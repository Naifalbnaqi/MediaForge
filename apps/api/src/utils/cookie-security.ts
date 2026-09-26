import type { ServerEnvironment } from '@media/config';

/**
 * Effective value for auth cookies' `Secure` attribute: an explicit `COOKIE_SECURE`
 * always wins (this is what lets Docker Compose run the API with NODE_ENV=production
 * over plain http://localhost, without weakening real production deployments); when
 * `COOKIE_SECURE` is not set at all, falls back to the existing production-safe
 * default of requiring HTTPS whenever NODE_ENV is 'production'.
 */
export function resolveCookieSecure(
  environment: Pick<ServerEnvironment, 'COOKIE_SECURE' | 'NODE_ENV'>,
): boolean {
  return environment.COOKIE_SECURE ?? environment.NODE_ENV === 'production';
}
