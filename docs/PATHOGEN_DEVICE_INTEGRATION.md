# 病原体检测模块 · 设备自动采集对接方案（VirusHunter2.0B）

> 版本：v1.0（2026-10-14）　状态：设计定稿 + 代码实现
> 背景：病原体检测（食源性细菌/病毒）当前为**手动导入 Word 报告**（ mammoth 解析 .docx → 本地记录 → 同步服务端）。
> 本方案将其升级为**检测设备（VirusHunter2.0B）自动采集**：设备检测完成后主动推送 JSON，系统经统一上传接口
> 自动解析、按设备编号归属学校租户、落入该租户隔离空间，前端列表原样展示（手动导入保留为兜底）。

---

## 1. 总体流程（自动对接链路）

```
┌──────────────┐   ① 检测完成，生成报告 JSON    ┌─────────────────────────────┐
│ VirusHunter  │ ───────────────────────────▶ │ 本系统统一上传接口            │
│ 2.0B 设备    │   POST /api/open/pathogen-device/upload                    │
│ （每校 N 台）│   Header: X-API-Key: pdv_xxx（设备密钥）                    │
└──────────────┘   Body:   VirusHunter 协议字段 + DeviceNo                  └─────────┬───────────────────┘
                                                                                     │
        ┌────────────────────────────────────────────────────────────────────────────▼
        │ ② 接口校验层：密钥认证 → 设备号匹配 → 协议字段校验 → 租户冲突检查
        │ ③ 归属判定：设备密钥 → public.PathogenDevice → school_code（不信任报文中的任何租户信息）
        │ ④ 记录构建：协议字段 → 与手动导入同构的 pathogen 记录（三键 + 检测项 + 风险结论）
        │ ⑤ 幂等去重：record_code = RC-pathogen-sha1(设备号+样本编号)，重复上传返回既有报告
        │ ⑥ 落库：createTenantClient(school_code).testRecord.create（租户 schema 隔离）
        │ ⑦ 响应：{ code: 0, data: { reportId } }（reportId = record_code，供设备留存发送凭证）
        └────────────────────────────────────────────────────────────────────────────┬
                                                                                     ▼
                                                    学校员工端「病原体检测」列表 / 看板 / 导出
                                                    （前端经 /api/records/pathogen 同步，自动出现，
                                                      来源标记为「设备采集」，无需任何手工操作）
```

关键原则：

1. **设备只面对一个地址、一把钥匙**。设备不感知学校、租户、schema 等任何内部概念；
   学校归属完全由服务端持有的「设备编号 → 学校」映射决定（需求 7）。
2. **写入路径与手动导入同构**。自动采集记录与 Word 导入记录落在同一张 `TestRecord`（`test_type='pathogen'`）、
   同一租户 schema，前端展示/统计/导出/开放接口零改造即可覆盖设备数据。
3. **手动导入保留**作为无设备学校与异常兜底通道，不做删除。

---

## 2. 数据接口规范（对外仅一个上传接口）

### 2.1 端点与认证

| 项 | 值 |
|---|---|
| 方法 / 路径 | `POST /api/open/pathogen-device/upload` |
| 认证 | 请求头 `X-API-Key: pdv_<43位base64url>`（或 `Authorization: Bearer pdv_...`）。**两种模式（同一接口，任选其一）**：① **统一上传密钥（推荐，B 方案 2026-10-15 新增）**——全平台共用一把平台级密钥，归属完全由报文 `DeviceNo` 决定；② 设备密钥（严格模式）——每台设备独立密钥。库中仅存 sha256 哈希 |
| 内容类型 | `application/json`，请求体上限 2MB（荧光数组较大，但单次报告足够） |
| 传输 | 生产强制 HTTPS（Caddy 终止）；建议设备侧配置证书校验 |
| 限流 | 按设备 60 次/分钟（可配置），超限 429 + `Retry-After`；统一密钥另有平台级 600 次/分钟兜底 |

> **两种认证模式对照**：
> **统一上传密钥（推荐）**：控制台「病原体设备」页顶部创建，全平台设备共用。密钥只做准入，
> 归属**完全由报文 `DeviceNo`** 查「学校-设备编号」映射决定——设备必须先在学校登记
> （未登记 = 403 `DEVICE_NOT_REGISTERED`）。接入形态最简：一把钥匙 + 学校侧绑定设备编号。
> **设备密钥（可选，严格）**：每台设备一把密钥，报文 `DeviceNo` 必须与密钥所属设备一致
> （不一致 = 403 `DEVICE_MISMATCH`），密钥泄露爆炸半径限制在单设备/单校。
> 两种模式可并行使用；审计日志以 `auth_mode`（device / unified）区分来源。

