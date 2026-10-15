-- AlterEnum
ALTER TYPE "UploadSource" ADD VALUE 'AI_VIDEO';

-- AlterTable
ALTER TABLE "Scene" ADD COLUMN     "motion" TEXT NOT NULL DEFAULT 'still';
