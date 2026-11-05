// Parser: bilibili subtitle json (https://aisubtitle.hdslb.com/...) -> [{start, end, text}]
import { normalizeCueText, finalizeCues } from "./common.js";

export function parseBilibiliSubtitle(payload) {
  let data = payload;
  if (typeof data === "string") {
    try { data = JSON.parse(data); } catch { return []; }
  }
  const body = Array.isArray(data?.body) ? data.body : [];
  const cues = [];
  for (const item of body) {
    if (!item) continue;
    const start = Number(item.from);
    let end = Number(item.to);
    const text = normalizeCueText(item.content);
    if (!text || !Number.isFinite(start)) continue;
    if (!Number.isFinite(end) || end <= start) end = start + 1.5;
    cues.push({ start, end, text });
  }
  return finalizeCues(cues);
}

/** Choose the best subtitle track from /x/player/v2 payload. English (or zh->en) first, manual over AI. */
export function pickBilibiliTrack(subtitles, preferredLangs = ["en-US", "en", "ai-en"]) {
  if (!Array.isArray(subtitles) || subtitles.length === 0) return null;
  const usable = subtitles.filter((s) => s && typeof s.subtitle_url === "string" && s.subtitle_url);
  if (usable.length === 0) return null;
  const score = (s) => {
    const lan = String(s.lan || "").toLowerCase();
    let v = 0;
    const idx = preferredLangs.findIndex((p) => lan === p.toLowerCase());
    if (idx >= 0) v -= (10 - idx);
    if (!/en/.test(lan)) v += 30;
    if (String(s.type) === "0" || String(s.type) === "1") v -= 1;
    return v;
  };
  return usable.slice().sort((a, b) => score(a) - score(b))[0];
}