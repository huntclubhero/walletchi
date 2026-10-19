import { config } from "../config.js";
import { logger } from "../logger.js";
import type { AppContext } from "../context.js";
import type { Runner } from "../store/types.js";
import { minNeedSecondsLeft } from "./needs.js";
import { lifeDeadlineValue, type RunnerPassOptions } from "./pass.js";
import { petCareBalanceFor, petNeedPctFor, petNeedSecondsLeftRead, survivorLine } from "./season.js";
import { setupNudgeFor } from "./setup-nudge.js";
import { activeAnnouncement } from "./announce.js";
import { memorialLineEnabledFor } from "./memorial-line.js";

// STABLE PASS FIELDS (2026-10-17).
//
// iOS compares a downloaded pass with the copy ON THE PHONE. A changed value without a
// changeMessage has been silent for months, but a field ADDED without one raised the generic
// "Pass changed" banner. Three living-pet fields used to be conditional on a chain read: ALIVE
// (only while the on-chain headcount is verified and fresh), CARE (omitted when the balance read
// fails) and SURVIVES (omitted when the countdown read fails). Around a restart, or an RPC blip,
// they dropped off a served pass and came back on the next one, which the phone saw as ADDED.
//
// So each of them now serves its LAST KNOWN value when the fresh read fails or is not ready yet.
// House law holds: counts are on-chain verified or hidden, never a placeholder. Only a value that
// came from a successful on-chain read is ever remembered, so a remembered value WAS verified.
// A field that has never had a verified value for that pet stays absent (a one-time add at its
// first verification). An honest "no value" (season not live, memorial, champion, dormant egg, no
// account yet) never falls back: those stay exactly as before.
//
// The values persist in PassFieldMemory so they survive a restart. That table is not the Runner
// row on purpose: writing it must never move Runner.updatedAt, which is the pass's Last-Modified.

const KEY_ALIVE = "alive";
const keyCare = (serial: string) => `carebal:${serial}`;
const keyLife = (serial: string) => `life:${serial}`;

// Write-through cache: what the store holds for a key (or that it holds nothing). Bounded.
const known = new Map<string, string | null>();
const MAX_KEYS = 20_000;

function cacheSet(key: string, value: string | null): void {
  known.set(key, value);
  if (known.size > MAX_KEYS) known.clear();
}

async function recall(ctx: AppContext, key: string): Promise<string | null> {
  if (known.has(key)) return known.get(key) ?? null;
  try {
    const v = await ctx.store.getPassFieldMemory(key);
    cacheSet(key, v);
    return v;
  } catch (err) {
    logger.warn({ err: String(err), key }, "pass field memory read failed");
    return null;
  }
}

async function remember(ctx: AppContext, key: string, value: string): Promise<void> {
  if (known.get(key) === value) return; // unchanged: no write
  cacheSet(key, value);
  try {
    await ctx.store.putPassFieldMemory(key, value);
  } catch (err) {
    known.delete(key); // retry on the next pass build
    logger.warn({ err: String(err), key }, "pass field memory write failed");
  }
}

/**
 * Load the global ALIVE line into memory. Called once at boot so the very first pass after a
 * restart already has it; recall() would also fetch it lazily.
 */
export async function warmPassFieldMemory(ctx: AppContext): Promise<void> {
  await recall(ctx, KEY_ALIVE);
}

/**
 * Everything a LIVE Apple pass build needs from the chain, with the stable-field fallbacks applied.
 * Spread straight into generateRunnerPkpass options. Used by the Wallet web service and the
 * download route, so every Apple pass of a living pet has the same field set.
 */
export async function stablePassInputs(ctx: AppContext, runner: Runner, now = new Date()): Promise<RunnerPassOptions> {
  const living = !runner.gone && !runner.won;
  const needPct = await petNeedPctFor(ctx, runner);
  const lifeRead = await petNeedSecondsLeftRead(ctx, runner);
  const needSecondsLeft = lifeRead.ok ? lifeRead.value : null;
  let careBalance = await petCareBalanceFor(ctx, runner);
  const setupNudge = await setupNudgeFor(ctx, runner);

  // ALIVE: one global line. Fresh when verified; else the last line that WAS verified, but only
  // while the season is live (a season that is switched off shows no headcount, as before).
  let aliveLine = survivorLine();
  if (living && config.modes.survivalLive) {
    if (aliveLine) await remember(ctx, KEY_ALIVE, aliveLine);
    else aliveLine = await recall(ctx, KEY_ALIVE);
  }

  // CARE: petCareBalanceFor only returns null for a living pet with an account when the read
  // failed and this process has no cached value (a restart). Then the stored value stands in.
  if (living && runner.tbaAddress) {
    if (careBalance) await remember(ctx, keyCare(runner.serial), careBalance);
    else careBalance = await recall(ctx, keyCare(runner.serial));
  }

  // SURVIVES: remember the deadline a fresh read produced; fall back ONLY on a failed read.
  let lifeFallback: string | null = null;
  if (living) {
    if (lifeRead.ok) {
      const secs = minNeedSecondsLeft(lifeRead.value);
      if (secs) await remember(ctx, keyLife(runner.serial), lifeDeadlineValue(now.getTime(), secs));
    } else {
      lifeFallback = await recall(ctx, keyLife(runner.serial));
    }
  }

  // The active one-time announcement (runner/announce.ts): the event line banners only while it shows
  // it. A memorial has that line only under the flag (runner/memorial-line.ts).
  const announcement = living || memorialLineEnabledFor(runner) ? await activeAnnouncement(ctx) : null;

  return { needPct, needSecondsLeft, careBalance, setupNudge, aliveLine, lifeFallback, announcement };
}

/** Test hook: forget the in-process cache (the in-memory half of a simulated restart). */
export function _resetPassFieldMemoryCache(): void {
  known.clear();
}
