# CodeBuddy TASK PACKET — P3-W0-T02B

## TASK ID / OBJECTIVE

P3-W0-T02B · AUD-039 / RC-10：把 **root Jest 默认入口中的真实 PostgreSQL 破坏性套件**接入 T02A 已验收的同一隔离门禁。本包只处理 root Jest；完成后 AUD-039 仍需 backend 旧入口及最终入口矩阵复核。

你是 CodeBuddy 执行工程师。先实施、保存证据，再停止交 GPT 复审。W0-T01 和 T02A（含 R1…R4）已本地 PASS，均为未提交工作树；不 reset/clean/stash。

## FIXED BASELINE / REQUIRED PRE-READ

audit baseline `f08e72e3e74d188b4555e0bee16280b3dd0d622b`；task HEAD `7343a8a9f8fc28b7ef2a6bad2b22c701b2fbf9e7`；branch `Product_tencent_CVM`。

按顺序阅读 phase3/ORCHESTRATOR_STATE.md、P3-W0-T02A-R4_REVIEW.md、本包、P3-W0-T02B_INPUT_MANIFEST.json；再读 BASELINE_TEST_CONTRACT、Phase 2 的 RC-10/W0、ISSUE_INVENTORY 的 AUD-039、T02A rework4 最终报告与 ENTRYPOINT_MATRIX。开始记录 git status/diff stat/HEAD/branch/index，并逐项**只读**核验输入快照；未知变化先报告，不覆盖旧证据。

定点读：`jest.config.cjs`、`package.json` 测试命令、`tests/setup-env.js`、`tests/p0ProvNoAdminInSchool.test.js`、共享 `tests/helpers/db-isolation.cjs`/setup、`tests/isolation/provision.cjs`、生产 `backend/lib/schoolAdminPurge.js`、`backend/lib/tenantClient.js` 和 Prisma `School`/`User` 模型。生产文件只读。其他 root 测试仅做目标入口与 DB 客户端的**定点**清单核对；不重新全仓审计。

## SCOPE / SAFETY

允许修改 `jest.config.cjs`、`tests/p0ProvNoAdminInSchool.test.js`，以及确有必要时 `tests/setup-env.js` 和 `docs/TEST_DATABASE_ISOLATION.md`。允许在 `tests/isolation/` 下新增 root 专用 fixture/probe/门禁回归；T02A 的共享门禁、provisioner、两个 integration 套件和 W0-T01 文件为保护项，确需改变其契约先返回 DESIGN BLOCKER，不自行改旧包。新证据仅写 phase3/evidence/P3-W0-T02B/。

不改生产 purge、tenantClient、Prisma schema/migration、backend 旧测试、live-api、AUD-040 的全局脚本/CI、认证/餐具等其它 finding。无 stage/commit/push/deploy；不连接业务/已有开发 PG，不读取真实 `.env`，不写包外工作记忆，不回删未知目录。危险 URL/角色/schema 负例只用纯解析或连接替身，绝不能实际连接该地址。真实操作只在新建独占 cluster 内，沿用 T02A `down` 的严格归属、stop、进程和端口复验。

## ENTRY DECISION

root `jest.config.cjs` 的 `setupFiles` 在测试模块导入前运行。把**同一** `db-isolation-setup.cjs` 加到 root Jest 入口（保留 `tests/setup-env.js` polyfill），让 `npm test`、直接 `jest --config jest.config.cjs` 和直跑危险测试文件在缺/错显式配置时非零拒绝；不能仅在 npm wrapper 或测试 body 中检查。默认 root 命令含危险 p0 套件，因此此门禁可使缺测试上下文的默认命令整体拒绝。T02B 不拆分默认 unit/db 脚本，那属于 AUD-040 的后续范围。

唯一连接来源仍是显式 `TEST_DATABASE_URL` + `TEST_DB_CONTEXT_FILE`；普通/已有 `DATABASE_URL` 不构成授权。共享 setup 验证后才设置 `DATABASE_URL=cfg.url`，并须在 **Prisma import/构造/连接之前**完成。`p0ProvNoAdminInSchool.test.js` 当前静态 Prisma import、默认 `new PrismaClient()`、动态建表和 `DROP SCHEMA … CASCADE` 都须改为受控路径。既有 `backend/.env` 若存在，不能被当作测试连接来源；在合成隔离进程中用 fail-on-access 或等价观测证明旧 dotenv 路径不可接管配置，不打印真实内容。

## IMPLEMENTATION REQUIREMENTS

### 1. root Jest 前置拒绝与来源绑定

- root setup 与 integration 使用**同一**纯配置门禁/错误码。缺 `TEST_DATABASE_URL`、仅 `DATABASE_URL`、缺上下文、URL/上下文冲突、固定业务库/schema、默认端口、非法/重复 query 参数时，必须在任何 Prisma 客户端创建或连接前拒绝；其它未验证数据库变量不得成为连接来源，按共享 setup 契约在校验后覆盖或清除，并记录不回连的观测。安全错误不回显完整 URL、密码或 canary。合法正例能到达受控连接边界，证明观察器有效。
- 测试模块不应在校验前触发 backend 真实 dotenv 或默认 Prisma 连接。使用显式 `cfg.url` 创建测试客户端；如果生产 import 链需要读取 `process.env.DATABASE_URL`，由已验证 setup 在 import 前覆盖。记录 import 顺序与连接工厂/网络边界观测；对 Prisma 原生引擎无法由 Node Socket 覆盖的部分，另用实际数据库身份 SELECT 证明，不把 Node 观察器的零次尝试扩称所有底层连接。
- `npm test`、直接 Jest config、直跑 p0 文件分别验证无配置非零；合法配置下不能新 skip，根 suite 的已知两项历史失败必须精确比对，不能只按失败数量放行。

