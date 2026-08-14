-- 删除历史遗留的 Backup 旧模型（架构优化计划 P0-1 / P2-6）
-- 该表为旧版「浏览器 localStorage + Supabase」架构遗留，全库无代码写入
-- （无 /api/backup 路由；前端 BackupRestore.js 纯 localStorage）。
-- 新备份体系统一使用 BackupRun（P0 备份引擎）。
-- ⚠️ 仅删除 Backup 表及其外键/索引，不涉及其他任何表。

-- DropForeignKey
ALTER TABLE "Backup" DROP CONSTRAINT "Backup_created_by_fkey";

-- DropIndex
DROP INDEX "Backup_backup_path_key";
DROP INDEX "Backup_created_by_idx";

-- DropTable
DROP TABLE "Backup";
