# 迁移失败处置手册（MIGRATION_FAILURE_RUNBOOK）

> **适用范围**：`deploy.sh` 第 6 节「后端依赖 / Prisma / Seed」中 `prisma migrate deploy` 失败（public 库）。
> **配套实现**：`deploy/deploy.sh` 的迁移段（P3-W2-T01-R2）。失败一律 **非零停止并保留现场**；
> 脚本只做**只读诊断**（`deploy_diagnose_migration_state`），随后 `fail`。本手册是**人工**处置入口。
> **上位约束**：Phase 2 `RC-04 — migration-first schema evolution`（failed 状态仅在检查实际部分执行结果后按受控 runbook resolve；不得自动删 migration 历史或失败后盲退 db push）。

## 0. 铁律（先读）

1. **先只读诊断 + 备份，再动手**：任何写操作前先 `pg_dump` 备份当前库。
2. deploy.sh 在失败时**已经做的事**：打印原始 stdout/stderr、打印只读诊断、`fail` 非零退出。
   **没有做**（也永远不允许自动做）的事：
   - `prisma migrate resolve --rolled-back` / `--applied`；
   - 删除/清理 `_prisma_migrations` 记录；
   - `prisma db push`（任何形态）；`--accept-data-loss`。
3. **「public.User 不存在」≠ 数据库为空 ≠ 可以回退/重建**。既有库可能未登记迁移链（P3005），也可能只有部分结构。
4. **部分执行必须人工核实**：failed 记录 `applied_steps_count > 0`，或人工核实到残留对象/数据时，
   先确认其实际效果，再决定「向前修复」或「回滚后重放」；两者都是人工动作。
5. 结构演进唯一入口 = migration（RC-04）。修复根因后**重跑部署**（迁移段会重新执行），不得旁路跳过。

## 1. 只读诊断（复制即用）

以下命令均**只读**。连接参数与 deploy.sh 使用的适配文件一致（`PG_HOST/PG_PORT/PG_USER/PGPASSWORD/PG_DB_NAME`）。

```bash
# ① 迁移历史是否存在、各类记录计数
psql -h "$PG_HOST" -p "$PG_PORT" -U "$PG_USER" -d "$PG_DB_NAME" -c \
  "SELECT count(*) AS total,
          count(*) FILTER (WHERE finished_at IS NOT NULL AND rolled_back_at IS NULL) AS applied,
          count(*) FILTER (WHERE finished_at IS NULL AND rolled_back_at IS NULL) AS failed,
          count(*) FILTER (WHERE rolled_back_at IS NOT NULL) AS rolled_back
     FROM _prisma_migrations;"   # 表不存在 → 报错 "relation does not exist" = 无迁移历史（见场景 A/B）

# ② failed 记录明细（含已执行步数；>0 即可能部分执行）
psql ... -c "SELECT migration_name, started_at, applied_steps_count, left(logs, 500)
               FROM _prisma_migrations
              WHERE finished_at IS NULL AND rolled_back_at IS NULL ORDER BY started_at;"

# ③ 最后完成的一条迁移
psql ... -c "SELECT migration_name, finished_at FROM _prisma_migrations
              WHERE finished_at IS NOT NULL AND rolled_back_at IS NULL
              ORDER BY finished_at DESC LIMIT 1;"

# ④ public 结构概览（表数 / 是否存在 User）
psql ... -c "SELECT count(*) AS tables FROM pg_tables WHERE schemaname='public';"
psql ... -c "SELECT count(*) AS has_user FROM pg_tables WHERE schemaname='public' AND tablename='User';"

# ⑤ Prisma 侧只读状态（需 backend/.env 指向同一库；只读）
cd backend && npx prisma migrate status
```

## 2. 场景判定表

