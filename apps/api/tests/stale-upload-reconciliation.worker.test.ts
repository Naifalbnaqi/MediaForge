import { describe, expect, it } from 'vitest';
import {
  reconcileStaleUploads,
  STALE_UPLOAD_ERROR_CODE,
  type StaleUploadTimingConfig,
} from '../src/workers/stale-upload-reconciliation.worker.js';
import type { JobsRepository } from '../src/domain/jobs/jobs.repository.js';
import {
  USER_CANCELLED_CLEANED_ERROR_CODE,
  USER_CANCELLED_ERROR_CODE,
  type CreateJobData,
  type DeletedJob,
  type JobRecord,
} from '../src/domain/jobs/jobs.types.js';
import type { ObjectStorageService } from '../src/services/storage.service.js';

const TTL_SECONDS = 900;
const GRACE_SECONDS = 300;
const TIMING: StaleUploadTimingConfig = {
  uploadUrlTtlSeconds: TTL_SECONDS,
  pendingUploadGraceSeconds: GRACE_SECONDS,
};
const NOW = new Date('2026-01-01T01:00:00.000Z');
/** The one, effective safe cutoff every candidate query is gated on: `createdAt +
 * TTL + grace <= now`. Mirrors `computeSafeCutoff` in the module under test. */
const SAFE_CUTOFF_MS = (TTL_SECONDS + GRACE_SECONDS) * 1000;

/** Well inside the raw TTL — definitely fresh, not even close to eligible. */
const FRESH_CREATED_AT = new Date(NOW.getTime() - (TTL_SECONDS - 60) * 1000);
/** Past the raw TTL, but still inside the grace window — a PUT accepted just
 * before the TTL boundary could still legitimately be landing bytes right now.
 * Must be treated exactly like "fresh": untouched, not even queried. */
const PAST_TTL_STILL_IN_GRACE_CREATED_AT = new Date(NOW.getTime() - (TTL_SECONDS * 1000 + 60 * 1000));
/** One second past the full TTL + grace cutoff — definitely eligible. */
const PAST_SAFE_CUTOFF_CREATED_AT = new Date(NOW.getTime() - (SAFE_CUTOFF_MS + 1000));

function makeJob(overrides: Partial<JobRecord>): JobRecord {
  return {
    id: 'job-1',
    status: 'PENDING',
    sourceObjectKey: 'uploads/user-1/placeholder.mp4',
    sourceFileName: 'video.mp4',
    sourceMimeType: 'video/mp4',
    sourceSizeBytes: 100n,
    operation: null,
    options: {},
    progress: 0,
    processingAttempt: 0,
    errorCode: null,
    errorMessage: null,
    startedAt: null,
    completedAt: null,
    userId: 'user-1',
    createdAt: PAST_SAFE_CUTOFF_CREATED_AT,
    ...overrides,
  };
}

/**
 * Mirrors `PrismaJobsRepository`'s real query/conditional-write semantics for every
 * method this worker actually uses — genuine status/errorCode filtering on the two
 * find* queries, and genuine conditional writes on markUploaded/markCancelled/
 * markCancelledStorageCleaned — so the race/idempotency tests below exercise real
 * behavior, not a fake that always agrees with whatever the test expects.
 */
class FakeJobsRepository implements JobsRepository {
  public jobs = new Map<string, JobRecord>();
  public markCancelledCalls: string[] = [];
  public markCancelledStorageCleanedCalls: string[] = [];

