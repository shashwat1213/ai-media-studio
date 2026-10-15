-- CreateEnum
CREATE TYPE "UploadStatus" AS ENUM ('PENDING', 'READY');

-- AlterEnum
ALTER TYPE "JobKind" ADD VALUE 'EDIT';

-- AlterTable
ALTER TABLE "GenerationJob" ADD COLUMN     "editSpec" JSONB;

-- CreateTable
CREATE TABLE "Upload" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "status" "UploadStatus" NOT NULL DEFAULT 'PENDING',
    "storageKey" TEXT NOT NULL,
    "fileName" TEXT NOT NULL,
    "mimeType" TEXT NOT NULL,
    "bytes" INTEGER NOT NULL,
    "width" INTEGER,
    "height" INTEGER,
    "durationMs" INTEGER,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Upload_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "Upload_storageKey_key" ON "Upload"("storageKey");

-- CreateIndex
CREATE INDEX "Upload_userId_status_createdAt_idx" ON "Upload"("userId", "status", "createdAt");

-- AddForeignKey
ALTER TABLE "Upload" ADD CONSTRAINT "Upload_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Hand-written invariants. `kind::text`: Postgres forbids using a freshly added enum value
-- ('EDIT') inside the same transaction that added it; comparing as text sidesteps that safely.
-- (enforced by the database, not just the app).
-- The IMAGE check from the motion migration stays as is; EDIT jobs carry a spec + a length and
-- never a motion preset or source image.
ALTER TABLE "GenerationJob" ADD CONSTRAINT "GenerationJob_edit_fields_check"
  CHECK ("kind"::text <> 'EDIT' OR ("editSpec" IS NOT NULL AND "durationS" BETWEEN 1 AND 120 AND "motionPreset" IS NULL AND "sourceAssetId" IS NULL));

-- Only EDIT jobs carry an edit spec.
ALTER TABLE "GenerationJob" ADD CONSTRAINT "GenerationJob_spec_only_edit_check"
  CHECK ("kind"::text = 'EDIT' OR "editSpec" IS NULL);

ALTER TABLE "Upload" ADD CONSTRAINT "Upload_bytes_check" CHECK ("bytes" > 0);
