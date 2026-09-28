-- @scope: both
-- P3-LIFECYCLE-AB-R3 · Release A · M1（expand）：审计主体锚点 + nullable 契约 + 强门禁 CHECK NOT VALID
--
-- 上位依据：R9（username-only 不自动映射）/ R10（14 链放行窗口 3）/ R12（PASS_LOCAL_SCOPE）/
--   P3-W2-LIFECYCLE-DESIGN-R5 §1（强门禁 = DB 级 CHECK ... NOT VALID，替代 created_at 水位）/
--   P3-LIFECYCLE-AB-R1/{PLAN_A.md,TEST_PLAN.md} 与 P3-LIFECYCLE-AB-R2/{PLAN_A_R2.md,CLIENT_STRATEGY_R2.md}。
-- 本文件仅追加在本链尾 `20260927120000_public_infra_field_option_self_fk` 之后；旧 14 文件一字不改。
--
-- 语义（A 期 = nullable，允许历史 NULL；B 期 = M2 回填/VALIDATE/SET NOT NULL）：
--   1. 解除 `AuditLog.user_id` 级联销毁（AUD-027）：列可空 + FK ON DELETE SET NULL（删用户不再删审计）；
--   2. `AuditPrincipal`（不可变主体锚点：人类 = 稳定 subject_user_id；系统 = 'system'，每 scope 恰 1 行）；
--   3. `AuditLog.principal_id`（A 期可空）+ `actor_snapshot`（JSONB，事件时点快照）；
--   4. **强门禁**：`CHECK ("principal_id" IS NOT NULL) NOT VALID` —— 不校验存量行，但此后所有
--      INSERT / UPDATE 的新版本必须满足（时间无关，无法用"回填旧时间/应用指定时间"绕过）；
--   5. `User.deleted_at/deleted_by`（软删除标记；身份不可复用）；
--   6. `School.generation` + `OpenApiGrant.school_id/school_generation/revoked_at/revoked_reason`
--      （grant 身份绑定与同 code 重建不继承，见 openApiGrantIdentity.js）；
--   7. `recycle_bin.generation`（public 专用对象；租户侧 no-op，绝不建对象）。
--
-- 幂等性：全部语句可重复执行（IF NOT EXISTS / DROP IF EXISTS + ADD / duplicate_object 守卫）。
-- 分类协议（tenantProvisioner）：`@scope: both`；无 pg_*/information_schema 裸引用；
--   recycle_bin 语句用 to_regclass 守卫（只查当前 schema）并显式登记 @tenant-scoped。

-- 1) AuditLog.user_id：解除级联销毁（可空 + ON DELETE SET NULL）
ALTER TABLE "AuditLog" ALTER COLUMN "user_id" DROP NOT NULL;

-- DROP IF EXISTS + ADD：重复执行幂等；把历史 CASCADE 重建为 SET NULL（同一约束名，逐 schema）
ALTER TABLE "AuditLog" DROP CONSTRAINT IF EXISTS "AuditLog_user_id_fkey";
ALTER TABLE "AuditLog" ADD CONSTRAINT "AuditLog_user_id_fkey"
  FOREIGN KEY ("user_id") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- 2) AuditPrincipal：不可变主体锚点
CREATE TABLE IF NOT EXISTS "AuditPrincipal" (
  "id"               TEXT NOT NULL,
  "kind"             TEXT NOT NULL,               -- system / user
  "scope_key"        TEXT NOT NULL,               -- 当前 schema（current_schema()）；复合唯一的第一维
  "school_code"      TEXT,
  "subject_user_id"  TEXT NOT NULL,               -- 稳定主体 id（人类 = User.id；系统 = 'system'）
  "subject_username" TEXT,
  "created_at"       TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "created_by"       TEXT,
  "origin"           TEXT NOT NULL DEFAULT 'event', -- event / backfilled / system / mapping
  "observed_at"      TIMESTAMP(3),
  CONSTRAINT "AuditPrincipal_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "AuditPrincipal_scope_key_subject_user_id_key"
  ON "AuditPrincipal"("scope_key", "subject_user_id");
CREATE INDEX IF NOT EXISTS "AuditPrincipal_subject_user_id_idx" ON "AuditPrincipal"("subject_user_id");
CREATE INDEX IF NOT EXISTS "AuditPrincipal_school_code_idx" ON "AuditPrincipal"("school_code");
CREATE INDEX IF NOT EXISTS "AuditPrincipal_kind_idx" ON "AuditPrincipal"("kind");

-- 3) AuditLog 主体列（A 期 nullable）+ FK（RESTRICT：主体是审计的锚，不允许级联删除）+ 索引
ALTER TABLE "AuditLog" ADD COLUMN IF NOT EXISTS "principal_id" TEXT;
ALTER TABLE "AuditLog" ADD COLUMN IF NOT EXISTS "actor_snapshot" JSONB;

