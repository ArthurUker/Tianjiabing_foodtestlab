-- @scope: both
-- 病原体设备自动采集（VirusHunter2.0B 对接）建表迁移：public."PathogenDevice"
--
-- 背景（2026-10-14）：病原体检测由「手动导入 Word 报告」升级为「设备自动采集」。
--   设备推送 POST /api/open/pathogen-device/upload，报文只带设备编号 DeviceNo；
--   服务端按本表 device_no → school_code 映射归属学校租户（schema-per-tenant 物理隔离写入）。
--
-- 权威副本在 public（平台级配置表，与 OpenApi* / FriendlyLink 同模式）：
--   ① public 由 prisma migrate 管理，本迁移直接建表（IF NOT EXISTS 幂等）；
--   ② 租户 schema 由迁移链逐租户回放 + provisionSchool 推表，建**同名空表**（纯结构对齐，
--      租户副本永不写入；应用层一律用基础 prisma 单例读写 public，绝不用 req.db）；
--   ③ 为避免「public 迁移已跑、租户尚未回放」的窗口，沿用 20260928120000_friendly_links 先例，
--      用 DO 块一次性为全部 school_* 建空表（school_*_old_* 回滚点跳过）。
--
-- 分类协议（backend/lib/tenantProvisioner.js TENANT_MIGRATION_REGISTRY，按文件 checksum 固定）：
--   本文件 3 条语句 = 2 条普通 DDL（建表 / 建索引，逐租户执行）
--                + 1 条显式跳过（扫全库 DO 块）。
--
-- 结构由 `prisma migrate diff --from-empty --to-schema-datamodel` 口径生成，与 Prisma Client 一致。

-- ============ public schema（prisma migrate 管理）============

CREATE TABLE IF NOT EXISTS "PathogenDevice" (
    "id" TEXT NOT NULL,
    "device_no" TEXT NOT NULL,
    "school_code" TEXT NOT NULL,
    "name" TEXT,
    "binding_user_id" TEXT NOT NULL,
    "default_canteen" TEXT,
    "status" TEXT NOT NULL DEFAULT 'active',
    "key_hash" TEXT NOT NULL,
    "key_prefix" TEXT NOT NULL,
    "key_last4" TEXT NOT NULL,
    "rate_limit_per_min" INTEGER NOT NULL DEFAULT 60,
    "ip_whitelist" JSONB,
    "upload_count" INTEGER NOT NULL DEFAULT 0,
    "last_used_at" TIMESTAMP(3),
    "last_upload_at" TIMESTAMP(3),
    "disabled_at" TIMESTAMP(3),
    "disabled_reason" TEXT,
    "created_by" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "PathogenDevice_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "PathogenDevice_device_no_key" ON "PathogenDevice"("device_no");
CREATE UNIQUE INDEX IF NOT EXISTS "PathogenDevice_key_hash_key" ON "PathogenDevice"("key_hash");
CREATE INDEX IF NOT EXISTS "PathogenDevice_school_code_idx" ON "PathogenDevice"("school_code");
CREATE INDEX IF NOT EXISTS "PathogenDevice_status_idx" ON "PathogenDevice"("status");

-- ============ 租户 schema（school_*，仅建空表，结构对齐用）============
-- @tenant-skip: 扫全库 DO 块（一次性为存量 school_* 建空表）；逐租户回放时其单 schema 效果
-- 由同文件的 CREATE TABLE / CREATE INDEX（均带 IF NOT EXISTS，幂等）覆盖。

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
            'CREATE TABLE IF NOT EXISTS %I."PathogenDevice" (
                "id" TEXT NOT NULL,
                "device_no" TEXT NOT NULL,
                "school_code" TEXT NOT NULL,
                "name" TEXT,
                "binding_user_id" TEXT NOT NULL,
                "default_canteen" TEXT,
                "status" TEXT NOT NULL DEFAULT ''active'',
                "key_hash" TEXT NOT NULL,
                "key_prefix" TEXT NOT NULL,
                "key_last4" TEXT NOT NULL,
                "rate_limit_per_min" INTEGER NOT NULL DEFAULT 60,
                "ip_whitelist" JSONB,
                "upload_count" INTEGER NOT NULL DEFAULT 0,
                "last_used_at" TIMESTAMP(3),
                "last_upload_at" TIMESTAMP(3),
                "disabled_at" TIMESTAMP(3),
                "disabled_reason" TEXT,
                "created_by" TEXT,
                "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
                "updated_at" TIMESTAMP(3) NOT NULL,
                CONSTRAINT "PathogenDevice_pkey" PRIMARY KEY ("id")
             )', t.schema_name);
        EXECUTE format(
            'CREATE UNIQUE INDEX IF NOT EXISTS "PathogenDevice_device_no_key" ON %I."PathogenDevice"("device_no")', t.schema_name);
        EXECUTE format(
            'CREATE UNIQUE INDEX IF NOT EXISTS "PathogenDevice_key_hash_key" ON %I."PathogenDevice"("key_hash")', t.schema_name);
        EXECUTE format(
            'CREATE INDEX IF NOT EXISTS "PathogenDevice_school_code_idx" ON %I."PathogenDevice"("school_code")', t.schema_name);
        EXECUTE format(
            'CREATE INDEX IF NOT EXISTS "PathogenDevice_status_idx" ON %I."PathogenDevice"("status")', t.schema_name);
        RAISE NOTICE '病原体设备建表完成: %', t.schema_name;
    END LOOP;
END $$;
