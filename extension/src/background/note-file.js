// 复习笔记（扩展侧）：两种目标
//   ① 目录模式：用户选一个文件夹，可在里面「新建」笔记文件，之后都追加到它
//   ② 文件模式：用户直接选一个已有的笔记文件，之后都追加到这个文件
// 句柄存在扩展自己的 IndexedDB 里，写文件不需要再次授权。
import "../shared/protocol.js";
import "../shared/docx.js";

export const NOTE_FILE_NAME = "双语字幕笔记.docx";
const TEXT_STORE = "texts";
const DB_NAME = "st-notes-v2";   // 换新库名，避免旧库结构问题
const STORE = "handles";
const DIR_KEY = "note-dir";
const FILE_KEY = "note-file-target";

function openDb() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE)) db.createObjectStore(STORE);
      if (!db.objectStoreNames.contains(TEXT_STORE)) db.createObjectStore(TEXT_STORE);
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error || new Error("IndexedDB 打开失败"));
  });
}

async function idbGet(key) {
  const db = await openDb();
  return await new Promise((resolve, reject) => {
    const t = db.transaction(STORE, "readonly");
    const req = t.objectStore(STORE).get(key);
    req.onsuccess = () => resolve(req.result || null);
    req.onerror = () => reject(req.error);
  });
}

