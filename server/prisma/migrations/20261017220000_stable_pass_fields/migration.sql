-- STABLE PASS FIELDS + DEVICE-TRUE PASS DIFF LOG. Two new tables, nothing else changes.
-- PassFieldMemory: the last on-chain-verified value of the ALIVE / CARE / SURVIVES pass fields, so a
-- failed read or a restart serves the last value instead of dropping the field.
-- PassServedSnapshot: the field snapshot of each pass served to Apple Wallet, keyed by its
-- Last-Modified, a few per serial, for the diff log. Additive: no existing table changes.
CREATE TABLE "PassFieldMemory" (
    "key" TEXT NOT NULL,
    "value" TEXT NOT NULL,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "PassFieldMemory_pkey" PRIMARY KEY ("key")
);

CREATE TABLE "PassServedSnapshot" (
    "serial" TEXT NOT NULL,
    "lastModified" TIMESTAMP(3) NOT NULL,
    "fields" TEXT NOT NULL,
    "servedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "PassServedSnapshot_pkey" PRIMARY KEY ("serial","lastModified")
);
