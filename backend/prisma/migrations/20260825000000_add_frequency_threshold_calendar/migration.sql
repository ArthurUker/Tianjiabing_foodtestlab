-- N1/N2: FrequencyThreshold（检测频率阈值）与 DetectionCalendar（检测日历）建表迁移
--
-- 背景：这两张表此前只存在于 prisma/schema.prisma（模型定义），没有任何 migration 覆盖：
--   - public schema 由 `prisma migrate deploy` 管理，只应用 migration 文件中的 DDL；
--     缺失 migration 时 public 永远不建这两张表（部署脚本 §6 migrate deploy 成功后
--     不会回退到 db push）→ 平台超管（schoolCode 为空 → 走 public）或未同步租户的
--     学校访问 /api/frequency/* 时 Prisma 报 P2021 table does not exist → 500。
--   - 租户 schema 由 lib/tenantProvisioner.js 的 `prisma db push ?schema=<租户>` 推表，
--     仅当新增表后运行过 db push（部署 §6.55 同步 / 启动自愈）才会建表；若未跑过同样缺表。
-- 本迁移：
--   ① public 直接建表（IF NOT EXISTS 幂等，兼容已被 db push 建过表的既有环境）；
--   ② 遍历全部 school_* 租户 schema 建表（IF NOT EXISTS），一次性补齐存量租户，
--      不再依赖逐租户 db push。recycle_* / school_*_old_*（回收站 / 影子恢复残留）跳过。
--
-- 结构由 `prisma migrate diff --from-empty --to-schema-datamodel` 生成，与 Prisma Client 完全一致。

-- ============ public schema（prisma migrate 管理）============

CREATE TABLE IF NOT EXISTS "FrequencyThreshold" (
    "id" TEXT NOT NULL,
    "school_code" TEXT NOT NULL,
    "test_type" TEXT NOT NULL,
    "weekly_target" INTEGER NOT NULL,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "FrequencyThreshold_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX IF NOT EXISTS "FrequencyThreshold_school_code_test_type_key"
    ON "FrequencyThreshold"("school_code", "test_type");

CREATE TABLE IF NOT EXISTS "DetectionCalendar" (
    "id" TEXT NOT NULL,
    "school_code" TEXT NOT NULL,
    "test_type" TEXT NOT NULL,
    "day_of_week" INTEGER NOT NULL,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "DetectionCalendar_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX IF NOT EXISTS "DetectionCalendar_school_code_test_type_day_of_week_key"
    ON "DetectionCalendar"("school_code", "test_type", "day_of_week");

-- ============ 租户 schema（school_*，一次性补齐存量租户）============

DO $$
DECLARE
    t record;
BEGIN
    FOR t IN
        SELECT nspname AS schema_name
        FROM pg_namespace
        WHERE nspname LIKE 'school\_%' ESCAPE '\'
          AND nspname NOT LIKE 'school\_%\_old\_%' ESCAPE '\'
    LOOP
        EXECUTE format(
            'CREATE TABLE IF NOT EXISTS %I."FrequencyThreshold" (
                "id" TEXT NOT NULL,
                "school_code" TEXT NOT NULL,
                "test_type" TEXT NOT NULL,
                "weekly_target" INTEGER NOT NULL,
                "updated_at" TIMESTAMP(3) NOT NULL,
                CONSTRAINT "FrequencyThreshold_pkey" PRIMARY KEY ("id")
             )', t.schema_name);
        EXECUTE format(
            'CREATE UNIQUE INDEX IF NOT EXISTS "FrequencyThreshold_school_code_test_type_key"
             ON %I."FrequencyThreshold"("school_code", "test_type")', t.schema_name);
        EXECUTE format(
            'CREATE TABLE IF NOT EXISTS %I."DetectionCalendar" (
                "id" TEXT NOT NULL,
                "school_code" TEXT NOT NULL,
                "test_type" TEXT NOT NULL,
                "day_of_week" INTEGER NOT NULL,
                "enabled" BOOLEAN NOT NULL DEFAULT true,
                "updated_at" TIMESTAMP(3) NOT NULL,
                CONSTRAINT "DetectionCalendar_pkey" PRIMARY KEY ("id")
             )', t.schema_name);
        EXECUTE format(
            'CREATE UNIQUE INDEX IF NOT EXISTS "DetectionCalendar_school_code_test_type_day_of_week_key"
             ON %I."DetectionCalendar"("school_code", "test_type", "day_of_week")', t.schema_name);
        RAISE NOTICE 'N1/N2 建表完成: %', t.schema_name;
    END LOOP;
END $$;
