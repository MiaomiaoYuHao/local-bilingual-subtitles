// MV3 service worker: the extension's message hub and the only context that can use
// chrome.tabs + chrome.storage. It resolves caption sources on behalf of content scripts
// (MAIN-world injection + privileged fetches) and brokers all work for the offscreen
// document, which is limited to chrome.runtime.
import "../shared/protocol.js";
import "../shared/docx.js";
import { resolveYouTube, resolveBilibili, resolveTrackSrc } from "./track-fetchers.js";
import { parseJson3 } from "../parsers/json3.js";
import { parseTimedtextXml } from "../parsers/timedtext-xml.js";

const ST = globalThis.ST;
const { MSG, CONFIG } = ST;

const SW_VERSION = "sw-b103";
/* ------------------------------------------------- 原生助手：系统直接读写 / 打开文件 */

const HOST_NAME = "com.subsnote.host";
const NOTE_FILE_FALLBACK = "双语字幕笔记.docx";
const hostCache = { checked: false, ok: false, version: "", defaultDir: "", error: "" };

function hostCall(action, payload, timeoutMs) {
  return new Promise((resolve) => {
    let done = false;
    const ms = Number.isFinite(timeoutMs) ? timeoutMs : 10000;
    const timer = setTimeout(() => { if (!done) { done = true; resolve({ ok: false, error: "本地助手没有响应" }); } }, ms);
    try {
      chrome.runtime.sendNativeMessage(HOST_NAME, Object.assign({ action }, payload || {}), (res) => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        const lastError = chrome.runtime.lastError;
        if (lastError) { resolve({ ok: false, error: lastError.message || "本地助手未安装" }); return; }
        resolve(res || { ok: false, error: "本地助手没有返回数据" });
      });
    } catch (err) {
      if (!done) { done = true; clearTimeout(timer); }
      resolve({ ok: false, error: String((err && err.message) || err) });
    }
  });
}

/** 等系统弹窗时别让 service worker 被回收 */
function hostKeepAlive(task) {
  const timer = setInterval(() => { try { chrome.runtime.getPlatformInfo(() => { }); } catch { } }, 15000);
  return Promise.resolve(task).finally(() => clearInterval(timer));
}

async function hostReady(force) {
  if (hostCache.checked && !force) return hostCache;
  const res = await hostCall("ping", {}, 8000);
  hostCache.checked = true;
  hostCache.ok = !!(res && res.ok);
  hostCache.version = (res && res.version) || "";
  hostCache.defaultDir = (res && res.defaultDir) || "";
  hostCache.error = (res && res.error) || "";
  if (hostCache.ok && hostCache.defaultDir) {
    try {
      const cur = await chrome.storage.local.get(["st_note_dir_abs"]);
      if (!cur.st_note_dir_abs) await chrome.storage.local.set({ st_note_dir_abs: hostCache.defaultDir });
    } catch { }
  }
  return hostCache;
}

function docxFileName(name) {
  const n = String(name || "").trim() || NOTE_FILE_FALLBACK;
  return /\.docx$/i.test(n) ? n : n.replace(/\.(txt|md|markdown)$/i, "") + ".docx";
}
function joinWindowsPath(dir, name) {
  const d = String(dir || "").replace(/[\\/]+$/, "");
  return d ? d + "\\" + name : name;
}
/** 读笔记文本：优先用兼容压缩格式的解析（Word/WPS 重存过的也能读） */
async function readDocxText(docx, bytes) {
  if (docx.extractTextFromDocx) {
    const text = await docx.extractTextFromDocx(bytes);
    if (text !== null && text !== undefined) return text;
    if (!docx.extractTextFromStoredDocx) return null;
  }
  return docx.extractTextFromStoredDocx ? docx.extractTextFromStoredDocx(bytes) : null;
}

/** 文件被 Word / WPS 打开占用时，Windows 会拒绝读写 */
function isLockedError(text) {
  return /being used by another process|used by another process|sharing violation|正在被另一进程使用|cannot access the file|拒绝访问/i.test(String(text || ""));
}

