# PHASE 2 — FINAL ARCHITECTURE DECISIONS

日期：2026-09-24。固定基线：`f08e72e3e74d188b4555e0bee16280b3dd0d622b`。仅设计裁决，以下均为**目标架构和未来验收条件，尚未实现或执行**。

依据：[ROOT_CAUSE_MATRIX](ROOT_CAUSE_MATRIX.md)、[PHASE2_MASTER_VERDICT](PHASE2_MASTER_VERDICT.md)、[原依赖图](REMEDIATION_DEPENDENCY_GRAPH.md) 与 [最终严重度](FINAL_SEVERITY_ARBITRATION.md)。沿用 RC-01…RC-10 及原 23 项映射，不重新审计或扩大 inventory。AUD-007、025 降为 P2 不改变所在架构边界。

## 决策总表

| RC | Issues | 最终目标 |
|---|---|---|
| RC-01 | 001, 002 | 统一 tenant + subject + operation 身份契约，浏览器存储与服务端幂等分别实现 |
| RC-02 | 010, 012, 014, 015, 016 | 持久化 school/user epoch + session version + refresh family，统一认证与失效事务 |
| RC-03 | 004, 005, 006, 007 | 可恢复任务状态机、隔离命名空间、一致快照、写屏障、原子发布与安全切换 |
| RC-04 | 008, 009 | migration-first，全新/已有库双路径验收，启动 drift detection / fail-fast |
| RC-05 | 003 | 按输出上下文划分的统一 safe rendering abstraction |
| RC-06 | 021, 022 | 持久化离线 mutation 状态机 + CAS + 显式冲突处理 |
| RC-07 | 020 | 专用导出 job/endpoint，服务端一致读取并流式生成；列表分页明确覆盖范围 |
| RC-08 | 017, 047 | 显式资源授权；报告平台权限与学校 grant 生命周期分别落实 |
| RC-09 | 025, 027 | 两个独立子边界：结论归一；不可变审计主体和历史保留 |
| RC-10 | 039, 044 | 两个入口门禁：测试隔离身份；生产 secret 校验 |

“统一”指语义与不变量统一，不要求所有组件共用一张表、一个库或一个 helper。RC-08/09/10 不再相互合并；RC-09 的两个问题不是同一具体失效机制，保留原编号用于追踪，分子模块、分发布门禁。RC-01 与 RC-06 共享客户端文件面但仍是独立设计。

## RC-01 — scoped state identity

**最终目标。**身份由 `tenantImmutableId + tenantGeneration + subjectImmutableId + operationNamespace + resourceId/method + contractVersion` 构成；平台作用域显式标记，不能用缺失 tenant 表示“任意学校”。每个 mutation 另有稳定 operationId。学校 code、用户名和 token 字符串均不作为持久主体身份。服务端从认证上下文推导 scope，不能相信请求体声明。

| 层 | 具体契约 |
|---|---|
| browser local state | tenant/subject 分区；切换主体使旧异步回调失效，禁止回填当前缓存；缓存保存覆盖区间/版本 |
| offline queue | 每个 operation 固定归属及数据版本；重登原主体才能发送；换校、换账号不自动改绑旧任务 |
| server idempotency | **认证 → 当前授权 → 幂等查找/占位 → 执行**；键包含 scope、操作、资源、operationId，规范化 payload hash 作为同键一致性校验；同键异 payload 明确冲突，不能当新请求 |

采用独立服务端幂等执行记录，覆盖 pending/committed/failed/unknown 和重试结果；多实例写入必须共享唯一性约束，并使业务提交和幂等结果处于同一事务或等价可恢复协议。不能在业务已提交、缓存写入失败时盲目再执行。命中仍要检查当前权限/响应可见性；旧权限缓存不授予新权限。单纯 Redis SETNX 不自动提供业务恰好一次语义。

**Rejected alternatives。**仅 bodyHash、仅 tenant 前缀、认证后却授权前命中、以客户端 scope 作信任源、把浏览器缓存和 server cache 合为同一实现。原矩阵“加 scope 或移到授权后”改为两者都必须。Redis 是可选实现，非此次裁决强制引入的新基础设施。

