/* =============================================================================
   names.js — วิเคราะห์ชื่อโครงการ: แยกส่วนประกอบ จัดกลุ่มงาน จัดหมวดวัตถุประสงค์
              และหาสัญญาณที่อ่านได้จากชื่อ

   ทำไมต้องปรับพจนานุกรมได้เอง
     ชื่อโครงการเขียนคนละสำนวนกันในแต่ละหน่วยงานและแต่ละชุดข้อมูล พจนานุกรมที่ใช้ได้ดีกับ
     ชุดงานประปา จะครอบคลุมงานถนนหรืองานอาคารได้น้อยลงทันที ผู้ใช้จึงต้องแก้คำเองได้
     แล้วบันทึกเป็น "โปรไฟล์" ไว้ใช้กับชุดข้อมูลถัดไป

   ทำไมยังเป็นพจนานุกรมคำ ไม่ใช่โมเดล
     งานตรวจสอบต้องตอบได้ว่า "ทำไมสัญญานี้อยู่กลุ่มนี้" ซึ่งเป็นเหตุผลเดียวกับที่ ETL
     เคยลอง TF-IDF + k-means แล้วเลิกใช้ (tools/ds_models.py:234) — กลุ่มที่ได้แยกตาม
     สำนวนการเขียน ไม่ใช่ชนิดงาน
   ============================================================================= */

