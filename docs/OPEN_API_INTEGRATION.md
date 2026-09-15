# 开放接口对接文档（第三方只读数据拉取）

> 版本：v1（2026-09-15）｜适用对象：经平台超管开通授权的第三方系统（如朴食科技智慧食堂平台）
> 平台侧实现：`backend/routes/openApiRoutes.js`（对外）、`backend/routes/adminOpenApiRoutes.js`（超管配置）
> 内部说明见 [`README.md` §5.13](../README.md)

---

## 1. 概述

平台为**指定学校、指定范围**开放只读数据接口：第三方持 API Key 拉取该校的食品安全检测数据，写入己方数据库。

- **只读**：接口不提供任何写入能力；平台侧数据由学校使用者维护。
- **按校授权**：只能访问被授权的学校；未授权学校一律 `403`。
- **按类型授权**：`visible_types` 白名单内的检测类型可见；**病原体需显式开启**，默认不开放。
- **字段最小化**：内部字段与检测人姓名默认不下发；检测人姓名需在授权中显式开启。

### 1.1 接入前需向平台方确认

| 项目 | 说明 |
|---|---|
| 学校清单 | 需要拉取哪些学校（平台侧按 `school_code` 授权，如 `tjb`/`zhyz`/`zhsy`） |
| 检测类型 | 需要哪些类型（餐具 / 果蔬农残 / 食用油 / 肉蛋农残 / 病原体） |
| 检测人姓名 | 是否需要下发（默认不下发） |
| 业务日期范围 | 是否需要限定起止日期（按检测业务日期，非录入时间） |
| 出口 IP | 贵方调用方的公网出口 IP（可加入平台白名单） |
| 拉取频率 | 建议轮询频率（平台侧默认限流 60 次/分钟，可调整） |

平台侧完成后提供：**接口域名** + **API Key**（形如 `oap_xxxxxxxx...`，一次性展示）。

---

## 2. 认证

每次请求携带 API Key，二选一：

```http
X-API-Key: <你的 API Key>
```

```http
Authorization: Bearer <你的 API Key>
```

- 必须使用 **HTTPS**（`https://<平台域名>/api/open/v1/...`）。
- 密钥泄露风险由双方共担：请勿硬编码到前端、请勿写入日志；建议配置到环境变量/密钥管理。
- 平台支持**密钥轮换**：轮换期内新旧密钥同时有效，请在旧密钥到期前完成切换。

---

## 3. 接口清单

基址：`https://<平台域名>/api/open/v1`

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/ping` | 连通性自检 + 服务器时间（用于对账时钟） |
| GET | `/profile` | 当前密钥的授权范围（学校、类型、`scope_version`） |
| GET | `/schools` | 授权范围内的学校列表 |
| GET | `/dict?school_code=` | 字典：开放类型 / 食堂列表 / 结论枚举 |
| GET | `/sync/manifest?school_code=[&detail=1]` | 全量清单 `total` + `digest`；`detail=1` 附 `[{record_code, updated_at}]` |
| GET | `/test-records?school_code=&cursor=&limit=&since=&until=&test_type=` | 检测记录增量拉取（游标分页） |
| GET | `/stats?school_code=&start=&end=` | 合格率统计（对账用） |

响应统一为：成功 `{ "code": 0, "data": {...} }`；失败 `{ "code": "<错误码>", "error": "<说明>" }`。
所有时间字段为 **ISO8601 +08:00**（北京时间）。

---

## 4. 推荐同步流程

> 每轮同步即完成一次「新增 / 变更 / 删除」对账，无需额外定时任务。

```
① GET /sync/manifest?school_code=<校>            → 取 total + digest
   └─ digest 与本地记录的上次值一致 → 本轮无事可做，结束
② digest 变化 → GET /sync/manifest?...&detail=1  → 取全量清单 [{record_code, updated_at}]
   ├─ 清单有、本地无            → 新增：拉取该记录
   ├─ updated_at 比本地新        → 变更：重拉该记录
   └─ 本地有、清单无            → **已删除：删除本地该记录**（平台侧为硬删除）
③ 明细拉取：GET /test-records?school_code=<校>&cursor=<游标>&limit=100
   ├─ 响应含 next_cursor / has_more，循环拉取直至 has_more=false
   └─ 中断后带上次 cursor 续传即可（不重不漏）
