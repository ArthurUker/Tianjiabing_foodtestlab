# FIX-P1-26：生产数据库路径在 docs/ 文档与 REVIEW_GUIDE 记录不一致

| 字段 | 内容 |
|------|------|
| **问题 ID** | `P1-26` |
| **优先级** | 🟠 P1 重要（建议 1 周内处理） |
| **影响文件** | `docs/review/RG_01_SYSTEM.md`（§1.2 歧义说明消除） |
| **预估工时** | 0.5h |
| **关联问题** | DOCS-03（DATABASE_SCHEMA.md 路径统一，依赖 P1-26 确认结论） |
| **状态** | ✅ 已完成 |
| **完成日期** | 2026-07-01 |

---

## 1. 问题

> 来自 FIX_PLAN.md P1-26 原始描述：
> 生产数据库路径在 `docs/` 文档与 `REVIEW_GUIDE` 记录不一致，存在 Prisma 无法找到数据库的风险

> 来自 RG_03b_ISSUES_P1.md §3 P1-26 审阅细化：
> - **位置**：`docs/` 系统文档 vs 本文档 §1.2
> - **`docs/` 记录**：`D:\珠海一中\foodtestlab.db`
> - **本文档 v0.7 记录**：`D:\ZhuHaiYiZhong-data\zhuhaiyizhong.db`
> - **风险**：若 `.env` 中 `DATABASE_URL` 配置了错误路径，Prisma 将无法找到数据库文件，系统完全无法读写数据
> - **修复建议**：**立即确认生产服务器 `.env` 中的 `DATABASE_URL` 实际值**，并统一所有文档记录

## 2. 根因

项目由"田家炳食品检验系统"（foodtestlab，端口 8081/3001，PM2 `foodtestlab-api`）衍生为"珠海一中食品检验系统"（zhuhaiyizhong，端口 8082/3002，PM2 `zhuhaiyizhong-api`）时，`docs/` 系统文档（ARCHITECTURE.md / DATABASE_SCHEMA.md / DEPLOYMENT_GUIDE.md / README.md）中的数据库路径未同步更新，仍保留田家炳遗留路径 `D:\珠海一中\foodtestlab.db`（目录名改为"珠海一中"但文件名仍为 `foodtestlab.db` 的混合错误）。

而实际生产部署脚本 `deploy.ps1` 与 `.env.example` 模板均已使用正确的珠海一中路径 `D:\ZhuHaiYiZhong-data\zhuhaiyizhong.db`，REVIEW_GUIDE v0.7 亦记录此正确路径，形成"代码/部署配置正确 vs docs/ 系统文档错误"的文档不一致。

## 3. 修复

按 RG_03b 审阅建议"确认生产服务器 `.env` 中的 `DATABASE_URL` 实际值"，通过生产部署脚本 `deploy.ps1` 确认权威路径：

**① 确认生产实际 `DATABASE_URL`（`deploy.ps1` L107 / L311-322）：**

```powershell
# L107：数据目录
$dataPath = if ($env:DATA_PATH) { $env:DATA_PATH } else { "D:\ZhuHaiYiZhong-data" }

# L311-322：部署时强制写入 backend/.env
$dbFile = Join-Path $dataPath "zhuhaiyizhong.db"          # → D:\ZhuHaiYiZhong-data\zhuhaiyizhong.db
$dbUrl  = "file:" + ($dbFile -replace "\\", "/")          # → file:D:/ZhuHaiYiZhong-data/zhuhaiyizhong.db
$envText2 = $envText2 -replace '(?m)^DATABASE_URL\s*=.*$', "DATABASE_URL=`"$dbUrl`""
```

**确认结论**：生产 `DATABASE_URL = file:D:/ZhuHaiYiZhong-data/zhuhaiyizhong.db`（物理路径 `D:\ZhuHaiYiZhong-data\zhuhaiyizhong.db`）。`deploy.ps1` 部署时强制覆盖 `backend/.env`，运行时以部署脚本写入值为准，`.env.example` 模板值（L17）与生产一致。

**② 消除 `docs/review/RG_01_SYSTEM.md` §1.2 歧义说明：**

将原"⚠️ 路径存在歧义"说明替换为"✅ 数据库路径已确认（P1-26 闭环）"，记录：
- 生产实际 `DATABASE_URL` 值
- 确认依据（`deploy.ps1` L107 / L311-322）
- `.env.example` 模板值一致性
- `docs/` 系统文档错误路径将在 DOCS-01/02/03/04 系列统一修正（TD-P2-30）

**代码无变更**：`schema.prisma`（`url = env("DATABASE_URL")`）、`deploy.ps1`（强制写入正确路径）、`.env.example`（模板值正确）均已正确，无需改动。

## 4. 功能影响

- 运行时行为零变化：生产部署由 `deploy.ps1` 强制写入正确 `DATABASE_URL`，本次仅为文档确认，不触及任何运行时代码
- REVIEW_GUIDE §1.2 不再标注"路径存在歧义"，消除维护者对数据库路径的疑虑
- 为 DOCS-03（DATABASE_SCHEMA.md 路径统一）提供确认结论依据，依赖链 P1-26→DOCS-03 前置项满足

## 5. 验收标准

- [x] 生产 `DATABASE_URL` 实际值已确认：`file:D:/ZhuHaiYiZhong-data/zhuhaiyizhong.db`
- [x] 确认依据为 `deploy.ps1` L107 / L311-322（部署脚本强制写入）
- [x] `.env.example` L17 模板值与生产实际一致
- [x] `RG_01_SYSTEM.md` §1.2 歧义说明已替换为确认结论
- [x] 代码无变更（`schema.prisma` / `deploy.ps1` / `.env.example` 均已正确）

## 6. 技术债

- **TD-P2-30**：`docs/` 系统文档（`ARCHITECTURE.md` / `DATABASE_SCHEMA.md` / `DEPLOYMENT_GUIDE.md` / `README.md`）仍记录田家炳系统遗留路径 `D:\珠海一中\foodtestlab.db`（50+ 处），与生产实际 `D:\ZhuHaiYiZhong-data\zhuhaiyizhong.db` 不一致。其中 `DATABASE_SCHEMA.md` 路径统一已明确归属 DOCS-03；`backend/README.md`（Supabase 引用）归属 DOCS-01；`API_REFERENCE.md`（端口错误）归属 DOCS-02；`FRONTEND_GUIDE.md` / `DEPLOYMENT_GUIDE.md` 缺失/内容归属 DOCS-04。建议在 DOCS 系列中统一修正全部 `docs/` 系统文档的数据库路径为 `D:\ZhuHaiYiZhong-data\zhuhaiyizhong.db`。

## 7. 备注

- 代码无变更（纯文档确认任务）
- TD-P2-28（`AdaptiveUploadQueue._fetchLatest()` 硬编码 URL）与 P1-26 主题（数据库路径文档歧义）无关，本次未清理，维持原状
- 生产运行时风险已被 `deploy.ps1` 部署脚本兜底（强制写入正确 `DATABASE_URL`），文档不一致不会导致生产 Prisma 找不到数据库
