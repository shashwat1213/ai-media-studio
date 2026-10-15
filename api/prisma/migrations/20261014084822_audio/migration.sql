-- CreateEnum
CREATE TYPE "UploadSource" AS ENUM ('UPLOAD', 'RECORDING', 'TTS');

-- CreateEnum
CREATE TYPE "TranscriptStatus" AS ENUM ('NONE', 'PENDING', 'DONE', 'FAILED');

-- AlterTable
ALTER TABLE "Upload" ADD COLUMN     "hasAudio" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "script" TEXT,
ADD COLUMN     "source" "UploadSource" NOT NULL DEFAULT 'UPLOAD',
ADD COLUMN     "transcript" JSONB,
ADD COLUMN     "transcriptCost" INTEGER,
ADD COLUMN     "transcriptError" TEXT,
ADD COLUMN     "transcriptStatus" "TranscriptStatus" NOT NULL DEFAULT 'NONE',
ADD COLUMN     "voice" TEXT;

-- CreateIndex
CREATE INDEX "Upload_transcriptStatus_createdAt_idx" ON "Upload"("transcriptStatus", "createdAt");

-- Hand-written invariants.
-- A TTS upload always records what was said and by whom.
ALTER TABLE "Upload" ADD CONSTRAINT "Upload_tts_fields_check"
  CHECK ("source" <> 'TTS' OR ("script" IS NOT NULL AND "voice" IS NOT NULL));
-- A finished transcript has content; a running one has a reserved cost.
ALTER TABLE "Upload" ADD CONSTRAINT "Upload_transcript_done_check"
  CHECK ("transcriptStatus" <> 'DONE' OR "transcript" IS NOT NULL);
ALTER TABLE "Upload" ADD CONSTRAINT "Upload_transcript_pending_check"
  CHECK ("transcriptStatus" <> 'PENDING' OR "transcriptCost" > 0);
