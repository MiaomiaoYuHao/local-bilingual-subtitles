# 贡献指南

## 开发环境

- Node.js 22+
- Chrome 或 Edge 120+
- Windows 仅在测试原生笔记宿主时需要

```powershell
npm ci
npm test
npm run build
```

## 提交 Pull Request

1. 从 `main` 创建短生命周期分支
2. 保持改动聚焦，并说明用户可见行为的变化
3. 新增功能或修复 bug 时补充测试
4. 提交前确认 `npm test` 和 `npm run build` 通过
5. 不要提交 API Key、个人路径、浏览器 profile 或测试截图
6. 如果修改了第三方模型或运行时，请同步更新 `THIRD_PARTY_NOTICES.md`

提交信息建议使用 Conventional Commits，例如：

```text
fix(asr): shorten duplicate sentence window
feat(overlay): add subtitle opacity setting
docs(readme): clarify online translation privacy
```

## 代码约定

- 使用现有模块结构和原生 ES Modules
- 默认保持本地优先，不在未经用户选择时发送字幕到云端
- 不引入遥测、广告或与字幕功能无关的追踪
- 新增外部依赖时说明来源、许可证和离线可用性