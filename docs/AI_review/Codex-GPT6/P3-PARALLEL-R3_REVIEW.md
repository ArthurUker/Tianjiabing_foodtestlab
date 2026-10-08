# P3 并行轮次 3 — Codex 总控限定复审

日期：2026-09-25。范围：用户返回的五个 CodeBuddy 窗口（`P3-CLOSE-T01` 阶段 A、`P3-W2-T02`、`P3-W5-RECORD-T01`、`P3-W5-REPORT-AUTH-T01`、`P3-W2-LIFECYCLE-T01` 阶段一）。本记录不代替此前 Astra/K3 的逐轮裁决，也不把 CodeBuddy 的 `PASS_LOCAL` 自报直接当成总控 PASS。

## 共同事实与复审方法

- HEAD `7343a8a9f8fc28b7ef2a6bad2b22c701b2fbf9e7`，branch `Product_tencent_CVM`，index 空；工作树故意未提交。`git diff --check` 通过。未 reset/clean/stash/stage/commit/push，未连接业务库或运行全套件。
- 对五份 `HASHES_FINAL.json` 按各自格式和路径前缀独立重算内容 SHA-256：**44/44、88/88、54/54、51/51、25/25**，现存文件全部匹配。该检查证明清单内当前内容一致，不证明包外无改动。
- 冻结 29 只读校验独立实测 `29/29 ALL_MATCH`，manifest SHA-256 `4f9c8d4cc16e99c5951a0153098af0e5e79a890d60004663d6df59473edbd8da`；未运行旧 PF 固定输出校验器。
- 独立比较 `P3-CLOSE-T01/input-snapshot-start.json` 与 `P3-W5-RECORD-T01/input-snapshot-end.json`：共同文件变动 **13**、新增 **119**、移除 **0**。13 个变动归入 CLOSE 3、W2-T02 5、RECORD 4、REPORT-AUTH 1；新增代码 8 项归入 RECORD 5、REPORT-AUTH 3，其余为本轮证据。LIFECYCLE 尚未编辑产品/测试代码。该比较是两时点的已列文件对照，不把各窗口不同时间的快照计数误说成同一总体。
- 核对实际源码、定点原始日志/rc 与结构化结果；另做一项不连接数据库的幂等中间件复现。没有代跑 CodeBuddy 的 PG 测试。

## 分包裁决

| 包 | 裁决 | 理由与边界 |
|---|---|---|
| P3-CLOSE-T01 阶段 A | **PASS（仅 A）** | `securityRegression` 旧 AUD-016 断言保留故障场景，事务替身观测到写入生效后回滚与无 epoch 行；日志从 17/18 转 18/18。W3 台账按套件/进程隔离，正反文件序全绿，backup 组单次 27/27。阶段 B（AUD-040 + 统一全量回归）尚未执行。真实 PG 原子性仍由 W1 既有矩阵证据支持；本包的替身不是新的 PG 证明。 |
| P3-W2-T02 | **REWORK** | 定点 9/9 + 4/4 + 2/2 与安全/deploy 回归日志可核，但实现仍违反冻结的 Phase 2 RC-04：`AUTO_SYNC_TENANTS=true` 仍在**启动后**执行 `db push`/回填；默认检查在 `app.listen` 后异步执行，漂移只告警而服务继续；只枚举 `status='active'`，未覆盖停用学校。RC-04 要求启动只检测、漂移阻断 readiness/对应能力、停用学校纳入升级。证据目录另存两份含未掩码**隔离实例**连接凭据的文件（见下），不得进入提交。不能裁定 AUD-009 余量闭合。 |
| P3-W5-RECORD-T01 | **REWORK** | AUD-002 的租户/主体隔离与先鉴权方向正确，9/9 定点成立；但 `resourceScopeOf()` 只用路由模板、不含具体资源 ID。独立纯内存复现：同一用户对 `/api/records/oil/r1` 与 `/api/records/oil/r2` 以同 key、同 body 发 PUT，第二次 handler **未调用**，却返回第一条的 200 `{id:'r1'}`。AUD-020 服务端作业 10/10 定点成立，但浏览器 `collectData()` 对每类型仍 `slice(0, 2000)`，`dataScopeLines()` 在作业成功时仍可宣称“权威全量”；因此 2501 行成功作业可能生成只有 2000 行的报告。`≤2000 全量校验` 用例在超限时提前 `return`，并未保证跑到成功分支；没有 2501/10000+ 完整报告正例。受保护 `idempotencyConcurrency.test.js` 旧断言冲突需按场景保留原则修订。不能裁定 AUD-002/020 关闭。 |
| P3-W5-REPORT-AUTH-T01 | **PASS_LOCAL（AUD-017 本地范围）** | `router.use(authenticateUser, requireReportPlatformAdmin)` 位于全部 handler 前；守卫仅放行 `role='admin'` 且无 `schoolCode`，符合 RC-08 平台范围。真实服务矩阵 20/20 连续两轮 rc=0，含十端点的 401/403、平台正例、写拒绝零副作用、登出后 401 与证据路径。Phase 2 bug-exists probe 原样保留，正式反转回归另建，符合既有契约。尚无统一全量回归或部署验证。证据下载保留既有 `max-age=86400`，后续统一安全回归宜覆盖注销后的浏览器缓存行为；本轮不据此推翻已测服务端守卫。 |
| P3-W2-LIFECYCLE-T01 阶段一 | **DESIGN_REWORK；尚无实现验收** | 只读快照/设计/矩阵确已交付，窗口 2 停止编辑通知已由其回执给出；但设计的 `AuditPrincipal.scope_key @unique` 只取 `platform` 或 `school_<code>`，会使同校第二个用户无法建 principal。必须改为包含主体 ID 的唯一身份（例如 `(scope_key, subject_user_id)` 联合唯一）。“身份列为空的 legacy active grant 继续放行”与 RC-08 的不按 code 猜归属、读时身份校验冲突。测试矩阵 B14 仍把已由 CLOSE 阶段 A 修复的 `securityRegression` 一项失败当基线，也须更正。未编辑 schema、未生成 client、未跑迁移或测试，因此不得报告 AUD-027/047 已修复。 |

