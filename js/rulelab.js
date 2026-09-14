/* =========================================================
   ห้องทดลองกฎ (Rule Lab)
   =========================================================

   กฎที่ผู้ใช้หรือ AI สร้างถูกเก็บเป็น "ข้อมูล" (JSON) ไม่ใช่โค้ด
   ทุกเงื่อนไขต้องใช้ฟิลด์ ตัวดำเนินการ และค่าจากรายการที่กำหนดไว้เท่านั้น
   จึงรันกฎที่ AI เขียนได้อย่างปลอดภัย และตรวจได้ก่อนว่ากฎจะทำอะไร

   รูปแบบกฎ:
   {
     "name": "ชื่อกฎ", "description": "เหตุผล", "severity": "low|medium|high|critical",
     "weight": 1-40, "category": "ราคา|การแข่งขัน|โครงสร้างสัญญา|ผู้รับจ้าง|วิธีจัดหา|ภูมิศาสตร์|เอกสาร/ข้อมูล",
     "match": "all|any",
     "conditions": [ { "field": "...", "op": "...", "value": ... } ]
   }

   ไฟล์นี้ยังมีการขุดกฎความสัมพันธ์ (Apriori) และตัวชี้วัดสุขภาพของกฎ
   ทั้งหมดคำนวณในเบราว์เซอร์จากระเบียนที่มีอยู่ ไม่ส่งข้อมูลออกไปไหน */

