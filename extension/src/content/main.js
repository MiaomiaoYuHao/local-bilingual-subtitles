// Content-script entry point: video discovery, router lifecycle, the 200ms subtitle window,
// the space hotkey, and translation scheduling. Subtitle lines are drawn over the video by
// overlay.js; this file only supplies data and state.
(() => {
  const ST = (globalThis.ST = globalThis.ST || {});
  const util = ST.util;
  const MSG = ST.MSG;
  const CONFIG = ST.CONFIG;
  const DISPLAY_LINES = CONFIG.DISPLAY_LINES || 3;

  if (typeof window !== "undefined" && window.top !== window) return; // top frame only
  if (globalThis.__ST_BOOTED__) return;
  globalThis.__ST_BOOTED__ = true;

  const state = {
    video: null,
    router: null,
    cache: new ST.SubtitleCache(CONFIG.WINDOW_SIZE),
    translations: new Map(), // text -> {status:'pending'|'done'|'error', zh, error}
    inflight: new Set(),
    model: { state: "unknown", device: null, progress: null, message: "", dtype: null },
    resolve: { state: "idle", message: "", adapterLabel: "", attempts: 0, errors: [] },
    settings: { hotkey: "z", saveKey: "s", fabVisible: true },
    cloudNoticeText: "",
    cloudNoticeAt: 0,
    cloudNoticeHidden: false,
    cloudNoticeTimer: null,
    host: { ok: false, dir: "" },
    ocr: { timer: null, busy: false, lastAt: -99, lastText: "", observations: [], lastKey: null, captionStart: -1, seq: 0, hits: 0, attempts: 0, disabled: false, startedAt: 0, probeTimer: null, lastHitText: "", mismatches: 0, videoTried: false, videoBusy: false, videoActive: false, goodMatches: 0, blobTried: false },
    audio: { on: false, busy: false, lastText: "", lastAt: -99, remoteTried: false, bufferTried: false, restarts: 0, startedAt: 0 },
    resolving: false,
    retryTimer: null,
    resolveWatchdog: null,
    liveKind: null,
    liveTimer: null,
    lastLiveText: null,
    liveFallbackTimer: null,
    lastHref: location.href,
    resolveToken: 0,
    preloaded: false,
    prefetching: false,
    lastPrefetchAt: 0,
    prefetchToken: 0,
    prefetchAll: { running: false, done: 0, total: 0 },
    autoBufferTimer: null,
    autoBufferAt: 0,
    autoBufferKey: "",
    softSubtitles: false,
  };

  const overlay = new ST.Overlay();
  ST.overlay = overlay;

  /* ------------------------------------------------------------------ messaging */

  function requestSWOnce(type, payload, timeoutMs) {
    return new Promise((resolve, reject) => {
      let settled = false;
      const timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        reject(new Error("后台脚本无响应（超时）"));
      }, Number.isFinite(timeoutMs) ? timeoutMs : 25000);
      try {
        chrome.runtime.sendMessage({ type, payload }, (res) => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          const lastError = chrome.runtime.lastError;
          if (lastError) { reject(new Error(lastError.message)); return; }
          if (!res) { reject(new Error("后台脚本未返回数据")); return; }
          if (res.ok === false) { reject(new Error(res.error || "后台脚本报错")); return; }
          resolve(res.data);
        });
      } catch (err) {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        reject(err);
      }
    });
  }

  async function requestSW(type, payload, timeoutMs) {
    let last = null;
    for (let i = 0; i < 3; i++) {
      try { return await requestSWOnce(type, payload, timeoutMs); }
      catch (err) {
        last = err;
        const msg = String(err && err.message ? err.message : err);
        if (!/Receiving end|establish connection|message port closed/i.test(msg)) throw err;
        await new Promise((r) => setTimeout(r, 300 * (i + 1)));
      }
    }
    throw last;
  }

  chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    if (!msg || typeof msg.type !== "string") return undefined;
    if (msg.type === "st:ping") {
      let version = "0";
      try { version = chrome.runtime.getManifest().version; } catch { /* ignore */ }
      sendResponse({ ok: true, alive: true, version, at: Date.now(), href: location.href });
      return true;
    }
    if (msg.type === "st:bili-dom") {
      sendResponse({ ok: true, text: typeof ST.readBilibiliDomCaption === "function" ? ST.readBilibiliDomCaption() : null });
      return true;
    }
    if (msg.type === "st:prefetch-ocr") {
      (async () => {
        let url = "";
        if (typeof ST.getDouyinVideoUrl === "function") { try { url = ST.getDouyinVideoUrl(); } catch { /* ignore */ } }
        if (!url && state.video) url = String(state.video.currentSrc || "");
        if (!/^https?:/i.test(url)) { sendResponse({ ok: false, error: "当前页面没有可提取的视频直链" }); return; }
        const dur = Number(state.video && state.video.duration) || 0;
        const maxFrames = Math.min(300, Math.max(3, Math.ceil(dur / 2) || 20));
        state.ocr.videoBusy = true;
        enterFallback();
        syncSourceLabel();
        composeStatus();
        try {
          const r = await requestSW("st:ocr-video-opfs", { url, step: 2, maxFrames }, 900000);
          const cues = (r && r.cues) || [];
          if (!cues.length) { sendResponse({ ok: false, error: "画面里没有识别到英文字幕" }); return; }
          stopOcrSampler(true);
          stopAsr();
          state.ocr.videoActive = true;
          state.ocr.disabled = false;
          state.cache.load(cues.map((c) => ({ ...c, source: "ocr-video" })), { source: "ocr-video" });
          state.cache.update(currentTime());
          state.resolve.state = "ok";
          state.resolve.message = "预处理画面 OCR";
          state.resolve.adapterLabel = "后台视频 OCR";
          state.resolve.attempts = 5;
          if (state.retryTimer) { clearTimeout(state.retryTimer); state.retryTimer = null; }
          syncSourceLabel();
          overlay.setErrors([]);
          render();
          prefetchSubtitles({ force: true, all: true }).catch(() => null);
          sendResponse({ ok: true, data: { cues: cues.length } });
        } catch (err) {
          sendResponse({ ok: false, error: err && err.message ? err.message : String(err) });
        } finally {
          state.ocr.videoBusy = false;
          composeStatus();
        }
      })();
      return true;
    }
    if (msg.type === "st:prefetch-audio") {
      (async () => {
        const url = typeof ST.getDouyinAudioUrl === "function" ? ST.getDouyinAudioUrl() : "";
        const dur = Number(state.video && state.video.duration) || 0;
        if (!url) { sendResponse({ ok: false, error: "当前页面没有可提取的音频直链" }); return; }
        if (dur > 1800) { sendResponse({ ok: false, error: "音频超过 30 分钟，暂不整段预处理" }); return; }
        state.audio.remoteTried = true;
        state.audio.bufferTried = true;
        state.audio.on = true;
        state.audio.busy = true;
        enterFallback();
        syncSourceLabel();
        composeStatus();
        try {
          const maxSeconds = Math.min(1800, Math.max(30, Math.ceil(dur || 300)));
          const r = await requestSW("st:asr-opfs-url", { url, maxSeconds }, maxSeconds > 300 ? 1200000 : 300000);
          const text = String((r && r.text) || "").trim();
          const segs = (r && r.segments) || [];
          if (!text && !segs.length) { sendResponse({ ok: false, error: "没有识别到语音" }); return; }
          const applied = segs.length ? applyAsrSegments(segs, text, currentTime()) : applyAsrText(text, currentTime());
          sendResponse({ ok: true, data: { text, duration: r.duration || 0, segments: segs.length, applied } });
        } catch (err) {
          sendResponse({ ok: false, error: err && err.message ? err.message : String(err) });
        } finally {
          state.audio.on = false;
          state.audio.busy = false;
          syncSourceLabel();
          composeStatus();
        }
      })();
      return true;
    }
    if (msg.type === "st:prefetch-all") {
      prefetchSubtitles({ force: true, all: true }).then((r) => sendResponse({ ok: true, data: r })).catch((err) => sendResponse({ ok: false, error: String(err && err.message ? err.message : err) }));
      return true;
    }
    if (msg.type === "st:blob-opfs-test") {
      startBlobOpfsOcr().then((r) => sendResponse({ ok: true, data: r })).catch((err) => sendResponse({ ok: false, error: String(err && err.message ? err.message : err) }));
      return true;
    }
    if (msg.type === "st:audio-stats") {
      const d = ST.audioCapture && ST.audioCapture.debug ? ST.audioCapture.debug() : null;
      sendResponse({ ok: true, data: d ? { ...d, source: state.audio.source || "", restarts: state.audio.restarts || 0 } : null });
      return true;
    }
    if (msg.type === "st:page-state") {
      const st = overlay.state || {};
      let version = "0";
      try { version = chrome.runtime.getManifest().version; } catch { /* ignore */ }
      sendResponse({ ok: true, data: {
        adapter: String(st.adapter || ""),
        model: String(st.model || ""),
        statusText: String(st.statusText || ""),
        rows: Number(st.rows) || 0,
        zhCount: Number(st.zhCount) || 0,
        currentEn: String(st.currentEn || ""),
        currentZh: String(st.currentZh || ""),
        sources: [...new Set((st.displayed || []).map((x) => x && x.source).filter(Boolean))],
        videoUrl: (() => {
          let u = "";
          if (typeof ST.getDouyinVideoUrl === "function") { try { u = ST.getDouyinVideoUrl(); } catch { /* ignore */ } }
          if (!u && state.video) u = String(state.video.currentSrc || "");
          return /^https?:/i.test(u) ? u : "";
        })(),
        audioUrl: typeof ST.getDouyinAudioUrl === "function" ? (() => { try { return ST.getDouyinAudioUrl(); } catch { return ""; } })() : "",
        resolve: { state: state.resolve.state, message: state.resolve.message, adapterLabel: state.resolve.adapterLabel, errors: state.resolve.errors || [] },
        prefetch: state.prefetchAll,
        prefetchToken: state.prefetchToken,
        href: location.href,
        version,
      }});
      return true;
    }
    if (msg.type === "st:note-bytes") {
      const fileName = (msg.payload && msg.payload.fileName) || "";
      ST.noteStore.readBytes(fileName)
        .then((r) => sendResponse(r))
        .catch((err) => sendResponse({ ok: false, error: String(err && err.message ? err.message : err) }));
      return true;
    }
    if (msg.type === MSG.TRANSLATION_RESULT) { onTranslationResult(msg.payload || {}); return undefined; }
    if (msg.type === MSG.MODEL_PROGRESS) { onModelStatus(msg.payload || {}); return undefined; }
    return undefined;
  });

  /* ------------------------------------------------------------------ video lifecycle */

  function findVideo() {
    const all = Array.from(document.querySelectorAll("video"));
    if (!all.length) return null;
    const score = (v) => {
      const area = (v.clientWidth || 0) * (v.clientHeight || 0);
      const playing = v.paused ? 0 : 1;
      return area + playing * 100000 + Math.min(v.duration || 0, 60) * 1000;
    };
    return all.sort((a, b) => score(b) - score(a))[0];
  }

  function attachVideo(video) {
    // 换了视频：作废上一条视频还在解析中的结果，别让它写进新窗口
    state.resolveToken++;
    state.resolving = false;
    state.softSubtitles = false;
    state.lastLiveText = null;
    state.video = video;
    state.preloaded = false;
    stopOcrSampler();
    stopAsr();
    state.merger = ST.SentenceMerger ? new ST.SentenceMerger({ maxChars: 70, gapMs: 1200 }) : null;
    state.cache.clear();
    state.translations.clear();
    state.inflight.clear();
    state.resolve = { state: "idle", message: "", adapterLabel: "", attempts: 0, errors: [] };
    state.prefetchToken++;
    state.prefetchAll = { running: false, done: 0, total: 0 };
    overlay.setAdapter("");
    overlay.setErrors([]);
    overlay.attachVideo(video);

    state.router = new ST.Router(
      { video, location, document, window, requestSW, log: util.log },
      {
        onAdapterError(adapter, err) {
          state.resolve.errors.push({ adapter: adapter.id, message: err && err.message ? err.message : String(err) });
          overlay.setErrors(state.resolve.errors);
        },
      }
    );
    render();
    for (const evt of ["loadedmetadata", "loadeddata", "durationchange", "play"]) {
      video.addEventListener(evt, onVideoMetaChange, { passive: true });
    }
    resolveSubtitles("attach");
    preloadModel();
    const attached = video;
    setTimeout(() => {
      if (state.video !== attached || state.softSubtitles) return;
      util.guard("并行画面识别", maybeStartOcr);
      util.guard("并行语音识别", maybeStartAsr);
    }, 800);
  }

  function detachVideo() {
    stopOcrSampler();
    stopAsr();
    state.resolveToken++;
    state.resolving = false;
    state.softSubtitles = false;
    if (state.retryTimer) { clearTimeout(state.retryTimer); state.retryTimer = null; }
    if (state.resolveWatchdog) { clearTimeout(state.resolveWatchdog); state.resolveWatchdog = null; }
    if (state.autoBufferTimer) { clearTimeout(state.autoBufferTimer); state.autoBufferTimer = null; }
    state.autoBufferAt = 0;
    state.autoBufferKey = "";
    state.video = null;
    state.router = null;
    state.cache.clear();
    state.translations.clear();
    state.inflight.clear();
    state.resolve = { state: "idle", message: "", adapterLabel: "", attempts: 0, errors: [] };
    stopLiveSampler();
    overlay.hide();
    overlay.setFabVisible(false);
    overlay.attachVideo(null);
    render();
  }

  const onVideoMetaChange = util.debounce(() => {
    if (!state.video) return;
    if (state.resolve.state === "ok" && state.cache.cues.length) return;
    resolveSubtitles("meta");
  }, 900);

  /* ------------------------------------------------------------------ resolution */

  async function resolveSubtitles(trigger) {
    if (!state.video || !state.router) return;
    if (state.retryTimer) { clearTimeout(state.retryTimer); state.retryTimer = null; }
    const token = ++state.resolveToken;
    state.resolving = true;
    state.resolve.state = "loading";
    state.resolve.message = "正在获取字幕…";
    composeStatus();
    if (state.resolveWatchdog) clearTimeout(state.resolveWatchdog);
    state.resolveWatchdog = setTimeout(() => {
      state.resolveWatchdog = null;
      if (token !== state.resolveToken || state.resolve.state !== "loading") return;
      util.log("字幕解析超过 8 秒，先启动 OCR/ASR 兜底，软字幕结果稍后仍可采用");
      util.guard("画面字幕识别", maybeStartOcr);
      util.guard("语音识别", maybeStartAsr);
    }, 8000);
    try {
      const result = await state.router.resolveOnce();
      if (token !== state.resolveToken) { util.log("忽略过期的字幕结果（视频已切换）"); return; }
      const merged = ST.mergeCuesIntoSentences ? ST.mergeCuesIntoSentences(result.cues) : result.cues;
      if (merged.length !== result.cues.length) util.log(`字幕合并：${result.cues.length} 条 → ${merged.length} 句`);
      state.cache.load(merged, result.meta);
      state.softSubtitles = merged.length > 0;
      if (merged.length && result.cues.length) {
        stopOcrSampler();
        stopAsr();
        state.ocr.videoActive = false;
        util.log("软字幕优先，关闭 OCR/ASR 兜底");
      }
      state.translations.clear();
      state.inflight.clear();
      const meta = result.meta || {};
      const trackInfo = meta.track
        ? ` · ${meta.track.languageCode || meta.track.lan || meta.track.language || ""}${meta.track.name && meta.track.name.simpleText ? " " + meta.track.name.simpleText : ""}`
        : "";
      state.resolve = {
        state: "ok",
        message: `已加载 ${state.cache.cues.length} 条字幕 · ${result.adapter.label}（${meta.source || "unknown"}${trackInfo}）`,
        adapterLabel: result.adapter.label,
        attempts: state.resolve.attempts + 1,
        errors: result.errors || [],
      };
      overlay.setAdapter(result.adapter.label);
      overlay.setErrors(state.resolve.errors);
      overlay.setFabVisible(state.settings.fabVisible);
      if (result.live) {
        startLiveSampler(result.live);
        if (state.liveFallbackTimer) clearTimeout(state.liveFallbackTimer);
        // 只对 YouTube 做“CC 未开”兜底；B 站/抖音的失败路径在 catch 里处理，避免抢在软字幕前面。
        if (ST.platformOf && ST.platformOf(location) === "youtube") {
          state.liveFallbackTimer = setTimeout(() => {
            state.liveFallbackTimer = null;
            if (!state.liveKind || state.cache.cues.length) return;
            util.log("YouTube 实时字幕 6 秒无内容，启动 OCR/ASR 兜底");
            util.guard("画面字幕识别", maybeStartOcr);
            util.guard("语音识别", maybeStartAsr);
          }, 6000);
        }
      } else stopLiveSampler();
      state.cache.update(currentTime());
      render();
      composeStatus();
      if (state.cache.cues.length) scheduleAutoBuffer({ all: !result.live, force: true });
      if (!state.preloaded) { state.preloaded = true; preloadModel(); }
      util.log(`字幕就绪：${result.cues.length} 条（适配器 ${result.adapter.id}，触发=${trigger}）`);
    } catch (err) {
      if (token !== state.resolveToken) return;
      state.resolve.state = "error";
      state.resolve.message = err && err.message ? err.message : String(err);
      state.resolve.errors = (err && err.details && err.details.errors) || state.resolve.errors;
      overlay.setErrors(state.resolve.errors);
      overlay.setFabVisible(state.settings.fabVisible);
      render();
      composeStatus();
      util.warn("获取字幕失败：", state.resolve.message);
      scheduleRetry();
      util.guard("画面字幕识别", maybeStartOcr);
      util.guard("语音识别", maybeStartAsr);
    } finally {
      if (token === state.resolveToken) {
        state.resolving = false;
        if (state.resolveWatchdog) { clearTimeout(state.resolveWatchdog); state.resolveWatchdog = null; }
      }
    }
  }

  function scheduleRetry() {
    if (state.resolve.attempts >= 5) return;
    const delay = [2500, 5000, 9000, 15000, 25000][Math.min(state.resolve.attempts, 4)];
    state.resolve.attempts++;
    if (state.retryTimer) clearTimeout(state.retryTimer);
    state.retryTimer = setTimeout(() => {
      state.retryTimer = null;
      if (state.video && !state.resolving) resolveSubtitles("retry");
    }, delay);
  }

  function preloadModel() {
    util.guard("预加载本地模型", () => requestSW(MSG.PRELOAD_MODEL, {}, 120000));
  }

  /* ------------------------------------------------------------------ live window */

  function currentTime() {
    const v = state.video;
    if (!v) return 0;
    const t = Number(v.currentTime);
    return Number.isFinite(t) ? t : 0;
  }

  let invalidatedNotified = false;
  function runtimeAlive() {
    try { return !!(chrome && chrome.runtime && chrome.runtime.id); } catch { return false; }
  }

  function tick() {
    // 扩展被更新/重载后，已注入的脚本会失效：只提示刷新（此时已无法调用扩展 API）
    if (!runtimeAlive()) {
      if (!invalidatedNotified) {
        invalidatedNotified = true;
        try { overlay.showReloadNotice("扩展已更新，需要刷新一次页面"); } catch { /* ignore */ }
        util.warn("扩展上下文已失效，请刷新页面");
      }
      return;
    }
    if (state.video && !document.contains(state.video)) { detachVideo(); return; }
    if (!state.video) return;
    const res = state.cache.update(currentTime());
    if (res.changed) {
      render();
      if (overlay.open) scheduleTranslate();
    }
  }

  function render() {
    if (!overlay.mounted) return;
    overlay.setWindow(state.cache.entries(), state.translations);
    composeStatus();
  }

  /** The chip is the only status text on screen, and only while it matters. */
  function isYoutubeAdPlaying() {
    if (!ST.platformOf || ST.platformOf(location) !== "youtube") return false;
    const ad = document.querySelector(".ytp-ad-player-overlay, .ytp-ad-player-overlay-layout");
    if (ad && ad.offsetParent !== null) return true;
    const skip = document.querySelector(".ytp-ad-skip-button, .ytp-ad-skip-button-modern");
    return !!(skip && skip.offsetParent !== null);
  }

  function syncSourceLabel() {
    const parts = [];
    if (state.ocr.timer) parts.push("画面字幕 OCR");
    if (state.ocr.videoActive) parts.push("后台视频 OCR");
    if (state.audio.on) parts.push("语音识别");
    if (parts.length) {
      state.resolve.adapterLabel = parts.join(" + ");
      overlay.setAdapter(state.resolve.adapterLabel);
    }
  }

  function dropOcrCues() {
    const removed = state.cache.cues.filter((c) => c.source === "ocr").map((c) => c.text);
    if (!removed.length) return;
    state.cache.removeWhere((c) => c.source === "ocr");
    for (const text of removed) { state.translations.delete(text); state.inflight.delete(text); }
    requestSW("st:translate-cancel", { texts: removed }, 5000).catch(() => null);
    render();
  }

  function enterFallback() {
    if (state.retryTimer) { clearTimeout(state.retryTimer); state.retryTimer = null; }
    state.resolve.state = "fallback";
    state.resolve.attempts = 5;
  }

  function composeStatus() {
    if (!overlay.mounted) return;
    if (state.resolve.state === "loading" || state.resolve.state === "idle") {
      overlay.setStatus("正在获取字幕…", "info");
      return;
    }
    if (state.ocr.timer && state.cache.cues.length) { overlay.setStatus("", "info"); return; }
    if (state.ocr.timer && state.audio.on) { overlay.setStatus("正在识别画面字幕和语音…", "info"); return; }
    if (state.ocr.timer) { overlay.setStatus("正在识别画面字幕…", "info"); return; }
    if (state.ocr.videoBusy) { overlay.setStatus("正在后台识别视频画面…", "info"); return; }
    if (state.audio.on && !state.cache.cues.length) { overlay.setStatus("正在识别语音…", "info"); return; }
    if (state.resolve.state === "error") {
      const hint = (state.resolve.errors || []).map((e) => e.message).slice(0, 1).join("｜");
      overlay.setStatus(`未找到可用字幕${hint ? `：${hint}` : ""}`, "error");
      return;
    }
    if (state.liveKind && !state.cache.cues.length) {
      overlay.setStatus("请在播放器里打开字幕（CC）", "info");
      return;
    }
    const current = state.cache.entries().slice(-1)[0];
    if (state.resolve.state === "ok" && current && !isLikelyEnglish(current.text) && state.model.state === "ready") {
      overlay.setStatus("当前字幕不是英文，未翻译", "info");
      return;
    }
    const m = state.model;
    if (m.state === "ready" && m.cloud && m.cloud.notice) {
      const notice = String(m.cloud.notice);
      if (state.cloudNoticeText !== notice) {
        state.cloudNoticeText = notice;
        state.cloudNoticeAt = Date.now();
        state.cloudNoticeHidden = false;
        if (state.cloudNoticeTimer) clearTimeout(state.cloudNoticeTimer);
        state.cloudNoticeTimer = setTimeout(() => {
          state.cloudNoticeTimer = null;
          if (state.cloudNoticeText === notice) { state.cloudNoticeHidden = true; overlay.setStatus("", "info"); }
        }, 6000);
      }
      if (!state.cloudNoticeHidden) { overlay.setStatus(notice, "info"); return; }
      overlay.setStatus("", "info");
      return;
    }
    state.cloudNoticeText = "";
    state.cloudNoticeAt = 0;
    state.cloudNoticeHidden = false;
    if (state.cloudNoticeTimer) { clearTimeout(state.cloudNoticeTimer); state.cloudNoticeTimer = null; }
    if (m.state === "ready") { overlay.setStatus("", "info"); return; }
    if (m.state === "error") { overlay.setStatus("翻译暂时不可用，请刷新页面重试", "error"); return; }
    if (m.state === "downloading") {
      if (m.progress == null || m.progress < 100) {
        const pct = m.progress != null ? ` ${m.progress.toFixed(0)}%` : "";
        overlay.setStatus(`正在下载离线翻译${pct}（只这一次）`, "info", m.progress);
      } else {
        overlay.setStatus("正在准备离线翻译…", "info");
      }
      return;
    }
    if (m.state === "loading" || m.state === "warming") { overlay.setStatus(m.message || "正在初始化翻译引擎…", "info"); return; }
    overlay.setStatus("正在准备翻译…", "info");
  }

  /* ------------------------------------------------------------------ live captions */

  const LIVE_READERS = {
    "youtube-dom-caption": () => (typeof ST.readYoutubeDomCaption === "function" ? ST.readYoutubeDomCaption() : null),
    "bilibili-dom-caption": () => (typeof ST.readBilibiliDomCaption === "function" ? ST.readBilibiliDomCaption() : null),
    "douyin-dom-caption": () => (typeof ST.readDouyinDomCaption === "function" ? ST.readDouyinDomCaption() : null),
  };

  function startLiveSampler(kind) {
    if (state.liveKind === kind && state.liveTimer) return;
    stopLiveSampler();
    if (!LIVE_READERS[kind]) return;
    state.liveKind = kind;
    state.lastLiveText = null;
    state.liveTimer = setInterval(sampleLiveCaption, 250);
    sampleLiveCaption();
    util.log("进入实时字幕模式（读取播放器自带字幕）", kind);
  }

  function stopLiveSampler() {
    if (state.liveFallbackTimer) { clearTimeout(state.liveFallbackTimer); state.liveFallbackTimer = null; }
    if (state.merger) state.merger.reset();
    if (state.liveTimer) { clearInterval(state.liveTimer); state.liveTimer = null; }
    state.liveKind = null;
    state.lastLiveText = null;
  }

  /** 把合并器给的 partial / commit 写进滑动窗口 */
  function applySentenceEvents(events) {
    let changed = false;
    for (const ev of (events || [])) {
      if (!ev || !ev.unit) continue;
      const res = state.cache.upsertLive(ev.unit);
      if (res !== "none") changed = true;
    }
    if (changed) scheduleAutoBuffer({ all: false });
    return changed;
  }

  function sampleLiveCaption() {
    if (!state.liveKind || !state.video) return;
    const reader = LIVE_READERS[state.liveKind];
    let text = null;
    try { text = reader(); } catch { text = null; }
    if (!text) {
      // 播放器把字幕清掉了 = 这一句说完了：收句再去翻译整句
      if (state.lastLiveText !== null && state.merger) {
        state.lastLiveText = null;
        if (applySentenceEvents(state.merger.flush())) {
          render();
          if (overlay.open) scheduleTranslate();
        }
      }
      return;
    }
    if (text === state.lastLiveText) return;
    state.lastLiveText = text;
    if (state.liveFallbackTimer) { clearTimeout(state.liveFallbackTimer); state.liveFallbackTimer = null; }
    // 只收英语：播放器渲染的是中文字幕时不要当成原文
    if (util.isLikelyEnglish && !util.isLikelyEnglish(text)) {
      util.log("画面字幕不是英文，跳过", String(text).slice(0, 30));
      return;
    }
    const t = currentTime();
    const cue = { start: t, end: t + 4, text };
    const events = state.merger ? state.merger.push(cue) : [{ type: "commit", unit: { key: null, start: t, end: t + 4, text, done: true } }];
    if (applySentenceEvents(events)) {
      render();
      if (overlay.open) scheduleTranslate();
    }
  }

  /* ------------------------------------------------------- 画面字幕识别（OCR） */

  let ocrCanvas = null;

  function canCaptureFrames(video) {
    try {
      const c = document.createElement("canvas");
      c.width = 8; c.height = 8;
      const g = c.getContext("2d");
      g.drawImage(video, 0, 0, 8, 8);
      g.getImageData(0, 0, 1, 1);
      return true;
    } catch { return false; }
  }

  function captureSubtitleBand(video) {
    const w = Number(video.videoWidth) || 0;
    const h = Number(video.videoHeight) || 0;
    if (!w || !h) return "";
    // 横向只取中间 80%：水印/角标大多在两侧
    const band = ST.ocr.pickSubtitleBand(w, h, 0.3);
    band.sx = Math.round(w * 0.1);
    band.sw = Math.round(w * 0.8);
    // 放大 2 倍 + 二值化：字幕是浅色字、背景偏暗，这样 OCR 准得多
    const scale = Math.min(1.6, 1024 / band.sw);
    const cw = Math.max(1, Math.round(band.sw * scale));
    const ch = Math.max(1, Math.round(band.sh * scale));
    if (!ocrCanvas) ocrCanvas = document.createElement("canvas");
    ocrCanvas.width = cw;
    ocrCanvas.height = ch;
    const g = ocrCanvas.getContext("2d", { willReadFrequently: true });
    g.drawImage(video, band.sx, band.sy, band.sw, band.sh, 0, 0, cw, ch);
    let altDataUrl = "";
    try {
      const img = g.getImageData(0, 0, cw, ch);
      const d = img.data;
      const total = cw * ch;
      const lumArr = new Uint8Array(total);
      let sum = 0, minLum = 255, maxLum = 0;
      for (let p = 0, i = 0; p < total; p++, i += 4) {
        const lum = (0.299 * d[i] + 0.587 * d[i + 1] + 0.114 * d[i + 2]) | 0;
        lumArr[p] = lum;
        sum += lum;
        if (lum < minLum) minLum = lum;
        if (lum > maxLum) maxLum = lum;
      }
      const mean = sum / Math.max(1, total);
      const thr = Math.min(210, Math.max(110, mean + 35));
      const invert = mean > 160;
      let bandHash = 0, white = 0;
      for (let p = 0, i = 0; p < total; p++, i += 4) {
        const bright = lumArr[p] > thr;
        const v = (invert ? !bright : bright) ? 255 : 0;
        d[i] = d[i + 1] = d[i + 2] = v;
        d[i + 3] = 255;
        if (v) white++;
        if (i % 388 === 0) bandHash = (bandHash * 31 + (v ? 1 : 0)) | 0;
      }
      g.putImageData(img, 0, 0);
      ocrCanvas.__bandHash = bandHash;

      // 低对比兜底：把灰底灰字拉伸到 0-255；少数派作为文字颜色。
      const span = maxLum - minLum;
      if (span >= 12 && span < 100) {
        const stretched = new Uint8Array(total);
        let brightCount = 0;
        for (let p = 0; p < total; p++) {
          const v = Math.max(0, Math.min(255, Math.round((lumArr[p] - minLum) * 255 / span)));
          stretched[p] = v;
          if (v > 128) brightCount++;
        }
        const ratio = brightCount / Math.max(1, total);
        const whiteRatio = white / Math.max(1, total);
        const lowContrast = whiteRatio < 0.002 || whiteRatio > 0.55;
        const textLike = (ratio > 0.0005 && ratio < 0.45) || (ratio > 0.55 && ratio < 0.9995);
        if (lowContrast && textLike) {
          const alt = document.createElement("canvas");
          alt.width = cw; alt.height = ch;
          const ag = alt.getContext("2d");
          const aimg = ag.createImageData(cw, ch);
          const ad = aimg.data;
          const altInvert = ratio > 0.55;
          for (let p = 0, i = 0; p < total; p++, i += 4) {
            const isWhite = altInvert ? stretched[p] <= 128 : stretched[p] > 128;
            const v = isWhite ? 255 : 0;
            ad[i] = ad[i + 1] = ad[i + 2] = v;
            ad[i + 3] = 255;
          }
          ag.putImageData(aimg, 0, 0);
          altDataUrl = alt.toDataURL("image/png");
        }
      }
    } catch { /* 取不到像素就按原图识别 */ }
    // 行投影：只保留"白字最多"的那条字幕带（去掉上下大片背景/水印）
    try {
      const img2 = g.getImageData(0, 0, cw, ch);
      const d2 = img2.data;
      const sums = new Int32Array(ch);
      for (let y = 0; y < ch; y++) {
        let c = 0;
        const row = y * cw * 4;
        for (let x = 0; x < cw; x++) if (d2[row + x * 4] > 0) c++;
        sums[y] = c;
      }
      const minCount = Math.max(2, Math.round(cw * 0.008));
      let top = -1, bottom = -1;
      for (let y = 0; y < ch; y++) {
        if (sums[y] >= minCount) { if (top < 0) top = y; bottom = y; }
      }
      if (top >= 0 && bottom - top >= 6) {
        const pad = 4;
        const y0 = Math.max(0, top - pad);
        const y1 = Math.min(ch, bottom + pad);
        const out = document.createElement("canvas");
        out.width = cw;
        out.height = Math.max(1, y1 - y0);
        out.getContext("2d").drawImage(ocrCanvas, 0, y0, cw, y1 - y0, 0, 0, cw, y1 - y0);
        return { dataUrl: out.toDataURL("image/png"), hash: ocrCanvas.__bandHash || 0, height: out.height, altDataUrl };
      }
    } catch { /* 投影失败就用整带 */ }
    return { dataUrl: ocrCanvas.toDataURL("image/png"), hash: ocrCanvas.__bandHash || 0, height: ch, altDataUrl };
  }

  /** 两个 OCR 结果是不是同一句字幕（容忍少量 OCR 差异，但不把相邻句子粘起来） */
  function sameCaptionText(a, b) {
    const A = String(a || "").trim();
    const B = String(b || "").trim();
    if (!A || !B) return false;
    if (A === B) return true;
    const na = A.toLowerCase().replace(/\s+/g, " ");
    const nb = B.toLowerCase().replace(/\s+/g, " ");
    if (na.includes(nb) || nb.includes(na)) {
      return Math.min(na.length, nb.length) / Math.max(na.length, nb.length) >= 0.62;
    }
    return (ST.charEditRatio ? ST.charEditRatio(A, B) : 1) <= 0.24;
  }

  /** 只收"像人话的英文"：优先用 tesseract 行级/逐词置信度过滤背景噪声。 */
  function pickEnglishOcr(res) {
    const confidence = Number(res && res.confidence);
    if (Number.isFinite(confidence) && confidence < 45) return "";
    const height = Number(res && res.height) || 0;
    let text = "";
    if (ST.ocr.selectOcrLines) text = ST.ocr.selectOcrLines(res && res.lines, height);
    if (!text && ST.ocr.selectOcrWords) text = ST.ocr.selectOcrWords(res && res.words, height);
    if (!text) {
      // 旧版引擎没有 words/lines 时的兜底：仍然按整行英文闸门筛。
      const lines = String((res && res.text) || "").split("\n").map((l) => l.trim()).filter(Boolean);
      const englishLines = lines.filter((l) => util.isLikelyEnglish(l));
      for (const c of (englishLines.length ? englishLines : [String((res && res.text) || "")])) {
        const cleaned = ST.ocr.cleanOcrText(c);
        if (!cleaned) continue;
        const words = (cleaned.match(/[A-Za-z]{2,}/g) || []).length;
        const letters = (cleaned.match(/[A-Za-z]/g) || []).length;
        const ratio = letters / Math.max(1, cleaned.replace(/\s+/g, "").length);
        if (words >= 3 && ratio >= 0.6 && (!ST.ocr.looksLikeRealEnglish || ST.ocr.looksLikeRealEnglish(cleaned))) {
          text = cleaned;
          break;
        }
      }
    }
    if (!text) return "";
    if (ST.ocr.correctCommonWords) text = ST.ocr.correctCommonWords(text);
    if (ST.ocr.trimOcrEdges) text = ST.ocr.trimOcrEdges(text);
    if (!text || (ST.ocr.looksLikeRealEnglish && !ST.ocr.looksLikeRealEnglish(text))) return "";
    return text;
  }

  async function runOcrTick() {
    if (state.ocr.disabled || state.ocr.busy || !state.video) return;
    if (state.video.paused || state.video.ended) return;
    const t = currentTime();
    if (Math.abs(t - state.ocr.lastAt) < 0.6) return;
    state.ocr.lastAt = t;
    let cap = null;
    try {
      cap = captureSubtitleBand(state.video);
    } catch (err) {
      util.log("画面取帧失败，停止识别", err && err.message);
      stopOcrSampler();
      return;
    }
    if (!cap || !cap.dataUrl) return;
    if (cap.hash && cap.hash === state.ocr.lastHash) return;   // 画面没变，跳过推理
    state.ocr.lastHash = cap.hash;
    const dataUrl = cap.dataUrl;
    state.ocr.busy = true;
    try {
      let res = await requestSW("st:ocr-test", { dataUrl }, 30000);
      if (state.ocr.disabled) return;
      let text = pickEnglishOcr(res);
      if (!text && cap.altDataUrl) {
        const alt = await requestSW("st:ocr-test", { dataUrl: cap.altDataUrl }, 30000);
        if (state.ocr.disabled) return;
        const altText = pickEnglishOcr(alt);
        if (altText) { res = alt; text = altText; util.log("低对比字幕二次识别成功"); }
      }
      if (!text) return;

      // 多帧投票：同一句字幕连续识别 2-3 次，置信度加权取多数写法；
      // 第一帧仍然立刻上屏，第二/三帧只做原地纠正，不增加首条延迟。
      const prev = state.ocr.observations[state.ocr.observations.length - 1];
      const gap = prev ? Math.abs(t - prev.at) : 99;
      const sameCluster = prev && gap <= 3.5 && sameCaptionText(text, prev.text);
      if (!sameCluster) {
        state.ocr.observations = [];
        state.ocr.captionStart = t;
        state.ocr.lastKey = null;
      }
      state.ocr.observations.push({
        text,
        confidence: Number(res && res.confidence) || 0,
        at: t,
      });
      while (state.ocr.observations.length > 3) state.ocr.observations.shift();

      state.ocr.attempts++;
      const merged = ST.ocr.consensusOcrText
        ? ST.ocr.consensusOcrText(state.ocr.observations)
        : { text };
      const finalText = String((merged && merged.text) || text).trim();
      if (state.ocr.disabled) return;
      if (!finalText) return;
      if (ST.ocr.looksLikeRealEnglish && !ST.ocr.looksLikeRealEnglish(finalText)) return;
      if (!state.ocr.lastHitText || !sameCaptionText(finalText, state.ocr.lastHitText)) {
        state.ocr.hits++;
        state.ocr.lastHitText = finalText;
      }
      // OCR 与 ASR 连续 2 行一致：说明硬字幕可靠，关闭 ASR 节省 CPU。
      if (state.audio.on && state.audio.lastText && ST.crossCheck && Math.abs(t - state.audio.lastAt) <= 8) {
        const cc = ST.crossCheck(finalText, state.audio.lastText);
        if (cc.score >= 0.55) {
          state.ocr.goodMatches++;
          if (state.ocr.goodMatches >= 2) {
            util.log("OCR 与语音连续一致，关闭 ASR 节省资源");
            stopAsr();
          }
        } else {
          state.ocr.goodMatches = 0;
        }
      }

      const sameAsCommitted = state.ocr.lastText && sameCaptionText(finalText, state.ocr.lastText);
      if (!sameAsCommitted || !state.ocr.lastKey) {
        state.ocr.seq = (state.ocr.seq || 0) + 1;
        state.ocr.lastKey = "ocr-" + state.ocr.seq;
        state.ocr.captionStart = t;
      }
      state.ocr.lastText = finalText;
      const start = Number.isFinite(state.ocr.captionStart) && state.ocr.captionStart >= 0
        ? state.ocr.captionStart
        : t;
      const unit = { key: state.ocr.lastKey, start, end: t + 3.2, text: finalText, done: true, source: "ocr" };
      if (state.cache.upsertLive(unit) !== "none") {
        // 软字幕失败后 OCR 兜底成功：UI 必须显示真实来源，而不是适配器错误。
        state.resolve.state = "ok";
        state.resolve.message = "画面字幕识别";
        syncSourceLabel();
        overlay.setErrors([]);
        render();
        if (overlay.open) { try { translateWindow(); } catch { } }
      }
    } catch { /* 单帧失败不影响下一帧 */ }
    finally { state.ocr.busy = false; }
  }

  function startOcrSampler() {
    if (state.ocr.timer || !state.video) return false;
    if (!canCaptureFrames(state.video)) { util.log("这个页面的画面不能取帧，跳过页面内画面识别"); return false; }
    state.ocr.timer = setInterval(runOcrTick, 1000);
    state.ocr.lastAt = -99;
    state.ocr.hits = 0;
    state.ocr.attempts = 0;
    state.ocr.lastHitText = "";
    state.ocr.mismatches = 0;
    state.ocr.goodMatches = 0;
    state.ocr.disabled = false;
    state.ocr.startedAt = Date.now();
    if (state.ocr.probeTimer) clearTimeout(state.ocr.probeTimer);
    state.ocr.probeTimer = setTimeout(() => {
      state.ocr.probeTimer = null;
      const keep = ST.ocr.shouldKeepOcrProbe
        ? ST.ocr.shouldKeepOcrProbe({ hits: state.ocr.hits, attempts: state.ocr.attempts, elapsedMs: Date.now() - state.ocr.startedAt })
        : state.ocr.hits >= 2;
      if (keep) return;
      util.log("9 秒内没有稳定硬字幕，关闭画面 OCR，改用语音识别");
      state.ocr.disabled = true;
      stopOcrSampler(true);
      dropOcrCues();
    }, 9000);
    enterFallback();
    syncSourceLabel();
    util.log("开始识别画面字幕");
    composeStatus();
    runOcrTick();
    return true;
  }

  function stopOcrSampler(keepProbe) {
    if (state.ocr.timer) clearInterval(state.ocr.timer);
    if (state.ocr.probeTimer) clearTimeout(state.ocr.probeTimer);
    state.ocr.timer = null;
    state.ocr.probeTimer = null;
    state.ocr.busy = false;
    state.ocr.lastText = "";
    state.ocr.lastAt = -99;
    state.ocr.lastHash = 0;
    state.ocr.observations = [];
    state.ocr.lastKey = null;
    state.ocr.captionStart = -1;
    if (!keepProbe) {
      state.ocr.videoActive = false;
      state.ocr.videoTried = false;
      state.ocr.videoBusy = false;
      state.ocr.blobTried = false;
      state.ocr.hits = 0;
      state.ocr.attempts = 0;
      state.ocr.lastHitText = "";
      state.ocr.mismatches = 0;
      state.ocr.goodMatches = 0;
      state.ocr.disabled = false;
    }
    syncSourceLabel();
  }

  function applyAsrText(text, t) {
    let clean = String(text || "").replace(/\s+/g, " ").trim();
    if (ST.dedupeAsrText) clean = ST.dedupeAsrText(clean);
    if (!clean || !util.isLikelyEnglish(clean)) return false;
    if (state.audio.lastText && ST.textSimilarity && ST.textSimilarity(clean, state.audio.lastText) >= 0.9) return false;
    state.audio.lastText = clean;
    if (ST.ocr && ST.ocr.looksLikeRealEnglish && !ST.ocr.looksLikeRealEnglish(clean)) {
      util.log("语音结果不像正常英文，丢弃", clean.slice(0, 40));
      return false;
    }
    if (state.ocr.timer && ST.crossCheck) {
      const ocrLatest = [...state.cache.cues].reverse().find((c) => c.source === "ocr");
      if (ocrLatest && Math.abs(t - (Number(ocrLatest.end) || Number(ocrLatest.start) || t)) <= 8) {
        const cc = ST.crossCheck(ocrLatest.text, clean);
        if (cc.score < 0.45) state.ocr.mismatches++;
        else state.ocr.mismatches = 0;
        if (state.ocr.mismatches >= 2) {
          util.log("OCR 与语音连续不一致，关闭画面 OCR");
          state.ocr.disabled = true;
          stopOcrSampler(true);
          dropOcrCues();
        }
      }
    }
    state.audio.lastAt = t;
    state.resolve.state = "ok";
    state.resolve.message = "语音识别";
    syncSourceLabel();
    overlay.setErrors([]);
    const events = state.merger ? state.merger.push({ start: Math.max(0, t - 6), end: t, text: clean, source: "asr" }) : [];
    if (applySentenceEvents(events)) { render(); if (overlay.open) scheduleTranslate(); }
    scheduleAutoBuffer({ all: false });
    return true;
  }

  function applyAsrSegments(segments, fallbackText, fallbackTime) {
    const heldOcr = state.cache.cues.filter((c) => c.source === "ocr" || c.source === "ocr-video");
    if (heldOcr.length >= 2 && !state.ocr.disabled) {
      util.log("已有稳定硬字幕 OCR，整段语音只保留给交叉验证");
      return false;
    }
    const cues = [];
    for (const seg of segments || []) {
      let text = String((seg && seg.text) || "").replace(/\s+/g, " ").trim();
      if (ST.dedupeAsrText) text = ST.dedupeAsrText(text);
      if (!text || !util.isLikelyEnglish(text)) continue;
      if (ST.ocr && ST.ocr.looksLikeRealEnglish && !ST.ocr.looksLikeRealEnglish(text)) continue;
      const start = Math.max(0, Number(seg.start) || 0);
      const end = Math.max(start + 1, Number(seg.end) || start + 3);
      cues.push({ start, end, text });
    }
    if (!cues.length) return applyAsrText(fallbackText, fallbackTime);
    state.cache.load(cues.sort((a, b) => a.start - b.start), { source: "asr-video" });
    state.cache.update(currentTime());
    state.resolve.state = "ok";
    state.resolve.message = "语音识别（已预处理）";
    state.resolve.adapterLabel = "语音识别";
    state.resolve.attempts = 5;
    if (state.retryTimer) { clearTimeout(state.retryTimer); state.retryTimer = null; }
    state.audio.lastText = cues[cues.length - 1].text;
    syncSourceLabel();
    overlay.setErrors([]);
    render();
    if (overlay.open) { try { translateWindow(); } catch { } }
    scheduleAutoBuffer({ all: true, force: true });
    util.log("整段语音预处理完成", cues.length, "条时间轴字幕");
    return true;
  }

  function startAudioBuffer(delayMs) {
    if (!state.video || state.audio.bufferTried || state.softSubtitles) return;
    const url = typeof ST.getDouyinAudioUrl === "function" ? ST.getDouyinAudioUrl() : "";
    const dur = Number(state.video.duration) || 0;
    if (!url || !(dur > 0 && dur <= 1800)) return;
    state.audio.bufferTried = true;
    const maxSeconds = Math.min(1800, Math.max(30, Math.ceil(dur)));
    const run = () => {
      if (!state.video) return;
      util.log("后台预处理整段语音（缓冲）", Math.round(maxSeconds), "秒");
      requestSW("st:asr-opfs-url", { url, maxSeconds }, maxSeconds > 300 ? 1200000 : 300000)
        .then((r) => {
          if (!state.video) return;
          const segs = (r && r.segments) || [];
          const text = String((r && r.text) || "").trim();
          if (segs.length) applyAsrSegments(segs, text, currentTime());
          else if (text) applyAsrText(text, currentTime());
        })
        .catch((err) => util.log("后台整段语音预处理失败", err && err.message));
    };
    if (delayMs > 0) setTimeout(run, delayMs); else run();
  }

  function startRemoteAsr() {
    if (!state.video || state.audio.remoteTried) return;
    const url = typeof ST.getDouyinAudioUrl === "function" ? ST.getDouyinAudioUrl() : "";
    const dur = Number(state.video.duration) || 0;
    if (!url || !(dur > 0 && dur <= 1800)) return;
    state.audio.remoteTried = true;
    state.audio.bufferTried = true;
    state.audio.on = true;
    state.audio.busy = true;
    enterFallback();
    syncSourceLabel();
    composeStatus();
    const maxSeconds = Math.min(1800, Math.max(30, Math.ceil(dur)));
    util.log("页面音频不可抓，尝试 media-audio OPFS ASR");
    requestSW("st:asr-opfs-url", { url, maxSeconds }, maxSeconds > 300 ? 1200000 : 300000)
      .then((r) => {
        const segs = (r && r.segments) || [];
        const text = String((r && r.text) || "").trim();
        if (segs.length) applyAsrSegments(segs, text, currentTime());
        else if (text) applyAsrText(text, currentTime());
      })
      .catch((err) => util.log("OPFS 语音识别失败", err && err.message))
      .finally(() => { state.audio.on = false; state.audio.busy = false; syncSourceLabel(); composeStatus(); });
  }

  async function handleAsrPcm(pcm) {
    // 上一段还没回来就跳过这一段，避免排队把内存撑爆 / 越拖越久
    if (state.audio.busy) { util.log("语音识别还在处理上一段，跳过本段"); return; }
    // 静音/太小音量直接跳过，省掉一次推理
    let sum = 0, peak = 0;
    for (let i = 0; i < pcm.length; i++) { const v = pcm[i]; sum += v * v; if (Math.abs(v) > peak) peak = Math.abs(v); }
    const rms = Math.sqrt(sum / Math.max(1, pcm.length));
    if (rms < 0.005 && peak < 0.05) { util.log("这一段几乎没有声音，跳过语音识别"); return; }
    state.audio.busy = true;
    const startedAt = Date.now();
    try {
      const r = await requestSW("st:asr", { pcm: Array.from(pcm) }, 60000);
      const text = String((r && r.text) || "").replace(/\s+/g, " ").trim();
      if (text) applyAsrText(text, currentTime());
    } catch (err) {
      util.log("语音识别失败", err && err.message);
    } finally {
      state.audio.busy = false;
      if (Date.now() - startedAt > 20000) util.log("语音识别耗时 " + Math.round((Date.now() - startedAt) / 1000) + "s");
    }
  }

  /** 视频 captureStream 没有声音时，用 media-audio 直链建一个跨域 audio 元素采集。 */
  async function startAudioElementAsr() {
    if (!state.video) return false;
    const url = typeof ST.getDouyinAudioUrl === "function" ? ST.getDouyinAudioUrl() : "";
    if (!url) return false;
    try {
      const a = document.createElement("audio");
      a.crossOrigin = "anonymous";
      a.preload = "auto";
      a.src = url;
      a.volume = 0.01;
      try { a.currentTime = Number(state.video.currentTime) || 0; } catch { /* ignore */ }
      await new Promise((resolve) => {
        if (a.readyState >= 2) return resolve();
        const timer = setTimeout(resolve, 5000);
        a.addEventListener("canplay", () => { clearTimeout(timer); resolve(); }, { once: true });
        a.load();
      });
      a.play().catch(() => {});
      await new Promise((r) => setTimeout(r, 500));
      const ok = ST.audioCapture.startAudioCapture(a, handleAsrPcm, { windowSec: 5, overlapSec: 2.5 });
      if (!ok) { try { a.pause(); a.src = ""; } catch { /* ignore */ } return false; }
      state.audio.element = a;
      state.audio.source = "audio-element";
      state.audio.on = true;
      state.audio.lastText = "";
      state.audio.lastAt = -99;
      state.audio.startedAt = Date.now();
      const sync = () => {
        if (state.audio.element !== a || !state.video) return;
        try {
          if (Math.abs(a.currentTime - state.video.currentTime) > 1.5) a.currentTime = state.video.currentTime;
          if (state.video.paused) a.pause(); else a.play().catch(() => {});
        } catch { /* ignore */ }
      };
      state.audio.syncFn = sync;
      state.video.addEventListener("play", sync);
      state.video.addEventListener("pause", sync);
      state.video.addEventListener("seeked", sync);
      state.audio.syncTimer = setInterval(sync, 3000);
      enterFallback();
      syncSourceLabel();
      composeStatus();
      util.log("改用 media-audio 直链采集（跨域 audio 元素）");
      return true;
    } catch (err) {
      util.log("media-audio 采集失败", err && err.message);
      return false;
    }
  }

  function maybeStartAsr() {
    if (state.audio.on || !state.video) return;
    if (isYoutubeAdPlaying()) {
      util.log("YouTube 广告播放中，稍后启动语音识别");
      setTimeout(() => { if (!state.audio.on && state.video) maybeStartAsr(); }, 3000);
      return;
    }
    if (!ST.audioCapture || !ST.audioCapture.supported(state.video)) { startRemoteAsr(); return; }
    setTimeout(() => {
      if (!state.video || state.audio.bufferTried || state.softSubtitles) return;
      if (state.audio.lastAt >= 0) return; // 实时语音已出结果，不重复占用 ASR
      startAudioBuffer(0);
    }, 15000);
    const ok = ST.audioCapture.startAudioCapture(state.video, handleAsrPcm, { windowSec: 5, overlapSec: 2.5 });
    if (ok) {
      state.audio.on = true;
      state.audio.source = "video";
      state.audio.lastText = "";
      state.audio.lastAt = -99;
      state.audio.remoteTried = false;
      state.audio.startedAt = Date.now();
      enterFallback(); syncSourceLabel(); util.log("开始识别视频声音");
      setTimeout(async () => {
        if (!state.video || !state.audio.on || state.audio.lastAt >= 0 || state.audio.restarts >= 1) return;
        state.audio.restarts++;
        util.log("视频音轨 8 秒无结果，尝试 media-audio 直链采集");
        try { ST.audioCapture.stopAudioCapture(); } catch { /* ignore */ }
        state.audio.on = false;
        if (await startAudioElementAsr()) return;
        util.log("media-audio 采集不可用，重启视频音轨一次");
        maybeStartAsr();
      }, 8000);
    } else { startRemoteAsr(); }
  }

  function stopAsr() {
    if (ST.audioCapture) ST.audioCapture.stopAudioCapture();
    if (state.audio.syncTimer) { clearInterval(state.audio.syncTimer); state.audio.syncTimer = null; }
    if (state.video && state.audio.syncFn) {
      try {
        state.video.removeEventListener("play", state.audio.syncFn);
        state.video.removeEventListener("pause", state.audio.syncFn);
        state.video.removeEventListener("seeked", state.audio.syncFn);
      } catch { /* ignore */ }
    }
    if (state.audio.element) {
      try { state.audio.element.pause(); state.audio.element.src = ""; } catch { /* ignore */ }
    }
    state.audio.element = null;
    state.audio.syncFn = null;
    state.audio.source = "";
    state.audio.on = false;
    state.audio.busy = false;
    state.audio.lastText = "";
    state.audio.lastAt = -99;
    state.audio.remoteTried = false;
    state.audio.bufferTried = false;
    state.audio.restarts = 0;
    state.audio.startedAt = 0;
    syncSourceLabel();
  }
  function applyVideoOcrCues(r) {
    const cues = (r && r.cues) || [];
    if (!cues.length) return false;
    state.ocr.videoActive = true;
    state.cache.load(cues.map((c) => ({ ...c, source: "ocr-video" })), { source: "ocr-video" });
    state.cache.update(currentTime());
    state.resolve.state = "ok";
    state.resolve.message = "后台视频 OCR";
    state.resolve.adapterLabel = "后台视频 OCR";
    state.resolve.attempts = 5;
    if (state.retryTimer) { clearTimeout(state.retryTimer); state.retryTimer = null; }
    syncSourceLabel();
    overlay.setErrors([]);
    render();
    if (overlay.open) { try { translateWindow(); } catch { } }
    scheduleAutoBuffer({ all: true, force: true });
    return true;
  }

  function base64Chunk(u8) {
    let s = "";
    for (let i = 0; i < u8.length; i += 0x8000) {
      s += String.fromCharCode.apply(null, u8.subarray(i, i + 0x8000));
    }
    return btoa(s);
  }

  /** 页面 blob → content 端口 → SW 写 OPFS。 */
  function uploadBlobToOpfs(blobUrl, name) {
    return new Promise((resolve, reject) => {
      const port = chrome.runtime.connect({ name: "st-opfs-upload" });
      let settled = false;
      let readyResolve = null;
      const ready = new Promise((r) => { readyResolve = r; });
      const timer = setTimeout(() => done(new Error("blob 上传超时")), 300000);
      function done(err, value) {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        if (err) reject(err); else resolve(value);
      }
      port.onMessage.addListener((msg) => {
        if (!msg) return;
        if (msg.type === "ready") { if (readyResolve) readyResolve(); return; }
        if (msg.type === "saved") { done(null, msg); return; }
        if (msg.type === "error") { if (readyResolve) readyResolve(); done(new Error(msg.error || "blob 上传失败")); }
      });
      port.onDisconnect.addListener(() => {
        if (!settled) done(new Error("blob 上传通道关闭"));
      });
      (async () => {
        const res = await fetch(blobUrl);
        if (!res.ok) throw new Error("blob 读取失败 " + res.status);
        port.postMessage({ type: "start", name });
        await ready;
        const reader = res.body.getReader();
        while (true) {
          const { done: isDone, value } = await reader.read();
          if (isDone) break;
          port.postMessage({ type: "chunk", data: base64Chunk(value) });
        }
        port.postMessage({ type: "done" });
      })().catch((err) => { if (readyResolve) readyResolve(); done(err); });
    });
  }

  async function startBlobOpfsOcr() {
    if (!state.video) return { ok: false, error: "没有视频" };
    const src = String(state.video.currentSrc || "");
    if (!/^blob:/i.test(src)) return { ok: false, error: "不是 blob 视频" };
    if (state.ocr.blobTried) return { ok: false, error: "已尝试过" };
    state.ocr.blobTried = true;
    state.ocr.videoBusy = true;
    enterFallback();
    syncSourceLabel();
    composeStatus();
    util.log("页面不能取帧，尝试把 blob 视频写入 OPFS 后 OCR");
    try {
      const saved = await uploadBlobToOpfs(src, "blob-" + Date.now() + ".mp4");
      const r = await requestSW("st:ocr-opfs-name", { name: saved.name, step: 2, maxFrames: 12 }, 300000);
      const applied = applyVideoOcrCues(r);
      return { ok: applied, cues: (r && r.cues) || [] };
    } catch (err) {
      util.log("blob OPFS OCR 失败", err && err.message);
      return { ok: false, error: err && err.message ? err.message : String(err) };
    } finally {
      state.ocr.videoBusy = false;
      composeStatus();
    }
  }

  function maybeStartOcr() {
    if (!state.video || state.ocr.disabled) return;
    if (state.resolve.state === "ok" && state.cache.cues.length) return;
    if (state.ocr.timer) return;
    // YouTube 未开 CC 时 OCR 容易读到播放器/画面浮层文字，直接用 ASR。
    if (ST.platformOf && ST.platformOf(location) === "youtube" && !state.cache.cues.length) {
      util.log("YouTube 无软字幕：跳过画面 OCR，使用语音识别");
      return;
    }
    if (startOcrSampler()) return;
    const video = state.video;
    let src = String(video.currentSrc || "");
    if (/^blob:/i.test(src) && typeof ST.getDouyinVideoUrl === "function") {
      try { const u = ST.getDouyinVideoUrl(); if (/^https?:/i.test(u)) src = u; } catch { /* ignore */ }
    }
    const blobInfo = { src, tried: state.ocr.blobTried, canCaptureFrames: false };
    if (ST.ocr.shouldTryBlobOpfs ? ST.ocr.shouldTryBlobOpfs(blobInfo) : false) { startBlobOpfsOcr(); return; }
    const info = { src, duration: Number(video.duration) || 0, tried: state.ocr.videoTried, canCaptureFrames: false };
    const canShort = ST.ocr.shouldTryVideoOcr ? ST.ocr.shouldTryVideoOcr(info) : false;
    const canLong = ST.ocr.shouldTryVideoOcrOpfs ? ST.ocr.shouldTryVideoOcrOpfs(info) : false;
    if (!canShort && !canLong) return;
    const type = canShort ? "st:ocr-video" : "st:ocr-video-opfs";
    state.ocr.videoTried = true;
    state.ocr.videoBusy = true;
    enterFallback();
    syncSourceLabel();
    composeStatus();
    util.log("页面不能取帧，尝试后台抓取视频 OCR");
    requestSW(type, { url: src, step: 2, maxFrames: canShort ? 20 : 12 }, 300000)
      .then((r) => { applyVideoOcrCues(r); })
      .catch((err) => util.log("后台视频 OCR 失败", err && err.message))
      .finally(() => { state.ocr.videoBusy = false; composeStatus(); });
  }

  /** The MAIN-world hook captured the player's own caption payload: upgrade to the full list. */
  ST.onYtCaptured = () => {
    if (state.resolve.state === "ok" && state.cache.cues.length && !state.liveKind) return;
    state.resolve.attempts = 0;
    resolveSubtitles("captured");
  };

  /* ------------------------------------------------------------------ translation */

  let translateDebounced = null;
  function scheduleTranslate() {
    if (!overlay.open) return;
    if (!translateDebounced) translateDebounced = util.debounce(translateWindow, CONFIG.TRANSLATE_DEBOUNCE_MS);
    translateDebounced();
  }

  /** Only English lines are translated; a player showing e.g. Chinese captions must not be
   *  "translated" into nonsense. */
  const isLikelyEnglish = (text) => util.isLikelyEnglish(text);
  ST.isLikelyEnglish = isLikelyEnglish;

  function needsTranslation(text) {
    const t = state.translations.get(text);
    if (!t) return true;
    if (t.status === "error") return state.model.state === "ready";
    return false;
  }

  /** Only the lines that are actually on screen are translated, newest first. */
  function translateWindow() {
    if (!overlay.open) return;
    // 已收句的整句都翻；当前 ASR/OCR 半句达到 3+ 词也立即翻，避免长句一直等收句而没有中文。
    const shown = state.cache.entries().slice(-DISPLAY_LINES).filter((e) => {
      if (e.done !== false) return true;
      if (!e.isCurrent) return false;
      if (e.source !== "asr" && e.source !== "ocr") return false;
      return String(e.text || "").trim().split(/\s+/).filter(Boolean).length >= 3;
    });
    for (const e of shown) {
      if (!isLikelyEnglish(e.text) && !state.translations.has(e.text)) {
        state.translations.set(e.text, { status: "done", zh: "", source: "non-english" });
      }
    }
    const wanted = shown.filter((e) => needsTranslation(e.text) && !state.inflight.has(e.text));
    if (!wanted.length) return;
    wanted.sort((a, b) => (b.isCurrent ? 1 : 0) - (a.isCurrent ? 1 : 0));
    wanted.forEach((e, i) => {
      state.inflight.add(e.text);
      let provisional = "";
      if (ST.textSimilarity) {
        let best = 0;
        for (const [t, v] of state.translations) {
          if (t === e.text || !v || v.status !== "done" || !v.zh) continue;
          const sc = ST.textSimilarity(e.text, t);
          if (sc > best && sc >= 0.6) { best = sc; provisional = v.zh; }
        }
      }
      state.translations.set(e.text, { status: "pending", zh: provisional, error: null, provisional: !!provisional });
      e.priority = i === 0 && e.isCurrent;
    });
    render();
    const all = state.cache.entries();
    const withContext = wanted.map((e) => {
      const idx = all.findIndex((x) => x.index === e.index);
      const prevLines = idx > 0 ? all.slice(Math.max(0, idx - 2), idx).map((x) => x.text) : [];
      return { text: e.text, priority: !!e.priority, prevLines };
    });
    requestSW(MSG.TRANSLATE, { items: withContext }, 60000).catch((err) => {
      for (const e of wanted) {
        state.inflight.delete(e.text);
        const prev = state.translations.get(e.text);
        state.translations.set(e.text, { status: "error", zh: (prev && prev.zh) || "", error: err.message });
      }
      render();
    });
  }

  /** 内部缓冲：像视频灰条一样提前翻译，不需要用户打开面板或点按钮。 */
  function scheduleAutoBuffer(opts) {
    const o = opts || {};
    if (!state.cache.cues.length) return;
    if (state.autoBufferTimer) return;
    const now = Date.now();
    const cooldown = o.all ? 15000 : 20000;
    const wait = Math.max(0, cooldown - (now - state.autoBufferAt));
    const key = `${location.href}|${o.all ? "all" : "window"}|${state.cache.cues.length}`;
    if (!o.force && state.autoBufferKey === key && wait > 0) return;
    state.autoBufferTimer = setTimeout(() => {
      state.autoBufferTimer = null;
      if (!state.cache.cues.length) return;
      state.autoBufferAt = Date.now();
      state.autoBufferKey = key;
      prefetchSubtitles({ all: !!o.all, auto: true, force: true }).catch(() => null);
    }, wait);
  }

  /** 预翻译未来 60 秒（默认）或全部字幕；auto 为内部自动缓冲，不依赖面板打开。 */
  async function prefetchSubtitles(opts) {
    const o = opts || {};
    // 实时 ASR 的当前句由 translateWindow 以 priority 直翻；不要再批量预取历史变体，避免队列被半句刷爆。
    if (o.auto && state.audio.on && !state.softSubtitles) return { ok: false, error: "live-asr-skip-prefetch" };
    if (!state.cache.cues.length) return { ok: false, error: "没有可预处理的字幕" };
    if (!o.force && !o.auto && !overlay.open) return { ok: false, error: "字幕未打开" };
    if (state.prefetching) return { ok: false, error: "预处理进行中" };
    const now = Date.now();
    if (!o.force && now - state.lastPrefetchAt < (o.auto ? 5000 : 8000)) return { ok: false, error: "刚预取过" };
    const allMode = !!o.all;
    const t = currentTime();
    const from = allMode ? 0 : Math.max(0, state.cache.findIndexAt(t));
    const end = allMode ? Infinity : t + 60;
    const all = state.cache.cues;
    const candidates = [];
    for (let i = from; i < all.length; i++) {
      const c = all[i];
      if (!c) continue;
      if (c.start > end) break;
      const text = String(c.text || "").trim();
      if (!text || !isLikelyEnglish(text)) continue;
      if (state.translations.has(text) || state.inflight.has(text)) continue;
      candidates.push({ text, priority: false, prevLines: all.slice(Math.max(0, i - 2), i).map((x) => x.text) });
      if (!allMode && candidates.length >= 20) break;
    }
    util.log("预翻译候选", allMode ? "all" : "window", candidates.length, "token", state.prefetchToken);
    if (!candidates.length) {
      const total = Number(state.prefetchAll && state.prefetchAll.total) || 0;
      const done = Number(state.prefetchAll && state.prefetchAll.done) || 0;
      const allDone = allMode && total > 0 && done >= total;
      const message = allDone ? "字幕已全部预处理" : (allMode ? "当前没有可批量预处理的字幕（可能是实时字幕）" : "没有需要预处理的字幕");
      state.prefetchAll = { running: false, done, total, message };
      return { ok: true, done, total, message };
    }
    const token = state.prefetchToken;
    state.prefetching = true;
    state.lastPrefetchAt = now;
    state.prefetchAll = { running: true, done: 0, total: candidates.length, message: "" };
    try {
      for (let i = 0; i < candidates.length; i += 20) {
        if (token !== state.prefetchToken) { util.log("预翻译取消，token 变化", token, state.prefetchToken); break; }
        const batch = candidates.slice(i, i + 20);
        for (const it of batch) {
          state.translations.set(it.text, { status: "pending", zh: "", error: null });
          state.inflight.add(it.text);
        }
        await requestSW(MSG.TRANSLATE, { items: batch }, 60000);
        for (let n = 0; n < 600; n++) {
          if (token !== state.prefetchToken) break;
          if (batch.every((it) => !state.inflight.has(it.text))) break;
          await new Promise((r) => setTimeout(r, 100));
        }
        if (token !== state.prefetchToken) break;
        state.prefetchAll.done = Math.min(candidates.length, i + batch.length);
        util.log("预翻译进度", state.prefetchAll.done, "/", candidates.length);
      }
      return { ok: true, done: state.prefetchAll.done, total: candidates.length };
    } catch (err) {
      return { ok: false, error: err && err.message ? err.message : String(err) };
    } finally {
      state.prefetching = false;
      state.prefetchAll.running = false;
    }
  }

  function onTranslationResult(payload) {
    const text = payload.text;
    if (!text) return;
    state.inflight.delete(text);
    if (payload.error) {
      state.translations.set(text, { status: "error", zh: "", error: payload.error });
    } else {
      state.translations.set(text, { status: "done", zh: payload.zh || "", source: payload.source || "model" });
    }
    render();
    if (overlay.open) scheduleTranslate();
  }

  function onModelStatus(payload) {
    state.model = {
      state: payload.state || state.model.state,
      device: payload.device || state.model.device,
      progress: Number.isFinite(payload.progress) ? payload.progress : state.model.progress,
      message: payload.message || "",
      dtype: payload.dtype || state.model.dtype,
      cloud: payload.cloud || state.model.cloud || null,
    };
    overlay.setModelState(state.model.state);
    if (state.model.device) overlay.setDevice(state.model.device);
    composeStatus();
    if (state.model.state === "ready" && overlay.open) {
      // drop stale "pending"/"failed" markers so those lines get requested again
      for (const [text, t] of state.translations) {
        if ((t.status === "pending" || t.status === "error") && !state.inflight.has(text)) state.translations.delete(text);
      }
      scheduleTranslate();
    }
    if (state.model.state === "error") util.warn("本地模型不可用：", state.model.message);
  }

  /* ------------------------------------------------------------------ interaction */

  function togglePopup(source) {
    if (!overlay.mounted) return;
    if (overlay.open) {
      overlay.hide();
      util.log("弹窗关闭");
      return;
    }
    if (!state.video) state.video = findVideo();
    overlay.ensurePlacement();
    overlay.attachVideo(state.video);
    overlay.show();
    prefetchSubtitles();
    if (ST.platformOf && ST.platformOf(location) === "youtube" && !state.cache.cues.length) util.guard("语音识别", maybeStartAsr);
    if (!state.video) {
      overlay.setStatus("当前页面没有检测到视频，请在视频页面使用。", "error");
      return;
    }
    overlay.setFabVisible(state.settings.fabVisible);
    render();
    if (state.resolve.state !== "ok") resolveSubtitles("popup");
    else scheduleTranslate();
    // 状态还没拿到（例如后台 service worker 刚被唤醒）时补问一次
    if (state.model.state === "unknown") {
      util.guard("补充引擎状态", () => requestSW(MSG.MODEL_STATUS, {}, 10000).then((data) => { if (data) onModelStatus(data); }));
    }
    util.log(`弹窗打开（方式：${source}）`);
  }

  function onKeyDown(event) {
    const key = String(event.key || "").toLowerCase();
    const saveKey = String(state.settings.saveKey || "").toLowerCase();
    // 保存当前三条双语字幕到笔记（Shift+保存键 = 重新选择保存位置）
    if (saveKey && saveKey !== "none" && key === saveKey) {
      if (util.isEditableTarget(event.target)) return;
      event.preventDefault();
      if (event.stopImmediatePropagation) event.stopImmediatePropagation();
      event.stopPropagation();
      if (event.shiftKey) { util.guard("重新选择保存位置", changeNoteFile); return; }
      util.guard("保存笔记", saveNote);
      return;
    }
    // V：在页面上直接授权 / 选择保存位置（不用去扩展面板点确认）
    if (key === "v" && !event.shiftKey && !event.ctrlKey && !event.metaKey && !event.altKey) {
      if (util.isEditableTarget(event.target)) return;
      event.preventDefault();
      if (event.stopImmediatePropagation) event.stopImmediatePropagation();
      event.stopPropagation();
      util.guard("选择保存位置", recoverFolder);
      return;
    }
    const hotkey = String(state.settings.hotkey || "").toLowerCase();
    if (!hotkey || hotkey === "none") return;
    const isSpace = event.code === "Space" || key === " " || key === "spacebar";
    if (hotkey === "space" ? !isSpace : key !== hotkey) return;
    if (event.ctrlKey || event.metaKey || event.altKey) return;
    if (util.isEditableTarget(event.target)) return;
    if (!state.video && !findVideo()) return; // no video on this page: leave the key alone
    event.preventDefault();
    if (event.stopImmediatePropagation) event.stopImmediatePropagation();
    event.stopPropagation();
    togglePopup("hotkey:" + hotkey);
  }

  /* ------------------------------------------------------------------ 复习笔记 */

  async function noteLines() {
    const shown = overlay.displayedEntries();
    const lines = [];
    for (const e of shown) {
      lines.push(e.text);
      const t = state.translations.get(e.text);
      if (t && t.status === "done" && t.zh) lines.push(t.zh);
    }
    return { lines, count: shown.length };
  }

  async function storedFileName() {
    try {
      const res = await chrome.storage.local.get(["st_note_filename"]);
      return res.st_note_filename || ST.noteStore.DEFAULT_FILE;
    } catch { return ST.noteStore.DEFAULT_FILE; }
  }

  async function saveNote() {
    const { lines, count } = await noteLines();
    if (!count || !lines.length) { overlay.flash("没有字幕可保存", 1600, "err"); return; }
    const fileName = await storedFileName();

    // ⓪ 本地助手：直接把笔记写到磁盘上（不用授权、不用下载）
    if (state.host.ok) {
      try {
        const out = await requestSW(MSG.NOTE_APPEND, { lines, fileName }, 25000);
        if (out && out.ok) {
          overlay.flash("已存笔记", 1500, "ok");
          util.log("笔记已保存：" + count + " 条（" + (out.folder || "") + "）");
          return;
        }
        const why = out && out.reason;
        if (why === "duplicate") { overlay.flash("这段已经保存过了", 1800, "err"); return; }
        if (why === "locked") { overlay.flash("笔记正在 Word 里打开，先关掉它再按 S", 3600, "err"); return; }
        if (why === "duplicate") { overlay.flash("这段已经保存过了", 1800, "err"); return; }
      if (why === "foreign-docx") { overlay.flash("这个 Word 文件不是本工具生成的，换个文件名再存", 3400, "err"); return; }
        if (why === "error") { overlay.flash("保存失败：" + String((out && out.error) || "").slice(0, 60), 3600, "err"); return; }
        if (why === "empty") { return; }
      } catch { /* 落到后面的方式 */ }
    }

    // ① 页面端文件夹（在页面上按 V 授权过的那个）——授权最省事
    if (await ST.noteStore.getFolder()) {
      let res = await ST.noteStore.appendLines(lines, fileName).catch((err) => ({ ok: false, reason: "error", error: String(err && err.message ? err.message : err) }));
      if (res && res.ok) {
        overlay.flash("已存笔记", 1500, "ok");
        util.log("笔记已保存：" + count + " 条（页面文件夹 " + (res.folder || "") + "）");
        return;
      }
      if (res && res.reason === "permission") {
        // 再按一次（这次是紧接着的手势）通常就能授权成功
        res = await ST.noteStore.appendLines(lines, fileName).catch(() => null);
        if (res && res.ok) { overlay.flash("已存笔记", 1500, "ok"); return; }
        overlay.flash("需确认保存位置：按 V 重新授权", 3200, "err");
        return;
      }
      if (res && res.reason === "missing-folder") { overlay.flash("保存位置已失效：按 V 重新选择", 3200, "err"); return; }
      if (res && res.reason === "stale-handle") { overlay.flash("保存位置已失效：按 V 重新选择", 3200, "err"); return; }
      if (res && res.reason === "picker-active") { overlay.flash("已有一个文件夹选择窗口打开，请先处理它", 3400, "err"); return; }
      if (res && res.reason === "duplicate") { overlay.flash("这段已经保存过了", 1800, "err"); return; }
    }

    // ② 扩展面板里设置的文件夹
    try {
      const res = await requestSW(MSG.NOTE_APPEND, { lines }, 20000);
      const reason = res && res.reason;
      if (res && res.ok) { overlay.flash("已存笔记", 1500, "ok"); return; }
      if (reason === "duplicate") { overlay.flash("这段已经保存过了", 1800, "err"); return; }
      if (reason === "permission") { overlay.flash("需确认保存位置：按 V 即可", 3200, "err"); return; }
      if (reason === "missing-folder") { overlay.flash("保存位置已失效：按 V 重新选择", 3200, "err"); return; }
    } catch { /* 落到最后的提示 */ }

    // 完全没设置过 → 直接用这次按键的手势弹出文件夹选择，选完继续保存
    const recovered = await ST.noteStore.ensureFolderInteractively();
    if (recovered && recovered.ok) {
      const res2 = await ST.noteStore.appendLines(lines, fileName).catch((err) => ({ ok: false, reason: "error", error: String(err && err.message ? err.message : err) }));
      if (res2 && res2.ok) { overlay.flash("已存笔记（" + (res2.folder || "") + "）", 1800, "ok"); return; }
      const why = (res2 && res2.reason) || "error";
      if (why === "permission") { overlay.flash("没拿到文件夹写入权限：再按一次 S 或 V", 3000, "err"); return; }
      if (why === "picker-active") { overlay.flash("已有一个文件夹选择窗口打开，请先在里面选好或取消", 3400, "err"); return; }
      if (why === "stale-handle") { overlay.flash("保存位置已失效：按 V 重新选择文件夹", 3200, "err"); return; }
      if (why === "foreign-docx") { overlay.flash("这个 Word 文件不是本工具生成的，换个文件名再存", 3400, "err"); return; }
      if (why === "missing-folder") { overlay.flash("保存位置已失效：按 V 重新选择", 3000, "err"); return; }
      overlay.flash("保存失败：" + String((res2 && res2.error) || why).slice(0, 70), 3600, "err");
      return;
    }
    if (recovered && recovered.reason === "aborted") { overlay.flash("已取消选择保存位置", 1800, "err"); return; }
    if (recovered && recovered.reason === "permission") { overlay.flash("未获得文件夹权限：按 V 再试一次", 2600, "err"); return; }
    overlay.flash("需先设置保存位置：按 V 选择文件夹", 3200, "err");
  }

  /** 按 V：在页面上完成"授权 / 选择保存位置" */
  async function recoverFolder() {
    if (state.host.ok) {
      overlay.flash("请在系统窗口里选择文件夹…", 6000, "ok");
      try {
        const res = await requestSW("st:host-pick-dir", {}, 300000);
        if (res && res.picked) { state.host.dir = res.dir; overlay.flash("保存位置：" + res.dir, 2600, "ok"); return; }
        overlay.flash("已取消选择保存位置", 1800, "err");
        return;
      } catch (err) {
        overlay.flash("选择保存位置失败：" + String(err && err.message ? err.message : err).slice(0, 60), 3200, "err");
        return;
      }
    }
    const res = await ST.noteStore.ensureFolderInteractively();
    if (res && res.ok) { overlay.flash("保存位置已就绪：" + (res.folder || ""), 1800, "ok"); return; }
    const reason = res && res.reason;
    if (reason === "aborted") { overlay.flash("已取消选择保存位置", 1800, "err"); return; }
    if (reason === "picker-active") { overlay.flash("已有一个文件夹选择窗口打开，请先在里面选好或取消", 3400, "err"); return; }
    if (reason === "stale-handle") { overlay.flash("上次的保存位置已失效：请重新选择", 3200, "err"); return; }
    if (reason === "unsupported") { overlay.flash("当前浏览器不支持直接写文件（需要 Chrome/Edge）", 2600, "err"); return; }
    if (reason === "permission") { overlay.flash("未获得文件夹权限：再按一次 V", 2600, "err"); return; }
    overlay.flash("选择保存位置失败：" + String((res && res.error) || "").slice(0, 80), 3200, "err");
  }

  async function changeNoteFile() {
    try {
      await ST.noteStore.forgetFolder();
      state.host.dir = "";
      try { await chrome.storage.local.set({ st_note_dir_abs: "" }); } catch { /* ignore */ }
      overlay.flash("已清空保存位置：按 V 重新选择", 2400, "err");
    } catch (err) {
      util.warn("重置保存位置失败", err);
    }
  }

  /* ------------------------------------------------------------------ settings */

  const HOTKEY_LABELS = { space: "空格", z: "Z", x: "X", e: "E", q: "Q", v: "V" };

  function applySettings(settings) {
    const next = settings.hotkey === undefined ? state.settings.hotkey : String(settings.hotkey || "none").toLowerCase();
    state.settings.hotkey = next;
    if (settings.saveKey !== undefined) state.settings.saveKey = String(settings.saveKey || "none").toLowerCase();
    state.settings.fabVisible = settings.fabVisible !== false;
    overlay.setHotkeyLabel(HOTKEY_LABELS[state.settings.hotkey] || "—");
    overlay.setFabVisible(state.settings.fabVisible && !!state.video);
  }

  /** 问一下后台：本地助手在不在（在的话保存/查看都走系统，不用下载） */
  function refreshHostState() {
    util.guard("本地助手状态", () => requestSW("st:host-status", {}, 15000).then((data) => {
      if (!data) return;
      state.host.ok = !!data.available;
      state.host.dir = data.dir || "";
      if (state.host.ok) util.log("本地助手已就绪：" + (state.host.dir || "未设置保存位置"));
    }));
  }

  function loadSettings() {
    refreshHostState();
    try {
      chrome.storage.local.get([CONFIG.STORAGE_KEYS.HOTKEY, CONFIG.STORAGE_KEYS.SAVE_KEY, CONFIG.STORAGE_KEYS.BUTTON_VISIBLE], (res) => {
        if (chrome.runtime.lastError) { applySettings({}); return; }
        applySettings({
          hotkey: res[CONFIG.STORAGE_KEYS.HOTKEY] === undefined ? "z" : res[CONFIG.STORAGE_KEYS.HOTKEY],
          saveKey: res[CONFIG.STORAGE_KEYS.SAVE_KEY] === undefined ? "s" : res[CONFIG.STORAGE_KEYS.SAVE_KEY],
          fabVisible: res[CONFIG.STORAGE_KEYS.BUTTON_VISIBLE] !== false,
        });
      });
    } catch { applySettings({}); }
  }

  function watchSettings() {
    try {
      chrome.storage.onChanged.addListener((changes, area) => {
        if (area !== "local") return;
        const patch = {};
        if (changes[CONFIG.STORAGE_KEYS.HOTKEY]) patch.hotkey = changes[CONFIG.STORAGE_KEYS.HOTKEY].newValue;
        if (changes[CONFIG.STORAGE_KEYS.SAVE_KEY]) patch.saveKey = changes[CONFIG.STORAGE_KEYS.SAVE_KEY].newValue;
        if (changes[CONFIG.STORAGE_KEYS.BUTTON_VISIBLE]) patch.fabVisible = changes[CONFIG.STORAGE_KEYS.BUTTON_VISIBLE].newValue !== false;
        if (Object.keys(patch).length) applySettings({ ...state.settings, ...patch });
      });
    } catch { /* ignore */ }
  }

  /* ------------------------------------------------------------------ boot */

  function boot() {
    overlay.mount();
    overlay.onFabClick = () => togglePopup("button");
    overlay.onClose = () => util.log("弹窗关闭（按钮）");
    loadSettings();
    watchSettings();

    // one short welcome toast per page load (spec §13)
    setTimeout(() => {
      try {
        const label = HOTKEY_LABELS[state.settings.hotkey] || state.settings.hotkey;
        overlay.toast(
          "<b>双语字幕扩展已就绪</b><br>打开视频后按 <b>" + label + " 键</b>，或点击右下角悬浮按钮，视频字幕位置会显示英中双语字幕。<br>（热键可在扩展图标里更换；空格键保留给播放器）",
          { ms: 5000 }
        );
      } catch (err) { util.warn("欢迎提示显示失败", err); }
    }, 600);

    util.guard("初始模型状态", () => requestSW(MSG.MODEL_STATUS, {}, 15000).then((data) => { if (data) onModelStatus(data); }));

    window.addEventListener("keydown", onKeyDown, true);
    window.addEventListener("yt-navigate-finish", () => setTimeout(onNavigate, 400));
    window.addEventListener("popstate", onNavigate);

    setInterval(watchVideo, 1000);
    setInterval(tick, CONFIG.TICK_MS);
    watchVideo();

    util.log("内容脚本已注入", ST.listAdapters().map((a) => a.id).join(", "));
    // 空闲时预热语音识别模型：第一次下载/初始化在后台完成，用到时不再干等
    setTimeout(() => { util.guard("语音模型预热", () => requestSW("st:asr-preload", {}, 600000)); }, 2500);
    // OCR 引擎预热：YouTube 无软字幕时不用 OCR（避免读广告/浮层），不为它加载 tesseract 抢占内存
    if (!ST.platformOf || ST.platformOf(location) !== "youtube") {
      setTimeout(() => {
        util.guard("OCR 引擎预热", () => requestSW("st:ocr-test", {
          dataUrl: "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
        }, 120000));
      }, 3000);
    }
  }

  function onNavigate() {
    if (location.href === state.lastHref) return;
    state.lastHref = location.href;
    util.log("页面地址变化，重新解析字幕", location.href);
    const v = findVideo();
    if (!v) { detachVideo(); return; }
    attachVideo(v);
  }

  function watchVideo() {
    if (location.href !== state.lastHref) onNavigate();
    const v = findVideo();
    if (v !== state.video) {
      if (v) attachVideo(v);
      else detachVideo();
      return;
    }
    if (state.video) {
      // 实时字幕采样意外停止（如扩展更新、页面挂起）时自愈
      if (state.resolve.state === "ok" && state.liveKind && !state.liveTimer) {
        util.log("实时字幕采样已重启");
        startLiveSampler(state.liveKind);
      }
      overlay.setFabVisible(state.settings.fabVisible);
      if (state.resolve.state === "error" && !state.resolving && !state.retryTimer && state.resolve.attempts < 5) scheduleRetry();
    }
  }

  util.guard("boot", boot);
})();
