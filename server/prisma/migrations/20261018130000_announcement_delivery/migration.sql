/* PER-CARD ANNOUNCEMENT DELIVERY (runner/announce.ts). One new table, nothing else changes.
   One row per (serial, text): the card's event line was set to that announcement once. */
CREATE TABLE "AnnouncementDelivery" (
    "serial" TEXT NOT NULL,
    "text" TEXT NOT NULL,
    "deliveredAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AnnouncementDelivery_pkey" PRIMARY KEY ("serial","text")
);

CREATE INDEX "AnnouncementDelivery_text_idx" ON "AnnouncementDelivery"("text");

/* ONE-TIME BACKFILL. The cards whose event line still shows the ACTIVE announcement received it
   before this table existed (2026-10-17 night). Record them, so a re-run of the same text (to reach
   the cards that were skipped for a care reminder) can never banner them a second time. A card
   whose line has already moved on is not recorded: it is indistinguishable from one never reached,
   and a second banner on it is the risk the operator accepts by re-running (see the PR). */
INSERT INTO "AnnouncementDelivery" ("serial", "text")
SELECT r."serial", a."text"
FROM "Runner" r
JOIN "Announcement" a ON a."id" = 'active'
WHERE r."lastEvent" = a."text"
ON CONFLICT DO NOTHING;

/* PUBLIC SNAPSHOT NOTE: the private repo has a second one-time backfill here that records the
   live devices served the 2026-10-17 announcement, by pass serial. Those serials belong to real
   players, so the list is removed from this snapshot. On a fresh database it inserted nothing. */