  public async create(data: CreateJobData): Promise<JobRecord> {
    const job = makeJob({ ...data, status: 'PENDING' });
    this.jobs.set(job.id, job);
    return job;
  }
  public async markUploaded(id: string): Promise<JobRecord | null> {
    const job = this.jobs.get(id);
    if (!job || job.status !== 'PENDING') return null;
    return this.update(id, { status: 'UPLOADED' });
  }
  public async findById(id: string): Promise<JobRecord | null> {
    return this.jobs.get(id) ?? null;
  }
  public async findManyByUser(userId: string): Promise<JobRecord[]> {
    return [...this.jobs.values()].filter((job) => job.userId === userId);
  }
  public async markQueued(): Promise<JobRecord | null> {
    throw new Error('FakeJobsRepository.markQueued: not used by the stale-upload sweep');
  }
  public async markProcessing(): Promise<JobRecord> {
    throw new Error('FakeJobsRepository.markProcessing: not used by the stale-upload sweep');
  }
  public async markCompleted(): Promise<JobRecord> {
    throw new Error('FakeJobsRepository.markCompleted: not used by the stale-upload sweep');
  }
  public async markFailed(): Promise<JobRecord> {
    throw new Error('FakeJobsRepository.markFailed: not used by the stale-upload sweep');
  }
  public async markRetried(): Promise<JobRecord | null> {
    throw new Error('FakeJobsRepository.markRetried: not used by the stale-upload sweep');
  }

  public async findStalePending(olderThan: Date, limit: number): Promise<JobRecord[]> {
    return [...this.jobs.values()]
      .filter((job) => job.status === 'PENDING' && job.createdAt.getTime() <= olderThan.getTime())
      .sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime())
      .slice(0, limit);
  }

  public async markCancelled(
    id: string,
    errorCode: string,
    errorMessage: string,
  ): Promise<JobRecord | null> {
    this.markCancelledCalls.push(id);
    const job = this.jobs.get(id);
    if (!job || job.status !== 'PENDING') return null;
    return this.update(id, { status: 'CANCELLED', errorCode, errorMessage, completedAt: new Date() });
  }

  public async findCancelledAwaitingStorageCleanup(
    olderThan: Date,
    limit: number,
  ): Promise<JobRecord[]> {
    return [...this.jobs.values()]
      .filter(
        (job) =>
          job.status === 'CANCELLED' &&
          job.errorCode === USER_CANCELLED_ERROR_CODE &&
          job.createdAt.getTime() <= olderThan.getTime(),
      )
      .sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime())
      .slice(0, limit);
  }

  public async markCancelledStorageCleaned(id: string): Promise<JobRecord | null> {
    this.markCancelledStorageCleanedCalls.push(id);
    const job = this.jobs.get(id);
    if (!job || job.status !== 'CANCELLED' || job.errorCode !== USER_CANCELLED_ERROR_CODE) return null;
    return this.update(id, { errorCode: USER_CANCELLED_CLEANED_ERROR_CODE });
  }

  public async countActiveByUser(): Promise<number> {
    return 0;
  }

  public async deleteFinished(): Promise<DeletedJob | null> {
    throw new Error('deleteFinished is not exercised by this test file');
  }

  private update(id: string, patch: Partial<JobRecord>): JobRecord {
    const job = this.jobs.get(id);
    if (!job) throw new Error(`no such job: ${id}`);
    const updated = { ...job, ...patch };
    this.jobs.set(id, updated);
    return updated;
  }
}

class FakeStorageService implements ObjectStorageService {
  public headObjectCalls: string[] = [];
  public deleteObjectCalls: string[] = [];
  public headObjectResults = new Map<string, { sizeBytes: number } | null>();

  public async createUploadUrl(): Promise<{ url: string; expiresAt: Date }> {
    throw new Error('FakeStorageService.createUploadUrl: not used by the stale-upload sweep');
  }
  public async createDownloadUrl(): Promise<{ url: string; expiresAt: Date }> {
    throw new Error('FakeStorageService.createDownloadUrl: not used by the stale-upload sweep');
  }
  public async deleteObject(objectKey: string): Promise<void> {
    this.deleteObjectCalls.push(objectKey);
  }
  public async headObject(objectKey: string): Promise<{ sizeBytes: number } | null> {
    this.headObjectCalls.push(objectKey);
    return this.headObjectResults.get(objectKey) ?? null;
  }
  public async downloadToFile(): Promise<void> {
    throw new Error('FakeStorageService.downloadToFile: not used by the stale-upload sweep');
  }
  public async uploadFromFile(): Promise<void> {
    throw new Error('FakeStorageService.uploadFromFile: not used by the stale-upload sweep');
  }
  public async checkAccessible(): Promise<void> {}
}

function build() {
  const jobsRepository = new FakeJobsRepository();
  const storage = new FakeStorageService();
  return { jobsRepository, storage };
}

