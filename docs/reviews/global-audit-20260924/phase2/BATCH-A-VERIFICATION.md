# PHASE 2 — Independent Adversarial Verification · BATCH A

- **基线**：`f08e72e3e74d188b4555e0bee16280b3dd0d622b`（工作区在执行前后均无应用代码改动）
- **验证范围**：AUD-001 / 002 / 010 / 012 / 014 / 015 / 016 / 017 / 047
- **第一遍材料**：`docs/reviews/global-audit-20260924/`（ISSUE_INVENTORY.md、VERIFICATION.md、issues.json、probes.mjs、probe-results.json、repository-map.json、coverage.tsv）
- **本轮方法**：从真实代码重新追踪完整调用链 → 检查上游认证/授权/租户隔离/校验/挂载顺序/事务边界/DB 约束/部署约束 → 用**真实应用模块 + 受控替身**独立复现（不使用第一遍的脚本）→ 源码断言交叉复核
- **审计限制**：未修改应用代码、未 commit/push、未连接任何业务数据库。本轮额外设置了指向 `127.0.0.1:1`（不可达端口）的**占位** `DATABASE_URL`，仅用于让租户客户端可被构造（Prisma 惰性连接，连接必然失败），未使用仓库业务 `.env`

## 结论速览

| Issue | 判定 | 复现等级 | Confidence | 优先级建议 |
|---|---|---|---|---|
| AUD-001 | CONFIRMED | A（JSDOM 行为复现） | HIGH | 保持 P1 |
| AUD-002 | CONFIRMED | A（真实 express 路由复现） | HIGH | 保持 P1 |
| AUD-010 | CONFIRMED | B（代码路径确定） | MEDIUM-HIGH | 保持 P1 |
| AUD-012 | CONFIRMED | B（代码路径确定） | HIGH | 保持 P1 |
| AUD-014 | CONFIRMED | A（真实中间件复现） | HIGH | 保持 P1 |
| AUD-015 | CONFIRMED | B（语义等价复现 + 第一遍 SQL 证据） | HIGH | **降级 P2** |
| AUD-016 | CONFIRMED | A（真实函数失败路径复现） | HIGH | 保持 P1 |
| AUD-017 | CONFIRMED | B（代码路径确定） | HIGH | **降级 P2** |
| AUD-047 | CONFIRMED | B（代码路径确定） | MEDIUM-HIGH | 保持 P1 |

复现等级：**A**=已实际复现；**B**=代码路径确定；**C**=依赖部署条件；**D**=理论风险。本批无 C/D 级判定。

---

## AUD-001 · 浏览器记录缓存和离线队列未按学校、账号隔离

**Original claim**：`cache_<table>`、`pending_<table>` 等键不含租户/账号维度且无清理，切校或换账号后新主体直接读到旧主体缓存与待上传任务；待上传任务在发送时使用当前 token。

**Verification verdict：CONFIRMED**

**实际完整调用路径**

1. `new StorageService(tableName)` → `this.localCacheKey = cache_${tableName}` / `this.pendingRequestsKey = pending_${tableName}`（`frontend/js/core/Storage.js:61-62`），构造入参只有表名，无学校/账号。
2. 缓存读写全部直接使用这两个全局键：初始化 `Storage.js:500-504`、写入 `574`/`593`、队列读写 `650-659`；全文件对这两个键**没有任何 `removeItem` 清理点**。
3. 账号/学校相关的清理只发生在认证态：`AuthService.clearAuth()`（`frontend/js/services/AuthService.js:875-904`）用 `_nsKey()` 清 token/user/refresh 键——**不含 `cache_*` / `pending_*`**。
4. 队列请求头在发送时现取当前凭据：`Storage._getHeaders()` → `_getAuthToken()`（`Storage.js:212-217`），故 A 校离线创建的任务会在 B 校会话下携带 B 校 token 发出。
5. 列表读取优先返回本地缓存：`getAll()` 先返回 `_getLocalCacheData()` 再后台同步（`Storage.js:92-96`）。

**关键代码证据**：`frontend/js/core/Storage.js:61-62`、`:212-217`、`:500-504`、`:574`、`:593`、`:650-659`；`frontend/js/services/AuthService.js:875-904`

**现有保护机制**：认证态 key 已按学校命名空间隔离（TD-TenantIsolation，`AuthService.js:880-904`）；后端 schema-per-tenant 隔离。二者都不覆盖浏览器记录缓存。

