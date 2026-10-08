# ROOT CAUSE MATRIX — Phase 2 合并根因分析

- **基线**：`f08e72e3e74d188b4555e0bee16280b3dd0d622b`
- **覆盖**：第一遍 23 个 P1（Phase 2 A/B/C 全部 CONFIRMED）
- **目的**：不做"23 个 issue 各自修复"的规划，而是识别系统性共同根因，说明为何补丁式修复危险

## 对预设 RC 列表的调整说明（保留编号，明确边界）

| 决策 | 内容 | 理由 |
|---|---|---|
| 保留 RC-01…RC-10 | 编号与语义沿用用户给定的候选清单 | 10 个 RC 已能**无重叠、无遗漏**覆盖 23 项（映射见下），无需合并或新增 |
| 明确 RC-02 与 RC-08 的边界 | RC-02 = **已签发凭据的失效传播**（token/session）；RC-08 = **授权实体本身的范围与生命周期**（谁能访问什么、授权何时失效） | AUD-012/015/016 是"吊销如何传导"，AUD-017/047 是"授权范围/实体生命周期"，修复对象与迁移影响不同 |
| AUD-039 归 RC-10 而非 RC-04 | RC-04 = schema 演进方法；RC-10 = 环境/配置防护 | 039 的失效模式是"测试误连业务库 + 固定 schema 破坏性清理"，属环境防护缺失；其修复不需要 migration 纪律（但 039 的**修复方向**要避免引入新的不可回放变更） |
| AUD-047 归 RC-08 而非 RC-01 | RC-01 = 缓存键缺租户/主体维度；RC-08 = 授权实体与资源生命周期解耦 | 047 的缺陷不在"键"，而在 grant 以文本 code 关联可复用的学校生命周期 |
| 不合并 RC-01 与 RC-06 | 两者共享 `Storage`/`AdaptiveUploadQueue` 文件面，但根因不同：**隔离维度缺失** vs **本地先行语义缺失** | 合并会导致修复方案互相污染（隔离前缀不解决状态机丢失，状态机不解决跨主体命中） |

## 覆盖映射（23/23）

| RC | Issue | 数量 |
|---|---|---|
| RC-01 | 001, 002 | 2 |
| RC-02 | 010, 012, 014, 015, 016 | 5 |
| RC-03 | 004, 005, 006, 007 | 4 |
| RC-04 | 008, 009 | 2 |
| RC-05 | 003 | 1 |
| RC-06 | 021, 022 | 2 |
| RC-07 | 020 | 1 |
| RC-08 | 017, 047 | 2 |
| RC-09 | 025, 027 | 2 |
| RC-10 | 039, 044 | 2 |
| **合计** | | **23** |

---

## RC-01 · Tenant / Subject scoped state（缓存作用域缺失）

- **Affected Issues**：AUD-001（客户端缓存/离线队列键 `cache_<table>`/`pending_<table>`，`Storage.js:61-62`）、AUD-002（服务端幂等键 `${key}:${bodyHash}`，`idempotencyMiddleware.js:40`）
- **Shared Failure Mechanism**：命中判定以"内容等价"为唯一条件，**不包含租户与主体维度**，且在客户端表现为跨主体共享本地存储、在服务端表现为缓存短路**先于** authenticateUser/requireEditorOrAbove（`recordRoutes.js:20-21` vs `:280`）。
- **Why patch-per-issue is dangerous**：只给服务端键加 `tenant:subject` 前缀，客户端仍跨主体读缓存（AUD-001 原样存在）；只改客户端键，服务端仍可被 B 校 guest 命中 A 校写响应；两侧键格式若不一致，未来引入共享存储（NF-A-02）还要再改一次语义。
- **Preferred architectural boundary**：建立统一的"缓存作用域"抽象（tenant + subject + resource + method），由读取/写入入口统一注入；服务端幂等中间件移到认证与授权之后（或以 tenant/subject 绑定键并缓存脱敏响应）。
- **Migration implications**：客户端缓存键变更需一次性迁移或丢弃旧缓存（用户会经历一次"本地历史消失"）；服务端幂等为进程内 Map（NF-A-02），键格式变更与"引入共享存储"应同批完成，避免两次语义切换。
- **Test implications**：跨租户/跨主体命中矩阵（A/B 校 × operator/guest/viewer）；缓存命中时守卫调用计数为 0 的回归用例；body 键顺序/等价的边界。
- **Deployment implications**：多实例部署下当前幂等 store 不共享（NF-A-02），键改造需与共享存储（Redis）引入计划对齐；无 schema 变更。

