# PHASE 3 审阅总账（REVIEW LOG MASTER）— 供 GPT 冷启动续审

> **2026-09-28 R19 最新增量**：[P3-CLOSE-B-R19_REVIEW.md](../../../AI_review/Codex-GPT6/P3-CLOSE-B-R19_REVIEW.md) 核验 R4 单实例全量测试绿链：backend 460/460、0 skip，全部入口 rc=0、readyz/API 200、006 GATE_PASS；HASHES 独立复验 85+5+6 ALL_MATCH。发现 `logs/w3-env-map.json` 保存管理 URL 与备份主密钥明文，报告“凭据不进日志”错误，故测试结果成立但证据保密性须返工。B-7b helper 口令透传、真实部署两段接线与授权/回退仍待做；不能把本地回归 PASS 等同发布验收。

> **2026-09-27 R18 最新增量**：F/L/P 三包限定复审见 [P3-R18_CONTRACTS_REVIEW.md](../../../AI_review/Codex-GPT6/P3-R18_CONTRACTS_REVIEW.md)，原窗口 5 单份新任务见 [P3-NEXT_RELAY_R18_PROMPT.md](P3-NEXT_RELAY_R18_PROMPT.md)。B-1…B-6 定点已闭合，004 真实双会话 8/8；证据复验 84/84、24/24、38/38，冻结 29/29、入口审计 24/24。R17 旧 fixture 顺序作废：T02B 先于 T02E/root。B-7 W3REG env 仍由窗口 5 新 R4 runner 修并独占干净实例全量复跑。R3 全量红链原样留档，当前仍 **NO_PASS_LOCAL_REGRESSION**；发布/部署 HOLD。

> **2026-09-27 R17 最新增量**：窗口 5 `P3-CLOSE-B-R3` 限定复审见 [P3-CLOSE-B-R17_REVIEW.md](../../../AI_review/Codex-GPT6/P3-CLOSE-B-R17_REVIEW.md)，下一轮三项并行定点 + 最终串行全量 prompt 见 [P3-NEXT_RELAY_R17_PROMPTS.md](P3-NEXT_RELAY_R17_PROMPTS.md)。入口 G3 修复独立核验 24/24；R3 清单 85/85+9/9+6/6、冻结 29/29。全量**仍红**：backend 390/415、25 fail，root/live-api/report-auth/session 亦红，**NO_PASS_LOCAL_REGRESSION**。红因校正：live-api 已 DELETE 200，残留是软删墓碑；旧链断言为 6 项/5 文件；W3REG 管理 URL 是与 fixture 级联不同的 runner 环境缺口。三独占面先修测试合同，窗口 5 再用新证据/新实例全量复跑。部署继续 HOLD。

> **2026-09-27 R16 最新增量**：窗口 3 R6 与窗口 4 双实例恢复限定复审见 [P3-R16_LIFECYCLE_CROSS_REVIEW.md](../../../AI_review/Codex-GPT6/P3-R16_LIFECYCLE_CROSS_REVIEW.md)，下一棒单份 prompt 见 [P3-NEXT_RELAY_R16_PROMPT.md](P3-NEXT_RELAY_R16_PROMPT.md)。两包限定 PASS_LOCAL_SCOPE；证据独立复验 56/56、156/156，冻结 29/29，unit 当前 28/286 全绿。`test:entry-audit` 当前 **rc=1**，一个 `*.unit.test.cjs` 未收录，窗口 5 必须先修入口 G3，才在独占实例跑全量。W3 的 C6c 是注入态、序列权限 N/A；readyz/API 200 依赖测试准备补授权，真实部署授权尚未证明。窗口 5 获本地全量启动信号；发布/部署继续 HOLD。§0/§4 不变。

