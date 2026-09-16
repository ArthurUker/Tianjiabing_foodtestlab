# foodSentinel 开放接口 · 接入包

- 对接方：**示例对接方**
- 契约版本：`v1`
- 生成时间：2026-09-16T06:21:23.208Z
- ⚠️ 本文件中的**开放范围是生成时的授权快照**（学校代码：test）；**实际生效权限一律以 `GET /profile` 为准**（平台可能在此之后调整授权），本快照也不代表其它学校已开通。
- ⚠️ 本文件**不包含任何密钥**：API Key 由平台超管通过安全渠道单独提供，明文只在生成时显示一次。

## 0. 快速开始（可直接复制运行）

```bash
# ① 连通性 + 服务器时间（对账时钟）
curl -s -H "X-API-Key: $KEY" https://foodsentinel.digifluidic.com/api/open/v1/ping

# ② 确认当前授权范围（学校 / 类型 / 字段开关 / scope_version / projection_fingerprint）
curl -s -H "X-API-Key: $KEY" https://foodsentinel.digifluidic.com/api/open/v1/profile

# ③ 取字段字典（据此写映射：是否下发、单位、结论枚举、自定义字段）
curl -s -H "X-API-Key: $KEY" "https://foodsentinel.digifluidic.com/api/open/v1/dict?school_code=<校>"

# ④ 拉第一页记录（limit ≤ 200；看 has_more / next_cursor）
curl -s -H "X-API-Key: $KEY" "https://foodsentinel.digifluidic.com/api/open/v1/test-records?school_code=<校>&limit=200"

# ⑤ 对账清单（total + digest；detail=1 附全量 {record_code, updated_at}）
curl -s -H "X-API-Key: $KEY" "https://foodsentinel.digifluidic.com/api/open/v1/sync/manifest?school_code=<校>"
```

> `$KEY` 即平台提供的密钥明文（形如 `oap_…`）。**认证只有一种密钥**，可用下面两种方式之一携带；两者同时出现时以 `X-API-Key` 为准。

**分页响应外层结构**（`GET /test-records`，注意外层是 `data`，单条记录在 `data.items[]`）：
```json
{ "code": 0, "data": { "school_code": "<校>", "scope_version": 1, "projection_fingerprint": "…",
    "count": 200, "has_more": true, "next_cursor": "<最后一页为 null>",
    "server_time": "2026-09-16T12:00:00+08:00", "items": [ { "…": "单条记录对象（见 §4 样例）" } ] } }
```
**清单响应外层结构**（`GET /sync/manifest`，`detail=1` 时才有 `items`）：
```json
{ "code": 0, "data": { "total": 1129, "complete": true, "digest": "…",
    "digest_covers": "cursor_version+scope_version+projection_fingerprint+record_code@updated_at",
    "generated_at": "2026-09-16T12:00:00+08:00",
    "items": [ { "record_code": "RC-…", "updated_at": "2026-09-16T11:05:00+08:00" } ] } }
```

## 1. 接口地址与认证

- 基址：`https://foodsentinel.digifluidic.com/api/open/v1`
- 认证（**同一个密钥**，二选一携带方式）：`X-API-Key: <密钥>` 或 `Authorization: Bearer <密钥>`；必须 HTTPS。
- 限流：默认 60 次/分钟（超限返回 429，请按 `Retry-After` 退避）。
- 分页参数：`limit` 默认 **100**、上限 **200**；`limit` 缺失 / 非数字 / `0` 一律**回退默认值**（不报错，兼容既有调用行为）。
- 日期参数（`start` / `end`）：接受 `YYYY-MM-DD` 或 ISO8601 日期时间（取日期部分），**两端含当天**；非法日期返回 `400 INVALID_START` / `INVALID_END`，`start > end` 返回 `400 INVALID_RANGE`；请求范围与授权业务日期范围**求交集**（请求不能越过授权范围）。
- `projection_fingerprint`（字段可见性指纹）在 `/test-records`、`/samples`、`/sync/manifest` 响应中返回，**`/profile` 不含**该字段。
- 所有成功响应为 `{ "code": 0, "data": {...} }`；失败为 `{ "code": "<错误码>", "error": "..." }`。

