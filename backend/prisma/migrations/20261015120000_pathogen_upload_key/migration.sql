-- @scope: both
-- 病原体设备「统一上传密钥」（B 方案）建表迁移：public."PathogenUploadKey"
--
-- 背景（2026-10-15）：在 20261014120000_pathogen_devices（每设备密钥模式）之上新增
--   **统一上传密钥**推荐模式：全平台设备共用一把平台级密钥，上传归属完全由报文 DeviceNo
--   查 PathogenDevice「学校-设备编号」映射决定（设备必须先在学校登记）。每设备密钥模式保留。
--
-- 权威副本在 public（平台级配置表，与 PathogenDevice / OpenApi* / FriendlyLink 同模式）：
--   ① public 由 prisma migrate 管理，本迁移直接建表（IF NOT EXISTS 幂等）；
--   ② 租户 schema 由迁移链逐租户回放 + provisionSchool 推表，建**同名空表**（纯结构对齐，
--      租户副本永不写入；应用层一律用基础 prisma 单例读写 public，绝不用 req.db）；
--   ③ 为避免「public 迁移已跑、租户尚未回放」的窗口，沿用 20260928120000_friendly_links 先例，
--      用 DO 块一次性为全部 school_* 建空表（school_*_old_* 回滚点跳过）。
--
-- 单活语义（应用层保证）：同一时刻至多一行 status='active'；
--   创建/轮换 = 停用旧行 + 插入新行（保留历史行用于审计）。
--
-- 分类协议（backend/lib/tenantProvisioner.js TENANT_MIGRATION_REGISTRY，按文件 checksum 固定）：
--   本文件 4 条语句 = 3 条普通 DDL（建表 / 2 索引，逐租户执行）
--                + 1 条显式跳过（扫全库 DO 块）。
--
-- 结构由 `prisma migrate diff --from-empty --to-schema-datamodel` 口径生成，与 Prisma Client 一致。

-- ============ public schema（prisma migrate 管理）============

CREATE TABLE IF NOT EXISTS "PathogenUploadKey" (
    "id" TEXT NOT NULL,
    "key_hash" TEXT NOT NULL,
    "key_prefix" TEXT NOT NULL,
    "key_last4" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'active',
    "disabled_at" TIMESTAMP(3),
    "last_used_at" TIMESTAMP(3),
    "created_by" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "PathogenUploadKey_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "PathogenUploadKey_key_hash_key" ON "PathogenUploadKey"("key_hash");
CREATE INDEX IF NOT EXISTS "PathogenUploadKey_status_idx" ON "PathogenUploadKey"("status");

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
            'CREATE TABLE IF NOT EXISTS %I."PathogenUploadKey" (
                "id" TEXT NOT NULL,
                "key_hash" TEXT NOT NULL,
                "key_prefix" TEXT NOT NULL,
                "key_last4" TEXT NOT NULL,
                "status" TEXT NOT NULL DEFAULT ''active'',
                "disabled_at" TIMESTAMP(3),
                "last_used_at" TIMESTAMP(3),
                "created_by" TEXT,
                "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
                "updated_at" TIMESTAMP(3) NOT NULL,
                CONSTRAINT "PathogenUploadKey_pkey" PRIMARY KEY ("id")
             )', t.schema_name);
        EXECUTE format(
            'CREATE UNIQUE INDEX IF NOT EXISTS "PathogenUploadKey_key_hash_key" ON %I."PathogenUploadKey"("key_hash")', t.schema_name);
        EXECUTE format(
            'CREATE INDEX IF NOT EXISTS "PathogenUploadKey_status_idx" ON %I."PathogenUploadKey"("status")', t.schema_name);
        RAISE NOTICE '病原体统一上传密钥建表完成: %', t.schema_name;
    END LOOP;
END $$;
