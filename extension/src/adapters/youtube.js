// YouTube adapter.
//
// YouTube now answers /api/timedtext with an empty 200 unless the request carries the player's
// own proof-of-origin token, so the adapter tries, in order:
//   1. caption payloads captured from the player itself (yt-main-hook.js, MAIN world)
//   2. an own timedtext fetch (still works in some regions/players)
//   3. real TextTrack objects the player already populated
//   4. live captions rendered by the player into its own caption window (needs CC switched on)
(() => {
  const ST = (globalThis.ST = globalThis.ST || {});
  const captured = [];
  const MAX_KEEP = 8;

  /** 从 timedtext 地址里认出这条数据属于哪个视频（可能拿不到） */
  function captionVideoId(u) {
    try {
      const url = new URL(String(u || ""), location.href);
      const v = url.searchParams.get("v");
      if (v) return v;
      const m = url.pathname.match(/\/(?:shorts|embed|live|v)\/([A-Za-z0-9_-]{6,})/);
      return m ? m[1] : null;
    } catch { return null; }
  }

  document.addEventListener("st:yt-timedtext", (event) => {
    try {
      const data = JSON.parse(event.detail);
      if (!data || !data.body) return;
      captured.push({ url: data.url, body: data.body, videoId: captionVideoId(data.url), at: data.at || Date.now() });
      while (captured.length > MAX_KEEP) captured.shift();
      ST.util.log(`捕获播放器字幕数据 ${data.body.length} 字节，开头：${JSON.stringify(String(data.body).slice(0, 90))}`);
      if (typeof ST.onYtCaptured === "function") ST.onYtCaptured(data);
    } catch (err) {
      ST.util.warn("播放器字幕事件解析失败", err);
    }
  });

  function videoIdFrom(location) {
    const url = new URL(location.href);
    const v = url.searchParams.get("v");
    if (v) return v;
    const m = url.pathname.match(/\/(shorts|embed|live|v)\/([A-Za-z0-9_-]{6,})/);
    return m ? m[2] : null;
  }

  const HINT = /(点击|click).{0,6}(查看|view).{0,6}(设置|settings)|^(英语|中文|English|Chinese)[\s·]*$/i;
  // 播放器字幕窗口里的"界面提示"（不是台词）：整行丢弃
  const UI_HINT = /(查看设置|点击.{0,6}设置|字幕设置|自动翻译|自动生成.*设置|点击.{0,4}查看)/;

  /** Text the player is currently rendering as captions (CC must be on). */
  function readDomCaption() {
    const scoped = document.querySelectorAll(".ytp-caption-window-container .ytp-caption-segment");
    const nodes = scoped.length ? scoped : document.querySelectorAll(".ytp-caption-segment");
    if (!nodes.length) return null;
    const parts = [];
    for (const n of nodes) {
      if (n.offsetHeight === 0 && n.offsetWidth === 0) continue;
      const t = (n.textContent || "").replace(/\s+/g, " ").trim();
      if (!t || HINT.test(t)) continue;
      parts.push(t);
    }
    const text = parts.join(" ").replace(/\s{2,}/g, " ").trim();
    if (!text || UI_HINT.test(text)) return null;
    return text;
  }

  ST.matchesYoutubeUrl = (location) => {
    const h = String(location.hostname || "");
    return /(^|\.)youtube\.com$/.test(h) || /(^|\.)youtube-nocookie\.com$/.test(h);
  };

  ST.registerAdapter({
    id: "youtube",
    label: "YouTube 适配器",
    priority: 30,
    match(location) { return ST.matchesYoutubeUrl(location); },

    async getSubtitles(ctx) {
      const videoId = videoIdFrom(ctx.location);
      const errors = [];

      // 换视频了：先把上一条视频捕获到的字幕数据扔掉，否则会继续播旧字幕
      for (let i = captured.length - 1; i >= 0; i--) {
        const c = captured[i];
        if (c && c.videoId && videoId && c.videoId !== videoId) captured.splice(i, 1);
      }

      // 1) captured player payload
      if (captured.length) {
        try {
          const res = await ctx.requestSW(ST.MSG.GET_SUBTITLES, {
            adapter: "youtube",
            videoId,
            pageUrl: ctx.location.href,
            captured: captured.map((c) => c.body),
          }, 6000);
          if (res && res.cues && res.cues.length) {
            return { cues: res.cues, meta: { source: res.source || "player-capture", videoId, track: res.track || null } };
          }
          if (res && res.reason) errors.push(res.reason);
        } catch (err) {
          errors.push(`播放器字幕数据解析失败: ${err && err.message ? err.message : err}`);
        }
      }

      // 2) own timedtext fetch
      try {
        const res = await ctx.requestSW(ST.MSG.GET_SUBTITLES, {
          adapter: "youtube",
          videoId,
          pageUrl: ctx.location.href,
          transport: "json3",
        }, 6000);
        if (res && res.cues && res.cues.length) {
          return { cues: res.cues, meta: { source: "timedtext-json3", videoId, track: res.track || null } };
        }
        if (res && res.reason) errors.push(res.reason);
      } catch (err) {
        errors.push(`timedtext 获取失败: ${err && err.message ? err.message : err}`);
      }

      // 3) TextTrack objects that are already populated
      const dom = ST.readDomCues ? ST.readDomCues(ctx.video, { preferEnglish: true }) : null;
      if (dom && dom.cues.length) return { cues: dom.cues, meta: { source: "dom-texttrack", videoId } };

      // 4) live captions rendered by the player (the user's own CC switch, nothing is modified)
      const liveText = readDomCaption();
      return {
        cues: [],
        live: "youtube-dom-caption",
        meta: { source: "player-dom-caption", videoId, sample: liveText, errors },
      };
    },
  });

  ST.readYoutubeDomCaption = readDomCaption;
})();