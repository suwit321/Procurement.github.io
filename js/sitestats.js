/* sitestats.js — ตัวนับการเข้าชมเว็บไซต์ + ข้อมูลระบบ ในปุ่มจางมุมขวาล่าง

   เว็บนี้เป็นไซต์ static บน GitHub Pages ไม่มีเซิร์ฟเวอร์ของเราเอง จึงใช้บริการตัวนับสาธารณะ Abacus
   (https://abacus.jasoncameron.dev ไม่ต้องสมัคร เปิด CORS) เก็บตัวนับ 2 ตัวใต้ namespace ของเว็บนี้:
     views    = จำนวนครั้งที่เข้าชม (รวมคนเดิมที่กลับมา) นับ 1 ครั้งต่อ 1 เซสชันของแท็บ ไม่นับตอนกดรีเฟรช
     visitors = ผู้เข้าชมไม่ซ้ำ นับ 1 ครั้งต่อ 1 เบราว์เซอร์ (จำด้วย localStorage)

   ข้อจำกัดที่ต้องบอกผู้ใช้ตรง ๆ (แสดงในแผงด้วย):
     - "ไม่ซ้ำ" คือต่อเบราว์เซอร์/อุปกรณ์ ไม่ใช่ต่อคน — คนเดียวใช้สองเครื่องนับเป็นสอง ล้างข้อมูลเบราว์เซอร์หรือใช้โหมดส่วนตัวจะถูกนับใหม่
     - ไม่กรองบอต และตัวนับสาธารณะเขียนได้ทุกคน จึงเป็นตัวเลขประมาณการ ไม่ใช่ตัวเลขที่ใช้อ้างอิงทางการ
   ไม่นับเมื่อเปิดจาก localhost/ไฟล์ในเครื่อง (กันตัวเลขเพี้ยนตอนพัฒนา) และเคารพ Do-Not-Track
   ไม่ส่งข้อมูลสัญญาหรือข้อมูลผู้ใช้ใด ๆ ไปกับตัวนับ มีแค่คำขอ HTTP เปล่า ๆ ที่ผู้ให้บริการเห็น IP ตามธรรมชาติของเครือข่าย
*/
'use strict';

