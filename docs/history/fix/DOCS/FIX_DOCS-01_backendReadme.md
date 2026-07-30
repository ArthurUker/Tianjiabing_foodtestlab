> ⚠️ **历史归档文档**：本条 FIX 记录的是项目早期 **SQLite 阶段** 的修复，仅作历史留档。当前系统已迁移至 **PostgreSQL**（`backend/prisma/schema.prisma` 为 `provider = "postgresql"`）。文中"Prisma Client + SQLite"、"provider = \"sqlite\"" 等描述均已过时，不代表当前系统。

# FIX-DOCS-01：backend/README.md 仍引用 Supabase，与当前架构完全不符

| 字段 | 内容 |
|------|------|
| **问题 ID** | `DOCS-01` |
| **优先级** | 📄 文档修复（穿插进行） |
| **影响文件** | `backend/README.md` |
| **预估工时** | 1h |
| **关联问题** | - |
| **状态** | ✅ 已完成 |
| **完成日期** | 2026-07-02 |

---

## 1. 问题描述

`backend/README.md` 在项目由 Supabase 架构迁移至 Prisma + SQLite 架构后未同步更新，仍大量引用 Supabase，与当前实际技术栈完全不符。核实发现的具体 Supabase 引用位置（修复前）：

| 行号 | 内容 |
|------|------|
| L3 | `Express.js 后端服务器，为前端提供安全的API接口，隐藏Supabase密钥。` |
| L21-23 | `.env` 示例中 `# Supabase` / `SUPABASE_URL=https://mqnzaxwvyjtfktzqjugl.supabase.co` / `SUPABASE_KEY=...` |
| L52 | 启动 banner `🔒 All Supabase keys are protected` |
| L241 | `Supabase 密钥完全隐藏在后端 .env 文件中：` |
| L248-251 | 代码示例 `createClient(URL, PUBLIC_KEY)` / `process.env.SUPABASE_URL` / `process.env.SUPABASE_KEY` |
| L378 | 故障排除标题 `### 问题：无法连接到Supabase` |
| L386 | `1. 检查 .env 中的 SUPABASE_URL` |
| L388 | `3. 确认Supabase项目是否在线` |
| L392 | `curl https://mqnzaxwvyjtfktzqjugl.supabase.co/rest/v1/` |
| L454-455 | Heroku 部署 `heroku config:set SUPABASE_URL=xxx` / `SUPABASE_KEY=xxx` |
| L528 | 开发指南示例 `const profile = await supabase.from('users').select('*')...` |

附带问题：README 中端口示例统一为 `3000`，与 `backend/server.js` L29 `const PORT = process.env.PORT || 3002` 实际默认端口不符。

## 2. 根因分析

项目早期为 Supabase 前端直连架构，后端最初作为「API 代理 + 密钥隐藏」层引入。随后项目完成架构迁移：数据访问层改为 Prisma Client + SQLite（`backend/prisma/schema.prisma` `provider = "sqlite"`），认证改为 `jsonwebtoken` + `bcryptjs`（`backend/modules/UserManager.js` `jwt.sign` / `bcryptjs`，`backend/middleware/authMiddleware.js` `createAuthMiddleware`），进程管理改为 PM2（`deploy.ps1`）。但 `backend/README.md` 未随架构迁移同步更新，仍保留全套 Supabase 描述，属文档与代码长期脱节。

## 3. 修复方案

### 方案 A（推荐，已采用）

对 `backend/README.md` 进行整体重写（Supabase 段落分散且需语义重写，单纯关键词替换会导致语义不通）：

```diff
- Express.js 后端服务器，为前端提供安全的API接口，隐藏Supabase密钥。
+ Express.js 后端服务器，为前端提供安全的 API 接口。当前技术栈：Express + Prisma + SQLite（数据访问），JWT + bcryptjs（认证），PM2（进程管理）。
```

```diff
- # Supabase
- SUPABASE_URL=https://mqnzaxwvyjtfktzqjugl.supabase.co
- SUPABASE_KEY=eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9...
- # 服务器
- PORT=3000
+ # 数据库（Prisma + SQLite）
+ DATABASE_URL="file:D:/ZhuHaiYiZhong-data/zhuhaiyizhong.db"
+ # 服务器
+ PORT=3002
```

```diff
- ║  ✅ Running on port 3000               ║
- ║  🔒 All Supabase keys are protected    ║
+ ║  ✅ Running on port 3002               ║
+ ║  🗄️  Prisma + SQLite ready             ║
+ ║  🔑 JWT auth enabled                   ║
```

