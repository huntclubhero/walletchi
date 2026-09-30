import { randomBytes } from "node:crypto";
import { recoverMessageAddress } from "viem";
import { config } from "../config.js";
import { logger } from "../logger.js";
import type { AppContext } from "../context.js";
import type { Runner } from "../store/types.js";
import { pushRunnerPass } from "./idle.js";
import { _resetPetNeedsCache } from "./season.js";

// WALLETCHI secondary-market claim core (WS2). A buyer who picked a pet up on
// OpenSea proves ownership (EIP-191 personal_sign over a SERVER-issued nonce,
// checked against Pet721.ownerOf on-chain) and gets the pet's wallet pass
// re-issued for its EXISTING state: no reset, no death, no timer change. On a
// successful wallet claim the pass authenticationToken ROTATES so the previous
// owner's pass and its HMAC care links are invalidated.
//
// SECURITY NOTES (the point of this module):
//  - Nonces are server-issued, single-use, TTL-bounded, and consumed only when a
//    pass is actually issued (the multi-pet picker re-sends the same signature).
//  - Signature recovery is EIP-191 personal_sign via viem recoverMessageAddress;
//    the recovered signer must equal BOTH the claimed address and ownerOf.
//  - The email path is RE-DELIVERY only (never rotates): it re-sends the current
//    pass to the on-file email, and only while our owner-of-record still matches
//    the on-chain owner. A secondary buyer must use the wallet path.
//  - Rotation keeps the previous token in an in-process registry so the old
//    pass's next Apple web-service refresh renders a "transferred" keepsake
//    (and can deregister), while never leaking the NEW token to the old owner.

// In-process nonce store: nonce -> expiry ms. Server-restart loss is fine (the
// claimer just re-signs); a nonce is worthless without a matching signature.
// Bounded (oldest-issued evicted at the cap) so a nonce flood cannot grow it
// without limit between TTL prunes.
const nonces = new Map<string, number>();
const MAX_NONCES = 10_000;

function pruneNonces(now = Date.now()): void {
  for (const [n, exp] of nonces) {
    if (exp <= now) nonces.delete(n);
  }
}

export function issueClaimNonce(): { nonce: string; expiresAt: string; ttlSeconds: number } {
  pruneNonces();
  while (nonces.size >= MAX_NONCES) {
    const oldest = nonces.keys().next().value;
    if (oldest === undefined) break;
    nonces.delete(oldest);
  }
  const nonce = randomBytes(16).toString("hex");
  const ttlSeconds = config.CLAIM_NONCE_TTL_SECONDS;
  nonces.set(nonce, Date.now() + ttlSeconds * 1000);
  return { nonce, expiresAt: new Date(Date.now() + ttlSeconds * 1000).toISOString(), ttlSeconds };
}

export function isClaimNonceActive(nonce: string): boolean {
  const exp = nonces.get(nonce);
  return exp !== undefined && exp > Date.now();
}

export function consumeClaimNonce(nonce: string): void {
  nonces.delete(nonce);
}

// The signed message must embed a server-issued nonce on its own line
// ("Nonce: <hex>", per the site's buildClaimMessage). Extract it for validation.
export function extractNonce(message: string): string | null {
  const m = /^Nonce:\s*([0-9a-fA-F]{16,64})\s*$/m.exec(message);
  return m ? m[1]!.toLowerCase() : null;
}

// Recover the EIP-191 personal_sign signer. Returns null on any malformed input
// (never throws into the route).
export async function recoverClaimSigner(
  message: string,
  signature: string,
): Promise<string | null> {
  try {
    return await recoverMessageAddress({ message, signature: signature as `0x${string}` });
  } catch {
    return null;
  }
}

// The public life-status trio the site renders. DB flags are the base truth the
// server maintains; when the survival season is live the vault is authoritative.
export type PetPublicStatus = "alive" | "critical" | "dead";

export interface PetLiveStatus {
  status: PetPublicStatus;
  secondsLeft?: number;
  daysLived?: number;
  careCount?: number;
}