④ 返回 409 SCOPE_CHANGED → 平台方调整了授权范围：回到第 ① 步重新对账
```

要点：

- 建议保存每校的 `scope_version`、`digest`、`cursor` 与本地的 `record_code → updated_at` 清单。
- 幂等键用 `record_code`（平台内唯一、跨次拉取稳定）；`record_id` 为平台内部 id，可一并保存但不用于业务判断。
- 平台侧记录为**硬删除（无回收站）**，删除只能通过清单比对感知，因此第 ② 步不可省略。

---

## 5. 接口详情

### 5.1 `GET /ping`

```json
{ "code": 0, "data": { "client_name": "朴食科技", "credential_label": "生产",
  "credential_prefix": "oap_12345678", "server_time": "2026-09-15T14:30:00+08:00" } }
```

### 5.2 `GET /profile`

```json
{ "code": 0, "data": {
  "client": { "name": "朴食科技", "rate_limit_per_min": 60 },
  "credential": { "label": "生产", "prefix": "oap_12345678", "last4": "a1b2", "expires_at": null },
  "grants": [ { "school_code": "tjb", "school_name": "珠海市田家炳中学", "status": "active",
    "scope_version": 3, "visible_types": ["tableware","pesticide","oil","leanMeat"],
    "include_pathogen": false, "include_inspector": false, "include_attachments": false,
    "start_date": null, "end_date": null } ],
  "server_time": "2026-09-15T14:30:00+08:00" } }
```

### 5.3 `GET /sync/manifest`

| 参数 | 必填 | 说明 |
|---|---|---|
| `school_code` | 是 | 学校代码 |
| `detail` | 否 | `1` 时返回 `items` 全量清单，否则仅 `total` + `digest` |

```json
{ "code": 0, "data": {
  "school_code": "tjb", "scope_version": 3, "total": 1109,
  "digest": "9f2c…", "items": [ { "record_code": "RC-tableware-…", "updated_at": "2026-09-14T11:05:00+08:00" } ],
  "server_time": "2026-09-15T14:30:00+08:00" } }
```

> `digest` = 对 `record_code@updated_at` 升序拼接后的 sha256 摘要：条数或任一条记录的更新时间变化都会改变摘要。

### 5.4 `GET /test-records`

| 参数 | 必填 | 说明 |
|---|---|---|
| `school_code` | 是 | 学校代码 |
| `cursor` | 否 | 上一页返回的 `next_cursor`；首次不传（从头开始） |
| `limit` | 否 | 每页条数，默认 100，上限 200 |
| `since` / `until` | 否 | 按**数据变更时间**（`updated_at`）过滤，ISO8601 |
| `test_type` | 否 | 仅拉某类型；不传 = 全部已开放类型 |

```json
{ "code": 0, "data": {
  "school_code": "tjb", "school_name": "珠海市田家炳中学", "scope_version": 3,
  "count": 100, "has_more": true, "next_cursor": "eyJ2Ijox…",
  "items": [ {
      "record_id": "cmt…", "record_code": "RC-tableware-07c2240b…",
      "school_code": "tjb", "school_name": "珠海市田家炳中学",
      "test_type": "tableware", "test_name": "餐具洁净度检测",
      "test_date": "2026-01-16", "canteen": "三食堂",
      "status": "completed",
      "initial_conclusion": "fail", "final_conclusion": "pass", "conclusion": "pass",
      "conclusion_text": "整改后复检合格", "conclusion_source": "stored", "is_positive": null,
      "result": { "result": "不合格 (>500)", "rlu": 614, "atpPoints": [ … ] },
      "created_at": "2026-01-16T00:00:00+08:00", "updated_at": "2026-09-14T11:05:00+08:00",
      "data_version": 1 } ],
  "server_time": "2026-09-15T14:30:00+08:00" } }
