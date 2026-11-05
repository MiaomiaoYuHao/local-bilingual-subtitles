// The in-page overlay: bilingual lines drawn over the video at the player's subtitle
// position (newest line at the bottom), a floating translucent button, a transient status
// chip, and the welcome toast. Rendered inside a shadow root; it never touches the player's
// own caption elements.
(() => {
  const ST = (globalThis.ST = globalThis.ST || {});
  const util = ST.util;
  const DISPLAY_LINES = (ST.CONFIG && ST.CONFIG.DISPLAY_LINES) || 3;

  const TPL = `
<div class="root">
  <div class="subs" role="region" aria-label="双语字幕"></div>
  <div class="chip"><span class="chip-text"></span><span class="bar"><i></i></span></div>
  <button class="fab" type="button" title="双语字幕（空格）" aria-label="双语字幕">
    <span class="fab-label">中A</span>
    <span class="dot"></span>
  </button>
  <div class="toast-host"></div>
  <div class="flash"></div>
</div>`;

  class Overlay {
    constructor(options) {
      this.options = options || {};
      this.host = null;
      this.shadow = null;
      this.video = null;
      this.open = false;
      this.entries = [];
      this.translations = null;
      this.state = { open: false, model: "unknown", device: "-", adapter: "-", rows: 0, zhCount: 0, errors: [], currentEn: "", currentZh: "" };
      this.onClose = null;
      this.onFabClick = null;
      this._toastTimer = null;
      this._repositionBound = () => this.reposition();
    }

    mount() {
      if (this.host) return this.host;
      // 扩展更新后会自动重新注入：先清掉上一次留下的浮层
      const stale = document.getElementById("st-bilingual-subtitles");
      if (stale && stale.parentNode) stale.parentNode.removeChild(stale);
      const host = document.createElement("div");
      host.id = "st-bilingual-subtitles";
      host.setAttribute("data-st-root", "1");
      host.style.setProperty("all", "initial", "important");
      const shadow = host.attachShadow({ mode: "open" });
      const style = document.createElement("style");
      style.textContent = ST.OVERLAY_CSS || "";
      shadow.appendChild(style);
      const wrap = document.createElement("div");
      wrap.innerHTML = TPL;
      while (wrap.firstChild) shadow.appendChild(wrap.firstChild);

      this.host = host;
      this.shadow = shadow;
      this.subs = shadow.querySelector(".subs");
      this.chip = shadow.querySelector(".chip");
      this.chipText = shadow.querySelector(".chip-text");
      this.chipBar = shadow.querySelector(".chip .bar > i");
      this.fab = shadow.querySelector(".fab");
      this.fabDot = shadow.querySelector(".fab .dot");
      this.toastHost = shadow.querySelector(".toast-host");
      this.flashEl = shadow.querySelector(".flash");

      this.fab.addEventListener("click", (e) => {
        e.preventDefault();
        e.stopPropagation();
        if (this.onFabClick) this.onFabClick();
      });
      for (const type of ["keydown", "keyup", "keypress", "pointerdown", "wheel"]) {
        host.addEventListener(type, (e) => e.stopPropagation());
      }
      document.documentElement.appendChild(host);
      document.addEventListener("fullscreenchange", () => { this.ensurePlacement(); this.reposition(); }, true);
      window.addEventListener("resize", this._repositionBound, { passive: true });
      window.addEventListener("scroll", this._repositionBound, { passive: true, capture: true });
      this.syncStateAttr();
      return host;
    }

    destroy() {
      window.removeEventListener("resize", this._repositionBound);
      window.removeEventListener("scroll", this._repositionBound, true);
      if (this.host && this.host.parentNode) this.host.parentNode.removeChild(this.host);
      this.host = null;
      this.shadow = null;
    }

    get mounted() { return !!this.host; }

    attachVideo(video) {
      this.video = video || null;
      this.reposition();
    }

    /** Keep the overlay visible when the player enters native fullscreen. */
    ensurePlacement() {
      if (!this.host) return;
      const fs = document.fullscreenElement;
      const parent = fs && !fs.contains(this.host) ? fs : document.documentElement;
      if (this.host.parentNode !== parent) parent.appendChild(this.host);
    }

    /** Anchor the lines to the video's own subtitle area (bottom-centre of the video box). */
    reposition() {
      if (!this.host || !this.subs) return;
      const rect = this.video && this.video.getBoundingClientRect ? this.video.getBoundingClientRect() : null;
      const ok = rect && rect.width > 120 && rect.height > 90 && rect.bottom > 0 && rect.top < window.innerHeight;
      if (!ok) {
        // 更新提示必须看得见，即使此刻量不到视频区域
        this.subs.classList.toggle("visible", !!this.lockNotice && this.open);
        this.chip.classList.remove("visible");
        return;
      }
      const fontSize = Math.max(7, Math.min(15, rect.width / 76));
      this.subs.style.fontSize = `${fontSize.toFixed(1)}px`;
      this.subs.style.width = `${Math.min(rect.width * 0.92, 1280).toFixed(0)}px`;
      this.subs.style.left = `${(rect.left + rect.width / 2).toFixed(0)}px`;
      this.subs.style.bottom = `${(window.innerHeight - rect.bottom + rect.height * 0.12).toFixed(0)}px`;
      this.subs.style.transform = "translateX(-50%)";
      this.chip.style.left = `${(rect.left + rect.width / 2).toFixed(0)}px`;
      this.chip.style.top = `${(Math.max(rect.top, 0) + 12).toFixed(0)}px`;
      this.chip.style.transform = "translateX(-50%)";
      this.subs.classList.toggle("visible", this.open);
      this.repositionFlash();
    }

    setHotkeyLabel(label) {
      this.hotkeyLabel = label || "—";
      if (this.fab) {
        const text = "双语字幕（热键 " + this.hotkeyLabel + "）";
        this.fab.title = text;
        this.fab.setAttribute("aria-label", text);
      }
    }

    setAdapter(label) {
      this.state.adapter = label || "-";
      this.syncStateAttr();
    }

    setDevice(device) {
      this.state.device = device || "-";
      this.syncStateAttr();
    }

    setModelState(state) {
      this.state.model = state || "unknown";
      if (this.fabDot) {
        this.fabDot.className = "dot";
        if (state === "ready") this.fabDot.classList.add("ready");
        else if (state === "downloading" || state === "loading" || state === "warming") this.fabDot.classList.add("loading");
        else if (state === "error") this.fabDot.classList.add("error");
      }
      this.syncStateAttr();
    }

    /** Transient chip: only used while the local model is not usable yet (or on failure). */
    setStatus(text, kind, progress) {
      if (!this.chip) return;
      const show = !!text;
      this.chip.classList.toggle("visible", show);
      this.chip.classList.toggle("error", kind === "error");
      this.chipText.textContent = text || "";
      const hasBar = typeof progress === "number" && progress >= 0 && progress <= 100;
      this.chipBar.parentElement.classList.toggle("hidden", !hasBar);
      if (hasBar) this.chipBar.style.width = `${progress.toFixed(1)}%`;
      this.state.statusText = text || "";
      this.reposition();
    }

    setErrors(errors) {
      this.state.errors = Array.isArray(errors) ? errors.slice(0, 4) : [];
      this.syncStateAttr();
    }

    /**
     * 一次性提示，显示在视频字幕区域。
     * kind: "ok" 绿色（成功） | "err" 红色（失败或操作提示）
     */
    flash(text, ms, kind) {
      if (!this.flashEl) return;
      const el = this.flashEl;
      el.textContent = String(text || "");
      el.classList.remove("ok", "err");
      el.classList.add(kind === "ok" ? "ok" : "err");
      el.classList.add("show");
      this.repositionFlash();
      if (this._flashTimer) clearTimeout(this._flashTimer);
      this._flashTimer = setTimeout(() => { el.classList.remove("show"); }, Number.isFinite(ms) ? ms : 1800);
    }

    /** 让提示贴在字幕位置上（和字幕同一片区域，但不进字幕列表，因此永远不会被保存） */
    repositionFlash() {
      if (!this.flashEl) return;
      const rect = this.video && this.video.getBoundingClientRect ? this.video.getBoundingClientRect() : null;
      if (!rect || rect.width < 120 || rect.height < 90) {
        this.flashEl.style.left = "50%";
        this.flashEl.style.bottom = "16%";
        this.flashEl.style.transform = "translateX(-50%)";
        return;
      }
      this.flashEl.style.fontSize = Math.max(12, Math.min(26, rect.width / 46)).toFixed(1) + "px";
      this.flashEl.style.width = Math.min(rect.width * 0.9, 1200).toFixed(0) + "px";
      this.flashEl.style.left = (rect.left + rect.width / 2).toFixed(0) + "px";
      this.flashEl.style.bottom = (window.innerHeight - rect.bottom + rect.height * 0.12).toFixed(0) + "px";
      this.flashEl.style.transform = "translateX(-50%)";
    }

    /** 扩展被更新/重载后，已注入的脚本会失效：在字幕位置给出唯一且醒目的提示 */
    showReloadNotice(text) {
      if (!this.subs) return;
      this.lockNotice = true;
      const row = document.createElement("div");
      row.className = "row current";

      const en = document.createElement("div");
      en.className = "en";
      en.textContent = text || "扩展已更新";

      const bar = document.createElement("div");
      bar.style.cssText = "margin-top:6px;display:flex;gap:10px;align-items:center;justify-content:center;pointer-events:auto";
      const hint = document.createElement("span");
      hint.style.cssText = "font-size:0.72em;opacity:.85";
      hint.textContent = "按 R 或点按钮刷新";

      const btn = document.createElement("button");
      btn.type = "button";
      btn.textContent = "刷新";
      btn.style.cssText = "font:inherit;font-size:0.8em;padding:3px 12px;border:0;border-radius:999px;background:#2563eb;color:#fff;cursor:pointer;pointer-events:auto";
      btn.addEventListener("click", (e) => { e.preventDefault(); e.stopPropagation(); location.reload(); });

      bar.appendChild(hint);
      bar.appendChild(btn);
      row.appendChild(en);
      row.appendChild(bar);
      this.subs.innerHTML = "";
      this.subs.appendChild(row);
      this.show();

      // 字母键 R 也能刷新（避开 F5 是笔记本亮度键的问题）
      this._reloadKey = (ev) => {
        const key = String(ev.key || "").toLowerCase();
        if (key !== "r" || ev.ctrlKey || ev.metaKey || ev.altKey) return;
        ev.preventDefault();
        location.reload();
      };
      window.addEventListener("keydown", this._reloadKey, true);
    }

    setFabVisible(v) { if (this.fab) this.fab.classList.toggle("hidden", !v); }

    /** entries: [{index,start,end,text,isCurrent}] in playback order; only the newest N are drawn. */
    setWindow(entries, translations) {
      if (this.lockNotice) return;   // 已提示刷新，不再覆盖
      this.entries = Array.isArray(entries) ? entries : [];
      this.translations = translations || null;
      this.render();
      this.syncStateAttr();
      this.reposition();
    }

    displayedEntries() {
      const tail = this.entries.slice(-DISPLAY_LINES);
      const seen = new Set();
      const out = [];
      for (let i = tail.length - 1; i >= 0; i--) {
        const e = tail[i];
        const key = String(e.text || "").replace(/\s+/g, " ").trim().toLowerCase();
        if (key && seen.has(key)) continue;
        if (key) seen.add(key);
        out.unshift(e);
      }
      return out;
    }

    render() {
      if (!this.subs) return;
      const shown = this.displayedEntries();
      const frag = document.createDocumentFragment();
      for (const entry of shown) {
        const row = document.createElement("div");
        row.className = "row" + (entry.isCurrent ? " current" : "");
        row.setAttribute("data-st-index", String(entry.index));
        if (entry.isCurrent) row.setAttribute("data-st-current", "1");

        const en = document.createElement("div");
        en.className = "en";
        en.textContent = entry.text;
        row.appendChild(en);

        const t = this.translations ? this.translations.get(entry.text) : null;
        if (t && t.status === "done" && t.zh) {
          const zh = document.createElement("div");
          zh.className = "zh";
          zh.textContent = t.zh;
          row.appendChild(zh);
        } else if (t && t.status === "error") {
          const zh = document.createElement("div");
          zh.className = "zh error";
          const reason = t.error ? String(t.error).slice(0, 60) : "未知原因";
          zh.textContent = "翻译失败（" + reason + "）";
          zh.title = String(t.error || "");
          row.appendChild(zh);
        }
        // no translation yet -> render nothing (no "translating…" placeholder)
        frag.appendChild(row);
      }
      this.subs.innerHTML = "";
      this.subs.appendChild(frag);
    }

    show() {
      this.open = true;
      this.state.open = true;
      this.ensurePlacement();
      this.reposition();
      this.syncStateAttr();
    }

    hide() {
      this.open = false;
      this.state.open = false;
      if (this.subs) this.subs.classList.remove("visible");
      this.syncStateAttr();
    }

    toggle() { return this.open ? (this.hide(), false) : (this.show(), true); }

    toast(text, options) {
      const opts = options || {};
      const el = document.createElement("div");
      el.className = "toast";
      el.setAttribute("role", "status");
      const span = document.createElement("span");
      span.className = "toast-text";
      span.innerHTML = text;
      const close = document.createElement("button");
      close.className = "toast-close";
      close.type = "button";
      close.textContent = "✕";
      close.addEventListener("click", () => el.remove());
      el.appendChild(span);
      el.appendChild(close);
      if (this.toastHost) {
        this.toastHost.innerHTML = "";
        this.toastHost.appendChild(el);
      }
      if (this._toastTimer) clearTimeout(this._toastTimer);
      const ms = Number.isFinite(opts.ms) ? opts.ms : 8000;
      if (ms > 0) this._toastTimer = setTimeout(() => el.remove(), ms);
      return el;
    }

    clearToast() {
      if (this._toastTimer) clearTimeout(this._toastTimer);
      if (this.toastHost) this.toastHost.innerHTML = "";
    }

    /** Compact machine-readable state for the automated playtest and for support. */
    syncStateAttr() {
      if (!this.host) return;
      try {
        const shown = this.displayedEntries();
        const current = this.entries.find((e) => e.isCurrent) || this.entries[this.entries.length - 1] || null;
        const zhOf = (text) => {
          const t = this.translations && this.translations.get(text);
          return t && t.status === "done" && t.zh ? t.zh : "";
        };
        this.state.rows = shown.length;
        this.state.cacheRows = this.entries.length;
        this.state.zhCount = shown.filter((e) => zhOf(e.text)).length;
        this.state.currentEn = current ? String(current.text).slice(0, 200) : "";
        this.state.currentZh = current ? String(zhOf(current.text)).slice(0, 200) : "";
        this.state.displayed = shown.map((e) => ({ en: String(e.text).slice(0, 120), zh: String(zhOf(e.text)).slice(0, 120), source: String(e.source || ""), current: !!e.isCurrent }));
        this.host.setAttribute("data-st-state", JSON.stringify(this.state));
      } catch { /* never break the page because of a debug attribute */ }
    }
  }

  ST.Overlay = Overlay;
})();