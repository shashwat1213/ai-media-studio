import type { RequestHandler } from 'express';
import { unauthorized } from '../../lib/errors.js';
import { AUTH_COOKIE, verifyToken } from './tokens.js';

/** Rejects the request with 401 unless it carries a valid JWT cookie. Sets req.userId. */
export function requireAuth(jwtSecret: string): RequestHandler {
  return (req, _res, next) => {
    const token: unknown = req.cookies?.[AUTH_COOKIE];
    const userId = typeof token === 'string' ? verifyToken(token, jwtSecret) : null;
    if (!userId) {
      next(unauthorized());
      return;
    }
    req.userId = userId;
    next();
  };
}
