-- 开放接口（第三方数据开放）建表迁移：OpenApiClient / OpenApiCredential / OpenApiGrant
--
-- 背景（2026-09-15，朴食科技对接）：
--   平台超管按「对接方 × 学校」开通只读数据接口，第三方持独立 API Key 拉取指定学校
--   的检测数据。三张表均为**平台级配置表**，权威副本在 public：
--   ① public 由 prisma migrate 管理，本迁移直接建表（IF NOT EXISTS 幂等）；
--   ② 租户 schema 由 lib/tenantProvisioner.js 的 db push 推表，但为避免"迁移已跑、
--      租户尚未 db push"的窗口，这里按 20260825000000_add_frequency_threshold_calendar
--      的先例，用 DO 块一次性为全部 school_* 建**空表**（租户副本永不写入，纯结构对齐，
--      勿在此迁移中触碰任何租户业务数据）。
--   ⚠️ 本迁移对既有租户是"加空表"，不改任何现有表结构；recycle_* / school_*_old_* 跳过。
--   ⚠️ 刻意不建跨 schema 外键；租户副本内的 client_id 外键指向同 schema 的同名表。
--
-- 结构由 `prisma migrate diff --from-empty --to-schema-datamodel` 生成，与 Prisma Client 一致。

-- ============ public schema（prisma migrate 管理）============

CREATE TABLE IF NOT EXISTS "OpenApiClient" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "status" TEXT NOT NULL DEFAULT 'active',
    "ip_whitelist" JSONB,
    "rate_limit_per_min" INTEGER NOT NULL DEFAULT 60,
    "last_used_at" TIMESTAMP(3),
    "disabled_at" TIMESTAMP(3),
    "disabled_reason" TEXT,
    "created_by" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "OpenApiClient_pkey" PRIMARY KEY ("id")
);

