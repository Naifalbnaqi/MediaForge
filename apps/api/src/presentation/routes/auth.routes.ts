import type { FastifyInstance, FastifyReply } from 'fastify';
import { loginSchema, registerSchema } from '@media/validation';
import type { AuthService } from '../../application/auth/auth.service.js';
import type { TokenService } from '../../infrastructure/security/token-service.js';
import { createAuthenticate } from '../../middleware/authenticate.js';
import { createCsrfToken, CSRF_COOKIE, REFRESH_COOKIE, verifyCsrf } from '../../middleware/csrf.js';
import { AppError } from '../../utils/app-error.js';

interface AuthRoutesOptions {
  authService: AuthService;
  tokenService: TokenService;
  /** Effective `Secure` attribute for auth cookies — see `resolveCookieSecure`. */
  cookieSecure: boolean;
  cookieDomain?: string;
}

export async function authRoutes(app: FastifyInstance, options: AuthRoutesOptions): Promise<void> {
  const cookieBase = {
    secure: options.cookieSecure,
    sameSite: 'strict' as const,
    ...(options.cookieDomain ? { domain: options.cookieDomain } : {}),
  };

  function setAuthCookies(
    reply: FastifyReply,
    result: { refreshToken: string; refreshExpiresAt: Date },
  ): void {
    reply.setCookie(REFRESH_COOKIE, result.refreshToken, {
      ...cookieBase,
      httpOnly: true,
      path: '/',
      expires: result.refreshExpiresAt,
    });
    reply.setCookie(CSRF_COOKIE, createCsrfToken(), {
      ...cookieBase,
      httpOnly: false,
      path: '/',
      expires: result.refreshExpiresAt,
    });
  }

  app.post(
    '/register',
    { config: { rateLimit: { max: 5, timeWindow: '1 minute' } } },
    async (request, reply) => {
      const input = registerSchema.parse(request.body);
      const result = await options.authService.register(input, {
        ipAddress: request.ip,
        ...(request.headers['user-agent'] ? { userAgent: request.headers['user-agent'] } : {}),
      });
      setAuthCookies(reply, result);
      return reply.status(201).send({ accessToken: result.accessToken, user: result.user });
    },
  );

  app.post(
    '/login',
    { config: { rateLimit: { max: 10, timeWindow: '1 minute' } } },
    async (request, reply) => {
      const input = loginSchema.parse(request.body);
      const result = await options.authService.login(input, {
        ipAddress: request.ip,
        ...(request.headers['user-agent'] ? { userAgent: request.headers['user-agent'] } : {}),
      });
      setAuthCookies(reply, result);
      return { accessToken: result.accessToken, user: result.user };
    },
  );

  app.post('/refresh', { preHandler: verifyCsrf }, async (request, reply) => {
    const token = request.cookies[REFRESH_COOKIE];
    if (!token) throw new AppError(401, 'REFRESH_TOKEN_REQUIRED', 'Refresh token is required');
    const result = await options.authService.refresh(token);
    setAuthCookies(reply, result);
    return { accessToken: result.accessToken, user: result.user };
  });

  app.post('/logout', { preHandler: verifyCsrf }, async (request, reply) => {
    const token = request.cookies[REFRESH_COOKIE];
    if (token) await options.authService.logout(token);
    reply.clearCookie(REFRESH_COOKIE, { ...cookieBase, path: '/' });
    reply.clearCookie(CSRF_COOKIE, { ...cookieBase, path: '/' });
    return reply.status(204).send();
  });

  app.get('/me', { preHandler: createAuthenticate(options.tokenService) }, async (request) => {
    if (!request.authUser)
      throw new AppError(401, 'AUTHENTICATION_REQUIRED', 'Authentication required');
    return { user: request.authUser };
  });
}
