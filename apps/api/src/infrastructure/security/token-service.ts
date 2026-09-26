import { createHash, randomUUID } from 'node:crypto';
import { jwtVerify, SignJWT } from 'jose';
import type { UserRole } from '@media/types';

export interface TokenPayload {
  sub: string;
  email: string;
  role: UserRole;
  sessionId?: string;
}

export interface TokenPair {
  accessToken: string;
  refreshToken: string;
  refreshTokenHash: string;
  refreshExpiresAt: Date;
}

export class TokenService {
  private readonly accessKey: Uint8Array;
  private readonly refreshKey: Uint8Array;

  public constructor(
    accessSecret: string,
    refreshSecret: string,
    private readonly accessTtl: string,
    private readonly refreshTtlDays: number,
  ) {
    this.accessKey = new TextEncoder().encode(accessSecret);
    this.refreshKey = new TextEncoder().encode(refreshSecret);
  }

  public async createPair(
    userId: string,
    email: string,
    role: UserRole,
    sessionId: string = randomUUID(),
  ): Promise<TokenPair> {
    const refreshExpiresAt = new Date(Date.now() + this.refreshTtlDays * 86_400_000);
    const accessToken = await new SignJWT({ email, role })
      .setProtectedHeader({ alg: 'HS256', typ: 'JWT' })
      .setSubject(userId)
      .setIssuedAt()
      .setExpirationTime(this.accessTtl)
      .setJti(randomUUID())
      .sign(this.accessKey);
    const refreshToken = await new SignJWT({ email, role, sessionId })
      .setProtectedHeader({ alg: 'HS256', typ: 'JWT' })
      .setSubject(userId)
      .setIssuedAt()
      .setExpirationTime(refreshExpiresAt)
      .setJti(randomUUID())
      .sign(this.refreshKey);
    return {
      accessToken,
      refreshToken,
      refreshTokenHash: this.hash(refreshToken),
      refreshExpiresAt,
    };
  }

  public async verifyAccess(token: string): Promise<TokenPayload> {
    const { payload } = await jwtVerify(token, this.accessKey, { algorithms: ['HS256'] });
    return this.toPayload(payload);
  }

  public async verifyRefresh(token: string): Promise<TokenPayload & { sessionId: string }> {
    const { payload } = await jwtVerify(token, this.refreshKey, { algorithms: ['HS256'] });
    const parsed = this.toPayload(payload);
    if (typeof payload.sessionId !== 'string') throw new Error('Invalid refresh token');
    return { ...parsed, sessionId: payload.sessionId };
  }

  public hash(token: string): string {
    return createHash('sha256').update(token).digest('hex');
  }

  private toPayload(payload: Record<string, unknown>): TokenPayload {
    if (
      typeof payload.sub !== 'string' ||
      typeof payload.email !== 'string' ||
      (payload.role !== 'USER' && payload.role !== 'ADMIN')
    ) {
      throw new Error('Invalid token claims');
    }
    return { sub: payload.sub, email: payload.email, role: payload.role };
  }
}
