// Adapter registry. Every adapter returns the SAME shape: [{start, end, text}] (seconds, string).
(() => {
  const ST = (globalThis.ST = globalThis.ST || {});

  const registry = [];

  ST.registerAdapter = function registerAdapter(adapter) {
    if (!adapter || typeof adapter.getSubtitles !== "function") {
      throw new Error("adapter 必须实现 getSubtitles(ctx)");
    }
    registry.push({
      id: adapter.id || `adapter-${registry.length + 1}`,
      label: adapter.label || adapter.id || "adapter",
      priority: Number.isFinite(adapter.priority) ? adapter.priority : 0,
      match: typeof adapter.match === "function" ? adapter.match : () => true,
      getSubtitles: adapter.getSubtitles,
    });
    return adapter.id;
  };

  ST.listAdapters = () => registry.slice();

  /** test hook: drop every registered adapter */
  ST.clearAdapters = () => { registry.length = 0; };

  /** adapters whose match() accepts this location, highest priority first */
  ST.candidatesFor = function candidatesFor(location) {
    const result = [];
    for (const a of registry) {
      try {
        if (a.match(location)) result.push(a);
      } catch (err) {
        ST.util?.warn(`适配器 ${a.id} 的 match() 抛错，已忽略`, err);
      }
    }
    return result.sort((x, y) => y.priority - x.priority);
  };
})();