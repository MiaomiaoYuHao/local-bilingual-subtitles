// 云端翻译引擎（多服务商）。
//
//   google  谷歌翻译免费接口（免 key，地区可达性最好，质量=谷歌翻译）
//   openai  任意 OpenAI 兼容接口（OpenRouter / Gemini / DeepSeek / SiliconFlow / Ollama …）
//   groq    Groq 免费档（部分地区被 Cloudflare 封锁，会直接 403）
//
// 统一入口 cloudTranslate({provider, apiKey, baseUrl, model, text, prevLines})，
// LLM 类会带上「上文 2 句」做上下文；传统 MT（谷歌）只翻当前句。
import "../shared/protocol.js";

export const GOOGLE_ENDPOINT = "https://translate.googleapis.com/translate_a/single";
export const GROQ_BASE = "https://api.groq.com/openai/v1";

export const PROVIDERS = {
  google: {
    id: "google",
    label: "谷歌翻译（免 Key，最快上手）",
    needsKey: false,
    defaultModel: "google-translate",
    note: "非官方接口，免费、无需注册；质量=谷歌翻译，可能限流。",
  },
  openai: {
    id: "openai",
    label: "OpenAI 兼容接口（OpenRouter / Gemini / DeepSeek / Ollama …）",
    needsKey: true,
    defaultModel: "google/gemini-2.5-flash",
    defaultBaseUrl: "https://openrouter.ai/api/v1",
    presets: [
      { label: "OpenRouter（有免费模型）", baseUrl: "https://openrouter.ai/api/v1", model: "meta-llama/llama-3.3-70b-instruct:free", keyUrl: "https://openrouter.ai/keys" },
      { label: "Google Gemini（免费额度）", baseUrl: "https://generativelanguage.googleapis.com/v1beta/openai", model: "gemini-2.5-flash", keyUrl: "https://aistudio.google.com/apikey" },
      { label: "DeepSeek（便宜）", baseUrl: "https://api.deepseek.com/v1", model: "deepseek-chat", keyUrl: "https://platform.deepseek.com/api_keys" },
      { label: "硅基流动 SiliconFlow", baseUrl: "https://api.siliconflow.cn/v1", model: "Qwen/Qwen3-8B", keyUrl: "https://cloud.siliconflow.cn/account/ak" },
      { label: "本地 Ollama", baseUrl: "http://127.0.0.1:11434/v1", model: "qwen3:8b", keyUrl: "" },
    ],
    note: "任何兼容 /chat/completions 的接口都能填；LLM 会带上下文翻译，质量最好。",
  },
  groq: {
    id: "groq",
    label: "Groq 免费档（部分地区被封锁）",
    needsKey: true,
    defaultModel: "llama-3.1-8b-instant",
    models: [
      { id: "llama-3.1-8b-instant", label: "Llama 3.1 8B（最快）" },
      { id: "llama-3.3-70b-versatile", label: "Llama 3.3 70B（更好）" },
      { id: "openai/gpt-oss-20b", label: "GPT-OSS 20B" },
      { id: "openai/gpt-oss-120b", label: "GPT-OSS 120B" },
    ],
    note: "中国大陆/香港等地区会被 Cloudflare 拦成 403，需梯子。",
  },
};

export class CloudError extends Error {
  constructor(message, kind, status) {
    super(message);
    this.name = "CloudError";
    this.kind = kind || "unknown"; // auth | rate | model | network | geo | server | bad-response
    this.status = status || 0;
  }
}

function failFromStatus(status, detail) {
  const kind = status === 401 || status === 403 ? (/country|region|territory|Forbidden/i.test(detail) && status === 403 ? "geo" : "auth")
    : status === 429 ? "rate"
    : status === 404 ? "model"
    : status >= 500 ? "server" : "bad-response";
  return new CloudError(`HTTP ${status}：${detail}`, kind, status);
}

const SYSTEM_PROMPT =
  "你是影视字幕翻译引擎，把英文字幕翻译成自然、口语化的简体中文。" +
  "规则：只输出中文译文本身；不要解释、不要加引号、不要音译、不要输出英文原文；输出一行。";

function buildUserPrompt(text, prevLines) {
  const ctx = (prevLines || []).filter((l) => l && l.trim()).slice(-2);
  if (!ctx.length) return `把下面这句英文字幕翻译成简体中文，只输出中文：\n${text}`;
  return (
    "上文（仅供理解语境，不要翻译）：\n" +
    ctx.map((l) => `- ${l}`).join("\n") +
    `\n\n请只翻译下面这一句，直接输出中文译文：\n${text}`
  );
}

async function fetchWithTimeout(url, options, timeoutMs) {
  const controller = typeof AbortController !== "undefined" ? new AbortController() : null;
  const timer = setTimeout(() => { try { controller && controller.abort(); } catch { /* ignore */ } }, timeoutMs);
  try {
    return await fetch(url, { ...options, signal: controller ? controller.signal : undefined });
  } catch (err) {
    if (controller && controller.signal.aborted) throw new CloudError(`请求超时（${Math.round(timeoutMs / 1000)} 秒）`, "network", 0);
    throw new CloudError(`网络请求失败：${err && err.message ? err.message : err}`, "network", 0);
  } finally {
    clearTimeout(timer);
  }
}

