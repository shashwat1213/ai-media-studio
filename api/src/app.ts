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
import { createUploadService } from './modules/editor/uploads.service.js';
import type { ProbeResult, UploadMime } from './modules/editor/probe.js';
import { audioRouter } from './modules/audio/audio.routes.js';
import { libraryRouter } from './modules/library/library.routes.js';
import { createLibraryService } from './modules/library/library.js';
import { scenesRouter } from './modules/director/scenes.routes.js';
import { PIPER_VOICES } from './modules/director/local-ai.js';
import type { LocalAiStatus } from './modules/director/index.js';
import { AURA_VOICES } from './modules/audio/speech.js';
import { createStubSpeech, type SpeechProvider } from './modules/audio/speech.js';
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
  /** Tests inject a fake media probe; production runs ffprobe. */
  probe?: (url: string, declared: UploadMime) => Promise<ProbeResult>;
  /** Voice-over + transcription. Defaults to the free offline stub (tests). */
  speech?: SpeechProvider;
  /** Scene Director: is the local AI reachable? (UI hint only). */
  localAi?: () => Promise<LocalAiStatus>;
  ffmpegPath?: string;
}

/**
 * Builds the Express app WITHOUT starting a server.
 * Tests import this and fire requests with supertest — no real port needed.
 * Dependencies (db, queue, storage, config, logger, metrics) are passed in, not imported, so tests control them.
 */
export function createApp({ prisma, config, logger, metrics, queue, storage, redisPing, probe, speech, ffmpegPath, localAi }: AppDeps): Express {
  const log = logger ?? createLogger('test');
  const m = metrics ?? createMetrics();
  const app = express();

  app.disable('x-powered-by');
  app.set('trust proxy', 1); // behind one proxy (Vite dev / AWS ALB): real client IP for rate limiting
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
  const voices = speech ?? createStubSpeech();
  app.use(
    libraryRouter(
      createLibraryService({ prisma, voiceExists: (engine, v) => (engine === 'piper' ? PIPER_VOICES : AURA_VOICES).some((x) => x.id === v) }),
      config.jwtSecret,
    ),
  );

  if (queue && storage) {
    const generation = createGenerationService({
      prisma,
      queue,
      storage,
      metrics: m,
      maxActiveJobsPerUser: config.maxActiveJobsPerUser,
    });
    const uploads = createUploadService({ prisma, storage, probe });
    // Scene Director: needs the queue (production runs in the worker) and storage (pictures).
    app.use(
      scenesRouter({
        prisma,
        storage,
        jwtSecret: config.jwtSecret,
        voices: () => voices.voices,
        enqueueScene: queue.enqueueScene?.bind(queue),
        localAi: localAi ?? (async () => ({ llm: false, image: false, upscale: false, faceRef: false })),
        rateLimit: config.generateRateLimit,
      }),
    );
    // Audio first: its /uploads/:id/transcribe must not be shadowed by anything more generic.
    app.use(
      audioRouter({
        prisma,
        storage,
        speech: speech ?? createStubSpeech(),
        uploads,
        jwtSecret: config.jwtSecret,
        enqueueTranscription: queue.enqueueTranscription?.bind(queue),
        rateLimit: config.generateRateLimit,
        ffmpegPath,
      }),
    );
    app.use(
      generationRouter(generation, {
        jwtSecret: config.jwtSecret,
        providerMode: config.providerMode,
        generateRateLimit: config.generateRateLimit,
        onOrphan: (key, err) => log.warn({ key, err: (err as Error).message }, 'row deleted but object delete failed'),
        uploads,
      }),
    );
  }

  app.use((_req, res) => {
    res.status(404).json({ error: 'Not found' });
  });
  app.use(errorHandler);

  return app;
}
