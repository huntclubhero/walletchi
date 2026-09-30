import { getAddress, recoverMessageAddress } from "viem";
import { createSiweMessage, generateSiweNonce, parseSiweMessage } from "viem/siwe";
import { config } from "../config.js";
import { logger } from "../logger.js";
import type { AppContext } from "../context.js";
import { freshOwnerOf } from "./claim.js";

// Spec-floor conformance: an ERC-4361 (Sign-In with Ethereum) challenge that
// authorizes a single state-mutating care action reachable from a wallet pass.
//
// This is the STRONG proof-of-control path required by the "Wallet Pass
// Extension for NFTs" security floor. It is additive: the existing static-HMAC
// care links (the custodial capability path for email-onboarded users, who never
// sign) are untouched. A self-custody wallet holder can instead fetch a
// challenge, sign it, and have the relayer execute the care gaslessly, with the
// server verifying every field before acting:
//   (1) proof of control: a signature over a server-issued challenge that names
//       the token (chain id, contract, token id), the action, a single-use
//       nonce, an expiration, and the verifier domain. EOA recovery first, then
//       an ERC-1271 fallback for smart-contract accounts.
//   (2) a fresh on-chain ownerOf read AT VERIFY TIME (not at issuance), so a
//       transfer between challenge issuance and use is refused.
//
// The nonce record is the authoritative binding: the SIWE resources carry the
// same token + action for human readability, but verification checks the record
// the server stored when it issued the nonce, so a re-signed or tampered message
// cannot re-bind to a different token or action.

export type ChallengeErrorCode =
  | "bad_nonce" // nonce not server-issued (or already pruned)
  | "replayed" // nonce already consumed
  | "expired" // challenge past its expiration
  | "bad_domain" // domain / uri does not match this verifier
  | "bad_chain" // chain id does not match this deployment
  | "bad_binding" // token id / action does not match the endpoint being hit
  | "bad_signature" // signature does not recover to (or validate for) the claimed account
  | "not_owner" // the claimed account is not the current on-chain owner
  | "unavailable"; // ownerOf read is down while real value is at stake

export interface ChallengeIssue {
  message: string; // the ERC-4361 message to sign
  nonce: string;
  expiresAt: string; // ISO
  ttlSeconds: number;
}

type NonceRecord = {
  tokenId: string;
  action: string;
  address: string; // lowercase; the account the challenge was issued for
  domain: string;
  expiresAtMs: number;
  used: boolean;
};

// In-process single-use nonce store (mirrors the claim nonce store: a restart
// just forces a re-sign, and a nonce is worthless without a matching signature).
// Bounded so a nonce flood cannot grow it without limit between TTL prunes.
const nonces = new Map<string, NonceRecord>();
const MAX_NONCES = 10_000;

function prune(now = Date.now()): void {
  for (const [n, rec] of nonces) {
    if (rec.expiresAtMs <= now) nonces.delete(n);
  }
}

// The authority (host[:port]) of this verifier, from PUBLIC_BASE_URL. This is
// the SIWE `domain` field; a signature made for another origin will not match.
export function verifierDomain(): string {
  return new URL(config.PUBLIC_BASE_URL).host;
}

// The token as a CAIP-19 asset id (chain id + contract + token id in one string), which the Wallet
// Pass Extension's recommended ERC-4361 serialization puts FIRST in the resources list. Omitted
// when the Pet721 address is not configured (pre-deploy demo), leaving only the action URN.
export function tokenResource(tokenId: string): string | null {
  const pet721 = config.pet721Address;
  if (!pet721) return null;
  return `eip155:${config.robinhood.chainId}/erc721:${getAddress(pet721)}/${tokenId}`;
}

/** The action as the draft's second resource: `urn:wallet-pass:action:<action>`. */
export function actionResource(action: string): string {
  return `urn:wallet-pass:action:${action}`;
}

// Issue a single-use, expiring, domain / chain / token / action bound ERC-4361
// challenge for `address` to sign. The address is the account claiming control
// (the current owner); the server binds it into the nonce record so a signature
// under a different address is refused.
export function issueActionChallenge(input: {
  tokenId: string;
  action: string;
  address: string;
}): ChallengeIssue {
  prune();
  while (nonces.size >= MAX_NONCES) {
    const oldest = nonces.keys().next().value;
    if (oldest === undefined) break;
    nonces.delete(oldest);
  }

  const address = getAddress(input.address); // checksum; throws on a bad address
  const nonce = generateSiweNonce();
  const ttlSeconds = config.CHALLENGE_TTL_SECONDS;
  const issuedAt = new Date();
  const expirationTime = new Date(issuedAt.getTime() + ttlSeconds * 1000);
  const domain = verifierDomain();

  // The draft's recommended layout: the CAIP-19 token first, the action URN second, and the action
  // restated in plain language in the statement. The nonce RECORD stays the authoritative binding
  // (see the header), so this layout is for wallets and humans, not the verifier.
  const tok = tokenResource(input.tokenId);
  const resources = tok ? [tok, actionResource(input.action)] : [actionResource(input.action)];

  const message = createSiweMessage({
    domain,
    address,
    statement:
      `Authorize the ${input.action} action for wallet pass token ${input.tokenId} on ${domain}. ` +
      "This grants no token spending approval.",
    uri: config.PUBLIC_BASE_URL,
    version: "1",
    chainId: config.robinhood.chainId,
    nonce,
    issuedAt,
    expirationTime,
    resources,
  });

  nonces.set(nonce, {
    tokenId: input.tokenId,
    action: input.action,
    address: address.toLowerCase(),
    domain,
    expiresAtMs: expirationTime.getTime(),
    used: false,
  });

  return { message, nonce, expiresAt: expirationTime.toISOString(), ttlSeconds };
}