> **2026-09-27 R15 历史增量**：窗口 3 R5 限定复审见 [P3-LIFECYCLE-AB-R15_REVIEW.md](../../../AI_review/Codex-GPT6/P3-LIFECYCLE-AB-R15_REVIEW.md)，两份接力 prompt 见 [P3-NEXT_RELAY_R15_PROMPTS.md](P3-NEXT_RELAY_R15_PROMPTS.md)。独立复验 R5 证据 64/64、冻结 29/29、当前 16 文件产品摘要 `03993cf97…`。M2 三类语义空系统行局部通过；004 必填 pre 与已绑定主体核对局部通过，但预校验后重读行、UPDATE 比新读值，仍有陈旧映射竞态且先建主体可能留孤儿。004 并发路径 REWORK；窗口 4 可在固定链/独立实例、禁调用 004 映射条件下启动双实例恢复，与窗口 3 的独占脚本 R6 并行。窗口 5 全量回归 HOLD；发布沙盒不等于真实部署。§0/§4 不变。

> **2026-09-27 R14 历史增量**：窗口 3 R4 限定返工复审见 [P3-LIFECYCLE-AB-R14_REVIEW.md](../../../AI_review/Codex-GPT6/P3-LIFECYCLE-AB-R14_REVIEW.md)，限定 R5 prompt 见 [P3-NEXT_RELAY_R14_PROMPT.md](P3-NEXT_RELAY_R14_PROMPT.md)。独立复验 R4 证据 61/61、冻结 29/29、当前 16 文件产品摘要 `844a5506…`、发布沙盒 7/7。管理员 grant 守门与 006 双向空值判据已闭合；004 `pre` 可省、已绑定行跳过映射核对，M2 P-4 仅认 SQL NULL 与 006 的 JSONB null/空对象口径不一致。裁决 **REWORK**，窗口 4 双实例恢复及窗口 5 全量回归继续 HOLD；部署包装器仅有函数级沙盒，真实部署另验。§0/§4 不变，未提交/未部署。

> **2026-09-27 R13 历史增量**：生命周期 A/B 限定复审见 [P3-LIFECYCLE-AB-R13_REVIEW.md](../../../AI_review/Codex-GPT6/P3-LIFECYCLE-AB-R13_REVIEW.md)，窗口 3 限定返工 prompt 见 [P3-NEXT_RELAY_R13_PROMPT.md](P3-NEXT_RELAY_R13_PROMPT.md)。A/B 矩阵 33/33、23/23 与受影响定点结果可保留，但管理员预览/字典漏 grant 身份校验、004 映射覆盖稳定快照且未限定租户、006 JSONB 空值不对称；B 发布门禁尚无可执行强制入口。裁决 **REWORK**，窗口 4 双实例恢复与窗口 5 全量回归 HOLD。证据 43/43、冻结 29/29；`git diff --check` 因 schema.prisma 行尾空格非零。§0/§4 不变，未提交/未部署。

> **2026-09-27 R12 最新增量**：窗口 1 的 14 链补证限定复审见 [P3-FIXTURE-14CHAIN-R12_REVIEW.md](../../../AI_review/Codex-GPT6/P3-FIXTURE-14CHAIN-R12_REVIEW.md)，仅窗口 3 的新 prompt 见 [P3-NEXT_RELAY_R12_PROMPT.md](P3-NEXT_RELAY_R12_PROMPT.md)。窗口 1 新实例 10 入口 rc=0/0 skip，证据 88/88 只读复验，已明文停止；窗口 3 可独占生命周期 A/B。锁的聚合 digest `4e8595bb…` 与产品 `migrationChainDigest()` 的 `88a2ba45…` 不相等，须分别标注，不能以锁值验产品台账；逐文件 14/14 成立。窗口 4/5 的动态阶段仍等待接力。§0/§4 不变，未提交/未部署。

