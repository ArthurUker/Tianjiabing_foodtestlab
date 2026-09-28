# 数据库测试隔离门禁（AUD-039 / RC-10 · P3-W0-T02A）

本文档描述**已接入本门禁的两个 PG integration 套件**（`tests/integration/concurrency.test.js`、
`tests/integration/roleAuditTrigger.test.js`）的运行方式、门禁语义与已知未接入入口。

> 状态：AUD-039 **未关闭**。本包只完成共享门禁与两个套件的接入；root Jest / backend 其余 DB 入口
> （含 `REVIEW_TEST_DATABASE_URL` 旧接口）留待后续包接入同一门禁。

## 1. 快速开始（本任务独占实例）

```sh
# 1) 创建独占 PG 实例（只监听 127.0.0.1、非默认端口；含受限角色、fixture、实例标记、外部 sentinel）
RUN_ID="t02a$(node -e "console.log(require('crypto').randomBytes(4).toString('hex'))")"
node tests/isolation/provision.cjs up --run-id "$RUN_ID" --port 55512
#   → 打印 contextPath（无密码）与 envPath（含密码，0600）

# 2) 载入测试环境并运行
set -a; . "/tmp/t02a-$RUN_ID/test-env.sh"; set +a
npm run test:integration            # 期望 13/13、0 skip

# 3) 额外验证（受限身份/sentinel/权限拒绝/失败清理）
node tests/isolation/live-probe.cjs

# 4) 销毁（归属核验 datadir + pid 后停止并删除本任务自有目录）
node tests/isolation/provision.cjs down --run-id "$RUN_ID"
```

门禁的纯单元回归（**不需要 PG**）：

```sh
npx jest --config tests/isolation/jest.isolation.config.cjs
```

## 2. 必需配置（无默认值、无 fallback）

| 变量 | 含义 | 拒绝行为 |
|---|---|---|
| `TEST_DATABASE_URL` | **唯一**连接来源；形如 `postgresql://<受限角色>:<pw>@127.0.0.1:<专属端口>/<专属库>` | 缺失 → `MISSING_TEST_URL`（仅设置 `DATABASE_URL` 不构成授权） |
| `TEST_DB_CONTEXT_FILE` | 任务 runner 生成的上下文 JSON（**不含密码**）：runId、loopback host/专属端口、库、受限角色、实例标记、允许 schema 与公共 fixture 清单 | 缺失/不可读/非法/与 URL 不符 → `MISSING_CONTEXT` / `CONTEXT_UNREADABLE` / `CONTEXT_INVALID` / `URL_MISMATCH` |

其他被拒绝的情形：URL query 覆盖身份边界（`host`/`port`/`user`/`dbname`/`search_path`/`options`/`service`/`hostaddr` 等 → `URL_PARAM_FORBIDDEN`；允许项仅 `schema`（须在 allowedSchemas 内）与 `application_name`）、业务样式库/角色/标记（`foodsentinel*`/`school_tjb`/`school_a|b|c`/`postgres`/`test` → `BUSINESS_NAME_REJECTED`）、固定业务 schema（`SCHEMA_NOT_ALLOWED`）。

**拒绝发生在连接之前**：`tests/helpers/db-isolation-setup.cjs` 作为 Jest `setupFiles` 在每个测试文件加载前执行，
缺失/冲突配置直接抛错 → Jest 非零退出（**不 skip、不降级**）；直接 `jest --config` 与单文件入口同样经过该 setup。

## 3. 运行时身份核验（连接之后、DDL/DML 之前）

受控连接（`tests/helpers/db-isolation.cjs` 的 `connectGuarded`）连接后**只做只读 SELECT**：

- `current_database()` / `current_user` / `session_user` / `inet_server_addr()`（去掩码）/ `inet_server_port()`
- 角色属性：`rolsuper` / `rolcreatedb` / `rolcreaterole` / `rolreplication` / `rolbypassrls` 必须全为 false
- 角色成员关系：不得通过任何成员关系持有 `rolsuper`
- 实例标记：`public.t02a_instance_marker.instance_tag` 必须等于上下文的 `instanceTag`（测试角色只读）
- 任一不符 → 断开连接并抛错（`RUNTIME_IDENTITY_MISMATCH` / `RUNTIME_PRIVILEGE_REJECTED` / `MARKER_MISMATCH`），**不做猜测性 cleanup**

