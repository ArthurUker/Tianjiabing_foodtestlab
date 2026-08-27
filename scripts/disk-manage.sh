#!/usr/bin/env bash
# disk-manage.sh — 磁盘管理 root 特权操作包装脚本（仅 allowlist，供 foodsentinel 服务经 sudo 调用）
#
# 由 /etc/sudoers.d/foodsentinel-disk 授权：
#   foodsentinel ALL=(root) NOPASSWD: /usr/local/sbin/disk-manage.sh
#
# 子命令（参数严格校验，防注入/目录穿越）：
#   du <path>             — du -sb（白名单目标）
#   ls <dir>              — 文件明细 "size\tpath"（白名单目录）
#   journal-vacuum <days> — journalctl --vacuum-time=<days>d（1-365）
#   log-delete <path>     — rm -f 单个日志文件（白名单目录内，禁 ..）
set -euo pipefail

CMD="${1:-}"; ARG="${2:-}"

case "$CMD" in
  du)
    case "$ARG" in
      /var/log/journal|/mnt/datadisk0/system-logs/syslog|/mnt/datadisk0/system-logs/journal|/mnt/datadisk0/foodsentinel/data/pgdata|/mnt/datadisk0/foodsentinel/backups|/mnt/datadisk0/foodsentinel/logs)
        exec du -sb "$ARG" ;;
      *) echo "du target not allowed" >&2; exit 2 ;;
    esac ;;
  ls)
    case "$ARG" in
      /mnt/datadisk0/system-logs/syslog|/mnt/datadisk0/system-logs/journal)
        # 输出 size\tpath 明细（find 不受目录读权限限制影响——以 root 执行）
        exec find "$ARG" -type f -printf '%s\t%T@\t%p\n' ;;
      *) echo "ls target not allowed" >&2; exit 2 ;;
    esac ;;
  journal-vacuum)
    [[ "$ARG" =~ ^[0-9]{1,3}$ ]] && [ "$ARG" -ge 1 ] && [ "$ARG" -le 365 ] || { echo "days invalid" >&2; exit 2; }
    exec journalctl --vacuum-time="${ARG}d" ;;
  log-delete)
    case "$ARG" in
      /mnt/datadisk0/foodsentinel/logs/*|/mnt/datadisk0/system-logs/syslog/*|/mnt/datadisk0/system-logs/journal/*)
        [[ "$ARG" == *..* ]] && { echo "path traversal denied" >&2; exit 2; }
        [ "$(dirname "$ARG")" != "$ARG" ] || exit 2
        exec rm -f -- "$ARG" ;;
      *) echo "delete target not allowed" >&2; exit 2 ;;
    esac ;;
  *) echo "unknown command" >&2; exit 2 ;;
esac
