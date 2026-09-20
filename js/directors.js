/* directors.js — ข้อมูลกรรมการที่ผู้ใช้กรอกเอง (ไม่ได้ดึงจากที่ไหนอัตโนมัติ)

   ที่มา: DBD DataWarehouse+ (datawarehouse.dbd.go.th) ดึงข้อมูลอัตโนมัติไม่ได้จริง — ตรวจแล้วพบว่า
   เว็บมี Imperva Incapsula กันบอท และ API ตอบกลับเป็นข้อมูลเข้ารหัส (kid/salt/iv/ct) ส่วนข้อมูลผู้ถือหุ้น
   (ต่างจากกรรมการ) ต้องสมัครสมาชิกด้วยเลขบัตรประชาชนจริงที่ shd.dbd.go.th จึงไม่มีทางทำถูกกฎหมายได้เลย
   นอกจากให้ผู้ตรวจเปิดดูเองแล้วพิมพ์ผลที่เห็นเข้ามา — โมดูลนี้จึงมีแค่ชั้นเก็บ+แจง ไม่มี fetch ใดๆ ทั้งสิ้น

   เก็บด้วย localStorage ธรรมดา (ไม่ใช่ IndexedDB ของ datasets.js) เพราะข้อมูลนี้เป็นชุดเล็ก
   (หลักสิบ-ร้อยแถว ไม่ใช่หมื่นแถวแบบข้อมูลจัดซื้อ) และเก็บทั่วทั้งแอปไม่ผูกกับชุดข้อมูลจัดซื้อที่กำลังใช้อยู่
   เพราะกรรมการของบริษัทหนึ่งเป็นข้อเท็จจริงเดียวกันไม่ว่าจะสลับไปดูชุดข้อมูลจัดซื้อชุดไหน */
'use strict';

const Directors = (() => {
  const KEY = 'pa_directors_v1';

  // แถวหนึ่งคือคนหนึ่งในบริษัทหนึ่ง: { id, tax_id, company_name, person_name, role, addedAt }
  function list() {
    try { return JSON.parse(localStorage.getItem(KEY) || '[]'); }
    catch (e) { return []; }
  }

  function save(rows) {
    try { localStorage.setItem(KEY, JSON.stringify(rows)); }
    catch (e) { /* พื้นที่เต็มหรือถูกปิดกั้น ไม่ใช่เรื่องคอขาดบาดตายของฟีเจอร์นี้ */ }
  }

  const norm = v => String(v ?? '').replace(/\s+/g, ' ').trim();

  // รหัสแถวต้องไม่ซ้ำกันเด็ดขาด — ใช้เวลาอย่างเดียวไม่พอ เพราะการวางหลายแถวพร้อมกันสร้างแถวภายในมิลลิวินาทีเดียวกัน
  // (เคยใช้ addedAt เป็นตัวลบแล้วกดลบแถวเดียวกลับลบทั้งชุดที่วางพร้อมกัน จึงต้องมีตัวนับกำกับ)
  let seq = 0;
  const newId = () => Date.now().toString(36) + '-' + (seq++).toString(36);

  function add({ tax_id, company_name, person_name, role }) {
    const rows = list();
    const rec = {
      id: newId(),
      tax_id: norm(tax_id), company_name: norm(company_name), person_name: norm(person_name),
      role: norm(role) || 'กรรมการ', addedAt: new Date().toISOString(),
    };
    if (!rec.tax_id) return { ok: false, reason: 'ไม่มีเลขผู้เสียภาษี' };
    if (!rec.person_name) return { ok: false, reason: 'กรอกชื่อบุคคลก่อน' };
    // กันแถวซ้ำเป๊ะ (คนเดิม บริษัทเดิม บทบาทเดิม) — ไม่กันชื่อคนซ้ำข้ามบริษัท เพราะนั่นคือสิ่งที่ฟีเจอร์นี้ต้องการตรวจจับ
    if (rows.some(r => r.tax_id === rec.tax_id && r.person_name === rec.person_name && r.role === rec.role)) {
      return { ok: false, reason: 'มีข้อมูลนี้อยู่แล้ว' };
    }
    rows.push(rec);
    save(rows);
    return { ok: true, rec };
  }

  function remove(id) {
    save(list().filter(r => r.id !== id));
  }

  function clear() {
    save([]);
  }

  /** วางหลายแถวพร้อมกัน คั่นด้วยจุลภาคหรือแท็บ บรรทัดละคน: เลขผู้เสียภาษี,ชื่อบริษัท,ชื่อบุคคล,บทบาท
   *  บทบาทเว้นว่างได้ (ถือเป็นกรรมการ) แถวที่ขาดเลขผู้เสียภาษีหรือชื่อบุคคลจะถูกข้ามและรายงานกลับ */
  function parseBulk(text) {
    const lines = String(text || '').split('\n').map(l => l.trim()).filter(Boolean);
    const ok = [], bad = [];
    for (const line of lines) {
      const parts = (line.includes('\t') ? line.split('\t') : line.split(',')).map(s => s.trim());
      const [tax_id, company_name, person_name, role] = parts;
      const r = add({ tax_id, company_name, person_name, role });
      (r.ok ? ok : bad).push({ line, reason: r.reason });
    }
    return { ok, bad, addedCount: ok.length };
  }

  return { list, add, remove, clear, parseBulk };
})();
