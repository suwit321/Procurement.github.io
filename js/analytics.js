/* analytics.js — การคำนวณเชิงสถิติและการรวมกลุ่ม

   ทุกฟังก์ชันรับ "ชุดระเบียนที่กรองแล้ว" เข้ามา ไม่ได้อ่านจากค่าที่คำนวณล่วงหน้า
   จึงทำให้ตัวกรองส่วนกลางมีผลกับทุกตารางและทุกกราฟพร้อมกัน
   (ของเดิมอ่านจากอาเรย์สำเร็จรูปใน data.json ตัวกรองจึงไม่มีผลข้ามแท็บ)
*/
'use strict';

const Analytics = (() => {

  const SPECIFIC = 'เฉพาะเจาะจง';

  /* ---------------------------------------------------------------
     การกระจุกตัวของตลาด
     --------------------------------------------------------------- */

  /** HHI ต่อหน่วยงาน = ผลรวมของ (ส่วนแบ่งมูลค่า x 100) ยกกำลังสอง
   *  minContracts สำคัญมาก: หน่วยงานที่มีสัญญาเดียวจะได้ 10,000 เสมอ
   *  ของเดิมไม่มีเกณฑ์นี้ ตาราง "กระจุกตัวสูง" จึงเต็มไปด้วยหน่วยงานสัญญาเดียว
   */
  /* ระดับการรวมกลุ่มของ "ผู้ซื้อ"
     agency = ตามกรม/หน่วยงานต้นสังกัด (เดิมมีแค่ระดับนี้)
     sub    = ตามหน่วยงานย่อย เช่น สาขาของการประปา ซึ่งเป็นระดับที่ตัดสินใจจัดซื้อจริง

     สำคัญ: หน่วยงานใหญ่ที่มีหลายร้อยสาขาจะดู "กระจายตัวดี" ที่ระดับกรมเสมอ
     เพราะรวมงานของทุกสาขาเข้าด้วยกัน การดูระดับสาขาจึงเห็นการกระจุกตัวที่ระดับกรมกลบไว้ */
  const BUYER_LEVELS = {
    agency: { key: r => r.dept_key, label: 'หน่วยงาน' },
    sub: { key: r => r.dept_sub_name || r.dept_key, label: 'หน่วยงานย่อย' },
  };

  function buyerKeyFn(level) {
    return (BUYER_LEVELS[level] || BUYER_LEVELS.agency).key;
  }

  /** ส่วนแบ่งรวมของผู้เล่น n รายแรก (concentration ratio)
   *  ใช้คู่กับ HHI เสมอ เพราะสองค่านี้เล่าคนละเรื่องเมื่อมีผู้เล่นรายเล็กจำนวนมาก
   *  ตัวอย่างจากชุดข้อมูลนี้: งานก่อสร้างทั้งประเทศได้ HHI เพียง 799 (ดูเหมือนแข่งขันดี)
   *  ทั้งที่ผู้รับจ้าง 5 รายแรกกินส่วนแบ่งถึง 38.7% เพราะผู้เล่นรายเล็ก 3,338 รายถ่วงค่า HHI ลง */
  function concentrationRatio(values, total, n) {
    if (!total) return 0;
    return values.slice().sort((a, b) => b - a).slice(0, n)
      .reduce((sum, v) => sum + v, 0) / total;
  }

  function hhi(records, { minContracts = 5, level = 'agency' } = {}) {
    const out = [];
    for (const [dept, rows] of U.groupBy(records, buyerKeyFn(level))) {
      if (rows.length < minContracts) continue;
      const total = U.sum(rows.map(r => r.contract_price_agree));
      if (total <= 0) continue;
      const byContractor = U.groupBy(rows, r => r.winner_key);
      const shares = [];
      let index = 0;
      for (const [, crows] of byContractor) {
        const value = U.sum(crows.map(r => r.contract_price_agree));
        shares.push(value);
        index += (value / total * 100) ** 2;
      }
      out.push({
        dept_name: dept, hhi: Math.round(index * 100) / 100,
        cr4: concentrationRatio(shares, total, 4),
        cr5: concentrationRatio(shares, total, 5),
        n_contracts: rows.length, n_contractors: byContractor.size, total_value: total,
        parent: level === 'sub' ? (rows[0].dept_key || '') : '',
      });
    }
    return out.sort((a, b) => b.hhi - a.hhi);
  }

  /** เทียบการกระจุกตัวระดับกรม กับระดับสาขาของกรมเดียวกัน
   *
   *  หน่วยงานที่มีหลายสาขาจะดู "กระจายตัวดี" ที่ระดับกรมเสมอ เพราะรวมงานของทุกสาขาเข้าด้วยกัน
   *  ทั้งที่แต่ละสาขาอาจจ้างผู้รับจ้างรายเดิมซ้ำ ตัวเลขระดับกรมจึงกลบปัญหาไว้
   *  ตัวอย่างจากชุดข้อมูลนี้: การประปาส่วนภูมิภาคได้ HHI 1,733 ที่ระดับกรม
   *  แต่มัธยฐานของ 80 สาขาอยู่ที่ 2,822 และ 44 สาขาเกิน 2,500 */
  function branchConcentration(records, { minBranches = 3, minContracts = 5 } = {}) {
    const parentStats = new Map(
      hhi(records, { minContracts, level: 'agency' }).map(h => [h.dept_name, h]));
    const branches = new Map();
    for (const b of hhi(records, { minContracts, level: 'sub' })) {
      if (!b.parent) continue;
      if (!branches.has(b.parent)) branches.set(b.parent, []);
      branches.get(b.parent).push(b);
    }

    const out = [];
    for (const [parent, list] of branches) {
      // สาขาที่ชื่อตรงกับกรมคือหน่วยงานที่ไม่มีสาขาจริง ไม่ต้องนำมาเทียบ
      const real = list.filter(b => b.dept_name !== parent);
      if (real.length < minBranches) continue;
      const p = parentStats.get(parent);
      if (!p) continue;
      const sorted = real.map(b => b.hhi).sort((a, b) => a - b);
      out.push({
        dept_name: parent,
        n_branches: real.length,
        parent_hhi: p.hhi,
        parent_cr5: p.cr5,
        branch_hhi_median: sorted[Math.floor(sorted.length / 2)],
        branches_concentrated: real.filter(b => b.hhi > 2500).length,
        total_value: p.total_value,
        // ยิ่งมาก แปลว่าตัวเลขระดับกรมกลบการกระจุกตัวไว้มาก
        hidden_gap: sorted[Math.floor(sorted.length / 2)] - p.hhi,
      });
    }
    return out.sort((a, b) => b.hidden_gap - a.hidden_gap);
  }

  /** ภาพรวมการกระจุกตัวทั้งตลาด แยกตามประเภทงาน — ไม่ผูกกับหน่วยงานใดหน่วยงานหนึ่ง
   *  ตอบคำถามว่า "ตลาดงานประเภทนี้ทั้งประเทศมีผู้เล่นกี่รายและกระจุกแค่ไหน" */
  function marketStructure(records, { minContracts = 20 } = {}) {
    const out = [];
    for (const [type, rows] of U.groupBy(records, r => r.project_type_name)) {
      if (rows.length < minContracts) continue;
      const total = U.sum(rows.map(r => r.contract_price_agree));
      if (total <= 0) continue;
      const byContractor = U.groupBy(rows, r => r.winner_key);
      const shares = [];
      let index = 0;
      for (const [, crows] of byContractor) {
        const value = U.sum(crows.map(r => r.contract_price_agree));
        shares.push(value);
        index += (value / total * 100) ** 2;
      }
      const once = [...byContractor.values()].filter(v => v.length === 1).length;
      out.push({
        project_type: type, n_contracts: rows.length, n_contractors: byContractor.size,
        hhi: Math.round(index * 100) / 100,
        cr4: concentrationRatio(shares, total, 4),
        cr5: concentrationRatio(shares, total, 5),
        one_time_share: byContractor.size ? once / byContractor.size : 0,
        total_value: total,
      });
    }
    return out.sort((a, b) => b.total_value - a.total_value);
  }

  /** ตัวชี้วัดคัดกรองต่อหน่วยงาน: การกระจายราคา + ส่วนแบ่งของผู้ชนะรายใหญ่สุด */
  function screening(records, { minContracts = 5, level = 'agency' } = {}) {
    const out = [];
    for (const [dept, rows] of U.groupBy(records, buyerKeyFn(level))) {
      if (rows.length < minContracts) continue;
      const prices = rows.map(r => r.contract_price_agree).filter(v => v !== null);
      const total = U.sum(prices);
      const byContractor = U.groupBy(rows, r => r.winner_key);
      let topShare = 0, topName = '';
      for (const [name, crows] of byContractor) {
        const share = total > 0 ? U.sum(crows.map(r => r.contract_price_agree)) / total : 0;
        if (share > topShare) { topShare = share; topName = name; }
      }
      out.push({
        dept_name: dept, n_contracts: rows.length,
        parent: level === 'sub' ? (rows[0].dept_key || '') : '',
        cv_price: prices.length > 1 ? U.cv(prices) : null,
        top_winner: topName, top_winner_share: topShare,
        specific_share: rows.filter(r => r.purchase_method_name === SPECIFIC).length / rows.length,
        total_value: total,
      });
    }
    return out.sort((a, b) => b.top_winner_share - a.top_winner_share);
  }

  /** หน่วยงานที่พึ่งพาวิธีเฉพาะเจาะจงสูง */
  function noncompete(records, { minContracts = 5 } = {}) {
    const out = [];
    for (const [dept, rows] of U.groupBy(records, r => r.dept_key)) {
      if (rows.length < minContracts) continue;
      const spec = rows.filter(r => r.purchase_method_name === SPECIFIC);
      out.push({
        dept_name: dept, n_contracts: rows.length,
        pct_specific: spec.length / rows.length,
        value_specific: U.sum(spec.map(r => r.contract_price_agree)),
        total_value: U.sum(rows.map(r => r.contract_price_agree)),
      });
    }
    return out.sort((a, b) => b.pct_specific - a.pct_specific || b.n_contracts - a.n_contracts);
  }

  /* ---------------------------------------------------------------
     การตรวจจับความผิดปกติ
     --------------------------------------------------------------- */

  const BENFORD_EXPECTED = Array.from({ length: 9 },
    (_, i) => Math.log10(1 + 1 / (i + 1)));

  /** การกระจายเลขหลักแรกเทียบกฎเบนฟอร์ด
   *  ค่าวิกฤต chi-square ที่ df=8, p=0.05 คือ 15.51
   */
  function benford(values) {
    const digits = new Array(9).fill(0);
    let n = 0;
    for (const v of values) {
      if (v === null || v === undefined) continue;
      const abs = Math.abs(Number(v));
      if (!Number.isFinite(abs) || abs < 1) continue;
      const first = Number(String(Math.trunc(abs))[0]);
      if (first >= 1 && first <= 9) { digits[first - 1]++; n++; }
    }
    if (!n) return { n: 0, observed: digits, observedPct: digits, expectedPct: BENFORD_EXPECTED, chi2: 0, deviates: false };

    const observedPct = digits.map(d => d / n);
    let chi2 = 0;
    for (let i = 0; i < 9; i++) {
      const expected = BENFORD_EXPECTED[i] * n;
      chi2 += (digits[i] - expected) ** 2 / expected;
    }
    return {
      n, observed: digits, observedPct, expectedPct: BENFORD_EXPECTED,
      chi2: Math.round(chi2 * 100) / 100, deviates: chi2 > 15.51,
    };
  }

  /** เบนฟอร์ดรายหน่วยงาน — ชี้เป้าหน่วยงานที่การกระจายเลขหลักแรกเบี่ยงเบนมาก */
  function benfordByAgency(records, { minContracts = 30 } = {}) {
    const out = [];
    for (const [dept, rows] of U.groupBy(records, r => r.dept_key)) {
      if (rows.length < minContracts) continue;
      const b = benford(rows.map(r => r.contract_price_agree));
      if (b.n < minContracts) continue;
      out.push({ dept_name: dept, n: b.n, chi2: b.chi2, deviates: b.deviates, total_value: U.sum(rows.map(r => r.contract_price_agree)) });
    }
    return out.sort((a, b) => b.chi2 - a.chi2);
  }

  /** หน้าผาที่เพดานราคา — นับสัญญาต่อช่วงราคา เพื่อให้เห็นการกองตัวใต้เพดาน
   *  สัญญาณเด่นของชุดข้อมูลนี้: ช่วงใต้เพดาน 500,000 หนาแน่นกว่าช่วงเหนือเพดานหลายเท่า
   */
  function thresholdCliff(records, { ceiling = 500000, binWidth = 50000, span = 5 } = {}) {
    const bins = [];
    for (let i = -span; i < span; i++) {
      const lo = ceiling + i * binWidth;
      bins.push({ lo, hi: lo + binWidth, n: 0, value: 0 });
    }
    for (const r of records) {
      const v = r.contract_price_agree;
      if (v === null) continue;
      for (const b of bins) {
        if (v >= b.lo && v < b.hi) { b.n++; b.value += v; break; }
      }
    }
    const below = bins.find(b => b.hi === ceiling);
    const above = bins.find(b => b.lo === ceiling);
    const ratio = below && above && above.n > 0 ? below.n / above.n : null;
    return { bins, ceiling, belowCount: below?.n ?? 0, aboveCount: above?.n ?? 0, ratio };
  }

  /** ฮิสโทแกรมอัตราส่วนราคาสัญญาต่อราคากลาง — แท่งพุ่งที่ 1.00 คือสัญญาณไร้การแข่งขัน */
  function priceRatioHistogram(records, { bins = 24, lo = 0.4, hi = 1.15 } = {}) {
    const width = (hi - lo) / bins;
    const buckets = Array.from({ length: bins }, (_, i) => ({
      lo: lo + i * width, hi: lo + (i + 1) * width, n: 0,
    }));
    let exact = 0, counted = 0;
    for (const r of records) {
      if (!r.price_build || r.contract_price_agree === null) continue;
      const ratio = r.contract_price_agree / r.price_build;
      counted++;
      if (Math.abs(ratio - 1) < 1e-9) exact++;
      const idx = Math.floor((ratio - lo) / width);
      if (idx >= 0 && idx < bins) buckets[idx].n++;
    }
    return { buckets, exact, counted };
  }

  /** ราคาผิดปกติเทียบกลุ่มเปรียบเทียบ (ประเภทโครงการ x วิธีจัดหา)
   *  ใช้ IQR แทน z-score เพราะการกระจายราคาเบ้มากและมีหางยาว
   */
  function priceOutliers(records, { minGroup = 30, k = 3.0, limit = 100 } = {}) {
    const out = [];
    // เทียบภายในกลุ่มงาน (จากชื่อโครงการ) แทนประเภทโครงการ ซึ่งมีเพียง 6 ค่าและ 2 ใน 3 เป็นจ้างก่อสร้าง
    // งานวางท่อจึงไม่ถูกเทียบราคากับการซื้อคลอรีน ถ้าไม่มีกลุ่มงานให้ใช้ประเภทโครงการตามเดิม
    const groups = U.groupBy(records,
      r => (r.work_group || r.project_type_name) + ' | ' + r.purchase_method_name);
    for (const [key, rows] of groups) {
      const prices = rows.map(r => r.contract_price_agree).filter(v => v !== null && v > 0);
      if (prices.length < minGroup) continue;
      const { upper, q1, q3 } = U.iqrBounds(prices, k);
      const med = U.median(prices);
      for (const r of rows) {
        const v = r.contract_price_agree;
        if (v === null || v <= upper) continue;
        out.push({
          record: r, peer_group: key, peer_median: med, peer_q1: q1, peer_q3: q3,
          upper_bound: upper, value: v, times_median: med > 0 ? v / med : null,
        });
      }
    }
    return out.sort((a, b) => (b.times_median || 0) - (a.times_median || 0)).slice(0, limit);
  }

  /** ระยะเวลาสัญญาผิดปกติ (สั้นติดลบ หรือยาวเกินกลุ่ม) */
  function durationOutliers(records, { limit = 50 } = {}) {
    const withDur = records.filter(r => r.duration_days !== null);
    if (!withDur.length) return { negative: [], long: [], median: 0 };
    const days = withDur.map(r => r.duration_days);
    const { upper } = U.iqrBounds(days, 3.0);
    return {
      median: U.median(days),
      negative: withDur.filter(r => r.duration_days < 0)
        .sort((a, b) => a.duration_days - b.duration_days).slice(0, limit),
      long: withDur.filter(r => r.duration_days > upper)
        .sort((a, b) => b.duration_days - a.duration_days).slice(0, limit),
      upper,
    };
  }

  /* ---------------------------------------------------------------
     รูปแบบการทุจริต
     --------------------------------------------------------------- */

  /** กลุ่มสัญญาที่เข้าข่ายแบ่งซื้อแบ่งจ้าง — รวมเป็นคลัสเตอร์ ไม่ใช่รายสัญญา */
  function splitClusters(records, { maxEach = 500000, minTotal = 400000, minCount = 2 } = {}) {
    const out = [];
    const groups = U.groupBy(records.filter(r => r.contract_date),
      r => r.dept_key + ' ' + r.winner_key + ' ' + r.contract_date);
    for (const [, rows] of groups) {
      if (rows.length < minCount) continue;
      if (!rows.every(r => r.contract_price_agree !== null && r.contract_price_agree < maxEach)) continue;
      const total = U.sum(rows.map(r => r.contract_price_agree));
      if (total < minTotal) continue;
      out.push({
        dept_name: rows[0].dept_key, winner_name: rows[0].winner_key,
        contract_date: rows[0].contract_date, n: rows.length, total, rows,
      });
    }
    return out.sort((a, b) => b.total - a.total);
  }

  /** เลขภาษีผูกกับหลายชื่อ (และทิศกลับ) — ตรวจหลังทำชื่อเป็นมาตรฐานแล้ว */
  function tinMismatch(records) {
    const byTin = new Map(), byName = new Map();
    for (const r of records) {
      if (r.tin_is_masked || !r.winner_tin || !r.winner_key) continue;
      let t = byTin.get(r.winner_tin);
      if (!t) { t = { names: new Set(), rows: [] }; byTin.set(r.winner_tin, t); }
      t.names.add(r.winner_key); t.rows.push(r);

      let n = byName.get(r.winner_key);
      if (!n) { n = { tins: new Set(), rows: [] }; byName.set(r.winner_key, n); }
      n.tins.add(r.winner_tin); n.rows.push(r);
    }

    const oneTinManyNames = [];
    for (const [tin, t] of byTin) {
      if (t.names.size < 2) continue;
      oneTinManyNames.push({
        kind: 'tin', key: tin, names: [...t.names], n_contracts: t.rows.length,
        total_value: U.sum(t.rows.map(r => r.contract_price_agree)),
      });
    }
    const oneNameManyTins = [];
    for (const [name, n] of byName) {
      if (n.tins.size < 2) continue;
      oneNameManyTins.push({
        kind: 'name', key: name, names: [...n.tins], n_contracts: n.rows.length,
        total_value: U.sum(n.rows.map(r => r.contract_price_agree)),
      });
    }
    return [...oneTinManyNames, ...oneNameManyTins]
      .sort((a, b) => b.total_value - a.total_value);
  }

  /** การผลัดกันชนะระหว่างผู้รับจ้างสองรายในหน่วยงานเดียว
   *  ชื่อถูกทำเป็นมาตรฐานตั้งแต่ ETL แล้ว จึงไม่เกิดกรณี "บริษัทสลับกับตัวเอง"
   *  ที่เคยเกิดจากชื่อต่างกันแค่เว้นวรรคซ้อน
   */
  function bidRotation(records, { minContracts = 6, minRatio = 0.6 } = {}) {
    const out = [];
    for (const [dept, rows] of U.groupBy(records, r => r.dept_key)) {
      if (rows.length < minContracts) continue;
      const counts = [...U.countBy(rows, r => r.winner_key)]
        .sort((a, b) => b[1] - a[1]);
      if (counts.length < 2) continue;
      const [a, b] = counts;
      const ratio = (a[1] + b[1]) / rows.length;
      if (ratio < minRatio) continue;
      // ต้องผลัดกันจริง ไม่ใช่รายเดียวกินขาด
      const balance = Math.min(a[1], b[1]) / Math.max(a[1], b[1]);
      if (balance < 0.4) continue;
      out.push({
        dept_name: dept, top_winners: [a[0], b[0]], counts: [a[1], b[1]],
        n_total_contracts: rows.length, alternation_ratio: ratio, balance,
        total_value: U.sum(rows.map(r => r.contract_price_agree)),
      });
    }
    return out.sort((a, b) => b.alternation_ratio - a.alternation_ratio || b.total_value - a.total_value);
  }

  /** คู่ผู้รับจ้างที่ "ครองพื้นที่เดียวกัน" ของหน่วยงานเดียวกัน
   *
   *  ต่างจาก bidRotation ตรงที่ข้อนั้นมองทั้งหน่วยงาน หน่วยงานที่มีสัญญาทั้งประเทศจึงไม่มีวันติดเกณฑ์
   *  ทั้งที่ในอำเภอหนึ่งอาจเหลือผู้เล่นแค่สองราย ข้อนี้จึงตัดเป็นรายพื้นที่ก่อนแล้วค่อยนับส่วนแบ่ง
   *
   *  วิธีคิด: หาผู้รับจ้างที่มีงานพร้อมพิกัดพอจะรู้ "พื้นที่ทำงาน" (ศูนย์กลาง + รัศมีที่ครอบ 90% ของงาน)
   *  จับคู่เฉพาะรายที่พื้นที่ทับกันและเคยรับงานจากหน่วยงานเดียวกัน แล้วนับว่าในรัศมีนั้น
   *  สัญญาของหน่วยงานร่วมทั้งหมดตกเป็นของสองรายนี้กี่เปอร์เซ็นต์
   *
   *  วัดกับชุดข้อมูลหลัก: 596 คู่ผ่านเกณฑ์พื้นฐาน · 18 คู่ครองตั้งแต่ 60% ของสัญญาอย่างน้อย 8 ฉบับ
   *  ข้อที่วัดแล้ว "ไม่ใช่" สัญญาณ: การสลับกันชนะตามเวลาของคู่เหล่านี้พอ ๆ กับการสุ่ม (เช่น สลับจริง 6 ครั้ง
   *  จากที่คาดไว้ 6.5) จึงไม่นำมาคิดคะแนน และไม่ควรนำไปอ้างว่าเป็นการผลัดกันชนะ
   */
  function territoryPairs(records, {
    minGeo = 3, minMarket = 8, minShare = 0.5, minPairContracts = 4, limit = 40,
  } = {}) {
    const rad = Math.PI / 180;
    const km = (a, b) => {
      const dLat = (b[0] - a[0]) * rad, dLon = (b[1] - a[1]) * rad, mid = (a[0] + b[0]) / 2 * rad;
      const x = dLon * Math.cos(mid), y = dLat;
      return Math.sqrt(x * x + y * y) * 6371;
    };

    // โปรไฟล์พื้นที่ของผู้รับจ้าง — ใช้เฉพาะพิกัดที่ไม่ใช่พิกัดใช้ร่วม (มักเป็นที่ตั้งสำนักงาน)
    const prof = [];
    for (const [key, rows] of U.groupBy(records, r => r.winner_key)) {
      const geo = rows.filter(r => r.lat !== null && r.lon !== null && r.geo_quality !== 'shared');
      if (geo.length < minGeo) continue;
      const center = [U.median(geo.map(r => r.lat)), U.median(geo.map(r => r.lon))];
      const ds = geo.map(r => km(center, [r.lat, r.lon])).sort((x, y) => x - y);
      prof.push({
        key, name: rows[0].winner_name, rows, center,
        p90: ds[Math.floor(0.9 * (ds.length - 1))],
        depts: new Set(rows.map(r => r.dept_key)),
      });
    }

    const byDept = U.groupBy(records.filter(r => r.lat !== null && r.lon !== null && r.geo_quality !== 'shared'),
      r => r.dept_key);

    const out = [];
    for (let i = 0; i < prof.length; i++) {
      for (let j = i + 1; j < prof.length; j++) {
        const a = prof[i], b = prof[j];
        const shared = [...a.depts].filter(d => b.depts.has(d));
        if (!shared.length) continue;
        const apart = km(a.center, b.center);
        // "พื้นที่ทับกัน" = ศูนย์กลางห่างกันไม่เกินรัศมีเฉลี่ยของทั้งคู่ (อย่างน้อย 8 กม. กันกรณีงานกระจุกจุดเดียว)
        const reach = Math.max(8, (a.p90 + b.p90) / 2);
        if (apart > reach) continue;

        const mid = [(a.center[0] + b.center[0]) / 2, (a.center[1] + b.center[1]) / 2];
        let market = 0, taken = 0, value = 0;
        const deptHit = new Map(), provinces = new Map(), rows = [];
        for (const dk of shared) {
          for (const r of (byDept.get(dk) || [])) {
            if (km(mid, [r.lat, r.lon]) > reach) continue;
            market++;
            if (r.winner_key !== a.key && r.winner_key !== b.key) continue;
            taken++;
            value += r.contract_price_agree || 0;
            rows.push(r);
            deptHit.set(r.dept_name || dk, (deptHit.get(r.dept_name || dk) || 0) + 1);
            if (r.province) provinces.set(r.province, (provinces.get(r.province) || 0) + 1);
          }
        }
        if (market < minMarket || taken < minPairContracts) continue;
        const share = taken / market;
        if (share < minShare) continue;

        const nA = rows.filter(r => r.winner_key === a.key).length;
        out.push({
          a: { key: a.key, name: a.name, n: nA },
          b: { key: b.key, name: b.name, n: taken - nA },
          depts: [...deptHit].sort((x, y) => y[1] - x[1]),
          provinces: [...provinces].sort((x, y) => y[1] - x[1]),
          apartKm: apart, radiusKm: reach, market, taken, share, value, rows,
          // ถ่วงกันไม่ให้คู่ที่รายหนึ่งกินขาดขึ้นมาบังคู่ที่แบ่งกันจริง ๆ
          balance: Math.min(nA, taken - nA) / Math.max(1, Math.max(nA, taken - nA)),
        });
      }
    }
    return out
      .sort((x, y) => y.share * y.taken - x.share * x.taken || y.value - x.value)
      .slice(0, limit);
  }

  /** จุดที่มีหลายสัญญาอยู่ด้วยกัน แยกเป็นสองแบบที่ความหมายต่างกันคนละเรื่อง
   *
   *  1) `exact` — ทุกสัญญาในกลุ่มอยู่ที่พิกัดเดียวกันเป๊ะทุกทศนิยม
   *     วัดกับชุดข้อมูลหลักได้ 35 กลุ่ม 149 สัญญา รวม 4,394 ล้านบาท และตัวอย่างที่ใหญ่ที่สุดคือ
   *     13 สัญญา 13 ผู้รับจ้าง 2,305 ล้านบาท ปักที่จุดเดียวในกรุงเทพฯ ของกรมทรัพยากรน้ำบาดาล
   *     ทั้งที่ชื่องานเป็นระบบประปาบาดาลคนละแห่ง → แทบแน่ใจได้ว่าเป็นพิกัดตั้งต้นหรือที่ตั้งหน่วยงาน
   *     กติกา geo_quality='shared' ของ ETL จับไม่ได้ เพราะกติกานั้นต้องมีชื่องานต่างกันตั้งแต่ 3 แบบ
   *     แต่ชื่อของกลุ่มพวกนี้เกือบเหมือนกันหมด จุดพวกนี้จึงยังถ่วงแผนที่ จุดร้อน และรอยเท้าอยู่
   *
   *  2) `cluster` — สัญญาอยู่ใกล้กันแต่คนละพิกัด (เช่น งานวางท่อหลายเส้นในย่านเดียวกัน)
   *     อันนี้คือสถานที่จริงที่มีงานซ้ำ ๆ ใช้ดูว่างานเดิมถูกจ้างซ้ำหรือเปลี่ยนมือผู้รับจ้างหรือไม่
   *     ข้อควรระวังที่วัดแล้ว: ในชุดนี้เหลือเพียง 33 กลุ่ม และส่วนใหญ่เป็นย่านที่มีงานหนาแน่นตามปกติ
   *     (เช่น งานวางท่อของการประปานครหลวงในกรุงเทพฯ) ไม่ใช่การผลัดกันรับงานที่จุดเดียว
   */
  function stackedPoints(records, { cellDeg = 0.005, minContracts = 3, limit = 60 } = {}) {
    const geo = records.filter(r => r.lat !== null && r.lon !== null && r.geo_quality !== 'shared');
    const cells = new Map();
    for (const r of geo) {
      const k = `${Math.round(r.lat / cellDeg)}|${Math.round(r.lon / cellDeg)}`;
      let c = cells.get(k);
      if (!c) cells.set(k, c = []);
      c.push(r);
    }
    const out = [];
    for (const rows of cells.values()) {
      if (rows.length < minContracts) continue;
      const coords = new Set(rows.map(r => `${r.lat.toFixed(6)},${r.lon.toFixed(6)}`));
      const winners = [...U.countBy(rows, r => r.winner_name || r.winner_key)].sort((a, b) => b[1] - a[1]);
      const depts = [...U.countBy(rows, r => r.dept_name || r.dept_key)].sort((a, b) => b[1] - a[1]);
      const dates = rows.map(r => r.contract_date).filter(Boolean).sort();
      out.push({
        kind: coords.size === 1 ? 'exact' : 'cluster',
        lat: U.median(rows.map(r => r.lat)), lon: U.median(rows.map(r => r.lon)),
        rows, n: rows.length, nCoords: coords.size,
        winners, depts,
        province: rows[0].province || '',
        value: U.sum(rows.map(r => r.contract_price_agree)),
        firstDate: dates[0] || null, lastDate: dates[dates.length - 1] || null,
      });
    }
    return out
      .sort((a, b) => b.n - a.n || b.value - a.value)
      .slice(0, limit);
  }

  /** คีย์ของสัญญาที่อยู่ในกลุ่ม "พิกัดซ้ำเป๊ะ" — ใช้ซ่อนออกจากแผนที่ได้ทั้งชุด */
  function stackedExactKeys(records, opts = {}) {
    const keys = new Set();
    for (const g of stackedPoints(records, { ...opts, limit: Infinity })) {
      if (g.kind !== 'exact') continue;
      for (const r of g.rows) keys.add(`${r.lat.toFixed(6)},${r.lon.toFixed(6)}`);
    }
    return keys;
  }

  /* ---------------------------------------------------------------
     พฤติกรรมผู้รับจ้าง: ประเภทงาน · ราคาเทียบตลาด · สัญญาณการแข่งขัน
     --------------------------------------------------------------- */

  /** ส่วนลดจากราคากลาง — ตัวเดียวที่ข้อมูลชุดนี้มีจริงและบอกเรื่องการแข่งขันได้
   *  price_build มีครบ 10,152 จาก 10,174 สัญญา (99.8%) จึงใช้เป็นฐานได้ทั้งชุด */
  function ceilingDiscount(r) {
    const base = r.price_build;
    if (!base || base <= 0 || r.contract_price_agree === null || r.contract_price_agree === undefined) return null;
    return (base - r.contract_price_agree) / base;
  }

  /** ค่ากลางของตลาดไว้เทียบ แยกตาม (วิธีจัดหา × ประเภทโครงการ)
   *  ต้องแยกสองชั้นนี้ ไม่งั้นจะเทียบข้ามคนละสนาม — วัดกับข้อมูลจริงแล้วต่างกันคนละโลก:
   *  e-bidding ลดกลาง 14.33% ไม่ลดเลยแค่ 1.9% · เฉพาะเจาะจง ลดกลาง 0.09% ไม่ลดเลย 40.7%
   *  ถ้าเอาสองอย่างมาเทียบกันตรง ๆ ผู้รับจ้างที่รับงานเฉพาะเจาะจงจะดู "ไม่ยอมลดราคา" ทุกราย
   */
  function marketBaselines(records, { minCell = 20 } = {}) {
    const cells = new Map();
    const add = (map, key, d) => {
      let v = map.get(key);
      if (!v) map.set(key, v = []);
      v.push(d);
    };
    const byType = new Map(), byMethod = new Map();
    for (const r of records) {
      const d = ceilingDiscount(r);
      if (d === null) continue;
      add(cells, `${r.purchase_method_name}|${r.project_type_name}`, d);
      add(byType, r.project_type_name, d);
      add(byMethod, r.purchase_method_name, d);
    }
    const summarize = list => ({
      n: list.length,
      med: U.median(list),
      zeroShare: list.filter(d => Math.abs(d) < 1e-9).length / list.length,
    });
    const shrink = (map, min) => {
      const out = new Map();
      for (const [k, v] of map) if (v.length >= min) out.set(k, summarize(v));
      return out;
    };
    const all = [];
    for (const v of cells.values()) all.push(...v);
    return {
      cell: shrink(cells, minCell),
      type: shrink(byType, 5),
      method: shrink(byMethod, 5),
      overall: all.length ? summarize(all) : null,
    };
  }

  /** ดัชนีตลาด (จังหวัด × กลุ่มงาน) → เซ็ตผู้รับจ้างที่เคยชนะในตลาดนั้น
   *  ใช้ตอบว่า "ผู้รับจ้างรายนี้มีคู่แข่งกี่รายในสนามที่ตัวเองเล่น"
   *  ไม่ใช่จำนวนผู้ยื่นเสนอราคา (ข้อมูลชุดนี้ไม่มี) แต่เป็นจำนวนผู้เล่นที่เคยชนะงานแบบเดียวกันในพื้นที่เดียวกัน */
  function marketPlayers(records) {
    const idx = new Map();
    for (const r of records) {
      const k = `${r.province || '-'}|${r.work_group || 'other'}`;
      let v = idx.get(k);
      if (!v) idx.set(k, v = new Set());
      v.add(r.winner_key);
    }
    return idx;
  }

  /** โครงการที่แยกเป็นหลายสัญญา (project_id เดียว หลายฉบับ)
   *  วัดแล้วมี 51 โครงการจาก 10,000 และ 49 ใน 51 มีผู้ชนะมากกว่าหนึ่งราย
   *  นี่คือที่เดียวในชุดข้อมูลที่ตอบได้ว่า "งานก้อนเดียวกันใครได้ส่วนไหน" */
  function multiLotProjects(records) {
    const out = new Map();
    for (const [pid, rows] of U.groupBy(records, r => r.project_id)) {
      if (rows.length < 2) continue;
      const winners = new Set(rows.map(r => r.winner_key));
      // ★ แถวที่เป็นสมาชิกกิจการค้าร่วม (is_jv) มียอดซ้ำกับแถวของกิจการค้าร่วมเอง
      //   ถ้ารวมทุกแถวจะนับซ้ำ จึงแยกยอดที่ตัดส่วนซ้ำออกไว้ให้ด้วย (ดู jvGroups)
      const jvRows = rows.filter(r => r.is_jv);
      out.set(pid, {
        project_id: pid, project_name: rows[0].project_name,
        dept_name: rows[0].dept_name, rows, n: rows.length, nWinners: winners.size,
        value: U.sum(rows.map(r => r.contract_price_agree)),
        nJv: jvRows.length,
        valueNoDup: U.sum(rows.filter(r => !r.is_jv).map(r => r.contract_price_agree)),
      });
    }
    return out;
  }

  /** ภาพพฤติกรรมของผู้รับจ้างรายเดียว เทียบกับตลาดที่ตัวเองเล่นอยู่ */
  function contractorBehaviour(rows, { baselines, players, lots, groupLabel = k => k } = {}) {
    const n = rows.length;
    const tally = (keyFn, labelFn) => [...U.groupBy(rows, keyFn)]
      .map(([k, list]) => {
        const ds = list.map(ceilingDiscount).filter(d => d !== null);
        return {
          key: k, label: labelFn ? labelFn(k) : k, n: list.length,
          value: U.sum(list.map(r => r.contract_price_agree)),
          share: list.length / n,
          medDisc: ds.length ? U.median(ds) : null,
          zeroShare: ds.length ? ds.filter(d => Math.abs(d) < 1e-9).length / ds.length : null,
          rows: list,
        };
      })
      .sort((a, b) => b.n - a.n);

    const groups = tally(r => r.work_group || 'other', groupLabel);
    const types = tally(r => r.project_type_name);
    const methods = tally(r => r.purchase_method_name);

    // ส่วนลดเทียบตลาดของ "วิธีจัดหา × ประเภท" เดียวกัน — ต่างเป็นลบคือลดน้อยกว่าคนอื่นในสนามเดียวกัน
    const rel = [];
    const relByType = new Map();
    for (const r of rows) {
      const d = ceilingDiscount(r);
      if (d === null || !baselines) continue;
      const m = baselines.cell.get(`${r.purchase_method_name}|${r.project_type_name}`);
      if (!m) continue;
      const diff = d - m.med;
      rel.push({ r, diff });
      let v = relByType.get(r.project_type_name);
      if (!v) relByType.set(r.project_type_name, v = []);
      v.push(diff);
    }
    // ★ ตารางประเภทงานต้องใช้ฐานเดียวกับ KPI ไม่งั้นจะขัดกันเอง: เทียบกับ "ประเภท" เฉย ๆ
    //   จะกลบผลของวิธีจัดหาจนผู้รับจ้างที่ลดน้อยกว่าสนาม e-bidding ถึง 17% ขึ้นมาเป็น -0.3%
    for (const t of types) t.relDisc = relByType.has(t.key) ? U.median(relByType.get(t.key)) : null;
    const ds = rows.map(ceilingDiscount).filter(d => d !== null);

    // คู่แข่ง: ผู้รับจ้างรายอื่นที่เคยชนะงานกลุ่มเดียวกันในจังหวัดเดียวกัน
    const me = rows[0] ? rows[0].winner_key : null;
    const cells = new Set(rows.map(r => `${r.province || '-'}|${r.work_group || 'other'}`));
    const rivals = new Set();
    if (players) {
      for (const c of cells) for (const w of (players.get(c) || [])) if (w !== me) rivals.add(w);
    }

    // งานนอกความถนัด: กลุ่มงานที่คิดเป็นไม่ถึง 10% ของงานทั้งหมดของรายนี้
    const offSpec = groups.filter(g => g.share < 0.1);

    // โครงการที่แบ่งหลายสัญญาแล้วรายนี้ได้ส่วนหนึ่ง
    const inLots = [];
    if (lots) {
      const seen = new Set();
      for (const r of rows) {
        const lot = lots.get(r.project_id);
        if (!lot || seen.has(r.project_id)) continue;
        seen.add(r.project_id);
        inLots.push(lot);
      }
    }

    return {
      n, groups, types, methods,
      spec: groups.length ? groups[0].share : 0,
      specLabel: groups.length ? groups[0].label : '-',
      medDisc: ds.length ? U.median(ds) : null,
      zeroShare: ds.length ? ds.filter(d => Math.abs(d) < 1e-9).length / ds.length : null,
      relDisc: rel.length ? U.median(rel.map(x => x.diff)) : null,
      relN: rel.length,
      relWorst: rel.sort((a, b) => a.diff - b.diff).slice(0, 5),
      rivals: rivals.size, marketCells: cells.size,
      offSpec, offSpecN: offSpec.reduce((s, g) => s + g.n, 0),
      lots: inLots.sort((a, b) => b.value - a.value),
    };
  }

  /** กลุ่มกิจการค้าร่วม (JV) ที่ประกอบขึ้นใหม่จากแถวที่กระจายอยู่
   *
   *  โครงสร้างที่ตรวจพบในข้อมูลจริง: สัญญาร่วมค้าหนึ่งฉบับถูกบันทึกเป็นหลายแถวที่ใช้
   *  project_id กับ contract_no ร่วมกัน — แถวหนึ่งเป็นชื่อกิจการค้าร่วม อีกหลายแถวเป็นบริษัทสมาชิก
   *  (ETL ตัดคำว่า "(สัญญากิจการค้าร่วม)" ออกจากชื่อแล้วตั้งธง is_jv ไว้แทน · build_data.py:172)
   *
   *  ★ ตรวจแล้ว 17 จาก 18 กลุ่ม ยอดของสมาชิกรวมกันได้เท่ากับยอดของกิจการค้าร่วมเป๊ะทุกบาท
   *  แปลว่าแถวสมาชิกคือการ "แบ่งส่วน" ของสัญญาฉบับเดียวกัน ไม่ใช่สัญญาเพิ่ม
   *  การรวมยอดทุกแถวตรง ๆ จึงนับซ้ำ — เป็นข้อจำกัดของชุดข้อมูล ไม่ใช่ของการคำนวณ
   */
  function jvGroups(records) {
    const buckets = new Map();
    for (const r of records) {
      const k = `${r.project_id || ''}||${r.contract_no || ''}`;
      let v = buckets.get(k);
      if (!v) buckets.set(k, v = []);
      v.push(r);
    }
    const out = [];
    for (const [key, rows] of buckets) {
      const members = rows.filter(r => r.is_jv);
      if (!members.length) continue;
      const others = rows.filter(r => !r.is_jv);
      const memberSum = U.sum(members.map(r => r.contract_price_agree));
      // กิจการค้าร่วมคือแถวที่ยอดตรงกับผลรวมสมาชิกพอดี ไม่ใช่แค่แถวที่ชื่อขึ้นต้นว่า "กิจการค้าร่วม"
      // เพราะโครงการใหญ่หนึ่งโครงการอาจมีผู้ชนะรายอื่นปนอยู่ใน project_id เดียวกันด้วย
      const entity = others.find(r => Math.abs((r.contract_price_agree || 0) - memberSum) < 1) || null;
      out.push({
        key, project_id: rows[0].project_id, contract_no: rows[0].contract_no,
        project_name: rows[0].project_name, dept_name: rows[0].dept_name,
        province: rows[0].province, contract_date: rows[0].contract_date,
        purchase_method_name: rows[0].purchase_method_name,
        entity, members: [...members].sort((a, b) => (b.contract_price_agree || 0) - (a.contract_price_agree || 0)),
        memberSum, entityValue: entity ? entity.contract_price_agree : null,
        matched: !!entity,
      });
    }
    return out.sort((a, b) => b.memberSum - a.memberSum);
  }

  /** คู่พันธมิตรที่เข้าร่วมค้าด้วยกันบ่อย — นับจากกลุ่มที่ประกอบได้ข้างบน */
  function jvPartners(groups) {
    const pairs = new Map();
    for (const g of groups) {
      const keys = g.members.map(m => m.winner_key);
      for (let i = 0; i < keys.length; i++) {
        for (let j = i + 1; j < keys.length; j++) {
          const [a, b] = [keys[i], keys[j]].sort();
          const k = `${a}||${b}`;
          let v = pairs.get(k);
          if (!v) pairs.set(k, v = { a, b, n: 0, value: 0, groups: [] });
          v.n++; v.value += g.memberSum; v.groups.push(g);
        }
      }
    }
    return [...pairs.values()].sort((x, y) => y.n - x.n || y.value - x.value);
  }

  /** จัดอันดับผู้รับจ้างที่ "ลดราคาน้อยกว่าสนามของตัวเอง" มากที่สุดทั้งชุดข้อมูล
   *  สนาม = วิธีจัดหา × ประเภทโครงการ เดียวกัน (ดูเหตุผลที่ marketBaselines)
   *  ค่าติดลบมาก = ชนะงานด้วยราคาที่สูงกว่าคนอื่นในสนามเดียวกันเป็นปกติ */
  function underbidRanking(records, baselines, { minComparable = 3, minValue = 0, limit = Infinity } = {}) {
    const out = [];
    for (const [key, rows] of U.groupBy(records, r => r.winner_key)) {
      const diffs = [];
      for (const r of rows) {
        const d = ceilingDiscount(r);
        if (d === null) continue;
        const m = baselines.cell.get(`${r.purchase_method_name}|${r.project_type_name}`);
        if (!m) continue;
        diffs.push({ r, diff: d - m.med });
      }
      if (diffs.length < minComparable) continue;
      const value = U.sum(rows.map(r => r.contract_price_agree));
      if (value < minValue) continue;
      const methods = [...U.countBy(rows, r => r.purchase_method_name)].sort((a, b) => b[1] - a[1]);
      const ds = rows.map(ceilingDiscount).filter(d => d !== null);
      out.push({
        winner_key: key, winner_name: rows[0].winner_name, rows,
        n: rows.length, nComparable: diffs.length, value,
        method: methods[0] ? methods[0][0] : '-',
        methodShare: methods[0] ? methods[0][1] / rows.length : 0,
        medDisc: ds.length ? U.median(ds) : null,
        rel: U.median(diffs.map(x => x.diff)),
        // เงินที่ต่างจากการลดเท่าค่ากลางของสนาม — ใช้จัดลำดับตามน้ำหนักจริง ไม่ใช่ตามเปอร์เซ็นต์ลอย ๆ
        gapValue: diffs.reduce((s, x) => s + x.diff * (x.r.price_build || 0), 0),
      });
    }
    out.sort((a, b) => a.rel - b.rel);
    return Number.isFinite(limit) ? out.slice(0, limit) : out;
  }

  /* ---------------------------------------------------------------
     จังหวะเวลาของสัญญาเทียบปีงบประมาณ
     --------------------------------------------------------------- */

  /** ปีงบประมาณไทยเริ่ม 1 ต.ค. — เดือนตุลาคมคือเดือนที่ 1 ของปีงบ */
  const FISCAL_ORDER = [10, 11, 12, 1, 2, 3, 4, 5, 6, 7, 8, 9];

  function fiscalYear(dateStr) {
    if (!dateStr) return null;
    const y = +dateStr.slice(0, 4), m = +dateStr.slice(5, 7);
    return (m >= 10 ? y + 1 : y) + 543;   // คืนเป็น พ.ศ.
  }
  function fiscalQuarter(dateStr) {
    if (!dateStr) return null;
    const m = +dateStr.slice(5, 7);
    return m >= 10 ? 1 : m <= 3 ? 2 : m <= 6 ? 3 : 4;
  }

  /** ปฏิทินปีงบของทั้งชุดข้อมูล — ใช้เป็นฉากหลังให้รู้ว่าเดือนไหน "ไม่มีข้อมูล"
   *  ต่างจากเดือนที่ "มีข้อมูลแต่ผู้รับจ้างรายนี้ไม่มีงาน" ซึ่งคนละความหมายกันคนละเรื่อง */
  function fiscalCalendar(records) {
    const months = new Map();
    let total = 0;
    for (const r of records) {
      if (!r.contract_date) continue;
      const k = r.contract_date.slice(0, 7);
      months.set(k, (months.get(k) || 0) + 1);
      total++;
    }
    const keys = [...months.keys()].sort();
    if (!keys.length) return { slots: [], total: 0, years: [] };
    const years = [...new Set(keys.map(k => fiscalYear(k + '-01')))].sort();
    const slots = [];
    for (const fy of years) {
      for (const m of FISCAL_ORDER) {
        // ต.ค.-ธ.ค. อยู่ในปี ค.ศ. ก่อนหน้าปีงบ
        const cal = m >= 10 ? fy - 543 - 1 : fy - 543;
        const key = `${cal}-${String(m).padStart(2, '0')}`;
        slots.push({ key, fy, month: m, n: months.get(key) || 0, inData: months.has(key) });
      }
    }
    return { slots, total, years };
  }

  /** จังหวะเวลาของผู้รับจ้างรายหนึ่ง เทียบกับปฏิทินปีงบและกับค่าเฉลี่ยของทั้งชุด */
  function contractTiming(rows, calendar, { sameDayMin = 3 } = {}) {
    const dated = rows.filter(r => r.contract_date);
    const byMonth = new Map();
    for (const r of dated) {
      const k = r.contract_date.slice(0, 7);
      byMonth.set(k, (byMonth.get(k) || 0) + 1);
    }
    const slots = calendar.slots.map(s => ({
      ...s,
      mine: byMonth.get(s.key) || 0,
      // สัดส่วนของทั้งชุดในเดือนนั้น ใช้เป็นเส้นเทียบว่ารายนี้กระจุกผิดจังหวะไหม
      baseShare: calendar.total ? s.n / calendar.total : 0,
    }));
    const myTotal = dated.length;
    for (const s of slots) s.myShare = myTotal ? s.mine / myTotal : 0;

    const peak = slots.filter(s => s.mine > 0).sort((a, b) => b.myShare - a.myShare)[0] || null;

    // วันเดียวเซ็นหลายฉบับ — วัดแล้วมี 18 รายที่เซ็น ≥5 ฉบับในวันเดียว
    // รายที่สุดคือ 27 จาก 28 ฉบับในวันที่ 1 ต.ค. 2568 ซึ่งเป็นวันแรกของปีงบ
    const byDay = new Map();
    for (const r of dated) {
      let v = byDay.get(r.contract_date);
      if (!v) byDay.set(r.contract_date, v = []);
      v.push(r);
    }
    const bursts = [...byDay.entries()]
      .filter(([, list]) => list.length >= sameDayMin)
      .map(([date, list]) => ({
        date, n: list.length, rows: list,
        value: U.sum(list.map(r => r.contract_price_agree)),
        depts: [...new Set(list.map(r => r.dept_name || r.dept_key))],
        firstOfFiscalYear: date.slice(5) === '10-01',
      }))
      .sort((a, b) => b.n - a.n || b.value - a.value);

    const gaps = dated.map(r => r.announce_gap_days).filter(g => g !== null && g !== undefined);
    const durs = dated.map(r => r.duration_days).filter(d => d !== null && d !== undefined);
    const quarters = new Map();
    for (const r of dated) {
      const q = fiscalQuarter(r.contract_date);
      quarters.set(q, (quarters.get(q) || 0) + 1);
    }

    return {
      slots, myTotal, peak, bursts,
      burstRows: bursts.reduce((s, b) => s + b.n, 0),
      quarters: [1, 2, 3, 4].map(q => ({ q, n: quarters.get(q) || 0 })),
      gapMedian: gaps.length ? U.median(gaps) : null, gapN: gaps.length,
      durMedian: durs.length ? U.median(durs) : null, durN: durs.length,
      dated: dated.length, undated: rows.length - dated.length,
    };
  }

  /* ---------------------------------------------------------------
     การรวมกลุ่มพื้นฐาน
     --------------------------------------------------------------- */

  function totalsBy(records, keyFn, keyName) {
    const out = [];
    for (const [key, rows] of U.groupBy(records, keyFn)) {
      out.push({
        [keyName]: key,
        n_contracts: rows.length,
        total_value: U.sum(rows.map(r => r.contract_price_agree)),
        avg_risk: U.mean(rows.map(r => r.risk_score || 0)),
        max_risk: Math.max(...rows.map(r => r.risk_score || 0)),
        n_flagged: rows.filter(r => (r.rule_hits || []).length).length,
      });
    }
    return out.sort((a, b) => b.total_value - a.total_value);
  }

  const agencyTotals = r => totalsBy(r, x => x.dept_key, 'dept_name');
  const contractorTotals = r => totalsBy(r, x => x.winner_key, 'winner_name');

  /** ผู้รับจ้างที่ชนะงานจากหลายหน่วยงาน */
  function repeatWinners(records, { minAgencies = 3 } = {}) {
    const out = [];
    for (const [name, rows] of U.groupBy(records, r => r.winner_key)) {
      const agencies = new Set(rows.map(r => r.dept_key));
      if (agencies.size < minAgencies) continue;
      out.push({
        winner_name: name, n_agencies: agencies.size, n_contracts: rows.length,
        total_value: U.sum(rows.map(r => r.contract_price_agree)),
        agencies: [...agencies],
      });
    }
    return out.sort((a, b) => b.n_agencies - a.n_agencies || b.total_value - a.total_value);
  }

  /* ตัวคั่นคีย์ของเส้นเชื่อม ต้องเป็นอักขระที่ไม่มีทางปรากฏในชื่อจริง
     เพราะทั้งชื่อหน่วยงานและชื่อผู้รับจ้างมีช่องว่างอยู่ในตัวเองอยู่แล้ว
     (9,313 จาก 10,174 ระเบียน) ถ้าใช้ช่องว่างเป็นตัวคั่น ชื่อจะถูกตัดขาดตอนแยกกลับ
     เขียนเป็น escape เพื่อให้เห็นชัดในซอร์ส และกันเครื่องมืออื่นตัดอักขระควบคุมทิ้ง */
  const EDGE_SEP = '\u0000';

  /** เส้นเชื่อมหน่วยงาน-ผู้รับจ้าง คำนวณจากระเบียนที่กรองแล้ว (ไม่ใช่ค่าคงที่จาก ETL)
   *  แต่ละเส้นพกข้อมูลพอให้แท็บเครือข่ายกรองต่อได้ โดยไม่ต้องวนระเบียนซ้ำ
   */
  function networkEdges(records) {
    const out = [];
    for (const [key, rows] of U.groupBy(records, r => r.dept_key + EDGE_SEP + r.winner_key)) {
      const [source, target] = key.split(EDGE_SEP);
      if (!source || !target) continue;

      const rules = new Set();
      let flagged = 0;
      for (const r of rows) {
        const hits = r.rule_hits || [];
        if (hits.length) flagged++;
        for (const h of hits) rules.add(h.rule_id);
      }

      out.push({
        source, target, n: rows.length,
        value: U.sum(rows.map(r => r.contract_price_agree)),
        max_risk: Math.max(...rows.map(r => r.risk_score || 0)),
        avg_risk: U.mean(rows.map(r => r.risk_score || 0)),
        rules,
        flagged,
        // เลขภาษีถูกปิดบังทั้งคู่ ใช้ยืนยันตัวตนผู้รับจ้างไม่ได้
        masked: rows.every(r => r.tin_is_masked),
        rows,
      });
    }
    return out.sort((a, b) => b.value - a.value);
  }

  /** อนุกรมเวลารายเดือน แยกตามมิติที่เลือก */
  function timeseries(records, dimension = 'purchase_method_name') {
    const months = new Set();
    const series = new Map();
    for (const r of records) {
      const m = U.monthKey(r.contract_date);
      if (!m) continue;
      months.add(m);
      const dim = r[dimension] || 'ไม่ระบุ';
      let s = series.get(dim);
      if (!s) { s = new Map(); series.set(dim, s); }
      const cur = s.get(m) || { n: 0, value: 0 };
      cur.n++; cur.value += r.contract_price_agree || 0;
      s.set(m, cur);
    }
    const sortedMonths = [...months].sort();
    return {
      months: sortedMonths,
      series: [...series.entries()]
        .map(([name, byMonth]) => ({
          name,
          counts: sortedMonths.map(m => byMonth.get(m)?.n || 0),
          values: sortedMonths.map(m => byMonth.get(m)?.value || 0),
          total: U.sum(sortedMonths.map(m => byMonth.get(m)?.n || 0)),
        }))
        .sort((a, b) => b.total - a.total),
    };
  }

  /** โปรไฟล์ผู้รับจ้างพร้อมมิติความเสี่ยง 5 ด้าน
   *  network มาจากดัชนี percentile ที่ ETL คำนวณไว้ (สเกล 0-100 เท่ากันทุกมิติ)
   *  ของเดิม network อยู่สเกล 0-22 ทำให้น้ำหนัก 30% ที่โฆษณาไว้ไม่เป็นจริง
   */
  const RISK_WEIGHTS = { network: 0.30, price: 0.20, competition: 0.20, contract: 0.20, concentration: 0.10 };

  /** น้ำหนักที่ใช้จริงกับชุดข้อมูลตรงหน้า
   *  ดัชนีเครือข่าย (composite_risk_norm) มาจาก ETL เท่านั้น ชุดข้อมูลที่ผู้ใช้นำเข้าเองจึงไม่มี
   *  ถ้าปล่อยให้มิตินั้นเป็น 0 คะแนนรวมจะหายไป 30% เงียบ ๆ ทั้งที่คำอธิบายบนหน้าจอยังบอกว่า 30%
   *  จึงตัดมิติที่ไม่มีข้อมูลออก แล้วเกลี่ยน้ำหนักที่เหลือให้รวมเป็น 1 และให้หน้าจออ่านค่าจากที่นี่ */
  function riskWeights(hasNetwork = true) {
    if (hasNetwork) return { ...RISK_WEIGHTS };
    const rest = { ...RISK_WEIGHTS, network: 0 };
    const total = Object.values(rest).reduce((s, v) => s + v, 0);
    for (const k of Object.keys(rest)) if (k !== 'network') rest[k] = rest[k] / total;
    return rest;
  }

  function contractorProfiles(records, nodeIndex, { minContracts = 1, hasNetwork } = {}) {
    const W = riskWeights(hasNetwork === undefined ? !!(nodeIndex && nodeIndex.size) : hasNetwork);
    const edges = networkEdges(records);
    const byContractor = new Map();
    for (const e of edges) {
      let list = byContractor.get(e.target);
      if (!list) { list = []; byContractor.set(e.target, list); }
      list.push(e);
    }

    const profiles = [];
    for (const [name, rows] of U.groupBy(records, r => r.winner_key)) {
      if (rows.length < minContracts) continue;
      const pairs = (byContractor.get(name) || []).sort((a, b) => b.value - a.value);
      const totalValue = U.sum(rows.map(r => r.contract_price_agree));
      const node = nodeIndex.get('C::' + name);

      // มิติที่ 1 — ตำแหน่งในเครือข่าย (percentile จาก ETL)
      const network = node ? node.composite_risk_norm : 0;

      // มิติที่ 2 — ราคา: สัดส่วนสัญญาที่ราคาชิดราคากลาง
      const withCeiling = rows.filter(r => r.price_build && r.contract_price_agree !== null);
      const tight = withCeiling.filter(r => r.contract_price_agree / r.price_build >= 0.99).length;
      const price = withCeiling.length ? tight / withCeiling.length * 100 : 0;

      // มิติที่ 3 — การแข่งขัน: สัดส่วนงานที่ได้มาด้วยวิธีเฉพาะเจาะจง
      const competition = rows.filter(r => r.purchase_method_name === SPECIFIC).length / rows.length * 100;

      // มิติที่ 4 — สัญญา: คะแนนความเสี่ยงสูงสุดจาก rule engine
      const contract = Math.max(...rows.map(r => r.risk_score || 0));

      // มิติที่ 5 — การกระจุกตัว: พึ่งพาหน่วยงานเดียวมากแค่ไหน
      const topPair = pairs.length ? pairs[0].value : 0;
      const concentration = totalValue > 0 ? topPair / totalValue * 100 : 0;

      const final =
        W.network * network + W.price * price +
        W.competition * competition + W.contract * contract +
        W.concentration * concentration;

      profiles.push({
        winner_name: name,
        winner_tin: rows[0].winner_tin,
        tin_is_masked: rows[0].tin_is_masked,
        n_contracts: rows.length,
        n_agencies: new Set(rows.map(r => r.dept_key)).size,
        total_value: totalValue,
        max_risk: contract,
        avg_risk: U.mean(rows.map(r => r.risk_score || 0)),
        n_flagged: rows.filter(r => (r.rule_hits || []).length).length,
        risk: {
          network: Math.round(network * 10) / 10,
          price: Math.round(price * 10) / 10,
          competition: Math.round(competition * 10) / 10,
          contract: Math.round(contract * 10) / 10,
          concentration: Math.round(concentration * 10) / 10,
          final: Math.round(final * 10) / 10,
        },
        pairs, rows,
        node,
      });
    }
    return profiles.sort((a, b) => b.risk.final - a.risk.final);
  }

  /** ส่วนแบ่งงานที่ให้ "ผู้รับจ้างรายใหม่" — ไล่สัญญาตามลำดับวันที่ทำสัญญา แล้วนับว่าผู้ชนะแต่ละรายเคย
   *  ปรากฏในหน่วยงานนี้มาก่อนหรือไม่ ใช้ตอบคำถาม "หน่วยงานนี้เปิดให้รายใหม่เข้าหรือให้กลุ่มเดิมซ้ำ"
   *
   *  ข้อจำกัดสำคัญ: ชุดข้อมูลนี้มีข้อมูลเพียงปีงบเดียว "รายใหม่" ที่วัดได้จึงหมายถึง
   *  "ไม่เคยปรากฏภายในช่วงเวลาที่มีข้อมูล" เท่านั้น ไม่ใช่ผู้รับจ้างหน้าใหม่ในระบบจัดซื้อจริง
   *  (ผู้ชนะสัญญาแรกสุดของหน่วยงานถูกนับเป็น "ใหม่" เสมอ เพราะไม่มีข้อมูลก่อนหน้าให้เทียบ)
   */
  function newSupplierShare(rows) {
    const dated = rows.filter(r => r.contract_date)
      .slice().sort((a, b) => (a.contract_date < b.contract_date ? -1 : a.contract_date > b.contract_date ? 1 : 0));
    const seen = new Set();
    let newN = 0, newValue = 0;
    const totalValue = U.sum(dated.map(r => r.contract_price_agree));
    for (const r of dated) {
      if (!seen.has(r.winner_key)) { newN++; newValue += r.contract_price_agree || 0; }
      seen.add(r.winner_key);
    }
    return {
      n: dated.length, newN, share: dated.length ? newN / dated.length : null,
      newValue, valueShare: totalValue > 0 ? newValue / totalValue : null,
      distinctWinners: seen.size, undated: rows.length - dated.length,
    };
  }

  /** โปรไฟล์รายหน่วยงาน — คล้าย contractorProfiles แต่ไม่มีมิติเครือข่าย (agency ไม่มีคะแนนจาก ETL)
   *  ตอบ 3 คำถามหลัก: มีกี่โครงการ/สัญญา ใครได้งาน และด้วยวิธีอะไร พร้อมสัญญาณเสริมที่วัดจากข้อมูลได้จริง
   *  level ควบคุมว่านับที่ระดับกรม (รวมทุกสาขา) หรือระดับสาขา — ดูคอมเมนต์ BUYER_LEVELS ด้านบนเรื่องทำไมต้องแยกสองระดับ
   */
  function agencyProfiles(records, { level = 'agency', minContracts = 1 } = {}) {
    const keyFn = buyerKeyFn(level);
    const hhiByDept = new Map(hhi(records, { minContracts: 1, level }).map(h => [h.dept_name, h]));
    const screenByDept = new Map(screening(records, { minContracts: 1, level }).map(s => [s.dept_name, s]));
    // ค่าฐานสัดส่วนวิธีจัดหาทั้งชุด ใช้เทียบว่าหน่วยงานหนึ่งเบี่ยงจากค่าฐานแค่ไหน (หลักการเดียวกับ marketBaselines ด้านบน)
    const baseMethodShare = new Map();
    for (const [m, n] of U.countBy(records, r => r.purchase_method_name)) baseMethodShare.set(m, n / records.length);

    const out = [];
    for (const [key, rows] of U.groupBy(records, keyFn)) {
      if (!key || rows.length < minContracts) continue;
      const totalValue = U.sum(rows.map(r => r.contract_price_agree));
      const contractors = contractorTotals(rows);
      const methods = [...U.countBy(rows, r => r.purchase_method_name)]
        .map(([label, n]) => ({ label, n, share: n / rows.length, baseShare: baseMethodShare.get(label) || 0 }))
        .sort((a, b) => b.n - a.n);
      const types = [...U.countBy(rows, r => r.work_group || 'other')]
        .map(([label, n]) => ({ label, n, share: n / rows.length }))
        .sort((a, b) => b.n - a.n);
      const h = hhiByDept.get(key);
      const scr = screenByDept.get(key);

      out.push({
        dept_name: key,
        // การ์ดตะกร้าทำงานที่ระดับกรมเท่านั้น (renderAgencyModal/cartAgencySummary เดิม) จึงยึด dept_key/dept_name
        // ของแถวจริงเป็นตัวอ้างอิงตะกร้าเสมอ แม้กำลังดูที่ระดับสาขาก็ตาม — ไม่ใช่บั๊ก แต่เป็นข้อจำกัดที่ตั้งใจ
        dept_key: rows[0].dept_key,
        parent_dept_name: rows[0].dept_name,
        dept_sub_name: rows[0].dept_sub_name || '',
        level,
        n_contracts: rows.length,
        n_projects: new Set(rows.map(r => r.project_id)).size,
        total_value: totalValue,
        n_contractors: contractors.length,
        n_flagged: rows.filter(r => (r.rule_hits || []).length).length,
        max_risk: Math.max(0, ...rows.map(r => r.risk_score || 0)),
        avg_risk: U.mean(rows.map(r => r.risk_score || 0)),
        n_provinces: new Set(rows.map(r => r.province).filter(Boolean)).size,
        n_districts: new Set(rows.map(r => r.district).filter(Boolean)).size,
        hhi: h ? h.hhi : null,
        cr5: h ? h.cr5 : null,
        top_winner: scr ? scr.top_winner : (contractors[0] ? contractors[0].winner_name : ''),
        top_winner_share: scr ? scr.top_winner_share
          : (totalValue > 0 && contractors[0] ? contractors[0].total_value / totalValue : 0),
        methods, types,
        loyalty: newSupplierShare(rows),
        contractors, rows,
      });
    }
    return out.sort((a, b) => b.total_value - a.total_value);
  }

  /** จัดคิวตรวจสอบด้วย "คะแนน × มูลค่า" (exposure) แทนคะแนนอย่างเดียว
   *  วัดกับชุดข้อมูลนี้แล้ว: 50 อันดับแรกด้วยคะแนนอย่างเดียวคุมมูลค่าได้ 2.62 พันล้าน
   *  ส่วน 50 อันดับแรกด้วยคะแนน×มูลค่าคุมได้ 13.18 พันล้าน และซ้ำกันแค่ 19 เรื่อง
   *
   *  ข้อจำกัดที่ต้องรู้: สูตรเป็นการคูณตรง ๆ ไม่ทอนค่า (ไม่ log) เพื่อให้อธิบายง่าย
   *  แต่แปลว่าสัญญาคะแนน 0 จะได้ exposure = 0 เสมอไม่ว่ามูลค่าจะสูงแค่ไหน — จุดนี้คือเหตุผลที่ต้องมี
   *  "ชั้นมูลค่าสูงตรวจเสมอ" (materiality) แยกออกมาต่างหาก ไม่ใช่ให้สูตรคูณแก้ปัญหานี้เอง
   *  (วัดแล้ว: 24 ใน 50 สัญญาใหญ่สุดของทั้งประเทศคะแนนอยู่ระดับ "ต่ำ"/"ไม่พบสัญญาณ")
   */
  /** ห่อระเบียนด้วยคะแนน มูลค่า และ exposure แล้วเรียงตามโหมดที่เลือก
   *  แยกออกมาเพื่อให้ auditQueue กับ queueCoverage เรียงด้วยกติกาเดียวกันเสมอ
   *  ไม่เช่นนั้นเส้นกราฟกับรายการในคิวอาจเรียงต่างกันโดยไม่มีใครรู้ */
  function queueWrap(records, mode) {
    const wrap = records.map(r => {
      const score = r.risk_score || 0, value = r.contract_price_agree || 0;
      return { r, score, value, exposure: score * value };
    });
    const key = mode === 'score' ? x => x.score : mode === 'value' ? x => x.value : x => x.exposure;
    return { wrap, sorted: [...wrap].sort((a, b) => key(b) - key(a) || b.value - a.value) };
  }

  function auditQueue(records, {
    mode = 'exposure',        // 'exposure' | 'score' | 'value'
    n = 40,
    materiality = 0, // บาท — สัญญามูลค่า ≥ นี้ ติดคิวเสมอไม่ว่าคะแนนเท่าไร
    capRender = 200,          // เพดานจำนวนแถวที่ส่งให้ UI วาดจริง (records อาจมีหลักหมื่น)
  } = {}) {
    const { wrap, sorted } = queueWrap(records, mode);

    const ranked = sorted.slice(0, n);
    ranked.forEach(x => { x.includedBy = 'rank'; });
    const rankedSet = new Set(ranked);

    const materialityOnly = materiality > 0
      ? sorted.filter(x => x.value >= materiality && !rankedSet.has(x))
          .sort((a, b) => b.value - a.value)
      : [];
    materialityOnly.forEach(x => { x.includedBy = 'materiality'; });

    const logical = ranked.concat(materialityOnly);
    const totalValue = U.sum(logical.map(x => x.value));
    const datasetTotalValue = U.sum(wrap.map(x => x.value));
    const items = logical.slice(0, capRender);

    return {
      mode, n, materiality, items,
      totalItems: logical.length, totalValue, datasetTotalValue,
      coveragePct: datasetTotalValue ? totalValue / datasetTotalValue : 0,
      materialityOnlyCount: materialityOnly.length,
      renderTruncated: logical.length > items.length,
    };
  }

  /** เส้นครอบคลุมมูลค่า: ถ้าตรวจไล่ตามลำดับ k เรื่องแรก จะครอบคลุมมูลค่ารวมกี่ %
   *  คำนวณครบทั้งสามโหมดด้วยกติกาเดียวกับ auditQueue (ผ่าน queueWrap) เพื่อวางเทียบในกราฟเดียว
   *
   *  อ่านอย่างระวัง: โหมด "มูลค่าอย่างเดียว" คือเพดานทางทฤษฎีของการครอบคลุมเงินเสมอ (ไล่จากก้อนใหญ่สุด)
   *  ไม่มีโหมดไหนสูงกว่านี้ได้ แต่ไม่ได้ดูสัญญาณความเสี่ยงเลย ส่วนโหมดคะแนนอย่างเดียวดูแต่ความเสี่ยงโดยไม่สนขนาด
   *  จึงเป็นการเทียบว่าแต่ละวิธีแลกเงินที่ครอบคลุมกับความเสี่ยงที่จับไว้อย่างไร ไม่ใช่การพิสูจน์ว่าวิธีใดถูกต้อง
   *  คืนค่าอาเรย์ยาว maxN+1 (จุดแรกคือ k=0 ที่ 0%) */
  function queueCoverage(records, { maxN = 100 } = {}) {
    const total = U.sum(records.map(r => r.contract_price_agree || 0));
    const N = Math.min(maxN, records.length);
    const curve = mode => {
      const { sorted } = queueWrap(records, mode);
      const out = [0];
      let acc = 0;
      for (let k = 0; k < N; k++) { acc += sorted[k].value; out.push(total ? acc / total : 0); }
      return out;
    };
    return { total, maxN: N, exposure: curve('exposure'), score: curve('score'), value: curve('value') };
  }

  /** หากรรมการที่ปรากฏในหลายบริษัทที่ต่างก็เป็นผู้ชนะงานในชุดข้อมูลจัดซื้อนี้
   *  ข้อมูลกรรมการมาจากที่ผู้ใช้พิมพ์เข้ามาเอง (ดู js/directors.js) ไม่ใช่ข้อมูลที่แอปดึงมา
   *
   *  ข้อจำกัดสำคัญ: จับคู่ชื่อแบบตรงตัวอักษรทุกตัว (ตัดช่องว่างซ้ำแล้วเทียบ) ไม่ทำ fuzzy matching
   *  จึงพลาดได้ทั้งสองทาง — สะกดต่างกันเล็กน้อยจะไม่นับเป็นคนเดียวกัน (false negative)
   *  ส่วนชื่อสามัญที่พ้องกันโดยบังเอิญจะถูกนับเป็นคนเดียวกันผิด (false positive) ต้องเปิดดูรายละเอียดก่อนสรุป
   *  ไม่ใช้เลขผู้เสียภาษีที่ถูกปิดบัง (มีตัวอักษร x ปน) เป็นตัวจับคู่เด็ดขาด เพราะไม่ใช่เลขจริง จับคู่ผิดบริษัทได้
   */
  function sharedDirectors(directorRows, records) {
    // เลขผู้เสียภาษี (ที่ไม่ถูกปิดบัง) -> แถวสัญญาของผู้รับจ้างรายนั้นในชุดข้อมูลจัดซื้อ
    const byTin = new Map();
    for (const r of records) {
      if (!r.winner_tin || r.tin_is_masked) continue;
      let list = byTin.get(r.winner_tin);
      if (!list) byTin.set(r.winner_tin, list = []);
      list.push(r);
    }

    const byPerson = new Map();
    for (const d of directorRows) {
      let list = byPerson.get(d.person_name);
      if (!list) byPerson.set(d.person_name, list = []);
      list.push(d);
    }

    const out = [];
    for (const [person, entries] of byPerson) {
      const companies = entries.map(e => {
        const rows = byTin.get(e.tax_id);
        return {
          tax_id: e.tax_id, company_name: e.company_name, role: e.role,
          matched: !!rows,
          winner_key: rows ? rows[0].winner_key : null,
          winner_name: rows ? rows[0].winner_name : null,
          n_contracts: rows ? rows.length : 0,
          total_value: rows ? U.sum(rows.map(r => r.contract_price_agree)) : 0,
          project_ids: rows ? new Set(rows.map(r => r.project_id)) : new Set(),
        };
      });
      const matched = companies.filter(c => c.matched);
      const distinctWinners = new Set(matched.map(c => c.winner_key));
      if (distinctWinners.size < 2) continue;   // สนใจเฉพาะคนที่โยงผู้ชนะงาน ≥2 รายที่ต่างกัน

      // เคยได้งานโครงการเดียวกันไหม (แบ่งล็อตเดียวกัน) — สัญญาณแรงกว่าการอยู่ในชุดข้อมูลเดียวกันเฉยๆ
      let sameProject = false;
      outer:
      for (let i = 0; i < matched.length; i++) {
        for (let j = i + 1; j < matched.length; j++) {
          if (matched[i].winner_key === matched[j].winner_key) continue;   // บริษัทเดียวกันที่บันทึกซ้ำหลายบทบาท ไม่นับ
          for (const pid of matched[i].project_ids) {
            if (matched[j].project_ids.has(pid)) { sameProject = true; break outer; }
          }
        }
      }

      out.push({ person_name: person, companies, matchedCount: distinctWinners.size, sameProject });
    }
    return out.sort((a, b) => (b.sameProject - a.sameProject) || b.matchedCount - a.matchedCount);
  }

  /* ---------------------------------------------------------------
     วิเคราะห์เชิงลึกวิธีจัดหา (กรอบ 3E + Integrity)
     --------------------------------------------------------------- */

  /** สรุปทุกตัวชี้วัดต่อวิธีจัดหาในรอบเดียว — เป็นแกนของส่วนภาพรวม/ประสิทธิภาพ/ความคุ้มค่า
   *
   *  ★ ข้อควรระวังที่ต้องอ่านคู่กันเสมอ: `announce_gap_days` (ประกาศ→ลงนาม) มีเฉพาะวิธีที่ต้องประกาศเชิญชวน
   *  วัดกับชุดข้อมูลนี้แล้วมีเพียง 1,910 จาก 10,174 ระเบียน (18.8%) และเป็น e-bidding เกือบทั้งหมด
   *  ส่วนเฉพาะเจาะจงกับคัดเลือกไม่มีวันประกาศในต้นทางเลย (0%) จึง "เทียบเวลากระบวนการข้ามวิธีจัดหาไม่ได้"
   *  ทุกที่ที่แสดง gapMed ต้องแสดง gapCover กำกับ ไม่งั้นจะอ่านเป็นว่าเฉพาะเจาะจงเร็วกว่าทั้งที่ไม่มีข้อมูล
   */
  function methodBreakdown(records) {
    const totalN = records.length;
    const totalV = U.sum(records.map(r => r.contract_price_agree));
    const out = [];
    for (const [method, rows] of U.groupBy(records, r => r.purchase_method_name || '-')) {
      const values = rows.map(r => r.contract_price_agree || 0);
      const value = U.sum(values);
      const disc = rows.map(ceilingDiscount).filter(d => d !== null);
      const gaps = rows.map(r => r.announce_gap_days).filter(v => v !== null && v !== undefined);
      const durs = rows.map(r => r.duration_days).filter(v => v !== null && v !== undefined);
      out.push({
        method, n: rows.length, value,
        shareN: totalN ? rows.length / totalN : 0,
        shareV: totalV ? value / totalV : 0,
        mean: rows.length ? value / rows.length : 0,
        median: values.length ? U.median(values) : 0,
        discN: disc.length, discCover: rows.length ? disc.length / rows.length : 0,
        discMed: disc.length ? U.median(disc) : null,
        discZeroShare: disc.length ? disc.filter(d => Math.abs(d) < 1e-9).length / disc.length : null,
        gapN: gaps.length, gapCover: rows.length ? gaps.length / rows.length : 0,
        gapMed: gaps.length ? U.median(gaps) : null,
        durN: durs.length, durCover: rows.length ? durs.length / rows.length : 0,
        durMed: durs.length ? U.median(durs) : null,
        rows,
      });
    }
    return out.sort((a, b) => b.value - a.value);
  }

  /** ความเหมาะสมเชิงกลยุทธ์รายกลุ่มงาน (Kraljic: ความเสี่ยงด้านอุปทาน × สาระสำคัญ)
   *
   *  แกนความเสี่ยงด้านอุปทานใช้ HHI ที่คิดจาก "ส่วนแบ่งมูลค่า" ของผู้ขายแต่ละราย (นิยามมาตรฐาน
   *  และตรงกับ Analytics.hhi ที่ใช้อยู่ทั้งแอป) ★ ห้ามคิดจากจำนวนสัญญาแทน เพราะให้ผลคนละเรื่องกัน:
   *  วัดชุดข้อมูลนี้แบบนับจำนวนได้ HHI แค่ 17-219 ทุกกลุ่ม (ดูเหมือนแข่งขันดีหมด ไม่มีอะไรน่าสนใจ)
   *  แต่แบบถ่วงมูลค่าได้ 58-5,228 ซึ่งแยกกลุ่มได้จริง — กลุ่ม repair ได้ถึง 5,228 (เกินเกณฑ์กระจุกตัวสูง 2,500)
   *  ขณะที่ material 58 · road 170 · pipe 178 แข่งขันกันจริง ความต่างนี้คือสาระของแผนภาพทั้งใบ
   *
   *  specShareV (สัดส่วนมูลค่าที่จัดหาแบบไม่แข่งขัน) เป็นมิติที่สามซ้อนบนแผนภาพ ใช้ตอบว่า
   *  "กลุ่มที่เงินเยอะและตลาดกระจุก ถูกจัดหาด้วยวิธีที่ไม่มีการแข่งขันด้วยหรือเปล่า"
   *  (วัดแล้วต่างกันมาก: source 2.5% · leak 3.8% · pipe 17.9% · road 29.4% · energy 40.3%)
   */
  function methodStrategicFit(records) {
    const totalV = U.sum(records.map(r => r.contract_price_agree));
    const out = [];
    for (const [group, rows] of U.groupBy(records, r => r.work_group || 'other')) {
      const value = U.sum(rows.map(r => r.contract_price_agree));
      const byWinner = U.groupBy(rows, r => r.winner_key);
      let index = 0;
      for (const [, wrows] of byWinner) {
        const wv = U.sum(wrows.map(r => r.contract_price_agree));
        if (value > 0) index += (wv / value * 100) ** 2;
      }
      const spec = rows.filter(r => r.purchase_method_name === SPECIFIC);
      const specValue = U.sum(spec.map(r => r.contract_price_agree));
      const disc = rows.map(ceilingDiscount).filter(d => d !== null);
      out.push({
        group, n: rows.length, value,
        shareV: totalV ? value / totalV : 0,
        suppliers: byWinner.size,
        hhi: Math.round(index),
        specShareN: rows.length ? spec.length / rows.length : 0,
        specShareV: value > 0 ? specValue / value : 0,
        discMed: disc.length ? U.median(disc) : null,
        rows,
      });
    }
    return out.sort((a, b) => b.value - a.value);
  }

  /** ตรวจการใช้วิธีจัดหาที่อาจไม่ตรงเงื่อนไขวงเงิน และการแตกสัญญาเลี่ยงเพดาน
   *
   *  กฎกระทรวงตาม พ.ร.บ.การจัดซื้อจัดจ้างฯ 2560 กำหนดวงเงินวิธีเฉพาะเจาะจงไว้ที่ 500,000 บาท
   *  แต่มาตรา 56(2) มีข้อยกเว้นหลายกรณี (ผู้ขายรายเดียว ฉุกเฉิน ต่อเนื่องจากสัญญาเดิม ฯลฯ)
   *  ผลลัพธ์ของฟังก์ชันนี้จึงเป็น "รายการที่ต้องขอเอกสารเหตุผลประกอบ" ไม่ใช่ข้อสรุปว่าผิดระเบียบ
   *
   *  คลัสเตอร์แตกสัญญาจัดกลุ่มตาม หน่วยงาน + วันทำสัญญาเดียวกัน โดยไม่สนใจว่าผู้รับจ้างเป็นใคร
   *  ต่างจาก splitClusters ที่มีอยู่ ซึ่งบังคับว่าต้องเป็นผู้รับจ้างรายเดียวกันด้วย — การแตกสัญญา
   *  กระจายไปหลายผู้ขายในวันเดียวเป็นรูปแบบที่ splitClusters จับไม่ได้ จึงต้องมีตัวนี้เพิ่ม
   *  (วัดกับชุดข้อมูลนี้ได้ 713 คลัสเตอร์ รวม 768 ล้านบาท สูงสุดคือ 45 สัญญาในวันเดียวของหน่วยงานเดียว)
   */
  function thresholdEvasion(records, { ceiling = 500000, nearBand = 0.1 } = {}) {
    const spec = records.filter(r => r.purchase_method_name === SPECIFIC);
    const overCeiling = spec.filter(r => (r.contract_price_agree || 0) > ceiling)
      .sort((a, b) => (b.contract_price_agree || 0) - (a.contract_price_agree || 0));
    const nearLo = ceiling * (1 - nearBand);
    const nearCeiling = spec.filter(r => {
      const v = r.contract_price_agree || 0;
      return v >= nearLo && v <= ceiling;
    });

    const clusters = [];
    for (const [key, rows] of U.groupBy(spec, r => `${r.dept_key} ${r.contract_date || ''}`)) {
      if (rows.length < 2 || !rows[0].contract_date) continue;
      if (rows.some(r => (r.contract_price_agree || 0) > ceiling)) continue;   // มีฉบับเกินเพดานอยู่แล้ว ไม่ใช่การแตกเพื่อเลี่ยง
      const total = U.sum(rows.map(r => r.contract_price_agree));
      if (total <= ceiling) continue;
      clusters.push({
        dept_key: rows[0].dept_key, dept_name: rows[0].dept_name,
        date: rows[0].contract_date, n: rows.length, total, rows,
        winners: new Set(rows.map(r => r.winner_key)).size,
      });
    }
    clusters.sort((a, b) => b.total - a.total);

    return {
      ceiling, nearLo,
      overCeiling, overCeilingValue: U.sum(overCeiling.map(r => r.contract_price_agree)),
      nearCeiling, nearCeilingValue: U.sum(nearCeiling.map(r => r.contract_price_agree)),
      clusters, clusterValue: U.sum(clusters.map(c => c.total)),
      specN: spec.length,
    };
  }

  /** ราคาต่อหน่วยแบบนำร่อง — อ่านขนาดท่อและความยาวจาก "ชื่อโครงการ" แล้วคิดบาทต่อเมตร
   *
   *  ★ เป็นการประมาณจากชื่อโครงการ ไม่ใช่ BOQ จริง — สัญญาหนึ่งมักรวมงานอื่นนอกเหนือจากตัวท่อ
   *  (งานดิน งานคืนผิวจราจร อุปกรณ์ข้อต่อ) ตัวเลขจึงสูงกว่าราคาท่อเปล่าเสมอ ใช้ได้แค่เทียบ
   *  "ขนาดเดียวกันข้ามหน่วยงาน" แบบหยาบ ๆ ห้ามใช้อ้างอิงราคาต่อหน่วยที่แท้จริง
   *  วัดกับชุดข้อมูลนี้แล้วมีเพียงหลักร้อยสัญญาที่ระบุครบทั้งขนาดและความยาว
   *
   *  ★ ต้องแปลงเลขไทยเป็นเลขอารบิกก่อนเสมอ — ชื่อโครงการในชุดนี้จำนวนมากพิมพ์ขนาด/ปริมาณเป็นเลขไทย
   *  (เช่น "ขนาดเส้นผ่านศูนย์กลาง ๓๐๐") ซึ่ง \d ของ JavaScript ไม่รู้จัก วัดแล้วถ้าไม่แปลงก่อนจะจับได้
   *  168 สัญญา แต่แปลงแล้วได้ 292 คือหายไป 42% ทั้งที่ข้อมูลมีอยู่จริง (ปัญหาเดียวกับที่แก้ไว้ใน dataio.js)
   */
  const PIPE_SIZE_RE = /(\d+)\s*(?:นิ้ว|มม\.|มิลลิเมตร)/;
  const PIPE_LEN_RE = /(\d[\d,]*(?:\.\d+)?)\s*(?:เมตร|ม\.)/;
  const THAI_DIGITS = '๐๑๒๓๔๕๖๗๘๙';
  const thaiDigitsToArabic = v => String(v ?? '').replace(/[๐-๙]/g, ch => String(THAI_DIGITS.indexOf(ch)));

  function unitPricePilot(records, { minPerSize = 5, minLength = 10 } = {}) {
    const parsed = [];
    for (const r of records) {
      const name = thaiDigitsToArabic(r.project_name || '');
      const s = PIPE_SIZE_RE.exec(name);
      const l = PIPE_LEN_RE.exec(name);
      const value = r.contract_price_agree || 0;
      if (!s || !l || value <= 0) continue;
      const length = Number(String(l[1]).replace(/,/g, ''));
      const size = Number(s[1]);
      // ขนาด 0 เกิดจากการอ่านชื่อผิด (เช่นเลขศูนย์โดด ๆ ในชื่อรุ่น) ไม่ใช่ท่อจริง ต้องตัดทิ้ง
      if (!Number.isFinite(length) || length < minLength || !(size > 0)) continue;
      parsed.push({ r, size, length, value, perMetre: value / length });
    }
    const bySize = [];
    for (const [size, list] of U.groupBy(parsed, x => x.size)) {
      if (list.length < minPerSize) continue;
      const per = list.map(x => x.perMetre);
      bySize.push({
        size: Number(size), n: list.length,
        medPerMetre: U.median(per),
        minPerMetre: Math.min(...per), maxPerMetre: Math.max(...per),
        items: list,
      });
    }
    bySize.sort((a, b) => a.size - b.size);
    return { bySize, parsedN: parsed.length, totalN: records.length, shownN: U.sum(bySize.map(b => b.n)) };
  }

  return {
    hhi, screening, noncompete,
    benford, benfordByAgency, thresholdCliff, priceRatioHistogram,
    priceOutliers, durationOutliers,
    splitClusters, tinMismatch, bidRotation, territoryPairs, stackedPoints, stackedExactKeys,
    marketStructure, concentrationRatio, BUYER_LEVELS, branchConcentration,
    agencyTotals, contractorTotals, repeatWinners, networkEdges, timeseries,
    contractorProfiles, RISK_WEIGHTS, riskWeights,
    agencyProfiles, newSupplierShare, buyerKeyFn,
    ceilingDiscount, marketBaselines, marketPlayers, multiLotProjects, contractorBehaviour,
    jvGroups, jvPartners, underbidRanking,
    fiscalYear, fiscalQuarter, fiscalCalendar, contractTiming,
    auditQueue, queueCoverage, sharedDirectors,
    methodBreakdown, methodStrategicFit, thresholdEvasion, unitPricePilot,
  };
})();
