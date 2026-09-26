import type { AuthenticatedUser } from '@media/types';
import { apiRequest } from '@media/auth-client';

/**
 * `GET /api/v1/admin/me` — registered at the `/api/v1/admin` prefix, guarded
 * by `[createAuthenticate(tokenService), createRequireRole('ADMIN')]` (see
 * apps/api/src/presentation/routes/admin.routes.ts). This is the real,
 * server-verified authorization boundary for the admin dashboard: a 200
 * response is the only thing that should ever be treated as proof of ADMIN
 * access. Kept local to apps/admin (rather than in @media/auth-client)
 * because it's the only consumer; it reuses the shared `apiRequest` fetch/
 * error-parsing plumbing instead of duplicating it.
 */
export function adminMe(accessToken: string): Promise<{ user: AuthenticatedUser }> {
  return apiRequest<{ user: AuthenticatedUser }>('/admin/me', { accessToken });
}
