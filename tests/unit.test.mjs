// Unit tests: caption parsers, the 5-line rolling window, adapter fallback routing,
// and the translation post-processor. Run with: npm test
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

import "../extension/src/shared/protocol.js";
import "../extension/src/shared/dom-utils.js";
import "../extension/src/shared/subtitle-cache.js";
import "../extension/src/shared/docx.js";
import "../extension/src/shared/sentence-merge.js";
import "../extension/src/content/audio-capture.js";
import "../extension/src/shared/ocr-text.js";
import "../extension/src/shared/cross-check.js";
import "../extension/src/core/plan.js";
import "../extension/src/adapters/adapter-api.js";
import "../extension/src/core/router.js";
import { parseJson3, pickCaptionTrack } from "../extension/src/parsers/json3.js";
import { parseVtt, parseSrt } from "../extension/src/parsers/vtt.js";
import { parseBilibiliSubtitle, pickBilibiliTrack } from "../extension/src/parsers/bilibili.js";
import { cleanTranslation } from "../extension/src/background/model-manager.js";
import { asrOptionsForSeconds } from "../extension/src/background/asr-engine.js";
import { normalizeKey, cacheKey } from "../extension/src/background/translate-store.js";

const ST = globalThis.ST;
const util = ST.util;
const fixtures = path.resolve(import.meta.dirname, "fixtures");
const read = (f) => fs.readFileSync(path.join(fixtures, f), "utf8");

/* ----------------------------------------------------------------- platform parsers */

test("json3 解析：跳过无文本事件、合并 segs、换行转空格、缺省时长补齐", () => {
  const cues = parseJson3(JSON.parse(read("youtube-json3.json")));
  assert.equal(cues.length, 7, "应解析出 7 条字幕（aAppend 空事件必须丢弃）");
  assert.equal(cues[0].text, "Hello everyone and welcome back to the channel.");
  assert.equal(cues[0].start, 1.2);
  assert.ok(Math.abs(cues[0].end - 3.4) < 1e-9, `end 应为 3.4，实际 ${cues[0].end}`);
  assert.equal(cues[1].start, 3.6);
  assert.equal(cues[2].text, "[Music]");
  assert.equal(cues[2].end, 7.2, "缺少 dDurationMs 时用下一条的起始时间");
  assert.ok(cues.every((c) => c.end > c.start));
  assert.ok(cues.every((c, i) => i === 0 || c.start >= cues[i - 1].start), "必须按时间升序");
});

test("json3 解析：字符串输入与坏数据不会抛错", () => {
  assert.deepEqual(parseJson3("not-json"), []);
  assert.deepEqual(parseJson3({}), []);
  assert.deepEqual(parseJson3(null), []);
});

test("json3 轨道选择：优先人工英文字幕，其次自动字幕", () => {
  const tracks = [
    { languageCode: "ja", baseUrl: "u-ja", kind: "" },
    { languageCode: "en", baseUrl: "u-en-asr", kind: "asr" },
    { languageCode: "en", baseUrl: "u-en", kind: "" },
  ];
  assert.equal(pickCaptionTrack(tracks).baseUrl, "u-en");
  assert.equal(pickCaptionTrack([{ languageCode: "ja", baseUrl: "u-ja" }]).baseUrl, "u-ja", "没有英文时退化为唯一可用轨道");
  assert.equal(pickCaptionTrack([]), null);
});

test("WebVTT 解析：NOTE/STYLE/REGION 块、标签、实体、多行正文、长时间戳", () => {
  const cues = parseVtt(read("sample.vtt"));
  assert.equal(cues.length, 4);
  assert.equal(cues[0].text, "Welcome to the demo.");
  assert.equal(cues[0].start, 1);
  assert.equal(cues[0].end, 3.5);
  assert.equal(cues[1].text, "Second line & more.");
  assert.equal(cues[2].text, "Multi-line cue continues here.");
  assert.equal(cues[3].start, 70.5, "HH:MM:SS.mmm 解析正确");
  assert.ok(!cues.some((c) => /NOTE|STYLE|::cue|REGION|Kind:/.test(c.text)), "注释/样式/头部信息不能混入字幕");
});

test("SRT 解析：逗号毫秒分隔符与序号行", () => {
  const cues = parseSrt(read("sample.srt"));
  assert.equal(cues.length, 3);
  assert.equal(cues[0].start, 0.5);
  assert.equal(cues[1].text, "Second subtitle with two lines.");
  assert.equal(cues[2].text, "Third one.");
});

test("B站字幕解析与轨道选择", () => {
  const cues = parseBilibiliSubtitle(JSON.parse(read("bilibili-subtitle.json")));
  assert.equal(cues.length, 3);
  assert.equal(cues[1].text, "欢迎来到本期视频");
  assert.equal(cues[1].start, 3.5);
  const track = pickBilibiliTrack([
    { lan: "zh-CN", subtitle_url: "//x/zh.json" },
    { lan: "en-US", subtitle_url: "//x/en.json" },
  ]);
  assert.equal(track.subtitle_url, "//x/en.json");
  assert.equal(pickBilibiliTrack([]), null);
});

/* ----------------------------------------------------------------- 英文判定（实时检测） */

