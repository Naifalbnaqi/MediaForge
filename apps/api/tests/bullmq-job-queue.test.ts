import { describe, expect, it } from 'vitest';
import { buildProcessingJobId } from '../src/infrastructure/queue/bullmq-job-queue.js';

describe('buildProcessingJobId', () => {
  it('produces the same id for the same jobId and processingAttempt (redelivery is idempotent)', () => {
    const first = buildProcessingJobId('job-1', 1);
    const second = buildProcessingJobId('job-1', 1);

    expect(first).toBe(second);
  });

  it('produces a different id for a different processingAttempt (a retry never reuses the prior attempt)', () => {
    const attemptOne = buildProcessingJobId('job-1', 1);
    const attemptTwo = buildProcessingJobId('job-1', 2);

    expect(attemptOne).not.toBe(attemptTwo);
  });

  it('produces a different id for a different jobId at the same attempt number', () => {
    const jobOne = buildProcessingJobId('job-1', 1);
    const jobTwo = buildProcessingJobId('job-2', 1);

    expect(jobOne).not.toBe(jobTwo);
  });

  it('never contains ":" — BullMQ reserves it as its internal Redis key separator', () => {
    // A UUID-shaped jobId, since that's what production actually passes in.
    const id = buildProcessingJobId('3fa85f64-5717-4562-b3fc-2c963f66afa6', 7);

    expect(id).not.toContain(':');
  });
});
