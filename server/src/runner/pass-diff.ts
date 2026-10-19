import { logger } from "../logger.js";
import type { AppContext } from "../context.js";

// PASS DIFF LOG (2026-10-17). Holders saw iOS's generic "Pass changed" next to the album message,
// and guessing at the cause was not good enough: we are on people's lock screens. So every time a
// device downloads a pass, log exactly which fields changed and whether each changed field carries
// a changeMessage (Apple only documents notifying on those; several changing at once are
// summarised as "Pass changed"). Pure observation: it never changes what is served.
//
// DEVICE-TRUE. The phone compares the new pass with the copy IT holds, not with the last pass this
// process served (another device, or a previous process before a restart, may have served
// something else). A device's fetch carries If-Modified-Since, the Last-Modified of its copy, so
// every served pass's field snapshot is stored keyed by the Last-Modified it went out with
// (PassServedSnapshot, the newest PASS_DIFF_KEEP per serial, in the DB so restarts keep them) and
// the diff runs against the snapshot whose Last-Modified equals the request's If-Modified-Since.
// When there is no such snapshot (no header, or a copy older than the ones kept) it diffs against
// the newest one and says so in `base`. A 304 delivers no pass and is never logged.

type FieldSnap = { value: string; attributed?: string; cm?: string };
type Snap = Record<string, FieldSnap>; // path "storeCard.backFields.album" -> field

const SECTIONS = ["headerFields", "primaryFields", "secondaryFields", "auxiliaryFields", "footerFields", "backFields"] as const;
export const PASS_DIFF_KEEP = 5;

export function passFieldSnapshot(passJson: Record<string, unknown>): Snap {
  const out: Snap = {};
  for (const dict of ["storeCard", "posterGeneric", "generic", "eventTicket"]) {
    const d = passJson[dict] as Record<string, unknown> | undefined;
    if (!d) continue;
    for (const sec of SECTIONS) {
      const arr = d[sec] as Array<Record<string, unknown>> | undefined;
      if (!Array.isArray(arr)) continue;
      for (const f of arr) {
        out[`${dict}.${sec}.${String(f.key)}`] = {
          value: String(f.value ?? ""),
          ...(f.attributedValue !== undefined ? { attributed: String(f.attributedValue) } : {}),
          ...(f.changeMessage !== undefined ? { cm: String(f.changeMessage) } : {}),
        };
      }
    }
  }
  return out;
}

const short = (s: string | undefined) => (s === undefined ? undefined : s.length > 90 ? `${s.slice(0, 87)}...` : s);

/** Whole seconds: Last-Modified and If-Modified-Since are HTTP dates. */
const toSecond = (d: Date) => new Date(Math.floor(d.getTime() / 1000) * 1000);

export type DiffBase = "ims" | "latest-no-ims" | "latest-ims-unmatched" | "none";

export interface PassDiffResult {
  base: DiffBase;
  baseLastModified: string | null;
  changes: Array<Record<string, unknown>>;
  notifying: number;
}

export function diffSnapshots(prev: Snap, now: Snap): Array<Record<string, unknown>> {
  const changes: Array<Record<string, unknown>> = [];
  for (const [path, f] of Object.entries(now)) {
    const p = prev[path];
    if (!p) changes.push({ path, kind: "added", to: short(f.value), cm: f.cm ?? null });
    else if (p.value !== f.value || p.attributed !== f.attributed || p.cm !== f.cm) {
      changes.push({ path, kind: "changed", from: short(p.value), to: short(f.value), cmBefore: p.cm ?? null, cm: f.cm ?? null });
    }
  }
  for (const [path, p] of Object.entries(prev)) {
    if (!(path in now)) changes.push({ path, kind: "removed", from: short(p.value), cmBefore: p.cm ?? null });
  }
  return changes;
}

/**
 * Record a pass served with `lastModified` and log what changed versus the copy the requesting
 * device holds (its If-Modified-Since). Never throws; returns the result for tests.
 */
export async function logPassDiff(
  ctx: AppContext,
  serial: string,
  passJson: Record<string, unknown>,
  lastModified: Date,
  ifModifiedSince: string | undefined,
  meta: Record<string, unknown> = {},
): Promise<PassDiffResult | null> {
  try {
    const now = passFieldSnapshot(passJson);
    const kept = await ctx.store.listServedPassSnapshots(serial); // newest first
    const imsMs = ifModifiedSince ? new Date(ifModifiedSince).getTime() : NaN;
    const hasIms = Number.isFinite(imsMs);
    const exact = hasIms ? kept.find((k) => toSecond(k.lastModified).getTime() === Math.floor(imsMs / 1000) * 1000) : undefined;
    const prevRow = exact ?? kept[0];
    const base: DiffBase = exact ? "ims" : !prevRow ? "none" : hasIms ? "latest-ims-unmatched" : "latest-no-ims";

    await ctx.store.putServedPassSnapshot(serial, toSecond(lastModified), JSON.stringify(now), PASS_DIFF_KEEP);

    if (!prevRow) {
      logger.info({ serial, base, fields: Object.keys(now).length, ...meta }, "pass diff: baseline");
      return { base, baseLastModified: null, changes: [], notifying: 0 };
    }
    const changes = diffSnapshots(JSON.parse(prevRow.fields) as Snap, now);
    // the fields Apple documents it notifies on: value changed or added, WITH a changeMessage in the
    // new pass. This can UNDERCOUNT: on 2026-10-17 (iOS 27) a back field added WITHOUT a changeMessage
    // still raised "Pass changed", and when the pass carries posterGeneric every back field is listed twice (storeCard and posterGeneric).
    const notifying = changes.filter((c) => c.kind !== "removed" && c.cm).length;
    const baseLastModified = prevRow.lastModified.toUTCString();
    logger.info({ serial, base, baseLastModified, changed: changes.length, notifying, changes, ...meta }, "pass diff");
    return { base, baseLastModified, changes, notifying };
  } catch (err) {
    logger.warn({ err: String(err), serial }, "pass diff failed");
    return null;
  }
}
