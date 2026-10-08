# 全局审计审阅接续入口（Codex → Kimi-K3 → Codex）

更新：2026-09-28（R19）。本文件是**跨模型入口与索引**，不是取代各轮原始 `*_REVIEW.md` 的新裁决。用户以后切换模型，只需先给此文件路径和新的执行结果；新模型再按下述读序进入对应证据。这里的“审阅 PASS”与 CodeBuddy 自报 `PASS_LOCAL` 严格区分。

审阅记录按模型放在本目录的 `GPT6-Astra/`（早期 15 份）、`Kimi-K3/`（中段 5 份）、`Codex-GPT6/`（当前 18 份，含并发补充裁决）。当前 Codex 记录可确认属于 GPT-6 系，但原记录没有可核实的 Astra 子型号署名，因此单列，避免误标。旧 `phase3/` 路径保留**字节一致的兼容副本**，供历史任务包和已启动窗口的输入快照核对；新分类文件中的裁决文字不变，仅将 Markdown 相对链接改为新位置。[ORGANIZATION_MAP.json](ORGANIZATION_MAP.json) 记录早期 21 份旧/新路径及移动前后 SHA-256；R4–R19 及并发补充裁决在新目录直接创建。下方旧轮次状态表保留历史时点，**最新以 R19 增量为准**。

## 最新增量：R19 CLOSE-B-R4 全量回归限定复审

先读 [P3-CLOSE-B-R19_REVIEW.md](Codex-GPT6/P3-CLOSE-B-R19_REVIEW.md)。单实例全量测试绿链成立（backend 460/460、0 skip、readyz/API 200），但 R4 证据文件写入管理 URL 与备份主密钥明文，故证据保密性需返工；先脱敏并更新 runner/HASHES。B-7b helper 窄环境仍需修，真实发布两段接线、授权与回退均未验收。总审阅记录 **38 份：Astra 15、K3 5、Codex-GPT6 18**。

## 最新增量：R18 三包合同限定复审

先读 [P3-R18_CONTRACTS_REVIEW.md](Codex-GPT6/P3-R18_CONTRACTS_REVIEW.md)，给原窗口 5 的单份任务见 [P3-NEXT_RELAY_R18_PROMPT.md](../reviews/global-audit-20260924/phase3/P3-NEXT_RELAY_R18_PROMPT.md)。F/L/P 三窗已停止，B-1…B-6 限定定点通过，004 真实双会话补证 8/8；证据复验 84/84、24/24、38/38。R17 旧 fixture 顺序错误，以 **T02B→T02E→root DB→live-api→后续** 为准。B-7 W3REG env 仍需原窗口 5 的新 R4 runner 修；现在发独占单实例全量复跑信号，当前尚无全量 PASS。发布/真实部署 HOLD。总审阅记录 **37 份：Astra 15、K3 5、Codex-GPT6 17**。

## 最新增量：R17 窗口 5 全量红链限定复审

先读 [P3-CLOSE-B-R17_REVIEW.md](Codex-GPT6/P3-CLOSE-B-R17_REVIEW.md)；三项独占定点返工与最后全量复跑的 prompt 见 [P3-NEXT_RELAY_R17_PROMPTS.md](../reviews/global-audit-20260924/phase3/P3-NEXT_RELAY_R17_PROMPTS.md)。入口漏收录已修并独立核对 24/24，但单实例全量仍红：backend 390/415、25 fail，root/live-api/report-auth/session 亦红。R3 清单 85+9+6 全部匹配、冻结 29/29。六类红因中两项需更正：live-api 的 DELETE 已 200，保留的是软删墓碑；链旧断言实际 6 项/5 文件。另有独立 runner 缺口：W3REG 管理 URL 未接线，不能全归 fixture 失败。先并行修三个互不抢文件的测试合同，再由 CLOSE-B 新实例全量复跑。发布/真实部署仍 HOLD。总审阅记录 **36 份：Astra 15、K3 5、Codex-GPT6 16**。

## 历史增量：R16 生命周期 R6 与双实例恢复限定复审

先读 [P3-R16_LIFECYCLE_CROSS_REVIEW.md](Codex-GPT6/P3-R16_LIFECYCLE_CROSS_REVIEW.md)；下一棒单份可复制 prompt 见 [P3-NEXT_RELAY_R16_PROMPT.md](../reviews/global-audit-20260924/phase3/P3-NEXT_RELAY_R16_PROMPT.md)。窗口 3 的 004 绑定点 `pre` 同源判据与逐行事务、窗口 4 的真实跨实例恢复均在已测范围 **PASS_LOCAL_SCOPE**；窗口 3 第二交错为同事务注入，窗口 4 的 C6c 为非终态注入且序列 USAGE N/A。独立复验 56/56、156/156、冻结 29/29，当前 unit 28/286 全绿。当前 `test:entry-audit` **G3 rc=1**（新 CJS 测试漏收录），窗口 5 先修入口审计，再独占单实例跑全量；发布/真实部署仍 HOLD。总审阅记录 **35 份：Astra 15、K3 5、Codex-GPT6 15**。

