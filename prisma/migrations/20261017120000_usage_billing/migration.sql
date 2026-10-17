-- AlterTable
ALTER TABLE "Shop" ADD COLUMN     "billingTest" BOOLEAN NOT NULL DEFAULT false;

-- CreateTable
CREATE TABLE "UsageCharge" (
    "shop" TEXT NOT NULL,
    "orderId" TEXT NOT NULL,
    "orderName" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "amount" DECIMAL(10,2) NOT NULL,
    "periodEnd" TIMESTAMP(3),
    "usageRecordId" TEXT,
    "error" TEXT,
    "test" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "UsageCharge_pkey" PRIMARY KEY ("shop","orderId")
);

-- CreateIndex
CREATE INDEX "UsageCharge_shop_periodEnd_idx" ON "UsageCharge"("shop", "periodEnd");

-- AddForeignKey
ALTER TABLE "UsageCharge" ADD CONSTRAINT "UsageCharge_shop_fkey" FOREIGN KEY ("shop") REFERENCES "Shop"("shop") ON DELETE CASCADE ON UPDATE CASCADE;