| 端点 | 说明 |
|---|---|
| `GET /ping` | 连通性 + 服务器时间 |
| `GET /profile` | 当前密钥的授权范围（每校 scope_version / 类型 / 日期范围 / 字段开关；**不含** projection_fingerprint） |
| `GET /schools` | 授权学校清单 |
| `GET /dict?school_code=` | 字典：类型、食堂、结论枚举、**字段字典** |
| `GET /samples?school_code=&test_type=` | **合成样例**（非真实数据，可在无数据时开发） |
| `GET /sync/manifest?school_code=[&detail=1]` | 全量清单（total + digest）；`detail=1` 附明细用于对账 |
| `GET /test-records?school_code=&cursor=&limit=` | 检测记录增量拉取（游标分页） |
| `GET /stats?school_code=&start=&end=` | 合格率统计（含排除原因，可对账） |

## 2. 当前已保存的开放范围

| 学校 | 学校代码 | 开放类型 | 业务日期范围 | 检测人姓名 | 病原体 | scope_version |
|---|---|---|---|---|---|---|
| 测试学校 | `test` | tableware、oil、pathogen | 不限 ~ 不限 | 不下发 | 开放 | 1 |

## 3. 字段字典

> 读表须知：
> - **必现**只是**当前数据分布观察**（是 = 该类型现有记录都出现），**不是接口输出保证**——请勿据此建必填模型，容错解析以「可空」「下发」为准。
> - **可空**：字段存在但值可能为 `null`。**三态区分**：字段**省略**（不存在）≠ `null`（存在无值）≠ 空串/空数组（有值为空）。
> - **下发=否** 的字段**不会出现在响应中**，列出仅为说明原始存储结构（如 `result.inspector` 属个人信息恒不下发），请勿据此开发。
> - **公共字段只列一次**（该学校所有开放类型一致）；各类型的专属字段分列在其后。数组元素结构见说明中的「元素：…」。

### 测试学校 / 公共字段

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
| `initial_conclusion` | 初检结论 | enum（取值：pass / fail / warning / unknown） | — | 是 | 否 | 是 | 记录内保存的初检判定 |
| `final_conclusion` | 最终结论 | enum（取值：pass / fail / warning / unknown） | — | 是 | 否 | 是 | 有复检时取复检结论，否则与初检一致 |
| `conclusion` | 结论（对外统一口径） | enum（取值：pass / fail / warning / unknown） | — | 是 | 否 | 是 | 等于 final_conclusion，推荐直接使用此字段 |
| `final_conclusion_basis` | 最终结论来源 | enum（取值：initial / recheck） | — | 是 | 否 | 是 | initial=无复检、沿用初检；recheck=由复检结论覆盖 |
| `conclusion_text` | 结论原文 | string | — | 否 | 是 | 是 | 记录内保存的判定文本原样返回（如「整改后复检合格」「不合格 (>500)」） |
| `conclusion_source` | 结论来源 | string | — | 是 | 否 | 是 | 固定为 'stored'：结论是**录入/检测当时保存**的值，不是按当前阈值重新计算的结果 |
| `is_positive` | 是否阳性 | boolean | — | 否 | 是 | 是 | 仅病原体有意义（true=阳性、false=阴性）；非病原体为 null |
| `result` | 检测业务数据 | object | — | 是 | 否 | 是 | 该类型的业务字段集合（见同类型 result.* 条目）；字段随类型与学校自定义配置不同 |
| `created_at` | 记录创建时间 | datetime | — | 是 | 否 | 是 | ⚠️ 历史导入数据的创建时间可能等于业务日期零点，不要用它做增量同步 |
| `updated_at` | 数据变更时间 | datetime | — | 是 | 否 | 是 | **增量同步唯一依据**；记录内容发生任何对外可见变更（含复检）都会刷新 |
| `data_version` | 数据版本 | integer | — | 是 | 否 | 是 |  |
| `inspector` | 检测人姓名 | string | — | 否 | 是 | 是 | 仅当该学校授权开启「下发检测人姓名」时出现；关闭时该字段不存在（含复检/修改轨迹内的姓名一律不下发）（条件字段：仅当 include_inspector 开启时存在） |
| `result.canteen` | 食堂（历史同义副本） | string | — | 否 | 是 | 是 | 与顶层 canteen 同义（**以顶层为准**）；仅历史记录可能出现，新记录不再写入 |
| `result.testDate` | 检测日期（历史同义副本） | string | — | 否 | 是 | 是 | 与顶层 test_date 同义（**以顶层为准**）；仅历史记录可能出现，新记录不再写入 |
| `result.inspector` | 检测人（历史同义副本，恒不下发） | string | — | 否 | 是 | **否** | 属个人信息，为**平台内部存储字段：任何情况下都不会出现在响应中**（无论是否开启「下发检测人姓名」）。需要检测人请使用顶层 inspector（由 include_inspector 控制） |