**Migration / compatibility。**版本化本地分区；旧无归属缓存不得猜测迁给当前用户，可丢弃后重新拉取。未上传 mutation 不得静默删除或自动归属：原始数据隔离保存，仅在归属可验证时迁入，不能向新主体展示他人内容。服务端旧 Map 不复用；上线需定义旧操作去重边界。新幂等台账若采用数据库表，依赖 RC-04。旧 HTTP 响应可保持，但同键异 body/权限拒绝是有意收紧；为 RC-06 提供稳定 create 重试契约。

**Required regression tests。**双学校×双账号×guest/editor；同 key/body 不跨主体命中；同主体同 key 异 body 冲突；权限撤回后命中仍拒绝；多实例同操作只提交一次；提交后响应丢失重试；账号切换时在途响应和旧队列不能污染新分区。

## RC-02 — authoritative session / token invalidation

**最终目标。**五项必须同一 architectural wave 完成，不采用五个相互独立的时间戳/阈值补丁。建立服务端权威状态：school status/epoch、tenant-scoped user status/epoch、session ID/version/status、refresh family ID/rotation sequence/absolute expiry。access 与 refresh 携带对应不可变主体与版本；`iat` 仅用于时间属性，不再决定撤销先后。guest 和平台身份也走明确的适用状态检查。

| 事件 | 权威转换及认证结果 |
|---|---|
| school disabled | 同事务更新 status 与 school epoch；新登录、guest、access、refresh 均拒绝；重新启用不复活旧 epoch |
| logout | 当前 session/family 撤销；成功响应后该 session 的后续 access/refresh 不可用 |
| remote revoke | 校验 session 归属并撤销指定 session；撤销全部用 user epoch，不混淆其他主体 |
| password reset/change | 密码 hash 与 user epoch、必要的 family 撤销同事务提交；失败整体失败，不返回“已改密”却未撤销 |
| DB recheck failure | 权威状态不能确认即 fail-closed；基础设施故障返回可重试 503，无效凭据返回 401/403；不先放行两次，不因只读而豁免保密性 |
| same-second issue/revoke | 版本与事务提交顺序决定有效性；先签发后撤销的旧版本失效，撤销后完成新认证签发的版本按策略有效 |
| refresh rotation/replay | 锁定 family/当前序号，单次消费并生成后继；并发只能一个有效推进，响应丢失用有界幂等结果协调；已消费 token 不能独立创建另一个后继，真正重放撤销 family |

初期对在线受保护请求读取权威存储，不把最终一致缓存当撤销真值。未来缓存需证明失效传播和故障语义，不以“短 TTL”替代即时失效承诺。客户端离线保存仍可继续本地操作，重新上传须重新认证。

**事务与并发边界。**当前 public/tenant 分离的 Prisma client 不等于跨 client 的同一事务。目标需要在一个数据库事务连接内完成相关 schema 的密码/epoch 变更，或先建立同事务可用的权威身份存储；禁止拿两个顺序 await 冒充原子性。签发与撤销竞争须序列化或验证版本，不能在密码验证已过期后用新 epoch 签出旧凭据会话。成功撤销后新开始的请求必须拒绝；已进入业务事务的写操作采用提交前版本核验/协调锁，定义先提交者胜出的顺序，不声称能追回已经发送的数据。

**Rejected alternatives。**`iat+epsilon`、只删 Session 展示行、仅缩短 access TTL、五处分散黑名单、故障时信任 JWT 中旧角色，以及允许任何旧 refresh 无限制换取新版本。Session/epoch 是同一模型，不能继续让 Session 只承担在线列表显示。

**Migration / compatibility。**选择持久化模型，因此**确需 schema migration**，修正原矩阵“不涉及 schema（除非落库）”的模糊结论。expand 添加状态和索引、回填、发布可理解新字段的代码、再统一 enforcement。旧 token 缺少 sid/epoch 无法证明归属时，最终切换强制重新登录；不能默认赋予最新 epoch，也不能靠旧 refresh 自动升级。准备阶段双版本读取不计为修复完成；强制点必须退出不安全兼容。旧 session UI 可读适配，新撤销必须命中新模型。混合实例切换须摘除旧认证节点。refresh family 要有绝对最长寿命，不能靠无限轮转规避策略。

