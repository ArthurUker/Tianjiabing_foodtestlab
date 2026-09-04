# 后端 API 服务（backend/）

食品安全检验系统（部署代号 `foodsentinel`）的后端，基于 **Express + Prisma + PostgreSQL**，使用 **JWT（Bearer）** 认证。生产部署由 **systemd** 托管，前端经 **Caddy** 反向代理（非 Windows / 非 PM2）。开发/测试/生产统一使用 PostgreSQL。

> 完整架构、API 清单、前端与部署说明见 [`../docs/DEVELOPMENT_GUIDE.md`](../docs/DEVELOPMENT_GUIDE.md)。本文仅覆盖后端自身的本地开发与运行。

---

## 技术栈

- Node.js 20（ESM，`"type": "module"`），入口 `server.js`
- Express 4 + jsonwebtoken + bcryptjs
- Prisma 5 + PostgreSQL（连接串由 `DATABASE_URL` 提供，开发/测试/生产统一）

---

## 快速开始（本地开发）

```bash
cd backend
npm install

# 1) 准备 .env（参考仓库根目录 .env.example，正式以部署脚本生成 .env 为准）
#    至少配置：DATABASE_URL / JWT_SECRET / SEED_ADMIN_PASSWORD / SEED_OPERATOR_PASSWORD / SEED_VIEWER_PASSWORD

# 2) 生成 Prisma Client 并同步表结构
npx prisma generate
npx prisma db push            # 生产环境慎用 --accept-data-loss

# 3) 初始化初始账号（admin / operator / viewer）
node prisma/seed.js

# 4) 启动（开发模式带 --watch 自动重启）
npm run dev                   # 或生产：npm start
```

启动后默认监听 `PORT`（部署用 `3000`；本地可设 `3002`）。健康检查：

```bash
curl http://127.0.0.1:3002/api/health   # 本地开发端口；部署环境为 3000
```

---

## 关键环境变量（`.env`）

| 变量 | 说明 |
|------|------|
| `NODE_ENV` | development / production |
| `PORT` | 后端内部端口（默认 3000） |
| `SERVE_STATIC` | 是否后端托管静态资源（生产 false，由 Caddy 托管 `dist/`） |
| `DATABASE_URL` | `postgresql://<user>:<pass>@127.0.0.1:5432/foodsentinel` |
| `JWT_SECRET` | 强随机密钥（不可为弱密钥黑名单，否则启动即退出） |
| `JWT_EXPIRE` | 令牌有效期（默认 7d） |
| `CORS_ORIGIN` | 逗号分隔允许来源；`*` 全开 |
| `CORS_HOSTNAMES` | hostname[:port] 白名单 |
| `SEED_ADMIN_PASSWORD` / `SEED_OPERATOR_PASSWORD` / `SEED_VIEWER_PASSWORD` | seed 初始密码（缺失则 seed 拒绝运行） |
| `SEED_ALLOW_PROD` | 生产环境允许 seed（默认 false） |
| `LOGIN_RATE_LIMIT_MAX` / `LOGIN_RATE_LIMIT_WINDOW_MS` | 登录限流（默认 10 / 15 分钟） |
| `RATE_LIMIT_MAX_REQUESTS` / `RATE_LIMIT_WINDOW_MS` | 全局限流（默认 1000 / 60s） |

---

## 目录结构

```
backend/
├── server.js                 # 应用入口：路由、中间件、启动、健康检查
├── package.json              # 后端依赖与脚本
├── prisma/
│   ├── schema.prisma         # 数据模型（User/AuditLog/TestRecord/TestItem/Attachment/Guest/Backup/SystemLog/Session）
│   └── seed.js               # 初始账号初始化
├── modules/
│   └── UserManager.js        # 用户 / 认证核心逻辑（loginUser / verifyToken / 角色管理）
├── routes/
│   ├── userRoutes.js         # /api/user/* 用户与认证
│   ├── auditRoutes.js        # /api/audit-logs/*
│   ├── guestRoutes.js        # /api/guest/*（quick-access / verify-token / stats；register 已关闭）
│   ├── sessionRoutes.js      # /api/session/* 会话同步与事件
│   └── syncRoutes.js         # /api/sync/*
├── lib/
│   ├── tenantClient.js       # per-schema 专属 PrismaClient（Schema-per-tenant 隔离核心）
│   ├── tenantProvisioner.js  # 新学校 schema 初始化（provisionSchool）
│   └── auditLog.js           # 统一审计写入门面（writeTenantAuditLog / writeSystemLog）
├── middleware/
│   ├── authMiddleware.js     # 统一认证 / 授权工厂（authenticateUser / authorizeAdmin / authorizeRoles）
│   ├── validationMiddleware.js  # 限流 / 文本消毒
│   └── idempotencyMiddleware.js # 幂等（records API）
└── scripts/                  # 一次性迁移 / 修复 / 导入脚本（规范见 scripts/README.md）
```

---

## 迁移脚本规范（RK50）

一次性数据迁移 / 修复 / 导入脚本统一放在 [`scripts/`](./scripts/README.md)，要求：

- **命名**：`NNN_description.mjs`（三位递增序号，ESM）；
- **试运行**：必须支持 `--dry-run`（只打印计划不写库），危险写操作需显式 `--yes`；
- **日志**：带 `[NNN_xxx]` 前缀的进度日志 + 结束汇总（成功/跳过/失败），失败非 0 退出；
- **幂等**：重复执行不产生重复数据（确定性键位判重）；
- **多租户**：操作租户 schema 必须经 `lib/tenantClient.js` 的 `createTenantClient`，不要依赖 `SET search_path`。

