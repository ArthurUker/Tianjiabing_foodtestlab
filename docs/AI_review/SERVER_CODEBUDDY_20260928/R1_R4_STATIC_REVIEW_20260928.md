# R1–R4 只读代码深审报告（2026-09-28）

> 基线：冻结 commit **`83bce2a`**（R0 已证 = 当时运行代码）｜范围：后端 ~22k 行（lib / routes / middleware / scripts / migrations / deploy）
> **本轮未修改任何代码、数据或配置**｜证据级别：**静态（源码回读）** + 少量**生产只读取数**
> 脱敏：不含数据库口令/连接串、token、API Key、`BACKUP_MASTER_KEY`、真实个人信息、未脱敏请求体。

## 1. 方法

4 路独立探查并行产出 **40 条候选** → 逐条回读源码复核（不采信工具结论）→ **17 条坐实**、13 条留作待验证、若干条**下调或证伪**。

**证据级别声明**：本报告全部为**静态**证据（源码行级回读）与**生产只读**取数。**未**在隔离克隆库构造最小反例，因此"代码事实"成立，"可利用性/可达性"仍需下一轮在克隆库验证。

## 2. 已坐实发现（17 条）

| ID | 严重度 | 一句话 | 位置 |
| --- | --- | --- | --- |
| SRV-111 | **P1** | 学校侧备份列表下发全库备份的 `table_counts`（键为 `schema.table`）→ **跨租户元数据泄漏** | `routes/schoolBackupRoutes.js:137-142,187` + `lib/backupService.js:150` |
| SRV-114 | **P1**（latent） | 旧 schema 清理脚本的正则可命中**在用**租户 schema → `DROP SCHEMA CASCADE` | `scripts/005_cleanup-old-schemas.mjs:25,132` + `lib/tenantClient.js:70` |
| SRV-101 | P2 | PUT 未提交 `status` ⇒ 记录状态被改写成 `completed`（archived 复活 / failed 伪装完成） | `lib/recordNormalize.js:336` + `routes/recordRoutes.js:764-766` |
| SRV-108 | P2 | baseline 准入证明的 NOT NULL 扫描上限 60，**截断部分不计入"未证明"** | `lib/tenantProvisioner.js:1301-1308,1357-1360` |
| SRV-105 | P2 | `/api/sync/*` 写路径**零审计**；`DELETE /api/sync/queue` 物理删除归档记录 | `routes/syncRoutes.js`（全文 0 处 audit）+ `:361-366` |
| SRV-104 | P2 | 审计写入失败被 catch 吞掉，且与业务写不同事务 | `lib/recordNormalize.js:380-386` |
| SRV-106 | P2 | 心跳把已注销会话复位为 `active` → **"登出其它设备/强退"失效** | `routes/sessionRoutes.js:41-44` vs `:77-84` |
| SRV-109 | P2 | 两段发布入口 `b1` 段不可执行（cwd 无 schema + 门禁无 `DATABASE_URL`） | `scripts/b-release-two-phase.sh:38,58,49-50` |
| SRV-110 | P2 | 就绪闸门优先取**未签名** `body.schoolCode`，可绕过按校阻断 | `server.js:314-329,361` |
| SRV-112 | P2 | 按天删备份删不到真实产物（是子目录），行照删、按天统计恒 0 | `routes/adminDiskRoutes.js:145-148,256-262` |
| SRV-113 | P2 | `restore-from-upload` 防伪造锚点为空时**静默降级** | `routes/adminBackupRoutes.js:416-421` |
| SRV-102 | P2 | `sync` 更新不校验记录 `test_type` 与请求 `store` 一致 → 跨模块写坏 | `routes/syncRoutes.js:117-150` |
| SRV-103 | P2 | 复检自愈用"库内旧值"覆盖本次显式提交的 `result`（200 但用户值被丢弃） | `routes/recordRoutes.js:779-791` |
| SRV-115 | P3 | 过期清理删文件不删 `BackupRun` 行（**当前被 `BACKUP_KEEP_DAYS=0` 关停**） | `lib/backupService.js:667-698` |
| SRV-116 | P3 | 数据库口令进进程 argv（`pg_dump --dbname` / `psql -c`） | `lib/backupService.js:199`、`deploy/deploy.sh:363,368` |
| SRV-107 | P3 | `POST /api/session` 的 update 分支不校验 `user_id`（同租户跨用户会话行篡改） | `routes/sessionRoutes.js:30-44` |
| SRV-117 | P3 | 租户链回放的 `to_regclass('"recycle_bin"')` 未限定 schema → 实际改 `public` 对象 | `prisma/migrations/20260927130000_.../migration.sql:89-95` + `lib/tenantProvisioner.js:1717` |

