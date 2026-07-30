-- M2（窗口2）：新增用户表 must_change_password 字段（默认/临时密码账号首登强制改密标记）
-- 幂等写法，可安全重复执行。
-- 注意：本 SQL 仅作用于当前 search_path 指向的 schema（public 或某租户 schema）。
-- 多租户环境请优先使用 `npm run db:sync`（prisma db push 逐 schema 推送），
-- 它会把该字段同步到所有租户 schema（含控制台 UI 动态新建的学校）。
ALTER TABLE "User" ADD COLUMN IF NOT EXISTS "must_change_password" BOOLEAN NOT NULL DEFAULT false;
