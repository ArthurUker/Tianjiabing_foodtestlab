# 学校定制功能 API 文档（customization-api）

> 适用分支：`feat/liquid-glass` ｜ 最后更新：2026-07-26

所有接口前缀 `/api`。除公开端点外，需 `Authorization: Bearer <token>`。

## 1. 获取学校定制配置（公开，限频）

```
GET /api/schools/:code/config
```

- 参数校验：`code` 须通过 `isValidSchoolCode`。
- 频率限制：`rateLimit(60, 60000)`（DS-04）。
- 返回：合并后的 `SchoolCustomization`（含 `visible_types` / `field_labels` / `hidden_fields` / `theme_config` / `field_rules` / `field_options` / `field_order` / `custom_fields` / `test_types`）。

## 2. 更新学校定制配置（管理端，乐观锁）

```
PUT /api/admin/schools/:code/customization
```

- 鉴权：`requirePlatformSuperAdmin`（DS-03，平台超管跨校操作 + 审计）。
- 请求体：白名单列（`CUSTOMIZATION_COLUMNS`）+ `expected_updated_at`（乐观锁基线）。
- 行为：服务端校验 `expected_updated_at` 与当前 `updated_at` 一致，否则返回 `409 Conflict`（BS-06）；成功写入并审计 `SystemLog`（BS-11）。
- 载荷校验：`validateCustomizationPayload`（原型链净化 D-06、JSON 深度≤6 / 体积≤200KB D-07、Logo 仅位图/非 SVG DS-12）。

## 3. 访客快速访问

```
POST /api/guest/quick-access
```

- 请求体：`{ "schoolCode": "<code>" }`（强制要求，RK23）。
- 返回：带 `role:'guest'` 与 `schoolCode` 的快速访问令牌，用于只读访客看板。

## 4. 认证 / 刷新

```
POST /api/auth/login        # { username, password, schoolCode? }
POST /api/auth/refresh      # { refreshToken } → 新 access token
```

- `refresh` 端点使用独立密钥 `JWT_REFRESH_SECRET`，并校验 `decoded.type === 'refresh'`，拒绝把 refresh 当 access 用（DS-01/02）。
- 用户不存在时执行假 `bcrypt.compare` 拉平枚举时间（DS-15）。

## 5. 检测记录写入（幂等）

```
POST /api/records/:tableName        # 旧路径，tableName 经 RECORD_ROUTE_TYPES 白名单校验（DS-07）
POST /api/test-records              # 新路径，覆盖幂等中间件 idempotencyMiddleware（CR-11）
```

- 记录载荷经 `buildRecordPayload` 净化（原型链 D-06、JSON 校验 D-07），`sample_info` / `result_data` 非空默认 `{}`（D-02）。
- `TestRecord.data_version` 标记业务数据版本（RK48）。
