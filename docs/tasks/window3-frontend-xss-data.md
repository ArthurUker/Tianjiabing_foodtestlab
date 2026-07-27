# 窗口③ 任务：前端 XSS 修复 + 数据完整性（7个bug）

## 环境
- **分支**：`main`（commit `f3b55ae`）
- **只改文件**：`js/main.js`、`js/modules/GenericTest.js`、`js/modules/GuestDashboard.js`、`js/modules/UserManagement.js`、`js/modules/Pathogen.js`、`js/modules/Dashboard.js`、`js/modules/registry.js`
- **切分支**：`git checkout -b fix/window3-frontend-xss`

## 上下文

所有 bug 来自第二轮深度审阅（2026-07-27）。本窗口聚焦前端 XSS（innerHTML 注入）和异常处理缺口。

---

## Bug 列表

### 🔴 NB-03：innerHTML XSS（4 处）

所有 innerHTML 拼接**来自服务端/用户的数据**时，必须使用 `escapeHtml()` 转义。`escapeHtml` 可以从以下位置导入：
```javascript
import { escapeHtml } from '../utils/schoolCustomization/shared.js'
// 或
function escapeHtml(s) {
    if (typeof s !== 'string') return s
    return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;')
}
```

#### ① `js/modules/UserManagement.js` — 用户列表
**位置**：搜索 `row.innerHTML`（约 line 232-249）
**问题**：`${user.username}`、`${user.phone}` 等直接拼入 HTML
**修复**：对 `user.username`、`user.phone`、`user.full_name` 调用 `escapeHtml()` 后再拼入模板

#### ② `js/modules/GuestDashboard.js` — 访客界面
**位置**：搜索 `container.innerHTML`（约 line 132, 391, 411-423）
**问题**：`${guest.full_name || guest.username}`、`${req.request_type}`、`${req.request_reason}`、`${req.approval_comment}` 直接拼入
**修复**：对上述字符串调用 `escapeHtml()`

#### ③ `js/modules/Pathogen.js` — 病原体检测记录表
**位置**：搜索 `tbody.innerHTML = currentRecords.map`（约 line 1310, 1337-1351）
**问题**：`${item.testDate}`、`${item.sampleId}`、`${item.canteen}`、`${item.inspector}` 直接拼入
**修复**：对 item 的字段调用 `escapeHtml()`

#### ④ `js/main.js` — 快速访问模式
**位置**：搜索快速访问后备渲染器 innerHTML 模板（约 line 453-463）
**问题**：`${record.testDate}`、`${record.canteen}`、`${record.inspector}` 等直接拼入
**修复**：对 record 字段调用 `escapeHtml()`

**通用方法**：在 `js/utils/` 下找一个已有 escapeHtml（如 `schoolCustomization/shared.js`），各文件按相对路径 import。若不方便 import（如 main.js 内联代码），可内联 escapeHtml 函数。

---

### 🔴 NB-08：GenericTest.js collectCustomFieldValues 无 try-catch
**文件**：`js/modules/GenericTest.js`，搜索 `handleSubmit` 中的 `collectCustomFieldValues`（约 line 977）
**问题**：若 `getSchoolCustomization()` 抛异常（localStorage 解析失败），整个提交中断。而 `Tableware.js` 的 `handleFormSubmit` 中已有 try-catch 容错。

**修复**：与 Tableware.js 统一：
```javascript
try {
    const customFields = collectCustomFieldValues(e.target, getSchoolCustomization())
    Object.assign(baseInfo, customFields)
} catch (err) {
    console.warn('⚠️ 自定义字段收集失败，继续提交基础字段:', err.message)
}
```

---

### 🟠 NB-15：Pathogen.js JSON.parse(btn.dataset.*) 无 try-catch
**文件**：`js/modules/Pathogen.js`，搜索 `JSON.parse(btn.dataset.recheck)` 和 `JSON.parse(btn.dataset.test)`（约 line 804, 1205）
**问题**：data 属性被篡改会导致未捕获异常中断事件处理

**修复**：
```javascript
let data
try {
    data = JSON.parse(btn.dataset.recheck)
} catch {
    return  // 或 UINotification.warn
}
```

---

### 🟡 NB-19：applySchoolBranding 未 await
**文件**：`js/main.js`，搜索 `applySchoolBranding(schoolCode)`（约 line 243）和 CR-06 同步回调（约 line 261）
**影响**：品牌更新与导航逻辑并行执行，可能视觉闪烁

**修复**：改为 `await applySchoolBranding(schoolCode)`

---

### 🟡 NB-23：Dashboard 无数据时合格率返回 100%
**文件**：`js/modules/Dashboard.js`
**位置**：
1. `getStats` 中 pathogen 分支和通用分支（约 line 1022, 1037）：`passRate: count > 0 ? Math.round(...) : 100`
2. 总合格率（约 line 740）：`totalCount > 0 ? Math.round(...) : 100`

**问题**：无数据时显示 100% 误导用户

**修复**：改为 `totalCount > 0 ? ... : null`，前端渲染时 null 显示 "—" 或 "暂无数据"

---

### 🟡 NB-24：Dashboard 趋势图日期跨时区
**文件**：`js/modules/Dashboard.js`，搜索 `calculateCanteenTrends`（约 line 1580-1584）
**问题**：`new Date(recordDate)` 解析为 UTC 午夜，与 `startOfLocalDay`/`endOfLocalDay`（本地时区）比较时偏移 8 小时

**修复**：使用 `new Date(recordDate + 'T00:00:00')` 或 `isWithinLocalDayRange(recordDate, startDate, endDate)`

---

### 🟢 NB-32：leanMeat label 不一致
**文件**：`js/modules/registry.js`（约 line 38）vs `js/modules/GenericTest.js`（约 line 739）、`js/modules/Dashboard.js`（约 line 458）
**问题**：registry.js 中 label 为 `'瘦肉精检测'`，但 GenericTest 和 Dashboard 中显示为 `'肉蛋农残'`

**修复**：统一为 `'肉蛋农残检测'`（当前业务使用名称），或在 registry 加注释说明两个名称的对应关系

---

## 自检清单
```bash
for f in js/main.js js/modules/GenericTest.js js/modules/GuestDashboard.js \
         js/modules/UserManagement.js js/modules/Pathogen.js \
         js/modules/Dashboard.js js/modules/registry.js; do
    node --input-type=module --check < "$f" && echo "$f OK"
done
```

## 提交
```bash
git add js/main.js js/modules/GenericTest.js js/modules/GuestDashboard.js \
        js/modules/UserManagement.js js/modules/Pathogen.js \
        js/modules/Dashboard.js js/modules/registry.js
git commit -m "fix(window3): XSS修复+异常处理+数据完整性 — 4处innerHTML/GenericTest try-catch/Pathogen JSON.parse/Dashboard合格率/日期/leanMeat"
```
