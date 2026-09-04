#!/usr/bin/env bash
# =========================================================
# setup-backup-kms.sh — 配置备份 KMS 密钥（fail-closed 解锁）
# =========================================================
# 背景：后端报错"未配置加密主密钥（TENCENT_* 或 BACKUP_MASTER_KEY），fail-closed 拒绝执行"
# 不是代码 bug，是 backupService.js:296 的安全机制（无密钥拒绝执行，防明文备份裸奔）。
#
# 用法（在公网服务器上以 root 运行）：
#   sudo bash /opt/foodsentinel/scripts/setup-backup-kms.sh [options]
#
# 必填项（至少一组）：
#   --tencent                 启用模式 A（腾讯云 KMS 信封加密，**生产推荐**），需依次输入：
#                               TENCENT_SECRET_ID
#                               TENCENT_SECRET_KEY
#                               TENCENT_KMS_REGION（默认 ap-guangzhou）
#                               TENCENT_KMS_KEY_ID
#   --local                   启用模式 B（本地主密钥 base64，仅开发/过渡）：
#                               BACKUP_MASTER_KEY=$(openssl rand -base64 32)
#                              ⚠️ 若已有密钥（历史备份需恢复），务必用 --key 复用，
#                                不要自动生成新密钥（AES-GCM 单向，旧备份将无法解密）
#
# 可选项：
#   --key <base64>          复用已有 BACKUP_MASTER_KEY（模式 B，推荐恢复历史备份时使用）。
#                           未传时 --local 会交互式询问：直接粘贴已有密钥 或 回车自动生成。
#   --restart                 配置完自动重启后端 systemd 单元
#   --dry-run                 只打印将要做的修改，不实际写入 .env
#   --env /path/to/.env    手动指定 backend/.env 路径（默认自动探测）
#
# 行为：
#   1. 自动从 systemd 探测 *-api 服务 + 后端 .env 路径
#   2. 检测现有 KMS 配置（已配置则强制要求 --force 才覆盖）
#   3. 备份 .env 到 .env.bak.YYYYMMDD-HHMMSS
#   4. 幂等写入/更新密钥变量（chmod 600）
#   5. 可选重启服务 + 跑 003_backup-now.mjs --dry-run 验证 kmsMode()
#
# ⚠️ 注意：deploy.sh 已在 2026-08-18 修复为复用 BACKUP_MASTER_KEY / TENCENT_*（见
# deploy.sh 密钥复用循环），重部署不再丢备份密钥。但请确认服务器上的 deploy.sh 已更新
# （git pull），否则旧版仍会整体覆盖 backend/.env 导致密钥丢失。建议仍把密钥单独保存到
# /root/.foodsentinel-backup-secrets.env 作为保险。
# =========================================================
set -euo pipefail

log()  { echo -e "\033[36m=== $* ===\033[0m"; }
ok()   { echo -e "\033[32m[OK] $*\033[0m"; }
warn() { echo -e "\033[33m[WARN] $*\033[0m"; }
fail() { echo -e "\033[31m[FAIL] $*\033[0m"; exit 1; }

MODE=""           # tencent | local
RESTART=false
DRYRUN=false
FORCE=false
ENV_FILE=""
PROVIDED_KEY=""
TENCENT_REGION_DEFAULT="ap-guangzhou"

while [ $# -gt 0 ]; do
  case "$1" in
    --tencent) MODE="tencent"; shift ;;
    --local)   MODE="local"; shift ;;
    --key)     PROVIDED_KEY="$2"; shift 2 ;;
    --restart) RESTART=true; shift ;;
    --dry-run) DRYRUN=true; shift ;;
    --force)   FORCE=true; shift ;;
    --env)     ENV_FILE="$2"; shift 2 ;;
    --region)  TENCENT_REGION_DEFAULT="$2"; shift 2 ;;
    -h|--help) sed -n '2,45p' "$0"; exit 0 ;;
    *) fail "未知参数: $1（--help 查看用法）" ;;
  esac
