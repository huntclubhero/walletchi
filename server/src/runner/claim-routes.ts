import { Router } from "express";
import { z } from "zod";
import { config } from "../config.js";
import { logger } from "../logger.js";
import type { AppContext } from "../context.js";
import type { Runner } from "../store/types.js";
import { runnerNumber } from "./theme.js";
import { runnerPassDownloadUrl } from "./pass.js";
import { getRunnerGoogle } from "./google.js";
import { sendRunnerReceiptEmail } from "./email.js";
import { getSeasonGate } from "./season.js";
import { clientIp } from "../util/client-ip.js";
import { wrap } from "../util/async-handler.js";
import {
  issueClaimNonce,
  isClaimNonceActive,
  consumeClaimNonce,
  extractNonce,
  recoverClaimSigner,
  petLiveStatus,
  isPetDead,
  isPlaceholderEmail,
  rotateRunnerAuth,
  claimRateHit,
  cachedPetOwnersOf,
  freshOwnerOf,
} from "./claim.js";

// WS2 secondary-market claim endpoints. The response contract is LOCKED to the
// site's built /claim page (SECONDARY-MARKET-REVISION.md):
//   200 single: { ok:true, serial, tokenId, runnerNumber, status, secondsLeft?,
//                 applePassUrl?, googleSaveUrl?, emailed? }
//   200 multi:  { ok:false, multiple:true, pets:[{tokenId, serial, runnerNumber, status}] }
//   4xx:        { error, code:"not_owner"|"not_found"|"dead_soulbound" }

const WalletClaim = z.object({
  method: z.literal("wallet"),
  address: z.string().regex(/^0x[0-9a-fA-F]{40}$/, "invalid EVM address"),
  signature: z.string().regex(/^0x[0-9a-fA-F]+$/, "invalid signature"),
  message: z.string().min(1).max(2000),
  tokenId: z.string().regex(/^[0-9]+$/).optional(),
  // The buyer's contact. A wallet claim unbinds the SELLER's email (see
  // rotateRunnerAuth), so without this the new owner has no receipt and no
  // email re-delivery if they lose the pass. Optional at the API so old
  // clients keep working; the claim page asks for it. NOT an anti-Sybil
  // gate: a claim is not a mint, and one person may own many pets.
  email: z.string().trim().email("invalid email").max(320).optional(),
});

const EmailClaim = z.object({
  method: z.literal("email"),
  email: z.string().email("invalid email"),
  tokenId: z.string().regex(/^[0-9]+$/, "invalid pet number"),
});

const ClaimBody = z.discriminatedUnion("method", [WalletClaim, EmailClaim]);

// The literal statement web-cub/src/lib/wallet.ts writes into the claim message. Kept here
// beside the verifier so the two can never drift apart silently: if the client copy changes
// without this one, claims start failing loudly instead of the check quietly going slack.
const CLAIM_STATEMENT = "I own WALLETCHI and I am claiming its wallet pass.";

type ClaimError = { status: number; error: string; code: string };
const notOwner = (error: string): ClaimError => ({ status: 403, error, code: "not_owner" });
const notFound = (error: string): ClaimError => ({ status: 404, error, code: "not_found" });
const deadSoulbound = (): ClaimError => ({
  status: 409,
  error:
    "This pet is a soulbound memorial. It has passed on, so it can be viewed forever but cannot be claimed for transfer.",
  code: "dead_soulbound",
});

// Per-IP fixed-window limiter for the claim endpoints only (separate buckets so
// nonce polling never eats the claim budget). 20/min is far above any legit
// claim flow; it exists to stop an email-bomb / nonce flood.
const limited =
  (bucket: string) =>
  (
    req: import("express").Request,
    res: import("express").Response,
    next: import("express").NextFunction,
  ) => {
    const retryAfter = claimRateHit(`${bucket}:${clientIp(req)}`);
    if (retryAfter !== null) {
      res.setHeader("Retry-After", String(retryAfter));
      return res.status(429).json({
        error: "Too many requests. Please try again in a minute.",
        code: "rate_limited",
      });
    }
    next();
  };

