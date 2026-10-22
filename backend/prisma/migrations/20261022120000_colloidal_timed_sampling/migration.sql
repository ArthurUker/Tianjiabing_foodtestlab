-- @scope: both
-- One physical card, three original camera samples; no processed images.
ALTER TABLE "ColloidalEntry" ADD COLUMN "sampling" JSONB;
ALTER TABLE "ColloidalAttempt" ADD COLUMN "sample_index" INTEGER, ADD COLUMN "captured_at" TIMESTAMP(3);
CREATE UNIQUE INDEX "ColloidalAttempt_entry_id_sample_index_key" ON "ColloidalAttempt"("entry_id", "sample_index");
ALTER TABLE "ColloidalAttempt" ADD CONSTRAINT "ColloidalAttempt_sample_index_check" CHECK ("sample_index" IS NULL OR "sample_index" BETWEEN 1 AND 3);
