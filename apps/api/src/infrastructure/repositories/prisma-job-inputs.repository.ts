import type { PrismaClient } from '@media/database';
import type { JobInputsRepository } from '../../domain/job-inputs/job-inputs.repository.js';
import type { CreateJobInputData, JobInputRecord } from '../../domain/job-inputs/job-inputs.types.js';

export class PrismaJobInputsRepository implements JobInputsRepository {
  public constructor(private readonly database: PrismaClient) {}

  public async create(data: CreateJobInputData): Promise<JobInputRecord> {
    return this.database.jobInput.create({
      data: {
        jobId: data.jobId,
        objectKey: data.objectKey,
        fileName: data.fileName,
        mimeType: data.mimeType,
        sizeBytes: data.sizeBytes,
        order: data.order,
      },
    });
  }

  public async findByJobId(jobId: string): Promise<JobInputRecord[]> {
    return this.database.jobInput.findMany({
      where: { jobId },
      orderBy: { order: 'asc' },
    });
  }
}
