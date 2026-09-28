# R6 深入复证 · 第 1 轮报告（2026-09-28）

> 计划依据：`R6_DEEP_VERIFICATION_PLAN.md`（提交 `2eef9cb`）｜执行时间：**16:53–16:58 CST**
> 本轮**未修产品代码、未在生产迁移/恢复/故障注入、未在生产目录落盘迁移或 schema**。原始日志保留在仓库外（`/tmp/r6_*.txt`），本文件仅脱敏摘要。
> **历史证据不继承**：`R0/R1–R4/INCIDENT/FINDINGS` 中的 PASS 与严重度均被重新审验，本轮给出独立结论。

## 0. 结论速览

| 项 | 本轮结论 | 证据级别 |
| --- | --- | --- |
| A 线上基线可冻结 | **PASS**（`--check` rc=0、006 rc=0、`readyz` 200） | 生产只读 |
| 事故"未恢复/已恢复"两段状态 | **已澄清**（见 §1.3） | 生产只读 |
| B · SRV-121/122 机制 | **复现成功**（隔离服务目录+克隆库，逐字复现事故三项特征） | 隔离 PG |
| C · SRV-114 | **复现成功（含破坏性后果）** | 隔离 PG + 真实脚本执行 |
| C · SRV-108 | **部分复证 → 降级 P3**；新登记 SRV-137（唯一索引上限） **P2/待构造反例** | 静态 + 隔离只读计数 |
| C · SRV-111 / SRV-110 / SRV-106 | **NOT_RUN**（原因见 §3.4） | — |

## 1. A 段 · 重新冻结线上基线

### 1.1 事实表（2026-09-28 16:53–16:57 CST）

| 项 | 实测 |
| --- | --- |
| 进程 / 启动 / cwd | PID **1673914** · 16:45:51 CST · `/opt/foodsentinel/backend`（`/proc/1673914/cwd`）· exe `/opt/node-v20.20.2/bin/node` |
| 工作区 HEAD / 分支 | `0e66f0f` · `Product_tencent_CVM` · `git status` **clean** |
| 远端 `Product_tencent_CVM` | **`2eef9cb`**（领先工作区 1 个**纯文档**提交：新增 `R6_DEEP_VERIFICATION_PLAN.md`） |
| 其他窗口活动 | **有**：`.git/FETCH_HEAD` mtime **16:52:55**；远端 16:52 后新增 `2eef9cb`；启动后（16:45:51 起）仓库内被改动的文件仅 `FINDINGS.md`（= 本审查自己的提交） |
| 运行代码 = 工作区？ | **可证一致**：启动后 `backend/` 无源码文件被改写；`dist` 构建于 16:45:41（早于启动 16:45:51） |
| 迁移链 | **17 个文件**，摘要 `0606fb2bc2c07acb`；链尾 `20260928120000_friendly_links` |
| public 台账 | 17/17 applied，0 pending |
| 四校台账 | 各 `applied=17/17 baselined=16`，链尾 `20260928120000_friendly_links` |
| `db:sync --check` | **rc=0**（16:53:24）· `TENANT_SCHEMA_CHECK=OK schools=4 expectedTables=23 chain=0606fb2bc2c0` |
| `006_audit_principal_gate` | **rc=0**（16:53）· `GATE_PASS`，4 租户全 `ok:true` |
| `GET /api/health` | **200**（`ready:true`，`tenantSchema.status=OK`，`blockedSchools=[]`） |
| `GET /api/readyz` | **200**（本地与公网同）；`status:"ready"`、`certification:"verified"`、`blockedSchools:[]`、`globalBlockers:[]`、`checkedAt=08:52:54Z` |

### 1.2 关于"其他窗口"

按计划"开始前确认是否有其他窗口正在编辑或部署同一生产工作区；如有，停止克隆以外的线上探针并报告"：
**判定为"有"**（16:52:55 fetch + 16:52 远端新提交）。因此在 A 段要求的两条只读门禁与三个 HTTP 探针**之后**，本轮**未再新增任何线上动态探针**；B/C 全部转入隔离环境。A 段也未在生产制造任何 blocked 学校、未删 schema、未改授权。