**第一遍是否遗漏保护机制**：未遗漏。第一遍已说明「服务器 schema 隔离无法补救客户端选错归属」。本轮补充一条此前未写明的前提：该隔离成立**仅因部署为单域名同源**——现网入口 `https://foodsentinel.digifluidic.com`，SPA 与 `/api/*` 同域（`deploy/DEPLOY_READINESS_REPORT.md:84-88`）；若将来按子域分租户，localStorage 会天然隔离，本项不成立。

**Trigger conditions**：同一浏览器（同源）先访问 A 校后切到 B 校，或同校注销后换账号；缓存/队列键不变。

**实际影响**：新主体 UI 直接展示旧主体缓存（含检测人姓名、食堂等 PII）；A 校离线创建的待上传记录可能被以 B 校凭据写入 B 校 schema（归属错误）。

**第一遍影响描述是否准确**：准确。

**Reproduction evidence**：`phase2/probes-batch-a.mjs` 用 JSDOM（同源 `/a/` → `/b/`）加载真实 `StorageService`：新实例读到 `inspector=A校检测员` 与 `pending job id=a-job`；并做键模板/无清理点源码断言（全部通过）。

**反证 / 限制条件**：跨设备无效；若产品后续改为子域隔离则不成立；不影响服务端已有数据（仅客户端展示与后续写入归属）。

**Confidence**：HIGH　**Recommended priority**：保持原优先级（P1）

---

## AUD-002 · 幂等缓存跨租户、跨主体命中，且先于写权限检查

**Original claim**：缓存键仅由 `Idempotency-Key` 与 body hash 组成，命中后直接返回缓存响应，跳过写权限检查；B 校 guest 可获得 A 校写请求的原始成功响应（非匿名，生产有前置 /api 认证）。

**Verification verdict：CONFIRMED**

**实际完整调用路径**

1. 生产挂载顺序：`app.use('/api', recognitionRoutes)`（`backend/server.js:339`）→ `recognitionRoutes` 内部 `router.use(authenticateUser)`（`backend/routes/recognitionRoutes.js:21`，无路径限定，对 `/api/*` 全部生效）→ 后续 `app.use('/', recordRoutes)`（`backend/server.js:347`）。
2. `createRecordRoutes` 内 **router 级**前置：`router.use('/api/records', idempotencyMiddleware)`（`backend/routes/recordRoutes.js:20-21`），先于具体路由 `router.post('/api/records/:tableName', authenticateUser, requireEditorOrAbove, handler)`（`recordRoutes.js:280`）。
3. 键构造：`` const cacheKey = `${key}:${bodyHash(req.body)}` ``（`backend/middleware/idempotencyMiddleware.js:40`），不含 tenant / userId / method / path。
4. 命中即返回：`res.status(cached.status || 200).json(cached.result)`（`idempotencyMiddleware.js:53-58`），**不再调用 `next()`**，因此该路由上的 `authenticateUser` 与 `requireEditorOrAbove` 都不执行。
5. 缓存内容为 handler 原始响应体：`recordRoutes.js:333-337` → `buildRecordPayload(record)`（`backend/lib/recordNormalize.js:26-56`）展开 `sample_info`+`result_data`，含 `inspector`／`canteen`／`testDate`。

**关键代码证据**：`idempotencyMiddleware.js:40`、`:53-58`；`recordRoutes.js:20-21`、`:280`、`:333-337`；`server.js:339`、`:347`；`recognitionRoutes.js:21`

**现有保护机制**：生产前置 `authenticateUser`（要求有效 JWT）→ 匿名不可达（第一遍已明示）。`requireGuestReadOnly` 只覆盖 GET 读路径；写路径的 `requireEditorOrAbove` 被缓存短路跳过。

**第一遍是否遗漏保护机制**：未遗漏，且其表述（"不将其描述为匿名绕过"）与本轮复核一致。

**Trigger conditions**：请求方为**已认证**身份（含 B 校 guest/viewer），且**知道**目标请求的 `Idempotency-Key` 与**逐字节相同**的 body（`JSON.stringify` 口径）。前端键为 `sync_${Date.now()}_${random5}_${type}`（`Storage.js:756-758`），端口 5 位 base36 随机，远程枚举不可行；现实路径是同设备/同客户端跨校重放（离线队列重放、浏览器重试、共享终端）。

**实际影响**：跨租户、跨主体读取 A 校写响应的**未脱敏字段**（检测人姓名等），并绕过写权限判定；不产生任何写入（`writes` 计数保持 1）。

**第一遍影响描述是否准确**：准确，且已附带"需知道 key+body""非匿名"的前置说明。

