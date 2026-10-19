-- Device registrations outlive an auth rotation as SUPERSEDED rows (store/types.ts): they still
-- answer the device's list call, so a superseded pass refreshes into its keepsake view, but they
-- no longer count toward the per-serial cap and stop receiving pushes after a short window.
-- Nullable and additive: every existing row stays live, exactly as before.
ALTER TABLE "RunnerDeviceRegistration" ADD COLUMN "supersededAt" TIMESTAMP(3);
