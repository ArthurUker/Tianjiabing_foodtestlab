# P3-W0-T01-R1 — JWT 配置值流限定修订

你是 CodeBuddy。只补 P3-W0-T01_REVIEW 的 R1/R2/R3，沿用 P3-W0-T01 原授权范围与 RC-10。本包不是新 wave，不重做已通过工作。

## REQUIRED PRE-READ / BASELINE

先读 `docs/reviews/global-audit-20260924/phase3/ORCHESTRATOR_STATE.md`、`P3-W0-T01_REVIEW.md`、原 `P3-W0-T01_TASK_PACKET.md` 和本包。上述短文件名均位于同一 phase3 目录。

branch=`Product_tencent_CVM`，HEAD=`7343a8a9f8fc28b7ef2a6bad2b22c701b2fbf9e7`。当前本包未提交 diff 是修订基底，不要求 tracked 干净，不 reset/clean/stash。对照 `P3-W0-T01_REVIEW_INPUT_MANIFEST.json` 核验开始输入；若有额外用户改动，保留并报告，不覆盖。

Preflight PASS；W0 首包 REWORK；AUD-044 未关闭。原已验证 suite 190/190、13/13、249/251 不重跑。保留原 W0 四份日志与结果证据；新日志/JSON/补丁报告放 `phase3/evidence/P3-W0-T01/rework/`，原报告可追加更正索引但不倒改原执行结果。Phase 1/2 manifest、全部 P3-PF-T01 证据、总控 state/review/packet 不改。

## R1 — 解析有效值 → 校验 → 无损写回

总控确定的语义：文件语法不是 secret 本身。必须先解析文件的有效值，再调用共享校验；来自真实环境变量的字符串则已经是有效值，不再按 dotenv 去引号或删注释。

- 实现 JWT 两键专用、安全的旧文件解析，不执行文件内容。支持常见单行裸值、配对单双引号、键周边空格、可选 export 及合法行尾注释，行为应与当前 dotenv 对支持子集一致。重复 JWT 声明、复杂转义/多行或无法明确无损处理的格式可明确拒绝，而非自行猜测/静默取首值。
- 文件不存在/确实无 access 值才可以进入原生成策略；不可读、解析失败、歧义必须非零拒绝，不能被当作缺失。已有非空弱值拒绝，不擅自重生；若遇复杂旧语法，只报安全原因，不泄漏内容。
- 共享解析应可在当前 deploy §5.1 的依赖安装前运行；不得假定首次部署已经安装 dotenv/node_modules。无需新增依赖：可以采用无依赖的保守子集解析器；测试使用已装真实 dotenv.parse 验证该子集。不要为此提前运行安装/部署步骤。
- 不修改 JWT 核心 raw UTF-8 规则/签名或 refresh 派生。**部署表示限制与运行时强度规则分开**：如果继续输出未加引号的 env 行，对不能证明在 dotenv 与 EnvironmentFile 间无损的值（例如 `#`、引号、反斜线、反引号、空白）在写回前明确拒绝并记录 DEPLOY 表示原因；不得静默删改，也不得将此限制扩到直接进程环境的合法值。安全生成的 hex/base64 与常见合法旧值必须通过。
- 也可做兼容的序列化，但需证明两种消费端的语义；本包不要求真实 systemd。没有这类证据时采用明确的保守部署限制，不声称所有任意字符可无损部署。
- 将真实 deploy 的 JWT 环境优先选择及 JWT 序列化小段抽取到可共用函数/模块；harness 必须调用同一代码。其余配置、整段部署框架不重构。JWT 参数值不经 eval 执行，不通过 argv 传值。
- 明确初始化 optional refresh，保证当前实际写回步骤在 `set -u` 下缺省也不报错；不能仅以 CLI 的临时环境赋值代替 shell 返回值初始化。

## R2 — 错误路径无值输出

- CLI 拒绝未知参数时只给固定用法/原因，不回显参数或派生片段。仅纯 --help/-h 可成功；`--help` 混入其它参数也不得回显秘密，按用法错误处理。
- 修正文档注入示例：说明先从受控环境提供值，再运行 sudo/部署；不要把值写进 sudo 或其它可见 argv。无需执行真实注入。
- harness 只使用合成随机样本，失配时报告 case ID/布尔比较，不在 failed assertion/echo/错误分支打印样本值。不把真实 secret 引入测试。

