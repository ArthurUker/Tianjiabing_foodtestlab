# P3-W0-T02A-R1 — REWORK PATCH PROMPT

## TASK ID / TITLE / ROLE

**P3-W0-T02A-R1：闭合真实 Prisma 连接、namespace/权限边界与失败清理。**

你是 CodeBuddy implementation engineer。只修 T02A 复审的四组缺口，沿用已接受的无 fallback、Jest setup、任务派生与原 13 个回归语义；不要重新设计生产系统。

## FIXED BASELINE / CURRENT HEAD

audit baseline `f08e72e3e74d188b4555e0bee16280b3dd0d622b`；HEAD `7343a8a9f8fc28b7ef2a6bad2b22c701b2fbf9e7`；branch `Product_tencent_CVM`。

先只读核对 `P3-W0-T02A_REVIEW_INPUT_MANIFEST.json`。保护 W0-T01 和旧 T02A evidence；不 reset/clean/stash，不覆盖已有 hash/日志。

## OBJECTIVE / IN SCOPE / OUT OF SCOPE

目标是原 T02A 退出契约，不扩大 AUD-039 的入口范围。允许修改 T02A 新建的 `tests/helpers/db-isolation*`、`tests/isolation/*`、4 个 integration 文件、`docs/TEST_DATABASE_ISOLATION.md`；新正式测试仍限这些测试目录。修订证据新建 `phase3/evidence/P3-W0-T02A/rework1/`。

禁止改生产 tenantClient/trigger/应用、W0-T01、schema migration、依赖/lockfile/CI、root/backend 其他测试、历史失败与餐具 delta。旧证据原样保留，通过新报告修正口径。不得写包外工作记忆、改总控文件、提交或部署。

## REQUIRED PRE-READ

phase3/ORCHESTRATOR_STATE.md → P3-W0-T02A_REVIEW.md → 本包 → P3-W0-T02A_REVIEW_INPUT_MANIFEST.json → 原 T02A 包的架构契约与退出条件。然后仅读上述有界文件及原 TEST_RESULTS/ENTRYPOINT_MATRIX；生产 tenantClient/trigger 只读。禁止全仓重扫。

## ARCHITECTURAL DECISION / IMPLEMENTATION REQUIREMENTS

### A. 核验必须覆盖真正执行 SQL 的 Prisma 路径

- 保持真实生产 createTenantClient 的创建、缓存、并发和 schema 隔离回归。pg Client 的验证结果不能给另一个 Prisma 连接作担保。
- 测试层使用 Prisma interactive transaction：在**同一 transaction client**上通过薄适配调用共享只读核验，再执行业务 SELECT/INSERT；对新建/重新获取的事务都执行，不以缓存过的验证结果跨物理连接放行。不修改生产模块，也不另复制校验规则。
- 共享验证接受明确 expected schema（public 只用于清单内特例）；核对 current_schema 与 catalog 中预期 namespace/对象归属、marker 的只读权限。必须先核验才可业务访问。连接配置在创建客户端前检查，冻结验证后的配置；实际创建租户 client 前检查环境 URL 未偏离。
- 为实际 pg/Prisma 两条消费链分别加入拒绝负例，观察发生的 SELECT 和被阻断的业务 SQL；不能仅测独立 helper 然后宣称所有连接已保护。

### B. 约束上下文与受限身份

- allowedSchemas、tenant codes/schema、roleAudit schema/user、markerTable、allowedFixtureObjects 必须与 runId 及本任务固定 fixture 契约一致，不是“上下文声称允许就允许”。固定 school_tjb/school_a、跨 run ID、未登记 public 表、畸形 marker 名都必须在连接前拒绝。解析所有 URL 参数，重复身份相关参数拒绝；decode 异常返回固定安全错误，不打印原输入。拒绝默认 5432，与本任务专属端口契约一致。
- role 属性必须完整且五项严格为 false，角色名称/记录数匹配；缺记录、null/未知值拒绝。TCP addr/port 必须与上下文相符，null 不放行。
- 本包角色没有任何成员关系需求：**拒绝测试角色的所有直接角色成员关系**即可切断间接成员提权路径，不必实现通用角色图。增补非 superuser 高权限父角色、两跳链和缺属性的负例。
- provisioner 新实例采用真实口令认证（例如 SCRAM）；管理凭据单独以 0600 文件/受控环境提供给 provisioner 与 controller，不进入 Jest 测试环境或命令参数/日志。不得再靠 trust + 可推导管理用户名。以测试凭据冒用管理员、连接其他库必须拒绝；管理负例只在本任务新实例执行。
- 明确收紧 PUBLIC/测试角色的数据库 CONNECT 权限及不需要的 schema CREATE 权限，仅授权目标库和列明对象。禁止测试角色改 marker/创建 schema/修改 sentinel；提供真实拒绝证据。不要仅检查角色 flag 后宣称全部权限已验证。

### C. 登记与资源生命周期

