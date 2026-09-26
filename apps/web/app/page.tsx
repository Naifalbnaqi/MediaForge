import Link from 'next/link';

const features = [
  ['Private by design', 'Short-lived access, isolated jobs, and expiring downloads.'],
  ['Built for quality', 'A reliable processing foundation ready for production workloads.'],
  ['Clear progress', 'Track every authorized media job from upload to download.'],
] as const;

export default function HomePage() {
  return (
    <>
      <section className="relative overflow-hidden px-5 py-24 sm:py-32">
        <div className="absolute inset-0 -z-10 bg-[radial-gradient(circle_at_top,#6366f133,transparent_45%)]" />
        <div className="mx-auto max-w-4xl text-center">
          <span className="rounded-full border border-indigo-200 bg-indigo-50 px-3 py-1 text-xs font-semibold text-indigo-700 dark:border-indigo-900 dark:bg-indigo-950 dark:text-indigo-300">
            Your media. Your workflow.
          </span>
          <h1 className="mt-7 text-balance text-5xl font-black tracking-tight sm:text-7xl">
            Media processing without the friction.
          </h1>
          <p className="mx-auto mt-6 max-w-2xl text-pretty text-lg leading-8 text-slate-600 dark:text-slate-300">
            Convert, compress, and prepare media you are authorized to process—with a secure,
            dependable workflow.
          </p>
          <div className="mt-9 flex flex-wrap justify-center gap-3">
            <Link
              href="/dashboard"
              className="rounded-xl bg-indigo-600 px-6 py-3 font-semibold text-white shadow-lg shadow-indigo-600/20 hover:bg-indigo-500"
            >
              Open dashboard
            </Link>
            <a
              href="#features"
              className="rounded-xl border border-slate-300 px-6 py-3 font-semibold hover:bg-white dark:border-slate-700 dark:hover:bg-slate-900"
            >
              Learn more
            </a>
          </div>
        </div>
      </section>
      <section id="features" className="mx-auto grid max-w-7xl gap-5 px-5 pb-24 md:grid-cols-3">
        {features.map(([title, description]) => (
          <article
            key={title}
            className="rounded-2xl border border-slate-200 bg-white p-7 shadow-sm dark:border-slate-800 dark:bg-slate-900"
          >
            <h2 className="text-lg font-bold">{title}</h2>
            <p className="mt-3 leading-7 text-slate-600 dark:text-slate-300">{description}</p>
          </article>
        ))}
      </section>
    </>
  );
}
