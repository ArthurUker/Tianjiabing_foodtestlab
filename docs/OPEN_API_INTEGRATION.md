# 开放接口对接文档（第三方只读数据拉取）

> 契约版本：**v1**（`contract_version: "v1"`，所有响应都会带上）
> 最后更新：2026-09-23
> 平台侧实现：`backend/routes/openApiRoutes.js`（对外）、`backend/routes/adminOpenApiRoutes.js`（超管配置）
> 字段契约单一事实源：`backend/lib/openApiFieldSchema.js`；超管控制台「开放接口」页可在线查看字段字典与样例、并下载**接入包**

---

## 0. 契约承诺与兼容性

- 本次 v1 纠错增加 `change_token`，修正复检结论与 `initial_conclusion` 的解释，并改变清单摘要；已有客户端必须按下文升级，不能仅沿用旧摘要与旧秒级时间比较。
- 今后若需改变已有字段语义，应另行规划版本路径和迁移窗口；本文不承诺旧客户端可无修改继续同步。
- 本文件与平台实际行为不一致时，**以平台在线响应（`/dict`、`/samples`、`/profile`）为准**，并请通知平台方修正文档。

### v1 内的行为修正（2026-09-15，均在 v1 内完成，已通知影响面）

| 项 | 变更 | 兼容性影响 |
|---|---|---|
| 食用油结论 | `conclusion` 改为按平台业务口径判定（`colorLevel` 仅「不合格」判不合格，其余等级视为合格；无 `colorLevel` 回退 `result`），与 `/stats` 完全一致 | 少数食用油记录的 `conclusion` 由 `unknown` 变为 `pass`；字段本身与取值枚举未变 |
| 增量游标 | 游标升级为 v2：额外绑定**筛选条件指纹**与**投影策略指纹** | 旧游标请求会返回 `409 SCOPE_CHANGED`，需重新对账（对接初期无影响） |
| 清单摘要 `digest` | 组成改为「游标协议版本 + `scope_version` + `projection_fingerprint` + 各记录 `record_code@updated_at`」 | 同样的数据 digest 值会与旧版不同；语义更强（字段可见性变化也能被感知） |
| 清单超限 | 超过单次上限时返回 `413 MANIFEST_TOO_LARGE`，**不再可能返回被截断的清单** | 之前不存在静默截断，此处仅把行为显式化 |
| 统计 | 新增 `scope_total / included_total / excluded / pass_rate_detail`；移除含糊的差异说明 | 既有字段 `total / pass_count / pass_rate` 含义不变 |

### 本轮纠错与已有客户端升级（2026-09-23）

- `updated_at` 按数据库 `TIMESTAMP(3)` 输出毫秒；明细与清单新增相同的 `change_token`（UTC 毫秒时间与记录 `version` 组合）。`digest` 现在覆盖逐记录 `change_token` 和投影指纹，旧摘要不能与新摘要直接比较。
- 丢弃旧的跨轮游标，保留旧本地状态作回滚点；先完整获取清单和明细，按 `record_code` 整条替换（清掉已撤回字段），再读尾部清单。只有首尾摘要一致且所有分页成功时，才一次性提交新数据、摘要和水位。失败时保留旧完成状态。参考客户端用 `syncProtocolVersion: 2` 强制旧状态完成这次重拉。
- 历史复检可能覆盖当前检测值，旧 `initial_conclusion` 不能视为可信初检。新解析在无初检快照的复检记录中返回 `unknown`，结构化最新复检 `isPassed` 优先；`conclusion_conflict` 表示它与可识别的 `finalStatus` 矛盾。原 `pass_rate` 数值算法未改，`metric_basis` 更正为 `stored_current_result`。
- `school_name` 是当前学校主数据；学校改名会改变投影指纹。即使记录未更新，也应重拉该校记录以刷新名称。

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
| GET | `/profile` | 当前密钥的授权范围（每校 `scope_version`、类型、日期范围、字段开关） |
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
| `required` | `true` = **服务端投影保证**该字段一定出现在响应中（目前仅顶层字段）；`result.*` 字段来自保存的检测数据，**恒为 `false`**（是否出现取决于录入路径与历史数据） |
| `observed_present` | 数据观察（可选）：例如「该类型现有记录均出现」。⚠️ **不是输出保证**，不得据此建必填模型 |
| `nullable` | 是否允许 `null` |
| `enum` | 枚举取值（如有） |
| `conditional` / `conditional_on` | 条件字段：例如顶层 `inspector` 仅当授权开启 `include_inspector` 时才存在 |
| `emitted` | `false` = **该字段不会出现在响应中**（如 `result.inspector`），列出仅为说明原始存储结构，请勿据此编写取值逻辑 |
| `source` | `platform`（平台内置）或 `school_custom`（学校自定义字段，类型不保证，标注为 `unknown`） |
| `item_fields` | 数组元素包含的键（如 `atpPoints[]` 的 `loc/rlu/res`） |

