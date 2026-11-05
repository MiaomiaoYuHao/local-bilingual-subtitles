// 安装 / 更新「本地双语字幕」原生宿主程序（Windows）
//   node tools/host/install.mjs
// 做三件事：复制宿主脚本、写 native messaging 清单、注册到 Chrome/Edge 注册表。
import { spawn } from "node:child_process";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export const HOST_NAME = "com.subsnote.host";
export const NOTE_FILE = "双语字幕笔记.docx";

const HERE = import.meta.dirname;
const ROOT = path.resolve(HERE, "..", "..");
const EXT_DIR = path.join(ROOT, "extension");
const PROFILE = process.env.ST_BROWSER_PROFILE || path.join(os.homedir(), ".st-ext-browser-profile");
const LOCAL = process.env.LOCALAPPDATA || path.join(os.homedir(), "AppData", "Local");
const TARGET_DIR = path.join(LOCAL, "SubsNoteHost");
const MANIFEST_PATH = path.join(TARGET_DIR, HOST_NAME + ".json");
const FALLBACK_IDS = ["gdccmchgjmokpnpiapfbjigffmpeghkb"];

/** 从浏览器 profile 里找出现在这个扩展的 ID（未打包扩展的 ID 由路径决定） */
function detectExtensionIds() {
  const ids = new Set();
  const want = path.resolve(EXT_DIR).toLowerCase();
  const candidates = [];
  for (const rel of ["Preferences", "Default/Preferences", "Profile 1/Preferences"]) {
    candidates.push(path.join(PROFILE, rel));
  }
  for (const file of candidates) {
    let prefs;
    try { prefs = JSON.parse(fs.readFileSync(file, "utf8")); } catch { continue; }
    const settings = (prefs && prefs.extensions && prefs.extensions.settings) || {};
    for (const [id, val] of Object.entries(settings)) {
      const p = String((val && val.path) || "");
      if (!p) continue;
      if (path.resolve(p).toLowerCase() === want) ids.add(id);
    }
  }
  return [...ids];
}

/** 找一下用户的笔记现在放在哪 */
function findNoteDir() {
  const roots = [
    ROOT,
    path.join(os.homedir(), "Desktop"),
    path.join(os.homedir(), "Documents"),
    path.join(os.homedir(), "Downloads"),
    path.join(os.homedir(), "OneDrive"),
  ].filter((p) => { try { return fs.statSync(p).isDirectory(); } catch { return false; } });

  const walk = (dir, depth) => {
    let entries = [];
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return null; }
    for (const e of entries) {
      if (e.isFile() && e.name === NOTE_FILE) return dir;
    }
    if (depth <= 0) return null;
    for (const e of entries) {
      if (!e.isDirectory()) continue;
      const name = e.name;
      if (/^(node_modules|\.git|\.playtest|\.st-ext|AppData|\$RECYCLE\.BIN)$/i.test(name)) continue;
      const hit = walk(path.join(dir, name), depth - 1);
      if (hit) return hit;
    }
    return null;
  };

  for (const r of roots) {
    const hit = walk(r, 3);
    if (hit) return hit;
  }
  return path.join(ROOT, "笔记");
}

export function callHost(msg, timeoutMs = 20000, hostCmd = path.join(TARGET_DIR, "host.cmd")) {
  return new Promise((resolve) => {
    let child;
    try { child = spawn(hostCmd, [], { windowsHide: true, shell: true }); }
    catch (err) { resolve({ ok: false, error: String(err && err.message) }); return; }
    const chunks = [];
    child.stdout.on("data", (d) => chunks.push(d));
    const timer = setTimeout(() => { try { child.kill(); } catch {} resolve({ ok: false, error: "宿主程序无响应" }); }, timeoutMs);
    child.on("error", (err) => { clearTimeout(timer); resolve({ ok: false, error: String(err && err.message) }); });
    child.on("close", () => {
      clearTimeout(timer);
      const buf = Buffer.concat(chunks);
      if (buf.length < 4) { resolve({ ok: false, error: "宿主程序没有返回数据" }); return; }
      const len = buf.readInt32LE(0);
      try { resolve(JSON.parse(buf.subarray(4, 4 + len).toString("utf8"))); }
      catch (err) { resolve({ ok: false, error: "返回数据无法解析：" + String(err && err.message) }); }
    });
    const body = Buffer.from(JSON.stringify(msg), "utf8");
    const head = Buffer.alloc(4);
    head.writeInt32LE(body.length, 0);
    child.stdin.write(Buffer.concat([head, body]));
    child.stdin.end();
  });
}

export async function ensureHost({ quiet = false } = {}) {
  const log = (...a) => { if (!quiet) console.log("[宿主]", ...a); };
  fs.mkdirSync(TARGET_DIR, { recursive: true });
  for (const f of ["host.ps1", "host.cmd"]) {
    fs.copyFileSync(path.join(HERE, f), path.join(TARGET_DIR, f));
  }

  const defaultDir = findNoteDir();
  const searchRoots = [ROOT, path.join(os.homedir(), "Desktop"), path.join(os.homedir(), "Documents"), path.join(os.homedir(), "Downloads")]
    .filter((p) => { try { return fs.statSync(p).isDirectory(); } catch { return false; } });
  fs.writeFileSync(path.join(TARGET_DIR, "host-config.json"),
    JSON.stringify({ defaultDir, searchRoots }, null, 2), "utf8");

  const ids = [...new Set([...detectExtensionIds(), ...FALLBACK_IDS])];
  const manifest = {
    name: HOST_NAME,
    description: "本地双语字幕 —— 直接读写本机笔记文件",
    path: path.join(TARGET_DIR, "host.cmd"),
    type: "stdio",
    allowed_origins: ids.map((id) => "chrome-extension://" + id + "/*"),
  };
  fs.writeFileSync(MANIFEST_PATH, JSON.stringify(manifest, null, 2), "utf8");

  let registered = 0;
  for (const hive of ["HKCU\\Software\\Google\\Chrome\\NativeMessagingHosts", "HKCU\\Software\\Microsoft\\Edge\\NativeMessagingHosts"]) {
    try {
      execFileSync("reg", ["add", hive + "\\" + HOST_NAME, "/ve", "/t", "REG_SZ", "/d", MANIFEST_PATH, "/f"], { stdio: "ignore" });
      registered++;
    } catch (err) { log("注册表写入失败：", String(err && err.message)); }
  }

  const ping = await callHost({ action: "ping" });
  const info = { ok: !!ping.ok, dir: TARGET_DIR, manifest: MANIFEST_PATH, ids, defaultDir, registered, ping };
  if (ping.ok) log("已就绪 ✔  笔记文件夹：" + (ping.defaultDir || defaultDir));
  else log("宿主自检失败：", ping.error);
  return info;
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(import.meta.filename)) {
  const info = await ensureHost();
  console.log(JSON.stringify(info, null, 2));
  process.exit(info.ok ? 0 : 1);
}
