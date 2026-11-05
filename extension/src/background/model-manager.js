// 翻译引擎：本地（Transformers.js）或云端（Groq 免费档，OpenAI 兼容接口）。
//
//  本地 fast  : Xenova/opus-mt-en-zh          ~113MB，CPU 单句约 0.25s
//  本地 quality: onnx-community/Qwen2.5-0.5B-Instruct  ~0.5-1GB，CPU 较慢
//  云端 groq  : Llama 3.x / GPT-OSS 等，带上下文翻译，质量最好；失败自动回退本地
//
// 运行在 offscreen 文档里（Chrome 只给它 chrome.runtime），因此所有设置都由 service worker
// 通过 configure() 随消息传入，本模块不直接访问 chrome.storage。
import "../shared/protocol.js";
import { cloudTranslate, listModels, PROVIDERS, CloudError } from "./cloud-translator.js";

const CONFIG = globalThis.ST.CONFIG;

const ENGINE_MT = "mt";
const ENGINE_QWEN = "qwen";
const ENGINE_GROQ = "groq";
const MT_MODEL_ID = "Xenova/opus-mt-en-zh";

let pipelineFn = null;
let env = null;
let generator = null;
let loadPromise = null;
let gpuKeepAlive = null;

export const state = {
  phase: "idle", // idle | downloading | loading | warming | ready | error
  engine: null,          // 用户选择的引擎
  localEngine: null,     // 当前已加载的本地管线
  device: null,          // webgpu | wasm | cloud
  dtype: null,           // fp16 / q8 / uint8 …（云端时为模型名）
  progress: null,
  message: "",
  error: null,
  loadedAt: null,
  deviceReason: "",
  fallbackFrom: null,
  resolvedDevice: null,
  resolvedDtype: null,
  warmupMs: null,
  gpuUnusable: false,
  cloud: { model: null, calls: 0, failures: 0, lastError: null, lastUsage: null, notice: null, cooldownUntil: 0 },
  translations: 0,
  inflight: 0,
  queue: 0,
  stats: { calls: 0, totalMs: 0, lastMs: 0, cached: 0, timeouts: 0, localFallbacks: 0 },
  lastRaw: null,
};

const config = {
  devicePreference: null,
  dtypeOverride: null,
  skipWebgpu: false,
  resolvedDevice: null,
  resolvedDtype: null,
  engine: ENGINE_MT,
  cloudProvider: "google",           // google | openai(OpenAI 兼容：Gemini/OpenRouter/DeepSeek/…) | groq
  cloudKey: "",
  cloudModel: "",
  cloudBaseUrl: "",
  cloudFallbackLocal: true,
};

const progressByFile = new Map();

let onStatusChange = null;
export function setStatusListener(fn) { onStatusChange = fn; }

export function snapshot() {
  return {
    state: state.phase,
    engine: state.engine,
    localEngine: state.localEngine,
    device: state.device,
    dtype: state.dtype,
    progress: state.progress,
    message: state.message,
    error: state.error,
    loadedAt: state.loadedAt,
    deviceReason: state.deviceReason,
    fallbackFrom: state.fallbackFrom,
    resolvedDevice: state.resolvedDevice,
    resolvedDtype: state.resolvedDtype,
    warmupMs: state.warmupMs,
    gpuUnusable: state.gpuUnusable,
    cloud: { ...state.cloud },
    translations: state.translations,
    inflight: state.inflight,
    stats: { ...state.stats },
    lastRaw: state.lastRaw || null,
  };
}

function emit(extra) {
  const snap = { ...snapshot(), ...(extra || {}) };
  try { if (onStatusChange) onStatusChange(snap); } catch { /* ignore */ }
  return snap;
}

export function getConfig() { return { ...config }; }

