'use client';

import { Button, LoadingState } from '@media/ui';
import { useAuth } from '@media/auth-client';
import { useRouter } from 'next/navigation';
import { UploadPanel } from '@/components/upload-panel';

export default function DashboardPage() {
  const { user, logout } = useAuth();
  const router = useRouter();

  async function handleLogout(): Promise<void> {
    await logout();
    router.push('/');
  }

  // RequireAuth (the layout's auth gate) only renders this page once
  // status === 'authenticated', which the AuthProvider guarantees comes
  // paired with a non-null user. This check exists purely to satisfy
  // strict-mode typing without a non-null assertion — it should never
  // actually render for a real visitor.
  if (!user) {
    return <LoadingState label="Loading your account" />;
  }

  return (
    <div>
      <div className="flex flex-wrap items-end justify-between gap-x-6 gap-y-4">
        <div>
          <h1 className="text-3xl font-bold tracking-tight">Dashboard</h1>
          <p className="mt-2 text-slate-600 dark:text-slate-300">
            Your processing workspace is ready.
          </p>
        </div>

        <section
          aria-label="Your account"
          className="flex flex-wrap items-center gap-x-3 gap-y-2 rounded-xl border border-slate-200 bg-white px-4 py-2.5 text-sm dark:border-slate-800 dark:bg-slate-900"
        >
          <span className="min-w-0 truncate font-medium" title={user.email}>
            {user.email}
          </span>
          <span className="inline-flex rounded-full border border-indigo-200 bg-indigo-50 px-2.5 py-0.5 text-xs font-semibold text-indigo-700 dark:border-indigo-900 dark:bg-indigo-950 dark:text-indigo-300">
            {user.role}
          </span>
          <Button type="button" variant="secondary" size="sm" onClick={handleLogout}>
            Log out
          </Button>
        </section>
      </div>

      <div className="mt-8">
        <UploadPanel />
      </div>
    </div>
  );
}
