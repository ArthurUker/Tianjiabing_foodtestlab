# 16 个审查工作包

基线与通用门槛见 [REVIEW_PLAN.md](REVIEW_PLAN.md)。实际逐文件归属以 [coverage-plan.tsv](coverage-plan.tsv) 为准；下列入口是导航，不是包范围的穷举。各包须审完主归属文件的完整内容，协同包阅读关键调用与消费契约。

每包交付：`SCOPE.md`、`CALL_CHAINS.md`、`CHECKS.tsv`、`FINDINGS.json`、`VERIFICATION.md`、`coverage-delta.tsv`、`HANDOFF.md`。没有发现也要交检查证据与未覆盖项；未运行写 `NOT_RUN`。

## WP00 · 基线、规范、历史与覆盖治理

**入口**：根 README、`docs/PROJECT_CONVENTIONS.md`、`docs/README.md`、现行开发/测试/迁移说明、global-audit 的总账/状态/裁决、SERVER_CODEBUDDY 的 R6–R8 与 FINDINGS。

**检查清单**：

1. 重新冻结 SHA/分支/dirty、460 文件及执行期增量；检查全部源码根、hidden 配置与未跟踪代码，逐项登记排除理由。
2. 把生产环境说明、当前本地代码、历史审查快照分开；查明 ignored 历史资产是否可在目标执行端获取。
3. 为 AUD/SRV 历史问题建立当前映射；读取总账顶部最新裁决，不能继承早期“当前”字段。
4. 核对规范与现行实现：public/tenant 权威表、审计保留、guest/viewer、学校生命周期、结论与导出政策、迁移失败协议。
5. 业务语义有冲突时保留来源与日期，登记待裁决；尤其油品警戒计入合格率、餐具取值优先级、审计/回收保留与历史授权重授。
6. 建端点、模型、原始 SQL 对象、脚本、后台任务与证据读取目录；唯一 ID、计数与严重度汇总由明细生成。

**方法/证据**：Git NUL 路径清单、文件 hash、分类/主责任矩阵、历史别名表、规则/实现/裁决对照表。动态验证不适用；历史动态结果标为历史证据。

**依赖/出口**：先于所有包；G1 要求所有文件、调用链有负责人，范围分母与敏感材料边界明确。

## WP01 · 服务入口、装配、readiness 与资源边界

**入口**：`backend/server.js`、`middleware/validationMiddleware.js`、`readOnlyMiddleware.js`、`lib/securityGuards.js`。

**检查清单**：

1. 按实际顺序展开 rate limit、proxy/IP、CORS、路径级 body parser、全局 parser、read-only/write barrier、安全头、rewrite、readiness、router、错误出口。
2. 各 route 的局部中间件与 server 包装是否一致；未知路径、动态/静态路径冲突、重复定义的可达性与响应契约。
3. 请求体大小/内容类型/解码失败、大上传在认证前的成本、错误状态码/堆栈/秘密泄漏。
4. `/health` 与 `/readyz` 的精确含义、迁移未证实/检测中/部分校阻断/全局阻断/超时；学校 hint 来源与已认证真实租户一致性。
5. startup/import、recycle infra、告警、识别单例、定时 GC 的 DDL/DML/文件/外联副作用；启动 check 注释不代表全部进程只读。
6. 监听地址、trust proxy、端口、shutdown、Prisma disconnect、定时器释放、连接/缓存/限流 Map 的上限与生命周期。

**定点验证设计**：独占回环服务，在 G0 后验证健康/readiness、畸形 body、不同 Origin/IP、blocked A token + body B、未知 API、启动/关闭。记录真实 middleware 命中、HTTP、实际 schema 与后台副作用，不只看状态码。

**证据/依赖/出口**：装配顺序表、endpoint matrix、启动/退出状态图；依赖 WP00，与 WP02/03/11/14 共审。任何受保护入口的认证/租户/写屏障路径不得空白。

## WP02 · 身份、会话、JWT、guest 与角色

**入口**：`modules/UserManager.js`、`middleware/authMiddleware.js`、user/session/guest routes、`lib/sessionEpoch.js`、`jwtSecretConfig.js`、`jwtSecretResolve.js`；前端 Auth/GuestAuth/Permission/Session 服务、`core/Auth.js`（内含 OperationGuard）、login/quickAccess/superAdminLogin/SuperAdminAccount。

