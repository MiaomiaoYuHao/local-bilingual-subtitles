# 本地双语字幕

在浏览器中为英文视频提供实时英中双语字幕。支持 **YouTube / B 站 / 抖音**，可从软字幕、硬字幕 OCR 或无字幕语音 ASR 中获取英文，再用本地 Opus-MT 翻译为简体中文。

> 当前版本：**1.5.38**（Service Worker `sw-b103`）
> 单元测试：**57/57 通过**
> 目标浏览器：**Chrome / Edge 120+**（Manifest V3）

[![CI](https://github.com/MiaomiaoYuHao/local-bilingual-subtitles/actions/workflows/ci.yml/badge.svg)](https://github.com/MiaomiaoYuHao/local-bilingual-subtitles/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)

## 功能

- **三种字幕来源**：网页软字幕、画面硬字幕 OCR、视频语音 ASR
- **双语叠层**：播放器上显示最近三条英文字幕及中文译文
- **本地翻译**：内置量化版 Opus-MT 英中翻译模型，无需 API Key
- **本地识别**：Whisper Tiny 英文 ASR + Tesseract OCR
- **WebGPU / WASM**：优先使用 WebGPU，失败时自动回退 WASM
- **可选在线翻译**：支持免 Key 的 Google 翻译接口，以及 OpenAI 兼容接口 / Groq
- **可选笔记助手**：通过 Windows 原生宿主把当前字幕保存到 Word 文档

## 隐私说明

**默认翻译模式是本地 Opus-MT。** 软字幕解析、OCR、ASR 和默认翻译均在本机完成，不需要把字幕发送到自建服务器。

如果手动切换到“在线翻译”，字幕文本会发送到所选服务商：

- Google 翻译模式使用非官方的公开接口，无需 Key，但可能受限流或地区影响
- OpenAI 兼容接口 / Groq 模式需要用户自行提供 API Key
- API Key 仅保存在浏览器本地扩展存储中

扩展声明了较宽的主机权限，以支持在任意视频网页上按需读取字幕轨、媒体信息和画面。项目不包含统计、遥测或广告 SDK。

## 下载即用（普通用户）

不需要安装 Node.js，也不需要构建：

1. 打开 [最新 Release](https://github.com/MiaomiaoYuHao/local-bilingual-subtitles/releases/latest)
2. 下载 `local-bilingual-subtitles-v1.5.38.zip`
3. 解压到一个固定且长期保留的文件夹
4. 打开 `edge://extensions/` 或 `chrome://extensions/`
5. 开启 **开发人员模式**
6. 点击 **加载解压缩的扩展**，选择刚解压的文件夹
7. 回到视频页面刷新一次，按 `Z` 开启双语字幕

> 发布包已经内含翻译、OCR、ASR 模型和运行时。首次可用不需要联网下载模型；解压后的 `INSTALL.txt` 也有安装说明。`r`n`r`n## 开发者从源码加载



1. 安装 Node.js 22+（仅构建和测试需要）
2. 克隆仓库：

   ```powershell
   git clone https://github.com/MiaomiaoYuHao/local-bilingual-subtitles.git
   cd local-bilingual-subtitles
   npm ci
   npm run build
   ```

3. 打开 `edge://extensions/` 或 `chrome://extensions/`
4. 开启 **开发人员模式**
5. 点击 **加载解压缩的扩展**
6. 选择仓库中的 `extension` 目录
7. 回到视频页面刷新一次

模型和运行时已经随 `extension/vendor` 一起提供，国内网络环境下不需要首次下载模型权重。

## 使用

1. 打开支持的英文视频页面
2. 播放视频；若存在 CC / 字幕轨，先在播放器中选择英文字幕
3. 按 `Z`，或点击页面右下角的「中A」
4. 弹窗中可选择翻译方式、字幕显示和笔记保存选项

没有字幕轨时，扩展会按页面能力尝试 OCR 或 ASR。首次使用本地模型可能需要几秒加载时间。

## 工作原理

```text
软字幕 / 视频画面 / 音频
          │
          ├── 字幕轨解析
          ├── Tesseract OCR
          └── Whisper Tiny ASR
                    │
              英文句子合并与质量过滤
                    │
          Opus-MT 本地翻译（默认）
                    │
            三条双语字幕叠层
```

默认本地模式不需要云端 API；在线模式作为可选后备，适合希望使用更大模型或更快响应的场景。

## 开发

```powershell
npm ci
npm test
npm run build
npm run playtest
```

- `npm test`：运行全部单元测试
- `npm run build`：校验 manifest、同步 Transformers.js 运行时并写入构建报告
- `npm run playtest`：使用 Playwright 启动本地字幕页面做端到端测试
- `node tools/acceptance-local.mjs`：本地软字幕全链路验收
- `node tools/acceptance-youtube.mjs`：YouTube 真实视频验收
- `node tools/acceptance-10.mjs youtube|bilibili|douyin`：三平台 10 条视频验收

真实页面验收需要本机安装 Chrome。可以通过 `ST_CHROME`、`ST_EXT_PATH`、`ST_PROFILE`、`ST_CDP_PORT` 等环境变量覆盖默认路径和端口。详见 [tools/README.md](tools/README.md)。

### 目录

```text
extension/            可直接加载的 Manifest V3 扩展
  src/                扩展源码
  vendor/             本地模型与浏览器运行时
tests/                单元测试和端到端测试页面
tools/                构建、验收与可选宿主程序
docs/                 验收记录和历史验证资料
```

## 已知限制

- 慢网、冷启动和部分平台的分段字幕可能带来延迟
- 极低对比度小字、强音乐/噪声仍可能降低 OCR/ASR 质量
- 页面完全不暴露媒体 URL 的 MSE 播放器可能需要额外的分片解析
- 超长音视频会增加 CPU、内存和识别耗时
- macOS / Linux 下的原生笔记宿主尚未提供；只做字幕翻译不需要宿主
- 在线翻译属于可选功能，可用性和配额由第三方服务决定

## 第三方组件

本项目打包了 Transformers.js、ONNX Runtime Web、Opus-MT、Whisper Tiny、Tesseract.js 和英文 tessdata。各组件的来源及许可证见 [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)。

## 参与贡献

欢迎提交 Issue 和 Pull Request。提交前请阅读 [CONTRIBUTING.md](CONTRIBUTING.md)。安全问题请按 [SECURITY.md](SECURITY.md) 私下报告。

## License

[MIT](LICENSE) © 2026 MiaomiaoYuHao