## 最新增量：R15 生命周期 R5 限定复审与分流接力

先读 [P3-LIFECYCLE-AB-R15_REVIEW.md](Codex-GPT6/P3-LIFECYCLE-AB-R15_REVIEW.md)；两个可复制 prompt 见 [P3-NEXT_RELAY_R15_PROMPTS.md](../reviews/global-audit-20260924/phase3/P3-NEXT_RELAY_R15_PROMPTS.md)。R5 的 M2 空快照单次回放与 004 必填 pre/已绑定主体核对在已测范围通过；但 004 预校验后重新读行，UPDATE 只比对新读值，仍可在两次读取之间把旧映射绑到已变化的 username-only 快照，且先建主体后发现 UPDATE 0 行可能留孤儿。裁决：004 并发路径限定 REWORK；当前 16 文件链作为窗口 4 固定输入，**窗口 4 双实例恢复可启动，但不得调用 004 映射**，可与窗口 3 的独占脚本 R6 并行；窗口 5 全量回归仍 HOLD。总审阅记录 **34 份：Astra 15、K3 5、Codex-GPT6 14**。

## 历史增量：R14 生命周期 A/B 限定返工复审

先读 [P3-LIFECYCLE-AB-R14_REVIEW.md](Codex-GPT6/P3-LIFECYCLE-AB-R14_REVIEW.md)；窗口 3 的可复制限定 R5 prompt 见 [P3-NEXT_RELAY_R14_PROMPT.md](../reviews/global-audit-20260924/phase3/P3-NEXT_RELAY_R14_PROMPT.md)。R13-1 管理端守门与 R13-3 的 006 判据、R13-4 的发布函数级沙盒在各自范围内通过；004 的行级前置事实可省且已绑定行不核映射主体，M2 P-4 只认 SQL NULL 而 006 也把 JSONB null/空对象视为空，故裁决 **REWORK**。窗口 4 双实例真实恢复、窗口 5 全量回归继续 HOLD；真实部署门禁另待发布侧验收。总审阅记录 **33 份：Astra 15、K3 5、Codex-GPT6 13**。

## 历史增量：R13 生命周期 A/B 限定复审

先读 [P3-LIFECYCLE-AB-R13_REVIEW.md](Codex-GPT6/P3-LIFECYCLE-AB-R13_REVIEW.md)；窗口 3 限定返工 prompt 见 [P3-NEXT_RELAY_R13_PROMPT.md](../reviews/global-audit-20260924/phase3/P3-NEXT_RELAY_R13_PROMPT.md)。窗口 3 的 A/B 数据与客户端定点有可保留证据，但管理员 `preview/dict` 未执行 grant 身份校验、004 映射可覆盖稳定快照且跨租户同 ID 误用、006 空快照判据不对称；B 发布门禁仍是流程约定。裁决 **REWORK**，窗口 4 双实例真实恢复与窗口 5 全量回归继续 HOLD。总审阅记录 **32 份：Astra 15、K3 5、Codex-GPT6 12**。

## 历史增量：R12 窗口 1 的 14 链补证

先读 [P3-FIXTURE-14CHAIN-R12_REVIEW.md](Codex-GPT6/P3-FIXTURE-14CHAIN-R12_REVIEW.md)；给窗口 3 的单份可复制 prompt 见 [P3-NEXT_RELAY_R12_PROMPT.md](../reviews/global-audit-20260924/phase3/P3-NEXT_RELAY_R12_PROMPT.md)。窗口 1 在新实例完成 14 链定点并明文停止，限定 **PASS_LOCAL_SCOPE**；证据 88/88 复验。锁内聚合 digest `4e8595bb…` 与产品运行时 `88a2ba45…` 不相等，故以后分别标注，不把前者用作产品台账预期；14/14 逐文件内容锁仍成立。现在仅窗口 3 独占生命周期 A/B，窗口 4/5 的动态阶段继续按接力门禁等待。总审阅记录 **31 份：Astra 15、K3 5、Codex-GPT6 11**。

## 历史增量：R11 总控限定复审