CREATE TABLE IF NOT EXISTS "OpenApiCredential" (
    "id" TEXT NOT NULL,
    "client_id" TEXT NOT NULL,
    "label" TEXT NOT NULL DEFAULT '生产',
    "key_hash" TEXT NOT NULL,
    "key_prefix" TEXT NOT NULL,
    "key_last4" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'active',
    "expires_at" TIMESTAMP(3),
    "revoked_at" TIMESTAMP(3),
    "revoked_reason" TEXT,
    "last_used_at" TIMESTAMP(3),
    "call_count" INTEGER NOT NULL DEFAULT 0,
    "created_by" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "OpenApiCredential_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX IF NOT EXISTS "OpenApiCredential_key_hash_key" ON "OpenApiCredential"("key_hash");
CREATE INDEX IF NOT EXISTS "OpenApiCredential_client_id_idx" ON "OpenApiCredential"("client_id");
CREATE INDEX IF NOT EXISTS "OpenApiCredential_status_idx" ON "OpenApiCredential"("status");

CREATE TABLE IF NOT EXISTS "OpenApiGrant" (
    "id" TEXT NOT NULL,
    "client_id" TEXT NOT NULL,
    "school_code" TEXT NOT NULL,
    "visible_types" JSONB,
    "include_pathogen" BOOLEAN NOT NULL DEFAULT false,
    "include_inspector" BOOLEAN NOT NULL DEFAULT false,
    "include_attachments" BOOLEAN NOT NULL DEFAULT false,
    "start_date" TIMESTAMP(3),
    "end_date" TIMESTAMP(3),
    "scope_version" INTEGER NOT NULL DEFAULT 1,
    "status" TEXT NOT NULL DEFAULT 'active',
    "created_by" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "OpenApiGrant_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX IF NOT EXISTS "OpenApiGrant_client_id_school_code_key" ON "OpenApiGrant"("client_id", "school_code");
CREATE INDEX IF NOT EXISTS "OpenApiGrant_school_code_idx" ON "OpenApiGrant"("school_code");

DO $$ BEGIN
    ALTER TABLE "OpenApiCredential" ADD CONSTRAINT "OpenApiCredential_client_id_fkey"
        FOREIGN KEY ("client_id") REFERENCES "OpenApiClient"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
    ALTER TABLE "OpenApiGrant" ADD CONSTRAINT "OpenApiGrant_client_id_fkey"
        FOREIGN KEY ("client_id") REFERENCES "OpenApiClient"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- ============ 租户 schema（school_*，仅建空表，结构对齐用）============

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
            'CREATE TABLE IF NOT EXISTS %I."OpenApiClient" (
                "id" TEXT NOT NULL,
                "name" TEXT NOT NULL,
                "description" TEXT,
                "status" TEXT NOT NULL DEFAULT ''active'',
                "ip_whitelist" JSONB,
                "rate_limit_per_min" INTEGER NOT NULL DEFAULT 60,
                "last_used_at" TIMESTAMP(3),
                "disabled_at" TIMESTAMP(3),
                "disabled_reason" TEXT,
                "created_by" TEXT,
                "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
                "updated_at" TIMESTAMP(3) NOT NULL,
                CONSTRAINT "OpenApiClient_pkey" PRIMARY KEY ("id")
             )', t.schema_name);

        EXECUTE format(
            'CREATE TABLE IF NOT EXISTS %I."OpenApiCredential" (
                "id" TEXT NOT NULL,
                "client_id" TEXT NOT NULL,
                "label" TEXT NOT NULL DEFAULT ''生产'',
                "key_hash" TEXT NOT NULL,
                "key_prefix" TEXT NOT NULL,
                "key_last4" TEXT NOT NULL,
                "status" TEXT NOT NULL DEFAULT ''active'',
                "expires_at" TIMESTAMP(3),
                "revoked_at" TIMESTAMP(3),
                "revoked_reason" TEXT,
                "last_used_at" TIMESTAMP(3),
                "call_count" INTEGER NOT NULL DEFAULT 0,
                "created_by" TEXT,
                "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
                CONSTRAINT "OpenApiCredential_pkey" PRIMARY KEY ("id")
             )', t.schema_name);
        EXECUTE format(
            'CREATE UNIQUE INDEX IF NOT EXISTS "OpenApiCredential_key_hash_key"
             ON %I."OpenApiCredential"("key_hash")', t.schema_name);
        EXECUTE format(
            'CREATE INDEX IF NOT EXISTS "OpenApiCredential_client_id_idx"
             ON %I."OpenApiCredential"("client_id")', t.schema_name);
        EXECUTE format(
            'CREATE INDEX IF NOT EXISTS "OpenApiCredential_status_idx"
             ON %I."OpenApiCredential"("status")', t.schema_name);

        EXECUTE format(
            'CREATE TABLE IF NOT EXISTS %I."OpenApiGrant" (
                "id" TEXT NOT NULL,
                "client_id" TEXT NOT NULL,
                "school_code" TEXT NOT NULL,
                "visible_types" JSONB,
                "include_pathogen" BOOLEAN NOT NULL DEFAULT false,
                "include_inspector" BOOLEAN NOT NULL DEFAULT false,
                "include_attachments" BOOLEAN NOT NULL DEFAULT false,
                "start_date" TIMESTAMP(3),
                "end_date" TIMESTAMP(3),
                "scope_version" INTEGER NOT NULL DEFAULT 1,
                "status" TEXT NOT NULL DEFAULT ''active'',
                "created_by" TEXT,
                "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
                "updated_at" TIMESTAMP(3) NOT NULL,
                CONSTRAINT "OpenApiGrant_pkey" PRIMARY KEY ("id")
             )', t.schema_name);
        EXECUTE format(
            'CREATE UNIQUE INDEX IF NOT EXISTS "OpenApiGrant_client_id_school_code_key"
             ON %I."OpenApiGrant"("client_id", "school_code")', t.schema_name);
        EXECUTE format(
            'CREATE INDEX IF NOT EXISTS "OpenApiGrant_school_code_idx"
             ON %I."OpenApiGrant"("school_code")', t.schema_name);

        -- 租户副本内的外键指向同 schema 表（用 %I 显式限定，避免落到 search_path=public）
        BEGIN
            EXECUTE format(
                'ALTER TABLE %I."OpenApiCredential" ADD CONSTRAINT "OpenApiCredential_client_id_fkey"
                 FOREIGN KEY ("client_id") REFERENCES %I."OpenApiClient"("id")
                 ON DELETE CASCADE ON UPDATE CASCADE', t.schema_name, t.schema_name);
        EXCEPTION WHEN duplicate_object THEN NULL; WHEN undefined_table THEN NULL; END;
        BEGIN
            EXECUTE format(
                'ALTER TABLE %I."OpenApiGrant" ADD CONSTRAINT "OpenApiGrant_client_id_fkey"
                 FOREIGN KEY ("client_id") REFERENCES %I."OpenApiClient"("id")
                 ON DELETE CASCADE ON UPDATE CASCADE', t.schema_name, t.schema_name);
        EXCEPTION WHEN duplicate_object THEN NULL; WHEN undefined_table THEN NULL; END;

        RAISE NOTICE 'OpenAPI 建表完成: %', t.schema_name;
    END LOOP;
END $$;
