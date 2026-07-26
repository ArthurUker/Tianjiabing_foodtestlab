#!/usr/bin/env bash
# provision-school.sh — 为单所学校创建独立 schema（方案② Schema-per-tenant）
#
# 用法：
#   SCHOOL_CODE=tianjiabing \
#   DATABASE_URL=postgresql://user:pass@127.0.0.1:5432/foodtestlab \
#   bash scripts/provision-school.sh
#
# 原理：
#   1. 先从「模板 schema」克隆租户表到该校 schema（schema 名即 schoolCode，如 school-a）。
#      模板 schema 名由 TEMPLATE_SCHEMA 指定（默认 school_template）。
#   2. 模板 schema 需预先用 `prisma db push` 建好（仅含租户业务表，不含系统表
#      School / SchoolCustomization，它们只存在于 public）。
#   3. 系统表（School / SchoolCustomization）始终位于 public，由 config 端点
#      用显式 public. 前缀访问，不随 search_path 切换。
#
# 前置：已执行过 `npx prisma db push`（将全量表推到 public，并建好 school_template）。
# 依赖：psql / pg_dump 在 PATH 中，且 DATABASE_URL 可连接。

set -euo pipefail

SCHOOL_CODE="${SCHOOL_CODE:?请设置 SCHOOL_CODE（学校代码，如 tianjiabing，仅小写字母/数字/连字符）}"
DATABASE_URL="${DATABASE_URL:?请设置 DATABASE_URL（postgresql://...）}"
TEMPLATE_SCHEMA="${TEMPLATE_SCHEMA:-school_template}"
SCHOOL_NAME="${SCHOOL_NAME:-学校(${SCHOOL_CODE})}"

# —— 校验学校代码（与 backend/lib/tenantClient.js 的 isValidSchoolCode 一致）——
if ! echo "$SCHOOL_CODE" | grep -Eq '^[a-z0-9-]{1,40}$'; then
  echo "❌ 非法 SCHOOL_CODE: $SCHOOL_CODE（仅允许小写字母、数字、连字符，长度 1~40）" >&2
  exit 1
fi
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

# —— schema 名与运行时 schemaNameOf() 对齐：school_ 前缀，- 归一为 _ ——
BARE_CODE="${SCHOOL_CODE#school-}"
SCHEMA_NAME="school_$(echo "$BARE_CODE" | tr '-' '_')"

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

# 3. 登记系统记录（BS-01：开通即写 School/SchoolCustomization，避免登录白屏）
#    与 backend/lib/tenantProvisioner.js 的默认值保持一致（幂等，不覆盖已有记录）。
echo "➡️  登记 public.\"School\" / \"SchoolCustomization\" ..."
$PSQL <<SQL
INSERT INTO public."School" ("id","code","name","status","created_at","updated_at")
VALUES ('sch_${SCHOOL_CODE}', '${SCHOOL_CODE}', '${SCHOOL_NAME}', 'active', now(), now())
ON CONFLICT ("code") DO UPDATE SET "updated_at" = now();

INSERT INTO public."SchoolCustomization"
  ("id","school_code","theme_config","field_labels","hidden_fields","field_rules",
   "field_options","field_order","custom_fields","test_types","visible_types","updated_at")
VALUES ('sc_${SCHOOL_CODE}', '${SCHOOL_CODE}', '{}','{}','[]','{}','{}','{}','{}','[]',
        '["tableware","pesticide","oil","leanMeat","pathogen"]', now())
ON CONFLICT ("school_code") DO NOTHING;
SQL
echo "✅ 系统记录已登记（code=$SCHOOL_CODE, name=$SCHOOL_NAME）"

echo "🎉 学校 $SCHOOL_CODE 的 schema 已创建并克隆完成。"
echo "   如需创建该校 manager 账号，请运行: SCHOOL_CODES=$SCHOOL_CODE node backend/prisma/provision-tenants.js"
