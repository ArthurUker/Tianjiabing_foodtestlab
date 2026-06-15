# FRONTEND_GUIDE.md

# 食品安全检验管理系统 Pro 前端模块说明

## 版本信息

| 项目 | 内容 |
|---|---|
| 系统名称 | 食品安全检验管理系统 Pro |
| 项目名称 | `tianjiabing-foodtestlab` |
| 文档名称 | `FRONTEND_GUIDE.md` |
| 文档类型 | 前端模块说明 / 前端维护指南 |
| 适用对象 | 前端开发人员、后端联调人员、部署维护人员、项目交接人员 |
| 当前文档版本 | v1.0 |
| 系统版本参考 | package version `3.1.0` / 页面文档 Version 4.0 |
| 更新时间 | 2026-06-15 |

---

## 1. 文档目的

本文档用于说明 **食品安全检验管理系统 Pro** 的前端模块架构、页面职责、路由与权限控制机制、本地缓存规范、快速访问模式、数据同步机制以及示例数据生成逻辑。

本文档重点覆盖以下内容：

1. 前端模块列表与职责；
2. `Router.js` 路由与权限控制机制；
3. 主要业务模块功能说明；
4. `localStorage` 缓存键规范，包括 `cache_*`、`pending_*` 等；
5. `SampleDataGenerator.js` 示例数据生成器说明；
6. 用户认证、访客访问、快速访问模式；
7. 本地缓存、待同步队列与后端 API 同步机制；
8. 前端调试与后续维护建议。

本文档适用于以下场景：

- 新开发人员理解项目结构；
- 前后端联调时确认页面与接口关系；
- 部署维护人员定位登录、缓存、同步、权限问题；
- 项目交接、版本归档和二次开发。

---

## 2. 系统概述

**食品安全检验管理系统 Pro** 是面向校园食堂食品安全检测业务的数字化管理平台，主要用于记录、分析和管理以下类型的检测数据：

- 餐具洁净度检测；
- 果蔬农药残留检测；
- 食用油品质检测；
- 肉蛋类/瘦肉精相关检测；
- 病原体检测；
- 食品安全数据看板；
- 操作审计日志；
- 数据导出；
- 数据备份与恢复；
- 用户与访客权限管理。

系统前端采用 **原生 JavaScript ES Modules 模块化架构**，不是典型的 React/Vue 单页组件架构。各页面模块通过 DOM 容器挂载，由 `main.js` 完成初始化，由 `Router.js` 负责认证检查、权限守卫和页面访问控制。

---

## 3. 前端技术栈

根据当前项目文件，前端主要技术栈如下：

| 类型 | 技术/库 | 用途 |
|---|---|---|
| 前端语言 | JavaScript ES Modules | 模块化前端开发 |
| 页面结构 | HTML + DOM 容器挂载 | 页面与模块容器承载 |
| 样式框架 | Tailwind CSS | 响应式 UI 和快速样式构建 |
| 图标库 | Font Awesome | 页面图标 |
| 图表库 | Chart.js | 数据看板图表展示 |
| PDF/图片导出 | html2canvas / jsPDF | 看板、报告导出 |
| Word 解析 | Mammoth.js | 病原检测 `.docx` 文件解析 |
| 网络请求 | fetch / APIClient / NetworkHelper | 后端 API 通信 |
| 本地存储 | localStorage / sessionStorage | Token、用户、缓存和待同步数据 |
| 权限体系 | AuthService / PermissionService / GuestAuthService | 用户、角色、访客和快速访问控制 |
| 数据存储 | StorageService | 本地缓存 + 后端同步 |
| 缓存管理 | CacheManager | 内存缓存 + localStorage 缓存 + TTL |
| 审计日志 | AuditLogService / AuditLogger | 操作审计追踪 |

---

## 4. 前端目录与关键文件

当前前端主要文件可按职责划分如下。

### 4.1 入口与页面结构

| 文件 | 说明 |
|---|---|
| `index.html` | 系统主页面结构，定义各模块容器、外部库和页面说明 |
| `main.js` | 前端启动入口，负责初始化路由、导航、模块、快速访问模式和示例数据 |

### 4.2 路由与权限

| 文件 | 说明 |
|---|---|
| `Router.js` | 路由管理、登录状态检查、权限守卫、页面切换 |
| `AuthService.js` | 用户登录、登出、Token 管理、用户信息管理 |
| `PermissionService.js` | 角色权限映射、细粒度权限检查、权限缓存 |
| `GuestAuthService.js` | 访客注册、访客登录、快速访问模式 |
| `SessionManager.js` | 会话生命周期、并发会话限制、自动登出 |
| `UserAuth.js` | 通用用户认证封装，偏新架构/通用 API 客户端使用 |

### 4.3 数据、缓存与网络

| 文件 | 说明 |
|---|---|
| `Storage.js` | 核心数据存储服务，管理 `cache_*`、`pending_*`、服务端同步 |
| `CacheManager.js` | 统一缓存管理器，支持内存缓存、localStorage 缓存、TTL 和 LRU |
| `NetworkHelper.js` | 网络请求辅助，支持超时、重试、错误处理 |
| `ApiClient.js` | 通用 REST API 客户端，封装认证和 CRUD 请求 |

### 4.4 业务模块

| 文件 | 说明 |
|---|---|
| `Dashboard.js` | 数据看板模块 |
| `UserManagement.js` | 用户管理模块 |
| `AuditLog.js` | 审计日志模块 |
| `BackupRestore.js` | 数据备份与恢复模块 |
| `GenericTest.js` | 通用检测模块，覆盖农残、油品、肉蛋类检测等 |
| `GuestDashboard.js` | 访客中心模块 |
| `Pathogen.js` | 病原检测模块 |
| `Tableware.js` | 餐具洁净度检测模块 |
| `ExportService.js` | 数据导出报告模块 |

### 4.5 通用基础能力

| 文件 | 说明 |
|---|---|
| `BaseTestModule.js` | 测试类模块基类，提供事件、分页、排序、缓存等通用能力 |
| `FormBuilder.js` | 动态表单生成器 |
| `SampleDataGenerator.js` | 快速访问模式下的示例数据生成器 |

---

## 5. 前端启动与初始化流程

系统前端入口为 `main.js`。

### 5.1 初始化总体流程

`main.js` 在 `DOMContentLoaded` 事件触发后执行系统初始化，核心流程如下：

```text
DOMContentLoaded
        ↓
检查 URL 参数 quickAccess=true
        ↓
检查 GuestAuthService 中的快速访问状态
        ↓
如为快速访问模式且未登录访客，则自动创建临时访客
        ↓
快速访问模式下调用 initializeSampleData()
        ↓
初始化 Router
        ↓
router.setupAll()
        ↓
暴露 window.router
        ↓
初始化 UI 导航
        ↓
根据模式隐藏或禁用管理功能
        ↓
初始化各业务模块
```

### 5.2 快速访问模式的启动入口

快速访问模式可通过 URL 参数启用：