**Required regression tests。**上述事件×access/refresh/guest×多实例；固定时钟同秒两种次序；停校后重启/重新启用；密码写入或 epoch 写入中途失败；认证 DB 故障首个请求即关闭；并发改密/签发/refresh/logout；family 重放与合法并发；缺字段旧 token、旧节点、进程重启不恢复撤销状态。与 RC-03 联测旧数据库快照恢复后 epoch 不回退复活凭据。

## RC-03 — backup / restore engine

**最终目标。**四项由同一引擎边界负责，004+005 作为恢复切换单元，006+007 作为备份产物单元。全部要求均采纳：

| 必备能力 | 最终语义 |
|---|---|
| unique job identity | 高熵 jobId，从 API/CLI/scheduler 入口贯穿任务、文件、schema、日志与恢复重试 |
| non-tenant workspace namespace | 独立保留命名空间，租户注册不能创建该前缀；更换随机后缀仍须验证 owner |
| per-school exclusive lock | 跨进程、跨实例协调维护任务；all-scope 按稳定顺序获取覆盖学校及 public 的协调权，防死锁；锁/租约丢失立即停止推进 |
| write barrier | 恢复 staging 前阻止目标的新写入，覆盖 API、sync、后台、CLI、审计/session 写入和管理通道；网关只辅助，应用/DB 协议才是约束 |
| in-flight drain | 安装屏障后等待旧写事务终结，再开始恢复；超时中止或明确取消，不把已确认新写入静默丢弃 |
| consistent DB snapshot | 计数、结构、scope 清单与 dump 共享同一快照边界；固定连接持有导出快照直至消费者结束；协调 schema DDL/租户生命周期，不能仅两个 REPEATABLE READ 各自启动 |
| isolated temporary workspace | 每 job 私有文件目录、最小权限；明文和暂存 schema 归属记账，崩溃后有可核验清理路径 |
| atomic artifact publication | 加密内容、meta、校验信息作为一个版本化 package，先完整生成校验，再以原子目录切换/manifest 提交发布；不得逐个 rename 就宣布整体原子 |
| safe cleanup ownership | 仅清理本 job 登记且再次核验归属的对象；未知/失去锁的任务不按拼接路径 DROP/unlink；清理可重入 |
| tenant client reconnect | 切换时停止新 client 借出、排空旧读/写连接、断开所有实例目标池；切换后重建并验证，旧连接不可继续命中旧 schema |

备份使用 MVCC 一致快照，正常备份不要求暂停所有业务写入；维护任务锁用于避免与恢复/DDL等冲突。恢复屏障必须覆盖整个从 staging 到 cutover 的写入风险窗口。`READONLY_MODE` 人工设定或 Caddy 拦 HTTP 无法阻断后台/直连写入，不能单独作为正确性保证。

建议任务状态：`QUEUED → LOCKED → BARRIER/DRAINED（恢复）→ SNAPSHOTTING/STAGING → VALIDATING → PUBLISHING/SWITCHING → RECONNECTING（恢复）→ SUCCEEDED`；异常转 `FAILED/RECOVERY_REQUIRED`，持久台账记录 owner、fencing generation、旧/新对象及完成标志。切换只允许持当前执行权的进程推进；服务重启不能靠过期进程内标记猜测继续执行。

**Rejected alternatives。**随机文件名作为唯一修复、全局进程内 mutex、单加锁而不 drain、按校名拼接 DROP、恢复时关闭行数校验、发布未配齐 meta 的 aes、恢复成功前删除旧 schema。无依据保留“零影响在线恢复”承诺。

