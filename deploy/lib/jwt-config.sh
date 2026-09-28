#!/usr/bin/env bash
# P3-W0-T01-R1/R2 — JWT 配置选择/解析/校验/序列化 + 临时资源生命周期 + 原子 env 发布
# （deploy.sh 与本任务测试共用同一实现，不复制第二套规则）。
#
# P3-W0-T01-R2（D1）：本文件是部署包的一部分，必须与 deploy.sh 保持相对路径 lib/jwt-config.sh
#   一起分发；deploy.sh 在**任何部署副作用之前**做存在/可读/加载/必需函数检查。
# P3-W0-T01-R2（D2）：
#   - 片段与 staging 从创建起即受限权限（0600），权限建立失败即停止（不使用 `chmod || true` 放行）。
#   - 资源必须显式登记（jwt_config_track_tmp），EXIT/INT/TERM 统一清理（信号退出保持非零）。
#   - 不再先截断 backend/.env：在同目录 staging 完整组装 → 校验 → `mv` 原子替换；任何失败保留旧文件。
#
# 设计约束（承接 R1）：值不执行（无 eval）、不经 argv；旧 .env 有效值经 dotenv 子集解析后再校验；
# 校验/生成/序列化集中在 backend/lib/jwtSecretResolve.js + backend/lib/jwtSecretConfig.js。
#
# 本文件无顶层副作用（仅定义函数与数组变量）；可在 §2 安装运行时之后、§6 安装依赖之前运行。
# 外部依赖：node、mktemp、chmod、mv、grep。

# 本任务临时资源登记表（精确归属：只登记调用方传入的路径）
_JWT_TMP_FILES=()

# ── 生命周期：登记 / 清理 / trap 注册 ──────────────────────────────────────────

# 登记一个本任务自有临时文件（cleanup 只会删除登记过的路径）
jwt_config_track_tmp() {
    [ -n "${1:-}" ] || return 0
    _JWT_TMP_FILES+=("$1")
    return 0
}

# 清理全部已登记资源；保留传入的退出码（trap 用法：jwt_config_cleanup_tmp $?）
# 只用已登记路径（绝不触碰未登记的/外部路径）；数组遍历兼容 bash 3.2。
jwt_config_cleanup_tmp() {
    local rc=${1:-$?}
    local f
    if [ "${#_JWT_TMP_FILES[@]}" -gt 0 ]; then
        for f in "${_JWT_TMP_FILES[@]}"; do
            if [ -n "$f" ]; then rm -f -- "$f" 2>/dev/null || true; fi
        done
    fi
    _JWT_TMP_FILES=()
    return "$rc"
}

# 注册 EXIT/INT/TERM 清理：信号退出保持非零退出码且不继续部署
jwt_config_register_cleanup_traps() {
    _JWT_TMP_FILES=()
    trap 'jwt_config_cleanup_tmp $?' EXIT
    trap 'jwt_config_cleanup_tmp 130; exit 130' INT
    trap 'jwt_config_cleanup_tmp 143; exit 143' TERM
    return 0
}

# ── 临时文件：创建即受限权限（失败即停止）───────────────────────────────────────

# 在指定目录创建 0600 临时文件；结果写入 JWT_TMP_PATH。失败返回非零（不 chmod || true 放行）。
jwt_config_make_secure_tmp() {
    local dir="${1:-${TMPDIR:-/tmp}}" f
    [ -d "$dir" ] || return 1
    f=$(umask 077
        mktemp "$dir/jwt-secure.XXXXXX" 2>/dev/null) || return 1
    if ! chmod 600 "$f" 2>/dev/null; then
        rm -f -- "$f" 2>/dev/null || true
        return 1
    fi
    JWT_TMP_PATH="$f"
    return 0
}

# ── 文件模式/属主核验助手 ──────────────────────────────────────────────────────

