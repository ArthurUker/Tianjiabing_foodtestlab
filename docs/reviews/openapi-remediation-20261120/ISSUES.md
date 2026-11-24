# 开放接口全量修复台账（2026-11-20）

修复基线：生产 HEAD `33f4515`（工作树 clean）。
开发位置：数据盘副本 `/mnt/datadisk0/foodsentinel-review/openapi-fix-20261120/foodsentinel`（生产工作树未改动）。

## 0. 来源与口径

| 来源 | 内容 | 采用情况 |
|---|---|---|
| DeepSeek 两轮 | `接口联调测试报告-2026-11-17.md`（run_tests.py 61 用例 + run_tests2.py 19 用例），F-01~F-11 | 全部复核，6 个问题属实 |
| 我方深挖两轮 | F/N/S 系列（含数据库实测） | 全部并入 |
| GLM 一轮 | **结果文件未收到**（服务器全域检索无） | 待补发后并入；已用我方两轮覆盖同一问题域 |

## 1. 合并问题台账（去重后 23 项）

| # | 级别 | 问题 | 处置 | 状态 |
|---|---|---|---|---|
| 1 | P0 | F-01 `/stats` 的 `test_type` 被静默忽略 | 实现类型过滤（未知 400 / 未授权 403）+ 回显 `test_type_filter` | 已修复 |
| 2 | P0 | F-02 `/test-records` 忽略 `start`/`end` 且不校验 | 实现业务日期窗口（请求 ∩ 授权，闭区间）+ 回显 `start`/`end` + `INVALID_START/END/RANGE` | 已修复 |
| 3 | P1 | F-03 `/stats` 无 conclusion 分布 | 新增 `conclusion_distribution {pass,fail,warning,unknown}`（与明细同源，四项和 = scope_total） | 已修复 |
| 4 | P1 | F-04 `riskLevel` 枚举陈旧（称"没有高风险"） | 字典改为 5 值 + 黑名单解析说明（实测计数更新） | 已修复 |
| 5 | P1 | F-05 `rluValue` 单位随类型变化 | 单位/阈值按 `testType` 分别标注（atp=RLU，detergent=mg/L ≤0.1） | 已修复 |
| 6 | P2 | F-06 未知学校码 400/403/404 语义 | 文档对齐（403 不泄露存在性；404 仅停用/不存在极端情况） | 已修复（文档） |
| 7 | P2 | F-07 `/samples` 外层结构未文档化 | 端点表 + FAQ 补 `data.samples[]` + `item` | 已修复（文档） |
| 8 | P2 | F-08 字典食堂缺「四食堂」 | 字典食堂 = 配置 ∪ 数据实测值（自动跟随） | 已修复 |
| 9 | P2 | F-09 oil 39→0 | 根因：`school_test` 于 2026-09-28 重置，oil 未保留（非可见性问题）；接口无变更 | 已定位 |
| 10 | P2 | F-10 `/profile` 与 `/schools` 语义差异 | 文档说明 + **disabled 授权只回 code/status**（最小披露） | 已修复 |
| 11 | P3 | F-11 数据质量（压测污染） | 见 §3 数据治理 | 待批准 |
| 12 | P1 | N-01/S-02 巨型记录（977/416 轮 recheckReports，单条 1.28MB/0.55MB） | 数据治理清除源头；服务端暂不截断（避免丢失复检证据） | 待批准（§3） |
| 13 | P2 | N-03/S-04 游标无签名可伪造 | **游标 v3：HMAC-SHA256 签名**；篡改/剥离 → 409；指纹纳入 start/end/until | 已修复 |
| 14 | P3 | N-05 `updated_at` 缺索引 | 迁移 `20261124000000_testrecord_updated_at_id_index` + `@@index([updated_at, id])`；public + 4 租户已落库，执行计划走 Index Only Scan | 已修复（2026-11-24） |
| 15 | P3 | N-06/S-07 `limit` 接受浮点/负数 | `parseInt` + 夹取 [1,200]（小数向下取整、负数按 1） | 已修复 |
| 16 | P2 | N-07/S-03 空串/未知 `test_type` 静默；`/sync/manifest` 忽略 `test_type` | 统一 400 `INVALID_TEST_TYPE`（已知未授权仍 403）；manifest 支持过滤并回显 | 已修复 |
| 17 | P3 | N-08/S-05 错误信封不一致（401/429 无 `server_time`） | `deny()` 补 `server_time`，与路由层同形 | 已修复 |
| 18 | P2 | N-09 `/profile` 泄露 disabled 学校名称/类型 | disabled 仅回 `school_code` + `status` | 已修复 |
| 19 | P2 | N-10/S-06 `status` 未过滤 | `/test-records`、`/sync/manifest`、`/stats` 只含 `completed` | 已修复 |
| 20 | P2 | S-01 `since`/`until` 零用例覆盖 | 补集成用例；`until` 非法 → 400 `INVALID_UNTIL`；游标绑定 until | 已修复（测试+校验） |
| 21 | P3 | S-08 字典反向覆盖未验证 | 既有 `projection-contract` / `sample-schema-conformance` 已覆盖，无需改码 | 已验证 |
| 22 | P3 | S-09 动态变更传播未实测 | 既有 `f6-upgrade` 套件覆盖（旧基线→升级→失败不推进） | 已验证 |
| 23 | P3 | S-10 限流语义（第 46 次 429） | 滑动窗口 60s/凭证；文档与自检清单已写明 | 已澄清 |