/** 谷歌翻译免费接口（GET，返回嵌套数组） */
export async function googleTranslate({ text, timeoutMs }) {
  const url = `${GOOGLE_ENDPOINT}?client=gtx&sl=en&tl=zh-CN&dt=t&dj=1&q=${encodeURIComponent(text)}`;
  const res = await fetchWithTimeout(url, { method: "GET" }, timeoutMs || 20000);
  const raw = await res.text().catch(() => "");
  if (!res.ok) throw failFromStatus(res.status, raw.slice(0, 160));
  let data = null;
  try { data = JSON.parse(raw); } catch { throw new CloudError("谷歌接口返回内容无法解析", "bad-response", res.status); }
  const sentences = Array.isArray(data && data.sentences) ? data.sentences : [];
  const zh = sentences.map((s) => s.trans || "").join("").trim();
  if (!zh) {
    // 兼容未加 dj=1 的旧格式
    const legacy = Array.isArray(data) && Array.isArray(data[0]) ? data[0].map((p) => (p && p[0]) || "").join("") : "";
    if (!legacy.trim()) throw new CloudError("谷歌接口没有返回译文（可能被限流）", "bad-response", res.status);
    return { zh: legacy.trim(), model: "google-translate", usage: null };
  }
  return { zh, model: "google-translate", usage: null };
}

/** 任意 OpenAI 兼容 /chat/completions */
export async function openAiCompatibleTranslate({ baseUrl, apiKey, model, text, prevLines, timeoutMs, temperature, providerTag }) {
  const base = String(baseUrl || "").replace(/\/+$/, "");
  if (!base) throw new CloudError("未填写接口地址（Base URL）", "auth", 0);
  if (!model) throw new CloudError("未填写模型名", "model", 0);
  const headers = { "content-type": "application/json" };
  if (apiKey) headers.authorization = `Bearer ${apiKey}`;
  const buildBody = (withReasoning) => JSON.stringify({
    model,
    messages: [
      { role: "system", content: SYSTEM_PROMPT },
      { role: "user", content: buildUserPrompt(text, prevLines) },
    ],
    temperature: typeof temperature === "number" ? temperature : 0.2,
    max_tokens: 256,           // 字幕很短，压上限降延迟
    stream: false,
    ...(withReasoning ? { reasoning_effort: "none" } : {}),  // 关掉 LLM 的"思考"，否则慢好几倍
  });
  let res = await fetchWithTimeout(`${base}/chat/completions`, { method: "POST", headers, body: buildBody(true) }, timeoutMs || 45000);
  if (res.status === 400) {
    // 个别服务商不认 reasoning_effort：原样重试一次
    const probe = await res.clone().text().catch(() => "");
    if (/reasoning|unknown|unsupported|invalid/i.test(probe)) {
      res = await fetchWithTimeout(`${base}/chat/completions`, { method: "POST", headers, body: buildBody(false) }, timeoutMs || 45000);
    }
  }
  const raw = await res.text().catch(() => "");
  if (!res.ok) {
    let detail = raw.slice(0, 200);
    try { const j = JSON.parse(raw); detail = (j.error && (j.error.message || j.error.type)) || detail; } catch { /* keep raw */ }
    throw failFromStatus(res.status, detail);
  }
  let data = null;
  try { data = JSON.parse(raw); } catch { throw new CloudError("接口返回内容无法解析", "bad-response", res.status); }
  const zh = data && data.choices && data.choices[0] && data.choices[0].message ? data.choices[0].message.content : "";
  return {
    zh: String(zh || "").trim(),
    model: (data && data.model) || model,
    usage: (data && data.usage) || null,
    provider: providerTag || "openai-compatible",
  };
}

/** 统一入口 */
export async function cloudTranslate(opts) {
  const provider = opts.provider || "google";
  if (provider === "google") return await googleTranslate({ text: opts.text, timeoutMs: opts.timeoutMs });
  if (provider === "groq") {
    return await openAiCompatibleTranslate({
      baseUrl: GROQ_BASE, apiKey: opts.apiKey, model: opts.model || PROVIDERS.groq.defaultModel,
      text: opts.text, prevLines: opts.prevLines, timeoutMs: opts.timeoutMs, providerTag: "groq",
    });
  }
  return await openAiCompatibleTranslate({
    baseUrl: opts.baseUrl || PROVIDERS.openai.defaultBaseUrl,
    apiKey: opts.apiKey,
    model: opts.model || PROVIDERS.openai.defaultModel,
    text: opts.text, prevLines: opts.prevLines, timeoutMs: opts.timeoutMs, providerTag: "openai-compatible",
  });
}

/** 拉取 OpenAI 兼容接口的模型列表（尽力而为，失败不影响使用） */
export async function listModels({ provider, apiKey, baseUrl, timeoutMs }) {
  if (provider === "google") return ["google-translate"];
  if (provider === "groq") {
    const res = await fetchWithTimeout(`${GROQ_BASE}/models`, { headers: apiKey ? { authorization: `Bearer ${apiKey}` } : {} }, timeoutMs || 15000);
    if (!res.ok) throw failFromStatus(res.status, "模型列表获取失败");
    const data = await res.json().catch(() => null);
    return (data && data.data ? data.data : []).map((m) => m.id).filter(Boolean).sort();
  }
  const base = String(baseUrl || "").replace(/\/+$/, "");
  if (!base) return [];
  const res = await fetchWithTimeout(`${base}/models`, { headers: apiKey ? { authorization: `Bearer ${apiKey}` } : {} }, timeoutMs || 15000);
  if (!res.ok) throw failFromStatus(res.status, "模型列表获取失败");
  const data = await res.json().catch(() => null);
  return (data && data.data ? data.data : []).map((m) => m.id).filter(Boolean).sort();
}