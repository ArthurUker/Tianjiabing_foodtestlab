# RDPMS 开放接口 P0/P1 正确性与数据完整性修复报告（2026-09-17）

> 本轮性质：**不变量修复**（不是"改测试"）。以真实源码 + 真实测试结果为唯一依据。
> **未执行**：生产发布、重启、生产构建（`build:prod` 会写线上 `dist/`）、生产数据/授权/密钥变更、commit、push。
> 所有数据库验证均在隔离库 `foodsentinel_review_test` 上完成（含运行时库名断言）。

---

## A. 基线

```
Repo:            git@github.com:ArthurUker/Tianjiabing_foodtestlab.git
Branch:          Product_tencent_CVM
Starting HEAD:   d090b77d7933790e4456bbdcdc2b94227053857c   （= 上一轮修复提交）
Base (给定):     bf04495b1599f1edd895e7c5a624bf6248bb53     ⚠️ 该对象在本克隆中不存在（fatal: Not a valid object name）
Working tree:    clean（`git status --short` 为空）
Remote 真实指针: d090b77（`git ls-remote`）
⚠️ 本地跟踪引用 origin/Product_tencent_CVM = f109d65 是**陈旧值**（该分支不在 fetch refspec 内，见下），
   与 HEAD 无分叉：`git merge-base --is-ancestor f109d65 HEAD` → true。判断远端状态必须以 `git ls-remote` 为准。
另：remote.origin.fetch 仅含 `+refs/heads/main:refs/remotes/origin/main` → `@{upstream}` 无法解析（本轮未改配置）。
```

基线测试（改动前）：`node --test tests/` = **82 项（80 pass / 0 fail / 2 skipped）**，skip 原因=需隔离库环境变量。

---

## B. 修复摘要

