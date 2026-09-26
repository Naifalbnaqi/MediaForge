export interface MediaJobMessage {
  jobId: string;
  userId: string;
  /** The Job's `processingAttempt` at the moment it was enqueued — see
   * `BullMqJobQueue.enqueue` for why this is bound into the underlying queue's own
   * job id rather than reusing `jobId` alone across a retry. */
  attempt: number;
}

/** Queue port. BullMQ wiring and processors are intentionally deferred to Phase 2. */
export interface JobQueue {
  enqueue(message: MediaJobMessage): Promise<void>;
}
