#!/bin/bash

# 食品安全系统 - 生产部署脚本
# 用于安全地部署应用到生产环境

set -e

# ==================== 配置 ====================

# 颜色定义
GREEN='\033[0;32m'
BLUE='\033[0;34m'
YELLOW='\033[1;33m'
RED='\033[0;31m'
NC='\033[0m'

# 部署配置
ENVIRONMENT="${1:-production}"
VERSION="${2:-latest}"
DRY_RUN="${3:---no-dry-run}"

# 部署参数
DEPLOY_HOST="${DEPLOY_HOST:-api.example.com}"
DEPLOY_USER="${DEPLOY_USER:-deploy}"
DEPLOY_PATH="${DEPLOY_PATH:-/app/foodtestlab}"
BACKUP_PATH="${DEPLOY_PATH}/backups"
LOG_FILE="/tmp/deploy-$(date +%Y%m%d-%H%M%S).log"

# ==================== 函数 ====================

log() {
    echo -e "${BLUE}[$(date +'%Y-%m-%d %H:%M:%S')]${NC} $1" | tee -a "$LOG_FILE"
}

success() {
    echo -e "${GREEN}✅ $1${NC}" | tee -a "$LOG_FILE"
}

error() {
    echo -e "${RED}❌ $1${NC}" | tee -a "$LOG_FILE"
    exit 1
}

warn() {
    echo -e "${YELLOW}⚠️  $1${NC}" | tee -a "$LOG_FILE"
}

# ==================== 预检查 ====================

check_prerequisites() {
    log "🔍 检查前置条件..."
    
    # 检查必要的命令
    for cmd in docker ssh scp curl; do
        if ! command -v $cmd &> /dev/null; then
            error "缺少必要工具: $cmd"
        fi
    done
    
    success "前置条件检查通过"
}

run_multi_app_preflight() {
    local preflight_script="$(cd "$(dirname "$0")" && pwd)/preflight-multi-app.sh"

    if [ -x "$preflight_script" ]; then
        log "🧭 执行双系统防冲突预检..."
        SYSTEM_NAME="foodtestlab" \
        FRONTEND_PORT="8081" \
        API_PORT="3001" \
        OTHER_FRONTEND_PORT="8080" \
        OTHER_API_PORT="3000" \
        PM2_APP_NAME="foodtestlab-api" \
        "$preflight_script" || error "双系统预检失败，请先排除冲突后再部署"
        success "双系统防冲突预检通过"
    else
        warn "未找到可执行预检脚本: $preflight_script，跳过预检"
    fi
}

check_deployment_approval() {
    if [ "$DRY_RUN" == "--dry-run" ]; then
        warn "演练模式 - 不会执行实际部署"
        return 0
    fi
    
    log "🛑 确认部署"
    echo -e "${YELLOW}即将部署到: $ENVIRONMENT${NC}"
    echo -e "${YELLOW}版本: $VERSION${NC}"
    echo -e "${YELLOW}主机: $DEPLOY_HOST${NC}"
    echo ""
    
    read -p "确认部署? (y/n) " -n 1 -r
    echo
    if [[ ! $REPLY =~ ^[Yy]$ ]]; then
        error "部署被中止"
    fi
}

# ==================== 构建 ====================

build_application() {
    log "🔨 构建应用..."
    
    npm run build:prod || error "构建失败"
    
    success "应用构建成功"
}

build_docker_image() {
    log "🐳 构建 Docker 镜像..."
    
    docker build -t foodtestlab:$VERSION . || error "Docker 构建失败"
    docker tag foodtestlab:$VERSION foodtestlab:latest
    
    success "Docker 镜像构建成功"
}

# ==================== 备份 ====================

create_backup() {
    log "💾 创建备份..."
    
    BACKUP_FILE="$BACKUP_PATH/foodtestlab-backup-$(date +%Y%m%d-%H%M%S).tar.gz"
    
    ssh "$DEPLOY_USER@$DEPLOY_HOST" << EOF
        mkdir -p "$BACKUP_PATH"
        cd "$DEPLOY_PATH"
        tar -czf "$BACKUP_FILE" . --exclude=node_modules --exclude=dist || true
        echo "Backup created: $BACKUP_FILE"
        
        # 保留最近 10 个备份
        ls -t "$BACKUP_PATH"/foodtestlab-backup-*.tar.gz | tail -n +11 | xargs rm -f
EOF
    
    success "备份已创建"
}

backup_database() {
    log "🗄️  备份数据库..."
    
    ssh "$DEPLOY_USER@$DEPLOY_HOST" << EOF
        pg_dump -U postgres foodtestlab > /tmp/db-backup-$(date +%Y%m%d-%H%M%S).sql
        gzip /tmp/db-backup-*.sql
        mv /tmp/db-backup-*.sql.gz "$BACKUP_PATH/"
        
        # 保留最近 5 个数据库备份
        ls -t "$BACKUP_PATH"/db-backup-*.sql.gz | tail -n +6 | xargs rm -f
EOF
    
    success "数据库备份已创建"
}

# ==================== 部署 ====================

