import type { Prisma, PrismaClient } from '@media/database';
import type { JobsRepository } from '../../domain/jobs/jobs.repository.js';
import {
  DELETABLE_JOB_STATUSES,
  USER_CANCELLED_CLEANED_ERROR_CODE,
  USER_CANCELLED_ERROR_CODE,
  type CreateJobData,
  type DeletedJob,
  type JobRecord,
} from '../../domain/jobs/jobs.types.js';

const jobSelect = {
  id: true,
  status: true,
  sourceObjectKey: true,
  sourceFileName: true,
  sourceMimeType: true,
  sourceSizeBytes: true,
  operation: true,
  options: true,
  progress: true,
  processingAttempt: true,
  errorCode: true,
  errorMessage: true,
  startedAt: true,
  completedAt: true,
  userId: true,
  createdAt: true,
} as const;

type SelectedJob = Prisma.JobGetPayload<{ select: typeof jobSelect }>;

/** Prisma's `Json` column type-checks as `JsonValue`, not `Record<string, unknown>` —
 * narrow it here in one place rather than scattering casts. `options` is always
 * written as a plain object by this repository (`{}` at create time, `{}` from
 * `markQueued` today), so this narrowing reflects a real invariant, not a lie. */
function toJobRecord(job: SelectedJob): JobRecord {
  return { ...job, options: job.options as Record<string, unknown> };
}

export class PrismaJobsRepository implements JobsRepository {
  public constructor(private readonly database: PrismaClient) {}

  public async create(data: CreateJobData): Promise<JobRecord> {
    const job = await this.database.job.create({
      data: {
        userId: data.userId,
        sourceObjectKey: data.sourceObjectKey,
        sourceFileName: data.sourceFileName,
        sourceMimeType: data.sourceMimeType,
        sourceSizeBytes: data.sourceSizeBytes,
        // No processing operation has been requested yet — this row currently just
        // tracks an in-flight/raw upload (see Job.operation / Job.options in schema.prisma).
        options: {},
      },
      select: jobSelect,
    });
    return toJobRecord(job);
  }

  public async markUploaded(id: string): Promise<JobRecord | null> {
    // Conditional updateMany, same pattern as markQueued/markRetried/markCancelled —
    // see the port doc for the race this closes against stale-upload reconciliation.
    const { count } = await this.database.job.updateMany({
      where: { id, status: 'PENDING' },
      data: { status: 'UPLOADED' },
    });
    if (count === 0) return null;
    return this.findById(id);
  }

  public async findById(id: string): Promise<JobRecord | null> {
    const job = await this.database.job.findUnique({ where: { id }, select: jobSelect });
    return job ? toJobRecord(job) : null;
  }

  public async findManyByUser(userId: string): Promise<JobRecord[]> {
    const jobs = await this.database.job.findMany({
      where: { userId },
      orderBy: { createdAt: 'desc' },
      select: jobSelect,
    });
    return jobs.map(toJobRecord);
  }

  public async markQueued(
    id: string,
    operation: string,
    options: Record<string, unknown>,
  ): Promise<JobRecord | null> {
    // updateMany + a status filter in the WHERE clause makes this conditional on the
    // row's *current* state at write time, not the caller's earlier read — Postgres
    // evaluates and applies this atomically, so of two concurrent callers racing on
    // the same row, only one can ever see count: 1. update() (used elsewhere in this
    // file) has no WHERE beyond id and would blindly overwrite regardless of status.
    const { count } = await this.database.job.updateMany({
      where: { id, status: 'UPLOADED' },
      data: {
        status: 'QUEUED',
        operation,
        options: options as Prisma.InputJsonValue,
        processingAttempt: { increment: 1 },
      },
    });
    if (count === 0) return null;
    // updateMany doesn't return the row itself, only the affected count — but since
    // we just confirmed we're the one who won the conditional write, this read
    // authoritatively reflects it (nothing else transitions UPLOADED->QUEUED).
    return this.findById(id);
  }

  public async markProcessing(id: string): Promise<JobRecord> {
    const job = await this.database.job.update({
      where: { id },
      data: { status: 'PROCESSING', startedAt: new Date() },
      select: jobSelect,
    });
    return toJobRecord(job);
  }

  public async markCompleted(id: string): Promise<JobRecord> {
    const job = await this.database.job.update({
      where: { id },
      data: { status: 'COMPLETED', completedAt: new Date(), progress: 100 },
      select: jobSelect,
    });
    return toJobRecord(job);
  }

