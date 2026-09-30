import { config } from "../config.js";
import { logger } from "../logger.js";
import type { AppContext } from "../context.js";
import { isQuietHour } from "./quiet.js";
import { pushRunnerPass, persistMemorial } from "./idle.js";
import { runFinalizePoke, disarmFinalizeWatcher } from "./settlement.js";
import { setSnapshotAlive } from "./season.js";

// The WALLETCHI drama layer (LAST PET STANDING): ONE global poller. Deaths are
// NOT events anymore: a pet is dead the instant lastCareAt + lifeTtl passes, so
// each poll SWEEPS THE TIMERS of the server's known pets and treats any pet
// that crossed its deadline since the last poll as a NEW death (death-feed ping
// + memorial). The poller still listens to the chain for the Victory event (the
// champion celebration). The "N remain" survivor count is computed OFF-CHAIN
// from the same timer sweep (display-only; the contract needs no headcount).
// Fan-out is strictly bounded: coalesced deaths, latched milestones, quiet-
// hours-gated, a hard per-cycle cap, and a per-owner throttle
// (lastWanderPingAt), so it is a trickle, never a synchronous 2000 broadcast.
// Inert until survivalLive.

const MILESTONES = [1000, 500, 100, 10, 2, 1];

/**
 * Which milestones a colony has genuinely crossed. Exported so the rule stays
 * testable: a threshold only counts once the colony has actually been ABOVE it,
 * otherwise a five-pet test season with four alive announces "10 remain", a
 * number describing a colony that never existed.
 */
export function milestonesCrossed(alive: number, everHatched: number): number[] {
  return MILESTONES.filter((m) => alive <= m && everHatched > m);
}

let lastBlock = 0;
let pendingDeaths = 0;
const latched = new Set<number>();

function milestoneLine(m: number): string {
  // Understated on purpose. The fact is already the drama: these pets do not
  // respawn. A line that shouts undersells it.
  if (m === 1) return "One left. It outlived every other pet in the colony.";
  if (m === 2) return "Two left. Whoever looks away first loses.";
  if (m === 10) return "Ten left. Small enough to count on your hands.";
  return `${m.toLocaleString("en-US")} still breathing. The rest are memorials.`;
}

// A bounded fan-out of one drama line: least-recently-pinged owners first, capped per
// cycle, one ping per owner per DEATHFEED_MIN_HOURS. Spreads across cycles by design.
async function broadcastDrama(ctx: AppContext, line: string, now: Date, excludeSerial?: string): Promise<void> {
  const cutoff = new Date(now.getTime() - config.DEATHFEED_MIN_HOURS * 3600_000);
  const batch = await ctx.store.deathFeedBatch(config.DRAMA_MAX_PUSHES_PER_CYCLE, cutoff);
  for (const r of batch) {
    if (r.serial === excludeSerial) continue;
    await ctx.store.updateRunner(r.serial, { lastEvent: line, lastWanderPingAt: now });
    await pushRunnerPass(ctx, r.serial, { message: { header: "The Arena", body: line } });
  }
}

async function celebrateVictory(ctx: AppContext, tokenId: string, prize: bigint, now: Date): Promise<void> {
  const winner = await ctx.store.getRunnerByTokenId(tokenId);
  let excl: string | undefined;
  if (winner && !winner.won) {
    await ctx.store.updateRunner(winner.serial, {
      won: true,
      wonPrize: prize.toString(), // the real prize paid, for the victory card
      lastEvent: "WINNER. Your pet outlasted them all and claimed the Pot.",
    });
    await pushRunnerPass(ctx, winner.serial, {
      message: { header: "Victory", body: "Your pet outlasted them all and claimed the Pot." },
    });
    excl = winner.serial;
  }
  if (!isQuietHour(now)) {
    await broadcastDrama(ctx, "The season is over. A champion has been crowned.", now, excl);
  }
}

// The timer sweep: derive deaths + the alive tally from the clock. For every
// known minted pet not already memorialized, one petState read decides alive vs
// dead (the read embodies the contract's single death definition). A pet that
// reads dead but is not yet `gone` in the store is a NEW death: memorialize it
// (idempotent; the gone flag guards) and count it into the coalesced ping.
// Already-gone pets cost no read (death is permanent), so the sweep shrinks as
// the season burns down. Bounded by the 2,000 supply cap, same order of RPC
// work as the retired auto-defender scan.
async function sweepTimers(
  ctx: AppContext,
  now: Date,
): Promise<{ alive: number; newDeaths: number; hatched: number }> {
  const minted = await ctx.store.allMintedRunners();
  let alive = 0;
  let newDeaths = 0;
  // Every pet that ever entered the race, living or memorial. A milestone is
  // meaningless above this number: a colony cannot fall past a threshold it was
  // never above.
  let hatched = 0;
  for (const r of minted) {
    if (!r.tokenId) continue;
    if (r.gone) {
      hatched += 1; // a memorial still counts as a pet that once raced
      continue; // permanent: already counted out
    }
    hatched += 1;
    try {
      const state = await ctx.relayer.petState(r.tokenId);
      if (state.registered && state.dead) {
        newDeaths += 1;
        await persistMemorial(ctx, r, r.tokenId);
      } else {
        alive += 1;
      }
    } catch (err) {
      // Read failure: keep the store's view (not gone == alive) so a flaky RPC
      // never warps the count or fakes a death.
      logger.warn({ err: String(err), serial: r.serial }, "timer sweep petState read failed");
      alive += 1;
    }
  }
  void now;
  return { alive, newDeaths, hatched };
}

