-- WALLETCHI memorial: persist the vault memorialState on the reap flip.
ALTER TABLE "Runner" ADD COLUMN "bornAt" TIMESTAMP(3);
ALTER TABLE "Runner" ADD COLUMN "diedAt" TIMESTAMP(3);
ALTER TABLE "Runner" ADD COLUMN "careCount" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "Runner" ADD COLUMN "deathRank" INTEGER NOT NULL DEFAULT 0;
