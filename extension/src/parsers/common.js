// Shared cue text/timestamp helpers. Used by the service worker (ESM) and unit tests.

/** "01:02:03.456" | "02:03.456" | "02:03,456" -> seconds (number) */
export function parseTimestamp(stamp) {
  const s = String(stamp).trim().replace(",", ".");
  const parts = s.split(":");
  if (parts.length < 2 || parts.length > 3) return NaN;
  const sec = parseFloat(parts[parts.length - 1]);
  const min = parseInt(parts[parts.length - 2], 10);
  const hr = parts.length === 3 ? parseInt(parts[0], 10) : 0;
  if (!Number.isFinite(sec) || !Number.isFinite(min) || !Number.isFinite(hr)) return NaN;
  return hr * 3600 + min * 60 + sec;
}

/** Collapse whitespace, drop inline markup leftovers, decode the entities that show up in captions. */
export function normalizeCueText(text) {
  if (!text) return "";
  let t = String(text);
  t = t.replace(/\uFEFF/g, "");
  t = t.replace(/<br\s*\/?>/gi, " ");
  t = t.replace(/<[^>]*>/g, "");        // <c>, <v Speaker>, <00:00:01.000>, <i>, ...
  t = t.replace(/&nbsp;/gi, " ");
  t = t.replace(/&lt;/gi, "<").replace(/&gt;/gi, ">");
  t = t.replace(/&quot;/gi, '"').replace(/&#39;/gi, "'");
  t = t.replace(/&amp;/gi, "&");
  t = t.replace(/[\r\n\t]+/g, " ");
  t = t.replace(/\s{2,}/g, " ");
  return t.trim();
}

/** Sort + drop empty / zero-length cues, guarantee ascending start times. */
export function finalizeCues(cues) {
  const out = [];
  for (const c of cues || []) {
    if (!c) continue;
    const text = normalizeCueText(c.text);
    const start = Number(c.start);
    let end = Number(c.end);
    if (!text) continue;
    if (!Number.isFinite(start)) continue;
    if (!Number.isFinite(end) || end <= start) end = start + 1.5;
    out.push({ start, end, text });
  }
  out.sort((a, b) => a.start - b.start || a.end - b.end);
  return out;
}