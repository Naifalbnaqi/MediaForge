import type { PrismaClient } from '@media/database';
import type { AuthRepository } from '../../domain/auth/auth.repository.js';
import type {
  CreateSessionData,
  CreateUserData,
  SessionRecord,
  UserRecord,
} from '../../domain/auth/auth.types.js';

export class PrismaAuthRepository implements AuthRepository {
  public constructor(private readonly database: PrismaClient) {}

  public async findUserByEmail(email: string): Promise<UserRecord | null> {
    return this.database.user.findUnique({ where: { email } });
  }

  public async findUserById(id: string): Promise<UserRecord | null> {
    return this.database.user.findUnique({ where: { id } });
  }

  public async createUser(data: CreateUserData): Promise<UserRecord> {
    return this.database.user.create({ data });
  }

  public async createSession(data: CreateSessionData): Promise<SessionRecord> {
    return this.database.session.create({ data });
  }

  public async findSessionByTokenHash(tokenHash: string): Promise<SessionRecord | null> {
    return this.database.session.findUnique({ where: { tokenHash } });
  }

  public async rotateSession(id: string, tokenHash: string, expiresAt: Date): Promise<void> {
    await this.database.session.update({
      where: { id },
      data: { tokenHash, expiresAt, lastRefreshedAt: new Date() },
    });
  }

  public async revokeSession(id: string): Promise<void> {
    await this.database.session.update({ where: { id }, data: { revokedAt: new Date() } });
  }

  public async revokeAllUserSessions(userId: string): Promise<void> {
    await this.database.session.updateMany({
      where: { userId, revokedAt: null },
      data: { revokedAt: new Date() },
    });
  }
}
