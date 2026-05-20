# 同一服务器双系统部署防冲突指南

本指南用于以下场景：
- 同一台腾讯云服务器已经跑着一个系统（例如 `159.75.106.179:8080`）
- 你准备再部署本系统到另一个端口（例如 `159.75.106.179:8081`）
- 目标是避免 Nginx、Node、PM2、数据库、日志互相影响

## 1. 冲突来源总览

双系统同机常见冲突不是“开两个终端”，而是“资源重叠”：
- 端口冲突：两个服务抢同一个监听端口
- 进程名冲突：PM2 名称相同导致误重启
- 配置覆盖：Nginx 共用同一个 conf 被互相覆盖
- 数据冲突：共用同一数据库/同一表
- 路径冲突：共用同一个上传目录或日志目录
- 环境变量串用：部署时加载了另一套 `.env`

## 2. 强制隔离规则（必须执行）

建议固定如下资源矩阵：

| 资源 | 系统A（已存在） | 系统B（本系统） |
|---|---|---|
| 前端端口 | 8080 | 8081 |
| API端口 | 3000 | 3001 |
| PM2 名称 | rdpms-backend | foodtestlab-api |
| Nginx conf | /etc/nginx/conf.d/rdpms.conf | /etc/nginx/conf.d/foodtestlab.conf |
| 前端目录 | /var/www/rdpms | /var/www/foodtestlab |
| 后端目录 | /opt/rdpms/current | /opt/foodtestlab/current |
| 上传目录 | /data/rdpms/uploads | /data/foodtestlab/uploads |
| 日志目录 | /var/log/rdpms | /var/log/foodtestlab |

## 3. 数据库部署防冲突

如果两个系统都要做 SQL 部署：
- 不共用同一个数据库名
- 不共用同一个数据库用户
- 迁移脚本分开执行（禁止同时执行到同一库）
- 备份文件名带系统前缀（例如 `foodtestlab_YYYYMMDD.sql`）

推荐：
- 系统A维持原数据库
- 系统B使用独立数据库（或独立 schema）

## 4. Nginx 防冲突做法

- 每个系统单独一个 `server` 配置文件
- 每个系统单独监听端口
- `location /api/` 各自反代到自己的 Node 端口
- `access_log` 和 `error_log` 分文件

示例：
- 系统A: `listen 8080; proxy_pass http://127.0.0.1:3000;`
- 系统B: `listen 8081; proxy_pass http://127.0.0.1:3001;`

## 5. PM2 防冲突做法

- 应用名唯一（禁止重名）
- 环境变量文件独立
- 部署时先 `pm2 stop <app_name>` 再更新代码
- 重启时仅重启当前系统进程

## 6. 腾讯云控制台必须操作

在云服务器对应安全组新增规则：
- 入站 `TCP 8081`（系统B前端入口）
- 保留原有 `TCP 8080`
- 不对公网开放 `3001`

如果系统启用防火墙，还需在服务器本机放行：

```bash
# Ubuntu
sudo ufw allow 8081/tcp

# CentOS/RHEL
sudo firewall-cmd --add-port=8081/tcp --permanent
sudo firewall-cmd --reload
```

## 7. 推荐部署顺序（避免互相中断）

1. 停止系统B的 PM2 进程（不动系统A）
2. 拉取系统B代码并安装依赖
3. 执行系统B数据库迁移（仅系统B数据库）
4. 启动系统B PM2
5. 更新/重载系统B Nginx 配置
6. 验证 `8080` 和 `8081` 都可访问

## 8. 部署前检查清单

- [ ] `8080` 与 `8081` 未混用
- [ ] `3000` 与 `3001` 未混用
- [ ] PM2 应用名不重复
- [ ] Nginx conf 文件路径不重复
- [ ] 数据库连接串不是同一套
- [ ] `.env` 属于当前系统
- [ ] 安全组已放行新端口

## 9. 本仓库可用配套文件

- `deploy/nginx/foodtestlab-low-spec.conf`
- `deploy/pm2/ecosystem.config.cjs`
- `scripts/preflight-multi-app.sh`
- `docs/TENCENT_LOW_SPEC_DEPLOYMENT_TEMPLATE.md`

先执行预检脚本，再部署：

```bash
bash scripts/preflight-multi-app.sh
```
