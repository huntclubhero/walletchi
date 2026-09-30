-- Card Play: cub-care actions + forks.
ALTER TABLE "Runner" ADD COLUMN "lastHoneyAt" TIMESTAMP(3);
ALTER TABLE "Runner" ADD COLUMN "lastFishAt" TIMESTAMP(3);
ALTER TABLE "Runner" ADD COLUMN "lastExploreAt" TIMESTAMP(3);
ALTER TABLE "Runner" ADD COLUMN "pendingSalmon" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "Runner" ADD COLUMN "activeFork" TEXT;
ALTER TABLE "Runner" ADD COLUMN "forkExpiresAt" TIMESTAMP(3);

-- CreateTable
CREATE TABLE "RunnerEvent" (
    "id" TEXT NOT NULL,
    "serial" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "message" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "RunnerEvent_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "RunnerEvent_serial_idx" ON "RunnerEvent"("serial");

-- CreateIndex
CREATE INDEX "RunnerEvent_createdAt_idx" ON "RunnerEvent"("createdAt");

-- AddForeignKey
ALTER TABLE "RunnerEvent" ADD CONSTRAINT "RunnerEvent_serial_fkey" FOREIGN KEY ("serial") REFERENCES "Runner"("serial") ON DELETE CASCADE ON UPDATE CASCADE;
