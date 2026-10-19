/* DEVICE MARK (runner/sybil.ts step 6d, one Chi per phone). One new table, nothing else changes.
   One row per browser mark that minted: the peppered hash of the website's random cookie and the
   peppered hash of the inbox it minted. */
CREATE TABLE "MintMark" (
    "markHash" TEXT NOT NULL,
    "emailHash" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "MintMark_pkey" PRIMARY KEY ("markHash")
);

CREATE INDEX "MintMark_emailHash_idx" ON "MintMark"("emailHash");