**检查清单**：

1. access/refresh/guest 的 secret、算法、claim 类型/issuer/audience（若有）、校码/主体/epoch、过期和 key 配置；检查所有消费出口，不只签发。
2. 登录错误、锁定、用户名/密码处理、强制改密、停用/删除、平台 admin 与校内 admin 的信任来源。
3. refresh 轮转/重放/多标签互斥/并发，撤销同秒边界、Session 状态与实际 token 能力的区别。
4. 权限/账号/学校 mutation 与 epoch、审计是否同事务；缓存有效期、DB 故障 fail-soft 的资格、角色回查和缺 schoolCode 的处理。
5. role × school × resource × operation 矩阵：platform admin、manager、operator、viewer、guest、API-Key、匿名；前端显隐与后端拒绝分别验收。
6. guest 功能开关、可见类型、导出限制、快速访问及过期/刷新/idle/logout；事件是否真实派发、会话 API 是否真实调用。

**定点验证设计**：A/B 校与 public 超管、同用户名/同资源 ID、旧 access/refresh、权限变更、DB 故障、guest > 校验周期、多标签并发。确定性屏障放在真实 epoch/refresh mutation 边界。

**证据/依赖/出口**：token 状态图、角色矩阵、拒绝码、DB 前后状态、前端 storage/网络/可见 UI；依赖 WP01/03/08/13。所有身份失效入口的生效时点与未知条件明确。

## WP03 · 租户、学校生命周期、初始化与同步引擎

**入口**：`tenantClient.js`、`tenantProvisioner.js`、`tenantSync.js`、`tenantWriteBarrier.js`、`publicInfraShape.js`、`schemaCompatibility.js`、`schoolAdminPurge.js`、`middleware/tenantMiddleware.js`、`routes/schoolRoutes.js`、`sync-tenant-schemas.mjs`。

**检查清单**：

1. schoolCode 来源/归一/合法性、同 schema 归一冲突、空值/public 回落、SQL 标识符与数据库 URL 构造。
2. public 系统表与 tenant 表的权威来源、冗余副本、req.db 注入、raw SQL 的限定；核对基础单例与派生客户端是否混用。
3. LRU 淘汰在途客户端、学校停用/恢复后的缓存、连接总预算、disconnect 的异常路径。
4. 建校、停用、回收、restore、purge、重用 code：generation/epoch、grants、回收对象、客户端、写屏障与审计的事务/补偿。
5. tenant 迁移的分类/投影/checksum/链摘要、lock/fencing/heartbeat/CAS/人工清锁、failed 与 baseline 证明、partial drift 与 readiness。
6. AUTO_SYNC 各值、CLI check/apply、启动 infra ensure、模板克隆及后台任务；逐个证明检测与变更边界。

**定点验证设计**：独占 PG，public+A/B/回收/旧 schema，缺对象/多对象/旧链/失败链、同名/归一冲突、停校在途请求、建校中断、锁持有/过期/清锁竞争。

**证据/依赖/出口**：每条 Prisma/raw SQL 的 scope、生命周期图、迁移台账/catalog、屏障/epoch/缓存连续性、资源归属与 cleanup receipt；与 WP02/07/08/14 交叉。不能只用 readyz 200 证明全部结构和权限。

## WP04 · 记录 CRUD、同步、离线、幂等与并发

**入口**：record/sync routes、`idempotencyMiddleware.js`、`recordNormalize.js`、`readContract.js`、`sanitize.js`；`Storage.js`、`AdaptiveUploadQueue.js`、`SyncScope.js`、`SyncStateMachine.js`。

**检查清单**：

