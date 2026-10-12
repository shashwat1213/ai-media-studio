# AI Media Studio

Credit-based AI image generation SaaS — a portfolio project focused on **Docker, CI/CD and AWS (ECS Fargate)**.
Full spec: [`specs/00_PROJECT_BASE.md`](specs/00_PROJECT_BASE.md). Decision log: `specs/NN_*_learnings.md`.

## Stack
- **api/** — Express 5 + TypeScript (strict) + Prisma (PostgreSQL) + Zod · *(BullMQ, S3, OpenRouter from Phase 2)*
- **web/** — React 19 + Vite + Tailwind v4 + shadcn/ui + TanStack Query
- **infra** — docker-compose (Postgres, Redis, MinIO) · GitHub Actions CI

## Run locally
Requires Node 22+ and Docker.

```bash
cp .env.example .env && cp api/.env.example api/.env && cp web/.env.example web/.env
docker compose up -d                 # postgres :5433, redis :6379, minio/Silo :9000 (console :9001)

cd api && npm install
npx prisma migrate dev               # create tables
npm run dev                          # http://localhost:4000/health

cd ../web && npm install
npm run dev                          # http://localhost:5173
```

## Checks (same as CI)
```bash
cd api && npm run typecheck && npm run lint && npm test && npm run build
cd web && npm run typecheck && npm run lint && npm run build
```

## Status
- [x] Phase 0 — scaffold
- [ ] Phase 1 — auth + credits
- [ ] Phase 2 — generation + jobs
- [ ] Phase 3 — payments (optional)
- [ ] Phase 4 — Dockerize fully
- [ ] Phase 5 — CI/CD + AWS
