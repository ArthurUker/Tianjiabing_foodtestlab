# 窗口① 任务：backend/server.js 核心修复（10个bug）

## 环境
- **分支**：`main`（commit `f3b55ae`）
- **只改文件**：`backend/server.js`（**不要碰其他文件**）
- **切分支**：`git checkout -b fix/window1-server backend/main` 或直接在 main 上改

## 上下文

本窗口只修改 `backend/server.js`。所有 bug 来自第二轮深度审阅（2026-07-27），编号 NB-XX。

---

## Bug 列表（按优先级排序）

### 🔴 NB-01：User 表 `is_active` vs `status` 列名不一致
**影响**：用户管理全部功能不可用。schema.prisma User 模型用 `status TEXT`（值 active/disabled），但 server.js 裸 SQL 用 `is_active`（值 true/false）。

**修复**：搜索 `is_active` 的所有出现（`SELECT ... is_active`、`UPDATE ... is_active`、`INSERT ... is_active`），全部替换为 `status`，值从 `true`/`false` 改为 `'active'`/`'disabled'`。共约 10-15 处。

**验证**：`grep -n 'is_active' backend/server.js` 应返回 0 结果

---

### 🔴 NB-02：错误信息泄露（24 处 catch 块）
**影响**：生产环境返回 `details: error.message`，泄露 SQL 语句、表名、列名、约束名。

**修复**：搜索所有 `catch` 块中 `details: error.message` 或 `error: error.message`，改为：
- 开发环境（`NODE_ENV === 'development'`）：保留 `details: error.message`
- 生产环境：删除 details 字段或返回通用文案 `'An error occurred'`

已有工具函数：`backend/routes/auditRoutes.js` 中的 `clientErr` 函数可作为参考模式——在 server.js 顶部写一个 `const clientErr = (msg) => ({ error: msg })`，所有端点统一返回 `clientErr('xxx')` 而非透传 `error.message`。

**关键端点**（24 处分布在约 12 个端点中）：`/api/records/*`、`/api/test-records/*`、`/api/admin/schools/*`、`/api/schools/:code/config`

---

### 🔴 NB-07：reprovision 默认弱密码 `'changeme'`
**位置**：搜索 `changeme`（约 line 849）
```javascript
adminPassword: req.body?.adminPassword || process.env.SEED_ADMIN_PASSWORD || 'changeme'
```

**修复**：移除 `'changeme'` 回退。若未提供 password 且无环境变量，返回 400 `'⚠️ 必须提供 adminPassword'`。

---

### 🟠 NB-09：limit/offset 无上限 → DoS
**位置**：搜索 `parseInt(limit)` 和 `parseInt(offset)`（约 6 处，如 line 1137, 1176 等）

**修复**：对 `limit` 做 `Math.min(parseInt(limit) || 100, 500)` 上限截断；对 `offset` 做 `Math.max(0, parseInt(offset) || 0)`。

---

### 🟠 NB-13：PUT /api/test-records/:id 未调用 sanitizeObjectKeys
**位置**：`PUT /api/test-records/:id` handler（约 line 1540-1567）

**修复**：在 `JSON.stringify(result_data)` 之前调用 `sanitizeObjectKeys(result_data)`。同时为 `status` 字段增加白名单校验（pending/completed/failed/archived）。

---

### 🟠 NB-14：quick-access JWT 缺 userId → 审计写入 500
**位置**：搜索 `POST /api/guest/quick-access`（约 line 201，在 guestRoutes.js 中——确认下是否在 server.js 内还是引用了 guestRoutes.js）

**说明**：quick-access JWT payload 缺 `userId` 字段，后续审计写入 `user_id = null` 违反 NOT NULL 约束。如果 quick-access 在 guestRoutes.js 中，只需在 JWT payload 加 `userId: 'quick-access'`；如果在 server.js 中则在 server.js 改。

---

### 🟡 NB-25：bulk-upsert 无乐观锁
**位置**：搜索 `bulk-upsert` 或 `/api/records/:tableName/bulk`（约 line 1304-1314）

**修复**：在 bulk-upsert 的 update 分支中增加 version 校验（类似单条 PUT 端点的模式），或在注释中明确标注"最后写入胜出"语义。

---

### 🟢 NB-30：SchoolCustomization INSERT 用可预测 ID
**位置**：`provisionSchool` 相关逻辑（搜索 `sc_${code}` 或 `INSERT.*SchoolCustomization`，约 line 741）

**修复**：将 ID 改为 `crypto.randomUUID()` 或使用 Prisma 的 `@default(cuid())` 自动生成。

---

### 🟢 NB-33：应用层 body limit 2MB vs Caddy 8MB 不一致
**位置**：搜索 `express.json({ limit: '2mb' })`（约 line 474）

**修复**：改为 `express.json({ limit: process.env.BODY_LIMIT || '8mb' })` 与 Caddy 对齐，或加注释说明 2MB 是有意限制。

---

### 🟢 NB-34：缺少 HSTS 响应头
**位置**：安全响应头设置（约 line 477-486）

**修复**：在已有安全头列表（X-Content-Type-Options 等）中增加：
```javascript
res.setHeader('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
```
仅当环境变量 `DOMAIN` 已配置时设置（HTTP 部署下 HSTS 无意义）。

---

## 自检清单
修复完成后运行：
```bash
node --check backend/server.js          # 语法
grep -n 'is_active' backend/server.js   # 应为 0
grep -n 'changeme' backend/server.js    # 应为 0
grep -n 'details: error.message' backend/server.js  # 应全部处理
```

## 提交
```bash
git add backend/server.js
git commit -m "fix(window1): server.js 核心修复 — is_active→status + 错误脱敏 + 默认密码 + limit上限 + sanitize + bulk乐观锁"
```
