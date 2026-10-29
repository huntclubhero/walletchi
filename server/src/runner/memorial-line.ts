import { config } from "../config.js";
import type { Runner } from "../store/types.js";

// THE MEMORIAL EVENT LINE (2026-10-18).
//
// A living card has an event line (pass.ts, the `status` field built from runner.lastEvent) and a
// one-time announcement (announce.ts) is a VALUE change of that line, which is the only way we
// know to raise exactly one lock-screen message. A memorial card had no such line, so the keepers
// of dead pets (who still play CHI SHOT and CHI NIGHT from their tombstone) could not be told
// anything. This puts a quiet line on memorial cards: it reads the pet's last event (death writes
// MEMORIAL_COPY.memorialLine, idle.ts persistMemorial) or MEMORIAL_IDLE_LINE
// when there is none, and carries a changeMessage ONLY while it shows the active announcement,
// exactly the living rule. A memorial's line is never a care reminder (nothing writes reminders
// to a dead pet), so that half of the living rule does not apply.
//
// Flag-gated, default OFF, serial-first like every other card feature: with both switches off the
// pass bytes are identical to today for every pet (scripts/announce-check.ts proves it on the full
// passJson). Switching it on ADDS a field to the memorial card, which iOS 27 has shown as the
// generic "Pass changed" (2026-10-17), so the rollout names Hunt's tombstone first.

/** What the memorial line shows when a gone pet has no last event. Hunt's to change; keep it short. */
export const MEMORIAL_IDLE_LINE = "Resting.";

// Parsed once per distinct env value (the env does not change at runtime, but checks flip it in-process).
let serialsRaw: string | undefined;
let serials: ReadonlySet<string> = new Set();
function memorialLineSerials(): ReadonlySet<string> {
  if (config.MEMORIAL_LINE_SERIALS !== serialsRaw) {
    serialsRaw = config.MEMORIAL_LINE_SERIALS;
    serials = new Set((serialsRaw ?? "").split(",").map((s) => s.trim()).filter((s) => s.length > 0));
  }
  return serials;
}

/** True when this GONE pet's memorial card carries the event line. Always false for a living pet. */
export function memorialLineEnabledFor(runner: Pick<Runner, "serial" | "gone">): boolean {
  return runner.gone && (config.MEMORIAL_LINE_ENABLED || memorialLineSerials().has(runner.serial));
}

/** The memorial line's value: the last event, else the idle line. */
export function memorialLineValue(runner: Pick<Runner, "lastEvent">): string {
  return runner.lastEvent ?? MEMORIAL_IDLE_LINE;
}
