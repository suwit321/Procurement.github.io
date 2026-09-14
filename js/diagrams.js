/* diagrams.js — ไดอะแกรมอธิบายรูปแบบของกฎที่เน้นความสัมพันธ์/โครงสร้าง

   กฎที่เป็นสูตรคณิตศาสตร์ล้วน (R1, R2, R4, R8, R9, R14, R16) อ่านจาก codebox ที่มีอยู่แล้วเพียงพอ
   แต่กฎที่เป็น "รูปแบบความสัมพันธ์" (แบ่งซื้อ, TIN ไม่ตรง, คู่ซ้ำ, หน้าผาราคา ฯลฯ) อธิบายด้วยภาพ
   เข้าใจเร็วกว่าสูตรมาก โมดูลนี้จึงมีเฉพาะกฎกลุ่มหลัง ไม่ครบทั้ง 17 ข้อโดยตั้งใจ
*/
'use strict';

const Diagrams = (() => {

  /* ค่าตั้งต้นคือชุดสว่าง ใช้เมื่ออ่านโทเค็น CSS ไม่ได้ (เช่นตอนทดสอบนอกเบราว์เซอร์)
     syncColors() จะเขียนทับด้วยค่าจริงของธีมปัจจุบันก่อนวาดทุกครั้ง
     ถ้าไม่ทำ ไดอะแกรมจะเป็นกล่องขาวตัวอักษรเข้มค้างอยู่แม้ผู้ใช้เปิดโหมดมืด */
  const COLOR = {
    agency: '#0B4F45', contractor: '#EA580C', danger: '#B42318',
    warning: '#C2680B', primary: '#0E7C66', muted: '#93A7A1', text: '#132420',
    surface: '#FFFFFF', line: '#C9D8D3',
    dangerBg: '#FDF0EE', warnBg: '#FDF4E7', tealBg: '#E3F3EE',
    director: '#5B4BB8', address: '#0E7490', subcontractor: '#C2680B',
  };

  /** อ่านสีจากโทเค็น CSS ของธีมที่เปิดอยู่
   *  เรียกก่อนวาดทุกครั้ง เพราะ svg() ถูกประกอบเป็นสตริงตอนวาด ไม่ได้แคชไว้ */
  function syncColors() {
    if (typeof getComputedStyle !== 'function') return;
    const cs = getComputedStyle(document.documentElement);
    const v = (name, fallback) => (cs.getPropertyValue(name) || '').trim() || fallback;
    COLOR.agency = v('--brand-teal', COLOR.agency);
    COLOR.contractor = v('--sev-3', COLOR.contractor);
    COLOR.danger = v('--sev-4', COLOR.danger);
    COLOR.warning = v('--sev-3', COLOR.warning);
    COLOR.primary = v('--primary', COLOR.primary);
    COLOR.muted = v('--muted', COLOR.muted);
    COLOR.text = v('--text', COLOR.text);
    COLOR.surface = v('--surface', COLOR.surface);
    COLOR.line = v('--border-strong', COLOR.line);
    COLOR.dangerBg = v('--sev-4-bg', COLOR.dangerBg);
    COLOR.warnBg = v('--sev-3-bg', COLOR.warnBg);
    COLOR.tealBg = v('--primary-soft', COLOR.tealBg);
    COLOR.director = v('--violet', COLOR.director);
    COLOR.address = v('--sev-2', COLOR.address);
    COLOR.subcontractor = v('--sev-3', COLOR.subcontractor);
  }

  /* ---------- ตัวช่วยวาดชิ้นส่วนซ้ำ ---------- */

  function box(x, y, w, h, label, opts = {}) {
    const { fill = COLOR.surface, stroke = COLOR.muted, textColor = COLOR.text,
      rx = 10, fontSize = 12, sub = '', bold = true } = opts;
    const cy = y + h / 2 - (sub ? 7 : 0);
    return `
      <rect x="${x}" y="${y}" width="${w}" height="${h}" rx="${rx}"
            fill="${fill}" stroke="${stroke}" stroke-width="1.6"/>
      <text x="${x + w / 2}" y="${cy}" text-anchor="middle" dominant-baseline="middle"
            font-size="${fontSize}" font-weight="${bold ? 600 : 400}" fill="${textColor}">${label}</text>
      ${sub ? `<text x="${x + w / 2}" y="${cy + 16}" text-anchor="middle"
            font-size="10.5" fill="${COLOR.muted}">${sub}</text>` : ''}`;
  }

  function arrow(id, x1, y1, x2, y2, opts = {}) {
    const { stroke = COLOR.muted, dash = '', label = '', labelDx = 0, labelDy = -6 } = opts;
    const midX = (x1 + x2) / 2 + labelDx, midY = (y1 + y2) / 2 + labelDy;
    return `
      <line x1="${x1}" y1="${y1}" x2="${x2}" y2="${y2}" stroke="${stroke}" stroke-width="1.7"
            stroke-dasharray="${dash}" marker-end="url(#arrow-${id})"/>
      ${label ? `<text x="${midX}" y="${midY}" text-anchor="middle" font-size="10.5" fill="${stroke}">${label}</text>` : ''}`;
  }

  function defs(id, color) {
    return `<defs><marker id="arrow-${id}" viewBox="0 0 10 10" refX="9" refY="5"
              markerWidth="7" markerHeight="7" orient="auto-start-reverse">
              <path d="M0,0 L10,5 L0,10 z" fill="${color}"/>
            </marker></defs>`;
  }

  function wrap(id, viewBox, inner) {
    return `<svg viewBox="${viewBox}" xmlns="http://www.w3.org/2000/svg" role="img"
                 aria-label="แผนภาพอธิบายรูปแบบของกฎ ${id}"
                 font-family="'IBM Plex Sans Thai', system-ui, sans-serif">${inner}</svg>`;
  }

  /* ---------- นิยามไดอะแกรมรายกฎ ---------- */

  const DEFS = {

    R10: {
      title: 'สงสัยการแบ่งซื้อแบ่งจ้าง',
      caption: 'หน่วยงานเดียวทำสัญญาหลายฉบับกับผู้รับจ้างรายเดิม ในวันเดียวกัน ' +
        'แต่ละฉบับตั้งใจให้ต่ำกว่าเพดาน 500,000 บาท เพื่อเลี่ยงวิธีจัดหาที่เข้มงวดกว่า ' +
        'ทั้งที่รวมกันแล้วเกินเพดานไปมาก',
      svg: () => wrap('R10', '0 0 400 190', `
        ${defs('R10', COLOR.muted)}
        ${box(20, 75, 100, 46, 'หน่วยงาน A', { stroke: COLOR.agency })}
        ${box(280, 75, 100, 46, 'ผู้รับจ้าง B', { stroke: COLOR.contractor })}
        ${[0, 1, 2].map(i => {
          const y = 20 + i * 35;
          return `
            ${box(150, y, 100, 26, `สัญญาที่ ${i + 1}`, { fontSize: 10.5, sub: '', stroke: COLOR.warning, fill: COLOR.warnBg })}
            <text x="200" y="${y + 38}" text-anchor="middle" font-size="9.5" fill="${COLOR.muted}">&lt; 500,000 บาท</text>
            ${arrow('R10-a' + i, 120, 95, 150, y + 13, { stroke: COLOR.agency })}
            ${arrow('R10-b' + i, 250, y + 13, 280, 95, { stroke: COLOR.contractor })}`;
        }).join('')}
        <text x="200" y="150" text-anchor="middle" font-size="10.5" fill="${COLOR.text}">ทำสัญญาวันเดียวกันทั้ง 3 ฉบับ</text>
        <rect x="60" y="163" width="280" height="22" rx="11" fill="${COLOR.danger}"/>
        <text x="200" y="174" text-anchor="middle" dominant-baseline="middle"
              font-size="11" font-weight="700" fill="#fff">รวมทั้งหมด ≥ 400,000 บาท</text>`),
    },

    R7: {
      title: 'เลขผู้เสียภาษีกับชื่อผู้รับจ้างไม่สอดคล้อง',
      caption: 'เลขผู้เสียภาษีเลขเดียวกัน ผูกอยู่กับชื่อนิติบุคคลมากกว่าหนึ่งชื่อ ' +
        'อาจเป็นการพิมพ์ชื่อไม่เป็นมาตรฐาน หรือสัญญาณของนิติบุคคลที่ใช้หลายชื่อสลับกัน',
      svg: () => wrap('R7', '0 0 400 170', `
        ${defs('R7', COLOR.warning)}
        ${box(150, 62, 100, 46, 'เลขผู้เสียภาษี', { stroke: COLOR.primary, sub: '0105519xxxxxx' })}
        ${box(20, 10, 120, 40, 'บริษัท เอ จำกัด', { stroke: COLOR.contractor })}
        ${box(260, 10, 120, 40, 'บริษัท บี จำกัด', { stroke: COLOR.contractor })}
        ${arrow('R7-a', 200, 62, 100, 50, { stroke: COLOR.warning, label: '' })}
        ${arrow('R7-b', 200, 62, 300, 50, { stroke: COLOR.warning, label: '' })}
        <text x="200" y="135" text-anchor="middle" font-size="16" fill="${COLOR.danger}">⚠</text>
        <text x="200" y="152" text-anchor="middle" font-size="11" fill="${COLOR.text}">เลขเดียว ผูกกับชื่อนิติบุคคล 2 ชื่อ</text>`),
    },

    R11: {
      title: 'วันสิ้นสุดสัญญาก่อนวันทำสัญญา',
      caption: 'ลำดับวันที่ในข้อมูลผิดปกติ — วันที่สิ้นสุดสัญญาที่บันทึกไว้ มาก่อนวันที่ทำสัญญาเอง ' +
        'ซึ่งเป็นไปไม่ได้ในทางปฏิบัติ ควรตรวจสอบกับเอกสารต้นฉบับ',
      svg: () => wrap('R11', '0 0 400 150', `
        ${defs('R11', COLOR.muted)}
        <line x1="30" y1="80" x2="370" y2="80" stroke="${COLOR.muted}" stroke-width="2"/>
        ${[60, 150, 240, 330].map(x => `<line x1="${x}" y1="75" x2="${x}" y2="85" stroke="${COLOR.muted}" stroke-width="1.5"/>`).join('')}
        <text x="200" y="105" text-anchor="middle" font-size="10.5" fill="${COLOR.muted}">เส้นเวลา →</text>
        ${box(255, 35, 130, 34, 'วันสิ้นสุดสัญญา', { stroke: COLOR.danger, fill: COLOR.dangerBg, fontSize: 11 })}
        ${box(30, 35, 130, 34, 'วันทำสัญญา', { stroke: COLOR.agency, fontSize: 11 })}
        <line x1="150" y1="80" x2="330" y2="80" stroke="${COLOR.danger}" stroke-width="3" stroke-dasharray="4 3"/>
        <text x="240" y="30" text-anchor="middle" font-size="18" fill="${COLOR.danger}">✕</text>
        <text x="200" y="135" text-anchor="middle" font-size="11" fill="${COLOR.text}">ลำดับย้อนกลับ — ผิดปกติ</text>`),
    },

    R12: {
      title: 'ราคาชิดเพดานวิธีเฉพาะเจาะจง',
      caption: 'จำนวนสัญญากองตัวหนาแน่นอยู่ใต้เพดาน 500,000 บาทเล็กน้อย แล้วลดฮวบทันทีที่ข้ามเพดานไป ' +
        'การกระจายราคาตามธรรมชาติไม่ทำให้เกิดหน้าผาแบบนี้พอดีที่จุดตัดวิธีจัดหา',
      svg: () => wrap('R12', '0 0 400 170', `
        ${[
          { h: 30 }, { h: 48 }, { h: 68 }, { h: 92 }, { h: 120 },
          { h: 18 }, { h: 22 }, { h: 16 },
        ].map((b, i) => {
          const x = 30 + i * 42;
          const isTallest = i === 4;   // แท่งสูงสุดก่อนถึงเพดานพอดี ใส่ตัวเลขไว้ในแท่งกันชนกับป้ายเพดาน
          const isFirstAbove = i === 5;
          return `<rect x="${x}" y="${140 - b.h}" width="30" height="${b.h}" rx="3"
                    fill="${i < 5 ? COLOR.warning : COLOR.line}"/>` +
                 (isTallest ? `<text x="${x + 15}" y="${140 - b.h + 16}" text-anchor="middle"
                    font-size="9.5" font-weight="700" fill="#fff">1,789</text>` : '') +
                 (isFirstAbove ? `<text x="${x + 15}" y="${140 - b.h - 8}" text-anchor="middle"
                    font-size="9" fill="${COLOR.text}">119</text>` : '');
        }).join('')}
        <line x1="235" y1="22" x2="235" y2="140" stroke="${COLOR.danger}" stroke-width="2" stroke-dasharray="4 3"/>
        <text x="235" y="12" text-anchor="middle" font-size="10" font-weight="700" fill="${COLOR.danger}">เพดาน 500,000</text>
        <text x="150" y="158" text-anchor="middle" font-size="10.5" fill="${COLOR.muted}">ใต้เพดาน (มาก)</text>
        <text x="320" y="158" text-anchor="middle" font-size="10.5" fill="${COLOR.muted}">เหนือเพดาน (น้อย)</text>`),
    },

    R13: {
      title: 'ราคาสัญญาเท่ากับราคากลางพอดี',
      caption: 'ราคาที่ตกลงเท่ากับราคากลางทุกบาททุกสตางค์ ไม่มีส่วนลดแม้แต่น้อย ' +
        'สะท้อนว่าไม่มีแรงกดดันจากการแข่งขันด้านราคาเลย',
      svg: () => wrap('R13', '0 0 400 170', `
        <text x="20" y="35" font-size="11" fill="${COLOR.muted}">ปกติ (มีการแข่งขัน)</text>
        ${box(20, 45, 220, 22, '', { fill: COLOR.agency, stroke: COLOR.agency, rx: 4 })}
        <text x="40" y="60" font-size="10" fill="#fff">ราคาสัญญา</text>
        ${box(20, 75, 260, 22, '', { fill: COLOR.line, stroke: COLOR.line, rx: 4 })}
        <text x="40" y="90" font-size="10" fill="${COLOR.text}">ราคากลาง</text>
        <line x1="240" y1="45" x2="240" y2="97" stroke="${COLOR.muted}" stroke-width="1" stroke-dasharray="2 2"/>
        <text x="250" y="72" font-size="9.5" fill="${COLOR.muted}">ส่วนต่าง</text>

        <text x="20" y="128" font-size="11" fill="${COLOR.danger}" font-weight="600">พบในกฎนี้ (ราคา = ราคากลาง)</text>
        ${box(20, 138, 280, 22, '', { fill: COLOR.danger, stroke: COLOR.danger, rx: 4 })}
        <text x="40" y="153" font-size="10" fill="#fff">ราคาสัญญา = ราคากลางเป๊ะ</text>
        <text x="330" y="153" font-size="14" fill="${COLOR.danger}">100%</text>`),
    },

    R15: {
      title: 'คู่หน่วยงาน-ผู้รับจ้างซ้ำสูง',
      caption: 'ผู้รับจ้างรายเดิมได้งานจากหน่วยงานเดิมซ้ำหลายสิบครั้งในปีเดียว ' +
        'อาจมาจากความเชี่ยวชาญเฉพาะทาง หรือจากการแข่งขันที่ไม่สม่ำเสมอ ต้องดูวิธีจัดหาประกอบ',
      svg: () => wrap('R15', '0 0 400 160', `
        ${defs('R15', COLOR.primary)}
        ${box(20, 60, 110, 44, 'หน่วยงาน A', { stroke: COLOR.agency })}
        ${box(270, 60, 110, 44, 'ผู้รับจ้าง B', { stroke: COLOR.contractor })}
        ${[-24, -10, 4, 18, 32].map((dy, i) =>
          arrow('R15-' + i, 130, 82 + dy * 0.6, 270, 82 + dy * 0.6, { stroke: COLOR.primary })).join('')}
        <rect x="150" y="105" width="100" height="24" rx="12" fill="${COLOR.primary}"/>
        <text x="200" y="117" text-anchor="middle" dominant-baseline="middle"
              font-size="11" font-weight="700" fill="#fff">× 52 สัญญา</text>
        <text x="200" y="20" text-anchor="middle" font-size="11" fill="${COLOR.muted}">คู่เดิมซ้ำตลอดทั้งปีงบ</text>`),
    },

    R17: {
      title: 'พิกัดโครงการห่างจากพื้นที่ปกติของจังหวัด',
      caption: 'คอลัมน์จังหวัดในข้อมูลระบุที่ตั้งของหน่วยงาน แต่พิกัดบนแผนที่คือที่ตั้งโครงการจริง ' +
        'เมื่อทั้งสองจุดห่างกันมาก เป็นสัญญาณให้ตรวจสอบเพิ่มเติม ไม่ใช่ข้อสรุปว่าผิดปกติ',
      svg: () => wrap('R17', '0 0 400 170', `
        ${defs('R17', COLOR.muted)}
        <circle cx="90" cy="90" r="46" fill="${COLOR.tealBg}" stroke="${COLOR.agency}" stroke-width="1.5" stroke-dasharray="3 3"/>
        <text x="90" y="70" text-anchor="middle" font-size="10.5" fill="${COLOR.agency}" font-weight="600">จังหวัดของ</text>
        <text x="90" y="84" text-anchor="middle" font-size="10.5" fill="${COLOR.agency}" font-weight="600">หน่วยงาน</text>
        <circle cx="90" cy="90" r="5" fill="${COLOR.agency}"/>
        <circle cx="320" cy="55" r="6" fill="${COLOR.danger}"/>
        <text x="320" y="35" text-anchor="middle" font-size="10.5" fill="${COLOR.danger}" font-weight="600">พิกัดโครงการจริง</text>
        ${arrow('R17-a', 100, 80, 312, 58, { stroke: COLOR.danger, dash: '5 3', label: '> 200 กม.', labelDy: -8 })}
        <text x="200" y="150" text-anchor="middle" font-size="11" fill="${COLOR.text}">ห่างจากศูนย์กลางจังหวัดผิดปกติ</text>`),
    },
  };


  /* ---------- ไดอะแกรมของแท็บสาธิต ----------
     สองอันนี้รับข้อมูลเข้ามา ไม่ได้ฝังชื่อไว้ในโค้ด เพื่อให้ภาพตรงกับเคสที่วางไว้ใน
     tools/build_data.py เสมอ ถ้าเคสเปลี่ยน ภาพเปลี่ยนตามโดยไม่ต้องแก้ที่นี่ */

  const KIND_LABEL = { director: 'กรรมการร่วม', address: 'ที่อยู่จดทะเบียนร่วม',
    subcontractor: 'ผู้รับเหมาช่วงร่วม' };

  function esc(t) {
    return String(t).replace(/[&<>"']/g, c =>
      ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  }

  /** ตัดข้อความยาวให้พอดีกล่อง SVG ซึ่งตัดเองไม่ได้เหมือน HTML */
  function fit(text, max) {
    const t = String(text);
    return t.length > max ? t.slice(0, max - 1) + '…' : t;
  }

  /** ภาพหลักของแท็บ: เทียบสิ่งที่ข้อมูลจริงเห็น กับสิ่งที่ข้อมูลที่ขาดหายจะเผยให้เห็น */
  function demoCollusion(companies, shared) {
    syncColors();
    const cos = (companies || []).slice(0, 3);
    const sh = (shared || []).slice(0, 3);
    if (cos.length < 2) return '';
    const colW = 108, gap = 18;
    const xs = cos.map((_, i) => 404 + i * (colW + gap));

    const inner = `
      ${defs('demo-a', COLOR.muted)}
      ${defs('demo-b', COLOR.danger)}
      <line x1="390" y1="14" x2="390" y2="296" stroke="${COLOR.line}" stroke-width="1.5" stroke-dasharray="4 4"/>

      <text x="18" y="24" font-size="12" font-weight="700" fill="${COLOR.text}">① ข้อมูลที่มีตอนนี้</text>
      ${box(96, 42, 190, 32, 'โครงการหนึ่งสัญญา', { stroke: COLOR.agency, fontSize: 11 })}
      ${arrow('demo-a', 191, 74, 191, 112, { stroke: COLOR.muted })}
      ${box(96, 112, 190, 40, 'ผู้ชนะ 1 ราย', { stroke: COLOR.primary, fontSize: 11,
        sub: fit(cos[0], 24) })}
      <text x="191" y="184" text-anchor="middle" font-size="11" fill="${COLOR.muted}">ผู้ยื่นรายอื่นไม่ถูกบันทึกไว้</text>
      ${cos.slice(1).map((_, i) => box(96 + i * 100, 200, 90, 30, '?', {
        stroke: COLOR.line, fill: 'none', fontSize: 13, textColor: COLOR.muted })).join('')}
      <text x="191" y="262" text-anchor="middle" font-size="11" fill="${COLOR.text}">มองไม่เห็นว่าใครแข่งกับใคร</text>

      <text x="404" y="24" font-size="12" font-weight="700" fill="${COLOR.text}">② ถ้ามีข้อมูลนิติบุคคล</text>
      ${box(494, 42, 190, 32, 'โครงการเดียวกัน', { stroke: COLOR.agency, fontSize: 11 })}
      ${cos.map((c, i) => `
        ${arrow('demo-a', 589, 74, xs[i] + colW / 2, 104, { stroke: COLOR.muted })}
        ${box(xs[i], 104, colW, 40, `ผู้ยื่นที่ ${i + 1}`, {
          stroke: COLOR.primary, fontSize: 10.5, sub: fit(c, 14) })}`).join('')}
      <rect x="398" y="96" width="${xs[cos.length - 1] + colW - 398 + 6}" height="56" rx="10"
            fill="none" stroke="${COLOR.danger}" stroke-width="1.4" stroke-dasharray="5 4"/>
      ${arrow('demo-b', 589, 158, 589, 188, { stroke: COLOR.danger })}
      ${sh.map((x, i) => box(xs[i] || (404 + i * (colW + gap)), 188, colW, 44,
        KIND_LABEL[x.kind] || x.kind, {
          stroke: COLOR[x.kind] || COLOR.muted, fontSize: 10,
          sub: fit(x.label, 15) })).join('')}
      <text x="589" y="262" text-anchor="middle" font-size="11" font-weight="700" fill="${COLOR.danger}">ซองครบตามระเบียบ แต่เป็นผู้เล่นรายเดียว</text>
      <text x="589" y="282" text-anchor="middle" font-size="10.5" fill="${COLOR.muted}">ใช้ร่วมกัน ${sh.length} ช่องทาง</text>`;

    return `<svg viewBox="0 0 780 300" xmlns="http://www.w3.org/2000/svg" role="img"
                 aria-label="แผนภาพเทียบข้อมูลที่มีอยู่กับข้อมูลที่ขาดหาย"
                 font-family="'IBM Plex Sans Thai', system-ui, sans-serif">${inner}</svg>`;
  }

  /** ภาพดาว: สิ่งที่ใช้ร่วมกัน 1 อย่าง -> บริษัทที่ผูกอยู่ ใช้ในหน้าต่างรายละเอียด */
  function demoStar(sharedLabel, kind, companies) {
    syncColors();
    const cos = (companies || []).slice(0, 6);
    const h = Math.max(150, 34 + cos.length * 46);
    const cy = h / 2;
    const color = COLOR[kind] || COLOR.muted;
    const inner = `
      ${defs('demo-star', color)}
      ${box(10, cy - 30, 170, 60, KIND_LABEL[kind] || 'ใช้ร่วมกัน', {
        stroke: color, fontSize: 11, sub: fit(sharedLabel, 22) })}
      ${cos.map((c, i) => {
        const y = 12 + i * 46;
        return `${arrow('demo-star', 180, cy, 250, y + 18, { stroke: color })}
                ${box(250, y, 230, 36, fit(c, 30), { stroke: COLOR.primary, fontSize: 10.5 })}`;
      }).join('')}`;
    return `<svg viewBox="0 0 490 ${h}" xmlns="http://www.w3.org/2000/svg" role="img"
                 aria-label="แผนภาพบริษัทที่ผูกกับ ${esc(sharedLabel)}"
                 font-family="'IBM Plex Sans Thai', system-ui, sans-serif">${inner}</svg>`;
  }

  function has(ruleId) { return Object.prototype.hasOwnProperty.call(DEFS, ruleId); }

  function render(ruleId) {
    const d = DEFS[ruleId];
    if (!d) return null;
    syncColors();
    return `
      <div class="rule-diagram">
        ${d.svg()}
      </div>
      <p class="rule-diagram-caption">${d.caption}</p>`;
  }

  return { has, render, ids: Object.keys(DEFS), demoCollusion, demoStar, syncColors };
})();
