import type { PrismaClient } from '@media/database';
import type { ProcessedFilesRepository } from '../../domain/processed-files/processed-files.repository.js';
import type {
  CreateProcessedFileData,
  ProcessedFileRecord,
} from '../../domain/processed-files/processed-files.types.js';

export class PrismaProcessedFilesRepository implements ProcessedFilesRepository {
  public constructor(private readonly database: PrismaClient) {}

  public async create(data: CreateProcessedFileData): Promise<ProcessedFileRecord> {
    return this.database.processedFile.create({
      data: {
        jobId: data.jobId,
        objectKey: data.objectKey,
        fileName: data.fileName,
        mimeType: data.mimeType,
        sizeBytes: data.sizeBytes,
      },
    });
  }

  public async findByJobId(jobId: string): Promise<ProcessedFileRecord[]> {
    return this.database.processedFile.findMany({
      where: { jobId },
      orderBy: { createdAt: 'desc' },
    });
  }
}
