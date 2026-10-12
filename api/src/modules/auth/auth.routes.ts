import { Router } from 'express';
import rateLimit from 'express-rate-limit';
import type { AppConfig } from '../../config/app-config.js';
import { unauthorized } from '../../lib/errors.js';
import { CredentialsSchema } from './auth.schemas.js';
import type { AuthService } from './auth.service.js';
import { requireAuth } from './require-auth.js';
import { AUTH_COOKIE, authCookieOptions, signToken } from './tokens.js';

export function authRouter(auth: AuthService, config: AppConfig): Router {
  const router = Router();
  const cookieOpts = authCookieOptions(config.secureCookies, config.jwtTtlDays);

  // Slow down password guessing: N requests / 15 min / IP on login+register.
  const limiter = rateLimit({
    windowMs: 15 * 60 * 1000,
    limit: config.authRateLimit,
    standardHeaders: 'draft-8',
    legacyHeaders: false,
    message: { error: 'Too many attempts, try again later' },
  });

  const issueSession = (res: import('express').Response, userId: string) =>
    res.cookie(AUTH_COOKIE, signToken(userId, config.jwtSecret, config.jwtTtlDays), cookieOpts);

  router.post('/auth/register', limiter, async (req, res) => {
    const creds = CredentialsSchema.parse(req.body);
    const user = await auth.register(creds);
    issueSession(res, user.id);
    res.status(201).json({ user });
  });

  router.post('/auth/login', limiter, async (req, res) => {
    const creds = CredentialsSchema.parse(req.body);
    const user = await auth.login(creds);
    issueSession(res, user.id);
    res.json({ user });
  });

  router.post('/auth/logout', (_req, res) => {
    // Must pass the same path/flags or the browser keeps the cookie.
    const { maxAge: _maxAge, ...clearOpts } = cookieOpts;
    res.clearCookie(AUTH_COOKIE, clearOpts);
    res.status(204).end();
  });

  router.get('/auth/me', requireAuth(config.jwtSecret), async (req, res) => {
    const user = await auth.getById(req.userId!);
    if (!user) throw unauthorized(); // token valid but user deleted
    res.json({ user });
  });

  return router;
}
