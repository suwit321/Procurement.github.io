/* util.js — ฟังก์ชันพื้นฐาน: จัดรูปแบบ, สถิติ, วันที่, DOM
   โหลดก่อนไฟล์อื่นทั้งหมด */
'use strict';

const U = (() => {

  /* ---------- จัดรูปแบบ ---------- */

  /* Number.prototype.toLocaleString สร้างตัวจัดรูปแบบใหม่ทุกครั้งที่เรียก
     ซึ่งช้ามากเมื่อเรียกหลายพันครั้งต่อการประเมินหนึ่งรอบ
     การเก็บ Intl.NumberFormat ไว้ใช้ซ้ำเร็วกว่าหลายสิบเท่า */
  const _formatters = new Map();

  function formatter(digits) {
    let f = _formatters.get(digits);
    if (!f) {
      f = new Intl.NumberFormat('th-TH', {
        minimumFractionDigits: digits, maximumFractionDigits: digits
      });
      _formatters.set(digits, f);
    }
    return f;
  }

  function num(x, digits = 0) {
    if (x === null || x === undefined || x === '' || Number.isNaN(Number(x))) return '-';
    return formatter(digits).format(Number(x));
  }

  /** ย่อจำนวนเงินเป็น พัน/ล้าน/พันล้าน — ตัวเลขเต็มอ่านยากในการ์ด KPI */
  function money(x) {
    if (x === null || x === undefined || Number.isNaN(Number(x))) return '-';
    const v = Number(x);
    const abs = Math.abs(v);
    if (abs >= 1e9) return (v / 1e9).toFixed(2) + ' พันล้าน';
    if (abs >= 1e6) return (v / 1e6).toFixed(2) + ' ล้าน';
    if (abs >= 1e3) return (v / 1e3).toFixed(1) + ' พัน';
    return num(v, 0);
  }

  function baht(x) { return x === null || x === undefined ? '-' : num(x, 2) + ' บาท'; }

  function pct(x, digits = 1) {
    if (x === null || x === undefined || Number.isNaN(Number(x))) return '-';
    return (Number(x) * 100).toFixed(digits) + '%';
  }

  function esc(x) {
    return String(x ?? '').replace(/[&<>"']/g,
      m => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[m]));
  }

  /* ---------- วันที่ ---------- */

  const THAI_MONTHS_SHORT = ['ม.ค.', 'ก.พ.', 'มี.ค.', 'เม.ย.', 'พ.ค.', 'มิ.ย.',
    'ก.ค.', 'ส.ค.', 'ก.ย.', 'ต.ค.', 'พ.ย.', 'ธ.ค.'];

  /** '2025-11-20' -> '20 พ.ย. 68' (แสดงผลเป็น พ.ศ. ตามต้นฉบับ) */
  function thaiDate(iso) {
    if (!iso) return '-';
    const d = new Date(iso + 'T00:00:00');
    if (Number.isNaN(d.getTime())) return '-';
    const be = d.getFullYear() + 543;
    return `${d.getDate()} ${THAI_MONTHS_SHORT[d.getMonth()]} ${String(be).slice(-2)}`;
  }

  /** '2025-11-20' -> '2025-11' สำหรับจัดกลุ่มรายเดือน */
  function monthKey(iso) { return iso ? iso.slice(0, 7) : null; }

  function thaiMonthLabel(key) {
    if (!key) return '-';
    const [y, m] = key.split('-').map(Number);
    return `${THAI_MONTHS_SHORT[m - 1]} ${String(y + 543).slice(-2)}`;
  }

  /* ---------- สถิติ ---------- */

  const sum = a => a.reduce((s, x) => s + (Number(x) || 0), 0);
  const mean = a => (a.length ? sum(a) / a.length : 0);

  function quantile(sorted, q) {
    if (!sorted.length) return 0;
    const pos = (sorted.length - 1) * q;
    const lo = Math.floor(pos), hi = Math.ceil(pos);
    return lo === hi ? sorted[lo] : sorted[lo] + (sorted[hi] - sorted[lo]) * (pos - lo);
  }

  function median(values) {
    return quantile([...values].sort((a, b) => a - b), 0.5);
  }

  function stddev(values) {
    if (values.length < 2) return 0;
    const m = mean(values);
    return Math.sqrt(sum(values.map(v => (v - m) ** 2)) / (values.length - 1));
  }

  /** สัมประสิทธิ์การแปรผัน — ใช้วัดการกระจายของราคาภายในหน่วยงาน */
  function cv(values) {
    const m = mean(values);
    return m === 0 ? 0 : stddev(values) / m;
  }

  /** ขอบเขต outlier แบบ Tukey; ใช้ 3.0 เพื่อจับเฉพาะค่าสุดโต่งจริง */
  function iqrBounds(values, k = 3.0) {
    const sorted = [...values].sort((a, b) => a - b);
    const q1 = quantile(sorted, 0.25), q3 = quantile(sorted, 0.75);
    const iqr = q3 - q1;
    return { q1, q3, iqr, lower: q1 - k * iqr, upper: q3 + k * iqr };
  }

  /* ---------- การจัดกลุ่ม ---------- */

  function groupBy(rows, keyFn) {
    const map = new Map();
    for (const row of rows) {
      const key = keyFn(row);
      if (key === null || key === undefined || key === '') continue;
      let bucket = map.get(key);
      if (!bucket) { bucket = []; map.set(key, bucket); }
      bucket.push(row);
    }
    return map;
  }

  function countBy(rows, keyFn) {
    const map = new Map();
    for (const row of rows) {
      const key = keyFn(row);
      if (key === null || key === undefined || key === '') continue;
      map.set(key, (map.get(key) || 0) + 1);
    }
    return map;
  }

  /* ---------- ภูมิศาสตร์ ---------- */

  /** ระยะทางวงกลมใหญ่ (กม.) */
  function haversine(lat1, lon1, lat2, lon2) {
    const R = 6371, toRad = d => d * Math.PI / 180;
    const dLat = toRad(lat2 - lat1), dLon = toRad(lon2 - lon1);
    const a = Math.sin(dLat / 2) ** 2 +
      Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) ** 2;
    return 2 * R * Math.asin(Math.sqrt(a));
  }

  /* ---------- DOM ---------- */

  const $ = id => document.getElementById(id);

  /* ตัวรับแจ้งหลังวาดเนื้อหาใหม่
     ใช้แทน MutationObserver เพราะทำงานตรงจุดและตามลำดับที่แน่นอน
     ผู้รับแจ้งจะไม่ถูกเรียกซ้ำจากการแก้ DOM ของตัวเอง */
  const _renderHooks = [];
  function onRender(fn) { _renderHooks.push(fn); }

  function setHTML(id, html) {
    const el = $(id);
    if (!el) return;
    el.innerHTML = html;
    for (const fn of _renderHooks) {
      try { fn(el); } catch (e) { console.error('render hook ล้มเหลว', e); }
    }
  }

  /** ข้อความว่างที่มีกรอบชัดเจน — เดิมช่องว่างเปล่าแยกไม่ออกจาก widget ที่พัง */
  function emptyState(message = 'ไม่พบข้อมูลตามเงื่อนไขที่เลือก') {
    return `<div class="empty-state">${esc(message)}</div>`;
  }

  function emptyRow(colspan, message = 'ไม่พบข้อมูลตามเงื่อนไขที่เลือก') {
    return `<tr><td colspan="${colspan}" class="text-center small-muted py-4">${esc(message)}</td></tr>`;
  }

  function debounce(fn, wait = 200) {
    let timer;
    return function (...args) {
      clearTimeout(timer);
      timer = setTimeout(() => fn.apply(this, args), wait);
    };
  }

  /* ---------- สถิติแบบเบย์: Empirical Bayes สำหรับสัดส่วน ----------

     ปัญหาที่แก้: หน่วยงานครึ่งหนึ่งในข้อมูลมีสัญญาเพียงฉบับเดียว สัดส่วนอย่าง "ใช้วิธีเฉพาะเจาะจง"
     จึงเป็น 0% หรือ 100% ได้ง่ายโดยบังเอิญ การตัดด้วย "ต้องมีอย่างน้อย n ฉบับ" แก้ได้ครึ่งเดียว
     เพราะทิ้งหน่วยงานเล็กไปทั้งหมด และหน่วยงานที่มี n พอดีเกณฑ์ยังแกว่งมาก

     วิธีนี้ประมาณการกระจายของสัดส่วนระหว่างหน่วยงาน (prior) จากข้อมูลเอง แล้วดึงค่าของ
     หน่วยงานข้อมูลน้อยเข้าหาค่ากลาง ยิ่งข้อมูลน้อยยิ่งถูกดึงมาก หน่วยงาน 50 สัญญาแทบไม่ขยับ */

  function _logGamma(x) {
    // Lanczos approximation (g=7, n=9) แม่นยำระดับ 1e-15 ในช่วงที่ใช้งาน
    const c = [0.99999999999980993, 676.5203681218851, -1259.1392167224028, 771.32342877765313,
      -176.61503916999185, 12.507343278686905, -0.13857109526572012,
      9.9843695780195716e-6, 1.5056327351493116e-7];
    if (x < 0.5) return Math.log(Math.PI / Math.sin(Math.PI * x)) - _logGamma(1 - x);
    x -= 1;
    let a = c[0];
    const t = x + 7.5;
    for (let i = 1; i < 9; i++) a += c[i] / (x + i);
    return 0.5 * Math.log(2 * Math.PI) + (x + 0.5) * Math.log(t) - t + Math.log(a);
  }

  function _betaContinuedFraction(x, a, b) {
    // Lentz's algorithm ตาม Numerical Recipes §6.4
    const TINY = 1e-300, EPS = 3e-14;
    const qab = a + b, qap = a + 1, qam = a - 1;
    let c = 1, d = 1 - qab * x / qap;
    if (Math.abs(d) < TINY) d = TINY;
    d = 1 / d;
    let h = d;
    for (let m = 1; m <= 300; m++) {
      const m2 = 2 * m;
      let aa = m * (b - m) * x / ((qam + m2) * (a + m2));
      d = 1 + aa * d; if (Math.abs(d) < TINY) d = TINY;
      c = 1 + aa / c; if (Math.abs(c) < TINY) c = TINY;
      d = 1 / d; h *= d * c;
      aa = -(a + m) * (qab + m) * x / ((a + m2) * (qap + m2));
      d = 1 + aa * d; if (Math.abs(d) < TINY) d = TINY;
      c = 1 + aa / c; if (Math.abs(c) < TINY) c = TINY;
      d = 1 / d;
      const del = d * c;
      h *= del;
      if (Math.abs(del - 1) < EPS) break;
    }
    return h;
  }

  /** P(X <= x) เมื่อ X ~ Beta(a, b) — regularized incomplete beta I_x(a, b) */
  function betaCdf(x, a, b) {
    if (x <= 0) return 0;
    if (x >= 1) return 1;
    const lnFront = _logGamma(a + b) - _logGamma(a) - _logGamma(b) +
      a * Math.log(x) + b * Math.log(1 - x);
    // ใช้ความสมมาตร I_x(a,b) = 1 - I_{1-x}(b,a) เพื่อให้ continued fraction ลู่เข้าเร็ว
    if (x < (a + 1) / (a + b + 2)) return Math.exp(lnFront) * _betaContinuedFraction(x, a, b) / a;
    return 1 - Math.exp(lnFront) * _betaContinuedFraction(1 - x, b, a) / b;
  }

  /** P(X > x) เมื่อ X ~ Beta(a, b) */
  function betaSf(x, a, b) { return 1 - betaCdf(x, a, b); }

  /** ประมาณ prior Beta(α, β) จากข้อมูลหลายกลุ่ม ด้วย method of moments
   *
   *  ks, ns = จำนวนที่เข้าเงื่อนไข และจำนวนทั้งหมดของแต่ละกลุ่ม
   *  ความแปรปรวนที่สังเกตได้ระหว่างกลุ่ม = ความแปรปรวนจริง + ความแปรปรวนจากการสุ่มแบบทวินาม
   *  จึงต้องหักส่วนหลังออก ไม่เช่นนั้น prior จะกว้างเกินจริงและแทบไม่ดึงหน่วยงานเล็กเลย
   *  (ถ่วงน้ำหนักด้วยขนาดกลุ่ม ให้หน่วยงานใหญ่มีผลต่อค่ากลางมากกว่า) */
  function fitBetaPrior(ks, ns) {
    let N = 0, mean = 0;
    for (let i = 0; i < ns.length; i++) { N += ns[i]; mean += ks[i]; }
    if (!N) return { alpha: 1, beta: 1, mean: 0.5, sd: 0 };
    mean /= N;
    let varObs = 0, varSamp = 0;
    for (let i = 0; i < ns.length; i++) {
      if (!ns[i]) continue;
      const w = ns[i] / N, p = ks[i] / ns[i];
      varObs += w * (p - mean) ** 2;
      varSamp += w * mean * (1 - mean) / ns[i];
    }
    const tau2 = Math.max(varObs - varSamp, 1e-6);
    // ความเข้มข้นของ prior (α+β) จำกัดไว้ไม่ให้แคบจนหน่วยงานใหญ่ถูกดึงด้วย หรือกว้างจนไร้ความหมาย
    const s = Math.min(Math.max(mean * (1 - mean) / tau2 - 1, 2), 1e4);
    const m = Math.min(Math.max(mean, 1e-6), 1 - 1e-6);
    return { alpha: m * s, beta: (1 - m) * s, mean: m, sd: Math.sqrt(tau2) };
  }

  /** ค่าหลังปรับ (posterior) ของกลุ่มหนึ่ง */
  function betaPosterior(prior, k, n) {
    const a = prior.alpha + k, b = prior.beta + n - k;
    return { a, b, mean: a / (a + b) };
  }

  /* ---------- ส่งออก CSV ---------- */

  function toCSV(headers, rows) {
    const cell = v => {
      const s = String(v ?? '');
      return /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
    };
    return [headers.map(cell).join(','), ...rows.map(r => r.map(cell).join(','))].join('\n');
  }

  function downloadCSV(filename, headers, rows) {
    // BOM เพื่อให้ Excel อ่านภาษาไทยถูกต้อง
    const blob = new Blob(['﻿' + toCSV(headers, rows)],
      { type: 'text/csv;charset=utf-8;' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  }

  return {
    num, money, baht, pct, esc,
    thaiDate, monthKey, thaiMonthLabel, THAI_MONTHS_SHORT,
    sum, mean, median, quantile, stddev, cv, iqrBounds,
    groupBy, countBy, haversine,
    betaCdf, betaSf, fitBetaPrior, betaPosterior,
    $, setHTML, onRender, emptyState, emptyRow, debounce,
    toCSV, downloadCSV,
  };
})();
