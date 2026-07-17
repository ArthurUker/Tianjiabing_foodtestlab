# 田家炳食品检验系统 · 开发/测试环境部署指南

> 适用环境：**开发 / 测试（dev/test）**
> 部署模式：**最简模式**（仅 `public` 共享 schema，不初始化多租户）
> 配套文件：`deploy/deploy.sh`（通用脚本） + `deploy/deploy.foodtestlab.conf`（本环境适配）
> 文档版本对应：PostgreSQL + Schema-per-tenant 方案②，dev/test 简化形态

---

## 0. 本文档范围与约定

- **什么时候看本文**：需要在腾讯云 CVM 上拉起一套用于开发联调、功能测试的 dev/test 实例。
- **与生产的区别**（见第 11 节）：生产会初始化学校租户（`SCHOOL_CODES` 非空）、绑定域名走 HTTPS（配 `DOMAIN`+`TLS_EMAIL`）、可能使用独立数据库实例。
- **术语**
  - *通用脚本* = `deploy/deploy.sh`：只负责部署流程，不含任何学校名 / 端口 / 路径硬编码。
  - *适配文件* = `deploy/deploy.foodtestlab.conf`：只描述「这一套环境长什么样」，改它即可适配新服务器 / 新用途。
- **本文默认你已经把 PostgreSQL 改造提交并推送到 GitHub `main` 分支**（当前 `main` 已是 `provider = "postgresql"`，服务器 `git clone` 会拉到正确版本）。

---

## 1. 目标架构与技术选型

| 层级 | 选型 | 说明 |
|------|------|------|
| 应用 | 单应用（Hono 后端 + 静态前端） | 无状态 JWT，统一经 Caddy 反代 |
| 数据库 | PostgreSQL（单实例） | 方案② Schema-per-tenant；**dev/test 仅用 `public` schema** |
| 反向代理 | Caddy | 无域名时监听 `:FRONTEND_PORT`（HTTP）；有域名自动申请 Let's Encrypt HTTPS |
| 进程托管 | systemd（原生） | 开机自启、崩溃重启；**不使用 PM2** |
| 运行时 | Node 20 LTS（NVM 安装）/ PostgreSQL / Caddy / Git | 脚本自动安装（Ubuntu 仓库 PG，22.04 为 PG14） |
| 代码来源 | GitHub `main` | 已 PostgreSQL 化，部署即拉即用 |

**dev/test 最简形态的数据落点**：所有业务表、用户表都建在 `public` schema 下，`SCHOOL_CODES` 留空，部署脚本会 `[SKIP]` 跳过学校 schema 初始化。后续要测试多租户，只需把学校代码填回适配文件重跑部署。

---

## 2. 服务器环境要求（本环境实测）

| 项目 | 值 |
|------|-----|
| 操作系统 | Ubuntu 22.04 LTS |
| 规格 | 2 vCPU / 3.5 GiB 内存 / 系统盘 49G + 数据盘 49G |
| 公网 IP | `111.231.166.161` |
| 内网 IP | `172.17.0.9` |
| 数据盘挂载点 | `/mnt/datadisk0` |
| 最低配置建议 | ≥1 vCPU / ≥2 GiB（脚本会按需开 swap） |

---

## 3. 前置准备（必须由人在腾讯云控制台 / 服务器完成）

> ⚠️ 这些脚本**管不了云平台网络与磁盘挂载**，必须手动确认，否则会出现「本机健康检查通过、外部浏览器访问超时」的假阳性。

### 3.1 安全组（最关键）
在腾讯云控制台，确认实例安全组已放行：

| 协议/端口 | 用途 | 是否必须 |
|-----------|------|----------|
| TCP 22 | SSH 登录 | ✅ 必须 |
| TCP 8080 | `FRONTEND_PORT`，Caddy 对外监听（**本环境无域名，监听 `:8080`**） | ✅ 必须 |
| TCP 443 | 加域名阶段再开 | ❌ 暂不开 |
| TCP 3000 | `API_PORT` 内部端口，仅 `127.0.0.1` | ❌ **不要对公网开放** |

> 注：README 里提到的「放行 80」只适用于 `DOMAIN` 为空且 `FRONTEND_PORT=80` 的场景；**本环境 `FRONTEND_PORT=8080`，请放行 8080**。

### 3.2 数据盘持久化挂载
本环境数据库与日志都放在数据盘 `/mnt/datadisk0`，脚本 `REQUIRED_MOUNT=/mnt/datadisk0` 会在未挂载时**直接中止**（防止数据静默写回系统盘）。

