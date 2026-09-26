import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';

// Next.js 16 renamed the `middleware.js` file convention to `proxy.js` — the
// installed version here is 16.3.4, so this file (not `middleware.ts`) is
// what Next.js actually loads. See
// node_modules/next/dist/docs/01-app/03-api-reference/03-file-conventions/proxy.md.
//
// `request.nextUrl.pathname` (and the `matcher` patterns below) are already
// basePath-relative: Next strips the `/admin` basePath before Proxy sees the
// path, so this file is written exactly like apps/web/proxy.ts even though
// this app is served under /admin in production.

const REFRESH_COOKIE = 'media_refresh';
// Admin has no public landing page the way web does — everything is gated
// except the login page itself.
const PUBLIC_PATHS = ['/login'];

/**
 * Fast, flash-free coarse gate: redirect to /login when the HttpOnly
 * `media_refresh` cookie is simply absent. This never inspects or verifies
 * the cookie's contents (that would require sharing the backend's JWT
 * secret with the frontend, which must never happen) — a present-but-
 * expired-or-invalid cookie still passes this check. The authoritative check
 * for *authentication* is the API itself, via the silent-refresh result
 * surfaced through AuthProvider on the client. The authoritative check for
 * *authorization* (ADMIN role) is the GET /api/v1/admin/me call made from
 * app/page.tsx — this proxy makes no role decision at all.
 */
export function proxy(request: NextRequest): NextResponse {
  const { pathname } = request.nextUrl;
  const isPublic = PUBLIC_PATHS.some(
    (path) => pathname === path || pathname.startsWith(`${path}/`),
  );

  if (!isPublic && !request.cookies.has(REFRESH_COOKIE)) {
    // `request.nextUrl.clone()` (not `new URL('/login', request.url)`) is
    // required here: this app has `basePath: '/admin'`, and
    // `request.nextUrl`/`pathname` are basePath-stripped, but `request.url`
    // is the full external URL string. Building a fresh `URL` from an
    // absolute path (`/login`) against that string discards everything but
    // the origin per the WHATWG URL spec, dropping the `/admin` prefix from
    // the resulting redirect. Cloning `nextUrl` and only reassigning
    // `pathname` preserves the internal basePath so it's correctly
    // re-added (as `/admin/login`) when Next serializes the redirect's
    // `Location` header.
    const loginUrl = request.nextUrl.clone();
    loginUrl.pathname = '/login';
    loginUrl.searchParams.set('from', pathname);
    return NextResponse.redirect(loginUrl);
  }

  return NextResponse.next();
}

export const config = {
  // Run on every route except static assets — new protected pages added
  // later are covered automatically without needing a matcher update.
  //
  // The catch-all entry alone is NOT enough: Next compiles it (confirmed by
  // inspecting the build output's compiled matcher regexp) to require a
  // literal `/` *after* the basePath before the negative-lookahead group can
  // match, e.g. `^\/admin(?:\/((?!_next\/static|...).*))...`. That never
  // matches the bare root itself (`/admin`, i.e. this app's home page with
  // no trailing segment) — only `/admin/<something>`. The explicit `'/'`
  // entry below covers exactly that exact-root case so the dashboard at `/`
  // is actually gated, not just nested paths.
  matcher: ['/', '/((?!_next/static|_next/image|favicon.ico).*)'],
};
