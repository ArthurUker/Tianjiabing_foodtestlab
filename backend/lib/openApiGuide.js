// openApiGuide.js — 开放接口「接入说明」共享内容（**单一事实源**）
//
// 为什么放在后端：同一份文字同时供两处使用，避免"界面一套、导出文档另一套"：
//   ① 超管界面「开放接口 → 接入说明」通过 GET /api/admin/open-api/clients/:id/guide 读取；
//   ② 「下载接入包（Markdown）」在 routes/adminOpenApiRoutes.js 中直接引用。
//
// 内容口径（必须与实现一致，改实现时同步改这里）：
//   - 认证：X-API-Key / Authorization: Bearer（同一把密钥）
//   - 限流：对接方 rate_limit_per_min，默认 60/分钟，超限 429 + Retry-After
//   - limit：默认 100、上限 200；缺失/非数字/0 一律回退默认值
//   - 日期：YYYY-MM-DD 或 ISO8601（取日期部分），两端含当天；非法 400、倒置 400、请求范围 ∩ 授权范围
//   - 错误码：见 routes/openApiRoutes.js 与 middleware/openApiAuth.js 的实际返回
//   - 统计口径：universe_total = scope_total + request_out_of_range_total + excluded_total
//   - 复检阶段：is_positive 属初检证据，不是复检结论
//
// ⚠️ 本模块只输出**文字与结构化描述**，不含任何密钥、不含真实记录、不读数据库。

export const GUIDE_CONTRACT_VERSION = 'open/v1'

/* ─────────────── ① 快速开始 ─────────────── */

export function buildQuickStartLines(base) {
  return [
    '```bash',
    '# ① 连通性 + 服务器时间（对账时钟）',
    `curl -s -H "X-API-Key: $KEY" ${base}/ping`,
    '',
    '# ② 确认当前授权范围（学校 / 类型 / 字段开关 / scope_version）',
    `curl -s -H "X-API-Key: $KEY" ${base}/profile`,
    '',
    '# ③ 取字段字典（据此写映射：是否下发、单位、结论枚举、自定义字段）',
    `curl -s -H "X-API-Key: $KEY" "${base}/dict?school_code=<校>"`,
    '',
    '# ④ 拉第一页记录（limit ≤ 200；看 has_more / next_cursor）',
    `curl -s -H "X-API-Key: $KEY" "${base}/test-records?school_code=<校>&limit=200"`,
    '',
    '# ⑤ 对账清单（total + digest；detail=1 附全量 {record_code, updated_at, change_token}）',
    `curl -s -H "X-API-Key: $KEY" "${base}/sync/manifest?school_code=<校>"`,
    '```',
    '',
    '> `$KEY` 即平台提供的密钥明文（形如 `oap_…`）。**认证只有一种密钥**，可用下面两种方式之一携带；两者同时出现时以 `X-API-Key` 为准。',
    '',
    '> ⚠️ **基址别重复拼 `/v1`**：正确是 `https://<域名>/api/open/v1/ping`。若拼成 `/api/open/v1/v1/ping`，请求会落到需要登录态的其它路由，'
      + '返回 `401 缺少授权令牌` —— 看起来像"密钥无效"，实际是地址拼错（本项目自测时踩过两次）。',
    '',
    '**分页响应外层结构**（`GET /test-records`，注意外层是 `data`，单条记录在 `data.items[]`）：',
    '```json',
    '{ "code": 0, "data": { "school_code": "<校>", "scope_version": 1, "projection_fingerprint": "…",',
    '    "count": 200, "has_more": true, "next_cursor": "<最后一页为 null>",',
    '    "server_time": "2026-09-16T12:00:00+08:00", "items": [ { "…": "单条记录对象（见样例）" } ] } }',
    '```',
    '**清单响应外层结构**（`GET /sync/manifest`，`detail=1` 时才有 `items`）：',
    '```json',
    '{ "code": 0, "data": { "total": 1129, "complete": true, "digest": "…",',
    '    "digest_covers": "cursor_version+scope_version+projection_fingerprint+record_code@change_token",',
    '    "generated_at": "2026-09-16T12:00:00+08:00",',
    '    "items": [ { "record_code": "RC-…", "updated_at": "2026-09-16T11:05:00.900+08:00", "change_token": "2026-09-16T03:05:00.900Z|v2" } ] } }',
    '```',
  ]
}