const EMPTY_RESULT = { completedCount: 0, cancelledCount: 0, cleanedCount: 0, candidateCount: 0 };

describe('reconcileStaleUploads — stale PENDING pass', () => {
  it('leaves a fresh PENDING job (well inside the TTL) completely untouched', async () => {
    const { jobsRepository, storage } = build();
    const job = makeJob({ id: 'fresh-1', createdAt: FRESH_CREATED_AT });
    jobsRepository.jobs.set(job.id, job);

    const result = await reconcileStaleUploads({ jobsRepository, storage }, TIMING, NOW);

    expect(result).toEqual(EMPTY_RESULT);
    expect((await jobsRepository.findById(job.id))?.status).toBe('PENDING');
    expect(jobsRepository.markCancelledCalls).toHaveLength(0);
    expect(storage.headObjectCalls).toHaveLength(0);
    expect(storage.deleteObjectCalls).toHaveLength(0);
  });

  // Requirement 1: TTL expired but still inside grace -> untouched.
  it('leaves a PENDING job past the raw TTL but still inside the grace period completely untouched (no cancel, no storage access)', async () => {
    const { jobsRepository, storage } = build();
    const job = makeJob({ id: 'in-grace', createdAt: PAST_TTL_STILL_IN_GRACE_CREATED_AT });
    jobsRepository.jobs.set(job.id, job);
    // Even if an object genuinely exists — a PUT could still be landing it right
    // now — this must never be checked before the full cutoff has passed.
    storage.headObjectResults.set(job.sourceObjectKey, { sizeBytes: 100 });

    const result = await reconcileStaleUploads({ jobsRepository, storage }, TIMING, NOW);

    expect(result).toEqual(EMPTY_RESULT);
    expect((await jobsRepository.findById(job.id))?.status).toBe('PENDING');
    expect(jobsRepository.markCancelledCalls).toHaveLength(0);
    expect(storage.headObjectCalls).toHaveLength(0);
    expect(storage.deleteObjectCalls).toHaveLength(0);
  });

  // Requirement 2: TTL+grace expired -> eligible.
  it('treats a PENDING job past the full TTL + grace cutoff as an eligible candidate', async () => {
    const { jobsRepository, storage } = build();
    const job = makeJob({ id: 'past-cutoff', createdAt: PAST_SAFE_CUTOFF_CREATED_AT });
    jobsRepository.jobs.set(job.id, job);
    storage.headObjectResults.set(job.sourceObjectKey, null);

    const result = await reconcileStaleUploads({ jobsRepository, storage }, TIMING, NOW);

    expect(result.candidateCount).toBe(1);
    // It was genuinely considered (storage was consulted at least once) — the exact
    // call count isn't the point here; the missing-object -> CANCELLED behavior
    // itself is covered by a dedicated test below.
    expect(storage.headObjectCalls).toContain(job.sourceObjectKey);
  });

  // Requirement 3: matching object after grace -> UPLOADED.
  it('reconciles a job past the full cutoff straight to UPLOADED when a matching object already exists, instead of cancelling it', async () => {
    const { jobsRepository, storage } = build();
    // The browser's PUT actually succeeded; only the /complete confirmation call
    // never arrived (closed tab, dropped connection right after the PUT finished).
    const job = makeJob({
      id: 'self-heal-1',
      sourceObjectKey: 'uploads/user-1/self-heal-1.mp4',
      sourceSizeBytes: 250n,
    });
    jobsRepository.jobs.set(job.id, job);
    storage.headObjectResults.set(job.sourceObjectKey, { sizeBytes: 250 });

    const result = await reconcileStaleUploads({ jobsRepository, storage }, TIMING, NOW);

    expect(result).toEqual({ completedCount: 1, cancelledCount: 0, cleanedCount: 0, candidateCount: 1 });
    const updated = await jobsRepository.findById(job.id);
    expect(updated?.status).toBe('UPLOADED');
    // Never cancelled, so never deleted either — this is a real upload, not litter.
    expect(jobsRepository.markCancelledCalls).toHaveLength(0);
    expect(storage.deleteObjectCalls).toHaveLength(0);
  });

  it('cancels and deletes a job past the full cutoff whose object size does not match what was declared (partial/corrupt upload)', async () => {
    const { jobsRepository, storage } = build();
    const job = makeJob({
      id: 'mismatch-1',
      sourceObjectKey: 'uploads/user-1/mismatch-1.mp4',
      sourceSizeBytes: 250n,
    });
    jobsRepository.jobs.set(job.id, job);
    storage.headObjectResults.set(job.sourceObjectKey, { sizeBytes: 10 });

    const result = await reconcileStaleUploads({ jobsRepository, storage }, TIMING, NOW);

    expect(result).toEqual({ completedCount: 0, cancelledCount: 1, cleanedCount: 0, candidateCount: 1 });
    const updated = await jobsRepository.findById(job.id);
    expect(updated?.status).toBe('CANCELLED');
    expect(updated?.errorCode).toBe(STALE_UPLOAD_ERROR_CODE);
    expect(storage.deleteObjectCalls).toEqual([job.sourceObjectKey]);
  });

  // Requirement 4: missing object after grace -> CANCELLED.
  it('cancels a job past the full cutoff with nothing in storage, without attempting to delete anything', async () => {
    const { jobsRepository, storage } = build();
    const job = makeJob({ id: 'stale-2', sourceObjectKey: 'uploads/user-1/stale-2.mp4' });
    jobsRepository.jobs.set(job.id, job);
    storage.headObjectResults.set(job.sourceObjectKey, null);

    const result = await reconcileStaleUploads({ jobsRepository, storage }, TIMING, NOW);

    expect(result.cancelledCount).toBe(1);
    expect(result.completedCount).toBe(0);
    const updated = await jobsRepository.findById(job.id);
    expect(updated?.status).toBe('CANCELLED');
    expect(storage.deleteObjectCalls).toHaveLength(0);
  });

  it.each(['UPLOADED', 'QUEUED', 'PROCESSING', 'COMPLETED', 'FAILED', 'CANCELLED'] as const)(
    'never touches an old job that is already %s, even though it is old enough to look stale',
    async (status) => {
      const { jobsRepository, storage } = build();
      const job = makeJob({ id: 'old-but-resolved', status, createdAt: PAST_SAFE_CUTOFF_CREATED_AT });
      jobsRepository.jobs.set(job.id, job);

      const result = await reconcileStaleUploads({ jobsRepository, storage }, TIMING, NOW);

      // findStalePending itself filters on status: PENDING, so a job in any other
      // status is never even a candidate for this pass — the primary guard, not
      // just the conditional write. (A synthetic CANCELLED-with-no-errorCode job
      // here also never qualifies for the deferred-cleanup pass below, since that
      // requires errorCode === USER_CANCELLED specifically.)
      expect(result).toEqual(EMPTY_RESULT);
      expect((await jobsRepository.findById(job.id))?.status).toBe(status);
      expect(jobsRepository.markCancelledCalls).toHaveLength(0);
      expect(storage.headObjectCalls).toHaveLength(0);
      expect(storage.deleteObjectCalls).toHaveLength(0);
    },
  );

  it('is race-safe against a concurrent completion: a job that flips to UPLOADED between the query and the write is left alone', async () => {
    const { jobsRepository } = build();
    const job = makeJob({ id: 'racing-job', sourceObjectKey: 'uploads/user-1/racing-job.mp4' });
    jobsRepository.jobs.set(job.id, job);

    // Simulates the exact race in the milestone: the browser's own upload finished
    // and /complete won, transitioning the row to UPLOADED, in the gap between
    // findStalePending's read and markCancelled's write. The real implementation
    // can't be paused mid-call from a test, so this asserts the same guarantee at
    // the unit the race actually resolves in: markCancelled's conditional WHERE
    // clause refuses to act on a row that is no longer PENDING.
    await jobsRepository.markUploaded(job.id);

    const cancelled = await jobsRepository.markCancelled(job.id, 'UPLOAD_EXPIRED', 'stale');

    expect(cancelled).toBeNull();
    expect((await jobsRepository.findById(job.id))?.status).toBe('UPLOADED');
  });

  it('two concurrent sweeps over the same size-mismatched candidate: only one cancels and deletes storage, the other is a no-op', async () => {
    const { jobsRepository, storage } = build();
    const job = makeJob({
      id: 'contested',
      sourceObjectKey: 'uploads/user-1/contested.mp4',
      sourceSizeBytes: 250n,
    });
    jobsRepository.jobs.set(job.id, job);
    storage.headObjectResults.set(job.sourceObjectKey, { sizeBytes: 10 });

    const [first, second] = await Promise.all([
      reconcileStaleUploads({ jobsRepository, storage }, TIMING, NOW),
      reconcileStaleUploads({ jobsRepository, storage }, TIMING, NOW),
    ]);

    // Both sweeps see the same single candidate (findStalePending is a read), but
    // markCancelled's conditional write means only one of them actually wins.
    expect(first.candidateCount).toBe(1);
    expect(second.candidateCount).toBe(1);
    expect(first.cancelledCount + second.cancelledCount).toBe(1);
    expect((await jobsRepository.findById(job.id))?.status).toBe('CANCELLED');
    // Storage is only ever cleaned up once, by whichever sweep actually won.
    expect(storage.deleteObjectCalls).toEqual([job.sourceObjectKey]);
  });

  it('two concurrent sweeps over the same self-healable candidate: only one reconciles it to UPLOADED', async () => {
    const { jobsRepository, storage } = build();
    const job = makeJob({
      id: 'contested-heal',
      sourceObjectKey: 'uploads/user-1/contested-heal.mp4',
      sourceSizeBytes: 250n,
    });
    jobsRepository.jobs.set(job.id, job);
    storage.headObjectResults.set(job.sourceObjectKey, { sizeBytes: 250 });

    const [first, second] = await Promise.all([
      reconcileStaleUploads({ jobsRepository, storage }, TIMING, NOW),
      reconcileStaleUploads({ jobsRepository, storage }, TIMING, NOW),
    ]);

    expect(first.completedCount + second.completedCount).toBe(1);
    expect((await jobsRepository.findById(job.id))?.status).toBe('UPLOADED');
    expect(storage.deleteObjectCalls).toHaveLength(0);
  });

  it('running the sweep again after a job was already cancelled finds nothing left to do in this pass (idempotent across repeated ticks)', async () => {
    const { jobsRepository, storage } = build();
    const job = makeJob({
      id: 'already-done',
      sourceObjectKey: 'uploads/user-1/already-done.mp4',
      sourceSizeBytes: 250n,
    });
    jobsRepository.jobs.set(job.id, job);
    storage.headObjectResults.set(job.sourceObjectKey, { sizeBytes: 10 });

    const firstRun = await reconcileStaleUploads({ jobsRepository, storage }, TIMING, NOW);
    const secondRun = await reconcileStaleUploads({ jobsRepository, storage }, TIMING, NOW);

    expect(firstRun).toEqual({ completedCount: 0, cancelledCount: 1, cleanedCount: 0, candidateCount: 1 });
    expect(secondRun).toEqual(EMPTY_RESULT);
    expect(storage.deleteObjectCalls).toEqual([job.sourceObjectKey]);
  });

  it('processes multiple eligible candidates in one tick, up to the batch size', async () => {
    const { jobsRepository, storage } = build();
    for (const id of ['stale-a', 'stale-b', 'stale-c']) {
      const job = makeJob({ id, sourceObjectKey: `uploads/user-1/${id}.mp4` });
      jobsRepository.jobs.set(job.id, job);
      storage.headObjectResults.set(job.sourceObjectKey, null);
    }

    const result = await reconcileStaleUploads({ jobsRepository, storage }, TIMING, NOW, 100);

    expect(result).toEqual({ completedCount: 0, cancelledCount: 3, cleanedCount: 0, candidateCount: 3 });
    for (const id of ['stale-a', 'stale-b', 'stale-c']) {
      expect((await jobsRepository.findById(id))?.status).toBe('CANCELLED');
    }
  });

  it('respects the batch size limit, leaving the remainder for a later tick', async () => {
    const { jobsRepository, storage } = build();
    for (const id of ['stale-a', 'stale-b', 'stale-c']) {
      const job = makeJob({ id, sourceObjectKey: `uploads/user-1/${id}.mp4` });
      jobsRepository.jobs.set(job.id, job);
      storage.headObjectResults.set(job.sourceObjectKey, null);
    }

    const result = await reconcileStaleUploads({ jobsRepository, storage }, TIMING, NOW, 2);

    expect(result.cancelledCount).toBe(2);
    expect(result.candidateCount).toBe(2);
    const statuses = ['stale-a', 'stale-b', 'stale-c'].map(
      async (id) => (await jobsRepository.findById(id))?.status,
    );
    expect((await Promise.all(statuses)).filter((status) => status === 'PENDING')).toHaveLength(1);
  });
});

