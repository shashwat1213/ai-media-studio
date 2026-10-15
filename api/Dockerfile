# syntax=docker/dockerfile:1.7
#
# API + worker image (one image, two start commands) + a one-off `migrator` target.
# Spec: specs/05_dockerize_spec.md
#
# Multi-stage build. Each FROM starts a fresh image; only what we explicitly COPY --from
# carries over. Compilers, devDependencies, TS sources and tests never reach the final image.
#
#   deps          all dependencies (incl. dev) -> needed to compile TypeScript
#   build         tsc -> dist/
#   prod-deps     production dependencies + generated Prisma client (still has the prisma CLI)
#   migrator      prod-deps + migrations, runs `prisma migrate deploy` once, then exits
#   runtime-deps  prod-deps with the migration-only tooling removed
#   runtime       node + runtime-deps + dist. Non-root. The default target (last stage).

ARG NODE_IMAGE=node:22.23.3-alpine3.24

# ---------- base: tini as PID 1 ----------
FROM ${NODE_IMAGE} AS base
# tini forwards SIGTERM to node and reaps zombie processes (PID 1 has special signal rules).
RUN apk add --no-cache tini
WORKDIR /app
ENV NODE_ENV=production

# ---------- deps ----------
FROM ${NODE_IMAGE} AS deps
WORKDIR /app
# Copy ONLY the manifests first. Docker caches each layer: as long as package*.json don't
# change, the slow `npm ci` layer is reused even when source code changes.
COPY package.json package-lock.json ./
COPY prisma ./prisma
# BuildKit cache mount: npm's download cache survives between builds without ending up in a layer.
RUN --mount=type=cache,target=/root/.npm npm ci

# ---------- build ----------
FROM deps AS build
COPY tsconfig.json tsconfig.build.json ./
COPY src ./src
RUN npm run build

# ---------- prod-deps ----------
FROM ${NODE_IMAGE} AS prod-deps
WORKDIR /app
COPY package.json package-lock.json ./
COPY prisma ./prisma
# --omit=dev drops vitest, eslint, tsx... --ignore-scripts skips postinstall; we generate explicitly.
# Note: `prisma` + `typescript` are still installed here because they're (optional) peer deps of
# @prisma/client and npm keeps them in the prod tree. The migrator needs the CLI, so that's fine.
RUN --mount=type=cache,target=/root/.npm \
    npm ci --omit=dev --ignore-scripts \
 && ./node_modules/.bin/prisma generate

# ---------- migrator (one-off) ----------
# Runs as a separate container/ECS task BEFORE api + worker start. Keeping the migration CLI
# out of the long-running image means less code (and less attack surface) in what serves traffic.
FROM base AS migrator
COPY --from=prod-deps --chown=node:node /app/node_modules ./node_modules
COPY --chown=node:node package.json ./
COPY --chown=node:node prisma ./prisma
USER node
ENTRYPOINT ["/sbin/tini", "--"]
# `migrate deploy` only applies committed migrations, never generates new ones. Safe for prod.
CMD ["./node_modules/.bin/prisma", "migrate", "deploy"]

# ---------- runtime-deps ----------
FROM prod-deps AS runtime-deps
# Remove what only the CLI/migrations need (~125 MB). The generated client in node_modules/.prisma
# loads the musl query engine directly; it doesn't need the CLI, its engines package or TypeScript.
# Source maps aren't used at runtime either. Verified by running the image (login + queries work).
RUN rm -rf node_modules/prisma node_modules/@prisma/engines node_modules/@prisma/config \
           node_modules/@prisma/fetch-engine node_modules/@prisma/get-platform \
           node_modules/effect node_modules/typescript node_modules/.bin/prisma node_modules/.bin/tsc \
 && find node_modules -name '*.map' -type f -delete \
 # Prisma ships WASM query engines for every database (mysql, sqlite, sqlserver, cockroach...)
 # for edge/serverless runtimes. We run on Node with the native musl engine (.prisma/client
 # -> runtime/library.js), so those ~50 MB are dead weight.
 && rm -f node_modules/@prisma/client/runtime/*.wasm-base64.* \
          node_modules/@prisma/client/runtime/query_engine_bg.* \
          node_modules/@prisma/client/runtime/query_compiler_bg.*

# ---------- runtime (default) ----------
FROM base AS runtime
ENV PORT=4000
# ffmpeg renders MOTION + EDIT jobs in the worker; the API uses ffprobe to verify uploads. ~+60 MB, from Alpine's signed repo.
# Same image runs the API (which never calls it): one image for both keeps deploys simple.
RUN apk add --no-cache ffmpeg
# --chown: the non-root user owns its files.
COPY --from=runtime-deps --chown=node:node /app/node_modules ./node_modules
COPY --from=build        --chown=node:node /app/dist ./dist
# Caption fonts for the Editor (SIL OFL; licence files shipped next to them). Read-only data.
COPY --chown=node:node assets ./assets
# libass picks a FALLBACK font per character through fontconfig (Latin from Geist, Hindi from Noto
# Devanagari). Alpine has no system fonts, so without this fontconfig knows no fonts at all and
# Hindi captions render as empty boxes. Point it at our bundled fonts and build its cache.
RUN mkdir -p /etc/fonts/conf.d \
 && printf '<?xml version="1.0"?>\n<!DOCTYPE fontconfig SYSTEM "fonts.dtd">\n<fontconfig><dir>/app/assets/fonts</dir><cachedir>/tmp/fontconfig</cachedir></fontconfig>\n' > /etc/fonts/conf.d/50-app-fonts.conf \
 && fc-cache -f /app/assets/fonts \
 && fc-list | grep -q 'Noto Sans Devanagari'
COPY --chown=node:node package.json ./

# The official node image ships a non-root `node` user (uid 1000). Never run as root:
# a container escape or RCE bug then starts with no privileges.
USER node
EXPOSE 4000

# The image knows how to check itself. HEALTH_PORT lets the worker (port 4001) reuse it.
# Node's built-in fetch: no curl/wget needed in the image.
HEALTHCHECK --interval=10s --timeout=3s --start-period=10s --retries=5 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.HEALTH_PORT||process.env.PORT||4000)+'/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

ENTRYPOINT ["/sbin/tini", "--"]
# exec form + `node` directly (not `npm start`): node itself receives SIGTERM, so graceful shutdown runs.
# Worker: same image, command overridden to ["node", "dist/worker.js"].
CMD ["node", "dist/server.js"]
