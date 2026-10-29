import { logger } from "../logger.js";
import type { AppContext } from "../context.js";
import type { Runner } from "../store/types.js";
import { pushRunnerPass } from "./idle.js";
import { isAlertLine } from "./reminders.js";
import { memorialLineEnabledFor } from "./memorial-line.js";
import { MEMORIAL_COPY } from "./theme.js";

// ONE-TIME ANNOUNCEMENT ON THE EVENT LINE (2026-10-17).
//
// Hunt does not want announcements to add lines to the card (the album "NEW" back field made it
// busy). Every living card already has an event line (pass.ts, the field built from
// runner.lastEvent), and the evidence from Hunt's iOS 27 phone and the device-true diff log is:
// a VALUE change of an EXISTING field that carries changeMessage "%@" raises exactly that text;
// dropping the changeMessage with the same value is silent; plain value changes are silent.
//
// So an announcement sets lastEvent to the text and pings the phone. The line carries "%@" only
// while its value equals the ACTIVE announcement, which is persisted (store) so a restart between
// the push and the phone's fetch still serves the banner. The next care or event replaces
// lastEvent with a normal line (no changeMessage); clearing the announcement leaves cards that
// still show the text with the same value and no changeMessage (silent). A pending care reminder
// (isAlertLine) is never overwritten: those pets are skipped.
//
// DELIVERY RECORD (2026-10-18). "Already got it" used to mean "the line still shows the text",
// which stops being true within hours (the next care or idle line replaces it). So a re-run of the
// same text, to reach the cards a reminder made us skip, would have bannered everyone a second
// time. Now every delivery is recorded per (serial, text) in the store, right after the line is
// written and BEFORE the push (a crash mid-push errs toward not re-sending), and a card with a
// record is "already" forever, whatever its line shows now. Re-running the same text is safe.
//
// MEMORIAL CARDS (2026-10-18). A memorial has the event line only under the memorial-line flag
// (runner/memorial-line.ts); with it on for a tombstone, that card is a target like a living one.

export const ANNOUNCE_MAX_CHARS = 140;
const PACE_MS = 250;

/** null when the text is acceptable, else why not. Plain text only: no markup, no control chars. */
export function announcementTextError(text: unknown): string | null {
  if (typeof text !== "string") return "text must be a string";
  if (text.trim() !== text) return "text must not start or end with whitespace";
  if (text.length < 1 || text.length > ANNOUNCE_MAX_CHARS) return `text must be 1 to ${ANNOUNCE_MAX_CHARS} characters`;
  if (/[<>]/.test(text)) return "text must be plain (no < or >)";
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u001f\u007f-\u009f\u2028\u2029]/.test(text)) return "text must not contain control characters or line breaks";
  if (/\u2014/.test(text) || text.includes("-".repeat(2))) return "text must not contain an em dash";
  // A reminder-shaped line would be treated as a reminder (banner on every change, never overwritten).
  if (isAlertLine(text)) return "text must not look like a care reminder";
  return null;
}

// THE ACTIVE ANNOUNCEMENT: persisted, cached in process.
let cache: { loaded: boolean; text: string | null } = { loaded: false, text: null };

/** The active announcement, read from the store once per process (write-through after that). */
export async function activeAnnouncement(ctx: AppContext): Promise<string | null> {
  if (cache.loaded) return cache.text;
  try {
    const text = await ctx.store.getActiveAnnouncement();
    cache = { loaded: true, text };
    return text;
  } catch (err) {
    // A failed read serves no changeMessage (silent at worst) and retries on the next pass build.
    logger.warn({ err: String(err) }, "announcement read failed");
    return cache.text;
  }
}

/** Test hook: forget the in-process cache (the in-memory half of a simulated restart). */
export function _resetAnnouncementCache(): void {
  cache = { loaded: false, text: null };
}

