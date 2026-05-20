# 腾讯云低配部署模板（轻后端，重前端）

本模板用于当前系统的生产部署重构：
- 前端改为静态托管（Nginx 或 COS）
- 后端仅负责 /api（认证、存储、鉴权）
- 一次性配置反向代理、缓存头、跨域

同机双系统防冲突指导请配套阅读：
- `docs/SERVER_MULTI_APP_CONFLICT_AVOIDANCE_GUIDE.md`
- 预检脚本：`scripts/preflight-multi-app.sh`

适配你的当前场景（无私有域名）：
- 公网 IP：`159.75.106.179`
- 已有系统：`159.75.106.179:8080`
- 本系统新增前端端口：`159.75.106.179:8081`

## 1. 目录建议

```bash
/opt/foodtestlab/current
├── backend/
├── js/
├── css/
├── index.html
└── login.html

/var/www/foodtestlab
├── index.html
├── login.html
├── js/
└── css/
```

说明：
- `/var/www/foodtestlab` 只放前端静态文件。
- Node 进程只启动 `backend/server.js`，监听 `127.0.0.1:3001`。

## 2. 后端环境变量（生产）

参考项目根目录 `.env.example`，生产推荐：

```env
NODE_ENV=production
PORT=3001
SERVE_STATIC=false
CORS_ORIGIN=http://159.75.106.179:8081
SUPABASE_URL=...
SUPABASE_KEY=...
JWT_SECRET=...
JWT_EXPIRE=7d
```

## 3. PM2 启动

使用模板：`deploy/pm2/ecosystem.config.cjs`

```bash
cd /opt/foodtestlab/current
pm2 start deploy/pm2/ecosystem.config.cjs
pm2 save
pm2 startup
```

部署前先执行冲突预检：

```bash
bash scripts/preflight-multi-app.sh
```

## 4. Nginx 配置

使用模板：`deploy/nginx/foodtestlab-low-spec.conf`

```bash
sudo cp deploy/nginx/foodtestlab-low-spec.conf /etc/nginx/conf.d/foodtestlab.conf
sudo nginx -t
sudo systemctl reload nginx
```

## 5. 联调检查

```bash
# API 健康检查
curl -s http://127.0.0.1:3001/api/health

# Nginx 反代检查
curl -I http://159.75.106.179:8081/api/health

# 前端首页
curl -I http://159.75.106.179:8081/
```

## 6. 腾讯云控制台必须新增端口

你提到需要在腾讯云后台新增端口，这一步必须做。

安全组（云服务器控制台）：
- 入站新增：`TCP 8081`，来源 `0.0.0.0/0`（或你的办公出口 IP）
- 保留已有：`TCP 8080`
- 建议不要开放：`TCP 3001`（后端只本机监听）

如果服务器同时开了系统防火墙（Ubuntu UFW）：

```bash
sudo ufw allow 8081/tcp
sudo ufw status
```

如果是 CentOS/RHEL firewalld：

```bash
sudo firewall-cmd --add-port=8081/tcp --permanent
sudo firewall-cmd --reload
sudo firewall-cmd --list-ports
```

## 7. COS 静态托管（可选）

如果前端放 COS + CDN：
- 将 `CORS_ORIGIN` 设置为实际 CDN 域名。
- Nginx 只保留 `/api` 站点或改用 API 子域名（如 `api.foodlab.example.com`）。
- 前端请求统一使用 `https://api.foodlab.example.com/api/...`。

## 8. 为什么这套更适合低配腾讯云

- Node 不再提供静态文件，CPU 与连接压力更小。
- Nginx/COS 托管静态资源并利用缓存，节省带宽与计算。
- 前端本地执行大部分 UI 与数据处理，服务端只做必要业务。
