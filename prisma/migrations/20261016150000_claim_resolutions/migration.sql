-- AlterTable
ALTER TABLE "Claim" ADD COLUMN     "resolutionLock" TEXT,
ADD COLUMN     "resolvedAt" TIMESTAMP(3);

-- CreateTable
CREATE TABLE "ClaimResolution" (
    "id" TEXT NOT NULL,
    "claimId" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'PROCESSING',
    "amount" DECIMAL(12,2) NOT NULL,
    "currency" TEXT NOT NULL,
    "shopifyId" TEXT,
    "shopifyName" TEXT,
    "note" TEXT,
    "error" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "completedAt" TIMESTAMP(3),

    CONSTRAINT "ClaimResolution_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "ClaimResolution_claimId_idx" ON "ClaimResolution"("claimId");

-- CreateIndex
CREATE INDEX "ClaimResolution_status_completedAt_idx" ON "ClaimResolution"("status", "completedAt");

-- AddForeignKey
ALTER TABLE "ClaimResolution" ADD CONSTRAINT "ClaimResolution_claimId_fkey" FOREIGN KEY ("claimId") REFERENCES "Claim"("id") ON DELETE CASCADE ON UPDATE CASCADE;