function parentFolder(p) {
  return String(p || "").replace(/[\\/][^\\/]*$/, "");
}
function bytesToBase64(bytes) {
  let bin = "";
  const step = 0x8000;
  for (let i = 0; i < bytes.length; i += step) bin += String.fromCharCode.apply(null, bytes.subarray(i, i + step));
  return btoa(bin);
}
function base64ToBytes(b64) {
  const bin = atob(b64 || "");
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

async function noteDirAbs(host) {
  try {
    const st = await chrome.storage.local.get(["st_note_dir_abs"]);
    if (st.st_note_dir_abs) return String(st.st_note_dir_abs);
  } catch { }
  const h = host || (await hostReady());
  return (h && h.ok && h.defaultDir) ? h.defaultDir : "";
}

async function noteName() {
  try {
    const st = await chrome.storage.local.get(["st_note_filename"]);
    return docxFileName(st.st_note_filename);
  } catch { return docxFileName(""); }
}

/** 用系统默认程序直接打开笔记（不下载、不留副本）；助手不可用或找不到文件时返回 null */
async function hostOpenNote(fileName) {
  const host = await hostReady();
  if (!host.ok) return null;
  const name = docxFileName(fileName || (await noteName()));
  let full = "";
  const dir = await noteDirAbs(host);
  if (dir) {
    const candidate = joinWindowsPath(dir, name);
    const ex = await hostCall("exists", { path: candidate }, 8000);
    if (ex.ok && ex.exists) full = candidate;
  }
  if (!full) {
    const found = await hostKeepAlive(hostCall("find", { name }, 25000));
    if (!found || !found.ok || !found.path) return null;
    full = found.path;
  }
  const opened = await hostCall("open", { path: full }, 10000);
  if (!opened.ok) return { ok: false, error: opened.error || "打开失败" };
  const folder = parentFolder(full);
  try {
    const cur = await chrome.storage.local.get(["st_note_dir_abs"]);
    if (folder && cur.st_note_dir_abs !== folder) await chrome.storage.local.set({ st_note_dir_abs: folder });
  } catch { }
  return { ok: true, data: { direct: true, file: name, path: full, folder } };
}

/** 用原生助手追加笔记；助手不可用就返回 null，交给原来的流程 */
async function hostAppendLines(lines, fileName) {
  const host = await hostReady();
  if (!host.ok) return null;
  const dir = await noteDirAbs(host);
  if (!dir) return null;
  const name = docxFileName(fileName || (await noteName()));
  const full = joinWindowsPath(dir, name);
  const body = (Array.isArray(lines) ? lines : String(lines || "").split("\n"))
    .map((l) => String(l || "").replace(/\s+$/, ""))
    .filter((l) => l.trim())
    .join("\n");
  if (!body) return { ok: true, data: { ok: false, reason: "empty" } };

  const docx = globalThis.ST && globalThis.ST.docx;
  let prev = "";
  const readRes = await hostCall("read", { path: full }, 12000);
  if (readRes.ok && readRes.base64) {
    const extracted = docx ? await readDocxText(docx, base64ToBytes(readRes.base64)) : null;
    if (extracted === null || extracted === undefined) return { ok: true, data: { ok: false, reason: "foreign-docx" } };
    prev = extracted;
  } else if (!readRes.ok && readRes.code !== "ENOENT") {
    return { ok: true, data: { ok: false, reason: isLockedError(readRes.error) ? "locked" : "error", error: readRes.error } };
  }

  if (docx && docx.isDuplicateGroup && docx.isDuplicateGroup(prev, body)) {
    return { ok: true, data: { ok: false, reason: "duplicate", file: name, folder: dir } };
  }
  const merged = prev.trimEnd() ? prev.trimEnd() + "\n\n" + body : body;
  const nextText = merged + "\n\n";
  const bytes = docx ? docx.buildFromText(nextText) : new TextEncoder().encode(nextText);
  const writeRes = await hostCall("write", { path: full, base64: bytesToBase64(bytes) }, 15000);
  if (!writeRes.ok) return { ok: true, data: { ok: false, reason: isLockedError(writeRes.error) ? "locked" : "error", error: writeRes.error } };
  return { ok: true, data: { ok: true, file: name, folder: dir, bytes: bytes.length, direct: true } };
}


const debug = {
  startedAt: Date.now(),
  version: chrome.runtime.getManifest().version,
  model: null,
  counts: { getSubtitles: 0, translate: 0, modelStatus: 0, preload: 0, subtitlesOk: 0, subtitlesFail: 0, results: 0, resultsCached: 0 },
  subtitleRequests: [],
  errors: [],
  offscreen: { created: 0, reason: null, failures: 0 },
};
globalThis.__st_debug = debug;
globalThis.__st_sw_version = SW_VERSION;

const MAX_LOG = 40;
function pushLog(list, entry) {
  list.push(entry);
  if (list.length > MAX_LOG) list.shift();
}
function pushError(where, err) {
  pushLog(debug.errors, { at: Date.now(), where, message: err && err.message ? err.message : String(err) });
}

/* ---------------------------------------------------------------- offscreen document */

let creating = null;

async function hasOffscreen() {
  try { return await chrome.offscreen.hasDocument(); } catch (err) { pushError("hasDocument", err); return false; }
}

async function ensureOffscreen() {
  if (await hasOffscreen()) return true;
  if (creating) { await creating; return true; }
  creating = (async () => {
    const attempts = [
      { reasons: ["WORKERS"], justification: "在本地运行 Transformers.js 翻译模型（WebGPU/WASM）：页面 CSP 会阻止 WASM/Worker，Service Worker 又会被回收。" },
      { reasons: ["DOM_SCRAPING"], justification: "在本地运行 Transformers.js 翻译模型（WebGPU/WASM）。" },
    ];
    for (const attempt of attempts) {
      try {
        await chrome.offscreen.createDocument({ url: "src/background/offscreen.html", reasons: attempt.reasons, justification: attempt.justification });
        debug.offscreen.created++;
        debug.offscreen.reason = attempt.reasons.join(",");
        return true;
      } catch (err) {
        pushError(`createDocument(${attempt.reasons.join(",")})`, err);
      }
    }
    debug.offscreen.failures++;
    throw new Error("无法创建离屏文档，本地翻译不可用");
  })();
  try { return await creating; } finally { creating = null; }
}

/** 关掉离屏文档（下次按最新代码重建）：扩展更新后旧实例会继续跑旧代码，必须换掉 */
async function recycleOffscreen(reason) {
  try {
    if (await chrome.offscreen.hasDocument()) {
      await chrome.offscreen.closeDocument();
      debug.offscreen.created = 0;
      console.log("[双语字幕] 已重建离屏文档（" + reason + "）");
    }
  } catch (err) { pushError("recycleOffscreen", err); }
}

const OPFS_VIDEO_DIR = "st-video-cache";

/** 直链视频流式写入 OPFS，避免把大文件整个放进内存。 */
async function fetchVideoToOpfs(url, name) {
  const res = await fetch(url, { credentials: "include" });
  if (!res.ok) throw new Error("视频下载失败 " + res.status);
  if (!res.body) throw new Error("视频流不可读");
  const root = await navigator.storage.getDirectory();
  const dir = await root.getDirectoryHandle(OPFS_VIDEO_DIR, { create: true });
  const safe = String(name || ("v-" + Date.now() + ".mp4")).replace(/[^a-z0-9._-]/gi, "_");
  const fh = await dir.getFileHandle(safe, { create: true });
  const w = await fh.createWritable();
  const reader = res.body.getReader();
  let bytes = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      await w.write(value);
      bytes += value.byteLength || 0;
    }
    await w.close();
  } catch (err) {
    try { await w.abort(); } catch { /* ignore */ }
    throw err;
  }
  return { name: safe, bytes };
}