test("英文判定：英文字幕不会被误判成中文（含中文里夹英文词）", () => {
  const yes = [
    "Hello everyone, and welcome back to the channel.",
    "It's sloppily written and rendered at an extremely low resolution of 28x28 pixels,",
    "英语 点击 查看设置 Hello world",
    "[music]",
    ">> Move faster.",
    "OK 好",
    "Yeah, exactly.",
  ];
  const no = [
    "大家好，欢迎回到频道。",
    "おそらく鬼舞無惨は鬼たちを",
    "英语",
    "中文（中国）",
    "一个鲜血淋漓的真善良 为什么发给你的是40万的offer 但最后你到手只有6万 咱们来拆解一下这个校招offer里面的猫腻啊",
    "",
  ];
  for (const t of yes) assert.equal(util.isLikelyEnglish(t), true, "应判为英文：" + t);
  for (const t of no) assert.equal(util.isLikelyEnglish(t), false, "不应判为英文：" + t);
});

/* ----------------------------------------------------------------- rolling window */

function makeCues(n) {
  return Array.from({ length: n }, (_, i) => ({ start: i * 2, end: i * 2 + 1.9, text: `line ${i + 1}` }));
}

test("滑动窗口：当前 + 历史固定 5 条", () => {
  const cache = new ST.SubtitleCache(5);
  cache.load(makeCues(12));
  for (let t = 0.1; t < 20; t += 0.2) cache.update(t);
  const entries = cache.entries();
  assert.equal(entries.length, 5);
  assert.equal(entries[entries.length - 1].text, "line 10");
  assert.deepEqual(entries.slice(0, 4).map((e) => e.text), ["line 6", "line 7", "line 8", "line 9"]);
  assert.equal(entries.filter((e) => e.isCurrent).length, 1);
});

test("滑动窗口：中途打开弹窗时立即回填历史（不必等 4 条新字幕）", () => {
  const cache = new ST.SubtitleCache(5);
  cache.load(makeCues(20));
  cache.update(15.0);
  const entries = cache.entries();
  assert.equal(entries.length, 5, "打开瞬间就应有 5 条");
  assert.equal(entries[4].isCurrent, true);
  assert.equal(entries[4].text, "line 8");
});

test("滑动窗口：字幕在 1 秒内被记入（200ms 轮询下首个 tick 即命中）", () => {
  const cache = new ST.SubtitleCache(5);
  cache.load(makeCues(10));
  const res = cache.update(2.05);
  assert.equal(res.changed, true);
  assert.equal(cache.entries().at(-1).text, "line 2");
});

test("滑动窗口：拖动进度条（时间跳变）时重建窗口而不是留下陈旧字幕", () => {
  const cache = new ST.SubtitleCache(5);
  cache.load(makeCues(30));
  cache.update(2.1);
  cache.update(4.1);
  cache.update(6.1);
  assert.equal(cache.entries().length, 4, "窗口建立时会回填前面 1 条（播放中途打开也有上下文）");
  const res = cache.update(40.2);
  assert.equal(res.seeked, true);
  const entries = cache.entries();
  assert.equal(entries.at(-1).text, "line 21");
  assert.equal(entries.at(-1).isCurrent, true);
  assert.ok(entries.length <= 5);
  assert.ok(!entries.some((e) => e.text === "line 4"), "seek 后不能残留跳转前的字幕");
});

test("滑动窗口：同一句字幕重复出现时只保留最新一条（不重复显示）", () => {
  const cache = new ST.SubtitleCache(5);
  cache.load([]);
  cache.appendLive({ start: 1, end: 5, text: "[music]" });
  cache.appendLive({ start: 5, end: 9, text: ">> Mhm." });
  cache.appendLive({ start: 9, end: 13, text: "[music]" });   // 广告/重播导致重复
  cache.appendLive({ start: 13, end: 17, text: ">> Mhm." });
  const books = cache.entries().map((e) => e.text);
  assert.deepEqual(books, ["[music]", ">> Mhm."], "重复文本应只留最新一条");
  assert.equal(cache.entries().filter((e) => e.isCurrent).length, 1, "仍然只有一条当前字幕");
});

/* ----------------------------------------------------------------- router fallback (spec §11) */

function ctxStub() {
  return { video: null, location: { hostname: "example.com", href: "https://example.com/" }, document: null, requestSW: async () => ({}) };
}

test("字幕来源：OCR/ASR 来源随 cue 保留到窗口", () => {
  const cache = new globalThis.ST.SubtitleCache(5);
  assert.equal(cache.upsertLive({ key: "a", start: 1, end: 2, text: "hello there", source: "ocr" }), "add");
  assert.equal(cache.entries().slice(-1)[0].source, "ocr");
  cache.upsertLive({ key: "a", start: 1, end: 2, text: "hello there now", source: "asr" });
  assert.equal(cache.entries().slice(-1)[0].source, "asr");
});

test("ASR 句子合并保留 source", () => {
  const m = new globalThis.ST.SentenceMerger();
  const ev = m.push({ start: 1, end: 3, text: "hello there how", source: "asr" });
  assert.equal(ev[0].unit.source, "asr");
});

