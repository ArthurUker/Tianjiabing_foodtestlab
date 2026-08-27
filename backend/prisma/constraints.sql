-- constraints.sql — 数据库级 CHECK 约束（D-01 / D-03 补充，Prisma 不支持原生 CHECK）
--
-- 用法（对每个租户 schema 各执行一次；:schema 需替换为实际 schema 名）：
--   psql "$DATABASE_URL" -v schema=<school_schema> -f backend/prisma/constraints.sql
-- 或手动：
--   psql "$DATABASE_URL" -c 'SET search_path TO <school_schema>' -f ...（psql -f 会重置 search_path，
--   推荐用上面的 -v 变量方式）
--
-- ⚠️ 设计决策（D-01）：TestRecord.test_type 【不加】DB 级 CHECK 约束。
--   原因：层级 B 允许学校在管理控制台自定义全新检测类型（test_types 配置），
--   DB 硬编码类型白名单会阻断该业务能力。类型合法性由应用层校验
--   （server.js 依据 SchoolCustomization.visible_types/test_types 白名单）。
--
-- 所有语句幂等：约束已存在时跳过。

SET search_path TO :"schema";

-- D-03: TestRecord.status 合法值（与 schema.prisma 注释一致：pending/completed/failed/archived；
--       兼容离线同步链路的 synced 状态）
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint c
    JOIN pg_namespace n ON n.oid = c.connamespace
    WHERE c.conname = 'testrecord_status_check'
      AND n.nspname = current_schema()
  ) THEN
    EXECUTE 'ALTER TABLE "TestRecord" ADD CONSTRAINT testrecord_status_check
             CHECK (status IN (''pending'',''completed'',''failed'',''archived'',''synced''))';
  END IF;
END $$;

-- Session.status 合法值
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint c
    JOIN pg_namespace n ON n.oid = c.connamespace
    WHERE c.conname = 'session_status_check'
      AND n.nspname = current_schema()
  ) THEN
    EXECUTE 'ALTER TABLE "Session" ADD CONSTRAINT session_status_check
             CHECK (status IN (''active'',''revoked''))';
  END IF;
END $$;

-- User.status 合法值
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint c
    JOIN pg_namespace n ON n.oid = c.connamespace
    WHERE c.conname = 'user_status_check'
      AND n.nspname = current_schema()
  ) THEN
    EXECUTE 'ALTER TABLE "User" ADD CONSTRAINT user_status_check
             CHECK (status IN (''active'',''disabled''))';
  END IF;
END $$;
