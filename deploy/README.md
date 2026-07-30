# 通用部署方案说明（deploy/）

## 目标
把原来写死在 `deploy.ps1`（Windows、珠海一中专用）的部署逻辑，改成：
- **一份通用脚本 `deploy.sh`**：只负责部署流程，不含任何学校名 / 端口 / 路径硬编码。
- **一份适配文件 `deploy.<系统名>.conf`**：只描述“这一套环境长什么样”。换用户、换服务器、换系统，只改适配文件。

## 文件清单
| 文件 | 作用 |
|------|------|
| `deploy.sh` | 通用部署脚本（bash，适配 Ubuntu 22.04/24.04） |
| `deploy.adapter.example.conf` | 适配文件模板，复制后改名填写 |
| `README.md` | 本说明 |

> 旧的 `deploy.ps1` 保留不动，仅用于原有 Windows 服务器。新 CVM（Linux）用 `deploy.sh`。

## 技术选型（依据你的选择）
- 操作系统：Ubuntu 22.04/24.04 LTS
- 反向代理：Caddy（有域名自动申请 Let's Encrypt HTTPS；无域名先监听 `:80`）
- 进程托管：**systemd**（Linux 原生，开机自启；已确定不用 PM2）
- 数据库：PostgreSQL（单实例，多学校按 schema 隔离；开发/测试/生产统一）
- 运行时：脚本自动安装（NVM 装 Node 20 LTS + Caddy + Git）

## ⚠️ 部署前置（必须手动完成，脚本无法代劳）
1. **腾讯云安全组**：脚本只管 OS 内部监听，不碰云平台网络。请登录腾讯云控制台，确认实例安全组已放行 **TCP 22 / 80**（补域名后还需 **443**）。漏配会导致「本机 `curl 127.0.0.1` 健康检查通过，但外部浏览器访问超时」的假阳性。
2. **数据盘持久化挂载**：若 `DATA_DIR` 指向独立数据盘（如 `/mnt/datadisk0`），请确认它已写入 `/etc/fstab` 持久化。脚本会检查该挂载点是否存在，未挂载则**直接中止**（不静默写回系统盘）。
   ```bash
   grep datadisk0 /etc/fstab || echo "未配置持久化挂载，重启会丢失挂载点"
   ```
3. **外网出站**：脚本启动即预检 `github.com` 与 `registry.npmjs.org` 连通性，不通会提前中止，避免跑到一半才发现拉不到代码/依赖。

## 多用户同机部署（不同端口访问）
同一台服务器可以给多个用户 / 多套系统各自独立部署，互不干扰：
- 每个用户一份独立适配文件 `deploy.<用户>.conf`，其中 **`FRONTEND_PORT`（公网访问端口）与 `API_PORT`（后端端口）必须全服务器唯一**。
- 目录天然隔离：`REPO_ROOT` / `DATA_DIR` / `LOG_DIR` 都按 `SYSTEM_NAME` 区分。
- systemd 服务按 `APP_NAME` 区分，互不影响。
- Caddy 采用 **主配置 `import` 站点目录** 模式：每个用户一份 `/etc/caddy/sites/<APP_NAME>.caddy` 片段，互不覆盖；新增 / 重跑某用户不会冲掉其它用户的站点。
- 脚本会**预检端口冲突**（扫描已有 Caddy 站点片段与监听端口），撞端口直接中止。
- 每个用户的 `FRONTEND_PORT` 都需在腾讯云安全组单独放行。

新增一个用户只需：复制适配文件 → 改 `SYSTEM_NAME` / `FRONTEND_PORT` / `API_PORT` / 各目录 → 重跑 `sudo bash deploy.sh deploy.<新用户>.conf`。

## 在腾讯云新 CVM 上的使用步骤
1. 买好 CVM，安全组放行 **22**（SSH）、**80**（HTTP；若用域名还要 **443**）。
2. SSH 登录，把两个文件传上去（放在 `/opt/deploy/` 之类稳定目录，**不要放进代码仓库目录**）：
   ```bash
   scp deploy/deploy.sh deploy/deploy.adapter.example.conf root@<公网IP>:/opt/deploy/
   ```
3. 复制并填写适配文件：
   ```bash
   cd /opt/deploy
   cp deploy.adapter.example.conf deploy.foodtestlab.conf
   vim deploy.foodtestlab.conf   # 至少确认 SYSTEM_NAME / REPO_URL / DEPLOY_BRANCH / API_PORT
   ```
4. 一键部署：
   ```bash
   sudo bash deploy.sh /opt/deploy/deploy.foodtestlab.conf
   ```

