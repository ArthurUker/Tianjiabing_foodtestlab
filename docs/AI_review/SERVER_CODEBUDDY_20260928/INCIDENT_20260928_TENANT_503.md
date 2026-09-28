# 事故报告：全站租户不可用（2026-09-28 16:24 起）

> **级别：P0**（关键服务全不可用）｜**状态：截至 2026-09-28 16:45 未解除**｜**证据级别：生产只读**
> 本文件只含脱敏信息：不含数据库口令/完整连接串、token、API Key、`BACKUP_MASTER_KEY`、真实个人信息与未脱敏请求体。

## 1. 现象

| 观测点 | 结果（2026-09-28 16:38–16:45） |
| --- | --- |
| `GET /api/readyz` | **HTTP 503**（本地回环与公网一致），`status:"not-ready"` |
| `tenantSchema.status` | `CANNOT_CHECK`；`certification:"not-verified"` |
| `blockedSchools` | **`["zhsy","zhyz","tjb","test"]`（四校全部）** |
| `globalBlockers` | **`["MIGRATIONS_PENDING","CANNOT_CHECK"]`** |
| 受保护租户 API | **一律 503 `TENANT_MIGRATION_NOT_READY`**（实测 `/api/test-records`、`/api/user/me`、`/api/audit-logs/users`、`/api/records/exports`、`/api/school/backups`、`/api/session`，含伪造 Bearer） |
| `GET /api/health` | **200**（liveness 正常，`ready:false` 仅体现在 body） |
| 静态页面 / 平台超管路径 | 200（`/api/admin/**`、`/api/user/super-admin/**` 属显式豁免） |
| `node backend/sync-tenant-schemas.mjs --check` | **rc=1**（同日 16:12 时为 rc=0） |

**业务影响**：公网页面打开正常，但**四所学校的教师无法登录、无法录入或查询检测数据**（所有业务 API 均 503）。
**可观测性**：`/api/readyz` 正确返回 503，外部监控若以 readyz 为判据可发现；**若监控只看 `/api/health` 200 则会漏报**。

## 2. 时间线（CST）

| 时间 | 事件 | 证据 |
| --- | --- | --- |
| 15:40:44 | 服务启动（PID 1639588，`NRestarts=0`），加载当时的工作区代码 | systemd |
| 16:12 | R0 基线核验：`readyz` 200、`blockedSchools:[]`、`--check` rc=0 | R0 记录 |
| **16:24** | 工作区出现新迁移目录 `backend/prisma/migrations/20260928120000_friendly_links/`（另有 12 个已修改文件） | 目录 mtime、`git status` |
| ≤16:25 | 就绪门禁下一次 60s 复检判定 fail-closed | `readyz.checkedAt` 序列 |
| 16:34 | 同目录存在另一窗口活动（`git fetch`） | `.git/FETCH_HEAD` mtime |
| 16:35:47 | 首次观测到 503（`checkedAt=08:35:47Z`） | `/api/readyz` |
| 16:43:08 / 16:43:26 | 另一窗口 `merge --ff-only a1dda3f` 并提交 `caa2a93`（友情链接功能），工作区转为 clean | `git reflog` |
| 16:45 | 事故**仍未解除**（迁移未部署） | `/api/readyz` |

## 3. 根因

**直接原因（文件级，与数据库无关）**：新迁移文件 `20260928120000_friendly_links/migration.sql` 被放入**生产工作区**（即 systemd 服务的 `WorkingDirectory`），但**未执行** `prisma migrate deploy` / `npm run db:sync`。

**放大机制（关键）**：常驻服务在**运行期每 60s 从磁盘重新读取迁移链与 `schema.prisma`**（不是启动期快照）。因此：

1. 迁移链从 16 条变为 17 条 → 第 17 条在 public 台账中**未应用** → 全局阻断 `MIGRATIONS_PENDING`；
2. 该迁移的租户投影在**运行进程内存中的旧分类注册表**里没有登记 → `TENANT_PROJECTION_UNCLASSIFIED`（DO 块含 `pg_namespace` 等 catalog 引用而无显式分类）→ `CANNOT_CHECK`；
3. 两者叠加 → fail-closed → 四校全部阻断，**每 60s 复检、不会自愈**。

**对照实验（同一时刻、同一磁盘文件、不同代码版本）**：

| 执行者 | 代码来源 | 分类结果 |
| --- | --- | --- |
| 常驻服务（PID 1639588，15:40:44 启动） | **内存中的旧代码** | `TENANT_PROJECTION_UNCLASSIFIED` → `CANNOT_CHECK`（阻断） |
| `sync-tenant-schemas.mjs --check`（CLI） | **磁盘上的新工作区代码** | `scope=both skip=2 exec=2 20260928120000_friendly_links`（分类正常），仅剩 `MIGRATIONS_PENDING` |

## 4. 数据库侧证据（只读）

