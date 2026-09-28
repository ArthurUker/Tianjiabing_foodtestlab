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