校验与后续操作**绑定同一连接**；Prisma tenant 客户端依赖 `process.env.DATABASE_URL`（仅在配置校验通过后由 setup 显式设为测试 URL），
测试内另有 `expect(process.env.DATABASE_URL).toBe(cfg.url)` 防御性断言。

## 4. 隔离实例与受限角色

- provisioner（`tests/isolation/provision.cjs`）以**管理身份**创建独占 cluster（唯一目录/端口、只监听回环），
  管理连接**不传给测试进程**；
- 受限角色：`NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS`，只授予必要 DML/只读
  （无 CREATE/DROP；`AuditLog` 需 INSERT 是 trigger 以调用者权限写入所需；`t02a_instance_marker` 只读）；
- 公共 fixture（`public.messages`、`public.revoked_tokens`）与 tenant schema/表/种子行、roleAudit schema
  与 **生产 `role-audit-trigger.sql`**（经 `psql -v schema=<已校验标识符>`）均由 provisioner 精确创建；
- 外部 sentinel 由**独立所有者**持有（测试角色读写均被拒绝，实测 `42501`）。

## 5. 清理归属

- 测试只登记并清理**自己插入的行**（`cleanupRegistered`）；不再 `TRUNCATE`/`DROP SCHEMA school_%`；
- cleanup/disconnect 失败 → 聚合错误（`CLEANUP_FAILED`），保留原始错误并使整次运行非零；
- sentinel 与其它所有者对象不由测试清理；实例最终由 provisioner 归属核验后整体回收。

## 6. 入口接入状态（P3-CLOSE-B-R1 / AUD-040 时点）

| 入口 | 现状（2026-09-26 起） |
|---|---|
| root Jest `npm test` | 拆分为 `test:db`（DB 面，挂同一门禁）+ `test:unit`（离线面，**不挂**门禁）；`npm test` = 两者串行（DB 先、缺配置即 fail-closed 且零连接尝试） |
| root Jest **unit 面** | `jest.unit.config.cjs`：28 文件，**不需要** `TEST_*`、不连库（audit runner 守护零 DB 指示符）；保留 `tests/setup-env.js`（TextEncoder polyfill），仅不挂 `db-isolation-setup.cjs` |
| root Jest **DB 面** | `jest.db.config.cjs`：显式清单（当前 1 文件 `tests/p0ProvNoAdminInSchool.test.js`），挂 `db-isolation-setup.cjs` |
| `backend/tests/**`（node:test） | 经 `backend/tests/_isolation.mjs` 桥接同一门禁（`REVIEW_TEST_DATABASE_URL` 旧符号已废弃 → `T02C_LEGACY_DISABLED`）；入口由 `tests/runners/run-backend-tests.mjs` **递归枚举**（不再用 shell `**`） |
| `tests/integration/**` | 同一门禁（`tests/integration/jest.integration.config.cjs`） |
| `tests/isolation/**` | 不连库（门禁负例与被验证对象）；`npm run test:isolation` 显式入口 |
| `tests/integration/live-api.mjs` | 不连库、只回环 + 派生 code 边界（`T02C-LIVE-API-REFUSED`）；`npm run test:live-api` 为 harness 包装 |
| `deploy/deploy.sh` 的部署校验 | 已由 W0-T01 覆盖（JWT），与本门禁无关 |

## 7. 安全边界（不做的事）

- 不连接生产/业务/已有开发实例；不读取真实 `.env`；`DATABASE_URL` 单独存在不会授权连接；
- 危险 URL 负例只做纯解析或连接替身（`connect=0`），绝不尝试真实连接；
- 真实权限/身份负例只在本任务自有 cluster 内执行；实例销毁前核验 datadir/pid/端口归属，不 `pkill` 未知进程、不删未知目录。

---

## 8. R1 修订（P3-W0-T02A-R1；闭合复审 R1–R4）

- **Prisma 消费链也先核验**：测试层 `withVerifiedTenantTx()` 在**新的 interactive transaction** 内先用共享
  `verifyRuntimeIdentity`（薄适配同一函数）核验 `expectedSchema`/身份/namespace owner/marker 只读，再执行同一 tx 的业务 SQL；
  不再以 pg Client 的验证结果给 Prisma 连接作担保。
