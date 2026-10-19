-- @scope: both
-- Selected v5 integration. Original uploads only; no processed image storage.
CREATE TABLE "ColloidalEntry" (
    "id" TEXT NOT NULL,
    "project_id" TEXT NOT NULL,
    "module_code" TEXT NOT NULL,
    "context" JSONB NOT NULL,
    "created_by" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'open',
    "record_ids" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
    "result_source" TEXT,
    "entry_path" TEXT,
    "adopted_attempt_id" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "completed_at" TIMESTAMP(3),
    CONSTRAINT "ColloidalEntry_pkey" PRIMARY KEY ("id")
);
CREATE TABLE "ColloidalAttempt" (
    "id" TEXT NOT NULL,
    "entry_id" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'uploading',
    "elapsed_seconds" DOUBLE PRECISION,
    "time_source" TEXT NOT NULL,
    "input_mode" TEXT NOT NULL,
    "source" TEXT NOT NULL,
    "photo_name" TEXT,
    "photo_key" TEXT,
    "photo_mime" TEXT,
    "photo_sha256" TEXT,
    "photo_size" INTEGER NOT NULL DEFAULT 0,
    "photo_state" TEXT NOT NULL DEFAULT 'absent',
    "photo_purged_at" TIMESTAMP(3),
    "pipeline" TEXT NOT NULL,
    "core_commit" TEXT NOT NULL,
    "result" JSONB,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "completed_at" TIMESTAMP(3),
    CONSTRAINT "ColloidalAttempt_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "ColloidalAttempt_entry_id_fkey" FOREIGN KEY ("entry_id") REFERENCES "ColloidalEntry"("id") ON DELETE RESTRICT ON UPDATE CASCADE
);
CREATE INDEX "ColloidalEntry_created_by_created_at_idx" ON "ColloidalEntry"("created_by", "created_at");
CREATE INDEX "ColloidalEntry_record_ids_idx" ON "ColloidalEntry" USING GIN ("record_ids");
CREATE INDEX "ColloidalAttempt_entry_id_created_at_idx" ON "ColloidalAttempt"("entry_id", "created_at");
CREATE INDEX "ColloidalAttempt_status_created_at_idx" ON "ColloidalAttempt"("status", "created_at");
CREATE INDEX "ColloidalAttempt_photo_state_created_at_idx" ON "ColloidalAttempt"("photo_state", "created_at");