export type ChallengeVerifyResult =
  | { ok: true; account: string }
  | { ok: false; code: ChallengeErrorCode };

// Verify a signed challenge for a specific care action + token. Consumes the
// nonce on success (single use). Order matters: cheap record / field checks
// before the signature recovery, and the fresh ownerOf read LAST so a transfer
// between issuance and use is caught at the moment of action.
export async function verifyActionChallenge(
  ctx: AppContext,
  input: {
    message: string;
    signature: string;
    expectedTokenId: string;
    expectedAction: string;
  },
): Promise<ChallengeVerifyResult> {
  let parsed: ReturnType<typeof parseSiweMessage>;
  try {
    parsed = parseSiweMessage(input.message);
  } catch {
    return { ok: false, code: "bad_signature" };
  }
  const nonce = parsed.nonce;
  if (!nonce) return { ok: false, code: "bad_nonce" };
  const rec = nonces.get(nonce);
  if (!rec) return { ok: false, code: "bad_nonce" };
  if (rec.used) return { ok: false, code: "replayed" };

  const now = Date.now();
  // Expiry: the server record is authoritative; the message's own expiration is
  // also honored (whichever is sooner refuses a stale challenge).
  const msgExpMs =
    parsed.expirationTime instanceof Date ? parsed.expirationTime.getTime() : rec.expiresAtMs;
  if (rec.expiresAtMs <= now || msgExpMs <= now) {
    nonces.delete(nonce);
    return { ok: false, code: "expired" };
  }

  // Domain + uri must be this verifier (anti cross-origin replay of a signature).
  const domain = verifierDomain();
  if (parsed.domain !== domain || rec.domain !== domain) {
    return { ok: false, code: "bad_domain" };
  }
  if (parsed.uri && parsed.uri !== config.PUBLIC_BASE_URL) {
    return { ok: false, code: "bad_domain" };
  }

  // Chain id must match this deployment.
  if (parsed.chainId !== undefined && Number(parsed.chainId) !== config.robinhood.chainId) {
    return { ok: false, code: "bad_chain" };
  }

  // Binding: the nonce was issued for a specific token + action. The endpoint
  // being hit must match it, so a challenge for feed on pet A cannot authorize
  // water on pet B.
  if (rec.tokenId !== input.expectedTokenId || rec.action !== input.expectedAction) {
    return { ok: false, code: "bad_binding" };
  }

  // The claimed account: parsed from the message, cross-checked against the
  // record the challenge was issued for.
  if (!parsed.address) return { ok: false, code: "bad_signature" };
  const account = parsed.address.toLowerCase();
  if (account !== rec.address) return { ok: false, code: "bad_signature" };

  // Signature: EOA recovery first (the common self-custody case), then an
  // ERC-1271 fallback for smart-contract accounts. In production the email-
  // onboarded owner is an embedded EOA, so the 1271 branch is a generic safety
  // net rather than a prod path.
  let signatureValid = false;
  try {
    const recovered = await recoverMessageAddress({
      message: input.message,
      signature: input.signature as `0x${string}`,
    });
    signatureValid = recovered.toLowerCase() === account;
  } catch {
    signatureValid = false;
  }
  if (!signatureValid) {
    try {
      signatureValid = await ctx.relayer.isValidErc1271Signature(
        account,
        input.message,
        input.signature,
      );
    } catch (err) {
      logger.debug({ err: String(err) }, "erc-1271 fallback verification failed");
      signatureValid = false;
    }
  }
  if (!signatureValid) return { ok: false, code: "bad_signature" };

  // Fresh on-chain ownerOf AT VERIFY TIME (floor check 2). Uncached on purpose:
  // this is the mutating request, so the read must reflect the current owner, not
  // a cache warmed by the care guard. A transfer since issuance lands here.
  let owner: string;
  try {
    // Fail closed after one short retry; never a cached owner (see freshOwnerOf).
    owner = await freshOwnerOf(ctx, input.expectedTokenId);
  } catch (err) {
    logger.warn(
      { err: String(err), tokenId: input.expectedTokenId },
      "challenge ownerOf read unavailable",
    );
    return { ok: false, code: "unavailable" };
  }
  if (owner.toLowerCase() !== account) return { ok: false, code: "not_owner" };

  // Consume the nonce (single use) only after every check passes. The record is
  // KEPT (marked used, not deleted) until it expires, so a replay is refused as
  // an explicit "replayed" rather than being conflated with an unknown nonce;
  // prune() reclaims it once past expiry.
  rec.used = true;
  return { ok: true, account };
}

// Test hook: clear the in-process challenge nonce store between scenarios.
export function _resetChallengeState(): void {
  nonces.clear();
}
