import { fileURLToPath } from 'node:url';
import type { NextConfig } from 'next';

const config: NextConfig = {
  basePath: '/admin',
  output: 'standalone',
  // See apps/web/next.config.ts: standalone tracing must start at the monorepo root.
  outputFileTracingRoot: fileURLToPath(new URL('../../', import.meta.url)),
  poweredByHeader: false,
  transpilePackages: ['@media/ui', '@media/types', '@media/validation', '@media/auth-client'],
};

export default config;
