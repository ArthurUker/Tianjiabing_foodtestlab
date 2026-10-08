# P3-W0-AUD039 — 最终统一入口矩阵（FINAL ENTRYPOINT MATRIX）

- **性质**：AUD-039 正式关闭件（收尾件 = P3-W0-T02D）；**本地验收（REVIEWED_PASS_LOCAL 预期），未提交、未部署、未做现网验证**。
- **固定基线**：HEAD `7343a8a9f8fc28b7ef2a6bad2b22c701b2fbf9e7` · branch `Product_tencent_CVM` · index 空。
- **口径来源**：T02A / T02B / T02C 已验收证据（引用路径，不复制大段日志）+ T02D 三条零配置拒绝冒烟复核（`evidence/P3-W0-T02D/`）。
- **单一事实源**：`tests/helpers/db-isolation.cjs`（门禁唯一实现）。三个 DB 消费链共用它：root Jest `setupFiles`、PG integration `setupFiles`、backend node:test ESM 薄桥接 `backend/tests/_isolation.mjs`（`createRequire` 同一实现，无第二份门禁）。live-api 不连库，只做回环 + 派生 code 边界。

## 1. 主矩阵（全部测试入口统一口径）

| 入口 | 配置来源 | 未配置行为 | 拒绝码 | 实例来源 | 已验收证据 |
|---|---|---|---|---|---|
| root Jest：`npm test`（`jest --coverage`）/ `npx jest --config jest.config.cjs` / 直跑 `jest --runTestsByPath tests/p0*.test.js` | `TEST_DATABASE_URL` + `TEST_DB_CONTEXT_FILE`（`jest.config.cjs` → `setupFiles`，在任何测试模块加载前） | **非零拒绝**（不 skip）；每个 suite 在 setup 即失败、0 用例执行 | `[T02A-ISOLATION-REFUSED] code=MISSING_TEST_URL`（码集合见 §2） | 任务自有 provisioner（`tests/isolation/provision.cjs up`） | T02B：`evidence/P3-W0-T02B/logs/root-full.log/.rc`、`p0-run.log/.rc`；T02B-R2：`rework2/logs/isolation-unit.json`（68/68）、`gate-*.{log,rc,obs.json}`、`obs-<label>-<token>.{net.log,modules.log}`；T02C：`evidence/P3-W0-T02C/logs/root-full.log/.rc`（257/255/2/0）+ `root-full-json.json`；T02D 冒烟：`evidence/P3-W0-T02D/logs/smoke-root-jest-noconfig.{log,rc}` |
| PG integration：`npm run test:integration` / `npx jest --config tests/integration/jest.integration.config.cjs [<file>]` | 同上（`tests/integration/jest.integration.config.cjs` → `setupFiles`，配置校验先于一切连接） | **非零拒绝**（不 skip、不降级） | 同上（缺配置 `MISSING_TEST_URL`；配置冲突 `URL_MISMATCH` 等） | 任务自有 provisioner（同实例、受限角色） | T02A：`logs/entry-refusal-npm.log/.rc`、`entry-refusal-direct.log/.rc`、`entry-refusal-mismatch.log/.rc`（`URL_MISMATCH` 且 `ECONNREFUSED=0`）、正对照 `entry-connect-attempt.log`（`ECONNREFUSED=10`）、`integration-run.log/.rc`；T02C：`logs/pg-integration.log/.rc`（23/23） |
| backend node:test：`npm run test:backend`（=`node --test --test-concurrency=1 backend/tests/**/*.test.mjs`，20 文件） | 同上；经 `backend/tests/_isolation.mjs` 薄桥接（`loadIsolation()`，配置合法后显式设 `DATABASE_URL`，非回落语义） | **fail-closed 拒绝**：6 个 DB 套件各注册 1 条拒绝用例（`assert.fail` → 文件 rc≠0），纯函数套件照常运行，整体非零 | `[T02C-ISOLATION-REFUSED] code=MISSING_TEST_URL`（同码集合；旧符号另见 §3） | 任务自有 provisioner + `backend/tests/t02c-instance-fixture.mjs`（精确重建门禁/fixture 对象） | T02C：`logs/backend-full.log/.rc`（251/251/0 skip）、`backend-refusal-noconfig.log/.rc`（rc=1）、`t02c-instance-fixture.json/.rc`；T02D 冒烟：`evidence/P3-W0-T02D/logs/smoke-backend-noconfig.{log,rc}` |
| live-api：`node tests/integration/live-api.mjs`（`npm run test:live-api` 是其 harness 包装，须带 `<runId> <port> <evidenceDir>`） | `T02C_BASE_URL`（**仅回环** `127.0.0.1`/`localhost`/`::1`，无默认端口）+ `T02C_SCHOOL_CODE`（provisioner 派生，无硬编码 `tianjiabing`） | **非零拒绝**（拒绝发生在发出任何请求之前） | `T02C-LIVE-API-REFUSED` | 任务 harness 拉起的真实后端（回环 + 任务自有端口；跑完停止并核验端口释放） | T02C：`logs/live-api-refusal-nourl.log/.rc`、`live-api-refusal-external.log/.rc`、`live-api-harness.json`、`live-api-run.log`、`live-api-backend-server.log`；T02D 冒烟：`evidence/P3-W0-T02D/logs/smoke-live-api-nourl.{log,rc}` |
| isolation 套件：`npx jest --config tests/isolation/jest.isolation.config.cjs` | **无 DB**（纯函数 / 合成 env / 子进程观测器） | 不适用（该套件自身不连库；它验证的正是其他入口的拒绝行为） | —（被验证对象：`MISSING_TEST_URL` / `URL_MISMATCH` / `T02C_LEGACY_DISABLED`） | —（观测器用合成环境；不建实例） | T02A：`logs/gate-unit.log`（17/17 单元）、`logs/live-probe.log`（11/11 探针检查）；T02B：`logs/isolation-unit.json/.log/.rc`（54/54 当时）；T02B-R2：`rework2/logs/isolation-unit.json/.log/.rc`（**68/68**） |