先读 [P3-PARALLEL-R11_REVIEW.md](Codex-GPT6/P3-PARALLEL-R11_REVIEW.md)；两段接力 prompt 见 [P3-NEXT_RELAY_R11_PROMPTS.md](../reviews/global-audit-20260924/phase3/P3-NEXT_RELAY_R11_PROMPTS.md)。公共链 follow-up 14 文件/digest `4e8595bb…` 已锁并停止，前向 FK 修复、索引有效性及离线认证替身限定范围通过；独立重算 14/14、证据 110/110，当前 unit 独立复跑 **28/285 全绿**。先给窗口 1 新链补证，再给窗口 3 独占生命周期 A/B；窗口 4 双实例恢复与窗口 5 全量回归按原门禁等待。无需重新同时发五个实施任务。总审阅记录 **30 份：Astra 15、K3 5、Codex-GPT6 10**。

## 历史增量：R10 并发执行补充裁决

先读 [P3-R10_CONCURRENT_EXECUTION_REVIEW.md](Codex-GPT6/P3-R10_CONCURRENT_EXECUTION_REVIEW.md)；给原窗口的补充指令见 [P3-R10_CONCURRENT_CORRECTION_PROMPTS.md](../reviews/global-audit-20260924/phase3/P3-R10_CONCURRENT_CORRECTION_PROMPTS.md)。五窗同时发放未造成已知共享链并行编辑：窗口 1 已在 13 文件链上停止并交动态定点，窗口 2 在其停止前只做链外候选与独占代码，尚无新 migration；窗口 3/4/5 依赖动态阶段均维持 HOLD。窗口 1 的绿灯不代表窗口 2 最终新链；当前 isolation 复核 68/68 已绿，认证离线两套件仍 10 fail/2 pass，需补测试替身。按新链尾 hash 补跑链依赖定点后再让生命周期动 schema/client。总审阅记录 **29 份：Astra 15、K3 5、Codex-GPT6 9**；本补充记录为在途裁决，窗口 2 最终仍待审。

## 历史增量：R10 总控复审

先读 [P3-PARALLEL-R10_REVIEW.md](Codex-GPT6/P3-PARALLEL-R10_REVIEW.md)；五个可复制的下一轮任务原文见 [P3-NEXT_WAVE_R10_PROMPTS.md](../reviews/global-audit-20260924/phase3/P3-NEXT_WAVE_R10_PROMPTS.md)。本轮审公共基础设施链、迁移先行 fixture、生命周期 A/B 准备、外部备份注册、AUD-040 入口。独立静态复现 fixture 对已删除 `REVOKED_TOKENS_DDL` 的依赖导致 `E_REVOCATION_DDL_SOURCE`；公共链 13 文件已锁且停止，可立即由 fixture 窗口修接口并跑动态。外部注册的来源缺失仍可登记为 `external:unknown`，须返工。生命周期 A/B、W3 双实例恢复、最终全量回归仍依次 HOLD。总审阅记录 **28 份：Astra 15、K3 5、Codex-GPT6 8**。

## 历史增量：R9 总控复审

先读 [P3-PARALLEL-R9_REVIEW.md](Codex-GPT6/P3-PARALLEL-R9_REVIEW.md)；五个可复制的下一轮任务原文见 [P3-NEXT_WAVE_R9_PROMPTS.md](../reviews/global-audit-20260924/phase3/P3-NEXT_WAVE_R9_PROMPTS.md)。本轮审 W2-T02-R6、DB-FIXTURE-R2、LIFECYCLE-DESIGN-R5、W3-CROSS-PLAN-R4、HARNESS-CHECK-R1。总审阅记录 **27 份：Astra 15、K3 5、Codex-GPT6 7**。W2-R6 的定点返工通过，公共基础设施尚未版本化；两个 db-push fixture 阻断真实 harness；生命周期的 username-only 映射被总控改为保守拒绝；W3 缺跨实例 BackupRun 产品注册。下一轮按公共链→fixture→生命周期→恢复→全量回归接力，不把五窗并行编辑等同于并行跑迁移。

## 历史增量：R8 总控复审

先读 [P3-PARALLEL-R8_REVIEW.md](Codex-GPT6/P3-PARALLEL-R8_REVIEW.md)；下一轮五个可复制任务原文见 [P3-NEXT_WAVE_R8_PROMPTS.md](../reviews/global-audit-20260924/phase3/P3-NEXT_WAVE_R8_PROMPTS.md)。本轮审 W2-T02-R5、DB-FIXTURE-R1、LIFECYCLE-DESIGN-R4、W3-CROSS-PLAN-R3、DEPLOY-DOC-R3。总审阅记录 **26 份：Astra 15、K3 5、Codex-GPT6 6**。

| 包 | R8 总控裁决 |
|---|---|
| W2-T02-R5 | **REWORK**：边缘写批未受 guard 覆盖、人工清锁原子性与 baseline postcheck 持久阻断缺口。 |
| DB-FIXTURE-R1 | **PASS_LOCAL**：测试对象迁址完成；真实业务表隔离正例待补。 |
| LIFECYCLE-DESIGN-R4 | **DESIGN_REWORK / 实施 HOLD**：G2A、B client 发布时间和历史主体映射需修。 |
| W3-CROSS-PLAN-R3 | **PLAN_REWORK / 联测 HOLD**：可复用源与恢复目标须物理隔离。 |
| DEPLOY-DOC-R3 | **PASS_AS_OF_R7**：现行人工清锁命令已过时。 |

