// M2 来源管线：官方软字幕 → 画面字幕(OCR) → 语音识别(ASR)
// 约定：只翻译英语；每个来源都分"在线/离线"两种实现，由后台引擎按可用性与速度自适应。
(() => {
  const ST = (globalThis.ST = globalThis.ST || {});

  const KINDS = [
    { id: "soft", label: "官方字幕", hint: "平台自带软字幕", speed: 3 },
    { id: "ocr", label: "画面字幕", hint: "识别画面上的硬字幕", speed: 2 },
    { id: "asr", label: "语音识别", hint: "听视频声音转写", speed: 1 },
  ];

  const ORDER = ["soft", "ocr", "asr"];

  function platformOf(location) {
    const h = String((location && location.hostname) || "");
    if (/(^|\.)youtube\.com$|youtube-nocookie/.test(h)) return "youtube";
    if (/(^|\.)bilibili\.com$|(^|\.)b23\.tv$/.test(h)) return "bilibili";
    if (/(^|\.)douyin\.com$|(^|\.)iesdouyin\.com$/.test(h)) return "douyin";
    return "generic";
  }

  /** 当前页面该按什么顺序找字幕来源 */
  function planFor(location) {
    const platform = platformOf(location);
    return { platform, steps: ORDER.map((id) => KINDS.find((k) => k.id === id)).filter(Boolean) };
  }

  ST.SOURCE_KINDS = KINDS;
  ST.platformOf = platformOf;
  ST.sourcePlanFor = planFor;
})();