```text
?quickAccess=true
```

`main.js` 中会同时检查：

```javascript
const isQuickAccessParam = urlParams.get('quickAccess') === 'true';
const isQuickAccessStorage = guestAuthService.isQuickAccessMode();
const isQuickAccessMode = isQuickAccessParam || isQuickAccessStorage;
```

如果快速访问模式启用且当前没有访客登录，系统会调用：

```javascript
guestAuthService.quickAccessAsViewer();
```

随后调用：

```javascript
initializeSampleData();
```

用于初始化演示或只读查看所需的示例数据。

---

## 6. Router.js 路由与权限控制机制

`Router.js` 是系统前端的路由与权限守卫管理器，主要负责：

- 页面导航；
- 登录状态检查；
- 用户权限验证；
- 访客权限验证；
- 快速访问模式识别；
- 页面初始化；
- 调试入口暴露。

### 6.1 Router 类核心职责

`Router` 类初始化时会将自身暴露到全局对象：

```javascript
window.router = this;
```

该设计便于：

- 浏览器控制台调试；
- 页面按钮事件调用；
- 登出和跳转逻辑统一处理；
- 部署后快速排查路由问题。

### 6.2 初始化认证检查

`router.init()` 中会同时检查三类身份状态：

```javascript
const isUserAuthenticated = authService.isAuthenticated();
const isGuestAuthenticated = guestAuthService.isLoggedIn();
const isQuickAccess = guestAuthService.isQuickAccessMode();

const isAuthenticated =
    isUserAuthenticated ||
    isGuestAuthenticated ||
    isQuickAccess;
```

因此系统支持三种访问模式：

| 访问模式 | 说明 |
|---|---|
| 正式用户登录 | 通过 `AuthService` 登录，使用 `auth_token` |
| 访客登录 | 通过 `GuestAuthService` 登录，使用 `guest_token` |
| 快速访问模式 | 通过 `quickAccess=true` 或 `is_quick_access` 启用 |

### 6.3 权限守卫机制

路由权限由以下服务共同完成：

| 服务 | 职责 |
|---|---|
| `AuthService` | 判断正式用户是否登录、Token 是否有效 |
| `GuestAuthService` | 判断访客是否登录、是否为快速访问模式 |
| `PermissionService` | 判断当前角色是否具备具体权限 |
| `Router` | 根据认证和权限结果决定页面是否可访问 |

### 6.4 页面访问控制原则

系统应遵循以下访问控制原则：

| 页面/模块 | 建议访问权限 |
|---|---|
| Dashboard | 登录用户、访客、快速访问用户可读 |
| Tableware | 登录用户可增删改查；访客/快速访问模式只读 |
| GenericTest | 登录用户可增删改查；访客/快速访问模式只读或受限 |
| Pathogen | 登录用户可导入、解析、管理；访客/快速访问模式只读 |
| UserManagement | 仅管理员 |
| AuditLog | 管理员或具备 `audit:view` 权限角色 |
| BackupRestore | 仅管理员或具备备份权限角色 |
| ExportService | 正式用户可导出；访客需具备导出权限或提交导出申请 |
| GuestDashboard | 访客用户和快速访问用户 |

---

## 7. 权限模型说明

权限模型由 `PermissionService.js` 定义。

### 7.1 角色类型

当前权限映射中主要包含以下角色：

| 角色 | 说明 |
|---|---|
| `admin` | 管理员，拥有全部权限 |
| `manager` | 主管，拥有记录管理、导出、审计查看等权限 |
| `operator` | 操作人员，拥有记录读取、创建、更新和部分导出权限 |
| `viewer` / guest | 访客或只读用户，通常仅允许查看数据 |

### 7.2 权限命名规范

权限采用：

```text
资源:操作
```

或：

```text
module:模块名
```

例如：

```text
records:read
records:create
records:update
records:delete
export:pdf
export:excel
backup:view
backup:create
backup:restore
users:read
users:create
users:update
users:delete
audit:view
audit:export
settings:view
settings:update
module:tableware
module:pesticide
module:oil
module:leanMeat
module:pathogen
```

### 7.3 管理员权限

`admin` 角色拥有：

```text
records:read
records:create
records:update
records:delete
export:pdf
export:excel
backup:view
backup:create
backup:restore
users:read
users:create
users:update
users:delete
audit:view
audit:export
settings:view
settings:update
module:tableware
module:pesticide
module:oil
module:leanMeat
module:pathogen
```

### 7.4 权限控制建议

后续维护时，建议遵循：

1. 页面级权限由 `Router.js` 控制；
2. 按钮级权限由页面模块结合 `PermissionService` 控制；
3. 接口级权限必须由后端再次校验；
4. 前端权限仅用于优化交互，不能作为安全边界；
5. 快速访问模式必须默认只读；
6. 数据备份、恢复、用户管理、审计导出等高风险功能仅允许管理员访问。

---

## 8. 用户认证与会话管理

### 8.1 AuthService.js

`AuthService.js` 是当前主认证链路使用的用户认证服务，负责：

- 用户登录；
- 用户登出；
- Token 保存；
- 用户信息保存；
- Token 过期检查；
- Refresh Token 保存；
- 清理访客身份；
- 记录登录审计日志。

### 8.2 认证相关 localStorage Key

`AuthService` 使用以下键：

| Key | 说明 |
|---|---|
| `auth_token` | 正式用户访问 Token |
| `current_user` | 当前用户信息 |
| `token_expiry` | Token 过期时间 |
| `refresh_token` | Refresh Token |

### 8.3 登录流程

用户登录时调用：

```javascript
authService.login(username, password)
```

其主要流程如下：

```text
校验用户名和密码
        ↓
POST /api/user/login
        ↓
服务端返回 token / user / expiresIn / refreshToken
        ↓
清除访客信息 current_guest / guest_token / is_quick_access
        ↓
保存 auth_token
        ↓
保存 current_user
        ↓
保存 token_expiry
        ↓
保存 refresh_token
        ↓
写入登录审计日志
```

### 8.4 访客身份清理

正式用户登录前，系统会清除访客相关数据：

```javascript
localStorage.removeItem('current_guest');
localStorage.removeItem('guest_token');
localStorage.removeItem('is_quick_access');
sessionStorage.removeItem('current_guest');
sessionStorage.removeItem('guest_token');
```

该设计用于避免访客身份与管理员身份混用。

### 8.5 SessionManager.js

`SessionManager.js` 负责会话生命周期管理，主要功能包括：

- 登录后创建会话；
- 登出后删除当前会话；
- 最多允许 5 个并发活跃会话；
- 30 分钟无活动自动登出；
- 记录设备信息；
- 记录浏览器信息；
- 与后端同步会话状态。

核心配置：

```javascript
this.maxConcurrentSessions = 5;
this.sessionTimeout = 30 * 60 * 1000;
```

---

## 9. 访客与快速访问模式

### 9.1 GuestAuthService.js

`GuestAuthService.js` 负责访客相关认证逻辑，包括：