### 测试学校 / tableware · 专属字段

| 路径 | 中文名 | 类型 | 单位 | 必现 | 可空 | 下发 | 说明 |
|---|---|---|---|---|---|---|---|
| `result.testType` | 检测项目 | string | — | 否 | 是 | 是 | 如 表面清洁度 / 洗涤剂残留；历史记录中仅部分存在，取值以学校配置为准 |
| `result.location` | 检测点位 | string | — | 否 | 是 | 是 |  |
| `result.rluValue` | RLU 值 | string | RLU | 是 | 是 | 是 | ⚠️ 字符串类型（历史录入即文本），需自行转数值 |
| `result.result` | 结果文本 | string | — | 是 | 是 | 是 | 如「合格 (<200)」「不合格 (>500)」 |
| `result.atpPoints` | ATP 点位明细 | array<object> | — | 否 | 是 | 是 | ；元素：loc(点位)、rlu(RLU 字符串)、res(结论文本)、testType(检测项目，部分记录存在) |
| `result.correctiveAction` | 整改措施 | string | — | 是 | 是 | 是 |  |
| `result.recheckResult` | 复检结果备注 | string | — | 是 | 是 | 是 |  |
| `result.recheckRecords` | 复检记录 | array<object> | — | 否 | 是 | 是 | 有复检时才出现（实测仅餐具/病原体有）。元素中 user（复检人姓名）**不下发**；元素：id(序号)、time(复检时间字符串)、isPassed(是否通过 boolean)、points(点位明细 array) |
| `result.finalStatus` | 最终状态文本 | string | — | 否 | 是 | 是 | 如「整改后复检合格」，有复检时出现；**病原体实测不产出本字段（0/66）——病原体复检结论在 `result.recheckReports[].isPassed`** |
| `result.remark` | 备注 | string | — | 否 | 是 | 是 |  |

### 测试学校 / oil · 专属字段

| 路径 | 中文名 | 类型 | 单位 | 必现 | 可空 | 下发 | 说明 |
|---|---|---|---|---|---|---|---|
| `result.colorLevel` | 综合品质等级 | enum（取值：合格 / 警戒 / 不合格） | — | 是 | 是 | 是 | ⚠️ **不是颜色**：由前端按「TPM 与酸价等级取最差」算出的综合等级（2026-09-16 实测 合格 38 / 警戒 1，无不合格）。结论口径：**仅「不合格」判不合格**，其余等级视为合格（与 `/stats` 同源） |
| `result.tpmValue` | TPM（极性组分） | string | g/100g（数值等价于 %） | 是 | 是 | 是 | ⚠️ 字符串类型；**数值口径：`0.06` 表示 0.06 g/100g（即 0.06%），请勿再 ×100**。平台判定：≤0.13 合格 / ≤0.25 警戒 / >0.25 不合格；实测范围 0.06~0.20 |
| `result.acidValue` | 酸价值 | string | mg KOH/g（前端展示简写 mg/g） | 否 | 是 | 是 | ⚠️ 字符串类型；实测取值 空字符串 21 / 0.3 13 / 0 5。平台判定：<2.5 合格 / <5 警戒 / ≥5 不合格 |
| `result.oilTemp` | 油温 | string | ℃ | 是 | 是 | 是 | ⚠️ 字符串类型；实测恒为 35 |
| `result.result` | 结果文本（兜底字段） | string | — | 是 | 是 | 是 | **实测 39/39 均为空字符串**——油品结论看 `colorLevel`；本字段仅作历史/其它来源的兜底（`/stats` 在 colorLevel 为空时才回退读它） |
| `result.remark` | 备注 | string | — | 是 | 是 | 是 |  |

