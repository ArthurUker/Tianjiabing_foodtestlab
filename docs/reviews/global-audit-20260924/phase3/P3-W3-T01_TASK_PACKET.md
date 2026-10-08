# CodeBuddy TASK PACKET — P3-W3-T01（并行包 A：备份/恢复状态机，RC-03）

## 任务与固定边界

修复 **AUD-004 / AUD-005 / AUD-006 / AUD-007**（备份/恢复缺状态机与命名空间；最终严重度 006=FINAL_P1、007=FINAL_P2、004/005=P1）。依据：`phase2/ROOT_CAUSE_MATRIX.md` RC-03、`phase2/REMEDIATION_DEPENDENCY_GRAPH.md` W3、`phase2/FINAL_SEVERITY_ARBITRATION.md`。

**⚠️ 并行执行**：本包与 P3-W4-T01、P3-W5-T01 在**同一工作树**并发执行。规则：
1. 只改本包授权文件与新建文件；兄弟包文件（`frontend/js/core/Storage.js`、`frontend/js/core/AdaptiveUploadQueue.js`、`frontend/js/modules/{GenericTest,Pathogen,Dashboard,GuestDashboard}.js`、`backend/lib/{recordNormalize,openApiFieldSchema,openApiScope}.js`、`backend/routes/{recordRoutes,guestRoutes}.js`）**绝不修改、绝不还原**，其 drift 属预期（快照已标 `PARALLEL_OTHER_PACKET_SCOPE_DO_NOT_TOUCH`）。
2. **禁止运行全套件**（root Jest 全量 / backend 全量 / integration 全量会读到兄弟包的半成品）；只运行本包**定点测试**（自建实例，provisioner 为共享只读设施）。
3. 不 reset/clean/stash/stage/commit/push；固定 HEAD `7343a8a9f8fc28b7ef2a6bad2b22c701b2fbf9e7`、branch `Product_tencent_CVM`。
4. 先读 `ORCHESTRATOR_STATE.md`、本包、`P3-W3-T01_REVIEW_INPUT_MANIFEST.json`（616 项），开始只读核验**本包范围**；非兄弟、非授权 drift 先报告。

## 允许修改（仅此）

- `backend/lib/backupService.js`（531 行）、`backend/lib/restoreService.js`（256 行）
- `backend/routes/adminBackupRoutes.js`、`backend/routes/schoolBackupRoutes.js`
- `backend/scripts/003_backup-now.mjs`
- `tests/backupKms.test.js`、`tests/restoreSchemaRewrite.test.js`（既有 root Jest 定点回归，随语义更新）
- 可在 `backend/lib/` 新建备份/恢复台账与命名空间辅助文件；可在 `backend/tests/backup/` 新建本包 node:test 套件；新证据只写 `phase3/evidence/P3-W3-T01/`

保护项含 `deploy.sh`/`deploy/`（READONLY_MODE 与 Caddy 联动如需改 deploy → **DESIGN BLOCKER 注记**，只交应用侧设计与开关）。NF-B-02（恢复明文落 `/tmp`）按 RC-03 口径顺带改私有目录/流式，属本包范围。

## 总控设计口径（源自 RC-03，不另行发挥）

1. **恢复 = 状态机**：任务台账（owner/runId/目标 code/暂存 schema/阶段/时间戳）；暂存 schema 名含随机熵且**登记归属**；切换（DROP/RENAME）前必须再校验目标对象仍属本任务；任何 DROP 只命中台账登记对象。撞名 `school_<code>_restore` 类固定名**废除**（AUD-004）。
2. **互斥**：同校恢复/备份用 PG advisory lock（`pg_try_advisory_lock`，键含 scope+code）；并发请求只有一个获得执行权，其余明确 409/423 类拒绝（AUD-005）。恢复窗口的**写屏障**：应用侧在恢复状态机进入 STAGING 即拒绝该校写路径（复用/新增应用内开关；不动 deploy）。
3. **备份快照一致**：计数与 dump 共享同一快照（`REPEATABLE READ` 事务 + `pg_export_snapshot()` 传给 pg_dump `--snapshot`，或从 dump 反推计数）；不一致不得登记 `ok/passed`（AUD-006）。
4. **备份命名空间独占**：文件名加随机 ID + 任务专属临时目录 + **原子发布**（rename）；失败清理只删台账登记的自己产物（AUD-007）。
5. **台账存储**：优先文件系统/库内系统表均可，但若新增 public 系统表须评估：当前环境**不允许**新 migration（W2 未做）→ 默认用实例内专属命名空间/文件台账，并在报告中说明多实例限制（单体 Caddy 单后端现状）。
6. 兼容：既有备份产物格式/恢复入口的外部行为不变（管理端路由、CLI `003_backup-now` 可用）；`RESTORE_DROP_OLD` 语义与保留策略不变。

## 退出条件

- 定点测试（自建实例，真实 PG）：① 并发恢复互斥（只一个执行权、另一个明确拒绝、失败清理不触碰他人 schema/产物）；② 暂存撞名注入（预建同名合法 schema → 不 DROP 他人）；③ 备份持续写入下计数一致（快照语义正例 + 不一致时拒绝登记的负例）；④ 同秒同范围并发备份（产物互不覆盖、失败不删对方）；⑤ 既有 `tests/backupKms.test.js` / `tests/restoreSchemaRewrite.test.js` 定点通过（语义如需更新，记录旧断言→新断言映射，不许删断言凑数）。
- 逐入口真实 rc/原始日志；实例安全 down（进程/端口/目录三条件）；台账不留残留。
- 证据 `evidence/P3-W3-T01/`：RESULT.md、COMMANDS.md、TEST_RESULTS.json、实例登记、输入对照（本包范围 + 兄弟 drift 豁免）、冻结 29 只读核验、`HASHES_FINAL.json`（先报告后生成、排除自身、两次只读复验）。不运行旧 PF `manifest-verify.mjs`。
- **不跑全套件**；在 RESULT 中明确「全套件回归留待三合一轮次」。

## 返回

STATUS（仅 W3-T01）、CHANGED FILES、定点 rc、并发/撞名/快照/命名四组判别证据、资源与 hash/Git、DESIGN BLOCKER（如有）、未决项、ASTRA REVIEW HANDOFF，然后停止。