### 2.2 请求体字段（VirusHunter2.0B 协议 + 设备编号）

| 字段 | 类型 | 必填 | 说明 | 示例 |
|---|---|---|---|---|
| `DeviceNo` | string | 是 | 检测设备编号，须与密钥所属设备一致 | `VH-2B-001` |
| `DetectionDateTime` | string | 是 | 开始检测时间 | `2026-09-17 08:30:00` |
| `DetectionEndDateTime` | string | 是 | 结束检测时间 | `2026-09-17 10:45:00` |
| `SampleStr` | string | 是 | 检测样品信息 | `黄鳍鲷 汤胜亮` |
| `DetectionPeopleStr` | string | 是 | 检测员姓名 | `张三` |
| `DetectionNumber` | string | 是 | 样本编号（幂等键组成部分） | `20260917001` |
| `FileName` | string | 是 | 报告文件名 | `20260917_0830_1045_黄鳍鲷 汤胜亮.vhfl` |
| `ChipID` | string | 否 | 芯片内部数据库编码 | `TS001` |
| `ChipName` | string | 是 | 芯片名称 | `四通道微流控芯片` |
| `ChipNumber` | string | 是 | 芯片唯一识别码 | `SN20260917001` |
| `Parms` | object | 是 | 点位名称字典 `{通道-序号: 靶标名}` | `{"FAM-1":"ORF1ab","HEX-1":"内参"}` |
| `OptimizationDataLists` | object | 是 | 点位荧光数据集合 | `{"FAM-1":[0.12,0.45,...]}` |
| `ResultList` | object | 是 | 点位判读结果 `true=阳性` | `{"FAM-1":true,"FAM-2":false}` |
| `CTList` | object | 是 | 点位 CT 值，未检出为 `-` | `{"FAM-1":"25.3","FAM-2":"-"}` |

点位标识格式：`通道-序号`，通道 ∈ {FAM, HEX, ROX, CY5}，序号 1~8；字典只需包含本次实际使用的点位。
时间格式同时兼容 `YYYY-MM-DD HH:mm:ss` 与 ISO 8601（`YYYY-MM-DDTHH:mm:ss`）。

### 2.3 响应体

```jsonc
// 成功（200）
{ "code": 0, "message": "success", "data": { "reportId": "RC-pathogen-<hash>" } }

// 重复上传（200，幂等）
{ "code": 0, "message": "success", "data": { "reportId": "RC-pathogen-<hash>", "duplicated": true } }

// 失败（4xx/5xx，message 为设备可读的中文原因）
{ "code": 400, "message": "参数校验失败：DetectionNumber不能为空", "data": null }
```

`reportId` 即服务端记录编码（`TestRecord.record_code`），设备应留存以自查发送结果；
重复上传同一 `DeviceNo + DetectionNumber` 返回同一 `reportId` 且 `duplicated:true`，不产生第二条记录。

---

## 3. 多租户隔离下的数据归属判断

### 3.1 映射模型（public schema，平台级配置）

```
public.PathogenDevice（权威副本，prisma migrate 管理；应用层只用基础 prisma 单例读写）
├── device_no        设备编号（全局唯一，上传报文携带）
├── school_code      归属学校代码（= schema 名 school_<code>）
├── binding_user_id  记录创建人（该校租户内一名 editor 及以上用户；外键在租户 schema，应用层校验）
├── default_canteen  默认食堂（SampleStr 无法匹配食堂名单时回落）
├── status           active / disabled
├── key_hash / key_prefix / key_last4   设备密钥（sha256，明文仅创建时返回一次）
├── rate_limit_per_min / ip_whitelist    限流与来源限制（可选）
└── last_used_at / upload_count / last_upload_at   运行统计
```

- 同一学校可配置多台设备；一台设备只归属一所学校（`device_no` 全局唯一）。
- **备份注意**：与 `OpenApi*` / `FriendlyLink` 同模式——public 段不参与租户备份恢复，
  设备配置须靠「超管导出 JSON」留档（导入接口按 id upsert，用于重建/迁移）。

### 3.2 归属判定链（fail-closed，任一步失败即拒绝且不泄露内部信息）

