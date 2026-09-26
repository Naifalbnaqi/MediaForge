import type { AuthResponse } from '@media/types';
import type { LoginInput, RegisterInput } from '@media/validation';
import type { AuthRepository } from '../../domain/auth/auth.repository.js';
import type { PasswordHasher } from '../../infrastructure/security/password-hasher.js';
import type { TokenPair, TokenService } from '../../infrastructure/security/token-service.js';
import { AppError } from '../../utils/app-error.js';

export interface RequestMetadata {
  ipAddress?: string;
  userAgent?: string;
}

export interface AuthResult extends AuthResponse {
  refreshToken: string;
  refreshExpiresAt: Date;
}

export class AuthService {
  public constructor(
    private readonly repository: AuthRepository,
    private readonly passwordHasher: PasswordHasher,
    private readonly tokens: TokenService,
  ) {}

  public async register(input: RegisterInput, metadata: RequestMetadata): Promise<AuthResult> {
    if (await this.repository.findUserByEmail(input.email)) {
      throw new AppError(
        409,
        'EMAIL_ALREADY_REGISTERED',
        'An account with this email already exists',
      );
    }
    const user = await this.repository.createUser({
      email: input.email,
      name: input.name,
      passwordHash: await this.passwordHasher.hash(input.password),
    });
    return this.issueSession(user, metadata);
  }

  public async login(input: LoginInput, metadata: RequestMetadata): Promise<AuthResult> {
    const user = await this.repository.findUserByEmail(input.email);
    if (!user || !(await this.passwordHasher.verify(input.password, user.passwordHash))) {
      throw new AppError(401, 'INVALID_CREDENTIALS', 'Email or password is incorrect');
    }
    return this.issueSession(user, metadata);
  }

  public async refresh(refreshToken: string): Promise<AuthResult> {
    let claims;
    try {
      claims = await this.tokens.verifyRefresh(refreshToken);
    } catch {
      throw new AppError(401, 'INVALID_REFRESH_TOKEN', 'Refresh token is invalid or expired');
    }
    const session = await this.repository.findSessionByTokenHash(this.tokens.hash(refreshToken));
    if (
      !session ||
      session.revokedAt ||
      session.expiresAt <= new Date() ||
      session.id !== claims.sessionId
    ) {
      throw new AppError(401, 'INVALID_REFRESH_TOKEN', 'Refresh token is invalid or expired');
    }
    const user = await this.repository.findUserById(claims.sub);
    if (!user) throw new AppError(401, 'INVALID_REFRESH_TOKEN', 'Refresh token is invalid');
    const pair = await this.tokens.createPair(user.id, user.email, user.role, session.id);
    await this.repository.rotateSession(session.id, pair.refreshTokenHash, pair.refreshExpiresAt);
    return this.result(user, pair);
  }

  public async logout(refreshToken: string): Promise<void> {
    const session = await this.repository.findSessionByTokenHash(this.tokens.hash(refreshToken));
    if (session) await this.repository.revokeSession(session.id);
  }

  private async issueSession(
    user: Awaited<ReturnType<AuthRepository['createUser']>>,
    metadata: RequestMetadata,
  ): Promise<AuthResult> {
    const pair = await this.tokens.createPair(user.id, user.email, user.role);
    const claims = await this.tokens.verifyRefresh(pair.refreshToken);
    await this.repository.createSession({
      id: claims.sessionId,
      userId: user.id,
      tokenHash: pair.refreshTokenHash,
      expiresAt: pair.refreshExpiresAt,
      ...(metadata.ipAddress ? { ipAddress: metadata.ipAddress } : {}),
      ...(metadata.userAgent ? { userAgent: metadata.userAgent } : {}),
    });
    return this.result(user, pair);
  }

  private result(
    user: { id: string; email: string; role: 'USER' | 'ADMIN' },
    pair: TokenPair,
  ): AuthResult {
    return {
      accessToken: pair.accessToken,
      refreshToken: pair.refreshToken,
      refreshExpiresAt: pair.refreshExpiresAt,
      user: { id: user.id, email: user.email, role: user.role },
    };
  }
}