/* ─────────────── ② 端点 ─────────────── */

export const GUIDE_ENDPOINTS = [
  { method: 'GET', path: '/ping', params: '—', desc: '连通性 + 服务器时间（对账本机时钟）' },
  { method: 'GET', path: '/profile', params: '—', desc: '当前密钥的授权范围（每校 scope_version / 类型 / 日期范围 / 字段开关）；**不含** projection_fingerprint' },
  { method: 'GET', path: '/schools', params: '—', desc: '当前密钥可访问的学校清单' },
  { method: 'GET', path: '/dict', params: 'school_code', desc: '字段字典：类型、食堂、结论枚举、字段路径/类型/单位/必现/可空/是否下发' },
  { method: 'GET', path: '/samples', params: 'school_code、test_type（可选）', desc: '合成样例（非真实数据，`SAMPLE-` 前缀，可在无数据时开发）' },
  { method: 'GET', path: '/test-records', params: 'school_code、test_type（可选）、cursor、limit', desc: '检测记录（游标分页，完整对象）' },
  { method: 'GET', path: '/sync/manifest', params: 'school_code、detail（可选）', desc: '全量清单（total + digest）；`detail=1` 附 {record_code, updated_at, change_token}' },
  { method: 'GET', path: '/stats', params: 'school_code、start、end、test_type（可选）', desc: '合格率统计（含集合恒等式与排除原因，可对账）' },
]

/* ─────────────── ③ 参数与规则 ─────────────── */

export const GUIDE_PARAM_RULES = [
  '- 认证（**同一个密钥**，二选一携带方式）：`X-API-Key: <密钥>` 或 `Authorization: Bearer <密钥>`；必须 HTTPS。两者同时出现时以 `X-API-Key` 为准。',
  '- 限流：默认 **60 次/分钟**（按凭证独立计数）；超限返回 `429 RATE_LIMITED`，请按 `Retry-After` 退避并降低并发。',
  '- 分页参数：`limit` 默认 **100**、上限 **200**；`limit` 缺失 / 非数字 / `0` 一律**回退默认值**（不报错，兼容既有调用行为）。',
  '- 日期参数（`start` / `end`）：接受 `YYYY-MM-DD` 或 ISO8601 日期时间（取日期部分），**两端含当天**（闭区间）；'
    + '非法日期返回 `400 INVALID_START` / `INVALID_END`，`start > end` 返回 `400 INVALID_RANGE`；'
    + '请求范围与授权业务日期范围**求交集**（请求不能越过授权范围，交集为空是合法请求 → 200 且 0 条）。',
  '- `projection_fingerprint`（字段可见性指纹）在 `/test-records`、`/samples`、`/sync/manifest` 响应中返回，**`/profile` 不含**该字段。',
  '- 所有成功响应为 `{ "code": 0, "data": {...} }`；失败为 `{ "code": "<错误码>", "error": "..." }`（均带 `server_time`）。',
]

/* ─────────────── ④ 字段字典读表须知 ─────────────── */