1. 提取 `X-API-Key` → sha256 查 `PathogenDevice`；不存在/已停用/已吊销 → 401/403；
2. 取 `school_code` → 校验 `public.School` 存在且 `status='active'`（世代 generation 无需参与，
   设备映射随学校硬删即失效，重新配置才恢复）；
3. 报文 `DeviceNo` 必须等于设备行的 `device_no`，否则 403 `DEVICE_MISMATCH`（租户冲突防护）；
4. 报文中出现的任何 `school_code` / `schoolCode` / `tenant` 等字段一律**忽略并剥离**，
   绝不作为归属依据（需求 7：接口不暴露租户信息）；
5. 用 `createTenantClient(prisma, school_code)` 获得该租户专属 PrismaClient，
   以 `binding_user_id` 为 `created_by` 写入 `TestRecord`——物理 schema 隔离，无跨租户竞态。

---

## 4. 系统设置中的设备编号配置（CRUD）

超管控制台（`admin-schools.html`）学校管理 → 学校配置组新增子视图 **「病原体设备」**
（前端 `views/pathogenDeviceView.js`，后端 `/api/admin/pathogen-devices`，`authenticateUser + requirePlatformSuperAdmin`）：

| 操作 | 端点 | 说明 |
|---|---|---|
| 查询 | `GET /api/admin/pathogen-devices?school_code=` | 按学校过滤列表；不含明文密钥 |
| 新增 | `POST /api/admin/pathogen-devices` | `device_no` 全局唯一校验；`school_code` 必须存在且启用；`binding_user_id` 必须存在于该校租户；`default_canteen` 须在该校食堂名单内；响应**仅此一次**返回明文密钥 |
| 修改 | `PATCH /api/admin/pathogen-devices/:id` | 名称 / 备注 / 默认食堂 / 绑定用户 / 限流 / IP 白名单 / 启停；`device_no` 与 `school_code` 不可变更（变更 = 删旧建新，保证映射稳定） |
| 删除 | `DELETE /api/admin/pathogen-devices/:id` | 物理删除；已上传记录不受影响（记录内已固化 device_no 快照） |
| 轮换密钥 | `POST /api/admin/pathogen-devices/:id/rotate-key` | 生成新密钥并立即失效旧密钥（明文同样只返回一次） |
| 导出 / 导入 | `GET /api/admin/pathogen-devices/export`、`POST .../import` | 灾后重建 / 迁移（含 key_hash，不含明文；export 含 `platform_key` 最新一行） |

**统一上传密钥管理（B 方案，2026-10-15）**——同视图顶部卡片，端点 `/api/admin/pathogen-devices/platform-key`：

| 操作 | 端点 | 说明 |
|---|---|---|
| 查询 | `GET .../platform-key` | 当前最新一行（单活）的 status / prefix / last4 / 最近使用；**不含 key_hash** |
| 创建 / 轮换 | `POST .../platform-key` | 同一事务内停用全部 active 行 + 插入新行；明文**仅此一次**返回；响应带 `rotated` 标记 |
| 停用 / 启用 | `PATCH .../platform-key` | `{status: 'active'|'disabled'}`；停用后统一密钥上传全部 401（每设备密钥模式不受影响） |

所有变更写 `writeAdminOpsLog`（public.SystemLog，`[admin-audit]` 前缀）审计。
> 说明：学校 manager 自助配置本校设备的入口（`/api/school/pathogen-devices`，以 token 中
> schoolCode 为作用域）与本方案同构，可作为后续迭代；v1 由平台超管统一配置，与 OpenApi 授权同口径。

---

## 5. 异常处理场景与策略

