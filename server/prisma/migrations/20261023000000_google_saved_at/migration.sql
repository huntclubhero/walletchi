/* GOOGLE WALLET SAVE SEEN (routes.ts wallet-callback). One nullable column, nothing else changes:
   the moment Google's save callback last named this pet's current object. Display only. */
ALTER TABLE "Runner" ADD COLUMN "googleSavedAt" TIMESTAMP(3);
