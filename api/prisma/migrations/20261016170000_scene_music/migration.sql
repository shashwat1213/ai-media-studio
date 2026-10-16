-- AlterEnum
ALTER TYPE "UploadSource" ADD VALUE 'MUSIC';

-- AlterTable
ALTER TABLE "Scene" ADD COLUMN     "music" TEXT NOT NULL DEFAULT 'auto';
