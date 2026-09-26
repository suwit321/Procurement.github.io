/* cot.js — ปุ่ม "ไล่เหตุผล" (Chain of Thought) ของแท็บที่กำลังดู

   ไล่เหตุผลทีละขั้นจากตัวเลขจริงในขอบเขตที่กรองอยู่ ทั้งหมดคำนวณในเบราว์เซอร์ ไม่ต้องใช้ AI
   AI เป็นทางต่อยอดเท่านั้น (ปุ่ม "ให้ AI ขยายความ") และรับข้อความชุดเดียวกับที่ผู้ใช้เห็นบนจอ

   โครง 6 ขั้นเหมือนกันทุกแท็บ: ขอบเขต → วัดอะไรได้ → เทียบกับอะไร → ข้อสังเกต → ลงมือตรงไหน → ตอบอะไรไม่ได้

   สื่อสารกับแอปผ่าน api ที่ส่งเข้ามาตอน init เท่านั้น (แพตเทิร์นเดียวกับ importui.js)
   ไม่แตะตัวแปรภายในของ app.js โดยตรง

   ── กฎเหล็ก (ผิดข้อใดข้อหนึ่งคือผิดกติกา "ห้ามแต่งข้อมูล" ของทั้งระบบ) ──
   1. build() ต้อง pure: ห้ามแตะ state ห้ามเรียก render* / Charts / setHTML
      และห้ามคืน HTML แม้แต่แท็กเดียว เพราะโมเดลเดียวต้อง render ได้สามทาง
      (HTML ในหน้าต่าง · ข้อความคัดลอก/บันทึก · ข้อมูลที่ส่งให้ AI) ถ้าคืน HTML ตัวเลขจะเคลื่อนออกจากกัน
   2. ห้าม `|| 0` / `?? 0` แทนฟิลด์ที่ว่าง ต้องกรองแถวที่ขาดออกแล้วรายงานผ่าน F.dropped()
   3. เรียก Analytics.* ด้วยพารามิเตอร์เดียวกับที่ render*() ของแท็บนั้นใช้ พร้อมคอมเมนต์ชี้ตำแหน่ง
      ไม่เช่นนั้นผู้ใช้จะเห็นสองตัวเลขที่ขัดกันบนจอเดียวกัน
   4. ทุกแท็บต้องมี limits ไม่ว่าง — แท็บที่ไม่มีข้อจำกัดคือแท็บที่ยังไม่ได้คิด
*/
'use strict';

