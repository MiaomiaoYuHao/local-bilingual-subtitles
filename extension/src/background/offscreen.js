// Offscreen document: owns the Transformers.js pipeline and the IndexedDB translation cache.
//
// It runs outside the page CSP, survives service-worker suspension and can use WebGPU, but
// Chrome only exposes chrome.runtime here - so results and status updates go back through the
// service worker, which is the only context that can talk to tabs and chrome.storage.
import "../shared/protocol.js";
import { ensureLoaded, translateLine, getStatus, setStatusListener, configure, resetPipeline, testCloud, isCloudEngine } from "./model-manager.js";
import { getMany, putCached, stats as cacheStats, clearAll, touchCached, setCacheModelTag } from "./translate-store.js";
import { appendLines, readNote, readNoteWithUrl, createNote, hasDir, listNotes, readBytes, NOTE_FILE_NAME } from "./note-file.js";
import { markCached, setQueueDepth } from "./model-manager.js";
import { recognizeImage, recognizeVideoUrl } from "./ocr-engine.js";
import { decodeAudioBase64, decodeAudioFile } from "./audio-decode.js";
import { transcribePcm, preloadAsr } from "./asr-engine.js";

const MSG = globalThis.ST.MSG;

const queue = [];
const queued = new Set();
let running = false;
let statsCache = { count: 0 };
let pendingReset = false;

/** 缓存标签跟随当前引擎，本地/云端结果分开存 */
function syncCacheTag() {
  const st = getStatus();
  if (st.engine === "groq") setCacheModelTag(`cloud:${(st.cloud && st.cloud.provider) || "cloud"}:${st.dtype || "model"}`);
  else setCacheModelTag(`local:${st.localEngine || "mt"}:${st.dtype || ""}:prompt2`);
}

function post(message) {
  try {
    return chrome.runtime.sendMessage(message, () => void chrome.runtime.lastError);
  } catch { return undefined; }
}

function pushStatus(extra) {
  const snap = { ...getStatus(), queue: queue.length, ...(extra || {}) };
  post({ type: MSG.OFFSCREEN_STATUS, payload: snap });
  return snap;
}

setStatusListener(() => { pushStatus(); });

/** Results are handed to the service worker; content scripts never talk to us directly. */
function postResult(payload) {
  post({ type: MSG.OFFSCREEN_RESULT, payload });
}

async function applyConfig(next) {
  const diff = configure(next);
  if (!diff.changed) return false;
  if (!diff.reload) return false;
  pendingReset = true;
  const loadedSomething = getStatus().state === "ready" || getStatus().state === "downloading" || getStatus().state === "warming";
  if (loadedSomething && !running && !queue.length) {
    pendingReset = false;
    await resetPipeline("设备/精度设置已更改");
  }
  return true;
}

async function drain() {
  if (running) return;
  running = true;
  globalThis.__stDrainStage = "start";
  try {
    await ensureLoaded();
    globalThis.__stDrainStage = "loaded";
    setQueueDepth(queue.length);
    pushStatus();
    while (queue.length) {
      const job = queue.shift();
      globalThis.__stDrainStage = "job:" + String(job.text || "").slice(0, 30);
      queued.delete(job.text);
      setQueueDepth(queue.length);
      const started = Date.now();
      try {
        syncCacheTag();
        const { zh, device, dtype } = await translateLine(job.text, { prevLines: job.prevLines });
        globalThis.__stDrainStage = "putCached";
        await putCached(job.text, zh, { ms: Date.now() - started, device, dtype, requestId: job.requestId || null }).catch(() => null);
        globalThis.__stDrainStage = "postResult";
        postResult({
          requestId: job.requestId,
          tabId: job.tabId,
          text: job.text,
          zh,
          cached: false,
          ms: Date.now() - started,
          device,
          dtype,
          source: "model",
        });
      } catch (err) {
        postResult({
          requestId: job.requestId,
          tabId: job.tabId,
          text: job.text,
          error: err && err.message ? err.message : String(err),
        });
      }
      pushStatus({ lastJobMs: Date.now() - started });
    }
  } catch (err) {
    const message = err && err.message ? err.message : String(err);
    while (queue.length) {
      const job = queue.shift();
      globalThis.__stDrainStage = "job:" + String(job.text || "").slice(0, 30);
      queued.delete(job.text);
      postResult({ text: job.text, tabId: job.tabId, requestId: job.requestId, error: message });
    }
    setQueueDepth(0);
    pushStatus();
  } finally {
    globalThis.__stDrainStage = "idle";
    running = false;
    if (pendingReset) {
      pendingReset = false;
      await resetPipeline("设备/精度设置已更改").catch(() => null);
    }
  }
}

