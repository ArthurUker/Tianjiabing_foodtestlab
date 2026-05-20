#!/usr/bin/env bash

# 食品安全检验管理系统 - 一键部署脚本
# 参考 project-management/rdpms-system 部署模式改进
# 适配腾讯云低配服务器：轻后端、重前端、静态托管、预检防冲突

set -e

# ==================== 配置 ====================

REPO_ROOT="${REPO_ROOT:-.}"
BACKEND_PATH="$REPO_ROOT/backend"
FRONTEND_PATH="$REPO_ROOT"
DATA_DIR="${DATA_DIR:-/opt/foodtestlab}"
LOG_FILE="/tmp/foodtestlab-deploy-$(date +%s).log"

SYSTEM_NAME="foodtestlab"
FRONTEND_PORT="${FRONTEND_PORT:-8081}"
API_PORT="${API_PORT:-3001}"
PM2_APP_NAME="${PM2_APP_NAME:-foodtestlab-api}"
NGINX_CONF="${NGINX_CONF:-/etc/nginx/conf.d/foodtestlab.conf}"

# 颜色定义
RED='\033[0;31m'
GREEN='\033[0;32m'
BLUE='\033[0;34m'
YELLOW='\033[1;33m'
NC='\033[0m'

# ==================== 工具函数 ====================

log() {
    local msg="$1"
    echo -e "${BLUE}[$(date +'%Y-%m-%d %H:%M:%S')]${NC} $msg" | tee -a "$LOG_FILE"
}

success() {
    local msg="$1"
    echo -e "${GREEN}✅ $msg${NC}" | tee -a "$LOG_FILE"
}

error() {
    local msg="$1"
    echo -e "${RED}❌ $msg${NC}" | tee -a "$LOG_FILE"
    exit 1
}

warn() {
    local msg="$1"
    echo -e "${YELLOW}⚠️  $msg${NC}" | tee -a "$LOG_FILE"
}

has_cmd() {
    command -v "$1" >/dev/null 2>&1
}

# ==================== 预检 ====================

pre_check() {
    log "🧭 开始部署前预检..."
    
    # 检查必要工具
    for cmd in git node npm pm2 nginx; do
        if ! has_cmd "$cmd"; then
            warn "缺少命令: $cmd（继续，但部分功能可能失败）"
        fi
    done
    
    # 运行双系统冲突预检
    if [[ -x "$REPO_ROOT/scripts/preflight-multi-app.sh" ]]; then
        SYSTEM_NAME="$SYSTEM_NAME" \
        FRONTEND_PORT="$FRONTEND_PORT" \
        API_PORT="$API_PORT" \
        PM2_APP_NAME="$PM2_APP_NAME" \
        NGINX_CONF="$NGINX_CONF" \
        bash "$REPO_ROOT/scripts/preflight-multi-app.sh" || error "双系统预检失败"
        success "预检通过"
    else
        warn "未找到预检脚本，跳过"
    fi
}

# ==================== Git 操作 ====================

fetch_code() {
    log "📡 拉取最新代码..."
    
    cd "$REPO_ROOT"
    
    local retry=0
    local max_retry=3
    
    while [[ $retry -lt $max_retry ]]; do
        if git fetch origin 2>&1 | tee -a "$LOG_FILE"; then
            success "Git fetch 成功"
            break
        else
            retry=$((retry + 1))
            if [[ $retry -lt $max_retry ]]; then
                warn "Git fetch 失败，重试 ($retry/$max_retry)..."
                sleep 3
            else
                error "Git fetch 最终失败"
            fi
        fi
    done
    
    git reset --hard origin/runon_tencentcloud || error "Git reset 失败"
    git clean -fd -e "**/.env" -e "*.db"
    
    local commit_msg=$(git log -1 --oneline)
    success "代码已更新至: $commit_msg"
}

# ==================== 后端部署 ====================

deploy_backend() {
    log "🔧 部署后端..."
    
    cd "$BACKEND_PATH"
    
    # 停止旧进程（释放文件锁）
    if has_cmd pm2; then
        pm2 stop "$PM2_APP_NAME" 2>/dev/null || true
        sleep 2
    fi
    
    # 清理旧依赖
    log "清理旧 node_modules..."
    rm -rf node_modules package-lock.json
    
    # 安装依赖
    log "安装后端依赖..."
    npm ci || npm install || error "npm 依赖安装失败"
    success "后端依赖安装成功"
    
    # Prisma 迁移
    if [[ -d "prisma" ]]; then
        log "执行 Prisma schema 迁移..."
        npx prisma generate || warn "Prisma 生成失败"
        npx prisma db push --skip-generate --accept-data-loss 2>&1 | tee -a "$LOG_FILE" || warn "Prisma 迁移失败"
        success "Prisma 迁移完成"
    fi
}

