-- @scope: both
-- P3-LIFECYCLE-AB-R3 · Release B · M2（enforce）：自足回填 + VALIDATE + SET NOT NULL
--
-- 前置：B1（A 版 schema/client 仍在运行）；004 已先跑（幂等回填 P-1/P-4，P-3 进待人工）。
-- 本文件**自足**：不依赖 004 先行 —— 即使 004 未跑，M2 也会在本事务内完成 P-1/P-4 的批量绑定；
--   P-3（仅 username / 无稳定主体锚点的历史人类行）**一律拒绝**（R9），有残量即 RAISE，租户阻断（fail-closed），
--   人工按 REPAIR_RUNBOOK 提供映射证据（004 --mapping）重放后再次对齐。
--
-- 幂等：全部语句可重复执行；VALIDATE/SET NOT NULL 重复执行安全。
-- 分类协议：`@scope: both`；本文件无 pg_*/information_schema 裸引用（表达式仅用内建函数与当前 schema 相对对象）。
--
-- R14-2 版本说明（本文件为**未发布本地链**，修订合法）：
--   依据：R5 开工固定时两处新 migration 均 **untracked/未提交**（`git log -- <chain>` 空、HEAD 停留
--   2026-09-24），仓库内无任何共享/生产 `migrate deploy` 记录，`deploy.sh` 未接入也未执行；
--   本会话对 16 文件链的全部应用均指向 scratch 隔离实例（已全部 down/销毁）。
--   ⇒ 旧 checksum 未进入共享/生产。历史 checksum 分列：R4 `3b214ee8346c79d6…` → R5 本版见
--   `evidence/P3-LIFECYCLE-AB-R5/logs/chain-16-files.log`（逐文件 sha/bytes + 产品链摘要）。
--   若未来在**已应用旧版 M2** 的环境遇到 checksum 不符：按 MIGRATION_FAILURE_RUNBOOK 人工核实，
--   **不得**静默 resolve、**不得**假设"在失败的 M2 之后追加一条 migration"能修复（M2 先失败即阻断）。

-- 1) 系统主体（每 scope 恰 1 行；与 M1/写门面同一确定性 id）
INSERT INTO "AuditPrincipal" ("id", "kind", "scope_key", "school_code", "subject_user_id", "subject_username", "origin", "observed_at")
SELECT 'system-principal:' || current_schema(), 'system', current_schema(), NULL, 'system', 'system', 'system', now()
WHERE NOT EXISTS (SELECT 1 FROM "AuditPrincipal" WHERE "kind" = 'system');

-- 2) P-1（user_id 路径）：为仍 NULL 的审计行的 user_id 建档主体
--    user_id 由 FK 保证指向真实 User 行（稳定主体 id），无需形态猜测。
INSERT INTO "AuditPrincipal" ("id", "kind", "scope_key", "subject_user_id", "subject_username", "origin", "observed_at")
SELECT DISTINCT 'principal:m2:' || substr(md5(current_schema() || '/' || a."user_id"), 1, 24),
       'user', current_schema(), a."user_id",
       (SELECT u."username" FROM "User" u WHERE u."id" = a."user_id" LIMIT 1),
       'backfilled', now()
FROM "AuditLog" a
WHERE a."principal_id" IS NULL AND a."user_id" IS NOT NULL
ON CONFLICT ("scope_key", "subject_user_id") DO NOTHING;

-- 绑定同时补主体快照（provenance）：G3④ 要求"人类主体行必须有主体快照锚点"，
-- 且历史行 user_id 未来可能被 FK SET NULL —— 快照是后续可证明性的唯一留存。
UPDATE "AuditLog" a
   SET "principal_id" = p."id",
       "actor_snapshot" = COALESCE(a."actor_snapshot", jsonb_build_object(
         'source', 'm2_backfill', 'observed_at', now(), 'subject_user_id', a."user_id"))
  FROM "AuditPrincipal" p
 WHERE a."principal_id" IS NULL AND a."user_id" IS NOT NULL
   AND p."scope_key" = current_schema()
   AND p."subject_user_id" = a."user_id"
;