/** content → SW：把页面 blob 分片上传到 OPFS（端口名 st-opfs-upload）。 */
chrome.runtime.onConnect.addListener((port) => {
  if (!port || port.name !== "st-opfs-upload") return;
  let writable = null, name = "", bytes = 0, closed = false;
  let chain = Promise.resolve();
  const fail = (err) => {
    if (closed) return;
    closed = true;
    try { port.postMessage({ type: "error", error: err && err.message ? err.message : String(err) }); } catch { }
    try { port.disconnect(); } catch { }
  };
  port.onMessage.addListener((msg) => {
    if (!msg || closed) return;
    if (msg.type === "start") {
      (async () => {
        try {
          const root = await navigator.storage.getDirectory();
          const dir = await root.getDirectoryHandle(OPFS_VIDEO_DIR, { create: true });
          name = String(msg.name || ("blob-" + Date.now() + ".mp4")).replace(/[^a-z0-9._-]/gi, "_");
          const fh = await dir.getFileHandle(name, { create: true });
          writable = await fh.createWritable();
          port.postMessage({ type: "ready", name });
        } catch (err) { fail(err); }
      })();
      return;
    }
    if (msg.type === "chunk" && writable) {
      try {
        const bin = atob(String(msg.data || ""));
        const data = new Uint8Array(bin.length);
        for (let i = 0; i < bin.length; i++) data[i] = bin.charCodeAt(i);
        bytes += data.byteLength;
        chain = chain.then(() => writable.write(data)).catch(fail);
      } catch (err) { fail(err); }
      return;
    }
    if (msg.type === "done" && writable) {
      const w = writable;
      writable = null;
      (async () => {
        try {
          await chain;
          await w.close();
          closed = true;
          port.postMessage({ type: "saved", name, bytes });
          pruneVideoCache(3).catch(() => null);
        } catch (err) { fail(err); }
      })();
    }
  });
  port.onDisconnect.addListener(() => {
    if (!closed && writable) { try { writable.abort(); } catch { /* ignore */ } }
  });
});

/** OPFS 视频缓存：最多保留 3 个文件，超过 30 分钟的也清掉。 */
async function pruneVideoCache(maxFiles) {
  const keep = Number.isFinite(maxFiles) ? maxFiles : 3;
  try {
    const root = await navigator.storage.getDirectory();
    const dir = await root.getDirectoryHandle(OPFS_VIDEO_DIR, { create: true });
    const entries = [];
    for await (const [name, handle] of dir.entries()) {
      if (!handle || handle.kind !== "file") continue;
      try {
        const f = await handle.getFile();
        entries.push({ name, time: f.lastModified || 0, size: f.size || 0 });
      } catch { /* ignore */ }
    }
    entries.sort((a, b) => b.time - a.time);
    const now = Date.now();
    for (let i = 0; i < entries.length; i++) {
      if (i < keep && now - entries[i].time < 30 * 60 * 1000) continue;
      try { await dir.removeEntry(entries[i].name); } catch { /* ignore */ }
    }
  } catch { /* cache cleanup is best effort */ }
}

function askOffscreen(type, payload, timeoutMs) {
  return new Promise((resolve, reject) => {
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      reject(new Error("离屏文档无响应（超时）"));
    }, Number.isFinite(timeoutMs) ? timeoutMs : 25000);
    try {
      chrome.runtime.sendMessage({ type, payload }, (res) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        const lastError = chrome.runtime.lastError;
        if (lastError) { reject(new Error(lastError.message)); return; }
        resolve(res);
      });
    } catch (err) {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(err);
    }
  });
}

/** The offscreen document cannot read chrome.storage, so every message carries the settings. */
async function configSnapshot() {
  try {
    const res = await chrome.storage.local.get([
      CONFIG.STORAGE_KEYS.DEVICE_PREFERENCE,
      CONFIG.STORAGE_KEYS.DTYPE_OVERRIDE,
      CONFIG.STORAGE_KEYS.GPU_UNUSABLE,
      CONFIG.STORAGE_KEYS.RESOLVED_DEVICE,
      CONFIG.STORAGE_KEYS.RESOLVED_DTYPE,
      CONFIG.STORAGE_KEYS.ENGINE,
      CONFIG.STORAGE_KEYS.CLOUD_PROVIDER,
      CONFIG.STORAGE_KEYS.CLOUD_KEY,
      CONFIG.STORAGE_KEYS.CLOUD_MODEL,
      CONFIG.STORAGE_KEYS.CLOUD_BASEURL,
      CONFIG.STORAGE_KEYS.GROQ_KEY,
    ]);
    return {
      devicePreference: res[CONFIG.STORAGE_KEYS.DEVICE_PREFERENCE] || null,
      dtypeOverride: res[CONFIG.STORAGE_KEYS.DTYPE_OVERRIDE] || null,
      skipWebgpu: res[CONFIG.STORAGE_KEYS.GPU_UNUSABLE] === true,
      resolvedDevice: res[CONFIG.STORAGE_KEYS.RESOLVED_DEVICE] || null,
      resolvedDtype: res[CONFIG.STORAGE_KEYS.RESOLVED_DTYPE] || null,
      engine: ["qwen", "groq"].includes(res[CONFIG.STORAGE_KEYS.ENGINE]) ? res[CONFIG.STORAGE_KEYS.ENGINE] : "mt",
      cloudProvider: res[CONFIG.STORAGE_KEYS.CLOUD_PROVIDER] || "google",
      cloudKey: res[CONFIG.STORAGE_KEYS.CLOUD_KEY] || res[CONFIG.STORAGE_KEYS.GROQ_KEY] || "",
      cloudModel: res[CONFIG.STORAGE_KEYS.CLOUD_MODEL] || "",
      cloudBaseUrl: res[CONFIG.STORAGE_KEYS.CLOUD_BASEURL] || "",
    };
  } catch {
    return { devicePreference: null, dtypeOverride: null };
  }
}

/** 调离屏文档；失败(连接不存在/超时)时自动重建离屏文档并重试一次 */
async function askOffscreenWithRetry(type, payload, timeoutMs) {
  try {
    return await askOffscreen(type, payload, timeoutMs);
  } catch (err) {
    const msg = err && err.message ? err.message : String(err);
    if (!/Receiving end|establish connection|无响应|超时|message channel closed|message port closed/i.test(msg)) throw err;
    pushError("offscreen:" + type, err);
    await recycleOffscreen("调用失败自动重试");
    await ensureOffscreen();
    return await askOffscreen(type, payload, timeoutMs);
  }
}

/* ---------------------------------------------------------------- tab fan-out */

