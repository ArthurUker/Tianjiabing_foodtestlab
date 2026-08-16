-- 补记 School.short_name 唯一约束（P1-1 已在 schema.prisma 声明 @@unique([short_name])，
-- 但 baseline 及后续 migration 均遗漏，导致 public 与 schema.prisma 漂移）。
--
-- 现状：
--   - public."School" 已存在 "School_short_name_key" 唯一索引（历史 db push --accept-data-loss 带入），
--     故此处用 IF NOT EXISTS 保证幂等（migrate deploy 仅记录、不重复创建）。
--   - 各租户 schema（school_*）由 tenantSync 的 `prisma db push --accept-data-loss` 对齐，
--     会自动补上该唯一约束（租户 School 表为空表，无重复值风险），无需在本 migration 用 DO 块处理。
--
-- 说明：本 migration 的主要作用是消除「schema.prisma 与 migration 历史」的漂移，
-- 使 `prisma migrate dev` 不再把 short_name 约束报告为未记录的 schema 变更。

CREATE UNIQUE INDEX IF NOT EXISTS "School_short_name_key" ON "School"("short_name");
