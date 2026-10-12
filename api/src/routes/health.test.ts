import { describe, it, expect } from 'vitest';
import request from 'supertest';
import { createApp } from '../app.js';

function appWith(queryRaw: () => Promise<unknown>) {
  return createApp({ db: { $queryRaw: queryRaw } as never, corsOrigin: '*' });
}

describe('GET /health', () => {
  it('returns 200 when the database responds', async () => {
    const res = await request(appWith(async () => [{ '?column?': 1 }])).get('/health');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ status: 'ok', db: 'up' });
  });

  it('returns 503 when the database is down', async () => {
    const res = await request(
      appWith(async () => {
        throw new Error('connection refused');
      }),
    ).get('/health');
    expect(res.status).toBe(503);
    expect(res.body).toEqual({ status: 'degraded', db: 'down' });
  });

  it('returns 404 JSON for unknown routes', async () => {
    const res = await request(appWith(async () => [])).get('/nope');
    expect(res.status).toBe(404);
    expect(res.body).toEqual({ error: 'Not found' });
  });
});