### 1.3 事故两段状态必须分开写

- `INCIDENT_20260928_TENANT_503.md` 记录的 **"截至 16:45 未恢复"** 是**当时的事实**（16:45 时 `readyz` 仍 503）。
- **16:45:51 服务重启后恢复**；本轮独立复核：**`readyz` 200 + 两门禁 rc=0** 持续成立（非沿用旧绿灯）。
- 即：事故持续约 **16:25 → 16:45:54**（≈20 分钟），由"部署新代码 + 完成 public/租户迁移"解除。

## 2. B 段 · SRV-121/122 独立复核

### 2.1 静态调用链：哪些来自内存、哪些运行期读盘

| 值 | 来源 | 位置 |
| --- | --- | --- |
| 就绪复检周期（默认 60s）与模式 | 环境变量 + 模块常量 | `backend/server.js:515-518` |
| 首轮检测（listen 前）+ 周期性 `refreshTenantReadiness()` | 运行期调用 | `server.js:596`、`:527`、`:550`（`syncAllTenantSchemas(mode:'check')`） |
| 迁移**文件清单与内容摘要** | **运行期读磁盘**（`fs.readFileSync`） | `backend/lib/tenantProvisioner.js:199-204`（`chainManifest`）、`:207-211`（`migrationChainDigest`） |
| 契约表集合 | **运行期读磁盘**（`backend/prisma/schema.prisma`） | `tenantProvisioner.js:217-231`（`readExpectedTenantTables`） |
| **迁移语句分类注册表** | **模块级 `Object.freeze` 常量 = 进程启动时冻结在内存** | `tenantProvisioner.js:284-308`（`TENANT_MIGRATION_REGISTRY`） |
| catalog 引用判据 / 未命中时的分类路径 | 内存常量 + 磁盘语句文本 | `:326`（`CATALOG_RE`）、`:364`（`reg = REGISTRY[name] \|\| null`）、`:418`（UNCLASSIFIED 抛错） |

**推论（本轮已验证）**：新增迁移文件 → 磁盘链变化**立即**被周期复检看到；而分类注册表**只能随进程重启更新** → 旧进程必然对未知迁移报 `TENANT_PROJECTION_UNCLASSIFIED` → fail-closed。

### 2.2 隔离复现（未在生产重演）

**环境**：克隆库 `fs_r6_verify`（`pg_dump --schema-only` 生产结构，**零业务数据**）；两份独立代码目录 `/mnt/datadisk0/fs-r6-verify/repo-old`（= `83bce2a`，注册表 **11** 条）与 `repo-new`（= `0e66f0f`，注册表 **12** 条）；两者 `node_modules` 为只读软链；`repo-old` 额外复制了**新的** `schema.prisma` 与 `20260928120000_friendly_links/`（复刻"旧进程 + 新磁盘"）。两份 `.env` 均指向克隆库，端口 3102 / 3103。

| 执行者 | 代码 | 磁盘链 | 库 | 结果 |
| --- | --- | --- | --- | --- |
| CLI（旧） | `83bce2a` | 17 文件 `0606fb2bc2c07acb` | 克隆库 | **rc=1**；`TENANT_PROJECTION_UNCLASSIFIED：20260928120000_friendly_links … pg_namespace`；`globalBlockers=[MIGRATIONS_PENDING, CANNOT_CHECK]` |
| CLI（新） | `0e66f0f` | **同一磁盘链** | **同一库** | **rc=1**；**无 UNCLASSIFIED**；`globalBlockers=[MIGRATIONS_PENDING]` |
| 服务（旧，:3102） | `83bce2a` | 同上 | 同上 | `readyz` **503**、`status:CANNOT_CHECK`、`globalBlockers=[MIGRATIONS_PENDING, CANNOT_CHECK]`；租户 API **503 `TENANT_MIGRATION_NOT_READY`**；`/api/health` **200** |
| 服务（新，:3103） | `0e66f0f` | 同上 | 同上 | `readyz` **503**、`status:MIGRATIONS_PENDING`、`globalBlockers=[MIGRATIONS_PENDING]`（**CANNOT_CHECK 消失**）；租户 API **503**；`/api/health` **200** |

