# 开放接口 F1–F8 独立复核 + HTTP 链路补测（2026-09-17）

> 本轮性质：**独立复核对**（不以"已有测试通过"当结论）+ 真实 HTTP 层补测 + 过度确定表述修正。
> **未执行**：生产数据写入、生产授权/密钥变更、生产构建/重启/迁移、Git 提交/推送/配置修改、向第三方发送消息。
> 隔离环境：独立数据库 `foodsentinel_review_test` + 独立 schema `school_reviewtest`（本地临时库，非生产）。

---

## 一、现场取证（事实，非交接转述）

| 项 | 实测 |
|---|---|
| 分支 / HEAD | `Product_tencent_CVM` / `c5489e1` |
| 工作区 | 干净（本轮开始时唯一未跟踪 = 交接文档 `PENDING_TASKS_HANDOFF_20260917.md`） |
| 提交存在性与祖先关系 | `d090b77`、`a877901`、`d87d445`、`c5489e1` 均存在且均为 HEAD 祖先 |
| 远端真实指针 | `d87d445`（因此 `c5489e1` **确实未推送**，与交接一致） |
| 生产版本 | 服务启动 2026-09-17 12:41:02；**独立核验方式** = 后端文件 mtime 早于启动 + 部署文件与 `d87d445` 逐字节一致 → 运行中的后端 = `d87d445` 的后端部分。**"据交接记录已上线"已由本地证据支持**，但未通过接口指纹做在线比对（无生产凭证，且本轮禁止） |
| 文档存在性 | 交接列举的 6 份文档全部存在（无缺失、无需补造历史） |

---

## 二、修正与新增（逐项：触发条件 / file:line / 修改前后 / 复现 / 测试 / 兼容 / 未覆盖风险）

### N1（本轮新发现）· 对账契约表述与实现不符 —— **仅文档修正，不改运行行为**

- **触发条件**：授权**不带**业务日期范围时，按文档"`/test-records` 明细条数应与 `/stats.scope_total` 一致"做对账 → 数量不一致（实测 5 vs 3）。
- **file:line**：`docs/OPEN_API_INTEGRATION.md`（对账建议段）；实现依据 `backend/routes/openApiRoutes.js` 的 `dateClause()`（日期过滤只来自**授权范围**，该端点不接受业务日期参数；`until` 过滤的是 `updated_at`）。
- **修改前**：宣称"同一日期范围下明细条数与 `scope_total` 应一致"（在无授权日期范围时为**错误断言**）。
- **修改后**：分三种情形给出**可对账恒等式** —— ① 授权带范围：`manifest.total == scope_total`；② 无授权范围：`manifest.total == scope_total + excluded_total`；③ 请求/授权范围差异由 `request_out_of_range_total` 解释。
- **复现方式**：`REVIEW_TEST_DATABASE_URL=… node --test tests/http/` 的第 4 项（HTTP 层：records 5 条、manifest 5 条、scope_total 3 条、excluded_total 2 条，恒等式成立）。
- **测试结果**：HTTP 套件 8/8 通过（含该恒等式）。
- **兼容影响**：无（文档措辞）。
- **未覆盖风险**：无（属表述纠正）。

### N2（本轮加固）· 测试隔离：把 `DATABASE_URL` 重定向内置到门禁

- **触发条件**：运行器从 `backend/.env` 注入生产 `DATABASE_URL`；若某个用例忘记自行覆盖，`lib/tenantClient.js` 的 `baseDatabaseUrl()` 会连上生产库。
- **file:line**：`backend/tests/_isolation.mjs`（`assertIsolationConfig` 内新增重定向逻辑）。
- **修改前**：仅"解析连接串校验库名/schema + 写前断言 `current_database()`"；重定向靠各用例自觉（上一轮 stats 用例手动做）。
- **修改后**：门禁**统一**把 `process.env.DATABASE_URL` 指向隔离库，并打印重定向日志（本机实测输出：`[isolation] 已将 DATABASE_URL 由 "foodsentinel" 重定向为隔离库 "foodsentinel_review_test"`）。
- **复现方式**：运行任一 DB/HTTP 套件，观察隔离日志；负例见 `tests/records/isolation-gate.test.mjs`（5 项：用户名/密码/query 含 `review_test` 不算数、真实 schema 拒绝、未配置即 SKIP、无范围清理拒绝）。
- **测试结果**：隔离门禁负例 5/5；HTTP 套件运行日志确认重定向生效。
- **兼容影响**：仅测试基础设施。
- **未覆盖风险**：`process.env.DATABASE_URL` 被重定向后，**同一进程内**若还有其他库连接需求（例如同时连生产做对比）会被一并改写 —— 当前无此类用例。

