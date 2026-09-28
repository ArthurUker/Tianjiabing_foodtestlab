# R6 深入复证 · 第 2 轮报告（2026-09-28）

> 计划依据：`R6_DEEP_VERIFICATION_PLAN.md` §阶段 3（SRV-101/102/103/104/105 与 SRV-124–136 逐条复核）与 §阶段 5（独立复核视角）
> 执行时间：**16:59–17:0x CST**｜**未修产品代码、未改数据库、未启停服务、未做任何线上探针写入**
> 历史证据不继承：首轮与本轮结论均重新回读源码得出。

## 0. 约束与证据级别（先说清"这轮为什么没动线上"）

- 开始前探测到**另一窗口正在编辑同一生产工作区**：`git status` 出现 `M frontend/pages/login.html`，且 `.git/FETCH_HEAD` mtime = **16:59:58**。
- 按计划"开始前确认是否有其他窗口正在编辑或部署同一生产工作区；如有，停止克隆以外的线上探针并报告"→ 本轮**全部为静态源码回读 + 不接触数据库的函数级替身验证**，未启动任何隔离服务、未创建克隆库、未对生产发起任何探针。
- 生产状态仅做**最小只读确认**（用于声明本报告时效）：`/api/readyz` **HTTP 200**、`status:"ready"`、`blockedSchools:[]`、`globalBlockers:[]`；服务 `MainPID=1673914`、`NRestarts=0`、启动 16:45:51。远端 = 本地 `e4b265e`（无新提交、无新计划文件）。
- 证据级别：**静态**（源码回读）与**替身测试**（纯函数，无 DB、无网络）。**无**隔离 PG、**无**生产受控写。

## 1. SRV-101–105 复核

| ID | 结论 | 本轮证据 | 证据级别 | 建议定级 |
| --- | --- | --- | --- | --- |
| **SRV-101** | **属实（已获函数级铁证）** | ① `resolveWritableStatus({requested: undefined, role:'operator', currentStatus:'archived'})` → `{"ok":true}`（**无 `status` 键**），故 `recordRoutes.js:766` 的展开不覆盖；② `buildRecordWriteData('oil', <body 无 status>, {existingSampleInfo:{}, existingResultData:{}})` → **`data.status = "completed"`**；③ 对照：显式 `status:'failed'` → `"failed"`（说明默认值只在未提交时泄漏）；④ `create` 分支同样为 `"completed"`（该分支属预期语义） | **替身测试（函数级，无需 DB）** | **P2 维持**（archived 记录被"复活"、failed 被伪装完成） |
| SRV-102 | 维持（本轮无新增证据） | `syncRoutes.js:117-150` 的 update 分支只校验存在性与 `canModifyRecord`，**无 `existingUpdate.test_type !== store` 判定**；REST 路径 `recordRoutes.js:731-733` 有该判定 | 静态（本人回读） | P2 维持 |
| SRV-103 | 维持（本轮无新增证据） | `recordRoutes.js:779-791` 自愈块以 `writeData.result_data`（merge 模式下含库内旧 `recheckRecords`）为准双向改写 `result`；触发前提=merge 模式 + 库内已有复检结论 + 本次未提交 `recheckRecords` | 静态（本人回读）；**最小反例 NOT_RUN**（需 Express 栈） | P2 维持 |
| SRV-104 | 维持 | `recordNormalize.js:380-386` 的 `catch` 仅 `console.error`，且调用点均在业务写提交之后 | 静态（本人回读） | P2 维持 |
| SRV-105 | 维持 | `syncRoutes.js` 全文对 `audit|AuditLog|writeTenantAuditLog` **0 命中**；`DELETE /api/sync/queue`（`:361-366`）`deleteMany({status:'archived'})` | 静态（本人回读） | P2 维持 |

> SRV-102/103/104/105 的**最小反例本轮未构造**（均需 Express/租户栈）→ 记为 NOT_RUN，不计为"已复证"。

## 2. SRV-124–136 复核（13 条，逐条回读源码）

