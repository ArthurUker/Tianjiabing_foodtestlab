# 🔧 食品安全系统 - 运维手册

**文档版本**: 3.1  
**最后更新**: 2026-04-24  
**维护团队**: DevOps / SRE

---

## 📚 目录

1. [系统架构](#系统架构)
2. [启动和停止](#启动和停止)
3. [日常维护](#日常维护)
4. [监控和告警](#监控和告警)
5. [故障排查](#故障排查)
6. [备份和恢复](#备份和恢复)
7. [性能优化](#性能优化)
8. [安全维护](#安全维护)
9. [SLA 和报表](#sla-和报表)

---

## 🏗️ 系统架构

### 整体架构

```
用户 (Web/Mobile)
    ↓
负载均衡器 (Nginx/LB)
    ↓
┌──────────────────────────────────┐
│   应用层 (Docker Container)       │
│   Node.js + Express + React       │
└──────────────────────────────────┘
    ↓
┌──────────────────────────────────┐
│   数据层                          │
│   ├─ PostgreSQL (主数据库)        │
│   ├─ Redis (缓存)                 │
│   └─ Elasticsearch (日志)         │
└──────────────────────────────────┘
    ↓
┌──────────────────────────────────┐
│   监控和告警                      │
│   ├─ Prometheus (指标)            │
│   ├─ Grafana (仪表板)             │
│   ├─ AlertManager (告警)          │
│   └─ Jaeger (追踪)                │
└──────────────────────────────────┘
```

### 服务清单

| 服务 | 端口 | 状态检查 | 说明 |
|------|------|---------|------|
| 应用 | 3000 | http://localhost:3000/health | Node.js 应用 |
| 数据库 | 5432 | psql -U postgres | PostgreSQL |
| Redis | 6379 | redis-cli ping | 缓存 |
| Prometheus | 9090 | http://localhost:9090 | 指标收集 |
| Grafana | 3000 | http://localhost:3000 | 可视化 |
| Elasticsearch | 9200 | curl localhost:9200 | 日志 |
| Kibana | 5601 | http://localhost:5601 | 日志查询 |

---

## 🚀 启动和停止

### 启动应用

#### 方式 1: Docker Compose

```bash
# 启动所有服务
docker-compose up -d

# 检查状态
docker-compose ps

# 查看日志
docker-compose logs -f app
```

#### 方式 2: Kubernetes

```bash
# 部署应用
kubectl apply -f k8s/deployment.yaml

# 检查 Pod 状态
kubectl get pods

# 查看日志
kubectl logs -f deployment/foodtestlab
```

#### 方式 3: systemd 服务

```bash
# 启动服务
systemctl start foodtestlab

# 查看状态
systemctl status foodtestlab

# 查看日志
journalctl -f -u foodtestlab
```

### 停止应用

```bash
# Docker Compose
docker-compose down

# Kubernetes
kubectl delete deployment foodtestlab

# systemd
systemctl stop foodtestlab
```

### 重启应用

```bash
# Docker Compose
docker-compose restart app

# Kubernetes
kubectl rollout restart deployment/foodtestlab

# systemd
systemctl restart foodtestlab
```

---

## 🛠️ 日常维护

### 每日检查

```bash
#!/bin/bash

# 应用健康检查
curl -s http://localhost:3000/health | jq .

# 数据库连接
psql -U postgres -d foodtestlab -c "SELECT 1;"

# Redis 连接
redis-cli ping

# 磁盘空间
df -h

# 内存使用
free -h

# CPU 使用
top -n 1
```

**目标**:
- ✅ 应用健康
- ✅ 数据库正常
- ✅ 磁盘使用 < 80%
- ✅ 内存使用 < 80%
- ✅ 无错误日志

### 每周任务

- [ ] 运行完整性检查 (包含性能测试)
- [ ] 审查错误日志
- [ ] 检查备份状态
- [ ] 验证监控告警
- [ ] 更新文档

### 每月任务

- [ ] 执行安全补丁更新
- [ ] 优化数据库 (VACUUM/ANALYZE)
- [ ] 清理过期数据
- [ ] 性能基准测试
- [ ] 容量规划评估

### 定期更新

```bash
# 系统更新
apt-get update && apt-get upgrade

# Docker 镜像更新
docker pull <image>

# 依赖更新
npm update

# 安全修补
npm audit fix
```

---

## 👁️ 监控和告警

### 系统架构

监控系统基于以下组件：

```
应用层 (Express/React)
    ↓
Instrumentation (OpenTelemetry)
    ↓
Data Collection (Metrics/Traces/Logs)
    ↓
Collection Agent
    ├─ Prometheus (指标)
    ├─ Jaeger (追踪)
    └─ ELK Stack (日志)
    ↓
Storage & Analysis
    ├─ Time-series DB
    ├─ Log Storage
    └─ Trace Storage
    ↓
Visualization & Alerting
    ├─ Grafana (仪表板)
    ├─ Prometheus Alert Manager
    └─ 通知系统 (钉钉/邮件/短信)
```

### 安装和配置

#### Step 1: 安装监控依赖

**Backend Instrumentation**:
```bash
npm install @opentelemetry/api
npm install @opentelemetry/sdk-node
npm install @opentelemetry/auto
npm install @opentelemetry/exporter-prometheus
npm install @opentelemetry/exporter-trace-jaeger
npm install @opentelemetry/sdk-trace-node
npm install pino pino-http
npm install express-prometheus-middleware
```

**Frontend Monitoring**:
```bash
npm install @opentelemetry/sdk-web
npm install @opentelemetry/exporter-trace-jaeger-web
npm install @sentry/react
npm install performance-observer-polyfill
```

#### Step 2: 配置 OpenTelemetry (Backend)

**文件: backend/config/telemetry.js**

```javascript
const { NodeSDK } = require('@opentelemetry/sdk-node');
const { getNodeAutoInstrumentations } = require('@opentelemetry/auto-instrumentations-node');
const { PeriodicExportingMetricReader } = require('@opentelemetry/sdk-metrics');
const { PrometheusExporter } = require('@opentelemetry/exporter-prometheus');
const { BatchSpanProcessor } = require('@opentelemetry/sdk-trace-node');
const { JaegerExporter } = require('@opentelemetry/exporter-trace-jaeger');

const sdk = new NodeSDK({
  traceExporter: new JaegerExporter({
    endpoint: process.env.JAEGER_ENDPOINT || 'http://localhost:14268/api/traces',
  }),
  metricExporter: new PrometheusExporter(
    { port: 9464, endpoint: '/metrics' },
  ),
  instrumentations: [getNodeAutoInstrumentations()],
});

sdk.start();

process.on('SIGTERM', () => {
  sdk.shutdown()
    .then(() => console.log('Telemetry shut down'))
    .catch(log => console.log('Error shutting down telemetry', log))
    .finally(() => process.exit(0));
});

module.exports = sdk;
```

#### Step 3: 配置 Prometheus

**文件: prometheus/prometheus.yml**

```yaml
global:
  scrape_interval: 15s
  evaluation_interval: 15s
  external_labels:
    monitor: 'foodtestlab-monitor'

alerting:
  alertmanagers:
    - static_configs:
        - targets: ['localhost:9093']

rule_files:
  - 'rules/alert_rules.yml'
  - 'rules/recording_rules.yml'

scrape_configs:
  - job_name: 'prometheus'
    static_configs:
      - targets: ['localhost:9090']

  - job_name: 'foodtestlab-app'
    static_configs:
      - targets: ['localhost:9464']
    metrics_path: '/metrics'
    scrape_interval: 5s

  - job_name: 'node-exporter'
    static_configs:
      - targets: ['localhost:9100']

  - job_name: 'postgres'
    static_configs:
      - targets: ['localhost:9187']
```

#### Step 4: 配置告警规则

**文件: prometheus/rules/alert_rules.yml**

```yaml
groups:
  - name: foodtestlab_alerts
    interval: 30s
    rules:
      # 应用可用性
      - alert: InstanceDown
        expr: up{job="foodtestlab-app"} == 0
        for: 5m
        annotations:
          summary: "实例宕机"
          description: "foodtestlab 实例已离线"

      # 高错误率
      - alert: HighErrorRate
        expr: rate(http_requests_total{status=~"5.."}[5m]) > 0.05
        for: 5m
        annotations:
          summary: "错误率过高"
          description: "5 分钟内错误率 > 5%"

      # CPU 使用过高
      - alert: HighCPUUsage
        expr: node_cpu_seconds_total{mode="system"} > 0.9
        for: 5m
        annotations:
          summary: "CPU 使用过高"
          description: "CPU 使用率 > 90%"

      # 内存使用过高
      - alert: HighMemoryUsage
        expr: node_memory_MemAvailable_bytes / node_memory_MemTotal_bytes < 0.15
        for: 5m
        annotations:
          summary: "内存不足"
          description: "可用内存 < 15%"

      # 磁盘空间
      - alert: DiskSpaceLow
        expr: node_filesystem_avail_bytes / node_filesystem_size_bytes < 0.1
        for: 5m
        annotations:
          summary: "磁盘空间不足"
          description: "可用磁盘 < 10%"

      # 响应时间过长
      - alert: SlowResponse
        expr: histogram_quantile(0.99, http_request_duration_seconds_bucket) > 1
        for: 5m
        annotations:
          summary: "响应时间过长"
          description: "P99 延迟 > 1 秒"
```

### Grafana 仪表板

**应用性能仪表板**:
- 访问: http://localhost:3000
- 用户名: admin
- 密码: admin123

**关键指标**:
- 请求速率 (req/s)
- 响应时间 (ms)
- 错误率 (%)
- P95/P99 延迟 (ms)
- 缓存命中率 (%)
- CPU 使用率
- 内存使用率
- 磁盘 I/O

**仪表板位置**:
- Home > Dashboards > Application Performance
- Home > Dashboards > Infrastructure

### 告警规则

**严重告警** (Slack/PagerDuty):
- 实例宕机 (1 分钟内恢复)
- 错误率 > 5% (持续 5 分钟)
- CPU 使用 > 90% (持续 5 分钟)
- 磁盘满 (< 1GB 可用)

**警告告警** (Slack/Email):
- 错误率 > 1% (持续 5 分钟)
- 响应时间 > 1s (持续 5 分钟)
- 内存使用 > 85% (持续 5 分钟)
- 磁盘 < 10% (持续 5 分钟)

### 告警响应流程

```
告警触发
  ↓
通知团队 (Slack/Email/PagerDuty)
  ↓
分析原因
  ↓
├─ 自愈 → 监控恢复
├─ 调整 → 优化配置
└─ 升级 → 深层调查
  ↓
解决并记录
```

### 日志查询

**Kibana 访问**: http://localhost:5601

**常用查询**:

```sql
-- 错误日志
level: ERROR AND timestamp > now-1h

-- 缓慢请求
response_time > 1000 AND timestamp > now-1h

-- 特定用户活动
user_id: "12345" AND timestamp > now-24h

-- API 端点性能
endpoint: "/api/records" AND timestamp > now-6h
```

### Jaeger 分布式追踪

**Jaeger UI**: http://localhost:16686

**调查步骤**:
1. 选择服务 (foodtestlab)
2. 选择操作 (HTTP GET, POST 等)
3. 设置查询条件 (时间范围、错误等)
4. 查看追踪结果和延迟分析

### 禁用告警 (临时维护)

```bash
# 通过 AlertManager API
curl -X POST http://localhost:9093/api/v1/silences \
  -d '{
    "matchers": [{"name": "service", "value": "foodtestlab"}],
    "startsAt": "2026-04-24T10:00:00Z",
    "endsAt": "2026-04-24T11:00:00Z",
    "comment": "维护窗口"
  }'
```

---

## 🔍 故障排查

### 常见问题

#### 1. 应用无法启动

**症状**: 容器立即退出

**排查步骤**:
```bash
# 查看详细日志
docker-compose logs app

# 常见原因
- 数据库未启动 → docker-compose restart db
- 环境变量缺失 → 检查 .env 文件
- 端口占用 → lsof -i :3000
```

#### 2. 数据库连接失败

**症状**: 日志显示"连接数据库失败"

**排查步骤**:
```bash
# 检查数据库服务
docker-compose ps postgres

# 检查连接字符串
grep DATABASE_URL .env

# 手动测试连接
psql postgresql://user:pass@localhost:5432/db
```

#### 3. 性能下降

**症状**: 响应时间变慢

**排查步骤**:
```bash
# 检查系统资源
top -n 1
free -h
df -h

# 检查数据库状态
psql -c "SELECT datname, count(*) FROM pg_stat_activity GROUP BY datname;"

# 检查 Redis 内存
redis-cli info memory

# 查看慢查询
tail -100 /var/log/postgres/slow.log
```

#### 4. 磁盘空间不足

**症状**: 磁盘已满

**排查步骤**:
```bash
# 查看磁盘使用
du -sh /*

# 清理日志
rm -rf /var/log/app/*.gz
journalctl --vacuum=30d

# 清理容器数据
docker system prune -a

# 清理数据库
psql -c "VACUUM FULL; ANALYZE;"
```

### 故障升级流程

```
问题检测
  ↓
初级诊断 (15 分钟)
  ↓
├─ 可解决 → 执行修复
└─ 无法解决 → 升级
  ↓
深层分析 (30 分钟)
  ├─ 找到原因 → 实施修复
  └─ 仍无法解决 → 启动变更控制
  ↓
恢复
  ├─ 自动恢复 → 验证
  ├─ 需要备份 → 数据恢复
  └─ 需要回滚 → 版本回滚
```

---

## 💾 备份和恢复

### 备份策略

**备份类型**:
- 数据库备份: 每天 00:00 UTC
- 应用配置: 每周
- 用户数据: 每天
- 二进制日志: 连续

**备份位置**:
- 本地: `/backup/local`
- 异地: AWS S3
- 冷备: 磁带库 (每月)

### 数据库备份

```bash
# 完整备份
pg_dump -U postgres foodtestlab | gzip > backup-$(date +%Y%m%d).sql.gz

# 增量备份 (WAL 日志)
pg_basebackup -U postgres -Ft -Pv -D /backup/base

# 验证备份
gunzip -c backup-20260424.sql.gz | head -100
```

### 备份自动化

```bash
#!/bin/bash
# /etc/cron.d/foodtestlab-backup

# 每天 00:00 执行备份
0 0 * * * root /usr/local/bin/backup-database.sh
0 1 * * * root /usr/local/bin/backup-s3.sh
```

### 数据恢复

```bash
# 停止应用
systemctl stop foodtestlab

# 恢复数据库
dropdb foodtestlab
createdb foodtestlab
gunzip -c backup-20260424.sql.gz | psql -U postgres foodtestlab

# 启动应用
systemctl start foodtestlab

# 验证
curl http://localhost:3000/health
```

### RTO 和 RPO

| 场景 | RTO | RPO |
|------|------|------|
| 应用崩溃 | 5 分钟 | 实时 |
| 数据库故障 | 15 分钟 | 24 小时 |
| 磁盘故障 | 30 分钟 | 24 小时 |
| 数据中心故障 | 2 小时 | 1 小时 |

---

## ⚡ 性能优化

### 性能监控

```bash
# 应用性能
curl http://localhost:9090/api/v1/query?query=http_request_duration_seconds

# 数据库性能
psql -c "SELECT query, calls, total_time FROM pg_stat_statements ORDER BY total_time DESC LIMIT 10;"

# 缓存效率
redis-cli info stats
```

### 常见优化

#### 1. 数据库优化

```sql
-- 添加索引
CREATE INDEX idx_user_email ON users(email);

-- 分析查询性能
EXPLAIN ANALYZE SELECT * FROM orders WHERE user_id = 1;

-- 清理数据库
VACUUM FULL;
ANALYZE;
```

#### 2. 缓存优化

```bash
# 检查缓存hit rate
redis-cli info stats | grep hits

# 增加过期时间
redis-cli CONFIG SET maxmemory-policy allkeys-lru

# 清理过期数据
redis-cli EVICT
```

#### 3. 应用优化

```javascript
// 启用 HTTP 缓存
app.use(compression());

// 启用连接池
const pool = new Pool({ max: 20 });

// 异步处理
queue.process('send-email', async (job) => {
  await sendEmail(job.data);
});
```

---

## 🔐 安全维护

### 安全检查清单

**月度检查**:
- [ ] 依赖漏洞扫描 (npm audit)
- [ ] SSL/TLS 证书验证
- [ ] 防火墙规则审计
- [ ] 访问日志审计
- [ ] 数据加密验证

**季度检查**:
- [ ] 安全评估
- [ ] 渗透测试
- [ ] 合规检查
- [ ] 备份恢复演练

### 密钥轮换

```bash
# 数据库密码轮换
ALTER ROLE postgres WITH PASSWORD 'new_password';

# API 密钥轮换
# 1. 生成新密钥
# 2. 配置在应用
# 3. 验证工作
# 4. 删除旧密钥

# SSL 证书更新
certbot renew
systemctl reload nginx
```

### 安全日志审计

```bash
# 查看认证日志
tail -f /var/log/auth.log

# 查看应用错误
tail -f logs/error.log

# 查看数据库日志
tail -f /var/log/postgresql/postgresql.log
```

---

## 📊 SLA 和报表

### SLA 指标

| 指标 | 目标 | 当前 |
|------|------|------|
| 可用性 | 99.9% | 99.95% |
| 响应时间 (平均) | 400ms | 340ms |
| 错误率 | < 0.1% | 0.02% |
| 恢复时间 | < 5 分钟 | 3 分钟 |

### 月度报表

```markdown
# 2026 年 4 月运维报告

## 可用性
- 总运行时间: 99.95%
- 计划停机: 0.5 小时
- 故障时间: 1 小时

## 性能
- 平均响应时间: 340ms
- P99 延迟: 650ms
- 吞吐量: 150 req/s

## 事件
- 严重事件: 0 起
- 告警总数: 45 起
- 平均响应时间: 5 分钟

## 改进
- 优化了数据库查询
- 增加了缓存层
- 更新了依赖包
```

---

## 📞 联系方式

### 支持团队

| 角色 | 联系方式 | 可用时间 |
|------|---------|--------|
| 值班工程师 | 18:00-09:00 | 24/7 |
| 数据库管理员 | DBA@example.com | 工作时间 |
| 网络管理员 | NET@example.com | 工作时间 |

### 升级路径

```
问题
  ↓
级别 1: 初级支持 (15 分钟)
  ↓ (无法解决)
级别 2: 专家支持 (1 小时)
  ↓ (无法解决)
级别 3: 工程团队 (4 小时)
  ↓ (无法解决)
管理层评估
```

---

## ✅ 维护检查清单

**每日**:
- [ ] 应用健康检查
- [ ] 监控告警查看
- [ ] 错误日志查看
- [ ] 磁盘空间检查

**每周**:
- [ ] 完整系统检查
- [ ] 性能基准测试
- [ ] 安全补丁检查
- [ ] 备份验证

**每月**:
- [ ] 容量规划评估
- [ ] 成本分析
- [ ] 安全审计
- [ ] 文档更新

---

**维护团队**: 随时待命  
**应急热线**: +86-xxx-xxxx-xxxx  
**文档版本**: 3.1  
**最后更新**: 2026-04-24

