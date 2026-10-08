# CodeBuddy TASK PACKET — P3-W0-T02A

## TASK ID

P3-W0-T02A

## TASK TITLE

AUD-039 / RC-10：共享数据库测试隔离门禁与两个 PG integration 套件接入。

## ROLE

你是 CodeBuddy 执行工程师。实施本包、运行限定测试、保存证据后停止，由 GPT 复审。W0-T01 已通过本地验收。本包是 AUD-039 第一段实施，不等于整个 finding 完成。

## FIXED BASELINE / CURRENT HEAD

audit baseline：`f08e72e3e74d188b4555e0bee16280b3dd0d622b`。

task HEAD：`7343a8a9f8fc28b7ef2a6bad2b22c701b2fbf9e7`；branch：`Product_tencent_CVM`。沿用 W0-T01 的未提交工作树。开始只读核对 `P3-W0-T02A_INPUT_MANIFEST.json`，任何未知变化先报告；不 reset/clean/stash。旧包应用、测试、证据保持字节不变。

## OBJECTIVE

消除本包两个 integration 套件对普通 DATABASE_URL、默认本机库、固定 school_a/b/c、school_tjb/test 账号的危险依赖。缺失/错误测试上下文必须非零拒绝；真正隔离的受限角色可以运行既有 13 个测试；失败清理不能影响外部对象。

## IN SCOPE

- `tests/integration/pg-bootstrap.js`、`concurrency.test.js`、`roleAuditTrigger.test.js`、`jest.integration.config.cjs`。
- 新建测试专用共享门禁，例如 `tests/helpers/db-isolation.cjs`：无 import 时连接/DDL/dotenv 副作用，兼容未来 root Jest 与 backend ESM 调用；禁止复制多套规则。
- 新增该门禁的纯单元/受控连接回归、真实隔离 PG 验证，以及必要的测试专用 fixture/provisioning 工具。均限 `tests/helpers/`、`tests/isolation/` 或 `tests/integration/`，不要混入生产目录。
- 新建 `docs/TEST_DATABASE_ISOLATION.md`；证据目录 `phase3/evidence/P3-W0-T02A/`。
- 列出已知未接入入口与后续依赖，仅定点读取 `tests/p0ProvNoAdminInSchool.test.js`、`tests/setup-env.js`、root Jest/package scripts、`backend/tests/_isolation.mjs` 及其直接调用者。此列表用于后续交接，不在本包顺手改造。

## OUT OF SCOPE

不改 W0-T01、认证/业务实现、tenantClient、生产 schema/migration、依赖/lockfile、CI 或 AUD-040 的全局测试脚本重构。root Jest 数据库测试、backend 旧 REVIEW_TEST_DATABASE_URL 接口留待下一包，不运行它们，不声称已全覆盖。`tests/integration/live-api.mjs` 不在这两个 Jest 套件内，本包只登记未接入，不运行或连接已有服务。禁止修历史 authSession 断言、餐具语义或其他 finding。

## ARCHITECTURAL DECISION

沿用 FINAL_ARCHITECTURE_DECISIONS / RC-10 的显式测试 URL、独立实例、受限角色、真实连接身份与 namespace 核验、只清本任务对象。具体契约如下，执行者不自行减弱：

