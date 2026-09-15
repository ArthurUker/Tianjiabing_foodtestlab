# 开放接口对接文档（第三方只读数据拉取）

> 契约版本：**v1**（`contract_version: "v1"`，所有响应都会带上）
> 最后更新：2026-09-15
> 平台侧实现：`backend/routes/openApiRoutes.js`（对外）、`backend/routes/adminOpenApiRoutes.js`（超管配置）
> 字段契约单一事实源：`backend/lib/openApiFieldSchema.js`；超管控制台「开放接口」页可在线查看字段字典与样例、并下载**接入包**

---

## 0. 契约承诺与兼容性

- **v1 内不删除字段、不改变既有字段语义**；新增字段一律以向后兼容方式追加。
- 需要破坏性变更时，会先发布新版本路径（如 `/v2`），并提前通知；旧版本在过渡期内继续可用。
- 本文件与平台实际行为不一致时，**以平台在线响应（`/dict`、`/samples`、`/profile`）为准**，并请通知平台方修正文档。

### v1 内的行为修正（2026-09-15，均在 v1 内完成，已通知影响面）

| 项 | 变更 | 兼容性影响 |
|---|---|---|
| 食用油结论 | `conclusion` 改为按平台业务口径判定（`colorLevel` 仅「不合格」判不合格，其余等级视为合格；无 `colorLevel` 回退 `result`），与 `/stats` 完全一致 | 少数食用油记录的 `conclusion` 由 `unknown` 变为 `pass`；字段本身与取值枚举未变 |
| 增量游标 | 游标升级为 v2：额外绑定**筛选条件指纹**与**投影策略指纹** | 旧游标请求会返回 `409 SCOPE_CHANGED`，需重新对账（对接初期无影响） |
| 清单摘要 `digest` | 组成改为「游标协议版本 + `scope_version` + `projection_fingerprint` + 各记录 `record_code@updated_at`」 | 同样的数据 digest 值会与旧版不同；语义更强（字段可见性变化也能被感知） |
| 清单超限 | 超过单次上限时返回 `413 MANIFEST_TOO_LARGE`，**不再可能返回被截断的清单** | 之前不存在静默截断，此处仅把行为显式化 |
| 统计 | 新增 `scope_total / included_total / excluded / pass_rate_detail`；移除含糊的差异说明 | 既有字段 `total / pass_count / pass_rate` 含义不变 |

---

## 1. 认证

每次请求携带 API Key，二选一：

```http
X-API-Key: <你的 API Key>
```

```http
Authorization: Bearer <你的 API Key>
```

- 必须 HTTPS；基址：`https://<平台域名>/api/open/v1`
- 默认限流 **60 次/分钟**（超限 `429` + `Retry-After` 头，请退避重试）
- 支持 IP 白名单（由平台方配置）；支持密钥到期与吊销；轮换期内新旧密钥可同时有效

---

## 2. 接口清单

| 方法 | 路径 | 用途 |
|---|---|---|
| GET | `/ping` | 连通性 + 服务器时间（对账时钟） |
| GET | `/profile` | 当前密钥的授权范围（含 `scope_version`、`projection_fingerprint`） |
| GET | `/schools` | 授权学校列表 |
| GET | `/dict?school_code=` | 字典：类型、食堂、结论枚举、**字段字典** |
| GET | `/samples?school_code=[&test_type=]` | **合成样例**（非真实数据） |
| GET | `/sync/manifest?school_code=[&detail=1]` | 全量清单：`total` + `digest`（`detail=1` 附明细） |
| GET | `/test-records?school_code=&cursor=&limit=&test_type=&since=&until=` | 检测记录增量拉取 |
| GET | `/stats?school_code=&start=&end=` | 合格率统计（含排除原因） |

统一响应：成功 `{ "code": 0, "data": {...} }`；失败 `{ "code": "<错误码>", "error": "<说明>" }`。
所有时间字段为 ISO8601（`+08:00`）。所有响应均带 `contract_version`。

---

## 3. 先做三件事：确认范围、拿字段字典、拿样例

