#!/bin/bash

# 食品安全系统 - 监控栈停止脚本
# 用于优雅地停止监控系统

set -e

# 颜色定义
GREEN='\033[0;32m'
BLUE='\033[0;34m'
YELLOW='\033[1;33m'
RED='\033[0;31m'
NC='\033[0m'

# 项目目录
PROJECT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/.."

echo -e "${BLUE}========================================${NC}"
echo -e "${BLUE}食品安全系统 - 监控栈停止${NC}"
echo -e "${BLUE}========================================${NC}"
echo ""

# 接收参数
CLEAN_VOLUMES="${1:---keep-volumes}"

if [ "$CLEAN_VOLUMES" == "-v" ] || [ "$CLEAN_VOLUMES" == "--clean-volumes" ]; then
    echo -e "${YELLOW}⚠️  将删除所有数据卷${NC}"
    COMPOSE_CMD="down -v"
else
    echo -e "${YELLOW}保留数据卷${NC}"
    COMPOSE_CMD="down"
fi

echo -e "${YELLOW}🛑 停止监控栈...${NC}"

# 停止监控栈
docker-compose -f "$PROJECT_DIR/docker-compose.monitoring.yml" $COMPOSE_CMD

echo ""
echo -e "${GREEN}✅ 监控栈已停止${NC}"
echo ""

if [ "$COMPOSE_CMD" == "down -v" ]; then
    echo -e "${YELLOW}📊 已删除的数据卷:${NC}"
    echo "  - prometheus_data"
    echo "  - alertmanager_data"
    echo "  - grafana_data"
    echo "  - elasticsearch_data"
    echo ""
fi

echo -e "${YELLOW}💡 提示:${NC}"
echo "  如需保留数据: ./scripts/stop-monitoring.sh"
echo "  如需清理数据: ./scripts/stop-monitoring.sh -v"
echo ""

echo -e "${GREEN}✅ 完成${NC}"
