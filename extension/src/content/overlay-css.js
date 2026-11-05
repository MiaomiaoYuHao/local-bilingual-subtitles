// Overlay stylesheet kept as a JS string: injected into a shadow root so the host page can
// never style it. The bilingual lines are drawn over the video at the player's own subtitle
// position; nothing else is written on screen (per user requirement).
(() => {
  const ST = (globalThis.ST = globalThis.ST || {});
  ST.OVERLAY_CSS = `
:host { all: initial; }
* { box-sizing: border-box; margin: 0; padding: 0; }
.hidden { display: none !important; }
.root {
  position: fixed;
  inset: 0;
  pointer-events: none;
  z-index: 2147483000;
  font-family: system-ui, -apple-system, "Segoe UI", "Microsoft YaHei", "PingFang SC", sans-serif;
  -webkit-font-smoothing: antialiased;
}

/* ---------- floating translucent button (trigger ①) ---------- */
.fab {
  position: fixed;
  right: 20px;
  bottom: 110px;
  width: 44px;
  height: 44px;
  border-radius: 50%;
  border: 1px solid rgba(255, 255, 255, 0.3);
  background: rgba(15, 23, 42, 0.5);
  backdrop-filter: blur(6px);
  -webkit-backdrop-filter: blur(6px);
  color: #fff;
  cursor: pointer;
  display: flex;
  align-items: center;
  justify-content: center;
  font-size: 14px;
  font-weight: 700;
  letter-spacing: -0.5px;
  opacity: 0.55;
  transition: opacity 0.16s ease, transform 0.16s ease, background 0.16s ease;
  pointer-events: auto;
  z-index: 2147483003;
  padding: 0;
  user-select: none;
}
.fab:hover { opacity: 1; transform: scale(1.06); background: rgba(15, 23, 42, 0.8); }
.fab:active { transform: scale(0.97); }
.fab .dot {
  position: absolute;
  top: 2px;
  right: 2px;
  width: 9px;
  height: 9px;
  border-radius: 50%;
  background: #64748b;
  border: 1px solid rgba(0, 0, 0, 0.35);
}
.fab .dot.ready { background: #22c55e; }
.fab .dot.loading { background: #f59e0b; animation: st-pulse 1.1s infinite ease-in-out; }
.fab .dot.error { background: #ef4444; }

/* ---------- bilingual lines drawn over the video ---------- */
.subs {
  position: fixed;
  display: none;
  flex-direction: column;
  align-items: flex-start;
  justify-content: flex-end;
  gap: 0.28em;
  pointer-events: none;
  z-index: 2147483002;
  text-align: left;
  font-size: 9px;
  line-height: 1.3;
}
.subs.visible { display: flex; }
.subs .row { width: 100%; opacity: 0.82; transition: opacity 0.15s ease; }
.subs .row.current { opacity: 1; }
.subs .en {
  color: #f8fafc;
  font-weight: 600;
  font-size: 0.92em;
  text-shadow: 0 1px 3px rgba(0, 0, 0, 0.95), 0 0 8px rgba(0, 0, 0, 0.85), 0 0 2px rgba(0, 0, 0, 1);
  word-break: break-word;
}
.subs .zh {
  color: #ffe066;
  font-weight: 700;
  font-size: 1.06em;
  text-shadow: 0 1px 3px rgba(0, 0, 0, 0.95), 0 0 8px rgba(0, 0, 0, 0.85), 0 0 2px rgba(0, 0, 0, 1);
  word-break: break-word;
}
.subs .row.current .en { font-size: 1em; }
.subs .row.current .zh { font-size: 1.16em; color: #ffd11a; }

/* ---------- transient status chip (only while the model is not usable yet) ---------- */
.chip {
  position: fixed;
  display: none;
  align-items: center;
  gap: 8px;
  padding: 5px 12px;
  border-radius: 999px;
  background: rgba(11, 15, 25, 0.82);
  border: 1px solid rgba(255, 255, 255, 0.14);
  color: #e5e7eb;
  font-family: system-ui, -apple-system, "Segoe UI", "Microsoft YaHei", sans-serif;
  font-size: 12px;
  line-height: 1.4;
  white-space: nowrap;
  pointer-events: none;
  z-index: 2147483004;
  box-shadow: 0 6px 18px rgba(0, 0, 0, 0.4);
}
.chip.visible { display: inline-flex; }
.chip.error { color: #fca5a5; border-color: rgba(252, 165, 165, 0.4); }
.chip .bar { width: 74px; height: 3px; border-radius: 2px; background: rgba(255, 255, 255, 0.16); overflow: hidden; }
.chip .bar > i { display: block; height: 100%; width: 0%; background: linear-gradient(90deg, #60a5fa, #22d3ee); transition: width 0.3s ease; }

/* ---------- welcome toast ---------- */
.toast {
  position: fixed;
  left: 50%;
  bottom: 28px;
  transform: translateX(-50%);
  background: rgba(11, 15, 25, 0.94);
  border: 1px solid rgba(255, 255, 255, 0.14);
  border-radius: 10px;
  box-shadow: 0 10px 30px rgba(0, 0, 0, 0.45);
  padding: 10px 14px;
  display: flex;
  align-items: flex-start;
  gap: 10px;
  max-width: min(560px, calc(100vw - 40px));
  color: #e5e7eb;
  font-family: system-ui, "Segoe UI", "Microsoft YaHei", sans-serif;
  pointer-events: auto;
  z-index: 2147483005;
  animation: st-rise 0.22s ease;
}
.toast .toast-text { font-size: 12.5px; line-height: 1.6; }
.toast .toast-text b { color: #93c5fd; }
.toast .toast-close { border: none; background: transparent; color: #94a3b8; cursor: pointer; font-size: 13px; line-height: 1; }
.toast .toast-close:hover { color: #fff; }
/* ---------- 字幕区域里的一次性提示（成功绿 / 失败与操作提示红） ---------- */
.flash {
  position: fixed;
  display: none;
  align-items: center;
  justify-content: center;
  gap: 8px;
  padding: 0.15em 0.6em;
  border-radius: 8px;
  background: rgba(0, 0, 0, 0.55);
  font-family: system-ui, "Microsoft YaHei", sans-serif;
  font-size: 0.75em;
  line-height: 1.5;
  letter-spacing: 0.2px;
  pointer-events: none;
  opacity: 0;
  transition: opacity 0.18s ease;
  z-index: 2147483004;
  text-shadow: 0 1px 3px rgba(0, 0, 0, 0.9);
  white-space: nowrap;
  max-width: 92%;
  overflow: hidden;
  text-overflow: ellipsis;
}
.flash.show { display: flex; opacity: 0.9; }
.flash.ok { color: #4ade80; }        /* 成功 = 绿色 */
.flash.err { color: #f87171; }       /* 失败 / 操作提示 = 红色 */

@keyframes st-pulse { 0%, 100% { opacity: 0.35; } 50% { opacity: 1; } }
@keyframes st-rise { from { opacity: 0; transform: translateX(-50%) translateY(8px); } to { opacity: 1; transform: translateX(-50%) translateY(0); } }
@media (prefers-reduced-motion: reduce) { .fab, .subs .row { transition: none; } .toast, .fab .dot.loading { animation: none; } }
`;
})();