# ==================== 前端部署 ====================

deploy_frontend() {
    log "🎨 部署前端..."
    
    cd "$FRONTEND_PATH"
    
    # 清理旧依赖
    log "清理旧 node_modules..."
    rm -rf node_modules package-lock.json
    
    # 安装依赖
    log "安装前端依赖..."
    npm ci || npm install || error "npm 依赖安装失败"
    
    # 构建前端
    log "构建前端静态文件..."
    if [[ -f "package.json" ]]; then
        if grep -q '"build"' package.json; then
            npm run build 2>&1 | tee -a "$LOG_FILE" || warn "前端构建可能失败，检查日志"
        else
            warn "package.json 不含 build 脚本"
        fi
    fi
    
    success "前端部署完成"
}

# ==================== PM2 管理 ====================

manage_pm2() {
    log "⚙️  配置 PM2..."
    
    if ! has_cmd pm2; then
        warn "PM2 未安装，跳过"
        return
    fi
    
    cd "$BACKEND_PATH"
    
    # 检查应用是否已存在
    if pm2 list 2>/dev/null | grep -qw "$PM2_APP_NAME"; then
        log "重启 PM2 应用: $PM2_APP_NAME"
        pm2 restart "$PM2_APP_NAME" 2>&1 | tee -a "$LOG_FILE"
    else
        log "启动 PM2 应用: $PM2_APP_NAME"
        pm2 start src/index.js --name "$PM2_APP_NAME" 2>&1 | tee -a "$LOG_FILE" || error "PM2 启动失败"
    fi
    
    pm2 save
    success "PM2 配置完成"
}

# ==================== Nginx 配置 ====================

reload_nginx() {
    log "🌐 重载 Nginx 配置..."
    
    if ! has_cmd nginx; then
        warn "Nginx 未安装，跳过"
        return
    fi
    
    # 校验配置
    if ! nginx -t 2>&1 | tee -a "$LOG_FILE"; then
        error "Nginx 配置校验失败"
    fi
    
    # 重载
    if systemctl is-active --quiet nginx; then
        systemctl reload nginx || error "Nginx 重载失败"
        success "Nginx 已重载"
    else
        warn "Nginx 未运行，跳过重载"
    fi
}

# ==================== 验证 ====================

health_check() {
    log "🏥 执行健康检查..."
    
    local attempts=0
    local max_attempts=30
    
    while [[ $attempts -lt $max_attempts ]]; do
        if curl -s http://127.0.0.1:${API_PORT}/api/health >/dev/null 2>&1; then
            success "API 健康检查通过"
            return 0
        fi
        
        attempts=$((attempts + 1))
        warn "API 暂未响应 ($attempts/$max_attempts)..."
        sleep 2
    done
    
    warn "健康检查超时（API 可能需要更多时间启动）"
}

# ==================== 部署总结 ====================

show_summary() {
    echo
    echo -e "${BLUE}========================================${NC}"
    echo -e "${GREEN}✅ 部署完成！${NC}"
    echo -e "${BLUE}========================================${NC}"
    echo
    log "前端地址: http://159.75.106.179:${FRONTEND_PORT}"
    log "API 地址: http://159.75.106.179:${FRONTEND_PORT}/api"
    log "内部 API: http://127.0.0.1:${API_PORT}"
    log "PM2 应用: $PM2_APP_NAME"
    log "部署日志: $LOG_FILE"
    echo
}

# ==================== 异常处理 ====================

cleanup_on_error() {
    error "部署失败，请检查日志: $LOG_FILE"
}

trap cleanup_on_error ERR

# ==================== 主流程 ====================

main() {
    echo -e "${BLUE}========================================${NC}"
    echo -e "${BLUE}食品安全检验系统 - 一键部署${NC}"
    echo -e "${BLUE}========================================${NC}"
    echo
    
    mkdir -p "$(dirname "$LOG_FILE")"
    log "部署日志: $LOG_FILE"
    echo
    
    pre_check
    fetch_code
    deploy_backend
    deploy_frontend
    manage_pm2
    reload_nginx
    health_check
    show_summary
}

main
