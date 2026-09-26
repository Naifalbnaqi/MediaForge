import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';

// Next.js 16 renamed the `middleware.js` file convention to `proxy.js` — the
// installed version here is 16.3.4, so this file (not `middleware.ts`) is
// what Next.js actually loads. See
// node_modules/next/dist/docs/01-app/03-api-reference/03-file-conventions/proxy.md.

const REFRESH_COOKIE = 'media_refresh';
const PROTECTED_PREFIXES = ['/dashboard'];

/**
 * Fast, flash-free coarse gate: redirect to /login when the HttpOnly
 * `media_refresh` cookie is simply absent. This never inspects or verifies
 * the cookie's contents (that would require sharing the backend's JWT
 * secret with the frontend, which must never happen) — a present-but-
 * expired-or-invalid cookie still passes this check. The authoritative check
 * is the API itself, via the silent-refresh result surfaced through
 * `AuthProvider`/`RequireAuth` on the client (see @media/auth-client, used by
 * apps/web/app/dashboard/layout.tsx).
 */
export function proxy(request: NextRequest): NextResponse {
  const { pathname } = request.nextUrl;
  const isProtected = PROTECTED_PREFIXES.some(
    (prefix) => pathname === prefix || pathname.startsWith(`${prefix}/`),
  );

  if (isProtected && !request.cookies.has(REFRESH_COOKIE)) {
    const loginUrl = new URL('/login', request.url);
    loginUrl.searchParams.set('from', pathname);
    return NextResponse.redirect(loginUrl);
  }

  return NextResponse.next();
}

export const config = {
  matcher: ['/dashboard/:path*'],
};