  public async markFailed(id: string, errorCode: string, errorMessage: string): Promise<JobRecord> {
    const job = await this.database.job.update({
      where: { id },
      data: { status: 'FAILED', errorCode, errorMessage, completedAt: new Date() },
      select: jobSelect,
    });
    return toJobRecord(job);
  }

  public async markRetried(id: string): Promise<JobRecord | null> {
    // Same conditional-updateMany pattern as markQueued, and for the same reason: two
    // concurrent retry clicks on the same FAILED job must not both succeed.
    // operation/options are deliberately absent from `data` — a retry redoes the same
    // requested operation, it doesn't accept a new one.
    const { count } = await this.database.job.updateMany({
      where: { id, status: 'FAILED' },
      data: {
        status: 'QUEUED',
        errorCode: null,
        errorMessage: null,
        progress: 0,
        completedAt: null,
        processingAttempt: { increment: 1 },
      },
    });
    if (count === 0) return null;
    return this.findById(id);
  }

  public async findStalePending(olderThan: Date, limit: number): Promise<JobRecord[]> {
    const jobs = await this.database.job.findMany({
      where: { status: 'PENDING', createdAt: { lte: olderThan } },
      orderBy: { createdAt: 'asc' },
      take: limit,
      select: jobSelect,
    });
    return jobs.map(toJobRecord);
  }

  public async markCancelled(
    id: string,
    errorCode: string,
    errorMessage: string,
  ): Promise<JobRecord | null> {
    // Same conditional-updateMany pattern as markQueued/markRetried, and for the same
    // reason: this must not cancel a row that a concurrent /complete call (or another
    // racing cleanup pass) already moved out of PENDING.
    const { count } = await this.database.job.updateMany({
      where: { id, status: 'PENDING' },
      data: { status: 'CANCELLED', errorCode, errorMessage, completedAt: new Date() },
    });
    if (count === 0) return null;
    return this.findById(id);
  }

  public async findCancelledAwaitingStorageCleanup(
    olderThan: Date,
    limit: number,
  ): Promise<JobRecord[]> {
    const jobs = await this.database.job.findMany({
      where: {
        status: 'CANCELLED',
        errorCode: USER_CANCELLED_ERROR_CODE,
        createdAt: { lte: olderThan },
      },
      orderBy: { createdAt: 'asc' },
      take: limit,
      select: jobSelect,
    });
    return jobs.map(toJobRecord);
  }

  public async markCancelledStorageCleaned(id: string): Promise<JobRecord | null> {
    // Conditional updateMany, same pattern as everywhere else in this file — this is
    // what makes two overlapping sweep ticks (this worker's own concurrency, or two
    // replicas) safe against each other: only one can ever win this claim for a
    // given job, so only one ever actually calls storage.deleteObject for it.
    const { count } = await this.database.job.updateMany({
      where: { id, status: 'CANCELLED', errorCode: USER_CANCELLED_ERROR_CODE },
      data: { errorCode: USER_CANCELLED_CLEANED_ERROR_CODE },
    });
    if (count === 0) return null;
    return this.findById(id);
  }

  public async deleteFinished(id: string, userId: string): Promise<DeletedJob | null> {
    // Ownership and the deletable-status check live in the WHERE of *both* the read and
    // the delete: the read only exists to collect the storage keys the database is
    // about to cascade away (a job's ProcessedFile/JobInput rows), while the
    // conditional deleteMany is the actual authority — same pattern as markQueued/
    // markRetried/markCancelled. A retry that moved the job to QUEUED between the two
    // makes count 0, so a live job is never deleted from under a worker.
    const where = { id, userId, status: { in: [...DELETABLE_JOB_STATUSES] } };
    const row = await this.database.job.findFirst({
      where,
      select: {
        ...jobSelect,
        processedFiles: { select: { objectKey: true } },
        inputs: { select: { objectKey: true } },
      },
    });
    if (!row) return null;

    const { count } = await this.database.job.deleteMany({ where });
    if (count === 0) return null;

    const { processedFiles, inputs, ...job } = row;
    // A Set: for a future multi-input job the legacy source key is the same object as
    // its first JobInput's key, and it must only be named once.
    const objectKeys = [
      ...new Set([
        job.sourceObjectKey,
        ...processedFiles.map((file) => file.objectKey),
        ...inputs.map((input) => input.objectKey),
      ]),
    ];
    return { job: toJobRecord(job), objectKeys };
  }

  public async countActiveByUser(userId: string): Promise<number> {
    return this.database.job.count({
      where: { userId, status: { in: ['QUEUED', 'PROCESSING'] } },
    });
  }
}
