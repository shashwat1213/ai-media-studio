import { Redis, type RedisOptions } from 'ioredis';

/**
 * Redis connections for BullMQ.
 *
 * Two flavours, because they fail differently on purpose:
 * - 'worker': BullMQ's Worker sits in a BLOCKING command (BRPOPLPUSH-style) waiting for jobs.
 *   It must retry forever (maxRetriesPerRequest: null) so a Redis blip doesn't crash the worker.
 * - 'producer' (the API): must FAIL FAST. If Redis is down, POST /generate should get an error
 *   quickly (so we can refund + answer 503), not hang until the client gives up.
 *   Commands give up after 1 reconnect attempt; enqueue() adds its own hard timeout on top.
 *   (We keep ioredis' offline queue ON: BullMQ sends commands the moment a Queue is constructed,
 *   before the socket is connected. With the offline queue OFF those are rejected instantly.)
 */
export function createRedis(url: string, role: 'producer' | 'worker'): Redis {
  const opts: RedisOptions =
    role === 'worker' ? { maxRetriesPerRequest: null } : { maxRetriesPerRequest: 1, connectTimeout: 2_000 };
  return new Redis(url, { ...opts, lazyConnect: false });
}

/** PING with a timeout, for /health. */
export async function pingRedis(redis: Redis, timeoutMs = 1_000): Promise<boolean> {
  try {
    const res = await withTimeout(redis.ping(), timeoutMs);
    return res === 'PONG';
  } catch {
    return false;
  }
}

export function withTimeout<T>(p: Promise<T>, ms: number, message = `timed out after ${ms} ms`): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(message)), ms);
  });
  return Promise.race([p, timeout]).finally(() => clearTimeout(timer));
}
