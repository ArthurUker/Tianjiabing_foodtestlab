<!-- 本文件为**离线合成的接入包样本**（桩数据，非真实对接方/学校/密钥）；实际交付请在超管界面「开放接口 → 接入说明 → 下载接入包」生成。 -->
# foodSentinel 开放接口 · 接入包

- 对接方：**示例对接方（合成）**
- 契约版本：`v1`
- 生成时间：2026-09-24T03:41:06.353Z
- ⚠️ 本文件中的**开放范围是生成时的授权快照**（学校代码：demo）；**实际生效权限一律以 `GET /profile` 为准**（平台可能在此之后调整授权），本快照也不代表其它学校已开通。
- ⚠️ 本文件**不包含任何密钥**：API Key 由平台超管通过安全渠道单独提供，明文只在生成时显示一次。

## 0. 快速开始（可直接复制运行）

```bash
# ① 连通性 + 服务器时间（对账时钟）
curl -s -H "X-API-Key: $KEY" https://foodsentinel.digifluidic.com/api/open/v1/ping

# ② 确认当前授权范围（学校 / 类型 / 字段开关 / scope_version）
curl -s -H "X-API-Key: $KEY" https://foodsentinel.digifluidic.com/api/open/v1/profile

# ③ 取字段字典（据此写映射：是否下发、单位、结论枚举、自定义字段）
curl -s -H "X-API-Key: $KEY" "https://foodsentinel.digifluidic.com/api/open/v1/dict?school_code=<校>"

# ④ 拉第一页记录（limit ≤ 200；看 has_more / next_cursor）
curl -s -H "X-API-Key: $KEY" "https://foodsentinel.digifluidic.com/api/open/v1/test-records?school_code=<校>&limit=200"

# ⑤ 对账清单（total + digest；detail=1 附全量 {record_code, updated_at, change_token}）
curl -s -H "X-API-Key: $KEY" "https://foodsentinel.digifluidic.com/api/open/v1/sync/manifest?school_code=<校>"
```

> `$KEY` 即平台提供的密钥明文（形如 `oap_…`）。**认证只有一种密钥**，可用下面两种方式之一携带；两者同时出现时以 `X-API-Key` 为准。

> ⚠️ **基址别重复拼 `/v1`**：正确是 `https://<域名>/api/open/v1/ping`。若拼成 `/api/open/v1/v1/ping`，请求会落到需要登录态的其它路由，返回 `401 缺少授权令牌` —— 看起来像"密钥无效"，实际是地址拼错（本项目自测时踩过两次）。

**分页响应外层结构**（`GET /test-records`，注意外层是 `data`，单条记录在 `data.items[]`）：
```json
{ "code": 0, "data": { "school_code": "<校>", "scope_version": 1, "projection_fingerprint": "…",
    "count": 200, "has_more": true, "next_cursor": "<最后一页为 null>",
    "server_time": "2026-09-16T12:00:00+08:00", "items": [ { "…": "单条记录对象（见样例）" } ] } }
```
**清单响应外层结构**（`GET /sync/manifest`，`detail=1` 时才有 `items`）：
```json
{ "code": 0, "data": { "total": 1129, "complete": true, "digest": "…",
    "digest_covers": "cursor_version+scope_version+projection_fingerprint+record_code@change_token",
    "generated_at": "2026-09-16T12:00:00+08:00",
    "items": [ { "record_code": "RC-…", "updated_at": "2026-09-16T11:05:00.900+08:00", "change_token": "2026-09-16T03:05:00.900Z|v2" } ] } }
```

## 1. 接口地址与认证

- 基址：`https://foodsentinel.digifluidic.com/api/open/v1`
- 认证（**同一个密钥**，二选一携带方式）：`X-API-Key: <密钥>` 或 `Authorization: Bearer <密钥>`；必须 HTTPS。两者同时出现时以 `X-API-Key` 为准。
- 限流：默认 **60 次/分钟**（按凭证独立计数）；超限返回 `429 RATE_LIMITED`，请按 `Retry-After` 退避并降低并发。
- 分页参数：`limit` 默认 **100**、上限 **200**；`limit` 缺失 / 非数字 / `0` 一律**回退默认值**（不报错，兼容既有调用行为）。
- 日期参数（`start` / `end`）：接受 `YYYY-MM-DD` 或 ISO8601 日期时间（取日期部分），**两端含当天**（闭区间）；非法日期返回 `400 INVALID_START` / `INVALID_END`，`start > end` 返回 `400 INVALID_RANGE`；请求范围与授权业务日期范围**求交集**（请求不能越过授权范围，交集为空是合法请求 → 200 且 0 条）。
- `projection_fingerprint`（字段可见性指纹）在 `/test-records`、`/samples`、`/sync/manifest` 响应中返回，**`/profile` 不含**该字段。
- 所有成功响应为 `{ "code": 0, "data": {...} }`；失败为 `{ "code": "<错误码>", "error": "..." }`（均带 `server_time`）。

| 端点 | 参数 | 说明 |
|---|---|---|
| `GET /ping` | — | 连通性 + 服务器时间（对账本机时钟） |
| `GET /profile` | — | 当前密钥的授权范围（每校 scope_version / 类型 / 日期范围 / 字段开关）；**不含** projection_fingerprint |
| `GET /schools` | — | 当前密钥可访问的学校清单 |
| `GET /dict` | school_code | 字段字典：类型、食堂、结论枚举、字段路径/类型/单位/必现/可空/是否下发 |
| `GET /samples` | school_code、test_type（可选） | 合成样例（非真实数据，`SAMPLE-` 前缀，可在无数据时开发） |
| `GET /test-records` | school_code、test_type（可选）、cursor、limit | 检测记录（游标分页，完整对象） |
| `GET /sync/manifest` | school_code、detail（可选） | 全量清单（total + digest）；`detail=1` 附 {record_code, updated_at, change_token} |
| `GET /stats` | school_code、start、end、test_type（可选） | 合格率统计（含集合恒等式与排除原因，可对账） |

## 2. 当前已保存的开放范围（授权快照）

- 快照生成时间：2026-09-24T03:41:06.353Z（此后平台仍可调整授权；交付前如已改动请**重新下载**本文件）
- 有效密钥：1 把（展示用片段：`oap_SAMPLE00…zzzz`；仅供辨认，**明文只在生成时显示一次**）
- 限流：60 次/分钟（按凭证独立计数；超限 429 + `Retry-After`）
- IP 白名单：**未配置（不限制来源 IP）** —— 正式启用建议填入对方固定出口 IP（若出现 `403 IP_DENIED`，先核对出口 IP 是否与白名单一致）

| 学校 | 学校代码 | 开放类型 | 业务日期范围 | 检测人姓名 | 病原体 | 附件 | scope_version |
|---|---|---|---|---|---|---|---|
| 示例学校（合成） | `demo` | tableware、pesticide、oil、leanMeat、pathogen | 不限 ~ 不限 | 不下发 | 开放 | 不开放 | 1 |

> 上表是**生成时的快照**；`scope_version` 会随授权变更递增。请以 `GET /profile` 的实时结果为准（两者不一致时以服务端实时值为准并告知平台）。

## 3. 字段字典

