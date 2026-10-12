# 01 — Scaffold (Phase 0) — Spec

## What
Boot the skeleton of every moving part so later phases only add features, never plumbing.

- `/api` — Express + TypeScript (strict), Prisma initialised, `GET /health` route.
- `/web` — React + TypeScript + Vite + Tailwind v4 + shadcn/ui, a placeholder landing page that calls `/health`.
- `docker-compose.yml` — infra only for now: `postgres`, `redis`, `minio` (Silo image — see learnings) (+ healthchecks, named volumes).
- `.github/workflows/ci.yml` — type-check + lint + build for api and web.

## Why
- Proves the toolchain end to end on day 1 (cheap to fix now, expensive later).
- CI green from the first commit means every later PR is checked automatically.

## Decisions
| Decision | Choice | Reason |
|---|---|---|
| Node version | **22 LTS** (deviates from spec's node:20) | Node 20 reached end-of-life April 2026 — no more security patches. 22 is the current maintained LTS. |
| Layout | plain folders `/api`, `/web`, `/specs`, own `package.json` each | Easiest to explain; each folder maps 1:1 to a Docker image later. |
| Postgres host port | **5433** → container 5432 | Host 5432 is already used by another local Postgres (PMS project). Inside the compose network services still use 5432. |
| API port | 4000 | Avoids clashing with Vite (5173). |
| Config | `zod`-validated env in `api/src/config/env.ts` | App crashes at boot with a clear message if config is wrong, instead of failing later at random. |

## Data model
Prisma initialised with a minimal `User` model only (full model comes in Phase 1).

## Endpoints
- `GET /health` → `200 { status: "ok", db: "up" | "down" }` (db checked with `SELECT 1`; returns 503 if db down).

## Acceptance criteria
- [x] `npm run typecheck && npm run lint && npm run build` passes in `/api` and `/web`.
- [x] `npm test` in `/api` passes (health route test with supertest).
- [x] `docker compose up -d` brings postgres/redis/minio to *healthy*.
- [x] `npx prisma migrate dev` creates the first migration against compose Postgres.
- [x] `GET /health` returns `db: "up"` with compose running.
- [ ] CI workflow file is valid and runs the same commands. *(commands pass locally; first real run happens once pushed to GitHub)*