正式 migration、W3 真恢复、CLOSE-B 全量回归/部署仍 HOLD。

## 历史增量：R7 总控复审

先读 [P3-PARALLEL-R7_REVIEW.md](Codex-GPT6/P3-PARALLEL-R7_REVIEW.md)；下一轮五个可复制任务原文见 [P3-NEXT_WAVE_R7_PROMPTS.md](../reviews/global-audit-20260924/phase3/P3-NEXT_WAVE_R7_PROMPTS.md)。本轮审 W2-T02-R4、W1-R1-PLAN-R3、LIFECYCLE-DESIGN-R3、W3-CROSS-PLAN-R2、CLOSE-B-PLAN-R2。总审阅记录 **25 份：Astra 15、K3 5、Codex-GPT6 5**。

| 包 | R7 最新裁决 |
|---|---|
| W2-T02-R4 | **REWORK**：R6 四项直接反例有定点证据；父死/psql 仍活、清锁 CAS、baseline 提交后失败未闭合 |
| W1-R1-PLAN-R3 | **PASS_PLAN / 实施 HOLD**：`@scope: public` 协议对齐，运行时认证形状自检待实施 |
| LIFECYCLE-DESIGN-R3 | **DESIGN_REWORK / HOLD**：Release A/B 的 Prisma nullable→non-null 合同与 restore 实际 hook 未闭合 |
| W3-CROSS-PLAN-R2 | **PLAN_REWORK / 联测 HOLD**：修复失败 staging 不会被下一次恢复复用，CLI 无随机 staging 目标 |
| CLOSE-B-PLAN-R2 | **PASS_READONLY_FINDING / 实施 HOLD**：fixture 合成表与新 extra-object 闸门冲突；须专用 schema，不能复用哨兵 |

下一轮五窗分别为 W2-R5 引擎、测试 fixture 迁址、生命周期设计、W3 联测计划、部署文档校准。W1/LIFECYCLE 正式 migration、W3 真实联测、CLOSE-B 全量回归仍无实施信号。

## 历史增量：R6 总控复审

先读 [P3-PARALLEL-R6_REVIEW.md](Codex-GPT6/P3-PARALLEL-R6_REVIEW.md)；下一轮五个可复制任务原文见 [P3-NEXT_WAVE_R6_PROMPTS.md](../reviews/global-audit-20260924/phase3/P3-NEXT_WAVE_R6_PROMPTS.md)。本轮审 W2-T02-R3、W2-T01-R2-DOC、LIFECYCLE-R2-DESIGN、W1-R1-PLAN-R2、W3-R2-CROSS。总审阅记录 **24 份：Astra 15、K3 5、Codex-GPT6 4**。

| 包 | R6 最新裁决 |
|---|---|
| W2-T02-R3 | **REWORK**：裸 attestation 绕过、分类失败/public 未知对象放流量、长迁移锁过期接管、baseline 台账非原子 |
| W2-T01-R2-DOC | **PASS_DOC_AS_OF_R2**；现行运维说明待 R4 后同步 |
| LIFECYCLE-R2-DESIGN | **DESIGN_REWORK / HOLD**：系统主体方向可用，M1→回填→M2 无版本停点，恢复切换时序错误 |
| W1-R1-PLAN-R2 | **PLAN_REWORK / HOLD**：提案元数据与 W2 实际 `@scope` 协议不符，public 见证未落地 |
| W3-R2-CROSS | **PASS_READONLY_FACTS / PLAN_REWORK / HOLD**：C2/C3 仍期待 R3 已取消的自动 baseline |

只有 W2-R4 可立即编辑相关产品代码并跑隔离 PG；其余四窗做互不干扰的计划修订。W1/LIFECYCLE 正式 migration、W3 跨包恢复、CLOSE-B 全量回归仍无实施信号。

## 历史增量：R5 总控复审

先读 [P3-PARALLEL-R5_REVIEW.md](Codex-GPT6/P3-PARALLEL-R5_REVIEW.md)；下一轮五个完整任务文本见 [P3-NEXT_WAVE_R5_PROMPTS.md](../reviews/global-audit-20260924/phase3/P3-NEXT_WAVE_R5_PROMPTS.md)。此轮独立核验了 W2-T02-R2、W2-T01-R2、W3-R2、W1-R1 只读准备、LIFECYCLE-R2 只读准备的原始证据与源码。总审阅记录 **23 份：Astra 15、K3 5、Codex-GPT6 3**。

