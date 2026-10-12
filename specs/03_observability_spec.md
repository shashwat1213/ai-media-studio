# 03 — Observability + Benchmarks — Spec

## What
Make the API **measurable**, and produce **real, reproducible numbers** that can go on a resume honestly.

1. **Structured logging.** `pino` JSON logs, one line per request: method, route, status, duration, `requestId`. Pretty-printed in dev, JSON in prod (CloudWatch can query it).
2. **Request IDs.** Every request gets an `X-Request-Id` (we reuse the incoming one if it's valid, otherwise generate one), echoed in the response header and included in every log line and in 500 error bodies. A user's bug report can then be matched to the exact log line.
3. **Prometheus metrics** at `GET /metrics` (`prom-client`):
   - `http_request_duration_seconds` histogram, labelled `{method, route, status_code}`. `route` is the **pattern** (`/jobs/:id`), never the raw URL, so label cardinality stays bounded.
   - `http_requests_total` counter (same labels)
   - Business counters: `auth_events_total{event=register|login_success|login_failure}`, `credits_debited_total`, `credits_granted_total{reason}`, `credit_debit_rejected_total`
   - Default Node process metrics: event-loop lag, heap, GC, CPU
   - **Protected:** if `METRICS_TOKEN` is set, it must be sent as `Authorization: Bearer …`. It is required in production; the app refuses to boot without it.
4. **Load-test benchmarks** (`npm run bench`, autocannon): fixed scenarios, results written to `docs/BENCHMARKS.md` with machine specs + date.
5. **Coverage.** `npm run test:coverage` (v8), with thresholds enforced in CI so coverage can't silently drop.
6. **Bundle budget.** CI fails if the web entry JS chunk grows past a gzip budget.

## Why
- In production you can't fix what you can't see. Request IDs + structured logs + latency histograms are the standard trio.
- Resume numbers must come from a command anyone can re-run, with the hardware stated. No invented numbers.

## Non-goals
- Grafana dashboards / a Prometheus server. We expose metrics; scraping them in AWS is Phase 5 (CloudWatch).
- Distributed tracing (OpenTelemetry). It's a possible later extension and is logged as such.

## Acceptance criteria
- [x] Every response carries `X-Request-Id`, and the log line for it contains the same id.
- [x] `/metrics` returns Prometheus text format and contains the histogram + business counters. It returns 401 without the token when `METRICS_TOKEN` is set.
- [x] Unknown URLs are all recorded under one label (`route="unmatched"`), so there's no cardinality explosion.
- [x] Tests cover the above.
- [x] `npm run bench` produces p50/p95/p99 latency + req/s for each scenario, recorded in `docs/BENCHMARKS.md`.
- [x] Coverage thresholds are enforced. The bundle-size check runs in CI.
- [x] `docs/RESUME_METRICS.md` lists every claim with the exact command that proves it.
