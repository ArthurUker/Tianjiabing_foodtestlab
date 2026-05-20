# 食品系统一键部署操作指南

本指南说明如何使用 `scripts/deploy.sh` 脚本在腾讯云服务器上一键部署食品检验系统。

## 1. 前置条件（必须先完成）

在服务器上确保已安装以下工具：
- Node.js >= 18（推荐 LTS）
- npm >= 8
- Git
- PM2（全局安装）
- Nginx
- curl（用于健康检查）

快速安装脚本：
```bash
# Ubuntu 22.04 / Debian 12
sudo apt update
sudo apt install -y git curl build-essential

# Node.js 20
curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
sudo apt install -y nodejs

# PM2（全局）
sudo npm install -g pm2

# Nginx
sudo apt install -y nginx
sudo systemctl enable nginx
```

## 2. 目录结构规划

部署时，建议按以下目录规划部署：

```bash
# 代码目录
/opt/foodtestlab/current          # 当前运行版本

# 数据目录
/data/foodtestlab/
├── uploads/                       # 用户上传文件
└── db/                           # 数据库文件（如果用 SQLite）

# 前端静态文件（由 Nginx 提供）
/var/www/foodtestlab/
├── index.html
├── login.html
├── js/
├── css/
└── assets/

# 日志目录
/var/log/foodtestlab/
├── api.log
├── error.log
└── deploy.log

# PM2 进程管理
~/.pm2/logs/                      # PM2 日志自动放这里
```

初始化目录：
```bash
sudo mkdir -p /opt/foodtestlab/current
sudo mkdir -p /data/foodtestlab/{uploads,db}
sudo mkdir -p /var/www/foodtestlab
sudo mkdir -p /var/log/foodtestlab
sudo chown -R $USER:$USER /opt/foodtestlab /data/foodtestlab /var/www/foodtestlab /var/log/foodtestlab
```

## 3. 代码拉取与初始化

```bash
cd /opt/foodtestlab/current

# 第一次部署：克隆仓库
git clone -b runon_tencentcloud https://github.com/ArthurUker/Tianjiabing_foodtestlab.git .

# 或后续更新：拉取最新代码
git fetch origin
git reset --hard origin/runon_tencentcloud
```

## 4. 环境变量配置

复制示例文件并编辑：
```bash
cp .env.example .env

# 编辑 .env，至少需要配置：
nano .env
```

关键变量：
```env
NODE_ENV=production
PORT=3001
SERVE_STATIC=false
CORS_ORIGIN=http://159.75.106.179:8081
SUPABASE_URL=https://your-project.supabase.co
SUPABASE_KEY=your-anon-key
JWT_SECRET=your-very-long-secret-key-here
JWT_EXPIRE=7d
```

## 5. 一键部署（核心步骤）

### 5.1 运行部署脚本

```bash
cd /opt/foodtestlab/current
bash scripts/deploy.sh
```

脚本将自动执行：
1. ✅ 双系统冲突预检
2. ✅ 拉取最新代码（自动重试）
3. ✅ 清理旧 node_modules
4. ✅ 安装后端依赖
5. ✅ 执行 Prisma 迁移
6. ✅ 安装前端依赖
7. ✅ 构建前端静态文件
8. ✅ PM2 启动/重启后端
9. ✅ Nginx 配置重载
10. ✅ 健康检查

### 5.2 环境变量自定义

如果需要覆盖默认配置，可使用环境变量：

```bash
# 自定义前端端口、API 端口、PM2 名称
FRONTEND_PORT=8082 \
API_PORT=3002 \
PM2_APP_NAME=foodtestlab-api-v2 \
NGINX_CONF=/etc/nginx/conf.d/foodtestlab-v2.conf \
bash scripts/deploy.sh
```

## 6. 部署后验证

### 6.1 API 健康检查