> **2026-09-27 R11 最新增量**：限定复审见 [P3-PARALLEL-R11_REVIEW.md](../../../AI_review/Codex-GPT6/P3-PARALLEL-R11_REVIEW.md)，两段接力 prompt 见 [P3-NEXT_RELAY_R11_PROMPTS.md](P3-NEXT_RELAY_R11_PROMPTS.md)。公共链 follow-up 14 文件、digest `4e8595bb…` 已锁并停止；前向 FK 修复、失效索引负例、R6d A/B 口径与认证离线替身限定范围通过，独立复核 14/14 SHA、证据 110/110、unit 28/285 rc=0。旧 R6 harness rc=1（链尾租户假设）保留。现在先窗口 1 在新链补证并停止，再窗口 3 独占生命周期 A/B；窗口 4 双实例与窗口 5 全量依旧排队。**无需再同时发五个实施 prompt**。§0/§4 不变，未提交/未部署。

> **2026-09-27 R10 并发执行补充裁决**：见 [P3-R10_CONCURRENT_EXECUTION_REVIEW.md](../../../AI_review/Codex-GPT6/P3-R10_CONCURRENT_EXECUTION_REVIEW.md)，原窗口补充指令见 [P3-R10_CONCURRENT_CORRECTION_PROMPTS.md](P3-R10_CONCURRENT_CORRECTION_PROMPTS.md)。五任务同发未见共享 migration/client 越门禁编辑：fixture 已在 13 链完成动态并停止；公共链 follow-up 尚未入链/未终验；生命周期仅准备、W3 仅来源注册与 PG 原子性、CLOSE-B 仅入口核对。当前独立复核 isolation 68/68，认证离线两文件 10 fail/2 pass（旧 Prisma 替身缺新 catalog 形状）；须补替身并在公共链新尾锁定后重跑链依赖定点。R10 prompt 的 live-api/学校 B/report-auth fixture 顺序错误，以 fixture R2 `RESULT §3` 更正。§0/§4 不变；本条为在途裁决，非公共链 follow-up 完成裁决。

> **2026-09-26 R10 最新增量**：完整裁决见 [P3-PARALLEL-R10_REVIEW.md](../../../AI_review/Codex-GPT6/P3-PARALLEL-R10_REVIEW.md)，五窗口可复制 prompt 见 [P3-NEXT_WAVE_R10_PROMPTS.md](P3-NEXT_WAVE_R10_PROMPTS.md)。公共链 13 文件已落地并停止，限定范围 PASS，但旧 R6d harness 实测 rc=1、历史 FieldOption FK 守卫与索引可用性待补证；fixture Phase 1 静态通过，但旧 `REVOKED_TOKENS_DDL` 提取实测 `E_REVOCATION_DDL_SOURCE`，先修后跑动态。LIFECYCLE 仅准备、W3 注册来源允许 `external:unknown` 须返工、CLOSE-B 仅 AUD-040 离线通过。接力：fixture 动态→公共链 follow-up→生命周期 A/B→双实例恢复→单实例全量回归。§0/§4 不变，未提交/未部署。

> **2026-09-26 R9 最新增量**：完整裁决见 [P3-PARALLEL-R9_REVIEW.md](../../../AI_review/Codex-GPT6/P3-PARALLEL-R9_REVIEW.md)，下一轮五窗口完整 prompt 见 [P3-NEXT_WAVE_R9_PROMPTS.md](P3-NEXT_WAVE_R9_PROMPTS.md)。W2-T02-R6 的 R8 四项定点返工 **PASS_LOCAL_SCOPE**，但锁表/吊销表未入链且运行时 DDL 未撤，RC-04 未关闭；DB-FIXTURE-R2 真实业务表隔离正例 **PASS_LOCAL**；LIFECYCLE-DESIGN-R5 方向可用，但 username-only 不能证明历史主体身份，实施须保守拒绝；W3-CROSS-PLAN-R4 **PASS_PLAN**，跨实例 BackupRun 产品注册仍缺；HARNESS-CHECK-R1 **PASS_STATIC/DYNAMIC_HOLD**，T02C/report-auth fixture 的 db push 与 migration-first 冲突。五窗按公共链→fixture 动态→生命周期 A/B→W3 真恢复→CLOSE-B 全量接力；§0/§4 不变，未提交/未部署。

