-- CreateSchema
CREATE SCHEMA IF NOT EXISTS "public";

-- CreateTable
CREATE TABLE "Session" (
    "id" TEXT NOT NULL,
    "shop" TEXT NOT NULL,
    "state" TEXT NOT NULL,
    "isOnline" BOOLEAN NOT NULL DEFAULT false,
    "scope" TEXT,
    "expires" TIMESTAMP(3),
    "accessToken" TEXT NOT NULL,
    "userId" BIGINT,
    "firstName" TEXT,
    "lastName" TEXT,
    "email" TEXT,
    "accountOwner" BOOLEAN NOT NULL DEFAULT false,
    "locale" TEXT,
    "collaborator" BOOLEAN DEFAULT false,
    "emailVerified" BOOLEAN DEFAULT false,
    "refreshToken" TEXT,
    "refreshTokenExpires" TIMESTAMP(3),

    CONSTRAINT "Session_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Shop" (
    "shop" TEXT NOT NULL,
    "currency" TEXT NOT NULL DEFAULT 'USD',
    "installedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "uninstalledAt" TIMESTAMP(3),
    "settings" JSONB,
    "version" INTEGER NOT NULL DEFAULT 0,
    "syncedVersion" INTEGER NOT NULL DEFAULT 0,
    "syncError" TEXT,
    "productId" TEXT,
    "productHandle" TEXT,
    "validationId" TEXT,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Shop_pkey" PRIMARY KEY ("shop")
);

-- CreateTable
CREATE TABLE "OrderRecord" (
    "shop" TEXT NOT NULL,
    "orderId" TEXT NOT NULL,
    "orderName" TEXT NOT NULL,
    "protected" BOOLEAN NOT NULL,
    "choice" TEXT,
    "fee" DECIMAL(12,2) NOT NULL,
    "currency" TEXT NOT NULL,
    "orderedAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "OrderRecord_pkey" PRIMARY KEY ("shop","orderId")
);

-- CreateIndex
CREATE INDEX "OrderRecord_shop_orderedAt_idx" ON "OrderRecord"("shop", "orderedAt");

-- AddForeignKey
ALTER TABLE "OrderRecord" ADD CONSTRAINT "OrderRecord_shop_fkey" FOREIGN KEY ("shop") REFERENCES "Shop"("shop") ON DELETE CASCADE ON UPDATE CASCADE;

