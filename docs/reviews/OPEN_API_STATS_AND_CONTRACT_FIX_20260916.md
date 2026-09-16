# 开放接口修复报告：/stats 日期 500 + 样例/契约/接入包一致性

> 触发依据：2026-09-16 13:44—13:50 线上只读验证（36 次 GET：22×200、2×401、6×403、2×400、**4×500**）
> 本轮授权：改码、补测试、隔离库验证、隔离目录前端构建、出报告与待发布清单
> **未执行**：生产数据/授权/密钥/白名单修改、迁移、发布构建、重启、提交、推送
> 工作区：`Product_tencent_CVM`，HEAD `50ef5dc`，本报告与修复均为**未提交**状态

---

## 1. 结论摘要

- **1 项线上故障已定位并修复（P0）**：`/stats` 带日期参数必 500。根因是 SQL 里 `text >= date` 无隐式转换，**与"空结果集"无关**；同一根因还潜伏在 `dateClause()`（`/test-records`、`/sync/manifest` 在**授权配置了业务日期范围**时也会 500，线上因 `test` 授权未配范围而未暴露）。
- **样例/契约问题**：多为**构造数据错误**（不是判定逻辑错、也不影响历史真实记录），已修并加守门测试；1 项为**字典未登记**（病原体 `finalStatus`），已通过"样例不再产出该字段"消除矛盾。
- **1 项业务口径待确认**：`unknown` 是否计入合格率分母（本轮**保留现状**，仅补文档说明，不改指标含义）。
- **发布仍未进行**：本轮修复只在工作区；线上仍是修复前代码（`dist` 指纹 `3934fcb6…` 前后一致，未变）。

---

## 2. P0：`/stats` 日期参数 500

### 2.1 实际根因（已用真实数据库错误复现）

业务日期存放在 `sample_info->>'testDate'`，是**文本**；旧实现把参数写成 `$N::date`：

```sql
-- 旧实现（openApiRoutes.js:521-522 / 84-88）
count(*) FILTER (WHERE substring("sample_info"->>'testDate' from 1 for 10) >= $2::date)
```

隔离库实测（`/tmp/stats_rootcause.sql`）：

```
ERROR:  operator does not exist: text >= date
HINT:  No operator matches the given name and argument types. You might need to add explicit type casts.
```

→ **只要请求带 `start`/`end` 就必然 500**（与范围宽窄无关，故"宽范围也失败"符合该根因）；不带日期参数时不产生该比较，所以 200。

**同一根因的第二处（本轮新发现）**：`dateClause()`（`openApiRoutes.js:78-91`）用于 `/v1/test-records` 与 `/v1/sync/manifest`，同样写 `::date`。因此**任何配置了 `grant.start_date/end_date` 的授权，这两个接口也会整体 500**。线上 `test` 授权未配日期范围，故只暴露了 `/stats`。

### 2.2 修复内容（`backend/routes/openApiRoutes.js` + `lib/openApiScope.js`）

1. 统一改为**文本比较**（`YYYY-MM-DD` 同长度 ISO 文本的字典序 = 时间序），比较前先过合法性正则：
   `businessDateValidSql()` + `BUSINESS_DATE_TEXT_EXPR`（`openApiScope.js`）。
2. 新增 `parseDayParam()`：接受 `YYYY-MM-DD` 或 ISO8601 日期时间（取日期部分），校验真实日历（`2026-02-30` 拒绝）。
3. 新增 `effectiveDateRange()`：**授权范围 ∩ 请求范围**（`maxDay/minDay`）。修复前是"请求范围**覆盖**授权范围"，会越过授权边界取数。
4. 错误语义稳定化：非法日期 → `400 INVALID_START`/`INVALID_END`；`start > end` → `400 INVALID_RANGE`；交集为空是**合法请求** → `200` 返回 0 条（附 `range.empty_reason`）。
5. 口径可解释化（additive，不改既有字段含义）：
   - `scope_total` = 授权∩请求范围内有效日期记录数（进分母）
   - `out_of_range_total`（**新增**）= 有有效日期但在范围外
   - `excluded_total/excluded[]` = 日期缺失或格式非法（与范围无关）
   - **恒等式**：`scope_total + out_of_range_total + excluded_total = 授权类型内全部记录数`
   - `pass_rate`、`pass_rate_detail.value` 在分母为 0 时返回 `null`（不返回 0）
   - `range:{requested, grant, effective, inclusivity:'两端含当天（闭区间）', empty, empty_reason}`