| ID | Severity | Root cause | Files changed | Before | After | Regression test | Status |
|---|---|---|---|---|---|---|---|
| **P0-1** | P0 | `normalizeWriteJson` 在 strip 控制键**之后**仍把"只剩 `{}`"当作显式提交写回；`PUT /api/records/:id` 的字段保护块把 `undefined` 变成 `{}` | `lib/recordNormalize.js`、`routes/syncRoutes.js`、`routes/recordRoutes.js` | `result_data: {canteen:'B'}` → strip → `{}` → **写回清空全部检测结果**（三条写入路径都中招） | strip 后**无业务键 → `undefined`（不改动）**；上下文键合并进 `sample_info`；局部更新默认 **merge**，`null` 键=删除，`replace` 需显式 `result_data_mode` | `tests/records/partial-update.integration.test.mjs` A-1/A-2/A-3/B-1/B-2/C | ✅ 已修复并验证 |
| **P0-2** | P0 | 参考客户端在 **tail 校验之前**执行 `st.digest = tail.digest`；`cursor/watermark` 轮次中途就地写入正式状态 | `docs/examples/openapi-sync-client.mjs`、`docs/OPEN_API_INTEGRATION.md` §4.3.1 | head=D1/tail=D2 时把 D2 记为已同步 → **下一轮跳过 → 新增记录永久漏拉**；失败留下半同步状态 | 候选状态（candidate）→ 所有改动只写 candidate → tail 校验（digest + scope + projection）→ **一次性原子提交**；异常/不一致**不触碰正式 checkpoint**；请求级退避重试（尊重 `Retry-After`） | `tests/openapi/sync-client.test.mjs` Test D / Test E / 异常语义 / 替换式重投影（4/4） | ✅ 已修复并验证 |
| **P1-1** | P1 | `out_of_range_total` 统计"有效日期但不在**生效范围**内"的记录 → 生效范围含授权边界 → **授权范围外的记录数量可被第三方反推**（侧信道） | `routes/openApiRoutes.js`（`/stats`） | 授权 1 月时，`out_of_range_total` 会随 2 月及更早/更晚的记录数变化 | 只统计 **授权可见全集内**的桶；授权范围外记录**不出现在任何字段**（新增 `range.authorization_boundary` 声明） | Test F（注入 999 条授权外记录 → 所有返回值逐字段不变） | ✅ 已修复并验证 |
| **P1-2** | P1 | `inRangeSql = inRangeExpr \|\| 'TRUE'`：无任何日期范围时 `scope_total` 计入**日期缺失/非法**记录，同时 `excluded_total` 又统计一次 → 双计、分母被污染 | `routes/openApiRoutes.js`、`lib/openApiScope.js` | 真实 102 条 + 2 条脏日期 → `scope_total=102`、`excluded_total=2`（和 104） | 桶互斥：`universe_total = scope_total + request_out_of_range_total + excluded_total`；`scope_total` 只含 `validDate ∧ 授权内 ∧ 请求内` | stats 集成 #4/#10（Test G 含 by_type 汇总一致性） | ✅ 已修复并验证 |
| **P1-3** | P1 | 各写入口并发语义不一致：sync 更新无 version 概念、legacy PUT **不递增 version**、bulk-upsert 是"先读后比再写"（TOCTOU） | `routes/syncRoutes.js`、`routes/recordRoutes.js`、`lib/recordNormalize.js` | A/B 客户端同读 v3 → 两者都成功（last-write-wins）；version 常驻不变 | 统一：带 `expected_version`/`expected_updated_at`/`version` → **原子 CAS**（冲突 409 / 批量 `VERSION_CONFLICT`）；不带 → **明确 LWW**（代码注释 + README §4.4 写明）但 `version` **原子 `+1`** | partial-update Test J / K / K-2 / bulk CAS | ✅ 已修复并验证 |
| **P1/P2-日期** | P1 | 库内 `testDate` 只做正则校验 → `2026-02-30`/`2026-13-01`/`2026-00-10` 被视为"有效"，参与文本比较并进入分母；`pickTestDate` 也只截取前 10 位 | `lib/openApiScope.js`、`lib/recordNormalize.js` | 日历不存在的日期 = 有效日期（不影响 500，但污染统计与下发） | SQL 侧 `businessDateValidSql()` 做**真实公历校验**（闰年/月日上限，纯 CASE 判定，**不对脏值做 `::date`**）；JS 侧 `isValidBusinessDate()` 同语义；`pickTestDate` 不合法→`null` | stats #5/#6 + 投影断言 | ✅ 已修复并验证 |
| **P1/P2-oil** | P1 | `colorLevel` **fail-open**：`color.includes('不合格') ? fail : pass` → 任何非空脏值（`深绿色`/`foo`）都判"合格" | `lib/openApiScope.js`、`routes/openApiRoutes.js` | 未知等级 → pass | **显式枚举**：`合格`/`警戒`→pass、`不合格`→fail、未识别→**回退 `result` 文本**（两者皆无→unknown）；`/stats` 的 SQL 分支同源改造 | contract 用例（合格/警戒/不合格/深绿色/foo/空串/null）+ stats #7 | ✅ 已修复并验证 |
| **P2-TPM** | P2 | 单位/阈值缺**外部权威规格**（仅有仓库内前后端一致） | 无代码改动（仅文档/字段字典措辞已在上一轮写明） | — | 保留现口径（`g/100g`，≤0.13 合格 / ≤0.25 警戒 / >0.25 不合格），**不擅自改阈值** | 证据见 §F | ⏳ 待外部资料确认（本轮不阻塞） |

**额外缺陷（由本轮测试暴露并已修复）**：`expected_updated_at` 未列入 `stripVolatileFields` 的剥离集 → 带该字段的 bulk-upsert 请求会算出**不同的 `record_code`**，本应"条件更新"的请求反而**新增重复记录**（乐观锁形同不可用）。修复：加入剥离集（`lib/recordNormalize.js`），`tests/records/partial-update.integration.test.mjs` 第 10 项锁定。

---

## C. 写入口审计表

