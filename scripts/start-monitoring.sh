#!/bin/bash

# 食品安全系统 - 监控栈启动脚本
# 用于启动完整的监控和可观测性系统

set -e

# 颜色定义
GREEN='\033[0;32m'
BLUE='\033[0;34m'
YELLOW='\033[1;33m'
RED='\033[0;31m'
NC='\033[0m' # No Color

# 项目目录
PROJECT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

echo -e "${BLUE}========================================${NC}"
echo -e "${BLUE}食品安全系统 - 监控栈启动${NC}"
echo -e "${BLUE}========================================${NC}"
echo ""

# 检查 Docker
if ! command -v docker &> /dev/null; then
    echo -e "${RED}❌ Docker 未安装${NC}"
    exit 1
fi

# 检查 Docker Compose
if ! command -v docker-compose &> /dev/null; then
    echo -e "${RED}❌ Docker Compose 未安装${NC}"
    exit 1
fi

echo -e "${YELLOW}📋 检查环境配置...${NC}"

# 检查 .env 文件
if [ ! -f "$PROJECT_DIR/.env" ]; then
    echo -e "${YELLOW}⚠️  .env 文件未找到，使用默认配置${NC}"
    cat > "$PROJECT_DIR/.env" << 'EOF'
# 数据库配置
DB_HOST=localhost
DB_PORT=5432
DB_NAME=foodtestlab
DB_USER=postgres
DB_PASSWORD=postgres

# Grafana 配置
GF_ADMIN_USER=admin
GF_ADMIN_PASSWORD=admin123

# SMTP 配置 (告警邮件)
SMTP_HOST=smtp.example.com:587
SMTP_USER=alerts@example.com
SMTP_PASSWORD=your_password
SMTP_FROM=alerts@example.com

# 告警邮件
ALERT_EMAIL_CRITICAL=critical@example.com
ALERT_EMAIL_WARNING=warning@example.com
ALERT_EMAIL_DEV=dev@example.com
ALERT_EMAIL_DBA=dba@example.com

# Slack 配置 (可选)
SLACK_WEBHOOK=https://hooks.slack.com/services/YOUR/WEBHOOK/URL

# 应用配置
NODE_ENV=production
JAEGER_ENDPOINT=http://localhost:14268/api/traces
METRICS_PORT=9464
EOF
    echo -e "${GREEN}✓ 已创建默认 .env 文件${NC}"
fi

# 加载环境变量
set -a
source "$PROJECT_DIR/.env"
set +a

echo -e "${YELLOW}📁 创建必要的目录...${NC}"

# 创建必要的目录
mkdir -p "$PROJECT_DIR/prometheus/rules"
mkdir -p "$PROJECT_DIR/grafana/provisioning/dashboards"
mkdir -p "$PROJECT_DIR/grafana/provisioning/datasources"
mkdir -p "$PROJECT_DIR/logstash"

echo -e "${GREEN}✓ 目录已准备${NC}"

echo -e "${YELLOW}🐳 启动 Docker Compose...${NC}"

# 启动监控栈
docker-compose -f "$PROJECT_DIR/docker-compose.monitoring.yml" up -d

echo ""
echo -e "${BLUE}========================================${NC}"
echo -e "${GREEN}✅ 监控栈启动成功！${NC}"
echo -e "${BLUE}========================================${NC}"
echo ""

# 等待服务启动
echo -e "${YELLOW}⏳ 等待服务启动...${NC}"
sleep 10

echo ""
echo -e "${GREEN}📍 服务地址:${NC}"
echo -e "  Prometheus:   ${BLUE}http://localhost:9090${NC}"
echo -e "  Grafana:      ${BLUE}http://localhost:3000${NC} (admin/$GF_ADMIN_PASSWORD)"
echo -e "  AlertManager: ${BLUE}http://localhost:9093${NC}"
echo -e "  Kibana:       ${BLUE}http://localhost:5601${NC}"
echo -e "  Jaeger:       ${BLUE}http://localhost:16686${NC}"
echo -e "  Node Exporter:${BLUE}http://localhost:9100/metrics${NC}"
echo ""

echo -e "${YELLOW}📊 后续步骤:${NC}"
echo "  1. 访问 Grafana (http://localhost:3000)"
echo "  2. 添加 Prometheus 数据源"
echo "  3. 导入应用仪表板"
echo "  4. 配置告警通知"
echo ""

echo -e "${YELLOW}📋 实用命令:${NC}"
echo "  查看服务状态:       docker-compose -f docker-compose.monitoring.yml ps"
echo "  查看日志:          docker-compose -f docker-compose.monitoring.yml logs -f"
echo "  停止监控栈:        docker-compose -f docker-compose.monitoring.yml down"
echo "  清理数据卷:        docker-compose -f docker-compose.monitoring.yml down -v"
echo ""

echo -e "${GREEN}✅ 监控系统已就绪！${NC}"
