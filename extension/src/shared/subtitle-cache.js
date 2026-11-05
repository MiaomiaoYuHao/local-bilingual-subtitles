// Rolling window of subtitle lines: the current line + (WINDOW_SIZE - 1) previous lines.
(() => {
  const ST = (globalThis.ST = globalThis.ST || {});

  class SubtitleCache {
    constructor(windowSize) {
      this.windowSize = windowSize || 5;
      this.cues = [];
      this.currentIndex = -1;
      this.history = [];
      this.lastTime = null;
      this.version = 0;
      this.meta = null;
    }

    /** Replace the cue list (new video / adapter re-resolved). */
    load(cues, meta) {
      this.cues = Array.isArray(cues) ? cues.slice().sort((a, b) => a.start - b.start) : [];
      this.meta = meta || null;
      this.currentIndex = -1;
      this.history = [];
      this.lastTime = null;
      this.version++;
    }

    clear() { this.load([], null); }

    /** index of the last cue whose start is <= t, or -1 */
    findIndexAt(t) {
      const cues = this.cues;
      let lo = 0, hi = cues.length - 1, ans = -1;
      while (lo <= hi) {
        const mid = (lo + hi) >> 1;
        if (cues[mid].start <= t) { ans = mid; lo = mid + 1; } else { hi = mid - 1; }
      }
      return ans;
    }

    /** fill history with up to windowSize-1 cues preceding idx (used when the window opens mid-video) */
    primeHistory(idx) {
      const from = Math.max(0, idx - (this.windowSize - 1));
      this.history = [];
      for (let i = from; i < idx; i++) this.history.push(i);
    }

    /**
     * Advance to time t.
     * @returns {{changed: boolean, seeked: boolean, entry: object|null}}
     */
    update(t) {
      if (!Number.isFinite(t)) return { changed: false, seeked: false, entry: null };
      const prev = this.lastTime;
      const seeked =
        prev !== null &&
        (Math.abs(t - prev) > (ST.CONFIG ? ST.CONFIG.SEEK_THRESHOLD : 3) || t < prev - 0.5);
      this.lastTime = t;

      const idx = this.findIndexAt(t);

      if (seeked) {
        this.currentIndex = idx;
        if (idx >= 0) this.primeHistory(idx); else this.history = [];
        this.version++;
        return { changed: true, seeked: true, entry: this.entryFor(idx) };
      }

      if (idx !== this.currentIndex) {
        if (idx >= 0) {
          if (this.currentIndex >= 0 && this.history[this.history.length - 1] !== this.currentIndex) {
            this.history.push(this.currentIndex);
          } else if (this.currentIndex < 0) {
            this.primeHistory(idx);
          }
          const max = this.windowSize - 1;
          if (this.history.length > max) this.history = this.history.slice(this.history.length - max);
        } else {
          this.history = [];
        }
        this.currentIndex = idx;
        this.version++;
        return { changed: true, seeked: false, entry: this.entryFor(idx) };
      }
      return { changed: false, seeked: false, entry: this.entryFor(idx) };
    }

    /**
     * Add one line observed live (no playlist available, e.g. reading the player's own captions).
     * Returns true when a new line was added.
     */
    appendLive(cue) {
      if (!cue || !cue.text) return false;
      const text = String(cue.text).trim();
      if (!text) return false;
      const last = this.cues[this.cues.length - 1];
      if (last && last.text === text) {
        last.end = Math.max(last.end, Number(cue.end) || last.end);
        return false;
      }
      this.cues.push({ start: Number(cue.start) || 0, end: Number(cue.end) || (Number(cue.start) || 0) + 4, text });
      const idx = this.cues.length - 1;
      if (this.currentIndex >= 0 && this.history[this.history.length - 1] !== this.currentIndex) this.history.push(this.currentIndex);
      else if (this.currentIndex < 0) this.primeHistory(idx);
      const max = this.windowSize - 1;
      if (this.history.length > max) this.history = this.history.slice(this.history.length - max);
      this.currentIndex = idx;
      this.lastTime = Number(cue.start) || null;
      this.version++;
      return true;
    }

    /**
     * 实时字幕：同一编号的句子就地更新（还没说完时文本会变长），说了新的句子才新起一条。
     * @returns {"add"|"update"|"none"}
     */
    upsertLive(unit) {
      if (!unit || !unit.text) return "none";
      const text = String(unit.text).trim();
      if (!text) return "none";
      const end = Number(unit.end) || (Number(unit.start) || 0) + 4;
      const last = this.cues[this.cues.length - 1];
      const canMerge = last && unit.key && last.key === unit.key;
      if (canMerge) {
        if (last.text === text && (last.done !== false) === (unit.done !== false)) {
          last.end = Math.max(last.end, end);
          return "none";
        }
        last.text = text;
        last.end = Math.max(last.end, end);
        last.done = unit.done !== false;
        if (unit.source) last.source = unit.source;
        this.lastTime = Number(unit.start) || this.lastTime;
        this.version++;
        return "update";
      }
      this.cues.push({
        key: unit.key || null,
        start: Number(unit.start) || 0,
        end,
        text,
        done: unit.done !== false,
        source: unit.source || null,
      });
      const idx = this.cues.length - 1;
      if (this.currentIndex >= 0 && this.history[this.history.length - 1] !== this.currentIndex) this.history.push(this.currentIndex);
      else if (this.currentIndex < 0) this.primeHistory(idx);
      const max = this.windowSize - 1;
      if (this.history.length > max) this.history = this.history.slice(this.history.length - max);
      this.currentIndex = idx;
      this.lastTime = Number(unit.start) || this.lastTime;
      this.version++;
      return "add";
    }

    /** Remove cues matching a predicate (used when an OCR probe is rejected). */
    removeWhere(pred) {
      const before = this.cues.length;
      this.cues = this.cues.filter((c) => !pred(c));
      if (this.currentIndex >= this.cues.length) this.currentIndex = this.cues.length - 1;
      this.history = [];
      if (this.cues.length !== before) this.version++;
      return before - this.cues.length;
    }

    entryFor(idx) {
      if (idx < 0 || idx >= this.cues.length) return null;
      const c = this.cues[idx];
      return { index: idx, start: c.start, end: c.end, text: c.text, done: c.done !== false, source: c.source || null, isCurrent: true };
    }

    /** Window contents, oldest -> newest, at most windowSize entries. */
    entries() {
      const out = [];
      const seen = new Set();
      const seenText = new Set();
      const norm = (t) => String(t || "").replace(/\s+/g, " ").trim().toLowerCase();
      const push = (idx, isCurrent) => {
        if (idx < 0 || idx >= this.cues.length || seen.has(idx)) return;
        seen.add(idx);
        const c = this.cues[idx];
        // 同文本只保留最新的一条（如广告/重播/滚动字幕导致的重复）
        const key = norm(c.text);
        if (key && seenText.has(key)) return;
        if (key) seenText.add(key);
        out.push({ index: idx, start: c.start, end: c.end, text: c.text, done: c.done !== false, source: c.source || null, isCurrent });
      };
      push(this.currentIndex, true);              // 先放当前行，保证它一定在
      for (let i = this.history.length - 1; i >= 0; i--) push(this.history[i], false);  // 历史从新到旧
      out.sort((a, b) => a.start - b.start);
      // 当前行始终视为最新
      for (const e of out) e.isCurrent = e.index === this.currentIndex;
      if (out.length > this.windowSize) {
        const cur = out.find((e) => e.isCurrent);
        out.splice(0, out.length - this.windowSize);
        if (cur && !out.includes(cur)) { out.shift(); out.push(cur); out.sort((a, b) => a.start - b.start); }
      }
      return out;
    }

    get size() { return this.entries().length; }
  }

  ST.SubtitleCache = SubtitleCache;
})();