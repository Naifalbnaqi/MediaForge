-- Add UPLOADED state to JobStatus: represents a source file confirmed stored in
-- object storage with no processing operation requested yet. Inserted after PENDING
-- to keep the enum's logical lifecycle ordering intact.
ALTER TYPE "JobStatus" ADD VALUE 'UPLOADED' AFTER 'PENDING';

-- Allow Job rows to represent a raw upload with no operation chosen yet.
-- NULL now means "no processing operation requested/started" (i.e. this row is
-- currently just an uploaded source file, not a processing job).
ALTER TABLE "Job" ALTER COLUMN "operation" DROP NOT NULL;

-- Persist the source file's declared size at upload-initiation time, so "My Files"
-- can display it without deriving it later. NOT NULL with no default: every Job row
-- (upload-only today, processing request in Phase 5+) always knows its source size
-- at creation time, and the Job table has zero existing rows in any real deployment
-- (no application code writes to it yet), so this cannot violate existing data.
ALTER TABLE "Job" ADD COLUMN "sourceSizeBytes" BIGINT NOT NULL;
