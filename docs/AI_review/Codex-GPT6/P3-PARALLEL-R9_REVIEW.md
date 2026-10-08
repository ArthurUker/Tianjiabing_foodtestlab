# Phase 3 并行轮次 R9 总控复审（2026-09-26）

本轮依 `REVIEW_LOG_MASTER.md` §0/§1/§4、R8 裁决与 Phase 2 RC-04/RC-08，审 P3-W2-T02-R6、P3-DB-FIXTURE-R2、P3-W2-LIFECYCLE-DESIGN-R5、P3-W3-R2-CROSS-PLAN-R4、P3-HARNESS-CHECK-R1。只读复核证据与当前源码；未跑隔离 PG/产品套件，未编辑产品代码、提交或部署。五包 hash 复验为 150/150、51/51、9/9、14/14、19/19 `ALL_MATCH`；`node --check` 抽查 W2 两源文件、harness helper、集成测试均 rc=0。执行者报告的 PG rc 与实例 down 以其原始日志为证，不把自报等同总控重跑。

## 裁决

| 包 | 总控裁决 | 尚未闭合 |
|---|---|---|
| W2-T02-R6 | **PASS_LOCAL（R8 ①–④定点范围）**。空台账 DDL 加 guard、失败记录经 guard 与写后核对、人工清锁 advisory+CAS 同批、baseline 先持久写非终态再提升均有真实反例。 | 锁表仍运行时创建/升级且 11 文件链未增；`baseline_pending` 仅靠“未知状态”通用阻断，须正式纳入协议/检查口径；复证与提升之间的结构改变窗口尚未消除。RC-04 **未完成**。 |
| DB-FIXTURE-R2 | **PASS_LOCAL**。真实迁移 A/B 的未限定名 `User`/`TestRecord`、同键跨校锁正反对照补齐 R8 缺口；27/27、17/17、34/34、15/15、68/68。 | 测试角色在空 schema 上预授 `ALL TABLES` 后，回放新表仍需事后 GRANT；应固化为 fixture 契约。真实 server 未测。 |
| LIFECYCLE-DESIGN-R5 | **PASS_DESIGN_DIRECTION / 实施需修订**。`CHECK ... NOT VALID` 作为 A 新写入强门禁可行；B 两段部署接口未接线已明示。 | M-2“当前 username 唯一且 User.created_at ≤ 审计时间”仍不能证明历史主体身份：用户名可能在该时间之前已被回收，且没有不可变 id/世代。裁决为**username-only 不自动映射**；仅稳定主体 id 或独立可审证明可绑定，否则保守拒绝。不得以 M-2 现稿实施。 |
| W3-CROSS-PLAN-R4 | **PASS_PLAN / 真实联测待接口**。A/B 双实例避免了“修源即修改目标”；旧备份拒绝与新备份复原分栏正确。 | `BackupRun` 跨实例注册无产品入口；人工插行只能作测试准备，不能算产品能力。若要关闭灾备产品路径，需受控注册入口和真实恢复联测。 |
| HARNESS-CHECK-R1 | **PASS_STATIC / DYNAMIC_HOLD**。三入口改动、迁移前置 helper 与静态核验已交付。 | T02C/报告授权 fixture 仍 `db push` public，先污染版本证明；`public.revoked_tokens` 临时 `SET SCHEMA` 寄存方案不作为最终 fixture 合同。先修 fixture，再跑 49/20/12 动态。 |

## 总控决策与下一步

1. **W2-R6 的停止编辑信号有效**；允许启动公共基础设施版本化迁移包，但 R6 的局部 PASS **不等于** RC-04 关闭。锁表与吊销表统一由一个窗口按 `@scope: public` 协议入链，运行时 DDL 同一发布撤出并改只读形状检查；`baseline_pending` 改正式已知非终态，复证→提升前再做可证明的结构检查。
2. **测试 fixture O1**：迁移先于 public/tenant 业务表使用。T02C 与 report-auth fixture 退出 `db push`；测试角色 GRANT 在回放**后**完成。不要依靠搬移 `revoked_tokens` 表或声明式 attestation。修毕在独占实例跑三入口动态。
3. **生命周期实施允许开始准备与 Release A**，但 migration 链编辑必须等公共基础设施窗口完成并冻结链尾 hash。A/B 不能在同一发布中提前暴露 M2；M-2 的 username-only 自动映射按上表拒绝。Release B 的 deploy/client 门禁必须真实接线后才可验证。
4. **W3 跨实例产品路径**应新增受控外部备份注册能力（可复用既有 BackupRun 字段并单独审计来源，不放宽现有上传来源校验）；之后做 A/B 双实例真实恢复。没有产品注册时只能报告测试人工准备，不算阻塞解决。
5. **CLOSE-B** 可独占改 AUD-040 unit/DB 入口，最终单实例全量回归须等 fixture、公共链、生命周期发布态、W3 真实恢复全部停止且总控复核。不可用旧 270/310 数字硬套新基线。

五个执行 prompt 见 `phase3/P3-NEXT_WAVE_R9_PROMPTS.md`。其编辑面互斥；共享 migration 链、实例运行与全量回归均采用明文接力信号。冻结 29、HEAD、故意未提交工作树纪律保持不变。
