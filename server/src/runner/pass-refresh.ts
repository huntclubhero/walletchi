import { config } from "../config.js";
import { logger } from "../logger.js";
import type { AppContext } from "../context.js";
import { pushRunnerPass } from "./idle.js";
import { albumEnabledFor, ALBUM_NOTICE } from "./album.js";
import { headcountVerified, refreshSeasonSnapshot } from "./season.js";
import { warmPassFieldMemory } from "./pass-memory.js";
import { claimTemplateChange, type GateMode } from "./pass-gate.js";

// KEEPING EVERY CARD CURRENT, WITHOUT PUSHING UNCHANGED CARDS (2026-10-21).
//
// A Wallet card only changes when the phone re-downloads it, and the phone only re-downloads after
// (1) we ping it and (2) the server then reports the pass as changed. This module used to keep the
// cards current with a PASS EPOCH: every run moved it, so every pass counted as changed and every
// phone was pinged, 24 times a day plus 90 s after every boot. iOS 27 counts those pushes of an
// unchanged pass against us ("Some passes are receiving too many updates... automatic updates for
// your WALLETCHI passes will be disabled").
//
// Now every run goes through the push gate (runner/pass-gate.ts): a pass is pushed only when the
// content the phone would download differs from the version it holds, and "changed" is per serial,
// written right before that one push. So the timer stays (it is what catches a real change that
// nothing pushed, like a layout or setting change) but for an unchanged pass it is a no-op.
//   - the SCHEDULED run (every PASS_REFRESH_MINUTES) is a background refresh: fields only, the
//     headcount alone never pushes, and it does nothing for Apple during quiet hours;
//   - the BOOT run (~90 s after boot) only happens when the template hash changed (pass-gate.ts):
//     an ordinary deploy or restart pushes nothing, and the first boot of this code only stores it;
//   - the MANUAL run (/internal/passes/refresh) counts every field change.
// Every ping is SILENT: no message, so no banner and no sound (news and album runs add Google
// messages exactly as before).

export interface PassRefreshState {
  running: boolean;
  total: number;
  done: number;
  failed: number;
  /** Apple outcomes of this run (runner/idle.ts ApplePushOutcome). */
  pushed: number;
  unchanged: number;
  quiet: number;
  startedAt: string | null;
  reason: string | null;
}

let state: PassRefreshState = { running: false, total: 0, done: 0, failed: 0, pushed: 0, unchanged: 0, quiet: 0, startedAt: null, reason: null };

export function passRefreshState(): PassRefreshState {
  return state;
}

/** Spacing between pets, so APNs and the Google API never see a burst. */
const PACE_MS = 250;

/**
 * Walk the living pets (and memorials with { memorials: true }) and push each card whose content
 * changed, under `mode` (runner/pass-gate.ts). One run at a time; returns false (and changes
 * nothing) when a run is already going. Fire-and-forget: progress is on passRefreshState().
 */
export async function refreshAllPasses(
  ctx: AppContext,
  reason: string,
  opts: { memorials?: boolean; news?: boolean; album?: boolean; mode?: GateMode } = {},
): Promise<boolean> {
  if (state.running) return false;
  const runners = (await ctx.store.allMintedRunners()).filter((x) => x.status === "ready" && (opts.memorials || !x.gone));
  const mode: GateMode = opts.mode ?? "content";
  state = {
    running: true,
    total: runners.length,
    done: 0,
    failed: 0,
    pushed: 0,
    unchanged: 0,
    quiet: 0,
    startedAt: new Date().toISOString(),
    reason,
  };
  const run = state;
  void (async () => {
    for (const x of runners) {
      try {
        // news: Apple banners come from the NEWS field itself; Google gets a notifying message
        // album: the photo album announcement, to Google cards that have the album (Apple banners
        // come from the plain albumNote line while ALBUM_ANNOUNCE=banner)
        const message =
          opts.album && albumEnabledFor(x)
            ? { header: "WALLETCHI", body: ALBUM_NOTICE, notify: true }
            : opts.news && config.NEWS_TEXT
              ? { header: "WALLETCHI", body: config.NEWS_TEXT, notify: true }
              : undefined;
        const outcome = await pushRunnerPass(ctx, x.serial, message ? { message, mode } : { mode });
        if (outcome === "pushed") run.pushed += 1;
        else if (outcome === "unchanged") run.unchanged += 1;
        else if (outcome === "quiet") run.quiet += 1;
        else if (outcome === "failed") run.failed += 1;
      } catch {
        run.failed += 1;
      }
      run.done += 1;
      await new Promise((r) => setTimeout(r, PACE_MS));
    }
    run.running = false;
    logger.info({ ...run, mode }, "silent pass refresh finished");
  })();
  return true;
}