---

## RC-02 · Credential / session invalidation（身份态真值分散、失效非强制）

- **Affected Issues**：AUD-010（停校不阻断，`schoolRoutes.js:404-422`）、AUD-012（logout 无吊销、Session 不参与认证）、AUD-014（fail-soft 放行两次）、AUD-015（iat+1 边界）、AUD-016（吊销非原子、失败被吞）
- **Shared Failure Mechanism**：授权真值分散在 **User / School / Session / public.revoked_tokens** 四个存储；失效**依赖显式写入**，而写入既非强制（logout/停校不写）、也非全路径覆盖、失败还不向调用方上报；回查失败时按进程级计数 fail-soft 放行；全量吊销以 `revoked_at >= to_timestamp(iat+1)` 比较。
- **Why patch-per-issue is dangerous**：只修 logout（012）不修停校（010）→ 停校后仍可登录；只收紧 fail-soft（014）→ 无共享缓存时 PG 抖动会导致全站 503 雪崩（该机制是刻意折中）；只修原子性（016）不改边界（015）→ 同秒窗口仍在；五项共享"当前有效授权无法及时收敛"的语义，逐项修补会反复触碰同一批中间件与 UserManager。
- **Preferred architectural boundary**：引入**统一 session/token epoch**（用户级 + 学校级世代），认证入口集中校验（token 携带的 epoch 与权威值比较）；吊销/降权/停校与业务变更**同事务**写入；fail-soft 仅限"可证明只读"的能力或明确时限；iat+1 被 epoch 取代。
- **Migration implications**：token payload 可能新增 session/epoch 字段 → 需要**两阶段兼容**（先发兼容期双读，再强制）；存量 refresh token 的有效性策略需业务确认；不涉及 schema 变更（除非把 epoch 落库为字段）。
- **Test implications**：固定时钟覆盖"同秒先签发后吊销 / 先吊销后签发"；停校、登出、改密、降权、删除的失效矩阵；DB 故障窗口内的状态序列（含 200/200/503 的回归）；多实例交错请求。
- **Deployment implications**：`AUTH_DB_RECHECK_FAIL_THRESHOLD` 需从"未覆盖的默认值"变为显式运维策略；若引入共享缓存/存储需部署 Redis 或等价物；学校停用/启用应触发一次批量失效（成本与限流需评估）。

---

## RC-03 · Backup / Restore state machine（备份恢复缺状态机与命名空间）

