-- Launch fix 1 (pipelined mint): the mint transaction's nonce, persisted together with
-- issueTxHash BEFORE the broadcast, so a process restarted mid-burst can re-attach to
-- every in-flight mint (or prove one never landed) instead of reaping it by age.
-- Additive, nullable: existing rows are untouched.
ALTER TABLE "Runner" ADD COLUMN "issueNonce" INTEGER;
