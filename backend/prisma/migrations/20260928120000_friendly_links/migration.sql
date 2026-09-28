-- @scope: both
-- 友情链接（登录页外链）建表迁移：public."FriendlyLink"
--
-- 背景（2026-09-28）：登录卡下方的「友情链接」原为 frontend/pages/login.html 内硬编码的
--   单条外链（https://foodsafety.digifluidic.com/）。现改由平台超管在超管控制台「友情链接」
--   视图维护：多条 / 排序 / 启停 / 一键访问 / 访问计数；登录页读取 /api/public/friendly-links 渲染。
--
-- 权威副本在 public（平台级配置表，与 OpenApi* 三表同模式）：
--   ① public 由 prisma migrate 管理，本迁移直接建表（IF NOT EXISTS 幂等）；
--   ② 租户 schema 由迁移链逐租户回放 + provisionSchool 推表，建**同名空表**（纯结构对齐，
--      租户副本永不写入；应用层一律用基础 prisma 单例读写 public，绝不用 req.db）；
--   ③ 为避免"public 迁移已跑、租户尚未回放"的窗口，沿用 20260915120000_open_api_tables 先例，
--      用 DO 块一次性为全部 school_* 建空表（school_*_old_* 回滚点跳过）。
--
-- 分类协议（backend/lib/tenantProvisioner.js TENANT_MIGRATION_REGISTRY，按文件 checksum 固定）：
--   本文件 4 条语句 = 2 条普通 DDL（建表 / 建索引，逐租户执行）
--                + 2 条显式跳过（public 种子数据 / 扫全库 DO 块）。
--
-- 结构由 `prisma migrate diff --from-empty --to-schema-datamodel` 口径生成，与 Prisma Client 一致。

-- ============ public schema（prisma migrate 管理）============

CREATE TABLE IF NOT EXISTS "FriendlyLink" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "url" TEXT NOT NULL,
    "description" TEXT,
    "icon" TEXT,
    "group_name" TEXT,
    "sort_order" INTEGER NOT NULL DEFAULT 0,
    "status" TEXT NOT NULL DEFAULT 'enabled',
    "open_in_new_tab" BOOLEAN NOT NULL DEFAULT true,
    "visit_count" INTEGER NOT NULL DEFAULT 0,
    "last_visit_at" TIMESTAMP(3),
    "created_by" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "FriendlyLink_pkey" PRIMARY KEY ("id")
);

CREATE INDEX IF NOT EXISTS "FriendlyLink_status_sort_order_idx" ON "FriendlyLink"("status", "sort_order");

-- 种子（**仅 public**；逐租户回放按注册表 skip，租户副本保持空表）：
-- 保留登录页原有的「校园食安卫士」入口，避免上线即空；仅当表为空时写入（幂等）。
INSERT INTO "FriendlyLink" ("id", "name", "url", "description", "icon", "sort_order", "status", "open_in_new_tab", "visit_count", "created_at", "updated_at")
SELECT 'fl-seed-campus-foodsafety', '校园食安卫士', 'https://foodsafety.digifluidic.com/', '校园食品安全「检·教·治」一体化推广方案', 'fas fa-link', 10, 'enabled', true, 0, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP
WHERE NOT EXISTS (SELECT 1 FROM "FriendlyLink");

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
            'CREATE TABLE IF NOT EXISTS %I."FriendlyLink" (
                "id" TEXT NOT NULL,
                "name" TEXT NOT NULL,
                "url" TEXT NOT NULL,
                "description" TEXT,
                "icon" TEXT,
                "group_name" TEXT,
                "sort_order" INTEGER NOT NULL DEFAULT 0,
                "status" TEXT NOT NULL DEFAULT ''enabled'',
                "open_in_new_tab" BOOLEAN NOT NULL DEFAULT true,
                "visit_count" INTEGER NOT NULL DEFAULT 0,
                "last_visit_at" TIMESTAMP(3),
                "created_by" TEXT,
                "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
                "updated_at" TIMESTAMP(3) NOT NULL,
                CONSTRAINT "FriendlyLink_pkey" PRIMARY KEY ("id")
             )', t.schema_name);
        EXECUTE format(
            'CREATE INDEX IF NOT EXISTS "FriendlyLink_status_sort_order_idx"
             ON %I."FriendlyLink"("status", "sort_order")', t.schema_name);
        RAISE NOTICE '友情链接建表完成: %', t.schema_name;
    END LOOP;
END $$;
