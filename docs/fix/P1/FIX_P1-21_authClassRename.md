# FIX-P1-21：Auth.js 与 AuthService.js 类名完全相同导致混淆

| 字段 | 内容 |
|------|------|
| **问题 ID** | `P1-21` |
| **优先级** | 🟠 P1 重要（建议 1 周内处理） |
| **影响文件** | `js/core/Auth.js`、`js/modules/Pathogen.js`、`js/modules/GenericTest.js`、`js/modules/Tableware.js` |
| **预估工时** | 1h |
| **关联问题** | P0-09 |
| **状态** | ✅ 已完成 |
| **完成日期** | 2026-07-01（文档闭环；代码修复由先前提交 `956e015` 完成） |

---

## 1. 问题

**FIX_PLAN 原始描述**：
> `P1-21` | Auth.js 与 AuthService.js 类名完全相同导致混淆

**RG_03b 审阅细化**：
> #### P1-21：`js/core/Auth.js` 与 `js/services/AuthService.js` 类名冲突，极易引发维护错误
> - **修复建议**：将 `js/core/Auth.js` 中的类重命名为 `OperationGuard`，导出单例改名为 `operationGuard`

**问题现象**：
- `js/core/Auth.js` 原导出类名 `Auth`、单例 `auth`
- `js/services/AuthService.js` 导出类名 `AuthService`、单例 `authService`
- 两者类名首 token 均为 `Auth`，单例首 token 均为 `auth`，在 import 语句、IDE 自动补全、全局搜索、code review 中极易混淆
- 但两者职责完全不同：
  - `js/core/Auth.js`：**操作守卫**——仅负责删除操作的二次确认 + 获取当前用户显示名（`verify(actionName, onSuccess)` / `getCurrentUser()`）
  - `js/services/AuthService.js`：**身份认证**——登录/登出/注册/Token 管理/密码修改/用户列表/删除/更新（完整后端 API 调用）
- 类名冲突在维护时会导致：误改文件、误用单例（如将 `auth.verify` 误用为 `authService.verify`，但 AuthService 无 verify 方法 → 运行时崩溃）

## 2. 根因

**实际根因**：
- `js/core/Auth.js` 命名时未充分考虑与 `js/services/AuthService.js` 的命名空间冲突
- `Auth` 类名过于宽泛，无法体现其"操作守卫（删除二次确认）"的实际职责
- 文件名 `Auth.js` 与 `AuthService.js` 在同目录树（`js/core/` vs `js/services/`）下高度相似，进一步加剧混淆

**定位**：
- `js/core/Auth.js` L5（原 `export class Auth {`）、L37（原 `export const auth = new Auth();`）
- 消费方：`js/modules/Pathogen.js` L2/L68/L76、`js/modules/GenericTest.js` L2/L57/L65、`js/modules/Tableware.js` L2/L66/L73

## 3. 修复

**对应 RG_03b 建议**：将 `js/core/Auth.js` 中的类重命名为 `OperationGuard`，导出单例改名为 `operationGuard`。

**实际执行内容**（由先前提交 `956e015` 完成）：

1. `js/core/Auth.js`：
   - L5：`export class Auth {` → `export class OperationGuard {`
   - L37：`export const auth = new Auth();` → `export const operationGuard = new OperationGuard();`
   - 文件头注释保留（"身份认证服务模块"语义略宽，但类名已准确反映职责，未额外改动注释以保持最小 diff）

2. `js/modules/Pathogen.js`：
   - L2：`import { auth } from '../core/Auth.js';` → `import { operationGuard } from '../core/Auth.js';`
   - L68：`auth.verify('删除病原体检测记录', ...)` → `operationGuard.verify('删除病原体检测记录', ...)`
   - L76：`auth.verify('编辑病原体检测记录', ...)` → `operationGuard.verify('编辑病原体检测记录', ...)`

3. `js/modules/GenericTest.js`：
   - L2：`import { auth } from '../core/Auth.js';` → `import { operationGuard } from '../core/Auth.js';`
   - L57：`auth.verify('删除检测记录', ...)` → `operationGuard.verify('删除检测记录', ...)`
   - L65：`auth.verify('编辑/整改记录', ...)` → `operationGuard.verify('编辑/整改记录', ...)`

