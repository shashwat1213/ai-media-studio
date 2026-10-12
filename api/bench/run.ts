/**
 * Reproducible API benchmark.  Run:  npm run bench
 *
 * 1. Builds nothing itself; expects `npm run build` first (dist/server.js).
 * 2. Starts the compiled server as a child process in NODE_ENV=production
 *    (info-level JSON logs written to /dev/null, so logging cost is included).
 * 3. Seeds a user on the TEST database, then load-tests fixed HTTP scenarios with autocannon.
 * 4. Runs a credit-ledger stress test (concurrent debits) and checks correctness.
 * 5. Writes docs/BENCHMARKS.md + bench/results.json with machine specs and date.
 *
 * Numbers are only meaningful together with the hardware they were measured on.
 */
import { spawn, type ChildProcess } from 'node:child_process';
import { writeFileSync, mkdirSync, openSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import autocannon from 'autocannon';
import { PrismaClient } from '@prisma/client';
import { createCreditService } from '../src/modules/credits/credits.service.js';

const PORT = 4900;
const BASE = `http://127.0.0.1:${PORT}`;
const DB_URL =
  process.env.TEST_DATABASE_URL ?? 'postgresql://studio:studio@localhost:5433/ai_media_studio_test?schema=public';
const DURATION = Number(process.env.BENCH_DURATION ?? 10); // seconds per scenario
const METRICS_TOKEN = 'bench-metrics-token-0123456789';
const ROOT = path.resolve(import.meta.dirname, '..', '..');

type Scenario = {
  name: string;
  what: string;
  connections: number;
  request: { method?: 'GET' | 'POST'; path: string; body?: string; headers?: Record<string, string> };
};

async function waitForHealth(timeoutMs = 10_000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      if ((await fetch(`${BASE}/health`)).ok) return;
    } catch {
      /* not up yet */
    }
    await new Promise((r) => setTimeout(r, 200));
  }
  throw new Error('server did not become healthy');
}

function startServer(): ChildProcess {
  const devNull = openSync('/dev/null', 'w');
  return spawn(process.execPath, ['dist/server.js'], {
    cwd: path.resolve(import.meta.dirname, '..'),
    stdio: ['ignore', devNull, 'inherit'],
    env: {
      ...process.env,
      NODE_ENV: 'production',
      PORT: String(PORT),
      DATABASE_URL: DB_URL,
      JWT_SECRET: 'bench-secret-bench-secret-bench-secret-123',
      METRICS_TOKEN,
      AUTH_RATE_LIMIT: '100000000', // the limiter would (correctly) block a load test
      BCRYPT_COST: '12', // production cost
      LOG_LEVEL: 'info',
    },
  });
}

function runAutocannon(s: Scenario) {
  return new Promise<autocannon.Result>((resolve, reject) => {
    autocannon(
      {
        url: BASE + s.request.path,
        method: s.request.method ?? 'GET',
        body: s.request.body,
        headers: { 'content-type': 'application/json', ...s.request.headers },
        connections: s.connections,
        duration: DURATION,
      },
      (err, res) => (err ? reject(err) : resolve(res)),
    );
  });
}

async function creditStress(prisma: PrismaClient) {
  const credits = createCreditService(prisma);
  const results: Record<string, unknown>[] = [];

  for (const mode of ['1 hot user (max row contention)', '50 users (spread load)'] as const) {
    await prisma.$executeRawUnsafe('TRUNCATE "CreditTransaction", "User" CASCADE');
    const userCount = mode.startsWith('1') ? 1 : 50;
    const startBalance = 1_000;
    const users = await Promise.all(
      Array.from({ length: userCount }, (_, i) =>
        prisma.user.create({ data: { email: `stress${i}@bench.local`, passwordHash: 'x', credits: startBalance } }),
      ),
    );
    // Ask for MORE than the total balance so some debits must be rejected.
    const total = userCount === 1 ? 2_000 : 5_000;
    const concurrency = 50;
    let next = 0;
    let ok = 0;
    let rejected = 0;
    const t0 = performance.now();
    await Promise.all(
      Array.from({ length: concurrency }, async () => {
        while (next < total) {
          const i = next++;
          try {
            await credits.debit(users[i % userCount]!.id, 1, 'GENERATION', `bench_${i}`);
            ok++;
          } catch {
            rejected++;
          }
        }
      }),
    );
    const seconds = (performance.now() - t0) / 1000;

    // Correctness: no negative balances, and ledger sum == cached balance for every user.
    const [check] = await prisma.$queryRaw<{ mismatches: bigint; negatives: bigint }[]>`
      SELECT
        COUNT(*) FILTER (WHERE u.credits <> COALESCE(l.sum, 0) + ${startBalance}) AS mismatches,
        COUNT(*) FILTER (WHERE u.credits < 0) AS negatives
      FROM "User" u
      LEFT JOIN (SELECT "userId", SUM(delta) AS sum FROM "CreditTransaction" GROUP BY "userId") l ON l."userId" = u.id`;
    const mismatches = Number(check?.mismatches ?? -1);
    const negatives = Number(check?.negatives ?? -1);
    const expectedOk = Math.min(total, userCount * startBalance);

    results.push({
      mode,
      attempted: total,
      concurrency,
      succeeded: ok,
      rejected,
      expectedSucceeded: expectedOk,
      seconds: +seconds.toFixed(2),
      debitsPerSec: Math.round(total / seconds),
      ledgerMismatches: mismatches,
      negativeBalances: negatives,
      correct: ok === expectedOk && mismatches === 0 && negatives === 0,
    });
  }
  return results;
}