# 输出文件的八进制权限（macOS stat -f / Linux stat -c 兼容）；读取失败返回非零。
jwt_config_file_mode() {
    local f="$1" m
    m=$(stat -f '%Lp' "$f" 2>/dev/null) || m=$(stat -c '%a' "$f" 2>/dev/null) || return 1
    [ -n "$m" ] || return 1
    printf '%s' "$m"
}

# 核验文件属主（user 或 user:group 的 user 部分）；owner user 不可解析时核验失败（fail-closed）。
# 说明：group 部分不在此核验——跨平台按"组名"反查 gid 不可靠（BSD id -g 视参数为用户名等），
# 且 chown 系统调用成功即已按 owner 字符串完成 user:group 设置；核验 user 足以证明 chown 生效。
jwt_config_verify_owner() {
    local f="$1" owner="$2" want_user uid want_uid
    want_user="${owner%%:*}"
    [ -n "$want_user" ] || return 1
    want_uid=$(id -u "$want_user" 2>/dev/null) || return 1
    uid=$(stat -f '%u' "$f" 2>/dev/null) || uid=$(stat -c '%u' "$f" 2>/dev/null) || return 1
    [ "$uid" = "$want_uid" ] || return 1
    return 0
}

# ── 原子发布：staging → 目标（发布前完成权限/属主；mv 是最后一步）────────────────

# 校验 + 发布前权限/属主设置与核验 + 同目录原子替换；任何失败都保留旧目标并返回非零。
# 参数：$1 = staging；$2 = 目标（backend/.env）；$3 = 属主（可选，形如 user:group）
# 返回码：6 = 校验/同目录/替换失败；7 = staging 权限设置失败；8 = staging 属主设置失败；9 = 权限/属主核验失败
jwt_config_publish_env() {
    local staging="$1" target="$2" owner="${3:-}" target_dir staging_dir mode
    if [ -z "$staging" ] || [ ! -s "$staging" ]; then
        echo "[jwt-config] staging 缺失或为空，拒绝替换（旧配置保持不变）" >&2
        return 6
    fi
    if [ ! -r "$staging" ]; then
        echo "[jwt-config] staging 不可读，拒绝替换（旧配置保持不变）" >&2
        return 6
    fi
    if ! grep -q '^JWT_SECRET=' "$staging" 2>/dev/null; then
        echo "[jwt-config] staging 缺少 JWT_SECRET 行，拒绝替换（旧配置保持不变）" >&2
        return 6
    fi
    if [ -z "$target" ]; then
        echo "[jwt-config] 目标路径为空，拒绝替换" >&2
        return 6
    fi
    if [ -d "$target" ]; then
        echo "[jwt-config] 目标是目录，拒绝替换（旧配置保持不变）" >&2
        return 6
    fi
    target_dir="$(dirname -- "$target")"
    if [ ! -d "$target_dir" ]; then
        echo "[jwt-config] 目标目录不存在，拒绝替换（旧配置保持不变）" >&2
        return 6
    fi
    # 同目录要求：确保走同文件系统 rename；不静默退化为跨文件系统 copy
    staging_dir="$(dirname -- "$staging")"
    if [ "$(cd -- "$staging_dir" 2>/dev/null && pwd -P)" != "$(cd -- "$target_dir" 2>/dev/null && pwd -P)" ]; then
        echo "[jwt-config] staging 与目标不在同一目录，拒绝替换（不跨文件系统复制）" >&2
        return 6
    fi

    # ── 发布前：在 staging 上完成权限与属主；任一失败都不执行 mv ──
    if ! chmod 600 "$staging" 2>/dev/null; then
        echo "[jwt-config] 发布前无法设置 staging 权限 600，拒绝替换（旧配置保持不变）" >&2
        return 7
    fi
    if [ -n "$owner" ]; then
        if ! chown "$owner" "$staging" 2>/dev/null; then
            echo "[jwt-config] 发布前无法设置 staging 属主 ${owner}，拒绝替换（旧配置保持不变）" >&2
            return 8
        fi
    fi
    mode="$(jwt_config_file_mode "$staging")" || {
        echo "[jwt-config] 无法读取 staging 权限，拒绝替换（旧配置保持不变）" >&2
        return 9
    }
    if [ "$mode" != "600" ]; then
        echo "[jwt-config] staging 权限核验失败（期望 600，实际 ${mode}），拒绝替换" >&2
        return 9
    fi
    if [ -n "$owner" ]; then
        if ! jwt_config_verify_owner "$staging" "$owner"; then
            echo "[jwt-config] staging 属主核验失败（期望 ${owner}），拒绝替换" >&2
            return 9
        fi
    fi

    # ── 最后一步：mv（同目录 rename 原子替换）；此后不再执行会失败却返回 0 的操作 ──
    if ! mv -f -- "$staging" "$target" 2>/dev/null; then
        echo "[jwt-config] 替换目标失败（旧配置保持不变）" >&2
        return 6
    fi
    return 0
}

