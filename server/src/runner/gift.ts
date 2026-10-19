import { randomBytes } from "node:crypto";
import { getAddress } from "viem";
import { config } from "../config.js";
import { logger } from "../logger.js";
import type { AppContext } from "../context.js";
import { freshOwnerOf } from "./claim.js";
import { lookupPrivyWalletByEmail } from "../services/privy.js";

// "GIFT THIS PET": an owner hands a living pet to another person.
//
// WHY THIS NEEDS A SERVER SIDE AT ALL. Holders have Privy embedded wallets with no external
// transfer UI and zero ETH, so the only way a pet can move is a gas-sponsored user operation from
// the owner's EIP-7702 smart account calling Pet721.transferFrom(owner, recipient, tokenId). The
// gas policy's sponsorship webhook (gas-sponsor.ts) approves care() and the arming bootstrap and
// denies everything else, so a transfer needs a rule of its own, and that rule must be NARROW:
// "any transferFrom on our token" would let anyone with a wallet burn our sponsorship budget on
// ops the token then reverts (the same griefing shape the care rule closes).
//
// So a gift is PREPARED first. The owner proves control of the pet's CURRENT on-chain owner (the
// same auth as every other spending path), names a recipient (an email Privy resolves to that
// person's embedded wallet, or a plain address), and the server records a short-lived INTENT:
// (tokenId, from, to). The webhook then approves a transfer only when the op's sender is the
// pet's owner, `from` is that sender, and (tokenId, from, to) is exactly a prepared intent that
// has not expired, at most GIFT_SPONSOR_MAX_PER_HOUR times per pet per hour. Nothing about the
// rule trusts the client: the calldata is fixed by ERC-721, the intent is server state, and the
// ownership read is the chain's.
//
// WHAT HAPPENS AFTER THE TRANSFER LANDS is the EXISTING transfer machinery, not a copy of it:
//   - the seller's one-tap care session is revoked here the moment ownerOf reads the recipient
//     (the same revoke the pass-tap care path performs when it detects a sale, routes.ts);
//   - the pass secret rotates on the RECIPIENT's first claim (pass-link on /me, rotate-links,
//     the gated manifest or the /claim page), which rebinds the owner of record, unbinds the
//     seller's email, and pushes the seller's card into the TRANSFERRED keepsake (claim.ts
//     rotateRunnerAuth);
//   - Pet721._update emits PassUpdate(tokenId) on the transfer itself, so pass distributors learn
//     about the new holder from the chain.
//
// STATE LIVES IN PROCESS, like the claim nonces: an intent is worthless without the owner's
// signature and the chain's ownership read, and a restart just means the owner prepares again.

/** How long a prepared gift stays sponsorable. The owner signs within seconds of preparing; the
 *  window only has to outlive a slow bundler and one retry. */
export const GIFT_INTENT_TTL_MS = 15 * 60_000;
/** Sponsored transfer approvals per pet per hour. One is the gift; the second is a retry after a
 *  failed op (a refused simulation, a dropped bundle). A third inside the hour is nobody's honest
 *  use and is refused. */
export const GIFT_SPONSOR_MAX_PER_HOUR = 2;
const GIFT_SPONSOR_WINDOW_MS = 60 * 60_000;
/** Polling cadence of the landing watcher (a fallback for a keeper who closes the tab). */
const LANDING_POLL_MS = 4_000;
const MAX_INTENTS = 4_000;

export type GiftIntentStatus = "prepared" | "approved" | "landed" | "expired";

export interface GiftIntent {
  id: string;
  tokenId: string;
  serial: string;
  /** The owner at prepare time, lowercase. The op's sender and `from` must both equal it. */
  from: string;
  /** The recipient wallet, lowercase. */
  to: string;
  /** The email the recipient was resolved from, for the result copy only. Null for an address. */
  toEmail: string | null;
  createdAt: number;
  expiresAt: number;
  status: GiftIntentStatus;
  /** Sponsorship approvals granted against this intent (progress display; the limiter is per pet). */
  approvals: number;
  landedAt?: number;
}

// One ACTIVE intent per pet (a new prepare replaces the previous one), plus an id index for the
// status read. Both bounded.
const intentsByToken = new Map<string, GiftIntent>();
const intentsById = new Map<string, GiftIntent>();

function pruneIntents(now = Date.now()): void {
  for (const [id, intent] of intentsById) {
    // A landed intent is kept for the status read for one TTL after landing, then dropped.
    const keepUntil = intent.status === "landed" ? (intent.landedAt ?? now) + GIFT_INTENT_TTL_MS : intent.expiresAt;
    if (keepUntil <= now) {
      intentsById.delete(id);
      if (intentsByToken.get(intent.tokenId) === intent) intentsByToken.delete(intent.tokenId);
    }
  }
}