> **2026-09-26 R8 最新增量**：完整裁决见 [P3-PARALLEL-R8_REVIEW.md](../../../AI_review/Codex-GPT6/P3-PARALLEL-R8_REVIEW.md)，五窗口原文见 [P3-NEXT_WAVE_R8_PROMPTS.md](P3-NEXT_WAVE_R8_PROMPTS.md)。W2-T02-R5 的 R7 指定反例通过，但空台账初始化 DDL、通用失败台账写入未受 guard 覆盖，人工清锁与在飞 SQL 探测非原子，baseline 提交后 failed 标记失败缺持久阻断证明，故 **REWORK**；DB-FIXTURE-R1 迁址 **PASS_LOCAL**、业务表隔离正例待补；LIFECYCLE-DESIGN-R4 与 W3-CROSS-PLAN-R3 仍 **DESIGN/PLAN_REWORK + 实施 HOLD**；DEPLOY-DOC-R3 为 R7 时点文档通过、现行清锁命令待同步。W1/LIFECYCLE 正式迁移、W3 真实恢复联测、CLOSE-B 全量回归均**未获实施信号**。§0/§4 不变；下方旧“当前”均为历史时点。

> **2026-09-26 R7 最新增量**：完整裁决见 [P3-PARALLEL-R7_REVIEW.md](../../../AI_review/Codex-GPT6/P3-PARALLEL-R7_REVIEW.md)，五窗口原文见 [P3-NEXT_WAVE_R7_PROMPTS.md](P3-NEXT_WAVE_R7_PROMPTS.md)。W2-T02-R4 的 R6 直接反例已实测，但父进程死亡而 psql/PG 仍运行、人工清锁 CAS、baseline 提交后失败仍是 RC-04 放行缺口，裁决 **REWORK**；W1-R1-PLAN-R3 **PASS_PLAN/实施 HOLD**；LIFECYCLE-DESIGN-R3 与 W3-CROSS-PLAN-R2 **PLAN_REWORK/实施 HOLD**；CLOSE-B-PLAN-R2 的 fixture extra-object 冲突 **PASS_READONLY_FINDING/实施 HOLD**。W2-R5 与专用测试 fixture 迁址可并行于各自独占面，W1/LIFECYCLE 正式 migration、W3 真实联测、CLOSE-B 全量回归仍无实施信号。§0/§4 不变，下文旧“当前”保持历史时点。

> **2026-09-26 R6 最新增量**：完整裁决见 [P3-PARALLEL-R6_REVIEW.md](../../../AI_review/Codex-GPT6/P3-PARALLEL-R6_REVIEW.md)，下一轮五窗口原文见 [P3-NEXT_WAVE_R6_PROMPTS.md](P3-NEXT_WAVE_R6_PROMPTS.md)。W2-T02-R3 REWORK（无证明 attestation 放流量、分类/未知对象只挡 readyz、锁过期并行、baseline 非原子）；W2-T01-R2-DOC 限定文档 PASS，当前 README 随 R3 已过时；LIFECYCLE-R2-DESIGN 与 W1-R1-PLAN-R2 仍设计返工/HOLD；W3-R2-CROSS 只读事实通过但计划返工，联测 HOLD。W2-R4 复审前不发 W1/LIFECYCLE 正式 migration、W3 真实联测或 CLOSE-B 实施信号。§0/§4 不变，下文旧“当前”保持历史时点。

> **2026-09-26 R5 最新增量**：完整裁决见 [P3-PARALLEL-R5_REVIEW.md](../../../AI_review/Codex-GPT6/P3-PARALLEL-R5_REVIEW.md)，下一轮五窗任务见 [P3-NEXT_WAVE_R5_PROMPTS.md](P3-NEXT_WAVE_R5_PROMPTS.md)。W2-T02-R2 REWORK（off 放流量、自动 baseline、检查错误、并发、重建/投影）；W2-T01-R2 deploy 失败分支 PASS_LOCAL；W3-R2 ACL grant option PASS_LOCAL，跨包恢复联测待做；W1-R1 只读准备 PASS，auth migration 实施 HOLD；LIFECYCLE-R2 只读准备 PASS，enforcement 设计 REWORK、实施 HOLD。CLOSE-B 不启动。下文 R4/更早时点段落保留历史事实；§0/§4 不变。