// Short per-tokenId cache + in-flight coalescer for the petState read behind
// petLiveStatus: it sits on every public pet read (state page, metadata,
// by-owner rows), so a polling crowd on one pet must cost ONE vault read per
// TTL window, not one per request. secondsLeft drifting a few seconds inside
// the window is invisible next to a multi-day life timer. Errors are never
// cached (the caller's DB fallback handles them).
type PetStateRead = Awaited<ReturnType<AppContext["relayer"]["petState"]>>;
const PET_STATE_TTL_MS = 5_000;
const petStateCache = new Map<string, { state: PetStateRead; at: number }>();
const petStateInFlight = new Map<string, Promise<PetStateRead>>();
// Same TTL for the decorative memorial careCount read next to it.
const petCareCountCache = new Map<string, { careCount: number; at: number }>();

async function cachedPetState(ctx: AppContext, tokenId: string): Promise<PetStateRead> {
  const hit = petStateCache.get(tokenId);
  if (hit && Date.now() - hit.at < PET_STATE_TTL_MS) return hit.state;
  const inFlight = petStateInFlight.get(tokenId);
  if (inFlight) return inFlight;
  const read = ctx.relayer
    .petState(tokenId)
    .then((state) => {
      petStateCache.set(tokenId, { state, at: Date.now() });
      return state;
    })
    .finally(() => {
      petStateInFlight.delete(tokenId);
    });
  petStateInFlight.set(tokenId, read);
  return read;
}

export async function petLiveStatus(ctx: AppContext, runner: Runner): Promise<PetLiveStatus> {
  let status: PetPublicStatus = runner.gone ? "dead" : runner.critical ? "critical" : "alive";
  let secondsLeft: number | undefined;
  let careCount: number | undefined = runner.careCount > 0 ? runner.careCount : undefined;

  if (config.modes.survivalLive && runner.tokenId) {
    try {
      const s = await cachedPetState(ctx, runner.tokenId);
      if (s.registered) {
        // Death is the clock, permanent: dead the instant the timer lapses.
        // CRITICAL now means APPROACHING the deadline (inside the fade window),
        // because there is no revive once it passes.
        if (!s.dead && s.lastCareAt <= 0) {
          // Dormant egg: registered but never fed, so its clock has not started.
          // isAlive is false only because it has not hatched yet (the first feed
          // hatches it): that is NOT death. Show it as alive with no countdown
          // so the care page lets the keeper hatch it instead of a memorial.
          status = "alive";
        } else if (s.dead || !s.isAlive) {
          status = "dead";
          secondsLeft = 0;
        } else {
          secondsLeft = s.secondsLeft;
          status = s.secondsLeft <= config.CRITICAL_WINDOW_HOURS * 3600 ? "critical" : "alive";
        }
      }
    } catch (err) {
      logger.warn({ err: String(err), serial: runner.serial }, "petState read failed (status falls back to db)");
    }
    try {
      const cached = petCareCountCache.get(runner.tokenId);
      let count: number;
      if (cached && Date.now() - cached.at < PET_STATE_TTL_MS) {
        count = cached.careCount;
      } else {
        count = (await ctx.relayer.petMemorial(runner.tokenId)).careCount;
        petCareCountCache.set(runner.tokenId, { careCount: count, at: Date.now() });
      }
      if (count > 0) careCount = count;
    } catch {
      // memorial read is decorative here; DB careCount stands
    }
  }

  const bornMs = (runner.bornAt ?? runner.createdAt).getTime();
  const endMs = status === "dead" ? (runner.diedAt ?? runner.updatedAt).getTime() : Date.now();
  const daysLived = Math.max(1, Math.floor((endMs - bornMs) / 86_400_000) + 1);

  return { status, secondsLeft, daysLived, careCount };
}

// Dead == soulbound memorial. Prefer the Pet721 isDead read (matches the transfer
// hook exactly); fall back to the persisted gone flag when the read is unavailable.
export async function isPetDead(ctx: AppContext, runner: Runner): Promise<boolean> {
  if (runner.gone) return true;
  if (!runner.tokenId) return false;
  try {
    return await ctx.relayer.petIsDead(runner.tokenId);
  } catch {
    return runner.gone;
  }
}

// The previous-authToken registry: serial -> the token that was replaced at the
// last claim. In-process only (a restart just means the old pass 401s and
// freezes instead of rendering the "transferred" keepsake; security does not
// depend on this, the ROTATION in the store does).
//
// WHY the registry records a reason. The keepsake the old pass refreshes into
// must say what happened to it. After a sale it reads "transferred"; after the
// OWNER asked for a reset (Wallet Pass Extension, capability configuration:
// links MUST rotate on the owner's request, the only remedy for a leaked link
// under an unchanged owner) the same owner still holds the old card, and telling
// them their pet "moved to a new wallet" would be false and alarming.
export type AuthRotationReason = "transfer" | "reset";
const previousAuthTokens = new Map<string, { token: string; rotatedAt: Date; reason: AuthRotationReason }>();