```bash
KEY="<你的密钥>"; BASE="https://<平台域名>/api/open/v1"

curl -s -H "X-API-Key: $KEY" "$BASE/profile"                      # 授权了哪些学校/类型
curl -s -H "X-API-Key: $KEY" "$BASE/dict?school_code=<学校>"       # ← 字段字典（写映射的依据）
curl -s -H "X-API-Key: $KEY" "$BASE/samples?school_code=<学校>"    # ← 合成样例（无真实数据也能开发）
```

### 3.1 字段字典（`/dict` 的 `field_schema`）

每个开放类型返回一组字段描述：

| 字段 | 含义 |
|---|---|
| `path` | **对外响应中的路径**：顶层字段直接写名；检测业务字段在 `result.*` 下（如 `result.rluValue`、`result.recheckRecords`） |
| `label` | 中文名 |
| `type` | `string` / `number` / `boolean` / `date` / `datetime` / `enum` / `array<object>` / `object` / `unknown` |
| `unit` | 单位；无单位或未知时为 `null`（字典表里显示 `—`） |
| `required` | `true` = 该类型**当前全部记录**都出现该字段；`false` = 可能缺失（历史数据或学校配置差异） |
| `nullable` | 是否允许 `null` |
| `enum` | 枚举取值（如有） |
| `conditional` / `conditional_on` | 条件字段：例如 `inspector` 仅当授权开启 `include_inspector` 时才存在 |
| `source` | `platform`（平台内置）或 `school_custom`（学校自定义字段，类型不保证，标注为 `unknown`） |
| `item_fields` | 数组元素包含的键（如 `atpPoints[]` 的 `loc/rlu/res`） |

注意事项：

- 字典描述的是**实际对外契约**，不是数据库原始结构；`result` 内可能出现与顶层同义的冗余副本（`canteen` / `testDate` / `inspector`），**取顶层为准**。
- 实测类型提醒：`result.rluValue`、`result.tpmValue`、`result.acidValue`、`result.oilTemp` 在源数据中为**字符串**，需自行转数值；`result.allTestItems[].no` 存在 number 与 string 两种形态。
- 学校自定义字段会出现在字典中（`source: school_custom`），其类型与单位由学校配置决定，平台不做保证。

### 3.2 合成样例（`/samples`）

- 全部为**构造数据**，`record_code` 以 `SAMPLE-` 开头，且带 `synthetic: true`——**请勿写入正式数据集**。
- 覆盖各类型的合格、不合格、复检、字段缺失场景；复检样例**仅对真实存在复检结构的类型产生**（餐具 `recheckRecords`、病原体 `recheckReports`），不会为果蔬/肉蛋/食用油编造复检结构。
- 样例经过与真实记录**完全相同的授权检查与字段投影**，因此形态即真实响应形态（检测人姓名默认不下发）。

---

## 4. 推荐同步流程

> 目标：可靠地得到"新增 / 变更 / 已撤回"，且任何失败都不导致本地数据被误删。

```
① GET /sync/manifest?school_code=<校>            → total + digest
   ├─ digest 与本地一致 → 本轮结束（无需拉明细）
   └─ digest 变化 → 进入第 ② 步
② GET /sync/manifest?school_code=<校>&detail=1   → [{record_code, updated_at}]
   ├─ 清单有、本地无         → 新增
   ├─ updated_at 比本地新     → 变更
   └─ 本地有、清单无         → **仅当本轮清单"完整获取"时**才可判定为"源端已不存在"（见 §5 三态）
③ 明细用 GET /test-records?school_code=<校>&cursor=<游标>&limit=200 逐页拉取
   ├─ 每页成功处理完成后，才保存 next_cursor；重试允许重复，按 record_code 幂等 upsert
   └─ 收到 409 → 回到第 ① 步重新对账，并**重新拉取全部明细以重新投影**
④ 本轮结束时再取一次 manifest.digest：与开始时不一致 → 数据在本轮期间又发生变化，重跑一轮
```

### 4.1 游标规则（`next_cursor`）