```bash
# 本机 API 检查
curl -s http://127.0.0.1:3001/api/health | jq

# 公网 Nginx 反代检查
curl -s http://159.75.106.179:8081/api/health | jq
```

### 6.2 前端访问

```bash
# 浏览器访问
open http://159.75.106.179:8081
```

### 6.3 PM2 进程检查

```bash
pm2 list
pm2 logs foodtestlab-api
```

### 6.4 Nginx 配置检查

```bash
sudo nginx -t
sudo systemctl status nginx
```

## 7. 常见问题排查

### "端口已占用"

```bash
# 查看占用端口的进程
lsof -nP -iTCP:8081 -sTCP:LISTEN
lsof -nP -iTCP:3001 -sTCP:LISTEN

# 杀死进程（谨慎！）
pkill -f "node.*server.js"
pm2 kill
```

### "Git 拉取失败"

脚本有自动重试机制，如果仍失败：
```bash
cd /opt/foodtestlab/current
git fetch origin --dry-run  # 测试连接
git status
```

### "npm 安装失败"

```bash
# 清理缓存
npm cache clean --force

# 升级 npm
npm install -g npm@latest

# 重新安装
npm ci --prefer-offline
```

### "Prisma 迁移失败"

```bash
cd backend
npx prisma db push --skip-generate --accept-data-loss
```

## 8. 日志位置

部署日志：
- 脚本输出：`/tmp/foodtestlab-deploy-*.log`
- PM2 日志：`~/.pm2/logs/foodtestlab-api-*.log`
- 系统日志：`/var/log/foodtestlab/`
- Nginx 日志：`/var/log/nginx/access.log` 和 `error.log`

查看日志：
```bash
# 最新部署日志
tail -100f /tmp/foodtestlab-deploy-*.log

# PM2 日志
pm2 logs foodtestlab-api

# 系统日志
tail -100f /var/log/foodtestlab/*.log
```

## 9. 回滚方案

如果部署失败，虽然脚本没有自动回滚，但 Git 历史还在：

```bash
# 查看之前的版本
git log --oneline

# 回滚到之前的版本
git reset --hard <commit-hash>

# PM2 重启
pm2 restart foodtestlab-api
```

## 10. 腾讯云安全组配置

在腾讯云控制台确保已放行：
- ✅ 入站 `TCP 8081`（前端）
- ✅ 入站 `TCP 22`（SSH，限制来源）
- ❌ 不开放 `TCP 3001`（内部 API）

## 11. Nginx 配置验证

确保 `/etc/nginx/conf.d/foodtestlab.conf` 内容如下：

```bash
sudo cat /etc/nginx/conf.d/foodtestlab.conf
```

应该包含：
- `listen 8081;`
- `proxy_pass http://127.0.0.1:3001;`
- 正确的静态文件路径和 CORS 配置

参考：[deploy/nginx/foodtestlab-low-spec.conf](../deploy/nginx/foodtestlab-low-spec.conf)

## 12. 定时自动部署（可选）

使用 cron 定时运行部署：

```bash
# 编辑 crontab
crontab -e

# 示例：每天凌晨 2 点部署
0 2 * * * cd /opt/foodtestlab/current && bash scripts/deploy.sh >> /var/log/foodtestlab/cron-deploy.log 2>&1
```

## 13. 快速命令参考

```bash
# 部署
cd /opt/foodtestlab/current && bash scripts/deploy.sh

# 查看状态
pm2 list

# 查看日志
pm2 logs foodtestlab-api

# 重启后端
pm2 restart foodtestlab-api

# 停止后端
pm2 stop foodtestlab-api

# 重载 Nginx
sudo systemctl reload nginx

# 查看 API 状态
curl http://127.0.0.1:3001/api/health | jq
```

## 14. 支持和反馈

如遇问题，请提供：
1. 部署日志文件路径
2. PM2 日志
3. 服务器环境信息（`uname -a`, `node -v`, `npm -v`）
4. 错误信息的完整输出