1. **配置来源。** 本包唯一连接来源是显式 `TEST_DATABASE_URL`；没有默认 URL、DATABASE_URL fallback 或业务 dotenv。缺失立即失败，不 skip。`DATABASE_URL` 即使存在也不能授权连接；为生产 tenantClient 必要的兼容覆盖，只在测试上下文验证后显式设置为本次测试 URL。子进程不得继承未经检查的业务连接源。
2. **任务上下文。** 另提供任务 runner 生成的上下文文件（例如 `TEST_DB_CONTEXT_FILE`），含随机 run ID、精确 loopback host/非默认专属 port、db、受限 role、允许的 schema/公共 fixture 对象清单、实例标记。文件不含密码。拒绝缺失上下文、URL 与上下文不符、格式非法、schema 越界、业务样式库/固定业务 schema；URL 名字含 test 不能作为唯一证据。解析 query 参数，拒绝能覆盖 host/port/user/db/search_path 等身份边界的参数；允许项必须列明。动态 SQL 标识符严格验证后引用，不拼接任意输入。
3. **隔离根。** 新建本任务独占临时 PG cluster，只监听 127.0.0.1、唯一目录/端口；创建前拒绝已有目录/占用端口。不能复用开发/业务 PG。provisioner 独立持有管理身份，只有它在已核验的自有 cluster 内建库/角色/fixture/实例标记；其连接不得传给测试进程。
4. **受限执行身份。** 测试角色为非 superuser、NOCREATEDB、NOCREATEROLE、NOREPLICATION、NOBYPASSRLS，不能通过角色成员关系切换到更高权限；不能连接其他库或修改外部所有者对象。只授予运行本套件必要权限。公共 fixture 和标记由 provisioner 精确创建、授权；标记不允许测试角色改写。不要以“独立实例所以直接用管理员跑测试”代替受限角色。
5. **运行时门禁。** 创建客户端之前先验证纯配置；连接后只允许核验用 SELECT，核对 current_database/current_user/session_user、服务端地址/端口、角色属性、实例标记和允许 namespace。任何不匹配在测试业务读写、DDL/DML 前拒绝。校验与操作必须绑定同一受控连接；pool 新连接与 Prisma tenant 客户端不能绕过。可以只读核验 catalog；失败后不做猜测性 cleanup。dotenv 和受影响模块导入顺序必须有证据。
6. **唯一任务对象。** tenant codes 由 run ID 派生，符合现有 resolveSchemaName 的字符/长度规则；三个租户与角色审计租户分别有登记，避免 suite 相互清理。纯函数里验证 school-a→school_a 的既有断言可保留，实际 DB 客户端不得再使用这些固定租户。roleAudit 的 username/user ID 也必须由任务生成，不采纳 school_tjb/test 默认值或任意 TEST_SCHEMA。
7. **公共 fixture 特例。** concurrency 的 public.messages 和真实 trigger 的 public.revoked_tokens 保持被测语义，不能为隔离改生产 trigger/路由；只在全新任务库、精确清单和权限下由 provisioner 创建。发现同名既有对象则停止，不 TRUNCATE/接管。测试按任务 user ID/记录键处理行。不得仅因为表在 public 就允许任意公共表操作。
8. **清理归属。** 只清实际成功创建并登记的对象/本任务行，不按 school_% 枚举 DROP，不全表 purge/TRUNCATE 外部对象。记录创建失败与已登记部分，失败路径 finally 清理；cleanup/disconnect 失败必须保留原始错误且整次任务非零。其他所有者 sentinel 不由测试清理，最终由 provisioner 在验证后回收整个自有实例。

## REQUIRED PRE-READ

1. phase3/ORCHESTRATOR_STATE.md、P3-W0-T01-R4_REVIEW.md、本包、P3-W0-T02A_INPUT_MANIFEST.json。
2. phase3/BASELINE_TEST_CONTRACT.md、AUDIT_EVIDENCE_MANIFEST.json；Phase 2 最终架构 RC-10 与波次 W0；ISSUE_INVENTORY 的 AUD-039。
3. 本包四个 integration 文件、生产 `backend/lib/tenantClient.js` 和 `backend/prisma/role-audit-trigger.sql`（生产文件只读），既有 PF COMMANDS 中隔离 fixture 的记录仅供理解依赖，不能执行会覆盖旧证据的脚本。
4. 上述未接入入口仅用于绘制范围清单。禁止重新全仓审计；不运行原 bug-exists 危险 probe。

## IMPLEMENTATION REQUIREMENTS

- 先列本包入口→配置验证→真实身份核验→fixture/测试→清理调用链和文件清单，再实施。
- 保持现有 concurrency 的真实 Prisma tenantClient、并发查询/写入/缓存和 public 回落断言；roleAudit 必须使用真实生产 SQL trigger 验证审计/吊销/非法角色拒绝，不以 mock 代替正例。
- 新夹具只服务本任务，不执行生产 db push/migrate/seed 或迁移修复；不得需要现网数据。fixture 完整性失败单列为执行错误，不能混为门禁拒绝通过。
- 直接 Jest config、单文件 Jest 入口与 npm run test:integration 都要得到一致拒绝；不能只在 npm wrapper 放门禁。纯门禁单测可无 PG 执行，live 套件缺配置必须非零。
- 日志只输出安全原因、case ID、布尔/计数、脱敏身份与任务资源归属，不打印完整 URL/密码/环境。未知参数不回显原值。

## BACKWARD COMPATIBILITY

生产接口/数据/token 无变化。测试使用方式有意收紧：旧 DATABASE_URL 和默认端口/固定 schema 不再可用；文档给出新显式配置配方。backend 的 REVIEW_TEST_DATABASE_URL 暂不改，由后续包通过兼容薄封装接入同一门禁；不得因此宣称旧入口已经安全。

## SAFETY CONSTRAINTS

禁止连接生产/业务/已有开发实例，禁止读取真实 .env。危险 URL 负例用纯解析或连接替身证明 connect=0，绝不真的尝试连接该地址。真实权限/身份负例只在本任务自有 cluster 中执行。不得全局 pkill、删未知目录或停止已有 PG；先核验 datadir/port/PID/所有权，再清理。禁止写任务之外的工作记忆。

