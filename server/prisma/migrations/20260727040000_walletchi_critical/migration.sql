-- WALLETCHI critical: lapsed-but-in-grace near-death state (fading, still revivable).
ALTER TABLE "Runner" ADD COLUMN "critical" BOOLEAN NOT NULL DEFAULT false;
