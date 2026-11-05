// Caption acquisition that needs either page context (page globals / same-site cookies)
// or extension privileges (cross-origin fetch without CORS). Everything returns
// [{start, end, text}] with seconds.
import { parseJson3, pickCaptionTrack } from "../parsers/json3.js";
import { parseBilibiliSubtitle, pickBilibiliTrack } from "../parsers/bilibili.js";
import { parseVtt, looksLikeVtt } from "../parsers/vtt.js";
import { finalizeCues } from "../parsers/common.js";

/* ==================================================================== YouTube */

/** Runs in the page's MAIN world (stringified by chrome.scripting.executeScript). */
function ytDiscoverTracksInPage() {
  const out = { tracks: null, source: null, errors: [] };
  const take = (tracks, source) => {
    if (out.tracks && out.tracks.length) return;
    if (Array.isArray(tracks) && tracks.length) {
      out.tracks = tracks.map((t) => ({
        baseUrl: t.baseUrl || t.url || "",
        languageCode: t.languageCode || t.language || "",
        kind: t.kind || "",
        vssId: t.vssId || "",
        name: t.name && t.name.simpleText ? t.name.simpleText : t.name || "",
        isTranslatable: !!t.isTranslatable,
      }));
      out.source = source;
    }
  };
  try {
    const pr = window.ytInitialPlayerResponse;
    if (pr) take(pr.captions && pr.captions.playerCaptionsTracklistRenderer && pr.captions.playerCaptionsTracklistRenderer.captionTracks, "ytInitialPlayerResponse");
  } catch (e) { out.errors.push("ytInitialPlayerResponse: " + e.message); }
  try {
    const player = document.getElementById("movie_player");
    if (player && typeof player.getPlayerResponse === "function") {
      const pr = player.getPlayerResponse();
      take(pr && pr.captions && pr.captions.playerCaptionsTracklistRenderer && pr.captions.playerCaptionsTracklistRenderer.captionTracks, "movie_player.getPlayerResponse");
    }
    if (player && typeof player.getOption === "function") {
      const tl = player.getOption("captions", "tracklist");
      if (Array.isArray(tl) && tl.length) {
        take(tl.map((t) => ({ baseUrl: t.baseUrl || t.url, languageCode: t.languageCode, kind: t.kind, name: t.name })), "movie_player.getOption");
      }
    }
  } catch (e) { out.errors.push("movie_player: " + e.message); }
  try {
    const el = document.querySelector("video");
    if (el && el.textTracks) {
      out.domTrackCount = el.textTracks.length;
      out.domCueCounts = Array.from(el.textTracks).map((t) => (t && t.cues ? t.cues.length : 0));
    }
  } catch (e) { out.errors.push("textTracks: " + e.message); }
  return out;
}

/** Runs in the page's MAIN world: fetch the timedtext URL with the page's own origin. */
async function ytFetchTimedtextInPage(baseUrl) {
  try {
    const url = new URL(baseUrl, location.href);
    url.searchParams.set("fmt", "json3");
    const res = await fetch(url.toString(), { credentials: "include" });
    const text = await res.text();
    return { ok: res.ok, status: res.status, length: text.length, body: text.slice(0, 4000000) };
  } catch (e) {
    return { ok: false, error: String(e && e.message ? e.message : e) };
  }
}

