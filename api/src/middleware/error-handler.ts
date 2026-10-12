import type { ErrorRequestHandler } from 'express';
import { ZodError } from 'zod';
import { HttpError } from '../lib/errors.js';

/**
 * Single place that turns thrown errors into HTTP responses.
 * Express 5 forwards errors from async handlers here automatically.
 * Unknown errors -> 500 with a generic message + the requestId, so a user's
 * bug report can be matched to the full error in the logs (never leak stack traces).
 */
export const errorHandler: ErrorRequestHandler = (err, req, res, _next) => {
  if (err instanceof ZodError) {
    res.status(400).json({ error: 'Validation failed', details: err.flatten().fieldErrors });
    return;
  }
  if (err instanceof HttpError) {
    res.status(err.status).json(err.details ? { error: err.message, details: err.details } : { error: err.message });
    return;
  }
  // body-parser errors (malformed JSON, too large) carry a status
  if (typeof err === 'object' && err !== null && 'status' in err && typeof err.status === 'number' && err.status < 500) {
    res.status(err.status).json({ error: 'Invalid request body' });
    return;
  }
  req.log?.error({ err }, 'unhandled error');
  res.status(500).json({ error: 'Internal server error', requestId: req.id });
};
