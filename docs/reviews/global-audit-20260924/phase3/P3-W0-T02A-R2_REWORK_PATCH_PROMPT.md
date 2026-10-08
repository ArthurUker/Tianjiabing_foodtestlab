# P3-W0-T02A-R2 — REWORK PATCH PROMPT

## TASK ID / TITLE / ROLE

P3-W0-T02A-R2：修正跨库权限证明、凭据传递、安全清理与剩余拒绝负例。

你是 CodeBuddy 执行工程师。保留已接受的 R1 Prisma 同事务正例、派生命名空间、结构化登记、allSettled 和真实 trigger；只闭合本轮复审列出的缺口。

## BASELINE / REQUIRED PRE-READ

audit baseline `f08e72e3e74d188b4555e0bee16280b3dd0d622b`；HEAD `7343a8a9f8fc28b7ef2a6bad2b22c701b2fbf9e7`；branch `Product_tencent_CVM`。

先读 phase3/ORCHESTRATOR_STATE.md、P3-W0-T02A-R1_REVIEW.md、本包、P3-W0-T02A-R1_REVIEW_INPUT_MANIFEST.json，再定点读取相应代码与 R1 证据。不重新全仓审计，输入未知变化先报告，不 reset/clean/stash。

## SCOPE / SAFETY / COMPATIBILITY