| 包 | R5 最新裁决 |
|---|---|
| W2-T02-R2 | **REWORK**：off 放流量、稀疏见证自动 baseline、public 检查错误、并发迁移、重建 CASCADE 与投影规则 |
| W2-T01-R2 | **PASS_LOCAL（deploy 失败分支）**；共享 README 旧语义待更正 |
| W3-R2 | **PASS_LOCAL（ACL grant option）**；恢复 × 新租户迁移引擎联测待做 |
| W1-R1 Phase A | **PASS_READONLY，实施 HOLD**；public-only auth migration 与租户回放分类未闭合 |
| LIFECYCLE-T01-R2 准备 | **PASS_READONLY，enforcement 设计 REWORK，实施 HOLD**；允许 NULL 白名单与全列 NOT NULL 矛盾 |

窗口 1（W2-R3）完成并经总控复审前，**不发 W1/LIFECYCLE 的 schema/代码实施信号，也不启动 CLOSE-B 全量回归**。R4/R3 历史结论保留；上述 R5 是当前覆盖状态。

## 历史增量：R4 总控复审

先读 [P3-PARALLEL-R4_REVIEW.md](Codex-GPT6/P3-PARALLEL-R4_REVIEW.md)，再读涉及任务的原始证据；下一轮五个可转发任务在 [P3-NEXT_WAVE_R4_PROMPTS.md](../reviews/global-audit-20260924/phase3/P3-NEXT_WAVE_R4_PROMPTS.md)。此轮完成五份新回执审阅及事实包指向的旧三包限定裁决。至此审阅记录共 **22 份：GPT6-Astra 15、Kimi-K3 5、Codex-GPT6 2**。

| 包 | R4 最新裁决 |
|---|---|
| P3-W2-T02-R1 | **REWORK**：逐租户迁移版本、未知漂移、全局失败能力闸门、凭据错误路径 |
| P3-W5-RECORD-T01-R1 | **PASS_LOCAL**：R3 两项返工闭合；全套件/浏览器 E2E 未做 |
| P3-W2-LIFECYCLE-T01-R1 | **PASS_DESIGN，实施 HOLD**：待 W2 迁移协议稳定 |
| P3-PRIOR-THREE-FACTS-T01 | **PASS_FACTS**：旧三包事实归因，不能代替裁决 |
| P3-CLOSE-T01 阶段 B 盘点 | **PASS_READONLY，实施 HOLD**：计划需清除旧 db push opt-in 前提 |
| P3-W1-T01 | **PASS_LOCAL（RC-02 定点），RC-04 交叉返工**：auth 运行时 DDL |
| P3-W3-R1 | **REWORK**：ACL grant option 差异被漏判 |
| P3-W2-T01-R1 | **REWORK**：migrate 失败后自动 resolve/db push |

CLOSE 阶段 A 与 REPORT-AUTH 的原 PASS_LOCAL 保持；未部署、未全套件复证。下一轮窗口 1/2/3 的独立代码面可先启动；窗口 4/5 先只读准备，待窗口 1 停止且迁移协议获总控确认后再实施。**CLOSE-B 未获启动信号。** 不得把执行者“窗口 3 可开始 schema”视为总控许可。

## 给接任模型的最短指令

> 请先读 `docs/AI_review/REVIEW_CONTINUITY_HANDOFF.md`，再按其“读序”读取 `REVIEW_LOG_MASTER.md` §0/§4、`ORCHESTRATOR_STATE.md` 的最新增量、最新 `P3-CLOSE-B-R19_REVIEW.md`、相关任务的原始证据。保持已冻结裁决与故意未提交工作树；只审我随后提供的新 CodeBuddy 结果，给出逐包裁决、证据与下一轮互不干扰的任务文本。不要把执行者自报当总控复审，也不要重新做 Phase 1/2 全仓审计。

## 权威读序与边界

