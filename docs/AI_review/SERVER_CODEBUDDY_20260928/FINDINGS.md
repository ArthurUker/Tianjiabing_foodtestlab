# 发现台账与复核模板

本文件只提供格式。不要把尚未在服务器复证的历史问题预填成“已发现”。每项问题有稳定 ID（如 `SRV-001`）；同一根因的多处表现归为一个 ID，并逐项列影响入口。

## 严重度

| 级别 | 判据 | 处理顺序 |
| --- | --- | --- |
| P0 | 跨租户/外部数据泄漏、数据损坏、关键服务全不可用、不可控写库 | 停止新增写探针，先止损和保全证据 |
| P1 | 核心流程失败、认证/授权绕过或错误阻断、备份恢复不能可靠执行、部署门禁失效 | 下一轮优先修复，未闭合不报全面通过 |
| P2 | 有可控绕行的功能缺陷、局部权限/数据一致性风险、可复现的运维误导 | 排期并设验收条件 |
| P3 | 文档、观测和低影响维护问题 | 归属到版本化清单 |

## 单项记录（复制一份）

```markdown
### SRV-001 · 简短标题

- 状态：OPEN / FIXING / READY_FOR_REVIEW / VERIFIED_CLONE / VERIFIED_PROD / CLOSED / NOT_REPRODUCED
- 严重度：P0 / P1 / P2 / P3；判定理由：
- 首见时间（含时区）：；发现轮次/审查员：
- 代码基线：仓库 commit；实际运行进程 commit/路径；DB 链摘要（若相关）：
- 影响：入口/角色/租户范围/数据范围/外部合作方；当前实际影响与潜在影响分开写：
- 复现前提与最小步骤：
- 预期 vs 实际：HTTP 状态、错误码、SQL 形状、台账状态或文件差异（不含凭据/个人数据）：
- 证据级别：静态 / 单测替身 / 隔离 PG / 生产只读 / 生产受控写；原始日志仓外位置及脱敏摘要：
- 根因：`path:line`，如为推测写“待证实”：
- 修复方案与修改面：
- 修复提交 SHA、测试入口、执行数、0 skip、失败前后反例：
- 克隆库验收：PASS / FAIL / NOT_RUN；生产验收：PASS / FAIL / NOT_RUN：
- 清理/回退与外部影响：
- 独立复核人、时间、复核证据：
- 未解决风险/关闭理由：
```

## 每轮摘要（复制一份）

```markdown
### R0 / R1 / R2 / R3 / R4 / R5 / R6 · 日期

| 项目 | 记录 |
| --- | --- |
| 工作区 HEAD / 实际运行 SHA | |
| 审查范围与排除项 | |
| 命令/测试/HTTP 探针 | |
| 退出码、测试执行数、skip | |
| 证据级别与环境 | |
| 新发现 / 关闭 / 仍开放 | |
| 生产数据变化与清理 | |
| 脱敏检查 | |
| 本轮结论 | PASS / FAIL / BLOCKED / NOT_RUN |
```

## 统计口径

只统计**真实执行**的测试数，不把 suite 数、断言数与 HTTP 探针数相加。失败用例不能因后续复跑绿而从时间线删除；每次尝试独立命名并保留原始退出码。`VERIFIED_CLONE` 不等于 `VERIFIED_PROD`。修复已经推送但尚未部署的状态保持 `READY_FOR_REVIEW` 或 `VERIFIED_CLONE`。

---

# 台账 · 2026-09-28 首轮（R0–R5）

> 每条发现均给出可复核的 `path:line`。**完整叙述与触发条件**见同目录：
> `R0_BASELINE_20260928.md`（R0 基线）、`R1_R4_STATIC_REVIEW_20260928.md`（R1–R4 静态深审）、`INCIDENT_20260928_TENANT_503.md`（P0 事故 + R5）。
> 代码基线：`83bce2a`（R0 时运行代码）。状态一律 `OPEN`（本轮只读，未修）。

## 严重度分布

| 级别 | 数量 | ID |
| --- | --- | --- |
| P0 | 1 | SRV-121 |
| P1 | 2 | SRV-111、SRV-114 |
| P2 | 15 | SRV-R0-001/002/003、SRV-101/102/103/104/105/106/108/109/110/112/113/122 |
| P3 | 10 | SRV-R0-004/005、SRV-107/115/116/117/118/119/120/123 |
| 已坐实合计 | **28** | P0×1 + P1×2 + P2×15 + P3×10 |
| 待验证（严重度待定） | 13 | SRV-124…136 |