### N3（本轮修正）· TPM 单位过度确定表述 —— **含运行行为变化（响应新增字段）**

- **触发条件**：对接方按字典 `unit=g/100g（数值等价于 %）` 与"勿再 ×100"推断设备单位并做换算。
- **file:line**：`backend/lib/openApiFieldSchema.js`（`result.tpmValue` 描述符）、`backend/routes/openApiRoutes.js`（`field_schema_notes`）。
- **修改前**：断言式表述 —— "`0.06` 表示 0.06 g/100g（即 0.06%），请勿再 ×100"。
- **修改后**：`unit` 语义保留为**平台标注**（`g/100g（平台标注，未经设备协议核实）`），**新增** `unit_source:'platform_label'`、`unit_verified:false`；描述与 notes 改为"平台按原始录入值保存；单位与阈值属当前实现口径、**未经设备协议核实**；请勿自行换算或据该字段重判历史结论"。
- **复现方式**：`node --test tests/openapi/contract.test.mjs`（字段字典断言）+ `curl /api/open/v1/dict` 观察新字段（需凭证；本机用 HTTP 测试内的真实 key 已验证）。
- **测试结果**：契约套件通过；HTTP 套件第 3 项验证 dict 可达且含枚举/复检结构。
- **兼容影响**：**追加字段**（`unit_source`/`unit_verified`），旧字段语义未变；表述由"确定"降级为"待核实"——可能被对接方视为契约收紧（正向）。
- **未覆盖风险**：设备协议未取得前，`unit_verified` 无法转 `true`；历史数据不做换算（已写入 TPM 清单 §3）。

### N4（本轮新增）· 真实 HTTP 链路测试（`backend/tests/http/openapi-http.integration.test.mjs`，8 项）

- **装配**：真实 `express` + 真实 `createOpenApiRoutes({ prisma })`（内含真实 API-Key 中间件）+ 真实租户客户端；服务仅监听 `127.0.0.1` 随机端口。
- **与生产装配的差异（不得视为完全等价）**：未加载 `server.js` 的静态资源、上传、定时任务、钉钉等外部副作用；**未挂载内部 JWT 路由**。
- **覆盖**：① 无/错密钥 401（`MISSING_KEY`/`INVALID_KEY`）与正确密钥 200；② 未授权学校 403、未授权类型 403；③ 字典含枚举与复检结构；④ records↔manifest↔stats 恒等式与指纹同源；⑤ 日期参数边界（非法 400、日历不存在 400、`start>end` 400、闭区间边界、交集空 → 200 且 `pass_rate=null`）；⑥ 注入记录只影响对应桶、清理后回基线；⑦ 样例 `fail` 场景确实 `fail`、`synthetic=true`、`SAMPLE-` 前缀；⑧ 复检结构下发且复检人姓名被剔除、最终结论来自复检。
- **测试结果**：**8/8 通过**。

### N5（本轮复核确认，无改动）· `db-readonly-checks.mjs` 已在上一轮改为同源谓词

- 生产**只读**实测 12/12（分页 1063/1063、无重复、严格单调；`scope_total 1062 + excluded 1 = 1063`；`pass_count ≤ scope_total`）。

---

## 三、F1–F8 独立复核结论

