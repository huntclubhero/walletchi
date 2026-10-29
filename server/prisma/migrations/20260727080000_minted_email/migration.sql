-- Anti-Sybil atomic email claim: emailHash is the primary key, so reserveEmail
-- is an insert-or-conflict and two concurrent same-email mints can never both
-- pass. Additive only; the column holds a peppered hash, never the address.
CREATE TABLE "MintedEmail" (
    "emailHash" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "MintedEmail_pkey" PRIMARY KEY ("emailHash")
);
