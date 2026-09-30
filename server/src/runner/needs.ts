import { config } from "../config.js";
import type { AppContext } from "../context.js";
import type { Runner } from "../store/types.js";
import { isQuietHour } from "./quiet.js";
import type { PetMood } from "./pet.js";

// WALLETCHI: virtual-pet needs (hunger/thirst/joy 0-100) that decay on the tick
// engine, drive the pet's mood, and ping the lock screen. Needs decay only after
// the egg hatches; survival death (GONE) is vault-driven and lands later.

export type Mood = PetMood;

type RunnerPatch = Parameters<AppContext["store"]["updateRunner"]>[1];

// Compute the pet's mood. Egg/gone/sleeping take precedence over needs; all needs
// low reads as sick. FIVE NEEDS: joy is the WEAKEST of play/toy/explore (see
// chainNeedsToMeters), so a toy or explore deficit lands in the existing "sad"
// bucket: no new moods, and the soonest-lapsing need still drives STATUS.
export function moodFor(runner: Runner, now: Date): Mood {
  if (runner.gone) return "gone";
  if (!runner.hatched) return "egg";
  // Near-death overrides sleep: a fading pet does not peacefully nap.
  if (runner.critical) return "critical";
  if (isQuietHour(now)) return "sleeping";
  const low = config.NEED_LOW_THRESHOLD;
  const { hunger, thirst, joy } = runner;
  const lowCount = [hunger, thirst, joy].filter((v) => v <= low).length;
  if (lowCount >= 3) return "sick";
  const min = Math.min(hunger, thirst, joy);
  if (min <= low) {
    if (hunger === min) return "hungry";
    if (thirst === min) return "thirsty";
    return "sad";
  }
  return "happy";
}

// A default narration line for a mood (STATUS fallback when there is no fresher event).
// `platform` only changes WHERE the line points a keeper: the care buttons sit on
// the BACK of an Apple pass (reached by the ••• button, top right, since iOS 15)
// and directly on the card on Android. A new egg is the one moment that
// instruction is load-bearing, because nothing hatches until the keeper finds it.
export function moodLine(mood: Mood, platform: "apple" | "google" = "apple"): string {
  switch (mood) {
    case "egg":
      return platform === "google"
        ? "A new egg. Tap Feed below to hatch it."
        : "A new egg. Tap ••• then Feed to hatch it.";
    // Written in the pet's own register: a small creature with opinions, whose
    // stakes are real. Understated on purpose, because these pets do not
    // respawn and copy that shouts about it undersells it.
    case "happy":
      return "Fed, watered and thoroughly pleased with you.";
    case "hungry":
      return "Hungry. It has opinions about this.";
    case "thirsty":
      return "Thirsty. Looking at the bowl, then at you.";
    case "sad":
      return "Bored out of its mind. It has been watching the door.";
    case "sleeping":
      return "Fast asleep. Dreaming of snacks, probably.";
    case "sick":
      return "Not doing well. Something has been neglected too long.";
    case "critical":
      return "Fading. This is the part you do not get to undo.";
    case "gone":
      return "Gone. It lived exactly as long as it was cared for.";
  }
}

// Filled/empty dot meter for a 0-100 value, e.g. 62 -> "●●●○○".
export function needsMeter(value: number, dots = 5): string {
  const filled = Math.max(0, Math.min(dots, Math.round((value / 100) * dots)));
  return "●".repeat(filled) + "○".repeat(dots - filled);
}

// FIVE NEEDS ON ONE FIELD (audit #3). Apple SILENTLY DROPS storeCard fields
// past its per-row limits, so five separate need fields risk a need simply
// vanishing from the card. All five needs ride ONE compact value instead:
// per-need glyph + countdown, MOST URGENT FIRST, e.g. "🧭2h 🍯11h 💧14h 🎾19h 🧸1d"
// (a need runs on a 24h clock, so nothing here can ever read above 1d). This set
// is CANONICAL: web-cub/src/lib/needs.ts mirrors it, and the care page, the care
// confirm page and the site all render from one of the two. Index = canonical
// actionType order (0=FEED 1=WATER 2=PLAY 3=TOY 4=EXPLORE); display order is
// urgency.
export const NEED_GLYPHS = ["🍯", "💧", "🎾", "🧸", "🧭"] as const;