## 已坐实发现

| ID | 严重度 | 摘要 | 位置 | 证据级别 |
| --- | --- | --- | --- | --- |
| **SRV-121** | **P0** | 就绪门禁在运行期实时读取**可写工作区** → 在生产目录"放入一个迁移文件"即可 ≤60s 内造成全站租户 503 且不自愈 | `backend/server.js:300-376`；`backend/lib/tenantSync.js`（链摘要读盘） | 生产只读 |
| **SRV-111** | **P1** | 学校侧备份列表下发全库备份的 `table_counts`（键为 `schema.table`）→ **跨租户元数据泄漏** | `backend/routes/schoolBackupRoutes.js:137-142,187` + `backend/lib/backupService.js:150` | 静态 |
| **SRV-114** | **P1**(latent) | 旧 schema 清理正则命中**在用**租户 schema → `DROP SCHEMA CASCADE` | `backend/scripts/005_cleanup-old-schemas.mjs:25,132` + `backend/lib/tenantClient.js:70` | 静态 |
| SRV-R0-001 | P2 | `GET /api/audit-logs/users` 对 admin/manager 恒 400（`Argument 'not' must not be null`） | `backend/routes/auditRoutes.js:344-347`；`backend/prisma/schema.prisma:87` | 生产只读 + 静态 |
| SRV-R0-002 | P2 | 缺 `test_name` 时 `POST /api/test-records` 返回 500 而非 400 | `backend/routes/recordRoutes.js:78-88,115-116`；`schema.prisma:130` | 生产只读 + 静态 |
| SRV-R0-003 | P2 | 恢复作业的**租户侧**审计写入失败（`AuditLog_user_id_fkey`） | `backend/routes/schoolBackupRoutes.js` | 生产只读 |
| SRV-101 | P2 | PUT 未提交 `status` ⇒ 记录状态被改写成 `completed`（archived 复活 / failed 伪装完成） | `backend/lib/recordNormalize.js:336,288`；`backend/routes/recordRoutes.js:764-766` | 静态 |
| SRV-102 | P2 | `sync` 更新不校验记录 `test_type` 与请求 `store` 一致 | `backend/routes/syncRoutes.js:117-150`（对比 `recordRoutes.js:731-733`） | 静态 |
| SRV-103 | P2 | 复检自愈覆盖本次显式提交的 `result`（200 但用户值被丢弃） | `backend/routes/recordRoutes.js:779-791` | 静态 |
| SRV-104 | P2 | 审计写入失败被吞，且与业务写不同事务 | `backend/lib/recordNormalize.js:380-386` | 静态 |
| SRV-105 | P2 | `/api/sync/*` 零审计；`DELETE /api/sync/queue` 物理删除归档记录 | `backend/routes/syncRoutes.js`（0 处 audit）、`:361-366` | 静态 |
| SRV-106 | P2 | 心跳把已注销会话复位 `active` → "登出其它设备/强退"失效 | `backend/routes/sessionRoutes.js:41-44` vs `:77-84` | 静态 |
| SRV-107 | P3 | `POST /api/session` 的 update 分支不校验 `user_id` | `backend/routes/sessionRoutes.js:30-44` | 静态 |
| SRV-108 | P2 | baseline 证明 NOT NULL 扫描 `slice(0,60)` 且**截断不计入 `notProven`**（契约 ≈160 列） | `backend/lib/tenantProvisioner.js:1301-1308,1357-1360` | 静态 + 契约统计 |
| SRV-109 | P2 | `b-release-two-phase.sh` b1 不可执行（cwd 无 schema；006 门禁无 `DATABASE_URL`） | `backend/scripts/b-release-two-phase.sh:38,58,49-50` | 静态 |
| SRV-110 | P2 | 就绪闸门优先取**未签名** `body.schoolCode`，可绕过按校阻断 | `backend/server.js:314-329,361` | 静态 |
| SRV-112 | P2 | 按天删备份只删文件不删子目录、行照删、按天统计恒 0 | `backend/routes/adminDiskRoutes.js:145-148,256-262` | 静态 |
| SRV-113 | P2 | `restore-from-upload` 锚点为空即跳过强校验 | `backend/routes/adminBackupRoutes.js:416-421` | 静态 |
| SRV-115 | P3 | 过期清理不删 `BackupRun` 行（当前被 `BACKUP_KEEP_DAYS=0` 关停） | `backend/lib/backupService.js:667-698` | 静态 + 配置 |
| SRV-116 | P3 | 口令进进程 argv（`pg_dump --dbname` / `psql -c`） | `backend/lib/backupService.js:199`、`deploy/deploy.sh:363,368` | 静态 |
| SRV-117 | P3 | 租户回放 `to_regclass('"recycle_bin"')` 未限 schema → 改 `public` 对象 | `backend/prisma/migrations/20260927130000_.../migration.sql:89-95` | 静态 |
| SRV-118 | P3 | `/import` 不校验 IP 白名单项/无上限/非数组写 `[]`（= 取消来源限制） | `backend/routes/adminOpenApiRoutes.js:927-928` | 静态 |
| SRV-119 | P3 | IP 白名单项不归一 → IPv6 CIDR 永不匹配；非数组即"不限制" | `backend/lib/openApiKeys.js:79-97` | 静态 |
| SRV-120 | P3 | 登录审计 IP 取 `X-Forwarded-For` **首值**（可伪造） | `backend/routes/userRoutes.js:122` | 静态 |
| SRV-122 | P2 | 新迁移落盘必须伴随重启，但该顺序未被强制（旧注册表 → fail-closed） | `backend/lib/tenantProvisioner.js`（`TENANT_MIGRATION_REGISTRY`）；`deploy/deploy.sh` 顺序 | 生产只读 |
| SRV-123 | P3 | 导出 `jobId` 未校验即进 `path.join` | `backend/lib/exportJobs.js:65-73` | 静态 |
| SRV-R0-004 | P3 | 文档写 `/readyz` 可用，实测 404（仅 `/api/readyz`、`/health`） | `README.md`/`ONLINE_CHECKS.md` vs `backend/server.js:312` | 生产只读 |
| SRV-R0-005 | P3 | R0 窗口与生产写/恢复并发 → 基线不可复用 | `backups/.jobs/restore-*.json`、`AuditLog` | 生产只读 |

