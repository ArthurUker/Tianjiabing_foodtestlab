# Phase 3 并行轮次 R4 总控复审

日期：2026-09-26。范围：本轮五份新回执，以及事实包指向的 W1/W3/W2 三份旧回执的补充限定复审。此处的 PASS 仅指所列本地证据与范围，均非部署或现网验收。冻结裁决以 `phase3/REVIEW_LOG_MASTER.md` §0/§4 与 Phase 2 `FINAL_ARCHITECTURE_DECISIONS.md` RC-04/RC-08 为上位约束；本记录不修改它们。

## 核验方法与共同事实

- 读执行包 RESULT、TEST_RESULTS、COMMANDS、原始日志及关键源码；对当前工作树独立复算 W2-T02-R1 74/74、W5-RECORD-R1 58/58、PRIOR-THREE-FACTS 12/12、CLOSE-B 18/18，LIFECYCLE 设计 hash 4/4。冻结 29/29 只读一致；HEAD `7343a8a9f8fc28b7ef2a6bad2b22c701b2fbf9e7`，index 空，`git diff --check` 无报错。
- 这些 hash 只证明对应文件在复算时匹配，不证明设计满足 RC，也不替代全套件。三个旧包的当前 hash 漂移由事实包逐项归因后续兄弟修改；不得倒归为旧包越权。
- 未连接业务库、未真实部署、未提交、未代跑 PG/Jest。下述反例基于源码与现有原始测试证据；涉及新增场景的结论是返工要求，并非声称已实测失败。

## 五份新回执

| 包 | 裁决 | 证据支持与边界 |
|---|---|---|
| P3-W2-T02-R1 | **REWORK（RC-04 未闭合）** | unit 7/7、真实实例 16/16，启动只检测、active/disabled 覆盖、产品路径移除 db push、旧凭据脱敏均有证据；但逐租户版本、未知漂移与全局失败阻断存在缺口，见下。 |
| P3-W5-RECORD-T01-R1 | **PASS_LOCAL（R3 两项返工闭合）** | AUD-002 10/10、AUD-020 12/12、受保护 probe 6/6、记录契约 24/24；具体资源 r1/r2 各跑 handler，2501/11000+ 真正导出成功，2501/2000 渲染标为部分数据。单实例文件台账、进程内幂等台账和浏览器 PDF E2E 仍为登记限制，不因此扩称整体 RC-01/RC-07 关闭。 |
| P3-W2-LIFECYCLE-T01-R1 | **PASS_DESIGN；产品实施 HOLD** | 复合唯一 `(scope_key,subject_user_id)`、旧 grant 无身份 fail-closed、securityRegression 基线 18/18 三项 R3 修正已写入 DESIGN/TEST_MATRIX/BLOCKERS。无 schema/migration/PG 实施，不能记 AUD-027/047 已修。需先等 W2 逐租户迁移纪律稳定。 |
| P3-PRIOR-THREE-FACTS-T01 | **PASS_FACTS** | 旧三包当时事实与当前工作树漂移分开，提供逐包可定位证据；不把该只读包当三包裁决。 |
| P3-CLOSE-T01 阶段 B 盘点 | **PASS_READONLY；执行计划 NOT_READY** | 29 个 root Jest 文件中 1 个 DB、28 个 unit；现有 backend glob 35/35，但将漏更深层新文件的盘点有用。计划 §2 仍写 `TENANT_DB_PUSH_ACCEPT_DATA_LOSS=true`，与新 migration-first 纪律冲突；应待 W2 与生命周期结果后更新。**不发阶段 B 开工信号。** |

### W2-T02-R1 必须返工的四项

1. **租户没有可验证的迁移版本。** `backend/lib/tenantProvisioner.js:73-88` 只列文件并求链摘要；`:138-145,238-267` 实际用 `prisma migrate diff --from-empty/--from-url ... --to-schema-datamodel` 生成末态 SQL。 `backend/lib/tenantSync.js:186-200` 只查 **public** `_prisma_migrations`。这能证明 datamodel 差异，不能证明各租户按版本执行了 migration 中的 SQL、回填或 checksum；“链末=datamodel”只是未验证前提。RC-04 要求 public 与每个 tenant 均可回放、诊断、核验版本。
2. **未知漂移未阻断。** `tenantSync.js:309-329` 把 extra table 仅作警告并令 `ok=true`；`tenantProvisioner.js:322-330` 只比较 reference 对 tenant 的缺失项，不检查额外列/约束/索引。不可悄悄删除这些对象，但未知差异须阻断或有经审查的显式分类；不是仅打印警告后报 OK。
3. **全局失败可绕过能力闸门。** `server.js:314-330` 只有 school hint 命中 `blockedSchools` 才拒绝；public migration failed/pending 或检查超时时该数组可为空，readyz 为 503 而租户请求仍进入 handler。 `server.js:461-477` 中 `AUTO_SYNC_TENANTS=false` 直接 `ok=true/SKIPPED`，可在未证明迁移完成时开放 readiness。无法确认学校归属的租户业务入口也需按能力分类拒绝；健康与必要的修复/管理入口可以单独豁免。
4. **错误路径可能暴露凭据。** `tenantProvisioner.js:127` 把含 `--from-url` 的完整参数拼进错误；`:143` 将连接 URL 放入参数，`:212` 将 URL 放入 psql argv。需用不含密钥的参数/安全传递方式，并以假凭据故障注入断言日志、错误及进程参数无秘密。旧证据两份文件的脱敏已完成且不应逆转。

