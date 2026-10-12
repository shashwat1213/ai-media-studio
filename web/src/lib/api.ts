/**
 * Tiny fetch wrapper. All API calls go through here so auth cookies,
 * base URL and error handling live in ONE place.
 * VITE_API_URL is baked in at build time; in dev it's '/api' (Vite proxy).
 */
const BASE = import.meta.env.VITE_API_URL ?? '/api';

export class ApiError extends Error {
  readonly status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

export async function api<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`${BASE}${path}`, {
    credentials: 'include', // send the httpOnly JWT cookie (Phase 1)
    headers: { 'Content-Type': 'application/json', ...init?.headers },
    ...init,
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new ApiError(res.status, body.error ?? res.statusText);
  return body as T;
}

export interface Health {
  status: 'ok' | 'degraded';
  db: 'up' | 'down';
}
