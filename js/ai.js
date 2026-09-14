/* =========================================================
   ผู้ช่วย AI — ชั้นเชื่อมต่อผู้ให้บริการ
   =========================================================

   แอปนี้เป็นหน้าเว็บล้วนไม่มีเซิร์ฟเวอร์ ทุกคำขอจึงยิงจากเบราว์เซอร์ตรงไปยังผู้ให้บริการ
   ไฟล์นี้รู้แค่ "ส่งข้อความ รับข้อความกลับทีละส่วน" ไม่รู้จักข้อมูลจัดซื้อจัดจ้างเลย
   การประกอบข้อมูลที่จะส่งอยู่ใน app.js ซึ่งเข้าถึงสถานะของหน้าได้

   ผู้ให้บริการแบ่งสามกลุ่มตามต้นทุนของผู้ใช้:
   1) ฟรี ไม่ต้องใช้ key — Chrome Built-in AI (ในเบราว์เซอร์) และ Ollama (ในเครื่อง)
      ข้อมูลไม่ออกนอกเครื่องเลย
   2) ฟรี แต่ต้องสมัครรับ key — Gemini, Groq, OpenRouter (โมเดล :free)
   3) เสียเงินตามการใช้งาน — Anthropic Claude, OpenAI

   Key ถูกเก็บในแท็บนี้เท่านั้นเป็นค่าเริ่มต้น (sessionStorage หายเมื่อปิดแท็บ)
   ผู้ใช้เลือกให้จำถาวรในเครื่องได้ แต่ key จะอ่านได้จากส่วนขยายเบราว์เซอร์ใดก็ได้ที่เข้าหน้านี้ */

