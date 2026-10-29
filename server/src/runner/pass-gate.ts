import { createHash } from "node:crypto";
import { config } from "../config.js";
import type { AppContext } from "../context.js";
import type { Runner, ServedPassSnapshot } from "../store/types.js";
import { assembleRunnerPass } from "./pass.js";
import { stablePassInputs } from "./pass-memory.js";
import { passFieldSnapshot, PASS_DIFF_KEEP, type Snap } from "./pass-diff.js";
import { versionChangedAt } from "./pass-time.js";
import { isAlertLine } from "./reminders.js";

// PASS PUSH GATE (2026-10-21). iOS 27 warned WALLETCHI holders "Some passes are receiving too many
// updates" and threatened to switch off automatic updates. The Wallet device logs named the three
// things it counts against us:
//   1. "Server requested update ... but the pass was unchanged": a push for a pass whose content
//      had not changed (the hourly refresh pushed every card, every hour).
//   2. "Server ignored the 'if-modified-since' header ... returned the full unchanged pass data":
//      Last-Modified followed the row's updatedAt or a global epoch, not the pass content.
//   3. "Device received spurious push ... returned no serial numbers": a push the device list
//      endpoint then did not back up.
//
// ONE SOURCE OF TRUTH: THE CONTENT ROWS. Every content version of a pass is one PassServedSnapshot
// row (serial, lastModified), holding the field snapshot plus a hash of the rest of the bundle
// (images, colors). The newest row per serial IS the pass's current version:
//   - Last-Modified of the pass = that row's lastModified (whole seconds, strictly increasing per
//     serial, see nextLastModified), so If-Modified-Since gets an honest 304;
//   - the "updated since" list endpoint reports a serial when that row's changedAt (when the
//     version first appeared, in ms, see changedAtOf) is newer than the device's tag, and the tag it
//     returns is the newest such changedAt;
//   - a push goes out ONLY after a new row was written for it (the content differs from the newest
//     row), so the device that is pinged always finds the serial listed and a different pass.
// A pass GET that renders content different from the newest row writes the new row itself (the
// content moved without a push, e.g. the headcount), so a manual refresh is also honest.
//
// Which differences justify a PUSH is decided per call (compareFor): every field counts for a
// high-signal push (reminder, memorial, evolution, victory, claim, announce, care); a silent
// background refresh ignores the ALIVE headcount alone (it rides along with the next real push)
// and never runs during quiet hours. Images never decide a push (the time-of-day art would push
// every card four times a day), but they do count for Last-Modified, so a served pass is never
// called unchanged when its art moved.

/** Meta keys added to a field snapshot. Never fields; prefixed so they cannot collide with one. */
export const META_BUNDLE = "_bundle";
export const META_COLORS = "_colors";

/** SURVIVES carries an ISO deadline rebuilt from "now + seconds left": a second of jitter is not news. */
export const LIFE_TOLERANCE_MS = 120_000;

const isMeta = (path: string) => path.startsWith("_");

// VITAL FIELDS (the night safety net). The old hourly epoch re-sent every card through the night,
// so a deadline that moved (a care made on the website, a need the server folded late) still
// reached the phone. Quiet hours now hold back only the cosmetic changes: flavor on the event line,
// the balance, the headcount, the back. A change to the clock or the state of the pet still goes:
// SURVIVES, the STATUS word, the memorial and champion fields, the setup nudge, and the event line
// when it now shows a reminder (runner/reminders.ts).
const VITAL_KEYS: ReadonlySet<string> = new Set([
  "life",
  "petstatus",
  "winner",
  "pot",
  "lived",
  "cared",
  "outlasted",
  "memory",
  "epitaph",
  "setup",
]);
export function isVitalPath(path: string, now: Snap[string] | undefined): boolean {
  const key = path.slice(path.lastIndexOf(".") + 1);
  if (VITAL_KEYS.has(key)) return true;
  return key === "status" && isAlertLine(now?.value ?? null);
}
const isHeadcount = (path: string) => path.endsWith(".alive");
const isLife = (path: string) => path.endsWith(".life");

