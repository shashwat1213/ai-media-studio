/**
 * Tiny fetch wrapper. All API calls go through here so cookies, base URL and
 * error handling live in ONE place.
 * VITE_API_URL is baked in at build time; in dev it's '/api' (Vite proxy).
 */
const BASE = import.meta.env.VITE_API_URL ?? '/api';

export class ApiError extends Error {
  readonly status: number;
  readonly details?: Record<string, string[] | undefined>;
  constructor(status: number, message: string, details?: Record<string, string[] | undefined>) {
    super(message);
    this.status = status;
    this.details = details;
  }
}

export async function api<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`${BASE}${path}`, {
    ...init,
    credentials: 'include', // send the httpOnly JWT cookie
    headers: { 'Content-Type': 'application/json', ...init?.headers },
  });
  if (res.status === 204) return undefined as T;
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new ApiError(res.status, body.error ?? res.statusText, body.details);
  return body as T;
}

// ---- API types (mirror the backend's response shapes) ----

export interface User {
  id: string;
  email: string;
  credits: number;
  createdAt: string;
}

export type CreditReason = 'SIGNUP_BONUS' | 'PURCHASE' | 'GENERATION' | 'REFUND';

export interface CreditTransaction {
  id: string;
  delta: number;
  reason: CreditReason;
  balanceAfter: number;
  refId: string | null;
  createdAt: string;
}

export interface CreditSummary {
  balance: number;
  transactions: CreditTransaction[];
}

export interface Health {
  status: 'ok' | 'degraded';
  db: 'up' | 'down';
}
