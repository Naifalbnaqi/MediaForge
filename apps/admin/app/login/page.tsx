'use client';

import { ApiError, useAuth } from '@media/auth-client';
import { Button, ErrorState, LoadingState } from '@media/ui';
import { loginSchema } from '@media/validation';
import { useRouter } from 'next/navigation';
import { useState, type FormEvent } from 'react';

export default function AdminLoginPage() {
  const router = useRouter();
  const { login } = useAuth();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);

  async function handleSubmit(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    const result = loginSchema.safeParse({ email, password });
    if (!result.success) {
      const errors: Record<string, string> = {};
      for (const issue of result.error.issues) {
        const key = issue.path[0];
        if (typeof key === 'string' && !errors[key]) errors[key] = issue.message;
      }
      setFieldErrors(errors);
      return;
    }
    setFieldErrors({});
    setSubmitError(null);
    setIsSubmitting(true);
    try {
      await login(result.data);
      // Do NOT assume the dashboard here — a successfully authenticated
      // account may still not hold the ADMIN role. That authorization
      // decision belongs to app/page.tsx's server-verified /admin/me check.
      router.push('/');
    } catch (error) {
      setSubmitError(
        error instanceof ApiError ? error.message : 'Something went wrong. Please try again.',
      );
      setIsSubmitting(false);
    }
  }

  return (
    <div className="mx-auto max-w-md px-6 py-20">
      <p className="text-sm font-semibold uppercase tracking-widest text-indigo-400">
        MediaForge
      </p>
      <h1 className="mt-2 text-3xl font-bold">Administrator sign in</h1>
      <p className="mt-3 text-slate-400">Sign in with your MediaForge account credentials.</p>

      {isSubmitting ? (
        <div className="mt-8">
          <LoadingState label="Signing in" />
        </div>
      ) : (
        <form className="mt-8 space-y-5" onSubmit={handleSubmit} noValidate>
          <div>
            <label htmlFor="email" className="block text-sm font-medium text-slate-300">
              Email
            </label>
            <input
              id="email"
              name="email"
              type="email"
              autoComplete="email"
              value={email}
              onChange={(event) => setEmail(event.target.value)}
              className="mt-1.5 w-full rounded-xl border border-slate-700 bg-slate-900 px-3.5 py-2.5 text-sm text-slate-100 outline-none focus:border-indigo-500"
            />
            {fieldErrors.email && (
              <p className="mt-1.5 text-sm text-red-400">{fieldErrors.email}</p>
            )}
          </div>

          <div>
            <label htmlFor="password" className="block text-sm font-medium text-slate-300">
              Password
            </label>
            <input
              id="password"
              name="password"
              type="password"
              autoComplete="current-password"
              value={password}
              onChange={(event) => setPassword(event.target.value)}
              className="mt-1.5 w-full rounded-xl border border-slate-700 bg-slate-900 px-3.5 py-2.5 text-sm text-slate-100 outline-none focus:border-indigo-500"
            />
            {fieldErrors.password && (
              <p className="mt-1.5 text-sm text-red-400">{fieldErrors.password}</p>
            )}
          </div>

          {submitError && <ErrorState title="Could not log in">{submitError}</ErrorState>}

          <Button type="submit" className="w-full">
            Log in
          </Button>
        </form>
      )}
    </div>
  );
}