/** Hash of everything in the bundle that is not a field: the images and the ground colors. */
export function bundleHash(images: Record<string, Buffer>): string {
  const h = createHash("sha1");
  for (const name of Object.keys(images).sort()) {
    h.update(name);
    h.update(createHash("sha1").update(images[name]!).digest());
  }
  return h.digest("hex");
}

/** The full content snapshot of a rendered pass: its fields plus the bundle and color meta keys. */
export function passContentSnapshot(passJson: Record<string, unknown>, images?: Record<string, Buffer>): Snap {
  const snap = passFieldSnapshot(passJson);
  snap[META_COLORS] = {
    value: [passJson.foregroundColor, passJson.backgroundColor, passJson.labelColor].map((c) => String(c ?? "")).join("|"),
  };
  if (images) snap[META_BUNDLE] = { value: bundleHash(images) };
  return snap;
}

export interface CompareOpts {
  /** Ignore the ALIVE headcount (a background refresh: the count alone never pushes). */
  ignoreHeadcount?: boolean;
  /** Ignore the meta keys (images, colors): a push decision is about fields only. */
  fieldsOnly?: boolean;
  /** Quiet hours: compare only the fields that matter at night (isVitalPath). */
  vitalOnly?: boolean;
}

function sameValue(path: string, a: Snap[string] | undefined, b: Snap[string] | undefined): boolean {
  if (!a || !b) return a === b;
  if (a.attributed !== b.attributed || a.cm !== b.cm) return false;
  if (a.value === b.value) return true;
  if (isLife(path)) {
    const ta = Date.parse(a.value);
    const tb = Date.parse(b.value);
    return Number.isFinite(ta) && Number.isFinite(tb) && Math.abs(ta - tb) <= LIFE_TOLERANCE_MS;
  }
  return false;
}

/**
 * True when `now` carries nothing new versus `prev` under `opts`. A meta key missing on either
 * side is not compared (rows written before this gate existed have no bundle hash; the gate's own
 * field-only render has none either), so the absence of a hash is never itself a change.
 */
export function sameContent(prev: Snap, now: Snap, opts: CompareOpts = {}): boolean {
  const paths = new Set([...Object.keys(prev), ...Object.keys(now)]);
  for (const path of paths) {
    if (isMeta(path)) {
      if (opts.fieldsOnly) continue;
      if (!(path in prev) || !(path in now)) continue;
    }
    if (opts.ignoreHeadcount && isHeadcount(path)) continue;
    if (opts.vitalOnly && !isVitalPath(path, now[path])) continue;
    if (!sameValue(path, prev[path], now[path])) return false;
  }
  return true;
}

const toSecond = (ms: number) => Math.floor(ms / 1000) * 1000;

/**
 * The Last-Modified for a NEW content version: this second, but always at least one second past the
 * newest version (two changes inside one second must not share a Last-Modified, or the phone holding
 * the first would be told 304 for the second). It can run a second or two ahead of the clock in a
 * burst; that is harmless, because the list endpoint orders versions by changedAt, not by this.
 */
export function nextLastModified(newest: Pick<ServedPassSnapshot, "lastModified"> | undefined, nowMs: number): Date {
  const floor = toSecond(nowMs);
  if (!newest) return new Date(floor);
  return new Date(Math.max(floor, newest.lastModified.getTime() + 1000));
}

/** When a version first appeared, for the "updated since" list (see versionChangedAt). */
export const changedAtOf = versionChangedAt;

export function parseSnap(fields: string): Snap {
  try {
    return JSON.parse(fields) as Snap;
  } catch {
    return {};
  }
}