export const GUIDE_DICT_NOTES = [
  '> **必现 = 服务端保证**（是 = 该字段一定出现在响应中，目前仅顶层字段）。`result.*` 字段来自保存的检测数据，**恒为否**：'
    + '若观察到「现有记录均出现」，会写在说明里的 `实测出现：…` —— 那是**数据观察，不是输出保证**，请勿据此建必填模型；容错解析以「可空」「下发」为准。',
  '> **可空**：字段存在但值可能为 `null`。**三态区分**：字段**省略**（不存在）≠ `null`（存在无值）≠ 空串/空数组（有值为空）。',
  '> **下发=否** 的字段**不会出现在响应中**，列出仅为说明原始存储结构（如 `result.inspector` 属个人信息恒不下发），请勿据此开发。',
  '> **公共字段只列一次**（该学校所有开放类型一致）；各类型的专属字段分列在其后。数组元素结构见说明中的「元素：…」。',
  '> ⚠️ **单位标注 ≠ 已核实单位**：字段表「单位」列带 `⚠️未核实` 的（如 `result.tpmValue`）表示该单位仅为**平台界面标注**'
    + '（字段上 `unit_source=platform_label`、`unit_verified=false`），**设备协议/计量文件尚未核实** —— 请勿自行换算（×100 / ÷100），也不要据该字段重新判定历史结论。',
]

/* ─────────────── ⑤ 业务口径与判定规则 ─────────────── */

export const GUIDE_BUSINESS_RULES = [
  '**结论字段**（每类型都返回）：`initial_conclusion`（初检）/ `final_conclusion`（最终）/ `conclusion`（对外统一，等于最终）/ '
    + '`final_conclusion_basis`（`initial` = 无复检沿用初检；`recheck` = 由复检覆盖）/ `conclusion_conflict`（复检结论冲突时为 true）。',
  '',
  '**合格判定（与 `/stats` 同源；按保存值，不按当前阈值重判）**：',
  '',
  '| 类型 | 判定 |',
  '|---|---|',
  '| 餐具洁净度 | 顶层 `result` 有文本 → 含「合格」且不含「不合格」为合格；**顶层为空时回退 `result.atpPoints[].res`**（洗涤剂残留记录只写点位结论）：任一点位「不合格」→ 不合格；所有点位「合格」→ 合格；其余（警戒/无结论）→ 未判定、不计合格 |',
  '| 果蔬 / 肉蛋 | `result` 文本含「合格」且不含「不合格」→ 合格 |',
  '| 食用油 | 先看 `result.colorLevel`（综合品质等级）：`合格` / `警戒` → 合格；`不合格` → 不合格；**其它未识别值回退 `result` 文本** |',
  '| 病原体 | `result.riskLevel = 无风险` → 合格；**其它任何非空值 → 不合格/有风险**。⚠️ 「有风险」≠ 确诊阳性（是否检出看 `result.positiveDetails` 是否非空） |',
  '',
  '**统计口径（`GET /stats`）**：',
  '',
  '- 集合恒等式：`universe_total = scope_total + request_out_of_range_total + excluded_total`（授权可见全集 = 入分母 + 请求范围外 + 无法定位业务日期）。',
  '- `pass_rate = pass_count / scope_total`；**分母为 0 时返回 `null`**（不返回 0，避免被读成"全部不合格"）。',
  '- **`unknown` 计入分母**（v1 口径）：`pass_rate` 低于 1 **不等于**其余记录都不合格，请用 `conclusion` 分布解释差值。',
  '- `metric_basis = stored_current_result`：按**当前保存的** `result`/`colorLevel`/`riskLevel` 判定；部分 Web 复检会覆盖这些字段，'
    + '因此它**不承诺等同初检指标**，也不在所有类型上等同最终结论（需独立初检/最终指标的，请与平台约定新字段方案）。',
  '- 授权业务日期范围**外**的记录不出现在任何字段中（连数量也不可推断）；日期范围 = 授权范围 ∩ 请求范围，闭区间。',
  '',
  '**复检记录的阶段语义（同一条记录里各字段属于不同阶段，并存不矛盾）**：',
  '',
  '| 字段 | 阶段 | 说明 |',
  '|---|---|---|',
  '| `result.riskLevel` / `result.positiveDetails` / `result.positiveItems` | **初检证据** | 初检留下的风险等级与检出明细；复检不会重写这些证据 |',
  '| `is_positive` | **初检检出证据** | `positiveDetails` 非空 ⟺ `true`；该键缺失时按 `riskLevel ≠ 无风险` 兜底。**不是复检结论、也不等于确诊** |',
  '| `initial_conclusion` | 初检结论 | 无独立初检快照时（原值已被复检覆盖）为 `unknown`，**不逆推** |',
  '| `final_conclusion` / `conclusion` / `final_conclusion_basis` | **最终结论** | 有复检时取最新复检的 `isPassed`（`basis=recheck`）；判断"当前是否合格"只看这里 |',
  '',
  '- 因此 `initial_conclusion=unknown` + `final_conclusion=pass` + `is_positive=true` 是**正常组合**（初检快照被覆盖 / 初检检出证据仍在 / 复检通过）。',
  '- 复检结论优先取结构化 `recheckReports[].isPassed`（或 `recheckRecords[].isPassed`）；`finalStatus` 等文本字段仅作兼容兜底，冲突时以结构化字段为准。',
  '',
  '**单位与数值**：数值类字段一律为**字符串且为原始录入口径**（平台不做换算、不做缩放）。'
    + '`result.tpmValue` 的 `unit`（g/100g）与阈值均属**平台界面标注**（`unit_verified=false`，未经设备协议/计量文件核实）——'
    + '请勿自行 ×100 / ÷100，也不要据此重新判定历史结论。',
]