### 2.3 回归证据（数据库级，隔离库）

命令：`sudo -u foodsentinel bash /tmp/run-openapi-db-tests.sh`（强制库名含 `review_test`）
新增 `backend/tests/openapi/stats-date.integration.test.mjs`（真实 handler + 真实租户连接 + 隔离库），**12/12 通过**：

| 用例 | 结果 |
|---|---|
| 远期范围 `2099-01-01~2099-01-02`（原 500） | 200、全 0、`pass_rate=null`、`out_of_range_total=5` |
| 宽范围 `2000-01-01~2100-01-01` | 200、`scope_total=5`、`excluded=2` |
| 仅 `start` / 仅 `end` | 200（旧实现两者均 500） |
| 同一天 `start=end` + 边界记录 | 200、上边界当天计入（闭区间） |
| 非法日期（`abc`/`2026-02-30`/`2026-13-01`/`2026/01/15`） | 400 `INVALID_START`/`INVALID_END`（不再是 500） |
| `start > end` | 400 `INVALID_RANGE` |
| ISO8601 日期时间入参 | 200、按日期部分生效 |
| **授权自带范围**（`2026-01-01~01-31`） | 200（旧实现必 500）；请求 `01-16~02-28` → 生效范围 `01-16~01-31`（**不越过授权**） |
| 交集为空（授权 1 月 + 请求 3 月） | 200、0 条、`range.empty=true` |
| 口径恒等式（含 `by_type` 汇总一致性） | 通过 |
| 缺失/非法业务日期 | 进 `excluded`（不静默丢弃）、不计入分母 |
| 时区无关（`SET TIME ZONE UTC` vs `Asia/Shanghai`） | 计数一致 |
| **同源缺陷**：授权带范围时 `/test-records`、`/sync/manifest` | 200、仅返回范围内 4 条 |

⚠️ **测试隔离强化（过程中发现并修正的真实风险）**：`lib/tenantClient.js:78-80` 的 `baseDatabaseUrl()` 读的是 `process.env.DATABASE_URL`（**不是传入的 prisma 实例**）。测试进程若带生产 URL，路由内的 `createTenantClient` 会连生产库。已在测试里：① 显式把 `process.env.DATABASE_URL` 指向隔离库；② 租户客户端自带 `?schema=`；③ **`assertIsolated()` 在写入前断言 `current_database()` 必须是 `foodsentinel_review_test`**。（首次运行时该断言之前，测试确实尝试过连生产——因生产无 `school_reviewtest` schema 而失败，未产生任何数据变更；这也是本轮最重要的工程教训之一。）

---

## 3. 样例与契约问题

### 3.1 食用油 `fail` 样例返回 `pass` —— **构造输入错误**（不影响真实记录）

- 判定逻辑没错：油品按 `colorLevel` 判定（`openApiScope.js:168-181`），仅"不合格"判不合格；`/stats` 同口径。
- 错在样例数据：`colorLevel:'深绿色'`（**实测真实数据里 `colorLevel` 只有 `合格 38 / 警戒 1`，根本不是颜色词**——它是前端按「TPM 与酸价等级取最差」算出的**综合品质等级**）+ 未给 `result` → 推导为 `pass`。
- 已修：`pass` → `colorLevel:'合格'`、tpm `0.06`、酸 `0.3`、油温 `35`（**全部与实测一致**）；`fail` → `colorLevel:'不合格'` + tpm `0.31`(>0.25) + 酸 `5.2`(≥5)（自洽）。
- **对真实记录的影响：无**（仅合成样例）。真实油品结论口径未改、未重算历史。

### 3.2 病原体复检样例字段阶段混淆 —— **样例构造 + 字典描述双问题**

- 实测：`riskLevel` 只有 `无风险 48 / 低风险 9 / 极低风险 9`（**无"高风险"**）；`positiveDetails` 非空 ⟺ `riskLevel ≠ 无风险`（18/18）；病原体 `finalStatus` **0/66**；无风险时 `positiveItems` 是 **1 字符占位（非空）**。
- 已修：样例改用真实 `riskLevel`；明确「`riskLevel`/`riskReason`/`positiveItems`/`positiveDetails` = **初检证据**，复检结论在 `recheckReports[].isPassed`，`allTestItems` = 当前明细」；**病原体样例不再产出 `finalStatus`**（字典也不再暗示该字段存在）。
- `is_positive` 语义**保持 v1 不变**（`riskLevel` 非空且 ≠ 无风险），只在字典/文档写明"**不等于确诊阳性**，检出看 `positiveDetails`"。
- 多次复检取最终结论的规则：`finalStatus` 优先，否则 `getLatestRecheckPassed()`（最新一次）——已在字典说明。