| 项 | 独立复核判定 | 复核依据（本轮实测） | 缺口 |
|---|---|---|---|
| F1 局部更新/扁平 | ✅ 通过 | DB 集成 12 项（context-only 不清空、扁平生效、`{}`/null 不改动、非法 400、兄弟字段保留、replace vs merge） | 未做生产写入实测（授权边界） |
| F2 legacy PUT 版本 | ✅ 通过 | DB 集成 Test J-2（双写者：1×200 且 v+1、1×409） | — |
| F3 同步客户端原子性 | ✅ 通过 | 纯函数 5 项（中途新增/中途失败/tail 失败/重试耗尽/异常语义）+ mock 端到端（7 场景 + 失败语义，退出码 0） | 未用真实第三方客户端验证 |
| F4 统计授权边界 | ✅ 通过 | DB 集成 Test F（注入 999 条授权外记录 → 返回值逐字段不变）+ HTTP 第 6 项（桶变化可解释、清理回基线） | 生产侧只做了只读对账（未做授权变更实验） |
| F5 日期集合/日历 | ✅ 通过 | DB 集成（互斥桶、恒等式、`2026-02-30/13-01/00-10` 不入分母、不 500、投影 `test_date=null`）+ HTTP 第 5 项 | — |
| F6 投影指纹 | ⚠️ **部分通过** | 契约测试（配置指纹影响指纹；记录行不变仅投影变化 → digest 变化）+ 参考客户端场景 4/5/7 | **缺"父版本→当前版本"端到端升级测试**（用父提交代码生成的 digest 与当前比对）；见 §五 |
| F7 复检结构 | ✅ 通过 | 契约测试（三类登记 + 白名单允许 + PII 剔除）+ HTTP 第 8 项（真实响应含复检、无姓名） | — |
| F8 测试隔离 | ✅ 通过（并加固） | 隔离门禁负例 5 项 + 本轮 N2 统一重定向 + `cleanupScoped` 空 where 抛错 + 移除 `deleteMany({})` + 去掉写死路径 | schema 名仍为固定 `school_reviewtest`（未做到"每轮一次性数据库"） |
| F9 指标口径 | ⏳ 设计草案 | 契约声明已在线上（`metric_basis`）；本轮产出 `F9_DUAL_METRIC_CONTRACT_DRAFT_20260917.md` | 需业务确认（§六） |

---

## 四、测试分层结果（不重复相加）+ 跳过原因

| 层次 | 数量 | 结果 | 跳过原因 |
|---|---|---|---|
| 纯函数/契约（无库） | 95 | 92 pass / 0 fail | **3 skip**：均为"未设置 `REVIEW_TEST_DATABASE_URL`"的 DB 门控文件（配置后不 skip） |
| 隔离库集成（未过 HTTP） | 35 | 35 pass / 0 fail | — |
| **HTTP 链路集成（本轮新增）** | 8 | 8 pass / 0 fail | 未配置隔离库时整体 skip |
| 生产只读行为核验（脚本，非 test runner） | 12 | 12 pass | — |

**关键反例（非"全绿"替代）**：context-only 不清空、扁平业务字段生效、双写者版本冲突、tail 失败不推进 checkpoint、重试耗尽不误报完成、授权外记录数不影响返回值、日历不存在不入分母且不 500、未识别 oil 等级不自动合格、复检证据下发且无姓名、对账恒等式。

---

## 五、仍未覆盖的风险（如实列出）

1. **F6 缺端到端升级测试**：未用父提交（`d090b77`）代码生成一份 digest 与当前实现比对（需要两套代码并行运行数据库查询；本轮时间/篇幅未做）。
2. **内部路由（`/api/records`、`/api/sync`）无 HTTP 层测试**：需内部 JWT 登录链路（`POST /api/user/login` + bcrypt 测试用户 + 角色/学校绑定 + `loginRateLimit`）。为避免**伪造 `req.user`** 冒充 HTTP 层，本轮未纳入；这些路由的行为由"真实 handler + 真实 DB"集成测试覆盖 —— **层次不同，不可互相替代**。
3. 未做生产写入实测、未做 App 实机、未用真实第三方客户端、未做授权变更实验（受授权边界限制）。
4. 测试装配不加载定时任务/上传/钉钉等副作用 → 与生产装配不等价（已声明）。
5. 隔离 schema 仍为固定名（未做到"每轮一次性库"）。