## 待验证候选（未逐条回读，严重度待定）

| ID | 摘要 | 位置 |
| --- | --- | --- |
| SRV-124 | 开放接口拒绝日志含 `originalUrl`（含 query）→ Key 若走 query 会落库 | `backend/middleware/openApiAuth.js:56-80` |
| SRV-125 | 开放接口游标未签名且 `f`/`p` 校验被真值短路 | `backend/routes/openApiRoutes.js:463-468`；`backend/lib/openApiScope.js:325-401` |
| SRV-126 | 开放接口限流为进程内 Map、按 credential 计数 | `backend/middleware/openApiAuth.js:35,119-126` |
| SRV-127 | 导出统计口径与后端/看板不一致 | `frontend/js/services/ExportService.js:993-1000` vs `backend/lib/conclusionVerdict.js:31` |
| SRV-128 | 幂等 store 全局共享、无字节上限，满则全体 429 | `backend/middleware/idempotencyMiddleware.js:30-36,182-184` |
| SRV-129 | 台账存在性探测用 `information_schema`（受权限过滤） | `backend/lib/tenantProvisioner.js:499-501` vs `backend/lib/publicInfraShape.js:15-16` |
| SRV-130 | `004 --schema` 未走 schema 白名单 | `backend/scripts/004_backfill_audit_principals.mjs:59,458` |
| SRV-131 | `TENANT_ALIGN_ACCEPT_DESTRUCTIVE` 已无消费方 | `backend/lib/tenantProvisioner.js:50-58,1992` |
| SRV-132 | `rewriteSchemaNames` 全局替换可能改到 COPY 数据行 | `backend/lib/restoreSqlUtils.js:19-21` |
| SRV-133 | ACL 基线与自证只看显式 ACL（不含属主、仅 5 类对象） | `backend/lib/restoreService.js:230,244-253,413-417` |
| SRV-134 | 恢复 drain 依赖 query 文本命中；屏障键未归一 | `backend/lib/restoreService.js:130-140,517`；`backend/lib/tenantWriteBarrier.js:90-98` |
| SRV-135 | `seed.js` 无校验写 `School`，非法 code 可永久卡死 readiness | `backend/prisma/seed.js:79-87` |
| SRV-136 | 历史 admin 降级日志永不输出（`Array.isArray` 误用） | `backend/lib/tenantProvisioner.js:2062-2067` |

## 每轮摘要

### R0 · 2026-09-28（16:11–16:15 CST）

