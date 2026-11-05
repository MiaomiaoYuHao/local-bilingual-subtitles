// Bilibili adapter: /x/web-interface/view (aid/cid) -> /x/player/v2 (subtitle list) -> subtitle json.
(() => {
  const ST = (globalThis.ST = globalThis.ST || {});

  function idsFrom(location) {
    const url = new URL(location.href);
    const m = url.pathname.match(/\/video\/(BV[0-9A-Za-z]+|av\d+)/i);
    return {
      bvid: m && /^BV/i.test(m[1]) ? m[1] : null,
      aid: m && /^av/i.test(m[1]) ? m[1].slice(2) : null,
      page: Number(url.searchParams.get("p") || 1) || 1,
    };
  }

  ST.readBilibiliDomCaption = function readBilibiliDomCaption() {
    const selectors = [
      ".bpx-player-subtitle-wrap",
      ".bili-subtitle-x-subtitle-panel-major-group",
      ".bpx-player-subtitle-panel .bpx-player-ctrl-subtitle-text",
      ".bpx-player-subtitle-panel-text",
      ".bilibili-player-video-subtitle",
    ];
    const ui = /^(字幕|关闭|添加字幕|中文|英文|自动生成|翻译)$/;
    for (const sel of selectors) {
      const nodes = document.querySelectorAll(sel);
      if (!nodes.length) continue;
      const parts = [];
      const seen = new Set();
      for (const n of nodes) {
        const t = (n.textContent || "").replace(/\s+/g, " ").trim();
        if (!t || ui.test(t) || seen.has(t)) continue;
        seen.add(t);
        parts.push(t);
      }
      if (parts.length) return parts.join(" ").trim();
    }
    return null;
  };

  async function waitForDomCaption(ms) {
    const end = Date.now() + (Number(ms) || 6000);
    while (Date.now() < end) {
      const text = ST.readBilibiliDomCaption();
      if (text && (!ST.util || !ST.util.isLikelyEnglish || ST.util.isLikelyEnglish(text))) return text;
      await new Promise((r) => setTimeout(r, 300));
    }
    return ST.readBilibiliDomCaption();
  }

  ST.registerAdapter({
    id: "bilibili",
    label: "B站适配器",
    priority: 20,
    match(location) {
      const h = String(location.hostname || "");
      return /(^|\.)bilibili\.com$/.test(h);
    },
    async getSubtitles(ctx) {
      const ids = idsFrom(ctx.location);
      const errors = [];
      try {
        const res = await ctx.requestSW(ST.MSG.GET_SUBTITLES, { adapter: "bilibili", ...ids, pageUrl: ctx.location.href }, 6000);
        if (res && res.cues && res.cues.length) {
          return { cues: res.cues, meta: { source: res.source || "player-v2", track: res.track || null, ...ids } };
        }
        if (res && res.reason) errors.push(res.reason);
      } catch (err) {
        errors.push(`接口获取失败: ${err && err.message ? err.message : err}`);
      }

      const dom = ST.readDomCues ? ST.readDomCues(ctx.video, { preferEnglish: true }) : null;
      if (dom && dom.cues.length) {
        const sample = dom.cues.slice(0, 6).map((c) => c.text).join(" ");
        if (!ST.util || !ST.util.isLikelyEnglish || ST.util.isLikelyEnglish(sample)) {
          return { cues: dom.cues, meta: { source: "dom-texttrack", ...ids } };
        }
        errors.push("页面字幕轨不是英文");
      }

      const liveText = await waitForDomCaption(12000);
      if (liveText && (!ST.util || !ST.util.isLikelyEnglish || ST.util.isLikelyEnglish(liveText))) {
        return { cues: [], live: "bilibili-dom-caption", meta: { source: "player-dom-caption", ...ids, sample: liveText } };
      }
      if (liveText) errors.push("画面上的字幕不是英文");

      throw new ST.AdapterError(`B站: 未找到字幕（${errors.join("；") || "该视频可能没有 CC 字幕，或需要登录"}）`);
    },
  });
})();