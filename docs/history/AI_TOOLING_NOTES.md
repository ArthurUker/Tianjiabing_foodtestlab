# AI 工具使用可靠性注意事项

**文档路径**：`docs/AI_TOOLING_NOTES.md`
**创建日期**：2026-07-02
**适用范围**：本项目（食品安全检验管理系统 Pro）所有 AI 辅助开发、代码审计、bug 排查任务

---

## search_content（ripgrep）中文搜索可靠性注意事项

### 已知问题

`search_content` 工具（基于 ripgrep）在处理中文关键词搜索时，存在以下已确认的可靠性缺陷：

#### 1. 误报 0 命中

对某些中文子串搜索可能返回 0 命中，即便该字符串在文件中确实存在。

- **案例 A**：`docs/fix/P0/FIX_P0-11_passRateMisjudge.md` v1 排查记录——对 `合格` 的 `search_content` 搜索返回 0 命中，导致遗漏 5 处实际存在的 bug（Dashboard.js `getLeanMeatStatsByType` / `calculateCanteenTrends` / `calculateCanteenPassRate` 及 Tableware.js 2 处），直至 v2 改用 `grep -rn` 命令行工具才发现。
- **案例 B**：2026-07-02 P0-11 收尾登记 P2-24 时，对 `js/modules/GenericTest.js` 执行 `search_content`（pattern 含 `合格`/`警戒`/`不合格`）再次返回 0 命中，改用 `grep -n` 命令行后正确返回 25+ 行命中。
- **案例 C**：TD-P2-31 排查时同样出现 `search_content` 中文搜索异常，需改用 `read_file` 逐段读取绕过。

#### 2. 行号偏移

返回的命中行号可能与文件实际行号存在 2-3 行偏差。

- **案例**：`docs/fix/P0/FIX_P0-11_passRateMisjudge.md` v3 章节——`Tableware.js` 打印模板行 `search_content` 报告 L1206，经 `read_file` 实际读取确认为 L1209（偏移 3 行）。

### 强制规范

1. **任何"确认某中文模式在全仓库不存在"的结论，禁止仅凭 `search_content` 单一工具得出**，必须使用 `grep -rn "<关键词>"`（或等价的可靠命令行搜索）交叉验证后才能下结论。
2. **涉及行号的具体引用**（如"第 X 行存在此问题"），若来源于 `search_content`，建议以 `read_file` 实际读取结果为准校正。
3. 本注意事项适用于所有涉及中文关键词的代码审计、bug 排查、历史影响面评估类任务。

### 修订记录

| 日期 | 变更内容 |
|------|---------|
| 2026-07-02 | 首次登记，基于 P0-11 bug 排查中三次实际暴露的工具异常案例（v1 误报 0 命中、TD-P2-31 搜索异常、v3 行号偏移） |