/** Render the pass exactly as the Wallet web service would serve it (stable inputs, same options). */
export async function renderForGate(
  ctx: AppContext,
  runner: Runner,
  opts: { images: boolean },
): Promise<{ snap: Snap; passJson: Record<string, unknown> }> {
  const inputs = await stablePassInputs(ctx, runner);
  const assembled = await assembleRunnerPass(runner, { ...inputs, fieldsOnly: !opts.images });
  return { snap: passContentSnapshot(assembled.passJson, opts.images ? assembled.images : undefined), passJson: assembled.passJson };
}

/** Write a new content version and return its Last-Modified. */
export async function recordVersion(
  ctx: AppContext,
  serial: string,
  newest: ServedPassSnapshot | undefined,
  snap: Snap,
  nowMs = Date.now(),
): Promise<Date> {
  const lastModified = nextLastModified(newest, nowMs);
  await ctx.store.putServedPassSnapshot(serial, lastModified, JSON.stringify(snap), PASS_DIFF_KEEP, new Date(nowMs));
  return lastModified;
}

// Which version each serial's phones last fetched (Last-Modified ms), noted by the pass GET. Used
// only to decide whether a push APNs refused still needs a retry (runner/idle.ts): a phone that
// already fetched the version must not be pinged for it again. In memory, bounded.
const fetchedVersion = new Map<string, number>();
export function noteVersionFetched(serial: string, lastModified: Date): void {
  if (fetchedVersion.size > 20_000) fetchedVersion.clear();
  fetchedVersion.set(serial, lastModified.getTime());
}
export function versionFetched(serial: string, lastModified: Date | undefined): boolean {
  return lastModified !== undefined && fetchedVersion.get(serial) === lastModified.getTime();
}

export type GateMode =
  /** A high-signal or care push: any field change pushes (the default). */
  | "content"
  /** A silent background refresh: the headcount alone does not push, and in quiet hours only a
   *  vital field (isVitalPath) does. */
  | "background"
  /** A template change at boot: fields, art and colors all count. */
  | "bundle"
  /** The auth token rotated (claim, link reset): the old devices must fetch the keepsake. */
  | "force";

export type GateDecision =
  | { push: true; reason: "changed" | "first-version" | "forced"; lastModified: Date }
  | { push: false; reason: "unchanged" | "quiet" | "gone"; newestLastModified?: Date };

/**
 * Decide whether an Apple push for `serial` would deliver a different pass and, when it would,
 * write the new version first (so the list endpoint and the pass GET back the push up). The caller
 * has already checked devices. `quiet`: quiet hours, which only matter to a background refresh.
 */
export async function gateApplePush(
  ctx: AppContext,
  serial: string,
  mode: GateMode,
  nowMs = Date.now(),
  opts: { quiet?: boolean } = {},
): Promise<GateDecision> {
  const runner = await ctx.store.getRunner(serial);
  if (!runner) return { push: false, reason: "gone" };
  const newest = (await ctx.store.listServedPassSnapshots(serial))[0];
  if (mode === "force") {
    const { snap } = await renderForGate(ctx, runner, { images: true });
    return { push: true, reason: "forced", lastModified: await recordVersion(ctx, serial, newest, snap, nowMs) };
  }
  if (!newest) {
    // Never served through the web service since versions were kept: nothing to compare with, so
    // this push establishes the first version (the phone fetches against its row's updatedAt).
    const { snap } = await renderForGate(ctx, runner, { images: true });
    return { push: true, reason: "first-version", lastModified: await recordVersion(ctx, serial, newest, snap, nowMs) };
  }
  const prev = parseSnap(newest.fields);
  const compare: CompareOpts =
    mode === "background" ? { ignoreHeadcount: true, fieldsOnly: true } : mode === "bundle" ? {} : { fieldsOnly: true };
  // Fields first, without painting any art: most background checks stop here.
  const quick = await renderForGate(ctx, runner, { images: mode === "bundle" });
  if (sameContent(prev, quick.snap, compare)) return { push: false, reason: "unchanged", newestLastModified: newest.lastModified };
  // Night: the change waits for morning unless it is vital. Nothing is written, so the morning run
  // still sees the difference.
  if (mode === "background" && opts.quiet && sameContent(prev, quick.snap, { ...compare, vitalOnly: true })) {
    return { push: false, reason: "quiet", newestLastModified: newest.lastModified };
  }
  const full = mode === "bundle" ? quick : await renderForGate(ctx, runner, { images: true });
  return { push: true, reason: "changed", lastModified: await recordVersion(ctx, serial, newest, full.snap, nowMs) };
}

