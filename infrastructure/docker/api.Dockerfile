# Manifests only (no source): the `npm ci` layers below are rebuilt only when a
# dependency actually changes, not on every source edit. Every workspace's manifest is
# needed because `npm ci` validates the lockfile against the whole workspace tree.
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
RUN npm run db:generate && npm run build -w @media/api

# One-shot migration image: applies committed migrations (`prisma migrate deploy`,
# never `migrate dev`) as an explicit step run before rolling out api/worker, not
# automatically or concurrently from every replica — see docker-compose.yml's
# `migrate` service (profile-gated, so `docker compose up` never starts it on its
# own) and docs/PRODUCTION.md for the intended flow. Built straight from `build`,
# with the full dev dependency set, since the Prisma CLI (`prisma`) is a
# devDependency of @media/database and this stage is the only place that needs it —
# keeping it out of every runtime image is deliberate: `prisma`'s own dependency tree
# carries `@prisma/config` -> `deepmerge-ts` and `prisma` -> `mysql2`, both of which have
# open high-severity advisories with no non-breaking fix yet (see README's "Dependency
# audit note"); this stage is short-lived and ops-only, so carrying them here doesn't
# expose the continuously-running containers.
FROM build AS migrate
ENV NODE_ENV=production
CMD ["npm", "run", "db:deploy"]

# Production dependencies of the API workspace ONLY. Installing with `-w @media/api`
# (rather than pruning the whole monorepo's tree) is what keeps the customer/admin
# frontends' dependencies — Next.js alone is ~200 MB — out of the API/worker image.
# `--omit=optional` matters as well as `--omit=dev`: @prisma/client declares `prisma` as
# an *optional peer* dependency, which npm records as `devOptional` rather than `dev`,
# so `--omit=dev` alone would still install the Prisma CLI (and its mysql2/deepmerge-ts
# advisories). Verified: with both flags, `prisma`/`mysql2`/`deepmerge-ts` are absent
# while `@prisma/client` itself, which the API needs at runtime, is present.
FROM manifests AS prod-deps
RUN npm ci --omit=dev --omit=optional -w @media/api

FROM node:22-alpine AS runtime
RUN apk add --no-cache ffmpeg
WORKDIR /app
ENV NODE_ENV=production
COPY --from=prod-deps /app/node_modules ./node_modules
COPY --from=build /app/apps/api/dist ./apps/api/dist
COPY --from=build /app/apps/api/package.json ./apps/api/package.json
COPY --from=build /app/package.json ./package.json
USER node
EXPOSE 4000
CMD ["node", "apps/api/dist/server.js"]

# Worker-only runtime: everything `runtime` has, plus headless LibreOffice for
# `document-to-pdf`. A separate stage (not added to `runtime` itself) because
# the API process never runs LibreOffice — see docker-compose.yml's `worker`
# service, which is the only one built with `target: runtime-worker`. Installs
# only the three components document-to-pdf actually uses (writer/calc/impress,
# which pull in libreoffice-common) rather than the full `libreoffice`
# meta-package (which also drags in Base, Math, GTK/Qt/KF6 integration, and
# every language pack) — verified directly: this alone is enough to convert
# DOCX/PPTX/XLSX/ODT/ODS/ODP/RTF/TXT and the legacy DOC/PPT/XLS. Still adds
# roughly 400-500 MB, which is real and unavoidable for genuine LibreOffice
# conversion — accepted here, and only here, per the instruction to keep the
# API/web images lean.
FROM runtime AS runtime-worker
USER root
RUN apk add --no-cache libreoffice-writer libreoffice-calc libreoffice-impress
USER node
