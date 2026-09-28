#!/usr/bin/env bash
# P3-W0-T01-R3 — 部署分发（D1，保留）与完整组装/发布成功路径（共享唯一实现）。
#
# 复用真实共享代码：deploy/lib/jwt-config.sh（jwt_config_assemble_env / jwt_config_publish_env /
# jwt_config_prepare / 生命周期）与真实 deploy/deploy.sh（分发负例/正例）。
# 组装不再由测试自写：assemble_and_publish 仅是按生产调用序列的**纯调用包装**。
# 全部在任务临时目录、合成值；不连接数据库、不运行真实部署主体。
# 故障注入部分在同目录另一个文件：deploy-env-fault-injection.test.sh。
#
# 用法：bash backend/tests/security/deploy-distribution-lifecycle.test.sh
set -o pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "$HERE/../../.." && pwd)"
LIB="$ROOT/deploy/lib/jwt-config.sh"
BACKEND="$ROOT/backend"
DEPLOY_SH="$ROOT/deploy/deploy.sh"

WORK="$(mktemp -d "${TMPDIR:-/tmp}/p3w0r3-lifecycle.XXXXXX")"
SPY_BIN="$WORK/bin"
SPY_LOG="$WORK/spy.log"
mkdir -p "$SPY_BIN"
cleanup() { rm -rf "$WORK"; }
trap cleanup EXIT

PASS=0; FAIL=0
ok_case()  { PASS=$((PASS+1)); echo "CASE $1 PASS — $2"; }
bad_case() { FAIL=$((FAIL+1)); echo "CASE $1 FAIL — expected[$2] actual[$3]"; }
expect_eq(){ if [ "$2" = "$3" ]; then ok_case "$1" "$4"; else bad_case "$1" "$2" "$3"; fi }
expect_true() { if [ "$2" = "true" ]; then ok_case "$1" "$3"; else bad_case "$1" "true" "$2"; fi }

# shellcheck source=../../../deploy/lib/jwt-config.sh
source "$LIB"

STRONG_A="$(openssl rand -base64 48)"
STRONG_B="$(openssl rand -base64 40)"
sha256() { shasum -a 256 "$1" | awk '{print $1}'; }
file_mode() { node -e 'console.log((require("fs").statSync(process.argv[1]).mode & 0o777).toString(8))' "$1"; }
dotenv_get() { # $1=文件 $2=键 $3=期望值（经环境传递，不进 argv）
    EXPECT_VAL="$3" node -e '
const fs=require("fs");
const dotenv=require(process.argv[1]);
const v=dotenv.parse(fs.readFileSync(process.argv[2],"utf8"))[process.argv[3]];
console.log(String(v===process.env.EXPECT_VAL));
' "$BACKEND/node_modules/dotenv" "$1" "$2" 2>/dev/null
}
dotenv_has_key() {
    node -e '
const fs=require("fs");
const dotenv=require(process.argv[1]);
const v=dotenv.parse(fs.readFileSync(process.argv[2],"utf8"))[process.argv[3]];
console.log(String(v!==undefined && v!==""));
' "$BACKEND/node_modules/dotenv" "$1" "$2" 2>/dev/null
}
nonjwt_fields_ok() { # 完整非 JWT 字段集合与值的逐项核对（只输出布尔）
    node -e '
const fs=require("fs");
const dotenv=require(process.argv[1]);
const env=dotenv.parse(fs.readFileSync(process.argv[2],"utf8"));
const expect={
  NODE_ENV:"production", PORT:"3000", SERVE_STATIC:"false",
  DATABASE_URL:"postgresql://u:p@127.0.0.1:5432/db", JWT_EXPIRE:"7d",
  CORS_ORIGIN:"http://127.0.0.1:8080",
  SEED_ADMIN_PASSWORD:"seed-admin", SEED_OPERATOR_PASSWORD:"seed-operator", SEED_VIEWER_PASSWORD:"seed-viewer",
  BACKUP_DIR:"/var/backups/x", BACKUP_KEEP_DAYS:"7", BACKUP_MASTER_KEY:"master-key",
  TENCENT_SECRET_ID:"tid", TENCENT_SECRET_KEY:"tkey", TENCENT_KMS_REGION:"ap-guangzhou", TENCENT_KMS_KEY_ID:"kid",
};
console.log(String(Object.entries(expect).every(([k,v])=>env[k]===v)));
' "$BACKEND/node_modules/dotenv" "$1" 2>/dev/null
}