export async function resolveYouTube(tabId, { videoId, pageUrl }) {
  if (!Number.isFinite(tabId)) throw new Error("缺少标签页 ID");
  const injected = await chrome.scripting.executeScript({
    target: { tabId, allFrames: false },
    world: "MAIN",
    func: ytDiscoverTracksInPage,
  });
  const info = injected && injected[0] && injected[0].result;
  const tracks = (info && info.tracks) || [];
  if (!tracks.length) {
    return {
      cues: [],
      reason: `页面没有暴露字幕轨（${(info && info.errors || []).join("；") || "视频可能没有 CC/自动字幕"}）`,
      tracks: [],
      domCueCounts: (info && info.domCueCounts) || [],
    };
  }
  const track = pickCaptionTrack(tracks, ["en", "en-US", "en-GB", "en-orig"]);
  if (!track || !track.baseUrl) return { cues: [], reason: "字幕轨缺少地址", tracks };

  const url = new URL(track.baseUrl, pageUrl || "https://www.youtube.com/");
  url.searchParams.set("fmt", "json3");

  let text = "";
  let fromPage = false;
  try {
    const res = await fetch(url.toString(), { credentials: "include" });
    text = await res.text();
  } catch (err) {
    text = "";
  }
  if (!text || text.length < 8) {
    const inPage = await chrome.scripting.executeScript({
      target: { tabId, allFrames: false },
      world: "MAIN",
      func: ytFetchTimedtextInPage,
      args: [track.baseUrl],
    });
    const r = inPage && inPage[0] && inPage[0].result;
    if (r && r.ok && r.body) { text = r.body; fromPage = true; }
  }
  const cues = parseJson3(text);
  return {
    cues,
    tracks,
    track: { languageCode: track.languageCode, kind: track.kind, name: track.name, vssId: track.vssId },
    format: "json3",
    transport: fromPage ? "page" : "service-worker",
    reason: cues.length ? "" : "字幕数据为空（该视频可能没有英文字幕）",
  };
}

/* ==================================================================== Bilibili */

/** Runs in the bilibili page's MAIN world so cookies/referer are those of the page. */
async function biliResolveInPage(bvid, aid, page) {
  const result = { cues: [], track: null, reason: "", debug: {} };
  const json = async (url) => {
    const res = await fetch(url, { credentials: "include" });
    if (!res.ok) throw new Error(`${res.status} ${url}`);
    return res.json();
  };
  try {
    const q = bvid ? `bvid=${encodeURIComponent(bvid)}` : `aid=${encodeURIComponent(aid)}`;
    const view = await json(`https://api.bilibili.com/x/web-interface/view?${q}`);
    if (view.code !== 0) throw new Error(`view: ${view.code} ${view.message}`);
    const data = view.data;
    const pageObj = (data.pages || []).find((p) => Number(p.page) === Number(page)) || data.pages[0] || {};
    const cid = pageObj.cid || data.cid;
    result.debug.aid = data.aid;
    result.debug.cid = cid;
    const player = await json(`https://api.bilibili.com/x/player/v2?aid=${data.aid}&cid=${cid}${bvid ? `&bvid=${encodeURIComponent(bvid)}` : ""}`);
    if (player.code !== 0) throw new Error(`player/v2: ${player.code} ${player.message}`);
    const subs = (player.data && player.data.subtitle && player.data.subtitle.subtitles) || [];
    result.debug.subtitleCount = subs.length;
    result.debug.langs = subs.map((s) => s.lan);
    if (!subs.length) throw new Error("该视频没有可用字幕（可能需要登录或该视频无 CC）");
    const isEn = (lan) => /^(en|ai-en)/i.test(String(lan || ""));
    const pick = subs.find((s) => isEn(s.lan) && s.subtitle_url);
    if (!pick) {
      const langs = subs.map((s) => s.lan).filter(Boolean).join(" / ");
      throw new Error("该视频只有非英文字幕（" + (langs || "未知") + "），没有英文字幕");
    }
    result.track = { lan: pick.lan, lan_doc: pick.lan_doc, id: pick.id };
    let subUrl = pick.subtitle_url;
    if (subUrl.indexOf("//") === 0) subUrl = "https:" + subUrl;
    const sub = await json(subUrl);
    result.cues = (sub.body || []).map((i) => ({ start: Number(i.from), end: Number(i.to), text: String(i.content || "") }));
  } catch (e) {
    result.reason = String(e && e.message ? e.message : e);
  }
  return result;
}

const isBilibiliUrl = (u) => /^https?:\/\/([^/]*\.)?bilibili\.com\//i.test(String(u || ""));