> **2026-09-26 R4 最新增量**：完整裁决见 [P3-PARALLEL-R4_REVIEW.md](../../../AI_review/Codex-GPT6/P3-PARALLEL-R4_REVIEW.md)，下一轮五窗口原文见 [P3-NEXT_WAVE_R4_PROMPTS.md](P3-NEXT_WAVE_R4_PROMPTS.md)。W2-T02-R1 REWORK（逐租户版本/未知漂移/全局闸门/凭据错误路径）；W5-RECORD-R1 PASS_LOCAL；LIFECYCLE-R1 PASS_DESIGN 但实施 HOLD；PRIOR-THREE-FACTS PASS_FACTS；CLOSE-B 盘点 PASS_READONLY 但实施 HOLD。旧三包补充限定：W1-T01 RC-02 定点 PASS_LOCAL、RC-04 运行时 DDL 返工；W3-R1 grant option 差异返工；W2-T01-R1 自动 resolve/db push 返工。CLOSE-B **未发启动信号**。下文 §2/§7 的旧“当前”与排队状态保留历史快照；§0/§4 不变。

- 维护：总控审阅线（GPT Astra 系 → 2026-09-25 起 Kimi-K3 接续）。更新：2026-09-25。
- **用途**：Codex 额度恢复后，GPT 凭本文件 + 下列索引**无需重新全仓审计**即可接续总控审阅。每轮审阅的完整裁决见各 `*_REVIEW.md`（本文件是索引+要点+规则，不替代原文）。
- 性质：总控只读复核记录；未 commit/stage/push 任何修复；未代跑测试/PG；未查看真实凭据。

## 0. 全局不变量（任何续审先核）

| 项 | 值 |
|---|---|
| 审计基线 SHA | `f08e72e3e74d188b4555e0bee16280b3dd0d622b` |
| 当前 HEAD（所有任务开始=结束） | `7343a8a9f8fc28b7ef2a6bad2b22c701b2fbf9e7`，branch `Product_tencent_CVM` |
| 工作树 | **故意未提交**（大量修改+新增）；任何任务不得 reset/clean/stash/checkout |
| 冻结 29 文件 | `AUDIT_EVIDENCE_MANIFEST.json`，SHA-256 `4f9c8d4cc16e99c5951a0153098af0e5e79a890d60004663d6df59473edbd8da`；只读校验器 `evidence/P3-W0-T01/rework2/verify-frozen-readonly.mjs`（**勿运行**旧 PF `manifest-verify.mjs`，有固定输出副作用） |
| Phase 2 裁决 | 21 P1 + 28 P2 冻结；三个餐具 delta（C02/C03/C04）登记观察不并入 |
| 门禁唯一事实源 | `tests/helpers/db-isolation.cjs`；唯一配置 `TEST_DATABASE_URL`+`TEST_DB_CONTEXT_FILE`，缺配置→非零拒绝不 skip；`REVIEW_TEST_DATABASE_URL` 已废弃（`T02C_LEGACY_DISABLED`） |
| 最终入口矩阵 | `P3-W0-AUD039_FINAL_ENTRYPOINT_MATRIX.md`（AUD-039 关闭件） |
| 当前测试基线 | root Jest **270/268/2/0**（历史 2 项=`tests/authSession.test.js` 断言行 259/294，0 skip）；backend node:test **310/310/0/0**（29 文件逐入口）；PG integration **23/23**；isolation **68/68**；backend 差值 251→310 = +23W3 +23W4 +13W5 |
| 部署状态 | 全部"本地验收"；未提交/未部署/未现网验证 |

