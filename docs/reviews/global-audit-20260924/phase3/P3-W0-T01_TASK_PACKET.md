# CodeBuddy TASK PACKET — P3-W0-T01

## TASK ID

P3-W0-T01

## TASK TITLE

AUD-044 / RC-10：统一 JWT access/refresh 配置校验，覆盖服务启动及 deploy 非空复用。

## ROLE

你是 CodeBuddy 执行工程师。实现本包、执行有界回归、提交证据后停止，由 GPT 总控复审。不得自行改变认证架构、扩大 wave 或关闭 finding。

## FIXED BASELINE / CURRENT HEAD

- 审计 baseline：`f08e72e3e74d188b4555e0bee16280b3dd0d622b`。
- task-start HEAD：`7343a8a9f8fc28b7ef2a6bad2b22c701b2fbf9e7`；branch：`Product_tencent_CVM`。
- Preflight READY_FOR_REMEDIATION；P3-PF-T01（R1/R2）PASS。tracked/index 开始为空；审计目录原已 untracked，不删除。
- 开始记录 Git/manifest；HEAD/branch 或非本任务 tracked 状态不符时报告 delta，停止依赖该状态的实施，不能 reset/clean/stash 他人内容。

## OBJECTIVE

原样复制当前公开示例值、配置空值/弱值或 deploy 复用非空示例值时，所有受支持启动入口必须拒绝；合法已有强密钥保持原始字节与令牌语义。日志不泄漏密钥。

## IN SCOPE

仅 AUD-044。预计允许修改：

- `backend/server.js` 的 JWT 配置校验和必要启动顺序。
- 新增一个无数据库、无 import 副作用的共享 JWT 配置校验模块，例如 `backend/lib/jwtSecretConfig.js`；必要的薄 CLI（`backend/scripts/validate-jwt-secrets.mjs`）。
- `.env.example` 的 JWT 小节；`deploy/deploy.sh` 的 JWT 取值、校验、持久化连接点；`deploy/deploy.adapter.example.conf` 的 JWT 字段/注释。
- 若需安全测试复用分支，可在 `deploy/lib/` 抽取仅 JWT 配置解析/选择步骤；由真实 deploy 与测试共用。不得复制另一套业务逻辑充当测试。
- 新增 `backend/tests/security/` 下本任务正式单元/启动回归与纯测试替身；必要的 JWT 配置操作说明，可新建 `docs/JWT_SECRET_CONFIGURATION.md`。
- 本任务证据目录：`docs/reviews/global-audit-20260924/phase3/evidence/P3-W0-T01/`。

已知 npm start/dev、直接 node、systemd ExecStart 最终进入 server.js。仅按 JWT 字段有界检索仓库受支持配置/部署文档中的占位及示例字面量，列清单与出处；不开展全仓安全审计，不读取真实 .env/凭据。

## OUT OF SCOPE

AUD-039 测试框架修复、RC-02 session/epoch、JWT 算法/claims/TTL、refresh 派生算法、认证路由、数据库/schema/migration、备份、业务语义、前端、餐具 delta、历史两项 authSession 失败、依赖升级及 lockfile。

不执行 deploy.sh 主流程、不启动 systemd、不安装服务、不连接数据库、不执行 Prisma DDL、不访问生产、不检查/轮换线上密钥。本包不做发布。

## ARCHITECTURAL DECISION

沿用 FINAL_ARCHITECTURE_DECISIONS 的 RC-10。以下是该裁决的本包实现契约，执行者无需再自定安全/兼容规则：

