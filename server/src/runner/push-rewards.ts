import { config } from "../config.js";
import { logger } from "../logger.js";
import type { AppContext } from "../context.js";
import { pushHolderRewards } from "./tax-rewards.js";
import { runShowcaseFeeLeg } from "./showcase-drip.js";

// SEASON 2, NO CLAIMS: the 2h push engine (Hunt's ruling 2026-08-30).
//
// Nobody claims anything, ever. Every reward is PUSHED to where the asset lives:
// a pet's care rewards to the pet's own ERC-6551 account, the winner's pot to the
// winning pet's account. This engine is the thing that does the pushing on a
// timer, and the single most important fact about it is that it holds NO
// authority: every call it makes is permissionless with contract-enforced amounts
// and contract-enforced destinations. A caller can only choose WHO gets paid
// EARLIER, never how much and never to where. So if this server is down for a
// week, nothing is stranded and nobody is stuck: anyone at all can run the exact
// same calls, and the money still lands in the same accounts.
//
// One cycle does five things, in order:
//   1. PUSH   pendingReward > 0 means alive, unpaid, and holding points, so those
//             pets are paid in one pushRewards per epoch.
//   2. FORFEIT a dead pet's pending reads 0 while its points stay positive; that
//             pair is the forfeit signal, and sweepForfeited rolls the share into
//             a future pool for the survivors.
//   3. HOLDER  the USDG airdrop leg: every unclaimed leaf in the recent rounds is
//             delivered to its holder without the holder asking.
//   4. PRIZE  any prize finalize() could not deliver is retried with pushPrize.
//   5. RESIDUAL once the season has settled, whatever is left in the distributor
//             goes to the champion rather than sitting locked forever.
//
// EACH LEG IS SEPARATELY GATED and separately fallible. The pet legs need
// config.modes.rewardsLive, the holder leg needs holderRewardsLive, the
// settlement tail needs survivalLive; a cycle with only some of those configured
// does the part it can, and a leg that throws never takes the others down with it.

/**
 * How many FINISHED epochs one cycle sweeps (config.REWARDS_PUSH_EPOCH_WINDOW,
 * default 12 = ceil(lifeTtl / epochLength) at the shipped 2h epoch and 1 day life
 * window). At least 1, always.
 *
 * It is a window rather than a full-season scan because an unpushed epoch stays
 * pushable right up until the season settles. It is a CONFIGURABLE window because
 * what happens after that is not neutral: the residual sweep hands anything still
 * unpushed to the champion instead of the pets that earned it, so an outage longer
 * than the window needs a way to catch up that does not require a deploy. See the
 * config declaration.
 */
function epochWindow(): number {
  return Math.max(1, config.REWARDS_PUSH_EPOCH_WINDOW);
}

// Pets per write. The on-chain loop is one storage read plus at most one transfer
// per id, so a few hundred fits a block comfortably; the chunking exists so a
// full 2,000-pet season cannot build a transaction nobody can mine.
export const REWARDS_PUSH_BATCH = 200;

// Concurrent view reads. A cycle is O(pets x epochs) reads and the pet count is
// bounded by the supply cap, so this is the knob that keeps a 2,000-pet season
// from opening two thousand sockets at once against the RPC.
const READ_CONCURRENCY = 25;

export interface PushCycleSummary {
  epochsScanned: number;
  pushedPets: number;
  pushedRaw: bigint;
  forfeitedPets: number;
  /** Holder-airdrop rounds scanned, and leaves actually delivered. */
  holderRounds: number;
  holderPushed: number;
  prizePushed: boolean;
  residualSwept: boolean;
  /** Reads that failed. The ids stay eligible and are retried next cycle. */
  skippedReads: number;
}

function emptySummary(): PushCycleSummary {
  return {
    epochsScanned: 0,
    pushedPets: 0,
    pushedRaw: 0n,
    forfeitedPets: 0,
    holderRounds: 0,
    holderPushed: 0,
    prizePushed: false,
    residualSwept: false,
    skippedReads: 0,
  };
}

/** Run `fn` over `items` at bounded concurrency, preserving order. */
async function mapLimited<T, R>(items: T[], fn: (item: T) => Promise<R>): Promise<R[]> {
  const out: R[] = [];
  for (let i = 0; i < items.length; i += READ_CONCURRENCY) {
    const slice = items.slice(i, i + READ_CONCURRENCY);
    out.push(...(await Promise.all(slice.map(fn))));
  }
  return out;
}