describe('reconcileStaleUploads — deferred cleanup of manually-cancelled uploads', () => {
  // Requirement 5: manually cancelled object not deleted before cutoff.
  it('does not clean up a manually-cancelled job until the full TTL + grace cutoff has passed since it was created', async () => {
    const { jobsRepository, storage } = build();
    const job = makeJob({
      id: 'too-soon',
      status: 'CANCELLED',
      errorCode: USER_CANCELLED_ERROR_CODE,
      errorMessage: 'Cancelled by you.',
      sourceObjectKey: 'uploads/user-1/too-soon.mp4',
      createdAt: PAST_TTL_STILL_IN_GRACE_CREATED_AT,
    });
    jobsRepository.jobs.set(job.id, job);
    storage.headObjectResults.set(job.sourceObjectKey, { sizeBytes: 100 });

    const result = await reconcileStaleUploads({ jobsRepository, storage }, TIMING, NOW);

    expect(result.cleanedCount).toBe(0);
    expect(jobsRepository.markCancelledStorageCleanedCalls).toHaveLength(0);
    expect(storage.headObjectCalls).toHaveLength(0);
    expect(storage.deleteObjectCalls).toHaveLength(0);
    expect((await jobsRepository.findById(job.id))?.errorCode).toBe(USER_CANCELLED_ERROR_CODE);
  });

  it('cleans up a manually-cancelled job once the full TTL + grace cutoff has passed, deleting its storage object', async () => {
    const { jobsRepository, storage } = build();
    const job = makeJob({
      id: 'safe-to-clean',
      status: 'CANCELLED',
      errorCode: USER_CANCELLED_ERROR_CODE,
      errorMessage: 'Cancelled by you.',
      sourceObjectKey: 'uploads/user-1/safe-to-clean.mp4',
      createdAt: PAST_SAFE_CUTOFF_CREATED_AT,
    });
    jobsRepository.jobs.set(job.id, job);
    storage.headObjectResults.set(job.sourceObjectKey, { sizeBytes: 100 });

    const result = await reconcileStaleUploads({ jobsRepository, storage }, TIMING, NOW);

    expect(result.cleanedCount).toBe(1);
    expect(storage.deleteObjectCalls).toEqual([job.sourceObjectKey]);
    const updated = await jobsRepository.findById(job.id);
    expect(updated?.status).toBe('CANCELLED');
    expect(updated?.errorCode).toBe(USER_CANCELLED_CLEANED_ERROR_CODE);
    // The user-facing reason is untouched by this purely-internal bookkeeping step.
    expect(updated?.errorMessage).toBe('Cancelled by you.');
  });

  it('claims (and marks cleaned) a manually-cancelled job past the cutoff even with nothing left in storage', async () => {
    const { jobsRepository, storage } = build();
    const job = makeJob({
      id: 'safe-nothing-there',
      status: 'CANCELLED',
      errorCode: USER_CANCELLED_ERROR_CODE,
      sourceObjectKey: 'uploads/user-1/safe-nothing-there.mp4',
      createdAt: PAST_SAFE_CUTOFF_CREATED_AT,
    });
    jobsRepository.jobs.set(job.id, job);
    storage.headObjectResults.set(job.sourceObjectKey, null);

    const result = await reconcileStaleUploads({ jobsRepository, storage }, TIMING, NOW);

    expect(result.cleanedCount).toBe(1);
    expect(storage.deleteObjectCalls).toHaveLength(0);
    expect((await jobsRepository.findById(job.id))?.errorCode).toBe(USER_CANCELLED_CLEANED_ERROR_CODE);
  });

  it('never revisits a sweep-cancelled (UPLOAD_EXPIRED) job in the deferred-cleanup pass, even if old enough', async () => {
    const { jobsRepository, storage } = build();
    const job = makeJob({
      id: 'sweep-cancelled',
      status: 'CANCELLED',
      errorCode: STALE_UPLOAD_ERROR_CODE,
      sourceObjectKey: 'uploads/user-1/sweep-cancelled.mp4',
      createdAt: PAST_SAFE_CUTOFF_CREATED_AT,
    });
    jobsRepository.jobs.set(job.id, job);
    storage.headObjectResults.set(job.sourceObjectKey, { sizeBytes: 100 });

    const result = await reconcileStaleUploads({ jobsRepository, storage }, TIMING, NOW);

    expect(result.cleanedCount).toBe(0);
    expect(storage.headObjectCalls).toHaveLength(0);
    expect(storage.deleteObjectCalls).toHaveLength(0);
  });

  it('never revisits an already-cleaned job (bounded growth: the errorCode marker excludes it going forward)', async () => {
    const { jobsRepository, storage } = build();
    const job = makeJob({
      id: 'already-cleaned',
      status: 'CANCELLED',
      errorCode: USER_CANCELLED_CLEANED_ERROR_CODE,
      sourceObjectKey: 'uploads/user-1/already-cleaned.mp4',
      createdAt: PAST_SAFE_CUTOFF_CREATED_AT,
    });
    jobsRepository.jobs.set(job.id, job);

    const result = await reconcileStaleUploads({ jobsRepository, storage }, TIMING, NOW);

    expect(result).toEqual(EMPTY_RESULT);
    expect(storage.headObjectCalls).toHaveLength(0);
  });

  // Requirement 6: cleanup after cutoff is idempotent.
  it('two concurrent sweeps over the same awaiting-cleanup candidate: only one claims it and deletes storage', async () => {
    const { jobsRepository, storage } = build();
    const job = makeJob({
      id: 'contested-cleanup',
      status: 'CANCELLED',
      errorCode: USER_CANCELLED_ERROR_CODE,
      sourceObjectKey: 'uploads/user-1/contested-cleanup.mp4',
      createdAt: PAST_SAFE_CUTOFF_CREATED_AT,
    });
    jobsRepository.jobs.set(job.id, job);
    storage.headObjectResults.set(job.sourceObjectKey, { sizeBytes: 100 });

    const [first, second] = await Promise.all([
      reconcileStaleUploads({ jobsRepository, storage }, TIMING, NOW),
      reconcileStaleUploads({ jobsRepository, storage }, TIMING, NOW),
    ]);

    expect(first.cleanedCount + second.cleanedCount).toBe(1);
    expect(storage.deleteObjectCalls).toEqual([job.sourceObjectKey]);
    expect((await jobsRepository.findById(job.id))?.errorCode).toBe(USER_CANCELLED_CLEANED_ERROR_CODE);
  });

  it('running the sweep again after cleanup finds nothing left to do (idempotent across repeated ticks)', async () => {
    const { jobsRepository, storage } = build();
    const job = makeJob({
      id: 'cleanup-then-repeat',
      status: 'CANCELLED',
      errorCode: USER_CANCELLED_ERROR_CODE,
      sourceObjectKey: 'uploads/user-1/cleanup-then-repeat.mp4',
      createdAt: PAST_SAFE_CUTOFF_CREATED_AT,
    });
    jobsRepository.jobs.set(job.id, job);
    storage.headObjectResults.set(job.sourceObjectKey, { sizeBytes: 100 });

    const firstRun = await reconcileStaleUploads({ jobsRepository, storage }, TIMING, NOW);
    const secondRun = await reconcileStaleUploads({ jobsRepository, storage }, TIMING, NOW);

    expect(firstRun.cleanedCount).toBe(1);
    expect(secondRun).toEqual(EMPTY_RESULT);
    expect(storage.deleteObjectCalls).toEqual([job.sourceObjectKey]);
  });
});