const interestedTabs = new Set();

function rememberTab(sender) {
  const id = sender && sender.tab ? sender.tab.id : undefined;
  if (!Number.isFinite(id)) return undefined;
  interestedTabs.add(id);
  return id;
}

function sendToTab(tabId, message) {
  if (!Number.isFinite(tabId)) return;
  try {
    chrome.tabs.sendMessage(tabId, message, () => {
      if (chrome.runtime.lastError) interestedTabs.delete(tabId);
    });
  } catch {
    interestedTabs.delete(tabId);
  }
}

function broadcastModelStatus(payload) {
  for (const tabId of Array.from(interestedTabs)) sendToTab(tabId, { type: MSG.MODEL_PROGRESS, payload });
}

chrome.tabs.onRemoved.addListener((tabId) => interestedTabs.delete(tabId));

/* ---------------------------------------------------------------- handlers */

/** Caption payloads the YouTube player itself received (json3 or srv3/p XML). */
function parseCapturedCaptions(bodies) {
  const list = Array.isArray(bodies) ? bodies.slice().reverse() : [];
  for (const body of list) {
    const text = typeof body === "string" ? body.trim() : "";
    if (!text) continue;
    if (text[0] === "{") {
      const cues = parseJson3(text);
      if (cues.length) return { cues, source: "player-capture-json3" };
      continue;
    }
    if (text[0] === "<") {
      const cues = parseTimedtextXml(text);
      if (cues.length) return { cues, source: "player-capture-xml" };
    }
  }
  return { cues: [] };
}

async function handleGetSubtitles(payload, sender) {
  const tabId = sender && sender.tab ? sender.tab.id : undefined;
  const adapter = payload && payload.adapter;
  debug.counts.getSubtitles++;
  let result;
  if (adapter === "youtube") {
    // 1) caption payload the player itself fetched (works around YouTube's timedtext PoToken gate)
    if (Array.isArray(payload.captured) && payload.captured.length) {
      const captured = parseCapturedCaptions(payload.captured);
      if (captured.cues.length) {
        result = { cues: captured.cues, source: captured.source, track: null };
      } else {
        pushLog(debug.errors, { at: Date.now(), where: "parseCapturedCaptions", message: "解析播放器字幕数据得到 0 条" });
      }
    }
    // 2) our own timedtext fetch as a fallback
    if (!result) result = await resolveYouTube(tabId, payload);
  } else if (adapter === "bilibili") {
    result = await resolveBilibili(tabId, payload);
  } else if (adapter === "track") {
    result = await resolveTrackSrc(payload);
  } else {
    throw new Error(`未知适配器：${adapter}`);
  }

  const cues = Array.isArray(result.cues) ? result.cues : [];
  pushLog(debug.subtitleRequests, {
    at: Date.now(),
    adapter,
    tabId: Number.isFinite(tabId) ? tabId : null,
    ok: cues.length > 0,
    count: cues.length,
    reason: result.reason || "",
    target: payload.pageUrl || payload.src || "",
  });
  if (!cues.length) {
    debug.counts.subtitlesFail++;
    return { ok: false, error: result.reason || `${adapter} 未获取到字幕` };
  }
  debug.counts.subtitlesOk++;
  return {
    ok: true,
    data: { cues, track: result.track || null, source: result.source || result.transport || adapter, format: result.format || null, count: cues.length },
  };
}

async function handleTranslate(payload, sender) {
  const tabId = sender && sender.tab ? sender.tab.id : undefined;
  if (!Number.isFinite(tabId)) return { ok: false, error: "无法确定来源标签页" };
  await ensureOffscreen();
  debug.counts.translate++;
  const res = await askOffscreen(MSG.OFFSCREEN_TRANSLATE, { ...(payload || {}), tabId, config: await configSnapshot() });
  if (res && res.ok === false) return { ok: false, error: res.error || "翻译入队失败" };
  return res || { ok: true, data: { accepted: 0 } };
}

async function readStoredStatus() {
  try {
    const stored = await chrome.storage.local.get([CONFIG.STORAGE_KEYS.LAST_STATUS]);
    return stored[CONFIG.STORAGE_KEYS.LAST_STATUS] || null;
  } catch { return null; }
}

async function handleModelStatus() {
  debug.counts.modelStatus++;
  const config = await configSnapshot();
  if (await hasOffscreen()) {
    try {
      const res = await askOffscreen(MSG.OFFSCREEN_STATUS_REQ, { config });
      if (res && res.ok && res.data) {
        debug.model = res.data;
        return res;
      }
    } catch (err) {
      pushError("statusQuery", err);
    }
  }
  const stored = await readStoredStatus();
  const data = stored || { state: "idle", message: "本地模型尚未加载（首次翻译时会自动下载权重）", progress: null, device: null, dtype: null };
  debug.model = data;
  return { ok: true, data };
}

async function handlePreload() {
  debug.counts.preload++;
  await ensureOffscreen();
  const res = await askOffscreen(MSG.OFFSCREEN_PRELOAD, { config: await configSnapshot() }, 20000).catch((err) => {
    pushError("preload", err);
    return null;
  });
  if (res && res.ok === false) return { ok: false, error: res.error || "预加载失败" };
  return { ok: true, data: (res && res.data) || { started: true } };
}

async function handleSetDevicePreference(payload) {
  const key = CONFIG.STORAGE_KEYS.DEVICE_PREFERENCE;
  const dtypeKey = CONFIG.STORAGE_KEYS.DTYPE_OVERRIDE;
  const pref = payload && payload.preference;
  try {
    if (pref === "wasm" || pref === "webgpu") await chrome.storage.local.set({ [key]: pref });
    else await chrome.storage.local.remove(key);
    if (payload && payload.dtype !== undefined) {
      if (payload.dtype) await chrome.storage.local.set({ [dtypeKey]: payload.dtype });
      else await chrome.storage.local.remove(dtypeKey);
    }
  } catch (err) { pushError("setDevice", err); }
  const config = await configSnapshot();
  if (await hasOffscreen()) {
    await askOffscreen(MSG.OFFSCREEN_SET_DEVICE, { config }, 30000).catch((err) => pushError("setDeviceForward", err));
  }
  return { ok: true, data: { config } };
}

