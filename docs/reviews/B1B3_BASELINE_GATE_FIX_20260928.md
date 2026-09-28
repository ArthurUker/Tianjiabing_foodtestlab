# B1–B3 修复与生产克隆演练报告（2026-09-28）

> 范围：修复生产升级阻塞 **B1/B2/B3**（租户离线基线接入通道），并在**重新创建的生产库完整克隆**上复演四校升级路径。
> 基线：`Product_tencent_CVM` = `2c64e9198ad3c7bb6b972781071901d5953b62b0`（开工前 `git ls-remote` 核对一致；工作副本为独立 clone，未触碰服务器运行目录 `/opt/foodsentinel`）。
> 受保护对象：`backend/prisma/migrations/**`（16 条，sha256 前缀见下）与 `backend/prisma/schema.prisma` 全程**字节未改**（`git status --porcelain backend/prisma/` 为空）。
> **推送代码 ≠ 生产部署批准**：本报告结束时状态为「B1–B3 已修复/验证，生产部署 HOLD」。

## 1. 缺陷与修复

### B1 —— 缺契约表时 `--baseline-plan` 崩溃（产不出计划）

- **根因**：`buildBaselineProof()`（`backend/lib/tenantProvisioner.js`）的数据语义扫描直接遍历参照侧（`public`）的 NOT NULL 列 / 外键 / 唯一索引并查询租户侧同名对象；租户缺少 `AuditPrincipal` 等表时抛 PG `42P01`，证明函数整体抛出 → CLI 无法写出计划文件。
- **修复**：
  - 新增 `tables.contract.present` 检查（缺失契约表 → 显式不通过）；
  - NOT NULL / 外键扫描在**表或列不存在时不再发起查询**，改记 `未扫描/未证明`；
  - 未扫描项一并计入 `data.semantics=false`（**跳过扫描绝不等于通过**）；
  - `data.semantics` 段落整体加 try/catch：任何扫描异常记为「未证明」（fail-closed），保证**计划始终可产出**；
  - 保持不变：证明全程只读（仅 `SELECT`）、不建表、不写台账。

### B2 —— 提示把 schema 名当作 CLI 参数

- **根因**：`TENANT_MIGRATION_STATE_UNPROVABLE` 提示里写 `--baseline-plan ${schema}`（如 `school_zhsy`），而 CLI 用裸字符串拼接派生 schema → 形成 `school_school_zhsy` 后失败。
- **修复**：
  - fail-closed 提示改用**经校验的 `School.code`**（`baselineAdmissionGuidance()`，由 `provisionSchool` 传入 code；`alignTenantSchema` 的 staging 场景不带 code）；
  - 新增 `interpretBaselineTargetArg()` / `resolveBaselineSchoolTarget()`：`--baseline-plan` 与 `--baseline-apply` 都校验 **参数 → `School.code` → 派生 schema** 三者一致；
  - `school_<code>`（schema 形态）**明确拒绝**并给出正确示例；恢复流程的临时 staging schema（`*_stg_*` / `*_restore`）不给出无法执行的正式学校命令，改为提示「先修复可复用的源 schema 或使用新备份重建」；
  - `--baseline-apply` 增设计划门禁：`proofOk !== true`、缺 `proofDigest`、或**现场重算摘要与计划不一致（过期/漂移）**一律拒绝，且拒绝发生在取锁与写台账之前。

### B3 —— 唯一索引数据扫描把 NULL 误报为重复

- **根因**：旧实现对唯一索引做 `GROUP BY <列> HAVING count(*)>1`，把 nullable 列的**多个 NULL 分成一组**；而 PostgreSQL 唯一索引默认 `NULLS DISTINCT`，NULL 之间不冲突。生产四校 `User.email` 全为 NULL（zhsy 4/4、zhyz 2/2、tjb 2/2、test 3/3）→ 证明永远无法通过。
- **修复**：改为按**目录事实**（`pg_get_indexdef(indexrelid, k, false)` 键表达式 / `pg_get_expr(indpred)` 谓词 / `indnullsnotdistinct`）构造检查：
  - 默认 `NULLS DISTINCT`：**任一键列为 NULL 的组不报重复**（单列与复合键统一处理）；
  - `NULLS NOT DISTINCT`（PG15+，低版本以常量 `false` 代替该列，避免引用不存在的列）：NULL 视为相等，纳入检查；
  - 部分索引：按谓词限定范围；表达式索引：按键表达式检查（旧实现静默跳过）；
  - 新增 `indexes.valid`：`indisvalid/indisready` 任一为假 → 不通过（无效索引不维护唯一性，且其唯一性检查不得计入通过）；
  - 键表达式不可读、扫描抛错 → 记「未证明」（fail-closed）。

