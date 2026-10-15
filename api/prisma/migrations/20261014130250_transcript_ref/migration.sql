-- AlterTable
ALTER TABLE "Upload" ADD COLUMN     "transcriptRef" TEXT;

-- Voice-over transcripts are free (cost 0): a running transcription needs a cost, not a positive one.
ALTER TABLE "Upload" DROP CONSTRAINT "Upload_transcript_pending_check";
ALTER TABLE "Upload" ADD CONSTRAINT "Upload_transcript_pending_check"
  CHECK ("transcriptStatus" <> 'PENDING' OR ("transcriptCost" IS NOT NULL AND "transcriptCost" >= 0));
-- A paid transcription always has a ledger reference.
ALTER TABLE "Upload" ADD CONSTRAINT "Upload_transcript_ref_check"
  CHECK ("transcriptCost" IS NULL OR "transcriptCost" = 0 OR "transcriptRef" IS NOT NULL);