- 游标由服务端生成，绑定：学校 + 筛选条件（类型集合、`until`）+ 授权版本 `scope_version` + 投影策略 `projection_fingerprint` + 水位 `(updated_at, id)`。
- **不可跨学校、不可更换 `test_type`/`until` 复用**（会返回 `400 CURSOR_FILTER_MISMATCH`）；
- 授权或字段可见性变化 → `409 SCOPE_CHANGED`；
- 旧协议游标 → `409 SCOPE_CHANGED`（提示重新对账）；
- 排序键为 `(updated_at ASC, id ASC)`：同一时间戳的记录靠 `id` 决胜，不会漏。
- `since` 参数仅用于**重叠回拉**（粗筛，边界记录可能重复），常规增量请使用 `cursor`。

### 4.2 三种"记录不见了"的情况必须区分

| 情况 | 判定依据 | 建议动作 |
|---|---|---|
| **源记录确实删除** | 本轮清单**完整获取成功**、`scope_version`/`projection_fingerprint` 与本地记录一致、且该 `record_code` 不在清单中 | 按双方约定删除或标记撤回（平台侧为硬删除，无回收站） |
| **授权收紧导致不可见** | `scope_version` 变化、该校 `403`、或该类型已不在 `visible_types` 中 | **标记为撤回/不可见**，不要物理删除；同时按新授权重投影 |
| **请求失败导致状态未知** | `401/403/409/429`、超时、解析失败、部分分页失败 | **绝不可解释为"空清单"**：保留旧水位、保留本地数据、重试 |

> 平台**不建议**客户端默认物理删除：先标记撤回（软删除/不可见），物理删除策略由双方单独约定。

### 4.3 字段撤回（容易漏）

授权关闭「检测人姓名」后，新响应中不再包含 `inspector`——**对方本地已有的姓名不会自动消失**。
若客户端只做"字段 merge"，旧值会残留。因此：

- 检测到 `projection_fingerprint` 变化时，必须对影响范围内记录执行**替换式重投影**（用新响应整体覆盖，或显式清除已撤回字段）；
- 同理适用于任何未来新增的可撤回字段。

### 4.4 失败与重试约定

- `401/403`：不要重试，检查密钥/授权/白名单；
- `429`：按 `Retry-After` 退避；
- `5xx`/超时：指数退避重试，**保留旧水位**；
- 分页中途失败：从**最后一次成功处理**的 `cursor` 继续；
- 任何情况下都不可用"空结果"覆盖本地已有数据。

---

## 5. 接口详情

### 5.1 `GET /ping`
```json
{ "code": 0, "data": { "client_name": "…", "credential_label": "生产",
  "credential_prefix": "oap_12345678", "contract_version": "v1", "server_time": "2026-09-15T14:30:00+08:00" } }
```

### 5.2 `GET /profile`
返回对接方、当前凭证与**每所学校的授权**（`school_code`/`scope_version`/`visible_types`/`include_pathogen`/`include_inspector`/`include_attachments`/`start_date`/`end_date`）。

### 5.3 `GET /dict`
`contract_version`、`school_code`、`scope_version`、`visible_types`、`canteens`、`conclusions`、`field_schema`（见 §3.1）、`field_schema_notes`。

### 5.4 `GET /samples`
`contract_version`、`samples: [{ test_type, scenario, synthetic: true, note, item }]`。

### 5.5 `GET /sync/manifest`

| 参数 | 必填 | 说明 |
|---|---|---|
| `school_code` | 是 | 学校代码 |
| `detail` | 否 | `1` 时附 `items` 全量清单，否则仅摘要 |

```json
{ "code": 0, "data": {
  "contract_version": "v1", "school_code": "tjb",
  "scope_version": 3, "projection_fingerprint": "9f2c…",
  "visible_types": ["tableware", "pesticide", "oil", "leanMeat"],
  "generated_at": "2026-09-15T14:30:00+08:00",
  "detail": true, "total": 1063, "complete": true,
  "digest": "…", "digest_covers": "cursor_version+scope_version+projection_fingerprint+record_code@updated_at",
  "items": [ { "record_code": "RC-tableware-…", "updated_at": "2026-09-14T11:05:00+08:00" } ] } }
```

