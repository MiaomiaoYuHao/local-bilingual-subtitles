// Small shared helpers (no DOM requirement beyond what the caller passes in).
(() => {
  const ST = (globalThis.ST = globalThis.ST || {});

  const util = {
    clamp(v, lo, hi) { return Math.min(Math.max(v, lo), hi); },

    /** seconds -> "m:ss" */
    fmtTime(seconds) {
      if (!Number.isFinite(seconds) || seconds < 0) return "0:00";
      const s = Math.floor(seconds % 60);
      const m = Math.floor(seconds / 60);
      return `${m}:${String(s).padStart(2, "0")}`;
    },

    /** true when the event target is a text field, where a hotkey must never hijack the key */
    /** true when the hotkey must not be hijacked (text entry only; checkboxes/buttons are fine) */
    isEditableTarget(el) { return util.isEditableElement(el); },

    isEditableElement(el) {
      if (!el || typeof el !== "object") return false;
      if (el.isContentEditable === true) return true;
      const tag = String(el.tagName || "").toUpperCase();
      if (tag === "TEXTAREA" || tag === "SELECT") return true;
      if (tag === "INPUT") {
        const type = String(el.type || "text").toLowerCase();
        return !["button", "submit", "reset", "checkbox", "radio", "range", "color", "file"].includes(type);
      }
      return false;
    },

    debounce(fn, ms) {
      let timer = null;
      const wrapped = (...args) => {
        if (timer) clearTimeout(timer);
        timer = setTimeout(() => { timer = null; fn(...args); }, ms);
      };
      wrapped.cancel = () => { if (timer) { clearTimeout(timer); timer = null; } };
      return wrapped;
    },

    /**
     * 判断一行是否英文（用于决定要不要翻译）。
     * 规则：没有中日文字符 → 英文；中日文和拉丁字母混排时看谁主导（避免个别汉字/假名导致误判）。
     */
    isLikelyEnglish(text) {
      const t = String(text || "").trim();
      if (!t) return false;
      const cjk = (t.match(/[\u3040-\u30ff\u3400-\u4dbf\u4e00-\u9fff]/g) || []).length;
      const latin = (t.match(/[A-Za-z]/g) || []).length;
      if (cjk === 0) return true;        // 完全没有中日文 → 英文
      if (latin === 0) return false;     // 纯中日文 → 不翻译
      // 混排：英文必须占多数（中文里夹几个英文词不算英文），"OK 好" 这类短混排例外
      if (latin >= 4 && latin >= cjk) return true;
      if (cjk <= 2 && latin >= 2) return true;
      return false;
    },

    /** indent-free console logger that is easy to spot / filter in devtools */
    log(...args) { console.log("[双语字幕]", ...args); },
    warn(...args) { console.warn("[双语字幕]", ...args); },

    /** never let a rejected promise kill the extension */
    async guard(label, fn, onError) {
      try {
        return await fn();
      } catch (err) {
        util.warn(`${label} 失败：`, err && err.message ? err.message : err);
        if (typeof onError === "function") { try { onError(err); } catch { /* ignore */ } }
        return undefined;
      }
    },
  };

  ST.util = util;
  ST.sleep = (ms) => new Promise((r) => setTimeout(r, ms));
})();