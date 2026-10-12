# 03 — Observability + Benchmarks — Learnings

## What got built
- **Logging:** pino structured JSON logs, one line per request, secrets redacted (cookies, auth header, password fields). Pretty in dev, raw JSON in prod, silent in tests.
- **Request IDs:** `X-Request-Id` middleware — reuses a safe incoming id (e.g. from an AWS ALB), else generates a UUID. Echoed in the response header and included in every log line and in 500 bodies.
- **Metrics:** `GET /metrics` (prom-client) — `http_request_duration_seconds` histogram + `http_requests_total`, labelled by **route pattern**; business counters (`auth_events_total`, `credits_debited_total`, `credits_granted_total{reason}`, `credit_debit_rejected_total`); Node default metrics. Bearer-token protected, token required in prod.
- **Benchmark harness:** `npm run bench` (autocannon) — boots the compiled server in prod mode, runs fixed HTTP scenarios + a credit-ledger stress test, writes `docs/BENCHMARKS.md` + `api/bench/results.json` with machine specs and date.
- **Coverage:** `npm run test:coverage` (v8) with CI-enforced thresholds (90% lines / 80% branches).
- **Bundle budget:** `web/scripts/check-bundle-size.mjs` fails if initial gzipped JS > 120 kB. Wired into CI.
- CI now runs coverage + bundle budget and writes both into the GitHub step summary.

## The headline result: bcryptjs → native bcrypt
Phase 1 chose `bcryptjs` to dodge native builds in Alpine. Instrumenting the app exposed the cost of that choice, and the fix is a genuinely strong interview story.

**Isolated hash micro-benchmark** (8 concurrent, cost 12, measured event-loop delay):
| Implementation | hashes/s | event-loop p99 delay |
|---|---|---|
| bcryptjs (pure JS) | 3.7 | **808 ms** |
| native bcrypt | 21.2 | 11 ms |
| node:crypto scrypt (N=2¹⁷) | 12.0 | 11 ms |

**Why:** bcryptjs runs the hash **on the main thread**, so each hash freezes the single Node event loop for the whole ~200 ms. Native bcrypt hands the work to libuv's thread pool (4 threads by default), leaving the event loop free to serve other requests.

**End-to-end, measured before/after with the harness** (`GET /auth/me` at 50 conns while `POST /auth/login` runs at 10 conns, same machine):
| | bcryptjs | native bcrypt |
|---|---|---|
| `/auth/me` req/s during login load | 80 | **3,484** |
| `/auth/me` p99 during login load | 1,590 ms | **21 ms** |
| login req/s | 4 | **23** |

The hashes are cross-compatible (`$2b$` format), so this was a drop-in swap: one import line, no data migration, all 34 tests still green.

**Deviation note:** this reverses Phase 1's `bcryptjs` decision. The Alpine concern is handled instead by bcrypt 6's **prebuilt binaries** — it ships `linux-x64`/`linux-arm64` in both glibc and musl flavours, so `npm ci` needs no compiler. Verified: a clean `rm -rf node_modules && npm ci` loads the native module with no build step. We'll confirm it again inside the Alpine image in Phase 4.

## Decisions & trade-offs (interview material)

**1. Label by route PATTERN, not raw URL.** `http_request_duration_seconds{route="/jobs/:id"}`, never `/jobs/abc123`. Each distinct label set is a separate time-series in Prometheus; using raw URLs (or user ids) creates unbounded series and eventually OOMs the metrics backend. This is *the* classic metrics mistake. Unmatched routes collapse to `route="unmatched"`. There's a test asserting a raw id never appears in `/metrics`.

**2. Per-app Registry, not the global default.** prom-client has a global registry; using it means the second app built in a test throws "metric already registered". A `new Registry()` per `createApp` keeps tests isolated — the same dependency-injection discipline as the db/config.

**3. Histogram, not a gauge/average.** Averages hide tail latency. A histogram lets Prometheus compute any percentile (`histogram_quantile(0.99, ...)`) over any window. The bucket boundaries are chosen around our actual latencies (5 ms … 5 s).

**4. Constant-time token compare on `/metrics`.** `===` on strings can short-circuit on the first differing byte, a timing side-channel. `crypto.timingSafeEqual` always compares fully.

**5. Metrics/health excluded from access logs.** A load balancer hits `/health` every few seconds; logging those would bury real traffic and inflate log bills. They're still counted in metrics.

**6. requestId first in the middleware chain.** Even a request rejected by helmet/cors/rate-limit still gets an id, a log line, and a latency sample.

**7. Benchmark honesty.** The harness records CPU/RAM/OS/Node/date into the output, runs in `NODE_ENV=production` with logging ON (so logging cost is included), and the load generator shares the machine (noted as a conservative bias). The stress test *verifies correctness* (`SUM(ledger) == balance`, no negatives), so it's not just a speed number — it's a safety proof under load.

**8. scrypt was considered and rejected.** `node:crypto` has scrypt built in (no dependency at all) and is async/non-blocking. But bcrypt is the more widely recognised password-hashing choice and the existing `$2b$` hashes already work, so switching to native bcrypt was zero-migration. scrypt/argon2 noted as alternatives.

## Gotchas hit
- `req.route` is only set when a route matched; for routes mounted on a Router you need `req.baseUrl + req.route.path` to get the full pattern.
- A `$queryRaw` tuple destructure (`const [{x}] = ...`) is typed as possibly-undefined under `noUncheckedIndexedAccess`; read the row then coalesce.
- `--no-save` installs leave an *extraneous* package in `node_modules` but not in the lockfile; a clean `rm -rf node_modules && npm ci` is the only way to be sure the tree matches the lockfile. Did that before finalising.

## Follow-ups
- The `/auth/login` and credit-service paths increment counters; wire HTTP-level business metrics for the generation flow in Phase 2.
- In Phase 4, confirm the native bcrypt prebuild resolves inside `node:22-alpine` (musl). If it ever doesn't, the fallback is `node:22-slim` (glibc) or argon2.
- Consider `UV_THREADPOOL_SIZE` tuning in the container (default 4) once we know the Fargate task's vCPU count.
