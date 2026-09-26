import type { FastifyRequest } from 'fastify';
import type { AuthenticatedUser } from '@media/types';
import type { TokenService } from '../infrastructure/security/token-service.js';
import { AppError } from '../utils/app-error.js';

declare module 'fastify' {
  interface FastifyRequest {
    authUser?: AuthenticatedUser;
  }
}

export function createAuthenticate(tokens: TokenService) {
  return async function authenticate(request: FastifyRequest): Promise<void> {
    const authorization = request.headers.authorization;
    if (!authorization?.startsWith('Bearer ')) {
      throw new AppError(401, 'AUTHENTICATION_REQUIRED', 'A valid access token is required');
    }
    try {
      const claims = await tokens.verifyAccess(authorization.slice(7));
      request.authUser = { id: claims.sub, email: claims.email, role: claims.role };
    } catch {
      throw new AppError(401, 'INVALID_ACCESS_TOKEN', 'Access token is invalid or expired');
    }
  };
}