/* ─────────────── ⑥ 错误码与处理动作 ─────────────── */

export const GUIDE_ERROR_ROWS = [
  { status: 401, code: 'MISSING_KEY / INVALID_KEY / CREDENTIAL_REVOKED / CREDENTIAL_EXPIRED', meaning: '未携带 / 无效 / 已吊销 / 已过期', action: '**不要重试**：检查密钥配置与是否已轮换；必要时联系平台换新密钥' },
  { status: 403, code: 'CLIENT_DISABLED / IP_DENIED', meaning: '对接方被停用 / 来源 IP 不在白名单', action: '**不要重试**：核对密钥归属与出口 IP；需要变更请联系平台' },
  { status: 403, code: 'SCHOOL_NOT_AUTHORIZED / TYPE_NOT_AUTHORIZED / NO_VISIBLE_TYPE', meaning: '未授权学校 / 未授权类型 / 该校当前零权限', action: '**不要重试**：以 `GET /profile` 为准核对授权范围；需要新增请联系平台' },
  { status: 404, code: 'SCHOOL_NOT_FOUND', meaning: '学校代码不存在', action: '核对 `school_code`（用 `/schools` 列表）' },
  { status: 400, code: 'INVALID_SCHOOL_CODE / INVALID_CURSOR / CURSOR_SCHOOL_MISMATCH / CURSOR_FILTER_MISMATCH', meaning: '学校代码非法 / 游标非法 / 换学校或换筛选条件复用游标', action: '丢弃本地游标，改从 `manifest` 重新对账后重拉' },
  { status: 400, code: 'INVALID_START / INVALID_END / INVALID_RANGE / INVALID_SINCE / INVALID_UNTIL', meaning: '日期或时间参数非法 / 起止倒置', action: '按 `YYYY-MM-DD` 修正；`start` 不得晚于 `end`' },
  { status: 409, code: 'SCOPE_CHANGED', meaning: '授权或字段可见性变化、游标协议过旧', action: '重新对账 + **全量重拉并替换式重投影**（不要指望增量补齐被撤回的字段）' },
  { status: 413, code: 'MANIFEST_TOO_LARGE', meaning: '清单超单次上限（明确拒绝，不返回截断清单）', action: '**不得当作空清单**：停止对账并联系平台改用分页清单方案' },
  { status: 429, code: 'RATE_LIMITED', meaning: '触发限流', action: '按 `Retry-After` 退避（配合指数退避），降低并发与频率' },
  { status: 500, code: 'INTERNAL_ERROR / AUTH_ERROR', meaning: '平台侧异常', action: '有界重试（指数退避 + 上限，单轮 ≤ 5 次）；期间**保留旧水位**；持续失败联系平台' },
]

/* ─────────────── ⑦ 同步规则（必读） ─────────────── */

