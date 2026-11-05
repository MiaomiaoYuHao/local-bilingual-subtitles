// 离屏 ASR：Whisper（transformers.js，首次下载后离线）
let asrPromise = null;

async function getAsr() {
  if (!asrPromise) {
    asrPromise = (async () => {
      const mod = await import("../../vendor/transformers/transformers.min.js");
      const env = mod.env;
      // 模型随扩展打包在 vendor/asr/，不依赖联网下载
      env.allowLocalModels = true;
      env.allowRemoteModels = false;
      env.useBrowserCache = true;
      env.localModelPath = chrome.runtime.getURL("vendor/asr/");
      if (env.backends && env.backends.onnx && env.backends.onnx.wasm) {
        env.backends.onnx.wasm.wasmPaths = chrome.runtime.getURL("vendor/transformers/");
        env.backends.onnx.wasm.proxy = false;
      }
      return await mod.pipeline("automatic-speech-recognition", "whisper-tiny.en", { dtype: "q8" });
    })();
  }
  return await asrPromise;
}

export async function preloadAsr() {
  await getAsr();
  return { ok: true };
}

export function asrOptionsForSeconds(seconds, options) {
  const opts = { return_timestamps: !!(options && options.timestamps) };
  if (Number(seconds) > 29) { opts.chunk_length_s = 30; opts.stride_length_s = 5; }
  return opts;
}

function timestampPair(value) {
  if (Array.isArray(value)) return [Number(value[0]), Number(value[1])];
  if (typeof value === "number") return [Number(value), NaN];
  return [NaN, NaN];
}

let asrStats = { calls: 0, ok: 0, fail: 0, busy: false, lastMs: 0, lastText: "", lastError: null, at: 0 };

export async function transcribePcm(pcm, options) {
  const startedAt = Date.now();
  asrStats.calls++; asrStats.busy = true; asrStats.at = startedAt;
  try {
    const asr = await getAsr();
    const seconds = (pcm && pcm.length ? pcm.length : 0) / 16000;
    const out = await asr(pcm, asrOptionsForSeconds(seconds, options));
    const text = String((out && out.text) || "").trim();
    const segments = [];
    if (Array.isArray(out && out.chunks)) {
      for (const chunk of out.chunks) {
        const cue = String((chunk && chunk.text) || "").replace(/\s+/g, " ").trim();
        if (!cue) continue;
        const [rawStart, rawEnd] = timestampPair(chunk.timestamp);
        if (!Number.isFinite(rawStart)) continue;
        const start = Math.max(0, rawStart);
        const end = Number.isFinite(rawEnd) && rawEnd > start ? rawEnd : start + 3;
        segments.push({ start, end, text: cue });
      }
    }
    asrStats.ok++; asrStats.lastMs = Date.now() - startedAt; asrStats.lastText = text.slice(0, 120); asrStats.lastError = null;
    return { text, segments };
  } catch (err) {
    asrStats.fail++; asrStats.lastError = err && err.message ? err.message : String(err); asrStats.lastMs = Date.now() - startedAt;
    throw err;
  } finally {
    asrStats.busy = false;
  }
}

export async function debugAsr(pcm) {
  const asr = await getAsr();
  const feat = await asr.processor(pcm);
  const dims = feat.input_features && feat.input_features.dims ? feat.input_features.dims : null;
  const gen = {};
  try { const g = asr.model.generation_config; gen.keys = Object.keys(g); gen.forced = g.forced_decoder_ids; gen.no_ts = g.no_timestamps_token_id; } catch (e) { gen.error = String(e.message || e); }
  let ids = null, direct = "", directErr = "";
  try {
    const out = await asr.model.generate({ inputs: feat.input_features, max_new_tokens: 32, num_frames: Math.floor(pcm.length / 160) });
    ids = out && out.tolist ? out.tolist() : out;
    direct = asr.tokenizer.decode(ids[0], { skip_special_tokens: true });
  } catch (e) { directErr = String(e.message || e); }
  let pipe = "", pipeErr = "";
  try { const r = await asr(pcm, { return_timestamps: false }); pipe = String(r && r.text || ""); } catch (e) { pipeErr = String(e.message || e); }
  return { dims, ids, direct, directErr, pipe, pipeErr, gen };
}

globalThis.__stAsrDebug = () => ({ ...asrStats });
