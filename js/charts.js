/* charts.js — ตัวห่อ Plotly

   ใช้ Plotly.react แทน newPlot เพื่อให้การอัปเดตเป็นการ diff ไม่ใช่สร้างกราฟใหม่ทั้งหมด
   และเปิด modebar ไว้เพื่อให้ผู้ใช้บันทึกกราฟเป็น PNG ได้ (ของเดิมปิดไว้ทุกจุด)
*/
'use strict';

const Charts = (() => {

  const C = {
    teal: '#0f766e', orange: '#ea580c', red: '#b91c1c', yellow: '#ca8a04',
    purple: '#7c3aed', indigo: '#4338ca', blue: '#1d4ed8', green: '#166534',
    grey: '#94a3b8', pink: '#db2777', sky: '#0ea5e9',
  };

  const CATEGORICAL = [C.teal, C.orange, C.purple, C.blue, C.yellow,
    C.red, C.green, C.pink, C.sky, C.indigo];

  const FONT = { family: "'IBM Plex Sans Thai', system-ui, sans-serif", size: 12 };

  /* สีตัวอักษรและเส้นกริดของ Plotly เป็นค่าใน JS ไม่ใช่ CSS จึงไม่เปลี่ยนตามธีมเอง
     อ่านค่าจากโทเค็น CSS ชุดเดียวกับที่หน้าเว็บใช้ แล้วจำไว้เพื่อไม่ต้องเรียก
     getComputedStyle ทุกครั้งที่วาดกราฟ (แท็บหนึ่งวาดได้ถึง 4 กราฟ)
     app.js เรียก Charts.refreshTheme() เมื่อผู้ใช้สลับธีม เพื่อล้างค่าที่จำไว้ */
  let themeCache = null;
  function T() {
    if (themeCache) return themeCache;
    const cs = getComputedStyle(document.documentElement);
    const v = (name, fallback) => (cs.getPropertyValue(name) || '').trim() || fallback;
    themeCache = {
      ink: v('--text', '#132420'),
      dim: v('--muted', '#5F7570'),
      grid: v('--border', '#E1EAE7'),
      line: v('--border-strong', '#C9D8D3'),
      surface: v('--surface', '#FFFFFF'),
    };
    return themeCache;
  }
  function refreshTheme() { themeCache = null; }

  const CONFIG = {
    responsive: true,
    displaylogo: false,
    modeBarButtonsToRemove: ['lasso2d', 'select2d', 'autoScale2d'],
    toImageButtonOptions: { format: 'png', scale: 2 },
  };

  function baseLayout(extra = {}) {
    return Object.assign({
      font: Object.assign({}, FONT, { color: T().ink }),
      paper_bgcolor: 'rgba(0,0,0,0)',
      plot_bgcolor: 'rgba(0,0,0,0)',
      margin: { t: 30, l: 60, r: 20, b: 45 },
      hoverlabel: { font: { family: FONT.family, size: 11 } },
      xaxis: { gridcolor: T().grid, zerolinecolor: T().line },
      yaxis: { gridcolor: T().grid, zerolinecolor: T().line },
      // Plotly.react เห็นค่าที่เปลี่ยนแล้วไล่แท่ง/เส้นเข้าตำแหน่งใหม่ให้เอง เมื่อตัวกรองเปลี่ยน
      // ผู้ใช้จึงเห็นว่าตัวเลขไหนขยับ ไม่ใช่กราฟกระพริบเปลี่ยนเป็นค่าใหม่ทันที
      transition: { duration: 350, easing: 'cubic-in-out' },
    }, extra);
  }

  /** วาดกราฟ; ถ้าไม่มีข้อมูลให้แสดงข้อความแทนที่จะปล่อยพื้นที่ว่าง
   *  (ของเดิมกราฟว่างแยกไม่ออกจาก widget ที่พัง) */
  function draw(id, traces, layout = {}, emptyMessage = 'ไม่มีข้อมูลสำหรับกราฟนี้', configExtra = null) {
    const el = U.$(id);
    if (!el) return;
    // ต้องครอบคลุมทุกชนิดกราฟที่ใช้: cartesian (x/y), pie (values/labels),
    // sankey (link), treemap (labels) และ scatterpolar (r/theta)
    const hasData = traces.some(t =>
      (t.x && t.x.length) || (t.y && t.y.length) ||
      (t.values && t.values.length) || (t.labels && t.labels.length) ||
      (t.r && t.r.length) ||
      (t.link && t.link.value && t.link.value.length));
    if (!hasData) {
      if (el.dataset.plotted) { Plotly.purge(el); delete el.dataset.plotted; }
      el.innerHTML = U.emptyState(emptyMessage);
      el._spec = null;
      hideTools(el);
      return;
    }
    if (!el.dataset.plotted) el.innerHTML = '';
    const full = baseLayout(layout);
    // Plotly แก้ trace/layout ที่ส่งเข้าไปตรงๆ ตอนผู้ใช้ซูมหรือกด legend
    // จึงเก็บสำเนาที่ยังไม่ถูกแตะไว้ให้ปุ่มรีเซ็ตใช้วาดกลับ
    el._spec = { traces: clone(traces), layout: clone(full) };
    // configExtra ใช้เฉพาะจุดที่ต้องเปิดเครื่องมือ Plotly พิเศษ (เช่น ลากเลือกจุด) โดยไม่กระทบกราฟอื่น
    Plotly.react(el, traces, full, configExtra ? Object.assign({}, CONFIG, configExtra) : CONFIG);
    el.dataset.plotted = '1';
    renderTools(el);
  }

  function clone(x) {
    try { return structuredClone(x); } catch (e) { return JSON.parse(JSON.stringify(x)); }
  }

  /* ---------- แถบเครื่องมือของกราฟ: สลับแบบ · รีเซ็ต · เต็มจอ · ดาวน์โหลด ----------
     ใส่ครั้งเดียวที่ draw() กราฟทุกตัวจึงได้เครื่องมือชุดเดียวกันโดยไม่ต้องแก้ทีละจุด
     วางเป็นพี่น้องก่อนหน้ากราฟ ไม่ใช่ข้างใน เพราะ Plotly.purge/innerHTML ของกราฟจะล้างทิ้ง */

  const KINDS = {
    bar:     { icon: '▮', label: 'แท่งตั้ง' },
    hbar:    { icon: '▬', label: 'แท่งนอน' },
    donut:   { icon: '◔', label: 'โดนัท' },
    treemap: { icon: '▦', label: 'ทรีแมป' },
    table:   { icon: '☰', label: 'ตาราง' },
  };
  const KIND_KEY = 'pa_chart_kind:';
  const DONUT_MAX = 8;
  const TOPN_OPTIONS = [10, 20];

  const TS_KINDS = {
    line:     { icon: '📈', label: 'เส้น' },
    stackbar: { icon: '▤', label: 'แท่งซ้อน' },
    area:     { icon: '⛰', label: 'พื้นที่ซ้อน' },
    heatmap:  { icon: '▧', label: 'แผนที่ความร้อน' },
  };

  let filterHook = null;
  /** app.js เรียกครั้งเดียวตอนบูต — คลิกแท่ง/ชิ้นโดนัทที่ประกาศ opts.filterKey ไว้จะเรียก fn(key, value)
   *  แยกเป็น hook เพราะ charts.js ไม่รู้จัก state ตัวกรองหรือ applyFilters ของ app.js */
  function wireFilterClick(fn) { filterHook = fn; }

  function toolsOf(el) {
    const prev = el.previousElementSibling;
    return prev && prev.classList.contains('chart-tools') && prev.dataset.for === el.id ? prev : null;
  }

  function hideTools(el) {
    const bar = toolsOf(el);
    if (bar) bar.hidden = true;
  }

  /* ---------- ค่าที่จำไว้ต่อกราฟ: แบบกราฟ · Top N · โหมด % ----------
     ของเดิมเก็บแค่ชื่อแบบกราฟเป็นสตริงเปล่า จึงต้องอ่านแบบที่รองรับทั้งสตริงเดิมและ JSON ใหม่ */
  function loadUiState(id) {
    let raw = null;
    try { raw = localStorage.getItem(KIND_KEY + id); } catch (e) { /* โหมดส่วนตัว */ }
    if (!raw) return {};
    try {
      const o = JSON.parse(raw);
      if (o && typeof o === 'object') return o;
    } catch (e) { /* ค่าเดิมก่อนอัปเดตคือชื่อแบบกราฟล้วนๆ ไม่ใช่ JSON */ }
    return { kind: raw };
  }
  function saveUiState(id, st) {
    try {
      if (!st.kind && !st.topN && !st.pct) { localStorage.removeItem(KIND_KEY + id); return; }
      localStorage.setItem(KIND_KEY + id, JSON.stringify(st));
    } catch (e) { /* โหมดส่วนตัว */ }
  }
  function persist(el) {
    const s = el._series;
    saveUiState(el.id, {
      kind: s.kind !== s.natural ? s.kind : undefined,
      topN: s.topN || undefined,
      pct: s.pct || undefined,
    });
  }

  function renderTools(el) {
    let bar = toolsOf(el);
    if (!bar) {
      bar = document.createElement('div');
      bar.className = 'chart-tools';
      bar.dataset.for = el.id;
      bar.setAttribute('role', 'toolbar');
      bar.setAttribute('aria-label', 'เครื่องมือกราฟ');
      bar.addEventListener('click', onToolClick);
      bar.addEventListener('change', onToolChange);
      el.parentNode.insertBefore(bar, el);
    }
    const s = el._series;
    const ts = el._ts;
    const kinds = s ? allowedKinds(s) : [];
    const btn = (attrs, text, title, on) =>
      `<button type="button" class="chart-tool${on ? ' is-on' : ''}" ${attrs} title="${title}" aria-label="${title}">${text}</button>`;
    const kindBtns = s && kinds.length > 1
      ? `<span class="chart-kinds" role="group" aria-label="แบบกราฟ">${kinds.map(k =>
          `<button type="button" class="chart-tool${k === s.kind ? ' is-on' : ''}" data-kind="${k}"
            aria-pressed="${k === s.kind}" title="แสดงเป็น${KINDS[k].label}"
            aria-label="แสดงเป็น${KINDS[k].label}">${KINDS[k].icon}</button>`).join('')}</span>`
      : ts
      ? `<span class="chart-kinds" role="group" aria-label="แบบกราฟ">${Object.keys(TS_KINDS).map(k =>
          `<button type="button" class="chart-tool${k === ts.kind ? ' is-on' : ''}" data-tskind="${k}"
            aria-pressed="${k === ts.kind}" title="แสดงเป็น${TS_KINDS[k].label}"
            aria-label="แสดงเป็น${TS_KINDS[k].label}">${TS_KINDS[k].icon}</button>`).join('')}</span>`
      : '';
    // Top N และ % มีผลเฉพาะกราฟที่ทุกค่าเป็นส่วนหนึ่งของผลรวมเดียว (parts) — ฮิสโทแกรม/นับตามกฎที่ติดได้หลายข้อ
    // เรียงหรือย่อเป็น % ไม่ได้ความหมายเดิม จึงไม่แสดงตัวเลือกนี้ให้
    const canTopN = s && s.parts && s.labels.length > TOPN_OPTIONS[0];
    const topNSel = canTopN
      ? `<select class="chart-tool chart-topn" data-act="topn" title="แสดงเฉพาะรายการที่มีค่าสูงสุด N อันดับแรก" aria-label="จำนวนอันดับที่แสดง">
          <option value=""${s.topN ? '' : ' selected'}>ทั้งหมด (${s.labels.length})</option>
          ${TOPN_OPTIONS.filter(n => n < s.labels.length).map(n =>
            `<option value="${n}"${s.topN === n ? ' selected' : ''}>สูงสุด ${n}</option>`).join('')}
        </select>`
      : '';
    const pctBtn = s && s.parts
      ? btn('data-act="pct" aria-pressed="' + !!s.pct + '"', '%', 'แสดงเป็นสัดส่วน % ของผลรวมที่แสดงอยู่', s.pct)
      : '';
    const isTable = s && s.kind === 'table';
    const hint = s && s.opts.filterKey ? '<span class="chart-hint">คลิกเพื่อกรอง</span>' : '';
    bar.innerHTML = hint + kindBtns + topNSel + pctBtn +
      btn('data-act="reset"', '↺', 'รีเซ็ตกลับค่าเริ่มต้น (แบบกราฟ ลำดับ % การซูม และรายการที่ซ่อนจาก legend)') +
      (document.fullscreenEnabled ? btn('data-act="full"', '⤢', 'ขยายเต็มจอ (กด Esc เพื่อออก)') : '') +
      (isTable ? '' : btn('data-act="png"', 'PNG', 'ดาวน์โหลดกราฟเป็นภาพ PNG')) +
      (exportRows(el).rows.length ? btn('data-act="csv"', 'CSV', 'ดาวน์โหลดข้อมูลของกราฟนี้เป็น CSV') : '');
    bar.hidden = false;
  }

  function onToolClick(e) {
    const b = e.target.closest('button');
    if (!b) return;
    const el = document.getElementById(this.dataset.for);
    if (!el) return;
    if (b.dataset.kind) { setKind(el, b.dataset.kind); return; }
    if (b.dataset.tskind) { setTsKind(el, b.dataset.tskind); return; }
    const act = b.dataset.act;
    if (act === 'reset') resetChart(el);
    else if (act === 'full') toggleFull(el);
    else if (act === 'pct') togglePct(el);
    else if (act === 'png' && el.dataset.plotted) {
      Plotly.downloadImage(el, { format: 'png', scale: 2, filename: fileBase(el) });
    } else if (act === 'csv') {
      const { headers, rows } = exportRows(el);
      U.downloadCSV(fileBase(el) + '.csv', headers, rows);
    }
  }

  function onToolChange(e) {
    const sel = e.target.closest('[data-act="topn"]');
    if (!sel) return;
    const el = document.getElementById(this.dataset.for);
    if (el) setTopN(el, sel.value ? Number(sel.value) : null);
  }

  function setTopN(el, n) {
    const s = el._series;
    if (!s || s.topN === n) return;
    s.topN = n;
    persist(el);
    renderSeries(el);
  }

  function togglePct(el) {
    const s = el._series;
    if (!s) return;
    s.pct = !s.pct;
    persist(el);
    renderSeries(el);
  }

  function setTsKind(el, kind) {
    const ts = el._ts;
    if (!ts || ts.kind === kind) return;
    ts.kind = kind;
    try {
      if (kind === 'line') localStorage.removeItem(KIND_KEY + el.id);
      else localStorage.setItem(KIND_KEY + el.id, kind);
    } catch (e) { /* โหมดส่วนตัว */ }
    drawTimeseries(el.id, ts);
  }

  function resetChart(el) {
    if (el._series) {
      try { localStorage.removeItem(KIND_KEY + el.id); } catch (e) { /* โหมดส่วนตัว */ }
      const s = el._series;
      s.kind = s.natural; s.topN = null; s.pct = false;
      renderSeries(el);
      return;
    }
    if (el._ts) {
      try { localStorage.removeItem(KIND_KEY + el.id); } catch (e) { /* โหมดส่วนตัว */ }
      el._ts.kind = 'line';
      drawTimeseries(el.id, el._ts);
      return;
    }
    if (el._spec && el.dataset.plotted) {
      Plotly.react(el, clone(el._spec.traces), clone(el._spec.layout), CONFIG);
    }
  }

  /** รีเซ็ตกราฟทุกตัวที่มองเห็นอยู่ในขณะนี้ (ใช้กับปุ่ม "รีเซ็ตกราฟในแท็บนี้" ของ app.js) */
  function resetAllVisible(root = document) {
    root.querySelectorAll('.chart-tools:not([hidden])').forEach(bar => {
      const el = document.getElementById(bar.dataset.for);
      if (el && el.offsetParent) resetChart(el);
    });
  }

  function toggleFull(el) {
    const host = el.parentElement;
    if (document.fullscreenElement === host) { document.exitFullscreen(); return; }
    host.classList.add('chart-fs-host');
    const onChange = () => {
      const on = document.fullscreenElement === host;
      el.classList.toggle('chart-full', on);
      if (!on) {
        host.classList.remove('chart-fs-host');
        document.removeEventListener('fullscreenchange', onChange);
      }
      requestAnimationFrame(() => {
        if (el.dataset.plotted) Promise.resolve(Plotly.Plots.resize(el)).catch(() => {});
      });
    };
    document.addEventListener('fullscreenchange', onChange);
    host.requestFullscreen().catch(() => {
      host.classList.remove('chart-fs-host');
      document.removeEventListener('fullscreenchange', onChange);
    });
  }

  function fileBase(el) {
    const card = el.closest('.cardx');
    const title = card?.querySelector('h2, h3')?.textContent.trim() || el.id;
    return title.replace(/[\\/:*?"<>|]/g, '').replace(/\s+/g, '_').slice(0, 60);
  }

  function axisTitle(ax) {
    const t = ax && ax.title;
    return (typeof t === 'string' ? t : t && t.text) || '';
  }

  /** แปลงข้อมูลที่อยู่ในกราฟเป็นแถว CSV — กราฟป้าย+ค่าใช้ข้อมูลต้นทาง (ตามที่กำลังแสดงจริง) กราฟอื่นอ่านจาก trace */
  function exportRows(el) {
    const s = el._series;
    if (s) {
      const { labels, values } = s.view || visibleData(s);
      const head = s.pct ? 'สัดส่วนที่แสดง (%)' : (s.opts.axisTitle || s.opts.centerLabel || 'ค่า');
      const total = values.reduce((a, b) => a + (+b || 0), 0);
      return {
        headers: ['รายการ', head].concat(s.parts && !s.pct ? ['สัดส่วนที่แสดง (%)'] : []),
        rows: labels.map((l, i) => [l, values[i]]
          .concat(s.parts && !s.pct ? [total ? +(values[i] / total * 100).toFixed(2) : ''] : [])),
      };
    }
    const spec = el._spec;
    if (!spec) return { headers: [], rows: [] };
    const rows = [];
    for (const t of spec.traces) {
      const name = t.name || '';
      if (t.type === 'sankey' && t.link) {
        const lab = (t.node && t.node.label) || [];
        (t.link.value || []).forEach((v, i) =>
          rows.push([lab[t.link.source[i]] ?? t.link.source[i], lab[t.link.target[i]] ?? t.link.target[i], v]));
      } else if (t.labels && t.values) {
        t.labels.forEach((l, i) => rows.push([name, l, t.values[i]]));
      } else if (t.r && t.theta) {
        t.r.forEach((r, i) => rows.push([name, t.theta[i], r]));
      } else if (t.type === 'heatmap' && t.z) {
        // แผนที่ความร้อน: y คือชื่อชุดข้อมูล (ไม่ใช่ค่า) ค่าจริงอยู่ใน z — ต้องเช็กก่อนกิ่ง x+y ทั่วไป
        t.z.forEach((row, yi) => row.forEach((v, xi) => rows.push([t.y[yi], t.x[xi], v])));
      } else if (t.x && t.y) {
        t.x.forEach((x, i) => rows.push([name, x, t.y[i]]));
      }
    }
    const isSankey = spec.traces.some(t => t.type === 'sankey');
    const isHeatmap = spec.traces.some(t => t.type === 'heatmap');
    const headers = isSankey ? ['จาก', 'ไป', 'ค่า']
      : isHeatmap ? ['ชุดข้อมูล', 'ช่วงเวลา', 'ค่า']
      : ['ชุดข้อมูล', axisTitle(spec.layout.xaxis) || 'x', axisTitle(spec.layout.yaxis) || 'ค่า'];
    return { headers, rows };
  }

  /* ---------- กราฟแบบป้าย+ค่า ที่สลับแบบได้ (แท่ง / โดนัท / ทรีแมป / ตาราง) ----------
     parts = ค่าทุกตัวเป็นส่วนหนึ่งของผลรวมเดียวกัน (สัญญาหนึ่งอยู่ได้หมวดเดียว)
     เฉพาะแบบนี้จึงเปิดโดนัท/ทรีแมป — จำนวนตามกฎที่สัญญาเดียวติดหลายข้อ ฮิสโทแกรม
     หรืออัตราส่วน ถ้าวาดเป็นโดนัทจะสื่อสัดส่วนที่ไม่มีอยู่จริง */

  function allowedKinds(s) {
    const kinds = ['bar', 'hbar'];
    const nonNeg = s.values.every(v => v == null || v >= 0);
    const total = s.values.reduce((a, b) => a + (+b || 0), 0);
    if (s.parts && nonNeg && total > 0) {
      if (s.natural === 'donut' || s.labels.length <= DONUT_MAX) kinds.push('donut');
      kinds.push('treemap');
    }
    kinds.push('table');
    return kinds;
  }

  /** ตัดเหลือ Top N (เรียงตามค่ามากไปน้อย คงลำดับเดิมของรายการที่เหลือไว้) และ/หรือแปลงเป็น %
   *  ทำเฉพาะกราฟ parts — ฮิสโทแกรมหรือกราฟที่ลำดับแกนมีความหมาย (เช่นช่วงราคา) จะไม่ถูกเรียงใหม่ */
  function visibleData(s) {
    let labels = s.labels, values = s.values, filterValues = s.opts.filterValues || null;
    // colors เป็นสีต่อแท่ง (array เท่าจำนวน labels เดิม) ต้องตัดตามดัชนีเดียวกับ Top N
    // ไม่เช่นนั้นสีจะเลื่อนไปคนละแท่งเมื่อตัดรายการออก
    let colors = Array.isArray(s.opts.colors) ? s.opts.colors : null;
    if (s.parts && s.topN && s.topN < labels.length) {
      const idx = values.map((v, i) => i).sort((a, b) => (+values[b] || 0) - (+values[a] || 0)).slice(0, s.topN);
      idx.sort((a, b) => a - b);
      labels = idx.map(i => labels[i]);
      values = idx.map(i => values[i]);
      if (filterValues) filterValues = idx.map(i => filterValues[i]);
      if (colors) colors = idx.map(i => colors[i]);
    }
    if (s.parts && s.pct) {
      const total = values.reduce((a, b) => a + (+b || 0), 0);
      values = values.map(v => total ? +((+v || 0) / total * 100).toFixed(2) : 0);
    }
    return { labels, values, filterValues, colors };
  }

  function series(id, s) {
    const el = U.$(id);
    if (!el) return;
    el._series = s;
    const saved = loadUiState(id);
    s.kind = saved.kind && allowedKinds(s).includes(saved.kind) ? saved.kind : s.natural;
    s.topN = s.parts && saved.topN && saved.topN < s.labels.length ? saved.topN : null;
    s.pct = !!(s.parts && saved.pct);
    renderSeries(el);
  }

  function setKind(el, kind) {
    const s = el._series;
    if (!s || s.kind === kind) return;
    s.kind = kind;
    persist(el);
    renderSeries(el);
  }

  function renderSeries(el) {
    const s = el._series;
    s.view = visibleData(s);
    el.classList.toggle('chart-as-table', s.kind === 'table');
    if (s.kind === 'table') {
      if (el.dataset.plotted) { Plotly.purge(el); delete el.dataset.plotted; }
      el._spec = null;
      el.innerHTML = seriesTable(s);
      if (s.view.labels.length) renderTools(el); else hideTools(el);
      return;
    }
    if (s.kind === 'donut') drawDonut(el.id, s);
    else if (s.kind === 'treemap') drawTreemap(el.id, s);
    else drawBar(el.id, s, s.kind === 'hbar');
    wireSeriesClick(el, s);
  }

  /** คลิกแท่ง/ชิ้นโดนัท/กล่องทรีแมป ที่มี opts.filterKey ไว้ → ตั้งตัวกรองส่วนกลางผ่าน wireFilterClick
   *  ดัชนีอ้างอิงจาก s.view (หลังตัด Top N แล้ว) ไม่ใช่ s.labels ดิบ */
  function wireSeriesClick(el, s) {
    if (!el.dataset.plotted || typeof el.on !== 'function') return;
    if (el.removeAllListeners) el.removeAllListeners('plotly_click');
    const key = s.opts.filterKey, vals = s.view.filterValues;
    if (!key || !vals || !filterHook) return;
    el.on('plotly_click', ev => {
      const pt = ev.points && ev.points[0];
      if (!pt) return;
      let idx;
      if (s.kind === 'treemap') {
        if (!pt.id || pt.id === '__all') return;
        idx = Number(pt.id.slice(1));
      } else {
        idx = pt.pointIndex ?? pt.pointNumber ?? pt.i;
      }
      if (typeof idx === 'number' && vals[idx] != null) filterHook(key, vals[idx]);
    });
  }

  function seriesTable(s) {
    const { labels } = s.view;
    if (!labels.length) return U.emptyState('ไม่มีข้อมูลสำหรับกราฟนี้');
    const { headers, rows } = exportRows({ _series: s });
    const fmt = v => v == null || v === '' ? '–'
      : typeof v === 'number' ? v.toLocaleString('th-TH', { maximumFractionDigits: 2 }) : U.esc(v);
    return `<div class="table-wrap"><table class="table table-sm mini-table mb-0">
      <thead><tr>${headers.map((h, i) => `<th scope="col"${i ? ' class="text-end"' : ''}>${U.esc(h)}</th>`).join('')}</tr></thead>
      <tbody>${rows.map(r => `<tr>${r.map((v, i) =>
        `<td${i ? ' class="text-end"' : ''}>${fmt(v)}</td>`).join('')}</tr>`).join('')}</tbody></table></div>`;
  }

  /** เรียกเมื่อแท็บถูกเปิด — กราฟที่วาดตอนแท็บซ่อนอยู่จะมีความกว้าง 0 */
  function resizeIn(container) {
    if (!container) return;
    container.querySelectorAll('[data-plotted]').forEach(el => {
      // Plotly ปฏิเสธคำสั่ง resize ถ้ากราฟยังไม่ถูกแสดง (การ์ดที่พับอยู่ แท็บที่ยังไม่เปิด)
      // และคืนค่าเป็น Promise ที่ reject ซึ่ง try/catch ธรรมดาจับไม่ได้
      // จึงต้องเช็กขนาดก่อน แล้วรับ rejection ที่ยังหลุดมาได้ด้วย .catch()
      if (!el.offsetWidth || !el.offsetHeight) return;
      try { Promise.resolve(Plotly.Plots.resize(el)).catch(() => {}); }
      catch (e) { /* กราฟยังไม่พร้อม */ }
    });
  }

  /* ---------- รูปแบบกราฟที่ใช้ซ้ำ ---------- */

  /** parts: true เมื่อค่าทุกแท่งรวมกันเป็นผลรวมเดียว (เปิดให้สลับเป็นโดนัท/ทรีแมปและ Top N/% ได้)
   *  filterKey/filterValues (ใน opts): คลิกแท่งแล้วตั้งตัวกรองส่วนกลาง — filterValues ต้องยาวเท่า labels */
  function bar(id, labels, values, opts = {}) {
    series(id, { labels, values, opts, natural: opts.horizontal ? 'hbar' : 'bar', parts: !!opts.parts });
  }

  function donut(id, labels, values, colors, centerLabel, opts = {}) {
    series(id, {
      labels, values,
      opts: { colors: colors || null, centerLabel, filterKey: opts.filterKey, filterValues: opts.filterValues },
      natural: 'donut', parts: true,
    });
  }

  function partColors(s) {
    return Array.isArray(s.opts.colors) ? s.opts.colors : CATEGORICAL;
  }

  function drawBar(id, s, horizontal) {
    const { title, color, axisTitle: axisTitleOpt, refLines } = s.opts;
    const { labels, values, colors } = s.view;
    // รูปแบบ hover เขียนอ้างแกนของแนวเดิม (%{x} ของแท่งนอน) ต้องสลับแกนตามเมื่อหมุนกราฟ
    let valueFormat = s.pct ? null : s.opts.valueFormat;
    if (valueFormat && horizontal !== (s.natural === 'hbar')) {
      valueFormat = valueFormat.replace(/%\{([xy])/g, (_, a) => '%{' + (a === 'x' ? 'y' : 'x'));
    }
    if (s.pct) valueFormat = '%{' + (horizontal ? 'x' : 'y') + ':.1f}%';
    const axisTitleText = s.pct ? ((axisTitleOpt ? axisTitleOpt + ' ' : '') + '(%)') : axisTitleOpt;
    const marker = { color: colors || color || C.teal };
    const trace = horizontal
      ? { type: 'bar', orientation: 'h', y: labels, x: values, marker }
      : { type: 'bar', x: labels, y: values, marker };
    trace.hovertemplate = '%{' + (horizontal ? 'y' : 'x') + '}<br>' +
      (valueFormat || '%{' + (horizontal ? 'x' : 'y') + ':,.0f}') + '<extra></extra>';
    // เส้นอ้างอิงช่วยให้อ่านค่าได้โดยไม่ต้องกวาดสายตาไปที่แกน
    const shapes = (refLines || []).map(r => ({
      type: 'line', xref: horizontal ? 'x' : 'paper', yref: horizontal ? 'paper' : 'y',
      x0: horizontal ? r.value : 0, x1: horizontal ? r.value : 1,
      y0: horizontal ? 0 : r.value, y1: horizontal ? 1 : r.value,
      line: { color: r.color || '#94a3b8', width: 1.5, dash: 'dash' },
    }));
    const annotations = (refLines || []).filter(r => r.label).map(r => ({
      text: r.label, showarrow: false,
      xref: horizontal ? 'x' : 'paper', yref: horizontal ? 'paper' : 'y',
      x: horizontal ? r.value : 1, y: horizontal ? 1 : r.value,
      xanchor: horizontal ? 'left' : 'right', yanchor: 'bottom',
      font: { size: 10, color: r.color || '#94a3b8' },
    }));
    draw(id, [trace], {
      title: title ? { text: title, font: { size: 12 } } : undefined,
      // 220px เผื่อป้ายยาวของกราฟที่ออกแบบเป็นแท่งนอนอยู่แล้ว ส่วนกราฟที่ผู้ใช้หมุนมาจากแบบอื่น
      // มักอยู่ในการ์ดแคบ ให้ automargin ขยายเท่าป้ายจริงแทน ไม่เช่นนั้นแท่งจะถูกบีบจนอ่านไม่ได้
      margin: horizontal ? { t: title ? 34 : 12, l: s.natural === 'hbar' ? 220 : 20, r: 24, b: 40 } : { t: title ? 34 : 12, l: 66, r: 20, b: 70 },
      xaxis: horizontal ? { title: axisTitleText, gridcolor: T().grid } : { automargin: true, gridcolor: T().grid },
      yaxis: horizontal ? { automargin: true, autorange: 'reversed' } : { title: axisTitleText, gridcolor: T().grid },
      shapes, annotations,
    });
  }

  /** โดนัทพร้อมยอดรวมกลางวง
   *  ของเดิมพิมพ์เปอร์เซ็นต์บนทุกชิ้น ซึ่งทับกันเมื่อหลายชิ้นมีสัดส่วนใกล้เคียงกัน
   *  จึงแสดงเฉพาะชิ้นที่ตั้งแต่ 5% ขึ้นไป ส่วนที่เหลืออ่านได้จาก legend และ hover */
  function drawDonut(id, s) {
    const { labels, values } = s.view;
    const centerLabel = s.pct ? 'สัดส่วน %' : (s.opts.centerLabel || s.opts.axisTitle);
    const total = values.reduce((a, b) => a + (+b || 0), 0);
    // ค่าที่วาดเป็น % อยู่แล้วเมื่อ s.pct — พาย normalize ตามสัดส่วนเสมออยู่แล้วจึงได้รูปร่างเดิม
    // ต่างกันแค่ป้าย/hover ที่อ่านเป็น % ตรงๆ แทนจำนวนดิบ
    const pcts = values.map(v => total ? v / total : 0);
    draw(id, [{
      type: 'pie', hole: 0.62, labels, values,
      marker: { colors: partColors(s), line: { color: T().surface, width: 2 } },
      text: pcts.map(p => p >= 0.05 ? (p * 100).toFixed(0) + '%' : ''),
      textinfo: 'text', textposition: 'inside', insidetextorientation: 'horizontal',
      textfont: { size: 12, color: '#fff' },
      sort: false,
      hovertemplate: s.pct ? '%{label}<br>%{value:.1f}%<extra></extra>' : '%{label}<br>%{value:,.0f} (%{percent})<extra></extra>',
    }], {
      margin: { t: 12, l: 12, r: 12, b: 12 },
      showlegend: true,
      legend: { orientation: 'h', y: -0.08, font: { size: 11 } },
      annotations: [{
        text: s.pct ? '<b>100%</b>' : (`<b>${total.toLocaleString('th-TH')}</b>` + (centerLabel ? `<br><span style="font-size:11px">${centerLabel}</span>` : '')),
        showarrow: false, font: { size: 17, color: T().ink }, x: 0.5, y: 0.5,
      }],
    });
  }

  function drawTreemap(id, s) {
    const { labels, values } = s.view;
    const cols = partColors(s);
    const colors = labels.map((_, i) => cols[i % cols.length]);
    // ใช้ id แยกจากป้าย กันป้ายซ้ำกัน และมีโหนดรากชัดเจนเพื่อให้ % เทียบกับทั้งหมด
    draw(id, [{
      type: 'treemap', branchvalues: 'total',
      ids: ['__all'].concat(labels.map((_, i) => 'n' + i)),
      labels: ['ทั้งหมด'].concat(labels),
      parents: [''].concat(labels.map(() => '__all')),
      values: [values.reduce((a, b) => a + (+b || 0), 0)].concat(values),
      marker: { colors: ['rgba(0,0,0,0)'].concat(colors), line: { color: T().surface, width: 2 } },
      textfont: { color: [T().dim].concat(colors.map(inkOn)) },
      textinfo: 'label+value+percent root',
      hovertemplate: s.pct ? '%{label}<br>%{value:.1f}%<extra></extra>' : '%{label}<br>%{value:,.0f} (%{percentRoot:.1%})<extra></extra>',
      pathbar: { visible: false },
    }], { margin: { t: 6, l: 6, r: 6, b: 6 } });
  }

  function sankey(id, edges, { nodeColorFn, height } = {}) {
    if (!edges.length) { draw(id, [], {}, 'ไม่มีเส้นเชื่อมตามเงื่อนไขที่เลือก'); return; }
    const sources = new Set(edges.map(e => e.source));
    const nodes = [...new Set(edges.flatMap(e => [e.source, e.target]))];
    const index = new Map(nodes.map((n, i) => [n, i]));
    draw(id, [{
      type: 'sankey', orientation: 'h',
      node: {
        label: nodes, pad: 11, thickness: 13,
        line: { color: T().surface, width: 0.5 },
        color: nodes.map(n => nodeColorFn
          ? nodeColorFn(n, sources.has(n) ? 'agency' : 'contractor')
          : (sources.has(n) ? C.teal : C.orange)),
        hovertemplate: '%{label}<br>รวม %{value:,.0f} บาท<extra></extra>',
      },
      link: {
        source: edges.map(e => index.get(e.source)),
        target: edges.map(e => index.get(e.target)),
        value: edges.map(e => Math.max(e.value, 1)),
        color: 'rgba(15,118,110,0.20)',
        customdata: edges.map(e => [e.n, e.value]),
        hovertemplate: '%{source.label} → %{target.label}<br>' +
          '%{customdata[0]} สัญญา · %{customdata[1]:,.0f} บาท<extra></extra>',
      },
    }], { font: { size: 10, family: FONT.family, color: T().ink }, margin: { t: 10, l: 10, r: 10, b: 10 }, height });
  }

  function scatter(id, points, { xTitle, yTitle, colorTitle } = {}) {
    draw(id, [{
      type: 'scatter', mode: 'markers',
      x: points.map(p => p.x), y: points.map(p => p.y),
      text: points.map(p => p.label),
      marker: {
        size: points.map(p => p.size ?? 9),
        color: points.map(p => p.color ?? 0),
        colorscale: 'YlOrRd', showscale: !!colorTitle,
        colorbar: colorTitle ? { title: { text: colorTitle, font: { size: 10 } }, thickness: 12 } : undefined,
        line: { width: 0.5, color: 'rgba(0,0,0,0.15)' },
      },
      hovertemplate: '%{text}<extra></extra>',
    }], {
      xaxis: { title: xTitle, gridcolor: T().grid },
      yaxis: { title: yTitle, gridcolor: T().grid },
      margin: { t: 16, l: 70, r: 20, b: 55 },
    });
  }

  function lines(id, xLabels, series, { yTitle, mode = 'lines+markers' } = {}) {
    draw(id, series.map((s, i) => ({
      type: 'scatter', mode, name: s.name, x: xLabels, y: s.y,
      line: { color: CATEGORICAL[i % CATEGORICAL.length], width: 2.5, shape: 'spline', smoothing: 0.4 },
      marker: { size: 5 },
      hovertemplate: '%{fullData.name}<br>%{x}: %{y:,.0f}<extra></extra>',
    })), {
      yaxis: { title: yTitle, gridcolor: T().grid },
      xaxis: { gridcolor: T().grid },
      margin: { t: 16, l: 70, r: 20, b: 50 },
      legend: { orientation: 'h', y: -0.16, font: { size: 10 } },
      hovermode: 'x unified',
    });
  }

  /** เส้นแนวโน้มหลายชุดที่สลับแบบได้ (เส้น / แท่งซ้อน / พื้นที่ซ้อน / แผนที่ความร้อน) — ใช้กับแท็บแนวโน้มเวลา
   *  series = [{ name, y:[ตามลำดับ xLabels] }] · ต่างจาก lines() ตรงที่จำแบบกราฟที่เลือกไว้และมีแถบเครื่องมือ */
  function timeseries(id, xLabels, series, opts = {}) {
    const el = U.$(id);
    if (!el) return;
    let saved = null;
    try { saved = localStorage.getItem(KIND_KEY + id); } catch (e) { /* โหมดส่วนตัว */ }
    const kind = saved && TS_KINDS[saved] ? saved : 'line';
    el._series = null;
    el._ts = { xLabels, series, opts, kind };
    drawTimeseries(id, el._ts);
  }

  function drawTimeseries(id, ts) {
    const { xLabels, series, opts, kind } = ts;
    if (kind === 'heatmap') {
      draw(id, [{
        type: 'heatmap', x: xLabels, y: series.map(s => s.name), z: series.map(s => s.y),
        colorscale: 'Teal', hoverongaps: false,
        hovertemplate: '%{y}<br>%{x}: %{z:,.0f}<extra></extra>',
      }], {
        margin: { t: 16, l: 150, r: 20, b: 50 },
        xaxis: { gridcolor: T().grid },
        yaxis: { gridcolor: T().grid, automargin: true },
      }, 'ไม่มีข้อมูลสำหรับกราฟนี้');
      return;
    }
    const traces = series.map((s, i) => {
      const color = CATEGORICAL[i % CATEGORICAL.length];
      const hovertemplate = '%{fullData.name}<br>%{x}: %{y:,.0f}<extra></extra>';
      if (kind === 'stackbar') {
        return { type: 'bar', name: s.name, x: xLabels, y: s.y, marker: { color }, hovertemplate };
      }
      if (kind === 'area') {
        // stackgroup ทำให้พื้นที่ซ้อนทับกันสะสม เส้นบางเพราะพื้นที่สีเป็นตัวสื่อสารหลักอยู่แล้ว
        return { type: 'scatter', mode: 'lines', name: s.name, x: xLabels, y: s.y,
          stackgroup: 'one', line: { color, width: 1 }, hovertemplate };
      }
      return { type: 'scatter', mode: 'lines+markers', name: s.name, x: xLabels, y: s.y,
        line: { color, width: 2.5, shape: 'spline', smoothing: 0.4 }, marker: { size: 5 }, hovertemplate };
    });
    draw(id, traces, {
      yaxis: { title: opts.yTitle, gridcolor: T().grid },
      xaxis: { gridcolor: T().grid },
      margin: { t: 16, l: 70, r: 20, b: 50 },
      legend: { orientation: 'h', y: -0.16, font: { size: 10 } },
      hovermode: 'x unified',
      barmode: kind === 'stackbar' ? 'stack' : undefined,
    });
  }

  function waterfall(id, labels, values, title) {
    draw(id, [{
      type: 'waterfall', x: labels, y: values,
      connector: { line: { color: C.grey } },
      increasing: { marker: { color: C.orange } },
      totals: { marker: { color: C.teal } },
      hovertemplate: '%{x}: +%{y}<extra></extra>',
    }], {
      title: title ? { text: title, font: { size: 11 } } : undefined,
      margin: { t: title ? 40 : 16, l: 44, r: 16, b: 40 },
      yaxis: { title: 'น้ำหนักคะแนน', gridcolor: T().grid },
    }, 'ไม่พบสัญญาณความเสี่ยงในรายการนี้');
  }

  function radar(id, categories, values) {
    draw(id, [{
      type: 'scatterpolar', r: [...values, values[0]], theta: [...categories, categories[0]],
      fill: 'toself', fillcolor: 'rgba(234,88,12,0.18)',
      line: { color: C.orange, width: 2 },
      hovertemplate: '%{theta}: %{r:.1f}<extra></extra>',
    }], {
      polar: { radialaxis: { visible: true, range: [0, 100], gridcolor: T().line }, angularaxis: { gridcolor: T().line } },
      showlegend: false, margin: { t: 30, l: 50, r: 50, b: 30 },
    });
  }

  /** เรดาร์ซ้อนสองชุด ใช้เปรียบเทียบสองรายการบนแกนเดียวกันโดยตรง
   *  series = [{ name, values, color }] ยาวได้มากกว่า 2 แต่ออกแบบไว้สำหรับคู่เทียบ */
  function radarCompare(id, categories, series) {
    const closed = [...categories, categories[0]];
    draw(id, series.map(s => ({
      type: 'scatterpolar',
      r: [...s.values, s.values[0]], theta: closed,
      name: s.name,
      fill: 'toself', fillcolor: s.color + '2e',   // เติมความโปร่งใสท้าย hex ให้พื้นที่จางกว่าเส้น
      line: { color: s.color, width: 2 },
      hovertemplate: `${s.name}<br>%{theta}: %{r:.1f}<extra></extra>`,
    })), {
      polar: { radialaxis: { visible: true, range: [0, 100], gridcolor: T().line }, angularaxis: { gridcolor: T().line } },
      showlegend: true, legend: { orientation: 'h', y: -0.12, font: { size: 10.5 } },
      margin: { t: 24, l: 50, r: 50, b: 40 },
    });
  }

  function treemap(id, edges) {
    if (!edges.length) { draw(id, [], {}, 'ไม่มีข้อมูลตามเงื่อนไขที่เลือก'); return; }
    const agencies = [...new Set(edges.map(e => e.source))];
    const labels = [...agencies], parents = agencies.map(() => ''), values = agencies.map(() => 0);
    for (const e of edges) {
      labels.push(e.source + ' | ' + e.target);
      parents.push(e.source);
      values.push(e.value);
    }
    draw(id, [{
      type: 'treemap', labels, parents, values, branchvalues: 'remainder',
      marker: { colorscale: 'Teal' },
      hovertemplate: '%{label}<br>%{value:,.0f} บาท<extra></extra>',
      textinfo: 'label+value',
    }], { margin: { t: 10, l: 10, r: 10, b: 10 } });
  }

  /* ---------- กราฟชุดหน้าภาพรวม ---------- */

  /** ป้ายแกนมูลค่าแบบไทย ใช้กับแกน log (ค่าดิบ 1e6 อ่านยากกว่า "1 ล้าน") */
  const MONEY_TICKS = [
    [1e4, '1 หมื่น'], [1e5, '1 แสน'], [1e6, '1 ล้าน'], [1e7, '10 ล้าน'],
    [1e8, '100 ล้าน'], [1e9, '1 พันล้าน'], [1e10, '10 พันล้าน'],
  ];

  /** จุดกระจาย มูลค่า × คะแนนความเสี่ยง — หนึ่งจุดคือหนึ่งสัญญา
   *  groups = [{ name, color, points:[{x, y, label, id}] }] เรียงจากที่ต้องการวาดก่อน (ใต้สุด) ไปหลังสุด
   *  ring   = { name, points } วงกลมกลวงครอบจุดที่ติดคิวตรวจสอบ
   *  xRef/yRef = { value, label } เส้นอ้างอิง วาดเป็น trace ไม่ใช่ shape เพราะ shape บนแกน log
   *  ตีความพิกัดไม่ตรงกันในแต่ละเวอร์ชัน แต่ trace ใช้ค่าจริงเสมอ
   *  สัญญาที่ไม่มีมูลค่า (≤0) วาดบนแกน log ไม่ได้ ผู้เรียกต้องกรองออกและแจ้งจำนวนเอง */
  function riskValue(id, groups, { ring, xRef, yRef } = {}) {
    const all = groups.flatMap(g => g.points);
    // ไม่มีจุดเลยต้องจบตรงนี้ ไม่เช่นนั้น Math.min/max ของอาเรย์ว่างได้ ±Infinity
    // และเส้นอ้างอิงยังทำให้ draw() เห็นว่า "มีข้อมูล" จึงวาดกราฟเปล่าพิสดารแทนข้อความว่าง
    if (!all.length) { draw(id, [], {}, 'ไม่มีสัญญาที่มีมูลค่าตามเงื่อนไขนี้'); return; }
    const gl = all.length > 3000;   // SVG หนักเมื่อจุดเกินสองสามพัน สลับเป็น WebGL
    const type = gl ? 'scattergl' : 'scatter';
    const xs = all.map(p => p.x), ys = all.map(p => p.y);
    const xMin = Math.min(...xs), xMax = Math.max(...xs), yMax = Math.max(1, ...ys);

    const traces = groups.filter(g => g.points.length).map(g => ({
      type, mode: 'markers', name: g.name,
      x: g.points.map(p => p.x), y: g.points.map(p => p.y),
      customdata: g.points.map(p => p.id), text: g.points.map(p => p.label),
      marker: { color: g.color, size: 7, opacity: 0.78, line: { width: 0 } },
      hovertemplate: '%{text}<extra>' + g.name + '</extra>',
    }));
    if (ring && ring.points.length) {
      traces.push({
        type, mode: 'markers', name: ring.name,
        x: ring.points.map(p => p.x), y: ring.points.map(p => p.y),
        customdata: ring.points.map(p => p.id), text: ring.points.map(p => p.label),
        marker: { symbol: 'circle-open', size: 16, color: T().ink, line: { color: T().ink, width: 2 } },
        hovertemplate: '%{text}<extra>' + ring.name + '</extra>',
      });
    }
    const refStyle = { color: T().dim, width: 1.2, dash: 'dot' };
    if (xRef && xRef.value >= xMin && xRef.value <= xMax * 1.5) {
      // ป้ายอยู่ "ใต้" จุดบนสุดของเส้น (bottom left) — ถ้าอยู่เหนือจุดจะทะลุขอบบนของกราฟแล้วถูกตัด
      traces.push({ type: 'scatter', mode: 'lines+text', x: [xRef.value, xRef.value], y: [0, yMax * 1.07],
        text: ['', xRef.label], textposition: 'bottom left', textfont: { size: 10, color: T().dim },
        line: refStyle, showlegend: false, hoverinfo: 'skip' });
    }
    if (yRef) {
      traces.push({ type: 'scatter', mode: 'lines+text', x: [xMin / 1.4, xMax * 1.4], y: [yRef.value, yRef.value],
        text: [yRef.label, ''], textposition: 'top right', textfont: { size: 10, color: T().dim },
        line: refStyle, showlegend: false, hoverinfo: 'skip' });
    }

    const ticks = MONEY_TICKS.filter(([v]) => v >= xMin / 3 && v <= xMax * 3);
    draw(id, traces, {
      margin: { t: 12, l: 48, r: 16, b: 78 },
      hovermode: 'closest',
      xaxis: {
        type: 'log', title: { text: 'มูลค่าสัญญา (บาท)', font: { size: 11 } }, gridcolor: T().grid,
        tickvals: ticks.map(t => t[0]), ticktext: ticks.map(t => t[1]),
        range: [Math.log10(xMin / 1.6), Math.log10(xMax * 1.6)],
      },
      yaxis: { title: { text: 'คะแนนความเสี่ยง', font: { size: 11 } }, gridcolor: T().grid, range: [-yMax * 0.04, yMax * 1.1] },
      legend: { orientation: 'h', y: -0.3, font: { size: 10.5 } },
      dragmode: 'lasso',
      // เปิดปุ่มลากเลือกเฉพาะกราฟนี้ (ของเดิมปิดทุกกราฟไว้เพราะกราฟส่วนใหญ่เลือกจุดแล้วไม่มีผลอะไร)
      // ผู้เรียก (app.js) ผูก plotly_selected ไว้ต่างหากเพื่อใส่ตะกร้าทีละกลุ่ม
    }, undefined, { modeBarButtonsToRemove: ['autoScale2d'] });
  }

  /** เส้นครอบคลุมมูลค่าของคิว (ดู Analytics.queueCoverage)
   *  cov = { maxN, exposure[], score[], value[] } · mode = โหมดที่ผู้ใช้เลือกอยู่ · n = จำนวนเรื่องที่แสดง */
  function coverage(id, cov, { mode = 'exposure', n = 5 } = {}) {
    const xs = Array.from({ length: cov.maxN + 1 }, (_, i) => i);
    const defs = [
      { key: 'exposure', name: 'คะแนน × มูลค่า', color: C.teal, dash: 'solid', width: 3 },
      { key: 'score', name: 'คะแนนอย่างเดียว', color: C.orange, dash: 'dash', width: 2 },
      { key: 'value', name: 'มูลค่าอย่างเดียว (เพดาน)', color: C.grey, dash: 'dot', width: 2 },
    ];
    const traces = defs.map(d => ({
      type: 'scatter', mode: 'lines', name: d.name, x: xs, y: cov[d.key],
      line: { color: d.color, width: d.width, dash: d.dash },
      hovertemplate: '%{fullData.name}<br>ตรวจ %{x} เรื่อง ครอบคลุม %{y:.1%}<extra></extra>',
    }));
    const k = Math.min(n, cov.maxN), cur = defs.find(d => d.key === mode) || defs[0];
    if (k > 0) {
      traces.push({
        type: 'scatter', mode: 'markers+text', showlegend: false, x: [k], y: [cov[cur.key][k]],
        // ป้ายอยู่ใต้ขวาของจุด: เส้นสะสมชันขึ้นทางซ้ายบน ด้านนั้นว่างเสมอ ส่วน top left จะชนแกนตั้งเมื่อ k เล็ก
        text: [(cov[cur.key][k] * 100).toFixed(1) + '%'], textposition: 'bottom right',
        textfont: { size: 11, color: T().ink },
        marker: { size: 10, color: cur.color, line: { color: T().surface, width: 2 } },
        hovertemplate: `ตรวจ ${k} เรื่อง (ที่เลือกอยู่) ครอบคลุม %{y:.1%}<extra></extra>`,
      });
    }
    draw(id, traces, {
      margin: { t: 12, l: 50, r: 16, b: 78 },
      hovermode: 'x unified',
      xaxis: { title: { text: 'จำนวนสัญญาที่ตรวจ (เรียงตามลำดับที่เลือก)', font: { size: 11 } }, gridcolor: T().grid, range: [0, cov.maxN] },
      yaxis: { title: { text: 'สัดส่วนมูลค่ารวมที่ครอบคลุม', font: { size: 11 } }, gridcolor: T().grid, tickformat: '.0%', rangemode: 'tozero' },
      legend: { orientation: 'h', y: -0.3, font: { size: 10.5 } },
    });
  }

  /** ตัวอักษรขาวหรือดำ ตามความสว่างของพื้น — พื้นเทาอ่อนของ "ไม่พบสัญญาณ" อ่านตัวขาวไม่ออก */
  function inkOn(hex) {
    const m = /^#?([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(hex || '');
    if (!m) return T().ink;
    const [r, g, b] = [1, 2, 3].map(i => parseInt(m[i], 16) / 255)
      .map(c => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4));
    return 0.2126 * r + 0.7152 * g + 0.0722 * b > 0.4 ? '#132420' : '#ffffff';
  }

  /** ทรีแมปแบบลำดับชั้น (ids/parents ชัดเจน เพราะชื่อชั้นล่างซ้ำกันข้ามชั้นบนได้ เช่น "วิกฤต" ในทุกวิธีจัดหา)
   *  nodes = [{ id, parent, label, value, color }] — โหนดแม่ให้ value = 0 ระบบรวมจากลูกเอง (branchvalues 'remainder') */
  function treemapTree(id, nodes, { valueLabel = 'บาท' } = {}) {
    const rows = nodes.filter(n => n.value > 0 || nodes.some(c => c.parent === n.id));
    draw(id, [{
      type: 'treemap', branchvalues: 'remainder',
      ids: rows.map(n => n.id), labels: rows.map(n => n.label), parents: rows.map(n => n.parent || ''),
      values: rows.map(n => n.value),
      marker: { colors: rows.map(n => n.color || T().line), line: { color: T().surface, width: 2 } },
      textfont: { color: rows.map(n => (n.color ? inkOn(n.color) : T().ink)), size: 12 },
      textinfo: 'label+percent root', textposition: 'top left',
      pathbar: { visible: false }, tiling: { pad: 3 },
      hovertemplate: '%{label}<br>%{value:,.0f} ' + valueLabel + ' (%{percentRoot:.1%} ของทั้งหมด)<extra></extra>',
    }], { margin: { t: 6, l: 6, r: 6, b: 6 } });
  }

  return { C, CATEGORICAL, draw, resizeIn, bar, donut, sankey, scatter, lines, timeseries, waterfall, radar, radarCompare, treemap, riskValue, coverage, treemapTree, CONFIG, baseLayout, refreshTheme, wireFilterClick, resetAllVisible };
})();
