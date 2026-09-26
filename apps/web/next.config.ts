import { fileURLToPath } from 'node:url';
import type { NextConfig } from 'next';

const nextConfig: NextConfig = {
  output: 'standalone',
  // In this npm-workspaces monorepo the traced production server needs packages hoisted
  // to the repository root's node_modules, so tracing must start there rather than at
  // apps/web. Without it the standalone output silently omits them.
  outputFileTracingRoot: fileURLToPath(new URL('../../', import.meta.url)),
  poweredByHeader: false,
  reactStrictMode: true,
  allowedDevOrigins: ['127.0.0.1'],
  transpilePackages: ['@media/ui', '@media/types', '@media/validation', '@media/auth-client'],
};

export default nextConfig;
