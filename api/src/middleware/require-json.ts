import type { RequestHandler } from 'express';
import { HttpError } from '../lib/errors.js';

/**
 * Write requests that carry a body must be JSON.
 * A plain HTML <form> (the classic CSRF vector) can only send form/text bodies,
 * so this — together with SameSite=Lax cookies — blocks cross-site form posts.
 */
export const requireJson: RequestHandler = (req, _res, next) => {
  const hasBody = Number(req.headers['content-length'] ?? 0) > 0 || req.headers['transfer-encoding'] !== undefined;
  if (['POST', 'PUT', 'PATCH'].includes(req.method) && hasBody && !req.is('application/json')) {
    next(new HttpError(415, 'Content-Type must be application/json'));
    return;
  }
  next();
};
