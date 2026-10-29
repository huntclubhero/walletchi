-- WALLETCHI victory prize: the pot paid to the winner at finalize (raw care-token units).
ALTER TABLE "Runner" ADD COLUMN "wonPrize" TEXT NOT NULL DEFAULT '0';