# ── 完整 env 组装（唯一实现；deploy.sh 与测试都调用它）──────────────────────────

# 把完整 prefix + JWT fragment + 完整 suffix 组装到 staging。
# 变量契约（调用方在调用前以**全局变量**提供；值不经 argv，secret 不进入进程参数表）：
#   JWT_ASSEMBLE_STAGING   staging 路径（由 jwt_config_make_secure_tmp 创建并登记）
#   JWT_ASSEMBLE_FRAGMENT  JWT 片段路径（由 jwt_config_prepare 生成）
#   非 JWT 字段变量：API_PORT / DATABASE_URL / JWT_EXPIRE / CORS_ORIGIN /
#     SEED_ADMIN_PASSWORD / SEED_OPERATOR_PASSWORD / SEED_VIEWER_PASSWORD / BACKUP_DIR /
#     BACKUP_KEEP_DAYS / BACKUP_MASTER_KEY / TENCENT_SECRET_ID / TENCENT_SECRET_KEY /
#     TENCENT_KMS_REGION / TENCENT_KMS_KEY_ID
# 返回：0 成功；20/21 = 参数缺失；22 = prefix 写入失败；23 = fragment 合并失败；
#       24 = suffix 写入失败；25 = 附加完整性校验失败
# 说明：每一步写入/读取都显式检查返回码（不依赖 set -e）；调用方在非零时必须立即停止，不得进入 publish。
jwt_config_assemble_env() {
    local staging="${JWT_ASSEMBLE_STAGING:-}" fragment="${JWT_ASSEMBLE_FRAGMENT:-}" k
    if [ -z "$staging" ]; then
        echo "[jwt-config] 组装：staging 路径为空，拒绝组装" >&2
        return 20
    fi
    if [ -z "$fragment" ]; then
        echo "[jwt-config] 组装：fragment 路径为空，拒绝组装" >&2
        return 21
    fi

    # prefix：逐行写入并**逐行检查返回码**（不依赖块/最后一条命令的返回码，也不依赖 set -e）
    printf '%s\n' '# Auto-generated by deploy.sh — 重新部署会覆盖' > "$staging" || {
        echo "[jwt-config] 组装：写入 prefix 第 1 行失败，拒绝继续（旧配置保持不变）" >&2
        return 22
    }
    printf '%s\n' 'NODE_ENV=production' >> "$staging" || {
        echo "[jwt-config] 组装：写入 prefix 第 2 行失败，拒绝继续（旧配置保持不变）" >&2
        return 22
    }
    printf 'PORT=%s\n' "$API_PORT" >> "$staging" || {
        echo "[jwt-config] 组装：写入 prefix 第 3 行失败，拒绝继续（旧配置保持不变）" >&2
        return 22
    }
    printf '%s\n' 'SERVE_STATIC=false' >> "$staging" || {
        echo "[jwt-config] 组装：写入 prefix 第 4 行失败，拒绝继续（旧配置保持不变）" >&2
        return 22
    }
    printf 'DATABASE_URL=%s\n' "$DATABASE_URL" >> "$staging" || {
        echo "[jwt-config] 组装：写入 prefix 第 5 行失败，拒绝继续（旧配置保持不变）" >&2
        return 22
    }

    # fragment（读取/追加失败必须立即停止）
    if ! cat -- "$fragment" >> "$staging"; then
        echo "[jwt-config] 组装：合并 JWT 片段失败，拒绝继续（旧配置保持不变）" >&2
        return 23
    fi

    # suffix：逐行写入并逐行检查（任一行失败立即停止——即使前面的必需字段已经写出）
    printf 'JWT_EXPIRE=%s\n' "$JWT_EXPIRE" >> "$staging" || {
        echo "[jwt-config] 组装：写入 suffix（JWT_EXPIRE）失败，拒绝继续（旧配置保持不变）" >&2
        return 24
    }
    printf 'CORS_ORIGIN=%s\n' "$CORS_ORIGIN" >> "$staging" || {
        echo "[jwt-config] 组装：写入 suffix（CORS_ORIGIN）失败，拒绝继续（旧配置保持不变）" >&2
        return 24
    }
    printf 'SEED_ADMIN_PASSWORD=%s\n' "$SEED_ADMIN_PASSWORD" >> "$staging" || {
        echo "[jwt-config] 组装：写入 suffix（SEED_ADMIN_PASSWORD）失败，拒绝继续（旧配置保持不变）" >&2
        return 24
    }
    printf 'SEED_OPERATOR_PASSWORD=%s\n' "$SEED_OPERATOR_PASSWORD" >> "$staging" || {
        echo "[jwt-config] 组装：写入 suffix（SEED_OPERATOR_PASSWORD）失败，拒绝继续（旧配置保持不变）" >&2
        return 24
    }
    printf 'SEED_VIEWER_PASSWORD=%s\n' "$SEED_VIEWER_PASSWORD" >> "$staging" || {
        echo "[jwt-config] 组装：写入 suffix（SEED_VIEWER_PASSWORD）失败，拒绝继续（旧配置保持不变）" >&2
        return 24
    }
    printf 'BACKUP_DIR=%s\n' "$BACKUP_DIR" >> "$staging" || {
        echo "[jwt-config] 组装：写入 suffix（BACKUP_DIR）失败，拒绝继续（旧配置保持不变）" >&2
        return 24
    }
    printf 'BACKUP_KEEP_DAYS=%s\n' "$BACKUP_KEEP_DAYS" >> "$staging" || {
        echo "[jwt-config] 组装：写入 suffix（BACKUP_KEEP_DAYS）失败，拒绝继续（旧配置保持不变）" >&2
        return 24
    }
    printf 'BACKUP_MASTER_KEY=%s\n' "$BACKUP_MASTER_KEY" >> "$staging" || {
        echo "[jwt-config] 组装：写入 suffix（BACKUP_MASTER_KEY）失败，拒绝继续（旧配置保持不变）" >&2
        return 24
    }
    printf 'TENCENT_SECRET_ID=%s\n' "$TENCENT_SECRET_ID" >> "$staging" || {
        echo "[jwt-config] 组装：写入 suffix（TENCENT_SECRET_ID）失败，拒绝继续（旧配置保持不变）" >&2
        return 24
    }
    printf 'TENCENT_SECRET_KEY=%s\n' "$TENCENT_SECRET_KEY" >> "$staging" || {
        echo "[jwt-config] 组装：写入 suffix（TENCENT_SECRET_KEY）失败，拒绝继续（旧配置保持不变）" >&2
        return 24
    }
    printf 'TENCENT_KMS_REGION=%s\n' "$TENCENT_KMS_REGION" >> "$staging" || {
        echo "[jwt-config] 组装：写入 suffix（TENCENT_KMS_REGION）失败，拒绝继续（旧配置保持不变）" >&2
        return 24
    }
    printf 'TENCENT_KMS_KEY_ID=%s\n' "$TENCENT_KMS_KEY_ID" >> "$staging" || {
        echo "[jwt-config] 组装：写入 suffix（TENCENT_KMS_KEY_ID）失败，拒绝继续（旧配置保持不变）" >&2
        return 24
    }

    # 附加完整性校验（不替代上面的写入返回码检查）
    for k in NODE_ENV DATABASE_URL JWT_SECRET JWT_EXPIRE CORS_ORIGIN; do
        if ! grep -q "^${k}=" "$staging" 2>/dev/null; then
            echo "[jwt-config] 组装：staging 缺少必需字段 ${k}，拒绝继续" >&2
            return 25
        fi
    done
    return 0
}