1. create/PUT/bulk-upsert/delete/archive 的逐字段契约：状态、日期、record_code/version、作者、结果 JSON、缺省与部分更新、旧格式保真。
2. 同租户/主体/操作/路径/body 的幂等边界；缓存前后授权时点、pending/失败/过期/重复重试、不同资源同 key。
3. 唯一约束/乐观锁/实际更新是否原子，409 的真实对象和最终 version；批量部分失败与审计事务一致性。
4. localStorage 缓存/队列/指纹/退避的 school+subject+resource；legacy quarantine、身份切换、页面顶层实例化与初始化顺序。
5. create 在途编辑/删除、temp→server ID、墓碑、三路合并、重试预算、401/403/409/429/503/断网/未知提交结果。
6. 重载恢复、quota/存储不可用/JSON 损坏、队列持久化失败、分页完整性、取消/重启及用户可见冲突提示。

**定点验证设计**：真实 HTTP/PG 与隔离浏览器组合；同目标并发、不同主体/校同 key；页面离线→编辑→恢复→重载。断言 UI+cache+queue+HTTP+DB+audit 六方状态。当前主要存储链为 localStorage；只有代码实际使用的其他存储才进入对应断言。

**证据/依赖/出口**：请求字段映射、状态转移与时间序列、存储快照、最终记录/version、审计与部分失败记录；依赖 WP02/03/05/10/13。并发必须证明屏障覆盖真实修改边界。

## WP05 · 五类业务、结论、频率与统计

**入口**：Tableware/GenericTest/Pathogen、Dashboard/GuestDashboard/FrequencyModule；后端 frequency routes、`conclusionVerdict.js`、`tablewareVerdict.js`、`leanMeatCategory.js`；前端 conclusionVerdict、pathogenRisk/dateUtil、FormValidator 与 schoolCustomization/fields.js 等业务/字段工具。

**检查清单**：

1. tableware/pesticide/oil/leanMeat/pathogen 的原始量、单位、阈值、未知/空值/畸形值、复检与最终结论；前后端与旧记录兼容。
2. 保存与显示时是否丢字段、优先级是否一致；用真实调用链查 shadowed/重复算法，而非字符串包含证明同源。
3. 油品警戒与合格率、餐具 RLU/atpPoints、病原异常与复检等存在政策分歧时，列来源和待裁决，不发明新规则。
4. frequency 目标/日历/月报、周起点、UTC+8 日界、业务日期与 created_at、去重和分页/全部记录分母。
5. guest/viewer 可见类型在列表、详情、统计、导出、samples 中的一致性；页面隐藏不替代服务端投影。
6. 数值格式/枚举/自定义类型与动态字段规则；异步更新、empty/loading/error 状态、聚合数据量/缓存新鲜度。

**定点验证设计**：冻结边界数据集，含午夜/月周年边界、未知 verdict、复检、旧字段、超分页记录、不同类型/身份；原始→规范化→stored current→各输出逐项对账。

**证据/依赖/出口**：带业务来源的判定真值表、统计公式/分母、跨出口差异及业务待决表；依赖 WP04/06/12。业务正确性与源字段输出安全分别检查。

## WP06 · OpenAPI、授权投影、游标与导出

**入口**：openApi/adminOpenApi routes、`openApiAuth.js`、openApiKeys/Scope/GrantIdentity/FieldSchema/Guide、`exportJobs.js`；前端 `openApiView.js`、`ExportService.js`；`docs/examples/openapi-sync-client.mjs` 与 `openapi-acceptance-kit.mjs` 两个可执行示例。

**检查清单**：

1. 人类 JWT 配置面与 API-Key 业务面分离；credential/client active/revoke/expiry、key hash/一次显示、IP/proxy/限流/日志脱敏。
2. grant 学校、类型、字段、隐私名单与动态定制变化；scope/generation 身份连续性、samples 与真实 records 的一致性。
3. cursor/change token/projection fingerprint 绑定过滤、学校、scope 和字段；稳定排序、相同时间不同内容、授权扩大/收缩、删除/停校、页首尾 manifest。
4. 读完所有页并验证一致快照之后才提交同步；任何单页 200 不代表完整性。
5. export job 主体/租户绑定、jobId/文件路径/manifest、分页全量、最大行数、TTL/取消/重启/下载、恢复/失败后的文件状态。
6. 页面、本地窗口、服务端权威范围、PDF/HTML/Word/图片/字体加载、报告标题与模板输出编码、敏感字段脱敏。
7. 示例客户端的 URL/凭据来源、页面/manifest 验证、scope 变化/断点重试/状态持久化，以及 acceptance kit 的真实网络/写文件副作用；文档目录中的代码采用源码深审，不能当作普通说明跳过。