| 场景 | 判定 | HTTP | code | 处理策略 |
|---|---|---|---|---|
| 未携带密钥 | 无 `X-API-Key` | 401 | `MISSING_KEY` | 拒绝并提示携带方式；拒绝事件按 IP+原因 60s 节流写 SystemLog |
| 密钥无效/已吊销/已过期 | 哈希不命中或状态异常 | 401 | `INVALID_KEY` / `CREDENTIAL_REVOKED` | 拒绝；引导超管在控制台重新签发/轮换 |
| **设备编号未配置** | 密钥存在但设备行 `status='disabled'`，或学校已删 | 403 / 409 | `DEVICE_DISABLED` / `SCHOOL_NOT_FOUND` | 拒绝；控制台可见设备状态，超管启用或重新配置 |
| **报文 DeviceNo 与密钥设备不一致**（冒用/租户冲突） | `DeviceNo != device_no` | 403 | `DEVICE_MISMATCH` | 拒绝并告警日志（同一密钥多次 mismatch 提示可能泄露） |
| **数据格式错误** | 必填缺失/类型错误/点位字典结构非法/时间不可解析 | 400 | `VALIDATION_ERROR` | message 指明首个错误字段（对齐厂商文档示例口径）；设备修正后重传，**不落库** |
| **重复上传** | 同 `DeviceNo+DetectionNumber` 已存在 | 200 | 0 | 幂等返回既有 `reportId` + `duplicated:true`；设备侧按 reportId 自查，无需人工介入 |
| 并发重复（P2002） | 唯一索引冲突 | 200 | 0 | 捕获后按既有记录幂等返回（与手动写入同策略） |
| 绑定用户失效 | `binding_user_id` 在租户内不存在/已删 | 422 | `BINDING_USER_MISSING` | 拒绝；超管在控制台改绑（记录不留孤儿 created_by） |
| 学校无食堂配置且 SampleStr 无法识别 | 三键之 canteen 缺失 | 422 | `CANTEEN_UNRESOLVED` | 拒绝并提示配置默认食堂；**绝不写入「未知食堂」**污染看板分组 |
| 请求体超限 / 非法 JSON | >2MB 或解析失败 | 400 / 413 | `BODY_TOO_LARGE` / `INVALID_JSON` | 拒绝；不进入业务逻辑 |
| 限流 | 超 60 次/分钟 | 429 | `RATE_LIMITED` | `Retry-After` 头；设备应本地队列退避重试 |
| 服务端异常（DB 抖动等） | 未分类异常 | 500 | `INTERNAL_ERROR` | 通用文案不泄露细节；记 SystemLog；设备按退避重试，**不得**判为成功 |

通用约定：所有拒绝均为 fail-closed；响应结构统一 `{code, message, data}`；设备可据此做
「可重试（429/500）」与「不可重试（4xx 参数/归属类）」分类处理。

---

## 6. 对接后的数据流转逻辑

```
设备自动上传
   │
   ▼
① 接口校验（密钥 → 设备 → 学校存在性 → DeviceNo 一致性 → 协议字段）
   │
   ▼
② 设备编号匹配租户（device_no → school_code；报文中任何租户信息一律剥离忽略）
   │
   ▼
③ 记录构建（与手动导入同构）：
     testDate  = DetectionDateTime 取日期（YYYY-MM-DD，业务日期口径）
     sampleId  = DetectionNumber
     canteen   = SampleStr 模糊匹配该校食堂名单 → 未命中回落设备 default_canteen
     inspector = DetectionPeopleStr
     allTestItems ← Parms × ResultList × CTList（含内参识别；result: true→阳性/false→阴性）
     positiveItems / positiveDetails / riskLevel / riskReason ← 风险算法（与前端同规则：Ct<20 高、20~30 中、30~35 低、≥35 极低；内参不计阳性）
     result_data 另存 source='device'、deviceNo、chip 信息、FileName、原始协议快照（荧光数组截断保留前 64 点，防 JSON 膨胀）
   │
   ▼
④ 数据存储至对应租户隔离空间（school_<code> schema 的 TestRecord；created_by = 设备绑定用户）
   │
   ▼
⑤ 前端展示替换手动导入数据：
     - 员工端「病原体检测」列表由 /api/records/pathogen 同步，设备记录自动出现（来源徽标「设备」）；
     - 看板 / 检测频率月报 / 导出 / 开放接口（grant 显式开启 includePathogen 时）自动覆盖；
     - Word 手动导入降级为兜底通道，导入卡片提示「已接入设备自动采集」。
```

---

## 7. 租户隔离与接口暴露面核对清单

- [x] 上传接口**不接收、不信任**任何租户标识（school_code/tenant/schoolId 一律剥离忽略）；
- [x] 归属唯一依据 = 设备密钥 → `PathogenDevice.school_code`（public 表，平台级配置）；
- [x] 写入使用 `createTenantClient(school_code)` 专属 PrismaClient（schema-per-tenant），物理隔离；
- [x] `device_no` 全局唯一 + `DeviceNo` 与密钥强绑定，杜绝跨校冒用；
- [x] 设备密钥 sha256 单哈希存储、明文仅创建/轮换时返回一次、可即时吊销；
- [x] 按设备限流 + IP 白名单（可选）+ 拒绝事件节流落日志；
- [x] 学校删除/停用 → 该校区设备上传立即失效（409/403），不产生孤儿数据；
- [x] public 配置表不进租户备份 → 提供导出/导入留档（灾后重建路径明确）；
- [x] 手动导入路径权限模型不变（records:create），设备路径与人类 JWT 体系完全解耦。

