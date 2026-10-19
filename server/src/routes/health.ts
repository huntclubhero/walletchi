import { Router, type Request, type Response } from "express";
import { timingSafeEqual } from "node:crypto";
import { config, stubMatrix } from "../config.js";
import { mintsAdmitted } from "../runner/mint-budget.js";
import type { AppContext } from "../context.js";
import { wrap } from "../util/async-handler.js";
import {
  getRunnerGoogle,
  getGoogleProbe,
  getGoogleBackfill,
  getWalletCallbacks,
} from "../runner/google.js";
import { getCareMetrics } from "../runner/care-metrics.js";
import { getHolderRoundHealth } from "../runner/tax-rewards.js";
import { getLaunchpadInletHealth } from "../runner/launchpad-inlet.js";
import { announceSeasonStart } from "../runner/season-start.js";
import { refreshAllPasses, passRefreshState } from "../runner/pass-refresh.js";
import {
  announcementTextError,
  startAnnouncement,
  announceState,
  activeAnnouncement,
  clearAnnouncement,
} from "../runner/announce.js";
import { logger } from "../logger.js";


export function healthRouter(ctx: AppContext): Router {
  const r = Router();

  // Shared bearer gate for every /internal route. Absent token env => 404
  // (feature off) so none of them are discoverable in the demo.
  const authInternal = (req: Request, res: Response): boolean => {
    const expected = config.INTERNAL_STATUS_TOKEN;
    if (!expected) {
      res.status(404).end();
      return false;
    }
    const got = /^Bearer\s+(.+)$/i.exec(req.headers.authorization ?? "")?.[1]?.trim() ?? "";
    // Constant-time compare, parity with the HMAC/cap paths.
    let ok = got.length === expected.length;
    try {
      ok = ok && timingSafeEqual(Buffer.from(got), Buffer.from(expected));
    } catch {
      ok = false;
    }
    if (!ok) {
      res.status(401).end();
      return false;
    }
    return true;
  };

  // RE-ANNOUNCE THE SEASON START to every keeper's wallet card.
  //
  // Exists because the announcement can be MISSED: the season starts exactly once,
  // and if that instant falls in a gap (a deploy landing seconds later, a push
  // outage, a keeper whose device registered afterwards) there is no second
  // chance and the colony's clocks run in silence. Idempotent by nature: it only
  // re-pushes a card the keeper already holds, so the worst case is a duplicate
  // notification, which is strictly better than a keeper never learning their pet
  // is on a one-day clock.
  r.post("/internal/season/announce", wrap(async (req, res) => {
    if (!authInternal(req, res)) return;
    await announceSeasonStart(ctx);
    res.json({ ok: true });
  }));

  // SILENT REFRESH OF EVERY LIVING PET'S CARD (2026-10-15). Installed passes only change when the
  // server pushes them, so a change to pass layout (here: removing the reverted "Care for everything"
  // link) otherwise reaches each card only on that pet's next organic push, which can be hours.
  // This walks every living minted pet and calls pushRunnerPass WITHOUT a message: an empty APNs
  // background push (the device fetches the current pass) plus a Google object patch. No banner, no
  // notification (the status line is unchanged, and banners only ever fire for reminder lines).
  // Fire-and-forget, sequential and paced so APNs and the Google API are not hit in a burst; one run
  // at a time; progress on GET.
  r.post("/internal/passes/refresh", wrap(async (req, res) => {
    if (!authInternal(req, res)) return;
    // Shared with the scheduled engine (runner/pass-refresh.ts), which also moves the pass epoch so
    // the pinged phones actually re-download instead of being told "nothing new".
    // ?memorials=1 also re-sends memorial cards, once (only when a launch changes them).
    // ?news=1 also sends NEWS_TEXT to Google cards as a notifying message (Apple banners come from the field).
    const memorials = req.query.memorials === "1";
    // ?album=1 also sends the photo album announcement to Google cards that have the album.
    const news = req.query.news === "1";
    const album = req.query.album === "1";
    const started = await refreshAllPasses(ctx, ["manual", memorials ? "memorials" : "", news ? "news" : "", album ? "album" : ""].filter(Boolean).join("+"), { memorials, news, album });
    if (!started) return res.status(409).json({ error: "already running", ...passRefreshState() });
    res.status(202).json(passRefreshState());
  }));
  r.get("/internal/passes/refresh", wrap(async (req, res) => {
    if (!authInternal(req, res)) return;
    res.json(passRefreshState());
  }));

  // ONE-TIME ANNOUNCEMENT ON THE EVENT LINE (runner/announce.ts). No field is ever added: the
  // existing event line CHANGES to the text and carries changeMessage "%@" while it shows it.
  // Body: { text, serials?: string[], all?: boolean, dryRun?: boolean }. Exactly one of serials or
  // all. dryRun counts the targets and changes nothing. DELETE clears the active announcement.
  r.post("/internal/announce", wrap(async (req, res) => {
    if (!authInternal(req, res)) return;
    const body = (req.body ?? {}) as { text?: unknown; serials?: unknown; all?: unknown; dryRun?: unknown };
    const textError = announcementTextError(body.text);
    if (textError) return res.status(400).json({ error: textError });
    const all = body.all === true;
    const serials = body.serials;
    const serialsOk =
      Array.isArray(serials) &&
      serials.length > 0 &&
      serials.length <= 10_000 &&
      serials.every((s) => typeof s === "string" && s.length > 0 && s.length <= 128);
    if (all === serialsOk || (serials !== undefined && !serialsOk)) {
      return res.status(400).json({ error: "send exactly one of serials (non-empty string array) or all: true" });
    }
    const result = await startAnnouncement(ctx, {
      text: body.text as string,
      ...(all ? { all: true } : { serials: serials as string[] }),
      dryRun: body.dryRun === true,
    });
    if (result.kind === "busy") return res.status(409).json({ error: "already running", ...announceState() });
    if (result.kind === "dry") return res.json({ dryRun: true, total: result.total, wouldAnnounce: result.wouldAnnounce, wouldSkip: result.wouldSkip });
    res.status(202).json(announceState());
  }));
  r.get("/internal/announce", wrap(async (req, res) => {
    if (!authInternal(req, res)) return;
    res.json({ active: await activeAnnouncement(ctx), ...announceState() });
  }));
  r.delete("/internal/announce", wrap(async (req, res) => {
    if (!authInternal(req, res)) return;
    await clearAnnouncement(ctx);
    res.json({ active: null, ...announceState() });
  }));

  // Public liveness ONLY: non-sensitive. The detailed stub/mode matrix (relayer,
  // payment-bypass, wallet, auth state) is operational security state and must
  // never be published here, so the public health response cannot be used as a
  // deployment/attack map. Detailed readiness lives on the authenticated
  // /internal/status route.
  r.get("/health", wrap(async (_req, res) => {
    let dbOk = true;
    try {
      await ctx.store.ping();
    } catch {
      dbOk = false;
    }
    res.json({
      status: dbOk ? "ok" : "degraded",
      // Which build is live. Render injects RENDER_GIT_COMMIT at build time; this
      // is benign liveness metadata (a private-repo short SHA reveals nothing
      // exploitable) that makes "did the deploy actually swap?" verifiable
      // without a version guess. Falls back to "dev" off-platform.
      version: (process.env.RENDER_GIT_COMMIT ?? "dev").slice(0, 7),
      network: config.ROBINHOOD_NETWORK,
      chainId: config.robinhood.chainId,
      time: new Date().toISOString(),
    });
  }));

  // Authenticated internal readiness: full dependency + mode matrix, gated by a
  // bearer that is separate from any user-facing secret. Absent token env => 404
  // (feature off) so it is not even discoverable in the demo.
  r.get("/internal/status", wrap(async (req, res) => {
    if (!authInternal(req, res)) return;
    let db = "ok";
    try {
      await ctx.store.ping();
    } catch (err) {
      db = `error: ${String(err)}`;
    }
    // Relayer gas health: on mainnet a dry relayer silently stalls every care
    // and mint write, so surface the number + a low flag the heartbeat can read.
    let relayerHealth: Record<string, unknown> = { address: ctx.relayer.address };
    try {
      const wei = await ctx.relayer.relayerBalanceWei();
      const eth = Number(wei) / 1e18;
      relayerHealth = {
        address: ctx.relayer.address,
        balanceEth: Number(eth.toFixed(6)),
        low: eth < config.RELAYER_LOW_BALANCE_ETH,
        lowThresholdEth: config.RELAYER_LOW_BALANCE_ETH,
        pendingWrites: ctx.relayer.pending,
        // Launch fix 1 + 2: the mint pipeline's shape. Admitted counts against the hourly
        // budget at checkout; unmined is what the receipt watcher is still waiting on.
        mintsAdmitted: mintsAdmitted(),
        mintsInFlight: ctx.relayer.mintsInFlight,
        unminedWrites: ctx.relayer.unminedWrites,
      };
    } catch (err) {
      relayerHealth = { address: ctx.relayer.address, error: String(err).slice(0, 200) };
    }
    // HOLDER ROUND HEALTH (mainnet blocker B2). Round posting is signed by a SEPARATE poster key
    // and gated on-chain by poster(), the per-round cap and the pause flag, and every one of those
    // fails as a silent revert inside a 4x/day background job. This block is the signal that
    // failure mode never had: is a poster key configured, does it match the chain, is the cap
    // armed, when did a round last land, and what did the last attempt say.
    const holderRounds: Record<string, unknown> = {
      ...getHolderRoundHealth(),
      // Poster-signed writes queue on their own FIFO (a different account, a different nonce
      // sequence), so it gets its own depth rather than hiding inside the relayer's.
      pendingPosterWrites: ctx.relayer.posterPending,
      holderVault: config.HOLDER_VAULT_ADDRESS ?? null,
    };
    // A DEDICATED signer has its own gas tank, and a fresh poster key starts empty. An unfunded
    // poster stalls every round for a reason no key check can explain, so publish the number
    // beside the same low-balance threshold the relayer uses.
    if (config.holderPosterAddress) {
      try {
        const posterWei = await ctx.relayer.holderPosterBalanceWei();
        const posterEth = Number(posterWei) / 1e18;
        holderRounds.posterBalanceEth = Number(posterEth.toFixed(6));
        holderRounds.posterGasLow = posterEth < config.RELAYER_LOW_BALANCE_ETH;
      } catch (err) {
        holderRounds.posterBalanceError = String(err).slice(0, 200);
      }
    }
    // LAUNCHPAD CREATOR-FEE INLET. The SOURCE of everything the splitter distributes. Its failure
    // mode is the nastiest in the pipeline because it is INVISIBLE downstream: with no inlet, the
    // splitter is empty, distribute() returns (0,0) without reverting, the holder job reports
    // "nothing unreserved to distribute", and the whole system looks like a healthy season with no
    // trading. This block is the difference between that and knowing nobody is claiming.
    // The spread carries the WHOLE pool config the inlet last read (onChainCreator, onChainQuote,
    // quoteMatchesFeeToken, poolExists, poolCreatorFeeBps, poolFeeRate) plus the claimPath, so the
    // three things the inlet refuses to send without are all answerable from this one block.
    const launchpadInlet: Record<string, unknown> = {
      ...getLaunchpadInletHealth(),
      // Collector-signed writes queue on their own FIFO (a third account, a third nonce sequence).
      pendingCollectorWrites: ctx.relayer.collectorPending,
      splitter: config.FEE_SPLITTER_ADDRESS ?? null,
      // Served alongside onChainQuote so the quote comparison can be checked by eye rather than
      // taken on trust from quoteMatchesFeeToken.
      feeToken: config.FEE_TOKEN_ADDRESS ?? null,
      feeTokenDecimals: config.FEE_TOKEN_DECIMALS,
    };
    // The collector is a THIRD dedicated signer, so it is a third gas tank that nobody tops up by
    // habit. An unfunded collector claims nothing, for a reason no seat check would ever surface.
    if (config.careFeeCollectorAddress) {
      try {
        const collectorWei = await ctx.relayer.careFeeCollectorBalanceWei();
        const collectorEth = Number(collectorWei) / 1e18;
        launchpadInlet.collectorBalanceEth = Number(collectorEth.toFixed(6));
        launchpadInlet.collectorGasLow = collectorEth < config.RELAYER_LOW_BALANCE_ETH;
      } catch (err) {
        launchpadInlet.collectorBalanceError = String(err).slice(0, 200);
      }
    }
    res.json({
      status: db === "ok" ? "ok" : "degraded",
      db,
      network: config.ROBINHOOD_NETWORK,
      chainId: config.robinhood.chainId,
      relayer: ctx.relayer.live ? "live" : "stub",
      relayerHealth,
      holderRounds,
      launchpadInlet,
      modes: stubMatrix(),
      google: {
        mode: getRunnerGoogle().live ? "live" : "stub",
        probe: getGoogleProbe(),
        backfill: getGoogleBackfill(),
        callbacks: getWalletCallbacks(),
      },
      // Care engagement by wallet source since last restart (apple / google /
      // untagged): the "did Android recover?" pulse.
      care: getCareMetrics(),
      time: new Date().toISOString(),
    });
  }));

  // On-demand REST probe: run it right after changing GOOGLE_ISSUER_ID and the
  // response says immediately whether the Wallet API accepts the config.
  r.post("/internal/google/probe", wrap(async (req, res) => {
    if (!authInternal(req, res)) return;
    res.json(await getRunnerGoogle().probe());
  }));

  // One-shot object backfill (run AFTER the issuer id is fixed): upserts every
  // minted pet's loyalty object so the whole population becomes patchable.
  // Fire-and-forget; poll /internal/status google.backfill for progress.
  r.post("/internal/google/backfill", wrap(async (req, res) => {
    if (!authInternal(req, res)) return;
    const runners = await ctx.store.allMintedRunners();
    const result = getRunnerGoogle().startBackfill(runners);
    res.status(result.started ? 202 : 409).json({ ...result, total: runners.length });
  }));

  // On-demand fee distribution: poke the splitter + post a holder round NOW instead of waiting for
  // the 4x/day timer. Used to make the tax-economy reward streams visible during testnet testing
  // (a fee-drip loop mints USDG to the splitter, then hits this). No-op unless holderRewardsLive.
  r.post("/internal/tax/distribute", wrap(async (req, res) => {
    if (!authInternal(req, res)) return;
    const { runFeeDistribution } = await import("../runner/tax-rewards.js");
    const result = await runFeeDistribution(ctx);
    res.json(result);
  }));

  return r;
}
