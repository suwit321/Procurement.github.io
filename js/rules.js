/* rules.js — เครื่องมือประเมินความเสี่ยง R1-R23

   เดิม rule ทั้งหมดถูกคำนวณล่วงหน้าใน data.json โดยสคริปต์ที่หายไป ทำให้ปรับเงื่อนไขไม่ได้
   และ 5 rule ไม่เคยทำงานเพราะข้อมูลนำเข้า parse ผิด ตอนนี้ย้ายมาคำนวณในเบราว์เซอร์
   จึงปรับ threshold/น้ำหนักได้สดและเห็นผลทันที

   หลักการสำคัญ: คะแนนจริงกับคะแนนสาธิตแยกกันเด็ดขาด
     risk_score       = เฉพาะ rule ที่ใช้ข้อมูลจริง (ค่าเริ่มต้นที่แสดง)
     risk_score_all   = รวม rule สาธิต (R5/R6) ไว้เปรียบเทียบเท่านั้น
   คำนวณด้วย scoreHits() ที่เดียว: กฎ scored:false (คุณภาพข้อมูล) ไม่บวกคะแนน
   และกฎใน family เดียวกัน (วัดเรื่องเดียวกัน) นับเฉพาะน้ำหนักสูงสุดข้อเดียว

   ช่องวงเงิน (project_money) ราคากลาง (price_build) และยอดรวม (sum_price_agree) เป็นค่าระดับโครงการ
   กฎที่เทียบกับช่องเหล่านี้จึงต้องใช้ผลรวมสัญญาของโครงการ (ctx.projectAgg) ไม่ใช่ราคาสัญญาฉบับเดียว
   ไม่เช่นนั้นโครงการที่แยกหลายสัญญาจะดูเหมือนได้ส่วนลดมหาศาล (ทบทวน 2026-09 ดู README)
*/
'use strict';

