# 05 — Dockerize fully (Phase 4) — Learnings

## What got built
- `api/Dockerfile`: multi-stage (`base` → `deps` → `build` → `prod-deps` → `migrator` / `runtime-deps` → `runtime`). Pinned `node:22.23.3-alpine3.24`, tini as PID 1, non-root `node` user, built-in `HEALTHCHECK`.
- **One image, three jobs**: the `runtime` target runs the API (`node dist/server.js`) *and* the worker (`node dist/worker.js`). The `migrator` target runs `prisma migrate deploy` once and exits.
- `web/Dockerfile`: Vite build → `nginxinc/nginx-unprivileged` (non-root, port 8080). `nginx.conf.template` handles the SPA fallback, `/api` reverse proxy, long-cache for hashed assets, no-cache for `index.html`, gzip and security headers.
- `docker-compose.yml`: 8 services — postgres, redis, minio, minio-init, **migrate, api, worker, web**. `docker compose up -d --build` → the whole app on http://localhost:8080.
- `scripts/smoke.sh`: register → generate → worker → download PNG → balance check → non-root check, all through nginx.
- CI `docker` job: buildx + GitHub Actions layer cache, builds all 3 images, `compose up --wait`, smoke test, tear down.
- `api/Dockerfile.naive`: the deliberately bad single-stage image, kept only as the "before" for the size comparison.

## Verified (real runs)
- **Image sizes** (`docker images` = uncompressed on disk; "compressed" = what a registry stores and ECS pulls):

  | Image | On disk | Compressed |
  |---|---|---|
  | api **naive** single-stage (`Dockerfile.naive`) | 1.11 GB | 300 MB |
  | api multi-stage, first attempt | 671 MB | — |
  | api multi-stage + prune (final `runtime`) | **346 MB** | **79 MB** |
  | web (nginx-unprivileged + static build) | **92 MB** | 26 MB |
  | migrator (one-off, keeps the Prisma CLI) | 671 MB | 158 MB |

  The api image is **69% smaller on disk, 74% smaller compressed** than the naive one. For context: the `node:22-alpine` base alone is 238 MB, so our app layer is only ~108 MB. Node's own binary (123 MB) is the biggest single thing left.
