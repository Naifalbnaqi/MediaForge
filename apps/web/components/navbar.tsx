import Link from 'next/link';
import { AuthNavActions } from './auth-nav-actions';
import { ThemeToggle } from './theme-toggle';

export function Navbar() {
  return (
    <header className="border-b border-slate-200/80 bg-white/80 backdrop-blur dark:border-slate-800 dark:bg-slate-950/80">
      <nav
        className="mx-auto flex max-w-7xl items-center justify-between px-5 py-4"
        aria-label="Main navigation"
      >
        <Link href="/" className="text-lg font-bold tracking-tight">
          MediaForge
        </Link>
        <div className="flex items-center gap-3">
          <Link
            href="/dashboard"
            className="text-sm font-medium text-slate-600 hover:text-indigo-600 dark:text-slate-300"
          >
            Dashboard
          </Link>
          <AuthNavActions />
          <ThemeToggle />
        </div>
      </nav>
    </header>
  );
}
