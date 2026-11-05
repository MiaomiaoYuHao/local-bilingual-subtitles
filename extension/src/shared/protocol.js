// Message protocol + tunables shared by content scripts, the service worker and the
// offscreen document. Written as a strict-mode-safe plain script so it can be loaded
// both as a content script (classic) and side-effect imported by ESM modules.
//
// IMPORTANT: Chrome exposes only chrome.runtime to offscreen documents (no chrome.tabs /
// chrome.storage), so the offscreen document is a pure compute sandbox: it receives work
// through messages and reports results back to the service worker, which owns tabs+storage.
(() => {
  const ST = (globalThis.ST = globalThis.ST || {});

  ST.MSG = Object.freeze({
    // content -> service worker
    GET_SUBTITLES: "st:get-subtitles",
    TRANSLATE: "st:translate",
    MODEL_STATUS: "st:model-status",
    PRELOAD_MODEL: "st:preload-model",
    SET_DEVICE_PREFERENCE: "st:set-device-preference",
    CACHE_STATS: "st:cache-stats",
    CLEAR_CACHE: "st:clear-cache",
    PING: "st:ping",
    OPEN_OFFSCREEN: "st:open-offscreen",
    CLOUD_TEST: "st:cloud-test",
    NOTE_APPEND: "st:note-append",
    NOTE_NEW: "st:note-new",
    NOTE_READ: "st:note-read",
    NOTE_OPEN: "st:note-open",
    NOTE_BYTES: "st:note-bytes",
    // service worker -> content
    TRANSLATION_RESULT: "st:translation-result",
    MODEL_PROGRESS: "st:model-progress",
    // service worker -> offscreen (all carry a `config` snapshot)
    OFFSCREEN_TRANSLATE: "st:offscreen-translate",
    OFFSCREEN_PRELOAD: "st:offscreen-preload",
    OFFSCREEN_STATUS_REQ: "st:offscreen-status-req",
    OFFSCREEN_SET_DEVICE: "st:offscreen-set-device",
    OFFSCREEN_CACHE_STATS: "st:offscreen-cache-stats",
    OFFSCREEN_CLEAR_CACHE: "st:offscreen-clear-cache",
    OFFSCREEN_CLOUD_TEST: "st:offscreen-cloud-test",
    OFFSCREEN_NOTE_APPEND: "st:offscreen-note-append",
    OFFSCREEN_NOTE_READ: "st:offscreen-note-read",
    OFFSCREEN_NOTE_NEW: "st:offscreen-note-new",
    OFFSCREEN_NOTE_VIEW: "st:offscreen-note-view",
    OFFSCREEN_NOTE_BYTES: "st:offscreen-note-bytes",
    OFFSCREEN_BLOB_URL: "st:offscreen-blob-url",
    // offscreen -> service worker
    OFFSCREEN_STATUS: "st:offscreen-status",
    OFFSCREEN_RESULT: "st:offscreen-result",
    OFFSCREEN_VERBOSE: "st:offscreen-verbose",
  });

  ST.CONFIG = Object.freeze({
    /** rolling English cache: current line + history (spec §3) */
    WINDOW_SIZE: 5,
    /** how many bilingual lines the on-video overlay shows (spec: 3, newest at the bottom) */
    DISPLAY_LINES: 3,
    /** subtitle polling cadence; spec asks for < 1s latency, we aim for 200ms */
    TICK_MS: 200,
    /** treat a time jump larger than this (seconds) as a seek and rebuild the window */
    SEEK_THRESHOLD: 3,
    TRANSLATE_DEBOUNCE_MS: 120,
    MODEL_ID: "onnx-community/Qwen2.5-0.5B-Instruct",
    MODEL_LABEL: "Qwen2.5-0.5B-Instruct",
    /** WebGPU needs an fp16-friendly graph; int4 (q4f16) leaves nodes the JSEP EP cannot run */
    TRANSLATION_DTYPE_WEBGPU: "fp16",
    TRANSLATION_DTYPE_WASM: "uint8",
    MAX_NEW_TOKENS: 64,
    /** give up on a single line after this long so the queue never wedges */
    INFERENCE_TIMEOUT_MS: 60000,
    /** warm-up generation: if WebGPU cannot produce a token in time we drop to WASM */
    WARMUP_TIMEOUT_MS: 45000,
    WARMUP_TIMEOUT_MS_WASM: 240000,
    STORAGE_KEYS: Object.freeze({
      SPACE_HOTKEY: "st_space_hotkey",
      HOTKEY: "st_hotkey",
      BUTTON_VISIBLE: "st_button_visible",
      DEVICE_PREFERENCE: "st_device_preference",
      DTYPE_OVERRIDE: "st_dtype_override",
      GPU_UNUSABLE: "st_webgpu_unusable",
      RESOLVED_DEVICE: "st_resolved_device",
      RESOLVED_DTYPE: "st_resolved_dtype",
      ENGINE: "st_engine",
      SAVE_KEY: "st_save_key",
      NOTE_DIR_NAME: "st_note_dir",
      NOTE_FILENAME: "st_note_filename",
      GROQ_KEY: "st_groq_key",
      CLOUD_MODEL: "st_cloud_model",
      CLOUD_PROVIDER: "st_cloud_provider",
      CLOUD_PRESET: "st_cloud_preset",
      CLOUD_KEY: "st_cloud_key",
      CLOUD_BASEURL: "st_cloud_baseurl",
      LAST_STATUS: "st_last_status",
      WELCOME_SHOWN: "st_welcome_shown",
    }),
  });

  ST.AdapterError = class AdapterError extends Error {
    constructor(message, details) {
      super(message);
      this.name = "AdapterError";
      this.details = details || null;
    }
  };
})();