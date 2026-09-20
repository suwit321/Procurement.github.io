/* =============================================================================
   dataio.js — อ่านไฟล์ จับคู่คอลัมน์ แปลงค่า และประกอบชุดข้อมูลให้เหมือนที่ ETL สร้าง

   ตรรกะล้วน ไม่แตะ DOM (หน้าจออยู่ใน app.js) เพื่อให้ทดสอบค่าทีละตัวได้

   หลักการสำคัญ 3 ข้อ
   1. ตัวแปลงทุกตัวพอร์ตมาจาก tools/build_data.py และ tools/ds_models.py แบบบรรทัดต่อบรรทัด
      ถ้าแก้ที่นี่ต้องแก้ที่นั่นด้วย ไม่งั้นข้อมูลชุดเดียวกันจะให้คะแนนต่างกันระหว่าง ETL กับเบราว์เซอร์
      (มีการทดสอบวนกลับ: ส่งออก raw CSV จากชุดหลัก แล้วนำเข้าใหม่ จำนวนกฎที่ติดต้องเท่าเดิมทุกข้อ)
   2. ฟิลด์ที่คำนวณในเบราว์เซอร์ไม่ได้ (ผลโมเดล) จะ "ไม่มีคีย์" ไม่ใช่ใส่ null
      เพราะโค้ดเดิมหลายที่เช็กด้วย !== undefined และเพราะการเดาค่าให้ผู้ตรวจคือการสร้างหลักฐานเท็จ
   3. ทุกอย่างที่เดา (การเข้ารหัสอักขระ ตัวคั่น การจับคู่คอลัมน์ รูปแบบวันที่) ต้องรายงานให้ผู้ใช้เห็น
      และแก้เองได้เสมอ
   ============================================================================= */

