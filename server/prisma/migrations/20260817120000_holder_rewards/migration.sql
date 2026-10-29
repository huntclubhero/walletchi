-- TAX ECONOMY holder airdrops: persisted Merkle rounds + leaves so the claim API
-- can serve proofs. New tables only: no existing column changes, no backfill.
CREATE TABLE "HolderRewardRound" (
    "id" INTEGER NOT NULL,
    "root" TEXT NOT NULL,
    "total" TEXT NOT NULL,
    "token" TEXT NOT NULL,
    "txHash" TEXT,
    "postedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "HolderRewardRound_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "HolderRewardLeaf" (
    "roundId" INTEGER NOT NULL,
    "account" TEXT NOT NULL,
    "amount" TEXT NOT NULL,
    "proof" TEXT NOT NULL,

    CONSTRAINT "HolderRewardLeaf_pkey" PRIMARY KEY ("roundId","account")
);

CREATE INDEX "HolderRewardLeaf_account_idx" ON "HolderRewardLeaf"("account");

ALTER TABLE "HolderRewardLeaf" ADD CONSTRAINT "HolderRewardLeaf_roundId_fkey"
    FOREIGN KEY ("roundId") REFERENCES "HolderRewardRound"("id")
    ON DELETE CASCADE ON UPDATE CASCADE;
