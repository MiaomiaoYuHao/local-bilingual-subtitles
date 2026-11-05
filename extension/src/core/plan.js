// 来源决策：先判断"这条视频是不是英语"，再盘点手上有什么资源，最后排出用哪种方法
(() => {
  const ST = (globalThis.ST = globalThis.ST || {});

  const isEnLang = (l) => /^(en|en-|ai-en)/i.test(String(l || ""));

  /** 语言证据：字幕轨语言 / 画面字幕文字 */
  function detectVideoLanguage(input) {
    const opts = input || {};
    const langs = (opts.tracks || []).map((t) => (t && (t.lan || t.languageCode || t.language)) || "").filter(Boolean);
    if (langs.some(isEnLang)) return { language: "en", evidence: "english-subtitle-track" };
    const dom = opts.domCaption;
    if (dom && ST.util && ST.util.isLikelyEnglish && ST.util.isLikelyEnglish(dom)) {
      return { language: "en", evidence: "english-screen-caption" };
    }
    const nonEn = langs.find((l) => /^(zh|ja|ko|ai-zh)/i.test(l));
    if (nonEn) return { language: "unknown", evidence: "only-" + nonEn };
    if (opts.audioLanguage) return { language: String(opts.audioLanguage), evidence: "audio" };
    return { language: "unknown", evidence: "none" };
  }

  /** 盘点当前页面/视频能拿到什么 */
  function inventoryResources(input) {
    const o = input || {};
    const tracks = Array.isArray(o.tracks) ? o.tracks : [];
    return {
      hasEnglishTrack: tracks.some((t) => isEnLang(t && (t.lan || t.languageCode || t.language))),
      hasAnyTrack: tracks.length > 0,
      trackLangs: tracks.map((t) => (t && (t.lan || t.languageCode || t.language)) || "").filter(Boolean),
      hasEnglishDomCaption: !!(o.domCaption && ST.util && ST.util.isLikelyEnglish && ST.util.isLikelyEnglish(o.domCaption)),
      canCaptureFrames: !!o.canCaptureFrames,     // 页面内取帧（跨域不污染时）
      canCaptureAudio: !!o.canCaptureAudio,       // 页面内 captureStream
      canFetchVideo: !!o.canFetchVideo,           // 后台能抓 mp4（抖音）
      hasOcr: !!(ST.ocr && ST.ocr.cleanOcrText),
      hasAsr: false,                              // Whisper 还没接
    };
  }

  /** 三种来源排序：软字幕 → OCR → ASR；只有英语视频才翻译 */
  function planSources(lang, res) {
    const steps = [];
    if (res.hasEnglishTrack) steps.push({ source: "soft", why: "有英文字幕轨" });
    if (res.hasEnglishDomCaption) steps.push({ source: "soft", why: "播放器画面字幕是英文" });
    const english = lang && lang.language === "en";
    if (english) {
      if (res.canCaptureFrames) steps.push({ source: "ocr", why: "识别画面上的英文字幕" });
      if (res.canFetchVideo) steps.push({ source: "ocr", why: "抓取视频后识别画面字幕" });
      if (res.canCaptureAudio) steps.push({ source: "asr", why: "识别视频声音" });
      if (res.canFetchVideo) steps.push({ source: "asr", why: "抓取视频后识别声音" });
    }
    return { english, steps, usable: steps.length > 0 };
  }

  /**
   * 没有英文字幕轨、也没有英文画面字幕时：必须实时听一小段声音判断是不是英语，
   * 判成英语才走 OCR/ASR（判不出/非英语就不硬翻）。
   */
  function needsAudioLanguageProbe(lang, res) {
    const hasEvidence = !!(lang && lang.language === "en") || !!(res && (res.hasEnglishTrack || res.hasEnglishDomCaption));
    return { needed: !hasEvidence, reason: hasEvidence ? "" : "没有英文软字幕，需要实时判断视频是否在讲英语" };
  }

  /**
   * 每一段都判一次（贯穿整个播放过程，而不是开头判一次）：
   * 静音 / 没说话 / 不是英语 → 这一段不翻译；只有英语段才进入翻译。
   */
  function shouldTranslateSegment(seg) {
    const s = seg || {};
    const text = String(s.text || "").replace(/\s+/g, " ").trim();
    if (s.hasSpeech === false || !text) return { translate: false, reason: "silence" };
    if (s.language && String(s.language).toLowerCase() !== "en") return { translate: false, reason: "not-english" };
    if (ST.util && ST.util.isLikelyEnglish && !ST.util.isLikelyEnglish(text)) return { translate: false, reason: "text-not-english" };
    return { translate: true, reason: "" };
  }

  ST.shouldTranslateSegment = shouldTranslateSegment;
  ST.needsAudioLanguageProbe = needsAudioLanguageProbe;
  ST.detectVideoLanguage = detectVideoLanguage;
  ST.inventoryResources = inventoryResources;
  ST.planSources = planSources;
})();