**Migration / compatibility。**任务台账/屏障世代走 RC-04 migration；新 package 显式 format/schema version、scope、jobId、计数和完整性信息。旧备份只读兼容并分类验证，未知/不一致必须明确拒绝，不能静默改 meta。恢复旧业务快照后，当前 session epoch/授权生命周期不能随历史数据回退；恢复凭据状态需重新生成失效世代/强制登录。灾备引导台账/密钥恢复程序不能依赖已损坏的业务库先正常运行。

**Rollback boundary。**切换前删除本任务暂存可回滚；切换后但写屏障尚未解除可经验证切回保留的旧 schema。新写入开放后禁止简单 rename 回旧库，须按数据恢复事件处理，否则再次 lost update。业务恢复点以前的历史回退必须明确展示，不可与恢复过程中丢失已确认写入混为一谈。

**Required regression tests。**合法学校名撞暂存名；两实例同校恢复只一方推进；不同校隔离；timer/manual/API 同 scope 同秒备份；一方失败不得删除成功方产物；持续写入备份后隔离恢复逐表一致；屏障覆盖后台与在途事务；每阶段崩溃/锁丢失/磁盘满；package 半发布不可见；旧池断开及新池查询；恢复后凭据不复活；旧产物兼容和断电后的任务恢复。

## RC-04 — migration-first schema evolution

**最终目标。**public 与每个 tenant 都有可回放、可诊断、可核验版本的 schema 演进路径。部署 migration 成功后才开放 readiness；启动只做 drift detection，不修改结构，不执行 `db push --accept-data-loss`。未知漂移、单租户失败和 failed migration 均必须失败退出/阻断对应能力；不能只记录告警再返回总成功。停用学校也在升级清单内，重新启用前必须通过版本检查。

**AUD-008 → AUD-009 裁决。**完整替换旧自愈、保持受支持升级可用性时，008 的可回放链及存量升级路径是 009 最终切换的硬前置；但不是“禁止先止损”的绝对 issue 顺序。可以先禁破坏性 push、失败即不开放服务，代价是明确维护/不可用，不能宣称 009 已完整交付兼容升级。两项可同一版本按 migrate→check 顺序发布，不要求隔一次发布。

**Migration implications。**原方案“baseline 与 unify 之间插入幂等补丁”是候选，不在未知历史上直接照搬。须按受支持状态分支：空库；正常已应用旧链；runtime db push 演进库；failed 记录；曾 resolve 标记的库；停用租户。保留已应用 migration 内容/checksum，不篡改 baseline；在测试副本证明补丁顺序、实际列类型/默认值/约束一致后，确定 bridge migration 或显式 baseline/repair 流程。`IF NOT EXISTS` 只解决名称存在，不证明类型/数据语义一致。failed 状态仅在检查实际部分执行结果后按受控 runbook resolve；不得自动删 migration 历史或失败后盲退 db push。

**Compatibility implications。**采用 expand → 兼容应用 → 回填/校验 → enforce → 后续 contract。新 schema 依赖的应用不能先接流量；旧应用仅在安全且兼容 additive schema 时回退。保留 stderr、租户结果与非零退出码。生产 `_prisma_migrations` 实际状态本轮未知；它是未来升级操作选择的 entry criterion，不阻止本轮架构裁决，也不触发本轮生产读取。

**Rejected alternatives。**只修 fresh install、只改 AUTO_SYNC 默认值、启动时 `db push` 自愈、所有失败自动 resolve applied、只检查 active 学校、仅靠全量数据库备份当通用 down migration。

**Required regression tests。**上述六类历史状态的空库回放/升级矩阵；租户 active/disabled；未知漂移与单校失败阻断 readiness/非零退出码；并发部署仅一个 migration 执行者；已有数据与约束不丢失；中断后重跑不重复破坏；旧兼容应用回滚验证。所有测试在明确隔离环境进行。

## RC-05 — safe rendering abstraction

**最终目标。**采用统一渲染边界与上下文专用 API，实施时迁移已确认的列表、详情、导出预览 sink。共享安全策略，不用一个 escapeHtml 函数兼任全部上下文。