**定点验证设计**：假 key 和 A/B 校、不同 grant、scope/projection 中途变更、重复时间/分页、错误 cursor；export 输入与下载逐行对账。GET 也会写用量/拒绝日志，只在隔离库运行。

**证据/依赖/出口**：client×credential×school×projection 矩阵、分页/manifest、输出字段/隐私、job/文件/HTTP/DB 证据；依赖 WP02/03/04/05/07。静态 jobId 越界线索与可达写原语分开登记。

## WP07 · 备份、恢复、KMS、磁盘与清理

**入口**：backup/restore/dump/KMS/job/SQL helper/external registration 库、adminBackup/schoolBackup/adminDisk routes；BackupRestore/backupManager 与管理 backup/disk 视图。CLI 由 WP14 主审、此包共审。

**检查清单**：

1. pg_dump 与元数据是否同快照，行计数/表全集/schema 结构、文件唯一命名、checksum/封装、损坏/缺 meta/截断。
2. KMS/envelope 加密算法、key/version/轮换/缓存、nonce、AAD、master key 文件权限、错误输出与命令 argv 秘密。
3. backup/upload/register/download 的路径 containment、symlink、文件所有权、SQL 标识符/表白名单、压缩解包配额与内容来源。
4. maintenance lock/job manifest/write barrier、staging schema 名唯一性与归属、切换前后在途写入、rename/ACL/客户端缓存重连。
5. 同校/跨校互斥、取消、崩溃重启、cleanup、备份保留边界、删除失败记录与文件是否一致、审计保留/归档政策。
6. 学校/平台备份列表、job 状态/metadata/错误响应的跨校暴露；批量恢复/平台维护的权限和失败范围。

**定点验证设计**：专属 PG/备份目录，固定数据集与未知对象哨兵；逐阶段故障注入，真实 dump/restore 后查询数据和权限；journal/宿主日志清理使用替身。不得触达已有备份或真实密钥。

**证据/依赖/出口**：状态机、每步持锁/可见状态/失败补偿、DB+catalog+ACL+文件+job+audit+cleanup receipt；依赖 WP03/08/10/13/14。API saved/200 不能替代可恢复与恢复后读写证明。

## WP08 · Prisma 模型、全部迁移与模型外 SQL

**入口**：`backend/prisma/` 全部 25 文件，包括 schema、17 条 migration、lock、constraints、role-audit-trigger、seed/provision/dedupe/password sync；WP03 引擎和 WP14 脚本共审。

**检查清单**：

1. 23 model 与 public/tenant 权威表逐一映射；revoked_tokens/recycle_bin/迁移锁/台账等模型外对象也建账。
2. 每条迁移的前置结构、作用 schema、裸表名/search_path、DROP/ALTER/DO/动态 SQL、幂等/同名异定义与 catalog 验证。
3. unique/FK/NULL/自关联/级联/默认值、JSON/text 转换、索引和 trigger；校验事务/权限/实际对象而非只看 Prisma schema。
4. baseline→expand→backfill→enforce 的老新代码兼容、NOT VALID 对新写的影响、批量/锁/膨胀/失败残量、人工映射证据。
5. 空库、受支持旧版本、public 与 tenant 不同迁移状态、部分执行/failed、checksum 不一致、回收/rollback schema、extra-object 保护。
6. seed/provision/dedupe 的默认账号/密码/角色、防覆盖/生产开关/dry-run、冲突数据取舍及不可逆影响。

**定点验证设计**：一组新库与受支持历史 fixtures，通过真实迁移链验证 catalog、约束拒绝、数据保真与失败保留；`db push` 不作为 migration deploy 链证明。锁时长的版本条件与实测量级单列。

**证据/依赖/出口**：每迁移一行前置/执行/后置/恢复表、模型/SQL 对象表、chain/checksum 与 catalog 指纹；依赖 WP03/13/14。禁止改写已应用迁移或以删除 failed 记录制造通过。

## WP09 · 管理前端、学校定制、跨校异步与外链

