import type { MintBudgetState } from "../chain/types.js";

// The PetIssuer's rolling mint budget is the brake on a leaked relayer key (200 an hour on the
// showcase). A keeper who arrives in a busy hour used to get "Mint did not complete. Please try
// again." with no hint that "again" meant "in 40 minutes". These helpers turn the budget into a
// specific, honest answer, both BEFORE the mint (the checkout pre-check) and after a race lost
// between the pre-check and the transaction (the fulfillment catch).

/** Prefix that marks a failureReason as safe to show the keeper verbatim (see routes.ts). */
export const MINT_BUSY_PREFIX = "MINT_BUSY: ";

/**
 * Seconds until the budget frees up, or null when a mint would be accepted right now. Mirrors
 * PetIssuer._consumeMintBudget exactly: max 0 is uncapped, and a window that has already rolled
 * over is fresh (the next mint opens it), whatever `used` still says.
 */
export function mintBusyRetryAfterSec(b: MintBudgetState, nowSec: number): number | null {
  if (b.max <= 0 || b.windowSecs <= 0) return null;
  const rollsAt = b.windowStart + b.windowSecs;
  if (nowSec >= rollsAt) return null;
  if (b.used < b.max) return null;
  return rollsAt - nowSec;
}

// ---------------------------------------------------------------------------
// ADMISSION (launch fix 2): the pre-check must count the mints that are ADMITTED
// BUT NOT YET MINED, not only the chain's `used`.
//
// `used` (mintsThisWindow) moves when a mint MINES. Under a burst, the mints
// already admitted are queued or broadcast and invisible to it, so a wave that
// crosses the hourly line was admitted by the old pre-check (which read only
// `used`) and every keeper past the line burned their proof-of-work, took an
// inbox claim, polled for a while, and then read "Busy hour". The rehearsal
// measured it: 70 of 270 keepers failed AFTER polling, 0 refused at checkout.
//
// The count lives here, in process, and is bumped SYNCHRONOUSLY in the same
// tick as the decision: N concurrent checkouts each read the same `used` from
// the chain, but the increment between their reads and their decisions cannot
// interleave, so exactly max - used of them are admitted. Every admission is
// released exactly once, on every exit (refusal later in the handler, fulfilment
// success, fulfilment failure), or the counter would drift up and eventually
// refuse everyone; the release is idempotent so a double call is harmless.
// One Render instance serves the mint, so in-process is the whole picture.
// ---------------------------------------------------------------------------

let admitted = 0;

export interface MintAdmission {
  /** Hand the slot back. Idempotent. */
  release(): void;
}

export type AdmitVerdict =
  | { ok: true; admission: MintAdmission }
  | { ok: false; retryAfterSec: number; message: string };

/** Mints admitted and not yet settled (queued, broadcast, or awaiting a receipt). */
export function mintsAdmitted(): number {
  return admitted;
}

function take(): MintAdmission {
  admitted += 1;
  let released = false;
  return {
    release() {
      if (released) return;
      released = true;
      admitted = Math.max(0, admitted - 1);
    },
  };
}

/**
 * Decide, and reserve. A null budget (unreadable, or no issuer) admits without a
 * cap but still counts, so the count is always the truth about what is in flight.
 * Mirrors PetIssuer._consumeMintBudget for the window: a rolled-over window is
 * fresh whatever `used` still says, and the in-flight mints will open it.
 */
export function admitMint(b: MintBudgetState | null, nowSec: number): AdmitVerdict {
  if (!b || b.max <= 0 || b.windowSecs <= 0) return { ok: true, admission: take() };
  const rollsAt = b.windowStart + b.windowSecs;
  const rolled = nowSec >= rollsAt;
  const used = rolled ? 0 : b.used;
  if (used + admitted >= b.max) {
    const retryAfterSec = rolled ? b.windowSecs : rollsAt - nowSec;
    return { ok: false, retryAfterSec, message: mintBusyMessage(b, retryAfterSec) };
  }
  return { ok: true, admission: take() };
}

/** Test hook: reset the in-process count between smoke scenarios. */
export function _resetMintAdmissionForTests(): void {
  admitted = 0;
}

/** "Busy hour: the showcase mints 200 an hour, try again in 12 minutes." */
export function mintBusyMessage(budget: MintBudgetState | null, retryAfterSec: number | null): string {
  const pace = !budget || budget.max <= 0
    ? "a limited number an hour"
    : budget.windowSecs === 3600
      ? `${budget.max} an hour`
      : `${budget.max} every ${Math.max(1, Math.round(budget.windowSecs / 60))} minutes`;
  if (retryAfterSec === null) return `Busy hour: the showcase mints ${pace}, try again in a few minutes.`;
  const mins = Math.max(1, Math.ceil(retryAfterSec / 60));
  return `Busy hour: the showcase mints ${pace}, try again in ${mins} minute${mins === 1 ? "" : "s"}.`;
}