const Rules = (() => {

  const SPECIFIC_METHOD = 'เฉพาะเจาะจง';
  const EBIDDING_METHOD = 'ประกวดราคาอิเล็กทรอนิกส์ (e-bidding)';
  /* วงเงินที่วิธีเฉพาะเจาะจงใช้ได้โดยทั่วไป — เหนือกว่านี้ควรเปิดให้แข่งขัน
     ในข้อมูลนี้ 97.6% ของสัญญา 1-5 แสนใช้วิธีเฉพาะเจาะจง แต่เหนือ 5 แสนใช้เพียง 5.9%
     การนับรวมทุกขนาดจึงวัด "หน่วยงานนี้มีงานเล็ก" แทนที่จะวัด "หลีกเลี่ยงการแข่งขัน" */
  const DISCRETIONARY_CEILING = 500000;
  /* ระยะเวลาเผยแพร่ประกาศประกวดราคาขั้นต่ำ (วันทำการ) ตามวงเงิน — ระเบียบกระทรวงการคลังว่าด้วยการจัดซื้อจัดจ้าง
     และการบริหารพัสดุภาครัฐ พ.ศ. 2560 ขั้นตอน "ประกาศประกวดราคา" (ใช้กับวิธี e-bidding เท่านั้น
     วิธีคัดเลือก/เฉพาะเจาะจงมีขั้นตอนคนละแบบ ไม่ได้อยู่ในตารางนี้) เรียงจากวงเงินสูงไปต่ำ ใช้ตัวแรกที่วงเงินเกินเพดาน */
  const EBID_MIN_DAYS = [[50_000_000, 20], [10_000_000, 12], [5_000_000, 10], [DISCRETIONARY_CEILING, 5]];
  function ebidMinDays(projectMoney) {
    for (const [ceiling, days] of EBID_MIN_DAYS) if (projectMoney > ceiling) return days;
    return null;   // วงเงินไม่เกิน 5 แสน ปกติไม่ใช้ e-bidding ตารางนี้ไม่ครอบคลุม
  }
  const STORAGE_KEY = 'pa.ruleSettings.v1';
  /* จำนวนขั้นต่ำก่อนถือว่ากฎที่อิงการกระจาย/เพดานใช้กับชุดข้อมูลนี้ได้ — ต่ำกว่านี้แสดง "ไม่เข้ากับชุดข้อมูลนี้" แทน 0 */
  const MIN_APPLICABLE = 20;

  /** ยอดรวมสัญญาของโครงการ (ctx.projectAgg) — null ถ้ามีสัญญาในโครงการที่ไม่มีราคา เพราะยอดรวมจะต่ำกว่าจริง */
  function projectTotal(r, ctx) {
    const p = ctx.projectAgg && ctx.projectAgg.get(r.project_id);
    if (!p || p.missing || !(p.sum > 0)) return null;
    return p;
  }
  const projNote = p => (p.n > 1 ? ` · ทั้งโครงการ ${p.n} สัญญา รวม ${U.num(p.sum, 0)} บาท` : '');

  /** นับค่าใน array ที่เรียงแล้วซึ่งน้อยกว่า x (binary search) */
  function countBelow(sorted, x) {
    let lo = 0, hi = sorted.length;
    while (lo < hi) { const mid = (lo + hi) >> 1; if (sorted[mid] < x) lo = mid + 1; else hi = mid; }
    return lo;
  }

  /* ---------------------------------------------------------------
     นิยาม rule
     - thresholds: ปรับได้จาก UI
     - evaluate(): คืน null ถ้าไม่เข้าเงื่อนไข หรือ {actual} ถ้าเข้า
     --------------------------------------------------------------- */
  const DEFS = [
    {
      id: 'R1', name: 'ส่วนลดเทียบวงเงินโครงการสูงผิดปกติ',
      severity: 'medium', weight: 15, category: 'ราคา', source: 'real', family: 'discount',
      desc: 'ยอดรวมสัญญาของโครงการต่ำกว่าวงเงินมากผิดปกติ อาจสะท้อนการตั้งวงเงินสูงเกินจริง หรือการเสนอราคาต่ำเพื่อให้ได้งาน ' +
        'เทียบระดับโครงการ เพราะวงเงินเป็นของทั้งโครงการ ไม่ใช่ของสัญญาฉบับเดียว',
      thresholds: { pct: { value: 0.30, min: 0.05, max: 0.90, step: 0.05, label: 'ส่วนลดขั้นต่ำ', format: 'pct' } },
      logic: t => `(project_money - Σ contract_price_agree ของโครงการ) / project_money >= ${t.pct}`,
      evaluate(r, ctx, t) {
        const p = projectTotal(r, ctx);
        if (!r.project_money || !p) return null;
        const d = (r.project_money - p.sum) / r.project_money;
        return d >= t.pct ? { actual: U.pct(d) + projNote(p) } : null;
      }
    },
    {
      id: 'R2', name: 'ส่วนลดเทียบราคากลางสูงผิดปกติ',
      severity: 'medium', weight: 15, category: 'ราคา', source: 'real', family: 'discount',
      desc: 'ยอดรวมสัญญาของโครงการต่ำกว่าราคากลางมาก อาจบ่งชี้ราคากลางที่ตั้งไว้ไม่สมเหตุสมผล ' +
        'อยู่ family เดียวกับ R1 (ส่วนลด) จึงนับคะแนนเฉพาะข้อที่น้ำหนักสูงกว่า',
      thresholds: { pct: { value: 0.30, min: 0.05, max: 0.90, step: 0.05, label: 'ส่วนลดขั้นต่ำ', format: 'pct' } },
      logic: t => `(price_build - Σ contract_price_agree ของโครงการ) / price_build >= ${t.pct}`,
      evaluate(r, ctx, t) {
        const p = projectTotal(r, ctx);
        if (!r.price_build || !p) return null;
        const d = (r.price_build - p.sum) / r.price_build;
        return d >= t.pct ? { actual: U.pct(d) + projNote(p) } : null;
      }
    },
    {
      id: 'R3', name: 'โครงการเดียวมีหลายสัญญา',
      severity: 'high', weight: 20, category: 'โครงสร้างสัญญา', source: 'real',
      desc: 'โครงการเดียวถูกแยกทำสัญญาหลายฉบับ ควรตรวจว่ามีเหตุผลรองรับหรือเป็นการเลี่ยงวงเงิน',
      thresholds: { min: { value: 2, min: 2, max: 20, step: 1, label: 'จำนวนสัญญาขั้นต่ำ' } },
      logic: t => `จำนวนสัญญาของ project_id เดียวกัน >= ${t.min}`,
      evaluate(r, ctx, t) {
        const n = ctx.projectContracts.get(r.project_id) || 1;
        return n >= t.min ? { actual: `${n} สัญญา` } : null;
      }
    },
    {
      id: 'R4', name: 'มูลค่าสัญญาเกินวงเงินโครงการ',
      severity: 'critical', weight: 30, category: 'ราคา', source: 'real',
      desc: 'ยอดรวมสัญญาของโครงการสูงกว่าวงเงินที่ได้รับอนุมัติ เป็นความผิดปกติที่ต้องมีเอกสารอธิบาย',
      thresholds: { ratio: { value: 1.0, min: 1.0, max: 2.0, step: 0.05, label: 'อัตราส่วนขั้นต่ำ' } },
      logic: t => `Σ contract_price_agree ของโครงการ / project_money > ${t.ratio}`,
      evaluate(r, ctx, t) {
        const p = projectTotal(r, ctx);
        if (!r.project_money || !p) return null;
        const ratio = p.sum / r.project_money;
        return ratio > t.ratio ? { actual: `${ratio.toFixed(4)} เท่า` + projNote(p) } : null;
      }
    },
    {
      id: 'R5', name: 'ผู้เสนอราคารายเดียว',
      severity: 'high', weight: 20, category: 'การแข่งขัน', source: 'synthetic',
      desc: 'ชุดข้อมูลจริงไม่มีจำนวนผู้เสนอราคา ตัวเลขนี้สังเคราะห์ขึ้นเพื่อสาธิตแนวคิดเท่านั้น',
      thresholds: { max: { value: 1, min: 1, max: 5, step: 1, label: 'จำนวนรายสูงสุด' } },
      logic: t => `demo_n_bidders <= ${t.max}   [ข้อมูลสาธิต]`,
      evaluate(r, ctx, t) {
        // ต้องกันค่าว่างก่อนเทียบ เพราะ null <= 1 เป็นจริงใน JS
        // ชุดข้อมูลที่ผู้ใช้นำเข้าเองไม่มีฟิลด์สาธิตนี้ ถ้าไม่กันไว้จะติดกฎนี้ทุกระเบียน
        if (r.demo_n_bidders === null || r.demo_n_bidders === undefined) return null;
        return r.demo_n_bidders <= t.max ? { actual: `${r.demo_n_bidders} ราย` } : null;
      }
    },
    {
      id: 'R6', name: 'ระยะเวลายื่นข้อเสนอสั้นผิดปกติ (สาธิต)',
      severity: 'medium', weight: 10, category: 'การแข่งขัน', source: 'synthetic',
      desc: 'ตัวเลขสังเคราะห์ ใช้ R16 แทนสำหรับข้อมูลจริงที่มีวันประกาศ',
      thresholds: { days: { value: 7, min: 1, max: 30, step: 1, label: 'จำนวนวันสูงสุด' } },
      logic: t => `demo_submission_days <= ${t.days}   [ข้อมูลสาธิต]`,
      evaluate(r, ctx, t) {
        if (r.demo_submission_days === null || r.demo_submission_days === undefined) return null;
        return r.demo_submission_days <= t.days ? { actual: `${r.demo_submission_days} วัน` } : null;
      }
    },
    {
      id: 'R7', name: 'เลขผู้เสียภาษีกับชื่อผู้รับจ้างไม่สอดคล้อง',
      severity: 'high', weight: 25, category: 'ผู้รับจ้าง', source: 'real',
      desc: 'เลขภาษีเดียวผูกกับหลายชื่อ หรือชื่อเดียวผูกกับหลายเลขภาษี ' +
        'ตรวจหลังทำชื่อให้เป็นมาตรฐานแล้วเพื่อตัด false positive จากรูปแบบการพิมพ์',
      thresholds: { min: { value: 2, min: 2, max: 10, step: 1, label: 'จำนวนคู่ตรงข้ามขั้นต่ำ' } },
      logic: t => `จำนวนชื่อต่อ 1 เลขภาษี >= ${t.min} หรือ จำนวนเลขภาษีต่อ 1 ชื่อ >= ${t.min}`,
      evaluate(r, ctx, t) {
        if (r.tin_is_masked) return null;   // เลขภาษีถูกปิดบัง ใช้ระบุตัวตนไม่ได้
        const names = ctx.tinToNames.get(r.winner_tin);
        const tins = ctx.nameToTins.get(r.winner_key);
        if (names && names.size >= t.min) return { actual: `เลขภาษีนี้ผูกกับ ${names.size} ชื่อ` };
        if (tins && tins.size >= t.min) return { actual: `ชื่อนี้ผูกกับ ${tins.size} เลขภาษี` };
        return null;
      }
    },
    {
      id: 'R8', name: 'หน่วยงานใช้วิธีเฉพาะเจาะจงกับงานวงเงินเกิน 5 แสนบ่อยผิดปกติ',
      severity: 'medium', weight: 10, category: 'วิธีจัดหา', source: 'real',
      desc: 'นับเฉพาะโครงการวงเงินเกิน 500,000 บาท ซึ่งปกติต้องเปิดให้แข่งขัน ' +
        'แล้วประเมินด้วย Empirical Bayes ว่ามั่นใจแค่ไหนว่าสัดส่วนจริงของหน่วยงานสูงกว่าเกณฑ์ ' +
        'หน่วยงานที่มีโครงการเพียง 1-2 ฉบับจึงไม่ถูกติดธงเพราะความบังเอิญ',
      thresholds: {
        share: { value: 0.30, min: 0.10, max: 0.90, step: 0.05, label: 'สัดส่วนจริงที่ถือว่าผิดปกติ', format: 'pct' },
        confidence: { value: 0.90, min: 0.50, max: 0.99, step: 0.01, label: 'ความมั่นใจขั้นต่ำ', format: 'pct' },
      },
      logic: t => `เฉพาะวงเงิน > 500,000 และใช้วิธีเฉพาะเจาะจง · ` +
        `P(สัดส่วนจริงของหน่วยงาน >= ${t.share}) >= ${t.confidence} ตาม Beta posterior`,
      evaluate(r, ctx, t) {
        // ติดธงเฉพาะสัญญาที่เป็นพฤติกรรมนั้นจริง ไม่ใช่ทุกสัญญาของหน่วยงาน
        if (!(r.project_money > DISCRETIONARY_CEILING) || r.purchase_method_name !== SPECIFIC_METHOD) return null;
        const s = ctx.agencyMethod.get(r.dept_key);
        if (!s || !s.discretionary) return null;
        const post = U.betaPosterior(ctx.specificPrior, s.specificDiscretionary, s.discretionary);
        const prob = U.betaSf(t.share, post.a, post.b);
        if (prob < t.confidence) return null;
        return {
          actual: `${s.specificDiscretionary} จาก ${s.discretionary} โครงการ (ไม่ใช่สัญญา) วงเงินเกิน 5 แสน ` +
            `(ดิบ ${U.pct(s.specificDiscretionary / s.discretionary)} · ปรับแล้ว ${U.pct(post.mean)}) ` +
            `· มั่นใจ ${U.pct(prob, 0)} ว่าเกิน ${U.pct(t.share, 0)} · ค่ากลางทุกหน่วยงาน ${U.pct(ctx.specificPrior.mean)}`,
        };
      }
    },
    {
      id: 'R9', name: 'ราคาสัญญาเป็นเลขกลมผิดปกติ',
      severity: 'low', weight: 5, category: 'ราคา', source: 'real',
      desc: 'ราคาเป็นตัวเลขกลมเมื่อเทียบกับขนาดของตัวเอง (เช่น 150,000,000 หรือ 2,500,000) ' +
        'วัดด้วยจำนวนเลขนัยสำคัญ ไม่ใช่จำนวนศูนย์ท้าย เพราะสัญญาหลักร้อยล้านลงท้ายด้วย 000 แทบทุกฉบับ ' +
        'เป็นสัญญาณอ่อน จึงให้น้ำหนักต่ำ',
      thresholds: {
        sig: { value: 2, min: 1, max: 4, step: 1, label: 'เลขนัยสำคัญไม่เกิน (หลัก)' },
        minValue: { value: 100000, min: 10000, max: 5000000, step: 10000, label: 'มูลค่าขั้นต่ำ' }
      },
      logic: t => `contract_price_agree >= ${t.minValue} และมีเลขนัยสำคัญไม่เกิน ${t.sig} หลัก`,
      evaluate(r, ctx, t) {
        const v = r.contract_price_agree;
        if (v === null || v < t.minValue) return null;
        // หน่วยของหลักสุดท้ายที่อนุญาตให้ไม่เป็นศูนย์ เช่น 158,000,000 กับ sig=2 -> หน่วย 10,000,000
        const unit = 10 ** (Math.floor(Math.log10(v)) - t.sig + 1);
        const q = v / unit;
        return Math.abs(q - Math.round(q)) < 1e-9 ? { actual: `${U.num(v, 0)} (เลขนัยสำคัญไม่เกิน ${t.sig} หลัก)` } : null;
      }
    },
    {
      id: 'R10', name: 'สงสัยการแบ่งซื้อแบ่งจ้าง',
      severity: 'critical', weight: 25, category: 'โครงสร้างสัญญา', source: 'real', family: 'split',
      desc: 'หน่วยงานและผู้รับจ้างคู่เดิมทำสัญญาหลายฉบับในวันเดียวกัน แต่ละฉบับต่ำกว่าเพดาน ' +
        'แต่ยอดรวมสูง เป็นรูปแบบการเลี่ยงวิธีจัดหาที่เข้มงวดกว่า · ใช้ได้กับชุดที่มีงานวงเงินเล็ก ' +
        'ส่วนงานขนาดใหญ่ใช้ R23 (family เดียวกัน นับคะแนนข้อเดียว)',
      thresholds: {
        maxEach: { value: 500000, min: 100000, max: 5000000, step: 50000, label: 'เพดานต่อสัญญา' },
        minTotal: { value: 400000, min: 100000, max: 10000000, step: 50000, label: 'ยอดรวมขั้นต่ำ' },
        minCount: { value: 2, min: 2, max: 10, step: 1, label: 'จำนวนสัญญาขั้นต่ำ' }
      },
      logic: t => `หน่วยงาน+ผู้รับจ้าง+วันทำสัญญาเดียวกัน >= ${t.minCount} สัญญา, ` +
        `แต่ละฉบับ < ${t.maxEach}, รวม >= ${t.minTotal}`,
      applicable(ctx, t) {
        const n = countBelow(ctx.pricesSorted, t.maxEach);
        return n >= MIN_APPLICABLE ? { ok: true }
          : { ok: false, reason: `ชุดข้อมูลนี้มีสัญญาต่ำกว่า ${U.num(t.maxEach)} บาทเพียง ${U.num(n)} ฉบับ ` +
              `(ต้องมีอย่างน้อย ${MIN_APPLICABLE}) — กฎนี้ออกแบบสำหรับงานวงเงินเล็ก ดู R23 สำหรับงานทุกขนาด` };
      },
      evaluate(r, ctx, t) {
        const g = r._splitGroup;
        if (!g || g.rows.length < t.minCount) return null;
        // ผลของทั้งกลุ่มเหมือนกันทุกสมาชิก จึงตัดสินครั้งเดียวแล้วเก็บไว้
        // ไม่เช่นนั้นกลุ่มขนาด n จะถูกตรวจซ้ำ n รอบ
        const sig = t.maxEach + '|' + t.minTotal + '|' + t.minCount;
        if (g._sig !== sig) {
          g._sig = sig;
          g._verdict = (g.total >= t.minTotal &&
            g.rows.every(x => x.contract_price_agree !== null && x.contract_price_agree < t.maxEach))
            ? { actual: `${g.rows.length} สัญญา รวม ${U.num(g.total, 0)} บาท` }
            : null;
        }
        return g._verdict;
      }
    },
    {
      id: 'R11', name: 'วันสิ้นสุดสัญญาก่อนวันทำสัญญา',
      severity: 'high', weight: 15, category: 'เอกสาร/ข้อมูล', source: 'real', scored: false,
      desc: 'ความผิดพลาดของข้อมูลวันที่ ควรตรวจสอบเอกสารต้นฉบับ · เป็นกฎคุณภาพข้อมูล แสดงให้เห็นแต่ไม่บวกคะแนนความเสี่ยง',
      thresholds: { maxDays: { value: 0, min: -30, max: 30, step: 1, label: 'ระยะเวลาต่ำสุด (วัน)' } },
      logic: t => `duration_days < ${t.maxDays}`,
      evaluate(r, ctx, t) {
        if (r.duration_days === null) return null;
        return r.duration_days < t.maxDays ? { actual: `${r.duration_days} วัน` } : null;
      }
    },
    {
      id: 'R12', name: 'ราคาชิดเพดานวิธีเฉพาะเจาะจง',
      severity: 'high', weight: 20, category: 'ราคา', source: 'real',
      desc: 'ราคาสัญญาเกาะอยู่ใต้เพดาน 500,000 บาทของวิธีเฉพาะเจาะจง ' +
        'ชุดข้อมูลนี้มีสัญญาในช่วง 450,000-500,000 มากกว่าช่วงเหนือเพดานหลายเท่า ' +
        'ซึ่งเป็นรูปแบบที่ไม่เกิดขึ้นเองตามธรรมชาติ',
      thresholds: {
        ceiling: { value: 500000, min: 100000, max: 5000000, step: 50000, label: 'เพดาน' },
        bandPct: { value: 0.10, min: 0.01, max: 0.30, step: 0.01, label: 'ความกว้างช่วงใต้เพดาน', format: 'pct' }
      },
      logic: t => `วิธีเฉพาะเจาะจง และ ${t.ceiling} * (1 - ${t.bandPct}) <= ราคา < ${t.ceiling}`,
      applicable(ctx, t) {
        const n = countBelow(ctx.specificPricesSorted, t.ceiling);
        return n >= MIN_APPLICABLE ? { ok: true }
          : { ok: false, reason: `ชุดข้อมูลนี้มีสัญญาวิธีเฉพาะเจาะจงต่ำกว่าเพดาน ${U.num(t.ceiling)} บาทเพียง ${U.num(n)} ฉบับ ` +
              `(ต้องมีอย่างน้อย ${MIN_APPLICABLE}) จึงไม่มีการกระจายราคาใต้เพดานให้เทียบ` };
      },
      evaluate(r, ctx, t) {
        if (r.purchase_method_name !== SPECIFIC_METHOD) return null;
        const v = r.contract_price_agree;
        if (v === null) return null;
        const lo = t.ceiling * (1 - t.bandPct);
        return (v >= lo && v < t.ceiling)
          ? { actual: `${U.num(v, 0)} (${U.pct(v / t.ceiling)} ของเพดาน)` } : null;
      }
    },
    {
      id: 'R13', name: 'ราคาสัญญาเท่ากับราคากลางพอดี',
      severity: 'medium', weight: 15, category: 'การแข่งขัน', source: 'real', family: 'exact',
      desc: 'ยอดรวมสัญญาของโครงการไม่มีส่วนลดจากราคากลางเลย สะท้อนการไม่มีแรงกดดันด้านการแข่งขัน',
      thresholds: { minRatio: { value: 1.0, min: 0.95, max: 1.0, step: 0.005, label: 'อัตราส่วนขั้นต่ำ' } },
      logic: t => `Σ contract_price_agree ของโครงการ / price_build >= ${t.minRatio}`,
      evaluate(r, ctx, t) {
        const p = projectTotal(r, ctx);
        if (!r.price_build || !p) return null;
        const ratio = p.sum / r.price_build;
        // ผลรวมทศนิยมหลายฉบับอาจคลาดจาก 1.0 ในหลักที่ 1e-12 ทั้งที่เท่ากันจริง
        return ratio >= t.minRatio - 1e-9 ? { actual: `${(ratio * 100).toFixed(2)}% ของราคากลาง` + projNote(p) } : null;
      }
    },
    {
      id: 'R14', name: 'ราคากลางเท่ากับวงเงินโครงการ',
      severity: 'medium', weight: 10, category: 'ราคา', source: 'real',
      desc: 'ราคากลางถูกตั้งเท่าวงเงินที่ได้รับ แทนที่จะประมาณราคาอย่างเป็นอิสระ',
      thresholds: { tolerance: { value: 0.001, min: 0, max: 0.05, step: 0.001, label: 'ค่าคลาดเคลื่อนที่ยอมรับ', format: 'pct' } },
      logic: t => `|price_build - project_money| / project_money <= ${t.tolerance}`,
      evaluate(r, ctx, t) {
        if (!r.price_build || !r.project_money) return null;
        const diff = Math.abs(r.price_build - r.project_money) / r.project_money;
        return diff <= t.tolerance ? { actual: `ต่างกัน ${U.pct(diff, 3)}` } : null;
      }
    },
    {
      id: 'R15', name: 'คู่หน่วยงาน-ผู้รับจ้างซ้ำสูง',
      severity: 'medium', weight: 15, category: 'การแข่งขัน', source: 'real', family: 'pair',
      desc: 'ผู้รับจ้างรายเดิมได้งานจากหน่วยงานเดิมซ้ำหลายครั้ง ควรตรวจความสม่ำเสมอของการแข่งขัน',
      thresholds: { minPair: { value: 5, min: 2, max: 60, step: 1, label: 'จำนวนสัญญาขั้นต่ำต่อคู่' } },
      logic: t => `จำนวนสัญญาของคู่หน่วยงาน-ผู้รับจ้าง >= ${t.minPair}`,
      evaluate(r, ctx, t) {
        const n = ctx.pairCounts.get(r.dept_key + KEY_SEP + r.winner_key) || 0;
        return n >= t.minPair ? { actual: `${n} สัญญากับหน่วยงานเดียวกัน` } : null;
      }
    },
    {
      id: 'R16', name: 'ช่วงเวลาประกาศถึงทำสัญญาสั้นกว่าระยะขั้นต่ำตามระเบียบ',
      severity: 'high', weight: 20, category: 'การแข่งขัน', source: 'real',
      desc: 'ระเบียบกระทรวงการคลังว่าด้วยการจัดซื้อจัดจ้างและการบริหารพัสดุภาครัฐ พ.ศ. 2560 กำหนดระยะเวลาเผยแพร่ ' +
        'ประกาศประกวดราคาขั้นต่ำไว้ตามวงเงิน (5/10/12/20 วันทำการ) เฉพาะวิธี e-bidding ' +
        'ใช้วันประกาศจริงจากชุดข้อมูล (มีเฉพาะรายการที่ประกาศเชิญชวน) เทียบกับวันทำสัญญา ' +
        'เกณฑ์นี้เป็นวันทำการตามระเบียบ แต่ข้อมูลนับเป็นวันปฏิทิน (ไม่มีปฏิทินวันหยุดราชการ) ' +
        'จึงติดธงเฉพาะกรณีวันปฏิทินยังน้อยกว่าวันทำการขั้นต่ำ ซึ่งเป็นไปไม่ได้ตามระเบียบไม่ว่าวันหยุดจะตรงวันไหน — ' +
        'ไม่ใช่การเทียบเชิงสถิติ แต่เป็นข้อเท็จจริงเชิงกฎหมาย',
      thresholds: { bufferDays: { value: 0, min: 0, max: 10, step: 1, label: 'ผ่อนปรนเพิ่ม (วัน)' } },
      logic: t => `วิธี e-bidding, วงเงิน > ${U.num(DISCRETIONARY_CEILING)} และ announce_gap_days < ระยะขั้นต่ำตามวงเงิน (วันทำการ) - ${t.bufferDays}`,
      applicable(ctx) {
        return ctx.ebidGapEligible >= MIN_APPLICABLE ? { ok: true }
          : { ok: false, reason: `ชุดข้อมูลนี้มีสัญญาวิธี e-bidding ที่มีทั้งวันประกาศและวงเงินเกิน ${U.num(DISCRETIONARY_CEILING)} เพียง ` +
              `${U.num(ctx.ebidGapEligible)} ฉบับ (ต้องมีอย่างน้อย ${MIN_APPLICABLE})` };
      },
      evaluate(r, ctx, t) {
        if (r.announce_gap_days === null || r.announce_gap_days === undefined) return null;
        if (r.purchase_method_name !== EBIDDING_METHOD) return null;
        const minDays = ebidMinDays(r.project_money);
        if (minDays === null) return null;
        const floor = minDays - t.bufferDays;
        // announce_gap_days นับเป็นวันปฏิทิน ส่วนเกณฑ์ระเบียบเป็นวันทำการ (วันทำการ <= วันปฏิทินเสมอ)
        // ถ้าวันปฏิทินยังน้อยกว่าเกณฑ์วันทำการ แปลว่าต่ำกว่าขั้นต่ำแน่นอน ไม่ต้องมีปฏิทินวันหยุดราชการมายืนยัน
        return r.announce_gap_days < floor
          ? { actual: `${r.announce_gap_days} วัน (ปฏิทิน) ต่ำกว่าขั้นต่ำ ${minDays} วันทำการที่ระเบียบกำหนดสำหรับวงเงินนี้` }
          : null;
      }
    },
    {
      id: 'R17', name: 'พิกัดโครงการห่างจากพื้นที่ปกติของจังหวัด',
      severity: 'medium', weight: 10, category: 'ภูมิศาสตร์', source: 'real',
      desc: 'พิกัดโครงการอยู่ไกลจากศูนย์กลางพื้นที่ของจังหวัดที่หน่วยงานสังกัด ' +
        'หมายเหตุ: จังหวัดในข้อมูลระบุที่ตั้งหน่วยงาน ไม่ใช่ที่ตั้งโครงการ จึงเป็นสัญญาณให้ตรวจสอบ ไม่ใช่ข้อสรุป · ' +
        'ไม่ประเมินหน่วยงานที่ทำงานทั่วประเทศ (โครงการครึ่งหนึ่งขึ้นไปอยู่ไกลเกินเกณฑ์อยู่แล้ว เช่น กรมที่ตั้งอยู่กรุงเทพฯ) ' +
        'เพราะระยะห่างเป็นลักษณะปกติของหน่วยงานนั้น ไม่ใช่ความผิดปกติของโครงการ',
      thresholds: { maxKm: { value: 200, min: 50, max: 800, step: 25, label: 'ระยะทางสูงสุด (กม.)' } },
      logic: t => `ระยะจากศูนย์กลางจังหวัด > ${t.maxKm} กม. และมัธยฐานระยะของหน่วยงานนั้น <= ${t.maxKm} กม.`,
      evaluate(r, ctx, t) {
        if (r.lat === null || r.lon === null) return null;
        // พิกัดที่ถูกใช้ซ้ำหลายโครงการคือพิกัดสำนักงาน ระยะที่คำนวณได้จึงไม่มีความหมาย
        if (r.geo_quality === 'shared') return null;
        const c = ctx.provinceCentroid.get(r.province);
        if (!c) return null;
        const dg = ctx.deptGeo.get(r.dept_key);
        if (dg && dg.medKm > t.maxKm) return null;   // หน่วยงานทำงานทั่วประเทศ
        const km = U.haversine(r.lat, r.lon, c.lat, c.lon);
        return km > t.maxKm ? { actual: `${km.toFixed(0)} กม. จาก ${r.province}` +
          (dg ? ` (โครงการอื่นของหน่วยงานนี้ห่างมัธยฐาน ${dg.medKm.toFixed(0)} กม.)` : '') } : null;
      }
    },
    {
      id: 'R18', name: 'อยู่ในพื้นที่ที่ปิดราคาเท่าราคากลางบ่อยผิดปกติ',
      severity: 'medium', weight: 12, category: 'ราคา', source: 'real', family: 'exact',
      desc: 'สัญญานี้ปิดราคาเท่าราคากลางพอดี และอยู่ในพื้นที่ที่รูปแบบนี้เกิดบ่อยกว่าค่ากลางของประเทศมาก ' +
        'ในงานประเภทเดียวกัน · การไม่มีส่วนลดเลยเป็นครั้งคราวเกิดขึ้นได้ แต่ถ้าเกิดเป็นระบบทั้งพื้นที่ ' +
        'แปลว่าการแข่งขันด้านราคาแทบไม่ทำงานในพื้นที่นั้น · ใช้คู่กับ R13 ซึ่งจับที่ตัวสัญญาอย่างเดียว',
      thresholds: {
        minGapPts: { value: 15, min: 3, max: 50, step: 1, label: 'สูงกว่าค่ากลางประเทศ (จุด %)' },
        confidence: { value: 0.90, min: 0.50, max: 0.99, step: 0.01, label: 'ความมั่นใจขั้นต่ำ', format: 'pct' },
      },
      logic: t => `สัญญานี้ ราคา = ราคากลางพอดี และ P(สัดส่วนจริงของพื้นที่ >= ค่ากลางประเทศ + ${t.minGapPts} จุด %) ` +
        `>= ${t.confidence} ตาม Beta posterior ที่ประมาณ prior แยกรายประเภทงาน`,
      applicable(ctx) {
        return ctx.regionalExact.size ? { ok: true }
          : { ok: false, reason: 'ไม่มีประเภทงานใดที่มีข้อมูลพอสร้างฐานเปรียบเทียบรายพื้นที่' };
      },
      evaluate(r, ctx, t) {
        const p = projectTotal(r, ctx), base = r.price_build;
        if (!p || base === null || base <= 0) return null;
        // ต้องเป็นโครงการที่ยอดรวมสัญญาเท่าราคากลางพอดีเท่านั้น (ราคากลางเป็นค่าระดับโครงการ)
        if (Math.abs(p.sum / base - 1) >= 1e-6) return null;

        const cell = (r.project_type_name || '-') + KEY_SEP + (r.province || '-');
        const stat = ctx.regionalExact.get(cell);
        if (!stat) return null;
        const bar = stat.national + t.minGapPts / 100;
        if (bar >= 1) return null;
        const prob = U.betaSf(bar, stat.postA, stat.postB);
        if (prob < t.confidence) return null;
        return {
          actual: `${r.province}: ${stat.exact} จาก ${stat.n} สัญญา ปิดราคาเท่าราคากลาง ` +
            `(ดิบ ${U.pct(stat.share)} · ปรับแล้ว ${U.pct(stat.postMean)}) ขณะที่ทั้งประเทศ ${U.pct(stat.national)} ` +
            `· มั่นใจ ${U.pct(prob, 0)} ว่าสูงกว่าเกิน ${t.minGapPts} จุด %`,
        };
      }
    },
    {
      id: 'R19', name: 'ลงนามสัญญาในวันเสาร์หรืออาทิตย์',
      severity: 'medium', weight: 12, category: 'เอกสาร/ข้อมูล', source: 'real',
      desc: 'วันที่ลงนามตรงกับวันหยุดสุดสัปดาห์ ซึ่งพบน้อยมากในชุดข้อมูลนี้ ' +
        'อาจมีเหตุจำเป็นเร่งด่วนรองรับ หรืออาจเป็นความคลาดเคลื่อนของการบันทึกวันที่ ' +
        'ตรวจเฉพาะเสาร์-อาทิตย์ เพราะชุดข้อมูลไม่มีปฏิทินวันหยุดราชการ',
      thresholds: {
        includeSat: { value: 1, min: 0, max: 1, step: 1, label: 'นับวันเสาร์ด้วย (1=ใช่)' },
      },
      logic: t => `วันลงนามเป็นวันอาทิตย์${Number(t.includeSat) ? ' หรือวันเสาร์' : ''}`,
      evaluate(r, ctx, t) {
        if (!r.contract_date) return null;
        const day = new Date(r.contract_date + 'T00:00:00').getDay();   // 0 = อาทิตย์, 6 = เสาร์
        const hit = day === 0 || (Number(t.includeSat) && day === 6);
        return hit ? { actual: `${day === 0 ? 'วันอาทิตย์' : 'วันเสาร์'} ที่ ${r.contract_date}` } : null;
      }
    },
    {
      id: 'R20', name: 'เลขที่สัญญาซ้ำภายในหน่วยงานเดียวกัน',
      severity: 'high', weight: 20, category: 'เอกสาร/ข้อมูล', source: 'real', scored: false,
      desc: 'เลขที่สัญญาเป็นเลขรันรายปีของแต่ละหน่วยงาน การซ้ำข้ามหน่วยงานเป็นเรื่องปกติ ' +
        'แต่การซ้ำภายในหน่วยงานเดียวกันไม่ควรเกิด อาจเป็นการบันทึกซ้ำ หรือการออกเลขซ้ำ ' +
        'ซึ่งกระทบการอ้างอิงเอกสารและการตรวจสอบย้อนกลับ · เป็นกฎคุณภาพข้อมูล แสดงให้เห็นแต่ไม่บวกคะแนนความเสี่ยง',
      thresholds: { min: { value: 2, min: 2, max: 10, step: 1, label: 'จำนวนครั้งขั้นต่ำ' } },
      logic: t => `เลขที่สัญญาเดียวกันในหน่วยงานเดียวกัน >= ${t.min} ครั้ง`,
      evaluate(r, ctx, t) {
        if (!r.contract_no || !r.dept_key) return null;
        const n = ctx.contractNoCount.get(r.dept_key + KEY_SEP + r.contract_no) || 0;
        return n >= t.min ? { actual: `เลขที่ ${r.contract_no} ปรากฏ ${n} ครั้งในหน่วยงานนี้` } : null;
      }
    },
    {
      id: 'R21', name: 'ยอดรวมโครงการไม่ตรงกับผลรวมสัญญา',
      severity: 'medium', weight: 12, category: 'เอกสาร/ข้อมูล', source: 'real', scored: false,
      desc: 'ช่อง sum_price_agree คือยอดรวมสัญญาทั้งโครงการ จึงควรเท่ากับผลรวมราคาสัญญาทุกฉบับของโครงการในชุดข้อมูล ' +
        'ถ้าไม่ตรง แปลว่าชุดข้อมูลมีสัญญาของโครงการนี้ไม่ครบ หรือตัวเลขช่องใดช่องหนึ่งผิด — ' +
        'ส่วนลดที่ R1/R2/R4/R13 คำนวณสำหรับโครงการนี้จึงเชื่อได้น้อยลง · ' +
        'เป็นกฎคุณภาพข้อมูล แสดงให้เห็นแต่ไม่บวกคะแนนความเสี่ยง',
      thresholds: {
        tol: { value: 0.01, min: 0, max: 0.2, step: 0.005, label: 'ต่างกันได้ไม่เกิน', format: 'pct' },
      },
      logic: t => `|sum_price_agree - Σ contract_price_agree ของโครงการ| / sum_price_agree > ${t.tol}`,
      evaluate(r, ctx, t) {
        const a = r.sum_price_agree, p = projectTotal(r, ctx);
        if (a === null || a === undefined || a <= 0 || !p) return null;
        const diff = Math.abs(a - p.sum) / a;
        if (diff <= t.tol) return null;
        return { actual: `ยอดรวม ${U.num(a, 0)} · ผลรวม ${p.n} สัญญาในชุด ${U.num(p.sum, 0)} (ต่างกัน ${U.pct(diff, 1)})` };
      }
    },
    {
      id: 'R22', name: 'ผู้รับจ้างรับงานจากหน่วยงานเดียวล้วน',
      severity: 'medium', weight: 12, category: 'ผู้รับจ้าง', source: 'real', family: 'pair',
      desc: 'ผู้รับจ้างที่มีหลายสัญญาแต่มาจากหน่วยงานเดียวทั้งหมด เป็นภาพกลับด้านของ HHI ' +
        'คือมองจากฝั่งผู้รับจ้างว่ารายได้พึ่งพาใคร อาจเป็นความชำนาญเฉพาะทางที่มีผู้ว่าจ้างรายเดียวจริง ' +
        'แต่ควรตรวจว่าการประกาศเชิญชวนเปิดกว้างเพียงพอหรือไม่',
      thresholds: {
        minContracts: { value: 5, min: 2, max: 30, step: 1, label: 'จำนวนสัญญาขั้นต่ำ' },
        minValue: { value: 5000000, min: 0, max: 200000000, step: 1000000, label: 'มูลค่ารวมขั้นต่ำ' },
      },
      logic: t => `ผู้รับจ้างมีสัญญา >= ${t.minContracts} ฉบับ มูลค่ารวม >= ${t.minValue} ` +
        `และทุกฉบับมาจากหน่วยงานเดียว`,
      evaluate(r, ctx, t) {
        if (r.tin_is_masked) return null;   // ระบุตัวตนไม่ได้ ไม่ควรสรุปเรื่องการพึ่งพา
        const w = ctx.winnerProfile.get(r.winner_key);
        if (!w || w.depts.size !== 1) return null;
        if (w.n < t.minContracts || w.value < t.minValue) return null;
        return { actual: `${w.n} สัญญา รวม ${U.num(w.value, 0)} บาท จากหน่วยงานเดียว` };
      }
    },
    {
      id: 'R23', name: 'คู่เดิมลงนามหลายโครงการในวันเดียวกัน',
      severity: 'medium', weight: 12, category: 'โครงสร้างสัญญา', source: 'real', family: 'split',
      desc: 'หน่วยงานและผู้รับจ้างคู่เดิมลงนามสัญญาของโครงการต่างกันตั้งแต่ 2 โครงการในวันเดียว ' +
        'ไม่ผูกกับเพดานวงเงินจึงใช้ได้กับงานทุกขนาด อาจเป็นงานต่อเนื่องที่วางแผนร่วมกันจริง ' +
        'หรือการแยกโครงการเพื่อเลี่ยงวงเงิน/อำนาจอนุมัติที่สูงกว่า · family เดียวกับ R10 (นับคะแนนข้อเดียว) ' +
        'ต่างจาก R3 ที่ดูโครงการเดียวแยกหลายสัญญา',
      thresholds: { minProjects: { value: 2, min: 2, max: 10, step: 1, label: 'จำนวนโครงการขั้นต่ำ' } },
      logic: t => `หน่วยงาน+ผู้รับจ้าง+วันทำสัญญาเดียวกัน มี project_id ต่างกัน >= ${t.minProjects}`,
      evaluate(r, ctx, t) {
        const g = r._splitGroup;
        if (!g || !g.projects || g.projects.size < t.minProjects) return null;
        return { actual: `${g.projects.size} โครงการ ${g.rows.length} สัญญา รวม ${U.num(g.total, 0)} บาท วันที่ ${r.contract_date}` };
      }
    },
  ];

  const BY_ID = new Map(DEFS.map(d => [d.id, d]));

  /* ---------------------------------------------------------------
     ชั้นเอกสารกำกับกฎ — ใช้สร้างตารางอ้างอิงในแท็บ "กฎและการตั้งค่า"

     fields  = คอลัมน์ในชุดข้อมูลต้นทางที่กฎนี้ใช้จริง
     basis   = เหตุผลที่ตั้งกฎ เขียนให้ไม่ผูกกับชุดข้อมูลใดชุดหนึ่ง
               (จำนวนที่พบในชุดที่เปิดอยู่ ตารางแสดงสดจาก summarize() อยู่แล้ว)
     history = บันทึกการออกแบบและตัวเลขที่วัดตอนนั้น ระบุชุดข้อมูลที่วัดทุกครั้ง
               เดิมตัวเลขเหล่านี้อยู่ใน basis ทำให้ดูเหมือนเป็นผลของชุดที่เปิดอยู่ ทั้งที่มาจากชุดเก่า
     ระบุเฉพาะสิ่งที่ตรวจสอบย้อนกลับได้จากข้อมูล ไม่อ้างอิงเอกสารที่ยืนยันไม่ได้
     --------------------------------------------------------------- */
  const DOCS = {
    R1: {
      fields: ['project_money', 'contract_price_agree', 'project_id'],
      basis: 'ส่วนลดที่มากผิดปกติสะท้อนได้ทั้งการตั้งวงเงินสูงเกินจริงและการเสนอราคาต่ำเพื่อให้ได้งาน ' +
        'ทั้งสองกรณีต้องมีเอกสารอธิบาย · วงเงินเป็นค่าระดับโครงการ จึงเทียบกับยอดรวมสัญญาทุกฉบับของโครงการ',
      history: 'ชุดปีงบ 2569 ทั้งปี (10,174 สัญญา) พบ 711 สัญญา · ทบทวน 2026-09 กับชุดโครงการยอดสูงสุด (1,082 สัญญา): ' +
        'นิยามเดิมเทียบรายสัญญาติด 267 ฉบับ แต่ 231 ฉบับมาจากโครงการที่แยกหลายสัญญา ' +
        'ซึ่งเมื่อคิดทั้งโครงการมีส่วนลดมัธยฐานเพียง 3.9% จึงเปลี่ยนเป็นเทียบระดับโครงการ',
    },
    R2: {
      fields: ['price_build', 'contract_price_agree', 'project_id'],
      basis: 'ราคากลางคือราคาที่หน่วยงานประเมินว่าสมเหตุสมผล การต่ำกว่ามากจึงชี้ว่าราคากลางอาจตั้งไว้ไม่เหมาะสม ' +
        '· เทียบระดับโครงการเหมือน R1 และอยู่ family เดียวกัน เพราะเมื่อราคากลางเท่าวงเงิน (R14) สองกฎนี้วัดสิ่งเดียวกัน',
      history: 'ชุดปีงบ 2569 ทั้งปี พบ 610 สัญญา · ทบทวน 2026-09: R1 กับ R2 ติดสัญญาชุดเดียวกัน 97% จึงรวม family ให้นับคะแนนครั้งเดียว',
    },
    R3: {
      fields: ['project_id'],
      basis: 'โครงการเดียวที่แยกทำสัญญาหลายฉบับอาจมีเหตุผลรองรับ (เช่น แบ่งพื้นที่หรือแบ่งรายการ) ' +
        'แต่ก็เป็นวิธีเลี่ยงวงเงินที่ต้องใช้วิธีจัดหาเข้มงวดกว่าได้เช่นกัน',
      history: 'ชุดปีงบ 2569 ทั้งปี พบ 225 สัญญาใน 51 โครงการ',
    },
    R4: {
      fields: ['contract_price_agree', 'project_money', 'project_id'],
      basis: 'ยอดรวมสัญญาไม่ควรเกินวงเงินที่ได้รับอนุมัติ การเกินจึงเป็นความผิดปกติเชิงงบประมาณที่ต้องอธิบายได้ ' +
        '· เทียบระดับโครงการ กรณีที่แต่ละฉบับไม่เกินแต่รวมกันเกินจึงถูกจับด้วย',
      history: 'ชุดปีงบ 2569 ทั้งปี พบ 27 สัญญา (นิยามเดิมเทียบรายสัญญา)',
    },
    R5: {
      fields: ['demo_n_bidders (สังเคราะห์)'],
      basis: 'ชุดข้อมูลต้นทางไม่มีจำนวนผู้เสนอราคา ตัวเลขนี้สังเคราะห์ขึ้นเพื่อสาธิตแนวคิดเท่านั้น ' +
        'จึงไม่ถูกนับรวมในคะแนนความเสี่ยงที่แสดง',
    },
    R6: {
      fields: ['demo_submission_days (สังเคราะห์)'],
      basis: 'ชุดข้อมูลต้นทางไม่มีวันปิดรับซอง ใช้ R16 แทนสำหรับรายการที่มีวันประกาศจริง ' +
        'ไม่ถูกนับรวมในคะแนนที่แสดง',
    },
    R7: {
      fields: ['winner_tin', 'winner_name', 'tin_is_masked'],
      basis: 'เลขภาษีกับชื่อควรสอดคล้องกันแบบหนึ่งต่อหนึ่ง ความไม่สอดคล้องอาจชี้ถึงนิติบุคคลที่ใช้ตัวตนซ้อนกัน ' +
        'ตรวจหลังทำชื่อเป็นมาตรฐานและตัดเลขภาษีที่ถูกปิดบังออกแล้ว',
      history: 'ชุดปีงบ 2569 ทั้งปี: ตัดเลขภาษีที่ถูกปิดบัง 2,205 แถวออกแล้ว จำนวนที่พบลดจาก 460 เหลือ 155 ' +
        'เพราะส่วนต่างเป็นผลจากรูปแบบการพิมพ์ ไม่ใช่ความผิดปกติจริง',
    },
    R8: {
      fields: ['dept_name', 'purchase_method_name', 'project_money'],
      basis: 'นับเฉพาะโครงการวงเงินเกิน 5 แสน (ซึ่งปกติต้องเปิดให้แข่งขัน) หน่วยนับเป็นโครงการ ไม่ใช่สัญญา ' +
        'แล้วใช้ Empirical Bayes (prior แบบ Beta จากทุกหน่วยงาน) แทนการตัดด้วยจำนวนขั้นต่ำ ' +
        'หน่วยงานที่มีโครงการน้อยจึงไม่ถูกติดธงเพราะความบังเอิญ',
      history: 'ชุดปีงบ 2569 ทั้งปี: เวอร์ชันแรกนับทุกสัญญาและติดธง 180 หน่วยงาน 1,320 สัญญา แต่เกือบทั้งหมดเป็นหน่วยงานที่มีแต่งานเล็ก ' +
        'เพราะ 97.6% ของสัญญา 1-5 แสนใช้วิธีเฉพาะเจาะจงตามที่ระเบียบเปิดให้ทำได้ ขณะที่งานเกิน 5 แสนใช้เพียง 5.9% · ' +
        'เปลี่ยนหน่วยนับเป็นโครงการเพราะโครงการจ้างเหมาบุคคล 43 อัตราออกสัญญารายคน · ' +
        'ผลกับชุดนั้น 67 จาก 2,354 โครงการ ไม่พบหน่วยงานใดสูงกว่าที่ความบังเอิญอธิบายได้ ' +
        '(chi-square p = 0.19 · exact binomial หลังคุม FDR ติดธง 0 หน่วยงาน) · ' +
        'ชุดโครงการยอดสูงสุดมีแต่งานเกิน 5 แสน กฎจึงติดธงได้ ดูจำนวนสดในตาราง',
    },
    R9: {
      fields: ['contract_price_agree'],
      basis: 'ราคาที่เป็นตัวเลขกลมอาจมาจากการกำหนดตัวเลขแทนการคำนวณต้นทุนจริง แต่เป็นสัญญาณอ่อน จึงตั้งน้ำหนักไว้ต่ำสุด ' +
        '· วัดด้วยจำนวนเลขนัยสำคัญเพื่อให้ใช้ได้ทุกขนาดสัญญา',
      history: 'ชุดปีงบ 2569 ทั้งปี (เกณฑ์ศูนย์ท้าย 3 ตัว) พบ 5,646 สัญญา · ทบทวน 2026-09: เกณฑ์ศูนย์ท้ายติด 650 จาก 1,082 สัญญา ' +
        'ของชุดโครงการยอดสูงสุด (60%) เพราะสัญญาหลักร้อยล้านลงท้าย 000 แทบทุกฉบับ จึงเปลี่ยนเป็นเลขนัยสำคัญ',
    },
    R10: {
      fields: ['dept_name', 'winner_name', 'contract_date', 'contract_price_agree'],
      basis: 'การแตกงานเป็นหลายสัญญาย่อยในวันเดียวกันกับคู่สัญญาเดิม โดยแต่ละฉบับต่ำกว่าเพดานแต่ยอดรวมสูง ' +
        'เป็นรูปแบบการเลี่ยงวิธีจัดหาที่เข้มงวดกว่า · ใช้ได้เฉพาะชุดที่มีงานใต้เพดานมากพอ',
      history: 'ชุดปีงบ 2569 ทั้งปี พบ 441 กลุ่ม ครอบคลุม 1,025 สัญญา · ทบทวน 2026-09: ชุดโครงการยอดสูงสุดมีสัญญาต่ำกว่า 5 แสนเพียง 2 ฉบับ ' +
        'จึงเพิ่ม R23 สำหรับงานทุกขนาด',
    },
    R11: {
      fields: ['contract_date', 'contract_finish_date'],
      basis: 'วันสิ้นสุดก่อนวันเริ่มเป็นไปไม่ได้ในทางปฏิบัติ จึงเป็นความผิดพลาดของข้อมูลที่ควรตรวจกับเอกสารต้นฉบับ ' +
        '· กฎคุณภาพข้อมูล ไม่บวกคะแนนความเสี่ยง แต่ยังใช้เป็นป้าย "ความผิดพลาดที่รู้แน่" ในการวัด F2',
      history: 'ชุดปีงบ 2569 ทั้งปี พบ 10 สัญญา',
    },
    R12: {
      fields: ['purchase_method_name', 'contract_price_agree'],
      basis: 'ราคาที่เกาะอยู่ใต้เพดานวิธีเฉพาะเจาะจงพอดีเป็นรูปแบบที่ไม่เกิดขึ้นเองตามธรรมชาติของการกระจายราคา ' +
        '· ใช้ได้เฉพาะชุดที่มีงานใต้เพดานมากพอ',
      history: 'ชุดปีงบ 2569 ทั้งปี: ช่วง 450,000-500,000 บาทมี 1,789 สัญญา ขณะที่ช่วง 500,000-550,000 มีเพียง 119 สัญญา ต่างกัน 15 เท่า ' +
        'เป็นสัญญาณเชิงประจักษ์ที่หนักแน่นที่สุดของชุดนั้น · ชุดโครงการยอดสูงสุดไม่มีสัญญาในช่วงนี้เลย',
    },
    R13: {
      fields: ['contract_price_agree', 'price_build', 'project_id'],
      basis: 'การไม่มีส่วนลดจากราคากลางเลยแสดงว่าไม่มีแรงกดดันด้านการแข่งขัน ' +
        '· เทียบยอดรวมสัญญาของโครงการกับราคากลาง ซึ่งเป็นค่าระดับโครงการ',
      history: 'ชุดปีงบ 2569 ทั้งปี พบ 3,264 สัญญาที่ราคาตรงกับราคากลางพอดีทุกบาท (32.2% ของสัญญาที่มีราคากลาง)',
    },
    R14: {
      fields: ['price_build', 'project_money'],
      basis: 'ราคากลางควรมาจากการประมาณต้นทุนอย่างอิสระ การตั้งให้เท่าวงเงินที่ได้รับพอดีสะท้อนว่าไม่ได้ประมาณราคาแยกต่างหาก',
      history: 'ชุดปีงบ 2569 ทั้งปี พบ 4,759 สัญญา (46.8%) · ชุดโครงการยอดสูงสุดติดราวครึ่งหนึ่งเช่นกัน จึงเป็นกฎกว้างที่แยกแยะได้น้อย',
    },
    R15: {
      fields: ['dept_name', 'winner_name'],
      basis: 'ผู้รับจ้างรายเดิมที่ได้งานจากหน่วยงานเดิมซ้ำหลายครั้งอาจมาจากความเชี่ยวชาญเฉพาะ ' +
        'หรือจากการแข่งขันที่ไม่สม่ำเสมอ ต้องดูประกอบกับวิธีจัดหา · family เดียวกับ R22',
      history: 'ชุดปีงบ 2569 ทั้งปี พบ 254 คู่ที่มีสัญญาตั้งแต่ 5 ฉบับ สูงสุด 52 ฉบับ',
    },
    R16: {
      fields: ['announce_date', 'contract_date', 'purchase_method_name', 'project_money'],
      basis: 'ระเบียบกระทรวงการคลังว่าด้วยการจัดซื้อจัดจ้างและการบริหารพัสดุภาครัฐ พ.ศ. 2560 กำหนดระยะเวลาเผยแพร่ ' +
        'ประกาศประกวดราคาขั้นต่ำไว้ตามวงเงิน (เฉพาะวิธี e-bidding): เกิน 5 แสน-5 ล้าน ≥5 วันทำการ, 5-10 ล้าน ≥10 วันทำการ, ' +
        '10-50 ล้าน ≥12 วันทำการ, เกิน 50 ล้าน ≥20 วันทำการ ต่ำกว่านี้จำกัดโอกาสของผู้เสนอราคารายอื่นและขัดระเบียบโดยตรง ' +
        '(ไม่ใช่แค่ผิดปกติเชิงสถิติ) · ใช้วันประกาศจริงแทน R6 ที่เป็นข้อมูลสาธิต',
      history: 'ชุดปีงบ 2569 ทั้งปี: มีวันประกาศ 1,910 รายการ ใช้เกณฑ์ตายตัว ≤ 15 วันแบบเดียวทุกวงเงิน (ไม่มีฐานอ้างอิงกฎหมาย) · ' +
        'ทบทวน 2026-09: เปลี่ยนเป็นเทียบกับระยะขั้นต่ำตามระเบียบจริงแยกตามชั้นวงเงิน (เดิมเคยลองใช้เปอร์เซ็นไทล์ภายในวิธีจัดหา ' +
        'แต่เป็นการเทียบเชิงสัมพัทธ์ ไม่มีฐานทางกฎหมาย จึงเปลี่ยนมาใช้ตัวเลขจากระเบียบแทน) · เกณฑ์เป็นวันทำการแต่ข้อมูลนับวันปฏิทิน ' +
        '(ไม่มีปฏิทินวันหยุดราชการ) จึงติดธงเฉพาะกรณีวันปฏิทินยังน้อยกว่าวันทำการขั้นต่ำ ซึ่งเป็นไปไม่ได้ตามระเบียบเสมอ',
    },
    R17: {
      fields: ['project_location', 'province', 'dept_key'],
      basis: 'คอลัมน์จังหวัดระบุที่ตั้งหน่วยงาน ส่วนพิกัดระบุที่ตั้งโครงการ ระยะห่างมากจึงหมายถึงหน่วยงานจัดหาไกลจากพื้นที่ตนเอง ' +
        'ซึ่งอาจมีเหตุผลรองรับ เป็นสัญญาณให้ตรวจสอบ ไม่ใช่ข้อสรุป · ศูนย์กลางจังหวัดคำนวณจากมัธยฐานพิกัดของสัญญาในจังหวัดนั้น ' +
        '· ไม่ประเมินหน่วยงานที่มัธยฐานระยะของโครงการเกินเกณฑ์อยู่แล้ว (ทำงานทั่วประเทศ)',
      history: 'ทบทวน 2026-09: ชุดโครงการยอดสูงสุดติด 380 จาก 610 สัญญาที่มีพิกัด (62%) เกือบทั้งหมดเป็นกรมส่วนกลาง ' +
        '(โยธาธิการฯ 112, ทรัพยากรน้ำบาดาล 101, ทางหลวง 90) ซึ่งช่องจังหวัดคือที่ตั้งสำนักงานใหญ่',
    },
    R18: {
      fields: ['contract_price_agree', 'price_build', 'project_type_name', 'province'],
      basis: 'เทียบ "สัดส่วนโครงการที่ปิดราคาเท่าราคากลางพอดี" ของพื้นที่กับค่ากลางประเทศในงานประเภทเดียวกัน ' +
        'ด้วย Empirical Bayes (prior แยกรายประเภทงาน) ติดธงเมื่อมั่นใจตามเกณฑ์ว่าสูงกว่าจริง ไม่ใช่ความบังเอิญของตัวอย่าง ' +
        '· ข้อจำกัด: ราคากลางเป็นค่าที่หน่วยงานประเมินเอง กฎนี้บอกได้ว่าการแข่งขันด้านราคาไม่เกิดผลบ่อยแค่ไหนในพื้นที่ ' +
        'แต่บอกไม่ได้ว่าราคานั้นแพงเกินจริงหรือไม่ · family เดียวกับ R13',
      history: 'ชุดปีงบ 2569 ทั้งปี: การเทียบ "ระดับราคา" ข้ามจังหวัดใช้ไม่ได้ เพราะมัธยฐานอัตราส่วนราคาต่อราคากลางติด 100% แทบทุกจังหวัด ' +
        '(สูงสุดต่างจากค่ากลางเพียง 0.43%) ขณะที่สัดส่วนปิดราคาเท่าราคากลางกระจาย 0%-58.3% ' +
        '(มัธยฐาน 17.1% จาก 68 จังหวัดที่มีงานก่อสร้างตั้งแต่ 20 สัญญา) · เดิมใช้สัดส่วนดิบของพื้นที่ที่มีอย่างน้อย 20 สัญญา ' +
        'แล้วเปลี่ยนเป็น Empirical Bayes',
    },
    R19: {
      fields: ['contract_date'],
      basis: 'การลงนามวันหยุดสุดสัปดาห์พบน้อย ความหายากคือจุดแข็งของกฎนี้เพราะตรวจครบทุกฉบับได้ในเวลาไม่นาน ' +
        '· ข้อจำกัด: ไม่มีปฏิทินวันหยุดราชการในข้อมูล จึงตรวจได้เฉพาะเสาร์-อาทิตย์',
      history: 'ชุดปีงบ 2569 ทั้งปี พบ 22 ฉบับจาก 10,174 (0.22%) รวม 23.7 ล้านบาท',
    },
    R20: {
      fields: ['contract_no', 'dept_key'],
      basis: 'เลขที่สัญญาเป็นเลขรันรายปีของแต่ละหน่วยงาน (1/2569, 2/2569, ...) การซ้ำข้ามหน่วยงานจึงปกติ ' +
        'แต่การซ้ำภายในหน่วยงานเดียวกันไม่ควรเกิดและกระทบการอ้างอิงเอกสาร ' +
        '· กฎคุณภาพข้อมูล ไม่บวกคะแนน แต่ยังใช้เป็นป้าย "ความผิดพลาดที่รู้แน่" ในการวัด F2',
      history: 'ชุดปีงบ 2569 ทั้งปี: ซ้ำข้ามหน่วยงาน 353 กรณี ซ้ำภายในหน่วยงานเดียวกัน 24 กรณี',
    },
    R21: {
      fields: ['sum_price_agree', 'contract_price_agree', 'project_id'],
      basis: 'ยอดรวมโครงการควรเท่ากับผลรวมสัญญา ถ้าไม่ตรงแปลว่าชุดข้อมูลมีสัญญาไม่ครบหรือตัวเลขผิด ' +
        'และส่วนลดระดับโครงการของ R1/R2/R4/R13 เชื่อได้น้อยลง · กฎคุณภาพข้อมูล ไม่บวกคะแนน',
      history: 'ชุดปีงบ 2569 ทั้งปี (นิยามเดิม: ยอดรวมต่างจากราคาสัญญาฉบับนั้น) พบ 195 ฉบับ มัธยฐาน 7.4 เท่า · ' +
        'ทบทวน 2026-09: sum_price_agree เท่ากับผลรวมสัญญาของโครงการครบ 42/42 โครงการ ' +
        'ความต่างที่นิยามเดิมจับได้จึงเป็นแค่ "ยอดทั้งโครงการเทียบสัญญาฉบับเดียว" ไม่ใช่ข้อมูลขัดกัน ' +
        'จึงเปลี่ยนเป็นตรวจความครบของข้อมูลแทน',
    },
    R22: {
      fields: ['winner_key', 'dept_key', 'contract_price_agree'],
      basis: 'ผู้รับจ้างที่มีหลายสัญญาแต่มาจากหน่วยงานเดียวทั้งหมด เป็นมุมกลับของ HHI ซึ่งมองจากฝั่งหน่วยงาน ' +
        '· family เดียวกับ R15 (ติดสัญญาชุดเดียวกันเกือบทั้งหมด) จึงนับคะแนนข้อเดียว',
      history: 'ชุดปีงบ 2569 ทั้งปี: จากผู้รับจ้างที่มีสัญญาตั้งแต่ 5 ฉบับ 383 ราย พบ 188 ราย (49.1%) รับงานจากหน่วยงานเดียวล้วน ' +
        'สามอันดับแรกตามมูลค่ารับงานจากกรมทรัพยากรน้ำบาดาลรายละ 345-470 ล้านบาท',
    },
    R23: {
      fields: ['dept_key', 'winner_key', 'contract_date', 'project_id'],
      basis: 'ต่อยอด R10 ให้ใช้ได้กับงานทุกขนาด: ไม่ดูเพดานวงเงิน แต่ดูว่าคู่เดิมลงนามหลายโครงการ (project_id ต่างกัน) ในวันเดียว ' +
        'ซึ่งเป็นลักษณะของการแยกโครงการ · เป็นสัญญาณให้ตรวจเหตุผลของการแยก ไม่ใช่ข้อสรุป',
      history: 'ทบทวน 2026-09: ชุดโครงการยอดสูงสุดมี 60 กลุ่มที่คู่เดิมลงนามหลายโครงการในวันเดียว ' +
        'ซึ่ง R10 จับไม่ได้เพราะทุกฉบับเกินเพดาน 5 แสน',
    },
  };

  /* ตัวคั่นคีย์ ต้องเป็นอักขระที่ไม่ปรากฏในชื่อจริง
     ชื่อหน่วยงานและผู้รับจ้างมีช่องว่างอยู่ในตัวเองเกือบทุกระเบียน (ชุดปีงบ 2569 ทั้งปี: 9,313 จาก 10,174)
     การใช้ช่องว่างเป็นตัวคั่นจะทำให้คนละคู่ได้คีย์ชนกันได้
     เขียนเป็น escape เพื่อให้เห็นชัดและกันเครื่องมืออื่นตัดอักขระควบคุมทิ้ง */
  const KEY_SEP = '\u0000';

  function splitKey(r) {
    return r.dept_key + KEY_SEP + r.winner_key + KEY_SEP + (r.contract_date || '');
  }

  /* ---------------------------------------------------------------
     ระดับความเสี่ยง — นิยามเดียวใช้ทั้งแอป
     เดิมมีนิยามระดับกระจัดกระจาย 11 ชุดที่ไม่ตรงกัน
     --------------------------------------------------------------- */
  /* ---------------------------------------------------------------
     กรอบ 3E + Integrity/Performance ตามแนวมาตรฐานการตรวจสอบ

     แยกออกจาก DEFS โดยตั้งใจ เพราะเป็น "การจัดหมวดของกฎ" ไม่ใช่ตรรกะการตรวจจับ
     แก้ไขหรือทบทวนการจัดหมวดได้โดยไม่ไปแตะสูตรที่ใช้คำนวณคะแนน

     การจับคู่กฎกับมิติและช่วงกระบวนการ อ้างอิงตารางกรอบมาตรฐานที่ผู้ใช้จัดทำไว้
     (INTOSAI GUID 5280 / ISSAI, พ.ร.บ.การจัดซื้อจัดจ้างฯ, แนว red flags ของ World Bank และ OECD)
     ผู้ตรวจสอบควรทบทวนการจัดหมวดอีกครั้งให้ตรงกับกรอบที่หน่วยงานใช้จริง
     --------------------------------------------------------------- */

  const DIMENSIONS = [
    { key: 'economy', label: 'ความประหยัด', en: 'Economy',
      desc: 'ได้ของหรืองานในราคาที่สมเหตุสมผล ไม่จ่ายแพงเกินความจำเป็น' },
    { key: 'efficiency', label: 'ประสิทธิภาพ', en: 'Efficiency',
      desc: 'ใช้ทรัพยากรและเวลาในกระบวนการจัดหาอย่างเหมาะสม การแข่งขันเปิดกว้าง' },
    { key: 'effectiveness', label: 'ผลสัมฤทธิ์', en: 'Effectiveness',
      desc: 'งานที่ได้บรรลุวัตถุประสงค์และถูกนำไปใช้ประโยชน์จริง' },
    { key: 'integrity', label: 'ความสุจริตโปร่งใส', en: 'Integrity',
      desc: 'ไม่มีการเอื้อประโยชน์ ฮั้ว หรือหลีกเลี่ยงกระบวนการที่ควรใช้' },
    { key: 'performance', label: 'ผลงานผู้รับจ้าง', en: 'Performance',
      desc: 'ผู้รับจ้างส่งมอบงานได้ตรงเวลา ครบถ้วน และมีคุณภาพตามสัญญา' },
  ];

  const STAGES = [
    { key: 'plan', label: 'วางแผน / กำหนดขอบเขตงาน' },
    { key: 'award', label: 'จัดหาและลงนามสัญญา' },
    { key: 'manage', label: 'บริหารสัญญา' },
    { key: 'post', label: 'หลังส่งมอบ / ผลสัมฤทธิ์' },
    { key: 'portfolio', label: 'ภาพรวมพอร์ตสัญญา' },
  ];

  const FRAMEWORK = {
    R1:  { dims: ['economy'], stage: 'award',
           standard: 'พ.ร.บ.การจัดซื้อจัดจ้างฯ หลักความคุ้มค่า · INTOSAI GUID 5280 (economy)' },
    R2:  { dims: ['economy', 'integrity'], stage: 'award',
           standard: 'หลักความคุ้มค่า · แนว red flags ด้านราคาของ World Bank' },
    R3:  { dims: ['integrity', 'efficiency'], stage: 'plan',
           standard: 'INTOSAI GUID 5280 การออกแบบกระบวนการให้แข่งขันได้และประหยัด' },
    R4:  { dims: ['economy'], stage: 'award',
           standard: 'การควบคุมวงเงินและอำนาจอนุมัติตามระเบียบพัสดุ' },
    R5:  { dims: ['integrity', 'efficiency'], stage: 'award',
           standard: 'OECD red flags การฮั้วประมูล (ผู้เสนอราคารายเดียว)' },
    R6:  { dims: ['efficiency', 'integrity'], stage: 'award',
           standard: 'ISSAI performance audit – efficiency ของกระบวนการ' },
    R7:  { dims: ['integrity'], stage: 'award',
           standard: 'ความถูกต้องของข้อมูลตัวตนคู่สัญญา · แนว beneficial ownership' },
    R8:  { dims: ['efficiency', 'integrity'], stage: 'award',
           standard: 'พ.ร.บ.ฯ หลักการแข่งขันอย่างเป็นธรรม · INTOSAI ความเสี่ยง single-sourcing' },
    R9:  { dims: ['economy', 'integrity'], stage: 'award',
           standard: 'แนว red flags ด้านโครงสร้างราคาของ World Bank' },
    R10: { dims: ['integrity', 'economy'], stage: 'plan',
           standard: 'การแบ่งซื้อแบ่งจ้างเพื่อเลี่ยงวิธีจัดหา · INTOSAI GUID 5280' },
    R11: { dims: ['integrity'], stage: 'award',
           standard: 'ความถูกต้องครบถ้วนของสาระสำคัญในสัญญา' },
    R12: { dims: ['integrity', 'economy'], stage: 'plan',
           standard: 'การกำหนดขอบเขตงานให้พอดีเพดานวงเงิน · แนว red flags ของ World Bank' },
    R13: { dims: ['integrity', 'economy'], stage: 'award',
           standard: 'OECD red flags การเสนอราคาที่ไม่เป็นอิสระจากราคาอ้างอิง' },
    R14: { dims: ['economy', 'integrity'], stage: 'plan',
           standard: 'ความเป็นอิสระของการกำหนดราคากลางจากกรอบวงเงิน' },
    R15: { dims: ['integrity', 'economy'], stage: 'portfolio',
           standard: 'INTOSAI GUID 5280 การตรวจระดับระบบ · red flag การชนะซ้ำรายเดิม' },
    R16: { dims: ['efficiency', 'integrity'], stage: 'award',
           standard: 'ISSAI 100 / performance audit – efficiency ของกระบวนการ' },
    R17: { dims: ['effectiveness', 'integrity'], stage: 'post',
           standard: 'INTOSAI – effectiveness การใช้ประโยชน์และที่ตั้งของผลผลิต' },
    R18: { dims: ['economy'], stage: 'award',
           standard: 'value for money เทียบข้ามพื้นที่ · World Bank cost benchmarking' },
    R19: { dims: ['integrity'], stage: 'award',
           standard: 'ความสมเหตุสมผลของวันที่ในเอกสารสัญญา · แนว red flags ด้านกระบวนการ' },
    R20: { dims: ['integrity'], stage: 'award',
           standard: 'ความถูกต้องของการอ้างอิงเอกสารและการตรวจสอบย้อนกลับ' },
    R21: { dims: ['economy', 'integrity'], stage: 'award',
           standard: 'ความถูกต้องของมูลค่าที่ผูกพันตามสัญญา' },
    R22: { dims: ['efficiency', 'integrity'], stage: 'portfolio',
           standard: 'INTOSAI GUID 5280 การตรวจระดับระบบ · ความเสี่ยงจากการพึ่งพาคู่ค้ารายเดียว' },
    R23: { dims: ['integrity', 'economy'], stage: 'plan',
           standard: 'การแยกโครงการเพื่อเลี่ยงวิธีจัดหาหรืออำนาจอนุมัติ · INTOSAI GUID 5280' },
  };

  function framework(ruleId) { return FRAMEWORK[ruleId] || null; }

  /** นับกฎและจำนวนที่พบ แยกตามมิติ x ช่วงกระบวนการ — ใช้ทำตารางความครอบคลุม
   *  counts = Map ของ ruleId -> {n, value} จาก summarize() (ส่งมาได้หรือไม่ส่งก็ได้) */
  function coverage(counts = null) {
    const cells = new Map();
    const dimTotals = new Map();
    const stageTotals = new Map();

    for (const def of DEFS) {
      const f = FRAMEWORK[def.id];
      if (!f) continue;
      const n = counts ? (counts.get(def.id)?.n || 0) : 0;
      for (const dim of f.dims) {
        const key = dim + '|' + f.stage;
        let c = cells.get(key);
        if (!c) { c = { dim, stage: f.stage, rules: [], hits: 0 }; cells.set(key, c); }
        c.rules.push({ id: def.id, name: def.name, source: def.source, hits: n });
        c.hits += n;

        dimTotals.set(dim, (dimTotals.get(dim) || 0) + 1);
        stageTotals.set(f.stage, (stageTotals.get(f.stage) || 0) + 1);
      }
    }
    return { cells, dimTotals, stageTotals };
  }

  const BANDS = [
    { key: 'critical', label: 'วิกฤต', min: 60, cls: 'badge-critical', color: '#b91c1c' },
    { key: 'high', label: 'สูง', min: 40, cls: 'badge-high', color: '#ea580c' },
    { key: 'medium', label: 'ปานกลาง', min: 20, cls: 'badge-medium', color: '#ca8a04' },
    { key: 'low', label: 'ต่ำ', min: 0.0001, cls: 'badge-low', color: '#0f766e' },
    { key: 'none', label: 'ไม่พบสัญญาณ', min: -1, cls: 'badge-none', color: '#94a3b8' },
  ];

  function band(score) {
    return BANDS.find(b => score >= b.min) || BANDS[BANDS.length - 1];
  }

  const SEVERITY_ORDER = { none: 0, low: 1, medium: 2, high: 3, critical: 4 };

  /* ---------------------------------------------------------------
     การตั้งค่า threshold (ปรับได้จาก UI, จำไว้ใน localStorage)
     --------------------------------------------------------------- */

  function defaultSettings() {
    const s = {};
    for (const d of DEFS) {
      s[d.id] = { enabled: true, weight: d.weight, thresholds: {} };
      for (const [k, spec] of Object.entries(d.thresholds || {})) {
        s[d.id].thresholds[k] = spec.value;
      }
    }
    return s;
  }

  function loadSettings() {
    const base = defaultSettings();
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (!raw) return base;
      const saved = JSON.parse(raw);
      for (const [id, cfg] of Object.entries(saved)) {
        if (!base[id]) continue;
        if (typeof cfg.enabled === 'boolean') base[id].enabled = cfg.enabled;
        if (Number.isFinite(cfg.weight)) base[id].weight = cfg.weight;
        for (const [k, v] of Object.entries(cfg.thresholds || {})) {
          if (k in base[id].thresholds && Number.isFinite(v)) base[id].thresholds[k] = v;
        }
      }
    } catch (e) {
      console.warn('อ่านการตั้งค่า rule ไม่สำเร็จ ใช้ค่าเริ่มต้นแทน', e);
    }
    return base;
  }

  function saveSettings(settings) {
    try { localStorage.setItem(STORAGE_KEY, JSON.stringify(settings)); }
    catch (e) { /* โหมดส่วนตัวหรือพื้นที่เต็ม — ไม่กระทบการทำงาน */ }
  }

  function resetSettings() {
    try { localStorage.removeItem(STORAGE_KEY); } catch (e) { /* ไม่สำคัญ */ }
    return defaultSettings();
  }

  /* ---------------------------------------------------------------
     บริบท — สร้างดัชนีครั้งเดียว ใช้ซ้ำทุกครั้งที่ประเมิน
     --------------------------------------------------------------- */

  function buildContext(records) {
    const projectContracts = new Map();
    // ยอดรวมสัญญาต่อโครงการ — ใช้กับกฎที่เทียบกับช่องระดับโครงการ (วงเงิน ราคากลาง ยอดรวม)
    const projectAgg = new Map();
    const tinToNames = new Map();
    const nameToTins = new Map();
    const agencyMethod = new Map();
    const splitGroups = new Map();
    const pairCounts = new Map();
    const provincePoints = new Map();
    const prices = [], specificPrices = [];
    let ebidGapEligible = 0;   // นับสัญญาที่ R16 ประเมินได้ (e-bidding, มีวันประกาศ, วงเงิน > เพดานเฉพาะเจาะจง)

    for (const r of records) {
      projectContracts.set(r.project_id, (projectContracts.get(r.project_id) || 0) + 1);
      let pa = projectAgg.get(r.project_id);
      if (!pa) { pa = { n: 0, sum: 0, missing: 0 }; projectAgg.set(r.project_id, pa); }
      pa.n++;
      if (r.contract_price_agree === null || r.contract_price_agree === undefined) pa.missing++;
      else pa.sum += r.contract_price_agree;

      if (r.contract_price_agree !== null && r.contract_price_agree !== undefined) {
        prices.push(r.contract_price_agree);
        if (r.purchase_method_name === SPECIFIC_METHOD) specificPrices.push(r.contract_price_agree);
      }
      if (r.announce_gap_days !== null && r.announce_gap_days !== undefined
          && r.purchase_method_name === EBIDDING_METHOD && r.project_money > DISCRETIONARY_CEILING) {
        ebidGapEligible++;
      }

      if (!r.tin_is_masked && r.winner_tin && r.winner_key) {
        let names = tinToNames.get(r.winner_tin);
        if (!names) { names = new Set(); tinToNames.set(r.winner_tin, names); }
        names.add(r.winner_key);

        let tins = nameToTins.get(r.winner_key);
        if (!tins) { tins = new Set(); nameToTins.set(r.winner_key, tins); }
        tins.add(r.winner_tin);
      }

      let am = agencyMethod.get(r.dept_key);
      if (!am) {
        am = { total: 0, specific: 0, discretionary: 0, specificDiscretionary: 0 };
        agencyMethod.set(r.dept_key, am);
      }
      am.total++;
      if (r.purchase_method_name === SPECIFIC_METHOD) am.specific++;
      // นับเป็นโครงการ ไม่ใช่สัญญา: โครงการจ้างเหมาบุคคล 43 อัตราออกสัญญารายคน 43 ฉบับ
      // ถ้านับรายสัญญา โครงการเดียวนี้จะดันสัดส่วนของหน่วยงานเป็น 86% ทั้งที่อีก 7 โครงการใช้ e-bidding ถูกต้อง
      if (r.project_money > DISCRETIONARY_CEILING) {
        if (!am.projects) am.projects = new Map();
        if (!am.projects.has(r.project_id)) {
          const isSpecific = r.purchase_method_name === SPECIFIC_METHOD;
          am.projects.set(r.project_id, isSpecific);
          am.discretionary++;
          if (isSpecific) am.specificDiscretionary++;
        }
      }

      // เก็บกลุ่มไว้กับตัวระเบียนเลย จะได้ไม่ต้องประกอบคีย์ใหม่ทุกครั้งที่ประเมิน
      if (r.contract_date) {
        const k = splitKey(r);
        let g = splitGroups.get(k);
        if (!g) { g = { rows: [], total: 0, projects: new Set() }; splitGroups.set(k, g); }
        g.rows.push(r);
        g.total += r.contract_price_agree || 0;
        g.projects.add(r.project_id);
        r._splitGroup = g;
      } else {
        r._splitGroup = null;
      }

      const pk = r.dept_key + KEY_SEP + r.winner_key;
      pairCounts.set(pk, (pairCounts.get(pk) || 0) + 1);

      if (r.lat !== null && r.lon !== null && r.province && r.geo_quality !== 'shared') {
        let pts = provincePoints.get(r.province);
        if (!pts) { pts = { lats: [], lons: [] }; provincePoints.set(r.province, pts); }
        pts.lats.push(r.lat);
        pts.lons.push(r.lon);
      }
    }

    // ใช้มัธยฐานแทนค่าเฉลี่ย เพื่อไม่ให้พิกัดผิดปกติดึงศูนย์กลางเพี้ยน
    const provinceCentroid = new Map();
    for (const [prov, pts] of provincePoints) {
      if (pts.lats.length < 3) continue;   // จุดน้อยเกินไป ศูนย์กลางไม่น่าเชื่อถือ
      provinceCentroid.set(prov, { lat: U.median(pts.lats), lon: U.median(pts.lons) });
    }

    /* มัธยฐานระยะจากจังหวัดของหน่วยงานถึงโครงการ ต่อหน่วยงาน (R17)
       กรมส่วนกลางตั้งอยู่กรุงเทพฯ แต่ทำโครงการทั่วประเทศ ระยะไกลจึงเป็นเรื่องปกติของหน่วยงานนั้น
       ต้องมีโครงการที่มีพิกัดอย่างน้อย 3 แห่งจึงจะจัดประเภทได้ */
    const deptDist = new Map();
    for (const r of records) {
      if (r.lat === null || r.lon === null || r.lat === undefined || r.geo_quality === 'shared' || !r.dept_key) continue;
      const c = provinceCentroid.get(r.province);
      if (!c) continue;
      if (!deptDist.has(r.dept_key)) deptDist.set(r.dept_key, []);
      deptDist.get(r.dept_key).push(U.haversine(r.lat, r.lon, c.lat, c.lon));
    }
    const deptGeo = new Map();
    for (const [dept, ds] of deptDist) {
      if (ds.length >= 3) deptGeo.set(dept, { n: ds.length, medKm: U.median(ds) });
    }

    prices.sort((a, b) => a - b);
    specificPrices.sort((a, b) => a - b);

    /* เลขสัญญาเป็นเลขรันรายปีต่อหน่วยงาน (1/2569, 2/2569, ...) การซ้ำข้ามหน่วยงาน
       จึงเป็นเรื่องปกติ แต่การซ้ำภายในหน่วยงานเดียวกันไม่ควรเกิด */
    const contractNoCount = new Map();
    /* ฝั่งผู้รับจ้าง: รับงานจากกี่หน่วยงาน รวมกี่สัญญา และมูลค่าเท่าไร
       ใช้ตรวจการพึ่งพาหน่วยงานเดียว ซึ่งเป็นภาพกลับด้านของ HHI */
    const winnerProfile = new Map();

    for (const r of records) {
      if (r.contract_no && r.dept_key) {
        const k = r.dept_key + KEY_SEP + r.contract_no;
        contractNoCount.set(k, (contractNoCount.get(k) || 0) + 1);
      }
      if (r.winner_key) {
        let w = winnerProfile.get(r.winner_key);
        if (!w) { w = { n: 0, depts: new Set(), value: 0 }; winnerProfile.set(r.winner_key, w); }
        w.n++;
        if (r.dept_key) w.depts.add(r.dept_key);
        w.value += r.contract_price_agree || 0;
      }
    }

    // prior ของสัดส่วน "ใช้วิธีเฉพาะเจาะจงกับงานวงเงินเกิน 5 แสน" จากทุกหน่วยงานที่มีงานระดับนี้
    const disc = [...agencyMethod.values()].filter(a => a.discretionary > 0);
    const specificPrior = U.fitBetaPrior(disc.map(a => a.specificDiscretionary), disc.map(a => a.discretionary));

    return Object.assign(
      { projectContracts, projectAgg, tinToNames, nameToTins, agencyMethod, splitGroups, pairCounts,
        provinceCentroid, deptGeo, contractNoCount, winnerProfile, specificPrior,
        pricesSorted: prices, specificPricesSorted: specificPrices, ebidGapEligible },
      buildRegionalPrice(records, projectAgg));
  }

  /** ฐานเปรียบเทียบพฤติกรรมราคาข้ามพื้นที่ (ใช้โดย R18)
   *
   *  บันทึกการออกแบบ — ตัววัดที่ "ไม่ได้ผล" และเหตุผล:
   *  ตอนแรกออกแบบให้เทียบมัธยฐานของอัตราส่วน (ราคาสัญญา / ราคากลาง) ระหว่างจังหวัด
   *  วัดกับข้อมูลจริงแล้วพบว่าใช้ไม่ได้ เพราะมัธยฐานของแทบทุกจังหวัดติดอยู่ที่ 100% พอดี
   *  (จังหวัดที่สูงสุดสูงกว่าค่ากลางประเทศเพียง 0.43%) สาเหตุคือมีสัญญาจำนวนมาก
   *  ปิดราคาเท่าราคากลางเป๊ะ มัธยฐานจึงถูกตรึงไว้ที่ 1.0 และไม่มีอำนาจแยกแยะเลย
   *
   *  ตัววัดที่ใช้จริงจึงเปลี่ยนเป็น "สัดส่วนสัญญาที่ปิดราคาเท่าราคากลางพอดี"
   *  ซึ่งวัดแล้วกระจายตัวจริงตั้งแต่ 0% ถึง 58.3% ระหว่างจังหวัด (มัธยฐาน 17.1%)
   *  ตีความได้ตรงกว่าด้วย: บอกว่าในพื้นที่นั้น การแข่งขันด้านราคาไม่เกิดผลบ่อยแค่ไหน
   */
  function buildRegionalPrice(records, projectAgg) {
    const REGIONAL_MIN_GROUP = 20;     // ต่ำกว่านี้สัดส่วนแกว่งจนตีความไม่ได้
    const cellStat = new Map();        // "ประเภท|จังหวัด" -> {n, exact}
    const typeStat = new Map();        // "ประเภท" -> {n, exact}

    const bump = (map, key) => {
      let s = map.get(key);
      if (!s) { s = { n: 0, exact: 0 }; map.set(key, s); }
      return s;
    };

    for (const r of records) {
      // ราคากลางเป็นค่าระดับโครงการ จึงเทียบกับยอดรวมสัญญาของโครงการ (ตรงกับ R13/R18)
      const pa = projectAgg.get(r.project_id);
      const base = r.price_build;
      if (!pa || pa.missing || !(pa.sum > 0) || base === null || base === undefined || base <= 0) continue;
      const ratio = pa.sum / base;
      if (!Number.isFinite(ratio) || ratio <= 0 || ratio > 3) continue;

      const type = r.project_type_name || '-';
      const isExact = Math.abs(ratio - 1) < 1e-6;

      const c = bump(cellStat, type + KEY_SEP + (r.province || '-'));
      c.n++; if (isExact) c.exact++;
      const t = bump(typeStat, type);
      t.n++; if (isExact) t.exact++;
    }

    const nationalExact = new Map();
    for (const [type, s] of typeStat) {
      if (s.n < REGIONAL_MIN_GROUP) continue;
      nationalExact.set(type, s.exact / s.n);
    }

    /* เดิมตัดพื้นที่ที่มีน้อยกว่า 20 สัญญาทิ้งทั้งหมด แล้วใช้สัดส่วนดิบของพื้นที่ที่เหลือ
       ตอนนี้ประมาณ prior แยกตามประเภทงานจากทุกจังหวัด แล้วใช้ posterior แทนสัดส่วนดิบ
       พื้นที่ข้อมูลน้อยจึงเทียบได้โดยไม่ถูกติดธงเพราะความบังเอิญ และเกณฑ์ 20 สัญญาไม่จำเป็นอีก */
    const cellsByType = new Map();
    for (const [cell, s] of cellStat) {
      const type = cell.split(KEY_SEP)[0];
      if (!cellsByType.has(type)) cellsByType.set(type, []);
      cellsByType.get(type).push([cell, s]);
    }
    const regionalPrior = new Map();
    const regionalExact = new Map();
    for (const [type, cells] of cellsByType) {
      const nat = nationalExact.get(type);
      if (nat === undefined || cells.length < 5) continue;
      const prior = U.fitBetaPrior(cells.map(([, s]) => s.exact), cells.map(([, s]) => s.n));
      regionalPrior.set(type, prior);
      for (const [cell, s] of cells) {
        const post = U.betaPosterior(prior, s.exact, s.n);
        const share = s.exact / s.n;
        regionalExact.set(cell, {
          share, national: nat, n: s.n, exact: s.exact,
          gapPts: (share - nat) * 100,
          postA: post.a, postB: post.b, postMean: post.mean,
        });
      }
    }
    return { regionalExact, nationalExact, regionalPrior, REGIONAL_MIN_GROUP };
  }

  /* ---------------------------------------------------------------
     ประเมินผล
     --------------------------------------------------------------- */

  /** กฎนี้ใช้กับชุดข้อมูลที่เปิดอยู่ได้ไหม — กฎที่ไม่มี applicable() ใช้ได้เสมอ
   *  ถ้าไม่ได้ evaluate() จะข้ามทั้งกฎ และตารางกฎแสดงเหตุผลแทนจำนวน 0 */
  function applicability(def, ctx, thresholds) {
    if (!def.applicable || !ctx) return { ok: true };
    try { return def.applicable(ctx, thresholds) || { ok: true }; }
    catch (e) { return { ok: true }; }
  }

  /** คะแนนจากรายการ hit — นิยามเดียวที่ทั้งแอปใช้ (evaluate, what-if, F2, RuleLab)
   *  - กฎ scored:false (คุณภาพข้อมูล) ไม่บวกคะแนน
   *  - กฎ source ไม่ใช่ 'real' นับเฉพาะเมื่อ includeSynthetic (risk_score_all)
   *  - กฎใน family เดียวกันวัดเรื่องเดียวกัน จึงนับเฉพาะน้ำหนักสูงสุดข้อเดียว (เท่ากันเอาข้อที่มาก่อน)
   *  exclude  = rule_id ที่ไม่ต้องนับ · override = { rule_id: น้ำหนัก } ใช้แทน/เพิ่ม hit, null = ถือว่าไม่ติด
   *  คืน { score (ตัดที่ 100), counted: Set ของ rule_id ที่ถูกนับ, winner: Map family -> rule_id } */
  function scoreHits(hits, { exclude = null, override = null, includeSynthetic = false } = {}) {
    const ex = exclude ? new Set(exclude) : null;
    const items = [];
    for (const h of hits || []) {
      if (override && Object.prototype.hasOwnProperty.call(override, h.rule_id)) continue;
      items.push({ id: h.rule_id, w: h.rawWeight ?? h.weight, family: h.family || h.rule_id,
        scored: h.scored !== false, source: h.source });
    }
    if (override) {
      for (const [id, w] of Object.entries(override)) {
        if (w === null || w === undefined) continue;
        const def = BY_ID.get(id) || {};
        items.push({ id, w, family: def.family || id, scored: def.scored !== false, source: def.source || 'real' });
      }
    }
    const best = new Map();
    for (const it of items) {
      if (ex && ex.has(it.id)) continue;
      if (!it.scored) continue;
      if (it.source !== 'real' && !includeSynthetic) continue;
      const cur = best.get(it.family);
      if (!cur || it.w > cur.w) best.set(it.family, it);
    }
    let s = 0;
    const counted = new Set(), winner = new Map();
    for (const [fam, it] of best) { s += it.w; counted.add(it.id); winner.set(fam, it.id); }
    return { score: Math.min(100, s), counted, winner };
  }

  /** เขียนผลลงในตัว record โดยตรง เพื่อไม่ต้องคัดลอกอาเรย์ทั้งชุดทุกครั้งที่ปรับ threshold
   *  h.weight = น้ำหนักที่นับเข้า risk_score จริง (0 ถ้าไม่นับ) · h.rawWeight = น้ำหนักที่ตั้งไว้
   *  ผลรวม h.weight ของ hit ข้อมูลจริง = risk_score เสมอ (ก่อนตัดที่ 100) */
  function evaluate(records, ctx, settings) {
    const active = DEFS.filter(d => settings[d.id]?.enabled !== false
      && applicability(d, ctx, settings[d.id].thresholds).ok);

    for (const r of records) {
      const hits = [];

      for (const def of active) {
        const cfg = settings[def.id];
        const t = cfg.thresholds;
        let res;
        try {
          res = def.evaluate(r, ctx, t);
        } catch (e) {
          res = null;   // rule เดียวพังต้องไม่ทำให้ทั้งหน้าพัง
        }
        if (!res) continue;

        const weight = Number.isFinite(cfg.weight) ? cfg.weight : def.weight;
        hits.push({
          rule_id: def.id, rule_name: def.name, severity: def.severity,
          source: def.source, category: def.category, weight, rawWeight: weight,
          family: def.family || null, scored: def.scored !== false,
          actual: res.actual, logic: def.logic(t),
        });
      }

      const real = scoreHits(hits);
      const all = scoreHits(hits, { includeSynthetic: true });
      let sevReal = 'none', sevAll = 'none';
      for (const h of hits) {
        if (h.source === 'real') {
          h.counted = real.counted.has(h.rule_id);
          h.weight = h.counted ? h.rawWeight : 0;
          if (!h.scored) h.notCounted = 'quality';
          else if (!h.counted) { h.notCounted = 'family'; h.coveredBy = real.winner.get(h.family); }
        } else {
          h.counted = false;   // สาธิต: คงน้ำหนักเดิมไว้แสดง ทุกที่ที่รวมคะแนนกรอง source อยู่แล้ว
        }
        // ระดับสูงสุดไม่นับกฎคุณภาพข้อมูล เพราะเป็นความผิดพลาดของการบันทึก ไม่ใช่ความเสี่ยงของสัญญา
        if (!h.scored) continue;
        if (SEVERITY_ORDER[h.severity] > SEVERITY_ORDER[sevAll]) sevAll = h.severity;
        if (h.source === 'real' && SEVERITY_ORDER[h.severity] > SEVERITY_ORDER[sevReal]) sevReal = h.severity;
      }

      r.rule_hits = hits;
      r.risk_score = real.score;
      r.risk_score_all = all.score;
      r.max_severity = sevReal;
      r.max_severity_all = sevAll;
      r.risk_band = band(r.risk_score).key;
    }

    return records;
  }

  /** สรุปจำนวน hit ต่อ rule — ใช้ในแผงตั้งค่าและ KPI */
  function summarize(records) {
    const counts = new Map(DEFS.map(d => [d.id, { n: 0, value: 0 }]));
    let flagged = 0, flaggedValue = 0;
    const bandCounts = Object.fromEntries(BANDS.map(b => [b.key, 0]));

    for (const r of records) {
      const hits = r.rule_hits || [];
      if (hits.length) { flagged++; flaggedValue += r.contract_price_agree || 0; }
      bandCounts[r.risk_band] = (bandCounts[r.risk_band] || 0) + 1;
      for (const h of hits) {
        const c = counts.get(h.rule_id);
        if (c) { c.n++; c.value += r.contract_price_agree || 0; }
      }
    }
    return { counts, flagged, flaggedValue, bandCounts, total: records.length };
  }

  /* ---------------------------------------------------------------
     กฎที่ผู้ใช้สร้างเอง (จากห้องทดลองกฎในแท็บ AI)
     เพิ่มเข้า DEFS ตัวเดิม ทุกส่วนที่วนผ่าน DEFS (ตารางกฎ แผงตั้งค่า สรุปผล) จึงเห็นกฎใหม่ทันที
     ต้องลงทะเบียนก่อน loadSettings() เพื่อให้ค่าเปิด/ปิดและน้ำหนักที่ผู้ใช้ปรับไว้ถูกอ่านกลับมา
     --------------------------------------------------------------- */
  function addCustomRule(def, settings) {
    removeCustomRule(def.id);
    DEFS.push(def);
    BY_ID.set(def.id, def);
    if (settings && !settings[def.id]) settings[def.id] = { enabled: true, weight: def.weight, thresholds: {} };
  }

  function removeCustomRule(id, settings) {
    const i = DEFS.findIndex(d => d.id === id && d.custom);
    if (i < 0) return false;
    DEFS.splice(i, 1);
    BY_ID.delete(id);
    if (settings) delete settings[id];
    return true;
  }

  return {
    addCustomRule, removeCustomRule,
    DEFS, BY_ID, DOCS, BANDS, SEVERITY_ORDER,
    DIMENSIONS, STAGES, FRAMEWORK, framework, coverage,
    band, buildContext, evaluate, summarize, scoreHits, applicability,
    defaultSettings, loadSettings, saveSettings, resetSettings,
    SPECIFIC_METHOD,
  };
})();
