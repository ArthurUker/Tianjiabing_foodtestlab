# FIX_P1-17 — 用户删除操作防护加固

**文档路径**：`docs/fix/P1/FIX_P1-17_userDeleteGuard.md`
**关联问题**：P1-17（FIX_PLAN.md → P1 节）
**修复日期**：2026-07-01
**代码提交**：`3bd9689`
**文档版本**：v0.27

---

## 问题

**FIX_PLAN 原始描述**：
> `P1-17` | UserManagement 删除操作无二次确认且无后端权限校验 | 1h | ⬜ 待处理

**实际核验发现**：
- "无二次确认"：经核验 `js/modules/UserManagement.js:374` 已存在原生 `confirm()` 单步弹窗，原描述措辞偏弱。
- "无后端权限校验"：经核验 `backend/routes/userRoutes.js:252` 已挂载 `authenticateUser + authorizeRoles('admin','manager')` 双重中间件（P0-02 统一中间件产物），原描述与代码不符。

**审阅方确认扩展语义**（方案 B 验收口径）：在现有单步确认 + 角色鉴权基础上，补齐三项纵深防护：
1. 后端防止管理员删除自身账号；
2. 后端防止删除最后一个 admin 导致系统锁死；
3. 前端单步 `confirm()` 升级为两步确认并显示用户名，降低误删风险。

---

## 根因

- **后端**：删除路由虽有角色鉴权（admin/manager 可调用），但缺少业务层防护——管理员可删除自身账号导致当前会话立即失效，且可删除最后一个 admin 使系统再无管理员可管理。
- **前端**：原生单步 `confirm()` 仅显示通用文案"确定要删除这个用户吗？"，未展示被删用户名，误删风险较高。

---

## 修复

### C1 — 后端两项前置校验（`backend/routes/userRoutes.js`）

在 `router.delete('/:userId', ...)` 处理函数内、`userManager.deleteUser()` 调用前插入：

```javascript
// P1-17: 防止管理员删除自身账号
if (req.user && req.user.userId === req.params.userId) {
    return res.status(400).json({ error: '❌ 不能删除自己的账号' })
}

// P1-17: 防止删除最后一个 admin 导致系统锁死
const targetUser = await userManager.prisma.user.findUnique({ where: { id: req.params.userId } })
if (targetUser && targetUser.role === 'admin') {
    const adminCount = await userManager.prisma.user.count({ where: { role: 'admin', status: 'active' } })
    if (adminCount <= 1) {
        return res.status(400).json({ error: '❌ 无法删除最后一个管理员账号，系统将无法管理' })
    }
}
```

**字段一致性说明**：
- `req.user.userId` 与 `authMiddleware.js:35`（`req.user = verification.user`）+ JWT payload `userId`（`UserManager.js:27`）一致。
- `role` / `status` 字段名及 `'admin'` / `'active'` 值与 `schema.prisma:22-23` 一致。
- `userManager.prisma` 经 `UserManager.js:11`（`this.prisma = prismaClient`）注入可用。

### C2 — 前端两步确认（`js/modules/UserManagement.js`）

将 `deleteUser()` 原单步 `confirm()` 替换为两步确认：

```javascript
// P1-17: 升级为两步确认，显示用户名，防止误删
const user = this.users?.find(u => String(u.id) === String(userId)) || {}
const displayName = user.username || user.name || userId
const firstConfirm = confirm(`⚠️ 即将删除用户「${displayName}」\n\n此操作不可撤销，确定要继续吗？`)
if (!firstConfirm) return
const secondConfirm = confirm(`请再次确认：\n\n确定要永久删除用户「${displayName}」吗？`)
if (!secondConfirm) return
```

**字段一致性说明**：`user.username` 与 `AuthService.js:389` 返回结构一致；`String(u.id) === String(userId)` 比较对齐现有 `renderUserTable` 行 257 模式。

---

## 功能影响

- 管理员（admin）或主管（manager）调用 `DELETE /api/user/:userId` 删除自身账号时，后端返回 400「不能删除自己的账号」。
- 删除最后一个状态为 `active` 的 admin 账号时，后端返回 400「无法删除最后一个管理员账号，系统将无法管理」，避免系统锁死。
- 前端点击"删除"按钮后，连续两次 `confirm()` 弹窗均需确认才执行删除；弹窗显示被删用户名，降低误删风险。
- 既有 `authenticateUser + authorizeRoles('admin','manager')` 角色鉴权与 `UserManager.deleteUser()` 内的 TestRecord 关联检查（P1-08）保持不变。

---

## 技术债

- **TD-P2-21**：评估将 `UserManagement` 删除操作升级为模态对话框（Modal）替代原生 `confirm()`，与系统其他模态框（创建/编辑用户模态框）风格统一，提升 UX 一致性。原生 `confirm()` 存在浏览器样式不可定制、无法嵌入自定义按钮（如"取消并导出该用户数据"）等限制。

---

## 验证步骤

**后端（curl）**：
```bash
# 1. 以 admin 身份登录获取 token
TOKEN=$(curl -s -X POST http://localhost:3002/api/user/login \
  -H "Content-Type: application/json" \
  -d '{"username":"admin","password":"<密码>"}' | python3 -c "import sys,json;print(json.load(sys.stdin)['token'])")

# 2. 获取自身 userId
USER_ID=$(curl -s http://localhost:3002/api/user/me \
  -H "Authorization: Bearer $TOKEN" | python3 -c "import sys,json;print(json.load(sys.stdin)['data']['id'])")

# 3. 尝试删除自身，预期 400「不能删除自己的账号」
curl -X DELETE http://localhost:3002/api/user/$USER_ID \
  -H "Authorization: Bearer $TOKEN"
```

**前端（Console）**：
1. 以 admin 登录，进入用户管理页面。
2. 点击任一用户行的"删除"按钮。
3. 验证：第一次弹窗显示「⚠️ 即将删除用户「<用户名>」」；取消则不删除。
4. 确认第一次后出现第二次弹窗「请再次确认」；取消则不删除。
5. 两次均确认后，用户被删除，列表刷新。
