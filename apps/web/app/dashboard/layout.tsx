import Link from 'next/link';
import { RequireAuth } from '@media/auth-client';

export default function DashboardLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <div className="mx-auto grid max-w-7xl gap-8 px-5 py-10 md:grid-cols-[220px_1fr]">
      <aside className="self-start rounded-2xl border border-slate-200 bg-white p-4 dark:border-slate-800 dark:bg-slate-900">
        <p className="px-3 pb-3 text-xs font-semibold uppercase tracking-wider text-slate-500">
          Workspace
        </p>
        <nav className="space-y-1" aria-label="Dashboard">
          <Link
            href="/dashboard"
            className="block rounded-lg bg-indigo-50 px-3 py-2 text-sm font-medium text-indigo-700 dark:bg-indigo-950 dark:text-indigo-200"
          >
            Overview
          </Link>
        </nav>
      </aside>
      <section className="min-w-0">
        <RequireAuth>{children}</RequireAuth>
      </section>
    </div>
  );
}
