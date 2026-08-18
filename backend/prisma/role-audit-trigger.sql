-- role-audit-trigger.sql — 角色变更审计 + 合法性 DB 级兜底（H4-ext / #10 / #7）
--
-- 背景：changeUserRole（UserManager.js）已写入 AuditLog 并吊销会话；但运维直接
-- UPDATE "User" SET role=... 会绕过应用层审计与吊销，造成合规缺口与"降权不即时失效"。
-- 本脚本用 DB 触发器兜底：任何路径（含裸 SQL）的角色变更都写 AuditLog，并强制
-- role 合法值（非法值直接拒绝，防止 #9 的 role=NULL 绕过覆盖逻辑的漏洞）。
--
-- 同时把 "角色变更必须吊销会话" 的约束下沉到 DB：当角色发生变更时，往 public.revoked_tokens
-- 写入 user_all 全量吊销记录（与 UserManager.revokeUserSessions 行为一致），使旧 token
-- 在下次请求即 401（H2），不再依赖 30s TTL。
--
-- 用法（对每个租户 schema 各执行一次；:schema 替换为实际 schema 名，如 school_tjb）：
--   psql "$DATABASE_URL" -v schema=school_tjb -f backend/prisma/role-audit-trigger.sql
--
-- 所有对象幂等：已存在则跳过（DROP/CREATE 用 IF NOT EXISTS + CREATE OR REPLACE）。
-- 注意：触发器函数依赖 public.revoked_tokens 与 <schema>.audit_logs，部署前需确保两表已存在。

SET search_path TO :"schema";

-- ── 1. 角色合法性 CHECK 约束（拒绝 NULL / 非法值，兜底 #9）──────────────────
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint c
    JOIN pg_namespace n ON n.oid = c.connamespace
    WHERE c.conname = 'user_role_check'
      AND n.nspname = current_schema()
  ) THEN
    EXECUTE 'ALTER TABLE "User" ADD CONSTRAINT user_role_check
             CHECK (role IN (''admin'',''manager'',''operator'',''viewer''))';
  END IF;
END $$;

-- ── 2. 角色变更审计 + 全量吊销 触发器函数 ─────────────────────────────────
CREATE OR REPLACE FUNCTION audit_role_change()
RETURNS TRIGGER AS $$
DECLARE
  v_actor text;
  v_actor_id text;
BEGIN
  -- 仅当角色真正发生变化才处理
  IF OLD.role IS NOT DISTINCT FROM NEW.role THEN
    RETURN NEW;
  END IF;

  -- 尝试从 session_user / current_setting 获取操作者（应用层可 SET audit.actor_id）；
  -- 裸 SQL 无上下文时退化为 'db-direct'（仍保证审计不丢失，满足 #10 的可追溯要求）。
  BEGIN
    v_actor_id := current_setting('audit.actor_id', true);
  EXCEPTION WHEN OTHERS THEN
    v_actor_id := NULL;
  END;
  v_actor := COALESCE(v_actor_id, 'db-direct');

  -- 写入租户级审计（资源为 user，action=role_change；AuditLog 与 User 同 schema）。
  -- 用 TG_TABLE_SCHEMA 动态限定，避免 plpgsql 函数 search_path 解析到错误 schema 的外键。
  -- user_id 受外键约束必须存在：裸 SQL 无操作者时用 OLD.id（记在被改用户自身名下），
  -- 真实操作者来源统一放在 details.source（'app' | 'db-direct'）。
  EXECUTE format(
    'INSERT INTO %I."AuditLog" (id, user_id, action, resource_type, resource_id, details, created_at)
     VALUES ($1,$2,''role_change'',''user'',$3,$4,now())',
    TG_TABLE_SCHEMA
  ) USING
    gen_random_uuid()::text,
    OLD.id,
    OLD.id,
    -- P1-4 后续：AuditLog.details 已升级为 jsonb（见 migrations/20260814040000_json_fields_to_jsonb），
    -- 必须 ::jsonb 显式转换；::text 会触发 PG 42804「expression is of type text」拒写。
    -- 这里选 ::jsonb 而非省掉 cast：plpgsql 的 EXECUTE format + USING 路径下，省略 cast 走
    -- 「json → jsonb」隐式转换，部分 PG 版本会保持 json 字节序而牺牲 jsonb 的二进制去重/索引收益；
    -- 显式 ::jsonb 保证与其它应用层写入（writeTenantAuditLog）口径一致。
    json_build_object(
      'targetUserId', OLD.id,
      'targetUsername', OLD.username,
      'oldRole', OLD.role,
      'newRole', NEW.role,
      'source', CASE WHEN v_actor_id IS NULL THEN 'db-direct' ELSE 'app' END
    )::jsonb;

  -- 全量吊销会话（兜底 #7）：任何角色变更都让旧 token 即刻失效。
  -- 与 revokeAllUserTokens(token_type='user_all') 等价，覆盖裸 SQL 路径。
  -- jti 唯一，用 uuid 后缀避免并发重复；expires_at 取 8 天（与应用层一致）。
  INSERT INTO public.revoked_tokens (jti, user_id, school_code, token_type, reason, expires_at)
  VALUES ('user_all:' || OLD.id || ':' || gen_random_uuid()::text, OLD.id, NULL, 'user_all', 'role_change_db_trigger', now() + interval '8 days')
  ON CONFLICT (jti) DO NOTHING;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- ── 3. 挂载触发器（幂等：先删后建）────────────────────────────────────────
DROP TRIGGER IF EXISTS trg_audit_role_change ON "User";
CREATE TRIGGER trg_audit_role_change
  AFTER UPDATE OF role ON "User"
  FOR EACH ROW
  EXECUTE FUNCTION audit_role_change();
