export function Footer() {
  return (
    <footer className="border-t border-slate-200 py-8 text-center text-sm text-slate-500 dark:border-slate-800">
      <p>
        © {new Date().getFullYear()} MediaForge. Process only media you own or are authorized to
        use.
      </p>
    </footer>
  );
}
