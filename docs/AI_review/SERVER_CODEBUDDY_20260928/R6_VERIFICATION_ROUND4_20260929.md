# R6 第 4 轮报告（2026-09-29）：离线可判项 + G0 结论修正

> 计划依据：`R6_DEEP_REVIEW_PLAN_R3_20260929.md` §后续轮次「第 4 轮」——本轮完成其中**无需隔离实例栈**的两项（发布脚本实跑、SRV-127 口径核对），并**修正第 3 轮的 G0 结论**。
> 执行时间：**2026-09-29 10:32–10:3x CST**｜**未修产品源码、未部署、未连任何数据库、未创建克隆库/角色/服务、未在生产运行目录创建测试文件、未改真实授权**。
> 远端本周目内**无 R4 计划文件**（已 `git ls-tree` 核对），故按 R3 计划后续轮次执行。

## 0. 开工状态

| 项 | 实测 |
| --- | --- |
| 本地 HEAD / 远端 | 均为 **`e212621`**（无新提交、无 R4 计划） |
| 工作区 | **clean** |
| 服务 | `MainPID=1673914`，启动 2026-09-28 16:45:51，**未重启** |
| 其他窗口 | `FETCH_HEAD` mtime = **10:32:46**（与检查同秒）→ **仍在活动** |

## 1. S1 · 两段发布入口 `b-release-two-phase.sh` b1 段的实跑验证（SRV-109）

**方法说明（为什么不需要沙盒）**：脚本 `:38` 先 `cd "$REPO_ROOT"`，因此"仓库根"就是它真实的工作目录。在**不设置 `DATABASE_URL`** 的前提下直接执行它将要执行的两条命令，可复现其失败而**不连接任何数据库**（Prisma 在解析阶段即退出；006 在入口即退出）。**未创建沙盒目录、未写任何文件到生产工作区**（日志写入 `/tmp`）。

| 步骤 | 命令（等价于脚本 `:58` / `:49`） | 前置事实 | 实际输出 | 退出码 |
| --- | --- | --- | --- | --- |
| b1-① | `cd /opt/foodsentinel && node backend/node_modules/prisma/build/index.js migrate deploy`（`env -u DATABASE_URL`） | `ls -d prisma` → **No such file or directory**；`grep -c '"prisma"' package.json` → **0** | `Error: Could not find Prisma Schema that is required for this command.` + `Checked following paths: schema.prisma: file not found / prisma/schema.prisma: file not found` | **rc=1** |
| b1-②（gate②） | `cd /opt/foodsentinel/backend && node scripts/006_audit_principal_gate.mjs`（`env -u DATABASE_URL`） | 脚本 `b-release-two-phase.sh` 内**无任何 `.env` 加载**（无 `source`/dotenv） | `需要 DATABASE_URL（只读门禁）` | **rc=2** |

**结论**：b1 段**两处必然失败**——① 在仓库根执行 `npx prisma migrate deploy` 找不到 schema（脚本头部的两段发布设计无法按原样执行）；② 其 `gate_pass` 的第二条门禁在脚本环境下恒以 rc=2 中止（`set -euo pipefail` 下即整体退出）。二者均为**离线可判**，未使用真实发布、未发出网络请求、未触碰数据库。
**SRV-109：维持 P2**（发布通道不可用 → 运维只能手工拼命令，正是该脚本要消除的风险）。

## 2. S2 · 导出口径分叉（SRV-127）

| 侧 | 逐字引用（本轮本人回读） | 位置 |
| --- | --- | --- |
| 导出（学校端报表） | `const baseQualified = (r.result?.includes('合格') && !r.result?.includes('不合格')) || r.colorLevel === '合格';` | `frontend/js/services/ExportService.js:997` |
| 后端唯一事实源 | `export const OIL_COLOR_PASS = new Set(['合格', '警戒'])`；`if (OIL_COLOR_PASS.has(color)) return { level: LEVEL.PASS, … }` | `backend/lib/conclusionVerdict.js:31`；前端同源 `frontend/js/core/conclusionVerdict.js:17,41,58-60`（`isOilPass`） |

**判据**：油品记录 `colorLevel='警戒'`（`result` 为空）→ 导出侧 `baseQualified=false`（计不合格），后端/看板侧 `OIL_COLOR_PASS` 命中 → `LEVEL.PASS`（计合格）。**同一条记录在两个出口得出相反结论。**

**⚠️ 但本轮必须同时记录"这不是单纯笔误"**：导出侧表达式上方 `:994-996` 有**明文业务裁定**——"（2026-07-02业务方裁定）：仅'合格'计为合格，'警戒''不合格'等其余结果均计为不合格……请勿改为宽松匹配"。即**两侧各自都有背书**，本质是**两套口径未统一**，而非单侧实现错误。

