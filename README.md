# AI Media Studio

Credit-based AI image generation SaaS — a portfolio project focused on **Docker, CI/CD and AWS (ECS Fargate)**.
Full spec: [`specs/00_PROJECT_BASE.md`](specs/00_PROJECT_BASE.md). Decision log: `specs/NN_*_learnings.md`.

## Stack
- **api/** — Express 5 + TypeScript (strict) + Prisma (PostgreSQL) + Zod, JWT httpOnly-cookie auth, atomic credit ledger, **BullMQ job queue, S3/MinIO storage, OpenRouter image generation (free stub mode by default)**
- **web/** — React 19 + Vite + Tailwind v4 + shadcn/ui + TanStack Query + React Router + React Hook Form/Zod
- **infra** — multi-stage Docker images (api/worker, migrator, nginx web), docker-compose (8 services), GitHub Actions CI (tests + image build + compose smoke test)

## Run with Docker (everything, one command)
Requires Docker with the buildx plugin.

```bash
docker compose up -d --build         # postgres, redis, minio, migrate, api, worker, web
open http://localhost:8080           # the app
./scripts/smoke.sh                   # end-to-end check through the containers
```

## Run natively (dev loop)
Requires Node 22+ and Docker.

```bash
cp .env.example .env && cp api/.env.example api/.env && cp web/.env.example web/.env
docker compose up -d postgres redis minio minio-init   # infra only: postgres :5433, redis :6379, minio :9000 (console :9001)

cd api && npm install
npx prisma migrate dev               # create tables
# tests use a separate DB (once): CREATE DATABASE ai_media_studio_test;
npm test                             # integration tests against real Postgres
npm run dev                          # http://localhost:4000/health
npm run dev:worker                   # background worker (http://localhost:4001/health)

cd ../web && npm install
npm run dev                          # http://localhost:5173
```

Image generation runs in **stub mode** by default (free, server-rendered placeholder images — the queue, worker, storage and credits are all real). For real AI, set `AI_PROVIDER=openrouter` and `OPENROUTER_API_KEY` in `api/.env`.

## Benchmarks & metrics
- `cd api && npm run build && npm run bench` → writes `docs/BENCHMARKS.md` (HTTP throughput/latency + credit-ledger stress test).
- `cd api && npm run bench:pipeline` → writes `bench/pipeline-results.json` (job queue→worker→storage throughput, correctness checks).
- Metrics: `GET /metrics` (Prometheus). Logs: structured JSON (pino) with per-request `X-Request-Id`.
- Resume-ready, reproducible numbers: `docs/RESUME_METRICS.md`.

## Checks (same as CI)
```bash
cd api && npm run typecheck && npm run lint && npm run test:coverage && npm run build
cd web && npm run typecheck && npm run lint && npm run build && npm run size
```

## Status
- [x] Phase 0 — scaffold
- [x] Phase 1 — auth + credits
- [x] Observability + benchmarks (pino, Prometheus, autocannon, coverage, bundle budget)
- [x] Phase 2 — generation + jobs (BullMQ worker, S3/MinIO, OpenRouter, gallery UI)
- [ ] Phase 3 — payments (optional)
- [x] Phase 4 — Dockerize fully (api image 1.11 GB → 346 MB, non-root, compose + CI smoke test)
- [ ] Phase 5 — CI/CD + AWS