- **Affected Issues**：AUD-004（暂存名 `school_<code>_restore` 与合法学校撞名 + 两处无 ownership 的 DROP CASCADE）、AUD-005（无 mutex/advisory lock/drain/写屏障）、AUD-006（计数/结构/dump 三个时间点）、AUD-007（文件名仅 scope+秒级、失败互删）
- **Shared Failure Mechanism**：备份与恢复都以**非独占、非原子、无归属登记**的方式操作共享命名空间（schema 名、文件名）与共享数据（无共享快照）；恢复的说明文档承诺"影子/零影响"，但代码没有落实 ownership 与互斥。
- **Why patch-per-issue is dangerous**：只给暂存名加随机后缀（004）→ 并发恢复仍互相覆盖/互删（005 的机制不变）；只加 advisory lock（005）→ DROP 仍可能命中他人 schema（004 的 ownership 缺失不变）；只给文件名加熵（007）→ 失败清理仍按路径互删；只改计数快照（006）→ 备份产物命名与并发问题仍在。四项共同要求"任务可标识 + 命名空间独占 + 失败只清理自己的对象"。
- **Preferred architectural boundary**：恢复 = **持久化状态机**（任务台账含 owner/目标/暂存 schema 归属/阶段），暂存 schema 随机且登记，切换前校验目标仍属本任务；备份 = **单任务独占命名空间**（随机 ID + 专属目录 + 原子发布）+ 同一快照下取计数（`REPEATABLE READ` + `pg_export_snapshot` 传递或从 dump 反推）。
- **Migration implications**：若用 public 系统表保存恢复/备份任务台账，**必须产出可空库回放的新 migration**（依赖 RC-04 的纪律，否则加剧 AUD-008）；不使用 schema 变更的替代方案是文件系统/进程内台账（多实例不安全，不推荐）。
- **Test implications**：并发恢复（两请求只一个获得执行权、失败清理不触碰他人）；并发同范围备份（产物互不覆盖、失败不删对方）；固定时钟的文件名用例；持续写入期间备份→隔离恢复的计数一致性。
- **Deployment implications**：恢复窗口的写屏障需 **Caddy 层 + `READONLY_MODE` 联动**（把当前的人工流程代码化）；备份目录/磁盘水位/定时任务与手动触发的并发策略；`RESTORE_DROP_OLD` 语义需与保留策略对齐。

---

## RC-04 · Schema evolution / migration discipline（演进方法失控）

- **Affected Issues**：AUD-008（空库回放断裂：列由运行时 DDL 引入、baseline 无该列而后续 ALTER 引用）、AUD-009（启动自愈默认 `db push --accept-data-loss`，单校失败被吞、db:sync 退出码 0）
- **Shared Failure Mechanism**：**schema 变更存在两条并行通道**（migration 与运行时 db push/`ADD COLUMN IF NOT EXISTS`），且两者不同步：migration 链只对"db push 演进过的库"自洽；启动自愈用破坏性参数兜底漂移，失败不阻断发布。
- **Why patch-per-issue is dangerous**：只修 008（补 migration）而不动自愈 → 下次改 schema 仍会被 db push 抢先应用，migration 链继续失真；只去掉 `--accept-data-loss`（009）→ 租户 P2022 漂移立即回归（该自愈的存在理由）；只改 deploy.sh 的回退分支 → 空库仍不可部署、failed 记录仍会卡住后续部署。008 与 009 是同一枚硬币的两面。
- **Preferred architectural boundary**：**schema 变更唯一入口 = migration**（含租户 schema 的迁移产物）；启动自愈降级为"检查 + 告警 + 明确退出码"，不做破坏性应用；deploy.sh 失败必须可诊断（保留 stderr）且对 failed 记录有明确处理路径。
- **Migration implications**：在 baseline 与 `unify_school_customization_text` 之间**插入补丁 migration**（全部 `ADD COLUMN IF NOT EXISTS`，类型与当时生产一致），已 resolve 的库幂等无害、空库回放可通过；**不修改 baseline 文件本身**；生产接入取决于 `_prisma_migrations` 实际状态（需只读确认，Astra 仲裁项）。
- **Test implications**：空库 `migrate deploy` 全通过；受支持旧版库升级通过；租户 schema 与 public 结构一致性检查；把上述纳入部署门禁（CI）。
- **Deployment implications**：deploy.sh（stderr、failed 记录、首部署回退语义）、`AUTO_SYNC_TENANTS` 默认值、`npm run db:sync` 的退出码语义、多实例启动自愈的并发（当前每实例都会跑）。

---

## RC-05 · Output encoding（输出编码与净化边界缺失）

