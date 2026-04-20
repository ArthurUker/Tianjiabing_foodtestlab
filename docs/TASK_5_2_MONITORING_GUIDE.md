# 📊 Task 5.2 指南: 监控告警系统配置

**任务周期**: Week 5-6  
**优先级**: 🔴 高 (部署前必需)  
**预期工作量**: 4-6 小时

---

## 🎯 任务概述

**目标**: 建立完整的应用监控和告警系统，实现生产环境的可视化管理和异常预警。

**成果预期**: 
- ✅ APM 应用性能监控
- ✅ 错误追踪和日志系统
- ✅ 告警规则和通知
- ✅ 监控仪表板

---

## 📊 监控系统架构

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

---

## 🛠️ 安装配置步骤

### Step 1: 安装监控依赖

#### 1.1 Backend Instrumentation

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

#### 1.2 Frontend Monitoring

```bash
npm install @opentelemetry/sdk-web
npm install @opentelemetry/exporter-trace-jaeger-web
npm install @sentry/react
npm install performance-observer-polyfill
```

### Step 2: 配置 OpenTelemetry (Backend)

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

### Step 3: 配置 Prometheus

**文件: prometheus.yml**

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

### Step 4: 配置告警规则

**文件: prometheus/rules/alert_rules.yml**

```yaml
groups:
  - name: application
    interval: 30s
    rules:
      # 应用可用性
      - alert: InstanceDown
        expr: up == 0
        for: 5m
        labels:
          severity: critical
        annotations:
          summary: "实例 {{ $labels.instance }} 宕机"
          description: "实例 {{ $labels.instance }} 已离线超过 5 分钟"

      # API 错误率
      - alert: HighErrorRate
        expr: |
          (sum(rate(http_requests_total{status=~"5.."}[5m])) by (job) 
           / sum(rate(http_requests_total[5m])) by (job)) > 0.05
        for: 5m
        labels:
          severity: warning
        annotations:
          summary: "{{ $labels.job }} 错误率过高"
          description: "错误率为 {{ $value | humanizePercentage }}"

      # API 响应时间
      - alert: HighLatency
        expr: histogram_quantile(0.95, http_request_duration_seconds_bucket) > 1
        for: 5m
        labels:
          severity: warning
        annotations:
          summary: "API 响应时间过长"
          description: "P95 延迟为 {{ $value }}s"

      # CPU 使用率
      - alert: HighCPUUsage
        expr: node_cpu_seconds_total > 0.8
        for: 10m
        labels:
          severity: warning
        annotations:
          summary: "CPU 使用率过高"

      # 内存使用率
      - alert: HighMemoryUsage
        expr: |
          (1 - (node_memory_MemAvailable_bytes / node_memory_MemTotal_bytes)) > 0.85
        for: 10m
        labels:
          severity: warning
        annotations:
          summary: "内存使用率过高"
          description: "内存使用率为 {{ $value | humanizePercentage }}"

      # 磁盘空间
      - alert: LowDiskSpace
        expr: |
          (node_filesystem_avail_bytes{fstype!~"tmpfs|fuse.lxcfs|squashfs|vfat"} 
           / node_filesystem_size_bytes) < 0.15
        for: 10m
        labels:
          severity: warning
        annotations:
          summary: "磁盘空间不足"
          description: "剩余空间 {{ $value | humanize }}%"

      # 数据库连接
      - alert: HighDatabaseConnections
        expr: |
          pg_stat_activity_count > 80
        for: 5m
        labels:
          severity: warning
        annotations:
          summary: "数据库连接数过多"
          description: "当前连接数为 {{ $value }}"

      # 缓存命中率
      - alert: LowCacheHitRate
        expr: |
          (sum(rate(cache_hits_total[5m])) 
           / (sum(rate(cache_hits_total[5m])) + sum(rate(cache_misses_total[5m])))) < 0.5
        for: 10m
        labels:
          severity: info
        annotations:
          summary: "缓存命中率低"
          description: "命中率为 {{ $value | humanizePercentage }}"
```

