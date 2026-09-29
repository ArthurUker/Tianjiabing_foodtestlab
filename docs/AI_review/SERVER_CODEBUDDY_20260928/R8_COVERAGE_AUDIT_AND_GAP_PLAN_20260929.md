# R8 · 覆盖率审计与补齐计划（2026-09-29）

> 回答一个问题：**整个系统的所有代码是否都做了深度分析？—— 没有。** 本文件给出可核对的口径、缺口清单与补齐计划。
> 本轮**只做审计与计划，不做任何修复**。未改产品源码、未改数据库、未启停服务。
> 证据级别：目录/文件数/行数为**本轮实测**；"是否已审"来自历史报告的实际记录（可逐条回溯）。

## 一、全仓代码规模（实测）

| 目录 | 文件数 | 行数 |
| --- | --- | --- |
| `backend/lib` | 41 | 11,481 |
| `backend/routes` | 18 | 9,434 |
| `backend/middleware` | 6 | 1,529 |
| `backend/modules` | 2 | 1,832 |
| `backend/scripts` | 25 | 2,874 |
| `backend`（根 `*.js`/`*.mjs`） | 2 | 994 |
| `frontend/js/core` | 8 | 3,089 |
| `frontend/js/services` | 6 | 3,773 |
| `frontend/js/modules` | 47 | 23,827 |
| `frontend/js/utils` | 21 | 3,897 |
| `frontend`（其它 js） | 8 | — |
| `tests` | 37 | 7,496 |
| `backend/tests` | 74 | 16,414 |
| **合计（js/mjs）** | **313 个文件** | **≈ 86,000 行** |
| 未计入 | `deploy/*.sh`、`backend/prisma/migrations/*.sql`（17 个）、`frontend/**/*.html`、`*.css`、`jest.*.config.cjs`、`prisma/seed.js` 之外的 SQL | — |

> 口径说明：上表按目录 `find` 汇总得 **313 个 js/mjs**；生成逐文件清单时排除了运行时目录（`backend/uploads`、`backend/.export-jobs` 等不可读/非源码目录），实测得 **308 条**。两者差异 5 个即为这些运行时目录内的脚本，**以逐文件清单 `R8_FILE_INVENTORY_20260929.md` 的 308 条为准**。

## 二、覆盖率判定（三种口径必须分开）

| 口径 | 含义 | 规模（估） | 占全仓 |
| --- | --- | --- | --- |
| **① 逐行坐实** | 本人回读源码、行号进入报告、结论可复核 | **≈30 个文件的部分区段，约 3,000–4,000 行** | **≈ 4%** |
| **② 候选级清点** | 并行探查扫过、产出候选，**未逐条回读复核**（标记 `CANDIDATE_STATIC_UNVERIFIED`） | **≈90 个文件，约 35,000 行** | **≈ 40%** |
| **③ 完全未触达** | 从未被任何一轮读取或扫过 | **≈180+ 个文件** | **≈ 56%** |

⇒ **结论：没有做全量深度分析。** 目前是"**关键路径 4% 逐行坐实 + 40% 候选级扫过 + 56% 空白**"。

### 2.1 已逐行坐实的部分（口径 ①，可回溯）

| 领域 | 实际读过的位置（示例） |
| --- | --- |
| 迁移/发布 | `tenantProvisioner.js:196-336,1240-1300,2055-2070`、`scripts/005_cleanup-old-schemas.mjs`（全文）、`scripts/b-release-two-phase.sh`（全文）、`scripts/004…mjs:448-463`、`deploy/deploy.sh:352-373`、`migrations/20260928120000`（全文）、`20260927130000:82-103` |
| 就绪/隔离 | `server.js:300-376,505-600`、`lib/tenantClient.js`（全文） |
| 业务写入 | `lib/recordNormalize.js:318-392`、`routes/recordRoutes.js:40-116,750-825`、`routes/syncRoutes.js:105-165,361-366` |
| 会话 | `routes/sessionRoutes.js`（全文）、`middleware/idempotencyMiddleware.js:24-41` |
| 备份/恢复 | `lib/backupService.js:185-217,440-485,505-550,655-700`、`routes/adminDiskRoutes.js:128-288`、`routes/schoolBackupRoutes.js:130-200`、`routes/adminBackupRoutes.js:392-427`、`lib/restoreService.js:130-140,230-260,510-530`、`lib/dumpCounts.js`（全文） |
| 开放接口 | `lib/openApiKeys.js:60-97`、`lib/exportJobs.js:52-85`、`routes/adminOpenApiRoutes.js:898-990` |
| 契约 | `prisma/schema.prisma`（全文） |
| 前端（极少量） | `services/ExportService.js:986-1005`、`core/conclusionVerdict.js`（部分） |

### 2.2 完全未触达的部分（口径 ③，按规模排序）

