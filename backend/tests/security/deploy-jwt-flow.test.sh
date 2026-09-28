#!/usr/bin/env bash
# P3-W0-T01-R1 — deploy JWT 值流受控 harness。
#
# 复用的真实共享代码（与 deploy.sh 完全相同，非复制实现）：
#   - deploy/lib/jwt-config.sh::jwt_config_apply_env_overrides / jwt_config_prepare
#   - backend/scripts/validate-jwt-secrets.mjs → backend/lib/jwtSecretResolve.js → backend/lib/jwtSecretConfig.js
#   - 有效值对照使用**真实 dotenv.parse**（backend/node_modules/dotenv）
#
# 受控替身（明确标注，非端到端部署）：
#   - "persist"（写 backend/.env）与 "restart"（systemctl restart）以计数文件模拟；拒绝时两者必须为 0。
#     该控制流与 deploy.sh §5.1→§5.2→§8 同序，并由 D12 的静态行号顺序断言直接检查真实 deploy.sh。
#   - 不运行 deploy.sh 主流程：不装运行时、不动系统服务、不写真实路径、不连数据库。
#
# 安全：只用合成随机样本；失败时不打印样本值（仅 case ID 与布尔比较结果）。
#
# 用法：bash backend/tests/security/deploy-jwt-flow.test.sh
set -o pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "$HERE/../../.." && pwd)"
LIB="$ROOT/deploy/lib/jwt-config.sh"
BACKEND="$ROOT/backend"
CLI="$BACKEND/scripts/validate-jwt-secrets.mjs"

WORK="$(mktemp -d "${TMPDIR:-/tmp}/p3w0r1-flow.XXXXXX")"
PERSIST_MARK="$WORK/persist.count"
RESTART_MARK="$WORK/restart.count"
CANARY="$WORK/executed-canary"

cleanup() { rm -rf "$WORK"; }
trap cleanup EXIT

PASS=0; FAIL=0
ok_case()  { PASS=$((PASS+1)); echo "CASE $1 PASS — $2"; }
bad_case() { FAIL=$((FAIL+1)); echo "CASE $1 FAIL — expected[$2] actual[$3]"; }
expect_eq(){ if [ "$2" = "$3" ]; then ok_case "$1" "$4"; else bad_case "$1" "$2" "$3"; fi }

# shellcheck source=../../../deploy/lib/jwt-config.sh
source "$LIB"

persist_count() { [ -f "$PERSIST_MARK" ] && wc -l < "$PERSIST_MARK" | tr -d ' ' || echo 0; }
restart_count() { [ -f "$RESTART_MARK" ] && wc -l < "$RESTART_MARK" | tr -d ' ' || echo 0; }
reset_spies() { : > "$PERSIST_MARK"; : > "$RESTART_MARK"; }
# 片段中 refresh 行数（grep -c 无匹配时输出 0 但退出码非 0，必须用 || true 避免重复输出）
refresh_lines() { if [ -f "$1" ]; then grep -c 'JWT_REFRESH_SECRET=' "$1" || true; else echo 0; fi; }

# 受控部署控制流：§5.1（解析/校验/序列化）→ §5.2（persist）→ §8（restart），同序同函数。
# 参数：$1 = 旧 .env 路径；$2 = 片段输出路径
run_controlled_flow() {
    local env_file="$1" fragment_out="$2"
    jwt_config_prepare "$env_file" "$BACKEND" "$fragment_out" >/dev/null || return $?
    echo x >> "$PERSIST_MARK"
    echo x >> "$RESTART_MARK"
    return 0
}

# 用真实 dotenv.parse 比较两个文件中的 JWT 有效值（不打印任何值，仅输出 true/false）
dotenv_effective_equal() { # $1,$2 = 文件；$3 = 键
    node -e "
const fs=require('fs');
const dotenv=require(process.argv[1]);
const a=dotenv.parse(fs.readFileSync(process.argv[2],'utf8'));
const b=dotenv.parse(fs.readFileSync(process.argv[3],'utf8'));
console.log(String(a[process.argv[4]]===b[process.argv[4]]));
" "$BACKEND/node_modules/dotenv" "$1" "$2" "$3" 2>/dev/null
}

STRONG_A="$(openssl rand -base64 48)"
STRONG_B="$(openssl rand -base64 40)"
STRONG_C="$(openssl rand -hex 32)"
WEAK_EXAMPLE='please-run-openssl-rand-hex-32-and-replace-this'

echo "== deploy JWT 值流 harness（R1：有效值解析 + round-trip + 无回显）=="

