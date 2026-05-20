# 腾讯云迁移开发文档（可执行版）

## 1. 文档定位

本文档不是概念说明，而是迁移作战手册。目标是让你按步骤执行，能把系统稳定迁到腾讯云，并且具备回滚能力。

当前迁移对象：

- 数据存储：Supabase
- 后端部署：Railway
- 前端部署：GitHub Pages

目标状态：

- 前端和后端都运行在腾讯云服务器
- 对外统一由 Nginx 提供入口
- 本系统使用独立端口运行后端，不和你另一个系统冲突
- 先完成部署迁移，再分阶段处理数据库迁移

## 2. 关键结论

迁移建议分两段执行。

### 阶段 1（必须先做）

只迁部署承载，不迁数据库：

- 前端从 GitHub Pages 迁到腾讯云
- 后端从 Railway 迁到腾讯云
- 后端继续连接现有 Supabase

### 阶段 2（条件满足后再做）

在完成“前端不再直连 Supabase、后端成为唯一数据入口”后，再迁数据库到腾讯云 PostgreSQL。

## 3. 当前系统真实现状

### 3.1 后端与 Supabase 强耦合

后端在 [backend/server.js](../backend/server.js) 中直接使用 Supabase SDK 执行业务查询和写入，属于直接耦合，不是可无缝切数据库的架构。

### 3.2 前端仍有直连 Supabase 遗留

以下文件显示前端仍存在直连模式：

- [js/utils/supabaseClient.js](../js/utils/supabaseClient.js)
- [js/core/Storage.js](../js/core/Storage.js)

同时可见硬编码 Supabase URL 和 Key，这属于迁移和安全双重风险。

### 3.3 SQL 资产不完整

当前可见 SQL 文件：

- [backend/sql/01_users_schema.sql](../backend/sql/01_users_schema.sql)
- [backend/sql/02_guests_schema.sql](../backend/sql/02_guests_schema.sql)
- [backend/sql/02_seed_test_users.sql](../backend/sql/02_seed_test_users.sql)

这些不足以定义完整生产库，说明“数据库整体迁移”不能在第一阶段做。

## 4. 参考项目可复用经验

已参考：

- [../../project-management/rdpms-system/README.md](../../project-management/rdpms-system/README.md)
- [../../project-management/specs/rpm-system/technical-design.md](../../project-management/specs/rpm-system/technical-design.md)

可复用点：

- 单机模式部署
- Nginx 统一入口
- 进程守护（PM2）
- 固定目录管理
- 启停脚本和备份脚本

不可直接照搬点：

- 参考项目偏 Windows Server 方案
- 当前仓库更适配 Linux 运维方式
- 当前项目数据层是 Supabase 体系，不是本地 SQLite

## 5. 目标架构与端口规划

### 5.1 推荐目标架构

```text
Internet
  -> Nginx :80/:443
      -> /         前端静态文件
      -> /api/     反向代理到 Node.js
  -> Node.js :3001（仅本机监听）
      -> Supabase（阶段1）
      -> 腾讯云 PostgreSQL（阶段2）
```

### 5.2 端口建议

- 另一个系统保留原端口
- 本系统后端固定用 3001（或 3101）
- 不直接暴露 3001 到公网
- 公网只开放 80、443

### 5.3 服务器安全组建议

- 入站放行：80/tcp、443/tcp、22/tcp（限制来源）
- 关闭或严格限制：3001/tcp
- SSH 仅允许办公公网 IP 或堡垒机

## 6. 迁移前准备清单（必须完成）

## 6.1 配置冻结

冻结当前线上配置，记录并归档：

- Railway 环境变量
- GitHub Pages 构建参数
- Supabase URL、Key、表结构、策略
- 当前 CORS 白名单
- 当前域名和证书状态

## 6.2 基线快照

执行并保存以下信息：

```bash
git rev-parse HEAD
git branch --show-current
npm -v
node -v
```

## 6.3 业务冒烟基线

在迁移前先跑一次关键流程并记录结果，作为迁移后对比基线：

