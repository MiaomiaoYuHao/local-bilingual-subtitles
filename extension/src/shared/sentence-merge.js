// 把播放器拆碎的 cue 拼回"整句"：翻译按整句走，屏幕上也是整句。
// 两处用法：
//   ① 已经拿到完整字幕列表（timedtext/json3/track）→ mergeCuesIntoSentences() 一次性合并
//   ② 实时读播放器字幕（DOM）→ new SentenceMerger() 边听边拼，收句时回调 commit
(() => {
  const ST = (globalThis.ST = globalThis.ST || {});

  const DEFAULT_OPTS = {
    maxChars: 110,      // 一句话最长多少字符（没标点的自动字幕靠它兜底收句）
    gapMs: 1500,        // 两句之间停顿超过这个时间 → 认为上句说完了
    capMinChars: 40,    // 已有这么长，且新片段以大写字母开头 → 认为新句子开始
  };

  const norm = (t) => String(t == null ? "" : t).replace(/\s+/g, " ").trim();
  const words = (t) => norm(t).split(" ").filter(Boolean);
  const bare = (w) => String(w || "").toLowerCase().replace(/[^0-9a-z\u4e00-\u9fff']/g, "");
  const END_PUNCT = /[.!?…。！？][\]\)"'\u201d\u2019]*$/;
  const endsSentence = (t) => END_PUNCT.test(norm(t));
  const startsUpper = (t) => /^["'(]*[A-Z]/.test(norm(t));

  /** 新片段与已有文本的关系：{replace} 整段替换 | {append} 追加 | null 重复（不用动） */
  function overlap(buf, frag) {
    const b = norm(buf);
    const f = norm(frag);
    if (!f) return null;
    if (!b) return { replace: f };
    if (f === b) return null;
    if (b.startsWith(f)) return null;              // 显示回退/重复
    if (f.startsWith(b)) return { replace: f };    // 滚动字幕：越滚越长，整段替换
    if (b.endsWith(f)) return null;                // 新片段是旧文本的尾巴：重复
    const bw = words(b);
    const fw = words(f);
    const maxK = Math.min(bw.length, fw.length);
    for (let k = maxK; k > 0; k--) {
      let same = true;
      for (let i = 0; i < k; i++) {
        const a = bare(bw[bw.length - k + i]);
        const c = bare(fw[i]);
        if (!a || a !== c) { same = false; break; }
      }
      if (same) return { append: fw.slice(k).join(" "), overlap: true };   // 滚动窗口：只补新词
    }
    // ASR 重叠窗口可能从旧文本的中段开始：找 buf 的后缀在 frag 中间出现的位置，裁掉重复前缀。
    for (let k = Math.min(8, maxK); k >= 3; k--) {
      const maxStart = Math.min(4, fw.length - k);
      for (let start = 1; start <= maxStart; start++) {
        let same = true;
        for (let i = 0; i < k; i++) {
          const a = bare(bw[bw.length - k + i]);
          const c = bare(fw[start + i]);
          if (!a || a !== c) { same = false; break; }
        }
        if (same) {
          const rest = fw.slice(start + k).join(" ");
          if (rest) return { append: rest, overlap: true };
        }
      }
    }
    return { append: f, overlap: false };           // 真正的新内容（被拆开的半句/下一句）
  }

  function joinText(a, b) {
    const x = norm(a);
    const y = norm(b);
    if (!x) return y;
    if (!y) return x;
    return x + " " + y;
  }

  class SentenceMerger {
    constructor(opts) {
      this.opts = Object.assign({}, DEFAULT_OPTS, opts || {});
      this.seq = 0;
      this.buf = null;
    }

    reset() { this.buf = null; }

    get pending() { return this.buf ? this.buf.text : null; }

    /** @returns {Array<{type:"partial"|"commit", unit:object}>} */
    push(cue) {
      const text = norm(cue && cue.text);
      if (!text) return [];
      const start = Number(cue && cue.start) || 0;
      const end = Number(cue && cue.end) || start + 4;

      if (!this.buf) {
        this.buf = { seq: ++this.seq, start, end, text, source: cue.source || null };
        return [{ type: "partial", unit: this.snapshot(false) }];
      }
      const gapMs = (start - this.buf.end) * 1000;
      if (gapMs > this.opts.gapMs) return [this.commit(), ...this.push(cue)];

      const ov = overlap(this.buf.text, text);
      if (!ov) {
        this.buf.end = Math.max(this.buf.end, end);
        return [{ type: "partial", unit: this.snapshot(false) }];
      }
      if (ov.replace) {
        this.buf.text = ov.replace;
        this.buf.end = Math.max(this.buf.end, end);
        return [{ type: "partial", unit: this.snapshot(false) }];
      }
      // 上一句已经完整，或新片段看起来是新句子开头 → 先收句，再把新片段当成新的一句
      if (endsSentence(this.buf.text) || (!ov.overlap && this.buf.text.length >= this.opts.capMinChars && startsUpper(text))) {
        return [this.commit(), ...this.push(cue)];
      }
      this.buf.text = joinText(this.buf.text, ov.append);
      this.buf.end = Math.max(this.buf.end, end);
      const events = [{ type: "partial", unit: this.snapshot(false) }];
      if (endsSentence(this.buf.text) || this.buf.text.length >= this.opts.maxChars) events.push(this.commit());
      return events;
    }

    /** 字幕被播放器清掉 / 视频切换前：把没说完的半句也收掉 */
    flush() { return this.buf ? [this.commit()] : []; }

    commit() {
      const unit = this.snapshot(true);
      this.buf = null;
      return { type: "commit", unit };
    }

    snapshot(done) {
      const b = this.buf;
      return { key: "sent-" + b.seq, start: b.start, end: b.end, text: b.text, done: !!done, source: b.source || null };
    }
  }

  /** 完整字幕列表 → 整句列表（保持 {start,end,text} 结构） */
  function mergeCuesIntoSentences(cues, opts) {
    const merger = new SentenceMerger(opts);
    const out = [];
    const take = (events) => {
      for (const ev of events) if (ev.type === "commit" && ev.unit && ev.unit.text) out.push({ start: ev.unit.start, end: ev.unit.end, text: ev.unit.text });
    };
    for (const c of (Array.isArray(cues) ? cues : [])) {
      if (!c || !c.text) continue;
      take(merger.push({ start: c.start, end: c.end, text: c.text }));
    }
    take(merger.flush());
    return out;
  }

  /** ASR 同一窗口内经常重复整句/整段；保留语义，只去掉连续重复。 */
  function dedupeAsrText(text) {
    const s = norm(text);
    if (!s) return "";
    const parts = s.match(/[^.!?…。！？]+[.!?…。！？]?/g) || [s];
    const out = [];
    for (const raw of parts) {
      const p = norm(raw);
      if (!p) continue;
      const prev = out[out.length - 1];
      if (prev) {
        const a = bare(prev);
        const b = bare(p);
        if (a && b && (a === b || (a.length >= 16 && b.startsWith(a)))) continue;
      }
      out.push(p);
    }
    let joined = out.join(" ").trim();
    const w = words(joined);
    for (let k = 1; k <= Math.floor(w.length / 2); k++) {
      if (w.length % k !== 0) continue;
      const unit = w.slice(0, k).map(bare).join(" ");
      if (!unit || (unit.length < 16 && k < 3)) continue;
      let same = true;
      for (let i = k; i < w.length; i += k) {
        if (w.slice(i, i + k).map(bare).join(" ") !== unit) { same = false; break; }
      }
      if (same) { joined = w.slice(0, k).join(" "); break; }
    }
    return joined;
  }
  ST.SentenceMerger = SentenceMerger;
  ST.mergeCuesIntoSentences = mergeCuesIntoSentences;
  ST.dedupeAsrText = dedupeAsrText;
  ST.sentenceMergeInternals = { overlap, endsSentence };
})();
