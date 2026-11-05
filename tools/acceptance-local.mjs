// Isolated end-to-end check of the translation pipeline (no YouTube, no bandwidth competition):
// local page with a real WebVTT <track> -> generic adapter -> overlay -> local model -> Chinese.
//
//   node tools/acceptance-local.mjs
import { chromium } from "playwright";
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { startStaticServer } from "./lib/static-server.mjs";

const ROOT = path.resolve(import.meta.dirname, "..");
const MIRROR = process.env.ST_EXT_PATH || path.join(ROOT, "extension");
const PROFILE = path.join(ROOT, ".playtest", process.env.ST_PROFILE || "chrome-profile3");
const PORT = Number(process.env.ST_CDP_PORT || 9453);
const CHROME = process.env.ST_CHROME || (process.platform === "win32" ? "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe" : process.platform === "darwin" ? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" : "google-chrome");
const MODEL_TIMEOUT_MS = Number(process.env.ST_MODEL_TIMEOUT || 10 * 60 * 1000);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const log = (...a) => console.log(...a);
let failures = 0;
const check = (name, ok, detail) => { if (!ok) failures++; log(`  ${ok ? "PASS" : "FAIL"}  ${name}${detail ? " :: " + detail : ""}`); return ok; };
async function alive() { try { const r = await fetch(`http://127.0.0.1:${PORT}/json/version`); return r.ok; } catch { return false; } }

for (let p = 9440; p <= 9460; p++) {
  try {
    const r = await fetch(`http://127.0.0.1:${p}/json/version`);
    if (r.ok) { const b = await chromium.connectOverCDP(`http://127.0.0.1:${p}`); const s = await b.newBrowserCDPSession(); await s.send("Browser.close").catch(() => null); await sleep(700); }
  } catch { /* ignore */ }
}

const server = await startStaticServer(path.join(ROOT, "tests", "web"));
log("静态页面服务器:", server.origin);

const child = spawn(CHROME, [
  `--user-data-dir=${PROFILE}`, `--remote-debugging-port=${PORT}`,
  "--no-first-run", "--no-default-browser-check", "--autoplay-policy=no-user-gesture-required",
  "--window-size=1280,800", "about:blank",
], { stdio: "ignore" });
for (let i = 0; i < 60 && !(await alive()); i++) await sleep(400);
const browser = await chromium.connectOverCDP(`http://127.0.0.1:${PORT}`);
const ctx = browser.contexts()[0];
const bcdp = await browser.newBrowserCDPSession();
let extId = null;
try { extId = (await bcdp.send("Extensions.loadUnpacked", { path: MIRROR })).id; } catch (err) {
  const ex = ctx.serviceWorkers().find((w) => w.url().includes("/src/background/service-worker.js"));
  extId = ex ? new URL(ex.url()).host : null;
  if (!extId) throw err;
}
log("扩展:", extId, "(" + browser.version() + ")");

const swEval = async (fn, arg) => {
  for (let i = 0; i < 25; i++) {
    const w = ctx.serviceWorkers().find((x) => x.url().includes("/src/background/service-worker.js"));
    if (w) { try { return await w.evaluate(fn, arg); } catch { /* swapping */ } }
    await sleep(600);
  }
  return null;
};

const page = await ctx.newPage();
const pageLogs = [];
page.on("console", (m) => pageLogs.push(`${m.type()}: ${m.text()}`));
page.on("pageerror", (e) => log("  [pageerror]", String(e).slice(0, 160)));

log("\n1) 打开本地软字幕测试页（真实 WebVTT <track>，不需要外网）");
await page.goto(`${server.origin}/local-track.html`, { waitUntil: "domcontentloaded" });
for (let i = 0; i < 40 && !(await page.evaluate(() => !!(window.__fixture && window.__fixture.ready))); i++) await sleep(400);
check("视频与 <track> 字幕就绪", await page.evaluate(() => !!(window.__fixture && window.__fixture.ready)));

log("\n2) 播放视频并按热键 Z 打开双语字幕");
await page.evaluate(() => { const v = document.querySelector("video"); v.muted = true; v.play().catch(() => {}); });
await page.keyboard.press("z");
await sleep(800);
const helper = `(() => {
  const host = document.getElementById("st-bilingual-subtitles");
  if (!host) return null;
  let st = null; try { st = JSON.parse(host.getAttribute("data-st-state") || "null"); } catch { st = null; }
  const root = host.shadowRoot;
  const subs = root.querySelector(".subs");
  const chip = root.querySelector(".chip");
  return {
    state: st, visible: subs.classList.contains("visible"),
    chipVisible: chip.classList.contains("visible"),
    chipText: chip.querySelector(".chip-text").innerText,
    rows: Array.from(subs.querySelectorAll(".row")).map((r) => ({ en: (r.querySelector(".en") || {}).innerText || "", zh: (r.querySelector(".zh") || {}).innerText || "" })),
  };
})()`;
let st = await page.evaluate(helper);
check("双语浮层已打开", !!(st && st.visible));
check("通用 <track> 适配器解析出字幕", !!(st && st.state && /track/i.test(st.state.adapter || "")), st && st.state && st.state.adapter);

log("\n3) 等待本地模型加载 + 中文译文（首次会下载一次权重）");
const t0 = Date.now();
let firstZh = null;
let lastChip = "";
let ready = null;
while (Date.now() - t0 < MODEL_TIMEOUT_MS) {
  st = await page.evaluate(helper);
  if (st && st.chipVisible && st.chipText !== lastChip) { lastChip = st.chipText; log(`  [${((Date.now() - t0) / 1000).toFixed(0)}s] ${st.chipText}`); }
  const zh = st.rows.filter((r) => r.zh && /[\u4e00-\u9fff]/.test(r.zh));
  if (zh.length && !firstZh) {
    firstZh = Date.now() - t0;
    log(`  [${((Date.now() - t0) / 1000).toFixed(0)}s] 首条中文译文出现`);
  }
  if (zh.length && st.rows.some((r) => r.en)) log("   rows: " + st.rows.map((r) => (r.zh ? r.en.slice(0, 26) + " → " + r.zh.slice(0, 20) : r.en.slice(0, 30))).join(" | "));
  const model = await swEval(async () => (globalThis.__st_model_status ? (await globalThis.__st_model_status()).data : null));
  if (model && !ready && model.state === "ready") {
    ready = Date.now() - t0;
    log(`  [${(ready / 1000).toFixed(0)}s] 模型就绪 device=${model.device} dtype=${model.dtype} warmup=${model.warmupMs}ms`);
  }
  if (zh.length >= 2 && ready) break;
  await sleep(2000);
}

const model = await swEval(async () => (globalThis.__st_model_status ? (await globalThis.__st_model_status()).data : null));
check("本地模型就绪（只下载一次，之后走缓存）", !!(model && (model.state === "ready" || model.loadedAt)), model ? `${model.state} ${model.device}/${model.dtype} warmup=${model.warmupMs}ms` : "无状态");
check("视频字幕位置显示中文译文", !!firstZh, firstZh ? `${(firstZh / 1000).toFixed(1)}s 内出现首条译文` : "未出现");
if (model && model.stats) {
  log(`  推理统计: 调用 ${model.stats.calls} 次，缓存命中 ${model.stats.cached}，单句耗时 ${model.stats.lastMs}ms，超时 ${model.stats.timeouts}`);
  const warm = model.stats.calls > 0 && model.stats.lastMs > 0 && model.stats.lastMs < 8000;
  const allCached = model.stats.calls === 0 && model.stats.cached > 0;
  check("单句推理耗时在 8 秒内（实时性），重复句子命中缓存不再推理", warm || allCached,
    warm ? `单句 ${model.stats.lastMs}ms` : `全部命中 IndexedDB 缓存（模型调用 0 次，缓存命中 ${model.stats.cached}）`);
}

const shot = path.join(ROOT, "playtest", "evidence", `acceptance-local-${Date.now()}.png`);
fs.mkdirSync(path.dirname(shot), { recursive: true });
await page.screenshot({ path: shot });
log("  截图: " + path.relative(ROOT, shot));
log(failures ? `\n结果：${failures} 项未通过` : "\n结果：全部通过 ✅");
fs.writeFileSync(path.join(ROOT, "playtest", "acceptance-local.json"), JSON.stringify({ at: new Date().toISOString(), model, rows: st && st.rows, firstZh, pageLogs: pageLogs.slice(-30) }, null, 2));
// 不关闭浏览器：避免打断用户正在看的页面
await sleep(400);
try { child.kill(); } catch { /* ignore */ }
await server.close();
process.exit(failures ? 1 : 0);