**唯一变量 = 代码版本（内存注册表内容）**。旧服务四项特征与生产事故**逐字一致**（503 / `[MIGRATIONS_PENDING, CANNOT_CHECK]` / 租户 API 503 / health 200）。新代码重启后 `CANNOT_CHECK` 即刻消失，与生产 16:45:51 重启后转为 200 的观测一致。

### 2.3 现有发布脚本的实际顺序与可执行性（静态）

| 检查 | 结果 |
| --- | --- |
| `backend/scripts/b-release-two-phase.sh:38` | `cd "$REPO_ROOT"`（仓库根） |
| `:58` | `run npx prisma migrate deploy` —— 仓库根**无 `prisma/` 目录、无 `prisma` 键**，CLI 仅装在 `backend/node_modules` → **必然失败** |
| `:49-50`（`gate_pass`） | 直接执行 `006_audit_principal_gate.mjs`，该脚本只读 `process.env.DATABASE_URL`，而本脚本**从不加载 `backend/.env`** → 即便迁移成功也以 **rc=2** 中止 |
| `deploy/deploy.sh:560,564,632` | 正确 `cd "$REPO_ROOT/backend"` 后再 `npx prisma generate` / `migrate deploy` |
| 结论 | 两段发布入口 **b1 段当前不可执行**（静态可判；**沙盒实跑 NOT_RUN**） |

### 2.4 修复方案比较（每项均说明 fail-closed 行为）

| 方案 | 机制 | 真实 pending/failed 时 | 评价 |
| --- | --- | --- | --- |
| **① 不可变发布目录 + 原子切换**（如 `releases/<sha>` + 符号链接切换，停服或切流量后切换） | 运行中的进程与其迁移清单、schema.prisma 绑定在同一不可变快照；工作区/开发目录与运行目录物理隔离 | 新版本启动后仍按同一冻结清单判定：`pending`/`failed`/`checksum 不一致` → 继续 `MIGRATIONS_PENDING` / `CANNOT_CHECK` / `MIGRATION_REGISTRY_CHECKSUM_MISMATCH` → 503。**天然 fail-closed，且开发动作无法影响运行实例** | **推荐**：从根因消除"改文件即影响线上"；代价是发布流程改造 + 磁盘占用 |
| **② 部署脚本强制前置状态与停止条件**（部署前校验 cwd、Prisma schema 位置、env 加载、`generate`→`migrate`→`sync`→门禁→`build`→`restart` 顺序，任一步非 0 即中止） | 不改运行时语义，只保证"迁移文件进入生产目录"必然发生在一个受控事务内（且必然伴随重启） | 顺序被强制后，"旧进程 + 新迁移文件"窗口消失；真实 pending/failed 仍由门禁 fail-closed | **应做**：成本低；但只是流程约束，仍依赖人/脚本不绕过（如手工 `git pull`） |
| **③ 启动期冻结清单**（门禁只依据进程启动时读取的链摘要/契约集合，运行期不再读盘） | 运行期读盘改为启动时一次性快照 | 启动时若 pending/failed → 保持 503 直到重启并完成迁移；启动后磁盘变化不再影响运行实例 | **可作为①的部分替代**：最小改动即可消除"改文件即 DoS"；但会牺牲"修复后 60s 自动放开"的便利（需重启才恢复） |
| ~~④ 磁盘链变化时仅告警、继续放流量~~ | — | **会掩盖真实的未迁移数据库**（fail-open） | **明确不采纳**（与计划一致） |

