import type { FastifyRequest } from 'fastify';
import type { UserRole } from '@media/types';
import { AppError } from '../utils/app-error.js';

/**
 * Creates a preHandler that enforces an exact-role match against `request.authUser`.
 *
 * IMPORTANT: this guard does not authenticate the request itself — it only reads
 * `request.authUser`, which is populated by `createAuthenticate(tokenService)`
 * (see `middleware/authenticate.ts`). It must always be chained *after*
 * `createAuthenticate(...)` in a route's `preHandler` array, e.g.:
 *
 *   preHandler: [createAuthenticate(tokenService), createRequireRole('ADMIN')]
 *
 * Used alone (without authenticate running first), `request.authUser` will be
 * undefined and every request will be rejected with 403.
 */
export function createRequireRole(role: UserRole) {
  return async function requireRole(request: FastifyRequest): Promise<void> {
    if (request.authUser?.role !== role) {
      throw new AppError(403, 'FORBIDDEN', 'You do not have permission to access this resource');
    }
  };
}