1. **统一入口校验**：服务在配置加载后、监听和数据库/后台工作启动前执行同一校验。所有 NODE_ENV 均生效，没有 test/dev/skip-secret-validation 绕过开关。deploy 在 JWT 值解析/选择完成后、写 backend/.env 和重启前调用同一规则；不能因为旧值非空就跳过。
2. **明确表示方式**：沿用当前 JWT 库接收的原始 UTF-8 字符串，不自动 trim/normalize/hex-decode/base64-decode 后用于签名。最小 32 UTF-8 字节；空/纯空白、控制字符、单一字符重复串、已知公开弱值/占位/示例值拒绝。名单匹配可用 trim 后值以拒绝占位加空白，但成功值必须原样返回。不能用字符种类或估算熵宣称证明随机性；不要强制现有合法强密钥改成某一种编码。
3. **具体已知拒绝值至少包括** server.js 原五项与 `.env.example` 原 `please-run-openssl-rand-hex-32-and-replace-this`，以及上述限定检索发现的其他公开 JWT 示例/占位值。记录来源与测试映射；不要用过宽的“包含 secret/test 等子串”规则误伤随机值。对于部署不能无损表示的输入，明确拒绝并记录兼容限制，不能悄悄截断/转义改变有效密钥。
4. **refresh 兼容**：`JWT_REFRESH_SECRET` 未设置或恰为空字符串时，保留 UserManager 当前 `${JWT_SECRET}:refresh` 派生并验证最终有效值；显式非空 refresh 按同一规则校验，纯空白不是缺省。没有显式 refresh 不算缺少有效密钥。不要更改 UserManager 的签名/验签与派生行为；本包不新增“两个显式值必须不同”的独立策略。
5. **生成与重用**：新 access 配置确实缺失时，deploy 保留密码学安全随机生成（现有 openssl rand -base64 48 合法；操作文档也可用 openssl rand -hex 32），生成后仍校验。非空弱值拒绝，不能擅自替换/轮换。合法已有值精确保留。refresh 的显式环境/配置/旧 .env 值必须能够复用及写回，不能重部署丢失后意外退回派生值；完全未配置则保留派生，不自动新增独立 refresh。
6. **值流**：JWT 环境值优先于配置、配置优先于旧文件、最后生成/派生，与现有非空优先逻辑兼容。只处理任务合成文件；解析 JWT 旧值不得执行其内容，不通过 eval/命令替换执行密钥。不要把秘密放进 CLI 参数、日志、异常或 shell xtrace。其它配置的历史 eval/部署行为不在本包内重构。
7. **模板与操作说明**：示例 access 留空，注明必须安全生成/注入及旧公开值不可使用；refresh 可选语义一致。弱值需要由操作人员更换后才能启动；不得保留弱值验签兼容 key。本次只写说明，不实际执行轮换。

若无法同时满足这些要求，返回具体 DESIGN BLOCKER，不自行削弱门禁或改变身份语义。

## REQUIRED PRE-READ

按顺序读取（phase3/phase2 均在 `docs/reviews/global-audit-20260924/`）：

1. `phase3/ORCHESTRATOR_STATE.md`、`phase3/P3-PF-T01-R2_REVIEW.md`。
2. `phase3/BASELINE_TEST_CONTRACT.md` 与 `phase3/AUDIT_EVIDENCE_MANIFEST.json`。
3. `ISSUE_INVENTORY.md` 的 AUD-044；`phase2/FINAL_ARCHITECTURE_DECISIONS.md` 的 RC-10；`phase2/FINAL_REMEDIATION_WAVES.md` 的 W0。
4. `.env.example` JWT 段、`backend/server.js` 启动/监听段、`backend/modules/UserManager.js` 的 access/refresh 密钥使用（只读）。
5. `backend/package.json`、deploy 的 JWT 环境覆盖/旧配置复用/生成/.env 输出/systemd ExecStart 段、适配示例；本包测试涉及的 Jest setup/配置与纯内存测试。

不必重读整个 49 项审计或执行原 bug-exists probes。

## IMPLEMENTATION REQUIREMENTS

