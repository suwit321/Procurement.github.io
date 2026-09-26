/* deeppattern.js — แท็บ "รูปแบบเชิงลึก" (Deep Pattern / Autoencoder)

   ผลคำนวณล่วงหน้าด้วย tools/build_deep_pattern.py เป็น data/deep_pattern.json (ไฟล์แยกจาก data/data.json)
   ไฟล์นี้ (และ deep_pattern.json) โหลดเฉพาะตอนเปิดแท็บนี้เท่านั้น — ดู loadScriptOnce + renderDeep ใน app.js

   สื่อสารกับแอปผ่าน api ที่ส่งเข้ามาตอน init เท่านั้น (แพตเทิร์นเดียวกับ cot.js / importui.js)
   ตัวช่วยที่เป็น global อยู่แล้ว (U, Rules, Analytics, Charts) เรียกใช้ตรง ๆ ได้เหมือน cot.js

   สถานะของโมเดล 3 แบบ (ไม่มี training/scoring เพราะไม่มีเซิร์ฟเวอร์):
     idle/loading -> unavailable (ไม่มีไฟล์ หรือชุดข้อมูลไม่ใช่ชุดหลัก)
                  -> stale (มีไฟล์ แต่คนละเวอร์ชันกับ data.json ที่ใช้อยู่ตอนนี้)
                  -> ready (ตรงกันทุกอย่าง)
*/
'use strict';

