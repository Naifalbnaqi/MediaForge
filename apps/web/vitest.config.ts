import { fileURLToPath } from 'node:url';
import { configDefaults, defineConfig } from 'vitest/config';

export default defineConfig({
  // Mirrors tsconfig.json's "@/*": ["./*"] path mapping — TypeScript understands
  // that natively for type-checking, but Vite's own module resolution needs it
  // spelled out separately since it doesn't read tsconfig `paths`.
  resolve: { alias: { '@': fileURLToPath(new URL('.', import.meta.url)) } },
  // tsconfig.json sets `jsx: "preserve"` for Next.js's own SWC/babel pipeline to
  // consume — Vite 8's default transformer (oxc, not esbuild — verified against the
  // installed version's own config typings) leaves JSX completely untouched in that
  // mode, which is invalid JS outside Next's build. Overriding just the oxc
  // transform's own jsx setting here makes `.tsx` test files (and the components
  // they import) transform correctly under Vitest without touching the app's real
  // tsconfig/Next build config.
  oxc: { jsx: { runtime: 'automatic' } },
  test: {
    exclude: [...configDefaults.exclude, 'e2e/**'],
    environment: 'jsdom',
    setupFiles: ['./vitest.setup.ts'],
  },
});