**入口**：`adminSchools/**` 除 OpenAPI/backup/disk/test-report 特定视图的剩余文件；loginStyleDesigner、schoolCustomization 系列；admin/public friendly-link routes、friendlyLinks 库与前端 friendlyLinksView。

**检查清单**：

1. school list/create/detail/users/accounts、定制字段/级联选项、视觉编辑/预览、sidebar/kpi poller 的页面→API→身份→租户→审计链。
2. 切校/快速导航/响应乱序、await 后 scope/version 是否复核、旧响应覆盖 state、旧基准保存到新学校、轮询与事件取消。
3. 定制字段类型/顺序/required/hidden/options、父子树、自关联/多层/重复、schema 与读写 UI 的契约一致。
4. 用户管理与最后管理员、筛选后的对象集合、角色 mutation、保存前后权限；重复点击和部分批量失败。
5. HTML/CSS/theme/logo/外链 URL/iframe preview/postMessage 的上下文安全与跨 origin 信息；检查 URL 与 CSS 值来源，不能只靠文本 escape。
6. public link 公开列表、点击计数、管理变更、启停排序、协议/redirect/链接 rel 与隐私；公开 GET/点击统计也列副作用。

**定点验证设计**：隔离浏览器人为反转 A/B 返回顺序、展开多视图、旧版本保存、不同身份显示/请求；外链只用任务自有域/服务，不触发真实外部点击统计。

**证据/依赖/出口**：每视图矩阵、异步事件/请求 timeline、UI 当前学校+payload+最终 DB 的同 scope 证明；依赖 WP02/03/10/12。视觉预览不能替代保存后的读取验收。

## WP10 · 审计、测试报告/证据、反馈与归档

**入口**：audit/testResult/feedback routes、auditLog/auditPrincipal/securityAlerts/testCaseDefs、前端 AuditLog/Feedback/AuditService/AuditLogger、admin auditView 与 testReports 全视图。

**检查清单**：

1. 事件来源、可信主体/principal/actor snapshot、系统/租户落点、append-only、用户删除后证据、历史回填与敏感字段。
2. 业务 mutation 与审计是否同事务；审计失败引起的业务/告警行为、兼容降级、批量缺日志、DB 和前端离线审计关系。
3. security scanner 的相同 created_at 游标、批次/重启/重复通知、外部 webhook/错误日志和保留。
4. 报告任务 case/学校/主体/归档身份、角色授权与真实可达入口、证据上传/download 的路径归属和权限、文件/DB 一致性。
5. tasks/issues/list 视图 DOM id/事件选择器、同时展开多行、caseKey/detail/evidence 对应、追加记录的不可撤回与归档后行为。
6. 反馈截图、容量/数量/类型、存储 TTL/GC、匿名或越权路径、SystemLog 与通知的副作用；审计清理政策与规范冲突交 WP00。

**定点验证设计**：不同身份/校/任务、同时操作 A/B 行、缺主体历史数据、上传错误/越界、同时间多事件、归档重试；stub 全部真实通知，所有目录自有。

**证据/依赖/出口**：事件责任表、immutable 主体/事务/保留、UI caseKey+HTTP+DB+文件、拒绝/失败与 cleanup；依赖 WP02/03/07/08/09/13。审计可追溯与业务通过分开验收。

## WP11 · 图像识别、OpenCV、队列与嵌入

**入口**：recognition routes、`recognitionQueue.js`、`frontend/js/opencv/recognizer.js`、detergentDemo/syntheticDetergent/embed、demo HTML 与 CSS；供应商 OpenCV 由 WP15 主审。

**检查清单**：

1. 实际主线程/Worker 模型、import 自动初始化/pump、OpenCV 加载/失败/ready 与 Node/浏览器分支。
2. body/base64/PNG 格式与真实大小、像素/解码/内存上限、非法/巨大/异常图像、队列数量、job Map/TTL/取消/超时。
3. job 主体与学校、status 查询的 ownership/枚举边界、输入参数与结果结构、前后端共用算法版本。
4. ArUco/单应/色彩 ΔE/校准/单位、低置信度、定位→人工确认→比色流程的证据来源与提示。
5. OpenCV Mat/缓冲/DOM URL 的成功与异常释放；资源预算、CPU 阻塞及与 API 其他请求的争用。
6. iframe/postMessage 目标与来源、父页面接收与 sessionStorage fallback，结果是否被当成可信保存指令。

