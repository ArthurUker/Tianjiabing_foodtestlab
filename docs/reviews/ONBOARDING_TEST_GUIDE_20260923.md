# 开放接口「对接测试怎么做 / 怎么确认没问题」实战指南（2026-09-23）

> 面向：平台方（你）自测与未来对接方的验收。
> 核心原则：**分层次取证，不要用一层的结果去替代另一层**。自动化只能证明"实现符合契约"，
> 不能证明"契约符合业务意图"；后者必须用固定人工数据集核对。

---

## 一、四层验证（每层能证明什么 / 不能证明什么）

| 层 | 做法 | 能证明 | **不能**证明 |
|---|---|---|---|
| ① 单元/契约 | `node --test backend/tests/openapi/ backend/tests/records/`（现 **129** 项） | 字段字典、样例、结论推导、游标、指纹、归一化的**纯逻辑**正确 | 真实 SQL、真实 HTTP、认证、并发 |
| ② 隔离库集成 | `REVIEW_TEST_DATABASE_URL=… bash /tmp/run-openapi-db-tests.sh`（现 35 项） | 真实 PG 上的分页/时间比较/互斥桶/日历校验/写入归一/CAS | 认证与 HTTP 装配、真实网络 |
| ③ HTTP 链路 | `bash /tmp/run-http-tests.sh`（现 **19** 项） | 真实 Express + 真实 API-Key/内部 JWT + 真实租户客户端 | 生产数据分布、真实对接方行为 |
| ④ **对接方验收（自测工具）** | `OPENAPI_KEY=… node docs/examples/openapi-acceptance-kit.mjs --base-url=… --school=…` | **文档描述与真实行为一致**：鉴权边界、错误码、分页完整性、字典↔样例↔真实响应字段一致（**含"必现字段是否存在"的 C6 类检查**）、统计恒等式 | 业务语义是否正确（结论口径/单位/复检规则） |

**建议顺序**：③ 通过 → ④ 在新开通的学校上跑一遍 → 再把它交给对接方自检（同一把脚本，双方看到同一结果）。

---

## 二、用自检工具怎么做（含"零权限"这种新语义）

```bash
# 平台方在开通某校后自测（用临时密钥，验完即删）
OPENAPI_KEY=oap_xxxxx node docs/examples/openapi-acceptance-kit.mjs \
  --base-url=http://127.0.0.1:3002/api/open/v1 --school=test --expect-inspector=true
```

工具会逐项给出 ✅/❌ 与证据（状态码、错误码、条数、恒等式数值），并**在最后区分**：
"契约层自检通过" vs "语义层需人工确认"。

关键判据（工具已自动断言）：
1. **鉴权**：无密钥 `401 MISSING_KEY`、错密钥 `401 INVALID_KEY`；
2. **分页完整性**：逐页拉取后 `去重条数 == manifest.items 条数`，且**清单与明细逐条 `record_code` 全覆盖、`updated_at` 一致**（游标不推进/漏页会被判失败）；
3. **字段一致性**：字典里 `emitted:false` 的字段**不应**出现在样例/真实响应中；
3b. **必现一致性（C6 类）**：字典 `required=true` 的字段必须**真的出现在样例里**；`result.*` 一律不得声明 `required=true`（它们来自保存的检测数据）；
4. **统计恒等式**：`universe_total = scope_total + request_out_of_range_total + excluded_total`；
5. **可解释 4xx**：非法游标 `INVALID_CURSOR`、日历不存在 `INVALID_START`、`start>end` `INVALID_RANGE`、远期范围 `200 且 0 条 / pass_rate=null`；
6. **零权限语义**：`visible_types: []` 应得到 `403 NO_VISIBLE_TYPE`（而不是默默回退默认四类）。

---

## 三、必须人工确认的"语义层"清单（脚本无法代替）

用**固定数据集**（建议：3 条合法日期含 pass/fail/unknown、1 条脏日期、1 条缺日期、1 条带复检）逐条核对：

