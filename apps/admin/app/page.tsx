'use client';

import { ApiError, useAuth } from '@media/auth-client';
import { ErrorState, LoadingState } from '@media/ui';
import type { AuthenticatedUser } from '@media/types';
import { useRouter } from 'next/navigation';
import { useEffect, useState } from 'react';
import { adminMe } from '@/lib/admin-api';

type AdminAccessState =
  | { status: 'checking' }
  | { status: 'authorized'; user: AuthenticatedUser }
  | { status: 'forbidden' }
  | { status: 'error' };

const PLACEHOLDER_CARDS = ['Users', 'Jobs', 'System logs', 'Analytics'];

export default function AdminPage() {
  const { status, getAccessToken, logout } = useAuth();
  const router = useRouter();
  const [access, setAccess] = useState<AdminAccessState>({ status: 'checking' });

  // Layer 1: authentication. proxy.ts already redirects unauthenticated
  // visitors away when the refresh cookie is absent, but a present-and-
  // invalid cookie only surfaces here once AuthProvider's silent refresh
  // resolves — mirrors apps/web's RequireAuth.
  useEffect(() => {
    if (status === 'unauthenticated') {
      router.replace('/login');
    }
  }, [status, router]);

  // Layer 2: authorization. The real, server-verified check for whether this
  // authenticated account actually holds the ADMIN role.
  useEffect(() => {
    if (status !== 'authenticated') return;
    const accessToken = getAccessToken();
    if (!accessToken) {
      // Should not happen: `status === 'authenticated'` is only ever set
      // alongside a stored access token. Treat as session-invalid.
      void logout();
      router.replace('/login');
      return;
    }

    let cancelled = false;
    adminMe(accessToken)
      .then((result) => {
        if (cancelled) return;
        setAccess({ status: 'authorized', user: result.user });
      })
      .catch((error: unknown) => {
        if (cancelled) return;
        if (error instanceof ApiError && error.status === 403) {
          setAccess({ status: 'forbidden' });
          return;
        }
        if (error instanceof ApiError && error.status === 401) {
          // Shouldn't normally happen immediately after a successful silent
          // refresh, but treat it as session-invalid rather than stuck.
          void logout();
          router.replace('/login');
          return;
        }
        setAccess({ status: 'error' });
      });
    return () => {
      cancelled = true;
    };
  }, [status, getAccessToken, logout, router]);

  if (status !== 'authenticated' || access.status === 'checking') {
    return <LoadingState label="Verifying administrator access" />;
  }

  if (access.status === 'forbidden') {
    return (
      <main className="mx-auto max-w-xl px-6 py-20">
        <ErrorState title="Access denied">
          Your account is signed in but does not have administrator access. Contact an existing
          administrator if you believe this is a mistake.
        </ErrorState>
      </main>
    );
  }

  if (access.status === 'error') {
    return (
      <main className="mx-auto max-w-xl px-6 py-20">
        <ErrorState title="Could not verify access">
          Something went wrong while checking your administrator access. Please try again.
        </ErrorState>
      </main>
    );
  }

  const { user } = access;

  async function handleLogout(): Promise<void> {
    await logout();
    router.push('/login');
  }

  return (
    <main className="mx-auto max-w-6xl px-6 py-12">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <p className="text-sm font-semibold uppercase tracking-widest text-indigo-400">
            MediaForge
          </p>
          <h1 className="mt-2 text-3xl font-bold">Administration area</h1>
          <p className="mt-3 text-slate-400">
            Signed in as <span className="font-medium text-slate-200">{user.email}</span>
          </p>
        </div>
        <div className="flex items-center gap-3">
          <span className="inline-flex rounded-full border border-indigo-800 bg-indigo-950 px-2.5 py-0.5 text-xs font-semibold text-indigo-300">
            ADMIN
          </span>
          <button
            type="button"
            onClick={handleLogout}
            className="rounded-lg border border-slate-700 px-3 py-2 text-sm font-medium hover:bg-slate-800"
          >
            Log out
          </button>
        </div>
      </div>

      <div className="mt-10 grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        {PLACEHOLDER_CARDS.map((label) => (
          <section key={label} className="rounded-2xl border border-slate-800 bg-slate-900 p-6">
            <h2 className="text-sm font-medium text-slate-400">{label}</h2>
            <p className="mt-4 text-2xl font-bold">—</p>
            <p className="mt-3 text-xs text-slate-500">Arrives in a later phase.</p>
          </section>
        ))}
      </div>
    </main>
  );
}