export function engineOf() {
  if (config.engine === ENGINE_GROQ) return ENGINE_GROQ;
  return config.engine === ENGINE_QWEN ? ENGINE_QWEN : ENGINE_MT;
}
export function isCloudEngine() { return engineOf() === ENGINE_GROQ; }
export function localEngineForFallback() { return ENGINE_MT; }
function cloudLabel() {
  const p = PROVIDERS[config.cloudProvider] || PROVIDERS.google;
  const model = config.cloudModel || p.defaultModel || "";
  return model ? `${p.label.split("（")[0]} · ${model}` : p.label;
}
export function modelIdFor(engine) {
  if (engine === ENGINE_GROQ) return `cloud:${config.cloudProvider}:${config.cloudModel || ""}`;
  return engine === ENGINE_QWEN ? CONFIG.MODEL_ID : MT_MODEL_ID;
}
export function taskFor(engine) { return engine === ENGINE_QWEN ? "text-generation" : "translation"; }
export function engineLabel(engine) {
  if (engine === ENGINE_GROQ) return `云端 · ${cloudLabel()}`;
  return engine === ENGINE_QWEN ? "Qwen2.5-0.5B（高质量·较慢）" : "opus-mt-en-zh（快速·约113MB）";
}

export function configure(next) {
  if (!next) return { changed: false, reload: false };
  let changed = false, reload = false;
  if (next.devicePreference !== undefined) { const v = next.devicePreference || null; if (v !== config.devicePreference) { config.devicePreference = v; changed = true; reload = true; } }
  if (next.dtypeOverride !== undefined) { const v = next.dtypeOverride || null; if (v !== config.dtypeOverride) { config.dtypeOverride = v; changed = true; reload = true; } }
  if (next.skipWebgpu !== undefined) { const v = !!next.skipWebgpu; if (v !== config.skipWebgpu) { config.skipWebgpu = v; changed = true; reload = true; } }
  if (next.resolvedDevice !== undefined) { const v = next.resolvedDevice || null; if (v !== config.resolvedDevice) { config.resolvedDevice = v; changed = true; } }
  if (next.resolvedDtype !== undefined) { const v = next.resolvedDtype || null; if (v !== config.resolvedDtype) { config.resolvedDtype = v; changed = true; } }
  if (next.engine !== undefined) {
    const v = [ENGINE_QWEN, ENGINE_GROQ].includes(next.engine) ? next.engine : ENGINE_MT;
    if (v !== config.engine) { config.engine = v; changed = true; reload = true; }
  }
  if (next.cloudProvider !== undefined && next.cloudProvider !== config.cloudProvider) { config.cloudProvider = next.cloudProvider || "google"; changed = true; }
  if (next.cloudKey !== undefined && next.cloudKey !== config.cloudKey) { config.cloudKey = next.cloudKey || ""; changed = true; }
  if (next.cloudModel !== undefined && next.cloudModel !== config.cloudModel) { config.cloudModel = next.cloudModel || ""; changed = true; }
  if (next.cloudBaseUrl !== undefined && next.cloudBaseUrl !== config.cloudBaseUrl) { config.cloudBaseUrl = next.cloudBaseUrl || ""; changed = true; }
  if (next.cloudFallbackLocal !== undefined) config.cloudFallbackLocal = next.cloudFallbackLocal !== false;
  return { changed, reload };
}

export async function resetPipeline(reason) {
  try { if (generator && typeof generator.dispose === "function") await generator.dispose(); } catch { /* ignore */ }
  generator = null;
  loadPromise = null;
  state.localEngine = null;
  progressByFile.clear();
  state.phase = "idle";
  state.progress = null;
  state.error = null;
  state.warmupMs = null;
  state.device = null;
  state.dtype = null;
  state.message = reason ? `已重置本地模型（${reason}）` : "本地模型已重置";
  emit();
}

export async function holdGpu() {
  try {
    if (typeof navigator === "undefined" || !navigator.gpu || typeof navigator.gpu.requestAdapter !== "function") return false;
    if (gpuKeepAlive) return true;
    const adapter = await navigator.gpu.requestAdapter();
    if (!adapter) return false;
    const device = await adapter.requestDevice();
    gpuKeepAlive = { adapter, device };
    device.lost.then(() => { gpuKeepAlive = null; }).catch(() => { gpuKeepAlive = null; });
    return true;
  } catch {
    gpuKeepAlive = null;
    return false;
  }
}
export function hasGpuHold() { return !!gpuKeepAlive; }

