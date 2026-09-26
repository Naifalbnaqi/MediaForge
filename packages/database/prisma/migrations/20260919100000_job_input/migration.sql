-- Phase 7A: additive foundation for multi-input operations (image-to-pdf, Phase
-- 7F). Purely additive — a brand-new table plus one new relation column on Job's
-- child side; no existing table, column, or constraint is altered, dropped, or
-- backfilled. Every existing Job row is completely unaffected: it simply has zero
-- JobInput rows, and every current code path (single-input upload/processing)
-- keeps reading Job.sourceObjectKey/sourceFileName/sourceMimeType/sourceSizeBytes
-- directly, exactly as before. Nothing writes to this table yet.
CREATE TABLE "JobInput" (
  "id" TEXT NOT NULL,
  "jobId" TEXT NOT NULL,
  "objectKey" TEXT NOT NULL,
  "fileName" TEXT NOT NULL,
  "mimeType" TEXT NOT NULL,
  "sizeBytes" BIGINT NOT NULL,
  "order" INTEGER NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "JobInput_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "JobInput_objectKey_key" ON "JobInput"("objectKey");
CREATE UNIQUE INDEX "JobInput_jobId_order_key" ON "JobInput"("jobId", "order");
CREATE INDEX "JobInput_jobId_idx" ON "JobInput"("jobId");

ALTER TABLE "JobInput" ADD CONSTRAINT "JobInput_jobId_fkey" FOREIGN KEY ("jobId") REFERENCES "Job"("id") ON DELETE CASCADE ON UPDATE CASCADE;