| 项目 | 记录 |
| --- | --- |
| 工作区 HEAD / 实际运行 SHA | 均为 `83bce2a`（三重证据：cwd / 启动后无源码改写 / dist 构建时间 + reflog） |
| 审查范围与排除项 | 部署基线、门禁、就绪、目录权限、OpenAPI 授权元数据；排除一切写操作 |
| 命令/HTTP 探针 | `sync-tenant-schemas.mjs --check`、`006_audit_principal_gate.mjs`、`/api/health`、`/api/readyz`、`/health`、`/readyz` |
| 退出码 | 两门禁 **rc=0**；health/readyz **200**；`/readyz` **404** |
| 证据级别与环境 | 生产只读 |
| 新发现 / 关闭 / 仍开放 | 新 5（SRV-R0-001…005）；关闭 0；仍开放 5 |
| 生产数据变化与清理 | 窗口内 tjb +1 真实业务写入（1174→1175）、school_test 恢复作业 1 次；无残留 |
| 脱敏检查 | 通过（无口令/token/个人信息） |
| 本轮结论 | **PASS**（基线可信、不可复用；16:24 后失效） |

### R1–R4 · 2026-09-28（静态深审）

| 项目 | 记录 |
| --- | --- |
| 工作区 HEAD / 实际运行 SHA | `83bce2a`（本轮只读，未改文件/数据） |
| 审查范围与排除项 | lib/routes/middleware/scripts/migrations/deploy ~22k 行；排除一切写操作与破坏性反例 |
| 命令/HTTP 探针 | 源码回读为主；辅以只读 SQL（租户计数、授权元数据） |
| 退出码 | 不适用（无写命令）；只读查询 rc=0 |
| 证据级别与环境 | **静态** + 生产只读（**未**做隔离克隆库反例） |
| 新发现 / 关闭 / 仍开放 | 40 条候选中**坐实 17 条**、留 13 条待验证、少数被下调/证伪；关闭 0 |
| 生产数据变化与清理 | 无（只读） |
| 脱敏检查 | 通过 |
| 本轮结论 | **PASS**（静态层完成）；隔离库反例 **NOT_RUN** |

### R5 · 2026-09-28（在线核验，被 P0 中断）

| 项目 | 记录 |
| --- | --- |
| 工作区 HEAD / 实际运行 SHA | 工作区 16:24 被改、16:43 提交为 `caa2a93`；**运行进程仍是 15:40:44 加载的 `83bce2a`** → 基线失效 |
| 审查范围与排除项 | ONLINE_CHECKS 0–8；排除写探针与真实外部调用 |
| 命令/HTTP 探针 | `/api/health`、`/api/readyz`（本地+公网）、6 个受保护端点无 token/伪造 token、`--check`、只读 SQL |
| 退出码 | `/api/readyz` **503**；`--check` **rc=1**；6 个受保护端点全部 **503** |
| 证据级别与环境 | 生产只读 |
| 新发现 / 关闭 / 仍开放 | P0 事故 1 起（SRV-121）+ SRV-122 等；关闭 0 |
| 生产数据变化与清理 | 无（探针全部只读；未认证路径经源码确认不写审计） |
| 脱敏检查 | 通过 |
| 本轮结论 | **FAIL**（就绪与门禁未通过；项 4 BLOCKED、项 5/8 NOT_RUN） |

### R6 · 2026-09-28（深入复证第 1 轮；详见 `R6_VERIFICATION_ROUND1_20260928.md`）