### T02D 冒烟实测（轻量复核，不建实例、不连库）

| 冒烟入口 | 命令（零配置，env 显式 unset） | rc | 观测 |
|---|---|---|---|
| root Jest | `npm test -- --bail=1` | **1** | `Test Suites: 27 failed, 27 total`；`Tests: 0 total`；`[T02A-ISOLATION-REFUSED] code=MISSING_TEST_URL` |
| backend node:test | `npm run test:backend` | **1** | `tests 198 / pass 192 / fail 6 / skipped 0`；6 条 fail 均为 `[T02C-ISOLATION-REFUSED] code=MISSING_TEST_URL` |
| live-api | `node tests/integration/live-api.mjs`（无 `T02C_BASE_URL`） | **1** | `[T02C-LIVE-API-REFUSED] T02C_BASE_URL is required（本任务自有的回环地址；不存在默认值）` |

三条日志均无连接串/凭据/环境转储；rc 与日志落盘于 `evidence/P3-W0-T02D/logs/`（`*.rc` 为真实子进程退出码）。

## 2. 拒绝码集合（`tests/helpers/db-isolation.cjs` CODES，结构化、不含秘密）

`MISSING_TEST_URL` · `MISSING_CONTEXT` · `CONTEXT_UNREADABLE` · `CONTEXT_INVALID` · `CONTRACT_MISMATCH` · `URL_INVALID` · `URL_MISMATCH` · `URL_PARAM_FORBIDDEN` · `URL_PARAM_DUPLICATE` · `DEFAULT_PORT_REJECTED` · `BUSINESS_NAME_REJECTED` · `IDENTIFIER_INVALID` · `REGISTRY_REJECTED` · `RUNTIME_IDENTITY_MISMATCH` · `RUNTIME_PRIVILEGE_REJECTED` · `RUNTIME_MEMBERSHIP_REJECTED` · `MARKER_MISMATCH` · `SCHEMA_NOT_ALLOWED` · `PG_MODULE_MISSING` · `TARGET_URL_DRIFT` · `TARGET_CODE_NOT_ALLOWED` · `PROBE_INDETERMINATE`。

- **配置级**码在**连接之前**出现（T02A 判别：`URL_MISMATCH` 时 `ECONNREFUSED=0`）；
- **运行期**码（`RUNTIME_*`/`MARKER_MISMATCH`）在 DDL/DML 之前（受限角色：`NOSUPERUSER/NOCREATEDB/NOCREATEROLE/NOREPLICATION/NOBYPASSRLS`、拒绝一切成员关系、marker 只读）；
- backend 入口前缀 `[T02C-ISOLATION-REFUSED]`、root/integration 前缀 `[T02A-ISOLATION-REFUSED]`、live-api 前缀 `[T02C-LIVE-API-REFUSED]`，三者信息面均**不回显连接串/凭据**。

## 3. 已废弃入口语义（迁移指引）

