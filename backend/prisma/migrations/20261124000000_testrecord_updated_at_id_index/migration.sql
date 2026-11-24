-- @scope: both
-- N-05：开放接口游标排序键 (updated_at ASC, id ASC) 的复合索引。
-- 此前 TestRecord 只有 test_type/status/created_at 等索引，翻页 ORDER BY updated_at,id 全表排序。
CREATE INDEX IF NOT EXISTS "TestRecord_updated_at_id_idx" ON "TestRecord" ("updated_at", "id");
