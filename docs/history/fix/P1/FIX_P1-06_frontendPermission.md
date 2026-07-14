# FIX-P1-06：前端权限控制完全依赖 CSS hidden，可被 DevTools 绕过

| 字段 | 内容 |
|------|------|
| **问题 ID** | `P1-06` |
| **优先级** | 🟠 P1 重要（建议 1 周内处理） |
| **影响文件** | `js/modules/Tableware.js`、`js/modules/Pathogen.js`、`js/modules/GenericTest.js` |
| **预估工时** | 3h |
| **关联问题** | P0-09（后端边界）、P1-10（权限源可信度）、P1-14（本地 Storage 一致性） |
| **状态** | ✅ 已完成（前端体验层防护） |
| **完成日期** | 2026-06-30 |

---

## 1. 问题描述

前端权限控制完全依赖视觉层（CSS `classList.add('hidden')`），删除按钮等敏感操作的点击处理函数无任何权限判断。用户通过 DevTools 移除 `hidden` class 或篡改 `localStorage.current_user.role` 即可绕过前端权限控制。

### 核验发现的 3 个缺口

1. **事件处理层零权限判断**：`handleDeleteRecord`（Tableware/Pathogen/GenericTest 共 3 处）无 `hasPermission`/`hasRole` 调用
2. **误导性文案**：`Pathogen.js`、`Tableware.js` 的确认弹窗文案为"权限认证通过。确定要永久删除此记录吗？"，但代码中**根本没有任何权限认证逻辑**
3. **删除按钮无条件渲染**：不按权限决定是否生成按钮，仅靠外层模块入口隐藏

## 2. 根因分析

- `operationGuard.verify(actionName, onSuccess)`（`js/core/Auth.js`）名为"认证服务"，实为空壳 `confirm()` 弹窗，无角色/权限校验
- `handleDeleteRecord` 函数体直接调用 `storage.delete()`，无前置权限门槛
- 权限控制仅在 `Router.updateNavigationByPermission()` 等 UI 层做视觉隐藏，事件处理层为空白

## 3. 修复策略：双层拦截

### 层 ①：按钮点击层前置拦截

在 `operationGuard.verify` 调用之前插入 `permissionService.hasPermission('records:delete')` 判断。viewer/guest 点击删除按钮时立即拦截并提示，不进入确认弹窗。

### 层 ②：函数体纵深防御

在 `handleDeleteRecord` 函数体入口加二次校验，防止函数被其他路径（如未来新增的批量删除、键盘快捷键等）直接调用绕过按钮层。

### 修改范围（3 个模块 × 4 类改动）

| 文件 | ① import 追加 | ② 按钮点击层拦截 | ③ 函数体纵深防御 | ④ 文案统一 |
|------|:---:|:---:|:---:|:---:|
| `Tableware.js` | 第 8 行 | 第 61–65 行 | 第 608–612 行 | 第 614 行 |
| `Pathogen.js` | 第 9 行 | 第 62–66 行 | 第 414–418 行 | 第 420 行 |
| `GenericTest.js` | 第 7 行 | 第 52–56 行 | 第 257–261 行 | 第 263 行 |

### 统一文案

三模块确认弹窗文案统一为：`'确定要永久删除此记录吗？此操作不可恢复。'`

- 旧文案（Tableware/Pathogen）：`'权限认证通过。确定要永久删除此记录吗？'` → 已清除
- 旧文案（GenericTest）：`'删除该记录吗？此操作不可恢复！'` → 已统一

## 4. 验收标准

- [x] 3 个文件新增 `import { permissionService }` 
- [x] 按钮点击层 3 处 `hasPermission('records:delete')` 前置拦截
- [x] 函数体 3 处 `hasPermission('records:delete')` 纵深防御
- [x] `grep "权限认证通过"` 返回 0 匹配
- [x] `grep "P1-06"` 返回 6 处（每文件 2 处注释）
- [x] `grep "records:delete"` 返回 6 处
- [x] `grep "permissionService"` 返回 9 处（每文件 1 import + 2 调用）

## 5. 未修复项（技术债登记）

| 技术债 ID | 描述 | 处理方式 |
|-----------|------|---------|
| **TD-06** | 本地 `Storage.js` 的 `storage.delete()` 路径无权限判断，离线模式下前端删除仍可执行 | 与 P1-14（Storage.getAll 本地缓存优先）合并处理 |
| **P2（待登记）** | 删除按钮应按权限条件渲染，而非无条件生成后靠事件层拦截 | P2 优化阶段处理 |
| **P1-10** | `PermissionService` 权限源为前端硬编码 + localStorage，可被篡改 | 独立 P1 项处理 |

## 6. 防御纵深说明

| 层级 | 状态 | 说明 |
|------|:--:|------|
| 视觉层（CSS hidden） | ✅ 原有 | Router + main.js 控制 |
| **事件处理层（JS 判断）** | ✅ **本次新增** | 双层 `hasPermission` 拦截 |
| 后端层（中间件） | ✅ 已加固 | P0-09/P0-09b 覆盖 7 条写路由 |

**重要边界声明**：前端权限判断为**体验层防护**，防止普通用户误操作和减少无效请求；**非安全边界**。真正的安全边界是后端 `requireEditorOrAbove` 中间件（P0-09/P0-09b）。即使前端被完全绕过，后端仍会返回 403。

## 7. 回归测试要点

- [x] viewer/guest 角色点击删除按钮 → 立即提示"权限不足"，不进入确认弹窗
- [x] admin/editor 角色点击删除按钮 → 正常进入确认弹窗，文案为统一新文案
- [ ] DevTools 移除 hidden 后点击删除 → 前端拦截（后端兜底 403）

## 8. 备注

- `operationGuard.verify` 保留原位未动（其 `confirm` 弹窗作为第三层用户确认仍有价值）
- `permissionService` 为项目内已有模块（`js/services/PermissionService.js` 第 252 行具名导出），本次新增 import 非外部依赖