- **契约精确绑定**：`allowedSchemas` 必须与 runId 派生集合**恰好相等**；`database/role/instanceTag/markerTable/tenants/
  roleAudit/sentinel/allowedFixtureObjects` 全部与派生契约一致；固定业务名与跨 run 值一律拒绝（`CONTRACT_MISMATCH`）。
  URL 全参数解析：重复参数 `URL_PARAM_DUPLICATE`、白名单外 `URL_PARAM_FORBIDDEN`、decode 异常 `URL_INVALID`（不回显输入）、
  **默认 5432 拒绝**（`DEFAULT_PORT_REJECTED`）。
- **身份收紧**：TCP 地址（去掩码）与端口必须相符、**null 地址拒绝**；角色记录必须恰好一条且五项属性为布尔 false；
  **拒绝测试角色的所有直接成员关系**（两跳提权路径同样被 count 捕获）。
- **实例与凭据**：`scram-sha-256` 主机认证 + 管理口令 0600 文件（仅 provisioner/controller 读取）；
  `REVOKE CONNECT … FROM PUBLIC`（仅授权目标库）；`REVOKE CREATE ON SCHEMA public FROM PUBLIC`；
  测试角色无 CREATE、marker 只读（由 catalog `has_table_privilege` 证明）；跨库连接与冒用管理员均被拒。
- **登记与生命周期**：提交成功即登记任务行键；`settleAll` 分别尝试所有释放动作（错误聚合、保留根因）；
  `ownership.json`（原始 datadir + realpath + 真实端口 + PID）供 up/down/status 归属核对；**stop 非零禁止删目录**；
  up 失败按阶段收尾（启动后失败安全停止自有实例）。
- **示例路径**：请使用 provisioner 输出的**真实** `contextPath`/`envPath`（本机 `os.tmpdir()` 为 `/var/folders/...`，
  不一定是 `/tmp`）。

---

## 9. R2 修订（P3-W0-T02A-R2；跨库权限、凭据传递、安全清理与汇总器）

- **CONNECT**：除目标库外，`postgres`/`template1` 的 CONNECT 对 PUBLIC 与测试角色**显式收回**；跨库负例必须使用
  **同一正确测试凭据、仅改变数据库名**，并期待 **42501**（28000/28P01/ECONNREFUSED/超时不算通过）；冒用管理员另测（28P01）。
- **管理凭据传递**：psql 使用 **0600 PGPASSFILE**，argv 只含 `-h/-p/-U/-d/-v/-f` 等安全参数（永不包含口令或带密码 URL）；
  provisioner 在真实 spawn 边界记录 `psql-argv.json` 供审计；Jest 环境不继承管理凭据。
- **marker 只读性**：catalog 检查 `INSERT/UPDATE/DELETE/TRUNCATE` **全部**为 false（任一为 true → `MARKER_MISMATCH`）；
  可经 controller 临时授权注入验证，随后必须撤销并复验恢复。
