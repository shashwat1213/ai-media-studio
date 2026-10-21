import { describe, expect, it } from 'vitest';
import { silentLogger } from '../../../test/helpers.js';
import { createInlineQueue } from './inline-queue.js';
import type { QueueJob } from './worker.js';

function setup(handle: (job: QueueJob) => Promise<string>, extra: { sweep?: () => Promise<void> } = {}) {
  const background: Promise<unknown>[] = [];
  const sleeps: number[] = [];
  const q = createInlineQueue({
    handle,
    runInBackground: (p) => background.push(p),
    logger: silentLogger,
    maxAttempts: 3,
    backoffMs: 100,
    jobTimeoutMs: 60_000,
    sleep: async (ms) => void sleeps.push(ms),
    ...extra,
  });
  return { q, background, sleeps };
}

describe('inline queue (serverless jobs)', () => {
  it('runs each kind of job in the background with the right name/data/attempts', async () => {
    const seen: QueueJob[] = [];
    const { q, background } = setup(async (j) => (seen.push(j), 'done'));
    await q.enqueue('j1');
    await q.enqueueTranscription!('u1', 'r1');
    await q.enqueueScene!('s1', 'a1');
    expect(background).toHaveLength(3); // handed to waitUntil, not awaited by the request
    await q.idle();
    expect(seen).toEqual([
      { name: 'generate', data: { jobId: 'j1' }, attemptsMade: 0, attempts: 3 },
      { name: 'transcribe', data: { uploadId: 'u1' }, attemptsMade: 0, attempts: 3 },
      { name: 'scene', data: { sceneId: 's1' }, attemptsMade: 0, attempts: 2 },
    ]);
  });

  it('retries with exponential backoff, then stops at maxAttempts', async () => {
    let calls = 0;
    const { q, sleeps } = setup(async () => {
      calls++;
      throw new Error('transient');
    });
    await q.enqueue('j1');
    await q.idle();
    expect(calls).toBe(3);
    expect(sleeps).toEqual([100, 200]);
  });

  it('stops retrying once it succeeds', async () => {
    let calls = 0;
    const { q } = setup(async () => {
      if (++calls < 2) throw new Error('once');
      return 'done';
    });
    await q.enqueue('j1');
    await q.idle();
    expect(calls).toBe(2);
  });

  it('a duplicate enqueue while the job runs is a no-op (like BullMQ jobId)', async () => {
    let calls = 0;
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const { q, background } = setup(async () => {
      calls++;
      await gate;
      return 'done';
    });
    await q.enqueue('j1');
    await q.enqueue('j1');
    expect(background).toHaveLength(1);
    release();
    await q.close();
    expect(calls).toBe(1);
  });

  it('runs the sweeper after a job, at most once per interval', async () => {
    let sweeps = 0;
    const { q } = setup(async () => 'done', { sweep: async () => void sweeps++ });
    await q.enqueue('a');
    await q.idle();
    await q.enqueue('b');
    await q.idle();
    expect(sweeps).toBe(1);
  });
});
