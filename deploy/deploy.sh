#!/usr/bin/env bash
# =========================================================
# 通用部署脚本（deploy.sh）— 与具体系统解耦
# =========================================================
# 配套文件：deploy.<用户>.conf（适配文件 / 用户设置文件，由 deploy.adapter.example.conf 复制修改）
#
# 设计原则：
#   - 本脚本只负责“部署流程”，不含任何学校 / 系统名 / 端口等硬编码。
#   - 所有环境差异都在适配文件里，改适配文件即可适配新用户 / 新服务器。
#   - 支持同一台服务器多用户隔离部署：每个用户一份适配文件，分配独立的前端端口，
#     互不干扰（目录 / systemd 服务 / Caddy 站点各自独立）。
#   - 适配 Ubuntu 22.04/24.04 LTS，使用 Caddy（自动 HTTPS）+ systemd 托管后端。
#
# 用法：
#   sudo bash deploy.sh [适配文件路径]
#   不传路径时默认读取同目录下的 deploy.adapter.conf
#
# 流程：校验 → 装运行时 → 建系统用户/目录 → 拉代码 → 后端依赖/Prisma/Seed
#       → 前端构建 → 写 systemd 单元 → 写 Caddy 站点片段 → 健康检查 → 收尾报告
# =========================================================

set -o pipefail

# ------------------------- 基础工具 -------------------------
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ADAPTER_FILE="${1:-$SCRIPT_DIR/deploy.adapter.conf}"

log()  { echo -e "\n\033[36m=== $* ===\033[0m"; }
ok()   { echo -e "\033[32m✅ $*\033[0m"; }
warn() { echo -e "\033[33m⚠️  $*\033[0m"; }
fail() {
  echo -e "\033[31m❌ 错误: $*\033[0m"
  exit 1
}

# 生成强随机密码（14 位，含大小写字母与数字），供 PG / seed 使用
gen_password() {
  local p
  p=$(tr -dc 'A-Za-z0-9' < /dev/urandom | head -c 12)
  echo "${p}1A"
}

# ------------------------- 将 PostgreSQL 数据目录迁移到数据盘 -------------------------
# 仅当 REQUIRED_MOUNT 非空（即使用了独立数据盘）时启用。
# 做法：停止 PG → 将现有数据 rsync 到 $DATA_DIR/pgdata → 用软链替还原路径 → 启动。
# 软链对 PG 完全透明，无需改动 postgresql.conf，最稳妥，且不破坏 Ubuntu 的 cluster 管理。
relocate_postgres_data() {
  [ -n "$REQUIRED_MOUNT" ] || return 0   # 未配置数据盘则保持默认（系统盘）
  local pgver
  pgver=$(psql --version 2>/dev/null | awk '{print $3}' | cut -d. -f1-2)
  [ -n "$pgver" ] || { warn "无法识别 PostgreSQL 版本，跳过数据目录迁移"; return 0; }
  local cluster_dir="/var/lib/postgresql/${pgver}/main"
  local target_dir="$DATA_DIR/pgdata"
  # 已迁移（软链 / 已在数据盘下）则跳过，保证幂等
  [ -L "$cluster_dir" ] && { ok "PG 数据目录已是软链，跳过迁移"; return 0; }
  case "$cluster_dir" in "$DATA_DIR"*|"$REQUIRED_MOUNT"*) ok "PG 数据目录已在数据盘，跳过迁移"; return 0;; esac
  log "迁移 PostgreSQL 数据目录到数据盘: $target_dir"
  if ! systemctl stop postgresql; then warn "PostgreSQL 停止失败，跳过数据目录迁移"; return 0; fi
  mkdir -p "$target_dir"
  if [ -d "$cluster_dir" ]; then
    rsync -a "$cluster_dir/" "$target_dir/" 2>/dev/null || cp -a "$cluster_dir/." "$target_dir/"
    rm -rf "$cluster_dir"
  fi
  ln -s "$target_dir" "$cluster_dir"
  chown -R postgres:postgres "$target_dir"
  if ! systemctl start postgresql; then
    warn "PG 启动失败（数据盘迁移后），请检查: journalctl -u postgresql"
    return 0
  fi
  ok "PG 数据目录已迁移到数据盘（symlink: $cluster_dir -> $target_dir）"
}

# ------------------------- SchoolCustomization 增量列迁移（RK40）-------------------------
# 背景：向 schema.prisma 的 SchoolCustomization 增列后，`prisma db push` 只会把新列加到
# datasource 默认 schema（public），且旧学校历史行该列为 NULL；前端部分消费点期望非空
# JSON（对象 '{}' / 数组 '[]'），NULL 会导致「新增字段 → 旧学校」场景崩溃。
# 处理（幂等，写法参考 backend/prisma/constraints.sql 的 DO 块）：对所有含
# "SchoolCustomization" 表的 schema（public 及任何可能持有该表的 schema），
# ADD COLUMN IF NOT EXISTS 已知定制列，并把历史 NULL 回填为安全默认值。
# 注：新增列若未列入下方 obj_cols/arr_cols，请同步补充（与 schema.prisma 保持一致）。
migrate_school_customization() {
  log "SchoolCustomization 增量列迁移与 NULL 回填（RK40）"
  PGPASSWORD="$PG_PASSWORD" psql -v ON_ERROR_STOP=1 \
    -h "$PG_HOST" -p "$PG_PORT" -U "$PG_USER" -d "$PG_DB_NAME" <<'SQL' || fail "SchoolCustomization 增量迁移失败（H1：关键失败必须中止，避免旧学校 NULL 崩溃）"
DO $$
DECLARE
  r RECORD;
  -- 对象型定制列（默认回填 '{}'）
  -- Bug#2（Step4）: 补入 field_types（与 schema.prisma / tenantSync OBJ_COLS 对齐，此前缺失导致保存定制 500）
  obj_cols TEXT[] := ARRAY['field_labels','field_rules','field_options','field_order','custom_fields','theme_config','field_types'];
  -- 数组型定制列（默认回填 '[]'）
  -- Bug#2（Step4）: 补入 visible_menu_items（菜单栏定制列，此前缺失）
  arr_cols TEXT[] := ARRAY['hidden_fields','test_types','visible_menu_items'];
  c TEXT;
  default_visible CONSTANT TEXT := '["tableware","pesticide","oil","leanMeat","pathogen"]';
  -- Bug#2（Step4）: canteens（学校食堂信息，数组型，默认回填三食堂；与 tenantSync DEFAULT_CANTEENS 对齐）
  default_canteens CONSTANT TEXT := '["一食堂","二食堂","三食堂"]';
BEGIN
  FOR r IN
    SELECT table_schema FROM information_schema.tables
    WHERE table_name = 'SchoolCustomization'
  LOOP
    FOREACH c IN ARRAY obj_cols LOOP
      EXECUTE format('ALTER TABLE %I."SchoolCustomization" ADD COLUMN IF NOT EXISTS %I TEXT', r.table_schema, c);
      -- H2: 回填仅针对 NULL 行（历史遗留），单行条数极少，无需 LIMIT。
      -- 若数据量极大可加 LIMIT 分批；当前部署场景每 schema 仅 1 行 SchoolCustomization，全量回填安全。
      EXECUTE format('UPDATE %I."SchoolCustomization" SET %I = ''{}'' WHERE %I IS NULL', r.table_schema, c, c);
    END LOOP;
    FOREACH c IN ARRAY arr_cols LOOP
      EXECUTE format('ALTER TABLE %I."SchoolCustomization" ADD COLUMN IF NOT EXISTS %I TEXT', r.table_schema, c);
      -- H2: 同上，回填仅针对 NULL 行，每 schema 仅 1 行，无需 LIMIT。
      EXECUTE format('UPDATE %I."SchoolCustomization" SET %I = ''[]'' WHERE %I IS NULL', r.table_schema, c, c);
    END LOOP;
    -- visible_types：确保存在并回填五大模块默认，避免旧学校因 NULL 白屏
    EXECUTE format('ALTER TABLE %I."SchoolCustomization" ADD COLUMN IF NOT EXISTS visible_types TEXT', r.table_schema);
    EXECUTE format('UPDATE %I."SchoolCustomization" SET visible_types = %L WHERE visible_types IS NULL', r.table_schema, default_visible);
    -- Bug#2（Step4）: canteens（学校食堂信息）——数组型，回填默认三食堂（与 tenantSync DEFAULT_CANTEENS 一致）
    EXECUTE format('ALTER TABLE %I."SchoolCustomization" ADD COLUMN IF NOT EXISTS canteens TEXT', r.table_schema);
    EXECUTE format('UPDATE %I."SchoolCustomization" SET canteens = %L WHERE canteens IS NULL', r.table_schema, default_canteens);
    RAISE NOTICE 'SchoolCustomization 迁移完成: schema=%', r.table_schema;
  END LOOP;
END $$;
SQL
  ok "SchoolCustomization 增量列迁移完成（已按需补列并回填历史 NULL）"
}

