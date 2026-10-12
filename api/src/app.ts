import express, { type Express } from 'express';
import cors from 'cors';
import cookieParser from 'cookie-parser';
import type { PrismaClient } from '@prisma/client';
import { healthRouter } from './routes/health.js';

export interface AppDeps {
  db: Pick<PrismaClient, '$queryRaw'>;
  corsOrigin: string;
}

/**
 * Builds the Express app WITHOUT starting a server.
 * Splitting app (this file) from server (server.ts) lets tests import the app
 * and fire requests at it with supertest, without opening a real port.
 */
export function createApp({ db, corsOrigin }: AppDeps): Express {
  const app = express();

  app.disable('x-powered-by'); // don't advertise the framework to attackers
  app.use(cors({ origin: corsOrigin, credentials: true })); // credentials: needed for httpOnly JWT cookies later
  app.use(express.json({ limit: '100kb' }));
  app.use(cookieParser());

  app.use(healthRouter(db));

  app.use((_req, res) => {
    res.status(404).json({ error: 'Not found' });
  });

  return app;
}
