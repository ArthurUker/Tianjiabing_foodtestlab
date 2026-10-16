-- @scope: both
-- 病原体设备「绑定台账」迁移：PathogenDevice 增加绑定有效期，重复性约束改为「同一编号仅一个在用绑定」
--
-- 背景（2026-10-16 与产品确认）：设备绑定不是"一个可变字段"，而是**带时间区间的台账**：
--   · 绑定 = 学校 × 设备编号 × [valid_from, valid_to)；valid_to 为空 = 当前在用
--   · 学校设备故障换替代设备 → 旧绑定写 valid_to（变更当天）+ 新编号开新绑定（valid_from = 变更当天）
--   · 历史行**永久保留**，可查「什么时间到什么时间用了哪个编号」
--   · 同一学校可同时存在多个在用设备（多行并存）
--   · 同一设备编号可跨学校流转，但同一编号的区间**不得重叠**
--
-- 归属判定改为按**报文检测时间**落在哪个绑定区间来确定学校；已关闭的绑定，
-- 只要报文检测时间落在其区间内仍允许入库（设备离线/网络延迟的补传不丢数据）。
--
-- 约束变更：原 `device_no` 全局唯一 → 改为**部分唯一索引**（WHERE valid_to IS NULL），
-- 即「同一编号至多一个在用绑定」；区间不重叠由应用层在写入/变更时校验。
--
-- 分类协议（backend/lib/tenantProvisioner.js TENANT_MIGRATION_REGISTRY，按文件 checksum 固定）：
--   本文件 6 条语句 = 5 条普通 DDL/DML（逐租户回放）+ 1 条显式跳过（扫全库 DO 块）。

-- ============ public schema（prisma migrate 管理）============

ALTER TABLE "PathogenDevice"
    ADD COLUMN IF NOT EXISTS "valid_from" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    ADD COLUMN IF NOT EXISTS "valid_to" TIMESTAMP(3);

-- 存量数据回填：既有设备视为「自创建时间起在用」（默认值可能晚于创建时间）
UPDATE "PathogenDevice" SET "valid_from" = "created_at" WHERE "valid_from" > "created_at";

-- 取消「设备编号全局唯一」，改为「同一编号至多一个在用绑定」
DROP INDEX IF EXISTS "PathogenDevice_device_no_key";

CREATE UNIQUE INDEX IF NOT EXISTS "PathogenDevice_device_no_active_key"
    ON "PathogenDevice"("device_no") WHERE "valid_to" IS NULL;

CREATE INDEX IF NOT EXISTS "PathogenDevice_device_no_idx" ON "PathogenDevice"("device_no");

-- ============ 租户 schema（school_*，结构对齐用）============
-- @tenant-skip: 扫全库 DO 块（一次性为存量 school_* 补齐列与索引）；逐租户回放时其单 schema 效果
-- 由同文件前面的普通语句（均带 IF NOT EXISTS / IF EXISTS，幂等）覆盖。

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
            'ALTER TABLE %I."PathogenDevice"
                ADD COLUMN IF NOT EXISTS "valid_from" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
                ADD COLUMN IF NOT EXISTS "valid_to" TIMESTAMP(3)', t.schema_name);
        EXECUTE format(
            'UPDATE %I."PathogenDevice" SET "valid_from" = "created_at" WHERE "valid_from" > "created_at"', t.schema_name);
        EXECUTE format('DROP INDEX IF EXISTS %I."PathogenDevice_device_no_key"', t.schema_name);
        EXECUTE format(
            'CREATE UNIQUE INDEX IF NOT EXISTS "PathogenDevice_device_no_active_key" ON %I."PathogenDevice"("device_no") WHERE "valid_to" IS NULL',
            t.schema_name);
        EXECUTE format(
            'CREATE INDEX IF NOT EXISTS "PathogenDevice_device_no_idx" ON %I."PathogenDevice"("device_no")', t.schema_name);
        RAISE NOTICE '病原体设备绑定台账结构对齐完成: %', t.schema_name;
    END LOOP;
END $$;