> 读表须知：
> **必现 = 服务端保证**（是 = 该字段一定出现在响应中，目前仅顶层字段）。`result.*` 字段来自保存的检测数据，**恒为否**：若观察到「现有记录均出现」，会写在说明里的 `实测出现：…` —— 那是**数据观察，不是输出保证**，请勿据此建必填模型；容错解析以「可空」「下发」为准。
> **可空**：字段存在但值可能为 `null`。**三态区分**：字段**省略**（不存在）≠ `null`（存在无值）≠ 空串/空数组（有值为空）。
> **下发=否** 的字段**不会出现在响应中**，列出仅为说明原始存储结构（如 `result.inspector` 属个人信息恒不下发），请勿据此开发。
> **公共字段只列一次**（该学校所有开放类型一致）；各类型的专属字段分列在其后。数组元素结构见说明中的「元素：…」。
> ⚠️ **单位标注 ≠ 已核实单位**：字段表「单位」列带 `⚠️未核实` 的（如 `result.tpmValue`）表示该单位仅为**平台界面标注**（字段上 `unit_source=platform_label`、`unit_verified=false`），**设备协议/计量文件尚未核实** —— 请勿自行换算（×100 / ÷100），也不要据该字段重新判定历史结论。

### 示例学校（合成） / 公共字段

| 路径 | 中文名 | 类型 | 单位 | 必现 | 可空 | 下发 | 说明 |
|---|---|---|---|---|---|---|---|
| `record_id` | 平台内部记录 ID | string | — | 是 | 否 | 是 | 平台数据库主键，仅用于排障；业务幂等请用 record_code |
| `record_code` | 记录业务码 | string | — | 是 | 否 | 是 | 跨次拉取稳定不变的业务唯一键，用于本地 upsert 与清单比对 |
| `school_code` | 学校代码 | string | — | 是 | 否 | 是 | 平台学校代码（schema 名去前缀） |
| `school_name` | 学校名称 | string | — | 是 | 否 | 是 |  |
| `test_type` | 检测类型 | enum（取值：tableware / pesticide / oil / leanMeat / pathogen） | — | 是 | 否 | 是 | 类型白名单由授权决定 |
| `test_name` | 检测类型名称 | string | — | 是 | 否 | 是 |  |
| `test_date` | 检测业务日期 | date | — | 否 | 是 | 是 | 业务日期；极少数历史记录为空（与结论无关，不得据此判定为未完成） |
| `canteen` | 食堂 | string | — | 否 | 是 | 是 |  |
| `status` | 记录状态 | enum（取值：pending / completed / failed / archived） | — | 是 | 否 | 是 |  |
| `initial_conclusion` | 初检结论 | enum（取值：pass / fail / warning / unknown） | — | 是 | 否 | 是 | 无复检时按当前保存值映射；有复检且未保存独立初检快照时为 unknown，不逆推 |
| `final_conclusion` | 最终结论 | enum（取值：pass / fail / warning / unknown） | — | 是 | 否 | 是 | 有复检时取复检结论，否则与初检一致 |
| `conclusion` | 结论（对外统一口径） | enum（取值：pass / fail / warning / unknown） | — | 是 | 否 | 是 | 等于 final_conclusion，推荐直接使用此字段 |
| `final_conclusion_basis` | 最终结论来源 | enum（取值：initial / recheck） | — | 是 | 否 | 是 | initial=无复检、沿用初检；recheck=由复检结论覆盖 |
| `conclusion_conflict` | 复检结论冲突 | boolean | — | 是 | 否 | 是 | 复检 isPassed 与可识别的 finalStatus 相反时为 true；结构化 isPassed 优先 |
| `change_token` | 逐记录变化标识 | string | — | 是 | 否 | 是 | 毫秒级更新时间与内部记录版本的组合；用于清单和明细对账 |
| `conclusion_text` | 结论原文 | string | — | 否 | 是 | 是 | 记录内保存的判定文本原样返回（如「整改后复检合格」「不合格 (>500)」） |
| `conclusion_source` | 结论来源 | string | — | 是 | 否 | 是 | 固定为 'stored'：结论是**录入/检测当时保存**的值，不是按当前阈值重新计算的结果 |
| `is_positive` | 是否阳性 | boolean | — | 否 | 是 | 是 | 仅病原体有意义（非病原体恒为 null）。语义 = **当前保存的检出证据**：`result.positiveDetails` 非空 ⟺ true；该键缺失时按 `riskLevel ≠ 无风险` 兜底。**注意阶段**：它反映初检留下的检出证据，**不是复检结论、也不等于确诊** —— 复检合格后若 `positiveDetails` 仍是初检遗留值，本字段会保持 true，与 `final_conclusion=pass` / `final_conclusion_basis=recheck` **并存不矛盾**（初检检出 → 复检通过）。判断"当前是否合格"请用 final_conclusion，不要用本字段。 |
| `result` | 检测业务数据 | object | — | 是 | 否 | 是 | 该类型的业务字段集合（见同类型 result.* 条目）；字段随类型与学校自定义配置不同 |
| `created_at` | 记录创建时间 | datetime | — | 是 | 否 | 是 | ⚠️ 历史导入数据的创建时间可能等于业务日期零点，不要用它做增量同步 |
| `updated_at` | 数据变更时间 | datetime | — | 是 | 否 | 是 | 记录变更排序时间；逐条比较请用 change_token，并以 manifest.digest 做最终对账 |
| `data_version` | 数据版本 | integer | — | 是 | 否 | 是 |  |
| `inspector` | 检测人姓名 | string | — | 否 | 是 | 是 | 仅当该学校授权开启「下发检测人姓名」时出现；关闭时该字段不存在（含复检/修改轨迹内的姓名一律不下发）；（条件字段：仅当 include_inspector 开启时存在） |
| `result.canteen` | 食堂（历史同义副本） | string | — | 否 | 是 | 是 | 与顶层 canteen 同义（**以顶层为准**）；仅历史记录可能出现，新记录不再写入 |
| `result.testDate` | 检测日期（历史同义副本） | string | — | 否 | 是 | 是 | 与顶层 test_date 同义（**以顶层为准**）；仅历史记录可能出现，新记录不再写入 |
| `result.inspector` | 检测人（历史同义副本，恒不下发） | string | — | 否 | 是 | **否** | 属个人信息，为**平台内部存储字段：任何情况下都不会出现在响应中**（无论是否开启「下发检测人姓名」）。需要检测人请使用顶层 inspector（由 include_inspector 控制） |

### 示例学校（合成） / tableware · 专属字段

| 路径 | 中文名 | 类型 | 单位 | 必现 | 可空 | 下发 | 说明 |
|---|---|---|---|---|---|---|---|
| `result.testType` | 检测项目 | string | — | 否 | 是 | 是 | 如 表面清洁度 / 洗涤剂残留；历史记录中仅部分存在，取值以学校配置为准 |
| `result.location` | 检测点位 | string | — | 否 | 是 | 是 |  |
| `result.rluValue` | RLU 值 | string | RLU | 否 | 是 | 是 | ⚠️ 字符串类型（历史录入即文本），需自行转数值；实测出现：该类型现有记录均出现（数据观察，非输出保证） |
| `result.result` | 结果文本 | string | — | 否 | 是 | 是 | 如「合格 (<200)」「不合格 (>500)」。⚠️ **可能为空字符串**：洗涤剂残留（`testType=detergent`）点位只写 `result.atpPoints[].res`，此时记录级结论以点位为准（顶层为空**不等于不合格**）；实测出现：该类型现有记录均出现（数据观察，非输出保证） |
| `result.atpPoints` | ATP 点位明细 | array<object> | — | 否 | 是 | 是 | **点位级结论的权威来源**（顶层 `result` 为空时按此判定记录结论：任一点位「不合格」→ 不合格；所有点位「合格」→ 合格；其余 → 未判定）；；元素：loc(点位)、rlu(RLU 字符串)、res(结论文本)、testType(检测项目，部分记录存在) |
| `result.correctiveAction` | 整改措施 | string | — | 否 | 是 | 是 | 实测出现：该类型现有记录均出现（数据观察，非输出保证） |
| `result.recheckResult` | 复检结果备注 | string | — | 否 | 是 | 是 | 实测出现：该类型现有记录均出现（数据观察，非输出保证） |
| `result.recheckRecords` | 复检记录 | array<object> | — | 否 | 是 | 是 | 有复检时才出现；元素中 user（复检人姓名）不下发；；元素：id(序号)、time(复检时间字符串)、isPassed(是否通过 boolean)、points(点位明细 array) |
| `result.finalStatus` | 最终状态文本 | string | — | 否 | 是 | 是 | 如「整改后复检合格」；最终枚举优先取最新复检 isPassed |
| `result.remark` | 备注 | string | — | 否 | 是 | 是 |  |