```bash
# 已挂载检查
findmnt -m /mnt/datadisk0

# 持久化检查（应能看到挂载条目）
grep datadisk0 /etc/fstab || echo "未配置持久化挂载，重启会丢失挂载点"
```
若未挂载，请先挂载并写入 `/etc/fstab`，再开始部署。

### 3.3 SSH 与出站网络
- **部署机（你的本地 macOS）需能 SSH 到服务器 root**：
  ```bash
  ssh cvm-ubuntu "echo reachable"
  ```
- **服务器需能访问外网**（脚本启动即预检，不通会提前中止）：
  - `https://github.com`（拉代码）
  - `https://registry.npmjs.org`（装 npm 依赖）

---

## 4. 部署文件说明

| 文件 | 作用 | 去向 |
|------|------|------|
| `deploy/deploy.sh` | 通用部署脚本 | 传到服务器 `/opt/deploy/`，不进代码仓库目录 |
| `deploy/deploy.foodtestlab.conf` | 本环境适配文件（dev/test 最简） | 同上 |

> ⚠️ 适配文件含公网 IP（`111.231.166.161`），目前已随代码推到 GitHub。IP 本就公开、风险低；若想规范，后续可改为「`.example` 进 git + 真实 conf 仅本地 scp」的模式。当前不影响部署。

---

## 5. 适配文件关键字段（dev/test 最简版）

`deploy.foodtestlab.conf` 中本环境的关键值：

| 字段 | 本环境值 | 说明 |
|------|----------|------|
| `SYSTEM_NAME` | `foodtestlab` | 驱动目录 `/opt/foodtestlab`、服务 `foodtestlab-api.service`、系统用户 `foodtestlab` |
| `REPO_URL` | `https://github.com/ArthurUker/Tianjiabing_foodtestlab.git` | 代码来源（已是 PostgreSQL 版本） |
| `DEPLOY_BRANCH` | `main` | |
| `REPO_ROOT` | `/opt/foodtestlab` | 代码（系统盘，小、需频繁 pull/构建） |
| `DATA_DIR` | `/mnt/datadisk0/foodtestlab/data` | 数据库（数据盘，与系统盘生命周期解耦） |
| `LOG_DIR` | `/mnt/datadisk0/foodtestlab/logs` | 日志（数据盘） |
| `API_PORT` | `3000` | 后端内部端口（仅 `127.0.0.1`，Caddy 反代到此） |
| `FRONTEND_PORT` | `8080` | 用户公网访问端口（Caddy 对外监听，**安全组需放行**） |
| `DOMAIN` | `""` | 无域名 → Caddy 监听 `:8080`（HTTP） |
| `DB_TYPE` | `postgresql` | 与 `schema.prisma` 的 `provider` 一致 |
| `CORS_ORIGIN` | `""` | 留空 → 脚本用 `ifconfig.me` 取公网 IP，生成 `http://111.231.166.161:8080` |
| `JWT_SECRET` | `""` | 留空 → 脚本自动生成强随机值 |
| `SEED_ADMIN_PASSWORD` 等 | `""` | 留空 → 脚本自动生成随机密码（部署末尾打印） |
| `INSTALL_RUNTIME` | `true` | 脚本自动装 Node/Caddy/PG/Git |
| `NODE_VERSION` | `20` | 安装的 Node LTS |
| `ENABLE_SWAP` | `true` | 3.5G 内存 + 0 swap，构建峰值需 swap 缓冲避免 OOM |
| `REQUIRED_MOUNT` | `/mnt/datadisk0` | 非空：未挂载则中止 |
| `ACCEPT_DATA_LOSS` | `true` | `prisma db push` 接受数据丢失（dev/test 可接受） |
| `SEED_ON_FIRST_DEPLOY` | `true` | 首部署执行 seed 初始化账号 |
| `PROVISION_TENANTS` | `true`（但空 codes 自动 SKIP） | 见下 |
| `SCHOOL_CODES` | `""` | ★**dev/test 最简开关**：留空 → 仅 `public` schema，不初始化任何学校 |

**最简模式判定逻辑**：`SCHOOL_CODES` 为空时，`provision-tenants.js` 会打印
`[SKIP] SCHOOL_CODES 为空，跳过多租户初始化（dev/test 仅用 public 共享 schema）`
并直接返回，不会创建 `school_<code>` schema。