注意事项：

- 字典描述的是**实际对外契约**，不是数据库原始结构。`result` 内的 `canteen` / `testDate` 是**历史记录的同义副本**（2026-09-16 起写入端已收口，新记录不再产生这两个副本），**取值一律以顶层为准**；`result.inspector` 属个人信息，**任何情况下都不会下发**（字典中标注 `emitted:false`，列出仅为说明原始存储结构，请勿据此开发）。
- **输出字段采用白名单**：`result` 内只下发字典登记过的键。学校已配置的普通自定义字段仍自动登记；明显身份字段名或标签会被排除，数组内相同规则递归执行。自由文本（备注、样本描述等）仍可能包含手工录入的个人信息，键名过滤无法保证消除它。新增自定义字段的显式对外审批机制尚待业务确定；如需限制既有字段，须逐对接方评估与通知，不可把自动登记误读为逐字段审批。
- `result.sampleInfo`（病原体）是**普通字符串**（样品说明，实测 5~16 字符），不是 JSON，请勿解析为对象。
- 实测类型提醒：`result.rluValue`、`result.tpmValue`、`result.acidValue`、`result.oilTemp` 在源数据中为**字符串**，需自行转数值；`result.allTestItems[].no` 存在 number 与 string 两种形态。
- **单位与缩放（务必按此实现）**：
  - `result.tpmValue`：平台保存原始字符串，界面标注为 g/100g 并使用当前代码阈值；设备协议尚未核实，不能据界面标注确认物理单位或自行换算、重判历史记录。
  - `result.acidValue`：单位 `mg KOH/g`（前端展示简写 `mg/g`）；判定 <2.5 合格 / <5 警戒 / ≥5 不合格；空值出现过（实测 空 21 / 0.3 13 / 0 5）。
  - `result.oilTemp`：`℃`（实测恒为 35）。
  - `result.colorLevel`：**不是颜色**，是「综合品质等级」枚举 `合格 / 警戒 / 不合格`（由 TPM 与酸价等级取最差得出）。
- **病原体字段语义（避免误读）**：
  - `riskLevel` ∈ {`无风险`, `低风险`, `极低风险`}；**非「无风险」一律视为不合格/有风险**（与 `/stats` 同口径），但**这不等于确诊阳性**；
  - `positiveDetails` 数组是否非空 = **是否检出的权威依据**（实测：非空 ⟺ `riskLevel` ≠ 无风险）；
  - `positiveItems` 为文本：有检出时为致病菌名称（可能多个），无风险时是 **1 字符占位（非空）**——不要用"是否为空"判断检出；
  - 复检结论优先取最新 `recheckReports[].isPassed`；当前 Web 也会写入 `finalStatus`，两者冲突时以结构化 `isPassed` 为准。
- 学校现有普通自定义字段会出现在字典中（`source: school_custom`），其类型与单位由学校配置决定，平台不做保证。新增字段的对外审批规则尚未完成，接入方应按当前 `/dict` 逐校核对。

### 自定义字段的待决策方案

建议在每所学校的对接方授权中增加「已批准自定义字段路径」清单，精确到检测类型与 `result.*` 路径，默认空；学校内部新增字段只供内部使用，超管显式批准后才进入 `/dict`、样例和真实投影。批准或撤回须递增授权版本并改变投影指纹。现有授权已自动开放的普通自定义字段需要先导出影响清单，由业务方逐对接方决定保留或撤回并通知重同步；不能静默套用新默认值。现阶段仅已确定的身份字段名/标签会被过滤，自由文本仍需数据治理和人工约束。

### 3.2 合成样例（`/samples`）

- 全部为**构造数据**，`record_code` 以 `SAMPLE-` 开头，且带 `synthetic: true`——**请勿写入正式数据集**。
- 覆盖各类型的合格、不合格、复检、字段缺失场景；餐具、果蔬、肉蛋和食用油可有 `recheckRecords`，病原体使用 `recheckReports`。
- 样例经过与真实记录**完全相同的授权检查与字段投影**，因此形态即真实响应形态（检测人姓名默认不下发）。

---

## 4. 推荐同步流程

> 目标：可靠地得到"新增 / 变更 / 已撤回"，且任何失败都不导致本地数据被误删。

