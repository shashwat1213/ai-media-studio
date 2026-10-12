import { randomUUID } from 'node:crypto';
import type { RequestHandler } from 'express';
import type { Logger } from 'pino';
import { pinoHttp } from 'pino-http';
import type { Metrics } from './metrics.js';

// Accept a caller-supplied id only if it's short and safe (it ends up in logs + headers).
const SAFE_ID = /^[A-Za-z0-9._-]{1,64}$/;

/**
 * Request id + access log + latency metrics in one middleware.
 * - X-Request-Id: reuse a valid incoming id (e.g. from the AWS load balancer) or generate one.
 * - pino-http: one structured log line per request, tagged with that id.
 * - On 'finish': record duration under the ROUTE PATTERN (/jobs/:id), not the raw URL.
 *   Raw URLs would create one time-series per id = unbounded "cardinality explosion".
 */
export function httpObservability(logger: Logger, metrics: Metrics): RequestHandler[] {
  const requestId: RequestHandler = (req, res, next) => {
    const incoming = req.headers['x-request-id'];
    const id = typeof incoming === 'string' && SAFE_ID.test(incoming) ? incoming : randomUUID();
    req.id = id;
    res.setHeader('X-Request-Id', id);
    next();
  };

  const accessLog = pinoHttp({
    logger,
    genReqId: (req) => req.id as string,
    customLogLevel: (_req, res, err) => (err || res.statusCode >= 500 ? 'error' : res.statusCode >= 400 ? 'warn' : 'info'),
    autoLogging: { ignore: (req) => req.url === '/metrics' || req.url === '/health' }, // probes would drown real traffic
    serializers: {
      req: (req) => ({ id: req.id, method: req.method, url: req.url }),
      res: (res) => ({ statusCode: res.statusCode }),
    },
  });

  const timing: RequestHandler = (req, res, next) => {
    const end = metrics.httpDuration.startTimer();
    res.on('finish', () => {
      // req.route is set only when a route matched. Router-mounted paths need baseUrl too.
      const route = req.route?.path ? `${req.baseUrl}${String(req.route.path)}` : 'unmatched';
      const labels = { method: req.method, route, status_code: String(res.statusCode) };
      end(labels);
      metrics.httpTotal.inc(labels);
    });
    next();
  };

  return [requestId, accessLog, timing];
}
