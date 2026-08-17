#!/usr/bin/env bash
# =========================================================
# restart-school-backup-api.sh — 单独重启后端装载新路由
# =========================================================
# 背景：TD-School-Backup-Sync 给后端新增了 /api/school/backups 一组路由，并修改
# 了 server.js。Node 进程必须重启才能让 express 装载新路由（否则前端访问会 404）。
#
# 适用场景：
#   - 前端访问「数据备份与恢复」页面时控制台反复打印：
#       GET http://<host>/api/school/backups?page=1&pageSize=15 404 (Not Found)
#   - 即后端未重启
#
# 用法（在公网服务器上以 root 运行）：
#   sudo bash scripts/restart-school-backup-api.sh
#
# 行为：
#   1. 自动探测 <SYSTEM_NAME>-api systemd 服务名（无需手动输入）
#   2. 校验后端文件确实包含新路由（防止改完代码没推/没拉就先重启）
#   3. systemctl restart <service>
#   4. 等待并验证 /api/health 与 /api/school/backups 返回 JSON
#
# 若希望直接重启服务不校验文件，可加 --force：
#   sudo bash scripts/restart-school-backup-api.sh --force
# =========================================================
set -euo pipefail

log()  { echo -e "\033[36m=== $* ===\033[0m"; }
ok()   { echo -e "\033[32m[OK] $*\033[0m"; }
warn() { echo -e "\033[33m[WARN] $*\033[0m"; }
fail() { echo -e "\033[31m[FAIL] $*\033[0m"; exit 1; }

FORCE=false
[ "${1:-}" = "--force" ] && FORCE=true

[ "$(id -u)" -eq 0 ] || fail "请使用 root 运行（sudo bash $0）"
command -v systemctl >/dev/null 2>&1 || fail "本脚本仅适用于 systemd 环境"

# ----- 1. 自动探测服务名 -----
log "探测后端 systemd 服务名"
SERVICE_NAME=""
for f in /etc/systemd/system/*.service; do
    [ -e "$f" ] || continue
    bn="$(basename "$f")"
    case "$bn" in
        *-api.service) SERVICE_NAME="${bn%.service}" ;;
    esac
done
[ -n "$SERVICE_NAME" ] || fail "未找到 *-api.service，请确认是否走 deploy.sh 部署"
ok "服务名: $SERVICE_NAME"

# ----- 2. 文件预检（防止代码没推到服务器就先重启） -----
REPO_ROOT="$(systemctl show "$SERVICE_NAME" -p WorkingDirectory --value 2>/dev/null || true)"
if [ -n "$REPO_ROOT" ]; then
    REPO_ROOT="$(dirname "$REPO_ROOT")"
fi
if [ -z "$REPO_ROOT" ] || [ ! -d "$REPO_ROOT/backend" ]; then
    warn "无法从 systemd 自动定位 REPO_ROOT，跳过文件预检"
    SKIP_CHECK=true
else
    SKIP_CHECK=false
    log "代码预检: $REPO_ROOT"
    if ! grep -q "createSchoolBackupRoutes" "$REPO_ROOT/backend/server.js"; then
        if [ "$FORCE" = "true" ]; then
            warn "server.js 未包含 schoolBackupRoutes，但 --force 已开启，继续重启"
        else
            fail "server.js 中找不到 schoolBackupRoutes 挂载，请先在仓库中 git pull 拉取新代码，或加 --force 忽略预检"
        fi
    fi
    if ! [ -f "$REPO_ROOT/backend/routes/schoolBackupRoutes.js" ]; then
        if [ "$FORCE" = "true" ]; then
            warn "routes/schoolBackupRoutes.js 不存在，但 --force 已开启，继续"
        else
            fail "缺少 backend/routes/schoolBackupRoutes.js，请先 git pull，或加 --force"
        fi
    fi
    ok "代码预检通过（schoolBackupRoutes 已就位）"
fi

# ----- 3. 重启服务 -----
log "重启服务: systemctl restart $SERVICE_NAME"
systemctl restart "$SERVICE_NAME"
sleep 1

# ----- 4. 验证 -----
log "健康检查（最多等 60 秒）"
HEALTH_OK=false
LAST_PORT=""
# 用 systemctl 环境文件中的 PORT 变量，或退化逐个常见端口试
ENV_FILE="$(systemctl show "$SERVICE_NAME" -p EnvironmentFile --value 2>/dev/null || true)"
if [ -n "$ENV_FILE" ] && [ -f "$ENV_FILE" ]; then
    PORT_FROM_ENV="$(grep -E '^PORT=' "$ENV_FILE" 2>/dev/null | head -1 | cut -d= -f2 || true)"
fi
for port in ${PORT_FROM_ENV:-} 3000 4000 8000 8080 9000; do
    [ -z "$port" ] && continue
    code=$(curl -s -o /dev/null -w "%{http_code}" --max-time 3 "http://127.0.0.1:$port/api/health" 2>/dev/null || echo 000)
    if [ "$code" = "200" ]; then
        ok "API /api/health 在端口 $port 返回 200"
        HEALTH_OK=true
        LAST_PORT=$port
        break
    fi
    sleep 2
done
[ "$HEALTH_OK" = "true" ] || fail "健康检查超时（/api/health 未返回 200）。请手动：journalctl -u $SERVICE_NAME -n 80 --no-pager"

# ----- 5. 直接验证新路由 -----
if [ -n "$LAST_PORT" ]; then
    log "验证新路由 /api/school/backups"
    code=$(curl -s -o /dev/null -w "%{http_code}" --max-time 3 "http://127.0.0.1:$LAST_PORT/api/school/backups" 2>/dev/null || echo 000)
    if [ "$code" = "401" ] || [ "$code" = "403" ]; then
        ok "新路由 /api/school/backups 已装载（返回 $code，需登录；不再是 404）"
    elif [ "$code" = "404" ]; then
        fail "/api/school/backups 仍返回 404，请检查 server.js 是否正确挂载"
    else
        warn "/api/school/backups 返回 $code（可能是 5xx，请检查日志）"
    fi
fi

ok "全部完成"
echo ""
echo "[Next]"
echo "  1. 浏览器刷新学校管理控制台 -> 进入「数据备份与恢复」"
echo "  2. 若仍异常：journalctl -u $SERVICE_NAME -n 100 --no-pager | tail -60"