---

## 8. 代码落点（实现索引）

| 层 | 文件 | 职责 |
|---|---|---|
| 模型 | `backend/prisma/schema.prisma` → `PathogenDevice` | public 权威副本 |
| 模型 | `backend/prisma/schema.prisma` → `PathogenUploadKey` | 统一上传密钥（B 方案，public 权威副本，单活语义） |
| 迁移 | `backend/prisma/migrations/20261014120000_pathogen_devices/`、`20261015120000_pathogen_upload_key/` | public 建表 + 租户空表对齐；`lib/tenantProvisioner.js` 注册表登记 checksum |
| 领域逻辑 | `backend/lib/pathogenDevice.js` | 协议校验/归一、设备密钥、协议→记录映射、风险计算、食堂匹配 |
| 路由 | `backend/routes/pathogenDeviceRoutes.js` | 设备上传（免 JWT；设备密钥/统一上传密钥双模式）+ 超管 CRUD 与统一密钥管理（JWT+超管） |
| 挂载 | `backend/server.js` | `/api/open/pathogen-device`、`/api/admin/pathogen-devices`（位于 recognitionRoutes 兜底之前） |
| 前端配置 | `frontend/js/modules/adminSchools/views/pathogenDeviceView.js` + `pages/admin-schools.html` | 学校配置子视图「病原体设备」；含「接口使用指导」弹层与 Markdown 下载（`GUIDE_MD` 为界面/下载唯一事实源，域名占位符渲染时替换为当前站点） |
| 前端展示 | `frontend/js/modules/Pathogen.js` | 导入卡片提示 + 设备来源徽标；`window.PATHOGEN_MANUAL_IMPORT` 开关控制手动导入显隐 |
| 测试 | `backend/tests/pathogen-device/*.unit.test.mjs` | 校验/归属/映射/幂等/CRUD 路由级用例（无 DB） |

> 补充实现说明（2026-10-14 上线后增量）：① `server.js` 为上传路径增加了 body 超限（2MB）错误中间件，
> 将 body-parser 的 `entity.too.large` 转为厂商口径 413 `PAYLOAD_TOO_LARGE`（否则落全局处理器变成无信息量 500）；
> ② 前端伺服目录为 `dist/`（Caddy root），源码改动须同步拷贝进 dist 才生效（见 §9.1 步骤 1b）；
> ③ 「接口使用指导」渲染器 `renderMdBlocks` 曾因普通文本分支漏 `i++` 导致死循环（点击指导按钮页面卡死），
> 已修复并由 `tests/frontend/pathogenGuide.test.js`（仓库首个前端 jest 套件）锁定回归。
> ④ ⚠️ **tailwind CSS 是预编译产物**（`frontend/css/tailwind.css`，JIT 按 content globs 扫描源码生成，
> `npm run build:css` 重建后经 `build-static.js` 拷入 dist）：**源码里新写的 utility 类（尤其任意值类
> 如 `max-h-[88vh]`/`max-w-4xl`）若未重建 CSS，页面上完全不生效**——曾导致指导弹层无高度约束被内容撑爆、
> 既不能滚动也点不到按钮。新增类目后必须：`npm run build:css` → 拷 `frontend/css/tailwind.css` 进 `dist/css/`。
> 另修正了 `npm run build` 的执行顺序（原为 build-static 先于 build:css，会把旧 CSS 拷进 dist，已改为 CSS 在前）。

---

## 9. 部署与回退 runbook（变更窗口执行）

> 开发/验证基线：数据盘副本 `foodsentinel-review/run01-work/foodsentinel`（与生产同 commit，
> 测试 82/83 绿——唯一失败为需 `BASELINE_PROOF_TEST_DATABASE_URL` 的预存集成用例）。
> ⚠️ **2026-10-14 事故教训**：门禁按**工作树**校验。迁移文件进了链但 DB 未应用 → 全局 503；
> schema.prisma 有模型但租户缺表 → 逐校 503。因此下列 1~5 步必须在**同一窗口内连续完成**，
> 严禁提前把文件放进生产树后拖到次日。

### 9.1 窗口步骤（按序，每步可验证）

