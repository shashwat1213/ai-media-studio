-- CreateEnum
CREATE TYPE "LibraryKind" AS ENUM ('CHARACTER', 'PLACE', 'STYLE', 'VOICE', 'SOUND');

-- CreateTable
CREATE TABLE "LibraryItem" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "kind" "LibraryKind" NOT NULL,
    "handle" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT NOT NULL,
    "settings" JSONB NOT NULL DEFAULT '{}',
    "imageUploadId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "LibraryItem_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "LibraryItem_userId_kind_updatedAt_idx" ON "LibraryItem"("userId", "kind", "updatedAt");

-- CreateIndex
CREATE UNIQUE INDEX "LibraryItem_userId_handle_key" ON "LibraryItem"("userId", "handle");

-- AddForeignKey
ALTER TABLE "LibraryItem" ADD CONSTRAINT "LibraryItem_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Hand-written invariants: handles are lower-case slugs; text has sane bounds (the API checks too).
ALTER TABLE "LibraryItem" ADD CONSTRAINT "LibraryItem_handle_check" CHECK ("handle" ~ '^[a-z0-9_]{2,32}$');
ALTER TABLE "LibraryItem" ADD CONSTRAINT "LibraryItem_text_check"
  CHECK (char_length("name") BETWEEN 1 AND 60 AND char_length("description") <= 1000);
ALTER TABLE "LibraryItem" ADD CONSTRAINT "LibraryItem_settings_object_check" CHECK (jsonb_typeof("settings") = 'object');
