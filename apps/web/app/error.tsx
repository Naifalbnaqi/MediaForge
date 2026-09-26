'use client';
import { ErrorState } from '@media/ui';
export default function ErrorPage({ reset }: { error: Error; reset: () => void }) {
  return (
    <div className="mx-auto max-w-xl px-5 py-20">
      <ErrorState>
        <button onClick={reset} className="underline">
          Try again
        </button>
      </ErrorState>
    </div>
  );
}
