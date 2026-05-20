#!/usr/bin/env bash

set -euo pipefail

SYSTEM_NAME=${SYSTEM_NAME:-foodtestlab}
FRONTEND_PORT=${FRONTEND_PORT:-8081}
API_PORT=${API_PORT:-3001}
OTHER_FRONTEND_PORT=${OTHER_FRONTEND_PORT:-8080}
OTHER_API_PORT=${OTHER_API_PORT:-3000}
PM2_APP_NAME=${PM2_APP_NAME:-foodtestlab-api}
NGINX_CONF=${NGINX_CONF:-/etc/nginx/conf.d/foodtestlab.conf}

fail() {
  echo "[ERROR] $1" >&2
  exit 1
}

warn() {
  echo "[WARN]  $1"
}

ok() {
  echo "[OK]    $1"
}

has_cmd() {
  command -v "$1" >/dev/null 2>&1
}

echo "== 双系统同机部署预检: ${SYSTEM_NAME} =="

# 1) 端口矩阵冲突
[[ "$FRONTEND_PORT" != "$API_PORT" ]] || fail "FRONTEND_PORT 与 API_PORT 不能相同: $FRONTEND_PORT"
[[ "$FRONTEND_PORT" != "$OTHER_FRONTEND_PORT" ]] || fail "FRONTEND_PORT 与 OTHER_FRONTEND_PORT 冲突: $FRONTEND_PORT"
[[ "$API_PORT" != "$OTHER_API_PORT" ]] || fail "API_PORT 与 OTHER_API_PORT 冲突: $API_PORT"
ok "端口矩阵检查通过"

# 2) 本机监听冲突检查
if has_cmd lsof; then
  frontend_owner=$(lsof -nP -iTCP:"$FRONTEND_PORT" -sTCP:LISTEN 2>/dev/null | awk 'NR==2 {print $1}') || true
  if [[ -n "${frontend_owner:-}" && "$frontend_owner" != "nginx" ]]; then
    fail "前端端口 $FRONTEND_PORT 已被非 nginx 进程占用: $frontend_owner"
  fi

  api_owner=$(lsof -nP -iTCP:"$API_PORT" -sTCP:LISTEN 2>/dev/null | awk 'NR==2 {print $1}') || true
  if [[ -n "${api_owner:-}" && "$api_owner" != "node" ]]; then
    fail "API 端口 $API_PORT 已被非 node 进程占用: $api_owner"
  fi
  ok "监听占用检查通过"
else
  warn "未安装 lsof，跳过监听占用检查"
fi

# 3) PM2 名称冲突检查
if has_cmd pm2; then
  if pm2 list 2>/dev/null | grep -qw "$PM2_APP_NAME"; then
    ok "PM2 应用名已存在（后续应使用 restart）: $PM2_APP_NAME"
  else
    ok "PM2 应用名未占用（可使用 start）: $PM2_APP_NAME"
  fi
else
  warn "未安装 pm2，跳过 PM2 名称检查"
fi

# 4) Nginx 配置冲突检查
if [[ -f "$NGINX_CONF" ]]; then
  ok "检测到 Nginx 配置文件: ${NGINX_CONF}"
  if grep -q "listen[[:space:]]\+$OTHER_FRONTEND_PORT;" "$NGINX_CONF"; then
    fail "当前 Nginx 配置仍监听系统A端口 $OTHER_FRONTEND_PORT，请分离配置文件"
  fi
else
  warn "未检测到 Nginx 配置文件: ${NGINX_CONF}（首次部署可忽略）"
fi

echo
ok "预检完成，未发现阻断级冲突"
echo "建议继续执行部署。"