- 访客注册；
- 访客登录；
- 访客 Token 保存；
- 当前访客信息保存；
- 快速访问模式判断；
- 快速访问临时访客创建。

### 9.2 访客类型

系统支持至少两类访客：

| 访客类型 | 说明 |
|---|---|
| `viewer` | 只读访客 |
| `export_applicant` | 可提交导出申请的访客 |

### 9.3 访客相关 Key

| Key | 存储位置 | 说明 |
|---|---|---|
| `guest_token` | localStorage | 访客 Token |
| `current_guest` | localStorage | 当前访客信息 |
| `is_quick_access` | localStorage | 是否快速访问模式 |
| `guest_token` | sessionStorage | 部分场景下的会话级访客 Token |
| `current_guest` | sessionStorage | 部分场景下的会话级访客信息 |

### 9.4 快速访问模式链路

快速访问模式完整流程如下：

```text
URL 参数 quickAccess=true
        ↓
main.js 检测快速访问参数
        ↓
GuestAuthService 判断 localStorage 状态
        ↓
如果未登录访客，则 quickAccessAsViewer()
        ↓
生成临时访客身份
        ↓
写入 guest_token / current_guest / is_quick_access
        ↓
调用 initializeSampleData()
        ↓
Router 识别为已认证状态
        ↓
隐藏后台管理、导出、备份、编辑、删除等功能
        ↓
仅展示只读数据
```

### 9.5 快速访问模式限制

快速访问模式应遵循以下限制：

1. 默认只读；
2. 禁止用户管理；
3. 禁止数据备份与恢复；
4. 禁止删除记录；
5. 禁止修改真实业务数据；
6. 禁止直接使用真实管理员 Token；
7. 示例数据不得覆盖真实数据；
8. 如需导出，应走访客导出申请流程。

---

## 10. 模块列表与职责总览

| 模块 | 文件 | 主要职责 |
|---|---|---|
| Dashboard | `Dashboard.js` | 数据看板、统计分析、趋势展示、风险提示 |
| UserManagement | `UserManagement.js` | 用户 CRUD、权限管理、用户列表 |
| AuditLog | `AuditLog.js` | 操作审计日志查询、筛选、分页、导出 |
| BackupRestore | `BackupRestore.js` | 数据备份、恢复、同步状态监控 |
| GenericTest | `GenericTest.js` | 通用检测流程，覆盖农残、油品、肉蛋类检测 |
| GuestDashboard | `GuestDashboard.js` | 访客中心、只读数据查看、导出申请 |
| Pathogen | `Pathogen.js` | 病原检测数据管理、Word 解析、风险评估 |
| Tableware | `Tableware.js` | 餐具洁净度、ATP、洗涤剂残留、整改流程 |
| ExportService | `ExportService.js` | 数据导出报告、日期/食堂/检测类型筛选 |

---

## 11. Dashboard 数据看板模块

### 11.1 模块定位

`Dashboard.js` 是系统的数据分析与可视化中心，用于汇总展示各类食品安全检测数据。

### 11.2 主要职责

- 汇总餐具、农残、油品、肉蛋类、病原检测数据；
- 展示总样本数；
- 展示各模块检测数量和合格率；
- 生成趋势图；
- 展示风险预警；
- 支持看板 PDF 导出；
- 记录导出操作到审计日志；
- 与 `StorageService`、`NetworkHelper`、`auditLogService` 等服务交互。

### 11.3 数据来源

数据主要来自以下业务缓存和存储服务：

| 数据类型 | 存储键 |
|---|---|
| 餐具洁净度 | `cache_tableware` |
| 果蔬农残 | `cache_pesticide` |
| 食用油品质 | `cache_oil` |
| 肉蛋/瘦肉精 | `cache_leanMeat` |
| 病原检测 | `cache_pathogen` |

### 11.4 维护注意事项

1. 看板数据依赖多个模块的缓存；
2. 切换回 Dashboard 时，应刷新数据；
3. 快速访问模式下只展示已有缓存或示例数据；
4. 导出 PDF 时应记录审计日志；
5. 图表销毁和重建时应避免重复实例导致内存泄漏。

---

## 12. UserManagement 用户管理模块

### 12.1 模块定位

`UserManagement.js` 是系统用户账号和权限管理模块。

### 12.2 主要职责

- 用户列表展示；
- 用户分页；
- 用户搜索与过滤；
- 创建用户；
- 编辑用户；
- 删除或停用用户；
- 用户权限和角色管理；
- 调用 `authService`；
- 记录用户管理操作审计日志。

### 12.3 容器挂载

模块使用以下 DOM 容器：

```javascript
document.getElementById('user-management')
```

### 12.4 权限要求

用户管理属于高权限模块，建议仅允许：

```text
admin
```

或具备以下权限的角色访问：

```text
users:read
users:create
users:update
users:delete
```

### 12.5 维护注意事项

1. 创建用户、修改用户、删除用户必须记录审计日志；
2. 禁止访客和快速访问用户访问；
3. 删除用户应优先考虑软删除或禁用；
4. 密码重置应由后端完成安全校验；
5. 前端按钮隐藏不能替代后端权限控制。

---

## 13. AuditLog 操作审计日志模块

### 13.1 模块定位

`AuditLog.js` 用于展示和查询系统操作审计日志。

### 13.2 主要职责

- 从后端 API 获取审计日志；
- 支持分页；
- 支持日期筛选；
- 支持用户筛选；
- 支持操作类型筛选；
- 支持导出；
- 展示关键操作记录。

### 13.3 状态字段

模块内部维护以下状态：

```javascript
this.logs = [];
this.currentPage = 1;
this.pageSize = 15;
this.totalCount = 0;
this.filterDate = '';
this.filterUser = '';
this.filterAction = '';
this.isLoading = false;
```

### 13.4 后端服务

审计日志服务由 `AuditLogService.js` 封装。

记录日志接口：

```text
POST /api/audit-logs
```

典型请求头：

```text
Authorization: Bearer <auth_token>
Content-Type: application/json
```

典型请求体：

```json
{
  "action": "create",
  "table_name": "tableware",
  "record_id": 123,
  "details": "新增餐具检测记录"
}
```

### 13.5 权限要求

建议仅允许：

```text
admin
manager
```

或具备以下权限的角色访问：

```text
audit:view
audit:export
```

---

## 14. BackupRestore 数据备份与恢复模块

### 14.1 模块定位

`BackupRestore.js` 用于系统业务数据的备份、恢复、同步状态监控和恢复后结果提示。

### 14.2 目标业务表

模块定义需要备份的业务表：

```javascript
this.targetTables = [
  'tableware',
  'pesticide',
  'oil',
  'leanMeat',
  'pathogen'
];
```

### 14.3 主要职责

- 创建数据备份；
- 执行数据恢复；
- 监控服务器连接状态；
- 定时检查同步状态；
- 展示恢复后的同步结果；
- 使用 `NetworkHelper` 监听网络状态；
- 记录备份和恢复操作到审计日志。

