-- 将剩余 JSON 语义字段统一升级为 jsonb（架构优化计划 P1-4 阶段2）
--
-- 字段清单（全库核实均为 text、无 jsonb/text 混合）：
--   AuditLog.details          text?  -> jsonb?
--   TestRecord.sample_info    text NOT NULL DEFAULT '{}' -> jsonb NOT NULL DEFAULT '{}'
--   TestRecord.result_data    text NOT NULL DEFAULT '{}' -> jsonb NOT NULL DEFAULT '{}'
--   GuestExportRequest.request_data  text? -> jsonb?
--   BackupRun.table_counts    text?  -> jsonb?（仅 public，租户侧 BackupRun 无此列）
--   SystemLog.context         text?  -> jsonb?
--
-- 收益：jsonb 支持 ->/->>/@>/GIN 索引，消除 guestRoutes 统计聚合的 text::jsonb 每次全表 cast，
--       写入时校验 JSON 合法性。
-- 前置：已 pg_dump 备份 /tmp/json_fields_backup_*.sql。

-- ============ public schema（prisma migrate 管理）============

ALTER TABLE "AuditLog" ALTER COLUMN "details" TYPE jsonb USING "details"::jsonb;

-- TestRecord 两个非空列带 DEFAULT '{}'，PG 无法自动把 text 默认值 cast 到 jsonb，
-- 须先 DROP DEFAULT 再改类型再 SET DEFAULT。
ALTER TABLE "TestRecord" ALTER COLUMN "sample_info" DROP DEFAULT;
ALTER TABLE "TestRecord" ALTER COLUMN "sample_info" TYPE jsonb USING "sample_info"::jsonb;
ALTER TABLE "TestRecord" ALTER COLUMN "sample_info" SET DEFAULT '{}'::jsonb;
ALTER TABLE "TestRecord" ALTER COLUMN "result_data" DROP DEFAULT;
ALTER TABLE "TestRecord" ALTER COLUMN "result_data" TYPE jsonb USING "result_data"::jsonb;
ALTER TABLE "TestRecord" ALTER COLUMN "result_data" SET DEFAULT '{}'::jsonb;

ALTER TABLE "GuestExportRequest" ALTER COLUMN "request_data" TYPE jsonb USING "request_data"::jsonb;

ALTER TABLE "BackupRun" ALTER COLUMN "table_counts" TYPE jsonb USING "table_counts"::jsonb;

ALTER TABLE "SystemLog" ALTER COLUMN "context" TYPE jsonb USING "context"::jsonb;

-- ============ 租户 schema（school_*/recycle_*，走 db push / tenantSync 建表，prisma migrate 不覆盖）============

DO $$
DECLARE
    t record;
BEGIN
    FOR t IN
        SELECT table_schema, table_name, column_name
        FROM information_schema.columns
        WHERE table_schema <> 'public'
          AND (table_name, column_name) IN (
              ('AuditLog', 'details'),
              ('TestRecord', 'sample_info'),
              ('TestRecord', 'result_data'),
              ('SystemLog', 'context'),
              ('GuestExportRequest', 'request_data'),
              ('BackupRun', 'table_counts')
          )
          AND udt_name = 'text'
    LOOP
        IF t.table_name = 'TestRecord' AND t.column_name IN ('sample_info', 'result_data') THEN
            EXECUTE format('ALTER TABLE %I.%I ALTER COLUMN %I DROP DEFAULT',
                           t.table_schema, t.table_name, t.column_name);
            EXECUTE format('ALTER TABLE %I.%I ALTER COLUMN %I TYPE jsonb USING %I::jsonb',
                           t.table_schema, t.table_name, t.column_name, t.column_name);
            EXECUTE format('ALTER TABLE %I.%I ALTER COLUMN %I SET DEFAULT %L::jsonb',
                           t.table_schema, t.table_name, t.column_name, '{}');
        ELSE
            EXECUTE format('ALTER TABLE %I.%I ALTER COLUMN %I TYPE jsonb USING %I::jsonb',
                           t.table_schema, t.table_name, t.column_name, t.column_name);
        END IF;
        RAISE NOTICE 'P1-4 jsonb: %.%.%', t.table_schema, t.table_name, t.column_name;
    END LOOP;
END $$;
