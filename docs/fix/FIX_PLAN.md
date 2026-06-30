# 食品安全检验管理系统 Pro — 修复计划总进度看板

**文档路径**：`docs/fix/FIX_PLAN.md`
**基于审阅版本**：REVIEW_GUIDE.md **v0.10**
**计划制定日期**：2026-06-22
**文档版本**：**v1.12**（2026-06-30 更新；文档基线校准）

> 本文件为修复工作的**总索引和进度看板**。
> 每个问题的详细描述、修复代码、验收标准见对应子文件。

---

## ⚠️ AI 修复操作约束规则（所有 AI 工具必读）

> 适用范围：GitHub Copilot、Claude 等所有 AI 辅助工具。
> **执行任何修复前，必须完整阅读本节规则。**

| 规则 | 说明 |
|------|------|
| 🚫 禁止全文重写 | 任何文件均不得整体替换；每次改动必须是最小化 diff |
| 📍 定位优先 | 每处改动须提供精确定位依据（函数名/注释关键字/行号范围之一） |
| 📋 改动范围声明 | 提交前用 `git diff --name-only` 核验，确保与声明一致 |
| 🔒 禁止副作用 | 修复单一问题时，不得顺带修改无关逻辑、重命名变量或调整代码风格 |
| ✅ 测试前置 | 每个修复须提供人工验证步骤（后端提供 curl 命令，前端提供 Console 验证步骤） |
| 📝 提交规范 | 格式：`fix(P0-XX): 描述`，不超过 50 字；不同编号禁止合并提交 |
| ⚠️ 超范围确认 | 若需修改超过文件 30% 的内容，须先向人工确认，不得自行执行 |

---

## 文档版本变更记录

| 版本 | 日期 | 作者 | 变更内容 |
|------|------|------|---------|
| v1.0 | 2026-06-22 | Copilot | 初始创建，基于 REVIEW_GUIDE v0.6；P0×9、P1×23、P2×20、DOCS×4，共 **56 项**，预估工时 ~82.5h |
| v1.1 | 2026-06-22 | 郭博 / Monica | 对齐 REVIEW_GUIDE v0.8；补录 P0-10、P1-24/25/26、P2-21/22 共 **5 项**；新增 P0-10→P1-25、P1-26→DOCS-03 依赖链；工时重新汇总；总计 **61 项**，预估工时 ~88.5h |
| v1.2 | 2026-06-22 | Code Buddy / Monica | P0-03、P0-04、P0-05 修复完成，状态更新为 ✅；经 Monica 代码审阅通过 |
| v1.3 | 2026-06-22 | Code Buddy / Monica | P0-02 修复完成，状态更新为 ✅；经 Monica 代码审阅通过 |
| v1.4 | 2026-06-22 | Code Buddy / Monica | P0-01 修复完成，状态更新为 ✅；经 Monica 代码审阅通过 |
| v1.5 | 2026-06-23 | Code Buddy / Monica | P0-02 遗留补修（userRoutes.js 统一认证中间件）、P0-05 遗留补修（seed.js 移除 fallback 明文密码 + .env.example 补充 SEED_*_PASSWORD 说明）核验通过；经 Monica 远端 GitHub 核验 |
| v1.6 | 2026-06-23 | Code Buddy / Monica | P0-06 修复完成（record_code 统一为 buildDeterministicRecordCode，schema.prisma 添加 @unique 约束）；P0-08 修复完成（移除 temp-token- 前缀判断）；P0-10 修复完成（根目录 package.json start 脚本修正，添加 type:module）；状态更新为 ✅ |
| v1.7 | 2026-06-23 | Monica | 同步 REVIEW_GUIDE 至 v0.10；基于审阅版本字段更新；P0 完成率更新为 80%（8/10） |
| v1.8 | 2026-06-24 | Copilot | P0-07 修复完成（后端新增 /api/guest/quick-access 接口签发真实 JWT，GuestAuthService.quickAccessAsViewer 改为 async，Router.js 移除客户端快速访问旁路，login.html / main.js 调用点改为 await）；P0 完成率更新为 90%（9/10） |
| v1.10 | 2026-06-29 | Copilot | 完成 P1-02（幂等中间件 cleanup 节流）、P1-04（密码强度提升为至少8位且包含字母+数字）、P1-05（新增 `/api/user/refresh-token` 并对齐前端刷新路径）；P1 完成率更新为 11.5%（3/26） |
| v1.11 | 2026-06-29 | Copilot | 完成 P1-03（注册逻辑移除自动虚假邮箱，改为 `email: null`）与 P1-19（AdaptiveUploadQueue 指纹缓存改为 TTL 批量过期清理，移除 FIFO 淘汰策略）；P1 完成率更新为 19.2%（5/26） |
| v1.12 | 2026-06-30 | Copilot/Monica | 文档基线校准：P0-09 状态修正为已完成；P0 完成率更新为 100%；P1-02/03/04/05/19 子文档滞后问题登记 |