### 示例学校（合成） / pesticide · 专属字段

| 路径 | 中文名 | 类型 | 单位 | 必现 | 可空 | 下发 | 说明 |
|---|---|---|---|---|---|---|---|
| `result.vegetableType` | 蔬菜品种 | string | — | 否 | 是 | 是 | 实测出现：该类型现有记录均出现（数据观察，非输出保证） |
| `result.batchNo` | 检测项目（检测卡/试剂） | string | — | 否 | 是 | 是 | 如「克百威-胶体金检测卡」；取值以学校配置为准；实测出现：该类型现有记录均出现（数据观察，非输出保证） |
| `result.result` | 结果文本 | string | — | 否 | 是 | 是 | 实测出现：该类型现有记录均出现（数据观察，非输出保证） |
| `result.remark` | 备注 | string | — | 否 | 是 | 是 | 实测出现：该类型现有记录均出现（数据观察，非输出保证） |
| `result.recheckRecords` | 复检记录 | array<object> | — | 否 | 是 | 是 | 有复检时才出现；结论看元素 `isPassed`（true=复检合格）与顶层 `final_conclusion`。元素中的 `user`（复检人姓名）**不下发**；；元素：id(序号)、time(复检时间字符串)、isPassed(是否通过 boolean)、points(点位明细 array) |

### 示例学校（合成） / oil · 专属字段

| 路径 | 中文名 | 类型 | 单位 | 必现 | 可空 | 下发 | 说明 |
|---|---|---|---|---|---|---|---|
| `result.colorLevel` | 综合品质等级 | enum（取值：合格 / 警戒 / 不合格） | — | 否 | 是 | 是 | ⚠️ **不是颜色**：由前端按「TPM 与酸价等级取最差」算出的综合等级（2026-09-16 实测 合格 38 / 警戒 1，无不合格）。结论口径：**仅「不合格」判不合格**，其余等级视为合格（与 `/stats` 同源）；实测出现：该类型现有记录均出现（数据观察，非输出保证） |
| `result.tpmValue` | TPM（极性组分） | string | g/100g（平台标注，未经设备协议核实） **⚠️未核实** | 否 | 是 | 是 | 字符串类型，平台按**原始录入值**保存（实测范围 0.06~0.20）。⚠️ `g/100g` 标注与阈值（≤0.13 合格 / ≤0.25 警戒 / >0.25 不合格）均为**当前实现/界面口径**，**未经设备协议或计量文件核实**：请勿自行换算，也不要据此字段重新判定历史结论。待补资料：设备型号/固件与协议版本、原始报文、设备显示值与平台保存值对照、阈值出处与批准记录；实测出现：该类型现有记录均出现（数据观察，非输出保证） |
| `result.acidValue` | 酸价值 | string | mg KOH/g（前端展示简写 mg/g） | 否 | 是 | 是 | ⚠️ 字符串类型；实测取值 空字符串 21 / 0.3 13 / 0 5。平台判定：<2.5 合格 / <5 警戒 / ≥5 不合格 |
| `result.oilTemp` | 油温 | string | ℃ | 否 | 是 | 是 | ⚠️ 字符串类型；实测恒为 35；实测出现：该类型现有记录均出现（数据观察，非输出保证） |
| `result.result` | 结果文本（兜底字段） | string | — | 否 | 是 | 是 | **实测 39/39 均为空字符串**——油品结论看 `colorLevel`；本字段仅作历史/其它来源的兜底（`/stats` 在 colorLevel 为空时才回退读它）；实测出现：该类型现有记录均出现（数据观察，非输出保证） |
| `result.remark` | 备注 | string | — | 否 | 是 | 是 | 实测出现：该类型现有记录均出现（数据观察，非输出保证） |
| `result.recheckRecords` | 复检记录 | array<object> | — | 否 | 是 | 是 | 有复检时才出现；结论看元素 `isPassed`（true=复检合格）与顶层 `final_conclusion`。元素中的 `user`（复检人姓名）**不下发**；；元素：id(序号)、time(复检时间字符串)、isPassed(是否通过 boolean)、points(点位明细 array) |

### 示例学校（合成） / leanMeat · 专属字段

| 路径 | 中文名 | 类型 | 单位 | 必现 | 可空 | 下发 | 说明 |
|---|---|---|---|---|---|---|---|
| `result.meatType` | 肉类品种 | string | — | 否 | 是 | 是 | 实测出现：该类型现有记录均出现（数据观察，非输出保证） |
| `result.batchNo` | 检测项目（检测卡） | string | — | 否 | 是 | 是 | 如「恩诺沙星-胶体金检测卡」；取值以学校配置为准；实测出现：该类型现有记录均出现（数据观察，非输出保证） |
| `result.result` | 结果文本 | string | — | 否 | 是 | 是 | 实测出现：该类型现有记录均出现（数据观察，非输出保证） |
| `result.remark` | 备注 | string | — | 否 | 是 | 是 | 实测出现：该类型现有记录均出现（数据观察，非输出保证） |
| `result.recheckRecords` | 复检记录 | array<object> | — | 否 | 是 | 是 | 有复检时才出现；结论看元素 `isPassed`（true=复检合格）与顶层 `final_conclusion`。元素中的 `user`（复检人姓名）**不下发**；；元素：id(序号)、time(复检时间字符串)、isPassed(是否通过 boolean)、points(点位明细 array) |

### 示例学校（合成） / pathogen · 专属字段