| Route | File | Mutation | Partial/Replace | 归一化 | Version guard | Version increment | 事务 | 最终语义 |
|---|---|---|---|---|---|---|---|---|
| `POST /api/records/:tableName` | recordRoutes | create | — | `buildRecordWriteData`(create) | 无（新记录） | `version=1` | 单语句 | create |
| `POST /api/records/:tableName/bulk-upsert` | recordRoutes | upsert(create/update) | 命中已有=**replace** | `buildRecordWriteData`(+existing) | `expected_updated_at` → 条件含 `updated_at` | **`{increment:1}` 原子** | 单语句/条（逐条失败进 `failed[]`，不整批回滚） | LWW 默认 + CAS 可选 |
| `PUT /api/records/:tableName/:id` | recordRoutes | update | **replace**（契约，可 `result_data_mode:'merge'`） | `buildRecordWriteData`(+existing) | `where {id, version}`（客户端带 `version`） | **原子 +1** | 单语句 CAS | 乐观锁 |
| `POST /api/sync/records`（App） | syncRoutes | create/update/delete | update=`**merge**`（可 `'replace'`） | `normalizeWriteJson` | `expected_version`/`version` → CAS | **原子 +1** | 逐条；删除/更新各自单语句 | CAS 或明确 LWW |
| `POST /api/sync/batch` | syncRoutes | 同上（数组） | 同上 | 同上 | 同上 | 同上 | 逐条，**部分成功**（`results[]`/`errors[]` 可对应 syncId） | 同上 |
| `POST /api/test-records`（legacy 写） | recordRoutes | create | — | `normalizeWriteJson`(create) | 无 | `version=1` | 单语句 | create |
| `PUT /api/test-records/:id` | recordRoutes | update | update=`**merge**`（可 `'replace'`） | `normalizeWriteJson`(+existing RD) | `version` → CAS；未带 → LWW + 日志 | **原子 +1**（本轮修复） | 单语句 | CAS 或 LWW |
| `DELETE`（records / sync / test-records） | 各路由 | delete | — | — | 无 | — | 单语句 | 物理删除（`/sync/queue` 仅 archived，admin） |
| `scripts/import-*.mjs`（已执行完的导入） | scripts | 直接写库 | replace（历史口径，含上下文副本） | 自算哈希/显式码 | 无 | 显式赋值 | 批量（脚本内） | 一次性导入，刻意保留历史口径 |

---

## D. `/stats` 集合数学定义（互斥，可人工验算）

```
AuthorizedUniverse   = 授权类型内 ∧ 授权学校 ∧ 授权业务日期范围内（有范围时，按 validDate 且日期∈[grant.start, grant.end]）
scope_total          = |{ AuthorizedUniverse ∧ validDate ∧ date ∈ [max(grant.start,req.start), min(grant.end,req.end)] }|
request_out_of_range = |{ AuthorizedUniverse ∧ validDate ∧ date ∉ 请求范围 }|
excluded_total       = |{ AuthorizedUniverse ∧ ¬validDate }|      -- 仅当授权**未**限定日期范围时可能 > 0；否则恒为 0
validDate            = 格式 YYYY-MM-DD ∧ 真实公历（月 01–12、日符合该月与闰年上限）

恒等式：universe_total = scope_total + request_out_of_range_total + excluded_total
✅ 并集完备且两两不相交（validDate / ¬validDate 互斥，请求范围内外互斥）
🚫 授权范围外的记录**不属于任何集合**，不出现在任何返回值中（不可推断其数量）
```

---

## E. 测试结果

| 层级 | 命令 | 结果 |
|---|---|---|
| 静态 | `node --check`（5 个改动后端文件）；`git diff --check` | 通过 / 无空白问题 |
| 单元+契约 | `cd backend && node --test tests/` | **87 项：84 pass / 0 fail / 3 skipped**（3 个需隔离库的套件在无环境变量时跳过） |
| 数据库集成 | `sudo -u foodsentinel bash /tmp/run-openapi-db-tests.sh` | **33/33**：partial-update 10、records db-integration 10、stats-date 13（**顺序执行**，见下） |

**新增回归用例（反例优先，修复前必失败）**

| 用例 | 命令 | 结果 |
|---|---|---|
| Test A-1/A-2/A-3：context-only 更新不得清空（sync／legacy PUT／records PUT 三条路径） | 上述 DB 套件 | ok |
| Test B-1/B-2：局部业务字段更新保留兄弟字段；`replace` 差异显式化 | 同上 | ok |
| Test C：`{}`/缺省/`null` 不改动；非法结构 400 | 同上 | ok |
| Test D：同步中途新增 → 不得标记已同步、必须补齐 | `node --test tests/openapi/sync-client.test.mjs` | ok（旧实现必失败） |
| Test E：第 2 页 504 → 正式状态逐字段不变 | 同上 | ok |
| Test F：授权外记录数变化 → 返回值不变 | DB 套件（stats #8） | ok |
| Test G：桶互斥 + by_type 汇总一致 | DB 套件（stats #10） | ok |
| Test H：无任何日期范围时脏日期不得进入 `scope_total` | DB 套件（stats #4） | ok |
| Test I：`2026-02-30/13-01/00-10` 不算有效、不 500、投影 `test_date=null` | DB 套件（stats #5/#6） | ok |
| Test J/K/K-2：CAS 冲突 409、LWW 递增、批量一致 | DB 套件（partial J/K/K-2） | ok |
| Test L：oil 未知枚举不得默认合格 | contract 用例 + stats #7 | ok |