完整规范与脚本模板见 [`scripts/README.md`](./scripts/README.md)。

---

## API 速览（实际实现）

基础路径 `/api`，受保护接口需 `Authorization: Bearer <token>`。

### 认证（`/api/user`）

| 方法 | 路径 | 权限 | 说明 |
|------|------|------|------|
| POST | `/api/user/login` | 公开 | 登录，返回 `{ success, token, user, expiresIn }` |
| POST | `/api/user/verify-token` | 公开（带 token） | 校验令牌 |
| POST | `/api/user/refresh-token` | 登录用户 | 续期令牌 |
| GET | `/api/user/me` | 登录用户 | 当前用户信息 |
| PUT | `/api/user/me` | 登录用户 | 更新个人资料 |
| POST | `/api/user/change-password` | 登录用户 | 修改密码 |
| GET | `/api/user/list` | admin/manager | 用户列表 |
| PUT/DELETE | `/api/user/:userId` | admin/manager | 更新 / 删除用户（防删自己、防删最后一个 admin） |
| POST | `/api/user/:userId/{disable,enable,role,reset-password}` | admin/manager | 账号管理 |

> 前端 `AuthService` 与后端 `userRoutes.js` 现已一致（`change-password`/`verify-token`/`logout` 均为 `POST`），旧 README 的 `/api/auth/*` 调用方式已废弃。

### 访客（`/api/guest`）

| 方法 | 路径 | 说明 |
|------|------|------|
| POST | `/api/guest/quick-access` | 免凭证签发只读限权 JWT（**2h**，`guest_type='readonly'`、无导出权限、不可看病原体） |
| POST | `/api/guest/register` | **已关闭**：恒定 `403`（提示申请 viewer 账号） |
| POST | `/api/guest/verify-token` | 校验访客令牌（需 guest 角色 JWT） |
| GET  | `/api/guest/stats` | 访客看板汇总统计（仅聚合，不返回记录明细） |

> **开关（fail-closed）**：`quick-access` 强制校验 `School.guest_enabled`，
> 未开启返回 `403 该校未开放访客访问`；并挂独立限流（30 次/分钟）。
> 该开关由**平台超管**在学校管理控制台按校开启（写入 `PUT /api/admin/schools/:code` 的 `guestEnabled`）。
>
> **已下线（勿再寻找）**：
> - `/api/guest/login` 端点**不存在**（已移除）：访客无用户名密码登录通道，`quick-access` 是唯一入口。
> - `/api/guest-export-request/*` 全套（submit / my-requests / check-permission / admin/pending /
>   approve / reject）**路由文件已删除**、`server.js` 未挂载。故 `has_export_permission` **无法置为 true**，
>   访客导出为**恒定拒绝**。数据库层 `GuestExportRequest` 表作遗留结构保留。
> - 访客只读与模块白名单由 `requireGuestReadOnly`（`middleware/authMiddleware.js`）强制：
>   非 `GET`/`HEAD` 一律 403；白名单为 `visible_types` **强制剔除 `pathogen`**。

### 检测记录

| 方法 | 路径 | 权限 | 说明 |
|------|------|------|------|
| GET | `/api/test-records` | 登录 | 记录列表（分页 / test_type / status） |
| POST | `/api/test-records` | 编辑者↑ | 创建（幂等） |
| GET/PUT/DELETE | `/api/test-records/:id` | 登录 / 编辑者↑ | 单条查 / 改 / 删 |
| GET/POST | `/api/records/:tableName` | 登录 / 编辑者↑ | 按类型取 / 建（旧版兼容） |
| POST | `/api/records/:tableName/bulk-upsert` | 编辑者↑ | 批量导入（≤2000） |
| GET/PUT/DELETE | `/api/records/:tableName/:id` | 登录 / 编辑者↑ | 单条查 / 改 / 删 |

`test_type` 取值：`tableware` / `pesticide` / `oil` / `leanMeat` / `pathogen`。创建时按内容生成确定性 `record_code`（`RC-{type}-{sha256}`），重复提交按幂等返回已有记录。

### 其它

- `GET /health`、`GET /api/health`：健康检查
- `/api/audit-logs`：审计日志（前端 `AuditLogService` 写入）
- `/api/sync`：离线 / 多端同步

---

## 测试接口（curl 示例）

```bash
# 登录（密码为 SEED_ADMIN_PASSWORD 实际值，非 admin123）
TOKEN=$(curl -s -X POST http://127.0.0.1:3000/api/user/login \
  -H "Content-Type: application/json" \
  -d '{"username":"admin","password":"<SEED_ADMIN_PASSWORD>"}' | node -e 'process.stdin.on("data",d=>console.log(JSON.parse(d).token))')

# 获取餐具检测记录
curl -s "http://127.0.0.1:3000/api/records/tableware?limit=10" \
  -H "Authorization: Bearer $TOKEN"
```

---

## 生产运行与部署

生产环境**不使用 PM2 / Windows**。systemd 单元与 Caddy 站点片段由 `deploy/deploy.sh` 在首次安装时生成完毕（首装配置为服务器端 `/opt/deploy/deploy.foodsentinel.conf`，含密钥，不入仓库）；后续日常迭代只需更新代码并重启：

```bash
git pull && npm run build && sudo systemctl restart foodsentinel-api
curl http://127.0.0.1:3000/api/health
```

运维诊断：

```bash
systemctl status foodsentinel-api
journalctl -u foodsentinel-api -f
```

详见 [`../deploy/README.md`](../deploy/README.md) 与 [`../docs/DEVELOPMENT_GUIDE.md`](../docs/DEVELOPMENT_GUIDE.md)。