| 路径 | 中文名 | 类型 | 单位 | 必现 | 可空 | 下发 | 说明 |
|---|---|---|---|---|---|---|---|
| `result.riskLevel` | 风险等级 | enum（取值：无风险 / 低风险 / 极低风险） | — | 否 | 是 | 是 | 「无风险」为合格；**其它任何非空值一律视为不合格/有风险**（与 `/stats` 同口径；实测取值仅 无风险 48 / 低风险 9 / 极低风险 9，**没有"高风险"**）。⚠️ 「有风险」**不等于确诊阳性**——是否检出看 `result.positiveDetails`；实测出现：该类型现有记录均出现（数据观察，非输出保证） |
| `result.riskReason` | 风险原因 | string | — | 否 | 是 | 是 | 风险说明文本（实测长度 9~72）；实测出现：该类型现有记录均出现（数据观察，非输出保证） |
| `result.positiveItems` | 检出项目文本 | string | — | 否 | 是 | 是 | 有检出时为致病菌名称（可能多个，含分隔符；实测长度 14~46）；**无风险时为 1 字符占位（非空）**。判断是否检出请用 `result.positiveDetails`；实测出现：该类型现有记录均出现（数据观察，非输出保证） |
| `result.positiveDetails` | 检出明细 | array<object> | — | 否 | 是 | 是 | **是否检出的权威依据**：非空 ⟺ riskLevel ≠ 无风险（实测 18/18）；；元素：pathogen(致病菌名)、ct(number)、ctRaw(string)；实测出现：该类型现有记录均出现（数据观察，非输出保证） |
| `result.allTestItems` | 全部检测项 | array<object> | — | 否 | 是 | 是 | ；元素：no(序号，实测存在 number 与 string 两种)、channel(通道)、pathogen(致病菌名)、result(结果文本)、ct(string)、isInternalControl(是否内控 boolean)；实测出现：该类型现有记录均出现（数据观察，非输出保证） |
| `result.internalControlStatus` | 内控状态 | string | — | 否 | 是 | 是 | 实测出现：该类型现有记录均出现（数据观察，非输出保证） |
| `result.recheckReports` | 复检报告 | array<object> | — | 否 | 是 | 是 | 有复检时才出现；结论看 `isPassed`（true=复检合格）。元素中的 `user`（复检人姓名）**不下发**；；元素：id(序号)、time(复检时间字符串)、isPassed(是否通过 boolean)、user(复检人姓名，不下发) |
| `result.finalStatus` | 复检状态文本 | string | — | 否 | 是 | 是 | 当前 Web 复检可写「复检通过」或「复检低风险」；与 isPassed 冲突时以 isPassed 为准 |
| `result.sampleId` | 样品编号 | string | — | 否 | 是 | 是 | 2026-09-16 只读实测：66/66 条病原体记录均存在（此前字典漏登记）；实测出现：该类型现有记录均出现（数据观察，非输出保证） |
| `result.sampleType` | 样品类型 | string | — | 否 | 是 | 是 | 2026-09-16 只读实测：66/66 条均存在（此前字典漏登记）；实测出现：该类型现有记录均出现（数据观察，非输出保证） |
| `result.sampleInfo` | 样品说明 | string | — | 否 | 是 | 是 | ⚠️ **普通字符串**（实测长度 5~16 字符，例如样品别名；非 JSON、非对象），按文本处理，勿解析为对象（此前字典漏登记且曾被误判为"双重编码"）；实测出现：该类型现有记录均出现（数据观察，非输出保证） |

## 4. 合成样例（非真实数据）

> 以下为**构造样例**，`record_code` 以 `SAMPLE-` 前缀标记，请勿写入正式数据集；字段形态与真实响应一致（走与真实记录相同的投影）。

**场景含义（怎么用这些样例写测试）**：

| 类型 | 场景 | 含义 |
|---|---|---|
| tableware | `pass` | ATP 合格（`rluValue` < 200） |
| tableware | `fail` | ATP 不合格（`rluValue` > 500） |
| tableware | `recheck_passed` | 初检不合格 → 整改后复检合格：`initial_conclusion=fail`（或 `unknown`）、`final_conclusion=pass`、`final_conclusion_basis=recheck` |
| tableware | `sparse` | 字段稀疏（仅最小必填集）：**不要假设所有字段都会出现** |
| pesticide | `pass / fail` | 农残胶体金法合格 / 不合格（`result` 文本判定） |
| leanMeat | `pass / fail` | 肉蛋类合格 / 不合格 |
| oil | `pass` | `colorLevel=合格`（真实形态：TPM 0.06、酸价 0.3、油温 35） |
| oil | `fail` | `colorLevel=不合格`（合成构造：TPM 0.31 > 0.25、酸价 5.2 ≥ 5.0） |
| pathogen | `pass` | `riskLevel=无风险`、`positiveDetails=[]`、`positiveItems` 为占位符 |
| pathogen | `positive` | 检出：`riskLevel=低风险` + `positiveDetails` 非空（`is_positive=true`） |
| pathogen | `recheck_passed` | 初检检出 → 复检通过：`is_positive=true` 与 `final_conclusion=pass` **并存不矛盾**（阶段不同） |

### demo / tableware / pass

```json
{
  "record_id": "sample-tableware-pass",
  "record_code": "SAMPLE-tableware-pass",
  "school_code": "demo",
  "school_name": "示例学校（合成）",
  "test_type": "tableware",
  "test_name": "餐具洁净度检测",
  "test_date": "2026-01-15",
  "canteen": "示例食堂",
  "status": "completed",
  "initial_conclusion": "pass",
  "final_conclusion": "pass",
  "conclusion": "pass",
  "conclusion_text": "合格 (<200)",
  "conclusion_source": "stored",
  "final_conclusion_basis": "initial",
  "conclusion_conflict": false,
  "is_positive": null,
  "result": {
    "testType": "atp",
    "location": "餐具表面",
    "rluValue": "120",
    "result": "合格 (<200)",
    "atpPoints": [
      {
        "loc": "餐具表面",
        "rlu": "120",
        "res": "合格"
      }
    ],
    "correctiveAction": "",
    "recheckResult": ""
  },
  "created_at": "2026-01-15T00:00:00.000+08:00",
  "updated_at": "2026-01-15T00:00:00.000+08:00",
  "change_token": "2026-01-14T16:00:00.000Z|v1",
  "data_version": 1
}
```

### demo / tableware / fail

```json
{
  "record_id": "sample-tableware-fail",
  "record_code": "SAMPLE-tableware-fail",
  "school_code": "demo",
  "school_name": "示例学校（合成）",
  "test_type": "tableware",
  "test_name": "餐具洁净度检测",
  "test_date": "2026-01-15",
  "canteen": "示例食堂",
  "status": "completed",
  "initial_conclusion": "fail",
  "final_conclusion": "fail",
  "conclusion": "fail",
  "conclusion_text": "不合格 (>500)",
  "conclusion_source": "stored",
  "final_conclusion_basis": "initial",
  "conclusion_conflict": false,
  "is_positive": null,
  "result": {
    "testType": "atp",
    "location": "砧板表面",
    "rluValue": "614",
    "result": "不合格 (>500)",
    "atpPoints": [
      {
        "loc": "砧板表面",
        "rlu": "614",
        "res": "不合格"
      }
    ],
    "correctiveAction": "已重新清洗消毒",
    "recheckResult": ""
  },
  "created_at": "2026-01-15T00:00:00.000+08:00",
  "updated_at": "2026-01-15T00:00:00.000+08:00",
  "change_token": "2026-01-14T16:00:00.000Z|v1",
  "data_version": 1
}
```

### demo / tableware / recheck_passed