## 适配文件关键字段
| 字段 | 含义 |
|------|------|
| `SYSTEM_NAME` | 系统标识，驱动目录/服务名/用户名（如 `foodtestlab` → `/opt/foodtestlab`、`foodtestlab-api.service`、用户 `foodtestlab`） |
| `REPO_URL` / `DEPLOY_BRANCH` | 代码来源与分支 |
| `API_PORT` | 后端内部端口（127.0.0.1），Caddy 反代到此 |
| `FRONTEND_PORT` | 用户公网访问端口（Caddy 对外监听），全服务器必须唯一 |
| `DOMAIN` / `TLS_EMAIL` | 留空 = 仅 HTTP `:80`；填了 = 自动 HTTPS |
| `JWT_SECRET` / `SEED_*_PASSWORD` | 留空则脚本自动生成强随机值 |
| `INSTALL_RUNTIME` | `true` 时脚本自动装 Node/Caddy/Git |
| `ENABLE_SWAP` | `true` 强制开 / `false` 不开 / `auto` 内存<2G 自动开 |
| `SERVICE_MEMORY_MAX` | 后端内存上限(MB)；留空=按服务器内存自适应 |
| `REQUIRED_MOUNT` | 数据盘挂载点；非空时未挂载则中止，防止数据静默写回系统盘 |
| `ACCEPT_DATA_LOSS` | `prisma db push` 是否接受数据丢失（`false` 为观察模式） |
| `PROVISION_TENANTS` | `true` 时首部署初始化多租户：为每个学校建 `school_<code>` schema、推业务表、写 `public` 系统记录、建租户 admin |
| `SCHOOL_CODES` | 逗号分隔的学校代码（如 `tianjiabing`）；留空 = 仅用 `public` 共享 schema（dev/test 最简模式） |
| `SCHOOL_NAME_<code>` | 可选，学校显示名；如 `SCHOOL_NAME_tianjiabing="田家炳食品检验实验室"` |

## 按服务器性能自适应（无需手动调参）
脚本启动即探测内存/CPU，自动决定资源规划（适配文件可覆盖）：

| 服务器内存 | 是否开 swap | 后端 MemoryMax | Node 堆上限 |
|-----------|------------|----------------|-------------|
| ≤ 1G      | 自动开     | 384M           | 288M        |
| ≤ 2G      | 自动开     | 768M           | 576M        |
| ≤ 4G      | 否         | 1024M          | 768M        |
| > 4G      | 否         | 1536M          | 1152M       |

- 内存上限通过 `systemd MemoryMax` + `NODE_OPTIONS=--max-old-space-size` 双重约束，低配机不会因构建/`prisma generate` 把内存吃爆。
- 若服务器挂了独立数据盘，把适配文件里的 `DATA_DIR` 指向数据盘挂载点（如 `/data/<名>`）。脚本在 PostgreSQL 启动后会**自动把 PG 数据目录迁移到 `$DATA_DIR/pgdata`**（用软链替还原路径，对 PG 透明），系统盘只放代码。仅当配置了 `REQUIRED_MOUNT` 时才迁移。

## 后续加域名（切 HTTPS）
在适配文件填 `DOMAIN=你的域名`、`TLS_EMAIL=你的邮箱`，重跑：
```bash
sudo bash deploy.sh /opt/deploy/deploy.foodtestlab.conf
```
脚本会生成带 `email` 全局块的 Caddyfile 并自动签发证书（需域名 A 记录指向公网 IP、安全组放行 443）。

## 重新部署 / 更新代码
同一台机器上重跑同一个命令即可：脚本会 `git fetch + reset` 拉最新代码、重装依赖、重建前端、平滑重启服务。`backend/.env` 会被保留（不在 `git clean` 范围），但部署会按适配文件重写关键变量。

## 故障排查
- 后端起不来：`journalctl -u <APP_NAME> -n 50`
- Caddy 配置有误：`caddy validate --config /etc/caddy/Caddyfile`
- 健康检查失败但没报错：后端可能还在启动，等一会再 `curl http://127.0.0.1:<API_PORT>/api/health`

## ⚠️ 已知限制（切换多实例部署前必读）

### 安全事件告警扫描器假设单实例运行
- **位置**：`backend/lib/securityAlerts.js`（`SECURITY:*` 事件定时扫描 + webhook 推送）。
- **限制**：扫描游标（"已处理到 SystemLog 哪条记录"）保存在**进程内存**，未落共享存储。
- **当前无影响**：本部署方案为 systemd 单进程托管（已确定不用 PM2），单实例下行为完全正确。
- **触发条件（何时必须处理）**：当决定引入 **PM2 cluster 模式**或**多机 / 多进程部署**时，
  **必须先**把扫描游标改造为共享存储协调，否则每个实例都会各自扫描同一张
  `public.SystemLog` 并各自推送，同一批安全事件被重复告警 N 次（N=实例数），
  造成告警疲劳，反而掩盖真正需要关注的信号。
- **推荐改造方案**：新建极简数据库租约表（如 `alert_scanner_lease`：
  `id` / `holder_id` / `lease_expires_at`），实例扫描前用
  `INSERT ... ON CONFLICT DO UPDATE ... WHERE lease_expires_at < NOW()`
  原子抢占过期租约，仅租约持有者执行扫描与推送；租约 TTL 取扫描间隔的 2-3 倍并定期续约。
- **由谁审视**：执行多实例改造的开发/运维负责人，在改动进程托管方式（systemd 单元、
  引入 PM2、加实例数）的评审阶段主动检索本节；`securityAlerts.js` 模块顶部注释有同样声明作双保险。
- **同源原则**：任何跨请求/跨进程判断状态的数据（token 吊销记录、登录失败计数、本扫描游标）
  必须放数据库或 Redis 等共享存储，不能用进程内存 Map/变量（参见 TD-P2-14 / TD-P2-15）。
