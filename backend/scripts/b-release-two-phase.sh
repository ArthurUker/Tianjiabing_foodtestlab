#!/usr/bin/env bash
# b-release-two-phase.sh — P3-LIFECYCLE-AB-R4 · Release B 可执行两段发布入口（B1 → 门禁 → B2 / 回退）
#
# 背景：现行 deploy.sh（:564 prisma generate 早于 :633/:691 migrate）无法满足"生成 B client 之前
#       必须完成 M2 与门禁"的顺序。本入口把该顺序**可执行化**（R13-4）：
#
#   b1（迁移段；仍用 A 版 schema/client）：
#       schema-switch A  →（A client 生成）
#       npx prisma migrate deploy           # public 链
#       node sync-tenant-schemas.mjs        # 租户链（M1+M2；失败按 runbook 人工处置，不自动 resolve）
#       门禁① node sync-tenant-schemas.mjs --check
#       门禁② node backend/scripts/006_audit_principal_gate.mjs
#       任一非零 ⇒ **立即退出**（绝不生成/激活 B client、绝不 restart）
#
#   b2（激活段；仅当 b1 全绿）：
#       先**重跑**只读门禁（防并发漂移；非零即拒）
#       schema-switch B  →（B 版 required client 生成）
#       node scripts/build-static.js
#       systemctl restart "$APP_NAME"
#
#   rollback-client（回退；DB 不逆迁）：
#       schema-switch A  →（装回 A client）
#       node scripts/build-static.js
#       systemctl restart "$APP_NAME"       # 不执行任何 migrate（M2 保持）
#
# 用法：bash backend/scripts/b-release-two-phase.sh b1|b2|rollback-client
# 沙盒：R13B_LOG=<file>（记录每条被执行的命令；配合 PATH 桩可做函数级验证，不触真实部署）
# 约束：本脚本不做任何真实部署的旁路（不 resolve、不 db push、不跳过门禁）。
set -euo pipefail

PHASE="${1:-}"
if [[ ! "$PHASE" =~ ^(b1|b2|rollback-client)$ ]]; then
  echo "用法: $0 b1|b2|rollback-client" >&2
  exit 2
fi

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$REPO_ROOT"

APP_NAME="${APP_NAME:-foodtestlab}"
LOG="${R13B_LOG:-}"

run() {
  if [[ -n "$LOG" ]]; then printf 'RUN %s\n' "$*" >> "$LOG"; fi
  "$@"
}

gate_pass() {
  run node backend/sync-tenant-schemas.mjs --check
  run node backend/scripts/006_audit_principal_gate.mjs
}

case "$PHASE" in
  b1)
    echo "[b1] 生成 A 版 client（nullable；B1 期间进程继续以 A client 服务）"
    run node backend/tests/lifecycle/schema-switch.mjs A
    echo "[b1] public 链迁移（migrate deploy）"
    run npx prisma migrate deploy
    echo "[b1] 租户链迁移（版本化回放；失败不自动 resolve）"
    run node backend/sync-tenant-schemas.mjs
    echo "[b1] 只读强门禁（--check + 006 G2/G7/G8/G3）"
    gate_pass
    echo "[b1] 完成：迁移与门禁全绿。B2（生成/激活 B client）现在可以执行。"
    ;;
  b2)
    echo "[b2] 激活前复核：只读门禁必须再次全绿（防 b1 与 b2 之间的漂移）"
    gate_pass
    echo "[b2] 生成 B 版 required client"
    run node backend/tests/lifecycle/schema-switch.mjs B
    echo "[b2] 前端构建 + 重启（新 client 生效）"
    run node scripts/build-static.js
    run systemctl restart "$APP_NAME"
    echo "[b2] 完成：B client 已激活。"
    ;;
  rollback-client)
    echo "[rollback] 装回 A 版 client（DB 保持 M2，不逆迁）"
    run node backend/tests/lifecycle/schema-switch.mjs A
    run node scripts/build-static.js
    run systemctl restart "$APP_NAME"
    echo "[rollback] 完成：A client 已恢复，数据库未回退。"
    ;;
esac
