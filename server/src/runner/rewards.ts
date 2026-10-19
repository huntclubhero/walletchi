import type { AppContext } from "../context.js";

// Shared player-rewards READ logic for the /me dashboard's informational panel.
// The CareRewardsDistributor pays 20% of every care into per-epoch pools split
// pro rata INTO each pet's TBA.
//
// SEASON 2, NO CLAIMS: nothing here leads to a claim. The 2h push engine
// (push-rewards.ts) delivers these amounts on its own, and every call it makes is
// permissionless, so this scan answers "what has my pet earned and is waiting to
// be sent" rather than "what can I collect". Callers gate on
// config.modes.rewardsLive first, so it is inert until the distributor is wired.

// How many recent FINISHED epochs to scan for a pet's unpaid rewards.
export const REWARDS_WINDOW = 30;

export interface PendingEpoch {
  epoch: number;
  raw: bigint;
}

// A pet's FINISHED epochs that still carry a positive, unpaid pending, bounded to
// a recent window. Parallel reads (bounded by REWARDS_WINDOW), then a paid check
// only for the epochs that actually carry a pending.
export async function scanPending(
  ctx: AppContext,
  tokenId: string,
): Promise<{ epochNow: number; pending: PendingEpoch[] }> {
  const epochNow = await ctx.relayer.rewardsEpochNow();
  const from = Math.max(0, epochNow - REWARDS_WINDOW);
  const epochs: number[] = [];
  for (let e = from; e < epochNow; e++) epochs.push(e);
  const pendings = await Promise.all(epochs.map((e) => ctx.relayer.rewardsPending(tokenId, e)));
  const positive = epochs
    .map((epoch, i) => ({ epoch, raw: pendings[i]! }))
    .filter((x) => x.raw > 0n);
  const paidFlags = await Promise.all(
    positive.map((x) => ctx.relayer.rewardsClaimed(tokenId, x.epoch)),
  );
  const pending = positive.filter((_, i) => !paidFlags[i]);
  return { epochNow, pending };
}
