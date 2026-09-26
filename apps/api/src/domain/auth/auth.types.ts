import type { AuthenticatedUser, UserRole } from '@media/types';

export interface UserRecord extends AuthenticatedUser {
  name: string;
  passwordHash: string;
}

export interface SessionRecord {
  id: string;
  userId: string;
  tokenHash: string;
  expiresAt: Date;
  revokedAt: Date | null;
}

export interface CreateUserData {
  email: string;
  name: string;
  passwordHash: string;
  role?: UserRole;
}

export interface CreateSessionData {
  id: string;
  userId: string;
  tokenHash: string;
  expiresAt: Date;
  ipAddress?: string;
  userAgent?: string;
}
