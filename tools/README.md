# 开发与验收工具

## 常用命令

```powershell
npm test
npm run build
npm run playtest
```

## 打包发布

```powershell
powershell -ExecutionPolicy Bypass -File tools/package-release.ps1
```

输出位于 `release/local-bilingual-subtitles-v<version>.zip`，并生成 SHA256 校验文件。

## 真实页面验收

```powershell
node tools/acceptance-local.mjs
node tools/acceptance-youtube.mjs
node tools/acceptance-10.mjs youtube
node tools/acceptance-10.mjs bilibili
node tools/acceptance-10.mjs douyin
```

`acceptance-10.mjs` 读取 `.playtest/video-lists.json`。该文件属于本地测试数据，不随仓库发布。

## 环境变量

| 变量 | 用途 |
| --- | --- |
| `ST_CHROME` | Chrome 可执行文件路径 |
| `ST_EXT_PATH` | 未打包扩展目录，默认指向 `extension` |
| `ST_PROFILE` | Playwright / Chrome 测试 profile 名称 |
| `ST_CDP_PORT` | Chrome DevTools Protocol 端口 |
| `ST_MODEL_TIMEOUT` | 本地模型加载与翻译超时时间（毫秒） |

## 原生笔记宿主

仅 Windows 可用，且只影响“保存笔记”功能：

```powershell
node tools/host/install.mjs
```

宿主安装脚本会向 Chrome / Edge 注册 native messaging host。只做字幕翻译时无需安装。