## 2. 代码变更清单

| 文件 | 变更 |
|---|---|
| `backend/lib/openApiScope.js` | 游标 v3（HMAC 签名 + 校验）、`PROJECTION_REVISION=proj-r4-2026-11-20`、指纹纳入 start/end/until |
| `backend/routes/openApiRoutes.js` | `/stats` 类型过滤+conclusion 分布+by_type 零填充；`/test-records` start/end/until/limit/status/游标签名；`/sync/manifest` test_type+status；`/samples` 类型校验；`/dict` 食堂并集；`/profile` 最小披露 |
| `backend/lib/openApiFieldSchema.js` | riskLevel 枚举 5 值、rluValue 单位/阈值按类型、atpPoints 说明 |
| `backend/lib/openApiGuide.js` | 端点参数、日期/游标/状态语义、错误码、FAQ（samples 外层/limit/分布）、自检清单 |
| `docs/OPEN_API_INTEGRATION.md` | 独立对接文档同步：`/stats` test_type 与 `conclusion_distribution`、`/test-records` start/end、游标 v3 签名、status=completed、profile 脱敏、riskLevel/rluValue、错误码与自检清单 |
| `backend/middleware/openApiAuth.js` | `deny()` 统一 `server_time` |
| `backend/scripts/purge-openapi-stress-records.mjs` | 新增：压测数据清理（默认 dry-run，含备份+事务删除） |
| `backend/tests/openapi/contract.test.mjs` | +3 条（游标签名/指纹/字典） |
| `backend/tests/openapi/stats-date.integration.test.mjs` | +6 条（test_type/分布/零填充/日期窗口/limit/状态/游标签名） |
| `backend/tests/openapi/package-contract.test.mjs` | riskLevel 枚举断言更新 |
| `backend/tests/http/openapi-http.integration.test.mjs` | 未知类型 400 + 已知未授权 403 |

## 3. 数据治理（2026-11-20 09:09 CST 已执行）

只读实测（生产库）：

| 项 | 值 |
|---|---|
| 清理候选（压测员 ∪ `ZZTT-STRESS-%`） | **5,817 条 / result_data 原文 ≈3.8MB（JSON 序列化 4.07MB；含 RC-BULK-* 批量压测族与 ZZTT-STRESS-01 两台设备）** |
| 其中巨型记录 | 977 轮（1.28MB）、416 轮（0.55MB） |
| 清理后余量 | **62 条**（riskLevel 非"无风险" 10 条；无高风险） |
| 影响 | manifest digest / stats / 客户 records.csv 基线全部变化 |

执行结果（已批准并执行）：

```bash
node backend/scripts/purge-openapi-stress-records.mjs --school test --apply \
  --backup /mnt/datadisk0/deploy-backups/foodsentinel-20261120/db/purged-stress-records-test.json
# → deleted 5,817；totalAfter 62；备份 5.7MB（含 1.28MB 巨型记录，已校验行数 5,817）
```

清理后数据画像：**62 条**（riskLevel：无风险 14 / 中风险 9 / 低风险 1 / 非病原体 38；高风险 0）。

**待办**：通知朴食科技做「基线重置」——丢弃旧 `records.csv`，下一轮忽略 digest 差异、直接全量重拉一次。

## 4. 验证结果（隔离实例 55512，T02A/T02C fixture）

| 套件 | 结果 |
|---|---|
| `tests/openapi/`（全目录） | **103/103 通过**（含新增 9 条） |
| `tests/http/openapi-http.integration.test.mjs` | **12/12 通过** |
| `tests/log-center/openApiLog.unit.test.mjs` | 4/4 |
| `tests/records/{tableware-verdict,route-write-paths,db-integration}` | 7/7、23/23、10/10 |
| `tests/verdict/conclusion-matrix.test.mjs` | 9/9 |
| ESLint（变更源码） | 0 新增错误（测试文件 3 条为既有规则告警） |

## 5. 部署记录（2026-11-20 09:08 CST 已部署并验证）

- **无数据库迁移**（不动 `prisma/migrations`，不触发租户门禁）。
- 备份：`/mnt/datadisk0/deploy-backups/foodsentinel-20261120/files/`（部署前 9 个既有文件 + `before.sha256`）+ `db/purged-stress-records-test.json`（清理数据 5.7MB）。
- 已部署文件（生产 `/opt/foodsentinel`，哈希与数据盘副本一致）：
  `backend/lib/openApiScope.js`、`backend/lib/openApiFieldSchema.js`、`backend/lib/openApiGuide.js`、`backend/middleware/openApiAuth.js`、`backend/routes/openApiRoutes.js`、`backend/scripts/purge-openapi-stress-records.mjs`、4 个测试文件、本台账。
