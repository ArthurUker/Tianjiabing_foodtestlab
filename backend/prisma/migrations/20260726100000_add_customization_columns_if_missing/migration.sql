-- =========================================================================
-- P3-W2-T01（AUD-008 / RC-04）· 补丁 migration：把「运行时 DDL 时代」的漂移沉淀进 migration 链
--
-- 背景（BATCH-B-VERIFICATION · AUD-008，CONFIRMED/P1）：
--   visible_menu_items / canteens / field_types / guest_enabled 四列自 2026-07 起由
--   运行时 DDL（lib/tenantSync.js 的 ADD COLUMN IF NOT EXISTS）与 `prisma db push` 引入，
--   **从未沉淀为 migration**：
--     · baseline（20260726000000，由当时 schema.prisma 生成）不含它们；
--     · 20260814020000_unify 的 `ALTER COLUMN "visible_menu_items"` 等语句又引用它们
--   ⇒ 空库 `prisma migrate deploy` 在 unify 处 42703 中断（HEAD 实测复现，见
--     evidence/P3-W2-T01/logs/replay-empty-PREFIX-bug-exists.log），migration 链只在
--     「db push 演进过的库」上自洽。
--
-- 同类漂移（本轮补齐）：BackupRun / AccountApplication / FieldOption 三张表同样只由
--   db push 在运行时创建，链上无任何 CREATE 语句 —— 空库回放会在
--   20260814040000_json_fields_to_jsonb 的 `ALTER TABLE "BackupRun"` 处 42P01 中断，
--   且回放成功后的库也缺这三张表（链末状态 ≠ schema.prisma）。
--
-- 修复原则（不破坏既有实例）：
--   ① **不修改 baseline 文件本身**（历史接入锚点，见 baseline 头注释与 BATCH-B 修复方案①）；
--   ② 本补丁时间戳（20260726100000）落在 baseline 与 unify 之间，全部语句幂等
--     （ADD COLUMN IF NOT EXISTS / CREATE TABLE IF NOT EXISTS / CREATE INDEX IF NOT EXISTS /
--      外键用 pg_constraint 存在性守卫）：
--       · 空库回放 → 补齐后 unify/revert/json_fields_to_jsonb 可继续执行，链条闭合；
--       · 已按 baseline 注释 `migrate resolve --applied` 接入的既有库 → 首次执行到本迁移时，
--         已存在的同名列/表/索引为 no-op，缺失的补齐（两种状态都安全，重放无害）；
--   ③ 类型与当时生产一致：定制列 jsonb（public 生产即为 jsonb，见 unify 迁移头注释；
--      schema.prisma 的 Json → jsonb）；guest_enabled BOOLEAN NOT NULL DEFAULT false
--      （与 lib/tenantSync.js 运行时 DDL 逐字一致）。链末状态与 schema.prisma 对齐，
--      这四列与三张表不再依赖运行时 DDL。
-- =========================================================================

-- ── ① SchoolCustomization 定制列（unify/revert 迁移的前置依赖 + schema.prisma 漂移列）──
ALTER TABLE "SchoolCustomization" ADD COLUMN IF NOT EXISTS "visible_menu_items" JSONB;
ALTER TABLE "SchoolCustomization" ADD COLUMN IF NOT EXISTS "canteens" JSONB;
ALTER TABLE "SchoolCustomization" ADD COLUMN IF NOT EXISTS "field_types" JSONB;
-- 访客功能开关（RBAC 收敛）：默认关闭；与 tenantSync 运行时 DDL 同名同型同默认
ALTER TABLE "SchoolCustomization" ADD COLUMN IF NOT EXISTS "guest_enabled" BOOLEAN NOT NULL DEFAULT false;

-- ── ①b Guest / User 的访客与账号生命周期列（同为运行时 DDL 时代漂移；链末状态对齐 schema.prisma）──
-- （`prisma migrate diff --from-url=<链末库> --to-schema-datamodel` 实测缺失，见
--   evidence/P3-W2-T01/logs/diff-chainend-vs-schema.log；无任何后续 migration 引用，
--   但 fresh install 缺列会导致应用查询 P2022。）
ALTER TABLE "Guest" ADD COLUMN IF NOT EXISTS "can_view_pathogen" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "Guest" ADD COLUMN IF NOT EXISTS "request_pathogen_view" BOOLEAN NOT NULL DEFAULT false;
CREATE INDEX IF NOT EXISTS "Guest_can_view_pathogen_idx" ON "Guest"("can_view_pathogen");
ALTER TABLE "User" ADD COLUMN IF NOT EXISTS "can_view_pathogen" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "User" ADD COLUMN IF NOT EXISTS "disabled_reason" TEXT;