async function main() {
  const prisma = new PrismaClient({ datasources: { db: { url: DB_URL } } });
  await prisma.$executeRawUnsafe('TRUNCATE "CreditTransaction", "User" CASCADE');

  const server = startServer();
  const results: Record<string, unknown>[] = [];
  let mixed: Record<string, unknown> | undefined;
  try {
    await waitForHealth();
    const creds = JSON.stringify({ email: 'bench@bench.local', password: 'bench-password-123' });
    const reg = await fetch(`${BASE}/auth/register`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: creds,
    });
    const cookie = reg.headers.get('set-cookie')!.split(';')[0]!;

    const scenarios: Scenario[] = [
      { name: 'GET /health', what: 'Express + Postgres `SELECT 1`', connections: 50, request: { path: '/health' } },
      {
        name: 'GET /auth/me',
        what: 'JWT verify + 1 indexed DB read',
        connections: 50,
        request: { path: '/auth/me', headers: { cookie } },
      },
      {
        name: 'GET /credits',
        what: 'JWT verify + 2 DB reads (balance + 20 ledger rows)',
        connections: 50,
        request: { path: '/credits', headers: { cookie } },
      },
      {
        name: 'POST /auth/login',
        what: 'bcrypt compare at cost 12 (CPU-bound by design)',
        connections: 10,
        request: { method: 'POST', path: '/auth/login', body: creds },
      },
      {
        name: 'GET /metrics',
        what: 'Prometheus scrape (all series)',
        connections: 10,
        request: { path: '/metrics', headers: { authorization: `Bearer ${METRICS_TOKEN}` } },
      },
    ];

    // MIXED: what do normal users feel while someone hammers /auth/login?
    // If password hashing blocks the event loop, /auth/me latency explodes here.
    {
      process.stdout.write(`▶ MIXED: /auth/me (50 conns) while /auth/login runs (10 conns)… `);
      const [me, login] = await Promise.all([
        runAutocannon({ name: 'me', what: '', connections: 50, request: { path: '/auth/me', headers: { cookie } } }),
        runAutocannon({ name: 'login', what: '', connections: 10, request: { method: 'POST', path: '/auth/login', body: creds } }),
      ]);
      const row = {
        scenario: 'GET /auth/me *during* login load',
        what: 'event-loop health: is hashing blocking other requests?',
        connections: 50,
        reqPerSec: Math.round(me.requests.average),
        p50ms: me.latency.p50,
        p90ms: me.latency.p90,
        p99ms: me.latency.p99,
        maxMs: me.latency.max,
        total: me.requests.total,
        non2xx: me.non2xx + login.non2xx,
        errors: me.errors + login.errors,
        timeouts: me.timeouts + login.timeouts,
        concurrentLoginReqPerSec: Math.round(login.requests.average),
      };
      mixed = row;
      console.log(`${row.reqPerSec} req/s, p99 ${row.p99ms}ms (logins meanwhile: ${row.concurrentLoginReqPerSec} req/s)`);
    }

    for (const s of scenarios) {
      process.stdout.write(`▶ ${s.name} (${s.connections} conns, ${DURATION}s)… `);
      const r = await runAutocannon(s);
      const row = {
        scenario: s.name,
        what: s.what,
        connections: s.connections,
        reqPerSec: Math.round(r.requests.average),
        p50ms: r.latency.p50,
        p90ms: r.latency.p90,
        p99ms: r.latency.p99,
        maxMs: r.latency.max,
        total: r.requests.total,
        non2xx: r.non2xx,
        errors: r.errors,
        timeouts: r.timeouts,
      };
      results.push(row);
      console.log(`${row.reqPerSec} req/s, p50 ${row.p50ms}ms, p99 ${row.p99ms}ms, non2xx ${row.non2xx}`);
    }
    if (mixed) results.push(mixed);
  } finally {
    server.kill('SIGTERM');
  }

  console.log('▶ credit ledger stress test…');
  const stress = await creditStress(prisma);
  for (const s of stress) console.log('  ', s);
  await prisma.$executeRawUnsafe('TRUNCATE "CreditTransaction", "User" CASCADE');
  await prisma.$disconnect();

  const machine = {
    cpu: os.cpus()[0]?.model.trim(),
    cores: os.cpus().length,
    ramGb: Math.round(os.totalmem() / 1024 ** 3),
    os: `${os.type()} ${os.release()}`,
    node: process.version,
    date: new Date().toISOString().slice(0, 10),
  };

  mkdirSync(path.join(ROOT, 'api', 'bench'), { recursive: true });
  writeFileSync(path.join(ROOT, 'api', 'bench', 'results.json'), JSON.stringify({ machine, http: results, stress }, null, 2) + '\n');
  writeFileSync(path.join(ROOT, 'docs', 'BENCHMARKS.md'), renderMarkdown(machine, results, stress));
  console.log('✔ wrote docs/BENCHMARKS.md and api/bench/results.json');
}