```
① GET /sync/manifest?school_code=<校>            → total + digest
   ├─ 新版客户端已完整同步且 digest 与本地一致 → 本轮结束
   └─ digest 变化 → 进入第 ② 步
② GET /sync/manifest?school_code=<校>&detail=1   → [{record_code, updated_at, change_token}]
   ├─ 清单有、本地无         → 新增
   ├─ change_token 与本地不同 → 变更
   └─ 本地有、清单无         → **仅当本轮清单"完整获取"时**才可判定为"源端已不存在"（见 §5 三态）
③ 明细用 GET /test-records?school_code=<校>&cursor=<游标>&limit=200 逐页拉取
   ├─ 每页成功处理完成后，才保存 next_cursor；重试允许重复，按 record_code 幂等 upsert
   └─ 收到 409 → 回到第 ① 步重新对账，并**重新拉取全部明细以重新投影**
④ 本轮结束时再取一次 manifest.digest：与开始时不一致 → 数据在本轮期间又发生变化，重跑一轮
```

旧客户端升级、授权或投影变化，以及「摘要变化但清单逐条比较无变化」时，执行有界的完整重拉。失败或超过轮次上限必须返回未完成，保留旧完成摘要；不要把仅有摘要变化登记为已同步。

### 4.1 游标规则（`next_cursor`）

- 游标由服务端生成，绑定：学校 + 筛选条件（类型集合、`until`）+ 授权版本 `scope_version` + 投影策略 `projection_fingerprint` + 水位 `(updated_at, id)`。
- **不可跨学校、不可更换 `test_type`/`until` 复用**（会返回 `400 CURSOR_FILTER_MISMATCH`）；
- 授权或字段可见性变化 → `409 SCOPE_CHANGED`；
- 旧协议游标 → `409 SCOPE_CHANGED`（提示重新对账）；
- 排序键为 `(updated_at ASC, id ASC)`；`updated_at` 为毫秒精度。同一时间戳的记录靠 `id` 决胜。客户端须用清单摘要和逐条 `change_token` 复核，不得自行截断到秒。
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

**记录级字段减少（不依赖 `projection_fingerprint`）**：平台可能对单条记录做规范化（例如移除 `result` 内的历史同义副本 `canteen`/`testDate`），此时该记录 `updated_at` 变化、`digest` 变化，但 `projection_fingerprint` **不变**。因此：

- **凡重新获取到的记录，一律按其"完整投影对象"整体覆盖本地同 `record_code` 的记录**（不要只做字段级 merge）——这样字段减少才能同步生效；
- 反之，**不要**用"接口没返回该字段"解释为"该字段值为空/未变"：本接口只会返回**完整对象**（不存在部分响应语义）；契约内不返回 = 该字段不应存在于你方本地；
- 授权变化（`scope_version`/`projection_fingerprint`）与普通记录字段变化，都按同一条"整体覆盖"规则处理即可。

### 4.3.1 本地 checkpoint 的原子性（**必须遵守**）

参考实现见 `docs/examples/openapi-sync-client.mjs`（mock 模式可直接跑）。规则：

1. 读 `head` 清单 → **克隆当前本地状态为 candidate**；
2. 本轮所有改动（records / cursor / watermark）**只写 candidate**；
3. 本轮结束再读 `tail` 清单，**先校验** `tail.digest === head.digest`（且 `scope_version` / `projection_fingerprint` 未变）；
4. 校验通过才把 candidate **一次性提交**为正式状态；不一致则**丢弃 candidate 并重跑**（有界重试 + 退避）。

⚠️ 常见错误：在 tail 校验之前就写 `state.digest = tail.digest`。若同步中途源端新增了数据（head=D1、tail=D2），
下一轮会把 D2 误判为"已同步"，**新增记录永久漏拉**。同理，任何失败（第 N 页超时 / JSON 解析失败 /
tail 请求失败 / digest 不一致）都不得留下 records / cursor / watermark / digest 的半更新。

### 4.4 失败与重试约定

- `401/403`：不要重试，检查密钥/授权/白名单；
- `429`：按 `Retry-After` 退避；
- `5xx`/超时：指数退避重试，**保留旧水位**；
- 分页中途失败：保留上一轮正式 checkpoint；在当前候选轮内可从成功处理的 `cursor` 继续，跨轮从 manifest 重新对账；
- 任何情况下都不可用"空结果"覆盖本地已有数据。

---

## 5. 接口详情

### 5.1 `GET /ping`
```json
{ "code": 0, "data": { "client_name": "…", "credential_label": "生产",
  "credential_prefix": "oap_12345678", "contract_version": "v1", "server_time": "2026-09-15T14:30:00+08:00" } }
```

