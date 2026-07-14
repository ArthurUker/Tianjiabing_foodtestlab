# 后端 API 服务（backend/）

田家炳食品检验系统（部署代号 `foodtestlab`）的后端，基于 **Express + Prisma + PostgreSQL**，使用 **JWT（Bearer）** 认证。生产部署由 **systemd** 托管，前端经 **Caddy** 反向代理（非 Windows / 非 PM2）。开发/测试/生产统一使用 PostgreSQL。

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
curl http://127.0.0.1:3000/api/health
```

---

## 关键环境变量（`.env`）

| 变量 | 说明 |
|------|------|
| `NODE_ENV` | development / production |
| `PORT` | 后端内部端口（默认 3000） |
| `SERVE_STATIC` | 是否后端托管静态资源（生产 false，由 Caddy 托管 `dist/`） |
| `DATABASE_URL` | `file:<路径>/foodtestlab.db` |
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
│   ├── schema.prisma         # 数据模型（User/AuditLog/TestRecord/TestItem/Attachment/Guest/Backup/SystemLog）
│   └── seed.js               # 初始账号初始化
├── modules/
│   └── UserManager.js        # 用户 / 认证核心逻辑（loginUser / verifyToken / 角色管理）
├── routes/
│   ├── userRoutes.js         # /api/user/* 用户与认证
│   ├── auditRoutes.js        # /api/audit-logs/*
│   └── syncRoutes.js         # /api/sync/*
└── middleware/
    ├── authMiddleware.js     # 统一认证 / 授权工厂（authenticateUser / authorizeAdmin / authorizeRoles）
    ├── validationMiddleware.js  # 限流 / 文本消毒
    └── idempotencyMiddleware.js # 幂等（records API）
```

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

> ⚠️ 前端 `AuthService` 对 `change-password` / `verify-token` 的 method/path 与后端略有出入（见 DEVELOPMENT_GUIDE §9），属已知偏差，勿按旧 README 的 `/api/auth/*` 调用。

### 访客（`/api/guest`）

| 方法 | 路径 | 说明 |
|------|------|------|
| POST | `/api/guest/quick-access` | **唯一实现**：免凭证签发只读限权 JWT（2h） |

> 访客自助注册 / 登录 / 导出申请的前端调用（`/api/guest/login|register`、`/api/guest-export-request/*`）后端尚未实现（见 DEVELOPMENT_GUIDE §9）。

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

生产环境**不使用 PM2 / Windows**。由 `deploy/deploy.sh` 生成 systemd 单元并写入 Caddy 站点片段：

```bash
sudo bash deploy/deploy.sh deploy/deploy.foodtestlab.conf
```

运维：

```bash
systemctl status foodtestlab-api
journalctl -u foodtestlab-api -f
curl http://127.0.0.1:3000/api/health
```

详见 [`../deploy/README.md`](../deploy/README.md) 与 [`../docs/DEVELOPMENT_GUIDE.md`](../docs/DEVELOPMENT_GUIDE.md)。