// TEMPLATE HASH (fix 3). The boot refresh used to push the whole roster 90 s after every boot. It
// now runs only when something that shapes every card changed: the template version below or one
// of the settings that change a card.
//
// BUMP PASS_TEMPLATE_VERSION IN THE SAME PR as any code change to the pass that ships without a
// setting: new or changed art, layout, colors, a field's label or attributedValue. A field VALUE
// change is caught by the hourly refresh on its own, but an art-only change (petPassImages,
// petPosterImages, the strip, the icon) is invisible to the field diff, so without a bump it only
// reaches a card on that pet's next real change. The bump makes the next boot push every living
// card whose fields, art or colors differ (mode "bundle"), once. The
// last hash lives in PassFieldMemory, so an ordinary redeploy or restart pushes nothing. With no
// stored hash (the first boot of this code) the hash is stored and NOTHING is pushed: the cards in
// Wallet already match the template.
export const PASS_TEMPLATE_VERSION = "2026-10-21.1";
export const TEMPLATE_HASH_KEY = "pass-template-hash";

export function passTemplateHash(): string {
  const c = config as unknown as Record<string, unknown>;
  const relevant = [
    "PUBLIC_BASE_URL",
    "WEB_APP_URL",
    "ROBINHOOD_NETWORK",
    "PASS_TYPE_ID",
    "APPLE_TEAM_ID",
    "ORGANIZATION_NAME",
    "STATS_BAND_ENABLED",
    "POSTER_GENERIC_ENABLED",
    "POSTER_GENERIC_SERIALS",
    "TRAITS_V2_ENABLED",
    "GAME_ENABLED",
    "GAME_SERIALS",
    "NIGHT_ENABLED",
    "NIGHT_SERIALS",
    "ALBUM_ENABLED",
    "ALBUM_SERIALS",
    "ALBUM_ANNOUNCE",
    "ALBUM_NOTE_SERIALS",
    "ALBUM_NOTE_MODE",
    "NEWS_TEXT",
    "NEWS_BANNER",
    "MEMORIAL_LINE_ENABLED",
    "MEMORIAL_LINE_SERIALS",
    // NOT the CHI VALLEY settings (runner/valley.ts), on purpose: a hash change runs the boot refresh
    // in "bundle" mode, which also compares the art, and the art moves with the time of day, so even
    // a flags-off deploy would push every card whose art drifted. The valley link is a back FIELD, so
    // the scheduled background refresh pushes exactly the cards that gain or lose it.
  ];
  const flags: Record<string, unknown> = { v: PASS_TEMPLATE_VERSION, rewardsLive: config.modes.rewardsLive };
  for (const k of relevant) flags[k] = c[k] ?? null;
  return createHash("sha256").update(JSON.stringify(flags)).digest("hex");
}

/** "first-boot" (stored, nothing to do), "unchanged" (nothing to do) or "changed" (refresh, stored). */
export async function claimTemplateChange(ctx: AppContext): Promise<"first-boot" | "unchanged" | "changed"> {
  const hash = passTemplateHash();
  const stored = await ctx.store.getPassFieldMemory(TEMPLATE_HASH_KEY);
  if (stored === hash) return "unchanged";
  // Stored BEFORE the refresh runs: a crash mid-run must not make every later boot push the roster
  // again. A card the interrupted run missed still updates on its next real change.
  await ctx.store.putPassFieldMemory(TEMPLATE_HASH_KEY, hash);
  return stored === null ? "first-boot" : "changed";
}
