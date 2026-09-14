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
    }, extra);
  }

  /** วาดกราฟ; ถ้าไม่มีข้อมูลให้แสดงข้อความแทนที่จะปล่อยพื้นที่ว่าง
   *  (ของเดิมกราฟว่างแยกไม่ออกจาก widget ที่พัง) */
  function draw(id, traces, layout = {}, emptyMessage = 'ไม่มีข้อมูลสำหรับกราฟนี้') {
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
      return;
    }
    if (!el.dataset.plotted) el.innerHTML = '';
    Plotly.react(el, traces, baseLayout(layout), CONFIG);
    el.dataset.plotted = '1';
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

  function bar(id, labels, values, { title, color, horizontal = false, valueFormat, colors, axisTitle, refLines } = {}) {
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
      margin: horizontal ? { t: title ? 34 : 12, l: 220, r: 24, b: 40 } : { t: title ? 34 : 12, l: 66, r: 20, b: 70 },
      xaxis: horizontal ? { title: axisTitle, gridcolor: T().grid } : { automargin: true, gridcolor: T().grid },
      yaxis: horizontal ? { automargin: true, autorange: 'reversed' } : { title: axisTitle, gridcolor: T().grid },
      shapes, annotations,
    });
  }

  /** โดนัทพร้อมยอดรวมกลางวง
   *  ของเดิมพิมพ์เปอร์เซ็นต์บนทุกชิ้น ซึ่งทับกันเมื่อหลายชิ้นมีสัดส่วนใกล้เคียงกัน
   *  จึงแสดงเฉพาะชิ้นที่ตั้งแต่ 5% ขึ้นไป ส่วนที่เหลืออ่านได้จาก legend และ hover */
  function donut(id, labels, values, colors, centerLabel) {
    const total = values.reduce((a, b) => a + (b || 0), 0);
    const pcts = values.map(v => total ? v / total : 0);
    draw(id, [{
      type: 'pie', hole: 0.62, labels, values,
      marker: { colors: colors || CATEGORICAL, line: { color: T().surface, width: 2 } },
      text: pcts.map(p => p >= 0.05 ? (p * 100).toFixed(0) + '%' : ''),
      textinfo: 'text', textposition: 'inside', insidetextorientation: 'horizontal',
      textfont: { size: 12, color: '#fff' },
      sort: false,
      hovertemplate: '%{label}<br>%{value:,.0f} (%{percent})<extra></extra>',
    }], {
      margin: { t: 12, l: 12, r: 12, b: 12 },
      showlegend: true,
      legend: { orientation: 'h', y: -0.08, font: { size: 11 } },
      annotations: [{
        text: `<b>${total.toLocaleString('th-TH')}</b>` + (centerLabel ? `<br><span style="font-size:11px">${centerLabel}</span>` : ''),
        showarrow: false, font: { size: 17, color: T().ink }, x: 0.5, y: 0.5,
      }],
    });
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

  return { C, CATEGORICAL, draw, resizeIn, bar, donut, sankey, scatter, lines, waterfall, radar, radarCompare, treemap, CONFIG, baseLayout, refreshTheme };
})();