# ── 值流：环境覆盖 + 解析/校验/序列化 ──────────────────────────────────────────

# 用进程环境快照中的 JWT 值覆盖适配文件值（deploy.sh §0 调用；非空优先）。
# set -u 安全：全部使用 :- 默认展开，不依赖调用方是否已初始化变量。
jwt_config_apply_env_overrides() {
    if [ -n "${_ENV_JWT_SECRET:-}" ]; then JWT_SECRET="$_ENV_JWT_SECRET"; fi
    if [ -n "${_ENV_JWT_REFRESH_SECRET:-}" ]; then JWT_REFRESH_SECRET="$_ENV_JWT_REFRESH_SECRET"; fi
    return 0
}

# 解析/选择/生成/校验/序列化 → 生成 backend/.env 的 JWT 片段（0600）。
# 参数：$1 = 旧 backend/.env 路径（可不存在）；$2 = backend 目录；$3 = 片段输出路径
# 返回：0 成功；4 node 缺失；5 校验通过但片段缺失；其余为共享 CLI 的退出码（1 值拒绝；2 文件/用法错误）
jwt_config_prepare() {
    local backend_env="$1" backend_dir="$2" fragment_out="$3"

    # 显式初始化（不能依赖调用方的临时环境赋值；set -u 下同样安全）
    : "${JWT_SECRET:=}"
    : "${JWT_REFRESH_SECRET:=}"

    if ! command -v node >/dev/null 2>&1; then
        echo "[jwt-config] 需要 node 运行共享校验 ${backend_dir}/scripts/validate-jwt-secrets.mjs，但未找到 node" >&2
        return 4
    fi

    # 注意：选项名用 --source-env-file（不是 --env-file）—— node 自身会消费 --env-file，
    # 导致该参数不会传给脚本（fail-closed 的片段检查可捕获此类误用）。
    JWT_SECRET="$JWT_SECRET" JWT_REFRESH_SECRET="$JWT_REFRESH_SECRET" \
        node "$backend_dir/scripts/validate-jwt-secrets.mjs" \
        --source-env-file="$backend_env" \
        --write-fragment="$fragment_out" \
        --json
    local rc=$?
    if [ "$rc" -eq 0 ]; then
        if [ ! -s "$fragment_out" ]; then
            echo "[jwt-config] 内部错误：校验通过但未生成 JWT 片段（检查 CLI 选项是否被 node 内置选项吞掉）" >&2
            return 5
        fi
        if ! chmod 600 "$fragment_out" 2>/dev/null; then
            echo "[jwt-config] 无法为 JWT 片段设置 600 权限（不以 || true 放行；调用方应清理已登记资源）" >&2
            return 6
        fi
        local fmode
        fmode="$(jwt_config_file_mode "$fragment_out")" || {
            echo "[jwt-config] 无法读取 JWT 片段权限，拒绝继续" >&2
            return 6
        }
        if [ "$fmode" != "600" ]; then
            echo "[jwt-config] JWT 片段权限核验失败（期望 600，实际 ${fmode}）" >&2
            return 6
        fi
    fi
    return "$rc"
}
