> ⚠️ **历史归档文档**：本条 FIX 记录的是项目早期 **SQLite 阶段** 的修复，仅作历史留档。当前系统已迁移至 **PostgreSQL**（`backend/prisma/schema.prisma` 为 `provider = "postgresql"`）。文中"确认 `schema.prisma` datasource 仍为 `provider = "sqlite"`"等描述均已过时，不代表当前系统。

# FIX-DOCS-03：DATABASE_SCHEMA.md 数据库路径与生产配置不一致

| 字段 | 内容 |
|------|------|
| **问题 ID** | `DOCS-03` |
| **优先级** | 📄 文档修复（穿插进行） |
| **影响文件** | `docs/DATABASE_SCHEMA.md` |
| **预估工时** | 1h |
| **关联问题** | `TD-P2-30`（docs/ 系统文档路径统一，部分完成） |
| **状态** | ✅ 已完成 |
| **完成日期** | 2026-07-02 |

---

## 1. 问题描述

`docs/DATABASE_SCHEMA.md` 记录的生产数据库路径仍为田家炳系统遗留错误路径 `D:\珠海一中\foodtestlab.db`（目录名改为"珠海一中"但文件名仍为 `foodtestlab.db` 的混合错误），与生产实际路径 `D:\ZhuHaiYiZhong-data\zhuhaiyizhong.db` 不符。核实发现的错误位置（修复前）：

| 行号 | 内容 | 实际值 |
|------|------|------|
| L26 | `D:\珠海一中\foodtestlab.db` | `D:\ZhuHaiYiZhong-data\zhuhaiyizhong.db` |
| L41 | `DATABASE_URL="file:D:/珠海一中/foodtestlab.db"` | `DATABASE_URL="file:D:/ZhuHaiYiZhong-data/zhuhaiyizhong.db"` |
| L61 | `| 生产数据库文件 | D:\珠海一中\foodtestlab.db |` | `D:\ZhuHaiYiZhong-data\zhuhaiyizhong.db` |
| L82 | `D:\珠海一中\foodtestlab.db`（同步前备份对象） | `D:\ZhuHaiYiZhong-data\zhuhaiyizhong.db` |
| L138 | `DATABASE_URL="file:D:/珠海一中/foodtestlab.db"` | `file:D:/ZhuHaiYiZhong-data/zhuhaiyizhong.db` |
| L574 | `D:\珠海一中\foodtestlab.db`（5.7 备份对象） | `D:\ZhuHaiYiZhong-data\zhuhaiyizhong.db` |
| L1565 | `D:\珠海一中\foodtestlab.db`（14.4 数据库文件安全） | `D:\ZhuHaiYiZhong-data\zhuhaiyizhong.db` |

随路径变更需同步的关联描述（备份路径/命名）：

| 行号 | 内容 | 实际值 |
|------|------|------|
| L580 / L1589 | `D:\foodtestlab\backup`（推荐备份目录） | `D:\ZhuHaiYiZhong-data\backup`（与数据目录对齐） |
| L1595 | `foodtestlab_YYYYMMDD_HHMMSS.db`（备份文件命名） | `zhuhaiyizhong_YYYYMMDD_HHMMSS.db` |

## 2. 根因分析

项目由"田家炳食品检验系统"衍生为"珠海一中食品检验系统"时，生产数据目录改为 `D:\ZhuHaiYiZhong-data`、数据库文件改名为 `zhuhaiyizhong.db`（见 `deploy.ps1` L107 `$dataPath = "D:\ZhuHaiYiZhong-data"`、L311-312 `$dbFile = Join-Path $dataPath "zhuhaiyizhong.db"` → `$dbUrl = "file:" + ...`），但 `DATABASE_SCHEMA.md` 未同步更新，仍保留旧路径。属架构迁移文档未同步，与 `FIX_P1-26_databasePathAmbiguity.md` 同源。