// THE RUN.
export interface AnnounceState {
  running: boolean;
  text: string | null;
  total: number;
  done: number;
  skipped: number;
  failed: number;
  skippedReasons: { reminder: number; already: number; notLiving: number; notFound: number };
  startedAt: string | null;
  finishedAt: string | null;
}

const emptyState = (): AnnounceState => ({
  running: false,
  text: null,
  total: 0,
  done: 0,
  skipped: 0,
  failed: 0,
  skippedReasons: { reminder: 0, already: 0, notLiving: 0, notFound: 0 },
  startedAt: null,
  finishedAt: null,
});
let state: AnnounceState = emptyState();

export function announceState(): AnnounceState {
  return state;
}

/**
 * A pet the event line exists on: minted, not the champion (whose line is WINNER), and either alive
 * or a memorial with the line switched on (runner/memorial-line.ts).
 */
const hasEventLine = (r: Runner | null | undefined): r is Runner =>
  !!r && r.status === "ready" && !r.won && (!r.gone || memorialLineEnabledFor(r));

type SkipReason = keyof AnnounceState["skippedReasons"];
/**
 * Why a pet is skipped, or null to announce. `delivered` is the set of serials already recorded for
 * this text. notLiving keeps its name for the dry-run shape: it now also covers a memorial whose
 * line is switched off (and the champion, as before).
 */
function skipReason(r: Runner | null | undefined, text: string, delivered: ReadonlySet<string>): SkipReason | null {
  if (!r) return "notFound";
  if (!hasEventLine(r)) return "notLiving";
  // Recorded or still showing it: either way this card had its banner. Checked before the reminder
  // so a card that got it and then earned a reminder counts as already, not as skipped again.
  if (delivered.has(r.serial) || r.lastEvent === text) return "already";
  if (isAlertLine(r.lastEvent)) return "reminder";
  return null;
}

export interface AnnounceRequest {
  text: string;
  serials?: string[];
  all?: boolean;
  dryRun?: boolean;
}

export type AnnounceResult =
  | { kind: "busy" }
  | { kind: "dry"; total: number; wouldAnnounce: number; wouldSkip: AnnounceState["skippedReasons"] }
  | { kind: "started" };

async function targetsFor(ctx: AppContext, req: AnnounceRequest): Promise<Array<{ serial: string; runner: Runner | null }>> {
  if (req.all) {
    return (await ctx.store.allMintedRunners()).filter(hasEventLine).map((r) => ({ serial: r.serial, runner: r }));
  }
  const serials = [...new Set(req.serials ?? [])];
  const out: Array<{ serial: string; runner: Runner | null }> = [];
  for (const serial of serials) out.push({ serial, runner: await ctx.store.getRunner(serial) });
  return out;
}

/**
 * Announce `text` on the event line of the targeted pets. One run at a time. Persists the active
 * announcement FIRST (so every card that gets the text serves it with the changeMessage), then
 * walks the targets paced: lastEvent = text, delivery recorded, Apple ping, Google patch plus ONE
 * notifying message. Fire-and-forget; progress on announceState().
 */