- `docker compose up -d --build` from scratch: every service healthy, `migrate` and `minio-init` exit 0, api/worker/web start only after their dependencies.
- **Non-root:** api + worker uid 1000 (`node`), web uid 101 (`nginx`). The smoke test enforces it.
- **Native bcrypt + Prisma's musl engine load inside Alpine.** This closes the open item from 03 learnings. Checked directly in the image (`bcrypt.hash` works, PrismaClient loads its engine) and end-to-end (register/login through the container).
- **Graceful shutdown:** `docker compose stop api worker` → both log `shutting down` (worker: "finishing in-flight jobs") and **exit 0**, not 137 (SIGKILL).
- **Browser E2E against the containers** (same script as Phase 2, pointed at :8080): register → generate (live status → image) → `[fail]` refund → Ctrl+Enter → gallery → lightbox → delete → dashboard ledger → mobile. All passed.
- **No secrets in images:** no `.env` files in any image (the only `*.pem` files are the base image's public CA certs), and 0 secret strings in `docker history --no-trunc`. No TypeScript sources or tests in the runtime image (`/app` = `dist`, `node_modules`, `package.json`).
- nginx: deep links (`/gallery`) → 200; hashed assets get `Cache-Control: public, max-age=31536000, immutable` + gzip; missing asset → 404 (not index.html); `Server: nginx` with no version; `/api/*` proxied with `X-Request-Id`.

## Decisions & trade-offs (interview material)

**1. Why multi-stage?**
The build needs TypeScript, type definitions, eslint and vitest (devDependencies) plus the TS source. The running app needs none of them. In a multi-stage build each `FROM` is a fresh image, and only what you `COPY --from=` carries over, so build tools never reach production. The result is smaller (faster pulls, faster ECS scale-out, cheaper registry storage) and safer (fewer packages = fewer CVEs and less for an attacker to use).

**2. Layer caching: copy manifests before source.**
`COPY package*.json` → `npm ci` → *then* `COPY src`. Docker caches layers top-down and reuses a layer if its inputs haven't changed. Editing a `.ts` file only rebuilds from `COPY src` down, so the slow install is skipped. A BuildKit cache mount (`--mount=type=cache,target=/root/.npm`) also keeps npm's download cache *between* builds without it ending up in any layer.

**3. Pruning what the runtime doesn't need (671 → 346 MB).**
`npm ci --omit=dev` still installed `prisma` (CLI, 67 MB), `typescript` (23 MB) and `effect` (34 MB), because they're optional *peer* dependencies of `@prisma/client`. Prisma also ships WASM query engines for every database (mysql, sqlite, sqlserver, cockroach…) for edge runtimes, ~50 MB. We run on Node with the native musl engine, so a `runtime-deps` stage deletes all of that plus source maps. Every deletion was verified by running the image, not assumed.

**4. Migrations as a separate one-off container.**
`migrate` runs `prisma migrate deploy` and exits. api/worker use `depends_on: migrate: condition: service_completed_successfully`, so code never starts against an old schema. It's its own build target, which keeps the Prisma CLI out of the long-running image. In ECS (Phase 5) this becomes a one-off task run before the service update. `migrate deploy` only applies committed migrations and never generates new ones, so it's safe to run in production.

**5. One image for API + worker.**
Same code, same dependencies, different `command`. Benefits: build, scan and push once; the two processes can't drift onto different versions of shared code (credit service, job lifecycle). They're still **separate containers** (one process per container) so they scale, restart and get resources independently.

**6. tini as PID 1 + `node` directly, not `npm start`.**
PID 1 in Linux ignores signals it has no handler for, and doesn't reap zombie processes. `npm start` would make npm PID 1, and npm doesn't reliably forward SIGTERM to node. Then `docker stop` waits 10 s and SIGKILLs (exit 137), killing in-flight requests/jobs. tini (PID 1) forwards signals and reaps zombies; node gets SIGTERM and our graceful-shutdown code runs. Verified with exit code 0. We first also had compose `init: true`, which added a *second* tini that warned on startup. One is enough, so it was removed.

**7. Non-root everywhere.**
If an attacker gets code execution inside a root container, they're one kernel bug away from the host. As uid 1000/101 they start with no privileges. nginx can't bind port 80 without root, which is why the unprivileged image listens on 8080. The port number doesn't matter behind a load balancer.

**8. Config at runtime, never at build time.**
No `.env` in any image (`.dockerignore`). Everything comes from env vars at `docker run`/ECS time, so the *same image* moves from CI → staging → prod. The one build-time value, `VITE_API_URL=/api`, is relative on purpose: nginx proxies `/api` to whatever `API_UPSTREAM` is at runtime (envsubst template), so the web image doesn't need rebuilding per environment either.

**9. Same-origin via nginx = no CORS, cookies just work.**
The browser only talks to `localhost:8080` (or the ALB in prod). nginx serves the SPA and forwards `/api/*` to the api container. It mirrors the Vite dev proxy exactly, so dev and Docker behave the same. The httpOnly cookie is first-party, with no `SameSite=None` needed.

**10. Two S3 endpoints (the Phase 2 design paying off).**
Inside Docker, api/worker reach MinIO at `http://minio:9000` (service DNS), but the *browser* can't resolve `minio`. Presigned URLs are signed for `S3_PUBLIC_ENDPOINT=http://localhost:9000`. In AWS both become the real S3 endpoint and the variables disappear.

**11. Caching strategy for the SPA.**
Vite content-hashes asset filenames, so `/assets/*` is `immutable` for a year. A changed file gets a new name. `index.html` is `no-cache`, so browsers always revalidate it and pick up a new deploy immediately. nginx gotcha: `add_header` in a `location` *replaces* the server-level headers, and `expires` emits its own `Cache-Control`. We hit the duplicate-header bug and fixed it.

**12. CI builds the real images.**
The `docker` job builds with buildx and a GitHub Actions layer cache (`type=gha`), loads the images, and runs the same `docker compose up --wait` + `scripts/smoke.sh` you run locally. What CI tests is byte-for-byte what Phase 5 will push to ECR.

## Deviations from 00_PROJECT_BASE
- **`node:22.23.3-alpine3.24`**, not node:20 (EOL), pinned to patch + Alpine release (01 learnings).
- **`nginxinc/nginx-unprivileged`** instead of `nginx:alpine`, so nginx runs non-root.
- **A `migrator` target + compose `migrate` service**, not specified in the base doc. It's how migrations run safely in containers and on ECS.
- Installed the **buildx** CLI plugin locally (`~/.docker/cli-plugins/docker-buildx`). The machine's Docker had only the legacy builder, which doesn't support `RUN --mount` cache mounts.

## Known gaps / follow-ups
- Image vulnerability scanning (Trivy/Grype) → add in Phase 5 when images are pushed to ECR (ECR also has built-in scanning).
- The compose file uses local default credentials (`studio`/`minioadmin`/a placeholder JWT secret). Fine for a laptop; Phase 5 injects real secrets from Secrets Manager.
- Multi-arch images (arm64 for Graviton/Fargate ARM, ~20% cheaper) → buildx `--platform linux/amd64,linux/arm64` in Phase 5.
