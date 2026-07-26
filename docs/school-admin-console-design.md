# 学校管理控制台设计方案

## 1. 背景与目标

### 现状问题
- 现有 `admin-schools.html` 只能新增学校（code/name/adminPassword），不能编辑学校信息、管理定制配置、管理学校用户
- 每次新增学校或调整学校界面（校徽/主题色/字段定制）都要改代码或手动操作数据库
- README 承诺"新增学校零改码"，但实际管理能力缺失

### 目标
构建一个**零改码**的学校管理控制台，平台超管通过 GUI 即可完成：
- 新增/编辑/停用学校
- 配置每校外观（校徽/名称/主题色）
- 配置每校字段定制（可见检测类型/字段标签/隐藏字段/字段规则）
- 管理每校用户（查看/重置密码/启用停用）

## 2. 权限设计（RBAC 扩展）

### 新增权限
```
schools:manage   — 管理学校（平台超管独有）
```

### 区分两种 admin
| 角色 | role | schoolCode | 能力 |
|---|---|---|---|
| 平台超管 | admin | null（public schema） | 管理所有学校 + 本校所有功能 |
| 学校 admin | admin | "xxx"（school_xxx schema） | 仅本校功能，**不能**管理学校 |

### 实现方式
- **后端**：已有 `requirePlatformSuperAdmin` 中间件（`role=admin && !schoolCode`），所有学校管理 API 复用
- **前端**：`PermissionService` 新增 `schools:manage` 权限，仅当 `user.role==='admin' && !user.schoolCode` 时返回
- **Router**：新增 `isPlatformSuperAdmin()` 方法，导航栏据此显示"学校管理"入口

## 3. 界面设计

### 3.1 整体布局

```
┌─────────────────────────────────────────────────────────┐
│  顶部栏：学校管理控制台（平台超管）          [返回主界面] │
├─────────────────────────────────────────────────────────┤
│                                                         │
│  ┌─────────────────────────────────────────────────┐   │
│  │  [+ 新增学校]  [刷新]            搜索: [______]  │   │
│  ├─────────────────────────────────────────────────┤   │
│  │  代码    名称         状态   校徽  创建时间  操作 │   │
│  │  ──────────────────────────────────────────────  │   │
│  │  zhuhai  珠海市第一中学 启用  🏫  2025-01-01 [管理] │   │
│  │  tjb     田家炳中学     启用  🏫  2025-03-15 [管理] │   │
│  │  ...                                              │   │
│  └─────────────────────────────────────────────────┘   │
│                                                         │
│  ┌── 学校详情面板（点击[管理]展开）──────────────────┐   │
│  │  [基本信息] [界面定制] [用户管理]                 │   │
│  │  ──────────────────────────────────────────────  │   │
│  │  (Tab 内容区)                                     │   │
│  └──────────────────────────────────────────────────┘   │
└─────────────────────────────────────────────────────────┘
```

### 3.2 Tab: 基本信息

```
学校代码:    zhuhai-yizhong     (只读，创建后不可改)
学校全称:    [珠海市第一中学    ]
学校简称:    [珠海一中          ]
主题色:      [#1a73e8] [色块预览]
校徽 URL:   [https://.../logo.png]  [预览]
状态:       ◉ 启用  ○ 停用
登录地址:    /zhuhai-yizhong/login  (只读)

                              [保存修改]
```

### 3.3 Tab: 界面定制（SchoolCustomization）

```
┌─ 可见检测类型 ────────────────────────────────┐
│ ☑ 餐具洁净度  ☑ 果蔬农残  ☑ 食用油品质       │
│ ☑ 瘦肉精检测  ☑ 致病菌检测                    │
│ （勾选的模块在该校主界面显示）                  │
└──────────────────────────────────────────────┘

┌─ 字段标签覆盖 ────────────────────────────────┐
│ 字段名              显示标签                   │
│ testDate            [检测日期           ]      │
│ canteen             [食堂               ]      │
│ inspector           [检测员             ]      │
│ [+ 添加字段]                                   │
└──────────────────────────────────────────────┘

┌─ 隐藏字段 ────────────────────────────────────┐
│ 已隐藏: [sampler ×] [batchNo ×]  [+ 添加]      │
└──────────────────────────────────────────────┘

┌─ 字段规则 ────────────────────────────────────┐
│ 字段名     必填   最大长度   最小长度          │
│ note      ☐     [200      ] [0      ]         │
│ sampler   ☑     [50       ] [1      ]         │
│ [+ 添加规则]                                   │
└──────────────────────────────────────────────┘

                              [保存定制]
```

### 3.4 Tab: 用户管理

```
用户名       角色       状态    最后登录        操作
──────────────────────────────────────────────────
admin       管理员     启用    2025-07-22      [重置密码]
zhang       操作人员   启用    2025-07-20      [重置密码] [停用]
li          查看者     停用    2025-06-15      [重置密码] [启用]

                              [+ 新增用户]
```

### 3.5 新增学校对话框

