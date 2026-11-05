// 复习笔记（页面端）：文件夹句柄存在**页面自己的 IndexedDB** 里。
// 这样做的好处：授权/重新授权可以在"按 V 的那次按键手势"里完成，不用再跑去扩展面板点确认。
(() => {
  const ST = (globalThis.ST = globalThis.ST || {});
  const util = ST.util;

  const DB_NAME = "st-notes-page-v2";   // 换新库名：旧库曾出现"缺表/被占用"导致所有写入失败
  const STORE = "handles";
  const DIR_KEY = "note-dir";
  const DEFAULT_FILE = "双语字幕笔记.docx";
  const TEXT_STORE = "texts";

  function openOnce(version) {
    return new Promise((resolve, reject) => {
      const req = version ? indexedDB.open(DB_NAME, version) : indexedDB.open(DB_NAME);
      req.onupgradeneeded = () => {
        const db = req.result;
        if (!db.objectStoreNames.contains(STORE)) db.createObjectStore(STORE);
        if (!db.objectStoreNames.contains(TEXT_STORE)) db.createObjectStore(TEXT_STORE);
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error || new Error("IndexedDB 打开失败"));
      req.onblocked = () => reject(new Error("blocked"));
    });
  }

  /** 被其它连接阻塞时等一会再试（升级完成即可用） */
  async function openWithRetry(version, tries) {
    const max = tries || 4;
    let lastErr = null;
    for (let i = 0; i < max; i++) {
      try { return await openOnce(version); }
      catch (err) {
        lastErr = err;
        if (!/blocked|占用/i.test(String(err && err.message ? err.message : err))) throw err;
        await new Promise((r) => setTimeout(r, 300 * (i + 1)));
      }
    }
    throw lastErr || new Error("IndexedDB 打不开");
  }

  /** 兼容旧库：缺表就升级重建；版本冲突则退一步重试 */
  async function openDb() {
    const db = await openWithRetry();
    if (db.objectStoreNames.contains(STORE) && db.objectStoreNames.contains(TEXT_STORE)) return db;
    const nextVersion = db.version + 1;
    db.close();
    return await openWithRetry(nextVersion);
  }

  async function getCachedText(name) {
    try {
      const db = await openDb();
      return await new Promise((resolve) => {
        const req = db.transaction(TEXT_STORE, "readonly").objectStore(TEXT_STORE).get(name);
        req.onsuccess = () => resolve(typeof req.result === "string" ? req.result : "");
        req.onerror = () => resolve("");
      });
    } catch { return ""; }
  }

  async function setCachedText(name, text) {
    try {
      const db = await openDb();
      await new Promise((resolve) => {
        const t = db.transaction(TEXT_STORE, "readwrite");
        t.objectStore(TEXT_STORE).put(String(text), name);
        t.oncomplete = resolve;
        t.onerror = resolve;
      });
    } catch { /* 缓存失败不影响写文件 */ }
  }

  async function readDocxText(bytes) {
    const docx = ST.docx;
    if (!docx) return null;
    if (docx.extractTextFromDocx) {
      const text = await docx.extractTextFromDocx(bytes);
      if (text !== null && text !== undefined) return text;
    }
    return docx.extractTextFromStoredDocx ? docx.extractTextFromStoredDocx(bytes) : null;
  }

  /** 文件名统一成 .docx */
  function toDocxName(name) {
    const n = String(name || "").trim() || DEFAULT_FILE;
    return /\.docx$/i.test(n) ? n : n.replace(/\.(txt|md|markdown)$/i, "") + ".docx";
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

  async function idbSet(key, value) {
    const db = await openDb();
    await new Promise((resolve, reject) => {
      const t = db.transaction(STORE, "readwrite");
      if (value) t.objectStore(STORE).put(value, key);
      else t.objectStore(STORE).delete(key);
      t.oncomplete = () => resolve(true);
      t.onerror = () => reject(t.error);
    });
  }

  let sessionFolder = null;   // 内存兜底：写库失败时本次会话仍然可用
  let writeChain = Promise.resolve();   // 写入串行队列：连续保存不会互相覆盖

  function enqueue(task) {
    const run = writeChain.then(task, task);
    writeChain = run.then(() => undefined, () => undefined);
    return run;
  }

  async function getFolder() {
    const stored = await idbGet(DIR_KEY).catch(() => null);
    if (stored) return stored;
    return sessionFolder;
  }

  async function permissionState(handle) {
    if (!handle || typeof handle.queryPermission !== "function") return "granted";
    try { return await handle.queryPermission({ mode: "readwrite" }); } catch { return "denied"; }
  }

  /** 需要时在"当前这次按键手势"里申请写权限 */
  function classify(err) {
    const msg = String(err && err.message ? err.message : err);
    try { util.warn("[笔记] 原始错误:", msg, err && err.name ? "(" + err.name + ")" : ""); } catch { /* ignore */ }
    if (/already active/i.test(msg)) return "picker-active";
    if (/state cached in an interface object|invalidated|no longer exists/i.test(msg)) return "stale-handle";
    if (/permission|denied|NotAllowed/i.test(msg)) return "permission";
    if ((err && err.name === "NotFoundError") || /could not be found|not found|does not exist/i.test(msg)) return "missing-folder";
    return "error";
  }

  async function ensurePermission(handle) {
    let h = handle || (await getFolder());
    if (!h) return { ok: false, reason: "no-folder" };
    try {
      const state = await permissionState(h);
      if (state === "granted") return { ok: true, handle: h };
      if (!h.requestPermission) return { ok: false, reason: "permission", handle: h };
      const asked = await h.requestPermission({ mode: "readwrite" });
      if (asked === "granted") return { ok: true, handle: h };
      return { ok: false, reason: "permission", handle: h };
    } catch (err) {
      const reason = classify(err);
      if (reason === "stale-handle") {
        // 句柄彻底失效：清掉，让上层重新选
        sessionFolder = null;
        await idbSet(DIR_KEY, null).catch(() => null);
      }
      return { ok: false, reason };
    }
  }

  async function publish(folderName) {
    try {
      const res = await listFiles();
      await chrome.storage.local.set({
        st_note_dir: folderName || "",
        st_note_files: (res && res.files) || [],
        st_note_files_at: Date.now(),
      });
    } catch { /* 状态展示用，失败不影响 */ }
  }

  /** 页面上按 V：没有文件夹就选一个；有但没权限就重新授权 */
  async function ensureFolderInteractively() {
    let handle = await getFolder();
    if (handle) {
      const perm = await ensurePermission(handle);
      if (perm.ok) { await publish(handle.name); return { ok: true, action: "granted", folder: handle.name || "" }; }
      if (perm.reason === "permission") return { ok: false, reason: "permission", folder: handle.name || "" };
      handle = null;   // 句柄失效 → 重新选
    }
    if (typeof window.showDirectoryPicker !== "function") return { ok: false, reason: "unsupported" };
    try {
      const picked = await window.showDirectoryPicker({ id: "st-note-dir", mode: "readwrite", startIn: "desktop" });
      sessionFolder = picked;                       // 先放内存，保证本次会话一定可用
      let stored = true;
      try { await idbSet(DIR_KEY, picked); } catch (e) { stored = false; util.warn("保存文件夹句柄失败（本次会话仍可用）", e); }
      const perm = await ensurePermission(picked);
      await publish(picked.name);
      if (!perm.ok) return { ok: false, reason: "permission", folder: picked.name || "" };
      return { ok: true, action: "picked", folder: picked.name || "", stored };
    } catch (err) {
      const msg = err && err.message ? err.message : String(err);
      const reason = /abort/i.test(msg) ? "aborted" : classify(err);
      return { ok: false, reason, error: String(msg).slice(0, 160) };
    }
  }

  async function listFiles() {
    const dir = await getFolder();
    if (!dir) return { ok: false, reason: "no-folder", files: [] };
    const perm = await permissionState(dir);
    if (perm !== "granted") return { ok: false, reason: "permission", files: [] };
    const files = [];
    try {
      for await (const [name, h] of dir.entries()) {
        if (h.kind === "file" && /\.(docx|txt|md|markdown)$/i.test(name)) files.push(name);
      }
    } catch (err) {
      return { ok: false, reason: "list-failed", files: [], error: String(err && err.message ? err.message : err) };
    }
    files.sort();
    return { ok: true, folder: dir.name || "", files };
  }

  async function createFile(name) {
    const dir = await getFolder();
    if (!dir) return { ok: false, reason: "no-folder" };
    const finalName = toDocxName(name);
    let existed = true;
    try { await dir.getFileHandle(finalName); } catch { existed = false; }
    const handle = await dir.getFileHandle(finalName, { create: true });
    if (!existed) await setCachedText(finalName, "");   // 新建：清掉同名旧缓存，别让旧内容被拼回来
    await publish(dir.name);
    return { ok: true, file: handle.name, folder: dir.name || "", created: !existed };
  }

  /** 追加一组字幕：保证「每组之间恰好一个空行」 */
  async function appendLines(lines, fileName) {
    return await enqueue(() => appendLinesNow(lines, fileName));
  }

  async function appendLinesNow(lines, fileName) {
    const perm = await ensurePermission();
    if (!perm.ok) return { ok: false, reason: perm.reason };
    const dir = perm.handle;
    const finalName = toDocxName(fileName);
    let handle;
    try {
      handle = await dir.getFileHandle(finalName, { create: true });
    } catch (err) {
      const msg = String(err && err.message ? err.message : err);
      if ((err && err.name === "NotFoundError") || /could not be found|not found|does not exist/i.test(msg)) return { ok: false, reason: "missing-folder" };
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
    if (!fileRead) prev = await getCachedText(finalName);   // 只有读不出文件（例如被 Word 锁住）才退回缓存

    if (ST.docx && ST.docx.isDuplicateGroup && ST.docx.isDuplicateGroup(prev, body)) return { ok: false, reason: "duplicate", file: finalName };
    const merged = prev.trimEnd() ? prev.trimEnd() + "\n\n" + body : body;
    const nextText = merged + "\n\n";
    const bytes = ST.docx ? ST.docx.buildFromText(nextText) : new TextEncoder().encode(nextText);

    try {
      const writable = await handle.createWritable();
      try { await writable.write(bytes); } finally { await writable.close(); }
    } catch (err) {
      const reason = classify(err);
      if (reason === "stale-handle") { sessionFolder = null; await idbSet(DIR_KEY, null).catch(() => null); }
      if (reason !== "error") return { ok: false, reason };
      throw err;
    }
    await setCachedText(finalName, nextText);
    await publish(dir.name);
    return { ok: true, file: handle.name, folder: dir.name || "", bytes: bytes.length };
  }

  async function readText(fileName) {
    const perm = await ensurePermission();
    if (!perm.ok) return { ok: false, reason: perm.reason };
    const finalName = toDocxName(fileName);
    try {
      const handle = await perm.handle.getFileHandle(finalName);
      let text = "";
      try {
        const bytes = new Uint8Array(await (await handle.getFile()).arrayBuffer());
        text = (await readDocxText(bytes)) || "";
      } catch { text = await getCachedText(finalName); }
      if (!text) return { ok: false, reason: "foreign-docx", file: finalName };
      const url = URL.createObjectURL(new Blob([text], { type: "text/plain;charset=utf-8" }));
      return { ok: true, file: handle.name, folder: perm.handle.name || "", text, url };
    } catch (err) {
      return { ok: false, reason: "missing", error: String(err && err.message ? err.message : err) };
    }
  }

  /** 读取笔记文件原始字节（base64），用于"用 Word 打开" */
  async function readBytes(fileName) {
    const perm = await ensurePermission();
    if (!perm.ok) return { ok: false, reason: perm.reason };
    const finalName = toDocxName(fileName);
    try {
      const handle = await perm.handle.getFileHandle(finalName);
      const file = await handle.getFile();
      const buf = new Uint8Array(await file.arrayBuffer());
      let bin = "";
      const step = 0x8000;
      for (let i = 0; i < buf.length; i += step) bin += String.fromCharCode.apply(null, buf.subarray(i, i + step));
      return { ok: true, file: handle.name, folder: perm.handle.name || "", base64: btoa(bin), size: buf.length };
    } catch (err) {
      return { ok: false, reason: classify(err), error: String(err && err.message ? err.message : err) };
    }
  }

  async function forgetFolder() {
    sessionFolder = null;
    await idbSet(DIR_KEY, null).catch(() => null);
    try { await chrome.storage.local.remove(["st_note_dir", "st_note_files"]); } catch { /* ignore */ }
    return true;
  }

  ST.noteStore = {
    DEFAULT_FILE,
    getFolder,
    permissionState,
    ensurePermission,
    ensureFolderInteractively,
    listFiles,
    createFile,
    appendLines,
    readText,
    readBytes,
    forgetFolder,
    supportsPicker: () => typeof window.showDirectoryPicker === "function",
  };
})();