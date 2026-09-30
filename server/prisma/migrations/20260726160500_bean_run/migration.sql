-- CreateTable
CREATE TABLE "Runner" (
    "serial" TEXT NOT NULL,
    "tokenId" TEXT,
    "tbaAddress" TEXT,
    "ownerAddress" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "bestScore" INTEGER NOT NULL DEFAULT 0,
    "beans" INTEGER NOT NULL DEFAULT 0,
    "runs" INTEGER NOT NULL DEFAULT 0,
    "authToken" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'minting',
    "issueTxHash" TEXT,
    "failureReason" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Runner_pkey" PRIMARY KEY ("serial")
);

-- CreateTable
CREATE TABLE "RunSession" (
    "token" TEXT NOT NULL,
    "serial" TEXT NOT NULL,
    "used" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "RunSession_pkey" PRIMARY KEY ("token")
);

-- CreateTable
CREATE TABLE "RunnerDeviceRegistration" (
    "deviceLibraryId" TEXT NOT NULL,
    "passTypeId" TEXT NOT NULL,
    "serial" TEXT NOT NULL,
    "pushToken" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "RunnerDeviceRegistration_pkey" PRIMARY KEY ("deviceLibraryId","passTypeId","serial")
);

-- CreateIndex
CREATE UNIQUE INDEX "Runner_authToken_key" ON "Runner"("authToken");

-- CreateIndex
CREATE INDEX "Runner_email_idx" ON "Runner"("email");

-- CreateIndex
CREATE INDEX "Runner_tokenId_idx" ON "Runner"("tokenId");

-- CreateIndex
CREATE INDEX "RunSession_serial_idx" ON "RunSession"("serial");

-- CreateIndex
CREATE INDEX "RunnerDeviceRegistration_serial_idx" ON "RunnerDeviceRegistration"("serial");

-- CreateIndex
CREATE INDEX "RunnerDeviceRegistration_passTypeId_serial_idx" ON "RunnerDeviceRegistration"("passTypeId", "serial");

-- AddForeignKey
ALTER TABLE "RunSession" ADD CONSTRAINT "RunSession_serial_fkey" FOREIGN KEY ("serial") REFERENCES "Runner"("serial") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RunnerDeviceRegistration" ADD CONSTRAINT "RunnerDeviceRegistration_serial_fkey" FOREIGN KEY ("serial") REFERENCES "Runner"("serial") ON DELETE CASCADE ON UPDATE CASCADE;