## 1. 续审读序（冷启动）

1. 本文件（总账）
2. `ORCHESTRATOR_STATE.md`（当前状态表）
3. 当前在跑任务的任务包 + 其 `*_REVIEW_INPUT_MANIFEST.json`（快照）
4. 对应轮次的 `*_REVIEW.md`（历史裁决）
5. 需要细节时再进 `evidence/<task>/`（RESULT/COMMANDS/TEST_RESULTS/HASHES_FINAL + logs）
6. Phase 2 背景仅定点查：`../phase2/REMEDIATION_DEPENDENCY_GRAPH.md`、`ROOT_CAUSE_MATRIX.md`、`FINAL_SEVERITY_ARBITRATION.md`

## 2. 任务总账（按时间序；✅=复审 PASS，🔄=在跑，⏳=排队）

### Wave 0（AUD-044 + AUD-039）— 全部 ✅
| 任务 | 内容 | 复审 | 证据 |
|---|---|---|---|
| P3-PF-T01(+R1/R2) | Preflight | ✅（GPT 线，见各 REVIEW） | evidence/P3-PF-T01/ |
| P3-W0-T01(+R1…R4) | AUD-044 JWT 部署密钥 | ✅ | evidence/P3-W0-T01/（含只读 frozen 校验器 rework2/） |
| P3-W0-T02A(+R1…R4) | AUD-039 门禁+provisioner+两 integration 套件 | ✅ | evidence/P3-W0-T02A/ |
| P3-W0-T02B(+R1/R2) | root Jest+p0 接入；观测归属 token 化、收尾真实 rc、同实例链 | ✅（R2_REVIEW 有逐 PID 观测独立重验记录） | evidence/P3-W0-T02B/{,rework1/,rework2/} |
| P3-W0-T02C | backend 旧入口+live-api 接入薄桥接 | ✅（+61 归因更正：190+4+57） | evidence/P3-W0-T02C/ |
| P3-W0-T02D | AUD-039 关闭件（最终入口矩阵+更正索引） | ✅ → **AUD-039 = REVIEWED_PASS_LOCAL** | evidence/P3-W0-T02D/ |

### 并行轮次 1（W3/W4/W5 首包）— 全部 ✅（`P3-PARALLEL-R1_REVIEW.md`）
| 任务 | 修复 | 复审要点（独立核验记录见原文） |
|---|---|---|
| P3-W3-T01 | AUD-004/005/006/007+NF-B-02 备份恢复状态机 | 输入 616 零越权；hash 54/54；rc 全 0；restoreSqlUtils 越权自查还原 0 diff 实测；并发锁/撞名/快照/命名四组证据在案 |
| P3-W4-T01 | AUD-001/021/022 客户端同步 | hash 37/37；recordRoutes 行区实测（7 hunks≥480）；23 新用例+23 路由回归全绿；遗留 5 旧键直读+4 旧契约测试→CONS |
| P3-W5-T01 | AUD-003/025 输出编码+结论归一 | hash 30/30；行区 3 hunks≤300；实测 normalizeConclusion（未知非空一律 unknown）；申报 1 冲突+U1 均由总控裁决转 CONS |

### 并行轮次 2（收口+回归 / live-api / W2）— 全部 ✅（`P3-PARALLEL-R2_REVIEW.md`）
| 任务 | 结果 | 关键裁决 |
|---|---|---|
| P3-CONS-T01 | 4 组收口编辑 + **全量回归锁新基线**（root 270/268/2/0、backend 310/310/0/0 29 文件逐入口、integration 23/23、isolation 68/68） | hash 196/196；44 项 rc 落盘核对；DEFECT-1 登记 |
| P3-W0-T02E | live-api **49/49 全绿**（显式数据契约，零生产放宽） | after-check 10/10；三可挑战点复核通过 |
| P3-W2-T01 | AUD-008 补丁 migration 入链（空库/旧库回放闭合）+db:sync 三态退出码 | hash 35/35；**闸门段未执行**（见 §4 编排缺口） |