- 先输出本包将覆盖的真实入口/配置值流与预期文件清单，再实施。安全规则、错误码/原因来自共享模块，CLI/启动/deploy 不各维护一套黑名单。
- 校验失败输出字段名及安全原因，非零退出；不输出原值、子串、完整环境、带秘密命令。正常日志仅声明已配置。
- JWT_CONFIG 模块不得构造 Prisma/启动任务。真实 server.js 不可只在 package script 包装层受保护，直接 node 必须同样拒绝。
- deploy 应在保存配置前失败；受控测试证明弱旧值不会被写回/被随机覆盖，也不会触发 restart。确保现有 shell strict-mode 下 optional refresh 未设置不会触发未绑定变量错误。
- 测试替身仅位于测试目录，通过测试运行器注入；不要在生产入口加入为了 PASS 的短路开关。
- 保护 CORS 现有校验、合法 JWT 值及现有 auth 行为；不把 guard 下沉到 UserManager 构造器从而无端破坏纯内存历史测试。

## BACKWARD COMPATIBILITY

合法已有 access/显式 refresh 保持字节不变；缺省 refresh 的派生结果不变；hex/base64 等安全生成文本可继续使用。新规则故意拒绝弱值及公开示例，属于停止不安全启动，不做自动在线轮换。对公开密钥使用情况未知，不声称现网受影响或已恢复安全。

## SAFETY CONSTRAINTS

只在本地代码与任务合成配置上工作。测试环境使用严格白名单 env、空临时 cwd/合成 dotenv；不继承业务 DB/secret，不 source 真实 .env。所有数据库、后台 job、外部通知与部署服务操作必须由测试替身拦截；不用“无效 DATABASE_URL”代替隔离证明。测试超时需失败并只清理本任务子进程/临时目录。既有 AUD-039 仍未修好，因此本包禁止普通全套数据库测试。

冻结 manifest 29 文件与全部 P3-PF-T01 证据只读；开始/结束校验 hash，不覆盖 fixed-output probe 产物。只写本任务 evidence 目录，总控 state/review 由 GPT 更新。

## TEST PLAN

1. **目标单元**：access 缺失/空/空白、31/32 字节边界、多字节按 UTF-8 字节计数、控制字符、重复弱串、每个已知占位值；短 refresh/公开 refresh/空白 refresh 拒绝。缺省/空 refresh 派生成功；合法显式 refresh 原样保留。使用每次运行安全生成的非公开样本验证 hex/base64 与合法非限定格式正例，不将单一公开常量当生产推荐值。
2. **启动集成**：用真实 server.js 与测试专用依赖替身，在 production 下分别从 node 与 npm start 验证原示例、弱 refresh 在 Prisma/监听/后台副作用前失败；合法生成配置能走到启动监听阶段（可拦截 listen 并记录），然后正常清理。dev/test 至少验证核心 guard 不绕过。没有真正启动 DB 的正例，应准确标记“真实入口+受控依赖”，不能称端到端服务可用。
3. **部署值流**：不运行 deploy.sh 主流程。通过实际共用 JWT 配置选择/校验段的受控 harness 覆盖显式注入、配置值、旧文件非空示例拒绝、旧合法值保留、确实缺失才生成、显式 refresh 跨重部署保留。记录 persist/restart spy：拒绝时均为 0。校验特殊输入不会作为 shell 代码执行；仅合成无害 canary。
4. **安全回归反转**：AUD-044 原缺陷是“公开示例可启动”，新增正式回归断言“公开示例必拒绝、无启动副作用”，同时验证生成值允许。原审计 evidence/probe 不改；没有单独可执行原 probe 时标注来源为 INVENTORY+启动路径，不编造测试。
5. **日志与语义**：合成的非法 secret（含唯一标记）不得出现在捕获 stdout/stderr/异常；合法值经过配置选择/校验后与原值完全相等，兼容现有 jwt.sign/verify 及缺省 refresh 派生。
6. **既有回归**：仅运行 `tests/securityGuards.test.js`、`tests/authSession.test.js` 两个确定使用纯函数/内存替身的文件（先读实际 Jest setup，确认不会连库），以及本包新增正式测试。精确记录 authSession 两项历史失败，不能修改断言使其消失。若 setup 隐式 DB 依赖无法在纯替身环境隔离，报告该验证 blocker，不改 AUD-039 绕过。
7. **静态检查**：变更 JS 语法与 deploy 的 bash -n、diff --check；有 shellcheck 可用则仅相关脚本，不安装新依赖。无需全仓 lint/构建、三套 PG 基线重跑、餐具 probe 重跑。任何新失败/skip 必须单列，不能用历史噪声抵销。

