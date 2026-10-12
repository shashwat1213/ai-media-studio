import { Counter, Histogram, Registry, collectDefaultMetrics } from 'prom-client';

/**
 * Prometheus metrics. One Registry per app instance (not the global default)
 * so tests can create many apps without "metric already registered" errors.
 */
export function createMetrics() {
  const registry = new Registry();
  collectDefaultMetrics({ register: registry }); // event-loop lag, heap, GC, CPU, open handles

  const labelNames = ['method', 'route', 'status_code'] as const;

  return {
    registry,
    // Histogram -> lets Prometheus compute p50/p95/p99 over any time window.
    httpDuration: new Histogram({
      name: 'http_request_duration_seconds',
      help: 'HTTP request latency in seconds',
      labelNames,
      buckets: [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5],
      registers: [registry],
    }),
    httpTotal: new Counter({
      name: 'http_requests_total',
      help: 'Total HTTP requests',
      labelNames,
      registers: [registry],
    }),
    // Business metrics: what the product is actually doing, not just HTTP.
    authEvents: new Counter({
      name: 'auth_events_total',
      help: 'Auth events',
      labelNames: ['event'] as const,
      registers: [registry],
    }),
    creditsDebited: new Counter({
      name: 'credits_debited_total',
      help: 'Credits spent',
      registers: [registry],
    }),
    creditsGranted: new Counter({
      name: 'credits_granted_total',
      help: 'Credits granted',
      labelNames: ['reason'] as const,
      registers: [registry],
    }),
    debitRejected: new Counter({
      name: 'credit_debit_rejected_total',
      help: 'Debits rejected for insufficient credits',
      registers: [registry],
    }),
    // --- Phase 2: generation pipeline ---
    jobsCreated: new Counter({
      name: 'generation_jobs_created_total',
      help: 'Generation jobs accepted by the API',
      labelNames: ['model'] as const,
      registers: [registry],
    }),
    jobOutcomes: new Counter({
      name: 'generation_job_outcomes_total',
      help: 'Finished generation jobs by outcome',
      labelNames: ['outcome', 'model'] as const, // outcome: done | failed | retried | swept
      registers: [registry],
    }),
    jobDuration: new Histogram({
      name: 'generation_job_duration_seconds',
      help: 'Worker time per job attempt (provider call + upload + DB)',
      labelNames: ['outcome'] as const,
      buckets: [0.5, 1, 2.5, 5, 10, 20, 30, 60, 120],
      registers: [registry],
    }),
    providerDuration: new Histogram({
      name: 'ai_provider_request_duration_seconds',
      help: 'AI provider call latency',
      labelNames: ['provider', 'outcome'] as const,
      buckets: [0.5, 1, 2.5, 5, 10, 20, 30, 60, 120],
      registers: [registry],
    }),
    providerCostUsd: new Counter({
      name: 'ai_provider_cost_usd_total',
      help: 'USD reported by the AI provider (0 in stub mode)',
      registers: [registry],
    }),
    creditsRefunded: new Counter({
      name: 'credits_refunded_total',
      help: 'Credits refunded for failed jobs',
      registers: [registry],
    }),
  };
}

export type Metrics = ReturnType<typeof createMetrics>;
