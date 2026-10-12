import pino, { type Logger } from 'pino';

/**
 * Structured (JSON) logger. One JSON object per line is what log platforms
 * (CloudWatch Logs Insights, Loki, Datadog) can filter and aggregate:
 *   fields @timestamp, req.id, res.statusCode, responseTime | filter responseTime > 500
 * In dev we pretty-print for humans; in tests we stay silent.
 */
export function createLogger(nodeEnv: string, level?: string): Logger {
  return pino({
    level: level ?? (nodeEnv === 'test' ? 'silent' : 'info'),
    // Never log secrets, even by accident.
    redact: {
      paths: ['req.headers.cookie', 'req.headers.authorization', 'res.headers["set-cookie"]', '*.password', '*.passwordHash'],
      censor: '[redacted]',
    },
    transport: nodeEnv === 'development' ? { target: 'pino-pretty', options: { singleLine: true } } : undefined,
  });
}