/** How long the boot refresh waits for a verified headcount before it runs anyway. */
export const BOOT_HEADCOUNT_MAX_WAIT_MS = 10 * 60_000;
const BOOT_HEADCOUNT_RETRY_MS = 30_000;

/**
 * Wait until the season snapshot holds a verified on-chain headcount, so the boot refresh never
 * serves a pass built before it. True at once when the season is not live (there is no headcount
 * to wait for). Bounded: after maxWaitMs it returns false and the refresh runs anyway, which is
 * still safe because the ALIVE field then serves its last verified value (runner/pass-memory.ts).
 */
export async function waitForVerifiedHeadcount(
  ctx: AppContext,
  opts: { maxWaitMs?: number; retryMs?: number } = {},
): Promise<boolean> {
  if (!config.modes.survivalLive) return true;
  const deadline = Date.now() + (opts.maxWaitMs ?? BOOT_HEADCOUNT_MAX_WAIT_MS);
  for (;;) {
    await refreshSeasonSnapshot(ctx, true).catch(() => undefined);
    if (headcountVerified()) return true;
    if (Date.now() >= deadline) return false;
    await new Promise((r) => setTimeout(r, opts.retryMs ?? BOOT_HEADCOUNT_RETRY_MS));
  }
}

/**
 * The boot run (fix 3): only when the template hash changed. "first-boot" stores the hash and
 * pushes nothing (the cards in Wallet already match), "unchanged" does nothing, "changed" starts a
 * refresh of the living pets that counts art and colors too. Exported for the check script.
 */
export async function runBootRefresh(ctx: AppContext, reason = "boot"): Promise<"first-boot" | "unchanged" | "changed" | "busy"> {
  const outcome = await claimTemplateChange(ctx);
  if (outcome === "first-boot") {
    logger.info("boot pass refresh: first boot with a template hash, stored it, pushing nothing");
    return outcome;
  }
  if (outcome === "unchanged") {
    logger.info("boot pass refresh: template unchanged, pushing nothing");
    return outcome;
  }
  const started = await refreshAllPasses(ctx, reason, { mode: "bundle" });
  logger.info({ started }, "boot pass refresh: template changed, refreshing changed cards");
  return started ? "changed" : "busy";
}

export function startPassRefreshEngine(ctx: AppContext): { stop: () => void } {
  const minutes = config.PASS_REFRESH_MINUTES;
  if (minutes <= 0) {
    logger.info("pass refresh engine disabled (PASS_REFRESH_MINUTES=0)");
    return { stop: () => undefined };
  }
  void warmPassFieldMemory(ctx).catch(() => undefined);
  let stopped = false;
  const bootRun = async () => {
    const verified = await waitForVerifiedHeadcount(ctx);
    if (stopped) return;
    if (!verified) logger.warn({ waitedMs: BOOT_HEADCOUNT_MAX_WAIT_MS }, "boot pass refresh: headcount still unverified, running with last known values");
    await runBootRefresh(ctx, verified ? "boot" : "boot-unverified").catch((err) =>
      logger.error({ err: String(err) }, "boot pass refresh failed"),
    );
  };
  const boot = setTimeout(() => void bootRun(), Math.max(0, config.PASS_REFRESH_BOOT_DELAY_SECONDS) * 1000);
  const timer = setInterval(
    () =>
      void refreshAllPasses(ctx, "scheduled", { mode: "background" }).catch((err) =>
        logger.error({ err: String(err) }, "scheduled pass refresh failed to start"),
      ),
    minutes * 60_000,
  );
  boot.unref?.();
  timer.unref?.();
  logger.info({ everyMinutes: minutes, bootDelaySeconds: config.PASS_REFRESH_BOOT_DELAY_SECONDS }, "pass refresh engine started");
  return {
    stop: () => {
      stopped = true;
      clearTimeout(boot);
      clearInterval(timer);
    },
  };
}