const RuleLab = (() => {
  const STORE = 'pa_custom_rules_v1';
  const CATEGORIES = ['ราคา', 'การแข่งขัน', 'โครงสร้างสัญญา', 'ผู้รับจ้าง', 'วิธีจัดหา', 'ภูมิศาสตร์', 'เอกสาร/ข้อมูล'];
  const SEVERITIES = ['low', 'medium', 'high', 'critical'];

  let RECORDS = [];
  let vocab = {};

  const methodGroup = m => (/เฉพาะเจาะจง/.test(m || '') ? 'เฉพาะเจาะจง' : /e-bidding|ประกวดราคา/.test(m || '') ? 'e-bidding'
    : /คัดเลือก/.test(m || '') ? 'คัดเลือก' : 'อื่น ๆ');

  /* ---------- ฟิลด์ที่กฎใช้ได้ ---------- */

  const FIELDS = {
    contract_price_agree: { label: 'มูลค่าสัญญา', type: 'num', unit: 'บาท', get: r => r.contract_price_agree },
    price_build: { label: 'ราคากลาง', type: 'num', unit: 'บาท', get: r => r.price_build },
    project_money: { label: 'วงเงินโครงการ', type: 'num', unit: 'บาท', get: r => r.project_money },
    discount_pct: { label: 'ส่วนลดจากราคากลาง', type: 'num', unit: '%', note: 'เฉพาะโครงการสัญญาเดียว', get: r => r._rl.discount },
    duration_days: { label: 'ระยะเวลาสัญญา', type: 'num', unit: 'วัน', get: r => r.duration_days },
    announce_gap_days: { label: 'วันจากประกาศถึงลงนาม', type: 'num', unit: 'วัน', get: r => r.announce_gap_days },
    ml_pct: { label: 'เปอร์เซ็นไทล์ความผิดปกติ (Isolation Forest)', type: 'num', unit: '', get: r => r.ml_pct },
    project_n_contracts: { label: 'จำนวนสัญญาในโครงการ', type: 'num', unit: 'สัญญา', get: r => r._rl.projectN },
    contract_day: { label: 'วันที่ของเดือนที่ลงนาม', type: 'num', unit: '', get: r => r._rl.day },
    contractor_n_contracts: { label: 'จำนวนสัญญาของผู้รับจ้าง (ทั้งชุด)', type: 'num', unit: 'สัญญา', get: r => r._rl.cN },
    contractor_n_agencies: { label: 'จำนวนหน่วยงานที่ผู้รับจ้างได้งาน', type: 'num', unit: 'แห่ง', get: r => r._rl.cAg },
    contractor_top_agency_share: { label: 'สัดส่วนมูลค่าจากหน่วยงานหลักของผู้รับจ้าง', type: 'num', unit: '0-1', get: r => r._rl.cTop },
    contractor_specific_share: { label: 'สัดส่วนวิธีเฉพาะเจาะจงของผู้รับจ้าง', type: 'num', unit: '0-1', get: r => r._rl.cSpec },
    contractor_burst30: { label: 'สัญญาสูงสุดที่ผู้รับจ้างได้จากหน่วยงานเดียวใน 30 วัน', type: 'num', unit: 'สัญญา', get: r => r._rl.cBurst },
    pair_n_contracts: { label: 'จำนวนสัญญาของคู่หน่วยงาน-ผู้รับจ้างนี้', type: 'num', unit: 'สัญญา', get: r => r._rl.pairN },
    pair_share_of_agency: { label: 'สัดส่วนมูลค่าของหน่วยงานที่ไปที่ผู้รับจ้างรายนี้', type: 'num', unit: '0-1', get: r => r._rl.pairShare },
    purchase_method_name: { label: 'วิธีจัดหา', type: 'cat', get: r => r.purchase_method_name },
    method_group: { label: 'กลุ่มวิธีจัดหา', type: 'cat', get: r => r._rl.methodGroup },
    project_type_name: { label: 'ประเภทโครงการ', type: 'cat', get: r => r.project_type_name },
    work_group: { label: 'กลุ่มงาน', type: 'cat', get: r => r.work_group },
    province: { label: 'จังหวัดของหน่วยงาน', type: 'cat', get: r => r.province },
    geo_quality: { label: 'คุณภาพพิกัด', type: 'cat', get: r => r._rl.geo },
    project_name: { label: 'ชื่อโครงการ', type: 'text', get: r => r.project_name },
    dept_name: { label: 'ชื่อหน่วยงาน', type: 'text', get: r => r.dept_name },
    is_jv: { label: 'เป็นกิจการร่วมค้า', type: 'bool', get: r => !!r.is_jv },
    tin_is_masked: { label: 'เลขผู้เสียภาษีถูกปิดบัง', type: 'bool', get: r => !!r.tin_is_masked },
    weekend: { label: 'ลงนามวันเสาร์-อาทิตย์', type: 'bool', get: r => r._rl.weekend },
    month_end: { label: 'ลงนามวันที่ 25 ถึงสิ้นเดือน', type: 'bool', get: r => r._rl.monthEnd },
    rule_hit: { label: 'ติดกฎ', type: 'rule', get: r => (r.rule_hits || []).map(h => h.rule_id) },
    contractor_archetype: { label: 'รูปแบบพฤติกรรมผู้รับจ้าง', type: 'set', get: r => r._rl.arch },
  };

  const OPS = {
    num: ['>', '>=', '<', '<=', '==', '!=', 'between'],
    cat: ['==', '!=', 'in', 'not_in'],
    text: ['contains', 'not_contains'],
    bool: ['is'],
    rule: ['has', 'not_has'],
    set: ['has', 'not_has'],
  };
  const OP_LABEL = { '>': 'มากกว่า', '>=': 'ตั้งแต่', '<': 'น้อยกว่า', '<=': 'ไม่เกิน', '==': 'เท่ากับ', '!=': 'ไม่เท่ากับ',
    between: 'อยู่ระหว่าง', in: 'เป็นหนึ่งใน', not_in: 'ไม่ใช่', contains: 'มีคำว่า', not_contains: 'ไม่มีคำว่า',
    is: 'เป็น', has: 'มี', not_has: 'ไม่มี' };

  /* ---------- เตรียมตัวแปรต่อระเบียน ---------- */

  function init(records) {
    RECORDS = records;
    const projectN = U.countBy(records, r => r.project_id);
    const stats = new Map(Patterns.contractorStats(records, { minContracts: 1 }).map(c => [c.key, c]));
    const pairN = U.countBy(records, r => r.dept_key + '|' + r.winner_key);
    const pairV = new Map(), agencyV = new Map();
    for (const r of records) {
      const v = r.contract_price_agree || 0;
      pairV.set(r.dept_key + '|' + r.winner_key, (pairV.get(r.dept_key + '|' + r.winner_key) || 0) + v);
      agencyV.set(r.dept_key, (agencyV.get(r.dept_key) || 0) + v);
    }
    for (const r of records) {
      const d = r.contract_date ? new Date(r.contract_date + 'T00:00:00') : null;
      const c = stats.get(r.winner_key);
      const disc = Patterns.discount(r);
      const pk = r.dept_key + '|' + r.winner_key;
      r._rl = {
        discount: disc === null ? null : Math.round(disc * 1000) / 10,
        projectN: projectN.get(r.project_id) || 1,
        day: d ? d.getDate() : null,
        weekend: d ? (d.getDay() === 0 || d.getDay() === 6) : false,
        monthEnd: d ? d.getDate() >= 25 : false,
        methodGroup: methodGroup(r.purchase_method_name),
        geo: r.lat === null || r.lat === undefined ? 'none' : (r.geo_quality === 'shared' ? 'shared' : 'ok'),
        cN: c ? c.n : 1, cAg: c ? c.nAgencies : 1, cTop: c ? Math.round(c.topAgencyShare * 1000) / 1000 : 1,
        cSpec: c ? Math.round(c.specificShare * 1000) / 1000 : 0, cBurst: c ? c.burst30 : 1,
        arch: c ? c.archetypes : [],
        pairN: pairN.get(pk) || 1,
        pairShare: agencyV.get(r.dept_key) ? Math.round(pairV.get(pk) / agencyV.get(r.dept_key) * 1000) / 1000 : 0,
      };
    }
    const uniq = f => [...new Set(records.map(f).filter(Boolean))].sort((a, b) => String(a).localeCompare(String(b), 'th'));
    vocab = {
      purchase_method_name: uniq(r => r.purchase_method_name),
      method_group: ['เฉพาะเจาะจง', 'e-bidding', 'คัดเลือก', 'อื่น ๆ'],
      project_type_name: uniq(r => r.project_type_name),
      work_group: uniq(r => r.work_group),
      province: uniq(r => r.province),
      geo_quality: ['ok', 'shared', 'none'],
      rule_hit: () => Rules.DEFS.map(d => d.id),
      contractor_archetype: Patterns.ARCHETYPES.map(a => a.id),
    };
  }

  const vocabOf = field => (typeof vocab[field] === 'function' ? vocab[field]() : vocab[field] || []);

  /* ---------- ตรวจความถูกต้อง ---------- */

  function validate(input) {
    const errors = [];
    let rule = input;
    if (typeof input === 'string') {
      try { rule = JSON.parse(input); } catch (e) { return { ok: false, errors: [`อ่าน JSON ไม่ได้: ${e.message}`] }; }
    }
    if (!rule || typeof rule !== 'object' || Array.isArray(rule)) return { ok: false, errors: ['กฎต้องเป็นวัตถุ JSON'] };
    const out = {
      name: String(rule.name || '').trim().slice(0, 80),
      description: String(rule.description || '').trim().slice(0, 400),
      severity: SEVERITIES.includes(rule.severity) ? rule.severity : 'medium',
      weight: Math.max(1, Math.min(40, Math.round(Number(rule.weight) || 10))),
      category: CATEGORIES.includes(rule.category) ? rule.category : 'การแข่งขัน',
      match: rule.match === 'any' ? 'any' : 'all',
      conditions: [],
    };
    if (!out.name) errors.push('ต้องมีชื่อกฎ (name)');
    if (!Array.isArray(rule.conditions) || !rule.conditions.length) errors.push('ต้องมีเงื่อนไขอย่างน้อย 1 ข้อ (conditions)');
    (rule.conditions || []).slice(0, 8).forEach((c, i) => {
      const where = `เงื่อนไขที่ ${i + 1}`;
      const f = FIELDS[c?.field];
      if (!f) { errors.push(`${where}: ไม่รู้จักฟิลด์ "${c?.field}"`); return; }
      if (!OPS[f.type].includes(c.op)) { errors.push(`${where}: ฟิลด์ ${c.field} ใช้ตัวดำเนินการ ${OPS[f.type].join(', ')} เท่านั้น`); return; }
      let value = c.value;
      if (f.type === 'num') {
        if (c.op === 'between') {
          if (!Array.isArray(value) || value.length !== 2 || !value.every(v => Number.isFinite(Number(v)))) { errors.push(`${where}: between ต้องเป็น [ต่ำสุด, สูงสุด]`); return; }
          value = value.map(Number).sort((a, b) => a - b);
        } else if (!Number.isFinite(Number(value))) { errors.push(`${where}: ค่าต้องเป็นตัวเลข`); return; } else value = Number(value);
      } else if (f.type === 'cat' || f.type === 'rule' || f.type === 'set') {
        const list = vocabOf(c.field);
        const vals = Array.isArray(value) ? value.map(String) : [String(value ?? '')];
        const bad = vals.filter(v => !list.includes(v));
        if (bad.length) { errors.push(`${where}: ค่า ${bad.map(b => `"${b}"`).join(', ')} ไม่มีในข้อมูลของฟิลด์ ${c.field}`); return; }
        value = ['in', 'not_in'].includes(c.op) ? vals : vals[0];
      } else if (f.type === 'text') {
        value = String(value ?? '').trim();
        if (value.length < 2) { errors.push(`${where}: คำค้นต้องยาวอย่างน้อย 2 ตัวอักษร`); return; }
      } else if (f.type === 'bool') {
        value = value === true || value === 'true';
      }
      out.conditions.push({ field: c.field, op: c.op, value });
    });
    if ((rule.conditions || []).length > 8) errors.push('ใช้เงื่อนไขได้ไม่เกิน 8 ข้อ');
    return { ok: !errors.length, rule: out, errors };
  }

  /* ---------- แปลงเป็นฟังก์ชันและคำอธิบาย ---------- */

  function testCondition(c, r) {
    const f = FIELDS[c.field];
    const v = f.get(r);
    switch (f.type) {
      case 'num':
        if (v === null || v === undefined || !Number.isFinite(v)) return false;
        if (c.op === '>') return v > c.value;
        if (c.op === '>=') return v >= c.value;
        if (c.op === '<') return v < c.value;
        if (c.op === '<=') return v <= c.value;
        if (c.op === '==') return v === c.value;
        if (c.op === '!=') return v !== c.value;
        return v >= c.value[0] && v <= c.value[1];
      case 'cat':
        if (c.op === '==') return v === c.value;
        if (c.op === '!=') return v !== c.value;
        if (c.op === 'in') return c.value.includes(v);
        return !c.value.includes(v);
      case 'text': {
        const has = String(v || '').toLowerCase().includes(c.value.toLowerCase());
        return c.op === 'contains' ? has : !has;
      }
      case 'bool': return v === c.value;
      case 'rule': case 'set': {
        const has = (v || []).includes(c.value);
        return c.op === 'has' ? has : !has;
      }
      default: return false;
    }
  }

  function compile(rule) {
    const conds = rule.conditions;
    return rule.match === 'any' ? r => conds.some(c => testCondition(c, r)) : r => conds.every(c => testCondition(c, r));
  }

  function valueText(c) {
    const f = FIELDS[c.field];
    const fmt = v => {
      if (f.type !== 'num') {
        if (c.field === 'work_group' && typeof workGroupName === 'function') return workGroupName(v);
        if (c.field === 'contractor_archetype') return Patterns.ARCHETYPES.find(a => a.id === v)?.label || v;
        return v;
      }
      return f.unit === 'บาท' ? `${U.num(v)} บาท` : f.unit === '%' ? `${v}%` : `${U.num(v)}${f.unit && f.unit !== '0-1' ? ' ' + f.unit : ''}`;
    };
    if (f.type === 'bool') return c.value ? 'ใช่' : 'ไม่ใช่';
    if (c.op === 'between') return `${fmt(c.value[0])} ถึง ${fmt(c.value[1])}`;
    if (Array.isArray(c.value)) return c.value.map(fmt).join(', ');
    return fmt(c.value);
  }

  let workGroupName = null;
  function setWorkGroupLabeler(fn) { workGroupName = fn; }

  function describeCondition(c) {
    return `${FIELDS[c.field].label} ${OP_LABEL[c.op]} ${valueText(c)}`;
  }
  function describe(rule) {
    return rule.conditions.map(describeCondition).join(rule.match === 'any' ? ' หรือ ' : ' และ ');
  }

  /* ---------- ทดสอบย้อนหลัง ---------- */

  function backtest(rule, records = RECORDS) {
    const test = compile(rule);
    const hits = records.filter(r => { try { return test(r); } catch (e) { return false; } });
    const n = records.length;
    const value = U.sum(hits.map(r => r.contract_price_agree));
    const bands = Object.fromEntries(Rules.BANDS.map(b => [b.key, hits.filter(r => r.risk_band === b.key).length]));
    const unflagged = hits.filter(r => !(r.rule_hits || []).some(h => h.source === 'real')).length;
    const pri = r => r.risk_band === 'critical' || r.risk_band === 'high';
    const newPriority = hits.filter(r => !pri(r) && Math.min(100, (r.risk_score || 0) + rule.weight) >= 40).length;

    // ความสอดคล้องกับโมเดลความผิดปกติ — ใช้เป็นตัวแทนความแม่นยำ ไม่ใช่ความจริง
    const withMl = records.filter(r => r.ml_pct !== null && r.ml_pct !== undefined);
    const baseMl = withMl.length ? withMl.filter(r => r.ml_pct >= 90).length / withMl.length : 0;
    const hitMl = hits.filter(r => r.ml_pct !== null && r.ml_pct !== undefined);
    const hitMlShare = hitMl.length ? hitMl.filter(r => r.ml_pct >= 90).length / hitMl.length : null;

    const overlaps = Rules.DEFS.filter(d => !d.custom || d.id !== rule.id).map(d => {
      const withRule = hits.filter(r => (r.rule_hits || []).some(h => h.rule_id === d.id)).length;
      const ruleTotal = records.filter(r => (r.rule_hits || []).some(h => h.rule_id === d.id)).length;
      const union = hits.length + ruleTotal - withRule;
      return { id: d.id, name: d.name, both: withRule, ruleTotal, jaccard: union ? withRule / union : 0, shareOfHits: hits.length ? withRule / hits.length : 0 };
    }).filter(o => o.both > 0).sort((a, b) => b.jaccard - a.jaccard).slice(0, 6);

    const months = [...U.groupBy(hits.filter(r => r.contract_date), r => r.contract_date.slice(0, 7))]
      .sort((a, b) => a[0].localeCompare(b[0])).map(([m, rs]) => [m, rs.length]);

    return {
      n, hits, hitCount: hits.length, share: n ? hits.length / n : 0, value,
      bands, unflagged, newPriority, baseMl, hitMlShare, mlLift: hitMlShare !== null && baseMl ? hitMlShare / baseMl : null,
      overlaps, months,
      agencies: new Set(hits.map(r => r.dept_key)).size, contractors: new Set(hits.map(r => r.winner_key)).size,
      examples: [...hits].sort((a, b) => (b.contract_price_agree || 0) - (a.contract_price_agree || 0)).slice(0, 10),
    };
  }

  /* ---------- เก็บและลงทะเบียนกฎ ---------- */

  function loadSaved() {
    try { const v = JSON.parse(localStorage.getItem(STORE)); return Array.isArray(v) ? v : []; } catch (e) { return []; }
  }
  function saveAll(list) {
    try { localStorage.setItem(STORE, JSON.stringify(list)); } catch (e) { /* โควตาเต็ม */ }
  }

  function toDef(saved) {
    const rule = saved.rule;
    const test = compile(rule);
    return {
      id: saved.id, name: rule.name, severity: rule.severity, weight: rule.weight, category: rule.category,
      source: 'real', custom: true, created: saved.created,
      desc: rule.description || `กฎที่สร้างเอง: ${describe(rule)}`,
      thresholds: {},
      logic: () => describe(rule),
      evaluate(r) {
        if (!test(r)) return null;
        const shown = rule.conditions.slice(0, 3).map(c => {
          const f = FIELDS[c.field];
          const v = f.get(r);
          if (f.type === 'rule' || f.type === 'set') return null;
          const vv = f.type === 'num' ? (f.unit === 'บาท' ? U.num(v) : v) : f.type === 'bool' ? (v ? 'ใช่' : 'ไม่ใช่') : v;
          return `${f.label} ${vv}`;
        }).filter(Boolean);
        return { actual: shown.length ? shown.join(' · ') : 'ตรงเงื่อนไขของกฎที่สร้างเอง' };
      },
    };
  }

  function registerSaved(settings) {
    for (const s of loadSaved()) {
      const v = validate(s.rule);
      if (v.ok) Rules.addCustomRule(toDef({ ...s, rule: v.rule }), settings);
    }
  }

  function addRule(rule, settings) {
    const list = loadSaved();
    const used = new Set([...list.map(s => s.id), ...Rules.DEFS.map(d => d.id)]);
    let i = 1;
    while (used.has('C' + i)) i++;
    const saved = { id: 'C' + i, rule, created: new Date().toISOString() };
    list.push(saved);
    saveAll(list);
    Rules.addCustomRule(toDef(saved), settings);
    return saved.id;
  }

  function deleteRule(id, settings) {
    saveAll(loadSaved().filter(s => s.id !== id));
    return Rules.removeCustomRule(id, settings);
  }

  /* ---------- ขุดกฎความสัมพันธ์ (Apriori บน bitset) ---------- */

  const VALUE_BINS = [[0, 1e5, '≤1 แสน'], [1e5, 5e5, '1-5 แสน'], [5e5, 2e6, '5 แสน-2 ล้าน'], [2e6, 1e7, '2-10 ล้าน'], [1e7, Infinity, '>10 ล้าน']];

  function traitItems(r, labelWG) {
    const items = [];
    const push = (key, label, cond) => items.push({ key, label, conds: Array.isArray(cond) ? cond : [cond] });
    const mg = r._rl.methodGroup;
    push('mg:' + mg, `วิธี: ${mg}`, { field: 'method_group', op: '==', value: mg });
    if (r.project_type_name) push('pt:' + r.project_type_name, `ประเภท: ${r.project_type_name}`, { field: 'project_type_name', op: '==', value: r.project_type_name });
    if (r.work_group && r.work_group !== 'other') push('wg:' + r.work_group, `กลุ่มงาน: ${labelWG(r.work_group)}`, { field: 'work_group', op: '==', value: r.work_group });
    const v = r.contract_price_agree || 0;
    const bin = VALUE_BINS.find(b => v >= b[0] && v < b[1]);
    if (bin) push('vb:' + bin[2], `มูลค่า ${bin[2]}`, { field: 'contract_price_agree', op: 'between', value: [bin[0], bin[1] === Infinity ? 1e12 : bin[1] - 0.01] });
    if (v >= 450000 && v < 500000) push('near', 'มูลค่าชิดใต้เพดาน 4.5-5 แสน', { field: 'contract_price_agree', op: 'between', value: [450000, 499999.99] });
    const d = r._rl.discount;
    if (d !== null) {
      if (d <= 0.05) push('d0', 'ไม่ลดราคา', { field: 'discount_pct', op: '<=', value: 0.05 });
      // ส่วนลดถูกปัดเป็นทศนิยม 1 ตำแหน่งตอนเตรียมข้อมูล ช่วง 0.1-1 จึงตรงกับเงื่อนไข d > 0.05 && d <= 1 ทุกค่า
      else if (d <= 1) push('d1', 'ลดราคาไม่ถึง 1%', { field: 'discount_pct', op: 'between', value: [0.1, 1] });
      else if (d > 15) push('d15', 'ลดราคาเกิน 15%', { field: 'discount_pct', op: '>', value: 15 });
    }
    if (r._rl.projectN > 1) push('multi', 'โครงการแบ่งหลายสัญญา', { field: 'project_n_contracts', op: '>', value: 1 });
    if (r._rl.weekend) push('wkend', 'ลงนามวันหยุด', { field: 'weekend', op: 'is', value: true });
    if (r._rl.monthEnd) push('mend', 'ลงนามปลายเดือน', { field: 'month_end', op: 'is', value: true });
    if (r._rl.geo === 'shared') push('gshared', 'พิกัดใช้ร่วมหลายโครงการ', { field: 'geo_quality', op: '==', value: 'shared' });
    if (r.is_jv) push('jv', 'กิจการร่วมค้า', { field: 'is_jv', op: 'is', value: true });
    if (r.tin_is_masked) push('tin', 'เลขผู้เสียภาษีถูกปิดบัง', { field: 'tin_is_masked', op: 'is', value: true });
    // ลักษณะนี้มีสองเงื่อนไข ต้องแปลงเป็นกฎครบทั้งคู่ ไม่งั้นกฎที่ได้จะกว้างกว่าที่ขุดพบ
    if (r._rl.pairShare >= 0.5 && r._rl.pairN >= 3) push('pair', 'ผู้รับจ้างครองงานของหน่วยงาน ≥50%', [{ field: 'pair_share_of_agency', op: '>=', value: 0.5 }, { field: 'pair_n_contracts', op: '>=', value: 3 }]);
    for (const a of r._rl.arch) {
      if (a === 'wide') continue;
      push('ar:' + a, `ผู้รับจ้าง: ${Patterns.ARCHETYPES.find(x => x.id === a)?.label || a}`, { field: 'contractor_archetype', op: 'has', value: a });
    }
    return items;
  }

  function popcount32(x) { x -= (x >>> 1) & 0x55555555; x = (x & 0x33333333) + ((x >>> 2) & 0x33333333); return (((x + (x >>> 4)) & 0x0F0F0F0F) * 0x01010101) >>> 24; }
  function andCount(a, b, out) {
    let n = 0;
    for (let i = 0; i < a.length; i++) { const w = a[i] & b[i]; if (out) out[i] = w; n += popcount32(w); }
    return n;
  }

  /** mode: 'traits' = ลักษณะ ⇒ สัญญาควรตรวจก่อน · 'rules' = กฎ ⇒ กฎ (กฎที่มักติดพร้อมกัน) */
  function mine(records, { mode = 'traits', minSupport = 30, minConf = 0.5, minLift = 1.3, maxLen = 3, labelWG = x => x } = {}) {
    const N = records.length;
    const W = Math.ceil(N / 32);
    const items = new Map();
    const itemOf = (key, label, conds) => {
      if (!items.has(key)) items.set(key, { key, label, conds, bits: new Uint32Array(W), count: 0 });
      return items.get(key);
    };
    const target = new Uint32Array(W);
    let targetCount = 0;
    records.forEach((r, i) => {
      const bit = 1 << (i % 32), w = (i / 32) | 0;
      if (mode === 'traits') {
        for (const it of traitItems(r, labelWG)) { const x = itemOf(it.key, it.label, it.conds); x.bits[w] |= bit; x.count++; }
        if (r.risk_band === 'critical' || r.risk_band === 'high') { target[w] |= bit; targetCount++; }
      } else {
        for (const h of r.rule_hits || []) {
          if (h.source !== 'real') continue;
          const x = itemOf('R:' + h.rule_id, `${h.rule_id} ${h.rule_name}`, [{ field: 'rule_hit', op: 'has', value: h.rule_id }]);
          x.bits[w] |= bit; x.count++;
        }
      }
    });
    const freq = [...items.values()].filter(x => x.count >= minSupport).sort((a, b) => a.key.localeCompare(b.key));
    const rules = [];
    const tmp = new Uint32Array(W);

    // ชุดเงื่อนไข (antecedent) ขนาด 1..maxLen ที่พบบ่อยพอ
    let level = freq.map((x, i) => ({ idx: [i], bits: x.bits, count: x.count }));
    const allSets = [...level];
    for (let k = 2; k <= maxLen && level.length; k++) {
      const next = [];
      for (let a = 0; a < level.length; a++) {
        for (let b = a + 1; b < level.length; b++) {
          const A = level[a].idx, B = level[b].idx;
          if (A.slice(0, -1).join() !== B.slice(0, -1).join()) continue;   // ต่อชุดที่มีคำนำหน้าเหมือนกันเท่านั้น
          const bits = new Uint32Array(W);
          const count = andCount(level[a].bits, freq[B[B.length - 1]].bits, bits);
          if (count >= minSupport) next.push({ idx: [...A, B[B.length - 1]], bits, count });
        }
      }
      allSets.push(...next);
      level = next;
      if (allSets.length > 20000) break;
    }

    if (mode === 'traits') {
      const pC = targetCount / N;
      for (const s of allSets) {
        const both = andCount(s.bits, target, tmp);
        if (both < minSupport) continue;
        const conf = both / s.count, lift = pC ? conf / pC : 0;
        if (conf >= minConf && lift >= minLift) {
          rules.push({ ante: s.idx.map(i => freq[i]), cons: { label: 'ควรตรวจก่อน (วิกฤต+สูง)' }, n: both, anteN: s.count, support: both / N, conf, lift, bits: s.bits });
        }
      }
    } else {
      for (const s of allSets) {
        if (s.idx.length >= maxLen) continue;
        for (let c = 0; c < freq.length; c++) {
          if (s.idx.includes(c)) continue;
          const both = andCount(s.bits, freq[c].bits, tmp);
          if (both < minSupport) continue;
          const conf = both / s.count, lift = conf / (freq[c].count / N);
          if (conf >= minConf && lift >= minLift) {
            rules.push({ ante: s.idx.map(i => freq[i]), cons: freq[c], n: both, anteN: s.count, support: both / N, conf, lift, bits: s.bits });
          }
        }
      }
    }

    // ตัดกฎที่ซ้ำซ้อน: ถ้าชุดเงื่อนไขย่อยให้ความมั่นใจใกล้เคียงกันอยู่แล้ว เก็บกฎที่สั้นกว่า
    const keyOf = r => r.ante.map(a => a.key).sort().join('&') + '=>' + (r.cons.key || 'target');
    const byKey = new Map(rules.map(r => [keyOf(r), r]));
    const pruned = rules.filter(r => {
      if (r.ante.length === 1) return true;
      for (let i = 0; i < r.ante.length; i++) {
        const sub = r.ante.filter((_, j) => j !== i);
        const s = byKey.get(sub.map(a => a.key).sort().join('&') + '=>' + (r.cons.key || 'target'));
        if (s && s.conf >= r.conf - 0.03) return false;
      }
      return true;
    });
    pruned.sort((a, b) => b.lift - a.lift || b.n - a.n);
    return { mode, N, targetCount, items: items.size, frequent: freq.length, candidates: allSets.length, rules: pruned.slice(0, 60), totalRules: pruned.length };
  }

  function rowsOfBits(records, bits, limit = 10) {
    const out = [];
    for (let i = 0; i < records.length && out.length < limit * 20; i++) if (bits[(i / 32) | 0] & (1 << (i % 32))) out.push(records[i]);
    return out;
  }

  /* ---------- สุขภาพของกฎ ---------- */

  function health(records, settings, ctx) {
    const defs = Rules.DEFS.filter(d => d.source === 'real' && settings[d.id]?.enabled !== false);
    const sets = new Map(defs.map(d => [d.id, new Set()]));
    records.forEach((r, i) => { for (const h of r.rule_hits || []) sets.get(h.rule_id)?.add(i); });
    const active = defs.filter(d => sets.get(d.id).size > 0);
    const pairs = [];
    for (let a = 0; a < active.length; a++) {
      for (let b = a + 1; b < active.length; b++) {
        const A = sets.get(active[a].id), B = sets.get(active[b].id);
        const [small, big] = A.size < B.size ? [A, B] : [B, A];
        let both = 0;
        for (const x of small) if (big.has(x)) both++;
        const union = A.size + B.size - both;
        pairs.push({ a: active[a].id, b: active[b].id, both, jaccard: union ? both / union : 0, containA: A.size ? both / A.size : 0, containB: B.size ? both / B.size : 0 });
      }
    }
    const marginal = active.map(d => {
      const idx = sets.get(d.id);
      const w = settings[d.id].weight;
      let sole = 0, leave = 0, value = 0;
      for (const i of idx) {
        const r = records[i];
        const real = (r.rule_hits || []).filter(h => h.source === 'real');
        if (real.length === 1) sole++;
        const pri = r.risk_score >= 40;
        if (pri && Math.min(100, real.reduce((s, h) => s + h.weight, 0) - w) < 40) leave++;
        value += r.contract_price_agree || 0;
      }
      return { id: d.id, name: d.name, custom: !!d.custom, hits: idx.size, sole, leave, value, weight: w };
    }).sort((a, b) => b.leave - a.leave || b.hits - a.hits);
    const silent = defs.filter(d => sets.get(d.id).size === 0).map(d => ({ id: d.id, name: d.name }));
    return { active, pairs, marginal, silent, redundant: pairs.filter(p => p.jaccard >= 0.5).sort((a, b) => b.jaccard - a.jaccard) };
  }

  /** จำนวนที่ติดเมื่อเลื่อนเกณฑ์หนึ่งค่า — ประเมินกฎข้อเดียวซ้ำตามจุดที่ไล่ค่า */
  function sensitivity(records, ruleId, key, settings, ctx, steps = 12) {
    const def = Rules.BY_ID.get(ruleId);
    const spec = def?.thresholds?.[key];
    if (!spec) return null;
    const values = [];
    for (let i = 0; i < steps; i++) {
      const raw = spec.min + (spec.max - spec.min) * i / (steps - 1);
      values.push(Math.round(raw / spec.step) * spec.step);
    }
    const uniq = [...new Set(values.map(v => +v.toFixed(6)))];
    const base = settings[ruleId].thresholds;
    const counts = uniq.map(v => {
      const t = { ...base, [key]: v };
      let n = 0;
      for (const r of records) { try { if (def.evaluate(r, ctx, t)) n++; } catch (e) { /* ข้าม */ } }
      return n;
    });
    return { values: uniq, counts, current: base[key], spec };
  }

  return {
    FIELDS, OPS, OP_LABEL, CATEGORIES, SEVERITIES, init, vocabOf, validate, compile, describe, describeCondition,
    backtest, loadSaved, registerSaved, addRule, deleteRule, mine, rowsOfBits, health, sensitivity, setWorkGroupLabeler,
  };
})();