/** Record a prepared gift for `tokenId`, replacing any earlier one for the same pet. */
export function prepareGiftIntent(input: {
  tokenId: string;
  serial: string;
  from: string;
  to: string;
  toEmail: string | null;
}): GiftIntent {
  const now = Date.now();
  pruneIntents(now);
  if (intentsById.size >= MAX_INTENTS) {
    // At the cap, drop the oldest by creation. Intents are tiny and short-lived, so this only
    // triggers under a flood, where losing a stranger's prepared intent costs them a re-prepare.
    const oldest = intentsById.values().next().value;
    if (oldest) {
      intentsById.delete(oldest.id);
      if (intentsByToken.get(oldest.tokenId) === oldest) intentsByToken.delete(oldest.tokenId);
    }
  }
  const previous = intentsByToken.get(input.tokenId);
  if (previous && previous.status !== "landed") intentsById.delete(previous.id);
  const intent: GiftIntent = {
    id: randomBytes(16).toString("hex"),
    tokenId: input.tokenId,
    serial: input.serial,
    from: input.from.toLowerCase(),
    to: input.to.toLowerCase(),
    toEmail: input.toEmail,
    createdAt: now,
    expiresAt: now + GIFT_INTENT_TTL_MS,
    status: "prepared",
    approvals: 0,
  };
  intentsByToken.set(input.tokenId, intent);
  intentsById.set(intent.id, intent);
  return intent;
}

/** The pet's live (unexpired, not yet landed) intent, or null. */
export function activeGiftIntent(tokenId: string): GiftIntent | null {
  const intent = intentsByToken.get(tokenId);
  if (!intent) return null;
  if (intent.status === "landed" || intent.status === "expired") return null;
  if (intent.expiresAt <= Date.now()) {
    intent.status = "expired";
    return null;
  }
  return intent;
}

export function giftIntentById(id: string): GiftIntent | null {
  const intent = intentsById.get(id) ?? null;
  if (intent && intent.status === "prepared" && intent.expiresAt <= Date.now()) intent.status = "expired";
  return intent;
}

/**
 * THE WEBHOOK'S QUESTION: is `(tokenId, from, to)` a prepared gift the policy may fund right now?
 * Counts the approval against the pet's hourly window ONLY when every other check passed, so a
 * stranger's denied shapes cannot spend the owner's window. Returns the deny reason, or null to
 * approve.
 */
export function giftSponsorVerdict(input: { tokenId: string; from: string; to: string }): string | null {
  const intent = activeGiftIntent(input.tokenId);
  if (!intent) return "no prepared gift for this pet";
  if (intent.from !== input.from.toLowerCase()) return "transfer is not from the prepared owner";
  if (intent.to !== input.to.toLowerCase()) return "transfer is not to the prepared recipient";
  const retry = giftSponsorHit(input.tokenId);
  if (retry !== null) return `gift sponsorship limit reached for this pet (retry in ${retry}s)`;
  intent.status = "approved";
  intent.approvals += 1;
  return null;
}

// Per-pet fixed window of sponsored transfer approvals. Same shape as the claim limiters; kept
// here because the count belongs to the gift, not to an IP.
type RateWindow = { windowStart: number; count: number };
const sponsorHits = new Map<string, RateWindow>();

function giftSponsorHit(tokenId: string): number | null {
  const now = Date.now();
  const cur = sponsorHits.get(tokenId);
  if (!cur || now - cur.windowStart >= GIFT_SPONSOR_WINDOW_MS) {
    if (!cur && sponsorHits.size >= MAX_INTENTS) {
      for (const [k, v] of sponsorHits) {
        if (now - v.windowStart >= GIFT_SPONSOR_WINDOW_MS) sponsorHits.delete(k);
      }
      if (sponsorHits.size >= MAX_INTENTS) return null;
    }
    sponsorHits.set(tokenId, { windowStart: now, count: 1 });
    return null;
  }
  cur.count++;
  if (cur.count > GIFT_SPONSOR_MAX_PER_HOUR) {
    return Math.max(1, Math.ceil((cur.windowStart + GIFT_SPONSOR_WINDOW_MS - now) / 1000));
  }
  return null;
}

