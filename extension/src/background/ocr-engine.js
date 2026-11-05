// 离屏 OCR 引擎：扩展自己的页面里跑 tesseract（离线，资源已随扩展打包）
import "../shared/cross-check.js";
import "../shared/ocr-text.js";
let workerPromise = null;

function workerOptions() {
  const url = (p) => chrome.runtime.getURL(p);
  return {
    workerPath: url("vendor/ocr/worker.min.js"),
    corePath: url("vendor/ocr/tesseract-core-simd-lstm.wasm.js"),
    langPath: url("vendor/ocr"),
    cacheMethod: "none",
    workerBlobURL: false,
    gzip: true,
    legacyCore: false,
    legacyLang: false,
  };
}

async function getWorker() {
  if (!window.Tesseract) throw new Error("OCR 引擎没有加载");
  if (!workerPromise) {
    workerPromise = (async () => {
      const w = await window.Tesseract.createWorker("eng", 1, workerOptions());
      try { await w.setParameters({ tessedit_pageseg_mode: "6", preserve_interword_spaces: "1" }); } catch { }
      return w;
    })();
  }
  return await workerPromise;
}

export async function recognizeImage(dataUrl) {
  const worker = await getWorker();
  const { data } = await worker.recognize(dataUrl);
  const words = Array.isArray(data && data.words)
    ? data.words.map((w) => ({ text: String(w.text || "").trim(), confidence: Number(w.confidence || 0), bbox: w.bbox || null })).filter((w) => w.text)
    : [];
  const lines = Array.isArray(data && data.lines)
    ? data.lines.map((l) => ({ text: String(l.text || "").trim(), confidence: Number(l.confidence || 0), bbox: l.bbox || null })).filter((l) => l.text)
    : [];
  return { text: String((data && data.text) || ""), confidence: Number((data && data.confidence) || 0), words, lines };
}

function bandDataUrl(video) {
  const w = Number(video.videoWidth) || 0, h = Number(video.videoHeight) || 0;
  if (!w || !h || !window.ST || !ST.ocr) return "";
  const band = ST.ocr.pickSubtitleBand(w, h, 0.24);
  const scale = Math.min(2, 1280 / band.sw);
  const cw = Math.max(1, Math.round(band.sw * scale));
  const ch = Math.max(1, Math.round(band.sh * scale));
  const c = document.createElement("canvas");
  c.width = cw; c.height = ch;
  const g = c.getContext("2d", { willReadFrequently: true });
  g.drawImage(video, band.sx, band.sy, band.sw, band.sh, 0, 0, cw, ch);
  try {
    const img = g.getImageData(0, 0, cw, ch);
    const d = img.data;
    for (let i = 0; i < d.length; i += 4) {
      const lum = 0.299 * d[i] + 0.587 * d[i + 1] + 0.114 * d[i + 2];
      const v = lum > 165 ? 255 : 0;
      d[i] = d[i + 1] = d[i + 2] = v;
    }
    g.putImageData(img, 0, 0);
  } catch { /* ignore */ }
  return { dataUrl: c.toDataURL("image/png"), height: ch };
}

/** 抓视频文件 → 离屏解码 → 按时间抽底部字幕带 → OCR */
export async function recognizeVideoUrl(url, opts) {
  const o = opts || {};
  const step = Math.max(1, Number(o.step) || 2);
  const maxFrames = Math.min(120, Number(o.maxFrames) || 40);
  const res = await fetch(url, { credentials: "include" });
  if (!res.ok) throw new Error("视频下载失败 " + res.status);
  const blob = await res.blob();
  const objUrl = URL.createObjectURL(blob);
  const v = document.createElement("video");
  v.muted = true;
  v.preload = "auto";
  v.src = objUrl;
  await new Promise((ok, bad) => {
    const to = setTimeout(() => bad(new Error("视频解码超时")), 20000);
    v.onloadedmetadata = () => { clearTimeout(to); ok(); };
    v.onerror = () => { clearTimeout(to); bad(new Error("视频解码失败")); };
    v.load();
  });
  const dur = Number(v.duration) || 0;
  if (!Number.isFinite(dur) || dur <= 0) { try { v.src = ""; } catch { } URL.revokeObjectURL(objUrl); throw new Error("视频不可按时间点定位"); }
  const out = [];
  const seek = (t) => new Promise((ok) => {
    const h = () => { v.removeEventListener("seeked", h); ok(); };
    v.addEventListener("seeked", h);
    v.currentTime = t;
  });
  for (let t = Math.min(1, dur / 2), n = 0; t < dur - 0.2 && n < maxFrames; t += step, n++) {
    try {
      await seek(t);
      const cap = bandDataUrl(v);
      if (!cap || !cap.dataUrl) continue;
      const { data } = await (await getWorker()).recognize(cap.dataUrl);
      const conf = Number((data && data.confidence) || 0);
      if (conf < 45) continue;
      let cleaned = "";
      if (ST.ocr && ST.ocr.selectOcrLines) cleaned = ST.ocr.selectOcrLines(data && data.lines, cap.height);
      if (!cleaned && ST.ocr && ST.ocr.selectOcrWords) cleaned = ST.ocr.selectOcrWords(data && data.words, cap.height);
      if (!cleaned) cleaned = ST.ocr && ST.ocr.cleanOcrText ? ST.ocr.cleanOcrText(String((data && data.text) || "")) : String((data && data.text) || "").trim();
      if (cleaned) out.push({ start: t, end: Math.min(dur, t + step), text: cleaned, confidence: conf });
    } catch { /* 单帧失败继续 */ }
  }
  try { v.src = ""; } catch { /* ignore */ }
  URL.revokeObjectURL(objUrl);

  const merged = [];
  for (const cue of out) {
    const prev = merged[merged.length - 1];
    const same = prev && cue.start - prev.start <= step * 1.6 && ST.textSimilarity &&
      ST.textSimilarity(prev.text, cue.text) >= 0.62;
    if (!same) { merged.push({ ...cue, samples: [{ text: cue.text, confidence: cue.confidence }] }); continue; }
    prev.samples.push({ text: cue.text, confidence: cue.confidence });
    while (prev.samples.length > 3) prev.samples.shift();
    const vote = ST.ocr && ST.ocr.consensusOcrText ? ST.ocr.consensusOcrText(prev.samples) : null;
    prev.text = (vote && vote.text) || prev.text;
    prev.confidence = Math.max(prev.confidence, cue.confidence);
    prev.end = cue.end;
  }
  const cues = merged.map(({ samples, ...cue }) => cue);
  return { cues, duration: dur };
}

export async function closeOcr() {
  if (!workerPromise) return;
  const w = await workerPromise.catch(() => null);
  workerPromise = null;
  try { if (w) await w.terminate(); } catch { /* ignore */ }
}