**隔离库说明（§6 强制项）**

- 连接库名：`foodsentinel_review_test`（**不是生产**）。
- 连接来源：仅 `REVIEW_TEST_DATABASE_URL`，且断言库名匹配 `review_test`；未配置时整文件 **SKIP（SKIP: TEST_DATABASE_URL not configured）**，不使用任何默认/生产连接。
- **`lib/tenantClient.js` 的 `baseDatabaseUrl()` 读 `process.env.DATABASE_URL`（不是传入的 prisma 实例）** —— 测试进程必须先把该变量重定向到隔离库；否则路由内连接会指向生产（本轮之前的实现确实会尝试连生产，因生产无该 schema 而未产生写入；现已强制）。
- 隔离断言时机：`test.before()` 内、**任何读写之前** `assertIsolated()` 断言 `current_database()`；此后才做 fixture seed。
- 清理：`after()` 按 `created_by` + 前缀双条件删除；运行器**顺序执行**三个套件（共用同一租户 schema，`node --test` 默认并发会互相污染统计基数）。
- 未打印任何密码/完整连接串（脚本只回显库名与占位符）。

---

## F. 剩余风险（未解决项，按真实状态列出）

1. **TPM 单位/阈值缺外部权威规格**：仓库内证据一致（前端 `frontend/js/modules/GenericTest.js:652` 显示 `g/100g`；`getTpmLevel` 用 `≤0.13 合格`；字段字典已写明 `0.06 = 0.06 g/100g，勿 ×100`），但**没有设备协议/计量文件**证明设备输出的物理量口径。本轮**未改阈值**。需业务方提供：设备型号与输出协议、TPM 计量单位（质量分数 vs 体积分数）、0.13/0.25 的出处标准。
2. **oil 未识别等级**：现回退 `result` 文本（实测生产 `colorLevel` 仅 `合格/警戒`，本改动对现有数据零影响）。若业务方坚持"其它等级也算合格"，需给出权威枚举并登记到 `OIL_COLOR_LEVEL_PASS`——但**不应**回到"非空即合格"的 fail-open。
3. **App 兼容性未验证**：App 源码不在本仓，无法验证其离线队列是否携带 `expected_version`、是否会因"merge 语义"而期望删除字段（删除必须显式 `null`）。当前 sync 端点**默认 LWW**（为兼容离线队列），若 App 能带上版本号，建议尽快切换为 CAS。
4. **`/api/sync/batch` 为部分成功语义**：单条失败不整批回滚；调用方必须以 `results[]/errors[]` 的 `syncId` 对齐重试（已文档化，但与"整批原子"不同）。
5. **`unknown` 仍计入合格率分母**（v1 指标语义未变）：因此 `pass_rate<1` 不等于"其余不合格"。是否拆分口径需业务确认（建议新增字段而非改旧字段）。
6. **旧跟踪引用 + upstream 不可解析**：`origin/Product_tencent_CVM` 本地陈旧、`@{upstream}` 报错（fetch refspec 仅含 main）。推送需显式 `git push origin Product_tencent_CVM`。本轮**未改 git config**。
7. **历史导入脚本仍写上下文副本**（`import-{tjb,zhyz}-backup.mjs`）：刻意保留（改动会影响其内容哈希与去重），已在 `backend/scripts/README.md` 记录；新记录不再产生副本。
8. **未做**：生产构建/发布/重启/真机界面点击/OpenAPI 线上冒烟（本轮未获授权）。

---

## G. Diff

```
$ git status --short
 M README.md
 M backend/lib/openApiScope.js
 M backend/lib/recordNormalize.js
 M backend/routes/openApiRoutes.js
 M backend/routes/recordRoutes.js
 M backend/routes/syncRoutes.js
 M backend/tests/openapi/contract.test.mjs
 M backend/tests/openapi/stats-date.integration.test.mjs
 M docs/OPEN_API_INTEGRATION.md
 M docs/examples/openapi-sync-client.mjs
?? backend/tests/openapi/sync-client.test.mjs
?? backend/tests/records/partial-update.integration.test.mjs

$ git diff --stat
 10 files changed, 771 insertions(+), 344 deletions(-)
（含 docs/examples 302 行重写、stats 集成 303 行重写、README +27、openApiScope +57、recordNormalize +113、openApiRoutes +78、recordRoutes +115、syncRoutes +52）

$ git diff --name-status
M README.md / M backend/lib/openApiScope.js / M backend/lib/recordNormalize.js
M backend/routes/openApiRoutes.js / M backend/routes/recordRoutes.js / M backend/routes/syncRoutes.js
M backend/tests/openapi/contract.test.mjs / M backend/tests/openapi/stats-date.integration.test.mjs
M docs/OPEN_API_INTEGRATION.md / M docs/examples/openapi-sync-client.mjs
```