| ID | 本轮结论 | 关键位置（回读所得） | 与原推断的差异 | 建议定级 |
| --- | --- | --- | --- | --- |
| SRV-124 | **属实（附触发前提）** | `middleware/openApiAuth.js:80`（`req.originalUrl`）→ `:59`（写入 `context.path`）→ `lib/auditLog.js:186-188`（落 `public."SystemLog"`）；`lib/openApiKeys.js:44-53` 的 Key 提取**只读头部** | 原推断成立；补充：**Key 走 query 属非文档化用法**，故为"潜在泄漏"而非既有泄漏 | P3 维持 |
| SRV-125 | **属实** | `lib/openApiScope.js:335`（`Buffer…base64url`，无 MAC）；`routes/openApiRoutes.js:463,466`（`cur.f &&`、`cur.p &&` 真值短路） | 补充：`s`（school.code）与 `g`（scope_version）**仍强校验** → **不能扩大可见范围**，仅能自造水位/跳页 | P3 维持 |
| SRV-126 | **属实** | `middleware/openApiAuth.js:35`（模块级 `Map`）、`:119-120`（键 = `credential.id`） | 无 | P3 维持 |
| SRV-127 | **属实（分叉面比原推断更大）** | `frontend/js/services/ExportService.js:997`（`colorLevel === '合格'` 才合格）vs `lib/conclusionVerdict.js:31`（`OIL_COLOR_PASS = {合格, 警戒}`）；另 `Dashboard.js:995-1006` 有 `atpPoints` 回退而导出无 → 餐具同样分叉 | **扩大**：不止油品，餐具（顶层 `result` 空 + 点位全合格）也分叉 | **P2 维持** |
| SRV-128 | **属实** | `middleware/idempotencyMiddleware.js:30,32`（全局 `Map` + `MAX_ENTRIES=10000`）、`:182-183`（满则 **429 `IDEMPOTENCY_STORE_FULL`**） | 无；键与值均无字节上限（值为完整响应体） | P2 维持 |
| SRV-129 | **属实** | `lib/tenantProvisioner.js:499-501`（`information_schema.tables` 探台账）、`:517-522`（列/表见证）；纪律出处 `lib/publicInfraShape.js:15-16`，同文件 `tenantProvisioner.js:689` 也声明同纪律 | 修正表述：该纪律是**模块级自述**，非全仓强制门禁 | P3 维持 |
| SRV-130 | **属实但可达性大幅受限** | `scripts/004_backfill_audit_principals.mjs:59,458`（`--schema` 直用）、`:354`（进连接串）；**但 `:453-457` 先用 `$1` 参数化探测，要求该 schema 必须存在且 `AuditLog` 含 `principal_id`/`actor_snapshot` 两列，否则 exit 2** | **下调可达性**：注入面被该前置探测限制为"真实存在的租户 schema 名"，非任意字符串 | **P3**（维持，理由变更） |
| SRV-131 | **属实** | `lib/tenantProvisioner.js:44-47`（`buildTenantPushArgs`）、`:56-59`（`tenantPushAcceptDataLossEnabled`）；全仓检索仅定义处与 `deploy/README.md:229` | 无 | P3 维持 |
| SRV-132 | **属实（影响为潜在）** | `lib/restoreSqlUtils.js:20-21`（两处 `replaceAll`）、`:165-167`（整段含 COPY 数据行）、调用点 `lib/restoreService.js:570` | 补充：**未取到真实数据反例**（是否命中取决于数据文本） | P3 维持 |
| SRV-133 | **属实** | `lib/restoreService.js:230`（`ACL_OBJECT_KINDS = ['r','p','v','m','S']`）、`:248/:261`（`aclexplode`）、`:413-417`（自证只比对显式 ACL 身份集）；全文无 `nspowner/relowner` | 无 | P3 维持 |
| SRV-134 | **部分属实（已下调）** | 属实部分：`lib/restoreService.js:130,140`（drain 依赖 `query ILIKE '%"schema".%'` 文本命中）。下调依据：`:517` 屏障键与消费侧 `lib/tenantWriteBarrier.js:91-97` **主路径同源**（`schoolBackupRoutes` 取 `req.user.schoolCode`），且 `authMiddleware.js:477` 与建校侧 `schoolRoutes.js:232` 已对 `school_code` 做严格校验；**并由 `restoreService.js:520-522` 的全局 `READONLY_MODE` 默认兜底**（`RESTORE_ENGAGE_READONLY_MODE !== 'false'` 时挂载） | **降级**：仅在库中存在历史非规范 `School.code` 时才有"漏挡"空间 | **P3**（由 P3 维持但理由变更为"有兜底"） |
| SRV-135 | **属实（后果比原推断更硬）** | `backend/prisma/seed.js:75-78`（仅 `split/trim/filter`，**无 `isValidSchoolCode`**）→ `:85-87`（无校验 `school.create`）；卡死链路 `lib/tenantSync.js:493-495`（`非法学校代码…无法推导 schema` → `CHECK_ERROR`）→ `:578`（`ok = … && blockedSchools.length === 0`） | 补充：该非法行**无法通过 API 清除**（`schoolRoutes.js:448` 删除前先 `isValidSchoolCode` → 400） | **P2 维持**（可致 `/api/readyz` 永久 503 且需人工 SQL 修复） |
| SRV-136 | **属实** | `lib/tenantProvisioner.js:2062-2067`：`$executeRawUnsafe` 返回受影响行数（number），`Array.isArray(demoted)` 恒 false → 降级日志永不输出（UPDATE 仍执行） | 无 | P3 维持 |

