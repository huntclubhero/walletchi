/* ONE-TIME ANNOUNCEMENT (runner/announce.ts). One new table, nothing else changes.
   At most one row (id "active"): the text the event line may carry a changeMessage for. */
CREATE TABLE "Announcement" (
    "id" TEXT NOT NULL,
    "text" TEXT NOT NULL,
    "setAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Announcement_pkey" PRIMARY KEY ("id")
);