### 测试学校 / pathogen · 专属字段

| 路径 | 中文名 | 类型 | 单位 | 必现 | 可空 | 下发 | 说明 |
|---|---|---|---|---|---|---|---|
| `result.riskLevel` | 风险等级 | enum（取值：无风险 / 低风险 / 极低风险） | — | 是 | 是 | 是 | 「无风险」为合格；**其它任何非空值一律视为不合格/有风险**（与 `/stats` 同口径；实测取值仅 无风险 48 / 低风险 9 / 极低风险 9，**没有"高风险"**）。⚠️ 「有风险」**不等于确诊阳性**——是否检出看 `result.positiveDetails` |
| `result.riskReason` | 风险原因 | string | — | 是 | 是 | 是 | 风险说明文本（实测长度 9~72） |
| `result.positiveItems` | 检出项目文本 | string | — | 是 | 是 | 是 | 有检出时为致病菌名称（可能多个，含分隔符；实测长度 14~46）；**无风险时为 1 字符占位（非空）**。判断是否检出请用 `result.positiveDetails` |
| `result.positiveDetails` | 检出明细 | array<object> | — | 是 | 是 | 是 | **是否检出的权威依据**：非空 ⟺ riskLevel ≠ 无风险（实测 18/18）；元素：pathogen(致病菌名)、ct(number)、ctRaw(string) |
| `result.allTestItems` | 全部检测项 | array<object> | — | 是 | 是 | 是 | ；元素：no(序号，实测存在 number 与 string 两种)、channel(通道)、pathogen(致病菌名)、result(结果文本)、ct(string)、isInternalControl(是否内控 boolean) |
| `result.internalControlStatus` | 内控状态 | string | — | 是 | 是 | 是 |  |
| `result.recheckReports` | 复检报告 | array<object> | — | 否 | 是 | 是 | 有复检时才出现；结论看 `isPassed`（true=复检合格）。元素中的 `user`（复检人姓名）**不下发**；元素：id(序号)、time(复检时间字符串)、isPassed(是否通过 boolean)、user(复检人姓名，不下发) |
| `result.sampleId` | 样品编号 | string | — | 是 | 是 | 是 | 2026-09-16 只读实测：66/66 条病原体记录均存在（此前字典漏登记） |
| `result.sampleType` | 样品类型 | string | — | 是 | 是 | 是 | 2026-09-16 只读实测：66/66 条均存在（此前字典漏登记） |
| `result.sampleInfo` | 样品说明 | string | — | 是 | 是 | 是 | ⚠️ **普通字符串**（实测长度 5~16 字符，例如样品别名；非 JSON、非对象），按文本处理，勿解析为对象（此前字典漏登记且曾被误判为"双重编码"） |

## 4. 合成样例（非真实数据）

> 以下为**构造样例**，`record_code` 以 `SAMPLE-` 前缀标记，请勿写入正式数据集；字段形态与真实响应一致。

### test / tableware / pass

```json
{
  "record_id": "sample-tableware-pass",
  "record_code": "SAMPLE-tableware-pass",
  "school_code": "test",
  "school_name": "测试学校",
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
  "created_at": "2026-01-15T00:00:00+08:00",
  "updated_at": "2026-01-15T00:00:00+08:00",
  "data_version": 1
}
```

### test / tableware / fail

```json
{
  "record_id": "sample-tableware-fail",
  "record_code": "SAMPLE-tableware-fail",
  "school_code": "test",
  "school_name": "测试学校",
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
  "created_at": "2026-01-15T00:00:00+08:00",
  "updated_at": "2026-01-15T00:00:00+08:00",
  "data_version": 1
}
```

### test / tableware / recheck_passed

