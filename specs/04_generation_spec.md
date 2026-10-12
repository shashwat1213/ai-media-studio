# 04 — Generation + Jobs (Phase 2) — Spec

## What
1. A user types a prompt, picks a model and an aspect ratio, and clicks Generate.
2. The API **reserves the credits and creates a job in one DB transaction**, puts the job on a **BullMQ queue** (Redis), and answers `202 Accepted` immediately.
3. A separate **worker process** picks up the job, calls the AI provider, uploads the image to **S3 / MinIO (Silo)**, saves an `Asset` row and marks the job `DONE`.
4. If the job fails for good, the worker marks it `FAILED` and **refunds** the credits in the same transaction.
5. The UI polls the job until it finishes, then shows the image. A **gallery** lists every image the user has made.

## Why
- An AI image call takes 5–90 s. Holding an HTTP request open that long hits load-balancer timeouts (AWS ALB defaults to 60 s) and ties up the API. A queue lets the API answer in milliseconds and lets workers scale separately.
- Credits are money. They must never be lost, double-charged, or double-refunded, even when processes crash halfway.

## AI provider (researched 2026-10-12)
OpenRouter now has a dedicated **Image API**: `POST https://openrouter.ai/api/v1/images` with `{ model, prompt, aspect_ratio, n }`. It returns `{ data: [{ b64_json, media_type }], usage: { cost } }`. Billing is all-or-nothing: a failed generation returns 502 and is **not billed**.

The cheapest per-image models (from `GET /api/v1/images/models/{id}/endpoints`):

| Model | USD / image | Our price (credits) |
|---|---|---|
| `recraft/recraft-v4.1-flash` | 0.007 | 2 |
| `bytedance-seed/seedream-5-0-flash` | 0.018 | 5 |
| `qwen/qwen-image-3` | 0.03 | 8 |

Asymmetric pricing (spec §4a): a pricier model costs more credits. The catalog lives in code (`generation/models.ts`), so the price shown in the UI is always the price charged.

**Provider modes** (`AI_PROVIDER` env):
- `stub` (the default, and forced when `OPENROUTER_API_KEY` is empty): generates a real PNG locally (a gradient seeded from the prompt) after a short delay. **Costs nothing.** The UI shows a "Demo mode" banner so nobody mistakes it for real AI output.
- `openrouter`: real calls. Opt in only when you set a key.

## Data model
```prisma
enum JobStatus { QUEUED PROCESSING DONE FAILED }

model GenerationJob {
  id             String    @id @default(uuid())
  userId         String
  prompt         String
  model          String
  aspectRatio    String
  status         JobStatus @default(QUEUED)
  creditsCost    Int
  attempts       Int       @default(0)
  error          String?          // user-safe message, never a stack trace
  idempotencyKey String?
  startedAt      DateTime?
  finishedAt     DateTime?
  createdAt      DateTime  @default(now())
  updatedAt      DateTime  @updatedAt
  asset          Asset?
  @@unique([userId, idempotencyKey])
  @@index([userId, createdAt])
  @@index([status, updatedAt])     // for the stuck-job sweeper
}

model Asset {
  id         String   @id @default(uuid())
  userId     String
  jobId      String   @unique
  storageKey String   @unique      // users/<userId>/<jobId>.png
  mimeType   String
  bytes      Int
  width      Int?
  height     Int?
  createdAt  DateTime @default(now())
  @@index([userId, createdAt])
}
```
Hand-written SQL in the migration:
- `CHECK ("creditsCost" > 0)`, `CHECK (bytes > 0)`.
- **Partial unique index** `ON "CreditTransaction"("refId") WHERE reason = 'REFUND'`. The database itself guarantees a job can be refunded at most once.

## Credit flow (deviation from §6c, already logged in 01_scaffold_learnings)
`reserve → (success: keep) | (final failure: refund)`.
"Deduct on success" lets a user with 10 credits start five 10-credit jobs at once, because nothing is deducted yet when each check runs. Reserving inside the same transaction as job creation closes that race.

