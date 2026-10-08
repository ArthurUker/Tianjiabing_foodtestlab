# P3-W0-T02A-R3 — REWORK PATCH PROMPT

## TASK / ROLE / REQUIRED PRE-READ

任务：闭合 R2 剩余 L（生命周期）、H（契约/真实拒绝/资源释放）、E（证据对应关系）。你是 CodeBuddy 执行工程师；不是新一轮全仓审计。

按顺序读取本目录 ORCHESTRATOR_STATE.md、P3-W0-T02A-R2_REVIEW.md、本包、P3-W0-T02A-R2_REVIEW_INPUT_MANIFEST.json，然后只读相应源码和 R2 证据。

固定 HEAD `7343a8a9f8fc28b7ef2a6bad2b22c701b2fbf9e7`，branch `Product_tencent_CVM`；audit baseline `f08e72e3e74d188b4555e0bee16280b3dd0d622b`。先记录 git status/diff stat/HEAD/branch/index，逐项只读核验输入快照。保留已有未提交 diff，未知漂移先停止报告。

## SCOPE

只允许修改以下现有文件；不要求每个都改：

- tests/isolation/provision.cjs、lifecycle.test.cjs、live-probe.cjs、gate.unit.test.cjs
- tests/helpers/db-isolation.cjs
- tests/integration/pg-bootstrap.js、concurrency.test.js
- docs/TEST_DATABASE_ISOLATION.md

允许在 tests/isolation/ 下新增本包必需的定点回归和合成 fixtures；负例子进程 fixture 不得被默认 suite 当正常测试自动发现。新证据仅写 phase3/evidence/P3-W0-T02A/rework3/。R2 汇总器如需修订，复制到 rework3，禁止改旧文件。

生产模块、W0-T01、其余 integration 文件、现有 observer、依赖/lockfile/CI、root/backend DB 入口、旧证据、总控 state/review/packet/manifest 全部保护。无 stage/commit/push/deploy，无业务/现有开发实例访问。不写包外工作记忆，不回删未知文件。只用新建独占 PG cluster；危险分支优先合成目录/命令替身，不对未知实例试验。

## L — 共用归属与严格清理（先完成，再运行真实实例）

### L1 三态探测

ps/lsof 的命令错误、signal/timeout、非空诊断、输出格式错误均为 unknown，不可被过滤成 absent/released。严格验证 ps 返回的 PID 等于请求 PID；lsof PID 列表不得悄悄丢弃坏行。明确支持的平台 no-match 契约：例如 rc=1、stdout/stderr 均空；rc=0 空输出不得自动当成功无匹配。若平台不同，记录实际契约而非扩大放行。

up 的初始端口检查复用同一三态规则，unknown 时不得 initdb/start。down 和 up 收尾的后置探测沿用同一规则。必须有以下判别回归（含操作次数和目录保留）：

- rc=1 + stderr 错误；rc=0 + 空/畸形输出；混合合法/坏 PID 行；ps 返回另一 PID；signal/null status。
- 合法 present/listening 与合法 no-match 正对照，证明解析器不是全部拒绝。
- stop=0 后上述未知状态 → removed=false；不能借 stop 成功代替复验。

### L2 归属证据

ownership 与 postmaster.pid 必须有严格有效的 PID、规范 datadir、正整数 startTime、1…65535 端口并逐项一致；记录实际启动标识后才能授权关闭。缺字段/空值/畸形 port 不可转为可选字段；空串不得参与命令行 includes 放行。命令行需明确对应 PostgreSQL 的实际数据目录参数，不能只命中任意子串；监听者 PID 必须与实例对应。

status 输出实际探测/归属字段，不再取不存在的属性。不要求增加平台无关进程管理框架。增加独立的 PID/datadir/startTime/port 不符、缺失字段、路径前缀碰撞负例，均零 stop/delete；完整一致正例可进入停止。

### L3 启动异常与删除

up 异常、down、status 使用同一个归属判定及关闭后复验规则。start 调用前登记启动尝试；失败路径不能把“端口有监听”叫作 own instance，也不能把“无 pidfile + 当前无监听”当作启动已结束。

- start_attempted 之后缺失/畸形归属证据：非零、保留目录、零 stop/delete，输出安全的人工处置信息。允许保守保留，不要求自动抢救。
- 有完整一致的自有实例证据：才允许 stop；stop=0、进程已结束、端口释放全部确证后才删除。未知/矛盾均保留。
- start 之前失败：只清确知本调用创建且尚未尝试启动的资源；不得因外来监听者调用 stop。
- 原始错误与收尾错误分别保留，所有保留路径都给出 manual/residue 状态。

替换旧“只有端口监听也算自有”的合成断言。加入 start 非零+无 pidfile+端口空闲、仅外来监听者、完整自有证据但 stop 失败三个场景。前两者零 stop/delete；第三者允许一次 stop、禁止删除。危险条件全用合成资源。

lifecycle afterAll 真实实例仍只走安全关闭；有未解决残留则记录路径并使 suite 非零，不得只打印报告后 PASS。用合成子进程负例证明该非零行为。不要为了通过而删真实未知目录。

## H — 不可变契约、真实 helper 负例、错误释放

### H1 cfg 不可变