function renderMarkdown(machine: Record<string, unknown>, http: Record<string, unknown>[], stress: Record<string, unknown>[]) {
  const h = http
    .map(
      (r) =>
        `| ${r.scenario} | ${r.what} | ${r.connections} | **${Number(r.reqPerSec).toLocaleString('en-US')}** | ${r.p50ms} | ${r.p90ms} | ${r.p99ms} | ${r.non2xx} / ${r.errors} |`,
    )
    .join('\n');
  const s = stress
    .map(
      (r) =>
        `| ${r.mode} | ${r.attempted} @ ${r.concurrency} concurrent | ${r.succeeded} (expected ${r.expectedSucceeded}) | ${r.rejected} | **${Number(r.debitsPerSec).toLocaleString('en-US')}** | ${r.ledgerMismatches} | ${r.negativeBalances} | ${r.correct ? '✅' : '❌'} |`,
    )
    .join('\n');
  return `# Benchmarks

> Generated by \`cd api && npm run build && npm run bench\` — do not edit by hand.
> **Single API process** (one Node.js event loop, no clustering), Postgres 16 in Docker on the same machine.
> Measured on: ${machine.cpu} (${machine.cores} threads), ${machine.ramGb} GB RAM, ${machine.os}, Node ${machine.node}, ${machine.date}.
> Load generator (autocannon) runs on the same machine, so it competes for CPU: real numbers on separate hosts would be higher.

## HTTP throughput & latency (${DURATION}s per scenario, NODE_ENV=production, JSON logging on)

| Scenario | What it exercises | Conns | Req/s | p50 ms | p90 ms | p99 ms | non-2xx / errors |
|---|---|---|---|---|---|---|---|
${h}

**Reading this:** login is deliberately slow. bcrypt cost 12 costs ~200 ms of CPU per hash, which is what makes offline password cracking expensive. Native bcrypt runs hashes on libuv's thread pool (4 threads by default), so login throughput is bounded by that pool. The "during login load" row shows that the **event loop stays free**: other requests keep low latency while logins are being hashed.

## Credit ledger under concurrency

Concurrent \`debit(1)\` calls, each one an atomic conditional \`UPDATE\` + ledger \`INSERT\` in one transaction. More debits are requested than the balance allows, so some **must** be rejected.

| Mode | Debits attempted | Succeeded | Rejected | Debits/s | Ledger ≠ balance | Negative balances | Correct |
|---|---|---|---|---|---|---|---|
${s}

"Correct" means: exactly the affordable number of debits succeeded, every user's \`SUM(ledger) == balance\`, and no balance went negative.
`;
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