const AI = (() => {
  const ANTHROPIC_SDK_URL = 'https://cdn.jsdelivr.net/npm/@anthropic-ai/sdk@0.125.0/+esm';

  const PROVIDERS = {
    chrome: {
      label: 'Chrome Built-in AI (Gemini Nano)', group: 'free-nokey', kind: 'chrome', needsKey: false, compact: true,
      defaultModel: 'gemini-nano', fixedModel: true,
      note: 'ทำงานในเบราว์เซอร์ Chrome รุ่นใหม่ ข้อมูลไม่ออกนอกเครื่อง · โมเดลเล็ก บริบทสั้น และรองรับภาษาไทยจำกัด เหมาะกับงานสั้น ๆ',
      help: 'https://developer.chrome.com/docs/ai/prompt-api',
    },
    ollama: {
      label: 'Ollama (รันในเครื่องตัวเอง)', group: 'free-nokey', kind: 'openai', needsKey: false,
      baseUrl: 'http://localhost:11434', apiPath: '/v1', defaultModel: 'qwen2.5:7b',
      note: 'ติดตั้ง Ollama แล้วรัน "ollama pull qwen2.5:7b" · ต้องตั้งตัวแปร OLLAMA_ORIGINS=* ก่อนเปิด Ollama ไม่งั้นเบราว์เซอร์จะถูกบล็อก',
      help: 'https://ollama.com/download',
    },
    gemini: {
      label: 'Google Gemini', group: 'free-key', kind: 'gemini', needsKey: true,
      baseUrl: 'https://generativelanguage.googleapis.com/v1beta', defaultModel: 'gemini-2.5-flash',
      note: 'มีโควตาฟรีรายวัน · ข้อความในแพ็กเกจฟรีอาจถูกใช้ปรับปรุงบริการของ Google (ข้อมูลชุดนี้เป็นข้อมูลเปิดอยู่แล้ว)',
      help: 'https://aistudio.google.com/apikey',
    },
    groq: {
      label: 'Groq', group: 'free-key', kind: 'openai', needsKey: true, compact: true,
      baseUrl: 'https://api.groq.com/openai', apiPath: '/v1', defaultModel: 'llama-3.3-70b-versatile',
      note: 'มีโควตาฟรี ตอบเร็วมาก · โมเดลโอเพนซอร์ส ภาษาไทยพอใช้',
      help: 'https://console.groq.com/keys',
    },
    openrouter: {
      label: 'OpenRouter (เลือกโมเดลที่ลงท้าย :free)', group: 'free-key', kind: 'openai', needsKey: true,
      baseUrl: 'https://openrouter.ai/api', apiPath: '/v1', defaultModel: '', freeSuffix: ':free',
      note: 'รวมโมเดลหลายค่าย โมเดลที่ลงท้าย ":free" ใช้ฟรีแต่จำกัดจำนวนครั้ง · กด "ดึงรายชื่อ" เพื่อเลือกโมเดลฟรี',
      help: 'https://openrouter.ai/keys',
    },
    anthropic: {
      label: 'Anthropic Claude', group: 'paid', kind: 'anthropic', needsKey: true,
      defaultModel: 'claude-opus-5',
      note: 'คุณภาพการวิเคราะห์และภาษาไทยดีที่สุดในรายการ · คิดค่าใช้จ่ายตามจำนวนโทเค็น',
      help: 'https://console.anthropic.com/settings/keys',
    },
    openai: {
      label: 'OpenAI', group: 'paid', kind: 'openai', needsKey: true,
      baseUrl: 'https://api.openai.com', apiPath: '/v1', defaultModel: '',
      note: 'คิดค่าใช้จ่ายตามจำนวนโทเค็น · กด "ดึงรายชื่อ" เพื่อเลือกโมเดล',
      help: 'https://platform.openai.com/api-keys',
    },
    custom: {
      label: 'กำหนดเอง (API แบบ OpenAI-compatible)', group: 'custom', kind: 'openai', needsKey: false,
      baseUrl: '', apiPath: '/v1', defaultModel: '', editableUrl: true,
      note: 'ใช้กับ LM Studio, vLLM, LocalAI หรือบริการอื่นที่รับรูปแบบ /v1/chat/completions · key ไม่บังคับ',
    },
  };

  const GROUPS = [
    ['free-nokey', 'ฟรี · ไม่ต้องใช้ key'],
    ['free-key', 'ฟรี · ต้องสมัครรับ key'],
    ['paid', 'เสียค่าใช้จ่าย · ต้องใช้ key'],
    ['custom', 'อื่น ๆ'],
  ];

  /* ---------- การตั้งค่า ---------- */

  const CFG_KEY = 'pa_ai_cfg_v1';
  const KEYS_KEY = 'pa_ai_keys_v1';

  function readJSON(storage, key) {
    try { return JSON.parse(storage.getItem(key)) || {}; } catch (e) { return {}; }
  }
  function writeJSON(storage, key, value) {
    try { storage.setItem(key, JSON.stringify(value)); } catch (e) { /* โหมดส่วนตัวบางแบบเขียนไม่ได้ */ }
  }

  function loadConfig() {
    const c = readJSON(localStorage, CFG_KEY);
    return {
      provider: PROVIDERS[c.provider] ? c.provider : 'gemini',
      models: c.models || {},
      baseUrls: c.baseUrls || {},
      remember: !!c.remember,
    };
  }
  function saveConfig(cfg) {
    writeJSON(localStorage, CFG_KEY, { provider: cfg.provider, models: cfg.models, baseUrls: cfg.baseUrls, remember: cfg.remember });
  }

  function getKey(provider) {
    return readJSON(sessionStorage, KEYS_KEY)[provider] || readJSON(localStorage, KEYS_KEY)[provider] || '';
  }
  /** เก็บ key ที่เดียวตามที่ผู้ใช้เลือก และลบออกจากอีกที่ ไม่ให้ key ค้างอยู่ในที่เก็บถาวรโดยไม่ตั้งใจ */
  function setKey(provider, key, remember) {
    const session = readJSON(sessionStorage, KEYS_KEY), local = readJSON(localStorage, KEYS_KEY);
    delete session[provider]; delete local[provider];
    if (key) (remember ? local : session)[provider] = key;
    writeJSON(sessionStorage, KEYS_KEY, session);
    writeJSON(localStorage, KEYS_KEY, local);
  }
  function forgetAllKeys() {
    try { sessionStorage.removeItem(KEYS_KEY); localStorage.removeItem(KEYS_KEY); } catch (e) { /* ไม่สำคัญ */ }
  }

  /* ---------- ข้อผิดพลาดที่อ่านเข้าใจได้ ---------- */

  class AIError extends Error {
    constructor(message, { hint = '', aborted = false } = {}) { super(message); this.hint = hint; this.aborted = aborted; }
  }

  async function httpError(res, provider) {
    let detail = '';
    try {
      const body = await res.text();
      try { const j = JSON.parse(body); detail = j.error?.message || j.message || j.error || body; } catch (e) { detail = body; }
    } catch (e) { /* ไม่มีเนื้อหา */ }
    detail = String(detail).slice(0, 300);
    // Gemini ตอบ key ผิดด้วย HTTP 400 ไม่ใช่ 401
    if (res.status === 401 || res.status === 403 || (res.status === 400 && /api.?key/i.test(detail))) return new AIError('key ไม่ถูกต้องหรือไม่มีสิทธิ์ใช้โมเดลนี้', { hint: detail });
    if (res.status === 404) return new AIError('ไม่พบโมเดลหรือปลายทางนี้ ลองกด "ดึงรายชื่อ" แล้วเลือกโมเดลใหม่', { hint: detail });
    if (res.status === 429) return new AIError('ใช้เกินโควตาหรือส่งถี่เกินไป รอสักครู่แล้วลองใหม่', { hint: detail });
    if (res.status >= 500) return new AIError(`ผู้ให้บริการขัดข้อง (HTTP ${res.status}) ลองใหม่ภายหลัง`, { hint: detail });
    return new AIError(`คำขอไม่สำเร็จ (HTTP ${res.status})`, { hint: detail });
  }

  function networkError(e, p) {
    if (e?.name === 'AbortError') return new AIError('หยุดแล้ว', { aborted: true });
    if (p.kind === 'openai' && /localhost|127\.0\.0\.1/.test(p.baseUrlResolved || '')) {
      return new AIError('ติดต่อเซิร์ฟเวอร์ในเครื่องไม่ได้',
        { hint: 'ตรวจว่าเปิดโปรแกรมอยู่ และตั้ง OLLAMA_ORIGINS=* (หรือเปิด CORS ในโปรแกรมที่ใช้) แล้วเปิดโปรแกรมใหม่' });
    }
    return new AIError('เชื่อมต่อผู้ให้บริการไม่ได้', { hint: 'ตรวจอินเทอร์เน็ต หรือผู้ให้บริการอาจไม่อนุญาตให้เรียกจากเบราว์เซอร์โดยตรง' });
  }

  /* ---------- อ่านสตรีม SSE ---------- */

  async function* sseData(res, signal) {
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buf = '';
    try {
      while (true) {
        if (signal?.aborted) throw new DOMException('aborted', 'AbortError');
        const { value, done } = await reader.read();
        if (done) break;
        buf += decoder.decode(value, { stream: true });
        let nl;
        while ((nl = buf.indexOf('\n')) >= 0) {
          const line = buf.slice(0, nl).replace(/\r$/, '');
          buf = buf.slice(nl + 1);
          if (line.startsWith('data:')) yield line.slice(5).trim();
        }
      }
      if (buf.startsWith('data:')) yield buf.slice(5).trim();
    } finally {
      try { reader.releaseLock(); } catch (e) { /* ปิดไปแล้ว */ }
    }
  }

  /* ---------- ผู้ให้บริการแต่ละแบบ ---------- */

  function resolve(opts) {
    const p = { ...PROVIDERS[opts.provider] };
    if (!p.kind) throw new AIError('ไม่รู้จักผู้ให้บริการนี้');
    p.baseUrlResolved = (opts.baseUrl || p.baseUrl || '').replace(/\/+$/, '');
    p.model = opts.model || p.defaultModel;
    p.key = opts.key || '';
    if (p.needsKey && !p.key) throw new AIError('ยังไม่ได้ใส่ API key', { hint: p.help ? `ขอ key ได้ที่ ${p.help}` : '' });
    if (p.kind !== 'chrome' && !p.model) throw new AIError('ยังไม่ได้เลือกโมเดล', { hint: 'กด "ดึงรายชื่อ" แล้วเลือกโมเดล' });
    if (p.kind === 'openai' && !p.baseUrlResolved) throw new AIError('ยังไม่ได้ใส่ที่อยู่ของ API');
    return p;
  }

  async function streamOpenAI(p, { system, messages, maxTokens, signal, onText }) {
    const headers = { 'Content-Type': 'application/json' };
    if (p.key) headers.Authorization = `Bearer ${p.key}`;
    let res;
    try {
      res = await fetch(`${p.baseUrlResolved}${p.apiPath}/chat/completions`, {
        method: 'POST', headers, signal,
        body: JSON.stringify({
          model: p.model, stream: true, max_tokens: maxTokens,
          messages: [{ role: 'system', content: system }, ...messages],
        }),
      });
    } catch (e) { throw networkError(e, p); }
    if (!res.ok) throw await httpError(res, p);
    let full = '';
    try {
      for await (const data of sseData(res, signal)) {
        if (data === '[DONE]') break;
        let j; try { j = JSON.parse(data); } catch (e) { continue; }
        if (j.error) throw new AIError('ผู้ให้บริการตอบกลับข้อผิดพลาด', { hint: j.error.message || JSON.stringify(j.error) });
        const delta = j.choices?.[0]?.delta?.content;
        if (delta) { full += delta; onText(delta, full); }
      }
    } catch (e) { if (e instanceof AIError) throw e; throw networkError(e, p); }
    return full;
  }

  async function streamGemini(p, { system, messages, maxTokens, signal, onText }) {
    let res;
    try {
      res = await fetch(`${p.baseUrlResolved}/models/${encodeURIComponent(p.model)}:streamGenerateContent?alt=sse`, {
        method: 'POST', signal,
        headers: { 'Content-Type': 'application/json', 'x-goog-api-key': p.key },
        body: JSON.stringify({
          systemInstruction: { parts: [{ text: system }] },
          contents: messages.map(m => ({ role: m.role === 'assistant' ? 'model' : 'user', parts: [{ text: m.content }] })),
          generationConfig: { maxOutputTokens: maxTokens },
        }),
      });
    } catch (e) { throw networkError(e, p); }
    if (!res.ok) throw await httpError(res, p);
    let full = '', blocked = '';
    try {
      for await (const data of sseData(res, signal)) {
        let j; try { j = JSON.parse(data); } catch (e) { continue; }
        if (j.promptFeedback?.blockReason) blocked = j.promptFeedback.blockReason;
        const parts = j.candidates?.[0]?.content?.parts || [];
        const delta = parts.map(x => x.text || '').join('');
        if (delta) { full += delta; onText(delta, full); }
      }
    } catch (e) { if (e instanceof AIError) throw e; throw networkError(e, p); }
    if (!full && blocked) throw new AIError('Gemini ปฏิเสธคำขอนี้', { hint: blocked });
    return full;
  }

  let anthropicModule = null;
  async function loadAnthropic() {
    if (!anthropicModule) {
      anthropicModule = import(ANTHROPIC_SDK_URL).catch(e => {
        anthropicModule = null;
        throw new AIError('โหลดไลบรารี Anthropic ไม่สำเร็จ', { hint: 'ต้องเชื่อมต่ออินเทอร์เน็ตเพื่อโหลดจาก cdn.jsdelivr.net' });
      });
    }
    return anthropicModule;
  }

  function anthropicError(e, sdk) {
    if (e instanceof AIError) return e;
    if (e instanceof sdk.APIUserAbortError) return new AIError('หยุดแล้ว', { aborted: true });
    if (e instanceof sdk.AuthenticationError || e instanceof sdk.PermissionDeniedError) return new AIError('key ไม่ถูกต้องหรือไม่มีสิทธิ์ใช้โมเดลนี้', { hint: e.message });
    if (e instanceof sdk.NotFoundError) return new AIError('ไม่พบโมเดลนี้ ลองกด "ดึงรายชื่อ" แล้วเลือกใหม่', { hint: e.message });
    if (e instanceof sdk.RateLimitError) return new AIError('ใช้เกินโควตาหรือส่งถี่เกินไป รอสักครู่แล้วลองใหม่', { hint: e.message });
    if (e instanceof sdk.BadRequestError) return new AIError('คำขอไม่ถูกต้อง', { hint: e.message });
    if (e instanceof sdk.APIConnectionError) return new AIError('เชื่อมต่อ Anthropic ไม่ได้', { hint: e.message });
    if (e instanceof sdk.APIError) return new AIError(`Anthropic ขัดข้อง (HTTP ${e.status ?? '-'})`, { hint: e.message });
    return new AIError('เกิดข้อผิดพลาดที่ไม่คาดคิด', { hint: e?.message || String(e) });
  }

  /* Claude Opus 5 และ Fable 5.1 อาจปฏิเสธบางคำขอด้วยตัวกรองความปลอดภัย
     เปิด fallback ฝั่งเซิร์ฟเวอร์ไว้ ให้ระบบส่งต่อไปยังโมเดลสำรองที่เหมาะสมเองแทนการคืนคำตอบว่าง */
  const FALLBACK_MODELS = /^claude-(opus-5|fable-5-1)/;

  async function streamAnthropic(p, { system, messages, maxTokens, signal, onText }) {
    const sdk = await loadAnthropic();
    const client = new sdk.Anthropic({ apiKey: p.key, dangerouslyAllowBrowser: true });
    const body = { model: p.model, max_tokens: maxTokens, system, messages };
    const useFallback = FALLBACK_MODELS.test(p.model);
    let full = '';
    try {
      const stream = useFallback
        ? client.beta.messages.stream({ ...body, betas: ['server-side-fallback-2026-07-01'], fallbacks: 'default' }, { signal })
        : client.messages.stream(body, { signal });
      for await (const event of stream) {
        if (event.type === 'content_block_delta' && event.delta.type === 'text_delta') {
          full += event.delta.text;
          onText(event.delta.text, full);
        }
      }
      const msg = await stream.finalMessage();
      if (msg.stop_reason === 'refusal') {
        throw new AIError('โมเดลปฏิเสธคำขอนี้', { hint: msg.stop_details?.explanation || '' });
      }
      if (msg.stop_reason === 'max_tokens') full += '\n\n_(คำตอบถูกตัดเพราะยาวถึงขีดจำกัด)_';
    } catch (e) { throw anthropicError(e, sdk); }
    return full;
  }

  function chromeApi() { return globalThis.LanguageModel || null; }

  async function streamChrome(p, { system, messages, signal, onText, onStatus }) {
    const LM = chromeApi();
    if (!LM) {
      throw new AIError('เบราว์เซอร์นี้ไม่มี Chrome Built-in AI',
        { hint: 'ใช้ Chrome รุ่นใหม่บนคอมพิวเตอร์ที่รองรับ หรือเลือกผู้ให้บริการอื่น' });
    }
    const avail = await LM.availability();
    if (avail === 'unavailable') throw new AIError('อุปกรณ์นี้ใช้ Chrome Built-in AI ไม่ได้', { hint: 'ต้องการพื้นที่และหน่วยความจำตามที่ Chrome กำหนด' });
    const history = messages.slice(0, -1).map(m => ({ role: m.role, content: m.content }));
    const last = messages[messages.length - 1];
    let session;
    try {
      session = await LM.create({
        initialPrompts: [{ role: 'system', content: system }, ...history],
        signal,
        monitor(m) {
          m.addEventListener('downloadprogress', e => onStatus?.(`กำลังดาวน์โหลดโมเดลในเครื่อง ${Math.round(e.loaded * 100)}%`));
        },
      });
      let full = '';
      for await (const chunk of session.promptStreaming(last.content, { signal })) {
        // Chrome รุ่นแรกส่งข้อความสะสม รุ่นหลังส่งเฉพาะส่วนใหม่ รองรับทั้งสองแบบ
        const delta = chunk.startsWith(full) && full ? chunk.slice(full.length) : chunk;
        full += delta;
        if (delta) onText(delta, full);
      }
      return full;
    } catch (e) {
      if (e?.name === 'AbortError') throw new AIError('หยุดแล้ว', { aborted: true });
      if (e?.name === 'QuotaExceededError') throw new AIError('ข้อมูลยาวเกินกว่าที่โมเดลในเครื่องรับได้', { hint: 'ลองจำกัดตัวกรองให้แคบลง หรือใช้ผู้ให้บริการอื่น' });
      throw new AIError('Chrome Built-in AI ทำงานไม่สำเร็จ', { hint: e?.message || String(e) });
    } finally {
      try { session?.destroy(); } catch (e) { /* ปิดไปแล้ว */ }
    }
  }

  /** ส่งบทสนทนาและรับคำตอบทีละส่วน คืนข้อความเต็มเมื่อจบ */
  async function stream(opts) {
    const p = resolve(opts);
    const args = { ...opts, maxTokens: opts.maxTokens || (p.kind === 'anthropic' ? 64000 : 8192), onText: opts.onText || (() => {}) };
    if (p.kind === 'anthropic') return streamAnthropic(p, args);
    if (p.kind === 'gemini') return streamGemini(p, args);
    if (p.kind === 'chrome') return streamChrome(p, args);
    return streamOpenAI(p, args);
  }

  /** รายชื่อโมเดลจากผู้ให้บริการ — ชื่อโมเดลเปลี่ยนบ่อย จึงไม่ผูกรายการตายตัวไว้ในโค้ด */
  async function listModels(opts) {
    const p = { ...PROVIDERS[opts.provider] };
    p.baseUrlResolved = (opts.baseUrl || p.baseUrl || '').replace(/\/+$/, '');
    p.key = opts.key || '';
    if (p.kind === 'chrome') return ['gemini-nano'];
    if (p.needsKey && !p.key) throw new AIError('ใส่ API key ก่อนดึงรายชื่อโมเดล');
    if (p.kind === 'anthropic') {
      const sdk = await loadAnthropic();
      const client = new sdk.Anthropic({ apiKey: p.key, dangerouslyAllowBrowser: true });
      const ids = [];
      try { for await (const m of client.models.list()) ids.push(m.id); } catch (e) { throw anthropicError(e, sdk); }
      return ids;
    }
    let res;
    try {
      if (p.kind === 'gemini') {
        res = await fetch(`${p.baseUrlResolved}/models?pageSize=200`, { headers: { 'x-goog-api-key': p.key } });
      } else if (opts.provider === 'ollama') {
        res = await fetch(`${p.baseUrlResolved}/api/tags`);
      } else {
        res = await fetch(`${p.baseUrlResolved}${p.apiPath}/models`, { headers: p.key ? { Authorization: `Bearer ${p.key}` } : {} });
      }
    } catch (e) { throw networkError(e, p); }
    if (!res.ok) throw await httpError(res, p);
    const j = await res.json();
    let ids;
    if (p.kind === 'gemini') {
      ids = (j.models || []).filter(m => (m.supportedGenerationMethods || []).includes('generateContent'))
        .map(m => m.name.replace(/^models\//, ''));
    } else if (opts.provider === 'ollama') {
      ids = (j.models || []).map(m => m.name);
    } else {
      ids = (j.data || []).map(m => m.id);
    }
    if (p.freeSuffix) {
      // เรียงโมเดลฟรีขึ้นก่อน ผู้ใช้กลุ่มนี้ตั้งใจใช้ฟรีเป็นหลัก
      ids.sort((a, b) => (b.endsWith(p.freeSuffix) - a.endsWith(p.freeSuffix)) || a.localeCompare(b));
    }
    return ids;
  }

  async function chromeStatus() {
    const LM = chromeApi();
    if (!LM) return 'none';
    try { return await LM.availability(); } catch (e) { return 'unavailable'; }
  }

  /* ---------- แสดงผล Markdown อย่างปลอดภัย ----------
     คำตอบจาก AI ถือเป็นข้อมูลภายนอก ห้ามใส่ลง innerHTML ตรง ๆ
     จึง escape ทุกอักขระก่อน แล้วค่อยแปลงเฉพาะไวยากรณ์ที่รู้จัก ไม่รองรับ HTML ดิบและลิงก์ */

  function esc(s) {
    return String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  }

  function inline(text, refFn) {
    let s = esc(text);
    const codes = [];
    s = s.replace(/`([^`]+)`/g, (_, c) => { codes.push(c); return `\u0001${codes.length - 1}\u0001`; });
    s = s.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
      .replace(/(^|[^*])\*([^*\s][^*]*)\*/g, '$1<em>$2</em>');
    if (refFn) s = s.replace(/\[P:\s*([^\]\s]+)\s*\]/g, (_, id) => refFn(id));
    return s.replace(/\u0001(\d+)\u0001/g, (_, i) => `<code>${codes[+i]}</code>`);
  }

  function markdown(src, { refFn, blockFn } = {}) {
    const lines = String(src || '').replace(/\r/g, '').split('\n');
    const out = [];
    let i = 0;
    const isTableSep = l => /^\s*\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)*\|?\s*$/.test(l);
    const cells = l => l.trim().replace(/^\||\|$/g, '').split('|').map(c => c.trim());
    while (i < lines.length) {
      const line = lines[i];
      if (/^\s*```/.test(line)) {
        const lang = line.trim().slice(3).trim().toLowerCase();
        const buf = [];
        i++;
        while (i < lines.length && !/^\s*```/.test(lines[i])) buf.push(lines[i++]);
        const closed = i < lines.length;
        i++;
        // บล็อกพิเศษ (kpi, chart) ให้หน้าเว็บวาดเป็นการ์ดหรือกราฟ ถ้าวาดไม่ได้ค่อยแสดงเป็นโค้ด
        const special = blockFn && lang && closed ? blockFn(lang, buf.join('\n')) : null;
        out.push(special || ((lang === 'kpi' || lang === 'chart') && !closed
          ? '<div class="ai-block-pending">กำลังเตรียมภาพสรุป...</div>'
          : `<pre class="ai-code"><code>${esc(buf.join('\n'))}</code></pre>`));
        continue;
      }
      if (/^\s*\|/.test(line) && i + 1 < lines.length && isTableSep(lines[i + 1])) {
        const head = cells(line);
        i += 2;
        const rows = [];
        while (i < lines.length && /^\s*\|/.test(lines[i])) rows.push(cells(lines[i++]));
        out.push(`<div class="ai-table-wrap"><table class="table table-sm mini-table mb-0"><thead><tr>${head.map(h => `<th scope="col">${inline(h, refFn)}</th>`).join('')}</tr></thead>` +
          `<tbody>${rows.map(r => `<tr>${r.map(c => `<td>${inline(c, refFn)}</td>`).join('')}</tr>`).join('')}</tbody></table></div>`);
        continue;
      }
      const h = line.match(/^(#{1,4})\s+(.*)$/);
      if (h) { const lv = Math.min(6, h[1].length + 2); out.push(`<h${lv} class="ai-h">${inline(h[2], refFn)}</h${lv}>`); i++; continue; }
      if (/^\s*(---|\*\*\*)\s*$/.test(line)) { out.push('<hr>'); i++; continue; }
      if (/^\s*>/.test(line)) {
        const buf = [];
        while (i < lines.length && /^\s*>/.test(lines[i])) buf.push(lines[i++].replace(/^\s*>\s?/, ''));
        out.push(`<blockquote class="ai-quote">${inline(buf.join(' '), refFn)}</blockquote>`);
        continue;
      }
      if (/^\s*([-*+]|\d+[.)])\s+/.test(line)) {
        const ordered = /^\s*\d+[.)]\s+/.test(line);
        const items = [];
        while (i < lines.length && /^\s*([-*+]|\d+[.)])\s+/.test(lines[i])) {
          const indent = lines[i].match(/^\s*/)[0].length;
          // รายการระดับบนสุดที่เปลี่ยนชนิด (มีเลข ↔ ไม่มีเลข) คือรายการใหม่
          if (indent < 2 && /^\s*\d+[.)]\s+/.test(lines[i]) !== ordered) break;
          const text = lines[i].replace(/^\s*([-*+]|\d+[.)])\s+/, '');
          items.push(`<li${indent >= 2 ? ' class="ai-li-sub"' : ''}>${inline(text, refFn)}</li>`);
          i++;
        }
        out.push(ordered ? `<ol>${items.join('')}</ol>` : `<ul>${items.join('')}</ul>`);
        continue;
      }
      if (!line.trim()) { i++; continue; }
      const buf = [];
      while (i < lines.length && lines[i].trim() && !/^\s*(```|#{1,4}\s|[-*+]\s|\d+[.)]\s|>|\|)/.test(lines[i])) buf.push(lines[i++]);
      if (!buf.length) buf.push(lines[i++]);
      out.push(`<p>${buf.map(b => inline(b, refFn)).join('<br>')}</p>`);
    }
    return out.join('');
  }

  /** ดึงวัตถุ JSON ก้อนแรกจากคำตอบ — โมเดลเล็กมักห่อด้วย ```json หรือเขียนคำอธิบายนำหน้า */
  function extractJSON(text) {
    const s = String(text || '');
    const start = s.indexOf('{'), end = s.lastIndexOf('}');
    if (start < 0 || end <= start) return null;
    try { return JSON.parse(s.slice(start, end + 1)); } catch (e) { return null; }
  }


  /* ---------- ประมาณโทเค็นและค่าใช้จ่าย ----------
     ตัวเลขนี้ใช้บอกขนาดคร่าว ๆ ก่อนกดส่ง ไม่ใช่ใบแจ้งหนี้
     ภาษาไทยใช้โทเค็นต่อตัวอักษรมากกว่าอังกฤษหลายเท่า จึงแยกนับสองกลุ่ม */
  function estimateTokens(text) {
    const s = String(text || '');
    let ascii = 0;
    for (let i = 0; i < s.length; i++) if (s.charCodeAt(i) < 128) ascii++;
    return Math.ceil(ascii / 4 + (s.length - ascii) / 1.6);
  }

  // ราคาต่อ 1 ล้านโทเค็น (ขาเข้า, ขาออก) ดอลลาร์สหรัฐ — เฉพาะรุ่นที่ทราบราคาแน่นอน
  const PRICES = [
    [/^claude-(fable-5-1|mythos-5-1|fable-5)/, 10, 50],
    [/^claude-opus-(5|4-8|4-7|4-6)/, 5, 25],
    [/^claude-sonnet-5/, 2, 10],
    [/^claude-sonnet-4-6/, 3, 15],
    [/^claude-haiku-4-5/, 1, 5],
  ];
  function priceFor(provider, model) {
    const p = PROVIDERS[provider];
    if (!p) return null;
    if (p.group === 'free-nokey') return { free: true, note: 'ฟรี · ประมวลผลในเครื่อง' };
    if (p.group === 'free-key') return { free: true, note: 'ฟรีตามโควตาของผู้ให้บริการ' };
    if (p.kind === 'anthropic') {
      const hit = PRICES.find(([re]) => re.test(model || ''));
      if (hit) return { input: hit[1], output: hit[2] };
    }
    return null;
  }

  /* ---------- เรียกเครื่องมือ (tool use) สำหรับโหมดนักสืบ ----------
     หนึ่งรอบ = ส่งบทสนทนาและรายการเครื่องมือ แล้วรับข้อความกับคำขอเรียกเครื่องมือกลับมา
     การวนรอบและการรันเครื่องมืออยู่ใน app.js ไฟล์นี้แปลงรูปแบบข้อความของแต่ละค่ายเท่านั้น */

  function supportsTools(provider) {
    const k = PROVIDERS[provider]?.kind;
    return k === 'anthropic' || k === 'openai';
  }

  async function toolStep(opts) {
    const p = resolve(opts);
    const { system, messages, tools, signal, forceFinal = false, maxTokens } = opts;
    if (p.kind === 'anthropic') {
      const sdk = await loadAnthropic();
      const client = new sdk.Anthropic({ apiKey: p.key, dangerouslyAllowBrowser: true });
      const body = {
        model: p.model, max_tokens: maxTokens || 16000, system, messages,
        tools: tools.map(t => ({ name: t.name, description: t.description, input_schema: t.schema })),
      };
      if (forceFinal) body.tool_choice = { type: 'none' };
      try {
        const resp = FALLBACK_MODELS.test(p.model)
          ? await client.beta.messages.create({ ...body, betas: ['server-side-fallback-2026-07-01'], fallbacks: 'default' }, { signal })
          : await client.messages.create(body, { signal });
        if (resp.stop_reason === 'refusal') throw new AIError('โมเดลปฏิเสธคำขอนี้', { hint: resp.stop_details?.explanation || '' });
        const text = resp.content.filter(b => b.type === 'text').map(b => b.text).join('');
        const calls = resp.content.filter(b => b.type === 'tool_use').map(b => ({ id: b.id, name: b.name, input: b.input || {} }));
        // ต้องส่ง content กลับไปครบทุกบล็อกตามที่ได้รับ (รวมบล็อกความคิด) ไม่งั้นรอบถัดไปจะผิดรูปแบบ
        return { text, calls, assistant: { role: 'assistant', content: resp.content }, usage: resp.usage, truncated: resp.stop_reason === 'max_tokens' };
      } catch (e) { throw anthropicError(e, sdk); }
    }
    if (p.kind !== 'openai') {
      throw new AIError('ผู้ให้บริการนี้ยังไม่รองรับโหมดนักสืบ',
        { hint: 'ใช้ Anthropic Claude หรือผู้ให้บริการแบบ OpenAI-compatible (Groq, OpenRouter, OpenAI, Ollama)' });
    }
    const headers = { 'Content-Type': 'application/json' };
    if (p.key) headers.Authorization = `Bearer ${p.key}`;
    let res;
    try {
      res = await fetch(`${p.baseUrlResolved}${p.apiPath}/chat/completions`, {
        method: 'POST', headers, signal,
        body: JSON.stringify({
          model: p.model, max_tokens: maxTokens || 4096,
          messages: [{ role: 'system', content: system }, ...messages],
          tools: tools.map(t => ({ type: 'function', function: { name: t.name, description: t.description, parameters: t.schema } })),
          tool_choice: forceFinal ? 'none' : 'auto',
        }),
      });
    } catch (e) { throw networkError(e, p); }
    if (!res.ok) throw await httpError(res, p);
    const j = await res.json();
    const msg = j.choices?.[0]?.message || {};
    const calls = (msg.tool_calls || []).map((tc, i) => {
      let input = {};
      try {
        input = typeof tc.function?.arguments === 'string' ? JSON.parse(tc.function.arguments || '{}') : (tc.function?.arguments || {});
      } catch (e) { input = { _parseError: String(tc.function?.arguments).slice(0, 200) }; }
      return { id: tc.id || `call_${Date.now()}_${i}`, name: tc.function?.name, input };
    });
    const assistant = { role: 'assistant', content: msg.content ?? (calls.length ? null : '') };
    if (calls.length) assistant.tool_calls = calls.map(c => ({ id: c.id, type: 'function', function: { name: c.name, arguments: JSON.stringify(c.input) } }));
    return { text: msg.content || '', calls, assistant, usage: j.usage, truncated: j.choices?.[0]?.finish_reason === 'length' };
  }

  /** ผลของเครื่องมือในรูปแบบข้อความของแต่ละค่าย — ทุกผลของรอบเดียวกันต้องอยู่ในข้อความเดียว (Anthropic) */
  function toolResultMessages(provider, calls, results) {
    if (PROVIDERS[provider]?.kind === 'anthropic') {
      return [{ role: 'user', content: calls.map((c, i) => ({ type: 'tool_result', tool_use_id: c.id, content: results[i].text, is_error: !!results[i].error })) }];
    }
    return calls.map((c, i) => ({ role: 'tool', tool_call_id: c.id, content: results[i].text }));
  }

  const userMessage = text => ({ role: 'user', content: text });

  return {
    PROVIDERS, GROUPS, AIError,
    loadConfig, saveConfig, getKey, setKey, forgetAllKeys,
    stream, listModels, chromeStatus,
    markdown, extractJSON,
    estimateTokens, priceFor, supportsTools, toolStep, toolResultMessages, userMessage,
  };
})();