### 2.1 重点条目

**SRV-111（P1）跨租户元数据泄漏**
`schoolBackupRoutes.js:137-142` 的 where 显式含 `{ scope: 'all' }`（全库备份对所有学校可见），`:187` 把 `tableCounts: r.table_counts` 原样下发；`backupService.js:150` 的 `collectTableCounts` 以 **`counts[schema.table]`** 为键（与 dump 反推计数交叉核对必须同键，键形态确定）。任一所学校 admin/manager 调 `GET /api/school/backups` 即可读到**其他学校的 schema 名、表名与逐表行数**。同文件 `:154-155` 的注释写明"避免暴露其他租户结构信息"——该保护只作用于 `schema_snapshot`/`compat`，**漏了 `table_counts`**。
修复：学校侧仅回传 `school_<code>` 与 `public` 的子集（与 `buildSchoolSchemaCompat` 同口径过滤）。

**SRV-114（P1，latent）清理脚本可能删掉在用租户**
`schemaNameOf` 把 code 中 `-` 归一为 `_`（`tenantClient.js:70`）；`005_cleanup-old-schemas.mjs:25` 用 `^school_[a-z0-9_]+_old_[0-9]+$` 判定"备份点"。学校代码若形如 `x-old-2` ⇒ 在用 schema `school_x_old_2` **命中**，`ts = new Date(2)`（1970）排最前，在 `--all` 或同组超 `--keep` 时被 `DROP SCHEMA ... CASCADE`（`:132`），且无 OID/台账/在用性复核。当前生产校码（test/tjb/zhsy/zhyz）不匹配，故不可达。
修复：改用 `pg_namespace` + 恢复台账双条件（`_old_<epoch ms>` 且 OID 已登记），近 24h 备份点强制保留。

**SRV-101（P2）`status` 默认值泄漏进 update 语义**
`buildRecordWriteData` 恒定输出 `status`（`recordNormalize.js:336` 默认 `'completed'`）；`resolveWritableStatus` 在"未提交"时返回 `status: undefined`（`:288`），于是 `recordRoutes.js:766` 的展开不覆盖，`built.data.status` 原样落库。请求体不带 `status`（外部客户端、导表、部分更新）→ 状态被改写；`archived` 被**复活**为 completed，`failed` 被伪装成完成。Web 端因回写整条记录通常不触发。
修复：默认值只在 `mode === 'create'` 生效；update 未提交时不出该键。

**SRV-108（P2）准入证明被静默截断**
`tenantProvisioner.js:1302/1309/1335` 三处 `slice(0, 60/40/40)`；**被截断的余量不进 `notProven`**（`:1357-1360` 只汇总已记录项）。按 `schema.prisma` 逐模型统计：契约模型 23 个、**NOT NULL 列 ≈160 项**，60 的上限实际截掉约 100 列（FK ≈14、唯一索引 ≈30，这两个上限预计不触发）。含义：`proof.ok=true` 可在一批未扫描的 NOT NULL 列上成立，随后 `--baseline-apply` 记账并放开该校流量。
修复：去掉上限全扫（或分批），必须设限则把余量显式推入 `notProven`。

**SRV-105 + SRV-104（P2）审计完整性**
`syncRoutes.js` 全文对 `audit|AuditLog|writeTenantAuditLog` **0 命中**：离线队列的 add/update/delete/batch 全部无痕，`DELETE /api/sync/queue` 直接 `deleteMany({status:'archived'})` 物理删除该校归档记录（无审计、无二次确认、无条数上限）。REST 路径的审计是"业务提交后另起事务写、失败仅 `console.error`"（`recordNormalize.js:380-386`）→ 业务 200、审计缺失、调用方不可见。
修复：sync 写路径按 REST 同口径补审计；业务写与审计同事务，或至少落 `public.SystemLog` 兜底并暴露计数。