对已验证 cfg 及所有嵌套集合/对象冻结（两种配置获取入口都保持同一契约）。加顶层 url/runId 和嵌套 schemas/allowedSchemas/allowedFixtureObjects/tenants 等篡改回归；篡改不能改变后续允许范围。保持现有合法配置与前置 0/0/0 正反例；不改变生产 tenantClient。

### H2 真实消费 helper 的拒绝

保留独立真实 schema 不符用例，但不能用它替代 withVerifiedTenantTx 的拒绝证据。替换或准确重命名 STOP_BEFORE_BUSINESS 用例：它只证明 hook 中断。

增加通过实际 withVerifiedTenantTx、真实 createTenantClient 与真实事务触发的共享核验拒绝。可在测试专用 afterTransactionStart 钩子中对该真实 tx 设置另一允许 schema 的 search_path，再让原核验正常执行（需要时给 hook 传 tx）；不要在 hook 里直接抛错、伪造核验返回或绕开实际 helper。记录实际 current_schema 和固定 RUNTIME_IDENTITY_MISMATCH。若该实现受客户端行为限制，可以用已支持的 controller marker UPDATE 授权注入触发真实 MARKER_MISMATCH，并保留独立 schema 不符证据、说明两者分工。

同一套观测：正例 factory/transaction/实际业务 callback=1/1/1；前置拒绝=0/0/0；真正共享核验拒绝=1/1/0，业务执行器调用也为 0。计数必须覆盖传入的 callback，不能只计 beforeBusiness。保留原业务测试语义和五项已提交清零用例，不为消除缓存影响修改生产缓存。

### H3 已创建客户端的失败释放

覆盖 connectGuarded、provision 的 withAdmin/fixture client、live-probe controller：connect 位于受控 try 内，connect 拒绝后仍尝试结束已创建资源；原始 connect/query/verify 错误和 end 错误同时保留，不互相覆盖。两个管理员连接也纳入 finally，第二个创建/连接失败不得漏掉第一个。清理一项失败不阻止其他项释放。cross/impostor 的预期认证/授权错误与 end 失败分开记录；end 异常不能被空 catch 隐藏为成功负例。

使用测试专用依赖注入/合成 Client 验证 connect 失败+end 失败、第二个 admin 连接失败时第一个 end 已调用等路径；无需制造真实网络故障。保留真实正常 probe。若为可测性导出 controller 方法，CLI 行为保持，不在 import 时启动实例/连接。

## E — 来源必须对应结论

rework3 的新汇总器保留 R2 严格 rc 和必需 case/check 策略，并修正：

- 零连接结论引用实际 entry-observer 用例的通过记录，明确 Node setup 边界；不得只搜无 ECONNREFUSED。
- concurrent_partial_commit_cleanup 引用真实 integration 并发用例（五项成功、一项失败、登记五项、清理零、原错误保留）；cleanup_action_partial_failure 单列引用 probe，不互相代替。
- 残留来自逐实例登记/关闭结果与收尾观测；没有数据则 unknown/失败，不写死 0。所有真实任务实例均须纳入，人工保留是未解决项。
- 测试数量从输出取得；R2 历史分布为 14+12+3=29，明确更正旧报告，不改旧文件。钩子抛错不得再标为核验拒绝。

优先使用 Jest 结构化结果（或等价明确通过记录），匹配具体 case 身份和 passed 状态，不能只有 case 名子串存在。副本负例至少覆盖：缺/空/坏 rc，缺必需 case/check，移除 observer 通过记录、移除并发用例结果但保留 probe 清理失败证据、缺失/未知残留数据。均需非零；有效正对照通过。测试自测与应用/真实 PG 证据分开标注。

## TEST PLAN / EVIDENCE / STOP

先跑纯合成的 L/H 回归并确认门禁，再在新建自有实例运行相关 isolation、两套 integration、live-probe，保存真实 rc 和结构化结果。保留正常 up/status/down 与 trigger 失败自动收尾的真实正例。原 13 integration 语义不得删减。受影响 helper/provision 已改，相关 suite 重跑有必要；不要跑 root Jest/backend/W0-T01/旧 PF 校验器或扩大为全部 PG 基线。

rework3 至少 REPORT.md、COMMANDS.md、TEST_RESULTS.json、逐条 L/H/E 验收矩阵、logs/实际 rc、资源登记与最终处置记录、HASHES_FINAL.json。来源分别标注真实 PG/真实入口+受控注入/纯合成/沿用旧证据。过程失败和重跑原因如实保存；日志不含密码/完整秘密 URL。

完成报告后再生成 hash（不含自身及仍写入日志），只读复验；核对输入保护项与冻结 29 文件。禁止运行旧 PF 固定输出校验器。任何不能安全处置的真实实例即报告 blocker，不能通过削弱门禁或清理未知目录继续。

返回 STATUS（仅本轮）、CHANGED FILES、L/H/E 实际观测及证据路径、测试/失败/skip、未解决与残留、输入/输出/冻结 hash、git 状态、ASTRA REVIEW HANDOFF。完成后停止，不关闭 AUD-039、不接入 root/backend、不启动下一波。

执行模型沿用当前 CodeBuddy；GPT 复审按既定交接策略使用 GPT-6 Astra / Extra High（极高），携带 state、本包、最新输入快照、完整返回结果及落盘证据。这不是自动切换模型。
