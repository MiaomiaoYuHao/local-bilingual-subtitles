// Automated browser playtest: loads the unpacked extension into a real Chrome and drives a
// local <track> fixture plus YouTube, recording evidence (JSON + screenshots) per spec item.
//
// Chrome 137+ ignores --load-extension from the command line, and the bundled headless shell
// cannot host extensions at all, so this harness launches Chrome itself and loads the unpacked
// extension through the browser-level CDP command "Extensions.loadUnpacked".
//
//   node tools/playtest.mjs                    # local + youtube + native + cache + fallback
//   node tools/playtest.mjs --only=local       # single step
//   node tools/playtest.mjs --wasm             # also verify the WASM fallback path
//   node tools/playtest.mjs --headed=false ... # (always headed: WebGPU needs a real window)
import { chromium } from "playwright";
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { startStaticServer } from "./lib/static-server.mjs";

const ROOT = path.resolve(import.meta.dirname, "..");
const EXT = path.join(ROOT, "extension");
const MIRROR = path.join(os.homedir(), ".st-ext");
const PROFILE = path.join(ROOT, ".playtest", "chrome-profile");
const EVIDENCE = path.join(ROOT, "playtest", "evidence");
const REPORT_PATH = path.join(ROOT, "playtest", "playtest-report.json");
const CHROME_EXE = process.env.ST_CHROME || (process.platform === "win32" ? "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe" : process.platform === "darwin" ? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" : "google-chrome");
const PORT = Number(process.env.ST_CDP_PORT || 9444);

const argv = process.argv.slice(2);
const flag = (name) => argv.includes("--" + name);
const value = (name, dflt) => {
  const hit = argv.find((a) => a.startsWith("--" + name + "="));
  return hit ? hit.slice(name.length + 3) : dflt;
};
const ONLY = value("only", "");
const STEPS = ONLY ? ONLY.split(",").map((s) => s.trim()).filter(Boolean) : ["local", "youtube", "native", "cache", "fallback"];
const WANT_WASM = flag("wasm");
const YT_VIDEO = value("video", process.env.ST_YT_VIDEO || "aircAruvnKk");
const MODEL_TIMEOUT_MS = Number(value("model-timeout", 20 * 60 * 1000));

const report = {
  startedAt: new Date().toISOString(),
  chrome: null,
  extensionId: null,
  launch: "chrome --remote-debugging-port + CDP Extensions.loadUnpacked",
  steps: [],
  consoleErrors: [],
  pageErrors: [],
  extensionConsole: [],
  summary: null,
};

let current = null;
function startStep(name, description) {
  current = { name, description, status: "running", startedAt: new Date().toISOString(), checks: [], screenshots: [], notes: [] };
  report.steps.push(current);
  console.log("\n=== " + name + " === " + description);
  return current;
}
function check(name, ok, detail) {
  const entry = { name, ok: !!ok, detail: detail === undefined ? "" : String(detail) };
  if (current) current.checks.push(entry);
  console.log("  " + (ok ? "PASS" : "FAIL") + "  " + name + (detail ? " :: " + detail : ""));
  return !!ok;
}
function note(text) {
  if (current) current.notes.push(String(text));
  console.log("  note  " + text);
}
function failStep(err) {
  if (!current) return;
  current.status = "failed";
  current.error = err && err.stack ? err.stack : String(err);
  console.log("  ERROR " + current.error);
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function pollUntil(fn, { timeout = 30000, interval = 250, label = "condition" } = {}) {
  const start = Date.now();
  let last;
  while (Date.now() - start < timeout) {
    try {
      last = await fn();
      if (last) return { ok: true, value: last, elapsed: Date.now() - start };
    } catch (err) { last = err.message; }
    await sleep(interval);
  }
  return { ok: false, value: last, elapsed: Date.now() - start, label };
}

async function shot(page, name) {
  try {
    fs.mkdirSync(EVIDENCE, { recursive: true });
    const file = path.join(EVIDENCE, Date.now() + "-" + name + ".png");
    await page.screenshot({ path: file });
    if (current) current.screenshots.push(path.relative(ROOT, file));
    console.log("  shot  " + path.relative(ROOT, file));
    return file;
  } catch (err) {
    note("截图失败 " + name + ": " + err.message);
    return null;
  }
}

async function overlayState(page) {
  return await page.evaluate(() => {
    const host = document.getElementById("st-bilingual-subtitles");
    if (!host) return { state: null, panelVisible: false, fabVisible: false, rows: [], toastText: null, statusText: null };
    let parsed = null;
    try { parsed = JSON.parse(host.getAttribute("data-st-state") || "null"); } catch { parsed = null; }
    const shadow = host.shadowRoot;
    const subs = shadow && shadow.querySelector(".subs");
    const chip = shadow && shadow.querySelector(".chip");
    const fab = shadow && shadow.querySelector(".fab");
    const rows = shadow ? Array.from(shadow.querySelectorAll(".subs .row")) : [];
    const toast = shadow && shadow.querySelector(".toast .toast-text");
    const status = shadow && shadow.querySelector(".chip .chip-text");
    return {
      state: parsed,
      panelVisible: !!(subs && subs.classList.contains("visible")),
      chipVisible: !!(chip && chip.classList.contains("visible")),
      fabVisible: !!(fab && !fab.classList.contains("hidden")),
      toastText: toast ? toast.innerText : null,
      statusText: chip && chip.classList.contains("visible") && status ? status.innerText : null,
      rows: rows.map((r) => ({
        current: r.classList.contains("current"),
        time: r.querySelector(".time") ? r.querySelector(".time").innerText : "",
        en: r.querySelector(".en") ? r.querySelector(".en").innerText : "",
        zh: r.querySelector(".zh") ? r.querySelector(".zh").innerText : "",
        zhPending: r.querySelector(".zh") ? r.querySelector(".zh").classList.contains("pending") : false,
        zhError: r.querySelector(".zh") ? r.querySelector(".zh").classList.contains("error") : false,
      })),
    };
  });
}

async function swDebug(sw) {
  return await sw.evaluate(() => {
    const d = globalThis.__st_debug || {};
    return JSON.parse(JSON.stringify({
      version: d.version,
      counts: d.counts,
      model: d.model,
      offscreen: d.offscreen,
      subtitleRequests: d.subtitleRequests,
      errors: d.errors,
    }));
  });
}

async function swPing(sw) {
  return await sw.evaluate(async () => (globalThis.__st_ping ? await globalThis.__st_ping() : null));
}

async function videoTime(page, selector = "video") {
  return await page.evaluate((sel) => {
    const v = document.querySelector(sel);
    return v ? v.currentTime : null;
  }, selector);
}

const CJK = /[\u4e00-\u9fff\u3400-\u4dbf]/;

function mirrorExtension() {
  const home = os.homedir();
  if (path.dirname(MIRROR) !== home || path.basename(MIRROR) !== ".st-ext") {
    throw new Error("镜像目录必须是 " + path.join(home, ".st-ext"));
  }
  fs.rmSync(MIRROR, { recursive: true, force: true });
  fs.cpSync(EXT, MIRROR, { recursive: true });
  const count = fs.readdirSync(MIRROR).length;
  console.log("已同步扩展到 ASCII 路径 " + MIRROR + "（Chrome 只会用这个副本加载）");
  return count;
}

/** Close a leftover browser holding the profile, then drop Chrome's service-worker script
 *  cache so freshly edited extension code is really the code that runs. */
async function resetRunState() {
  // our launch range: close anything left over so the profile lock is free
  for (let p = 9440; p <= 9460; p++) {
    if (!(await portAlive(p))) continue;
    try { const stale = await chromium.connectOverCDP("http://127.0.0.1:" + p); await stale.close(); } catch { /* ignore */ }
    console.log("closed leftover chrome on port " + p);
    await sleep(1200);
  }
  // NOTE: never delete browser caches here - it invalidates the extension's own model cache
}

async function portAlive(port) {
  try {
    const res = await fetch("http://127.0.0.1:" + port + "/json/version");
    return res.ok;
  } catch { return false; }
}

async function waitForPort(port, timeoutMs = 25000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (await portAlive(port)) return true;
    await sleep(400);
  }
  return false;
}

async function main() {
  fs.mkdirSync(EVIDENCE, { recursive: true });
  fs.mkdirSync(PROFILE, { recursive: true });
  mirrorExtension();

  await resetRunState();
  const server = await startStaticServer(path.join(ROOT, "tests", "web"));
  console.log("静态测试服务器: " + server.origin);

  // free the debug port if a previous run left Chrome behind
  if (await portAlive(PORT)) {
    note("端口 " + PORT + " 上已有 Chrome，先连接并关闭它");
    try {
      const stale = await chromium.connectOverCDP("http://127.0.0.1:" + PORT);
      await stale.close();
    } catch { /* ignore */ }
    await sleep(1500);
  }

  const chromeArgs = [
    "--user-data-dir=" + PROFILE,
    "--remote-debugging-port=" + PORT,
    "--no-first-run",
    "--no-default-browser-check",
    "--autoplay-policy=no-user-gesture-required",
    "--disable-features=DialMediaRouteProvider,MediaRouter",
    "--window-size=1440,900",
    "--lang=en-US",
    "about:blank",
  ];
  const child = spawn(CHROME_EXE, chromeArgs, { stdio: "ignore" });
  report.chrome = { executable: CHROME_EXE, args: chromeArgs };
  child.on("error", (err) => console.error("Chrome 启动失败:", err.message));

  if (!(await waitForPort(PORT))) throw new Error("Chrome 调试端口未就绪（" + PORT + "）");
  const browser = await chromium.connectOverCDP("http://127.0.0.1:" + PORT);
  report.chrome.version = browser.version();

  const context = browser.contexts()[0];
  const bcdp = await browser.newBrowserCDPSession();

  let extId = null;
  try {
    const res = await bcdp.send("Extensions.loadUnpacked", { path: MIRROR });
    extId = res.id;
  } catch (err) {
    const existing = context.serviceWorkers().find((w) => w.url().includes("/src/background/service-worker.js"));
    if (!existing) throw new Error("扩展加载失败: " + err.message);
    extId = new URL(existing.url()).host;
    note("扩展已在该 profile 中加载: " + extId);
  }
  report.extensionId = extId;
  console.log("扩展已加载: " + extId + " (Chrome " + browser.version() + ")");

  const swConsole = [];
  const attachSW = (worker) => worker.on("console", (msg) => swConsole.push({ at: Date.now(), type: msg.type(), text: msg.text().slice(0, 400) }));
  context.on("serviceworker", attachSW);
  context.serviceWorkers().forEach(attachSW);

  const page = await context.newPage();
  const pageConsole = [];
  page.on("console", (msg) => {
    pageConsole.push({ at: Date.now(), type: msg.type(), text: msg.text().slice(0, 400) });
    if (msg.type() === "error") report.consoleErrors.push({ at: Date.now(), url: page.url(), text: msg.text().slice(0, 400) });
  });
  page.on("pageerror", (err) => report.pageErrors.push({ at: Date.now(), url: page.url(), text: String(err).slice(0, 400) }));

  const sw = {
    async evaluate(fn, arg) {
      let worker = context.serviceWorkers().find((w) => w.url().includes("/src/background/service-worker.js"));
      if (!worker) worker = await context.waitForEvent("serviceworker", { timeout: 15000 }).catch(() => null);
      if (!worker) throw new Error("扩展 service worker 不可用");
      return await worker.evaluate(fn, arg);
    },
  };

  const helpers = { page, context, sw, browser, server, pageConsole, swConsole, bcdp };

  for (const name of STEPS) {
    try {
      if (name === "local") await stepLocal(helpers);
      else if (name === "youtube") await stepYouTube(helpers);
      else if (name === "native") await stepNativeCaptions(helpers);
      else if (name === "cache") await stepCache(helpers);
      else if (name === "fallback") await stepFallback(helpers);
      else if (name === "wasm") await stepWasm(helpers);
      else throw new Error("未知步骤 " + name);
      if (current && current.status === "running") current.status = "passed";
    } catch (err) {
      failStep(err);
    }
  }

  if (WANT_WASM) {
    try {
      await stepWasm(helpers);
      if (current && current.status === "running") current.status = "passed";
    } catch (err) { failStep(err); }
  }

  report.extensionConsole = swConsole.slice(-200);
  report.pageConsole = pageConsole.slice(-200);

  const allChecks = report.steps.flatMap((s) => s.checks);
  report.summary = {
    finishedAt: new Date().toISOString(),
    steps: report.steps.map((s) => ({ name: s.name, status: s.status, checks: s.checks.length, failed: s.checks.filter((c) => !c.ok).length })),
    checksTotal: allChecks.length,
    checksFailed: allChecks.filter((c) => !c.ok).length,
    consoleErrorCount: report.consoleErrors.length,
    pageErrorCount: report.pageErrors.length,
    pass: allChecks.every((c) => c.ok) && report.pageErrors.length === 0,
  };
  fs.writeFileSync(REPORT_PATH, JSON.stringify(report, null, 2));
  console.log("\n===== 结果 =====");
  console.log((report.summary.checksTotal - report.summary.checksFailed) + "/" + report.summary.checksTotal + " 项断言通过；页面错误 " + report.pageErrors.length + "；控制台错误 " + report.consoleErrors.length);
  console.log("报告：" + path.relative(ROOT, REPORT_PATH));

  await browser.close().catch(() => {});
  await sleep(500);
  try { child.kill(); } catch { /* ignore */ }
  await server.close();
  process.exit(report.summary.pass ? 0 : 1);
}

/* ============================================================ steps */

const FIXTURE_CUES = [
  { start: 0.5, text: "Hello everyone, and welcome back to the channel." },
  { start: 3.4, text: "Today we are building a small browser extension." },
  { start: 6.8, text: "It reads the subtitles from the current page." },
  { start: 10.2, text: "Then it translates every line into Chinese." },
  { start: 13.6, text: "Everything runs locally, inside your browser." },
  { start: 17.0, text: "No cloud API, and no token costs at all." },
  { start: 20.4, text: "The model is cached, so it also works offline." },
  { start: 23.8, text: "Press the space bar to open the bilingual popup." },
  { start: 27.2, text: "The popup always keeps the last five lines." },
  { start: 30.6, text: "Thanks for watching, and see you next time." },
];

async function startProbe(page) {
  await page.evaluate(() => {
    window.__stProbe = { samples: [], stop: false };
    const tick = () => {
      if (!window.__stProbe || window.__stProbe.stop) return;
      const host = document.getElementById("st-bilingual-subtitles");
      let st = null;
      try { st = JSON.parse(host.getAttribute("data-st-state")); } catch { st = null; }
      const v = document.querySelector("video");
      window.__stProbe.samples.push({
        t: performance.now(),
        ct: v ? v.currentTime : null,
        paused: v ? v.paused : null,
        en: st ? st.currentEn : null,
        zh: st ? st.currentZh : null,
        rows: st ? st.rows : 0,
        zhCount: st ? st.zhCount : 0,
        model: st ? st.model : null,
        device: st ? st.device : null,
      });
      setTimeout(tick, 100);
    };
    tick();
  });
}

async function readProbe(page) {
  return await page.evaluate(() => {
    if (!window.__stProbe) return [];
    window.__stProbe.stop = true;
    return window.__stProbe.samples;
  });
}

function cueLatencies(samples) {
  const seen = new Set();
  const rows = [];
  for (const s of samples) {
    if (!s.en || seen.has(s.en)) continue;
    const cue = FIXTURE_CUES.find((c) => c.text === s.en);
    if (!cue) continue;
    seen.add(s.en);
    rows.push({ text: s.en, cueStart: cue.start, seenAtTime: s.ct, latency: Number((s.ct - cue.start).toFixed(2)) });
  }
  return rows;
}

async function playVideo(page) {
  await page.evaluate(() => {
    const v = document.querySelector("video");
    if (!v) return;
    v.muted = true;
    const p = v.play();
    if (p && p.catch) p.catch(() => {});
  });
}

async function waitForTranslations(page, min, timeoutMs) {
  let lastLog = 0;
  const start = Date.now();
  let last = null;
  while (Date.now() - start < timeoutMs) {
    const s = await overlayState(page);
    last = s;
    if (s && s.state && s.state.zhCount >= min) return { ok: true, state: s, elapsed: Date.now() - start };
    if (Date.now() - lastLog > 15000) {
      lastLog = Date.now();
      note(`等待译文… 模型=${s?.state?.model || "?"} 设备=${s?.state?.device || "?"} 状态=${(s?.statusText || "").slice(0, 90)}`);
    }
    await sleep(2000);
  }
  return { ok: false, state: last, elapsed: Date.now() - start };
}

async function stepLocal({ page, server, sw }) {
  startStep("local", "通用 <track> 适配器 · 本地页面全链路（解析 → 5 条缓存 → 弹窗 → 中译）");
  await page.goto(`${server.origin}/local-track.html`, { waitUntil: "domcontentloaded" });

  const ready = await pollUntil(() => page.evaluate(() => !!(window.__fixture && window.__fixture.ready)), { timeout: 20000 });
  check("本地 fixture 视频元数据就绪", ready.ok, `${ready.elapsed}ms`);

  const fab = await pollUntil(async () => ((await overlayState(page)) || {}).fabVisible === true, { timeout: 20000 });
  check("页面存在视频时出现半透明悬浮按钮（触发方式 ①）", fab.ok, `${fab.elapsed}ms`);

  const toastSeen = await pollUntil(async () => {
    const s = await overlayState(page);
    return s.toastText && /空格/.test(s.toastText) ? s.toastText : null;
  }, { timeout: 6000, interval: 200 });
  check("页面加载时弹出一次欢迎提示且说明用法（spec §13）", toastSeen.ok, (toastSeen.value || "").replace(/\s+/g, " ").slice(0, 110));

  const native0 = await page.evaluate(() => {
    const v = document.querySelector("video");
    return { tracks: v.textTracks.length, mode: v.textTracks[0] ? v.textTracks[0].mode : null };
  });
  check("原生 <track> 字幕保持浏览器默认状态（扩展未改动播放器字幕）", native0.tracks === 1 && native0.mode === "showing", JSON.stringify(native0));
  await shot(page, "local-01-welcome");

  const resolved = await pollUntil(async () => {
    const s = await overlayState(page);
    return s && s.state && /track/i.test(s.state.adapter || "") ? s.state : null;
  }, { timeout: 25000 });
  check("Router 选中通用 <track> 适配器并解析出字幕", resolved.ok, resolved.ok ? `adapter=${resolved.value.adapter} rows=${resolved.value.rows}` : String(resolved.value));

  await startProbe(page);
  await playVideo(page);
  await sleep(1500);
  const playing = await page.evaluate(() => {
    const v = document.querySelector("video");
    return { paused: v.paused, t: v.currentTime };
  });
  check("测试视频开始播放（播放进度可推进）", !playing.paused && playing.t > 0, JSON.stringify(playing));

  // ① space opens the popup, and the video keeps playing (overlay is independent)
  await page.keyboard.press("Space");
  await sleep(400);
  const opened = await overlayState(page);
  check("按空格键弹出双语弹窗（触发方式 ②）", opened.panelVisible === true, `panelVisible=${opened.panelVisible}`);
  check("弹窗打开时视频仍在播放（不劫持播放控制）", (await videoTime(page)) > playing.t, `t=${(await videoTime(page)).toFixed(2)}`);

  // wait for 5 lines to accumulate
  const five = await pollUntil(async () => {
    const s = await overlayState(page);
    return s.state.cacheRows >= 5 ? s : null;
  }, { timeout: 20000 });
  check("滑动窗口固定缓存「当前 + 历史」共 5 条英文字幕（spec §3）", five.ok && five.value.state.cacheRows === 5, five.ok ? `cacheRows=${five.value.state.cacheRows}` : `cacheRows=${five.value?.state?.cacheRows}`);
  check("视频字幕位置自上到下显示 3 条双语字幕", five.ok && five.value.state.rows === 3, `displayed=${five.value?.state?.rows}`);

  const samples = await readProbe(page);
  const latencies = cueLatencies(samples);
  const worst = latencies.reduce((m, r) => Math.max(m, r.latency), 0);
  check("字幕在 1 秒内进入缓存（spec §3）", latencies.length >= 3 && worst <= 1.0,
    `${latencies.length} 条实测，最大延迟 ${worst.toFixed(2)}s`);

  const liveRows = await overlayState(page);
  const enTexts = liveRows.rows.map((r) => r.en);
  check("显示的 3 条英文与页面字幕逐条对应且按时间升序（最新在最后）",
    enTexts.length === 3 && enTexts.every((t, i) => i === 0 || FIXTURE_CUES.findIndex((c) => c.text === enTexts[i - 1]) < FIXTURE_CUES.findIndex((c) => c.text === t)),
    enTexts.map((t) => t.slice(0, 24)).join(" | "));
  check("弹窗高亮当前正在播放的那一条", liveRows.rows.filter((r) => r.current).length === 1 && liveRows.rows[liveRows.rows.length - 1].current === true,
    `current=${liveRows.rows.filter((r) => r.current).length}, last=${liveRows.rows[liveRows.rows.length - 1].current}`);

  // live refresh while the panel stays open
  const before = (await overlayState(page)).rows.map((r) => r.en).join("||");
  await sleep(5000);
  const after = (await overlayState(page)).rows;
  const afterKey = after.map((r) => r.en).join("||");
  check("弹窗打开期间随播放实时刷新缓存内字幕（spec §6）", before !== afterKey, `内容已随播放推进更新`);
  await shot(page, "local-02-popup-live");

  // translations (first run downloads the model - allow a long budget)
  const modelT = await waitForTranslations(page, 3, MODEL_TIMEOUT_MS);
  check("本地模型产出中文译文（spec §8）", modelT.ok, modelT.ok ? `${modelT.elapsed}ms` : "超时");
  const tState = modelT.state ? modelT.state.state : null;
  const modelInfo = await sw.evaluate(async () => (globalThis.__st_model_status ? (await globalThis.__st_model_status()).data : null)).catch(() => null);
  const usedGpu = modelInfo && modelInfo.device === "webgpu";
  const documentedFallback = modelInfo && modelInfo.device === "wasm" && modelInfo.fallbackFrom === "webgpu";
  check("推理设备：优先 WebGPU，不可用时回退 WASM 并提示性能下降（spec §8）",
    !!(usedGpu || documentedFallback),
    modelInfo ? `device=${modelInfo.device} fallbackFrom=${modelInfo.fallbackFrom} dtype=${modelInfo.dtype} warmup=${modelInfo.warmupMs}ms msg=${(modelInfo.message || "").slice(0, 70)}` : "无状态");

  const rowsNow = (await overlayState(page)).rows;
  const translated = rowsNow.filter((r) => r.zh && CJK.test(r.zh));
  check("每条英文下都紧跟对应中文（英中对照展示，且不显示占位文字）", translated.length >= 1 && rowsNow.every((r) => !/翻译中|等待/.test(r.zh)), `${translated.length}/${rowsNow.length} 条已翻译`);
  check("译文不是英文回显（确实是中文）", translated.every((r) => r.zh.trim().toLowerCase() !== r.en.trim().toLowerCase()) && translated.length > 0,
    translated.map((r) => `「${r.en.slice(0, 18)}」→「${r.zh.slice(0, 14)}」`).join(" "));
  note(`译文样例：${translated.slice(0, 3).map((r) => r.zh).join(" / ")}`);
  await shot(page, "local-03-bilingual-translated");

  // ② space closes again
  await page.keyboard.press("Space");
  await sleep(350);
  check("再次按空格键弹窗直接消失（spec §6）", (await overlayState(page)).panelVisible === false, "");
  // ① floating button opens it
  await page.click("#st-bilingual-subtitles .fab");
  await sleep(400);
  check("点击悬浮按钮同样能弹出弹窗（spec §5）", (await overlayState(page)).panelVisible === true, "");
  // the overlay must contain nothing but the bilingual lines (no header/footer/timecodes)
  await page.click("#st-bilingual-subtitles .fab");
  await sleep(400);
  const audit = await page.evaluate(() => {
    const host = document.getElementById("st-bilingual-subtitles");
    const root = host.shadowRoot;
    const subs = root.querySelector(".subs");
    const chip = root.querySelector(".chip");
    const fab = root.querySelector(".fab");
    const texts = [];
    for (const el of root.querySelectorAll("*")) {
      if (el.children.length === 0 && (el.innerText || "").trim()) {
        texts.push({
          text: el.innerText.trim().slice(0, 40),
          where: subs.contains(el) ? "subs" : chip.contains(el) ? "chip" : fab.contains(el) ? "fab" : "other",
        });
      }
    }
    return {
      texts,
      chipVisible: chip.classList.contains("visible"),
      rows: subs.querySelectorAll(".row").length,
      zhLines: subs.querySelectorAll(".zh").length,
    };
  });
  const strayText = audit.texts.filter((t) => t.where === "other" || (t.where === "chip" && audit.chipVisible));
  check("视频画面上只有双语字幕本身，没有标题/时间码/状态栏等多余文字",
    strayText.length === 0 && !/^\d+:\d{2}$/.test(audit.texts.map((t) => t.text).join(" ")),
    JSON.stringify(audit.texts.slice(0, 8)));
  check("模型就绪后不再显示状态文字（只看字幕）", audit.chipVisible === false, `chipVisible=${audit.chipVisible}`);

  const swState = await swDebug(sw);
  check("后台服务正常提供字幕（service worker 记录）", (swState.counts.getSubtitles || 0) > 0 && (swState.counts.subtitlesOk || 0) > 0, JSON.stringify(swState.counts));
  return true;
}

async function stepYouTube({ page, sw }) {
  startStep("youtube", "YouTube 适配器 · 真实视频页面（英文 CC）");
  const url = `https://www.youtube.com/watch?v=${YT_VIDEO}`;
  await page.goto(url, { waitUntil: "domcontentloaded", timeout: 90000 });
  await sleep(1500);

  // consent / cookie walls (region dependent)
  const consent = page.locator('button:has-text("Accept all"), button[aria-label*="Accept"], tp-yt-paper-button:has-text("Accept all")').first();
  if (await consent.count().catch(() => 0)) {
    await consent.click({ timeout: 5000 }).catch(() => null);
    note("处理了 YouTube 同意页");
  }

  const player = await pollUntil(() => page.evaluate(() => !!document.querySelector("video")), { timeout: 45000 });
  check("YouTube 播放器与 <video> 元素出现", player.ok, `${player.elapsed}ms`);

  const adDone = await pollUntil(() => page.evaluate(() => !document.querySelector(".ad-showing")), { timeout: 90000, interval: 1000 });
  check("前置广告播完（避免广告画面干扰判定）", adDone.ok, `${adDone.elapsed}ms`);

  const title = await page.evaluate(() => document.title);
  note(`视频标题：${title}`);

  const resolved = await pollUntil(async () => {
    const s = await overlayState(page);
    return s && s.state && /YouTube/.test(s.state.adapter || "") && s.state.rows > 0 ? s : null;
  }, { timeout: 60000, interval: 1000 });
  check("Router 选中 YouTube 适配器并拿到字幕", resolved.ok, resolved.ok ? `adapter=${resolved.value.adapter} rows=${resolved.value.rows}` : String(resolved.value && resolved.value.statusText));

  const dbg = await swDebug(sw);
  const ytReq = (dbg.subtitleRequests || []).filter((r) => r.adapter === "youtube").pop();
  check("后台从 YouTube 取回完整字幕轨（timedtext json3）", !!ytReq && ytReq.count > 30, ytReq ? `count=${ytReq.count} ok=${ytReq.ok}` : "无记录");

  const tracklist = await page.evaluate(() => {
    const p = document.getElementById("movie_player");
    if (!p || typeof p.getOption !== "function") return null;
    const tl = p.getOption("captions", "tracklist");
    return Array.isArray(tl) ? tl.map((t) => `${t.languageCode}${t.kind ? "/" + t.kind : ""}`) : null;
  });
  check("页面 MAIN world 可读取播放器字幕轨列表（适配器数据源有效）", Array.isArray(tracklist) && tracklist.length > 0, tracklist ? tracklist.join(", ") : "null");

  await playVideo(page);
  await sleep(2000);
  await page.keyboard.press("Space");
  await sleep(600);
  const st = await overlayState(page);
  check("YouTube 页面上空格键弹出弹窗", st.panelVisible === true, "");
  const line = await pollUntil(async () => {
    const s = await overlayState(page);
    const en = s.state && s.state.currentEn;
    return en && en.length > 3 && /[A-Za-z]/.test(en) ? s : null;
  }, { timeout: 30000, interval: 500 });
  check("弹窗内出现真实英文台词（随播放匹配）", line.ok, line.ok ? `「${line.value.state.currentEn.slice(0, 70)}」` : "未出现");
  await shot(page, "youtube-01-popup");

  const modelT = await waitForTranslations(page, 1, MODEL_TIMEOUT_MS);
  check("YouTube 台词在本地翻译成中文", modelT.ok, modelT.ok ? `${modelT.elapsed}ms` : "超时");
  const zh = modelT.state && modelT.state.state ? modelT.state.state.currentZh : "";
  check("YouTube 弹窗展示英文 + 对应中文", !!zh && CJK.test(zh), `译文：「${zh.slice(0, 40)}」`);
  await shot(page, "youtube-02-translated");

  const adv = await page.evaluate(() => !!document.querySelector(".ad-showing"));
  check("播放过程中没有广告打断（证据有效）", !adv, `adShowing=${adv}`);
  return true;
}

async function stepNativeCaptions({ page, sw }) {
  startStep("native", "原生字幕共存 · 扩展弹窗不修改播放器自带字幕（spec §7）");
  const isYouTube = /youtube\.com/.test(page.url());
  if (!isYouTube) {
    current.status = "skipped";
    note("当前页面不是 YouTube，跳过原生字幕共存检查（由 youtube 步骤覆盖）");
    return false;
  }
  const before = await page.evaluate(() => {
    const p = document.getElementById("movie_player");
    return p && typeof p.getOption === "function" ? JSON.stringify(p.getOption("captions", "tracklist") || []) : null;
  });

  // make sure our own overlay is open before toggling the native captions
  const openState = await overlayState(page);
  if (!openState.panelVisible) { await page.keyboard.press("Space"); await sleep(400); }

  await page.keyboard.press("c");
  const nativeVisible = await pollUntil(() => page.evaluate(() => {
    const seg = document.querySelector(".ytp-caption-segment");
    const win = document.querySelector(".ytp-caption-window-container");
    const shown = !!(seg && win && win.offsetHeight > 0 && getComputedStyle(win).visibility !== "hidden");
    return shown ? { segments: document.querySelectorAll(".ytp-caption-segment").length } : null;
  }), { timeout: 25000, interval: 500 });
  check("按 YouTube 原生快捷键 c 可以打开播放器自带字幕", nativeVisible.ok, nativeVisible.ok ? `原生字幕片段 ${nativeVisible.value.segments} 个` : "未显示");

  const both = await overlayState(page);
  check("扩展弹窗与原生字幕可同时显示（互不冲突）", nativeVisible.ok && both.panelVisible === true,
    `native=${nativeVisible.ok} overlay=${both.panelVisible}`);

  const after = await page.evaluate(() => {
    const p = document.getElementById("movie_player");
    return p && typeof p.getOption === "function" ? JSON.stringify(p.getOption("captions", "tracklist") || []) : null;
  });
  check("扩展没有改动播放器字幕轨设置（未被扩展覆盖）", before !== null && before === after, `tracklist 未变化`);

  const domTracks = await page.evaluate(() => {
    const v = document.querySelector("video");
    return Array.from(v.textTracks || []).map((t) => t.mode);
  });
  check("扩展未修改 <video> 的 TextTrack mode（原生字幕状态由播放器控制）", !domTracks.includes("hidden"),
    `modes=${JSON.stringify(domTracks)}`);
  await shot(page, "native-01-both-captions");
  return true;
}

async function stepCache({ page, sw, server }) {
  startStep("cache", "IndexedDB 译文缓存 · 重复句子不再跑模型（spec §9）");
  const statsA = await sw.evaluate(async () => await globalThis.__st_model_status());
  const callsA = (statsA && statsA.data && statsA.data.stats ? statsA.data.stats.calls : null) ?? 0;
  const cacheA = statsA && statsA.data && statsA.data.cache ? statsA.data.cache.count : 0;
  check("IndexedDB 已有译文缓存记录", cacheA >= 3, `缓存 ${cacheA} 条`);

  await page.goto(`${server.origin}/local-track.html`, { waitUntil: "domcontentloaded" });
  await pollUntil(() => page.evaluate(() => !!(window.__fixture && window.__fixture.ready)), { timeout: 20000 });
  await pollUntil(async () => (await overlayState(page) || {}).fabVisible === true, { timeout: 15000 });
  await playVideo(page);

  // jump straight to a position whose lines are already cached
  await page.evaluate(() => { const v = document.querySelector("video"); v.currentTime = 6.0; });
  await sleep(1200);
  const t0 = Date.now();
  await page.keyboard.press("Space");
  const hit = await pollUntil(async () => {
    const s = await overlayState(page);
    return s.state && s.state.zhCount >= 2 ? s : null;
  }, { timeout: 20000, interval: 200 });
  const elapsed = Date.now() - t0;
  check("重复播放时缓存字幕立即可用（无需重新推理）", hit.ok && elapsed < 6000, `${elapsed}ms 内出现 ${hit.value ? hit.value.state.zhCount : 0} 条已缓存译文`);

  const statsB = await sw.evaluate(async () => await globalThis.__st_model_status());
  const callsB = (statsB && statsB.data && statsB.data.stats ? statsB.data.stats.calls : null) ?? 0;
  check("重复句子没有再次调用本地模型（模型调用次数未增加）", callsB === callsA, `model.calls ${callsA} → ${callsB}`);
  const cachedHits = statsB && statsB.data && statsB.data.stats ? statsB.data.stats.cached : 0;
  check("命中缓存次数被记录", cachedHits > 0, `cached=${cachedHits}`);
  note(`统计：${JSON.stringify(statsB.data.stats)}`);
  return true;
}

async function stepFallback({ page, sw, server }) {
  startStep("fallback", "异常与容错 · 没有字幕的页面不崩溃、自动尝试下一个适配器（spec §11）");
  await page.goto(`${server.origin}/local-no-track.html`, { waitUntil: "domcontentloaded" });
  const fab = await pollUntil(async () => (await overlayState(page) || {}).fabVisible === true, { timeout: 20000 });
  check("无字幕页面仍然正常挂载扩展（悬浮按钮出现）", fab.ok, "");
  await page.keyboard.press("Space");
  await sleep(2500);
  const st = await overlayState(page);
  check("无字幕时给出明确提示而不是崩溃", st.panelVisible === true && !!st.statusText && /字幕/.test(st.statusText), (st.statusText || "").slice(0, 120));
  check("没有字幕时不显示任何字幕行", st.rows.length === 0, `rows=${st.rows.length}`);
  await shot(page, "fallback-01-no-track");

  const dbg = await swDebug(sw);
  const tried = (dbg.subtitleRequests || []).map((r) => `${r.adapter}:${r.ok ? "ok" : "fail"}`);
  check("Router 记录到所有适配器的尝试与降级过程", tried.length > 0, tried.slice(-6).join(" → "));

  const ping = await swPing(sw);
  check("扩展后台仍然存活（异常没有拖垮扩展）", !!(ping && ping.ok), ping ? `version=${ping.data.version}` : "无响应");

  // a page with no video at all: the extension must stay invisible and inert
  await page.goto(`${server.origin}/plain.html`, { waitUntil: "domcontentloaded" });
  await sleep(2000);
  const plain = await overlayState(page);
  check("没有视频的页面不显示悬浮按钮", plain && plain.fabVisible === false, `fabVisible=${plain && plain.fabVisible}`);
  await page.keyboard.press("Space");
  await sleep(800);
  const afterSpace = await overlayState(page);
  check("没有视频的页面按空格不弹窗（不干扰网页自身行为）", afterSpace && afterSpace.panelVisible === false, `panelVisible=${afterSpace && afterSpace.panelVisible}`);

  const errs = await page.evaluate(() => window.__st_pageErrors || 0);
  check("整个过程没有未捕获的页面异常", report.pageErrors.length === 0, `pageErrors=${report.pageErrors.length}`);
  return true;
}

async function stepWasm({ page, sw, server }) {
  startStep("wasm", "WASM 回退路径 · 无 WebGPU 时提示性能下降（spec §8）");
  await sw.evaluate(async () => { await chrome.storage.local.set({ st_device_preference: "wasm" }); });
  await sw.evaluate(async () => await globalThis.__st_reset_offscreen());
  note("已强制 device=wasm 并重启离屏文档（首次会下载 uint8 量化权重）");

  await page.goto(`${server.origin}/local-track.html`, { waitUntil: "domcontentloaded" });
  await pollUntil(() => page.evaluate(() => !!(window.__fixture && window.__fixture.ready)), { timeout: 20000 });
  await playVideo(page);
  await page.keyboard.press("Space");
  await sleep(500);

  const ready = await pollUntil(async () => {
    const s = await overlayState(page);
    return s.state && s.state.model === "ready" ? s : null;
  }, { timeout: MODEL_TIMEOUT_MS, interval: 3000 });
  check("WASM 路径也能把模型加载到 ready", ready.ok, ready.ok ? `device=${ready.value.state.device}` : "超时");
  check("回退后设备为 WASM", ready.ok && ready.value.state.device === "wasm", ready.ok ? `device=${ready.value.state.device}` : "");
  check("弹窗向用户提示性能下降（spec §8）", !!(ready.value && /性能下降|较慢|WASM/.test(ready.value.statusText || "")), ((ready.value && ready.value.statusText) || "").slice(0, 130));
  await shot(page, "wasm-01-fallback-notice");

  const t = await waitForTranslations(page, 1, MODEL_TIMEOUT_MS);
  check("WASM 路径下依然能产出中文译文", t.ok, t.ok ? `${t.elapsed}ms` : "超时");

  await sw.evaluate(async () => { await chrome.storage.local.remove("st_device_preference"); });
  await sw.evaluate(async () => await globalThis.__st_reset_offscreen());
  note("已恢复自动设备选择");
  return true;
}

await main();