**Reproduction evidence**：`phase2/probes-batch-a.mjs` 用**真实 express + 真实 `recordRoutes` + 真实 `idempotencyMiddleware`**（认证/守卫为带计数替身）：
- A 校 operator POST（key=K，body=B）→ 200，`writes=1`，`auth=1`，`editor=1`
- B 校 guest 同 key 同 body → **200 且返回 `inspector=A校检测员`**，`writes=1`，`auth=1(+0)`，`editor=1(+0)`
- 不同 URL（`/api/test-records`）+ 不同身份再重放 → 仍命中同一响应，证明键不含 method/path/主体

**反证 / 限制条件**：需要 key+body 精确知识（不可盲打）；body 键顺序敏感；生产前置认证排除匿名；单实例内存 store（多实例部署下缓存不共享，命中范围缩小——`idempotencyMiddleware.js:1-9` 自述）。

**Confidence**：HIGH　**Recommended priority**：保持原优先级（P1）

---

## AUD-010 · 停用学校未阻断内部登录和已签发 token

**Original claim**：`School.status` 改为 disabled 后，该校 User/Guest 仍可登录、已签发 token 继续可用；内部链路主要检查主体自身状态。

**Verification verdict：CONFIRMED**

**实际完整调用路径**

1. 停用入口：`PATCH /api/admin/schools/:code/status`（`backend/routes/schoolRoutes.js:404-422`）仅执行 `prisma.school.update({ data: { status } })`，**无任何令牌/会话失效**。
2. 登录：`UserManager.loginUser`（`backend/modules/UserManager.js:313-390`）依次校验用户名、租户归属（`user.school_code === this.schoolCode`）、锁定、bcrypt、`user.status !== 'active'`——**从不查询 `public.School`**。
3. 受保护请求：`authenticateUser` 员工分支（`backend/middleware/authMiddleware.js:364-386`）回查租户 `User` 的 `status/school_code/must_change_password/role` 与 `revoked_tokens`——同样不检查 School。
4. 访客入口：`POST /api/guest/quick-access`（`backend/routes/guestRoutes.js:88-99`）只校验学校**存在**与 `SchoolCustomization.guest_enabled`，不校验 `school.status`。
5. DB 级兜底不存在：`role-audit-trigger.sql` 的触发器仅挂 `AFTER UPDATE OF role ON "User"`（`backend/prisma/role-audit-trigger.sql:92-96`），不监听 `School`。

**关键代码证据**：`schoolRoutes.js:404-422`；`UserManager.js:313-390`（378 仅检查 user.status）；`authMiddleware.js:364-386`；`guestRoutes.js:88-99`；`role-audit-trigger.sql:92-96`

**现有保护机制**：OpenAPI 侧已实现学校状态检查（`openApiRoutes.js:163-167`），与内部链路**不一致**——这正说明该校状态语义在平台内已被认可，只是未覆盖内部身份链路。

**第一遍是否遗漏保护机制**：未遗漏。本轮新增一条反证性质的确认：不存在以 DB 触发器/定时任务形式存在的"停校即吊销"兜底（`revokeAllUserTokens` 的 6 个调用点均为用户级操作：改密/重置/禁用/改角色/删除/管理更新）。

**Trigger conditions**：平台超管将某校 `status` 置为 `disabled`；该校 User/Guest 保持 active。

**实际影响**：停校后仍可登录、读写该校数据、获取访客 token；停校这一治理动作对内部链路实际无效。

**第一遍影响描述是否准确**：准确。

**Reproduction evidence**：`phase2/probes-batch-a.mjs` 静态断言组（停用 handler 无吊销/会话操作；loginUser 与认证回查无 School 查询；quick-access 查存在不查 status）全部通过。未做真实 DB 运行时复现（需隔离库），判定依据为**代码路径确定（B）**。

**反证 / 限制条件**：需平台超管操作；用户账号若另行被禁用则不受影响（本项只讨论学校维度）。

**Confidence**：MEDIUM-HIGH（无运行时 DB 复现，但路径无分支歧义）　**Recommended priority**：保持原优先级（P1）

---

## AUD-012 · 退出及远程会话撤销没有绑定 JWT 有效性

**Original claim**：logout 不做服务端撤销；会话表 `status=revoked` 不影响 JWT 认证与刷新；已保存 token 仍可用。

**Verification verdict：CONFIRMED**

**实际完整调用路径**