**取舍建议**：先做 **②（低成本、立即消除误操作窗口）**，同步推进 **①（结构上根治）**；**③** 可作为①落地前的过渡（若接受"恢复需重启"）。任何方案都必须保留：真实 `pending` / `failed` / `checksum 不一致` / 结构漂移 / 额外对象 → 继续 fail-closed。

## 3. C 段 · 五项高风险复证

### 3.1 SRV-114（清理脚本误删在用 schema）— ✅ 复现（含破坏性后果）

- **构造**：克隆库插入**在用**合成学校 `School(code='xsyn-old-2', status='active')` + schema `school_xsyn_old_2`（含 1 行标记数据）；另有真实备份点 `school_test_old_1790583051717` 作对照。
- **代码位置**：`backend/scripts/005_cleanup-old-schemas.mjs:25`（`^school_[a-z0-9_]+_old_[0-9]+$`）+ `backend/lib/tenantClient.js:70`（`schemaNameOf` 把 `-`→`_`）。
- **正例**：真实备份点被正确列为可删。
- **反例（区分缺陷）**：`--all --dry-run` 输出 `🗑  school_xsyn_old_2  (48 kB)` —— **在用 schema 被判为"可回滚备份点"**。
- **破坏性验证（仅克隆库）**：`echo yes | node scripts/005_cleanup-old-schemas.mjs --all --execute` → **rc=0**、日志 `DROP SCHEMA school_xsyn_old_2 CASCADE ... 完成：已删除 1 个备份点 schema`；复核 `live_schema_alive=false | school_row=1` ⇒ **在用学校的数据被物理删除，而 `public."School"` 注册行仍存活**（该校随后将因缺表而失败，数据不可恢复）。
- **可达性**：要求存在校码形如 `*[-]old[-]<数字>`（`isValidSchoolCode` 允许 `[a-z0-9-]`）。生产当前四校不匹配 → **当前不可达**；一旦新建此类学校即触发。
- **严重度**：维持 **P1**（潜在数据销毁；触发条件明确、后果不可逆）。
- **修复方向**：判定改为"`_old_` + 纯数字 epoch + 该 schema **未在** `public."School"`/恢复台账登记"三重条件；近 24h 备份点强制保留；`--execute` 前打印并核对 School 归属。

### 3.2 SRV-108（baseline 证明扫描上限）— ⚠️ 部分复证，**降级 P3**，并拆出新发现

- **实测（隔离库探针，复刻 `buildBaselineProof` 的参考列加载）**：`refCols=263`、**`notNullCols=160`**、上限 60 → **100 个参考 NOT NULL 列从未被扫描**（`tenantProvisioner.js:1302` `slice(0, 60)`；截断余量**不进入** `notProven`，`:1357-1360`）。
- **但无法构造"错误通过"**：`push('columns.type.nullable.default', …)`（`:1220-1221`）比较 `colKey`（**含 `is_nullable`**）且**无上限**——租户列若为可空以承载 NULL，该检查必然先不通过。⇒ **NOT NULL 截断的实际影响被结构检查①涵盖**，本轮**不能证实**其可导致 proof 误判。故 `R1_R4_STATIC_REVIEW` 中对其的 P2 定级**下调为 P3（潜在）**。
- **FK 上限 40**：实测 public `fks=13` → **未触发**。
- **🆕 SRV-137（P2，新登记）唯一索引扫描上限 40 < 实际 43**：`tenantProvisioner.js:1335` `uniqIdx.slice(0, 40)`；实测 public **唯一索引 = 43** → **至少 3 个唯一索引永不被重复值检查**，且重复值可**不伴随任何结构漂移**（`colKey`/约束/索引定义均一致）→ 存在**可构造的"错误通过"**。本轮**未构造该反例（NOT_RUN）**，下一轮优先补做（步骤见 §4.4）。
- 说明：上述计数取自**克隆库**（结构与生产同源），生产侧同口径取数 **NOT_RUN**。

