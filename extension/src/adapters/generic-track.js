// Generic adapter for any page that exposes soft subtitles through HTML <track> / TextTrack.
(() => {
  const ST = (globalThis.ST = globalThis.ST || {});

  function scoreTrack(track) {
    const kind = String(track.kind || "subtitles").toLowerCase();
    const lang = String(track.srclang || track.language || "").toLowerCase();
    const label = String(track.label || "").toLowerCase();
    let s = 0;
    if (kind === "subtitles") s -= 3;
    if (kind === "captions") s -= 2;
    if (kind !== "subtitles" && kind !== "captions") s += 10;
    if (lang.startsWith("en")) s -= 5;
    if (/english|英文|英語/.test(label)) s -= 4;
    if (track.default) s -= 1;
    return s;
  }

  function collectTrackElements(video) {
    const out = [];
    const seen = new Set();
    const push = (t) => { if (t && !seen.has(t)) { seen.add(t); out.push(t); } };
    if (video && video.querySelectorAll) {
      for (const t of video.querySelectorAll("track")) push(t);
    }
    if (typeof document !== "undefined") {
      for (const t of document.querySelectorAll("track")) push(t);
    }
    return out.sort((a, b) => scoreTrack(a) - scoreTrack(b));
  }

  function cuesFromCueList(cueList) {
    const cues = [];
    if (!cueList) return cues;
    for (let i = 0; i < cueList.length; i++) {
      const c = cueList[i];
      if (!c) continue;
      if (c.cueTime !== undefined) continue; // ignore script-only cues
      const text = String(c.text || "").replace(/<[^>]*>/g, " ").replace(/\s{2,}/g, " ").trim();
      if (!text) continue;
      cues.push({ start: Number(c.startTime), end: Number(c.endTime), text });
    }
    return cues.sort((a, b) => a.start - b.start);
  }

  /** Read cues that the page already loaded into TextTrack objects (sync, no player mutation). */
  ST.readDomCues = function readDomCues(video, opts) {
    const preferEnglish = !opts || opts.preferEnglish !== false;
    const candidates = [];
    for (const t of collectTrackElements(video)) candidates.push(t.track);
    if (video && video.textTracks) {
      for (const t of video.textTracks) candidates.push(t);
    }
    const withCues = candidates.filter((t) => t && t.cues && t.cues.length);
    if (!withCues.length) return null;
    withCues.sort((a, b) => {
      const sa = (preferEnglish && String(a.language || "").toLowerCase().startsWith("en") ? -5 : 0) + String(a.kind || "");
      const sb = (preferEnglish && String(b.language || "").toLowerCase().startsWith("en") ? -5 : 0) + String(b.kind || "");
      return sa < sb ? -1 : sa > sb ? 1 : 0;
    });
    const best = withCues[0];
    return {
      cues: cuesFromCueList(best.cues),
      track: { language: best.language, kind: best.kind, label: best.label, mode: best.mode },
    };
  };

  /** Force a disabled track to load so we can read its cues, then restore the original mode. */
  async function cuesByTemporarilyHidden(trackEl, timeoutMs) {
    const t = trackEl.track;
    if (!t) return [];
    if (t.cues && t.cues.length) return cuesFromCueList(t.cues);
    const original = t.mode;
    const loaded = new Promise((resolve) => {
      const onLoad = () => resolve(true);
      trackEl.addEventListener("load", onLoad, { once: true });
      setTimeout(() => resolve(false), timeoutMs || 4000);
    });
    try {
      t.mode = "hidden"; // loads cues without drawing the native caption UI
      await loaded;
      return cuesFromCueList(t.cues);
    } finally {
      try { t.mode = original === "showing" ? "showing" : "disabled"; } catch { /* ignore */ }
    }
  }

  ST.registerAdapter({
    id: "generic-track",
    label: "通用 <track> 适配器",
    priority: 10,
    match() { return true; },
    async getSubtitles(ctx) {
      const errors = [];
      const elements = collectTrackElements(ctx.video);
      const textTracks = [];
      if (ctx.video && ctx.video.textTracks) {
        for (const t of ctx.video.textTracks) textTracks.push(t);
      }
      if (!elements.length && !textTracks.length) {
        throw new ST.AdapterError("通用适配器: 页面没有 <track> 字幕元素");
      }

      // 1) already-loaded TextTrack objects
      const dom = ST.readDomCues(ctx.video, { preferEnglish: false });
      if (dom && dom.cues.length) {
        return { cues: dom.cues, meta: { source: "texttrack-object", track: dom.track } };
      }

      // 2) network tracks: fetch + parse in the service worker (no page CSP involvement)
      for (const el of elements) {
        const src = el.getAttribute("src") || el.src || "";
        if (!/^https?:/i.test(src)) continue;
        try {
          const res = await ctx.requestSW(ST.MSG.GET_SUBTITLES, {
            adapter: "track",
            src,
            kind: el.getAttribute("kind") || "",
            srclang: el.getAttribute("srclang") || "",
            pageUrl: ctx.location.href,
          }, 6000);
          if (res && res.cues && res.cues.length) {
            return {
              cues: res.cues,
              meta: { source: "track-src", src, format: res.format || "vtt" },
            };
          }
          if (res && res.reason) errors.push(`${src}: ${res.reason}`);
        } catch (err) {
          errors.push(`${src}: ${err && err.message ? err.message : err}`);
        }
      }

      // 3) blob:/data: tracks - make the player load them, then read the cues back
      for (const el of elements) {
        try {
          const cues = await cuesByTemporarilyHidden(el, 4000);
          if (cues.length) {
            return {
              cues,
              meta: { source: "texttrack-hidden", src: el.getAttribute("src") || "" },
            };
          }
        } catch (err) {
          errors.push(`texttrack: ${err && err.message ? err.message : err}`);
        }
      }

      throw new ST.AdapterError(`通用适配器: 未能解析出字幕（${errors.join("；") || "轨道为空"}）`);
    },
  });
})();