| 诊断观察 | 场景 | 处置 | 允许的人工命令（先核实） |
|---|---|---|---|
| 无 `_prisma_migrations`，public 无任何表 | **A 全新空库** | 修根因后重跑部署 | 无（**禁止** `db push`） |
| 无 `_prisma_migrations`，public 有表 | **B 既有库未接入（疑似 P3005）** | 人工核对后接入基线，见 §3-B | `migrate resolve --applied 20260726000000_baseline` |
| 有 failed 记录（`finished_at IS NULL AND rolled_back_at IS NULL`） | **C failed（P3009 阻断）** | 核实实际效果后处置，见 §3-C | `migrate resolve --rolled-back <name>`（仅在核实后） |
| 有迁移历史、无 failed 记录 | **D 普通失败** | 按报错修根因后重跑 | 无 |

> 组合情形按更保守者处理：例如 B + 缺 `User`（既有部分结构且未接链）必须先按 B 走人工核对；
> C + `applied_steps_count > 0` 属**部分执行**，必须先核实残留效果（§3-C）。

## 3. 逐场景处置（全部先备份；逐步留痕）

### 3-A 全新空库失败

- 常见根因：连接串/凭据错误、migration SQL 语法或权限问题、扩展缺失（如 `pgcrypto`）、磁盘空间不足、并发部署抢占。
- 处置：修复根因 → 重跑 `deploy.sh`。
- **禁止**改用 `prisma db push` 建表（旧 R1 回退路径已按 R4 裁决移除；它掩盖版本链且无法证明与 migration 语义一致）。

### 3-B 既有库未接入迁移链（P3005）

背景：库非空但无迁移历史（多为历史 `db push` 演进的库），`migrate deploy` 以
`P3005 — The database schema is not empty` 拒绝执行。

1. **备份**；
2. 人工核对现有结构/数据是否与 `20260726000000_baseline` 的语义一致（表、列类型、约束、默认值）；
3. 一致 → 人工执行 `npx prisma migrate resolve --applied 20260726000000_baseline`（仅登记，不重复建表）→ 重跑部署接链；
4. **不一致** → 登记为 repair/bridge 场景：按 RC-04「在测试副本证明补丁顺序、实际列类型/默认值/约束一致后，再确定 bridge migration 或显式 baseline/repair 流程」；
   **不得**直接 `--applied` 强行跳过（`IF NOT EXISTS` 只解决名称存在，不证明类型/数据语义一致）。

### 3-C failed 记录（P3009）

1. **备份**；
2. 读 failed 记录明细（§1-②：`migration_name`、`applied_steps_count`、`logs`）；
3. **核实该 migration 在库中的实际效果**：它要创建/修改的对象是否已存在？数据是否已被改动？（逐条对照该 migration 的 SQL 与库中现状）
4. 分两种结论处置：
   - **确认未产生实际效果 / 残留可安全消除** → 人工 `npx prisma migrate resolve --rolled-back <migration_name>` → 修复致因 → 重跑部署（该迁移会重新应用）；
   - **已产生部分真实效果（部分执行）** → **不得** rolled-back 了当跳过；走「向前修复」：先人工把库对齐到该 migration 完成态（或编写承接 migration），再 resolve/重放，全程留痕并复核；
5. 台账登记：`migration_name` / `applied_steps_count` / 核实人 / 核实结论 / 处置命令与时间。

### 3-D 普通失败

- 按部署日志中的原始错误修复根因 → 重跑部署；若为数据/结构不符引起，按 RC-04 新建 migration 承接（不改已应用 migration 内容/checksum）。

## 4. 禁止清单（任何场景）

- 自动/脚本化执行：`migrate resolve`（任一形态）、清理 `_prisma_migrations` 记录、`prisma db push`、`--accept-data-loss`；
- 用 `public.User` 是否存在推断数据库为空或可回退；
- 在失败现场直接放开服务（readiness/能力放行由应用侧策略负责，不属本手册）；
- 手工改脚本绕过迁移步骤继续后续部署（deploy.sh 已 fail-fast，必须修根因后重跑）。

## 5. 实现与使用文档

- `deploy/deploy.sh` 中的 `deploy_run_migrations` 在迁移失败时保留原始输出、调用只读诊断并非零退出。
- `deploy/README.md` 记录当前部署行为、迁移故障分类以及租户版本链的使用方法。
- 本手册用于人工核实失败现场；任何恢复动作都须先确认已执行步骤和数据状态。