export function previousAuthTokenFor(serial: string): string | null {
  return previousAuthTokens.get(serial)?.token ?? null;
}

/** Why the previous token was retired (drives the keepsake copy). Null when no rotation is on record. */
export function previousAuthRotationFor(serial: string): { token: string; reason: AuthRotationReason } | null {
  const prev = previousAuthTokens.get(serial);
  return prev ? { token: prev.token, reason: prev.reason } : null;
}

// Rotate the pass authenticationToken (invalidates every HMAC care link signed
// with the old token) and optionally rebind the owner-of-record. Pushes APNs so
// the old owner's registered devices refresh (and land on the transferred view).
// `reason` defaults to "transfer" (every claim path); the owner-requested reset
// passes "reset" and changes nothing else about the rotation.
export async function rotateRunnerAuth(
  ctx: AppContext,
  runner: Runner,
  opts: { newOwnerAddress?: string; newOwnerEmail?: string; reason?: AuthRotationReason } = {},
): Promise<Runner> {
  const newToken = randomBytes(24).toString("hex");
  previousAuthTokens.set(runner.serial, {
    token: runner.authToken,
    rotatedAt: new Date(),
    reason: opts.reason ?? "transfer",
  });

  const patch: Parameters<AppContext["store"]["updateRunner"]>[1] = { authToken: newToken };
  const newOwner = opts.newOwnerAddress;
  if (newOwner && newOwner.toLowerCase() !== runner.ownerAddress.toLowerCase()) {
    patch.ownerAddress = newOwner;
    // The on-file email belonged to the PREVIOUS owner. Unbind it so the email
    // re-delivery path cannot hand the rotated pass back to the seller.
    patch.email = `${newOwner.toLowerCase()}@wallet.walletchi.local`;
  }
  // The claimer's declared contact replaces the placeholder in the SAME write,
  // so there is never a persisted state where the seller's email survived or the
  // buyer's was dropped. Ownership was just signature-proven, which is exactly
  // the authority needed to set the pet's contact.
  if (opts.newOwnerEmail) patch.email = opts.newOwnerEmail;
  // A sale must not leave us holding the SELLER's key. sessionVerdict would reject it
  // (wrong_owner) and the vault's owner-only care() would reject it too, so this is not
  // exploitable, but "not exploitable" is not the same as "not held": without this we keep
  // a live sealed private key the seller granted, in every backup and every dump, for the
  // remainder of its TTL after the pet has changed hands. Destroy it at the moment
  // ownership moves. The care POST path already does this on a detected transfer.
  if (newOwner && newOwner.toLowerCase() !== runner.ownerAddress.toLowerCase()) {
    await ctx.store.revokeCareSession(runner.serial, "pet claimed by a new owner");
  }
  const updated = await ctx.store.updateRunner(runner.serial, patch);
  await pushRunnerPass(ctx, runner.serial); // best effort: old devices refresh into the transferred view
  return updated;
}

// Placeholder emails minted for wallet-owned pets are derived from the PUBLIC
// wallet address, so they must never satisfy the email-path ownership check.
export function isPlaceholderEmail(email: string): boolean {
  return email.toLowerCase().endsWith("@wallet.walletchi.local");
}

// Current-owner guard for care actions: a pet that transferred on-chain but has
// not been claimed yet must not accept the previous owner's (still HMAC-valid)
// links. Reads ownerOf with a short cache. On a read error the STALE cached
// owner stands in (covers an RPC blip for the current owner); with no cache at
// all the guard fails OPEN only while survival is off (demo posture) and CLOSED
// ("unavailable" -> the caller 503s) once real value is at stake, so an RPC
// outage can never resolve to the stale DB owner for a post-sale seller.
const ownerCache = new Map<string, { owner: string; at: number }>();
const OWNER_CACHE_MS = 60_000;

// Last-known-good on-chain owner from the guard's cache (may be stale). Shared
// with the on-site auth path so an RPC blip does not lock out current owners.
export function cachedPetOwner(tokenId: string): string | null {
  return ownerCache.get(tokenId)?.owner ?? null;
}

