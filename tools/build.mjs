// Vendors the runtime dependencies into extension/vendor, validates the manifest and
// every referenced file, and writes a build report used as playtest evidence.
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";

const root = path.resolve(import.meta.dirname, "..");
const ext = path.join(root, "extension");
const dist = path.join(root, "node_modules", "@huggingface", "transformers", "dist");
const vendor = path.join(ext, "vendor", "transformers");

const VENDOR_FILES = [
  "transformers.min.js",
  "ort-wasm-simd-threaded.jsep.wasm",
  "ort-wasm-simd-threaded.jsep.mjs",
];

function sha256(file) {
  return crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex");
}
function mb(bytes) {
  return `${(bytes / 1048576).toFixed(2)} MB`;
}

function rmrf(target) {
  if (fs.existsSync(target)) fs.rmSync(target, { recursive: true, force: true });
}

console.log("== 1. vendor transformers.js runtime ==");
rmrf(vendor);
fs.mkdirSync(vendor, { recursive: true });
const vendored = [];
for (const name of VENDOR_FILES) {
  const src = path.join(dist, name);
  if (!fs.existsSync(src)) throw new Error(`缺少依赖文件：${src}（先执行 npm install）`);
  const dst = path.join(vendor, name);
  fs.copyFileSync(src, dst);
  const size = fs.statSync(dst).size;
  vendored.push({ name, bytes: size, sha256: sha256(dst) });
  console.log(`  ${name.padEnd(36)} ${mb(size).padStart(10)}  ${sha256(dst).slice(0, 12)}`);
}

console.log("\n== 2. validate manifest ==");
const manifestPath = path.join(ext, "manifest.json");
const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
const missing = [];
const check = (rel, what) => {
  const p = path.join(ext, rel);
  if (!fs.existsSync(p)) missing.push(`${what}: ${rel}`);
};
check(manifest.background.service_worker, "service_worker");
for (const cs of manifest.content_scripts || []) for (const f of cs.js || []) check(f, "content_script");
check(manifest.action.default_popup, "action popup");
for (const size of Object.keys(manifest.icons || {})) check(manifest.icons[size], `icon${size}`);
for (const f of VENDOR_FILES) check(path.join("vendor", "transformers", f), "vendor");
// files referenced from code
const extraRefs = [
  "src/background/offscreen.html",
  "src/background/offscreen.js",
  "src/background/model-manager.js",
  "src/background/translate-store.js",
  "src/background/track-fetchers.js",
  "src/shared/protocol.js",
  "src/parsers/json3.js",
  "src/parsers/vtt.js",
  "src/parsers/bilibili.js",
  "src/parsers/common.js",
];
for (const f of extraRefs) check(f, "module");
if (missing.length) {
  console.error("manifest 校验失败：\n" + missing.map((m) => "  - " + m).join("\n"));
  process.exit(1);
}
const csp = manifest.content_security_policy?.extension_pages || "";
console.log(`  manifest v${manifest.manifest_version}, name="${manifest.name}", version=${manifest.version}`);
console.log(`  permissions: ${(manifest.permissions || []).join(", ")}`);
console.log(`  host_permissions: ${(manifest.host_permissions || []).join(", ")}`);
console.log(`  csp: ${csp}`);

console.log("\n== 3. syntax check every extension script ==");
const scripts = [];
(function walk(dir) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(p);
    else if (/\.(js|mjs)$/.test(entry.name)) scripts.push(p);
  }
})(ext);
for (const f of scripts) {
  const stat = await (await import("node:child_process")).spawnSync(process.execPath, ["--check", f], { encoding: "utf8" });
  if (stat.status !== 0) {
    console.error(`语法错误: ${path.relative(root, f)}\n${stat.stderr}`);
    process.exit(1);
  }
}
console.log(`  ${scripts.length} 个脚本语法检查通过`);

const totalBytes = vendored.reduce((a, v) => a + v.bytes, 0);
const report = {
  builtAt: new Date().toISOString(),
  manifest: { name: manifest.name, version: manifest.version, manifest_version: manifest.manifest_version, csp },
  vendored,
  vendorTotalBytes: totalBytes,
  scriptsChecked: scripts.length,
  model: {
    id: "onnx-community/Qwen2.5-0.5B-Instruct",
    files: {
      "onnx/model_q4f16.onnx": 483003582,
      "onnx/model_uint8.onnx": 512096636,
    },
  },
};
fs.writeFileSync(path.join(root, "build-report.json"), JSON.stringify(report, null, 2));
console.log(`\n== done ==\nvendor 总计 ${mb(totalBytes)}；报告写入 build-report.json`);