# 历史全仓审查资产 · 服务器读取入口

2026-10-08 发布到 GitHub，目标分支 `Product_tencent_CVM`。用途：供服务器拉取后，由 CodeBuddy 获取完整 AUD 明细、冻结裁决和阶段审阅记录。

本包保留历史文件内容和历史结论。**资料可取得不代表当前代码已验证或历史问题已修复。** 2026-09-24 初始审计基线为 `f08e72e3e74d188b4555e0bee16280b3dd0d622b`；后续 Phase 3 文档各有其自身基线、轮次和证据范围。

## 先读顺序

1. [SERVER_HANDOFF.md](SERVER_HANDOFF.md)：服务器更新、哈希核对与 CodeBuddy 任务边界。
2. [PUBLICATION_MANIFEST.json](PUBLICATION_MANIFEST.json)：已发布文件、来源 hash、范围与验证状态。
3. [ISSUE_INVENTORY.md](ISSUE_INVENTORY.md) 与 [issues.json](issues.json)：完整 `AUD-001` 至 `AUD-049` 共 49 项原始问题。
4. [VERIFICATION.md](VERIFICATION.md)、[coverage.tsv](coverage.tsv)、[repository-map.json](repository-map.json)：原始验证范围、覆盖和架构地图。
5. [phase2/FINAL_SEVERITY_ARBITRATION.md](phase2/FINAL_SEVERITY_ARBITRATION.md)、[FINAL_ARCHITECTURE_DECISIONS.md](phase2/FINAL_ARCHITECTURE_DECISIONS.md)、[ROOT_CAUSE_MATRIX.md](phase2/ROOT_CAUSE_MATRIX.md)、[REMEDIATION_DEPENDENCY_GRAPH.md](phase2/REMEDIATION_DEPENDENCY_GRAPH.md)：冻结裁决和修复依赖。
6. [phase3/REVIEW_LOG_MASTER.md](phase3/REVIEW_LOG_MASTER.md) → [ORCHESTRATOR_STATE.md](phase3/ORCHESTRATOR_STATE.md) 顶部最新历史裁决 → 对应任务包/输入清单/独立审阅。
7. Phase 3 的最新 R19 独立裁决为 [P3-CLOSE-B-R19_REVIEW.md](../../AI_review/Codex-GPT6/P3-CLOSE-B-R19_REVIEW.md)。它保留历史本地测试绿链与证据保密性返工、发布/授权/回退未完成的边界。
8. 再进入 [2026-10-08 全仓审查计划](../full-repository-review-plan-20261008/README.md)，复核当前版本；不要从旧“当前”字段推断服务器此刻状态。

## 本次入库范围

- 7 份初始全局审查文件，包含 49 项完整 AUD 明细及原始复现结果。
- Phase 2 的报告、裁决、结构化验证结果和复现脚本。
- Phase 3 根目录的审阅、任务包、接力提示词、总账和输入 manifest。
- Phase 3 读序引用的 GPT6-Astra、Kimi-K3、Codex-GPT6 独立审阅文档及跨模型交接入口；保留原相对链接路径。
- 共 165 份已有历史文件，以当前内容原样发布；另新增本读取入口、服务器交接、发布清单、引用可获得性表及校验和。

## 原始证据边界

`phase3/evidence/**`、`phase3/local-reconcile-20260928/**`、运行 `.env`、PID、原始日志、产品源码快照和旧 GitHub 上传草稿保持本地归档，不在本次提交中。历史 R19 已记录原始日志中的凭据留存问题；本次未将该类日志上传。

已发布报告中的原始证据路径和旧 hash 原样保留，不将其改写成可在服务器重跑的证据。Markdown 文件链接的可获得性见 [REFERENCE_AVAILABILITY.tsv](REFERENCE_AVAILABILITY.tsv)：`PUBLISHED_IN_THIS_COMMIT`、`ALREADY_TRACKED`、`LOCAL_ONLY_NOT_PUBLISHED`、`MISSING_REFERENCE` 分开记录；该表仅解析 Markdown 文件链接，不声称穷举正文代码块中所有路径。

服务器拉取并校验后，AUD 明细的 `MISSING_REFERENCE` 可以改为“历史源资料已取得，当前版本复核待做”。动态原始证据未取得的条目继续记录 `LOCAL_ONLY_NOT_PUBLISHED`，不得升级验证状态。

## 复现与版本说明

[probes.mjs](probes.mjs) 和 Phase 2 probes 是历史缺陷行为验证脚本。它们的 PASS 可能表示不安全行为被复现；当前源码变化后，它们可能失败或不再适用。先审阅代码、隔离条件和基线，再在明确授权范围执行，不在生产仓库顺手运行。

这些文件属于历史资产，不纳入 2026-10-08 计划冻结的 460 个文件分母。下一次 P0 要重新冻结当前仓库，登记本次新增资料；历史文档与自研代码/测试覆盖率分别统计。