权威来源重新核实（本次独立确认，未采信历史记录）：
- `deploy.ps1` L107：`$dataPath = if ($env:DATA_PATH) { $env:DATA_PATH } else { "D:\ZhuHaiYiZhong-data" }`
- `deploy.ps1` L311-312：`$dbFile = Join-Path $dataPath "zhuhaiyizhong.db"` / `$dbUrl = "file:" + ($dbFile -replace "\\","/")`
- `deploy.ps1` L316-321：强制写入 `backend/.env` 的 `DATABASE_URL`
- 结论：生产实际路径 `D:\ZhuHaiYiZhong-data\zhuhaiyizhong.db` / `DATABASE_URL="file:D:/ZhuHaiYiZhong-data/zhuhaiyizhong.db"` 仍成立，历史记录正确。

## 3. 修复方案

### 方案 A（推荐，已采用）

将 7 处错误数据库路径 + 2 处备份目录 + 1 处备份命名替换为生产实际值：

```diff
- D:\珠海一中\foodtestlab.db            （L26/L61/L82/L574/L1565，共 5 处）
+ D:\ZhuHaiYiZhong-data\zhuhaiyizhong.db

- DATABASE_URL="file:D:/珠海一中/foodtestlab.db"   （L41/L138，共 2 处）
+ DATABASE_URL="file:D:/ZhuHaiYiZhong-data/zhuhaiyizhong.db"

- D:\foodtestlab\backup                  （L580/L1589，共 2 处）
+ D:\ZhuHaiYiZhong-data\backup

- foodtestlab_YYYYMMDD_HHMMSS.db         （L1595，共 1 处）
+ zhuhaiyizhong_YYYYMMDD_HHMMSS.db
```

> 说明：备份目录由田家炳遗留的 `D:\foodtestlab\backup` 调整为与已确认的生产数据目录 `D:\ZhuHaiYiZhong-data` 对齐的 `D:\ZhuHaiYiZhong-data\backup`；备份文件命名同步改为 `zhuhaiyizhong_` 前缀。`deploy.ps1` 未显式定义备份目录，此为文档内一致性对齐。

### 方案 B（备选）

> 暂无备选方案。

## 4. 验收标准

- [x] `docs/DATABASE_SCHEMA.md` 全文不再出现 `D:\珠海一中\foodtestlab.db` / `file:D:/珠海一中/foodtestlab.db`
- [x] 7 处数据库路径替换为 `D:\ZhuHaiYiZhong-data\zhuhaiyizhong.db` / `file:D:/ZhuHaiYiZhong-data/zhuhaiyizhong.db`
- [x] 备份目录与命名同步更新为 `D:\ZhuHaiYiZhong-data\backup` / `zhuhaiyizhong_YYYYMMDD_HHMMSS.db`
- [x] 路径与 `deploy.ps1` L107/L311-322 权威来源一致

## 5. 回归测试要点

- [x] 核实权威路径来源：`deploy.ps1` L107（`D:\ZhuHaiYiZhong-data`）、L311-312（`zhuhaiyizhong.db`）
- [x] 复核 `D:\珠海一中\foodtestlab.db` / `foodtestlab\backup` 在本文档无残留（全文搜索确认 0 匹配）
- [x] 确认 `schema.prisma` datasource 仍为 `provider = "sqlite"` + `url = env("DATABASE_URL")`，无需改动

## 6. 备注

