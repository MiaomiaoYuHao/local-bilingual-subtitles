# 平台实测记录（2026-10-18）

## B 站

| 项 | 实测结果 |
| --- | --- |
| 登录状态（本机专用 profile） | **未登录** |
| 官方字幕接口 `/x/player/v2` | 8 个 TED/英语视频全部返回**空字幕列表**（`need_login_subtitle`），即**官方软字幕要登录才给** |
| `video.currentSrc` | `blob:`（MSE 流，不能直接下载） |
| `video.crossOrigin` | `anonymous` |
| 画布取帧 `drawImage + getImageData` | **可用**（能拿到像素，没有被污染） |
| `captureStream()` | **可用**（1 路视频 + 1 路音频） |

结论：B 站不登录没有官方字幕可拿；但**页面内取帧/取音都可行**，OCR / ASR 可以在页面里做，不需要下载视频。

## 抖音

| 项 | 实测结果 |
| --- | --- |
| 官方字幕 | 没有（页面无字幕轨） |
| `video.currentSrc` | `https://lf-douyin-pc-web.douyinstatic.com/.../xxx.mp4`（**直接 mp4 地址**） |
| `video.crossOrigin` | `null` |
| 画布取帧 | **失败**（SecurityError：画布被污染） |
| `captureStream()` | **失败**（Cannot capture） |

结论：抖音页面内既不能取帧也不能取音，但视频是**直链 mp4** → 走"后台抓文件 → 离屏解码"这条路：OCR 抽帧、ASR 解音都可行。抖音视频短，成本可控。

## 因此 M2 的取源策略定为

- B 站：软字幕（需登录）→ 页面内 **OCR**（取帧可用）→ 页面内 **ASR**（captureStream 可用）
- 抖音：无软字幕 → **抓 mp4 → 离屏 OCR/ASR**
- 翻译：在线谷歌（免 key）/ 离线 opus-mt（已有）
- OCR：tesseract.js（core + eng 语言包随扩展打包，离线）
- ASR：transformers.js Whisper tiny.en（首次下载后离线）

## 后台抓 mp4 实测（2026-10-18）

- 从扩展 SW 用 host 权限直接 fetch 抖音播放中的 mp4：**HTTP 200，content-type: video/mp4，12.9 MB→实测一条 129 MB**
- 说明"后台抓文件 → 离屏解码"这条路**可行**（不受页面 CORS/画布污染限制）
- 注意：文件可能很大，OCR 抽帧要按需取（优先用 Range 请求或边下边解），不能整段等下载完