### 3.3 隔离环境保真度备注

克隆目录运行 `buildBaselineProof` 时出现 `EACCES: /opt/foodsentinel/backend/.env`（被拒读）——说明库内某路径**硬引用了生产 .env**。本轮未定位到具体代码行（grep 未命中常见模式）→ 记为**观察项 / NOT_RUN**；若该路径在生产外的副本中可读，隔离实例可能误连生产库，建议下一轮定位。

### 3.4 SRV-111 / SRV-110 / SRV-106 — **NOT_RUN**（明确未执行，不算通过）

| ID | 未执行原因 | 下一轮可执行方案 |
| --- | --- | --- |
| SRV-111 | 需要"启动隔离服务 + 合成学校管理员登录 + 学校侧备份列表接口"三件套；A 段判定另一窗口活跃后，本轮把预算投入 B/SRV-114/SRV-108，克隆库已在收尾时销毁 | 重建克隆库 + 两台隔离服务；插入两所合成学校与 `scope='all'` 的 `BackupRun`（`table_counts` 键为 `schema.table`）；以合成管理员 `GET /api/school/backups`，只比较**其他校 schema/表名/行数**是否出现（不记录业务数据） |
| SRV-110 | 需在克隆库**制造单校 blocked**（结构漂移）+ 该校有效 token + `body.schoolCode` 指向健康校；制造 blocked 状态与签发 token 均需完整隔离栈 | 克隆库中对 `school_synA` 的某列做漂移 → 该校进 `blockedSchools`；以 A 校 token + `{"schoolCode":"synB"}` 请求 `/api/records/...`，比较闸门返回与最终路由归属 |
| SRV-106 | 需合成用户 + 会话行 + 心跳链路（`POST /api/session` 与 `DELETE /api/session/others`） | 克隆库建合成用户；登录 → `POST /api/session` 建会话 → `DELETE /others` → 再心跳 → 检查该会话是否回到 `active` 且旧 token 仍可用 |

## 4. D 段 · 状态变更、剩余候选与下一轮

### 4.1 状态变更（相对首轮）

| ID | 首轮 | 本轮 | 依据 |
| --- | --- | --- | --- |
| SRV-121 | P0（静态+生产只读推断） | **P0（已复现）** | §2.2 隔离复现，四项特征逐字一致 |
| SRV-122 | P2（静态） | **P2（已复现）** | 同上 + §2.3 脚本静态审查 |
| SRV-114 | P1（静态） | **P1（已复现，含破坏性后果）** | §3.1 |
| SRV-108 | P2 | **↓ P3（部分复证，无法构造误判）** | §3.2 |
| SRV-137 | — | **🆕 P2（唯一索引上限 40 < 43；反例 NOT_RUN）** | §3.2 |
| SRV-111 / 110 / 106 | P1 / P2 / P2（均静态） | **维持原级但状态=NOT_RUN（未复证）** | §3.4 |
| R0 五项（SRV-R0-001…005） | 见首轮 | 未重测 → 维持 OPEN | — |

### 4.2 其余待验证候选（13 条，本轮未复核）

`SRV-124`（拒绝日志含 query）· `SRV-125`（游标未签名/校验短路）· `SRV-126`（进程内限流）· `SRV-127`（导出统计口径分叉）· `SRV-128`（幂等 store 全局 429）· `SRV-129`（`information_schema` 探测）· `SRV-130`（`004 --schema` 未白名单）· `SRV-131`（`TENANT_ALIGN_ACCEPT_DESTRUCTIVE` 无消费方）· `SRV-132`（`rewriteSchemaNames` 全局替换）· `SRV-133`（ACL 基线不含属主）· `SRV-134`（drain 依赖 query 文本）· `SRV-135`（`seed.js` 无校验）· `SRV-136`（admin 降级日志不输出）。
**均保持 OPEN，不得视为 CLOSED。**

### 4.3 事故后尚未重做的线上缺口

