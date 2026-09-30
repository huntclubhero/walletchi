-- CreateTable
CREATE TABLE "Card" (
    "serial" TEXT NOT NULL,
    "tokenId" TEXT,
    "tbaAddress" TEXT,
    "ownerAddress" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "balanceCache" INTEGER NOT NULL DEFAULT 0,
    "punchesCache" INTEGER NOT NULL DEFAULT 0,
    "authToken" TEXT NOT NULL,
    "issueTxHash" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Card_pkey" PRIMARY KEY ("serial")
);

-- CreateTable
CREATE TABLE "CheckoutSession" (
    "id" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "walletAddress" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "priceCents" INTEGER NOT NULL,
    "loadCents" INTEGER NOT NULL,
    "paymentTxHash" TEXT,
    "serial" TEXT,
    "txHashes" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "failureReason" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "CheckoutSession_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AppleDeviceRegistration" (
    "deviceLibraryId" TEXT NOT NULL,
    "passTypeId" TEXT NOT NULL,
    "serial" TEXT NOT NULL,
    "pushToken" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AppleDeviceRegistration_pkey" PRIMARY KEY ("deviceLibraryId","passTypeId","serial")
);

-- CreateTable
CREATE TABLE "Redemption" (
    "jti" TEXT NOT NULL,
    "serial" TEXT NOT NULL,
    "amountCents" INTEGER NOT NULL,
    "vendorId" TEXT NOT NULL,
    "txHash" TEXT,
    "freeCoffee" BOOLEAN NOT NULL DEFAULT false,
    "punchesAfter" INTEGER NOT NULL DEFAULT 0,
    "balanceAfterCents" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Redemption_pkey" PRIMARY KEY ("jti")
);

-- CreateTable
CREATE TABLE "Vendor" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "pin" TEXT NOT NULL,
    "wallet" TEXT NOT NULL,

    CONSTRAINT "Vendor_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "Card_authToken_key" ON "Card"("authToken");

-- CreateIndex
CREATE INDEX "Card_ownerAddress_idx" ON "Card"("ownerAddress");

-- CreateIndex
CREATE INDEX "Card_email_idx" ON "Card"("email");

-- CreateIndex
CREATE INDEX "CheckoutSession_walletAddress_idx" ON "CheckoutSession"("walletAddress");

-- CreateIndex
CREATE INDEX "CheckoutSession_status_idx" ON "CheckoutSession"("status");

-- CreateIndex
CREATE INDEX "AppleDeviceRegistration_serial_idx" ON "AppleDeviceRegistration"("serial");

-- CreateIndex
CREATE INDEX "AppleDeviceRegistration_passTypeId_serial_idx" ON "AppleDeviceRegistration"("passTypeId", "serial");

-- CreateIndex
CREATE INDEX "Redemption_serial_idx" ON "Redemption"("serial");

-- CreateIndex
CREATE INDEX "Redemption_createdAt_idx" ON "Redemption"("createdAt");

-- AddForeignKey
ALTER TABLE "AppleDeviceRegistration" ADD CONSTRAINT "AppleDeviceRegistration_serial_fkey" FOREIGN KEY ("serial") REFERENCES "Card"("serial") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Redemption" ADD CONSTRAINT "Redemption_serial_fkey" FOREIGN KEY ("serial") REFERENCES "Card"("serial") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Redemption" ADD CONSTRAINT "Redemption_vendorId_fkey" FOREIGN KEY ("vendorId") REFERENCES "Vendor"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