| 缺口 | 规模 | 为何重要 |
| --- | --- | --- |
| **`frontend/js/modules` 47 个中的约 45 个** | ≈23,000 行 | 只在 R7 扫到 `Tableware.js`/`Dashboard.js`；其余检测模块（油品/病原体/肉蛋/通用）、`adminSchools/*` 各视图、登录/看板其它页面**从未读过**。前端是用户写入路径的**第一现场**（离线队列、去重、统计口径都在这层） |
| **`frontend/js/utils` 全部 21 个** | ≈3,900 行 | 工具层（时间/格式化/存储辅助）常被写入与导出复用 |
| **`backend/tests` 74 个 + `tests` 37 个中的约 109 个** | ≈23,900 行 | 收口条件要求"受影响测试全绿且 0 skip"；测试本身是否**假绿**只抽查了 2 个 |
| **`backend/lib` 41 个中的约 20 个未列名** | ≈5,000 行 | 含若干领域库（序列化/校验/统计辅助等）从未点名审阅 |
| **`backend/prisma/migrations` 17 个中的约 13 个** | — | 只全文审了 1 个、局部审了 2 个；**其余 14 个迁移的 SQL 从未逐条读**（历史不可逆操作、DO 块守卫、schema 限定都在这里面） |
| **`backend/scripts` 25 个中的约 21 个** | ≈2,000 行 | 运维脚本（备份/验证/导入/巡检）多数未审 |
| **`backend/modules` 2 个中的 `UserManager.js` 全文** | 1,832 行 | 仅被候选级扫过；账号生命周期核心 |
| **`frontend/**/*.html`、`*.css`、`jest.*.config.cjs`、`deploy/*.sh` 其余** | — | HTML 内联脚本与 CSP、构建/测试配置从未审 |
| **`prisma/seed.js` 之外的初始化与夹具** | — | — |

## 三、补齐计划（R8 起，按风险优先级并行推进）

> 原则：**先补"能被匿名/低权触达"和"会造成数据静默丢失"的空白**，再补其余；每批产出"候选 + 行号"，随后再进逐条坐实。**本轮不做修复。**

| 批次 | 目标 | 方法 | 产出与验收 |
| --- | --- | --- | --- |
| **R8-A（最高优先）** | `backend/lib` 剩余 ~20 个 + `backend/modules/UserManager.js` 全文 + `backend/middleware` 剩余 | 先自动生成**逐文件覆盖矩阵**（把 313 个文件打上 ①/②/③ 标签），再对 ③ 的 lib/middleware/modules 逐文件读 | 覆盖矩阵入仓；每个文件至少给出"读过/未读 + 一句话风险判定" |
| **R8-B** | **`backend/prisma/migrations` 全部 17 个** | 逐条读 SQL：不可逆操作（`SET NOT NULL`/`DROP`）、DO 块是否限定 schema、断言与回滚 | 每个迁移一行结论；与 SRV-117 同类问题一并归并 |
| **R8-C** | **`frontend/js/modules` 45 个未审 + `utils` 21 个** | 按"写入路径 / 统计口径 / XSS sink / 离线队列"四类专项扫，**不要漫读** | 每类一份清单；与 SRV-231/233/237 同族问题归并 |
| **R8-D** | **测试体系 111 个文件** | 专查"假绿"：skip/only、只断言不抛异常、mock 掉真实依赖、断言与实现同源 | 列出所有 skip/only 与弱断言；为收口条件 #5 做准备 |
| **R8-E** | `backend/scripts` 剩余 21 个 + `deploy/*.sh` 其余 + `*.html`/`*.css`/`jest` 配置 | 逐个读；重点看是否有写库/删文件/绕过门禁 | 同上 |
| **R8-F** | 对 R7 的 **40 条候选**逐条回读复核 | 按"最可能是真缺陷"排序，逐条证实/证伪/下调 | 全部从 `CANDIDATE_STATIC_UNVERIFIED` 转为 `CONFIRMED` 或 `REJECTED` |

**依赖**：R8-A 的覆盖矩阵应**先做**（它决定后续每批的清单是否完整）；R8-B/R8-C/R8-D 可并行；R8-F 可与其它批并行，但结论要先于"修复规划定稿"。

## 四、工作量与可行性提示

- 若按"全仓 86,000 行逐行坐实"口径，**远超单轮会话预算**；因此建议：**① 先出覆盖矩阵**（可自动化、一次产出），**② 再按风险分层**——把"逐行坐实"集中在 (a) 可被匿名触达的入口、(b) 写库与数据删除路径、(c) 判定口径与导出、(d) 凭据与会话 四类，其余以候选级+专项扫覆盖并明确标注未坐实。
- 这样最终能给出的诚实结论是："**全仓 100% 被扫过（候选级），X% 逐行坐实"**，而不是笼统的"已审完"。

## 五、边界

- 本轮只做覆盖率审计与补齐计划；**未修改任何文件**（仅新增本报告并更新 `FINDINGS.md`）。
- 数量为按目录实测的估算口径；**精确的逐文件矩阵**将在 R8-A 产出（届时可逐文件核对）。
- 脱敏：不含口令/连接串/token/API Key/`BACKUP_MASTER_KEY`/真实个人信息。