| # | 语义 | 怎么确认 | 当前实现 |
|---|---|---|---|
| S1 | 合格判定口径 | 同一批数据：明细 `conclusion` vs `stats.pass_count` | 统计沿用既有 SQL 数值算法（按**当前保存的** `result`/`colorLevel`/`riskLevel` 判定）；响应声明 `metric_basis=stored_current_result`（2026-09-23 由 `initial_conclusion` 更正而来）—— **它不承诺为初检指标，也不等同于最终结论**；真实初检快照与独立指标仍待决策 |
| S2 | 复检语义 | 一条"初检不合格→复检合格"的记录：`initial_conclusion` / `final_conclusion` / `isPassed` / `pass_count` | 有复检时 `initial_conclusion=unknown`（初检快照可能已被 Web 覆盖），`final_conclusion` 取最新结构化 `isPassed`；统计仍走 S1 的算法 → 明细 pass ≠ 计入分子（属预期，已在 `metric_basis_note` 说明） |
| S3 | 日期与范围 | 4 种"授权范围 × 请求范围"组合的条数关系 | 见 `OPEN_API_INTEGRATION.md` §5.7 的恒等式表（有自动化矩阵用例支撑） |
| S4 | 字段撤回 | 关闭某字段后重拉：本地是否残留 | 平台侧保证"不再下发"；**对方本地需替换式写入**才会消失（写入策略在对方） |
| S5 | TPM 单位 | 与设备原始读数对照 | **未核实**（`unit_verified:false`）——需设备协议材料 |
| S6 | 删除感知 | 清单缺失某记录 | 平台不区分"删除"与"移出授权范围"；对方应**标记撤回**而非物理删除 |

> 建议把 S1/S2/S3 的固定数据集核对结果留档（截图或 JSON），作为"接口语义已被确认"的证据。

---

## 四、常见"看起来失败其实正常"的情况（避免误判）

| 现象 | 是否问题 | 原因 |
|---|---|---|
| `/stats` 某校 `pass_rate=null` | ❌ 不是 | 分母为 0（该范围内无有效日期记录） |
| 明细条数 ≠ `stats.scope_total` | ❌ 不是 | 明细含日期缺失/非法记录（供排查），统计分母不含；用 `scope_total + excluded_total` 对账 |
| 明细 `conclusion=pass` 但 `pass_count` 未增加 | ❌ 不是 | 统计按**当前保存值**（`metric_basis=stored_current_result`）判定，**不等于初检口径、也不等同于最终结论**；该条属复检覆盖类 |
| 换了授权/字段后 `digest` 变了 | ❌ 不是 | 投影/范围变化会改变指纹与摘要（**必须**，否则对方无法感知变化） |
| `limit=0` 或 `limit=abc` 返回 200 | ❌ 不是 | 既有策略：非法/0 回退默认值（文档已写明） |

---

## 五、什么时候算"可以交付给对接方"

1. ③ 层全绿（HTTP 链路）；
2. ④ 层自检工具在该校上 **0 失败**；
3. S1–S3 的语义核对留档；
4. 该校授权配置确认（类型/开关/日期范围/IP 白名单/限流）；
5. 一把**正式密钥**（不要用测试期临时密钥）+ 一份接入包（超管界面可直接下载）。

---

## 六、实战案例（2026-09-23，可作为对照）

**案例：字典声明"必现"、样例里却没有（C6）** —— 第三方用同款方法验收时抓到：

- 现象：`/dict` 把 `result.sampleId/sampleType/sampleInfo` 标为 `required:true`，但三个病原体样例全缺这三个键（共 9 处）；
- 影响：对方按字典生成严格模型后，**连官方样例都校验失败**；
- 根因：把"实测 66/66 条都存在"这一**数据观察**当成了**必现契约**；
- 处置：`result.*` 的 `required` 统一收敛为 `false`（服务端不保证），观察信息改记 `observed_present`；样例补齐虚构值 —— 并**把这条检查写进自检工具与测试**（工具现在会直接判失败）。

**这条案例说明**：只跑"能跑通"的 happy path 不会暴露它；必须同时核对**字典 ∩ 样例 ∩ 真实响应**三者一致，以及"声明"与"实际"一致。

**配套资源**：
- 自检工具：`docs/examples/openapi-acceptance-kit.mjs`（只读，零依赖；退出码非 0 即有失败项）
- 接入包 §9「接入自检清单」：每项都带可判定的期望值，与工具检查项同源
- 本指南 §三 的 S1–S6：脚本证明不了的语义层，必须人工留档
