# Resume Metrics — AI Media Studio

Every number here comes from a command you can re-run. **Hardware matters**, so quote it with the number, or say "on my dev machine". Never put a number on your resume you can't reproduce in an interview.

Measured on: AMD Ryzen 7 170 (16 threads), 30 GB RAM, Node 24, Postgres 16 (Docker), single API process. Load generator on the same machine (so real-world numbers on separate hosts would be higher).

---

## 1. Password hashing: native bcrypt keeps the API responsive under login load

The headline engineering result. We switched from `bcryptjs` (pure JavaScript) to native `bcrypt`, which runs hashing on libuv's thread pool instead of blocking the single Node.js event loop. Same load, same machine, measured before and after:

| Metric (during a burst of logins) | bcryptjs (pure JS) | native bcrypt | Improvement |
|---|---|---|---|
| Other requests served (`GET /auth/me`) | 80 req/s | **3,484 req/s** | **~43×** |
| p99 latency of those requests | 1,590 ms | **21 ms** | **~75× lower** |
| Login throughput (10 conns) | 4 req/s | **23 req/s** | **~5×** |

**Reproduce:** `cd api && npm run build && npm run bench` → see the "during login load" row in `docs/BENCHMARKS.md`. The isolated hash micro-benchmark (`bcryptjs 3.7 hash/s, event loop blocked 808 ms` vs `native bcrypt 21 hash/s, event loop 11 ms`) is written up in `specs/03_observability_learnings.md`.

**Resume line (honest):**
> "Diagnosed event-loop blocking from pure-JS bcrypt under concurrent logins; switched to native bcrypt (hashing on the libuv thread pool), cutting p99 latency of concurrent requests from ~1,600 ms to ~20 ms (measured with autocannon)."

---

## 2. Read-path throughput (single process)

| Endpoint | Req/s | p99 |
|---|---|---|
| `GET /health` (DB `SELECT 1`) | ~9,100 | 8 ms |
| `GET /auth/me` (JWT + 1 indexed read) | ~4,600 | 13 ms |
| `GET /credits` (JWT + balance + 20 ledger rows) | ~3,700 | 17 ms |

**Reproduce:** `npm run bench`. **Resume line:** "Authenticated JSON endpoints sustain ~4k req/s at p99 < 20 ms on a single Node process (autocannon, local)."

---

## 3. Correctness under concurrency (the one that impresses senior engineers)

The atomic credit ledger holds under heavy contention — no overspend, no drift, no negative balances.

| Test | Result |
|---|---|
| 10 concurrent debits on a 50-credit balance | exactly 5 succeed, 5 rejected, balance 0 (unit test) |
| 2,000 debits @ 50 concurrent on **one** hot row | exactly 1,000 succeed; `SUM(ledger) == balance`; 0 negatives; ~1,400 debits/s |
| 5,000 debits @ 50 concurrent across 50 users | all 5,000 succeed; 0 drift; ~3,700 debits/s |

**How:** a single atomic `UPDATE "User" SET credits = credits - $n WHERE id = $id AND credits >= $n`, plus a ledger row, in one transaction. Postgres row locking serialises it, so no check-then-act race. Belt and braces: DB `CHECK (credits >= 0)`.

**Reproduce:** `npm test` (unit) + the stress section of `npm run bench`. **Resume line:** "Designed a credit-metering ledger that stays correct under concurrency — verified with a 2,000-operation stress test on a single contended row showing zero overspend and zero balance drift."

---

## 4. Test coverage & quality gates

| Metric | Value |
|---|---|
| Integration tests | **34**, against a real Postgres (not mocks) |
| Line coverage | **~93%** (CI fails under 90% lines / 80% branches) |
| CI jobs | api + web in parallel: typecheck, lint, test+coverage, build; api runs a Postgres service container |
| Web bundle (initial JS, gzip) | **~102 kB** (CI budget 120 kB), 13 route-split chunks |

**Reproduce:** `cd api && npm run test:coverage`; `cd web && npm run build && npm run size`.

---

## 5. Observability (what you'd say about "production readiness")

- Structured JSON logs (pino), one line per request, secrets redacted.
- Request IDs (`X-Request-Id`) echoed in responses and 500 bodies, so a user report maps to one log line.
- Prometheus `/metrics`: latency histogram (p50/p95/p99 by route pattern, bounded cardinality) + business counters (auth events, credits granted/debited/rejected) + Node process metrics. Token-protected.

