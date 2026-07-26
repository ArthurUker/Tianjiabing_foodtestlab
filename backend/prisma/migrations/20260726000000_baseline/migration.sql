-- =========================================================================
-- 基线迁移（RK46）— 由 `prisma migrate diff --from-empty --to-schema-datamodel`
-- 从当前 schema.prisma 生成，代表切换到 prisma migrate 前的既有 public 表结构。
--
-- 已有生产库（此前用 `prisma db push` 建表）接入 migrate 的方式：
--   npx prisma migrate resolve --applied 20260726000000_baseline
-- 该命令仅在 _prisma_migrations 表登记本基线为“已应用”，不会重复建表。
-- 之后新增变更用 `prisma migrate dev`（本地）/`prisma migrate deploy`（生产）产出可回滚迁移。
--
-- ⚠️ 租户 schema（school_<code>）仍由 lib/tenantProvisioner.js 的
--    `prisma db push ?schema=<租户>` 推表，本基线只针对 datasource 默认 schema（public），
--    不影响既有 provisionSchool 推租户流程。
-- =========================================================================

-- CreateTable
CREATE TABLE "User" (
    "id" TEXT NOT NULL,
    "username" TEXT NOT NULL,
    "email" TEXT,
    "password_hash" TEXT NOT NULL,
    "full_name" TEXT,
    "phone" TEXT,
    "role" TEXT NOT NULL DEFAULT 'user',
    "status" TEXT NOT NULL DEFAULT 'active',
    "school_code" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,
    "last_login" TIMESTAMP(3),

    CONSTRAINT "User_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AuditLog" (
    "id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "action" TEXT NOT NULL,
    "resource_type" TEXT,
    "resource_id" TEXT,
    "details" TEXT,
    "ip_address" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AuditLog_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "TestRecord" (
    "id" TEXT NOT NULL,
    "record_code" TEXT NOT NULL,
    "test_type" TEXT NOT NULL,
    "test_name" TEXT NOT NULL,
    "sample_info" TEXT NOT NULL DEFAULT '{}',
    "result_data" TEXT NOT NULL DEFAULT '{}',
    "status" TEXT NOT NULL DEFAULT 'pending',
    "created_by" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,
    "version" INTEGER NOT NULL DEFAULT 0,
    "data_version" INTEGER NOT NULL DEFAULT 1,
    "completed_at" TIMESTAMP(3),

    CONSTRAINT "TestRecord_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "TestItem" (
    "id" TEXT NOT NULL,
    "test_record_id" TEXT NOT NULL,
    "item_name" TEXT NOT NULL,
    "item_code" TEXT,
    "result" TEXT,
    "notes" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "TestItem_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Attachment" (
    "id" TEXT NOT NULL,
    "test_record_id" TEXT,
    "file_name" TEXT NOT NULL,
    "file_path" TEXT NOT NULL,
    "file_size" INTEGER,
    "file_type" TEXT,
    "uploaded_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Attachment_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Guest" (
    "id" TEXT NOT NULL,
    "username" TEXT NOT NULL,
    "email" TEXT,
    "password_hash" TEXT NOT NULL,
    "full_name" TEXT,
    "created_by" TEXT,
    "guest_type" TEXT NOT NULL DEFAULT 'viewer',
    "has_export_permission" BOOLEAN NOT NULL DEFAULT false,
    "valid_until" TIMESTAMP(3),
    "status" TEXT NOT NULL DEFAULT 'active',
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Guest_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "GuestExportRequest" (
    "id" TEXT NOT NULL,
    "guest_id" TEXT NOT NULL,
    "request_type" TEXT NOT NULL,
    "request_reason" TEXT,
    "request_data" TEXT,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "reviewed_by" TEXT,
    "reviewed_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "GuestExportRequest_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Backup" (
    "id" TEXT NOT NULL,
    "backup_name" TEXT NOT NULL,
    "backup_path" TEXT NOT NULL,
    "backup_size" INTEGER,
    "record_count" INTEGER NOT NULL DEFAULT 0,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "created_by" TEXT,
    "notes" TEXT,

    CONSTRAINT "Backup_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Session" (
    "id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "session_token" TEXT,
    "device_type" TEXT,
    "browser" TEXT,
    "user_agent" TEXT,
    "ip_address" TEXT,
    "status" TEXT NOT NULL DEFAULT 'active',
    "login_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "last_seen_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Session_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SystemLog" (
    "id" TEXT NOT NULL,
    "level" TEXT NOT NULL,
    "message" TEXT NOT NULL,
    "context" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "SystemLog_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "School" (
    "id" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "short_name" TEXT,
    "theme_color" TEXT,
    "logo_url" TEXT,
    "status" TEXT NOT NULL DEFAULT 'active',
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "School_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SchoolCustomization" (
    "id" TEXT NOT NULL,
    "school_code" TEXT NOT NULL,
    "visible_types" TEXT,
    "field_labels" TEXT,
    "hidden_fields" TEXT,
    "theme_config" TEXT,
    "field_rules" TEXT,
    "field_options" TEXT,
    "field_order" TEXT,
    "custom_fields" TEXT,
    "test_types" TEXT,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "SchoolCustomization_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "User_username_key" ON "User"("username");

-- CreateIndex
CREATE UNIQUE INDEX "User_email_key" ON "User"("email");

-- CreateIndex
CREATE INDEX "AuditLog_user_id_idx" ON "AuditLog"("user_id");

-- CreateIndex
CREATE INDEX "AuditLog_created_at_idx" ON "AuditLog"("created_at");

-- CreateIndex
CREATE UNIQUE INDEX "TestRecord_record_code_key" ON "TestRecord"("record_code");

-- CreateIndex
CREATE INDEX "TestRecord_test_type_idx" ON "TestRecord"("test_type");

-- CreateIndex
CREATE INDEX "TestRecord_status_idx" ON "TestRecord"("status");

-- CreateIndex
CREATE INDEX "TestRecord_created_by_idx" ON "TestRecord"("created_by");

-- CreateIndex
CREATE INDEX "TestRecord_created_at_idx" ON "TestRecord"("created_at");

-- CreateIndex
CREATE INDEX "TestRecord_test_type_created_at_idx" ON "TestRecord"("test_type", "created_at");

-- CreateIndex
CREATE INDEX "TestItem_test_record_id_idx" ON "TestItem"("test_record_id");

-- CreateIndex
CREATE INDEX "Attachment_test_record_id_idx" ON "Attachment"("test_record_id");

-- CreateIndex
CREATE UNIQUE INDEX "Guest_username_key" ON "Guest"("username");

-- CreateIndex
CREATE INDEX "Guest_created_by_idx" ON "Guest"("created_by");

-- CreateIndex
CREATE INDEX "Guest_guest_type_idx" ON "Guest"("guest_type");

-- CreateIndex
CREATE INDEX "GuestExportRequest_guest_id_idx" ON "GuestExportRequest"("guest_id");

-- CreateIndex
CREATE INDEX "GuestExportRequest_status_idx" ON "GuestExportRequest"("status");

-- CreateIndex
CREATE UNIQUE INDEX "Backup_backup_path_key" ON "Backup"("backup_path");

-- CreateIndex
CREATE INDEX "Backup_created_by_idx" ON "Backup"("created_by");

-- CreateIndex
CREATE INDEX "Session_user_id_idx" ON "Session"("user_id");

-- CreateIndex
CREATE INDEX "Session_status_idx" ON "Session"("status");

-- CreateIndex
CREATE INDEX "SystemLog_level_idx" ON "SystemLog"("level");

-- CreateIndex
CREATE INDEX "SystemLog_created_at_idx" ON "SystemLog"("created_at");

-- CreateIndex
CREATE UNIQUE INDEX "School_code_key" ON "School"("code");

-- CreateIndex
CREATE UNIQUE INDEX "SchoolCustomization_school_code_key" ON "SchoolCustomization"("school_code");

-- AddForeignKey
ALTER TABLE "AuditLog" ADD CONSTRAINT "AuditLog_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TestRecord" ADD CONSTRAINT "TestRecord_created_by_fkey" FOREIGN KEY ("created_by") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TestItem" ADD CONSTRAINT "TestItem_test_record_id_fkey" FOREIGN KEY ("test_record_id") REFERENCES "TestRecord"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Attachment" ADD CONSTRAINT "Attachment_test_record_id_fkey" FOREIGN KEY ("test_record_id") REFERENCES "TestRecord"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Guest" ADD CONSTRAINT "Guest_created_by_fkey" FOREIGN KEY ("created_by") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "GuestExportRequest" ADD CONSTRAINT "GuestExportRequest_guest_id_fkey" FOREIGN KEY ("guest_id") REFERENCES "Guest"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Backup" ADD CONSTRAINT "Backup_created_by_fkey" FOREIGN KEY ("created_by") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Session" ADD CONSTRAINT "Session_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SchoolCustomization" ADD CONSTRAINT "SchoolCustomization_school_code_fkey" FOREIGN KEY ("school_code") REFERENCES "School"("code") ON DELETE CASCADE ON UPDATE CASCADE;

