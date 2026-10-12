import { PrismaClient } from '@prisma/client';

// One shared PrismaClient per process. Each client holds a connection pool,
// so creating one per request would quickly exhaust Postgres connections.
export const prisma = new PrismaClient();