test("适配器路由：按站点选择适配器", () => {
  ST.clearAdapters();
  ST.registerAdapter({ id: "t-youtube", priority: 30, match: (l) => l.hostname.endsWith("youtube.com"), getSubtitles: async () => ({ cues: [] }) });
  ST.registerAdapter({ id: "t-generic", priority: 10, match: () => true, getSubtitles: async () => ({ cues: [] }) });
  const ids = ST.candidatesFor({ hostname: "www.youtube.com" }).map((a) => a.id);
  assert.ok(ids.includes("t-youtube"));
  assert.equal(ids[ids.length - 1], "t-generic", "低优先级排最后");
  const other = ST.candidatesFor({ hostname: "example.com" }).map((a) => a.id);
  assert.deepEqual(other, ["t-generic"]);
});

test("适配器失败自动降级到下一个，不抛出（spec §11）", async () => {
  ST.clearAdapters();
  ST.registerAdapter({
    id: "t-broken",
    priority: 100,
    match: () => true,
    getSubtitles: async () => { throw new ST.AdapterError("模拟适配器崩溃"); },
  });
  ST.registerAdapter({
    id: "t-second",
    priority: 90,
    match: () => true,
    getSubtitles: async () => ({ cues: [{ start: 1, end: 2, text: "fallback works" }], meta: { source: "second" } }),
  });
  const errors = [];
  const router = new ST.Router(ctxStub(), { onAdapterError: (a, e) => errors.push([a.id, e.message]) });
  const result = await router.resolveOnce();
  assert.equal(result.adapter.id, "t-second");
  assert.equal(result.cues.length, 1);
  assert.equal(errors[0][0], "t-broken");
  assert.equal(errors[0][1], "模拟适配器崩溃");
});

test("适配器返回空字幕也算失败并继续尝试", async () => {
  ST.clearAdapters();
  ST.registerAdapter({ id: "t-empty", priority: 80, match: () => true, getSubtitles: async () => ({ cues: [] }) });
  ST.registerAdapter({
    id: "t-last",
    priority: 70,
    match: () => true,
    getSubtitles: async () => [{ start: 0, end: 1, text: "ok" }],
  });
  const router = new ST.Router(ctxStub(), {});
  const result = await router.resolveOnce();
  assert.equal(result.adapter.id, "t-last");
});

test("全部适配器都失败时给出汇总错误（含每个适配器的失败原因）", async () => {
  ST.clearAdapters();
  ST.registerAdapter({ id: "t-fail-a", priority: 60, match: () => true, getSubtitles: async () => { throw new Error("A 崩了"); } });
  ST.registerAdapter({ id: "t-fail-b", priority: 50, match: () => true, getSubtitles: async () => { throw new Error("B 崩了"); } });
  const router = new ST.Router(ctxStub(), {});
  await assert.rejects(router.resolveOnce(), (err) => {
    assert.equal(err.message, "所有适配器都未能获取字幕");
    assert.deepEqual(err.details.errors.map((e) => e.adapter), ["t-fail-a", "t-fail-b"]);
    return true;
  });
});

test("router 规范化：丢弃空文本/非法时间，按 start 排序", async () => {
  ST.clearAdapters();
  ST.registerAdapter({
    id: "t-messy",
    priority: 40,
    match: () => true,
    getSubtitles: async () => ({ cues: [{ start: 5, end: 6, text: "b" }, { start: 1, end: 2, text: "a" }, { start: 3, end: 3, text: "  " }, { text: "no start" }] }),
  });
  const router = new ST.Router(ctxStub(), {});
  const res = await router.resolveOnce();
  assert.deepEqual(res.cues.map((c) => c.text), ["a", "b"]);
});

/* ----------------------------------------------------------------- translation post-processing */

test("译文后处理：去掉标签、引号、英文回显", () => {
  assert.equal(cleanTranslation("译文：大家好。", "Hello everyone."), "大家好。");
  assert.equal(cleanTranslation('"你好，世界"', "Hello world"), "你好，世界");
  assert.equal(cleanTranslation("  Welcome  to  the  demo  ", "Welcome to the demo"), "", "与原文相同的回显视为无译文");
  assert.equal(cleanTranslation("第一行\n第二行", "x"), "第一行 第二行");
});

test("缓存键：忽略大小写与多余空白，包含模型标签", () => {
  assert.equal(normalizeKey("  Hello   World  "), "hello world");
  assert.equal(cacheKey("Hello World"), cacheKey(" hello   world "));
  assert.notEqual(cacheKey("Hello"), cacheKey("Goodbye"));
});
/* ------------------------------------------------------------------ 笔记 docx（本地助手读写用） */

const docx = globalThis.ST.docx;