## R3 — 测试配置源隔离与边界补证

- 启动测试的 dotenv 读取只指向 mkdtemp 中合成文件，必须拦截默认仓库/用户配置查找。可在测试专用 loader 中将 config 调用约束到指定合成文件并保留真实解析；路径未设置时拒绝。不要在生产 server 增加跳过校验/跳过 dotenv 的测试 flag。
- node/npm 两种真实入口都证明没有读取真实 cwd/.env、backend/.env 或 HOME 配置；不能仅依靠当前它们不存在。正例 listen 在测试层拦截或改为回环，不改变生产监听配置。
- 原 COMMANDS 的手工启动和递归 grep 示例标为历史、不可直接复跑；新配方只能引用隔离 runner、限定 tracked 模板/文档字段，不读取真实 .env。修改说明不等于补造历史运行证据。

## 最小新增回归（只针对上述路径）

1. 旧文件中裸值/单双引号包裹的**公开弱值**、弱值带行尾注释：均在 persist/restart 前拒绝，计数 0，无自动替换。
2. 合法旧 access/显式 refresh 的裸值/配对引号/行尾注释：解析后有效字节保持；使用真实共享序列化写任务临时文件，再用真实 dotenv.parse 重载；重复模拟部署至少两次仍一致。新生成值也做一次 round-trip。使用真实 jwt.sign/verify 验证保留值对应签名兼容，缺省 refresh 派生一致。
3. 注入原始值带 `#`、引号、反斜线等：按选择的部署表示契约明确拒绝或真正 round-trip 无损；不能“harness shell 变量相等”就算通过。包含无害命令替换 canary 的文件不得执行。
4. 缺失与不可读/解析错误/重复键分开，错误不可生成。真实共享选择段覆盖环境 > 配置 > 旧文件优先级，不能把已合并变量当作全部证据。
5. optional refresh 未设置：`set -u` 下跑到真实 JWT 序列化/写回/重载，结果仍为派生；保留显式 refresh 的路径不退回派生。
6. CLI 未知参数（仅合成 canary）、--help 加未知参数均非零，stdout/stderr 不含 canary 原值/标记。此测试故意使用合成 argv 验证错误路径，不能拿真实密钥试验。
7. 隔离后的 node/npm 启动测试覆盖强正例、公开 access/refresh 负例及 dev/test 不绕过；为默认配置查找设置 fail-on-access 检查，证明不会读取任务目录外 .env。

运行修改涉及的原 20 项纯函数、新部署 harness 和启动测试；保存新计数、命令及退出码，不要求维持原计数。当前仅 core 启动/部署改动；原 Jest 38/40 与两项历史失败证据保持接受，若本次进一步触碰其依赖才定点重跑并说明。不执行 PG suite/全仓 lint/build/真实 deploy/systemd。静态语法检查、diff --check、manifest 核验照旧。

## 返回与停止

按原包返回 STATUS、R1/R2/R3 实际修改、文件清单、每个新增场景结果/原始日志/机器 JSON、输入与输出 hash、兼容限制和未执行项。报告区分实际退出码、stub 计数与运行时 round-trip，不夸大为线上验证。保留损坏的原部署日志，新日志确保 UTF-8 完整，JSON 独立记录真实 rc。

应用修订只限原 P3-W0-T01 的 JWT 文件/正式测试/相关说明及必要的 JWT 专用小模块。不修改 UserManager、认证协议、AUD-039 或其他 finding，不写与本任务无关的工作记忆文件。没有 commit/stage/push/deploy 权限；完成后停止，等待 GPT 复审，不下发下个任务。

## ASTRA REVIEW HANDOFF / 模型建议

返回 task=P3-W0-T01-R1、packet、HEAD/branch、保留的原证据、修订 diff、新测试/日志、风险/限制及待裁事项。下一轮 GPT 复审建议 **GPT-6 Astra / Extra High（极高）**：跨 dotenv/部署表示/启动校验的有效密钥一致性是认证边界。CodeBuddy 沿用当前执行工具/模型；若使用 GPT 辅助实现可用 Sol / Extra High。若需改变 JWT 算法/派生或真实部署验证，先返回 DESIGN BLOCKER，不能自行扩大范围。
