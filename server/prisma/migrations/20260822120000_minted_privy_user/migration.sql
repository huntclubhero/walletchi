-- Anti-Sybil atomic PRIVY-IDENTITY claim: the one-verified-keeper-one-pet wall.
-- subjectHash is the primary key, so reservePrivyUser is an insert-or-conflict and
-- two concurrent mints from one verified Privy session can never both pass. The
-- column holds a peppered HMAC of the Privy user id, never the raw id.
CREATE TABLE "MintedPrivyUser" (
    "subjectHash" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "MintedPrivyUser_pkey" PRIMARY KEY ("subjectHash")
);

-- Which verified identity minted a pet, so a genuinely failed mint can release the
-- claim above (parity with the existing MintedEmail release). Nullable and additive:
-- every existing row keeps working, no backfill, no default rewrite.
ALTER TABLE "Runner" ADD COLUMN "privyUserHash" TEXT;
