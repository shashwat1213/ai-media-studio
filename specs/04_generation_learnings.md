# 04 — Generation + Jobs (Phase 2) — Learnings

## What got built
**API**
- `GET /generate/models` (catalog + provider mode), `POST /generate` (202 + reserve), `GET /jobs`, `GET /jobs/:id`, `GET /assets`, `GET /assets/:id`, `DELETE /assets/:id`
- `src/modules/generation/*`: `models.ts` (priced catalog), `providers/` (stub + OpenRouter behind one interface), `queue.ts` (BullMQ producer), `generation.service.ts` (reserve+create+enqueue, listing, delete), `generation.routes.ts`, `processor.ts` (one attempt of a job, pure), `worker.ts` (BullMQ wiring + sweeper + worker HTTP), `job-lifecycle.ts` (fail+refund, exactly once)
- `src/lib/redis.ts`, `src/lib/storage.ts` (AWS SDK v3; MinIO/Silo locally, S3 in prod)
- `src/worker.ts`: the separate worker entrypoint (`npm run start:worker`)
- Migration `20261012093219_generation_jobs`: `JobStatus` enum, `GenerationJob` + `Asset`, CHECK constraints, and a **partial unique index** (one REFUND per job)

**Web**
- `/generate` (prompt form with RHF+Zod, model cards, aspect toggle, live "Recent generations"), `/gallery` (grid + "Load more" + lightbox with download/copy/delete), dashboard updated (Create CTA + recent strip)
- `features/generation/*`: TanStack Query hooks (`useRecentJobs`/`useJob` with self-stopping polling, `useGenerate`, `useAssets` infinite query, `useDeleteAsset`), `job-card`, `job-status-badge`, `asset-lightbox`, `generate-form`

## Verified (real runs, not assumptions)
- **49 new tests** (83 total), all against **real Postgres + real Redis + real Silo/MinIO** (no mocks for the infra). Coverage 93% lines / 89% branches (gate 90/80).
  - API: reserve-then-create order, per-model pricing, 402, the active-job cap (incl. two concurrency tests), Idempotency-Key (replay, 409, parallel race, per-user, malformed), 503+refund on a down queue, ownership 404s, cursor pagination, signed-URL fetch + tamper rejection, delete removes object + no refund.
  - Worker: happy path, skip-when-finished, retry vs permanent, unknown-error masking, empty-image rejection, the sweeper-wins-the-race case, refund-exactly-once (10 parallel + the DB index), the sweeper.
  - Provider: OpenRouter request shape + base64 decode + status→retry mapping + timeout, all with a **faked fetch so no money is spent**. Config refuses to boot with `AI_PROVIDER=openrouter` and no key.
  - End-to-end through **real BullMQ**: a job runs to DONE with a downloadable PNG; a `[flaky]` job is retried 3× then FAILED + refunded once; 12 parallel jobs across 4 users all finish with zero ledger drift; worker `/health` + `/metrics`.
- **Real servers, curl:** register → `POST /generate` 202 (`Location: /jobs/<id>`) → polled QUEUED→PROCESSING→DONE → signed URL downloaded a `512×288 PNG` → balance 50→45 with a GENERATION −5 ledger row.
- **Real browser (headless Chrome through the Vite proxy):** register → Generate; client validation; pick Qwen (button read "Generate · 8 credits"); job appeared and the **image rendered in place via polling, no reload**; a `[fail]` job showed "2 refunded" and the balance was restored; **Ctrl+Enter** generated a second image; gallery grid + lightbox (prompt, model, 512×288, 74 KB) + delete-with-confirm dropped the grid to 1; dashboard ledger showed the REFUND row; mobile (390px) kept the header nav with no overflow. Only console error is the expected logged-out 401 from `/auth/me`.
- **Pipeline benchmark** (stub at 0 ms, so it measures OUR overhead, not AI): 200 jobs, **22–27 jobs/s**, per-job 41–297 ms depending on worker concurrency, **0 failures, 0 ledger drift** every run. Throughput is bounded by single-instance MinIO PUT latency, which is the honest story.

## Decisions & trade-offs (interview material)

**1. Reserve credits on create, refund on failure — not "deduct on success".**
"Deduct on success" has a race: a user with 10 credits fires five 10-credit jobs at once, and because nothing is deducted yet, all five checks pass. We reserve (debit) inside the *same transaction* that creates the job. The debit's atomic conditional UPDATE (from Phase 1) locks the user row, so parallel requests serialise and the balance can't go negative. Logged earlier in `01_scaffold_learnings.md §4`; built here.

**2. The active-job cap is counted AFTER the debit, inside the same transaction.**
The debit takes the user's row lock first; only then do we `count` active jobs. If we counted first, two parallel requests could both read "2 active" and both create a 3rd. Same check-then-act lesson as credits — the fix is to do the check while holding the lock.

**3. Only the job id travels through Redis; the DB row is the source of truth.**
If the queue payload also held the prompt/model, there'd be two copies that could disagree. The worker re-reads the row from Postgres. BullMQ's `jobId = our job id`, so a retried enqueue is a no-op (no duplicate runs).