```json
{
  "record_id": "sample-tableware-recheck_passed",
  "record_code": "SAMPLE-tableware-recheck_passed",
  "school_code": "demo",
  "school_name": "示例学校（合成）",
  "test_type": "tableware",
  "test_name": "餐具洁净度检测",
  "test_date": "2026-01-15",
  "canteen": "示例食堂",
  "status": "completed",
  "initial_conclusion": "unknown",
  "final_conclusion": "pass",
  "conclusion": "pass",
  "conclusion_text": "整改后复检合格",
  "conclusion_source": "stored",
  "final_conclusion_basis": "recheck",
  "conclusion_conflict": false,
  "is_positive": null,
  "result": {
    "testType": "atp",
    "location": "砧板表面",
    "rluValue": "96",
    "result": "合格",
    "finalStatus": "整改后复检合格",
    "recheckRecords": [
      {
        "id": 1,
        "time": "2026-01-15 15:30",
        "isPassed": true,
        "points": [
          {
            "loc": "砧板表面",
            "rlu": "96",
            "res": "合格"
          }
        ]
      }
    ],
    "atpPoints": [
      {
        "loc": "砧板表面",
        "rlu": "96",
        "res": "合格"
      }
    ],
    "correctiveAction": "已重新清洗消毒",
    "recheckResult": "复检合格"
  },
  "created_at": "2026-01-15T00:00:00.000+08:00",
  "updated_at": "2026-01-15T15:31:00.000+08:00",
  "change_token": "2026-01-15T07:31:00.000Z|v1",
  "data_version": 1
}
```

### demo / tableware / sparse

```json
{
  "record_id": "sample-tableware-sparse",
  "record_code": "SAMPLE-tableware-sparse",
  "school_code": "demo",
  "school_name": "示例学校（合成）",
  "test_type": "tableware",
  "test_name": "餐具洁净度检测",
  "test_date": "2026-01-15",
  "canteen": "示例食堂",
  "status": "completed",
  "initial_conclusion": "pass",
  "final_conclusion": "pass",
  "conclusion": "pass",
  "conclusion_text": "合格 (<200)",
  "conclusion_source": "stored",
  "final_conclusion_basis": "initial",
  "conclusion_conflict": false,
  "is_positive": null,
  "result": {
    "result": "合格 (<200)",
    "rluValue": "80",
    "correctiveAction": "",
    "recheckResult": ""
  },
  "created_at": "2026-01-15T00:00:00.000+08:00",
  "updated_at": "2026-01-15T00:00:00.000+08:00",
  "change_token": "2026-01-14T16:00:00.000Z|v1",
  "data_version": 1
}
```

### demo / pesticide / pass

```json
{
  "record_id": "sample-pesticide-pass",
  "record_code": "SAMPLE-pesticide-pass",
  "school_code": "demo",
  "school_name": "示例学校（合成）",
  "test_type": "pesticide",
  "test_name": "果蔬农残检测",
  "test_date": "2026-01-15",
  "canteen": "示例食堂",
  "status": "completed",
  "initial_conclusion": "pass",
  "final_conclusion": "pass",
  "conclusion": "pass",
  "conclusion_text": "合格",
  "conclusion_source": "stored",
  "final_conclusion_basis": "initial",
  "conclusion_conflict": false,
  "is_positive": null,
  "result": {
    "vegetableType": "白菜（示例）",
    "batchNo": "克百威-胶体金检测卡",
    "result": "合格",
    "remark": ""
  },
  "created_at": "2026-01-15T00:00:00.000+08:00",
  "updated_at": "2026-01-15T00:00:00.000+08:00",
  "change_token": "2026-01-14T16:00:00.000Z|v1",
  "data_version": 1
}
```

### demo / pesticide / fail

```json
{
  "record_id": "sample-pesticide-fail",
  "record_code": "SAMPLE-pesticide-fail",
  "school_code": "demo",
  "school_name": "示例学校（合成）",
  "test_type": "pesticide",
  "test_name": "果蔬农残检测",
  "test_date": "2026-01-15",
  "canteen": "示例食堂",
  "status": "completed",
  "initial_conclusion": "fail",
  "final_conclusion": "fail",
  "conclusion": "fail",
  "conclusion_text": "不合格",
  "conclusion_source": "stored",
  "final_conclusion_basis": "initial",
  "conclusion_conflict": false,
  "is_positive": null,
  "result": {
    "vegetableType": "豇豆（示例）",
    "batchNo": "水胺硫磷-胶体金检测卡",
    "result": "不合格",
    "remark": "已下架处理"
  },
  "created_at": "2026-01-15T00:00:00.000+08:00",
  "updated_at": "2026-01-15T00:00:00.000+08:00",
  "change_token": "2026-01-14T16:00:00.000Z|v1",
  "data_version": 1
}
```

### demo / oil / pass

```json
{
  "record_id": "sample-oil-pass",
  "record_code": "SAMPLE-oil-pass",
  "school_code": "demo",
  "school_name": "示例学校（合成）",
  "test_type": "oil",
  "test_name": "食用油品质检测",
  "test_date": "2026-01-15",
  "canteen": "示例食堂",
  "status": "completed",
  "initial_conclusion": "pass",
  "final_conclusion": "pass",
  "conclusion": "pass",
  "conclusion_text": "合格",
  "conclusion_source": "stored",
  "final_conclusion_basis": "initial",
  "conclusion_conflict": false,
  "is_positive": null,
  "result": {
    "colorLevel": "合格",
    "tpmValue": "0.06",
    "acidValue": "0.3",
    "oilTemp": "35",
    "remark": "",
    "result": ""
  },
  "created_at": "2026-01-15T00:00:00.000+08:00",
  "updated_at": "2026-01-15T00:00:00.000+08:00",
  "change_token": "2026-01-14T16:00:00.000Z|v1",
  "data_version": 1
}
```

### demo / oil / fail

```json
{
  "record_id": "sample-oil-fail",
  "record_code": "SAMPLE-oil-fail",
  "school_code": "demo",
  "school_name": "示例学校（合成）",
  "test_type": "oil",
  "test_name": "食用油品质检测",
  "test_date": "2026-01-15",
  "canteen": "示例食堂",
  "status": "completed",
  "initial_conclusion": "fail",
  "final_conclusion": "fail",
  "conclusion": "fail",
  "conclusion_text": "不合格",
  "conclusion_source": "stored",
  "final_conclusion_basis": "initial",
  "conclusion_conflict": false,
  "is_positive": null,
  "result": {
    "colorLevel": "不合格",
    "tpmValue": "0.31",
    "acidValue": "5.2",
    "oilTemp": "35",
    "remark": "建议更换食用油",
    "result": ""
  },
  "created_at": "2026-01-15T00:00:00.000+08:00",
  "updated_at": "2026-01-15T00:00:00.000+08:00",
  "change_token": "2026-01-14T16:00:00.000Z|v1",
  "data_version": 1
}
```

### demo / leanMeat / pass

```json
{
  "record_id": "sample-leanMeat-pass",
  "record_code": "SAMPLE-leanMeat-pass",
  "school_code": "demo",
  "school_name": "示例学校（合成）",
  "test_type": "leanMeat",
  "test_name": "肉、蛋农残检测",
  "test_date": "2026-01-15",
  "canteen": "示例食堂",
  "status": "completed",
  "initial_conclusion": "pass",
  "final_conclusion": "pass",
  "conclusion": "pass",
  "conclusion_text": "合格",
  "conclusion_source": "stored",
  "final_conclusion_basis": "initial",
  "conclusion_conflict": false,
  "is_positive": null,
  "result": {
    "meatType": "猪肉",
    "batchNo": "恩诺沙星-胶体金检测卡",
    "result": "合格",
    "remark": ""
  },
  "created_at": "2026-01-15T00:00:00.000+08:00",
  "updated_at": "2026-01-15T00:00:00.000+08:00",
  "change_token": "2026-01-14T16:00:00.000Z|v1",
  "data_version": 1
}
```

### demo / leanMeat / fail

