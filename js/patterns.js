/* =========================================================
   การวิเคราะห์พฤติกรรมและรูปแบบ (Pattern Mining)
   =========================================================

   ทุกฟังก์ชันในไฟล์นี้คำนวณแบบกำหนดผลได้แน่นอน (deterministic) จากระเบียนที่ส่งเข้ามา
   ผลลัพธ์ถูกส่งให้ AI "ตีความ" ไม่ใช่ให้ AI "คำนวณ" เพราะโมเดลภาษานับและหาค่ากลางผิดบ่อย
   และคำตอบจะตรวจย้อนได้เสมอว่าตัวเลขมาจากไหน

   แยกจากกฎ R1-R22 โดยตั้งใจ: กฎตัดสินทีละสัญญา ส่วนไฟล์นี้มองระดับ "พฤติกรรม"
   ของผู้รับจ้าง คู่หน่วยงาน-ผู้รับจ้าง ช่วงเวลา และราคา ซึ่งต้องดูหลายสัญญาพร้อมกัน */

const Patterns = (() => {
  const CEILING = 500000;             // เพดานวิธีเฉพาะเจาะจงของงานทั่วไป
  const NEAR_LOW = 450000;            // ช่วงชิดเพดาน 10%
  const DAY = 86400000;

  let projectCount = new Map();
  /** ต้องเรียกครั้งเดียวหลังโหลดข้อมูล เพื่อรู้ว่าโครงการใดแบ่งหลายสัญญา */
  function init(records) {
    projectCount = U.countBy(records, r => r.project_id);
  }

  const isSpecific = r => /เฉพาะเจาะจง/.test(r.purchase_method_name || '');
  const time = iso => (iso ? new Date(iso + 'T00:00:00').getTime() : null);
  const median = a => (a.length ? U.median(a) : null);
  const round = (x, d = 3) => (x === null || x === undefined || !Number.isFinite(x) ? null : Math.round(x * 10 ** d) / 10 ** d);

  /** ส่วนลดเทียบราคากลาง ใช้เฉพาะโครงการสัญญาเดียว
   *  ราคากลางเป็นของทั้งโครงการ ถ้าเทียบกับสัญญาย่อยจะได้ส่วนลดสูงเกินจริง */
  function discount(r) {
    if ((projectCount.get(r.project_id) || 1) > 1) return null;
    if (!(r.price_build > 0) || !(r.contract_price_agree > 0)) return null;
    return 1 - r.contract_price_agree / r.price_build;
  }

  /** จำนวนสัญญาสูงสุดที่เกิดภายในหน้าต่างเวลา windowDays (เลื่อนหน้าต่างบนวันที่ที่เรียงแล้ว) */
  function maxInWindow(times, windowDays) {
    const t = times.filter(x => x !== null).sort((a, b) => a - b);
    let best = 0;
    for (let i = 0, j = 0; j < t.length; j++) {
      while (t[j] - t[i] > windowDays * DAY) i++;
      best = Math.max(best, j - i + 1);
    }
    return best;
  }

  /* ---------- 1) พฤติกรรมผู้รับจ้าง ---------- */

  const ARCHETYPES = [
    { id: 'captive', label: 'ผูกกับหน่วยงานเดียว', test: c => c.n >= 8 && c.topAgencyShare >= 0.8,
      desc: 'มูลค่างานอย่างน้อย 80% มาจากหน่วยงานเดียว และมีงานตั้งแต่ 8 สัญญา (ผู้รับจ้างรายเล็กส่วนใหญ่ทำงานกับหน่วยงานเดียวอยู่แล้ว จึงนับเฉพาะรายที่ได้งานซ้ำมาก)' },
    /* วิธีเฉพาะเจาะจงเป็นการต่อรองราคากับรายเดียว ราคาเท่าราคากลางจึงเป็นเรื่องปกติ (ค่ากลางของทั้งชุด 71%)
       ความผิดปกติจริงคือชนะชิดราคากลางในวิธีที่ควรมีการแข่งขัน */
    { id: 'ceilingHug', label: 'ชนะชิดราคากลางในงานที่มีการแข่งขัน', test: c => c.nDiscComp >= 3 && c.ceilingHugComp >= 0.5,
      desc: 'ในสัญญาวิธีที่มีการแข่งขัน (ไม่ใช่เฉพาะเจาะจง) อย่างน้อย 3 สัญญา ครึ่งหนึ่งขึ้นไปลดราคาไม่ถึง 0.5%' },
    { id: 'underCeiling', label: 'ราคาชิดใต้เพดาน 5 แสน', test: c => c.n >= 3 && c.nearCeiling >= 0.4,
      desc: 'อย่างน้อย 40% ของสัญญามีมูลค่า 450,000-499,999 บาท' },
    { id: 'burst', label: 'ได้งานถี่ในช่วงสั้น', test: c => c.burst30 >= 5,
      desc: 'ได้งานจากหน่วยงานเดียวกันตั้งแต่ 5 สัญญาภายใน 30 วัน' },
    { id: 'specificHeavy', label: 'ได้งานวิธีเฉพาะเจาะจงเกือบทั้งหมด', test: c => c.n >= 5 && c.specificShare >= 0.9,
      desc: 'อย่างน้อย 90% ของสัญญาได้ด้วยวิธีเฉพาะเจาะจง และมีงานตั้งแต่ 5 สัญญา' },
    { id: 'wide', label: 'รับงานกระจายหลายหน่วยงาน', test: c => c.nAgencies >= 8,
      desc: 'ได้งานจาก 8 หน่วยงานขึ้นไป (มักเป็นผู้รับจ้างรายใหญ่ ไม่ใช่สัญญาณเสี่ยงโดยตัวเอง)' },
  ];

  function contractorStats(rows, { minContracts = 3 } = {}) {
    const out = [];
    for (const [key, rs] of U.groupBy(rows, r => r.winner_key)) {
      if (rs.length < minContracts) continue;
      const value = U.sum(rs.map(r => r.contract_price_agree));
      const byAgency = U.groupBy(rs, r => r.dept_key);
      let topAgency = '', topValue = -1, burst30 = 0;
      for (const [dept, ars] of byAgency) {
        const v = U.sum(ars.map(r => r.contract_price_agree));
        if (v > topValue) { topValue = v; topAgency = dept; }
        burst30 = Math.max(burst30, maxInWindow(ars.map(r => time(r.contract_date)), 30));
      }
      const discs = rs.map(discount).filter(d => d !== null);
      const discsComp = rs.filter(r => !isSpecific(r)).map(discount).filter(d => d !== null);
      const dates = rs.map(r => r.contract_date).filter(Boolean).sort();
      const c = {
        key, name: rs[0].winner_name, n: rs.length, value,
        nAgencies: byAgency.size, topAgency, topAgencyShare: value > 0 ? topValue / value : 0,
        specificShare: rs.filter(isSpecific).length / rs.length,
        nDisc: discs.length, medDiscount: median(discs),
        ceilingHug: discs.length ? discs.filter(d => d <= 0.005).length / discs.length : null,
        nDiscComp: discsComp.length,
        ceilingHugComp: discsComp.length ? discsComp.filter(d => d <= 0.005).length / discsComp.length : null,
        nearCeiling: rs.filter(r => r.contract_price_agree >= NEAR_LOW && r.contract_price_agree < CEILING).length / rs.length,
        burst30,
        avgScore: U.mean(rs.map(r => r.risk_score || 0)),
        flaggedShare: rs.filter(r => (r.rule_hits || []).length).length / rs.length,
        first: dates[0] || null, last: dates[dates.length - 1] || null,
        jv: rs.some(r => r.is_jv), masked: rs.some(r => r.tin_is_masked),
      };
      c.archetypes = ARCHETYPES.filter(a => a.test(c)).map(a => a.id);
      out.push(c);
    }
    return out;
  }

  function contractorBehavior(rows, { top = 15 } = {}) {
    const stats = contractorStats(rows);
    const baseline = {
      n: stats.length,
      medContracts: median(stats.map(c => c.n)),
      medAgencies: median(stats.map(c => c.nAgencies)),
      medTopAgencyShare: round(median(stats.map(c => c.topAgencyShare))),
      medSpecificShare: round(median(stats.map(c => c.specificShare))),
      medDiscount: round(median(stats.map(c => c.medDiscount).filter(x => x !== null))),
      medCeilingHug: round(median(stats.map(c => c.ceilingHug).filter(x => x !== null))),
    };
    const archetypes = ARCHETYPES.map(a => {
      const members = stats.filter(c => c.archetypes.includes(a.id));
      return { ...a, count: members.length, value: U.sum(members.map(c => c.value)),
        avgScore: members.length ? U.mean(members.map(c => c.avgScore)) : null };
    });
    // จัดอันดับ: จำนวนรูปแบบที่เข้า (ไม่นับ "กระจายหลายหน่วยงาน" ซึ่งไม่ใช่สัญญาณเสี่ยง) แล้วคะแนนเฉลี่ย แล้วมูลค่า
    const riskArch = c => c.archetypes.filter(id => id !== 'wide').length;
    const ranked = [...stats].sort((a, b) => riskArch(b) - riskArch(a) || b.avgScore - a.avgScore || b.value - a.value);
    return { baseline, archetypes, top: ranked.slice(0, top), ARCHETYPES };
  }

  /* ---------- 2) คู่หน่วยงาน-ผู้รับจ้าง และการหมุนเวียน ---------- */

  function pairPatterns(rows, { top = 15 } = {}) {
    const agencyValue = new Map(), contractorValue = new Map();
    for (const r of rows) {
      agencyValue.set(r.dept_key, (agencyValue.get(r.dept_key) || 0) + (r.contract_price_agree || 0));
      contractorValue.set(r.winner_key, (contractorValue.get(r.winner_key) || 0) + (r.contract_price_agree || 0));
    }
    const pairs = [];
    for (const [k, rs] of U.groupBy(rows, r => r.dept_key + '\u0000' + r.winner_key)) {
      if (rs.length < 3) continue;
      const [dept, winner] = k.split('\u0000');
      const value = U.sum(rs.map(r => r.contract_price_agree));
      const times = rs.map(r => time(r.contract_date)).filter(x => x !== null).sort((a, b) => a - b);
      pairs.push({
        dept, winner, n: rs.length, value,
        shareOfAgency: agencyValue.get(dept) ? value / agencyValue.get(dept) : 0,
        shareOfContractor: contractorValue.get(winner) ? value / contractorValue.get(winner) : 0,
        spanDays: times.length ? Math.round((times[times.length - 1] - times[0]) / DAY) : null,
        specificShare: rs.filter(isSpecific).length / rs.length,
        avgScore: U.mean(rs.map(r => r.risk_score || 0)),
      });
    }
    const mutual = pairs.filter(p => p.shareOfAgency >= 0.5 && p.shareOfContractor >= 0.5)
      .sort((a, b) => b.n - a.n || b.value - a.value);

    /* การหมุนเวียน: หน่วยงานที่มีผู้รับจ้างไม่กี่รายผลัดกันได้งาน มูลค่าใกล้เคียงกัน
       วัดด้วยสัดส่วนสัญญาที่ผู้ชนะเปลี่ยนจากสัญญาก่อนหน้า (เรียงตามวันที่) ในกลุ่มผู้รับจ้าง 3 อันดับแรก */
    const rotation = [];
    for (const [dept, rs] of U.groupBy(rows, r => r.dept_key)) {
      if (rs.length < 6) continue;
      const counts = [...U.countBy(rs, r => r.winner_key)].sort((a, b) => b[1] - a[1]);
      if (counts.length < 2) continue;
      const top3 = new Set(counts.slice(0, 3).map(x => x[0]));
      const inTop = rs.filter(r => top3.has(r.winner_key) && r.contract_date)
        .sort((a, b) => a.contract_date.localeCompare(b.contract_date));
      const coverage = inTop.length / rs.length;
      if (inTop.length < 6 || coverage < 0.7 || top3.size < 2) continue;
      let switches = 0;
      for (let i = 1; i < inTop.length; i++) if (inTop[i].winner_key !== inTop[i - 1].winner_key) switches++;
      const alternation = switches / (inTop.length - 1);
      if (alternation < 0.6) continue;
      const order = [...top3];
      rotation.push({
        dept, n: rs.length, contractors: order.map(k => ({ name: inTop.find(r => r.winner_key === k)?.winner_name || k, n: counts.find(x => x[0] === k)[1] })),
        coverage, alternation, valueCV: round(U.cv(inTop.map(r => r.contract_price_agree || 0))),
        // ลำดับผู้ชนะ 12 สัญญาล่าสุดเป็นตัวอักษร A/B/C ให้เห็นจังหวะการผลัดกันได้งาน
        sequence: inTop.slice(-12).map(r => 'ABC'[order.indexOf(r.winner_key)]).join(''),
        avgScore: U.mean(rs.map(r => r.risk_score || 0)),
      });
    }
    rotation.sort((a, b) => (a.valueCV ?? 9) - (b.valueCV ?? 9) || b.alternation - a.alternation);

    return {
      nPairs: pairs.length,
      mutual: mutual.slice(0, top),
      nMutual: mutual.length,
      loyal: [...pairs].sort((a, b) => b.shareOfAgency - a.shareOfAgency || b.n - a.n).filter(p => p.n >= 4).slice(0, top),
      rotation: rotation.slice(0, top),
      nRotation: rotation.length,
    };
  }

  /* ---------- 3) รูปแบบช่วงเวลา ---------- */

  function timePatterns(rows, { top = 10 } = {}) {
    const byMonth = [...U.groupBy(rows.filter(r => r.contract_date), r => r.contract_date.slice(0, 7))]
      .sort((a, b) => a[0].localeCompare(b[0]))
      .map(([m, rs]) => ({ month: m, n: rs.length, value: U.sum(rs.map(r => r.contract_price_agree)) }));
    const meanN = byMonth.length ? U.mean(byMonth.map(m => m.n)) : 0;
    byMonth.forEach(m => { m.vsMean = meanN ? m.n / meanN : null; });

    const weekday = Array.from({ length: 7 }, () => ({ n: 0, value: 0 }));
    let monthEnd = 0, dated = 0;
    for (const r of rows) {
      if (!r.contract_date) continue;
      const d = new Date(r.contract_date + 'T00:00:00');
      weekday[d.getDay()].n++;
      weekday[d.getDay()].value += r.contract_price_agree || 0;
      if (d.getDate() >= 25) monthEnd++;
      dated++;
    }

    // วันเดียวกันหน่วยงานเดียวกันลงนามหลายสัญญา
    const bursts = [...U.groupBy(rows.filter(r => r.contract_date), r => r.dept_key + '\u0000' + r.contract_date)]
      .filter(([, rs]) => rs.length >= 5)
      .map(([k, rs]) => ({ dept: k.split('\u0000')[0], date: rs[0].contract_date, n: rs.length,
        nContractors: new Set(rs.map(r => r.winner_key)).size, value: U.sum(rs.map(r => r.contract_price_agree)) }))
      .sort((a, b) => b.n - a.n);

    /* แบ่งซื้อแบบกระจายวัน: กฎ R10 ดูเฉพาะวันเดียวกัน ส่วนนี้ขยายเป็นภายใน 30 วัน
       คู่เดิม ทุกฉบับต่ำกว่าเพดาน แต่รวมกันถึงเพดาน */
    const spread = [];
    for (const [k, rs] of U.groupBy(rows.filter(r => r.contract_date && r.contract_price_agree > 0 && r.contract_price_agree < CEILING), r => r.dept_key + '\u0000' + r.winner_key)) {
      if (rs.length < 2) continue;
      const s = [...rs].sort((a, b) => a.contract_date.localeCompare(b.contract_date));
      let bestSum = 0, bestN = 0, bestFrom = null, bestTo = null;
      for (let i = 0, j = 0, sum = 0; j < s.length; j++) {
        sum += s[j].contract_price_agree;
        while (time(s[j].contract_date) - time(s[i].contract_date) > 30 * DAY) { sum -= s[i].contract_price_agree; i++; }
        if (j - i + 1 >= 2 && sum > bestSum) { bestSum = sum; bestN = j - i + 1; bestFrom = s[i].contract_date; bestTo = s[j].contract_date; }
      }
      const distinctDays = new Set(s.map(r => r.contract_date)).size;
      if (bestSum >= CEILING && distinctDays >= 2) {
        const [dept, winner] = k.split('\u0000');
        spread.push({ dept, winner: rs[0].winner_name, n: bestN, sum: bestSum, from: bestFrom, to: bestTo });
      }
    }
    spread.sort((a, b) => b.sum - a.sum);

    const DOW = ['อาทิตย์', 'จันทร์', 'อังคาร', 'พุธ', 'พฤหัสบดี', 'ศุกร์', 'เสาร์'];
    return {
      byMonth,
      weekday: weekday.map((w, i) => ({ day: DOW[i], ...w, share: dated ? w.n / dated : 0 })),
      monthEndShare: dated ? monthEnd / dated : 0,
      monthEndExpected: 7 / 30.4,
      bursts: bursts.slice(0, top), nBursts: bursts.length,
      spread: spread.slice(0, top), nSpread: spread.length,
    };
  }

  /* ---------- 4) รูปแบบราคา ---------- */

  function pricePatterns(rows, { top = 10 } = {}) {
    const discs = rows.map(r => ({ r, d: discount(r) })).filter(x => x.d !== null);
    const bins = [
      ['ไม่ลดเลยหรือเกินราคากลาง', d => d <= 0.0005], ['ลด 0-1%', d => d > 0.0005 && d <= 0.01],
      ['ลด 1-5%', d => d > 0.01 && d <= 0.05], ['ลด 5-15%', d => d > 0.05 && d <= 0.15],
      ['ลด 15-30%', d => d > 0.15 && d <= 0.3], ['ลดมากกว่า 30%', d => d > 0.3],
    ];
    const discountBins = bins.map(([label, f]) => {
      const n = discs.filter(x => f(x.d)).length;
      return { label, n, share: discs.length ? n / discs.length : 0 };
    });
    const byMethod = [...U.groupBy(discs, x => x.r.purchase_method_name)]
      .filter(([, xs]) => xs.length >= 20)
      .map(([m, xs]) => ({ method: m, n: xs.length, medDiscount: round(median(xs.map(x => x.d))), zeroShare: xs.filter(x => x.d <= 0.0005).length / xs.length }))
      .sort((a, b) => b.n - a.n);

    const band = (lo, hi) => rows.filter(r => r.contract_price_agree >= lo && r.contract_price_agree < hi).length;
    const below = band(NEAR_LOW, CEILING), above = band(CEILING, CEILING + 50000);

    const priced = rows.filter(r => r.contract_price_agree > 0);
    const roundShare = mod => (priced.length ? priced.filter(r => r.contract_price_agree % mod === 0).length / priced.length : 0);

    // ราคาเดียวกันเป๊ะ ผู้รับจ้างต่างราย ในหน่วยงานเดียวกัน
    const samePrice = [...U.groupBy(priced, r => r.dept_key + '\u0000' + r.contract_price_agree)]
      .map(([k, rs]) => ({ dept: k.split('\u0000')[0], price: rs[0].contract_price_agree, n: rs.length, nContractors: new Set(rs.map(r => r.winner_key)).size }))
      .filter(x => x.n >= 3 && x.nContractors >= 2)
      .sort((a, b) => b.n - a.n || b.price - a.price);

    const outliers = (typeof Analytics !== 'undefined' ? Analytics.priceOutliers(rows) : []).slice(0, top);
    return {
      nComparable: discs.length, discountBins, byMethod,
      ceiling: { below, above, ratio: above ? below / above : null },
      round10k: roundShare(10000), round100k: roundShare(100000),
      samePrice: samePrice.slice(0, top), nSamePrice: samePrice.length,
      outliers,
    };
  }

  /* ---------- 5) จัดกลุ่มผู้รับจ้างตามพฤติกรรม (k-means) ---------- */

  const CLUSTER_FEATURES = [
    ['logValue', 'มูลค่ารวม (log10 บาท)', c => Math.log10(Math.max(c.value, 1))],
    ['logN', 'จำนวนสัญญา (log10)', c => Math.log10(c.n)],
    ['logAgencies', 'จำนวนหน่วยงาน (log10)', c => Math.log10(c.nAgencies)],
    ['topAgencyShare', 'สัดส่วนจากหน่วยงานหลัก', c => c.topAgencyShare],
    ['specificShare', 'สัดส่วนวิธีเฉพาะเจาะจง', c => c.specificShare],
    ['ceilingHug', 'สัดส่วนสัญญาที่ลดราคาไม่ถึง 0.5%', c => c.ceilingHug],
    ['nearCeiling', 'สัดส่วนราคาชิดใต้เพดาน', c => c.nearCeiling],
    ['avgScore', 'คะแนนความเสี่ยงเฉลี่ย', c => c.avgScore],
  ];

  function rng(seed) {
    return () => { seed |= 0; seed = seed + 0x6D2B79F5 | 0; let t = Math.imul(seed ^ seed >>> 15, 1 | seed); t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t; return ((t ^ t >>> 14) >>> 0) / 4294967296; };
  }

  function kmeans(X, k, rand) {
    const dist = (a, b) => a.reduce((s, v, i) => s + (v - b[i]) ** 2, 0);
    const C = [X[Math.floor(rand() * X.length)].slice()];
    while (C.length < k) {           // k-means++
      const d = X.map(x => Math.min(...C.map(c => dist(x, c))));
      const total = U.sum(d);
      let r = rand() * total, idx = 0;
      while (idx < d.length - 1 && (r -= d[idx]) > 0) idx++;
      C.push(X[idx].slice());
    }
    let assign = new Array(X.length).fill(0);
    for (let it = 0; it < 40; it++) {
      let changed = false;
      X.forEach((x, i) => {
        let best = 0, bd = Infinity;
        C.forEach((c, j) => { const dd = dist(x, c); if (dd < bd) { bd = dd; best = j; } });
        if (assign[i] !== best) { assign[i] = best; changed = true; }
      });
      C.forEach((c, j) => {
        const members = X.filter((_, i) => assign[i] === j);
        if (members.length) c.forEach((_, f) => { c[f] = U.mean(members.map(m => m[f])); });
      });
      if (!changed && it > 0) break;
    }
    const inertia = U.sum(X.map((x, i) => dist(x, C[assign[i]])));
    return { C, assign, inertia };
  }

  function clusterContractors(rows, { k = 5, examples = 5 } = {}) {
    const stats = contractorStats(rows);
    if (stats.length < k * 4) return { error: `ผู้รับจ้างที่มีตั้งแต่ 3 สัญญามีเพียง ${stats.length} ราย น้อยเกินกว่าจะจัดกลุ่ม ${k} กลุ่ม` };
    const medHug = median(stats.map(c => c.ceilingHug).filter(x => x !== null)) ?? 0;
    const raw = stats.map(c => CLUSTER_FEATURES.map(([id, , f]) => (id === 'ceilingHug' && c.ceilingHug === null ? medHug : f(c))));
    const mu = CLUSTER_FEATURES.map((_, j) => U.mean(raw.map(x => x[j])));
    const sd = CLUSTER_FEATURES.map((_, j) => Math.sqrt(U.mean(raw.map(x => (x[j] - mu[j]) ** 2))) || 1);
    const X = raw.map(x => x.map((v, j) => (v - mu[j]) / sd[j]));
    const rand = rng(20260914);
    let best = null;
    for (let t = 0; t < 6; t++) {       // หลายจุดเริ่ม เลือกผลที่กระชับที่สุด ผลจึงเหมือนเดิมทุกครั้งที่กด
      const res = kmeans(X, k, rand);
      if (!best || res.inertia < best.inertia) best = res;
    }
    const clusters = best.C.map((_, j) => {
      const members = stats.filter((_, i) => best.assign[i] === j);
      const rawMembers = raw.filter((_, i) => best.assign[i] === j);
      return {
        id: j + 1, size: members.length, value: U.sum(members.map(c => c.value)),
        profile: CLUSTER_FEATURES.map(([id, label], f) => ({
          id, label, mean: round(U.mean(rawMembers.map(x => x[f])), 3),
          z: round(U.mean(X.filter((_, i) => best.assign[i] === j).map(x => x[f])), 2),
        })),
        flaggedShare: U.mean(members.map(c => c.flaggedShare)),
        examples: [...members].sort((a, b) => b.value - a.value).slice(0, examples)
          .map(c => ({ name: c.name, n: c.n, value: c.value, avgScore: round(c.avgScore, 1), archetypes: c.archetypes })),
      };
    }).sort((a, b) => b.size - a.size);
    return { n: stats.length, k, clusters, features: CLUSTER_FEATURES.map(([id, label]) => ({ id, label })) };
  }

  /** ตัวเลขเด่นย่อ ๆ สำหรับแผนการตรวจสอบ */
  function highlights(rows) {
    const cb = contractorBehavior(rows, { top: 0 });
    const pp = pairPatterns(rows, { top: 0 });
    const tp = timePatterns(rows, { top: 0 });
    const pr = pricePatterns(rows, { top: 0 });
    return { archetypes: cb.archetypes.map(a => ({ label: a.label, count: a.count })), nMutual: pp.nMutual,
      nRotation: pp.nRotation, nSpread: tp.nSpread, nBursts: tp.nBursts, ceiling: pr.ceiling,
      zeroDiscountShare: pr.discountBins[0].share, nSamePrice: pr.nSamePrice };
  }

  return { init, ARCHETYPES, contractorStats, contractorBehavior, pairPatterns, timePatterns, pricePatterns, clusterContractors, highlights, discount };
})();