window.DeepPattern = (() => {

  let api = null;
  let status = 'idle';        // idle | loading | ready | stale | unavailable
  let error = '';
  let payload = null;         // { schema, meta, fields, rows }
  let byKey = null;           // Map<cartKey, compactRow>  compactRow = [i, k, s, e, f?]
  let wiredDom = false;

  const REQUIRED = ['rows', 'allRows', 'meta', 'dataset', 'tabId', 'markDirty', 'syncCot',
    'gotoTab', 'openDetail', 'openProfile', 'cartKey', 'clickable', 'cartBtn', 'workGroupLabel',
    'truncate', 'mlReasonText', 'proxyEval'];

  function init(a) {
    const missing = REQUIRED.filter(k => !(k in a));
    if (missing.length) console.error('DeepPattern.init: api ไม่ครบ ขาด:', missing.join(', '));
    api = a;
    bindDom();
  }

  /* ---------- โหลดข้อมูล (ครั้งเดียว ต่อชุดข้อมูล) ---------- */

  function fields() { return payload.fields; }               // ["i","k","s","e","f"]
  const IDX = { i: 0, k: 1, s: 2, e: 3, f: 4 };

  async function load() {
    const dataset = api.dataset();
    if (dataset.kind !== 'base') {
      status = 'unavailable';
      error = 'ชุดข้อมูลที่นำเข้าเองไม่มีผลจาก Autoencoder — ผลนี้ผูกกับ raw_data.csv ของชุดข้อมูลหลักเท่านั้น '
        + 'เปลี่ยนกลับไปใช้ชุดข้อมูลหลัก หรือรันสคริปต์กับไฟล์ต้นทางของชุดที่นำเข้าเอง';
      payload = null; byKey = null;
      return;
    }
    try {
      const res = await fetch('data/deep_pattern.json', { cache: 'no-cache' });
      if (!res.ok) throw new Error(`ไม่พบไฟล์ (HTTP ${res.status})`);
      const data = await res.json();
      if (data.schema !== 'deep_pattern/1') throw new Error('รูปแบบไฟล์ไม่ตรงกับที่แท็บนี้รองรับ (schema ' + data.schema + ')');
      payload = data;
      byKey = new Map(data.rows.map(r => [r[IDX.k], r]));
      const m = data.meta;
      const curMeta = api.meta() || {};
      const genOk = m.data_generated_at === curMeta.generated_at;
      const nOk = m.n_records === api.allRows().length;
      if (genOk && nOk) {
        status = 'ready'; error = '';
      } else {
        status = 'stale';
        error = `ไฟล์นี้คำนวณจากชุดข้อมูลคนละเวอร์ชัน (สร้างเมื่อ ${U.esc(m.trained_at || '-')} จาก ${U.num(m.n_records)} สัญญา) `
          + `ไม่ตรงกับชุดข้อมูลปัจจุบัน (${U.num(api.allRows().length)} สัญญา) — คะแนนรายสัญญาด้านล่างอาจจับคู่กับสัญญาผิดตัวหรือไม่ครบ `
          + `รันสคริปต์ใหม่กับ raw_data.csv ปัจจุบันเพื่ออัปเดต`;
      }
    } catch (e) {
      status = 'unavailable';
      error = 'ยังไม่มีผลจาก Autoencoder ในเครื่องนี้ — รัน <code>python tools/build_deep_pattern.py --input raw_data.csv</code> '
        + `เพื่อสร้าง data/deep_pattern.json (${U.esc(e && e.message || String(e))})`;
      payload = null; byKey = null;
    }
  }

  /* ---------- จับคู่ state.filtered / state.records กับผลของโมเดล ---------- */

  /** แถวหนึ่งของตารางผลลัพธ์ที่จับคู่กับ record จริงแล้ว รวมคะแนนกฎและ IF จาก record เดียวกัน (ไม่คำนวณซ้ำ) */
  function matchRows(records) {
    const out = [];
    for (const r of records) {
      const row = byKey.get(api.cartKey(r));
      if (!row) continue;
      out.push({
        record: r, i: row[IDX.i], s: row[IDX.s], e: row[IDX.e],
        f: row.length > IDX.f ? row[IDX.f] : null,
      });
    }
    return out;
  }

  /** ให้ CoT และตัวแท็บเองใช้ตัวเดียวกัน: matched ของ rows ที่ส่งมา + เกณฑ์เห็นตรงกันของ 3 engine
   *  เกณฑ์: risk_score >= 40 (ตรงกับขอบ Rules.BANDS ระดับสูง) · ml_pct >= flag_pct (95) · deep_score >= flag_pct (95) */
  function summarize(records) {
    if (status !== 'ready' && status !== 'stale') return null;
    const flagPct = payload.meta.thresholds.flag_pct;
    const matched = matchRows(records);
    for (const m of matched) {
      const r = m.record;
      const flags = [r.risk_score >= 40, r.ml_pct !== null && r.ml_pct !== undefined && r.ml_pct >= flagPct, m.s >= flagPct];
      m.agreeCount = flags.filter(Boolean).length;
      m.agreeOf = flags.length;              // เผื่ออนาคตมี engine ที่ไม่มีคะแนนสำหรับสัญญาบางฉบับ
      m.deepOnly = m.s >= flagPct && r.risk_score < 40 && !(r.ml_pct >= flagPct);
    }
    return { meta: payload.meta, matched, n: matched.length, nTotal: records.length, flagPct };
  }

  function snapshot() {
    return { status, error, payload, summarize };
  }

  /* ---------- การแสดงผล ---------- */

  const $ = id => document.getElementById(id);
  const LEVEL_LABEL = { critical: 'วิกฤต', high: 'สูง', medium: 'ปานกลาง', low: 'ต่ำ', none: 'ไม่พบสัญญาณ' };

  function renderStatusBanner() {
    const body = $('deepStatusBody');
    if (status === 'loading') { U.setHTML('deepStatusBody', '<p class="small-muted mb-0">กำลังโหลดผลจาก data/deep_pattern.json...</p>'); return; }
    if (status === 'unavailable') {
      U.setHTML('deepStatusBody', `<div class="model-missing"><strong>ยังไม่มีผลให้แสดง</strong><span>${error}</span></div>`);
      return;
    }
    const m = payload.meta;
    const v = m.verdict;
    const rows = [
      `<div>สร้างเมื่อ <b>${U.esc(m.trained_at)}</b> จากข้อมูลที่สร้าง <b>${U.esc(m.data_generated_at)}</b> · เวอร์ชันโมเดล <code>${U.esc(m.model_version)}</code></div>`,
      `<div>ให้คะแนน <b>${U.num(m.n_scored)}</b> จาก <b>${U.num(m.n_records)}</b> สัญญา (ไม่ให้คะแนน ${U.num(m.n_excluded)} สัญญาที่ราคาเป็นศูนย์หรือไม่มีราคากลาง — เป็นปัญหาข้อมูล ไม่ใช่พฤติกรรม)</div>`,
    ];
    const banners = [];
    if (status === 'stale') banners.push(`<div class="ma-note is-warn"><strong>ล้าสมัย:</strong> ${error}</div>`);
    if (v.duplicates_if) {
      banners.push(`<div class="ma-note"><strong>ผลตรงนี้ใกล้เคียงกับ Isolation Forest มาก</strong> (Spearman ${m.vs_isolation_forest.spearman}, `
        + `สัญญาณ 5% บนซ้ำกัน ${U.pct(m.vs_isolation_forest.top5pct_overlap)}) — ยังทำแท็บนี้ต่อตามที่ตกลงไว้ แต่ควรอ่านเป็นการยืนยันซ้ำ ไม่ใช่มุมมองใหม่</div>`);
    } else {
      banners.push(`<div class="ma-note is-good"><strong>ไม่ได้ซ้ำกับ Isolation Forest</strong> (Spearman ${m.vs_isolation_forest.spearman}, `
        + `5% บนซ้ำกันเพียง ${U.pct(m.vs_isolation_forest.top5pct_overlap)}) — น่าจะเห็นสัญญาณคนละชุดจริง</div>`);
    }
    if (v.mostly_linear) {
      banners.push(`<div class="ma-note"><strong>ใกล้เคียงกับ PCA เชิงเส้น</strong> (Spearman ${m.baseline_pca.spearman}) — ความไม่เป็นเส้นตรงของโมเดลนี้อาจช่วยได้ไม่มาก</div>`);
    }
    if (!v.stable) {
      const s = m.stability.vs_alt_fold_split;
      banners.push(`<div class="ma-note"><strong>ความเสถียรเมื่อเปลี่ยนวิธีแบ่งข้อมูลฝึก/ทดสอบยังไม่ถึงเกณฑ์ที่ตั้งไว้</strong> `
        + `(Spearman ${s.spearman} ต่ำกว่า 0.9 เล็กน้อย, 5% บนซ้ำกัน ${U.pct(s.top5pct_overlap)}) — อันดับต้น ๆ อาจขยับถ้าฝึกใหม่ด้วยการแบ่งข้อมูลชุดอื่น อ่านเป็นแนวโน้ม ไม่ใช่อันดับตายตัว</div>`);
    }
    U.setHTML('deepStatusBody', rows.join('') + banners.join(''));
  }

  function renderOverview() {
    const m = payload.meta;
    const arch = m.architecture;
    U.setHTML('deepOverviewKpis', [
      ['สถาปัตยกรรม', arch.layers.join('-')],
      ['ฟีเจอร์', `${m.features.length} ตัว`],
      ['ฝึกต่อโมเดล', `~${m.folds[0].n_train} ราย`],
      ['ให้คะแนนแบบ out-of-fold', `${U.num(m.n_scored)} ราย`],
      ['ensemble', `${m.training.folds} fold × ${m.training.seeds_per_fold} seed`],
      ['ระดับ Unusual Pattern', `≥ P${m.thresholds.strong_pct} (${U.num(m.thresholds.n_ge99)} ราย)`],
    ].map(([label, v]) => `<div><span>${U.esc(label)}</span><b>${U.esc(String(v))}</b></div>`).join(''));
    U.setHTML('deepOverviewNote',
      `ให้คะแนนแบบ out-of-fold: แบ่งข้อมูลเป็น ${m.training.folds} ส่วน แต่ละสัญญาได้คะแนนจากโมเดลที่ไม่เคยเห็นสัญญานั้นตอนฝึก `
      + `(ไม่ใช่โมเดลเดียวฝึกครั้งเดียวแล้วให้คะแนนข้อมูลของตัวเอง) · มาตรฐานฟีเจอร์: ${U.esc(arch.standardize)} · `
      + `ไม่ใช้ผลของกฎ R1-R22 หรือ Isolation Forest เลยในการฝึก เพื่อให้เป็นความเห็นอิสระ`);
  }

  const state = { filterLevel: 'all', page: 0, pageSize: 25, lastMatched: [] };

  function rowsForFilter(sn) {
    const flagPct = sn.flagPct;
    switch (state.filterLevel) {
      case 'ge99': return sn.matched.filter(m => m.s >= sn.meta.thresholds.strong_pct);
      case 'ge95': return sn.matched.filter(m => m.s >= flagPct);
      case 'agree': return sn.matched.filter(m => m.agreeCount >= 2);
      case 'onlydeep': return sn.matched.filter(m => m.deepOnly);
      default: return sn.matched;
    }
  }

  function renderSummaryAndTable() {
    const sn = summarize(api.rows());
    if (!sn) return;
    const flagPct = sn.flagPct;
    const ge99 = sn.matched.filter(m => m.s >= sn.meta.thresholds.strong_pct);
    const ge95 = sn.matched.filter(m => m.s >= flagPct);
    const agree = sn.matched.filter(m => m.agreeCount >= 2);
    const deepOnly = sn.matched.filter(m => m.deepOnly);
    U.setHTML('deepSummaryKpis', [
      ['สัญญาในขอบเขตที่มีคะแนน', `${U.num(sn.n)} จาก ${U.num(sn.nTotal)}`],
      [`Unusual Pattern (≥ P${sn.meta.thresholds.strong_pct})`, U.num(ge99.length)],
      [`Requires Further Review (≥ P${flagPct})`, U.num(ge95.length)],
      ['ทุก engine เห็นตรงกัน (≥ 2 จาก 3)', U.num(agree.length)],
      ['Deep จับได้ตัวเดียว', U.num(deepOnly.length)],
    ].map(([label, v]) => `<div><span>${U.esc(label)}</span><b>${U.esc(String(v))}</b></div>`).join(''));
    U.setHTML('deepSummaryNote',
      `นับเฉพาะสัญญาที่อยู่ในตัวกรองส่วนกลางตอนนี้ (${U.num(sn.nTotal)} สัญญา) และมีคะแนนจากโมเดล — `
      + `ตัวเลขในตารางด้านล่างคือรายการเดียวกับที่นับในนี้ ระดับ ≥ P${sn.meta.thresholds.strong_pct}/P${flagPct} เป็นเปอร์เซ็นไทล์ของทั้งชุดข้อมูล ไม่ใช่ของขอบเขตที่กรองอยู่`);

    state.lastMatched = rowsForFilter(sn).slice().sort((a, b) => b.s - a.s);
    state.page = 0;
    U.$('deepTableCount').textContent = `${U.num(state.lastMatched.length)} รายการ`;
    renderTablePage();
  }

  function renderTablePage() {
    const total = state.lastMatched.length;
    const pages = Math.max(1, Math.ceil(total / state.pageSize));
    state.page = Math.min(state.page, pages - 1);
    const start = state.page * state.pageSize;
    const slice = state.lastMatched.slice(start, start + state.pageSize);
    U.setHTML('deepTableBody', slice.map(m => {
      const r = m.record;
      const band = Rules.band(r.risk_score);
      return `<tr class="ub-row" data-deep-key="${U.esc(api.cartKey(r))}" tabindex="0" role="button" title="กดเพื่อดูรายละเอียด">
        <td>${api.clickable('project', r.project_id, api.truncate(r.project_name, 46))}</td>
        <td class="text-end" data-sort="${m.s}">${m.s.toFixed(1)}</td>
        <td class="text-end" data-sort="${r.risk_score}"><span class="badge ${band.cls}">${U.num(r.risk_score)}</span></td>
        <td class="text-end" data-sort="${r.ml_pct ?? -1}">${r.ml_pct === null || r.ml_pct === undefined ? '-' : r.ml_pct.toFixed(1)}</td>
        <td>${m.agreeCount}/${m.agreeOf}</td>
      </tr>`;
    }).join('') || U.emptyRow(5, 'ไม่มีสัญญาตามตัวกรองนี้'));
    U.$('deepPagerLabel').textContent = total ? `หน้า ${state.page + 1} / ${pages} (${U.num(total)} รายการ)` : '';
    U.$('deepPagerPrev').disabled = state.page <= 0;
    U.$('deepPagerNext').disabled = state.page >= pages - 1;
  }

  function renderDetail(key) {
    const row = byKey.get(key);
    if (!row) return;
    const r = api.allRows().find(x => api.cartKey(x) === key) || api.rows().find(x => api.cartKey(x) === key);
    if (!r) return;
    const s = row[IDX.s], e = row[IDX.e], f = row.length > IDX.f ? row[IDX.f] : null;
    const band = Rules.band(r.risk_score);
    const hasIf = r.ml_pct !== null && r.ml_pct !== undefined;
    const m = payload.meta;
    const engineRow = (name, score, extra, ts) => `
      <div class="profile-metric"><div class="label">${U.esc(name)}</div>
        <div class="value">${score === null ? '-' : score}</div>
        <div class="small-muted">${extra || ''}${ts ? ` · ${U.esc(ts)}` : ''}</div></div>`;
    const engines = `<div class="row g-2 mb-2">
      <div class="col-4">${engineRow('คะแนนกฎ', U.num(r.risk_score), band.label, 'คำนวณในเบราว์เซอร์ตามการตั้งค่ากฎปัจจุบัน')}</div>
      <div class="col-4">${engineRow('Isolation Forest', hasIf ? r.ml_pct.toFixed(1) + '%' : '-', hasIf ? 'เปอร์เซ็นไทล์ทั้งชุด' : 'ไม่มีคะแนน', payload && m.data_generated_at)}</div>
      <div class="col-4">${engineRow('Autoencoder', s.toFixed(1) + '%', `error ${e}`, m.trained_at)}</div>
    </div>`;
    const why = (f || []).map(entry => {
      const [j, delta, value, peer] = entry;
      const feat = m.features[j] || {};
      return `<li>${U.esc(api.mlReasonText({ key: feat.key, value, peer }))} <span class="small-muted">(ลดคะแนนผิดปกติ ${delta} ถ้าเป็นค่าปกติของกลุ่ม)</span></li>`;
    }).join('');
    U.setHTML('deepDetailBody', `
      <div class="mb-2"><strong>${api.clickable('project', r.project_id, api.truncate(r.project_name, 70))}</strong>
        <div class="small-muted">${U.esc(api.truncate(r.dept_name || '', 50))} · ${U.esc(api.truncate(r.winner_name || '', 50))}</div></div>
      ${engines}
      ${why ? `<div><div class="section-label mb-1">ปัจจัยที่ทำให้ Autoencoder เห็นว่าผิดปกติ</div><ul class="mb-0">${why}</ul></div>`
        : '<p class="small-muted mb-0">สัญญานี้ไม่ติดกลุ่มที่คำนวณคำอธิบายไว้ (คำนวณเฉพาะสัญญาคะแนนสูงสุด 400 อันดับแรก)</p>'}
      <p class="ma-note mt-2 mb-0">ทั้ง Isolation Forest และ Autoencoder ใช้ปัจจัย 12 ตัวชุดเดียวกัน การที่สองโมเดลนี้เห็นตรงกันจึงไม่ใช่หลักฐานอิสระสองชิ้น</p>`);
    U.$('deepDetailCard').hidden = false;
    U.$('deepDetailCard').scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  }

  function renderValidation() {
    const m = payload.meta;
    const h = m.histogram;
    const maxN = Math.max(1, ...h.counts);
    const bars = h.counts.map((c, i) => `<div class="hx-bar" style="height:${(c / maxN * 100).toFixed(0)}%" title="${c} สัญญา"></div>`).join('');
    const foldRows = m.folds.map(fo => {
      const bestEpochs = fo.seeds.map(s => s.best_epoch).join(', ');
      const anyNotEarly = fo.seeds.some(s => !s.stopped_early);
      return `<tr><td>${fo.k}</td><td class="text-end">${fo.n_train}</td><td class="text-end">${fo.n_test}</td>
        <td>${bestEpochs}${anyNotEarly ? ' <span class="badge badge-medium">ไม่ early-stop</span>' : ''}</td></tr>`;
    }).join('');
    U.setHTML('deepValidationBody', `
      <div class="row g-3 mb-2">
        <div class="col-lg-6">
          <div class="section-label mb-1">การกระจายค่า reconstruction error (log10)</div>
          <div class="hx-bars" role="img" aria-label="ฮิสโทแกรม reconstruction error">${bars}</div>
        </div>
        <div class="col-lg-6">
          <div class="section-label mb-1">เทียบกับวิธีอื่น (ทั้งชุดข้อมูล ไม่ตามตัวกรอง)</div>
          <ul class="mb-0">
            <li>Isolation Forest: Spearman ${m.vs_isolation_forest.spearman} · 5% บนซ้ำกัน ${U.pct(m.vs_isolation_forest.top5pct_overlap)} · 1% บนซ้ำกัน ${U.pct(m.vs_isolation_forest.top1pct_overlap)}</li>
            <li>PCA 3 มิติ (เส้นตรง): Spearman ${m.baseline_pca.spearman} · 5% บนซ้ำกัน ${U.pct(m.baseline_pca.top5pct_overlap)}</li>
            <li>เปลี่ยนวิธีแบ่ง fold: Spearman ${m.stability.vs_alt_fold_split.spearman} · 5% บนซ้ำกัน ${U.pct(m.stability.vs_alt_fold_split.top5pct_overlap)}</li>
            <li>1 seed เทียบ ensemble 5 seed: Spearman ${m.stability.single_seed_vs_5seed_ensemble.spearman} · 5% บนซ้ำกัน ${U.pct(m.stability.single_seed_vs_5seed_ensemble.top5pct_overlap)}</li>
          </ul>
        </div>
      </div>
      <div class="table-wrap mb-2"><table class="table table-sm mini-table mb-0">
        <caption class="visually-hidden">รายละเอียดการฝึกแต่ละ fold</caption>
        <thead><tr><th scope="col">fold</th><th scope="col" class="text-end">ฝึก</th><th scope="col" class="text-end">ทดสอบ</th><th scope="col">epoch ที่ดีที่สุด (5 seed)</th></tr></thead>
        <tbody>${foldRows}</tbody></table></div>
      <p class="small-muted mb-0">ยืนยันแล้วว่าคำนวณ Isolation Forest ซ้ำได้ตรงกับ data.json ทุกแถว (n=${m.vs_isolation_forest.if_reproduced.n}, ผลต่างสูงสุด ${m.vs_isolation_forest.if_reproduced.max_abs_diff}) ก่อนฝึก Autoencoder — ยืนยันว่าใช้ข้อมูลและฟีเจอร์ชุดเดียวกันจริง ·
        เวอร์ชันที่ใช้ตอนฝึก: python ${U.esc(m.versions.python)} · numpy ${U.esc(m.versions.numpy)} · pandas ${U.esc(m.versions.pandas)} · เวลารวม ${m.runtime_sec}s</p>
      ${renderProxySection()}`);
  }

  function renderProxySection() {
    const ev = api.proxyEval(r => {
      const row = byKey.get(api.cartKey(r));
      return row ? row[IDX.s] : null;
    });
    if (!ev) return '<p class="small-muted mb-0">กฎที่ใช้เป็นป้ายชั่วคราว (R4/R11/R20) ถูกปิดไว้ทั้งหมด จึงวัดเทียบไม่ได้</p>';
    return `<div class="mt-2"><div class="section-label mb-1">วัดจัดลำดับเทียบกับความผิดพลาดที่รู้แน่ (วิธีเดียวกับแท็บกฎ F2)</div>
      <p class="small-muted mb-1">ใช้ ${U.esc(ev.proxyRules.join(' · '))} ${U.num(ev.positives)} สัญญา (${U.pct(ev.base)}) เป็นป้ายชั่วคราว — ตัวเลขนี้อ่านระมัดระวังเป็นพิเศษ เพราะฟีเจอร์ของ Autoencoder คำนวณย้อนจาก R4 ได้บางส่วน (ราคากลางเทียบวงเงิน × ส่วนลด) จึงอาจดูดีเกินจริง</p>
      <p class="mb-0">precision@100 ${U.pct(ev.p100)} · precision@500 ${U.pct(ev.p500)} · AUC ${ev.auc === null ? '-' : ev.auc.toFixed(2)}</p></div>`;
  }

  function renderReady() {
    U.$('deepBody').hidden = false;
    renderOverview();
    renderSummaryAndTable();
    if (U.$('deepValidationDetails').open) renderValidation();
  }

  function render() {
    if (status === 'idle') {
      status = 'loading';
      renderStatusBanner();
      U.$('deepBody').hidden = true;
      load().then(() => {
        renderStatusBanner();
        if (status === 'ready' || status === 'stale') renderReady();
        api.markDirty();
        api.syncCot();
      });
      return;
    }
    renderStatusBanner();
    if (status === 'ready' || status === 'stale') renderReady();
    else U.$('deepBody').hidden = true;
  }

  /* ---------- DOM events (ผูกครั้งเดียว) ---------- */

  function bindDom() {
    if (wiredDom) return;
    wiredDom = true;
    $('deepFilterLevel').addEventListener('change', e => { state.filterLevel = e.target.value; renderSummaryAndTable(); });
    $('deepPagerPrev').addEventListener('click', () => { state.page--; renderTablePage(); });
    $('deepPagerNext').addEventListener('click', () => { state.page++; renderTablePage(); });
    $('deepDetailClose').addEventListener('click', () => { $('deepDetailCard').hidden = true; });
    $('deepTableBody').addEventListener('click', e => {
      const row = e.target.closest('[data-deep-key]');
      if (row && !e.target.closest('.detail-clickable')) renderDetail(row.dataset.deepKey);
    });
    $('deepTableBody').addEventListener('keydown', e => {
      if (e.key !== 'Enter' && e.key !== ' ') return;
      const row = e.target.closest('[data-deep-key]');
      if (row) { e.preventDefault(); renderDetail(row.dataset.deepKey); }
    });
    $('deepValidationDetails').addEventListener('toggle', e => {
      if (e.target.open && (status === 'ready' || status === 'stale')) renderValidation();
    });
  }

  return { init, render, snapshot };
})();