R1 的真实实例验证与安全回收予以承认；上述属于测试未覆盖的架构边界。下一包不得用更多末态 parity 测试取代版本化执行证据。

### RECORD-R1 限定通过理由

`idempotencyMiddleware.js:69-125` 的身份包括方法、路由模板、规范化具体路径与参数；R1 集成测试不仅比 hash，还比较两个 handler 与返回 ID。 `ExportService.js:457-483,525-548` 显示 expected/exported/rendered 审计，预览不足时标“部分数据”并给原始产物入口；`Storage.js` 的 complete 条件更保守。原 AUD-020 “修复前”探针是从旧交付文本内嵌的函数，不等于对前一轮源码的独立运行；当前源码与真实 2501/11000+ 用例足以支持本轮定点 PASS。最终全套件与真实浏览器渲染仍待后轮。

## 旧三包的补充限定裁决

事实索引：`evidence/P3-PRIOR-THREE-FACTS-T01/FACTS.md`；它记录 W1 当前 58/59、W3 当前 42/44、W2-T01-R1 当前 23/29 的差异来源，不应把当前值冒充交付时 hash。

| 包 | 本次裁决 | 依据与剩余边界 |
|---|---|---|
| P3-W1-T01 | **PASS_LOCAL（RC-02 定点）；RC-04 交叉返工** | 会话定点 15/15、12/12、18/18、11/11；唯一受保护旧断言已由 CLOSE-A 场景保留并更新，现 18/18。 `authMiddleware.js:54-88,348-353` 仍在请求/启动基础设施中执行 `CREATE TABLE/INDEX`，新增 school epoch 索引也靠运行时 DDL；违反 RC-04 “不在启动函数新增 DDL 自愈”。应移到链尾 migration，移除运行时 DDL，保持失效语义。strict 切换和全套件仍待。 |
| P3-W3-R1 | **REWORK（授权逐项一致声明不成立）** | DEFECT-1 的普通授权重放 repro→修复及 27/27 定点可信；但 `restoreService.js:245-269` 已采集 `grantable`，`:299-317` 差集只按 `grantee:privilege`，`:346-375` 自证也沿用该差集。基线为 `WITH GRANT OPTION`、恢复后只有普通权限时会误报 `verifiedIdentical=true`。补真实 PG 正反例，并保持失败时不 drop-old。 |
| P3-W2-T01-R1 | **REWORK（部署回退违反 RC-04）** | 五例沙盒及定点证明实现了既定分支，但 `deploy/deploy.sh:566-613` 仅凭 `public.User` 不存在判“首部署”，在任意 migrate 失败后自动把未完成记录 `resolve --rolled-back` 并 `db push`，可能掩盖部分执行与跳过版本链。移除自动 resolve/db push；migrate 失败保留现场、非零退出，运维只读诊断后人工处置。不能把“无 --accept-data-loss”当迁移安全充分条件。 |

这三项是按冻结 RC-04/授权契约补做的限定裁决，不推翻总账 §4 的 DEFECT-1 方案、写屏障分工或旧轮次通过的特定定点事实。

## 下一步顺序

任务原文见 `phase3/P3-NEXT_WAVE_R4_PROMPTS.md`。可同时开始 W2-T02-R2（租户迁移与 gate）和 W2-T01-R2（deploy-only），以及 W3-R2 的源码/自有隔离测试；W1-R1 先准备 auth DDL 迁移交接，等 W2-R2 完成链尾所有权后编辑；LIFECYCLE-R2 可先补授权面计划/测试，等 W2-R2 停止且总控确认迁移协议后实施 schema。W3 的最终跨包回归也应在 W2 停止后复证。CLOSE-B 继续只读，暂无启动信号。

所有新包需保留输入快照、兄弟漂移归因、原始 rc/log、冻结 29、最终 hash 双复验、实例 down；不提交、不部署、不跑全套件。最终统一回归还要处理 AUD-040 入口拆分，并按新文件清单重算测试基线。
