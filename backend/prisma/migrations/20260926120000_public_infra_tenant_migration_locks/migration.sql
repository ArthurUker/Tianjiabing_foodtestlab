-- @scope: public
-- P3-PUBLIC-INFRA-CHAIN-R1（R9 §1）：迁移互斥锁表正式入链。
--   · 本文件是本表的**唯一结构事实源**；运行时 apply 路径的 CREATE TABLE / ADD COLUMN 已撤出，
--     改为只读形状断言（缺形状/错形 → TENANT_LOCK_TABLE_SHAPE_MISMATCH → 该校阻断）。
--   · 与 runtime 历史定义逐列同形：migrationLockDdl() + migrationLockUpgradeStatements()
--     （runtime 只保留形状定义作为等价对照与只读断言，不再执行 DDL）。
--   · 存量库兼容：CREATE TABLE IF NOT EXISTS + 逐列 ADD COLUMN IF NOT EXISTS（不重建、不丢行；
--     持锁中的行保留，按心跳/人工清除规则自然收敛）。
--   · 不写 public. 前缀（分类协议：migrate deploy 的 search_path=public 即落 public）。
--   · @scope: public → 逐租户回放整条跳过（租户台账记 skipped_public_only），租户不产生同名对象。
CREATE TABLE IF NOT EXISTS "_tenant_migration_locks" (
  schema_name text PRIMARY KEY,
  owner text NOT NULL,
  locked_at timestamptz NOT NULL DEFAULT now(),
  heartbeat_at timestamptz NOT NULL DEFAULT now(),
  fencing_token bigint NOT NULL DEFAULT 1,
  hostname text,
  pid integer
);

-- 存量库升级（R3 期两列/三列锁表）：逐列补齐，幂等
ALTER TABLE "_tenant_migration_locks" ADD COLUMN IF NOT EXISTS heartbeat_at timestamptz NOT NULL DEFAULT now();
ALTER TABLE "_tenant_migration_locks" ADD COLUMN IF NOT EXISTS fencing_token bigint NOT NULL DEFAULT 1;
ALTER TABLE "_tenant_migration_locks" ADD COLUMN IF NOT EXISTS hostname text;
ALTER TABLE "_tenant_migration_locks" ADD COLUMN IF NOT EXISTS pid integer;

-- 结构自证（应用时逐列核对：表/列名/类型/非空/默认值/主键；不匹配即 RAISE → 迁移失败 → public pending 阻断流量）
DO $$
DECLARE
  bad text := NULL;
  cnt int;
  rec record;
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
     WHERE n.nspname = 'public' AND c.relname = '_tenant_migration_locks') THEN
    RAISE EXCEPTION 'PUBLIC_INFRA_LOCK_TABLE_SHAPE_MISMATCH: table-missing:public._tenant_migration_locks';
  END IF;
  FOR rec IN
    SELECT * FROM (VALUES
      ('schema_name','text',true),
      ('owner','text',true),
      ('locked_at','timestamp with time zone',true),
      ('heartbeat_at','timestamp with time zone',true),
      ('fencing_token','bigint',true),
      ('hostname','text',false),
      ('pid','integer',false)
    ) AS e(col, typ, nn)
  LOOP
    IF NOT EXISTS (
      SELECT 1 FROM pg_attribute a
        JOIN pg_class c ON c.oid = a.attrelid
        JOIN pg_namespace n ON n.oid = c.relnamespace
       WHERE n.nspname = 'public' AND c.relname = '_tenant_migration_locks'
         AND a.attname = rec.col AND a.attnum > 0 AND NOT a.attisdropped
         AND format_type(a.atttypid, a.atttypmod) = rec.typ
         AND a.attnotnull = rec.nn) THEN
      bad := coalesce(bad || '；', '') || format('column:%s(want %s, notnull=%s)', rec.col, rec.typ, rec.nn);
    END IF;
  END LOOP;
  SELECT count(*) INTO cnt FROM pg_attribute a
    JOIN pg_class c ON c.oid = a.attrelid
    JOIN pg_namespace n ON n.oid = c.relnamespace
   WHERE n.nspname = 'public' AND c.relname = '_tenant_migration_locks'
     AND a.attnum > 0 AND NOT a.attisdropped;
  IF cnt <> 7 THEN
    bad := coalesce(bad || '；', '') || format('column-count=%s(want 7)', cnt);
  END IF;
  FOR rec IN SELECT * FROM (VALUES ('locked_at','now()'), ('heartbeat_at','now()'), ('fencing_token','1')) AS e(col, def)
  LOOP
    IF NOT EXISTS (
      SELECT 1 FROM pg_attribute a
        JOIN pg_class c ON c.oid = a.attrelid
        JOIN pg_namespace n ON n.oid = c.relnamespace
        LEFT JOIN pg_attrdef d ON d.adrelid = c.oid AND d.adnum = a.attnum
       WHERE n.nspname = 'public' AND c.relname = '_tenant_migration_locks'
         AND a.attname = rec.col AND a.attnum > 0 AND NOT a.attisdropped
         AND coalesce(pg_get_expr(d.adbin, d.adrelid), '') = rec.def) THEN
      bad := coalesce(bad || '；', '') || format('default:%s(want %s)', rec.col, rec.def);
    END IF;
  END LOOP;
  IF NOT EXISTS (
    SELECT 1 FROM pg_index ix
      JOIN pg_class t ON t.oid = ix.indrelid
      JOIN pg_namespace n ON n.oid = t.relnamespace
     WHERE n.nspname = 'public' AND t.relname = '_tenant_migration_locks' AND ix.indisprimary
       AND (SELECT array_agg(a.attname::text ORDER BY k.ord)
              FROM unnest(ix.indkey::int2[]) WITH ORDINALITY AS k(attnum, ord)
              JOIN pg_attribute a ON a.attrelid = t.oid AND a.attnum = k.attnum) = ARRAY['schema_name']) THEN
    bad := coalesce(bad || '；', '') || 'primary-key(want schema_name)';
  END IF;
  IF bad IS NOT NULL THEN
    RAISE EXCEPTION 'PUBLIC_INFRA_LOCK_TABLE_SHAPE_MISMATCH: %', bad;
  END IF;
END $$;
