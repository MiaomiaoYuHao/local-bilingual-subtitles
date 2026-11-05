// Parser: YouTube `fmt=json3` timedtext payload -> [{start, end, text}]
import { normalizeCueText, finalizeCues } from "./common.js";

export function parseJson3(payload) {
  let data = payload;
  if (typeof data === "string") {
    try { data = JSON.parse(data); } catch { return []; }
  }
  const events = Array.isArray(data?.events) ? data.events : [];
  const cues = [];
  for (let i = 0; i < events.length; i++) {
    const ev = events[i];
    if (!ev || typeof ev !== "object") continue;
    const segs = Array.isArray(ev.segs) ? ev.segs : null;
    if (!segs || segs.length === 0) continue; // window/position events carry no text
    const text = segs.map((s) => (typeof s?.utf8 === "string" ? s.utf8 : "")).join("");
    const clean = normalizeCueText(text);
    if (!clean) continue;
    const start = Number(ev.tStartMs) / 1000;
    if (!Number.isFinite(start)) continue;
    let end = Number.isFinite(Number(ev.dDurationMs)) && Number(ev.dDurationMs) > 0
      ? start + Number(ev.dDurationMs) / 1000
      : NaN;
    if (!Number.isFinite(end)) {
      const nxt = events[i + 1];
      const nextStart = nxt && Number.isFinite(Number(nxt.tStartMs)) ? Number(nxt.tStartMs) / 1000 : NaN;
      end = Number.isFinite(nextStart) && nextStart > start ? nextStart : start + 2;
    }
    cues.push({ start, end, text: clean });
  }
  return finalizeCues(cues);
}

/** Pick the best track object out of the caption track list that YouTube embeds in the watch page. */
export function pickCaptionTrack(tracks, preferredLangs = ["en", "en-US", "en-GB"]) {
  if (!Array.isArray(tracks) || tracks.length === 0) return null;
  const usable = tracks.filter((t) => t && typeof t.baseUrl === "string" && t.baseUrl);
  if (usable.length === 0) return null;
  const score = (t) => {
    const lang = String(t.languageCode || "").toLowerCase();
    let s = 0;
    if (String(t.kind || "") === "asr") s += 5;             // manual captions beat auto ones
    const idx = preferredLangs.findIndex((p) => lang === p.toLowerCase() || lang.startsWith(p.split("-")[0]));
    if (idx >= 0) s -= idx * 2;
    if (!lang.startsWith("en")) s += 40;
    if (t.isTranslatable) s -= 1;
    return s;
  };
  return usable.slice().sort((a, b) => score(a) - score(b))[0];
}