4. `js/modules/Tableware.js`：
   - L2：`import { auth } from '../core/Auth.js';` → `import { operationGuard } from '../core/Auth.js';`
   - L66：`auth.verify('删除检测记录', ...)` → `operationGuard.verify('删除检测记录', ...)`
   - L73：`auth.verify('编辑/整改记录', ...)` → `operationGuard.verify('编辑/整改记录', ...)`

**消费方引用搜索结果**（grep 全项目）：
- `grep "core/Auth"`：3 命中（Pathogen/GenericTest/Tableware），均使用新名称 `operationGuard`
- `grep "operationGuard\|OperationGuard"`：12 命中（Auth.js 定义 2 + 3 消费方 import 3 + 6 处方法调用）
- `grep "auth\.verify\|auth\.getCurrentUser"`：0 命中（无残留旧调用）
- `grep "import.*\bAuth\b"`：仅匹配 `AuthService`/`UserAuth`（无关文件）

## 4. 功能影响

**修复后行为变化**：
- 类名 `OperationGuard` 准确反映"操作守卫"职责（删除二次确认 + 当前用户显示名获取），与 `AuthService`（身份认证）职责命名清晰分离
- 单例 `operationGuard` 与 `authService` 命名差异显著，IDE 自动补全、code review、全局搜索不再混淆
- 运行时行为零变化：`OperationGuard.verify()` / `OperationGuard.getCurrentUser()` 方法签名与实现完全未变，仅类名/单例名变更
- 所有消费方（Pathogen/GenericTest/Tableware）的删除二次确认、编辑操作守卫行为与修复前完全一致

**对 P0-09 关联的影响**：
- P0-09（`auth.verify()` 对编辑操作完全不做权限校验）的修复在 `backend/server.js` 层（`requireEditorOrAbove` 中间件），与前端 `js/core/Auth.js` 的 `verify()` 是不同层
- 前端 `operationGuard.verify()` 仅做 UX 层二次确认，后端 `requireEditorOrAbove` 是真正的安全边界
- P1-21 重命名不影响 P0-09 的安全边界，仅消除命名混淆

## 5. 验收标准

- [x] `js/core/Auth.js` 类名改为 `OperationGuard`
- [x] `js/core/Auth.js` 单例改为 `operationGuard`
- [x] 所有消费方（Pathogen/GenericTest/Tableware）import 与方法调用同步更新
- [x] 全项目无残留 `auth.verify` / `auth.getCurrentUser` 旧调用
- [x] 全项目无残留 `import { auth }` / `import { Auth }` 旧引用（排除 AuthService/UserAuth 无关文件）
- [x] `js/services/AuthService.js` 类名 `AuthService` 保持不变（真正身份认证服务，命名正确）

## 6. 回归测试要点

- [ ] Pathogen 模块：删除病原体检测记录时弹出二次确认对话框，确认后执行
- [ ] Pathogen 模块：编辑病原体检测记录时直接执行（无确认对话框）
- [ ] GenericTest 模块：删除检测记录时弹出二次确认对话框
- [ ] GenericTest 模块：编辑/整改记录时直接执行
- [ ] Tableware 模块：删除检测记录时弹出二次确认对话框
- [ ] Tableware 模块：编辑/整改记录时直接执行
- [ ] 控制台无 `operationGuard is not defined` / `operationGuard.verify is not a function` 错误
- [ ] 控制台无 `auth is not defined` 残留错误

## 7. 技术债

**TD-P2-25**：`js/core/Auth.js` 文件名未跟随类名更新为 `OperationGuard.js`。
- 现状：类名已改为 `OperationGuard`，但文件名仍为 `Auth.js`，与 `js/services/AuthService.js` 在文件名层面仍有相似性
- 风险：低。类名/单例名已区分，IDE 标签页显示类名而非文件名时无混淆；但文件树浏览时仍可能误选
- 建议：后续与 P2 系列优化合并，将 `js/core/Auth.js` 重命名为 `js/core/OperationGuard.js`，同步更新 3 个消费方的 import 路径
- 优先级：P2（低）

## 8. 备注

- 代码修复由先前提交 `956e015`（`fix(P1-21): rename Auth.js class to OperationGuard, update all call sites`）完成
- 本次为文档闭环任务，代码无变更
- 修复符合 RG_03b 审阅建议（类名 `OperationGuard` + 单例 `operationGuard`），无额外重构
