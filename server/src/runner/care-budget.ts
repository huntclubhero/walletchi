// SMART CARE: spend a pet's daily care limit only where it keeps the pet alive.
//
// Every living pet's account has a rolling 24 h spend limit baked in at mint (dailyCap = 20
// cares; it cannot be changed for pets already minted, and PR #36 only lifts it for future
// launches). The vault kills a pet when its STALEST need lapses (min(needAt) + lifeTtl), so a
// care on a need that was just served adds no life at all. With five needs and lifeTtl = 24 h a
// pet needs only five cares a day, yet holders who ran the five-tap ritual four times a day hit
// the limit and were then told "That is enough for today" while a need lapsed: pet No. 0038 died
// that way on 2026-10-16 (and No. 0119 hit the limit the same day).
//
// So before a pass tap spends, the server decides (pure function, tested in
// scripts/care-budget-check.ts):
//   fresh    half the limit is used and the tapped need was served under FRESH_SECONDS ago: do
//            not spend; point the keeper at the need that is running out instead.
//   reserve  the limit is getting low and this need can wait: either spending would leave fewer
//            cares than the needs that must be served before the window reopens, or only
//            RESERVE_CARES are left and this need still has more than half its life. Do not spend;
//            tell the keeper the pet is well cared for and point at the stalest need.
//   ok       spend.
// Every read is best effort: missing data (an unreadable limit included) never blocks a care.

export const FRESH_SECONDS = 60 * 60;
// Cares always held back for when needs are actually due: one per need.
export const RESERVE_CARES = 5;
// The "just served" rule only kicks in once half the limit is used.
export const FRESH_GUARD_CARES = 10;

export interface SpendState {
  dailyCap: bigint; // raw token units per window
  windowStart: number; // unix seconds
  spentInWindow: bigint; // raw token units
}

export interface BudgetInput {
  actionType: number; // 0..4, index into needAt
  needAt: number[]; // five need stamps, unix seconds (0 = never served)
  lifeTtl: number; // seconds
  now: number; // unix seconds
  careCost: bigint; // raw token units per care
  spend: SpendState | null; // null = unreadable (skip the reserve rule)
  window?: number; // spend window seconds (WalletchiAccount.SPEND_WINDOW = 1 day)
}

export type BudgetVerdict =
  | { kind: "ok" }
  | { kind: "fresh" | "reserve"; stalest: number; secondsLeft: number };

/** Index of the stalest need (the one the pet's life hangs on). */
export function stalestNeed(needAt: number[]): number {
  let best = 0;
  for (let i = 1; i < needAt.length; i++) if (needAt[i]! < needAt[best]!) best = i;
  return best;
}

/** Cares left in the current spend window (Infinity when unreadable). */
export function caresLeft(spend: SpendState | null, careCost: bigint, now: number, window = 86_400): number {
  if (!spend || careCost <= 0n) return Infinity;
  if (now >= spend.windowStart + window) return Number(spend.dailyCap / careCost); // the window rolls on the next spend
  const left = spend.dailyCap - spend.spentInWindow;
  return left <= 0n ? 0 : Number(left / careCost);
}

/** When the spend window reopens (unix seconds). */
export function windowReopensAt(spend: SpendState, now: number, window = 86_400): number {
  return now >= spend.windowStart + window ? now : spend.windowStart + window;
}

export function careBudgetVerdict(b: BudgetInput): BudgetVerdict {
  const window = b.window ?? 86_400;
  const { needAt, actionType, lifeTtl, now } = b;
  if (needAt.length !== 5 || needAt.every((t) => t === 0) || actionType < 0 || actionType > 4) return { kind: "ok" };
  const stalest = stalestNeed(needAt);
  const leftOf = (i: number) => Math.max(0, needAt[i]! + lifeTtl - now);
  const tappedAt = needAt[actionType]!;
  const age = now - tappedAt;
  // Judged by how much life the need has, never by rank: in the five-tap ritual every tap is the
  // stalest need at the moment it lands (all five were served together), so "the stalest always
  // spends" would let every ritual burn the limit.
  const left = caresLeft(b.spend, b.careCost, now, window);
  // With plenty of the limit left a tap always does what the keeper asked (a brand-new pet's first
  // taps land right after mint-time arming fed everything; they must care and hatch, not be held).
  if (Number.isFinite(left) && b.spend) {
    if (left <= FRESH_GUARD_CARES && tappedAt > 0 && age < FRESH_SECONDS) {
      return { kind: "fresh", stalest, secondsLeft: leftOf(stalest) };
    }
    const reopen = windowReopensAt(b.spend, now, window);
    // needs (other than this one) that lapse before the window reopens: each needs a care now
    let mustServe = 0;
    for (let i = 0; i < 5; i++) if (i !== actionType && needAt[i]! + lifeTtl <= reopen) mustServe++;
    const thisCanWait = tappedAt + lifeTtl > reopen;
    if (thisCanWait && left - 1 < mustServe) return { kind: "reserve", stalest, secondsLeft: leftOf(stalest) };
    // keep one care per need in hand while this need still has more than half its life
    if (left <= RESERVE_CARES && age < lifeTtl / 2) return { kind: "reserve", stalest, secondsLeft: leftOf(stalest) };
  }
  return { kind: "ok" };
}

/** "2h 17m" / "45m" / "1m" */
export function shortDuration(sec: number): string {
  const s = Math.max(0, Math.round(sec));
  const h = Math.floor(s / 3600);
  const m = Math.max(1, Math.floor((s % 3600) / 60));
  return h > 0 ? `${h}h ${m}m` : `${m}m`;
}
