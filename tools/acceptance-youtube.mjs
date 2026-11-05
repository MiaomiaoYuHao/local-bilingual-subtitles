// Final acceptance check, exactly the user's flow:
//   open the tool's Chrome -> open a YouTube video -> switch on the player's English captions
//   -> press space / click the floating button -> expect 3 bilingual lines over the video.
//
//   node tools/acceptance-youtube.mjs [videoId]
import { chromium } from "playwright";
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const ROOT = path.resolve(import.meta.dirname, "..");
const MIRROR = process.env.ST_EXT_PATH || path.join(ROOT, "extension");
const PROFILE = path.join(ROOT, ".playtest", process.env.ST_PROFILE || "chrome-profile");
const EVIDENCE = path.join(ROOT, "playtest", "evidence");
const PORT = Number(process.env.ST_CDP_PORT || 9446);
const CHROME = process.env.ST_CHROME || (process.platform === "win32" ? "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe" : process.platform === "darwin" ? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" : "google-chrome");
const VIDEO = process.argv[2] || process.env.ST_YT_VIDEO || "aircAruvnKk";
const MODEL_TIMEOUT_MS = 25 * 60 * 1000;
const SW_VERSION = (() => {
  try {
    const src = fs.readFileSync(path.join(MIRROR, "src", "background", "service-worker.js"), "utf8");
    const m = /const SW_VERSION = "([^"]+)"/.exec(src);
    return m ? m[1] : null;
  } catch { return null; }
})();

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const log = (...a) => console.log(...a);
let failures = 0;
function check(name, ok, detail) {
  if (!ok) failures++;
  log(`  ${ok ? "PASS" : "FAIL"}  ${name}${detail ? " :: " + detail : ""}`);
  return ok;
}

async function alive() { try { const r = await fetch(`http://127.0.0.1:${PORT}/json/version`); return r.ok; } catch { return false; } }

async function resetRunState() {
  for (let p = 9440; p <= 9460; p++) {
    try {
      const res = await fetch(`http://127.0.0.1:${p}/json/version`);
      if (!res.ok) continue;
      const b = await chromium.connectOverCDP(`http://127.0.0.1:${p}`);
      const s = await b.newBrowserCDPSession();
      await s.send("Browser.close").catch(() => null);
      await sleep(800);
      log(`closed leftover chrome on port ${p}`);
    } catch { /* ignore */ }
  }
  // NOTE: never delete browser caches here - it invalidates the extension's own model cache
}