async function detectDevice(preference) {
  if (preference === "wasm") return { device: "wasm", reason: "用户已强制使用 WASM（CPU）" };
  if (!preference && config.skipWebgpu) return { device: "wasm", reason: "此前 WebGPU 自检失败，已记住并直接使用 WASM" };
  try {
    if (typeof navigator !== "undefined" && navigator.gpu && typeof navigator.gpu.requestAdapter === "function") {
      const adapter = await navigator.gpu.requestAdapter();
      if (adapter) {
        let info = "";
        try {
          const a = adapter.info || (adapter.requestAdapterInfo ? await adapter.requestAdapterInfo() : null);
          if (a) info = [a.vendor, a.architecture || a.description].filter(Boolean).join(" ");
        } catch { /* optional */ }
        return { device: "webgpu", reason: info || "WebGPU" };
      }
      return { device: "wasm", reason: "浏览器未提供 WebGPU 适配器" };
    }
    return { device: "wasm", reason: "浏览器不支持 WebGPU" };
  } catch (err) {
    return { device: "wasm", reason: `WebGPU 检测失败：${err && err.message ? err.message : err}` };
  }
}

function dtypeFor(engine, device) {
  if (config.dtypeOverride) return config.dtypeOverride;
  if (config.resolvedDtype && !config.devicePreference && ["fp16", "q8", "q4", "uint8", "fp32"].includes(config.resolvedDtype)) return config.resolvedDtype;
  if (engine === ENGINE_MT) return device === "webgpu" ? "fp16" : "q8";
  return device === "webgpu" ? CONFIG.TRANSLATION_DTYPE_WEBGPU : CONFIG.TRANSLATION_DTYPE_WASM;
}

function onProgress(info) {
  try {
    const key = info.file || info.name || "unknown";
    if (Number.isFinite(info.total) && info.total > 0) {
      progressByFile.set(key, { loaded: Number(info.loaded) || 0, total: Number(info.total) });
      let loaded = 0;
      let total = 0;
      for (const v of progressByFile.values()) { loaded += v.loaded; total += v.total; }
      if (total > 0) {
        state.progress = Math.min(99.5, (loaded / total) * 100);
        state.message = `模型下载中 ${(loaded / 1048576).toFixed(0)} / ${(total / 1048576).toFixed(0)} MB（只下载一次，之后离线可用）`;
      }
    } else if (info.status === "initiate") {
      state.message = `准备下载 ${key}`;
    }
    if (info.status === "ready") {
      state.progress = 99.5;
      state.message = "权重就绪，正在创建推理会话…";
    }
  } catch { /* cosmetic */ }
}

async function clearModelCache() {
  try {
    if (typeof caches === "undefined") return false;
    const names = await caches.keys();
    for (const name of names) {
      const cache = await caches.open(name);
      const keys = await cache.keys();
      await Promise.all(keys.map((k) => cache.delete(k)));
    }
    progressByFile.clear();
    state.progress = null;
    return true;
  } catch {
    return false;
  }
}

async function ensureRuntime() {
  if (pipelineFn) return;
  const mod = await import("../../vendor/transformers/transformers.min.js");
  pipelineFn = mod.pipeline;
  env = mod.env;
  env.allowLocalModels = true;
  env.localModelPath = chrome.runtime.getURL("vendor/translate/");
  env.allowRemoteModels = false;
  env.useBrowserCache = true;
  try {
    if (env.backends && env.backends.onnx && env.backends.onnx.wasm) {
      env.backends.onnx.wasm.wasmPaths = chrome.runtime.getURL("vendor/transformers/");
      // 扩展页面不允许 blob: worker（MV3 CSP），ORT 默认的代理 Worker 会让推理永久挂起
      env.backends.onnx.wasm.proxy = false;
    }
  } catch (err) {
    state.lastError = `ORT 运行时配置失败: ${err && err.message ? err.message : err}`;
  }
}