/** 造一个"别的软件存过"的 docx：deflate 压缩 + 目录项（长度 0） */
async function buildDeflateDocx(text) {
  const enc = new TextEncoder();
  const parts = [
    { name: "docProps/", data: new Uint8Array(0), method: 0 },
    { name: "word/document.xml", data: enc.encode(docx.paragraphsFromXml ? xmlFor(text) : ""), method: 8 },
  ];
  const chunks = [];
  const central = [];
  let offset = 0;
  for (const part of parts) {
    const raw = part.data;
    const nameBytes = enc.encode(part.name);
    let data = raw;
    let method = part.method;
    if (method === 8) {
      const stream = new Blob([raw]).stream().pipeThrough(new CompressionStream("deflate-raw"));
      data = new Uint8Array(await new Response(stream).arrayBuffer());
    }
    const local = new Uint8Array(30 + nameBytes.length);
    const lv = new DataView(local.buffer);
    lv.setUint32(0, 0x04034b50, true);
    lv.setUint16(4, 20, true);
    lv.setUint16(6, 0x0800, true);
    lv.setUint16(8, method, true);
    lv.setUint16(10, 0, true);
    lv.setUint16(12, 0, true);
    lv.setUint32(14, docx.crc32(raw), true);
    lv.setUint32(18, data.length, true);
    lv.setUint32(22, raw.length, true);
    lv.setUint16(26, nameBytes.length, true);
    lv.setUint16(28, 0, true);
    local.set(nameBytes, 30);
    chunks.push(local, data);
    const cd = new Uint8Array(46 + nameBytes.length);
    const cv = new DataView(cd.buffer);
    cv.setUint32(0, 0x02014b50, true);
    cv.setUint16(4, 20, true);
    cv.setUint16(6, 20, true);
    cv.setUint16(8, 0x0800, true);
    cv.setUint16(10, method, true);
    cv.setUint32(16, docx.crc32(raw), true);
    cv.setUint32(20, data.length, true);
    cv.setUint32(24, raw.length, true);
    cv.setUint16(28, nameBytes.length, true);
    cv.setUint32(42, offset, true);
    cd.set(nameBytes, 46);
    central.push(cd);
    offset += local.length + data.length;
  }
  const centralSize = central.reduce((n, c) => n + c.length, 0);
  const end = new Uint8Array(22);
  const ev = new DataView(end.buffer);
  ev.setUint32(0, 0x06054b50, true);
  ev.setUint16(8, parts.length, true);
  ev.setUint16(10, parts.length, true);
  ev.setUint32(12, centralSize, true);
  ev.setUint32(16, offset, true);
  const total = chunks.reduce((n, c) => n + c.length, 0) + centralSize + 22;
  const out = new Uint8Array(total);
  let at = 0;
  for (const c of [...chunks, ...central, end]) { out.set(c, at); at += c.length; }
  return out;
}