---

## 六、需要业务拍板的最少问题

1. **F9**：是否需要"最终结论口径"（若需要，按 `F9_DUAL_METRIC_CONTRACT_DRAFT_20260917.md` 的 5 个确认项回答）。
2. **TPM**：提供设备协议/计量证明/阈值出处（清单见 `TPM_UNIT_VERIFICATION_CHECKLIST_20260917.md`）。
3. **App**：按 `APP_PROTOCOL_CHECKLIST_20260917.md` 回答 9 项（尤其"是否携带版本号""409 后是否保留本地编辑"）。
4. **第三方**：是否按 `THIRD_PARTY_RESYNC_ACCEPTANCE_20260917.md` 与对方做一次正式验收（含知会"首拉会全量重投影"）。

---

## 八、第二轮复核对（回应审阅反馈）—— ⚠️ **本节结论已被 §九 修正，请以 §九 为准**

> **§九 修正摘要（2026-09-23）**：本节把两个问题判为"待查缺陷"是**误判** —— 根因均为**测试装配缺陷**，产品代码无缺陷：
> ① `req.userId`：`server.js:131-141` 的 `authenticateUser` 包装本就会补 `req.userId`/`req.userRole` 并挂 `attachTenant`，我的测试装配漏挂 → 补上后 W1–W4 全部通过；
> ② 跨校 500：隔离库不存在 `school_tjb` schema → P2021（**测试环境产物**）；`UserManager` 的 `rootPrisma` 默认为传入实例（**"未传参数"的猜测错误**）。
> 本节 8.3 的"对账矩阵未做"已由 §九 完成；8.3 的"生产只读 12/12 时间归属""F6 升级模拟""TPM 接入包呈现"见 §九 的完成/未完成标注。

## 八（原始记录，保留）· 第二轮复核对 —— 状态：部分完成，如实列出

### 8.1 已补：内部写入链路的**真实登录 + HTTP** 测试（新增 `tests/http/internal-write-http.integration.test.mjs`）

真实装配：`express` + 真实 `UserManager(prisma, JWT_SECRET)` + 真实 `createAuthMiddleware` + 真实 `createUserRoutes` / `createRecordRoutes` / `createSyncRoutes`，**通过真实 `POST /api/user/login` 取得令牌**（未伪造 `req.user`）。服务仅监听 `127.0.0.1` 随机端口。

**已通过的 HTTP 断言**：
- 真实登录：正确口令 200 并下发令牌；错误口令 401；
- 跨学校登录（用户属 `reviewtest`，以 `schoolCode=tjb` 登录）**被拒**且不下发令牌 —— ⚠️ 但实际返回 **500**（期望 401），见 8.2 缺陷 #2；
- 无令牌写入 401；`viewer` 角色写入 403；
- 带 `record_code` 的重复创建按**幂等**处理（不重复建记录）✓

**受阻（未通过）的 5 项写入场景** —— 触发条件与根因已定位：

| # | 场景 | 现状 | 根因（file:line） |
|---|---|---|---|
| W1 | 只改食堂 → 结果+复检数组保留 | ❌ 500 | `POST /api/records/:tableName` 创建即失败：`Argument 'created_user' is missing` |
| W2 | 扁平更新真正保存 | ❌ 依赖 W1 的固定装置 | 同上 |
| W3 | 同版本两次更新仅一次成功 | ❌ 同上 | 同上 |
| W4 | 批量部分失败与重试 | ❌ 同上 | 同上 |
| W5 | 只读角色/跨校拒绝 | ✅ 已在 8.1 通过 | — |