async function createPipeline(engine, device, dtype) {
  // transformers.js 的 env 是全局单例：ASR 初始化会把 localModelPath 改成 vendor/asr/。
  // 每次创建翻译管线前必须重新指向翻译模型目录，否则 ASR 之后重载翻译模型会找错路径。
  env.allowLocalModels = true;
  env.allowRemoteModels = false;
  env.localModelPath = chrome.runtime.getURL("vendor/translate/");
  return await pipelineFn(taskFor(engine), modelIdFor(engine), { device, dtype, progress_callback: onProgress });
}

function withTimeout(promise, ms, message) {
  let timer = null;
  return Promise.race([
    promise.finally(() => { if (timer) clearTimeout(timer); }),
    new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(message)), ms); }),
  ]);
}

const SYSTEM_PROMPT =
  "你是英译中字幕翻译引擎。只输出对应的简体中文译文。" +
  "规则：像中文母语者写的口语字幕，优先意译，句子通顺自然，不要逐词直译；" +
  "保留人名、地名、品牌、专业术语；不添加原文没有的信息；" +
  "绝不输出英文原文，不加引号、解释、拼音或换行。";

const FEWSHOT = [
  { role: "user", content: "Hello everyone, and welcome back to the channel." },
  { role: "assistant", content: "大家好，欢迎回到本频道。" },
  { role: "user", content: "It's just to go by the way." },
  { role: "assistant", content: "只是顺路走走而已。" },
  { role: "user", content: "Some sources say it takes 600 hours of focused learning to reach functional fluency." },
  { role: "assistant", content: "有资料称，要达到实用流利大约需要 600 小时专注学习。" },
];

const STRICT_PROMPT =
  "你是英译中翻译引擎。把当前这句英文翻译成自然通顺的简体中文，只输出中文译文，不要输出英文、解释或换行。";

function buildMessages(en, strict, prevLines) {
  const system = { role: "system", content: strict ? STRICT_PROMPT : SYSTEM_PROMPT };
  const context = Array.isArray(prevLines) ? prevLines.map((x) => String(x || "").trim()).filter(Boolean).slice(-2) : [];
  const body = context.length
    ? "前文（只用于理解上下文，绝对不要翻译）：\n" + context.join("\n") + "\n\n当前这句（只翻译这一句）：\n" + en
    : en;
  if (strict) return [system, { role: "user", content: body }];
  return [system, ...FEWSHOT, { role: "user", content: body }];
}

function extractText(out) {
  if (!out) return "";
  const first = Array.isArray(out) ? out[0] : out;
  if (!first) return "";
  if (typeof first.translation_text === "string") return first.translation_text;
  const g = first.generated_text;
  if (Array.isArray(g)) {
    const last = g[g.length - 1];
    return typeof last === "string" ? last : (last && last.content) || "";
  }
  return typeof g === "string" ? g : "";
}

