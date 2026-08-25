-- TR-Rewrite: 浏览器测试模块重构 —— TestCase（用例/问题状态体）+ TestExecution（追加式执行记录）
-- 语义对齐检测业务模型：检测计划/风险上报 → 复检 → 合格 → 结案。
--   TestCase.source = task（后台安排的测试任务，case_key=CASE_DEFS 用例编号）
--                   | issue（测试人员自发反馈，第 1 轮 TestExecution 即反馈本身）
--   当前状态 = 最新一条 TestExecution.result（读取时派生）；收口/修复标记为用例级字段。
-- 旧表 TestResult 为空表（部署时已确认 0 行，无数据迁移），直接删除。
-- 结构由 `prisma migrate diff --from-empty --to-schema-datamodel` 生成，与 Prisma Client 一致。
-- 权威副本位于 public schema；provisionSchool 的租户 db push 产生的冗余空表忽略（与 BackupRun 同模式）。

CREATE TABLE IF NOT EXISTS "TestCase" (
    "id" TEXT NOT NULL,
    "case_key" TEXT NOT NULL,
    "source" TEXT NOT NULL DEFAULT 'task',
    "group" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "guide" TEXT,
    "reported_by" TEXT,
    "reported_at" TIMESTAMP(3),
    "fixed_pending_retest" BOOLEAN NOT NULL DEFAULT false,
    "fixed_note" TEXT,
    "closed" BOOLEAN NOT NULL DEFAULT false,
    "closed_by" TEXT,
    "closed_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "TestCase_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX IF NOT EXISTS "TestCase_case_key_key" ON "TestCase"("case_key");
CREATE INDEX IF NOT EXISTS "TestCase_source_idx" ON "TestCase"("source");
CREATE INDEX IF NOT EXISTS "TestCase_group_idx" ON "TestCase"("group");
CREATE INDEX IF NOT EXISTS "TestCase_closed_fixed_pending_retest_idx" ON "TestCase"("closed", "fixed_pending_retest");

CREATE TABLE IF NOT EXISTS "TestExecution" (
    "id" TEXT NOT NULL,
    "case_id" TEXT NOT NULL,
    "round" INTEGER NOT NULL,
    "result" TEXT NOT NULL,
    "detail" TEXT,
    "evidence" TEXT,
    "tester_name" TEXT NOT NULL,
    "tester_role" TEXT,
    "executed_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "TestExecution_pkey" PRIMARY KEY ("id")
);
CREATE INDEX IF NOT EXISTS "TestExecution_case_id_round_idx" ON "TestExecution"("case_id", "round");
CREATE INDEX IF NOT EXISTS "TestExecution_tester_name_idx" ON "TestExecution"("tester_name");

ALTER TABLE "TestExecution" DROP CONSTRAINT IF EXISTS "TestExecution_case_id_fkey";
DO $$ BEGIN
    ALTER TABLE "TestExecution" ADD CONSTRAINT "TestExecution_case_id_fkey"
        FOREIGN KEY ("case_id") REFERENCES "TestCase"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- 旧表（空表，无数据迁移）删除
DROP TABLE IF EXISTS "TestResult";