- `complete: true` 表示这是完整清单；**超上限时不会返回 `complete: false`，而是 `413` 错误**。
- `digest` 覆盖授权版本与投影策略：因此"关闭检测人姓名"这类变化也会改变 digest（避免客户端误判"无变化"而跳过重投影）。

### 5.6 `GET /test-records`

参数：`school_code`（必填）、`cursor`、`limit`（默认 100，上限 200）、`test_type`、`since`、`until`。

```json
{ "code": 0, "data": {
  "contract_version": "v1", "school_code": "tjb", "school_name": "…",
  "scope_version": 3, "projection_fingerprint": "9f2c…",
  "visible_types": ["tableware", "…"], "test_type_filter": null,
  "count": 200, "has_more": true, "next_cursor": "eyJ2Ijoy…",
  "items": [ {
      "record_id": "cmt…", "record_code": "RC-tableware-07c2240b…",
      "school_code": "tjb", "school_name": "…",
      "test_type": "tableware", "test_name": "餐具洁净度检测",
      "test_date": "2026-01-16", "canteen": "三食堂",
      "status": "completed",
      "initial_conclusion": "fail", "final_conclusion": "pass", "conclusion": "pass",
      "final_conclusion_basis": "recheck",
      "conclusion_text": "整改后复检合格", "conclusion_source": "stored",
      "is_positive": null,
      "result": { "result": "不合格 (>500)", "rluValue": "614", "recheckRecords": [ … ] },
      "created_at": "2026-01-16T00:00:00+08:00", "updated_at": "2026-09-14T11:05:00+08:00",
      "data_version": 1 } ] } }
```

字段含义见 `/dict` 的字段字典；这里强调三点：

- `conclusion` = `final_conclusion`（有复检取复检结论），`final_conclusion_basis` 说明它来自初检还是复检；
- `conclusion_source` 固定为 `stored`：结论是**检测/录入当时保存的值**，不是按当前阈值重算的结果；
- 增量同步只以 **`updated_at`** 为准（`created_at` 对历史导入数据可能等于业务日期零点，不可用于增量）。

### 5.7 `GET /stats`

```json
{ "code": 0, "data": {
  "school_code": "tjb", "start": null, "end": null,
  "total": 1062, "pass_count": 1046, "pass_rate": 0.9849,
  "scope_total": 1062, "included_total": 1062, "excluded_total": 1,
  "excluded": [ { "reason": "missing_or_invalid_test_date",
                  "label": "检测日期缺失或格式非法（无法定位业务日期）", "count": 1 } ],
  "pass_rate_detail": { "numerator": 1046, "denominator": 1062, "value": 0.9849,
                        "when_denominator_zero": "null（不返回 0，避免被误读为全部不合格）" },
  "by_type": [ { "test_type": "tableware", "total": 233, "pass_count": 217, "pass_rate": 0.9313,
                 "scope_total": 233, "included_total": 233, "excluded_total": 1, "excluded": [ … ] } ],
  "exclusion_policy": "…" } }
```

口径说明（与员工端看板一致）：

| 类型 | 合格判定 |
|---|---|
| 餐具 / 果蔬 / 肉蛋 | `result` 含「合格」且不含「不合格」 |
| 食用油 | 优先 `colorLevel`：**仅含「不合格」判不合格，其余等级均视为合格**；无 `colorLevel` 时回退 `result` |
| 病原体 | `riskLevel = 无风险` 为合格；阳性数 = `riskLevel` 非空且 ≠ 无风险 |

- `scope_total`：授权范围内（类型 + 授权业务日期范围）的记录数；
- `included_total`：参与合格率计算的记录数；
- `excluded[]`：未参与计算的条数与**原因**（当前仅「检测日期缺失/非法」一类）；
- 分母为 0 时 `pass_rate` 返回 `null`（不是 0）；
- 若授权本身带业务日期范围，范围外记录不属于本次统计范围（不计入 `excluded`）。

> 对账建议：`/test-records` 拉到的明细条数（授权范围内全部记录）与 `/stats.scope_total` 应一致；
> 若不一致，请用 `manifest.total` 与 `stats.excluded` 定位到具体原因，而不是简单"以某个数为准"。