- 修改行号：L26/L41/L61/L82/L138/L574/L580/L1565/L1589/L1595，共 10 处。
- **备份路径核实（2026-07-02 独立搜索，结论：推断值，非 `deploy.ps1` 确认值）**：本次将 `D:\foodtestlab\backup` → `D:\ZhuHaiYiZhong-data\backup` 的修改经独立核实，确认**仓库中不存在实际的备份脚本或定时任务定义**，该值为推断值（与已确认的生产数据目录 `D:\ZhuHaiYiZhong-data` 逻辑对齐），非 `deploy.ps1` 确认值。核实范围与结论：
  - `deploy.ps1`：仅定义 `$dataPath = "D:\ZhuHaiYiZhong-data"`（L107）与 `zhuhaiyizhong.db`（L311），**未定义 backup 目录、未调用备份脚本、未注册定时任务**。
  - `deploy/pm2/ecosystem.config.cjs`：为田家炳遗留 PM2 配置（`foodtestlab-api`/3001），无 cron/backup 字段；`deploy.ps1` 实际以 `npx pm2 start` 内联启动，未引用此文件。
  - `deploy/nginx/foodtestlab-low-spec.conf`：纯反向代理配置，无备份相关。
  - `scripts/*.bat`（quick-setup / admin-setup / diagnose-admin）：均为开发环境或 admin 账号工具，无备份路径定义。
  - 全仓库搜索 `schtasks|cron|ScheduledTask|Register-ScheduledJob` → **0 匹配**，不存在任何定时备份任务。
  - `backend/prisma/schema.prisma` 的 `Backup` 模型（L128-132）含 `backup_path` 字段，但为运行时按记录写入的 DB 列，无固定默认值，不构成路径权威来源。
  - `js/modules/BackupRestore.js`：为前端模块，`handleBackup()` 生成浏览器端 JSON 下载（`lab_backup_YYYY-MM-DD.json`），云端恢复走 `/api/records/*`，**不涉及文件系统 `D:\...\backup` 目录**。
  - `docs/DEPLOYMENT_GUIDE.md` L517 / L1475 有 `$backupDir = "D:\foodtestlab\backup"` 示例代码，但属文档内示例片段（非仓库可执行脚本），且仍为田家炳旧路径，不构成权威来源（已登记 TD-P2-30 待修）。
  - **结论**：`D:\ZhuHaiYiZhong-data\backup` 为文档一致性推断值。如实际部署时创建备份脚本或定时任务，**请以脚本/任务定义的路径为准**，并反向同步更新本文档与 `docs/DATABASE_SCHEMA.md`。
- **与 TD-P2-30 关联**：本项为 `TD-P2-30`（docs/ 系统文档路径统一）的部分完成。`DATABASE_SCHEMA.md` 路径已全部修正；`TD-P2-30` 整体仍待处理，因其他文档仍有相同路径错误残留（见下）。

### 其他文档同类路径错误残留（本次范围外，留待 TD-P2-30 后续处理）

经核实，以下文档仍存在 `D:\珠海一中\foodtestlab.db` / `file:D:/珠海一中/foodtestlab.db` 及田家炳遗留备份路径错误，**本次不修复，仅列出登记**：

| 文档 | 错误路径出现行号（示例） | 备注 |
|------|------|------|
| `docs/ARCHITECTURE.md` | L129/L213/L241/L258/L277/L368/L546/L566/L928/L1147/L1169/L1238/L1495 等（15+ 处） | 含 Mermaid 图节点、备份/恢复说明 |
| `docs/DEPLOYMENT_GUIDE.md` | L13/L145/L185/L219/L311/L433/L469/L485/L507/L519/L661/L831/L837/L873/L1406/L1477/L1485/L1527/L1552/L1677/L1820 等（20+ 处） | 含 `Copy-Item` 备份脚本、`Test-Path` 校验、`.env` 示例 |
| `docs/README.md` | L72/L140/L155/L357 等（5 处） | 含生产数据库文件表项、`DATABASE_URL` 示例 |
| `docs/API_REFERENCE.md` | L85/L87（`foodtestlab.db` 本地开发文件名，目录树） | 非生产路径错误，为本地开发 DB 文件名，影响较低 |

> 建议后续在 TD-P2-30 一次性统一修正上述文档全部路径为 `D:\ZhuHaiYiZhong-data\zhuhaiyizhong.db`。
