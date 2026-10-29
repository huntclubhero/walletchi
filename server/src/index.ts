import { config, stubMatrix } from "./config.js";
import { logger } from "./logger.js";
import { getPrisma, PrismaStore } from "./store/prisma.js";
import { createRelayer } from "./chain/relayer.js";
import { createApp } from "./app.js";
import type { AppContext } from "./context.js";
import { startIdleEngine } from "./runner/idle.js";
import { startPassRefreshEngine } from "./runner/pass-refresh.js";
import { startSeasonEngine } from "./runner/deathwatch.js";
import { quietZoneResolves } from "./runner/quiet.js";
import { reapStuckMints, recoverInFlightMints } from "./runner/fulfillment.js";
import { startOpenSeaSweep } from "./runner/opensea.js";
import { startRewardsPushEngine } from "./runner/push-rewards.js";
import { runFeeDistribution, verifyHolderPoster } from "./runner/tax-rewards.js";
import { verifyLaunchpadCollector } from "./runner/launchpad-inlet.js";
import { getRunnerGoogle } from "./runner/google.js";

// Process-level backstops: LOG and CONTINUE. The per-route wrap() helper routes
// async handler rejections into the error middleware, and these catch anything
// that still escapes (background intervals, fire-and-forget pushes), so a DB or
// RPC blip can never take the live API down. Deliberately no process.exit here.
process.on("unhandledRejection", (reason) => {
  logger.error(
    { err: String(reason), stack: (reason as Error)?.stack },
    "unhandledRejection (continuing)",
  );
});
process.on("uncaughtException", (err) => {
  logger.error({ err: String(err), stack: err.stack }, "uncaughtException (continuing)");
});

// ROBINHOOD_NETWORK vs the ACTUAL chain behind ROBINHOOD_RPC_URL.
//
// These two can desync silently. ROBINHOOD_NETWORK picks the chainId/explorer literals, but
// ROBINHOOD_RPC_URL independently overrides the endpoint we actually talk to (config.ts), so
// "testnet" pointed at a mainnet RPC (or the reverse) is one dashboard paste away. Everything
// downstream would then be quietly wrong: the gas-sponsorship webhook rejects on a chainId
// mismatch, explorer links point at the wrong chain, and any write lands somewhere nobody
// intended. Ask the RPC what chain it actually is and compare.
//
// NEVER BLOCKS BOOT ON A NETWORK BLIP: an unreachable or unparseable RPC is a WARN and we
// carry on, because a cold RPC must not take the API down. Only a DEFINITE disagreement acts,
// and only mainnet exits (there the writes are irreversible); elsewhere it is a loud ERROR.
async function verifyRpcChainId(): Promise<void> {
  const expected = config.robinhood.chainId;
  const url = config.robinhood.rpcUrl;
  let actual: number;
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "eth_chainId", params: [] }),
      signal: AbortSignal.timeout(10_000),
    });
    const json = (await res.json()) as { result?: string };
    if (!json.result) throw new Error(`no result in eth_chainId response`);
    actual = Number(BigInt(json.result));
  } catch (err) {
    logger.warn(
      { err: String(err), rpcUrl: url, expectedChainId: expected },
      "could not read eth_chainId from the configured RPC; skipping the network/RPC match check",
    );
    return;
  }
  if (actual === expected) {
    logger.info({ chainId: actual, network: config.ROBINHOOD_NETWORK }, "RPC chain id matches ROBINHOOD_NETWORK");
    return;
  }
  const msg =
    `ROBINHOOD_NETWORK=${config.ROBINHOOD_NETWORK} expects chainId ${expected}, but the configured ` +
    `RPC (${url}) reports chainId ${actual}. ROBINHOOD_RPC_URL overrides the endpoint independently ` +
    `of ROBINHOOD_NETWORK, so these have drifted apart. Fix one of them.`;
  if (config.ROBINHOOD_NETWORK === "mainnet") {
    logger.fatal({ expectedChainId: expected, actualChainId: actual, rpcUrl: url }, `[BOOT GUARD] ${msg}`);
    process.exit(1);
  }
  logger.error({ expectedChainId: expected, actualChainId: actual, rpcUrl: url }, `[BOOT GUARD] ${msg}`);
}

