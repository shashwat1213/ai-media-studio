-- CreateEnum
CREATE TYPE "SceneStatus" AS ENUM ('PLANNING', 'PRODUCING', 'READY', 'FAILED');

-- AlterEnum
ALTER TYPE "UploadSource" ADD VALUE 'AI_IMAGE';

-- CreateTable
CREATE TABLE "Scene" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "prompt" TEXT NOT NULL,
    "language" TEXT NOT NULL,
    "format" TEXT NOT NULL,
    "targetS" INTEGER NOT NULL,
    "voice" TEXT NOT NULL,
    "status" "SceneStatus" NOT NULL DEFAULT 'PLANNING',
    "title" TEXT,
    "script" JSONB,
    "draft" JSONB,
    "progress" TEXT,
    "error" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Scene_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "Scene_userId_createdAt_idx" ON "Scene"("userId", "createdAt");

-- CreateIndex
CREATE INDEX "Scene_status_updatedAt_idx" ON "Scene"("status", "updatedAt");

-- AddForeignKey
ALTER TABLE "Scene" ADD CONSTRAINT "Scene_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Hand-written invariants.
ALTER TABLE "Scene" ADD CONSTRAINT "Scene_language_check" CHECK ("language" IN ('hi', 'en'));
ALTER TABLE "Scene" ADD CONSTRAINT "Scene_format_check" CHECK ("format" IN ('9:16', '16:9', '1:1'));
ALTER TABLE "Scene" ADD CONSTRAINT "Scene_target_check" CHECK ("targetS" BETWEEN 6 AND 90);
ALTER TABLE "Scene" ADD CONSTRAINT "Scene_prompt_check" CHECK (char_length("prompt") BETWEEN 3 AND 2000);
-- READY means there is something to open.
ALTER TABLE "Scene" ADD CONSTRAINT "Scene_ready_check" CHECK ("status" <> 'READY' OR ("script" IS NOT NULL AND "draft" IS NOT NULL));