| 项目 | 记录 |
| --- | --- |
| 工作区 HEAD / 实际运行 SHA | 工作区 `0e66f0f`（clean）；运行进程 PID 1673914（16:45:51 启动，cwd=backend，启动后无源码改写） |
| 远端 / 其他窗口 | 远端 `2eef9cb`（领先 1 个纯文档提交）；**存在其他活跃窗口**（`.git/FETCH_HEAD` 16:52:55）→ 已停止克隆以外的线上动态探针 |
| 审查范围与排除项 | A 基线 / B SRV-121·122 / C 五项高风险；**排除**：生产迁移、恢复、故障注入、破坏性测试、在生产目录落盘迁移或 schema |
| 命令/HTTP 探针 | `--check` rc=0、`006` rc=0、`/api/health` 200、`/api/readyz` 200（公网同）；隔离环境：4 次 CLI/服务对照、`005_cleanup` dry-run+execute、baseline proof 探针 |
| 退出码 | 生产门禁 rc=0/rc=0；隔离：旧代码 rc=1（UNCLASSIFIED）、新代码 rc=1（仅 MIGRATIONS_PENDING）、005 execute rc=0 |
| 证据级别与环境 | 生产只读 · **隔离 PG + 真实脚本执行** · 静态 + 隔离只读计数 |
| 新发现 / 关闭 / 仍开放 | **SRV-121/122 复现成功**；**SRV-114 复现成功（含破坏性后果）**；**SRV-108 降级 P2→P3**；**新增 SRV-137（P2，唯一索引上限 40 < 实测 43，反例 NOT_RUN）**；SRV-111/110/106 维持原级但 **NOT_RUN** |
| 生产数据变化与清理 | 生产无数据变更；隔离环境已全部清理（克隆库 drop、隔离目录删除、3102/3103 无监听、生产 PID 未重启） |
| 脱敏检查 | 通过 |
| 本轮结论 | **A/B PASS；C 部分执行（114✅、108 部分、111/110/106 NOT_RUN）** → 整轮 **PARTIAL**（按口径记为：已完成项 PASS，未执行项 NOT_RUN，不整体报 PASS） |

#### R6 状态与证据级别变更

| ID | R1–R4 定级 | R6 定级 | 证据级别 | 备注 |
| --- | --- | --- | --- | --- |
| SRV-121 | P0（静态+生产只读） | **P0（已复现）** | 隔离 PG | 四项特征与事故逐字一致（503 / `[MIGRATIONS_PENDING,CANNOT_CHECK]` / 租户 API 503 / health 200） |
| SRV-122 | P2（静态） | **P2（已复现）** | 隔离 PG + 静态 | 唯一变量=内存注册表；重启后 `CANNOT_CHECK` 消失 |
| SRV-114 | P1（静态） | **P1（已复现，含破坏性后果）** | 隔离 PG + 真实脚本 | `DROP SCHEMA` 真删在用校 schema，`School` 注册行存活 |
| SRV-108 | P2 | **↓ P3（潜在）** | 静态 + 隔离只读计数 | NOT NULL 上限 60 < 实测 160，但被无上限的列检查①涵盖 → **无法构造误判** |
| SRV-137 | — | **🆕 P2** | 静态 + 隔离只读计数 | `uniqIdx.slice(0,40)` vs 实测唯一索引 **43** → ≥3 个唯一索引永不检查，可无结构漂移地产生重复值；**端到端反例 NOT_RUN** |
| SRV-111 / 110 / 106 | P1 / P2 / P2 | 维持原级，**状态 = NOT_RUN** | 静态 | 需完整隔离 HTTP 栈（合成学校/账号/blocked 状态/会话链），本轮未执行 |

#### R6 未执行项（NOT_RUN，不得计为通过）

1. ONLINE_CHECKS 项 4 未认证边界（事故后重做）与项 5 已授权业务读。
2. SRV-111 / SRV-110 / SRV-106 的隔离反例。
3. SRV-137 的端到端反例（第 41+ 唯一索引构造重复值 → proof 是否错误通过）。
4. 发布脚本（`b-release-two-phase.sh` / `deploy.sh`）的沙盒实跑（本轮仅静态审查）。
5. 其余 13 条候选（SRV-124…136）逐条复核。
6. 克隆/隔离副本中出现对生产 `.env` 的 `EACCES` 读尝试 → 未定位到具体代码行（隔离保真度观察项）。

### R6 · 第 2 轮（阶段 3/5：SRV-101–105 与 SRV-124–136 逐条复核；详见 `R6_VERIFICATION_ROUND2_20260928.md`）

**约束**：开工前探测到**另一窗口正在编辑生产工作区**（`M frontend/pages/login.html`、`.git/FETCH_HEAD` 16:59:58）→ 按计划停止克隆以外的线上探针，本轮**全部为静态回读 + 不触库的函数级替身验证**；生产仅做只读确认（`readyz` 200、`blockedSchools=[]`、PID 1673914 未重启）。