- untracked：**2 个**（均为本轮新增测试，见上）——**无**无关文件、无临时脚本、无 `.env`/凭证/数据库导出。
- `git diff --check` 通过；敏感串扫描（password/secret/token/DATABASE_URL/postgresql:///PRIVATE KEY）**无命中**（占位连接串仅出现在测试文件的注释里，形如 `postgresql://USER:PASS@…review_test`）。
- 无 schema 变更 → **无需迁移**。

---

## H. 发布判断

### `READY FOR HUMAN REVIEW`

不阻塞项（本轮验收底线逐条对照）：

| # | 验收项 | 状态 | 证据 |
|---|---|---|---|
| 1 | context-only 更新不再清空结果 | ✅ | Test A-1/A-2/A-3 |
| 2 | 局部更新不丢兄弟字段 | ✅ | Test B-1/B-2 |
| 3 | head/tail 不一致不推进 checkpoint | ✅ | Test D |
| 4 | 失败不留半同步状态 | ✅ | Test E |
| 5 | 第三方统计不泄露授权外记录数 | ✅ | Test F |
| 6 | 统计桶互斥且总量自洽 | ✅ | Test G + 恒等式断言 |
| 7 | 日历非法日期不算有效、不触发 500 | ✅ | Test I（含投影 `test_date=null`） |
| 8 | 各写入口 version 语义明确且经测试 | ✅ | Test J/K/K-2 + 审计表 §C |
| 9 | oil 未知枚举不自动升为合格 | ✅ | Test L + stats #7 |
| 10 | TPM 无依据时不擅自改单位/阈值 | ✅ | 未改；风险见 §F.1 |
| 11 | 文档/字段字典/示例客户端与实现一致 | ✅ | `docs/OPEN_API_INTEGRATION.md`（§4.3.1 checkpoint 原子性、§5.7 集合定义与 oil 枚举）、`README §4.4`、`docs/examples/openapi-sync-client.mjs` |
| 12 | 全测试门禁通过 / skip 有明确原因 | ✅ | 87 单测（3 skip 需隔离库）+ 33/33 DB |
| 13 | 未接触生产数据库/授权/部署 | ✅ | 全部 DB 操作在 `foodsentinel_review_test`（运行时断言）；未跑 `build:prod`/未重启/未改授权 |

**阻断项：无。** 需人工决策的事项（不影响正确性）：§F.1 TPM 外部规格、§F.2 oil 枚举口径、§F.5 `unknown` 分母口径、§F.3 App 是否切换 CAS。

> 本轮**未**执行 `git add` / `commit` / `push`。若后续要求提交：逐文件 `git add <具体文件>`（含 2 个 untracked），提交信息建议
> `fix(open-api): harden partial updates, sync atomicity and stats scope`；推送用 `git push origin Product_tencent_CVM`（**不加 `-u`**）。

---

## I. 独立审阅（REVIEW.md，针对 `d090b77`）处置对照

> 审阅方结论：不建议直接发布 `d090b77`，列出 F1–F9。逐条复核结果（**均已在工作区处理**，除 F9 的指标口径变更需业务决策）：