### 14.4 同步结果 Key

模块使用：

```text
last_sync_result
```

用于保存恢复后的同步结果提示。

### 14.5 权限要求

备份恢复属于高风险模块，应仅允许：

```text
admin
```

或具备以下权限的角色：

```text
backup:view
backup:create
backup:restore
```

### 14.6 风险控制要求

1. 恢复操作前必须二次确认；
2. 恢复操作应记录审计日志；
3. 恢复失败应保留错误详情；
4. 快速访问模式下必须隐藏该模块；
5. 普通操作员不应具备恢复权限；
6. 备份文件应限制下载权限。

---

## 15. GenericTest 通用检测模块

### 15.1 模块定位

`GenericTest.js` 是通用食品安全检测模块，主要用于管理以下检测类型：

- 果蔬农药残留；
- 食用油品质；
- 肉蛋类/瘦肉精相关检测；
- 其他可配置检测流程。

### 15.2 主要职责

- 动态生成检测 UI；
- 管理检测数据录入；
- 支持多点位或多样本录入；
- 执行表单校验；
- 保存检测记录；
- 支持编辑、删除、查询；
- 支持纠正措施记录；
- 支持本地缓存与服务端同步；
- 支持快速访问模式下的只读显示；
- 根据权限控制敏感操作。

### 15.3 主要依赖

| 依赖 | 用途 |
|---|---|
| `StorageService` | 数据保存、更新、删除、同步 |
| `auth` / `AuthService` | 用户权限判断 |
| `FormValidator` | 表单校验 |
| `UINotification` | 操作提示 |
| `NetworkHelper` | 网络同步辅助 |
| `GuestAuthService` | 快速访问模式判断 |

### 15.4 维护注意事项

1. 新增检测类型时应优先复用 `GenericTestModule`；
2. 检测类型应与 `StorageService` 的表名一致；
3. 每类检测数据应有明确判定规则；
4. 修改字段时需同步更新导出、看板和缓存逻辑；
5. 快速访问模式下不得允许真实提交。

---

## 16. GuestDashboard 访客中心模块

### 16.1 模块定位

`GuestDashboard.js` 为访客用户提供只读数据查看和导出申请入口。

### 16.2 主要职责

- 获取当前访客信息；
- 判断访客类型；
- 判断快速访问模式；
- 展示访客中心 UI；
- 加载导出申请记录；
- 根据访客权限显示不同功能；
- 限制访客修改数据。

### 16.3 容器挂载

```javascript
document.getElementById('guest-dashboard')
```

### 16.4 访客类型显示

```javascript
guest.guest_type === 'viewer'
  ? '只读访客'
  : '导出申请访客'
```

### 16.5 权限限制

访客默认不应具备：

- 用户管理权限；
- 数据删除权限；
- 数据备份权限；
- 数据恢复权限；
- 系统设置权限；
- 审计日志管理权限。

---

## 17. Pathogen 病原检测模块

### 17.1 模块定位

`Pathogen.js` 用于病原检测数据管理、Word 报告解析、检测结果展示和风险评估。

### 17.2 主要职责

- 管理病原检测记录；
- 支持 `.docx` 文件导入；
- 使用 Mammoth.js 解析 Word 文档；
- 从原始文本中提取检测数据；
- 展示检测结果；
- 计算病原检测风险；
- 支持历史记录查询；
- 支持本地缓存和服务端同步；
- 记录导入、修改、删除等操作审计日志。

### 17.3 主要依赖

| 依赖 | 用途 |
|---|---|
| `StorageService` | 病原检测数据持久化 |
| `AuthService` | 用户权限 |
| `GuestAuthService` | 访客和快速访问模式 |
| `Mammoth.js` | Word 文档解析 |
| `UINotification` | 操作提示 |
| `AuditLogService` | 审计日志 |

### 17.4 缓存键

| Key | 说明 |
|---|---|
| `cache_pathogen` | 病原检测本地缓存 |
| `pending_pathogen` | 病原检测待同步请求 |
| `fingerprint_index_pathogen` | 病原检测指纹去重索引 |

### 17.5 维护注意事项

1. Word 模板变更会影响解析逻辑；
2. 病原检测字段变更需同步更新风险评估逻辑；
3. 文件导入必须限制文件类型；
4. 快速访问模式下应禁用文件导入；
5. 解析失败应保留原始错误提示，便于排查。

---

## 18. Tableware 餐具洁净度检测模块

### 18.1 模块定位

`Tableware.js` 用于餐具与环境表面洁净度检测管理，重点覆盖 ATP 检测和洗涤剂残留检测。

### 18.2 主要职责

- 餐具洁净度检测数据录入；
- ATP RLU 值记录；
- 洗涤剂残留检测记录；
- 自动判断检测结果；
- 不合格记录整改；
- 整改状态追踪；
- 历史记录查询；
- 标准模式和快速访问模式切换；
- 本地缓存和后端同步。

### 18.3 支持模式

| 模式 | 说明 |
|---|---|
| Standard Mode | 完整录入、编辑、删除、整改 |
| Quick Access Mode | 只读展示，隐藏录入、编辑、删除等操作 |

### 18.4 缓存键

| Key | 说明 |
|---|---|
| `cache_tableware` | 餐具检测本地缓存 |
| `pending_tableware` | 餐具检测待同步请求 |
| `fingerprint_index_tableware` | 餐具检测指纹去重索引 |

### 18.5 快速访问渲染

`main.js` 中定义了：

```javascript
window.renderQuickAccessData = () => {
  const cacheData = localStorage.getItem('cache_tableware');
  ...
};
```

该函数会读取：

```text
cache_tableware
```

并渲染最多前 20 条记录。

---

## 19. ExportService 数据导出模块

### 19.1 模块定位

`ExportService.js` 用于生成数据导出报告，支持按日期、食堂、检测类型等条件筛选。

### 19.2 数据来源

模块初始化时创建多个 `StorageService` 实例：

```javascript
this.storage = {
  tableware: new StorageService('tableware'),
  pesticide: new StorageService('pesticide'),
  oil: new StorageService('oil'),
  leanMeat: new StorageService('leanMeat'),
  pathogen: new StorageService('pathogen')
};
```

### 19.3 支持筛选条件

- 日期范围；
- 食堂；
- 检测类型；
- 肉类品种；
- 其他业务字段。

### 19.4 支持检测类型

| 检测类型 | 对应值 |
|---|---|
| 餐具洁净度 | `tableware` |
| 果蔬农残 | `pesticide` |
| 食用油品质 | `oil` |
| 肉、蛋农残 | `leanMeat` |
| 病原体检测 | `pathogen` |

### 19.5 权限要求

导出操作建议要求：

```text
export:pdf
export:excel
```

访客如果需要导出，应进入导出申请流程，而不是直接下载正式报告。

---

## 20. BaseTestModule 测试模块基类

### 20.1 模块定位

`BaseTestModule.js` 是测试类业务模块的通用基类，封装了事件系统、数据状态、分页、排序和缓存能力。

