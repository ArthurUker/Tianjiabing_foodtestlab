# R7 · 全量清点 + 统一分析 + 修复规划（2026-09-29）

> 目的：按"**先把问题找齐**，再统一分析、统一规划修复"执行。本轮**只做发现与规划，不做任何修复**。
> 覆盖补全：此前 R0–R6 只审了 迁移/认证/业务读写/备份恢复 四块；本轮对**从未审阅**的 学校与超管面、账号与权限面、新上线功能与免鉴权面、前端与测试面 做系统性清点。
> **证据级别声明（重要）**：本节所有条目均为**并行静态清点所得候选**，未经逐条回读复核（历史经验：上一轮同类候选中有 1 条被证伪、2 条需下调）。故一律标记 **CANDIDATE_STATIC_UNVERIFIED**，**不得**据此宣称"已确认"或"可利用"。
> 脱敏：不含口令/连接串/token/API Key/`BACKUP_MASTER_KEY`/真实个人信息。

## 一、新增候选（40 条，SRV-201–240）

### A. 学校管理 / 超管 / 定制配置（SRV-201–210）

| ID | 位置 | 问题 | 级别 |
| --- | --- | --- | --- |
| SRV-201 | `routes/schoolRoutes.js:243` | 建校 = `CREATE SCHEMA` → 迁移链 → `School`/`Customization` 三步**无事务无补偿**，失败留半套 schema；未传 `allowExisting`，同 code 重试恒 409；**全程无审计** | P1 |
| SRV-202 | `routes/schoolRoutes.js:607`（另 490/516/668） | 回收站恢复/清除把行内 `original_schema`/`recycle_schema` **直接插值进 `ALTER SCHEMA`/`DROP SCHEMA … CASCADE`**（未过 `assertSafeSchemaName`）；`DROP … IF EXISTS` 静默成功、"必须先停用"校验在事务外 | P1 |
| SRV-203 | `lib/schoolAdminPurge.js:69`（另 `schoolRoutes.js:668/693/1179`） | 批量把 `role='admin'` 降为 manager：裸 SQL、**无审计、不推进 user epoch**；`where status:{not:'deleted'}` 与实际取值（active/disabled）不符 → 过滤失效 | P1 |
| SRV-204 | `routes/schoolRoutes.js:999` | 超管重置密码只改 `password_hash`：**不推进 epoch、无审计**（对比 `UserManager.resetPassword:735-759` 为"改密+epoch 同事务"） | P2 |
| SRV-205 | `routes/schoolRoutes.js:741`（另 1116/1206） | 乐观锁与"最后一名在职 manager"保护都是**先查后写**（事务外读、UPDATE 无对应条件）；非法 `expected_updated_at` 会抛 RangeError→500 | P2 |
| SRV-206 | `lib/customizationValidate.js:66` | 校验 spec **漏了 `canteens`**（而 `CUSTOMIZATION_COLUMNS` 含该列）→ 提交被静默忽略但返回 success | P2 |
| SRV-207 | `lib/customizationValidate.js:123` | `theme_config` 只对**顶层** key 做 `/color\|logo/` 校验，值一旦是对象即跳过 → 脏 URL 经公开配置接口下发 | P2 |
| SRV-208 | `lib/fieldOptionService.js:279`（另 245/300） | 接受任意 `parent_option_id`，不校验存在性/自引用/环 → 选项静默消失；`deleteFieldOption` 先 count 后 delete（TOCTOU → 级联误删） | P2 |
| SRV-209 | `routes/frequencyRoutes.js:199`（另 111/234/281） | 4 个 **GET** 端点先 `ensureSeed` 执行 INSERT/UPDATE（含改写历史 `lean_meat`→`leanMeat`），无事务无审计；并发首次 GET 撞唯一约束 → P2002→500 | P2 |
| SRV-210 | `lib/schemaCompatibility.js:51` | 兼容性比对**只看列名与 data_type**（NOT NULL/默认值/唯一/外键/索引一律不比）；schema 不存在时返回空列集与"真空结构"不可区分 → **fail-open 假阳性** | P2 |