export async function resolveBilibili(tabId, { bvid, aid, page, pageUrl }) {
  let reason = "";
  if (Number.isFinite(tabId) && isBilibiliUrl(pageUrl)) {
    try {
      const injected = await chrome.scripting.executeScript({
        target: { tabId, allFrames: false },
        world: "MAIN",
        func: biliResolveInPage,
        args: [bvid || "", aid || "", Number(page) || 1],
      });
      const r = injected && injected[0] && injected[0].result;
      if (r && r.cues && r.cues.length) {
        return { cues: finalizeCues(r.cues), track: r.track, source: "player-v2(page)", debug: r.debug };
      }
      reason = (r && r.reason) || "页面内解析失败";
    } catch (err) {
      reason = `页面注入失败: ${err && err.message ? err.message : err}`;
    }
  }
  // Fallback: public endpoints from the extension context.
  try {
    const q = bvid ? `bvid=${encodeURIComponent(bvid)}` : `aid=${encodeURIComponent(aid)}`;
    const view = await fetch(`https://api.bilibili.com/x/web-interface/view?${q}`, { credentials: "include" }).then((r) => r.json());
    if (view.code === 0) {
      const data = view.data;
      const pageObj = (data.pages || []).find((p) => Number(p.page) === Number(page)) || data.pages[0] || {};
      const cid = pageObj.cid || data.cid;
      const player = await fetch(
        `https://api.bilibili.com/x/player/v2?aid=${data.aid}&cid=${cid}${bvid ? `&bvid=${encodeURIComponent(bvid)}` : ""}`,
        { credentials: "include" }
      ).then((r) => r.json());
      const subs = (player.data && player.data.subtitle && player.data.subtitle.subtitles) || [];
      // 只要英文字幕：没有英文轨就不要把中文字幕当原文（交给上层的 OCR/ASR 兜底）
      const enSubs = subs.filter((x) => x && x.subtitle_url && /^(en|ai-en)/i.test(String(x.lan || "")));
      if (!enSubs.length) {
        const langs = subs.map((x) => x && x.lan).filter(Boolean).join(" / ");
        throw new Error("该视频只有非英文字幕（" + (langs || "未知") + "），没有英文字幕");
      }
      const track = pickBilibiliTrack(enSubs, ["en-US", "en", "ai-en"]);
      if (track && track.subtitle_url) {
        let subUrl = track.subtitle_url;
        if (subUrl.indexOf("//") === 0) subUrl = "https:" + subUrl;
        const sub = await fetch(subUrl, { credentials: "include" }).then((r) => r.json());
        const cues = parseBilibiliSubtitle(sub);
        if (cues.length) return { cues, track, source: "player-v2(sw)" };
        reason = reason || "字幕内容为空";
      } else {
        reason = reason || "接口未返回字幕轨";
      }
    } else {
      reason = reason || `view 接口返回 ${view.code} ${view.message || ""}`;
    }
  } catch (err) {
    reason = reason || `接口请求失败: ${err && err.message ? err.message : err}`;
  }
  return { cues: [], reason: reason || "未获取到 B 站字幕" };
}

/* ==================================================================== <track> */

export async function resolveTrackSrc({ src }) {
  if (!/^https?:/i.test(String(src || ""))) return { cues: [], reason: "不是 http(s) 字幕地址" };
  try {
    const res = await fetch(src, { credentials: "include" });
    if (!res.ok) return { cues: [], reason: `HTTP ${res.status}` };
    const text = await res.text();
    if (!text || !text.trim()) return { cues: [], reason: "字幕文件为空" };
    let cues = [];
    let format = "vtt";
    const trimmed = text.trim();
    if (trimmed.startsWith("{") || trimmed.startsWith("[")) {
      try {
        const json = JSON.parse(trimmed);
        if (Array.isArray(json)) {
          cues = json.map((i) => ({ start: Number(i.start ?? i.from), end: Number(i.end ?? i.to), text: String(i.text ?? i.content ?? "") }));
          format = "json";
        } else {
          cues = parseJson3(json);
          format = "json3";
        }
      } catch { /* fall through to vtt */ }
    }
    if (!cues.length && looksLikeVtt(trimmed)) {
      cues = parseVtt(trimmed);
      format = /^\s*\d+\s*\n/.test(trimmed) && !/^\uFEFF?\s*WEBVTT/.test(trimmed) ? "srt" : "vtt";
    }
    if (!cues.length) cues = parseVtt(trimmed); // last resort: try the tolerant parser anyway
    return { cues: finalizeCues(cues), format, reason: cues.length ? "" : "解析后没有字幕内容" };
  } catch (err) {
    return { cues: [], reason: `请求失败: ${err && err.message ? err.message : err}` };
  }
}