**根因证据**：`backend/routes/recordRoutes.js` 的 legacy 创建路径使用 `req.userId`，而 `backend/middleware/authMiddleware.js:437` 仅设置 `req.user = u`（未设置 `req.userId`）→ Prisma 创建调用缺 `created_by` → `PrismaClientValidationError: Argument 'created_user' is missing` → 500。
**待确认**：生产是否存在兼容中间件补设 `req.userId`（本轮**未验证生产**）；若无，则 `POST /api/records/:tableName` 在**生产上也是 500**（待查缺陷 #1）。

### 8.2 本轮新发现的两个待查缺陷（**不擅自修，因涉及内部鉴权语义**）

1. **legacy 创建路径缺 `req.userId`**（见 8.1 根因）：影响 `POST /api/records/:tableName`（及任何依赖 `req.userId` 的分支）。**需确认生产是否受影响**后再决定修法（补 `req.userId = req.user.userId` 兼容层，或改用 `req.user.userId`）。
2. **跨校登录返回 500（期望 401）**：`UserManager.logFailedLogin(null, ...)` 走 `writeSystemLog(this.rootPrisma, …)`；`server.js:94` 以 `new UserManager(prisma, JWT_SECRET)` 构造，**未显式传 rootPrisma** → 嫌疑点。已记入测试注释（暂断言"必须被拒（≥400）且不下发令牌"，待根因确认后收紧为严格 401）。

### 8.3 未完成（明确列出，不含糊）

| 项 | 状态 | 说明 |
|---|---|---|
| 对账公式的**四种授权/请求日期组合**矩阵验证 | ❌ 未做 | 现有覆盖：无授权范围（HTTP 第 4 项：`manifest.total = scope_total + excluded_total`）与"授权带范围"（DB 集成 #13）。**缺**：无授权+有请求、有授权+有请求 两格的固定数据验证与文档表 |
| F6 **父版本→当前版本**升级模拟（不启动两套服务） | ❌ 未做 | 方案已明确：`git show d090b77:backend/lib/openApiScope.js` 取出旧实现 → 与当前实现对**同一份合成数据**计算 `projection_fingerprint`/`digest` → 用参考客户端模拟"旧状态 → 接入新代码 → 重拉 → 旧字段清除 → 失败不提交" |
| TPM `unit_verified` 在**生成的接入包**中的呈现 | ❌ 未验证 | 接入包表格目前渲染 路径/中文名/类型/单位/必现/可空/下发/说明，**未包含** `unit_verified`；需在生成器补渲染并在 package-contract 测试中断言 |
| 生产版本证据严格化 | ⚠️ 部分 | 现有证据＝文件 mtime + 磁盘文件与 `d87d445` 一致；**缺**进程入口/工作目录/服务配置（`ExecStart`/`WorkingDirectory`）核对 |
| 生产只读核验的时间归属 | ⚠️ 需澄清 | §五的"生产只读 12/12"是**本轮之前的同一日早先执行**（目标=生产库只读，脚本 `/tmp/…` 已删除），本轮**未重跑**；原文未标明归属，属**报告可追溯性缺陷**，特此更正 |

### 8.4 发布判断（修正后）

**不建议现在发布。** 理由：① 待查缺陷 #1（可能影响生产写入路径）；② 待查缺陷 #2（跨校登录 500）；③ 对账矩阵与 F6 升级模拟两项验收证据缺失；④ TPM 核实状态尚未贯穿接入包。 
待 8.3 完成后重新判定；本轮**未提交、未推送、未发布、未重启、未动生产**。

---

## 七、发布影响（本轮不执行）

| 项 | 结论 |
|---|---|
| 是否改运行行为 | **是**（N3：响应新增 `unit_source`/`unit_verified` + notes 文案；N2/N4 仅测试） |
| 前端产物 | 本轮未改前端文件 → **无需重建 dist** |
| 后端 | 需 `systemctl restart foodsentinel-api`（加载新字典字段与 notes） |
| 数据库迁移 | **无**（无 schema 变更） |
| 是否仍存在发布阻断项 | **无 F 类阻断项**；F6 的端到端升级测试与内部 HTTP 层属"证据缺口"，不构成阻断 |