// Short countdown for a need: whole days above 24h, whole hours above 1h,
// minutes below that (never "0m" for a still-alive need).
export function needShortTime(secondsLeft: number): string {
  if (secondsLeft >= 86_400) return `${Math.floor(secondsLeft / 86_400)}d`;
  if (secondsLeft >= 3_600) return `${Math.floor(secondsLeft / 3_600)}h`;
  return `${Math.max(1, Math.floor(secondsLeft / 60))}m`;
}

// The combined five-need value for a wallet card front: countdown form when the
// chain deadlines are available ("🍯2h"), percent form otherwise ("🍯82%", the
// DB meter fallback). Always all five, always most urgent first (ties keep
// canonical order: Array.prototype.sort is stable).
export function needsInline(needPct: number[], needSecondsLeft?: number[] | null): string {
  const timed = needSecondsLeft && needSecondsLeft.length === 5 ? needSecondsLeft : null;
  return [0, 1, 2, 3, 4]
    .map((i) => ({
      glyph: NEED_GLYPHS[i]!,
      pct: needPct[i] ?? 0,
      secs: timed ? timed[i]! : null,
    }))
    .sort((a, b) => (a.secs !== null && b.secs !== null ? a.secs - b.secs : a.pct - b.pct))
    .map((e) => `${e.glyph}${e.secs !== null ? needShortTime(e.secs) : `${e.pct}%`}`)
    .join(" ");
}

// THE DEATH COUNTDOWN. Under five needs a pet dies the moment the SOONEST of
// its five timers lapses, so the whole life clock is simply the minimum of the
// five. Returns null when the caller has no chain-derived countdowns (percents
// cannot be turned into honest time) or when the soonest need has already run
// out: a card must never promise a future the chain has taken away.
export function minNeedSecondsLeft(needSecondsLeft?: number[] | null): number | null {
  if (!needSecondsLeft || needSecondsLeft.length !== 5) return null;
  const min = Math.min(...needSecondsLeft);
  return Number.isFinite(min) && min > 0 ? min : null;
}

// Hour-granular life countdown for surfaces that cannot self-update. Apple
// renders a live relative date on the device; Google has no such field, so a
// minute-precise value there would go stale between patches and read as a lie.
// Rounds DOWN throughout: a card may never flatter the time a keeper has left.
export function survivesShort(secondsLeft: number): string {
  if (secondsLeft < 3_600) return "under 1h";
  if (secondsLeft < 172_800) return `~${Math.floor(secondsLeft / 3_600)}h`;
  return `~${Math.floor(secondsLeft / 86_400)}d`;
}

// The urgency ordering of the five canonical need indexes (most urgent first),
// for surfaces that render one line per need (the Google NEEDS text module).
export function needsUrgencyOrder(needPct: number[], needSecondsLeft?: number[] | null): number[] {
  const timed = needSecondsLeft && needSecondsLeft.length === 5 ? needSecondsLeft : null;
  return [0, 1, 2, 3, 4].sort((a, b) =>
    timed ? timed[a]! - timed[b]! : (needPct[a] ?? 0) - (needPct[b] ?? 0),
  );
}

