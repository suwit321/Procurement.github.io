/* rules.js — เครื่องมือประเมินความเสี่ยง R1-R22

   เดิม rule ทั้งหมดถูกคำนวณล่วงหน้าใน data.json โดยสคริปต์ที่หายไป ทำให้ปรับเงื่อนไขไม่ได้
   และ 5 rule ไม่เคยทำงานเพราะข้อมูลนำเข้า parse ผิด ตอนนี้ย้ายมาคำนวณในเบราว์เซอร์
   จึงปรับ threshold/น้ำหนักได้สดและเห็นผลทันที

   หลักการสำคัญ: คะแนนจริงกับคะแนนสาธิตแยกกันเด็ดขาด
     risk_score       = เฉพาะ rule ที่ใช้ข้อมูลจริง (ค่าเริ่มต้นที่แสดง)
     risk_score_all   = รวม rule สาธิต (R5/R6) ไว้เปรียบเทียบเท่านั้น
*/
'use strict';

const Rules = (() => {

  const SPECIFIC_METHOD = 'เฉพาะเจาะจง';
  /* วงเงินที่วิธีเฉพาะเจาะจงใช้ได้โดยทั่วไป — เหนือกว่านี้ควรเปิดให้แข่งขัน
     ในข้อมูลนี้ 97.6% ของสัญญา 1-5 แสนใช้วิธีเฉพาะเจาะจง แต่เหนือ 5 แสนใช้เพียง 5.9%
     การนับรวมทุกขนาดจึงวัด "หน่วยงานนี้มีงานเล็ก" แทนที่จะวัด "หลีกเลี่ยงการแข่งขัน" */
  const DISCRETIONARY_CEILING = 500000;
  const STORAGE_KEY = 'pa.ruleSettings.v1';

  /* ---------------------------------------------------------------
     นิยาม rule
     - thresholds: ปรับได้จาก UI
     - evaluate(): คืน null ถ้าไม่เข้าเงื่อนไข หรือ {actual} ถ้าเข้า
     --------------------------------------------------------------- */
  const DEFS = [
    {
      id: 'R1', name: 'ส่วนลดเทียบวงเงินโครงการสูงผิดปกติ',
      severity: 'medium', weight: 15, category: 'ราคา', source: 'real',
      desc: 'ส่วนลดจากวงเงินโครงการมากผิดปกติ อาจสะท้อนการตั้งวงเงินสูงเกินจริง หรือการเสนอราคาต่ำเพื่อให้ได้งาน',
      thresholds: { pct: { value: 0.30, min: 0.05, max: 0.90, step: 0.05, label: 'ส่วนลดขั้นต่ำ', format: 'pct' } },
      logic: t => `(project_money - contract_price_agree) / project_money >= ${t.pct}`,
      evaluate(r, ctx, t) {
        if (!r.project_money || r.contract_price_agree === null) return null;
        const d = (r.project_money - r.contract_price_agree) / r.project_money;
        return d >= t.pct ? { actual: U.pct(d) } : null;
      }
    },
    {
      id: 'R2', name: 'ส่วนลดเทียบราคากลางสูงผิดปกติ',
      severity: 'medium', weight: 15, category: 'ราคา', source: 'real',
      desc: 'ราคาสัญญาต่ำกว่าราคากลางมาก อาจบ่งชี้ราคากลางที่ตั้งไว้ไม่สมเหตุสมผล',
      thresholds: { pct: { value: 0.30, min: 0.05, max: 0.90, step: 0.05, label: 'ส่วนลดขั้นต่ำ', format: 'pct' } },
      logic: t => `(price_build - contract_price_agree) / price_build >= ${t.pct}`,
      evaluate(r, ctx, t) {
        if (!r.price_build || r.contract_price_agree === null) return null;
        const d = (r.price_build - r.contract_price_agree) / r.price_build;
        return d >= t.pct ? { actual: U.pct(d) } : null;
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
      desc: 'ราคาสัญญาสูงกว่าวงเงินที่ได้รับอนุมัติ เป็นความผิดปกติที่ต้องมีเอกสารอธิบาย',
      thresholds: { ratio: { value: 1.0, min: 1.0, max: 2.0, step: 0.05, label: 'อัตราส่วนขั้นต่ำ' } },
      logic: t => `contract_price_agree / project_money > ${t.ratio}`,
      evaluate(r, ctx, t) {
        if (!r.project_money || r.contract_price_agree === null) return null;
        const ratio = r.contract_price_agree / r.project_money;
        return ratio > t.ratio ? { actual: `${ratio.toFixed(4)} เท่า` } : null;
      }
    },
    {
      id: 'R5', name: 'ผู้เสนอราคารายเดียว',
      severity: 'high', weight: 20, category: 'การแข่งขัน', source: 'synthetic',
      desc: 'ชุดข้อมูลจริงไม่มีจำนวนผู้เสนอราคา ตัวเลขนี้สังเคราะห์ขึ้นเพื่อสาธิตแนวคิดเท่านั้น',
      thresholds: { max: { value: 1, min: 1, max: 5, step: 1, label: 'จำนวนรายสูงสุด' } },
      logic: t => `demo_n_bidders <= ${t.max}   [ข้อมูลสาธิต]`,
      evaluate(r, ctx, t) {
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
      desc: 'ราคาลงท้ายด้วยศูนย์หลายตัว เป็นสัญญาณอ่อน พบมากในชุดข้อมูล จึงให้น้ำหนักต่ำ',
      thresholds: {
        zeros: { value: 3, min: 2, max: 6, step: 1, label: 'จำนวนศูนย์ท้าย' },
        minValue: { value: 100000, min: 10000, max: 5000000, step: 10000, label: 'มูลค่าขั้นต่ำ' }
      },
      logic: t => `contract_price_agree >= ${t.minValue} และลงท้ายด้วยศูนย์ ${t.zeros} ตัว`,
      evaluate(r, ctx, t) {
        const v = r.contract_price_agree;
        if (v === null || v < t.minValue) return null;
        const mod = 10 ** t.zeros;
        return v % mod === 0 ? { actual: U.num(v, 0) } : null;
      }
    },
    {
      id: 'R10', name: 'สงสัยการแบ่งซื้อแบ่งจ้าง',
      severity: 'critical', weight: 25, category: 'โครงสร้างสัญญา', source: 'real',
      desc: 'หน่วยงานและผู้รับจ้างคู่เดิมทำสัญญาหลายฉบับในวันเดียวกัน แต่ละฉบับต่ำกว่าเพดาน ' +
        'แต่ยอดรวมสูง เป็นรูปแบบการเลี่ยงวิธีจัดหาที่เข้มงวดกว่า',
      thresholds: {
        maxEach: { value: 500000, min: 100000, max: 5000000, step: 50000, label: 'เพดานต่อสัญญา' },
        minTotal: { value: 400000, min: 100000, max: 10000000, step: 50000, label: 'ยอดรวมขั้นต่ำ' },
        minCount: { value: 2, min: 2, max: 10, step: 1, label: 'จำนวนสัญญาขั้นต่ำ' }
      },
      logic: t => `หน่วยงาน+ผู้รับจ้าง+วันทำสัญญาเดียวกัน >= ${t.minCount} สัญญา, ` +
        `แต่ละฉบับ < ${t.maxEach}, รวม >= ${t.minTotal}`,
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
      severity: 'high', weight: 15, category: 'เอกสาร/ข้อมูล', source: 'real',
      desc: 'ความผิดพลาดของข้อมูลวันที่ ควรตรวจสอบเอกสารต้นฉบับ',
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
      severity: 'medium', weight: 15, category: 'การแข่งขัน', source: 'real',
      desc: 'ไม่มีส่วนลดจากราคากลางเลย สะท้อนการไม่มีแรงกดดันด้านการแข่งขัน',
      thresholds: { minRatio: { value: 1.0, min: 0.95, max: 1.0, step: 0.005, label: 'อัตราส่วนขั้นต่ำ' } },
      logic: t => `contract_price_agree / price_build >= ${t.minRatio}`,
      evaluate(r, ctx, t) {
        if (!r.price_build || r.contract_price_agree === null) return null;
        const ratio = r.contract_price_agree / r.price_build;
        return ratio >= t.minRatio ? { actual: `${(ratio * 100).toFixed(2)}% ของราคากลาง` } : null;
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
      severity: 'medium', weight: 15, category: 'การแข่งขัน', source: 'real',
      desc: 'ผู้รับจ้างรายเดิมได้งานจากหน่วยงานเดิมซ้ำหลายครั้ง ควรตรวจความสม่ำเสมอของการแข่งขัน',
      thresholds: { minPair: { value: 5, min: 2, max: 60, step: 1, label: 'จำนวนสัญญาขั้นต่ำต่อคู่' } },
      logic: t => `จำนวนสัญญาของคู่หน่วยงาน-ผู้รับจ้าง >= ${t.minPair}`,
      evaluate(r, ctx, t) {
        const n = ctx.pairCounts.get(r.dept_key + KEY_SEP + r.winner_key) || 0;
        return n >= t.minPair ? { actual: `${n} สัญญากับหน่วยงานเดียวกัน` } : null;
      }
    },
    {
      id: 'R16', name: 'ช่วงเวลาประกาศถึงทำสัญญาสั้น',
      severity: 'high', weight: 20, category: 'การแข่งขัน', source: 'real',
      desc: 'ใช้วันประกาศจริงจากชุดข้อมูล (มีเฉพาะรายการที่ประกาศเชิญชวน/คัดเลือก) ' +
        'ช่วงเวลาที่สั้นเกินไปจำกัดโอกาสของผู้เสนอราคารายอื่น',
      thresholds: { maxDays: { value: 15, min: 1, max: 90, step: 1, label: 'จำนวนวันสูงสุด' } },
      logic: t => `announce_gap_days <= ${t.maxDays}`,
      evaluate(r, ctx, t) {
        if (r.announce_gap_days === null) return null;
        return r.announce_gap_days <= t.maxDays
          ? { actual: `${r.announce_gap_days} วัน` } : null;
      }
    },
    {
      id: 'R17', name: 'พิกัดโครงการห่างจากพื้นที่ปกติของจังหวัด',
      severity: 'medium', weight: 10, category: 'ภูมิศาสตร์', source: 'real',
      desc: 'พิกัดโครงการอยู่ไกลจากศูนย์กลางพื้นที่ของจังหวัดที่หน่วยงานสังกัด ' +
        'หมายเหตุ: จังหวัดในข้อมูลระบุที่ตั้งหน่วยงาน ไม่ใช่ที่ตั้งโครงการ จึงเป็นสัญญาณให้ตรวจสอบ ไม่ใช่ข้อสรุป',
      thresholds: { maxKm: { value: 200, min: 50, max: 800, step: 25, label: 'ระยะทางสูงสุด (กม.)' } },
      logic: t => `ระยะจากศูนย์กลางจังหวัด > ${t.maxKm} กม.`,
      evaluate(r, ctx, t) {
        if (r.lat === null || r.lon === null) return null;
        // พิกัดที่ถูกใช้ซ้ำหลายโครงการคือพิกัดสำนักงาน ระยะที่คำนวณได้จึงไม่มีความหมาย
        if (r.geo_quality === 'shared') return null;
        const c = ctx.provinceCentroid.get(r.province);
        if (!c) return null;
        const km = U.haversine(r.lat, r.lon, c.lat, c.lon);
        return km > t.maxKm ? { actual: `${km.toFixed(0)} กม. จาก ${r.province}` } : null;
      }
    },
    {
      id: 'R18', name: 'อยู่ในพื้นที่ที่ปิดราคาเท่าราคากลางบ่อยผิดปกติ',
      severity: 'medium', weight: 12, category: 'ราคา', source: 'real',
      desc: 'สัญญานี้ปิดราคาเท่าราคากลางพอดี และอยู่ในพื้นที่ที่รูปแบบนี้เกิดบ่อยกว่าค่ากลางของประเทศมาก ' +
        'ในงานประเภทเดียวกัน · การไม่มีส่วนลดเลยเป็นครั้งคราวเกิดขึ้นได้ แต่ถ้าเกิดเป็นระบบทั้งพื้นที่ ' +
        'แปลว่าการแข่งขันด้านราคาแทบไม่ทำงานในพื้นที่นั้น · ใช้คู่กับ R13 ซึ่งจับที่ตัวสัญญาอย่างเดียว',
      thresholds: {
        minGapPts: { value: 15, min: 3, max: 50, step: 1, label: 'สูงกว่าค่ากลางประเทศ (จุด %)' },
        confidence: { value: 0.90, min: 0.50, max: 0.99, step: 0.01, label: 'ความมั่นใจขั้นต่ำ', format: 'pct' },
      },
      logic: t => `สัญญานี้ ราคา = ราคากลางพอดี และ P(สัดส่วนจริงของพื้นที่ >= ค่ากลางประเทศ + ${t.minGapPts} จุด %) ` +
        `>= ${t.confidence} ตาม Beta posterior ที่ประมาณ prior แยกรายประเภทงาน`,
      evaluate(r, ctx, t) {
        const price = r.contract_price_agree, base = r.price_build;
        if (price === null || base === null || base <= 0 || price <= 0) return null;
        // ต้องเป็นสัญญาที่ปิดราคาเท่าราคากลางพอดีเท่านั้น
        if (Math.abs(price / base - 1) >= 1e-6) return null;

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
      severity: 'high', weight: 20, category: 'เอกสาร/ข้อมูล', source: 'real',
      desc: 'เลขที่สัญญาเป็นเลขรันรายปีของแต่ละหน่วยงาน การซ้ำข้ามหน่วยงานเป็นเรื่องปกติ ' +
        'แต่การซ้ำภายในหน่วยงานเดียวกันไม่ควรเกิด อาจเป็นการบันทึกซ้ำ หรือการออกเลขซ้ำ ' +
        'ซึ่งกระทบการอ้างอิงเอกสารและการตรวจสอบย้อนกลับ',
      thresholds: { min: { value: 2, min: 2, max: 10, step: 1, label: 'จำนวนครั้งขั้นต่ำ' } },
      logic: t => `เลขที่สัญญาเดียวกันในหน่วยงานเดียวกัน >= ${t.min} ครั้ง`,
      evaluate(r, ctx, t) {
        if (!r.contract_no || !r.dept_key) return null;
        const n = ctx.contractNoCount.get(r.dept_key + KEY_SEP + r.contract_no) || 0;
        return n >= t.min ? { actual: `เลขที่ ${r.contract_no} ปรากฏ ${n} ครั้งในหน่วยงานนี้` } : null;
      }
    },
    {
      id: 'R21', name: 'ยอดรวมกับราคาสัญญาไม่สอดคล้องกัน',
      severity: 'medium', weight: 12, category: 'ราคา', source: 'real',
      desc: 'ช่องยอดรวมกับช่องราคาสัญญาต่างกันมากผิดปกติ อาจเป็นเพราะช่องหนึ่งเก็บยอดรวมทั้งโครงการ ' +
        'ส่วนอีกช่องเก็บเฉพาะสัญญาฉบับนี้ หรือเป็นความคลาดเคลื่อนของข้อมูล ' +
        'ต้องตรวจว่าตัวเลขใดคือมูลค่าที่ผูกพันจริงก่อนนำไปใช้อ้างอิง',
      thresholds: {
        ratio: { value: 1.5, min: 1.05, max: 20, step: 0.05, label: 'อัตราส่วนต่างขั้นต่ำ (เท่า)' },
      },
      logic: t => `max(sum_price_agree, contract_price_agree) / min(...) >= ${t.ratio}`,
      evaluate(r, ctx, t) {
        const a = r.sum_price_agree, b = r.contract_price_agree;
        if (a === null || b === null || a <= 0 || b <= 0) return null;
        const ratio = Math.max(a, b) / Math.min(a, b);
        if (ratio < t.ratio) return null;
        return { actual: `ยอดรวม ${U.num(a, 0)} เทียบราคาสัญญา ${U.num(b, 0)} (ต่างกัน ${ratio.toFixed(1)} เท่า)` };
      }
    },
    {
      id: 'R22', name: 'ผู้รับจ้างรับงานจากหน่วยงานเดียวล้วน',
      severity: 'medium', weight: 12, category: 'ผู้รับจ้าง', source: 'real',
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
  ];

  const BY_ID = new Map(DEFS.map(d => [d.id, d]));

  /* ---------------------------------------------------------------
     ชั้นเอกสารกำกับกฎ — ใช้สร้างตารางอ้างอิงในแท็บ "กฎและการตั้งค่า"

     fields = คอลัมน์ในชุดข้อมูลต้นทางที่กฎนี้ใช้จริง
     basis  = เหตุผลที่ตั้งกฎ และหลักฐานที่พบในชุดข้อมูลนี้ถ้ามี
              ระบุเฉพาะสิ่งที่ตรวจสอบย้อนกลับได้จากข้อมูล ไม่อ้างอิงเอกสารที่ยืนยันไม่ได้
     --------------------------------------------------------------- */
  const DOCS = {
    R1: {
      fields: ['project_money', 'contract_price_agree'],
      basis: 'ส่วนลดที่มากผิดปกติสะท้อนได้ทั้งการตั้งวงเงินสูงเกินจริงและการเสนอราคาต่ำเพื่อให้ได้งาน ' +
        'ทั้งสองกรณีต้องมีเอกสารอธิบาย พบ 711 สัญญาในชุดข้อมูลนี้',
    },
    R2: {
      fields: ['price_build', 'contract_price_agree'],
      basis: 'ราคากลางคือราคาที่หน่วยงานประเมินว่าสมเหตุสมผล การต่ำกว่ามากจึงชี้ว่าราคากลาง ' +
        'อาจตั้งไว้ไม่เหมาะสม พบ 610 สัญญา',
    },
    R3: {
      fields: ['project_id'],
      basis: 'โครงการเดียวที่แยกทำสัญญาหลายฉบับอาจมีเหตุผลรองรับ แต่ก็เป็นวิธีเลี่ยงวงเงิน ' +
        'ที่ต้องใช้วิธีจัดหาเข้มงวดกว่าได้เช่นกัน พบ 225 สัญญาใน 51 โครงการ',
    },
    R4: {
      fields: ['contract_price_agree', 'project_money'],
      basis: 'ราคาสัญญาไม่ควรเกินวงเงินที่ได้รับอนุมัติ การเกินจึงเป็นความผิดปกติเชิงงบประมาณ ' +
        'ที่ต้องอธิบายได้ พบ 27 สัญญา',
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
      basis: 'เลขภาษีกับชื่อควรสอดคล้องกันแบบหนึ่งต่อหนึ่ง ความไม่สอดคล้องอาจชี้ถึงนิติบุคคล ' +
        'ที่ใช้ตัวตนซ้อนกัน ตรวจหลังทำชื่อเป็นมาตรฐานและตัดเลขภาษีที่ถูกปิดบัง 2,205 แถวออกแล้ว ' +
        'จำนวนที่พบจึงลดจาก 460 เหลือ 155 เพราะส่วนต่างเป็นผลจากรูปแบบการพิมพ์ ไม่ใช่ความผิดปกติจริง',
    },
    R8: {
      fields: ['dept_name', 'purchase_method_name', 'project_money'],
      basis: 'เวอร์ชันเดิมนับสัดส่วนวิธีเฉพาะเจาะจงจากทุกสัญญา แล้วติดธงหน่วยงานที่เกิน 95% ' +
        'ผลคือติดธง 180 หน่วยงาน 1,320 สัญญา แต่ตรวจแล้วเกือบทั้งหมดเป็นหน่วยงานที่มีแต่งานเล็ก ' +
        'เพราะในข้อมูลนี้ 97.6% ของสัญญา 1-5 แสนบาทใช้วิธีเฉพาะเจาะจงตามที่ระเบียบเปิดให้ทำได้ ' +
        'ขณะที่งานเกิน 5 แสนใช้วิธีนี้เพียง 5.9% จึงเปลี่ยนมานับเฉพาะงานเกิน 5 แสน ' +
        'และเนื่องจาก 705 จาก 728 หน่วยงานมีงานระดับนี้เพียง 1-4 ฉบับ จึงใช้ Empirical Bayes ' +
        '(prior แบบ Beta ประมาณจากทุกหน่วยงาน) แทนการตัดด้วยจำนวนขั้นต่ำ ' +
        'หน่วยงานที่มี 2 จาก 2 ฉบับจะได้ค่าปรับแล้วราว 38% ไม่ใช่ 100% · ' +
        'หน่วยนับเป็นโครงการ ไม่ใช่สัญญา เพราะพบว่าหน่วยงานเดียวที่เหลืออยู่หลังแก้สองข้อแรก ' +
        'เกิดจากโครงการจ้างเหมาบุคคล 43 อัตราที่ออกสัญญารายคน ขณะที่โครงการอื่นทั้ง 7 โครงการใช้ e-bidding · ' +
        'ผลปัจจุบัน: 67 จาก 2,354 โครงการ (2.8%) ไม่พบหน่วยงานใดสูงกว่าที่ความบังเอิญอธิบายได้ ' +
        'ยืนยันแยกด้วยวิธีที่ไม่ใช้ prior: ทดสอบความต่างระหว่างหน่วยงาน chi-square p = 0.19 ' +
        'และ exact binomial รายหน่วยงานหลังคุม false discovery rate ติดธง 0 หน่วยงาน ' +
        'กฎจึงไม่ติดธงสัญญาใด ซึ่งเป็นคำตอบที่ถูกต้องสำหรับข้อมูลชุดนี้ ไม่ใช่กฎเสีย',
    },
    R9: {
      fields: ['contract_price_agree'],
      basis: 'ราคาที่ลงท้ายด้วยศูนย์หลายตัวอาจมาจากการกำหนดตัวเลขแทนการคำนวณต้นทุนจริง ' +
        'แต่เป็นสัญญาณอ่อนเพราะพบถึง 5,646 สัญญา จึงตั้งน้ำหนักไว้ต่ำสุดเพียง 5 คะแนน',
    },
    R10: {
      fields: ['dept_name', 'winner_name', 'contract_date', 'contract_price_agree'],
      basis: 'การแตกงานเป็นหลายสัญญาย่อยในวันเดียวกันกับคู่สัญญาเดิม โดยแต่ละฉบับต่ำกว่าเพดาน ' +
        'แต่ยอดรวมสูง เป็นรูปแบบการเลี่ยงวิธีจัดหาที่เข้มงวดกว่า พบ 441 กลุ่ม ครอบคลุม 1,025 สัญญา',
    },
    R11: {
      fields: ['contract_date', 'contract_finish_date'],
      basis: 'วันสิ้นสุดก่อนวันเริ่มเป็นไปไม่ได้ในทางปฏิบัติ จึงเป็นความผิดพลาดของข้อมูล ' +
        'ที่ควรตรวจกับเอกสารต้นฉบับ พบ 10 สัญญา',
    },
    R12: {
      fields: ['purchase_method_name', 'contract_price_agree'],
      basis: 'หลักฐานจากชุดข้อมูลนี้โดยตรง: ช่วงราคา 450,000-500,000 บาท มี 1,789 สัญญา ' +
        'ขณะที่ช่วง 500,000-550,000 มีเพียง 119 สัญญา ต่างกัน 15 เท่า ' +
        'การกระจายราคาตามธรรมชาติไม่ทำให้เกิดหน้าผาแบบนี้ที่เพดานพอดี ' +
        'จึงเป็นสัญญาณเชิงประจักษ์ที่หนักแน่นที่สุดในชุดข้อมูล',
    },
    R13: {
      fields: ['contract_price_agree', 'price_build'],
      basis: 'การไม่มีส่วนลดจากราคากลางเลยแสดงว่าไม่มีแรงกดดันด้านการแข่งขัน ' +
        'พบ 3,264 สัญญาที่ราคาตรงกับราคากลางพอดีทุกบาท คิดเป็น 32.2% ของสัญญาที่มีราคากลาง',
    },
    R14: {
      fields: ['price_build', 'project_money'],
      basis: 'ราคากลางควรมาจากการประมาณต้นทุนอย่างอิสระ การตั้งให้เท่าวงเงินที่ได้รับพอดี ' +
        'สะท้อนว่าไม่ได้ประมาณราคาแยกต่างหาก พบ 4,759 สัญญา คิดเป็น 46.8%',
    },
    R15: {
      fields: ['dept_name', 'winner_name'],
      basis: 'ผู้รับจ้างรายเดิมที่ได้งานจากหน่วยงานเดิมซ้ำหลายครั้งอาจมาจากความเชี่ยวชาญเฉพาะ ' +
        'หรือจากการแข่งขันที่ไม่สม่ำเสมอ ต้องดูประกอบกับวิธีจัดหา พบ 254 คู่ที่มีสัญญาตั้งแต่ 5 ฉบับ สูงสุด 52 ฉบับ',
    },
    R16: {
      fields: ['announce_date', 'contract_date'],
      basis: 'ช่วงเวลาระหว่างประกาศกับทำสัญญาที่สั้นเกินไปจำกัดโอกาสของผู้เสนอราคารายอื่น ' +
        'ใช้วันประกาศจริงจากชุดข้อมูล ซึ่งมีเฉพาะ 1,910 รายการที่ประกาศเชิญชวนหรือคัดเลือก ' +
        'เป็นกฎที่ใช้ข้อมูลจริงมาแทน R6 ที่เป็นข้อมูลสาธิต',
    },
    R17: {
      fields: ['project_location', 'province'],
      basis: 'คอลัมน์จังหวัดระบุที่ตั้งหน่วยงาน ส่วนพิกัดระบุที่ตั้งโครงการ ระยะห่างมากจึงหมายถึง ' +
        'หน่วยงานจัดหาไกลจากพื้นที่ตนเอง ซึ่งอาจมีเหตุผลรองรับ เป็นสัญญาณให้ตรวจสอบ ไม่ใช่ข้อสรุป ' +
        'ศูนย์กลางจังหวัดคำนวณจากมัธยฐานพิกัดของสัญญาในจังหวัดนั้น',
    },
    R18: {
      fields: ['contract_price_agree', 'price_build', 'project_type_name', 'province'],
      basis: 'ทดสอบกับข้อมูลจริงแล้วพบว่า การเทียบ "ระดับราคา" ข้ามจังหวัดใช้ไม่ได้ ' +
        'เพราะมัธยฐานของอัตราส่วนราคาต่อราคากลางติดอยู่ที่ 100% แทบทุกจังหวัด ' +
        '(จังหวัดที่สูงสุดต่างจากค่ากลางประเทศเพียง 0.43%) จึงเปลี่ยนมาวัด ' +
        '"สัดส่วนสัญญาที่ปิดราคาเท่าราคากลางพอดี" ซึ่งกระจายตัวจริงตั้งแต่ 0% ถึง 58.3% ' +
        'ระหว่างจังหวัด (มัธยฐาน 17.1% จาก 68 จังหวัดที่มีงานก่อสร้างตั้งแต่ 20 สัญญา) ' +
        'ข้อจำกัด: ราคากลางเป็นค่าที่หน่วยงานประเมินเอง กฎนี้จึงบอกได้ว่าการแข่งขันด้านราคา ' +
        'ไม่เกิดผลบ่อยแค่ไหนในพื้นที่ แต่บอกไม่ได้ว่าราคานั้นแพงเกินจริงหรือไม่ · ' +
        'ปรับปรุง: เดิมใช้สัดส่วนดิบของพื้นที่ที่มีอย่างน้อย 20 สัญญา ตอนนี้ใช้ Empirical Bayes ' +
        'แยก prior รายประเภทงาน แล้วติดธงเมื่อมั่นใจอย่างน้อย 90% ว่าสัดส่วนจริงสูงกว่าค่ากลางประเทศเกินเกณฑ์ ' +
        'พื้นที่ที่เกินเกณฑ์เพียงเล็กน้อยจากความบังเอิญของตัวอย่างจึงไม่ถูกติดธงอีก',
    },
    R19: {
      fields: ['contract_date'],
      basis: 'ชุดข้อมูลนี้มีสัญญาลงนามวันเสาร์-อาทิตย์เพียง 22 ฉบับจาก 10,174 (0.22%) ' +
        'รวม 23.7 ล้านบาท ความหายากคือจุดแข็งของกฎนี้ เพราะตรวจครบทุกฉบับได้ในเวลาไม่นาน ' +
        'ข้อจำกัด: ไม่มีปฏิทินวันหยุดราชการในข้อมูล จึงตรวจได้เฉพาะเสาร์-อาทิตย์',
    },
    R20: {
      fields: ['contract_no', 'dept_key'],
      basis: 'เลขที่สัญญาในชุดข้อมูลนี้เป็นเลขรันรายปีของแต่ละหน่วยงาน (1/2569, 2/2569, ...) ' +
        'จึงพบเลขเดียวกันข้ามหน่วยงานถึง 353 กรณีซึ่งเป็นเรื่องปกติ ' +
        'แต่พบซ้ำภายในหน่วยงานเดียวกัน 24 กรณี ซึ่งไม่ควรเกิดและกระทบการอ้างอิงเอกสาร',
    },
    R21: {
      fields: ['sum_price_agree', 'contract_price_agree'],
      basis: 'ช่อง sum_price_agree เป็นฟิลด์ที่ระบบไม่เคยใช้มาก่อน ตรวจแล้วพบ 195 ฉบับ (1.9%) ' +
        'ที่ต่างจากราคาสัญญา โดยมัธยฐานของอัตราส่วนอยู่ที่ 7.4 เท่า ' +
        'ยังไม่ทราบแน่ชัดว่าเป็นยอดรวมทั้งโครงการหรือข้อมูลผิด จึงตั้งเป็นสัญญาณให้ตรวจ ไม่ใช่ข้อสรุป',
    },
    R22: {
      fields: ['winner_key', 'dept_key', 'contract_price_agree'],
      basis: 'จากผู้รับจ้างที่มีสัญญาตั้งแต่ 5 ฉบับ 383 ราย พบว่า 188 ราย (49.1%) ' +
        'รับงานจากหน่วยงานเดียวล้วน · สามอันดับแรกตามมูลค่าล้วนรับงานจากกรมทรัพยากรน้ำบาดาล ' +
        'รายละ 345-470 ล้านบาท · เป็นมุมกลับของ HHI ซึ่งมองจากฝั่งหน่วยงานเท่านั้น',
    },
  };

  /* ตัวคั่นคีย์ ต้องเป็นอักขระที่ไม่ปรากฏในชื่อจริง
     ชื่อหน่วยงานและผู้รับจ้างมีช่องว่างอยู่ในตัวเอง (9,313 จาก 10,174 ระเบียน)
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
    const tinToNames = new Map();
    const nameToTins = new Map();
    const agencyMethod = new Map();
    const splitGroups = new Map();
    const pairCounts = new Map();
    const provincePoints = new Map();

    for (const r of records) {
      projectContracts.set(r.project_id, (projectContracts.get(r.project_id) || 0) + 1);

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
        if (!g) { g = { rows: [], total: 0 }; splitGroups.set(k, g); }
        g.rows.push(r);
        g.total += r.contract_price_agree || 0;
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
      { projectContracts, tinToNames, nameToTins, agencyMethod, splitGroups, pairCounts,
        provinceCentroid, contractNoCount, winnerProfile, specificPrior },
      buildRegionalPrice(records));
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
  function buildRegionalPrice(records) {
    const REGIONAL_MIN_GROUP = 20;     // ต่ำกว่านี้สัดส่วนแกว่งจนตีความไม่ได้
    const cellStat = new Map();        // "ประเภท|จังหวัด" -> {n, exact}
    const typeStat = new Map();        // "ประเภท" -> {n, exact}

    const bump = (map, key) => {
      let s = map.get(key);
      if (!s) { s = { n: 0, exact: 0 }; map.set(key, s); }
      return s;
    };

    for (const r of records) {
      const price = r.contract_price_agree, base = r.price_build;
      if (price === null || base === null || base <= 0 || price <= 0) continue;
      const ratio = price / base;
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

  /** เขียนผลลงในตัว record โดยตรง เพื่อไม่ต้องคัดลอกอาเรย์ 10,174 รายการทุกครั้งที่ปรับ threshold */
  function evaluate(records, ctx, settings) {
    const active = DEFS.filter(d => settings[d.id]?.enabled !== false);

    for (const r of records) {
      const hits = [];
      let scoreReal = 0, scoreAll = 0;
      let sevReal = 'none', sevAll = 'none';

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
          source: def.source, category: def.category, weight,
          actual: res.actual, logic: def.logic(t),
        });

        scoreAll += weight;
        if (SEVERITY_ORDER[def.severity] > SEVERITY_ORDER[sevAll]) sevAll = def.severity;
        if (def.source === 'real') {
          scoreReal += weight;
          if (SEVERITY_ORDER[def.severity] > SEVERITY_ORDER[sevReal]) sevReal = def.severity;
        }
      }

      r.rule_hits = hits;
      r.risk_score = Math.min(100, scoreReal);
      r.risk_score_all = Math.min(100, scoreAll);
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
    band, buildContext, evaluate, summarize,
    defaultSettings, loadSettings, saveSettings, resetSettings,
    SPECIFIC_METHOD,
  };
})();
