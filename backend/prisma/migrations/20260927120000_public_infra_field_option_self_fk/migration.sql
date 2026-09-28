-- @scope: public
-- P3-PUBLIC-INFRA-FOLLOWUP-R1：历史 `20260726100000_add_customization_columns_if_missing` 的
--   FieldOption 自引用外键守卫**未限定 schema**：
--     IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'FieldOption_parent_option_id_fkey')
--   只要**任一其它 schema**（例如先建校的租户 schema）已存在同名约束，public 从零回放就会跳过创建
--   → public 缺该 FK → public 与租户结构不一致 → 租户被 `TENANT_EXTRA_OBJECTS` fail-closed 阻断
--   （真实复现与行为影响见 P3-PUBLIC-INFRA-FOLLOWUP-R1/logs/repro.log）。
-- 本文件是该缺陷的**前向修复**（不改已应用的历史 migration 与 checksum；旧 13 文件逐字节不动）：
--   · 按**目标 schema（public）精确判别**存在性；缺失则补齐；重复（>1）→ RAISE；
--   · 存在但定义不符（非自引用 / 未 validated / 缺 ON UPDATE|DELETE CASCADE）→ RAISE（fail-closed，
--     交人工核实；**不**静默 DROP/重建既有约束）；
--   · `@scope: public` → 逐租户回放整条跳过（台账记 `skipped_public_only`，租户不产生任何对象；
--     租户侧该 FK 由历史迁移的 scoped 语句建立，与本文件无关）。
-- 定点：空库从零 / 旧库（FK 已存在 → no-op）/ 重复回放 / 逐租户链 / 定义不符 fail-closed
--   见 evidence/P3-PUBLIC-INFRA-FOLLOWUP-R1/（verify 脚本 postfix 阶段 + logs/postfix.json）。
DO $followup_fk_fix$
DECLARE
  tgt text := 'public';
  nm  text := 'FieldOption_parent_option_id_fkey';
  cnt int;
  def text;
BEGIN
  -- 前置：表与两列必须存在（缺 → 结构不完整，fail-closed，不做猜测式修复）
  IF NOT EXISTS (
    SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
     WHERE n.nspname = tgt AND c.relname = 'FieldOption' AND c.relkind IN ('r', 'p')) THEN
    RAISE EXCEPTION 'PUBLIC_INFRA_FIELDOPTION_FK_FIX: table-missing:%.FieldOption', tgt;
  END IF;
  IF (SELECT count(*) FROM pg_attribute a
        JOIN pg_class c ON c.oid = a.attrelid
        JOIN pg_namespace n ON n.oid = c.relnamespace
       WHERE n.nspname = tgt AND c.relname = 'FieldOption'
         AND a.attname IN ('id', 'parent_option_id') AND a.attnum > 0 AND NOT a.attisdropped) <> 2 THEN
    RAISE EXCEPTION 'PUBLIC_INFRA_FIELDOPTION_FK_FIX: column-missing:%.FieldOption(id|parent_option_id)', tgt;
  END IF;

  -- 目标 schema 精确判别（**不**跨 schema 看同名约束 —— 即历史守卫的缺陷所在）
  SELECT count(*) INTO cnt
    FROM pg_constraint con
    JOIN pg_class t ON t.oid = con.conrelid
    JOIN pg_namespace n ON n.oid = t.relnamespace
   WHERE n.nspname = tgt AND t.relname = 'FieldOption' AND con.conname = nm AND con.contype = 'f';

  IF cnt = 0 THEN
    ALTER TABLE public."FieldOption" ADD CONSTRAINT "FieldOption_parent_option_id_fkey"
      FOREIGN KEY ("parent_option_id") REFERENCES public."FieldOption"("id") ON DELETE CASCADE ON UPDATE CASCADE;
  ELSIF cnt > 1 THEN
    RAISE EXCEPTION 'PUBLIC_INFRA_FIELDOPTION_FK_SHAPE_MISMATCH: duplicate-constraints:%', cnt;
  END IF;

  -- 形状自证：自引用 + 已验证 + 定义（规范化后）匹配（不匹配 → fail-closed，不自动重建）
  SELECT regexp_replace(pg_get_constraintdef(con.oid), '"?[A-Za-z_][A-Za-z0-9_]*"?\.', '', 'g')
    INTO def
    FROM pg_constraint con
    JOIN pg_class t ON t.oid = con.conrelid
    JOIN pg_namespace n ON n.oid = t.relnamespace
   WHERE n.nspname = tgt AND t.relname = 'FieldOption' AND con.conname = nm AND con.contype = 'f'
     AND con.convalidated AND con.conrelid = con.confrelid
   LIMIT 1;
  IF def IS NULL THEN
    RAISE EXCEPTION 'PUBLIC_INFRA_FIELDOPTION_FK_SHAPE_MISMATCH: missing-or-not-validated-or-not-self-referencing';
  END IF;
  IF def !~ '^FOREIGN KEY \(parent_option_id\) REFERENCES "?FieldOption"?\(id\)' THEN
    RAISE EXCEPTION 'PUBLIC_INFRA_FIELDOPTION_FK_SHAPE_MISMATCH: def=%', def;
  END IF;
  IF def NOT LIKE '%ON UPDATE CASCADE%' OR def NOT LIKE '%ON DELETE CASCADE%' THEN
    RAISE EXCEPTION 'PUBLIC_INFRA_FIELDOPTION_FK_SHAPE_MISMATCH: cascade-missing:def=%', def;
  END IF;
END
$followup_fk_fix$;