export function claimRouter(ctx: AppContext): Router {
  const r = Router();

  /** The sellout gate for receipt copy: pre-season the email must not tell a
   *  keeper to tap Feed, because the vault refuses every care until mint-out. */
  async function receiptSeasonPending(): Promise<{ minted: number; maxSupply: number } | null> {
    const gate = await getSeasonGate(ctx).catch(() => null);
    return gate?.selloutStartsSeason && gate.startedAt === 0
      ? { minted: gate.minted, maxSupply: gate.maxSupply }
      : null;
  }

  // The single verified-claim success payload. The pass reflects CURRENT
  // persisted state only (re-issue, never reset). googleSaveUrl is included only
  // when Google Wallet signing is configured (GOOGLE_SA_KEY_BASE64 + issuer id).
  async function successPayload(runner: Runner, opts: { includePassUrls: boolean; emailed?: boolean }) {
    const live = await petLiveStatus(ctx, runner);
    const payload: Record<string, unknown> = {
      ok: true,
      serial: runner.serial,
      tokenId: runner.tokenId ?? undefined,
      runnerNumber: runnerNumber(runner.tokenId, runner.serial),
      status: live.status,
    };
    if (live.secondsLeft !== undefined) payload.secondsLeft = live.secondsLeft;
    if (opts.includePassUrls) {
      // Capability URL: derived from the runner's CURRENT authToken, which the
      // wallet claim just rotated, so this is the new owner's cap and the
      // seller's old capability URL 404s from here on.
      payload.applePassUrl = runnerPassDownloadUrl(runner.serial, runner.authToken);
      let googleSaveUrl: string | null = null;
      try {
        googleSaveUrl = await getRunnerGoogle().saveUrl(runner);
      } catch (err) {
        logger.warn({ err: String(err), serial: runner.serial }, "google save url failed on claim");
      }
      if (googleSaveUrl) payload.googleSaveUrl = googleSaveUrl;
    }
    if (opts.emailed) payload.emailed = true;
    return payload;
  }

  // 1. Server-issued claim nonce (single-use, TTL-bounded). The site embeds it
  // in the message the wallet personal_signs; POST /api/claim verifies it.
  r.get("/api/claim/nonce", limited("nonce"), (_req, res) => {
    res.json(issueClaimNonce());
  });

  // 2. Ownership-verified pass claim (wallet proof or email re-delivery).
  r.post("/api/claim", limited("claim"), wrap(async (req, res) => {
    const parsed = ClaimBody.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({
        error: parsed.error.issues[0]?.message ?? "invalid body",
        code: "bad_request",
      });
    }

    try {
      if (parsed.data.method === "wallet") {
        return await handleWalletClaim(parsed.data, res);
      }
      return await handleEmailClaim(parsed.data, res);
    } catch (err) {
      logger.error({ err: String(err) }, "claim failed");
      return res.status(502).json({
        error: "We could not verify ownership right now. Please try again in a moment.",
        code: "unavailable",
      });
    }
  }));

  async function handleWalletClaim(
    body: z.infer<typeof WalletClaim>,
    res: import("express").Response,
  ) {
    // Nonce first: the signed message must embed a live server-issued nonce.
    const nonce = extractNonce(body.message);
    if (!nonce || !isClaimNonceActive(nonce)) {
      return res.status(400).json({
        error: "Your claim session expired. Please try again.",
        code: "bad_nonce",
      });
    }

    // If the message pins an address, it must be the one being claimed for
    // (prevents replaying a signature under a different address parameter).
    // BIND THE SIGNATURE TO THIS SITE AND THIS INTENT.
    //
    // Verifying only the nonce meant we accepted a signature over ANY text. A site the
    // holder visits could fetch a nonce from us (no browser needed: CORS does not gate a
    // server-to-server GET), ask them to sign something that never mentions WALLETCHI,
    // and post the result here. It recovers to an address that owns pets, so the
    // ownership check passes, and the attacker receives the pass capability URL whose
    // .pkpass embeds that pet's signed care links, while rotation kills the real owner's
    // pass. The NFT never moves, so this is theft of the SPEND CAPABILITY, not the asset.
    //
    // The client has always written a proper statement and domain line; we simply were
    // not checking them. Now the message must say what it is for and name this site, so a
    // signature harvested on someone else's page cannot be replayed here.
    const host = new URL(config.WEB_APP_URL).host;
    if (!body.message.includes(CLAIM_STATEMENT) || !body.message.includes(`${host} wants you to prove you own this pet.`)) {
      return res.status(400).json({
        error: "That signature was not made for this site. Start the claim again from the claim page.",
        code: "bad_message",
      });
    }
    const pinned = /^Address:\s*(0x[0-9a-fA-F]{40})\s*$/m.exec(body.message)?.[1];
    // MANDATORY, not conditional: an omitted Address line used to skip the check entirely.
    if (!pinned) {
      return res.status(400).json({
        error: "That signature is missing its address. Start the claim again from the claim page.",
        code: "bad_message",
      });
    }
    if (pinned.toLowerCase() !== body.address.toLowerCase()) {
      return res.status(400).json({
        error: "The signed message does not match the claiming wallet.",
        code: "bad_signature",
      });
    }

    // EIP-191 personal_sign recovery: the signer IS the proof.
    const signer = await recoverClaimSigner(body.message, body.signature);
    if (!signer) {
      return res.status(400).json({ error: "That signature could not be read.", code: "bad_signature" });
    }
    if (signer.toLowerCase() !== body.address.toLowerCase()) {
      return res
        .status(403)
        .json({ error: "That signature was not made by the claiming wallet.", code: "not_owner" });
    }

    // Resolve the pet(s) the signer owns.
    let runner: Runner | null = null;
    if (body.tokenId) {
      runner = await ctx.store.getRunnerByTokenId(body.tokenId);
      if (!runner) {
        const e = notFound("We could not find that pet. Double-check the number and try again.");
        return res.status(e.status).json({ error: e.error, code: e.code });
      }
      let owner: string;
      try {
        owner = await ctx.relayer.petOwnerOf(body.tokenId);
      } catch (err) {
        const msg = String(err instanceof Error ? err.message : err);
        if (/not set/i.test(msg)) {
          logger.error({ err: msg }, "claim attempted without PET721_ADDRESS configured");
          return res.status(503).json({
            error: "Claiming is not open yet. Please try again soon.",
            code: "unavailable",
          });
        }
        const e = notFound("We could not find that pet on-chain.");
        return res.status(e.status).json({ error: e.error, code: e.code });
      }
      if (owner.toLowerCase() !== signer.toLowerCase()) {
        const e = notOwner("That wallet does not own this pet. Connect the wallet that holds it.");
        return res.status(e.status).json({ error: e.error, code: e.code });
      }
    } else {
      // No tokenId: enumerate the pets this server knows and filter by ownerOf.
      // Route through the SHARED 60s owner cache, exactly as /api/pets/by-owner does and
      // for the same stated reason. Uncached, this branch was an unauthenticated
      // amplifier: anyone could self-sign a nonce with a throwaway key, reach here before
      // proving anything, and spend one signature to buy 2,000 ownerOf reads against our
      // RPC. Sustained, that starves the fresh-read ownership guard that every spending
      // path depends on, which degrades pass care during a season where death is
      // permanent.
      const minted = (await ctx.store.allMintedRunners()).filter((m) => m.tokenId);
      let owners: (string | null)[];
      try {
        owners = await cachedPetOwnersOf(ctx, minted.map((m) => m.tokenId!));
      } catch (err) {
        const msg = String(err instanceof Error ? err.message : err);
        if (/not set/i.test(msg)) {
          return res.status(503).json({
            error: "Claiming is not open yet. Please try again soon.",
            code: "unavailable",
          });
        }
        throw err;
      }
      const owned = minted.filter((_, i) => owners[i]?.toLowerCase() === signer.toLowerCase());
      if (owned.length === 0) {
        const e = notOwner(
          "That wallet does not hold a WALLETCHI. Connect the wallet that owns your pet, or use the email path.",
        );
        return res.status(e.status).json({ error: e.error, code: e.code });
      }
      if (owned.length > 1) {
        // The picker re-sends the SAME signature with a chosen tokenId, so the
        // nonce is NOT consumed here (it stays live until a pass is issued).
        const pets = [];
        for (const p of owned) {
          const live = await petLiveStatus(ctx, p);
          pets.push({
            tokenId: p.tokenId!,
            serial: p.serial,
            runnerNumber: runnerNumber(p.tokenId, p.serial),
            status: live.status,
          });
        }
        return res.json({ ok: false, multiple: true, pets });
      }
      runner = owned[0]!;
    }

    // A dead pet is a soulbound memorial: no pass re-issue, no control transfer.
    if (await isPetDead(ctx, runner)) {
      const e = deadSoulbound();
      return res.status(e.status).json({ error: e.error, code: e.code });
    }

    // The buyer's declared contact. Stored lowercase because the email
    // re-delivery path matches with a plain lowercase compare; the sybil
    // normalizeEmail form is for mint reserve keys and would BREAK that match
    // (gmail dot-stripping), so it is deliberately not used here. A placeholder
    // shape is refused: it would silently disable re-delivery for this pet.
    const claimEmail = body.email?.trim().toLowerCase();
    if (claimEmail && isPlaceholderEmail(claimEmail)) {
      return res.status(400).json({ error: "Enter a real email address.", code: "bad_request" });
    }

    // Verified. Consume the nonce, rotate the pass auth token (kills the prior
    // owner's pass + HMAC care links), rebind owner-of-record to the signer, and
    // re-issue the pass for the EXISTING pet state.
    consumeClaimNonce(nonce);
    const claimed = await rotateRunnerAuth(ctx, runner, {
      newOwnerAddress: signer,
      newOwnerEmail: claimEmail,
    });
    logger.info(
      { serial: claimed.serial, tokenId: claimed.tokenId, newOwner: signer, emailOnFile: Boolean(claimEmail) },
      "pet claimed (wallet proof): authToken rotated",
    );

    // Best-effort receipt to the address just placed on file: the same pass
    // links the response carries, so losing this email loses nothing. The claim
    // itself NEVER fails on a mail problem.
    let emailed = false;
    if (claimEmail) {
      try {
        let googleUrl: string | null = null;
        try {
          googleUrl = await getRunnerGoogle().saveUrl(claimed);
        } catch {
          googleUrl = null;
        }
        const sent = await sendRunnerReceiptEmail(claimed, {
          appleUrl: runnerPassDownloadUrl(claimed.serial, claimed.authToken),
          googleUrl,
          cardUrl: `${config.WEB_APP_URL}/pet/${claimed.serial}`,
        }, await receiptSeasonPending());
        emailed = sent.sent;
      } catch (err) {
        logger.warn({ err: String(err), serial: claimed.serial }, "claim receipt email failed");
      }
    }
    return res.json(await successPayload(claimed, { includePassUrls: true, emailed }));
  }

  async function handleEmailClaim(
    body: z.infer<typeof EmailClaim>,
    res: import("express").Response,
  ) {
    const runner = await ctx.store.getRunnerByTokenId(body.tokenId);
    if (!runner) {
      const e = notFound("We could not find that pet number. Double-check it and try again.");
      return res.status(e.status).json({ error: e.error, code: e.code });
    }

    // Email is NOT ownership proof by itself. It only re-delivers the CURRENT
    // pass, and only while (a) the email is genuinely on file (placeholder
    // wallet emails are derived from public data and never count) and (b) our
    // owner-of-record still matches the on-chain owner (no unclaimed transfer).
    const emailMatches =
      !isPlaceholderEmail(runner.email) &&
      runner.email.toLowerCase() === body.email.trim().toLowerCase();
    if (!emailMatches) {
      const e = notOwner("That email is not on file for this pet. Use the connect-wallet path.");
      return res.status(e.status).json({ error: e.error, code: e.code });
    }
    if (runner.tokenId) {
      try {
        const owner = await ctx.relayer.petOwnerOf(runner.tokenId);
        if (owner.toLowerCase() !== runner.ownerAddress.toLowerCase()) {
          const e = notOwner(
            "This pet moved to a new wallet since it was minted. Its new owner claims it with the wallet path.",
          );
          return res.status(e.status).json({ error: e.error, code: e.code });
        }
      } catch (err) {
        // A claim rotates the pass secret, so it is a state-changing action and the fresh ownership
        // read must FAIL CLOSED once real value is at stake: retry once, then refuse retryably. It
        // never falls back to the owner of record, which is exactly the SELLER after a sale. Only
        // the pre-deploy custodial demo (Pet721 not configured, survival off) keeps the DB record.
        if (config.modes.survivalLive) {
          try {
            const owner = await freshOwnerOf(ctx, runner.tokenId);
            if (owner.toLowerCase() !== runner.ownerAddress.toLowerCase()) {
              const e = notOwner(
                "This pet moved to a new wallet since it was minted. Its new owner claims it with the wallet path.",
              );
              return res.status(e.status).json({ error: e.error, code: e.code });
            }
          } catch {
            res.setHeader("Retry-After", "5");
            return res.status(503).json({
              error: "We could not verify ownership right now. Please try again in a moment.",
              code: "ownership_unavailable",
              retryable: true,
            });
          }
        } else {
          logger.debug({ err: String(err), serial: runner.serial }, "email claim ownerOf read unavailable (demo)");
        }
      }
    }

    if (await isPetDead(ctx, runner)) {
      const e = deadSoulbound();
      return res.status(e.status).json({ error: e.error, code: e.code });
    }

    // Re-deliver the current pass to the on-file inbox. NO rotation here: the
    // pet did not change hands, and rotating on an unauthenticated email input
    // would let anyone who knows the email grief the owner's live pass.
    let googleUrl: string | null = null;
    try {
      googleUrl = await getRunnerGoogle().saveUrl(runner);
    } catch {
      googleUrl = null;
    }
    await sendRunnerReceiptEmail(runner, {
      appleUrl: runnerPassDownloadUrl(runner.serial, runner.authToken),
      googleUrl,
      cardUrl: `${config.WEB_APP_URL}/pet/${runner.serial}`,
    }, await receiptSeasonPending());
    logger.info({ serial: runner.serial, tokenId: runner.tokenId }, "pet pass re-emailed (email path)");
    // Pass URLs go to the INBOX, not the response: typing an email is not proof.
    return res.json(await successPayload(runner, { includePassUrls: false, emailed: true }));
  }

  return r;
}