// FIVE-NEEDS chain-derived meters (redesign 8.3). During a live season the DB
// meters become a projection of the vault's five need stamps: per-need percent
// = time left on that need over the full life window, clamped 0..100. The
// legacy three columns survive as views over them (hunger = FEED, thirst =
// WATER, joy = the WEAKEST of PLAY/TOY/EXPLORE), so the card can never
// contradict the chain. `perNeed` is the full five-slot percent array in
// canonical actionType order (0=FEED 1=WATER 2=PLAY 3=TOY 4=EXPLORE).
export function chainNeedsToMeters(
  needAt: readonly number[],
  lifeTtlSeconds: number,
  nowSec: number,
): { hunger: number; thirst: number; joy: number; perNeed: number[] } {
  const ttl = Math.max(1, lifeTtlSeconds);
  const perNeed = [0, 1, 2, 3, 4].map((i) => {
    const left = Math.max(0, (needAt[i] ?? 0) + ttl - nowSec);
    return Math.max(0, Math.min(100, Math.round((100 * left) / ttl)));
  });
  return {
    hunger: perNeed[0]!,
    thirst: perNeed[1]!,
    joy: Math.min(perNeed[2]!, perNeed[3]!, perNeed[4]!),
    perNeed,
  };
}

// DB fallback projection of the five per-need percents when the chain stamps
// are unavailable (pre-season demo, RPC blip): FEED from hunger, WATER from
// thirst, PLAY/TOY/EXPLORE share the joy meter (joy is their min, so this is
// the honest pessimistic stand-in).
export function dbNeedPct(runner: Pick<Runner, "hunger" | "thirst" | "joy">): number[] {
  return [runner.hunger, runner.thirst, runner.joy, runner.joy, runner.joy];
}

// Awake hours between two instants, excluding quiet-hour spans, sampled per hour.
function awakeHoursBetween(start: Date, end: Date): number {
  const stepMs = 3600_000;
  let awake = 0;
  let t = start.getTime();
  const endMs = end.getTime();
  let guard = 0;
  while (t < endMs && guard++ < 24 * 14) {
    const slice = Math.min(stepMs, endMs - t);
    if (!isQuietHour(new Date(t + slice / 2))) awake += slice / stepMs;
    t += slice;
  }
  return awake;
}

export interface NeedsResult {
  runner: Runner;
  pushLine: string | null; // a ping to push (a need crossed low)
}

// Decay needs by elapsed AWAKE time and fire at most one ping. Persists. Runs for
// hatched, living pets only (an egg does not get hungry).
export async function decayNeeds(
  ctx: AppContext,
  runner: Runner,
  now: Date,
): Promise<NeedsResult> {
  if (!runner.hatched || runner.gone) return { runner, pushLine: null };
  // Live season, hatched on-chain pet: the vault's five need stamps are the
  // ONLY authority over the meters (reconcileOnChainCare projects them into
  // hunger/thirst/joy via chainNeedsToMeters). Cosmetic decay on top would let
  // the card contradict the chain. Pre-season / demo pets keep the decay.
  if (config.modes.survivalLive && runner.hatched && runner.tokenId) {
    return { runner, pushLine: null };
  }
  if (!runner.lastNeedsAt) {
    const updated = await ctx.store.updateRunner(runner.serial, { lastNeedsAt: now });
    return { runner: updated, pushLine: null };
  }
  const dec = Math.floor(awakeHoursBetween(runner.lastNeedsAt, now) * config.NEED_DECAY_PER_HOUR);
  if (dec <= 0) return { runner, pushLine: null }; // accumulate; do not advance the clock

  const low = config.NEED_LOW_THRESHOLD;
  const nh = Math.max(0, runner.hunger - dec);
  const nt = Math.max(0, runner.thirst - dec);
  const nj = Math.max(0, runner.joy - dec);
  const patch: RunnerPatch = { hunger: nh, thirst: nt, joy: nj, lastNeedsAt: now };

  // At most one ping. Priority: hunger > thirst > joy, on the crossing below low.
  let pushLine: string | null = null;
  const crossed = (before: number, after: number) => before > low && after <= low;
  if (crossed(runner.hunger, nh)) pushLine = "Pet's tummy is rumbling.";
  else if (crossed(runner.thirst, nt)) pushLine = "Pet is thirsty.";
  else if (crossed(runner.joy, nj)) pushLine = "Pet misses you.";
  if (pushLine) patch.lastEvent = pushLine;

  const updated = await ctx.store.updateRunner(runner.serial, patch);
  return { runner: updated, pushLine };
}
