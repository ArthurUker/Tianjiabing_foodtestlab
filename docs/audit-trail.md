# 审阅与修复审计追踪（Audit Trail）

> 本文件记录项目审阅-修复流程中的每一次动作（基线/执行/回滚），保证可追溯、可核查。
> 记录原则：每次获批执行前打基线锚点，每个授权项独立 commit，通过 `git log --grep="AUDIT-"` 客观核实。

## 一、历史遗留说明（无法精确追溯部分）

在引入 Git 审批锚点机制之前（第七轮之前），以下改动的产生轮次无法通过 commit 精确核实，
只能依据对话记录回溯。**凡未在下方"已批准"清单中出现的改动，一律视为未授权/历史遗留**。

| 阶段 | 事实 | 授权状态 |
|---|---|---|
| 第一轮（Excel 分析） | 仅产出 16 条问题分析结论，无代码改动 | 审阅 |
| 第二轮 | 未经审批直接落地 14 个文件的修复代码（Sheet1-3/4/5/6/8、Sheet2-1/2/3/5 及 C2 连带） | ❌ 未授权（违规产物） |
| 第三轮 | A 组审阅结论（未改动代码） | 审阅 |
| 第四轮 | 授权项1（login.html 相对路径）+ 授权项2（重建 dist，前置 diff 零差异）；B 组 diff 草稿呈报 | 部分授权 |
| 第五轮 | 工作区清算表（14 文件 / 189+/49-） | 审阅 |
| 第六轮 | 清算矛盾核查（发现 Tableware.js 披露缺陷） | 审阅 |
| 第七轮 | 逐项问答审批（15 项全部批准保留，已逐项独立 commit） | ✅ 全量授权 |

> 上述第二轮的 14 个文件改动，在第七轮已通过逐项问答（编号 1-15）全部获得用户明确批准，
> 并以独立 `AUDIT-EXEC` commit 固化，故不再视为"未授权"，但**dist 重建与后端重启仍待服务器端执行**。

## 二、审批锚点与执行记录（commit 级可追溯）

- **审批基线**：`869f47b`（`docs: browser verification checklist for QA (2026-08-07)`）——最后一次已知干净基线
- 第七轮曾建立临时锚点 `e9af1ed`（AUDIT-BASELINE: 第七轮问答确认前状态快照），
  为满足"逐文件独立 commit"要求已拆解（`git reset --soft`），该锚点不再出现在提交链中，内容与最终提交一致。

### 第七轮问答审批执行记录（全部批准保留）

| 编号 | commit hash | 文件 | 对应问题 | 授权依据 |
|---|---|---|---|---|
| 1 | `311cacd` | login.html | Sheet2-3 | 用户第七轮问答确认批准(编号1-A) |
| 2 | `bbbb23d` | admin-schools.html | Sheet2-5 | 用户第七轮问答确认批准(编号2-A) |
| 3 | `f7c1e0c` | backend/prisma/schema.prisma | Sheet1-6 | 用户第七轮问答确认批准(编号3-A) |
| 4 | `39c5f2e` | backend/routes/frequencyRoutes.js | Sheet1-6 | 用户第七轮问答确认批准(编号4-A) |
| 5 | `0aae524` | index.html（守卫） | Sheet1-8 | 用户第七轮问答确认批准(编号5-A) |
| 6 | `1d33fb9` | index.html（镉铅选项，追溯标记；内容含于 0aae524） | Sheet1-4 | 用户第七轮问答确认批准(编号6-A) |
| 7 | `79b2ebd` | js/core/Storage.js | Sheet1-8 | 用户第七轮问答确认批准(编号7-A) |
| 8 | `d80dd41` | js/modules/BackupRestore.js | Sheet1-8 | 用户第七轮问答确认批准(编号8-A) |
| 9 | `9c7c237` | js/modules/FrequencyModule.js | Sheet1-6 | 用户第七轮问答确认批准(编号9-A) |
| 10 | `dea5b06` | js/modules/GenericTest.js | Sheet2-1/2 | 用户第七轮问答确认批准(编号10-A) |
| 11 | `83158df` | js/modules/Pathogen.js | Sheet1-5 | 用户第七轮问答确认批准(编号11-A) |
| 12 | `2257ae4` | js/modules/Tableware.js | Sheet1-3 | 用户第七轮问答确认批准(编号12-A) |
| 13 | `e9a4328` | js/services/AuditService.js | Sheet1-8 | 用户第七轮问答确认批准(编号13-A) |
| 14 | `2f9da6d` | js/services/ExportService.js | Sheet1-8 | 用户第七轮问答确认批准(编号14-A) |
| 15 | `4458955` | js/services/PermissionService.js | Sheet1-8 | 用户第七轮问答确认批准(编号15-A) |

## 三、待服务器端执行（非本地动作）

以下操作由用户在服务器端完成，本地 Agent 不执行：

1. `git pull` 拉取最新代码（含上述 15 个 AUDIT-EXEC commit）
2. `node scripts/build-static.js` 重建 dist（使生产产物与已批准源文件一致）
3. 重启后端服务（加载已批准的 `frequencyRoutes.js`/`schema.prisma` 等后端改动）

## 四、核查命令

```bash
# 列出所有审批相关提交
git log --grep="AUDIT-" --oneline

# 查看某个文件的审批/执行历史
git log --oneline --all -- <file>

# 核对基线后全部变更
git diff 869f47b --stat
```
