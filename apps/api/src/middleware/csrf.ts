import { randomBytes, timingSafeEqual } from 'node:crypto';
import type { FastifyRequest } from 'fastify';
import { AppError } from '../utils/app-error.js';

export const CSRF_COOKIE = 'media_csrf';
export const REFRESH_COOKIE = 'media_refresh';

export function createCsrfToken(): string {
  return randomBytes(32).toString('base64url');
}

/**
 * Fastify's per-request hook runner invokes a non-callback-style preHandler and
 * only advances the chain if the return value is a thenable — a plain sync
 * function that neither returns a promise nor calls the `done` it's passed
 * stalls the request forever on its success path (see `node_modules/fastify/
 * lib/hooks.js`'s `hookRunnerGenerator`). `async` is what makes the return
 * value a real promise; the validation logic itself is unchanged.
 */
export async function verifyCsrf(request: FastifyRequest): Promise<void> {
  const cookie = request.cookies[CSRF_COOKIE];
  const header = request.headers['x-csrf-token'];
  if (!cookie || typeof header !== 'string') {
    throw new AppError(403, 'CSRF_VALIDATION_FAILED', 'CSRF token is missing or invalid');
  }
  const cookieBuffer = Buffer.from(cookie);
  const headerBuffer = Buffer.from(header);
  if (cookieBuffer.length !== headerBuffer.length || !timingSafeEqual(cookieBuffer, headerBuffer)) {
    throw new AppError(403, 'CSRF_VALIDATION_FAILED', 'CSRF token is missing or invalid');
  }
}
