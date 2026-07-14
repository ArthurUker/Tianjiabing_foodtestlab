#!/usr/bin/env bash
# provision-school.sh — 为单所学校创建独立 schema（方案② Schema-per-tenant）
#
# 用法：
#   SCHOOL_CODE=tianjiabing \
#   DATABASE_URL=postgresql://user:pass@127.0.0.1:5432/foodtestlab \
#   bash scripts/provision-school.sh
#
# 原理：
#   1. 先从「模板 schema」克隆租户表到 school_<code>。
#      模板 schema 名由 TEMPLATE_SCHEMA 指定（默认 school_template）。
#   2. 模板 schema 需预先用 `prisma db push` 建好（仅含租户业务表，不含系统表
#      School / SchoolCustomization，它们只存在于 public）。
#   3. 系统表（School / SchoolCustomization）始终位于 public，由 config 端点
#      用显式 public. 前缀访问，不随 search_path 切换。
#
# 前置：已执行过 `npx prisma db push`（将全量表推到 public，并建好 school_template）。
# 依赖：psql / pg_dump 在 PATH 中，且 DATABASE_URL 可连接。

set -euo pipefail

SCHOOL_CODE="${SCHOOL_CODE:?请设置 SCHOOL_CODE（学校代码，对应 schema school_<code>）}"
DATABASE_URL="${DATABASE_URL:?请设置 DATABASE_URL（postgresql://...）}"
TEMPLATE_SCHEMA="${TEMPLATE_SCHEMA:-school_template}"
# 不应进入每校 schema 的系统表（仅 public 保留）
SYSTEM_TABLES=("School" "SchoolCustomization" "_prisma_migrations")

# 提取连接参数（简单解析 postgresql://user:pass@host:port/db）
URI_PATH="${DATABASE_URL#postgresql://}"
AUTH_HOST="${URI_PATH%/*}"
DB_NAME="${DATABASE_URL##*/}"
PG_USER="${AUTH_HOST%%:*}"
REST="${AUTH_HOST#*:}"
PG_PASS="${REST%%@*}"
HOST_PORT="${REST#*@}"
PG_HOST="${HOST_PORT%%:*}"
PG_PORT="${HOST_PORT#*:}"

export PGPASSWORD="$PG_PASS"
PSQL="psql -h $PG_HOST -p $PG_PORT -U $PG_USER -d $DB_NAME"
PG_DUMP="pg_dump -h $PG_HOST -p $PG_PORT -U $PG_USER -d $DB_NAME"

SCHEMA_NAME="school_${SCHOOL_CODE}"

echo "➡️  目标 schema: $SCHEMA_NAME（来源模板: $TEMPLATE_SCHEMA）"

# 1. 建 schema
$PSQL -c "CREATE SCHEMA IF NOT EXISTS \"$SCHEMA_NAME\";"
echo "✅ schema $SCHEMA_NAME 已就绪"

# 2. 取模板 schema 中需要克隆的表（排除系统表）
TABLES=$($PSQL -t -A -c "SELECT tablename FROM pg_tables WHERE schemaname = '$TEMPLATE_SCHEMA';")
for TBL in $TABLES; do
  skip=0
  for SYS in "${SYSTEM_TABLES[@]}"; do
    [ "$TBL" = "$SYS" ] && skip=1 && break
  done
  [ "$skip" = "1" ] && continue

  echo "  ↳ 克隆表 $TEMPLATE_SCHEMA.\"$TBL\" → $SCHEMA_NAME.\"$TBL\""
  $PG_DUMP -n "$TEMPLATE_SCHEMA" -t "\"$TBL\"" --no-owner --no-privileges \
    | sed "s/\"$TEMPLATE_SCHEMA\"\./\"$SCHEMA_NAME\"./g" \
    | $PSQL > /dev/null
done

echo "🎉 学校 $SCHOOL_CODE 的 schema 已创建并克隆完成。"
echo "   记得在 public.\"School\" 中登记该校（code=$SCHOOL_CODE, name=...）。"
