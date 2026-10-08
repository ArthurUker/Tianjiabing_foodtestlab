# P3-FIXTURE-MIGRATED-R3-14CHAIN 限定复审（R12，2026-09-27）

## 裁决与接力

**PASS_LOCAL_SCOPE**：窗口 1 的 14 链补证满足进入窗口 3 生命周期 A/B 实施的接力条件。此裁决只覆盖本包定点，不代表生命周期、双实例恢复、全量回归或部署验收。窗口 3 现在独占 `schema.prisma`、Prisma client 与新增 migration；窗口 4 的双实例恢复等窗口 3 明文释放，窗口 5 的全量回归等窗口 1–4 均停止并经总控核验。

## 核验依据与限制

- 我独立运行 `P3-FIXTURE-MIGRATED-R3-14CHAIN/hash-final.mjs --verify-only`，**88/88 ALL_MATCH**；窗口 2 的 `P3-PUBLIC-INFRA-FOLLOWUP-R1/hash-final.mjs --verify-only`，**110/110 ALL_MATCH**；冻结 29 只读复核 **29/29 ALL_MATCH**；`git diff --check` 通过。
- 交付原始证据记录全新实例的 10 个入口均 rc=0、0 skip：live-api 49/49、isolation 68/68、集成 27/27、report-auth 20/20、session 12/12；终态 `db:sync --check` 为 2 校 14/14，readiness=200。执行者的实例 down、hash 前后不变与 14/14 逐文件精确匹配有原始日志和哈希清单支持。我没有独立重跑 PG 或全套件。
- **聚合 digest 不能混用**：锁文件 `CHAIN_TAIL_LOCK.json` 写 `4e8595bb03f228e747ef3b302ea4b16d07725c4b5043ed4988f47b3c432fda22`；当前产品 `migrationChainDigest()` 独立运行得 `88a2ba456f38ab0854995768707f8cca6124dbf5d1d017b6d31d3f6ff10c2522`。锁文件未声明聚合算法，不能据此声称两个值相等，也不能把该字段用作产品台账的预期值。14 条 `name/checksum/bytes` 与文件逐项一致、旧 13 文件未变，足以固定本次输入。保留原证据不改写；窗口 3 在新证据中分别标注“锁聚合值”和“产品运行时值”，并检查新实例台账的 `chain_digest` 是否按产品算法写入。
- 交付中的 `applied_projected` 属产品 `LEDGER_TERMINAL`，不应被夹具误判为 pending。窗口 1 已明文停止，窗口 2 已明文停止；当前无生命周期 R3 新证据目录，`schema.prisma` 未显示改动。窗口 3 开工时仍须重新取输入快照及共享面 hash。

## 下一步

给窗口 3 发送 [P3-NEXT_RELAY_R12_PROMPT.md](../../reviews/global-audit-20260924/phase3/P3-NEXT_RELAY_R12_PROMPT.md) 中的单份 prompt。窗口 4、5 已有原任务，暂不发动态执行信号。