const CoT = (() => {

  let api = null;
  let current = null;      // { tabId, def, model, text } ที่กำลังแสดงอยู่ ปุ่มคัดลอก/บันทึก/AI อ่านจากตัวนี้
  let modalInstance = null;
  let opener = null;           // ปุ่มที่เปิดหน้าต่าง — Bootstrap คืนโฟกัสให้เองเฉพาะตัวที่มี data-bs-toggle จึงต้องคืนเอง
  let handOffFocus = false;    // ปิดเพื่อไปทำอย่างอื่นต่อ (เปิดโปรไฟล์ สลับแท็บ) ปลายทางจัดการโฟกัสเอง ห้ามแย่ง

  const REQUIRED = ['rows', 'allRows', 'summary', 'meta', 'models', 'datasetName', 'tabId', 'filterSummary',
    'tabOpts', 'labels', 'gotoTab', 'openDetail', 'openProfile', 'download', 'toast',
    'setBand', 'jumpTo', 'exportQueue', 'aiReady', 'aiScopeText', 'aiSend',
    'setRule', 'settings', 'ruleOverlap', 'coverageGaps', 'contractorProfiles', 'agencyProfiles', 'agencyName',
    'underbid', 'hasNetwork', 'netFilter', 'territory', 'mapShown', 'stackGroups', 'deepPattern'];

  function init(a) {
    const missing = REQUIRED.filter(k => !(k in a));
    // api ไม่ครบเกิดได้เมื่อ cot.js กับ app.js คนละเวอร์ชัน (ลืม bump ?v=) บอกชื่อคีย์ตรง ๆ จะได้ไม่ต้องไล่หา
    if (missing.length) console.error('CoT.init: api ไม่ครบ ขาด:', missing.join(', '));
    api = a;
    bindModal();
  }

  /* ---------- ตัวช่วยสร้างโมเดล ---------- */

  const LEVEL_ORDER = { high: 0, mid: 1, low: 2 };
  const LEVEL_TEXT = { high: 'สำคัญมาก', mid: 'ควรดู', low: 'หมายเหตุ' };

  const F = {
    m: (label, value, note) => ({ label, value: String(value), note: note || '' }),
    find: (level, v, head, act) => ({ level, v: Number.isFinite(v) ? v : 0, head, act }),
    /** เรียงตามระดับก่อน แล้วตามเม็ดเงินที่เกี่ยวข้อง (ไม่ใช่ตามความร้ายแรงที่คาดเดาเอง) */
    sortFinds: fs => fs.sort((a, b) => (a.level === b.level ? b.v - a.v : LEVEL_ORDER[a.level] - LEVEL_ORDER[b.level])),
    /** บรรทัดบังคับของขั้นที่ 2 — บอกทุกครั้ง ทั้งตอนมีแถวตกและตอนครบ
     *  การบอกว่า "ครบ" ก็เป็นข้อมูล: ผู้อ่านแยกไม่ได้ว่าไม่มีบรรทัดนี้เพราะครบหรือเพราะระบบลืมตรวจ */
    dropped: (used, all, reason) => (used === all
      ? `คำนวณจากครบทุกแถวในขอบเขต (${U.num(all)} แถว) ไม่มีแถวที่ขาดฟิลด์ที่ใช้`
      : `คำนวณจาก ${U.num(used)} จาก ${U.num(all)} แถว · ที่เหลือ ${U.num(all - used)} แถว${reason}`),
  };

  /** บรรทัด "คำนวณจาก n จาก N" ของตัวเลขย่อย — ใช้เมื่อขั้นที่ 2 มีตัวเลขที่ใช้ฟิลด์ต่างกัน ต้องบอกแยกทีละตัว */
  F.part = (label, used, all, reason) => (used === all
    ? `${label}: คำนวณจากครบ ${U.num(all)} แถว`
    : `${label}: คำนวณจาก ${U.num(used)} จาก ${U.num(all)} แถว · ที่เหลือ ${U.num(all - used)} แถว${reason}`);

  /** ค่าไว้จัดเรียงเท่านั้น (ไม่แสดง) — แถวที่ไม่มีมูลค่าไปท้ายสุด ไม่ถูกนับเป็นศูนย์ในตัวเลขใด ๆ */
  const vOf = r => (r.contract_price_agree === null || r.contract_price_agree === undefined ? -1 : r.contract_price_agree);
  const byValueDesc = (a, b) => vOf(b) - vOf(a);
  const sumV = list => U.sum(list.map(r => r.contract_price_agree));
  const money = v => U.money(v);
  const hasVal = r => r.contract_price_agree !== null && r.contract_price_agree !== undefined;

  /** เกณฑ์ที่หน้าต่างนี้ตั้งเองเพื่อตัดระดับ "สำคัญมาก / ควรดู" — ไม่ใช่เกณฑ์ทางกฎหมายหรือระเบียบ
   *  ทุกที่ที่ใช้ต้องเขียนบอกผู้อ่านในขั้นที่ 3 ว่าเป็นเกณฑ์ของหน้าต่างนี้ ผู้อ่านจะได้ปรับความเชื่อถือเองได้
   *  ตัวที่ยืมมาจากที่อื่นในแอประบุที่มาไว้ข้างค่า */
  const CUT = {
    cliffHigh: 2,          // ช่วงใต้เพดานหนาแน่นกว่าเหนือเพดานตั้งแต่กี่เท่า
    exactHigh: 0.25,       // สัดส่วนสัญญาที่ราคาเท่าราคากลางพอดี
    quarterMid: 0.4,       // สัดส่วนสัญญาในไตรมาสเดียว
    geoLow: 0.6,           // สัดส่วนสัญญาที่มีพิกัด ต่ำกว่านี้ถือว่าแผนที่แทนทั้งขอบเขตไม่ได้
    topShareHigh: 0.7,     // ยืมจากป้าย "สูง" ในตารางคัดกรองแท็บเครือข่าย
    topShareMid: 0.5,      // ยืมจาก KPI "ผู้ชนะรายเดียว ≥ 50%" ในแท็บหน่วยงาน
    specificWarn: 0.8,     // ยืมจากป้ายเตือนวิธีเฉพาะเจาะจงในรายการแท็บหน่วยงาน
    newSupplierLow: 0.2,   // ยืมจากป้าย "แทบไม่มีรายใหม่" ในรายการแท็บหน่วยงาน
    terrHigh: 0.6,         // ส่วนแบ่งในพื้นที่ของคู่ผู้รับจ้าง
    riskHigh: 40,          // คะแนนรวมผู้รับจ้าง ตรงกับ KPI "คะแนน ≥ 40" และขอบระดับสูง (Rules.BANDS)
    broadRule: 0.5,        // กฎที่ติดสัญญาตั้งแต่ครึ่งของขอบเขต ถือว่ากว้างจนแยกแยะได้น้อย
    burstMultiple: 2,      // วันลงนามกระจุกที่ใหญ่ตั้งแต่กี่เท่าของมัธยฐานวันกระจุก จึงขึ้น "สำคัญมาก"
    bigData: 20000,        // เกินนี้ข้ามการคำนวณคู่ต่อคู่ที่หนัก แล้วบอกในขั้นที่ 6
  };

  /** ค่าตั้งของกฎที่ผู้ใช้ปรับไปจากค่าเริ่มต้น — ใช้ทั้งแท็บสัญญาณเสี่ยงและแท็บกฎ */
  function settingChanges() {
    const cur = api.settings() || {};
    const def = Rules.defaultSettings();
    const changed = [], disabled = [];
    for (const d of Rules.DEFS) {
      const a = cur[d.id], b = def[d.id];
      if (!a || !b) continue;
      if (a.enabled === false) disabled.push(d.id);
      const thr = Object.keys(b.thresholds || {}).some(k => !a.thresholds || a.thresholds[k] !== b.thresholds[k]);
      if (a.enabled !== b.enabled || a.weight !== b.weight || thr) changed.push(d.id);
    }
    return { changed, disabled };
  }

  const bandCuts = () => Rules.BANDS.filter(b => b.key !== 'none')
    .map(b => `${b.label} ${b.key === 'low' ? '> 0' : '≥ ' + b.min}`).join(' · ');
  const ruleName = id => { const d = Rules.DEFS.find(x => x.id === id); return d ? `${id} ${d.name}` : id; };

  const MAP_MODE = { cluster: 'กลุ่มหมุด', points: 'จุด', heat: 'ความหนาแน่น', hotspot: 'จุดร้อน' };
  const MAP_COLOR = { band: 'ความเสี่ยง', rule: 'กฎที่พบ', category: 'หมวดสัญญาณ', method: 'วิธีจัดหา', type: 'ประเภท', value: 'มูลค่า' };

  const MODE_LABEL = { exposure: 'คะแนน × มูลค่า', score: 'คะแนนอย่างเดียว', value: 'มูลค่าอย่างเดียว' };
  const pct = (x, d = 1) => U.pct(x, d);

  /* ---------- เนื้อหาต่อแท็บ ---------- */

  const TABS = {

    'tab-overview': {
      title: 'ภาพรวม',
      question: 'ชุดข้อมูลนี้บอกอะไร และควรเริ่มตรวจกี่เรื่องจึงคุ้มกับแรงที่ลง',
      build(c) {
        const { rows, summary: s, opts, L } = c;
        const qo = opts.queue;
        // ตรงกับ renderOverview() ใน app.js: auditQueue(rows, state.queue) และ queueCoverage(rows, {maxN:100})
        const q = Analytics.auditQueue(rows, qo);
        const cov = Analytics.queueCoverage(rows, { maxN: 100 });
        const ranked = q.items.filter(x => x.includedBy === 'rank');
        const extra = q.items.filter(x => x.includedBy === 'materiality');
        const k = Math.min(ranked.length, cov.maxN);
        const rankedValue = U.sum(ranked.map(x => x.value));
        const total = U.sum(rows.map(r => r.contract_price_agree));
        const cur = cov[qo.mode] ? cov[qo.mode][k] : cov.exposure[k];
        const modeText = MODE_LABEL[qo.mode] || qo.mode;

        const highMin = Rules.BANDS.find(b => b.key === 'high').min;
        const pri = rows.filter(r => r.risk_band === 'critical' || r.risk_band === 'high');
        const priV = U.sum(pri.map(r => r.contract_price_agree));
        const valued = rows.filter(r => r.contract_price_agree > 0);
        const unvalued = rows.length - valued.length;

        const measure = [
          F.m('สัญญาในขอบเขต', U.num(rows.length), `มูลค่ารวม ${U.money(total)} บาท`),
          F.m('พบสัญญาณอย่างน้อย 1 ข้อ', `${U.num(s.flagged)} สัญญา`,
            `${pct(s.flagged / s.total)} · มูลค่า ${U.money(s.flaggedValue)} บาท`),
          F.m('ระดับวิกฤต + สูง', `${U.num(pri.length)} สัญญา`,
            `มูลค่า ${U.money(priV)} บาท${total > 0 ? ` (${pct(priV / total)} ของมูลค่ารวม)` : ''}`),
          F.m('คิวตรวจสอบ', `${U.num(k)} เรื่อง`, `ครอบคลุม ${pct(cur)} ของมูลค่ารวม`),
        ];

        const baseline = [];
        if (k > 0) {
          baseline.push({ label: `เพดานการครอบคลุมด้วย ${k} เรื่อง (เรียงตามมูลค่าอย่างเดียว)`, value: pct(cov.value[k]),
            source: 'เรียงจากสัญญามูลค่าสูงสุดลงมา จึงเป็นค่าสูงสุดทางทฤษฎีของเงินที่ตรวจครอบคลุมได้ด้วยจำนวนเรื่องเท่ากัน แต่ไม่ได้ดูสัญญาณเสี่ยงเลย' });
          baseline.push({ label: `คิวแบบคะแนนอย่างเดียว ด้วย ${k} เรื่อง`, value: pct(cov.score[k]),
            source: 'ดูแต่ความเสี่ยงโดยไม่สนขนาดเงิน จึงมักได้สัญญาเล็กที่คะแนนสูง' });
        }
        if (qo.materiality > 0) {
          baseline.push({ label: 'เกณฑ์ "ตรวจเสมอ"', value: `${U.money(qo.materiality)} บาท`,
            source: 'ค่าเริ่มต้นตั้งจากเปอร์เซ็นไทล์ที่ 99 ของมูลค่าสัญญาในชุดข้อมูล ปัดเป็นทวีคูณของ 5 ล้านบาท ปรับได้ที่การ์ดคิว' });
        }
        baseline.push({ label: 'เกณฑ์ระดับสูง', value: `คะแนน ≥ ${highMin}`,
          source: 'ขอบของระดับในระบบคะแนน (Rules.BANDS) เป็นผลรวมน้ำหนักกฎที่ตั้งโดยมนุษย์ ไม่ใช่ความน่าจะเป็น' });

        const finds = [];
        if (k > 0) {
          const gap = cov.value[k] - cur;
          finds.push(F.find('high', rankedValue,
            `คิว ${U.num(k)} เรื่องแรก (เรียงด้วย${modeText}) ครอบคลุมมูลค่า ${U.money(rankedValue)} บาท คิดเป็น ${pct(cur)} ของมูลค่ารวมในขอบเขตนี้`,
            qo.mode !== 'value' && gap > 0.15
              ? `ถ้าเรียงตามมูลค่าอย่างเดียวจะครอบคลุมได้ ${pct(cov.value[k])} ต่างจากคิวนี้ ${(gap * 100).toFixed(1)} จุด — ลองสลับโหมดดูว่าคิวปัจจุบันข้ามสัญญาก้อนใหญ่ไปกี่เรื่อง แล้วชั่งว่าคุ้มกับสัญญาณเสี่ยงที่ได้เพิ่มหรือไม่`
              : `ครอบคลุมใกล้เพดานของเงินที่ทำได้ด้วยจำนวนเรื่องเท่านี้ (${pct(cov.value[k])}) เริ่มตรวจจากรายการบนสุดได้เลย`));
        }
        if (pri.length) {
          finds.push(F.find('high', priV,
            `ระดับวิกฤตและสูงรวม ${U.num(pri.length)} สัญญา มูลค่า ${U.money(priV)} บาท${total > 0 ? ` (${pct(priV / total)} ของมูลค่ารวม)` : ''}`,
            `กรองเฉพาะกลุ่มนี้เพื่อตรวจก่อน เพราะคะแนนสะสมจากกฎที่ติดสูงถึงระดับควรตรวจก่อน (≥ ${highMin})`));
        }
        if (extra.length) {
          const extraV = U.sum(extra.map(x => x.value));
          finds.push(F.find('mid', extraV,
            `มี ${U.num(q.materialityOnlyCount)} สัญญาที่ติดคิวเพราะมูลค่าตั้งแต่ ${U.money(qo.materiality)} บาทขึ้นไป แม้คะแนนไม่สูงพอจะติดอันดับ รวม ${U.money(extraV)} บาท`,
            'คะแนนต่ำไม่ได้แปลว่าไม่ต้องตรวจ กฎที่มีอยู่ยังไม่จับสัญญาณของสัญญาก้อนใหญ่เหล่านี้ — ขอเอกสารการกำหนดราคากลางและเหตุผลการเลือกวิธีจัดหา'));
        }
        if (s.total > 0 && s.flagged / s.total > 0.8) {
          finds.push(F.find('mid', s.flaggedValue,
            `สัญญา ${pct(s.flagged / s.total)} (${U.num(s.flagged)} จาก ${U.num(s.total)}) มีสัญญาณอย่างน้อย 1 ข้อ`,
            'สัดส่วนสูงจนการดูว่า "มีสัญญาณหรือไม่" แยกแยะไม่ได้ ใช้คะแนนและคิวจัดลำดับแทน'));
        }
        if (unvalued > 0) {
          finds.push(F.find('low', 0,
            `${U.num(unvalued)} สัญญาไม่มีมูลค่าสัญญา`,
            'สัญญาเหล่านี้ได้ exposure = 0 จึงไม่มีทางเข้าคิวโหมดคะแนน × มูลค่า และไม่แสดงในกราฟจุดกระจาย — ตรวจในไฟล์ต้นทางว่าทำไมมูลค่าว่าง'));
        }

        const acts = [{ label: 'ไปที่คิวตรวจสอบ', kind: 'jump', arg: 'ovQueueCard' }];
        if (pri.length) acts.push({ label: 'กรองเฉพาะวิกฤต + สูง', kind: 'band', arg: 'priority' });
        if (k > 0) {
          acts.push({ label: 'ส่งออกคิวเป็น CSV', kind: 'export' });
          acts.push({ label: `เปิดโปรไฟล์อันดับ 1: ${L.truncate(ranked[0].r.project_name, 32)}`, kind: 'profile', arg: ranked[0].r.project_id });
        }

        return {
          scopeExtra: [`คิวตรวจสอบ: จัดด้วย${modeText} · แสดง ${U.num(qo.n)} เรื่อง · ตรวจเสมอถ้ามูลค่า ≥ ${U.money(qo.materiality)} บาท`],
          measure,
          dropped: [F.dropped(valued.length, rows.length, ' ไม่มีมูลค่าสัญญา จึงไม่นับในกราฟจุดกระจายและได้ exposure = 0')].filter(Boolean),
          baseline,
          finds: F.sortFinds(finds),
          acts,
          limits: [
            'คะแนน × มูลค่า คูณตรง ๆ ไม่ทอนค่า สัญญาที่คะแนน 0 จะได้ exposure 0 เสมอไม่ว่ามูลค่าเท่าไร จึงต้องมีชั้น "ตรวจเสมอ" แยกออกมาต่างหาก',
            'คะแนนความเสี่ยงคือผลรวมน้ำหนักของกฎที่มนุษย์ตั้ง ไม่ใช่ความน่าจะเป็นที่จะผิดจริง',
            'ชุดข้อมูลไม่มีผลการตรวจสอบจริง จึงวัดไม่ได้ว่าคิวนี้จับสัญญาที่มีปัญหาจริงได้กี่เรื่อง',
            'ชุดข้อมูลไม่มีจำนวนผู้เสนอราคาและวันปิดรับซอง จึงประเมินการแข่งขันได้เพียงบางส่วน',
          ],
        };
      },
    },

    'tab-fraud': {
      title: 'สัญญาณเสี่ยง',
      question: 'สัญญาณอะไรติดมากที่สุด กระจุกอยู่ที่หมวดไหน และสัญญาณไหนอาจไม่ใช่สัญญาณอิสระต่อกัน',
      build(c) {
        const { rows, summary: s, L } = c;
        const defs = Rules.DEFS;
        const isReal = d => d.source !== 'synthetic';
        const realDefs = defs.filter(isReal);
        const synthDefs = defs.filter(d => !isReal(d));
        // summary.counts สร้างจาก Rules.summarize(state.filtered) ตัวเดียวกับ KPI ของแท็บ (app.js renderFraud)
        const cnt = d => s.counts.get(d.id) || { n: 0, value: 0 };
        const firing = realDefs.filter(d => cnt(d).n > 0).sort((a, b) => cnt(b).value - cnt(a).value);
        const silent = realDefs.filter(d => cnt(d).n === 0);
        const realHits = r => (r.rule_hits || []).filter(h => h.source !== 'synthetic');
        const realFlagged = rows.filter(r => realHits(r).length > 0);
        const multi = rows.filter(r => realHits(r).length >= 3);
        const total = sumV(rows);
        const ch = settingChanges();

        // หมวดของกฎ (Rules.DEFS[].category) — นับสัญญาที่ติดกฎจริงอย่างน้อยหนึ่งข้อในหมวดนั้น เหมือนการ์ดมิติในแท็บ
        const catOf = new Map(defs.map(d => [d.id, d.category]));
        const byCat = new Map();
        for (const r of rows) {
          const seen = new Set(realHits(r).map(h => catOf.get(h.rule_id)).filter(Boolean));
          for (const cat of seen) { let e = byCat.get(cat); if (!e) byCat.set(cat, e = []); e.push(r); }
        }
        const cats = [...byCat].map(([cat, list]) => ({ cat, n: list.length, value: sumV(list) })).sort((a, b) => b.n - a.n);

        const measure = [
          F.m('สัญญาในขอบเขต', U.num(rows.length), `มูลค่ารวม ${money(total)} บาท`),
          F.m('พบสัญญาณ ≥ 1 ข้อ (ทุกกฎ)', `${U.num(s.flagged)} สัญญา`, `${pct(s.flagged / s.total)} · มูลค่า ${money(s.flaggedValue)} บาท`),
          F.m('ติดกฎที่ใช้ข้อมูลจริง ≥ 1 ข้อ', `${U.num(realFlagged.length)} สัญญา`, `มูลค่า ${money(sumV(realFlagged))} บาท`),
          F.m('กฎข้อมูลจริงที่พบ', `${firing.length} จาก ${realDefs.length} ข้อ`, `ไม่พบเลย ${silent.length} ข้อ`),
          F.m('ติดกฎจริงตั้งแต่ 3 ข้อ', `${U.num(multi.length)} สัญญา`, `มูลค่า ${money(sumV(multi))} บาท`),
        ];

        const baseline = [
          { label: 'เกณฑ์ระดับความเสี่ยง', value: bandCuts(),
            source: 'ขอบของระดับในระบบคะแนน (Rules.BANDS) คะแนนคือผลรวมน้ำหนักของกฎที่ติด ซึ่งมนุษย์เป็นผู้ตั้ง ไม่ใช่ความน่าจะเป็นที่จะผิดจริง' },
          { label: 'น้ำหนักกฎ',
            value: ch.changed.length ? `ปรับจากค่าเริ่มต้น ${ch.changed.length} ข้อ (${ch.changed.join(', ')})` : 'ค่าเริ่มต้นของระบบทุกข้อ',
            source: 'เทียบค่าที่ตั้งอยู่กับ Rules.defaultSettings() ถ้าปรับแล้ว ทุกตัวเลขคะแนนในทุกแท็บเป็นค่าตามที่ตั้ง' },
        ];
        baseline.push({ label: 'กฎที่ "ติดกว้าง"', value: `ติดสัญญา ≥ ${pct(CUT.broadRule, 0)} ของขอบเขต`,
          source: 'เกณฑ์ที่หน้าต่างนี้ตั้งเอง ไม่ใช่เกณฑ์ทางกฎหมาย กฎที่ติดเกือบทุกสัญญาแยกแยะสัญญาได้น้อย จึงไม่ยกเป็นสัญญาณเด่นเดี่ยว ๆ' });

        const finds = [];
        const share = d => cnt(d).n / rows.length;
        const broad = firing.filter(d => share(d) >= CUT.broadRule);
        const focus = firing.find(d => share(d) < CUT.broadRule);   // firing เรียงตามมูลค่าอยู่แล้ว
        if (focus) {
          finds.push(F.find('high', cnt(focus).value,
            `กฎ ${ruleName(focus.id)} ติด ${U.num(cnt(focus).n)} สัญญา (${pct(share(focus))}) มูลค่า ${money(cnt(focus).value)} บาท มากที่สุดตามมูลค่าในกลุ่มกฎที่ไม่ได้ติดกว้าง`,
            'กรองเฉพาะกฎนี้เพื่อไล่ดูสัญญาที่ติด แล้วอ่านเงื่อนไขและที่มาของกฎในแท็บ "กฎการตรวจจับ" ก่อนสรุปว่าสัญญาณนี้หมายถึงอะไร'));
        }
        if (broad.length) {
          finds.push(F.find('mid', cnt(broad[0]).value,
            `กฎที่ติดสัญญาตั้งแต่ครึ่งของขอบเขต: ${broad.map(d => `${d.id} (${pct(share(d), 0)})`).join(', ')} — แยกแยะสัญญาได้น้อย`,
            'กฎที่ติดสัญญาส่วนใหญ่ทำให้แทบทุกสัญญาได้คะแนนจากกฎนี้เหมือนกัน จึงช่วยจัดลำดับได้น้อย อ่านเงื่อนไขของกฎในแท็บกฎว่ากำลังจับอะไร ก่อนนับเป็นสัญญาณ'));
        }
        if (multi.length) {
          finds.push(F.find('high', sumV(multi),
            `${U.num(multi.length)} สัญญาติดกฎที่ใช้ข้อมูลจริงตั้งแต่ 3 ข้อ รวม ${money(sumV(multi))} บาท`,
            'เปิดดูก่อนเพราะสัญญาณมาจากหลายเงื่อนไข แต่ต้องเช็กว่าเป็นสัญญาณอิสระต่อกันจริงหรือกฎที่ทับกัน (ดูตารางความทับซ้อนในแท็บกฎ) เพราะกฎที่ทับกันทำให้ดูรุนแรงเกินจริง'));
        }
        if (cats.length) {
          const t = cats[0];
          finds.push(F.find('mid', t.value,
            `หมวด "${t.cat}" มีสัญญาติดสัญญาณมากที่สุด ${U.num(t.n)} สัญญา (${pct(t.n / rows.length)}) มูลค่า ${money(t.value)} บาท`,
            'ใช้เป็นจุดตั้งต้นว่าควรอ่านเอกสารด้านใดก่อน (ราคา การแข่งขัน โครงสร้างสัญญา ฯลฯ) หมวดเดียวกันอาจมีหลายกฎที่ติดสัญญาเดียวกัน'));
        }
        if (silent.length) {
          finds.push(F.find('mid', 0,
            `กฎที่ใช้ข้อมูลจริง ${silent.length} ข้อไม่พบสัญญาณเลยในขอบเขตนี้ (${silent.slice(0, 8).map(d => d.id).join(', ')}${silent.length > 8 ? ' …' : ''})`,
            'ไม่ได้แปลว่าไม่มีปัญหา อาจเป็นเพราะคอลัมน์ที่กฎนั้นต้องใช้ไม่มีข้อมูล หรือกรองขอบเขตแคบจนไม่มีสัญญาเข้าเงื่อนไข ดูเงื่อนไขของแต่ละกฎในแท็บกฎ'));
        }
        if (s.total > 0 && s.flagged / s.total > 0.8) {
          finds.push(F.find('mid', s.flaggedValue,
            `สัญญา ${pct(s.flagged / s.total)} (${U.num(s.flagged)} จาก ${U.num(s.total)}) มีสัญญาณอย่างน้อย 1 ข้อ`,
            'สัดส่วนสูงจนการดูว่า "มีสัญญาณหรือไม่" แยกแยะไม่ได้ ใช้คะแนนและลำดับแทน'));
        }
        if (s.flagged > realFlagged.length) {
          finds.push(F.find('low', 0,
            `ตัวเลข "พบสัญญาณ" บนหน้าจอนับกฎสาธิตด้วย: มี ${U.num(s.flagged - realFlagged.length)} สัญญาที่ติดเฉพาะกฎสาธิต`,
            'กฎสาธิตสร้างจากข้อมูลสังเคราะห์และไม่นับในคะแนนความเสี่ยง จึงไม่ควรใช้เป็นเหตุตรวจ'));
        }
        if (synthDefs.length) {
          finds.push(F.find('low', 0, `${synthDefs.length} ข้อเป็นกฎที่ใช้ข้อมูลสาธิต (${synthDefs.map(d => d.id).join(', ')})`,
            'ไม่นับรวมในคะแนนที่แสดง ผู้ตรวจไม่ต้องนำมาประกอบการตัดสินใจ'));
        }
        if (ch.disabled.length) {
          finds.push(F.find('low', 0, `กฎที่ถูกปิดไว้ ${ch.disabled.length} ข้อ (${ch.disabled.join(', ')})`,
            'สัญญาที่จะติดกฎเหล่านี้ไม่ถูกนับ คะแนนจึงต่ำกว่าที่ค่าเริ่มต้นจะให้'));
        }

        const acts = [];
        const actRule = focus || firing[0];
        if (actRule) acts.push({ label: `กรองเฉพาะกฎ ${actRule.id}`, kind: 'rule', arg: actRule.id });
        acts.push({ label: 'กรองเฉพาะวิกฤต + สูง', kind: 'band', arg: 'priority' });
        acts.push({ label: 'ไปแท็บกฎการตรวจจับ', kind: 'goto', arg: 'pill-rules' });
        const top = [...rows].sort((a, b) => b.risk_score - a.risk_score)[0];
        if (top) acts.push({ label: `เปิดโปรไฟล์สัญญาคะแนนสูงสุด: ${L.truncate(top.project_name, 30)}`, kind: 'profile', arg: top.project_id });

        return {
          measure,
          dropped: [F.dropped(rows.length, rows.length, '')],
          baseline, finds: F.sortFinds(finds), acts,
          limits: [
            'กฎที่ไม่พบสัญญาณอาจเป็นเพราะคอลัมน์ที่กฎต้องใช้ว่าง ไม่ใช่เพราะไม่มีปัญหา',
            'คะแนนคือผลรวมน้ำหนักที่มนุษย์ตั้ง ไม่ใช่ความน่าจะเป็นที่จะผิดจริง และกฎสองข้อที่ติดสัญญาชุดเดียวกันถูกนับซ้ำ',
            'ชุดข้อมูลไม่มีจำนวนผู้เสนอราคาและวันปิดรับซอง จึงประเมินการแข่งขันได้เพียงบางส่วน',
            'ชุดข้อมูลไม่มีผลการตรวจสอบจริง จึงวัดไม่ได้ว่าสัญญาณแต่ละข้อจับสัญญาที่มีปัญหาจริงได้กี่เรื่อง',
          ],
        };
      },
    },

    'tab-anomaly': {
      title: 'ความผิดปกติ',
      question: 'ตัวเลขไหนเบี่ยงจากรูปแบบที่คาดไว้ — การกองใต้เพดาน ราคาเท่าราคากลาง ราคาสูงผิดกลุ่ม ระยะเวลาผิดปกติ',
      build(c) {
        const { rows, allRows, L } = c;
        const cliff = Analytics.thresholdCliff(rows);          // ตรงกับ app.js renderAnomaly (thresholdCliff(rows) ค่าเริ่มต้น)
        const ratio = Analytics.priceRatioHistogram(rows);     // ค่าเริ่มต้น เหมือนแท็บ
        const outliers = Analytics.priceOutliers(rows);        // ค่าเริ่มต้น (limit 100) แท็บตัดแสดง 40 แถว แต่ตัวเลขรวมนับจากทั้งหมดที่ได้
        const dur = Analytics.durationOutliers(rows);          // ค่าเริ่มต้น (limit 50)
        const priced = rows.filter(hasVal);
        const below = cliff.bins.find(b => b.hi === cliff.ceiling);
        const above = cliff.bins.find(b => b.lo === cliff.ceiling);
        const inBin = b => (b ? priced.filter(r => r.contract_price_agree >= b.lo && r.contract_price_agree < b.hi) : []);
        const belowRows = inBin(below), aboveRows = inBin(above);
        const specBelow = belowRows.filter(r => r.purchase_method_name === Rules.SPECIFIC_METHOD).length;
        const binW = cliff.bins.length ? cliff.bins[0].hi - cliff.bins[0].lo : 0;
        const exactRows = rows.filter(r => r.price_build && hasVal(r) && Math.abs(r.contract_price_agree / r.price_build - 1) < 1e-9);
        const withDur = rows.filter(r => r.duration_days !== null && r.duration_days !== undefined);

        // กลุ่มเปรียบเทียบของ priceOutliers (analytics.js: กลุ่มงาน | วิธีจัดหา ต้องมีสัญญามีราคา ≥ 30 ฉบับ)
        const groups = U.groupBy(rows, r => (r.work_group || r.project_type_name) + ' | ' + r.purchase_method_name);
        let untested = 0;
        for (const [, g] of groups) {
          if (g.filter(r => hasVal(r) && r.contract_price_agree > 0).length < 30) untested += g.length;
        }
        // ราคากลางเป็นของทั้งโครงการ — สัญญาในโครงการที่มีหลายสัญญาเทียบอัตราส่วนตรง ๆ ไม่ได้ (นับจากทั้งชุดข้อมูล)
        const perProject = U.countBy(allRows, r => r.project_id);
        const multiLot = rows.filter(r => perProject.get(r.project_id) > 1);   // ไม่พบในแผนที่นับ = undefined → false
        const capNote = (n, cap) => (n >= cap ? 'อย่างน้อย ' : '');

        const measure = [
          F.m('ช่วงใต้ / เหนือเพดาน', `${U.num(cliff.belowCount)} / ${U.num(cliff.aboveCount)} สัญญา`,
            cliff.ratio ? `ใต้เพดานหนาแน่นกว่า ${cliff.ratio.toFixed(1)} เท่า`
              : (cliff.belowCount + cliff.aboveCount === 0 ? 'ไม่มีสัญญาในช่วงเทียบเลย' : 'ไม่มีสัญญาเหนือเพดานในช่วงเทียบ จึงหาอัตราส่วนไม่ได้')),
          F.m('ราคาเท่าราคากลางพอดี', `${U.num(ratio.exact)} จาก ${U.num(ratio.counted)}`, ratio.counted ? pct(ratio.exact / ratio.counted) : 'ไม่มีสัญญาที่มีราคากลาง'),
          F.m('ราคาสูงเกินกลุ่มเปรียบเทียบ', `${capNote(outliers.length, 100)}${U.num(outliers.length)} สัญญา`, `มูลค่า ${money(sumV(outliers.map(o => o.record)))} บาท`),
          F.m('ระยะเวลาสัญญาติดลบ', `${capNote(dur.negative.length, 50)}${U.num(dur.negative.length)} รายการ`, `มัธยฐานระยะเวลา ${U.num(Math.round(dur.median))} วัน`),
        ];

        const baseline = [];
        if (below && above) {
          baseline.push({ label: `เพดาน ${U.num(cliff.ceiling)} บาท`, value: `เทียบช่วงกว้าง ${U.num(binW)} บาท ใต้และเหนือเพดาน`,
            source: 'ค่าเพดานที่ระบบใช้กับวิธีเฉพาะเจาะจง (rules.js DISCRETIONARY_CEILING) เทียบจำนวนสัญญาสองช่วงที่ติดเพดาน' });
        }
        baseline.push({ label: 'ราคาเท่าราคากลาง (สัดส่วน 1.00)', value: 'ไม่มีการลดราคาเลย',
          source: 'อัตราส่วนราคาสัญญาต่อราคากลางเท่ากับ 1 พอดี แปลว่าไม่มีการลดจากราคากลาง' });
        baseline.push({ label: 'ขอบบนของราคาปกติในกลุ่ม', value: 'Q3 + 3 × IQR',
          source: 'คิดภายในกลุ่ม (กลุ่มงาน | วิธีจัดหา) ที่มีสัญญามีราคา ≥ 30 ฉบับ ตาม Analytics.priceOutliers ใช้ IQR เพราะราคากระจายเบ้และหางยาว' });
        if (dur.upper !== undefined) {
          baseline.push({ label: 'ระยะเวลายาวผิดปกติ', value: `> ${U.num(Math.round(dur.upper))} วัน`, source: 'ขอบบน IQR × 3 ของระยะเวลาสัญญาในขอบเขตนี้ (Analytics.durationOutliers)' });
        }
        baseline.push({ label: 'ระดับ "สำคัญมาก" ของหน้าต่างนี้',
          value: `หน้าผาเพดาน ≥ ${CUT.cliffHigh} เท่า · ราคาเท่าราคากลาง ≥ ${pct(CUT.exactHigh, 0)}`,
          source: 'เกณฑ์ที่หน้าต่างนี้ตั้งเองเพื่อจัดลำดับ ไม่ใช่เกณฑ์ทางกฎหมาย ค่าที่ต่ำกว่านี้ยังแสดงเป็น "ควรดู"' });

        const finds = [];
        if (below && above && (cliff.belowCount + cliff.aboveCount) > 0) {
          const high = cliff.ratio !== null && cliff.ratio >= CUT.cliffHigh;
          finds.push(F.find(high ? 'high' : 'mid', below.value,
            `ช่วงราคา ${U.num(below.lo)}–${U.num(below.hi)} บาท มี ${U.num(cliff.belowCount)} สัญญา ขณะที่ช่วง ${U.num(above.lo)}–${U.num(above.hi)} บาท มี ${U.num(cliff.aboveCount)} สัญญา` +
              (cliff.ratio ? ` (ใต้เพดานหนาแน่นกว่า ${cliff.ratio.toFixed(1)} เท่า)` : ''),
            `ในช่วงใต้เพดาน ${U.num(cliff.belowCount)} สัญญา มี ${U.num(specBelow)} สัญญา (${cliff.belowCount ? pct(specBelow / cliff.belowCount) : '-'}) เป็นวิธีเฉพาะเจาะจง ซึ่งใช้ได้เมื่อวงเงินโครงการไม่เกินเพดาน สัญญาส่วนนี้จึงกองใต้เพดานโดยโครงสร้างอยู่แล้ว — ควรดูเฉพาะสัญญาที่ราคาชิดเพดานเกินกว่าที่วิธีนี้ควรเป็น (แท็บหน่วยงาน ส่วนวิเคราะห์เชิงลึกวิธีจัดหา)`));
        }
        if (cliff.belowCount + cliff.aboveCount === 0 && cliff.bins.length) {
          const sc = api.models().scope;
          finds.push(F.find('low', 0,
            `ไม่มีสัญญาราคาใกล้เพดานเลย (ช่วง ${U.num(cliff.bins[0].lo)}–${U.num(cliff.bins[cliff.bins.length - 1].hi)} บาท มี 0 สัญญา) จึงตรวจการกองใต้เพดานในขอบเขตนี้ไม่ได้`,
            sc && sc.looks_capped && sc.sort_key
              ? `ชุดข้อมูลนี้เก็บเฉพาะโครงการที่มียอดรวมสัญญาสูงสุด (ไฟล์สิ้นสุดที่ ${U.num(sc.cutoff_value)} บาท) จึงแทบไม่มีสัญญาราคาต่ำใกล้เพดาน นี่คือ "ข้อมูลไม่ครอบคลุมช่วงนี้" ไม่ใช่ "ไม่มีการกองใต้เพดาน"`
              : 'นี่คือ "ไม่มีข้อมูลในช่วงนี้" ไม่ใช่ "ไม่มีการกองใต้เพดาน"'));
        }
        if (ratio.counted > 0 && ratio.exact > 0) {
          const sh = ratio.exact / ratio.counted;
          finds.push(F.find(sh >= CUT.exactHigh ? 'high' : 'mid', sumV(exactRows),
            `${U.num(ratio.exact)} จาก ${U.num(ratio.counted)} สัญญาที่มีราคากลาง (${pct(sh)}) ทำราคาเท่าราคากลางพอดี ไม่ลดเลย มูลค่า ${money(sumV(exactRows))} บาท`,
            'ตรวจที่มาของราคากลางว่าอ้างอิงจากอะไร และมีการต่อรองก่อนลงนามหรือไม่ (ระวังโครงการที่มีหลายสัญญา เพราะราคากลางเป็นของทั้งโครงการ)'));
        }
        if (outliers.length) {
          const top = outliers[0];
          finds.push(F.find('mid', sumV(outliers.map(o => o.record)),
            `${capNote(outliers.length, 100)}${U.num(outliers.length)} สัญญาราคาสูงเกินขอบบนของกลุ่มเปรียบเทียบ สูงสุดคือ "${L.truncate(top.record.project_name, 46)}" ` +
              `${top.times_median ? top.times_median.toFixed(1) + ' เท่า' : '-'} ของมัธยฐานกลุ่ม (${L.peerGroupLabel(top.peer_group)})`,
            'ตรวจสเปกและขอบเขตงานว่ายากหรือใหญ่กว่างานทั่วไปในกลุ่มจริงหรือไม่ ราคาสูงอาจมาจากขนาดหรือความซับซ้อนของงาน ไม่ใช่ความผิดปกติ'));
        }
        if (dur.negative.length) {
          finds.push(F.find('mid', sumV(dur.negative),
            `ระยะเวลาสัญญาติดลบ ${capNote(dur.negative.length, 50)}${U.num(dur.negative.length)} รายการ (มัธยฐานระยะเวลา ${U.num(Math.round(dur.median))} วัน)`,
            'วันสิ้นสุดอยู่ก่อนวันเริ่มต้น จึงเป็นข้อมูลผิดพลาดหรือการลงนามย้อนหลัง ควรแยกออกก่อนนำสถิติระยะเวลาไปใช้'));
        }
        if (dur.long.length) {
          finds.push(F.find('low', sumV(dur.long), `${capNote(dur.long.length, 50)}${U.num(dur.long.length)} สัญญามีระยะเวลายาวเกิน ${U.num(Math.round(dur.upper))} วัน`,
            'สัญญาระยะยาวอาจเป็นงานก่อสร้างขนาดใหญ่ตามปกติ ดูประกอบกับมูลค่าและประเภทงาน'));
        }
        if (untested > 0) {
          finds.push(F.find('low', 0, `${U.num(untested)} สัญญาอยู่ในกลุ่มเปรียบเทียบที่เล็กกว่า 30 ฉบับ จึงไม่ถูกตรวจราคาผิดปกติเลย`,
            'นี่คือ "ยังไม่ได้ตรวจ" ไม่ใช่ "ตรวจแล้วผ่าน" ถ้ากรองขอบเขตแคบ กลุ่มจะเล็กลงและตรวจได้น้อยลงตาม'));
        }
        if (multiLot.length) {
          finds.push(F.find('low', 0, `${U.num(multiLot.length)} สัญญา (${pct(multiLot.length / rows.length)}) อยู่ในโครงการที่มีหลายสัญญา`,
            'ราคากลางเป็นของทั้งโครงการ อัตราส่วนราคาสัญญาต่อราคากลางของสัญญาเหล่านี้จึงเทียบตรง ๆ ไม่ได้ ดูส่วนที่เกี่ยวกับราคากลางด้วยความระวัง'));
        }

        const acts = [];
        if (outliers.length) acts.push({ label: `เปิดโปรไฟล์ราคาสูงสุดเทียบกลุ่ม: ${L.truncate(outliers[0].record.project_name, 28)}`, kind: 'profile', arg: outliers[0].record.project_id });
        if (dur.negative.length) acts.push({ label: `เปิดโปรไฟล์สัญญาระยะเวลาติดลบมากสุด: ${L.truncate(dur.negative[0].project_name, 24)}`, kind: 'profile', arg: dur.negative[0].project_id });

        const dg = api.models().digits;
        return {
          measure,
          dropped: [
            F.part('หน้าผาเพดาน', priced.length, rows.length, ' ไม่มีมูลค่าสัญญา'),
            F.part('ราคาเทียบราคากลาง', ratio.counted, rows.length, ' ไม่มีราคากลางหรือไม่มีมูลค่าสัญญา'),
            F.part('ราคาผิดปกติเทียบกลุ่ม', rows.length - untested, rows.length, ' อยู่ในกลุ่มเปรียบเทียบที่เล็กกว่า 30 ฉบับ จึงไม่ถูกตรวจ'),
            F.part('ระยะเวลาสัญญา', withDur.length, rows.length, ' ไม่มีวันเริ่ม/สิ้นสุดสัญญา'),
          ],
          baseline, finds: F.sortFinds(finds), acts,
          limits: [
            dg
              ? `การทดสอบเลขหลักแรก (เบนฟอร์ด) ระบบไม่ใช้เป็นสัญญาณ เพราะ 80% กลางของมูลค่าสัญญากว้างเพียง ${dg.decades_p10_p90.toFixed(1)} หลัก (${money(dg.value_p10)}–${money(dg.value_p90)} บาท) และกองใต้เพดาน เลขหลักแรกจึงเบี่ยงโดยโครงสร้าง ไม่ใช่เพราะตัวเลขถูกแต่ง`
              : 'การทดสอบเลขหลักแรก (เบนฟอร์ด) ไม่ถูกใช้เป็นสัญญาณในหน้าต่างนี้ เพราะมูลค่าสัญญาราคาจัดซื้อมีเพดานและราคากลางกำกับ ทำให้เลขหลักแรกเบี่ยงโดยโครงสร้าง',
            'ราคาผิดปกติเทียบกลุ่มตรวจได้เฉพาะกลุ่มที่มีสัญญามีราคา ≥ 30 ฉบับ กลุ่มเล็กไม่ถูกตรวจเลย',
            'กลุ่มเปรียบเทียบและขอบบนคิดจากสัญญาในขอบเขตที่กรองอยู่เท่านั้น ถ้ากรองแคบ ค่าเทียบจะเปลี่ยนตาม',
            'ราคากลางเป็นของทั้งโครงการ แต่มูลค่าสัญญาเป็นรายสัญญา โครงการที่แบ่งหลายลอตทำให้อัตราส่วนเพี้ยน',
          ],
        };
      },
    },

    'tab-time': {
      title: 'แนวโน้มเวลา',
      question: 'จังหวะเวลาการทำสัญญาบอกอะไร — มีวันหรือช่วงไหนที่กระจุกผิดปกติ',
      build(c) {
        const { rows, allRows, opts, L } = c;
        const cal = Analytics.fiscalCalendar(allRows);           // app.js fiscalCalendar(): ปฏิทินของทั้งชุดข้อมูล ไม่ผูกกับตัวกรอง
        const timing = Analytics.contractTiming(rows, cal);      // app.js: contractTiming(rows, fiscalCalendar()) ค่าเริ่มต้น sameDayMin = 3
        const ts = Analytics.timeseries(rows, opts.ts.dimension); // app.js renderTimeseries
        const dated = timing.dated;
        const inData = cal.slots.filter(sl => sl.inData).length;
        const peak = timing.peak;
        const QRANGE = { 1: 'ต.ค.–ธ.ค.', 2: 'ม.ค.–มี.ค.', 3: 'เม.ย.–มิ.ย.', 4: 'ก.ค.–ก.ย.' };
        const topQ = [...timing.quarters].sort((a, b) => b.n - a.n)[0];
        const medBurst = timing.bursts.length ? U.median(timing.bursts.map(b => b.n)) : null;

        const measure = [
          F.m('สัญญาที่มีวันทำสัญญา', `${U.num(dated)} จาก ${U.num(rows.length)}`, dated ? pct(dated / rows.length) : ''),
          F.m('ช่วงเวลาที่ครอบคลุม', `${U.num(ts.months.length)} เดือน`,
            ts.months.length ? `${U.thaiMonthLabel(ts.months[0])} ถึง ${U.thaiMonthLabel(ts.months[ts.months.length - 1])}` : 'ไม่มีวันทำสัญญาในขอบเขตนี้'),
          F.m('เดือนที่มีสัญญามากที่สุด', peak ? U.thaiMonthLabel(peak.key) : '-', peak ? `${U.num(peak.mine)} สัญญา (${pct(peak.myShare)} ของที่มีวันที่)` : ''),
          F.m('วันที่ลงนามพร้อมกัน ≥ 3 ฉบับ', `${U.num(timing.bursts.length)} วัน`, `รวม ${U.num(timing.burstRows)} สัญญา`),
          F.m('สัญญาตามไตรมาสปีงบ', timing.quarters.map(q => U.num(q.n)).join(' / '), 'ไตรมาส 1 / 2 / 3 / 4'),
        ];

        const baseline = [
          { label: 'ปฏิทินของทั้งชุดข้อมูล', value: `${inData} เดือนที่มีข้อมูล จาก ${cal.slots.length} เดือนของ ${cal.years.length} ปีงบ`,
            source: 'ใช้แยก "เดือนที่ไม่มีข้อมูลเลย" ออกจาก "เดือนที่มีข้อมูลแต่ไม่มีสัญญาในขอบเขตนี้" ซึ่งความหมายต่างกัน' },
        ];
        if (peak) {
          baseline.push({ label: `สัดส่วนของทั้งชุดข้อมูลในเดือน ${U.thaiMonthLabel(peak.key)}`, value: pct(peak.baseShare),
            source: rows.length === allRows.length ? 'ขอบเขตนี้คือทั้งชุด จึงเท่ากับสัดส่วนของขอบเขต' : `เทียบกับสัดส่วนในขอบเขตนี้ ${pct(peak.myShare)}` });
        }
        baseline.push({ label: 'ไตรมาสปีงบประมาณ', value: 'ต.ค.–ธ.ค. = ไตรมาส 1',
          source: 'ปีงบประมาณไทยเริ่ม 1 ต.ค. (Analytics.fiscalQuarter) ไตรมาส 2 = ม.ค.–มี.ค. · 3 = เม.ย.–มิ.ย. · 4 = ก.ค.–ก.ย.' });
        baseline.push({ label: 'นับเป็นวันกระจุก', value: 'ตั้งแต่ 3 สัญญาต่อวัน', source: 'ค่าเริ่มต้นของ Analytics.contractTiming (sameDayMin)' });
        if (medBurst !== null) {
          baseline.push({ label: 'มัธยฐานจำนวนสัญญาในวันกระจุก', value: `${U.num(medBurst, 1)} สัญญา`,
            source: `ระดับ "สำคัญมาก" ของวันกระจุก = ≥ ${CUT.burstMultiple} เท่าของค่านี้ และไม่ใช่วันแรก/วันสุดท้ายของปีงบ (เกณฑ์ที่หน้าต่างนี้ตั้งเอง)` });
        }
        baseline.push({ label: 'ระดับ "ควรดู" ของไตรมาส', value: `≥ ${pct(CUT.quarterMid, 0)} ของสัญญาที่มีวันที่`, source: 'เกณฑ์ที่หน้าต่างนี้ตั้งเอง ไม่ใช่เกณฑ์ทางกฎหมาย' });

        const finds = [];
        for (const b of timing.bursts.slice(0, 3)) {
          const first = b.firstOfFiscalYear, last = b.date.slice(5) === '09-30';
          const bigDay = medBurst !== null && b.n >= CUT.burstMultiple * medBurst;
          finds.push(F.find(first || last ? 'mid' : bigDay ? 'high' : 'mid', b.value,
            `วันที่ ${U.thaiDate(b.date)} มี ${U.num(b.n)} สัญญาลงนามในวันเดียว รวม ${money(b.value)} บาท จาก ${U.num(b.depts.length)} หน่วยงาน` +
              (first ? ' — เป็นวันแรกของปีงบประมาณ' : last ? ' — เป็นวันสุดท้ายของปีงบประมาณ' : ''),
            first
              ? 'การลงนามพร้อมกันจำนวนมากในวันที่ 1 ต.ค. เป็นเรื่องทางธุรการที่พบได้ตามปกติ ตรวจเฉพาะกรณีที่ผู้รับจ้างหรือหน่วยงานเดียวกันซ้ำหลายฉบับ'
              : last
                ? 'วันสุดท้ายของปีงบประมาณอาจมีการลงนามหนาแน่นตามวงจรงบประมาณ ตรวจว่าเป็นงานที่วางแผนไว้ตั้งแต่ต้นปีหรือมีการเร่งทำสัญญาใกล้สิ้นปีงบ โดยดูวันประกาศของสัญญาเหล่านั้น'
                : 'ตรวจว่าสัญญาชุดนี้เป็นงานเดียวกันที่ถูกแบ่งเป็นหลายฉบับ หรือเป็นการเซ็นล็อตเดียวกัน โดยดูขอบเขตงานและผู้รับจ้าง'));
        }
        if (dated > 0 && timing.burstRows / dated >= 0.5) {
          finds.push(F.find('low', 0,
            `วันที่ลงนามพร้อมกัน ≥ 3 ฉบับครอบคลุม ${pct(timing.burstRows / dated)} ของสัญญา (${U.num(timing.burstRows)} จาก ${U.num(dated)} สัญญา ใน ${U.num(timing.bursts.length)} วัน)`,
            'การลงนามหลายฉบับในวันเดียวเป็นลักษณะปกติของชุดข้อมูลนี้ จึงแยกแยะได้น้อย ให้ดูเฉพาะวันที่ใหญ่กว่าวันกระจุกทั่วไปมาก และวันที่หน่วยงานหรือผู้รับจ้างเดียวกันซ้ำหลายฉบับ'));
        }
        if (dated > 0 && topQ && topQ.n / dated >= CUT.quarterMid) {
          const qRows = rows.filter(r => r.contract_date && Analytics.fiscalQuarter(r.contract_date) === topQ.q);
          finds.push(F.find('mid', sumV(qRows),
            `ไตรมาส ${topQ.q} ของปีงบ (${QRANGE[topQ.q]}) มีสัญญา ${pct(topQ.n / dated)} ของสัญญาที่มีวันที่ (${U.num(topQ.n)} สัญญา) มูลค่า ${money(sumV(qRows))} บาท`,
            'ตรวจว่าเป็นวงจรงบประมาณตามปกติหรือการเร่งเซ็นสัญญาช่วงใดช่วงหนึ่ง แต่ระบบมีข้อมูลเพียงปีงบเดียว จึงเทียบกับปีก่อนไม่ได้'));
        }
        if (timing.gapMedian !== null) {
          finds.push(F.find('low', 0,
            `มัธยฐานจากวันประกาศถึงวันลงนามคือ ${U.num(Math.round(timing.gapMedian))} วัน คำนวณจากเพียง ${U.num(timing.gapN)} จาก ${U.num(dated)} สัญญาที่มีวันประกาศ`,
            'ระบบมีกฎตรวจช่วงประกาศ–ลงนามที่สั้นเกินไปอยู่แล้ว (ดูแท็บกฎ) ตัวเลขนี้ใช้ประกอบเท่านั้น เพราะสัญญาที่เหลือไม่มีวันประกาศ'));
        }
        if (timing.undated > 0) {
          finds.push(F.find('low', 0, `${U.num(timing.undated)} สัญญาไม่มีวันทำสัญญา`,
            'สัญญาเหล่านี้ไม่อยู่ในกราฟและสถิติเวลาทั้งหมดของแท็บนี้ ตรวจในไฟล์ต้นทางว่าทำไมวันที่ว่าง'));
        }
        if (cal.slots.length && inData < cal.slots.length) {
          finds.push(F.find('low', 0, `ข้อมูลมีสัญญาเพียง ${inData} เดือน จาก ${cal.slots.length} เดือนของ ${cal.years.length} ปีงบ`,
            'ยังไม่ครบปีงบประมาณ จึงสรุปรูปแบบตามฤดูกาลหรือเทียบปีต่อปีไม่ได้'));
        }

        const acts = [];
        if (timing.bursts.length) {
          const big = [...timing.bursts[0].rows].sort(byValueDesc)[0];
          if (big) acts.push({ label: `เปิดโปรไฟล์สัญญาใหญ่สุดของวันที่ ${U.thaiDate(timing.bursts[0].date)}: ${L.truncate(big.project_name, 22)}`, kind: 'profile', arg: big.project_id });
        }

        return {
          scopeExtra: [`แท็บแนวโน้มเวลา: แยกตาม ${opts.ts.dimension} · วัดเป็น ${opts.ts.metric === 'counts' ? 'จำนวนสัญญา' : 'มูลค่า'}`],
          measure,
          dropped: [
            F.dropped(dated, rows.length, ' ไม่มีวันทำสัญญา จึงไม่อยู่ในกราฟและสถิติเวลา'),
            F.part('มัธยฐานวันประกาศ → ลงนาม', timing.gapN, dated, ' ไม่มีวันประกาศ'),
            F.part('มัธยฐานระยะเวลาสัญญา', timing.durN, dated, ' ไม่มีวันเริ่ม/สิ้นสุดสัญญา'),
          ],
          baseline, finds: F.sortFinds(finds), acts,
          limits: [
            cal.years.length === 1
              ? `ข้อมูลมีเพียง 1 ปีงบประมาณ (${inData} เดือน) จึงเทียบปีต่อปีหรือแยกความเป็นฤดูกาลออกจากเหตุการณ์เฉพาะปีนี้ไม่ได้`
              : `ข้อมูลมี ${cal.years.length} ปีงบประมาณ (${inData} เดือนที่มีข้อมูล) การเทียบปีต่อปีขึ้นกับว่าเดือนที่เทียบมีข้อมูลครบทุกปีหรือไม่`,
            'วันประกาศว่างในหลายสัญญา (โดยเฉพาะวิธีเฉพาะเจาะจง) จึงวัดช่วงเวลาเปิดให้แข่งขันได้เพียงบางส่วน',
            'ชุดข้อมูลไม่มีวันเบิกจ่ายและวันแก้ไขสัญญา จึงจับความล่าช้าหลังลงนามหรือการขยายเวลาไม่ได้',
            'วันที่ลงนามพร้อมกันเป็นข้อสังเกตเท่านั้น ยังไม่รู้ว่าเป็นงานเดียวกันหรือคนละงาน',
          ],
        };
      },
    },

    'tab-rules': {
      title: 'กฎการตรวจจับ',
      question: 'คะแนนที่เห็นน่าเชื่อถือแค่ไหน — มีกฎที่นับซ้ำ ค่าที่ถูกปรับ หรือช่องว่างที่ตรวจไม่ได้หรือไม่',
      build(c) {
        const { rows, allRows, summary: s } = c;
        const defs = Rules.DEFS;
        const realDefs = defs.filter(d => d.source !== 'synthetic');
        const synthDefs = defs.filter(d => d.source === 'synthetic');
        const customDefs = defs.filter(d => d.custom);
        const ov = api.ruleOverlap();               // computeRuleOverlap(state.records) ตัวเดียวกับตารางความทับซ้อนในแท็บกฎ
        const ch = settingChanges();
        const firing = realDefs.filter(d => (s.counts.get(d.id) || { n: 0 }).n > 0);

        // ช่องว่างความครอบคลุม: ช่อง (มิติ × ช่วงกระบวนการ) ที่ไม่มีกฎ และรู้แน่ว่าขาดข้อมูลอะไร (COVERAGE_GAPS ใน app.js)
        const { cells } = Rules.coverage(s.counts);
        const gaps = [];
        for (const [key, need] of Object.entries(api.coverageGaps() || {})) {
          if (cells.get(key)) continue;
          const [dk, sk] = key.split('|');
          const dim = Rules.DIMENSIONS.find(x => x.key === dk), stage = Rules.STAGES.find(x => x.key === sk);
          gaps.push(`${dim ? dim.label : dk} × ${stage ? stage.label : sk} (${need})`);
        }

        const measure = [
          F.m('กฎทั้งหมด', `${defs.length} ข้อ`, `ข้อมูลจริง ${realDefs.length} · สาธิต ${synthDefs.length}${customDefs.length ? ` · สร้างเอง ${customDefs.length}` : ''}`),
          F.m('กฎจริงที่พบในขอบเขตนี้', `${firing.length} จาก ${realDefs.length} ข้อ`, `ไม่พบ ${realDefs.length - firing.length} ข้อ`),
          F.m('ปรับจากค่าเริ่มต้น', `${ch.changed.length} ข้อ`, ch.changed.length ? ch.changed.join(', ') : 'ใช้ค่าเริ่มต้นทั้งหมด'),
          F.m('คู่กฎที่ทับซ้อนมาก', `${ov.notable.length} คู่`, `จาก ${ov.active.length} กฎที่พบ ≥ 20 สัญญา (ทั้งชุดข้อมูล)`),
          F.m('ช่องที่ยังตรวจไม่ได้', `${gaps.length} ช่อง`, 'มิติ × ช่วงกระบวนการ ที่ขาดข้อมูล'),
        ];

        const baseline = [
          { label: 'เกณฑ์คู่กฎที่ทับซ้อน', value: 'Jaccard ≥ 0.2 หรือกฎหนึ่งอยู่ในอีกกฎ ≥ 95% (และซ้อนกัน ≥ 20 สัญญา)',
            source: 'เกณฑ์เดียวกับตารางในแท็บกฎ (computeRuleOverlap) ตั้งไว้คัดเฉพาะคู่ที่ควรดู ไม่ใช่เกณฑ์ทางสถิติที่ตายตัว' },
          { label: 'ค่าเริ่มต้นของน้ำหนักและเงื่อนไข', value: 'Rules.defaultSettings()',
            source: 'ใช้เทียบว่าผู้ใช้ปรับกฎไปจากค่าตั้งต้นหรือไม่ ถ้าปรับ คะแนนทุกแท็บเป็นค่าตามที่ตั้ง' },
        ];

        const finds = [];
        // กฎเล็กหนึ่งข้อมักอยู่ในกฎใหญ่หลายข้อ รวมเป็นข้อสังเกตเดียวต่อกฎเล็ก ไม่ให้ซ้ำกันสามบรรทัด
        const contained = new Map(), overlapOnly = [];
        for (const p of ov.notable) {
          if (p.contain >= 0.95) { let e = contained.get(p.smallId); if (!e) contained.set(p.smallId, e = []); e.push(p); }
          else overlapOnly.push(p);
        }
        for (const [small, list] of contained) {
          const lo = Math.min(...list.map(p => p.contain)), hi = Math.max(...list.map(p => p.contain));
          finds.push(F.find('high', Math.max(...list.map(p => p.inter)),
            `กฎ ${ruleName(small)} ติดธงเฉพาะสัญญาที่ ${list.map(p => `${p.bigId} (${U.num(p.inter)} สัญญา)`).join(', ')} ติดอยู่แล้ว ` +
              `${lo === hi ? pct(lo, 0) : pct(lo, 0) + '–' + pct(hi, 0)} — น้ำหนักถูกบวกซ้อน`,
            'ทบทวนว่าตั้งใจให้ยกระดับความเสี่ยงหรือไม่ ถ้าไม่ตั้งใจ คือการนับซ้ำ ให้ลดน้ำหนักข้อใดข้อหนึ่งในแท็บนี้'));
        }
        for (const p of overlapOnly.slice(0, 3)) {
          finds.push(F.find('mid', p.inter,
            `กฎ ${p.a} กับ ${p.b} ทับกัน ${U.num(p.inter)} สัญญา (Jaccard ${p.jac.toFixed(2)}, ${pct(p.contain, 0)} ของกฎที่เล็กกว่า) — อาจวัดสิ่งเดียวกัน`,
            'ตรวจว่ากฎสองข้อวัดคนละเรื่องจริงหรือไม่ ถ้าวัดสิ่งเดียวกัน สัญญาชุดนี้ได้คะแนนสูงเกินจริง'));
        }
        if (ch.changed.length) {
          finds.push(F.find('high', 0, `ผู้ใช้ปรับกฎ ${ch.changed.length} ข้อจากค่าเริ่มต้น (${ch.changed.join(', ')}) — คะแนนที่เห็นในทุกแท็บเป็นค่าตามที่ตั้ง ไม่ใช่ค่าตั้งต้นของระบบ`,
            'เปรียบเทียบกับค่าเริ่มต้นก่อนนำผลไปใช้หรืออ้างอิง ปุ่มรีเซ็ตค่าอยู่ในแท็บกฎ'));
        }
        if (gaps.length) {
          finds.push(F.find('mid', 0, `ยังมีช่องว่างที่ตรวจไม่ได้ ${gaps.length} ช่อง (มิติ × ช่วงกระบวนการ)`,
            gaps.join(' | ') + ' — ช่องเหล่านี้ว่างเพราะขาดข้อมูล ไม่ใช่เพราะไม่สำคัญ'));
        }
        if (ch.disabled.length) {
          finds.push(F.find('mid', 0, `กฎที่ถูกปิดไว้ ${ch.disabled.length} ข้อ (${ch.disabled.join(', ')})`, 'สัญญาที่จะติดกฎเหล่านี้ไม่ถูกนับ คะแนนจึงต่ำกว่าที่ค่าเริ่มต้นจะให้'));
        }
        if (synthDefs.length) {
          finds.push(F.find('low', 0, `${synthDefs.length} ข้อเป็นกฎที่ใช้ข้อมูลสาธิต (${synthDefs.map(d => d.id).join(', ')})`, 'ไม่นับรวมในคะแนนที่แสดง'));
        }

        const acts = [];
        if (ov.notable.length) acts.push({ label: `กรองเฉพาะกฎ ${ov.notable[0].smallId}`, kind: 'rule', arg: ov.notable[0].smallId });
        acts.push({ label: 'ไปแท็บสัญญาณเสี่ยง', kind: 'goto', arg: 'pill-fraud' });

        return {
          measure,
          dropped: [
            `ความทับซ้อนของกฎคำนวณจากทั้งชุดข้อมูล ${U.num(allRows.length)} สัญญา ไม่ตามตัวกรอง (เหมือนตารางในแท็บ)`,
            `กฎที่นำมาเทียบความทับซ้อน: ${ov.active.length} จาก ${realDefs.length} ข้อ (ต้องพบ ≥ 20 สัญญา ที่เหลือน้อยเกินจะเทียบได้)`,
            `จำนวนกฎที่พบในขอบเขตนี้คำนวณจาก ${U.num(rows.length)} สัญญาที่กรองอยู่`,
          ],
          baseline, finds: F.sortFinds(finds), acts,
          limits: [
            'คะแนนคือผลรวมน้ำหนักที่มนุษย์กำหนด ไม่ได้ปรับเทียบกับผลการตรวจสอบจริง',
            'ชุดข้อมูลไม่มีผลการตรวจสอบจริง (ground truth) จึงวัดความแม่นยำ (precision/recall) ของกฎไม่ได้เลย ส่วนตารางประเมินการจัดลำดับในแท็บกฎใช้ "ความผิดพลาดของข้อมูล" เป็นป้ายชั่วคราว ไม่ใช่ป้ายการทุจริต',
            'ความทับซ้อนบอกได้เพียงว่ากฎวัดสิ่งเดียวกันหรือไม่ ไม่ได้บอกว่ากฎถูกหรือผิด',
            'ช่องที่ยังตรวจไม่ได้ต้องขอข้อมูลเพิ่มจากหน่วยงานหรือระบบต้นทาง ตามที่ระบุในแต่ละช่อง',
          ],
        };
      },
    },

    'tab-contractor': {
      title: 'ผู้รับจ้าง',
      question: 'ผู้รับจ้างรายไหนมีพฤติกรรมต่างจากตลาดเดียวกัน หรือพึ่งพาหน่วยงานเดียว และตัวเลขมูลค่านับซ้ำหรือไม่',
      build(c) {
        const { rows, opts, L } = c;
        const all = api.contractorProfiles();        // profiles() ของแท็บ: contractorProfiles(state.filtered, nodeIndex) ทุกราย ไม่ตามรายการที่แท็บกรอง
        const cf = opts.contractor;
        const W = Analytics.riskWeights(api.hasNetwork());
        const ub = api.underbid();                   // ubRows() ของแท็บ ใช้เกณฑ์ที่ผู้ใช้ตั้งอยู่ในตาราง "ลดน้อยกว่าสนาม"
        const groups = Analytics.jvGroups(rows);     // app.js renderConJv: jvGroups(state.filtered)

        const totalV = U.sum(all.map(p => p.total_value));
        const byValue = [...all].sort((a, b) => b.total_value - a.total_value);
        const top5v = U.sum(byValue.slice(0, 5).map(p => p.total_value));
        const highRisk = all.filter(p => p.risk.final >= CUT.riskHigh);
        const multi = all.filter(p => p.n_agencies >= 3);
        const single = all.filter(p => p.n_agencies === 1 && p.n_contracts >= 5);   // เกณฑ์เดียวกับป้าย "หน่วยงานเดียว" ในรายการแท็บ
        const underLow = ub.rows.filter(r => r.rel < 0).sort((a, b) => a.rel - b.rel);
        const covered = U.sum(all.map(p => p.n_contracts));
        const DIM = { network: 'ตำแหน่งในเครือข่าย', price: 'ราคาชิดราคากลาง', competition: 'ได้งานด้วยวิธีเฉพาะเจาะจง', contract: 'คะแนนสัญญาสูงสุด', concentration: 'พึ่งพาหน่วยงานเดียว' };
        const drivers = p => Object.keys(DIM).map(k => ({ k, v: W[k] * p.risk[k] })).sort((a, b) => b.v - a.v)[0];

        const scopeExtra = [];
        if (cf.q || cf.riskMin > 0 || cf.contractMin > 1) {
          scopeExtra.push('รายการด้านซ้ายของแท็บถูกกรองเพิ่ม แต่การไล่เหตุผลนี้ใช้ผู้รับจ้างทุกรายในขอบเขตที่กรองอยู่');
        }

        const measure = [
          F.m('ผู้รับจ้างในขอบเขต', `${U.num(all.length)} ราย`, `มูลค่ารวม ${money(totalV)} บาท`),
          F.m('5 รายแรกตามมูลค่า', totalV > 0 ? pct(top5v / totalV) : '-', `${money(top5v)} บาท`),
          F.m('คะแนนรวม ≥ 40', `${U.num(highRisk.length)} ราย`, 'ตรงกับ KPI ในแท็บ'),
          F.m('ได้งาน ≥ 3 หน่วยงาน', `${U.num(multi.length)} ราย`, 'ตรงกับ KPI ในแท็บ'),
          F.m('พึ่งพาหน่วยงานเดียว (≥ 5 สัญญา)', `${U.num(single.length)} ราย`, `มูลค่า ${money(U.sum(single.map(p => p.total_value)))} บาท`),
        ];

        const baseline = [
          { label: 'คะแนนรวม 0–100',
            value: api.hasNetwork()
              ? `ถ่วงน้ำหนัก เครือข่าย ${pct(W.network, 0)} · ราคา ${pct(W.price, 0)} · การแข่งขัน ${pct(W.competition, 0)} · สัญญา ${pct(W.contract, 0)} · การกระจุกตัว ${pct(W.concentration, 0)}`
              : `4 มิติ (ไม่มีดัชนีเครือข่าย) ราคา ${pct(W.price, 0)} · การแข่งขัน ${pct(W.competition, 0)} · สัญญา ${pct(W.contract, 0)} · การกระจุกตัว ${pct(W.concentration, 0)}`,
            source: 'น้ำหนักที่มนุษย์ตั้ง (Analytics.riskWeights) ไม่ได้ปรับเทียบกับผลการตรวจสอบจริง' },
          { label: 'ค่ากลางของสนามเดียวกัน', value: `เทียบได้เมื่อมีสัญญาที่เทียบได้ ≥ ${ub.min} ฉบับ`,
            source: 'ส่วนลดของแต่ละรายเทียบมัธยฐานของสัญญาที่วิธีจัดหาและประเภทเดียวกัน คิดจากข้อมูลทั้งชุดเสมอ ไม่ตามตัวกรอง แต่รายชื่อมาจากขอบเขตที่กรองอยู่' },
          { label: 'เกณฑ์หน่วยงานเดียว', value: 'ได้งานจาก 1 หน่วยงาน และ ≥ 5 สัญญา', source: 'เกณฑ์เดียวกับป้ายเตือนในรายการของแท็บ' },
          { label: 'ระดับ "สำคัญมาก" ของคะแนนรวม', value: `≥ ${CUT.riskHigh}`, source: 'ขอบระดับสูงของระบบคะแนน (Rules.BANDS) เท่ากับ KPI "คะแนน ≥ 40"' },
        ];

        const finds = [];
        for (const p of all.filter(x => x.risk.final > 0).slice(0, 3)) {
          const d = drivers(p);
          finds.push(F.find(p.risk.final >= CUT.riskHigh ? 'high' : 'mid', p.total_value,
            `${L.truncate(p.winner_name, 44)}: คะแนนรวม ${p.risk.final.toFixed(1)} · ${U.num(p.n_contracts)} สัญญา · ${U.num(p.n_agencies)} หน่วยงาน · ${money(p.total_value)} บาท`,
            `ส่วนที่ดันคะแนนมากที่สุดคือ "${DIM[d.k]}" (ตัวเลขนี้คือคะแนนถ่วงน้ำหนัก ไม่ใช่ข้อกล่าวหา) — เปิดรายละเอียดผู้รับจ้างและอ่านสัญญาที่เกี่ยวข้องก่อนสรุป`));
        }
        if (byValue.length && totalV > 0) {
          finds.push(F.find('mid', top5v,
            `ผู้รับจ้าง 5 รายแรกตามมูลค่าได้ ${pct(top5v / totalV)} ของ ${money(totalV)} บาท (รายแรก ${L.truncate(byValue[0].winner_name, 36)} ${pct(byValue[0].total_value / totalV)})`,
            'ตลาดที่มีผู้ทำได้น้อยรายอาจเป็นธรรมชาติของงานเฉพาะทาง ดูขอบเขตงานประกอบก่อนตีความว่ากระจุกตัวผิดปกติ'));
        }
        if (multi.length) {
          const t = [...multi].sort((a, b) => b.n_agencies - a.n_agencies || b.total_value - a.total_value)[0];
          finds.push(F.find('mid', U.sum(multi.map(p => p.total_value)),
            `${U.num(multi.length)} รายได้งานจาก ≥ 3 หน่วยงาน สูงสุดคือ ${L.truncate(t.winner_name, 38)} (${U.num(t.n_agencies)} หน่วยงาน ${U.num(t.n_contracts)} สัญญา)`,
            'ผู้รับจ้างรายใหญ่ได้งานหลายหน่วยงานได้ตามปกติ ให้ดูว่างานส่วนใหญ่ได้มาด้วยวิธีเฉพาะเจาะจงหรือไม่ก่อนตีความ'));
        }
        if (single.length) {
          const t = [...single].sort((a, b) => b.total_value - a.total_value)[0];
          finds.push(F.find('mid', U.sum(single.map(p => p.total_value)),
            `${U.num(single.length)} รายได้งานจากหน่วยงานเดียวทั้งหมด (≥ 5 สัญญา) มูลค่าสูงสุดคือ ${L.truncate(t.winner_name, 34)} ${money(t.total_value)} บาท จาก ${L.truncate(t.pairs[0].source, 30)}`,
            'ตรวจว่าเป็นผู้รับจ้างประจำพื้นที่หรือรับเหมาช่วงตามธรรมชาติของงาน หรือมีการกำหนดเงื่อนไขให้เอื้อรายเดียว'));
        }
        if (underLow.length) {
          const t = underLow[0];
          finds.push(F.find('mid', U.sum(underLow.slice(0, 5).map(r => r.value)),
            `${U.num(underLow.length)} ราย ลดจากราคากลางน้อยกว่าค่ากลางของสนามเดียวกัน (เทียบได้ ≥ ${ub.min} ฉบับ) มากสุด ${L.truncate(t.winner_name, 32)} ต่ำกว่าสนาม ${(Math.abs(t.rel) * 100).toFixed(1)} จุด (เทียบได้ ${U.num(t.nComparable)} ฉบับ)`,
            'ไม่ได้แปลว่าผิด งานที่ยาก พื้นที่ห่างไกล หรือสเปกสูงกว่าค่ากลางก็ทำให้ราคาสูงได้ตามจริง ตารางนี้ใช้จัดลำดับว่าควรดูสัญญาไหนก่อน'));
        }
        if (groups.length) {
          const members = new Set();
          for (const g of groups) for (const m of g.members) members.add(m.winner_key);
          finds.push(F.find('mid', U.sum(groups.map(g => g.memberSum)),
            `พบสัญญากิจการค้าร่วม ${U.num(groups.length)} กลุ่ม (${U.num(members.size)} บริษัทสมาชิก) รวม ${money(U.sum(groups.map(g => g.memberSum)))} บาท`,
            'ในตัวเลขทุกแท็บ แถวสมาชิกถูกนับเป็นสัญญาแยกกัน ทั้งที่ยอดของสมาชิกรวมกันเท่ากับยอดกิจการค้าร่วม มูลค่าของรายที่ร่วมค้าจึงอาจนับซ้ำ ให้อ่านด้วยความระวัง'));
        }
        const sel = cf.selected ? all.find(p => p.winner_name === cf.selected.winner_name) : null;
        if (cf.selected && sel) {
          const top = sel.pairs[0];
          finds.push(F.find(sel.risk.final >= CUT.riskHigh ? 'high' : 'mid', sel.total_value,
            `รายที่แสดงโปรไฟล์อยู่ในแท็บ: ${L.truncate(sel.winner_name, 40)} — คะแนนรวม ${sel.risk.final.toFixed(1)} · ${U.num(sel.n_contracts)} สัญญา` +
              (top ? ` · ${L.truncate(top.source, 26)} ให้งาน ${pct(sel.total_value > 0 ? top.value / sel.total_value : null, 0)} ของมูลค่า` : '') +
              ` · วิธีเฉพาะเจาะจง ${sel.risk.competition.toFixed(0)}% ของสัญญา · ราคาชิดราคากลาง (≥ 99%) ${sel.risk.price.toFixed(0)}% ของสัญญาที่มีราคากลาง`,
            'ตัวเลขทั้งหมดนี้มาจากการ์ดโปรไฟล์ของรายที่เลือก ใช้ดูว่ารายนี้สูงเพราะมิติใด แล้วเปิดสัญญาที่คะแนนสูงสุดของรายนี้'));
        } else if (cf.selected) {
          finds.push(F.find('low', 0, `ผู้รับจ้างที่เลือกไว้ในแท็บ (${L.truncate(cf.selected.winner_name, 36)}) ไม่อยู่ในขอบเขตที่กรองอยู่แล้ว`,
            'ตัวเลขในแท็บอาจยังโชว์รายเดิมค้างอยู่ ให้เลือกใหม่จากรายการก่อนอ่านโปรไฟล์'));
        }

        const acts = [];
        const lead = all.find(p => p.risk.final > 0);
        if (lead) {
          acts.push({ label: `ดูรายละเอียด: ${L.truncate(lead.winner_name, 30)}`, kind: 'detail', arg: { type: 'contractor', id: lead.winner_name } });
          const worst = [...lead.rows].sort((a, b) => b.risk_score - a.risk_score)[0];
          if (worst) acts.push({ label: `เปิดโปรไฟล์สัญญาคะแนนสูงสุดของรายนี้: ${L.truncate(worst.project_name, 22)}`, kind: 'profile', arg: worst.project_id });
        }

        return {
          scopeExtra,
          measure,
          dropped: [
            F.dropped(covered, rows.length, ' ไม่มีชื่อผู้รับจ้าง จึงไม่ถูกจัดเป็นโปรไฟล์'),
            `ตารางลดน้อยกว่าสนาม: ${U.num(ub.rows.length)} ราย เข้าเกณฑ์เทียบได้ (≥ ${ub.min} ฉบับ${ub.value > 0 ? ` และมูลค่า ≥ ${money(ub.value)} บาท` : ''}) ที่เหลือมีสัญญาเทียบได้น้อยเกินไป`,
          ],
          baseline, finds: F.sortFinds(finds), acts,
          limits: [
            'ชุดข้อมูลไม่มีราคาของผู้แพ้และจำนวนผู้เสนอราคา จึงไม่รู้ว่าการได้งานมาจากการแข่งขันจริงหรือไม่',
            'ชื่อผู้รับจ้างถูกทำให้เป็นมาตรฐานก่อนวิเคราะห์ อาจรวมคนละรายเข้าด้วยกันหรือแยกรายเดียวออกเป็นสองราย และเลขผู้เสียภาษีบางรายถูกปิดบังจึงไม่ใช้จับคู่ตัวตน',
            'คะแนนรวมเป็นผลรวมน้ำหนักที่มนุษย์ตั้ง ใช้จัดลำดับความสำคัญ ไม่ใช่ความน่าจะเป็นที่จะผิดจริง',
            'ข้อมูลกรรมการมาจากที่ผู้ใช้พิมพ์เอง (ไม่ได้ดึงจากแหล่งทางการ) และจับคู่ตรงตัวอักษร พลาดได้ทั้งสองทาง',
            ...(api.hasNetwork() ? [] : ['ชุดข้อมูลนี้ไม่มีดัชนีเครือข่ายจาก ETL คะแนนรวมจึงตัดมิติเครือข่ายออกและเกลี่ยน้ำหนักที่เหลือใหม่']),
          ],
        };
      },
    },

    'tab-agency': {
      title: 'หน่วยงาน',
      question: 'หน่วยงานไหนซื้อแบบผูกกับผู้ขายรายเดียว พึ่งวิธีเฉพาะเจาะจงมาก หรือแทบไม่มีรายใหม่',
      build(c) {
        const { rows, opts, L } = c;
        const all = api.agencyProfiles();            // agencyProfilesCached(): agencyProfiles(state.filtered, {level}) ตามระดับที่เลือกในแท็บ
        const level = opts.agency.level;
        const lv = level === 'sub' ? 'หน่วยงานย่อย' : 'หน่วยงาน';   // Analytics.BUYER_LEVELS
        const nm = a => L.truncate(api.agencyName(a), 40);
        const enough = all.filter(a => a.n_contracts >= 5);          // เกณฑ์ minContracts = 5 เดียวกับ Analytics.hhi/screening
        const specOf = a => a.methods.find(m => m.label === Rules.SPECIFIC_METHOD);
        const conc = enough.filter(a => a.hhi !== null && a.hhi > 2500);
        const dom = enough.filter(a => a.top_winner_share >= CUT.topShareMid)
          .sort((a, b) => b.top_winner_share - a.top_winner_share || b.total_value - a.total_value);
        const specHeavy = enough.filter(a => { const m = specOf(a); return m && m.share >= CUT.specificWarn; })
          .sort((a, b) => b.total_value - a.total_value);
        const newLow = enough.filter(a => a.loyalty.share !== null && a.loyalty.share < CUT.newSupplierLow)
          .sort((a, b) => b.total_value - a.total_value);
        const oneContractor = enough.filter(a => a.n_contractors === 1);
        const specBase = rows.length ? rows.filter(r => r.purchase_method_name === Rules.SPECIFIC_METHOD).length / rows.length : null;
        const covered = U.sum(all.map(a => a.n_contracts));
        const totalV = U.sum(all.map(a => a.total_value));

        const measure = [
          F.m(`${lv}ในขอบเขต`, U.num(all.length), `มูลค่ารวม ${money(totalV)} บาท`),
          F.m('มีสัญญา ≥ 5 ฉบับ (ตีความ HHI ได้)', `${U.num(enough.length)} แห่ง`, `ที่เหลือ ${U.num(all.length - enough.length)} แห่งสัญญาน้อยเกินไป`),
          F.m('HHI > 2,500', `${U.num(conc.length)} แห่ง`, 'ตรงกับ KPI ในแท็บ'),
          F.m('ผู้ชนะรายเดียว ≥ 50% ของมูลค่า', `${U.num(dom.length)} แห่ง`, 'ตรงกับ KPI ในแท็บ'),
          F.m('ใช้เฉพาะเจาะจง ≥ 80% ของสัญญา', `${U.num(specHeavy.length)} แห่ง`, specBase === null ? '' : `ค่าฐานทั้งขอบเขต ${pct(specBase)}`),
        ];

        const baseline = [
          { label: 'ดัชนีกระจุกตัว HHI', value: '1,500 เริ่มกระจุก · 2,500 กระจุกสูง', source: 'เกณฑ์สากลของดัชนี HHI ตามที่แท็บนี้ใช้ ไม่ใช่ตัวเลขที่ตั้งขึ้นเอง' },
          { label: 'ส่วนแบ่งผู้ชนะรายใหญ่สุด', value: `≥ ${pct(CUT.topShareMid, 0)} (KPI ของแท็บ) · ≥ ${pct(CUT.topShareHigh, 0)} ระดับสูง`, source: 'ยืมจากแท็บหน่วยงาน (KPI) และตารางคัดกรองในแท็บเครือข่าย ซึ่งเป็นเกณฑ์ที่ระบบตั้งเอง' },
          { label: 'สัดส่วนวิธีเฉพาะเจาะจงทั้งขอบเขต', value: specBase === null ? '-' : pct(specBase), source: `ค่าฐานเทียบว่าแต่ละ${lv}เบี่ยงแค่ไหน · ป้ายเตือนของแท็บใช้ ≥ ${pct(CUT.specificWarn, 0)}` },
          { label: 'ผู้ชนะรายใหม่', value: `< ${pct(CUT.newSupplierLow, 0)} = แทบไม่มีรายใหม่`, source: 'ยืมจากป้าย "แทบไม่มีรายใหม่" ในรายการของแท็บ (Analytics.newSupplierShare)' },
        ];

        const finds = [];
        for (const a of dom.slice(0, 4)) {
          finds.push(F.find(a.top_winner_share >= CUT.topShareHigh ? 'high' : 'mid', a.total_value * a.top_winner_share,
            `${nm(a)} (${U.num(a.n_contracts)} สัญญา): ${L.truncate(a.top_winner, 34)} ได้ ${pct(a.top_winner_share)} ของมูลค่า ${money(a.total_value)} บาท` +
              (a.hhi !== null ? ` · HHI ${U.num(Math.round(a.hhi))}` : ''),
            'ตรวจว่าเป็นงานเฉพาะทางที่มีผู้ทำได้น้อยรายจริง หรือมีการกำหนดสเปกให้เอื้อรายเดียว โดยดูขอบเขตงานและวิธีจัดหาของสัญญาเหล่านั้น'));
        }
        for (const a of specHeavy.slice(0, 3)) {
          const m = specOf(a);
          finds.push(F.find('mid', a.total_value * m.share,
            `${nm(a)} ใช้วิธีเฉพาะเจาะจง ${pct(m.share)} ของ ${U.num(a.n_contracts)} สัญญา (ค่าฐานทั้งขอบเขต ${specBase === null ? '-' : pct(specBase)})`,
            'ตรวจเหตุผลการเลือกวิธีเฉพาะเจาะจงรายสัญญา และดูว่ามีสัญญาราคาชิดเพดานจำนวนมากหรือไม่ (แท็บนี้มีส่วนวิเคราะห์เชิงลึกวิธีจัดหา)'));
        }
        if (conc.length) {
          finds.push(F.find('mid', U.sum(conc.map(a => a.total_value)),
            `${U.num(conc.length)} จาก ${U.num(enough.length)} ${lv} (≥ 5 สัญญา) มี HHI สูงกว่า 2,500`,
            'ตลาดผู้ขายน้อยรายโดยธรรมชาติ (งานเทคนิคเฉพาะ) ให้ค่า HHI สูงเหมือนการผูกขาด ต้องดูขอบเขตงานก่อนสรุป และลองสลับระดับกรม/หน่วยงานย่อยเพราะตัวเลขระดับกรมอาจกลบการกระจุกตัวของสาขา'));
        }
        if (newLow.length) {
          const a = newLow[0];
          finds.push(F.find('mid', U.sum(newLow.map(x => x.total_value)),
            `${U.num(newLow.length)} ${lv} (≥ 5 สัญญา) แทบไม่มีผู้ชนะรายใหม่ (< ${pct(CUT.newSupplierLow, 0)}) เช่น ${nm(a)} มีรายใหม่ ${pct(a.loyalty.share, 0)} จากผู้ชนะ ${U.num(a.loyalty.distinctWinners)} ราย`,
            'ข้อมูลมีเพียงช่วงเดียว "รายใหม่" จึงแปลว่า "ไม่เคยปรากฏในช่วงที่มีข้อมูล" ไม่ใช่ผู้รับจ้างหน้าใหม่ในระบบจริง และผู้ชนะสัญญาแรกสุดถูกนับเป็นรายใหม่เสมอ อ่านเป็นข้อสังเกตเท่านั้น'));
        }
        if (oneContractor.length) {
          finds.push(F.find('mid', U.sum(oneContractor.map(a => a.total_value)),
            `${U.num(oneContractor.length)} ${lv} มีสัญญา ≥ 5 ฉบับแต่ผู้รับจ้างรายเดียวทั้งหมด`,
            'ตรวจว่าเป็นสัญญาต่อเนื่องของงานเดียว (เช่น บำรุงรักษา) หรือการจัดหาที่ไม่เปิดให้รายอื่นเข้าแข่ง'));
        }
        const sel = opts.agency.selected ? all.find(a => a.dept_name === opts.agency.selected.dept_name) : null;
        if (opts.agency.selected && sel) {
          const m = specOf(sel);
          finds.push(F.find('mid', sel.total_value,
            `รายที่แสดงโปรไฟล์อยู่ในแท็บ: ${nm(sel)} — ${U.num(sel.n_contracts)} สัญญา · ${U.num(sel.n_contractors)} ผู้รับจ้าง · ${money(sel.total_value)} บาท` +
              (sel.n_contracts >= 5 ? ` · ผู้ชนะรายใหญ่สุด ${pct(sel.top_winner_share, 0)}${sel.hhi !== null ? ` · HHI ${U.num(Math.round(sel.hhi))}` : ''}` : ' · สัญญาน้อยกว่า 5 ฉบับ ยังตีความ HHI ไม่ได้') +
              (m ? ` · เฉพาะเจาะจง ${pct(m.share, 0)}` : ''),
            'ตัวเลขทั้งหมดนี้มาจากการ์ดโปรไฟล์ของรายที่เลือก ใช้ประกอบข้อสังเกตข้างบน'));
        }
        if (all.length - enough.length > 0) {
          finds.push(F.find('low', 0, `${U.num(all.length - enough.length)} ${lv} มีสัญญาน้อยกว่า 5 ฉบับ จึงไม่ถูกนำมาตัดสินเรื่องกระจุกตัวเลย`,
            'สัญญา 1 ฉบับ = ผู้ชนะรายเดียว 100% = HHI 10,000 เสมอ ไม่ใช่สัญญาณจริง นี่คือ "ยังไม่ได้ตรวจ" ไม่ใช่ "ตรวจแล้วผ่าน"'));
        }

        const acts = [];
        const lead = dom[0] || specHeavy[0];
        if (lead) {
          acts.push({ label: `ดูรายละเอียด: ${L.truncate(api.agencyName(lead), 28)}`, kind: 'detail', arg: { type: 'agency', id: lead.dept_key } });
          const worst = [...lead.rows].sort((a, b) => b.risk_score - a.risk_score)[0];
          if (worst) acts.push({ label: `เปิดโปรไฟล์สัญญาคะแนนสูงสุดของ${lv}นี้: ${L.truncate(worst.project_name, 20)}`, kind: 'profile', arg: worst.project_id });
        }
        acts.push({ label: 'ดูความสัมพันธ์ในแท็บเครือข่าย', kind: 'goto', arg: 'pill-network' });

        return {
          scopeExtra: [`กำลังนับที่ระดับ "${lv}" ${level === 'sub' ? '(แยกสาขา)' : '(รวมทุกสาขาเข้าด้วยกัน)'} — ผลเปลี่ยนตามระดับที่เลือกในแท็บ`],
          measure,
          dropped: [
            F.dropped(covered, rows.length, ` ไม่มีชื่อ${lv}`),
            `${U.num(enough.length)} จาก ${U.num(all.length)} ${lv} มีสัญญา ≥ 5 ฉบับ ที่เหลือ ${U.num(all.length - enough.length)} แห่งไม่ถูกนำมาตัดสินเรื่อง HHI และส่วนแบ่งผู้ชนะ`,
          ],
          baseline, finds: F.sortFinds(finds), acts,
          limits: [
            `ผลทั้งหมดนับที่ระดับ "${lv}" ถ้าสลับเป็นระดับอื่น ตัวเลขและรายชื่อจะเปลี่ยน (ระดับกรมรวมทุกสาขา อาจกลบการกระจุกตัวของสาขา)`,
            'ตัดหน่วยงานที่มีสัญญาน้อยกว่า 5 ฉบับออกจากการตัดสินทั้งหมด หน่วยงานเหล่านั้นไม่ถูกประเมินเรื่องกระจุกตัว',
            'ตลาดผู้ขายน้อยรายโดยธรรมชาติของงาน (เทคนิคเฉพาะ) ให้ผลเหมือนการผูกขาด ต้องดูขอบเขตงานจริงก่อนสรุป',
            '"ผู้ชนะรายใหม่" วัดได้เพียงในช่วงเวลาที่มีข้อมูล (ช่วงเดียว) ไม่ใช่ผู้รับจ้างหน้าใหม่ในระบบจัดซื้อจริง',
            'ชุดข้อมูลไม่มีจำนวนผู้เสนอราคา จึงแยกไม่ได้ว่าผู้ชนะรายเดียวเพราะไม่มีคู่แข่งหรือเพราะชนะการแข่งขัน',
          ],
        };
      },
    },

    'tab-network': {
      title: 'เครือข่ายความสัมพันธ์',
      question: 'คู่หน่วยงาน–ผู้รับจ้างคู่ไหนผูกกันแน่นผิดปกติ และกราฟที่เห็นครอบคลุมคู่ทั้งหมดแค่ไหน',
      build(c) {
        const { rows, opts, L } = c;
        const nt = opts.net;
        const allEdges = Analytics.networkEdges(rows);          // app.js renderNetwork: networkEdges(state.filtered)
        const matching = api.netFilter(allEdges);               // netFilteredEdges(allEdges) ตัวกรองเฉพาะแท็บเครือข่าย
        const shown = matching.slice(0, nt.topN);               // กราฟแสดงเฉพาะ topN คู่แรก
        const repeat = Analytics.repeatWinners(rows);           // ค่าเริ่มต้น minAgencies = 3 เหมือนแท็บ
        const big = rows.length > CUT.bigData;
        const terr = big ? null : api.territory();              // terrCompute() ใช้ส่วนแบ่ง/ขนาดตลาดที่ผู้ใช้ตั้งในแท็บ
        const totalV = U.sum(allEdges.map(e => e.value));
        const shownV = U.sum(shown.map(e => e.value));
        const critical = allEdges.filter(e => Rules.band(e.max_risk).key === 'critical');
        const medianN = allEdges.length ? U.median(allEdges.map(e => e.n)) : null;
        const masked = allEdges.filter(e => e.masked);
        const edgeRows = U.sum(allEdges.map(e => e.n));

        const scopeExtra = [];
        const nf = [];
        if (nt.agency) nf.push(`หน่วยงาน ${L.truncate(nt.agency, 24)}`);
        if (nt.contractor) nf.push(`ผู้รับจ้าง ${L.truncate(nt.contractor, 24)}`);
        if (nt.rule) nf.push(`กฎ ${nt.rule}`);
        if (nt.band) { const bd = Rules.BANDS.find(b => b.key === nt.band); nf.push(`ระดับ ${bd ? bd.label : nt.band}`); }
        if (nt.flaggedOnly) nf.push('เฉพาะที่มีสัญญาณ');
        if (nt.maskedOut) nf.push('ตัดเลขภาษีที่ถูกปิดบัง');
        if (nt.minContracts > 1) nf.push(`≥ ${nt.minContracts} สัญญาต่อคู่`);
        if (nt.minValue > 0) nf.push(`มูลค่าคู่ ≥ ${nt.minValue} ล้านบาท`);
        scopeExtra.push(`ตัวกรองเฉพาะแท็บเครือข่าย: ${nf.length ? nf.join(' · ') : 'ไม่มี'} · แสดง ${U.num(nt.topN)} คู่แรกบนกราฟ`);

        const measure = [
          F.m('คู่หน่วยงาน–ผู้รับจ้าง', U.num(allEdges.length), `เข้าเงื่อนไขของแท็บ ${U.num(matching.length)} คู่`),
          F.m('กราฟแสดง', `${U.num(shown.length)} คู่`, totalV > 0 ? `ครอบคลุม ${pct(shownV / totalV)} ของมูลค่าทุกคู่` : ''),
          F.m('คู่ที่มีสัญญาระดับวิกฤต', `${U.num(critical.length)} คู่`, `มูลค่า ${money(U.sum(critical.map(e => e.value)))} บาท`),
          F.m('ผู้รับจ้างที่ได้งาน ≥ 3 หน่วยงาน', `${U.num(repeat.length)} ราย`, ''),
          F.m('คู่ที่ครองพื้นที่เดียวกัน', big ? 'ข้าม' : `${U.num(terr.rows.length)} คู่`, big ? `ขอบเขตใหญ่เกิน ${U.num(CUT.bigData)} สัญญา` : `ส่วนแบ่ง ≥ ${pct(terr.share, 0)} ในตลาด ≥ ${terr.market} สัญญา`),
        ];

        const baseline = [];
        if (medianN !== null) {
          baseline.push({ label: 'มัธยฐานจำนวนสัญญาต่อคู่', value: `${U.num(medianN, 1)} สัญญา`, source: 'มัธยฐานของทุกคู่ในขอบเขตที่กรองอยู่ (Analytics.networkEdges)' });
        }
        baseline.push({ label: 'ระดับความเสี่ยงของคู่', value: 'คะแนนสูงสุดของสัญญาในคู่นั้น', source: 'ใช้ขอบระดับเดียวกับระบบคะแนน (Rules.BANDS) คู่ระดับวิกฤตมีสัญญาที่คะแนน ≥ 60 อย่างน้อย 1 ฉบับ' });
        if (terr) {
          baseline.push({ label: 'คู่ที่ครองพื้นที่เดียวกัน', value: `ส่วนแบ่ง ≥ ${pct(terr.share, 0)} ของสัญญาในรัศมี และตลาด ≥ ${terr.market} สัญญา`,
            source: 'ค่าที่ตั้งอยู่ในแท็บ (Analytics.territoryPairs) หาพื้นที่ทำงานจากพิกัดที่ไม่ใช่พิกัดใช้ร่วม' });
          baseline.push({ label: 'ระดับ "สำคัญมาก" ของคู่ครองพื้นที่', value: `ส่วนแบ่ง ≥ ${pct(CUT.terrHigh, 0)}`, source: 'เกณฑ์ที่หน้าต่างนี้ตั้งเอง ไม่ใช่เกณฑ์ทางกฎหมาย' });
        }

        const finds = [];
        if (allEdges.length) {
          const e = allEdges[0];
          const isCrit = Rules.band(e.max_risk).key === 'critical';
          finds.push(F.find(isCrit ? 'high' : 'mid', e.value,
            `${L.truncate(e.source, 34)} – ${L.truncate(e.target, 34)}: ${U.num(e.n)} สัญญา รวม ${money(e.value)} บาท (${totalV > 0 ? pct(e.value / totalV) : '-'} ของมูลค่าทุกคู่) · คะแนนสูงสุดในคู่ ${U.num(e.max_risk)}` +
              (medianN !== null ? ` · มัธยฐานของทุกคู่ ${U.num(medianN, 1)} สัญญา` : ''),
            'ตรวจว่าเป็นความสัมพันธ์ตามธรรมชาติของงาน (หน่วยงานที่ซื้อของชนิดเดียวซ้ำ) หรือการได้งานต่อเนื่องด้วยวิธีเฉพาะเจาะจง โดยเปิดสัญญาในคู่นี้ดู'));
        }
        if (critical.length) {
          finds.push(F.find('high', U.sum(critical.map(e => e.value)),
            `${U.num(critical.length)} คู่มีสัญญาระดับวิกฤตอย่างน้อย 1 ฉบับ รวมมูลค่า ${money(U.sum(critical.map(e => e.value)))} บาท`,
            'ในแท็บนี้เลือกระดับ "วิกฤต" ที่ตัวกรองระดับความเสี่ยงของเครือข่ายเพื่อดูเฉพาะคู่เหล่านี้ แล้วเปิดสัญญาที่คะแนนสูงสุดในแต่ละคู่'));
        }
        if (terr) {
          for (const t of terr.rows.slice(0, 3)) {
            finds.push(F.find(t.share >= CUT.terrHigh ? 'high' : 'mid', t.value,
              `${L.truncate(t.a.name, 28)} กับ ${L.truncate(t.b.name, 28)} ครองพื้นที่เดียวกัน: ${U.num(t.taken)} จาก ${U.num(t.market)} สัญญา (${pct(t.share, 0)}) ในรัศมี ${t.radiusKm.toFixed(0)} กม.` +
                (t.depts[0] ? ` · ${L.truncate(t.depts[0][0], 26)}` : ''),
              'คู่นี้มีพื้นที่ทำงานทับกันและแบ่งงานของหน่วยงานร่วมกันเกือบทั้งหมด แต่ระบบเคยวัดในชุดข้อมูลหลักว่าการสลับกันชนะตามเวลาของคู่แบบนี้ไม่ต่างจากการสุ่ม จึงอย่าเรียกว่าการผลัดกันชนะ ใช้เป็นจุดตั้งต้นให้ดูเอกสารการเสนอราคา'));
          }
        }
        if (repeat.length) {
          finds.push(F.find('mid', U.sum(repeat.map(r => r.total_value)),
            `${U.num(repeat.length)} ราย ได้งานจาก ≥ 3 หน่วยงาน สูงสุดคือ ${L.truncate(repeat[0].winner_name, 36)} (${U.num(repeat[0].n_agencies)} หน่วยงาน ${U.num(repeat[0].n_contracts)} สัญญา)`,
            'ผู้รับจ้างรายใหญ่ได้งานหลายหน่วยงานได้ตามปกติ ดูว่างานส่วนใหญ่ได้มาด้วยวิธีเฉพาะเจาะจงหรือไม่ (แท็บผู้รับจ้าง)'));
        }
        finds.push(F.find('low', 0,
          `กราฟแสดง ${U.num(shown.length)} คู่ จาก ${U.num(matching.length)} คู่ที่เข้าเงื่อนไข (ตั้งไว้ ${U.num(nt.topN)}) — ข้อสังเกตข้างบนคิดจากทั้ง ${U.num(allEdges.length)} คู่ ไม่ใช่เฉพาะที่เห็นบนกราฟ`,
          'ถ้าคู่ที่สนใจไม่อยู่บนกราฟ ให้เพิ่มจำนวนคู่ที่แสดงหรือกรองหน่วยงาน/ผู้รับจ้างในแท็บนี้'));
        if (masked.length) {
          finds.push(F.find('low', U.sum(masked.map(e => e.value)), `${U.num(masked.length)} คู่มีเลขภาษีผู้รับจ้างถูกปิดบังทุกสัญญา`,
            'ยืนยันตัวตนผู้รับจ้างของคู่เหล่านี้ไม่ได้ จึงเชื่อมกับข้อมูลภายนอกไม่ได้ (ตัดออกได้ด้วยตัวเลือก "ตัดเลขภาษีที่ถูกปิดบัง" ในแท็บ)'));
        }
        if (big) {
          finds.push(F.find('low', 0, `ข้ามการหาคู่ที่ครองพื้นที่เดียวกัน เพราะขอบเขตมี ${U.num(rows.length)} สัญญา (เกิน ${U.num(CUT.bigData)})`,
            'การหาคู่ต้องเทียบผู้รับจ้างทีละคู่ ใช้เวลานานเมื่อข้อมูลมาก กรองให้แคบลงแล้วเปิดหน้าต่างนี้ใหม่'));
        }

        const acts = [];
        if (allEdges.length) {
          const e = allEdges[0];
          acts.push({ label: `ดูหน่วยงาน: ${L.truncate(e.source, 26)}`, kind: 'detail', arg: { type: 'agency', id: e.source } });
          acts.push({ label: `ดูผู้รับจ้าง: ${L.truncate(e.target, 26)}`, kind: 'detail', arg: { type: 'contractor', id: e.target } });
          const worst = [...e.rows].sort((a, b) => b.risk_score - a.risk_score)[0];
          if (worst) acts.push({ label: `เปิดโปรไฟล์สัญญาคะแนนสูงสุดของคู่นี้: ${L.truncate(worst.project_name, 20)}`, kind: 'profile', arg: worst.project_id });
        }
        acts.push({ label: 'ไปแท็บหน่วยงาน', kind: 'goto', arg: 'pill-agency' });

        return {
          scopeExtra,
          measure,
          dropped: [
            F.dropped(edgeRows, rows.length, ' ไม่มีชื่อหน่วยงานหรือผู้รับจ้าง จึงไม่ถูกนับเป็นคู่'),
            big ? `คู่ที่ครองพื้นที่เดียวกันไม่ได้คำนวณ (ขอบเขตเกิน ${U.num(CUT.bigData)} สัญญา)` : 'คู่ที่ครองพื้นที่เดียวกันใช้เฉพาะสัญญาที่มีพิกัดและไม่ใช่พิกัดใช้ร่วมหลายโครงการ',
          ],
          baseline, finds: F.sortFinds(finds), acts,
          limits: [
            'เส้นเชื่อม = มีสัญญาร่วมกันเท่านั้น ไม่ใช่ความสัมพันธ์ทางกฎหมาย การถือหุ้น หรือการสมยอมราคา',
            'ชุดข้อมูลไม่มีราคาของผู้แพ้และจำนวนผู้เสนอราคา จึงชี้การสมยอมราคาจากข้อมูลนี้ไม่ได้',
            'ตาราง "กรรมการร่วม" ในแท็บมาจากข้อมูลที่ผู้ใช้พิมพ์เอง จับคู่ตรงตัวอักษร ไม่ได้มาจากแหล่งทางการ',
            'คู่ที่ครองพื้นที่เดียวกันอิงพิกัดของงาน ซึ่งบางส่วนเป็นพิกัดตั้งต้นหรือที่ตั้งหน่วยงาน (ตัดพิกัดที่ระบบติดป้ายว่าใช้ร่วมหลายโครงการออกแล้ว แต่จับได้ไม่หมด)',
          ],
        };
      },
    },

    'tab-explain': {
      title: 'แผนที่รายโครงการ',
      question: 'งานกระจุกอยู่ที่ไหน และตำแหน่งบนแผนที่เชื่อถือได้แค่ไหน',
      build(c) {
        const { rows, meta, opts, L } = c;
        const mp = opts.map;
        const hasGeo = r => r.lat !== null && r.lat !== undefined && r.lon !== null && r.lon !== undefined;
        const geo = rows.filter(hasGeo);
        const shared = geo.filter(r => r.geo_quality === 'shared');
        const shown = api.mapShown();                            // mapGeoRows(): จุดที่วาดอยู่จริง (ตามตัวกรอง เดือนที่เลื่อน และการซ่อนพิกัดร่วม/ซ้ำ)
        const stack = api.stackGroups();                          // stackGroups(): stackedPoints(state.filtered, {minContracts:3, limit:80})
        const exact = stack.filter(g => g.kind === 'exact');
        const cluster = stack.filter(g => g.kind === 'cluster');
        const capped = stack.length >= 80 ? 'อย่างน้อย ' : '';
        const exactRows = exact.flatMap(g => g.rows);
        const noGeo = rows.filter(r => !hasGeo(r));

        // รวมตามจังหวัด (ที่ตั้งของหน่วยงาน ไม่ใช่ที่ตั้งงาน)
        const byProv = [...U.groupBy(rows, r => r.province)].map(([province, list]) => ({ province, n: list.length, value: sumV(list) }))
          .sort((a, b) => b.value - a.value);
        const withProv = U.sum(byProv.map(p => p.n));
        const totalV = sumV(rows);
        const tl = mp.timelapse;
        const cutMonth = tl && tl.months && tl.months.length && tl.monthIndex < tl.months.length - 1 ? tl.months[tl.monthIndex] : null;

        const measure = [
          F.m('สัญญาที่มีพิกัด', `${U.num(geo.length)} จาก ${U.num(rows.length)}`, pct(geo.length / rows.length)),
          F.m('จุดที่วาดบนแผนที่ตอนนี้', `${U.num(shown.length)} จุด`, 'ตามตัวเลือกซ่อนพิกัดร่วม/ซ้ำ และเดือนที่เลื่อน'),
          F.m('พิกัดใช้ร่วมหลายโครงการ', `${U.num(shared.length)} สัญญา`, 'ที่ ETL ติดป้ายไว้ น่าจะเป็นที่ตั้งสำนักงาน'),
          F.m('พิกัดซ้ำกันเป๊ะ', `${capped}${U.num(exact.length)} กลุ่ม`, `${U.num(exactRows.length)} สัญญา · ${money(sumV(exactRows))} บาท`),
          F.m('ย่านที่มีงานซ้ำใกล้กัน', `${capped}${U.num(cluster.length)} ย่าน`, 'สัญญา ≥ 3 ฉบับ คนละพิกัด'),
        ];

        const baseline = [];
        if (meta && meta.geo_pct !== undefined && meta.geo_pct !== null) {
          baseline.push({ label: 'สัดส่วนสัญญาที่มีพิกัดของทั้งชุดข้อมูล', value: `${meta.geo_pct}%`, source: 'จากข้อมูลต้นทาง (ที่มาของข้อมูล) ต้นทางไม่ได้ระบุพิกัดทุกสัญญา' });
        }
        baseline.push({ label: 'เกณฑ์จัดกลุ่มจุดซ้อน', value: 'ช่องละ 0.005° (ราว 500 ม.) ตั้งแต่ 3 สัญญาขึ้นไป',
          source: 'ค่าที่ระบบใช้ใน Analytics.stackedPoints ตัวเดียวกับตาราง "จุดเดียวหลายสัญญา" (แสดงไม่เกิน 80 กลุ่ม)' });
        baseline.push({ label: 'พิกัดซ้ำเป๊ะ vs ย่านใกล้กัน', value: 'ซ้ำเป๊ะ = ทุกสัญญาในกลุ่มพิกัดเดียวกันทุกทศนิยม',
          source: 'สองแบบนี้ความหมายต่างกัน: ซ้ำเป๊ะน่าจะเป็นพิกัดตั้งต้น ส่วนย่านใกล้กันคือสถานที่จริงที่มีงานซ้ำ' });
        baseline.push({ label: 'ระดับ "สำคัญมาก" ของหน้าต่างนี้', value: `พิกัดครอบคลุม < ${pct(CUT.geoLow, 0)} ของสัญญา`, source: 'เกณฑ์ที่หน้าต่างนี้ตั้งเอง ไม่ใช่เกณฑ์ทางกฎหมาย' });

        const finds = [];
        if (noGeo.length) {
          finds.push(F.find(geo.length / rows.length < CUT.geoLow ? 'high' : 'mid', sumV(noGeo),
            `มีพิกัดเพียง ${U.num(geo.length)} จาก ${U.num(rows.length)} สัญญา (${pct(geo.length / rows.length)}) — อีก ${U.num(noGeo.length)} สัญญา (${money(sumV(noGeo))} บาท) ไม่ปรากฏบนแผนที่เลย`,
            'อ่านแผนที่เป็นตัวแทนของทั้งขอบเขตไม่ได้ ตัวเลขบนแผนที่คือเฉพาะสัญญาที่มีพิกัด ตรวจว่าสัญญาที่ไม่มีพิกัดกระจุกที่หน่วยงานหรือประเภทงานใดเป็นพิเศษหรือไม่'));
        }
        if (exact.length) {
          const t = exact[0];
          finds.push(F.find('high', sumV(exactRows),
            `พบพิกัดซ้ำกันเป๊ะ ${capped}${U.num(exact.length)} กลุ่ม รวม ${U.num(exactRows.length)} สัญญา ${money(sumV(exactRows))} บาท — ใหญ่สุดคือ ${U.num(t.n)} สัญญาที่จุดเดียว${t.province ? ` (${t.province})` : ''}`,
            'สัญญาหลายฉบับที่ปักพิกัดเดียวกันทุกทศนิยมมักเป็นพิกัดตั้งต้นหรือที่ตั้งหน่วยงาน ไม่ใช่ที่ตั้งงานจริง ห้ามตีความเชิงพื้นที่จากจุดเหล่านี้ (แผงมุมมองของแผนที่มีตัวเลือกซ่อนพิกัดซ้ำ)'));
        }
        if (shared.length) {
          finds.push(F.find('mid', sumV(shared),
            `${U.num(shared.length)} สัญญามีพิกัดที่ ETL ติดป้าย "ใช้ร่วมหลายโครงการ" (น่าจะเป็นที่ตั้งสำนักงาน) — ตอนนี้แผนที่${mp.hideShared ? 'ซ่อน' : 'แสดง'}จุดเหล่านี้`,
            mp.hideShared ? 'การซ่อนไว้ทำให้จุดที่เห็นเชื่อถือได้มากขึ้น แต่จำนวนสัญญาบนแผนที่จะน้อยกว่าจำนวนที่มีพิกัด' : 'ควรซ่อนจุดเหล่านี้ก่อนอ่านการกระจุกตัว เพราะไม่ใช่ที่ตั้งงานจริง'));
        }
        if (cluster.length) {
          const t = cluster[0];
          finds.push(F.find('mid', sumV(cluster.flatMap(g => g.rows)),
            `พบ ${capped}${U.num(cluster.length)} ย่านที่มีสัญญา ≥ 3 ฉบับอยู่ใกล้กันแต่คนละพิกัด ใหญ่สุดคือ ${U.num(t.n)} สัญญา${t.province ? ` (${t.province})` : ''}`,
            'เป็นสถานที่จริงที่มีงานซ้ำ ดูว่างานเดิมถูกจ้างซ้ำหรือเปลี่ยนมือผู้รับจ้างหรือไม่ แต่ย่านที่มีงานหนาแน่นตามปกติ (เช่น งานวางท่อในเมือง) ก็ให้ผลเหมือนกัน จึงไม่ใช่สัญญาณในตัวเอง'));
        }
        if (byProv.length && totalV > 0) {
          const t = byProv[0];
          finds.push(F.find('low', t.value,
            `จังหวัดของหน่วยงานที่มีมูลค่าสูงสุดคือ ${t.province}: ${pct(t.value / totalV)} ของมูลค่า จาก ${pct(t.n / rows.length)} ของสัญญา`,
            'จังหวัดในข้อมูลคือที่ตั้งของหน่วยงานผู้ซื้อ ไม่ใช่ที่ตั้งงาน จึงอ่านเป็นการกระจายของงานบนแผนที่ไม่ได้'));
        }
        if (shown.length < geo.length || cutMonth) {
          finds.push(F.find('low', 0,
            `แผนที่วาด ${U.num(shown.length)} จุด จาก ${U.num(geo.length)} สัญญาที่มีพิกัด — ซ่อนพิกัดร่วม: ${mp.hideShared ? 'เปิด' : 'ปิด'} · ซ่อนพิกัดซ้ำเป๊ะ: ${mp.hideStacked ? 'เปิด' : 'ปิด'}${cutMonth ? ` · ตัวเลื่อนเวลาแสดงถึงเดือน ${U.thaiMonthLabel(cutMonth)}` : ''}`,
            'จำนวนที่ต่างกันมาจากตัวเลือกเหล่านี้ ปรับได้ที่แผนที่ ตัวเลขข้างบนในหน้าต่างนี้คิดจากทุกสัญญาที่มีพิกัด ไม่ตามตัวเลือกซ่อน'));
        }

        const acts = [];
        if (exact.length) {
          const big = [...exact[0].rows].sort(byValueDesc)[0];
          if (big) acts.push({ label: `เปิดโปรไฟล์สัญญาใหญ่สุดในกลุ่มพิกัดซ้ำ: ${L.truncate(big.project_name, 22)}`, kind: 'profile', arg: big.project_id });
        }

        return {
          scopeExtra: [`แผนที่: รูปแบบ${MAP_MODE[mp.mode] || mp.mode} · ระบายสีตาม${MAP_COLOR[mp.colorBy] || mp.colorBy} · ซ่อนพิกัดร่วม ${mp.hideShared ? 'เปิด' : 'ปิด'}`],
          measure,
          dropped: [
            F.dropped(geo.length, rows.length, ' ไม่มีพิกัด จึงไม่ปรากฏบนแผนที่'),
            F.part('รวมตามจังหวัด', withProv, rows.length, ' ไม่มีจังหวัด'),
          ],
          baseline, finds: F.sortFinds(finds), acts,
          limits: [
            'คอลัมน์จังหวัด อำเภอ ตำบล ระบุที่ตั้งของหน่วยงาน ไม่ใช่ที่ตั้งโครงการ ส่วนพิกัดบนแผนที่มาจากคอลัมน์ตำแหน่งโครงการ ทั้งสองอย่างจึงไม่จำเป็นต้องตรงกัน',
            'พิกัดซ้ำเป๊ะบางกลุ่มยังหลุดการติดป้ายว่าใช้ร่วมของ ETL จึงต้องดูจากตารางจุดเดียวหลายสัญญา ไม่ใช่เชื่อทุกจุดบนแผนที่',
            'ตัวเลขในหน้าต่างนี้คิดจากทุกสัญญาที่มีพิกัดในขอบเขตที่กรองอยู่ ไม่ตามเดือนที่เลื่อนหรือการซ่อนพิกัดของแผนที่',
            'ตารางจุดเดียวหลายสัญญาแสดงสูงสุด 80 กลุ่ม ถ้ามีมากกว่านั้นตัวเลขกลุ่มเป็นค่าต่ำสุด',
          ],
        };
      },
    },

    'tab-deep': {
      title: 'รูปแบบเชิงลึก',
      question: 'Autoencoder เห็นอะไรที่ Isolation Forest ยังไม่เห็น และผลนี้เชื่อถือได้แค่ไหน',
      build(c) {
        const { rows, L, deepPattern: dp } = c;
        // availability() กันไว้แล้วว่า dp.status ไม่ใช่ idle/loading/unavailable ก่อนจะมาถึงนี่
        // แต่ถ้าสถานะหลุดกลางทาง (เช่น เปลี่ยนชุดข้อมูลพอดีตอนกด) ให้ตอบแบบไม่มีข้อมูลแทนที่จะพัง
        const sn = dp && dp.summarize ? dp.summarize(rows) : null;
        if (!sn) {
          return {
            measure: [], dropped: [], baseline: [], finds: [],
            acts: [{ label: 'ไปที่แท็บรูปแบบเชิงลึก', kind: 'goto', arg: 'pill-deep' }],
            limits: ['ยังไม่มีข้อมูลจาก Autoencoder ให้ไล่เหตุผลตอนนี้ — เปิดแท็บนั้นให้โหลดเสร็จก่อน'],
          };
        }
        const m = sn.meta, v = m.verdict, flagPct = sn.flagPct;
        const ge99 = sn.matched.filter(x => x.s >= m.thresholds.strong_pct);
        const ge95 = sn.matched.filter(x => x.s >= flagPct);
        const agree = sn.matched.filter(x => x.agreeCount >= 2);
        const deepOnly = sn.matched.filter(x => x.deepOnly);

        const measure = [
          F.m('สัญญาที่มีคะแนนในขอบเขตนี้', `${U.num(sn.n)} จาก ${U.num(sn.nTotal)}`, ''),
          F.m(`Unusual Pattern (≥ P${m.thresholds.strong_pct})`, U.num(ge99.length), `มูลค่า ${money(sumV(ge99.map(x => x.record)))} บาท`),
          F.m(`Requires Further Review (≥ P${flagPct})`, U.num(ge95.length), ''),
          F.m('ทุก engine เห็นตรงกัน (≥ 2 จาก 3)', U.num(agree.length), 'กฎ ≥ 40 · IF ≥ P95 · Deep ≥ P95'),
          F.m('Deep จับได้ตัวเดียว', U.num(deepOnly.length), 'กฎและ Isolation Forest ไม่เห็น'),
        ];

        const baseline = [
          { label: 'เกณฑ์ระดับ', value: `≥ P${m.thresholds.strong_pct} = Unusual Pattern · ≥ P${flagPct} = Requires Further Review`,
            source: 'เปอร์เซ็นไทล์ของ reconstruction error ทั้งชุดข้อมูล (สูตรเดียวกับ ml_pct ของ Isolation Forest)' },
          { label: '"เห็นตรงกัน"', value: 'กฎ ≥ 40 · IF ≥ P95 · Deep ≥ P95 (อย่างน้อย 2 ใน 3)',
            source: 'เกณฑ์ที่หน้าต่างนี้ตั้งเอง ไม่มีการถ่วงน้ำหนักระหว่าง engine' },
          { label: 'ซ้ำกับ Isolation Forest?', value: v.duplicates_if ? 'ใช่' : 'ไม่ใช่',
            source: `Spearman ${m.vs_isolation_forest.spearman} · 5% บนซ้ำกัน ${pct(m.vs_isolation_forest.top5pct_overlap, 0)}` },
          { label: 'เสถียรข้ามการแบ่งข้อมูลฝึก/ทดสอบ?', value: v.stable ? 'ผ่านเกณฑ์' : 'ต่ำกว่าเกณฑ์เล็กน้อย',
            source: `Spearman ${m.stability.vs_alt_fold_split.spearman} (เกณฑ์ ≥ 0.9)` },
        ];

        const finds = [];
        if (ge99.length) {
          const top = [...ge99].sort((a, b) => b.s - a.s)[0];
          finds.push(F.find('high', sumV(ge99.map(x => x.record)),
            `${U.num(ge99.length)} สัญญาอยู่ในระดับ Unusual Pattern (deep_score ≥ P${m.thresholds.strong_pct}) รวม ${money(sumV(ge99.map(x => x.record)))} บาท สูงสุดคือ "${L.truncate(top.record.project_name, 40)}" (${top.s.toFixed(1)})`,
            'เปิดรายละเอียดในแท็บรูปแบบเชิงลึกเพื่อดูปัจจัยที่ทำให้ผิดปกติ แล้วเทียบกับคะแนนกฎและ Isolation Forest ของสัญญาเดียวกัน'));
        }
        if (agree.length) {
          finds.push(F.find('high', sumV(agree.map(x => x.record)),
            `${U.num(agree.length)} สัญญาที่ทั้ง 3 engine เห็นตรงกันอย่างน้อย 2 ใน 3 รวม ${money(sumV(agree.map(x => x.record)))} บาท`,
            'สัญญาณจากหลายมุมมองพร้อมกัน ควรตรวจก่อน แต่กฎ Isolation Forest และ Autoencoder ใช้ปัจจัยทับซ้อนกันบางส่วน จึงไม่ใช่หลักฐานอิสระสามชิ้นเต็ม ๆ'));
        }
        if (deepOnly.length) {
          finds.push(F.find('mid', sumV(deepOnly.map(x => x.record)),
            `${U.num(deepOnly.length)} สัญญาที่ Autoencoder เห็นผิดปกติ (≥ P${flagPct}) แต่กฎและ Isolation Forest ไม่เห็นเลย มูลค่า ${money(sumV(deepOnly.map(x => x.record)))} บาท`,
            'จุดบอดของกฎและ Isolation Forest ที่ Autoencoder ช่วยเติมเต็มได้ — ตรวจปัจจัยที่ทำให้ผิดปกติในรายละเอียดก่อนตัดสินใจ เพราะไม่มีข้อมูลยืนยันจริงว่าโมเดลนี้แม่นแค่ไหน'));
        }
        if (v.duplicates_if) {
          finds.push(F.find('low', 0, 'ผลของ Autoencoder ใกล้เคียงกับ Isolation Forest มาก',
            'อ่านเป็นการยืนยันซ้ำมากกว่ามุมมองใหม่ ดูตัวเลขเปรียบเทียบเต็มในส่วนการตรวจสอบโมเดลของแท็บ'));
        }
        if (!v.stable) {
          finds.push(F.find('low', 0, 'ความเสถียรเมื่อเปลี่ยนวิธีแบ่งข้อมูลฝึก/ทดสอบยังต่ำกว่าเกณฑ์ที่ตั้งไว้เล็กน้อย',
            'อันดับต้น ๆ อาจขยับถ้าฝึกใหม่ด้วยการสุ่มแบ่งชุดอื่น ใช้ผลนี้เป็นแนวโน้ม ไม่ใช่อันดับตายตัว'));
        }

        const acts = [{ label: 'ไปที่แท็บรูปแบบเชิงลึก', kind: 'goto', arg: 'pill-deep' }];
        if (ge99.length) {
          const top = [...ge99].sort((a, b) => b.s - a.s)[0];
          acts.push({ label: `เปิดโปรไฟล์: ${L.truncate(top.record.project_name, 28)}`, kind: 'profile', arg: top.record.project_id });
        }

        return {
          measure,
          dropped: [F.dropped(sn.n, sn.nTotal, ' ไม่มีคะแนน (ราคาเป็นศูนย์หรือไม่มีราคากลาง ถูกตัดออกตั้งแต่ตอนฝึก)')],
          baseline, finds: F.sortFinds(finds), acts,
          limits: [
            'ปัจจัยที่ Autoencoder และ Isolation Forest ใช้เป็นชุดเดียวกันทั้ง 12 ตัว การเห็นตรงกันของสองโมเดลนี้จึงไม่ใช่หลักฐานอิสระ',
            'ชุดข้อมูลนี้ไม่มีผลตรวจสอบจริง (ground truth) จึงวัดความแม่นยำของ deep_score ไม่ได้เลย ใช้จัดลำดับความสำคัญเท่านั้น',
            v.stable ? 'ความเสถียรของอันดับเมื่อเปลี่ยนวิธีแบ่งข้อมูลฝึก/ทดสอบผ่านเกณฑ์ที่ตั้งไว้'
              : 'ความเสถียรของอันดับเมื่อเปลี่ยนวิธีแบ่งข้อมูลฝึก/ทดสอบยังต่ำกว่าเกณฑ์เล็กน้อย (ดูตัวเลขในแท็บ)',
            'ตัวชี้วัดเทียบกับความผิดพลาดที่รู้แน่ (R4/R11/R20) อาจดูดีเกินจริง เพราะฟีเจอร์บางตัวคำนวณย้อนจากเงื่อนไขของกฎนั้นได้บางส่วน',
          ],
        };
      },
    },
  };

  /* ---------- ปิดปุ่มในแท็บที่ไม่มีการไล่เหตุผล ---------- */

  const OFF_REASON = {
    'tab-import': 'แท็บนำเข้าข้อมูลไม่ใช่การวิเคราะห์ ตัวเลขที่เห็นเป็นรายงานคุณภาพของไฟล์ที่กำลังจับคู่ ยังไม่เข้าชุดข้อมูลที่ใช้วิเคราะห์',
    'tab-demo': 'ตัวเลขทุกตัวในแท็บสาธิตสังเคราะห์ขึ้นเพื่อสาธิต การไล่เหตุผลจากข้อมูลที่แต่งขึ้นขัดกับกติกาของระบบ',
    'tab-ai': 'แท็บนี้คือที่ที่ AI ทำงานอยู่แล้ว ปุ่มไล่เหตุผลมีหน้าที่พาคุณมาที่นี่ กลับไปแท็บอื่นแล้วกดอีกครั้ง',
  };

  function availability(tabId) {
    if (!api) return { ok: false, reason: 'ระบบยังเริ่มไม่เสร็จ' };
    if (OFF_REASON[tabId]) return { ok: false, reason: OFF_REASON[tabId] };
    if (!TABS[tabId]) return { ok: false, reason: 'การไล่เหตุผลของแท็บนี้ยังไม่พร้อมใช้งาน' };
    if (!api.summary() || !api.rows()) return { ok: false, reason: 'ยังโหลดข้อมูลไม่เสร็จ' };
    if (tabId === 'tab-deep') {
      const dp = api.deepPattern();
      if (!dp || dp.status === 'idle' || dp.status === 'loading') {
        return { ok: false, reason: 'เปิดแท็บนี้ให้โหลดข้อมูลก่อน แล้วกดปุ่มนี้อีกครั้ง' };
      }
      if (dp.status === 'unavailable') return { ok: false, reason: dp.error || 'ยังไม่มีผลจาก Autoencoder ในชุดข้อมูลนี้' };
    }
    return { ok: true };
  }

  const BTN_TITLE = 'ไล่เหตุผลทีละขั้นจากตัวเลขของแท็บที่กำลังดู (Chain of Thought)';

  /** ใช้ aria-disabled ไม่ใช่ disabled เพื่อให้ปุ่มยังโฟกัสได้และสกรีนรีดเดอร์อ่านเหตุผลจาก title */
  function syncBtn() {
    const btn = document.getElementById('cotBtn');
    if (!btn) return;
    const a = availability(api ? api.tabId() : '');
    btn.classList.toggle('is-off', !a.ok);
    btn.setAttribute('aria-disabled', String(!a.ok));
    btn.title = a.ok ? BTN_TITLE : a.reason;
  }

  /* ---------- สร้างโมเดลทั้ง 6 ขั้น ---------- */

  function scopeLines(rows, extra) {
    const total = U.sum(rows.map(r => r.contract_price_agree));
    const filters = api.filterSummary();
    const sc = api.models().scope;
    const lines = [
      `ชุดข้อมูล: ${api.datasetName()}`,
      `สัญญาในขอบเขต: ${U.num(rows.length)} จาก ${U.num(api.allRows().length)} สัญญา · มูลค่ารวม ${U.money(total)} บาท`,
      `ตัวกรองที่เปิดอยู่: ${filters.length ? filters.join(' · ') : 'ไม่ได้กรอง (ใช้ข้อมูลทั้งชุด)'}`,
    ];
    if (sc) {
      // ข้อความเดียวกับ scopeSentence() ใน app.js แต่เป็นข้อความล้วน (scopeSentence คืน HTML ที่ escape แล้ว)
      const capped = sc.looks_capped && sc.sort_key
        ? `${U.num(sc.n_projects)} โครงการที่มียอดรวมสัญญาสูงสุด (ไฟล์สิ้นสุดที่ ${U.num(sc.cutoff_value)} บาท)`
        : `${U.num(sc.n_projects)} โครงการ`;
      lines.push(`ขอบเขตของชุดข้อมูล: ${capped}${sc.name_keyword ? ` ที่ชื่อมีคำว่า "${sc.name_keyword}"` : ''} — ตัวเลขสัดส่วนอธิบายได้เฉพาะภายในขอบเขตนี้ ไม่ใช่การจัดซื้อจัดจ้างทั้งประเทศ`);
    }
    return lines.concat(extra || []);
  }

  function compute(tabId) {
    const def = TABS[tabId];
    const rows = api.rows();
    const model = { title: def.title, question: def.question, scope: scopeLines(rows, []) };
    if (!rows.length) {
      return Object.assign(model, { measure: [], dropped: [], baseline: [], finds: [], acts: [],
        empty: true, limits: ['ไม่มีสัญญาตามตัวกรองที่เปิดอยู่ จึงไม่มีตัวเลขให้ไล่เหตุผล — ล้างตัวกรองแล้วลองใหม่'] });
    }
    const built = def.build({ rows, allRows: api.allRows(), summary: api.summary(), meta: api.meta(), opts: api.tabOpts(),
      L: api.labels, deepPattern: api.deepPattern() });
    model.scope = scopeLines(rows, built.scopeExtra);
    return Object.assign(model, built);
  }

  const STEPS = [
    { key: 'scope', head: 'ขอบเขตที่กำลังดู', why: 'ตัวเลขทุกตัวข้างล่างอธิบายได้เฉพาะในขอบเขตนี้' },
    { key: 'measure', head: 'วัดอะไรได้จากข้อมูลนี้', why: 'เฉพาะสิ่งที่คำนวณจากคอลัมน์ที่มีจริง พร้อมบอกว่าแถวไหนตกจากการคำนวณ' },
    { key: 'baseline', head: 'เทียบกับอะไร', why: 'ข้อสังเกตจะมีความหมายเมื่อบอกได้ว่าเทียบกับอะไร และเกณฑ์นั้นมาจากไหน' },
    { key: 'finds', head: 'ข้อสังเกตเรียงตามน้ำหนัก', why: 'เรียงตามระดับ แล้วตามเม็ดเงินที่เกี่ยวข้อง ไม่ใช่ตามความร้ายแรงที่คาดเดา' },
    { key: 'acts', head: 'ลงมือตรงไหน', why: 'ปุ่มพาไปยังที่ที่ตรวจต่อได้จริง' },
    { key: 'limits', head: 'สิ่งที่ตอบไม่ได้จากข้อมูลชุดนี้', why: 'ขอบเขตของข้อสรุปข้างบน' },
  ];

  const CLOSING = 'ข้อสังเกตทั้งหมดเป็นจุดตั้งต้นในการตรวจสอบ ไม่ใช่ข้อสรุปว่ามีการกระทำผิด ทุกข้อต้องยืนยันกับเอกสารจริงของหน่วยงานก่อนนำไปใช้';

  /* ---------- แสดงผลเป็น HTML ---------- */

  function stepBody(key, m) {
    const e = U.esc;
    if (m.empty && key !== 'scope' && key !== 'limits') return '<p class="cot-empty">ไม่มีข้อมูลให้คำนวณในขั้นนี้</p>';
    switch (key) {
      case 'scope':
        return `<ul class="cot-list">${m.scope.map(t => `<li>${e(t)}</li>`).join('')}</ul>`;
      case 'measure':
        return `<div class="cot-metrics">${m.measure.map(x => `
          <div class="cot-m"><div class="cot-m-l">${e(x.label)}</div><div class="cot-m-v">${e(x.value)}</div>
            ${x.note ? `<div class="cot-m-n">${e(x.note)}</div>` : ''}</div>`).join('')}</div>` +
          m.dropped.map(t => `<p class="cot-drop">${e(t)}</p>`).join('');
      case 'baseline':
        return `<ul class="cot-list">${m.baseline.map(x => `
          <li><b>${e(x.label)}:</b> ${e(x.value)}<span class="cot-src">ที่มา: ${e(x.source)}</span></li>`).join('')}</ul>`;
      case 'finds': {
        if (!m.finds.length) {
          return '<p class="ma-note">ไม่พบจุดเสี่ยงตามเกณฑ์ที่ระบบตรวจในขอบเขตนี้ — ไม่ได้แปลว่าไม่มีปัญหา แปลว่าไม่มีรูปแบบที่ตรวจจับได้จากข้อมูลที่มี</p>';
        }
        const card = f => `
          <div class="method-find ${f.level === 'high' ? 'is-high' : f.level === 'mid' ? 'is-mid' : ''}">
            <div><i class="cot-lv">${LEVEL_TEXT[f.level]}</i><b>${e(f.head)}</b><span>→ ${e(f.act)}</span></div>
          </div>`;
        const FIRST = 6;
        const rest = m.finds.slice(FIRST);
        return m.finds.slice(0, FIRST).map(card).join('') +
          (rest.length ? `<details class="queue-more"><summary>ดูอีก ${rest.length} ข้อ</summary>${rest.map(card).join('')}</details>` : '');
      }
      case 'acts':
        return m.acts.length
          ? `<div class="cot-acts">${m.acts.map((a, i) =>
            `<button type="button" class="btn btn-sm btn-outline-secondary" data-cot-act="${i}">${e(a.label)}</button>`).join('')}</div>`
          : '<p class="cot-empty">ไม่มีปุ่มลงมือสำหรับขอบเขตนี้</p>';
      case 'limits':
        return `<ul class="cot-list">${m.limits.map(t => `<li>${e(t)}</li>`).join('')}</ul>
          <p class="ma-note mt-2">${e(CLOSING)}</p>`;
      default: return '';
    }
  }

  function renderHTML(m) {
    return `<p class="method-q">คำถามวิเคราะห์: ${U.esc(m.question)}</p>
      <ol class="cot-steps">${STEPS.map((s, i) => `
        <li class="cot-step">
          <span class="cot-step-n" aria-hidden="true">${i + 1}</span>
          <h3 class="cot-step-h">${U.esc(s.head)}</h3>
          <p class="cot-why">${U.esc(s.why)}</p>
          <div class="cot-step-body">${stepBody(s.key, m)}</div>
        </li>`).join('')}</ol>`;
  }

  /* ---------- แสดงผลเป็นข้อความล้วน (คัดลอก · บันทึก · ส่งให้ AI) ----------
     ต้องมาจากโมเดลเดียวกับ HTML เสมอ เพื่อให้ทุกตัวเลขที่ AI เห็นเป็นตัวเลขตัวเดียวกับที่ผู้ใช้เห็นบนจอ */

  function plainText(m, { stamp = false } = {}) {
    const out = [`# ไล่เหตุผล · ${m.title}`, `คำถามวิเคราะห์: ${m.question}`];
    if (stamp) out.push(`สร้างเมื่อ: ${new Date().toLocaleString('th-TH', { dateStyle: 'long', timeStyle: 'short' })}`);
    out.push('');
    const sec = (i, head, lines) => { out.push(`## ${i}. ${head}`, ...lines, ''); };
    sec(1, STEPS[0].head, m.scope.map(t => `- ${t}`));
    sec(2, STEPS[1].head, [...m.measure.map(x => `- ${x.label}: ${x.value}${x.note ? ` (${x.note})` : ''}`), ...m.dropped.map(t => `- ${t}`)]);
    sec(3, STEPS[2].head, m.baseline.map(x => `- ${x.label}: ${x.value} · ที่มา: ${x.source}`));
    sec(4, STEPS[3].head, m.finds.length
      ? m.finds.map((f, i) => `${i + 1}. [${LEVEL_TEXT[f.level]}] ${f.head}\n   → ${f.act}`)
      : ['ไม่พบจุดเสี่ยงตามเกณฑ์ที่ระบบตรวจในขอบเขตนี้ — ไม่ได้แปลว่าไม่มีปัญหา']);
    sec(5, STEPS[4].head, m.acts.map(a => `- ${a.label}`));
    sec(6, STEPS[5].head, [...m.limits.map(t => `- ${t}`), '', CLOSING]);
    return out.join('\n');
  }

  /* ---------- หน้าต่าง ---------- */

  const $ = id => document.getElementById(id);
  function modal() {
    if (!modalInstance) modalInstance = bootstrap.Modal.getOrCreateInstance($('cotModal'));
    return modalInstance;
  }

  /** ปิดหน้าต่างแล้วค่อยทำ fn — ต้องรอ hidden.bs.modal ไม่ใช่เรียกต่อกันทันที
   *  เพราะ hide() เป็น animation ถ้าสลับแท็บทับกลางทาง body จะค้างคลาส modal-open (เลื่อนหน้าไม่ได้) */
  function afterClose(fn) {
    const el = $('cotModal');
    handOffFocus = true;
    if (!el.classList.contains('show')) { fn(); return; }
    // ครอบ try: handler นี้ถูกเรียกจากอีเวนต์ของ Bootstrap ถ้า throw จะกลายเป็น error เงียบ ผู้ใช้เห็นแค่ว่ากดแล้วไม่เกิดอะไร
    const once = () => {
      el.removeEventListener('hidden.bs.modal', once);
      try { fn(); } catch (e) { console.error('CoT: ทำต่อหลังปิดหน้าต่างไม่สำเร็จ', e); api.toast('ทำรายการไม่สำเร็จ ดูรายละเอียดใน console'); }
    };
    el.addEventListener('hidden.bs.modal', once);
    modal().hide();
  }

  function open() {
    const tabId = api.tabId();
    const a = availability(tabId);
    if (!a.ok) { api.toast(a.reason); return; }
    if ($('cotModal').classList.contains('show')) return;

    opener = document.activeElement;
    handOffFocus = false;
    const def = TABS[tabId];
    $('cotModalTitle').textContent = `ไล่เหตุผล · ${def.title}`;
    $('cotModalSub').textContent = 'คำนวณจากตัวเลขจริงในขอบเขตที่กรองอยู่ ไม่ต้องใช้ AI';
    U.setHTML('cotModalBody', '<div class="loading-box">กำลังคำนวณ...</div>');
    setAiControls(false);
    current = null;
    modal().show();

    // ให้หน้าต่างวาดก่อนแล้วค่อยคำนวณ ชุดข้อมูลที่นำเข้าเองใหญ่ได้ถึงหลักแสนแถว
    setTimeout(() => {
      try {
        const model = compute(tabId);
        current = { tabId, def, model };
        U.setHTML('cotModalBody', renderHTML(model));
        setAiControls(true);
      } catch (e) {
        console.error('CoT: คำนวณไม่สำเร็จ', e);
        U.setHTML('cotModalBody', '<div class="ma-note">คำนวณการไล่เหตุผลของแท็บนี้ไม่สำเร็จ ดูรายละเอียดใน console</div>');
      }
    }, 0);
  }

  function setAiControls(ready) {
    ['cotCopy', 'cotSave', 'cotAi'].forEach(id => { $(id).disabled = !ready; });
    const ai = api.aiReady();
    $('cotAi').textContent = ai ? 'ให้ AI ขยายความ' : 'ตั้งค่า AI เพื่อขยายความ';
    $('cotAiNote').textContent = ai
      ? 'AI ขยายความจากตัวเลขชุดนี้เท่านั้น ไม่เพิ่มตัวเลขใหม่'
      : 'ยังไม่ได้ตั้งค่า AI · ทุกส่วนข้างบนใช้ได้โดยไม่ต้องใช้ AI';
  }

  /* ---------- ปุ่มใน footer และเนื้อหา ---------- */

  function copyText(text) {
    const fallback = () => {
      const ta = document.createElement('textarea');
      ta.value = text; ta.style.position = 'fixed'; ta.style.opacity = '0';
      document.body.appendChild(ta); ta.select();
      try { document.execCommand('copy'); api.toast('คัดลอกแล้ว'); } catch (e) { api.toast('คัดลอกไม่สำเร็จ'); }
      ta.remove();
    };
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(text).then(() => api.toast('คัดลอกแล้ว'), fallback);
    } else fallback();
  }

  function aiPrompt(m) {
    return `ข้างล่างนี้คือการไล่เหตุผลที่ระบบคำนวณจากข้อมูลจริงแล้ว สำหรับแท็บ "${m.title}"\n` +
      `คำถามของแท็บนี้: ${m.question}\n\n` +
      'ช่วยขยายความโดย:\n' +
      '1. อธิบายว่าข้อสังเกตแต่ละข้อมีความหมายอย่างไรในบริบทการจัดซื้อจัดจ้างภาครัฐไทย\n' +
      '2. เสนอคำอธิบายทางเลือกที่สุจริตหรือเป็นเรื่องปกติของตลาดสำหรับข้อสังเกตแต่ละข้อ\n' +
      '3. เสนอลำดับการตรวจสอบและเอกสารที่ต้องขอจากหน่วยงาน\n\n' +
      'ห้ามเพิ่มตัวเลขใหม่ที่ไม่ปรากฏในบล็อก <data> ห้ามคำนวณสถิติใหม่ ถ้าต้องใช้ตัวเลขที่ไม่มีให้บอกว่าข้อมูลชุดนี้ไม่มี\n' +
      'ข้อจำกัดในหัวข้อ "สิ่งที่ตอบไม่ได้จากข้อมูลชุดนี้" ต้องคงอยู่ในคำตอบ ห้ามข้าม';
  }

  function runAct(a) {
    // ทุกปุ่มที่เปลี่ยนสถานะของแอป (ตัวกรอง แท็บ) ต้องปิดหน้าต่างก่อน ไม่งั้นค้างแสดงตัวเลขของขอบเขตเก่า
    afterClose(() => {
      if (a.kind === 'jump') api.jumpTo(a.arg);
      else if (a.kind === 'band') api.setBand(a.arg);
      else if (a.kind === 'rule') api.setRule(a.arg);
      else if (a.kind === 'export') api.exportQueue();
      else if (a.kind === 'profile') api.openProfile(a.arg);
      else if (a.kind === 'detail') api.openDetail(a.arg.type, a.arg.id);
      else if (a.kind === 'goto') api.gotoTab(a.arg);
    });
  }

  function bindModal() {
    $('cotModal').addEventListener('hidden.bs.modal', () => {
      if (!handOffFocus && opener && document.contains(opener)) opener.focus();
      opener = null;
    });
    $('cotCopy').addEventListener('click', () => { if (current) copyText(plainText(current.model, { stamp: true })); });
    $('cotSave').addEventListener('click', () => {
      if (!current) return;
      const day = new Date().toISOString().slice(0, 10).replace(/-/g, '');
      // ต้นฉบับ .md มีขอบเขตและตัวกรองติดไปด้วยเสมอ (ขั้นที่ 1) เพื่อให้ไฟล์ที่ส่งต่ออ่านเดี่ยว ๆ ได้ถูกต้อง
      api.download(new Blob(['﻿' + plainText(current.model, { stamp: true })], { type: 'text/markdown;charset=utf-8' }),
        `ไล่เหตุผล-${current.tabId.replace('tab-', '')}-${day}.md`);
    });
    $('cotAi').addEventListener('click', () => {
      if (!current) return;
      const m = current.model;
      // ต้องแนบ data เสมอ: ตัวตรวจตัวเลขของ AI ใช้ data ในเธรดเป็นฐานเทียบ ถ้าว่างจะเตือนว่าทุกตัวเลขหาไม่พบ
      // data ส่งเป็นฟังก์ชัน ไม่ใช่ค่า: aiScopeText() อ่านสถานะ AI ที่ยังไม่ถูกตั้งจนกว่า renderAI() จะรัน
      // ถ้าคำนวณเป็นอาร์กิวเมนต์ตรงนี้ มันจะ throw ก่อนได้สลับแท็บด้วยซ้ำ (เจอจริงตอนทดสอบ)
      afterClose(() => api.aiSend(`🧭 ไล่เหตุผล · ${m.title}`, aiPrompt(m), () => plainText(m) + '\n\n' + api.aiScopeText()));
    });
    $('cotModalBody').addEventListener('click', e => {
      const b = e.target.closest('[data-cot-act]');
      if (b && current) runAct(current.model.acts[Number(b.dataset.cotAct)]);
    });
  }

  return { init, open, syncBtn, availability };
})();