# ------------------------- 0. 读取适配文件 -------------------------
[ -f "$ADAPTER_FILE" ] || fail "找不到适配文件: $ADAPTER_FILE\n用法: sudo bash deploy.sh <适配文件.conf>"

# DS-19（部署安全）：机密优先取自「真实环境变量」，不落入版本库/适配文件。
# 先快照进程环境里的机密，source 适配文件后再覆盖回来，使下面这种用法生效：
#   PG_PASSWORD=xxx JWT_SECRET=yyy DATABASE_URL=... sudo -E bash deploy.sh <conf>
# 从而机密只存在于运行环境与部署产物 backend/.env（chmod 600），不随适配文件入库。
_ENV_PG_PASSWORD="${PG_PASSWORD:-}"
_ENV_DATABASE_URL="${DATABASE_URL:-}"
_ENV_JWT_SECRET="${JWT_SECRET:-}"

# shellcheck disable=SC1090
source "$ADAPTER_FILE"
ok "已加载适配文件: $ADAPTER_FILE"

# DS-19：环境变量优先覆盖适配文件中的同名机密；并对「适配文件硬编码机密」给出安全告警。
for _s in PG_PASSWORD DATABASE_URL JWT_SECRET; do
  _envvar="_ENV_${_s}"
  if [ -n "${!_envvar}" ]; then eval "$_s=\"\${$_envvar}\""; fi
  # 仅当最终取值非空且适配文件里存在非空的硬编码赋值时告警（留空 ="" / 注释行不触发）
  if [ -n "${!_s}" ] && grep -Eq "^[[:space:]]*${_s}=[\"']?[^\"'[:space:]]" "$ADAPTER_FILE" 2>/dev/null; then
    warn "【安全·DS-19】适配文件疑似硬编码了 ${_s}。建议留空自动生成，或用真实环境变量传入（sudo -E），避免机密随适配文件进入版本库。"
  fi
done

# 必填项校验
[ -n "${SYSTEM_NAME:-}" ]    || fail "适配文件缺少 SYSTEM_NAME"
[ -n "${REPO_URL:-}" ]       || fail "适配文件缺少 REPO_URL"
[ -n "${DEPLOY_BRANCH:-}" ]  || fail "适配文件缺少 DEPLOY_BRANCH"
[ -n "${API_PORT:-}" ]       || fail "适配文件缺少 API_PORT"
[ -n "${FRONTEND_PORT:-}" ]  || fail "适配文件缺少 FRONTEND_PORT（多用户部署，每个用户需独立前端端口）"
[[ "${FRONTEND_PORT:-}" =~ ^[0-9]+$ ]] || fail "FRONTEND_PORT 必须是数字"

# 默认值补全（未设置时使用）
REPO_ROOT="${REPO_ROOT:-/opt/${SYSTEM_NAME}}"
DATA_DIR="${DATA_DIR:-/var/lib/${SYSTEM_NAME}}"
LOG_DIR="${LOG_DIR:-/var/log/${SYSTEM_NAME}}"
APP_NAME="${APP_NAME:-${SYSTEM_NAME}-api}"
# P0 备份引擎：备份根目录放【系统盘】（与数据盘物理分离），保留天数默认 7
BACKUP_DIR="${BACKUP_DIR:-/var/backups/${SYSTEM_NAME}}"
BACKUP_KEEP_DAYS="${BACKUP_KEEP_DAYS:-7}"
DB_TYPE="${DB_TYPE:-postgresql}"
# PostgreSQL 连接参数（单实例，与后端 schema.prisma provider=postgresql 一致）
PG_HOST="${PG_HOST:-127.0.0.1}"
PG_PORT="${PG_PORT:-5432}"
PG_DB_NAME="${PG_DB_NAME:-${SYSTEM_NAME}}"
PG_USER="${PG_USER:-${SYSTEM_NAME}}"
PG_PASSWORD="${PG_PASSWORD:-}"   # 留空则脚本自动生成强随机密码
NODE_VERSION="${NODE_VERSION:-20}"
INSTALL_RUNTIME="${INSTALL_RUNTIME:-true}"
ENABLE_SWAP="${ENABLE_SWAP:-false}"
SWAP_SIZE_GB="${SWAP_SIZE_GB:-2}"
ACCEPT_DATA_LOSS="${ACCEPT_DATA_LOSS:-true}"
SEED_ON_FIRST_DEPLOY="${SEED_ON_FIRST_DEPLOY:-true}"
FRONTEND_NPM_INSTALL="${FRONTEND_NPM_INSTALL:-false}"
PROVISION_TENANTS="${PROVISION_TENANTS:-true}"   # 首次部署是否初始化多租户（学校 schema / 系统记录 / 租户 admin）
JWT_EXPIRE="${JWT_EXPIRE:-7d}"
SERVICE_MEMORY_MAX="${SERVICE_MEMORY_MAX:-}"
REQUIRED_MOUNT="${REQUIRED_MOUNT:-}"   # 数据盘挂载点；非空时若未挂载则中止，避免数据静默写回系统盘

# 前置条件提醒（脚本无法配置云平台安全组，必须手动在控制台放行）
warn "【前置条件·手动】请确认腾讯云安全组已放行 TCP 22 及本次 FRONTEND_PORT=$FRONTEND_PORT（补域名后还需 443）。"
warn "  脚本不配置安全组；漏配会导致【本机健康检查通过但外部浏览器访问超时】的假阳性。"

# ------------------------- 1. 运行环境与权限 -------------------------
# DS-19：root 仅用于「安装运行时 / 建系统用户 / 写 systemd 与 Caddy」等特权步骤；
# 业务服务进程本身以非 root 系统用户 $SYSTEM_NAME 运行（见 §8 systemd 单元 User=）。
log "检查运行环境"
[ "$(id -u)" -eq 0 ] || fail "请使用 root 运行（sudo bash deploy.sh ...）"
command -v apt-get >/dev/null 2>&1 || fail "本脚本仅支持 apt 系发行版（Ubuntu/Debian）"

START_TIME=$(date +%s)

# ------------------------- 1.5 服务器性能自适应（按新机配置规划资源）-------------------------
TOTAL_MEM_MB=$(free -m 2>/dev/null | awk '/^Mem:/{print $2}')
[ -z "$TOTAL_MEM_MB" ] && TOTAL_MEM_MB=2048   # 取不到时按保守值
CPU_COUNT=$(nproc 2>/dev/null || echo 1)

# 后端内存上限：自适应；可被适配文件 SERVICE_MEMORY_MAX 覆盖
if [ -z "$SERVICE_MEMORY_MAX" ]; then
  if   [ "$TOTAL_MEM_MB" -le 1024 ]; then MEM_LIMIT_MB=384
  elif [ "$TOTAL_MEM_MB" -le 2048 ]; then MEM_LIMIT_MB=768
  elif [ "$TOTAL_MEM_MB" -le 4096 ]; then MEM_LIMIT_MB=1024
  else MEM_LIMIT_MB=1536
  fi
else
  MEM_LIMIT_MB="$SERVICE_MEMORY_MAX"
fi
NODE_OLD_SPACE=$(( MEM_LIMIT_MB * 3 / 4 ))
log "服务器资源: 内存 ${TOTAL_MEM_MB}MB / CPU ${CPU_COUNT} 核"
ok "后端内存上限 MemoryMax=${MEM_LIMIT_MB}M（NODE_OPTIONS --max-old-space-size=${NODE_OLD_SPACE}M）"

