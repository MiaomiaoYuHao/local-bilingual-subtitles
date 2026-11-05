// 音频通道：从 video 抓系统音频（captureStream → WebAudio → PCM），每 N 秒交出一段 16k 单声道
(() => {
  const ST = (globalThis.ST = globalThis.ST || {});
  const TARGET_RATE = 16000;
  let ac = null, proc = null, source = null, sink = null;
  let buffers = [];
  let collected = 0;
  const stats = { segments: 0, lastRms: 0, lastPeak: 0, lastSpeechSec: 0, lastAt: 0 };
  let windowSec = 4;
  let overlapSec = 2;

  function supported(video) {
    try { return !!(video && typeof video.captureStream === "function" && (window.AudioContext || window.webkitAudioContext)); } catch { return false; }
  }

  function downsample(input, srcRate) {
    if (srcRate === TARGET_RATE) return input;
    const ratio = srcRate / TARGET_RATE;
    const len = Math.floor(input.length / ratio);
    const out = new Float32Array(len);
    for (let i = 0; i < len; i++) out[i] = input[Math.min(input.length - 1, Math.round(i * ratio))];
    return out;
  }

  /** 去直流 + 70Hz 二阶高通 + 峰值归一：压掉音乐低频轰鸣，提升小音量语音。 */
  function conditionPcm(input, opts) {
    const pcm = input instanceof Float32Array ? input : new Float32Array(input || []);
    if (!pcm.length) return pcm;
    const out = new Float32Array(pcm.length);
    const w0 = 2 * Math.PI * 85 / TARGET_RATE;
    const cos = Math.cos(w0);
    const alpha = Math.sin(w0) / (2 * 0.707);
    const a0 = 1 + alpha;
    const b0 = (1 + cos) / 2, b1 = -(1 + cos), b2 = (1 + cos) / 2;
    const a1 = -2 * cos, a2 = 1 - alpha;
    let x1 = 0, x2 = 0, y1 = 0, y2 = 0, peak = 0;
    for (let i = 0; i < pcm.length; i++) {
      const x = pcm[i];
      const y = (b0 * x + b1 * x1 + b2 * x2 - a1 * y1 - a2 * y2) / a0;
      x2 = x1; x1 = x; y2 = y1; y1 = y; out[i] = y;
      const a = Math.abs(y); if (a > peak) peak = a;
    }
    if ((!opts || opts.normalize !== false) && peak > 0.0005) {
      const gain = Math.min(12, 0.9 / peak);
      if (gain > 1.05) for (let i = 0; i < out.length; i++) out[i] *= gain;
    }
    return out;
  }

  /** 去掉首尾静音（20ms 帧能量 VAD），返回裁剪后的 PCM 和语音时长。 */
  function trimSilence(input, opts) {
    const pcm = input instanceof Float32Array ? input : new Float32Array(input || []);
    const frame = 320; // 20ms @16k
    const frames = Math.floor(pcm.length / frame);
    if (!frames) return { pcm, speechSec: pcm.length / TARGET_RATE, leadingSec: 0, trailingSec: 0 };
    let peak = 0;
    for (const x of pcm) peak = Math.max(peak, Math.abs(x));
    const threshold = Math.max(Number(opts && opts.threshold) || 0.006, peak * 0.08);
    let first = -1, last = -1;
    for (let f = 0; f < frames; f++) {
      let sum = 0;
      const at = f * frame;
      for (let i = 0; i < frame; i++) { const x = pcm[at + i]; sum += x * x; }
      if (Math.sqrt(sum / frame) >= threshold) { if (first < 0) first = f; last = f; }
    }
    if (first < 0) return { pcm: new Float32Array(0), speechSec: 0, leadingSec: 0, trailingSec: pcm.length / TARGET_RATE };
    const pad = Math.round(0.1 * TARGET_RATE);
    const a = Math.max(0, first * frame - pad);
    const b = Math.min(pcm.length, (last + 1) * frame + pad);
    return { pcm: pcm.slice(a, b), speechSec: (last - first + 1) * frame / TARGET_RATE, leadingSec: a / TARGET_RATE, trailingSec: (pcm.length - b) / TARGET_RATE };
  }

  /** 每 windowSec 秒回调一次 onSegment(Float32Array PCM 16k)，保留 overlapSec 秒重叠 */
  function startAudioCapture(video, onSegment, opts) {
    stopAudioCapture();
    if (!supported(video)) return false;
    windowSec = Math.max(3, Number(opts && opts.windowSec) || 4);
    overlapSec = Math.max(0, Math.min(windowSec - 0.5, Number(opts && opts.overlapSec) || 2));
    let stream;
    try { stream = video.captureStream(); } catch { return false; }
    const tracks = stream.getAudioTracks ? stream.getAudioTracks() : [];
    if (!tracks.length) return false;
    const Ctx = window.AudioContext || window.webkitAudioContext;
    ac = new Ctx();
    source = ac.createMediaStreamSource(stream);
    proc = ac.createScriptProcessor(4096, 1, 1);
    sink = ac.createGain();
    sink.gain.value = 0;                 // 静音输出，不产生回声
    proc.onaudioprocess = (e) => {
      const d = e.inputBuffer.getChannelData(0);
      buffers.push(new Float32Array(d));
      collected += d.length;
      if (collected < ac.sampleRate * windowSec) return;
      const merged = new Float32Array(collected);
      let at = 0;
      for (const b of buffers) { merged.set(b, at); at += b.length; }
      buffers = [];
      collected = 0;
      const pcm = downsample(merged, ac.sampleRate);
      const keep = Math.min(merged.length, Math.round(ac.sampleRate * overlapSec));
      buffers = keep > 0 ? [merged.slice(merged.length - keep)] : [];
      collected = keep;
      const trimmed = trimSilence(pcm);
      if (trimmed.speechSec >= 0.5) {
        let sum = 0, peak = 0;
        for (const x of trimmed.pcm) { sum += x * x; const a = Math.abs(x); if (a > peak) peak = a; }
        stats.segments++; stats.lastRms = Math.sqrt(sum / Math.max(1, trimmed.pcm.length)); stats.lastPeak = peak; stats.lastSpeechSec = trimmed.speechSec; stats.lastAt = Date.now();
        try { onSegment(conditionPcm(trimmed.pcm)); } catch { /* 单段失败不影响后续 */ }
      }
    };
    source.connect(proc);
    proc.connect(sink);
    sink.connect(ac.destination);
    return true;
  }

  function stopAudioCapture() {
    try { if (proc) proc.disconnect(); } catch { }
    try { if (sink) sink.disconnect(); } catch { }
    try { if (source) source.disconnect(); } catch { }
    try { if (ac) ac.close(); } catch { }
    ac = null; proc = null; source = null; sink = null;
    buffers = [];
    collected = 0;
  }

  ST.audioCapture = { startAudioCapture, stopAudioCapture, supported, trimSilence, conditionPcm, stats, debug: () => ({ ...stats }), TARGET_RATE };
})();
