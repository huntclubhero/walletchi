import { Router, type Request, type Response } from "express";
import { getAddress, isAddress } from "viem";
import { config } from "../config.js";
import { logger } from "../logger.js";
import type { AppContext } from "../context.js";
import type { Runner } from "../store/types.js";
import { wrap } from "../util/async-handler.js";
import { clientIp } from "../util/client-ip.js";
import { verifyPrivyToken, getPrivyUserWallets } from "../services/privy.js";
import { runnerPassDownloadUrl } from "./pass.js";
import { getRunnerGoogle } from "./google.js";
import { issueActionChallenge, verifyActionChallenge, type ChallengeErrorCode } from "./challenge.js";
import { claimRateHit, freshOwnerOf, rotateRunnerAuth } from "./claim.js";

// WALLET PASS EXTENSION (ERC draft, IERC721WalletPass, 0xef5f1e71): THE PASS MANIFEST.
//
// Pet721.passURI(id) is `<PASS_BASE_URI>eip155/<chainId>/<pet721>/<id>`, and it resolves HERE. The
// draft requires the URI to resolve to a manifest of the shape
//   { "formats": { "apple": <pkpass URL>, "google": <Save to Google Wallet link> }, "updatedAt": <unix s> }
//
// WALLETCHI OPERATES THE GATED CONFIGURATION (and runs pass action links in the capability
// configuration on top of it). Its acquisition URLs are CAPABILITY URLs: the .pkpass download is an
// HMAC capability derived from the pass's secret, and the installed pass carries capability action
// links. The draft is explicit that a capability URL published by a public manifest is public data
// ("unguessability does not survive publication"), and that only in the gated configuration may
// possession of one serve as a possession proof. So:
//
//   - UNAUTHENTICATED fetch: 401 `proof_required`, with directions to the challenge. NO acquisition
//     URL, ever. passURI is a public view function; anyone can enumerate ids and fetch this.
//   - OWNER-AUTHENTICATED fetch: 200 with the manifest, `Cache-Control: no-store` (clients MUST NOT
//     durably cache acquisition URLs). Two ways to prove control of the owning account:
//       1. The draft's interoperable path (same shape as its reference server): fetch an ERC-4361
//          challenge for the `acquire` action from `<passURI>/challenge?address=<account>`, sign it,
//          and send the message base64url-encoded in `X-Wallet-Pass-Proof` with the signature in
//          `X-Wallet-Pass-Signature`. The challenge names the CAIP-19 token, the action, a single-use
//          nonce, an expiry and this verifier's domain, and every field is checked (challenge.ts).
//       2. The WALLETCHI site's path: a Privy access token (`Authorization: Bearer ...`) whose linked
//          wallet is the owner. Email-onboarded keepers hold an embedded signer, so this is the same
//          proof of control without a signing prompt.
//     Both then take a FRESH ownerOf read that fails closed, never a cached owner.
//   - A proven owner who is NOT the owner of record is a new owner's first claim: the pass secret
//     ROTATES before any URL is minted (the gated configuration's rotation requirement), which also
//     kills every link the previous owner still holds.
//
// The OPTIONAL `wallet_pass` metadata mirror is deliberately NOT served: tokenURI is public, so
// mirroring this manifest there would publish the capability URLs this gate exists to protect.

/** The action a manifest proof is bound to. A proof for `acquire` cannot authorize anything else. */
export const ACQUIRE_ACTION = "acquire";

const MANIFEST_PATH = "/wallet-pass/eip155/:chainId/:contract/:tokenId([0-9]+)";

/** passURI for a token, composed exactly as DeployWalletchi composes the on-chain base. */
export function walletPassUri(tokenId: string): string | null {
  if (!config.pet721Address) return null;
  return `${config.PUBLIC_BASE_URL}/wallet-pass/eip155/${config.robinhood.chainId}/${config.pet721Address.toLowerCase()}/${tokenId}`;
}

type Resolved = { ok: true; tokenId: string } | { ok: false; status: number; error: string };

function resolveCollection(req: Request): Resolved {
  const { chainId, contract, tokenId } = req.params as Record<string, string>;
  const pet721 = config.pet721Address;
  if (!pet721) return { ok: false, status: 404, error: "unknown_collection" };
  if (chainId !== String(config.robinhood.chainId)) return { ok: false, status: 404, error: "unknown_collection" };
  if (!contract || contract.toLowerCase() !== pet721.toLowerCase()) {
    return { ok: false, status: 404, error: "unknown_collection" };
  }
  if (!tokenId || !/^[1-9][0-9]{0,9}$/.test(tokenId)) return { ok: false, status: 400, error: "invalid_request" };
  return { ok: true, tokenId };
}

function refuse(res: Response, status: number, error: string, extra: Record<string, unknown> = {}) {
  res.setHeader("Cache-Control", "no-store");
  return res.status(status).json({ error, ...extra });
}

/** HTTP status for a refused ERC-4361 proof: a retryable 503 only when the chain read was down. */
function statusForChallenge(code: ChallengeErrorCode): number {
  if (code === "unavailable") return 503;
  if (code === "not_owner") return 403;
  return 401;
}