| 项 | 审阅判定 | 本轮状态 | 证据 / 处理 |
|---|---|---|---|
| **F1**（P1）只改上下文清空结果 + **扁平更新被静默忽略** | 真实缺陷 | ✅ 已修（含**审阅新增的第二个反例**） | ① strip 后无业务键 → `undefined`（不改动）；② 局部更新默认 merge；③ **扁平业务字段**（`{id, result:'合格'}`）改为并入 result_data（旧行为是"成功但无变更"）；`expected_version`/`result_data_mode` 纳入控制键 | Test A-1/A-2/A-3、B、C、**Test M**（新增） |
| **F2**（P1）legacy PUT 有版本条件但不递增版本 | 真实缺陷 | ✅ 已修 | `version: { increment: 1 }`；并补**双写者**反例 | **Test J-2**（新增：v0 两个写者 → 1×200 且 v0→v0+1，另 1×409） |
| **F3**（P1）参考客户端持续漏数 + 失败轮次已改本地数据 | 真实缺陷 | ✅ 已修 | candidate → tail 校验（digest+scope+projection）→ 原子提交；异常不触碰 checkpoint；退避重试 | Test D / E / 异常语义 / **tail 失败 + 重试耗尽**（新增）/ 替换式重投影 |
| **F4**（P1）统计返回授权日期之外的数量（并指出原集成测试把越界计数当正确期望） | 真实缺陷 | ✅ 已修（**测试期望已重写**） | 删 `out_of_range_total`，改 `universe_total` + `request_out_of_range_total`；授权外记录不出现在任何字段 | Test F（注入 999 条授权外记录 → 返回值逐字段不变） |
| **F5**（P2）日期排除不自洽 + 日历非法值当有效 | 真实缺陷 | ✅ 已修 | 互斥桶 + 恒等式；`businessDateValidSql()` 真实公历校验（纯 CASE，脏值不做 `::date`） | stats #4/#5/#6（`2026-02-30`/`13-01`/`00-10`）：不进 scope、不 500、`test_date=null` |
| **F6**（P1）投影变了但指纹/摘要不变 → 客户端永久保留旧字段 | 真实缺陷 | ✅ 已修 | 新增 `PROJECTION_REVISION`（投影实现修订号，改动投影必须 bump）+ `allowedKeysFingerprint()`（学校自定义字段对输出的影响）；两者进入 `projection_fingerprint` → 传导到 `manifest digest`；/test-records、/samples、/sync/manifest、超管 preview 四处同源 | contract 用例（配置指纹影响指纹；记录行不变仅投影变化 → digest 变化） |
| **F7**（P2）白名单漏掉 GenericTest 支持的复检结构 | 真实缺陷 | ✅ 已修（**旧断言按写入路径修正**） | 依 `frontend/js/modules/GenericTest.js:549-550` 写入路径，为 oil/pesticide/leanMeat 登记 `result.recheckRecords`；`user` 仍被 PII 剔除 | contract 用例（登记 + 白名单允许 + 投影含复检证据且无 `user`）；旧断言"果蔬不应有复检字段"已改为按写入路径断言 |
| **F8**（P1）隔离检查可误放行 + 整表删除 | 真实缺陷 | ✅ 已修 | 新增 `tests/_isolation.mjs`：**解析连接串**校验库名（用户名/密码/query 含 `review_test` 不算）、schema 白名单 `school_review…`、生产黑名单；`assertIsolated()` 在**读写前**校验真实 `current_database()`/`current_schema()`；清理强制带范围（`cleanupScoped`，空 where 直接抛错）；`deleteMany({})` 已移除；`createRequire(import.meta.url)` 去掉写死路径 | **`tests/records/isolation-gate.test.mjs`**（纯函数负例：用户名/密码/query 造假、真实 schema、未配置变量、无范围清理） |
| **F9**（P2）统计按初检判定，与明细最终结论不一致（既有问题） | 真实差异（非本轮引入） | ⚠️ **契约已声明，语义未改**（需业务决策） | `/stats` 新增 `metric_basis='initial_conclusion'` + `metric_basis_note` 说明"明细 pass 未计入分子"是预期差异；文档 §5.7 同步。**未擅自改变 v1 指标含义**；如需最终结论口径，将以新字段提供 |

**本轮新增/变更测试**：`tests/_isolation.mjs`（门禁）、`tests/records/isolation-gate.test.mjs`（5 项负例）、partial-update 增 Test J-2/Test M、sync-client 增 tail 失败/重试耗尽、contract 增 F6/F7 两项并修正 1 项旧断言。

**最终门禁**：`node --test tests/` = **95 项（92 pass / 0 fail / 3 skipped）**；隔离库顺序集成 = **35/35**（partial-update 12、records 10、stats 13）。

**仍未解决 / 需决策**：F9 的指标口径（初检 vs 最终结论）属业务决策，本轮只做**声明**；其余 F1–F8 均有反例锁定。此外 §F 的 TPM 外部规格、App 兼容性、生产发布一致性仍未验证（原因同 §F）。
