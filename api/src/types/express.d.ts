// Adds custom fields to Express's Request type.
declare global {
  namespace Express {
    interface Request {
      /** Set by requireAuth. */
      userId?: string;
      /** Set by the request-id middleware (also used by pino-http). */
      id?: string;
    }
  }
}

export {};
