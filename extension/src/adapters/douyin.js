// 抖音适配器：先找官方软字幕；找不到就明确告诉上层"这条视频需要 OCR / 语音识别"
(() => {
  const ST = (globalThis.ST = globalThis.ST || {});
  const UI_HINT = /(打开字幕|自动字幕|点击.{0,6}设置|查看设置|字幕设置)/;

  function readDomCaption() {
    const nodes = document.querySelectorAll(
      ".xg-caption [class*='text'], [class*='caption'] [class*='text'], [data-e2e='video-caption'], .xgplayer-caption"
    );
    const parts = [];
    for (const n of nodes) {
      if (n.offsetHeight === 0 && n.offsetWidth === 0) continue;
      const t = (n.textContent || "").replace(/\s+/g, " ").trim();
      if (!t || UI_HINT.test(t)) continue;
      parts.push(t);
    }
    const text = parts.join(" ").replace(/\s{2,}/g, " ").trim();
    return text || null;
  }
  ST.readDouyinDomCaption = readDomCaption;

  /** 从页面数据/performance 里找真正的视频流 URL（MSE blob 视频用）。 */
  function collectVideoUrls() {
    const urls = new Set();
    const add = (u) => {
      if (typeof u !== "string" || !/^https?:/.test(u)) return;
      if (/download\/douyin_pc_client\.mp4/i.test(u)) return;
      if (!/(media-video|mime_type=video_mp4|\.mp4|video\/tos|douyinvod)/i.test(u)) return;
      urls.add(u);
    };
    const walk = (node, depth) => {
      if (!node || depth > 10) return;
      if (Array.isArray(node)) { for (const x of node) walk(x, depth + 1); return; }
      if (typeof node !== "object") return;
      for (const [k, v] of Object.entries(node)) {
        if (typeof v === "string" && /(mp4|video\/tos|douyinvod|mime_type|media-video)/i.test(k + v)) add(v);
        else walk(v, depth + 1);
      }
    };
    for (const key of ["__INITIAL_SSR_STATE__", "_SSR_DATA", "__RENDER_DATA__", "RENDER_DATA"]) {
      try { walk(globalThis[key], 0); } catch { /* ignore */ }
    }
    try { for (const e of performance.getEntriesByType("resource")) add(e.name); } catch { /* ignore */ }
    const v = document.querySelector("video");
    if (v && /^https?:/.test(v.currentSrc || "")) add(v.currentSrc);
    return [...urls];
  }

  function getVideoUrl() {
    const urls = collectVideoUrls();
    return urls.find((u) => /media-video/i.test(u)) || urls.find((u) => /mime_type=video_mp4|\.mp4/i.test(u)) || "";
  }
  ST.getDouyinVideoUrl = getVideoUrl;

  function collectAudioUrls() {
    const urls = new Set();
    const add = (u) => {
      if (typeof u !== "string" || !/^https?:/.test(u)) return;
      if (!/(media-audio|mime_type=audio_mp4|\.m4a)/i.test(u)) return;
      urls.add(u);
    };
    try { for (const e of performance.getEntriesByType("resource")) add(e.name); } catch { /* ignore */ }
    return [...urls];
  }
  function getAudioUrl() {
    const urls = collectAudioUrls();
    return urls.find((u) => /media-audio/i.test(u)) || "";
  }
  ST.getDouyinAudioUrl = getAudioUrl;

  /** 页面数据里可能带官方字幕地址（抖音不同版本字段不一样，逐个试探） */
  function collectSubtitleUrls() {
    const urls = new Set();
    const add = (u) => {
      if (typeof u !== "string" || !/^https?:|^\/\//.test(u)) return;
      if (!/subtitle|caption|\.vtt|\.srt|clit|imsdk/i.test(u)) return;
      urls.add(u.startsWith("//") ? "https:" + u : u);
    };
    const walk = (node, depth) => {
      if (!node || depth > 8) return;
      if (Array.isArray(node)) { for (const x of node) walk(x, depth + 1); return; }
      if (typeof node !== "object") return;
      for (const [k, v] of Object.entries(node)) {
        if (typeof v === "string" && /subtitle|caption|vtt|srt/i.test(k)) add(v);
        else walk(v, depth + 1);
      }
    };
    for (const key of ["__INITIAL_SSR_STATE__", "_SSR_DATA", "__RENDER_DATA__", "RENDER_DATA"]) {
      try { walk(globalThis[key], 0); } catch { /* ignore */ }
    }
    return [...urls].slice(0, 4);
  }

  ST.registerAdapter({
    id: "douyin",
    label: "抖音适配器",
    priority: 25,
    match(location) { return /(^|\.)douyin\.com$|(^|\.)iesdouyin\.com$/.test(String(location.hostname || "")); },

    async getSubtitles(ctx) {
      const errors = [];
      // ① 播放器正在渲染的字幕（用户自己打开了字幕）
      const live = readDomCaption();
      if (live) return { cues: [], live: "douyin-dom-caption", meta: { source: "player-caption", platform: "douyin" } };

      // ② 页面数据里的官方字幕地址
      for (const url of collectSubtitleUrls()) {
        try {
          const res = await ctx.requestSW(ST.MSG.GET_SUBTITLES, { adapter: "generic-track", src: url, pageUrl: ctx.location.href }, 6000);
          if (res && res.cues && res.cues.length) {
            return { cues: res.cues, meta: { source: "official-subtitle", platform: "douyin", url } };
          }
          if (res && res.reason) errors.push(String(res.reason).slice(0, 80));
        } catch (err) {
          errors.push(String(err && err.message ? err.message : err).slice(0, 80));
        }
      }

      // ③ 画面 OCR / 语音 ASR 由内容脚本的来源管线继续兜底；
      // 这里只负责平台官方软字幕，避免把"没有软字幕"误报成"识别失败"。

      const err = new ST.AdapterError("这条抖音视频没有官方软字幕，继续尝试画面字幕/语音识别", { errors });
      throw err;
    },
  });
})();