**SRV-106（P2）会话管控失效**
`DELETE /api/session/others` 只把他人会话行置 `revoked`（`sessionRoutes.js:77-84`），被注销设备的下一次心跳（前端每 60s `POST /api/session`）在 `:41-44` **无条件**写回 `status:'active'`。被"强制登出"的设备凭未过期的 access(30m)/refresh(7d) 继续可用，并重新出现在活跃会话列表。
修复：注销时对该 userId 写 `public.revoked_tokens`（或 bump epoch）；心跳仅在"行存在且属本人"时更新 `last_seen_at`。

**SRV-109（P2）发布入口不可执行**
`b-release-two-phase.sh:38` 先 `cd "$REPO_ROOT"`，`:58` 再执行 `npx prisma migrate deploy`——仓库根**无 `prisma/` 目录也无 `prisma` 键**（已核），CLI 只装在 `backend/node_modules`；`:49-50` 的门禁直接跑 `006_audit_principal_gate.mjs`，该脚本只读 `process.env.DATABASE_URL` 而脚本从不加载 `backend/.env` → 即便迁移通过也必然以退出码 2 中止。

**SRV-110（P2，latent）就绪闸门可被请求体绕过**
`tenantSchoolHint` 顺序为 URL → **`req.body.schoolCode`** → JWT 载荷（`server.js:314-329`），`:361` 仅按该 hint 判定是否阻断。对 `/api/records/...` 等无校码前缀的路由，登录用户加 `{"schoolCode":"<健康校码>"}` 即可让**自己所在被阻断学校**的请求穿过 `TENANT_SCHEMA_NOT_READY` 闸门，路由层仍按 JWT 解析到被阻断学校执行。当前四校全绿故不可达——恰在闸门该起作用时失效。
修复：hint 以 JWT 为准，`body.schoolCode` 只用于未认证的登录路径。

### 2.2 复核纠偏（工具结论被修正）

| 工具结论 | 复核结果 |
| --- | --- |
| "备份过期清理删文件不删行（P2，默认保留 7 天）" | **下调 P3**：生产 `.env` 实测 `BACKUP_KEEP_DAYS=0`，`cleanupOldBackups` 在 `keepDays()<=0` 时直接 `return 0`（`backupService.js:671`）→ 当前**不生效** |
| "baseline 证明被截断（P2）" | **坐实并量化**：按 `schema.prisma` 统计 ≈160 NOT NULL 列 vs 上限 60 |
| "IP 白名单 IPv6 永不匹配 / 限流按 credential 计数" | 见 §3（部分已坐实为 SRV-119） |
| "recycle_bin 语句写 public（P2）" | **下调 P3**：public 先迁移且语句为 `ADD COLUMN IF NOT EXISTS`，实为 no-op，属语义/锁粒度问题 |

## 3. 待验证候选（13 条，未逐条回读）