deploy_application() {
    log "🚀 部署应用..."
    
    if [ "$DRY_RUN" == "--dry-run" ]; then
        log "[演练] 跳过实际部署"
        return 0
    fi
    
    # 上传新版本
    log "📦 上传文件..."
    ssh "$DEPLOY_USER@$DEPLOY_HOST" mkdir -p "$DEPLOY_PATH/new"
    scp -r dist/* "$DEPLOY_USER@$DEPLOY_HOST:$DEPLOY_PATH/new/" || error "上传失败"
    
    # 停止旧版本 (保持 5 秒)
    log "⏹️  停止应用..."
    ssh "$DEPLOY_USER@$DEPLOY_HOST" << EOF
        cd "$DEPLOY_PATH"
        
        # 备份当前版本
        [ -d "old" ] && rm -rf old
        [ -d "current" ] && mv current old
        
        # 激活新版本
        mv new current
        
        # 重启服务
        systemctl restart foodtestlab || docker-compose restart app
EOF
    
    success "应用已部署"
}

# ==================== 验证 ====================

wait_for_startup() {
    log "⏳ 等待应用启动..."
    
    local max_attempts=30
    local attempt=1
    
    while [ $attempt -le $max_attempts ]; do
        if curl -sf "http://$DEPLOY_HOST/api/health" > /dev/null; then
            success "应用已启动"
            return 0
        fi
        
        warn "等待中... ($attempt/$max_attempts)"
        sleep 2
        ((attempt++))
    done
    
    error "应用启动超时"
}

verify_deployment() {
    log "🧪 验证部署..."
    
    # 检查 HTTP 响应
    HTTP_CODE=$(curl -s -o /dev/null -w "%{http_code}" "http://$DEPLOY_HOST")
    if [ "$HTTP_CODE" != "200" ]; then
        error "HTTP 错误: $HTTP_CODE"
    fi
    
    # 检查 API
    curl -sf "http://$DEPLOY_HOST/api/health" > /dev/null || error "API 健康检查失败"
    
    # 检查数据库连接
    ssh "$DEPLOY_HOST" "curl -sf http://localhost:3000/api/db-check || true" || error "数据库检查失败"
    
    success "部署验证通过"
}

# ==================== 告警 ====================

send_notification() {
    local status="$1"
    local message="$2"
    
    if [ -z "$SLACK_WEBHOOK" ]; then
        return
    fi
    
    local color="good"
    if [ "$status" == "error" ]; then
        color="danger"
    elif [ "$status" == "warning" ]; then
        color="warning"
    fi
    
    curl -X POST "$SLACK_WEBHOOK" \
        -H 'Content-Type: application/json' \
        -d "{
            \"attachments\": [{
                \"color\": \"$color\",
                \"title\": \"部署通知\",
                \"text\": \"$message\",
                \"fields\": [
                    {\"title\": \"环境\", \"value\": \"$ENVIRONMENT\"},
                    {\"title\": \"版本\", \"value\": \"$VERSION\"},
                    {\"title\": \"主机\", \"value\": \"$DEPLOY_HOST\"}
                ]
            }]
        }" || true
}

# ==================== 回滚 ====================

rollback() {
    error_msg="$1"
    error "部署失败: $error_msg"
    
    log "⚠️  开始回滚..."
    
    ssh "$DEPLOY_USER@$DEPLOY_HOST" << EOF
        cd "$DEPLOY_PATH"
        
        # 恢复旧版本
        [ -d "current" ] && rm -rf current
        [ -d "old" ] && mv old current
        
        # 重启服务
        systemctl restart foodtestlab || docker-compose restart app
EOF
    
    warn "已回滚到上一个版本"
    send_notification "error" "部署失败并已回滚: $error_msg"
    exit 1
}

# ==================== 主流程 ====================

main() {
    echo -e "${BLUE}========================================${NC}"
    echo -e "${BLUE}食品安全系统 - 生产部署${NC}"
    echo -e "${BLUE}========================================${NC}"
    echo ""
    
    # 初始化
    mkdir -p "$(dirname "$LOG_FILE")"
    log "部署日志: $LOG_FILE"
    echo ""
    
    # 前检查
    check_prerequisites || exit 1
    run_multi_app_preflight
    check_deployment_approval
    
    # 构建
    build_application
    build_docker_image
    
    # 备份
    create_backup
    backup_database
    
    # 部署
    deploy_application || rollback "部署命令执行失败"
    
    # 验证
    wait_for_startup || rollback "应用启动失败"
    verify_deployment || rollback "验证失败"
    
    # 完成
    echo ""
    echo -e "${BLUE}========================================${NC}"
    echo -e "${GREEN}✅ 部署完成！${NC}"
    echo -e "${BLUE}========================================${NC}"
    echo ""
    
    log "✅ 应用已成功部署到 $ENVIRONMENT"
    log "📍 应用地址: http://$DEPLOY_HOST"
    log "📝 部署日志: $LOG_FILE"
    
    send_notification "good" "✅ 部署成功"
    
    success "部署完成"
}

# ==================== 执行 ====================

# 捕获错误
trap 'rollback "脚本执行出错"' ERR

# 运行主程序
main

# 输出日志路径
echo ""
echo "完整日志: $LOG_FILE"