### B. 账号 / 权限 / 访客（SRV-211–220）

| ID | 位置 | 问题 | 级别 |
| --- | --- | --- | --- |
| SRV-211 | `modules/UserManager.js:1155`（allowedUpdates 1117） | `adminUpdateUser` 允许 `status='active'` 且**不校验 `target.deleted_at`**（`enableUser:958` 有该防护）→ 软删除账号可复活/身份复用 | P1 |
| SRV-212 | `routes/userRoutes.js:699` | `POST /application` 未校验 `schoolCode` 格式；非法码经 `tenantClient.js:119-123` **静默回落 public** → 可做平台超管用户名枚举 + 向 public 表注水 | P2 |
| SRV-213 | `routes/userRoutes.js:63,67` | 登录失败响应 **`code` 区分 `PASSWORD_WRONG`/`USER_NOT_FOUND`** → 直接泄漏账号是否存在，抵消假哈希防枚举 | P2 |
| SRV-214 | `modules/UserManager.js:1431`（阈值 1421-1422） | 5 次/2 分钟失败即把账号写 `status='disabled'`（需管理员恢复），无额外成本 → **未认证者可永久停用任意已知用户名** | P2 |
| SRV-215 | `modules/UserManager.js:1538`（放行 1530） | 申请被拒后允许重提，但仍走 `accountApplication.create`，而 `username` 唯一 → 必然 P2002 → 被拒用户**永久无法再申请** | P2 |
| SRV-216 | `modules/UserManager.js:594`（同类 627） | 平台超管**新增/删除**未调用 `logAdminAction`（对比 698/762 有）→ 最高权限账号增删无审计 | P2 |
| SRV-217 | `middleware/validationMiddleware.js:105`（含 144/290/318/398） | `validateRequestBody`/`validateField`/`limitRequestSize`/`createValidationMiddleware` **在 backend 内零引用**；`req.sanitizedBody` 无人读取 → **校验/净化层未接线** | P3 |
| SRV-218 | `routes/userRoutes.js:122`（同类 145） | 登录审计 IP 取 `X-Forwarded-For` **最左值**（可伪造），与 `trust proxy=1` 的 `req.ip` 口径不一致（= 既有 SRV-120 的同一根因第二处） | P3 |
| SRV-219 | `routes/guestRoutes.js:92,100`（签发 154） | 无凭证签发 2h 全校只读 JWT；404/403 分叉可区分 → **校码与访客开关可枚举**，并可批量拉取该校白名单模块数据 | P3 |
| SRV-220 | `middleware/authMiddleware.js:617`（同口径 `UserManager.js:197`） | **fail-open 降级**：`visible_types` 查询失败回落"默认四大模块"而非拒绝；`isAccountLocked` 计数查询异常 `return false` 直接解锁 | P3 |

### C. 新上线功能 / 免鉴权与低权限入口（SRV-221–230）