async function main() {
  fs.mkdirSync(EVIDENCE, { recursive: true });
  await resetRunState();

  const child = spawn(CHROME, [
    `--user-data-dir=${PROFILE}`, `--remote-debugging-port=${PORT}`,
    "--no-first-run", "--no-default-browser-check", "--autoplay-policy=no-user-gesture-required",
    "--window-size=1440,900", "--lang=en-US", "about:blank",
  ], { stdio: "ignore" });
  for (let i = 0; i < 60 && !(await alive()); i++) await sleep(400);
  if (!(await alive())) throw new Error("Chrome 调试端口未就绪");

  const browser = await chromium.connectOverCDP(`http://127.0.0.1:${PORT}`);
  const ctx = browser.contexts()[0];
  const bcdp = await browser.newBrowserCDPSession();
  const swUrl = (w) => w.url().includes("/src/background/service-worker.js");
  let extId = null;
  let loadedFresh = false;
  try { extId = (await bcdp.send("Extensions.loadUnpacked", { path: MIRROR })).id; loadedFresh = true; }
  catch (err) {
    const ex = ctx.serviceWorkers().find(swUrl);
    if (!ex) throw err;
    extId = new URL(ex.url()).host;
    log("扩展已在 profile 中注册，沿用现有实例");
  }
  log(`扩展已加载: ${extId} (Chrome ${browser.version()}, fresh=${loadedFresh})`);

  ctx.on("serviceworker", (w) => {
    if (!swUrl(w)) return;
    w.on("console", (m) => log(`  [sw:${m.type()}] ${m.text().slice(0, 200)}`));
    w.on("close", () => log("  [sw] 已停止"));
  });
  for (const w of ctx.serviceWorkers()) {
    if (!swUrl(w)) continue;
    w.on("console", (m) => log(`  [sw:${m.type()}] ${m.text().slice(0, 200)}`));
  }

  // talk to the service worker directly; MV3 workers start lazily, so wait a little
  const swEval = async (fn, arg) => {
    for (let i = 0; i < 20; i++) {
      const w = ctx.serviceWorkers().find((x) => x.url().includes("/src/background/service-worker.js"));
      if (w) {
        try { return await w.evaluate(fn, arg); } catch { /* worker may be swapping */ }
      }
      await sleep(800);
    }
    return null;
  };

  if (process.env.ST_SKIP_WEBGPU !== "0") {
    await swEval(async () => { await chrome.storage.local.set({ st_webgpu_unusable: true }); return true; });
  }

  const page = await ctx.newPage();
  const pageLogs = [];
  page.on("console", (m) => {
    pageLogs.push(`${m.type()}: ${m.text()}`);
    if (m.type() === "error" && !/doubleclick|googleads|ERR_FAILED|403/.test(m.text())) log("  [page error] " + m.text().slice(0, 160));
  });
  page.on("pageerror", (e) => { log("  [pageerror] " + String(e).slice(0, 200)); });

  log(`\n1) 打开 YouTube 视频 https://www.youtube.com/watch?v=${VIDEO}`);
  await page.goto(`https://www.youtube.com/watch?v=${VIDEO}`, { waitUntil: "domcontentloaded", timeout: 90000 });
  await sleep(1500);
  const consent = page.locator('button:has-text("Accept all"), button[aria-label*="Accept"]').first();
  if (await consent.count().catch(() => 0)) await consent.click({ timeout: 4000 }).catch(() => null);
  let ok = false;
  for (let i = 0; i < 60 && !ok; i++) { ok = await page.evaluate(() => !!document.querySelector("video")); if (!ok) await sleep(500); }
  check("播放器出现", ok, await page.title());
  for (let i = 0; i < 90; i++) { if (!(await page.evaluate(() => !!document.querySelector(".ad-showing")))) break; await sleep(1000); }
  check("广告已结束", !(await page.evaluate(() => !!document.querySelector(".ad-showing"))));

  log("\n2) 播放视频并打开播放器自带英语字幕（用户操作）");
  await page.evaluate(() => { const v = document.querySelector("video"); v.muted = true; v.play().catch(() => {}); });
  await sleep(2500);
  let ccState = await page.evaluate(() => {
    const b = document.querySelector("button.ytp-subtitles-button");
    return b ? b.getAttribute("aria-pressed") : null;
  });
  if (ccState !== "true") {
    const btn = page.locator("button.ytp-subtitles-button").first();
    if (await btn.count()) { await btn.click({ timeout: 5000 }).catch(() => null); }
    await sleep(1500);
    ccState = await page.evaluate(() => {
      const b = document.querySelector("button.ytp-subtitles-button");
      return b ? b.getAttribute("aria-pressed") : null;
    });
  }
  // pick the English caption track explicitly (the user's "打开英语字幕" step)
  await page.evaluate(() => {
    const p = document.getElementById("movie_player");
    if (p && typeof p.setOption === "function") {
      try { p.setOption("captions", "track", { languageCode: "en" }); } catch { /* ignore */ }
    }
  });
  await sleep(1500);

  let segs = 0;
  let segText = "";
  for (let i = 0; i < 40; i++) {
    const info = await page.evaluate(() => ({
      n: document.querySelectorAll(".ytp-caption-segment").length,
      t: Array.from(document.querySelectorAll(".ytp-caption-segment")).map((n) => n.textContent.trim()).join(" ").slice(0, 60),
    }));
    segs = info.n;
    segText = info.t;
    if (segs > 0 && /[A-Za-z]{3}/.test(segText)) break;
    await sleep(500);
  }
  log("  播放器字幕文本: " + JSON.stringify(segText));
  check("播放器自带英文字幕已开启", segs > 0, `ccPressed=${ccState} segments=${segs}`);

  log("\n3) 按快捷键 Z 调出本工具的双语字幕");
  await page.keyboard.press("z");
  await sleep(800);
  const overlay = await page.evaluate(() => {
    const host = document.getElementById("st-bilingual-subtitles");
    if (!host) return null;
    let st = null;
    try { st = JSON.parse(host.getAttribute("data-st-state") || "null"); } catch { st = null; }
    const root = host.shadowRoot;
    const subs = root.querySelector(".subs");
    const chip = root.querySelector(".chip");
    return {
      state: st,
      visible: subs.classList.contains("visible"),
      chipVisible: chip.classList.contains("visible"),
      chipText: chip.querySelector(".chip-text").innerText,
      rows: Array.from(subs.querySelectorAll(".row")).map((r) => ({
        current: r.classList.contains("current"),
        en: (r.querySelector(".en") || {}).innerText || "",
        zh: (r.querySelector(".zh") || {}).innerText || "",
      })),
    };
  });
  check("双语浮层已打开", !!(overlay && overlay.visible));
  check("YouTube 适配器已解析字幕", !!(overlay && overlay.state && /YouTube/.test(overlay.state.adapter || "")), overlay && overlay.state && overlay.state.adapter);

  log("\n4) 等待英文原句 + 本地中文翻译出现在视频字幕位置");
  let withZh = 0;
  let lastMsg = "";
  const t0 = Date.now();
  while (Date.now() - t0 < MODEL_TIMEOUT_MS) {
    const s = await page.evaluate(() => {
      const host = document.getElementById("st-bilingual-subtitles");
      if (!host) return null;
      let st = null;
      try { st = JSON.parse(host.getAttribute("data-st-state") || "null"); } catch { st = null; }
      const root = host.shadowRoot;
      const subs = root.querySelector(".subs");
      const chip = root.querySelector(".chip");
      return {
        state: st,
        chipVisible: chip.classList.contains("visible"),
        chipText: chip.querySelector(".chip-text").innerText,
        rows: Array.from(subs.querySelectorAll(".row")).map((r) => ({
          current: r.classList.contains("current"),
          en: (r.querySelector(".en") || {}).innerText || "",
          zh: (r.querySelector(".zh") || {}).innerText || "",
        })),
      };
    });
    if (!s) break;
    if (s.chipVisible && s.chipText !== lastMsg) { lastMsg = s.chipText; log("  chip: " + s.chipText); }
    const en = s.rows.filter((r) => r.en).length;
    withZh = s.rows.filter((r) => r.zh && /[\u4e00-\u9fff]/.test(r.zh)).length;
    if (en >= 1 && s.rows.some((r) => r.en)) log(`  rows en=${en} zh=${withZh} :: ${s.rows.map((r) => (r.zh ? r.en.slice(0, 26) + " → " + r.zh.slice(0, 18) : r.en.slice(0, 30))).join(" | ")}`);
    if (withZh >= 1 && en >= 2) break;
    await sleep(3000);
  }
  const final = await page.evaluate(() => {
    const host = document.getElementById("st-bilingual-subtitles");
    let st = null;
    try { st = JSON.parse(host.getAttribute("data-st-state") || "null"); } catch { st = null; }
    const root = host.shadowRoot;
    const subs = root.querySelector(".subs");
    return {
      state: st,
      rows: Array.from(subs.querySelectorAll(".row")).map((r) => ({
        current: r.classList.contains("current"),
        en: (r.querySelector(".en") || {}).innerText || "",
        zh: (r.querySelector(".zh") || {}).innerText || "",
      })),
      anyOtherText: Array.from(root.querySelectorAll("*")).filter((el) => !/^(STYLE|SCRIPT|TEMPLATE)$/.test(el.tagName) && el.children.length === 0 && (el.innerText || "").trim() && !subs.contains(el) && !root.querySelector(".fab").contains(el) && !(root.querySelector(".chip").contains(el) && root.querySelector(".chip").classList.contains("visible")) && !(root.querySelector(".toast-host") && root.querySelector(".toast-host").contains(el))).map((el) => el.innerText.trim().slice(0, 40)),
    };
  });
  const chipStillNeeded = /下载|加载中|准备中/.test(final.chipText || "");
  const toastNoted = (await page.evaluate(() => { const h = document.getElementById("st-bilingual-subtitles"); const t = h && h.shadowRoot.querySelector(".toast-host"); return !!(t && t.innerText.trim()); }));
  if (toastNoted) log("  note  欢迎提示（spec §13，5 秒后自动消失）仍在屏幕上，已从“多余文字”检查中排除");
  const enRows = final.rows.filter((r) => r.en);
  const zhRows = final.rows.filter((r) => r.zh && /[\u4e00-\u9fff]/.test(r.zh));
  check("视频字幕位置显示英文原句", enRows.length >= 1, enRows.map((r) => r.en.slice(0, 40)).join(" | "));
  check("英文下方显示中文译文（本地模型，实时）", zhRows.length >= 1, zhRows.map((r) => r.zh.slice(0, 30)).join(" | "));
  check("视频画面上只有双语字幕（无标题/时间码/多余文字）", final.anyOtherText.length === 0 || (chipStillNeeded && final.anyOtherText.length === 1 && final.anyOtherText[0] === (final.chipText || "").slice(0, 40)), JSON.stringify(final.anyOtherText));

  const model = await swEval(async () => (globalThis.__st_model_status ? (await globalThis.__st_model_status()).data : null));
  if (model) log(`  model: device=${model.device} dtype=${model.dtype} fallbackFrom=${model.fallbackFrom} calls=${model.stats && model.stats.calls} cacheHits=${model.stats && model.stats.cached}`);
  check("本地模型在运行（WebGPU 或已回退 WASM）", !!model && (model.state === "ready" || model.loadedAt), model ? `${model.state} ${model.device}/${model.dtype}` : "无状态");

  const captured = pageLogs.filter((l) => /捕获播放器字幕数据/.test(l));
  log(`  捕获到的播放器字幕数据：${captured.length} 次`);

  const shot = path.join(EVIDENCE, `acceptance-youtube-${Date.now()}.png`);
  await page.screenshot({ path: shot });
  log(`  截图：${path.relative(ROOT, shot)}`);

  if (failures) log(`\n结果：${failures} 项未通过`);
  else log("\n结果：全部通过 ✅");

    fs.writeFileSync(path.join(ROOT, "playtest", "acceptance-youtube.json"), JSON.stringify({ at: new Date().toISOString(), video: VIDEO, extensionId: extId, failures, overlay: final, model, pageLogs: pageLogs.slice(-40) }, null, 2));
  // 不关闭浏览器：避免打断用户正在看的页面
  await sleep(500);
  try { child.kill(); } catch { /* ignore */ }
  process.exit(failures ? 1 : 0);
}

main().catch((err) => { console.error("FAILED:", err); process.exit(2); });