async function idbOpen() {
  const db = await openDb();
  if (db.objectStoreNames.contains(STORE) && db.objectStoreNames.contains(TEXT_STORE)) return db;
  const next = db.version + 1;
  db.close();
  return await new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, next);
    req.onupgradeneeded = () => {
      const d = req.result;
      if (!d.objectStoreNames.contains(STORE)) d.createObjectStore(STORE);
      if (!d.objectStoreNames.contains(TEXT_STORE)) d.createObjectStore(TEXT_STORE);
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function getCachedText(name) {
  try {
    const db = await idbOpen();
    return await new Promise((resolve) => {
      const req = db.transaction(TEXT_STORE, "readonly").objectStore(TEXT_STORE).get(name);
      req.onsuccess = () => resolve(typeof req.result === "string" ? req.result : "");
      req.onerror = () => resolve("");
    });
  } catch { return ""; }
}

async function setCachedText(name, text) {
  try {
    const db = await idbOpen();
    await new Promise((resolve) => {
      const t = db.transaction(TEXT_STORE, "readwrite");
      t.objectStore(TEXT_STORE).put(String(text), name);
      t.oncomplete = resolve;
      t.onerror = resolve;
    });
  } catch { /* ignore */ }
}

async function readDocxText(bytes) {
  const docx = globalThis.ST.docx;
  if (!docx) return null;
  if (docx.extractTextFromDocx) {
    const text = await docx.extractTextFromDocx(bytes);
    if (text !== null && text !== undefined) return text;
  }
  return docx.extractTextFromStoredDocx ? docx.extractTextFromStoredDocx(bytes) : null;
}

/** 文件名统一成 .docx */
export function toDocxName(name) {
  const n = String(name || "").trim() || NOTE_FILE_NAME;
  return /\.docx$/i.test(n) ? n : n.replace(/\.(txt|md|markdown)$/i, "") + ".docx";
}

export async function getDirHandle() { return await idbGet(DIR_KEY).catch(() => null); }
export async function getFileTarget() { return await idbGet(FILE_KEY).catch(() => null); }
export async function hasDir() { return !!(await getDirHandle()); }

/** 当前写入目标：优先"直接选的文件"，其次"文件夹 + 文件名" */
export async function getTarget() {
  // 文件夹优先：文件名由用户在文件夹下指定/新建
  const dir = await getDirHandle();
  if (dir) return { kind: "dir", handle: dir, folder: dir.name || "" };
  const file = await getFileTarget();
  if (file) return { kind: "file", handle: file, name: file.name };
  return null;
}

/** 列出文件夹里已有的笔记文件（供弹窗下拉选择） */
export async function listNotes() {
  const dir = await getDirHandle();
  if (!dir) return { ok: false, reason: "no-folder", files: [] };
  const files = [];
  try {
    for await (const [name, handle] of dir.entries()) {
      if (handle.kind !== "file") continue;
      if (!/\.(docx|txt|md|markdown)$/i.test(name)) continue;
      files.push(name);
    }
  } catch (err) {
    return { ok: false, reason: "list-failed", error: String(err && err.message ? err.message : err), files: [] };
  }
  files.sort();
  return { ok: true, folder: dir.name || "", files };
}

/** 追加一组字幕；保证「每组之间恰好一个空行」 */
export async function appendLines(lines, fileName) {
  const target = await getTarget();
  if (!target) return { ok: false, reason: "no-folder" };
  const finalName = toDocxName(fileName);
  let handle;
  try {
    handle = target.kind === "file"
      ? target.handle
      : await target.handle.getFileHandle(finalName, { create: true });
  } catch (err) {
    const msg = String(err && err.message ? err.message : err);
    const isNotFound = (err && err.name === "NotFoundError") || /could not be found|not found|does not exist|NotFound/i.test(msg);
    if (isNotFound) return { ok: false, reason: "missing-folder" };
    throw err;
  }

  const body = (Array.isArray(lines) ? lines : String(lines).split("\n"))
    .map((l) => String(l || "").replace(/\s+$/, ""))
    .filter((l) => l.trim())
    .join("\n");
  if (!body) return { ok: false, reason: "empty" };

  // 以磁盘上的文件为准：文件是空的就是空的（绝不能把旧缓存拼回来）
  let prev = "";
  let fileRead = false;
  try {
    const file = await handle.getFile();
    fileRead = true;
    if (file.size > 0) {
      const bytes0 = new Uint8Array(await file.arrayBuffer());
      const extracted = await readDocxText(bytes0);
      if (extracted === null || extracted === undefined) return { ok: false, reason: "foreign-docx" };
      prev = extracted;
    }
  } catch { fileRead = false; }
  if (!fileRead) prev = await getCachedText(handle.name);   // 只有读不出文件时才退回缓存
  if (globalThis.ST.docx && globalThis.ST.docx.isDuplicateGroup && globalThis.ST.docx.isDuplicateGroup(prev, body)) {
    return { ok: false, reason: "duplicate", file: handle.name };
  }
  const merged = prev.trimEnd() ? prev.trimEnd() + "\n\n" + body : body;
  const nextText = merged + "\n\n";
  const bytes = globalThis.ST.docx ? globalThis.ST.docx.buildFromText(nextText) : new TextEncoder().encode(nextText);

  try {
    const writable = await handle.createWritable();
    try { await writable.write(bytes); } finally { await writable.close(); }
  } catch (err) {
    const msg = String(err && err.message ? err.message : err);
    if (/permission|denied|NotAllowed/i.test(msg)) return { ok: false, reason: "permission" };
    throw err;
  }
  await setCachedText(handle.name, nextText);
  return { ok: true, file: handle.name, folder: target.folder || "", bytes: bytes.length };
}

/** 在已选文件夹里新建一个笔记文件 */
export async function createNote(fileName) {
  const dir = await getDirHandle();
  if (!dir) return { ok: false, reason: "no-folder" };
  const finalName = toDocxName(fileName);
  let existed = true;
  try {
    await dir.getFileHandle(finalName);       // 已存在则不再创建
  } catch {
    existed = false;
  }
  const handle = await dir.getFileHandle(toDocxName(fileName), { create: true });
  if (!existed) await setCachedText(finalName, "");   // 新建：清掉同名旧缓存
  return { ok: true, file: handle.name, folder: dir.name || "", created: !existed };
}

/** 读取当前笔记内容，并在离屏文档里建 blob 链接（离屏常驻，链接长期有效） */
/** 读取笔记原始字节（base64） */
export async function readBytes(fileName) {
  const target = await getTarget();
  if (!target) return { ok: false, reason: "no-folder" };
  const handle = target.kind === "file" ? target.handle : await target.handle.getFileHandle(toDocxName(fileName));
  const file = await handle.getFile();
  const buf = new Uint8Array(await file.arrayBuffer());
  let bin = "";
  const step = 0x8000;
  for (let i = 0; i < buf.length; i += step) bin += String.fromCharCode.apply(null, buf.subarray(i, i + step));
  return { ok: true, file: handle.name, folder: target.folder || "", base64: btoa(bin), size: buf.length };
}

/** 读取笔记文本（不带 blob 链接） */
export async function readNote(fileName) {
  const res = await readNoteWithUrl(fileName);
  return res && res.ok ? res.text : null;
}

export async function readNoteWithUrl(fileName) {
  const target = await getTarget();
  if (!target) return { ok: false, reason: "no-folder" };
  try {
    const handle = target.kind === "file"
      ? target.handle
      : await target.handle.getFileHandle(toDocxName(fileName));
    let text = "";
    try {
      const bytes = new Uint8Array(await (await handle.getFile()).arrayBuffer());
      text = (await readDocxText(bytes)) || "";
    } catch { text = await getCachedText(handle.name); }
    if (!text) return { ok: false, reason: "foreign-docx", file: handle.name };
    const url = URL.createObjectURL(new Blob([text], { type: "text/plain;charset=utf-8" }));
    return { ok: true, file: handle.name, folder: target.folder || "", text, url };
  } catch (err) {
    return { ok: false, reason: "missing", error: String(err && err.message ? err.message : err) };
  }
}