const SiteStats = (() => {

  const BASE = 'https://abacus.jasoncameron.dev';
  const NS = 'suwit321-procurement-analytics';
  const LS_KEY = 'pa.site.v1';
  const SS_KEY = 'pa.site.session';

  const host = location.hostname;
  const isLocal = !host || host === 'localhost' || host === '127.0.0.1' || host === '[::1]'
    || host.endsWith('.localhost') || host.endsWith('.test') || host.endsWith('.local') || location.protocol === 'file:';
  const dnt = navigator.doNotTrack === '1' || window.doNotTrack === '1';
  const canCount = !isLocal && !dnt;

  let api = {};
  let pending = Promise.resolve();   // คำขอนับที่ยังค้างอยู่ — ตอนเปิดแผงต้องรอให้เสร็จก่อนอ่านค่า จะได้รวมครั้งของตัวเอง
  let local = null;                  // บันทึกในเบราว์เซอร์นี้
  let panelOpen = false;

  /* ---------- บันทึกในเบราว์เซอร์นี้ ---------- */

  function loadLocal() {
    try { return JSON.parse(localStorage.getItem(LS_KEY)) || null; } catch (e) { return null; }
  }
  function saveLocal() {
    try { localStorage.setItem(LS_KEY, JSON.stringify(local)); } catch (e) { /* โหมดส่วนตัวหรือพื้นที่เต็ม — ไม่กระทบการทำงาน */ }
  }
  function sessionSeen() {
    try { return sessionStorage.getItem(SS_KEY) === '1'; } catch (e) { return false; }
  }
  function markSession() {
    try { sessionStorage.setItem(SS_KEY, '1'); } catch (e) { /* ไม่สำคัญ */ }
  }

  /* ---------- ตัวนับระยะไกล ---------- */

  async function remote(action, key) {
    const res = await fetch(`${BASE}/${action}/${NS}/${key}`, { mode: 'cors', cache: 'no-store', keepalive: action === 'hit' });
    if (res.status === 404) return 0;        // ยังไม่เคยมีใครถูกนับ
    if (!res.ok) throw new Error('HTTP ' + res.status);
    const j = await res.json();
    return Number(j.value);
  }

  function track() {
    const now = Date.now();
    const fresh = !loadLocal();
    local = loadLocal() || { id: Math.random().toString(36).slice(2) + now.toString(36), first: now, visits: 0, last: null, prev: null, counted: false };
    const newSession = !sessionSeen();
    if (newSession) {
      local.visits += 1;
      local.prev = local.last;
      local.last = now;
      markSession();
      saveLocal();
    } else if (fresh) saveLocal();

    if (!canCount) return;
    const jobs = [];
    if (newSession) jobs.push(remote('hit', 'views').catch(() => null));
    if (!local.counted) {
      jobs.push(remote('hit', 'visitors').then(() => { local.counted = true; saveLocal(); }).catch(() => null));
    }
    pending = Promise.all(jobs);
  }

  /* ---------- แผง ---------- */

  const $ = id => document.getElementById(id);
  const th = ms => (ms ? new Date(ms).toLocaleString('th-TH', { dateStyle: 'medium', timeStyle: 'short' }) : '-');

  function scriptVersion() {
    const s = [...document.querySelectorAll('script[src*="app.js"]')][0];
    const m = s && /[?&]v=(\d+)/.exec(s.src);
    return m ? `app.js v${m[1]}` : '-';
  }

  function systemRows() {
    const meta = (api.meta && api.meta()) || {};
    const ds = (api.dataset && api.dataset()) || {};
    const deep = window.DeepPattern && window.DeepPattern.snapshot ? window.DeepPattern.snapshot() : null;
    const model = deep && deep.payload ? deep.payload.meta.model_version : null;
    const rows = [
      ['ชุดข้อมูลที่ใช้อยู่', ds.name ? `${ds.name}${ds.kind && ds.kind !== 'base' ? ' (นำเข้าเอง)' : ''}` : '-'],
      ['จำนวนสัญญา', api.records ? U.num(api.records()) : '-'],
      ['ช่วงวันทำสัญญา', meta.contract_date_min ? `${U.thaiDate(meta.contract_date_min)} ถึง ${U.thaiDate(meta.contract_date_max)}` : '-'],
      ['สร้างข้อมูลเมื่อ', meta.generated_at ? th(Date.parse(meta.generated_at)) : '-'],
      ['ไฟล์ต้นทาง', meta.source_file || '-'],
      ['โมเดล Autoencoder', model || 'ยังไม่ได้โหลด (เปิดแท็บรูปแบบเชิงลึกก่อน)'],
      ['เวอร์ชันสคริปต์', scriptVersion()],
      ['ที่อยู่หน้านี้', location.origin + location.pathname],
    ];
    return rows.map(([k, v]) => `<tr><th scope="row">${U.esc(k)}</th><td>${U.esc(String(v))}</td></tr>`).join('');
  }

  function systemText() {
    const rows = [...document.querySelectorAll('#siteStatsSys tr')].map(tr => `${tr.cells[0].textContent}: ${tr.cells[1].textContent}`);
    return ['Procurement Analytics', ...rows,
      `เบราว์เซอร์: ${navigator.userAgent}`, `หน้าจอ: ${screen.width}x${screen.height} · ธีม: ${document.documentElement.getAttribute('data-theme') || 'light'}`,
      `เวลา: ${new Date().toISOString()}`].join('\n');
  }

  function build() {
    const btn = document.createElement('button');
    btn.type = 'button'; btn.id = 'siteStatsBtn'; btn.className = 'sitestats-btn';
    btn.setAttribute('aria-haspopup', 'dialog'); btn.setAttribute('aria-expanded', 'false');
    btn.setAttribute('aria-controls', 'siteStatsPanel');
    btn.setAttribute('aria-label', 'ข้อมูลเว็บไซต์และสถิติการเข้าชม'); btn.title = 'ข้อมูลเว็บไซต์และสถิติการเข้าชม';
    btn.textContent = 'ⓘ';

    const panel = document.createElement('section');
    panel.id = 'siteStatsPanel'; panel.className = 'sitestats-panel'; panel.hidden = true;
    panel.setAttribute('role', 'dialog'); panel.setAttribute('aria-labelledby', 'siteStatsTitle');
    panel.innerHTML = `
      <header class="sitestats-head"><h2 id="siteStatsTitle">ข้อมูลเว็บไซต์</h2>
        <button type="button" class="sitestats-x" id="siteStatsClose" aria-label="ปิด">✕</button></header>
      <div class="sitestats-body">
        <div class="section-label mb-1">สถิติการเข้าชม</div>
        <div id="siteStatsCounts" aria-live="polite"></div>
        <div class="section-label mt-3 mb-1">เบราว์เซอร์นี้</div>
        <div id="siteStatsMine"></div>
        <div class="section-label mt-3 mb-1">ข้อมูลระบบ</div>
        <table class="sitestats-table"><tbody id="siteStatsSys"></tbody></table>
        <div class="d-flex gap-2 flex-wrap mt-2">
          <button type="button" class="btn btn-sm btn-outline-secondary" id="siteStatsCopy">คัดลอกข้อมูลระบบ</button>
          <button type="button" class="btn btn-sm btn-outline-secondary" id="siteStatsReset">ล้างบันทึกในเบราว์เซอร์นี้</button>
        </div>
        <details class="mt-2 sitestats-note"><summary>ตัวเลขนี้นับอย่างไร / ความเป็นส่วนตัว</summary>
          <ul class="mb-0">
            <li><b>ครั้งที่เข้าชม</b> นับ 1 ต่อ 1 เซสชันของแท็บ (รวมคนเดิมที่กลับมา) รีเฟรชหน้าไม่นับเพิ่ม</li>
            <li><b>ผู้เข้าชมไม่ซ้ำ</b> นับต่อเบราว์เซอร์/อุปกรณ์ ไม่ใช่ต่อคน — ใช้สองเครื่องนับสองครั้ง ล้างข้อมูลเบราว์เซอร์หรือใช้โหมดส่วนตัวจะนับใหม่</li>
            <li>ไม่กรองบอต และตัวนับสาธารณะ เขียนได้ทุกคน จึงเป็นตัวเลข<b>ประมาณการ</b> ไม่ควรใช้อ้างอิงทางการ</li>
            <li>ส่งไปที่ตัวนับของ abacus.jasoncameron.dev แค่คำขอเปล่า ไม่มีข้อมูลสัญญาหรือข้อมูลส่วนตัวแนบไป (ผู้ให้บริการเห็น IP ตามปกติของเครือข่าย)</li>
            <li>ไม่นับเมื่อเปิดจากเครื่องตัวเอง (localhost) และไม่นับเมื่อเบราว์เซอร์ตั้ง Do-Not-Track</li>
            <li>เก็บในเบราว์เซอร์นี้เฉพาะรหัสสุ่ม จำนวนครั้งที่เข้า และเวลาเข้าครั้งแรก/ล่าสุด (localStorage) กดล้างได้ด้านบน</li>
          </ul></details>
      </div>`;
    document.body.append(btn, panel);

    btn.addEventListener('click', () => toggle());
    $('siteStatsClose').addEventListener('click', () => toggle(false));
    document.addEventListener('keydown', e => { if (e.key === 'Escape' && panelOpen) { toggle(false); btn.focus(); } });
    document.addEventListener('click', e => { if (panelOpen && !e.target.closest('#siteStatsPanel, #siteStatsBtn')) toggle(false); });
    $('siteStatsCopy').addEventListener('click', async () => {
      try { await navigator.clipboard.writeText(systemText()); $('siteStatsCopy').textContent = 'คัดลอกแล้ว ✓'; }
      catch (e) { $('siteStatsCopy').textContent = 'คัดลอกไม่สำเร็จ'; }
      setTimeout(() => { $('siteStatsCopy').textContent = 'คัดลอกข้อมูลระบบ'; }, 1600);
    });
    $('siteStatsReset').addEventListener('click', () => {
      try { localStorage.removeItem(LS_KEY); sessionStorage.removeItem(SS_KEY); } catch (e) { /* ไม่สำคัญ */ }
      local = { id: null, first: null, visits: 0, last: null, prev: null, counted: false };
      renderMine();
    });
  }

  function renderMine() {
    const l = local || {};
    $('siteStatsMine').innerHTML = U.kpiRow([
      U.kpiTile('เข้ามาแล้ว', `${U.num(l.visits || 0)} ครั้ง`, `ครั้งแรก ${th(l.first)}`),
      U.kpiTile('ครั้งก่อนหน้า', l.prev ? th(l.prev) : '-', l.prev ? '' : 'ครั้งแรกของเบราว์เซอร์นี้'),
    ]);
  }

  async function renderCounts() {
    const box = $('siteStatsCounts');
    if (isLocal) {
      box.innerHTML = '<div class="ma-note">เปิดจากเครื่องตัวเอง (localhost) — ไม่นับ และไม่ดึงตัวเลขจริง ตัวนับจะทำงานหลังนำขึ้นเว็บ (deploy)</div>';
      return;
    }
    box.innerHTML = '<div class="small-muted">กำลังอ่านตัวเลข...</div>';
    try {
      await pending;
      const [views, visitors] = await Promise.all([remote('get', 'views'), remote('get', 'visitors')]);
      box.innerHTML = U.kpiRow([
        U.kpiTile('ผู้เข้าชมไม่ซ้ำ', U.num(visitors), 'นับต่อเบราว์เซอร์/อุปกรณ์', 'info'),
        U.kpiTile('ครั้งที่เข้าชม (รวมซ้ำ)', U.num(views), 'นับ 1 ต่อ 1 เซสชัน'),
      ]) + (dnt ? '<div class="small-muted mt-1">เบราว์เซอร์ตั้ง Do-Not-Track — ครั้งนี้ไม่ถูกนับ</div>' : '');
    } catch (e) {
      box.innerHTML = '<div class="ma-note is-warn">อ่านตัวเลขจากตัวนับไม่สำเร็จ (ผู้ให้บริการอาจไม่ตอบหรือเครือข่ายบล็อก) ไม่กระทบการใช้งานส่วนอื่น</div>';
    }
  }

  function toggle(force) {
    panelOpen = typeof force === 'boolean' ? force : !panelOpen;
    $('siteStatsPanel').hidden = !panelOpen;
    $('siteStatsBtn').setAttribute('aria-expanded', String(panelOpen));
    $('siteStatsBtn').classList.toggle('is-open', panelOpen);
    if (!panelOpen) return;
    $('siteStatsSys').innerHTML = systemRows();     // อ่านใหม่ทุกครั้งที่เปิด เพราะชุดข้อมูล/โมเดลอาจเปลี่ยนไปแล้ว
    renderMine();
    renderCounts();
    $('siteStatsClose').focus();
  }

  function init(hooks) {
    api = hooks || {};
    if ($('siteStatsBtn')) return;
    build();
  }

  // นับตั้งแต่โหลดสคริปต์ ไม่รอ boot ของแอป และไม่บล็อกการวาดหน้า
  track();

  return { init, toggle };
})();
