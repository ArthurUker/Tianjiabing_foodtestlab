# 窗口② 任务：后端路由 + 中间件修复（9个bug）

## 环境
- **分支**：`main`（commit `f3b55ae`）
- **只改文件**：`backend/routes/userRoutes.js`、`backend/routes/guestRoutes.js`、`backend/routes/syncRoutes.js`、`backend/middleware/idempotencyMiddleware.js`、`backend/middleware/validationMiddleware.js`、`backend/middleware/authMiddleware.js`、`backend/lib/tenantProvisioner.js`
- **切分支**：`git checkout -b fix/window2-middleware`

## 上下文

所有 bug 来自第二轮深度审阅（2026-07-27），编号 NB-XX。本窗口文件与窗口①（server.js）**零重叠**。

---

## Bug 列表

### 🔴 NB-04：登录端点未校验 schoolCode
**文件**：`backend/routes/userRoutes.js`，`POST /api/user/login` handler
**影响**：非法 schoolCode 可能意外命中 public schema 超管账号

**修复**：在 handler 开头增加：
```javascript
if (!isValidSchoolCode(schoolCode)) {
    return res.status(400).json({ error: '非法学校代码' })
}
```
需要从 `tenantClient.js` 导入 `isValidSchoolCode`。

---

### 🔴 NB-06：访客注册无校验
**文件**：`backend/routes/guestRoutes.js`，`POST /api/guest/register` handler
**影响**：可注册弱密码、超长用户名（可能触发 XSS）、恶意 guest_type

**修复**（3 项）：
1. **密码强度**：增加 `if (String(password).length < 8) return res.status(400).json({ error: '密码至少8位' })`
2. **username 格式**：增加 `if (!/^[a-zA-Z0-9_]{3,32}$/.test(username)) return res.status(400).json({ error: '用户名格式非法' })`
3. **guest_type 白名单**：
```javascript
const VALID_GUEST_TYPES = new Set(['viewer', 'export_applicant'])
if (!VALID_GUEST_TYPES.has(guest_type || 'viewer')) {
    return res.status(400).json({ error: '非法的访客类型' })
}
```

---

### 🟠 NB-10：sync 路由缺角色校验
**文件**：`backend/routes/syncRoutes.js`，`POST /api/sync/records` 和 `POST /api/sync/batch`
**影响**：viewer 只读角色可通过 sync 端点写入/更新/删除数据

**修复**：在两个 POST 端点挂载 `requireEditorOrAbove` 中间件。需要从 server.js 的导出确认该中间件的导入路径。

---

### 🟠 NB-11：幂等中间件缺陷
**文件**：`backend/middleware/idempotencyMiddleware.js`
**问题**：
1. 仅以 `Idempotency-Key` header 为缓存键，不校验请求体——攻击者可用相同 key 发送不同 body
2. Map 无大小上限——大量不同 key 可耗尽内存

**修复**：
1. 将请求体 JSON 序列化后的哈希纳入缓存键：`${key}:${hash}`
2. Map 最大条目数 10000，超限时拒绝新缓存并返回 429
3. 定期清扫过期条目

---

### 🟠 NB-12：访客注册/登录端点无限流
**文件**：`backend/routes/guestRoutes.js`
**影响**：`POST /api/guest/register` 和 `POST /api/guest/login` 是公开端点，无 rateLimit

**修复**：从 `validationMiddleware.js` 导入 `rateLimit`，为两个端点添加限流：
```javascript
const guestRegisterLimiter = rateLimit(10, 60 * 1000)  // 每分钟10次
const guestLoginLimiter = rateLimit(20, 60 * 1000)     // 每分钟20次
```
同时 guest login 端点当用户不存在时应执行假 `bcryptjs.compare` 拉平时序（参考 `UserManager.js:161` 的 DS-15 修复）。

---

### 🟡 NB-18：resolveGuestVisibleTypes 缓存 stale
**文件**：`backend/middleware/authMiddleware.js`（`resolveGuestVisibleTypes` 函数）
**影响**：管理员修改 visible_types 后，60 秒内访客仍按旧白名单读取

**修复**：
1. 在 authMiddleware.js 中暴露一个 `clearGuestVisibleTypesCache(schoolCode)` 函数
2. 在模块导出中添加该函数
3. **注意**：还需要窗口①（server.js）在 `PUT /api/admin/schools/:code/customization` 成功后调用此清除函数。请在本文件中实现导出，并在注释中说明 server.js 需要调用的位置。

---

### 🟢 NB-28：sanitizeHtml 正则 ReDoS
**文件**：`backend/middleware/validationMiddleware.js`，约 line 31-36
**问题**：`/<script\b[^<]*(?:(?!<\/script>)<[^<]*)*<\/script>/gi` 嵌套量词可导致灾难性回溯

**修复**：简化为 `/<script\b[^>]*>[\s\S]*?<\/script>/gi`，对 `<style>` 同样处理。

---

### 🟢 NB-29：rateLimit Map 永不清理
**文件**：`backend/middleware/validationMiddleware.js`，rateLimit 实现内部（约 line 364-389）
**问题**：IP 过期后时间戳被 filter 清除但空数组 key 永存，内存缓慢增长

**修复**：在过滤后增加清理逻辑：
```javascript
if (timestamps.length === 0) {
    requestMap.delete(key)
} else {
    requestMap.set(key, timestamps)
}
```

---

### 🟡 NB-05：provisionSchool 中 --accept-data-loss
**文件**：`backend/lib/tenantProvisioner.js`，搜索 `--accept-data-loss`
**影响**：schema 变更导致列类型不兼容时会静默丢数据

**修复**：对 reprovision 场景去掉 `--accept-data-loss`，或在日志中显著警告。对于首次 provision（无数据），该 flag 相对安全。

---

## 自检清单
```bash
node --check backend/routes/userRoutes.js
node --check backend/routes/guestRoutes.js
node --check backend/routes/syncRoutes.js
node --check backend/middleware/idempotencyMiddleware.js
node --check backend/middleware/validationMiddleware.js
node --check backend/middleware/authMiddleware.js
node --check backend/lib/tenantProvisioner.js
```

## 提交
```bash
git add backend/routes/userRoutes.js backend/routes/guestRoutes.js backend/routes/syncRoutes.js \
        backend/middleware/idempotencyMiddleware.js backend/middleware/validationMiddleware.js \
        backend/middleware/authMiddleware.js backend/lib/tenantProvisioner.js
git commit -m "fix(window2): 路由+中间件 — schoolCode校验/访客注册/guset_type/sync角色/幂等/限流/ReDoS/cache"
```
