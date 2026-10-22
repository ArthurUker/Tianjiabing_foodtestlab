-- @scope: both
-- Bounded text/numeric recognition receipts; original images stay separate.
ALTER TABLE "ColloidalAttempt" ADD COLUMN "process_log" JSONB NOT NULL DEFAULT '[]';
