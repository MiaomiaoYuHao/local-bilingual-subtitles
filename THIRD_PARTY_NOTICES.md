# 第三方组件与许可证

本仓库的 `extension/vendor` 目录包含用于离线字幕识别和翻译的第三方运行时与模型。它们分别受各自上游许可证约束，MIT 许可证仅适用于本项目原创代码。

| 组件 | 上游项目 | 许可证 |
| --- | --- | --- |
| Transformers.js | https://github.com/huggingface/transformers.js | Apache-2.0 |
| ONNX Runtime Web | https://github.com/microsoft/onnxruntime | MIT |
| Opus-MT EN→ZH (`Xenova/opus-mt-en-zh`) | https://huggingface.co/Xenova/opus-mt-en-zh | CC-BY-4.0 |
| Whisper Tiny EN (`Xenova/whisper-tiny.en`) | https://huggingface.co/Xenova/whisper-tiny.en | Apache-2.0 |
| Tesseract.js | https://github.com/naptha/tesseract.js | Apache-2.0 |
| English tessdata (`tessdata_fast`) | https://github.com/tesseract-ocr/tessdata_fast | Apache-2.0 |

## 说明

- 模型文件和运行时按上游发布的量化版本打包，未改变其许可证归属。
- 上游许可证全文可在对应项目仓库中获取。
- 下游分发者应保留本文件和适用的上游许可证信息。
- 如果发现许可证归属或版本信息有误，请提交 Issue 或安全报告，维护者会及时更正。