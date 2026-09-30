-- Idle cub layer: the card plays itself between runs.
ALTER TABLE "Runner" ADD COLUMN "idleSalmon" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "Runner" ADD COLUMN "lastTickAt" TIMESTAMP(3);
ALTER TABLE "Runner" ADD COLUMN "lastEvent" TEXT;
ALTER TABLE "Runner" ADD COLUMN "lastPushAt" TIMESTAMP(3);
ALTER TABLE "Runner" ADD COLUMN "lastIdleCatchAt" TIMESTAMP(3);
ALTER TABLE "Runner" ADD COLUMN "pendingDigest" INTEGER NOT NULL DEFAULT 0;