export async function startAnnouncement(ctx: AppContext, req: AnnounceRequest): Promise<AnnounceResult> {
  if (state.running) return { kind: "busy" };
  const targets = await targetsFor(ctx, req);
  // Read once per run: only this run adds to it (one run at a time), and it adds as it goes.
  const delivered = await ctx.store.listAnnouncementDeliveries(req.text);
  if (req.dryRun) {
    const wouldSkip = { reminder: 0, already: 0, notLiving: 0, notFound: 0 };
    for (const t of targets) {
      const why = skipReason(t.runner, req.text, delivered);
      if (why) wouldSkip[why] += 1;
    }
    const skipped = Object.values(wouldSkip).reduce((a, b) => a + b, 0);
    return { kind: "dry", total: targets.length, wouldAnnounce: targets.length - skipped, wouldSkip };
  }
  const text = req.text;
  await ctx.store.setActiveAnnouncement(text);
  cache = { loaded: true, text };
  state = { ...emptyState(), running: true, text, total: targets.length, startedAt: new Date().toISOString() };
  const run = state;
  void (async () => {
    for (const t of targets) {
      // Cleared or replaced mid-run: stop, so no card gets a text that no longer banners.
      if (cache.text !== text) break;
      try {
        // Re-read right before writing: a reminder may have landed since the list was taken.
        const fresh = await ctx.store.getRunner(t.serial);
        const why = skipReason(fresh, text, delivered);
        if (why) {
          run.skipped += 1;
          run.skippedReasons[why] += 1;
          run.done += 1;
          continue;
        }
        await ctx.store.updateRunner(t.serial, { lastEvent: text });
        // Recorded the moment the line is written, before the push: if the process dies here the
        // phone may fetch the text on its own, and a re-run must not send it again.
        await ctx.store.recordAnnouncementDelivery(t.serial, text);
        delivered.add(t.serial);
        await pushRunnerPass(ctx, t.serial, { message: { header: "WALLETCHI", body: text, notify: true } });
      } catch (err) {
        run.failed += 1;
        logger.warn({ err: String(err), serial: t.serial }, "announcement failed for a pet");
      }
      run.done += 1;
      await new Promise((r) => setTimeout(r, PACE_MS));
    }
    run.running = false;
    run.finishedAt = new Date().toISOString();
    logger.info({ ...run }, "announcement finished");
  })();
  return { kind: "started" };
}

/**
 * Clear the active announcement. Living cards still showing it keep the value and lose the
 * changeMessage (silent); the next care or idle line replaces it. A TOMBSTONE has no next line
 * (nothing rewrites a gone pet's lastEvent), so it would show the announcement forever: every gone
 * pet whose line equals the cleared text goes back to the memorial sentence it died with, and its
 * cards are pinged with no message. That happens strictly AFTER the store clear, so the served line
 * already has no changeMessage and the value change is the proven silent path. Paced, in the
 * background; progress on memorialResetState().
 */
export async function clearAnnouncement(ctx: AppContext): Promise<void> {
  const cleared = await activeAnnouncement(ctx);
  await ctx.store.setActiveAnnouncement(null);
  cache = { loaded: true, text: null };
  if (cleared) void resetMemorialLines(ctx, cleared);
}

export interface MemorialResetState {
  running: boolean;
  total: number;
  done: number;
  failed: number;
}
let memorialReset: MemorialResetState = { running: false, total: 0, done: 0, failed: 0 };
export function memorialResetState(): MemorialResetState {
  return memorialReset;
}

async function resetMemorialLines(ctx: AppContext, text: string): Promise<void> {
  // Never runs concurrently with itself: a second DELETE while one is going is left to the next.
  if (memorialReset.running) return;
  let tombstones: Runner[];
  try {
    tombstones = (await ctx.store.allMintedRunners()).filter((r) => r.gone && r.lastEvent === text);
  } catch (err) {
    logger.warn({ err: String(err) }, "memorial line reset: could not list pets");
    return;
  }
  const run: MemorialResetState = { running: true, total: tombstones.length, done: 0, failed: 0 };
  memorialReset = run;
  for (const r of tombstones) {
    try {
      // Re-read: the line must still be the cleared text (a new announcement may have landed).
      const fresh = await ctx.store.getRunner(r.serial);
      if (fresh?.gone && fresh.lastEvent === text) {
        await ctx.store.updateRunner(r.serial, { lastEvent: MEMORIAL_COPY.memorialLine });
        await pushRunnerPass(ctx, r.serial);
      }
    } catch (err) {
      run.failed += 1;
      logger.warn({ err: String(err), serial: r.serial }, "memorial line reset failed for a pet");
    }
    run.done += 1;
    await new Promise((res) => setTimeout(res, PACE_MS));
  }
  run.running = false;
  if (run.total) logger.info({ ...run }, "memorial line reset finished");
}