- **删除门禁（三态探测）**：`probePid`/`probePort` 返回 present/absent/**unknown**；命令失败或输出畸形一律视为 unknown 并 **fail-closed**。
  `down` 仅当 `stop rc=0` **且** 进程 absent **且** 端口 released 同时成立才删除；归属互核（`ownership.json` ↔ `postmaster.pid` ↔ ps 命令行 ↔ 监听者 PID）
  不一致时 **零 stop / 零 delete**。`up` 在 start **之前**登记 `start_attempted`；探测到自有实例则安全停止 + 复验后才清理，否则保留现场。
- **前置拒绝**：`withVerifiedTenantTx` 在创建客户端/事务前检查 `DATABASE_URL == cfg.url`、tenant code 派生关系；
  不接受调用方覆写 `expectedSchema`（`EXPECTED_SCHEMA_OVERRIDE_FORBIDDEN`）。
- **入口观测**：`tests/helpers/connection-observer.cjs`（测试专用，patch `net.Socket.prototype.connect`）用于证明"配置拒绝 → 连接尝试=0"，
  并以回环死端口正对照证明观测器有效；不访问业务地址。
- **汇总器**：rc 必须存在、非空、严格整数；必需 rc/check/case 为显式清单；`--selftest` 以副本验证缺文件/空 rc/畸形 rc/缺 check/缺 case 均被拒。
- **示例路径**：使用 provisioner 输出的真实 `contextPath`/`envPath`（本机 `os.tmpdir()` 不在 `/tmp`）。

---

## 10. R3 修订（P3-CLOSE-B-R1；AUD-040 入口拆分与逐文件枚举）

**入口矩阵（拆分后）**

| 入口 | 命令 | 配置来源 | 文件集（逐文件枚举） | 缺 `TEST_*` 行为 |
|---|---|---|---|---|
| unit（离线） | `npm run test:unit`（含 `--coverage`） | `jest.unit.config.cjs`（`setupFiles` **仅** `tests/setup-env.js`） | `tests/*.test.js` 中 **28** 个非 DB 文件（`tests/runners/entry-sets.cjs` 显式清单） | **rc=0**（本入口不连库；audit 守护零 DB 指示符） |
| db（门禁） | `npm run test:db` | `jest.db.config.cjs`（挂 `db-isolation-setup.cjs`） | 显式清单：`tests/p0ProvNoAdminInSchool.test.js`（当前 1 文件） | **非零拒绝、0 用例、0 skip**：`MISSING_TEST_URL` / `MISSING_CONTEXT` |
| root 全量 | `npx jest --config jest.config.cjs` | `jest.config.cjs`（门禁保留） | unit ∪ db = **29** | 同上（每个 suite 在 setup 即失败） |
| `npm test` | `npm run test:db && npm run test:unit` | 同上 | 29（串行） | DB 面**先**拒绝（fail-closed 且**零连接尝试**，T02B-R2 `npm_test` 观测契约），unit 不启动 |
| integration | `npm run test:integration` | `tests/integration/jest.integration.config.cjs` | **2** 文件 | 非零拒绝、0 用例 |
| isolation | `npm run test:isolation` | `tests/isolation/jest.isolation.config.cjs` | **4** 文件 | 不适用（不连库；被验证对象正是其它入口的拒绝行为） |
| backend | `npm run test:backend` | `tests/runners/run-backend-tests.mjs`（**递归**枚举任意深度） | `backend/tests/**/*.test.mjs`（当前 **40**，含一层/顶层/多层） | 各 DB suite 在 `_isolation.mjs` 桥接处 `assert.fail` → 文件 rc≠0、整体非零、**0 skip** |
| frontend | `npm run test:frontend` | `jest.frontend.config.cjs`（`passWithNoTests:false`） | `tests/frontend/**/*.test.js`（**当前无套件**） | fail-closed：`No tests found` → **rc≠0**（不再假命中 integration） |

**逐文件枚举（防 shell `**` 漏跑）**：所有 testMatch 均为**逐文件绝对化路径**（`<rootDir>/...`），`test:backend` 由 Node 递归枚举后把文件路径直接交给 `node --test`；
旧脚本 `node --test … backend/tests/**/*.test.mjs` 的 `**` 由 shell 展开（`sh`/`dash` 下 `**` ≡ `*`，仅一层）→ 顶层 `backend/tests/x.test.mjs` 与两层嵌套会**静默漏跑**。审计入口
`npm run test:entry-audit`（`tests/runners/audit-entry-coverage.mjs`）逐项核对（**23 项**，P3-CLOSE-B-R2 时点）：声明清单 == 独立**递归**枚举（root/integration/isolation/backend）、unit ∪ db == root 面、
unit 面零 DB 指示符、db 面每个文件 ≥1 指示符、配置 testMatch == 清单、integration/isolation 配置 glob 覆盖声明清单、unit 配置不得挂门禁 setup、
脚本指向正确、backend 漏跑差集量化、**全仓 `*.test.*` 产物必须被某入口覆盖或显式登记为 known-non-entry（附理由）**、本轮新增测试必须出现在递归清单；任一不符 → rc≠0 失败。

**「离线可跑」与「必绿」的区别**：unit 入口的保证是**不依赖 PG/`TEST_*`**（可离线执行、不 skip、fail-closed 明确）；其**是否全绿**取决于被测产品与各包的测试替身合同
（例：P3-CLOSE-B-R2 时点，链尾 `public.revoked_tokens` 形状探测使两个使用 Prisma 替身的既有 unit 套件按设计 503 —— 属归属包的接口合同问题，非入口问题，见该包 `BLOCKERS.md`）。

**保持的契约**：`DATABASE_URL`/业务 `.env` **永不**构成授权（仅 `DATABASE_URL` → `MISSING_TEST_URL`）；拒绝发生在连接之前（观测器实测连接尝试=0）；
DB 面缺配置是 **fail-closed 拒绝**，绝不 skip、不降级；`passWithNoTests:false` 防止空跑伪装通过。