---

## 目录结构

```
docs/fix/
├── FIX_PLAN.md          ← 本文件（总进度看板）
├── P0/                  ← 高危问题（10项）
├── P1/                  ← 重要问题（26项）
├── P2/                  ← 优化建议（22项）
└── DOCS/                ← 文档修复（4项）
```

---

## 关键依赖关系

```
P0-02（统一 authMiddleware）
    └─► P0-01（syncRoutes 重写）
            └─► P1-16（BackupRestore 修复）

P0-06（record_code 统一）
    └─► P1-15（重复数据根治）

P1-01（路由顺序修复）
    └─► P2-15（自动解决）

P0-07（快速访问认证修复）
    └─► P1-18（病原体访客权限）
            └─► P2-19（login.html 描述更新）

P1-21（Auth.js 重命名）
    └─► P0-09（auth.verify() 权限校验）

P0-10（根目录 package.json 修复）
    └─► P1-25（双 package.json 版本同步）

P1-26（数据库路径歧义确认）
    └─► DOCS-03（DATABASE_SCHEMA.md 路径统一）
```

---

## 执行路线图

| 阶段 | 时间 | 目标 |
|------|------|------|
| 第一阶段 | Day 1~3 | 消除所有 P0 安全漏洞（10项） |
| 第二阶段 | Week 1  | 修复 P1 功能正确性问题（前 13 项）|
| 第三阶段 | Week 2  | 完成 P1 架构优化（后 13 项）|
| 第四阶段 | Week 3  | P2 优化 + 文档修复（22 + 4 项）|

---

## P0 高危问题（10 项）

| ID | 问题描述 | 预估工时 | 状态 | 完成日期 |
|----|---------|---------|------|---------|
| `P0-01` | syncRoutes.js 无认证 + 不操作DB + CommonJS 三重问题 | 4h | ✅ 已完成 | 2026-06-22 |
| `P0-02` | authenticateUser 中间件三处实现不一致 | 3h | ✅ 已完成 | 2026-06-23（遗留补修核验通过） |
| `P0-03` | JWT 密钥 fallback 为弱明文字符串 | 0.5h | ✅ 已完成 | 2026-06-22 |
| `P0-04` | POST /api/user/register 完全公开无需授权 | 0.5h | ✅ 已完成 | 2026-06-22 |
| `P0-05` | seed.js 初始密码明文写入公开仓库 | 1h | ✅ 已完成 | 2026-06-23（遗留补修核验通过） |
| `P0-06` | record_code 双重生成逻辑导致幂等性失效 | 3h | **状态**：✅ 已完成（2026-06-23） | 2026-06-23 |
| `P0-07` | 快速访问模式完全绕过后端认证 | 4h | **状态**：✅ 已完成（2026-06-24，四端全链核验通过） | 2026-06-24 |
| `P0-08` | Storage.js _canSyncWithServer() temp-token- 前缀可被客户端伪造 | 1h | **状态**：✅ 已完成（2026-06-23） | 2026-06-23 |
| `P0-09` | auth.verify() 对编辑操作完全不做权限校验 | 3h | ✅ 已完成 | 2026-06-24 |
| `P0-10` | 根目录 package.json 缺少 "type":"module" 且无 Prisma 依赖，生产部署存在启动崩溃风险 | 1h | **状态**：✅ 已完成（2026-06-23） | 2026-06-23 |

#### 修复指令（Copilot 执行）

**目标文件**：`backend/server.js`（仅此一个文件）

**步骤 1 — 新增中间件函数**
定位：搜索 `export function authenticateUser` 函数定义，在该函数结束的 `}` 之后插入：
```javascript
// P0-09: 角色校验中间件 — 仅允许 admin / editor，拒绝访客写操作
function requireEditorOrAbove(req, res, next) {
  if (req.user && req.user.guest_type) {
    return res.status(403).json({
      error: '访客无写操作权限',
      code: 'GUEST_WRITE_FORBIDDEN'
    })
  }
  if (req.userRole && req.userRole !== 'admin' && req.userRole !== 'editor') {
    return res.status(403).json({
      error: '权限不足，需要编辑员或管理员权限',
      code: 'INSUFFICIENT_ROLE'
    })
  }
  next()
}
```

**步骤 2 — 修改 PUT 路由**
定位：搜索 `app.put('/api/records/:tableName/:id', authenticateUser,`
仅将 `authenticateUser,` 替换为 `authenticateUser, requireEditorOrAbove,`
其余参数和函数体一字不改。

