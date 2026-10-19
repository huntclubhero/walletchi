import { config } from "../config.js";
import { logger } from "../logger.js";
import type { AppContext } from "../context.js";
import { pushRunnerPass } from "./idle.js";
import { albumEnabledFor, ALBUM_NOTICE } from "./album.js";
import { headcountVerified, refreshSeasonSnapshot } from "./season.js";
import { warmPassFieldMemory } from "./pass-memory.js";

// KEEPING EVERY CARD CURRENT.
//
// A Wallet card only changes when the phone re-downloads it, and the phone only re-downloads after
// (1) we ping it and (2) the server then reports the pass as changed. Until now "changed" meant the
// pet's database row moved, so anything that changes a card WITHOUT touching the row never reached
// it: a deploy that changes the card layout, a switch like GAME_SERIALS putting a Play button on a
// pass, or the live chain figures the card prints (the need bars, the CARE balance). The old bulk
// refresh pinged every phone, and every phone was told "nothing new".
//
// THE PASS EPOCH fixes that. It is the moment every card last counted as changed: the effective
// update time of a pass is the later of its row's updatedAt and the epoch. It starts at boot (a
// deploy or an env change restarts the service, so those always count) and moves forward each time
// refreshAllPasses runs, which then pings every living pet's phones so they fetch the new pass.
//
// It runs on its own ~90 s after boot (so a deploy or setting change lands on every card without
// anyone tapping anything) and then every PASS_REFRESH_MINUTES (the need bars and balance never
// drift far from the chain). Every ping is SILENT: no message, so no banner and no sound.
//
// A RESTART DOES NOT COUNT AS A CHANGE UNTIL THE BOOT REFRESH RUNS (2026-10-17). The epoch used to
// start at boot, so for the first minutes after every restart any phone that asked got a brand new
// pass built before the on-chain headcount was verified. Now the epoch starts at zero (passes are
// as new as their own row) and the boot refresh, which first waits for a verified headcount
// (waitForVerifiedHeadcount, bounded), is what moves it. With the engine disabled the epoch starts
// at boot exactly as before.

let passEpoch = new Date(0);
// Memorial cards never change on their own, so the regular epoch leaves them alone (otherwise every
// refresh re-sent them and they jumped back to the top of the keeper's Wallet). When a launch DOES
// change them (the game button on tombstones), a refresh run with { memorials: true } moves this
// separate epoch once, and their cards pick the change up exactly one time.
let memorialEpoch = new Date(0);

/** The update time Wallet should see for a pass: never earlier than the epoch that applies to it. */
export function effectiveUpdatedAt(updatedAt: Date, gone = false): Date {
  const epoch = gone ? memorialEpoch : passEpoch;
  return updatedAt > epoch ? updatedAt : epoch;
}

export function currentMemorialEpoch(): Date {
  return memorialEpoch;
}

export function currentPassEpoch(): Date {
  return passEpoch;
}

export interface PassRefreshState {
  running: boolean;
  total: number;
  done: number;
  failed: number;
  startedAt: string | null;
  reason: string | null;
}

let state: PassRefreshState = { running: false, total: 0, done: 0, failed: 0, startedAt: null, reason: null };

export function passRefreshState(): PassRefreshState {
  return state;
}

/** Spacing between pets, so APNs and the Google API never see a burst. */
const PACE_MS = 250;

/**
 * Move the epoch to now and silently ping every living pet's cards. One run at a time; returns false
 * (and changes nothing) when a run is already going. Fire-and-forget: progress is on passRefreshState().
 */
export async function refreshAllPasses(
  ctx: AppContext,
  reason: string,
  opts: { memorials?: boolean; news?: boolean; album?: boolean } = {},
): Promise<boolean> {
  if (state.running) return false;
  const runners = (await ctx.store.allMintedRunners()).filter((x) => x.status === "ready" && (opts.memorials || !x.gone));
  passEpoch = new Date();
  if (opts.memorials) memorialEpoch = passEpoch;
  state = { running: true, total: runners.length, done: 0, failed: 0, startedAt: passEpoch.toISOString(), reason };
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
        await pushRunnerPass(ctx, x.serial, message ? { message } : {});
      } catch {
        state.failed += 1;
      }
      state.done += 1;
      await new Promise((r) => setTimeout(r, PACE_MS));
    }
    state.running = false;
    logger.info({ ...state }, "silent pass refresh finished");
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

export function startPassRefreshEngine(ctx: AppContext): { stop: () => void } {
  const minutes = config.PASS_REFRESH_MINUTES;
  if (minutes <= 0) {
    // Nothing will move the epoch, so a restart counts as a change right away (the old behavior).
    passEpoch = new Date();
    logger.info("pass refresh engine disabled (PASS_REFRESH_MINUTES=0)");
    return { stop: () => undefined };
  }
  void warmPassFieldMemory(ctx).catch(() => undefined);
  const run = (reason: string) =>
    void refreshAllPasses(ctx, reason).catch((err) => logger.error({ err: String(err), reason }, "pass refresh failed to start"));
  let stopped = false;
  const bootRun = async () => {
    const verified = await waitForVerifiedHeadcount(ctx);
    if (stopped) return;
    if (!verified) logger.warn({ waitedMs: BOOT_HEADCOUNT_MAX_WAIT_MS }, "boot pass refresh: headcount still unverified, running with last known values");
    run(verified ? "boot" : "boot-unverified");
  };
  const boot = setTimeout(() => void bootRun(), Math.max(0, config.PASS_REFRESH_BOOT_DELAY_SECONDS) * 1000);
  const timer = setInterval(() => run("scheduled"), minutes * 60_000);
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