| 数据/上下文 | 输出策略 |
|---|---|
| 普通文本 | `textContent`、文本节点或模板默认文本绑定；不解释业务字段内标签 |
| HTML 结构 | 可信静态模板/DOM 构造；动态文本经文本绑定，禁止拼入原始 innerHTML；确需 HTML 的入口显式区分 |
| attribute | 仅允许固定安全属性名，通过 DOM property/setAttribute 赋值；事件用 addEventListener，禁止动态 on*、srcdoc 等可执行属性；DOM API 不是任意属性安全许可 |
| URL | 先解析并校验协议/来源/用途白名单，再赋值 href/src；拒绝 javascript 等执行协议，不能仅 HTML 转义 |
| rich text | 仅明确需要富文本的字段使用经过维护的白名单 sanitizer；限制元素、属性与 URL；输出类型与普通字符串区分，净化后不再拼接不可信内容 |

**Rejected alternatives。**逐个 sink 临时 escape、输入端删标签当全局防护、以 CSP 替代输出策略、把同一 helper 同时承载结论归一。CSP 为独立纵深防护，不作为关闭 AUD-003 的必需大改造。

**Migration / compatibility。**无数据 schema 迁移。保留原始业务文本，不批量删除看似 HTML 的历史数据以掩盖漏洞；修复后恶意标签应显示为文本或按明确富文本规则净化。历史内容调查另走有范围的修复任务，本轮不扩审。收敛分叉 helper，保持打印/导出预览布局与事件绑定行为。

**Required regression tests。**已确认列表/详情/预览的标签、引号、属性闭合、实体变体、URL 协议负例；合法中英文及特殊字符不双重转义；可点击元素仍工作；富文本允许项保留、危险项拒绝；CSP 关闭时仍安全。既有证据为注入路径成立，不把未演示的脚本执行声称为本轮实测。

## RC-06 — offline mutation state machine

**最终目标。**AUD-021/022 必须同批协议切换。队列/本地记录/ID 映射置于可原子更新的本地持久存储；不是只加几个枚举。每条 mutation 保存 scope、stable operationId、tempId/serverId、desiredRevision、已发送 revision/payload、baseVersion/baseSnapshot、状态与错误。网络超时表示结果未知，不表示 server 未提交。

| State | 进入、转换与不变量 |
|---|---|
| LOCAL_NEW | 新建尚未排队；本地编辑更新 desired；保存原子进入 CREATE_PENDING；删除可本地取消 |
| CREATE_PENDING | create 未发出；编辑合并待发 payload；删除取消 create 和本地行，不发 DELETE |
| CREATE_IN_FLIGHT | 固定已发送 payload/revision 和 operationId；后续编辑记为新 desired revision，不能改写已发包；删除记 tombstone/cancel intent |
| SERVER_CREATED | create 确认后原子保存 temp ID → server ID、server version、canonical response 和队列引用；尚有 tombstone 转 DELETE_PENDING，有更新 revision 转 UPDATE_PENDING，否则 SYNCED |
| UPDATE_PENDING | 带 baseVersion 的有序更新；在途更新另记 sentRevision，后续编辑仍保留；成功仅确认已发送 revision，有残余差异继续排队 |
| DELETE_PENDING | 隐藏本地行但保留 tombstone；已知 server ID 才发送带版本删除；create 结果未知时先用原 operationId 查明/重试，然后补偿删除 |
| CONFLICT | 409 后停止自动写；保存 base/local/latest 三份，显式显示冲突；解决后以新 operation revision 和 latest version 重新提交 |
| SYNCED | 本地 desired 与已确认服务端版本一致，无悬挂任务；再编辑进入 UPDATE_PENDING，再删除进入 DELETE_PENDING |
| FAILED | 保存数据、归属与可解释错误；临时网络故障可退避回原 pending；权限/验证错误需修正后重试；未知提交不能新建 operationId 猜重试 |

成功删除进入已确认 tombstone/本地清理终态，不复活幽灵行。create 期间编辑：先完成映射，再提交差额；绝不将旧 create 响应覆盖新 desired。create 尚未发出时删除无需服务器操作；已发出时删除必须等结果确认，不能忘记可能已存在的服务端行。重启后重放状态机，不能只依赖内存回调。

