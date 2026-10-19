import { config } from "../config.js";
import { logger } from "../logger.js";
import type { AppContext } from "../context.js";
import { runSettlementTail } from "./push-rewards.js";

// WALLETCHI settlement (LAST PET STANDING): the server's role is NOT to pick the
// winner. The contract tracks the leader/runnerUp two-slot state on every care
// and the game is over the instant runnerUpCareAt + lifeTtl passes; finalize()
// is permissionless, re-verifies that on-chain, and pays the whole pot to the
// leader's TBA. The server is merely a FINALIZE POKE: on an interval it reads
// isOver() and, when true, submits finalize() so the payout lands promptly.
// The contract is the judge; the poke can never steer, rush, or bias the
// outcome (a losing race just reverts GameNotOver/GameOver, which is benign).
// Inert until survivalLive; gated by SETTLEMENT_FINALIZE_POKE.
//
// SEASON 2, NO CLAIMS: two changes.
//   - A poke is followed IMMEDIATELY by the settlement tail (retry an escrowed
//     prize, sweep the rewards residual to the champion) rather than waiting for
//     the next 2h push tick: the moment the game is decided is the moment the
//     winner should be paid.
//   - The fixed poll is no longer the only trigger. Every poke re-arms a WATCHER
//     aimed at the published deadline (see below), so the finalize lands within
//     seconds of isOver() flipping instead of up to SETTLEMENT_POLL_MINUTES later.
//     The interval stays as the safety net for a read that failed while arming.

export async function runFinalizePoke(ctx: AppContext): Promise<void> {
  if (!config.modes.survivalLive || !config.SETTLEMENT_FINALIZE_POKE) return;

  let over = false;
  try {
    // isOver() is already false once the pot is claimed, so this single read
    // covers both "not decidable yet" and "already finalized".
    over = await ctx.relayer.isOver();
  } catch (err) {
    logger.warn({ err: String(err) }, "isOver read failed; skipping finalize poke");
    return;
  }

  if (over) {
    try {
      const res = await ctx.relayer.finalizeSeason();
      logger.info({ txHash: res.txHash }, "finalize poke landed: the pot is paid to the last pet standing");
    } catch (err) {
      // Benign races: someone else finalized first (GameOver), or a care landed
      // between the read and the write (GameNotOver). The next tick re-checks.
      logger.warn({ err: String(err) }, "finalize poke reverted (re-checked next tick)");
    }
  }

  // The tail runs on EVERY tick, not only the one that finalized. It is a no-op
  // on an unsettled season (one settlementState read), and running it on the
  // faster settlement cadence rather than only inside the 2h push cycle is what
  // makes an escrowed prize a minutes-long delay instead of a hours-long one.
  // It also covers the season someone ELSE finalized, which our poke never sees
  // as a success. It owns its own error handling.
  await runSettlementTail(ctx);

  // Re-aim the deadline watcher from whatever the state is NOW. Every poke ends
  // here, so the watcher stays armed for the current deadline without needing an
  // engine of its own.
  await armFinalizeWatcher(ctx);
}

// ---------------------------------------------------------------------------
// The deadline watcher: finalize the MOMENT isOver() flips
// ---------------------------------------------------------------------------
//
// There is no event to listen for. isOver() does not flip because something
// happened; it flips because a DEADLINE PASSED (runnerUpCareAt + lifeTtl, which
// the vault publishes as settlementState().winsAt). Nothing is emitted at that
// instant, so a log subscription would sit silent through the exact moment it
// exists to catch. The event-driven equivalent is therefore to ARM A TIMER for
// the published deadline and let the fixed poll stay as the safety net.
//
// WHY AN ARMED TIMER IS SAFE HERE, and this is the load-bearing property:
// winsAt is MONOTONICALLY NON-DECREASING. It is derived from the runner-up's care
// stamp, care stamps only ever move forward, and a new carer can only become the
// runner-up with a LATER stamp. So a care can push the deadline out, never pull it
// in, which means an armed timer can only ever fire EARLY. And firing early is
// free: the timer does not send a transaction, it calls runFinalizePoke, which
// re-reads isOver() first and re-arms from the fresh deadline. A premature fire
// costs one view call, not gas on a GameNotOver revert.
const WATCHER_FIRE_BUFFER_MS = 2_000; // land just past the deadline, not on it
const WATCHER_MAX_DELAY_MS = 6 * 3_600_000; // re-read at least this often

let watcherTimer: ReturnType<typeof setTimeout> | null = null;
let watcherArmedForSec = 0;

/**
 * Point the watcher at the current deadline. Safe to call repeatedly: it replaces
 * any existing timer, and it arms nothing when there is nothing to wait for (a
 * settled season, an undecidable one, or a deadline already in the past, which the
 * ordinary poll interval picks up on its next tick).
 */
export async function armFinalizeWatcher(ctx: AppContext): Promise<number | null> {
  if (!config.modes.survivalLive || !config.SETTLEMENT_FINALIZE_POKE) return null;

  let winsAt = 0;
  let finalized = false;
  try {
    const state = await ctx.relayer.settlementState();
    winsAt = state.winsAt;
    finalized = state.finalized;
  } catch (err) {
    logger.warn({ err: String(err) }, "finalize watcher: settlementState read failed (poll interval still covers it)");
    return null;
  }

  if (finalized) {
    disarmFinalizeWatcher();
    return null;
  }
  // winsAt is 0 while the season is not DECIDABLE at all (no leader, or fewer
  // than minPlayers have hatched). There is no deadline to wait for yet.
  if (winsAt <= 0) {
    disarmFinalizeWatcher();
    return null;
  }
  const deltaMs = winsAt * 1000 - Date.now();
  // Already past: the poke that just ran either finalized it or found it not
  // decidable for another reason. Arming a sub-second timer here would spin
  // against whatever is refusing; the interval is the right cadence for that.
  if (deltaMs <= 0) {
    disarmFinalizeWatcher();
    return null;
  }

  const delayMs = Math.min(deltaMs + WATCHER_FIRE_BUFFER_MS, WATCHER_MAX_DELAY_MS);
  if (watcherTimer) clearTimeout(watcherTimer);
  watcherArmedForSec = winsAt;
  watcherTimer = setTimeout(() => {
    watcherTimer = null;
    void runFinalizePoke(ctx).catch((err) =>
      logger.error({ err: String(err) }, "finalize watcher poke failed"),
    );
  }, delayMs);
  watcherTimer.unref?.();
  logger.info(
    { winsAt, inSeconds: Math.round(delayMs / 1000) },
    "finalize watcher armed for the season deadline",
  );
  return winsAt;
}

export function disarmFinalizeWatcher(): void {
  if (watcherTimer) clearTimeout(watcherTimer);
  watcherTimer = null;
  watcherArmedForSec = 0;
}

/** The deadline the watcher is currently waiting on, or 0 when it is not armed. */
export function finalizeWatcherArmedFor(): number {
  return watcherArmedForSec;
}