---

## 九、第三轮（2026-09-23）：根因定论、内部写入 HTTP 层、对账矩阵、生产证据

### 9.1 两个"待查缺陷"的**根因定论：均为测试装配缺陷，产品代码无缺陷**（撤回 §八 的缺陷定性）

| 编号 | 现象 | 根因（file:line） | 定性 | 处理 |
|---|---|---|---|---|
| R1 | `POST /api/records/:tableName` 500：`Argument 'created_user' is missing` | `backend/server.js:131-141` 的 `authenticateUser` 包装会补 `req.userId = req.user.userId` / `req.userRole` 并挂 `attachTenant`（注入 `req.db`）；**我的 HTTP 测试装配漏挂了这一层** | **测试装配缺陷**（非产品缺陷） | 测试按生产装配复刻该包装 → W1–W4 全部通过 |
| R2 | 跨校登录返回 500（期望 401） | 隔离库不存在 `school_tjb` schema → tenant 客户端 `findUnique` 报 `P2021`（表不存在）→ 500。**这是隔离环境产物**；`UserManager` 构造函数 `constructor(prismaClient, jwtSecret){ this.rootPrisma = prismaClient }` 表明 **rootPrisma 默认即有值**（§八 的"未传参数"猜测**错误，已撤回**） | **测试环境产物**（非产品缺陷） | 改用"schema 内 `school_code` 与所属 schema 不一致"的用户精确构造不匹配场景 → 断言 **401**，且与"账号不存在"**响应体逐字节相同**（防枚举） |

### 9.2 内部写入链路：**真实登录 + HTTP**（新增 `tests/http/internal-write-http.integration.test.mjs`，6/6 通过）

装配（与生产一致的部分）：`express` + `UserManager(prisma, JWT_SECRET)` + `createAuthMiddleware` + **复刻 `server.js:132-141` 的 `authenticateUser`（补 `req.userId`/`req.userRole` + `attachTenant` 注入 `req.db`）** + `createUserRoutes` / `createRecordRoutes` / `createSyncRoutes`；令牌来自**真实 `POST /api/user/login`**（未伪造 `req.user`）。路由挂载修正：`recordRoutes` 内部路径自带 `/api/records`，必须挂**根**。

| 断言 | 结果 |
|---|---|
| 真实登录（正确 200 / 错误口令 401） | ✅ |
| 无令牌写入 401；`viewer` 写入 403 | ✅ |
| 学校不匹配 → 401，且与"账号不存在"响应体完全相同（防枚举） | ✅ |
| **W1** 只改食堂 → 原测量值 / 兄弟字段 / **复检数组**保留 | ✅ |
| **W1b** 创建成功同时断言：记录存在 **+ `created_by` = 认证身份** + `record_code` 形态 | ✅ |
| **W2** 扁平业务字段更新真正落库（非"成功但无变更"） | ✅ |
| **W3** 同版本两次更新：1×200（v→v+1）+ 1×409 `VERSION_CONFLICT`，冲突不写入 | ✅ |
| **W4** 批量部分失败逐项可对应（`results[].syncId` / `errors[].syncId`）+ 重试幂等（按 `created_by` 计数不增） | ✅ |
| **W5** `record_code` 重复创建按幂等处理（仅一条） | ✅ |

### 9.3 对账四组合矩阵（新增于开放接口 HTTP 套件，含未授权记录隔离）

固定数据：3 条合法日期（03-01 / 03-02 / 03-10）+ 1 条日历不存在（02-30）+ 1 条缺日期。