- 生产验证（临时验证凭证，用后已删除；`client/credential` 残留 0）：
  - 健康 `ready:true`、`globalBlockers=[]`；401 信封含 `server_time`
  - 契约 14/14 PASS（清理前 + 清理后各一轮）：`/stats?test_type`、`conclusion_distribution` 可加总、`by_type` 5 类、`/test-records` start/end 回显、`/dict` 枚举与单位、`/profile` disabled 脱敏、未知/空类型 400、篡改游标 409、`manifest?test_type`
  - 数据清理后 `/stats` scope_total ≤70、`manifest.total=62`，分布和 = scope_total
  - `journalctl` 无 error
- 客户端影响：游标 v3 + `PROJECTION_REVISION` bump + 数据清理 → 对接方首次旧游标收到 409，需按协议重新对账并做基线重置（预期行为）。
- 回滚：从备份目录回拷文件 + `systemctl restart foodsentinel-api`。
- 生产 git 工作树当前为**未提交改动**（11 文件：5 改 + 2 新增目录/文件），未执行 commit。

## 6. 全量审核结论（2026-11-24，生产实测）

**客户反馈 F-01~F-11 + 我方深挖 N-01~N-10 + 补充 S-01~S-10，全部 23 项均已解决或明确收口**（21 项生产实测 PASS + 索引迁移 + 数据面 SQL 复核）。

| 类别 | 结论 |
|---|---|
| F-01 /stats test_type | ✅ 已解决（生产实测：pathogen/oil 返回不同数字，by_type 只含请求类型） |
| F-02 /test-records start/end | ✅ 已解决（生效并回显；`start=abc`→400、`start>end`→400） |
| F-03 conclusion 分布 | ✅ 已解决（`conclusion_distribution` 和=scope_total；by_type 覆盖 0 条类型） |
| F-04 riskLevel 枚举 | ✅ 已解决（含中/高风险，删除"没有高风险"） |
| F-05 rluValue 单位 | ✅ 已解决（按 testType 区分 RLU/mg/L） |
| F-06 错误码语义 | ✅ 已解决（400 格式非法 / 403 未授权，文档已对齐） |
| F-07 samples 外层 | ✅ 已解决（文档已写明 `data.samples[]` + `item`） |
| F-08 食堂缺四食堂 | ✅ 已解决（字典=配置∪实测，含四食堂） |
| F-09 oil 39→0 | ✅ 已定位（2026-09-28 schema 重置，oil 未保留；by_type 可见 oil=0） |
| F-10 profile/schools 语义 | ✅ 已解决（disabled 仅 code+status；/schools 只 active） |
| F-11 数据质量 | ✅ 压测已清（62 条）；样本量小属业务提示，非接口缺陷 |
| N-01/S-02 巨型记录 | ✅ 已清除（现 0 条 >100KB） |
| N-02 压测污染 | ✅ 已清除（inspector=压测员 / ZZTT 设备 0 条） |
| N-03/S-04 游标可伪造 | ✅ 已解决（v3 签名，篡改→409） |
| N-04 since 未入指纹 | ✅ 已澄清（cursor 优先，非缺陷；until 已入指纹并实测 400） |
| N-05 updated_at 索引 | ✅ 已解决（2026-11-24 迁移落库 public+4 租户） |
| N-06/S-07 limit 灰色输入 | ✅ 已解决（小数取整、负数按 1） |
| N-07/S-03 test_type/manifest | ✅ 已解决（未知/空 400；manifest 支持并回显） |
| N-08/S-05 错误信封 | ✅ 已解决（401/429 均含 server_time） |
| N-09 /profile disabled 泄露 | ✅ 已解决（最小披露） |
| N-10/S-06 status 过滤 | ✅ 已解决（三端点只含 completed，集成测试覆盖） |
| S-01 since/until 零覆盖 | ✅ 已解决（非法 400 + 集成用例） |
| S-08/S-09 测试方法论 | ✅ 已由 projection-conformance / f6-upgrade 套件覆盖 |
| S-10 限流语义 | ✅ 已澄清（按凭证滑窗，429 含 server_time 与 Retry-After） |

## 7. 未决与风险

1. **GLM 一轮结果缺失**——请补发文件，并入后如发现新增项再补修。
2. **压测数据清理已执行**（§3）；仍需通知对接方做基线重置。
3. **N-05 `updated_at` 索引已落库**（2026-11-24 停服窗口：public migrate deploy + 全租户 db:sync + generate + 重启，门禁恢复 ready:true）。
4. 巨型记录的服务端上限护栏**有意不做**（数据清理后无实例；截断会丢复检证据，若未来复检轮数失控再在写入侧评估）。
5. 生产 git：`7e5143c` 已提交推送；索引迁移另行提交。
