// 交叉验证：同一段内容用两种方法取出来，结果应该大致相同（而不是"出了字就算过"）
(() => {
  const ST = (globalThis.ST = globalThis.ST || {});
  const normWords = (t) => String(t || "")
    .toLowerCase()
    .replace(/[^a-z0-9'\u4e00-\u9fff]+/g, " ")
    .split(" ")
    .map((w) => w.trim())
    .filter((w) => w.length >= 2);

  /** 词集合重叠度（Jaccard）+ 长度比，0~1 */
  function textSimilarity(a, b) {
    const A = new Set(normWords(a));
    const B = new Set(normWords(b));
    if (!A.size || !B.size) return 0;
    let inter = 0;
    for (const w of A) if (B.has(w)) inter++;
    const jac = inter / (A.size + B.size - inter);
    const lenRatio = Math.min(A.size, B.size) / Math.max(A.size, B.size);
    return Number((jac * 0.75 + lenRatio * 0.25).toFixed(3));
  }

  /** 字符级编辑距离（0~1）：用来判断两次 OCR 是否同一句，比词集合更细。 */
  function charEditRatio(a, b) {
    const A = String(a || "").toLowerCase().replace(/[^a-z0-9' ]+/g, " ").replace(/\s+/g, " ").trim();
    const B = String(b || "").toLowerCase().replace(/[^a-z0-9' ]+/g, " ").replace(/\s+/g, " ").trim();
    if (A === B) return 0;
    if (!A || !B) return 1;
    let prev = Array.from({ length: B.length + 1 }, (_, i) => i);
    for (let i = 1; i <= A.length; i++) {
      const row = [i];
      for (let j = 1; j <= B.length; j++) {
        row[j] = Math.min(prev[j] + 1, row[j - 1] + 1, prev[j - 1] + (A[i - 1] === B[j - 1] ? 0 : 1));
      }
      prev = row;
    }
    return prev[B.length] / Math.max(A.length, B.length);
  }

  /** 两种方法的结果是否"大致相同" */
  function crossCheck(a, b, min) {
    const score = textSimilarity(a, b);
    const need = Number.isFinite(min) ? min : 0.45;
    return { ok: score >= need, score, threshold: need };
  }

  ST.textSimilarity = textSimilarity;
  ST.charEditRatio = charEditRatio;
  ST.crossCheck = crossCheck;
})();