### 20.2 主要能力

- 事件监听；
- 事件取消；
- 事件触发；
- 一次性事件监听；
- 数据数组维护；
- Loading 状态；
- 分页状态；
- 筛选条件；
- 排序字段；
- 缓存开关；
- 缓存 TTL 配置。

### 20.3 默认分页与排序

```javascript
this.currentPage = 1;
this.pageSize = 20;
this.sortBy = 'created_at';
this.sortOrder = 'desc';
```

### 20.4 默认缓存时间

```javascript
this.cacheTTL = 30 * 60 * 1000;
```

即：

```text
30 分钟
```

---

## 21. FormBuilder 动态表单生成器

### 21.1 模块定位

`FormBuilder.js` 用于根据字段配置动态生成 HTML 表单，减少各检测模块中重复的表单代码。

### 21.2 主要能力

- 定义单个字段；
- 批量定义字段；
- 设置字段类型；
- 设置字段 label；
- 设置必填规则；
- 设置 placeholder；
- 添加字段验证器；
- 动态生成表单 HTML；
- 支持不同布局方式。

### 21.3 默认配置

```javascript
{
  layout: 'vertical',
  submitText: '提交',
  resetText: '重置',
  cssClass: ''
}
```

### 21.4 维护建议

1. 新增检测表单时优先考虑复用 `FormBuilder`；
2. 字段配置应集中管理；
3. 表单校验规则应和后端保持一致；
4. 不应仅依赖前端校验保护数据完整性。

---

## 22. StorageService 数据存储与同步机制

### 22.1 模块定位

`Storage.js` 中的 `StorageService` 是系统业务数据存储与同步的核心类。

它负责：

- 本地缓存初始化；
- 读取本地数据；
- 保存数据；
- 更新数据；
- 删除数据；
- 生成待同步请求；
- 与后端 API 同步；
- 临时 ID 管理；
- 数据去重；
- 指纹索引；
- 同步队列处理；
- 全局退避控制。

### 22.2 支持的业务表

```javascript
const TABLE_NAME_MAP = {
  leanMeat: 'leanMeat',
  oil: 'oil',
  pathogen: 'pathogen',
  pesticide: 'pesticide',
  tableware: 'tableware'
};
```

### 22.3 默认配置

```javascript
const DEFAULT_CONFIG = {
  apiBaseUrl: '/api/records',
  maxSyncRows: 200,
  syncCooldownMs: 30000,
  queueBatchSize: 5,
  queueBatchDelayMs: 400,
  minRetryDelayMs: 1000,
  maxRetryDelayMs: 30000,
  globalBackoffKey: 'app_sync_backoff_until'
};
```

### 22.4 关键 Key 生成规则

每个 `StorageService(tableName)` 会生成以下 key：

```javascript
this.localCacheKey = `cache_${tableName}`;
this.pendingRequestsKey = `pending_${tableName}`;
this.fingerprintIndexKey = `fingerprint_index_${tableName}`;
```

### 22.5 业务缓存键表

| 业务模块 | localCacheKey | pendingRequestsKey | fingerprintIndexKey |
|---|---|---|---|
| 餐具洁净度 | `cache_tableware` | `pending_tableware` | `fingerprint_index_tableware` |
| 果蔬农残 | `cache_pesticide` | `pending_pesticide` | `fingerprint_index_pesticide` |
| 食用油品质 | `cache_oil` | `pending_oil` | `fingerprint_index_oil` |
| 肉蛋/瘦肉精 | `cache_leanMeat` | `pending_leanMeat` | `fingerprint_index_leanMeat` |
| 病原检测 | `cache_pathogen` | `pending_pathogen` | `fingerprint_index_pathogen` |

### 22.6 读取流程

调用：

```javascript
storage.getAll()
```

时，系统会：

```text
读取本地 cache_<tableName>
        ↓
异步触发 _syncFromApi()
        ↓
返回本地缓存数据
        ↓
后台同步服务器数据
        ↓
合并本地和服务器数据
        ↓
更新 cache_<tableName>
```

该设计属于 **本地优先、后台同步** 模式。

### 22.7 保存流程

调用：

```javascript
storage.save(data)
```

时，系统会：

```text
清理 payload
        ↓
本地去重检查
        ↓
生成 temp_<timestamp>_<random> 临时 ID
        ↓
写入 cache_<tableName>
        ↓
标记 _status = pending
        ↓
写入 pending_<tableName>
        ↓
触发 _processQueuedRequests()
        ↓
后台创建服务器记录
```

### 22.8 更新流程

调用：

```javascript
storage.update(id, updatedData)
```

时，系统会：

```text
查找本地缓存记录
        ↓
清理更新数据
        ↓
本地去重检查
        ↓
更新 cache_<tableName>
        ↓
标记 _status = updating
        ↓
如果是 tempId，则合并临时更新
        ↓
如果是服务端 ID，则写入 pending_<tableName>
        ↓
触发同步队列
```

### 22.9 删除流程

调用：

```javascript
storage.delete(id)
```

时，系统会：

```text
从 cache_<tableName> 移除记录
        ↓
如果是 tempId，则清理本地待创建请求
        ↓
如果是服务端 ID，则写入 delete 请求到 pending_<tableName>
        ↓
触发同步队列
```

### 22.10 同步鉴权

`StorageService` 会从以下位置读取 Token：

```javascript
const adminToken = localStorage.getItem('auth_token');
const guestToken = localStorage.getItem('guest_token');
return adminToken || guestToken || null;
```

如果 Token 不存在，则不进行服务端同步。

如果 Token 是临时 Token，例如：

```text
temp-token-*
```

则不允许同步真实服务器。

### 22.11 同步状态字段

本地记录可能包含：

| 状态 | 说明 |
|---|---|
| `pending` | 新建记录待同步 |
| `updating` | 更新记录待同步 |
| `synced` | 已与服务器同步 |

### 22.12 维护注意事项

1. 不要随意删除 `pending_*`，否则可能丢失未同步数据；
2. 可删除 `cache_*`，系统会尝试从服务器重新拉取；
3. 修改字段结构时需考虑指纹去重逻辑；
4. 同步失败时应检查 `app_sync_backoff_until`；
5. 访客或快速访问模式应避免写入真实服务端；
6. 对关键业务数据执行恢复前，应备份 localStorage。

---

## 23. CacheManager 缓存管理机制

### 23.1 模块定位

`CacheManager.js` 是统一缓存管理器，支持：

- 内存缓存；
- localStorage 缓存；
- 自动过期；
- 最大缓存数量限制；
- LRU 淘汰；
- 缓存统计；
- 命名空间隔离。

### 23.2 默认配置

```javascript
{
  maxSize: 100,
  defaultTTL: 60 * 60 * 1000,
  enableLocalStorage: true,
  namespace: 'cache'
}
```

即：

| 配置 | 默认值 |
|---|---|
| 最大缓存项数 | 100 |
| 默认过期时间 | 1 小时 |
| 是否启用 localStorage | 是 |
| 命名空间 | `cache` |

