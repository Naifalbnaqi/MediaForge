import type { FastifyInstance } from 'fastify';
import type { TokenService } from '../../infrastructure/security/token-service.js';
import { createAuthenticate } from '../../middleware/authenticate.js';
import { createRequireRole } from '../../middleware/require-role.js';

interface AdminRoutesOptions {
  tokenService: TokenService;
}

export async function adminRoutes(app: FastifyInstance, options: AdminRoutesOptions): Promise<void> {
  app.get(
    '/me',
    { preHandler: [createAuthenticate(options.tokenService), createRequireRole('ADMIN')] },
    async (request) => {
      return { user: request.authUser };
    },
  );
}