export function cleanTranslation(raw, source) {
  let text = String(raw || "").trim();
  text = text.replace(/^(译文|翻译|中文|简体中文)\s*[:：]\s*/i, "");
  text = text.replace(/^["'“”‘’]+|["'“”‘’]+$/g, "");
  text = text.replace(/[\r\n]+/g, " ").replace(/\s{2,}/g, " ").trim();
  if (text && source && text.toLowerCase() === String(source).trim().toLowerCase()) text = "";
  return text;
}

function hasChinese(text) {
  return /[\u4e00-\u9fff\u3400-\u4dbf]/.test(String(text || ""));
}

async function runGeneration(engine, text, maxNewTokens, timeoutMs) {
  const started = Date.now();
  if (engine === ENGINE_MT) {
    const out = await withTimeout(generator(text, { max_new_tokens: maxNewTokens }), timeoutMs, `推理超时（${Math.round(timeoutMs / 1000)} 秒）`);
    return { text: extractText(out), ms: Date.now() - started };
  }
  const out = await withTimeout(
    generator(text, { max_new_tokens: maxNewTokens, do_sample: false, repetition_penalty: 1.05 }),
    timeoutMs,
    `推理超时（${Math.round(timeoutMs / 1000)} 秒）`
  );
  return { text: extractText(out), ms: Date.now() - started };
}

async function loadLocalWith(engine, device, dtype) {
  state.engine = engineOf();
  state.localEngine = engine;
  state.device = device;
  state.dtype = dtype;
  state.phase = "downloading";
  state.progress = null;
  state.error = null;
  state.gpuUnusable = false;
  progressByFile.clear();
  emit();
  if (device === "webgpu") await holdGpu();
  generator = await createPipeline(engine, device, dtype);
  state.phase = "warming";
  state.message = `正在初始化并自检 ${device === "webgpu" ? "WebGPU" : "WASM"} 推理（首次需要编译模型，请稍候）…`;
  emit();
  const warmupBudget = device === "webgpu" ? CONFIG.WARMUP_TIMEOUT_MS : CONFIG.WARMUP_TIMEOUT_MS_WASM;
  const warm = await runGeneration(engine, "Hello everyone.", 16, warmupBudget);
  state.warmupMs = warm.ms;
  state.resolvedDevice = device;
  state.resolvedDtype = dtype;
  return warm;
}

/** 云端引擎：无需任何本地权重 */
function markCloudReady() {
  const provider = PROVIDERS[config.cloudProvider] || PROVIDERS.google;
  const model = config.cloudModel || provider.defaultModel || "";
  state.engine = ENGINE_GROQ;
  state.device = "cloud";
  state.dtype = model;
  state.phase = "ready";
  state.progress = 100;
  state.error = null;
  state.loadedAt = Date.now();
  state.cloud.model = model;
  state.cloud.provider = config.cloudProvider;
  const needsKey = provider.needsKey !== false;
  state.message = !needsKey || config.cloudKey
    ? "在线翻译已就绪"
    : "在线翻译需要先填写 API Key（在扩展图标里）";
  emit();
  return snapshot();
}

export async function ensureLoaded() {
  if (engineOf() === ENGINE_GROQ) return markCloudReady();
  if (state.phase === "ready" && generator && state.localEngine === engineOf()) return snapshot();
  if (loadPromise) return loadPromise;

  loadPromise = (async () => {
    await ensureRuntime();
    const engine = engineOf();
    let detected;
    if (!config.devicePreference && (config.resolvedDevice === "webgpu" || config.resolvedDevice === "wasm")) {
      detected = { device: config.resolvedDevice, reason: "沿用上次成功的推理设备（权重已缓存，不会重新下载）" };
    } else {
      detected = await detectDevice(config.devicePreference);
    }
    const dtype = dtypeFor(engine, detected.device);
    state.deviceReason = detected.reason;
    state.fallbackFrom = null;
    state.message = `使用 ${detected.device === "webgpu" ? "WebGPU" : "WASM"} 加载 ${engineLabel(engine)}（${detected.reason}）`;
    emit();

    let firstError = null;
    const dispose = async () => {
      try { if (generator && generator.dispose) await generator.dispose(); } catch { /* ignore */ }
      generator = null;
    };
    try {
      await loadLocalWith(engine, detected.device, dtype);
    } catch (err) {
      firstError = err && err.message ? err.message : String(err);
      await dispose();
      state.message = `模型加载失败（${String(firstError).slice(0, 80)}），正在清空本地权重缓存并重新下载…`;
      emit();
      if (await clearModelCache()) {
        try {
          await loadLocalWith(engine, detected.device, dtype);
          firstError = null;
        } catch (err2) {
          firstError = err2 && err2.message ? err2.message : String(err2);
          await dispose();
        }
      }
    }

    if (!generator && detected.device === "webgpu" && config.devicePreference !== "webgpu") {
      state.fallbackFrom = "webgpu";
      state.gpuUnusable = true;
      state.message = `WebGPU 不可用（${firstError}），已回退到 WASM（CPU，性能下降）`;
      emit();
      try {
        await loadLocalWith(engine, "wasm", dtypeFor(engine, "wasm"));
      } catch (err) {
        const second = err && err.message ? err.message : String(err);
        state.phase = "error";
        state.error = second;
        state.message = `模型加载失败：${second}`;
        loadPromise = null;
        emit();
        throw new Error(state.message);
      }
    } else if (!generator) {
      state.phase = "error";
      state.error = firstError || "未知错误";
      state.message = `模型加载失败：${state.error}`;
      loadPromise = null;
      emit();
      throw new Error(state.message);
    }

    state.phase = "ready";
    state.progress = 100;
    state.loadedAt = Date.now();
    const deviceText = state.device === "webgpu" ? "WebGPU" : "WASM CPU";
    state.message = state.fallbackFrom
      ? `本地模型就绪（${deviceText}，因 WebGPU 不可用而回退，性能下降）`
      : `本地模型就绪（${deviceText}，${engineLabel(engine)}）`;
    emit();
    return snapshot();
  })();

  try {
    return await loadPromise;
  } catch (err) {
    loadPromise = null;
    throw err;
  }
}

/** 云端失败时用的本地兜底（不改变用户选择的引擎） */
async function translateWithLocalFallback(text) {
  const local = localEngineForFallback();
  if (!generator || state.localEngine !== local) {
    if (state.localEngine && state.localEngine !== local) await resetPipeline("切换到本地兜底引擎");
    // 临时把"配置引擎"切到本地，让 ensureLoaded() 去加载本地管线，再切回来
    const savedEngine = config.engine;
    config.engine = local;
    loadPromise = null;
    try {
      await ensureLoaded();
    } finally {
      config.engine = savedEngine;
    }
  }
  if (!generator) throw new Error("本地兜底模型不可用");
  const timeout = state.device === "webgpu" ? 60000 : 150000;
  const { text: raw } = await runGeneration(local, text, CONFIG.MAX_NEW_TOKENS, timeout);
  return cleanTranslation(raw, text);
}

export async function translateLine(text, options) {
  const opts = options || {};
  const engine = engineOf();

  if (engine === ENGINE_GROQ) {
    globalThis.__stDrainStage = "cloud";
    const now = Date.now();
    const cooling = now < (state.cloud.cooldownUntil || 0);
    if (!cooling) {
      try {
        const provider = PROVIDERS[config.cloudProvider] || PROVIDERS.google;
        const res = await cloudTranslate({
          provider: config.cloudProvider,
          text,
          prevLines: opts.prevLines,
          apiKey: config.cloudKey,
          baseUrl: config.cloudBaseUrl || provider.defaultBaseUrl || "",
          model: config.cloudModel || provider.defaultModel || "",
          timeoutMs: opts.timeoutMs || 45000,
        });
        const zh = cleanTranslation(res.zh, text);
        if (!hasChinese(zh)) throw new CloudError("云端返回的不是中文", "bad-response", 0);
        state.cloud.calls++;
        state.cloud.failures = 0;
        state.cloud.lastError = null;
        state.cloud.lastUsage = res.usage || null;
        state.cloud.notice = null;
        state.stats.lastMs = 0;
        state.translations++;
        return { zh, device: "cloud", dtype: res.model || state.dtype, engine: ENGINE_GROQ, usage: res.usage || null };
      } catch (err) {
        state.cloud.failures++;
        state.cloud.lastError = err && err.message ? err.message : String(err);
        const kind = err && err.kind ? err.kind : "unknown";
        // 限流/网络/服务端错误：冷却一段时间，期间直接用本地
        if (kind === "rate" || kind === "server" || kind === "network") {
          state.cloud.cooldownUntil = Date.now() + (kind === "rate" ? 60000 : 20000);
        }
        state.cloud.notice = kind === "auth" && /API Key|未填写/i.test(state.cloud.lastError)
          ? "在线翻译需要先填写 API Key"
          : "在线翻译暂时不可用，已改用离线翻译";
        emit();
        if (!config.cloudFallbackLocal) throw err;
      }
    } else {
      state.cloud.notice = "云端限流冷却中，已临时改用本地引擎";
      emit();
    }
    // 回退本地
    state.stats.localFallbacks++;
    try {
      const zh = await translateWithLocalFallback(text);
      if (!hasChinese(zh)) throw new Error("本地兜底也没有给出中文译文");
      state.translations++;
      return { zh, device: state.device, dtype: state.dtype, engine: state.localEngine, fallback: true, cloudError: state.cloud.lastError };
    } catch (localErr) {
      const cloudErr = state.cloud.lastError ? `云端：${state.cloud.lastError}；` : "";
      throw new Error(`${cloudErr}本地兜底也失败：${localErr && localErr.message ? localErr.message : localErr}`);
    }
  }

  // 本地引擎
  globalThis.__stDrainStage = "ensureLoaded";
  await ensureLoaded();
  globalThis.__stDrainStage = "inference";
  const timeout = state.localEngine === ENGINE_MT ? 30000 : (state.device === "webgpu" ? 60000 : 150000);
  state.inflight++;
  state.stats.calls++;
  try {
    const startedAt = Date.now();
    let { text: raw } = await runGeneration(state.localEngine, state.localEngine === ENGINE_MT ? text : buildMessages(text, false, opts.prevLines), CONFIG.MAX_NEW_TOKENS, timeout);
    state.lastRaw = String(raw || "").slice(0, 200);
    let zh = cleanTranslation(raw, text);
    if (!hasChinese(zh)) zh = "";
    if (!zh && state.localEngine === ENGINE_QWEN && Date.now() - startedAt < 60000) {
      ({ text: raw } = await runGeneration(state.localEngine, buildMessages(text, true, opts.prevLines), CONFIG.MAX_NEW_TOKENS, timeout));
      state.lastRaw = String(raw || "").slice(0, 200);
      zh = cleanTranslation(raw, text);
      if (!hasChinese(zh)) zh = "";
    }
    if (!zh) throw new Error(raw ? "模型没有给出中文译文（英文回显）" : "模型没有返回内容");
    state.stats.lastMs = Date.now() - startedAt;
    state.stats.totalMs += state.stats.lastMs;
    state.translations++;
    return { zh, device: state.device, dtype: state.dtype, engine: state.localEngine, ms: state.stats.lastMs };
  } catch (err) {
    if (/超时/.test(err && err.message ? err.message : "")) state.stats.timeouts++;
    throw err;
  } finally {
    state.inflight--;
  }
}

export async function testCloud(overrides) {
  const o = overrides || {};
  const provider = o.provider || config.cloudProvider || "google";
  const preset = PROVIDERS[provider] || PROVIDERS.google;
  const apiKey = o.apiKey !== undefined ? o.apiKey : config.cloudKey;
  const baseUrl = o.baseUrl || config.cloudBaseUrl || preset.defaultBaseUrl || "";
  const model = o.model || config.cloudModel || preset.defaultModel || "";
  let models = [];
  try { models = await listModels({ provider, apiKey, baseUrl }); } catch { models = []; }
  const res = await cloudTranslate({
    provider,
    text: "This is a neural network.",
    prevLines: ["Welcome back to the channel."],
    apiKey,
    baseUrl,
    model,
    timeoutMs: 30000,
  });
  return { zh: res.zh, model: res.model, usage: res.usage, models, provider };
}

export function getStatus() { return snapshot(); }
export function markCached(n) { state.stats.cached += Number(n) || 0; }
export function setQueueDepth(n) { state.queue = Number(n) || 0; }
export { ENGINE_MT, ENGINE_QWEN, ENGINE_GROQ };

globalThis.__stModelDebug = () => ({ phase: state.phase, engine: engineOf(), localEngine: state.localEngine, hasGenerator: !!generator, loadPending: !!loadPromise, message: state.message, error: state.error, progress: state.progress, queue: state.queue, inflight: state.inflight, device: state.device, dtype: state.dtype });
