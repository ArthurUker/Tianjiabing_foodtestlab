# backend/scripts/ 迁移与运维脚本规范（RK50）

本目录存放**一次性数据迁移 / 修复 / 导入**类脚本（区别于 `prisma/seed.js` 的常规初始化）。
所有新增脚本必须遵守以下规范。

## 0. 存量导入脚本现状（2026-09-16 审阅核实，动手前必读）

| 脚本 | 执行模式 | 与平台现行口径 |
|---|---|---|
| `import-tjb-backup.mjs` | **默认写库**（需显式 `--dry-run` 才只预览） | ⚠️ 仍把 `testDate/canteen/inspector` 平铺进 `result_data`（历史口径，见该文件注释） |
| `import-zhyz-backup.mjs` | **默认写库**（需显式 `--dry-run`） | 同上 |
| `import-tjb-sqlite.mjs` | 默认 `--dry-run`（需 `--commit` 写库） | 沿用 manifest 的 `record_code`，不自算哈希 |
| `import-backup-local.mjs` | 无 dry-run，直接写 | ⚠️ 用**基础 prisma 单例**（→ `public` schema），仅适用于本地/public 场景；`JSON.stringify` 传入 Json 列属历史写法 |

要点：
- 这些脚本**不被**部署/备份/恢复流程引用（`docs/deployment/backup-module.md` 用的是 `003_backup-now.mjs` / `004_backup-verify.mjs`），重跑前请先确认是否仍需要；
- 平台自 2026-09-16 起规定：上下文三键只落 `sample_info`，`result_data` 不再保留副本（`README.md` §4.3）。**继续使用上表两个 `*-backup.mjs` 导入，会产出带历史副本的记录**（对外仍是同值，字段字典已把副本标为可选）——因此不要宣称"所有新记录都没有副本"，除非先把脚本口径对齐。
- 任何"改默认执行方式 / 改输出规范 / 改哈希或去重标识"的调整，都必须在报告与本文档中给出迁移说明，不得悄悄破坏既有调用。

## 1. 命名规范

```
NNN_description.mjs
```

- `NNN`：三位递增序号（`001` 起），按创建顺序分配，**不复用**已用序号；
- `description`：小写英文 + 连字符/下划线，描述脚本用途；
- 后缀统一 `.mjs`（ESM，与 backend `"type": "module"` 一致）。

示例：

```
001_backfill-record-code.mjs
002_migrate-legacy-backup.mjs
```

> 历史脚本 `import-backup-local.mjs` 早于本规范，保留原名不追溯改名；新脚本一律按规范命名。

## 2. 必备能力

每个脚本必须实现：

### 2.1 `--dry-run`（试运行）

- `node scripts/NNN_xxx.mjs --dry-run`：只**读取并打印将要执行的变更**（计数、样例），不写库；
- 默认（不带参数）也建议先输出计划，需 `--yes` / `--apply` 才真正执行写操作（危险操作必须如此）。

### 2.2 日志

- 每一步打印带前缀的进度日志：`[NNN_xxx] 处理 tableware：120 条，跳过 3 条（已存在）`；
- 结束打印汇总（成功/跳过/失败 计数）；
- 失败要打印失败记录的定位信息（id / record_code），并以非 0 退出码结束；
- 长任务建议同时 `fs.appendFileSync` 落一份 `scripts/logs/NNN_xxx.<timestamp>.log`（`scripts/logs/` 已在 .gitignore 时不入库）。

### 2.3 幂等

- 重复执行不产生重复数据（用确定性键位判重，如 `record_code`、`IMPORT-` 前缀）；
- upsert 或「查重后跳过」二选一，并在日志里体现跳过数。

### 2.4 多租户注意（Schema-per-tenant）

- 本项目为 PostgreSQL Schema-per-tenant：默认 `PrismaClient` 连的是 `DATABASE_URL` 指向的 schema（通常 public）；
- 要操作某租户 schema，必须通过 `lib/tenantClient.js` 的 `createTenantClient(prisma, schoolCode)` 获取该 schema 专属 client，**不要**依赖 `SET search_path`（对 Prisma model 查询无效）；
- 跨全部租户的迁移脚本应遍历 `public.School` 列表逐 schema 执行，并逐 schema 打印日志。

## 3. 脚本骨架（模板）

```js
// NNN_description.mjs — <一句话说明>
// 用法：node scripts/NNN_description.mjs [--dry-run] [--yes]
import 'dotenv/config'
import { PrismaClient } from '@prisma/client'

const TAG = '[NNN_description]'
const DRY = process.argv.includes('--dry-run')
const YES = process.argv.includes('--yes')

const prisma = new PrismaClient()

async function main() {
  console.log(`${TAG} 开始（dry-run=${DRY}）`)
  // 1) 读取待处理数据并统计
  // 2) DRY：仅打印计划后 return
  if (DRY) { console.log(`${TAG} dry-run 结束，未写库`); return }
  if (!YES) { console.log(`${TAG} 写操作需显式 --yes 确认，退出`); process.exit(1) }
  // 3) 执行写入（幂等），打印进度
  // 4) 汇总：成功 X / 跳过 Y / 失败 Z
}

main()
  .catch((e) => { console.error(`${TAG} 失败:`, e); process.exitCode = 1 })
  .finally(() => prisma.$disconnect())
```

## 4. 上线检查清单

- [ ] 先在本地/测试库 `--dry-run` 核对计数与样例
- [ ] 生产执行前备份（`pg_dump` 或平台快照）
- [ ] 生产先 `--dry-run` 再 `--yes` 实跑
- [ ] 执行日志留存，写入变更记录（docs/CHANGELOG.md）
