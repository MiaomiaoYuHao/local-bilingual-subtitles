// 离屏：解码音频为 16k 单声道 PCM（ASR 的输入）
const TARGET_RATE = 16000;

function downsample(input, srcRate) {
  if (srcRate === TARGET_RATE) return input;
  const ratio = srcRate / TARGET_RATE;
  const len = Math.floor(input.length / ratio);
  const out = new Float32Array(len);
  for (let i = 0; i < len; i++) out[i] = input[Math.min(input.length - 1, Math.round(i * ratio))];
  return out;
}

export async function decodeAudioFile(file, maxSeconds) {
  const raw = await file.arrayBuffer();
  const ctx = new (window.AudioContext || window.webkitAudioContext)();
  const buf = await ctx.decodeAudioData(raw);
  let pcm = downsample(buf.getChannelData(0), buf.sampleRate);
  const limit = Number(maxSeconds) > 0 ? Math.floor(Number(maxSeconds) * TARGET_RATE) : 0;
  if (limit && pcm.length > limit) pcm = pcm.slice(0, limit);
  try { await ctx.close(); } catch { }
  return { samples: pcm.length, duration: pcm.length / TARGET_RATE, pcm };
}

export async function decodeAudioBase64(base64, mime) {
  const bin = atob(String(base64 || ""));
  const u8 = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) u8[i] = bin.charCodeAt(i);
  return await decodeAudioFile(new File([u8], "audio.bin", { type: mime || "audio/webm" }));
}
