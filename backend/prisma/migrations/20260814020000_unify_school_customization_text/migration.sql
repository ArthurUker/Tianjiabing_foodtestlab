-- 消除 public SchoolCustomization 的 jsonb/text 漂移（架构优化计划 P1-4 修正方案）
--
-- 背景（经 information_schema 精确核实）：
--   - public."SchoolCustomization" 的 12 个定制列历史遗留为 jsonb
--   - 所有租户 schema（school_*/recycle_*，由 tenantSync.js 用 `ADD COLUMN ... TEXT` 建表）
--     与 prisma/schema.prisma 定义（String）均为 text
--   - 代码中遍布的 `$N::jsonb` cast（tenantSync.js / schoolRoutes.js）正是为了兼容 public 的 jsonb 列
--
-- 决策：统一为 text（与 schema.prisma String 定义、与全部租户 schema 对齐），
--      而非升级为 Json（那会让所有租户表 + TestRecord 等都 ALTER，收益却因项目大量使用 raw SQL 而有限）。
-- 数据：仅 4 行，均为合法 JSON；jsonb::text 得到规范化 JSON 字符串，语义不变。
-- 前置：已 pg_dump 备份 /tmp/sc_backup_*.sql。

ALTER TABLE "SchoolCustomization" ALTER COLUMN "visible_types"     TYPE text USING "visible_types"::text;
ALTER TABLE "SchoolCustomization" ALTER COLUMN "visible_menu_items" TYPE text USING "visible_menu_items"::text;
ALTER TABLE "SchoolCustomization" ALTER COLUMN "canteens"          TYPE text USING "canteens"::text;
ALTER TABLE "SchoolCustomization" ALTER COLUMN "field_labels"      TYPE text USING "field_labels"::text;
ALTER TABLE "SchoolCustomization" ALTER COLUMN "hidden_fields"     TYPE text USING "hidden_fields"::text;
ALTER TABLE "SchoolCustomization" ALTER COLUMN "theme_config"      TYPE text USING "theme_config"::text;
ALTER TABLE "SchoolCustomization" ALTER COLUMN "field_rules"       TYPE text USING "field_rules"::text;
ALTER TABLE "SchoolCustomization" ALTER COLUMN "field_options"     TYPE text USING "field_options"::text;
ALTER TABLE "SchoolCustomization" ALTER COLUMN "field_order"       TYPE text USING "field_order"::text;
ALTER TABLE "SchoolCustomization" ALTER COLUMN "custom_fields"     TYPE text USING "custom_fields"::text;
ALTER TABLE "SchoolCustomization" ALTER COLUMN "test_types"        TYPE text USING "test_types"::text;
ALTER TABLE "SchoolCustomization" ALTER COLUMN "field_types"       TYPE text USING "field_types"::text;