# ---------- D1 显式注入强值 → 通过 + persist + restart ----------
unset JWT_SECRET JWT_REFRESH_SECRET
JWT_SECRET="$STRONG_A"; JWT_REFRESH_SECRET="$STRONG_B"; reset_spies
run_controlled_flow "$WORK/none.env" "$WORK/d1.frag"
expect_eq D1_rc 0 "$?" "显式注入强值通过校验"
expect_eq D1_persist 1 "$(persist_count)" "通过后 persist 发生"
expect_eq D1_restart 1 "$(restart_count)" "通过后 restart 发生"

# ---------- D2 配置路径 hex 值 ----------
unset JWT_SECRET JWT_REFRESH_SECRET
JWT_SECRET="$STRONG_C"; reset_spies
run_controlled_flow "$WORK/none.env" "$WORK/d2.frag"
expect_eq D2_rc 0 "$?" "hex 强值通过"
expect_eq D2_refresh_absent "$(refresh_lines "$WORK/d2.frag")" 0 "缺省 refresh 不写独立行"

# ---------- D3 旧文件裸值弱值 → 拒绝（不 persist/restart，不自动替换） ----------
unset JWT_SECRET JWT_REFRESH_SECRET
printf 'JWT_SECRET=%s\n' "$WEAK_EXAMPLE" > "$WORK/old-bare-weak.env"
reset_spies
run_controlled_flow "$WORK/old-bare-weak.env" "$WORK/d3.frag"
rc=$?
[ "$rc" -ne 0 ] && ok_case D3_rc "裸值弱值被拒绝" || bad_case D3_rc "非零" "$rc"
expect_eq D3_persist 0 "$(persist_count)" "拒绝时 persist = 0"
expect_eq D3_restart 0 "$(restart_count)" "拒绝时 restart = 0"
expect_eq D3_no_fragment "$(test -s "$WORK/d3.frag" && echo nonempty || echo empty)" empty "拒绝时不产出片段（不生成/不写回）"

# ---------- D15 旧文件**引号包裹**弱值 → 拒绝（原缺口 1 反转） ----------
unset JWT_SECRET JWT_REFRESH_SECRET
printf 'JWT_SECRET="%s"\n' "$WEAK_EXAMPLE" > "$WORK/old-quoted-weak.env"
reset_spies
run_controlled_flow "$WORK/old-quoted-weak.env" "$WORK/d15.frag"
rc=$?
[ "$rc" -ne 0 ] && ok_case D15_rc "引号包裹弱值被拒绝（有效值解析后命中名单）" || bad_case D15_rc "非零" "$rc"
expect_eq D15_persist 0 "$(persist_count)" "拒绝时 persist = 0"
expect_eq D15_no_fragment "$(test -s "$WORK/d15.frag" && echo nonempty || echo empty)" empty "拒绝时不产出片段"

# ---------- D16 弱值 + 行尾注释 → 拒绝 ----------
unset JWT_SECRET JWT_REFRESH_SECRET
printf 'JWT_SECRET=%s  # looks harmless\n' "$WEAK_EXAMPLE" > "$WORK/old-comment-weak.env"
reset_spies
run_controlled_flow "$WORK/old-comment-weak.env" "$WORK/d16.frag"
rc=$?
[ "$rc" -ne 0 ] && ok_case D16_rc "弱值带注释被拒绝" || bad_case D16_rc "非零" "$rc"
expect_eq D16_persist 0 "$(persist_count)" "拒绝时 persist = 0"

# ---------- D17 合法旧值的语法变体：解析 → 写回 → 真实 dotenv 重载一致（≥2 次部署） ----------
for variant in bare quoted commented; do
    unset JWT_SECRET JWT_REFRESH_SECRET
    case "$variant" in
        bare)      printf 'JWT_SECRET=%s\n' "$STRONG_C" > "$WORK/old-$variant.env" ;;
        quoted)    printf 'JWT_SECRET = "%s"\n' "$STRONG_C" > "$WORK/old-$variant.env" ;;
        commented) printf 'JWT_SECRET=%s   # keep\n' "$STRONG_C" > "$WORK/old-$variant.env" ;;
    esac
    run_controlled_flow "$WORK/old-$variant.env" "$WORK/d17-$variant.frag" >/dev/null
    rc=$?
    if [ "$rc" -ne 0 ]; then bad_case "D17_${variant}_rc" "0" "$rc"; continue; fi
    same1="$(dotenv_effective_equal "$WORK/old-$variant.env" "$WORK/d17-$variant.frag" JWT_SECRET)"
    expect_eq "D17_${variant}_effective" true "$same1" "写回片段的有效值与旧文件一致（真实 dotenv.parse）"

    # 第二次部署：把片段当旧文件
    run_controlled_flow "$WORK/d17-$variant.frag" "$WORK/d17-$variant.2.frag" >/dev/null
    same2="$(dotenv_effective_equal "$WORK/d17-$variant.frag" "$WORK/d17-$variant.2.frag" JWT_SECRET)"
    expect_eq "D17_${variant}_second_deploy" true "$same2" "重复部署 ≥2 次有效值稳定"