## 2. 新登记缺陷 B4（**不属本次修复范围**）

- **现象**：`20260726100000_add_customization_columns_if_missing` 中 FieldOption 自引用外键的守卫
  `IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='FieldOption_parent_option_id_fkey')` **未限定 schema**；
  只要**任一其它 schema**（先建的租户 schema 或 public）已有同名约束，**后建的 schema 会静默跳过创建该外键**。
  上游 `20260927120000_public_infra_field_option_self_fk` 只对 **public 侧**做了前向修复。
- **证据**：集成测试夹具中先建 `public`（链末）再建探针 schema（链前缀）时，探针 schema 稳定缺失该外键（测试运行时打印
  `[fixture] school_b3probe: 缺 FieldOption 自引用外键（链内跨 schema 守卫缺陷 B4）`）。
- **影响面**：不影响本次四校升级（生产四校由历史 db push 建表，均已含该外键，证明结构检查通过）；
  但**影响新建学校**——新校按链回放时该外键可能被跳过，随后 `compareTenantStructureToPublic` 结构自证 fail-closed。
- **未修复原因**：修复需改动既有 migration 文件或新增链尾迁移，与本任务「保持既有 migration 字节不变」的约束冲突。
  建议单独立项（不改历史文件，追加链尾承接迁移或在租户回放前做 schema 限定的守卫）。

## 3. 生产克隆演练（四校全路径）

- **方法**：`pg_dump` 全量克隆生产库（库仅 18MB）为一次性实例 `fs_upgrade_rehearsal_20260928`；
  在**独立工作副本**中执行；演练结束已 `dropdb`。
  **未复用任何历史已修好的克隆**，每次演练均从生产库重新克隆。
- **演练前**：`public` 10 条迁移、四校无 `_tenant_migrations` 台账（与生产一致）。

| 步骤 | 命令 | 结果 |
|---|---|---|
| B) public 迁移 | `prisma migrate deploy` | 6 条全部应用成功 |
| C) 旧结构失败计划（B1） | `--baseline-plan <code>` ×4 | **rc=1 / proofOk=false**（`tables.contract.present=false`、`data.semantics=false`），**计划文件已产出**，各校 `ledger=0`（零写入） |
| D) 人工修复 | M1/M2 租户投影回放（引擎自带 `buildTenantProjection` 生成）×4 | 4/4 OK |
| E) 证明 + 台账 | `--baseline-plan` + `--baseline-apply` ×4 | plan_rc=0 / apply_rc=0，台账 **16/16**（status=baselined） |
| F) 租户同步 | `db:sync` | 4/4 对齐，无失败项 |
| G) 只读复核 | `--check` | rc=0，四校 `OK … applied=16/16 baselined=16` |
| H) 审计门禁 | `006_audit_principal_gate.mjs` | rc=0，`GATE_PASS：全租户 4 个均满足 G2/G7/G8/G3` |

**数据摘要前后对照（演练前 → 演练后，逐字节一致）**

| 学校 | TestRecord 条数 | record_code 集合 md5 |
|---|---|---|
| school_zhsy | 40 | `c87efda7d8f5cf0860e4e58611b4fb77` |
| school_zhyz | 56 | `c58a386b253401059c7000c025281696` |
| school_tjb | 1174 | `5ad02182f31845831cc949f433a61fb3` |
| school_test | 5 | `8e01e0d1695533d3336d38259e71653c` |

**B2 现场证据（演练库）**

