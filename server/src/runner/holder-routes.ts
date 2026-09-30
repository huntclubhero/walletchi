import { Router } from "express";
import { isAddress, getAddress } from "viem";
import { config } from "../config.js";
import { logger } from "../logger.js";
import type { AppContext } from "../context.js";
import { wrap } from "../util/async-handler.js";

// TAX ECONOMY holder-airdrop API. Read-only proof lookup only. Holder rewards are
// AIRDROPPED by the 2h push engine (pushHolderRewards walks every posted leaf and
// pays it, gaslessly), so there is no claim surface here: NO CLAIM, ALWAYS AIRDROPS
// (Hunt's ruling 2026-08-31, the last claim surface in the product retired). The
// POST /claim relay that used to live here answers 410; the GET stays because a
// holder may still want to see what is coming, and the proof it returns is the
// public escape hatch to self-claim on-chain if our relayer is ever down.
//
// Response contract:
//   GET  /api/holder-rewards/:address
//     200 { holderRewardsLive, token, tokenDecimals, rounds: [{ roundId, amount, proof, claimed }] }
//   Degrades to { holderRewardsLive: false, ... } when the pipeline is dark, and an
//   invalid address is a 400: never a 500 for a malformed public request.
export function holderRouter(ctx: AppContext): Router {
  const router = Router();

  router.get(
    "/api/holder-rewards/:address",
    wrap(async (req, res) => {
      const raw = String(req.params.address ?? "");
      if (!isAddress(raw)) return res.status(400).json({ error: "invalid address" });
      if (!config.modes.holderRewardsLive) {
        return res.json({ holderRewardsLive: false, token: null, tokenDecimals: null, rounds: [] });
      }
      const account = getAddress(raw);
      const leaves = await ctx.store.holderLeavesForAccount(account);
      const claimedFlags = await Promise.all(
        leaves.map((l) =>
          ctx.relayer.holderClaimed(l.roundId, l.account).catch((err) => {
            // Fail toward "unclaimed": showing a claimable row twice is harmless
            // (the contract rejects a double claim); hiding one strands money.
            logger.warn({ err: String(err), roundId: l.roundId }, "holder claimed read failed");
            return false;
          }),
        ),
      );
      return res.json({
        holderRewardsLive: true,
        token: config.FEE_TOKEN_ADDRESS,
        tokenDecimals: config.FEE_TOKEN_DECIMALS,
        // MED-4: return the PROOF so a holder can self-claim on-chain even if our
        // relayer is down or dry (the contract's "claimable forever" then holds
        // without depending on us). The proof is public data anyway.
        rounds: leaves.map((l, i) => ({
          roundId: l.roundId,
          amount: l.amount,
          proof: JSON.parse(l.proof) as string[],
          claimed: claimedFlags[i]!,
        })),
      });
    }),
  );

  // NO CLAIM, ALWAYS AIRDROPS (Hunt's ruling 2026-08-31, season-2 no-claims law).
  // The holder airdrop is DELIVERED by the 2h push engine (pushHolderRewards walks
  // every posted leaf and pays it, gaslessly, leaf by leaf), so a holder never asks
  // for anything. This user-facing relay is the last claim surface in the product
  // and it is retired: it answers 410 and never touches the chain. The underlying
  // contract claim() stays (it is what the push bot calls to deliver, and it stays
  // the public escape hatch a holder can call themselves with the GET proof if our
  // relayer is ever down), but WE offer no claim button.
  router.post("/api/holder-rewards/:address/claim", (_req, res) => {
    res.status(410).json({
      error: "holder rewards are airdropped to you automatically now; there is nothing to claim",
      code: "rewards_pushed",
    });
  });

  return router;
}