### 23.3 缓存键格式

`CacheManager` 的缓存键格式为：

```text
<namespace>:<key>
```

默认情况下：

```text
cache:<key>
```

### 23.4 缓存读取顺序

```text
先读取内存缓存
        ↓
如果命中且未过期，直接返回
        ↓
如果内存未命中，读取 localStorage
        ↓
如果 localStorage 命中且未过期，恢复到内存
        ↓
如果均未命中，返回 null
```

### 23.5 缓存数据结构

缓存项通常包含：

```javascript
{
  value,
  ttl,
  createdAt,
  expiresAt,
  accessCount,
  lastAccess,
  size
}
```

### 23.6 缓存统计

`getStats()` 返回：

- hits；
- misses；
- sets；
- deletes；
- total；
- hitRate；
- size；
- maxSize。

### 23.7 与 StorageService 的区别

| 项目 | StorageService | CacheManager |
|---|---|---|
| 主要用途 | 业务数据持久化和同步 | 通用缓存 |
| key 格式 | `cache_<tableName>` | `cache:<key>` |
| 是否管理 pending 队列 | 是 | 否 |
| 是否同步服务器 | 是 | 否 |
| 是否有 TTL | 间接/业务控制 | 是 |
| 是否有内存缓存 | 否/较弱 | 是 |

---

## 24. localStorage 缓存键规范

### 24.1 Key 类型总览

| 类型 | 格式 | 用途 |
|---|---|---|
| 认证 Token | `auth_token` | 正式用户 Token |
| 当前用户 | `current_user` | 登录用户信息 |
| Token 过期 | `token_expiry` | Token 过期时间 |
| Refresh Token | `refresh_token` | 刷新 Token |
| 访客 Token | `guest_token` | 访客 Token |
| 当前访客 | `current_guest` | 访客信息 |
| 快速访问标识 | `is_quick_access` | 是否快速访问模式 |
| 业务缓存 | `cache_<tableName>` | 业务数据本地缓存 |
| 待同步请求 | `pending_<tableName>` | 业务数据待同步队列 |
| 指纹索引 | `fingerprint_index_<tableName>` | 数据去重索引 |
| 同步退避 | `app_sync_backoff_until` | 全局同步退避时间 |
| 同步结果 | `last_sync_result` | 备份恢复后同步结果 |
| 通用缓存 | `cache:<key>` | CacheManager 管理的缓存 |

### 24.2 `cache_*` 规范

`cache_*` 用于保存已经进入本地数据区的业务数据。

格式：

```text
cache_<tableName>
```

示例：

```text
cache_tableware
cache_pesticide
cache_oil
cache_leanMeat
cache_pathogen
```

用途：

- 页面快速渲染；
- 离线查看；
- 后台同步前的本地数据源；
- 快速访问模式展示数据；
- 看板统计数据来源。

维护原则：

1. `cache_*` 可被视为本地业务数据副本；
2. 不建议在存在 `pending_*` 时直接清除；
3. 如需清理，应优先完成同步或导出备份；
4. 可通过服务端重新同步恢复部分数据；
5. 快速访问示例数据也可能写入 `cache_*`。

### 24.3 `pending_*` 规范

`pending_*` 用于保存尚未成功同步到服务器的操作请求。

格式：

```text
pending_<tableName>
```

示例：

```text
pending_tableware
pending_pesticide
pending_oil
pending_leanMeat
pending_pathogen
```

待同步请求通常包括：

- create；
- update；
- delete。

维护原则：

1. `pending_*` 不应随意删除；
2. 删除会导致未同步新增、修改或删除操作丢失；
3. 网络恢复后系统会尝试重新处理；
4. 同步失败时可结合控制台日志和 `app_sync_backoff_until` 排查；
5. 备份恢复前建议导出 `pending_*` 内容。

### 24.4 `fingerprint_index_*` 规范

`fingerprint_index_*` 用于保存服务端或本地数据指纹索引，主要用于去重。

格式：

```text
fingerprint_index_<tableName>
```

示例：

```text
fingerprint_index_tableware
fingerprint_index_pathogen
```

维护原则：

1. 该数据用于减少重复上传；
2. 若出现误判重复，可清理对应索引后重新同步；
3. 清理前建议备份；
4. 字段结构变化可能影响指纹生成。

### 24.5 认证类 Key 规范

| Key | 可否手动删除 | 删除影响 |
|---|---|---|
| `auth_token` | 可以 | 用户退出登录 |
| `current_user` | 可以 | 用户状态丢失 |
| `token_expiry` | 可以 | Token 过期判断异常或重新登录 |
| `refresh_token` | 可以 | 无法刷新 Token |
| `guest_token` | 可以 | 访客退出登录 |
| `current_guest` | 可以 | 访客信息丢失 |
| `is_quick_access` | 可以 | 快速访问模式失效 |

### 24.6 推荐排查命令

浏览器控制台查看所有业务缓存：

```javascript
Object.keys(localStorage).filter(k => k.startsWith('cache_'));
```

查看所有待同步请求：

```javascript
Object.keys(localStorage).filter(k => k.startsWith('pending_'));
```

查看认证状态：

```javascript
localStorage.getItem('auth_token');
localStorage.getItem('current_user');
localStorage.getItem('guest_token');
localStorage.getItem('current_guest');
```

清除快速访问状态：

```javascript
localStorage.removeItem('is_quick_access');
localStorage.removeItem('guest_token');
localStorage.removeItem('current_guest');
sessionStorage.removeItem('guest_token');
sessionStorage.removeItem('current_guest');
```

---

## 25. SampleDataGenerator.js 示例数据生成器

### 25.1 模块定位

`SampleDataGenerator.js` 用于在快速访问模式下生成或补齐示例检测数据。

该文件主要服务于：

- 快速访问模式；
- 演示环境；
- 访客只读浏览；
- 前端功能验证；
- 无真实数据时的页面展示。

### 25.2 启用条件

示例数据生成器仅在 URL 参数满足以下条件时启用：

```javascript
const isQuickAccess = urlParams.get('quickAccess') === 'true';
```

如果不是快速访问模式，函数会直接返回：

```javascript
if (!isQuickAccess) return;
```

### 25.3 初始化入口

在 `main.js` 中：

```javascript
if (isQuickAccessMode) {
  initializeSampleData();
}
```

### 25.4 数据保护原则

当前代码中特别注意：

```javascript
// 不清除缓存，因为可能已有真实数据。只在必要时添加缺失的数据
```

这说明示例数据生成器的设计原则是：

1. 不主动清空 `cache_*`；
2. 不主动清空 `pending_*`；
3. 不覆盖真实数据；
4. 仅在必要时补充缺失数据；
5. 服务于快速访问模式的只读展示。

### 25.5 禁止事项

在生产环境中，不应使用示例数据生成器执行以下操作：

