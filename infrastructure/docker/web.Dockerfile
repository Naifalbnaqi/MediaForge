# Manifests only (no source): dependency layers are rebuilt only when a dependency
# changes. Every workspace's manifest is needed because `npm ci` validates the
# lockfile against the whole workspace tree.
FROM node:22-alpine AS manifests
WORKDIR /app
COPY package.json package-lock.json ./
COPY apps/admin/package.json apps/admin/
COPY apps/api/package.json apps/api/
COPY apps/web/package.json apps/web/
COPY packages/auth-client/package.json packages/auth-client/
COPY packages/config/package.json packages/config/
COPY packages/database/package.json packages/database/
COPY packages/types/package.json packages/types/
COPY packages/ui/package.json packages/ui/
COPY packages/validation/package.json packages/validation/

FROM manifests AS build
ARG NEXT_PUBLIC_API_URL=/api/v1
ARG NEXT_PUBLIC_ADMIN_URL=/admin
ENV NEXT_PUBLIC_API_URL=$NEXT_PUBLIC_API_URL
ENV NEXT_PUBLIC_ADMIN_URL=$NEXT_PUBLIC_ADMIN_URL
RUN npm ci
COPY . .
RUN npm run build -w @media/web

# Runs Next.js's traced standalone server (`output: 'standalone'`, with the tracing
# root set to the monorepo root in next.config.ts): only the files the app actually
# loads are copied, so the image carries no devDependencies, no Prisma CLI, none of the
# API's dependencies, and starts `node` directly as PID 1 (rather than through `npm`,
# which does not reliably forward SIGTERM). `next start` would not work here — Next
# refuses it with `output: 'standalone'`.
FROM node:22-alpine AS runtime
WORKDIR /app
ENV NODE_ENV=production
ENV NEXT_TELEMETRY_DISABLED=1
ENV PORT=3000
ENV HOSTNAME=0.0.0.0
COPY --from=build --chown=node:node /app/apps/web/.next/standalone ./
COPY --from=build --chown=node:node /app/apps/web/.next/static ./apps/web/.next/static
USER node
EXPOSE 3000
CMD ["node", "apps/web/server.js"]