```diff
- ### 1. API密钥隐藏
- Supabase 密钥完全隐藏在后端 .env 文件中：
- const client = createClient(URL, PUBLIC_KEY)
- const client = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY)
+ ### 1. 数据库访问收敛
- 当前后端通过 Prisma Client 统一访问 SQLite 数据库 ... DATABASE_URL 由后端 .env 提供，前端不可见
+ import { PrismaClient } from '@prisma/client'
+ const prisma = new PrismaClient()
+ const user = await prisma.user.findUnique({ where: { username } })
```

```diff
- ### 问题：无法连接到Supabase
- 1. 检查 .env 中的 SUPABASE_URL
- 2. 验证网络连接
- 3. 确认Supabase项目是否在线
- curl https://mqnzaxwvyjtfktzqjugl.supabase.co/rest/v1/
+ ### 问题：无法连接到数据库
+ 1. 检查 .env 中的 DATABASE_URL 是否指向真实存在的 SQLite 文件
+ 2. 确认数据目录已创建（生产环境为 D:\ZhuHaiYiZhong-data）
+ 3. 执行 npx prisma generate 重新生成 Client
+ 4. 执行 npx prisma db push --accept-data-loss 同步表结构
+ Test-Path D:\ZhuHaiYiZhong-data\zhuhaiyizhong.db
```

```diff
- ### 部署到Heroku
- heroku config:set SUPABASE_URL=xxx / SUPABASE_KEY=xxx / JWT_SECRET=xxx
+ 当前生产环境为腾讯云 Windows Server，使用 PM2 管理后端进程，Nginx 做反向代理 ...
+ | 后端端口 | 3002 | 前端/Nginx 端口 | 8082 | PM2 应用名 | zhuhaiyizhong-api |
+ npx pm2 start server.js --name zhuhaiyizhong-api --time
```

```diff
- const profile = await supabase.from('users').select('*').eq('id', req.user.userId).single()
- res.json({ success: true, data: profile.data })
+ const profile = await prisma.user.findUnique({ where: { id: req.user.userId } })
+ res.json({ success: true, data: profile })
```

附带端口修正：所有 `localhost:3000` / `EXPOSE 3000` / `-p 3000:3000` → `3002`。

### 方案 B（备选）

> 暂无备选方案。

## 4. 验收标准

- [x] `backend/README.md` 全文不再出现 `Supabase` / `SUPABASE_URL` / `SUPABASE_KEY` / `createClient` / `supabase.co` 等关键词
- [x] `.env` 示例改为 `DATABASE_URL`（Prisma + SQLite）+ `PORT=3002` + `JWT_SECRET`
- [x] 启动 banner 与 curl/Docker 示例端口统一为 `3002`
- [x] 数据库访问示例改为 Prisma Client 用法
- [x] 部署章节改为 PM2/Windows 生产配置，与 `deploy.ps1` 一致

## 5. 回归测试要点

- [x] 核实当前技术栈：`backend/prisma/schema.prisma`（sqlite）、`backend/modules/UserManager.js`（jwt+bcryptjs）、`backend/middleware/authMiddleware.js`（createAuthMiddleware）
- [x] 核实默认端口：`backend/server.js` L29 `process.env.PORT || 3002`
- [x] 核实生产部署：`deploy.ps1` PM2 + Nginx + 端口 3002/8082

## 6. 备注

- 修改行号范围：全文重写（原 563 行 → 新 ~530 行）。主要改动段落：L3（简介）、L20-35（.env 示例）、L49-55（启动 banner）、L239-252（安全特性-数据库访问收敛）、L314/335/342（curl 示例端口）、L378-393（故障排除-数据库连接）、L442-483（部署章节 PM2/Docker）、L528（开发指南代码示例）。
- README 中 `## 📚 API文档` 章节示例的旧 API 路径（`/api/auth/login`、`/api/records/:type` 等）属 API 路径不匹配问题，归 [FIX_P1-27_auditRouteAndApiMismatch.md](../P1/FIX_P1-27_auditRouteAndApiMismatch.md)，不在 DOCS-01 范围内。
- 与 `FIX_P1-26_databasePathAmbiguity.md` / `TD-P2-30` 同源（架构迁移文档未同步），本次 README 路径已同步为生产实际值 `D:\ZhuHaiYiZhong-data\zhuhaiyizhong.db`。