// Live testnet season 2026-08-22 (hardened): PetVault 0x925237758Fc63916E58e3c679681EE17d490b4d3.
async function main() {
  // Fail loudly if Postgres is unreachable. No silent degradation.
  const prisma = getPrisma();
  const store = new PrismaStore(prisma);
  try {
    await store.ping();
    logger.info("database connection ok");
  } catch (err) {
    logger.fatal(
      { err: String(err) },
      "cannot reach Postgres via DATABASE_URL. Start Postgres (see README docker one-liner) and run `npm run prisma:migrate`.",
    );
    process.exit(1);
  }

  // Quiet hours resolve in QUIET_TZ. If this runtime has no ICU data for the
  // configured zone the window silently falls back to SERVER local (UTC in a
  // container), which is the exact bug this config exists to kill, so say so out
  // loud. Deliberately NOT fatal: a misaligned flavour window is cosmetic, while
  // refusing to boot over it would stop the care engine and kill every pet.
  if (!quietZoneResolves(config.QUIET_TZ)) {
    logger.error(
      { quietTz: config.QUIET_TZ },
      "QUIET_TZ does not resolve on this runtime (missing ICU data or a typo). Quiet hours have FALLEN BACK to server-local time and will fire at the wrong hours. Fade warnings are unaffected: they ignore quiet hours by design.",
    );
  } else {
    logger.info(
      {
        quietTz: config.QUIET_TZ,
        window: `${config.IDLE_QUIET_START_HOUR}:00-${config.IDLE_QUIET_END_HOUR}:00`,
      },
      "quiet hours resolved",
    );
  }

  const relayer = createRelayer();
  // Before we serve anything: confirm the RPC we will be writing to is the chain we think it is.
  await verifyRpcChainId();
  const ctx: AppContext = { store, relayer };

  const app = createApp(ctx);

  // MINT RECOVERY (launch fix 1), BEFORE the reaper and before we listen. A
  // restart mid-burst leaves rows at "minting" whose transactions are already on
  // the chain or in its mempool: their keepers must get their pets, not a
  // "mint did not complete" and a released inbox claim that would let them mint
  // a second one. Every such row is re-attached to its persisted transaction (or
  // failed on the spot when none was ever signed). Awaited only for the DB
  // classification; the chain settlement runs in the background. Never throws.
  await recoverInFlightMints(ctx).catch((err) =>
    logger.error({ err: String(err) }, "mint recovery failed (the reaper will sweep by age)"),
  );

  // STUCK-MINT REAPER. The failure path releases both anti-Sybil claims when a
  // mint fails, but only if the process is alive to run it. A process death
  // mid-mint (deploy, restart, OOM) leaves the row at status "minting" holding
  // the inbox AND the verified identity forever: that keeper owns no pet and gets
  // "already_minted" on every retry, for a reason they cannot see or fix. Since
  // launch fix 1 the recovery above handles a restart precisely; this is the
  // age-based backstop for whatever it could not classify, and it skips every
  // row this process is actively driving. Swept ONCE AT BOOT and then on an
  // interval. Wired here rather than inside the idle engine to avoid an idle ->
  // fulfillment -> claim -> idle import cycle. Never throws: reapStuckMints owns
  // its error handling.
  void reapStuckMints(ctx);
  const stuckMintSweep = setInterval(
    () => void reapStuckMints(ctx),
    Math.max(1, config.MINT_STUCK_MINUTES) * 60_000,
  );
  stuckMintSweep.unref?.();

  // WALLETCHI idle engine: needs decay + death/critical bookkeeping between visits.
  const idleEngine = startIdleEngine(ctx);
  // Keeps every living pet's Wallet card current: after each boot and then on an interval.
  const passRefreshEngine = startPassRefreshEngine(ctx);
  // WALLETCHI season engine: timer-sweep drama poller (death-feed/milestones/
  // victory) + the finalize poke. No-op until survivalLive (SURVIVAL_ENABLED +
  // vault + relayer key).
  const seasonEngine = startSeasonEngine(ctx);
  // OpenSea metadata-refresh sweep (no-op without OPENSEA_API_KEY + PET721_ADDRESS).
  const openseaSweep = startOpenSeaSweep(ctx);
  // SEASON 2, NO CLAIMS: the 2h reward push. Pays every pet that earned an epoch,
  // forfeits dead pets' shares to the survivors, delivers the holder airdrops
  // nobody asked for, and retries any escrowed prize. Each leg is separately
  // gated (rewardsLive / holderRewardsLive / survivalLive) and the engine is a
  // no-op only when all three are dark. Every call it makes is permissionless, so
  // this timer is a convenience and never a chokepoint: if we are down, anyone can
  // run the same pushes and nothing is stranded.
  const rewardsPushEngine = startRewardsPushEngine(ctx);

  // TAX ECONOMY fee distribution: 4x/day (default) splitter poke + holder
  // airdrop round. No-op until holderRewardsLive. One catch-up run shortly after
  // boot so a redeploy never delays a due distribution by a full interval.
  const taxTimer = setInterval(
    () => void runFeeDistribution(ctx).catch((err) =>
      logger.error({ err: String(err) }, "fee distribution cycle failed"),
    ),
    config.TAX_DISTRIBUTION_MINUTES * 60_000,
  );
  const taxBootTimer = setTimeout(
    () => void runFeeDistribution(ctx).catch((err) =>
      logger.error({ err: String(err) }, "fee distribution boot run failed"),
    ),
    60_000,
  );
  if (config.modes.holderRewardsLive) {
    logger.info(
      {
        everyMinutes: config.TAX_DISTRIBUTION_MINUTES,
        splitter: config.FEE_SPLITTER_ADDRESS,
        roundPosting: config.modes.holderPostingLive ? "LIVE" : "DARK (no usable poster key)",
        holderPoster: config.holderPosterAddress ?? "(none)",
        // The INLET, named here because every other number on this line can look healthy while
        // this one is off and the splitter receives nothing at all.
        creatorFeeInlet: config.modes.launchpadInletLive
          ? "LIVE"
          : "DARK (nothing claims the launchpad creator-fee stream)",
        // Which claim shape the inlet will use. Printed at boot so the transaction count an operator
        // should expect per cycle (one, not two) is never a surprise.
        creatorFeeClaimPath: config.modes.launchpadClaimToSplitter
          ? "claim-to-splitter (one tx, collector never holds revenue)"
          : "claim-then-forward (two tx, LAUNCHPAD_HOOK_CLAIM_TO_FN is empty)",
        launchpadHook: config.LAUNCHPAD_HOOK_ADDRESS ?? "(none)",
        careFeeCollector: config.careFeeCollectorAddress ?? "(none)",
      },
      "tax-economy fee distribution scheduled",
    );
  }
  // BOOT ASSERTION (mainnet blocker B2): the poster key we hold must BE the vault's poster, or
  // every round reverts NotPoster. Awaited before listen so the verdict is on /internal/status
  // from the first request, and it lands well before the 60s boot catch-up run below. Same
  // posture as verifyRpcChainId: it NEVER blocks boot (an RPC blip is not a verdict, and a
  // rewards-leg misconfiguration must not take mint, care and claims down with it) but a definite
  // mismatch is a loud error that also disables posting so no gas is burned on a certain revert.
  // The .catch is the belt to the check's own braces: this is a diagnostic, and no diagnostic is
  // ever allowed to be the reason the API does not come up.
  await verifyHolderPoster(ctx).catch((err) =>
    logger.error({ err: String(err) }, "holder poster boot check failed (continuing)"),
  );
  // BOOT ASSERTION: does the launchpad hook agree that OUR collector holds the creator seat? This
  // is the source of every dollar the splitter distributes, and a seat we do not hold produces
  // silence rather than errors downstream (empty distributions read exactly like a quiet market).
  // Same posture as the two checks above: a no-op when the inlet is unconfigured, a warn on an
  // unreadable RPC, and a loud error naming both addresses on a definite mismatch. It NEVER blocks
  // boot, and the .catch is the belt to its own braces.
  await verifyLaunchpadCollector(ctx).catch((err) =>
    logger.error({ err: String(err) }, "launchpad collector boot check failed (continuing)"),
  );

  // Google Wallet REST probe: one boot-time check that says LOUDLY whether the
  // configured issuer id is usable by the Wallet API (a misconfigured id
  // otherwise fails silently inside best-effort catches forever). Result also
  // lands on /internal/status.
  if (getRunnerGoogle().live) {
    void getRunnerGoogle()
      .probe()
      .catch((err) => logger.error({ err: String(err) }, "google boot probe failed"));
  }

  const server = app.listen(config.PORT, () => {
    logger.info(
      { port: config.PORT, modes: stubMatrix() },
      `WALLETCHI server listening on :${config.PORT}`,
    );
  });

  const shutdown = async (sig: string) => {
    logger.info({ sig }, "shutting down");
    idleEngine.stop();
    passRefreshEngine.stop();
    seasonEngine.stop();
    openseaSweep.stop();
    rewardsPushEngine.stop();
    clearInterval(taxTimer);
    clearTimeout(taxBootTimer);
    server.close();
    await prisma.$disconnect();
    process.exit(0);
  };
  process.on("SIGINT", () => void shutdown("SIGINT"));
  process.on("SIGTERM", () => void shutdown("SIGTERM"));
}

main().catch((err) => {
  logger.fatal({ err: String(err), stack: (err as Error).stack }, "fatal boot error");
  process.exit(1);
});