1. `POST /api/user/logout`（`backend/routes/userRoutes.js:191-194`）注释即写明"JWT 无状态，服务端无需作废"，handler 仅 `res.json({ success: true })`；前端确实调用该接口（`frontend/js/services/AuthService.js:348`）。
2. 会话撤销：`DELETE /api/session/:id` 与 `/others` 只更新 `Session.status='revoked'`（`backend/routes/sessionRoutes.js:70-91`、`:94-114`）。
3. 认证：`authenticateUser`（`authMiddleware.js:322-397`）只查 Guest/User + `public.revoked_tokens`；**认证链路与刷新链路均无 Session 表查询**（源码断言）。
4. 刷新：`POST /api/user/refresh-token`（`userRoutes.js:287-314`）校验吊销表与用户状态，同样不查 Session。

**关键代码证据**：`userRoutes.js:191-194`、`:287-314`；`sessionRoutes.js:70-114`；`authMiddleware.js:322-397`

**现有保护机制**：passwords/role/disable/delete 等路径会写 `revoked_tokens`（`user_all`），确实能即时失效 token；但 logout 与"会话管理 UI"不在其中。

**第一遍是否遗漏保护机制**：未遗漏。

**Trigger conditions**：调用 logout，或在会话界面撤销某会话（含"登出其它设备"）。

**实际影响**：界面显示已退出/已撤销，但保存的 access token（≤30 分钟）与 refresh token（≤7 天，可续期）仍有效——"远程撤销"无法真正终止会话，除非另有改密等触发全量吊销。

**第一遍影响描述是否准确**：准确。

**Reproduction evidence**：`phase2/probes-batch-a.mjs` 静态断言组通过：logout handler 内无任何 `revoke`；认证/刷新代码无 `session.findUnique/findFirst`；会话撤销仅写 `status:'revoked'`。第一遍另有 logout 无吊销依赖仍 200 的最小复现（`probe-results.json`）。

**反证 / 限制条件**：token 有 TTL 上限，非永久；若用户改密或角色变更，另有吊销路径覆盖。

**Confidence**：HIGH　**Recommended priority**：保持原优先级（P1）

---

## AUD-014 · 认证数据库故障时默认先放行两次请求

**Original claim**：JWT 有效但 DB 回查失败时，前两次请求按 fail-soft 放行（沿用 token 内旧权限），第 3 次才 503；成功回查会清零计数。

**Verification verdict：CONFIRMED**

**实际完整调用路径**

1. `authenticateUser` 员工分支：`const [dbUser, revoked] = await Promise.all([...])`（`authMiddleware.js:366-373`）。
2. 任一失败 → `catch`：`const failClosed = _onRecheckFailure(error)`（`:429`）→ 计数 < 阈值时**不返回**，仅告警，继续执行到 `req.user = u; req.db = ...; next()`（`:433-443`）→ 业务链继续执行。
3. 阈值：`DB_RECHECK_FAIL_THRESHOLD = Number(process.env.AUTH_DB_RECHECK_FAIL_THRESHOLD || 3)`（`authMiddleware.js:220`）；仓库内**没有任何部署文件覆盖**该变量（`.env.example:93` 仅有缓存 TTL 注释）。
4. 清零：`_onRecheckSuccess()`（`:257-262`）在每次回查成功时把进程级计数清零。

**关键代码证据**：`authMiddleware.js:220`、`:244-255`、`:257-262`、`:366-373`、`:429-443`

**现有保护机制**：连续失败阈值（3）可让持续故障快速转入 503；失败计数与指标可观测（`getRecheckFailState`）。这是文档化的可用性折中（注释明确"避免瞬时抖动误伤"）。

**第一遍是否遗漏保护机制**：未遗漏。

**Trigger conditions**：JWT 签名有效 + 当前用户/吊销信息回查抛错（DB 不可达、连接池耗尽等）；多用户交错时任一成功回查会清零计数，可能使 fail-soft 窗口被反复延长。

**实际影响**：故障窗口内，token 内**旧角色**继续生效——包括已被禁用/已降权但吊销记录无法读取的账号；两次请求可完成读或写业务。这不是"只读降级"，而是完整权限放行。

**第一遍影响描述是否准确**：准确（200/200/503 与本轮一致）。

**Reproduction evidence**：`phase2/probes-batch-a.mjs` 直接调用**真实 `authenticateUser`**（fake manager + 全部抛错的 fake DB）：状态序列 `200 / 200 / 503`，前两次 `next()` 被调用且 `req.user.role='admin'`（token 内旧角色被沿用）；阈值读取为 3。

**反证 / 限制条件**：计数为进程级，多实例各自独立（注释自述）；若部署显式设置 `AUTH_DB_RECHECK_FAIL_THRESHOLD=1` 可消除该窗口（当前未设置）。

**Confidence**：HIGH　**Recommended priority**：保持原优先级（P1）