### Step 5: 配置告警通知

**文件: prometheus/alertmanager.yml**

```yaml
global:
  resolve_timeout: 5m
  slack_api_url: ${{ secrets.SLACK_WEBHOOK }}
  pagerduty_url: https://events.pagerduty.com/v2/enqueue

route:
  receiver: 'default'
  group_by: ['alertname', 'cluster', 'service']
  group_wait: 10s
  group_interval: 10s
  repeat_interval: 12h
  
  routes:
    - match:
        severity: critical
      receiver: 'critical'
      continue: true
      group_wait: 0s
      repeat_interval: 1m

    - match:
        severity: warning
      receiver: 'warning'
      group_wait: 30s
      repeat_interval: 4h

receivers:
  - name: 'default'
    webhook_configs:
      - url: 'http://localhost:5001/alerts'

  - name: 'critical'
    pagerduty_configs:
      - service_key: ${{ secrets.PAGERDUTY_SERVICE_KEY }}
    slack_configs:
      - channel: '#critical-alerts'
        title: '🚨 严重告警'
        text: '{{ .GroupLabels.alertname }}'
    email_configs:
      - to: 'oncall@example.com'
        from: 'alertmanager@example.com'
        smarthost: 'smtp.example.com:587'
        auth_username: 'alertmanager@example.com'
        auth_password: ${{ secrets.SMTP_PASSWORD }}

  - name: 'warning'
    slack_configs:
      - channel: '#warnings'
        title: '⚠️ 警告告警'
    dingtalk_configs:
      - api_url: ${{ secrets.DINGTALK_WEBHOOK }}
```

### Step 6: 配置 ELK Stack (日志)

**Docker Compose: docker-compose.monitoring.yml**

```yaml
version: '3'

services:
  elasticsearch:
    image: docker.elastic.co/elasticsearch/elasticsearch:8.0.0
    environment:
      - discovery.type=single-node
      - xpack.security.enabled=false
    ports:
      - "9200:9200"
    volumes:
      - elasticsearch_data:/usr/share/elasticsearch/data

  kibana:
    image: docker.elastic.co/kibana/kibana:8.0.0
    ports:
      - "5601:5601"
    environment:
      - ELASTICSEARCH_HOSTS=http://elasticsearch:9200

  logstash:
    image: docker.elastic.co/logstash/logstash:8.0.0
    volumes:
      - ./logstash.conf:/usr/share/logstash/pipeline/logstash.conf
    environment:
      - ELASTICSEARCH_HOSTS=elasticsearch:9200
    depends_on:
      - elasticsearch

  prometheus:
    image: prom/prometheus:latest
    ports:
      - "9090:9090"
    volumes:
      - ./prometheus.yml:/etc/prometheus/prometheus.yml
      - ./prometheus/rules:/etc/prometheus/rules
      - prometheus_data:/prometheus
    command:
      - '--config.file=/etc/prometheus/prometheus.yml'
      - '--storage.tsdb.path=/prometheus'

  alertmanager:
    image: prom/alertmanager:latest
    ports:
      - "9093:9093"
    volumes:
      - ./prometheus/alertmanager.yml:/etc/alertmanager/alertmanager.yml
      - alertmanager_data:/alertmanager

  grafana:
    image: grafana/grafana:latest
    ports:
      - "3000:3000"
    environment:
      - GF_SECURITY_ADMIN_PASSWORD=admin
    volumes:
      - grafana_data:/var/lib/grafana
      - ./grafana/dashboards:/etc/grafana/provisioning/dashboards

  jaeger:
    image: jaegertracing/all-in-one:latest
    ports:
      - "6831:6831/udp"
      - "16686:16686"
    environment:
      - COLLECTOR_ZIPKIN_HTTP_PORT=9411

volumes:
  elasticsearch_data:
  prometheus_data:
  alertmanager_data:
  grafana_data:
```