-- 3) P-1b（快照稳定 id 路径）：快照含合法 subject_user_id 的历史行（仅接受无空白/控制字符、长度 ≤191）
INSERT INTO "AuditPrincipal" ("id", "kind", "scope_key", "subject_user_id", "origin", "observed_at")
SELECT DISTINCT 'principal:m2s:' || substr(md5(current_schema() || '/' || x.subj), 1, 24),
       'user', current_schema(), x.subj, 'backfilled', now()
FROM (
  SELECT DISTINCT a."actor_snapshot"->>'subject_user_id' AS subj
    FROM "AuditLog" a
   WHERE a."principal_id" IS NULL
     AND a."user_id" IS NULL
     AND a."actor_snapshot"->>'subject_user_id' IS NOT NULL
     AND a."actor_snapshot"->>'subject_user_id' ~ '^[^[:space:][:cntrl:]]{1,191}$'
) x
ON CONFLICT ("scope_key", "subject_user_id") DO NOTHING;

UPDATE "AuditLog" a
   SET "principal_id" = p."id"
  FROM "AuditPrincipal" p
 WHERE a."principal_id" IS NULL AND a."user_id" IS NULL
   AND a."actor_snapshot"->>'subject_user_id' IS NOT NULL
   AND a."actor_snapshot"->>'subject_user_id' ~ '^[^[:space:][:cntrl:]]{1,191}$'
   AND p."scope_key" = current_schema()
   AND p."subject_user_id" = a."actor_snapshot"->>'subject_user_id'
;

-- 4) P-4（系统事件路径）：**无主体且语义空快照**才绑系统主体（三个 AND 缺一不可；G3③/G3④ 双向护栏由 006 门禁断言）
-- R14-2：语义空快照 := SQL NULL / JSONB null / 空对象 —— 与 006 G3③/G3④ 及本文件 4.5 节**同一谓词**；
--   修正前仅 `IS NULL`，会使 `'null'::jsonb` / `'{}'::jsonb` 的历史系统行在"未先跑 004"的
--   单次 staging align 上留残量、把自足 M2 误判为失败。
UPDATE "AuditLog"
   SET "principal_id" = 'system-principal:' || current_schema()
 WHERE "principal_id" IS NULL
   AND "user_id" IS NULL
   AND ("actor_snapshot" IS NULL OR "actor_snapshot" IN ('null'::jsonb, '{}'::jsonb))
;

-- 4.5) 主体快照补齐（provenance 修复）：已绑定人类主体但快照**语义空**的行（SQL NULL / JSONB null / 空对象，
--      R13-3 统一口径）⇒ 以主体锚点补齐。系统主体行**保持语义空**（G3③ 系统行不得携带人类证据）。
UPDATE "AuditLog" a
   SET "actor_snapshot" = jsonb_build_object(
         'source', 'm2_backfill', 'observed_at', now(), 'subject_user_id', p."subject_user_id")
  FROM "AuditPrincipal" p
 WHERE a."principal_id" = p."id" AND p."kind" = 'user'
   AND (a."actor_snapshot" IS NULL OR a."actor_snapshot" IN ('null'::jsonb, '{}'::jsonb))
;

-- 5) 残量检查：仍有未绑定行（P-3：仅 username / 非法主体形态 / 无证据）⇒ M2 fail-closed（租户阻断）
DO $m2_residual_guard$
DECLARE
  residual int;
  sample text;
BEGIN
  SELECT count(*), min(id) INTO residual, sample
    FROM "AuditLog" WHERE "principal_id" IS NULL;
  IF residual > 0 THEN
    RAISE EXCEPTION 'M2_UNBOUND_PRINCIPAL_ROWS: % rows remain unbound in schema % (sample id=%). 处置：004 待人工清单 + --mapping 证据重放后重新对齐（R9：username-only 不自动映射）。',
      residual, current_schema(), sample;
  END IF;
END
$m2_residual_guard$;

-- 6) VALIDATE + SET NOT NULL（B 版 required 契约；重复执行安全）
ALTER TABLE "AuditLog" VALIDATE CONSTRAINT "AuditLog_principal_id_required_new";
ALTER TABLE "AuditLog" ALTER COLUMN "principal_id" SET NOT NULL;