export function buildSyncRuleLines() {
  return [
    '**每轮顺序（请不要颠倒，尤其是"删除判定"必须在一致性校验通过之后）**：',
    '',
    '1. 取本轮范围与初始指纹：`GET /sync/manifest?school_code=<校>`（只取 `total` + `digest`）。',
    '   `digest` 覆盖：游标协议版本 + `scope_version` + `projection_fingerprint` + 每条 `record_code@change_token`。',
    '2. 客户端已按新版协议完整同步、且 `digest` 与本地保存的一致 → **本轮结束**（不拉明细、不做任何删除）。旧状态需先完整重拉。',
    '3. `digest` 变化 → 带 `detail=1` 拉**完整清单**。若返回 `413` 或任何错误，**不得当作空清单**，按第 7 条处理。',
    '4. 按 `change_token` 比较逐条变化；投影/授权变化、旧状态升级，或摘要变化但逐条无差异时，必须完整重拉。拉取明细后按 `record_code` **整体覆盖**候选记录。',
    '5. 结束前**再取一次** `manifest`：与第 1 步的 `digest` 不一致 → 说明本轮期间数据又变了：**丢弃本轮暂存结果并重跑一轮**。',
    '6. 两读一致 → 本轮才算成功：此时才提交暂存结果、执行"缺失记录"处理（见下）、保存水位与游标。',
    '7. 任何一步失败（401/403/409/429/超时/解析失败/分页中断）→ **保留上一轮完成状态与水位**，退避后重试；'
      + '**重试必须有上限**（建议指数退避：单轮最多 5 次、总时长 ≤ 10 分钟），仍失败则放弃本轮并告警，不要无限重跑。',
    '',
    '**"清单里没有" ≠ "源记录被物理删除"**：记录可能因**业务日期范围、状态、类型可见性**变化而移出当前有效范围。'
      + '统一表述为「**当前有效范围内已不可见**」→ 按双方约定标记撤回/不可见；接口未给出删除原因时，**不要推断源端发生了物理删除**。',
    '',
    '**`next_cursor` 语义（写代码前必读）**：',
    '- 只在**成功处理完一页之后**保存 `next_cursor`；不要预先保存；',
    '- 最后一页 `has_more:false`、`next_cursor:null` → **清空本地游标**，下一轮从 `manifest` 重新对账；',
    '- 游标**不是**下一轮水位：它绑定「学校 + 筛选条件 + `scope_version` + `projection_fingerprint` + 水位 `(updated_at,id)`」，'
      + '换学校/换筛选条件/授权或字段可见性变化后必须丢弃（否则 400 / 409）；',
    '- 游标无固定有效期，但**不建议跨轮次长期保存**：每轮以 `manifest` 为准，游标仅用于单轮内翻页与断点续传；',
    '- 若清单显示某条记录已变更，但你方水位已越过它：用 `since=<字符串时间>` 做**重叠回拉**（建议回退 5 分钟）并幂等去重。',
    '',
    '**增量依据**：`updated_at` 用于**记录变更排序**（排序键 `(updated_at ASC, id ASC)`，同一时间戳靠 `id` 决胜）；'
      + '**完整同步还必须结合服务端游标、`scope_version` 与清单 `digest` 对账**，不得仅凭 `updated_at` 判定同步完成'
      + '（`created_at` 对历史导入数据可能等于业务日期零点，**不可**用于增量）。',
    '',
    '**字段撤回与记录级字段减少**：授权关闭「检测人姓名」后，新响应不再包含该字段；此外平台可能对**单条记录**做规范化'
      + '（如移除 `result` 内的历史同义副本），此时只有 `updated_at`/`digest` 变化，`projection_fingerprint` **不变**。'
      + '两种情况都按同一条规则处理：**凡重新获取到的记录，一律以新响应的完整对象整体覆盖本地同 `record_code` 记录**'
      + '（并清除新响应中已不存在的字段）；本接口只返回完整对象，不存在"部分响应"语义。你方自有业务字段请单独存放，避免被平台对象覆盖。',
    '',
    '收到 `409 SCOPE_CHANGED`（授权或字段可见性变化 / 游标过旧）→ 回到第 1 步重新对账，并重新拉取全部明细以重新投影。',
    '旧客户端升级：丢弃跨轮旧游标，保留旧数据与旧摘要作回滚点，使用新客户端完整拉取并替换本校记录；两次摘要一致后才原子提交新版摘要、记录和水位。学校改名也会改变投影指纹并触发重投影。',
  ]
}