- **Affected Issues**：AUD-003（`GenericTest.js:1332/1345-1347/350-352`、`Pathogen.js:1181` 的 innerHTML；后端 `sanitizeObjectKeys` 仅键名净化）
- **Shared Failure Mechanism**：渲染层以字符串拼接组织 HTML，业务字段直接进入元素与**属性上下文**；仓库存在 7+ 份分叉的 `escapeHtml`（NF-C-02）；页面级与网关层均无 CSP（`server.js:205-207` 仅 `/api/*`；`deploy.sh:836-841` 无 CSP）。
- **Why patch-per-issue is dangerous**：逐处补 `escapeHtml` 会遗漏详情弹窗（NF-C-01）、导出预览与其它模块；且各模块自带实现语义不一，修复本身会引入新的不一致（转义过度导致显示错误 vs 遗漏）。
- **Preferred architectural boundary**：统一的输出编码边界——文本一律 `textContent`/安全绑定，属性用 DOM API 赋值；如需富文本，仅在明确白名单净化后渲染；把"数据 → DOM"的唯一通道收敛到共享 helper。
- **Migration implications**：无数据迁移；但**存量已写入的脏数据**需要在修复后清理或至少审计（谁在何时写入了标签样式内容）。
- **Test implications**：DOM 注入回归覆盖**列表 + 详情 + 导出预览**三类 sink（当前只覆盖列表）；属性闭合、编码变体、textarea/引号闭合用例。
- **Deployment implications**：若后续启用页面级 CSP，必须先移除内联事件处理器（当前 UI 大量 `onclick`），属较大改造；短期内 CSP 不能作为本项的保护依赖。

---

## RC-06 · Offline mutation + optimistic concurrency（本地先行语义与并发协议缺失）

- **Affected Issues**：AUD-021（临时记录状态机：`Storage.js:159/176/693/725`）、AUD-022（409 仅换 version：`AdaptiveUploadQueue.js:166-172`、`Storage.js:380-388`、`recordRoutes.js:538/570-592`）
- **Shared Failure Mechanism**：客户端采用"本地先行 + 后台队列"，但**缺少显式同步状态机**（temp ID 的生命周期、编辑如何在 create 出队后仍能到达）与**乐观并发协议**（409 只提供 serverVersion，无合并语义，客户端自动以 stale 全量重放）。
- **Why patch-per-issue is dangerous**：只修 021（状态机）→ 409 重试仍会覆盖他人；只修 022（合并）→ create 出队后的编辑仍静默丢失；两者在同一条 `Storage`/`AdaptiveUploadQueue` 路径上共享 temp ID 映射与队列顺序，分批修复会互相破坏假设（例如"create 出队前合并编辑"的补丁会被新状态机的语义推翻）。
- **Preferred architectural boundary**：客户端同步状态机（TEMP_CREATED → … → SYNCED，见 BATCH-C 报告）作为唯一写入路径；服务端 PUT 保持 CAS 语义并**返回足够冲突信息**（latest object 或字段级基线）；客户端在冲突时做字段基线合并或显式请用户确认，禁止自动全量重放。
- **Migration implications**：客户端本地队列/缓存结构可能变更（需版本化与一次性迁移）；服务端 409 响应体扩展需**向后兼容**（旧客户端忽略新字段仍安全失败，而非误重试）；不涉及 schema 变更。
- **Test implications**：状态机时序矩阵（离线建→改→删→重连、在途编辑、失败重试）；两用户并发（A 改 X、B 改 Y 均保留；同改 X 必须呈现冲突）；stale 重放不得成功。
- **Deployment implications**：无部署变更；但需客户端**强制更新**策略（旧版本客户端在服务端收紧后可能不断冲突，需灰度与提示）。

---

## RC-07 · Pagination / complete-read contract（读取契约不成立）

