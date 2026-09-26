import type { CreateProcessedFileData, ProcessedFileRecord } from './processed-files.types.js';

export interface ProcessedFilesRepository {
  create(data: CreateProcessedFileData): Promise<ProcessedFileRecord>;
  findByJobId(jobId: string): Promise<ProcessedFileRecord[]>;
}