| ID | 严重度(待定) | 摘要 | 位置（待复核） |
| --- | --- | --- | --- |
| SRV-124 | P2? | 开放接口拒绝日志把 `originalUrl`（含 query）写入 `SystemLog` → 若调用方以 query 传 Key 会随鉴权失败落库 | `middleware/openApiAuth.js:56-80` |
| SRV-125 | P3 | 开放接口游标未签名，且 `f`/`p` 校验被真值判断短路 → 可自造游标（范围仍由 grant 现算，无越权） | `routes/openApiRoutes.js:463-468`、`lib/openApiScope.js:325-401` |
| SRV-126 | P3 | 开放接口限流为进程内 Map 且按 credential 计数 → 多实例/轮换双活可成倍放大 | `middleware/openApiAuth.js:35,119-126` |
| SRV-127 | P2? | 导出统计口径与后端 SQL/看板不一致（同一批数据两套合格率） | `frontend/js/services/ExportService.js:993-1000` vs `lib/conclusionVerdict.js:31` |
| SRV-128 | P2? | 幂等 store 全局共享、无字节上限（仅 10000 条目），满则对**所有租户**返回 429 | `middleware/idempotencyMiddleware.js:30-36,182-184` |
| SRV-129 | P3 | 台账存在性探测用 `information_schema`（受权限过滤），与本仓自定契约（须用 `pg_catalog`）冲突 | `lib/tenantProvisioner.js:499-501` vs `lib/publicInfraShape.js:15-16` |
| SRV-130 | P3 | `004_backfill_audit_principals.mjs --schema` 未走 schema 白名单即插值进 SQL/连接串 | `scripts/004_backfill_audit_principals.mjs:59,458` |
| SRV-131 | P3 | `TENANT_ALIGN_ACCEPT_DESTRUCTIVE` / `acceptDataLoss` 已无消费方，注释仍称"默认拒绝破坏性语句" | `lib/tenantProvisioner.js:50-58,1992` |
| SRV-132 | P2? | `rewriteSchemaNames` 为全局字符串替换，可能改到 COPY 数据行内的同名文本 | `lib/restoreSqlUtils.js:19-21` |
| SRV-133 | P3 | 学校侧/超管侧 ACL 基线与自证只看显式 ACL（不含属主、仅 5 类对象） | `lib/restoreService.js:230,244-253,413-417` |
| SRV-134 | P3 | 恢复的 drain 依赖 `pg_stat_activity.query` 文本命中；屏障键用未归一 `schoolCode` | `lib/restoreService.js:130-140,517`、`lib/tenantWriteBarrier.js:90-98` |
| SRV-135 | P3 | `seed.js` 无校验写 `public."School"`，非法 `SCHOOL_CODES` 项可永久卡死 readiness 与每次部署 | `backend/prisma/seed.js:79-87` |
| SRV-136 | P3 | `provisionSchool` 历史 admin 降级日志永不输出（对 `$executeRawUnsafe` 返回值做 `Array.isArray`） | `lib/tenantProvisioner.js:2062-2067` |

## 4. 已核实**未发现**缺陷的方向

- **租户隔离主线**：`req.db` 仅由 `authenticateUser`→`attachTenant` 依 JWT `schoolCode` 绑定；schema 名拼进 DDL/连接串前统一过 `assertSafeSchemaName`（`/^school_[a-z0-9_]+$/` + ≤63）；`schemaNameOf` 单点归一。未找到跨租户读取他人业务数据的路径。
- **原生 SQL**：`/api/test-records/stats` 的 `$queryRawUnsafe` 片段全部来自常量 + 绑定参数；业务日期走文本比较 + 合法性正则。
- **命令执行**：备份/恢复 `spawn` 全程数组参数、无 `shell:true`；上传文件名净化 + `mkdtemp(0700)`；外部注册有符号链接/realpath 越界拒绝，且审计与 `BackupRun` 插入同事务。
- **未认证路径不写审计**：`middleware/authMiddleware.js` 对 `SystemLog|writeTenantAuditLog|securityAlert` **0 命中** → 未认证 401 探针不落库，可安全复用为只读探针。

## 5. 修复顺序建议（供 R6/F1 排期）

1. **SRV-121（P0，见事故报告）** → 先止损并重新冻结基线。
2. **SRV-111**（跨租户元数据泄漏）→ 改动最小、收益最高。
3. **SRV-114**（潜在毁数据）→ 给清理脚本加"在用性 + 台账"双门禁，或先冻结执行。
4. **SRV-101 / SRV-106**（状态被静默改写、会话管控失效）。
5. **SRV-104 / SRV-105**（审计缺口）→ 需先定义"租户侧审计是否强制"。
6. **SRV-108 / SRV-109 / SRV-110 / SRV-122**（门禁与发布链本体）。
7. 其余 P2/P3 按排期。

## 6. 边界

- 全部为**静态 + 生产只读**证据；**未**在隔离克隆库做最小反例，故 P1/P2 的**可利用性与可达性**仍需下一轮验证。
- 未修改任何代码/数据；未运行 `migrate deploy`、无参数 `db:sync`、`--baseline-apply`、恢复、清理或压测。