| 组合 | 授权范围 | 请求范围 | 实测（records / manifest / scope / excluded / oor / universe） | 对账关系 |
|---|---|---|---|---|
| ① | 无 | 无 | 5 / 5 / 3 / 2 / 0 / 5 | `manifest = scope + excluded` |
| ② | 无 | 03-01..03-02 | 5 / 5 / 2 / 2 / 1 / 5 | `manifest = scope + oor + excluded` |
| ③ | 03-01..03-05 | 无 | 2 / 2 / 2 / 0 / 0 / 2 | `manifest = scope`（授权过滤后脏日期不可归属） |
| ④ | 03-01..03-05 | 03-02 当天 | 2 / 2 / 1 / 0 / 1 / 2 | `manifest = scope + oor` |

另：注入 20 条**授权范围外**记录 → 六个字段逐项不变；清理后回到基线（无数量侧信道）。**未通过修改断言迎合实现**：组合①的"明细含脏日期"是**产品契约**（明细供排查），已在 `docs/OPEN_API_INTEGRATION.md` 写明。

### 9.4 生产版本证据（补强，非充分证明）

```
MainPID              = 3385979
ExecStart            = /usr/local/bin/node server.js
WorkingDirectory     = /opt/foodsentinel/backend
ActiveEnterTimestamp = Thu 2026-09-17 12:41:02 CST
```
结合"五层同类文件 mtime 早于启动"与"工作区 clean ⇒ 磁盘文件 == `d87d445`"⇒ 运行版本 = `d87d445` 后端部分的**支持度提高**；仍**未做**接口级指纹在线比对（无生产凭证/受授权限制），故不称"已充分证明"。

### 9.5 本轮未完成（**不标"部分完成"**）

| 项 | 状态 |
|---|---|
| F6「父提交 → 当前实现」升级模拟（旧指纹/摘要 → 新代码触发重拉 → 整条替换 → 旧字段清除 → 中途失败不提交摘要） | **未完成** |
| TPM `unit_source`/`unit_verified` 在**生成的接入包**中的呈现 + package-contract 断言 | **未完成** |

### 9.6 本轮测试数量（分层，不重复相加）

| 层次 | 结果 |
|---|---|
| 纯函数/契约 | 95 项：**92 pass / 0 fail / 3 skip**（skip＝未设置隔离库变量） |
| 隔离库集成 | **35/35**（12 + 10 + 13） |
| HTTP 链路（顺序执行两个文件） | **15/15**（开放接口 9 + 内部写入 6） |
| 未执行 | F6 升级模拟、TPM 接入包断言（见 9.5） |

> 数量对应关系说明（回应"14 项 / 10 通过 / 5 项受阻"）：那是**两个文件并发**跑的合并计数——9（开放接口）+ 6（内部写入）= 15，其中内部文件整体还被计为 1 个文件级结果，故显示 14；5 项受阻 = 4 个写入场景 + 1 个跨校断言。现改为**顺序执行**并按文件分别计数，即 **9 + 6 = 15，全绿**。

### 9.7 操作事故披露（必须记录）

为复现 R2，我写过一次性脚本 `/tmp/repro-login-crossschool.mjs`，该脚本**未接隔离门禁**，导致 `lib/tenantClient.baseDatabaseUrl()` 取到 `process.env.DATABASE_URL` 指向生产库：
- 影响 1：对生产 `school_tjb` 做了一次 `SELECT`（未命中、无数据读取外泄）；
- 影响 2：失败登录路径调用 `writeSystemLog(rootPrisma, …)`，在**生产 `public.SystemLog` 写入 1 条 `warn` 级记录**（内容＝用户名 `u-repro-cross` + 时间戳，不含密钥或个人数据）。
- 处置：脚本已删除；该写入**未回滚**（不擅自动生产数据），在此如实披露。后续所有一次性脚本一律先经 `tests/_isolation.mjs` 门禁。

### 9.8 发布判断（本轮结束后）

**仍不建议发布**：证据缺口从"装配不明"收敛为**两项明确未完成**（9.5）。R1/R2 已证明为测试问题，故**产品侧无阻断缺陷**；建议先补 9.5 两项再评估发布。

---

## 十、第四轮（2026-09-23 续）：补完 9.5 的两项缺口

### 10.1 F6 升级模拟（新增 `backend/tests/openapi/f6-upgrade.test.mjs`，**3/3 通过**）

