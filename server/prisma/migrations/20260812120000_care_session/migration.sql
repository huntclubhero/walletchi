-- On-chain scoped care session: one row per pet holding the Alchemy MAv2 session
-- key that is scoped ON-CHAIN to care(uint256,uint8) on the PetVault and nothing
-- else. This is what lets a wallet-pass tap feed the pet with no website and no
-- signature after the owner signs exactly once.
--
-- New table only: no existing column changes, no backfill. A pet with no row here
-- simply falls back to the proven owner-signed care page.
CREATE TABLE "CareSession" (
    "serial" TEXT NOT NULL,
    "tokenId" TEXT NOT NULL,
    "ownerAddress" TEXT NOT NULL,
    "vaultAddress" TEXT NOT NULL,
    "publicKey" TEXT NOT NULL,
    "secretEnc" TEXT NOT NULL,
    "context" TEXT NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "revokedAt" TIMESTAMP(3),
    "revokedReason" TEXT,
    "lastUsedAt" TIMESTAMP(3),
    "useCount" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "CareSession_pkey" PRIMARY KEY ("serial")
);

CREATE INDEX "CareSession_tokenId_idx" ON "CareSession"("tokenId");

CREATE INDEX "CareSession_expiresAt_idx" ON "CareSession"("expiresAt");

ALTER TABLE "CareSession" ADD CONSTRAINT "CareSession_serial_fkey" FOREIGN KEY ("serial") REFERENCES "Runner"("serial") ON DELETE CASCADE ON UPDATE CASCADE;