### Step 7: 启动监控系统

```bash
# 启动监控栈
docker-compose -f docker-compose.monitoring.yml up -d

# 查看服务状态
docker-compose ps

# 访问服务
- Prometheus: http://localhost:9090
- Grafana: http://localhost:3000
- Kibana: http://localhost:5601
- Jaeger: http://localhost:16686
```

---

## 📊 配置监控仪表板

### Grafana 仪表板

**1. 应用性能仪表板**
```
- 请求速率 (req/s)
- 平均响应时间 (ms)
- P95/P99 延迟 (ms)
- 错误率 (%)
- 吞吐量 (ops/s)
```

**2. 系统资源仪表板**
```
- CPU 使用率 (%)
- 内存使用率 (%)
- 磁盘 I/O (MB/s)
- 网络流量 (Mbps)
- 系统负载
```

**3. 数据库仪表板**
```
- 连接数
- 查询时间
- 缓存命中率
- 事务速率
- 锁等待
```

**4. 业务指标仪表板**
```
- 用户活跃度
- API 调用统计
- 数据量增长
- 缓存效率
- 离线模式使用率
```

---

## 🔔 告警规则配置

### 关键告警

| 告警 | 条件 | 接收人 | 操作 |
|------|------|--------|------|
| 应用宕机 | up == 0 | 运维 | 立即页面 |
| 高错误率 | > 5% (5m) | 开发 | 15分钟内处理 |
| 高延迟 | P95 > 1s (5m) | 开发 | 1小时内调查 |
| CPU过高 | > 80% (10m) | 运维 | 检查资源 |
| 内存过高 | > 85% (10m) | 运维 | 考虑扩容 |
| 磁盘不足 | < 15% (10m) | 运维 | 清理日志 |
| DB连接过多 | > 80 | 运维 | 检查连接泄漏 |

---

## 📈 性能基准

### 设置性能基准

```javascript
// 应用启动后收集基准数据

基准指标:
- 响应时间: P50 < 100ms, P95 < 500ms, P99 < 1s
- 错误率: < 0.1% (可接受 0.01%)
- 吞吐量: > 100 req/s
- CPU使用: < 50% 平均
- 内存: < 60% 平均
- 缓存命中: > 80%
```

---

## 🔍 日志收集策略

### 日志级别

```
ERROR   - 错误: 必须立即处理
WARN    - 警告: 需要关注
INFO    - 信息: 常规操作记录
DEBUG   - 调试: 详细执行信息
```

### 关键日志

```
- 登录成功/失败
- API 请求/响应
- 数据库查询
- 错误堆栈
- 离线同步事件
- 缓存操作
- 安全事件
```

---

## 🧪 验证步骤

```bash
# 1. 检查 Prometheus 目标
curl http://localhost:9090/api/v1/targets

# 2. 检查告警规则
curl http://localhost:9090/api/v1/rules

# 3. 查询指标
curl http://localhost:9090/api/v1/query?query=up

# 4. 测试告警触发
# 停止应用后等待告警

# 5. 验证通知
# 检查钉钉/邮件收到告警
```

---

## 📋 实施清单

- [ ] 安装 OpenTelemetry 依赖
- [ ] 配置 Prometheus 和告警规则
- [ ] 配置 AlertManager 和通知
- [ ] 启动 ELK Stack (日志)
- [ ] 配置 Grafana 仪表板
- [ ] 创建告警接收人列表
- [ ] 测试告警通知
- [ ] 文档化告警处理流程
- [ ] 训练团队

---

## 🎯 后续步骤

**当前**: Task 5.2 规划  
**下一步**: 实施应用监控  
**预期完成**: Week 6 初期

---

**优先级**: 🔴 高  
**预计工作量**: 4-6 小时  
**重要性**: 部署前必需

