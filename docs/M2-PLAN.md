# M2 计划：三源字幕 + 多平台

## 总原则（用户明确要求）

1. **先判断这条视频是不是英语**（字幕轨语言 / 画面英文字幕 / 音频语言，任一证据即可）
2. 再**盘点手上有什么资源**（英文字幕轨 / 画面字幕 / 能否取帧 / 能否取音 / 能否抓 mp4）
3. 然后按 **官方软字幕 → 硬字幕 OCR → 语音 ASR** 排方法；英语视频即使没有英文字幕轨，也必须能靠 OCR/ASR 跑通
4. 非英语视频不翻译（不硬翻中文）

实现：`extension/src/core/plan.js` → `ST.detectVideoLanguage` / `ST.inventoryResources` / `ST.planSources`（已有单测）

## 目标

- 平台：YouTube、B 站、抖音（通用 <track> 继续保留）
- 来源顺序（自适应）：① 官方软字幕 ② 硬字幕 OCR ③ 视频声音 ASR
- 只翻译英语；非英语只显示原文
- 每个来源都有「在线 / 离线」两种实现，按可用性与速度自动选
- 用户不配置任何 key

## 已落地（1.1.0）

| 项 | 状态 |
| --- | --- |
| 抖音适配器 `src/adapters/douyin.js` | 已注册：先读播放器渲染的字幕，再找页面数据里的官方字幕地址；都没有就明确报"需要 OCR / ASR" |
| 来源管线 `src/core/sources.js` | `ST.sourcePlanFor(location)` → 平台 + 软字幕/OCR/ASR 顺序与标签 |
| 抖音实时字幕读取 `ST.readDouyinDomCaption` | 已接入 `LIVE_READERS` |
| B 站 | 沿用现有软字幕适配器（下一步接进来源标签与 OCR 兜底） |

## 下一步（按顺序）

1. **来源标签与降级**：路由结果带 `source: soft|ocr|asr`，UI 只显示"来源：官方字幕/画面字幕/语音"；失败自动降一级。
2. **取视频文件**（OCR / ASR 的前提）：页面拿不到像素/音频（跨域会污染画布），改由 SW 用 host 权限抓 `video.src` → 交给离屏文档解码。
3. **OCR（离线）**：离屏 `HTMLVideoElement(blob)` → 每秒抽帧 → 本地 OCR（tesseract.js 内核 + eng 语言包，需 vendor 进扩展）→ 只在底部字幕区域识别，过滤非英文。
4. **ASR（离线）**：离屏 `AudioContext.decodeAudioData` → 16k 单声道 → transformers.js Whisper（tiny.en，首次下载后离线）→ 带时间戳的片段。
5. **在线模式**：翻译已有谷歌免费接口（免 key）；OCR/ASR 的"在线"需要用户自填 key 才可靠（无免 key 的公共 OCR/ASR），UI 里明确标注"在线需 key，离线开箱可用"。

## 技术约束（必须记住）

- 跨域视频不能直接 `drawImage`/`captureStream`（画布污染/静音），必须"后台抓文件 → 离屏解码"。
- tesseract.js 的 core + traineddata 要随扩展打包（离线）。
- Whisper 模型首次下载（几十 MB）后缓存，避免重复下载。
- 笔记写入规则不变：以磁盘文件为准、同段不重复、组间一个空行。

## 抖音 OPFS 实现步骤（下一次开工照这个做）

1. SW 新增 `st:douyin-fetch`：对 `video.currentSrc` 发 Range 请求（每片 4MB），把分片写入 OPFS：
   `navigator.storage.getDirectory()` → `douyin/<hash>.mp4`，用 `createSyncAccessHandle`（Worker）或 `createWritable` 顺序写
2. 全部下载完 → 离屏 `getFile()` 拿 File → `URL.createObjectURL` → video 解码（同源，不污染画布）
3. 抽帧：每 2 秒 seek 一次 → 底部 30% → 二值化 → tesseract OCR（复用 `ocr-engine.js`）
4. 结果过质量闸门 + 与 ASR/官方字幕交叉验证（≥0.45）
5. 失败退回：直接 `fetch` 全量（小于 60MB 时）

## ASR 权重来源（备选）

- 后台续传：分片 Range 下载 ONNX 到 OPFS，跨会话累积，完成后 `env.localModelPath` 指向本地
- 手动放置：用户把 `encoder_model_quantized.onnx` + `decoder_model_merged_quantized.onnx` 放进 `extension/vendor/asr/whisper-tiny.en/onnx/`
- 换镜像/换更小模型（需先验证可下载）
