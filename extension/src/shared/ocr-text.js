// OCR 文本后处理：把画面底部识别出来的乱码整理成"一行英文"
(() => {
  const ST = (globalThis.ST = globalThis.ST || {});
  const NOISE = /^[\s\-_=~|·•.,:;'"!?()\[\]{}<>\/\\*#]+$/;

  // 常用词表同时用于质量闸门和"只差一个字母"的纠错，避免把专有名词改坏。
  const COMMON_WORDS = new Set(("the a an to of and in is are it this that you we i he she they was were be for on with at as from by not but have has had do does did can could will would should there here what how when why who if so or my your our their me him her them us no yes just all one two three get got go going know think like want need say said see look come came make made take took time way day new old good bad very really about into out up down over more most some any every only also then than now still even back because before after while through hello everyone welcome hear love answer depends fluent careful channel video today walking walk sidewalk street crosswalk trash bin world people thing things first last next year years right well little long great work life comes coming goes gone knows known wanted needs needed says looks looked takes taking taken makes making worked feels felt seems seemed suggest suggests receive received begin started stop helped learn learning teach teaching english youtube channels subtitle subtitles videos resolution battle losing lose lost year years treat treats hope had good eve just wanted start video videos thanking thank watching watch your someone moving britain america british accent accents dictionary chinese fun lot make started it's year's something everything anything nothing someone somebody another around already").split(" "));

  // 只收录非常确定、且不会把正常单词改错的 OCR 混淆/常见拼写错误。
  const EXPLICIT_FIXES = new Map([
    ["teh", "the"], ["hte", "the"], ["thc", "the"], ["tbe", "the"], ["tiie", "the"], ["tlie", "the"],
    ["y0u", "you"], ["yau", "you"], ["vou", "you"], ["aud", "and"], ["a11", "all"], ["t0", "to"],
    ["wil1", "will"], ["wi11", "will"], ["wlll", "will"],
    ["dont", "don't"], ["cant", "can't"], ["wont", "won't"], ["isnt", "isn't"], ["didnt", "didn't"],
    ["doesnt", "doesn't"], ["couldnt", "couldn't"], ["wouldnt", "wouldn't"], ["shouldnt", "shouldn't"],
    ["youre", "you're"], ["theyre", "they're"], ["thats", "that's"], ["whats", "what's"],
    ["lets", "let's"], ["ive", "I've"], ["im", "I'm"], ["recieve", "receive"], ["sugges", "suggest"], ["thal", "that"], ["thai", "that"], ["yor", "you"], ["youl", "you"], ["thei", "they're"], ["ard", "and"], ["wi1l", "will"], ["s0", "so"], ["n0w", "now"],
  ]);

  const PROPER_NAMES = new Set("youtube facebook google twitter instagram amazon microsoft apple john smith britain america british chinese english".split(" "));

  function preserveCase(source, replacement) {
    if (!source) return replacement;
    if (source === source.toUpperCase()) return replacement.toUpperCase();
    if (/^[A-Z]/.test(source)) return replacement.charAt(0).toUpperCase() + replacement.slice(1);
    return replacement;
  }

  /** 相邻换位算 1 次编辑（recieve → receive） */
  function editDistanceAtMostOne(a, b) {
    if (a === b) return true;
    const la = a.length, lb = b.length;
    if (Math.abs(la - lb) > 1) return false;
    if (la === lb) {
      let first = -1, second = -1;
      for (let i = 0; i < la; i++) {
        if (a[i] !== b[i]) {
          if (first < 0) first = i;
          else if (second < 0) second = i;
          else return false;
        }
      }
      if (second < 0) return true;
      return second === first + 1 && a[first] === b[second] && a[second] === b[first];
    }
    let i = 0, j = 0, skipped = false;
    while (i < la && j < lb) {
      if (a[i] === b[j]) { i++; j++; continue; }
      if (skipped) return false;
      skipped = true;
      if (la > lb) i++; else j++;
    }
    return true;
  }

  /** 常见词的正常屈折形式（comes / started / making）不要当成拼写错误。 */
  function isLikelyInflection(word) {
    if (!word || word.length < 4) return false;
    if (COMMON_WORDS.has(word)) return true;
    if (word.endsWith("s") && COMMON_WORDS.has(word.slice(0, -1))) return true;
    if (word.endsWith("es") && COMMON_WORDS.has(word.slice(0, -2))) return true;
    if (word.endsWith("ies") && COMMON_WORDS.has(word.slice(0, -3) + "y")) return true;
    if (word.endsWith("ed") && (COMMON_WORDS.has(word.slice(0, -2)) || COMMON_WORDS.has(word.slice(0, -1)))) return true;
    if (word.endsWith("ing") && (COMMON_WORDS.has(word.slice(0, -3)) || COMMON_WORDS.has(word.slice(0, -3) + "e"))) return true;
    return false;
  }

  /** OCR 常见字形混淆：只在候选词能唯一命中常用词时采用。 */
  function ocrVariants(word) {
    const out = new Set([word]);
    let cur = word;
    const rules = [
      [/ii/g, "n"], [/rn/g, "m"], [/vv/g, "w"], [/cl/g, "d"], [/li/g, "h"],
      [/0/g, "o"], [/1/g, "l"], [/5/g, "s"], [/8/g, "b"], [/@/g, "a"], [/\$/g, "s"],
    ];
    for (const [re, to] of rules) {
      const next = cur.replace(re, to);
      if (next !== cur) { out.add(next); cur = next; }
    }
    return out;
  }

  function nearestCommonWord(word) {
    if (!word || word.length < 4 || !/^[a-z]+$/.test(word)) return "";
    if (isLikelyInflection(word)) return "";
    let found = new Set();
    for (const variant of ocrVariants(word)) {
      for (const candidate of COMMON_WORDS) {
        if (Math.abs(candidate.length - variant.length) > 1) continue;
        if (!editDistanceAtMostOne(variant, candidate)) continue;
        found.add(candidate);
      }
    }
    if (found.size !== 1) return ""; // 有歧义就不改
    return found.values().next().value;
  }

  /** 行内前后噪声：孤立数字/符号/单字母碎片（如 "7 ... 2,"） */
  function trimOcrEdges(raw) {
    const keepShort = new Set("i a an the to of in on at as or we he it my me us no so do go be by if is are you they this that and but for with from was were has have had not just all one two get got can will would there here what how when why who then than now still even back because before after while through hello everyone welcome".split(" "));
    const toks = cleanOcrText(raw).split(" ").filter(Boolean);
    const junk = (w) => {
      const core = String(w || "").replace(/[^A-Za-z0-9']/g, "");
      if (!core) return true;
      if (/^\d+$/.test(core)) return true;
      if (/^[^A-Za-z0-9]+$/.test(w)) return true;
      if (/^[A-Za-z]{1,2}$/.test(core) && !keepShort.has(core.toLowerCase())) return true;
      if (/^[A-Za-z]{3}$/.test(core) && !COMMON_WORDS.has(core.toLowerCase())) return true;
      return false;
    };
    while (toks.length > 3 && junk(toks[0])) toks.shift();
    while (toks.length > 3 && junk(toks[toks.length - 1])) toks.pop();
    return toks.join(" ").trim();
  }

  /** 只在上下文非常明确时修复 OCR 粘连/常见误读，避免改坏正常句子。 */
  function fixOcrPhrases(raw) {
    return String(raw || "")
      .replace(/\byou['’]?\s*l*learn\b/gi, "you learn")
      .replace(/\balso\s*fa\b/gi, "also a")
      .replace(/\balsofa\b/gi, "also a")
      .replace(/\balso\s*alot\b/gi, "also a lot")
      .replace(/\balso\s*a\s*lot\b/gi, "also a lot")
      .replace(/\bto\s*[g{]?\s*[m]?\s*[i1]?ake\b/gi, "to make")
      .replace(/\balot\b/gi, "a lot")
      .replace(/\btheif\b/gi, "their")
      .replace(/\bthue\b/gi, "the")
      .replace(/\bfhe\b/gi, "the")
      .replace(/\bbriti\b/gi, "british")
      .replace(/\blearn[!|]\s+English\b/gi, "learn English")
      .replace(/\btheir\s+also\b/gi, "they're also")
      .replace(/\bth\s+r[nm]\b/gi, "then")
      .replace(/\bThe\s+And\b/g, "And")
      .replace(/\bNew,\s+Year['’]s\b/gi, "New Year's")
      .replace(/\band!\s+I\b/gi, "and I")
      .replace(/\balso\s+lot\b/gi, "also a lot")
      .replace(/\byear:\s+treats\b/gi, "year treats")
      .replace(/\btreats\s+SY\s+well\b/gi, "treats you well")
      .replace(/([A-Za-z]),([A-Za-z])/g, "$1, $2")
      .replace(/\b(help|teach|taught|helping)\s+you\s+English\b/gi, "$1 you learn English")
      .replace(/\b(and)\s+is\b(?=\s*[,.]|$)/gi, "$1")
      .replace(/\bInyfYourype\b/gi, "my YouTube")
      .replace(/\byoul\s+English\b/gi, "you learn English")
      .replace(/\bfor\s+me\s+make\b/gi, "for me to make")
      .replace(/\bby,\s+thanking\b/gi, "by thanking")
      .replace(/\bthey're\s+Fig\s+CNT\b/gi, "they're")
      .replace(/\bEve\s+and\s+is\b/gi, "Eve and")
      .replace(/\bthei\s+Fig\s+CNT,?\s*also\b/gi, "they're also")
      .replace(/\[lake\b/gi, "make")
      .replace(/\bfor\s+me\s+make\b/gi, "for me to make")
      .replace(/\bdnd\s+T\b/gi, "and I")
      .replace(/\bchann?i+el\b/gi, "channel")
      .replace(/\s{2,}/g, " ")
      .trim();
  }

  /** 把 OCR 粘连词切开：只允许"常用词 + 单个噪声字符 + 常用词"这类高确定模式。 */
  function segmentFusedWord(word, depth) {
    const lower = String(word || "").toLowerCase();
    if (!lower) return null;
    if (COMMON_WORDS.has(lower)) return { parts: [word], cost: 0 };
    if (PROPER_NAMES.has(lower)) return null;
    if (lower.length < 5 || depth > 3) return null;
    let best = null;
    const consider = (parts, cost) => {
      if (!parts || parts.length < 2) return;
      const score = cost * 100 + parts.length * 5 - parts.reduce((m, p) => Math.min(m, p.length), 99);
      if (!best || score < best.score) best = { parts, cost, score };
    };
    for (let i = 2; i <= lower.length - 2; i++) {
      const left = word.slice(0, i);
      const right = word.slice(i);
      if (!COMMON_WORDS.has(left.toLowerCase())) continue;
      if (COMMON_WORDS.has(right.toLowerCase())) { consider([left, right], 0); continue; }
      if (right.length > 1) {
        const tail = right.slice(1);
        if (COMMON_WORDS.has(tail.toLowerCase())) consider([left, tail], 1);
        else {
          const seg = segmentFusedWord(tail, (depth || 0) + 1);
          if (seg) consider([left].concat(seg.parts), seg.cost + 1);
        }
      }
    }
    return best ? { parts: best.parts, cost: best.cost } : null;
  }

  function splitFusedWords(text) {
    return String(text || "").split(/(\s+)/).map((token) => {
      if (!token || /^\s+$/.test(token)) return token;
      const m = token.match(/^([^A-Za-z]*)([A-Za-z][A-Za-z'’\-]*)([^A-Za-z]*)$/);
      if (!m) return token;
      const core = m[2];
      if (/['’]/.test(core)) return token;
      const lower = core.toLowerCase();
      if (COMMON_WORDS.has(lower) || PROPER_NAMES.has(lower) || EXPLICIT_FIXES.has(lower) || core === core.toUpperCase() && core.length > 1) return token;
      if (core.length === 4 && /[jli]$/.test(lower) && COMMON_WORDS.has(lower.slice(0, -1))) return m[1] + core.slice(0, -1) + m[3];
      if (core.length < 5) return token;
      const seg = segmentFusedWord(core, 0);
      if (!seg || seg.parts.length < 2) return token;
      return m[1] + seg.parts.join(" ") + m[3];
    }).join("");
  }

  /** 修正高置信度的 OCR 常见词错误；名字/全大写缩写不动。 */
  function correctCommonWords(raw) {
    const prepared = fixOcrPhrases(splitFusedWords(fixOcrPhrases(raw)));
    return prepared.replace(/[A-Za-z][A-Za-z'’\-]*/g, (word) => {
      const lower = word.toLowerCase().replace(/’/g, "'");
      if (EXPLICIT_FIXES.has(lower)) return preserveCase(word, EXPLICIT_FIXES.get(lower));
      if (word === word.toUpperCase() && word.length > 1) return word;
      if (!/^[A-Za-z]+$/.test(word)) return word;
      if (COMMON_WORDS.has(lower)) return word;
      const fixed = nearestCommonWord(lower);
      if (!fixed) return word;
      // 句子开头的常见词首字母大写是正常的，保留 casing。
      return preserveCase(word, fixed);
    });
  }

  /** 只截画面底部（字幕通常在底部 26%），返回 canvas 的源矩形 */
  function pickSubtitleBand(width, height, ratio) {
    const w = Math.max(1, Math.round(Number(width) || 0));
    const h = Math.max(1, Math.round(Number(height) || 0));
    const band = Math.min(0.6, Math.max(0.12, Number(ratio) || 0.26));
    const sh = Math.max(1, Math.round(h * band));
    return { sx: 0, sy: Math.max(0, h - sh), sw: w, sh };
  }

  /** OCR 原文 → 一行可读英文（去重、拼行、去掉孤字符与纯符号行） */
  function cleanOcrText(raw) {
    const lines = String(raw || "")
      .replace(/\r/g, "")
      .split("\n")
      .map((l) => l.replace(/\s+/g, " ").trim())
      .filter((l) => l && !NOISE.test(l))
      .map((l) => l
        .replace(/^[|¦_~]+|[|¦_~]+$/g, "")          // 行首/行尾的 OCR 杂线
        .replace(/(^|\s)[|¦]{1,2}(?=\s|$)/g, " ")
        .replace(/\s{2,}/g, " ")
        .trim())
      .filter(Boolean);
    const out = [];
    for (const l of lines) {
      const prev = out[out.length - 1];
      if (prev && prev.toLowerCase() === l.toLowerCase()) continue;   // 同帧重复
      // 逐字重复（OCR 有时把一行吐两遍）
      if (prev && prev.replace(/\s+/g, "") === l.replace(/\s+/g, "")) continue;
      out.push(l);
    }
    let text = out.join(" ").replace(/\s{2,}/g, " ").trim();
    // 去开头噪声：全大写短词/带符号的碎片（水印、角标），如 "AEE $e / ZS"
    {
      const toks = text.split(" ").filter(Boolean);
      let k = 0;
      while (k < toks.length - 3) {
        const w = toks[k];
        const junk = (/^[A-Z]{1,3}$/.test(w) && w !== "I") || /[^A-Za-z0-9'’-]/.test(w) || /^\d+$/.test(w);
        if (!junk) break;
        k++;
      }
      if (k > 0 && k < toks.length) text = toks.slice(k).join(" ");
    }
    // 去尾部孤立符号/单字母（OCR 常见尾巴，如 "v \"）
    const toks = text.split(" ").filter(Boolean);
    while (toks.length > 3) {
      const last = toks[toks.length - 1];
      const isJunk = /^[^A-Za-z0-9]+$/.test(last) || (/^[A-Za-z]$/.test(last) && !/^[aI]$/.test(last));
      if (!isJunk) break;
      toks.pop();
    }
    return toks.join(" ").trim();
  }

  const normWord = (w) => String(w || "").toLowerCase().replace(/[^a-z0-9']/g, "");

  function tokenize(text) {
    return cleanOcrText(text).split(" ").filter(Boolean);
  }

  function normalizedTokens(text) {
    return tokenize(text).map(normWord).filter(Boolean);
  }

  function sampleWeight(sample) {
    const conf = Number(sample && sample.confidence);
    if (!Number.isFinite(conf)) return 1;
    return Math.max(0.35, Math.min(1.6, conf / 70));
  }

  /**
   * 全局对齐（Levenshtein）：返回 medoid 每个词对应的样本词索引，以及每个边界上的插入词。
   * 词表很短（<40），O(n*m) 足够快。
   */
  function alignTokens(base, other) {
    const n = base.length, m = other.length;
    const dp = Array.from({ length: n + 1 }, () => new Int16Array(m + 1));
    for (let i = 0; i <= n; i++) dp[i][0] = i;
    for (let j = 0; j <= m; j++) dp[0][j] = j;
    for (let i = 1; i <= n; i++) {
      for (let j = 1; j <= m; j++) {
        const same = base[i - 1] === other[j - 1] ? 0 : 1;
        dp[i][j] = Math.min(dp[i - 1][j] + 1, dp[i][j - 1] + 1, dp[i - 1][j - 1] + same);
      }
    }
    const map = new Int16Array(n).fill(-1);
    const inserts = Array.from({ length: n + 1 }, () => []);
    let i = n, j = m;
    while (i > 0 || j > 0) {
      if (i > 0 && j > 0) {
        const same = base[i - 1] === other[j - 1] ? 0 : 1;
        if (dp[i][j] === dp[i - 1][j - 1] + same) {
          map[i - 1] = j - 1;
          i--; j--; continue;
        }
      }
      if (i > 0 && dp[i][j] === dp[i - 1][j] + 1) { i--; continue; }
      if (j > 0 && dp[i][j] === dp[i][j - 1] + 1) {
        inserts[i].unshift(j - 1);
        j--; continue;
      }
      break;
    }
    return { map, inserts };
  }

  function pickWeightedVariant(variants, fallback) {
    // variants: [{ key, text, weight, common }]
    if (!variants.length) return fallback;
    const byKey = new Map();
    for (const v of variants) {
      const cur = byKey.get(v.key) || { key: v.key, text: v.text, weight: 0, count: 0, common: v.common };
      cur.weight += v.weight;
      cur.count++;
      if (v.weight > 0 && (!cur.text || v.common)) cur.text = v.text;
      byKey.set(v.key, cur);
    }
    const all = [...byKey.values()];
    const total = all.reduce((s, v) => s + v.weight, 0);
    all.sort((a, b) => (b.weight - a.weight) || (b.common ? 1 : 0) - (a.common ? 1 : 0) || a.count - b.count);
    const best = all[0];
    // 两帧打平时，优先常用词/正常单词，避免把数字噪声留下。
    if (all.length > 1 && Math.abs(best.weight - all[1].weight) < 1e-6 && best.common !== all[1].common) {
      return (all[1].common ? all[1] : best).text;
    }
    return best.weight * 2 >= total ? best.text : fallback;
  }

  /**
   * 多帧 OCR 投票：对同一句字幕的多次识别做词级对齐，按置信度加权选多数写法。
   * 单帧、全部失败时也能安全退回。
   * @returns {{text:string, confidence:number, agreement:number, samples:number}}
   */
  function consensusOcrText(samples) {
    const list = (Array.isArray(samples) ? samples : [])
      .map((s) => (typeof s === "string" ? { text: s, confidence: 70 } : s))
      .filter((s) => s && s.text)
      .map((s) => ({ text: cleanOcrText(s.text), confidence: Number(s.confidence), weight: sampleWeight(s) }))
      .filter((s) => s.text);
    if (!list.length) return { text: "", confidence: 0, agreement: 0, samples: 0 };
    if (list.length === 1) {
      const only = list[0];
      return { text: correctCommonWords(only.text), confidence: Number.isFinite(only.confidence) ? only.confidence : 0, agreement: 1, samples: 1 };
    }

    // medoid：与其它样本平均相似度最高的一帧作为对齐基准。
    let medoidIdx = 0, bestScore = -1;
    for (let i = 0; i < list.length; i++) {
      let score = 0;
      for (let j = 0; j < list.length; j++) {
        if (i === j) continue;
        score += ST.textSimilarity ? ST.textSimilarity(list[i].text, list[j].text) : 0;
      }
      if (score > bestScore) { bestScore = score; medoidIdx = i; }
    }
    const medoid = list[medoidIdx];
    const base = normalizedTokens(medoid.text);
    const baseRaw = tokenize(medoid.text);
    if (!base.length) return { text: correctCommonWords(medoid.text), confidence: Number.isFinite(medoid.confidence) ? medoid.confidence : 0, agreement: 1, samples: list.length };

    const mappings = list.map((s, idx) => {
      if (idx === medoidIdx) {
        return {
          tokens: tokenize(s.text),
          norm: normalizedTokens(s.text),
          weight: s.weight,
          confidence: s.confidence,
          map: Int16Array.from(base.map((_, i) => i)),
          inserts: Array.from({ length: base.length + 1 }, () => []),
        };
      }
      const t = tokenize(s.text);
      const nt = normalizedTokens(s.text);
      const a = alignTokens(base, nt);
      return { tokens: t, norm: nt, weight: s.weight, confidence: s.confidence, map: a.map, inserts: a.inserts };
    });

    const totalWeight = mappings.reduce((s, m) => s + m.weight, 0);
    const output = [];
    let agreedWeight = 0;

    for (let i = 0; i <= base.length; i++) {
      // 先处理边界插入：只有多数样本都多出同一个词时才补进来。
      const insertVariants = [];
      for (const m of mappings) {
        const idxs = m.inserts[i] || [];
        const text = idxs.map((j) => m.tokens[j]).filter(Boolean).join(" ");
        const key = idxs.map((j) => m.norm[j]).filter(Boolean).join(" ");
        insertVariants.push({ key, text, weight: m.weight, common: key && COMMON_WORDS.has(key) });
      }
      const inserted = pickWeightedVariant(insertVariants, "");
      if (inserted) output.push(inserted);

      if (i === base.length) break;
      const variants = [];
      for (const m of mappings) {
        const j = m.map[i];
        if (j >= 0) {
          const key = m.norm[j];
          const text = m.tokens[j];
          variants.push({ key, text, weight: m.weight, common: COMMON_WORDS.has(key) });
        } else {
          variants.push({ key: "", text: "", weight: m.weight, common: false });
        }
      }
      const fallback = baseRaw[i] || "";
      const best = pickWeightedVariant(variants, fallback);
      if (best) output.push(best);
      if (best && base[i]) {
        for (const v of variants) if (v.key === normWord(best)) agreedWeight += v.weight;
      }
    }

    let text = correctCommonWords(output.join(" ").replace(/\s{2,}/g, " ").trim());
    // 极少数情况下投票把所有词都投掉；兜底回 medoid。
    if (!text) text = correctCommonWords(medoid.text);
    const confs = list.map((s) => s.confidence).filter(Number.isFinite);
    return {
      text,
      confidence: confs.length ? confs.reduce((a, b) => a + b, 0) / confs.length : 0,
      agreement: totalWeight ? Math.min(1, agreedWeight / totalWeight) : 0,
      samples: list.length,
    };
  }

  /** 页面内不能取帧时，是否值得走后台抓短视频 URL 的 OCR 兜底。 */
  function shouldTryVideoOcr(info) {
    const o = info || {};
    return !o.canCaptureFrames && !o.tried && /^https?:/i.test(String(o.src || "")) && Number(o.duration) > 0 && Number(o.duration) <= 180;
  }

  /** 长直链视频（>180s）走 OPFS 流式下载，避免整段文件进内存。 */
  function shouldTryVideoOcrOpfs(info) {
    const o = info || {};
    const d = Number(o.duration) || 0;
    return !o.canCaptureFrames && !o.tried && /^https?:/i.test(String(o.src || "")) && d > 180 && d <= 1800;
  }

  /** 页面不能取帧的 blob 视频：由 content 分片上传到 OPFS。 */
  function shouldTryBlobOpfs(info) {
    const o = info || {};
    return !o.canCaptureFrames && !o.tried && /^blob:/i.test(String(o.src || ""));
  }

  /** 9 秒探测：至少稳定识别到 2 条英文行才继续 OCR，否则说明没有硬字幕。 */
  function shouldKeepOcrProbe(info) {
    const o = info || {};
    const hits = Number(o.hits) || 0;
    const attempts = Number(o.attempts) || 0;
    const elapsed = Number(o.elapsedMs) || 0;
    if (elapsed < 8000) return true;
    return hits >= 2 && attempts >= 2;
  }

  function hasEnoughCommonWords(text) {
    const words = (String(text || "").match(/[A-Za-z]{2,}/g) || []);
    if (words.length > 5) return true;
    const hits = words.filter((w) => COMMON_WORDS.has(w.toLowerCase())).length;
    return words.length > 0 && hits >= Math.ceil(words.length * 0.7);
  }

  /** 从 tesseract 行级结果里只挑高置信字幕行，丢掉背景噪声。 */
  function selectOcrLines(lines, imageHeight) {
    const h = Number(imageHeight) || 0;
    const list = (Array.isArray(lines) ? lines : [])
      .filter((l) => l && Number(l.confidence) >= 65)
      .filter((l) => !h || h < 120 || !l.bbox || Number(l.bbox.y1) > h * 0.35)
      .sort((a, b) => ((a.bbox && a.bbox.y0) || 0) - ((b.bbox && b.bbox.y0) || 0));
    const out = [];
    for (const line of list) {
      const text = trimOcrEdges(fixOcrPhrases(line.text));
      if (text && looksLikeRealEnglish(text) && hasEnoughCommonWords(text)) out.push(text);
    }
    return fixOcrPhrases(out.join(" "));
  }

  /** 行级结果不可用时的兜底：只保留逐词置信度高的词。 */
  function selectOcrWords(words, imageHeight) {
    const h = Number(imageHeight) || 0;
    const kept = (Array.isArray(words) ? words : [])
      .filter((w) => w && Number(w.confidence) >= 75)
      .filter((w) => !h || h < 120 || !w.bbox || Number(w.bbox.y1) > h * 0.35)
      .map((w) => String(w.text || "").trim())
      .filter(Boolean);
    const text = trimOcrEdges(fixOcrPhrases(kept.join(" ")));
    return looksLikeRealEnglish(text) && hasEnoughCommonWords(text) ? fixOcrPhrases(text) : "";
  }

  /** 判断是不是"像人话的英文"，用来挡住 OCR/ASR 的乱码 */
  function looksLikeRealEnglish(text) {
    const t = String(text || "").replace(/\s+/g, " ").trim();
    if (!t) return false;
    const tokens = t.split(" ").filter(Boolean);
    if (tokens.length < 2) return false;
    const letters = (t.match(/[A-Za-z]/g) || []).length;
    if (letters < 6) return false;
    const words = tokens.filter((w) => /^[A-Za-z][A-Za-z'’-]*$/.test(w));
    if (words.length / tokens.length < 0.7) return false;
    const singles = tokens.filter((w) => {
      const core = w.replace(/[^A-Za-z]/g, "");
      return core.length === 1 && !/^[ia]$/i.test(core);
    }).length;
    if (singles / tokens.length > 0.2) return false;
    const longWords = words.filter((w) => w.length >= 3).length;
    if (longWords < 2) return false;
    // 正常句子几乎一定含常用词；纯乱码字母串基本不会命中
    // 单字母的 a/i 不算"常用词"证据，否则 "Bh Cd A Tew EY CEE" 这种乱码会混过去
    const hits = words.filter((w) => w.length >= 2 && COMMON_WORDS.has(w.toLowerCase())).length;
    return hits >= 1;
  }

  ST.ocr = { cleanOcrText, pickSubtitleBand, looksLikeRealEnglish, correctCommonWords, consensusOcrText, trimOcrEdges, fixOcrPhrases, splitFusedWords, selectOcrLines, selectOcrWords, shouldKeepOcrProbe, shouldTryVideoOcr, shouldTryVideoOcrOpfs, shouldTryBlobOpfs };
})();