## 复核依据与可复现反例

1. **W2-T02 与冻结架构冲突**：`../phase2/FINAL_ARCHITECTURE_DECISIONS.md` RC-04 明定“启动只做 drift detection，不修改结构”；未知漂移、单租户失败阻断 readiness/对应能力，停用学校纳入升级。现 `backend/server.js` 的 `TENANT_SYNC_MODE=true→apply`、`app.listen` 回调后 `selfHealTenantSchemas()` 与仅告警分支，以及 `backend/lib/tenantSync.js` 的 active-only 枚举，逐项不符。此前给 CodeBuddy 的五窗 prompt 对显式 apply 的容忍过宽；以冻结的 Phase 2 裁决为准，此处纠正编排指令，不修改旧裁决。
2. **AUD-002 新跨记录碰撞**：`backend/middleware/idempotencyMiddleware.js` 的 `resourceScopeOf()` 取 `req.route.path`（模板），随后 `identity=SHA256(version|tenant|subject|resource|operationId)`。审阅者在内存中用两个不同 `req.path`、相同模板、相同主体/key/body 调用真实中间件，得到同一个 identity；第一请求执行，第二请求命中缓存且 handler 未执行，返回第一记录内容。复现无需 PG，也未修改文件。应把规范化的具体资源标识纳入身份，并证明同一目标重试仍去重。
3. **AUD-020 报告假全量**：`frontend/js/services/ExportService.js` 下载完成的 NDJSON 后写本地缓存；`collectData()` 在筛选前对每类型 `records.slice(0, MAX_ROWS_PER_TYPE)`，上限 2000。即使权威作业 `expectedCount=exportedCount=2501`，生成 HTML 的 `data` 仍最多 2000，`dataScopeLines()` 首行却按 `auth.complete` 宣称“权威全量”。附加“本地窗口截断”文字不能让该报告变成完整。需要明确拆开“权威原始产物可下载”与“本地预览/PDF 仅部分”的语义，或真正让报告完整消费快照产物。
4. **AUD-027 唯一键**：`evidence/P3-W2-LIFECYCLE-T01/DESIGN.md §2.1` 同时声明 `scope_key @unique` 和 `scope_key='platform' / 'school_<code>'`，未包含用户 ID；同校多用户写入必冲突。这是设计缺陷，不应等 migration 实测才发现。
5. **证据凭据**：只做布尔扫描、未打印值。`evidence/P3-W2-T02/logs/sandbox-url.txt`（mode 0644）与 `logs/w2t02-dbsync.env`（mode 0600）均含未掩码隔离实例 PG URL。实例已 down 的自报/日志不等于允许凭据进入仓库证据。下一包须安全移除或改为脱敏形状，重建本包 hash 与更正索引；不得把值复制进 review、日志或提交。

## 下一步编排

任务文本见 [P3-NEXT_WAVE_PROMPTS.md](../../reviews/global-audit-20260924/phase3/P3-NEXT_WAVE_PROMPTS.md)。先并行 W2-T02-R1 与 W5-RECORD-T01-R1（文件面互斥）；LIFECYCLE 先修设计，schema/Prisma 共享产物须等 W2-R1 停止编辑和测试后再动。CLOSE 阶段 B（AUD-040 与单实例单次全量回归）须等上述产品编辑、生命周期实现及这些包的总控复审结束后独占执行。此前 W1-T01/W3-R1/W2-T01-R1 三包仍只有执行回执，缺本总控的独立裁决；在最终关闭/发布前须补其限定复审。任何包都不得真实部署或提交。