- 覆盖真实业务数据；
- 清空 `cache_*`；
- 清空 `pending_*`；
- 自动创建真实服务器记录；
- 作为正式检测数据来源；
- 伪造审计记录。

### 25.6 推荐文档说明

应在代码和文档中明确：

```text
SampleDataGenerator.js 仅用于快速访问、演示和前端功能验证。
该模块不应作为生产环境真实业务数据来源。
```

---

## 26. APIClient 与 NetworkHelper

### 26.1 APIClient.js

`ApiClient.js` 是通用 REST API 客户端，默认基础路径为：

```javascript
new APIClient('/api')
```

### 26.2 APIClient 支持的认证接口

| 方法 | 接口 |
|---|---|
| `login()` | `POST /auth/login` |
| `logout()` | `POST /auth/logout` |
| `refreshToken()` | `POST /auth/refresh` |

注意：当前主认证链路中的 `AuthService.js` 使用的是：

```text
POST /api/user/login
```

而 `ApiClient.js` 使用：

```text
POST /api/auth/login
```

这说明系统中可能存在两套认证接口封装。后续重构时建议统一。

### 26.3 APIClient 支持的记录接口

| 方法 | 接口 |
|---|---|
| `getRecords(type)` | `GET /records/:type` |
| `getRecord(type, id)` | `GET /records/:type/:id` |
| `createRecord(type, data)` | `POST /records/:type` |
| `updateRecord(type, id, data)` | `PUT /records/:type/:id` |
| `deleteRecord(type, id)` | `DELETE /records/:type/:id` |
| `getStatistics(type)` | `GET /statistics/:type` |

### 26.4 NetworkHelper.js

`NetworkHelper.js` 提供带超时和重试机制的请求能力。

核心方法：

```javascript
NetworkHelper.fetchWithRetry(url, options)
```

默认配置：

| 参数 | 默认值 |
|---|---|
| timeout | 10000 ms |
| retries | 3 |
| retryDelay | 1000 ms |

请求流程：

```text
发起请求
        ↓
如果超时或失败，记录错误
        ↓
调用 onRetry 回调
        ↓
按 retryDelay * attempt 延迟
        ↓
重试
        ↓
超过最大次数后抛出错误
```

### 26.5 使用建议

1. 高风险接口应设置较短超时；
2. 数据同步接口可允许重试；
3. 删除、恢复等非幂等操作应谨慎重试；
4. Token 过期错误应统一跳转登录或刷新 Token；
5. 网络错误和业务错误应区分提示。

---

## 27. 审计日志机制

### 27.1 相关文件

| 文件 | 说明 |
|---|---|
| `AuditLog.js` | 审计日志页面模块 |
| `AuditLogService.js` | 审计日志 API 服务 |
| `AuditLogger.js` | 前端轻量审计封装，供其他模块调用 |

### 27.2 审计日志记录接口

`AuditLogService` 记录日志时调用：

```text
POST /api/audit-logs
```

请求体：

```json
{
  "action": "login",
  "table_name": "system",
  "record_id": null,
  "details": "用户 admin 登录系统"
}
```

### 27.3 需要记录审计日志的操作

建议以下操作必须记录：

| 操作 | 是否必须记录 |
|---|---|
| 登录 | 是 |
| 登出 | 建议 |
| 新增检测记录 | 是 |
| 修改检测记录 | 是 |
| 删除检测记录 | 是 |
| 导入病原检测文件 | 是 |
| 导出报告 | 是 |
| 创建用户 | 是 |
| 修改用户 | 是 |
| 删除/禁用用户 | 是 |
| 数据备份 | 是 |
| 数据恢复 | 是 |
| 权限变更 | 是 |

---

## 28. 数据备份、恢复与同步状态

### 28.1 备份恢复相关模块

| 文件 | 说明 |
|---|---|
| `BackupRestore.js` | 备份恢复页面和同步状态管理 |
| `Storage.js` | 业务数据本地缓存与同步 |
| `NetworkHelper.js` | 网络状态辅助 |
| `AuditLogService.js` | 审计日志记录 |

### 28.2 备份范围

备份范围建议覆盖：

```text
tableware
pesticide
oil
leanMeat
pathogen
users
audit_logs
settings
```

当前前端模块中明确的业务表为：

```javascript
['tableware', 'pesticide', 'oil', 'leanMeat', 'pathogen']
```

### 28.3 恢复后的前端行为

恢复后建议：

```text
保存 last_sync_result
        ↓
刷新页面或重新初始化模块
        ↓
BackupRestore 检查 last_sync_result
        ↓
展示恢复/同步结果通知
        ↓
清除 last_sync_result
        ↓
重新拉取服务端数据
```

---

## 29. 调试入口与常用排查方法

### 29.1 全局调试对象

系统暴露：

```javascript
window.router
```

用于路由调试。

快速访问模式下还暴露：

```javascript
window.renderQuickAccessData
```

用于重新渲染餐具缓存数据。

### 29.2 检查当前用户

```javascript
JSON.parse(localStorage.getItem('current_user') || 'null');
```

### 29.3 检查当前访客

```javascript
JSON.parse(localStorage.getItem('current_guest') || 'null');
```

### 29.4 检查是否快速访问

```javascript
localStorage.getItem('is_quick_access');
```

### 29.5 检查业务缓存

```javascript
JSON.parse(localStorage.getItem('cache_tableware') || 'null');
```

### 29.6 检查待同步队列

```javascript
JSON.parse(localStorage.getItem('pending_tableware') || '[]');
```

### 29.7 检查同步退避

```javascript
localStorage.getItem('app_sync_backoff_until');
```

### 29.8 强制退出访客模式

```javascript
localStorage.removeItem('guest_token');
localStorage.removeItem('current_guest');
localStorage.removeItem('is_quick_access');
sessionStorage.removeItem('guest_token');
sessionStorage.removeItem('current_guest');
location.reload();
```

### 29.9 强制退出正式登录

```javascript
localStorage.removeItem('auth_token');
localStorage.removeItem('current_user');
localStorage.removeItem('token_expiry');
localStorage.removeItem('refresh_token');
location.reload();
```

---

## 30. 已知架构注意事项

### 30.1 认证服务存在多套封装

当前系统中存在：

```text
AuthService.js
UserAuth.js
ApiClient.js
```

其中：

- `Router.js` 当前主要依赖 `AuthService.js`；
- `UserAuth.js` 依赖 `ApiClient.js`；
- `AuthService.js` 登录接口为 `/api/user/login`；
- `ApiClient.js` 登录接口为 `/api/auth/login`。

建议后续重构时统一认证入口，避免：

- Token 来源不一致；
- 登录接口不一致；
- 登出清理不一致；
- 权限判断不一致；
- 多标签页状态同步异常。

### 30.2 快速访问模式必须避免真实写入

快速访问模式可能产生临时访客身份和示例数据。应确保：

1. 不使用真实管理员 Token；
2. 不上传示例数据到真实后端；
3. 不显示管理功能；
4. 不允许编辑、删除、恢复；
5. 不覆盖已有真实缓存。