| 检查 | 结果 |
| --- | --- |
| `public._prisma_migrations` | `pending=0`，链尾仍为 `20260927140000_lifecycle_audit_principal_enforce` |
| `to_regclass('public."FriendlyLink"')` | **ABSENT** |
| `school_tjb."FriendlyLink"` / `school_test."FriendlyLink"` | **ABSENT** |
| 四校 `_tenant_migrations` | `applied=16/17 baselined=16 pending=1` |

结论：该迁移**在任何 schema 中都从未执行过**，数据未被改动。

## 5. 恢复选项（事故报告时均未执行）

- **方案 B（先恢复可用，不部署新功能）**：备份未提交改动 → 让工作区回到与运行代码一致的提交（`git restore .` + 移走未跟踪文件，**含迁移文件，且必须同时还原 `schema.prisma`**）→ 链恢复 16 条 → ≤60s 自愈，无需重启。
  - 注意：**只删迁移文件不足**，因为 `schema.prisma` 新增了 `FriendlyLink` 模型，契约表集合变化同样触发结构自证失败（日志已出现"结构漂移：缺表 1"）。
- **方案 A（把该功能上线）**：停服 → `cd backend && npx prisma migrate deploy` → `npm run db:sync` → `--check` rc=0 → `prisma generate` → `npm run build:prod` → 启动。
  - 注意：**必须先停服再落盘迁移文件**（见 SRV-122），否则窗口期内旧进程持续 fail-closed。
- 两条路都需先确认**没有其他窗口正在同目录操作**。

## 6. 由此暴露的代码/设计缺陷

### SRV-121（P0）就绪门禁在运行期实时读取可写工作区
- 证据：`backend/server.js:300-376`（门禁与豁免清单）、就绪判定每 60s 复检（日志"复检每 60s"）；`backend/lib/tenantSync.js` 读 `prisma/migrations/*` 计算链摘要。
- 后果：**在生产目录里"放入一个迁移文件"这一纯文件操作，可在 ≤60s 内造成全站租户 503 且不自愈**（"改文件即 DoS"）。
- 候选修复（择一或组合）：
  (a) 门禁改用**启动时冻结**的链摘要/结构指纹，仅在重启时重新判定；
  (b) 检测到"磁盘链 ≠ 启动时链"时**只告警不阻断**（仅对"已应用迁移的 checksum 不一致"这类真实数据风险 fail-closed）；
  (c) 强制流程：迁移文件只能经"停服 → 部署 → 启动"进入生产目录（增加 pre-deploy 检查）。

### SRV-122（P2）新迁移落盘必须伴随重启，但该顺序未被强制执行
- `TENANT_PROJECTION_UNCLASSIFIED` 的 fail-closed 依赖"迁移文件 + `tenantProvisioner.js` 分类注册表**同时**更新"，而运行进程持有旧注册表 → 新迁移落盘但未重启 = 全站阻断。
- 因此"**先停服再改文件**"是隐性强制顺序；`deploy/deploy.sh` 的 `migrate → sync → generate → build → restart` 顺序在中间窗口内同样会让旧进程 fail-closed。

## 7. 本轮（R5）在线核验结果

| 顺序 | 核验 | 结论 |
| --- | --- | --- |
| 0 | 版本一致 | R0 已证（运行=工作区=`83bce2a`）；**16:24 后失效**（工作区被改、进程未重启） |
| 1 | 存活 `/api/health` | PASS（200） |
| 2 | 就绪 `/api/readyz` | **FAIL**（HTTP 503 + 四校阻断，见上） |
| 3 | 迁移与审计门禁 | **FAIL**（`--check` rc=1） |
| 4 | 未认证边界 | **BLOCKED**：全局阻断优先于认证，返回 503 而非 401/403 → 无法证明"未认证不泄漏业务数据"，恢复后须重跑 |
| 5 | 已授权租户读 | **NOT_RUN**（无专用可审计账号；且 P0 期间结论不可信） |
| 6 | 外部 OpenAPI（只读） | 无异常：`OPENAPI_DENIED` 近 24h = 1（发生于升级冒烟 07:42Z）、累计 45；未触发任何真实调用 |
| 7 | 导出与备份元数据 | PASS（只读）：导出作业 2 个、产物权限 `0600`、路径位于 `.export-jobs/jobs` 下；备份日目录 `0700`；`BackupRun` 42 条全 `ok` + `verify_passed`，最近 07:57Z |
| 8 | 合成写读删 | NOT_RUN（本轮只读） |
| — | 额外 | `TENANT_READINESS_ATTESTED` 相关记录 0 条（确认未使用绕过通道） |

**方法学提示**：P0 期间"未认证边界"等负例探针会被全局阻断掩盖，**红灯与绿灯均不可信**，必须先恢复再核验。

## 8. 边界与声明

- 本事故与审查探针无关：探针全部为只读 GET，未写文件、未写库、未重启服务；迁移文件落盘时间（16:24）早于探针（16:36）。
- R0 的"运行代码 = 工作区 HEAD"结论在 16:24 之后**失效**，恢复后必须重新执行 R0 冻结基线。
