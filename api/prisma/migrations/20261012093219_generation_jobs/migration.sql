-- CreateEnum
CREATE TYPE "JobStatus" AS ENUM ('QUEUED', 'PROCESSING', 'DONE', 'FAILED');

-- CreateTable
CREATE TABLE "GenerationJob" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "prompt" TEXT NOT NULL,
    "model" TEXT NOT NULL,
    "aspectRatio" TEXT NOT NULL,
    "status" "JobStatus" NOT NULL DEFAULT 'QUEUED',
    "creditsCost" INTEGER NOT NULL,
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "error" TEXT,
    "idempotencyKey" TEXT,
    "startedAt" TIMESTAMP(3),
    "finishedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "GenerationJob_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Asset" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "jobId" TEXT NOT NULL,
    "storageKey" TEXT NOT NULL,
    "mimeType" TEXT NOT NULL,
    "bytes" INTEGER NOT NULL,
    "width" INTEGER,
    "height" INTEGER,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Asset_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "GenerationJob_userId_createdAt_idx" ON "GenerationJob"("userId", "createdAt");

-- CreateIndex
CREATE INDEX "GenerationJob_status_updatedAt_idx" ON "GenerationJob"("status", "updatedAt");

-- CreateIndex
CREATE UNIQUE INDEX "GenerationJob_userId_idempotencyKey_key" ON "GenerationJob"("userId", "idempotencyKey");

-- CreateIndex
CREATE UNIQUE INDEX "Asset_jobId_key" ON "Asset"("jobId");

-- CreateIndex
CREATE UNIQUE INDEX "Asset_storageKey_key" ON "Asset"("storageKey");

-- CreateIndex
CREATE INDEX "Asset_userId_createdAt_idx" ON "Asset"("userId", "createdAt");

-- AddForeignKey
ALTER TABLE "GenerationJob" ADD CONSTRAINT "GenerationJob_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Asset" ADD CONSTRAINT "Asset_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Asset" ADD CONSTRAINT "Asset_jobId_fkey" FOREIGN KEY ("jobId") REFERENCES "GenerationJob"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- ---------------------------------------------------------------------------
-- Hand-written: rules Prisma's schema language can't express.
-- ---------------------------------------------------------------------------

-- A job always costs something; a stored object is never empty.
ALTER TABLE "GenerationJob" ADD CONSTRAINT "GenerationJob_creditsCost_positive" CHECK ("creditsCost" > 0);
ALTER TABLE "GenerationJob" ADD CONSTRAINT "GenerationJob_attempts_nonneg" CHECK ("attempts" >= 0);
ALTER TABLE "Asset" ADD CONSTRAINT "Asset_bytes_positive" CHECK ("bytes" > 0);

-- At most ONE refund per job, enforced by the database itself (partial unique index).
-- Even if two workers / the sweeper race to refund the same job, the second INSERT fails.
CREATE UNIQUE INDEX "CreditTransaction_refund_once" ON "CreditTransaction"("refId") WHERE "reason" = 'REFUND';
