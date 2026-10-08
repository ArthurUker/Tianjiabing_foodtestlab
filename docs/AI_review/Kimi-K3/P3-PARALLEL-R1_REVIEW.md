# P3 并行轮次 1（W3-T01 / W4-T01 / W5-T01）— Orchestrator consolidated review

日期：2026-09-25。裁决：**三包均 PASS（本地定点验收；全量回归留 P3-CONS-T01）**。AUD-004/005/006/007、AUD-001/021/022、AUD-003/025 的代码修复进入「待全量回归确认」状态；未提交/未部署。总控只读复核，未代跑、未修改。

## 统一核验记录

- **Git**：HEAD `7343a8a`、branch `Product_tencent_CVM`、index 空，三包执行前后一致。
- **输入快照（各 616 项）**：三包均 **PROTECTED 漂移 0、缺失 0**；变化集合三包交叉一致——W3 授权 5 改（`backupKms.test.js` 未改属实）+ 10 兄弟；W4 授权 2 改 + recordRoutes + 13 兄弟；W5 授权 8 改 + recordRoutes + 7 兄弟。
- **共享文件 `recordRoutes.js` 行区纪律**：`git diff -U0` 共 10 hunks —— W5 3 个（:12、:162-166、:186-191，**全部 ≤300**）+ W4 7 个（:565/:627/:629/:648/:652/:695/:922，**全部 ≥480**）；**缓冲区 :301-479 零改动**；W4 区内 P3-W4-T01 标记 6 处、外来标记 0。与两包行区声明逐字吻合。
- **越权自查**：W3 申报的 `restoreSqlUtils.js` 一度被改 → 实测 `git diff` **0 行**（100% 还原）属实。
- **冻结 29**：只读核验 ALL_MATCH。**输出 hash**：W3 54/54、W4 37/37、W5 30/30，全部独立复算通过。
- **资源**：端口 55441/55442/59961 实测无监听，无 w3t01/w5t01 残留进程；W3 实例 b down 三条件全 true、`status.exists=false`。
- **语法**：`recordRoutes.js`、`backupService.js`、`restoreService.js`、`backupJobs.js`、`conclusionVerdict.js`、`guestRoutes.js` `node --check` 全过。

## 分包裁决

### W3-T01（AUD-004/005/006/007 + NF-B-02）→ PASS
rc 全 0（引擎单元 11/11、备份产物 5/5、恢复状态机 7/7、jest 定点 15/15、冻结×2、实例 down）。判别证据在原始日志可查：并发恢复恰一个执行权（`RESTORE_LOCK_BUSY` 409）、撞名哨兵存活、快照一致正例 vs live 模式 `BACKUP_ARTIFACT_INCONSISTENT` 负例、同秒并发备份锁。过程失败（dev 实例 a 的两轮 ✖）原样留档。命名兼容（`_stg_<8hex>` 新名 vs `_old_<epoch>` 保留策略 005）判断合理。**DESIGN BLOCKER（server.js 挂载 per-school 屏障）裁决：挂起到 W1 波次**——server.js 是 W1（RC-02）主战场，现在挂载制造合并摩擦；当前全局 `READONLY_MODE` 屏障功能正确仅范围偏宽，已登记。

### W4-T01（AUD-001/021/022）→ PASS
新增 23 用例全绿（4+7+4+8），既有 `route-write-paths` 23/23 只读回归通过；键作用域 `cache_v2__<tenant>__<subjectHash>__<res>` + 旧键一次性隔离封存（零双读）；状态机（在途编辑/在途删除/墓碑防复活）；409 扩展 + stale 五路径拒绝 + 旧客户端明确失败。两项登记偏差（4xx 不退避、旧键封存而非迁移）可接受。**未决项转入 CONS 包**（见下）。

### W5-T01（AUD-003/025）→ PASS（含 1 项已裁决冲突 + 1 项已授权遗留）
判定矩阵 9/9、油脂 PG 4/4、注入回归 9/9；受影响套件 207/206/**1 fail** 恰为申报冲突。总控实测 `normalizeConclusion`：未知非空 colorLevel（含与 result 冲突）一律 `unknown`、仅空值回退 result —— 与最终仲裁（FINAL_P2：未知值不得沿用合格规则）一致。**冲突裁决**：`contract.test.mjs:185-186` 断言的「未识别等级回退 result 文本」正是 AUD-025 审定的 fail-open 残留（2026-09-17 那次"P1 修复"只闭合了"非空即合格"、保留了回退通道）——**授权在 CONS 包改写这两条断言为新口径**（`深绿色+合格→unknown`、`foo+不合格→unknown`），保留场景与注释溯源。**U1 裁决**：`openApiRoutes.js:603-611` 纳入 CONS 包授权（改调同一判定源 + 同步 `stats-date` 的 `RC-stats-4` 期望 pass 2→1）。

## 转 P3-CONS-T01 的收口清单（下一轮窗口 1）

1. `contract.test.mjs:185-186` → 新口径（已裁决）。
2. `openApiRoutes.js:603-611` → 同一判定源 + `stats-date.integration.test.mjs` RC-stats-4 期望更新。
3. W4 未决 #2：4 个旧契约测试（`storageApplyServerRecord`/`storageDurabilityAndRace`/`storageForceServer`/`uploadQueue409Recovery`）按 probe 契约更新——保留场景、断言反转为新语义、注释溯源（`uploadQueue409Recovery` 即"缺陷B"probe，正式 regression 已由 w4 套件承接）。
4. W4 未决 #1：5 处旧键直读（`Dashboard.js`、`GenericTest.js`、`Tableware.js`、`main.js`、`utils/SampleDataGenerator.js`）→ 迁移 `getStorageKeys()`。
5. 全量回归（单实例）：root Jest / PG integration / backend node:test / isolation，建立**新基线**（计入 w3/w4/w5 新套件与 root 新增用例；root 历史两项失败不变则仍为 2）。
6. W3 登记：多实例台账限制（W2 依赖）、旧产物兼容未回归、live 模式运维注记——转入各自后续波次，不阻塞。

## 下一轮另一窗口

P3-W0-T02E（live-api 数据契约，窗口 2）：与 CONS 文件面互不相交（仅 `live-api.mjs` + `t02c-*` harness），并行安全。W1（会话模型）/W2/AUD-040/AUD-002/020/017 留再下一轮。
