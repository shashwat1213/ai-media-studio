import express, { type Express } from 'express';
import cors from 'cors';
import cookieParser from 'cookie-parser';
import helmet from 'helmet';
import type { PrismaClient } from '@prisma/client';
import type { Logger } from 'pino';
import type { AppConfig } from './config/app-config.js';
import type { Storage } from './lib/storage.js';
import { healthRouter } from './routes/health.js';
import { errorHandler } from './middleware/error-handler.js';
import { requireJson } from './middleware/require-json.js';
import { createAuthService } from './modules/auth/auth.service.js';
import { authRouter } from './modules/auth/auth.routes.js';
import { createCreditService } from './modules/credits/credits.service.js';
import { creditsRouter } from './modules/credits/credits.routes.js';
import { createGenerationService } from './modules/generation/generation.service.js';
import { generationRouter } from './modules/generation/generation.routes.js';
import type { JobQueue } from './modules/generation/queue.js';
import { createLogger } from './observability/logger.js';
import { createMetrics, type Metrics } from './observability/metrics.js';
import { httpObservability } from './observability/http-observability.js';
import { metricsRouter } from './observability/metrics-route.js';

export interface AppDeps {
  prisma: PrismaClient;
  config: AppConfig;
  logger?: Logger;
  metrics?: Metrics;
  // Phase 2. Optional so auth/credits tests don't need Redis or S3.
  queue?: JobQueue;
  storage?: Storage;
  redisPing?: () => Promise<boolean>;
}

/**
 * Builds the Express app WITHOUT starting a server.
 * Tests import this and fire requests with supertest — no real port needed.
 * Dependencies (db, queue, storage, config, logger, metrics) are passed in, not imported, so tests control them.
 */
export function createApp({ prisma, config, logger, metrics, queue, storage, redisPing }: AppDeps): Express {
  const log = logger ?? createLogger('test');
  const m = metrics ?? createMetrics();
  const app = express();

  app.disable('x-powered-by');
  // Real client IP for rate limiting = the entry N hops from the right of X-Forwarded-For.
  // 1 locally (nginx / Vite proxy), 3 on AWS (CloudFront -> ALB -> nginx). See env.ts.
  app.set('trust proxy', config.trustProxyHops ?? 1);
  app.use(httpObservability(log, m)); // first: so even rejected requests get an id, a log line, a timing
  app.use(helmet());
  app.use(cors({ origin: config.corsOrigin, credentials: true, exposedHeaders: ['X-Request-Id', 'Location'] }));
  app.use(requireJson);
  app.use(express.json({ limit: '100kb' }));
  app.use(cookieParser());

  const authService = createAuthService(
    prisma,
    { bcryptCost: config.bcryptCost, signupBonusCredits: config.signupBonusCredits },
    m,
  );
  const creditService = createCreditService(prisma, m);

  app.use(healthRouter(prisma, redisPing));
  app.use(metricsRouter(m, config.metricsToken));
  app.use(authRouter(authService, config));
  app.use(creditsRouter(creditService, config.jwtSecret));

  if (queue && storage) {
    const generation = createGenerationService({
      prisma,
      queue,
      storage,
      metrics: m,
      maxActiveJobsPerUser: config.maxActiveJobsPerUser,
    });
    app.use(
      generationRouter(generation, {
        jwtSecret: config.jwtSecret,
        providerMode: config.providerMode,
        generateRateLimit: config.generateRateLimit,
        onOrphan: (key, err) => log.warn({ key, err: (err as Error).message }, 'asset row deleted but object delete failed'),
      }),
    );
  }

  app.use((_req, res) => {
    res.status(404).json({ error: 'Not found' });
  });
  app.use(errorHandler);

  return app;
}
