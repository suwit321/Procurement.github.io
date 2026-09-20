/* =============================================================================
   importui.js — หน้าจอของแท็บ "นำเข้าข้อมูล"

   แยกจาก app.js เพราะเป็นงานคนละเรื่องกับการวิเคราะห์ และ app.js ยาวมากแล้ว
   สื่อสารกับแอปผ่าน api ที่ส่งเข้ามาตอน init เท่านั้น (ไม่แตะตัวแปรภายในของ app.js โดยตรง)

   ลำดับการใช้งาน: เลือกแหล่ง → ตั้งค่าและอ่านไฟล์ → จับคู่คอลัมน์ → ตรวจคุณภาพ → ยืนยันนำเข้า
   ทุกขั้นย้อนกลับได้ และไม่มีการเขียนอะไรลง IndexedDB จนกว่าจะกดยืนยัน
   ============================================================================= */

const ImportUI = (() => {
  'use strict';

  let api = {};

  const MAP_STORE = 'pa_import_maps_v1';
  const ROW_WARN = 50000;
  const ROW_MAX = 200000;

  const ui = {
    step: 1,
    source: null,          // 'file' | 'api' | 'paste'
    read: null,            // ผลจาก DataIO.readFile
    mapping: null,
    aiMapping: null,       // คอลัมน์ที่ AI เสนอ (ไว้ทำไฮไลต์)
    result: null,          // { records, report }
    merge: 'replace',
    name: '',
    busy: '',
    error: null,
    notice: '',
    datasets: [],
    storage: null,
  };

  /* ---------- ตัวช่วยเล็ก ๆ ---------- */

  const esc = U.esc;
  const pct = (x, d = 0) => `${(x * 100).toFixed(d)}%`;
  const fileSize = b => (b > 1048576 ? `${(b / 1048576).toFixed(1)} MB` : `${Math.max(1, Math.round(b / 1024))} KB`);
  const el = id => document.getElementById(id);

  function setBusy(text) { ui.busy = text; render(); }
  function fail(err) {
    ui.busy = '';
    ui.error = err;
    console.warn('นำเข้าข้อมูลไม่สำเร็จ', err);
    render();
  }

  /* ---------- แม่แบบการจับคู่คอลัมน์ที่ผู้ใช้บันทึกเอง ---------- */

  const loadMaps = () => { try { return JSON.parse(localStorage.getItem(MAP_STORE) || '{}'); } catch (e) { return {}; } };
  const saveMaps = m => { try { localStorage.setItem(MAP_STORE, JSON.stringify(m)); } catch (e) { /* โควตาเต็ม */ } };
  const headerSignature = headers => headers.slice().sort().join('|').slice(0, 400);

  /* ---------- วาดหน้าจอ ---------- */

  function render() {
    if (!el('importWizard')) return;
    U.setHTML('importWizard', wizardHTML());
    U.setHTML('importDatasets', datasetsHTML());
    U.setHTML('importTools', toolsHTML());
  }

  function stepHead() {
    const steps = [[1, 'เลือกแหล่งข้อมูล'], [2, 'อ่านไฟล์'], [3, 'จับคู่คอลัมน์และตรวจ']];
    return `<div class="imp-steps" role="list">${steps.map(([n, label]) => `
      <div class="imp-step ${ui.step === n ? 'is-on' : ui.step > n ? 'is-done' : ''}" role="listitem">
        <span class="imp-step-n">${ui.step > n ? '✓' : n}</span>${esc(label)}</div>`).join('')}</div>`;
  }

  function wizardHTML() {
    const parts = [
      `<div class="card-title-row"><h2 class="h6 mb-0">นำเข้าชุดข้อมูลใหม่</h2>
        ${ui.step > 1 ? '<button type="button" class="btn btn-sm btn-link p-0" data-imp-reset>เริ่มใหม่</button>' : ''}</div>`,
      stepHead(),
      ui.error ? errorHTML(ui.error) : '',
      ui.busy ? `<div class="imp-busy"><span class="ag-spin"></span> ${esc(ui.busy)}</div>` : '',
    ];
    if (ui.step === 1) parts.push(sourceHTML());
    if (ui.step === 2) parts.push(readHTML());
    if (ui.step === 3) parts.push(mappingHTML(), reportHTML(), commitHTML());
    return parts.join('');
  }

  function errorHTML(err) {
    return `<div class="ai-error"><strong>${esc(err.message || String(err))}</strong>
      ${err.hint ? `<div class="small mt-1">${esc(err.hint)}</div>` : ''}</div>`;
  }

  function sourceHTML() {
    const idb = Datasets.available();
    return `
      ${idb.ok ? '' : `<div class="ai-warn mb-2">${esc(idb.reason)}</div>`}
      <div class="imp-sources">
        <label class="imp-source">
          <input type="file" id="impFile" accept=".csv,.tsv,.txt,.json,.xlsx,.xlsm,.xls" hidden>
          <span class="imp-source-icon" aria-hidden="true">📁</span>
          <span class="imp-source-title">ไฟล์ของฉัน</span>
          <span class="imp-source-sub">CSV · XLSX · JSON · ลากไฟล์มาวางตรงนี้ก็ได้</span>
        </label>
        <button type="button" class="imp-source" data-imp-source="api">
          <span class="imp-source-icon" aria-hidden="true">🔌</span>
          <span class="imp-source-title">e-GP Open Data</span>
          <span class="imp-source-sub">ดึงตามเงื่อนไขที่เลือกจาก govspending.data.go.th</span>
        </button>
        <button type="button" class="imp-source" data-imp-source="paste">
          <span class="imp-source-icon" aria-hidden="true">📋</span>
          <span class="imp-source-title">วาง JSON</span>
          <span class="imp-source-sub">วางผลที่ดึงมาเองจาก API หรือเครื่องมืออื่น</span>
        </button>
      </div>
      ${ui.source === 'paste' ? `
        <div class="imp-paste mt-2">
          <label class="ai-field-label" for="impPaste">วางข้อความ JSON ที่นี่</label>
          <textarea class="form-control" id="impPaste" rows="6" placeholder='[{"project_id":"...","project_name":"..."}] หรือ {"result":[...]}'></textarea>
          <button type="button" class="btn btn-sm btn-primary mt-2" data-imp-paste-go>อ่านข้อความนี้</button>
        </div>` : ''}
      ${ui.source === 'api' ? apiPlaceholderHTML() : ''}
      <details class="imp-help mt-3">
        <summary>ชุดข้อมูลที่นำเข้าใช้ทำอะไรได้บ้าง</summary>
        <ul class="mb-0">
          <li><strong>ใช้ได้เต็มที่</strong> — กฎตรวจจับ R1–R22 ที่คำนวณในเบราว์เซอร์ ตัวกรองทุกตัว แผนที่ ตะกร้า ป้ายผลการตรวจ ผู้ช่วย AI และห้องทดลองกฎ</li>
          <li><strong>ใช้ไม่ได้</strong> — การ์ดที่ต้องใช้ผลโมเดล Python (Isolation Forest · แบบจำลองส่วนลด · ราคาถนนต่อ ตร.ม. · การทดสอบหลักตัวเลข · ดัชนีเครือข่าย)
            ถ้าต้องการครบ ให้ส่งออกเป็น <code>raw_data.csv</code> จากการ์ดด้านขวา แล้วรัน <code>python tools/build_data.py</code></li>
          <li><strong>กฎ R5 และ R6</strong> เป็นกฎสาธิตที่ใช้ฟิลด์สังเคราะห์ จะไม่ทำงานกับข้อมูลที่นำเข้า (และไม่เคยนับในคะแนนความเสี่ยงอยู่แล้ว)</li>
        </ul>
      </details>`;
  }

  function apiPlaceholderHTML() {
    const base = 'https://opend.data.go.th/govspending/cgdcontract';
    return `
      <div class="imp-api mt-2">
        <div class="ai-warn mb-2">
          <strong>เบราว์เซอร์เรียก e-GP API ตรง ๆ ไม่ได้</strong> — เซิร์ฟเวอร์ของผู้ให้บริการไม่ส่งหัว CORS กลับมา
          จาวาสคริปต์จึงอ่านผลไม่ได้ (ทดสอบแล้วทั้ง opend.data.go.th และ data.go.th)
          ระหว่างที่ตัวช่วยดึงข้อมูลยังไม่เสร็จ (เฟสถัดไป) ใช้วิธีนี้ไปก่อนได้เลย:
        </div>
        <ol class="imp-steps-list">
          <li>ขอ API key ที่ <a href="https://opend.data.go.th/register_api" target="_blank" rel="noopener noreferrer">opend.data.go.th/register_api</a></li>
          <li>เปิด URL นี้ในแท็บใหม่ (ใส่ค่าของคุณแทน <code>YOUR_KEY</code> และแก้เงื่อนไขได้ตามต้องการ)
            <div class="imp-url"><code id="impApiUrl">${esc(base)}?api-key=YOUR_KEY&amp;year=2569&amp;offset=0&amp;limit=1000</code>
              <button type="button" class="btn btn-sm btn-outline-secondary" data-imp-copy="impApiUrl">คัดลอก</button></div>
          </li>
          <li>บันทึกผลเป็นไฟล์ <code>.json</code> แล้วลากกลับมาวางที่ช่อง "ไฟล์ของฉัน" ด้านบน (ระบบรู้จักรูปแบบ <code>{"result":[...]}</code> ของ e-GP อยู่แล้ว)</li>
        </ol>
        <div class="small-muted">พารามิเตอร์ที่บริการนี้รับ: <code>year · dept_code · budget_start · budget_end · keyword · winner_tin · offset · limit</code></div>
      </div>`;
  }

  function readHTML() {
    const r = ui.read;
    if (!r) return '';
    const info = r.info || {};
    const bits = [];
    if (info.fileName) bits.push(`ไฟล์ <strong>${esc(info.fileName)}</strong> · ${fileSize(info.bytes || 0)}`);
    bits.push(`${U.num(r.rows.length)} แถว · ${r.header.length} คอลัมน์`);
    if (info.encoding) bits.push(`การเข้ารหัส <strong>${esc(info.encoding.encoding)}</strong>${info.encoding.thaiChars ? ` (พบอักษรไทย ${U.num(info.encoding.thaiChars)} ตัว)` : ''}`);
    if (info.delimiter) bits.push(`ตัวคั่น <code>${info.delimiter === '\t' ? 'แท็บ' : esc(info.delimiter)}</code>`);
    if (info.shape) bits.push(`รูปแบบ ${esc(info.hint || info.shape)}`);
    if (info.sheet) bits.push(`ชีต <strong>${esc(info.sheet)}</strong>`);

    return `
      <div class="imp-read">
        <div class="imp-read-line">${bits.join(' · ')}</div>
        ${info.encoding && info.encoding.replacementChars ? `<div class="ai-warn">พบอักขระที่อ่านไม่ออก ${U.num(info.encoding.replacementChars)} ตัว — ลองเปลี่ยนการเข้ารหัสด้านล่าง</div>` : ''}
        ${info.truncated ? `<div class="ai-warn">อ่านเฉพาะ ${U.num(ROW_MAX)} แถวแรกเท่านั้น</div>` : ''}
        ${(info.ragged || []).length ? `<div class="ai-warn">มี ${U.num(info.ragged.length)} บรรทัดที่จำนวนคอลัมน์ไม่ตรงกับหัวตาราง (เติมค่าว่างให้แล้ว) เช่น บรรทัด ${info.ragged.slice(0, 3).map(x => x.line).join(', ')}</div>` : ''}
        ${info.encoding ? `
          <label class="imp-inline">การเข้ารหัสอักขระ
            <select class="form-select form-select-sm" data-imp-encoding>
              ${['utf-8', 'windows-874', 'utf-16le', 'utf-16be'].map(e => `<option value="${e}"${info.encoding.encoding === e ? ' selected' : ''}>${e}${e === 'windows-874' ? ' (TIS-620)' : ''}</option>`).join('')}
            </select></label>` : ''}
        ${(info.sheets || []).length > 1 ? `
          <label class="imp-inline">ชีต
            <select class="form-select form-select-sm" data-imp-sheet>
              ${info.sheets.map(s => `<option value="${esc(s.name)}"${s.name === info.sheet ? ' selected' : ''}>${esc(s.name)} (${U.num(s.rows)} แถว)</option>`).join('')}
            </select></label>` : ''}
        <div class="table-wrap imp-preview">
          <table class="table table-sm mini-table mb-0">
            <thead><tr>${r.header.slice(0, 8).map(h => `<th scope="col">${esc(h)}</th>`).join('')}${r.header.length > 8 ? '<th scope="col">…</th>' : ''}</tr></thead>
            <tbody>${r.rows.slice(0, 5).map(row => `<tr>${r.header.slice(0, 8).map(h => `<td>${esc(String(row[h] ?? '').slice(0, 40))}</td>`).join('')}${r.header.length > 8 ? '<td>…</td>' : ''}</tr>`).join('')}</tbody>
          </table>
        </div>
        <div class="lab-row mt-2">
          <button type="button" class="btn btn-sm btn-primary" data-imp-to-mapping>ต่อไป: จับคู่คอลัมน์</button>
          <button type="button" class="btn btn-sm btn-outline-secondary" data-imp-reset>เลือกไฟล์อื่น</button>
        </div>
      </div>`;
  }

  /* ---------- ขั้นที่ 3: จับคู่คอลัมน์ ---------- */

  const TIER_LABEL = { required: 'จำเป็น', important: 'สำคัญ', optional: 'เสริม' };

  function mappingHTML() {
    const r = ui.read;
    const headers = r.header;
    const saved = loadMaps();
    const sig = headerSignature(headers);

    const rows = DataIO.FIELD_SPECS.map(spec => {
      const chosen = ui.mapping[spec.key];
      const sample = chosen ? r.rows.slice(0, 3).map(x => String(x[chosen] ?? '').trim()).filter(Boolean).slice(0, 2).join(' · ') : '';
      const fromAi = ui.aiMapping && ui.aiMapping[spec.key] === chosen && chosen;
      return `<tr class="imp-map-row tier-${spec.tier}${!chosen && spec.tier === 'required' ? ' is-missing' : ''}">
        <td><span class="imp-tier tier-${spec.tier}">${TIER_LABEL[spec.tier]}</span> ${esc(spec.label)}
          <div class="small-muted"><code>${spec.key}</code></div></td>
        <td>
          <select class="form-select form-select-sm" data-imp-map="${spec.key}">
            <option value="">— ไม่ใช้ —</option>
            ${headers.map(h => `<option value="${esc(h)}"${h === chosen ? ' selected' : ''}>${esc(h)}</option>`).join('')}
          </select>
          ${fromAi ? '<span class="imp-ai-tag">AI เสนอ</span>' : ''}
        </td>
        <td class="small-muted">${esc(sample) || '<span class="imp-empty">—</span>'}</td>
      </tr>`;
    }).join('');

    const missing = DataIO.FIELD_SPECS.filter(s => s.tier === 'required' && !ui.mapping[s.key]);

    return `
      <div class="imp-map">
        <div class="card-title-row mt-2"><h3 class="h6 mb-0">จับคู่คอลัมน์</h3>
          <span class="small-muted">${headers.length} คอลัมน์ในไฟล์</span></div>
        <div class="lab-row mb-2">
          <button type="button" class="btn btn-sm btn-outline-secondary" data-imp-guess>เดาอัตโนมัติอีกครั้ง</button>
          <button type="button" class="mp-btn is-ai" data-imp-ai-map title="ส่งเฉพาะชื่อคอลัมน์และตัวอย่าง 3 แถวให้ AI เสนอการจับคู่ แล้วคุณกดยืนยันเอง">✨ ให้ AI ช่วยจับคู่</button>
          ${saved[sig] ? `<button type="button" class="btn btn-sm btn-outline-secondary" data-imp-load-map>ใช้แม่แบบที่บันทึกไว้</button>` : ''}
          <button type="button" class="btn btn-sm btn-outline-secondary" data-imp-save-map>บันทึกเป็นแม่แบบ</button>
        </div>
        ${missing.length ? `<div class="ai-warn mb-2">ยังไม่ได้จับคู่ฟิลด์ที่จำเป็น: ${missing.map(s => esc(s.label)).join(' · ')}</div>` : ''}
        <div class="table-wrap imp-map-wrap">
          <table class="table table-sm mini-table mb-0">
            <thead><tr><th scope="col">ฟิลด์ของระบบ</th><th scope="col">คอลัมน์ในไฟล์</th><th scope="col">ตัวอย่างค่า</th></tr></thead>
            <tbody>${rows}</tbody>
          </table>
        </div>
        <div class="lab-row mt-2">
          <button type="button" class="btn btn-sm btn-primary" data-imp-normalize ${missing.length ? 'disabled' : ''}>ตรวจคุณภาพข้อมูล</button>
        </div>
      </div>`;
  }

  /* ---------- รายงานคุณภาพ ---------- */

  function reportHTML() {
    if (!ui.result) return '';
    const rep = ui.result.report;
    const recs = ui.result.records;

    const covRows = Object.entries(rep.coverage)
      .filter(([, c]) => c.mapped || c.tier !== 'optional')
      .map(([key, c]) => `<tr class="${c.mapped && c.pct < 0.5 ? 'is-low' : ''}">
        <td>${esc(c.label)}</td>
        <td class="text-end">${c.mapped ? pct(c.pct) : '<span class="small-muted">ไม่ได้จับคู่</span>'}</td>
        <td><span class="imp-bar"><i style="width:${(c.pct * 100).toFixed(1)}%"></i></span></td>
        <td class="small-muted">${(rep.badValues[key] || []).length ? `อ่านไม่ได้ เช่น ${esc((rep.badValues[key] || []).join(' · ').slice(0, 60))}` : ''}</td>
      </tr>`).join('');

    const df = rep.dateFormats.contract_date || {};
    const dateBits = [['thai', 'ไทยย่อ'], ['iso', 'ISO'], ['slash', 'ทับ/ขีด'], ['excel', 'Excel'], ['bad', 'อ่านไม่ได้'], ['empty', 'ว่าง']]
      .filter(([k]) => df[k]).map(([k, label]) => `${label} ${U.num(df[k])}`).join(' · ');

    return `
      <div class="imp-report">
        <div class="card-title-row mt-3"><h3 class="h6 mb-0">ผลการตรวจก่อนนำเข้า</h3>
          <span class="badge badge-derived">คำนวณในเบราว์เซอร์</span></div>

        <div class="ma-kpis imp-kpis">
          <div><span>แถวที่ใช้ได้</span><b>${U.num(rep.kept)}</b><em>จาก ${U.num(rep.inputRows)} แถว${rep.dropped ? ` · ทิ้ง ${U.num(rep.dropped)}` : ''}</em></div>
          <div><span>ช่วงวันที่ทำสัญญา</span><b>${rep.dateMin ? U.thaiDate(rep.dateMin) : '-'}</b><em>ถึง ${rep.dateMax ? U.thaiDate(rep.dateMax) : '-'}</em></div>
          <div><span>มีพิกัด</span><b>${pct(rep.geoPct)}</b><em>${U.num(rep.withGeo)} สัญญา${rep.geoMeta && rep.geoMeta.shared_rows ? ` · ใช้พิกัดร่วม ${U.num(rep.geoMeta.shared_rows)}` : ''}</em></div>
          <div class="${rep.dupes ? 'is-warn' : ''}"><span>คีย์สัญญาซ้ำ</span><b>${U.num(rep.dupes)}</b><em>${rep.dupes ? 'ตรวจว่าไฟล์มีแถวซ้ำหรือไม่' : 'ไม่พบ'}</em></div>
        </div>

        ${rep.dropped ? `<p class="ma-note">แถวที่ทิ้ง: ${Object.entries(rep.dropReasons).map(([k, v]) => `${esc(k)} ${U.num(v)}`).join(' · ')}</p>` : ''}
        ${dateBits ? `<p class="ma-note">รูปแบบวันที่ทำสัญญาที่พบ — ${dateBits}</p>` : ''}
        ${!rep.hasSpecificMethod && rep.methods.length ? `
          <div class="ai-warn">ไม่พบวิธีจัดหาที่มีคำว่า "เฉพาะเจาะจง" ในข้อมูลชุดนี้ — กฎ R8 R12 และ R22 เทียบชื่อวิธีจัดหาแบบตรงตัว
            ถ้าคำในไฟล์เขียนต่างออกไป กฎเหล่านี้จะไม่ทำงานโดยไม่มีข้อความแจ้ง · ค่าที่พบมากที่สุดคือ
            ${rep.methods.slice(0, 3).map(m => `<code>${esc(m.name || '(ว่าง)')}</code>`).join(' ')}</div>` : ''}

        <details class="lab-section"><summary>ความครบของแต่ละฟิลด์</summary>
          <div class="table-wrap"><table class="table table-sm mini-table mb-0 imp-cov">
            <thead><tr><th scope="col">ฟิลด์</th><th scope="col" class="text-end">มีค่า</th><th scope="col">สัดส่วน</th><th scope="col">หมายเหตุ</th></tr></thead>
            <tbody>${covRows}</tbody></table></div>
        </details>

        <details class="lab-section" open><summary>กฎที่จะทำงานได้กับชุดข้อมูลนี้</summary>
          ${rulesReadyHTML(recs)}
        </details>

        <details class="lab-section"><summary>ตัวอย่าง 20 แถวแรกหลังแปลงค่า</summary>
          <div class="table-wrap"><table class="table table-sm mini-table mb-0">
            <thead><tr><th scope="col">โครงการ</th><th scope="col">หน่วยงาน</th><th scope="col">ผู้รับจ้าง</th><th scope="col" class="text-end">มูลค่า</th><th scope="col">วันที่</th><th scope="col">กลุ่มงาน</th></tr></thead>
            <tbody>${recs.slice(0, 20).map(r => `<tr>
              <td>${esc(String(r.project_name).slice(0, 48))}</td>
              <td>${esc(String(r.dept_name).slice(0, 26))}</td>
              <td>${esc(String(r.winner_name).slice(0, 26))}</td>
              <td class="text-end">${U.money(r.contract_price_agree)}</td>
              <td>${r.contract_date ? U.thaiDate(r.contract_date) : '<span class="ai-warn">-</span>'}</td>
              <td>${esc(DataIO.WORK_GROUP_LABELS[r.work_group] || r.work_group)}</td></tr>`).join('')}</tbody>
          </table></div>
        </details>
      </div>`;
  }

  /** ตรวจว่ากฎแต่ละข้อมีฟิลด์ครบไหม โดยอ่านรายการฟิลด์ที่ Rules.DOCS ประกาศไว้
   *  แล้วรันจริงบนตัวอย่าง 2,000 แถว (สำเนา ไม่แตะข้อมูลที่แอปใช้อยู่) เพื่อดูว่าติดกี่รายการ */
  function rulesReadyHTML(records) {
    const sample = records.slice(0, 2000).map(r => ({ ...r }));
    let hits = {};
    try {
      const ctx = Rules.buildContext(sample);
      const settings = Rules.defaultSettings();
      Rules.evaluate(sample, ctx, settings);
      for (const r of sample) for (const h of (r.rule_hits || [])) hits[h.rule_id] = (hits[h.rule_id] || 0) + 1;
    } catch (err) {
      return `<div class="ai-warn">ทดลองรันกฎไม่สำเร็จ: ${esc(err.message || String(err))}</div>`;
    }

    // กฎที่ใช้บริบททั้งชุด (นับจำนวนซ้ำ คู่หน่วยงาน-ผู้รับจ้าง ฯลฯ) จะได้ผลต่ำกว่าจริงเมื่อดูแค่ตัวอย่าง
    const contextual = new Set(['R3', 'R8', 'R10', 'R15', 'R18', 'R20', 'R22']);
    const rows = Rules.DEFS.filter(d => d.source === 'real').map(d => {
      const fields = (Rules.DOCS[d.id] && Rules.DOCS[d.id].fields) || [];
      const missing = fields.filter(f => {
        if (!(f in (records[0] || {}))) return false;   // ฟิลด์ที่ ETL สร้าง เช่น lat/geo_quality ตรวจจากค่าจริงแทน
        return records.every(r => r[f] === null || r[f] === undefined || r[f] === '');
      });
      const n = hits[d.id] || 0;
      const status = missing.length ? 'no' : n > 0 ? 'yes' : 'maybe';
      return `<tr>
        <td><b>${d.id}</b> ${esc(d.name)}</td>
        <td>${status === 'no' ? '<span class="badge badge-none">ไม่ทำงาน</span>'
          : status === 'yes' ? '<span class="badge badge-low">ทำงานได้</span>'
            : '<span class="badge badge-medium">ไม่ติดในตัวอย่าง</span>'}</td>
        <td class="text-end">${n ? U.num(n) : '-'}${contextual.has(d.id) && n ? '*' : ''}</td>
        <td class="small-muted">${missing.length ? `ไม่มีค่าในฟิลด์ ${missing.map(esc).join(', ')}` : ''}</td>
      </tr>`;
    }).join('');

    return `<div class="table-wrap"><table class="table table-sm mini-table mb-0">
        <thead><tr><th scope="col">กฎ</th><th scope="col">สถานะ</th><th scope="col" class="text-end">ติดในตัวอย่าง</th><th scope="col">หมายเหตุ</th></tr></thead>
        <tbody>${rows}</tbody></table></div>
      <p class="ma-note">ทดลองกับ ${U.num(Math.min(2000, records.length))} แถวแรกด้วยเกณฑ์เริ่มต้น ตัวเลขจึงเป็นการประมาณ ·
        * กฎที่ต้องดูทั้งชุดข้อมูล (เช่น นับสัญญาซ้ำในโครงการเดียวกัน) จะติดน้อยกว่าความเป็นจริงเมื่อดูแค่ตัวอย่าง ·
        R5 และ R6 เป็นกฎสาธิตที่ต้องใช้ฟิลด์สังเคราะห์ จึงไม่อยู่ในรายการนี้</p>`;
  }

  /* ---------- ยืนยันนำเข้า ---------- */

  function commitHTML() {
    if (!ui.result) return '';
    const n = ui.result.records.length;
    const cur = api.getDataset();
    const big = n > ROW_WARN;
    return `
      <div class="imp-commit">
        <div class="card-title-row mt-3"><h3 class="h6 mb-0">นำเข้า</h3></div>
        <label class="ai-field-label" for="impName">ชื่อชุดข้อมูล</label>
        <input class="form-control form-control-sm" id="impName" value="${esc(ui.name)}" placeholder="เช่น e-GP ปีงบ 2569 กรมทางหลวง">
        <div class="imp-merge mt-2">
          <div class="ai-field-label">วิธีรวมกับชุดที่ใช้อยู่ (${esc(cur.name)} · ${U.num(api.getRecords().length)} สัญญา)</div>
          ${Object.entries(DataIO.MERGE_MODES).map(([k, label]) => `
            <label class="imp-radio"><input type="radio" name="impMerge" value="${k}"${ui.merge === k ? ' checked' : ''}>
              <span>${esc(label)}</span></label>`).join('')}
          ${ui.merge !== 'replace' ? `<div class="small-muted mt-1">
            ${ui.merge === 'append' ? 'ต่อท้ายจะทำให้สัญญาที่ซ้ำกันถูกนับสองครั้ง และกฎ R3/R20 อาจติดเพิ่มโดยไม่ใช่ความเสี่ยงจริง'
              : 'อัปเดตตามคีย์: จับคู่ด้วย รหัสโครงการ + เลขที่สัญญา + เลขผู้เสียภาษี (ไม่รวมมูลค่า เพื่อให้เห็นสัญญาที่ตัวเลขเปลี่ยน) ฟิลด์ที่ชุดใหม่ไม่มีค่าจะคงของเดิมไว้'}</div>` : ''}
          ${mergeDiffHTML()}
        </div>
        ${big ? `<div class="ai-warn mt-2">ชุดข้อมูลนี้มี ${U.num(n)} แถว ซึ่งใหญ่กว่าที่ระบบเคยทดสอบไว้ (10,174 แถว) กราฟและตารางอาจวาดช้าลง</div>` : ''}
        ${n > ROW_MAX ? `<div class="ai-error mt-2">เกิน ${U.num(ROW_MAX)} แถว ระบบจะนำเข้าเฉพาะส่วนแรกเท่านั้น</div>` : ''}
        <div class="lab-row mt-2">
          <button type="button" class="btn btn-primary" data-imp-commit>นำเข้าและใช้ชุดนี้ทั้งแอป</button>
          <button type="button" class="btn btn-sm btn-outline-secondary" data-imp-download-json>ดาวน์โหลดเป็นไฟล์ชุดข้อมูล</button>
        </div>
      </div>`;
  }

  /** สรุปส่วนต่างก่อนกดยืนยัน — คำนวณสดเพราะผู้ใช้เปลี่ยนโหมดรวมได้ตลอด
   *  จุดที่ต้องบอกให้ชัดคือ "แก้ไขกี่รายการ และแก้ฟิลด์ไหน" ไม่ใช่แค่จำนวนรวม */
  function mergeDiffHTML() {
    if (ui.merge === 'replace' || !ui.result) return '';
    const base = api.getRecords();
    if (!base.length) return '';
    const { diff } = DataIO.mergeRecords(base, ui.result.records, ui.merge);
    const fields = Object.entries(diff.changedFields).sort((a, b) => b[1] - a[1]).slice(0, 6);
    const labelOf = k => (DataIO.FIELD_SPECS.find(s => s.key === k) || {}).label || k;
    return `
      <div class="imp-diff">
        <div class="imp-diff-line">
          <span class="imp-diff-n is-add">+${U.num(diff.added)}</span> รายการใหม่ ·
          <span class="imp-diff-n is-upd">${U.num(diff.updated)}</span> รายการที่ถูกแก้ ·
          <span class="imp-diff-n">${U.num(diff.kept)}</span> คงเดิม ·
          รวมเป็น <strong>${U.num(base.length + diff.added)}</strong> สัญญา
        </div>
        ${fields.length ? `<div class="small-muted">ฟิลด์ที่เปลี่ยนมากที่สุด: ${fields.map(([k, n]) => `${esc(labelOf(k))} ${U.num(n)}`).join(' · ')}</div>` : ''}
        ${(diff.examples || []).length ? `<ul class="imp-diff-ex">${diff.examples.map(x =>
          `<li>[${esc(x.project_id)}] มูลค่า ${U.money(x.from)} → <strong>${U.money(x.to)}</strong></li>`).join('')}</ul>` : ''}
      </div>`;
  }

  /* ---------- การ์ดขวา: ชุดข้อมูลของฉัน / เครื่องมือ ---------- */

  function datasetsHTML() {
    const cur = api.getDataset();
    const rows = ui.datasets.map(d => `
      <div class="imp-ds ${d.id === cur.id ? 'is-on' : ''}">
        <div class="imp-ds-main">
          <b>${esc(d.name)}</b>
          <span class="small-muted">${U.num(d.n_records)} สัญญา · ${fileSize(d.bytes || 0)} · นำเข้า ${U.thaiDate(String(d.created).slice(0, 10))}
            ${d.origin && d.origin.source ? ` · ${esc(d.origin.source)}` : ''}</span>
        </div>
        <div class="imp-ds-actions">
          ${d.id === cur.id ? '<span class="badge badge-low">กำลังใช้</span>'
            : `<button type="button" class="btn btn-sm btn-outline-primary" data-imp-use="${d.id}">ใช้ชุดนี้</button>`}
          <button type="button" class="btn btn-sm btn-outline-secondary" data-imp-rename="${d.id}" title="เปลี่ยนชื่อ">✎</button>
          <button type="button" class="btn btn-sm btn-outline-secondary" data-imp-export="${d.id}" title="ดาวน์โหลดเป็นไฟล์">⬇</button>
          <button type="button" class="btn btn-sm btn-outline-danger" data-imp-delete="${d.id}" title="ลบ">✕</button>
        </div>
      </div>`).join('');

    const st = ui.storage;
    return `
      <div class="card-title-row"><h2 class="h6 mb-0">ชุดข้อมูลของฉัน</h2>
        <span class="small-muted">${ui.datasets.length ? `${ui.datasets.length} ชุด` : ''}</span></div>
      <div class="imp-ds ${cur.id === 'base' ? 'is-on' : ''}">
        <div class="imp-ds-main"><b>ชุดข้อมูลหลักของระบบ</b>
          <span class="small-muted">มากับแอป · มีผลโมเดลครบทุกส่วน</span></div>
        <div class="imp-ds-actions">
          ${cur.id === 'base' ? '<span class="badge badge-low">กำลังใช้</span>'
            : '<button type="button" class="btn btn-sm btn-outline-primary" data-imp-use-base>กลับชุดหลัก</button>'}
        </div>
      </div>
      ${rows || '<p class="ma-note">ยังไม่มีชุดข้อมูลที่นำเข้า</p>'}
      ${st ? `<p class="ma-note">พื้นที่ที่เบราว์เซอร์ให้ใช้: ใช้ไป ${fileSize(st.usage)} จาก ${fileSize(st.quota)}</p>` : ''}`;
  }

  function toolsHTML() {
    return `
      <div class="card-title-row"><h2 class="h6 mb-0">ส่งต่อให้ ETL เพื่อให้ได้ผลโมเดลครบ</h2></div>
      <p class="small-muted">ชุดข้อมูลที่นำเข้าในเบราว์เซอร์คำนวณผลโมเดล Python ไม่ได้
        ถ้าต้องการ Isolation Forest แบบจำลองส่วนลด ราคาถนนต่อ ตร.ม. และดัชนีเครือข่าย ให้ทำสองขั้นนี้</p>
      <ol class="imp-steps-list">
        <li>ส่งออกชุดข้อมูลที่ใช้อยู่เป็นไฟล์ที่ ETL อ่านได้
          <div class="lab-row mt-1"><button type="button" class="btn btn-sm btn-outline-secondary" data-imp-raw-csv>⬇ ส่งออก raw_data.csv</button></div></li>
        <li>วางไฟล์ไว้ในโฟลเดอร์โปรเจกต์แล้วสั่ง
          <div class="imp-url"><code id="impEtlCmd">python tools/build_data.py --input raw_data.csv</code>
            <button type="button" class="btn btn-sm btn-outline-secondary" data-imp-copy="impEtlCmd">คัดลอก</button></div>
          <span class="small-muted">จะได้ <code>data/data.json</code> ชุดใหม่ที่มีผลโมเดลครบ แล้วกลับมาที่ "ชุดข้อมูลหลักของระบบ"</span></li>
      </ol>
      <details class="imp-help mt-2">
        <summary>ข้อจำกัดที่ต้องรู้ก่อนส่งออก</summary>
        <p class="mb-0 small-muted">ชุดข้อมูลที่ ETL สร้างเก็บพิกัดไว้เป็นละติจูด/ลองจิจูดที่คำนวณแล้ว
          ไม่ได้เก็บรูปเรขาคณิตดั้งเดิม (POLYGON/LINESTRING) ไว้ การส่งออกจึงเขียนกลับเป็นจุด <code>POINT</code> ของจุดกึ่งกลาง
          ผลคือกติกา "พิกัดใช้ร่วมหลายโครงการ" ซึ่งจับกลุ่มจากข้อความพิกัดตรงตัว จะนับได้ต่างจากเดิมเล็กน้อย
          (ชุดข้อมูลหลักปัจจุบัน 1,702 แถว เมื่อส่งออกแล้วสร้างใหม่จะได้ 1,766 แถว ต่างกัน 0.6%)
          ส่วนตัวเลขอื่นทั้งหมด — จำนวนสัญญา มูลค่ารวม คะแนนความเสี่ยง และจำนวนที่ติดกฎแต่ละข้อ — ตรงกันทุกตัว</p>
      </details>`;
  }

  /* ---------- การทำงาน ---------- */

  async function handleFile(file, { encoding, sheet } = {}) {
    if (!file) return;
    setBusy(`กำลังอ่าน ${file.name}...`);
    ui.error = null;
    try {
      const read = await DataIO.readFile(file, { encoding, sheet, maxRows: ROW_MAX });
      read.file = file;
      ui.read = read;
      ui.name = ui.name || file.name.replace(/\.[^.]+$/, '');
      ui.mapping = DataIO.guessMapping(read.header).map;
      ui.result = null;
      ui.step = 2;
      ui.busy = '';

      // ไฟล์ที่ส่งออกจากระบบนี้ (หรือ data.json) ข้ามการจับคู่ได้เลย
      if (read.payload) {
        ui.directPayload = read.payload;
        ui.step = 3;
        ui.result = { records: read.payload.records || [], report: quickReportFromPayload(read.payload) };
      } else ui.directPayload = null;

      render();
    } catch (err) { fail(err); }
  }

  function quickReportFromPayload(payload) {
    const recs = payload.records || [];
    const dates = recs.map(r => r.contract_date).filter(Boolean).sort();
    const withGeo = recs.filter(r => r.lat !== null && r.lat !== undefined).length;
    return {
      inputRows: recs.length, kept: recs.length, dropped: 0, dropReasons: {}, coverage: {}, dateFormats: {}, badValues: {},
      dupes: 0, dateMin: dates[0] || null, dateMax: dates[dates.length - 1] || null,
      withGeo, geoPct: recs.length ? withGeo / recs.length : 0, geoMeta: (payload.models || {}).geo || null,
      methods: [], hasSpecificMethod: true, negativeMoney: 0, backwardDates: 0, direct: true,
    };
  }

  function normalizeNow() {
    setBusy('กำลังแปลงค่าและตรวจคุณภาพ...');
    setTimeout(() => {
      try {
        const rows = ui.read.rows;
        ui.result = DataIO.normalize(rows, ui.mapping);
        ui.step = 3;
        ui.busy = '';
        render();
      } catch (err) { fail(err); }
    }, 30);
  }

  async function commit() {
    if (!ui.result) return;
    const can = Datasets.available();
    if (!can.ok) return fail(new DataIO.ImportError('เก็บชุดข้อมูลไม่ได้', { hint: can.reason }));

    // ต้องอ่านชื่อก่อน setBusy เพราะ setBusy วาดการ์ดใหม่ ช่องกรอกเดิมจะหายไปพร้อมค่าที่พิมพ์ไว้
    const typedName = (el('impName') && el('impName').value.trim()) || '';
    setBusy('กำลังบันทึกชุดข้อมูล...');
    try {
      const incoming = ui.result.records.slice(0, ROW_MAX);
      const base = ui.merge === 'replace' ? [] : api.getRecords();
      const merged = DataIO.mergeRecords(base, incoming, ui.merge);

      let payload;
      if (ui.directPayload && ui.merge === 'replace') {
        payload = ui.directPayload;                        // ไฟล์ที่ส่งออกจากระบบนี้ ใช้ payload เดิมทั้งก้อน (มีผลโมเดลติดมาด้วยถ้ามี)
      } else {
        const geoMeta = DataIO.deriveGeoQuality(merged.records);
        payload = DataIO.buildPayload(merged.records, {
          sourceFile: (ui.read && ui.read.info.fileName) || 'นำเข้า',
          origin: { kind: 'import', source: ui.source || 'file', file: (ui.read && ui.read.info.fileName) || '', imported_at: new Date().toISOString(), merge: ui.merge },
          geoMeta,
          syntheticDemo: api.getSyntheticDemo(),
          pipeline: {
            version: 1,
            encoding: ui.read && ui.read.info.encoding ? ui.read.info.encoding.encoding : null,
            delimiter: ui.read ? ui.read.info.delimiter || null : null,
            mapping: ui.mapping, merge: ui.merge,
          },
        });
      }

      const name = typedName || ui.name || 'ชุดข้อมูลนำเข้า';
      const entry = await Datasets.put(payload, { name, origin: payload.meta.origin });
      Datasets.setActive(entry);
      api.activate(payload, { id: entry.id, name: entry.name, kind: 'import' });

      ui.step = 1; ui.read = null; ui.result = null; ui.directPayload = null; ui.busy = '';
      ui.notice = `นำเข้า "${name}" แล้ว · ${U.num((payload.records || []).length)} สัญญา — ทุกแท็บใช้ชุดนี้แล้ว`;
      await refreshDatasets();
      render();
    } catch (err) {
      fail(err.name === 'QuotaExceededError'
        ? new DataIO.ImportError('พื้นที่เก็บข้อมูลในเบราว์เซอร์ไม่พอ', { hint: 'ลบชุดข้อมูลเก่าที่ไม่ใช้แล้วลองใหม่' })
        : err);
    }
  }

  async function useDataset(id) {
    setBusy('กำลังเปิดชุดข้อมูล...');
    try {
      const payload = await Datasets.get(id);
      const meta = await Datasets.getMeta(id);
      if (!payload) throw new DataIO.ImportError('ไม่พบชุดข้อมูลนี้แล้ว');
      Datasets.setActive(meta);
      api.activate(payload, { id, name: meta.name, kind: 'import' });
      ui.busy = '';
      ui.notice = `เปลี่ยนไปใช้ "${meta.name}" แล้ว`;
      render();
    } catch (err) { fail(err); }
  }

  async function useBase() {
    setBusy('กำลังกลับไปชุดข้อมูลหลัก...');
    try {
      const payload = await api.fetchBase();
      Datasets.setActive(null);
      api.activate(payload, { id: 'base', name: 'ชุดข้อมูลหลักของระบบ', kind: 'base' });
      ui.busy = '';
      ui.notice = 'กลับมาใช้ชุดข้อมูลหลักแล้ว';
      render();
    } catch (err) { fail(err); }
  }

  async function refreshDatasets() {
    ui.datasets = await Datasets.list();
    ui.storage = await Datasets.estimate();
  }

  /** ให้ AI เสนอการจับคู่ — ส่งเฉพาะชื่อคอลัมน์และตัวอย่าง 3 แถว ไม่ส่งข้อมูลทั้งไฟล์ */
  async function aiMap() {
    if (!api.aiReady()) { api.openAISettings(); return; }
    setBusy('กำลังให้ AI อ่านชื่อคอลัมน์...');
    try {
      const headers = ui.read.header;
      const samples = ui.read.rows.slice(0, 3).map(row => Object.fromEntries(headers.map(h => [h, String(row[h] ?? '').slice(0, 40)])));
      const fields = DataIO.FIELD_SPECS.map(s => `${s.key} = ${s.label}`).join('\n');
      const system = 'คุณช่วยจับคู่คอลัมน์ของไฟล์ข้อมูลจัดซื้อจัดจ้างภาครัฐไทยกับฟิลด์ของระบบ ' +
        'ตอบเป็น JSON ก้อนเดียวเท่านั้น รูปแบบ {"field_key":"ชื่อคอลัมน์ในไฟล์ หรือ null"} ' +
        'ห้ามเดาถ้าไม่มั่นใจ ให้ใส่ null · ห้ามสร้างชื่อคอลัมน์ที่ไม่มีในรายการ';
      const prompt = `ฟิลด์ของระบบ:\n${fields}\n\nคอลัมน์ในไฟล์: ${headers.join(' | ')}\n\nตัวอย่าง 3 แถว:\n${JSON.stringify(samples, null, 1)}`;
      const text = await api.aiAsk(system, prompt);
      const json = AI.extractJSON(text);
      if (!json) throw new DataIO.ImportError('AI ไม่ได้ตอบเป็น JSON ที่อ่านได้');
      const proposal = {};
      for (const spec of DataIO.FIELD_SPECS) {
        const v = json[spec.key];
        proposal[spec.key] = typeof v === 'string' && headers.includes(v) ? v : null;
      }
      ui.aiMapping = proposal;
      for (const [k, v] of Object.entries(proposal)) if (v) ui.mapping[k] = v;
      ui.busy = '';
      ui.notice = 'AI เสนอการจับคู่แล้ว ตรวจสอบและแก้ได้ก่อนกดต่อไป';
      render();
    } catch (err) { fail(err); }
  }

  function downloadRawCSV() {
    const records = api.getRecords();
    if (!records.length) return;
    U.downloadCSV(`raw_data-${new Date().toISOString().slice(0, 10)}.csv`,
      DataIO.RAW_COLUMNS, DataIO.toRawRows(records));
  }

  async function exportDataset(id) {
    const payload = await Datasets.get(id);
    const meta = await Datasets.getMeta(id);
    if (!payload) return;
    const blob = new Blob([JSON.stringify(payload)], { type: 'application/json' });
    api.download(blob, `${(meta.name || 'dataset').replace(/[\\/:*?"<>|]/g, '_')}.json`);
  }

  /* ---------- ผูกเหตุการณ์ (delegation ที่ระดับแท็บ วาดใหม่ได้โดยไม่ต้องผูกซ้ำ) ---------- */

  function wire() {
    const pane = el('tab-import');
    if (!pane) return;

    pane.addEventListener('click', async e => {
      const t = e.target.closest('button, [data-imp-source]');
      if (!t) return;
      const d = t.dataset;

      if ('impReset' in d) { ui.step = 1; ui.read = null; ui.result = null; ui.error = null; ui.directPayload = null; render(); }
      else if (d.impSource) { ui.source = d.impSource; ui.step = 1; render(); }
      else if ('impPasteGo' in d) {
        const text = el('impPaste').value.trim();
        if (!text) return;
        const file = new File([text], 'paste.json', { type: 'application/json' });
        handleFile(file);
      } else if ('impToMapping' in d) { ui.step = 3; render(); }
      else if ('impGuess' in d) { ui.mapping = DataIO.guessMapping(ui.read.header).map; ui.aiMapping = null; render(); }
      else if ('impAiMap' in d) aiMap();
      else if ('impSaveMap' in d) {
        const maps = loadMaps();
        maps[headerSignature(ui.read.header)] = ui.mapping;
        saveMaps(maps);
        ui.notice = 'บันทึกแม่แบบการจับคู่แล้ว ครั้งหน้าไฟล์หน้าตาเดียวกันจะใช้ได้ทันที';
        render();
      } else if ('impLoadMap' in d) {
        const maps = loadMaps();
        const saved = maps[headerSignature(ui.read.header)];
        if (saved) { ui.mapping = { ...ui.mapping, ...saved }; render(); }
      } else if ('impNormalize' in d) normalizeNow();
      else if ('impCommit' in d) commit();
      else if ('impDownloadJson' in d) {
        const geoMeta = DataIO.deriveGeoQuality(ui.result.records);
        const payload = ui.directPayload || DataIO.buildPayload(ui.result.records, { sourceFile: ui.name, geoMeta, syntheticDemo: api.getSyntheticDemo() });
        api.download(new Blob([JSON.stringify(payload)], { type: 'application/json' }), `${(ui.name || 'dataset').replace(/[\\/:*?"<>|]/g, '_')}.json`);
      } else if (d.impUse) useDataset(d.impUse);
      else if ('impUseBase' in d) useBase();
      else if (d.impDelete) {
        if (t.dataset.confirm !== '1') { t.dataset.confirm = '1'; t.textContent = 'ยืนยัน?'; setTimeout(() => { if (document.contains(t)) { t.dataset.confirm = ''; t.textContent = '✕'; } }, 3000); return; }
        await Datasets.remove(d.impDelete);
        if (api.getDataset().id === d.impDelete) await useBase();
        await refreshDatasets();
        render();
      } else if (d.impRename) {
        const cur = ui.datasets.find(x => x.id === d.impRename);
        const name = prompt('ชื่อใหม่ของชุดข้อมูล', cur ? cur.name : '');
        if (name && name.trim()) { await Datasets.rename(d.impRename, name.trim()); await refreshDatasets(); render(); }
      } else if (d.impExport) exportDataset(d.impExport);
      else if ('impRawCsv' in d) downloadRawCSV();
      else if (d.impCopy) {
        const node = el(d.impCopy);
        try { await navigator.clipboard.writeText(node.textContent.trim()); t.textContent = 'คัดลอกแล้ว ✓'; setTimeout(() => { t.textContent = 'คัดลอก'; }, 1600); }
        catch (err) { t.textContent = 'คัดลอกไม่ได้'; }
      }
    });

    pane.addEventListener('change', e => {
      const t = e.target;
      if (t.id === 'impFile') { handleFile(t.files && t.files[0]); t.value = ''; }
      else if (t.dataset.impMap !== undefined) { ui.mapping[t.dataset.impMap] = t.value || null; ui.result = null; render(); }
      else if (t.dataset.impEncoding !== undefined) handleFile(ui.read.file, { encoding: t.value });
      else if (t.dataset.impSheet !== undefined) handleFile(ui.read.file, { sheet: t.value });
      else if (t.name === 'impMerge') { ui.merge = t.value; render(); }
    });

    // ลากไฟล์มาวางที่การ์ดได้เลย
    const wiz = el('importWizard');
    ['dragenter', 'dragover'].forEach(ev => wiz.addEventListener(ev, e => { e.preventDefault(); wiz.classList.add('is-drop'); }));
    ['dragleave', 'drop'].forEach(ev => wiz.addEventListener(ev, e => { e.preventDefault(); wiz.classList.remove('is-drop'); }));
    wiz.addEventListener('drop', e => {
      const file = e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files[0];
      if (file) handleFile(file);
    });
  }

  let wired = false;
  function init(hooks) { api = hooks; }

  async function renderTab() {
    if (!wired) { wire(); wired = true; }
    if (!ui.datasets.length) await refreshDatasets();
    render();
    if (ui.notice) {
      const box = el('importWizard');
      box.insertAdjacentHTML('afterbegin', `<div class="ai-ok mb-2">${esc(ui.notice)}</div>`);
      ui.notice = '';
    }
  }

  return { init, render: renderTab, refresh: refreshDatasets };
})();