**定点验证设计**：限额合成图片 + 固定样本 hash，Node/浏览器结果对照，短时有限并发/失败/timeout；不得进行无上限压力。

**证据/依赖/出口**：算法输入/输出/版本、资源预算、队列状态、任务身份、实际消息接收链；依赖 WP01/02/12/13/15。算法正确性与识别依据/业务阈值分开裁决。

## WP12 · 页面壳、路由、公共工具与输出安全

**入口**：6 个 HTML、`main.js`、Router/domSafe、公共 config/utils、CSS/Tailwind 输入；按功能与 WP02/05/09/11 协同，vendor/生成 CSS 由 WP15 主审。

**检查清单**：

1. 页面→inline script/module→实例→监听器/定时器/请求的完整依赖图，认证前实例化、quick access/guest、初始化失败、退回/重载。
2. schoolCode 唯一提取入口、URL rewrite/相对资源/页面 base、不同前缀/查询/预览的身份一致性。
3. source→sink 分类：text、HTML、属性、URL、CSS、inline JS、PDF/嵌入；逐消费者检查 escape/sanitize 的上下文与可信边界。
4. CSP/SRI/iframe/sandbox、CDN/外链/图片/字体、postMessage、下载文件名/标题；反代与应用头是否覆盖实际页面。
5. Dialog/表单/通知/事件委托的可见结果、重复 id、焦点/键盘、监听释放、novalidate 后的校验、空/错误/加载/冲突状态。
6. 公共工具的日期/数值/字段 masking/格式/学校定制及各实际调用方；无调用/孤儿文件也登记，不直接删除。

**定点验证设计**：干净隔离 profile，全部页面/学校路径与身份分支，合成边界数据源；检查 DOM 内容/事件、console/network 与可见截图，再对照 API/存储最终状态。

**证据/依赖/出口**：页面入口表、source→sink 表、事件生命周期、页面/反代/后端真实权限矩阵；依赖 WP02/04/05/09/14/15。无 XSS payload 出现不等于所有 sink 安全。

## WP13 · 测试入口、隔离工具、夹具与测试可信度

**入口**：`tests/` 全部、`backend/tests/` 全部、Cypress 全部、所有 Jest/Cypress 配置、entry-sets、backend runner、entry-audit 与 fixture/harness。

**检查清单**：

1. 建全集→入口→收集→实际执行→断言→风险映射，分别枚举 `.test.mjs`、`.unit.test.cjs`、Jest、`.cy.js` 与 standalone 验证/fixture；shell glob 不能代替递归真实清单。
2. 当前静态入口参考：root 28 unit + 1 DB、integration 2、isolation 4、backend runner 49、Cypress 3、专用 frontend 0；再次核对，文件数不是测试执行数。
3. TEST_* / `_isolation` 的拒绝时点、0 连接观察正对照、dotenv/URL fallback、pg 与 Prisma 真身份/owner/marker；生成 Prisma 客户端与模块搜索不得残留生产路径。按能力适用 G0；纯离线门禁负例先做通用检查，不依赖 DB G0 已成立。
4. runId/角色/实例/datadir/端口/PID/sentinel/fixture chain 锁定、restricted/admin credential 分离、管理 pre-clean 的作用域、down 归属与失败保留。现有 report-auth harness 向待测 server 传 adminUrl，先按主计划 G0 做身份分离方案，不能直接视作准入；真实 HTTP listener 与网络可达范围也单独验证。
5. skip/only/todo、条件断言/源码正则/仅 toBeDefined/宽 HTTP 集合、mock 掏空认证/DB/领域库、全局 fetch 还原、随机 fixture/重复 record_code/跨套件污染。
6. 测试预期与业务裁决/当前实现是否一致；并发采用真边界屏障，集合数与成功数从原始明细复算；timeout/信号/cleanup 失败不能当 pass。

**定点验证设计**：先离线门禁负例和有效正对照，再任务自有 PG/HTTP/浏览器；复算所有测试入口，关键弱断言做受控反例证明（在独占副本与授权范围内）。