done

# ---------- D18 优先级：环境 > 旧文件（共享覆盖函数 + 同一 prepare） ----------
unset JWT_SECRET JWT_REFRESH_SECRET
printf 'JWT_SECRET=%s\n' "$STRONG_C" > "$WORK/old-priority.env"
_ENV_JWT_SECRET="$STRONG_A"
jwt_config_apply_env_overrides
expect_eq D18_env_overrides "$STRONG_A" "${JWT_SECRET:-}" "环境快照覆盖适配/旧文件值（函数级）"
run_controlled_flow "$WORK/old-priority.env" "$WORK/d18.frag" >/dev/null
same_env="$(EXPECT_ENV_VALUE="$STRONG_A" node -e '
const fs=require("fs");
const dotenv=require(process.argv[1]);
const f=dotenv.parse(fs.readFileSync(process.argv[2],"utf8"));
console.log(String(f.JWT_SECRET===process.env.EXPECT_ENV_VALUE));
' "$BACKEND/node_modules/dotenv" "$WORK/d18.frag" 2>/dev/null)"
expect_eq D18_prepare_env_wins true "$same_env" "prepare 输出使用环境值而非旧文件值"
unset _ENV_JWT_SECRET

# ---------- D19 缺失 / 不可读 / 重复键 区分（错误不得生成） ----------
unset JWT_SECRET JWT_REFRESH_SECRET
run_controlled_flow "$WORK/none-2.env" "$WORK/d19-missing.frag" >/dev/null
expect_eq D19_missing_rc 0 "$?" "文件缺失 → 走生成策略（首次部署）"

mkdir -p "$WORK/a-directory.env"
run_controlled_flow "$WORK/a-directory.env" "$WORK/d19-unreadable.frag" >/dev/null
rc=$?
[ "$rc" -eq 2 ] && ok_case D19_unreadable_rc "不可读 → 退出码 2（不被当作缺失）" || bad_case D19_unreadable_rc "2" "$rc"

printf 'JWT_SECRET=%s\nJWT_SECRET=%s\n' "$STRONG_C" "$STRONG_A" > "$WORK/dup.env"
run_controlled_flow "$WORK/dup.env" "$WORK/d19-dup.frag" >/dev/null
rc=$?
[ "$rc" -eq 2 ] && ok_case D19_duplicate_rc "重复键 → 退出码 2" || bad_case D19_duplicate_rc "2" "$rc"

# ---------- D20 部署表示限制：注入值含 # / 引号 / 反斜线 → 拒绝 ----------
for kind in hash quote backslash; do
    unset JWT_SECRET JWT_REFRESH_SECRET
    case "$kind" in
        hash)      JWT_SECRET="${STRONG_C}#tail" ;;
        quote)     JWT_SECRET="\"${STRONG_C}\"" ;;
        backslash) JWT_SECRET="${STRONG_C}\\tail" ;;
    esac
    reset_spies
    run_controlled_flow "$WORK/none.env" "$WORK/d20-$kind.frag" >/dev/null
    rc=$?
    [ "$rc" -ne 0 ] && ok_case "D20_${kind}_rc" "含 ${kind} 的值在写回前被拒绝" || bad_case "D20_${kind}_rc" "非零" "$rc"
    expect_eq "D20_${kind}_persist" 0 "$(persist_count)" "拒绝时 persist = 0"
done

# ---------- D21 CLI 错误路径不回显参数（合成 canary） ----------
CANARY_ARG="p3w0r1-canary-$(openssl rand -hex 8)"
out_err="$(node "$CLI" "$CANARY_ARG" 2>&1)"; rc=$?
[ "$rc" -eq 2 ] && ok_case D21_unknown_arg_rc "未知参数 → 退出码 2" || bad_case D21_unknown_arg_rc "2" "$rc"
if printf '%s' "$out_err" | grep -qF "p3w0r1-canary"; then bad_case D21_no_echo "输出不含 canary" "含有 canary 片段"; else ok_case D21_no_echo "未知参数输出不含参数值"; fi

out_err2="$(node "$CLI" --help "$CANARY_ARG" 2>&1)"; rc=$?
[ "$rc" -eq 2 ] && ok_case D21_help_mixed_rc "--help 混入其它参数 → 用法错误" || bad_case D21_help_mixed_rc "2" "$rc"
if printf '%s' "$out_err2" | grep -qF "p3w0r1-canary"; then bad_case D21_help_no_echo "输出不含 canary" "含有 canary 片段"; else ok_case D21_help_no_echo "--help 混用输出不含参数值"; fi

