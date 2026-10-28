-- @scope: both
-- 病原体设备上报检索加固（2026-10-28，压测前）
--
-- 背景：原判重/合并实现是「按 created_at 倒序取最近 300 条记录，再在内存里比对芯片号」，
--   档案候选是「按食堂+样本类型取最近 20 条再逐条比对」。数据量增长后会出现：
--     · 老芯片重传（距今超过 300 条记录）→ 判不出重复 → 产生重复记录
--     · 同食堂候选超过 20 条 → 漏判复测合并
--   属**规模相关缺陷**，压测（P0-④）会直接暴露。
--
-- 方案：把「芯片号集合」与「档案键」落成派生列并建索引，改为精确查询：
--   · chip_nos TEXT[] + GIN 索引 → 覆盖「记录自身芯片 + 各复测轮次芯片」，支持 has 查询
--   · case_key TEXT  + B-tree(test_type, case_key) → 同档案候选直接按键取，行数极少
-- 两列均为派生值（真值仍在 sample_info / result_data JSON），由写入路径维护，
-- 历史数据用一次性回填脚本补齐（scripts/backfill-pathogen-lookup.mjs，用与写入同一套 JS 归一化，
-- 保证与 SQL 手写相比不产生口径差）。
--
-- 分类协议（TENANT_MIGRATION_REGISTRY，按文件 checksum 固定）：3 条语句，全部为
-- 幂等 DDL（ADD COLUMN IF NOT EXISTS / CREATE INDEX IF NOT EXISTS），无跳过语句，逐租户回放。

ALTER TABLE "TestRecord"
    ADD COLUMN IF NOT EXISTS "chip_nos" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
    ADD COLUMN IF NOT EXISTS "case_key" TEXT;

-- 芯片号集合检索（GIN 支持数组 has / && 操作符）
CREATE INDEX IF NOT EXISTS "TestRecord_chip_nos_idx" ON "TestRecord" USING GIN ("chip_nos");

-- 档案键检索（同档案候选：通常 1~2 行）
CREATE INDEX IF NOT EXISTS "TestRecord_test_type_case_key_idx" ON "TestRecord" ("test_type", "case_key");