```json
{
  "record_id": "sample-tableware-recheck_passed",
  "record_code": "SAMPLE-tableware-recheck_passed",
  "school_code": "test",
  "school_name": "测试学校",
  "test_type": "tableware",
  "test_name": "餐具洁净度检测",
  "test_date": "2026-01-15",
  "canteen": "示例食堂",
  "status": "completed",
  "initial_conclusion": "fail",
  "final_conclusion": "pass",
  "conclusion": "pass",
  "conclusion_text": "整改后复检合格",
  "conclusion_source": "stored",
  "final_conclusion_basis": "recheck",
  "is_positive": null,
  "result": {
    "testType": "atp",
    "location": "砧板表面",
    "rluValue": "614",
    "result": "不合格 (>500)",
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
        "rlu": "614",
        "res": "不合格"
      }
    ],
    "correctiveAction": "已重新清洗消毒",
    "recheckResult": "复检合格"
  },
  "created_at": "2026-01-15T00:00:00+08:00",
  "updated_at": "2026-01-15T15:31:00+08:00",
  "data_version": 1
}
```

### test / tableware / sparse

```json
{
  "record_id": "sample-tableware-sparse",
  "record_code": "SAMPLE-tableware-sparse",
  "school_code": "test",
  "school_name": "测试学校",
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
  "is_positive": null,
  "result": {
    "result": "合格 (<200)",
    "rluValue": "80",
    "correctiveAction": "",
    "recheckResult": ""
  },
  "created_at": "2026-01-15T00:00:00+08:00",
  "updated_at": "2026-01-15T00:00:00+08:00",
  "data_version": 1
}
```

### test / oil / pass

```json
{
  "record_id": "sample-oil-pass",
  "record_code": "SAMPLE-oil-pass",
  "school_code": "test",
  "school_name": "测试学校",
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
  "is_positive": null,
  "result": {
    "colorLevel": "合格",
    "tpmValue": "0.06",
    "acidValue": "0.3",
    "oilTemp": "35",
    "remark": "",
    "result": ""
  },
  "created_at": "2026-01-15T00:00:00+08:00",
  "updated_at": "2026-01-15T00:00:00+08:00",
  "data_version": 1
}
```

### test / oil / fail

```json
{
  "record_id": "sample-oil-fail",
  "record_code": "SAMPLE-oil-fail",
  "school_code": "test",
  "school_name": "测试学校",
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
  "is_positive": null,
  "result": {
    "colorLevel": "不合格",
    "tpmValue": "0.31",
    "acidValue": "5.2",
    "oilTemp": "35",
    "remark": "建议更换食用油",
    "result": ""
  },
  "created_at": "2026-01-15T00:00:00+08:00",
  "updated_at": "2026-01-15T00:00:00+08:00",
  "data_version": 1
}
```

### test / pathogen / pass

```json
{
  "record_id": "sample-pathogen-pass",
  "record_code": "SAMPLE-pathogen-pass",
  "school_code": "test",
  "school_name": "测试学校",
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
  "is_positive": false,
  "result": {
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
  "created_at": "2026-01-15T00:00:00+08:00",
  "updated_at": "2026-01-15T00:00:00+08:00",
  "data_version": 1
}
```

### test / pathogen / positive

```json
{
  "record_id": "sample-pathogen-positive",
  "record_code": "SAMPLE-pathogen-positive",
  "school_code": "test",
  "school_name": "测试学校",
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
  "is_positive": true,
  "result": {
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
  "created_at": "2026-01-15T00:00:00+08:00",
  "updated_at": "2026-01-15T00:00:00+08:00",
  "data_version": 1
}
```

### test / pathogen / recheck_passed

```json
{
  "record_id": "sample-pathogen-recheck_passed",
  "record_code": "SAMPLE-pathogen-recheck_passed",
  "school_code": "test",
  "school_name": "测试学校",
  "test_type": "pathogen",
  "test_name": "病原体检测",
  "test_date": "2026-01-15",
  "canteen": "示例食堂",
  "status": "completed",
  "initial_conclusion": "fail",
  "final_conclusion": "pass",
  "conclusion": "pass",
  "conclusion_text": "低风险",
  "conclusion_source": "stored",
  "final_conclusion_basis": "recheck",
  "is_positive": true,
  "result": {
    "riskLevel": "低风险",
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
  "created_at": "2026-01-15T00:00:00+08:00",
  "updated_at": "2026-01-15T16:00:00+08:00",
  "data_version": 1
}
```