## Endpoints
| Method | Path | Notes |
|---|---|---|
| GET | `/generate/models` | Catalog + `mode: 'stub' \| 'openrouter'` |
| POST | `/generate` | `{ prompt (3–1000 chars), model, aspectRatio }`. Optional `Idempotency-Key` header. **202** `{ job }` |
| GET | `/jobs?limit&cursor&status` | Newest first, cursor pagination |
| GET | `/jobs/:id` | Polled by the UI. Includes `asset` with a signed URL once DONE |
| GET | `/assets?limit&cursor` | Gallery. Each item has a short-lived signed URL |
| GET | `/assets/:id` | One asset + signed URL |
| DELETE | `/assets/:id` | Deletes the object and the row. **No refund** (the work was done) |

Errors: 400 validation · 401 · **402 insufficient credits** · 404 not found *or not yours* (we don't reveal that someone else's id exists) · **409** same Idempotency-Key with a different body · **429** too many active jobs · 503 queue unavailable (credits refunded).

## Rules
- **Ownership.** Every query filters by `userId`. Another user's job or asset id returns 404.
- **Active-job cap** (`MAX_ACTIVE_JOBS_PER_USER`, default 3). The count runs *after* the credit debit has locked the user's row, so two parallel requests can't both see "2 active".
- **Idempotency-Key.** Retrying the same request with the same key returns the original job and doesn't charge again. Same key with a different prompt/model returns 409.
- **Queue down.** If Redis is down when enqueueing, the job is marked FAILED, credits are refunded, and the API returns 503.
- **Worker state machine.** Transitions are conditional updates (`UPDATE … WHERE status IN (…)`), so a duplicate delivery or a late retry can't move a DONE job backwards.
- **Retries.** Up to 3 attempts with exponential backoff for transient errors (network, 5xx, 429). Permanent errors (4xx, content policy) fail immediately.
- **Stuck-job sweeper.** Every minute, the worker fails and refunds jobs stuck in QUEUED/PROCESSING longer than `JOB_TIMEOUT_MINUTES` (default 10), e.g. after a crash or a Redis wipe. Credits can't stay locked forever.
- **Storage.** Objects are private. The browser only gets **presigned GET URLs** (15 min). Uploads stay server-side. Separate S3 clients are used for the internal endpoint (`minio:9000` inside Docker) and the public endpoint (`localhost:9000`) the browser can reach.
- **Worker observability.** A tiny HTTP server on `WORKER_PORT` (4001) serves `/health` and `/metrics`: job duration histogram, outcomes, provider latency.

## UI
- **/generate**: prompt textarea with a counter, model cards showing the credit cost, aspect-ratio toggle, Generate button disabled when the balance is too low. Below it, "Recent jobs" with live status badges (queued → processing → done/failed), the finished image inline, and the refund noted on failure.
- **/gallery**: responsive image grid, "Load more" (cursor), a lightbox with prompt, model, date and size, plus Download, Copy prompt, Delete (with confirm).
- **Dashboard**: the placeholder card becomes a "Generate" CTA plus a "Recent creations" strip.
- After a job finishes, the credit balance and history refresh automatically.

## Acceptance criteria
- [ ] POST /generate → 202. The balance drops by the cost, the ledger has a GENERATION row with `refId = jobId`, and the job is QUEUED.
- [ ] The worker turns it into DONE. The object exists in S3 and `GET /assets/:id` returns a URL that downloads a valid PNG.
- [ ] Provider failure on the final attempt → FAILED, plus exactly one REFUND row, and the balance is restored. Processing a second failure for the same job doesn't refund again (app check + DB index).
- [ ] Transient error → retried. Permanent error → no retry.
- [ ] **Concurrency:** 50-credit user, 10 parallel 10-credit generate requests → exactly 5 accepted, the rest 402 or 429, never negative.
- [ ] Idempotency: same key twice → one job, one charge. Same key with a different body → 409.
- [ ] User B can't see, poll or delete user A's jobs/assets (404).
- [ ] Redis unreachable → 503 and credits refunded.
- [ ] Sweeper refunds a stuck job exactly once.
- [ ] Tests run against real Postgres + Redis + Silo, locally and in CI. Coverage gate still ≥ 90% lines.
- [ ] Real end-to-end run: API + worker + web in a real browser (generate, watch the status change, see the image, open the gallery, delete).