**定性建议**：**SRV-127 维持 P2**，但处置方式应为**业务口径裁决 + 单点收敛**（对外导出统一消费服务端结论），而不是直接改导出表达式——否则会推翻 2026-07-02 的裁定。修复前需业务确认"警戒是否计入合格率"。

**未完成的部分（NOT_RUN）**：餐具的 `atpPoints` 回退差异（看板 `Dashboard.isQualified` 有回退、导出侧未见）**未逐行排除上游是否另有 tableware 分支** → 记为待证实，不在本轮结论内。

## 3. 🔧 修正第 3 轮 G0 的结论（重要）

第 3 轮我判定"EACCES 是由**把隔离副本 `node_modules` 做成软链**导致，复制 `node_modules` 即可解决"。本轮在**生产目录、真实 `node_modules`、以 ubuntu 用户**执行 `006` 时**再次复现同一条 EACCES**：

```
Schema Env Error: Error: EACCES: permission denied, open '/opt/foodsentinel/backend/.env'
需要 DATABASE_URL（只读门禁）          ← 006 在访问 DB 前即退出
```

而 `scripts/006_audit_principal_gate.mjs` **既不 import dotenv、也不读 `.env`** ⇒ **读取由 Prisma 运行时触发**，路径 = **schema 所在目录的父目录**（`backend/prisma/schema.prisma` → `backend/.env`）。

**修正后的结论**：
1. 该 EACCES 是 **Prisma 在本仓的固有 `.env` 发现行为**，与软链无关；任何**非 `foodsentinel` 用户**在 `backend/` 下运行 Prisma 支持的代码都会出现，且**被 Prisma 静默忽略**（非致命）。
2. 因此第 3 轮给出的隔离配方**不充分**：**复制 `node_modules` 不够**——被复制的生成客户端里内嵌的仍是 `/opt/foodsentinel/backend/prisma/schema.prisma`，Prisma 依旧会去**生产目录**找 `.env`。
3. **修正后的硬性要求**：隔离副本必须**在副本内执行 `prisma generate`**（使内嵌 schema 路径指向副本），并且隔离成立判据升级为**两条**：
   ```
   grep -ao "/opt/foodsentinel[^\"']*" <副本>/backend/node_modules/.prisma/client/index.js   # 必须为空
   grep -c "/opt/foodsentinel" <副本>/backend/node_modules/.prisma/client/*                   # 必须为 0
   ```
   另：**不得**把"生产 `.env` 恰好不可读"当作隔离保证（计划已明确此点，本轮以实证支持）。

## 4. 本轮 NOT_RUN

| 项 | 原因 |
| --- | --- |
| SRV-101/102/103/104/105 路由级最小反例 | 需完整隔离 HTTP 栈（Express + 合成租户 + 签名 token），本轮按 §3 修正后的要求尚未搭建 |
| SRV-128 / SRV-135 隔离影响验证 | 同上（前者需 Express，后者需隔离库） |
| SRV-111 / SRV-110 / SRV-106 / SRV-107 负例 | 同上（R3 遗留） |
| 发布脚本的**端到端**沙盒实跑（含真实 `migrate`/`db:sync`/`restart` 序列） | 需隔离库与隔离服务；本轮的 **S1 只覆盖 b1 段的两处失败点**（离线、零连库） |
| 餐具 `atpPoints` 回退差异（SRV-127 子项） | 未逐行排除上游分支 |
| ONLINE_CHECKS 项 4/5（生产未认证边界、已授权业务读） | 生产工作区仍有其他窗口活动 |

## 5. 重新定级（本轮）

| ID | 本轮定级 | 依据 |
| --- | --- | --- |
| **SRV-109** | **P2 维持（已实跑坐实）** | b1 段两处必然失败，rc=1 / rc=2，离线可判 |
| **SRV-127** | **P2 维持（已坐实分叉，但需业务定性）** | 导出 `:997` vs `OIL_COLOR_PASS`；两侧均有背书，属口径未统一 |
| SRV-137 | P3（第 3 轮下调，本轮无新证据） | — |
| SRV-111 / 110 / 106 | P1 / P2 / P2 **维持，仍 NOT_RUN** | — |

## 6. 清理与边界

- 未创建任何数据库/角色/隔离目录/服务 → **无清理项、无实例需要 down**。
- 未在生产工作区写入任何文件（两份日志在 `/tmp`）；`git status` 复核仍 clean。
- 两条实跑命令均在 `env -u DATABASE_URL` 下执行，**Prisma 在 schema 解析阶段退出、006 在环境检查阶段退出**，**未建立任何数据库连接**。
- **脱敏**：不含口令/连接串/token/API Key/`BACKUP_MASTER_KEY`/真实个人信息。