```json
{
  "record_id": "sample-leanMeat-fail",
  "record_code": "SAMPLE-leanMeat-fail",
  "school_code": "demo",
  "school_name": "示例学校（合成）",
  "test_type": "leanMeat",
  "test_name": "肉、蛋农残检测",
  "test_date": "2026-01-15",
  "canteen": "示例食堂",
  "status": "completed",
  "initial_conclusion": "fail",
  "final_conclusion": "fail",
  "conclusion": "fail",
  "conclusion_text": "不合格",
  "conclusion_source": "stored",
  "final_conclusion_basis": "initial",
  "conclusion_conflict": false,
  "is_positive": null,
  "result": {
    "meatType": "鸡肉",
    "batchNo": "氟苯尼考-胶体金检测卡",
    "result": "不合格",
    "remark": "已停用该批次"
  },
  "created_at": "2026-01-15T00:00:00.000+08:00",
  "updated_at": "2026-01-15T00:00:00.000+08:00",
  "change_token": "2026-01-14T16:00:00.000Z|v1",
  "data_version": 1
}
```

### demo / pathogen / pass

```json
{
  "record_id": "sample-pathogen-pass",
  "record_code": "SAMPLE-pathogen-pass",
  "school_code": "demo",
  "school_name": "示例学校（合成）",
  "test_type": "pathogen",
  "test_name": "病原体检测",
  "test_date": "2026-01-15",
  "canteen": "示例食堂",
  "status": "completed",
  "initial_conclusion": "pass",
  "final_conclusion": "pass",
  "conclusion": "pass",
  "conclusion_text": "无风险",
  "conclusion_source": "stored",
  "final_conclusion_basis": "initial",
  "conclusion_conflict": false,
  "is_positive": false,
  "result": {
    "sampleId": "SAMPLE-PATH-001",
    "sampleType": "表面涂抹样（示例）",
    "sampleInfo": "留样复检（示例）",
    "riskLevel": "无风险",
    "riskReason": "",
    "positiveItems": "-",
    "positiveDetails": [],
    "internalControlStatus": "有效",
    "allTestItems": [
      {
        "no": 1,
        "channel": "A1",
        "pathogen": "沙门氏菌（示例）",
        "result": "未检出",
        "ct": "",
        "isInternalControl": false
      },
      {
        "no": 2,
        "channel": "A2",
        "pathogen": "内控（示例）",
        "result": "正常",
        "ct": "",
        "isInternalControl": true
      }
    ]
  },
  "created_at": "2026-01-15T00:00:00.000+08:00",
  "updated_at": "2026-01-15T00:00:00.000+08:00",
  "change_token": "2026-01-14T16:00:00.000Z|v1",
  "data_version": 1
}
```

### demo / pathogen / positive

```json
{
  "record_id": "sample-pathogen-positive",
  "record_code": "SAMPLE-pathogen-positive",
  "school_code": "demo",
  "school_name": "示例学校（合成）",
  "test_type": "pathogen",
  "test_name": "病原体检测",
  "test_date": "2026-01-15",
  "canteen": "示例食堂",
  "status": "completed",
  "initial_conclusion": "fail",
  "final_conclusion": "fail",
  "conclusion": "fail",
  "conclusion_text": "低风险",
  "conclusion_source": "stored",
  "final_conclusion_basis": "initial",
  "conclusion_conflict": false,
  "is_positive": true,
  "result": {
    "sampleId": "SAMPLE-PATH-002",
    "sampleType": "表面涂抹样（示例）",
    "sampleInfo": "疑似阳性复核（示例）",
    "riskLevel": "低风险",
    "riskReason": "检出沙门氏菌（示例）",
    "positiveItems": "沙门氏菌（示例）",
    "positiveDetails": [
      {
        "pathogen": "沙门氏菌（示例）",
        "ct": 21.5,
        "ctRaw": "21.5"
      }
    ],
    "internalControlStatus": "有效",
    "allTestItems": [
      {
        "no": 1,
        "channel": "A1",
        "pathogen": "沙门氏菌（示例）",
        "result": "检出",
        "ct": "21.5",
        "isInternalControl": false
      }
    ]
  },
  "created_at": "2026-01-15T00:00:00.000+08:00",
  "updated_at": "2026-01-15T00:00:00.000+08:00",
  "change_token": "2026-01-14T16:00:00.000Z|v1",
  "data_version": 1
}
```

### demo / pathogen / recheck_passed

```json
{
  "record_id": "sample-pathogen-recheck_passed",
  "record_code": "SAMPLE-pathogen-recheck_passed",
  "school_code": "demo",
  "school_name": "示例学校（合成）",
  "test_type": "pathogen",
  "test_name": "病原体检测",
  "test_date": "2026-01-15",
  "canteen": "示例食堂",
  "status": "completed",
  "initial_conclusion": "unknown",
  "final_conclusion": "pass",
  "conclusion": "pass",
  "conclusion_text": "复检通过",
  "conclusion_source": "stored",
  "final_conclusion_basis": "recheck",
  "conclusion_conflict": false,
  "is_positive": true,
  "result": {
    "sampleId": "SAMPLE-PATH-003",
    "sampleType": "表面涂抹样（示例）",
    "sampleInfo": "整改后复检（示例）",
    "riskLevel": "无风险",
    "finalStatus": "复检通过",
    "riskReason": "初检检出沙门氏菌（示例）",
    "positiveItems": "沙门氏菌（示例）",
    "positiveDetails": [
      {
        "pathogen": "沙门氏菌（示例）",
        "ct": 21.5,
        "ctRaw": "21.5"
      }
    ],
    "recheckReports": [
      {
        "id": 1,
        "time": "2026-01-15 16:00",
        "isPassed": true
      }
    ],
    "internalControlStatus": "有效",
    "allTestItems": [
      {
        "no": 1,
        "channel": "A1",
        "pathogen": "沙门氏菌（示例）",
        "result": "未检出",
        "ct": "",
        "isInternalControl": false
      }
    ]
  },
  "created_at": "2026-01-15T00:00:00.000+08:00",
  "updated_at": "2026-01-15T16:00:00.000+08:00",
  "change_token": "2026-01-15T08:00:00.000Z|v1",
  "data_version": 1
}
```

## 5. 业务口径与判定规则（务必按此实现）

**结论字段**（每类型都返回）：`initial_conclusion`（初检）/ `final_conclusion`（最终）/ `conclusion`（对外统一，等于最终）/ `final_conclusion_basis`（`initial` = 无复检沿用初检；`recheck` = 由复检覆盖）/ `conclusion_conflict`（复检结论冲突时为 true）。

**合格判定（与 `/stats` 同源；按保存值，不按当前阈值重判）**：

| 类型 | 判定 |
|---|---|
| 餐具洁净度 | 顶层 `result` 有文本 → 含「合格」且不含「不合格」为合格；**顶层为空时回退 `result.atpPoints[].res`**（洗涤剂残留记录只写点位结论）：任一点位「不合格」→ 不合格；所有点位「合格」→ 合格；其余（警戒/无结论）→ 未判定、不计合格 |
| 果蔬 / 肉蛋 | `result` 文本含「合格」且不含「不合格」→ 合格 |
| 食用油 | 先看 `result.colorLevel`（综合品质等级）：`合格` / `警戒` → 合格；`不合格` → 不合格；**其它未识别值回退 `result` 文本** |
| 病原体 | `result.riskLevel = 无风险` → 合格；**其它任何非空值 → 不合格/有风险**。⚠️ 「有风险」≠ 确诊阳性（是否检出看 `result.positiveDetails` 是否非空） |