## TEST PLAN

1. **无连接负例**：缺 TEST_DATABASE_URL、仅 DATABASE_URL、缺上下文、URL/上下文冲突、用户名含 test 但库不符、固定 school_tjb/school_a、非法标识符、覆写连接参数；验证在客户端创建/连接前失败，connect=0、DDL/DML=0。测试错误输出含合成敏感标记时断言无回显。
2. **只读身份拒绝**：受控客户端与专属 PG 负例覆盖 db/user/session user/port/marker 不符、管理员/高权限成员角色；允许身份 SELECT，DDL/DML=0。未通过验证不得触发 teardown 对外部对象操作。
3. **真实正例**：新独占 cluster + 受限 role，两个 integration suite 的既有 13 个测试全部执行、不 skip；新门禁回归另计，不减少原断言。证明当前数据库/执行角色与预期一致，实际写入落在清单内。
4. **外部对象与失败清理**：在自有库中由独立所有者预置 sentinel schema/table/行，保存 before；正常及 setup 中途失败之后 after 一致。测试角色直接尝试修改它必须权限拒绝。已登记部分清理、未登记对象保留；真实 cleanup 拒绝/连接释放错误或受控注入必须使执行非零且报告完整，不能用空路径/默认零计数充当证明。
5. **实际入口拒绝**：npm run test:integration 以及直调指定 Jest config/文件，在缺配置时非零且零连接/DDL；正例执行两套件。不要运行 root npm test 或 backend 全套（尚未接入）。
6. **静态与非回归**：仅检查本包变更语法、git diff --check；独立只读验 W0-T01 保护快照和冻结 29 文件。既有 W0 测试、Jest 历史两失败及餐具 delta 不重跑、不修改。

## ACCEPTANCE CRITERIA

本包两个 integration 套件的普通 URL/default/schema 路径已切断；配置拒绝在连接前、真实身份拒绝在 DDL/DML 前；正例受限身份 13/13 无 skip；失败清理和 sentinel 证明成立；直接入口不绕过；无越权变更、新失败或日志秘密。所有实际数值从运行记录获得，setup/权限/观测异常不能标记 PASS。

这只验收 T02A；AUD-039 仍需后续 root Jest / backend 接入和整体入口复核才可关闭。发现本包必须改生产模块或旧包时先报告，不自行扩大。

## REQUIRED EVIDENCE

在 `phase3/evidence/P3-W0-T02A/` 保存 RESULT.md、COMMANDS.md（完整可复跑、默认拒绝复用资源）、ENTRYPOINT_MATRIX.md（本包已覆盖与已知未接入分开）、TEST_RESULTS.json、运行日志、隔离资源与角色权限原始输出、清理记录、最终 hash 清单。

日志直接重定向保存原字节；命令真实 rc 用独立字段捕获，管道记录 PIPESTATUS/等价结果，不手填 exit_code=0。JSON 成功字段从实际断言/退出码生成，缺数据即失败；至少每个负例包含拒绝阶段、connect/DDL/DML 观测，sentinel 前后基准与清理对象列表。

先完成报告再生成最终 hash，排除清单自身与仍在写的生成日志，随后只读复验。记录开始/结束 HEAD/branch/status/index、允许修改与新增文件、原始失败与重跑原因、未执行项、schema/API 是否变化。不得执行 PF 的旧固定输出校验器。

## COMMIT POLICY

不 stage/commit/push/merge/deploy；不创建 PR；不自动回滚/删除现有未提交内容。

## STOP CONDITIONS

输入未知 drift、需要生产数据/权限才能验证、需修改生产架构/旧包、不能实现受限 role 与真实触发器兼容、不能证明自有实例归属时停止，返回具体 blocker。正常完成后也停止，不自行接入 root/backend 或启动 W2a。

## FINAL RESPONSE FORMAT

STATUS: PASS / PARTIAL / BLOCKED（仅 T02A）

TASK / HEAD / BRANCH；CHANGED FILES；IMPLEMENTED；TEST RESULTS（原 13 与新增分别计数）；REGRESSION SOURCE AND INVERSION；BASELINE FAILURES / NEW FAILURES / SKIPS；UNRESOLVED / DESIGN BLOCKERS；ISOLATION / CLEANUP / MANIFEST / GIT；NEXT RECOMMENDED ACTION；ASTRA REVIEW HANDOFF。

模型交接沿用既定策略：CodeBuddy 使用当前执行模型；GPT 复审 Astra / Extra High（极高）。携带本包、最新 state、输入快照与完整执行结果；不重新全仓扫描。
