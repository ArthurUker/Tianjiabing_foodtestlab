-- @scope: public
-- P3-PUBLIC-INFRA-CHAIN-R1（R9 §1）：令牌吊销事实源（表 + 3 索引）正式入链。
--   · 本文件是吊销表与索引的**唯一结构事实源**；运行时 authMiddleware 的
--     CREATE TABLE / CREATE INDEX 已撤出，改为只读形状断言
--     （缺表/缺列/缺索引/错形 → AUTH_INFRA_MISSING → 503，**不进 fail-soft**）。
--   · 与 runtime 历史定义同形（authMiddleware REVOKED_TOKENS_DDL：7 列 + 3 非唯一索引；
--     school_epoch 索引 = P3-W1-T01 停校 O(1) 失效全校会话的关键路径）。
--   · 存量库兼容：IF NOT EXISTS（不重建、不丢行）；**已应用后**的事后缺失/篡改
--     不会被 migrate deploy 重跑修复 → 由运行时只读自检兜底（fail-closed）。
--   · 不写 public. 前缀（分类协议：migrate deploy 的 search_path=public 即落 public）。
--   · @scope: public → 逐租户回放整条跳过（租户台账记 skipped_public_only），租户不产生同名对象。
CREATE TABLE IF NOT EXISTS revoked_tokens (
  jti         TEXT PRIMARY KEY,
  user_id     TEXT NOT NULL,
  school_code TEXT,
  token_type  TEXT NOT NULL DEFAULT 'access',
  reason      TEXT,
  revoked_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at  TIMESTAMPTZ NOT NULL
);

-- 结构自证（应用时逐列核对：表/列名/类型/非空/默认值/主键；不匹配即 RAISE → 迁移失败 → public pending 阻断流量）
DO $$
DECLARE
  bad text := NULL;
  cnt int;
  rec record;
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
     WHERE n.nspname = 'public' AND c.relname = 'revoked_tokens') THEN
    RAISE EXCEPTION 'PUBLIC_INFRA_REVOKED_TOKENS_SHAPE_MISMATCH: table-missing:public.revoked_tokens';
  END IF;
  FOR rec IN
    SELECT * FROM (VALUES
      ('jti','text',true),
      ('user_id','text',true),
      ('school_code','text',false),
      ('token_type','text',true),
      ('reason','text',false),
      ('revoked_at','timestamp with time zone',true),
      ('expires_at','timestamp with time zone',true)
    ) AS e(col, typ, nn)
  LOOP
    IF NOT EXISTS (
      SELECT 1 FROM pg_attribute a
        JOIN pg_class c ON c.oid = a.attrelid
        JOIN pg_namespace n ON n.oid = c.relnamespace
       WHERE n.nspname = 'public' AND c.relname = 'revoked_tokens'
         AND a.attname = rec.col AND a.attnum > 0 AND NOT a.attisdropped
         AND format_type(a.atttypid, a.atttypmod) = rec.typ
         AND a.attnotnull = rec.nn) THEN
      bad := coalesce(bad || '；', '') || format('column:%s(want %s, notnull=%s)', rec.col, rec.typ, rec.nn);
    END IF;
  END LOOP;
  SELECT count(*) INTO cnt FROM pg_attribute a
    JOIN pg_class c ON c.oid = a.attrelid
    JOIN pg_namespace n ON n.oid = c.relnamespace
   WHERE n.nspname = 'public' AND c.relname = 'revoked_tokens'
     AND a.attnum > 0 AND NOT a.attisdropped;
  IF cnt <> 7 THEN
    bad := coalesce(bad || '；', '') || format('column-count=%s(want 7)', cnt);
  END IF;
  FOR rec IN SELECT * FROM (VALUES ('token_type','''access''::text'), ('revoked_at','now()')) AS e(col, def)
  LOOP
    IF NOT EXISTS (
      SELECT 1 FROM pg_attribute a
        JOIN pg_class c ON c.oid = a.attrelid
        JOIN pg_namespace n ON n.oid = c.relnamespace
        LEFT JOIN pg_attrdef d ON d.adrelid = c.oid AND d.adnum = a.attnum
       WHERE n.nspname = 'public' AND c.relname = 'revoked_tokens'
         AND a.attname = rec.col AND a.attnum > 0 AND NOT a.attisdropped
         AND coalesce(pg_get_expr(d.adbin, d.adrelid), '') = rec.def) THEN
      bad := coalesce(bad || '；', '') || format('default:%s(want %s)', rec.col, rec.def);
    END IF;
  END LOOP;
  IF NOT EXISTS (
    SELECT 1 FROM pg_index ix
      JOIN pg_class t ON t.oid = ix.indrelid
      JOIN pg_namespace n ON n.oid = t.relnamespace
     WHERE n.nspname = 'public' AND t.relname = 'revoked_tokens' AND ix.indisprimary
       AND (SELECT array_agg(a.attname::text ORDER BY k.ord)
              FROM unnest(ix.indkey::int2[]) WITH ORDINALITY AS k(attnum, ord)
              JOIN pg_attribute a ON a.attrelid = t.oid AND a.attnum = k.attnum) = ARRAY['jti']) THEN
    bad := coalesce(bad || '；', '') || 'primary-key(want jti)';
  END IF;
  IF bad IS NOT NULL THEN
    RAISE EXCEPTION 'PUBLIC_INFRA_REVOKED_TOKENS_SHAPE_MISMATCH: %', bad;
  END IF;
END $$;

-- 3 索引（非唯一；索引名与列序 = 运行时历史定义逐字一致）
CREATE INDEX IF NOT EXISTS revoked_tokens_expires_at_idx ON revoked_tokens (expires_at);
CREATE INDEX IF NOT EXISTS revoked_tokens_user_idx ON revoked_tokens (user_id, token_type, revoked_at);
CREATE INDEX IF NOT EXISTS revoked_tokens_school_epoch_idx ON revoked_tokens (school_code, token_type, revoked_at);

-- 索引自证（名称 + 列序 + 非唯一；不匹配即 RAISE）
DO $$
DECLARE
  bad text := NULL;
  rec record;
BEGIN
  FOR rec IN
    SELECT * FROM (VALUES
      ('revoked_tokens_expires_at_idx', ARRAY['expires_at']),
      ('revoked_tokens_user_idx', ARRAY['user_id','token_type','revoked_at']),
      ('revoked_tokens_school_epoch_idx', ARRAY['school_code','token_type','revoked_at'])
    ) AS e(name, cols)
  LOOP
    IF NOT EXISTS (
      SELECT 1 FROM pg_class i
        JOIN pg_index ix ON ix.indexrelid = i.oid
        JOIN pg_class t ON t.oid = ix.indrelid
        JOIN pg_namespace n ON n.oid = t.relnamespace
       WHERE n.nspname = 'public' AND t.relname = 'revoked_tokens' AND i.relname = rec.name
         AND ix.indisunique = false
         AND (SELECT array_agg(a.attname::text ORDER BY k.ord)
                FROM unnest(ix.indkey::int2[]) WITH ORDINALITY AS k(attnum, ord)
                JOIN pg_attribute a ON a.attrelid = t.oid AND a.attnum = k.attnum) = rec.cols) THEN
      bad := coalesce(bad || '；', '') || format('index:%s(want %s)', rec.name, array_to_string(rec.cols, ','));
    END IF;
  END LOOP;
  IF bad IS NOT NULL THEN
    RAISE EXCEPTION 'PUBLIC_INFRA_REVOKED_TOKENS_INDEX_MISMATCH: %', bad;
  END IF;
END $$;
