import { Router } from "express";
import { z } from "zod";
import { config } from "../config.js";
import type { AppContext } from "../context.js";
import { wrap } from "../util/async-handler.js";
import { authInternal } from "../util/internal-auth.js";
import { ensurePrivyUserWithWallet } from "../services/privy.js";
import { adoptPet } from "../runner/adopt.js";
import { subjectTag } from "../runner/sybil.js";
import { StuckTxError } from "../chain/stuck-tx.js";
import { logger } from "../logger.js";

// INTERNAL GIFT MINT (A9, 2026-10-20). Until today an ops script (walletchi-ops/gift-mint.cjs)
// created the keeper's Privy user by hand and signed issuePet with the RELAYER KEY from a laptop.
// That second signer took nonce 4441 under the running API at 02:29Z, and the next rewards push
// failed "nonce too low" (epoch 321, five pets; one payout left the retry window). The rule now:
// NOTHING signs with the relayer key outside this process. This route is the same gift, done by
// the API's own queue and write pipeline.
//
// POST /internal/gift-mint  Bearer INTERNAL_STATUS_TOKEN  { email, dryRun?, allowSecond? }
//   400 bad_request            no usable email
//   401 / 404                  wrong token / token env unset (authInternal)
//   409 busy                   a mint for that email is already in flight here
//   409 already_has_pet        the embedded wallet already holds a pet (send allowSecond:true to gift another)
//   422 no_embedded_wallet     the Privy user exists but has no embedded wallet (external only)
//   503 unavailable            Privy stubbed or unreachable, the wallet's pets unreadable, or the mint could
//                              not be issued; after an issue attempt the body's `outcome` is "not_minted" or
//                              "unknown" (a stuck transaction may still mine: dry-run the email and read
//                              `pets` before any retry)
//   200 { dryRun:true, ... }   looked up only; creates no user, mints nothing; `pets` = the wallet's pets
//   201 { tokenId, txHash, tbaAddress, wallet, serial, privyUserCreated }
//
// Deliberately NOT gated by the site's supply cap or the sold-out state: a gift is the operator's
// call, exactly as the old script was; the issuer contract's own caps and budget still apply
// (a refusal there surfaces as 503 with the chain's message). The row is created right away
// through adoptPet with a fresh gate, so the keeper's My pets shows the pet on their first visit
// instead of waiting for the throttled adoption sweep. Logs carry the Privy subject HASH and the
// wallet, never the email.
const Body = z.object({
  email: z.string().trim().toLowerCase().min(3).max(254).regex(/^[^\s@]+@[^\s@]+\.[^\s@]+$/),
  dryRun: z.boolean().optional(),
  allowSecond: z.boolean().optional(),
});

const inFlight = new Set<string>();

// Every pet this wallet owns: the store's rows, plus any minted token the store has no row for
// (a gift whose adoption was skipped under the site-mint guard, or whose caller saw a 503 while
// the bytes still mined), judged on the chain itself: a FRESH minted count, then ownerOf for the
// few ids the store lacks. Never the cached season gate and never the throttled sweep: both can
// be a mint behind, which is exactly the pet this check exists to find. Throws when the chain
// cannot be read, so the caller refuses instead of minting on a guess.
async function petsOwnedBy(ctx: AppContext, wallet: string): Promise<string[]> {
  const rows = await ctx.store.allMintedRunners();
  const owned = new Set(rows.filter((r) => r.tokenId && r.ownerAddress?.toLowerCase() === wallet).map((r) => r.tokenId as string));
  const known = new Set(rows.map((r) => r.tokenId));
  const gate = await ctx.relayer.seasonGate();
  for (let id = 1; id <= gate.minted; id++) {
    const t = String(id);
    if (known.has(t)) continue;
    const owner = await ctx.relayer.petOwnerOf(t);
    if (owner.toLowerCase() === wallet) owned.add(t);
  }
  return [...owned].sort((a, b) => Number(a) - Number(b));
}

