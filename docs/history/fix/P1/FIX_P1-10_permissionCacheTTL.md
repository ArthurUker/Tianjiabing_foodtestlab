# FIX P1-10：PermissionService 权限缓存永不失效

## 问题描述
`js/services/PermissionService.js` 的 `permissionCache`（`Map`）在 `getCurrentUserPermissions()` 首次计算后写入用户权限，读取时直接命中返回，**无任何 TTL / 过期时间**。同时存在 `clearCache()` 方法（L192-193）并由 `js/core/Router.js:449-450` 的 `permissionChanged` 事件监听触发，但经全仓核验**该事件 0 处派发**（所有 `dispatchEvent` 均为 `dataChanged`），`clearCache()` 实为死代码。用户角色变更（`UserManagement.handleFormSubmit` / `UserManager.changeUserRole` / `adminUpdateUser`）与用户删除（`UserManagement.deleteUser` / `UserManager.deleteUser`）均未触发任何缓存清除。

结论：缓存实质"永不失效"，权限变更后整个会话期内返回旧权限。

## 根因
1. 缓存写入（L107/L112）仅存权限数组，无时间戳，无 TTL 字段。
2. 读取（L97-98）无条件命中返回，无过期判断。
3. `clearCache()` 依赖的 `permissionChanged` 事件从未被派发，清除逻辑形同虚设。
4. 权限变更/删除入口未接入缓存失效。

## 修复内容（C1 路径：添加 TTL）

在 `js/services/PermissionService.js` 内为权限缓存增加 5 分钟 TTL：

| 位置 | 修改 |
|------|------|
| 构造函数（L12-13） | 新增 `this.PERMISSION_CACHE_TTL = 5 * 60 * 1000` |
| 缓存读取（L98-105） | 命中后检查 `Date.now() - cached.cachedAt < TTL`，过期则 `delete` 并回源 |
| 缓存写入（L114/L119） | 值结构由权限数组改为 `{ permissions, cachedAt: Date.now() }` |

```diff
  constructor() {
      this.permissionCache = new Map();
      this.rolePermissionMap = this.initRolePermissions();
+     // P1-10: 权限缓存 TTL（5 分钟），防止权限变更后缓存永不失效
+     this.PERMISSION_CACHE_TTL = 5 * 60 * 1000; // 5 minutes
  }
```

```diff
- // 检查缓存
- if (this.permissionCache.has(user.id)) {
-     return this.permissionCache.get(user.id);
- }
+ // 检查缓存（P1-10: 增加 TTL 过期检查，过期则清除并回源）
+ if (this.permissionCache.has(user.id)) {
+     const cached = this.permissionCache.get(user.id);
+     if (cached && (Date.now() - cached.cachedAt) < this.PERMISSION_CACHE_TTL) {
+         return cached.permissions;
+     }
+     this.permissionCache.delete(user.id); // 过期则清除
+ }
```

```diff
- this.permissionCache.set(user.id, combinedPermissions);
+ // P1-10: 缓存写入时记录时间戳
+ this.permissionCache.set(user.id, { permissions: combinedPermissions, cachedAt: Date.now() });
```

### 关于 C2（权限变更后主动清除）未实施说明
C2 要求在角色修改/用户删除入口添加 `permissionCache.delete(userId)`，但：
- 这些入口位于 `js/modules/UserManagement.js`、`backend/modules/UserManager.js`，**不在本次预检（A1-A3）确定的"权限缓存相关文件"范围内**，按约束"代码阶段仅允许修改权限缓存相关文件"不予修改。
- 架构上，管理员在自身会话中变更他人角色，**无法触达被变更用户浏览器的客户端缓存**；TTL 是跨会话权限收敛的唯一有效机制。
- 前端 `clearCache()` 的 `permissionChanged` 事件派发缺失问题登记为技术债，后续可在 `UserManagement` 变更成功后补 `window.dispatchEvent(new Event('permissionChanged'))`（仅能刷新管理员自身视图）。

## 功能影响
- 权限变更后最多 **5 分钟**内自动收敛生效（TTL 过期回源）。
- 缓存值结构变更（数组 → 对象），仅 `PermissionService` 内部读写，无外部消费者，向后兼容。
- `clearCache()`（全量清除）行为不变，仍可用于强制刷新。

## 遗留技术债
- **TD-P2-14**：考虑引入 Redis 或 LRU Cache 替代内存 `Map`，支持多实例部署与服务端统一缓存失效。
- **TD-P1-10a**（登记）：`permissionChanged` 事件派发缺失，`clearCache()` 当前为死代码；建议在 `UserManagement.js` 角色/状态变更成功后补派发事件（受本次文件范围约束未实施）。

## 验收标准
- [x] 缓存写入携带 `cachedAt` 时间戳
- [x] 缓存读取在 TTL 过期后自动清除并回源
- [x] `git diff` 仅涉及 `js/services/PermissionService.js`
- [ ] 人工验证：修改用户角色后，等待 5 分钟，目标用户重新登录/刷新后权限收敛（待人工执行）

## 提交信息
- fix(P1-10): 权限缓存添加TTL(5min)过期机制，解决缓存永不失效（1b60d78）
- docs(P1-10): v0.20 文档闭环