-- ── ② BackupRun（备份引擎主表；20260814040000 会把 table_counts ALTER 为 jsonb，表必须先存在）──
CREATE TABLE IF NOT EXISTS "BackupRun" (
    "id" TEXT NOT NULL,
    "run_type" TEXT NOT NULL,
    "scope" TEXT NOT NULL,
    "schema_name" TEXT,
    "school_code" TEXT,
    "file_path" TEXT NOT NULL,
    "file_size" INTEGER,
    "table_counts" JSONB,
    "schema_snapshot" JSONB,
    "checksum" TEXT,
    "encrypted" BOOLEAN NOT NULL DEFAULT true,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "verify_status" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "created_by" TEXT,

    CONSTRAINT "BackupRun_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX IF NOT EXISTS "BackupRun_file_path_key" ON "BackupRun"("file_path");
CREATE INDEX IF NOT EXISTS "BackupRun_created_at_idx" ON "BackupRun"("created_at");
CREATE INDEX IF NOT EXISTS "BackupRun_school_code_idx" ON "BackupRun"("school_code");
CREATE INDEX IF NOT EXISTS "BackupRun_status_idx" ON "BackupRun"("status");

-- ── ③ AccountApplication（自助注册申请表；链上无 CREATE）──
CREATE TABLE IF NOT EXISTS "AccountApplication" (
    "id" TEXT NOT NULL,
    "username" TEXT NOT NULL,
    "email" TEXT,
    "phone" TEXT,
    "full_name" TEXT,
    "password_hash" TEXT NOT NULL,
    "view_pathogen" BOOLEAN NOT NULL DEFAULT true,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "school_code" TEXT,
    "reviewer_id" TEXT,
    "review_note" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "reviewed_at" TIMESTAMP(3),

    CONSTRAINT "AccountApplication_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX IF NOT EXISTS "AccountApplication_username_key" ON "AccountApplication"("username");
CREATE INDEX IF NOT EXISTS "AccountApplication_status_idx" ON "AccountApplication"("status");
CREATE INDEX IF NOT EXISTS "AccountApplication_school_code_idx" ON "AccountApplication"("school_code");

-- ── ④ FieldOption（字段选项表，含自引用外键；链上无 CREATE）──
CREATE TABLE IF NOT EXISTS "FieldOption" (
    "id" TEXT NOT NULL,
    "module_code" TEXT NOT NULL,
    "field_code" TEXT NOT NULL,
    "value" TEXT NOT NULL,
    "label" TEXT NOT NULL,
    "parent_option_id" TEXT,
    "sort_order" INTEGER NOT NULL DEFAULT 0,
    "is_default" BOOLEAN NOT NULL DEFAULT false,
    "is_builtin" BOOLEAN NOT NULL DEFAULT false,
    "used_count" INTEGER NOT NULL DEFAULT 0,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "FieldOption_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX IF NOT EXISTS "FieldOption_module_code_field_code_value_parent_option_id_key" ON "FieldOption"("module_code", "field_code", "value", "parent_option_id");
CREATE INDEX IF NOT EXISTS "FieldOption_module_code_field_code_parent_option_id_idx" ON "FieldOption"("module_code", "field_code", "parent_option_id");
CREATE INDEX IF NOT EXISTS "FieldOption_parent_option_id_idx" ON "FieldOption"("parent_option_id");
-- 自引用外键（PostgreSQL 无 ADD CONSTRAINT IF NOT EXISTS，用 pg_constraint 存在性守卫保证幂等；
-- 与 20260915120000_open_api_tables 的守卫写法一致）
DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'FieldOption_parent_option_id_fkey') THEN
        ALTER TABLE "FieldOption" ADD CONSTRAINT "FieldOption_parent_option_id_fkey"
            FOREIGN KEY ("parent_option_id") REFERENCES "FieldOption"("id") ON DELETE CASCADE ON UPDATE CASCADE;
    END IF;
END $$;
