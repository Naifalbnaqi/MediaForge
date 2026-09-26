'use client';

import { LoadingState } from '@media/ui';
import { useRouter } from 'next/navigation';
import { useEffect, type PropsWithChildren } from 'react';
import { useAuth } from './auth-context';

/**
 * Second, authoritative layer of route protection. The consuming app's
 * `proxy.ts` only checks whether the `media_refresh` cookie is present (a
 * fast, flash-free coarse gate) — it cannot verify the cookie's JWT
 * signature without sharing the backend's secret with the frontend, so a
 * present-but-expired-or-invalid cookie still reaches this component. This
 * waits for the silent-refresh result from `AuthProvider` and redirects to
 * `/login` only if that call actually failed.
 */
export function RequireAuth({ children }: PropsWithChildren) {
  const { status } = useAuth();
  const router = useRouter();

  useEffect(() => {
    if (status === 'unauthenticated') {
      router.replace('/login');
    }
  }, [status, router]);

  if (status !== 'authenticated') {
    return <LoadingState label="Checking your session" />;
  }

  return <>{children}</>;
}