function xmlFor(text) {
  const body = String(text).split("\n").map((line) =>
    line === "" ? "<w:p/>" : `<w:p><w:r><w:t xml:space="preserve">${line}</w:t></w:r></w:p>`).join("");
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>${body}</w:body></w:document>`;
}

test("docx：自己写的文件能原样读回（段落不丢）", async () => {
  const text = "hello world\n你好，世界\n\nsecond group\n第二组\n";
  const bytes = docx.buildFromText(text);
  assert.equal(docx.extractTextFromStoredDocx(bytes), text);
});

test("docx：Word/WPS 重存过的压缩文件也能读回（追加不丢内容）", async () => {
  const text = "first line\n第一行\n\nsecond line\n第二行";
  const bytes = await buildDeflateDocx(text);
  assert.equal(docx.extractTextFromStoredDocx(bytes), null, "压缩格式不是本工具的 store 格式");
  const read = await docx.extractTextFromDocx(bytes);
  assert.equal(read, text);
});

/* ---------------------------------------------------- 句子合并（拆碎的 cue 拼回整句） */

const merge = () => globalThis.ST.mergeCuesIntoSentences;

test("ASR 重复句/整段去重：保留语义，去掉连续重复", () => {
  const d = globalThis.ST.dedupeAsrText;
  assert.equal(d("I'm not sure if I'm going to do it. I'm not sure if I'm going to do it."), "I'm not sure if I'm going to do it.");
  assert.equal(d("I'm not sure if I'm going to do it I'm not sure if I'm going to do it"), "I'm not sure if I'm going to do it");
  assert.equal(d("That's what he says now. That's what he says now."), "That's what he says now.");
  assert.equal(d("Hello there. How are you today?"), "Hello there. How are you today?");
  assert.equal(d("very very good"), "very very good", "短强调重复不要误删");
  assert.equal(d("no no no"), "no no no", "短重复不要误删");
  assert.equal(d(""), "");
});
test("句子合并：被拆成两段的句子合成一句", () => {
  const out = merge()([
    { start: 0, end: 3, text: "The particular light-sensitive cells in your eye that are firing when you" },
    { start: 3, end: 6, text: "see this 3 are very different from the ones firing when you see this 3." },
  ]);
  assert.equal(out.length, 1);
  assert.equal(out[0].text, "The particular light-sensitive cells in your eye that are firing when you see this 3 are very different from the ones firing when you see this 3.");
  assert.equal(out[0].start, 0);
  assert.equal(out[0].end, 6);
});

test("句子合并：重叠片段的 ASR 大写开头不另起一句", () => {
  const m = new globalThis.ST.SentenceMerger();
  m.push({ start: 0, end: 4, text: "solution of 28x28 pixels, but your brain has no trouble recognizing" });
  const ev = m.push({ start: 2, end: 6, text: "But your brain has no trouble recognizing it as a 3." });
  assert.equal(ev[0].unit.text, "solution of 28x28 pixels, but your brain has no trouble recognizing it as a 3.");
});

test("句子合并：ASR 重叠窗口从旧文本中段开始不会重复", () => {
  const m = new globalThis.ST.SentenceMerger();
  m.push({ start: 0, end: 4, text: "extremely low resolution of 28x28 pixels, but your brain has" });
  const ev = m.push({ start: 2, end: 6, text: "28 pixels, but your brain has no trouble recognizing it as a 3." });
  assert.equal(ev[0].unit.text, "extremely low resolution of 28x28 pixels, but your brain has no trouble recognizing it as a 3.");
});

test("句子合并：本来两句话不会被粘成一句", () => {
  const out = merge()([
    { start: 0, end: 2, text: "This is a 3." },
    { start: 2, end: 4, text: "Here is another one." },
  ]);
  assert.equal(out.length, 2);
  assert.equal(out[0].text, "This is a 3.");
  assert.equal(out[1].text, "Here is another one.");
});

test("句子合并：滚动字幕（新片段包含旧文本）不会重复", () => {
  const out = merge()([
    { start: 0, end: 1, text: "the quick brown" },
    { start: 1, end: 2, text: "the quick brown fox" },
    { start: 2, end: 3, text: "quick brown fox jumps" },
    { start: 3, end: 4, text: "brown fox jumps over" },
  ]);
  assert.equal(out.length, 1);
  assert.equal(out[0].text, "the quick brown fox jumps over");
});

test("句子合并：没有标点也不会无限长（到长度上限收句）", () => {
  const cues = [];
  for (let i = 0; i < 12; i++) cues.push({ start: i, end: i + 0.9, text: "word" + i });
  const out = merge()(cues, { maxChars: 20 });
  assert.ok(out.length >= 3, "应至少收成 3 句，实际 " + out.length);
  assert.ok(out.every((c) => c.text.length <= 40));
});

test("句子合并：停顿超过 1.5 秒就断句", () => {
  const out = merge()([
    { start: 0, end: 1, text: "first part here" },
    { start: 4, end: 5, text: "second part here" },
  ]);
  assert.equal(out.length, 2);
  assert.equal(out[0].text, "first part here");
  assert.equal(out[1].text, "second part here");
});

test("实时合并器：调用方可以拿到 partial，收句时拿到 commit", () => {
  const merger = new globalThis.ST.SentenceMerger();
  const seen = [];
  const push = (c) => { for (const ev of merger.push(c)) seen.push(ev.type + ":" + ev.unit.text + (ev.unit.done ? "#done" : "")); };
  push({ start: 0, end: 1, text: "one two" });
  push({ start: 1, end: 2, text: "three four" });
  push({ start: 2, end: 3, text: "five six." });
  const flushed = merger.flush();
  assert.equal(seen[0], "partial:one two");
  assert.equal(seen[1], "partial:one two three four");
  assert.equal(seen[2], "partial:one two three four five six.");
  assert.equal(seen[3], "commit:one two three four five six.#done");
  assert.equal(flushed.length, 0);
});

test("docx：空笔记追加时只写当前三条（不会把旧内容拼回来）", async () => {
  const docx = globalThis.ST.docx;
  const empty = docx.buildFromText("");
  assert.equal(await docx.extractTextFromDocx(empty), "", "空文档应读回空字符串（不是 null）");
  const body = "This is a 3.\n这是一个3。\nSee this 3.\n看这个3。";
  const first = docx.buildFromText(body + "\n\n");
  assert.equal((await docx.extractTextFromDocx(first)).trim(), body);
  // 第二次追加：老内容 + 一个空行 + 新内容
  const second = docx.buildFromText(body + "\n\nNext line.\n下一行。\n\n");
  assert.equal((await docx.extractTextFromDocx(second)).trim(), body + "\n\nNext line.\n下一行。");
});

test("docx：同一组内容不会被重复追加（识别最后一组）", () => {
  const docx = globalThis.ST.docx;
  const g1 = "This is a 3.\n这是一个3。\nSee this 3.\n看这个3。";
  const g2 = "Next line.\n下一行。\nAnother.\n另一个。";
  const text = g1 + "\n\n" + g2 + "\n\n";
  assert.equal(docx.lastGroup(text), g2);
  assert.equal(docx.isDuplicateGroup(text, g2), true, "刚存过的同一组应判为重复");
  assert.equal(docx.isDuplicateGroup(text, g1), false, "不同组不算重复");
  assert.equal(docx.isDuplicateGroup("", g1), false, "空笔记不算重复");
  assert.equal(docx.isDuplicateGroup(g1 + "\n\n", g1.replace(/\s+/g, "  ")), true, "空白差异不影响判定");
});

test("音频 VAD：裁掉首尾静音，纯静音返回空", () => {
  const trim = globalThis.ST.audioCapture.trimSilence;
  const rate = 16000;
  const a = new Float32Array(rate * 2);
  for (let i = rate * 0.5; i < rate * 1.5; i++) a[i] = 0.2 * Math.sin(2 * Math.PI * 220 * i / rate);
  const r = trim(a);
  assert.ok(r.pcm.length < a.length, "应裁掉静音");
  assert.ok(r.speechSec >= 0.9 && r.speechSec <= 1.2, "语音时长约 1 秒");
  assert.equal(trim(new Float32Array(rate)).pcm.length, 0, "纯静音应跳过");
});

test("音频预处理：压掉低频轰鸣，保留语音频段并归一化", () => {
  const cond = globalThis.ST.audioCapture.conditionPcm;
  const rate = 16000, n = rate * 2;
  const tone = (hz, amp) => {
    const a = new Float32Array(n);
    for (let i = 0; i < n; i++) a[i] = amp * Math.sin(2 * Math.PI * hz * i / rate);
    return a;
  };
  const rms = (a) => { let s = 0; for (const x of a) s += x * x; return Math.sqrt(s / Math.max(1, a.length)); };
  const rumble = tone(50, 0.3);
  const rumbleOut = cond(rumble, { normalize: false });
  assert.ok(rms(rumbleOut) < rms(rumble) * 0.75, "50Hz 轰鸣应被明显压低");
  const voice = tone(440, 0.1);
  const voiceOut = cond(voice, { normalize: false });
  assert.ok(rms(voiceOut) > rms(voice) * 0.85, "440Hz 语音频段应基本保留");
  const quiet = cond(tone(440, 0.01));
  let peak = 0;
  for (const x of quiet) peak = Math.max(peak, Math.abs(x));
  assert.ok(peak > 0.05 && peak <= 0.95, "小音量语音应被提升到可用电平");
  assert.equal(cond(new Float32Array(0)).length, 0, "空音频不应抛错");
});
test("ASR 参数：短音频不分块，长音频才分块", () => {
  assert.deepEqual(asrOptionsForSeconds(10), { return_timestamps: false });
  assert.deepEqual(asrOptionsForSeconds(30), { return_timestamps: false, chunk_length_s: 30, stride_length_s: 5 });
});

/* ------------------------------------------------------------ OCR 文本后处理 */

test("OCR 文本清理：去符号行、拼行、去重复", () => {
  const ocr = globalThis.ST.ocr;
  assert.equal(ocr.cleanOcrText("Hello\nthere.|\n===\n"), "Hello there.");
  assert.equal(ocr.cleanOcrText("Hello world\nHello world"), "Hello world");
  assert.equal(ocr.cleanOcrText("  |  |  "), "");
  assert.equal(ocr.cleanOcrText(">> Move\u00a0faster."), ">> Move faster.");
});

test("OCR 常用词纠错：只改高置信度错误，保留正常屈折和名字", () => {
  const fix = globalThis.ST.ocr.correctCommonWords;
  assert.equal(fix("I recieve teh message from my Youtube Shannel"), "I receive the message from my Youtube Channel");
  assert.equal(fix("it comes to me and I started learning English"), "it comes to me and I started learning English");
  assert.equal(fix("Hello everyone, I am John Smith"), "Hello everyone, I am John Smith");
  assert.equal(fix("The channel is great"), "The channel is great");
});

test("OCR 多帧投票：多数帧纠正尾部噪声并保留整句", () => {
  const vote = globalThis.ST.ocr.consensusOcrText;
  const r = vote([
    { text: "about my New Year's Resolution when it comes 3 Ra", confidence: 72 },
    { text: "about my New Year's Resolution when it comes to", confidence: 80 },
    { text: "about my New Year's Resolution when it comes to", confidence: 84 },
  ]);
  assert.equal(r.text, "about my New Year's Resolution when it comes to");
  assert.equal(r.samples, 3);
  assert.ok(r.agreement >= 0.8, "多数一致时 agreement 应该高");
});

test("OCR 多帧投票：两帧有分歧时由置信度更高的写法胜出", () => {
  const vote = globalThis.ST.ocr.consensusOcrText;
  const r = vote([
    { text: "It took him in losing the battle", confidence: 82 },
    { text: "It took him and losing the battle", confidence: 58 },
  ]);
  assert.equal(r.text, "It took him in losing the battle");
});

test("OCR 粘连词切分：高确定模式才切，正常词/品牌名不动", () => {
  const fix = globalThis.ST.ocr.correctCommonWords;
  assert.equal(fix("I hope you had a goodiNew Year’s Evefandis"), "I hope you had a good New Year’s Eve and");
  assert.equal(fix("I just wanted to start thislvideo by,thanking all of you for watching InyfYourype videos."), "I just wanted to start this video by thanking all of you for watching my YouTube videos.");
  assert.equal(fix("Facebook and YouTube are great"), "Facebook and YouTube are great");
  assert.equal(fix("something everything another"), "something everything another");
});

test("OCR 真实帧修正：New Year's / also a lot / 尾部噪声", () => {
  const fix = globalThis.ST.ocr.correctCommonWords;
  const lines = (ls) => globalThis.ST.ocr.selectOcrLines(ls, 216);
  assert.equal(fix("I hope you had a good New, Year's Eve, and! I hope that the new year treats SY well."), "I hope you had a good New Year's Eve, and I hope that the new year treats you well.");
  assert.equal(lines([
    { text: "I hope you had a good New, Year's Eve, and!", confidence: 90, bbox: { y0: 118, y1: 165 } },
    { text: "I hope that the new year: treats SY well.", confidence: 73, bbox: { y0: 154, y1: 216 } },
  ]), "I hope you had a good New Year's Eve, and I hope that the new year treats you well.");
  assert.equal(lines([{ text: "I just wanted to start this video by, thanking Cea Xe", confidence: 76, bbox: { y0: 105, y1: 170 } }]), "I just wanted to start this video by thanking");
  assert.equal(fix("also lot of fun for mejtoymake, ard I started"), "also a lot of fun for me to make, and I started");
});

test("OCR 行级过滤：只保留高置信字幕行，并修掉背景噪声/粘连词", () => {
  const lines = [
    { text: "AEDT TION         gy    Sy 4&8        [Se", confidence: 36, bbox: { y0: 0, y1: 25 } },
    { text: "I know they help you'learn! English, but their     2,", confidence: 83, bbox: { y0: 110, y1: 165 } },
    { text: "7              also alot of fun for me togmake, and I started", confidence: 81, bbox: { y0: 146, y1: 188 } },
    { text: ":                    y                        A           TN               :", confidence: 17, bbox: { y0: 166, y1: 216 } },
  ];
  const expected = "I know they help you learn English, but they're also a lot of fun for me to make, and I started";
  assert.equal(globalThis.ST.ocr.selectOcrLines(lines, 216), expected);
  assert.equal(globalThis.ST.ocr.selectOcrLines([{ text: "I know they help you learn English", confidence: 90, bbox: { y0: 1, y1: 30 } }], 40), "I know they help you learn English", "紧裁后的字幕行不能被纵向过滤误杀");
});

test("OCR 逐词兜底：低置信背景词被丢弃", () => {
  const words = [
    { text: "I", confidence: 95, bbox: { y0: 110, y1: 140 } },
    { text: "know", confidence: 93, bbox: { y0: 110, y1: 140 } },
    { text: "TAG", confidence: 16, bbox: { y0: 0, y1: 20 } },
    { text: "they", confidence: 96, bbox: { y0: 110, y1: 140 } },
    { text: "help", confidence: 93, bbox: { y0: 110, y1: 140 } },
    { text: "you", confidence: 97, bbox: { y0: 110, y1: 140 } },
    { text: "learn", confidence: 94, bbox: { y0: 110, y1: 140 } },
    { text: "English", confidence: 96, bbox: { y0: 110, y1: 140 } },
  ];
  assert.equal(globalThis.ST.ocr.selectOcrWords(words, 216), "I know they help you learn English");
});

test("后台视频 OCR 兜底条件：仅短直链且页面不能取帧", () => {
  const ok = globalThis.ST.ocr.shouldTryVideoOcr;
  assert.equal(ok({ src: "https://x/a.mp4", duration: 60, tried: false, canCaptureFrames: false }), true);
  assert.equal(ok({ src: "blob:https://x/a", duration: 60, tried: false, canCaptureFrames: false }), false);
  assert.equal(ok({ src: "https://x/a.mp4", duration: 900, tried: false, canCaptureFrames: false }), false);
  assert.equal(ok({ src: "https://x/a.mp4", duration: 60, tried: true, canCaptureFrames: false }), false);
  assert.equal(ok({ src: "https://x/a.mp4", duration: 60, tried: false, canCaptureFrames: true }), false);
});

test("长直链视频 OPFS 兜底条件", () => {
  const ok = globalThis.ST.ocr.shouldTryVideoOcrOpfs;
  assert.equal(ok({ src: "https://x/a.mp4", duration: 900, tried: false, canCaptureFrames: false }), true);
  assert.equal(ok({ src: "https://x/a.mp4", duration: 120, tried: false, canCaptureFrames: false }), false);
  assert.equal(ok({ src: "blob:https://x/a", duration: 900, tried: false, canCaptureFrames: false }), false);
  assert.equal(ok({ src: "https://x/a.mp4", duration: 2000, tried: false, canCaptureFrames: false }), false);
});

test("blob 视频 OPFS 兜底条件", () => {
  const ok = globalThis.ST.ocr.shouldTryBlobOpfs;
  assert.equal(ok({ src: "blob:https://x/a", tried: false, canCaptureFrames: false }), true);
  assert.equal(ok({ src: "https://x/a", tried: false, canCaptureFrames: false }), false);
  assert.equal(ok({ src: "blob:https://x/a", tried: true, canCaptureFrames: false }), false);
  assert.equal(ok({ src: "blob:https://x/a", tried: false, canCaptureFrames: true }), false);
});

test("OCR 无硬字幕探测：稳定识别到 2 条才继续", () => {
  const keep = globalThis.ST.ocr.shouldKeepOcrProbe;
  assert.equal(keep({ hits: 0, attempts: 5, elapsedMs: 9000 }), false);
  assert.equal(keep({ hits: 1, attempts: 5, elapsedMs: 9000 }), false);
  assert.equal(keep({ hits: 2, attempts: 3, elapsedMs: 9000 }), true);
  assert.equal(keep({ hits: 0, attempts: 1, elapsedMs: 5000 }), true, "探测期未结束前继续");
});

test("OCR 短行质量闸门：垃圾短行拒绝，正常短句保留", () => {
  const lines = (text) => globalThis.ST.ocr.selectOcrLines([{ text, confidence: 85, bbox: { y0: 100, y1: 150 } }], 216);
  assert.equal(lines("iat 1 hear you Savall"), "");
  assert.equal(lines("I love you"), "I love you");
  assert.equal(lines("Hello everyone"), "Hello everyone");
});

test("字幕窗口：可以按来源清掉 OCR 临时行", () => {
  const cache = new globalThis.ST.SubtitleCache(5);
  cache.upsertLive({ key: "o", start: 1, end: 2, text: "garbage ocr line", source: "ocr" });
  cache.upsertLive({ key: "a", start: 2, end: 3, text: "hello from asr", source: "asr" });
  assert.equal(cache.removeWhere((c) => c.source === "ocr"), 1);
  assert.equal(cache.entries().length, 1);
  assert.equal(cache.entries()[0].source, "asr");
});

test("OCR 取字幕带：只截底部一小块", () => {
  const ocr = globalThis.ST.ocr;
  const b = ocr.pickSubtitleBand(1080, 1920, 0.26);
  assert.equal(b.sw, 1080);
  assert.ok(b.sy > 1200 && b.sy + b.sh === 1920);
  const small = ocr.pickSubtitleBand(1, 1, 0.01);
  assert.ok(small.sh >= 1);
});

/* ------------------------------------------------ 来源决策：语言优先 + 资源盘点 */

test("来源决策：先判断语言，再按资源排方法", () => {
  const { detectVideoLanguage, inventoryResources, planSources } = globalThis.ST;
  assert.equal(detectVideoLanguage({ tracks: [{ lan: "en-US" }] }).language, "en");
  assert.equal(detectVideoLanguage({ domCaption: "Hello there, how are you doing" }).language, "en");
  assert.equal(detectVideoLanguage({ tracks: [{ lan: "ai-zh" }] }).language, "unknown");

  const inv = inventoryResources({
    tracks: [{ lan: "ai-zh" }],
    domCaption: "Hello there, how are you doing",
    canCaptureFrames: true,
    canCaptureAudio: true,
  });
  assert.equal(inv.hasEnglishTrack, false);
  assert.equal(inv.hasEnglishDomCaption, true);

  const en = planSources({ language: "en" }, inv);
  assert.equal(en.english, true);
  assert.ok(en.steps.some((s) => s.source === "ocr"));
  assert.ok(en.steps.some((s) => s.source === "asr"));

  const need1 = globalThis.ST.needsAudioLanguageProbe({ language: "unknown", evidence: "only-ai-zh" }, { hasEnglishTrack: false, hasEnglishDomCaption: false });
  assert.equal(need1.needed, true, "没有英文证据时必须先听音判断");
  const need2 = globalThis.ST.needsAudioLanguageProbe({ language: "en", evidence: "english-subtitle-track" }, { hasEnglishTrack: true });
  assert.equal(need2.needed, false, "有英文字幕就不必再听音");

  const gate = globalThis.ST.shouldTranslateSegment;
  assert.equal(gate({ language: "en", text: "Hello there, how are you" }).translate, true);
  assert.equal(gate({ language: "zh", text: "你好，欢迎回来" }).translate, false, "中文段不翻");
  assert.equal(gate({ hasSpeech: false, text: "" }).translate, false, "静音/没说话不翻");
  assert.equal(gate({ language: "en", text: "" }).translate, false, "空文本不翻");
  assert.equal(gate({ language: "en", text: "你好，欢迎回来" }).translate, false, "语言标错时文本再兜一层");

  const zh = planSources({ language: "zh" }, inv);
  assert.equal(zh.english, false);
  assert.ok(zh.steps.every((s) => s.source === "soft"), "非英语视频不排 OCR/ASR");
});

test("OCR/ASR 质量闸门：乱码挡掉、正常英文通过", () => {
  const q = globalThis.ST.ocr.looksLikeRealEnglish;
  const good = [
    "Hello everyone and welcome back to the channel",
    "This is a simple burned in subtitle test",
    "It took him in losing the battle",
  ];
  const bad = [
    "J PJ lJ J) J Fea Ji a oil oe Noy Net DEE BL",
    "Se fe",
    "hello",
    "1 2 3 4 5 6 7 8",
    "a b c d e f g h",
    "Bh Cd A Tew EY CEE",
  ];
  for (const s of good) assert.equal(q(s), true, "应通过：" + s);
  for (const s of bad) assert.equal(q(s), false, "应拦住：" + s);
});

test("字符编辑距离：同句 OCR 微差应接近 0，相邻句子应明显更大", () => {
  const d = globalThis.ST.charEditRatio;
  assert.ok(d("with the right accent.", "with the right accents.") < 0.1);
  assert.ok(d("I want to tell you something", "I want to tell you a story") > 0.24);
});
test("OCR/ASR 交叉验证：垃圾 OCR 低分，正常 OCR 高分", () => {
  const cc = globalThis.ST.crossCheck;
  const asr = "How long do you think it takes to become fluent in English?";
  assert.ok(cc("do ygu think 1.9 be come - In", asr).score < 0.45);
  assert.ok(cc("do to be come English", asr).score < 0.45);
  assert.ok(cc("depends What hear you're)", asr).score < 0.45);
  assert.ok(cc("right now am walking on the sidewalk", "right now I am walking on the sidewalk").score >= 0.45);
});

test("交叉验证：两种方法结果应大致相同", () => {
  const { textSimilarity, crossCheck } = globalThis.ST;
  const a = "It took him in losing the battle";
  const b = "it took him in losing the battle";
  assert.ok(textSimilarity(a, b) > 0.9, "几乎一样应接近 1");
  assert.ok(crossCheck("It took him in losing the battle", "it took him and losing the battle").score >= 0.45, "OCR/ASR 小误差仍应通过");
  assert.equal(crossCheck("hello welcome back", "完全不同的一句话").ok, false);
  assert.equal(crossCheck("J PJ lJ J Fea", "It took him in losing the battle").ok, false, "乱码不能通过");
});