out_help="$(node "$CLI" --help 2>&1)"; rc=$?
[ "$rc" -eq 0 ] && ok_case D21_bare_help_rc "纯 --help → 成功（唯一的成功用法）" || bad_case D21_bare_help_rc "0" "$rc"
if printf '%s' "$out_help" | grep -qE "source-env-file|write-fragment"; then ok_case D21_bare_help_usage "纯 --help 打印固定用法文本"; else bad_case D21_bare_help_usage "含用法项" "不含"; fi

# ---------- D14 set -u 下 optional refresh 未设置：跑到真实序列化 ----------
unset JWT_SECRET JWT_REFRESH_SECRET
STRICT_OUT="$(bash -c 'set -u; source "$1"; JWT_SECRET="$2"; unset JWT_REFRESH_SECRET; jwt_config_prepare "" "$3" "$4" >/dev/null; echo "rc=$?"' _ "$LIB" "$STRONG_A" "$BACKEND" "$WORK/d14.frag" 2>&1)"
case "$STRICT_OUT" in
    *"rc=0"*) ok_case D14_strict "set -u 下 refresh 未设置跑到序列化完成（无未绑定变量错误）" ;;
    *) bad_case D14_strict "rc=0" "$STRICT_OUT" ;;
esac
expect_eq D14_refresh_derived "$(refresh_lines "$WORK/d14.frag")" 0 "缺省 refresh 不写独立行（派生语义）"

# ---------- D9 canary：旧值含命令替换 → 不得执行 ----------
unset JWT_SECRET JWT_REFRESH_SECRET
printf 'JWT_SECRET="$(touch %s)-padding-to-exceed-thirty-two-bytes"\n' "$CANARY" > "$WORK/old-canary.env"
run_controlled_flow "$WORK/old-canary.env" "$WORK/d9.frag" >/dev/null
if [ -e "$CANARY" ]; then bad_case D9_noexec "canary 不存在" "canary 被执行"; else ok_case D9_noexec "旧值内容未被作为 shell 代码执行"; fi

# ---------- D12 静态顺序断言：真实 deploy.sh 的 校验 → 共享组装 → 共享发布 < restart ----------
# （P3-W0-T01-R3 / A：组装移入唯一共享函数 jwt_config_assemble_env；deploy.sh 不再自建 heredoc）
LINE_VALIDATE=$(grep -n 'jwt_config_prepare "\$BACKEND_ENV"' "$ROOT/deploy/deploy.sh" | head -1 | cut -d: -f1)
LINE_ASSEMBLE=$(grep -n 'jwt_config_assemble_env' "$ROOT/deploy/deploy.sh" | head -1 | cut -d: -f1)
LINE_PUBLISH=$(grep -n 'jwt_config_publish_env "\$JWT_STAGING" "\$BACKEND_ENV"' "$ROOT/deploy/deploy.sh" | head -1 | cut -d: -f1)
LINE_RESTART=$(grep -n 'systemctl restart "\$APP_NAME"' "$ROOT/deploy/deploy.sh" | head -1 | cut -d: -f1)
if [ -n "$LINE_VALIDATE" ] && [ -n "$LINE_ASSEMBLE" ] && [ -n "$LINE_PUBLISH" ] && [ -n "$LINE_RESTART" ] \
   && [ "$LINE_VALIDATE" -lt "$LINE_ASSEMBLE" ] && [ "$LINE_ASSEMBLE" -lt "$LINE_PUBLISH" ] \
   && [ "$LINE_PUBLISH" -lt "$LINE_RESTART" ]; then
    ok_case D12_order "deploy.sh 顺序：校验($LINE_VALIDATE) < 组装($LINE_ASSEMBLE) < 发布($LINE_PUBLISH) < restart($LINE_RESTART)"
else
    bad_case D12_order "validate<assemble<publish<restart" "$LINE_VALIDATE/$LINE_ASSEMBLE/$LINE_PUBLISH/$LINE_RESTART"
fi

# ---------- D13 静态断言：JWT 键不再经过 eval 复用循环 ----------
if grep -A3 'for k in PG_PASSWORD' "$ROOT/deploy/deploy.sh" | grep -q 'JWT_SECRET'; then
    bad_case D13_no_eval "JWT 键不在 eval 复用循环中" "仍出现在循环键列表"
else
    ok_case D13_no_eval "JWT 键已移出 eval 复用循环（共享库安全处理）"
fi

echo
echo "DEPLOY-FLOW RESULT: pass=$PASS fail=$FAIL"
[ "$FAIL" -eq 0 ] || exit 1
exit 0
