# Phase 3 R10 五窗口并发执行补充裁决（2026-09-27）

本记录回答“五份 prompt 同时发出是否有问题”。按 `REVIEW_LOG_MASTER.md` §0/§4、R10 裁决与各包当前证据只读复核；另在当前工作树直接运行离线 `npm run test:isolation -- --runInBand`、两份认证 unit 定点。未运行 PG/全量回归，未改产品/测试、未提交/部署。本记录是**在途裁决**；公共链 follow-up 尚无最终结果，不能代替它的终审。

## 结论

**同时发任务可以；同时越过依赖闸门不可以。** 这轮没有证据表明窗口 3 提前编辑 schema/client、窗口 4 提前跑双实例恢复或窗口 5 提前跑全量回归；它们保留了阶段门禁。窗口 2 在窗口 1 停止前只做链外候选 SQL 验证、独占形状代码/测试与自有实例反例，尚未追加 migration。窗口 1 停止信号已发布，允许窗口 2继续独占追加前向 migration。**风险是跨窗口测试读取了未最终冻结的兄弟代码，绿灯属于测试时点，不能拼成最终链的同一条绿链。**

## 逐包状态与时点

| 包 | 本次裁决 | 依赖与下一步 |
|---|---|---|
| FIXTURE-MIGRATED-R2 | **PASS_LOCAL_ON_13_CHAIN**。旧 DDL 提取冲突消除，9 个动态入口 rc=0，isolation 68/68、live-api 49/49、report-auth 20/20、session 12/12，0 skip；实例 down，停止信号有效。 | 当时链尾仍 13 文件。`publicInfraShape.js` 由窗口 2 于 12:07 改动，live-api 日志为 12:11；其绿灯覆盖当时兄弟候选代码，不能自动代表窗口 2 最终前向 migration。窗口 2 锁定新链后，在新实例复跑**链依赖**的准备、`--check`/readyz/租户入口与受影响套件，逐时点记录源 hash；最终全量回归仍归 CLOSE-B。R10 prompt 把 report-auth fixture 放在 live-api 前、学校 B 放在 live-api 前，是编排错误；正确顺序为 provision→t02c→live-api→学校 B→report-auth fixture→其余入口。 |
| PUBLIC-INFRA-FOLLOWUP-R1 | **PROGRESS_ONLY**。F-1 真实复现、候选前向 SQL 链外试验、失效索引 12/12、R6d A/B 对照 4/4 已有证据；产品形状代码已编辑。 | 尚未交最终 RESULT/新 migration/hash/down。旧 13 链依然当前事实；其工作不得填 `PASS`。窗口 1 已停止，可继续按原任务独占追加并复证。 |
| LIFECYCLE-AB-R2 | **PASS_READONLY_PREP / IMPLEMENTATION_HOLD**。双产物 B1(A client+M2)→门禁→B2(B client) 方向有可执行方案，未改 schema/client。 | 等窗口 2 新链尾锁定、停止后才开 A/B。不能把“窗口 2 首包 13 链停止”误作 follow-up 的停止信号。其 BL-R2-3/4（A2/A5 与共享 hunk）仍需实施时明确归属；双产物策略可按既有 R9 授权推进，但必须实测生成、门禁、回退。 |
| W3-CROSS-REG-R2 | **PASS_LOCAL_SOURCE_AND_PG_ATOMICITY / CROSS_HOLD**。15/15 离线与真实 PG 5/5 双跑，缺来源拒绝、学校存在/状态校核、审计失败整事务回滚有证据；实例 down。 | 真实 PG 在 13 链旧时点，只验证注册模块原子性；双实例恢复仍须等生命周期 release 面停止、新链尾/恢复路径稳定。`meta.runId` 加显式 sourceRunId 使来源可追踪，**不是跨实例来源的密码学证明**，不能在后续报告中夸大。 |
| CLOSE-B-R2 | **PASS_ENTRY_RECONCILIATION / FULL_REGRESSION_HOLD**。递归枚举 23 项与 DB 缺环境非零门禁成立。 | 离线记录的 isolation 2 失败属窗口 1 中间态，现已消除；认证 unit 10 失败仍存在，须测试替身适配后再跑离线 unit，不能报全绿。最终全量回归仍最后独占。 |

## 本次独立复核

- `npm run test:isolation -- --runInBand`：**4 suites / 68 tests 全过，rc=0**。CLOSE-B-R2 的 2 例失败仅是其开工时点，当前不得继续列为活跃 blocker。
- `npx jest --config jest.unit.config.cjs --runInBand --runTestsByPath tests/refreshConcurrencyBackend.test.js tests/authRecheckFailover.test.js`：**2 suites 失败；10 fail / 2 pass，rc=1**。现有 Prisma 替身的 `$queryRawUnsafe` 未模拟 `publicInfraShape.js` 的 catalog 查询，按产品合同返回 table missing → `AUTH_INFRA_MISSING`。产品在真库缺设施时 503 是正确边界。
- `P3-FIXTURE-MIGRATED-R2/HASHES_FINAL.json` 102/102、`P3-W3-CROSS-REG-R2` 36/36、`P3-CLOSE-B-R2` 证据 34/34+源码 9/9+未触及 6/6，独立只读复验 `ALL_MATCH`。三包互不证明后续链状态。

## 立即分派与停止条件

1. **窗口 2继续原 follow-up**：窗口 1 已明文停止，允许按其原任务追加前向 migration，空/旧/重复/租户投影复证并锁新链尾；旧 13 文件逐字节不改。其结果返回后总控复审，再发窗口 3 的 A/B 编辑信号。
2. **认证离线替身修复单独授权**：归属窗口 2 或新的认证测试专窗，只改 `tests/refreshConcurrencyBackend.test.js` 与 `tests/authRecheckFailover.test.js` 中的 Prisma catalog 替身/必要测试辅助。返回与实际 `publicInfraShape.js` 一致的表/PK/索引形状；保留原 12 场景与全部业务断言，新增缺设施→503 的独立负例。不得在产品代码加入 unit 豁免、不得把两套件移到 DB 入口、不得把 `AUTH_INFRA_MISSING` 降级。跑两文件及 `npm run test:unit`，0 skip、逐项 rc，若保护清单涉及测试则注释溯源并登记授权。
3. **窗口 1 的链依赖补跑**：等窗口 2 最终新链尾后以新实例/新源 hash 对账，只补跑受前向 migration 影响的准备、`--check`、readyz/API 与相关 fixture/live-api；若实际影响范围扩大再扩跑。按窗口 1 已证明的正确入口顺序，不在旧 13 链实例上升级凑绿。
4. **窗口 3/4/5 继续各自 HOLD**：LIFECYCLE 等新链尾和总控信号；W3 双实例等生命周期完成；CLOSE-B 全量等四窗停止并核验。并发只限各自独占、无依赖的工作。

此次最关键的修正是**按版本与时点对账**：13 链的绿灯、候选形状代码的绿灯、未来 14 链的绿灯不可相加成一次完整验收。

可直接转发给现有窗口的补充指令见 `phase3/P3-R10_CONCURRENT_CORRECTION_PROMPTS.md`；其内容只调整接力与测试替身归属，不重发五个并行实施任务。
