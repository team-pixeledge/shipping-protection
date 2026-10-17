-- AlterTable
ALTER TABLE "Claim" ADD COLUMN     "addressHash" TEXT,
ADD COLUMN     "dismissedFlags" TEXT[] DEFAULT ARRAY[]::TEXT[],
ADD COLUMN     "locale" TEXT NOT NULL DEFAULT 'en',
ADD COLUMN     "source" TEXT NOT NULL DEFAULT 'CUSTOMER',
ADD COLUMN     "trackingNumbers" TEXT[] DEFAULT ARRAY[]::TEXT[];

-- AlterTable
ALTER TABLE "OrderRecord" ADD COLUMN     "trackedAt" TIMESTAMP(3);

-- CreateTable
CREATE TABLE "Shipment" (
    "shop" TEXT NOT NULL,
    "fulfillmentId" TEXT NOT NULL,
    "orderId" TEXT NOT NULL,
    "orderName" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "stage" TEXT NOT NULL,
    "tracking" JSONB NOT NULL,
    "trackingNumbers" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "lineItemIds" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "shippedAt" TIMESTAMP(3) NOT NULL,
    "inTransitAt" TIMESTAMP(3),
    "deliveredAt" TIMESTAMP(3),
    "estimatedDeliveryAt" TIMESTAMP(3),
    "lastEventAt" TIMESTAMP(3),
    "lastEventStatus" TEXT,
    "flags" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "flaggedAt" TIMESTAMP(3),
    "checkedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "closedAt" TIMESTAMP(3),
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Shipment_pkey" PRIMARY KEY ("shop","fulfillmentId")
);

-- CreateTable
CREATE TABLE "RateLimit" (
    "key" TEXT NOT NULL,
    "count" INTEGER NOT NULL DEFAULT 0,
    "resetAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "RateLimit_pkey" PRIMARY KEY ("key")
);

-- CreateIndex
CREATE INDEX "Shipment_shop_orderId_idx" ON "Shipment"("shop", "orderId");

-- CreateIndex
CREATE INDEX "Shipment_shop_closedAt_shippedAt_idx" ON "Shipment"("shop", "closedAt", "shippedAt");

-- CreateIndex
CREATE INDEX "Shipment_closedAt_checkedAt_idx" ON "Shipment"("closedAt", "checkedAt");

-- CreateIndex
CREATE INDEX "RateLimit_resetAt_idx" ON "RateLimit"("resetAt");

-- CreateIndex
CREATE INDEX "Claim_shop_addressHash_idx" ON "Claim"("shop", "addressHash");

-- AddForeignKey
ALTER TABLE "Shipment" ADD CONSTRAINT "Shipment_shop_fkey" FOREIGN KEY ("shop") REFERENCES "Shop"("shop") ON DELETE CASCADE ON UPDATE CASCADE;

