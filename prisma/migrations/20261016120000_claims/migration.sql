-- AlterTable
ALTER TABLE "Shop" ADD COLUMN     "portalPath" TEXT NOT NULL DEFAULT '/apps/safeship';

-- CreateTable
CREATE TABLE "Claim" (
    "id" TEXT NOT NULL,
    "shop" TEXT NOT NULL,
    "number" INTEGER NOT NULL,
    "orderId" TEXT NOT NULL,
    "orderName" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'OPEN',
    "email" TEXT NOT NULL,
    "description" TEXT NOT NULL,
    "items" JSONB NOT NULL,
    "amount" DECIMAL(12,2) NOT NULL,
    "currency" TEXT NOT NULL,
    "protected" BOOLEAN NOT NULL,
    "flags" TEXT[],
    "shipments" JSONB NOT NULL,
    "resolution" TEXT,
    "decidedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Claim_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ClaimEvent" (
    "id" TEXT NOT NULL,
    "claimId" TEXT NOT NULL,
    "actor" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "status" TEXT,
    "message" TEXT,
    "internal" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ClaimEvent_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ClaimFile" (
    "id" TEXT NOT NULL,
    "claimId" TEXT NOT NULL,
    "pathname" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "contentType" TEXT NOT NULL,
    "size" INTEGER NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ClaimFile_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "Claim_shop_status_createdAt_idx" ON "Claim"("shop", "status", "createdAt");

-- CreateIndex
CREATE INDEX "Claim_shop_orderId_idx" ON "Claim"("shop", "orderId");

-- CreateIndex
CREATE INDEX "Claim_shop_email_idx" ON "Claim"("shop", "email");

-- CreateIndex
CREATE UNIQUE INDEX "Claim_shop_number_key" ON "Claim"("shop", "number");

-- CreateIndex
CREATE INDEX "ClaimEvent_claimId_createdAt_idx" ON "ClaimEvent"("claimId", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "ClaimFile_pathname_key" ON "ClaimFile"("pathname");

-- CreateIndex
CREATE INDEX "ClaimFile_claimId_idx" ON "ClaimFile"("claimId");

-- AddForeignKey
ALTER TABLE "Claim" ADD CONSTRAINT "Claim_shop_fkey" FOREIGN KEY ("shop") REFERENCES "Shop"("shop") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ClaimEvent" ADD CONSTRAINT "ClaimEvent_claimId_fkey" FOREIGN KEY ("claimId") REFERENCES "Claim"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ClaimFile" ADD CONSTRAINT "ClaimFile_claimId_fkey" FOREIGN KEY ("claimId") REFERENCES "Claim"("id") ON DELETE CASCADE ON UPDATE CASCADE;

