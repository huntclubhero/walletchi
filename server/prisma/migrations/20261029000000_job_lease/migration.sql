/* Cross-instance job lease (store.tryAcquireJobLease). The holder round job takes it so two
   overlapping server instances can never snapshot and post the same round id. Additive only. */
CREATE TABLE "JobLease" (
    "name" TEXT NOT NULL,
    "holder" TEXT NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "JobLease_pkey" PRIMARY KEY ("name")
);
