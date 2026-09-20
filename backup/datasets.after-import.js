/* =============================================================================
   datasets.js — ทะเบียนชุดข้อมูลหลายชุด เก็บใน IndexedDB

   ทำไมต้อง IndexedDB: ชุดข้อมูลหลักมีขนาด 23 MB ส่วน localStorage มีเพดานราว 5 MB
   และในนั้นมีประวัติ AI กับตะกร้าอยู่แล้ว

   แยกเป็น 2 store โดยตั้งใจ
     datasets  = ทะเบียน (เล็ก) — เปิดรายการชุดข้อมูลได้โดยไม่ต้องอ่านก้อน 23 MB
     payloads  = ตัวข้อมูลจริง — อ่านเฉพาะตอนจะใช้งานชุดนั้น
   เก็บเป็นออบเจกต์ ไม่ใช่สตริง JSON เพราะ structured clone เร็วกว่าและไม่ต้องสร้างสตริงยักษ์ในหน่วยความจำ
   ============================================================================= */

const Datasets = (() => {
  'use strict';

  const DB_NAME = 'pa_datasets';
  const DB_VERSION = 1;
  const STORE_META = 'datasets';
  const STORE_PAYLOAD = 'payloads';
  const ACTIVE_KEY = 'pa_active_dataset_v1';
  const BASE_ID = 'base';           // ชุดหลักที่มากับแอป (data/data.json) ไม่ได้เก็บใน IndexedDB

  let dbPromise = null;

  /** IndexedDB ใช้ไม่ได้เมื่อเปิดไฟล์ตรง ๆ ด้วย file:// (origin แบบทึบ)
   *  ต้องบอกผู้ใช้ตั้งแต่ต้น ไม่ใช่ปล่อยให้พังตอนกดยืนยันหลังแปลงไฟล์เสร็จไปแล้ว */
  function available() {
    if (location.protocol === 'file:') return { ok: false, reason: 'เปิดหน้านี้ผ่านเว็บเซิร์ฟเวอร์ก่อน (เช่น python -m http.server) เบราว์เซอร์ไม่ให้เก็บข้อมูลเมื่อเปิดไฟล์ตรง ๆ' };
    if (!('indexedDB' in window)) return { ok: false, reason: 'เบราว์เซอร์นี้ไม่รองรับ IndexedDB' };
    return { ok: true };
  }

  function open() {
    const can = available();
    if (!can.ok) return Promise.reject(new Error(can.reason));
    if (!dbPromise) {
      dbPromise = new Promise((resolve, reject) => {
        const req = indexedDB.open(DB_NAME, DB_VERSION);
        req.onupgradeneeded = () => {
          const db = req.result;
          if (!db.objectStoreNames.contains(STORE_META)) db.createObjectStore(STORE_META, { keyPath: 'id' });
          if (!db.objectStoreNames.contains(STORE_PAYLOAD)) db.createObjectStore(STORE_PAYLOAD, { keyPath: 'id' });
        };
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => reject(req.error || new Error('เปิดฐานข้อมูลในเบราว์เซอร์ไม่สำเร็จ'));
        req.onblocked = () => reject(new Error('มีแท็บอื่นเปิดฐานข้อมูลรุ่นเก่าค้างอยู่ ลองปิดแท็บอื่นแล้วโหลดใหม่'));
      }).catch(err => { dbPromise = null; throw err; });
    }
    return dbPromise;
  }

  function tx(storeNames, mode, fn) {
    return open().then(db => new Promise((resolve, reject) => {
      const t = db.transaction(storeNames, mode);
      let result;
      t.oncomplete = () => resolve(result);
      t.onerror = () => reject(t.error);
      t.onabort = () => reject(t.error || new Error('ยกเลิกการเขียนฐานข้อมูล (พื้นที่อาจเต็ม)'));
      result = fn(...storeNames.map(n => t.objectStore(n)));
    }));
  }

  const request = req => new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });

  /* ---------- ทะเบียน ---------- */

  async function list() {
    try {
      const db = await open();
      const store = db.transaction(STORE_META, 'readonly').objectStore(STORE_META);
      const rows = await request(store.getAll());
      return rows.sort((a, b) => String(b.created).localeCompare(String(a.created)));
    } catch (err) {
      console.warn('อ่านทะเบียนชุดข้อมูลไม่สำเร็จ', err);
      return [];
    }
  }

  async function get(id) {
    const db = await open();
    const store = db.transaction(STORE_PAYLOAD, 'readonly').objectStore(STORE_PAYLOAD);
    const row = await request(store.get(id));
    return row ? row.payload : null;
  }

  async function getMeta(id) {
    const db = await open();
    const store = db.transaction(STORE_META, 'readonly').objectStore(STORE_META);
    return request(store.get(id));
  }

  const newId = () => 'ds_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 7);

  /** ขนาดโดยประมาณ — ใช้ความยาว JSON ของตัวอย่าง 200 ระเบียนคูณจำนวนจริง
   *  ไม่ stringify ทั้งก้อนเพราะชุด 10,000 แถวจะสร้างสตริง 20 MB ทิ้งเปล่า ๆ */
  function estimateBytes(payload) {
    const recs = payload.records || [];
    if (!recs.length) return 0;
    const sample = recs.slice(0, Math.min(200, recs.length));
    const per = JSON.stringify(sample).length / sample.length;
    return Math.round(per * recs.length);
  }

  async function put(payload, { name, origin = null, id = newId() } = {}) {
    const meta = payload.meta || {};
    const entry = {
      id,
      name: name || meta.source_file || 'ชุดข้อมูลนำเข้า',
      created: new Date().toISOString(),
      origin: origin || meta.origin || null,
      n_records: (payload.records || []).length,
      bytes: estimateBytes(payload),
      absent: meta.absent || [],
      summary: {
        total_contract_value: meta.total_contract_value || 0,
        contract_date_min: meta.contract_date_min || null,
        contract_date_max: meta.contract_date_max || null,
        n_agencies: meta.n_agencies || 0,
        n_contractors: meta.n_contractors || 0,
        geo_pct: meta.geo_pct || 0,
      },
    };
    await tx([STORE_META, STORE_PAYLOAD], 'readwrite', (metaStore, payloadStore) => {
      metaStore.put(entry);
      payloadStore.put({ id, payload });
    });
    return entry;
  }

  async function rename(id, name) {
    const entry = await getMeta(id);
    if (!entry) return null;
    entry.name = name;
    await tx([STORE_META], 'readwrite', store => store.put(entry));
    return entry;
  }

  async function remove(id) {
    await tx([STORE_META, STORE_PAYLOAD], 'readwrite', (metaStore, payloadStore) => {
      metaStore.delete(id);
      payloadStore.delete(id);
    });
    if (getActive()?.id === id) setActive(null);
  }

  /* ---------- ชุดที่ใช้อยู่ (เก็บใน localStorage เพราะต้องอ่านตอน boot ก่อนเปิด IndexedDB) ---------- */

  function getActive() {
    try {
      const raw = localStorage.getItem(ACTIVE_KEY);
      if (!raw) return null;
      const v = JSON.parse(raw);
      return v && v.id && v.id !== BASE_ID ? v : null;
    } catch (e) { return null; }
  }

  function setActive(entry) {
    try {
      if (!entry || entry.id === BASE_ID) localStorage.removeItem(ACTIVE_KEY);
      else localStorage.setItem(ACTIVE_KEY, JSON.stringify({ id: entry.id, name: entry.name, activatedAt: new Date().toISOString() }));
    } catch (e) { /* โหมดส่วนตัวหรือพื้นที่เต็ม — ยังใช้ได้ในรอบนี้ แค่จำข้ามรอบไม่ได้ */ }
  }

  /** พื้นที่ที่เบราว์เซอร์ให้ใช้ — เรียกก่อนเขียนชุดใหญ่ เพื่อบอกตัวเลขจริงแทนปล่อยให้ QuotaExceededError โผล่ดิบ ๆ */
  async function estimate() {
    if (!navigator.storage || !navigator.storage.estimate) return null;
    try {
      const { usage = 0, quota = 0 } = await navigator.storage.estimate();
      return { usage, quota, free: Math.max(0, quota - usage) };
    } catch (e) { return null; }
  }

  return { BASE_ID, available, open, list, get, getMeta, put, rename, remove, getActive, setActive, estimate, estimateBytes };
})();