| ID | 位置 | 问题 | 级别 |
| --- | --- | --- | --- |
| SRV-221 | `routes/testResultRoutes.js:454`（写侧） | `/upload` 的 `case_id` 仅校验"字符串 ≤80"即 `path.join(EVIDENCE_STORE_DIR, case_id)` + `mkdirSync(recursive)` + 写入 → **越出 uploads 沙箱的受限任意文件写入**（内容可控、扩展名限图片） | P1 |
| SRV-222 | `routes/testResultRoutes.js:473`（读侧） | 只拦斜杠不拦 `..`，`caseId='..'` 通过自证 → 可读 uploads 根层文件；470 行二次 `decodeURIComponent`（畸形 % → 500） | P2 |
| SRV-223 | `routes/testResultRoutes.js:278`（另 301-305） | ISS 编号与 `round` 均为 `count/aggregate(_max)+1` **非原子** → 并发下唯一约束冲突 500、轮次重号 | P2 |
| SRV-224 | `routes/testResultRoutes.js:307`（另 350/375/457） | 全部写端点**无任何审计**；330/362/385 直接把 `e.message` 回显调用方 | P2 |
| SRV-225 | `routes/testResultRoutes.js:109` vs `frontend/.../testReports/shared.js:72` | 证据端点需 Bearer（`requireReportPlatformAdmin`），而前端用裸 `<img src>`（浏览器不带 Authorization）→ **证据展示功能整体失效** | P2 |
| SRV-226 | `routes/feedbackRoutes.js:182`（写回 246） | 节流是"先读时间戳 → 最后才写"的 **TOCTOU**，且写回发生在钉钉推送与最多 3×5MB 落盘之后；guest 令牌可无凭证获得 → 绕过 60s 限流写满磁盘 + 刷屏 | P1 |
| SRV-227 | `routes/feedbackRoutes.js:124`（读取 257-266） | 截图按 dataURL **自述 mime** 定扩展名（无魔数校验）；文件**永不清理**；读取端点**无认证**且 `Cache-Control: public, max-age=86400` → 本域托管任意内容 + 磁盘无界增长 | P2 |
| SRV-228 | `routes/recognitionRoutes.js:27` | 路由器只挂 `authenticateUser`，**无 guest 守卫、无配额**；单任务 8MB base64 常驻内存；`jobs` Map 永不回收 → guest/任意账号循环调用可 CPU+内存 DoS | P1 |
| SRV-229 | `routes/recognitionRoutes.js:56` | `status(jobId)` **无属主/学校校验**，jobId 可枚举 → 跨校/跨用户读取他人识别结果（IDOR）+ `e.message` 外泄 | P2 |
| SRV-230 | `routes/publicFriendlyLinkRoutes.js:47` | 免鉴权 `+1` 计数仅 IP 维度限流、无身份去重 → `visit_count` 可被刷高；同 IP 正常访客受影响 | P3 |

### D. 前端 / 测试（SRV-231–240）

| ID | 位置 | 问题 | 级别 |
| --- | --- | --- | --- |
| **SRV-231** | `frontend/js/modules/Tableware.js:1659`（另 999/1683/1687/1605-1624） | 列表与详情用 **innerHTML 直拼** `inspector/canteen/p.loc/p.res/correctiveAction/recheckResult/recheckRecords[].user`，零转义（文件内已有 `escAttr` 未用）→ **存储型 XSS**（写入侧仅必填校验） | **P1** |
| SRV-232 | `frontend/js/modules/Dashboard.js:1688`（另 1314/1362-1368） | 趋势图图例与风险提示 innerHTML 直拼食堂名/病原体明细 → 看板存储型 XSS（不同 sink） | P2 |
| **SRV-233** | `frontend/js/core/Storage.js:164-169`（另 `_findLocalDuplicate:1436`、`AdaptiveUploadQueue.js:46-51`、`Storage.js:840-843`） | 内容指纹去重把"同内容第二条记录"**静默吞掉**（save 返回旧行；create 命中 queue pin 直接 return，不落库也不换 tempId）→ 提示"成功 N 条"实际少写，被 skip 的行永久 pending | **P1** |
| SRV-234 | `frontend/js/core/Storage.js:395-407` | 全量同步合并**只保留服务端 1000 行窗口内**的记录，窗口外的本地行被静默删除（无 diff/无提示） | P2 |
| **SRV-235** | `frontend/js/services/SessionManager.js:43-46`（另 355-371；`main.js:413`） | 会话注册表**永不被填充**：全前端无任何代码 dispatch `userLogin/userLogout`，`Router.handleLogout` 也不调用 → **从不写 `/api/session`、无心跳、登出无 DELETE**；"已登出其它设备"为假成功、"30 分钟无活动登出"永不生效 | **P1** |
| SRV-236 | `frontend/js/core/Storage.js:1085-1094` | 队列快照结构不识别（旧裸数组/未知 schemaVersion）时**整队清空**，仅写迁移标记 → 离线未上传任务静默清零 | P2 |
| SRV-237 | `frontend/js/services/ExportService.js:997-1002` | 导出统计自造判定：oil `警戒` 记不合格、餐具顶层 `result` 为空时不回退 `atpPoints`（= 既有 SRV-127 的前端侧同源表现） | P2 |
| SRV-238 | `frontend/js/services/ExportService.js:1052-1054`（另 1129-1132） | 餐具风险检查读记录级 `r.rluValue`，而写入结构是 `atpPoints[].rlu` → **RLU 超标风险恒为 0**，点位/RLU 列空白（误导性报告） | P2 |
| SRV-239 | `frontend/js/modules/Dashboard.js:1166-1169` | 服务端 stats 失败只 `console.warn` 后静默退回本地窗口统计，卡片**无"部分数据"标记** | P2 |
| SRV-240 | `tests/storageDurabilityAndRace.test.js:150-157`；`tests/w5OutputEncoding.test.js:100-221`；`jest.frontend.config.cjs:14` | ① U6 用例只断言"不抛异常 + data 是数组"（注释自认竞态限制）→ **永久假绿**；② XSS 回归只覆盖 3 类 sink，未覆盖仍在直拼的 `Tableware/Dashboard`；③ `test:frontend` 指向不存在的 `tests/frontend`（恒零用例） | P2 |