### 当前在跑（🔄，2026-09-25 发放，尚未返回）
| 任务 | 内容 | 快照 | 特殊约束 |
|---|---|---|---|
| P3-W1-T01 | **RC-02 会话模型一次重构**（AUD-010/012/014/015/016）+ server.js 写屏障挂载 | 952 项 | **独占 auth 六文件**（middleware/authMiddleware.js、modules/UserManager.js、routes/userRoutes|schoolRoutes.js、server.js、tests/authSession.test.js）；只跑定点；禁全套件 |
| P3-W3-R1 | DEFECT-1 根修：restore 切换后重放租户授权 | 952 项 | **禁全套件**（backend 全量会 import W1 编辑中的 auth 面） |
| P3-W2-T01-R1 | deploy.sh 闸门后段（函数化+failed 记录+移除 accept-data-loss） | 952 项 | 沙盒+定点 only，零真实部署 |

### 排队（⏳）
AUD-002/020（recordRoutes 写路径幂等+读路径分页）、AUD-017（报告授权）、AUD-040（npm test unit/db 拆分，jest 配置排最后）、W2-T02（AUTO_SYNC/启动自愈 server.js 侧，排 W1 后）、**W1 后统一全套件回归轮**（复证 310 基线+DEFECT-1 修复+W1 新语义）、最终统一提交+部署+现网验证。

## 3. 已修复 issue 状态（23 P1 口径）

已修复并复审 ✅：AUD-044、039（W0）｜004、005、006、007（W3）｜001、021、022（W4）｜003、025（W5）｜008（W2-T01，009 部分）＝**12 项**。
在跑 🔄：010、012、014、015、016（W1）。
排队 ⏳：002、020、017（W5 尾）、009 余量（W2-T02）、027/047（依 W2 纪律，027 需保留策略裁决）、040（P2 流程项）。
（027/047 属 P2 侧 W2 范围，未列入 23 P1 计数。）

## 4. 总控裁决备忘（续审不得推翻，除非新证据）

1. **未知非空 colorLevel 一律 unknown**（不回退 result）——`backend/lib/conclusionVerdict.js` 为唯一事实源；`contract.test.mjs:185-186` 已按此反转（原断言是 AUD-025 fail-open 残留）。
2. **DEFECT-1 选选项①**：恢复引擎切换后按基线重放租户授权（W3-R1 执行中）；过渡态=两段式 runner + fixture 链顺序契约 `t02b→root→integration→t02c→w3→backend`。
3. **W3 写屏障挂载并入 W1**（server.js 是其修改面）；全局 READONLY_MODE 兜底保留。
4. **live-api 数据契约**：super-admin/login 是生产专用路由（旧 public 无 schoolCode 路径被 400/401 负例固化）；harness 的 `AUTO_SYNC_TENANTS=false` 仅 spawn env。
5. **test:backend 系修改既有失效脚本**（`jest backend/**/*.test.js`→`node --test …`），非纯新增（T02D 更正索引在案）。
6. **编排缺口登记**：`REGRESSION_DONE` 类协调标记必须在发包**双方**明文（W2 空等 1h20m 的教训）；`add()` 式去重守卫会吞掉兄弟包政策覆盖（快照生成教训）。
7. 餐具 delta C02/C03/C04 与 root 历史 2 项失败维持登记；`tablewareVerdict.js` 禁碰。

## 5. 协作规则（对 CodeBuddy 窗口恒定有效）