---

## 6. 部署步骤

### 6.1 本地（部署机）上传部署文件
> 部署脚本与适配文件不进代码仓库目录，单独维护在服务器 `/opt/deploy/`。

```bash
# 建目录并上传（从本仓库根目录执行）
ssh cvm-ubuntu "mkdir -p /opt/deploy"
scp deploy/deploy.sh deploy/deploy.foodtestlab.conf cvm-ubuntu:/opt/deploy/
```

### 6.2 服务器一键部署
```bash
ssh cvm-ubuntu
sudo bash /opt/deploy/deploy.sh /opt/deploy/deploy.foodtestlab.conf
```

### 6.3 脚本自动执行顺序（了解即可，无需手动干预）
1. 加载并校验适配文件（缺必填字段立即中止）。
2. 检查本机 `curl` 外网（github.com / registry.npmjs.org），不通提前中止。
3. 检查数据盘挂载（`REQUIRED_MOUNT` 未挂则中止）。
4. 探测内存/CPU，自适应决定 swap 与后端 `MemoryMax`（脚本按服务器规格自动规划）。
5. 安装运行时：Git / Caddy / Node(NVM 20) / PostgreSQL，并建库、建应用角色。
6. 数据盘就绪后，将 PG 数据目录迁移到 `$DATA_DIR/pgdata`（软链，对 PG 透明）。
7. 生成 `backend/.env`（随机 `JWT_SECRET`、`SEED_*` 密码、`DATABASE_URL`）。
8. `git clone/pull` `main` 到 `REPO_ROOT`（已是 PostgreSQL 代码）。
9. `npm ci` + `prisma generate` + `prisma db push --accept-data-loss`。
10. **首部署**执行 `seed.js` 初始化 `admin` / `operator` / `viewer` 账号。
11. **多租户初始化**：`SCHOOL_CODES` 为空 → `[SKIP]`（仅 `public` schema）。
12. 前端构建 `scripts/build-static.js`（无需 `npm install` 前端依赖）。
13. 写 systemd 单元 `foodtestlab-api.service` + Caddy 站点片段 `/etc/caddy/sites/foodtestlab-api.caddy`。
14. 健康检查 `http://127.0.0.1:3000/api/health`（最多等待约 60s）。
15. 收尾打印初始账号密码。

---

## 7. 验证部署

**服务器内检查：**
```bash
# 后端服务状态
systemctl status foodtestlab-api

# 后端日志（实时）
journalctl -u foodtestlab-api -f

# 健康检查（应返回 200）
curl -s -o /dev/null -w "%{http_code}\n" http://127.0.0.1:3000/api/health

# Caddy 状态
systemctl status caddy
```

**公网访问（浏览器）：**
```
http://111.231.166.161:8080
```

**登录：**
- 用户名：`admin`
- 密码：部署脚本**末尾打印的随机密码**（首登录后请立即修改）
- 无需选择学校（dev/test 走 `public` schema）

---

## 8. 常见问题排查

| 现象 | 可能原因 | 处理 |
|------|----------|------|
| 本机 `curl` 健康通过，外部浏览器超时 | 安全组未放行 `8080` | 腾讯云控制台放行 TCP 8080 |
| 脚本启动即报「无法访问 github.com」 | 服务器出站受限 | 检查安全组 / 网络连通性 |
| 脚本中止「REQUIRED_MOUNT 未挂载」 | 数据盘未挂载 | 先挂载 `/mnt/datadisk0` 并写入 `/etc/fstab` |
| `prisma db push` 失败 | PG 未起 / `DATABASE_URL` 错 | `journalctl -u postgresql` 排查 |
| Caddy 启动失败 | 站点片段配置错误 | `caddy validate --config /etc/caddy/Caddyfile` |
| 「前端端口已被占用」 | 同机其他用户抢占 `FRONTEND_PORT` | 换一个 `FRONTEND_PORT`（同机须唯一） |
| 页面 404 / 白屏 | 前端未构建或 root 指向错 | 确认 `dist/index.html` 存在、Caddy `root` 指向 `/opt/foodtestlab/dist` |

---

## 9. 后续开发迭代（代码更新）

开发流程：本地改代码 → `git push origin main` → 服务器重跑同一条部署命令。

