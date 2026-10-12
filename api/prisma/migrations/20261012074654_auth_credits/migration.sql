-- CreateEnum
CREATE TYPE "CreditReason" AS ENUM ('SIGNUP_BONUS', 'PURCHASE', 'GENERATION', 'REFUND');

-- AlterTable
ALTER TABLE "User" ADD COLUMN     "credits" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP;

-- Hand-edited: the temporary default above back-fills existing rows safely;
-- Prisma sets updatedAt itself (@updatedAt), so drop the DB default to match the schema.
ALTER TABLE "User" ALTER COLUMN "updatedAt" DROP DEFAULT;

-- Hand-edited: business invariants enforced by the database itself (Prisma can't model CHECKs).
-- Last line of defence if application code ever has a bug.
ALTER TABLE "User" ADD CONSTRAINT "User_credits_non_negative" CHECK ("credits" >= 0);

-- CreateTable
CREATE TABLE "CreditTransaction" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "delta" INTEGER NOT NULL,
    "reason" "CreditReason" NOT NULL,
    "balanceAfter" INTEGER NOT NULL,
    "refId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "CreditTransaction_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "CreditTransaction_userId_createdAt_idx" ON "CreditTransaction"("userId", "createdAt");

-- AddForeignKey
ALTER TABLE "CreditTransaction" ADD CONSTRAINT "CreditTransaction_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;


-- Hand-edited: ledger rows must move the balance and can never leave it negative.
ALTER TABLE "CreditTransaction" ADD CONSTRAINT "CreditTransaction_delta_non_zero" CHECK ("delta" <> 0);
ALTER TABLE "CreditTransaction" ADD CONSTRAINT "CreditTransaction_balanceAfter_non_negative" CHECK ("balanceAfter" >= 0);
