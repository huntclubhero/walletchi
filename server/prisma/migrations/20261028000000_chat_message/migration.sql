/* CHI CHAT (runner/chat.ts). One new table, nothing else changes: the room's messages, in id
   order. deletedAt is a moderator's soft delete. */
CREATE TABLE "ChatMessage" (
    "id" SERIAL NOT NULL,
    "serial" TEXT NOT NULL,
    "tokenId" TEXT NOT NULL,
    "body" TEXT NOT NULL,
    "deletedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ChatMessage_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "ChatMessage_serial_idx" ON "ChatMessage"("serial");

/* The name a keeper picks for the room on first entry. nameKey (lowercased) is unique. */
CREATE TABLE "ChatName" (
    "serial" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "nameKey" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ChatName_pkey" PRIMARY KEY ("serial")
);

CREATE UNIQUE INDEX "ChatName_nameKey_key" ON "ChatName"("nameKey");