echo "===== D1：分发布局与早期拒绝（真实 deploy.sh 入口）====="
for _spy in apt-get apt systemctl psql git useradd curl openssl; do
    cat > "$SPY_BIN/$_spy" <<'SPY'
#!/usr/bin/env bash
echo "$(basename "$0") $*" >> "${P3W0R2_SPY_LOG:-/dev/null}"
exit 127
SPY
    chmod +x "$SPY_BIN/$_spy"
done
unset _spy

mk_pkg() {
    local variant="$1" pkg="$WORK/pkg-$variant"
    rm -rf "$pkg"; mkdir -p "$pkg"
    cp "$DEPLOY_SH" "$pkg/deploy.sh"
    printf 'SYSTEM_NAME=""\n' > "$pkg/deploy.sys.conf"
    case "$variant" in
        missing-lib)     : ;;
        lib-is-dir)      mkdir -p "$pkg/lib/jwt-config.sh" ;;
        lib-unreadable)  mkdir -p "$pkg/lib"; cp "$LIB" "$pkg/lib/jwt-config.sh"; chmod 000 "$pkg/lib/jwt-config.sh" ;;
        lib-broken)      mkdir -p "$pkg/lib"; printf 'if true\n' > "$pkg/lib/jwt-config.sh" ;;
        lib-missing-fn)  mkdir -p "$pkg/lib"; printf 'jwt_config_apply_env_overrides() { return 0; }\n' > "$pkg/lib/jwt-config.sh" ;;
        full)            mkdir -p "$pkg/lib"; cp "$LIB" "$pkg/lib/jwt-config.sh" ;;
    esac
    printf '%s' "$pkg"
}
run_pkg() {
    local pkg="$1"
    : > "$SPY_LOG"
    OUT="$(PATH="$SPY_BIN:$PATH" P3W0R2_SPY_LOG="$SPY_LOG" bash "$pkg/deploy.sh" "$pkg/deploy.sys.conf" 2>&1)"
    RC=$?
}
spy_count() { if [ -f "$SPY_LOG" ]; then wc -l < "$SPY_LOG" | tr -d ' '; else echo 0; fi; }

for variant in missing-lib lib-is-dir lib-unreadable lib-broken lib-missing-fn; do
    pkg="$(mk_pkg "$variant")"
    run_pkg "$pkg"
    expect_eq "D1_${variant}_rc" 1 "$RC" "分发异常（${variant}）真实入口非零退出"
    expect_eq "D1_${variant}_spies" 0 "$(spy_count)" "早期拒绝：安装/系统/数据库/git spy 全 0"
    expect_true "D1_${variant}_no_adapter" "$(printf '%s' "$OUT" | grep -qF '已加载适配文件' && echo false || echo true)" "未走到 §0"
done
pkg_full="$(mk_pkg full)"
run_pkg "$pkg_full"
expect_eq D1_full_rc 1 "$RC" "完整布局：在 §0 必填项处停止（副作用前）"
expect_true D1_full_no_lib_error "$(printf '%s' "$OUT" | grep -qF 'JWT 共享库' && echo false || echo true)" "不再报库错误（依赖检查通过）"
expect_true D1_full_adapter_loaded "$(printf '%s' "$OUT" | grep -qF '已加载适配文件' && echo true || echo false)" "依赖加载证明：到达 §0"
expect_eq D1_full_spies 0 "$(spy_count)" "未执行安装/系统/数据库/git"

echo "===== B：成功完整组装/发布（共享唯一实现；期望值独立保存）====="

# 生产变量契约（调用方以全局变量提供；值与 deploy.sh 语义一致）
set_contract_vars() {
    API_PORT=3000
    DATABASE_URL='postgresql://u:p@127.0.0.1:5432/db'
    JWT_EXPIRE=7d
    CORS_ORIGIN='http://127.0.0.1:8080'
    SEED_ADMIN_PASSWORD=seed-admin
    SEED_OPERATOR_PASSWORD=seed-operator
    SEED_VIEWER_PASSWORD=seed-viewer
    BACKUP_DIR=/var/backups/x
    BACKUP_KEEP_DAYS=7
    BACKUP_MASTER_KEY=master-key
    TENCENT_SECRET_ID=tid
    TENCENT_SECRET_KEY=tkey
    TENCENT_KMS_REGION=ap-guangzhou
    TENCENT_KMS_KEY_ID=kid
}