| ID | 本轮结论 | 证据级别 | 定级变动 |
| --- | --- | --- | --- |
| **SRV-101** | **属实（函数级铁证）**：`resolveWritableStatus({requested:undefined,…})` → `{"ok":true}`（无 `status` 键）＋ `buildRecordWriteData('oil', <无 status>)` → `status="completed"`；显式 `status:'failed'` → `"failed"` | **替身测试（无需 DB）** | P2 维持（已复证） |
| SRV-102 / 103 / 104 / 105 | 维持（静态已回读） | 静态 | P2 维持；**最小反例 NOT_RUN** |
| SRV-124 | **属实**（附前提：Key 走 query 属非文档化用法） | 静态 | P3 |
| SRV-125 | **属实**（`s`/`g` 仍强校验 → **不可扩大可见范围**） | 静态 | P3 |
| SRV-126 | **属实** | 静态 | P3 |
| SRV-127 | **属实且分叉面更大**（导出无 `atpPoints` 回退；`colorLevel='警戒'` 被计不合格） | 静态 | **P2** |
| SRV-128 | **属实**（满则全体 429 `IDEMPOTENCY_STORE_FULL`） | 静态 | P2 |
| SRV-129 | **属实**（纪律为模块级自述，非全仓门禁） | 静态 | P3 |
| SRV-130 | **属实但可达性大幅受限**（`:453-457` 前置参数化探测要求 schema 真实存在且含 M1 两列） | 静态 | **P3（理由变更）** |
| SRV-131 | **属实**（无任何产品/测试调用方） | 静态 | P3 |
| SRV-132 | **属实（影响潜在，未取到真实数据反例）** | 静态 | P3 |
| SRV-133 | **属实**（无 `nspowner/relowner`） | 静态 | P3 |
| SRV-134 | **部分属实**：drain 文本命中央实；屏障键主路径同源且**有全局 `READONLY_MODE` 默认兜底**（`restoreService.js:520-522`） | 静态 | **理由变更**（漏挡仅限历史非规范 `School.code`） |
| SRV-135 | **属实且更硬**：非法 `SCHOOL_CODES` 落库后**无法用 API 清除**（删除接口先 `isValidSchoolCode` → 400）→ `/api/readyz` 永久 503 | 静态 | **P2** |
| SRV-136 | **属实**（`Array.isArray(number)` 恒 false） | 静态 | P3 |

**汇总裁决**：13 条 = **12 属实 + 1 部分属实，0 证伪**；SRV-124–136 **全部脱离"待验证"状态**（但证据级别仅为静态/替身）。建议下一轮用隔离栈补：SRV-127、SRV-135 的最小反例，以及第 1 轮遗留的 SRV-111/110/106 与 SRV-137 反例。

**本轮 NOT_RUN**：SRV-102/103/104/105 最小反例；SRV-127/135 隔离复现；SRV-111/110/106、SRV-137 反例；ONLINE_CHECKS 项 4/5（事故后仍未重做）；发布脚本沙盒实跑；`.env` `EACCES` 观察项定位。

### R6 · 第 3 轮（隔离实例动态复证；详见 `R6_VERIFICATION_ROUND3_20260929.md`）

**开工状态（09-29 10:18）**：本地 `e964544` / 远端 `4f6bcf1`（多 1 文档提交）· 工作区 clean · 服务 `MainPID=1673914` 启动于 09-28 16:45:51 未重启 · `find backend -newermt` 无改动 ⇒ **运行后端代码 = 工作区**（前端另有 2 个提交，由 Caddy 服务）· **另一窗口活跃**（`FETCH_HEAD` mtime 10:18:21）。`readyz=200` 不作为冻结基线。

#### G0（硬门禁）— **定位完成，并修正上一轮的观察项**

- `Schema Env Error` 字符串**只来自 Prisma 自身运行时**（`@prisma/client/runtime/library.js`、`prisma/build/index.js`），**非项目代码**。
- 项目代码内 `/opt/foodsentinel` 命中**全部是注释中的运行示例**；`envFilePath` 仅 `lib/jwtSecretResolve.js:26,39,48,51` 的定义，**无调用方**。
- **决定性证据**：`node_modules/.prisma/client/index.js` 内嵌生成时的绝对路径 `/opt/foodsentinel/backend/prisma/schema.prisma`（及 `/opt/foodsentinel/backend/node_modules/`）。
- **根因**：上一轮把隔离副本的 `backend/node_modules` 做成了**指向生产的软链** → Prisma 按内嵌 schema 路径在生产目录做 `.env` 发现 → 读 `/opt/foodsentinel/backend/.env` → EACCES。**属隔离搭建不彻底，非产品缺陷**（并被"权限恰好拒绝"掩盖）。
- **新增隔离成立判据**：`grep -ao "/opt/foodsentinel[^\"']*" <副本>/backend/node_modules/.prisma/client/index.js` **必须为空**；`node_modules` 必须**复制**（或在副本内 `prisma generate`）；另需专用 DB 角色（`REVOKE CONNECT … FROM <role>`）、`server.js:598` 为全接口绑定故需显式回环绑定。

