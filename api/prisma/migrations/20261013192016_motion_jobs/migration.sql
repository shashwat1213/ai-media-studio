-- CreateEnum
CREATE TYPE "JobKind" AS ENUM ('IMAGE', 'MOTION');

-- AlterTable
ALTER TABLE "Asset" ADD COLUMN     "durationMs" INTEGER;

-- AlterTable
ALTER TABLE "GenerationJob" ADD COLUMN     "durationS" INTEGER,
ADD COLUMN     "kind" "JobKind" NOT NULL DEFAULT 'IMAGE',
ADD COLUMN     "motionPreset" TEXT,
ADD COLUMN     "sourceAssetId" TEXT;

-- AddForeignKey
ALTER TABLE "GenerationJob" ADD CONSTRAINT "GenerationJob_sourceAssetId_fkey" FOREIGN KEY ("sourceAssetId") REFERENCES "Asset"("id") ON DELETE SET NULL ON UPDATE CASCADE;


-- Hand-written: invariants the database enforces, not just the app.
-- A MOTION job must say which preset + length it renders (the source may later become NULL
-- if the user deletes that image, so it is NOT required here; the API requires it on create).
ALTER TABLE "GenerationJob" ADD CONSTRAINT "GenerationJob_motion_fields_check"
  CHECK ("kind" <> 'MOTION' OR ("motionPreset" IS NOT NULL AND "durationS" BETWEEN 2 AND 10));

-- IMAGE jobs never carry motion fields.
ALTER TABLE "GenerationJob" ADD CONSTRAINT "GenerationJob_image_fields_check"
  CHECK ("kind" <> 'IMAGE' OR ("sourceAssetId" IS NULL AND "motionPreset" IS NULL AND "durationS" IS NULL));

-- "Motion clips made from this image" lookups.
CREATE INDEX "GenerationJob_sourceAssetId_idx" ON "GenerationJob"("sourceAssetId");