**证据/依赖/出口**：入口差集、mock/断言有效性表、G0 证据与实际 suite/case 明细；与所有包共享风险映射。现有 `npm test`、`test:all`、backend/debug/entry-audit/harness/Cypress 先读再运行。

## WP14 · 构建、部署、运维 CLI、CI 与失败协议

**入口**：根 `scripts/` 全部、`backend/scripts/` 全部、`deploy/` 全部、`.github/workflows/`、构建/lint/Babel/Tailwind/Git 配置。各领域脚本由对应包共审。

**检查清单**：

1. 每 CLI 的 cwd/模块类型/参数默认、dotenv/秘密来源、外联、spawn/argv/eval、写库/删文件/重启/通知、dry-run 与 exit code。
2. Git 获取/版本钉住、npm ci/install fallback、系统包/nvm 远程执行、Prisma generate、JWT 配置分发、.env 原子写入/权限/保留。
3. public migrate deploy→tenant apply→backfill/seed→build→restart→health/反代→学校页面的实际顺序；失败停止/现场留存/台账，不依据旧注释猜执行。
4. b-release 两段接线、schema 路径/cwd、服务名、授权重放/回退；真实程序与 PATH 桩的证据层级分别登记。
5. PG 数据目录复制/挂载/删除、备份/KMS/日志/journal/磁盘/cron/systemd、作用域和所有权、恢复窗口；不可逆动作前证明所有前置成功。
6. build-static 的复制/扁平 HTML/demo/version/缓存、root build 与 deploy build 的 CSS 产物一致性、dist 原子切换与失败残留。
7. CI 的触发/执行/凭据/制品/required checks；现有 deploy branch guard 与质量门禁职责分别核对，不能以有 workflow 代替实际测试 CI。
8. 脚本、模板、README、runbook 与当前真实实现/目标策略差异，危险历史命令明确身份；不得直接照历史说明操作。

**定点验证设计**：文件脚本先自有目录/替身，发布与数据目录/systemd/Caddy 再 disposable Linux VM/container（能力不足记 ENV_BLOCKED）；覆盖每个失败点的停止、旧服务/数据/文件/台账及恢复条件。

**证据/依赖/出口**：逐脚本副作用表、失败/回退矩阵、制品 hash、系统/反代/浏览器分别验收；依赖 WP03/07/08/13/15。本包不向生产执行 deploy、restart、seed、cleanup。

## WP15 · 依赖、手工 vendor、生成物与供应链

**入口**：root/backend/scripts package、两个 lockfile、`.npmrc`、vendor JS/OpenCV/CSS/字体、生成 `tailwind.css` 与相关许可证/加载声明。

**检查清单**：

1. Node/npm/Prisma/测试工具 engines 与锁版本、直接/传递依赖、root/backend 双树与脚本 module type 一致性。
2. registry/source/integrity、安装/lifecycle/远程脚本、runtime/dev 边界、生成 Prisma 客户端来源与可复现性。
3. 手工 vendor 的官方来源/实际版本/hash/license、锁文件外资源、压缩库暴露 API/实际调用方、浏览器/Node 共用版本。
4. 当前官方安全公告与受影响版本、可达调用面、可用修复路径；自动扫描只是输入，区分开发依赖/不可达/真实运行影响。
5. CDN/字体/外部 URL 的版本钉住、SRI/缓存/离线 fallback、来源变更；生成 CSS 与构建输入/命令的对应，不混算自研覆盖率。
6. Git 跟踪敏感材料与 ignore 的不同边界；仅对合成模板和受控源码作秘密检测，不打印实际秘密，也不以 ignore 证明历史没有泄漏。

**定点验证设计**：以锁与官方元数据为主；需要安装/生成时仅在授权的独占副本中进行，先审 lifecycle。资源加载/离线 fallback 使用隔离浏览器与任务网络策略。

**证据/依赖/出口**：SBOM/来源/版本/hash/license/加载方/公告适用性表、包树差异、生成物验证；与 WP11/12/13/14 共审。第三方专审完成单列，不宣称已逐行理解全部压缩库。
