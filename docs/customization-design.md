# 学校定制功能设计文档（customization-design）

> 适用分支：`feat/liquid-glass` ｜ 最后更新：2026-07-26

本文说明田家炳食品检验系统的「学校定制功能」架构与数据流转，是 `school-customization-risk-plan.md` 的实施依据。

## 1. 多租户隔离

- 采用 **方案② Schema-per-tenant**：每个学校拥有独立 PostgreSQL schema `school_<code>`。
- 隔离核心：`backend/lib/tenantClient.js` 的 `createTenantClient(prisma, schoolCode)` 为每个 schema 缓存独立 `PrismaClient`（LRU + 每客户端连接上限）。Prisma 把 schema 硬编码进 SQL，故 `SET LOCAL search_path` 对 model 查询无效（仅裸 `$queryRaw` 生效）。
- 系统表 `School` / `SchoolCustomization` 位于 `public`，所有租户共享。
- schema 名归一：`schemaNameOf(code)` 将 `school-` 前缀归一为 `school_` 下划线；`isValidSchoolCode` 仅允许 `[a-z0-9-]`；`assertSafeSchemaName` 仅允许 `^school_[a-z0-9_]+$`（≤63 字符），拦截 `public`、注入等。

## 2. SchoolCustomization 表列

位于 `public`，关键列：

| 列 | 说明 |
|---|---|
| `visible_types` | JSON：对访客/师生可见的检测类型集合（驱动导航显隐，见 RK3/RK34） |
| `field_labels` | JSON：字段中文标签覆盖 |
| `hidden_fields` | JSON：被隐藏/停用的字段名数组（收集时不再提交，见 RK38） |
| `theme_config` | JSON：主题色、Logo、背景等（含 `custom_fields` 旧兼容嵌套） |
| `field_rules` | JSON：字段必填/只读等规则 |
| `field_options` | JSON：下拉选项定义 |
| `field_order` | JSON：字段顺序 |
| `section_titles` | JSON：分区标题（嵌套在 theme_config 内，见 RK47 拆分决策） |
| `custom_fields` | JSON：自定义字段定义数组 |
| `test_types` | JSON：层级B 自定义检测类型定义（见 RK32/RK34） |
| `updated_at` | 乐观锁基准（`PUT` 时校验 `expected_updated_at`，冲突返回 409，见 BS-06） |

> 设计决策（D-01）：`test_type` **不**加数据库级 CHECK 约束，改由应用层白名单（`TEST_TYPE_LABELS`）校验，避免新增类型需迁移。

## 3. 自定义字段流转

```
管理端配置 → SchoolCustomization.custom_fields
   ↓ injectCustomFields(formEl, customization, moduleCode)   // 注入表单
   ↓ 用户填写
   ↓ collectCustomFieldValues(formEl, customization)          // 收集（跳过 hidden_fields）
   ↓ 存入 TestRecord（JSON）
   ↓ isRecordQualifiedByCustomFields(record, customization, moduleCode)  // 合格率判定（统计角色 + 合格值/区间，见 RK21）
```

- 历史记录缺自定义字段时**不判不合格**（向后兼容，RK21）。
- 解析：`resolveCustomFields(customization, moduleCode)` 优先取顶层 `custom_fields`，回退 `theme_config.custom_fields`。

## 4. 统计规则（stat rules）

每个自定义字段可配置：

- `statRole`：`label`（仅展示）/ `result`（参与合格率）/ `ignore`
- `qualifiedValues`：视为合格的离散值集合
- `range`：合格数值区间 `[min, max]`

合格率 = 满足 `statRole='result'` 且值命中 `qualifiedValues`/区间 的字段数 / 参与字段总数（RK21 取 AND）。

## 5. visible_types 与导航

- `visible_types` 控制师生端/访客端模块导航的显隐（RK3/RK34）。
- 未配置时回退默认类型集合。
- 层级B（RK32/RK34）目标：所有检测类型经统一注册中心（`TEST_FORM_IDS` / `FORM_MODULE_MAP` / `MODULE_FIELDS`）声明，新增类型只需登记即自动出现在导航/表单/看板。

## 6. 层级B（test_types，待实现）

后端 schema / 校验 / 管理端数据通道（`test_types` 列、配置弹层 `#statPopover`）已就绪，前端录入与看板卡片待样板类型确定后实现。

## 7. 安全要点

- JWT：`HS256` 算法白名单；access / refresh 类型隔离 + 独立刷新密钥 `JWT_REFRESH_SECRET`（DS-01/02）。
- 导出报告对记录值做 HTML 转义，防 XSS（DS-13）。
- 反向代理（Caddy）设安全头 + 8MB 请求体上限（RK39）。
