import { describe, expect, it } from 'vitest';
import type { FastifyRequest } from 'fastify';
import { createRequireRole } from '../src/middleware/require-role.js';

function fakeRequest(role?: 'USER' | 'ADMIN'): FastifyRequest {
  return {
    authUser: role ? { id: 'user-1', email: 'user@example.com', role } : undefined,
  } as unknown as FastifyRequest;
}

describe('createRequireRole', () => {
  it('allows a request whose authUser.role matches the required role', async () => {
    const requireAdmin = createRequireRole('ADMIN');
    await expect(requireAdmin(fakeRequest('ADMIN'))).resolves.toBeUndefined();
  });

  it('rejects with a 403 AppError when authUser.role does not match', async () => {
    const requireAdmin = createRequireRole('ADMIN');
    await expect(requireAdmin(fakeRequest('USER'))).rejects.toMatchObject({
      statusCode: 403,
      code: 'FORBIDDEN',
    });
  });

  it('rejects with a 403 AppError when authUser is undefined', async () => {
    const requireAdmin = createRequireRole('ADMIN');
    await expect(requireAdmin(fakeRequest())).rejects.toMatchObject({
      statusCode: 403,
      code: 'FORBIDDEN',
    });
  });

  it('is generic over the required role, not hardcoded to ADMIN', async () => {
    const requireUser = createRequireRole('USER');
    await expect(requireUser(fakeRequest('USER'))).resolves.toBeUndefined();
    await expect(requireUser(fakeRequest('ADMIN'))).rejects.toMatchObject({ statusCode: 403 });
  });
});