- 管理员登录
- 新增检测记录
- 编辑记录
- 删除记录
- 统计页加载
- 访客登录与导出申请
- 审计日志查看

## 7. 阶段 1：部署迁移实施手册

## 7.1 服务器初始化（Ubuntu 22.04）

```bash
sudo apt update
sudo apt install -y nginx git curl build-essential

# 安装 Node.js 20
curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
sudo apt install -y nodejs

# 安装 PM2
sudo npm install -g pm2
```

校验：

```bash
node -v
npm -v
pm2 -v
nginx -v
```

## 7.2 目录规划与权限

```bash
sudo mkdir -p /srv/foodtestlab/{app,releases,shared/env,shared/logs,shared/backups,frontend_dist}
sudo chown -R $USER:$USER /srv/foodtestlab
```

## 7.3 拉取代码（runon_tencentcloud 分支）

```bash
cd /srv/foodtestlab/app
git clone -b runon_tencentcloud https://github.com/ArthurUker/Tianjiabing_foodtestlab.git .
```

## 7.4 安装依赖与构建

```bash
cd /srv/foodtestlab/app
npm ci
npm run build:prod
```

说明：

- 若仓库缺少 lock 文件导致 `npm ci` 失败，则改用 `npm install`
- 前端静态产物按项目实际输出目录放到 `/srv/foodtestlab/frontend_dist`

## 7.5 环境变量文件

创建：`/srv/foodtestlab/shared/env/.env.production`

示例：

```env
NODE_ENV=production
PORT=3001
CORS_ORIGIN=https://your-domain.com
SUPABASE_URL=https://your-project.supabase.co
SUPABASE_KEY=your-service-role-or-secure-server-key
JWT_SECRET=replace_with_long_random_secret
API_BASE_URL=https://your-domain.com
LOG_LEVEL=info
```

要求：

- 不允许把 Supabase Key 暴露到前端代码
- CORS 不允许 `*`（生产）
- `JWT_SECRET` 长度建议至少 32 字符

## 7.6 PM2 启动后端

```bash
cd /srv/foodtestlab/app
export $(grep -v '^#' /srv/foodtestlab/shared/env/.env.production | xargs)
pm2 start backend/server.js --name foodtestlab-api
pm2 save
pm2 startup
```

校验：

```bash
pm2 status
curl -s http://127.0.0.1:3001/health
```

## 7.7 Nginx 配置

创建配置：`/etc/nginx/sites-available/foodtestlab.conf`

```nginx
server {
    listen 80;
    server_name your-domain.com;

    root /srv/foodtestlab/frontend_dist;
    index index.html;

    access_log /var/log/nginx/foodtestlab.access.log;
    error_log /var/log/nginx/foodtestlab.error.log;

    location / {
        try_files $uri $uri/ /index.html;
    }

    location /api/ {
        proxy_pass http://127.0.0.1:3001/api/;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_read_timeout 60s;
    }

    location /health {
        proxy_pass http://127.0.0.1:3001/health;
    }
}
```

启用：

```bash
sudo ln -sf /etc/nginx/sites-available/foodtestlab.conf /etc/nginx/sites-enabled/foodtestlab.conf
sudo nginx -t
sudo systemctl reload nginx
```

## 7.8 HTTPS（建议当天完成）

```bash
sudo apt install -y certbot python3-certbot-nginx
sudo certbot --nginx -d your-domain.com
```

## 7.9 阶段 1 验收

验收项：

- 首页可访问
- `/health` 返回正常
- `/api/user/login` 登录正常
- CRUD 正常
- 审计日志正常
- 浏览器控制台无跨域错误
- 前端代码中无明文 Supabase Key

## 8. 阶段 1 回滚预案

触发条件（任一满足即回滚）：

- 连续 5 分钟核心 API 错误率 > 10%
- 登录成功率显著下降
- 数据写入出现连续失败

回滚动作：

1. DNS/流量切回旧环境（Railway + GitHub Pages）
2. 暂停腾讯云新实例对外入口
3. 保存腾讯云日志并定位问题
4. 修复后再执行灰度切换