- 交付 = 工作区改动 + 证据目录（RESULT/COMMANDS/TEST_RESULTS/HASHES_FINAL + logs + rc 落盘）；默认不 commit/stage/push。
- 输入快照逐项只读核验；**PROTECTED 漂移=越权**；兄弟包 drift 用 `PARALLEL_OTHER_PACKET_SCOPE_DO_NOT_TOUCH` 豁免（并行轮）；未知 drift 先报告。
- HASHES_FINAL 必须先写完报告再生成、排除自身、至少两次只读复验；禁跑旧 PF `manifest-verify.mjs`；不读真实 `.env`、不连业务库、凭据零落盘。
- probe 契约：bug-exists probe 保留场景、另建正式 regression 反转断言、注释溯源，不删原 probe 不改断言凑数。
- 计数纪律：任何 suite 计数变化必须给出逐项归因对账（如 190+4+57=251、251+23+23+13=310），禁止"反正通过"式放行；分栏 baseline known/preexisting/new/skips。
- 同一工作树并行上限=互不可见文件面；全量回归同一时刻只能一个窗口跑。

## 6. 复审方法备忘（Kimi-K3 线已验证有效）

- 输入快照：node 脚本全量复算 sha256 比对 policy（附：changed 集合三包交叉一致性核对）。
- 输出 hash：按各包实际结构（files 对象/entries 数组/嵌套 {path,sha256}）解析后独立复算。
- 追加类改动：manifest bytes 前缀 hash 比对证"仅追加"。
- 行区共享文件：`git diff -U0` hunk 行号逐一分配核对（W4/W5 recordRoutes 案：10 hunks 全部落入声明区、缓冲零改动、外来标记 0）。
- 语义抽测：直接 require 新模块跑输入输出（normalizeConclusion 案）；`node --check` 共享文件语法。
- 资源：lsof/pgrep 实测端口与进程无残留；rc 文件逐字读数。

## 7. 2026-09-25 接续增量（以本节覆盖 §2 的旧“当前在跑/排队”时态）

跨模型单文件入口：[REVIEW_CONTINUITY_HANDOFF.md](../../../AI_review/REVIEW_CONTINUITY_HANDOFF.md)。Codex 接续后的五包限定复审原文：[P3-PARALLEL-R3_REVIEW.md](../../../AI_review/Codex-GPT6/P3-PARALLEL-R3_REVIEW.md)；可转发的下一轮任务：[P3-NEXT_WAVE_PROMPTS.md](P3-NEXT_WAVE_PROMPTS.md)。本增量不改 §0 全局不变量和 §4 裁决备忘；§0 中 270/310 是旧基线，不能当成本轮运行结果。

| 包 | 当前总控裁决 |
|---|---|
| P3-CLOSE-T01 阶段 A | PASS；阶段 B AUD-040/全量回归未执行 |
| P3-W2-T02 | REWORK：RC-04 启动只检测、readiness/能力阻断、disabled 覆盖；旧证据两份隔离凭据文件须更正 |
| P3-W5-RECORD-T01 | REWORK：同路由模板不同具体记录的幂等碰撞；浏览器 2000 行截断仍称权威全量 |
| P3-W5-REPORT-AUTH-T01 | PASS_LOCAL（AUD-017 本地范围），待统一回归 |
| P3-W2-LIFECYCLE-T01 阶段一 | DESIGN_REWORK；仅只读设计交付，未实施 |
| P3-W1-T01 / P3-W3-R1 / P3-W2-T01-R1 | 执行回执已返回，**尚缺本接续总控独立复审**；旧 §2 的“在跑”已过时 |

下一轮可并行 W2-T02-R1 与 W5-RECORD-T01-R1；LIFECYCLE 先修设计，schema/client/PG 等 W2-R1 停止；窗口 4 只读整理旧三包事实，可并行，但不代替总控裁决；窗口 5（CLOSE 阶段 B）最后独占全量回归。先前五窗 prompt 对 `AUTO_SYNC_TENANTS=true` 启动 apply 的容忍与冻结 Phase 2 RC-04 冲突，已在 R3 原文更正，不视为推翻 §4。所有裁决仍为本地范围，未 commit/部署/现网验证。

*（本总账随每轮复审追加；各轮细节以对应 `*_REVIEW.md` 原文为准。）*
