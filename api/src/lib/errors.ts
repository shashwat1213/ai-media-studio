/**
 * Errors that carry an HTTP status. Services throw these; the error middleware
 * turns them into JSON responses. Anything else becomes a generic 500.
 */
export class HttpError extends Error {
  readonly status: number;
  readonly details?: unknown;
  constructor(status: number, message: string, details?: unknown) {
    super(message);
    this.status = status;
    this.details = details;
  }
}

export const unauthorized = (msg = 'Not authenticated') => new HttpError(401, msg);
export const conflict = (msg: string) => new HttpError(409, msg);

/** Thrown by the credit service; mapped to 402 Payment Required. */
export class InsufficientCreditsError extends HttpError {
  constructor() {
    super(402, 'Insufficient credits');
  }
}

export const notFound = (msg = 'Not found') => new HttpError(404, msg);
export const tooManyRequests = (msg: string) => new HttpError(429, msg);
export const serviceUnavailable = (msg: string) => new HttpError(503, msg);
