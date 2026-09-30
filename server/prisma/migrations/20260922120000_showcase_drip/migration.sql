-- TESTNET SHOWCASE simulated-fee drip ledger. The composite primary key is the once-per-epoch
-- guard (insert-or-conflict before the mint is sent). Additive: no existing table changes.
CREATE TABLE "ShowcaseDrip" (
    "token" TEXT NOT NULL,
    "epoch" INTEGER NOT NULL,
    "amountRaw" TEXT NOT NULL,
    "txHash" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ShowcaseDrip_pkey" PRIMARY KEY ("token","epoch")
);
