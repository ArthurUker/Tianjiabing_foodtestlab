#!/usr/bin/env bash
# backup-alert.sh — 数据库备份失败告警钩子（由 systemd OnFailure 触发）
#
# 用法（systemd 单元中）：
#   [Unit]
#   OnFailure=<app>-backup-alert.service
#   ...
#   <app>-backup-alert.service:
#   [Service]
#   Type=oneshot
#   EnvironmentFile=<backend-env>
#   ExecStart=/bin/bash <repo>/scripts/backup-alert.sh
#
# 可选环境变量：
#   BACKUP_ALERT_WEBHOOK  企业微信/钉钉等机器人 webhook 地址（未配置则仅写日志）
#   BACKUP_ALERT_LOG      告警日志路径（默认 /var/log/foodtestlab/backup.err.log）
set -u

LOG_FILE="${BACKUP_ALERT_LOG:-/var/log/foodtestlab/backup.err.log}"
TS="$(date -Is)"
MSG="[backup-alert] ${TS} 数据库备份任务失败，请检查备份服务日志（journalctl -u '*-backup.service'）"

# 1) 写入告警日志（目录不存在时静默降级，不阻断 OnFailure 流程）
echo "$MSG" >> "$LOG_FILE" 2>/dev/null || true

# 2) 配置了 webhook 时推送失败告警（curl 不存在/网络失败均静默降级，不使 OnFailure 单元失败）
if [ -n "${BACKUP_ALERT_WEBHOOK:-}" ]; then
  curl -fsS -m 10 -X POST \
    -H 'Content-Type: application/json' \
    -d "{\"msgtype\":\"text\",\"text\":{\"content\":\"${MSG}\"}}" \
    "${BACKUP_ALERT_WEBHOOK}" >/dev/null 2>&1 || true
fi
