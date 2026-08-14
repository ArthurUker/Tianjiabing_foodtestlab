-- 撤销 20260814020000 的错误迁移（把 public SchoolCustomization 误降级为 text），
-- 恢复为 jsonb —— 与历史正确优化方向一致（P1-4 修正）。
--
-- 正确方向：jsonb（而非 text）。理由：
--   1) jsonb 支持 ->> / -> / @> / ? 等 JSON 运算符，可在 WHERE 内直接查 JSON 内部，
--      项目已多处依赖（guestRoutes.js result_data::jsonb->>'result'、auditLog.js context::jsonb->>'actor_id'）；
--      text 列每次都要 ::jsonb 临时转换且无法建 GIN 索引。
--   2) jsonb 写入时校验 JSON 合法性，非法 JSON 拒绝写入；text 存任意字符串，运行时才炸。
--   3) jsonb 去重键 + 紧凑存储，通常比 text 存 JSON 更省空间。
-- 数据：4 行均为合法 JSON，text::jsonb 语义不变。

ALTER TABLE "SchoolCustomization" ALTER COLUMN "visible_types"     TYPE jsonb USING "visible_types"::jsonb;
ALTER TABLE "SchoolCustomization" ALTER COLUMN "visible_menu_items" TYPE jsonb USING "visible_menu_items"::jsonb;
ALTER TABLE "SchoolCustomization" ALTER COLUMN "canteens"          TYPE jsonb USING "canteens"::jsonb;
ALTER TABLE "SchoolCustomization" ALTER COLUMN "field_labels"      TYPE jsonb USING "field_labels"::jsonb;
ALTER TABLE "SchoolCustomization" ALTER COLUMN "hidden_fields"     TYPE jsonb USING "hidden_fields"::jsonb;
ALTER TABLE "SchoolCustomization" ALTER COLUMN "theme_config"      TYPE jsonb USING "theme_config"::jsonb;
ALTER TABLE "SchoolCustomization" ALTER COLUMN "field_rules"       TYPE jsonb USING "field_rules"::jsonb;
ALTER TABLE "SchoolCustomization" ALTER COLUMN "field_options"     TYPE jsonb USING "field_options"::jsonb;
ALTER TABLE "SchoolCustomization" ALTER COLUMN "field_order"       TYPE jsonb USING "field_order"::jsonb;
ALTER TABLE "SchoolCustomization" ALTER COLUMN "custom_fields"     TYPE jsonb USING "custom_fields"::jsonb;
ALTER TABLE "SchoolCustomization" ALTER COLUMN "test_types"        TYPE jsonb USING "test_types"::jsonb;
ALTER TABLE "SchoolCustomization" ALTER COLUMN "field_types"       TYPE jsonb USING "field_types"::jsonb;
