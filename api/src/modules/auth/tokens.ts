import jwt from 'jsonwebtoken';
import type { CookieOptions } from 'express';

export const AUTH_COOKIE = 'token';

export function signToken(userId: string, secret: string, ttlDays: number): string {
  return jwt.sign({}, secret, { subject: userId, expiresIn: `${ttlDays}d`, algorithm: 'HS256' });
}

/** Returns the userId, or null if the token is missing, tampered, or expired. */
export function verifyToken(token: string, secret: string): string | null {
  try {
    // Pin the algorithm: never let the token itself choose how it's verified.
    const payload = jwt.verify(token, secret, { algorithms: ['HS256'] });
    return typeof payload === 'object' && typeof payload.sub === 'string' ? payload.sub : null;
  } catch {
    return null;
  }
}

export function authCookieOptions(secure: boolean, ttlDays: number): CookieOptions {
  return {
    httpOnly: true, // JS can't read it -> XSS can't steal the session
    secure, // HTTPS-only in production
    sameSite: 'lax', // not sent on cross-site POSTs -> CSRF protection
    path: '/',
    maxAge: ttlDays * 24 * 60 * 60 * 1000,
  };
}