ALTER TABLE "AuditLog" DROP CONSTRAINT IF EXISTS "AuditLog_principal_id_fkey";
ALTER TABLE "AuditLog" ADD CONSTRAINT "AuditLog_principal_id_fkey"
  FOREIGN KEY ("principal_id") REFERENCES "AuditPrincipal"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

CREATE INDEX IF NOT EXISTS "AuditLog_principal_id_idx" ON "AuditLog"("principal_id");

-- 4) 强门禁：新 INSERT / UPDATE 必带 principal（NOT VALID ⇒ 不校验存量行；G8 断言其状态）
DO $m1_principal_required_new$
BEGIN
  ALTER TABLE "AuditLog"
    ADD CONSTRAINT "AuditLog_principal_id_required_new" CHECK ("principal_id" IS NOT NULL) NOT VALID;
EXCEPTION WHEN duplicate_object THEN NULL;  -- 已存在（含已被 M2 VALIDATE）⇒ 保持原状，不重建
END
$m1_principal_required_new$;

-- 5) 系统主体播种（每 scope 恰 1 行；id 确定性 = system-principal:<schema>；P-4 专用，不得承载带快照的人类事件）
INSERT INTO "AuditPrincipal" ("id", "kind", "scope_key", "school_code", "subject_user_id", "subject_username", "origin", "observed_at")
SELECT 'system-principal:' || current_schema(), 'system', current_schema(), NULL, 'system', 'system', 'system', now()
WHERE NOT EXISTS (SELECT 1 FROM "AuditPrincipal" WHERE "kind" = 'system');

-- 6) User 软删除标记（身份不可复用：软删账号不得复活/重建同名继承）
ALTER TABLE "User" ADD COLUMN IF NOT EXISTS "deleted_at" TIMESTAMP(3);
ALTER TABLE "User" ADD COLUMN IF NOT EXISTS "deleted_by" TEXT;

-- 7) 学校世代（硬删/重建 ⇒ generation 单调递增）与 grant 身份列
ALTER TABLE "School" ADD COLUMN IF NOT EXISTS "generation" INTEGER NOT NULL DEFAULT 1;
ALTER TABLE "OpenApiGrant" ADD COLUMN IF NOT EXISTS "school_id" TEXT;
ALTER TABLE "OpenApiGrant" ADD COLUMN IF NOT EXISTS "school_generation" INTEGER;
ALTER TABLE "OpenApiGrant" ADD COLUMN IF NOT EXISTS "revoked_at" TIMESTAMP(3);
ALTER TABLE "OpenApiGrant" ADD COLUMN IF NOT EXISTS "revoked_reason" TEXT;
CREATE INDEX IF NOT EXISTS "OpenApiGrant_school_id_idx" ON "OpenApiGrant"("school_id");

-- 8) recycle_bin.generation（public 专用对象；租户侧不存在 → no-op，不创建任何对象）
-- @tenant-scoped: to_regclass 仅查当前 schema；recycle_bin 属 PUBLIC_INFRA_TABLES（仅 public），租户侧 no-op
DO $m1_recycle_bin_generation$
BEGIN
  IF to_regclass('"recycle_bin"') IS NOT NULL THEN
    ALTER TABLE "recycle_bin" ADD COLUMN IF NOT EXISTS "generation" INTEGER NOT NULL DEFAULT 1;
  END IF;
END
$m1_recycle_bin_generation$;