- **Affected Issues**：AUD-020（前端 `limit=1000` 一次拉取、导出 `limit=10000` 被 cap 2000、`total` 未使用、报告不声明完整性）
- **Shared Failure Mechanism**：读取链路以"单次请求 + 固定上限"代替"完整读取契约"；后端已返回 `total` 与 `limit/offset`，前端不消费；报告层用本地条数生成"总数"文案。
- **Why patch-per-issue is dangerous**：继续抬高 `maxSyncRows`（历史上 200 → 1000 的循环）只是把截断点后移，代价是首屏与内存；只改导出而不改列表会让看板与报告口径继续分叉；只改前端不明确后端上限语义（`MAX_RECORDS_LIMIT`）会让"完整性"继续不可证。
- **Preferred architectural boundary**：定义"完整读取"契约并**三选一**：服务端分页（total + cursor/offset 契约）、流式导出（服务端生成）、超限显式拒绝（不静默截断）；所有消费方（列表/看板/导出）复用同一契约并在 UI/报告中声明数据范围。
- **Migration implications**：无数据迁移；导出 API 契约可能变更（需要版本或参数语义澄清）；本地缓存需从"全量语义"改为"分页窗口语义"。
- **Test implications**：2501 / 10000+ 条的分页与导出完整性；`total` 与实取条数一致性；网络失败与超限场景必须"明确标注失败/不完整"。
- **Deployment implications**：大导出的资源上限（流式 IO、超时、磁盘/内存水位）；分页后首屏性能与请求数（客户端拉取策略）。

---

## RC-08 · Authorization lifecycle（授权实体的范围与生命周期）

- **Affected Issues**：AUD-017（`/api/test-results` 仅 `authenticateUser`，10 个端点含 4 个写端点，数据落全局 public）、AUD-047（OpenApiGrant 以文本 `school_code` 关联，学校删除不回撤、同 code 重建自动生效）
- **Shared Failure Mechanism**：授权**以隐式约定存在**（"登录即可用"、"code 相同即同一学校"），没有显式的授权实体（主体/范围/有效期/世代）与生命周期管理。
- **Why patch-per-issue is dangerous**：只给 017 加角色守卫 → 若该模块确有学校协作用途会被误伤（需先定产品定位）；只给 047 清 grant → 回收站恢复策略（恢复应否继承授权）被默认答案决定，可能误伤合法恢复；两者的修复都需要先回答"授权如何表达与失效"。
- **Preferred architectural boundary**：授权是**显式实体**——主体（人/对接方）+ 范围（学校/类型/端点）+ 有效期与世代；访问点统一校验；资源删除/重建/恢复对授权的影响有明确策略并留痕。
- **Migration implications**：047 若引入学校世代/不可复用 ID → schema 变更，**必须走 RC-04 的 migration 纪律**；存量 grant 需迁移策略（导出影响清单 + 业务逐对接方决定）。
- **Test implications**：角色矩阵（guest/viewer/operator/manager/admin 对所有端点）；学校删除→重建→恢复的授权继承；对接方 API Key 在世代变化后的行为。
- **Deployment implications**：授权变更需审计与通知（尤其影响第三方对接的可用性）；测试报告模块的生产定位需产品决策（限制平台角色 vs 建立协作授权）。

---

## RC-09 · Domain integrity / audit retention（领域判定与审计保留）