export function internalGiftRouter(ctx: AppContext): Router {
  const r = Router();
  r.post("/internal/gift-mint", wrap(async (req, res) => {
    if (!authInternal(req, res)) return;
    res.setHeader("Cache-Control", "no-store");
    const parsed = Body.safeParse(req.body ?? {});
    if (!parsed.success) return res.status(400).json({ code: "bad_request", error: "email required" });
    const { email, dryRun, allowSecond } = parsed.data;
    if (!config.modes.privyLive) return res.status(503).json({ code: "unavailable", error: "Privy is not configured" });
    if (inFlight.has(email)) return res.status(409).json({ code: "busy", error: "a gift mint for that email is already in flight" });
    inFlight.add(email);
    try {
      const who = await ensurePrivyUserWithWallet(email, { create: !dryRun });
      if (dryRun) {
        if (who.ok) {
          const pets = await petsOwnedBy(ctx, who.wallet).catch(() => null);
          if (pets === null) return res.status(503).json({ dryRun: true, code: "unavailable", error: "could not read the wallet's pets from the chain", wallet: who.wallet });
          return res.json({ dryRun: true, userExists: true, wouldCreateUser: false, wallet: who.wallet, pets });
        }
        if (who.code === "no_embedded_wallet") return res.status(422).json({ dryRun: true, code: who.code, error: who.error });
        // A lookup that worked and found nobody is the common dry-run answer; a lookup that
        // failed is not, and the two must not look alike.
        if (/no Privy user for that email/.test(who.error)) return res.json({ dryRun: true, userExists: false, wouldCreateUser: true, wallet: null, pets: [] });
        return res.status(503).json({ dryRun: true, code: "unavailable", error: who.error });
      }
      if (!who.ok) {
        const status = who.code === "no_embedded_wallet" ? 422 : 503;
        // privyUserCreated: true when Privy made the user but the answer cannot be minted into (the
        // seat is spent); "unknown" when the create itself threw (Privy may or may not have kept it).
        return res.status(status).json({ code: who.code, error: who.error, privyUserCreated: who.created ?? false });
      }
      // ONE GIFT PER WALLET BY DEFAULT. The failure modes that matter here (a 503 for a stuck
      // transaction that mined anyway, a dropped connection, a double-click) all end in the same
      // natural act: the operator runs it again. A wallet that already holds a pet is refused
      // unless the second pet is explicitly meant. A user created on this very call owns nothing.
      if (!allowSecond && !who.created) {
        const pets = await petsOwnedBy(ctx, who.wallet).catch(() => null);
        if (pets === null) return res.status(503).json({ code: "unavailable", error: "could not read the wallet's pets from the chain; nothing minted", wallet: who.wallet });
        if (pets.length > 0) return res.status(409).json({ code: "already_has_pet", error: "that wallet already holds a pet; send allowSecond:true to gift another", wallet: who.wallet, pets });
      }
      let issued: { tokenId: string; txHash: string; tbaAddress: string };
      try {
        issued = await ctx.relayer.issueRunner(who.wallet);
      } catch (err) {
        // A StuckTxError means the head exhausted its replacements: the bytes are still the node's
        // to mine, and they often do a moment later. "Nothing minted" is NOT knowable for that one,
        // so the body says `outcome: "unknown"` and the operator dry-runs before any retry. Every
        // other refusal (simulate, budget, queue full, a nonce taken by a stranger) happened before
        // anything reached the node or is a definite miss.
        const outcome = err instanceof StuckTxError ? "unknown" : "not_minted";
        logger.warn(
          { err: String(err), wallet: who.wallet, userHash: subjectTag(who.userId), outcome },
          outcome === "unknown" ? "internal gift mint: issue did not settle; the transaction may still mine" : "internal gift mint: issue failed (nothing minted)",
        );
        return res.status(503).json({ code: "unavailable", outcome, error: `mint failed: ${String(err)}`, privyUserCreated: who.created, wallet: who.wallet });
      }
      const runner = await adoptPet(ctx, issued.tokenId, { freshGate: true }).catch((err) => {
        logger.warn({ err: String(err), tokenId: issued.tokenId }, "internal gift mint: row not adopted yet (the sweep will)");
        return null;
      });
      logger.warn(
        { tokenId: issued.tokenId, txHash: issued.txHash, wallet: who.wallet, userHash: subjectTag(who.userId), privyUserCreated: who.created, serial: runner?.serial ?? null },
        "internal gift mint: pet issued through the API's relayer",
      );
      return res.status(201).json({
        tokenId: issued.tokenId,
        txHash: issued.txHash,
        tbaAddress: issued.tbaAddress,
        wallet: who.wallet,
        serial: runner?.serial ?? null,
        privyUserCreated: who.created,
      });
    } finally {
      inFlight.delete(email);
    }
  }));
  return r;
}