**汇总裁决**：13 条中 **12 条属实 / 1 条部分属实**（SRV-134）；**无一条被证伪**。两处**定级/理由修正**：SRV-130（可达性上限，理由变更）、SRV-134（有全局兜底，理由变更）。

## 3. 状态与证据级别变更（叠加首轮）

| ID | 首轮 | 第 1 轮 | 本轮（第 2 轮） |
| --- | --- | --- | --- |
| SRV-101 | P2（静态） | — | **P2（替身测试：函数级铁证）** |
| SRV-124…133、135、136 | 待验证（P?） | — | **属实 → 定级 P3×10 / P2×2（SRV-127、SRV-135）** |
| SRV-130 | 待验证 | — | 属实但**可达性受限**（P3，理由变更） |
| SRV-134 | 待验证 | — | **部分属实**（drain 属实；屏障部分有 `READONLY_MODE` 兜底 → P3，理由变更） |
| SRV-102/103/104/105 | P2 | — | **维持 P2**（静态已回读；最小反例 NOT_RUN） |

⇒ 至此 **SRV-124–136 全部 13 条不再是"待验证"**，但**证据级别仅为静态/替身**，其中 SRV-127、SRV-135 建议下一轮用隔离栈补最小反例。

## 4. 本轮未执行（NOT_RUN，不得计为通过）

1. SRV-102/103/104/105 的最小反例（需 Express + 租户栈）。
2. SRV-127、SRV-135 的隔离复现（前者需导出链路，后者需在克隆库执行 `seed`）。
3. 第 1 轮遗留：**SRV-111 / SRV-110 / SRV-106 的隔离反例**、**SRV-137 的端到端反例**（第 41+ 唯一索引造重复值 → proof 是否错误通过）。
4. 事故后**仍未重做**的线上缺口：ONLINE_CHECKS 项 4（未认证边界）、项 5（已授权业务读）——本轮因另一窗口活跃而继续 **NOT_RUN**。
5. 发布脚本（`b-release-two-phase.sh` / `deploy/deploy.sh`）沙盒实跑。
6. 第 1 轮观察项：隔离副本对生产 `/opt/foodsentinel/backend/.env` 的 `EACCES` 读尝试，仍未定位代码行。

## 5. 下一轮最小修复顺序（不变，仅补充验收细节）

| 顺序 | 项 | 补充验收条件 |
| --- | --- | --- |
| 1 | SRV-121/122 | 先落"发布脚本前置校验 + 停止条件"，再推"不可变发布目录 + 原子切换"；真实 pending/failed/checksum 不一致仍须 503 |
| 2 | SRV-111 | 合成两校 + 全库备份：A 校管理员响应中不得出现 B 校 schema/表/行数 |
| 3 | SRV-114 | 合成在用校 `xsyn-old-2` 不再进待删清单；真实备份点仍可清理 |
| 4 | SRV-137 + SRV-108 | 第 41+ 唯一索引造重复值 → proof **必须** `ok=false`；截断余量计入 `notProven`；四校 `--baseline-plan` 仍 `proofOk=true` |
| 5 | **SRV-101** | 修复后：`PUT` 未提交 `status` ⇒ **不得**出现 `status='completed'`；`archived` 记录不得被复活（可用本轮函数级用例直接回归） |
| 6 | SRV-127 / SRV-135 | 导出统计与后端同源（警戒=合格）；非法 `SCHOOL_CODES` 项 fail-fast 且不落库 |
| 7 | SRV-102/103/104/105、SRV-110/106 | 逐条最小反例后修复，保留修复前后反例与 rc |

## 6. 脱敏声明

本文件不含数据库口令/连接串、token、API Key、`BACKUP_MASTER_KEY`、真实个人信息与未脱敏请求体。本轮未修改任何产品代码、未改数据库、未启停服务；生产仅做只读确认（`/api/readyz`）。