// Batch ownerOf THROUGH the 60s owner cache, for the /api/pets/by-owner
// dashboard read: a raw petOwnersOf over every minted pet is O(supply) RPC per
// request (an amplification vector); the dashboard tolerates a cache-window of
// staleness. Only tokenIds missing a fresh cache entry hit the chain, and their
// results warm the same cache the care guard uses. Claim-time ownership proofs
// keep their direct (uncached) reads.
export async function cachedPetOwnersOf(
  ctx: AppContext,
  tokenIds: string[],
): Promise<(string | null)[]> {
  const now = Date.now();
  const out: (string | null)[] = new Array(tokenIds.length).fill(null);
  const missing: { id: string; idx: number }[] = [];
  tokenIds.forEach((id, idx) => {
    const cached = ownerCache.get(id);
    if (cached && now - cached.at < OWNER_CACHE_MS) {
      out[idx] = cached.owner;
    } else {
      missing.push({ id, idx });
    }
  });
  if (missing.length > 0) {
    const owners = await ctx.relayer.petOwnersOf(missing.map((m) => m.id));
    owners.forEach((owner, j) => {
      const m = missing[j]!;
      out[m.idx] = owner;
      if (owner) ownerCache.set(m.id, { owner, at: now });
    });
  }
  return out;
}

/** A fresh ownerOf read could not be taken, even after a retry. Retryable: nothing was refused on
 *  the merits, the chain was simply not answering. */
export class OwnershipUnavailableError extends Error {
  readonly code = "ownership_unavailable";
  constructor(readonly tokenId: string) {
    super(`fresh ownerOf read unavailable for token ${tokenId}`);
    this.name = "OwnershipUnavailableError";
  }
}

/** One short retry absorbs an RPC blip without making a keeper wait on a real outage. */
export const FRESH_OWNER_RETRY_MS = 250;

/**
 * THE FRESH ENTITLEMENT READ for a state-changing action (Wallet Pass Extension, "Authorization of
 * pass-reachable actions", check 2). It is taken NOW, against the chain, for this request, and it
 * FAILS CLOSED: one short retry, then OwnershipUnavailableError. It NEVER falls back to a cached or
 * last-known-good owner. The draft is explicit that check 2 is never substitutable and never
 * deferred, and a cached owner is exactly a deferred read: it is what a pet's SELLER looks like for up
 * to a cache lifetime after the sale. A successful read still warms the cache for the read paths.
 */
export async function freshOwnerOf(ctx: AppContext, tokenId: string): Promise<string> {
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const owner = await ctx.relayer.petOwnerOf(tokenId);
      ownerCache.set(tokenId, { owner, at: Date.now() });
      return owner;
    } catch (err) {
      logger.warn({ err: String(err), tokenId, attempt }, "fresh ownerOf read failed");
      if (attempt === 0) await new Promise((r) => setTimeout(r, FRESH_OWNER_RETRY_MS));
    }
  }
  throw new OwnershipUnavailableError(tokenId);
}

// Mutating callers (care actions, reward claims) pass { fresh: true }: the
// wallet-pass floor requires the ownership read at the time of the request, so
// the cache must never widen the post-sale window on an action. A fresh read
// FAILS CLOSED ("unavailable") after one retry and never falls back to the
// cached owner (see freshOwnerOf). Read paths (no `fresh`) keep the cache and
// its stale-beats-DB fallback on an RPC blip.
export async function careOwnerGuard(
  ctx: AppContext,
  runner: Runner,
  opts: { fresh?: boolean } = {},
): Promise<"ok" | "transferred" | "unavailable"> {
  if (!runner.tokenId) return "ok";
  if (opts.fresh) {
    if (!config.modes.survivalLive) {
      // Pet721 not configured (pre-deploy demo): there is no chain to read and no value at stake.
      try {
        const owner = await ctx.relayer.petOwnerOf(runner.tokenId);
        return owner.toLowerCase() === runner.ownerAddress.toLowerCase() ? "ok" : "transferred";
      } catch {
        return "ok";
      }
    }
    try {
      const owner = await freshOwnerOf(ctx, runner.tokenId);
      return owner.toLowerCase() === runner.ownerAddress.toLowerCase() ? "ok" : "transferred";
    } catch {
      return "unavailable";
    }
  }
  const now = Date.now();
  const cached = ownerCache.get(runner.tokenId);
  let owner: string | null =
    !opts.fresh && cached && now - cached.at < OWNER_CACHE_MS ? cached.owner : null;
  if (!owner) {
    try {
      owner = await ctx.relayer.petOwnerOf(runner.tokenId);
      ownerCache.set(runner.tokenId, { owner, at: now });
    } catch (err) {
      logger.debug({ err: String(err), serial: runner.serial }, "care owner guard read unavailable");
      if (cached) {
        owner = cached.owner; // stale last-known-good beats the DB record
      } else if (config.modes.survivalLive) {
        return "unavailable"; // fail closed: real value at stake, nothing to check against
      } else {
        // Pet721 not configured yet (demo / pre-season): do not block care.
        return "ok";
      }
    }
  }
  return owner.toLowerCase() === runner.ownerAddress.toLowerCase() ? "ok" : "transferred";
}