**4. Exactly-once refund, two independent guards.**
(a) `failAndRefund` flips the job to FAILED with a conditional UPDATE (`WHERE status IN (QUEUED,PROCESSING)`); only the first caller matches, everyone else refunds nothing. (b) A **partial unique index** `ON "CreditTransaction"(refId) WHERE reason='REFUND'` means the database rejects a second refund row even if app logic has a bug. Both are tested (10 parallel calls → 1 refund; a hand-written 2nd insert → unique violation).

**5. The worker is a separate process/container from the API.**
A slow AI call (5–90 s) or a CPU-heavy decode must never make the API slow. They scale independently (`WORKER_CONCURRENCY`, more worker tasks on ECS). They share one codebase + Docker image, different start command — simpler to reason about and to deploy.

**6. Crash-safe worker state machine.**
Every transition is a guarded conditional update, and the storage key is deterministic (`users/<user>/<job>.<ext>`). So: a duplicate delivery of a finished job is skipped; a retry after a crash overwrites the same object instead of leaking a second; and if the sweeper failed+refunded a job while the worker was mid-flight, the final `PROCESSING→DONE` update matches 0 rows and the result is discarded (we delete the just-uploaded object) — the user is never handed a refunded job for free. There's a test for that exact race.

**7. Retryable vs permanent errors.**
`ProviderError` carries `retryable`. Network blips, 5xx and 429 retry with exponential backoff (BullMQ, 3 attempts). 4xx / content-policy fail immediately — retrying a rejected prompt just wastes time and money. Unknown errors are treated as retryable but their message is replaced with a generic one, so provider internals never reach the user.

**8. Stuck-job sweeper.**
If a worker dies after reserving credits but before finishing, or Redis is wiped, a job could hold credits forever. A sweeper (every 60 s) fails+refunds anything active and untouched past `JOB_TIMEOUT_MINUTES`, re-checking the cutoff inside the update so it can't race a job that just progressed. It reuses the same exactly-once `failAndRefund`.

**9. Private objects + presigned URLs, with two S3 clients.**
The bucket is private; the browser only ever gets a presigned GET URL (15 min). The signature covers the Host header, so a URL signed for `minio:9000` (the server's internal endpoint inside Docker) is invalid from the browser. We keep two clients: one for the internal endpoint (uploads, deletes) and one signed for the public endpoint (`localhost:9000` locally, the CDN/S3 host in prod). Tested: the signed URL downloads the bytes, a tampered signature gets 403.

**10. Idempotency-Key.**
The UI sends a fresh uuid per click. A dropped-then-retried request returns the original job (200) instead of charging twice; the same key with a different body is a 409; the `@@unique([userId, idempotencyKey])` index also makes parallel duplicates collapse to one (P2002 → replay). Keys are per-user, so two users can't collide.

**11. Stub provider is the default and is genuinely free.**
No key ⇒ stub, always (two independent guards: `providerMode()` and the Zod refine). The stub renders a real, valid PNG (a prompt-seeded gradient with soft circles) so the *entire* pipeline is exercised with zero spend. `[fail]` / `[flaky]` hooks let us demo the failure+refund paths. The UI shows a "Demo mode" banner so the output is never mistaken for real AI.

**12. Self-stopping polling instead of websockets.**
A job's status changes a handful of times. TanStack Query's `refetchInterval` returns `1500` while any job is active and `false` once everything is finished, so polling stops on its own. Far simpler than a websocket for this shape of data, and it survives reconnects for free. When a watched job transitions to finished, we invalidate `['auth','me']`, `['credits']` and the gallery exactly once (not every poll).

**13. CI: `services:` for Postgres/Redis, `docker run` for Silo.**
GitHub `services:` can't pass a container command, and Silo needs `server /data`. So Postgres + Redis are `services:` (with healthchecks), and Silo is started as an explicit `docker run` step with a health-wait loop. The tests point at all three via `TEST_*` env vars.

## Deviations from 00_PROJECT_BASE
- **OpenRouter dedicated Image API** (`POST /api/v1/images`, base64 out), not the old `/chat/completions` + `modalities:['image']` pattern — that's deprecated and 500s on newer models (researched 2026-10-12).
- **Cheapest models researched live:** `recraft/recraft-v4.1-flash` ($0.007), `seedream-5-0-flash` ($0.018), `qwen/qwen-image-3` ($0.03). Our credit prices (2/5/8) are asymmetric per §4a.
- **Redis offline queue stays ON for the producer.** BullMQ issues commands the instant a `Queue` is constructed, before the socket connects; with ioredis' offline queue OFF those are rejected immediately and the Queue can't even be built. Fail-fast is instead enforced by `maxRetriesPerRequest: 1` + a hard `withTimeout` around `enqueue()`.

## Known gaps / follow-ups
- Orphaned objects: if `DELETE /assets/:id` removes the row but the S3 delete then fails, the object is left behind (logged, harmless). A periodic reconciliation job could sweep objects with no matching row. Out of scope now.
- Signed-URL TTL is 15 min; a lightbox left open longer needs a refetch (the gallery already refetches every 10 min).
- Payments (Phase 3) will add a PURCHASE path to top up credits; the ledger + `CreditReason.PURCHASE` already support it.
