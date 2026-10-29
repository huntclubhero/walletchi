// CARE REMINDERS (2026-10-15): at most two per life cycle, each asking for ONE tap.
//
// Why this replaced the fade pings. Pets were dying with nobody warned, and the cause was
// volume, not silence: every change to the Apple pass's STATUS line raised a banner, and a
// healthy pet's idle flavor ("napping", "stretching") changed it about seven times a day. A
// keeper who mutes a chatty pass never sees the warning that matters. Meanwhile the warning
// itself came only in the final six hours and listed needs to remember, and of the 29 dead
// pets whose keepers came back at least once, 22 died from a need they never tapped.
//
// So: a DAILY CARE check-in once the weakest need has CHECKIN_HOURS left (sent early, before
// quiet hours begin, when it would otherwise land inside them), then a LAST CHANCE at
// LAST_CHANCE_HOURS left, which ignores quiet hours because a dying pet is worth waking for.
// Both NAME every need coming due (most urgent first), because keepers fed and forgot the
// rest. Only these lines raise a banner (pass.ts gates changeMessage on isAlertLine); flavor
// and need pings update the card quietly.

import { shortDuration } from "./care-budget.js";

// WORDING (Hunt, 2026-10-18). Pets were dying after smart care began answering a repeat tap with
// "Already taken care of": keepers read that as "done for today" and the check-in ("Daily care
// time ... tap Water and Toy") did not say how long the pet had. Both lines now lead with the fact
// that a need was missed, say exactly how long until the pet dies (the same clock the card shows),
// and name the taps that fix it. When the needs read fails the line says "all five needs", which
// is always a safe instruction: smart care makes a tap on a fresh need free.
// Hunt 2026-10-19: no opener. The line says what happens and what to do; nothing else is needed.
export const CHECKIN_PREFIX = "Your Chi dies in";
export const LAST_CHANCE_PREFIX = "Last chance";
/** Check-in prefixes before 2026-10-19; cards still showing one are reminders until a care clears them. */
export const LEGACY_CHECKIN_PREFIXES = ["Daily care time", "You missed something"] as const;

/** "Water", "Toy and Explore", "Water, Toy and Explore"; "all five needs" when the read failed or all are due. */
export function needList(labels: readonly string[]): string {
  if (labels.length === 0 || labels.length >= 5) return "all five needs";
  if (labels.length === 1) return labels[0]!;
  return `${labels.slice(0, -1).join(", ")} and ${labels[labels.length - 1]!}`;
}

/** "7h 40m" / "6h" / "45m": the time until the weakest need lapses, i.e. until the pet dies. Never under 1m. */
export function timeLeft(secondsLeft: number): string {
  const s = Math.max(60, Math.round(secondsLeft));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  if (h > 0) return m > 0 ? `${h}h ${m}m` : `${h}h`;
  return `${Math.max(1, m)}m`;
}

// "your Chi", never the pet's name (Hunt 2026-10-18: a name in the banner is confusing).
export function checkInLine(secondsLeft: number, due: readonly string[]): string {
  return `${CHECKIN_PREFIX} ${timeLeft(secondsLeft)}. Tap ${needList(due)} on the back of this card to keep it alive.`;
}

export function lastChanceLine(secondsLeft: number, due: readonly string[]): string {
  return `${LAST_CHANCE_PREFIX}: your Chi dies in ${timeLeft(secondsLeft)}. Tap ${needList(due)} on the back of this card now.`;
}

// LIMIT-AWARE (2026-10-17): a pet's account allows a fixed number of cares per rolling 24 h. When a
// reminder goes out while that window has no cares left, a tap would be refused, so the line keeps
// its prefix (isAlertLine, and with it the banner rule, reads the start) and gains one plain clause
// saying when care opens again. Nothing else about the reminder changes.
export function careReopensClause(secondsUntil: number): string {
  return `Care opens again in ${shortDuration(secondsUntil)}.`;
}

export function withCareReopen(line: string, secondsUntil: number): string {
  return `${line} ${careReopensClause(secondsUntil)}`;
}

/** Labels of the needs with at most `windowSec` left, most urgent first (ties in canonical order). */
export function dueNeeds(labels: readonly string[], secondsLeftPerNeed: readonly number[], windowSec: number): string[] {
  return secondsLeftPerNeed
    .map((left, i) => ({ left, i }))
    .filter((n) => n.left <= windowSec)
    .sort((a, b) => a.left - b.left || a.i - b.i)
    .map((n) => labels[n.i]!);
}

/** True for the two reminder lines: the only status lines allowed to raise a banner. */
export function isAlertLine(line: string | null | undefined): boolean {
  return !!line && (line.startsWith(CHECKIN_PREFIX) || line.startsWith(LAST_CHANCE_PREFIX) || LEGACY_CHECKIN_PREFIXES.some((p) => line.startsWith(p)));
}

export type ReminderKind = "checkin" | "last-chance";

export interface ReminderInput {
  secondsLeft: number; // until the weakest need lapses (the pet's death)
  lastEvent: string | null | undefined; // what the card says now
  quietNow: boolean;
  quietSoon: boolean; // quiet hours begin before the next tick
  quietSpanSec: number; // length of the quiet window
  checkInSec: number;
  lastChanceSec: number;
}

/** Which reminder to send on this tick, if any. Pure; idle.ts does the I/O. */
export function reminderDue(i: ReminderInput): ReminderKind | null {
  if (i.secondsLeft <= 0) return null;
  if (i.secondsLeft <= i.lastChanceSec) {
    // Once per cycle: a care clears the line, so the next cycle can warn again.
    return i.lastEvent?.startsWith(LAST_CHANCE_PREFIX) ? null : "last-chance";
  }
  // Early when the check-in moment would fall inside the coming quiet window: better at 10:45pm
  // than at 3am or not until 8am with hours already gone.
  const due = i.secondsLeft <= i.checkInSec || (i.quietSoon && i.secondsLeft <= i.checkInSec + i.quietSpanSec);
  if (!due || i.quietNow) return null;
  if (isAlertLine(i.lastEvent)) return null; // already told this cycle
  return "checkin";
}
