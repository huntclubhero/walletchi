-- Anti-Sybil mint signals: one row per mint attempt (blocked or minted).
-- Additive only; the email lives here solely as a peppered hash.
CREATE TABLE "MintSignal" (
    "id" TEXT NOT NULL,
    "normalizedEmailHash" TEXT NOT NULL,
    "fingerprint" TEXT,
    "ip" TEXT,
    "subnet" TEXT,
    "outcome" TEXT NOT NULL,
    "botFlags" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "MintSignal_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "MintSignal_normalizedEmailHash_idx" ON "MintSignal"("normalizedEmailHash");
CREATE INDEX "MintSignal_ip_idx" ON "MintSignal"("ip");
CREATE INDEX "MintSignal_fingerprint_idx" ON "MintSignal"("fingerprint");
CREATE INDEX "MintSignal_createdAt_idx" ON "MintSignal"("createdAt");
