# 01 — Scaffold (Phase 0) — Learnings

## What got built
| Piece | Files | Verified |
|---|---|---|
| Express + TS API | `api/src/{app,server}.ts`, `config/env.ts`, `lib/prisma.ts`, `routes/health.ts` | typecheck, lint, 3 tests, build, real run |
| Prisma | `api/prisma/schema.prisma` (minimal `User`) | `prisma validate` + `generate` OK. **No migration yet** (needs compose Postgres, see Blockers) |
| React web | `web/` — Vite 8 + React 19 + Tailwind v4 + shadcn (button, card, badge) + TanStack Query | typecheck, lint, build (JS 93.7 kB gzip) |
| Infra | `docker-compose.yml` — postgres 16, redis 7.4, minio + one-shot bucket creator | `docker compose config` valid. **Not started yet** (see Blockers) |
| CI | `.github/workflows/ci.yml` — 2 parallel jobs (api, web) | Same commands pass locally. Runs on GitHub once pushed |

Real smoke results (compiled `dist/`, not ts-node):
- DB reachable → `GET /health` = `200 {"status":"ok","db":"up"}`
- DB unreachable → `503 {"status":"degraded","db":"down"}`
- Unknown route → `404 {"error":"Not found"}`; `X-Powered-By` header removed
- `DATABASE_URL=notaurl` → process refuses to boot with `Invalid url`
- Browser path `localhost:5173/api/health` → Vite proxy → Express → DB = 200

## Deviations from 00_PROJECT_BASE (logged per §12)
1. **Node 22 instead of 20.** Node 20 went end-of-life in April 2026, so it gets no security patches. Node 22 is the maintained LTS. Docker images will use `node:22-alpine`.
2. **Postgres host port 5433.** Port 5432 on this machine is already used by the PMS project's Postgres. Only the *host* side changes. Inside Docker, services still use `postgres:5432`.
3. **ESLint 10 / Vite 8 / React 19 / Express 5.** These are the current stable versions, and the spec didn't pin versions.
4. **Credits (decided now, built in Phase 2):** the spec says "deduct only on success, refund on failure", which contradicts itself. The plan is to **reserve credits when the job is created** (inside a DB transaction) and refund if the job fails. Otherwise a user with 10 credits could fire 5 parallel jobs costing 10 each, and every check would pass because nothing had been deducted yet. That bug is a race condition.

## Decisions worth explaining in an interview

**Why split `app.ts` from `server.ts`?**
`createApp()` only *builds* the Express app, and `server.ts` *listens on a port*. Tests import `createApp` and call it with supertest, so no real port is opened and no real DB is needed. The DB is passed in as a dependency (`{ db }`), so tests can pass a fake one. That's dependency injection in its simplest form.

**Why validate env with Zod at boot?**
This is "fail fast". A typo in `DATABASE_URL` should crash the app at startup with a clear message. Otherwise it shows up 3 hours later as a confusing error on the first request. On ECS a crashing task is easy to spot. A half-working one is not.

**Why does `/health` ping the database?**
Later, the ECS load balancer and Docker healthchecks will use this route to decide whether a container should get traffic. A container that is "running" but can't reach the DB shouldn't get traffic, so it returns 503.

**Why graceful shutdown (SIGTERM handler)?**
When ECS deploys a new version, it sends SIGTERM to the old container and waits before killing it. The handler stops taking new requests, lets in-flight ones finish, and closes the DB pool. Together with health checks, this is what gives zero-downtime rolling deployments.

**Why one `PrismaClient`?**
Each client opens a *pool* of DB connections. Creating one per request would exhaust Postgres's connection limit quickly.

**Why the Vite dev proxy (`/api` → `:4000`)?**
The browser only ever talks to one origin (`localhost:5173`). That means no CORS preflight in dev, and the httpOnly auth cookie (Phase 1) behaves the same way it will in prod behind a single domain.

**Why shadcn instead of a component library?**
shadcn copies the component *source* into `web/src/components/ui/`. We own the code, it's built on Radix (accessible) + Tailwind, and theming is just CSS variables in `index.css`.

