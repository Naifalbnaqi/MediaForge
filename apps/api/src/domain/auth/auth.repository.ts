import type { CreateSessionData, CreateUserData, SessionRecord, UserRecord } from './auth.types.js';

export interface AuthRepository {
  findUserByEmail(email: string): Promise<UserRecord | null>;
  findUserById(id: string): Promise<UserRecord | null>;
  createUser(data: CreateUserData): Promise<UserRecord>;
  createSession(data: CreateSessionData): Promise<SessionRecord>;
  findSessionByTokenHash(tokenHash: string): Promise<SessionRecord | null>;
  rotateSession(id: string, tokenHash: string, expiresAt: Date): Promise<void>;
  revokeSession(id: string): Promise<void>;
  revokeAllUserSessions(userId: string): Promise<void>;
}