async function handleCache(action) {
  await ensureOffscreen();
  const type = action === "clear" ? MSG.OFFSCREEN_CLEAR_CACHE : MSG.OFFSCREEN_CACHE_STATS;
  const res = await askOffscreen(type, {}, 30000).catch((err) => { pushError("cache", err); return null; });
  if (res && res.ok === false) return { ok: false, error: res.error || "缓存操作失败" };
  return res || { ok: true, data: {} };
}

function handlePing() {
  return {
    ok: true,
    data: {
      version: debug.version,
      startedAt: debug.startedAt,
      counts: debug.counts,
      model: debug.model,
      offscreen: debug.offscreen,
      subtitleRequests: debug.subtitleRequests.slice(-6),
      errors: debug.errors.slice(-6),
      interestedTabs: Array.from(interestedTabs),
    },
  };
}

/* ---------------------------------------------------------------- message routing */

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  const type = msg && msg.type;
  if (!type) return undefined;

  // status pushes from the offscreen document: remember, fan out, never reply
  if (type === MSG.OFFSCREEN_STATUS) {
    debug.model = msg.payload || null;
    const push = msg.payload || {};
    if (push.gpuUnusable === true) {
      try { chrome.storage.local.set({ [CONFIG.STORAGE_KEYS.GPU_UNUSABLE]: true }); } catch { /* ignore */ }
    }
    // remember the combination that actually works: later sessions skip the probe and reuse
    // the cached weights instead of downloading them again
    if (push.state === "ready" && (push.device === "webgpu" || push.device === "wasm") && push.engine !== "groq" && push.dtype) {
      try {
        chrome.storage.local.set({
          [CONFIG.STORAGE_KEYS.RESOLVED_DEVICE]: push.device,
          [CONFIG.STORAGE_KEYS.RESOLVED_DTYPE]: push.dtype,
        });
      } catch { /* ignore */ }
    }
    try {
      chrome.storage.local.set({ [CONFIG.STORAGE_KEYS.LAST_STATUS]: { ...(msg.payload || {}), at: Date.now() } });
    } catch { /* ignore */ }
    broadcastModelStatus(msg.payload || {});
    return undefined;
  }

  // one translated line finished: deliver it to the requesting tab
  if (type === MSG.OFFSCREEN_RESULT) {
    const payload = msg.payload || {};
    const tabId = payload.tabId;
    const { tabId: _drop, ...rest } = payload;
    debug.counts.results++;
    if (rest.cached) debug.counts.resultsCached++;
    sendToTab(tabId, { type: MSG.TRANSLATION_RESULT, payload: rest });
    return undefined;
  }

  if (type.indexOf("st:offscreen-") === 0) return undefined; // other offscreen traffic is not ours
  if (type.indexOf("st:") !== 0) return undefined;
  rememberTab(sender);

  const run = async () => {
    switch (type) {
      case MSG.GET_SUBTITLES: return await handleGetSubtitles(msg.payload || {}, sender);
      case MSG.TRANSLATE: return await handleTranslate(msg.payload || {}, sender);
      case MSG.MODEL_STATUS: return await handleModelStatus();
      case MSG.PRELOAD_MODEL: return await handlePreload();
      case MSG.SET_DEVICE_PREFERENCE: return await handleSetDevicePreference(msg.payload || {});
      case MSG.CACHE_STATS: return await handleCache("stats");
      case MSG.CLEAR_CACHE: return await handleCache("clear");
      case MSG.OPEN_OFFSCREEN: await ensureOffscreen(); return { ok: true, data: { open: true } };
      case "st:note-new": {
        const hostForNew = await hostReady();
        if (hostForNew.ok) {
          const dirForNew = await noteDirAbs(hostForNew);
          if (dirForNew) {
            const nameForNew = docxFileName((msg.payload && msg.payload.fileName) || "");
            const fullForNew = joinWindowsPath(dirForNew, nameForNew);
            const exForNew = await hostCall("exists", { path: fullForNew }, 8000);
            if (!exForNew.exists) {
              const docxMod = globalThis.ST && globalThis.ST.docx;
              const baseName = String(nameForNew).replace(/[.]docx$/i, "");
              const seed = docxMod ? docxMod.buildFromText("") : new Uint8Array();
              await hostCall("write", { path: fullForNew, base64: bytesToBase64(seed) }, 12000);
            }
            await chrome.storage.local.set({ st_note_filename: nameForNew, st_note_dir_abs: dirForNew });
            return { ok: true, data: { file: nameForNew, folder: dirForNew, created: !exForNew.exists, direct: true } };
          }
        }
        await ensureOffscreen();
        const stored0 = await chrome.storage.local.get(["st_note_filename"]);
        const wantName = (msg.payload && msg.payload.fileName) || stored0["st_note_filename"] || "";
        const res0 = await askOffscreenWithRetry("st:offscreen-note-new", { fileName: wantName }, 20000);
        if (res0 && res0.ok === false) return { ok: false, error: res0.error || "新建笔记失败" };
        const file0 = (res0 && res0.data && res0.data.file) || wantName;
        if (file0) { try { await chrome.storage.local.set({ ["st_note_filename"]: file0 }); } catch { /* ignore */ } }
        return { ok: true, data: { file: file0, folder: (res0 && res0.data && res0.data.folder) || "" } };
      }
      case "st:open-action-popup": {
        try { if (chrome.action && chrome.action.openPopup) { await chrome.action.openPopup(); return { ok: true, data: { opened: true } }; } } catch (err) { pushError("openPopup", err); }
        return { ok: true, data: { opened: false } };
      }
      case "st:note-open": {
        const storedOpen = await chrome.storage.local.get(["st_note_filename"]);
        const wantFile = (msg.payload && msg.payload.fileName) || storedOpen.st_note_filename || "";
        const hostOpened = await hostOpenNote(wantFile).catch(() => null);
        if (hostOpened) return hostOpened;
        let got = null;
        // ① 页面端文件夹（用户在页面按 V 选的）
        try {
          const tabs = await chrome.tabs.query({ url: ["http://*/*", "https://*/*"] });
          for (const t of tabs) {
            if (!Number.isFinite(t.id)) continue;
            try {
              const r = await chrome.tabs.sendMessage(t.id, { type: "st:note-bytes", payload: { fileName: wantFile } });
              if (r && r.ok && r.base64) { got = r; break; }
            } catch { /* 该标签页没有内容脚本 */ }
          }
        } catch (err) { pushError("noteOpen:page", err); }
        // ② 扩展端文件夹（弹窗里设置的）
        if (!got) {
          const r2 = await askOffscreenWithRetry("st:offscreen-note-bytes", { fileName: wantFile }, 25000).catch(() => null);
          const data2 = r2 && (r2.data || r2);
          if (data2 && data2.base64) got = data2;
        }
        if (!got || !got.base64) return { ok: false, error: "读不到笔记文件：请先在视频页面按 V 选好保存位置" };
        // ③ 生成文件链接 → 下载（同名覆盖）→ 用系统默认程序（Word）打开
        const blobRes = await askOffscreenWithRetry("st:offscreen-blob-url", { base64: got.base64 }, 20000).catch(() => null);
        const blobUrl = blobRes && blobRes.data && blobRes.data.url;
        if (!blobUrl) return { ok: false, error: "生成文件链接失败" };
        const fileName2 = got.file || wantFile || "双语字幕笔记.docx";
        let downloadId = null;
        try {
          downloadId = await chrome.downloads.download({ url: blobUrl, filename: fileName2, conflictAction: "overwrite", saveAs: false });
        } catch (err) { pushError("downloads.download", err); }
        if (!Number.isFinite(downloadId)) return { ok: false, error: "下载失败（无法打开文件）" };
        await new Promise((resolve) => {
          const timer = setTimeout(resolve, 8000);
          const onChanged = (delta) => {
            if (delta.id !== downloadId) return;
            const state = delta.state && delta.state.current;
            if (state === "complete" || state === "interrupted") { clearTimeout(timer); chrome.downloads.onChanged.removeListener(onChanged); resolve(); }
          };
          chrome.downloads.onChanged.addListener(onChanged);
        });
        // 打开动作必须由"有用户手势"的弹窗页面来做（Chrome 要求）
        return { ok: true, data: { downloadId, file: fileName2, folder: got.folder || "" } };
      }
      case "st:note-list": {
        const hostForList = await hostReady();
        if (hostForList.ok) {
          const dirForList = await noteDirAbs(hostForList);
          if (dirForList) {
            const listed = await hostCall("list", { dir: dirForList }, 12000);
            if (listed.ok) return { ok: true, data: { ok: true, folder: dirForList, files: (listed.files || []).map((f) => f.name), direct: true } };
          }
        }
        await ensureOffscreen();
        const resList = await askOffscreenWithRetry("st:offscreen-note-list", {}, 15000);
        if (resList && resList.ok === false) return { ok: false, error: resList.error || "读取文件夹失败" };
        return resList || { ok: true, data: { ok: false, files: [] } };
      }
      case "st:note-read": {
        await ensureOffscreen();
        const stored1 = await chrome.storage.local.get(["st_note_filename"]);
        const wanted = (msg.payload && msg.payload.fileName) || stored1["st_note_filename"] || "";
        const res1 = await askOffscreenWithRetry("st:offscreen-note-view", { fileName: wanted }, 20000);
        if (res1 && res1.ok === false) return { ok: false, error: res1.error || "读取笔记失败" };
        if (res1 && res1.data) res1.data.requested = wanted;      // 便于排查读的是哪个文件
        return res1 || { ok: true, data: { ok: false, requested: wanted } };
      }
      case "st:note-append": {
        const hostAppended = await hostAppendLines((msg.payload && msg.payload.lines) || [], (msg.payload && msg.payload.fileName) || "").catch(() => null);
        if (hostAppended) return hostAppended;
        await ensureOffscreen();
        const storedName = (await chrome.storage.local.get(["st_note_filename"]))["st_note_filename"] || "";
        const res = await askOffscreenWithRetry("st:offscreen-note-append", { lines: (msg.payload && msg.payload.lines) || [], fileName: (msg.payload && msg.payload.fileName) || storedName }, 30000);
        if (res && res.ok === false) return { ok: false, error: res.error || "保存失败" };
        return res || { ok: true, data: { ok: false, reason: "no-folder" } };
      }
      case "st:asr-preload": {
        await ensureOffscreen();
        const rp = await askOffscreenWithRetry("st:offscreen-asr-preload", {}, 600000);
        return rp || { ok: false, error: "预热没有响应" };
      }
      case "st:asr": {
        await ensureOffscreen();
        const pcmArr = (msg.payload && msg.payload.pcm) || [];
        let r4 = await askOffscreenWithRetry("st:offscreen-asr", { pcm: pcmArr }, 300000).catch(() => null);
        if (!r4 || r4.ok === false) {
          // 离屏页可能在 ONNX 推理时被回收：重建一次再试
          pushError("asr:retry", new Error((r4 && r4.error) || "无响应"));
          try { await recycleOffscreen(); } catch { }
          try { r4 = await askOffscreenWithRetry("st:offscreen-asr", { pcm: pcmArr }, 300000); } catch { r4 = null; }
        }
        return r4 || { ok: false, error: "语音识别没有响应" };
      }
      case "st:asr-opfs-url": {
        try {
          const p2 = msg.payload || {};
          const saved = await fetchVideoToOpfs(p2.url, p2.name || ("audio-" + Date.now() + ".m4a"));
          await ensureOffscreen();
          try {
            const timeoutMs = Number(p2.maxSeconds) > 300 ? 1200000 : 300000;
            const r = await askOffscreenWithRetry("st:offscreen-asr-opfs", { name: saved.name, maxSeconds: p2.maxSeconds }, timeoutMs);
            return r || { ok: false, error: "OPFS 语音识别没有响应" };
          } finally { pruneVideoCache(3).catch(() => null); }
        } catch (err) {
          return { ok: false, error: err && err.message ? err.message : String(err) };
        }
      }
      case "st:audio-probe": {
        await ensureOffscreen();
        const p3 = msg.payload || {};
        const r3 = await askOffscreenWithRetry("st:offscreen-audio-decode", { base64: p3.base64, mime: p3.mime }, 60000);
        return r3 || { ok: false, error: "音频解码没有响应" };
      }
      case "st:ocr-video": {
        try {
          await ensureOffscreen();
          const p2 = msg.payload || {};
          const r = await askOffscreenWithRetry("st:offscreen-ocr-video", { url: p2.url, step: p2.step, maxFrames: p2.maxFrames }, 300000);
          return r || { ok: false, error: "画面识别没有响应" };
        } catch (err) {
          return { ok: false, error: err && err.message ? err.message : String(err) };
        }
      }
      case "st:translate-cancel": {
        try {
          await ensureOffscreen();
          const r = await askOffscreenWithRetry("st:offscreen-translate-cancel", { texts: (msg.payload && msg.payload.texts) || [] }, 15000);
          return r || { ok: false, error: "取消失败" };
        } catch (err) {
          return { ok: false, error: err && err.message ? err.message : String(err) };
        }
      }
      case "st:ocr-video-opfs": {
        try {
          const p2 = msg.payload || {};
          const saved = await fetchVideoToOpfs(p2.url, p2.name || ("v-" + Date.now() + ".mp4"));
          await ensureOffscreen();
          try {
            const r = await askOffscreenWithRetry("st:offscreen-ocr-opfs", { name: saved.name, step: p2.step, maxFrames: p2.maxFrames }, 900000);
            return r || { ok: false, error: "OPFS 画面识别没有响应" };
          } finally { pruneVideoCache(3).catch(() => null); }
        } catch (err) {
          return { ok: false, error: err && err.message ? err.message : String(err) };
        }
      }
      case "st:ocr-opfs-name": {
        try {
          await ensureOffscreen();
          const p2 = msg.payload || {};
          try {
            const r = await askOffscreenWithRetry("st:offscreen-ocr-opfs", { name: p2.name, step: p2.step, maxFrames: p2.maxFrames }, 300000);
            return r || { ok: false, error: "OPFS 画面识别没有响应" };
          } finally { pruneVideoCache(3).catch(() => null); }
        } catch (err) {
          return { ok: false, error: err && err.message ? err.message : String(err) };
        }
      }
      case "st:ocr-test": {
        await ensureOffscreen();
        const r = await askOffscreenWithRetry("st:offscreen-ocr", { dataUrl: (msg.payload && msg.payload.dataUrl) || "" }, 90000);
        return r || { ok: false, error: "OCR 没有响应" };
      }
      case "st:host-status": {
        const h = await hostReady(true);
        let dir = "";
        try { dir = ((await chrome.storage.local.get(["st_note_dir_abs"])).st_note_dir_abs) || h.defaultDir || ""; } catch { }
        return { ok: true, data: { available: h.ok, version: h.version, dir, defaultDir: h.defaultDir, error: h.error } };
      }
      case "st:host-pick-dir": {
        const h = await hostReady();
        if (!h.ok) return { ok: false, error: "本地助手未安装，请用桌面快捷方式启动浏览器" };
        let start = "";
        try { start = ((await chrome.storage.local.get(["st_note_dir_abs"])).st_note_dir_abs) || h.defaultDir || ""; } catch { }
        const pick = await hostKeepAlive(hostCall("pick-dir", { startDir: start }, 300000));
        if (!pick.ok) return { ok: false, error: pick.error || "选择文件夹失败" };
        if (!pick.picked || !pick.dir) return { ok: true, data: { picked: false } };
        const dir = String(pick.dir).replace(/[\\/]+$/, "");
        await chrome.storage.local.set({ st_note_dir_abs: dir });
        return { ok: true, data: { picked: true, dir } };
      }
      case "st:host-set-dir": {
        const dirIn = String((msg.payload && msg.payload.dir) || "").trim().replace(/[\\/]+$/, "");
        if (!dirIn) return { ok: false, error: "请填写文件夹路径" };
        if (!/^[a-zA-Z]:\\/.test(dirIn) && !/^\\\\/.test(dirIn)) return { ok: false, error: "路径要像 C:\\笔记 这样" };
        const h2 = await hostReady();
        if (!h2.ok) return { ok: false, error: "本地助手未安装" };
        await chrome.storage.local.set({ st_note_dir_abs: dirIn });
        return { ok: true, data: { dir: dirIn } };
      }
      case "st:host-reveal": {
        const h3 = await hostReady();
        if (!h3.ok) return { ok: false, error: "本地助手未安装" };
        let dir = String((msg.payload && msg.payload.dir) || "").trim() || (await noteDirAbs(h3));
        if (!dir) return { ok: false, error: "还没有设置保存位置" };
        let target = dir;
        const ex = await hostCall("exists", { path: dir }, 8000);
        if (!ex.exists) target = joinWindowsPath(dir, await noteName());
        const rev = await hostCall("reveal", { path: target }, 10000);
        if (!rev.ok) return { ok: false, error: rev.error || "打开文件夹失败" };
        return { ok: true, data: { path: target } };
      }
      case "st:host-forget": {
        await chrome.storage.local.set({ st_note_dir_abs: "" });
        return { ok: true, data: { ok: true } };
      }
      case "st:cloud-test": {
        await ensureOffscreen();
        const p = msg.payload || {};
        const res = await askOffscreenWithRetry("st:offscreen-cloud-test", {
          config: await configSnapshot(),
          apiKey: p.apiKey !== undefined ? p.apiKey : "",
          model: p.model || "",
          provider: p.provider || "",
          baseUrl: p.baseUrl || "",
        }, 45000);
        if (res && res.ok === false) return { ok: false, error: res.error || "云端测试失败" };
        return res || { ok: true, data: {} };
      }
      case MSG.PING: return handlePing();
      default: {
        // 通用兜底：把没见过的消息转给离屏文档处理，避免"SW 被浏览器缓存成旧版"导致新功能失效
        try {
          await ensureOffscreen();
          const fwd = await askOffscreen(type, msg.payload || {}, 30000);
          if (fwd && (fwd.ok !== undefined || fwd.error)) return fwd;
        } catch (err) { pushError("forward:" + type, err); }
        return { ok: false, error: `未知消息类型：${type}` };
      }
    }
  };

  run()
    .then((res) => { try { sendResponse(res); } catch { /* channel closed */ } })
    .catch((err) => {
      pushError(`handle(${type})`, err);
      try { sendResponse({ ok: false, error: err && err.message ? err.message : String(err) }); } catch { /* ignore */ }
    });
  return true;
});