允许修改 T02A 的 tests/helpers/db-isolation*、tests/isolation/*、四个 integration 文件及 docs/TEST_DATABASE_ISOLATION.md；新回归限这些测试目录。生产模块、W0-T01、root/backend 其余入口、schema migration/依赖/CI 不动。无生产 API/token/数据变化。

新证据仅写 phase3/evidence/P3-W0-T02A/rework2/，原包/R1 证据与 hash 不覆盖。不写总控 state/review/packet，不写任何包外工作记忆；不为修正这条限制而回删未知记忆/临时文件。不 stage/commit/push/deploy，不连接业务或现有开发实例。

## IMPLEMENTATION REQUIREMENTS / ACCEPTANCE

### 1. CONNECT 权限与管理员秘密

- 在新建自有 cluster 内显式收紧非目标可连接数据库（含 postgres/template1）的 CONNECT 授权，只让测试角色连接目标库；管理 controller 仍能管理自身实例。记录数据库 ACL 与实际连接结果，不假定设置角色 flag 已足够。
- 跨库负例使用**正确的同一测试角色、同一密码、同一 host/port，只改变数据库名**。目标库正对照必须成功；非目标库失败必须记录明确授权错误（预期 42501），28000/28P01、ECONNREFUSED、超时和驱动配置错误不能代替 CONNECT 拒绝。冒用管理员另测：测试密码配管理员用户名，记录认证拒绝，不与跨库场景混为一谈。
- psql 命令参数不得含管理员密码/完整带密码 URL。使用 0600 临时 PGPASSFILE 等独立凭据来源，参数只含安全 host/port/user/db 与 SQL 路径；仅该管理子进程接收，Jest 不继承。清理 credential file 必须按本任务归属处理。
- 在真实 spawn 边界捕获参数进行合成 canary 检查，失败仅报布尔/case ID，不打印 argv/秘密。不要为了验证 argv 泄密而输出旧真实密码。
- marker catalog 门禁检查 INSERT、UPDATE、DELETE、TRUNCATE 等写能力，任一存在即拒绝；固定 owner/SELECT 读取仍保留。新增仅 UPDATE 被授予而 INSERT=false 的拒绝回归；真实验证只在自有实例，controller 最后撤销注入授权。

### 2. 生命周期删除门禁

- up/down/status 共用归属与安全删除逻辑：精确规范路径、记录 PID 与 postmaster.pid 实际 PID/datadir/启动标识/端口互相核对，关联监听者与该实例；ps 字符串子串匹配不能单独授权 stop/delete。未知/矛盾/解析失败 fail-closed，保留现场。
- down 只有 stop 成功、目标进程确已结束、端口确已释放都成立才删除；portReleased=false 不得删，不得 ok=true。区分“探测成功且不存在”与探测程序执行失败；工具缺失/权限错误/输出畸形返回不确定，不能当无进程/无监听。
- up 在调用 start 前登记“启动已尝试”。start 返回非零、超时或进程状态不确定时，不得仅因缺 started_instance 标记就删除。若确有可核验的本任务实例则安全停止并复验；不能证明归属/停止则非零保留目录，列出人工处置信息。其他 fixture/trigger 失败走同一安全清理逻辑。
- lifecycle 测试 afterAll 不得无条件递归删除包含真实 PG 的目录；纯合成目录可以按登记清理，真实实例仅通过已核验的安全关闭流程。对失败保留目录的测试，先验证保护成立，再在可信 controller 下安全处置；无法确认时报告残留，不以测试收尾绕过门禁。
- 最小判别用例：stop=0 但端口仍占用→delete=0；ps/lsof 探测错误→delete=0；PID/start/datadir/port 不符→stop/delete=0；start 非零但注入显示实例仍活着→不能直接删；正常真实 up/down→所有条件满足才删除。危险分支优先用合成目录/命令替身，不对未知实例试验。

### 3. 实际 helper 的前置拒绝与负例

- 冻结验证后的 cfg（包含嵌套契约集合），在 withVerifiedTenantTx 调用 createTenantClient 或 transaction **之前**检查当前 DATABASE_URL 与 cfg.url、tenant code/expected schema 的允许关系。不能只依赖 beforeAll；不允许 opts.expectedSchema 将实际目标关系改写为越界对象。
- 原 13 功能语义保持；Prisma 正例继续调用真实生产 createTenantClient，同 tx 核验后业务。针对真实消费 helper 的拒绝回归覆盖 URL drift、越界 schema 和运行时 schema 不符，分别记录 client factory / transaction / business callback 调用次数；正对照必须证明 spies 命中。
- pg 拒绝测试必须明确期待特定拒绝；删除“没有异常也通过”的分支。pg/Prisma 连接失败与释放失败同时发生时都要保留错误、尝试释放已创建资源，controller 创建 admin 连接也纳入 try/finally，不让第二连接失败漏掉第一连接。
- 实际 Jest/setup 入口缺配置/冲突的零连接结论使用可观察连接工厂/网络边界（测试专用注入），不能只检索 ECONNREFUSED。合法配置的正对照至少到达连接边界，证明观测器有效；不访问业务地址。
- 注入真实并发写入批次“至少一项已提交、另一项失败”，走本套件实际登记/allSettled/cleanup helper，证明已提交任务行最终 0、无在途任务、外部 sentinel 不变、原始失败保留。与“两个删除动作之一失败”分别记录，不能互相替代。

### 4. 证据生成

- 新汇总器的 rc 必须存在、非空且严格为合法整数；不能 Number('')=0。必需 case/check/资源字段显式列清单，缺项不得 vacuous PASS；记录原始退出码，不能由测试数量推导。
- 为缺文件、空 rc、畸形 rc、缺必需 case/check 做最小负例；汇总必须非零。修改副本 fixture，不破坏旧日志。
- 修正报告口径：R1 跨库测试为错误密码拒绝，原管理员密码曾作为 psql argv；R2 才提供正确凭据权限验证与无秘密 argv 证明。旧文件保留，新报告引用更正。

## TEST PLAN / REQUIRED EVIDENCE

按 1→2→3→4 顺序验证，仅重跑本包相关 unit/lifecycle、两套 integration（原 13 另列；新增断言不减原语义）、真实权限/probe 和入口负例、相关语法/diff 检查。不得重跑 root/backend/W0-T01，不用“无新失败”掩盖初次运行失败或 skip。

所有真实 PG 操作限新建本任务独占 cluster；新端口/目录拒绝冲突。before/after 基准在操作前保存，cleanup 成功不等于数据库权限正确，分别证明。保留现场错误、重跑原因与残留列表。

rework2 下至少 REPORT.md、COMMANDS.md、TEST_RESULTS.json、ENTRYPOINT_MATRIX.md、RESOURCE_PERMISSIONS.md、logs/和实际 rc、HASHES_FINAL.json。日志安全且直接保存原字节，不打印秘密。报告先完成，hash 最后生成（排除自身/仍写入日志）再只读复验。保护快照、冻结 29 文件只读核验，禁止运行旧 PF 固定输出校验器。

## STOP / FINAL RESPONSE / MODEL HANDOFF

若需改生产模块/旧包、无法证明自有实例安全清理、发现新输入 drift，报告具体 blocker；不自行削弱门禁。完成后停止，不接入 root/backend、不启动 W2a、不关闭 AUD-039。

返回 STATUS（仅本轮）、CHANGED FILES、四组实施/逐例实际观测、原 13 与新增测试结果、BASELINE/NEW FAILURES、UNRESOLVED/BLOCKERS、ISOLATION/CLEANUP/MANIFEST/GIT、ASTRA REVIEW HANDOFF。

沿用既定交接：CodeBuddy 当前执行模型；GPT 复审 Astra / Extra High（极高），携带最新 state、本包、输入快照与完整返回结果。
