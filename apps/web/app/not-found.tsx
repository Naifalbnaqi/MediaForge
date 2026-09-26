import Link from 'next/link';
export default function NotFound() {
  return (
    <div className="px-5 py-24 text-center">
      <h1 className="text-4xl font-bold">Page not found</h1>
      <Link className="mt-5 inline-block text-indigo-600 underline" href="/">
        Return home
      </Link>
    </div>
  );
}