1. 本文件先定位时间线与当前任务；随后依 [REVIEW_LOG_MASTER.md](../reviews/global-audit-20260924/phase3/REVIEW_LOG_MASTER.md) §1：读该总账（尤其 §0 全局不变量、§4 不得随意推翻的裁决），读 [ORCHESTRATOR_STATE.md](../reviews/global-audit-20260924/phase3/ORCHESTRATOR_STATE.md) **最新增量**，读新任务包/输入快照，读相应 `*_REVIEW.md`，必要时读 `docs/reviews/global-audit-20260924/phase3/evidence/<task>/` 原始日志/rc/源码。
2. Phase 2 的 21 P1 + 28 P2、RC 系列结构裁决以 [FINAL_SEVERITY_ARBITRATION.md](../reviews/global-audit-20260924/phase2/FINAL_SEVERITY_ARBITRATION.md)、[FINAL_ARCHITECTURE_DECISIONS.md](../reviews/global-audit-20260924/phase2/FINAL_ARCHITECTURE_DECISIONS.md) 为准；具体依赖/根因见 [REMEDIATION_DEPENDENCY_GRAPH.md](../reviews/global-audit-20260924/phase2/REMEDIATION_DEPENDENCY_GRAPH.md)、[ROOT_CAUSE_MATRIX.md](../reviews/global-audit-20260924/phase2/ROOT_CAUSE_MATRIX.md)。Phase 3 prompt 若与冻结裁决冲突，应记录并纠正 prompt，不能默默放宽 RC。
3. HEAD `7343a8a9f8fc28b7ef2a6bad2b22c701b2fbf9e7`、branch `Product_tencent_CVM`、index 空是最近核验事实；工作树有意含大量未提交兄弟窗口修改。不得 reset/clean/stash/checkout、不得未经任务授权 stage/commit/push/部署。冻结 29 的唯一只读核验器在 `docs/reviews/global-audit-20260924/phase3/evidence/P3-W0-T01/rework2/verify-frozen-readonly.mjs`；旧 PF verifier 有固定输出副作用。任何新结果须重新核对当时 HEAD/status/manifest，不能把此处事实永久沿用。
4. 历史总账中的 root Jest 270/268/2/0、backend 310/310/0/0 是 `P3-CONS-T01` 时点基线；后续包已改变测试与语义，最终全量回归尚未完成。不要以旧数字替代新逐文件计数。

## 审阅血缘：从最早 Codex 到现在

| 时段/审阅线 | 完整记录入口 | 已有裁决范围 |
|---|---|---|
| Phase 1 原始审计 | [ISSUE_INVENTORY.md](../reviews/global-audit-20260924/ISSUE_INVENTORY.md)、[VERIFICATION.md](../reviews/global-audit-20260924/VERIFICATION.md) | 问题盘点与复核事实；以 Phase 2 最终严重度与架构裁决为冻结汇总。 |
| Phase 2 交叉裁决 | [PHASE2_MASTER_VERDICT.md](../reviews/global-audit-20260924/phase2/PHASE2_MASTER_VERDICT.md)、[FINAL_SEVERITY_ARBITRATION.md](../reviews/global-audit-20260924/phase2/FINAL_SEVERITY_ARBITRATION.md)、[FINAL_ARCHITECTURE_DECISIONS.md](../reviews/global-audit-20260924/phase2/FINAL_ARCHITECTURE_DECISIONS.md)；细项在该目录的 BATCH 验证文档、根因矩阵与依赖图 | 21 P1/28 P2；RC-02/04/07/08 等约束。 |
| Codex/GPT-6 Astra 早期 Phase 3 线 | [P3-PF-T01_REVIEW.md](GPT6-Astra/P3-PF-T01_REVIEW.md) 及 R1/R2；[P3-W0-T01_REVIEW.md](GPT6-Astra/P3-W0-T01_REVIEW.md) 及 R1–R4；[P3-W0-T02A_REVIEW.md](GPT6-Astra/P3-W0-T02A_REVIEW.md) 及 R1–R4；[P3-W0-T02B_REVIEW.md](GPT6-Astra/P3-W0-T02B_REVIEW.md) 及 R1。共 **15** 份逐轮记录。 | PF、AUD-044、AUD-039 前段的返工与验收。模型归属据 [KIMI_K3_REVIEW_HANDOFF.md](../reviews/global-audit-20260924/phase3/KIMI_K3_REVIEW_HANDOFF.md) 和总账交接记载；各文件未必逐份署名，不把推断说成逐份独立签名。 |
| Kimi-K3 接续线 | [P3-W0-T02B-R2_REVIEW.md](Kimi-K3/P3-W0-T02B-R2_REVIEW.md)、[P3-W0-T02C_REVIEW.md](Kimi-K3/P3-W0-T02C_REVIEW.md)、[P3-W0-T02D_REVIEW.md](Kimi-K3/P3-W0-T02D_REVIEW.md)、[P3-PARALLEL-R1_REVIEW.md](Kimi-K3/P3-PARALLEL-R1_REVIEW.md)、[P3-PARALLEL-R2_REVIEW.md](Kimi-K3/P3-PARALLEL-R2_REVIEW.md)，共 **5** 份。 | AUD-039 关闭；W3/W4/W5 首包；CONS/T02E/W2-T01 及历史全量基线。接棒原件 [KIMI_K3_REVIEW_HANDOFF.md](../reviews/global-audit-20260924/phase3/KIMI_K3_REVIEW_HANDOFF.md)。 |
| Codex 当前接续线 | [R3](Codex-GPT6/P3-PARALLEL-R3_REVIEW.md) → [R4](Codex-GPT6/P3-PARALLEL-R4_REVIEW.md) → [R5](Codex-GPT6/P3-PARALLEL-R5_REVIEW.md) → [R6](Codex-GPT6/P3-PARALLEL-R6_REVIEW.md) → [R7](Codex-GPT6/P3-PARALLEL-R7_REVIEW.md) → [R8](Codex-GPT6/P3-PARALLEL-R8_REVIEW.md) → [R9](Codex-GPT6/P3-PARALLEL-R9_REVIEW.md) → [R10](Codex-GPT6/P3-PARALLEL-R10_REVIEW.md) → [R10 并发补充](Codex-GPT6/P3-R10_CONCURRENT_EXECUTION_REVIEW.md) → [R11](Codex-GPT6/P3-PARALLEL-R11_REVIEW.md) → [R12](Codex-GPT6/P3-FIXTURE-14CHAIN-R12_REVIEW.md) → [R13](Codex-GPT6/P3-LIFECYCLE-AB-R13_REVIEW.md) → [R14](Codex-GPT6/P3-LIFECYCLE-AB-R14_REVIEW.md) → [R15](Codex-GPT6/P3-LIFECYCLE-AB-R15_REVIEW.md) → [R16](Codex-GPT6/P3-R16_LIFECYCLE_CROSS_REVIEW.md) → [R17](Codex-GPT6/P3-CLOSE-B-R17_REVIEW.md) → [R18](Codex-GPT6/P3-R18_CONTRACTS_REVIEW.md) → [R19](Codex-GPT6/P3-CLOSE-B-R19_REVIEW.md) | R3 初审、R4 续审及旧三包裁决、R5–R19 接续。最新总控裁决见 [P3-CLOSE-B-R19_REVIEW.md](Codex-GPT6/P3-CLOSE-B-R19_REVIEW.md)。 |