**附带核对（非候选）**：`/api/admin/friendly-links`、`/api/public/friendly-links` 的挂载顺序**正确**（在 `server.js:479` 的全局认证之前）；`lib/friendlyLinks.js` 的协议/长度/图标白名单与前端 `safeUrl`+`textContent` 双检**未见 XSS/开放重定向**；`adminFriendlyLinkRoutes.js` 五处回显 `e.message`、`count→create` 非原子（上限可略超 50）为低危待办。

## 二、统一分析（按根因族归并，跨模块）

| 根因族 | 表现（ID） | 为什么值得统一处理 |
| --- | --- | --- |
| **A 写入语义 / 状态机不统一** | SRV-101（未提交 `status` 写成 completed）、SRV-211（软删账号复活）、SRV-106（会话行复活）、SRV-235（前端根本不写会话） | 都是"状态由谁写、何时写、能不能回退"没有单点契约。**SRV-235 会让 SRV-106 在生产中大部分不可达**——需先确认前端是否真的从不注册会话，再决定 SRV-106 的定级 |
| **B 审计覆盖不均** | SRV-104/105（sync/CRUD 审计被吞或无）、SRV-203/204/216（降权、重置密码、超管增删无审计）、SRV-224（测试体系全无审计） | 同一类"高影响操作"，有的有审计有的没有；且失败被吞 → 无法用"有没有审计行"做判定 |
| **C 并发 / 原子性** | SRV-205（先查后写乐观锁）、SRV-208（TOCTOU 级联删）、SRV-209（GET 写库竞态）、SRV-223（编号/轮次非原子）、SRV-226（节流 TOCTOU）、SRV-233（去重竞态） | 统一问题：`读-判-写` 没有放进同一个原子边界（事务/CAS/唯一约束兜底） |
| **D fail-open / 静默降级** | SRV-210（结构比对只看列）、SRV-220（visible_types/锁定查询失败即放行）、SRV-206（canteens 静默忽略）、SRV-239（stats 失败静默回退） | 与既有铁律"fail-closed"相悖，且都**不产生任何告警** |
| **E 口径不统一（单一事实源被绕过）** | SRV-127 / SRV-237（导出 vs 看板）、SRV-238（RLU 恒 0）、SRV-232（看板与后端）、SRV-239 | 同一批数据多个出口给出不同结论；**需先业务裁定**再统一收敛到服务端结论 |
| **F 路径与输入未校验** | SRV-221/222（证据上传/读取穿越）、SRV-229（jobId 枚举）、SRV-202（schema 名插值 DDL）、SRV-218（XFF 伪造） | 都为"用户可控字符串直接进入系统边界（文件系统/DDL/审计字段）" |
| **G 前端渲染安全** | SRV-231（Tableware 存储型 XSS）、SRV-232 | 写入侧不做转义、渲染侧直拼 innerHTML；`escAttr` 已存在却未使用 |
| **H 数据丢失 / 静默丢弃** | SRV-233（去重吞记录）、SRV-234（窗口外丢行）、SRV-236（队列迁移清空）、SRV-101/103 | 用户"看到成功"但数据没了 —— 对检测业务是**不可接受**的一类 |
| **I 凭据 / 会话生命周期** | SRV-204/203（改密/降权不推 epoch）、SRV-211（软删复活）、SRV-235（前端不注册会话）、SRV-218 | token 吊销链与账号状态变更没有统一挂钩 |
| **J 防护层未接线** | SRV-217（validationMiddleware 零引用） | 存在但从不生效的"安全层"比没有更危险（给人已防护的错觉） |
| **K 迁移 / 发布边界（已复现）** | SRV-121/122、SRV-109 | 已在隔离环境复现，属"可被无意触发的全站不可用" |

