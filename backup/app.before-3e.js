/* app.js — ชั้นแสดงผลและการเชื่อมต่อ

   ต่างจากเดิมตรงที่ตัวกรองเป็นส่วนกลาง ทุกแท็บอ่านจากชุดระเบียนที่กรองแล้วชุดเดียวกัน
   และคำนวณใหม่ทุกครั้งที่ตัวกรองหรือค่าของกฎเปลี่ยน
*/
'use strict';

const App = (() => {

  const state = {
    payload: null,
    records: [],
    filtered: [],
    ctx: null,
    settings: null,
    nodeIndex: new Map(),
    summary: null,
    profiles: null,
    filters: { q: '', province: '', method: '', type: '', band: '', rule: '', minValue: 0, bounds: null, flagged: false },
    net: {
      view: 'sankey', topN: 40, minValue: 0, minContracts: 1, colorBy: 'entity',
      agency: '', contractor: '', rule: '', band: '', flaggedOnly: false, maskedOut: false,
    },
    contractor: { q: '', riskMin: 0, contractMin: 1, selected: null },
    ts: { dimension: 'purchase_method_name', metric: 'counts' },
    selectedRecord: null,
    map: {
      mode: 'cluster', colorBy: 'band', basemap: 'light', sizeByValue: true,
      hidden: new Set(),   // กลุ่มที่ถูกปิดจากคำอธิบายสัญลักษณ์
      timelapse: { playing: false, monthIndex: 0, months: [], timer: null },
    },
    compare: { type: 'contractor', a: null, b: null },
    dirty: new Set(),
  };

  let map, baseLayer, clusterLayer, pointLayer, heatLayer, modalInstance;

  const TAB_RENDERERS = {
    'tab-overview': renderOverview,
    'tab-explain': renderExplain,
    'tab-fraud': renderFraud,
    'tab-anomaly': renderAnomaly,
    'tab-network': renderNetwork,
    'tab-contractor': renderContractor,
    'tab-time': renderTimeseries,
    'tab-rules': renderRuleSettings,
    'tab-demo': renderDemo,
  };

  /* =========================================================
     การโหลด
     ========================================================= */

  async function boot() {
    const bootMsg = U.$('bootMessage');
    try {
      bootMsg.textContent = 'กำลังดาวน์โหลดข้อมูล...';
      // no-cache บังคับให้ตรวจกับเซิร์ฟเวอร์ก่อนเสมอ ไม่ใช่ไม่แคชเลย
      // ป้องกันไม่ให้เบราว์เซอร์ใช้ข้อมูลเก่าค้างหลังสร้าง data.json ใหม่
      const res = await fetch('data/data.json', { cache: 'no-cache' });
      if (!res.ok) throw new Error('HTTP ' + res.status);
      const text = await res.text();

      bootMsg.textContent = 'กำลังอ่านข้อมูล...';
      state.payload = JSON.parse(text);
      state.records = state.payload.records || [];

      // สตริงค้นหาเตรียมไว้ล่วงหน้า — ของเดิมเรียก JSON.stringify ทุกระเบียนทุกครั้งที่พิมพ์
      for (const r of state.records) {
        r._search = (r.project_name + ' ' + r.dept_name + ' ' + r.winner_name + ' ' +
          r.project_id + ' ' + r.winner_tin + ' ' + r.contract_no).toLowerCase();
      }

      state.nodeIndex = new Map((state.payload.network_nodes || []).map(n => [n.id, n]));

      bootMsg.textContent = 'กำลังสร้างดัชนีสำหรับประเมินความเสี่ยง...';
      state.ctx = Rules.buildContext(state.records);
      state.settings = Rules.loadSettings();

      bootMsg.textContent = 'กำลังประเมินกฎความเสี่ยง...';
      Rules.evaluate(state.records, state.ctx, state.settings);

      buildFilterOptions();
      wireGlobalFilters();
      wireTabs();
      wireControls();
      TableSort.init();
      readHash();
      applyFilters();

      U.$('bootScreen').hidden = true;
      U.$('appRoot').hidden = false;
      renderMeta();
    } catch (err) {
      showBootError(err);
    }
  }

  /** แสดงข้อผิดพลาดพร้อมปุ่มลองใหม่ — ของเดิมล้าง document.body ทั้งหน้าและกู้คืนไม่ได้ */
  function showBootError(err) {
    const isFileProtocol = location.protocol === 'file:';
    U.$('bootScreen').innerHTML = `
      <div class="text-center" style="max-width:560px">
        <div class="h5 mb-3">โหลดข้อมูลไม่สำเร็จ</div>
        <div class="alert alert-danger text-start small">${U.esc(String(err))}</div>
        ${isFileProtocol ? `
          <div class="alert alert-warning text-start small">
            หน้านี้ถูกเปิดจากไฟล์โดยตรง เบราว์เซอร์จึงไม่อนุญาตให้อ่านไฟล์ข้อมูล<br>
            ให้เปิดผ่านเว็บเซิร์ฟเวอร์แทน เช่นสั่ง
            <code>python -m http.server 8000</code> ในโฟลเดอร์โปรเจกต์
            แล้วเปิด <code>http://localhost:8000</code>
          </div>` : ''}
        <button class="btn btn-primary" onclick="location.reload()">ลองใหม่</button>
      </div>`;
    console.error(err);
  }

  function renderMeta() {
    const m = state.payload.meta || {};
    U.$('metaLine').textContent =
      `${U.num(m.total_records)} สัญญา · ${m.contract_date_min || '?'} ถึง ${m.contract_date_max || '?'} · ${m.n_provinces || 0} จังหวัด`;
  }

  /* =========================================================
     ตัวกรองส่วนกลาง
     ========================================================= */

  function buildFilterOptions() {
    const m = state.payload.meta || {};
    fillSelect('gfProvince', 'ทุกจังหวัด', m.provinces || []);
    fillSelect('gfMethod', 'ทุกวิธี', m.methods || []);
    fillSelect('gfType', 'ทุกประเภท', m.project_types || []);
    // "ควรตรวจสอบก่อน" คือวิกฤต+สูงรวมกัน ตรงกับตัวเลขบนการ์ด KPI ใบที่สอง
    // มีไว้เพื่อให้กดการ์ดแล้วได้ชุดข้อมูลเดียวกับที่การ์ดนับจริง
    U.setHTML('gfBand', '<option value="">ทุกระดับ</option>' +
      '<option value="priority">ควรตรวจสอบก่อน (วิกฤต+สูง)</option>' +
      Rules.BANDS.filter(b => b.key !== 'none')
        .map(b => `<option value="${b.key}">${U.esc(b.label)}</option>`).join('') +
      '<option value="none">ไม่พบสัญญาณ</option>');
    U.setHTML('gfRule', '<option value="">ทุกกฎ</option>' +
      Rules.DEFS.map(d => `<option value="${d.id}">${d.id} · ${U.esc(d.name)}</option>`).join(''));
  }

  function fillSelect(id, allLabel, values) {
    U.setHTML(id, `<option value="">${U.esc(allLabel)}</option>` +
      values.map(v => `<option value="${U.esc(v)}">${U.esc(v)}</option>`).join(''));
  }

  function wireGlobalFilters() {
    const onChange = () => { syncFiltersFromUI(); applyFilters(); };
    ['gfProvince', 'gfMethod', 'gfType', 'gfBand', 'gfRule'].forEach(id =>
      U.$(id).addEventListener('change', onChange));
    U.$('gfSearch').addEventListener('input', U.debounce(onChange, 250));
    U.$('gfMinValue').addEventListener('input', U.debounce(onChange, 300));
    U.$('gfReset').addEventListener('click', resetAllFilters);

    // ป้ายเงื่อนไขในสรุปตัวกรอง กดกากบาทเพื่อยกเลิกทีละเงื่อนไข
    U.$('gfSummary').addEventListener('click', e => {
      const clear = e.target.closest('[data-clear]');
      if (!clear) return;
      clearOneFilter(clear.dataset.clear);
    });

    wireFilterShortcuts();
    wireMoreFilters();
  }

  const FILTER_CONTROL = {
    q: 'gfSearch', province: 'gfProvince', method: 'gfMethod',
    type: 'gfType', band: 'gfBand', rule: 'gfRule', minValue: 'gfMinValue',
  };

  function resetAllFilters() {
    state.filters = { q: '', province: '', method: '', type: '', band: '', rule: '', minValue: 0, bounds: null, flagged: false };
    Object.values(FILTER_CONTROL).forEach(id => { U.$(id).value = ''; });
    applyFilters();
  }

  /** ยกเลิกเงื่อนไขเดียวจากป้ายที่กดกากบาท */
  function clearOneFilter(key) {
    if (key === 'all') { resetAllFilters(); return; }
    if (key === 'bounds') state.filters.bounds = null;
    else if (key === 'flagged') state.filters.flagged = false;
    else {
      state.filters[key] = key === 'minValue' ? 0 : '';
      const control = FILTER_CONTROL[key];
      if (control) U.$(control).value = '';
    }
    applyFilters();
  }

  /** ปุ่มทางลัดใต้ KPI และการ์ด KPI ที่กดได้ ตั้งตัวกรองให้ตรงกับตัวเลขที่การ์ดนับ */
  function applyShortcut(kind) {
    if (kind === 'clear') { resetAllFilters(); return; }
    if (kind === 'flagged') {
      state.filters.flagged = !state.filters.flagged;
    } else {
      // กดซ้ำที่ระดับเดิม = ยกเลิก เพื่อให้ปุ่มทำหน้าที่สลับเปิดปิดได้ในตัว
      state.filters.band = state.filters.band === kind ? '' : kind;
      U.$('gfBand').value = state.filters.band;
    }
    applyFilters();
  }

  /** ไฮไลต์ปุ่มทางลัดให้ตรงกับตัวกรองที่ใช้อยู่จริง กดแล้วเห็นทันทีว่ากำลังกรองอะไร */
  function renderQuickFilters() {
    document.querySelectorAll('.quick-chip[data-shortcut]').forEach(btn => {
      const kind = btn.dataset.shortcut;
      if (kind === 'clear') return;
      const on = kind === 'flagged' ? state.filters.flagged : state.filters.band === kind;
      btn.classList.toggle('is-on', on);
      btn.setAttribute('aria-pressed', String(on));
    });
  }

  function wireFilterShortcuts() {
    document.addEventListener('click', e => {
      const el = e.target.closest('[data-shortcut]');
      if (!el) return;
      applyShortcut(el.dataset.shortcut);
    });
  }

  /** ตัวกรองที่ใช้ไม่บ่อยถูกพับไว้ ลดจำนวนช่องที่เห็นครั้งแรกจาก 8 เหลือ 4 */
  function wireMoreFilters() {
    const btn = U.$('gfMoreToggle');
    const panel = U.$('gfMore');
    if (!btn || !panel) return;
    btn.addEventListener('click', () => {
      const open = panel.hidden;
      panel.hidden = !open;
      btn.setAttribute('aria-expanded', String(open));
      btn.classList.toggle('is-open', open);
    });
  }

  function syncFiltersFromUI() {
    state.filters = {
      q: U.$('gfSearch').value.trim().toLowerCase(),
      province: U.$('gfProvince').value,
      method: U.$('gfMethod').value,
      type: U.$('gfType').value,
      band: U.$('gfBand').value,
      rule: U.$('gfRule').value,
      minValue: (Number(U.$('gfMinValue').value) || 0) * 1e6,
      // สองค่านี้ไม่มีตัวควบคุมในแถบตัวกรอง (มาจากกรอบแผนที่และปุ่มทางลัด) จึงต้องคงค่าไว้เอง
      bounds: state.filters.bounds,
      flagged: state.filters.flagged,
    };
  }

  function matches(r) {
    const f = state.filters;
    if (f.province && r.province !== f.province) return false;
    if (f.method && r.purchase_method_name !== f.method) return false;
    if (f.type && r.project_type_name !== f.type) return false;
    if (f.band === 'priority') {
      if (r.risk_band !== 'critical' && r.risk_band !== 'high') return false;
    } else if (f.band && r.risk_band !== f.band) return false;
    if (f.flagged && !(r.rule_hits || []).length) return false;
    if (f.minValue && (r.contract_price_agree || 0) < f.minValue) return false;
    if (f.rule && !(r.rule_hits || []).some(h => h.rule_id === f.rule)) return false;
    if (f.q && !r._search.includes(f.q)) return false;
    if (f.bounds) {
      // สัญญาที่ไม่มีพิกัดจะไม่เข้าเกณฑ์พื้นที่ จึงถูกตัดออกเมื่อกรองตามกรอบแผนที่
      if (r.lat === null || r.lon === null) return false;
      const b = f.bounds;
      if (r.lat < b.south || r.lat > b.north || r.lon < b.west || r.lon > b.east) return false;
    }
    return true;
  }

  /** จุดศูนย์กลาง: กรอง -> สรุป -> ทำให้ทุกแท็บล้าสมัย -> วาดแท็บที่กำลังเปิด */
  function applyFilters() {
    state.filtered = state.records.filter(matches);
    state.filtered.sort((a, b) => b.risk_score - a.risk_score ||
      (b.contract_price_agree || 0) - (a.contract_price_agree || 0));
    state.summary = Rules.summarize(state.filtered);
    state.profiles = null;
    state.selectedRecord = state.filtered[0] || null;
    state.contractor.selected = null;

    renderKPIs();
    renderQuickFilters();
    renderFilterSummary();
    state.dirty = new Set(Object.keys(TAB_RENDERERS));
    renderActiveTab();
    writeHash();
  }

  function renderFilterSummary() {
    const f = state.filters;
    const bandLabel = f.band === 'priority'
      ? 'ควรตรวจสอบก่อน (วิกฤต+สูง)'
      : (Rules.BANDS.find(b => b.key === f.band)?.label || f.band);

    // [คีย์ที่ใช้ยกเลิก, ข้อความบนป้าย]
    const parts = [];
    if (f.q) parts.push(['q', `ค้นหา "${f.q}"`]);
    if (f.province) parts.push(['province', f.province]);
    if (f.method) parts.push(['method', f.method]);
    if (f.type) parts.push(['type', f.type]);
    if (f.band) parts.push(['band', 'ระดับ ' + bandLabel]);
    if (f.flagged) parts.push(['flagged', 'เฉพาะที่พบสัญญาณ']);
    if (f.rule) parts.push(['rule', 'กฎ ' + f.rule]);
    if (f.minValue) parts.push(['minValue', `มูลค่า ≥ ${U.money(f.minValue)}`]);
    if (f.bounds) parts.push(['bounds', 'เฉพาะพื้นที่บนแผนที่']);

    const n = state.filtered.length, total = state.records.length;
    if (!parts.length) {
      U.setHTML('gfSummary', `แสดงทั้งหมด <strong>${U.num(total)}</strong> สัญญา`);
      return;
    }

    // ทุกป้ายกดกากบาทเพื่อยกเลิกเฉพาะเงื่อนไขนั้นได้ ไม่ต้องไปหาช่องที่ตั้งไว้
    const chips = parts.map(([key, text]) =>
      `<span class="chip chip-removable${key === 'bounds' ? ' chip-bounds' : ''}">${U.esc(text)}` +
      `<button type="button" class="chip-x" data-clear="${key}"` +
      ` title="ยกเลิกเงื่อนไขนี้" aria-label="ยกเลิกเงื่อนไข ${U.esc(text)}">✕</button></span>`).join(' ');

    U.setHTML('gfSummary',
      `<strong>${U.num(n)}</strong> จาก ${U.num(total)} สัญญา · ${chips} ` +
      `<button type="button" class="chip chip-clear-all" data-clear="all"` +
      ` title="ล้างตัวกรองทั้งหมด">ล้างทั้งหมด</button>`);
  }

  function renderKPIs() {
    const s = state.summary;
    const value = U.sum(state.filtered.map(r => r.contract_price_agree));
    const realRules = Rules.DEFS.filter(d => d.source === 'real' && s.counts.get(d.id).n > 0).length;

    // พาดหัวเป็นจำนวนที่ "ควรตรวจสอบก่อน" ไม่ใช่จำนวนที่พบสัญญาณ
    // เพราะกฎน้ำหนักต่ำอย่าง R9/R13/R14 เข้าเงื่อนไขเป็นวงกว้าง
    // ตัวเลขรวมจึงสูงจนไม่ช่วยจัดลำดับความสำคัญ
    const priority = state.filtered.filter(r => r.risk_band === 'critical' || r.risk_band === 'high');
    const priorityValue = U.sum(priority.map(r => r.contract_price_agree));

    // การ์ดที่มี shortcut กดแล้วกรองให้ตรงกับตัวเลขที่การ์ดนับอยู่จริง
    const items = [
      ['สัญญาที่แสดงอยู่', U.num(s.total), `มูลค่ารวม ${U.money(value)} บาท`, null],
      ['ควรตรวจสอบก่อน', U.num(priority.length),
        `วิกฤต ${U.num(s.bandCounts.critical)} · สูง ${U.num(s.bandCounts.high)}` +
        (s.total ? ` (${U.pct(priority.length / s.total)})` : ''), 'priority'],
      ['มูลค่าที่ควรตรวจสอบก่อน', U.money(priorityValue) + ' บาท',
        value ? `${U.pct(priorityValue / value)} ของมูลค่ารวม` : '-', 'priority'],
      ['พบสัญญาณอย่างน้อย 1 ข้อ', U.num(s.flagged),
        `กฎที่ทำงานจริง ${realRules} จาก ${Rules.DEFS.filter(d => d.source === 'real').length} ข้อ`, 'flagged'],
    ];
    U.setHTML('kpis', items.map(i => {
      const [label, val, sub, shortcut] = i;
      const on = shortcut === 'flagged' ? state.filters.flagged : state.filters.band === shortcut;
      const tag = shortcut ? 'button' : 'div';
      const attrs = shortcut
        ? ` type="button" data-shortcut="${shortcut}" aria-pressed="${on}"` +
          ` title="คลิกเพื่อกรองเฉพาะกลุ่มนี้ กดซ้ำเพื่อยกเลิก"`
        : '';
      return `
      <div class="col-6 col-lg-3"><${tag} class="cardx kpi${shortcut ? ' kpi-clickable' : ''}${on ? ' is-on' : ''}"${attrs}>
        <div class="small-muted">${label}</div>
        <div class="v">${val}</div>
        <div class="small-muted">${sub}</div>
        ${shortcut ? '<span class="kpi-hint" aria-hidden="true">คลิกเพื่อกรอง</span>' : ''}
      </${tag}></div>`;
    }).join(''));
  }

  /* =========================================================
     แท็บ
     ========================================================= */

  function wireTabs() {
    document.querySelectorAll('[data-bs-toggle="pill"]').forEach(btn => {
      btn.addEventListener('shown.bs.tab', () => {
        renderActiveTab();
        const pane = document.querySelector(btn.dataset.bsTarget);
        Charts.resizeIn(pane);
        if (btn.dataset.bsTarget === '#tab-explain' && map) map.invalidateSize();
        syncGroupToActiveTab();
        writeHash();
      });
    });
    wireGroupNav();
  }

  function activeTabId() {
    return document.querySelector('.tab-pane.active')?.id || 'tab-overview';
  }

  /* ---------- นำทางสองระดับ: กลุ่มงาน -> แท็บย่อย ----------

     ปุ่มแท็บทั้ง 9 อันยังเป็นของ Bootstrap เหมือนเดิมทุกประการ
     ชั้นกลุ่มเป็นเพียงตัวสลับว่าจะโชว์แถวแท็บย่อยชุดไหน แล้วสั่ง .show() ให้แท็บในกลุ่มนั้น
     ทำให้ลิงก์เดิมแบบ #tab=network ยังใช้ได้ และไม่ต้องแตะ TAB_RENDERERS เลย */

  const NAV_GROUP_KEY = 'pa_nav_last_tab_of_group';

  function loadGroupMemory() {
    try { return JSON.parse(localStorage.getItem(NAV_GROUP_KEY)) || {}; }
    catch (e) { return {}; }
  }
  function saveGroupMemory(mem) {
    try { localStorage.setItem(NAV_GROUP_KEY, JSON.stringify(mem)); }
    catch (e) { /* โหมดส่วนตัวหรือพื้นที่เต็ม ไม่ใช่เรื่องคอขาดบาดตาย */ }
  }

  function groupOfPill(btn) {
    return btn?.closest('li[data-group]')?.dataset.group || null;
  }

  /** โชว์แท็บย่อยเฉพาะของกลุ่มที่เลือก และไฮไลต์ปุ่มกลุ่ม
   *
   *  ซ่อนที่ระดับ <li> ไม่ใช่แยก tablist ออกเป็นหลายชุด เพราะ Bootstrap หา
   *  "แท็บที่ต้องปิด" จากพี่น้องใน tablist เดียวกันเท่านั้น ถ้าแยก tablist
   *  การเปิดแท็บข้ามกลุ่มจะไม่ปิดแท็บเดิม แล้วจะมีหลาย pane active พร้อมกัน */
  function showGroupRow(group) {
    document.querySelectorAll('.group-btn').forEach(b => {
      const on = b.dataset.group === group;
      b.classList.toggle('active', on);
      b.setAttribute('aria-pressed', String(on));
    });
    let visible = 0;
    document.querySelectorAll('.tab-subnav li[data-group]').forEach(li => {
      const on = li.dataset.group === group;
      li.hidden = !on;
      if (on) visible++;
    });
    // กลุ่มที่มีแท็บเดียว ปุ่มกลุ่มก็สื่อความหมายครบแล้ว ไม่ต้องโชว์แถวย่อยซ้ำ
    const ul = document.querySelector('.tab-subnav');
    if (ul) ul.hidden = visible <= 1;
  }

  /** เปิดกลุ่มให้ตรงกับแท็บที่กำลัง active อยู่ (ใช้ตอน deep link และตอนสลับแท็บ) */
  function syncGroupToActiveTab() {
    const pill = document.querySelector('.tab-subnav .nav-link.active');
    const group = groupOfPill(pill);
    if (!group) return;
    showGroupRow(group);
    const mem = loadGroupMemory();
    mem[group] = pill.id;
    saveGroupMemory(mem);
  }

  function wireGroupNav() {
    document.querySelectorAll('.group-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        const group = btn.dataset.group;
        showGroupRow(group);

        const pills = [...document.querySelectorAll(`.tab-subnav li[data-group="${group}"] .nav-link`)];
        if (!pills.length) return;
        // ถ้าแท็บที่เปิดอยู่อยู่ในกลุ่มนี้แล้ว ไม่ต้องสลับซ้ำ
        if (pills.some(p => p.classList.contains('active'))) return;

        const remembered = loadGroupMemory()[group];
        const target = pills.find(p => p.id === remembered) || pills[0];
        bootstrap.Tab.getOrCreateInstance(target).show();
      });
    });
    // ตั้งสถานะเริ่มต้นให้ตรงกับแท็บที่ active อยู่ตอนโหลด (ไม่มี event ให้รอ)
    syncGroupToActiveTab();
  }

  /** วาดเฉพาะแท็บที่เปิดอยู่และยังล้าสมัย — ของเดิมวาดทุกกราฟทุกแท็บตอนโหลด */
  function renderActiveTab() {
    const id = activeTabId();
    if (!state.dirty.has(id)) return;
    try {
      TAB_RENDERERS[id]?.();
      state.dirty.delete(id);
    } catch (e) {
      console.error('วาดแท็บ ' + id + ' ไม่สำเร็จ', e);
    }
  }

  /* =========================================================
     แท็บภาพรวม
     ========================================================= */

  function renderOverview() {
    const s = state.summary;
    const rows = state.filtered;

    const cliff = Analytics.thresholdCliff(rows);
    const priority = rows.filter(r => r.risk_band === 'critical' || r.risk_band === 'high');
    U.setHTML('overviewLede',
      `จากสัญญา ${U.num(s.total)} รายการที่กำลังแสดง มี ${U.num(priority.length)} รายการ ` +
      `ที่อยู่ในระดับควรตรวจสอบก่อน คิดเป็นมูลค่า ${U.money(U.sum(priority.map(r => r.contract_price_agree)))} บาท` +
      (cliff.ratio ? ` · สัญญาในช่วงใต้เพดาน ${U.money(cliff.ceiling)} มีจำนวนมากกว่าช่วงเหนือเพดาน ${cliff.ratio.toFixed(1)} เท่า` : ''));

    const bands = Rules.BANDS.filter(b => (s.bandCounts[b.key] || 0) > 0);
    Charts.donut('ovBandDonut', bands.map(b => b.label),
      bands.map(b => s.bandCounts[b.key]), bands.map(b => b.color));

    const ruleStats = Rules.DEFS
      .map(d => ({ d, n: s.counts.get(d.id).n }))
      .filter(x => x.n > 0)
      .sort((a, b) => b.n - a.n);
    Charts.bar('ovRuleBar', ruleStats.map(x => x.d.id + ' ' + x.d.name.slice(0, 26)),
      ruleStats.map(x => x.n), {
      horizontal: true,
      colors: ruleStats.map(x => x.d.source === 'synthetic' ? Charts.C.purple : Charts.C.teal),
      axisTitle: 'จำนวนสัญญา',
    });

    const ts = Analytics.timeseries(rows, 'risk_band');
    Charts.lines('ovMonthly', ts.months.map(U.thaiMonthLabel),
      ts.series.map(x => ({ name: bandLabel(x.name), y: x.counts })), { yTitle: 'จำนวนสัญญา' });

    const methods = [...U.countBy(rows, r => r.purchase_method_name)]
      .sort((a, b) => b[1] - a[1]).slice(0, 6);
    Charts.donut('ovMethodDonut', methods.map(m => m[0].slice(0, 28)), methods.map(m => m[1]));

    const agencies = Analytics.agencyTotals(rows)
      .sort((a, b) => b.n_flagged - a.n_flagged || b.total_value - a.total_value).slice(0, 12);
    U.setHTML('ovAgencyBody', agencies.map(a => `
      <tr><td>${clickable('agency', a.dept_name, a.dept_name)}</td>
      ${numTd(a.n_contracts)}
      ${numTd(a.n_flagged)}
      ${moneyTd(a.total_value)}</tr>`).join('')
      || U.emptyRow(4));

    const top = rows.filter(r => r.risk_score > 0).slice(0, 12);
    U.setHTML('ovTopRiskBody', top.map(r => `
      <tr><td>${clickable('project', r.project_id, r.project_name)}</td>
      ${moneyTd(r.contract_price_agree)}
      <td class="text-end" data-sort="${r.risk_score}">${scoreBadge(r.risk_score)}</td></tr>`).join('')
      || U.emptyRow(3, 'ไม่พบสัญญาที่มีสัญญาณความเสี่ยง'));
  }

  const bandLabel = key => Rules.BANDS.find(b => b.key === key)?.label || key;

  function scoreBadge(score) {
    const b = Rules.band(score);
    return `<span class="badge ${b.cls}">${U.num(score)}</span>`;
  }

  function clickable(type, id, label) {
    return `<span class="detail-clickable" data-type="${U.esc(type)}" data-id="${U.esc(id)}" role="button" tabindex="0">${U.esc(label)}</span>`;
  }

  /* เซลล์ตัวเลขพร้อม data-sort เป็นค่าดิบ
     จำเป็นเพราะข้อความที่แสดงถูกย่อ (เช่น "6.19 พันล้าน") การเรียงจากข้อความจึงคลาดเคลื่อน */
  const sortAttr = v => `data-sort="${v === null || v === undefined || Number.isNaN(v) ? '' : v}"`;
  const numTd = (v, cls = '') => `<td class="text-end ${cls}" ${sortAttr(v)}>${U.num(v)}</td>`;
  const moneyTd = v => `<td class="text-end metric" ${sortAttr(v)}>${U.money(v)}</td>`;
  const pctTd = (v, digits = 1) => `<td class="text-end" ${sortAttr(v)}>${U.pct(v, digits)}</td>`;
  const dateTd = iso => `<td class="text-nowrap" data-sort="${iso || ''}">${U.thaiDate(iso)}</td>`;

  /* =========================================================
     แท็บรายโครงการ + GIS
     ========================================================= */

  function renderExplain() {
    const rows = state.filtered;
    const shown = rows.slice(0, 300);

    U.$('listCount').textContent = rows.length > shown.length
      ? `แสดง ${U.num(shown.length)} จาก ${U.num(rows.length)}`
      : `${U.num(rows.length)} รายการ`;

    U.setHTML('list', shown.map((r, i) => `
      <div class="item" data-idx="${i}">
        <div class="d-flex justify-content-between gap-2">
          <strong class="small">${U.esc(truncate(r.project_name, 90))}</strong>
          ${scoreBadge(r.risk_score)}
        </div>
        <div class="small-muted">${U.esc(truncate(r.dept_name, 60))}</div>
        <div class="small-muted">${U.esc(truncate(r.winner_name, 60))} · ${U.money(r.contract_price_agree)}</div>
      </div>`).join('') || U.emptyState('ไม่พบโครงการตามเงื่อนไขที่เลือก'));

    U.$('list').querySelectorAll('.item').forEach(el => {
      el.addEventListener('click', () => {
        U.$('list').querySelectorAll('.item').forEach(x => x.classList.remove('active'));
        el.classList.add('active');
        showRecord(shown[Number(el.dataset.idx)]);
      });
    });

    initMap();
    updateMapLayers(mapRowsForDisplay());
    showRecord(state.selectedRecord || shown[0] || null);
  }

  const truncate = (s, n) => (s && s.length > n ? s.slice(0, n) + '…' : (s || ''));

  function showRecord(r) {
    state.selectedRecord = r;
    if (!r) {
      U.setHTML('detail', U.emptyState('เลือกรายการจากด้านซ้าย'));
      U.setHTML('rulesPanel', U.emptyState('ยังไม่ได้เลือกโครงการ'));
      Charts.waterfall('waterfall', [], []);
      return;
    }

    const kv = (k, v) => `<div class="detail-kv"><span class="k">${k}</span><span class="v">${v}</span></div>`;
    const ratio = r.price_build ? r.contract_price_agree / r.price_build : null;

    U.setHTML('detail', `
      <div class="mb-2 d-flex justify-content-between align-items-start gap-2">
        <strong>${U.esc(r.project_name)}</strong>
        <button class="btn btn-sm btn-outline-primary flex-shrink-0 detail-clickable"
                data-type="project" data-id="${U.esc(r.project_id)}">ดูแบบเต็ม</button>
      </div>
      ${kv('รหัสโครงการ', U.esc(r.project_id))}
      ${kv('หน่วยงาน', clickable('agency', r.dept_key, r.dept_name))}
      ${kv('ผู้รับจ้าง', clickable('contractor', r.winner_key, r.winner_name))}
      ${kv('เลขผู้เสียภาษี', U.esc(r.winner_tin) + (r.tin_is_masked ? ' <span class="badge badge-none">ถูกปิดบัง</span>' : ''))}
      ${kv('วิธีจัดหา', U.esc(r.purchase_method_name))}
      ${kv('ประเภท', U.esc(r.project_type_name))}
      ${kv('มูลค่าสัญญา', `<span class="metric">${U.baht(r.contract_price_agree)}</span>`)}
      ${kv('ราคากลาง', `<span class="metric">${U.baht(r.price_build)}</span>`)}
      ${kv('วงเงินโครงการ', `<span class="metric">${U.baht(r.project_money)}</span>`)}
      ${ratio !== null ? kv('ราคาต่อราคากลาง', `<span class="metric">${(ratio * 100).toFixed(2)}%</span>`) : ''}
      ${kv('วันทำสัญญา', U.thaiDate(r.contract_date))}
      ${kv('วันสิ้นสุด', U.thaiDate(r.contract_finish_date) +
        (r.duration_days !== null ? ` <span class="small-muted">(${U.num(r.duration_days)} วัน)</span>` : ''))}
      ${r.announce_gap_days !== null ? kv('ประกาศถึงทำสัญญา', `${U.num(r.announce_gap_days)} วัน`) : ''}
      ${kv('พื้นที่หน่วยงาน', U.esc([r.province, r.district, r.subdistrict].filter(Boolean).join(' / ')))}
      ${kv('พิกัดโครงการ', r.lat !== null
        ? `${r.lat.toFixed(5)}, ${r.lon.toFixed(5)} <a class="ms-1" target="_blank" rel="noopener noreferrer"
             href="https://www.google.com/maps?q=${r.lat},${r.lon}">เปิดแผนที่</a>`
        : '<span class="small-muted">ไม่มีพิกัดในชุดข้อมูล</span>')}
      ${kv('คะแนนความเสี่ยง', `${scoreBadge(r.risk_score)} <span class="small-muted">(รวมส่วนสาธิต ${U.num(r.risk_score_all)})</span>`)}
    `);

    const hits = r.rule_hits || [];
    U.setHTML('rulesPanel', hits.length ? hits.map(h => `
      <div class="rule-card">
        <div class="d-flex justify-content-between gap-2 mb-2">
          <strong class="small">${h.rule_id} · ${U.esc(h.rule_name)}</strong>
          <div class="flex-shrink-0">
            <span class="badge ${h.source === 'synthetic' ? 'badge-synthetic' : 'badge-real'}">${h.source === 'synthetic' ? 'สาธิต' : 'จริง'}</span>
            <span class="badge ${Rules.BANDS.find(b => b.key === h.severity)?.cls || 'badge-medium'}">+${h.weight}</span>
          </div>
        </div>
        <div class="small mb-1"><strong>ค่าที่พบ:</strong> ${U.esc(h.actual)}</div>
        <div class="codebox">${U.esc(h.logic)}</div>
        ${Diagrams.has(h.rule_id) ? `<button type="button" class="btn btn-sm btn-link p-0 mt-1 detail-clickable"
                data-type="diagram" data-id="${h.rule_id}">🔍 ดูตัวอย่างรูปแบบ</button>` : ''}
      </div>`).join('')
      : U.emptyState('ไม่พบสัญญาณความเสี่ยงในโครงการนี้'));

    Charts.waterfall('waterfall', hits.map(h => h.rule_id), hits.map(h => h.weight),
      hits.length ? `รวม ${U.num(r.risk_score)} คะแนน` : '');

    if (map && r.lat !== null) map.setView([r.lat, r.lon], 12);
  }

  /* =========================================================
     แผนที่
     ========================================================= */

  const THAILAND_VIEW = { center: [13.0, 101.0], zoom: 6 };

  // ครอบคลุมทุกจุดที่มีพิกัดในชุดข้อมูล (6,728 จุด) เพราะ Leaflet วาดบน canvas
  // การตัดจำนวนทำให้คำอธิบายสัญลักษณ์เพี้ยน เนื่องจากระเบียนเรียงตามคะแนนความเสี่ยง
  // กลุ่มที่คะแนนต่ำจึงหายไปจากสัดส่วนทั้งที่มีอยู่จริง
  const MAX_PINS = 12000;

  const BASEMAPS = {
    light: {
      url: 'https://{s}.basemaps.cartocdn.com/light_all/{z}/{x}/{y}{r}.png',
      attribution: '&copy; OpenStreetMap &copy; CARTO', maxZoom: 19, dark: false,
    },
    street: {
      url: 'https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png',
      attribution: '&copy; OpenStreetMap contributors', maxZoom: 19, dark: false,
    },
    dark: {
      url: 'https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png',
      attribution: '&copy; OpenStreetMap &copy; CARTO', maxZoom: 19, dark: true,
    },
    satellite: {
      url: 'https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}',
      attribution: 'Tiles &copy; Esri', maxZoom: 18, dark: true,
    },
  };

  const PALETTE = ['#0f766e', '#ea580c', '#7c3aed', '#1d4ed8', '#ca8a04',
    '#b91c1c', '#166534', '#db2777', '#0ea5e9', '#4b5563'];

  /** สีประจำกลุ่ม รองรับจำนวนกลุ่มเท่าใดก็ได้
   *  ถ้าเกินจำนวนสีในชุดที่เลือกไว้ จะสร้างเฉดกระจายเท่ากันแทนการวนซ้ำ
   *  เพราะการวนซ้ำทำให้คนละกลุ่มได้สีเดียวกัน (กฎมี 17 ข้อ แต่ชุดสีมี 10) */
  function categoryColor(index, total) {
    if (index < 0) return '#94a3b8';
    if (total <= PALETTE.length) return PALETTE[index % PALETTE.length];
    const hue = (index * 360 / total) % 360;
    const light = index % 2 ? 42 : 56;   // สลับความสว่าง ช่วยแยกเฉดที่อยู่ใกล้กัน
    return `hsl(${Math.round(hue)}, 64%, ${light}%)`;
  }

  /** ช่วงมูลค่าสำหรับโหมดระบายสีตามมูลค่า */
  const VALUE_BINS = [
    { max: 5e5, label: 'ไม่เกิน 5 แสน', color: '#0f766e' },
    { max: 2e6, label: '5 แสน - 2 ล้าน', color: '#0ea5e9' },
    { max: 1e7, label: '2 - 10 ล้าน', color: '#ca8a04' },
    { max: 1e8, label: '10 - 100 ล้าน', color: '#ea580c' },
    { max: Infinity, label: 'เกิน 100 ล้าน', color: '#b91c1c' },
  ];

  /** กฎที่มีน้ำหนักสูงสุดของระเบียนนั้น ใช้เป็นตัวแทนเมื่อระบายสีตามกฎ */
  function topHit(r) {
    const hits = r.rule_hits || [];
    if (!hits.length) return null;
    return hits.reduce((a, b) => (b.weight > a.weight ? b : a));
  }

  /** นิยามการจัดกลุ่มหมุด — คืน {key, label, color} ของแต่ละระเบียน
   *  ทำให้เพิ่มมิติใหม่ได้โดยแก้ที่เดียว */
  const COLOR_MODES = {
    band: {
      label: 'ระดับความเสี่ยง',
      of: r => {
        const b = Rules.band(r.risk_score);
        return { key: b.key, label: b.label, color: b.color };
      },
      order: Rules.BANDS.map(b => b.key),
    },
    rule: {
      label: 'กฎที่พบ',
      of: r => {
        const h = topHit(r);
        if (!h) return { key: '_none', label: 'ไม่พบสัญญาณ', color: '#94a3b8' };
        const i = Rules.DEFS.findIndex(d => d.id === h.rule_id);
        return { key: h.rule_id, label: h.rule_id + ' · ' + h.rule_name,
          color: categoryColor(i, Rules.DEFS.length) };
      },
      order: Rules.DEFS.map(d => d.id),
    },
    category: {
      label: 'หมวดของสัญญาณ',
      of: r => {
        const h = topHit(r);
        if (!h) return { key: '_none', label: 'ไม่พบสัญญาณ', color: '#94a3b8' };
        const cats = [...new Set(Rules.DEFS.map(d => d.category))];
        return { key: h.category, label: h.category,
          color: categoryColor(cats.indexOf(h.category), cats.length) };
      },
    },
    method: {
      label: 'วิธีจัดหา',
      of: r => {
        const methods = state.payload.meta.methods || [];
        return { key: r.purchase_method_name, label: r.purchase_method_name,
          color: categoryColor(methods.indexOf(r.purchase_method_name), methods.length) };
      },
    },
    type: {
      label: 'ประเภทโครงการ',
      of: r => {
        const types = state.payload.meta.project_types || [];
        return { key: r.project_type_name, label: r.project_type_name,
          color: categoryColor(types.indexOf(r.project_type_name), types.length) };
      },
    },
    value: {
      label: 'ช่วงมูลค่าสัญญา',
      of: r => {
        const v = r.contract_price_agree ?? 0;
        const bin = VALUE_BINS.find(b => v <= b.max) || VALUE_BINS[VALUE_BINS.length - 1];
        return { key: bin.label, label: bin.label, color: bin.color };
      },
      order: VALUE_BINS.map(b => b.label),
    },
  };

  function colorOf(r) {
    return (COLOR_MODES[state.map.colorBy] || COLOR_MODES.band).of(r);
  }

  /** รัศมีหมุดจากมูลค่าสัญญา ใช้ log เพราะมูลค่ากระจายกว้างมาก
   *  (ต่ำสุดหลักหมื่น สูงสุดหลักพันล้าน) */
  function radiusOf(r) {
    if (!state.map.sizeByValue) return 6;
    const v = Math.max(1, r.contract_price_agree || 1);
    return Math.max(4, Math.min(20, 3 + Math.log10(v) * 1.9));
  }

  function initMap() {
    if (map) return;

    map = L.map('map', {
      scrollWheelZoom: true,
      zoomControl: false,
      preferCanvas: true,          // วาดหมุดจำนวนมากได้ลื่นกว่า SVG
      worldCopyJump: true,
    }).setView(THAILAND_VIEW.center, THAILAND_VIEW.zoom);

    L.control.zoom({ position: 'topright' }).addTo(map);
    L.control.scale({ imperial: false, position: 'bottomleft' }).addTo(map);

    setBasemap(state.map.basemap);

    clusterLayer = L.markerClusterGroup({
      chunkedLoading: true,
      maxClusterRadius: 55,
      spiderfyOnMaxZoom: true,
      showCoverageOnHover: false,
      // ไอคอนกลุ่มเป็นวงแหวนสัดส่วน แสดงองค์ประกอบของกลุ่มตามมิติที่เลือกอยู่
      // ทำให้เห็นได้ทันทีว่ากระจุกนี้ประกอบด้วยอะไรบ้าง ไม่ใช่แค่จำนวน
      iconCreateFunction: cluster => {
        const markers = cluster.getAllChildMarkers();
        const n = cluster.getChildCount();

        const parts = new Map();
        for (const m of markers) {
          const g = m.options.group;
          if (!g) continue;
          parts.set(g.color, (parts.get(g.color) || 0) + 1);
        }
        const ordered = [...parts.entries()].sort((a, b) => b[1] - a[1]);

        // conic-gradient ต้องระบุช่วงองศาต่อเนื่องกัน จึงสะสมมุมไปทีละส่วน
        let acc = 0;
        const stops = ordered.map(([color, count]) => {
          const from = acc / n * 360;
          acc += count;
          return `${color} ${from.toFixed(1)}deg ${(acc / n * 360).toFixed(1)}deg`;
        }).join(', ');

        // เต้นเฉพาะกระจุกที่สัดส่วนวิกฤตสูงกว่าค่าเฉลี่ยของชุดที่แสดงอยู่อย่างน้อยเท่าตัว
        // เกณฑ์ตายตัวใช้ไม่ได้ เพราะสัดส่วนวิกฤตเปลี่ยนตามตัวกรองและค่าที่ตั้งในกฎ
        // ถ้าใช้แค่ "มีวิกฤตอย่างน้อยหนึ่ง" เกือบทุกกระจุกจะเต้นจนไม่เหลือความหมาย
        const criticalCount = markers.filter(x =>
          Rules.band(x.options.riskScore || 0).key === 'critical').length;
        const share = criticalCount / n;
        const hot = criticalCount >= 3 && share >= state.map.criticalBaseline * 2;

        const size = n < 10 ? 36 : n < 100 ? 44 : n < 1000 ? 52 : 60;
        const label = n >= 1000 ? (n / 1000).toFixed(1) + 'k' : n;

        return L.divIcon({
          html: `<div class="cluster-donut ${hot ? 'is-critical' : ''}"
                      title="${n} สัญญา · ระดับวิกฤต ${criticalCount} (${(share * 100).toFixed(0)}%)${hot ? ' — สูงกว่าค่าเฉลี่ยของชุดนี้มาก' : ''}"
                      style="background:conic-gradient(${stops || '#94a3b8 0deg 360deg'})">
                   <span class="cluster-core">${label}</span>
                 </div>`,
          className: 'cluster-icon',
          iconSize: L.point(size, size),
        });
      },
    });
    map.addLayer(clusterLayer);

    wireMapControls();
    initTimelapseControls();
  }

  function setBasemap(key) {
    const cfg = BASEMAPS[key] || BASEMAPS.light;
    if (baseLayer) map.removeLayer(baseLayer);
    baseLayer = L.tileLayer(cfg.url, {
      attribution: cfg.attribution, maxZoom: cfg.maxZoom, subdomains: 'abcd',
    }).addTo(map);
    baseLayer.setZIndex(0);
    U.$('mapCard').classList.toggle('map-dark', !!cfg.dark);
  }

  function wireMapControls() {
    document.querySelectorAll('[data-mapmode]').forEach(btn => {
      btn.addEventListener('click', () => {
        document.querySelectorAll('[data-mapmode]').forEach(b => {
          b.classList.remove('active'); b.setAttribute('aria-pressed', 'false');
        });
        btn.classList.add('active'); btn.setAttribute('aria-pressed', 'true');
        state.map.mode = btn.dataset.mapmode;
        updateMapLayers(mapRowsForDisplay());
      });
    });

    U.$('mapColorBy').addEventListener('change', e => {
      state.map.colorBy = e.target.value;
      // คีย์ของกลุ่มที่ซ่อนไว้ผูกกับมิติเดิม พอเปลี่ยนมิติจึงไม่มีความหมายอีก
      state.map.hidden.clear();
      updateMapLayers(mapRowsForDisplay());
    });
    U.$('mapBasemap').addEventListener('change', e => {
      state.map.basemap = e.target.value;
      setBasemap(e.target.value);
    });
    U.$('mapSizeByValue').addEventListener('change', e => {
      state.map.sizeByValue = e.target.checked;
      updateMapLayers(mapRowsForDisplay());
    });

    U.$('mapResetView').addEventListener('click', () =>
      map.flyTo(THAILAND_VIEW.center, THAILAND_VIEW.zoom, { duration: 0.8 }));

    U.$('mapFitData').addEventListener('click', () => {
      const geo = mapRowsForDisplay().filter(r => r.lat !== null);
      if (!geo.length) return;
      map.flyToBounds(L.latLngBounds(geo.map(r => [r.lat, r.lon])),
        { padding: [30, 30], duration: 0.8, maxZoom: 14 });
    });

    // กรองชุดข้อมูลให้เหลือเฉพาะที่อยู่ในกรอบแผนที่ปัจจุบัน
    U.$('mapFilterToView').addEventListener('click', () => {
      // ยุติการเลื่อนหรือซูมที่ยังทำอยู่ก่อน เพื่อให้ได้กรอบที่ผู้ใช้เห็นจริง
      // ไม่ใช่กรอบระหว่างทางของ animation
      map.stop();
      const b = map.getBounds();
      state.filters.bounds = {
        north: b.getNorth(), south: b.getSouth(), east: b.getEast(), west: b.getWest(),
      };
      applyFilters();
    });

    U.$('mapFullscreen').addEventListener('click', toggleMapFullscreen);
    document.addEventListener('fullscreenchange', () => {
      const on = !!document.fullscreenElement;
      U.$('mapCard').classList.toggle('map-fullscreen', on);
      U.$('mapFullscreen').textContent = on ? '⤢' : '⛶';
      setTimeout(() => map.invalidateSize(), 180);
    });

    wireTimelapse();
  }

  /* ---------- แผนที่เล่นย้อนเวลา ---------- */

  /** รายชื่อเดือนที่มีอยู่จริง คำนวณครั้งเดียวจากทั้งชุดข้อมูล (ไม่ใช่ที่กรองแล้ว)
   *  เพื่อให้แถบเลื่อนมีช่วงคงที่ ไม่ขยับตามตัวกรองที่เปลี่ยนไปมา */
  function contractMonths() {
    const tl = state.map.timelapse;
    if (tl.months.length) return tl.months;
    const set = new Set();
    for (const r of state.records) {
      const m = U.monthKey(r.contract_date);
      if (m) set.add(m);
    }
    tl.months = [...set].sort();
    return tl.months;
  }

  /** ชุดระเบียนที่จะวาดบนแผนที่ ณ ขณะนี้ — ถ้าเลื่อนไปไม่ถึงเดือนสุดท้ายให้ตัดเฉพาะสัญญา
   *  ที่ทำก่อนหรือในเดือนนั้น (สะสมไปเรื่อยๆ) ถ้าอยู่ที่เดือนสุดท้ายพอดีคือทั้งหมด ไม่ต้องกรองซ้ำ */
  function mapRowsForDisplay() {
    const tl = state.map.timelapse;
    if (!tl.months.length || tl.monthIndex >= tl.months.length - 1) return state.filtered;
    const cutoff = tl.months[tl.monthIndex];
    return state.filtered.filter(r => {
      const m = U.monthKey(r.contract_date);
      return m !== null && m <= cutoff;
    });
  }

  function updateTimelapseLabel() {
    const tl = state.map.timelapse;
    const label = U.$('mapTimelapseLabel');
    if (!tl.months.length) { label.textContent = 'ไม่มีข้อมูลวันที่'; return; }
    const atEnd = tl.monthIndex >= tl.months.length - 1;
    label.textContent = atEnd
      ? `ทุกเดือน (${tl.months.length} เดือน)`
      : `ถึง ${U.thaiMonthLabel(tl.months[tl.monthIndex])} · ${tl.monthIndex + 1}/${tl.months.length}`;
  }

  function initTimelapseControls() {
    const months = contractMonths();
    const slider = U.$('mapTimelapseSlider');
    slider.max = String(Math.max(0, months.length - 1));
    slider.value = String(months.length - 1);   // เริ่มที่ "ทุกเดือน" เหมือนแผนที่ปกติ
    slider.disabled = months.length < 2;
    U.$('mapPlayTimelapse').disabled = months.length < 2;
    state.map.timelapse.monthIndex = months.length - 1;
    updateTimelapseLabel();
  }

  function pauseTimelapse() {
    const tl = state.map.timelapse;
    tl.playing = false;
    if (tl.timer) { clearInterval(tl.timer); tl.timer = null; }
    U.$('mapPlayIcon').textContent = '▶';
    U.$('mapPlayTimelapse').classList.remove('is-playing');
    U.$('mapPlayTimelapse').setAttribute('aria-label', 'เล่นไล่เวลาทีละเดือนบนแผนที่');
  }

  function playTimelapse() {
    const tl = state.map.timelapse;
    if (!tl.months.length) return;
    // เล่นจากต้นใหม่เสมอเมื่อกดตอนอยู่ที่ปลายทาง ให้เห็นเอฟเฟกต์ "ทยอยเกิดขึ้น" เต็มรอบ
    if (tl.monthIndex >= tl.months.length - 1) tl.monthIndex = 0;
    tl.playing = true;
    U.$('mapPlayIcon').textContent = '⏸';
    U.$('mapPlayTimelapse').classList.add('is-playing');
    U.$('mapPlayTimelapse').setAttribute('aria-label', 'หยุดการเล่นไล่เวลาบนแผนที่');
    tl.timer = setInterval(() => {
      tl.monthIndex++;
      if (tl.monthIndex >= tl.months.length) { tl.monthIndex = tl.months.length - 1; pauseTimelapse(); }
      U.$('mapTimelapseSlider').value = String(tl.monthIndex);
      updateTimelapseLabel();
      updateMapLayers(mapRowsForDisplay());
    }, 900);
  }

  function wireTimelapse() {
    U.$('mapPlayTimelapse').addEventListener('click', () => {
      if (state.map.timelapse.playing) pauseTimelapse();
      else playTimelapse();
    });
    U.$('mapTimelapseSlider').addEventListener('input', e => {
      pauseTimelapse();
      state.map.timelapse.monthIndex = Number(e.target.value);
      updateTimelapseLabel();
      updateMapLayers(mapRowsForDisplay());
    });
  }

  function toggleMapFullscreen() {
    const card = U.$('mapCard');
    if (document.fullscreenElement) document.exitFullscreen();
    else card.requestFullscreen?.().catch(err =>
      console.warn('เปิดเต็มจอไม่สำเร็จ', err));
  }

  function popupHTML(r, group) {
    const band = Rules.band(r.risk_score);
    const hits = (r.rule_hits || []).slice(0, 8);
    return `
      <div class="map-popup">
        <div class="pop-title">${U.esc(truncate(r.project_name, 120))}</div>
        <div class="pop-meta">${U.esc(truncate(r.dept_name, 60))}</div>
        <div class="pop-meta">${U.esc(truncate(r.winner_name, 60))}</div>
        <div class="pop-row">
          <span class="badge" style="background:${band.color}">${band.label} · ${U.num(r.risk_score)}</span>
          <strong class="metric">${U.baht(r.contract_price_agree)}</strong>
        </div>
        <div class="pop-meta">${U.esc(r.purchase_method_name)} · ${U.thaiDate(r.contract_date)}</div>
        ${group ? `<div class="pop-meta">กลุ่ม: <span class="pop-swatch" style="background:${group.color}"></span>${U.esc(group.label)}</div>` : ''}
        ${hits.length ? `<div class="pop-chips">${hits.map(h =>
          `<span class="rule-chip ${h.source === 'synthetic' ? 'chip-synthetic' : ''}" title="${U.esc(h.rule_name)}">${h.rule_id}</span>`).join('')}</div>` : ''}
        <button class="btn btn-sm btn-outline-primary w-100 mt-2 detail-clickable"
                data-type="project" data-id="${U.esc(r.project_id)}">ดูรายละเอียดเต็ม</button>
      </div>`;
  }

  function updateMapLayers(rows) {
    if (!map) return;
    const geo = rows.filter(r => r.lat !== null && r.lon !== null);

    clusterLayer.clearLayers();
    if (pointLayer) { map.removeLayer(pointLayer); pointLayer = null; }
    if (heatLayer) { map.removeLayer(heatLayer); heatLayer = null; }
    if (map.hasLayer(clusterLayer) && state.map.mode !== 'cluster') map.removeLayer(clusterLayer);

    const groups = new Map();   // สำหรับสร้างคำอธิบายสัญลักษณ์
    let plotted = 0;

    // ค่าฐานของสัดส่วนวิกฤต ใช้ตัดสินว่ากระจุกไหน "ร้อน" กว่าปกติ
    state.map.criticalBaseline = geo.length
      ? geo.filter(r => r.risk_band === 'critical').length / geo.length : 0;

    if (state.map.mode === 'heat') {
      const maxScore = Math.max(1, ...geo.map(r => r.risk_score));
      heatLayer = L.heatLayer(
        geo.map(r => [r.lat, r.lon, Math.max(0.12, r.risk_score / maxScore)]),
        { radius: 24, blur: 20, maxZoom: 12,
          gradient: { 0.2: '#0f766e', 0.45: '#ca8a04', 0.7: '#ea580c', 1: '#b91c1c' } }
      ).addTo(map);
      plotted = geo.length;
    } else {
      // เรียงตามคะแนนอยู่แล้ว การตัดที่ MAX_PINS จึงเก็บรายการสำคัญไว้ก่อน
      const subset = geo.slice(0, MAX_PINS);
      const markers = [];
      for (const r of subset) {
        const g = colorOf(r);
        if (!groups.has(g.key)) groups.set(g.key, { ...g, n: 0 });
        groups.get(g.key).n++;
        if (state.map.hidden.has(g.key)) continue;   // ถูกปิดจากคำอธิบายสัญลักษณ์

        const marker = L.circleMarker([r.lat, r.lon], {
          radius: radiusOf(r),
          color: '#ffffff', weight: 1.2,
          fillColor: g.color, fillOpacity: 0.85,
          riskScore: r.risk_score,
          group: g,
        });
        marker.bindPopup(() => popupHTML(r, g), { maxWidth: 300, className: 'map-popup-wrap' });
        marker.on('click', () => showRecord(r));
        markers.push(marker);
      }
      plotted = markers.length;

      if (state.map.mode === 'cluster') {
        if (!map.hasLayer(clusterLayer)) map.addLayer(clusterLayer);
        clusterLayer.addLayers(markers);
      } else {
        pointLayer = L.layerGroup(markers).addTo(map);
      }
    }

    renderMapLegend(groups);

    const pct = rows.length ? U.pct(geo.length / rows.length) : '-';
    // แยกเหตุผลที่จุดหายให้ชัด ระหว่างการซ่อนกลุ่มเองกับการตัดจำนวนตามเพดาน
    const hiddenCount = state.map.hidden.size
      ? [...groups.values()].filter(g => state.map.hidden.has(g.key)).reduce((s, g) => s + g.n, 0)
      : 0;
    const capped = geo.length - plotted - hiddenCount;

    const notes = [];
    if (hiddenCount > 0) notes.push(`ซ่อนไว้ ${U.num(hiddenCount)} จุด`);
    if (capped > 0) notes.push(`เกินเพดานการวาด ${U.num(capped)} จุด`);

    U.setHTML('mapStats', geo.length
      ? `<strong>${U.num(plotted)}</strong> จุดบนแผนที่` +
        (notes.length ? ` <span class="text-warning-emphasis">(${notes.join(' · ')})</span>` : '') +
        `<br><span class="small-muted">${U.num(rows.length)} สัญญาที่กรองอยู่ · ${pct} มีพิกัด</span>`
      : '<span class="small-muted">ไม่มีสัญญาที่มีพิกัดตามเงื่อนไขที่เลือก</span>');

    setTimeout(() => map.invalidateSize(), 60);
  }

  function renderMapLegend(groups) {
    const el = U.$('mapLegend');
    if (state.map.mode === 'heat') {
      el.innerHTML = `
        <div class="legend-title">ความหนาแน่นถ่วงด้วยคะแนนความเสี่ยง</div>
        <div class="legend-gradient"></div>
        <div class="legend-scale"><span>ต่ำ</span><span>สูง</span></div>`;
      return;
    }
    if (!groups.size) { el.innerHTML = ''; return; }

    const mode = COLOR_MODES[state.map.colorBy] || COLOR_MODES.band;
    let items = [...groups.values()];
    if (mode.order) {
      items.sort((a, b) => mode.order.indexOf(a.key) - mode.order.indexOf(b.key));
    } else {
      items.sort((a, b) => b.n - a.n);
    }
    const shown = items.slice(0, 8);
    const rest = items.length - shown.length;
    const anyHidden = state.map.hidden.size > 0;

    el.innerHTML = `
      <div class="legend-title">${U.esc(mode.label)}
        <span class="legend-hint">คลิกเพื่อซ่อน/แสดง</span></div>
      ${shown.map(g => {
        const off = state.map.hidden.has(g.key);
        return `<div class="legend-row legend-toggle ${off ? 'is-off' : ''}"
                     data-group="${U.esc(g.key)}" role="button" tabindex="0"
                     aria-pressed="${!off}" title="${U.esc(g.label)}">
          <span class="legend-dot" style="background:${g.color}"></span>
          <span class="legend-label">${U.esc(truncate(g.label, 28))}</span>
          <span class="legend-count">${U.num(g.n)}</span>
        </div>`;
      }).join('')}
      ${rest > 0 ? `<div class="legend-row legend-more">และอีก ${rest} กลุ่ม</div>` : ''}
      ${anyHidden ? `<button class="btn btn-sm btn-link p-0 legend-reset" id="legendShowAll" type="button">แสดงทุกกลุ่ม</button>` : ''}`;

    el.querySelectorAll('.legend-toggle').forEach(row => {
      const toggle = () => {
        const key = row.dataset.group;
        if (state.map.hidden.has(key)) state.map.hidden.delete(key);
        else state.map.hidden.add(key);
        updateMapLayers(mapRowsForDisplay());
      };
      row.addEventListener('click', toggle);
      row.addEventListener('keydown', e => {
        if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); toggle(); }
      });
    });
    U.$('legendShowAll')?.addEventListener('click', () => {
      state.map.hidden.clear();
      updateMapLayers(mapRowsForDisplay());
    });
  }

  /* =========================================================
     แท็บ Red Flags
     ========================================================= */

  const DIMENSIONS = [
    { key: 'ราคา', icon: '💰', label: 'ความผิดปกติด้านราคา' },
    { key: 'การแข่งขัน', icon: '⚖️', label: 'การจำกัดการแข่งขัน' },
    { key: 'โครงสร้างสัญญา', icon: '🧩', label: 'โครงสร้างสัญญา' },
    { key: 'ผู้รับจ้าง', icon: '🏢', label: 'ตัวตนผู้รับจ้าง' },
    { key: 'วิธีจัดหา', icon: '📋', label: 'วิธีจัดหา' },
    { key: 'ภูมิศาสตร์', icon: '📍', label: 'ภูมิศาสตร์' },
    { key: 'เอกสาร/ข้อมูล', icon: '📄', label: 'คุณภาพข้อมูล' },
  ];

  function renderFraud() {
    const rows = state.filtered;
    const s = state.summary;

    const flaggedValue = s.flaggedValue;
    const critical = rows.filter(r => r.risk_band === 'critical');
    U.setHTML('fraudKpis', [
      ['สัญญาที่มีสัญญาณ', U.num(s.flagged)],
      ['มูลค่าที่มีสัญญาณ', U.money(flaggedValue)],
      ['ระดับวิกฤต', U.num(critical.length)],
      ['กฎที่พบอย่างน้อย 1 ครั้ง', U.num([...s.counts.values()].filter(c => c.n > 0).length)],
    ].map(i => `<div class="col-6 col-lg-3"><div class="cardx kpi">
        <div class="small-muted">${i[0]}</div><div class="v">${i[1]}</div></div></div>`).join(''));

    // การ์ดมิติ ทำหน้าที่เป็นตัวกรองหมวดของกฎ
    U.setHTML('fraudDims', DIMENSIONS.map(dim => {
      const ruleIds = Rules.DEFS.filter(d => d.category === dim.key).map(d => d.id);
      const n = rows.filter(r => (r.rule_hits || []).some(h => ruleIds.includes(h.rule_id))).length;
      const active = state.filters.rule && ruleIds.includes(state.filters.rule);
      return `<div class="col-6 col-lg-3 col-xl-2">
        <div class="cardx dim-card p-3 ${active ? 'active' : ''}" data-dim="${U.esc(dim.key)}"
             role="button" tabindex="0" aria-pressed="${active}">
          <div class="dim-icon">${dim.icon}</div>
          <div class="small fw-semibold">${U.esc(dim.label)}</div>
          <div class="v">${U.num(n)}</div>
          <div class="small-muted">${ruleIds.join(', ')}</div>
        </div></div>`;
    }).join(''));

    U.$('fraudDims').querySelectorAll('.dim-card').forEach(card => {
      const activate = () => {
        const ids = Rules.DEFS.filter(d => d.category === card.dataset.dim).map(d => d.id);
        const next = ids.includes(state.filters.rule) ? '' : ids[0];
        U.$('gfRule').value = next;
        syncFiltersFromUI();
        applyFilters();
      };
      card.addEventListener('click', activate);
      card.addEventListener('keydown', e => {
        if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); activate(); }
      });
    });

    const bands = Rules.BANDS.filter(b => (s.bandCounts[b.key] || 0) > 0);
    Charts.donut('fraudSeverityDonut', bands.map(b => b.label),
      bands.map(b => s.bandCounts[b.key]), bands.map(b => b.color));

    const cats = new Map();
    for (const d of Rules.DEFS) {
      cats.set(d.category, (cats.get(d.category) || 0) + s.counts.get(d.id).n);
    }
    const catList = [...cats].filter(c => c[1] > 0).sort((a, b) => b[1] - a[1]);
    Charts.bar('fraudCategoryBar', catList.map(c => c[0]), catList.map(c => c[1]),
      { horizontal: true, color: Charts.C.red, axisTitle: 'จำนวนสัญญา' });

    const buckets = new Array(11).fill(0);
    for (const r of rows) buckets[Math.min(10, Math.floor(r.risk_score / 10))]++;
    Charts.bar('fraudHistogram', buckets.map((_, i) => i === 10 ? '100' : `${i * 10}-${i * 10 + 9}`),
      buckets, { color: Charts.C.orange, axisTitle: 'จำนวนสัญญา' });

    renderTinMismatch(rows);
    renderSplitContracts(rows);
    renderNoncompete(rows);
    renderRotation(rows);
    renderFraudCases(rows);
  }

  function renderTinMismatch(rows) {
    const list = Analytics.tinMismatch(rows).slice(0, 40);
    U.setHTML('tinMismatchBody', list.map(m => `
      <tr>
        <td data-sort="${U.esc(m.key)}">${m.kind === 'tin'
          ? U.esc(m.key)
          : clickable('contractor', m.key, truncate(m.key, 40))}
          <div class="small-muted">${m.kind === 'tin' ? 'เลขภาษี 1 → หลายชื่อ' : 'ชื่อ 1 → หลายเลขภาษี'}</div></td>
        <td class="small" data-sort="${m.names.length}">${m.names.map(n => U.esc(truncate(n, 46))).join('<br>')}</td>
        ${numTd(m.n_contracts)}
        ${moneyTd(m.total_value)}
      </tr>`).join('') || U.emptyRow(4, 'ไม่พบความไม่สอดคล้องของเลขภาษีกับชื่อ'));
  }

  function renderSplitContracts(rows) {
    const t = state.settings.R10.thresholds;
    const list = Analytics.splitClusters(rows, {
      maxEach: t.maxEach, minTotal: t.minTotal, minCount: t.minCount,
    }).slice(0, 40);
    U.setHTML('splitContractBody', list.map(c => `
      <tr>
        <td>${clickable('agency', c.dept_name, truncate(c.dept_name, 34))}</td>
        <td>${clickable('contractor', c.winner_name, truncate(c.winner_name, 34))}</td>
        ${dateTd(c.contract_date)}
        ${numTd(c.n)}
        ${moneyTd(c.total)}
      </tr>`).join('') || U.emptyRow(5, 'ไม่พบกลุ่มสัญญาที่เข้าเกณฑ์การแบ่งซื้อแบ่งจ้าง'));
  }

  function renderNoncompete(rows) {
    const list = Analytics.noncompete(rows, { minContracts: 5 }).slice(0, 40);
    U.setHTML('noncompeteBody', list.map(a => `
      <tr>
        <td>${clickable('agency', a.dept_name, truncate(a.dept_name, 44))}</td>
        ${numTd(a.n_contracts)}
        ${pctTd(a.pct_specific)}
        ${moneyTd(a.value_specific)}
      </tr>`).join('') || U.emptyRow(4, 'ไม่พบหน่วยงานที่มีสัญญาถึงเกณฑ์ขั้นต่ำ'));
  }

  function renderRotation(rows) {
    const list = Analytics.bidRotation(rows).slice(0, 40);
    U.setHTML('rotationBody', list.map(r => `
      <tr>
        <td data-sort="${U.esc(r.dept_name)}">${clickable('agency', r.dept_name, truncate(r.dept_name, 34))}</td>
        <td class="small" data-sort="${U.esc(r.top_winners[0] || '')}">${r.top_winners.map((w, i) =>
          `${U.esc(truncate(w, 36))} <span class="small-muted">(${r.counts[i]})</span>`).join('<br>')}</td>
        ${pctTd(r.alternation_ratio)}
        ${moneyTd(r.total_value)}
      </tr>`).join('') || U.emptyRow(4, 'ไม่พบรูปแบบการผลัดกันชนะ'));
  }

  function renderFraudCases(rows) {
    const cases = rows.filter(r => (r.rule_hits || []).length);
    const shown = cases.slice(0, 200);
    U.$('fraudCaseCount').textContent = cases.length > shown.length
      ? `แสดง ${U.num(shown.length)} จาก ${U.num(cases.length)}` : `${U.num(cases.length)} รายการ`;
    U.setHTML('fraudCaseBody', shown.map(r => `
      <tr>
        <td>${clickable('project', r.project_id, truncate(r.project_name, 56))}</td>
        <td>${clickable('agency', r.dept_key, truncate(r.dept_name, 30))}</td>
        <td>${clickable('contractor', r.winner_key, truncate(r.winner_name, 30))}</td>
        ${moneyTd(r.contract_price_agree)}
        ${numTd(r.risk_score)}
        <td data-sort="${r.risk_score}">${badgeFor(r.risk_score)}</td>
        <td class="small" data-sort="${(r.rule_hits || []).length}">${(r.rule_hits || []).map(h =>
          `<span class="rule-chip ${h.source === 'synthetic' ? 'chip-synthetic' : ''}">${h.rule_id}</span>`).join(' ')}</td>
      </tr>`).join('') || U.emptyRow(7, 'ไม่พบสัญญาที่มีสัญญาณความเสี่ยง'));
  }

  function badgeFor(score) {
    const b = Rules.band(score);
    return `<span class="badge ${b.cls}">${b.label}</span>`;
  }

  /* =========================================================
     แท็บความผิดปกติเชิงสถิติ
     ========================================================= */

  function renderAnomaly() {
    const rows = state.filtered;

    const cliff = Analytics.thresholdCliff(rows);
    U.$('anCliffNote').textContent = cliff.ratio
      ? `ช่วงใต้เพดาน ${U.money(cliff.ceiling)} มี ${U.num(cliff.belowCount)} สัญญา ` +
        `ขณะที่ช่วงเหนือเพดานมี ${U.num(cliff.aboveCount)} สัญญา คิดเป็น ${cliff.ratio.toFixed(1)} เท่า`
      : `ช่วงใต้เพดานมี ${U.num(cliff.belowCount)} สัญญา`;
    Charts.bar('anCliffChart',
      cliff.bins.map(b => U.money(b.lo)),
      cliff.bins.map(b => b.n), {
      colors: cliff.bins.map(b => b.hi === cliff.ceiling ? Charts.C.red
        : (b.lo < cliff.ceiling ? Charts.C.orange : Charts.C.teal)),
      axisTitle: 'จำนวนสัญญา',
    });

    const ratio = Analytics.priceRatioHistogram(rows);
    U.$('anRatioNote').textContent = ratio.counted
      ? `จาก ${U.num(ratio.counted)} สัญญาที่มีราคากลาง มี ${U.num(ratio.exact)} สัญญา ` +
        `(${U.pct(ratio.exact / ratio.counted)}) ที่ราคาเท่ากับราคากลางพอดี`
      : 'ไม่มีสัญญาที่มีราคากลางในชุดที่เลือก';
    Charts.bar('anRatioChart',
      ratio.buckets.map(b => b.lo.toFixed(2)),
      ratio.buckets.map(b => b.n), {
      colors: ratio.buckets.map(b => (b.lo <= 1 && b.hi > 1) ? Charts.C.red : Charts.C.teal),
      axisTitle: 'จำนวนสัญญา',
    });

    const b = Analytics.benford(rows.map(r => r.contract_price_agree));
    U.$('anBenfordNote').textContent = b.n
      ? `จาก ${U.num(b.n)} สัญญา · chi-square = ${b.chi2} ` +
        (b.deviates ? '(เบี่ยงเบนอย่างมีนัยสำคัญที่ระดับ 0.05)' : '(ไม่เบี่ยงเบนอย่างมีนัยสำคัญ)')
      : 'ไม่มีข้อมูลเพียงพอ';
    Charts.draw('anBenfordChart', [
      { type: 'bar', name: 'ที่พบจริง', x: [1, 2, 3, 4, 5, 6, 7, 8, 9], y: b.observedPct.map(v => v * 100), marker: { color: Charts.C.teal } },
      { type: 'scatter', mode: 'lines+markers', name: 'ตามกฎเบนฟอร์ด', x: [1, 2, 3, 4, 5, 6, 7, 8, 9], y: b.expectedPct.map(v => v * 100), line: { color: Charts.C.red, width: 2 } },
    ], {
      xaxis: { title: 'เลขหลักแรก', dtick: 1 }, yaxis: { title: 'สัดส่วน (%)' },
      margin: { t: 16, l: 55, r: 16, b: 45 }, legend: { orientation: 'h', y: -0.2 },
    });

    const byAgency = Analytics.benfordByAgency(rows).slice(0, 25);
    U.setHTML('anBenfordBody', byAgency.map(a => `
      <tr>
        <td>${clickable('agency', a.dept_name, truncate(a.dept_name, 46))}</td>
        ${numTd(a.n)}
        <td class="text-end" data-sort="${a.chi2}">${a.chi2.toFixed(1)}</td>
        <td data-sort="${a.deviates ? 1 : 0}">${a.deviates ? '<span class="badge badge-high">เบี่ยงเบน</span>'
          : '<span class="badge badge-none">ปกติ</span>'}</td>
      </tr>`).join('') || U.emptyRow(4, 'ไม่มีหน่วยงานที่มีสัญญาถึง 30 ฉบับ'));

    const outliers = Analytics.priceOutliers(rows).slice(0, 40);
    U.setHTML('anOutlierBody', outliers.map(o => `
      <tr>
        <td>${clickable('project', o.record.project_id, truncate(o.record.project_name, 50))}</td>
        <td class="small-muted">${U.esc(truncate(o.peer_group, 40))}</td>
        ${moneyTd(o.value)}
        <td class="text-end" ${sortAttr(o.times_median)}>${o.times_median ? o.times_median.toFixed(1) + '×' : '-'}</td>
      </tr>`).join('') || U.emptyRow(4, 'ไม่พบราคาที่ผิดปกติเทียบกลุ่มเปรียบเทียบ'));

    const dur = Analytics.durationOutliers(rows);
    U.$('anDurationNote').textContent =
      `มัธยฐานระยะเวลาสัญญา ${U.num(Math.round(dur.median))} วัน · ` +
      `พบระยะเวลาติดลบ ${U.num(dur.negative.length)} รายการ`;
    const durRows = [
      ...dur.negative.map(r => ({ r, kind: 'ติดลบ', cls: 'badge-critical' })),
      ...dur.long.slice(0, 25).map(r => ({ r, kind: 'ยาวผิดปกติ', cls: 'badge-medium' })),
    ];
    U.setHTML('anDurationBody', durRows.map(x => `
      <tr>
        <td>${clickable('project', x.r.project_id, truncate(x.r.project_name, 42))}</td>
        <td class="text-end" data-sort="${x.r.duration_days}">${U.num(x.r.duration_days)} วัน</td>
        <td data-sort="${x.kind}"><span class="badge ${x.cls}">${x.kind}</span></td>
      </tr>`).join('') || U.emptyRow(3, 'ไม่พบระยะเวลาสัญญาที่ผิดปกติ'));
  }

  /* =========================================================
     แท็บเครือข่าย
     ========================================================= */

  /** ตัวกรองเฉพาะแท็บเครือข่าย ทำงานต่อจากตัวกรองส่วนกลาง */
  function netFilteredEdges(allEdges) {
    const n = state.net;
    return allEdges.filter(e => {
      if (n.agency && e.source !== n.agency) return false;
      if (n.contractor && e.target !== n.contractor) return false;
      if (n.rule && !e.rules.has(n.rule)) return false;
      if (n.band && Rules.band(e.max_risk).key !== n.band) return false;
      if (n.flaggedOnly && !e.flagged) return false;
      if (n.maskedOut && e.masked) return false;
      if (e.n < n.minContracts) return false;
      if (e.value < n.minValue * 1e6) return false;
      return true;
    });
  }

  /* คำอธิบายวิธีอ่านแผนภาพ เปลี่ยนตามรูปแบบและมิติสีที่เลือกอยู่
     แยกเป็นค่าคงที่เพื่อให้ข้อความอยู่ที่เดียว ไม่ปนกับ logic การวาด */
  const NET_VIEW_HINTS = {
    sankey: 'อ่านจากซ้ายไปขวา คอลัมน์ซ้ายคือหน่วยงาน คอลัมน์ขวาคือผู้รับจ้าง ' +
      'เส้นยิ่งหนาแปลว่ามูลค่าที่ไหลจากหน่วยงานนั้นไปยังผู้รับจ้างรายนั้นยิ่งสูง',
    bubble: 'หนึ่งจุดคือหนึ่งคู่ แกนนอนคือจำนวนสัญญาที่ทำร่วมกัน แกนตั้งคือมูลค่ารวม ' +
      'จุดที่อยู่มุมขวาบนคือคู่ที่ทำสัญญากันทั้งบ่อยครั้งและมูลค่าสูง',
    treemap: 'พื้นที่ของกล่องคือมูลค่ารวม กล่องใหญ่คือหน่วยงาน กล่องย่อยข้างในคือผู้รับจ้างแต่ละราย ' +
      'ใช้ดูว่างบของหน่วยงานหนึ่งกระจายหรือกระจุกอยู่กับใคร',
    matrix: 'แถวคือหน่วยงาน คอลัมน์คือผู้รับจ้าง ช่องยิ่งเข้มแปลว่ามูลค่ารวมยิ่งสูง ' +
      'คอลัมน์ที่มีช่องเข้มหลายแถวคือผู้รับจ้างที่ได้งานจากหลายหน่วยงาน',
  };
  const NET_COLOR_HINTS = {
    entity: 'สีตอนนี้แยกตามประเภท เขียวคือหน่วยงาน ส้มคือผู้รับจ้าง',
    risk: 'สีตอนนี้มาจากคะแนนของสัญญาที่เสี่ยงที่สุดในคู่นั้น ไล่จากแดง (วิกฤต) ถึงเทา (ไม่พบสัญญาณ)',
    community: 'สีตอนนี้แยกตามกลุ่มในเครือข่าย โหนดสีเดียวกันคือกลุ่มที่ทำสัญญากันเองหนาแน่น',
    composite: 'สีตอนนี้มาจากคะแนนเครือข่ายรวม 0-100 ของโหนดนั้น ยิ่งแดงยิ่งมีบทบาทมากในเครือข่าย',
  };

  function renderNetViewHint() {
    U.setHTML('netViewHint',
      `<span class="net-hint-row"><span class="net-hint-tag">วิธีอ่าน</span>` +
      `${NET_VIEW_HINTS[state.net.view] || ''}</span>` +
      `<span class="net-hint-row"><span class="net-hint-tag">ความหมายของสี</span>` +
      `${NET_COLOR_HINTS[state.net.colorBy] || ''}</span>`);
  }

  function renderNetwork() {
    const rows = state.filtered;
    const allEdges = Analytics.networkEdges(rows);
    const matching = netFilteredEdges(allEdges);
    const edges = matching.slice(0, state.net.topN);

    populateNetSelects(allEdges);
    renderNetSummary(allEdges, matching, edges);
    renderNetViewHint();
    state.net._edges = edges;   // netNodeColor โหมด "ระดับเสี่ยงของคู่" ต้องใช้

    if (state.net.view === 'sankey') {
      Charts.sankey('networkChart', edges, { nodeColorFn: netNodeColor });
    } else if (state.net.view === 'bubble') {
      Charts.scatter('networkChart', edges.map(e => ({
        x: e.n, y: e.value,
        size: Math.max(8, Math.min(40, Math.sqrt(e.value) / 700)),
        color: e.max_risk,
        label: `${U.esc(e.source)}<br>${U.esc(e.target)}<br>${U.money(e.value)} บาท · ${e.n} สัญญา` +
          `<br>คะแนนสูงสุด ${U.num(e.max_risk)}`,
      })), { xTitle: 'จำนวนสัญญา', yTitle: 'มูลค่ารวม (บาท)', colorTitle: 'คะแนน' });
    } else if (state.net.view === 'matrix') {
      renderNetMatrix(edges);
    } else {
      Charts.treemap('networkChart', edges);
    }

    U.setHTML('netTableBody', matching.slice(0, 50).map(e => `
      <tr>
        <td>${clickable('agency', e.source, truncate(e.source, 40))}</td>
        <td>${clickable('contractor', e.target, truncate(e.target, 40))}</td>
        ${moneyTd(e.value)}
        ${numTd(e.n)}
      </tr>`).join('') || U.emptyRow(4));

    const screen = Analytics.screening(rows, { minContracts: 5 }).slice(0, 30);
    U.setHTML('screenTableBody', screen.map(s => {
      const level = s.top_winner_share > 0.7 ? ['สูง', 'badge-critical']
        : s.top_winner_share > 0.45 ? ['ปานกลาง', 'badge-medium'] : ['ต่ำ', 'badge-none'];
      return `<tr>
        <td>${clickable('agency', s.dept_name, truncate(s.dept_name, 40))}</td>
        ${numTd(s.n_contracts)}
        <td class="text-end" ${sortAttr(s.cv_price)}>${s.cv_price === null ? '-' : s.cv_price.toFixed(2)}</td>
        ${pctTd(s.top_winner_share)}
        <td data-sort="${s.top_winner_share}"><span class="badge ${level[1]}">${level[0]}</span></td>
      </tr>`;
    }).join('') || U.emptyRow(5, 'ไม่มีหน่วยงานที่มีสัญญาถึง 5 ฉบับ'));

    // ผูกคะแนนเครือข่ายจาก ETL เข้ากับผู้เล่นที่เหลืออยู่หลังตัวกรองทั้งสองชั้น
    const present = new Set();
    for (const e of matching) { present.add('A::' + e.source); present.add('C::' + e.target); }
    const composite = (state.payload.network_nodes || [])
      .filter(n => present.has(n.id)).slice(0, 25);
    U.setHTML('compositeRisk', composite.map((n, i) => `
      <div class="item" data-type="${n.type}" data-name="${U.esc(n.name)}">
        <div class="d-flex justify-content-between gap-2">
          <span class="small"><span class="rank-badge">${i + 1}</span> ${U.esc(truncate(n.name, 40))}</span>
          <span class="badge ${Rules.band(n.composite_risk_norm).cls}">${n.composite_risk_norm.toFixed(1)}</span>
        </div>
        <div class="small-muted">${n.type === 'agency' ? 'หน่วยงาน' : 'ผู้รับจ้าง'} ·
          เชื่อมกับ ${n.degree} ราย · อยู่กลุ่มที่ ${n.community}</div>
      </div>`).join('') || U.emptyState('ไม่มีข้อมูลเครือข่าย'));
    wireDrill('compositeRisk');

    const hhi = Analytics.hhi(rows, { minContracts: 5 }).slice(0, 18);
    Charts.bar('hhiChart', hhi.map(h => truncate(h.dept_name, 34)), hhi.map(h => h.hhi), {
      horizontal: true, axisTitle: 'HHI',
      colors: hhi.map(h => h.hhi > 2500 ? Charts.C.red : h.hhi > 1500 ? Charts.C.orange : Charts.C.teal),
    });

    const repeat = Analytics.repeatWinners(rows).slice(0, 20);
    U.setHTML('repeatWinners', repeat.map(r => `
      <div class="item" data-type="contractor" data-name="${U.esc(r.winner_name)}">
        <div class="d-flex justify-content-between gap-2">
          <span class="small">${U.esc(truncate(r.winner_name, 40))}</span>
          <span class="badge badge-medium">${r.n_agencies} หน่วยงาน</span>
        </div>
        <div class="small-muted">${r.n_contracts} สัญญา · ${U.money(r.total_value)} บาท</div>
      </div>`).join('') || U.emptyState('ไม่พบผู้รับจ้างที่ได้งานหลายหน่วยงาน'));
    wireDrill('repeatWinners');

    const topC = Analytics.contractorTotals(rows).slice(0, 20);
    U.setHTML('topContractors', topC.map(c => `
      <div class="item" data-type="contractor" data-name="${U.esc(c.winner_name)}">
        <div class="d-flex justify-content-between gap-2">
          <span class="small">${U.esc(truncate(c.winner_name, 40))}</span>
          <span class="metric small">${U.money(c.total_value)}</span>
        </div>
        <div class="small-muted">${c.n_contracts} สัญญา · เข้าเงื่อนไข ${c.n_flagged}</div>
      </div>`).join('') || U.emptyState('ไม่มีข้อมูล'));
    wireDrill('topContractors');
  }

  function netNodeColor(name, type) {
    const mode = state.net.colorBy;
    if (mode === 'entity') return type === 'agency' ? Charts.C.teal : Charts.C.orange;

    // ระดับเสี่ยงของคู่: ใช้คะแนนสูงสุดของเส้นเชื่อมที่แตะโหนดนี้
    if (mode === 'risk') {
      const worst = (state.net._edges || [])
        .filter(e => (type === 'agency' ? e.source : e.target) === name)
        .reduce((m, e) => Math.max(m, e.max_risk), 0);
      return Rules.band(worst).color;
    }

    const node = state.nodeIndex.get((type === 'agency' ? 'A::' : 'C::') + name);
    if (!node) return Charts.C.grey;
    if (mode === 'community') {
      return Charts.CATEGORICAL[node.community % Charts.CATEGORICAL.length];
    }
    return Rules.band(node.composite_risk_norm).color;
  }

  /* ---------- ตัวกรองเครือข่าย ---------- */

  /** เติมรายการในกล่องเลือก โดยอิงจากเส้นเชื่อมที่มีอยู่จริงหลังตัวกรองส่วนกลาง
   *  ทำให้ไม่มีตัวเลือกที่เลือกแล้วได้ผลลัพธ์ว่าง */
  function populateNetSelects(allEdges) {
    const keep = (id, value) => { if (value) U.$(id).value = value; };

    const agencies = [...new Set(allEdges.map(e => e.source))].sort((a, b) => a.localeCompare(b, 'th'));
    const contractors = [...new Set(allEdges.map(e => e.target))].sort((a, b) => a.localeCompare(b, 'th'));

    // เติมใหม่เฉพาะเมื่อชุดตัวเลือกเปลี่ยน เพราะรายการมีหลายพันรายการ
    const sig = agencies.length + '/' + contractors.length;
    if (state.net._selectSig !== sig) {
      state.net._selectSig = sig;
      U.setHTML('netAgency', '<option value="">ทุกหน่วยงาน</option>' +
        agencies.map(a => `<option value="${U.esc(a)}">${U.esc(truncate(a, 60))}</option>`).join(''));
      U.setHTML('netContractor', '<option value="">ทุกผู้รับจ้าง</option>' +
        contractors.map(c => `<option value="${U.esc(c)}">${U.esc(truncate(c, 60))}</option>`).join(''));
      keep('netAgency', state.net.agency);
      keep('netContractor', state.net.contractor);
    }

    if (!U.$('netRule').options.length) {
      U.setHTML('netRule', '<option value="">ทุกกฎ</option>' +
        Rules.DEFS.map(d => `<option value="${d.id}">${d.id} · ${U.esc(d.name)}</option>`).join(''));
      U.setHTML('netBand', '<option value="">ทุกระดับ</option>' +
        Rules.BANDS.map(b => `<option value="${b.key}">${U.esc(b.label)}</option>`).join(''));
    }
  }

  function renderNetSummary(allEdges, matching, shown) {
    const n = state.net;
    const parts = [];
    if (n.agency) parts.push('หน่วยงาน: ' + truncate(n.agency, 34));
    if (n.contractor) parts.push('ผู้รับจ้าง: ' + truncate(n.contractor, 34));
    if (n.rule) parts.push('กฎ ' + n.rule);
    if (n.band) parts.push('ระดับ ' + (Rules.BANDS.find(b => b.key === n.band)?.label || n.band));
    if (n.minContracts > 1) parts.push(`สัญญาต่อคู่ ≥ ${n.minContracts}`);
    if (n.minValue > 0) parts.push(`มูลค่า ≥ ${n.minValue} ลบ.`);
    if (n.flaggedOnly) parts.push('เฉพาะคู่ที่พบสัญญาณ');
    if (n.maskedOut) parts.push('ตัดเลขภาษีที่ถูกปิดบัง');

    const nodes = new Set(matching.flatMap(e => ['A::' + e.source, 'C::' + e.target]));
    const value = U.sum(matching.map(e => e.value));

    U.setHTML('netSummary',
      `<strong>${U.num(matching.length)}</strong> คู่ จาก ${U.num(allEdges.length)} คู่ · ` +
      `${U.num(nodes.size)} โหนด · มูลค่ารวม ${U.money(value)} บาท` +
      (matching.length > shown.length
        ? ` · <span class="text-warning-emphasis">วาดเฉพาะ ${U.num(shown.length)} คู่แรกตามมูลค่า</span>` : '') +
      (parts.length ? '<br>' + parts.map(p => `<span class="chip">${U.esc(p)}</span>`).join(' ') : ''));
  }

  /** ตารางความร้อน หน่วยงาน x ผู้รับจ้าง — เห็นความเข้มข้นของความสัมพันธ์เป็นภาพเดียว */
  function renderNetMatrix(edges) {
    if (!edges.length) { Charts.draw('networkChart', [], {}, 'ไม่มีคู่ตามเงื่อนไขที่เลือก'); return; }

    // จำกัดขนาดตารางให้อ่านออก โดยเลือกผู้เล่นที่มีมูลค่ารวมสูงสุด
    const topBy = (keyFn, limit) => {
      const totals = new Map();
      for (const e of edges) totals.set(keyFn(e), (totals.get(keyFn(e)) || 0) + e.value);
      return [...totals.entries()].sort((a, b) => b[1] - a[1]).slice(0, limit).map(x => x[0]);
    };
    const agencies = topBy(e => e.source, 18);
    const contractors = topBy(e => e.target, 26);
    const ai = new Map(agencies.map((a, i) => [a, i]));
    const ci = new Map(contractors.map((c, i) => [c, i]));

    const z = agencies.map(() => new Array(contractors.length).fill(null));
    const text = agencies.map(() => new Array(contractors.length).fill(''));
    for (const e of edges) {
      const r = ai.get(e.source), c = ci.get(e.target);
      if (r === undefined || c === undefined) continue;
      z[r][c] = e.value;
      text[r][c] = `${e.source}<br>${e.target}<br>${U.money(e.value)} บาท · ${e.n} สัญญา<br>คะแนนสูงสุด ${U.num(e.max_risk)}`;
    }

    Charts.draw('networkChart', [{
      type: 'heatmap',
      z, text,
      x: contractors.map(c => truncate(c, 24)),
      y: agencies.map(a => truncate(a, 24)),
      colorscale: [[0, '#e6f5f3'], [0.25, '#7dd3c8'], [0.5, '#ca8a04'], [0.75, '#ea580c'], [1, '#b91c1c']],
      hoverongaps: false,
      hovertemplate: '%{text}<extra></extra>',
      colorbar: { title: { text: 'มูลค่า', font: { size: 10 } }, thickness: 12 },
    }], {
      margin: { t: 10, l: 175, r: 20, b: 155 },
      xaxis: { tickangle: -45, tickfont: { size: 9 }, automargin: true },
      yaxis: { tickfont: { size: 9 }, automargin: true },
    });
  }

  function wireDrill(containerId) {
    U.$(containerId)?.querySelectorAll('.item[data-name]').forEach(el => {
      el.addEventListener('click', () => openDetail(el.dataset.type, el.dataset.name));
    });
  }

  /* =========================================================
     แท็บผู้รับจ้าง
     ========================================================= */

  function profiles() {
    if (!state.profiles) {
      state.profiles = Analytics.contractorProfiles(state.filtered, state.nodeIndex);
    }
    return state.profiles;
  }

  function renderContractor() {
    const all = profiles();
    const c = state.contractor;
    const list = all.filter(p =>
      p.n_contracts >= c.contractMin &&
      p.risk.final >= c.riskMin &&
      (!c.q || p.winner_name.toLowerCase().includes(c.q)));

    U.setHTML('contractorKpis', [
      ['ผู้รับจ้างทั้งหมด', U.num(all.length)],
      ['คะแนน ≥ 40', U.num(all.filter(p => p.risk.final >= 40).length)],
      ['ได้งาน ≥ 3 หน่วยงาน', U.num(all.filter(p => p.n_agencies >= 3).length)],
      ['มูลค่ารวมสูงสุด', U.money(Math.max(0, ...all.map(p => p.total_value)))],
    ].map(i => `<div class="col-6 col-lg-3"><div class="cardx kpi">
        <div class="small-muted">${i[0]}</div><div class="v">${i[1]}</div></div></div>`).join(''));

    const shown = list.slice(0, 200);
    U.$('contractorCount').textContent = list.length > shown.length
      ? `แสดง ${U.num(shown.length)} จาก ${U.num(list.length)}` : `${U.num(list.length)} ราย`;

    U.setHTML('contractorRankList', shown.map((p, i) => `
      <div class="item" data-idx="${i}">
        <div class="d-flex justify-content-between gap-2">
          <span class="small"><span class="rank-badge">${i + 1}</span> ${U.esc(truncate(p.winner_name, 38))}</span>
          <span class="badge ${Rules.band(p.risk.final).cls}">${p.risk.final.toFixed(0)}</span>
        </div>
        <div class="small-muted">${p.n_contracts} สัญญา · ${p.n_agencies} หน่วยงาน · ${U.money(p.total_value)}</div>
        ${riskBar(p.risk)}
      </div>`).join('') || U.emptyState('ไม่พบผู้รับจ้างตามเงื่อนไข'));

    U.$('contractorRankList').querySelectorAll('.item').forEach(el => {
      el.addEventListener('click', () => {
        U.$('contractorRankList').querySelectorAll('.item').forEach(x => x.classList.remove('active'));
        el.classList.add('active');
        showContractor(shown[Number(el.dataset.idx)]);
      });
    });

    showContractor(state.contractor.selected || shown[0] || null);
  }

  /** แถบ 5 ส่วนที่ความกว้างสะท้อนน้ำหนักจริง ไม่ใช่แบ่งเท่ากันเหมือนของเดิม */
  function riskBar(risk) {
    const W = Analytics.RISK_WEIGHTS;
    const segs = [
      ['network', W.network, Charts.C.indigo], ['price', W.price, Charts.C.orange],
      ['competition', W.competition, Charts.C.red], ['contract', W.contract, Charts.C.yellow],
      ['concentration', W.concentration, Charts.C.teal],
    ];
    return `<div class="riskbar-wrap">${segs.map(([k, w, color]) =>
      `<div class="riskbar-seg" style="width:${(risk[k] / 100) * w * 100}%;background:${color}"
            title="${k}: ${risk[k].toFixed(1)} (น้ำหนัก ${(w * 100).toFixed(0)}%)"></div>`).join('')}</div>`;
  }

  function showContractor(p) {
    state.contractor.selected = p;
    if (!p) {
      U.setHTML('contractorProfile', U.emptyState('เลือกผู้รับจ้างจากรายการด้านซ้าย'));
      U.setHTML('contractorPairBody', U.emptyRow(4));
      U.setHTML('contractorCaseBody', U.emptyRow(3));
      Charts.draw('contractorRiskChart', [], {}, 'ยังไม่ได้เลือกผู้รับจ้าง');
      return;
    }

    const metric = (label, value) =>
      `<div class="col-6 col-xl-4"><div class="profile-metric">
        <div class="label">${label}</div><div class="value">${value}</div></div></div>`;

    U.setHTML('contractorProfile', `
      <div class="mb-2 d-flex justify-content-between align-items-start gap-2">
        <strong>${U.esc(p.winner_name)}</strong>
        <button class="btn btn-sm btn-outline-primary flex-shrink-0 detail-clickable"
                data-type="contractor" data-id="${U.esc(p.winner_name)}">ดูแบบเต็ม</button>
      </div>
      <div class="small-muted mb-2">เลขผู้เสียภาษี ${U.esc(p.winner_tin)}
        ${p.tin_is_masked ? '<span class="badge badge-none">ถูกปิดบัง</span>' : ''}</div>
      <div class="row g-2">
        ${metric('คะแนนรวม', p.risk.final.toFixed(1))}
        ${metric('จำนวนสัญญา', U.num(p.n_contracts))}
        ${metric('หน่วยงาน', U.num(p.n_agencies))}
        ${metric('มูลค่ารวม', U.money(p.total_value))}
        ${metric('คะแนนสัญญาสูงสุด', U.num(p.max_risk))}
        ${metric('สัญญาที่มีสัญญาณ', U.num(p.n_flagged))}
      </div>`);

    Charts.radar('contractorRiskChart',
      ['เครือข่าย', 'ราคา', 'การแข่งขัน', 'สัญญา', 'การกระจุกตัว'],
      [p.risk.network, p.risk.price, p.risk.competition, p.risk.contract, p.risk.concentration]);

    U.setHTML('contractorPairBody', p.pairs.slice(0, 20).map(pair => `
      <tr>
        <td>${clickable('agency', pair.source, truncate(pair.source, 36))}</td>
        ${moneyTd(pair.value)}
        ${numTd(pair.n)}
        ${pctTd(p.total_value ? pair.value / p.total_value : 0)}
      </tr>`).join('') || U.emptyRow(4));

    const cases = [...p.rows].sort((a, b) => b.risk_score - a.risk_score).slice(0, 20);
    U.setHTML('contractorCaseBody', cases.map(r => `
      <tr>
        <td>${clickable('project', r.project_id, truncate(r.project_name, 46))}</td>
        ${moneyTd(r.contract_price_agree)}
        <td class="text-end" data-sort="${r.risk_score}">${scoreBadge(r.risk_score)}</td>
      </tr>`).join('') || U.emptyRow(3));
  }

  /* =========================================================
     แท็บแนวโน้มเวลา
     ========================================================= */

  function renderTimeseries() {
    const rows = state.filtered;
    const ts = Analytics.timeseries(rows, state.ts.dimension);
    const metric = state.ts.metric;

    U.$('tsNote').textContent = ts.months.length
      ? `ครอบคลุม ${ts.months.length} เดือน ตั้งแต่ ${U.thaiMonthLabel(ts.months[0])} ` +
        `ถึง ${U.thaiMonthLabel(ts.months[ts.months.length - 1])}`
      : 'ไม่มีข้อมูลวันทำสัญญาในชุดที่เลือก';

    Charts.lines('timeChart', ts.months.map(U.thaiMonthLabel),
      ts.series.slice(0, 10).map(s => ({
        name: state.ts.dimension === 'risk_band' ? bandLabel(s.name) : truncate(s.name, 34),
        y: s[metric],
      })),
      { yTitle: metric === 'counts' ? 'จำนวนสัญญา' : 'มูลค่า (บาท)' });

    const byMonth = U.groupBy(rows, r => U.monthKey(r.contract_date));
    const monthRows = [...byMonth.entries()].sort((a, b) => a[0].localeCompare(b[0]));
    const maxCount = Math.max(1, ...monthRows.map(m => m[1].length));
    U.setHTML('tsMonthBody', monthRows.map(([month, list]) => {
      const flagged = list.filter(r => (r.rule_hits || []).length).length;
      const isPeak = list.length >= maxCount * 0.95;
      const avg = U.mean(list.map(r => r.risk_score));
      return `<tr class="${isPeak ? 'row-peak' : ''}">
        <td data-sort="${month}">${U.thaiMonthLabel(month)}${isPeak ? ' <span class="badge badge-medium">สูงสุด</span>' : ''}</td>
        ${numTd(list.length)}
        ${moneyTd(U.sum(list.map(r => r.contract_price_agree)))}
        ${numTd(flagged)}
        <td class="text-end" data-sort="${avg}">${avg.toFixed(1)}</td>
      </tr>`;
    }).join('') || U.emptyRow(5));
  }

  /* =========================================================
     แท็บกฎและการตั้งค่า
     ========================================================= */

  /** ตารางอ้างอิงกฎทั้ง 17 ข้อ — ชื่อ คำอธิบาย ที่มา การคำนวณ และจำนวนที่พบ */
  /** "เจอสัญญาณแล้วทำอะไรต่อ" — เอกสารที่ควรขอ และคำถามที่ควรหาคำตอบ
   *  ใช้ทั้งในตารางกฎและในแผงรายละเอียดสัญญา */
  function auditStepsHTML(ruleId) {
    const a = Learn.auditSteps(ruleId);
    if (!a) return '<span class="small-muted">-</span>';
    return `
      <div class="audit-next${a.demo ? ' audit-next-demo' : ''}">
        <div class="audit-next-label">เอกสารที่ควรขอ</div>
        <ul class="audit-list">${a.docs.map(d => `<li>${U.esc(d)}</li>`).join('')}</ul>
        <div class="audit-next-label">จุดที่ควรตรวจ</div>
        <ul class="audit-list">${a.checks.map(c => `<li>${U.esc(c)}</li>`).join('')}</ul>
      </div>`;
  }

  function renderRuleTable() {
    const s = state.summary;
    U.setHTML('ruleTableBody', Rules.DEFS.map(def => {
      const cfg = state.settings[def.id];
      const doc = Rules.DOCS[def.id] || {};
      const stat = s.counts.get(def.id);
      const band = Rules.BANDS.find(b => b.key === def.severity);
      const isDemo = def.source === 'synthetic';
      return `
        <tr class="${cfg.enabled ? '' : 'rule-off'}">
          <td data-sort="${def.id}" style="min-width:170px">
            <div class="fw-semibold">${def.id} · ${U.esc(def.name)}</div>
            <div class="mt-1">
              <span class="badge ${band?.cls || 'badge-medium'}">${band?.label || def.severity}</span>
              <span class="badge badge-none">น้ำหนัก ${cfg.weight}</span>
              ${cfg.enabled ? '' : '<span class="badge badge-none">ปิดใช้งาน</span>'}
            </div>
            <div class="small-muted mt-1">หมวด: ${U.esc(def.category)}</div>
          </td>
          <td class="small" style="min-width:220px">${U.esc(def.desc)}</td>
          <td class="small" data-sort="${isDemo ? 'ข' : 'ก'}${U.esc(def.id)}" style="min-width:260px">
            <span class="badge ${isDemo ? 'badge-synthetic' : 'badge-real'}">
              ${isDemo ? 'ข้อมูลสาธิต' : 'ข้อมูลจริง'}</span>
            <div class="mt-1">${(doc.fields || []).map(f =>
              `<code class="field-chip">${U.esc(f)}</code>`).join(' ')}</div>
            <div class="small-muted mt-1">${U.esc(doc.basis || '')}</div>
          </td>
          <td style="min-width:230px">
            <div class="codebox">${U.esc(def.logic(cfg.thresholds))}</div>
            ${Diagrams.has(def.id) ? `<button type="button" class="btn btn-sm btn-link p-0 mt-1 detail-clickable"
                    data-type="diagram" data-id="${def.id}">🔍 ดูตัวอย่างรูปแบบ</button>` : ''}
          </td>
          <td class="small" style="min-width:250px">${auditStepsHTML(def.id)}</td>
          ${numTd(stat.n)}
        </tr>`;
    }).join(''));
  }

  function exportRuleTable() {
    const s = state.summary;
    const headers = ['กฎ', 'ชื่อ', 'ระดับ', 'น้ำหนัก', 'หมวด', 'เปิดใช้งาน',
      'คำอธิบายกฎ', 'ประเภทข้อมูล', 'คอลัมน์ที่ใช้', 'ที่มาและเหตุผล', 'การคำนวณ', 'จำนวนที่พบ', 'มูลค่าที่พบ'];
    const rows = Rules.DEFS.map(def => {
      const cfg = state.settings[def.id];
      const doc = Rules.DOCS[def.id] || {};
      const stat = s.counts.get(def.id);
      return [def.id, def.name,
        Rules.BANDS.find(b => b.key === def.severity)?.label || def.severity,
        cfg.weight, def.category, cfg.enabled ? 'ใช่' : 'ไม่',
        def.desc, def.source === 'synthetic' ? 'ข้อมูลสาธิต' : 'ข้อมูลจริง',
        (doc.fields || []).join(' '), doc.basis || '',
        def.logic(cfg.thresholds), stat.n, stat.value];
    });
    U.downloadCSV('procurement-rules.csv', headers, rows);
  }

  function renderRuleSettings() {
    const s = state.summary;
    renderRuleTable();
    U.setHTML('ruleSettings', Rules.DEFS.map(def => {
      const cfg = state.settings[def.id];
      const stat = s.counts.get(def.id);
      const band = Rules.BANDS.find(b => b.key === def.severity);
      return `
        <div class="cardx rule-config mb-3" data-rule="${def.id}">
          <div class="p-3">
            <div class="d-flex flex-wrap justify-content-between align-items-start gap-2 mb-2">
              <div>
                <div class="d-flex align-items-center gap-2 flex-wrap">
                  <strong>${def.id} · ${U.esc(def.name)}</strong>
                  <span class="badge ${band?.cls || 'badge-medium'}">${band?.label || def.severity}</span>
                  <span class="badge ${def.source === 'synthetic' ? 'badge-synthetic' : 'badge-real'}">
                    ${def.source === 'synthetic' ? 'ข้อมูลสาธิต' : 'ข้อมูลจริง'}</span>
                  <span class="badge badge-none">${U.esc(def.category)}</span>
                </div>
                <div class="small-muted mt-1">${U.esc(def.desc)}</div>
              </div>
              <div class="text-end flex-shrink-0">
                <div class="v">${U.num(stat.n)}</div>
                <div class="small-muted">สัญญา · ${U.money(stat.value)} บาท</div>
              </div>
            </div>

            <div class="row g-3 align-items-end">
              <div class="col-6 col-md-3">
                <div class="form-check form-switch">
                  <input class="form-check-input" type="checkbox" role="switch"
                         id="en-${def.id}" data-field="enabled" ${cfg.enabled ? 'checked' : ''}>
                  <label class="form-check-label small" for="en-${def.id}">เปิดใช้กฎนี้</label>
                </div>
              </div>
              <div class="col-6 col-md-3">
                <label class="form-label" for="w-${def.id}">น้ำหนักคะแนน: <span data-label="weight">${cfg.weight}</span></label>
                <input class="form-range" type="range" id="w-${def.id}" data-field="weight"
                       min="0" max="40" step="1" value="${cfg.weight}">
              </div>
              ${Object.entries(def.thresholds || {}).map(([key, spec]) => `
                <div class="col-6 col-md-3">
                  <label class="form-label" for="t-${def.id}-${key}">${U.esc(spec.label)}:
                    <span data-label="${key}">${formatThreshold(cfg.thresholds[key], spec)}</span></label>
                  <input class="form-range" type="range" id="t-${def.id}-${key}"
                         data-field="threshold" data-key="${key}"
                         min="${spec.min}" max="${spec.max}" step="${spec.step}"
                         value="${cfg.thresholds[key]}">
                </div>`).join('')}
            </div>
            <div class="codebox mt-3">${U.esc(def.logic(cfg.thresholds))}</div>
          </div>
        </div>`;
    }).join(''));

    U.$('ruleSettings').querySelectorAll('[data-field]').forEach(input => {
      const handler = input.type === 'checkbox' ? 'change' : 'input';
      input.addEventListener(handler, U.debounce(() => onRuleSettingChange(input), 180));
      // อัปเดตตัวเลขข้างป้ายทันทีแม้การคำนวณจะถูกหน่วง
      if (input.type === 'range') {
        input.addEventListener('input', () => {
          const card = input.closest('.rule-config');
          const def = Rules.BY_ID.get(card.dataset.rule);
          const key = input.dataset.field === 'weight' ? 'weight' : input.dataset.key;
          const label = card.querySelector(`[data-label="${key}"]`);
          if (label) {
            label.textContent = input.dataset.field === 'weight'
              ? input.value : formatThreshold(Number(input.value), def.thresholds[key]);
          }
        });
      }
    });

    U.$('ruleReset').onclick = () => {
      state.settings = Rules.resetSettings();
      recomputeRules();
      renderRuleSettings();
    };
    U.$('ruleTableExport').onclick = exportRuleTable;
  }

  function formatThreshold(value, spec) {
    if (spec.format === 'pct') return (value * 100).toFixed(value < 0.01 ? 1 : 0) + '%';
    return value >= 10000 ? U.num(value) : String(value);
  }

  function onRuleSettingChange(input) {
    const card = input.closest('.rule-config');
    const id = card.dataset.rule;
    const cfg = state.settings[id];
    if (input.dataset.field === 'enabled') cfg.enabled = input.checked;
    else if (input.dataset.field === 'weight') cfg.weight = Number(input.value);
    else cfg.thresholds[input.dataset.key] = Number(input.value);

    Rules.saveSettings(state.settings);
    recomputeRules();

    const def = Rules.BY_ID.get(id);
    card.querySelector('.codebox').textContent = def.logic(cfg.thresholds);
    const stat = state.summary.counts.get(id);
    card.querySelector('.v').textContent = U.num(stat.n);
    card.querySelector('.v').nextElementSibling.textContent =
      `สัญญา · ${U.money(stat.value)} บาท`;

    // ตารางอ้างอิงด้านบนแสดงเงื่อนไขและจำนวนที่พบเหมือนกัน จึงต้องอัปเดตตามไปด้วย
    renderRuleTable();
  }

  /** ประเมินใหม่ทั้งชุดแล้วทำให้ทุกแท็บล้าสมัย — 10,174 ระเบียนใช้เวลาไม่กี่สิบมิลลิวินาที */
  function recomputeRules() {
    Rules.evaluate(state.records, state.ctx, state.settings);
    state.filtered = state.records.filter(matches);
    state.filtered.sort((a, b) => b.risk_score - a.risk_score);
    state.summary = Rules.summarize(state.filtered);
    state.profiles = null;
    renderKPIs();
    renderQuickFilters();
    renderFilterSummary();
    state.dirty = new Set(Object.keys(TAB_RENDERERS));
    state.dirty.delete('tab-rules');   // แผงตั้งค่ากำลังถูกแก้ไขอยู่ ไม่ต้องวาดทับ
    renderActiveTab();
  }

  /* =========================================================
     แท็บสาธิต
     ========================================================= */

  function renderDemo() {
    const demo = state.payload.synthetic_demo || {};
    U.$('demoDisclaimer').textContent = demo.disclaimer || '';

    const statuses = demo.workflow_statuses || [];
    const cases = demo.workflow_cases || [];
    U.setHTML('kanban', statuses.map(status => {
      const items = cases.filter(c => c.status === status);
      return `<div class="col-md-6 col-xl">
        <div class="kanban-col p-2">
          <div class="d-flex justify-content-between align-items-center mb-2">
            <strong class="small">${U.esc(status)}</strong>
            <span class="badge badge-none">${items.length}</span>
          </div>
          ${items.slice(0, 8).map(c => `
            <div class="case-card">
              <div class="small fw-semibold">${U.esc(truncate(c.project_name, 60))}</div>
              <div class="small-muted">${U.esc(truncate(c.dept_name, 40))}</div>
              <div class="small-muted">${U.money(c.value)} บาท · ${U.esc(c.owner)}</div>
            </div>`).join('') || '<div class="small-muted text-center py-3">ไม่มีเคส</div>'}
        </div></div>`;
    }).join('') || U.emptyState('ไม่มีข้อมูลสาธิต'));

    const linkRows = list => (list || []).map(l => `
      <tr><td class="small">${U.esc(l.shared)}</td>
      <td class="small">${l.contractors.map(c => U.esc(truncate(c, 40))).join('<br>')}</td></tr>`
    ).join('') || U.emptyRow(2, 'ไม่มีข้อมูลสาธิต');

    U.setHTML('demoDirectorBody', linkRows(demo.director_links));
    U.setHTML('demoAddressBody', linkRows(demo.address_links));
    U.setHTML('demoSubcontractorBody', linkRows(demo.subcontractor_links));
  }

  /* =========================================================
     เปรียบเทียบสองรายการแบบเคียงข้าง
     ========================================================= */

  let compareModalInstance;
  function getCompareModal() {
    if (!compareModalInstance) compareModalInstance = new bootstrap.Modal(U.$('compareModal'));
    return compareModalInstance;
  }

  const COMPARE_COLOR_A = '#1677FF';
  const COMPARE_COLOR_B = '#DC3545';

  function compareNameList() {
    return state.compare.type === 'contractor'
      ? profiles().map(p => p.winner_name)
      : Analytics.agencyTotals(state.filtered).map(a => a.dept_name);
  }

  /** เปิดหน้าต่างเปรียบเทียบ ตั้งค่าเริ่มต้นเป็นสองอันดับแรกของแท็บนั้น (มูลค่า/คะแนนสูงสุด)
   *  เพราะเป็นคู่ที่มักน่าสนใจที่สุดให้ดูก่อน ผู้ใช้เปลี่ยนได้จาก dropdown ในหน้าต่าง */
  function openCompare(type) {
    state.compare.type = type;
    U.$('compareModalTitle').textContent = type === 'contractor' ? 'เปรียบเทียบผู้รับจ้าง' : 'เปรียบเทียบหน่วยงาน';

    const names = compareNameList();
    if (names.length < 2) {
      U.setHTML('compareSelectA', ''); U.setHTML('compareSelectB', '');
      U.setHTML('compareBody', U.emptyState('มีรายการไม่พอให้เลือกเปรียบเทียบภายใต้ตัวกรองปัจจุบัน'));
      getCompareModal().show();
      return;
    }
    if (!names.includes(state.compare.a)) state.compare.a = names[0];
    if (!names.includes(state.compare.b) || state.compare.b === state.compare.a) {
      state.compare.b = names.find(n => n !== state.compare.a) || names[1];
    }
    populateCompareSelects();
    // เปิดหน้าต่างให้เห็นก่อนเสมอ แม้การวาดเนื้อหาจะพัง ผู้ใช้จะได้เห็นข้อความ error
    // แทนที่จะกดปุ่มแล้วไม่มีอะไรเกิดขึ้นเลยโดยไม่รู้สาเหตุ
    getCompareModal().show();
    renderCompareBodySafe();
  }

  function populateCompareSelects() {
    const names = compareNameList();
    const opts = selected => names.map(n =>
      `<option value="${U.esc(n)}" ${n === selected ? 'selected' : ''}>${U.esc(truncate(n, 55))}</option>`).join('');
    U.setHTML('compareSelectA', opts(state.compare.a));
    U.setHTML('compareSelectB', opts(state.compare.b));
  }

  function wireCompare() {
    U.$('compareContractorsBtn').addEventListener('click', () => openCompare('contractor'));
    U.$('compareAgenciesBtn').addEventListener('click', () => openCompare('agency'));
    U.$('compareSelectA').addEventListener('change', e => { state.compare.a = e.target.value; renderCompareBodySafe(); });
    U.$('compareSelectB').addEventListener('change', e => { state.compare.b = e.target.value; renderCompareBodySafe(); });
  }

  /** จุดเดียวที่ครอบ error ไว้ ครอบคลุมทั้งตอนเปิดหน้าต่างและตอนเปลี่ยน dropdown ทั้งสองช่อง
   *  กันไม่ให้ error หนึ่งจุด (เช่น ไลบรารีกราฟโหลดไม่ทัน) ทำให้ทั้งหน้าต่างไม่ตอบสนอง */
  function renderCompareBodySafe() {
    try {
      renderCompareBody();
    } catch (e) {
      U.setHTML('compareBody', `<div class="alert alert-danger small">แสดงผลเปรียบเทียบไม่สำเร็จ: ${U.esc(e.message)}</div>`);
      console.error('renderCompareBody ล้มเหลว', e);
    }
  }

  function renderCompareBody() {
    if (state.compare.type === 'contractor') renderContractorCompare();
    else renderAgencyCompare();
  }

  /** แถวเปรียบเทียบหนึ่งตัวชี้วัด — ไฮไลต์ฝั่งที่ "แย่กว่า" ด้วยสีแดงอ่อน ไม่ใช้แค่ตัวหนา
   *  higherIsRiskier บอกทิศทางว่าค่ามากหรือค่าน้อยคือน่ากังวลกว่า (default: มากกว่าดีกว่า) */
  /** neutral: true สำหรับตัวเลขที่เป็นข้อเท็จจริงล้วนๆ ไม่มีทิศทาง "ดีกว่า/แย่กว่า" ในตัวเอง
   *  (เช่น จำนวนสัญญา มูลค่ารวม) การไฮไลต์ตัวเลขเหล่านี้จะให้ความหมายที่เข้าใจผิดได้
   *  ไฮไลต์เฉพาะตัวชี้วัดที่เป็นสัญญาณความเสี่ยงจริงๆ เท่านั้น */
  function compareMetricRow(label, valA, valB, opts = {}) {
    const { higherIsRiskier = false, formatFn = U.num, neutral = false } = opts;
    const a = Number(valA) || 0, b = Number(valB) || 0;
    let clsA = '', clsB = '';
    if (!neutral && a !== b) {
      const aWorse = higherIsRiskier ? a > b : a < b;
      clsA = aWorse ? 'compare-worse' : 'compare-better';
      clsB = aWorse ? 'compare-better' : 'compare-worse';
    }
    return `<div class="compare-metric-row">
      <div class="compare-val ${clsA}">${formatFn(valA)}</div>
      <div class="compare-label">${U.esc(label)}</div>
      <div class="compare-val ${clsB}">${formatFn(valB)}</div>
    </div>`;
  }

  function renderContractorCompare() {
    const all = profiles();
    const a = all.find(p => p.winner_name === state.compare.a);
    const b = all.find(p => p.winner_name === state.compare.b);
    if (!a || !b) { U.setHTML('compareBody', U.emptyState('เลือกผู้รับจ้างทั้งสองฝั่งเพื่อเปรียบเทียบ')); return; }

    const agenciesA = new Set(a.pairs.map(p => p.source));
    const agenciesB = new Set(b.pairs.map(p => p.source));
    const shared = [...agenciesA].filter(x => agenciesB.has(x));

    U.setHTML('compareBody', `
      <div class="compare-head">
        <div class="compare-name" style="color:${COMPARE_COLOR_A}">${U.esc(truncate(a.winner_name, 50))}</div>
        <div class="compare-vs">เทียบกับ</div>
        <div class="compare-name" style="color:${COMPARE_COLOR_B}">${U.esc(truncate(b.winner_name, 50))}</div>
      </div>
      ${compareMetricRow('คะแนนรวม 5 มิติ', a.risk.final, b.risk.final, { higherIsRiskier: true, formatFn: v => Number(v).toFixed(1) })}
      ${compareMetricRow('จำนวนสัญญา', a.n_contracts, b.n_contracts, { neutral: true })}
      ${compareMetricRow('จำนวนหน่วยงานที่ทำงานด้วย', a.n_agencies, b.n_agencies, { neutral: true })}
      ${compareMetricRow('มูลค่ารวม', a.total_value, b.total_value, { formatFn: U.money, neutral: true })}
      ${compareMetricRow('สัญญาที่มีสัญญาณ', a.n_flagged, b.n_flagged, { higherIsRiskier: true })}

      <div class="row g-3 mt-2">
        <div class="col-md-6">
          <h3 class="h6">องค์ประกอบคะแนน 5 มิติ</h3>
          <div id="compareRadar" style="height:300px" role="img"
               aria-label="เปรียบเทียบองค์ประกอบคะแนนความเสี่ยง 5 มิติของสองผู้รับจ้าง"></div>
        </div>
        <div class="col-md-6">
          <h3 class="h6">หน่วยงานที่ทำงานร่วมกันทั้งสองราย (${shared.length})</h3>
          <p class="small-muted mb-2">หน่วยงานที่เคยทำสัญญากับผู้รับจ้างทั้งสองราย ไม่ได้แปลว่ามีความผิดปกติ
            แต่เป็นจุดที่อาจน่าตรวจสอบเพิ่มเติมหากพบร่วมกับสัญญาณอื่น</p>
          ${shared.length
            ? `<div class="list-box" style="max-height:220px">${shared.map(name =>
                `<div class="item">${clickable('agency', name, truncate(name, 60))}</div>`).join('')}</div>`
            : U.emptyState('ไม่มีหน่วยงานที่ทำงานร่วมกันทั้งสองราย')}
        </div>
      </div>`);

    Charts.radarCompare('compareRadar', ['เครือข่าย', 'ราคา', 'การแข่งขัน', 'สัญญา', 'การกระจุกตัว'], [
      { name: truncate(a.winner_name, 24), color: COMPARE_COLOR_A,
        values: [a.risk.network, a.risk.price, a.risk.competition, a.risk.contract, a.risk.concentration] },
      { name: truncate(b.winner_name, 24), color: COMPARE_COLOR_B,
        values: [b.risk.network, b.risk.price, b.risk.competition, b.risk.contract, b.risk.concentration] },
    ]);
  }

  function buildAgencyCompareStats(name) {
    const rows = state.filtered.filter(r => r.dept_key === name);
    const total = U.sum(rows.map(r => r.contract_price_agree));
    const contractors = Analytics.contractorTotals(rows);
    const h = Analytics.hhi(rows, { minContracts: 1 })[0];
    const specific = rows.filter(r => r.purchase_method_name === Rules.SPECIFIC_METHOD).length;
    return {
      name, rows, total,
      n_contracts: rows.length,
      n_contractors: contractors.length,
      hhi: h ? h.hhi : 0,
      pctSpecific: rows.length ? specific / rows.length : 0,
      topShare: total && contractors.length ? contractors[0].total_value / total : 0,
      nFlagged: rows.filter(r => (r.rule_hits || []).length).length,
      contractorNames: new Set(contractors.map(c => c.winner_name)),
    };
  }

  function renderAgencyCompare() {
    const a = buildAgencyCompareStats(state.compare.a);
    const b = buildAgencyCompareStats(state.compare.b);
    if (!a.rows.length || !b.rows.length) { U.setHTML('compareBody', U.emptyState('เลือกหน่วยงานทั้งสองฝั่งเพื่อเปรียบเทียบ')); return; }

    const shared = [...a.contractorNames].filter(x => b.contractorNames.has(x));

    U.setHTML('compareBody', `
      <div class="compare-head">
        <div class="compare-name" style="color:${COMPARE_COLOR_A}">${U.esc(truncate(a.name, 50))}</div>
        <div class="compare-vs">เทียบกับ</div>
        <div class="compare-name" style="color:${COMPARE_COLOR_B}">${U.esc(truncate(b.name, 50))}</div>
      </div>
      ${compareMetricRow('จำนวนสัญญา', a.n_contracts, b.n_contracts, { neutral: true })}
      ${compareMetricRow('มูลค่ารวม', a.total, b.total, { formatFn: U.money, neutral: true })}
      ${compareMetricRow('จำนวนผู้รับจ้าง', a.n_contractors, b.n_contractors, { neutral: true })}
      ${compareMetricRow('ดัชนีกระจุกตัว (HHI)', a.hhi, b.hhi, { higherIsRiskier: true, formatFn: v => U.num(Math.round(v)) })}
      ${compareMetricRow('สัดส่วนวิธีเฉพาะเจาะจง', a.pctSpecific, b.pctSpecific, { higherIsRiskier: true, formatFn: U.pct })}
      ${compareMetricRow('ส่วนแบ่งผู้ชนะรายใหญ่สุด', a.topShare, b.topShare, { higherIsRiskier: true, formatFn: U.pct })}
      ${compareMetricRow('สัญญาที่มีสัญญาณ', a.nFlagged, b.nFlagged, { higherIsRiskier: true })}

      <div class="mt-3">
        <h3 class="h6">ผู้รับจ้างที่ทำงานร่วมกันทั้งสองหน่วยงาน (${shared.length})</h3>
        <p class="small-muted mb-2">ผู้รับจ้างที่เคยได้งานจากทั้งสองหน่วยงาน ไม่ได้แปลว่ามีความผิดปกติ
          แต่เป็นจุดที่อาจน่าตรวจสอบเพิ่มเติมหากพบร่วมกับสัญญาณอื่น</p>
        ${shared.length
          ? `<div class="list-box" style="max-height:220px">${shared.map(name =>
              `<div class="item">${clickable('contractor', name, truncate(name, 60))}</div>`).join('')}</div>`
          : U.emptyState('ไม่มีผู้รับจ้างที่ทำงานร่วมกันทั้งสองหน่วยงาน')}
      </div>`);
  }

  /* =========================================================
     หน้าต่างรายละเอียด
     ========================================================= */

  function getModal() {
    if (!modalInstance) modalInstance = new bootstrap.Modal(U.$('detailModal'));
    return modalInstance;
  }

  function openDetail(type, id) {
    const title = {
      project: 'รายละเอียดโครงการ', contractor: 'ข้อมูลผู้รับจ้าง', agency: 'ข้อมูลหน่วยงาน',
      diagram: 'ตัวอย่างรูปแบบของกฎ', term: 'อภิธานศัพท์',
    }[type] || 'รายละเอียด';
    U.$('detailModalTitle').textContent = title;
    U.setHTML('detailModalBody', '<div class="loading-box">กำลังรวบรวมข้อมูล...</div>');
    getModal().show();
    setTimeout(() => {
      try {
        if (type === 'project') renderProjectModal(id);
        else if (type === 'contractor') renderContractorModal(id);
        else if (type === 'agency') renderAgencyModal(id);
        else if (type === 'diagram') renderDiagramModal(id);
        else if (type === 'term') renderGlossaryModal(id);
      } catch (e) {
        U.setHTML('detailModalBody', `<div class="alert alert-danger small">แสดงรายละเอียดไม่สำเร็จ: ${U.esc(e.message)}</div>`);
      }
    }, 30);
  }

  /* =========================================================
     ทัวร์แนะนำครั้งแรก
     ========================================================= */

  const TOUR_KEY = 'pa_tour_done';
  let tourIndex = 0;

  function tourSeen() {
    try { return localStorage.getItem(TOUR_KEY) === '1'; } catch (e) { return true; }
  }
  function markTourSeen() {
    try { localStorage.setItem(TOUR_KEY, '1'); } catch (e) { /* ไม่สำคัญ */ }
  }

  function startTour() {
    tourIndex = 0;
    U.$('tourOverlay').hidden = false;
    document.body.classList.add('tour-open');
    showTourStep();
  }

  function endTour() {
    U.$('tourOverlay').hidden = true;
    document.body.classList.remove('tour-open');
    document.querySelectorAll('.tour-spotlight').forEach(el => el.classList.remove('tour-spotlight'));
    markTourSeen();
  }

  function showTourStep() {
    const step = Learn.TOUR[tourIndex];
    if (!step) { endTour(); return; }

    document.querySelectorAll('.tour-spotlight').forEach(el => el.classList.remove('tour-spotlight'));
    const target = document.querySelector(step.target);
    if (target) {
      target.classList.add('tour-spotlight');
      target.scrollIntoView({ block: 'center', behavior: 'smooth' });
    }

    U.setHTML('tourBody', `
      <div class="tour-step-count">ขั้นที่ ${tourIndex + 1} จาก ${Learn.TOUR.length}</div>
      <h5 class="tour-title">${U.esc(step.title)}</h5>
      <p class="tour-text">${U.esc(step.body)}</p>`);
    U.$('tourPrev').disabled = tourIndex === 0;
    U.$('tourNext').textContent = tourIndex === Learn.TOUR.length - 1 ? 'เริ่มใช้งาน' : 'ถัดไป';
  }

  function wireTour() {
    U.$('tourNext').addEventListener('click', () => { tourIndex++; showTourStep(); });
    U.$('tourPrev').addEventListener('click', () => { tourIndex = Math.max(0, tourIndex - 1); showTourStep(); });
    U.$('tourSkip').addEventListener('click', endTour);
    U.$('tourBtn').addEventListener('click', startTour);
    document.addEventListener('keydown', e => {
      if (U.$('tourOverlay').hidden) return;
      if (e.key === 'Escape') endTour();
      else if (e.key === 'ArrowRight') { tourIndex++; showTourStep(); }
      else if (e.key === 'ArrowLeft') { tourIndex = Math.max(0, tourIndex - 1); showTourStep(); }
    });
    // ครั้งแรกเท่านั้น รอให้หน้าวาดเสร็จก่อนเพื่อให้ไฮไลต์ตำแหน่งถูกต้อง
    if (!tourSeen()) setTimeout(startTour, 700);
  }

  /* =========================================================
     กรณีศึกษา — ตั้งค่าให้ผู้ใช้เห็นของจริงในคลิกเดียว
     ========================================================= */

  function renderCases() {
    const box = U.$('learnCases');
    if (!box) return;
    U.setHTML('learnCases', Learn.CASES.map(c => `
      <button type="button" class="case-card" data-case="${U.esc(c.id)}"
              title="กดเพื่อตั้งตัวกรองและเปิดตัวอย่างจริง">
        <span class="case-badge">${U.esc(c.badge)}</span>
        <span class="case-title">${U.esc(c.title)}</span>
        <span class="case-teaser">${U.esc(c.teaser)}</span>
      </button>`).join(''));
  }

  /** ตั้งตัวกรองตามกรณีศึกษา เปิดแท็บที่เกี่ยวข้อง แล้วอธิบายว่าให้ดูตรงไหน
   *  เลือกสัญญาตัวอย่างจากข้อมูลที่กรองแล้ว ณ ตอนนั้น ไม่ได้ผูกกับรหัสสัญญาตายตัว
   *  ตัวอย่างจึงยังใช้ได้แม้เปลี่ยนชุดข้อมูล */
  function applyCase(caseId) {
    const c = Learn.findCase(caseId);
    if (!c) return;

    resetAllFilters();
    Object.entries(c.filters).forEach(([key, value]) => {
      state.filters[key] = value;
      const control = FILTER_CONTROL[key];
      if (control) U.$(control).value = value;
    });
    applyFilters();

    // เปิดกลุ่มและแท็บปลายทาง
    const pill = U.$('pill-' + c.tab);
    if (pill && !pill.classList.contains('active')) {
      bootstrap.Tab.getOrCreateInstance(pill).show();
    }

    showCaseNote(c, pickExample(c));
  }

  /** เลือกสัญญาตัวอย่างที่ "สอนได้ชัดที่สุด" ไม่ใช่ที่คะแนนสูงสุด
   *
   *  สัญญาคะแนนสูงสุดมักติดกฎพร้อมกันหลายข้อ (บางรายการติด 7 ข้อ) ซึ่งดูไม่ออกว่า
   *  รูปแบบของกฎที่กำลังอธิบายหน้าตาเป็นอย่างไร จึงเลือกรายการที่ติดกฎอื่นน้อยที่สุด
   *  เพื่อให้สัญญาณที่ต้องการสอนเด่นออกมา แล้วค่อยตัดสินด้วยมูลค่าเพื่อให้ยังเป็นรายการที่มีนัยสำคัญ */
  function pickExample(c) {
    if (!c.pickTopRule) return null;
    const candidates = state.filtered
      .filter(r => (r.rule_hits || []).some(h => h.rule_id === c.pickTopRule));
    if (!candidates.length) return null;
    return candidates.reduce((best, r) => {
      const nBest = (best.rule_hits || []).length, nR = (r.rule_hits || []).length;
      if (nR !== nBest) return nR < nBest ? r : best;
      return (r.contract_price_agree || 0) > (best.contract_price_agree || 0) ? r : best;
    });
  }

  /** แถบอธิบายกรณีศึกษา ค้างไว้ด้านล่างจนกว่าผู้ใช้จะปิด */
  function showCaseNote(c, example) {
    const bar = U.$('caseNote');
    if (!bar) return;
    const n = state.filtered.length;
    U.setHTML('caseNote', `
      <div class="case-note-head">
        <span class="case-badge">${U.esc(c.badge)}</span>
        <strong>${U.esc(c.title)}</strong>
        <button type="button" class="case-note-close" id="caseNoteClose"
                title="ปิดคำอธิบาย" aria-label="ปิดคำอธิบายกรณีศึกษา">✕</button>
      </div>
      <div class="case-note-body">
        <p class="mb-1"><strong>ให้ดูตรงไหน:</strong> ${U.esc(c.look)}</p>
        <p class="mb-0 small-muted">ตอนนี้กรองเหลือ <strong>${U.num(n)}</strong> สัญญา` +
        (example
          ? ` · ตัวอย่างที่คะแนนสูงสุด: <button type="button"
                class="term-link detail-clickable" data-type="project"
                data-id="${U.esc(example.project_id)}">${U.esc(truncate(example.project_name, 60))}</button>`
          : '') +
      `</p></div>`);
    bar.hidden = false;
  }

  function wireCases() {
    document.addEventListener('click', e => {
      const card = e.target.closest('[data-case]');
      if (card) { applyCase(card.dataset.case); return; }
      if (e.target.closest('#caseNoteClose')) {
        const bar = U.$('caseNote');
        if (bar) bar.hidden = true;
      }
    });
  }

  /* =========================================================
     อภิธานศัพท์กลาง
     ========================================================= */

  /** แสดงคำเดียวพร้อมคำที่เกี่ยวข้อง หรือทั้งชุดเมื่อ id = 'all'
   *  ใช้ modal เดิมร่วมกับรายละเอียดอื่น จึงไม่ต้องเพิ่ม modal ใหม่ */
  function renderGlossaryModal(id) {
    if (id === 'all') { renderGlossaryAll(); return; }
    const t = Learn.glossaryTerm(id);
    if (!t) { U.setHTML('detailModalBody', U.emptyState('ไม่พบคำนี้ในอภิธานศัพท์')); return; }

    const related = (t.seeAlso || [])
      .map(k => [k, Learn.glossaryTerm(k)])
      .filter(([, v]) => v)
      .map(([k, v]) => `<button type="button" class="term-link detail-clickable"
              data-type="term" data-id="${U.esc(k)}">${U.esc(v.term)}</button>`).join(' ');

    U.setHTML('detailModalBody', `
      <div class="detail-section">
        <h6>${U.esc(t.term)}</h6>
        <p class="glossary-short">${U.esc(t.short)}</p>
        <p class="glossary-body mb-0">${U.esc(t.body)}</p>
      </div>
      ${related ? `<div class="detail-section">
        <h6>คำที่เกี่ยวข้อง</h6>
        <div class="term-links">${related}</div>
      </div>` : ''}
      <div class="detail-section">
        <button type="button" class="btn btn-sm btn-outline-secondary detail-clickable"
                data-type="term" data-id="all">ดูอภิธานศัพท์ทั้งหมด</button>
      </div>`);
  }

  function renderGlossaryAll() {
    const items = Learn.glossaryIds().map(k => {
      const t = Learn.glossaryTerm(k);
      return `<div class="glossary-item">
        <button type="button" class="glossary-term detail-clickable"
                data-type="term" data-id="${U.esc(k)}">${U.esc(t.term)}</button>
        <div class="glossary-short">${U.esc(t.short)}</div>
      </div>`;
    }).join('');
    U.setHTML('detailModalBody', `
      <div class="detail-section">
        <p class="small-muted">คำอธิบายทุกคำอิงจากสูตรที่ระบบใช้คำนวณจริง กดที่คำเพื่อดูรายละเอียดเต็ม</p>
        <div class="glossary-grid">${items}</div>
      </div>`);
  }

  /** แผงตัวอย่างรูปแบบเชิงภาพของกฎ — ใช้กับกฎที่เป็น "รูปแบบความสัมพันธ์" เท่านั้น
   *  (ดูรายชื่อที่มีตัวอย่างได้จาก Diagrams.ids) กฎที่เหลือยังอ่านสูตรจาก codebox ตามเดิม */
  function renderDiagramModal(ruleId) {
    const def = Rules.BY_ID.get(ruleId);
    const html = Diagrams.render(ruleId);
    U.setHTML('detailModalBody', `
      <div class="detail-section">
        <h6>${U.esc(ruleId)} · ${U.esc(def?.name || '')}</h6>
        ${html || U.emptyState('ยังไม่มีตัวอย่างภาพสำหรับกฎนี้')}
      </div>
      ${def ? `<div class="detail-section">
        <h6>สูตรที่ใช้จริง</h6>
        <div class="codebox">${U.esc(def.logic(state.settings[ruleId].thresholds))}</div>
      </div>` : ''}
      <div class="detail-section">
        <h6>ถ้าเจอแบบนี้ ตรวจอะไรต่อ</h6>
        ${auditStepsHTML(ruleId)}
      </div>`);
  }

  const kvRow = (k, v) => `<div class="detail-kv"><span class="k">${k}</span><span class="v">${v}</span></div>`;

  function renderProjectModal(projectId) {
    const rows = state.records.filter(r => r.project_id === projectId);
    if (!rows.length) { U.setHTML('detailModalBody', U.emptyState('ไม่พบโครงการนี้')); return; }
    const r = rows[0];
    U.setHTML('detailModalBody', `
      <div class="detail-section">
        <h6>${U.esc(r.project_name)}</h6>
        ${kvRow('รหัสโครงการ', U.esc(r.project_id))}
        ${kvRow('หน่วยงาน', U.esc(r.dept_name))}
        ${kvRow('หน่วยงานย่อย', U.esc(r.dept_sub_name))}
        ${kvRow('วิธีจัดหา', U.esc(r.purchase_method_name))}
        ${kvRow('ประเภท', U.esc(r.project_type_name))}
        ${kvRow('พื้นที่หน่วยงาน', U.esc([r.province, r.district, r.subdistrict].filter(Boolean).join(' / ')))}
      </div>
      <div class="detail-section">
        <h6>ข้อมูลการเงิน</h6>
        ${kvRow('วงเงินโครงการ', U.baht(r.project_money))}
        ${kvRow('ราคากลาง', U.baht(r.price_build))}
        ${kvRow('มูลค่าสัญญา', U.baht(r.contract_price_agree))}
        ${kvRow('ยอดรวมทั้งโครงการ', U.baht(r.sum_price_agree))}
      </div>
      ${rows.length > 1 ? `<div class="detail-section">
        <h6>สัญญาในโครงการนี้ (${rows.length} ฉบับ)</h6>
        <table class="table table-sm mini-table mb-0">
          <thead><tr><th>เลขที่สัญญา</th><th>ผู้รับจ้าง</th><th class="text-end">มูลค่า</th></tr></thead>
          <tbody>${rows.map(x => `<tr><td>${U.esc(x.contract_no)}</td>
            <td>${U.esc(truncate(x.winner_name, 40))}</td>
            ${moneyTd(x.contract_price_agree)}</tr>`).join('')}</tbody>
        </table></div>` : ''}
      <div class="detail-section">
        <h6>สัญญาณความเสี่ยง (${(r.rule_hits || []).length})</h6>
        ${(r.rule_hits || []).map(h => `
          <div class="mb-2"><strong class="small">${h.rule_id} · ${U.esc(h.rule_name)}</strong>
          <span class="badge ${h.source === 'synthetic' ? 'badge-synthetic' : 'badge-real'}">${h.source === 'synthetic' ? 'สาธิต' : 'จริง'}</span>
          <div class="small-muted">${U.esc(h.actual)}</div></div>`).join('') || '<div class="small-muted">ไม่พบ</div>'}
      </div>`);
  }

  function renderContractorModal(name) {
    const rows = state.records.filter(r => r.winner_key === name || r.winner_name === name);
    if (!rows.length) { U.setHTML('detailModalBody', U.emptyState('ไม่พบผู้รับจ้างรายนี้')); return; }
    const agencies = Analytics.agencyTotals(rows);
    const total = U.sum(rows.map(r => r.contract_price_agree));
    U.setHTML('detailModalBody', `
      <div class="detail-section">
        <h6>${U.esc(name)}</h6>
        ${kvRow('เลขผู้เสียภาษี', [...new Set(rows.map(r => r.winner_tin))].map(U.esc).join(', '))}
        ${kvRow('จำนวนสัญญา', U.num(rows.length))}
        ${kvRow('มูลค่ารวม', U.baht(total))}
        ${kvRow('จำนวนหน่วยงาน', U.num(agencies.length))}
        ${kvRow('คะแนนสูงสุด', U.num(Math.max(...rows.map(r => r.risk_score))))}
      </div>
      <div class="detail-section">
        <h6>หน่วยงานที่ทำสัญญาด้วย</h6>
        <table class="table table-sm mini-table mb-0">
          <thead><tr><th>หน่วยงาน</th><th class="text-end">สัญญา</th><th class="text-end">มูลค่า</th><th class="text-end">สัดส่วน</th></tr></thead>
          <tbody>${agencies.slice(0, 20).map(a => `<tr>
            <td>${U.esc(truncate(a.dept_name, 40))}</td>
            ${numTd(a.n_contracts)}
            ${moneyTd(a.total_value)}
            ${pctTd(total ? a.total_value / total : 0)}</tr>`).join('')}</tbody>
        </table>
      </div>
      <div class="detail-section">
        <h6>สัญญาที่คะแนนสูงสุด</h6>
        <table class="table table-sm mini-table mb-0">
          <thead><tr><th>โครงการ</th><th class="text-end">มูลค่า</th><th class="text-end">คะแนน</th></tr></thead>
          <tbody>${[...rows].sort((a, b) => b.risk_score - a.risk_score).slice(0, 15).map(r => `<tr>
            <td>${U.esc(truncate(r.project_name, 60))}</td>
            ${moneyTd(r.contract_price_agree)}
            <td class="text-end" data-sort="${r.risk_score}">${scoreBadge(r.risk_score)}</td></tr>`).join('')}</tbody>
        </table>
      </div>`);
  }

  function renderAgencyModal(name) {
    const rows = state.records.filter(r => r.dept_key === name || r.dept_name === name);
    if (!rows.length) { U.setHTML('detailModalBody', U.emptyState('ไม่พบหน่วยงานนี้')); return; }
    const contractors = Analytics.contractorTotals(rows);
    const total = U.sum(rows.map(r => r.contract_price_agree));
    const h = Analytics.hhi(rows, { minContracts: 1 })[0];
    const methods = [...U.countBy(rows, r => r.purchase_method_name)].sort((a, b) => b[1] - a[1]);
    U.setHTML('detailModalBody', `
      <div class="detail-section">
        <h6>${U.esc(name)}</h6>
        ${kvRow('จำนวนสัญญา', U.num(rows.length))}
        ${kvRow('มูลค่ารวม', U.baht(total))}
        ${kvRow('จำนวนผู้รับจ้าง', U.num(contractors.length))}
        ${kvRow('HHI', h ? U.num(Math.round(h.hhi)) + (h.hhi > 2500 ? ' (กระจุกตัวสูง)' : '') : '-')}
        ${kvRow('สัญญาที่มีสัญญาณ', U.num(rows.filter(r => (r.rule_hits || []).length).length))}
      </div>
      <div class="detail-section">
        <h6>วิธีจัดหาที่ใช้</h6>
        ${methods.map(m => kvRow(U.esc(m[0]), `${m[1]} (${U.pct(m[1] / rows.length)})`)).join('')}
      </div>
      <div class="detail-section">
        <h6>ผู้รับจ้างรายใหญ่</h6>
        <table class="table table-sm mini-table mb-0">
          <thead><tr><th>ผู้รับจ้าง</th><th class="text-end">สัญญา</th><th class="text-end">มูลค่า</th><th class="text-end">ส่วนแบ่ง</th></tr></thead>
          <tbody>${contractors.slice(0, 20).map(c => `<tr>
            <td>${U.esc(truncate(c.winner_name, 40))}</td>
            ${numTd(c.n_contracts)}
            ${moneyTd(c.total_value)}
            ${pctTd(total ? c.total_value / total : 0)}</tr>`).join('')}</tbody>
        </table>
      </div>`);
  }

  /* =========================================================
     ตัวควบคุมอื่น
     ========================================================= */

  function wireControls() {
    wireCompare();
    wireCases();
    wireTour();
    renderCases();
    U.$('glossaryBtn').addEventListener('click', () => openDetail('term', 'all'));

    // เครือข่าย
    document.querySelectorAll('.net-view-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        document.querySelectorAll('.net-view-btn').forEach(b => {
          b.classList.remove('active'); b.setAttribute('aria-pressed', 'false');
        });
        btn.classList.add('active'); btn.setAttribute('aria-pressed', 'true');
        state.net.view = btn.dataset.view;
        state.dirty.add('tab-network');
        renderActiveTab();
      });
    });
    const netRefresh = () => { state.dirty.add('tab-network'); renderActiveTab(); };

    [['netColorBy', 'colorBy'], ['netAgency', 'agency'], ['netContractor', 'contractor'],
     ['netRule', 'rule'], ['netBand', 'band']].forEach(([id, key]) => {
      U.$(id).addEventListener('change', e => { state.net[key] = e.target.value; netRefresh(); });
    });
    [['netFlaggedOnly', 'flaggedOnly'], ['netMaskedOut', 'maskedOut']].forEach(([id, key]) => {
      U.$(id).addEventListener('change', e => { state.net[key] = e.target.checked; netRefresh(); });
    });

    bindRange('netTopN', 'netTopNLabel', v => { state.net.topN = v; netRefresh(); });
    bindRange('netMinValue', 'netMinValueLabel', v => { state.net.minValue = v; netRefresh(); });
    bindRange('netMinContracts', 'netMinContractsLabel', v => { state.net.minContracts = v; netRefresh(); });

    U.$('netReset').addEventListener('click', () => {
      Object.assign(state.net, {
        agency: '', contractor: '', rule: '', band: '',
        minContracts: 1, minValue: 0, topN: 40, flaggedOnly: false, maskedOut: false,
      });
      ['netAgency', 'netContractor', 'netRule', 'netBand'].forEach(id => { U.$(id).value = ''; });
      U.$('netFlaggedOnly').checked = false;
      U.$('netMaskedOut').checked = false;
      [['netTopN', 40], ['netMinValue', 0], ['netMinContracts', 1]].forEach(([id, v]) => {
        U.$(id).value = v;
        U.$(id + 'Label').textContent = v;
      });
      netRefresh();
    });

    // ผู้รับจ้าง
    U.$('contractorSearch').addEventListener('input', U.debounce(e => {
      state.contractor.q = e.target.value.trim().toLowerCase();
      state.dirty.add('tab-contractor'); renderActiveTab();
    }, 250));
    bindRange('contractorRiskMin', 'contractorRiskMinLabel', v => {
      state.contractor.riskMin = v; state.dirty.add('tab-contractor'); renderActiveTab();
    });
    bindRange('contractorContractMin', 'contractorContractMinLabel', v => {
      state.contractor.contractMin = v; state.dirty.add('tab-contractor'); renderActiveTab();
    });

    // แนวโน้มเวลา
    U.$('tsDimension').addEventListener('change', e => {
      state.ts.dimension = e.target.value; state.dirty.add('tab-time'); renderActiveTab();
    });
    U.$('tsMetric').addEventListener('change', e => {
      state.ts.metric = e.target.value; state.dirty.add('tab-time'); renderActiveTab();
    });

    // ส่งออก
    U.$('exportBtn').addEventListener('click', () => exportRecords(state.filtered, 'procurement-filtered.csv'));
    U.$('fraudExport').addEventListener('click', () =>
      exportRecords(state.filtered.filter(r => (r.rule_hits || []).length), 'procurement-redflags.csv'));

    U.$('provenanceBtn').addEventListener('click', showProvenance);

    // คลิกที่ชื่อเพื่อเปิดรายละเอียด — ใช้ event delegation แทน inline onclick
    // รวม .term ไว้ด้วย เพื่อให้ศัพท์เทคนิคที่ฝังในเนื้อหาเปิดอภิธานศัพท์ได้โดยไม่ต้องผูก listener เพิ่ม
    const DETAIL_SEL = '.detail-clickable[data-type][data-id], .term[data-type][data-id]';
    document.addEventListener('click', e => {
      const el = e.target.closest(DETAIL_SEL);
      if (el) openDetail(el.dataset.type, el.dataset.id);
    });
    document.addEventListener('keydown', e => {
      if (e.key !== 'Enter') return;
      const el = e.target.closest?.(DETAIL_SEL);
      if (el) openDetail(el.dataset.type, el.dataset.id);
    });

    window.addEventListener('hashchange', () => { readHash(); applyFilters(); });
  }

  function bindRange(inputId, labelId, onDone) {
    const input = U.$(inputId), label = U.$(labelId);
    input.setAttribute('aria-live', 'polite');
    input.addEventListener('input', () => { label.textContent = input.value; });
    input.addEventListener('input', U.debounce(() => onDone(Number(input.value)), 200));
  }

  function exportRecords(rows, filename) {
    const headers = ['รหัสโครงการ', 'ชื่อโครงการ', 'ประเภท', 'หน่วยงาน', 'วิธีจัดหา', 'จังหวัด',
      'ผู้รับจ้าง', 'เลขผู้เสียภาษี', 'วงเงินโครงการ', 'ราคากลาง', 'มูลค่าสัญญา',
      'วันทำสัญญา', 'วันสิ้นสุด', 'ระยะเวลา(วัน)', 'ละติจูด', 'ลองจิจูด',
      'คะแนนความเสี่ยง', 'ระดับ', 'กฎที่เข้าเงื่อนไข'];
    const data = rows.map(r => [
      r.project_id, r.project_name, r.project_type_name, r.dept_name, r.purchase_method_name,
      r.province, r.winner_name, r.winner_tin, r.project_money, r.price_build, r.contract_price_agree,
      r.contract_date, r.contract_finish_date, r.duration_days, r.lat, r.lon,
      r.risk_score, Rules.band(r.risk_score).label,
      (r.rule_hits || []).map(h => h.rule_id).join(' '),
    ]);
    U.downloadCSV(filename, headers, data);
  }

  function showProvenance() {
    const m = state.payload.meta || {};
    const s = Rules.summarize(state.records);
    const realFiring = Rules.DEFS.filter(d => d.source === 'real' && s.counts.get(d.id).n > 0);
    const realSilent = Rules.DEFS.filter(d => d.source === 'real' && s.counts.get(d.id).n === 0);
    const synthetic = Rules.DEFS.filter(d => d.source === 'synthetic');

    U.$('detailModalTitle').textContent = 'ที่มาของข้อมูล';
    U.setHTML('detailModalBody', `
      <div class="detail-section">
        <h6>ชุดข้อมูล</h6>
        ${kvRow('ไฟล์ต้นทาง', U.esc(m.source_file))}
        ${kvRow('สร้างเมื่อ', U.esc(m.generated_at))}
        ${kvRow('จำนวนสัญญา', U.num(m.total_records))}
        ${kvRow('มูลค่ารวม', U.baht(m.total_contract_value))}
        ${kvRow('ช่วงวันทำสัญญา', `${m.contract_date_min} ถึง ${m.contract_date_max}`)}
        ${kvRow('ปีงบประมาณ', (m.budget_years || []).join(', '))}
        ${kvRow('ความครอบคลุม', `${U.num(m.n_provinces)} จังหวัด · ${U.num(m.n_agencies)} หน่วยงาน · ${U.num(m.n_contractors)} ผู้รับจ้าง`)}
        ${kvRow('สัญญาที่มีพิกัด', `${U.num(m.geo_rows)} (${m.geo_pct}%)`)}
        ${kvRow('เลขภาษีที่ถูกปิดบัง', `${U.num(m.n_masked_tins)} — ไม่ถูกใช้ในการวิเคราะห์ตัวตน`)}
      </div>
      <div class="detail-section">
        <h6>ความหมายของป้ายกำกับ</h6>
        <div class="small mb-1"><span class="badge badge-real">ข้อมูลจริง</span> มาจากไฟล์ต้นทางโดยตรง</div>
        <div class="small mb-1"><span class="badge badge-derived">คำนวณ</span> คำนวณจากข้อมูลจริงในเบราว์เซอร์</div>
        <div class="small"><span class="badge badge-synthetic">ข้อมูลสาธิต</span> สังเคราะห์ขึ้นเพื่อสาธิต ไม่นับรวมในคะแนนจริง</div>
      </div>
      <div class="detail-section">
        <h6>สถานะของกฎ (ทั้งชุดข้อมูล)</h6>
        <div class="small mb-2">กฎที่ใช้ข้อมูลจริงและพบสัญญาณ: <strong>${realFiring.length}</strong> ข้อ</div>
        ${realFiring.map(d => `<div class="small">• ${d.id} ${U.esc(d.name)} — ${U.num(s.counts.get(d.id).n)} สัญญา</div>`).join('')}
        ${realSilent.length ? `<div class="small mt-2 mb-1">กฎที่ใช้ข้อมูลจริงแต่ไม่พบสัญญาณ: <strong>${realSilent.length}</strong> ข้อ</div>
          ${realSilent.map(d => `<div class="small">• ${d.id} ${U.esc(d.name)}</div>`).join('')}` : ''}
        <div class="small mt-2 mb-1">กฎที่ใช้ข้อมูลสาธิต: <strong>${synthetic.length}</strong> ข้อ
          (ไม่นับรวมในคะแนนที่แสดง)</div>
        ${synthetic.map(d => `<div class="small">• ${d.id} ${U.esc(d.name)} — ${U.num(s.counts.get(d.id).n)} สัญญา</div>`).join('')}
      </div>
      <div class="detail-section">
        <h6>ข้อจำกัดที่ควรทราบ</h6>
        <div class="small">• คอลัมน์จังหวัด อำเภอ ตำบล ระบุที่ตั้งของหน่วยงาน ไม่ใช่ที่ตั้งโครงการ
          ส่วนพิกัดบนแผนที่มาจากคอลัมน์ตำแหน่งโครงการ ทั้งสองอย่างจึงไม่จำเป็นต้องตรงกัน</div>
        <div class="small">• ชุดข้อมูลไม่มีจำนวนผู้เสนอราคาและวันปิดรับซอง จึงประเมินการแข่งขันได้เพียงบางส่วน</div>
        <div class="small">• ชื่อผู้รับจ้างถูกทำให้เป็นมาตรฐานก่อนวิเคราะห์ เพื่อไม่ให้ชื่อเดียวกันที่พิมพ์ต่างกันถูกนับเป็นคนละราย</div>
        <div class="small">• คะแนนความเสี่ยงใช้จัดลำดับความสำคัญในการตรวจสอบ ไม่ใช่ข้อสรุปว่ามีการกระทำผิด</div>
      </div>`);
    getModal().show();
  }

  /* ---------- ลิงก์ที่แชร์ได้ ---------- */

  function writeHash() {
    const f = state.filters;
    const params = new URLSearchParams();
    if (f.q) params.set('q', f.q);
    if (f.province) params.set('prov', f.province);
    if (f.method) params.set('method', f.method);
    if (f.type) params.set('type', f.type);
    if (f.band) params.set('band', f.band);
    if (f.rule) params.set('rule', f.rule);
    if (f.minValue) params.set('min', String(f.minValue / 1e6));
    if (f.flagged) params.set('flagged', '1');
    params.set('tab', activeTabId().replace('tab-', ''));
    history.replaceState(null, '', '#' + params.toString());
  }

  function readHash() {
    const params = new URLSearchParams(location.hash.slice(1));
    if (![...params.keys()].length) return;
    const set = (id, value) => { if (value !== null) U.$(id).value = value; };
    set('gfSearch', params.get('q'));
    set('gfProvince', params.get('prov'));
    set('gfMethod', params.get('method'));
    set('gfType', params.get('type'));
    set('gfBand', params.get('band'));
    set('gfRule', params.get('rule'));
    set('gfMinValue', params.get('min'));
    // ตั้งก่อนเรียก sync เพราะ syncFiltersFromUI จะคงค่านี้ไว้ตามที่อยู่ใน state
    state.filters.flagged = params.get('flagged') === '1';
    syncFiltersFromUI();

    const tab = params.get('tab');
    const btn = tab && U.$('pill-' + tab);
    if (btn && !btn.classList.contains('active')) bootstrap.Tab.getOrCreateInstance(btn).show();
  }

  document.addEventListener('DOMContentLoaded', boot);

  return { state, openDetail };
})();