export async function runDramaPoll(ctx: AppContext, now: Date = new Date()): Promise<void> {
  if (!config.modes.survivalLive) return;

  // 1. Chain events: only the Victory matters now (LeaderChanged is decoded for
  // completeness but drives no ping). The cursor advances ONLY after the batch
  // is fully processed: a mid-batch throw leaves it in place so the range is
  // re-read next poll. Re-processing is idempotent (the won flag gates the
  // victory flip; milestones latch; death pings carry counts, not identities).
  let res: Awaited<ReturnType<AppContext["relayer"]["vaultEventsSince"]>>;
  try {
    res = await ctx.relayer.vaultEventsSince(lastBlock);
  } catch (err) {
    logger.warn({ err: String(err) }, "vaultEventsSince failed");
    return;
  }
  let victoryTokenId: string | null = null;
  let victoryPrize = 0n;
  for (const ev of res.events) {
    if (ev.kind === "victory") {
      victoryTokenId = ev.tokenId;
      victoryPrize = ev.prize;
    }
  }

  // 2. The timer sweep: derive new deaths + the off-chain alive tally.
  const swept = await sweepTimers(ctx, now);
  pendingDeaths += swept.newDeaths;
  setSnapshotAlive(swept.alive);

  // Victory supersedes the death-feed for this cycle.
  if (victoryTokenId) {
    await celebrateVictory(ctx, victoryTokenId, victoryPrize, now);
    lastBlock = res.toBlock;
    return;
  }

  // Pings defer out of quiet hours (pending deaths + milestone thresholds
  // persist in module state and re-detect on the next non-quiet poll).
  if (isQuietHour(now)) {
    lastBlock = res.toBlock;
    return;
  }

  const alive = swept.alive;
  // A milestone only means something if the colony was EVER bigger than it. The
  // old test was `alive <= m` alone, so a five-pet test season with four alive
  // announced "Only 10 pets remain alive": a threshold it had never been above,
  // describing a colony that never existed. Gate on the population that has
  // actually hatched, so early seasons stay quiet until there is real attrition
  // to narrate.
  const everHatched = Math.max(alive, swept.hatched);
  const passed = milestonesCrossed(alive, everHatched);
  const newlyPassed = passed.filter((m) => !latched.has(m));
  passed.forEach((m) => latched.add(m)); // latch all passed: no retroactive big-number pings
  const milestone = newlyPassed.length ? Math.min(...newlyPassed) : null;

  if (milestone !== null || pendingDeaths > 0) {
    const line = milestone !== null
      ? milestoneLine(milestone)
      : `A pet just went dark. ${alive.toLocaleString("en-US")} still breathing.`;
    await broadcastDrama(ctx, line, now);
    pendingDeaths = 0;
  }
  lastBlock = res.toBlock;
}

// The season engine: one drama-poll interval (timer sweep + victory) + one
// settlement interval (the finalize poke). Prod bootstrap starts it; both are
// no-ops until survivalLive. Each tick holds an in-flight latch: a slow sweep
// (O(known pets) RPC reads) must never stack a concurrent copy of itself when
// the interval fires again.
let dramaTickInFlight = false;
let settlementTickInFlight = false;

export function startSeasonEngine(ctx: AppContext): { stop: () => void } {
  if (!config.modes.survivalLive) {
    logger.info("season engine OFF (survival not live)");
    return { stop: () => {} };
  }
  const t1 = setInterval(() => {
    if (dramaTickInFlight) {
      logger.warn("drama tick still running; skipping this interval");
      return;
    }
    dramaTickInFlight = true;
    void runDramaPoll(ctx)
      .catch((e) => logger.error({ err: String(e) }, "drama poll failed"))
      .finally(() => {
        dramaTickInFlight = false;
      });
  }, config.DRAMA_POLL_MINUTES * 60_000);
  const t2 = setInterval(() => {
    if (settlementTickInFlight) {
      logger.warn("settlement tick still running; skipping this interval");
      return;
    }
    settlementTickInFlight = true;
    void runFinalizePoke(ctx)
      .catch((e) => logger.error({ err: String(e) }, "settlement tick failed"))
      .finally(() => {
        settlementTickInFlight = false;
      });
  }, config.SETTLEMENT_POLL_MINUTES * 60_000);
  t1.unref?.();
  t2.unref?.();
  // One poke AT BOOT rather than waiting a full interval. This both arms the
  // deadline watcher immediately and covers the case a redeploy is what made us
  // miss the deadline in the first place: a restart is exactly when the season
  // can already be over and nobody has poked it.
  void runFinalizePoke(ctx).catch((e) => logger.error({ err: String(e) }, "boot finalize poke failed"));
  logger.info(
    { dramaMin: config.DRAMA_POLL_MINUTES, settleMin: config.SETTLEMENT_POLL_MINUTES },
    "season engine started (timer-sweep drama poller + deadline-armed finalize poke)",
  );
  return {
    stop: () => {
      clearInterval(t1);
      clearInterval(t2);
      disarmFinalizeWatcher();
    },
  };
}

// Test hook: reset module latches so the smoke can drive independent scenarios.
export function _resetDramaState(): void {
  lastBlock = 0;
  pendingDeaths = 0;
  latched.clear();
}