```

字段说明：

| 字段 | 说明 |
|---|---|
| `record_code` | **业务唯一键**，用于本地 upsert 与清单比对 |
| `test_date` | 检测业务日期（`YYYY-MM-DD`）；极少数历史脏数据可能为 `null`（**与结论无关**） |
| `canteen` | 食堂名称文本 |
| `inspector` | 检测人姓名——**仅授权开启时出现** |
| `initial_conclusion` | 初检结论：`pass` / `fail` / `warning` / `unknown` |
| `final_conclusion` | 复检后的最终结论（无复检时等于初检） |
| `conclusion` | 对外使用的结论 = `final_conclusion` |
| `conclusion_text` | 结论文本原文（如「整改后复检合格」「不合格 (>500)」） |
| `conclusion_source` | 固定为 `stored`：**记录内冻结值**（录入时按当时阈值产出），非实时重算 |
| `is_positive` | 仅病原体有值：`true` = 阳性，`false` = 阴性，`null` = 不适用/未判定 |
| `result` | 该类型的业务字段（已剔除内部字段与人名类字段）；各类型字段不同，见 `/dict` |
| `updated_at` | 数据变更时间（增量同步依据） |

### 5.5 `GET /stats`

按类型返回条数、合格数与合格率。口径与平台员工端看板一致：

- 餐具/果蔬/肉蛋：`result` 含「合格」且不含「不合格」；
- 食用油：优先看 `colorLevel`（无则回退 `result`）；
- 病原体：`riskLevel = '无风险'`。

> ⚠️ **对账差异说明**：本口径**排除 `test_date` 缺失/非法的记录**（现网约 1 条），
> 因此 `total` 可能与 `/test-records` 明细条数相差极少数；对账时以 `/stats` 为准，并把差异条数单独记录。

---

## 6. 错误码

| HTTP | code | 含义 | 处理建议 |
|---|---|---|---|
| 401 | `MISSING_KEY` | 未携带 API Key | 检查请求头 |
| 401 | `INVALID_KEY` | 密钥无效 | 核对密钥 |
| 401 | `CREDENTIAL_REVOKED` / `CREDENTIAL_EXPIRED` | 密钥已吊销/过期 | 联系平台方换发 |
| 403 | `CLIENT_DISABLED` | 对接方被停用 | 联系平台方 |
| 403 | `IP_DENIED` | 来源 IP 不在白名单 | 提供出口 IP 或联系平台方 |
| 403 | `SCHOOL_NOT_AUTHORIZED` | 该校未授权 | 联系平台方开通 |
| 403 | `TYPE_NOT_AUTHORIZED` | 该检测类型未授权 | 联系平台方开通 |
| 400 | `INVALID_CURSOR` / `CURSOR_SCHOOL_MISMATCH` | 游标非法/串用了他校游标 | 该校重新从头拉取 |
| 409 | `SCOPE_CHANGED` | 授权范围已变更 | 回到 `sync/manifest` 重新对账 |
| 429 | `RATE_LIMITED` | 触发限流 | 按 `Retry-After` 头退避重试 |
| 500 | `INTERNAL_ERROR` | 平台内部错误 | 稍后重试；持续报错请联系平台方 |

---

## 7. 常见问题

**Q1：为什么有些记录在明细里、但没进入统计？**
见 §5.5 对账差异说明：统计口径排除 `test_date` 缺失/非法的脏数据。

**Q2：如何感知删除？**
平台侧为硬删除。必须依赖 `sync/manifest` 全量清单比对：**本地有、清单无 = 已删除**。

**Q3：授权范围变了怎么办？**
调 `/test-records` 会返回 `409 SCOPE_CHANGED`；此时重新执行 §4 的第 ① 步对账即可，
扩容后新增类型的历史数据可通过清单 + 明细补齐。

**Q4：检测人姓名能不能给？**
可以，但默认关闭。姓名可能出现在记录的多个位置（含复检记录），平台侧统一按授权开关控制，
不会出现"顶层没有、嵌套里漏出"的情况。

**Q5：停用接口后，已经下载到我们库里的数据怎么办？**
接口只能阻止后续读取。范围收紧/停用时，请在双方约定的时限内清理本地对应数据（平台方会给出「待清理范围」清单）。

**Q6：拉取频率建议？**
建议每 5~30 分钟一轮：先 `manifest`（轻量），有变化再拉明细。默认限流 60 次/分钟，可协商调整。

---

## 8. 接入自检清单

- [ ] `GET /ping` 返回 200 且 `server_time` 与本机时钟偏差可接受
- [ ] `GET /profile` 的学校与类型范围与约定一致
- [ ] `GET /sync/manifest` 的 `total` 与平台方告知的条数一致
- [ ] 全量拉取一次：条数与 `manifest.total` 一致；`record_code` 无重复
- [ ] 增量拉取：`cursor` 翻页不重不漏；中断重连续传正常
- [ ] 未授权学校/类型请求被 `403` 拒绝（越权自检）
- [ ] 抽样 3~5 条（含**不合格**与**复检合格**各至少 1 条）与平台方人工核对字段与结论
- [ ] 删除对账演练：平台方删除一条测试记录后，贵方下一轮对账能识别并删除本地对应记录
