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
RUN npm ci
COPY . .
RUN npm run build -w @media/admin

# Traced standalone server, same reasoning as web.Dockerfile. The app is served under
# the `/admin` basePath; the standalone server honours it.
FROM node:22-alpine AS runtime
WORKDIR /app
ENV NODE_ENV=production
ENV NEXT_TELEMETRY_DISABLED=1
ENV PORT=3001
ENV HOSTNAME=0.0.0.0
COPY --from=build --chown=node:node /app/apps/admin/.next/standalone ./
COPY --from=build --chown=node:node /app/apps/admin/.next/static ./apps/admin/.next/static
USER node
EXPOSE 3001
CMD ["node", "apps/admin/server.js"]
