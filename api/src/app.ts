import express, { type Express } from 'express';
import cors from 'cors';
import cookieParser from 'cookie-parser';
import helmet from 'helmet';
import type { PrismaClient } from '@prisma/client';
import type { AppConfig } from './config/app-config.js';
import { healthRouter } from './routes/health.js';
import { errorHandler } from './middleware/error-handler.js';
import { requireJson } from './middleware/require-json.js';
import { createAuthService } from './modules/auth/auth.service.js';
import { authRouter } from './modules/auth/auth.routes.js';
import { createCreditService } from './modules/credits/credits.service.js';
import { creditsRouter } from './modules/credits/credits.routes.js';

export interface AppDeps {
  prisma: PrismaClient;
  config: AppConfig;
}

/**
 * Builds the Express app WITHOUT starting a server.
 * Tests import this and fire requests with supertest — no real port needed.
 * Dependencies (db, config) are passed in, not imported, so tests control them.
 */
export function createApp({ prisma, config }: AppDeps): Express {
  const app = express();

  app.disable('x-powered-by');
  app.set('trust proxy', 1); // behind one proxy (Vite dev / AWS ALB): real client IP for rate limiting
  app.use(helmet());
  app.use(cors({ origin: config.corsOrigin, credentials: true }));
  app.use(requireJson);
  app.use(express.json({ limit: '100kb' }));
  app.use(cookieParser());

  const authService = createAuthService(prisma, {
    bcryptCost: config.bcryptCost,
    signupBonusCredits: config.signupBonusCredits,
  });
  const creditService = createCreditService(prisma);

  app.use(healthRouter(prisma));
  app.use(authRouter(authService, config));
  app.use(creditsRouter(creditService, config.jwtSecret));

  app.use((_req, res) => {
    res.status(404).json({ error: 'Not found' });
  });
  app.use(errorHandler);

  return app;
}