- 并发写入必须在每个已提交成功的操作后立即登记任务行键（或使用明确事务回滚方案）；等待全部并发任务 settled 后再进行清理，避免首个 rejection 与尚未完成写入竞态。不要在断言结束之后才登记。注入“部分成功后失败”证明成功写入无残留。
- registry 绑定本次 cfg/允许对象与任务行键。拒绝越界 qname、任意 whereSql/空范围、未成功创建的 schema/table 冒登记；可收窄 API 为本包实际需要的结构化行清理，provisioner 管理 schema/table 生命周期。不建设通用 SQL 防火墙。
- pg connect/verify、Prisma、probe 的所有失败分支可靠释放；suite afterAll 分别尝试所有 disconnect/cleanup，不因第一处失败跳过其它资源。原始业务错误与后续清理/释放错误都保存，运行非零；不能吞掉次要错误或用最后一个错误覆盖根因。
- up/down/status 统一严格校验 runId/port；在任何路径操作前限制为任务临时根下精确子目录，拒绝遍历/符号链接/未知归属。保存独立资源归属记录（runId、规范 datadir、真实端口、PID/启动身份），操作前与实际实例核对，不只看 ps 子串；status 不得使用 port=0。
- **pg_ctl stop 非零时禁止删目录、禁止 removed=true/ok=true**；确认进程停止及端口释放才删除确属本任务的文件。若归属或停止无法证明，保留现场、返回非零并列清人工处置所需信息，不自行扩大删除权限。
- up 在 initdb/start/fixture/trigger 任一步失败，要按已登记阶段收尾；启动后失败须安全停止自有实例。保留最初错误和清理结果；不因 context 尚未写出就失去资源归属。所有临时凭据、上下文和目录按本任务精确清理。
- 文档示例使用 provisioner 返回的真实 contextPath/envPath，不写死 /tmp（本机 os.tmpdir() 不一定是 /tmp）。保留无法安全清理的残留列表，不概括为无残留。

### D. 判别性观测和证据

- 修正无关 connect spy。对实际入口/连接工厂安装可观察替身或测试层注入；配置拒绝要求构造/连接计数为 0，并有配置允许的正对照证明包装确实命中。DDL/DML=0 从实际调用记录生成，不手填，不以未出现 ECONNREFUSED 作唯一依据。
- sentinel/未登记 keep 对象必须在被测写入和清理**之前**由独立 controller 创建并保存基准。正常、部分失败和 cleanup 失败后比较；不能在清理完之后才创建对象。
- 分别测试 stop 失败保留目录、归属不符零 stop/delete、启动后 fixture 失败安全收尾、cleanup/disconnect 失败非零且原始错误保留。可用测试专用依赖注入在合成目录验证危险分支；禁止对未知实例模拟停止，不向生产代码加跳过开关。
- 从原始日志/观测生成 rc、计数、before/after、资源状态。所需字段缺失/空/解析失败或命令非零使汇总失败；不得由测试数量推导 exit_code=0，不得由 removed 字段推导端口已释放。缺证据负例必须能使汇总器拒绝。

## BACKWARD COMPATIBILITY / SAFETY

无生产 API/token/数据变化；TEST_DATABASE_URL 显式隔离契约继续收紧。保留原 13 个功能用例及语义，不以 mock 替代真实正例。所有真实验证仅使用新建自有 cluster；不连接现有业务/开发 PG，不读真实 .env，不运行 root/backend 全套或 live-api。禁止 secret 回显、全局 pkill、删未知文件；不重复此前包外记忆写入。

## TEST PLAN / ACCEPTANCE CRITERIA

按下面顺序实施并验证，结果按 A/B/C/D 分组，不追求总测试数：

1. 单元/受控连接：跨任务或固定 schema 上下文、roleAudit 越界、marker 可写/缺失、角色缺属性或任意成员、null 地址、参数冲突均拒绝；实际 pg/Prisma 消费链的身份/schema 不符时业务 SQL=0。
2. 生命周期无真实危险操作的负例：stop 非零→delete=0、归属不符→stop/delete=0、up 部分失败→阶段性清理，原错误与清理错误均保留。正对照证明 spies 命中。
3. 全新实例：测试角色只有目标库/fixture 必需权限，冒用管理员和跨库连接失败；marker、sentinel 写入和 schema 创建被拒；两套件原 13/13，无 skip。记录真实 pg 与 Prisma transaction 的身份/namespace 核验先于业务 SQL。
4. 部分并发成功后失败、cleanup/disconnect 注入：任务行清理、未登记对象/独立 sentinel 不变、失败非零、无在途任务和遗留连接；随后正常重跑正例。probe/JSON 汇总缺数据必须拒绝。
5. 只重跑本包新增/修改门禁测试、两套 integration、入口拒绝及相关静态检查；W0-T01、root/backend 基线不重跑。新失败与先前执行过程失败分别记录，不能吞错或跳过断言。

退出：A/B/C/D 均有有效证据，受保护文件未变；仅 T02A-R1 自报 PASS 后等待总控，不关闭 AUD-039、不发起后续包。

## REQUIRED EVIDENCE / COMMIT POLICY

新证据只写 `phase3/evidence/P3-W0-T02A/rework1/`：REPORT.md、COMMANDS.md、TEST_RESULTS.json、ENTRYPOINT_MATRIX.md、原始 logs/与真实 rc、资源/角色权限证明、最终 HASHES_FINAL.json。旧证据不倒改。字段必须可追溯至实际执行，区分真实 PG、测试替身和静态推断。

报告后生成 hash，排除自身和未完成生成日志，再只读复验；冻结 29 文件继续只读。禁止执行旧 PF 固定输出校验器。记录 HEAD/branch/status/diff、允许修改与新增文件、未执行项和残留。

不 stage/commit/push/merge/deploy，不改总控 state/review/packet。若需改生产模块或无法满足以上边界，返回 DESIGN BLOCKER 及最小事实；不削弱门禁。正常完成后停止。

## FINAL RESPONSE / HANDOFF

STATUS（仅本次）/ CHANGED FILES / A-B-C-D IMPLEMENTED / TEST RESULTS（原 13 与新增分开）/ BASELINE FAILURES / NEW FAILURES / UNRESOLVED / DESIGN BLOCKERS / ISOLATION-CLEANUP-MANIFEST-GIT / ASTRA REVIEW HANDOFF。

沿用既定模型交接：CodeBuddy 当前执行模型；GPT 复审 Astra / Extra High（极高），携带最新 state、本包、输入快照与完整返回结果。不重新全仓扫描。