```
┌── 新增学校 ──────────────────────────────────┐
│                                              │
│  学校代码 *:  [tianjiabing                   ]│
│  (小写字母/数字/连字符，创建后不可改)          │
│                                              │
│  学校全称:    [田家炳中学                     ]│
│  学校简称:    [田家炳                         ]│
│  主题色:      [#1a73e8]                       │
│  校徽 URL:   [                               ]│
│                                              │
│  Admin 初始密码 *: [********         ]        │
│  (至少 8 位)                                 │
│                                              │
│              [取消]  [创建学校]               │
└──────────────────────────────────────────────┘
```

## 4. 后端 API 设计

### 已有（复用）
| 方法 | 路径 | 权限 | 说明 |
|---|---|---|---|
| GET | `/api/admin/schools` | 平台超管 | 列出所有学校 |
| POST | `/api/admin/schools` | 平台超管 | 新增学校（provision） |
| GET | `/api/schools/:code/config` | 公开 | 获取学校配置（登录前用） |

### 新增
| 方法 | 路径 | 权限 | 说明 |
|---|---|---|---|
| PUT | `/api/admin/schools/:code` | 平台超管 | 更新学校基本信息（name/short_name/theme_color/logo_url） |
| PATCH | `/api/admin/schools/:code/status` | 平台超管 | 启用/停用学校 |
| GET | `/api/admin/schools/:code/customization` | 平台超管 | 获取该校定制配置 |
| PUT | `/api/admin/schools/:code/customization` | 平台超管 | 更新该校定制配置（整体覆盖） |
| GET | `/api/admin/schools/:code/users` | 平台超管 | 列出该校用户（跨 schema 查询） |
| POST | `/api/admin/schools/:code/users/:userId/reset-password` | 平台超管 | 重置该校用户密码 |
| PATCH | `/api/admin/schools/:code/users/:userId/status` | 平台超管 | 启用/停用该校用户 |

### API 细节

#### PUT /api/admin/schools/:code
```json
// Request Body
{
  "name": "珠海市第一中学",
  "shortName": "珠海一中",
  "themeColor": "#1a73e8",
  "logoUrl": "https://..."
}
// Response
{ "success": true, "data": { ...更新后的学校记录 } }
```

#### PUT /api/admin/schools/:code/customization
```json
// Request Body（整体覆盖）
{
  "visible_types": ["tableware", "pesticide", "oil", "leanMeat", "pathogen"],
  "field_labels": { "testDate": "检测日期", "canteen": "食堂" },
  "hidden_fields": ["sampler", "batchNo"],
  "field_rules": { "note": { "required": false, "maxLength": 200 } }
}
// 每个字段存为 JSON 字符串到 SchoolCustomization 表
```

#### GET /api/admin/schools/:code/users
```json
// Response（跨 schema 查询，用 createTenantClient 路由到 school_<code>）
{
  "success": true,
  "data": [
    { "id": "...", "username": "admin", "role": "admin", "is_active": true, "last_login": "..." }
  ]
}
```

## 5. 前端实现方案

### 5.1 文件结构
```
admin-schools.html          ← 重写为完整管理控制台
js/modules/SchoolAdminConsole.js  ← 新增：管理控制台逻辑模块
```

### 5.2 技术选型
- 纯原生 ES Module（与项目一致，无框架）
- 复用 `AuthService.js` 的 token 管理
- 复用液态玻璃样式（`.glass` / `.glass-dark` / `.glass-table`）
- 使用 `js/services/AuthService.js` 的 `getApiBaseUrl()`

### 5.3 主页导航入口
在 `index.html` 导航栏新增一个仅平台超管可见的菜单项：
```html
<a data-super-admin-only href="./admin-schools.html" class="nav-btn ...">
  <i class="fas fa-school"></i> 学校管理
</a>
```
`Router.js` 的 `applyPermissions()` 中新增：
```js
if (user.role === 'admin' && !user.schoolCode) {
  this.toggleElementByPermission('[data-super-admin-only]', true);
} else {
  this.toggleElementByPermission('[data-super-admin-only]', false);
}
```

## 6. 数据流

```
平台超管登录 (schoolCode=null)
  → 主页导航显示"学校管理"入口
  → 点击进入 admin-schools.html
  → GET /api/admin/schools 加载学校列表
  → 点击[管理]展开详情面板
    → GET /api/admin/schools/:code/customization 加载定制
    → GET /api/admin/schools/:code/users 加载用户
  → 编辑后 PUT 保存
  → 学校用户下次登录时自动应用新配置（ensureSchoolConfig 拉取最新）
```

## 7. 实施计划

| 阶段 | 内容 | 文件 |
|---|---|---|
| 1 | 后端 API 扩展 | `backend/server.js` |
| 2 | RBAC 权限注册 | `js/services/PermissionService.js` + `js/core/Router.js` |
| 3 | 重写管理控制台前端 | `admin-schools.html` + `js/modules/SchoolAdminConsole.js` |
| 4 | 主页导航入口 | `index.html` + `js/core/Router.js` |
| 5 | 测试验证 | 手动测试完整流程 |

## 8. 安全考量

- 所有学校管理 API 复用 `requirePlatformSuperAdmin`，学校 admin 无法越权
- 用户密码重置需要平台超管权限，不支持明文返回密码
- 学校代码创建后不可修改（避免 schema 路由断裂）
- 停用学校后该校用户无法登录（登录时检查 `school.status === 'active'`，已有）