const Names = (() => {
  'use strict';

  const STORE = 'pa_name_profiles_v1';
  const ACTIVE = 'pa_name_profile_active_v1';

  /* ---------------------------------------------------------------------------
     1) ส่วนประกอบของชื่อ — ตรวจว่าชุดข้อมูลนี้เขียนชื่ออย่างไร
     ใช้ตอบคำถามแรกสุดว่า "ชื่อในชุดนี้แกะอะไรออกมาได้บ้าง" ก่อนจะลงแรงทำอย่างอื่น
     --------------------------------------------------------------------------- */

  const ANATOMY = [
    { key: 'method', label: 'วิธีจัดหา (ท้ายชื่อ)', rx: /ด้วยวิธี|โดยวิธี/, use: 'ตรวจความสอดคล้องกับคอลัมน์วิธีจัดหา' },
    { key: 'village', label: 'หมู่ที่ / ชื่อบ้าน', rx: /หมู่ที่\s*[\d๐-๙]|หมู่\s*[\d๐-๙]|บ้าน[ก-ฮ]/, use: 'ระบุที่ตั้งงานได้แม้ไม่มีพิกัด' },
    { key: 'admin', label: 'ตำบล / อำเภอ / จังหวัด', rx: /ตำบล|ต\.[ก-ฮ]|อำเภอ|อ\.[ก-ฮ]|จังหวัด|จ\.[ก-ฮ]/, use: 'เทียบกับจังหวัดของหน่วยงาน' },
    { key: 'size', label: 'ขนาด / เส้นผ่าศูนย์กลาง', rx: /ขนาด|Ø|เส้นผ่า|ศก\.|มม\.|นิ้ว/, use: 'ใช้แยกชั้นก่อนเทียบราคาต่อหน่วย' },
    { key: 'length', label: 'ความยาว / ระยะทาง', rx: /ความยาว|ระยะทาง|[\d,๐-๙.]+\s*(เมตร|ม\.|กม\.|กิโลเมตร)/, use: 'คิดราคาต่อเมตรได้' },
    { key: 'volume', label: 'ความจุ (ลบ.ม.)', rx: /ลบ\.?ม|ลูกบาศก์เมตร|ความจุ/, use: 'คิดราคาต่อลูกบาศก์เมตรได้' },
    { key: 'qty', label: 'จำนวน หน่วย ชุด แห่ง', rx: /จำนวน\s*[\d๐-๙,]+\s*(แห่ง|ชุด|ตัว|เครื่อง|อัตรา|ราย|จุด|หน่วย|รายการ)/, use: 'คิดราคาต่อหน่วยของงานซื้อและจ้างเหมา' },
    { key: 'year', label: 'ปีงบประมาณในชื่อ', rx: /ปีงบประมาณ|พ\.ศ\.\s*[๒2]/, use: 'ตรวจว่าตรงกับปีของสัญญา' },
    { key: 'again', label: 'ครั้งที่ 2 ขึ้นไป', rx: /ครั้งที่\s*[๒-๙2-9]/, use: 'งานที่ประกาศใหม่หลังยกเลิก' },
  ];

  function anatomy(records) {
    const n = records.length || 1;
    return ANATOMY.map(p => {
      const hits = records.filter(r => p.rx.test(r.project_name || ''));
      return {
        key: p.key, label: p.label, use: p.use,
        n: hits.length, pct: hits.length / n,
        sample: hits.slice(0, 2).map(r => r.project_name),
      };
    });
  }

  /* ---------------------------------------------------------------------------
     2) พจนานุกรม — กลุ่มงานและวัตถุประสงค์
     เก็บ pattern เป็นสตริง ไม่ใช่ RegExp เพื่อให้แก้ บันทึก และส่งออกเป็น JSON ได้
     --------------------------------------------------------------------------- */

  // ชุดตั้งต้นของกลุ่มงาน มาจาก tools/ds_models.py:242 (ผ่าน DataIO.WORK_GROUPS)
  const defaultGroups = () => DataIO.WORK_GROUPS.map(([key, label, rx]) => ({ key, label, pattern: rx.source, source: 'default' }));

  // หมวดวัตถุประสงค์ — วัดกับชุดข้อมูลประปาได้ครอบคลุมราว 61% ส่วนที่เหลือต้องขุดคำเพิ่มเอง
  const DEFAULT_PURPOSES = [
    { key: 'expand', label: 'ขยายบริการ / เพิ่มกำลังผลิต', pattern: 'ขยายเขต|เพิ่มกำลัง|ขยายกำลัง|ก่อสร้างระบบประปา|ขยายท่อ|เพิ่มประสิทธิภาพการผลิต' },
    { key: 'maintain', label: 'ซ่อมบำรุง / ฟื้นฟูสภาพ', pattern: 'ซ่อม|ปรับปรุง|บำรุงรักษา|ฟื้นฟู|เปลี่ยนท่อ|เปลี่ยนอุปกรณ์|ทดแทน' },
    { key: 'nrw', label: 'ลดน้ำสูญเสีย / ประสิทธิภาพ', pattern: 'น้ำสูญเสีย|แตกรั่ว|จุดรั่ว|DMA|สำรวจหาน้ำ' },
    { key: 'quality', label: 'คุณภาพน้ำ', pattern: 'คลอรีน|สารส้ม|สารกรอง|ทรายกรอง|ตรวจวิเคราะห์|คุณภาพน้ำ|น้ำดื่ม' },
    { key: 'urgent', label: 'ภัยพิบัติ / เร่งด่วน', pattern: 'ภัยแล้ง|ฉุกเฉิน|เร่งด่วน|อุทกภัย|ประสบภัย|ขาดแคลนน้ำ' },
    { key: 'admin', label: 'บริหาร / สนับสนุน', pattern: 'จ้างเหมาบุคคล|บุคคลภายนอก|รักษาความปลอดภัย|ทำความสะอาด|ที่ปรึกษา|สำรวจออกแบบ|ประชาสัมพันธ์|เช่าบริการ|อ่านมาตร' },
  ].map(p => ({ ...p, source: 'default' }));

  const defaultPurposes = () => DEFAULT_PURPOSES.map(p => ({ ...p }));

  /** คอมไพล์ครั้งเดียวต่อการวิเคราะห์ — pattern ที่ผู้ใช้พิมพ์เองอาจผิดรูป จึงข้ามเฉพาะตัวที่พัง */
  function compile(dict) {
    const out = [];
    for (const d of dict) {
      if (!d.pattern) continue;
      try { out.push({ ...d, rx: new RegExp(d.pattern) }); }
      catch (e) { out.push({ ...d, rx: null, error: String(e.message || e).slice(0, 80) }); }
    }
    return out;
  }

  /** คืนทุกกลุ่มที่ชื่อนี้เข้าข่าย (กลุ่มแรกคือกลุ่มหลัก ตามลำดับในพจนานุกรม) */
  function classify(name, compiled) {
    const text = String(name || '');
    const hits = [];
    for (const d of compiled) if (d.rx && d.rx.test(text)) hits.push(d.key);
    return hits;
  }

  /** สรุปว่าพจนานุกรมชุดนี้ทำงานกับชุดข้อมูลตรงหน้าได้ดีแค่ไหน */
  function analyze(records, dict, { unmatchedSample = 30 } = {}) {
    const compiled = compile(dict);
    const counts = {}, primary = {}, byCount = {}, overlaps = {};
    const unmatched = [];
    for (const d of dict) { counts[d.key] = 0; primary[d.key] = 0; }

    for (const r of records) {
      const hits = classify(r.project_name, compiled);
      byCount[hits.length] = (byCount[hits.length] || 0) + 1;
      if (!hits.length) { if (unmatched.length < 400) unmatched.push(r); continue; }
      primary[hits[0]]++;
      for (const k of hits) counts[k]++;
      for (let i = 0; i < hits.length; i++) {
        for (let j = i + 1; j < hits.length; j++) {
          const pair = [hits[i], hits[j]].sort().join('␀');
          overlaps[pair] = (overlaps[pair] || 0) + 1;
        }
      }
    }
    const n = records.length || 1;
    const matched = n - (byCount[0] || 0);
    return {
      n: records.length, matched, coverage: matched / n,
      counts, primary, byCount, compiled,
      multiShare: (n - (byCount[0] || 0) - (byCount[1] || 0)) / n,
      overlaps: Object.entries(overlaps).sort((a, b) => b[1] - a[1]).slice(0, 8)
        .map(([pair, v]) => ({ keys: pair.split('␀'), n: v })),
      unmatched: unmatched.slice(0, unmatchedSample),
      unmatchedTotal: byCount[0] || 0,
      errors: compiled.filter(c => c.error).map(c => ({ key: c.key, error: c.error })),
    };
  }

  /* ---------------------------------------------------------------------------
     3) ขุดคำจากชื่อที่ยังไม่เข้ากลุ่ม
     ภาษาไทยไม่เว้นวรรคระหว่างคำ การตัด n-gram ตามตำแหน่งตัวอักษรดิบ ๆ จึงได้เศษคำอย่าง "ะปาเ"
     (ลองแล้วกับข้อมูลจริง) วิธีที่ใช้จึงอาศัยโครงของชื่อโครงการภาครัฐแทน 3 ชั้น
       ก. ตัด "เปลือก" ที่ทุกชื่อมีเหมือนกันทิ้งก่อน — คำนำหน้า (ประกวดราคาซื้อ/จ้าง/เช่า)
          และหางวิธีจัดหา (ด้วยวิธี…/โดยวิธี…) ไม่งั้นคำที่ขุดได้จะเป็น "โดยวิธีเฉพาะเจาะจง" ทั้งหมด
       ข. ตั้งต้นที่ "ต้นวลี" เท่านั้น (หลังช่องว่าง/วงเล็บ) เพราะคำไทยที่ขึ้นต้นวลีคือคำจริงเสมอ
          แล้วค่อยขยายไปทางขวาทีละอักขระตราบที่ยังนับได้ ≥70% ของเดิม — จุดที่จำนวนตกฮวบคือจุดจบคำ
       ค. ขริบขอบตามอักขรวิธี: คำไทยไม่จบด้วยสระหน้า (เ แ โ ใ ไ) หรือวรรณยุกต์ลอย
          และไม่ขึ้นต้นด้วยสระตาม/ไม้ไต่คู้
     คำที่โผล่ทั้งฝั่ง "ยังไม่เข้ากลุ่ม" และฝั่ง "เข้ากลุ่มแล้ว" พอ ๆ กันไม่ช่วยแยกอะไร
     จึงต้องโผล่ฝั่งที่ยังไม่เข้ากลุ่มมากกว่าอย่างน้อย 3 เท่าจึงจะถูกเสนอ
     --------------------------------------------------------------------------- */

  const MINE_BOILER = /(ด้วยวิธี|โดยวิธี)[\s\S]*$/;
  const MINE_LEAD = /^\s*(ประกวดราคา|สอบราคา|ประกาศ)?\s*(จัดซื้อจัดจ้าง|จัดซื้อ|จัดจ้าง|ซื้อ|จ้างเหมา|จ้าง|เช่า)?\s*(งาน|โครงการ)?\s*/;
  const MINE_TAIL_BAD = /[เแโใไ่้๊๋์]$/;      // สระหน้า/วรรณยุกต์ลอยท้ายคำ = ตัดกลางคำ
  const MINE_HEAD_BAD = /^[ะัาำิีึืุู็่้๊๋์ๆฯๅ]/; // สระตาม/ไม้ไต่คู้ นำหน้าคำไม่ได้

  function mineStrip(s) {
    return String(s || '').replace(MINE_BOILER, '').replace(MINE_LEAD, '').replace(/\s+/g, ' ').trim();
  }
  function mineTrim(term) {
    let s = term;
    while (s && MINE_TAIL_BAD.test(s)) s = s.slice(0, -1);
    while (s && MINE_HEAD_BAD.test(s)) s = s.slice(1);
    return s.replace(/^[\s\-–—.,]+|[\s\-–—.,]+$/g, '');
  }

  function mineTerms(records, dict, { minCount = 3, minLen = 4, maxLen = 32, limit = 25, sample = 1500 } = {}) {
    const compiled = compile(dict);
    const unmatched = [], matched = [];
    for (const r of records) {
      const target = classify(r.project_name, compiled).length ? matched : unmatched;
      if (target.length < sample) target.push(String(r.project_name || ''));
      if (unmatched.length >= sample && matched.length >= sample) break;
    }
    if (!unmatched.length) return { terms: [], unmatched: 0, matchedSampled: matched.length };

    const unStripped = unmatched.map(mineStrip);
    const maStripped = matched.map(mineStrip);

    /* ก+ข: นับคำนำหน้าของทุกวลี นับครั้งเดียวต่อชื่อ กันชื่อเดียวดันคำเดียวขึ้นอันดับ */
    const cnt = new Map();
    const alphabet = new Set();
    for (const s of unStripped) {
      const seen = new Set();
      for (const raw of s.split(/[\s()"'“”/,]+/)) {
        const tk = raw.replace(/[0-9๐-๙]+/g, ' ').trim();
        if (tk.length < minLen) continue;
        for (const ch of tk) alphabet.add(ch);
        for (let len = minLen; len <= Math.min(tk.length, maxLen); len++) {
          const g = tk.slice(0, len);
          if (seen.has(g)) continue;
          seen.add(g);
          cnt.set(g, (cnt.get(g) || 0) + 1);
        }
      }
    }
    const chars = [...alphabet];

    /* ขยายไปทางขวาจนจำนวนตกต่ำกว่า 70% ของคำตั้งต้น = ขอบคำ */
    const grow = (seed) => {
      let cur = seed;
      const floor = cnt.get(seed) * 0.7;
      for (let guard = 0; guard < maxLen; guard++) {
        let next = null, best = 0;
        for (const ch of chars) {
          const n = cnt.get(cur + ch) || 0;
          if (n >= floor && n > best) { best = n; next = cur + ch; }
        }
        if (!next) break;
        cur = next;
      }
      return cur;
    };

    const pool = new Map();
    for (const [g, c] of cnt) {
      if (g.length !== minLen || c < minCount) continue;   // ตั้งต้นที่คำสั้นสุดของแต่ละสาย
      const grown = grow(g);
      const term = mineTrim(grown);
      if (term.length < minLen) continue;
      pool.set(term, Math.max(pool.get(term) || 0, cnt.get(grown) || c));
    }

    const scored = [...pool].map(([term, n]) => {
      let leak = 0;
      for (const s of maStripped) if (s.includes(term)) leak++;
      const hit = n / unStripped.length;
      const leakRate = leak / Math.max(1, maStripped.length);
      return { term, n, leak, hit, leakRate, score: hit - leakRate };
    }).filter(x => x.hit >= x.leakRate * 3)
      .sort((a, b) => b.score - a.score || b.n - a.n || b.term.length - a.term.length);

    /* หน่วยนับกับคำบอกปริมาณ ("รายการ" "กิโลกรัม" "ตารางเมตร" "แห่ง") โผล่บ่อยพอ ๆ กับคำที่มีความหมาย
       แต่ไม่บอกว่างานคืออะไร วัดได้จากที่มันตามหลังตัวเลขแทบทุกครั้ง จึงคัดออกด้วยข้อมูลเอง
       ไม่ต้องมีรายการคำต้องห้ามฝังไว้ (ซึ่งจะผูกกับชุดข้อมูลชุดนี้ชุดเดียว) */
    const afterNumber = (term) => {
      let hit = 0, total = 0;
      for (const s of unStripped) {
        let from = 0, i;
        while ((i = s.indexOf(term, from)) >= 0) {
          total++;
          if (/[0-9๐-๙][\s.,]*$/.test(s.slice(Math.max(0, i - 4), i))) hit++;
          from = i + term.length;
          if (total > 400) break;
        }
        if (total > 400) break;
      }
      return total ? hit / total : 0;
    };

    /* คำที่กินความกันเองเก็บอันเดียวพอ */
    const kept = [];
    for (const c of scored) {
      if (kept.some(k => k.term.includes(c.term) || c.term.includes(k.term))) continue;
      if (afterNumber(c.term) >= 0.6) continue;
      const i = unStripped.findIndex(s => s.includes(c.term));
      kept.push({ ...c, example: i < 0 ? '' : unmatched[i] });
      if (kept.length >= limit) break;
    }
    return { terms: kept, unmatched: unmatched.length, matchedSampled: matched.length };
  }

  /* ---------------------------------------------------------------------------
     4) สัญญาณที่อ่านได้จากชื่อ
     ทั้งสามข้อนี้วัดกับชุดข้อมูลหลักแล้วว่าพบของจริง ไม่ใช่การเดา
     --------------------------------------------------------------------------- */

  const tokenSet = s => new Set(String(s || '').replace(/[()"'“”]/g, ' ').split(/\s+/).filter(w => w.length > 2));
  const jaccard = (a, b) => { let i = 0; for (const t of a) if (b.has(t)) i++; const u = a.size + b.size - i; return u ? i / u : 0; };

  /** ชื่อคล้ายกันมากในหน่วยงานเดียวกัน ภายในกี่วันที่กำหนด
   *  ต่างจาก R10 ตรงที่ R10 ดูวันที่กับมูลค่า ส่วนข้อนี้ดู "เนื้องานที่เขียนเหมือนกัน" */
  function nearDuplicates(records, { minSim = 0.8, days = 30, limit = 60, maxPerDept = 400 } = {}) {
    const byDept = new Map();
    for (const r of records) {
      if (!r.contract_date) continue;
      let g = byDept.get(r.dept_key);
      if (!g) byDept.set(r.dept_key, g = []);
      g.push(r);
    }
    const out = [];
    let pairs = 0;
    for (const [dept, rows] of byDept) {
      if (rows.length < 2 || rows.length > maxPerDept) continue;
      const rs = rows.map(r => ({ r, t: tokenSet(r.project_name), d: Date.parse(r.contract_date + 'T00:00:00Z') }));
      for (let i = 0; i < rs.length; i++) {
        for (let j = i + 1; j < rs.length; j++) {
          if (Math.abs(rs[i].d - rs[j].d) > days * 864e5) continue;
          if (rs[i].r.project_id === rs[j].r.project_id) continue;
          const sim = jaccard(rs[i].t, rs[j].t);
          if (sim < minSim) continue;
          pairs++;
          if (out.length < limit) {
            out.push({
              dept, sim: Math.round(sim * 100) / 100,
              a: rs[i].r, b: rs[j].r,
              total: (rs[i].r.contract_price_agree || 0) + (rs[j].r.contract_price_agree || 0),
              gapDays: Math.round(Math.abs(rs[i].d - rs[j].d) / 864e5),
            });
          }
        }
      }
    }
    out.sort((a, b) => b.total - a.total);
    return { pairs, items: out };
  }

  const placeOf = name => {
    const m = String(name || '').match(/หมู่ที่\s*([\d๐-๙]+)/);
    const t = String(name || '').match(/(?:ตำบล|ต\.)\s*([ก-ฮ][ก-๙]*)/);
    return (m && t) ? `หมู่ ${m[1]} ต.${t[1]}` : null;
  };

  /** งานหลายครั้งที่จุดเดิมของหน่วยงานเดิม — คุณภาพงานหรือการตั้งงบซ้ำ */
  function repeatPlaces(records, { minTimes = 3, limit = 40 } = {}) {
    const groups = new Map();
    for (const r of records) {
      const p = placeOf(r.project_name);
      if (!p) continue;
      const key = r.dept_key + '␀' + p;
      let g = groups.get(key);
      if (!g) groups.set(key, g = { dept: r.dept_key, place: p, rows: [] });
      g.rows.push(r);
    }
    const hits = [...groups.values()].filter(g => g.rows.length >= minTimes)
      .map(g => ({ ...g, n: g.rows.length, value: g.rows.reduce((s, r) => s + (r.contract_price_agree || 0), 0) }))
      .sort((a, b) => b.n - a.n || b.value - a.value);
    return { placesParsed: groups.size, places: hits.length, contracts: hits.reduce((s, g) => s + g.n, 0), items: hits.slice(0, limit) };
  }

  /** จังหวัดที่เขียนในชื่อ ไม่ตรงกับจังหวัดของหน่วยงาน — ใช้ได้แม้ไม่มีพิกัด (ต่างจาก R17) */
  function provinceMismatch(records, { limit = 40 } = {}) {
    const rx = /จังหวัด\s*([ก-ฮ][ก-๙]+)/;
    let named = 0;
    const items = [];
    for (const r of records) {
      const m = String(r.project_name || '').match(rx);
      if (!m || !r.province) continue;
      named++;
      const inName = m[1];
      if (inName.startsWith(r.province.slice(0, 4))) continue;
      items.push({ r, inName, agencyProvince: r.province });
    }
    items.sort((a, b) => (b.r.contract_price_agree || 0) - (a.r.contract_price_agree || 0));
    return { named, mismatch: items.length, pct: named ? items.length / named : 0, items: items.slice(0, limit) };
  }

  /* ---------------------------------------------------------------------------
     5) นำผลไปใช้กับชุดข้อมูล
     --------------------------------------------------------------------------- */

  /** เขียนผลการจัดกลุ่มลงระเบียน: กลุ่มหลักไว้ใช้กับตัวกรองและกราฟ ทุกกลุ่มไว้ใช้ตอนค้นหา */
  function applyGroups(records, dict, { primaryField = 'work_group', allField = 'work_groups', fallback = 'other' } = {}) {
    const compiled = compile(dict);
    const counts = {};
    for (const r of records) {
      const hits = classify(r.project_name, compiled);
      r[primaryField] = hits[0] || fallback;
      r[allField] = hits;
      counts[r[primaryField]] = (counts[r[primaryField]] || 0) + 1;
    }
    return counts;
  }

  /* ---------------------------------------------------------------------------
     6) โปรไฟล์ที่บันทึกไว้ — เก็บทั้งพจนานุกรมและผลที่วัดได้ตอนบันทึก
     เก็บผลไว้ด้วยเพื่อให้เทียบได้ว่าพอเอาไปใช้กับชุดข้อมูลอื่นแล้วครอบคลุมลดลงแค่ไหน
     --------------------------------------------------------------------------- */

  function listProfiles() {
    try {
      const v = JSON.parse(localStorage.getItem(STORE));
      return Array.isArray(v) ? v : [];
    } catch (e) { return []; }
  }

  function writeProfiles(list) {
    try { localStorage.setItem(STORE, JSON.stringify(list)); return true; }
    catch (e) { return false; }
  }

  function saveProfile(profile) {
    const list = listProfiles();
    const now = new Date().toISOString();
    const id = profile.id || 'np_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
    const entry = { ...profile, id, updated: now, created: profile.created || now };
    const at = list.findIndex(p => p.id === id);
    if (at >= 0) list[at] = entry; else list.unshift(entry);
    writeProfiles(list.slice(0, 40));
    return entry;
  }

  const getProfile = id => listProfiles().find(p => p.id === id) || null;
  const deleteProfile = id => writeProfiles(listProfiles().filter(p => p.id !== id));

  function activeProfileId() {
    try { return localStorage.getItem(ACTIVE) || ''; } catch (e) { return ''; }
  }
  function setActiveProfile(id) {
    try { if (id) localStorage.setItem(ACTIVE, id); else localStorage.removeItem(ACTIVE); } catch (e) { /* ไม่สำคัญ */ }
  }

  return {
    ANATOMY, anatomy,
    defaultGroups, defaultPurposes, compile, classify, analyze, mineTerms,
    nearDuplicates, repeatPlaces, provinceMismatch, placeOf,
    applyGroups,
    listProfiles, saveProfile, getProfile, deleteProfile, activeProfileId, setActiveProfile,
  };
})();
