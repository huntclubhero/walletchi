-- WALLETCHI pixel pet: egg/hatch, toys, survival death flag, play/toy cooldowns.
ALTER TABLE "Runner" ADD COLUMN "lastPlayAt" TIMESTAMP(3);
ALTER TABLE "Runner" ADD COLUMN "lastToyAt" TIMESTAMP(3);
ALTER TABLE "Runner" ADD COLUMN "hatched" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "Runner" ADD COLUMN "toys" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "Runner" ADD COLUMN "gone" BOOLEAN NOT NULL DEFAULT false;
