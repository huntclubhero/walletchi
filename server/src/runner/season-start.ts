import { config } from "../config.js";
import { logger } from "../logger.js";
import type { AppContext } from "../context.js";

/**
 * THE SELLOUT START POKE.
 *
 * On a sellout season nothing may hatch or feed until someone calls startSeason(), and the call is
 * permissionless precisely so the season does not wait on a human being awake at the moment the
 * collection mints out.
 *
 * WHY IT IS CALLED FROM THE MINT PATH, not only the 45-minute idle cycle: the mint that sells the
 * last pet is the exact event that makes the season startable, and every keeper who just bought in
 * is looking at the site right then. Leaving it to the next tick would mean a sold-out collection
 * sitting frozen for up to three quarters of an hour with no way for anyone to tell whether it was
 * broken. The idle cycle keeps calling this as a BACKSTOP for the cases the mint path cannot cover
 * (a mint that lands while this process is restarting, a sellout reached by a direct on-chain mint
 * that never touched our API, an RPC blip on the first attempt).
 *
 * SAFE TO CALL AT ANY TIME, from anywhere. The vault re-verifies the sellout itself and rejects a
 * non-owner start before it, so the worst case for a mistimed poke is a revert that is swallowed
 * here: this can never start a season early, and losing the race to another caller is the ordinary
 * outcome rather than an error. Silent no-op on a clock season, an already-started season, or one
 * that is still minting.
 */
/**
 * TELL EVERY KEEPER THE RACE HAS BEGUN.
 *
 * The start is the single most time-critical moment in the season: every pet's
 * five clocks begin at that instant and a pet nobody feeds within one life
 * window is dead for good. Starting all of them in silence would mean a keeper's
 * first news of their own countdown is the fade warning with hours left, or
 * nothing at all. So the card is pushed with the message the moment it happens.
 *
 * QUIET HOURS ARE DELIBERATELY IGNORED, on the same rule as the fade warning: a
 * comfort feature must never eat a message the pet's survival depends on, and a
 * season that starts at 3am still costs a sleeping keeper the same hours. See
 * the quiet-hours law.
 *
 * Best effort per pet: one keeper's dead push token must never stop the rest of
 * the colony being told.
 */
export async function announceSeasonStart(ctx: AppContext): Promise<void> {
  // Dynamic import: idle.ts imports THIS module for the poke, so a static import
  // back into it would close a cycle (idle -> season-start -> idle).
  const { pushRunnerPass } = await import("./idle.js");
  let told = 0;
  try {
    const runners = await ctx.store.allMintedRunners();
    for (const r of runners) {
      if (r.gone) continue;
      try {
        // Touch the row first: Apple's list call reports a pass only when it changed since the
        // device's last fetch, so a bare push leaves the pre-season card in place (as me-routes).
        await ctx.store.updateRunner(r.serial, { lastPushAt: new Date() }).catch((err) =>
          logger.warn({ err: String(err), serial: r.serial }, "season-start touch failed (pushing anyway)"),
        );
        await pushRunnerPass(ctx, r.serial, {
          message: {
            header: "The season has begun",
            body: "Every pet woke at the same moment. Serve all five needs within a day or yours is gone for good.",
          },
        });
        told += 1;
      } catch (err) {
        logger.warn({ err: String(err), serial: r.serial }, "season-start push failed for one pet");
      }
    }
  } catch (err) {
    logger.error({ err: String(err) }, "season-start announcement failed");
  }
  logger.info({ told }, "season start announced to keepers");
}

export async function maybeStartSoldOutSeason(ctx: AppContext): Promise<void> {
  if (!config.modes.survivalLive) return;
  try {
    const gate = await ctx.relayer.seasonGate();
    if (!gate.selloutStartsSeason || gate.startedAt !== 0) return;
    if (gate.maxSupply === 0 || gate.minted < gate.maxSupply) return;
    logger.info(
      { minted: gate.minted, maxSupply: gate.maxSupply },
      "collection SOLD OUT: starting the season",
    );
    const { txHash } = await ctx.relayer.startSeason();
    logger.info({ txHash }, "season STARTED: every pet's clock begins together now");
    await announceSeasonStart(ctx);
  } catch (err) {
    logger.warn(
      { err: String(err) },
      "sellout season start poke did not land (idle cycle will retry)",
    );
  }
}
