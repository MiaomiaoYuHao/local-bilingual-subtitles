// Adapter router: picks adapters by hostname, tries them in order, never lets one failure
// take down the whole extension (spec §11).
(() => {
  const ST = (globalThis.ST = globalThis.ST || {});

  class Router {
    constructor(ctx, hooks) {
      this.ctx = ctx;
      this.hooks = hooks || {};
      this.activeAdapter = null;
      this.lastResult = null;
      this.lastErrors = [];
      this.resolving = false;
    }

    candidates() {
      try {
        return ST.candidatesFor(this.ctx.location);
      } catch (err) {
        (this.hooks.onError || ST.util.warn)("适配器筛选失败", err);
        return [];
      }
    }

    /** One resolution pass over every matching adapter. Throws only if all of them fail. */
    async resolveOnce() {
      if (this.resolving) return null;
      this.resolving = true;
      const errors = [];
      try {
        const candidates = this.candidates();
        if (!candidates.length) {
          const err = new ST.AdapterError("没有匹配当前网站的适配器");
          this.lastErrors = [{ adapter: "router", message: err.message }];
          throw err;
        }
        for (const adapter of candidates) {
          try {
            const raw = await adapter.getSubtitles(this.ctx);
            const cues = this.normalize(raw);
            const live = (raw && raw.live) || null;
            if (!cues.length && !live) {
              errors.push({ adapter: adapter.id, message: "字幕列表为空" });
              if (this.hooks.onAdapterError) this.hooks.onAdapterError(adapter, new ST.AdapterError("字幕列表为空"));
              continue;
            }
            const result = {
              adapter,
              cues,
              live,
              meta: (raw && raw.meta) || null,
              errors: errors.slice(),
            };
            this.activeAdapter = adapter;
            this.lastResult = result;
            this.lastErrors = errors.slice();
            if (this.hooks.onResolved) this.hooks.onResolved(result);
            return result;
          } catch (err) {
            const info = { adapter: adapter.id, message: err && err.message ? err.message : String(err) };
            errors.push(info);
            if (this.hooks.onAdapterError) this.hooks.onAdapterError(adapter, err);
            ST.util.warn(`适配器 ${adapter.id} 获取字幕失败，尝试下一个：${info.message}`);
          }
        }
        const finalErr = new ST.AdapterError("所有适配器都未能获取字幕", { errors });
        this.lastErrors = errors.slice();
        throw finalErr;
      } finally {
        this.resolving = false;
      }
    }

    /** Adapters may return either a cue array or {cues, meta}. */
    normalize(raw) {
      const cues = Array.isArray(raw) ? raw : raw && Array.isArray(raw.cues) ? raw.cues : [];
      const clean = [];
      for (const c of cues) {
        if (!c) continue;
        const text = String(c.text == null ? "" : c.text).trim();
        const start = Number(c.start);
        let end = Number(c.end);
        if (!text || !Number.isFinite(start)) continue;
        if (!Number.isFinite(end) || end <= start) end = start + 1.5;
        clean.push({ start, end, text });
      }
      clean.sort((a, b) => a.start - b.start);
      return clean;
    }
  }

  ST.Router = Router;
})();