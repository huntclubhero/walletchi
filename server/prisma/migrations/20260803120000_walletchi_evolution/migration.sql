-- WALLETCHI evolution: track the highest evolution stage a pet has celebrated so
-- the idle engine fires the momentous evolution event exactly once per stage.
-- Additive column with a safe default (0 = egg), so existing rows need no backfill.
ALTER TABLE "Runner" ADD COLUMN "lastStage" INTEGER NOT NULL DEFAULT 0;