### 2. p0 套件的真实操作只落在任务对象

- 使用新建的 T02A 独占 cluster、受限测试角色、runId 派生 `cfg.tenants.a`/`cfg.schemas.a`。root 专用 controller fixture 可在这个**全新自有实例**里精确补齐 `public."School"`、`public."User"` 与该学校 schema 的 `"User"`，权限最小化；只补被测真实 Prisma School/User 路径需要的表/列/行，不执行 db push/migrate/seed，不接管已有对象。fixture 存在性/owner/角色/标记不符即拒绝。管理员口令仅留 controller 进程，不传 root Jest；角色不得 CREATE/DROP、连接其他库或修改 sentinel。尽量复用 T02A 已有 schema/marker/sentinel，不为 root 套件创建固定 school_tjb/demo/school_a 等业务样式命名。
- p0 的原五项制度语义保持：非法学校 admin 降级、合法 manager 与 public 平台 admin 保留、幂等、列表 `is_invalid_role` 断言、POST/PUT 角色拒绝。**public 平台 admin 正对照必须实际存在**；旧代码里“不存在则不检查”的分支不能算通过。
- 生产 `purgeInvalidAdminInSchools` 会扫描 public School 的所有活跃行。调用前用受控身份核对本实例 public School 仅含本任务登记的学校 code；不满足就停止，业务 purge callback=0。实际执行使用真实生产函数与真实 Prisma，但每次破坏性操作必须先在**同一 transaction/client**上运行共享 `verifyRuntimeIdentity`（通过 Prisma tx 薄适配），随后才调用 purge/读写；不能让一次 pg 客户端核验给另一 Prisma 连接担保。若生产函数无法接收 tx，先返回具体兼容阻塞，不绕过。
- 测试本身不再 CREATE/DROP schema，不以固定 schema 或全表无范围 DELETE 清理。任务写入/修改的行以 runId 派生键登记；事务失败自动回滚，成功后的清理只按登记行键或由 provisioner 安全销毁整个自有实例。保留独立 owner sentinel 与 public 平台 admin 的 before/after；失败路径 cleanup/disconnect 尽力逐项执行并保留原错误，清理失败整体非零。不能为通过测试篡改生产 purge 结果。

### 3. 判别证据

- 无配置/冲突负例：实际 root Jest 入口非零，客户端 factory/connect/DDL/DML **0**；合法配置正对照可达连接边界并完成只读身份 SELECT。固定业务 URL 只作纯配置负例。
- 真实正例：专用实例中的 root p0 五项制度语义运行，受限 role、库/端口/schema/marker/School 精确清单在每个写事务之前得到证实；不会触及已有开发实例。对外 sentinel 和 public 平台 admin before/after 一致。若 fixture/schema 不足导致失败，记录执行错误，不改断言或 skip 凑绿。
- 失败注入：在事务内核验拒绝时业务 purge 0 次、DDL/DML 0；某项写入后抛错时回滚/登记清理有效，外部对象不变；清理或释放失败必须非零且保留原始错误。所有连接/fixture 由同一新实例创建及停止，结束确认进程消失、端口释放、目录按归属删除；无法确认则保留现场并报告。
- 回归：先验证 root 门禁和 p0 定点正例，再在**同一安全实例**运行 `npm test -- --runInBand`。旧 baseline 为 root Jest 249/251，仅 `tests/authSession.test.js:259` 与 `:294` 两项历史失败；本次实际总数从日志读取，按具体 case/错误比较：BASELINE_KNOWN、CURRENT_HEAD_PREEXISTING、NEW_FAILURES、SKIPS 分栏。不要把 2 项历史失败当整个命令 PASS，也不顺手修改它们。

## REQUIRED EVIDENCE

P3-W0-T02B/ 下至少 RESULT.md、COMMANDS.md、ENTRYPOINT_MATRIX.md、TEST_RESULTS.json、各入口真实 rc/原始日志、结构化 Jest 结果、配置/连接/DDL/DML 观测、fixture/权限/School 清单、sentinel 前后、实例登记与安全清理、HASHES_FINAL.json。证据区分真实 PG、真实入口+受控注入、纯合成；缺日志/必需 case/rc/资源状态不能 PASS，汇总器提供最小缺项负例。日志仅写安全字段和计数，不打印密码、完整 URL 或 .env 内容。

先写完报告再生成 hash（排除自身与仍写入日志），只读复验；独立对照输入快照、旧 T02A/W0-T01 保护项及冻结 29 文件。禁止运行旧 PF 的固定输出 manifest 校验器。仅本包接入 root；backend `_isolation.mjs`/其它 node:test DB 入口和 `live-api.mjs` 仍登记为未接入，AUD-039 不得关闭。

## STOP / HANDOFF

输入 drift、必须改生产 purge/tenantClient 或旧门禁、无法构造受限角色真实 fixture、无法证明自有实例安全关闭时返回 DESIGN BLOCKER 并停止；不削弱门禁、不借业务库验证。完成后返回 STATUS（仅 T02B）、CHANGED FILES、入口矩阵、原五项与新回归结果、真实 rc、两项历史失败的精确对照、新失败/skip、sentinel/cleanup/manifest/Git、未解决与 ASTRA REVIEW HANDOFF，然后停止。

CodeBuddy 沿用当前执行模型；GPT 复审建议 GPT-6 Astra / Extra High（极高）。交接带最新 state、本包、输入快照与完整执行结果；模型不会自动切换。