### 5.2 `GET /profile`
返回对接方、当前凭证与**每所学校的授权**（`school_code`/`school_name`/`status`/`scope_version`/`visible_types`/`include_pathogen`/`include_inspector`/`include_attachments`/`start_date`/`end_date`）。

> ⚠️ `/profile` **不返回** `projection_fingerprint`。字段可见性指纹请从 `/test-records`、`/samples`、`/sync/manifest` 的响应中读取（三处同值，与该校 grant 的 `scope_version` 一起用于判断"是否需要重投影"）。

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
  "digest": "…", "digest_covers": "cursor_version+scope_version+projection_fingerprint+record_code@change_token",
  "items": [ { "record_code": "RC-tableware-…", "updated_at": "2026-09-14T11:05:00.900+08:00", "change_token": "2026-09-14T03:05:00.900Z|v2" } ] } }
```

- `complete: true` 表示这是完整清单；**超上限时不会返回 `complete: false`，而是 `413` 错误**。
- `digest` 覆盖授权版本与投影策略：因此"关闭检测人姓名"这类变化也会改变 digest（避免客户端误判"无变化"而跳过重投影）。
- 学校名称按当前主数据下发；改名会改变投影指纹，即使记录行未更新也需重投影。

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
      "initial_conclusion": "unknown", "final_conclusion": "pass", "conclusion": "pass",
      "final_conclusion_basis": "recheck",
      "conclusion_text": "整改后复检合格", "conclusion_source": "stored",
      "conclusion_conflict": false, "is_positive": null,
      "result": { "result": "合格", "rluValue": "96", "recheckRecords": [ … ] },
      "created_at": "2026-01-16T00:00:00.000+08:00", "updated_at": "2026-09-14T11:05:00.900+08:00",
      "change_token": "2026-09-14T03:05:00.900Z|v2",
      "data_version": 1 } ] } }
```

字段含义见 `/dict` 的字段字典；这里强调三点：

- `conclusion` = `final_conclusion`（有复检取复检结论），`final_conclusion_basis` 说明它来自初检还是复检；
- 当前 Web 复检会覆盖部分当前检测值；若没有独立初检快照，`initial_conclusion=unknown`，不能由当前值倒推初检。最新结构化 `isPassed` 与文本矛盾时优先前者，`conclusion_conflict=true`。
- `conclusion_source` 固定为 `stored`：平台在**录入时按当时规则保存判定文本**（`result` / `colorLevel` / `riskLevel` / `finalStatus` / 复检结论），接口据此**映射**为结论枚举——因此结论反映的是"录入当时的判定"，**不会因平台阈值调整而改变**；
- 增量同步：`updated_at` 用于毫秒级排序，逐记录比较 `change_token`，完成条件还需首尾 `digest` 一致。旧秒级时间字符串应触发一次完整重拉。

### 5.7 `GET /stats`

```json
{ "code": 0, "data": {
  "school_code": "tjb", "start": "2026-01-01", "end": "2026-01-31",
  "total": 1062, "pass_count": 1046, "pass_rate": 0.9849,
  "scope_total": 1062, "included_total": 1062, "universe_total": 1063,
  "excluded_total": 0,
  "excluded": [],
  "request_out_of_range_total": 0,
  "range": { "requested": { "start": null, "end": null },
             "grant": { "start": "2026-01-01", "end": "2026-01-31" },
             "effective": { "start": "2026-01-01", "end": "2026-01-31" },
             "inclusivity": "两端含当天（闭区间）",
             "authorization_boundary": "统计只在「授权可见全集」内进行：授权业务日期范围外的记录不出现在任何字段中（连数量也不可推断）。" },
  "set_definition": { "authorized_universe": "…", "scope_total": "…", "identity": "universe_total = scope_total + request_out_of_range_total + excluded_total" },
  "pass_rate_detail": { "numerator": 1046, "denominator": 1062, "value": 0.9849,
                        "when_denominator_zero": "null（不返回 0，避免被误读为全部不合格）" },
  "by_type": [ { "test_type": "tableware", "total": 233, "pass_count": 217, "pass_rate": 0.9313,
                 "scope_total": 233, "universe_total": 233, "request_out_of_range_total": 0,
                 "included_total": 233, "excluded_total": 0, "excluded": [] } ],
  "exclusion_policy": "…" } }
```

口径说明（与员工端看板一致）：