**基线（用父提交 `d090b77` 的算法逐字复刻算出，非猜测）**：

```
旧指纹 fpOld = d908c58ac61dc862      ← 与审阅方在 F6 中给出的旧指纹**完全一致**（强互证）
新指纹 fpNew = 9806455dc4aeb118      （含投影修订号 PROJECTION_REVISION + 学校配置指纹）
旧/新 digest = 7d6071887687… → a02786f302e2…（同一份 rows + scope_version）
旧实现行为（git show d090b77 核对）：pickTestDate 仅 `match(/^(\d{4}-\d{2}-\d{2})/)` 截取；
  deriveConclusion(oil) = `color.includes('不合格') ? FAIL : PASS`（fail-open）
```

**升级链验证（不止比较指纹）**：伪造"已同步的老客户端"本地状态（`digest=fpOld 对应值`、本地 doc 为**旧投影输出**：`test_date='2026-02-30'`、`initial_conclusion='pass'`）→ 接入当前实现跑**真实 `syncSchool`**：

| 断言 | 结果 |
|---|---|
| 必须察觉变化（不得因旧 digest 相等而跳过） | ✅ committed=true |
| 重拉后**整条替换**：`test_date` 由 `'2026-02-30'` → **`null`**（日历校验生效） | ✅ |
| 旧结论被清除：`initial_conclusion` 由 `'pass'` → **`'unknown'`**（oil 未识别等级不再默认合格） | ✅ |
| 提交**新**摘要（`digestCurrent`）与新指纹 | ✅ |
| 注入中途失败（第 1 页 504 / tail 500）：本地数据与完成摘要**都不推进**，旧值仍在（无半更新） | ✅ |
| 失败后再次同步仍能完成升级（证明只是未提交，非脏状态） | ✅ |

### 10.2 TPM 核实状态贯穿接入包（`backend/routes/adminOpenApiRoutes.js`）

- 字段表「单位」列：`unit_verified === false` 的字段追加 **`⚠️未核实`**（如 `result.tpmValue` → `g/100g（平台标注，未经设备协议核实） **⚠️未核实**`）；
- 「读表须知」新增一条：说明 `unit_source=platform_label` / `unit_verified=false` 的含义，并明确**请勿自行换算（×100/÷100）、勿据此重判历史结论**；
- 新增 `package-contract` 断言（4 条）：该行必须含「未核实」、须知必须含「平台标注」与「请勿自行换算」、且**不得再出现"等价于 %"式断言**。
- **运行行为变化**：仅**接入包生成文本**（管理员下载物）；接口响应字段未变（`unit_source`/`unit_verified` 是 09-17 的改动）。

### 10.3 最新分层数字（本轮末次运行）

| 层次 | 结果 |
|---|---|
| 纯函数/契约（含 F6 3 项 + TPM 4 项断言） | **99 项：96 pass / 0 fail / 3 skip**（skip＝未设置隔离库变量） |
| 隔离库集成 | **35/35**（12 + 10 + 13） |
| HTTP 链路（顺序） | **15/15**（开放接口 9 + 内部写入 6） |

**剩余缺口**：① 生产**接口级在线比对**（受"不得使用生产凭证/不得在线核验"限制，仅有进程元数据 + 文件一致性证据）；② App 实机与真实第三方同步（外部依赖，需对方配合）；③ 数据侧：隔离库与生产的数据分布不同，个别断言依赖自建固定数据。

### 10.4 发布判断（第四次更新）

**产品侧无已知阻断缺陷**；本轮改动 = **测试**（不改变运行行为）+ **接入包生成器文案**（运行行为变化仅限管理员下载的接入包文本）。
发布影响：需 `systemctl restart foodsentinel-api`（加载新的字典 notes/接入包文案）；**前端未改，无需重建 dist；无迁移**。
仍建议：**发布前明确 10.3 的三项剩余缺口的处理方式**（接受为后续验收 / 或由对方配合补齐），其余无阻塞。
