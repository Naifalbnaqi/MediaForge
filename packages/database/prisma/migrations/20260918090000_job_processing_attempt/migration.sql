-- Tracks how many times a Job has been moved into QUEUED (first submission counts as
-- 1, each retry increments it again). NOT NULL with a default is safe regardless of
-- existing rows: no application code writes to Job.status transitions beyond what
-- already exists, and the default backfills any pre-existing row to 0 (meaning
-- "never queued yet"), which is accurate for every row that predates this migration.
ALTER TABLE "Job" ADD COLUMN "processingAttempt" INTEGER NOT NULL DEFAULT 0;