| 类型 | 合格判定 |
|---|---|
| 餐具 / 果蔬 / 肉蛋 | `result` 含「合格」且不含「不合格」 |
| 食用油 | 优先 `colorLevel`（综合品质等级）走**显式枚举**：`合格`/`警戒` → 合格；`不合格` → 不合格；**其它未识别值不再默认合格**，而是回退 `result` 文本判定（`colorLevel` 缺失时同样回退 `result`，实测油记录 `result` 恒为空串 → `unknown`） |
| 病原体 | `riskLevel = 无风险` 为合格；**任何其它非空值视为不合格/有风险**。⚠️ 「有风险」≠ 确诊阳性：是否检出看 `result.positiveDetails` 是否非空 |

### 复检记录的阶段语义（病原体，2026-09-23 补充）

同一条有复检的病原体记录里，各字段属于**不同阶段**，并存不矛盾：

| 字段 | 阶段 | 说明 |
|---|---|---|
| `result.riskLevel` / `result.positiveDetails` / `result.positiveItems` | **初检证据** | 初检留下的风险等级与检出明细；复检只改当前结果，不会重写这些证据 |
| `is_positive` | **初检检出证据**（顶层） | `positiveDetails` 非空 ⟺ `true`；该键缺失时按 `riskLevel ≠ 无风险` 兜底。**不是复检结论，也不等于确诊** |
| `initial_conclusion` | 初检结论 | 无独立初检快照时（复检已覆盖原值）为 `unknown`，**不逆推** |
| `final_conclusion` / `conclusion` / `final_conclusion_basis` | **最终结论** | 复检存在时取最新复检的 `isPassed`（`basis=recheck`）；判断"当前是否合格"只看这里 |

因此 `initial_conclusion=unknown` + `final_conclusion=pass` + `is_positive=true` 是**正常组合**（初检快照被复检覆盖 / 初检检出证据仍在 / 复检通过），不是同一时点的自相矛盾。

> ⚠️ **TPM（`result.tpmValue`）的单位尚未获得设备协议核实**：平台保存的是**原始字符串值**（不做换算），
> 字段字典中的 `unit`（`g/100g`）与阈值（≤0.13 / ≤0.25）属**平台界面标注与当前实现口径**，
> 字段上的 `unit_verified: false` 即表示"未经设备协议/计量文件确认"。**请勿自行换算（不要 ×100 或 ÷100），
> 也不要据该字段重新判定历史结论**；待核验资料清单见 `docs/reviews/TPM_UNIT_VERIFICATION_CHECKLIST_20260917.md`。

**集合定义（互斥，可人工验算）**：

| 集合 | 含义 |
|---|---|
| AuthorizedUniverse（`universe_total`） | 授权类型内、且落在**授权业务日期范围**内的记录 |
| `scope_total` = `included_total` | 日期合法 **且** 落在「授权 ∩ 请求」范围内 → 合格率分母 |
| `request_out_of_range_total` | 日期合法、在授权范围内，但超出**本次请求**范围 |
| `excluded_total` / `excluded[]` | 日期缺失 / 格式非法 / **日历不存在**（如 `2026-02-30`）。⚠️ 授权带业务日期范围时恒为 0：这类记录无法归属窗口，不计入任何返回值 |

- 恒等式：`universe_total = scope_total + request_out_of_range_total + excluded_total`；
- **授权范围外的记录不出现在任何字段里**（含数量）——统计不做授权外数量的侧信道；
- 分母为 0 时 `pass_rate` 返回 `null`（不是 0）；
- `start`/`end` 的实际生效范围 = **授权范围 ∩ 请求范围**（请求不得超过授权）；交集为空是合法请求 → `200` 且 0 条（`range.empty = true`）。
- `metric_basis = 'stored_current_result'`：既有 `pass_rate` 数值算法未改，按当前保存的 `result`/`colorLevel`/`riskLevel` 计算。部分 Web 复检会覆盖这些字段，所以它不能保证是初检率，也不保证所有类型都等于最终结论率。独立初检与最终结论统计指标须待业务确定快照保存和兼容方案。

> 对账建议（2026-09-17 澄清，避免误判）：
> · `/test-records` 的**日期过滤只来自授权范围**（该端点不接受业务日期参数，`until` 过滤的是 `updated_at`）。
> · 授权**带**业务日期范围时：`/test-records` 与 `/manifest` 只含范围内、日期合法的记录 ⇒ 与其条数一致的是 `stats.scope_total`。
> · 授权**不带**业务日期范围时：`/test-records` 会返回授权类型内**全部**记录（**包含日期缺失/非法**的记录，供排查），
>   而 `stats.scope_total` 只含日期合法的记录 ⇒ 对账恒等式为 **`manifest.total = scope_total + excluded_total`**；
>   请求范围与授权范围的差异另由 `request_out_of_range_total` 解释。
> 若仍不一致，请按上述三个桶定位，而不是简单"以某个数为准"。

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