| 已废弃 | 现行行为 | 迁移目标 | 证据 |
|---|---|---|---|
| `REVIEW_TEST_DATABASE_URL`（backend 旧约定，仅校验库名） | 旧符号 `testDbUrl()` / `parseDbUrl()` / `assertIsolationConfig()` 调用即抛 `code=T02C_LEGACY_DISABLED`（`[T02C-MIGRATION]` 指引，不含连接信息） | `TEST_DATABASE_URL` + `TEST_DB_CONTEXT_FILE`（`docs/TEST_DATABASE_ISOLATION.md`） | `backend/tests/_isolation.mjs:24-35`；T02C `logs/backend-refusal-noconfig.log`；T02B-R2 `rework2/logs/` 门禁用例 |
| 仅设置普通 `DATABASE_URL` 视为授权 | 不构成授权（无 fallback；`DATABASE_URL` 仅由门禁在**校验通过后**显式赋值为受校验测试 URL） | 同上 | T02B-R2 `direct-p0-only-database-url` 用例（`MISSING_TEST_URL`、连接尝试 0） |
| `test:backend` 旧值 `jest backend/**/*.test.js`（失效 glob） | T02C 起为 `node --test --test-concurrency=1 backend/tests/**/*.test.mjs`（系**修改**既有脚本，非纯新增） | — | P3-W0-T02C_REVIEW.md §独立核验记录；T02C RESULT.md「T02D 更正索引」 |

## 4. 已知边界（登记，不扩称）

1. **Node Socket 观测不覆盖 Prisma 原生引擎内部连接**：观测器的“零连接尝试”只在 Node 层可观察；该层证据 = 数据库内实际身份 SELECT（tx 内共享核验）。不得把观测器零尝试扩称为所有底层连接。
2. **live-api 全绿未达成**：其既有前置假设（public 平台登录 + 预置 `tianjiabing` 学校数据）与隔离空实例/生产 `isValidSchoolCode`（NB-04）契约冲突，首个认证步骤返回 `400 非法学校代码`；属**另一包**（数据契约）范围，本矩阵不宣称其全绿（如实分栏见 T02C `RESULT.md` §live-api 用例执行）。
3. **T02C 实例内权限放宽**：backend 业务套件所需 `public` 业务表 DML + `CREATE ON SCHEMA public` 仅在该任务实例内、随实例销毁；后续涉及 backend 业务套件的包应把该权限模型纳入 provisioner 契约复审（T02C 复审 §6 登记，不阻塞）。
4. **默认 `npm test` 未拆分 unit/db**（AUD-040 范围）：缺测试上下文时默认命令整体拒绝，属**当前设计结果**，非回归。
5. **PG 实例来源统一为任务自有 provisioner**（独占实例 + 受限角色 + 派生 schema/租户）；不指向业务库、不读业务 dotenv。

## 5. 当前已验收计数基线（T02C 起）

| 套件 | 基线 | 来源（证据） |
|---|---|---|
| root Jest | **257 / 255 / 2 / 0 skip**（2 项固定历史失败：`tests/authSession.test.js` 断言行 `:259` / `:294`） | T02C `logs/root-full.log/.rc`、`root-full-json.json`；T02B-R2 同基线 |
| PG integration | **23 / 23** | T02C `logs/pg-integration.log/.rc`（T02A-R1–R3 扩展已验收） |
| backend node:test | **251 / 251 / 0 skip**（精确对账：190 PF 基线 + 4 `isolation-gate` 5→9 + 57 W0-T01 三 security 套件；190 中 7 个 DB 套件为**真实运行**非 skip） | T02C `logs/backend-full.log/.rc`；T02C RESULT.md「T02D 更正索引」；P3-W0-T02C_REVIEW.md §2 |
| isolation 套件 | **68 / 68** | T02B-R2 `rework2/logs/isolation-unit.json/.log/.rc` |

- T02D **未重跑**上述全量基线（纯文档/核验包），只做三条零配置拒绝冒烟；基线沿用 T02A/T02B/T02C 已验收证据。
- 三个“餐具 delta”观察（C02/C03/C04）登记 `CURRENT_HEAD_DELTA_OBSERVATIONS`，与本矩阵口径无冲突；不得用 suite 额外失败=0 掩盖。

## 6. 关闭口径

- 本矩阵即 AUD-039 的统一入口口径：**所有 DB 相关入口（root Jest / PG integration / backend node:test）**共用同一 `db-isolation` 门禁，未配置一律**非零拒绝**（不 skip、不回落 `DATABASE_URL`、不读业务 dotenv）；**live-api** 以回环 + 派生 code 边界非零拒绝；**isolation 套件**不连库。
- 验收证据：本矩阵 + T02D `evidence/P3-W0-T02D/`（RESULT / COMMANDS / TEST_RESULTS / 冒烟 rc·日志 / 输入对照 566 项 / 冻结 29 只读核验 / `HASHES_FINAL.json` 两次只读复验）。
- **边界**：本地验收，未 commit / 未部署 / 未现网验证。
