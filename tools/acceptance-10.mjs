import { chromium } from "playwright";
import fs from "node:fs";
import path from "node:path";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const platform = process.argv[2] || "youtube";
const onlyArg = process.argv.find((a) => a.startsWith("--only="));
const ratioArg = process.argv.find((a) => a.startsWith("--ratio="));
const ratioOverride = ratioArg ? Number(ratioArg.slice("--ratio=".length)) : null;
const only = onlyArg ? onlyArg.slice("--only=".length).split(",").filter(Boolean) : null;
const official = !only;
const LISTS = JSON.parse(fs.readFileSync(".playtest/video-lists.json", "utf8"));
const IDS = {
  youtube: ["T8BpYoMdcww","RVzIGNFyvYU","nh36jE2M064","52t241OQ7Ec","FPsUIuKo6M8","EoOkWxc0-j0","mGmI9kGA_fA","gLdgEYAxJ8A","LTVk3yUb5Mg","Ge7c7otG2mk"],
  bilibili: ["BV15b411L7M4","BV1vmLp6YERf","BV1ZV411a7Fc","BV11K2YBnEtF","BV1qQ4y1U7SP","BV1fzVHzGE74","BV144411b7Uk","BV15uJi6rEF3","BV1a34y1u7z5","BV1Ph411s7jp"],
  douyin: ["7628617795365915955","7695793771383934218","7624578798001294003","7615841204400112505","7673104793703770089","7558961011962973491","7633019029120374001","7693358228889046312","7696727148106665258","7696531132234322597"]
};
const ids = IDS[platform];
if (!ids) { console.error("unknown platform", platform); process.exit(2); }
const all = LISTS[platform] || [];
function parseDuration(value) {
  const s = String(value || "").trim().split(/\s+/)[0];
  const parts = s.split(":").map((x) => Number(x));
  if (parts.some((x) => !Number.isFinite(x))) return 0;
  if (parts.length === 3) return parts[0] * 3600 + parts[1] * 60 + parts[2];
  if (parts.length === 2) return parts[0] * 60 + parts[1];
  return parts[0] || 0;
}const byId = (v) => v.id || v.bvid;
const missing = ids.filter((id) => !all.find((v) => byId(v) === id));
if (missing.length) {
  console.error("MISSING IDS", JSON.stringify(missing));
  const results = missing.map((id) => ({ id, pass: false, error: "missing-from-video-lists" }));
  fs.writeFileSync(".playtest/acceptance-10-" + platform + ".json", JSON.stringify({ platform, official, total: ids.length, passCount: 0, results }, null, 2));
  process.exit(1);
}
const items = ids.map((id) => all.find((v) => byId(v) === id)).filter((v) => !only || only.includes(byId(v)));
if (official && items.length !== 10) { console.error("official run must contain exactly 10 videos, got", items.length); process.exit(2); }

