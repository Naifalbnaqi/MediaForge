'use client';

import { useAuth } from '@media/auth-client';
import Link from 'next/link';
import { useRouter } from 'next/navigation';

export function AuthNavActions() {
  const { status, user, logout } = useAuth();
  const router = useRouter();
  // NEXT_PUBLIC_ADMIN_URL is read defensively (never throws) since this is
  // purely a navigation convenience, not a security check — see below.
  const adminUrl = process.env.NEXT_PUBLIC_ADMIN_URL;

  async function handleLogout(): Promise<void> {
    await logout();
    router.push('/');
  }

  if (status === 'loading') {
    // Reserve space so the navbar doesn't jump once the silent refresh settles.
    return <span className="inline-block h-9 w-24" aria-hidden="true" />;
  }

  if (status === 'authenticated' && user) {
    return (
      <div className="flex items-center gap-3">
        {/*
          UX convenience only — NOT the security boundary. A plain USER never
          sees this link because of this client-side check, but the real
          authorization gate is apps/admin's own server-verified GET
          /api/v1/admin/me check (backed by the API's requireAdmin guard).
          Never treat this conditional as enforcement.
        */}
        {user.role === 'ADMIN' && adminUrl && (
          <a
            href={adminUrl}
            className="text-sm font-medium text-slate-600 hover:text-indigo-600 dark:text-slate-300"
          >
            Admin
          </a>
        )}
        <span className="hidden text-sm text-slate-600 dark:text-slate-300 sm:inline">
          {user.email}
        </span>
        <button
          type="button"
          onClick={handleLogout}
          className="rounded-lg border border-slate-300 px-3 py-2 text-sm font-medium hover:bg-slate-100 dark:border-slate-700 dark:hover:bg-slate-800"
        >
          Log out
        </button>
      </div>
    );
  }

  return (
    <div className="flex items-center gap-3">
      <Link
        href="/login"
        className="text-sm font-medium text-slate-600 hover:text-indigo-600 dark:text-slate-300"
      >
        Log in
      </Link>
      <Link
        href="/register"
        className="rounded-lg bg-indigo-600 px-3 py-2 text-sm font-semibold text-white hover:bg-indigo-500"
      >
        Sign up
      </Link>
    </div>
  );
}