| # | 动作 | 验证 |
|---|---|---|
| 1 | 从副本同步功能文件进生产工作树：`backend/routes/pathogenDeviceRoutes.js`、`backend/lib/pathogenDevice.js`、`backend/tests/pathogen-device/`、`backend/prisma/migrations/20261014120000_pathogen_devices/`、`backend/prisma/migrations/20261015120000_pathogen_upload_key/`、`backend/prisma/schema.prisma`（含两个模型）、`backend/lib/tenantProvisioner.js`、`backend/server.js`、`frontend/js/modules/adminSchools/views/pathogenDeviceView.js`、`frontend/pages/admin-schools.html`、`frontend/pages/index.html`、`frontend/js/modules/Pathogen.js`、`backend/tests/tenant-sync/`（5 个链位次用例）、`docs/PATHOGEN_DEVICE_INTEGRATION.md`、`docs/README.md` | `git status` 与预期清单一致 |
| 1b | ⚠️ **前端伺服的是 `dist/` 构建产物，不是 `frontend/` 源码**（Caddy `root * /opt/foodsentinel/dist`；dist 与源码为逐字节拷贝关系、被 git 忽略）。源码改动必须同步进 dist 才生效：`cp frontend/pages/admin-schools.html dist/admin-schools.html`、`cp frontend/pages/index.html dist/index.html`、`cp frontend/js/modules/Pathogen.js dist/js/modules/Pathogen.js`、`cp frontend/js/modules/adminSchools/views/pathogenDeviceView.js dist/js/modules/adminSchools/views/`（CSS 未改动，无需重建 tailwind） | `curl -s https://<域名>/admin-schools.html \| grep 病原体设备` 有命中；用户侧需硬刷新（Ctrl+Shift+R）绕过浏览器缓存 |
| 2 | `cd backend && npx prisma generate` | `prisma.pathogenDevice` delegate 存在 |
| 3 | `npx prisma migrate deploy` | `_prisma_migrations` 新增 1 行 finished |
| 4 | `npm run db:sync`（逐租户回放：各 schema 建同名空表 + 台账） | 退出码 0；日志 `succeeded/total` 相等 |
| 5 | 等门禁复检（≤60s，无需重启） | `curl 127.0.0.1:3002/api/health` → `ready:true`、`status:OK`、`globalBlockers:[]`、`blockedSchools:[]` |
| 6 | `systemctl restart foodsentinel-api` | 启动日志无 import 错误 |
| 7 | 冒烟：无密钥上传 → 401 `MISSING_KEY`；超管在控制台「病原体设备」新增一台测试设备 → 返回明文密钥一次 | 密钥仅出现一次；列表不显示哈希 |

### 9.2 回退（按窗口进度分三种，**严禁混用**）

- **A. 失败于步骤 3（migrate deploy）之前**——文件已同步但迁移未应用：直接还原生产树（`git checkout --` 全部改动文件 + 移走迁移目录）→ `npx prisma generate` → 重启 → 门禁恢复 OK。此时无设备、无业务数据，零数据损失。
- **B. migrate deploy 已成功（步骤 3 之后）**——⚠️ **不要**移走迁移文件或回退 schema.prisma：台账已有该迁移记录而链上无文件 = `MIGRATION_LEDGER_UNKNOWN_ENTRY`（阻断）；public 有表而 schema 无模型 = `PUBLIC_EXTRA_OBJECTS`（阻断）。正确回退 = **保留迁移 + schema + 表**（链/账/模型保持一致，门禁 OK），仅撤代码（`server.js` 摘除两处挂载）并重启；若不再需要该功能，**不接入设备即为事实回退**（功能惰性，无写入方）。
- **C. 确需撤表**（仅当表本身有问题的极少数场景）：`DROP TABLE public."PathogenDevice"` + 删除 `_prisma_migrations` 对应行 + 逐租户 DROP 同名空表，全部完成后门禁复检 OK。此为破坏性操作，需人工确认后执行。

### 9.3 上线前置确认（窗口前完成，不阻塞开发）

**厂商侧（VirusHunter2.0B）**
- [ ] 认证头口径确认（`X-API-Key` 与 `Authorization: Bearer` 实现均支持）
- [ ] 报文字段名/日期格式与对接文档逐字一致（`YYYY-MM-DD HH:mm:ss`，兼容器 ISO `T` 格式）
- [ ] 失败重试策略对齐：`code:0` 成功；4xx 修数据不重试；409/422 人工处置；5xx 退避重试
- [ ] 设备出口 IP（配 `ip_whitelist`）与 TLS 经 Caddy 443 的可达性