/* ---------------------------------------------------------------- 自动修复失效的内容脚本 */

const CONTENT_FILES = [
  "src/shared/protocol.js",
  "src/shared/dom-utils.js",
  "src/shared/subtitle-cache.js",
  "src/adapters/adapter-api.js",
  "src/adapters/youtube.js",
  "src/adapters/bilibili.js",
  "src/adapters/generic-track.js",
  "src/core/router.js",
  "src/content/note-store.js",
  "src/content/overlay-css.js",
  "src/content/overlay.js",
  "src/content/main.js",
];

async function contentState(tabId) {
  try {
    const res = await chrome.tabs.sendMessage(tabId, { type: "st:ping" });
    return { alive: !!(res && res.ok), version: (res && res.version) || null };
  } catch {
    return { alive: false, version: null };
  }
}

/** 扩展刚更新/重载/重装后，已打开页面里的旧内容脚本已失效：这里自动补注入，用户无需刷新 */
async function reattachContentScripts(reason) {
  let tabs = [];
  try {
    tabs = await chrome.tabs.query({ url: ["http://*/*", "https://*/*"] });
  } catch (err) {
    pushError("queryTabs", err);
    return { checked: 0, fixed: 0 };
  }
  let fixed = 0;
  for (const tab of tabs.slice(0, 40)) {
    if (!Number.isFinite(tab.id)) continue;
    const state = await contentState(tab.id);
    // 活着且版本一致 → 跳过；否则（没有 / 版本过旧）重新注入
    if (state.alive && state.version === debug.version) continue;
    if (state.alive && state.version && state.version !== debug.version) {
      pushLog(debug.errors, { at: Date.now(), where: "reattach", message: `页面脚本版本过旧(${state.version}) → 重新注入` });
    }
    try {
      await chrome.scripting.executeScript({ target: { tabId: tab.id }, files: CONTENT_FILES });
      if (/youtube\.com|youtube-nocookie\.com/.test(tab.url || "")) {
        await chrome.scripting.executeScript({ target: { tabId: tab.id }, world: "MAIN", files: ["src/content/yt-main-hook.js"] }).catch(() => null);
      }
      fixed++;
      pushLog(debug.errors, { at: Date.now(), where: "reattach", message: `已补注入内容脚本：${(tab.url || "").slice(0, 60)}` });
    } catch (err) {
      pushError("reattach:" + String(tab.url || "").slice(0, 40), err);
    }
  }
  if (fixed) console.log(`[双语字幕] 自动修复内容脚本（${reason}）：${fixed} 个标签页`);
  return { checked: tabs.length, fixed };
}

