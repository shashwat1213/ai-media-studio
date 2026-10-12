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
  };
}

export type Metrics = ReturnType<typeof createMetrics>;