**学校侧（每所启用学校）**
- [ ] 绑定用户：该校一名 editor+ 有效账号（记录的 `created_by` / 审计归属）
- [ ] 默认食堂：该校食堂名单内的一项（`SampleStr` 识别不到时回落，避免 422）
- [ ] 设备编号台账：厂商序列号 → 本校设备编号的映射登记

**联调**
- [ ] 副本内用 `tests/pathogen-device` 的报文样例做模拟推送全链路联调
- [ ] 生产窗口内首台设备试推（试推记录带「设备」徽标，可辨识、可清理）

### 9.4 后续整改（不阻塞本功能）

- **FCR-146（P2）**：门禁判据改取「发布态」（已部署清单/流水线产物）而非工作树，根治「未提交改动击穿生产」。

---

## 10. 手动导入的下线路径（并行 → 隐藏）

**现阶段（并行期，默认）**：手动导入与设备自动采集同时可用。前端开关
`frontend/pages/index.html` 病原体 section 内 `window.PATHOGEN_MANUAL_IMPORT = true`：

| 值 | 效果 |
|---|---|
| `true`（默认） | 导入卡片 + 「同时支持手动导入」提示行显示；设备采集数据照常入列表 |
| `false` | 上述两项隐藏（`hidden` 属性）；列表/详情/设备徽标不受影响；**服务端导入能力保留**（兜底，不发版即可恢复） |

**操作方式**：前端为静态文件（Caddy 直接伺服），改这一个布尔值后刷新即生效——**无需重启服务、无需变更窗口**。建议隐藏时机：设备采集在目标学校稳定运行 ≥2 周且无 422/归属异常后，逐校推进（开关为全站统一，如需按学校差异化再评估配置化方案）。

## 11. 试点方案：测试学校（test）上线测试

测试学校（code=`test`，食堂名单：一食堂/二食堂/三食堂，pathogen 模块可见）无真实用户，是**零风险的首个生产验证对象**。窗口（§9.1）完成后执行：

1. 控制台「病原体设备」→ 选择**测试**学校 → 新增设备：
   - 设备编号：`VH-2B-TEST-01`（全局唯一，后续不可改）
   - 绑定用户：测试学校内一名有效账号（记录的 `created_by`/审计归属；控制台下拉可选）
   - 默认食堂：`一食堂`（`SampleStr` 识别不到时回落）
   - 保存后**明文密钥仅此一次展示**，立即抄录
2. 模拟设备推送（用抄录的密钥，等价于设备行为）：
   ```bash
   curl -X POST https://<域名>/api/open/pathogen-device/upload \
     -H "X-API-Key: <密钥>" -H "Content-Type: application/json" \
     -d @tests/pathogen-device 用例中的合法报文（DeviceNo=VH-2B-TEST-01，SampleStr 含「二食堂」）
   ```
   预期：`{"code":0,"message":"success","data":{"reportId":"RC-pathogen-..."}}`
3. 验证矩阵：
   - 测试学校「病原体检测」列表出现该记录，样本ID 旁有**「设备」徽标**，食堂=二食堂、检测员=绑定用户
   - **重复推送同一 DetectionNumber** → `duplicated:true`，列表不出现第二条
   - 无密钥 → 401；错误 DeviceNo → 403（`DEVICE_MISMATCH`）；缺字段 → 400 带中文原因
   - 控制台设备行：上传次数 +1、最近上传时间更新
4. 试点稳定后，按学校推进正式接入（每校：绑定用户 + 默认食堂 + 设备编号台账 + 出口 IP 白名单）。

---

## 12. 芯片编号语义与复测轮次（2026-10-15 与产品确认）

**重复判定以「芯片编号」为准**（不再以 设备编号+报告编号 为准）：一张芯片只产生一组数据，且只在芯片测试完成后上传。