### 30.3 localStorage 不应作为最终安全边界

localStorage 中的数据可被用户修改，因此：

1. 前端权限仅用于交互控制；
2. 后端必须再次校验 Token 和权限；
3. 敏感操作必须由服务端判断角色；
4. 审计日志应由后端可靠记录。

---

## 31. 后续维护规范

### 31.1 新增业务模块

新增模块时建议遵循以下步骤：

1. 新建模块文件，例如 `NewModule.js`；
2. 在 `index.html` 中增加对应容器；
3. 在 `main.js` 中引入并初始化；
4. 在 `Router.js` 中增加路由或页面切换配置；
5. 在 `PermissionService.js` 中增加模块权限；
6. 如有业务数据，使用 `new StorageService('<tableName>')`；
7. 定义 `cache_<tableName>`、`pending_<tableName>`、`fingerprint_index_<tableName>`；
8. 如有导出需求，同步更新 `ExportService.js`；
9. 如需要看板统计，同步更新 `Dashboard.js`；
10. 对新增、修改、删除、导出等操作接入审计日志。

### 31.2 新增权限

新增权限时应：

1. 在 `PermissionService.js` 中定义权限字符串；
2. 分配给对应角色；
3. 在页面按钮处做前端判断；
4. 在 `Router.js` 中做页面访问控制；
5. 后端接口同步增加权限校验；
6. 更新本文档权限章节。

### 31.3 修改缓存结构

修改缓存结构时应：

1. 明确版本兼容策略；
2. 避免直接破坏旧 `cache_*` 数据；
3. 避免删除 `pending_*`；
4. 必要时提供迁移函数；
5. 同步更新 `SampleDataGenerator.js`；
6. 同步更新导出和看板逻辑；
7. 更新本文档缓存键说明。

### 31.4 修改检测字段

修改检测字段时应同步检查：

- 对应业务模块；
- `StorageService` 数据清理逻辑；
- 指纹去重逻辑；
- `Dashboard.js` 统计逻辑；
- `ExportService.js` 导出逻辑；
- `SampleDataGenerator.js` 示例数据；
- 后端数据库字段；
- API 返回结构；
- 审计日志详情；
- 文档字段说明。

### 31.5 部署前检查清单

部署前建议检查：

```text
[ ] 登录接口可用
[ ] auth_token 正常保存
[ ] Router 初始化正常
[ ] 管理员可访问用户管理
[ ] 普通用户无法访问备份恢复
[ ] 访客只能只读访问
[ ] quickAccess=true 能正常进入
[ ] SampleDataGenerator 不覆盖真实数据
[ ] cache_* 能正常读取
[ ] pending_* 能正常同步
[ ] Dashboard 能刷新最新数据
[ ] ExportService 能读取各模块数据
[ ] AuditLog 能查询日志
[ ] BackupRestore 恢复后能显示同步结果
[ ] 控制台无关键错误
```

---

## 32. 附录：关键 localStorage Key 清单

| Key | 类型 | 来源 | 说明 |
|---|---|---|---|
| `auth_token` | string | AuthService / APIClient | 正式用户 Token |
| `current_user` | JSON | AuthService / UserAuth | 当前登录用户 |
| `token_expiry` | number/string | AuthService | Token 过期时间 |
| `refresh_token` | string | AuthService | Refresh Token |
| `guest_token` | string | GuestAuthService | 访客 Token |
| `current_guest` | JSON | GuestAuthService | 当前访客 |
| `is_quick_access` | string/bool | GuestAuthService / main.js | 快速访问模式 |
| `cache_tableware` | JSON | StorageService | 餐具检测缓存 |
| `pending_tableware` | JSON Array | StorageService | 餐具检测待同步 |
| `fingerprint_index_tableware` | JSON | StorageService | 餐具检测去重索引 |
| `cache_pesticide` | JSON | StorageService | 果蔬农残缓存 |
| `pending_pesticide` | JSON Array | StorageService | 果蔬农残待同步 |
| `fingerprint_index_pesticide` | JSON | StorageService | 果蔬农残去重索引 |
| `cache_oil` | JSON | StorageService | 食用油品质缓存 |
| `pending_oil` | JSON Array | StorageService | 食用油品质待同步 |
| `fingerprint_index_oil` | JSON | StorageService | 食用油品质去重索引 |
| `cache_leanMeat` | JSON | StorageService | 肉蛋/瘦肉精检测缓存 |
| `pending_leanMeat` | JSON Array | StorageService | 肉蛋/瘦肉精检测待同步 |
| `fingerprint_index_leanMeat` | JSON | StorageService | 肉蛋/瘦肉精检测去重索引 |
| `cache_pathogen` | JSON | StorageService | 病原检测缓存 |
| `pending_pathogen` | JSON Array | StorageService | 病原检测待同步 |
| `fingerprint_index_pathogen` | JSON | StorageService | 病原检测去重索引 |
| `app_sync_backoff_until` | timestamp | StorageService | 全局同步退避时间 |
| `last_sync_result` | JSON | BackupRestore | 恢复后同步结果 |
| `cache:<key>` | JSON | CacheManager | 通用缓存 |

---

## 33. 附录：核心业务数据表名

| 业务 | tableName | 说明 |
|---|---|---|
| 餐具洁净度 | `tableware` | ATP、洗涤剂残留、整改 |
| 果蔬农残 | `pesticide` | 果蔬农药残留 |
| 食用油品质 | `oil` | 油温、TPM/氧化值等 |
| 肉蛋类检测 | `leanMeat` | 肉、蛋、瘦肉精相关检测 |
| 病原检测 | `pathogen` | 病原体检测、Word 导入解析 |

---

## 34. 附录：推荐前端问题排查顺序

当系统出现前端问题时，建议按以下顺序排查：

```text
1. 打开浏览器控制台，查看是否有 JS 报错
2. 检查 main.js 是否成功加载
3. 检查 Router 是否初始化成功
4. 检查 window.router 是否存在
5. 检查 auth_token / guest_token 是否存在
6. 检查 current_user / current_guest 是否有效
7. 检查是否误处于 quickAccess 模式
8. 检查目标模块 DOM 容器是否存在
9. 检查 cache_* 是否有数据
10. 检查 pending_* 是否堆积
11. 检查 API 请求是否 401/403/500
12. 检查 Nginx API 代理路径
13. 检查后端服务是否运行
14. 检查数据库是否有对应表和数据
15. 检查权限配置是否遗漏
```

---

## 35. 文档维护说明

本文档应随以下变更同步更新：

- 新增前端模块；
- 修改路由或权限；
- 修改 localStorage key；
- 修改业务数据结构；
- 修改示例数据生成逻辑；
- 修改登录、访客或快速访问机制；
- 修改导出、备份、恢复流程；
- 修改 API 地址或返回结构；
- 修改前端启动流程；
- 修改部署方式。

建议文档维护人每次版本发布前检查本文档是否与代码一致。

---

# End of FRONTEND_GUIDE.md
