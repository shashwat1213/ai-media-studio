# 05 — Dockerize fully (Phase 4) — Spec

## What
1. **api image**: multi-stage Dockerfile (`deps` → `build` → slim `runtime`), non-root, prod deps + compiled `dist` only.
2. **worker**: the SAME api image, different start command (`node dist/worker.js`).
3. **web image**: multi-stage: Vite build → static files served by **unprivileged nginx** (non-root), with SPA fallback and a `/api` reverse proxy to the api container.
4. **Migrations** run as a one-off `migrate` service (`prisma migrate deploy`) that api + worker wait for.
5. **docker-compose.yml**: one command (`docker compose up -d --build`) brings up all 7 services: postgres, redis, minio, minio-init, migrate, api, worker, web.
6. **Measured image-size reduction** (naive single-stage vs multi-stage), a real resume number.
7. CI builds all images on every PR (no push yet; that's Phase 5) with layer caching, and smoke-tests the full stack with compose.

## Why
- The whole point of the project (learning goal #1): containerize a real multi-service app properly.
- Same image everywhere: what CI tests is byte-for-byte what ECS runs in Phase 5.

## Decisions to make + defend
- **Base image:** `node:22.23.3-alpine3.24` pinned to the patch + Alpine version (reproducible). Small, musl.
  - Risk: native `bcrypt` and Prisma engines on musl. Prisma already has `binaryTargets = ["native", "linux-musl-openssl-3.0.x"]`; bcrypt 6 ships musl prebuilds. **Verify inside the image** (03 learnings left this open).
- **Multi-stage**: compilers, devDependencies, TS sources and tests never reach the runtime image.
- **Non-root**: run as the image's built-in `node` user (uid 1000). nginx: `nginxinc/nginx-unprivileged` (port 8080, non-root).
- **One image, two processes** (api + worker): less to build/push/scan; the code they share can't drift. Separate *containers* still (one process per container).
- **Config at runtime, never baked in**: no `.env` in the image (`.dockerignore`), all config from env vars. The web image uses `VITE_API_URL=/api` (same-origin via nginx proxy), so the image is environment-agnostic.
- **PID 1 + signals**: `node` run directly (not via `npm`), so SIGTERM reaches our graceful-shutdown handler. `init: true` in compose adds tini for zombie reaping.
- **Healthchecks** in the image (`HEALTHCHECK`) and compose `depends_on: condition: service_healthy / service_completed_successfully`.
- **Two S3 endpoints in compose**: api/worker talk to `http://minio:9000` (container DNS); presigned URLs are signed for `http://localhost:9000` (what the browser reaches). Phase 2's two-client design pays off here.

## Acceptance criteria
- [ ] `docker compose up -d --build` from a clean state → all services healthy, `migrate` exits 0.
- [ ] Browser at http://localhost:8080: register → generate → image appears → gallery. (Real E2E against the containers.)
- [ ] api + worker run as non-root (uid 1000); nginx as non-root.
- [ ] Native bcrypt + Prisma engine load inside Alpine (login works in the container).
- [ ] `docker stop` → graceful shutdown log line, exit code 0 (not 137).
- [ ] Image sizes measured: naive vs multi-stage, recorded in RESUME_METRICS with the commands to reproduce.
- [ ] No secrets in any image layer (`docker history` / file listing check).
- [ ] CI: builds api + web images (buildx + GHA cache) and runs a compose smoke test.