### 3.3 样例时间顺序 —— 已修

复检场景 `updated_at` 现取复检时间（餐具 `15:31`、病原体 `16:00`）；实测 12 条含复检记录 `updated_at` 均 ≥ `created_at`，与承诺一致。时区写法统一说明：顶层 ISO8601 带 `+08:00`；`recheckRecords[].time` 为**无时区本地时间字符串**（历史格式，兼容保留）。

### 3.4 字典/样例一致性（本轮补齐）

| 项 | 处理 |
|---|---|
| `pathogen.result.recheckReports` 缺 `item_fields` | 已补（`id/time/isPassed/user(不下发)`） |
| TPM 单位歧义 | `unit` 改 `g/100g（数值等价于 %）`，说明写明"**0.06 = 0.06 g/100g，勿再 ×100**"+阈值 0.13/0.25+实测区间 |
| `colorLevel` 称"颜色" | 改「综合品质等级」+ `enum:['合格','警戒','不合格']` |
| `oil.result` 未登记 | 已登记（实测 39/39 为空串，仅作兜底） |
| `emitted:false` 不可见 | 字典表新增「下发」列；**接入包**字段表同步新增该列并标 **否**；超管界面字典表也新增该列（不下发行灰显 + "不下发"角标） |
| `required` 语义 | 明确为**数据分布观察**（不是输出保证），字典 notes 与接入包均写明，并补"字段省略 / null / 空串 / 空数组"三态区分 |
| 枚举值未列出 | 接入包与超管界面的「类型」列现在渲染 `enum（取值：…）` |
| `/profile` 含 `projection_fingerprint`（错误说法） | 已改正：该指纹取 `/test-records`、`/samples`、`/sync/manifest`；`/profile` 只给授权范围 |
| `limit=0`/`limit=abc` 返回 200 | 核实为**既有策略**（默认 100、上限 200、非法/0 回退默认），已写入接入包与文档，**未改行为** |

---

## 4. 最终约定（本轮定稿）

1. **日期参数**：`YYYY-MM-DD` 或 ISO8601（取日期部分）；两端含当天；非法 → 400；`start>end` → 400；**授权范围 ∩ 请求范围**；交集空 → 200 且 0 条。
2. **统计口径（未改语义）**：`unknown` **计入分母**；`pass_rate < 1 ≠ 其余不合格`（新增 `unknown_policy` 文案说明）；分母 0 → `null`。
3. **TPM**：字符串、原始 `g/100g` 数值（0.06 = 0.06%），判定 ≤0.13 合格 / ≤0.25 警戒 / >0.25 不合格。
4. **复检字段**：初检证据（`riskLevel`/`positiveDetails`/`positiveItems`）与复检结论（`recheckReports[].isPassed`、顶层 `final_conclusion*`）分离；病原体无 `finalStatus`。
5. **required**：数据观察，非契约保证；容错解析以 `nullable` + 「下发」为准。
6. **业务日期比较**：一律文本比较 + 合法性正则，**禁止**与 `::date` 混用（本轮重点回归项）。

---

## 5. 修改文件