**409 / lost update prevention。**服务端所有相关更新/同步/删除入口执行原子 CAS，失败返回 latestVersion 和有权限读取的 latest snapshot/字段差异。客户端不得只替换 version 原样重试。base-local-server 三方比较只可自动合并双方独立修改且业务约束允许的字段；同字段、删除对修改、相关联字段冲突必须显式处理。解决后仍做 CAS，再竞争则再次冲突。明确确认覆盖应形成新的用户操作和审计，不冒充透明重试。

**Rejected alternatives。**只改 temp ID 字符串、在 create 出队前临时合并、409 无限换 version、把全量 stale PUT 当“合并”、把新增 409 字段视为旧客户端安全保障。旧客户端忽略新字段后仍可能读版本并覆盖，原依赖图对此过于乐观。

**Migration / compatibility。**先准备 v2 写协议和 RC-01 幂等能力，再迁移分区队列并切换；未提交数据备份/可恢复且不能跨主体展示。旧客户端写入必须在所有旧 mutation 通道被版本门禁明确拒绝并提示升级（例如 426/明确协议错误），或提供已证明安全的服务端适配器；保留旧版读取不等于保留不安全写语义。协议版本不是安全授权凭据，租户授权仍由服务端验证。存储升级后不让旧 JS 重读新队列；回滚保留/冻结队列，不能降回旧自动覆盖算法。

**Required regression tests。**离线建→改→删；create 在途多次 edit/delete；提交成功响应丢失；重启发生在映射事务前后；双标签页同操作；双人不同字段/同字段编辑；删除与更新竞争；409 连续变化；授权失效后队列不跨用户；旧客户端请求被明确阻断；所有成功保存有 durable 本地或服务器确认依据。

## RC-07 — complete export / read contract

**最终目标。**选择 **dedicated export endpoint + server-side snapshot read + streaming artifact generation**：提交带筛选/权限上下文的导出 job，服务端在固定数据快照内按稳定顺序分批读取、流式写私有产物；完成后校验 expectedCount/exportedCount、筛选范围、schema/判定版本、校验和，再原子发布。下载可以流式传输已完成产物。创建、查询状态、下载均校验当前主体权限与资源归属。

此方案避免长 HTTP 响应已返回 200 后才发现少页，却把残缺文件当成功。job 失败/超限只返回明确失败，不发布“完整”报告。快照或数据库资源无法满足完整读取时明确拒绝/排队，不能退回固定 limit。导出取消、临时文件清理和资源上限均可观测。

列表使用服务端分页（优先稳定 cursor）；接口返回 hasMore/nextCursor、total 的计算口径和过滤条件。本地缓存标为部分窗口；看板全局总量由服务端同口径统计提供。离线报告只可明确标注本地覆盖范围/未同步项，不能声称全量。

**Rejected alternatives。**增大 limit；继续忽略 total；只修导出而列表缓存仍冒充全量；无快照的 offset client loop 在并发写入下声称完整。客户端分页循环可用于明确有界的普通读取，若作为导出替代必须有 snapshot cursor、页去重、完整性验收，当前不选为权威导出方案。

**Migration / compatibility。**无业务数据迁移；新 job/manifest 格式和 API 版本需兼容下载 UI。若 job 存入新表，依赖 RC-04；若用现有可靠任务设施，须证明持久状态/原子发布而不假定其已存在。旧导出入口在 cutover 后适配新 job 或明确报错，不能继续静默截断。缓存升级把“完整”状态改为覆盖范围元数据；原 26 个 P2 不因跨模块联测自动纳入本次关闭范围。

**Required regression tests。**0/1/1000/2000/2501/10000+ 条；跨页插入/删除/更新；expectedCount=exportedCount 且 ID 无重漏；中途 DB/磁盘/网络失败；取消/超限；旧接口和离线部分数据明确提示；权限撤销后不得下载旧产物；列表、看板、导出在相同快照/筛选条件下数值一致。

## RC-08 — authorization scope and lifecycle