/**
 * Has the gift landed? Reads ownerOf FRESH (fail closed: an unreadable chain answers "pending",
 * never "landed") and, the first time the recipient is the owner, retires the seller's one-tap
 * care session exactly as the pass-tap care path does on a detected sale. Idempotent: the status
 * read and the background watcher both call it.
 */
export async function settleGiftIntent(ctx: AppContext, intent: GiftIntent): Promise<GiftIntentStatus> {
  if (intent.status === "landed" || intent.status === "expired") return intent.status;
  if (intent.expiresAt <= Date.now()) {
    intent.status = "expired";
    return intent.status;
  }
  let owner: string;
  try {
    owner = (await freshOwnerOf(ctx, intent.tokenId)).toLowerCase();
  } catch {
    return intent.status; // unreadable: still pending, the caller asks again
  }
  if (owner !== intent.to) return intent.status;
  intent.status = "landed";
  intent.landedAt = Date.now();
  // The stored session was granted by the SELLER. sessionVerdict and the vault's owner-only care()
  // would both refuse it against the new owner, but "not usable" is not "not held": destroy it
  // the moment ownership moves, the same call and the same reason shape as routes.ts.
  await ctx.store.revokeCareSession(intent.serial, "pet gifted on-chain");
  logger.info(
    { serial: intent.serial, tokenId: intent.tokenId, from: intent.from, to: intent.to, intentId: intent.id },
    "gift landed: seller's care session revoked, pass rotates on the recipient's first claim",
  );
  return intent.status;
}

/**
 * Background landing watcher, so the seller's session is retired even when the keeper closes the
 * tab right after signing. Polls until the intent lands or expires; never keeps the process alive.
 */
export function watchGiftLanding(ctx: AppContext, intent: GiftIntent): void {
  const tick = async () => {
    let status: GiftIntentStatus;
    try {
      status = await settleGiftIntent(ctx, intent);
    } catch (err) {
      logger.debug({ err: String(err), intentId: intent.id }, "gift landing watcher read failed");
      status = intent.status;
    }
    // A replaced intent (the owner prepared again) stops its own watcher; the new one has its own.
    if (status === "landed" || status === "expired" || intentsById.get(intent.id) !== intent) return;
    const t = setTimeout(() => void tick(), LANDING_POLL_MS);
    t.unref?.();
  };
  const first = setTimeout(() => void tick(), LANDING_POLL_MS);
  first.unref?.();
}

export type GiftRecipient =
  | { ok: true; address: string; email: string | null }
  | { ok: false; status: number; code: string; error: string };

const ADDRESS_RE = /^0x[0-9a-fA-F]{40}$/;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/**
 * Turn what the owner typed into a wallet. An address is validated and checksummed; an email is
 * resolved through Privy's directory to that person's EMBEDDED wallet, which exists only once
 * they have signed in to WALLETCHI at least once. Nothing here proves the recipient wants the
 * pet, and nothing needs to: the recipient can always act from that wallet, and a pet is never
 * stranded by landing in an address whose keeper has not claimed it yet.
 */
export async function resolveGiftRecipient(raw: string): Promise<GiftRecipient> {
  const input = raw.trim();
  if (ADDRESS_RE.test(input)) {
    let address: string;
    try {
      address = getAddress(input).toLowerCase();
    } catch {
      return { ok: false, status: 400, code: "bad_recipient", error: "That wallet address is not valid." };
    }
    if (/^0x0{40}$/.test(address)) {
      return { ok: false, status: 400, code: "bad_recipient", error: "That wallet address is not valid." };
    }
    return { ok: true, address, email: null };
  }
  if (!EMAIL_RE.test(input) || input.length > 320) {
    return {
      ok: false,
      status: 400,
      code: "bad_recipient",
      error: "Enter the email they sign in with, or their wallet address.",
    };
  }
  const email = input.toLowerCase();
  const lookup = await lookupPrivyWalletByEmail(email);
  if (!lookup.ok) {
    return {
      ok: false,
      status: 503,
      code: "unavailable",
      error: "We could not look that email up right now. Please try again in a moment.",
    };
  }
  if (!lookup.address) {
    return {
      ok: false,
      status: 400,
      code: "recipient_unknown",
      error:
        "Nobody has signed in to WALLETCHI with that email yet. Ask them to sign in once at " +
        `${new URL(config.WEB_APP_URL).host}/me, then send the gift.`,
    };
  }
  return { ok: true, address: lookup.address.toLowerCase(), email };
}

// Test hook: clear every in-process gift table between check scenarios.
export function _resetGiftState(): void {
  intentsByToken.clear();
  intentsById.clear();
  sponsorHits.clear();
}