export function walletPassRouter(ctx: AppContext): Router {
  const r = Router();

  // Issue the `acquire` challenge a client signs to resolve the gated manifest.
  r.get(`${MANIFEST_PATH}/challenge`, wrap(async (req, res) => {
    const col = resolveCollection(req);
    if (!col.ok) return refuse(res, col.status, col.error);
    const retryAfter = claimRateHit(`wallet-pass:${clientIp(req)}`);
    if (retryAfter !== null) {
      res.setHeader("Retry-After", String(retryAfter));
      return refuse(res, 429, "rate_limited");
    }
    const address = String(req.query.address ?? "");
    if (!isAddress(address)) return refuse(res, 400, "invalid_request", { detail: "address query parameter required" });
    const ch = issueActionChallenge({ tokenId: col.tokenId, action: ACQUIRE_ACTION, address: getAddress(address) });
    res.setHeader("Cache-Control", "no-store");
    res.json({
      message: ch.message,
      nonce: ch.nonce,
      expiresAt: ch.expiresAt,
      proofHeaders: {
        "X-Wallet-Pass-Proof": "the message above, base64url-encoded",
        "X-Wallet-Pass-Signature": "the account's signature over the message",
      },
    });
  }));

  // The manifest itself.
  r.get(MANIFEST_PATH, wrap(async (req, res) => {
    res.setHeader("Vary", "Authorization, X-Wallet-Pass-Proof, X-Wallet-Pass-Signature");
    const col = resolveCollection(req);
    if (!col.ok) return refuse(res, col.status, col.error);
    const tokenId = col.tokenId;

    const proofHeader = req.get("x-wallet-pass-proof");
    const signature = req.get("x-wallet-pass-signature");
    const bearer = /^Bearer\s+(.+)$/i.exec(req.get("authorization") ?? "")?.[1]?.trim();

    if (!(proofHeader && signature) && !bearer) {
      return refuse(res, 401, "proof_required", {
        configuration: "gated",
        detail:
          "This manifest is gated: its acquisition URLs are capabilities and are served only to the token's current owner. " +
          "GET the challenge URI with the owning account in the address query parameter to obtain an ERC-4361 challenge for the acquire action, sign it, and repeat this request " +
          "with X-Wallet-Pass-Proof (the message, base64url) and X-Wallet-Pass-Signature.",
        challenge: `${walletPassUri(tokenId) ?? ""}/challenge`,
      });
    }

    let account: string;
    if (proofHeader && signature) {
      let message: string;
      try {
        message = Buffer.from(proofHeader, "base64url").toString("utf8");
      } catch {
        return refuse(res, 400, "invalid_message");
      }
      const v = await verifyActionChallenge(ctx, {
        message,
        signature,
        expectedTokenId: tokenId,
        expectedAction: ACQUIRE_ACTION,
      });
      if (!v.ok) {
        const status = statusForChallenge(v.code);
        if (status === 503) res.setHeader("Retry-After", "5");
        return refuse(res, status, v.code === "unavailable" ? "ownership_unavailable" : v.code, status === 503 ? { retryable: true } : {});
      }
      account = v.account.toLowerCase();
    } else {
      if (!config.modes.privyLive) return refuse(res, 401, "proof_required", { configuration: "gated" });
      const auth = await verifyPrivyToken(bearer);
      if (!auth.ok) return refuse(res, 401, "invalid_token");
      const wallets = await getPrivyUserWallets(auth.userId);
      let owner: string;
      try {
        owner = (await freshOwnerOf(ctx, tokenId)).toLowerCase();
      } catch {
        res.setHeader("Retry-After", "5");
        return refuse(res, 503, "ownership_unavailable", { retryable: true });
      }
      if (!wallets.includes(owner)) return refuse(res, 403, "not_owner");
      account = owner;
    }

    let runner: Runner | null = await ctx.store.getRunnerByTokenId(tokenId);
    if (!runner || runner.status !== "ready") return refuse(res, 404, "unknown_token");

    // A proven owner who is not the owner of record is a new owner's FIRST CLAIM: rotate the pass
    // secret before minting any URL, so the previous owner's pass download and action links die.
    if (account !== runner.ownerAddress.toLowerCase()) {
      runner = await rotateRunnerAuth(ctx, runner, { newOwnerAddress: account });
      logger.info({ serial: runner.serial, tokenId, newOwner: account }, "wallet-pass manifest: new owner proven, pass secret rotated");
    }

    const formats: Record<string, string> = { apple: runnerPassDownloadUrl(runner.serial, runner.authToken) };
    try {
      const google = await getRunnerGoogle().saveUrl(runner);
      if (google) formats.google = google;
    } catch (err) {
      logger.warn({ err: String(err), serial: runner.serial }, "wallet-pass manifest: google save link failed (apple only)");
    }
    res.setHeader("Cache-Control", "no-store");
    res.json({ formats, updatedAt: Math.floor(runner.updatedAt.getTime() / 1000) });
  }));

  return r;
}