- **未认证边界（ONLINE_CHECKS 项 4）**：事故期间被 503 掩盖；本轮未重做（另一窗口活跃）→ **NOT_RUN**。
- **已授权业务读（项 5）**：需专用可审计账号 → **NOT_RUN**。
- **外部 OpenAPI 授权现状（只读元数据，未改授权、未向合作方发请求）**：

| school | status | scope_version | school_id 已绑定 | generation |
| --- | --- | --- | --- | --- |
| test | active | 3 | 是 | 1 |
| tjb | disabled | 2 | 是 | 1 |
| zhsy | disabled | 1 | 是 | 1 |
| zhyz | disabled | 1 | 是 | 1 |

与 R0 一致（1 client / 1 credential / 4 grants）。⚠️ `test` 的 `scope_version=3`：外部调用方首次增量同步仍预期收 `409 SCOPE_CHANGED`，需协调窗口对齐游标。

### 4.4 下一轮最小修复顺序与验收条件

| 顺序 | 项 | 修复要点 | 验收条件 |
| --- | --- | --- | --- |
| 1 | **SRV-121/122** | 先落 ②（发布脚本前置校验+停止条件：cwd、Prisma schema 位置、env 加载、`generate`→`migrate`→`sync`→门禁→`build`→`restart`，任一步非 0 中止），再推 ①（不可变发布目录+原子切换） | 在克隆/隔离服务目录复现"旧进程 + 新迁移"时**不再影响运行实例**；真实 `pending`/`failed`/`checksum 不一致` 仍返回 503；发布脚本 b1/b2 在沙盒中 rc=0 且失败即中止 |
| 2 | **SRV-111** | 学校侧备份列表按 `school_<code>` + `public` 过滤 `table_counts` | 合成两校 + 全库备份：A 校管理员响应中**不出现** B 校 schema/表/行数 |
| 3 | **SRV-114** | 三重条件判定（`_old_<epoch ms>` + 未在 `School`/台账登记 + 保留窗口） | 合成在用校 `xsyn-old-2` 不再进入待删清单；真实备份点仍可清理 |
| 4 | **SRV-137** | 去掉唯一索引/FK 扫描上限（或截断即记 `notProven` = 不通过） | 在第 41 个及之后的唯一索引上构造重复值 → proof **必须** `ok=false` |
| 5 | **SRV-108** | 与 SRV-137 合并处理 | 截断余量计入 `notProven`；现有四校 `--baseline-plan` 仍 `proofOk=true`（不误伤） |
| 6 | **SRV-110 / SRV-106** | 按 §3.4 方案在克隆库先复现再修 | 闸门归属以 JWT 为准；已撤销会话心跳后**不得**回到 `active` |
| 7 | **SRV-101/102/103/104/105** | 下一轮逐条以最小反例确认后修复 | 每项保留修复前后反例、rc 与测试执行数（0 skip） |

### 4.5 证据级别与统计口径

- 本轮证据级别分布：**生产只读**（A 段门禁/HTTP/OpenAPI 元数据）· **隔离 PG + 真实脚本执行**（B/C-114）· **静态 + 隔离只读计数**（C-108）· **静态**（§2.3）。
- 未执行项一律 **NOT_RUN**，不因"静态看起来成立"计为通过。
- 隔离环境已清理：克隆库 `fs_r6_verify` 已 drop；两份隔离代码目录已删除；3102/3103 无监听；生产服务 PID 1673914 未重启、`readyz` 200、工作区 0 处改动。另发现 PID 2117254 为**无关既有服务**（`/mnt/datadisk0/foodsafety-outreach`，9 月 8 日起，仅监听 127.0.0.1:3100），非本轮残留。
- **脱敏**：本文件不含数据库口令/连接串、token、API Key、`BACKUP_MASTER_KEY`、真实个人信息与未脱敏请求体；原始日志（`/tmp/r6_*.txt`）留仓库外。