**步骤 3 — 修改 DELETE 路由**
定位：搜索 `app.delete('/api/records/:tableName/:id', authenticateUser,`
仅将 `authenticateUser,` 替换为 `authenticateUser, requireEditorOrAbove,`
其余参数和函数体一字不改。

**步骤 4 — 验证**
```bash
# 获取访客 token
GUEST_TOKEN=$(curl -s -X POST http://localhost:3002/api/guest/quick-access \
  -H "Content-Type: application/json" | python3 -c "import sys,json; print(json.load(sys.stdin)['token'])")

# 用访客 token 调用写接口，预期返回 403
curl -X PUT http://localhost:3002/api/records/tableware/test-id \
  -H "Authorization: Bearer $GUEST_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"testDate":"2026-06-24"}'
# 预期响应: { "error": "访客无写操作权限", "code": "GUEST_WRITE_FORBIDDEN" }
```

**步骤 5 — 提交**
```bash
git add backend/server.js
git commit -m "fix(P0-09): PUT/DELETE写操作接口增加角色校验，拒绝访客写入"
git push origin ZhuHaiYiZhong
```

---

## P1 重要问题（26 项）

| ID | 问题描述 | 预估工时 | 状态 | 完成日期 |
|----|---------|---------|------|---------|
| `P1-01` | auditRoutes.js 路由注册顺序冲突 | 0.5h | ⬜ 待处理 | - |
| `P1-02` | 幂等性中间件使用内存存储，PM2重启后全部失效 | 2h | ✅ 已完成（短期节流方案） | 2026-06-29 |
| `P1-03` | UserManager 注册时自动生成虚假 email | 0.5h | ✅ 已完成 | 2026-06-29 |
| `P1-04` | 密码强度校验过弱（仅要求 length >= 6） | 1h | ✅ 已完成 | 2026-06-29 |
| `P1-05` | AuthService.refreshToken() 调用后端不存在的接口 | 2h | ✅ 已完成 | 2026-06-29 |
| `P1-06` | 前端权限控制完全依赖 CSS hidden，可被 DevTools 绕过 | 3h | ⬜ 待处理 | - |
| `P1-07` | Router.js 将自身暴露到 window.router 全局作用域 | 0.5h | ⬜ 待处理 | - |
| `P1-08` | TestRecord 的 onDelete:Cascade 可能导致数据意外丢失 | 1h | ⬜ 待处理 | - |
| `P1-09` | 两套并行审计日志机制并存，职责边界混乱 | 2h | ⬜ 待处理 | - |
| `P1-10` | PermissionService 权限缓存永不失效 | 1h | ⬜ 待处理 | - |
| `P1-11` | SessionManager 会话全存内存且 IP 硬编码 | 2h | ⬜ 待处理 | - |
| `P1-12` | telemetry.js 使用 CommonJS 且未集成到主进程 | 1h | ⬜ 待处理 | - |
| `P1-13` | CORS_ORIGIN 配置在代码与环境变量间不一致 | 0.5h | ⬜ 待处理 | - |
| `P1-14` | Storage.getAll() 优先返回本地缓存，数据一致性无保障 | 2h | ⬜ 待处理 | - |
| `P1-15` | 生产环境重复数据根因未根治 | 1h | ⬜ 待处理 | - |
| `P1-16` | BackupRestore.js 备份恢复依赖无效的 syncRoutes | 2h | ⬜ 待处理 | - |
| `P1-17` | UserManagement 删除操作无二次确认且无后端权限校验 | 1h | ⬜ 待处理 | - |
| `P1-18` | 访客可访问病原体检测模块，与权限矩阵矛盾 | 0.5h | ⬜ 待处理 | - |
| `P1-19` | AdaptiveUploadQueue 指纹缓存淘汰策略为 FIFO，高频场景下可能重复上传 | 1h | ✅ 已完成（TTL 清理方案） | 2026-06-29 |
| `P1-20` | Dashboard.js 全局函数挂载 + 5个StorageService实例 | 2h | ⬜ 待处理 | - |
| `P1-21` | Auth.js 与 AuthService.js 类名完全相同导致混淆 | 1h | ⬜ 待处理 | - |
| `P1-22` | SampleDataGenerator 示例数据 ID 格式与 StorageService 不兼容 | 1h | ⬜ 待处理 | - |
| `P1-23` | 前端 FormValidator 校验规则与后端 validationMiddleware 不同步 | 2h | ⬜ 待处理 | - |
| `P1-24` | AdaptiveUploadQueue._doRequest() URL 硬编码，绕过 StorageService 的 apiBaseUrl 配置 | 1h | ⬜ 待处理 | - |
| `P1-25` | 两套 package.json 依赖版本不同步，开发与生产环境行为存在差异 | 1h | ⬜ 待处理 | - |
| `P1-26` | 生产数据库路径在 docs/ 文档与 REVIEW_GUIDE 记录不一致，存在 Prisma 无法找到数据库的风险 | 0.5h | ⬜ 待处理 | - |