#### G1 / G2 / G3 — **NOT_RUN**（技术原因，非"结论为假"）

未完成隔离搭建（复制 `node_modules` + 隔离 client + 专用角色 + 回环绑定）→ 不满足"写操作前证明目标非生产库"的前置条件，故**未执行任何动态测试、未产生任何指向生产库的写操作**。各配方已写入报告 §2 供下一轮直接复用。

#### G3 的**结构性下调**（本轮可确定的结论）

- 代码：`tenantProvisioner.js:1258`（`curIdxRows` 完整）· `:1266-1268`（`indexes.valid` **无上限**）· `:1257-1263`（`indexes.all` **无上限**）· `:1335`（仅数据级重复扫描 `slice(0,40)`）。
- 论证：**有效（`indisvalid && indisready`）的唯一索引在 PostgreSQL 中不可能存在重复值**；要产生重复必先使索引无效或改其定义/谓词，而这两类均被**无上限**的 `indexes.valid` / `indexes.all` 捕获。
- 裁决：**SRV-137 由 P2 下调为 P3（潜在/代码异味）**，保留"截断余量不计入 `notProven`"的代码缺陷描述。SRV-108 维持 P3。

#### 重新定级

| ID | 本轮定级 | 说明 |
| --- | --- | --- |
| **SRV-137** | **↓ P3** | 结构性下调（见上） |
| SRV-111 | **P1 维持** | 仍为静态；本轮 **NOT_RUN**（无隔离 HTTP 证据） |
| SRV-110 | **P2 维持** | 同上；"闸门绕过"与"业务越权"须分开裁定 |
| SRV-106 | **P2 维持** | 同上；不得仅凭 Session 行状态判定 |

#### 本轮 NOT_RUN 汇总

G1（SRV-111）、G2（SRV-110 / SRV-106 / SRV-107 负例）、G3 的动态反例、SRV-101–105 路由级反例、SRV-127/128/135 隔离验证、发布脚本沙盒实跑、ONLINE_CHECKS 项 4/5。

#### SRV-121 / SRV-114 验收条件（供后续修复轮）

- **SRV-121/122**：隔离副本中"旧进程运行期新增迁移"不得再影响运行实例；真实 pending/failed/checksum 不一致/结构漂移/额外对象**仍须 503**（不得退化为告警放行）；发布脚本 b1/b2 沙盒 rc=0 且失败即中止；恢复路径明确且有记录。
- **SRV-114**：合成在用校（`x-old-2` ⇒ `school_xsyn_old_2`）不进入待删清单；真实旧备份点仍可清理；`--dry-run` 输出判定依据（OID/台账/在用性）；保留窗口不被误删。

### R6 · 第 4 轮（离线可判项 + G0 结论修正；详见 `R6_VERIFICATION_ROUND4_20260929.md`）

**开工**：本地=远端=`e212621`（**无 R4 计划文件**）· 工作区 clean · 服务 PID 1673914 未重启 · 另一窗口 `FETCH_HEAD` mtime 10:32:46（活跃）。本轮**未连任何数据库、未建隔离环境、未在生产工作区写文件**。

#### S1 · SRV-109 已实跑坐实（offline，零连库）

脚本 `:38` 先 `cd "$REPO_ROOT"`，故"仓库根"即其真实 cwd；在不设 `DATABASE_URL` 下直接执行它要执行的两条命令：

| 步骤 | 前置事实 | 实际 | rc |
| --- | --- | --- | --- |
| b1-① 仓库根 `prisma migrate deploy`（= 脚本 `:58`） | `ls -d prisma` → 不存在；`grep -c '"prisma"' package.json` → **0** | `Error: Could not find Prisma Schema …`（`schema.prisma` / `prisma/schema.prisma` 均 file not found） | **rc=1** |
| b1-② `006_audit_principal_gate.mjs`（= `gate_pass` 第 2 条，`:50`） | 脚本内**无任何 `.env` 加载** | `需要 DATABASE_URL（只读门禁）` | **rc=2** |

⇒ b1 段两处必然失败；**SRV-109 维持 P2**（发布通道不可用）。

#### S2 · SRV-127 已坐实分叉，但**需业务定性**