# 纯调用包装：与 deploy.sh §5.1→§5.2 相同调用序列，不含任何自写组装内容
assemble_and_publish() { # $1=旧env $2=目标 $3=fragment 覆盖(可选) $4=owner(可选)
    local old="$1" target="$2" frag_override="${3:-}" owner="${4:-}"
    jwt_config_register_cleanup_traps
    jwt_config_make_secure_tmp "${TMPDIR:-/tmp}" || return 10
    local frag="$JWT_TMP_PATH"; jwt_config_track_tmp "$frag"
    if [ -n "$frag_override" ]; then
        frag="$frag_override"
    else
        jwt_config_prepare "$old" "$BACKEND" "$frag" || return 11
    fi
    jwt_config_make_secure_tmp "$(dirname -- "$target")" || return 12
    local staging="$JWT_TMP_PATH"; jwt_config_track_tmp "$staging"
    set_contract_vars
    JWT_ASSEMBLE_STAGING="$staging"; JWT_ASSEMBLE_FRAGMENT="$frag"
    jwt_config_assemble_env || return 13
    rm -f -- "$frag" 2>/dev/null || true
    jwt_config_publish_env "$staging" "$target" "$owner" || return 17
    return 0
}

# owner：本机无服务用户，使用当前用户作为**明确标注的受控替身**（生产为 $SYSTEM_NAME:$SYSTEM_NAME）
CUR_OWNER="$(id -un):$(id -gn)"

# B1 成功（显式 refresh；OLD 与 TARGET 分离，期望值来自独立旧副本）
T1="$WORK/b1"; mkdir -p "$T1"; OLD1="$T1/old.env"; TGT1="$T1/target.env"
printf 'NODE_ENV=production\nDATABASE_URL=postgresql://u:p@127.0.0.1:5432/db\nJWT_SECRET=%s\nJWT_REFRESH_SECRET=%s\nJWT_EXPIRE=7d\n' "$STRONG_A" "$STRONG_B" > "$OLD1"
OLD1_HASH="$(sha256 "$OLD1")"
B1_OUT="$(assemble_and_publish "$OLD1" "$TGT1" "" "$CUR_OWNER" 2>&1)"; rc=$?
expect_eq B1_rc 0 "$rc" "成功写回（显式 refresh；owner=当前用户替身）"
expect_true B1_access_expected "$(dotenv_get "$TGT1" JWT_SECRET "$STRONG_A")" "access 等于独立保存的旧副本值（真实 dotenv 重载）"
expect_true B1_refresh_expected "$(dotenv_get "$TGT1" JWT_REFRESH_SECRET "$STRONG_B")" "显式 refresh 等于独立保存值"
expect_true B1_fields_ok "$(nonjwt_fields_ok "$TGT1")" "完整非 JWT 字段集合及值逐项一致（16 项）"
expect_eq B1_mode 600 "$(file_mode "$TGT1")" "目标 mode=600（staging 核验后 mv）"
expect_true B1_old_untouched "$([ -f "$OLD1" ] && [ "$(sha256 "$OLD1")" = "$OLD1_HASH" ] && echo true || echo false)" "旧副本文件未被修改"
cp "$TGT1" "$T1/old2.env"
B1_OUT2="$(assemble_and_publish "$T1/old2.env" "$TGT1" "" "$CUR_OWNER" 2>&1)"; rc2=$?
expect_eq B1_second_rc 0 "$rc2" "第二次部署成功"
expect_true B1_second_access "$(dotenv_get "$TGT1" JWT_SECRET "$STRONG_A")" "第二次部署 access 值仍一致"
expect_true B1_no_value_in_out "$(printf '%s' "$B1_OUT$B1_OUT2" | grep -qF "$STRONG_A" && echo false || echo true)" "流程输出不含 access 值"

# B2 成功（缺省 refresh）
T2="$WORK/b2"; mkdir -p "$T2"; OLD2="$T2/old.env"; TGT2="$T2/target.env"
printf 'NODE_ENV=production\nDATABASE_URL=postgresql://u:p@127.0.0.1:5432/db\nJWT_SECRET=%s\n' "$STRONG_A" > "$OLD2"
assemble_and_publish "$OLD2" "$TGT2" "" >/dev/null 2>&1; rc=$?
expect_eq B2_rc 0 "$rc" "成功写回（缺省 refresh）"
expect_eq B2_refresh_absent false "$(dotenv_has_key "$TGT2" JWT_REFRESH_SECRET)" "缺省 refresh 不写独立值"
expect_true B2_access_expected "$(dotenv_get "$TGT2" JWT_SECRET "$STRONG_A")" "access 与独立旧副本一致"

echo
echo "LIFECYCLE RESULT: pass=$PASS fail=$FAIL"
[ "$FAIL" -eq 0 ] || exit 1
exit 0