## 5. 同步规则（必读）

**每轮顺序（请不要颠倒，尤其是"删除判定"必须在一致性校验通过之后）**：

1. 取本轮范围与初始指纹：`GET /sync/manifest?school_code=<校>`（只取 `total` + `digest`）。
   `digest` 覆盖：游标协议版本 + `scope_version` + `projection_fingerprint` + 每条 `record_code@updated_at`。
2. `digest` 与本地保存的一致 → **本轮结束**（不拉明细、**不做任何删除**）。
3. `digest` 变化 → 带 `detail=1` 拉**完整清单**。若返回 `413` 或任何错误，**不得当作空清单**，按第 7 条处理。
4. 拉取所需明细（`test-records` 游标分页）并**暂存**本轮结果：按 `record_code` **整体覆盖**本地记录。
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

## 6. 错误码与处理动作

| HTTP | code | 含义 | 你方应做什么 |
|---|---|---|---|
| 401 | `MISSING_KEY` / `INVALID_KEY` / `CREDENTIAL_REVOKED` / `CREDENTIAL_EXPIRED` | 未携带 / 无效 / 已吊销 / 已过期 | **不要重试**：检查密钥配置与是否已轮换；必要时联系平台换新密钥 |
| 403 | `CLIENT_DISABLED` / `IP_DENIED` / `SCHOOL_NOT_AUTHORIZED` / `TYPE_NOT_AUTHORIZED` | 对接方停用 / IP 不在白名单 / 未授权学校 / 未授权类型 | **不要重试**：核对授权范围与出口 IP；需要变更请联系平台 |
| 400 | `INVALID_CURSOR` / `CURSOR_SCHOOL_MISMATCH` / `CURSOR_FILTER_MISMATCH` / `INVALID_SINCE` / `INVALID_UNTIL` | 游标非法 / 换学校 / 换筛选条件复用游标 / 时间参数非法 | 丢弃本地游标，改从 `manifest` 重新对账后重拉 |
| 409 | `SCOPE_CHANGED` | 授权或字段可见性变化、游标协议过旧 | 重新对账 + **全量重拖并替换式重投影**（不要指望增量覆盖被撤回字段） |
| 413 | `MANIFEST_TOO_LARGE` | 清单超单次上限（**明确拒绝，不返回截断清单**） | **不得当作空清单**：停止对账并联系平台改为分页清单方案 |
| 429 | `RATE_LIMITED` | 触发限流 | 按 `Retry-After` 退避（配合指数退避），降低并发与频率 |
| 5xx / 超时 | — | 平台侧异常 | 有界重试（指数退避 + 上限）；期间**保留旧水位**；持续失败联系平台 |

## 7. 接入检查清单

- [ ] `GET /ping` 通，且服务器时间与本机偏差可接受
- [ ] `GET /profile` 的学校与类型范围与本文件 §2 快照一致；**不一致时以 `/profile` 为准**
- [ ] `GET /dict` 能取到字段字典（据此完成字段映射，含"是否下发"与单位口径）
- [ ] `GET /samples` 能取到合成样例（覆盖合格/不合格/复检等场景，且场景与结论一致）
- [ ] 全量拉取一次：条数与 `manifest.total` 一致，`record_code` 无重复
- [ ] 增量拉取：翻页不重不漏；**最后一页 `next_cursor=null` 时已清空本地游标**
- [ ] 本地记录按"**整体替换**"落地（含记录级字段减少：新响应没有的字段会被清除）
- [ ] 未授权学校/类型被 403 拒绝；错误码按 §6 的"应做什么"分流（401/403 不重试）
- [ ] 已实现：`digest` 二读一致后才提交/删除、失败不当空清单、`413` 有处理、重试有上限
- [ ] 抽样 3~5 条与平台方人工核对字段与结论（含不合格与复检各至少 1 条）