截至 R19 的逐轮总控审阅记录为 **38 份**（15+5+18，含一份在途补充）；表中早期段落是历史读序。任务包的 `RESULT.md`、`TEST_RESULTS.json` 等是执行证据，不算额外的总控裁决。以后有新 `*_REVIEW.md`，应在此表与总账追加，不重写历史文件。

### 逐份审阅文件索引（完整文件名，按接棒顺序）

- **Codex/GPT-6 Astra 早期线（15）**：
  [PF](GPT6-Astra/P3-PF-T01_REVIEW.md) · [PF-R1](GPT6-Astra/P3-PF-T01-R1_REVIEW.md) · [PF-R2](GPT6-Astra/P3-PF-T01-R2_REVIEW.md)；
  [W0-T01](GPT6-Astra/P3-W0-T01_REVIEW.md) · [R1](GPT6-Astra/P3-W0-T01-R1_REVIEW.md) · [R2](GPT6-Astra/P3-W0-T01-R2_REVIEW.md) · [R3](GPT6-Astra/P3-W0-T01-R3_REVIEW.md) · [R4](GPT6-Astra/P3-W0-T01-R4_REVIEW.md)；
  [W0-T02A](GPT6-Astra/P3-W0-T02A_REVIEW.md) · [R1](GPT6-Astra/P3-W0-T02A-R1_REVIEW.md) · [R2](GPT6-Astra/P3-W0-T02A-R2_REVIEW.md) · [R3](GPT6-Astra/P3-W0-T02A-R3_REVIEW.md) · [R4](GPT6-Astra/P3-W0-T02A-R4_REVIEW.md)；
  [W0-T02B](GPT6-Astra/P3-W0-T02B_REVIEW.md) · [R1](GPT6-Astra/P3-W0-T02B-R1_REVIEW.md)。
- **Kimi-K3 接续线（5）**：
  [W0-T02B-R2](Kimi-K3/P3-W0-T02B-R2_REVIEW.md) · [W0-T02C](Kimi-K3/P3-W0-T02C_REVIEW.md) · [W0-T02D](Kimi-K3/P3-W0-T02D_REVIEW.md) · [并行轮次 R1](Kimi-K3/P3-PARALLEL-R1_REVIEW.md) · [并行轮次 R2](Kimi-K3/P3-PARALLEL-R2_REVIEW.md)。