---

## 6. 错误码

| HTTP | code | 含义 | 处理建议 |
|---|---|---|---|
| 401 | `MISSING_KEY` / `INVALID_KEY` / `CREDENTIAL_REVOKED` / `CREDENTIAL_EXPIRED` | 未携带 / 无效 / 已吊销 / 已过期 | 检查密钥；联系平台方换发 |
| 403 | `CLIENT_DISABLED` | 对接方被停用 | 联系平台方 |
| 403 | `IP_DENIED` | 来源 IP 不在白名单 | 提供出口 IP |
| 403 | `SCHOOL_NOT_AUTHORIZED` / `TYPE_NOT_AUTHORIZED` / `NO_VISIBLE_TYPE` | 学校 / 类型未授权 | 联系平台方开通 |
| 400 | `INVALID_SCHOOL_CODE` / `INVALID_CURSOR` / `CURSOR_SCHOOL_MISMATCH` / `CURSOR_FILTER_MISMATCH` / `INVALID_SINCE` / `INVALID_UNTIL` | 参数或游标非法 | 修正参数；跨校/换条件复用游标要重拉 |
| 409 | `SCOPE_CHANGED` | 授权或字段可见性变化、游标协议过旧 | 重新对账并重拉全部明细 |
| 413 | `MANIFEST_TOO_LARGE` | 清单超单次上限（明确拒绝，不返回截断清单） | 联系平台方改为分页清单 |
| 429 | `RATE_LIMITED` | 触发限流 | 按 `Retry-After` 退避 |
| 500 | `INTERNAL_ERROR` | 平台内部错误 | 稍后重试，持续报错请联系平台方 |

---

## 7. 常见问题

**Q1：`/stats` 与明细条数为什么可能不一致？**
见 §5.7：统计只纳入能定位业务日期的记录，被排除的条数与原因在 `excluded` 中列明。请按 `excluded` 定位，而不是假定"某个接口更准"。

**Q2：`test_date` 为 `null` 是不是表示"未完成"？**
不是。检测日期缺失与结论未知是两件事：`conclusion` 独立表达结论；`test_date` 缺失只影响它是否参与统计。

**Q3：如何感知删除？**
见 §4.2。**必须在"清单完整获取成功"的前提下**才能判定源端已删除；请求失败不得解释为空清单。

**Q4：授权范围变了怎么办？**
`scope_version` / `projection_fingerprint` 变化 → 旧游标 `409`；重新对账并按新授权**重拉全部明细**（这样字段撤回才会生效）。范围变化只影响**被改动的那所学校**，其他学校的游标不受影响。

**Q5：检测人姓名能拿到吗？**
可以，但默认关闭。关闭时该字段在顶层与嵌套（复检记录、修改轨迹）中都**不会**下发；开启后使用 `include_inspector` 的授权生效。

**Q6：停用/收紧授权后，我们已下载的数据怎么办？**
平台只能阻止后续读取；已下载数据需按双方约定清理。收紧授权时平台会另行通知需要清理的范围。

---

## 8. 接入自检清单

- [ ] `GET /ping` 通，服务器时间与本机偏差可接受
- [ ] `GET /profile` 的学校与类型范围与约定一致
- [ ] `GET /dict` 能取到字段字典，字段映射已完成
- [ ] `GET /samples` 能取到各场景样例（合格/不合格/复检）
- [ ] 全量拉取一次：条数与 `manifest.total` 一致，`record_code` 无重复
- [ ] 增量拉取：翻页不重不漏；中断后带 `cursor` 续传；每页成功后才保存新游标
- [ ] 未授权学校/类型被 `403` 拒绝
- [ ] 已实现：`409` 重新对账、`digest` 双端校验（同步前后各一次）、字段撤回重投影、失败不当空清单
- [ ] 抽样 3~5 条（含不合格与复检各至少 1 条）与平台方人工核对
- [ ] 参考实现：`docs/examples/openapi-sync-client.mjs`（默认 dry-run，不连生产）