**Reproduce:** `curl -H "Authorization: Bearer $METRICS_TOKEN" localhost:4000/metrics`.
**Resume line:** "Instrumented the API with Prometheus metrics (RED method + business counters) and correlated structured logging via request IDs."

---

## 6. Async job pipeline (Phase 2): queue → worker → storage, correct under load

A real background pipeline: `POST /generate` reserves credits + enqueues (BullMQ/Redis), a separate worker calls the provider, uploads to S3/MinIO, records the asset, and keeps the credit ledger exactly right. Measured with the stub provider at **0 ms delay**, so these numbers are OUR overhead (queue + Postgres + S3 round-trips), not AI speed.

| Worker concurrency | Throughput | Per-job p50 / p95 | Correctness (200 jobs, 20 users) |
|---|---|---|---|
| 1 | ~22 jobs/s | 41 / 47 ms | 0 failed · 0 ledger drift |
| 4 | ~27 jobs/s | 108 / 146 ms | 0 failed · 0 ledger drift |
| 8 | ~25 jobs/s | 250 / 297 ms | 0 failed · 0 ledger drift |

Throughput plateaus around single-instance MinIO's PUT latency (the honest bottleneck — a real S3 or more worker tasks would scale further). The point that matters: **every run finished all 200 jobs with zero overspend and `SUM(ledger) == balance` for every user.**

Correctness properties verified by tests (real Postgres + Redis + S3, not mocks):
- **Reserve-then-refund** credit flow; 10 parallel generate requests on a 50-credit balance → exactly the affordable number succeed, never negative.
- **Exactly-once refund** on failure — enforced twice: a guarded status transition AND a partial unique index in Postgres (`one REFUND row per job`). 10 concurrent refund attempts → 1 refund.
- **Idempotency-Key**: a retried request returns the same job, charged once; parallel duplicates collapse to one.
- **Crash-safe**: deterministic storage keys + guarded transitions mean a retry overwrites instead of leaking, and a job the sweeper already refunded can't be delivered for free.

**Reproduce:** `cd api && npm run bench:pipeline` (needs the compose infra up) → `bench/pipeline-results.json`; correctness in `npm test` (`generation.test.ts`, `worker.test.ts`).
**Resume line (honest):** "Built an async image-generation pipeline (BullMQ/Redis worker + S3) with a reserve/refund credit ledger that stays correct under concurrency — exactly-once refunds guarded by both application logic and a Postgres partial-unique index, verified with a 200-job pipeline and parallel-request tests showing zero overspend and zero ledger drift."

---

## 7. Docker (Phase 4): multi-stage images, 69% smaller, non-root, one-command stack

| Image | On disk | Compressed (registry/pull) |
|---|---|---|
| api, naive single-stage | 1.11 GB | 300 MB |
| api, multi-stage + pruned (shipped) | **346 MB** | **79 MB** |
| web, nginx-unprivileged + static build | **92 MB** | 26 MB |

- api image **69% smaller on disk / 74% smaller compressed** than the naive build. The `node:22-alpine` base alone is 238 MB, so the app layer is ~108 MB.
- **8-service compose stack** (postgres, redis, minio, minio-init, migrate, api, worker, web) up with one command. Migrations run in a one-off container that api/worker wait for.
- All app containers **non-root** (uid 1000 / 101), tini as PID 1, graceful SIGTERM shutdown (exit 0, not 137).
- CI builds all images (buildx + layer cache) and runs a full-stack smoke test on every PR.

**Reproduce:**
```
docker build -f api/Dockerfile.naive -t ams-api:naive api
docker compose build && docker images | grep -E "ai-media-studio|ams-api"
docker image inspect <image> --format '{{.Size}}'   # compressed size
docker compose up -d --build && ./scripts/smoke.sh
```
**Resume line (honest):** "Containerized a 4-process app (API, BullMQ worker, migrations, nginx SPA) with multi-stage Docker builds, cutting the API image from 1.11 GB to 346 MB (−69%); non-root containers, graceful shutdown, and a CI pipeline that builds the images and smoke-tests the full docker-compose stack on every PR."

## Numbers you have NOT earned yet (do not claim until the phase is done)
- "Deployed on AWS", uptime, cost — needs Phase 5.
- Any user/traffic/revenue figure — this is a portfolio project; inventing these is the fastest way to fail an interview.