function chunk<T>(items: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

/**
 * Every pet that could be owed something, as a UNION of two sources that each
 * miss a different case. The vault's registeredCount covers pets this server
 * never saw (a direct mint), and it is the cheap read: one call for the whole
 * roster, since ids are sequential from 1. The store covers a pet whose
 * registration the vault SKIPPED (RegisterSkipped fires when the entry window has
 * closed), which would otherwise leave every later id invisible to the count.
 * DEAD pets are deliberately included: they are exactly the forfeit candidates.
 */
async function candidateTokenIds(ctx: AppContext): Promise<string[]> {
  const cap = Math.max(0, config.RUNNER_SUPPLY_CAP);
  const ids = new Set<string>();
  try {
    const stats = await ctx.relayer.petVaultStats();
    for (let i = 1; i <= Math.min(stats.registeredCount, cap); i++) ids.add(String(i));
  } catch (err) {
    logger.warn({ err: String(err) }, "push cycle: registeredCount read failed; falling back to the store roster");
  }
  try {
    for (const r of await ctx.store.allMintedRunners()) {
      if (!r.tokenId) continue;
      const n = Number(r.tokenId);
      if (Number.isSafeInteger(n) && n >= 1 && n <= cap) ids.add(r.tokenId);
    }
  } catch (err) {
    logger.warn({ err: String(err) }, "push cycle: store roster read failed");
  }
  return [...ids].sort((a, b) => Number(a) - Number(b));
}

/**
 * The settlement tail: the two pushes that only make sense once the season is
 * decided. Called both by the 2h engine and, so the winner is paid to the second
 * rather than at the next tick, straight after a successful finalize poke.
 *
 * Both halves are independent and each owns its own error handling: a distributor
 * that refuses the residual sweep must never be the reason the winner's escrowed
 * prize goes unretried, and vice versa.
 */
export async function runSettlementTail(
  ctx: AppContext,
): Promise<{ prizePushed: boolean; residualSwept: boolean }> {
  const out = { prizePushed: false, residualSwept: false };
  if (!config.modes.survivalLive) return out;

  let settled = false;
  let winner = "0";
  try {
    const state = await ctx.relayer.settlementState();
    settled = state.finalized; // finalized == potClaimed
    // `leader` is frozen once the pot is claimed, so after settlement the
    // candidate IS the champion.
    winner = state.candidate;
  } catch (err) {
    logger.warn({ err: String(err) }, "settlement tail: settlementState read failed");
    return out;
  }
  if (!settled || winner === "0") return out;

  // 1. The escrowed prize. finalize() pays the winner's TBA directly and does not
  // block on a care token that refuses; when that happens the prize waits in
  // unpaidPrize and this retry delivers it. The winner still signs nothing: the
  // destination is the pet's own account, fixed in the contract.
  try {
    const owed = await ctx.relayer.vaultUnpaidPrize(winner);
    if (owed > 0n) {
      const { txHash } = await ctx.relayer.vaultPushPrize(winner);
      out.prizePushed = true;
      logger.info({ txHash, winner, owed: owed.toString() }, "settlement tail: escrowed prize pushed to the champion");
    }
  } catch (err) {
    logger.warn({ err: String(err), winner }, "settlement tail: prize push failed (retried next cycle)");
  }

  // 2. The distributor residual. No epoch can ever earn another point once the
  // vault has settled, so anything still sitting here would be locked forever.
  // The sweep reverts AlreadySwept on a repeat, hence the view first.
  if (config.modes.rewardsLive) {
    try {
      if (!(await ctx.relayer.rewardsResidualSwept())) {
        const { txHash } = await ctx.relayer.rewardsSweepResidual();
        out.residualSwept = true;
        logger.info({ txHash, winner }, "settlement tail: rewards residual swept to the champion");
      }
    } catch (err) {
      logger.warn({ err: String(err) }, "settlement tail: residual sweep failed (retried next cycle)");
    }
  }
  return out;
}

/**
 * True when at least one leg of a cycle could do something. Each leg has its own
 * gate, so "the pet distributor is undeployed" must not silence the holder
 * airdrops or leave the winner's escrowed prize unretried.
 */
function anyLegLive(): boolean {
  return Boolean(
    config.modes.rewardsLive || config.modes.holderRewardsLive || config.modes.survivalLive,
  );
}

/**
 * One push cycle. Returns null when EVERY leg is dark, so the caller can tell
 * "nothing to do" apart from "did nothing".
 */
export async function runRewardsPush(ctx: AppContext): Promise<PushCycleSummary | null> {
  if (!anyLegLive()) return null;
  const summary = emptySummary();

  if (config.modes.rewardsLive) {
    await pushPetRewards(ctx, summary);
  }

  // TESTNET SHOWCASE: simulated trading fees into the splitter, then distribute(), every epoch. A
  // no-op unless SHOWCASE_USDG_DRIP. Never throws.
  await runShowcaseFeeLeg(ctx);

  // The holder leg: independently gated, and independently fallible. It owns its
  // error handling, so a holder-side RPC problem cannot cost the pets their push
  // or the winner their prize.
  try {
    const holder = await pushHolderRewards(ctx);
    summary.holderRounds = holder.rounds;
    summary.holderPushed = holder.pushed;
  } catch (err) {
    logger.warn({ err: String(err) }, "push cycle: holder leg failed (retried next cycle)");
  }

  const tail = await runSettlementTail(ctx);
  summary.prizePushed = tail.prizePushed;
  summary.residualSwept = tail.residualSwept;

  logger.info(
    {
      epochsScanned: summary.epochsScanned,
      pushedPets: summary.pushedPets,
      pushedRaw: summary.pushedRaw.toString(),
      forfeitedPets: summary.forfeitedPets,
      holderRounds: summary.holderRounds,
      holderPushed: summary.holderPushed,
      prizePushed: summary.prizePushed,
      residualSwept: summary.residualSwept,
      skippedReads: summary.skippedReads,
    },
    "rewards push cycle complete",
  );
  return summary;
}

/** The pet legs: push what is owed for each finished epoch, then forfeit the dead. */
async function pushPetRewards(ctx: AppContext, summary: PushCycleSummary): Promise<void> {
  let epochNow: number;
  try {
    epochNow = await ctx.relayer.rewardsEpochNow();
  } catch (err) {
    logger.warn({ err: String(err) }, "push cycle: epochNow read failed; skipping the pet legs");
    return;
  }
  const ids = await candidateTokenIds(ctx);
  if (ids.length === 0) {
    logger.info({ epochNow }, "push cycle: no registered pets yet");
    return;
  }

  // Death is per pet, not per epoch, and it is permanent, so read it ONCE for the
  // whole cycle. This is the vault's own definition (petState().dead), which is
  // the same read the distributor makes and which exempts the immortal champion,
  // so the champion is pushed like any living pet rather than forfeited.
  const deadCache = new Map<string, boolean>();
  const deadOf = async (tokenId: string): Promise<boolean | null> => {
    const hit = deadCache.get(tokenId);
    if (hit !== undefined) return hit;
    try {
      const dead = (await ctx.relayer.petState(tokenId)).dead;
      deadCache.set(tokenId, dead);
      return dead;
    } catch (err) {
      logger.warn({ err: String(err), tokenId }, "push cycle: petState read failed");
      return null;
    }
  };

  const from = Math.max(0, epochNow - epochWindow());
  let seasonSettled = false;
  for (let epoch = from; epoch < epochNow && !seasonSettled; epoch++) {
    summary.epochsScanned += 1;

    // A positive pending is the whole payment test in one read: it is non-zero
    // only for a pet that is alive, unpaid, and holding points.
    const pendings = await mapLimited(ids, (id) =>
      ctx.relayer.rewardsPending(id, epoch).catch((err) => {
        logger.warn({ err: String(err), tokenId: id, epoch }, "push cycle: pendingReward read failed");
        return null;
      }),
    );

    const pushIds: string[] = [];
    const zeroIds: string[] = [];
    const pendingById = new Map<string, bigint>();
    ids.forEach((id, i) => {
      const pending = pendings[i];
      if (pending === null || pending === undefined) {
        summary.skippedReads += 1;
        return;
      }
      if (pending > 0n) {
        pushIds.push(id);
        pendingById.set(id, pending);
      } else {
        zeroIds.push(id);
      }
    });

    // A zero pending is one of three things: already paid, no points, or DEAD.
    // Only the third is a forfeit, and it has to be confirmed against the vault
    // rather than inferred, because sweepForfeited reverts PetIsAlive on the
    // WHOLE batch if a single listed pet turns out to be alive.
    const forfeitIds: string[] = [];
    for (const id of zeroIds) {
      let points: bigint;
      try {
        points = await ctx.relayer.rewardsPoints(id, epoch);
      } catch (err) {
        logger.warn({ err: String(err), tokenId: id, epoch }, "push cycle: points read failed");
        summary.skippedReads += 1;
        continue;
      }
      if (points === 0n) continue; // never earned anything here
      let alreadyPaid: boolean;
      try {
        alreadyPaid = await ctx.relayer.rewardsClaimed(id, epoch);
      } catch (err) {
        logger.warn({ err: String(err), tokenId: id, epoch }, "push cycle: claimed read failed");
        summary.skippedReads += 1;
        continue;
      }
      if (alreadyPaid) continue;
      const dead = await deadOf(id);
      if (dead === null) {
        summary.skippedReads += 1;
        continue;
      }
      if (dead) forfeitIds.push(id);
    }

    for (const batch of chunk(pushIds, REWARDS_PUSH_BATCH)) {
      try {
        const { txHash } = await ctx.relayer.rewardsPushMany(epoch, batch);
        summary.pushedPets += batch.length;
        // The amount is what the chain told us was pending a moment ago; the
        // transfer itself is contract-enforced, so this is a report, not a promise.
        const batchRaw = batch.reduce((a, id) => a + (pendingById.get(id) ?? 0n), 0n);
        summary.pushedRaw += batchRaw;
        logger.info({ txHash, epoch, pets: batch.length, raw: batchRaw.toString() }, "push cycle: rewards pushed");
      } catch (err) {
        const msg = String(err);
        // SeasonSettled is not a retryable blip: the residual sweep has already
        // moved every remaining token to the champion, so no epoch can pay again.
        // Stop the cycle instead of burning gas on the same certain revert per epoch.
        if (/SeasonSettled/.test(msg)) {
          seasonSettled = true;
          logger.info({ epoch }, "push cycle: season settled; no epoch can pay again (stopping)");
          break;
        }
        logger.warn({ err: msg, epoch, pets: batch.length }, "push cycle: rewards push failed (retried next cycle)");
      }
    }

    for (const batch of chunk(forfeitIds, REWARDS_PUSH_BATCH)) {
      if (seasonSettled) break;
      try {
        const { txHash } = await ctx.relayer.rewardsSweepForfeited(epoch, batch);
        summary.forfeitedPets += batch.length;
        logger.info({ txHash, epoch, pets: batch.length }, "push cycle: dead pets' shares forfeited to the survivors");
      } catch (err) {
        logger.warn({ err: String(err), epoch, pets: batch.length }, "push cycle: forfeit sweep failed (retried next cycle)");
      }
    }
  }

  logger.info(
    { epochNow, pets: ids.length, pushed: summary.pushedPets, forfeited: summary.forfeitedPets },
    "push cycle: pet legs done",
  );
}

// The 2h engine. Same shape as the season engine in deathwatch.ts: one interval,
// an in-flight latch so a slow cycle (O(pets x epochs) reads) never stacks a
// second copy of itself, and unref so it can never hold the process open.
let pushTickInFlight = false;

export function startRewardsPushEngine(ctx: AppContext): { stop: () => void } {
  // Started when ANY leg is live, not just the pet distributor: the holder
  // airdrops and the winner's escrowed prize are separate promises with separate
  // gates, and an undeployed CareRewardsDistributor is no reason to leave either
  // of them undelivered.
  if (!anyLegLive()) {
    logger.info("rewards push engine OFF (no reward leg is live)");
    return { stop: () => {} };
  }
  const t = setInterval(() => {
    if (pushTickInFlight) {
      logger.warn("rewards push tick still running; skipping this interval");
      return;
    }
    pushTickInFlight = true;
    void runRewardsPush(ctx)
      .catch((e) => logger.error({ err: String(e) }, "rewards push cycle failed"))
      .finally(() => {
        pushTickInFlight = false;
      });
  }, config.REWARDS_PUSH_MINUTES * 60_000);
  t.unref?.();
  logger.info(
    { everyMinutes: config.REWARDS_PUSH_MINUTES, epochWindow: epochWindow() },
    "rewards push engine started (no claims: everything is pushed)",
  );
  return { stop: () => clearInterval(t) };
}

// Test hook: drop the in-flight latch so the smoke can drive independent cycles.
export function _resetPushState(): void {
  pushTickInFlight = false;
}