---

## AUD-015 · iat + 1 比较永久漏吊销同秒签发的旧 token

**Original claim**：`revoked_at >= to_timestamp(iat + 1)` 使"同一秒内先签发、后吊销"的旧 token 永不命中该吊销记录。

**Verification verdict：CONFIRMED（优先级建议降级）**

**实际完整调用路径**

1. `isTokenRevoked`（`backend/middleware/authMiddleware.js:82-102`）：`WHERE jti = $1 OR (token_type='user_all' AND user_id = $2 AND revoked_at >= to_timestamp($3 + 1))`。
2. 认证侧（`authMiddleware.js:334`、`:372`）与刷新侧（`backend/routes/userRoutes.js:287`）使用同一口径；`getTokenRevocationReason` 同样（`authMiddleware.js:111-129`）。
3. 设计意图有注释说明：`authMiddleware.js:74-79` 明确 `iat+1` 是为了避免"改密成功后同秒重新签发的新 token 被误吊销"。

**关键代码证据**：`authMiddleware.js:82-102`、`:111-129`；`userRoutes.js:287`

**现有保护机制**：`jti` 精确吊销不受影响（单 token 吊销路径精确匹配）；`iat+1` 只影响 `user_all` 全量吊销的边界秒。

**第一遍是否遗漏保护机制**：未遗漏（其修复方向已指出"不要用扩大旧 token 豁免区间解决改密后重新登录问题"，说明已知设计背景）。

**Trigger conditions**：目标 token 的 `iat` 与该用户产生 `user_all` 吊销记录的 `revoked_at` 落在**同一整数秒**（签发先、吊销后）。

**实际影响**：该枚 token 与这条吊销记录永不匹配：access 最长 30 分钟内继续可用；若漏吊销的是 refresh token，则可续期（续期时仍会校验用户状态，故"禁用户"场景下最终仍受阻，但"改密"场景下用户仍 active，续期成功）。

**第一遍影响描述是否准确**：技术事实准确，但"永久漏吊销"的措辞容易被读成吊销机制失效；实际是**1 秒时序窗口内的单枚 token**，窗口外一切正常。第一遍未强调"设计折中"与概率量级。

**Reproduction evidence**：`phase2/probes-batch-a.mjs` 语义等价复现：`iat=100s, revoked_at=100.5s → hit=false`；`revoked_at=101.0s → hit=true`；`iat=99s → hit=true`。另有第一遍在 PostgreSQL 18.4 上的真实表达式验证（`VERIFICATION.md:54-64`）。

**反证 / 限制条件**：真实的常见场景（改密/禁用发生在登录或刷新之后的 ≥1 秒）正常命中；窗口内漏吊销也受 access TTL 与后续吊销事件兜底。

**Confidence**：HIGH　**Recommended priority**：**降级（P1 → P2）**。理由：触发需签发与吊销同秒的时序巧合（概率 ≈ 1s / 会话间隔），影响上限受 TTL 约束，属边界精度缺陷而非权限体系失效；若上"统一 session epoch"方案则可同时消除本项与 AUD-016 的非原子问题。

---

## AUD-016 · 密码变更与会话吊销非原子，吊销失败仍返回成功

**Original claim**：改密/重置的密码写入与 `revokeUserSessions` 不在同一事务；吊销失败被捕获记录但不抛出，调用方仍返回成功。

**Verification verdict：CONFIRMED**

**实际完整调用路径**

1. 用户自助改密：`changePassword` —— 密码更新在 `await this.prisma.$transaction(async (tx) => { tx.user.update(...) })`（`backend/modules/UserManager.js:456-467`）之后，**事务外**调用 `await this.revokeUserSessions(userId, 'password_change', { userId })`（`:469-472`），随后 `return { success: true }`（`:476-479`）。
2. 管理员重置：`resetPassword` —— `user.update(...)`（`:662-669`）→ `revokeUserSessions(userId, 'password_reset', actor)`（`:678`）→ 返回成功（`:682-685`）。
3. `revokeUserSessions`（`:195-211`）：`catch` 后仅 `console.error` + `logSecurityEvent('REVOCATION_WRITE_FAILED', ...)`，**不 rethrow**。

**关键代码证据**：`UserManager.js:195-211`、`:456-479`、`:660-685`

**现有保护机制**：吊销失败会落 `SECURITY:REVOCATION_WRITE_FAILED` 安全事件，供告警通道（`securityAlerts.js`）消费；运维可感知。但不能代替安全状态更新。

**第一遍是否遗漏保护机制**：未遗漏。

