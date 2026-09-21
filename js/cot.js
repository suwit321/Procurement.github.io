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
    'setBand', 'jumpTo', 'exportQueue', 'aiReady', 'aiScopeText', 'aiSend'];

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
    const built = def.build({ rows, allRows: api.allRows(), summary: api.summary(), meta: api.meta(), opts: api.tabOpts(), L: api.labels });
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