const DataIO = (() => {
  'use strict';

  class ImportError extends Error {
    constructor(message, { hint = '' } = {}) {
      super(message);
      this.name = 'ImportError';
      this.hint = hint;
    }
  }

  /* ---------------------------------------------------------------------------
     1) ตัวแปลงค่า — พอร์ตจาก tools/build_data.py
     --------------------------------------------------------------------------- */

  // tools/build_data.py:45
  const THAI_MONTHS = {
    'ม.ค.': 1, 'ก.พ.': 2, 'มี.ค.': 3, 'เม.ย.': 4, 'พ.ค.': 5, 'มิ.ย.': 6,
    'ก.ค.': 7, 'ส.ค.': 8, 'ก.ย.': 9, 'ต.ค.': 10, 'พ.ย.': 11, 'ธ.ค.': 12,
  };
  const THAI_MONTHS_FULL = {
    'มกราคม': 1, 'กุมภาพันธ์': 2, 'มีนาคม': 3, 'เมษายน': 4, 'พฤษภาคม': 5, 'มิถุนายน': 6,
    'กรกฎาคม': 7, 'สิงหาคม': 8, 'กันยายน': 9, 'ตุลาคม': 10, 'พฤศจิกายน': 11, 'ธันวาคม': 12,
  };
  // tools/build_data.py:50
  const NULLISH = new Set(['', '-', 'nan', 'none', 'null', 'nat', 'n/a', 'na', 'undefined']);

  const isBlank = v => v === null || v === undefined || NULLISH.has(String(v).trim().toLowerCase());

  /** '3,498,760,900.00' -> 3498760900 — tools/build_data.py:53
   *  คอลัมน์เงินในไฟล์ต้นทางใช้คอมมาคั่นหลักพัน ETL รุ่นแรกเรียก float() ตรง ๆ จึงได้ null ทั้งคอลัมน์ */
  function parseMoney(value) {
    if (isBlank(value)) return null;
    if (typeof value === 'number') return Number.isFinite(value) ? value : null;
    const text = String(value).trim().replace(/,/g, '').replace(/^฿/, '').replace(/บาท$/, '').trim();
    const n = Number(text);
    return Number.isFinite(n) ? n : null;
  }

  /** '20 พ.ย. 68' -> '2025-11-20' — tools/build_data.py:71
   *  ปี พ.ศ. 2 หลัก: 68 -> 2568 -> ค.ศ. 2025 (ลบ 543)
   *
   *  ฝั่งเบราว์เซอร์รับรูปแบบมากกว่า ETL เพราะไฟล์จาก API/Excel เขียนวันที่คนละแบบกับ CSV ต้นทาง
   *  แต่ละแบบถูกนับแยกใน report.dateFormats เพื่อให้ผู้ใช้เห็นว่าไฟล์นี้ใช้รูปแบบไหน */
  function parseThaiDate(value, stats) {
    const bump = k => { if (stats) stats[k] = (stats[k] || 0) + 1; };
    if (isBlank(value)) { bump('empty'); return null; }

    // Excel ส่ง Date object มาเมื่ออ่านด้วย cellDates
    if (value instanceof Date && !Number.isNaN(value.getTime())) {
      bump('excel');
      return iso(value.getUTCFullYear(), value.getUTCMonth() + 1, value.getUTCDate());
    }

    const text = String(value).trim();

    // แบบที่ 1 — ไทยย่อ/ไทยเต็ม '20 พ.ย. 68' (เส้นทางเดียวกับ ETL)
    const parts = text.split(/\s+/);
    if (parts.length === 3) {
      const month = THAI_MONTHS[parts[1]] ?? THAI_MONTHS_FULL[parts[1]];
      const day = Number(parts[0]);
      let year = Number(parts[2]);
      if (month && Number.isInteger(day) && Number.isInteger(year)) {
        if (year < 100) year = 2500 + year;
        const out = buddhistToIso(year, month, day);
        if (out) { bump('thai'); return out; }
      }
    }

    // แบบที่ 2 — ISO 'YYYY-MM-DD' (อาจเป็น พ.ศ. ถ้าปีเกิน 2400)
    let m = text.match(/^(\d{4})-(\d{2})-(\d{2})/);
    if (m) {
      const out = maybeBuddhist(+m[1], +m[2], +m[3]);
      if (out) { bump('iso'); return out; }
    }

    // แบบที่ 3 — 'DD/MM/YYYY' หรือ 'DD-MM-YYYY'
    m = text.match(/^(\d{1,2})[/-](\d{1,2})[/-](\d{2,4})$/);
    if (m) {
      let year = +m[3];
      if (year < 100) year = 2500 + year;
      const out = maybeBuddhist(year, +m[2], +m[1]);
      if (out) { bump('slash'); return out; }
    }

    bump('bad');
    return null;
  }

  const pad = n => String(n).padStart(2, '0');
  const iso = (y, m, d) => `${y}-${pad(m)}-${pad(d)}`;

  function validDate(y, m, d) {
    if (!(m >= 1 && m <= 12 && d >= 1 && d <= 31)) return false;
    const dt = new Date(Date.UTC(y, m - 1, d));
    return dt.getUTCFullYear() === y && dt.getUTCMonth() === m - 1 && dt.getUTCDate() === d;
  }
  function buddhistToIso(beYear, month, day) {
    const y = beYear - 543;
    return validDate(y, month, day) ? iso(y, month, day) : null;
  }
  /** ปีเกิน 2400 ถือว่าเป็น พ.ศ. — ไม่มีสัญญาจัดซื้อจากปี ค.ศ. 2400 ให้สับสน */
  function maybeBuddhist(year, month, day) {
    const y = year > 2400 ? year - 543 : year;
    return validDate(y, month, day) ? iso(y, month, day) : null;
  }

  /** WKT -> {lat, lon, geomType} — tools/build_data.py:105
   *  POINT ใช้พิกัดตรง POLYGON/LINESTRING ยุบเป็น centroid · WKT เรียง lng ก่อน lat */
  function parseWkt(value) {
    if (isBlank(value)) return { lat: null, lon: null, geomType: null };
    const text = String(value).trim();
    const geomType = (text.split('(')[0] || '').trim().toUpperCase() || null;
    const numbers = (text.match(/-?\d+\.?\d*/g) || []).map(Number);
    if (numbers.length < 2) return { lat: null, lon: null, geomType };

    let sumLon = 0, sumLat = 0, n = 0;
    for (let i = 0; i + 1 < numbers.length; i += 2) { sumLon += numbers[i]; sumLat += numbers[i + 1]; n++; }
    const lon = sumLon / n, lat = sumLat / n;

    // ขอบเขตประเทศไทยแบบหลวม ๆ กันพิกัดสลับแกนหรือค่าขยะ
    if (!(lat >= 5 && lat <= 21 && lon >= 96 && lon <= 106)) return { lat: null, lon: null, geomType };
    return { lat: round6(lat), lon: round6(lon), geomType };
  }
  const round6 = x => Math.round(x * 1e6) / 1e6;

  /** พิกัดที่มาเป็นคอลัมน์ lat/lon แยก ต้องแปลงกลับเป็น WKT เพื่อให้กติกา geo_quality
   *  (ซึ่งจับกลุ่มด้วยสตริงพิกัดตรงตัว) และการส่งออก raw CSV ทำงานเหมือนกันทุกเส้นทาง */
  function pointWkt(lat, lon) {
    return (lat === null || lon === null) ? '' : `POINT(${lon} ${lat})`;
  }

  // tools/build_data.py:138
  const LEGAL_FORMS = ['บริษัทจำกัด', 'บริษัท', 'ห้างหุ้นส่วนจำกัด', 'ห้างหุ้นส่วนสามัญ',
    'หจก.', 'หสม.', 'บมจ.', 'บจก.', 'ร้าน'];
  const JV_MARKER = 'สัญญากิจการค้าร่วม';

  /** ชื่อผู้รับจ้างมาตรฐาน + เป็นกิจการค้าร่วมหรือไม่ — tools/build_data.py:145
   *  แก้ 2 ปัญหาที่ทำให้เกิด false positive: เว้นวรรคซ้อน และ prefix นิติบุคคลซ้ำ */
  function canonicalName(value) {
    if (value === null || value === undefined) return { key: '', isJv: false };
    let name = String(value).replace(/\s+/g, ' ').trim();
    if (!name) return { key: '', isJv: false };

    const isJv = name.includes(JV_MARKER);
    name = name.replace(new RegExp('\\(\\s*' + JV_MARKER + '\\s*\\)', 'g'), '').replace(/\s+/g, ' ').trim();

    let changed = true;
    while (changed) {
      changed = false;
      for (const form of LEGAL_FORMS) {
        if (name.startsWith(form + ' ')) {
          const remainder = name.slice(form.length + 1).trim();
          if (LEGAL_FORMS.some(f => remainder.startsWith(f))) { name = remainder; changed = true; break; }
        }
      }
    }
    return { key: name.trim(), isJv };
  }

  // tools/build_data.py:179
  const isMaskedTin = v => String(v ?? '').toLowerCase().includes('x');

  const deptKey = v => String(v ?? '').replace(/\s+/g, ' ').trim();

  /** ส่วนต่างวันเป็นวัน คิดบน UTC เพื่อไม่ให้เขตเวลาทำให้คลาดไป 1 วัน */
  function daysBetween(fromIso, toIso) {
    if (!fromIso || !toIso) return null;
    const a = Date.parse(fromIso + 'T00:00:00Z'), b = Date.parse(toIso + 'T00:00:00Z');
    if (Number.isNaN(a) || Number.isNaN(b)) return null;
    return Math.round((b - a) / 86400000);
  }

  /* ---------------------------------------------------------------------------
     2) กลุ่มงาน — พอร์ตจาก tools/ds_models.py:242
     ลำดับมีความหมาย: กลุ่มที่ระบุชนิดงานได้ชัดตรวจก่อน กลุ่มกว้างตรวจท้ายสุด
     แก้ที่นี่ต้องแก้ ds_models.py ด้วย
     --------------------------------------------------------------------------- */

  const WORK_GROUPS = [
    ['leak', 'สำรวจ/ซ่อมท่อแตกรั่ว', /แตกรั่ว|จุดรั่ว|น้ำสูญเสีย|ซ่อมท่อ/],
    ['staff', 'จ้างเหมาบุคคล/แรงงาน',
      /บุคคลภายนอก|ปฏิบัติงาน|ลูกจ้าง|พนักงาน|แรงงานรายวัน|คนงาน|\d+\s*อัตรา|[๐-๙]+\s*อัตรา|จ้างเหมาบริการบุคคล/],
    ['service', 'บริการทั่วไป/ไอที',
      /รักษาความปลอดภัย|ทำความสะอาด|อินเตอร์เน็ต|อินเทอร์เน็ต|เครือข่าย|VPN|โปรแกรม|ซอฟต์แวร์|ระบบบริหาร|เอกสาร|เก็บตัวอย่างน้ำ|ตรวจวิเคราะห์|ห้องปฏิบัติการ|ที่ปรึกษา|ออกแบบ|ควบคุมงาน|ประกันภัย|ประชาสัมพันธ์|พิมพ์|จัดเก็บรายได้|ดูแลสวน|ภูมิทัศน์/],
    ['chemical', 'สารเคมี/วัสดุวิทยาศาสตร์',
      /คลอรีน|สารส้ม|PAC|โพลีอะลูมิเนียม|ปูนขาว|สารเคมี|วัสดุวิทยาศาสตร์|น้ำยา|โซดาไฟ|กรดไฮโดร|ไฮโดรคลอริก/],
    ['meter', 'มาตรวัดน้ำ', /มาตรวัดน้ำ|มิเตอร์/],
    ['road', 'ถนน/ผิวจราจร',
      /(ก่อสร้าง|ปรับปรุง|ซ่อมแซม|ซ่อมสร้าง|บูรณะ)\s*(ผิว)?\s*ถนน|ถนน\s*(คอนกรีต|ลาดยาง|ลูกรัง|หินคลุก|แอสฟัล|คสล|ค\.ส\.ล)|ผิวจราจร|ลาดยาง|แอสฟัลท์ติก|แอสฟัลต์ติก|คืนสภาพผิว/],
    ['source', 'บ่อบาดาล/แหล่งน้ำดิบ',
      /บาดาล|ขุดลอก|ขุดสระ|สระน้ำ|สระเก็บน้ำ|ฝาย|อ่างเก็บน้ำ|แหล่งน้ำดิบ|น้ำดิบ/],
    ['tower', 'หอถัง/ถังเก็บน้ำ',
      /หอถัง|หอประปา|ถังสูง|ถังเก็บน้ำ|ถังพักน้ำ|หอสูง|ถังแชมเปญ|ถังเหล็ก|บ่อพักน้ำ|ถังน้ำใส/],
    ['plant', 'ระบบผลิต/กรองน้ำ',
      /ผลิตน้ำ|กรองน้ำ|ถาดเติมอากาศ|ถังกรอง|โรงกรอง|โรงผลิต|ตกตะกอน|น้ำดื่ม|อาร์โอ|สารกรอง|ทรายกรอง|กรวดกรอง/],
    ['energy', 'เครื่องสูบ/ไฟฟ้า/โซลาร์เซลล์',
      /เครื่องสูบ|ปั๊ม|ปั้ม|มอเตอร์|พลังงานแสงอาทิตย์|โซลาร์|โซล่า|ไฟฟ้า|หม้อแปลง|ตู้ควบคุม/],
    ['pipe', 'วางท่อ/ขยายเขตประปา',
      /วางท่อ|ขยายเขต|ท่อส่งน้ำ|ท่อจ่ายน้ำ|ท่อเมน|แนวท่อ|เดินท่อ|เปลี่ยนท่อ|ย้ายท่อ|ระบบท่อ|เส้นท่อ|ท่อ\s*(PVC|HDPE|พีวีซี|เหล็ก|พีอี)|เชื่อมต่อระบบ/],
    ['material', 'วัสดุ/อุปกรณ์ประปา', /ซื้อวัสดุ|วัสดุประปา|วัสดุก่อสร้าง|อุปกรณ์ประปา|ครุภัณฑ์|อะไหล่|ซื้อท่อ/],
    ['repair', 'ซ่อมแซม/ปรับปรุงระบบประปา', /ซ่อม|ปรับปรุง|บำรุงรักษา|ฟื้นฟู|ย้าย/],
    ['build', 'ก่อสร้างระบบประปา', /ก่อสร้าง|ติดตั้ง|จัดทำระบบประปา|ระบบประปา/],
  ];
  const WORK_GROUP_LABELS = Object.fromEntries([...WORK_GROUPS.map(([k, label]) => [k, label]), ['other', 'อื่นๆ']]);
  const WORK_GROUP_ORDER = [...WORK_GROUPS.map(([k]) => k), 'other'];

  function workGroupOf(projectName) {
    const name = String(projectName ?? '');
    for (const [key, , rx] of WORK_GROUPS) if (rx.test(name)) return key;
    return 'other';
  }

  /** ok / shared / none — พอร์ตจาก tools/ds_models.py:197
   *  shared = รูปเรขาคณิตเดียวกันทุกตัวอักษร ใช้กับสัญญา ≥3 ฉบับ ที่ชื่องานต่างกัน ≥3 ชื่อ
   *  = ร่องรอยของการปักพิกัดที่ตั้งสำนักงานแทนที่ตั้งงาน ไม่ใช่โครงการเดียวกัน
   *
   *  ข้อจำกัดที่ทดสอบแล้ว: ถ้าไฟล์ต้นทางมีแต่ lat/lon (เช่นส่งออกจากชุดที่ ETL สร้าง ซึ่งไม่เก็บ WKT เดิมไว้)
   *  รูปหลายเหลี่ยมคนละรูปที่จุดกึ่งกลางตรงกันจะถูกจับเป็นกลุ่มเดียวกัน จำนวนแถว shared จึงมากกว่าเดิมเล็กน้อย
   *  วัดจริงกับชุดข้อมูลหลัก: 1,702 → 1,766 แถว (0.6%) ส่วนคะแนนความเสี่ยงและจำนวนที่ติดกฎทุกข้อเท่าเดิม */
  function deriveGeoQuality(records, { minRows = 3, minNames = 3 } = {}) {
    const groups = new Map();
    records.forEach((r, i) => {
      const loc = String(r.project_location ?? '').trim();
      if (!loc || loc === '-') return;
      let g = groups.get(loc);
      if (!g) { g = { idx: [], names: new Set(), depts: new Set() }; groups.set(loc, g); }
      g.idx.push(i);
      g.names.add(r.project_name);
      g.depts.add(r.dept_key);
    });

    const shared = [];
    for (const [loc, g] of groups) {
      if (g.idx.length >= minRows && g.names.size >= minNames) shared.push([loc, g]);
    }
    const sharedSet = new Set(shared.map(([loc]) => loc));

    let sharedRows = 0;
    for (const r of records) {
      const loc = String(r.project_location ?? '').trim();
      if (!loc || loc === '-') { r.geo_quality = 'none'; continue; }
      if (sharedSet.has(loc)) { r.geo_quality = 'shared'; sharedRows++; } else r.geo_quality = 'ok';
    }

    const top = shared.sort((a, b) => b[1].idx.length - a[1].idx.length).slice(0, 8).map(([, g]) => {
      const rows = g.idx.map(i => records[i]);
      return {
        dept: mode(rows.map(r => r.dept_key)), province: mode(rows.map(r => r.province)),
        n: g.idx.length, names: g.names.size, depts: g.depts.size,
      };
    });

    return {
      shared_points: shared.length,
      shared_rows: sharedRows,
      shared_multi_agency_points: shared.filter(([, g]) => g.depts.size > 1).length,
      rule: `รูปเรขาคณิตเดียวกัน ≥${minRows} สัญญา และชื่องานต่างกัน ≥${minNames} ชื่อ`,
      top,
    };
  }

  function mode(values) {
    const counts = new Map();
    for (const v of values) counts.set(v, (counts.get(v) || 0) + 1);
    let best = '', bestN = -1;
    for (const [v, n] of counts) if (n > bestN) { best = v; bestN = n; }
    return best;
  }

  /* ---------------------------------------------------------------------------
     3) อ่านไฟล์: การเข้ารหัสอักขระ · CSV · JSON · XLSX
     --------------------------------------------------------------------------- */

  /** ไฟล์จากพอร์ทัลไทยมักเป็น TIS-620/windows-874 ไม่ใช่ UTF-8
   *
   *  ต้องใช้ fatal:true ตอนลอง UTF-8 เพราะโหมดปกติจะแปลงไบต์ที่อ่านไม่ได้เป็น U+FFFD เงียบ ๆ
   *  จำนวนแถวและหัวคอลัมน์จะดูถูกต้องทุกอย่าง เสียแค่ภาษาไทย ซึ่งเป็นความผิดพลาดที่หลุดไปถึงผู้ใช้ได้ง่ายที่สุด
   *  ส่วนทางกลับกัน (ไฟล์ UTF-8 ถอดด้วย 874) ไม่เกิด U+FFFD เลย ได้แค่ตัวอักษรขยะ จึงต้องให้คะแนนด้วยจำนวนอักษรไทย */
  function sniffEncoding(buffer) {
    const bytes = new Uint8Array(buffer);
    if (bytes[0] === 0xEF && bytes[1] === 0xBB && bytes[2] === 0xBF) return { encoding: 'utf-8', reason: 'BOM', bom: true };
    if (bytes[0] === 0xFF && bytes[1] === 0xFE) return { encoding: 'utf-16le', reason: 'BOM', bom: true };
    if (bytes[0] === 0xFE && bytes[1] === 0xFF) return { encoding: 'utf-16be', reason: 'BOM', bom: true };

    const sample = buffer.byteLength > 2e6 ? buffer.slice(0, 2e6) : buffer;
    let utf8Ok = true;
    try { new TextDecoder('utf-8', { fatal: true }).decode(sample); } catch (e) { utf8Ok = false; }

    const score = text => {
      let thai = 0, bad = 0;
      for (const ch of text) {
        const c = ch.codePointAt(0);
        if (c >= 0x0E00 && c <= 0x0E7F) thai++;
        else if (c === 0xFFFD) bad++;
      }
      return { thai, bad, score: thai - 100 * bad };
    };

    const asUtf8 = score(new TextDecoder('utf-8').decode(sample));
    const as874 = score(new TextDecoder('windows-874').decode(sample));
    const useUtf8 = utf8Ok && (asUtf8.score >= as874.score || asUtf8.thai > 0);
    return {
      encoding: useUtf8 ? 'utf-8' : 'windows-874',
      reason: utf8Ok ? 'ให้คะแนนจากจำนวนอักษรไทย' : 'ไม่ผ่านการตรวจแบบ UTF-8 เข้มงวด',
      bom: false,
      thaiChars: useUtf8 ? asUtf8.thai : as874.thai,
      replacementChars: useUtf8 ? asUtf8.bad : as874.bad,
      candidates: { 'utf-8': asUtf8, 'windows-874': as874 },
    };
  }

  function decodeText(buffer, encoding) {
    let text;
    try { text = new TextDecoder(encoding).decode(buffer); }
    catch (e) { text = new TextDecoder('utf-8').decode(buffer); }
    return text.replace(/^﻿/, '');
  }

  const DELIMITERS = [',', ';', '\t', '|'];

  /** เดาตัวคั่นจากจำนวนครั้งที่ปรากฏนอกเครื่องหมายคำพูด และความสม่ำเสมอระหว่างบรรทัด */
  function sniffDelimiter(text) {
    const lines = text.split(/\r\n|\r|\n/).filter(l => l.trim()).slice(0, 10);
    let best = ',', bestScore = -1;
    for (const d of DELIMITERS) {
      const counts = lines.map(l => countOutsideQuotes(l, d));
      if (!counts.length || counts[0] === 0) continue;
      const consistent = counts.filter(c => c === counts[0]).length / counts.length;
      const score = counts[0] * consistent;
      if (score > bestScore) { bestScore = score; best = d; }
    }
    return best;
  }

  function countOutsideQuotes(line, delimiter) {
    let n = 0, inQuotes = false;
    for (let i = 0; i < line.length; i++) {
      const ch = line[i];
      if (ch === '"') { if (inQuotes && line[i + 1] === '"') i++; else inQuotes = !inQuotes; }
      else if (ch === delimiter && !inQuotes) n++;
    }
    return n;
  }

  /** CSV ตาม RFC 4180: รองรับ "" ในค่า และขึ้นบรรทัดใหม่ในค่าที่อยู่ในเครื่องหมายคำพูด */
  function parseCSV(text, { delimiter, maxRows = Infinity } = {}) {
    const d = delimiter || sniffDelimiter(text);
    const rows = [];
    let row = [], field = '', inQuotes = false, truncated = false;

    for (let i = 0; i < text.length; i++) {
      const ch = text[i];
      if (inQuotes) {
        if (ch === '"') {
          if (text[i + 1] === '"') { field += '"'; i++; } else inQuotes = false;
        } else field += ch;
        continue;
      }
      if (ch === '"') { inQuotes = true; continue; }
      if (ch === d) { row.push(field); field = ''; continue; }
      if (ch === '\r') { if (text[i + 1] === '\n') i++; pushRow(); continue; }
      if (ch === '\n') { pushRow(); continue; }
      field += ch;
    }
    if (field !== '' || row.length) pushRow();

    function pushRow() {
      row.push(field); field = '';
      if (row.length === 1 && row[0].trim() === '') { row = []; return; }   // บรรทัดว่าง
      if (rows.length >= maxRows + 1) { truncated = true; row = []; return; }
      rows.push(row); row = [];
    }

    const header = rows.shift() || [];
    const ragged = [];
    rows.forEach((r, i) => {
      if (r.length !== header.length) ragged.push({ line: i + 2, got: r.length, want: header.length, preview: r.slice(0, 3).join(' | ') });
      while (r.length < header.length) r.push('');
      if (r.length > header.length) r.length = header.length;
    });

    return { header: header.map(h => String(h).trim()), rows, delimiter: d, ragged, truncated };
  }

  /** รับ JSON 5 รูปแบบ — คืน rows แบบ object ต่อแถว พร้อมบอกว่าเป็นรูปแบบไหน */
  function parseJSONPayload(data) {
    if (Array.isArray(data)) return { rows: data, shape: 'array', hint: 'อาเรย์ของออบเจกต์' };
    if (data && typeof data === 'object') {
      if (Array.isArray(data.records) && data.meta) {
        return { rows: data.records, shape: 'payload', hint: 'ชุดข้อมูลที่ส่งออกจากระบบนี้ (หรือ data.json)', payload: data };
      }
      if (Array.isArray(data.result)) {
        return { rows: data.result, shape: 'egp', hint: 'ผลจาก e-GP Open Data', summary: data.summary || null };
      }
      if (data.result && Array.isArray(data.result.records)) {
        return { rows: data.result.records, shape: 'ckan', hint: 'ผลจาก data.go.th (CKAN datastore_search)', total: data.result.total };
      }
      if (Array.isArray(data.records)) return { rows: data.records, shape: 'records', hint: 'ออบเจกต์ที่มีคีย์ records' };
      if (Array.isArray(data.data)) return { rows: data.data, shape: 'data', hint: 'ออบเจกต์ที่มีคีย์ data' };
    }
    throw new ImportError('อ่านโครงสร้าง JSON ไม่ออก', {
      hint: 'รองรับ: อาเรย์ของออบเจกต์ · {result:[...]} ของ e-GP · {result:{records:[...]}} ของ CKAN · ชุดข้อมูลที่ส่งออกจากระบบนี้',
    });
  }

  /* SheetJS ย้ายออกจาก npm ไปแล้ว รุ่นบน npm จึงค้างอยู่ที่ 0.18.5 (อ่าน .xlsx ได้ครบ)
     ลองตามลำดับ: ไฟล์ในเครื่อง (ถ้ามีคนวางไว้เพื่อใช้ออฟไลน์) → jsdelivr ซึ่งโปรเจกต์ใช้อยู่แล้ว → CDN ทางการของ SheetJS */
  const XLSX_SOURCES = [
    { url: './js/vendor/xlsx.mjs', label: 'ไฟล์ในเครื่อง' },
    { url: 'https://cdn.jsdelivr.net/npm/xlsx@0.18.5/+esm', label: 'cdn.jsdelivr.net' },
    { url: 'https://cdn.sheetjs.com/xlsx-0.20.3/package/xlsx.mjs', label: 'cdn.sheetjs.com' },
  ];
  let xlsxPromise = null;
  let xlsxSource = '';

  /** โหลดไลบรารีอ่าน Excel เฉพาะตอนที่ผู้ใช้เลือกไฟล์ .xlsx จริง ๆ
   *  รูปแบบ lazy import เดียวกับที่ ai.js โหลด SDK จาก CDN — ผู้ใช้ที่นำเข้าแค่ CSV/JSON ไม่ต้องโหลดอะไรเพิ่มเลย */
  function loadXLSX() {
    if (!xlsxPromise) {
      xlsxPromise = (async () => {
        const errors = [];
        for (const src of XLSX_SOURCES) {
          try {
            const mod = await import(/* webpackIgnore: true */ src.url);
            if (mod && typeof mod.read === 'function') { xlsxSource = src.label; return mod; }
            errors.push(`${src.label}: โมดูลไม่มีฟังก์ชัน read`);
          } catch (err) {
            errors.push(`${src.label}: ${String(err.message || err).slice(0, 80)}`);
          }
        }
        xlsxPromise = null;
        throw new ImportError('โหลดไลบรารีอ่าน Excel ไม่สำเร็จ', {
          hint: 'ต้องต่ออินเทอร์เน็ตครั้งแรกเพื่อโหลดไลบรารี · ทางออกที่ง่ายที่สุดคือเปิดไฟล์ใน Excel แล้ว Save As เป็น CSV (ระบบอ่านทั้ง UTF-8 และ TIS-620) · ' + errors.join(' · '),
        });
      })();
    }
    return xlsxPromise;
  }
  const xlsxLoadedFrom = () => xlsxSource;

  /** อ่าน .xlsx → {sheets, header, rows} รูปแบบเดียวกับ CSV เพื่อให้ปลายทางใช้โค้ดร่วมกันได้
   *  cellDates:true ให้เซลล์ชนิดวันที่กลายเป็น Date (ไม่งั้นจะได้เลขลำดับของ Excel เช่น 45231)
   *  ส่วนวันที่ พ.ศ. ในไฟล์ไทยมักเก็บเป็นข้อความอยู่แล้ว จึงยังไหลเข้า parseThaiDate ตามปกติ */
  async function readXLSX(buffer, { sheet, maxRows = Infinity } = {}) {
    const XLSX = await loadXLSX();
    const wb = XLSX.read(buffer, { type: 'array', cellDates: true });
    const sheets = wb.SheetNames.map(name => {
      const ref = wb.Sheets[name]['!ref'];
      const range = ref ? XLSX.utils.decode_range(ref) : null;
      return { name, rows: range ? range.e.r - range.s.r : 0, cols: range ? range.e.c - range.s.c + 1 : 0 };
    });
    const pick = sheet && wb.SheetNames.includes(sheet) ? sheet
      : (sheets.find(s => s.rows > 0) || sheets[0] || {}).name;
    if (!pick) throw new ImportError('ไฟล์ Excel นี้ไม่มีชีตที่มีข้อมูล');

    const grid = XLSX.utils.sheet_to_json(wb.Sheets[pick], { header: 1, defval: '', blankrows: false, raw: true });
    const header = (grid.shift() || []).map(h => String(h).trim());
    const rows = grid.slice(0, maxRows === Infinity ? undefined : maxRows);
    return { sheets, sheet: pick, header, rows, truncated: grid.length > rows.length };
  }

  /** จุดเข้าเดียวสำหรับไฟล์ทุกชนิด — คืน {kind, header, rows(object[]), info} */
  async function readFile(file, { sheet, encoding, maxRows = Infinity } = {}) {
    const name = (file.name || '').toLowerCase();
    const buffer = await file.arrayBuffer();

    if (/\.(xlsx|xlsm|xls)$/.test(name)) {
      const x = await readXLSX(buffer, { sheet, maxRows });
      return {
        kind: 'xlsx', header: x.header, rows: rowsToObjects(x.header, x.rows),
        info: { sheets: x.sheets, sheet: x.sheet, truncated: x.truncated, fileName: file.name, bytes: file.size },
      };
    }

    const sniff = encoding ? { encoding, reason: 'ผู้ใช้เลือกเอง' } : sniffEncoding(buffer);
    const text = decodeText(buffer, sniff.encoding);

    if (/\.json$/.test(name) || text.trimStart().startsWith('{') || text.trimStart().startsWith('[')) {
      let data;
      try { data = JSON.parse(text); }
      catch (err) { throw new ImportError('ไฟล์ JSON เสียหรือไม่สมบูรณ์', { hint: String(err.message || err).slice(0, 160) }); }
      const parsed = parseJSONPayload(data);
      const rows = maxRows === Infinity ? parsed.rows : parsed.rows.slice(0, maxRows);
      return {
        kind: 'json', header: headersOf(rows), rows, payload: parsed.payload || null,
        info: { shape: parsed.shape, hint: parsed.hint, encoding: sniff, fileName: file.name, bytes: file.size, total: parsed.total ?? parsed.summary?.total ?? null },
      };
    }

    const csv = parseCSV(text, { maxRows });
    return {
      kind: 'csv', header: csv.header, rows: rowsToObjects(csv.header, csv.rows),
      info: { encoding: sniff, delimiter: csv.delimiter, ragged: csv.ragged, truncated: csv.truncated, fileName: file.name, bytes: file.size },
    };
  }

  function rowsToObjects(header, rows) {
    return rows.map(r => {
      const o = {};
      header.forEach((h, i) => { o[h] = r[i]; });
      return o;
    });
  }

  function headersOf(rows) {
    const seen = new Set();
    for (const r of rows.slice(0, 50)) {
      if (r && typeof r === 'object') for (const k of Object.keys(r)) seen.add(k);
    }
    return [...seen];
  }

  /* ---------------------------------------------------------------------------
     4) จับคู่คอลัมน์
     ชื่อคอลัมน์ของ raw_data.csv ตรงกับชื่อฟิลด์ที่บริการ cgdcontract ของ e-GP ส่งมา
     (tools/build_data.py:555) ไฟล์จากแหล่งเดียวกันจึงจับคู่อัตโนมัติได้ครบโดยผู้ใช้แค่กดยืนยัน
     --------------------------------------------------------------------------- */

  const FIELD_SPECS = [
    { key: 'project_id', label: 'รหัสโครงการ', tier: 'required', kind: 'text', aliases: ['project_id', 'projectid', 'รหัสโครงการ', 'เลขที่โครงการ'] },
    { key: 'project_name', label: 'ชื่อโครงการ', tier: 'required', kind: 'text', aliases: ['project_name', 'projectname', 'ชื่อโครงการ', 'ชื่องาน'] },
    { key: 'dept_name', label: 'หน่วยงาน', tier: 'required', kind: 'text', aliases: ['dept_name', 'deptname', 'department', 'หน่วยงาน', 'ชื่อหน่วยงาน'] },
    { key: 'winner_name', label: 'ผู้รับจ้าง/ผู้ชนะ', tier: 'required', kind: 'text', aliases: ['winner_name', 'winnername', 'ผู้รับจ้าง', 'ผู้ชนะ', 'ผู้ชนะการเสนอราคา', 'คู่สัญญา'] },
    { key: 'contract_price_agree', label: 'ราคาที่ตกลง', tier: 'required', kind: 'money', aliases: ['contract_price_agree', 'ราคาที่ตกลงซื้อหรือจ้าง', 'ราคาที่ตกลง', 'มูลค่าสัญญา', 'contract_price'] },
    { key: 'contract_date', label: 'วันที่ทำสัญญา', tier: 'required', kind: 'date', aliases: ['contract_date', 'วันที่ทำสัญญา', 'วันทำสัญญา', 'วันที่ลงนาม'] },

    { key: 'price_build', label: 'ราคากลาง', tier: 'important', kind: 'money', aliases: ['price_build', 'ราคากลาง', 'ราคาอ้างอิง'] },
    { key: 'project_money', label: 'วงเงินโครงการ', tier: 'important', kind: 'money', aliases: ['project_money', 'วงเงินโครงการ', 'งบประมาณโครงการ', 'วงเงินงบประมาณ'] },
    { key: 'sum_price_agree', label: 'ยอดรวมของโครงการ', tier: 'important', kind: 'money', aliases: ['sum_price_agree', 'ยอดรวม', 'ราคารวม'] },
    { key: 'purchase_method_name', label: 'วิธีจัดหา', tier: 'important', kind: 'text', aliases: ['purchase_method_name', 'วิธีจัดหา', 'วิธีการจัดซื้อจัดจ้าง', 'วิธีซื้อหรือจ้าง'] },
    { key: 'purchase_method_group_name', label: 'กลุ่มวิธีจัดหา', tier: 'important', kind: 'text', aliases: ['purchase_method_group_name', 'กลุ่มวิธีจัดหา', 'ประเภทวิธีจัดหา'] },
    { key: 'project_type_name', label: 'ประเภทโครงการ', tier: 'important', kind: 'text', aliases: ['project_type_name', 'ประเภทโครงการ', 'ประเภทงาน'] },
    { key: 'province', label: 'จังหวัด (ที่ตั้งหน่วยงาน)', tier: 'important', kind: 'text', aliases: ['province', 'จังหวัด'] },
    { key: 'winner_tin', label: 'เลขประจำตัวผู้เสียภาษี', tier: 'important', kind: 'text', aliases: ['winner_tin', 'tin', 'เลขประจำตัวผู้เสียภาษี', 'เลขผู้เสียภาษี'] },
    { key: 'contract_no', label: 'เลขที่สัญญา', tier: 'important', kind: 'text', aliases: ['contract_no', 'เลขที่สัญญา', 'สัญญาเลขที่'] },
    { key: 'project_location', label: 'พิกัดโครงการ (WKT)', tier: 'important', kind: 'wkt', aliases: ['project_location', 'location', 'geometry', 'wkt', 'พิกัด', 'ที่ตั้งโครงการ'] },

    { key: 'dept_sub_name', label: 'หน่วยงานย่อย', tier: 'optional', kind: 'text', aliases: ['dept_sub_name', 'หน่วยงานย่อย', 'สำนัก/กอง'] },
    { key: 'district', label: 'อำเภอ', tier: 'optional', kind: 'text', aliases: ['district', 'อำเภอ', 'เขต'] },
    { key: 'subdistrict', label: 'ตำบล', tier: 'optional', kind: 'text', aliases: ['subdistrict', 'ตำบล', 'แขวง'] },
    { key: 'announce_date', label: 'วันที่ประกาศ', tier: 'optional', kind: 'date', aliases: ['announce_date', 'วันที่ประกาศ', 'วันประกาศ'] },
    { key: 'contract_finish_date', label: 'วันที่สิ้นสุดสัญญา', tier: 'optional', kind: 'date', aliases: ['contract_finish_date', 'วันที่สิ้นสุดสัญญา', 'วันสิ้นสุด', 'วันแล้วเสร็จ'] },
    { key: 'budget_year', label: 'ปีงบประมาณ', tier: 'optional', kind: 'text', aliases: ['budget_year', 'ปีงบประมาณ', 'ปีงบ', 'fiscal_year'] },
    { key: 'lat', label: 'ละติจูด (ถ้าแยกคอลัมน์)', tier: 'optional', kind: 'number', aliases: ['lat', 'latitude', 'ละติจูด'] },
    { key: 'lon', label: 'ลองจิจูด (ถ้าแยกคอลัมน์)', tier: 'optional', kind: 'number', aliases: ['lon', 'lng', 'longitude', 'ลองจิจูด'] },
  ];

  const norm = s => String(s ?? '').toLowerCase().replace(/[\s_\-.()]/g, '');

  /** เดาการจับคู่จากชื่อคอลัมน์: ตรงเป๊ะก่อน แล้วค่อยเป็นการมีคำนั้นอยู่ข้างใน */
  function guessMapping(headers) {
    const map = {};
    const used = new Set();
    const normed = headers.map(h => ({ raw: h, n: norm(h) }));

    for (const spec of FIELD_SPECS) {
      const aliases = spec.aliases.map(norm);
      let hit = normed.find(h => !used.has(h.raw) && aliases.includes(h.n));
      if (!hit) hit = normed.find(h => !used.has(h.raw) && aliases.some(a => a.length >= 4 && h.n.includes(a)));
      if (hit) { map[spec.key] = hit.raw; used.add(hit.raw); }
      else map[spec.key] = null;
    }
    const required = FIELD_SPECS.filter(s => s.tier === 'required');
    const matched = required.filter(s => map[s.key]).length;
    return { map, confidence: matched / required.length, unmatched: headers.filter(h => !used.has(h)) };
  }

  /* ---------------------------------------------------------------------------
     5) แปลงเป็นระเบียนของระบบ + รายงานคุณภาพ
     --------------------------------------------------------------------------- */

  const TEXT_FIELDS = ['project_id', 'project_name', 'project_type_name', 'dept_name', 'dept_sub_name',
    'purchase_method_name', 'purchase_method_group_name', 'province', 'district', 'subdistrict',
    'winner_tin', 'winner_name', 'contract_no'];
  const MONEY_FIELDS = ['project_money', 'price_build', 'sum_price_agree', 'contract_price_agree'];
  const DATE_FIELDS = ['announce_date', 'contract_date', 'contract_finish_date'];

  function normalize(rows, mapping, { onProgress } = {}) {
    const get = (row, field) => {
      const col = mapping[field];
      return col === null || col === undefined ? undefined : row[col];
    };

    const records = [];
    const dateFormats = {};
    const badValues = {};       // field -> ตัวอย่างค่าที่แปลงไม่ได้
    const noteBad = (field, raw) => {
      if (raw === undefined || raw === null || String(raw).trim() === '') return;
      const list = badValues[field] || (badValues[field] = []);
      if (list.length < 3 && !list.includes(String(raw))) list.push(String(raw));
    };
    let dropped = 0;
    const dropReasons = {};

    rows.forEach((row, i) => {
      const rec = {};
      for (const f of TEXT_FIELDS) rec[f] = String(get(row, f) ?? '').trim();

      // ต้องมีอย่างน้อยชื่อโครงการหรือรหัสโครงการ ไม่งั้นเป็นแถวขยะ (ท้ายไฟล์ บรรทัดรวมยอด ฯลฯ)
      if (!rec.project_id && !rec.project_name) {
        dropped++; dropReasons['ไม่มีรหัสและชื่อโครงการ'] = (dropReasons['ไม่มีรหัสและชื่อโครงการ'] || 0) + 1;
        return;
      }

      for (const f of MONEY_FIELDS) {
        const raw = get(row, f);
        rec[f] = parseMoney(raw);
        if (rec[f] === null) noteBad(f, raw);
      }
      for (const f of DATE_FIELDS) {
        const raw = get(row, f);
        const stats = dateFormats[f] || (dateFormats[f] = {});
        rec[f] = parseThaiDate(raw, stats);
        if (rec[f] === null) noteBad(f, raw);
      }

      // พิกัด: ใช้ WKT ถ้ามี ถ้าไม่มีลองประกอบจากคอลัมน์ lat/lon
      let wkt = String(get(row, 'project_location') ?? '').trim();
      let geo = parseWkt(wkt);
      if (geo.lat === null) {
        const la = Number(get(row, 'lat')), lo = Number(get(row, 'lon'));
        if (Number.isFinite(la) && Number.isFinite(lo) && la >= 5 && la <= 21 && lo >= 96 && lo <= 106) {
          geo = { lat: round6(la), lon: round6(lo), geomType: 'POINT' };
          wkt = pointWkt(geo.lat, geo.lon);
        } else if (wkt) noteBad('project_location', wkt);
      }
      rec.project_location = wkt;
      rec.lat = geo.lat; rec.lon = geo.lon; rec.geom_type = geo.geomType;

      const canon = canonicalName(rec.winner_name);
      rec.winner_key = canon.key;
      rec.is_jv = canon.isJv;
      rec.tin_is_masked = isMaskedTin(rec.winner_tin);
      rec.dept_key = deptKey(rec.dept_name);
      rec.duration_days = daysBetween(rec.contract_date, rec.contract_finish_date);
      rec.announce_gap_days = daysBetween(rec.announce_date, rec.contract_date);
      rec.work_group = workGroupOf(rec.project_name);
      rec.budget_year = String(get(row, 'budget_year') ?? '').trim();

      records.push(rec);
      if (onProgress && i % 2000 === 0) onProgress(i, rows.length);
    });

    const geoMeta = deriveGeoQuality(records);

    return { records, report: buildReport(records, { dropped, dropReasons, dateFormats, badValues, geoMeta, mapping, inputRows: rows.length }) };
  }

  /** คีย์สัญญา — สูตรเดียวกับตะกร้าใน app.js เพื่อให้ตะกร้าและป้ายผลการตรวจอ้างถึงสัญญาเดียวกัน
   *  ใช้ตรวจแถวซ้ำในไฟล์ (แถวที่เหมือนกันทุกช่องสำคัญ = ซ้ำจริง) */
  const recordKey = r => [r.project_id, r.contract_no, r.winner_tin, r.contract_price_agree, r.contract_date].join('|');

  /** คีย์ระบุตัวสัญญาสำหรับการอัปเดต — ไม่รวมมูลค่าและวันที่โดยตั้งใจ
   *  เพราะสิ่งที่เรามักอยากจับคือ "สัญญาฉบับเดิมที่ตัวเลขเปลี่ยน" ถ้าเอามูลค่าเข้ามาเป็นคีย์ด้วย
   *  สัญญาที่แก้ไขมูลค่าจะกลายเป็นรายการใหม่ แทนที่จะขึ้นเป็นรายการที่ถูกแก้ */
  const identityKey = r => [r.project_id, r.contract_no, r.winner_tin].join('|');

  function buildReport(records, ctx) {
    const n = records.length;
    const coverage = {};
    for (const spec of FIELD_SPECS) {
      if (spec.key === 'lat' || spec.key === 'lon') continue;
      const filled = records.filter(r => {
        const v = r[spec.key];
        return v !== null && v !== undefined && String(v).trim() !== '';
      }).length;
      coverage[spec.key] = { filled, pct: n ? filled / n : 0, mapped: !!ctx.mapping[spec.key], tier: spec.tier, label: spec.label };
    }

    const keys = new Map();
    for (const r of records) {
      const k = recordKey(r);
      keys.set(k, (keys.get(k) || 0) + 1);
    }
    const dupes = [...keys.values()].filter(v => v > 1).length;

    const dates = records.map(r => r.contract_date).filter(Boolean).sort();
    const withGeo = records.filter(r => r.lat !== null).length;

    // วิธีจัดหาเป็นการเทียบสตริงตรงตัวในกฎ R8/R12/R22 — ถ้าคำไม่ตรง กฎจะเงียบโดยไม่มี error
    const methods = [...new Map(records.map(r => [r.purchase_method_name, 0])).keys()].filter(Boolean);
    const methodCounts = {};
    for (const r of records) methodCounts[r.purchase_method_name] = (methodCounts[r.purchase_method_name] || 0) + 1;

    return {
      inputRows: ctx.inputRows, kept: n, dropped: ctx.dropped, dropReasons: ctx.dropReasons,
      coverage, dateFormats: ctx.dateFormats, badValues: ctx.badValues, dupes,
      dateMin: dates[0] || null, dateMax: dates[dates.length - 1] || null,
      withGeo, geoPct: n ? withGeo / n : 0, geoMeta: ctx.geoMeta,
      methods: methods.map(m => ({ name: m, n: methodCounts[m] })).sort((a, b) => b.n - a.n),
      hasSpecificMethod: methods.some(m => m.includes('เฉพาะเจาะจง')),
      negativeMoney: records.filter(r => r.contract_price_agree !== null && r.contract_price_agree <= 0).length,
      backwardDates: records.filter(r => r.duration_days !== null && r.duration_days < 0).length,
    };
  }

  /* ---------------------------------------------------------------------------
     6) ประกอบ payload ให้มีรูปร่างเดียวกับ data/data.json
     --------------------------------------------------------------------------- */

  const ABSENT_BLOCKS = ['hurdle', 'anomaly', 'road', 'digits', 'network'];

  function buildMeta(records, { sourceFile = '', origin = null } = {}) {
    const dates = records.map(r => r.contract_date).filter(Boolean).sort();
    const provinces = uniqueSorted(records.map(r => r.province));
    const methods = uniqueSorted(records.map(r => r.purchase_method_name));
    const types = uniqueSorted(records.map(r => r.project_type_name));
    const withGeo = records.filter(r => r.lat !== null).length;
    return {
      source_file: sourceFile,
      generated_at: new Date().toISOString().slice(0, 19),
      total_records: records.length,
      total_contract_value: records.reduce((s, r) => s + (r.contract_price_agree || 0), 0),
      contract_date_min: dates[0] || null,
      contract_date_max: dates[dates.length - 1] || null,
      budget_years: uniqueSorted(records.map(r => r.budget_year)),
      geo_rows: withGeo,
      geo_pct: records.length ? Math.round(withGeo / records.length * 1000) / 10 : 0,
      n_agencies: new Set(records.map(r => r.dept_key).filter(Boolean)).size,
      n_contractors: new Set(records.map(r => r.winner_key).filter(Boolean)).size,
      n_provinces: provinces.length,
      n_masked_tins: records.filter(r => r.tin_is_masked).length,
      provinces, methods, project_types: types,
      origin,
      absent: [...ABSENT_BLOCKS],
    };
  }

  // เรียงแบบไทย ต่างจาก sorted() ของ Python ที่เรียงตามรหัสอักขระ — ต่างกันแค่ลำดับในกล่องเลือก
  const uniqueSorted = values => [...new Set(values.filter(v => v !== null && v !== undefined && String(v).trim() !== ''))]
    .sort((a, b) => String(a).localeCompare(String(b), 'th'));

  function buildModels(records, { geoMeta, keyword = '', requestedLimit = null } = {}) {
    const counts = {};
    for (const r of records) counts[r.work_group] = (counts[r.work_group] || 0) + 1;
    const covered = records.filter(r => r.work_group !== 'other').length;

    return {
      scope: {
        sort_key: null, cutoff_value: null,
        n_projects: new Set(records.map(r => r.project_id).filter(Boolean)).size,
        n_contracts: records.length,
        looks_capped: requestedLimit ? records.length >= requestedLimit : false,
        name_keyword: keyword || null,
        keyword_share: keyword ? records.filter(r => r.project_name.includes(keyword)).length / (records.length || 1) : null,
      },
      work_groups: {
        labels: { ...WORK_GROUP_LABELS },
        order: [...WORK_GROUP_ORDER],
        counts,
        coverage: records.length ? covered / records.length : 0,
        method: 'พจนานุกรมคำจากชื่อโครงการ ตรวจตามลำดับ กลุ่มแรกที่ตรงคือกลุ่มของสัญญา (คำนวณในเบราว์เซอร์)',
      },
      geo: geoMeta || null,
    };
  }

  /** ประกอบชุดข้อมูลให้แอปใช้ได้ทันที — synthetic_demo ยกมาจากชุดหลักเพื่อให้แท็บสาธิตไม่พัง
   *  (เนื้อหาสาธิตเป็นเรื่องสมมุติล้วน ไม่เกี่ยวกับระเบียนจริงในชุดใด) */
  function buildPayload(records, { sourceFile = '', origin = null, geoMeta = null, keyword = '', requestedLimit = null, syntheticDemo = null, pipeline = null } = {}) {
    const meta = buildMeta(records, { sourceFile, origin });
    if (pipeline) meta.pipeline = pipeline;
    return {
      meta,
      records,
      models: buildModels(records, { geoMeta, keyword, requestedLimit }),
      network_nodes: [],
      network_edges: [],
      synthetic_demo: syntheticDemo || null,
    };
  }

  /* ---------------------------------------------------------------------------
     7) รวมชุดข้อมูล — แทนที่ / ต่อท้าย / อัปเดตตามคีย์
     --------------------------------------------------------------------------- */

  const MERGE_MODES = {
    replace: 'แทนที่ทั้งหมด',
    append: 'ต่อท้าย (เก็บของเดิมไว้ทุกแถว)',
    upsert: 'อัปเดตตามคีย์สัญญา (แถวเดิมที่ตรงกันจะถูกทับ)',
  };

  function mergeRecords(baseRecords, incoming, mode) {
    if (mode === 'replace' || !baseRecords || !baseRecords.length) {
      return { records: incoming, diff: { added: incoming.length, updated: 0, kept: 0, removed: baseRecords ? baseRecords.length : 0, changedFields: {} } };
    }
    if (mode === 'append') {
      return { records: baseRecords.concat(incoming), diff: { added: incoming.length, updated: 0, kept: baseRecords.length, removed: 0, changedFields: {} } };
    }

    const index = new Map(baseRecords.map((r, i) => [identityKey(r), i]));
    const out = baseRecords.map(r => ({ ...r }));
    const changedFields = {};
    const examples = [];
    let added = 0, updated = 0;

    for (const inc of incoming) {
      const k = identityKey(inc);
      const at = index.get(k);
      if (at === undefined) { out.push(inc); index.set(k, out.length - 1); added++; continue; }
      const target = out[at];
      let touched = false;
      for (const [field, value] of Object.entries(inc)) {
        // ฟิลด์ที่ชุดใหม่ไม่มีค่า ต้องไม่ไปลบของเดิมทิ้ง
        // (เช่น ผลจาก API ที่ไม่มีพิกัด จะทำให้ lat/lon, geo_quality, R17 และแผนที่หายไปทั้งชุด)
        if (value === null || value === undefined || value === '') continue;
        if (target[field] !== value) {
          if (field === 'contract_price_agree' && examples.length < 5) {
            examples.push({ project_id: target.project_id, field, from: target[field], to: value });
          }
          target[field] = value;
          changedFields[field] = (changedFields[field] || 0) + 1;
          touched = true;
        }
      }
      if (touched) updated++;
    }
    return { records: out, diff: { added, updated, kept: baseRecords.length - updated, removed: 0, changedFields, examples } };
  }

  /* ---------------------------------------------------------------------------
     8) ส่งออกเป็น raw_data.csv สำหรับ tools/build_data.py
     คอลัมน์และรูปแบบวันที่ต้องตรงกับที่ ETL คาดไว้ เพื่อให้รันต่อแล้วได้ชุดเต็มที่มีผลโมเดล
     --------------------------------------------------------------------------- */

  const RAW_COLUMNS = ['project_id', 'project_name', 'project_type_name', 'dept_name', 'dept_sub_name',
    'purchase_method_name', 'purchase_method_group_name', 'province', 'district', 'subdistrict',
    'winner_tin', 'winner_name', 'contract_no', 'project_money', 'price_build', 'sum_price_agree',
    'contract_price_agree', 'announce_date', 'contract_date', 'contract_finish_date',
    'project_location', 'budget_year'];

  const THAI_MONTH_BY_NUM = Object.fromEntries(Object.entries(THAI_MONTHS).map(([k, v]) => [v, k]));

  /** ISO -> '20 พ.ย. 68' ให้ parse_thai_date ของ ETL อ่านได้ทันทีโดยไม่ต้องแก้ Python */
  function isoToThaiDate(isoText) {
    if (!isoText) return '-';
    const m = String(isoText).match(/^(\d{4})-(\d{2})-(\d{2})$/);
    if (!m) return '-';
    const be = (+m[1]) + 543;
    return `${+m[3]} ${THAI_MONTH_BY_NUM[+m[2]]} ${String(be).slice(-2)}`;
  }

  function toRawRows(records) {
    return records.map(r => RAW_COLUMNS.map(col => {
      if (DATE_FIELDS.includes(col)) return isoToThaiDate(r[col]);
      // ชุดข้อมูลที่ ETL สร้างไม่ได้เก็บสตริง WKT ไว้ เหลือแต่ lat/lon ที่แปลงแล้ว
      // ถ้าไม่ประกอบกลับเป็น POINT พิกัดจะหายไปทั้งคอลัมน์ ทำให้แผนที่ว่างและกฎ R17 ไม่ทำงาน
      if (col === 'project_location' && !r.project_location) return pointWkt(r.lat ?? null, r.lon ?? null);
      const v = r[col];
      return v === null || v === undefined ? '' : String(v);
    }));
  }

  return {
    ImportError,
    // ตัวแปลง (ทดสอบทีละค่าได้)
    parseMoney, parseThaiDate, parseWkt, canonicalName, isMaskedTin, deptKey, daysBetween,
    workGroupOf, WORK_GROUPS, WORK_GROUP_LABELS, WORK_GROUP_ORDER, deriveGeoQuality, pointWkt,
    // อ่านไฟล์
    sniffEncoding, decodeText, sniffDelimiter, parseCSV, parseJSONPayload, readFile, readXLSX, loadXLSX, xlsxLoadedFrom,
    // จับคู่และแปลง
    FIELD_SPECS, guessMapping, normalize, recordKey,
    // ประกอบและรวม
    buildMeta, buildModels, buildPayload, mergeRecords, MERGE_MODES, ABSENT_BLOCKS, identityKey,
    // ส่งออก
    RAW_COLUMNS, toRawRows, isoToThaiDate,
  };
})();