# ------------------------- 1.6 外网出站连通性预检 -------------------------
log "检查外网出站连通性（apt / git / npm / nvm / caddy 源都依赖外网）"
# NB-07：不要用 `curl -sI https://github.com` —— 在国内云上常被 GitHub 抗爬虫风控挡返回超时，
# 而 `git` 协议（smart HTTP）实际可达。改用 `git ls-remote` 真实探测目标仓库 head。
if ! git -C "$REPO_ROOT" ls-remote --heads origin >/dev/null 2>&1; then
  fail "无法访问 origin GitHub 仓库（git ls-remote 失败）。请检查服务器出站网络 / 安全组 / DNS。"
fi
if ! curl -sI --max-time 8 https://registry.npmjs.org >/dev/null 2>&1; then
  fail "无法访问 registry.npmjs.org，npm 依赖安装将失败。"
fi
ok "外网连通性正常"

# ------------------------- 1.7 数据盘挂载前置检查 -------------------------
if [ -n "$REQUIRED_MOUNT" ]; then
  if ! findmnt -m "$REQUIRED_MOUNT" >/dev/null 2>&1; then
    fail "REQUIRED_MOUNT=$REQUIRED_MOUNT 未挂载。为避免数据盘掉线后把数据静默写回系统盘，已中止。请先挂载该盘（建议写入 /etc/fstab 持久化）。"
  fi
  ok "数据盘已挂载: $REQUIRED_MOUNT"
  if ! grep -qw "$REQUIRED_MOUNT" /etc/fstab 2>/dev/null; then
    warn "$REQUIRED_MOUNT 未写入 /etc/fstab，重启后可能不自动挂载，导致服务因 DATA_DIR 不存在而启动失败。建议配置持久化挂载。"
  fi
  case "$DATA_DIR" in
    "$REQUIRED_MOUNT"|"$REQUIRED_MOUNT"/*) ;;
    *) warn "DATA_DIR=$DATA_DIR 不在 REQUIRED_MOUNT=$REQUIRED_MOUNT 下，数据可能未落在数据盘" ;;
  esac
fi

# ------------------------- 2. 安装运行时 -------------------------
if [ "$INSTALL_RUNTIME" = "true" ]; then
  log "安装运行时：Git / Caddy / Node(NVM)"

  # 低配机开 swap：true 强制 / false 不开 / auto 内存<2G 自动开
  if [ "$ENABLE_SWAP" = "true" ] || { [ "$ENABLE_SWAP" = "auto" ] && [ "$TOTAL_MEM_MB" -lt 2048 ]; }; then
    if ! swapon --show 2>/dev/null | grep -q "/swapfile"; then
      SWAPFILE="/swapfile"
      if [ ! -f "$SWAPFILE" ]; then
        warn "正在创建 ${SWAP_SIZE_GB}G swap（低配机）..."
        fallocate -l "${SWAP_SIZE_GB}G" "$SWAPFILE" 2>/dev/null || dd if=/dev/zero of="$SWAPFILE" bs=1M count=$((SWAP_SIZE_GB*1024))
        chmod 600 "$SWAPFILE"
        mkswap "$SWAPFILE"
      fi
      swapon "$SWAPFILE"
      grep -q "/swapfile" /etc/fstab || echo "/swapfile none swap sw 0 0" >> /etc/fstab
    fi
    ok "swap 已启用"
  fi

  apt-get update -y
  apt-get install -y git curl ca-certificates gnupg lsb-release build-essential unzip jq openssl postgresql postgresql-contrib

  # Caddy（官方源）
  if ! command -v caddy >/dev/null 2>&1; then
    apt-get install -y debian-keyring debian-archive-keyring apt-transport-https
    curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/gpg.key' | gpg --dearmor -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
    echo "deb [signed-by=/usr/share/keyrings/caddy-stable-archive-keyring.gpg] https://dl.cloudsmith.io/public/caddy/stable/deb/debian any-version main" > /etc/apt/sources.list.d/caddy.list
    apt-get update -y
    apt-get install -y caddy
  fi
  ok "Caddy: $(caddy version 2>/dev/null | head -1)"

  # Node（NVM 默认装到 /root/.nvm；但 systemd 服务以非 root 系统用户 foodtestlab 运行，
  # 无法穿越 /root（700）执行软链过去的 node，会报 Permission denied / status=203/EXEC。
  # 因此必须把 node 整个目录复制到全局可读的 /opt，再从 /usr/local/bin 软链过去。）
  if ! command -v node >/dev/null 2>&1; then
    export NVM_DIR="/root/.nvm"
    curl -o- https://raw.githubusercontent.com/nvm-sh/nvm/v0.39.7/install.sh | bash
    # shellcheck disable=SC1090
    source "$NVM_DIR/nvm.sh"
    nvm install "$NODE_VERSION"
    nvm alias default "$NODE_VERSION"
    NODE_VER="$(nvm version "$NODE_VERSION")"
    NODE_SRC="$NVM_DIR/versions/node/$NODE_VER"
    NODE_DST="/opt/node-$NODE_VER"
    mkdir -p "$NODE_DST"
    cp -a "$NODE_SRC/." "$NODE_DST/"
    chmod -R a+rX "$NODE_DST"
    ln -sf "$NODE_DST/bin/node" /usr/local/bin/node
    ln -sf "$NODE_DST/bin/npm"  /usr/local/bin/npm
    ln -sf "$NODE_DST/bin/npx"  /usr/local/bin/npx
  fi
  ok "Node: $(node -v)  npm: $(npm -v)"
else
  warn "跳过运行时安装（INSTALL_RUNTIME=false），请确保 node/npm/caddy/git 已就绪"
  command -v node >/dev/null 2>&1 || fail "未检测到 node"
  command -v caddy >/dev/null 2>&1 || fail "未检测到 caddy"
fi

# ------------------------- 2.5 安装并初始化 PostgreSQL（单实例）-------------------------
# 多学校架构（方案② Schema-per-tenant）依赖单 PostgreSQL 实例；本机部署即安装并初始化。
if [ "$INSTALL_RUNTIME" = "true" ]; then
  log "安装并初始化 PostgreSQL（单实例，多学校按 schema 隔离）"
  if ! command -v psql >/dev/null 2>&1; then
    apt-get install -y postgresql postgresql-contrib
  fi
  # PG 未就绪则启动（Ubuntu 服务名为 postgresql）
  if ! pg_isready -h "$PG_HOST" -p "$PG_PORT" >/dev/null 2>&1; then
    systemctl enable postgresql
    systemctl start postgresql || fail "PostgreSQL 启动失败，请检查日志: journalctl -u postgresql"
  fi
  ok "PostgreSQL: $(psql --version 2>/dev/null | head -1)"

  # 数据盘就绪后、建库/建角色前，先把 PG 数据目录迁到数据盘（若配了 REQUIRED_MOUNT）
  relocate_postgres_data

  # 生成应用库密码（留空则自动生成）；建库/建角色使用本密码
  [ -z "$PG_PASSWORD" ] && PG_PASSWORD=$(gen_password)
  PG_SUPER="postgres"
  export PGPASSWORD="$PG_PASSWORD"

  # 应用角色（若不存在则创建）
  if ! sudo -u "$PG_SUPER" psql -tAc "SELECT 1 FROM pg_roles WHERE rolname='$PG_USER'" | grep -q 1; then
    sudo -u "$PG_SUPER" psql -c "CREATE ROLE \"$PG_USER\" WITH LOGIN PASSWORD '$PG_PASSWORD';" \
      || fail "创建 PostgreSQL 角色 $PG_USER 失败"
  fi
  # 每次部署都把角色密码同步为本次 .env 使用的 PG_PASSWORD（幂等）。
  # 否则重跑时重新生成密码会导致 .env 与库中角色密码不一致，prisma 连接报 P1000 认证失败。
  sudo -u "$PG_SUPER" psql -c "ALTER ROLE \"$PG_USER\" WITH PASSWORD '$PG_PASSWORD';" \
    || fail "更新 PostgreSQL 角色 $PG_USER 密码失败"
  # 应用数据库（若不存在），归属应用角色
  if ! sudo -u "$PG_SUPER" psql -tAc "SELECT 1 FROM pg_database WHERE datname='$PG_DB_NAME'" | grep -q 1; then
    sudo -u "$PG_SUPER" psql -c "CREATE DATABASE \"$PG_DB_NAME\" OWNER \"$PG_USER\";" \
      || fail "创建 PostgreSQL 数据库 $PG_DB_NAME 失败"
  fi
  ok "PostgreSQL 就绪: $PG_USER@$PG_HOST:$PG_PORT/$PG_DB_NAME"
else
  warn "跳过运行时安装，假定 PostgreSQL 已就绪（需 $PG_USER@$PG_HOST:$PG_PORT/$PG_DB_NAME 可连）"
  command -v psql >/dev/null 2>&1 || fail "未检测到 psql 客户端"
fi

# ------------------------- 3. 系统用户与目录 -------------------------
log "创建系统用户与目录"
id "$SYSTEM_NAME" >/dev/null 2>&1 || useradd --system --home-dir "$REPO_ROOT" --shell /usr/sbin/nologin "$SYSTEM_NAME"
mkdir -p "$REPO_ROOT" "$DATA_DIR" "$LOG_DIR"

# ------------------------- 4. 拉取代码 -------------------------
# 防御：仓库可能被 chown 到系统用户（部署收尾会 chown），root 重跑时 git 会因
# dubious ownership 报错。提前将 REPO_ROOT 加入 git safe.directory。
git config --global --add safe.directory "$REPO_ROOT" 2>/dev/null || true
log "拉取代码: $REPO_URL @ $DEPLOY_BRANCH"
if [ ! -d "$REPO_ROOT/.git" ]; then
  # 目录非空且非 git 仓库 => 拒绝，避免误清数据
  if [ -n "$(ls -A "$REPO_ROOT" 2>/dev/null)" ]; then
    fail "$REPO_ROOT 非空且不是 Git 仓库，请先清空或改 REPO_ROOT"
  fi
  git clone ${GIT_CLONE_DEPTH:+"--depth=$GIT_CLONE_DEPTH"} -b "$DEPLOY_BRANCH" "$REPO_URL" "$REPO_ROOT" \
    || fail "git clone 失败（检查网络/仓库地址/分支名 '$DEPLOY_BRANCH'）"
  ok "克隆完成"
else
  git -C "$REPO_ROOT" fetch origin "$DEPLOY_BRANCH"
  # 防误杀工作区：先 stash 未提交改动，再 reset；reset 完让用户手动 pop 恢复。
  # 历史教训：未加这段时 `git reset --hard origin/main` 会把工作区正在调试的改动永久冲掉，
  # 且因 reset --hard 不写 reflog，无法找回。
  if ! git -C "$REPO_ROOT" diff --quiet HEAD 2>/dev/null || \
     [ -n "$(git -C "$REPO_ROOT" ls-files --others --exclude-standard 2>/dev/null)" ]; then
    log "检测到工作区有未提交改动，自动 stash 暂存以防 reset --hard 冲掉..."
    git -C "$REPO_ROOT" stash push -u -m "deploy-autostash $(date -u +%FT%TZ)" \
      || fail "git stash push 失败（请手动处理工作区改动后再跑部署）"
    ok "已自动 stash；本次部署完成后需手动 'git stash pop' 恢复（在 $REPO_ROOT）"
  fi
  git -C "$REPO_ROOT" checkout "$DEPLOY_BRANCH"
  git -C "$REPO_ROOT" reset --hard "origin/$DEPLOY_BRANCH"
  # 保留本地的 .env，不被 clean 删掉
  git -C "$REPO_ROOT" clean -fd -e "backend/.env" -e ".env"
  ok "已更新到最新: $(git -C "$REPO_ROOT" log -1 --oneline)"
fi

# ------------------------- 5. 生成后端 .env（含密钥）-------------------------
log "生成 backend/.env"
BACKEND_ENV="$REPO_ROOT/backend/.env"

# 密钥复用：conf 未显式提供时，复用现有 .env 中已生成的密钥，避免重部署重新随机
# 导致 (1) PG 角色密码不匹配 / (2) JWT 失效需重新登录 / (3) seed 账号 password_hash
# 与 .env 不一致（登录失败）。仅首次部署（无旧 .env）才会真正生成随机值。
# 2026-08-18：新增 BACKUP_MASTER_KEY / TENCENT_* 复用 —— 备份加密密钥一旦丢失，
# 已用该密钥加密的 .aes 备份将永久无法解密，故重部署必须保留（TD-School-Backup-Sync）。
if [ -f "$BACKEND_ENV" ]; then
  for k in PG_PASSWORD JWT_SECRET SEED_ADMIN_PASSWORD SEED_OPERATOR_PASSWORD SEED_VIEWER_PASSWORD \
           BACKUP_MASTER_KEY TENCENT_SECRET_ID TENCENT_SECRET_KEY TENCENT_KMS_REGION TENCENT_KMS_KEY_ID; do
    [ -n "${!k}" ] && continue
    v=$(grep -E "^${k}=" "$BACKEND_ENV" 2>/dev/null | head -1 | cut -d= -f2-)
    [ -n "$v" ] && eval "$k=\"$v\""
  done
fi

if [ -z "$DATABASE_URL" ]; then
  [ -z "$PG_PASSWORD" ] && PG_PASSWORD=$(gen_password)
  DATABASE_URL="postgresql://${PG_USER}:${PG_PASSWORD}@${PG_HOST}:${PG_PORT}/${PG_DB_NAME}"
fi
[ -z "$JWT_SECRET" ] && JWT_SECRET=$(openssl rand -base64 48)
# 密码策略：conf 显式提供 > 复用现有 .env 中已写入的密码 > 随机生成。
# 关键：重部署时必须复用现有 .env 密码，否则新生成的密码与库中已 seed 的
# password_hash 不一致，导致登录失败（seed 仅在首部署运行一次）。
for v in SEED_ADMIN_PASSWORD SEED_OPERATOR_PASSWORD SEED_VIEWER_PASSWORD; do
  if [ -z "${!v}" ]; then
    if [ -f "$BACKEND_ENV" ] && grep -q "^$v=" "$BACKEND_ENV" 2>/dev/null; then
      eval "$v=\$(grep \"^$v=\" \"$BACKEND_ENV\" | head -1 | cut -d= -f2-)"
    else
      eval "$v=\$(gen_password)"
    fi
  fi
done
# 2026-08-26（补生产缺口）：备份加密主密钥（fail-closed 必需）。
# kmsMode() 要求至少配置 TENCENT_*（KMS，生产推荐）或 BACKUP_MASTER_KEY（本地），
# 否则备份引擎拒绝执行。此前 deploy.sh 仅做"复用旧 .env"，从未在【首次部署】时
# 校验/兜底，导致 .env 写入空 BACKUP_MASTER_KEY=，kmsMode() 返回 null，
# 每日备份任务静默失败（TD-School-Backup-Sync 复盘）。
# 规则（密钥必须由运维/用户从密钥库提供，部署脚本【不】自动生成）：
#   1) 适配文件 / 环境变量已显式提供 TENCENT_* 或 BACKUP_MASTER_KEY → 尊重用户选择，写入 .env。
#   2) 两者皆空（首次部署且未提供）→ 直接 fail 中止部署，提示用户先提供密钥后再跑。
#   3) 无论如何，把最终生效的备份密钥导出到离线保险文件（独立于 .env，防止重部署/误覆盖丢失）。
if [ -z "$TENCENT_SECRET_ID$TENCENT_SECRET_KEY$TENCENT_KMS_KEY_ID" ] && [ -z "$BACKUP_MASTER_KEY" ]; then
  err "缺少备份加密密钥：首次部署必须由你提供备份主密钥，部署脚本不会自动生成。"
  echo "  二选一（在适配文件或环境变量中提供其一）："
  echo "    A) 本地主密钥：BACKUP_MASTER_KEY=<你的 32 字节 base64 密钥，从密钥库取>"
  echo "    B) 腾讯云 KMS：TENCENT_SECRET_ID / TENCENT_SECRET_KEY / TENCENT_KMS_KEY_ID / TENCENT_KMS_REGION"
  echo "  提供后重新运行 deploy.sh。注意：BACKUP_MASTER_KEY 一旦用于加密 .aes 备份即不可更换，"
  echo "  请确保该密钥已在你的密钥库/离线介质妥善保存（脚本也会把它导出到 $BACKUP_SECRETS_FILE 作为副本）。"
  exit 1
fi

# 导出离线保险副本（独立于 backend/.env，chmod 600）。
BACKUP_SECRETS_FILE="/root/.foodtestlab-backup-secrets.env"
{
  echo "# Auto-exported by deploy.sh — 备份加密密钥离线保险（与 backend/.env 解耦，防重部署/误覆盖丢失）"
  echo "# 生成时间: $(date -u +%FT%TZ)"
  [ -n "$BACKUP_MASTER_KEY" ]    && echo "BACKUP_MASTER_KEY=$BACKUP_MASTER_KEY"
  [ -n "$TENCENT_SECRET_ID" ]    && echo "TENCENT_SECRET_ID=$TENCENT_SECRET_ID"
  [ -n "$TENCENT_SECRET_KEY" ]   && echo "TENCENT_SECRET_KEY=$TENCENT_SECRET_KEY"
  [ -n "$TENCENT_KMS_REGION" ]   && echo "TENCENT_KMS_REGION=${TENCENT_KMS_REGION:-ap-guangzhou}"
  [ -n "$TENCENT_KMS_KEY_ID" ]   && echo "TENCENT_KMS_KEY_ID=$TENCENT_KMS_KEY_ID"
} > "$BACKUP_SECRETS_FILE"
chmod 600 "$BACKUP_SECRETS_FILE" 2>/dev/null || true
ok "备份加密密钥已导出离线保险: $BACKUP_SECRETS_FILE（chmod 600，请另行异地保存）"

if [ -z "$CORS_ORIGIN" ]; then
  if [ -n "$DOMAIN" ]; then
    CORS_ORIGIN="https://$DOMAIN"
  else
    PUBIP=$(curl -s --max-time 5 ifconfig.me || true)
    if [ -n "$PUBIP" ]; then CORS_ORIGIN="http://$PUBIP:$FRONTEND_PORT"; else CORS_ORIGIN="http://127.0.0.1:$FRONTEND_PORT"; fi
  fi
fi
# 后端启动时拒绝 CORS_ORIGIN="*"（server.js 会 process.exit(1)），故兜底值必须为非通配符。
# 无法获取公网 IP 时临时用回环地址，并显式告警需人工修正，避免静默产出必失败的配置。
if [ "$CORS_ORIGIN" = "http://127.0.0.1:$FRONTEND_PORT" ]; then
  echo "⚠️ 未能自动获取公网 IP，CORS_ORIGIN 已临时设为 http://127.0.0.1:$FRONTEND_PORT"
  echo "   部署后浏览器跨域请求将被拒绝，请手动修正 backend/.env 的 CORS_ORIGIN 为真实访问域名/IP 后重启服务。"
fi

# 注意：不要加引号、不要出现会破坏 systemd EnvironmentFile 解析的字符
cat > "$BACKEND_ENV" <<EOF
# Auto-generated by deploy.sh — 重新部署会覆盖
NODE_ENV=production
PORT=$API_PORT
SERVE_STATIC=false
DATABASE_URL=$DATABASE_URL
JWT_SECRET=$JWT_SECRET
JWT_EXPIRE=$JWT_EXPIRE
CORS_ORIGIN=$CORS_ORIGIN
SEED_ADMIN_PASSWORD=$SEED_ADMIN_PASSWORD
SEED_OPERATOR_PASSWORD=$SEED_OPERATOR_PASSWORD
SEED_VIEWER_PASSWORD=$SEED_VIEWER_PASSWORD
BACKUP_DIR=$BACKUP_DIR
BACKUP_KEEP_DAYS=$BACKUP_KEEP_DAYS
BACKUP_MASTER_KEY=$BACKUP_MASTER_KEY
TENCENT_SECRET_ID=$TENCENT_SECRET_ID
TENCENT_SECRET_KEY=$TENCENT_SECRET_KEY
TENCENT_KMS_REGION=$TENCENT_KMS_REGION
TENCENT_KMS_KEY_ID=$TENCENT_KMS_KEY_ID
EOF
# DS-19：机密文件权限收紧到 600 并归属非 root 服务用户（系统用户已在 §3 创建），
# 避免同机其它用户读到 DATABASE_URL / JWT_SECRET / SEED_* 等机密。
chmod 600 "$BACKEND_ENV" 2>/dev/null || true
chown "$SYSTEM_NAME:$SYSTEM_NAME" "$BACKEND_ENV" 2>/dev/null || true
ok "backend/.env 已写入（PORT=$API_PORT, CORS_ORIGIN=$CORS_ORIGIN；已 chmod 600）"
warn "请记下初始账号密码（SEED_*_PASSWORD），首次登录后请修改"

# ------------------------- 6. 后端依赖 / Prisma / Seed -------------------------
log "后端依赖安装与数据库同步"
# 防御：先清空可能从启动环境（IDE / 父 shell）继承来的 NODE_OPTIONS，
# 避免其中携带如 --harmony-* 等已失效的 v8 flag 导致 node 启动失败。
unset NODE_OPTIONS
export NODE_OPTIONS="--max-old-space-size=${NODE_OLD_SPACE}"   # 低内存机避免构建/OOM（单位 MB，勿加 M 后缀）
cd "$REPO_ROOT/backend" || fail "找不到 backend 目录"
if [ -f package-lock.json ]; then npm ci --no-audit --no-fund; else npm install --no-audit --no-fund; fi
[ ${PIPESTATUS[0]} -eq 0 ] || fail "后端依赖安装失败"

npx prisma generate || fail "prisma generate 失败"

FIRST_DEPLOY=false
# 首部署判定：public 下尚不存在 User 表（prisma db push 后才会创建）
if ! PGPASSWORD="$PG_PASSWORD" psql -h "$PG_HOST" -p "$PG_PORT" -U "$PG_USER" -d "$PG_DB_NAME" \
     -tAc "SELECT 1 FROM pg_tables WHERE schemaname='public' AND tablename='User' LIMIT 1" 2>/dev/null | grep -q 1; then
  FIRST_DEPLOY=true
fi

# H3: 基线迁移已就绪，切为 prisma migrate deploy（生产推荐方式）；
# 不再使用 db push --accept-data-loss（危险，可能静默删列/丢数据）。
# 首部署时 baseline migration 会建全表；后续增量变更走新 migration 文件。
if npx prisma migrate deploy 2>/dev/null; then
  : # migrate deploy 成功
else
  warn "prisma migrate deploy 失败，尝试 db push 回退"
  if [ "$FIRST_DEPLOY" = "true" ]; then
    npx prisma db push --accept-data-loss || fail "prisma db push 也失败"
  else
    fail "prisma migrate deploy 失败且非首部署，请手动修复后再运行部署"
  fi
fi
ok "数据库 schema 同步完成"

# 透传学校代码给 seed（与 provision-tenants 一致），确保种子学校与租户 schema 对齐
for v in "${!SCHOOL_NAME_@}"; do export "$v"; done
# RK41: 若 SCHOOL_CODES 为空，多租户初始化将被跳过。生产部署前请在适配文件中
# 将 SCHOOL_CODES 设为学校代码列表（逗号分隔）
export SCHOOL_CODES

if [ -f prisma/seed.js ] && { [ "$FIRST_DEPLOY" = "true" ] && [ "$SEED_ON_FIRST_DEPLOY" = "true" ]; }; then
  log "首次部署：执行 seed 初始化账号"
  # 首部署必须放行 seed（seed.js 在生产环境默认跳过，避免泄露默认凭据）。
  # 仅本次首部署临时置位，不写入永久 .env；后续重跑部署若已存在账号则 seed 内 ensureUser 去重跳过。
  SEED_ALLOW_PROD=true node prisma/seed.js || warn "seed 执行失败，请手动运行: SEED_ALLOW_PROD=true node $REPO_ROOT/backend/prisma/seed.js"
fi

# 初始账号密码对齐已统一移至下方「6.6 同步 bootstrap 账号密码」（ESM 脚本）。
# 注意：此前内联的 `node -e 'require(...)'` 在本工程 ESM（type:module）下会抛
# “require is not defined” 而静默失败（仅 warn），导致重部署后登录 401。故改为 ESM 脚本。

# ------------------------- 6.5 多租户初始化（方案② Schema-per-tenant）-------------------------
if [ "$PROVISION_TENANTS" = "true" ]; then
  log "多租户初始化（创建学校 schema / 系统记录 / 租户 admin）"
  # 透传必要环境变量给 provision-tenants.js
  for v in "${!SCHOOL_NAME_@}"; do export "$v"; done
  export DATABASE_URL SEED_ADMIN_PASSWORD SCHOOL_CODES
  node prisma/provision-tenants.js \
    || fail "多租户初始化失败（创建租户 schema 和 SchoolCustomization 是关键路径，必须中止）"
fi

# ------------------------- 6.55 全量租户 schema 同步（防 P2022 漂移，关键）-------------------------
# 背景：§6.5 的 provision-tenants.js 只遍历适配文件里的 SCHOOL_CODES（引导学校）。
# 但生产环境后续「在学校管理控制台 UI 新建的租户」不在 SCHOOL_CODES 中，重部署时不会被
# 重新 db push，一旦 schema.prisma 变更就会出现 P2022 列不存在的 500。
# 本步读取 public."School" 中【全部】学校（含 UI 新建），对每个调用 provisionSchool
# （幂等 db push），把新列推到每个租户 schema，并对 SchoolCustomization 做跨 schema NULL 回填。
# 这是「改 schema 后重部署」与「启动自愈」之间的部署期保险。
# SKIP_PRISMA_GENERATE=1：§6 已执行过 generate，此处无需重复生成客户端。
log "全量租户 schema 同步（覆盖控制台 UI 新建的租户，防 P2022 漂移）"
# 第六轮（滚动部署时序安全）：同步失败必须【中止部署】而非仅告警。
# 原因：若此步失败而继续走到 §8 restart，新代码（authenticateUser select
# must_change_password 等新列）将对着未迁移的租户 schema 运行 → 相关租户
# 所有认证请求 P2022 → fail-closed 503，且只能寄望「非阻塞的启动自愈」竞速恢复。
# 中止部署时旧版本进程未被重启，继续正常服役，无任何用户可见影响。
# 窗口C（部署容量基准）：记录同步的开始/结束时间、总耗时与租户数量，为部署窗口
# 容量规划提供持续监控数据。纯日志增强：tee 仅旁路复制输出（set -o pipefail 保证
# node 的非零退出码原样穿透管道触发 fail），不改变原有执行逻辑与失败中止语义。
TENANT_SYNC_LOG_FILE="$(mktemp)"
TENANT_SYNC_START_TS=$(date +%s)
echo "⏱ 租户 schema 同步开始: $(date '+%Y-%m-%d %H:%M:%S')"
SKIP_PRISMA_GENERATE=1 node sync-tenant-schemas.mjs 2>&1 | tee "$TENANT_SYNC_LOG_FILE" \
  || fail "全量租户 schema 同步失败——已中止部署（旧版本继续运行）。修复后重试，或手动排查: npm run db:sync"
TENANT_SYNC_END_TS=$(date +%s)
TENANT_SYNC_COUNT=$(grep -oE '同步 [0-9]+ 个租户' "$TENANT_SYNC_LOG_FILE" | grep -oE '[0-9]+' | head -1)
rm -f "$TENANT_SYNC_LOG_FILE"
echo "⏱ 租户 schema 同步结束: $(date '+%Y-%m-%d %H:%M:%S') | 租户数量: ${TENANT_SYNC_COUNT:-未知} | 总耗时: $((TENANT_SYNC_END_TS - TENANT_SYNC_START_TS)) 秒"

# ------------------------- 6.6 同步 bootstrap 账号密码（每次部署）-------------------------
# seed.js 仅在首次部署创建账号（ensureUser 跳过已存在用户），重部署不会更新 password_hash；
# 若 .env 密码曾被重新随机，库内 hash 与 .env 不一致会导致登录失败。此处显式把库内
# bootstrap 账号（public: admin/operator/viewer；各租户 schema: admin）密码对齐为 .env 当前值，
# 确保登录始终可用（类比 PostgreSQL ALTER ROLE 同步角色密码）。
if [ -f prisma/syncBootstrapPasswords.js ]; then
  log "同步 bootstrap 账号密码到 .env"
  node prisma/syncBootstrapPasswords.js \
    || warn "bootstrap 密码同步失败，请手动运行: node $REPO_ROOT/backend/prisma/syncBootstrapPasswords.js"
fi

# ------------------------- 6.7 SchoolCustomization 增量列迁移（RK40）-------------------------
# 必须在 db push（§6，向 public 补列）与多租户初始化（§6.5，写入 SchoolCustomization 行）之后执行：
# 补齐旧学校历史行中新列的 NULL 值，避免「新增字段 → 旧学校」崩溃。幂等，可安全重跑。
migrate_school_customization

# ------------------------- 7. 前端构建 -------------------------
log "前端构建"
cd "$REPO_ROOT" || fail "找不到前端目录"
if [ "$FRONTEND_NPM_INSTALL" = "true" ]; then
  if [ -f package-lock.json ]; then npm ci --no-audit --no-fund; else npm install --no-audit --no-fund; fi
fi
node scripts/build-static.js || fail "前端构建失败（scripts/build-static.js）"
[ -f "$REPO_ROOT/dist/index.html" ] || fail "前端构建异常：dist/index.html 不存在"
# 让 caddy 用户可读静态资源
chmod -R a+rX "$REPO_ROOT/dist"
ok "前端构建完成：dist/index.html"

# ------------------------- 8. systemd 单元 -------------------------
log "写入 systemd 单元: $APP_NAME.service"
cat > "/etc/systemd/system/${APP_NAME}.service" <<EOF
[Unit]
Description=$SYSTEM_NAME food safety lab API
After=network.target postgresql.service

[Service]
Type=simple
User=$SYSTEM_NAME
Group=$SYSTEM_NAME
WorkingDirectory=$REPO_ROOT/backend
EnvironmentFile=$BACKEND_ENV
ExecStart=/usr/local/bin/node server.js
MemoryMax=${MEM_LIMIT_MB}M
Environment=NODE_OPTIONS=--max-old-space-size=${NODE_OLD_SPACE}
Environment=TZ=Asia/Shanghai
Restart=on-failure
RestartSec=5
StandardOutput=append:$LOG_DIR/app.out.log
StandardError=append:$LOG_DIR/app.err.log

[Install]
WantedBy=multi-user.target
EOF

# 目录归属：代码与数据归系统用户，caddy 仅需对 dist 有读权限（已 a+rX）
chown -R "$SYSTEM_NAME:$SYSTEM_NAME" "$REPO_ROOT" "$DATA_DIR" "$LOG_DIR"

systemctl daemon-reload
systemctl enable "$APP_NAME"
systemctl restart "$APP_NAME" || fail "启动 $APP_NAME 失败，查看: journalctl -u $APP_NAME -n 50"
ok "后端已启动: $APP_NAME"

# ------------------------- 8.5 数据备份定时任务（P0 备份引擎）-------------------------
# 每日 02:00 全库 pg_dump → AES-256-GCM 信封加密 → /var/backups/<name>（系统盘）
# 密钥：生产必须配置 TENCENT_*（KMS 模式）或 BACKUP_MASTER_KEY，否则备份 fail-closed 拒绝执行
log "写入数据备份 systemd timer: ${APP_NAME}-backup"
mkdir -p "$BACKUP_DIR"
chown "$SYSTEM_NAME:$SYSTEM_NAME" "$BACKUP_DIR"
cat > "/etc/systemd/system/${APP_NAME}-backup.service" <<EOF
[Unit]
Description=$SYSTEM_NAME daily database backup (pg_dump + AES encryption)
After=postgresql.service
# FIX-07: 备份失败触发告警钩子，避免"静默失败"无人感知
OnFailure=${APP_NAME}-backup-alert.service

[Service]
Type=oneshot
User=$SYSTEM_NAME
Group=$SYSTEM_NAME
WorkingDirectory=$REPO_ROOT/backend
EnvironmentFile=$BACKEND_ENV
Environment=TZ=Asia/Shanghai
# FIX-07: 脚本实际位于 backend/scripts/003_backup-now.mjs（此前的相对路径 scripts/... 依赖
# WorkingDirectory=backend 才能命中，易被误判为"文件缺失"）。改为绝对路径，消除歧义。
ExecStart=/usr/local/bin/node $REPO_ROOT/backend/scripts/003_backup-now.mjs --all
StandardOutput=append:$LOG_DIR/backup.out.log
StandardError=append:$LOG_DIR/backup.err.log
EOF
cat > "/etc/systemd/system/${APP_NAME}-backup.timer" <<EOF
[Unit]
Description=$SYSTEM_NAME daily database backup timer

[Timer]
OnCalendar=*-*-* 02:00:00
Persistent=true
RandomizedDelaySec=300

[Install]
WantedBy=timers.target
EOF
# FIX-07: 备份失败告警钩子（OnFailure）。写日志，并可在后端 env 配置 BACKUP_ALERT_WEBHOOK 推送机器人。
cat > "/etc/systemd/system/${APP_NAME}-backup-alert.service" <<EOF
[Unit]
Description=$SYSTEM_NAME backup failure alert hook

[Service]
Type=oneshot
User=$SYSTEM_NAME
Group=$SYSTEM_NAME
EnvironmentFile=$BACKEND_ENV
Environment=TZ=Asia/Shanghai
Environment=BACKUP_ALERT_LOG=$LOG_DIR/backup.err.log
ExecStart=/bin/bash $REPO_ROOT/scripts/backup-alert.sh
EOF
systemctl daemon-reload
systemctl enable "${APP_NAME}-backup.timer"
systemctl start "${APP_NAME}-backup.timer" || true
ok "备份定时任务已启用: ${APP_NAME}-backup.timer（每日 02:00，目录 $BACKUP_DIR，失败告警 ${APP_NAME}-backup-alert.service）"

# ------------------------- 8.6 日志轮转（logrotate）-------------------------
# 后端/备份 4 个 append 日志长期运行会无限增长（部署就绪度报告 🟡6）。
# 写入 /etc/logrotate.d/<APP_NAME>，由系统 logrotate.timer 每日触发。
# 设计要点：
#   - size 100M + 保留 7 份 + 压缩，控制磁盘占用
#   - copytruncate：不重命名原文件、不发送信号，对 systemd append: 完全无感，避免丢日志/卡死
#   - 轮转后权限归系统用户，确保服务仍可读写
#   - 不依赖 logrotate postrotate 发信号（systemd 用 append: 写入，无需 HUP）
log "写入 logrotate 规则: /etc/logrotate.d/${APP_NAME}"
cat > "/etc/logrotate.d/${APP_NAME}" <<EOF
# Managed by deploy.sh — ${SYSTEM_NAME} 应用与备份日志轮转
${LOG_DIR}/app.out.log
${LOG_DIR}/app.err.log
${LOG_DIR}/backup.out.log
${LOG_DIR}/backup.err.log
${LOG_DIR}/log-alert.out.log
{
    size 100M
    rotate 7
    missingok
    notifempty
    compress
    delaycompress
    copytruncate
    create 0644 ${SYSTEM_NAME} ${SYSTEM_NAME}
    sharedscripts
}
EOF
# 立即做一次 dry-run 校验语法（失败仅 warn，不阻断部署）
if command -v logrotate >/dev/null 2>&1; then
  logrotate -d "/etc/logrotate.d/${APP_NAME}" >/dev/null 2>&1 \
    && ok "logrotate 规则语法校验通过" \
    || warn "logrotate 规则 dry-run 异常，请检查 /etc/logrotate.d/${APP_NAME}"
fi

# ------------------------- 8.7 应用日志异常告警（log-alert）-------------------------
# 周期扫描 app.err.log 中的 ERROR/崩溃/OOM 等关键字并告警（增量游标，避免重复刷屏）。
# 告警脚本：scripts/log-alert.sh；由 systemd timer 每 15 分钟触发。
# 可选：在 backend/.env 配置 LOG_ALERT_WEBHOOK（企业微信/钉钉机器人）开启推送。
ALERT_SCRIPT="$REPO_ROOT/scripts/log-alert.sh"
if [ -f "$ALERT_SCRIPT" ]; then
  chmod +x "$ALERT_SCRIPT"
  cat > "/etc/systemd/system/${APP_NAME}-log-alert.service" <<EOF
[Unit]
Description=$SYSTEM_NAME application log anomaly alert scan

[Service]
Type=oneshot
User=$SYSTEM_NAME
Group=$SYSTEM_NAME
EnvironmentFile=$BACKEND_ENV
Environment=TZ=Asia/Shanghai
Environment=LOG_ALERT_DIR=$LOG_DIR
Environment=LOG_ALERT_TARGETS=$LOG_DIR/app.err.log
ExecStart=/bin/bash $ALERT_SCRIPT
EOF
  cat > "/etc/systemd/system/${APP_NAME}-log-alert.timer" <<EOF
[Unit]
Description=$SYSTEM_NAME log alert scan timer (every 15 min)

[Timer]
OnCalendar=*:0/15
Persistent=true
RandomizedDelaySec=60

[Install]
WantedBy=timers.target
EOF
  systemctl daemon-reload
  systemctl enable "${APP_NAME}-log-alert.timer"
  systemctl start "${APP_NAME}-log-alert.timer" || true
  ok "日志告警已启用: ${APP_NAME}-log-alert.timer（每 15 分钟扫描 $LOG_DIR/app.err.log）"
else
  warn "未找到 $ALERT_SCRIPT，跳过日志告警部署（脚本需随仓库一同克隆）"
fi

# ------------------------- 9. Caddy 多用户站点（import 模式，互不覆盖）-------------------------
log "写入 Caddy 站点（多用户隔离）"
CADDY_SITES_DIR="/etc/caddy/sites"
mkdir -p "$CADDY_SITES_DIR"
SNIPPET="$CADDY_SITES_DIR/${APP_NAME}.caddy"

# 端口冲突预检：扫描已有用户站点片段，避免两个用户抢占同一前端端口
if [ -d "$CADDY_SITES_DIR" ]; then
  for f in "$CADDY_SITES_DIR"/*.caddy; do
    [ -e "$f" ] || continue
    [ "$f" = "$SNIPPET" ] && continue
    if grep -Eq ":$FRONTEND_PORT \{" "$f"; then
      fail "前端端口 $FRONTEND_PORT 已被已部署站点占用: $f（请为本次部署换一个 FRONTEND_PORT）"
    fi
  done
fi
# 后端端口占用预检（轻量，ss 不存在则跳过）。
# 必须排除本系统自身的服务：重跑部署时，§8 刚 restart 的 $APP_NAME 仍监听自己的
# API_PORT，若不排除会被误判为"其它用户的服务"而中止部署（历史 bug）。
if command -v ss >/dev/null 2>&1; then
  _own_pid=$(systemctl show "$APP_NAME" -p MainPID --value 2>/dev/null || echo 0)
  _occupying_pids=$(ss -ltnp 2>/dev/null | grep ":$API_PORT " | grep -oE 'pid=[0-9]+' | cut -d= -f2 | sort -u)
  _foreign=""
  for _pid in $_occupying_pids; do
    [ "$_pid" = "$_own_pid" ] && continue
    _foreign="$_pid"
    break
  done
  if [ -n "$_foreign" ]; then
    fail "后端端口 $API_PORT 已被其它进程占用（PID: $_foreign），请换一个 API_PORT"
  fi
fi

# 主 Caddyfile 只需初始化一次：存在且已 import 站点目录则不动（不覆盖其它用户）
if [ ! -f /etc/caddy/Caddyfile ] || ! grep -q "import $CADDY_SITES_DIR" /etc/caddy/Caddyfile; then
  cat > /etc/caddy/Caddyfile <<EOF
# Managed by deploy.sh — 各用户站点片段在 $CADDY_SITES_DIR/*.caddy
import $CADDY_SITES_DIR/*.caddy
EOF
  ok "已初始化主 Caddyfile（import $CADDY_SITES_DIR）"
fi

# 本用户站点片段（有域名走 HTTPS，否则监听 :FRONTEND_PORT）
TLS_LINE=""
if [ -n "${DOMAIN:-}" ]; then
  [ -n "${TLS_EMAIL:-}" ] || fail "已设置 DOMAIN=$DOMAIN，但缺少 TLS_EMAIL（证书注册邮箱）"
  CADDY_ADDR="$DOMAIN"
  TLS_LINE="    tls $TLS_EMAIL"
else
  CADDY_ADDR=":$FRONTEND_PORT"
fi

cat > "$SNIPPET" <<EOF
$CADDY_ADDR {
    encode gzip

    # RK39: 全局安全响应头（应用层 server.js 亦有兜底）
    header {
        Strict-Transport-Security "max-age=31536000; includeSubDomains; preload"
        X-Content-Type-Options "nosniff"
        Referrer-Policy "no-referrer"
        -Server
        X-Frame-Options "SAMEORIGIN"
    }
    # 预览 iframe（admin-schools.html 内嵌 index.html）需同源框嵌套；
    # API 路由仍禁止框嵌套（server.js 另设 CSP frame-ancestors 'none' 双重防护）。
    @apiPath path /api/*
    header @apiPath {
        X-Frame-Options "SAMEORIGIN"
    }

    # 方案A：路径前缀多租户识别（/<code>/login → 登录页，URL 不变）
    # 早期仅匹配 /school-*/login，导致不带 school- 前缀的学校代码
    # 点登录地址会落到 index.html（主应用）而非登录页。现改为通用匹配任意 /<code>/login，
    # 并排除 /api/* 避免误伤接口。登录页自身仍用 extractSchoolCode 的 ?school= 兜底，双保险。
    # NB-2026-07-30: 同时匹配 /<code>/login.html，与 js/utils/schoolCode.js 的 buildSchoolLoginUrl
    #   生成约定（/<code>/login.html，纯路径方案，不拼 ?school=）保持一致。否则 try_files {path} /index.html
    #   会因 dist/<code>/login.html 不存在而 fallback 到 /index.html，又回到主应用入口 bug。
    @schoolLogin {
        path_regexp ^/[^/]+/login(\.html)?/?$
        not path /api/*
    }
    rewrite @schoolLogin /login.html

    # FIX-03: 帮助中心子路径兜底。任何 /<code>/help.html 统一重写到根 /help.html，
    # 避免直接访问子路径帮助页 404（登录页已改为绝对路径跳转，此为历史/书签链接兜底）。
    @schoolHelp {
        path_regexp ^/[^/]+/help\.html/?$
        not path /api/*
    }
    rewrite @schoolHelp /help.html

    # API 反代必须放在最前、且用 handle 互斥：Caddy 固定指令顺序中 rewrite 在
    # reverse_proxy 之前，若把 try_files 放外面会把 /api/* 先改写到 /index.html，
    # 导致所有 API 请求落到静态文件（返回 SPA HTML / 405）。用 handle 块保证
    # /api/* 优先反代、其余请求才走 SPA 回退。
    handle /api/* {
        # RK39: 限制请求体大小，防止超大 payload（定制配置/批量导入）打满内存
        request_body {
            max_size 8MB
        }
        reverse_proxy 127.0.0.1:$API_PORT
    }
    handle /health {
        reverse_proxy 127.0.0.1:$API_PORT
    }
    # TD-CacheBust: HTML/JS/CSS 强制 no-cache，浏览器每次向服务器验证 ETag，
    # 避免部署新版本前端后用户仍看到缓存的旧页面（如 admin-schools.html 二级菜单改版）。
    @staticAssets path *.js *.css *.mjs *.html
    header @staticAssets Cache-Control "no-cache, must-revalidate"
    handle {
        root * $REPO_ROOT/dist
        try_files {path} /index.html
        file_server
    }
$TLS_LINE
}
EOF

caddy validate --config /etc/caddy/Caddyfile >/dev/null 2>&1 || fail "Caddyfile 校验失败，请检查 $SNIPPET"
systemctl enable caddy
if systemctl is-active --quiet caddy; then
  caddy reload --config /etc/caddy/Caddyfile || systemctl restart caddy
else
  systemctl restart caddy || fail "Caddy 启动失败，查看: journalctl -u caddy -n 50"
fi
ok "Caddy 站点已加载: $CADDY_ADDR（片段 $SNIPPET）"

# 反向代理自检：确认 /api 经由 Caddy 真正反代到后端（而非被 SPA 回退吞掉返回 HTML）。
if curl -s "http://127.0.0.1:${FRONTEND_PORT}/api/health" | grep -q '"status"'; then
  ok "Caddy 反代自检通过（/api/health 返回后端 JSON）"
else
  warn "Caddy 反代自检异常：/api/health 未返回后端 JSON（可能被静态文件回退吞掉）"
fi

# ------------------------- 10. 健康检查 -------------------------
log "健康检查（等待后端启动）"
HEALTH_OK=false
for i in $(seq 1 30); do
  if curl -s -o /dev/null -w "%{http_code}" "http://127.0.0.1:${API_PORT}/api/health" | grep -q 200; then
    ok "API 健康检查通过（第 $i 次）"
    HEALTH_OK=true
    break
  fi
  sleep 2
done
[ "$HEALTH_OK" = "true" ] || warn "健康检查超时，后端可能仍在启动，稍后检查: journalctl -u $APP_NAME -n 50"

# ------------------------- 11. 收尾报告 -------------------------
ELAPSED=$(( $(date +%s) - START_TIME ))
log "部署完成（耗时 ${ELAPSED}s）"

echo -e "\033[36m请检查以下项目：\033[0m"
echo "  1. 后端状态 : systemctl status $APP_NAME"
echo "  2. 后端日志 : journalctl -u $APP_NAME -f"
echo "  3. Caddy 状态: systemctl status caddy"
echo "  4. 健康检查 : curl http://127.0.0.1:${API_PORT}/api/health"
if [ -n "$DOMAIN" ]; then
  echo "  5. 公网访问 : https://$DOMAIN"
else
  echo "  5. 公网访问 : http://<你的公网IP>:$FRONTEND_PORT（Caddy 监听此端口；安全组需放行 $FRONTEND_PORT）"
  echo "     之后补域名：在适配文件填 DOMAIN/TLS_EMAIL，重跑本脚本即自动切 HTTPS"
fi
echo -e "\033[36m后端初始账号密码（见 backend/.env 中对应 SEED_* 变量，首次登录后请修改）：\033[0m"
echo "  admin   / (见 backend/.env 中 SEED_ADMIN_PASSWORD)"
echo "  operator/ (见 backend/.env 中 SEED_OPERATOR_PASSWORD)"
echo "  viewer  / (见 backend/.env 中 SEED_VIEWER_PASSWORD)"
echo ""
echo -e "\033[36m备份加密密钥（P0 备份引擎，fail-closed 必需）：\033[0m"
if [ -n "$TENCENT_SECRET_ID$TENCENT_SECRET_KEY$TENCENT_KMS_KEY_ID" ]; then
  echo "  模式: 腾讯云 KMS（生产推荐）—— 已配置 TENCENT_*，密钥由云 KMS 托管"
elif [ -n "$BACKUP_MASTER_KEY" ]; then
  echo "  模式: 本地主密钥 BACKUP_MASTER_KEY（已在 .env 与离线保险 $BACKUP_SECRETS_FILE 各存一份）"
  echo "  ⚠️ 本地密钥为过渡方案：生产环境建议切换腾讯云 KMS（适配文件填 TENCENT_* 后重跑），以满足密钥轮换与审计合规。"
  echo "  ⚠️ 已加密的 .aes 备份只能由本密钥解密，密钥丢失=备份永久不可用。请务必将 $BACKUP_SECRETS_FILE 异地离线保存。"
else
  echo "  ❌ 未配置任何备份密钥（kmsMode 返回 null），每日备份任务将 fail-closed 拒绝执行！请配置 TENCENT_* 或 BACKUP_MASTER_KEY 后重跑。"
fi
echo -e "\033[36m运维关键文件（请异地备份，丢失将影响备份解密/服务恢复）：\033[0m"
echo "  离线密钥保险: $BACKUP_SECRETS_FILE (chmod 600)"
echo "  后端密钥      : $BACKEND_ENV (chmod 600)"
echo ""