// Fixed-window per-IP rate limit for the claim endpoints. In-process (matches
// the nonce store); GENEROUS so a legit claimer never sees it (a real claim is
// a handful of requests) while an email-bomb / nonce flood is capped. The key
// map is itself bounded (oldest evicted) so spoofed IPs cannot grow it.
const CLAIM_RATE_MAX = 20;
const CLAIM_RATE_WINDOW_MS = 60_000;
const MAX_RATE_KEYS = 10_000;
type RateWindow = { windowStart: number; count: number };
const claimRateHits = new Map<string, RateWindow>();

/** The one fixed-window counter behind every in-process limiter here. Returns retry-after seconds
 *  when `key` is over `max` hits in the current `windowMs` window, else null. */
function fixedWindowHit(hits: Map<string, RateWindow>, key: string, max: number, windowMs: number): number | null {
  const now = Date.now();
  const cur = hits.get(key);
  if (!cur || now - cur.windowStart >= windowMs) {
    if (!cur && hits.size >= MAX_RATE_KEYS) {
      // At the cap, drop EXPIRED windows only: evicting by age alone would let
      // an attacker cycling spoofed keys flush everyone's ACTIVE counters (and
      // so reset their own). If every entry is still live, the overflow key
      // simply goes untracked this window (fail-open beats a mass reset).
      for (const [k, v] of hits) {
        if (now - v.windowStart >= windowMs) hits.delete(k);
      }
      if (hits.size >= MAX_RATE_KEYS) return null;
    }
    hits.set(key, { windowStart: now, count: 1 });
    return null;
  }
  cur.count++;
  if (cur.count > max) {
    return Math.max(1, Math.ceil((cur.windowStart + windowMs - now) / 1000));
  }
  return null;
}

/** Count a hit for `key`. Returns retry-after seconds when over the limit, else null. */
export function claimRateHit(key: string): number | null {
  return fixedWindowHit(claimRateHits, key, CLAIM_RATE_MAX, CLAIM_RATE_WINDOW_MS);
}

// Owner-requested link rotation (POST /api/pet/:tokenId/rotate-links): ONE per pet
// per 10 minutes, keyed by serial. Every rotation retires a live pass (the owner's
// own card refreshes into a keepsake and must be re-added), so the limit is a
// safety rail against a stuck button or a script, not a capacity guard. It counts
// only rotations the caller was authorized to make: the route checks ownership
// first, so a stranger cannot spend the owner's window.
const ROTATE_RATE_MAX = 1;
const ROTATE_RATE_WINDOW_MS = 10 * 60_000;
const rotateRateHits = new Map<string, RateWindow>();

/** Count an owner-requested rotation for `serial`. Returns retry-after seconds when one already ran
 *  inside the window, else null. */
export function rotationRateHit(serial: string): number | null {
  return fixedWindowHit(rotateRateHits, serial, ROTATE_RATE_MAX, ROTATE_RATE_WINDOW_MS);
}

// Test hook: clear the in-process claim caches between smoke scenarios.
export function _resetClaimState(): void {
  nonces.clear();
  ownerCache.clear();
  previousAuthTokens.clear();
  claimRateHits.clear();
  rotateRateHits.clear();
  petStateCache.clear();
  petCareCountCache.clear();
  petStateInFlight.clear();
  _resetPetNeedsCache(); // the five-needs read cache lives in season.ts
}
