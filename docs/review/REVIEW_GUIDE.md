# 食品安全检验管理系统 Pro — 代码审阅上下文指导文档（索引）

**文档路径**：`docs/review/REVIEW_GUIDE.md`
**系统名称**：食品安全检验管理系统 Pro（珠海一中食品安全检验系统）
**仓库地址**：https://github.com/ArthurUker/Tianjiabing_foodtestlab/tree/ZhuHaiYiZhong
**审阅开始日期**：2026-06-22
**文档版本**：v0.10（2026-06-23 重构为索引文件）
**文档用途**：每次新对话开始时，将本文件提供给 AI，AI 按需读取对应子文件，无需加载全部内容。

> ⚠️ **本文件已于 v0.10 重构为纯索引。** 原完整内容已按章节拆分至以下子文件，请按需读取。

---

## 📂 子文件导航

| 子文件 | 章节内容 | 读取时机 |
|--------|---------|---------|
| [RG_01_SYSTEM.md](./RG_01_SYSTEM.md) | §1 系统背景速查（技术栈、部署口径、目录结构、架构说明） | 每次新对话必读 |
| [RG_02_CDN_WORKFLOW.md](./RG_02_CDN_WORKFLOW.md) | §1.10 GitHub CDN 缓存解决方案 + 工作流规范 | 每次新对话必读 |
| [RG_03a_ISSUES_REVIEWED.md](./RG_03a_ISSUES_REVIEWED.md) | §2 已审阅文件清单 + §3 P0 问题详情 | 需要 P0 问题详情时读取 |
| [RG_03b_ISSUES_P1.md](./RG_03b_ISSUES_P1.md) | §3 P1 重要问题详情 | 需要 P1 问题详情时读取 |
| [RG_03c_ISSUES_P2.md](./RG_03c_ISSUES_P2.md) | §3 P2 优化建议详情 | 需要 P2 问题详情时读取 |
| [RG_03d_ISSUES_P3.md](./RG_03d_ISSUES_P3.md) | §3 P3/DOCS 问题详情 + §4 优先级汇总 | 需要 P3/DOCS 问题详情时读取 |
| [RG_04_PROGRESS.md](./RG_04_PROGRESS.md) | §3 修复执行进度看板（各项状态表、完成率） | 核验进度时读取 |
| [RG_05_CHANGELOG.md](./RG_05_CHANGELOG.md) | §4 文档变更记录 + 附录 | 需要历史记录时读取 |

---

## 🚀 快速状态速查（置顶，每次更新同步维护）

| 字段 | 当前值 |
|------|-------|
| 文档版本 | v0.10 |
| FIX_PLAN 版本 | v1.7 |
| 最后同步时间 | 2026-06-23 15:35 |
| P0 完成率 | 80%（8/10）|
| P1 完成率 | 0%（0/26）|
| P2 完成率 | 0%（0/22）|
| DOCS 完成率 | 0%（0/4）|
| 下一个待处理项 | P0-07（快速访问绕过认证）|
| P0-06 | ✅ 已完成 2026-06-23 |
| P0-07 | ⬜ 待处理 |
| P0-08 | ✅ 已完成 2026-06-23 |
| P0-09 | ⬜ 待处理（依赖 P1-21）|
| P0-10 | ✅ 已完成 2026-06-23 |

---

## 📋 新对话启动检查清单

1. 读取本文件（索引）
2. 读取 [RG_01_SYSTEM.md](./RG_01_SYSTEM.md)（系统背景）
3. 读取 [RG_02_CDN_WORKFLOW.md](./RG_02_CDN_WORKFLOW.md)（CDN 规范 + 工作流）
4. 按任务需要读取 [RG_04_PROGRESS.md](./RG_04_PROGRESS.md)（进度核验）或 [RG_03a_ISSUES_REVIEWED.md](./RG_03a_ISSUES_REVIEWED.md) / [RG_03b_ISSUES_P1.md](./RG_03b_ISSUES_P1.md) / [RG_03c_ISSUES_P2.md](./RG_03c_ISSUES_P2.md) / [RG_03d_ISSUES_P3.md](./RG_03d_ISSUES_P3.md)（问题详情）
5. 所有 GitHub 文件读取链接均附加 `?t={当前Unix时间戳}` 参数
