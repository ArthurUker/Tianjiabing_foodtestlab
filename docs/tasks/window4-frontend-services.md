# 窗口④ 任务：前端服务层 + 备份恢复修复（8个bug）

## 环境
- **分支**：`main`（commit `f3b55ae`）
- **只改文件**：`js/services/AuthService.js`、`js/services/ExportService.js`、`js/services/SessionManager.js`、`js/modules/BackupRestore.js`
- **切分支**：`git checkout -b fix/window4-services`

## 上下文

所有 bug 来自第二轮深度审阅（2026-07-27）。本窗口文件与窗口③（前端页面）**零重叠**。

---

## Bug 列表

### 🔴 NB-05：AuthService.clearAuth 不清理 PermissionService 缓存
**文件**：`js/services/AuthService.js`，`clearAuth()` 方法（约 line 392-417）
**影响**：登出后权限缓存残留，快速切换身份可能命中旧权限

**修复**：在 `clearAuth()` 的末尾增加：
```javascript
try {
    // 清除权限缓存（防止登出后切换身份时命中旧权限）
    if (permissionService && typeof permissionService.clearCache === 'function') {
        permissionService.clearCache()
    }
} catch (e) {
    // 静默降级
}
```
`permissionService` 已在 AuthService.js 顶部导入。注意权限缓存的 clearCache 方法可能需在 `PermissionService.js` 中确认存在。

---

### 🟡 NB-20：BackupRestore 恢复无事务性
**文件**：`js/modules/BackupRestore.js`，`processRestoreData` 函数（约 line 658-824）
**问题**：逐表写入 localStorage（`processTable` 循环），中途失败无法回滚

**修复**（最小改动方案）：
1. 恢复前备份各表的旧数据到 `_backup_old_*` localStorage 键
2. `location.reload()` 前或失败时提供"回滚"能力
或更简单：在恢复前弹 confirm "此操作将覆盖现有数据且不可撤销，是否继续？"

---

### 🟡 NB-21：BackupRestore 业务表恢复无学校代码校验
**文件**：`js/modules/BackupRestore.js`，`processRestoreData` 入口（约 line 563-579）
**问题**：仅对 `customization` 做了 backupCode 校验（line 768-775），但 5 个业务表的恢复完全不校验——跨校数据可被恢复

**修复**：在 `processRestoreData` 开头增加：
```javascript
const currentCode = extractSchoolCode()
const backupCode = backupData.schoolCode
if (currentCode && backupCode && backupCode !== currentCode) {
    const proceed = confirm(`警告：备份数据属于学校 [${backupCode}]，与当前学校 [${currentCode}] 不一致。继续恢复可能造成数据混淆。是否继续？`)
    if (!proceed) return
}
```

---

### 🟡 NB-22：ExportService 大数据量导出内存风险
**文件**：`js/services/ExportService.js`，`collectData` 和 `generateReportHTML`（约 line 374-443）

**问题**：一次性将所有类型所有记录加载到内存，HTML 渲染和 PDF 导出可能 OOM

**修复**（最小改动方案）：
1. 在 `collectData` 中为每个类型加最大行数限制：`const MAX_ROWS_PER_TYPE = 2000`
2. 超限时在报表底部标注"注：记录数超过 2000 条，仅显示前 2000 条"
3. 在注释中标注未来考虑分批导出

---

### 🟡 NB-26：SessionManager logout().then() 无 catch
**文件**：`js/services/SessionManager.js`，搜索 `authService.logout().then`（约 line 241-243）
**问题**：`logout()` reject 时不跳转到登录页，用户停留在过期会话页面

**修复**：
```javascript
authService.logout()
    .then(() => { window.location.href = './login.html' })
    .catch(() => { window.location.href = './login.html' })  // 无论成功失败都跳转
```

---

### 🟡 NB-27：BackupRestore JSON.parse 在 reduce 中无 try-catch
**文件**：`js/modules/BackupRestore.js`
**位置**：
1. Line 386：`JSON.parse(localStorage.getItem('pending_${table}') || '[]')` 在 `.reduce()` 内
2. Line 417：`JSON.parse(localStorage.getItem('cache_${table}') || '{"data":[]}')`

**问题**：localStorage 中存在脏数据（非空非法的 JSON 字符串）会中断整个 reduce 流程

**修复**：
```javascript
// 对 line 386
let pendingData = []
try { pendingData = JSON.parse(localStorage.getItem(`pending_${table}`) || '[]') } catch { pendingData = [] }

// 对 line 417  
let cacheData = { data: [] }
try { cacheData = JSON.parse(localStorage.getItem(`cache_${table}`) || '{"data":[]}') } catch { cacheData = { data: [] } }
```

---

### 🟡 NB-23·24 已在窗口③处理，此处不重复

---

### 🟢 额外：ExportService showToast innerHTML 未转义
**文件**：`js/services/ExportService.js`，搜索 `toast.innerHTML = message`（约 line 1020）
**问题**：`error.message` 直接拼入 innerHTML

**修复**：改为 `toast.textContent = message`

---

## 自检清单
```bash
for f in js/services/AuthService.js js/services/ExportService.js \
         js/services/SessionManager.js js/modules/BackupRestore.js; do
    node --input-type=module --check < "$f" && echo "$f OK"
done
```

## 提交
```bash
git add js/services/AuthService.js js/services/ExportService.js \
        js/services/SessionManager.js js/modules/BackupRestore.js
git commit -m "fix(window4): 服务层 — AuthService权限缓存/BackupRestore事务+校验/ExportService内存/SessionManager catch"
```