- **Affected Issues**：AUD-025（油脂结论判定分散 4 处且 fail-open）、AUD-027（AuditLog 与 User 强绑定 + onDelete: Cascade）
- **Shared Failure Mechanism**：**领域语义（合格/不合格）与审计语义（谁做了什么）都没有单一事实源**：判定规则在内部统计 SQL、访客统计 SQL、OpenAPI 枚举、前端 Dashboard 各写一份且默认不同（未知值推定合格 vs unknown）；审计记录依附于被审计主体，主体物理删除即历史消失。
- **Why patch-per-issue is dangerous**：只改内部统计 SQL（025）→ 与 OpenAPI/前端继续不一致；只去 CASCADE（027）→ 需要决定"删除用户后这些审计归属谁"（NOT NULL 外键决定不能 SET NULL），没有保留策略的改表会造成半成品；两项共享"同一事实在不同出口/时间点的表示与存续"问题。
- **Preferred architectural boundary**：领域判定的**唯一函数**（`normalizeConclusion`，未知值不推定合格，返回 unknown/待判定）供统计/前端/开放接口共用；审计为**不可变存储**（主体快照或独立主体 ID，不与可变主体强绑定）。
- **Migration implications**：027 需要 schema 迁移（去 CASCADE / 软删除 / 快照字段），**依赖 RC-04 的 migration 纪律**；存量 AuditLog 必须保留（迁移不得删除历史）；025 无 schema 变更但**历史统计口径变化**需业务确认与对外说明（可能影响已发布的报告）。
- **Test implications**：判定矩阵（合法值/未知值/冲突 result/空值）跨四出口一致；删除/停用只有审计历史的用户后，历史数量、操作者快照、可查询性不变。
- **Deployment implications**：对外报告与 OpenAPI 的历史口径变更需通知第三方；审计保留如需满足合规周期，需明确保留年限与备份策略。

---

## RC-10 · Production configuration guard（环境防护缺失）

- **Affected Issues**：AUD-039（旧测试接受普通 `DATABASE_URL`、固定 schema、破坏性清理；p0Prov 经 Prisma 自动加载 `backend/.env` 直连业务库）、AUD-044（`.env.example` 占位密钥不在 `KNOWN_WEAK_SECRETS`，无强度校验）
- **Shared Failure Mechanism**：**"信任环境"假设**——测试假定连接串指向测试库、配置假定部署者会替换占位值；没有任何入口级防护（库名/角色白名单、占位值拒绝）。
- **Why patch-per-issue is dangerous**：只给测试加提示而不做启动拒绝，误跑仍会发生（且 `npm test` 是最常见命令）；只把示例值加入弱密钥列表而不做长度/熵校验，下一个新占位值仍会漏；两者共享"配置入口必须自证安全"的原则，且都属于成本低、收益高的前置防护。
- **Preferred architectural boundary**：**入口自证**——测试启动前校验连接串（库名/角色/显式隔离变量），拒绝生产样式 URL；服务配置启动前校验密钥（拒绝占位值 + 最小强度），并保证 `deploy.sh` 路径自动生成强值（已具备）。
- **Migration implications**：无 schema 变更；但 039 的修复若涉及"测试用独立 schema 命名空间"，需与 RC-04 协调避免新增不可回放变更。
- **Test implications**：生产样式 URL/固定业务 schema 在任何 DDL 前被拒绝；原样示例密钥必定启动失败；安全生成值启动成功。
- **Deployment implications**：CI 环境变量规范（显式测试 URL）；部署文档与 `.env.example` 文案（示例留空 + 生成指引）；`deploy.sh` 已有自动生成逻辑，需保持并加文档说明。

---

## 跨 RC 的关键观察（供 Astra 参考）

1. **RC-02 覆盖面最广（5/23）且与其他 RC 无重叠**：它是"授权态无法及时收敛"这一类失效的集合；一次性重构的收益最高，也最需要兼容窗口设计。
2. **RC-04 是所有后续 schema 变更的前置条件**：RC-03（恢复台账）、RC-08（学校世代）、RC-09（审计保留）都可能引入 schema 变更，若不在 RC-04 之后进行，会继续产生"不可回放"的历史。
3. **RC-03 内部天然成对**（004+005 恢复引擎；006+007 备份产物），且**文档承诺与代码能力存在落差**（"影子恢复/零影响"的假设未被 ownership 与互斥落实）——这是本矩阵中唯一存在"承诺-实现"鸿沟的 RC。
4. **RC-06 与 RC-01 共享文件面但根因不同**（见调整说明），修复应同波次但**不同方案**，否则会互相污染。
5. **无 D 级（纯理论）issue**：23 项全部具备 A 或 B 级证据；意味着当前的主要风险是"修复顺序与兼容性"，而非"证据不足"。