const browser = await chromium.connectOverCDP("http://127.0.0.1:9222");
const ctx = browser.contexts()[0];
const bcdp = await browser.newBrowserCDPSession();
const extPath = process.env.ST_EXT_PATH || path.join(process.cwd(), "extension");
const extId = (await bcdp.send("Extensions.loadUnpacked", { path: extPath })).id;
await sleep(4000);
const extPage = await ctx.newPage();
for (let i = 0; i < 10; i++) {
  try { await extPage.goto("chrome-extension://" + extId + "/src/ui/action-popup.html", { waitUntil: "domcontentloaded", timeout: 15000 }); break; } catch { await sleep(800); }
}
async function clearTranslationCache() {
  try {
    return await extPage.evaluate(() => new Promise((res) => chrome.runtime.sendMessage({ type: "st:clear-cache" }, (x) => res(x || { err: chrome.runtime.lastError && chrome.runtime.lastError.message }))));
  } catch (e) { return { err: String(e && e.message ? e.message : e) }; }
}
async function ensureOfflineEngine() {
  const t0 = Date.now();
  try {
    const sw = ctx.serviceWorkers().find((w) => w.url().includes("service-worker.js"));
    if (sw) await sw.evaluate(() => globalThis.__st_reset_offscreen && globalThis.__st_reset_offscreen()).catch(() => null);
    await sleep(1200);
    await extPage.evaluate(() => new Promise((res) => chrome.storage.local.set({ st_engine: "mt" }, () => res(true))));
    await extPage.evaluate(() => new Promise((res) => chrome.runtime.sendMessage({ type: "st:set-device-preference", payload: { preference: "wasm", dtype: null } }, (x) => res(x || {}))));
    for (let attempt = 0; attempt < 3; attempt++) {
      await extPage.evaluate(() => new Promise((res) => chrome.runtime.sendMessage({ type: "st:preload-model" }, (x) => res(x || {}))));
      for (let i = 0; i < 60; i++) {
        const r = await extPage.evaluate(() => new Promise((res) => chrome.runtime.sendMessage({ type: "st:model-status" }, (x) => res(x || {}))));
        const d = (r && r.data) || {};
        if (d.state === "ready" && d.engine && d.engine !== "groq") {
          await sleep(1500);
          const r2 = await extPage.evaluate(() => new Promise((res) => chrome.runtime.sendMessage({ type: "st:model-status" }, (x) => res(x || {}))));
          const d2 = (r2 && r2.data) || {};
          if (d2.state === "ready" && d2.engine && d2.engine !== "groq") return { ok: true, engine: d2.engine, device: d2.device, dtype: d2.dtype, ms: Date.now() - t0, attempt };
        }
        if (d.state === "error") break;
        await sleep(1000);
      }
      await sleep(1000);
    }
  } catch (e) { return { ok: false, error: String(e && e.message ? e.message : e) }; }
  return { ok: false, error: "offline-engine-not-ready", ms: Date.now() - t0 };
}
async function warmAuxEngines() {
  try {
    await extPage.evaluate(() => new Promise((res) => chrome.runtime.sendMessage({ type: "st:asr-preload" }, x => res(x || {}))));
    if (platform !== "youtube") {
      const png = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";
      await extPage.evaluate((dataUrl) => new Promise((res) => chrome.runtime.sendMessage({ type: "st:ocr-test", payload: { dataUrl } }, x => res(x || {}))), png);
    }
  } catch { /* best effort */ }
}
async function waitForTranslationReady() {
  for (let i = 0; i < 60; i++) {
    const r = await extPage.evaluate(() => new Promise((res) => chrome.runtime.sendMessage({ type: "st:model-status" }, (x) => res(x || {}))));
    const d = (r && r.data) || {};
    if (d.state === "ready" && d.engine && d.engine !== "groq") return true;
    if (d.state === "error") return false;
    if (i === 15) {
      const sw = ctx.serviceWorkers().find((w) => w.url().includes("service-worker.js"));
      if (sw) await sw.evaluate(() => globalThis.__st_reset_offscreen && globalThis.__st_reset_offscreen()).catch(() => null);
      await sleep(1200);
      await extPage.evaluate(() => new Promise((res) => chrome.runtime.sendMessage({ type: "st:set-device-preference", payload: { preference: "wasm", dtype: null } }, (x) => res(x || {}))));
      await extPage.evaluate(() => new Promise((res) => chrome.runtime.sendMessage({ type: "st:preload-model" }, (x) => res(x || {}))));
    }
    await sleep(1000);
  }
  return false;
}
const engineSetup = await ensureOfflineEngine();
console.log("ENGINE " + JSON.stringify(engineSetup));
await warmAuxEngines();
async function pageAudioStats(url) {
  try {
    return await extPage.evaluate((u) => new Promise(async (res) => {
      const tabs = await chrome.tabs.query({});
      const tab = tabs.find((t) => String(t.url || "") === u || String(t.url || "").includes(u));
      if (!tab) return res(null);
      chrome.tabs.sendMessage(tab.id, { type: "st:audio-stats" }, (x) => res(x || null));
    }), url);
  } catch { return null; }
}
async function state(page) {
  return await page.evaluate(() => {
    const h = document.getElementById("st-bilingual-subtitles");
    if (!h) return null;
    try { return JSON.parse(h.getAttribute("data-st-state") || "{}"); } catch { return null; }
  });
}
const clean = (t) => String(t || "").replace(/\[[^\]]*\]/g, " ").replace(/\s+/g, " ").trim();
const goodEn = (t) => {
  const x = clean(t);
  const words = x.split(" ").filter(Boolean);
  const letters = (x.match(/[A-Za-z]/g) || []).length;
  return words.length >= 3 && letters >= 6;
};
const goodZh = (t) => {
  const x = String(t || "").replace(/\s+/g, "").trim();
  return (x.match(/[\u4e00-\u9fff]/g) || []).length >= 2;
};
async function waitVideo(page) {
  for (let i = 0; i < 80; i++) {
    if (await page.evaluate(() => !!document.querySelector("video"))) return true;
    await sleep(500);
  }
  return false;
}
async function playbackInfo(page) {
  return await page.evaluate(() => {
    const v = document.querySelector("video");
    if (!v) return null;
    return { paused: !!v.paused, t: Number(v.currentTime) || 0, ready: Number(v.readyState) || 0, muted: !!v.muted, volume: Number(v.volume), duration: Number(v.duration) || 0 };
  });
}
async function waitForMainVideo(page, expected) {
  let stable = 0, last = 0;
  for (let i = 0; i < 180; i++) {
    const info = await page.evaluate(() => {
      const v = document.querySelector("video");
      const ad = document.querySelector(".ytp-ad-player-overlay,.ytp-ad-player-overlay-layout");
      const skip = document.querySelector(".ytp-ad-skip-button,.ytp-ad-skip-button-modern");
      return { d: Number(v && v.duration) || 0, ad: !!(ad && ad.offsetParent !== null), skip: !!(skip && skip.offsetParent !== null) };
    }).catch(() => null);
    if (!info) { await sleep(1000); continue; }
    if (info.skip) await page.evaluate(() => { const b = document.querySelector(".ytp-ad-skip-button,.ytp-ad-skip-button-modern"); if (b) b.click(); }).catch(() => {});
    if (expected > 0 && Math.abs(info.d - expected) < 5) return { ok: true, d: info.d };
    if (!info.ad && info.d > 60 && Math.abs(info.d - last) < 0.5) {
      stable++;
      if (stable >= 3) return { ok: true, d: info.d, warning: "youtube-duration-mismatch-but-main-video" };
    } else stable = 0;
    last = info.d;
    if (info.ad) await sleep(1000); else await sleep(1000);
  }
  return { ok: false, d: last };
}
async function ensurePlaying(page) {
  await page.click("video", { timeout: 3000 }).catch(() => {});
  await page.evaluate(() => { const b = document.querySelector(".ytp-large-play-button"); if (b) b.click(); }).catch(() => {});
  for (let i = 0; i < 30; i++) {
    const a = await playbackInfo(page);
    if (a && !a.paused && a.ready >= 2) {
      await sleep(1200);
      const b = await playbackInfo(page);
      if (b && !b.paused && b.t > a.t + 0.7) return true;
    }
    await page.evaluate(() => { const v = document.querySelector("video"); if (v) v.play().catch(() => {}); }).catch(() => {});
    await sleep(500);
  }
  return false;
}
async function waitAd(page) {
  if (platform !== "youtube") return true;
  for (let i = 0; i < 40; i++) {
    const ad = await page.evaluate(() => {
      const a = document.querySelector(".ytp-ad-player-overlay,.ytp-ad-player-overlay-layout");
      return !!(a && a.offsetParent !== null);
    });
    if (!ad) return true;
    await page.evaluate(() => { const b = document.querySelector(".ytp-ad-skip-button,.ytp-ad-skip-button-modern"); if (b) b.click(); }).catch(() => {});
    await sleep(1000);
  }
  return false;
}
async function testOne(item) {
  const page = await ctx.newPage();
  const id = byId(item);
  const started = Date.now();
  const result = { id, url: item.url, title: item.title || "", pass: false, cacheCleared: false };
  try {
    const cache = await clearTranslationCache();
    result.cacheCleared = !!(cache && cache.ok !== false);
    await page.goto(item.url, { waitUntil: "domcontentloaded", timeout: 90000 });
    if (!await waitVideo(page)) { result.error = "no-video"; return result; }
    await page.bringToFront();
    if (!await waitAd(page)) { result.error = "ad-timeout"; return result; }
    if (platform === "youtube") {
      try { await page.click("video", { timeout: 3000 }); } catch {}
      await page.keyboard.press("c");
      await sleep(1200);
    }
    const expected = parseDuration(item.duration);
    result.expectedDuration = expected;
    // YouTube 广告/占位视频用列表时长做正片判定；B 站/抖音的列表时长可能是合集/分P元数据，不能据此判失败。
    const enforceExpected = platform === "youtube" && expected > 0;
    let mainInfo = null;
    if (enforceExpected) {
      mainInfo = await waitForMainVideo(page, expected);
      if (!mainInfo.ok) { result.duration = Math.round(mainInfo.d || 0); result.error = "duration-mismatch-ad-or-placeholder"; return result; }
      if (mainInfo.warning) result.durationWarning = mainInfo.warning;
    } else {
      await page.waitForFunction(() => { const v = document.querySelector("video"); return v && Number(v.duration) > 1; }, { timeout: 30000 }).catch(() => {});
    }
    const dur = (mainInfo ? mainInfo.d : ((await playbackInfo(page))?.duration || 0));
    result.duration = Math.round(dur);
    if (!(dur > 0)) { result.error = "no-duration"; return result; }
    if (!enforceExpected && expected > 0 && Math.abs(dur - expected) >= 5) result.durationWarning = "list-duration-mismatch";
    const ratio = Number.isFinite(ratioOverride) && ratioOverride > 0 && ratioOverride < 1 ? ratioOverride : (dur < 180 ? 0.6 : 0.3);
    const baseStart = dur > 30 ? Math.min(Math.max(5, dur * ratio), dur - 25) : 0;
    result.start = Math.round(baseStart);
    result.engineWaitMs = 0;
    if (!await waitForTranslationReady()) { result.error = "engine-not-ready"; return result; }
    await page.keyboard.press("z");
    await sleep(600);
    // 英文预扫描：只找“有英文”的分段，不因翻译失败而换位置。找到后只测一次 20 秒同句翻译。
    const scanPositions = [];
    let firstEnSeen = false;
    let last = null;
    for (let scan = 0; scan < 6; scan++) {
      const pos = scan === 0 ? baseStart : Math.min(baseStart + scan * 30, Math.max(0, dur - 25));
      if (scan > 0 && pos <= baseStart + (scan - 1) * 30) break;
      scanPositions.push(Math.round(pos));
      await page.evaluate(({ t, mute }) => { const v = document.querySelector("video"); if (v) { v.muted = mute; if (!mute) v.volume = 0.05; try { v.currentTime = t; } catch {} v.play().catch(() => {}); } }, { t: pos, mute: platform === "youtube" }).catch(() => {});
      await sleep(1200);
      if (!await ensurePlaying(page)) { if (scan === 5) { result.error = "not-playing"; return result; } continue; }
      result.playing = true;
      const englishWaitStart = Date.now();
      while (Date.now() - englishWaitStart < 10000) {
        const s = await state(page);
        last = s;
        if (s) {
          const rows = Array.isArray(s.displayed) ? s.displayed : [];
          const current = rows.find((x) => x && x.current) || null;
          const en = clean(current ? current.en : s.currentEn);
          if (goodEn(en)) { firstEnSeen = true; result.englishAtMs = Date.now() - englishWaitStart; result.englishScanAt = Math.round(pos); break; }
          const zh = String(current ? current.zh : s.currentZh || "").trim();
          const source = current ? current.source || "" : "";
          result.last = { adapter: s.adapter || "", status: s.statusText || "", currentEn: en.slice(0, 120), currentZh: zh.slice(0, 80), source };
        }
        await sleep(250);
      }
      if (firstEnSeen) break;
    }
    result.scanPositions = scanPositions;
    if (!firstEnSeen) {
      result.adapter = (last && last.adapter) || result.adapter || "";
      result.audioStats = (await pageAudioStats(page.url()))?.data || null;
      result.elapsedMs = Date.now() - started;
      result.error = "no-english-found";
      return result;
    }
    const t0 = Date.now();
    let pair = null;
    while (Date.now() - t0 < 20000) {
      const s = await state(page);
      last = s;
      if (s) {
        const rows = Array.isArray(s.displayed) ? s.displayed : [];
        for (const row of rows) {
          const en = clean(row && row.en);
          const zh = String((row && row.zh) || "").trim();
          if (goodEn(en) && goodZh(zh)) {
            pair = { en, zh, source: (row && row.source) || "", adapter: s.adapter || "", atMs: Date.now() - t0 };
            break;
          }
        }
        if (pair) break;
        const current = rows.find((x) => x && x.current) || null;
        const en = clean(current ? current.en : s.currentEn);
        const zh = String(current ? current.zh : s.currentZh || "").trim();
        const source = current ? current.source || "" : "";
        result.last = { adapter: s.adapter || "", status: s.statusText || "", currentEn: en.slice(0, 120), currentZh: zh.slice(0, 80), source };
      }
      await sleep(250);
    }
    result.adapter = (last && last.adapter) || result.adapter || "";
    result.audioStats = (await pageAudioStats(page.url()))?.data || null;
    result.elapsedMs = Date.now() - started;
    if (pair) {
      result.pass = true;
      result.en = pair.en;
      result.zh = pair.zh;
      result.source = pair.source;
      result.pairAtMs = pair.atMs;
    } else {
      result.error = result.error || "no-current-bilingual-pair-within-20s";
    }
    return result;
  } catch (e) {
    result.error = String(e && e.message ? e.message : e);
    return result;
  } finally {
    await page.close().catch(() => {});
  }
}
const results = [];
for (const item of items) {
  const r = await testOne(item);
  results.push(r);
  console.log(JSON.stringify({ id: r.id, pass: r.pass, source: r.source || "", en: (r.en || "").slice(0, 80), zh: (r.zh || "").slice(0, 50), pairAtMs: r.pairAtMs || null, error: r.error || "", start: r.start }));
}
const passCount = results.filter((x) => x.pass).length;
const report = { platform, official, timestamp: new Date().toISOString(), engineSetup, total: items.length, passCount, startRule: "start at 30% (>=180s) or 60% (<180s); pre-scan up to 6 positions only until English is found; then one 20s same-cue Chinese window; no retry after English; cache cleared; ads handled", results };
const out = official ? ".playtest/acceptance-10-" + platform + ".json" : ".playtest/acceptance-10-" + platform + "-debug.json";
fs.writeFileSync(out, JSON.stringify(report, null, 2));
console.log("SUMMARY " + platform + " " + passCount + "/" + items.length + (official ? " OFFICIAL" : " DEBUG"));
await extPage.close().catch(() => {});
process.exit(official ? (passCount === 10 ? 0 : 1) : (passCount === items.length ? 0 : 1));