**Trigger conditions**：密码更新成功、随后写 `public.revoked_tokens` 失败（DB 抖动/权限/连接问题）。

**实际影响**：接口返回"密码已更新/已重置"成功，但旧 access/refresh 凭据未被吊销；与 AUD-014 叠加时，DB 故障窗口内认证回查同样失败 → fail-soft 放行 → 旧凭据**实际仍可用**。

**第一遍影响描述是否准确**：准确。

**Reproduction evidence**：`phase2/probes-batch-a.mjs` 用真实 `UserManager.revokeUserSessions` + 写吊销必然抛错的 fake rootPrisma：调用**不抛出**，且产生 `SECURITY:REVOCATION_WRITE_FAILED` 事件；配合源码断言（事务内更新、事务外吊销、调用方无补偿检查）确认调用方仍返回成功。

**反证 / 限制条件**：失败会留下可告警的安全事件；若 DB 完全不可用，密码更新本身通常也会失败（但"部分成功"窗口存在：事务已提交、吊销写失败）。

**Confidence**：HIGH　**Recommended priority**：保持原优先级（P1）

---

## AUD-017 · 全局测试报告接口对任意已登录身份开放读写

**Original claim**：`/api/test-results` 仅挂 `authenticateUser`，数据走全局 public Prisma；operator/viewer/guest 均可读写全局报告与管理操作。

**Verification verdict：CONFIRMED（优先级建议降级）**

**实际完整调用路径**

1. `const testResultRoutes = createTestResultRoutes(userManager, prisma)` → `app.use('/api/test-results', testResultRoutes)`（`backend/server.js:333-335`，注入**全局 public** prisma）。
2. `router.use(authenticateUser)`（`backend/routes/testResultRoutes.js:73-74`），全文件**无** `authorizeAdmin/authorizeRoles/requirePlatformSuperAdmin`。
3. 端点（源码枚举）：`GET /defs`、`GET /me`、`GET /cases`、`GET /cases/:id/history`、`POST /executions`、`POST /cases/close`、`POST /cases/mark-fixed`、`GET /summary`、`POST /upload`、`GET /evidence/:caseId/:file` —— 其中 4 个写端点（含上传）。
4. guest 身份可通过该认证（guest 分支在 `authMiddleware.js:322-348` 同样放行），快速访客（`is_quick_access`）甚至跳过 DB 回查。

**关键代码证据**：`server.js:333-335`；`testResultRoutes.js:9`（注释自述"全部 authenticateUser，任意已登录账号可提交/查看——测试场景"）、`:73-74`、`:203`、`:301`、`:333`、`:398`

**现有保护机制**：仅"必须登录"这一条；上传有 mime/大小/数量限制（`testResultRoutes.js:38-46`）。

**第一遍是否遗漏保护机制**：未遗漏。本轮补充一条影响严重性判断的事实：该路由头部注释自称**临时测试工具**且明确"任意已登录账号可提交/查看"，说明这是**已声明的设计意图**而非疏忽遗漏——这降低"隐藏后门"成分，但不改变越权事实。

**Trigger conditions**：任意已认证身份（含 guest）直接请求 `/api/test-results/*`。

**实际影响**：可读取全局测试用例/执行轨迹/证据图片，并可写入执行记录、关闭问题、标记"已修复"（污染质量状态）、上传文件。数据与请求方学校无关。与 AUD-018（case_id 目录逃逸）组合时进一步放大。

**第一遍影响描述是否准确**：准确。

**Reproduction evidence**：`phase2/probes-batch-a.mjs` 源码断言组通过（仅 authenticateUser、无角色守卫、10 个端点清单、server.js 注入全局 prisma）。未做 HTTP 运行时复现（该路由需要真实 DB 才可执行 handler），判定为代码路径确定（B）。

**反证 / 限制条件**：影响面限于测试报告模块，不含检测业务数据；若该模块在生产未启用/无前端入口则实际暴露面更小（本轮未验证前端入口在生产是否可达）。

**Confidence**：HIGH（代码路径清晰）　**Recommended priority**：**降级（P1 → P2）**。理由：不涉及租户业务数据的读写，属模块级权限过宽；仍应限制为平台/授权角色。

---

## AUD-047 · 学校删除后 OpenAPI 授权残留，可重新附着到同代码新学校

**Original claim**：`OpenApiGrant` 以 `school_code` 文本关联、无外键与生命周期处理；删除学校不撤销 grant，同 code 重建后旧对接方仍可读新学校数据。

**Verification verdict：CONFIRMED**

**实际完整调用路径**

