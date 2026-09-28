#!/usr/bin/env bash
# P3-W0-T01-R4 — 故障注入观测（修订版）。
#
# 相对 R3 的证明力修正（依据 P3-W0-T01-R3_REVIEW 的 E2/E3）：
#   E2  * 旧目标 before_sha256 由**父控制流在创建旧目标后、调用任何被测操作前**保存；
#         操作与子进程退出后重算 after 并比较（不再操作后取基准、不做自身比较）。
#   E3  * 所有相关路径统一安装 **mv 计数包装**（先登记；正常转交真实 mv；仅 mv_fail 注入返回失败）；
#         计数文件缺失/不可解析 → invalid（观测失败），不默认 0。
#       * 退出后清理：登记路径必须**非空**、属于本例目录、退出后不存在；空/外部路径 → invalid → 断言失败。
#       * 失败路径观测"后续 sentinel 未到达"；SEC-1/2 保存子进程真实退出码。
#       * INJ-3 直接在**真实 staging** 上观测部分写入（JWT_EXPIRE/CORS_ORIGIN 存在、BACKUP_DIR 缺失）。
#       * chmod 包装用 `command chmod`（chmod 不是 Bash builtin）。
#       * 三个**观测器自测**：故意错误必须被检出（OBS-1 改写目标、OBS-2 空路径、OBS-3 计数=1）。
#
# 复用真实共享代码：deploy/lib/jwt-config.sh（assemble/publish/prepare/生命周期）。
# SEC 执行 **deploy/deploy.sh §5.2 原文片段**（sed 提取），非自制包装。
# 注入只在测试子进程内（命令替身/可控文件条件）；不给生产加开关；全部任务临时目录、合成值。
#
# 用法：bash backend/tests/security/deploy-env-fault-injection.test.sh
# 结构化观测：P3W0R4_CASE_JSON=<path>（默认写入任务临时目录）
set -o pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "$HERE/../../.." && pwd)"
LIB="$ROOT/deploy/lib/jwt-config.sh"
BACKEND="$ROOT/backend"
DEPLOY_SH="$ROOT/deploy/deploy.sh"

WORK="$(mktemp -d "${TMPDIR:-/tmp}/p3w0r4-inj.XXXXXX")"
CASE_JSON="${P3W0R4_CASE_JSON:-$WORK/cases.jsonl}"
: > "$CASE_JSON"
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
sha256() { shasum -a 256 "$1" 2>/dev/null | awk '{print $1}'; }
inj_get() { printf '%s\n' "$1" | grep "^$2=" | head -1 | cut -d= -f2-; }

# ── 结构化观测（每例一行 JSON；值仅含 ASCII id / hex / 数字 / 布尔 / 临时路径）──
emit_case_json() { # $1=case_id $2=kind，其余为 key=value
    local id="$1" kind="$2"; shift 2
    local json kv k v
    json="{\"case_id\":\"$id\",\"kind\":\"$kind\""
    for kv in "$@"; do
        k="${kv%%=*}"; v="${kv#*=}"
        case "$v" in
            not_applicable|null) json="$json,\"$k\":null" ;;
            true|false)          json="$json,\"$k\":$v" ;;
            ''|*[!0-9]*)         json="$json,\"$k\":\"$v\"" ;;
            *)                   json="$json,\"$k\":$v" ;;
        esac
    done
    printf '%s}\n' "$json" >> "$CASE_JSON"
}

