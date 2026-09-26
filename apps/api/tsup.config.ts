import { defineConfig } from 'tsup';

export default defineConfig({
  // Two independent entrypoints/processes: the HTTP API (dist/server.js) and the
  // standalone BullMQ media-processing worker (dist/worker.js, run by
  // docker-compose.yml's `worker` service via `node dist/worker.js`). tsup builds each
  // as its own bundle under the same `noExternal`/`external` rules below.
  entry: ['src/server.ts', 'src/worker.ts'],
  format: ['esm'],
  dts: true,
  sourcemap: true,
  clean: true,
  platform: 'node',
  // Workspace packages (@media/config, @media/database, @media/validation, @media/types)
  // ship raw TypeScript ("exports": "./src/index.ts") and are normally resolved at
  // runtime through node_modules/@media/* symlinks into packages/*. The production
  // Docker image (infrastructure/docker/api.Dockerfile) does not copy packages/, and
  // even if it did, Node's native TypeScript type-stripping unconditionally refuses to
  // process any .ts file located under node_modules (ERR_UNSUPPORTED_NODE_MODULES_TYPE_STRIPPING),
  // so raw @media/* source can never be executed at runtime via its normal resolution path.
  // Force-inlining these workspace packages into dist/server.js removes the runtime
  // dependency on packages/* (and on any Node TypeScript support) entirely.
  noExternal: [/^@media\//],
  // @media/database pulls in pg (via @prisma/adapter-pg) and the @prisma/client runtime,
  // none of which are declared as direct dependencies of @media/api — tsup's default
  // externalization only looks at the entry package's own package.json, so without this
  // they get swept into the bundle by default. They are real, already-compiled npm
  // packages (unlike @media/*), and bundling pg specifically breaks at runtime with
  // "Dynamic require of \"events\" is not supported" (pg's CJS internals do not survive
  // esbuild's CJS-in-ESM interop). Keep them external so they load normally from
  // node_modules, matching how fastify/bcrypt/jose/etc. already behave.
  external: [/^@prisma\//, 'pg'],
});