- 导出 `frontend/js/services/ExportService.js:997`：`const baseQualified = (r.result?.includes('合格') && !r.result?.includes('不合格')) || r.colorLevel === '合格';`
- 后端/看板同源 `backend/lib/conclusionVerdict.js:31` + `frontend/js/core/conclusionVerdict.js:17,41,58-60`：`OIL_COLOR_PASS = {合格, 警戒}` → 警戒 = PASS。
- ⇒ 油品 `colorLevel='警戒'` 且 `result` 为空：**导出计不合格、看板计合格**。
- ⚠️ 导出侧 `:994-996` 有**明文业务裁定**（"2026-07-02业务方裁定：仅'合格'计为合格……请勿改为宽松匹配"）⇒ **两侧均有背书，属口径未统一**，处置应为"业务裁决 + 单点收敛"，**不得**直接改导出表达式。
- 餐具 `atpPoints` 回退差异：**NOT_RUN**（未逐行排除上游分支）。

#### 🔧 修正第 3 轮 G0 结论（重要）

在生产目录、真实 `node_modules`、ubuntu 用户下执行 `006` **再次复现**同一 EACCES；而 `006` **既不 import dotenv 也不读 `.env`** ⇒ 读取由 **Prisma 运行时**触发，路径 = schema 父目录（`backend/prisma/schema.prisma` → `backend/.env`）。

1. 该 EACCES 是 **Prisma 在本仓的固有行为**，与软链无关，**被 Prisma 静默忽略**（非致命）。
2. 第 3 轮配方**不充分**：**复制 `node_modules` 不够**——生成客户端内嵌的仍是生产 schema 绝对路径，Prisma 仍会去生产目录找 `.env`。
3. **修正后要求**：隔离副本必须**在副本内 `prisma generate`**；隔离成立判据升级为"内嵌路径必须不含 `/opt/foodsentinel`"；并**不得**把"生产 `.env` 恰好不可读"当隔离保证。

#### 本轮 NOT_RUN

SRV-101/102/103/104/105 路由级反例 · SRV-128/135 隔离验证 · SRV-111/110/106/107 · 发布脚本端到端沙盒（本轮只覆盖 b1 段两处失败点） · 餐具 `atpPoints` 子项 · ONLINE_CHECKS 项 4/5。

#### 定级

**SRV-109 P2 维持（已坐实）** · **SRV-127 P2 维持（已坐实分叉，需业务定性）** · SRV-137 P3（第 3 轮下调）· SRV-111/110/106 维持 P1/P2/P2 且仍 NOT_RUN。

### 收口判定（2026-09-29 10:38）— **不能收口**（详见 `R6_CLOSURE_ASSESSMENT_AND_ROUND5_PLAN_20260929.md`）

对照 `README.md` 的 8 条完整收口条件：**3 条通过（#3 部分、#8 通过）/ 4 条未满足**。
- ❌ #1 P0/P1 未清零：**SRV-121（P0）未修**、**SRV-114（P1）未修**、**SRV-111（P1）未复证未修**
- ❌ #2 P2 无责任人/排期；❌ #4 备份/恢复从未隔离验证；❌ #5 测试与入口清单**从未执行**；❌ #6 R5 项 4/5 未做、OpenAPI 真实调用未做；❌ #7 备份/回退吻合性未验证

#### SRV-106 证据级别收紧（避免过度结论）

| 层次 | 可否定论 | 依据 |
| --- | --- | --- |
| Session **行复活** | **可以** | `routes/sessionRoutes.js:41-44`（心跳 upsert 的 update 分支无条件写 `status:'active'`）vs `:77-84`（`DELETE /others` 仅置 `revoked`） |
| "强制登出**失效**（token 仍可用）" | **不可以** | 取决于 jti/user_epoch/school_epoch 吊销链，**必须动态验证** |

⇒ **SRV-106 = CONFIRMED_STATIC（仅行复活）**；"token 仍可用"与 SRV-107 跨用户负例均记 **NOT_RUN**，不得作为结论。

#### 第 5 轮计划要点（验收条件见专文）

段 A 隔离搭建（**副本内 `prisma generate`** + 专用 DB 角色 + 回环绑定）→ 段 B 反例（SRV-111/110/106/107、SRV-101–105、SRV-128/135、SRV-137）→ 段 C 收口前补齐（R5 项 4/5、测试清单 0 skip、备份/回退、OpenAPI 协调）→ 段 D 修复顺序（须逐项授权）。