- **Codex 当前线（18）**：[并行轮次 R3](Codex-GPT6/P3-PARALLEL-R3_REVIEW.md) · [并行轮次 R4](Codex-GPT6/P3-PARALLEL-R4_REVIEW.md) · [并行轮次 R5](Codex-GPT6/P3-PARALLEL-R5_REVIEW.md) · [并行轮次 R6](Codex-GPT6/P3-PARALLEL-R6_REVIEW.md) · [并行轮次 R7](Codex-GPT6/P3-PARALLEL-R7_REVIEW.md) · [并行轮次 R8](Codex-GPT6/P3-PARALLEL-R8_REVIEW.md) · [并行轮次 R9](Codex-GPT6/P3-PARALLEL-R9_REVIEW.md) · [并行轮次 R10](Codex-GPT6/P3-PARALLEL-R10_REVIEW.md) · [R10 并发补充](Codex-GPT6/P3-R10_CONCURRENT_EXECUTION_REVIEW.md) · [并行轮次 R11](Codex-GPT6/P3-PARALLEL-R11_REVIEW.md) · [R12](Codex-GPT6/P3-FIXTURE-14CHAIN-R12_REVIEW.md) · [R13](Codex-GPT6/P3-LIFECYCLE-AB-R13_REVIEW.md) · [R14](Codex-GPT6/P3-LIFECYCLE-AB-R14_REVIEW.md) · [R15](Codex-GPT6/P3-LIFECYCLE-AB-R15_REVIEW.md) · [R16](Codex-GPT6/P3-R16_LIFECYCLE_CROSS_REVIEW.md) · [R17](Codex-GPT6/P3-CLOSE-B-R17_REVIEW.md) · [R18](Codex-GPT6/P3-R18_CONTRACTS_REVIEW.md) · [R19](Codex-GPT6/P3-CLOSE-B-R19_REVIEW.md)。

## 历史快照：截至 2026-09-25 的可执行状态（最新以顶部 R15 为准）

| 工作包 | 最新总控口径 | 下一步 |
|---|---|---|
| PF/W0、并行轮次 R1/R2 | 维持历史 REVIEW 的本地 PASS；部署/现网仍未做 | 不重审已冻结事实；新交叉缺陷单独登记。 |
| P3-W1-T01、P3-W3-R1、P3-W2-T01-R1 | **执行回执已收到，尚无本接续线的独立复审裁决** | 依各包证据做限定复审；不能用执行自报填 PASS。 |
| P3-CLOSE-T01 阶段 A | **PASS（仅 A）** | 阶段 B AUD-040 与统一回归仍待做。 |
| P3-W2-T02 | **REWORK** | RC-04 启动写入/就绪边界、停用学校覆盖、凭据证据更正；见 R3 review 与下一轮窗口 1。 |
| P3-W5-RECORD-T01 | **REWORK** | 具体资源幂等键碰撞与浏览器报告假全量；见窗口 2。 |
| P3-W5-REPORT-AUTH-T01 | **PASS_LOCAL（AUD-017 本地范围）** | 纳入最后全量回归；现网未验。 |
| P3-W2-LIFECYCLE-T01 阶段一 | **DESIGN_REWORK**；尚无产品实现 | 先修 principal 唯一身份与 legacy grant fail-closed；待 W2-R1 停止后动 schema；见窗口 3。 |

并行关系：五份任务可同时发出。窗口 1（W2-R1）与窗口 2（RECORD-R1）可同时做定点，文件面互斥。窗口 3 现在可修设计，但 schema/client/PG 操作须等窗口 1 停止。窗口 4 只读整理 W1/W3/W2-R1 三包事实，可同时开展，不替总控裁决。窗口 5（CLOSE-B）现在只做只读入口盘点；必须等所有产品包完成且总控复审后，才独占干净实例实施 AUD-040 和单次全量回归。五份任务原文在 [P3-NEXT_WAVE_PROMPTS.md](../reviews/global-audit-20260924/phase3/P3-NEXT_WAVE_PROMPTS.md)。

## 证据与安全口径

- 看 `docs/reviews/global-audit-20260924/phase3/evidence/<task>/RESULT.md`、`COMMANDS.md`、`TEST_RESULTS.json`、`logs/`、`rc/`、`HASHES_FINAL.json` 与原源码，不只看交付摘要。核查输入 drift、行区归属、定点失败/skip、实例 down 与 hash；`PROTECTED` 漂移零容忍，兄弟窗口归因单列。
- 本轮五份最终 hash 独立复算 44/44、88/88、54/54、51/51、25/25；冻结 29/29。它们只说明复算时现存文件匹配。W2-T02 有两份包含未掩码**隔离实例** PG 连接凭据的证据文件，已在 R3 点名但未输出值，下一包须更正并如实重建 hash；**不要把当前的 88/88 当作这些文件可以保留的理由**。
- 不连接生产库、不看真实 `.env`、不真实部署。所有包默认不 commit/stage/push。最终统一回归、提交、部署及现网验证仍是后续门槛。

## 模型切换时应给什么

把**本文件路径**与新 CodeBuddy 的完整 `RESULT`/回执交给模型即可；要求先按顶部最短指令读序执行。若审某个旧轮次，再给对应 `*_REVIEW.md` 与证据目录；若处理新的架构争议，附 Phase 2 对应 RC 原文。模型名称或思考强度是交接建议，不改变文件中的裁决权威性。
