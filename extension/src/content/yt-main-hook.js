// MAIN-world hook (document_start) for YouTube.
// Since 2025 YouTube answers /api/timedtext with an empty 200 unless the request carries the
// player's own proof-of-origin token, so instead of fetching captions ourselves we capture the
// responses the player itself receives and forward them to the isolated content script.
(() => {
  if (window.__stYtHookInstalled) return;
  window.__stYtHookInstalled = true;

  const isTimedtext = (u) => typeof u === "string" && u.indexOf("/api/timedtext") !== -1;
  const MAX = 4000000;

  const emit = (url, body) => {
    if (!body) return;
    try {
      document.dispatchEvent(new CustomEvent("st:yt-timedtext", {
        detail: JSON.stringify({ url: String(url).slice(0, 3000), body: String(body).slice(0, MAX), at: Date.now() }),
      }));
    } catch { /* ignore */ }
  };

  try {
    const origFetch = window.fetch;
    if (typeof origFetch === "function") {
      window.fetch = function (...args) {
        const req = args[0];
        const url = typeof req === "string" ? req : (req && req.url) || "";
        const promise = origFetch.apply(this, args);
        if (isTimedtext(url) && promise && typeof promise.then === "function") {
          promise.then((res) => {
            try { res.clone().text().then((t) => emit(url, t)).catch(() => {}); } catch { /* ignore */ }
          }).catch(() => {});
        }
        return promise;
      };
    }
  } catch { /* ignore */ }

  try {
    const proto = XMLHttpRequest.prototype;
    const origOpen = proto.open;
    const origSend = proto.send;
    proto.open = function (method, url, ...rest) {
      try { this.__stUrl = url; } catch { /* ignore */ }
      return origOpen.call(this, method, url, ...rest);
    };
    proto.send = function (...args) {
      try {
        if (isTimedtext(this.__stUrl)) {
          this.addEventListener("load", () => {
            try { emit(this.__stUrl, this.responseText); } catch { /* ignore */ }
          });
        }
      } catch { /* ignore */ }
      return origSend.apply(this, args);
    };
  } catch { /* ignore */ }

  // let the page know the hook is alive (useful for diagnostics)
  try { document.documentElement.setAttribute("data-st-yt-hook", "1"); } catch { /* ignore */ }
})();