## ACCEPTANCE CRITERIA

- 统一规则覆盖 direct node/npm/service 的共同入口及 deploy 已有非空配置复用，真实路径测试与代码调用链一致。
- 原示例/全部定位的公开占位值、弱 access/显式 refresh 拒绝；合法新/旧值和缺省 refresh 精确保留，无秘密日志。
- 拒绝发生在持久化/监听/数据库/重启副作用前；部署复用用真实共享代码证明，不能仅字符串 grep。
- 测试计划完成且无新回归或未说明 skip；历史失败精确匹配。所有用例/日志有具体命令和退出码。
- 只有允许范围改动；schema/lockfile/应用业务逻辑未扩改，审计证据完整，任务资源清理完毕。
- 返回供审阅的工作区 diff 和 evidence 后停止；PASS 自报不等于 issue CLOSED。

## REQUIRED EVIDENCE

`phase3/evidence/P3-W0-T01/` 至少包含 RESULT.md、COMMANDS.md、TEST_RESULTS.json、脱敏原始日志、ENTRYPOINT_MATRIX.md（入口→共享校验→拒绝时副作用证明）、placeholder 来源/回归映射、开始/结束 Git 与 manifest 校验结果。记录受控依赖范围、未执行的真实环境验证及兼容限制。证据文件和新增正式测试完整列出，包括 gitignored 日志。

## COMMIT POLICY

不 stage/commit/push，不创建 PR/merge，不 deploy；保持当前 branch，提交未暂存 diff 供总控审阅。不运行 git clean/reset，不打包真实 secret。

## STOP CONDITIONS

遇到 HEAD/manifest 非预期变化、无法证明测试不触库、需要修改认证/refresh 语义或超出上述文件职责、需碰生产/旧真实凭据、依赖升级或 schema 变更时停止，报告事实与最小缺项。正常完成本包后也停止，不自行启动 AUD-039 或后续 wave。

## FINAL RESPONSE FORMAT

STATUS: PASS / REWORK / BLOCKED

TASK ID / HEAD / BRANCH:

CHANGED FILES / DIFF SUMMARY:

IMPLEMENTED（入口与值流对应）:

TEST RESULTS（逐项命令、退出码、计数、证据路径；纯函数/入口替身/部署替身分开）:

REGRESSION SOURCE AND INVERSION:

BASELINE FAILURES / CURRENT-HEAD DELTA OBSERVATIONS / NEW FAILURES / SKIPS:

COMPATIBILITY / UNRESOLVED / DESIGN BLOCKERS:

ISOLATION / CLEANUP / MANIFEST / GIT:

ASTRA REVIEW HANDOFF: task/packet、accepted RC-10 decisions、task-start HEAD/branch、diff/日志路径、失败与限制、建议模型及强度、升级触发条件。

## CODEBUDDY HANDOFF / MODEL RECOMMENDATION

任务：P3-W0-T01。先读 ORCHESTRATOR_STATE 和本包；Preflight PASS，W0 仅本包已发出、实施未开始。三个餐具 delta 与历史两项测试失败继续保留。

CodeBuddy 执行：沿用当前可用执行模型，本会话不臆测其产品选项；若使用 GPT 协助有界实现，建议 GPT-6 Sol / Extra High。

GPT 最终复审：**GPT-6 Astra / Extra High（极高）**，原因是认证配置强制拒绝、启动顺序、部署保留与日志泄密需要共同裁决；不需要默认 Max。模型切换携带本包、ORCHESTRATOR_STATE 和 CodeBuddy 完整返回结果，要求读取实际 diff/log 后裁决，不重新全仓扫描。