**统计口径（`GET /stats`）**：

- 集合恒等式：`universe_total = scope_total + request_out_of_range_total + excluded_total`（授权可见全集 = 入分母 + 请求范围外 + 无法定位业务日期）。
- `pass_rate = pass_count / scope_total`；**分母为 0 时返回 `null`**（不返回 0，避免被读成"全部不合格"）。
- **`unknown` 计入分母**（v1 口径）：`pass_rate` 低于 1 **不等于**其余记录都不合格，请用 `conclusion` 分布解释差值。
- `metric_basis = stored_current_result`：按**当前保存的** `result`/`colorLevel`/`riskLevel` 判定；部分 Web 复检会覆盖这些字段，因此它**不承诺等同初检指标**，也不在所有类型上等同最终结论（需独立初检/最终指标的，请与平台约定新字段方案）。
- 授权业务日期范围**外**的记录不出现在任何字段中（连数量也不可推断）；日期范围 = 授权范围 ∩ 请求范围，闭区间。

**复检记录的阶段语义（同一条记录里各字段属于不同阶段，并存不矛盾）**：

| 字段 | 阶段 | 说明 |
|---|---|---|
| `result.riskLevel` / `result.positiveDetails` / `result.positiveItems` | **初检证据** | 初检留下的风险等级与检出明细；复检不会重写这些证据 |
| `is_positive` | **初检检出证据** | `positiveDetails` 非空 ⟺ `true`；该键缺失时按 `riskLevel ≠ 无风险` 兜底。**不是复检结论、也不等于确诊** |
| `initial_conclusion` | 初检结论 | 无独立初检快照时（原值已被复检覆盖）为 `unknown`，**不逆推** |
| `final_conclusion` / `conclusion` / `final_conclusion_basis` | **最终结论** | 有复检时取最新复检的 `isPassed`（`basis=recheck`）；判断"当前是否合格"只看这里 |

- 因此 `initial_conclusion=unknown` + `final_conclusion=pass` + `is_positive=true` 是**正常组合**（初检快照被覆盖 / 初检检出证据仍在 / 复检通过）。
- 复检结论优先取结构化 `recheckReports[].isPassed`（或 `recheckRecords[].isPassed`）；`finalStatus` 等文本字段仅作兼容兜底，冲突时以结构化字段为准。

**单位与数值**：数值类字段一律为**字符串且为原始录入口径**（平台不做换算、不做缩放）。`result.tpmValue` 的 `unit`（g/100g）与阈值均属**平台界面标注**（`unit_verified=false`，未经设备协议/计量文件核实）——请勿自行 ×100 / ÷100，也不要据此重新判定历史结论。

## 6. 同步规则（必读）

**每轮顺序（请不要颠倒，尤其是"删除判定"必须在一致性校验通过之后）**：

1. 取本轮范围与初始指纹：`GET /sync/manifest?school_code=<校>`（只取 `total` + `digest`）。
   `digest` 覆盖：游标协议版本 + `scope_version` + `projection_fingerprint` + 每条 `record_code@change_token`。
2. 客户端已按新版协议完整同步、且 `digest` 与本地保存的一致 → **本轮结束**（不拉明细、不做任何删除）。旧状态需先完整重拉。
3. `digest` 变化 → 带 `detail=1` 拉**完整清单**。若返回 `413` 或任何错误，**不得当作空清单**，按第 7 条处理。
4. 按 `change_token` 比较逐条变化；投影/授权变化、旧状态升级，或摘要变化但逐条无差异时，必须完整重拉。拉取明细后按 `record_code` **整体覆盖**候选记录。
5. 结束前**再取一次** `manifest`：与第 1 步的 `digest` 不一致 → 说明本轮期间数据又变了：**丢弃本轮暂存结果并重跑一轮**。
6. 两读一致 → 本轮才算成功：此时才提交暂存结果、执行"缺失记录"处理（见下）、保存水位与游标。
7. 任何一步失败（401/403/409/429/超时/解析失败/分页中断）→ **保留上一轮完成状态与水位**，退避后重试；**重试必须有上限**（建议指数退避：单轮最多 5 次、总时长 ≤ 10 分钟），仍失败则放弃本轮并告警，不要无限重跑。

**"清单里没有" ≠ "源记录被物理删除"**：记录可能因**业务日期范围、状态、类型可见性**变化而移出当前有效范围。统一表述为「**当前有效范围内已不可见**」→ 按双方约定标记撤回/不可见；接口未给出删除原因时，**不要推断源端发生了物理删除**。

**`next_cursor` 语义（写代码前必读）**：
- 只在**成功处理完一页之后**保存 `next_cursor`；不要预先保存；
- 最后一页 `has_more:false`、`next_cursor:null` → **清空本地游标**，下一轮从 `manifest` 重新对账；
- 游标**不是**下一轮水位：它绑定「学校 + 筛选条件 + `scope_version` + `projection_fingerprint` + 水位 `(updated_at,id)`」，换学校/换筛选条件/授权或字段可见性变化后必须丢弃（否则 400 / 409）；
- 游标无固定有效期，但**不建议跨轮次长期保存**：每轮以 `manifest` 为准，游标仅用于单轮内翻页与断点续传；
- 若清单显示某条记录已变更，但你方水位已越过它：用 `since=<字符串时间>` 做**重叠回拉**（建议回退 5 分钟）并幂等去重。

**增量依据**：`updated_at` 用于**记录变更排序**（排序键 `(updated_at ASC, id ASC)`，同一时间戳靠 `id` 决胜）；**完整同步还必须结合服务端游标、`scope_version` 与清单 `digest` 对账**，不得仅凭 `updated_at` 判定同步完成（`created_at` 对历史导入数据可能等于业务日期零点，**不可**用于增量）。

**字段撤回与记录级字段减少**：授权关闭「检测人姓名」后，新响应不再包含该字段；此外平台可能对**单条记录**做规范化（如移除 `result` 内的历史同义副本），此时只有 `updated_at`/`digest` 变化，`projection_fingerprint` **不变**。两种情况都按同一条规则处理：**凡重新获取到的记录，一律以新响应的完整对象整体覆盖本地同 `record_code` 记录**（并清除新响应中已不存在的字段）；本接口只返回完整对象，不存在"部分响应"语义。你方自有业务字段请单独存放，避免被平台对象覆盖。

收到 `409 SCOPE_CHANGED`（授权或字段可见性变化 / 游标过旧）→ 回到第 1 步重新对账，并重新拉取全部明细以重新投影。
旧客户端升级：丢弃跨轮旧游标，保留旧数据与旧摘要作回滚点，使用新客户端完整拉取并替换本校记录；两次摘要一致后才原子提交新版摘要、记录和水位。学校改名也会改变投影指纹并触发重投影。

## 7. 错误码与处理动作

