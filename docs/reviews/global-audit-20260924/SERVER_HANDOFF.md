# 服务器 GitHub 拉取与 CodeBuddy 接续

本文件是资料交接说明，不执行服务、数据库、迁移、构建或部署。

## 服务器拉取后先核对

在服务器现有仓库中检查分支与工作区，保留所有本地修改；只有可以 fast-forward 的状态才继续更新。若已有改动/分叉导致失败，保留现场并报告，不 reset/clean/stash 或覆盖。

```sh
git status --short
git branch --show-current
git pull --ff-only origin Product_tencent_CVM
git log -1 --oneline
sha256sum -c docs/reviews/global-audit-20260924/SHA256SUMS
```

校验和路径以仓库根为工作目录，包括已发布的关联审阅文档。`SHA256SUMS` 覆盖 165 份原始资产和发布入口/交接/引用表/manifest；不包含校验和文件自身。所有核对必须使用实际取得的本次提交，不使用旧工作区结果。

本次提交只更新审查文档和 `.gitignore`。拉取资料后无需为此重启服务、执行迁移或重新构建应用。

## 可复制给 CodeBuddy

```text
任务：补齐全仓审查的历史资产来源，再继续已授权的 P0/静态审查。

先核对当前 branch/HEAD/dirty；确认本次 GitHub 历史资料提交已拉取。
在仓库根运行：
sha256sum -c docs/reviews/global-audit-20260924/SHA256SUMS
记录真实退出码和逐文件结果，缺文件/hash不匹配保留 MISSING_REFERENCE/REFERENCE_HASH_MISMATCH。

读取顺序：
1. docs/reviews/global-audit-20260924/README.md
2. PUBLICATION_MANIFEST.json、REFERENCE_AVAILABILITY.tsv
3. ISSUE_INVENTORY.md、issues.json、VERIFICATION.md
4. phase2/FINAL_SEVERITY_ARBITRATION.md、FINAL_ARCHITECTURE_DECISIONS.md、
   ROOT_CAUSE_MATRIX.md、REMEDIATION_DEPENDENCY_GRAPH.md
5. phase3/REVIEW_LOG_MASTER.md、ORCHESTRATOR_STATE.md 的顶部最新裁决，
   对应独立审阅、任务包和输入manifest；R19及更早记录都是历史时点。
6. docs/reviews/full-repository-review-plan-20261008/README.md 与当前计划。

核验 issues.json 是49个唯一ID，AUD-001..AUD-049全部存在。
原先“AUD明细不可得、仅24条引用线索”的条目，在拉取和hash实际通过后，
更新为历史源明细已取得；保留原缺口发现记录，不改旧审查结论。
为所有AUD建立当前SHA/代码位置/证据/状态对照，不沿用历史PASS为当前PASS。

phase3/evidence 与 local-reconcile 原始日志/运行环境/快照未发布；
此类路径记 LOCAL_ONLY_NOT_PUBLISHED，所需动态证据仍待取得或按隔离方案补证。
已发布的历史测试结果是报告证据，不等于原始日志已复核。

重新冻结当前Git范围与增量；旧计划460文件分母不自动覆盖这次新增资料。
继续本轮已授权的P0/只读审查，不因拉取资料而运行旧probes、测试、迁移、
构建、seed、清理、重启或部署；不改产品代码、不提交其他窗口工作。
输出引用恢复表、AUD血缘/当前状态对照、仍缺原始证据、下一精确动作。
```