| 场景 | 系统行为 |
|---|---|
| 同芯片 + 内容一致（内容指纹相同） | **幂等放行**：返回既有 `reportId` 与 `duplicated:true`，不产生新记录 |
| 同芯片 + 内容不一致 | **HTTP 409 `CHIP_REVIEW_REQUIRED`**「芯片编号重复，请人工复核」；在既有记录上追加 `reviewFlags`（仅标记，**不改动检测数据**）；前端列表显示「待复核」徽标、详情弹层显示红色复核横幅。第二张同编号芯片数据按产品口径走**人工上传导出报告** |
| 同档案 + 不同芯片 | **并入为复测轮次**：`recheckReports` 追加一条（`roundNo` 递增、`roundLabel` = 「初检 / 第 N 次检测（复测）」），**检测次数 +1**；结论以最新轮次为准（`finalStatus` = 复检通过 / 复检{风险}），与手动复检既有显示口径一致 |
| 不同档案 | 新建独立记录（`record_code = chipRecordCode(芯片编号)`） |

**档案键**：`食堂 || 样本类型 || 归一化样本描述 || **样本编号（DetectionNumber）** || 设备编号`，
且两次**检测日期相差 ≤ `CASE_WINDOW_DAYS`（当前 7）天**。
- ⚠️ **2026-10-16 修正**：档案键必须纳入**样本编号**——「同一个样本」的身份以样本编号为准。
  不含样本编号时，同食堂、同样本描述、同日、同设备的两份**不同样本**会被误并为同一档案的复测轮次
  （实测已发生：真实上传被既有档案吸收）。修复后：同样本编号 + 新芯片 = 复测；样本编号不同 = 各自独立记录。
- 检测员**不纳入键**（复测可能换人，且换人需在结果上体现：轮次记录本人检测员 + `inspectorChanged`/`prevInspector`）
- 时间窗避免把该食堂每轮常规抽检并入同一档案；检索实现：按「食堂 + 样本类型」取最近 20 条候选，
  逐条按档案键 + 时间窗精确比对（取最近一条命中）
- 轮次展示：设备轮次卡片额外显示**芯片编号 / 检测时段 / 上传时间**，用于区分第一轮与复测

**内容指纹**：`sha256(点位+判读+CT+检测时段+样本描述+检测员)`，落库于 `result_data.contentFingerprint`（历史记录缺失时由 `fingerprintOfStoredRecord` 从原始快照重算）。

**待产品确认的两个默认值**：① `CASE_WINDOW_DAYS = 7`；② 档案键不含检测员。二者调整均为 `lib/pathogenDevice.js` 内单点修改。

---

## 13. 设备绑定台账（时间区间，2026-10-16）

**绑定 = 学校 × 设备编号 × [valid_from, valid_to)**；`valid_to` 为空 = 当前在用。

| 操作 / 场景 | 行为 |
|---|---|
| 新增设备 | 可指定生效日期（默认当天，支持补录历史）；校验「该编号无在用绑定」且区间不重叠 |
| **变更编号**（设备故障换替代设备） | 同一事务：旧绑定写 `valid_to = 生效日` + 新绑定 `valid_from = 生效日`（继承运维配置、签发新密钥、返回一次明文）；历史行**永久保留** |
| 结束绑定（报废/退租） | 只写 `valid_to`，不新增设备 |
| 上报归属 | 按**报文检测时间**匹配绑定区间：命中哪条就归哪所学校（与密钥模式无关） |
| 已结束绑定的补传 | 检测时间落在其区间内 → **仍允许入库**（设备离线/网络延迟不丢数据） |
| 区间外 | 403 `DEVICE_BINDING_EXPIRED`，响应附「检测时间 + 该编号全部绑定区间」便于定位 |
| 设备密钥与绑定不一致 | 403 `DEVICE_BINDING_EXPIRED`（提示使用当前设备密钥） |
| 多设备并存 | 同一学校可有多条在用绑定（唯一性只约束「同一编号至多一条在用」） |
| 跨校流转 | 允许：A 校结束 → B 校启用，区间不重叠，历史各自可查 |

**约束变更**：`PathogenDevice.device_no` 去掉全局唯一，改为**部分唯一索引**（`WHERE valid_to IS NULL`）；
区间不重叠由应用层在写入/变更时校验。迁移链第 20 号 `20261016120000_pathogen_device_bindings`（`@scope: both`，不新增表）。

**控制台**：设备列表新增「绑定期间」列（`起 ~ 止` / `起 ~ 至今`）与台账状态（**在用 / 已结束 / 已停用**）、
「仅看在用」筛选、行内「变更编号」「结束绑定」动作；「变更编号」弹层可填新编号 + 生效日期，提交后返回新密钥一次。

**实测**（2026-10-16）：旧绑定区间内补传 → 200 入库；区间外 → 403 并列出区间；新设备上报 → 200。

