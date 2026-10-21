-- DropIndex
DROP INDEX "Upload_transcriptStatus_createdAt_idx";

-- AlterTable
ALTER TABLE "Upload" ADD COLUMN     "transcriptAt" TIMESTAMP(3);

-- CreateIndex
CREATE INDEX "Upload_transcriptStatus_transcriptAt_idx" ON "Upload"("transcriptStatus", "transcriptAt");
