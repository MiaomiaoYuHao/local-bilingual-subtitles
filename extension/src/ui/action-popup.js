// 弹窗：翻译方式 / 保存笔记（先选文件夹 → 指定文件名 → 新建或切换）/ 字幕显示
const MSG = {
  MODEL_STATUS: "st:model-status",
  PRELOAD_MODEL: "st:preload-model",
  NOTE_NEW: "st:note-new",
  NOTE_READ: "st:note-read",
  NOTE_LIST: "st:note-list",
  NOTE_OPEN: "st:note-open",
  HOST_STATUS: "st:host-status",
  HOST_PICK: "st:host-pick-dir",
  HOST_SET_DIR: "st:host-set-dir",
  HOST_REVEAL: "st:host-reveal",
  PAGE_STATE: "st:page-state",
};

const DEFAULT_NOTE_FILE = "双语字幕笔记.docx";
const DB_NAME = "st-notes";
const STORE = "handles";
const DIR_KEY = "note-dir";
const FILE_TARGET_KEY = "note-file-target";

const $ = (id) => document.getElementById(id);

function sendOnce(type, payload) {
  return new Promise((resolve) => {
    try {
      chrome.runtime.sendMessage({ type, payload }, (res) => {
        const err = chrome.runtime.lastError ? chrome.runtime.lastError.message : null;
        resolve({ res: res || null, err });
      });
    } catch (err) {
      resolve({ res: null, err: String(err && err.message ? err.message : err) });
    }
  });
}

/** 后台 service worker 偶发被回收：自动重试 */
async function send(type, payload, attempts) {
  const max = attempts || 4;
  for (let i = 0; i < max; i++) {
    const { res, err } = await sendOnce(type, payload);
    if (res) return res;
    if (!err || !/Receiving end|establish connection|message port closed/i.test(err)) return res || null;
    await new Promise((r) => setTimeout(r, 400 * (i + 1)));
  }
  return null;
}

let toastTimer = null;
function toast(text, kind) {
  $("toast").textContent = text || "";
  $("toast").className = "toast" + (kind ? " " + kind : "");
  if (toastTimer) clearTimeout(toastTimer);
  if (text) toastTimer = setTimeout(() => { $("toast").textContent = ""; }, 3600);
}

function openDb() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE)) db.createObjectStore(STORE);
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function setHandle(key, handle) {
  const db = await openDb();
  await new Promise((resolve, reject) => {
    const t = db.transaction(STORE, "readwrite");
    if (handle) t.objectStore(STORE).put(handle, key);
    else t.objectStore(STORE).delete(key);
    t.oncomplete = () => resolve(true);
    t.onerror = () => reject(t.error);
  });
}

function renderFolder(value) {
  const el = $("folder-path");
  if (!el) return;
  el.value = value || "";
}

function currentName() {
  return ($("notename").value || "").trim() || DEFAULT_NOTE_FILE;
}

