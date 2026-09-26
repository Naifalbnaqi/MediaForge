import type { ComponentPropsWithRef, PropsWithChildren } from 'react';

export type ButtonVariant = 'primary' | 'secondary' | 'danger' | 'danger-solid';
export type ButtonSize = 'md' | 'sm';

const BUTTON_BASE =
  'inline-flex items-center justify-center gap-1.5 rounded-xl font-semibold transition focus-visible:outline-2 focus-visible:outline-offset-2 disabled:cursor-not-allowed disabled:opacity-50';

const BUTTON_VARIANTS: Record<ButtonVariant, string> = {
  primary:
    'bg-indigo-600 text-white shadow-sm hover:bg-indigo-500 focus-visible:outline-indigo-500',
  secondary:
    'border border-slate-300 bg-white text-slate-700 hover:bg-slate-50 focus-visible:outline-indigo-500 dark:border-slate-700 dark:bg-transparent dark:text-slate-200 dark:hover:bg-slate-800',
  danger:
    'border border-red-300 bg-white text-red-700 hover:bg-red-50 focus-visible:outline-red-500 dark:border-red-900 dark:bg-transparent dark:text-red-300 dark:hover:bg-red-950/40',
  'danger-solid': 'bg-red-600 text-white shadow-sm hover:bg-red-500 focus-visible:outline-red-500',
};

const BUTTON_SIZES: Record<ButtonSize, string> = {
  md: 'min-h-11 px-5 py-2.5 text-sm',
  sm: 'min-h-9 px-3 py-1.5 text-xs',
};

export function Button({
  className = '',
  variant = 'primary',
  size = 'md',
  ...props
}: ComponentPropsWithRef<'button'> & { variant?: ButtonVariant; size?: ButtonSize }) {
  // React 19 passes `ref` through as an ordinary prop on function components, so it
  // arrives in `props` and is spread onto the <button> below.
  return (
    <button
      className={`${BUTTON_BASE} ${BUTTON_SIZES[size]} ${BUTTON_VARIANTS[variant]} ${className}`}
      {...props}
    />
  );
}

export function LoadingState({ label = 'Loading' }: { label?: string }) {
  return (
    <div className="flex min-h-48 items-center justify-center" role="status" aria-live="polite">
      <span className="size-6 animate-spin rounded-full border-2 border-indigo-500 border-t-transparent" />
      <span className="sr-only">{label}</span>
    </div>
  );
}

export function ErrorState({
  title = 'Something went wrong',
  children,
}: PropsWithChildren<{ title?: string }>) {
  return (
    <div
      className="rounded-2xl border border-red-200 bg-red-50 p-6 text-red-950 dark:border-red-900 dark:bg-red-950/40 dark:text-red-100"
      role="alert"
    >
      <h2 className="font-semibold">{title}</h2>
      {children && <div className="mt-2 text-sm opacity-80">{children}</div>}
    </div>
  );
}