**最终目标。**保持两个子边界，区别于 RC-02 凭据失效传播。

- **AUD-017：**生产全局测试报告默认仅平台授权管理角色可读写；guest/普通学校身份拒绝，包括 evidence 读写和批量 close/mark-fixed。若未来保留学校测试协作，使用显式 participant grant（任务/学校、读/提交/结案/修复能力），不是直接放开全局；该扩展不是本轮修复前置。
- **AUD-047：**grant 绑定不可复用 schoolId + generation + 对接方身份，code 只作显示/查找别名。删除学校在同一生命周期事务撤销 grant；同 code 新学校产生新身份。回收站恢复同一学校也默认保持 grant revoked，平台显式重授并留痕，避免历史授权自动复活。

**Rejected alternatives。**“任意登录即可”、只隐藏前端、用 code 作为永久授权主体、删除时清 grant 却保留重建自动绑定规则、把 RBAC 与 session epoch 合为一份通用缓存。

**Migration / compatibility。**017 的立即角色收紧可无 schema；047 的不可变关联/世代走 RC-04。存量 grant 只在唯一身份可证明时映射；孤儿、歧义、已删除学校授权隔离为无效，不按 code 猜测。对接方 API 返回结构可保持，授权变化需影响清单/明确错误；恢复后的重授是明确业务策略。RC-01 应使用同一 tenant identity 定义，不重复发明不同世代。

**Required regression tests。**每个报告/evidence 端点×guest/viewer/operator/manager/platform；跨校/跨任务 ID、批量混入无权 ID；学校删除/同 code 新建/回收站恢复；旧 API key/grant 不重新附着；失效请求与生命周期事务竞争。017 不依赖 047 migration 才能收紧。

## RC-09 — domain conclusion / audit retention

### RC-09a / AUD-025：结论事实源

**最终目标。**定义单一版本化领域规则与测试向量，得到 `qualified / unqualified / unknown` 及 reason；JS/SQL 若分别执行，应由同一规范生成或用同一契约用例验证，不能假装前端函数可直接用于 SQL。合法颜色 `合格/警戒/不合格` 按既有业务定义映射；未知非空 colorLevel 返回 unknown，不能默认合格；空值按明确 result 映射，冲突 precedence 显式记录。所有新写入口校验枚举，legacy 未知保留原值并标明待判定。

**Rejected alternatives。**NOT LIKE 反向推断、只改内部 SQL、把警戒擅自改为不合格、借输入校验重写历史检测事实。与 RC-05 输出编码不共用 helper。

**Migration / compatibility。**无必然 schema 变更；统一内部/guest/OpenAPI/前端/导出规则版本。统计返回 qualified/unqualified/unknown/total；合格率及分母明确，unknown 不隐式丢弃且不计合格，已知子集合比率若提供须另标注。历史统计可重算，已发布报告需标明更正版本，不能自动覆盖外部原件。

**Required regression tests。**三种合法颜色×合法/冲突 result、空/null、未知值、legacy payload；各出口相同输入相同结论；总量分解及分母；新 API/sync/legacy 写通道校验一致，原始历史值不被统计修复改写。

### RC-09b / AUD-027：审计历史独立存续

**最终目标。**选择 **immutable AuditPrincipal + event actor snapshot**。principal 标识原 tenant generation 与主体不可变身份，和登录 User 生命周期解耦；AuditLog→principal 外键 `RESTRICT`。可选 principal/live User 关联允许 `SET NULL`，历史仍能用 principal/snapshot 查询。事件保存当时身份显示信息、权限上下文及来源；账号日常“删除”采用 soft delete/失效，后续物理清理不删除 principal 或历史。

| 候选 | 裁决 |
|---|---|
| User FK RESTRICT | 可作最早止损，阻止删除有历史用户；单用会把正常账号清理永久绑死，不作为最终模型 |
| SET NULL | 仅配合 principal/snapshot 可用；只清空 user_id 会丢失历史归属解释 |
| actor snapshot | 必须有，避免用户名/角色变化改写历史含义；存储最少必要信息 |
| soft delete | 采用为常规账号生命周期；不能单独替代审计 FK 防护和受控物理清理 |
| immutable audit principal | 采用为持久锚点；审计保留不再依赖可删除登录 User |