done

[ "$(id -u)" -eq 0 ] || fail "请使用 root 运行（sudo bash $0）"

# ----- 1. 自动探测 .env 路径 -----
log "探测后端 systemd 服务 + .env 路径"
if [ -z "$ENV_FILE" ]; then
    SERVICE_NAME=""
    for f in /etc/systemd/system/*.service; do
        [ -e "$f" ] || continue
        bn="$(basename "$f")"
        case "$bn" in
            *-api.service) SERVICE_NAME="${bn%.service}" ;;
        esac
    done
    [ -n "$SERVICE_NAME" ] || fail "未找到 *-api.service，请用 --env 手动指定 backend/.env 路径"

    WD="$(systemctl show "$SERVICE_NAME" -p WorkingDirectory --value 2>/dev/null || true)"
    if [ -z "$WD" ] || [ ! -d "$WD" ]; then
        fail "无法从 $SERVICE_NAME 推断 backend/ 目录，请用 --env 指定"
    fi
    ENV_FILE="$WD/.env"
    [ -f "$ENV_FILE" ] || fail "探测到的 .env 不存在: $ENV_FILE（请用 --env 手动指定）"
    ok "服务: $SERVICE_NAME  目录: $WD  .env: $ENV_FILE"
fi
BACKEND_DIR="$(dirname "$ENV_FILE")"
[ -x "$BACKEND_DIR/node_modules/.bin/../../.." ] 2>/dev/null || true   # 仅静默

# ----- 2. 读取现有 KMS 状态 -----
existing_kms() {
    if grep -qE '^TENCENT_SECRET_ID=' "$ENV_FILE" 2>/dev/null; then echo "tencent"; return
    fi
    if grep -qE '^BACKUP_MASTER_KEY=' "$ENV_FILE" 2>/dev/null; then echo "local"; return
    fi
    echo "none"
}
CURRENT_KMS="$(existing_kms)"
log "当前 KMS 状态: $CURRENT_KMS"
if [ "$CURRENT_KMS" != "none" ] && [ "$FORCE" != "true" ]; then
    fail "已配置 KMS（$CURRENT_KMS），如要覆盖请加 --force（⚠️ 这会更新密钥，已用旧密钥加密的文件将无法解密）"
fi

# ----- 3. 选择模式 -----
if [ -z "$MODE" ]; then
    echo ""
    echo "选择 KMS 模式："
    echo "  1) 腾讯云 KMS 信封加密（生产推荐，需要 TENCENT_SECRET_ID/KEY/REGION/KEY_ID）"
    echo "  2) 本地主密钥 base64（仅开发/过渡，自动生成 32 字节密钥）"
    echo ""
    read -rp "输入选项 [1/2]: " opt
    case "$opt" in
        1) MODE="tencent" ;;
        2) MODE="local" ;;
        *) fail "无效选择" ;;
    esac
fi
ok "目标模式: $MODE"

# ----- 4. 收集密钥（dry-run 跳过输入） -----
collect_tencent() {
    if [ "$DRYRUN" = "true" ]; then
        TENCENT_SECRET_ID="<DRYRUN_SECRET_ID>"
        TENCENT_SECRET_KEY="<DRYRUN_SECRET_KEY>"
        TENCENT_KMS_REGION="$TENCENT_REGION_DEFAULT"
        TENCENT_KMS_KEY_ID="<DRYRUN_KEY_ID>"
        return
    fi
    read -rp "TENCENT_SECRET_ID: " TENCENT_SECRET_ID
    read -rsp "TENCENT_SECRET_KEY: " TENCENT_SECRET_KEY; echo ""
    read -rp "TENCENT_KMS_REGION [默认 $TENCENT_REGION_DEFAULT]: " rg
    TENCENT_KMS_REGION="${rg:-$TENCENT_REGION_DEFAULT}"
    read -rp "TENCENT_KMS_KEY_ID: " TENCENT_KMS_KEY_ID
    [ -n "$TENCENT_SECRET_ID" ] || fail "TENCENT_SECRET_ID 不能为空"
    [ -n "$TENCENT_SECRET_KEY" ] || fail "TENCENT_SECRET_KEY 不能为空"
    [ -n "$TENCENT_KMS_REGION" ] || fail "TENCENT_KMS_REGION 不能为空"
    [ -n "$TENCENT_KMS_KEY_ID" ] || fail "TENCENT_KMS_KEY_ID 不能为空"
}
collect_local() {
    if [ "$DRYRUN" = "true" ]; then
        BACKUP_MASTER_KEY="${PROVIDED_KEY:-<DRYRUN_LOCAL_KEY>}"
        return
    fi
    if [ -n "$PROVIDED_KEY" ]; then
        BACKUP_MASTER_KEY="$PROVIDED_KEY"
        ok "复用已有密钥（--key 传入，历史备份可恢复）"
    else
        echo ""
        echo "模式 B：BACKUP_MASTER_KEY（32 字节 base64）"
        echo "  - 若你有已保存的密钥（历史 .aes 备份需要它来恢复）：直接粘贴"
        echo "  - 若确认没有历史备份：直接回车，自动生成新密钥"
        read -rp "  粘贴已有密钥（回车则自动生成新密钥）: " KEY_INPUT
        if [ -n "$KEY_INPUT" ]; then
            BACKUP_MASTER_KEY="$KEY_INPUT"
            ok "复用已有密钥（历史备份可恢复）"
        else
            if command -v openssl >/dev/null 2>&1; then
                BACKUP_MASTER_KEY="$(openssl rand -base64 32)"
                ok "已自动生成 32 字节主密钥（⚠️ 历史 .aes 备份将无法用此密钥恢复）"
            else
                read -rp "BACKUP_MASTER_KEY（32 字节密钥 base64）: " BACKUP_MASTER_KEY
            fi
        fi
    fi
    [ -n "$BACKUP_MASTER_KEY" ] || fail "BACKUP_MASTER_KEY 不能为空"
    # 校验是合法的 32 字节 base64（防止手滑粘贴出错，导致所有新备份写入错误密钥）
    local key_len
    key_len="$(printf '%s' "$BACKUP_MASTER_KEY" | base64 -d 2>/dev/null | wc -c || echo 0)"
    if [ "$key_len" != "32" ]; then
        fail "BACKUP_MASTER_KEY 解码后长度 $key_len != 32 字节。请检查粘贴的密钥是否正确（必须是 openssl rand -base64 32 的输出）"
    fi
    ok "密钥长度校验通过（32 字节）"
}

case "$MODE" in
    tencent) collect_tencent ;;
    local)   collect_local ;;
    *)       fail "未选择模式" ;;
esac

# ----- 5. 备份 .env -----
if [ "$DRYRUN" = "true" ]; then
    log "DRY-RUN：以下变更将被打印，但不写入 .env"
else
    BAK="${ENV_FILE}.bak.$(date +%Y%m%d-%H%M%S)"
    cp -p "$ENV_FILE" "$BAK"
    ok "已备份: $BAK"
fi

# ----- 6. 幂等写入 -----
upsert_env() {
    local key="$1" value="$2"
    if grep -qE "^${key}=" "$ENV_FILE" 2>/dev/null; then
        # 替换现有值
        if [ "$DRYRUN" = "true" ]; then
            echo "  [DRY] UPDATE ${key}=..."
        else
            sed -i.bak "s|^${key}=.*|${key}=${value}|" "$ENV_FILE"
        fi
    else
        # 追加新行
        if [ "$DRYRUN" = "true" ]; then
            echo "  [DRY] APPEND ${key}=..."
        else
            echo "${key}=${value}" >> "$ENV_FILE"
        fi
    fi
}

log "写入 KMS 密钥到 .env"
case "$MODE" in
    tencent)
        upsert_env TENCENT_SECRET_ID   "$TENCENT_SECRET_ID"
        upsert_env TENCENT_SECRET_KEY  "$TENCENT_SECRET_KEY"
        upsert_env TENCENT_KMS_REGION  "$TENCENT_KMS_REGION"
        upsert_env TENCENT_KMS_KEY_ID  "$TENCENT_KMS_KEY_ID"
        ;;
    local)
        upsert_env BACKUP_MASTER_KEY   "$BACKUP_MASTER_KEY"
        warn "模式 B（本地密钥）以明文存储，仅限开发/过渡；生产必须切换到模式 A"
        warn "本次生成的 BACKUP_MASTER_KEY：$BACKUP_MASTER_KEY"
        warn "请务必单独保存到 /root/.foodsentinel-backup-secrets.env（deploy.sh 重部署会覆盖 .env）"
        ;;
esac

if [ "$DRYRUN" != "true" ]; then
    chmod 600 "$ENV_FILE"
    ok "已写入并 chmod 600"
fi

# ----- 7. 重启服务 -----
if [ "$RESTART" = "true" ]; then
    log "重启服务: systemctl restart $SERVICE_NAME"
    if [ "$DRYRUN" = "true" ]; then
        echo "  [DRY] systemctl restart $SERVICE_NAME"
    else
        systemctl restart "$SERVICE_NAME"
        sleep 2
    fi
fi

# ----- 8. 验证 kmsMode() -----
log "验证 KMS（dry-run 模式 + kmsMode() 输出）"
if [ "$DRYRUN" = "true" ]; then
    echo "  [DRY] 跳过验证"
else
    cd "$BACKEND_DIR"
    # ⚠️ 必须先加载 .env 变量再起 node，否则 kmsMode() 读不到 BACKUP_MASTER_KEY（此前版本此 bug 导致误报 FAIL）
    if ! set -a && . ./.env && set +a && node -e "import('./lib/backupKms.js').then(m => { const k = m.kmsMode(); if (!k) { console.error('FAIL: kmsMode() 返回 falsy'); process.exit(1) } console.log('kmsMode() = ' + k + ' ✅') }).catch(e => { console.error('FAIL:', e.message); process.exit(1) })" 2>&1; then
        fail "kmsMode() 仍返回 falsy，请检查 .env 是否真的写入了密钥（注意 systemd EnvironmentFile 不会实时更新，需重启）"
    fi
    # 同时跑一次 003_backup-now.mjs --dry-run 看端到端是否过 kmsMode()
    if [ -f scripts/003_backup-now.mjs ]; then
        echo "---"
        echo "[003_backup-now.mjs --dry-run 端到端验证]"
        if node scripts/003_backup-now.mjs --all --dry-run 2>&1 | tee /tmp/kms-dryrun.log | head -10; then
            if grep -qE "kmsMode\(\)\s*=\s*(tencent|local)" /tmp/kms-dryrun.log; then
                ok "003_backup-now.mjs dry-run 通过"
            else
                warn "dry-run 输出异常，请人工检查 /tmp/kms-dryrun.log"
            fi
        fi
    fi
fi

ok "全部完成"
echo ""
echo "[下一步]"
echo "  1. 浏览器登录学校管理员账号，进入「数据备份与恢复」→「立即备份」"
echo "  2. 平台超管进入 admin-schools.html → 备份运维 → 立即备份全库"
echo "  3. 都应该成功（不再是 500）"
echo ""
echo "[密钥持久化提醒]"
echo "  ✅  deploy.sh 已在 2026-08-18 修复：重部署会复用 BACKUP_MASTER_KEY / TENCENT_*，"
echo "      不再整体覆盖丢失。请先 git pull 把修复拉到服务器。"
echo "  ⚠️  模式 B 的 BACKUP_MASTER_KEY 仍建议单独持久化（/root/.foodsentinel-backup-secrets.env），"
echo "      双重保险：即使 .env 被意外覆盖，也能找回密钥解密历史备份。"