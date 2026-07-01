# FIX_P1-18 — 病原体检测模块访客访问守卫收紧

**文档路径**：`docs/fix/P1/FIX_P1-18_pathogenGuestAccess.md`
**关联问题**：P1-18（FIX_PLAN.md → P1 节）
**修复日期**：2026-07-01
**代码提交**：`a4aa276`
**文档版本**：v0.28

---

## 问题

**FIX_PLAN 原始描述**：
> `P1-18` | 访客可访问病原体检测模块，与权限矩阵矛盾 | 0.5h | ⬜ 待处理

**RG_03b_ISSUES_P1.md 细化描述**：
> `Pathogen.js` 快速访问模式下访客可访问病原体检测模块，与权限矩阵矛盾
> 修复建议：将权限检查改为 `if (isGuest || isQuickAccess) { return; }`

**实际核验发现**：
- `js/services/PermissionService.js:57-63` 权限矩阵中 `guest` 角色权限列表为 `['records:read', 'module:tableware', 'module:pesticide', 'module:oil', 'module:leanMeat']`，**故意未包含 `module:pathogen`**（L62 注释明确声明）。权限矩阵本身正确。
- `js/modules/Pathogen.js:24`（修复前）`initPathogen()` 守卫为 `if (isGuest && !isQuickAccess)`：仅拦截普通访客，**放行快速访问访客**。快速访问访客通过该守卫后，模块继续执行 `loadMammothJS()` / `setupPaginationListeners()` / `renderTable()` / `storage.on('sync', ...)` 等初始化逻辑，加载并渲染病原体检测数据，与权限矩阵「guest 无 `module:pathogen`」直接矛盾。
- `js/core/Router.js:207-225` `updateNavigationByPermission()` 对访客通过 CSS `hidden` 类隐藏病原体导航按钮与内容区域，但属 CSS 视觉层隐藏（P1-06 范畴），不构成数据层访问阻断。

---

## 根因

`initPathogen()` 的访客守卫使用 `isGuest && !isQuickAccess` 条件，原意是「普通访客拦截、快速访问访客放行（仅显示只读数据）」。但权限矩阵明确将 `module:pathogen` 排除出 `guest` 角色，即**所有访客（含快速访问）均不应访问病原体检测模块**。守卫条件 `&& !isQuickAccess` 与权限矩阵语义冲突，导致快速访问访客仍能初始化模块并加载病原体数据，形成「矩阵说不允许、代码却放行」的矛盾。

---

## 修复

### C1 — `initPathogen()` 守卫条件收紧（`js/modules/Pathogen.js`）

将访客守卫由「普通访客拦截」改为「所有访客（含快速访问）拦截」：

```javascript
// P1-18: 基于权限矩阵，访客（含快速访问模式）无 module:pathogen 权限，禁止初始化病原体模块
// 原守卫 if (isGuest && !isQuickAccess) 放行快速访问访客，与权限矩阵矛盾
if (isGuest || isQuickAccess) {
    console.warn('⛔ 访客无权访问病原体检测模块');
    UINotification.warning('您无权访问病原体检测模块');
    return; // 访客无权访问，直接返回
}
```

**改动说明**：
- 条件 `isGuest && !isQuickAccess` → `isGuest || isQuickAccess`，即由「是访客且非快速访问」改为「是访客或快速访问」，覆盖全部访客类型。
- `isGuest`（`guestAuthService.isLoggedIn()`）与 `isQuickAccess`（`guestAuthService.isQuickAccessMode()`）声明保留不变——`isQuickAccess` 在 L35 `if (isQuickAccess)` 仍用于隐藏导入操作行逻辑（虽守卫已 return，但保留声明避免影响后续可能的重构并维持变量完整）。
- 守卫命中后直接 `return`，跳过 `loadMammothJS()` / `renderTable()` / `storage.on('sync', ...)` 等数据加载与事件绑定，从数据层阻断访客访问。
- 对 admin / manager / operator / viewer 角色：`isGuest` 与 `isQuickAccess` 均为 `false`，守卫不触发，行为不变。

---

## 功能影响

- **快速访问访客**：进入主页后 `initPathogen()` 直接返回，不再加载 Mammoth.js、不再渲染病原体记录表格、不再绑定 `storage.on('sync')` 事件。病原体检测模块对该类访客完全不可用（数据层阻断）。
- **普通注册访客（viewer / export_applicant）**：行为不变（修复前即被 `isGuest && !isQuickAccess` 拦截）。
- **管理员 / 主管 / 操作人员 / 查看者**：行为不变，守卫不触发，模块正常初始化。
- 病原体检测导航按钮与内容区域对访客的 CSS 隐藏（`Router.js:209-225`）保持不变，与数据层守卫形成双重阻断。

---

## 技术债

- **TD-P2-22**：`js/main.js` `handleNavigation()`（L71-121）与 `js/utils/UIHelper.js` `setupNavigation()`（L17-52）导航点击层均未对 `module:pathogen` 等模块权限做校验。访客理论上可通过 DevTools 取消病原体按钮的 `hidden` 类后点击，或在浏览器控制台执行 `window.handleNavigation('pathogen-test')` 显示空白的病原体内容区域（因 `initPathogen()` 已 return，无数据加载与事件绑定，不构成实际数据泄露，但区域可见）。该问题与 P1-06（前端权限依赖 CSS hidden 可被 DevTools 绕过）同源，建议在导航层集中化 `module:xxx` 权限拦截，与 P1-06 一并根治。

---

## 验证步骤

**前端（Console）**：
1. 以管理员账号登录系统，确认病原体检测模块正常初始化、数据表格正常渲染。
2. 登出，点击登录页「快速访问」按钮进入快速访问模式。
3. 打开浏览器控制台，观察日志：应出现 `⛔ 访客无权访问病原体检测模块` 警告。
4. 确认病原体检测导航按钮不可见（CSS 隐藏），数据看板/餐具洁净度等其他模块正常。
5. 在控制台执行 `window.handleNavigation('pathogen-test')`：内容区域切换后病原体表格为空（`initPathogen` 未初始化），无数据加载——确认数据层访问已阻断。
6. （可选）以普通注册访客（viewer）登录，重复步骤 3-5，行为一致。