**Migration / compatibility。**先阻止破坏性 user delete/cascade，再 expand 新主体与 snapshot、回填、双写、校验行数/可查询性，最后切换 FK 与读取；不能在回填窗口继续允许历史级联消失。存量快照只能依据现有事实，当前姓名回填须标记 backfilled/observedAt，不能虚构当时角色；已经消失的历史不声称可被 migration 恢复。读取兼容旧 userId 过滤，通过 principal 映射查询。保留期限由业务制定，独立到期销毁流程须受控留痕；本轮不发明法定年限。

**Rejected alternatives。**只留下 user_delete 一条记录、用 SystemLog 代替 Application AuditLog、删除前导出一次即视为长期可查询、仍允许普通应用路径任意删除审计。应用级 append-only 与 DB 权限约束共同落实；不声称可抵御拥有全部数据库权限的管理员。

**Required regression tests。**只有审计无 TestRecord 的用户停用/删除/物理清理后历史数量、主体快照及检索不变；删除者和目标者的历史分别保留；重名新账号不继承旧身份；SystemLog 与 AuditLog 均可查；回填中断重试；约束阻止 cascade；新旧 API 过滤一致。

## RC-10 — environment and secret entry guards

**最终目标。**保持原环境防护分组，两个实现分别验收。

- **AUD-039：**测试必须使用显式专用 TEST_DATABASE_URL/隔离实例与受限角色；连接身份、数据库和任务专属 namespace 在任何破坏性 DDL 前核验。缺失变量立即拒绝，不能回退 DATABASE_URL 或隐式加载业务 .env。仅库名含 test 不够；独立角色权限与实例隔离构成第二道约束。清理只覆盖本任务登记的对象。
- **AUD-044：**服务监听前统一校验 access/refresh secret；拒绝空值、全部仓库占位/示例值与已知弱值，要求足够字节长度和明确编码；配置流程以密码学安全随机生成或受控 secret 注入为来源。字符串长度/估算熵不能证明真实随机性。所有 npm/node/service/deploy 入口共用强制校验，非空已有配置也须检查；不打印秘密。

**Rejected alternatives。**确认提示代替门禁、仅 NODE_ENV=test、只靠 URL 字符串、只把一个示例值加入名单、把 deploy.sh“空值自动生成”当所有入口的强制验证。039 属环境隔离，不与 RC-04 migration 机制合并；044 属认证配置，不与 RC-02 session 真值合并。

**Migration / compatibility。**无业务 schema 变更；CI 和本地测试需显式隔离配置。合法强密钥不强制变格式，迁移旧弱配置须停用并重新生成；如果确实使用过公开密钥，轮换及会话失效不能保留旧弱值作为兼容验签 key。是否现网弱密钥本轮未知，不执行检查/轮换。

**Required regression tests。**危险测试 URL/角色/namespace 在任何 DDL 前拒绝，隔离配置允许；从普通 npm test 间接入口也不能绕过；示例、空、弱值在标准 production start 必拒；合法生成值可启动；非空示例经 deploy 复用路径也被拒；错误日志不含 secret。测试启动检查使用隔离/替身环境，不对生产连接做试验。

## 跨边界交付规则

RC-04 提供 schema 演进前置，RC-02/03/08/09 以及选择持久台账的 RC-01/07 依次使用，不能在启动函数新增 DDL 自愈。RC-01 身份定义与 RC-08 学校身份保持一致；RC-06 create 重试依赖 RC-01 的服务端幂等契约。RC-03 恢复与 RC-02/08 联测历史状态不复活凭据/授权，属于集成门禁，不强行合并 root cause。

最终交付仍是 10 个 RC、原 23 项（其中 21 P1、2 P2）的修复设计；没有因此关闭原 26 个 P2 或候选。具体波次、硬依赖和回滚边界见 [FINAL_REMEDIATION_WAVES](FINAL_REMEDIATION_WAVES.md)。