/* ---------------------------------------------------------------- lifecycle */

chrome.runtime.onInstalled.addListener((details) => {
  console.log("[双语字幕] service worker 已安装/更新", details.reason, debug.version);
  // 更新后已打开页面里的脚本会失效：立刻自动补回，用户不用刷新
  recycleOffscreen("onInstalled:" + details.reason).catch(() => null);
  reattachContentScripts("onInstalled:" + details.reason).catch((err) => pushError("reattachInstall", err));
  chrome.storage.local
    .get([CONFIG.STORAGE_KEYS.SPACE_HOTKEY, CONFIG.STORAGE_KEYS.BUTTON_VISIBLE])
    .then((res) => {
      const patch = {};
      if (res[CONFIG.STORAGE_KEYS.SPACE_HOTKEY] === undefined) patch[CONFIG.STORAGE_KEYS.SPACE_HOTKEY] = true;
      if (res[CONFIG.STORAGE_KEYS.BUTTON_VISIBLE] === undefined) patch[CONFIG.STORAGE_KEYS.BUTTON_VISIBLE] = true;
      if (Object.keys(patch).length) chrome.storage.local.set(patch);
    })
    .catch(() => null);
});

// test/automation hooks (used by tools/playtest.mjs and tools/model-bench.mjs)
globalThis.__st_ping = () => handlePing();
globalThis.__st_model_status = () => handleModelStatus();
globalThis.__st_cache_stats = () => handleCache("stats");
globalThis.__st_clear_cache = () => handleCache("clear");
globalThis.__st_ensure_offscreen = () => ensureOffscreen();
globalThis.__st_reattach = (reason) => reattachContentScripts(reason || "manual");
globalThis.__st_reset_offscreen = async () => {
  try { await chrome.offscreen.closeDocument(); return { closed: true }; } catch (err) { return { closed: false, error: String(err && err.message ? err.message : err) }; }
};
globalThis.__st_config = () => configSnapshot();

// 启动时(限频)也检查一遍：覆盖"浏览器重启后某些标签页脚本没跟上"的情况
let lastReattachAt = 0;
async function maybeReattach(reason, minIntervalMs) {
  const now = Date.now();
  try {
    const stored = await chrome.storage.local.get(["st_last_reattach"]);
    lastReattachAt = Number(stored.st_last_reattach) || lastReattachAt;
  } catch { /* ignore */ }
  if (now - lastReattachAt < (minIntervalMs || 5 * 60 * 1000)) return { skipped: true };
  lastReattachAt = now;
  try { chrome.storage.local.set({ st_last_reattach: now }); } catch { /* ignore */ }
  return await reattachContentScripts(reason);
}
setTimeout(() => { maybeReattach("startup").catch(() => null); }, 1500);
// 不在每次 SW 启动时关闭离屏页：SW 会频繁被回收重启，关闭会中断正在加载的模型/ASR/OCR。扩展更新由 onInstalled 负责重建。
globalThis.__st_maybe_reattach = (reason) => maybeReattach(reason, 0);

console.log("[双语字幕] service worker 启动", debug.version);
globalThis.__st_boot = "ok";