async function onTranslate(payload) {
  const items = (payload && payload.items) || [];
  const tabId = payload && payload.tabId;
  const requestId = payload && payload.requestId;
  const texts = items.map((i) => String(i.text || "")).filter(Boolean);
  if (!texts.length) return { accepted: 0, queue: queue.length, status: getStatus() };

  let hits = 0;
  let cached = new Map();
  syncCacheTag();
  try {
    cached = await getMany(texts);
  } catch { cached = new Map(); }

  for (const [text, zh] of cached) {
    hits++;
    postResult({ requestId, tabId, text, zh, cached: true, source: "indexeddb" });
    touchCached(text);
  }
  for (const item of items) {
    const text = String(item.text || "");
    if (!text || cached.has(text) || queued.has(text)) continue;
    queued.add(text);
    const job = {
      text,
      prevLines: Array.isArray(item.prevLines) ? item.prevLines.slice(-2) : [],
      tabId,
      requestId,
      enqueuedAt: Date.now(),
    };
    if (item.priority) queue.unshift(job); else queue.push(job);
  }
  if (hits) markCached(hits);
  setQueueDepth(queue.length);
  pushStatus({ cacheHits: hits });
  drain();
  return { accepted: texts.length, cachedHits: hits, queue: queue.length, status: getStatus() };
}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  const type = msg && msg.type;
  const DIRECT = new Set();   // 笔记类消息一律由 service worker 转发（它能读到当前文件名）
  if (!type || (type.indexOf("st:offscreen-") !== 0 && !DIRECT.has(type))) return undefined; // not addressed to us
  const payload = msg.payload || {};

  if (type === MSG.OFFSCREEN_TRANSLATE) {
    (async () => {
      await applyConfig(payload.config);
      const data = await onTranslate(payload);
      sendResponse({ ok: true, data });
    })().catch((err) => sendResponse({ ok: false, error: err && err.message ? err.message : String(err) }));
    return true;
  }

  if (type === MSG.OFFSCREEN_PRELOAD) {
    (async () => {
      await applyConfig(payload.config);
      sendResponse({ ok: true, data: { started: true, status: getStatus() } });
      ensureLoaded().then(() => pushStatus()).catch(() => pushStatus());
    })().catch((err) => sendResponse({ ok: false, error: err && err.message ? err.message : String(err) }));
    return true;
  }

  if (type === MSG.OFFSCREEN_STATUS_REQ) {
    (async () => {
      await applyConfig(payload.config);
      try { statsCache = await cacheStats(); } catch { /* stats are cosmetic */ }
      sendResponse({ ok: true, data: { ...getStatus(), cache: statsCache, queue: queue.length, running } });
    })().catch((err) => sendResponse({ ok: false, error: err && err.message ? err.message : String(err) }));
    return true;
  }

  if (type === MSG.OFFSCREEN_SET_DEVICE) {
    (async () => {
      await applyConfig(payload.config);
      sendResponse({ ok: true, data: { config: getStatus(), note: "新设置已应用" } });
    })().catch((err) => sendResponse({ ok: false, error: err && err.message ? err.message : String(err) }));
    return true;
  }

  if (type === MSG.OFFSCREEN_NOTE_APPEND || type === "st:note-append") {
    (async () => {
      try {
        const res = await appendLines(payload.lines || [], payload.fileName || NOTE_FILE_NAME);
        sendResponse({ ok: true, data: res });
      } catch (err) {
        sendResponse({ ok: false, error: err && err.message ? err.message : String(err) });
      }
    })();
    return true;
  }

  if (type === "st:offscreen-note-new" || type === "st:note-new") {
    (async () => {
      try {
        const res = await createNote(payload.fileName || NOTE_FILE_NAME);
        sendResponse({ ok: true, data: res });
      } catch (err) { sendResponse({ ok: false, error: err && err.message ? err.message : String(err) }); }
    })();
    return true;
  }

  if (type === "st:offscreen-note-list" || type === "st:note-list") {
    (async () => {
      try {
        const res = await listNotes();
        sendResponse({ ok: true, data: res });
      } catch (err) { sendResponse({ ok: false, error: err && err.message ? err.message : String(err) }); }
    })();
    return true;
  }

  if (type === "st:offscreen-note-bytes") {
    (async () => {
      try {
        const res = await readBytes(payload.fileName || NOTE_FILE_NAME);
        sendResponse({ ok: true, data: res });
      } catch (err) { sendResponse({ ok: false, error: err && err.message ? err.message : String(err) }); }
    })();
    return true;
  }

  if (type === "st:offscreen-blob-url") {
    try {
      const bin = atob(payload.base64 || "");
      const bytes = new Uint8Array(bin.length);
      for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
      const blob = new Blob([bytes], { type: "application/vnd.openxmlformats-officedocument.wordprocessingml.document" });
      sendResponse({ ok: true, data: { url: URL.createObjectURL(blob) } });
    } catch (err) {
      sendResponse({ ok: false, error: String(err && err.message ? err.message : err) });
    }
    return false;
  }

  if (type === "st:offscreen-note-view" || type === "st:note-read") {
    (async () => {
      try {
        const res = await readNoteWithUrl(payload.fileName || NOTE_FILE_NAME);
        sendResponse({ ok: true, data: res });
      } catch (err) { sendResponse({ ok: false, error: err && err.message ? err.message : String(err) }); }
    })();
    return true;
  }

  if (type === MSG.OFFSCREEN_NOTE_READ) {
    (async () => {
      try {
        const text = await readNote(payload.fileName);
        sendResponse({ ok: true, data: { text, hasDir: await hasDir() } });
      } catch (err) {
        sendResponse({ ok: false, error: err && err.message ? err.message : String(err) });
      }
    })();
    return true;
  }
  if (type === "st:offscreen-ocr") {
    (async () => {
      try {
        const data = await recognizeImage(payload.dataUrl || "");
        sendResponse({ ok: true, data });
      } catch (err) {
        sendResponse({ ok: false, error: err && err.message ? err.message : String(err) });
      }
    })();
    return true;
  }

  if (type === "st:offscreen-asr-preload") {
    (async () => {
      try { sendResponse({ ok: true, data: await preloadAsr() }); }
      catch (err) { sendResponse({ ok: false, error: err && err.message ? err.message : String(err) }); }
    })();
    return true;
  }

  if (type === "st:offscreen-asr") {
    (async () => {
      try {
        const pcm = payload.pcm instanceof Float32Array ? payload.pcm : new Float32Array(payload.pcm || []);
        const r = await transcribePcm(pcm);
        sendResponse({ ok: true, data: r });
      } catch (err) { sendResponse({ ok: false, error: err && err.message ? err.message : String(err) }); }
    })();
    return true;
  }

  if (type === "st:offscreen-asr-opfs") {
    (async () => {
      try {
        const root = await navigator.storage.getDirectory();
        const dir = await root.getDirectoryHandle("st-video-cache", { create: true });
        const fh = await dir.getFileHandle(payload.name);
        const file = await fh.getFile();
        const decoded = await decodeAudioFile(file, payload.maxSeconds);
        const r = await transcribePcm(decoded.pcm, { timestamps: true });
        sendResponse({ ok: true, data: { text: r.text, segments: r.segments || [], duration: decoded.duration } });
      } catch (err) {
        sendResponse({ ok: false, error: err && err.message ? err.message : String(err) });
      }
    })();
    return true;
  }

  if (type === "st:offscreen-audio-decode") {
    (async () => {
      try {
        const r = await decodeAudioBase64(payload.base64 || "", payload.mime || "audio/webm");
        sendResponse({ ok: true, data: { samples: r.samples, duration: r.duration, pcm: Array.from(r.pcm) } });
      } catch (err) { sendResponse({ ok: false, error: err && err.message ? err.message : String(err) }); }
    })();
    return true;
  }

  if (type === "st:offscreen-ocr-opfs") {
    (async () => {
      let objUrl = "";
      try {
        const root = await navigator.storage.getDirectory();
        const dir = await root.getDirectoryHandle("st-video-cache", { create: true });
        const fh = await dir.getFileHandle(payload.name);
        const file = await fh.getFile();
        objUrl = URL.createObjectURL(file);
        const data = await recognizeVideoUrl(objUrl, { step: payload.step, maxFrames: payload.maxFrames });
        sendResponse({ ok: true, data });
      } catch (err) {
        sendResponse({ ok: false, error: err && err.message ? err.message : String(err) });
      } finally {
        if (objUrl) { try { URL.revokeObjectURL(objUrl); } catch { /* ignore */ } }
      }
    })();
    return true;
  }

  if (type === "st:offscreen-ocr-video") {
    (async () => {
      try {
        const data = await recognizeVideoUrl(payload.url || "", { step: payload.step, maxFrames: payload.maxFrames });
        sendResponse({ ok: true, data });
      } catch (err) {
        sendResponse({ ok: false, error: err && err.message ? err.message : String(err) });
      }
    })();
    return true;
  }

  if (type === MSG.OFFSCREEN_CLOUD_TEST) {
    (async () => {
      await applyConfig(payload.config);
      const data = await testCloud({ apiKey: payload.apiKey, model: payload.model, provider: payload.provider, baseUrl: payload.baseUrl });
      sendResponse({ ok: true, data });
    })().catch((err) => sendResponse({ ok: false, error: err && err.message ? err.message : String(err) }));
    return true;
  }

  if (type === MSG.OFFSCREEN_CACHE_STATS) {
    (async () => {
      statsCache = await cacheStats();
      sendResponse({ ok: true, data: statsCache });
    })().catch((err) => sendResponse({ ok: false, error: err && err.message ? err.message : String(err) }));
    return true;
  }

  if (type === MSG.OFFSCREEN_CLEAR_CACHE) {
    (async () => {
      await clearAll();
      statsCache = await cacheStats();
      sendResponse({ ok: true, data: statsCache });
    })().catch((err) => sendResponse({ ok: false, error: err && err.message ? err.message : String(err) }));
    return true;
  }

  if (type === "st:offscreen-translate-cancel") {
    const texts = new Set(((payload && payload.texts) || []).map((x) => String(x || "")).filter(Boolean));
    let removed = 0;
    for (let i = queue.length - 1; i >= 0; i--) {
      if (!texts.has(queue[i].text)) continue;
      queued.delete(queue[i].text);
      queue.splice(i, 1);
      removed++;
    }
    setQueueDepth(queue.length);
    pushStatus();
    sendResponse({ ok: true, data: { removed, queue: queue.length } });
    return false;
  }

  if (type === MSG.OFFSCREEN_VERBOSE) {
    sendResponse({ ok: true, data: { status: getStatus(), queue: queue.length } });
    return false;
  }

  return undefined;
});

for (const evt of ["error", "unhandledrejection"]) {
  globalThis.addEventListener(evt, (e) => {
    const message = e && (e.reason || e.message)
      ? String((e.reason && e.reason.message) || e.reason || e.message)
      : "unknown";
    pushStatus({ lastError: message, lastErrorAt: Date.now() });
    try { console.error("[双语字幕/offscreen]", message); } catch { /* ignore */ }
  });
}

pushStatus({ queue: 0, bootedAt: Date.now() });

globalThis.__stOffscreenDebug = () => ({ running, queue: queue.length, queued: queued.size, stage: globalThis.__stDrainStage || "" });