- 反例 `--baseline-plan school_zhsy` → rc=1：`"school_zhsy" 是 schema 名（school_<code>），不是学校代码（School.code）`，
  并提示正确写法 `--baseline-plan zhsy`；**未生成计划文件**。
- 反例 `--baseline-plan zhsy_stg_ab12` → rc=1：staging schema 指引（先修复可复用源/新备份）。
- 正例 `--baseline-plan zhsy` → 寻址 `school_zhsy`，证明通过。
- 引擎侧 fail-closed 提示已使用 code：`… --baseline-plan test …` / `… --baseline-apply test --evidence <plan.json> …`。

## 4. 验证命令与结果（rc / 用例数 / skip / 清理）

| 命令 | rc | 用例 | skip | 备注 |
|---|---|---|---|---|
| `node --test backend/tests/tenant-sync/`（含既有 4 个用例文件 + 新增 2 个）| 0 | 42 pass / 0 fail | **0** | 连跑两次均 42/42（集成测试可重复运行） |
| `node --test backend/tests/lifecycle/r13-release-gate.test.mjs` | 0 | 7 pass / 0 fail | 0 | 引用被改模块的发布门禁用例 |
| `node tests/runners/audit-entry-coverage.mjs` | 0 | checks=24 failed=0 | - | `ENTRY_COVERAGE_OK`；新增用例已被 backend 递归枚举收录（48 文件） |
| `prisma validate --schema backend/prisma/schema.prisma` | 0 | - | - | `The schema … is valid`（需提供 `DATABASE_URL` 环境变量，Prisma 5.22.0） |
| `git diff --check` | 0 | - | - | 无空白/冲突标记问题 |
| `git status --porcelain backend/prisma/` | 0 | - | - | 空：migration / schema.prisma **未被改动** |

- **新增测试**（均为定点判别用例，无 skip）：
  - `backend/tests/tenant-sync/b1b2b3-baseline-guards.unit.test.mjs`（离线 12 例）：缺表不查询缺失对象且显式不通过、完整 schema 不退化、
    NULLS DISTINCT/NOT DISTINCT、复合键、部分索引、表达式索引、无效索引、键表达式不可读、PG14 版本自适应、code/schema 正反例、staging 指引。
  - `backend/tests/tenant-sync/b1b3-baseline-proof.integration.test.mjs`（真实隔离 PG 1 例，fail-closed 门禁：库名须以 `_baseline_proof_test` 结尾）：
    旧结构失败计划 + 零写入、修复后证明通过 + 多行 NULL 不误报、`proofOk=false` 与**过期计划**均拒绝 `--baseline-apply` 且零台账写入。
    运行方式见文件头注释；本轮验证后隔离库已删除。
- **实例清理**：`fs_baseline_proof_test`、`fs_upgrade_rehearsal_20260928` 均已 `dropdb`；/tmp 临时文件无残留。
- **既有失败（非本次引入，如实登记）**：`backend/tests/security/startup-jwt-guard.test.mjs` 在**未改动的基线 `2c64e91` 上同样 0 pass / 10 fail**
  （已用 pristine clone 复现），属该用例自身的环境依赖问题，与本轮改动无关。

## 5. 未覆盖 / 遗留

- **生产部署仍为 HOLD**：未运行生产 `deploy.sh`、未重启服务、未修改生产授权与生产运行目录。
- **外部 OpenAPI 调用方需另行协调**：4 条 `OpenApiGrant` 已交付外部/正在调用，升级后 `school_id/school_generation` 为 NULL 的历史 grant
  会 fail-closed 并被就地隔离，需先与调用方约定窗口、重新授权并做 checkpoint 对齐。
- **两段发布接线未完成**：`b-release-two-phase.sh`（b1/b2/rollback-client）与生产适配文件 / systemd 的接线未在本任务验证。
- **生产备份与停服窗口未安排**：迁移窗口须停服（M1 的 CHECK NOT NULL 拦新写入），且 M2 `SET NOT NULL` 后**不可逆**（回退只能向前修复）。
- **B4**（跨 schema FK 守卫）已登记，未修复（见 §2）。