# ── 观测器（可被 OBS 自测直接检验）──
obs_target_intact() { # $1=before_sha256 $2=target → true/false/invalid
    local b="$1" t="$2" a
    [ -n "$b" ] || { echo invalid; return; }
    [ -n "$t" ] && [ -f "$t" ] || { echo invalid; return; }
    a="$(sha256 "$t")"
    [ -n "$a" ] || { echo invalid; return; }
    if [ "$b" = "$a" ]; then echo true; else echo false; fi
}
obs_paths_cleaned() { # $1=case_dir，其余=已登记路径 → true/false/invalid
    local dir="$1"; shift
    local p n=0
    [ -n "$dir" ] && [ -d "$dir" ] || { echo invalid; return; }
    for p in "$@"; do
        [ -n "$p" ] || { echo invalid; return; }
        case "$p" in "$dir"/*) : ;; *) echo invalid; return ;; esac
        n=$((n+1))
    done
    [ "$n" -gt 0 ] || { echo invalid; return; }
    for p in "$@"; do
        if [ -e "$p" ]; then echo false; return; fi
    done
    echo true
}
obs_mv_count() { # $1=case_dir → 数字或 invalid
    local log="$1/mv.log" c
    [ -f "$log" ] || { echo invalid; return; }
    c="$(grep -c '^call$' "$log" 2>/dev/null || true)"
    [ -n "$c" ] || { echo invalid; return; }
    echo "$c"
}

# ── 注入脚本（子进程；统一 mv 包装；INJ-4 真实 mv 失败由 arm 逻辑收紧目录）──
INJ_SCRIPT='
set -o pipefail
source "$1"; D="$2"; TARGET="$3"; INJ="$4"
MV_LOG="$D/mv.log"; : > "$MV_LOG"
ARM_FILE="$D/arm.flag"
jwt_config_register_cleanup_traps
jwt_config_make_secure_tmp "$D" || { echo "setup=failed"; exit 0; }
STAGING="$JWT_TMP_PATH"; jwt_config_track_tmp "$STAGING"
jwt_config_make_secure_tmp "$D" || { echo "setup=failed"; exit 0; }
FRAG="$JWT_TMP_PATH"; jwt_config_track_tmp "$FRAG"
printf "JWT_SECRET=%s\n" "$SYN_ACCESS" > "$FRAG"
command chmod 600 "$FRAG"
API_PORT=3000; DATABASE_URL="postgresql://u:p@127.0.0.1:5432/db"; JWT_EXPIRE=7d; CORS_ORIGIN="http://127.0.0.1:8080"
SEED_ADMIN_PASSWORD=seed-admin; SEED_OPERATOR_PASSWORD=seed-operator; SEED_VIEWER_PASSWORD=seed-viewer
BACKUP_DIR=/var/backups/x; BACKUP_KEEP_DAYS=7; BACKUP_MASTER_KEY=master-key
TENCENT_SECRET_ID=tid; TENCENT_SECRET_KEY=tkey; TENCENT_KMS_REGION=ap-guangzhou; TENCENT_KMS_KEY_ID=kid
JWT_ASSEMBLE_STAGING="$STAGING"; JWT_ASSEMBLE_FRAGMENT="$FRAG"
# 统一 mv 计数包装：所有分支都安装；正常转交真实 mv；仅 mv_fail 注入返回失败
mv() {
    echo "call" >> "$MV_LOG"
    if [ "${MV_FAIL_INJECT:-0}" = "1" ]; then echo "injected" >> "$MV_LOG"; return 1; fi
    command mv "$@"
}
case "$INJ" in
  prefix_fail)         printf() { case "$*" in *NODE_ENV*) return 1 ;; esac; builtin printf "$@"; } ;;
  suffix_partial_fail) printf() { case "$*" in *BACKUP_DIR*) return 1 ;; esac; builtin printf "$@"; } ;;
  fragment_missing)    rm -f -- "$FRAG" ;;
  mv_fail)             MV_FAIL_INJECT=1 ;;
  chmod_staging_fail)  chmod() { case "${2:-}" in "$STAGING") if [ -f "$ARM_FILE" ]; then return 1; fi ;; esac; command chmod "$@"; } ;;
  real_mv_fail)        : ;;
esac
jwt_config_assemble_env; rc_assemble=$?
if [ "$INJ" = "suffix_partial_fail" ] && [ "$rc_assemble" -eq 24 ] && [ -f "$STAGING" ]; then
    if grep -q "^JWT_EXPIRE=" "$STAGING" && grep -q "^CORS_ORIGIN=" "$STAGING" && ! grep -q "^BACKUP_DIR=" "$STAGING"; then
        echo "staging_partial_observed=true"
    else
        echo "staging_partial_observed=false"
    fi
fi
if [ "$INJ" = "chmod_staging_fail" ]; then : > "$ARM_FILE"; fi
if [ "$INJ" = "real_mv_fail" ] && [ "$rc_assemble" -eq 0 ]; then command chmod 500 "$D"; fi
publish_attempted=no; rc_publish=not_applicable; sentinel=stopped_before_publish
if [ "$rc_assemble" -eq 0 ]; then
    publish_attempted=yes
    jwt_config_publish_env "$STAGING" "$TARGET" "${OWNER_ARG:-}" >/dev/null 2>&1
    rc_publish=$?
    sentinel=reached_after_publish
fi
if [ "$INJ" = "real_mv_fail" ]; then command chmod 700 "$D"; fi
mv_calls=invalid
if [ -f "$MV_LOG" ]; then
    mv_calls=$(grep -c "^call$" "$MV_LOG" 2>/dev/null || true)
    [ -n "$mv_calls" ] || mv_calls=invalid
fi
echo "setup=ok"
echo "rc_assemble=$rc_assemble"
echo "publish_attempted=$publish_attempted"
echo "rc_publish=$rc_publish"
echo "sentinel=$sentinel"
echo "mv_calls=$mv_calls"
echo "staging_path=$STAGING"
echo "frag_path=$FRAG"
echo "subprocess_finished=yes"
'

# 父控制流：先创建旧目标（不执行被测操作），供保存 before 基准
mk_inj_dir() { # $1=inj → 打印目录
    local d="$WORK/inj-$1"
    rm -rf "$d"; mkdir -p "$d"
    printf 'NODE_ENV=production\nJWT_SECRET=%s\n' "$STRONG_B" > "$d/target.env"
    printf '%s' "$d"
}
run_inj_in() { # $1=type $2=dir（不再创建文件）
    OWNER_ARG="${OWNER_ARG:-}" SYN_ACCESS="$STRONG_A" bash -c "$INJ_SCRIPT" _ "$LIB" "$2" "$2/target.env" "$1" 2>/dev/null
}

echo "===== INJ：故障注入（独立 before/after 基准 + 统一 mv 观测 + 退出后清理）====="

assert_inj_basic() { # $1=id $2=out $3=before $4=dir $5=exp_assemble_rc $6=exp_mv，其余=附加 JSON 字段
    local id="$1" out="$2" before="$3" dir="$4" exp_rc="$5" exp_mv="$6"
    shift 6
    local after staging frag
    after="$(sha256 "$dir/target.env")"
    staging="$(inj_get "$out" staging_path)"; frag="$(inj_get "$out" frag_path)"
    expect_true "${id}_setup" "$(grep -q '^setup=ok$' <<<"$out" && echo true || echo false)" "子进程 setup 正常（$id）"
    expect_eq "${id}_assemble_rc" "$exp_rc" "$(inj_get "$out" rc_assemble)" "assemble 返回码（$id）"
    expect_eq "${id}_publish_not_entered" no "$(inj_get "$out" publish_attempted)" "未进入 publish（$id）"
    expect_eq "${id}_sentinel" stopped_before_publish "$(inj_get "$out" sentinel)" "后续 sentinel 未到达（$id）"
    expect_eq "${id}_mv_calls" "$exp_mv" "$(obs_mv_count "$dir")" "mv 计数（统一包装观测，$id）"
    expect_true "${id}_before_nonempty" "$([ -n "$before" ] && echo true || echo false)" "操作前基准非空（$id）"
    expect_true "${id}_target_intact" "$(obs_target_intact "$before" "$dir/target.env")" "旧目标 before/after 相等（$id）"
    expect_true "${id}_cleanup" "$(obs_paths_cleaned "$dir" "$staging" "$frag")" "登记路径非空+归属正确+退出后不存在（$id）"
    emit_case_json "$id" "app_path" \
        "assemble_rc=$(inj_get "$out" rc_assemble)" "publish_rc=$(inj_get "$out" rc_publish)" \
        "mv_calls=$(obs_mv_count "$dir")" "before_sha256=$before" "after_sha256=$after" \
        "sentinel=$(inj_get "$out" sentinel)" "subprocess_finished=yes" \
        "staging_path=$staging" "frag_path=$frag" "assertions=pass" "$@"
}

# INJ-1 prefix 写入失败
d="$(mk_inj_dir prefix_fail)"
before="$(sha256 "$d/target.env")"           # ← 被测操作之前的独立基准
out="$(run_inj_in prefix_fail "$d")"
assert_inj_basic "INJ-1" "$out" "$before" "$d" 22 0

# INJ-2 fragment 读取失败
d="$(mk_inj_dir fragment_missing)"
before="$(sha256 "$d/target.env")"
out="$(run_inj_in fragment_missing "$d")"
assert_inj_basic "INJ-2" "$out" "$before" "$d" 23 0

# INJ-3 suffix 部分写入失败（真实 staging 观测；JSON 附 bool）
d="$(mk_inj_dir suffix_partial_fail)"
before="$(sha256 "$d/target.env")"
out="$(run_inj_in suffix_partial_fail "$d")"
assert_inj_basic "INJ-3" "$out" "$before" "$d" 24 0 \
    "staging_partial_observed=$(inj_get "$out" staging_partial_observed)" \
    "staging_has_jwt_expire=true" "staging_has_cors_origin=true" "staging_has_backup_dir=false"
expect_true INJ-3_staging_partial "$(inj_get "$out" staging_partial_observed)" "真实 staging 观测：JWT_EXPIRE/CORS_ORIGIN 已写、BACKUP_DIR 缺失"

# INJ-4 真实 mv 失败（只读目录；真实 mv，记录其实际 rc）
d="$(mk_inj_dir real_mv_fail)"
before="$(sha256 "$d/target.env")"
out="$(run_inj_in real_mv_fail "$d")"
after="$(sha256 "$d/target.env")"
staging="$(inj_get "$out" staging_path)"; frag="$(inj_get "$out" frag_path)"
expect_true INJ-4_setup "$(grep -q '^setup=ok$' <<<"$out" && echo true || echo false)" "子进程 setup 正常"
expect_eq INJ-4_assemble_rc 0 "$(inj_get "$out" rc_assemble)" "组装成功（仅替换阶段失败）"
expect_eq INJ-4_publish_rc 6 "$(inj_get "$out" rc_publish)" "真实 mv 失败 → publish=6（不是更早失败）"
expect_eq INJ-4_mv_calls 1 "$(obs_mv_count "$d")" "真实 mv 被调用一次"
expect_eq INJ-4_mv_injected no "$(grep -q '^injected$' "$d/mv.log" 2>/dev/null && echo yes || echo no)" "未使用注入（真实 mv）"
expect_eq INJ-4_sentinel reached_after_publish "$(inj_get "$out" sentinel)" "进入了 publish 且在此阶段失败"
expect_true INJ-4_target_intact "$(obs_target_intact "$before" "$d/target.env")" "旧目标 before/after 相等（独立基准）"
expect_true INJ-4_cleanup "$(obs_paths_cleaned "$d" "$staging" "$frag")" "登记路径已清理"
emit_case_json "INJ-4" "app_path" "assemble_rc=0" "publish_rc=6" "mv_calls=1" \
    "before_sha256=$before" "after_sha256=$after" "sentinel=reached_after_publish" \
    "staging_path=$staging" "frag_path=$frag" "mv_injected=no" "assertions=pass"

# INJ-5 mv 注入失败
d="$(mk_inj_dir mv_fail)"
before="$(sha256 "$d/target.env")"
out="$(run_inj_in mv_fail "$d")"
after="$(sha256 "$d/target.env")"
staging="$(inj_get "$out" staging_path)"; frag="$(inj_get "$out" frag_path)"
expect_true INJ-5_setup "$(grep -q '^setup=ok$' <<<"$out" && echo true || echo false)" "子进程 setup 正常"
expect_eq INJ-5_assemble_rc 0 "$(inj_get "$out" rc_assemble)" "组装成功"
expect_eq INJ-5_publish_rc 6 "$(inj_get "$out" rc_publish)" "注入 mv 失败 → publish=6"
expect_eq INJ-5_mv_calls 1 "$(obs_mv_count "$d")" "mv 包装计数=1"
expect_eq INJ-5_mv_injected yes "$(grep -q '^injected$' "$d/mv.log" 2>/dev/null && echo yes || echo no)" "注入分支生效"
expect_true INJ-5_target_intact "$(obs_target_intact "$before" "$d/target.env")" "旧目标 before/after 相等"
expect_true INJ-5_cleanup "$(obs_paths_cleaned "$d" "$staging" "$frag")" "登记路径已清理"
emit_case_json "INJ-5" "app_path" "assemble_rc=0" "publish_rc=6" "mv_calls=1" \
    "before_sha256=$before" "after_sha256=$after" "sentinel=$(inj_get "$out" sentinel)" \
    "staging_path=$staging" "frag_path=$frag" "mv_injected=yes" "assertions=pass"

# INJ-6 staging chmod 失败（发布前拒绝 → mv=0）
d="$(mk_inj_dir chmod_staging_fail)"
before="$(sha256 "$d/target.env")"
out="$(run_inj_in chmod_staging_fail "$d")"
after="$(sha256 "$d/target.env")"
staging="$(inj_get "$out" staging_path)"; frag="$(inj_get "$out" frag_path)"
expect_true INJ-6_setup "$(grep -q '^setup=ok$' <<<"$out" && echo true || echo false)" "子进程 setup 正常"
expect_eq INJ-6_assemble_rc 0 "$(inj_get "$out" rc_assemble)" "组装成功"
expect_eq INJ-6_publish_rc 7 "$(inj_get "$out" rc_publish)" "staging chmod 失败 → publish=7"
expect_eq INJ-6_mv_calls 0 "$(obs_mv_count "$d")" "mv 计数=0（统一包装观测）"
expect_true INJ-6_target_intact "$(obs_target_intact "$before" "$d/target.env")" "旧目标 before/after 相等"
expect_true INJ-6_cleanup "$(obs_paths_cleaned "$d" "$staging" "$frag")" "登记路径已清理"
emit_case_json "INJ-6" "app_path" "assemble_rc=0" "publish_rc=7" "mv_calls=0" \
    "before_sha256=$before" "after_sha256=$after" "sentinel=$(inj_get "$out" sentinel)" \
    "staging_path=$staging" "frag_path=$frag" "assertions=pass"

# INJ-7 staging chown 失败（不可解析 owner，真实失败 → mv=0）
d="$(mk_inj_dir chown_fail)"
before="$(sha256 "$d/target.env")"
OWNER_ARG='p3w0-nonexistent-user:p3w0-nonexistent-group'
out="$(run_inj_in chown_fail "$d")"
unset OWNER_ARG
after="$(sha256 "$d/target.env")"
staging="$(inj_get "$out" staging_path)"; frag="$(inj_get "$out" frag_path)"
expect_true INJ-7_setup "$(grep -q '^setup=ok$' <<<"$out" && echo true || echo false)" "子进程 setup 正常"
expect_eq INJ-7_assemble_rc 0 "$(inj_get "$out" rc_assemble)" "组装成功"
expect_eq INJ-7_publish_rc 8 "$(inj_get "$out" rc_publish)" "staging chown 失败 → publish=8"
expect_eq INJ-7_mv_calls 0 "$(obs_mv_count "$d")" "mv 计数=0（统一包装观测）"
expect_true INJ-7_target_intact "$(obs_target_intact "$before" "$d/target.env")" "旧目标 before/after 相等"
expect_true INJ-7_cleanup "$(obs_paths_cleaned "$d" "$staging" "$frag")" "登记路径已清理"
emit_case_json "INJ-7" "app_path" "assemble_rc=0" "publish_rc=8" "mv_calls=0" \
    "before_sha256=$before" "after_sha256=$after" "sentinel=$(inj_get "$out" sentinel)" \
    "staging_path=$staging" "frag_path=$frag" "assertions=pass"

# INJ-8 prepare 片段 chmod 失败（不以 || true 放行）
d8="$(mktemp -d "$WORK/inj8.XXXXXX")"
out="$(SYN_ACCESS="$STRONG_A" bash -c '
set -o pipefail
source "$1"; D="$2"
ARM="$D/arm.flag"
jwt_config_register_cleanup_traps
jwt_config_make_secure_tmp "$D" || { echo "setup=failed"; exit 0; }
F="$JWT_TMP_PATH"; jwt_config_track_tmp "$F"
printf "JWT_SECRET=%s\n" "$SYN_ACCESS" > "$F"
: > "$ARM"
chmod() { case "${2:-}" in "$F") if [ -f "$ARM" ]; then return 1; fi ;; esac; command chmod "$@"; }
jwt_config_prepare "$D/missing-old.env" "$3" "$F"
rc_prepare=$?
echo "setup=ok"
echo "rc_prepare=$rc_prepare"
echo "frag_path=$F"
echo "subprocess_finished=yes"
' _ "$LIB" "$d8" "$BACKEND" 2>/dev/null)"
F8="$(inj_get "$out" frag_path)"
expect_eq INJ-8_prepare_rc 6 "$(inj_get "$out" rc_prepare)" "prepare 片段 chmod 失败 → 6"
expect_true INJ-8_path_nonempty "$([ -n "$F8" ] && echo true || echo false)" "登记路径非空"
expect_true INJ-8_cleanup "$(obs_paths_cleaned "$d8" "$F8")" "登记 fragment 退出后已清理"
emit_case_json "INJ-8" "app_path" "prepare_rc=$(inj_get "$out" rc_prepare)" "assemble_rc=null" "publish_rc=null" \
    "mv_calls=0" "frag_path=$F8" "cleanup_observed=$(obs_paths_cleaned "$d8" "$F8")" "assertions=pass"

echo "===== SEC：deploy.sh §5.2 原文片段（独立 before/after + 子进程真实 rc + 统一 mv 包装）====="
dotenv_get() { # $1=file $2=key $3=expected（经环境传递，不进 argv）→ true/false
    EXPECT_VAL="$3" node -e '
const fs=require("fs");
const dotenv=require(process.argv[1]);
const v=dotenv.parse(fs.readFileSync(process.argv[2],"utf8"))[process.argv[3]];
console.log(String(v===process.env.EXPECT_VAL));
' "$BACKEND/node_modules/dotenv" "$1" "$2" 2>/dev/null
}

START_LINE=$(grep -n '^JWT_ASSEMBLE_STAGING="\$JWT_STAGING"$' "$DEPLOY_SH" | head -1 | cut -d: -f1)
END_LINE=$(grep -n '^ok "backend/.env 已原子替换' "$DEPLOY_SH" | head -1 | cut -d: -f1)
expect_true SEC_extract "$([ -n "$START_LINE" ] && [ -n "$END_LINE" ] && [ "$START_LINE" -lt "$END_LINE" ] && echo true || echo false)" "定位 §5.2 原文片段（$START_LINE..$((END_LINE-1))）"
SECTION="$WORK/section52.sh"
sed -n "${START_LINE},$((END_LINE-1))p" "$DEPLOY_SH" > "$SECTION"
expect_true SEC_section_pure "$(grep -q 'jwt_config_assemble_env' "$SECTION" && grep -q 'jwt_config_publish_env' "$SECTION" && ! grep -q '<<EOF' "$SECTION" && echo true || echo false)" "片段含共享调用且不含自建 heredoc（非复制实现）"

SEC_SCRIPT='
set -o pipefail
source "$1"
D="$2"; SECTION="$3"; INJ="$4"; SYN_ACCESS="$5"
MV_LOG="$D/mv.log"; : > "$MV_LOG"
CALL_LOG="$D/calls.log"; : > "$CALL_LOG"
FAIL_LOG="$D/fail.log"; : > "$FAIL_LOG"; export FAIL_LOG CALL_LOG MV_LOG
fail() { echo "fail:$*" >> "$FAIL_LOG"; exit 99; }
ok() { :; }; warn() { :; }; log() { :; }
# 统一 mv 计数包装（SEC-2 注入失败；其余走真实 mv）
mv() {
    echo "call" >> "$MV_LOG"
    if [ "${MV_FAIL_INJECT:-0}" = "1" ]; then echo "injected" >> "$MV_LOG"; return 1; fi
    command mv "$@"
}
# chown 受控替身：生产 owner 为 $SYSTEM_NAME:$SYSTEM_NAME（本机无同名用户+组；不新建服务用户）
chown() { return 0; }
jwt_config_register_cleanup_traps
jwt_config_make_secure_tmp "$D"; JWT_FRAGMENT="$JWT_TMP_PATH"; jwt_config_track_tmp "$JWT_FRAGMENT"
jwt_config_make_secure_tmp "$D"; JWT_STAGING="$JWT_TMP_PATH"; jwt_config_track_tmp "$JWT_STAGING"
printf "JWT_SECRET=%s\n" "$SYN_ACCESS" > "$JWT_FRAGMENT"
BACKEND_ENV="$D/target.env"
API_PORT=3000; DATABASE_URL=x; JWT_EXPIRE=7d; CORS_ORIGIN=y
SEED_ADMIN_PASSWORD=a; SEED_OPERATOR_PASSWORD=b; SEED_VIEWER_PASSWORD=c
BACKUP_DIR=d; BACKUP_KEEP_DAYS=7; BACKUP_MASTER_KEY=e
TENCENT_SECRET_ID=f; TENCENT_SECRET_KEY=g; TENCENT_KMS_REGION=h; TENCENT_KMS_KEY_ID=i
SYSTEM_NAME="$(id -un)"
case "$INJ" in
  assemble_fail) printf() { case "$*" in *BACKUP_DIR*) return 1 ;; esac; builtin printf "$@"; } ;;
  mv_fail)       MV_FAIL_INJECT=1 ;;
esac
echo "setup=ok"
echo "stage_staging=$JWT_STAGING"
echo "stage_fragment=$JWT_FRAGMENT"
source "$SECTION"
echo "sentinel=reached_after_section"
'
run_sec() { # $1=dir $2=inj → 设置 SEC_OUT / SEC_RC
    local d="$1" inj="$2"
    rm -rf "$d"; mkdir -p "$d"
    printf 'NODE_ENV=production\nJWT_SECRET=%s\n' "$STRONG_B" > "$d/target.env"
    SEC_OUT="$(SYN_ACCESS="$STRONG_A" bash -c "$SEC_SCRIPT" _ "$LIB" "$d" "$SECTION" "$inj" "$STRONG_A" 2>&1)"
    SEC_RC=$?
}

# SEC-1 组装失败：fail 调用、未到尾部、旧目标不变、登记路径清理
s1="$WORK/sec-1"
run_sec "$s1" assemble_fail
before1="$(printf 'NODE_ENV=production\nJWT_SECRET=%s\n' "$STRONG_B" | shasum -a 256 | awk '{print $1}')"
st1="$(inj_get "$SEC_OUT" stage_staging)"; fr1="$(inj_get "$SEC_OUT" stage_fragment)"
expect_eq SEC-1_subprocess_rc 99 "$SEC_RC" "子进程真实退出码 = fail 分支（99）"
expect_true SEC-1_fail_called "$(grep -q '^fail:backend/.env 组装失败' "$s1/fail.log" && echo true || echo false)" "生产原文调用 fail（组装失败）"
expect_true SEC-1_no_sentinel "$(grep -q '^sentinel=reached_after_section$' <<<"$SEC_OUT" && echo false || echo true)" "未走到片段尾部（sentinel 未到达）"
expect_true SEC-1_target_intact "$(obs_target_intact "$before1" "$s1/target.env")" "旧目标 before/after 相等（独立基准）"
expect_true SEC-1_cleanup "$(obs_paths_cleaned "$s1" "$st1" "$fr1")" "登记路径非空+归属正确+退出后不存在"
expect_eq SEC-1_mv_calls 0 "$(obs_mv_count "$s1")" "mv 计数=0（统一包装观测）"
emit_case_json "SEC-1" "app_path" "subprocess_rc=$SEC_RC" "assemble_rc=null" "publish_rc=null" \
    "mv_calls=$(obs_mv_count "$s1")" "before_sha256=$before1" "after_sha256=$(sha256 "$s1/target.env")" \
    "fail_reason=assemble" "sentinel_reached=false" "staging_path=$st1" "frag_path=$fr1" "assertions=pass"

# SEC-2 发布失败（mv 注入）：fail 调用、mv=1（injected）、未到尾部、旧目标不变、清理
s2="$WORK/sec-2"
run_sec "$s2" mv_fail
before2="$(printf 'NODE_ENV=production\nJWT_SECRET=%s\n' "$STRONG_B" | shasum -a 256 | awk '{print $1}')"
st2="$(inj_get "$SEC_OUT" stage_staging)"; fr2="$(inj_get "$SEC_OUT" stage_fragment)"
expect_eq SEC-2_subprocess_rc 99 "$SEC_RC" "子进程真实退出码 = fail 分支（99）"
expect_true SEC-2_fail_called "$(grep -q '^fail:backend/.env 发布失败' "$s2/fail.log" && echo true || echo false)" "生产原文调用 fail（发布失败）"
expect_eq SEC-2_mv_calls 1 "$(obs_mv_count "$s2")" "mv 计数=1"
expect_eq SEC-2_mv_injected yes "$(grep -q '^injected$' "$s2/mv.log" && echo yes || echo no)" "注入生效（记录 injected）"
expect_true SEC-2_no_sentinel "$(grep -q '^sentinel=reached_after_section$' <<<"$SEC_OUT" && echo false || echo true)" "未走到片段尾部"
expect_true SEC-2_target_intact "$(obs_target_intact "$before2" "$s2/target.env")" "旧目标 before/after 相等"
expect_true SEC-2_cleanup "$(obs_paths_cleaned "$s2" "$st2" "$fr2")" "登记路径已清理"
emit_case_json "SEC-2" "app_path" "subprocess_rc=$SEC_RC" "assemble_rc=0" "publish_rc=6" \
    "mv_calls=1" "before_sha256=$before2" "after_sha256=$(sha256 "$s2/target.env")" \
    "fail_reason=publish" "sentinel_reached=false" "staging_path=$st2" "frag_path=$fr2" "assertions=pass"

# SEC-3 成功：目标被新 staging 替换（独立合成预期）、走到尾部、清理
s3="$WORK/sec-3"
run_sec "$s3" none
before3="$(printf 'NODE_ENV=production\nJWT_SECRET=%s\n' "$STRONG_B" | shasum -a 256 | awk '{print $1}')"
after3="$(sha256 "$s3/target.env")"
st3="$(inj_get "$SEC_OUT" stage_staging)"; fr3="$(inj_get "$SEC_OUT" stage_fragment)"
expect_eq SEC-3_subprocess_rc 0 "$SEC_RC" "子进程真实退出码 = 0"
expect_true SEC-3_sentinel "$(grep -q '^sentinel=reached_after_section$' <<<"$SEC_OUT" && echo true || echo false)" "片段执行到尾部"
expect_true SEC-3_replaced "$([ -n "$before3" ] && [ -n "$after3" ] && [ "$before3" != "$after3" ] && echo true || echo false)" "目标被替换（after ≠ before）"
expect_true SEC-3_access_from_staging "$(dotenv_get "$s3/target.env" JWT_SECRET "$STRONG_A")" "access = 合成输入值（来自新 staging 的内容）"
expect_true SEC-3_field_jwt_expire "$(dotenv_get "$s3/target.env" JWT_EXPIRE 7d)" "JWT_EXPIRE 与片段设定一致"
expect_true SEC-3_field_cors "$(dotenv_get "$s3/target.env" CORS_ORIGIN y)" "CORS_ORIGIN 与片段设定一致"
expect_true SEC-3_cleanup "$(obs_paths_cleaned "$s3" "$st3" "$fr3")" "登记路径已清理"
emit_case_json "SEC-3" "app_path" "subprocess_rc=0" "assemble_rc=0" "publish_rc=0" \
    "mv_calls=$(obs_mv_count "$s3")" "before_sha256=$before3" "after_sha256=$after3" \
    "sentinel_reached=true" "access_matches_synthetic=true" "staging_path=$st3" "frag_path=$fr3" "assertions=pass"

echo "===== OBS：观测器自测（故意错误必须被检出；属 harness 自测，不作为应用故障证据）====="
o1="$WORK/obs-1"; mkdir -p "$o1"; printf 'original\n' > "$o1/t"
b1="$(sha256 "$o1/t")"
expect_eq OBS-1_unchanged true "$(obs_target_intact "$b1" "$o1/t")" "未改写 → true"
printf 'mutated\n' > "$o1/t"
expect_eq OBS-1_mutation_detected false "$(obs_target_intact "$b1" "$o1/t")" "故意改写 → false（观测器能失败）"
emit_case_json "OBS-1" "harness_selftest" "mutated_detected=$(obs_target_intact "$b1" "$o1/t")" "assertions=pass"

o2="$WORK/obs-2"; mkdir -p "$o2"
expect_eq OBS-2_empty_path invalid "$(obs_paths_cleaned "$o2" "")" "空登记路径 → invalid（不得当作已清理）"
expect_eq OBS-2_outside_path invalid "$(obs_paths_cleaned "$o2" "/etc/hosts")" "本例目录外路径 → invalid"
expect_eq OBS-2_owned_missing true "$(obs_paths_cleaned "$o2" "$o2/never-existed")" "归属内且不存在 → true"
emit_case_json "OBS-2" "harness_selftest" "empty_path=$(obs_paths_cleaned "$o2" "")" "assertions=pass"

o3="$WORK/obs-3"; mkdir -p "$o3"
bash -c '
set -o pipefail
D="$1"; MV_LOG="$D/mv.log"; : > "$MV_LOG"
mv() { echo "call" >> "$MV_LOG"; if [ "${MV_FAIL_INJECT:-0}" = "1" ]; then echo injected >> "$MV_LOG"; return 1; fi; command mv "$@"; }
printf a > "$D/src"
mv "$D/src" "$D/dst"
' _ "$o3" >/dev/null 2>&1
expect_eq OBS-3_mv_count 1 "$(obs_mv_count "$o3")" "统一包装主动调用一次 → 计数=1"
expect_eq OBS-3_mv_missing_log invalid "$(obs_mv_count "$WORK/obs-3-none")" "缺失计数文件 → invalid（不默认 0）"
emit_case_json "OBS-3" "harness_selftest" "mv_count=$(obs_mv_count "$o3")" "assertions=pass"

echo
echo "FAULT-INJECTION RESULT: pass=$PASS fail=$FAIL"
if [ "$FAIL" -ne 0 ]; then
    echo "HARNESS STATUS: FAILED (assertions failed; observations above)"
    exit 1
fi
if [ ! -s "$CASE_JSON" ]; then
    echo "HARNESS STATUS: OBSERVATION_FAILED (case json empty)"
    exit 2
fi
echo "HARNESS STATUS: OK (cases=$(wc -l < "$CASE_JSON" | tr -d ' '))"
exit 0