需要提前准备：

- 旧环境仍保留可用
- 域名切流可在 5 分钟内完成
- 回滚联系人和值班表

## 9. 阶段 2：消除前端直连 Supabase

目标：前端只走后端 API。

## 9.1 必改文件范围

- [js/utils/supabaseClient.js](../js/utils/supabaseClient.js)
- [js/core/Storage.js](../js/core/Storage.js)
- 其他调用 Supabase REST 的模块

## 9.2 改造原则

- 浏览器端不出现 Supabase URL 和 Key
- 浏览器端不再使用 Supabase SDK
- 所有读写通过后端统一鉴权和审计

## 9.3 验收方法

- 全局搜索 `supabase.co`、`apikey`、`Bearer`（前端目录）
- 抓包确认前端请求全部发往 `/api/`
- 关键功能回归通过

## 10. 阶段 3：数据库迁移到腾讯云（可选）

前置条件（全部满足才启动）：

- 阶段 1 和阶段 2 稳定运行至少 1 周
- 前端已无直连 Supabase
- 完整导出 Supabase schema 和策略
- 数据迁移演练通过

## 10.1 迁移步骤

1. 导出 Supabase 全量结构（表、索引、函数、策略、触发器）
2. 在腾讯云 PostgreSQL 重建结构
3. 导入历史数据并做一致性校验
4. 改造后端数据访问层，支持新数据源
5. 双环境回归测试
6. 切流并观察

## 10.2 一致性校验建议

- 表行数对比
- 随机抽样数据字段对比
- 关键统计接口结果对比
- 登录与权限行为对比

## 11. 风险与防漏清单

### 高风险

- 前端明文 Supabase Key 泄露
- 前端仍直连 Supabase 导致访问链路不可控
- 生产 CORS 配置为 `*`

### 中风险

- Nginx 代理路径配置错误（`/api` 前缀丢失）
- PM2 环境变量未正确加载
- 域名切换时证书未就绪

### 低风险

- Ubuntu 基础组件安装
- PM2 启停
- Nginx 基础静态托管

## 12. 迁移过程检查表

## 12.1 上线前 D-3

- 配置冻结完成
- 环境变量清单完成
- 回滚预案确认
- 责任人和值班排班确认

## 12.2 上线前 D-1

- 腾讯云环境搭建完成
- Nginx 与 PM2 校验通过
- 阶段 1 联调通过
- 业务方确认迁移窗口

## 12.3 上线日

- 执行流量切换
- 30 分钟重点观测
- 2 小时持续观测
- 记录上线结果

## 12.4 上线后 D+1

- 错误日志审计
- 性能指标复盘
- 安全项复查

## 13. 常见故障处置

### 13.1 502 Bad Gateway

优先检查：

```bash
pm2 status
pm2 logs foodtestlab-api --lines 200
curl -s http://127.0.0.1:3001/health
sudo tail -n 200 /var/log/nginx/foodtestlab.error.log
```

### 13.2 CORS 报错

优先检查：

- `.env.production` 里的 `CORS_ORIGIN`
- Nginx 访问域名是否和 CORS 白名单一致
- 浏览器是否命中旧缓存

### 13.3 登录失败

优先检查：

- `JWT_SECRET` 是否加载
- Supabase URL/Key 是否正确
- 后端日志里是否有 Supabase 报错

## 14. 验收定义（DoD）

以下全部满足，阶段 1 才算完成：

- 腾讯云前端访问稳定
- 腾讯云后端运行稳定（24 小时无异常重启）
- 核心业务流程全部通过
- 前端无明文 Supabase Key
- 流量可以在 5 分钟内回滚
- 运维手册和联系人信息更新完成

## 15. 最终建议

最稳路径是：

1. 先迁部署到腾讯云（不迁数据库）
2. 再彻底去掉前端直连 Supabase
3. 最后按项目改造方式迁数据库

你另一个系统提供了非常好的部署模板，但这个系统的关键差异在于数据层耦合。先把数据访问路径收口到后端，迁移成功率会显著提高。