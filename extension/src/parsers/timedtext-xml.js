// Parser for the srv3 / "p-t" caption payloads YouTube's player may receive.
import { normalizeCueText, finalizeCues } from "./common.js";

/** <transcript><text start="1.2" dur="3.4">Hello</text>...</transcript> */
function parseClassicSrv3(xml) {
  const cues = [];
  const re = /<text\b([^>]*)>([\s\S]*?)<\/text>/g;
  let m;
  while ((m = re.exec(xml))) {
    const attrs = m[1];
    const body = m[2];
    const start = /start="([\d.]+)"/.exec(attrs);
    const dur = /dur="([\d.]+)"/.exec(attrs);
    const s = start ? parseFloat(start[1]) : NaN;
    if (!Number.isFinite(s)) continue;
    const d = dur ? parseFloat(dur[1]) : NaN;
    cues.push({ start: s, end: Number.isFinite(d) ? s + d : s + 1.5, text: normalizeCueText(body.replace(/<[^>]*>/g, " ")) });
  }
  return cues;
}

/** <timedtext><body><p t="1200" d="3400"><s>He</s><s>llo</s></p>...</body></timedtext> */
function parsePTimedtext(xml) {
  const cues = [];
  const re = /<p\b([^>]*)>([\s\S]*?)<\/p>/g;
  let m;
  while ((m = re.exec(xml))) {
    const attrs = m[1];
    const body = m[2];
    const t = /\bt="(\d+)"/.exec(attrs);
    const d = /\bd="(\d+)"/.exec(attrs);
    const ms = t ? parseInt(t[1], 10) : NaN;
    if (!Number.isFinite(ms)) continue;
    const dur = d ? parseInt(d[1], 10) : NaN;
    const text = normalizeCueText(body.replace(/<[^>]*>/g, ""));
    if (!text) continue;
    const start = ms / 1000;
    cues.push({ start, end: Number.isFinite(dur) ? start + dur / 1000 : start + 1.5, text });
  }
  return cues;
}

/** Try both known XML shapes; return [] when the payload is not XML captions. */
export function parseTimedtextXml(input) {
  const xml = String(input || "");
  if (!xml || xml[0] !== "<") return [];
  const cues = xml.indexOf("<p ") !== -1 || xml.indexOf("<p>") !== -1 ? parsePTimedtext(xml) : [];
  const fallback = cues.length ? cues : parseClassicSrv3(xml);
  return finalizeCues(fallback);
}