**跨族观察（本轮最重要的三个新判断）**：
1. **SRV-235 可能使 SRV-106 在生产中不可达**（前端从不调用 `/api/session`），但**不代表会话管控设计没问题**——需先验证前端实际调用链，再定 SRV-106 的最终级别。
2. **SRV-231（存储型 XSS）与 SRV-221（越权文件写入）是本轮新增中最严重的两条**：前者影响所有打开该记录的用户（含管理员），后者可写出 uploads 沙箱。
3. **SRV-233（去重吞记录）** 直接造成"检测数据缺失"，与既有 SRV-101/103 同属"数据被静默改写/丢弃"族，应合并处理。

## 三、修复规划（分批；每批含验收条件，均需逐项授权后执行）

> 原则：**一项风险一个修复单元**；先修"可被无意触发/可被匿名触发"的，再修"需要特定数据形态"的；每项保留修复前失败反例与相邻回归。

| 批次 | 范围 | 内容 | 验收条件 |
| --- | --- | --- | --- |
| **批 0（先做，未修复前的止血）** | 无代码变更 | ① 在 `SRV-121/122` 修复前，明确"**禁止在生产工作区直接落盘迁移文件**"作为临时纪律并写入 README；② 封禁/限制免鉴权高危端点（`/api/recognize` 配额、feedback 节流原子化前的临时开关） | 纪律写入文档；临时限制可开关且有记录 |
| **批 1（安全：可被匿名/低权触发）** | SRV-231、SRV-232、SRV-221、SRV-222、SRV-226、SRV-227、SRV-228、SRV-229 | XSS 转义（复用 `escAttr`/`textContent`）、证据上传/读取的双向路径校验（`case_id` 白名单 + `path.resolve` 前缀断言 + 去掉二次 decode）、feedback 节流改原子 + 魔数校验 + 读取端点鉴权与缓存策略、recognition 加 guest 守卫与配额并回收 jobs | 每项给出修复前反例（含请求样例与响应）与修复后同例通过；XSS 用真实 payload 验证不再执行；路径穿越用 `../` 与编码变体双向验证 |
| **批 2（数据完整性：静默丢数据）** | SRV-233、SRV-234、SRV-236、SRV-101、SRV-102、SRV-103 | 去重改为"仅提示不吞"或显式合并策略；同步窗口改为服务端分页/聚合；队列迁移加无损兜底（迁移前备份快照）；`status` 默认值只在 create 生效；sync 补 `test_type↔store` 校验；复检自愈只在本次确实提交了复检数据时生效 | 每项：修复前构造"丢数据/被改写"反例并保留 DB 前后对照；修复后同例数据完整；受影响测试 0 skip |
| **批 3（凭据与会话生命周期）** | SRV-204、SRV-203、SRV-211、SRV-235（+复核 SRV-106） | 重置密码/降权/软删复活统一挂钩 epoch；前端补齐会话注册或**明确下线** `/api/session` 相关 UI 文案（消除"假成功"） | 改密后旧 token **必须** 401；软删账号不可复活；若保留会话功能，撤销后旧凭据必须失效（三列分别验收） |
| **批 4（就绪与发布边界，已复现）** | SRV-121、SRV-122、SRV-109 | 发布脚本前置校验 + 停止条件；不可变发布目录 + 原子切换；b1/b2 段可执行化 | 隔离副本中"旧进程 + 新迁移文件"不再影响运行实例；真实 pending/failed/checksum 不一致仍 503；b1/b2 沙盒 rc=0 且失败即中止 |
| **批 5（口径统一，先业务裁定）** | SRV-127、SRV-237、SRV-238、SRV-232、SRV-239 | 先裁定"警戒是否计入合格率""餐具 RLU 取哪一层"；再让**所有出口**消费服务端 `conclusionVerdict`/`tablewareVerdict`/`/stats` | 同一批数据的看板、导出、`/v1/stats`、服务端 SQL 四处结论一致（用同数据集断言） |
| **批 6（学校/超管面）** | SRV-201、SRV-202、SRV-203（审计部分）、SRV-205、SRV-206、SRV-207、SRV-208、SRV-209、SRV-210 | 建校加补偿/回滚与审计；回收站 schema 名过白名单；乐观锁改原子；定制校验补 `canteens` 与嵌套值；`parent_option_id` 完整性；GET 端点去掉写库；结构比对扩到 NOT NULL/唯一/索引 | 每项给出反例；schema 名插值必须被白名单拒绝；并发用例不再产生 500 |
| **批 7（账号与防护层）** | SRV-212–SRV-220 | 申请入口校码校验、登录错误码归一、锁定策略加成本与可恢复路径、申请重提修复、超管增删审计、**接线或删除** validationMiddleware、XFF 统一、guest 枚举收紧 | 登录错误码不再区分账号存在性；validationMiddleware 要么挂上并被使用、要么删除（不留"假防护"） |
| **批 8（收口项）** | SRV-240 + R5 缺项 | 修假绿测试（U6 断言补强、XSS 回归扩到 Tableware/Dashboard、`test:frontend` 指向修正）；补 ONLINE_CHECKS 项 4/5；备份/回退吻合性 | 受影响测试全绿且 **0 skip**；未认证边界返回 401/403 且不含业务数据；已授权读归属正确 |

**依赖关系**：批 0 → 批 1 → 批 2 → 批 4（发布边界，越早越安全）→ 批 3 → 批 5（等业务裁定）→ 批 6/7 → 批 8。

## 四、下一步（需要决定的三件事）

1. **是否授权按批 1 先做安全修复**（XSS / 路径穿越 / 匿名 DoS）——这是唯一"可被匿名触发且后果直接"的一组。
2. **SRV-235 的前端调用链需优先复核**：它决定 SRV-106/107 的真实级别，也决定"会话管控"是要修还是要下线。
3. **SRV-127/238 需要业务裁定**（警戒是否计入合格率、RLT 取记录级还是点位级），否则批 5 无法动工。

## 五、边界

- 本轮**只做发现与规划**：未修改任何产品源码，未改数据库，未启停服务，未创建隔离环境。
- 所有新增条目为 **CANDIDATE_STATIC_UNVERIFIED**（并行静态清点、未经逐条回读复核）；历史条目（SRV-101–137 等）状态不变，**不因本轮而关闭或升级**。
- 未执行项写 NOT_RUN，不计为通过。
