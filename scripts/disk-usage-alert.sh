#!/usr/bin/env bash
# disk-usage-alert.sh — 磁盘水位告警（2026-08-27 容量策略）
#
# 策略背景：本机所有"体积上限自动删除"机制已按用户要求移除
#   （journal SystemMaxUse、logrotate size/rotate、BACKUP_KEEP_DAYS 均已去掉），
#   数据增长改为"达到磁盘容量 90% 时告警，由人工决策清理"，本脚本是唯一告警入口。
#
# 行为：每 10 分钟（cron /etc/cron.d/disk-usage-alert）检查挂载点：
#   - 使用率 ≥ $THRESHOLD（默认 90）→ 告警：
#       ① 追加 /mnt/datadisk0/system-logs/disk-alert.log
#       ② 写 foodsentinel 库 public.SystemLog（message 前缀 SECURITY:DISK_USAGE，
#          超管控制台安全事件扫描通道可见）
#   - 同一挂载点同级别 1 小时内只告警一次（状态文件防重）
#
# 手动测试：DISK_ALERT_THRESHOLD=1 /usr/local/sbin/disk-usage-alert.sh --force
set -u
THRESHOLD="${DISK_ALERT_THRESHOLD:-90}"
STATE_DIR="/var/lib/disk-usage-alert"
LOG_FILE="/mnt/datadisk0/system-logs/disk-alert.log"
PG_DB="foodsentinel"
MOUNTS=("/mnt/datadisk0" "/")          # 数据盘优先；系统盘顺带监控
mkdir -p "$STATE_DIR" || exit 1
FORCE=0; [ "${1:-}" = "--force" ] && FORCE=1

for m in "${MOUNTS[@]}"; do
  usage=$(df --output=pcent "$m" 2>/dev/null | tail -1 | tr -dc '0-9')
  [ -n "$usage" ] || continue
  [ "$usage" -ge "$THRESHOLD" ] || continue

  key=$(echo "$m" | tr '/' '_')
  state="$STATE_DIR/$key.last"
  now=$(date +%s)
  if [ "$FORCE" -ne 1 ] && [ -f "$state" ]; then
    last=$(cat "$state" 2>/dev/null || echo 0)
    [ $((now - last)) -lt 3600 ] && continue    # 1 小时内已告警过，跳过
  fi

  ts=$(date '+%F %T')
  msg="SECURITY:DISK_USAGE 磁盘水位告警：$m 已用 ${usage}%（阈值 ${THRESHOLD}%），日志/备份不自动清理，请人工决策清理"
  echo "$ts $msg" >> "$LOG_FILE"
  echo "$now" > "$state"

  # 写 SystemLog（超管控制台安全事件可见）；失败不影响本地日志
  # id 用时间戳+随机后缀避免碰撞
  sid="diskalert-$(date +%s)-$RANDOM"
  sudo -u postgres psql -d "$PG_DB" -q -c \
    "INSERT INTO public.\"SystemLog\" (\"id\",\"level\",\"message\",\"context\") \
     VALUES ('$sid','warn','$msg', jsonb_build_object('mount','$m','usage_pct',$usage,'threshold',$THRESHOLD));" \
    >> /dev/null 2>&1 || echo "$ts [warn] SystemLog 写入失败（psql）" >> "$LOG_FILE"
done
