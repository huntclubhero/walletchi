import { config } from "../config.js";
import type { AppContext } from "../context.js";
import type { CareSession, Runner } from "../store/types.js";
import { sessionVerdict } from "./session-care.js";

// THE UNARMED-PASS NUDGE (2026-09-23, tester Pretzel's pet No. 2).
//
// A pet whose one-tap arming never completed looks exactly like an armed one on the card: same
// buttons, same art. Every tap then opens the website, and a keeper who never goes back has no way
// to tell that one sign-in fixes it for good. So once a pet has been minted for a while and still
// has no working care session, its pass says so, on the back (Apple) and as the first text module
// (Google): tap any action to finish setup. The tap lands on the care page, which arms the pet the
// moment its owner is signed in (web-cub lib/arming.ts, sign-in mode).
//
// The grace period keeps it off the card during the minute mint-time arming normally takes. It
// disappears on the next pass refresh after arming succeeds: the session install bumps the runner and
// pushes the pass (me-routes.ts), so the If-Modified-Since check cannot serve the stale card.

export const SETUP_NUDGE_COPY = {
  label: "FINISH SETUP",
  value: "Tap any action to finish setup. After that, every button here works on its own.",
} as const;

/**
 * Should this pet's pass carry the setup nudge right now? Pure: the caller supplies the session row.
 * Only for a pet that COULD be armed and is not: silent care must be live on this deployment, the
 * pet minted, alive, not the champion, not held by the relayer (a custodial demo pet can never be
 * armed, so nudging it would send the keeper to a page that says so), and past the grace period.
 */
export function needsSetupNudge(
  runner: Runner,
  session: CareSession | null,
  opts: { now: Date; relayerAddress: string | null; graceMinutes: number },
): boolean {
  if (!config.modes.silentCareLive) return false;
  if (runner.status !== "ready" || !runner.tokenId || runner.gone || runner.won) return false;
  if (opts.relayerAddress && runner.ownerAddress.toLowerCase() === opts.relayerAddress.toLowerCase()) return false;
  if (opts.now.getTime() - runner.createdAt.getTime() < opts.graceMinutes * 60_000) return false;
  const verdict = sessionVerdict(session, {
    vaultAddress: config.PETVAULT_ADDRESS,
    ownerAddress: runner.ownerAddress,
    tokenId: runner.tokenId,
    now: opts.now,
  });
  return !verdict.ok;
}

/** needsSetupNudge with the session row read from the store. Best effort: a read error shows no nudge. */
export async function setupNudgeFor(ctx: AppContext, runner: Runner, now = new Date()): Promise<boolean> {
  try {
    const session = await ctx.store.getCareSession(runner.serial);
    return needsSetupNudge(runner, session, {
      now,
      relayerAddress: ctx.relayer.address ?? null,
      graceMinutes: config.SETUP_NUDGE_MINUTES,
    });
  } catch {
    return false;
  }
}