| 文件 | 改动 |
|---|---|
| `backend/lib/openApiScope.js` | 新增 `BUSINESS_DATE_TEXT_EXPR`、`businessDateValidSql()`、`parseDayParam()`、`maxDay/minDay` |
| `backend/routes/openApiRoutes.js` | `dateRangeClause()`（文本比较+合法性）、`effectiveDateRange()`、`/stats` 重写（范围求交/`out_of_range_total`/`range`/`unknown_policy`）、字典 notes（required/三态）、`recheckReports.item_fields` 由 schema 提供 |
| `backend/lib/openApiFieldSchema.js` | 样例修正（油品/病原体/`updated_at`）、`recheckReports.item_fields` |
| `backend/routes/adminOpenApiRoutes.js` | 接入包：公共字段只列一次 + 专属字段分节、字段表新增「下发」列与枚举取值/数组元素、limit 与日期参数说明、profile 字段纠正、授权快照声明（本轮前已加）、同步规则与错误码动作（本轮前已加） |
| `frontend/js/modules/adminSchools/views/openApiView.js` | 字典表新增「下发」列、枚举取值、数组元素与条件字段展示（**未构建到线上 dist**） |
| `docs/OPEN_API_INTEGRATION.md` | profile 字段纠正、日期参数与 limit 行为、TPM/病原体/结论来源口径（本轮前已改，本轮补 profile） |
| `backend/tests/openapi/stats-date.integration.test.mjs` | **新增**（12 用例，DB 级） |
| `backend/tests/openapi/package-contract.test.mjs` | 新增 3 组断言（公共字段唯一性/枚举与下发可见/参数与 profile 说明） |
| `docs/reviews/onboarding-pack-sample-20260916.md` | **新增**：重渲染的接入包样本（合成内容，无密钥/无真实记录） |

**接口兼容性**：所有新增字段均为**追加**（`out_of_range_total`、`range`、`unknown_policy`）；既有字段含义未变；仅**行为修正**是"非法日期从 500 → 400"与"请求范围不再覆盖授权范围"（后者属安全修正）。**无数据库结构变更 → 无需迁移**。

---

## 6. 测试结果

| 层级 | 命令 | 结果 |
|---|---|---|
| 静态 | `node --check`（全部改动后端文件） | 通过 |
| 单元/契约 | `cd backend && node --test tests/` | **82 项：80 通过 / 0 失败 / 2 跳过**（跳过项＝需隔离库环境变量） |
| 数据库集成 | `sudo -u foodsentinel bash /tmp/run-openapi-db-tests.sh` | **22/22 通过**（`/stats` 12 + 写入链路 10） |
| 界面（隔离构建） | `cp -r frontend scripts package.json /tmp/buildcheck && cd /tmp/buildcheck && node scripts/build-static.js` | 构建成功；隔离产物含新 UI 能力（`不下发`×4、`取值：`×1） |
| 线上产物未被触碰 | 构建前后 `find dist … sha256sum` | **均为 `3934fcb6…`**（未发布）；线上 `openApiView.js` 仍 `7301e66b…` |

---

## 7. 待发布清单（本轮不执行）

1. **无迁移**（无 schema 变更）。
2. 前端：`npm run build:prod`（= `build-static.js`；⚠️ **不要**用 `npm run build`，含 `build:css` 在本机必失败）→ 会写线上 `dist/`。
3. `sudo systemctl restart foodsentinel-api`。
4. 冒烟（用**临时对接方**，勿动朴食凭证）：
   - `/stats?school_code=<校>&start=2099-01-01&end=2099-01-02` → **200 且 0 条**（发布前为 500）
   - `/stats?...&start=abc` → 400 `INVALID_START`；`start>end` → 400 `INVALID_RANGE`
   - 给某校授权临时配业务日期范围 → `/stats`、`/test-records`、`/sync/manifest` 均 200（发布前 500）→ 验完恢复
   - `/samples?...&test_type=oil` 的 `fail` 场景 → `final_conclusion=fail`
   - 超管「接入说明」：字段字典出现「下发」列与枚举取值；下载的接入包为公共字段 + 专属字段结构
5. **回滚**：`git checkout -- <本轮文件>` + 重启；前端 `git checkout -- frontend/... && npm run build:prod`。**数据无需回滚**（本轮无数据变更）。

---

## 8. 剩余风险与下一阶段验收

1. **未验证（环境限制）**：App 端离线队列/载荷形态（源码不在本仓）；线上真实 401/403/429/游标并发行为；`limit` 边界在生产大数据量下的表现；超管界面真实登录态的窄屏可读性（已静态核对 + 隔离构建，未做真机点击）。
2. **待业务确认**：`unknown` 是否应排除出分母（若确认，建议新增 `pass_rate_judged` 之类的**新字段**而非改旧字段含义）；`requireEditor` 之外的写入状态策略（本轮未动）。
3. **同批遗留（非本轮范围）**：供应商 `record_code` 与内容哈希的耦合、批量部分失败的重试收敛、`/v1/profile` 是否补 `projection_fingerprint`（当前判断：不必，文档已指向正确来源）。
4. **下一阶段验收**：按 §7 冒烟清单逐项打勾；并与朴食确认其出口 IP、开通学校清单与拉取频率后再放开真实联调。
