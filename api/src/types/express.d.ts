// Adds `userId` to Express's Request type. Set by the requireAuth middleware.
declare global {
  namespace Express {
    interface Request {
      userId?: string;
    }
  }
}

export {};