1. 数据模型：`OpenApiGrant` 仅有 `school_code String` + `@@unique([client_id, school_code])`，**无 School 关系**（`backend/prisma/schema.prisma:412-434`）。
2. 彻底删除：`DELETE /api/admin/schools/:code` 事务内 `ALTER SCHEMA ... RENAME` + `tx.school.delete` + 写 `recycle_bin`（`backend/routes/schoolRoutes.js:490-502`），**不触碰 `OpenApiGrant`**。
3. 同 code 重建：`POST /api/admin/schools` → `provisionSchool`（`schoolRoutes.js:222-243`），仅当**schema 已存在**且非 `allowExisting` 时抛 409（`backend/lib/tenantProvisioner.js:120-133`）；删除已把 schema 改名，故重建顺利。创建路径不检查 `recycle_bin`。
4. 对外读取：`resolveSchool` 先按 client 的 grants（`openApiRoutes.js:139-148`）取 `school_code` 命中的 active grant，再查 School 并要求 `status === 'active'`（`:163-167`）。
5. 结果：删除期间 School 缺失 → 404（中间态保护）；同 code 新学校 active 后，**旧 grant 自动重新生效**，旧 API Key 无需重新授权即可读取新学校数据。

**关键代码证据**：`schema.prisma:412-434`；`schoolRoutes.js:222-243`、`:490-502`；`tenantProvisioner.js:120-133`；`openApiRoutes.js:139-148`、`:150-171`

**现有保护机制**：访问期 `School.status` 检查（删除后 404）；授权保存接口会把"未在请求中列出的学校"置为 disabled（`backend/routes/adminOpenApiRoutes.js:358-379`）——即若删除后有人重新保存过该对接方授权配置，残留会被停用（依赖人工动作，非自动）。

**第一遍是否遗漏保护机制**：未遗漏（已注明"删除后立即访问仍会被 school 检查拒绝"）。本轮补充上述人工缓解路径与触发概率判断。

**Trigger conditions**：① 平台删除某校；② 之后以**同一 code** 新建学校（含回收站恢复路径）；③ 期间无人重新保存该对接方授权配置。

**实际影响**：授权实体跨越学校生命周期存续，旧的第三方凭据自动获得新学校数据读取权（含检测记录、可含检测人姓名，取决于 grant 配置）。属跨租户授权边界失效。

**第一遍影响描述是否准确**：准确。

**Reproduction evidence**：`phase2/probes-batch-a.mjs` 源码断言组通过（grant 无 School 关系、删除事务不含 openApiGrant、创建不检查回收站、resolveSchool 的检查点与缺失的世代校验）。未做真实 DB 运行时复现（需隔离库），判定为代码路径确定（B）。

**反证 / 限制条件**：需要"删除 + 同 code 重建"两步运维动作；若学校被永久删除且永不复用该 code，则不触发；新建学校时若同时调用了授权保存接口，残留会被停用。

**Confidence**：MEDIUM-HIGH　**Recommended priority**：保持原优先级（P1）

---

## 汇总

```
CONFIRMED:                  9
PARTIALLY_CONFIRMED:        0
FALSE_POSITIVE:             0
NOT_REPRODUCIBLE:           0
NEEDS_RUNTIME_VERIFICATION: 0
```

判定为 CONFIRMED 但**建议调整优先级**的 2 项：AUD-015（P1→P2）、AUD-017（P1→P2）。

### 1. 第一遍审计最可信的发现

- **AUD-002**（幂等缓存跨租户/跨主体命中）：本轮用**不同的实现方式**（真实 express 路由链 + 受控守卫计数）独立复现成功，并首次量化了"认证与写权限守卫被跳过的次数为 0"这一直接证据；触发前提（key+body）与生产前置认证都被第一遍如实标注，属于"证据、影响、限制"三者齐备的高质量 finding。
- **AUD-014**（认证 fail-soft 放行两次）：直接调用真实中间件得到 `200/200/503`，与第一遍的 supertest 结果一致；`AUTH_DB_RECHECK_FAIL_THRESHOLD` 在生产无覆盖，结论稳固。
- **AUD-016**：吊销失败不上抛的机制用真实函数复现，与 AUD-014 形成"故障窗口内旧凭据仍可用"的完整链条。

### 2. 第一遍审计最可能被高估的发现

