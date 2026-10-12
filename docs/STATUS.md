# Status & Next Steps (handoff)

_Last updated: 2026-10-12 (Phase 2 complete)_

## Where things stand
| Branch | State | Contents |
|---|---|---|
| `main` | pushed, CI green | Phase 0 (scaffold) + Phase 1 (auth + credits) + observability, all merged |
| `feat/generation` | pushed, PR #3 (draft), CI green | **Phase 2: generation + jobs** |

Phase 2 is built and verified end-to-end. Nothing destructive pending.

## Local run (3 processes + infra)
```
docker compose up -d                 # postgres :5433, redis :6379, silo/minio :9000/:9001
cd api && npm run dev                 # API on :4000
cd api && npm run dev:worker          # worker on :4001 (/health, /metrics)
cd web && npm run dev                 # UI on :5173
```
Default is **stub mode** (free fake images). For real AI: set `AI_PROVIDER=openrouter` + `OPENROUTER_API_KEY` in `api/.env`.

## Verify commands
```
cd api && npm run typecheck && npm run lint && npm run test:coverage && npm run build
cd web && npm run typecheck && npm run lint && npm run build && npm run size
cd api && npm run bench:pipeline      # job pipeline throughput (optional, needs infra up)
```
Currently: api 83 tests pass, 93% lines; web builds, initial JS ~102 kB gzip.

## Next steps
1. Review PR #3, mark ready, merge into `main` (same flow as Phase 1).
2. **Phase 3 (optional): Payments** — Razorpay test-mode order + verify → grant credits (PURCHASE ledger reason already exists).
   Or skip to **Phase 4: Dockerize fully** — multi-stage Dockerfiles for api/worker/web, harden compose, image-size pass (resume metric).
3. **Phase 5: CI/CD + AWS** — ECR, ECS Fargate (api + worker services), RDS, S3, ElastiCache/Redis, OIDC deploy, `COST.md`.

## Pending verification (future phases)
- Native bcrypt prebuild inside `node:22-alpine` (musl) — Phase 4.
- Docker image-size before/after — Phase 4.
- "Deployed on AWS" / uptime / cost — Phase 5.