function safeName(name) {
  const n = String(name || "").trim();
  if (!n) return null;
  if (/[\\/:*?"<>|]/.test(n)) return null;
  return n;
}

/** 用文件夹里已有的笔记填充下拉建议 */
async function effectiveFiles() {
  const res = await send(MSG.NOTE_LIST, {});
  let files = (res && res.ok && res.data && res.data.files) || [];
  if (!files.length) {
    const stored = await chrome.storage.local.get(["st_note_files"]);
    if (Array.isArray(stored.st_note_files)) files = stored.st_note_files;
  }
  return files;
}

async function refreshFileList() {
  const files = await effectiveFiles();
  const list = $("notefiles");
  list.innerHTML = "";
  for (const name of files) {
    const opt = document.createElement("option");
    opt.value = name;
    list.appendChild(opt);
  }
}

function renderState(status) {
  const dot = $("dot");
  const text = $("state-text");
  const state = status ? status.state : "unknown";
  dot.className = "dot";
  if (state === "ready") text.textContent = status.engine === "groq" ? "在线翻译已就绪" : "离线翻译已就绪";
  else if (state === "error") { dot.classList.add("err"); text.textContent = "需要处理"; }
  else if (state === "idle") { dot.classList.add("wait"); text.textContent = "待命中"; }
  else { dot.classList.add("wait"); text.textContent = "正在准备…"; }
  if (status && status.engine) {
    $("mode-online").classList.toggle("on", status.engine === "groq");
    $("mode-offline").classList.toggle("on", status.engine !== "groq");
  }
}

async function refresh() {
  const res = await send(MSG.MODEL_STATUS, {});
  renderState(res && res.ok ? res.data : null);
}

$("mode-online").addEventListener("click", async () => {
  $("mode-online").classList.add("on");
  $("mode-offline").classList.remove("on");
  await chrome.storage.local.set({ st_engine: "groq", st_cloud_provider: "google", st_cloud_preset: "google", st_cloud_model: "google-translate", st_cloud_baseurl: "" });
  toast("已切换为在线翻译");
  await send(MSG.PRELOAD_MODEL, {});
  setTimeout(refresh, 400);
});

$("mode-offline").addEventListener("click", async () => {
  $("mode-offline").classList.add("on");
  $("mode-online").classList.remove("on");
  await chrome.storage.local.set({ st_engine: "mt", st_cloud_provider: "google" });
  toast("已切换为离线翻译（首次会下载约 113MB）");
  await send(MSG.PRELOAD_MODEL, {});
  setTimeout(refresh, 400);
});

$("pick-folder").addEventListener("click", async () => {
  // 有本地助手：直接用系统文件夹窗口，选完就能用，不用再确认权限
  const hostStatus = await send(MSG.HOST_STATUS, {});
  if (hostStatus && hostStatus.ok && hostStatus.data && hostStatus.data.available) {
    toast("请在系统窗口里选择文件夹…");
    const picked = await send(MSG.HOST_PICK, {}, 1);
    if (!picked || !picked.ok) { toast((picked && picked.error) || "选择失败", "err"); return; }
    if (!picked.data || picked.data.picked === false) { toast("已取消选择"); return; }
    $("folder-path").value = picked.data.dir;
    const files = await effectiveFiles();
    const saved = ($("notename").value || "").trim();
    if (!saved || (files.length && files.indexOf(saved) < 0)) $("notename").value = files[0] || saved || DEFAULT_NOTE_FILE;
    await chrome.storage.local.set({ st_note_filename: $("notename").value });
    await refreshFileList();
    toast("保存位置：" + picked.data.dir + (files.length ? "（发现 " + files.length + " 个笔记）" : "（填好名字点「新建」）"));
    return;
  }
  try {
    if (typeof window.showDirectoryPicker !== "function") { toast("当前浏览器不支持选择文件夹", "err"); return; }
    const dir = await window.showDirectoryPicker({ id: "st-note-dir", mode: "readwrite", startIn: "documents" });
    if (dir.queryPermission) {
      const state = await dir.queryPermission({ mode: "readwrite" });
      if (state !== "granted" && dir.requestPermission) {
        const asked = await dir.requestPermission({ mode: "readwrite" });
        if (asked !== "granted") { toast("没有获得写入权限", "err"); return; }
      }
    }
    await setHandle(DIR_KEY, dir);
    await setHandle(FILE_TARGET_KEY, null);           // 只用"文件夹 + 文件名"这一种模式
    await chrome.storage.local.set({ st_note_dir: dir.name || "已选择文件夹", st_note_target: "dir" });
    renderFolder(dir.name || "已选择文件夹");
    await refreshFileList();
    const res = await send(MSG.NOTE_LIST, {});
    const files = (res && res.data && res.data.files) || [];
    const saved = ($("notename").value || "").trim();
    const finalName = saved || files[0] || DEFAULT_NOTE_FILE;
    $("notename").value = finalName;
    await chrome.storage.local.set({ st_note_filename: finalName });   // 立刻落库
    toast("已选择文件夹：" + (dir.name || "") + (files.length ? `（发现 ${files.length} 个笔记）` : "（还没有笔记，填名字点「新建」）"));
  } catch (err) {
    const msg = err && err.message ? err.message : String(err);
    if (!/abort/i.test(msg)) toast("选择失败：" + msg.slice(0, 30), "err");
  }
});

// 边打字边保存，避免"框里有但后台还没记住"
let nameTimer = null;
$("notename").addEventListener("input", () => {
  if (nameTimer) clearTimeout(nameTimer);
  nameTimer = setTimeout(async () => {
    const name = safeName($("notename").value);
    if (name) await chrome.storage.local.set({ st_note_filename: name });
  }, 300);
});

$("notename").addEventListener("change", async () => {
  const name = safeName($("notename").value);
  if (!name) { toast("文件名不能为空，也不能包含 \\ / : * ? \" < > |", "err"); return; }
  $("notename").value = name;
  await chrome.storage.local.set({ st_note_filename: name });
});

/** 渲染"当前文件夹下的笔记"列表 */
function renderNoteList(files, folderChosen) {
  const box = $("notelist");
  box.innerHTML = "";
  box.classList.remove("hidden");      // 列表要真的显示出来

  if (!folderChosen) {
    box.classList.remove("hidden");
    const div = document.createElement("div");
    div.className = "empty";
    div.textContent = "请先「选择文件夹」";
    box.appendChild(div);
    return;
  }
  if (!files.length) {
    box.classList.remove("hidden");
    const div = document.createElement("div");
    div.className = "empty";
    div.textContent = "这个文件夹里还没有笔记，填好名字点「新建」即可";
    box.appendChild(div);
    return;
  }
  const current = ($("notename").value || "").trim();
  for (const name of files) {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.textContent = name;
    if (name === current) btn.classList.add("on");
    btn.addEventListener("click", async () => {
      $("notename").value = name;
      await chrome.storage.local.set({ st_note_filename: name });
      renderNoteList(files, true);
      toast("已选择笔记：" + name);
    });
    box.appendChild(btn);
  }
}

$("pick-note").addEventListener("click", async () => {
  const box = $("notelist");
  if (!box.classList.contains("hidden")) { box.classList.add("hidden"); return; }
  const files = await effectiveFiles();
  const stored = await chrome.storage.local.get(["st_note_dir"]);
  const hasFolder = !!(stored.st_note_dir) || files.length > 0;
  renderNoteList(files, hasFolder);
});

$("new-note").addEventListener("click", async () => {
  const name = safeName(currentName());
  if (!name) { toast("文件名不能为空，也不能包含 \\ / : * ? \" < > |", "err"); return; }
  $("notename").value = name;
  const res = await send(MSG.NOTE_NEW, { fileName: name });
  if (res && res.ok && res.data && res.data.file) {
    const existed = res.data.created === false;
    await chrome.storage.local.set({ st_note_filename: res.data.file });
    await refreshFileList();
    toast(existed ? "这个文件已存在，已用它：" + res.data.file : "已新建笔记：" + res.data.file);
    $("notelist").classList.add("hidden");
  } else if (res && res.ok && res.data && res.data.ok === false && res.data.reason === "no-folder") {
    await chrome.storage.local.set({ st_note_filename: name });
    toast("已选定文件名：" + name + "（首次按 S 时创建；也可在页面上按 V 选择文件夹）", "err");
  } else {
    await chrome.storage.local.set({ st_note_filename: name });
    toast("已选定文件名：" + name + "（在视频页面上按 V 选择文件夹即可生效）", "err");
  }
});

$("view-note").addEventListener("click", async () => {
  const name = currentName();
  toast("正在打开：" + name + "…");
  const res = await send(MSG.NOTE_OPEN, { fileName: name });
  if (res && res.ok && res.data && res.data.direct) { toast("已用 Word 打开：" + (res.data.file || name)); return; }
  if (!res || !res.ok || !res.data || !Number.isFinite(res.data.downloadId)) {
    toast((res && res.error) || "打开失败：读不到笔记文件", "err");
    return;
  }
  const id = res.data.downloadId;
  // 关键：由弹窗（有你的点击手势）调用 open，Chrome 才允许直接拉起 Word
  for (let i = 0; i < 6; i++) {
    try {
      await chrome.downloads.open(id);
      toast("已用 Word 打开：" + res.data.file);
      return;
    } catch (err) {
      const msg = String(err && err.message ? err.message : err);
      console.warn("[双语字幕] downloads.open 失败:", msg, "尝试次数", i + 1);
      if (/gesture/i.test(msg)) break;                    // 手势已过期，别再重试
      await new Promise((r) => setTimeout(r, 350));       // 可能还在下载中，稍等再试
    }
  }
  try { await chrome.downloads.show(id); toast("已保存到下载文件夹：" + res.data.file + "（双击即可打开）"); return; } catch { /* ignore */ }
  toast("已保存到下载文件夹：" + res.data.file + "，请在那里双击打开", "err");
});

$("savekey").addEventListener("change", async () => {
  await chrome.storage.local.set({ st_save_key: $("savekey").value });
  toast($("savekey").value === "none" ? "已关闭保存快捷键" : "保存快捷键：" + $("savekey").value.toUpperCase());
});

$("hotkey").addEventListener("change", async () => {
  await chrome.storage.local.set({ st_hotkey: $("hotkey").value });
  toast($("hotkey").value === "none" ? "已关闭显示快捷键" : "显示快捷键：" + $("hotkey").value.toUpperCase());
});

$("fabvis").addEventListener("change", async () => {
  await chrome.storage.local.set({ st_button_visible: $("fabvis").checked });
  toast($("fabvis").checked ? "已显示页面悬浮按钮" : "已隐藏页面悬浮按钮");
});

/** 打开弹窗时确认文件夹权限：浏览器重启后可能需要重新授权一次 */
async function checkFolderPermission() {
  const hostStatus = await send(MSG.HOST_STATUS, {});
  if (hostStatus && hostStatus.ok && hostStatus.data && hostStatus.data.available) { $("confirm-folder").style.display = "none"; return; }
  const db = await openDb();
  const handle = await new Promise((resolve) => {
    const t = db.transaction(STORE, "readonly");
    const req = t.objectStore(STORE).get(DIR_KEY);
    req.onsuccess = () => resolve(req.result || null);
    req.onerror = () => resolve(null);
  });
  if (!handle) { $("confirm-folder").style.display = "none"; return; }
  const perm = handle.queryPermission ? await handle.queryPermission({ mode: "readwrite" }) : "granted";
  if (perm === "granted") { $("confirm-folder").style.display = "none"; return; }
  toast("保存位置需要重新确认：按 V 或回车", "err");
  $("confirm-folder").style.display = "";
}

// 需要重新授权时：按 V 或回车即可（不用鼠标点）
// 用 V 而不是 C：C 在 YouTube 上是开关字幕
document.addEventListener("keydown", (event) => {
  const btn = $("confirm-folder");
  const needs = btn && btn.style.display !== "none";
  const key = String(event.key || "").toLowerCase();
  if (needs && (key === "v" || event.key === "Enter" || key === " ")) {
    event.preventDefault();
    btn.click();
  }
});

$("confirm-folder").addEventListener("click", async () => {
  const db = await openDb();
  const handle = await new Promise((resolve) => {
    const t = db.transaction(STORE, "readonly");
    const req = t.objectStore(STORE).get(DIR_KEY);
    req.onsuccess = () => resolve(req.result || null);
    req.onerror = () => resolve(null);
  });
  if (!handle) { toast("请点「选择文件夹」", "err"); return; }
  const perm = handle.requestPermission ? await handle.requestPermission({ mode: "readwrite" }) : "granted";
  if (perm === "granted") { renderFolder(handle.name || "已选择文件夹"); $("confirm-folder").style.display = "none"; toast("文件夹权限已确认，可以正常按 S 保存了"); }
  else toast("没有获得权限，请重新「选择文件夹」", "err");
});

async function loadSettings() {
  const res = await chrome.storage.local.get([
    "st_engine", "st_note_dir", "st_note_dir_abs", "st_note_filename", "st_save_key", "st_hotkey", "st_button_visible",
  ]);
  const online = res.st_engine !== "mt";
  $("mode-online").classList.toggle("on", online);
  $("mode-offline").classList.toggle("on", !online);
  $("savekey").value = res.st_save_key === undefined ? "s" : String(res.st_save_key);
  $("hotkey").value = res.st_hotkey === undefined ? "z" : String(res.st_hotkey);
  $("fabvis").checked = res.st_button_visible !== false;
  renderFolder(res.st_note_dir_abs || res.st_note_dir || "");
  $("notename").value = res.st_note_filename || DEFAULT_NOTE_FILE;
  await refreshFileList();
  await checkFolderPermission();
}

async function refreshHost() {
  const res = await send(MSG.HOST_STATUS, {});
  const data = res && res.ok ? res.data : null;
  if (!data || !data.available) { $("open-folder").style.display = "none"; return; }
  if (data.dir) $("folder-path").value = data.dir;
  $("open-folder").style.display = "";
}

$("open-folder").addEventListener("click", async () => {
  const res = await send(MSG.HOST_REVEAL, { dir: ($("folder-path").value || "").trim() });
  if (res && res.ok) { toast("已在资源管理器里打开"); return; }
  toast((res && res.error) || "打开文件夹失败", "err");
});

let pathTimer = null;
$("folder-path").addEventListener("input", () => {
  if (pathTimer) clearTimeout(pathTimer);
  pathTimer = setTimeout(async () => {
    const dir = ($("folder-path").value || "").trim();
    if (!dir) return;
    const res = await send(MSG.HOST_SET_DIR, { dir }, 1);
    if (res && res.ok) { await refreshFileList(); }
  }, 600);
});

$("folder-path").addEventListener("change", async () => {
  const dir = ($("folder-path").value || "").trim();
  if (!dir) return;
  const res = await send(MSG.HOST_SET_DIR, { dir }, 1);
  if (res && res.ok) { $("folder-path").value = res.data.dir; await refreshFileList(); toast("保存位置：" + res.data.dir); return; }
  toast((res && res.error) || "路径不可用", "err");
});

loadSettings().then(refreshHost);
refresh();
setInterval(refresh, 2000);
