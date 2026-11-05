// Parsers: WebVTT and SubRip -> [{start, end, text}]
import { parseTimestamp, normalizeCueText, finalizeCues } from "./common.js";

const SKIP_BLOCK = /^(NOTE|STYLE|REGION)\b/i;

/**
 * Tolerant WebVTT / SRT parser.
 * Handles: WEBVTT headers, cue identifiers, cue settings, X-TIMESTAMP-MAP, NOTE/STYLE/REGION
 * blocks, both "." and "," decimal separators, multi-line cue bodies.
 */
export function parseVtt(input) {
  if (!input) return [];
  const lines = String(input).replace(/^\uFEFF/, "").replace(/\r\n?/g, "\n").split("\n");
  const cues = [];
  let i = 0;

  // Leading blank lines, then the WEBVTT signature line plus its header block
  // (Kind:/Language: metadata) up to the first blank line. Servers that ship plain
  // SRT under a .vtt extension still work: cue parsing below is identical.
  while (i < lines.length && lines[i].trim() === "") i++;
  if (i < lines.length && /^WEBVTT/i.test(lines[i].trim())) {
    i++;
    while (i < lines.length && lines[i].trim() !== "") i++;
  }

  let skippedNote = false;
  while (i < lines.length) {
    let line = lines[i].trim();
    if (line === "") { i++; skippedNote = false; continue; }
    if (SKIP_BLOCK.test(line)) {
      // Consume the whole block (until blank line)
      i++;
      while (i < lines.length && lines[i].trim() !== "") i++;
      continue;
    }
    if (/^X-TIMESTAMP-MAP/i.test(line)) { i++; continue; }

    let timing = line;
    let id = null;
    if (!timing.includes("-->")) {
      // This line is a cue identifier; the timing line follows.
      id = timing;
      i++;
      if (i >= lines.length) break;
      timing = lines[i].trim();
    }
    if (skippedNote) { i++; continue; }
    if (!timing.includes("-->")) { i++; continue; }

    const [rawStart, rest] = timing.split("-->");
    const endToken = (rest || "").trim().split(/\s+/)[0];
    const start = parseTimestamp(rawStart);
    const end = parseTimestamp(endToken);
    i++;

    const body = [];
    while (i < lines.length && lines[i].trim() !== "") { body.push(lines[i]); i++; }
    const text = normalizeCueText(body.join("\n"));
    if (text && Number.isFinite(start)) {
      cues.push({ start, end: Number.isFinite(end) ? end : start + 1.5, text, id: id || undefined });
    }
  }
  return finalizeCues(cues);
}

/** SRT is a VTT dialect with commas; reuse the tolerant parser. */
export function parseSrt(input) {
  return parseVtt(input);
}

export function looksLikeVtt(input) {
  const s = String(input || "");
  return /^\uFEFF?\s*WEBVTT/.test(s) || s.includes("-->") || /^\s*NOTE\b/m.test(s);
}