```bash
# 在服务器上重跑即可平滑更新
sudo bash /opt/deploy/deploy.sh /opt/deploy/deploy.foodtestlab.conf
```
脚本会：`git fetch + reset` 拉最新 → 重装依赖 → `prisma generate` + `db push` → 重建前端 → 平滑重启服务。`backend/.env` 会被保留（不在 `git clean` 范围），但部署会按适配文件重写关键变量。

> ⚠️ 重跑会执行 `prisma db push --accept-data-loss`；开发期可接受，生产环境请谨慎（关闭 `ACCEPT_DATA_LOSS` 或先备份）。

---

## 10. dev/test 环境使用说明

- **登录无需选择学校**：`SCHOOL_CODES` 为空，所有请求走 `public` schema。
- **测试数据清理**：所有数据都在 `public`，可直接清表重来或重新部署。
- **测试多租户**：把 `SCHOOL_CODES` 填上学校代码（如 `tianjiabing`）并补 `SCHOOL_NAME_<code>`，重跑部署 → 脚本会创建 `school_<code>` schema、推送业务表、写 `public` 系统记录、建租户 admin。

---

## 11. 从 dev/test 升级到生产（未来）

| 维度 | dev/test（当前） | 生产（未来） |
|------|------------------|--------------|
| 多租户 | `SCHOOL_CODES=""`，仅 `public` | 填学校代码，初始化 `school_<code>` |
| 访问方式 | `http://IP:8080` | 绑域名 `DOMAIN` + `TLS_EMAIL` → 自动 HTTPS |
| 安全组 | 22 / 8080 | 加 443 |
| 数据丢失 | `ACCEPT_DATA_LOSS=true` | 建议改为 `false`（观察模式）或做好备份 |
| 数据库 | 单实例共享 | 建议独立实例 / 更强隔离 |

升级步骤：修改适配文件对应字段 → 重跑部署命令即可，脚本会平滑切换。

---

## 12. 附录：相关文件索引

| 文件 | 作用 |
|------|------|
| `deploy/deploy.sh` | 通用部署脚本（流程编排） |
| `deploy/deploy.foodtestlab.conf` | 本环境适配文件（dev/test 最简） |
| `deploy/README.md` | 通用部署方案说明 |
| `backend/prisma/schema.prisma` | 数据库 schema（`provider = "postgresql"`） |
| `backend/prisma/provision-tenants.js` | 多租户首部署初始化（空 `SCHOOL_CODES` 时 SKIP） |
| `backend/prisma/seed.js` | 初始账号 seed |
| `scripts/build-static.js` | 前端静态构建（仅 Node 内置模块，无需 npm install） |
| `backend/lib/tenantProvisioner.js` | 单校 schema 初始化（运行时动态建校共用） |

### 适配文件完整参考（dev/test 最简版）

```bash
# 系统标识
SYSTEM_NAME="foodtestlab"
# 代码来源
REPO_URL="https://github.com/ArthurUker/Tianjiabing_foodtestlab.git"
DEPLOY_BRANCH="main"
GIT_CLONE_DEPTH=1
# 目录布局
REPO_ROOT="/opt/${SYSTEM_NAME}"
DATA_DIR="/mnt/datadisk0/${SYSTEM_NAME}/data"
LOG_DIR="/mnt/datadisk0/${SYSTEM_NAME}/logs"
# 端口与服务名
API_PORT=3000
FRONTEND_PORT=8080
APP_NAME="${SYSTEM_NAME}-api"
# 公网暴露（无域名 → :8080）
DOMAIN=""
TLS_EMAIL=""
# 数据库
DB_TYPE="postgresql"
DATABASE_URL=""
# 跨域（留空自动推断为公网 IP:8080）
CORS_ORIGIN=""
# 安全密钥（留空自动生成）
JWT_SECRET=""
SEED_ADMIN_PASSWORD=""
SEED_OPERATOR_PASSWORD=""
SEED_VIEWER_PASSWORD=""
JWT_EXPIRE="7d"
# 运行时
INSTALL_RUNTIME=true
NODE_VERSION="20"
ENABLE_SWAP=true
SWAP_SIZE_GB=2
# 数据盘前置检查
REQUIRED_MOUNT="/mnt/datadisk0"
# 数据库初始化
ACCEPT_DATA_LOSS=true
SEED_ON_FIRST_DEPLOY=true
# 多租户（dev/test 最简：留空 → 仅 public schema）
PROVISION_TENANTS=true
SCHOOL_CODES=""
# 前端构建
FRONTEND_NPM_INSTALL=false
```
