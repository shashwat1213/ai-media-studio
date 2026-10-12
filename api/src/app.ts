import express, { type Express } from 'express';
import cors from 'cors';
import cookieParser from 'cookie-parser';
import helmet from 'helmet';
import type { PrismaClient } from '@prisma/client';
import type { Logger } from 'pino';
import type { AppConfig } from './config/app-config.js';
import { healthRouter } from './routes/health.js';
import { errorHandler } from './middleware/error-handler.js';
import { requireJson } from './middleware/require-json.js';
import { createAuthService } from './modules/auth/auth.service.js';
import { authRouter } from './modules/auth/auth.routes.js';
import { createCreditService } from './modules/credits/credits.service.js';
import { creditsRouter } from './modules/credits/credits.routes.js';
import { createLogger } from './observability/logger.js';
import { createMetrics, type Metrics } from './observability/metrics.js';
import { httpObservability } from './observability/http-observability.js';
import { metricsRouter } from './observability/metrics-route.js';

export interface AppDeps {
  prisma: PrismaClient;
  config: AppConfig;
  logger?: Logger;
  metrics?: Metrics;
}

/**
 * Builds the Express app WITHOUT starting a server.
 * Tests import this and fire requests with supertest — no real port needed.
 * Dependencies (db, config, logger, metrics) are passed in, not imported, so tests control them.
 */
export function createApp({ prisma, config, logger, metrics }: AppDeps): Express {
  const log = logger ?? createLogger('test');
  const m = metrics ?? createMetrics();
  const app = express();

  app.disable('x-powered-by');
  app.set('trust proxy', 1); // behind one proxy (Vite dev / AWS ALB): real client IP for rate limiting
  app.use(httpObservability(log, m)); // first: so even rejected requests get an id, a log line, a timing
  app.use(helmet());
  app.use(cors({ origin: config.corsOrigin, credentials: true, exposedHeaders: ['X-Request-Id'] }));
  app.use(requireJson);
  app.use(express.json({ limit: '100kb' }));
  app.use(cookieParser());

  const authService = createAuthService(
    prisma,
    { bcryptCost: config.bcryptCost, signupBonusCredits: config.signupBonusCredits },
    m,
  );
  const creditService = createCreditService(prisma, m);

  app.use(healthRouter(prisma));
  app.use(metricsRouter(m, config.metricsToken));
  app.use(authRouter(authService, config));
  app.use(creditsRouter(creditService, config.jwtSecret));

  app.use((_req, res) => {
    res.status(404).json({ error: 'Not found' });
  });
  app.use(errorHandler);

  return app;
}