/* ─────────────── ⑧ 常见错误与排查（FAQ） ─────────────── */

export const GUIDE_FAQ = [
  {
    q: '返回 401「缺少授权令牌」——是密钥失效了吗？',
    a: '多半是**地址拼错**：基址已含 `/api/open/v1`，再拼一次变成 `/api/open/v1/v1/ping` 时会落到需要登录态的其它路由。'
      + '正确：`https://<域名>/api/open/v1/ping`。若地址正确仍 401，再核对密钥是否被吊销/过期。',
  },
  {
    q: '401 和 403 该怎么区分处理？',
    a: '401 = 密钥问题（未携带/无效/吊销/过期）→ **不要重试**，先修配置；403 = 权限与来源问题（对接方停用、IP 白名单、学校或类型未授权、该校零权限）→ **不要重试**，以 `GET /profile` 为准核对后联系平台。',
  },
  {
    q: '`limit=0` 或 `limit=abc` 会报错吗？',
    a: '不会。缺失 / 非数字 / `0` 一律按默认值 **100** 处理，上限 **200**。要翻页请以响应里的 `has_more` 与 `next_cursor` 为准。',
  },
  {
    q: '最后一页之后，下一轮增量要从哪里开始？',
    a: '`next_cursor=null` 表示本轮翻页结束 → **清空本地游标**；下一轮一律从 `GET /sync/manifest` 的 `total`+`digest` 对账开始，不沿用上一轮游标（换学校/换筛选/授权变化后沿用会 400/409）。',
  },
  {
    q: '清单里少了一条，可以删本地记录吗？',
    a: '**不能直接删**。先确认本轮完整性与一致性（`digest` 二读一致、无 413/超时/部分清单），再把"清单中不存在"表述为「当前有效范围内已不可见」，按双方约定标记撤回；接口不提供删除原因，不要推断源端物理删除。',
  },
  {
    q: '`/samples` 的样例能直接入库吗？',
    a: '**不能**。样例是构造数据（`record_code` 以 `SAMPLE-` 开头、`synthetic:true`），仅用于无真实数据时开发联调；请勿写入正式数据集。',
  },
  {
    q: '`is_positive=true` 是不是表示当前不合格？',
    a: '不是。`is_positive` 是**初检阶段的检出证据**（`positiveDetails` 非空 ⟺ true），复检合格后它可能仍为 `true`。判断"当前是否合格"请看 `final_conclusion`（或等价的 `conclusion`）。',
  },
  {
    q: '字典里 `required` 为 `true` 的字段，能建 NOT NULL 吗？',
    a: '可以，但仅限**顶层字段**（服务端投影保证）。`result.*` 字段的 `required` 恒为 `false`（来自保存的检测数据），说明里的「实测出现：…」只是数据观察，不能当必填契约。',
  },
  {
    q: '单位标注可以直接换算使用吗？',
    a: '不能。带 `⚠️未核实` 的单位（如 `result.tpmValue` 的 `g/100g`）只是**平台界面标注**，未经设备协议/计量文件核实；平台按原始录入值保存，请勿 ×100 / ÷100，也不要据此重判历史结论。',
  },
  {
    q: '`pass_rate` 是 40%，是否表示另外 60% 不合格？',
    a: '不是。`unknown`（未判定）记录**计入分母**；请用响应里的 `conclusion` 分布解释差值。按已判定记录计算属指标语义变更，需与平台另行约定。',
  },
]

/* ─────────────── ⑨ 联调自检清单（可执行 + 期望值） ─────────────── */

