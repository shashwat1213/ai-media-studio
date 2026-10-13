import { describe, it, expect } from 'vitest';
import request from 'supertest';
import { createApp } from './app.js';
import { createLogger } from './observability/logger.js';
import { testConfig } from '../test/helpers.js';
import { loadEnv } from './config/env.js';
import { toAppConfig } from './config/app-config.js';

// Unit test (DB faked). The rate limiter keys on req.ip, so the number of trusted proxy hops
// decides whether two different users behind CloudFront -> ALB -> nginx share one limit.
function appWith(trustProxyHops: number | undefined, authRateLimit = 1) {
  return createApp({
    prisma: { $queryRaw: async () => [] } as never,
    config: { ...testConfig, trustProxyHops, authRateLimit },
    logger: createLogger('test'),
  });
}

// What X-Forwarded-For looks like when it reaches the API on AWS:
// CloudFront adds the client, the ALB adds the CloudFront edge, nginx adds the ALB.
const xff = (client: string) => `${client}, 130.176.0.10, 10.20.1.5`;

async function login(app: ReturnType<typeof appWith>, client: string) {
  return request(app)
    .post('/auth/login')
    .set('X-Forwarded-For', xff(client))
    .send({ email: 'nobody@example.com', password: 'x' });
}

describe('trust proxy hops', () => {
  it('defaults to 1 hop', () => {
    expect(appWith(undefined).get('trust proxy')).toBe(1);
  });

  it('with 1 hop behind 3 proxies, different users share ONE rate-limit bucket (the bug)', async () => {
    const app = appWith(1);
    await login(app, '203.0.113.1');
    const other = await login(app, '198.51.100.7');
    expect(other.status).toBe(429); // a different person is blocked by someone else's attempts
  });

  it('with 3 hops, each client gets its own bucket and the real IP is used', async () => {
    const app = appWith(3);
    await login(app, '203.0.113.1');
    const sameUser = await login(app, '203.0.113.1');
    const other = await login(app, '198.51.100.7');
    expect(sameUser.status).toBe(429);
    expect(other.status).not.toBe(429);
  });

  it('reads TRUST_PROXY_HOPS from the environment and rejects nonsense', () => {
    const base = { DATABASE_URL: 'postgresql://u:p@localhost:5432/db', JWT_SECRET: 'x'.repeat(32) };
    expect(toAppConfig(loadEnv({ ...base, TRUST_PROXY_HOPS: '3' })).trustProxyHops).toBe(3);
    expect(toAppConfig(loadEnv(base)).trustProxyHops).toBe(1);
  });
});