- **AUD-015**：技术事实成立，但触发窗口仅 1 秒、且 `iat+1` 是注释在案的**有意折中**（为支持改密后同秒重登）；"永久漏吊销"措辞偏重。建议降级 P2，并优先考虑与 AUD-016 一起用统一会话世代（session epoch）方案根治，而不是单独放大本项。
- **AUD-017**：事实成立（任意登录身份可读写），但代码注释显示这是**明确声明的临时测试工具**设计，且不涉及租户业务数据；建议降级 P2 并单独决策该模块的生产定位。
- **AUD-002 的措辞**：第一遍正文已避免"匿名绕过"，但标题级表述仍可能被下游读者理解为"任意人可读"；实际需 key+body 精确知识，主要现实路径是同设备/同客户端跨校重放。这一限制建议在最终修复工单中显著标注。

### 3. 需要 Codex/Astra 最终仲裁的问题

1. **AUD-015 的优先级与修复策略**：接受 `iat+1` 的 1 秒豁免（P2，文档化），还是改为 session/token epoch（根治，同时覆盖 AUD-016 的原子性）。
2. **AUD-002 的修复位置**：将幂等中间件移至认证+授权之后（改动路由链，注意仍需保住"重试去重"语义），还是保持位置但把缓存键补上 `tenantId+userId+method+path` 并缓存**脱敏后**响应。
3. **AUD-017 的产品定位**：`/api/test-results` 是否限制为平台角色；若保留学校协作，需要显式角色与范围模型。
4. **AUD-010 的停校语义**：停用学校是否应立即吊销全校用户/访客 token（批量 `user_all` 写入的规模与多实例一致性成本）。
5. **AUD-047 的重建语义**：同 code 新建学校与回收站恢复是否应共享 grant（当前是"自动继承"），还是强制重新授权并递增 `scope_version`。

### 4. 系统性共同 root cause

本轮 9 项可归为三条系统性根因：

1. **"缓存键不含主体/租户维度，且缓存判定先于授权判定"** —— AUD-001（浏览器 `cache_*`/`pending_*`）与 AUD-002（服务端幂等 store）是同一缺陷模式在两层（客户端/服务端）的复现：都以"内容等价"作为命中条件，忽略"谁在读写"。
2. **"身份态失效依赖显式吊销写入，而写入既非强制也非全路径覆盖"** —— AUD-010（学校停用不写吊销、认证不查学校）、AUD-012（logout/会话撤销不写吊销）、AUD-014（吊销与用户回查失败即 fail-soft）、AUD-015（吊销边界秒漏判）、AUD-016（吊销写失败被吞）共享同一根因：**授权状态的"真值"分散在多个存储（User/School/Session/revoked_tokens）且缺少统一世代语义**，导致任一路径缺失或失败都退化为"放行"。
3. **"授权实体与资源生命周期解耦"** —— AUD-047 单独成类：grant 以业务代码（文本）而非不可复用 ID/世代关联学校。

修复优先级建议：根因 2（认证态一致性）覆盖面最广（5/9 项），且与 AUD-014/016 的叠加风险最高。

---

## NEW_FINDINGS_CANDIDATES（不并入正式清单）

| 候选 | 描述 | 证据 | 级别 |
|---|---|---|---|
| NF-A-01 | `authenticateUser` 末尾的 `req.db = createTenantClient(...)` 位于 `try/catch` **之外**（`authMiddleware.js:437-443`）。当租户客户端构造失败（如 `DATABASE_URL` 缺失/非法）时，fail-soft 放行的请求会在中间件外抛出，表现为 500 而非 503，且 fail-soft 判定被绕过。生产中 DB 宕机不影响构造（Prisma 惰性连接），故仅在配置缺失类场景触发。 | 本轮探针首次运行时复现：`缺少 DATABASE_URL，无法创建租户客户端` 从 `authMiddleware.js:441` 抛出并逃出 try/catch | 低（配置类） |
| NF-A-02 | 幂等 store 为**进程内 Map**（`idempotencyMiddleware.js:6`），多实例部署下缓存不共享：同一 key 在不同实例会重复执行写操作。这**降低** AUD-002 的跨主体命中面，但同时意味着"幂等"承诺在多实例下不成立（与 AUD-002 的根因相反方向的影响）。 | `idempotencyMiddleware.js:1-9` 注释自述 | 中（既有明示） |

---

## 附录：本轮产物与可重跑方式

- `phase2/probes-batch-a.mjs` —— 独立验证脚本（真实模块 + 受控替身；无外部网络、无业务 DB）
- `phase2/probe-results-batch-a.json` —— 结构化观测结果（14 条）
- 重跑：`node docs/reviews/global-audit-20260924/phase2/probes-batch-a.mjs`

本轮未执行：真实数据库 HTTP 集成测试（AUD-010/017/047 需要隔离库与租户夹具）、Cypress/浏览器端到端、任何部署或数据变更。