export const GUIDE_SELF_CHECK = [
  { item: '`GET /ping` 带密钥', expect: '200，且 `data.server_time` 与你的时钟偏差可接受' },
  { item: '`GET /ping` 不带密钥 / 用错误密钥', expect: '`401 MISSING_KEY` / `401 INVALID_KEY`' },
  { item: '`GET /profile`、`GET /schools`', expect: '200，且学校与类型范围与接入包快照一致（**不一致时以 `/profile` 为准**）' },
  { item: '`GET /test-records?school_code=<未授权校>`', expect: '`403 SCHOOL_NOT_AUTHORIZED`（拿不到数据）' },
  { item: '`GET /dict`、`GET /samples`', expect: '200；样例带 `synthetic:true` 与 `SAMPLE-` 前缀，字段都能在字典里找到定义' },
  { item: '`GET /test-records?limit=2` 逐页取完', expect: '各页 `record_code` 无重复；末页 `has_more:false`、`next_cursor:null`；去重总数 == `manifest.total`' },
  { item: '重复请求第 2 页游标', expect: '200，且 `items` 与首次完全一致（游标幂等）' },
  { item: '`cursor=garbage` / 换 `test_type` 复用游标', expect: '`400 INVALID_CURSOR` / `400 CURSOR_FILTER_MISMATCH`' },
  { item: '各页 `projection_fingerprint` 与 `manifest` 对比', expect: '同源一致（不一致说明期间授权/字段可见性变了，需重投影）' },
  { item: '`GET /stats`', expect: '`universe_total == scope_total + request_out_of_range_total + excluded_total`；分母为 0 时 `pass_rate=null`' },
  { item: '`GET /stats?start=2099-01-01&end=2099-01-02`', expect: '200 且 `scope_total=0`、`pass_rate=null`（**不得 500**）' },
  { item: '`start=abc` / `start>end`', expect: '`400 INVALID_START` / `400 INVALID_RANGE`' },
  { item: '抽样 3~5 条记录与平台人工核对', expect: '字段、结论、复检阶段语义一致（不合格与复检各至少 1 条）' },
  { item: '异常路径演练', expect: '断网/超时/429/413 时本地状态不推进、不误删；重试有上限' },
]

/* ─────────────── ⑩ 合成样例场景说明 ─────────────── */

export const GUIDE_SAMPLE_SCENARIOS = [
  { type: 'tableware', scenario: 'pass', meaning: 'ATP 合格（`rluValue` < 200）' },
  { type: 'tableware', scenario: 'fail', meaning: 'ATP 不合格（`rluValue` > 500）' },
  { type: 'tableware', scenario: 'recheck_passed', meaning: '初检不合格 → 整改后复检合格：`initial_conclusion=fail`（或 `unknown`）、`final_conclusion=pass`、`final_conclusion_basis=recheck`' },
  { type: 'tableware', scenario: 'sparse', meaning: '字段稀疏（仅最小必填集）：**不要假设所有字段都会出现**' },
  { type: 'pesticide', scenario: 'pass / fail', meaning: '农残胶体金法合格 / 不合格（`result` 文本判定）' },
  { type: 'leanMeat', scenario: 'pass / fail', meaning: '肉蛋类合格 / 不合格' },
  { type: 'oil', scenario: 'pass', meaning: '`colorLevel=合格`（真实形态：TPM 0.06、酸价 0.3、油温 35）' },
  { type: 'oil', scenario: 'fail', meaning: '`colorLevel=不合格`（合成构造：TPM 0.31 > 0.25、酸价 5.2 ≥ 5.0）' },
  { type: 'pathogen', scenario: 'pass', meaning: '`riskLevel=无风险`、`positiveDetails=[]`、`positiveItems` 为占位符' },
  { type: 'pathogen', scenario: 'positive', meaning: '检出：`riskLevel=低风险` + `positiveDetails` 非空（`is_positive=true`）' },
  { type: 'pathogen', scenario: 'recheck_passed', meaning: '初检检出 → 复检通过：`is_positive=true` 与 `final_conclusion=pass` **并存不矛盾**（阶段不同）' },
]