| HTTP | code | 含义 | 你方应做什么 |
|---|---|---|---|
| 401 | `MISSING_KEY / INVALID_KEY / CREDENTIAL_REVOKED / CREDENTIAL_EXPIRED` | 未携带 / 无效 / 已吊销 / 已过期 | **不要重试**：检查密钥配置与是否已轮换；必要时联系平台换新密钥 |
| 403 | `CLIENT_DISABLED / IP_DENIED` | 对接方被停用 / 来源 IP 不在白名单 | **不要重试**：核对密钥归属与出口 IP；需要变更请联系平台 |
| 403 | `SCHOOL_NOT_AUTHORIZED / TYPE_NOT_AUTHORIZED / NO_VISIBLE_TYPE` | 未授权学校 / 未授权类型 / 该校当前零权限 | **不要重试**：以 `GET /profile` 为准核对授权范围；需要新增请联系平台 |
| 404 | `SCHOOL_NOT_FOUND` | 学校代码不存在 | 核对 `school_code`（用 `/schools` 列表） |
| 400 | `INVALID_SCHOOL_CODE / INVALID_CURSOR / CURSOR_SCHOOL_MISMATCH / CURSOR_FILTER_MISMATCH` | 学校代码非法 / 游标非法 / 换学校或换筛选条件复用游标 | 丢弃本地游标，改从 `manifest` 重新对账后重拉 |
| 400 | `INVALID_START / INVALID_END / INVALID_RANGE / INVALID_SINCE / INVALID_UNTIL` | 日期或时间参数非法 / 起止倒置 | 按 `YYYY-MM-DD` 修正；`start` 不得晚于 `end` |
| 409 | `SCOPE_CHANGED` | 授权或字段可见性变化、游标协议过旧 | 重新对账 + **全量重拉并替换式重投影**（不要指望增量补齐被撤回的字段） |
| 413 | `MANIFEST_TOO_LARGE` | 清单超单次上限（明确拒绝，不返回截断清单） | **不得当作空清单**：停止对账并联系平台改用分页清单方案 |
| 429 | `RATE_LIMITED` | 触发限流 | 按 `Retry-After` 退避（配合指数退避），降低并发与频率 |
| 500 | `INTERNAL_ERROR / AUTH_ERROR` | 平台侧异常 | 有界重试（指数退避 + 上限，单轮 ≤ 5 次）；期间**保留旧水位**；持续失败联系平台 |
| 5xx / 超时 | — | 平台侧异常 | 有界重试（指数退避 + 上限）；期间**保留旧水位**；持续失败联系平台 |

## 8. 常见错误与排查（FAQ）

**Q：返回 401「缺少授权令牌」——是密钥失效了吗？**

多半是**地址拼错**：基址已含 `/api/open/v1`，再拼一次变成 `/api/open/v1/v1/ping` 时会落到需要登录态的其它路由。正确：`https://<域名>/api/open/v1/ping`。若地址正确仍 401，再核对密钥是否被吊销/过期。

**Q：401 和 403 该怎么区分处理？**

401 = 密钥问题（未携带/无效/吊销/过期）→ **不要重试**，先修配置；403 = 权限与来源问题（对接方停用、IP 白名单、学校或类型未授权、该校零权限）→ **不要重试**，以 `GET /profile` 为准核对后联系平台。

**Q：`limit=0` 或 `limit=abc` 会报错吗？**

不会。缺失 / 非数字 / `0` 一律按默认值 **100** 处理，上限 **200**。要翻页请以响应里的 `has_more` 与 `next_cursor` 为准。

**Q：最后一页之后，下一轮增量要从哪里开始？**

`next_cursor=null` 表示本轮翻页结束 → **清空本地游标**；下一轮一律从 `GET /sync/manifest` 的 `total`+`digest` 对账开始，不沿用上一轮游标（换学校/换筛选/授权变化后沿用会 400/409）。

**Q：清单里少了一条，可以删本地记录吗？**

**不能直接删**。先确认本轮完整性与一致性（`digest` 二读一致、无 413/超时/部分清单），再把"清单中不存在"表述为「当前有效范围内已不可见」，按双方约定标记撤回；接口不提供删除原因，不要推断源端物理删除。

**Q：`/samples` 的样例能直接入库吗？**

**不能**。样例是构造数据（`record_code` 以 `SAMPLE-` 开头、`synthetic:true`），仅用于无真实数据时开发联调；请勿写入正式数据集。

**Q：`is_positive=true` 是不是表示当前不合格？**

不是。`is_positive` 是**初检阶段的检出证据**（`positiveDetails` 非空 ⟺ true），复检合格后它可能仍为 `true`。判断"当前是否合格"请看 `final_conclusion`（或等价的 `conclusion`）。

**Q：字典里 `required` 为 `true` 的字段，能建 NOT NULL 吗？**

可以，但仅限**顶层字段**（服务端投影保证）。`result.*` 字段的 `required` 恒为 `false`（来自保存的检测数据），说明里的「实测出现：…」只是数据观察，不能当必填契约。

**Q：单位标注可以直接换算使用吗？**

不能。带 `⚠️未核实` 的单位（如 `result.tpmValue` 的 `g/100g`）只是**平台界面标注**，未经设备协议/计量文件核实；平台按原始录入值保存，请勿 ×100 / ÷100，也不要据此重判历史结论。

**Q：`pass_rate` 是 40%，是否表示另外 60% 不合格？**

不是。`unknown`（未判定）记录**计入分母**；请用响应里的 `conclusion` 分布解释差值。按已判定记录计算属指标语义变更，需与平台另行约定。

## 9. 接入自检清单（可逐项勾选）

> 建议在联调开始、以及每次平台侧发布后各跑一遍；每项都给出可判定的期望值。

- [ ] `GET /ping` 带密钥 —— 期望：200，且 `data.server_time` 与你的时钟偏差可接受
- [ ] `GET /ping` 不带密钥 / 用错误密钥 —— 期望：`401 MISSING_KEY` / `401 INVALID_KEY`
- [ ] `GET /profile`、`GET /schools` —— 期望：200，且学校与类型范围与接入包快照一致（**不一致时以 `/profile` 为准**）
- [ ] `GET /test-records?school_code=<未授权校>` —— 期望：`403 SCHOOL_NOT_AUTHORIZED`（拿不到数据）
- [ ] `GET /dict`、`GET /samples` —— 期望：200；样例带 `synthetic:true` 与 `SAMPLE-` 前缀，字段都能在字典里找到定义
- [ ] `GET /test-records?limit=2` 逐页取完 —— 期望：各页 `record_code` 无重复；末页 `has_more:false`、`next_cursor:null`；去重总数 == `manifest.total`
- [ ] 重复请求第 2 页游标 —— 期望：200，且 `items` 与首次完全一致（游标幂等）
- [ ] `cursor=garbage` / 换 `test_type` 复用游标 —— 期望：`400 INVALID_CURSOR` / `400 CURSOR_FILTER_MISMATCH`
- [ ] 各页 `projection_fingerprint` 与 `manifest` 对比 —— 期望：同源一致（不一致说明期间授权/字段可见性变了，需重投影）
- [ ] `GET /stats` —— 期望：`universe_total == scope_total + request_out_of_range_total + excluded_total`；分母为 0 时 `pass_rate=null`
- [ ] `GET /stats?start=2099-01-01&end=2099-01-02` —— 期望：200 且 `scope_total=0`、`pass_rate=null`（**不得 500**）
- [ ] `start=abc` / `start>end` —— 期望：`400 INVALID_START` / `400 INVALID_RANGE`
- [ ] 抽样 3~5 条记录与平台人工核对 —— 期望：字段、结论、复检阶段语义一致（不合格与复检各至少 1 条）
- [ ] 异常路径演练 —— 期望：断网/超时/429/413 时本地状态不推进、不误删；重试有上限

> ⚠️ 停用对接方、吊销密钥、收紧授权都只能阻止**后续读取**：对方已下载到其数据库的数据不会自动消失，需按双方约定另行通知清理 —— 本系统无法代其删除。