## Docker concepts introduced (compose file)
- **Image vs container vs volume:** an image is a read-only template (like a class). A container is a running instance of it (like an object). A volume is storage that lives *outside* the container, so data survives the container being deleted.
- **Named volumes (`pgdata`, `miniodata`, `redisdata`):** `docker compose down` deletes containers but keeps named volumes, so DB data survives. `docker compose down -v` deletes the volumes too, and with them all the data.
- **Healthchecks:** `pg_isready`, `redis-cli ping`, `mc ready`. In Phase 4 the api will `depends_on: condition: service_healthy`, so it doesn't start before Postgres can actually accept connections. "Container started" and "DB ready" are not the same thing.
- **Service-name DNS:** inside the compose network, `minio-init` reaches MinIO at `http://minio:9000`. Docker's internal DNS resolves service names to container IPs. That's why `localhost` inside a container means *that container itself*, not your laptop.
- **Pinned tags** (`postgres:16.6-alpine`, not `latest`): the same compose file gives the same result next month.
- **One-shot container (`minio-init`):** runs `mc mb` to create the bucket, then exits. This is infra-as-code instead of clicking around a console.

## CI concepts introduced
- `npm ci` instead of `npm install`: installs exactly what's in `package-lock.json` and fails if it disagrees with `package.json`, so CI builds are reproducible.
- `concurrency: cancel-in-progress`: pushing twice quickly cancels the stale run.
- `permissions: contents: read`: the workflow token gets the least privilege it needs.
- The api and web jobs run in **parallel**, because they don't depend on each other.
- Postgres/Redis `services:` containers are **not** added yet. Phase 0 tests don't touch a DB. They arrive in Phase 1 along with the first integration tests.

## Incident: MinIO image no longer pullable (fixed)
**Symptom:** `docker compose up -d` failed with `pull access denied for minio/minio, repository does not exist or may require 'docker login'`. Compose aborted the whole stack, so postgres and redis were "Interrupted" too, and `prisma migrate` failed with P1001 (nothing listening on 5433).

**Root cause:** the image *reference* wasn't the problem. MinIO Inc. deleted the `minio/minio` and `minio/mc` repositories from Docker Hub (Sept 2026), and the MinIO community edition is archived and source-only. The error says "may require docker login", but logging in doesn't help, because the repo doesn't exist.

**Options considered:**
- `quay.io/minio/minio`, the old mirror: it now answers 401 to anonymous pulls (checked), and it would never get updates anyway.
- **`pgsty/silo`**, a community-maintained MinIO fork (~1.2M pulls, amd64 + arm64, latest release 2026-09-16). **Chosen.** It keeps the same S3 API, `MINIO_ROOT_*` env vars, `server /data --console-address` command and `/minio/health/live` route, so our app code and the AWS SDK config don't change at all.

**Changes:**
- `minio` service image: `pgsty/silo:RELEASE.2026-09-16T00-00-00Z`, pinned to an exact release tag rather than `latest`.
- `minio-init` reuses the same image (it bundles `mc`), so the dead `minio/mc` image is gone and there's one less image to pull.
- The healthcheck now uses `curl -fsS http://localhost:9000/minio/health/live` (curl ships in the image).

**Verified:** `docker compose config` is valid, and every image in it returns HTTP 200 from the Docker Hub registry manifest API (anonymous). That's the same check `docker pull` does first.

**Interview lesson:** pin image versions, *and* remember that a pinned tag only protects you if the registry still hosts it. For anything critical, mirror base images into your own registry (in AWS that's ECR, which we use in Phase 5). It also shows why we wrote storage code against the **S3 API** and not a vendor: swapping MinIO for Silo locally, or for AWS S3 in prod, needs zero code changes.

## Stack verified running (after `docker compose up -d`)
- Host ports listening: 5433 (postgres), 6379 (redis), 9000/9001 (Silo S3 API / console)
- Redis `PING` → `PONG`; Silo `/minio/health/live` → 200; console → 200
- Bucket check with a **signed** S3 request (`curl --aws-sigv4`): `HEAD /ai-media-assets` → 200, `HEAD /does-not-exist-xyz` → 404. So `minio-init` really created the bucket. (An anonymous request gets 403 for both, which proves nothing. That's why a signed request was needed.)
- `prisma migrate status` → 1 migration (`20261012073809_init`: `User` table + unique index on `email`), "Database schema is up to date"
- Compiled API against compose Postgres: `GET /health` → `200 {"status":"ok","db":"up"}`

## Next steps
- Push to GitHub so CI runs for real.
- Phase 1: auth + credits.
- (Optional) `sudo usermod -aG docker $USER` + re-login, so compose works without sudo.