---

## P2 优化建议（22 项）

| ID | 问题描述 | 预估工时 | 状态 | 完成日期 |
|----|---------|---------|------|---------|
| `P2-01` | 登录接口无专项限流，默认限流阈值过高 | 0.5h | ⬜ 待处理 | - |
| `P2-02` | 检测记录 CRUD 操作未在后端层自动写入审计日志 | 2h | ⬜ 待处理 | - |
| `P2-03` | 失败登录日志未确认写入数据库 | 0.5h | ⬜ 待处理 | - |
| `P2-04` | AuthService.getUser() JSON.parse 无容错处理 | 0.5h | ⬜ 待处理 | - |
| `P2-05` | Router.init() 每次调用都实例化新的 GuestAuthService | 0.5h | ⬜ 待处理 | - |
| `P2-06` | /api/health 与 /health 重复定义 | 0.5h | ⬜ 待处理 | - |
| `P2-07` | buildRecordWriteData() 字段提取无 Schema 验证 | 2h | ⬜ 待处理 | - |
| `P2-08` | Backup 模型缺少关联用户外键约束 | 1h | ⬜ 待处理 | - |
| `P2-09` | NetworkHelper 硬编码 Google URL，内网环境不可达 | 0.5h | ⬜ 待处理 | - |
| `P2-10` | main.js 和 Dashboard.js 大量函数通过 window.* 全局暴露 | 2h | ⬜ 待处理 | - |
| `P2-11` | GuestAuthService.getCurrentGuest() JSON.parse 无容错 | 0.5h | ⬜ 待处理 | - |
| `P2-12` | seed.js 测试账号在生产环境应禁用 | 0.5h | ⬜ 待处理 | - |
| `P2-13` | tempId 使用 Date.now()+Math.random()，多标签页可能碰撞 | 1h | ⬜ 待处理 | - |
| `P2-14` | ExportService 导出数据完全来自本地缓存，可能过期 | 1h | ⬜ 待处理 | - |
| `P2-15` | AuditLogService.getStats() 路由路径与 P1-01 冲突（P1-01 修复后自动解决） | 0h | ⬜ 待处理 | - |
| `P2-16` | Pathogen.js 动态加载 Mammoth.js 无 SRI 完整性校验 | 0.5h | ⬜ 待处理 | - |
| `P2-17` | 各检测模块未继承 GenericTest，存在大量重复代码 | 4h | ⬜ 待处理 | - |
| `P2-18` | UINotification.show() 使用 innerHTML 存在 XSS 风险 | 0.5h | ⬜ 待处理 | - |
| `P2-19` | login.html 访客按钮描述与实际权限范围不符 | 0.5h | ⬜ 待处理 | - |
| `P2-20` | FormValidator 缺少 XSS 和 SQL 注入防护规则 | 1h | ⬜ 待处理 | - |
| `P2-21` | Jest 测试框架与 ES Module 后端代码兼容性未验证 | 1h | ⬜ 待处理 | - |
| `P2-22` | Cypress E2E 测试脚本在 Windows Server 生产环境无法运行 | 0.5h | ⬜ 待处理 | - |

---

## 文档修复（4 项）

| ID | 问题描述 | 预估工时 | 状态 | 完成日期 |
|----|---------|---------|------|---------|
| `DOCS-01` | backend/README.md 仍引用 Supabase，与当前架构完全不符 | 1h | ⬜ 待处理 | - |
| `DOCS-02` | API_REFERENCE.md 端口记录错误（3001/8081 vs 实际 3002/8082） | 2h | ⬜ 待处理 | - |
| `DOCS-03` | DATABASE_SCHEMA.md 数据库路径与生产配置不一致（关联 P1-26） | 1h | ⬜ 待处理 | - |
| `DOCS-04` | FRONTEND_GUIDE.md 和 DEPLOYMENT_GUIDE.md 在仓库中缺失 | 8h | ⬜ 待处理 | - |

---

## 工时汇总

| 类别 | 数量 | 预估工时 |
|------|------|---------|
| P0 高危 | **10 项** | ~21h |
| P1 重要 | **26 项** | ~34.5h |
| P2 优化 | **22 项** | ~21h |
| 文档修复 | **4 项** | ~12h |
| **合计** | **61 项** | **~88.5h** |