#!/usr/bin/env bash
# log-alert.sh — 应用日志异常告警扫描（增量）
#
# 由 systemd timer 周期调用（默认每 15 分钟一次），增量扫描
# 后端错误日志（默认 $LOG_DIR/app.err.log，可选含 app.out.log）中
# 出现的 ERROR / 未捕获异常 / 内存超限(OOM) / 进程崩溃 等关键字，
# 仅针对"自上次扫描以来新增的行"告警，避免重复刷屏。
#
# 用法：
#   /bin/bash <repo>/scripts/log-alert.sh
#
# 可配置环境变量（由 backend/.env 通过 EnvironmentFile 注入；或显式 export）：
#   LOG_ALERT_DIR      日志目录（默认 /var/log/<system>，由 deploy.sh 覆盖为 $LOG_DIR）
#   LOG_ALERT_TARGETS  待扫描文件，空格分隔（默认 "$LOG_ALERT_DIR/app.err.log"）
#   LOG_ALERT_STATE    增量游标状态文件（默认 $LOG_ALERT_DIR/.log-alert.cursor）
#   LOG_ALERT_WEBHOOK  企业微信/钉钉机器人 webhook；未配置则仅写本地告警日志
#   LOG_ALERT_DINGTALK 也可仅配此项（与 LOG_ALERT_WEBHOOK 二选一，内容相同）
#   LOG_ALERT_MAX      单次扫描最多推送多少条命中（默认 20，防告警风暴）
#
# 关键字清单（大小写不敏感匹配整行）：
#   error, exception, uncaught, unhandled, fatal,
#   out of memory, heap out of memory, cannot find module,
#   EADDRINUSE, timeout, segfault, abort, denied
set -u

# ---------- 路径与默认值 ----------
DIR="${LOG_ALERT_DIR:-/var/log/foodsentinel}"
TARGETS="${LOG_ALERT_TARGETS:-$DIR/app.err.log}"
STATE_FILE="${LOG_ALERT_STATE:-$DIR/.log-alert.cursor}"
WEBHOOK="${LOG_ALERT_WEBHOOK:-${LOG_ALERT_DINGTALK:-}}"
MAX_HITS="${LOG_ALERT_MAX:-20}"

# 告警落盘日志（与扫描目标同目录，便于 logrotate 一并管理）
ALERT_LOG="$DIR/log-alert.out.log"

# ---------- 关键字模式 ----------
PATTERN='error|exception|uncaught|unhandled|fatal|out of memory|heap out of memory|cannot find module|EADDRINUSE|timeout|segfault|abort|denied'

# ---------- 游标管理（增量扫描）----------
# 状态文件记录"每个目标文件已经读到多少字节"。文件被 logrotate 截断/轮转后
# 当前大小 < 已记录偏移 => 视为新文件，从 0 开始（避免重复刷旧日志或越界）。
declare -A OFFSETS
if [ -f "$STATE_FILE" ]; then
  while IFS='=' read -r _f _off; do
    [ -n "${_f:-}" ] && OFFSETS["$_f"]="$_off"
  done < "$STATE_FILE"
fi

TS="$(date -Is)"
HITS=0
BATCH=""

for f in $TARGETS; do
  [ -f "$f" ] || continue
  cur_size=$(stat -c %s "$f" 2>/dev/null || echo 0)
  prev_off="${OFFSETS[$f]:-0}"
  # 轮转/截断：当前大小比已读偏移小，重头读
  if [ "$cur_size" -lt "$prev_off" ] 2>/dev/null; then
    prev_off=0
  fi
  # 用 dd 跳过已读字节，避免大文件全量 reload
  if [ "$cur_size" -gt "$prev_off" ] 2>/dev/null; then
    new_block=$(dd if="$f" bs=1 skip="$prev_off" count="$((cur_size - prev_off))" 2>/dev/null)
    while IFS= read -r line; do
      [ -z "$line" ] && continue
      if echo "$line" | grep -iqE "$PATTERN"; then
        HITS=$((HITS + 1))
        BATCH="${BATCH}${line}\n"
        [ "$HITS" -ge "$MAX_HITS" ] && {
          BATCH="${BATCH}[log-alert] 命中已达上限 $MAX_HITS，后续新增将下轮汇报\n"
          break
        }
      fi
    done <<< "$new_block"
  fi
  # 更新游标（始终以当前文件大小为基准，即便本轮未读完也推进到 cur_size）
  OFFSETS["$f"]="$cur_size"
done

# ---------- 持久化游标 ----------
{
  for _k in "${!OFFSETS[@]}"; do
    echo "${_k}=${OFFSETS[$_k]}"
  done
} > "$STATE_FILE.tmp" 2>/dev/null && mv "$STATE_FILE.tmp" "$STATE_FILE" 2>/dev/null || true

# ---------- 无命中则结束 ----------
[ "$HITS" -eq 0 ] && exit 0

MSG="[log-alert] ${TS} 检测到 ${HITS} 条应用日志异常（扫描: ${TARGETS}）：\n${BATCH}"

# 1) 写本地告警日志（目录不存在则静默降级）
echo -e "$MSG" >> "$ALERT_LOG" 2>/dev/null || true

# 2) 配置了 webhook 时推送（curl 失败/不存在均静默降级，不让 timer 失败）
if [ -n "$WEBHOOK" ]; then
  # 企业微信/钉钉 text 消息体（content 需单行，换行用 \n 转义）
  _content=$(echo -e "$MSG" | sed ':a;N;$!ba;s/\n/\\n/g')
  curl -fsS -m 10 -X POST \
    -H 'Content-Type: application/json' \
    -d "{\"msgtype\":\"text\",\"text\":{\"content\":\"${_content}\"}}" \
    "${WEBHOOK}" >/dev/null 2>&1 || true
fi

exit 0
