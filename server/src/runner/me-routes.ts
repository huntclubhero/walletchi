import { Router } from "express";
import { z } from "zod";
import { config } from "../config.js";
import { logger } from "../logger.js";
import type { AppContext } from "../context.js";
import type { Runner } from "../store/types.js";
import { runnerNumber } from "./theme.js";
import { runnerPassDownloadUrl } from "./pass.js";
import { getRunnerGoogle } from "./google.js";
import {
  petLiveStatus,
  isPetDead,
  rotateRunnerAuth,
  cachedPetOwnersOf,
  claimRateHit,
  byOwnerRateHit,
  rotationRateHit,
  freshOwnerOf,
  isPlaceholderEmail,
} from "./claim.js";
import { scanPending } from "./rewards.js";
import {
  cachedPetNeeds,
  getVaultConfig,
  needsSecondsLeft,
  NEED_ACTIONS,
  NEED_LABELS,
} from "./season.js";
import {
  verifyPrivyToken,
  getPrivyUserWallets,
  lookupPrivyUserEmail,
  lookupPrivyUserProfile,
  deletePrivyUser,
} from "../services/privy.js";
import { subjectTag } from "./sybil.js";
import { adoptPet, adoptUnrecordedPets } from "./adopt.js";
import { sealSessionKeyAsync, sessionVerdict, probeGrantScope } from "./session-care.js";
import { privateKeyToAccount } from "viem/accounts";
import type { Hex } from "viem";
import { clientIp, rateKey } from "../util/client-ip.js";
import { wrap } from "../util/async-handler.js";
import { careBudgetReportWithin, EMPTY_CARE_BUDGET } from "./care-budget-read.js";
import { reconcileOnChainCare, pushRunnerPass } from "./idle.js";
import { encodeFunctionData, getAddress } from "viem";
import {
  prepareGiftIntent,
  giftIntentById,
  settleGiftIntent,
  watchGiftLanding,
  resolveGiftRecipient,
  GIFT_INTENT_TTL_MS,
} from "./gift.js";

// F2/F4 on-site pet management (the /me dashboard). Endpoints:
//
//   GET  /api/pets/by-owner?address=0x..   public read: the pets an address owns
//                                          (on-chain ownerOf is the truth; same
//                                          enumeration the wallet claim uses).
//   POST /api/pet/care                     RETIRED (410 Gone): care() is
//                                          OWNER-ONLY on-chain now, so the
//                                          server can no longer relay care. The
//                                          web care page sends the owner's
//                                          signed care straight to the vault.
//   POST /api/pet/pass-link                Privy ownership proof -> the pet's
//                                          capability pass URLs. Equivalent in
//                                          strength to the SIWE wallet claim
//                                          (Privy attests wallet control), so it
//                                          rotates like a claim when the pet
//                                          changed hands.
//   POST /api/pet/:tokenId/rotate-links    Owner-requested rotation ("Reset my
//                                          pass links"): the claim rotation with
//                                          the owner unchanged, one per pet per
//                                          10 minutes. Returns the fresh links.
//   POST /api/pet/:tokenId/gift/prepare    "Gift this pet": the owner names a
//                                          recipient (email or address); the
//                                          server records the intent the gas
//                                          webhook will fund and returns the
//                                          transferFrom call to sign.
//   GET  /api/pet/:tokenId/gift/:intentId  Progress of a prepared gift (settles
//                                          it against a fresh ownerOf read).
//
// SECURITY: the authed wallet set always comes from Privy's getUser (server to
// server), NEVER from a client-asserted address. The body walletAddress field
// exists ONLY for the stub posture (Privy creds absent) and that posture is
// fail-secure: it is refused outright whenever real-value care is possible.

const CareBody = z.object({
  tokenId: z.string().regex(/^[0-9]+$/, "invalid pet number"),
  action: z.string().min(1).max(16),
  privyToken: z.string().optional(),
  // Stub-mode only (dev / smoke); ignored entirely when Privy is live.
  walletAddress: z.string().regex(/^0x[0-9a-fA-F]{40}$/).optional(),
});

const PassLinkBody = CareBody.omit({ action: true });

// Owner-auth body: the auth inputs care uses, with no action of its own (Privy
// token; the walletAddress is stub-mode only and ignored when Privy is live).
// The tokenId rides the URL.
const OwnerAuthBody = z.object({
  privyToken: z.string().optional(),
  walletAddress: z.string().regex(/^0x[0-9a-fA-F]{40}$/).optional(),
});

// Install body for the on-chain scoped care session. The client generated the
// session key locally and had the owner sign the grant for it, so it hands us
// both halves: the key (which we seal) and the grant's permissions context
// (opaque; Alchemy resolves it to the on-chain deferred action).
const CareSessionBody = OwnerAuthBody.extend({
  sessionKey: z.string().regex(/^0x[0-9a-fA-F]{64}$/, "invalid session key"),
  publicKey: z.string().regex(/^0x[0-9a-fA-F]{40}$/, "invalid session key address"),
  context: z.string().regex(/^0x[0-9a-fA-F]{2,4096}$/, "invalid permissions context"),
  expiresAtSec: z.number().int().positive().max(9999999999),
});

const REWARDS_CACHE_TTL_MS = 30_000;

// NO CHI, NO SIGN-IN: sign-ins whose Privy seat is never released. The house list is exactly
// what the ops sweep (walletchi-ops/privy-sweep-empty.cjs) protects: every @halldon.com address
// and Hunt's personal one. PROTECTED_SIGNIN_EMAILS adds more, comma separated.
const HOUSE_PROTECTED_SIGNIN = /@halldon\.com$|^owner@example\.com$/i;
export function isProtectedSignIn(email: string | null): boolean {
  if (!email) return false;
  const e = email.trim().toLowerCase();
  if (HOUSE_PROTECTED_SIGNIN.test(e)) return true;
  return (config.PROTECTED_SIGNIN_EMAILS ?? "")
    .split(",")
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean)
    .includes(e);
}

const ReleaseSeatBody = z.object({
  privyToken: z.string().optional(),
});

// Mirror of routes.ts realValueCarePossible: fail-secure on SURVIVAL_ENABLED
// alone so a half-configured mainnet deployment never opens the stub auth path.
function realValueCarePossible(): boolean {
  return Boolean(config.SURVIVAL_ENABLED) || config.modes.survivalLive;
}

type AuthedOwner =
  | { ok: true; runner: Runner; wallet: string; wallets: string[]; privyUserId?: string }
  | { ok: false; status: number; error: string; code: string; retryable?: boolean };

/** Send an authedOwnerFor refusal. A retryable one (the fresh ownership read was down) carries
 *  `retryable: true` and a Retry-After, so a client can tell "try again" from "you are not the owner". */
function sendAuthFailure(res: import("express").Response, auth: Extract<AuthedOwner, { ok: false }>) {
  if (auth.retryable) res.setHeader("Retry-After", "5");
  return res.status(auth.status).json({ error: auth.error, code: auth.code, ...(auth.retryable ? { retryable: true } : {}) });
}

// Per-need countdowns for one owned pet, in canonical action order (clients sort
// for display). SAME GATES as the runner-state payload: omitted for a dormant
// egg (no timers yet) and for a dead pet (frozen stamps would show phantom
// hours), and best effort, so a chain blip just falls back to the DB meters.
// Cheap: cachedPetNeeds coalesces and caches for 5s, and a wallet holds one pet.
async function ownedPetNeeds(
  ctx: AppContext,
  p: Runner,
  status: string,
): Promise<{ needs?: { action: string; label: string; secondsLeft: number }[] }> {
  if (!config.modes.survivalLive || !p.tokenId || !p.hatched || p.gone || status === "dead") {
    return {};
  }
  try {
    const [{ needAt }, vcfg] = await Promise.all([
      cachedPetNeeds(ctx, p.tokenId),
      getVaultConfig(ctx),
    ]);
    if (!needAt.some((t) => t > 0)) return {};
    const left = needsSecondsLeft(needAt, vcfg.lifeTtlSeconds, Math.floor(Date.now() / 1000));
    return {
      needs: NEED_ACTIONS.map((action, i) => ({
        action,
        label: NEED_LABELS[i]!,
        secondsLeft: left[i]!,
      })),
    };
  } catch {
    return {};
  }
}

export function meRouter(ctx: AppContext): Router {
  const r = Router();

  // Resolve the pet + prove the caller's Privy session controls its CURRENT
  // on-chain owner wallet. Shared by care + pass-link. AUTH RUNS FIRST: an
  // unauthenticated caller gets 401 whether or not the tokenId exists, so
  // these endpoints are not a pet-number existence oracle.
  async function authedOwnerFor(
    tokenId: string,
    privyToken: string | undefined,
    stubWallet: string | undefined,
  ): Promise<AuthedOwner> {
    let wallets: string[];
    let privyUserId: string | undefined;
    if (config.modes.privyLive) {
      if (!privyToken) {
        return { ok: false, status: 401, error: "Sign in to care for your pet.", code: "unauthorized" };
      }
      const auth = await verifyPrivyToken(privyToken);
      if (!auth.ok) {
        return { ok: false, status: 401, error: "Your session expired. Sign in again.", code: "unauthorized" };
      }
      privyUserId = auth.userId;
      wallets = (await getPrivyUserWallets(auth.userId)) ?? [];
      if (wallets.length === 0) {
        return {
          ok: false,
          status: 403,
          error: "No wallet is linked to your account yet. Sign in again to finish setup.",
          code: "no_wallet",
        };
      }
    } else {
      // Privy is stubbed. NEVER allow the asserted-wallet fallback where care
      // moves real value: without token verification an asserted address would
      // let anyone spend any pet's tank.
      if (realValueCarePossible()) {
        return {
          ok: false,
          status: 503,
          error: "Signed-in care is not open yet. Please try again soon.",
          code: "unavailable",
        };
      }
      if (!stubWallet) {
        return { ok: false, status: 401, error: "Sign in to care for your pet.", code: "unauthorized" };
      }
      logger.warn(
        { tokenId, wallet: stubWallet },
        "PRIVY STUB: accepting asserted wallet for on-site care (demo posture only)",
      );
      wallets = [stubWallet.toLowerCase()];
    }

    // A pet minted outside the site (or one the server never recorded) is adopted from the
    // chain here, so its owner can still sign in and claim it. See adopt.ts.
    let runner: Runner | null;
    try {
      runner = await adoptPet(ctx, tokenId);
    } catch {
      return {
        ok: false,
        status: 503,
        error: "We could not verify ownership right now. Please try again in a moment.",
        code: "ownership_unavailable",
        retryable: true,
      };
    }
    if (!runner) {
      return { ok: false, status: 404, error: "We could not find that pet.", code: "not_found" };
    }

    // Current-owner check. EVERY caller of this function is a state-changing request (installing
    // or revoking a spending session, issuing or rotating pass links), so this is the Wallet Pass
    // Extension's fresh entitlement read: taken now, FAIL CLOSED after one short retry, and never
    // answered from a cached or last-known-good owner, which is what the pet's seller looks like
    // for a cache lifetime after a sale. The owner-of-record fallback survives only while survival
    // is off (the pre-deploy custodial demo), where there is no chain to read and nothing to spend.
    let owner: string;
    if (config.modes.survivalLive) {
      try {
        owner = await freshOwnerOf(ctx, tokenId);
      } catch {
        return {
          ok: false,
          status: 503,
          error: "We could not verify ownership right now. Please try again in a moment.",
          code: "ownership_unavailable",
          retryable: true,
        };
      }
    } else {
      try {
        owner = await ctx.relayer.petOwnerOf(tokenId);
      } catch (err) {
        logger.debug({ err: String(err), tokenId }, "demo ownerOf read unavailable; using record");
        owner = runner.ownerAddress;
      }
    }
    if (!wallets.includes(owner.toLowerCase())) {
      return {
        ok: false,
        status: 403,
        error: "Your signed-in wallet does not own this pet.",
        code: "not_owner",
      };
    }
    return { ok: true, runner, wallet: owner.toLowerCase(), wallets, privyUserId };
  }

  // The pets an address currently owns, resolved against on-chain ownerOf (DB
  // owner-of-record fallback when Pet721 is not configured). Everything in the
  // response is already public via the pet page / metadata; no capability URLs.
  // Each request is O(minted pets) ownerOf resolution, so it is BOUNDED: reads
  // go through the shared 60s owner cache and the endpoint has its own per-IP
  // fixed-window limit (20/min, far above the dashboard's real cadence).
  r.get("/api/pets/by-owner", wrap(async (req, res) => {
    const retryAfter = byOwnerRateHit(`by-owner:${rateKey(clientIp(req))}`);
    if (retryAfter !== null) {
      res.setHeader("Retry-After", String(retryAfter));
      return res.status(429).json({
        error: "Too many requests. Please try again in a minute.",
        code: "rate_limited",
      });
    }
    const address = String(req.query.address ?? "");
    if (!/^0x[0-9a-fA-F]{40}$/.test(address)) {
      return res.status(400).json({ error: "invalid EVM address" });
    }
    const wanted = address.toLowerCase();
    // Pick up any on-chain pet the server never recorded before listing (throttled, and a
    // no-op when every minted token has a row).
    await adoptUnrecordedPets(ctx).catch((err) => logger.warn({ err: String(err) }, "by-owner adoption sweep failed"));
    const minted = (await ctx.store.allMintedRunners()).filter((m) => m.tokenId);
    let owners: (string | null)[];
    try {
      owners = await cachedPetOwnersOf(ctx, minted.map((m) => m.tokenId!));
    } catch (err) {
      logger.debug({ err: String(err) }, "by-owner ownersOf read unavailable; using records");
      owners = minted.map((m) => m.ownerAddress);
    }
    const owned = minted.filter((_, i) => owners[i]?.toLowerCase() === wanted);
    const pets = [];
    for (const p of owned) {
      const live = await petLiveStatus(ctx, p);
      pets.push({
        serial: p.serial,
        tokenId: p.tokenId!,
        number: runnerNumber(p.tokenId, p.serial),
        status: live.status,
        ...(live.secondsLeft !== undefined ? { secondsLeft: live.secondsLeft } : {}),
        careCount: live.careCount ?? p.careCount,
        hunger: p.hunger,
        thirst: p.thirst,
        joy: p.joy,
        // FIVE NEEDS, same shape and same gates as the runner-state payload.
        // The dashboard is a care surface: without these it can only draw the
        // three legacy meters, where play/toy/explore collapse into one "joy"
        // bar and the keeper cannot see which clock is about to kill the pet.
        ...(await ownedPetNeeds(ctx, p, live.status)),
        hatched: p.hatched,
        tbaAddress: p.tbaAddress ?? undefined,
        // WALLET BANNER (2026-10-22: 476 pets died in a day, most of them never in any wallet, so
        // no reminder ever reached a phone). apple = a live Apple Wallet registration exists;
        // google = Google's save callback named the pet's current object (unverified, display only).
        wallet: { apple: await ctx.store.hasLiveRunnerRegistration(p.serial), google: Boolean(p.googleSavedAt) },
      });
    }
    res.json({ address, pets });
  }));

  // ====== NO CHI, NO SIGN-IN: release the Privy seat ======
  //
  // Privy creates a user and an embedded wallet at EVERY sign-in, and the app has a hard
  // 150-user cap. On mint day (2026-10-19) the cap was spent by curious sign-ins that never
  // minted, and a sweep script (walletchi-ops/privy-sweep-empty.cjs) deleted the empty accounts
  // 10 to 20 minutes later. This is the sweep's rule at the front door, live: when My pets comes
  // up empty the page tells the visitor they have no Chi, calls this once, and signs them out.
  // The seat is free again before they leave.
  //
  // A WRONG DELETION IS FOREVER: deleting the Privy user destroys the embedded wallet's key
  // material, so a pet sitting in that wallet is orphaned for good (the next sign-in with the
  // same email gets a brand-new user and wallet). Every refusal below exists for that reason.
  //
  // THE RULE, exactly the sweep's: delete ONLY a user none of whose linked wallets (embedded and
  // external, read from Privy server-side, never from the body) owns any pet, alive or dead, as
  // the CHAIN says NOW (a fresh, uncached ownerOf over EVERY minted id), never a protected
  // sign-in, and never an account younger than the sweep's age floor. Everything else is a
  // refusal that deletes nothing:
  //   401 unauthorized                              no verified Privy session (the care check)
  //   200 { released:false, reason:"has_pet" }      a linked wallet owns a pet, or its mint is
  //                                                 still landing (a "minting" row for it)
  //   200 { released:false, reason:"protected" }    house or PROTECTED_SIGNIN_EMAILS address
  //   200 { released:false, reason:"no_wallet" }    no linked wallet yet (still provisioning;
  //                                                 the sweep keeps these too)
  //   200 { released:false, reason:"too_young" }    account younger than
  //                                                 RELEASE_SEAT_MIN_AGE_MINUTES (default 20,
  //                                                 the sweep's MIN_AGE_MIN): "sign in once,
  //                                                 then your friend sends the gift" (gift.ts
  //                                                 recipient_unknown) must keep working
  //   503 { released:false, reason:"unavailable" }  Privy, the season gate or an ownerOf read
  //                                                 could not be taken, or the delete failed:
  //                                                 FAIL CLOSED, the seat stays for the sweep
  //   200 { released:true }                          the Privy user is gone
  //
  // TWO OWNERSHIP PASSES. First the shared 60 s owner cache, as a cheap exit for a keeper whose
  // pet is already known. Then, before any delete, a FRESH uncached petOwnersOf over every id
  // in 1..minted (by a fresh count) plus every recorded id: the cache is what a pet's PREVIOUS
  // owner looks like for up to 60 s after a gift or a sale, and an ops mint has no Runner row
  // for the throttled adoption sweep to have found yet, so neither the cache nor the rows may be
  // the verdict that deletes. by-owner falls back to the owner-of-record when the chain is down;
  // this route does NOT: a minted token always has an owner, so a null in the batch read (the
  // live client swallows a per-token RPC error into null) is a failed read for every id inside
  // 1..minted. Rows from an earlier season can carry ids this one never minted; those revert
  // forever and are ignored only when null.
  //
  // AUTH: the caller can only ever release THEIR OWN seat (the user id is the verified token's
  // subject), so the worst a stolen token can do is sign a no-Chi visitor out a little early.
  // Rate limited per IP in the claim window (20/min): the fresh read is O(minted). One warn
  // line per release with the user id HASH (the anti-Sybil subject tag), never the email, never
  // the raw id. The protected list is by EMAIL: a house member who signs in with an external
  // wallet carries no email and is protected only by the pet that wallet holds.
  r.post("/api/me/release-seat", wrap(async (req, res) => {
    res.setHeader("Cache-Control", "no-store");
    const retryAfter = claimRateHit(`release-seat:${rateKey(clientIp(req))}`);
    if (retryAfter !== null) {
      res.setHeader("Retry-After", String(retryAfter));
      return res.status(429).json({
        released: false,
        reason: "rate_limited",
        error: "Too many requests. Please try again in a minute.",
        code: "rate_limited",
      });
    }
    const unavailable = (why: string) => {
      logger.warn({ why }, "release-seat refused: unavailable (nothing deleted)");
      res.setHeader("Retry-After", "5");
      return res.status(503).json({ released: false, reason: "unavailable", code: "unavailable" });
    };
    // No Privy, no seat to release. The stub posture never deletes anything.
    if (!config.modes.privyLive) return unavailable("privy not configured");
    const parsed = ReleaseSeatBody.safeParse(req.body ?? {});
    if (!parsed.success) {
      return res.status(400).json({ released: false, reason: "bad_request", error: "invalid body", code: "bad_request" });
    }
    const auth = await verifyPrivyToken(parsed.data.privyToken);
    if (!auth.ok || !auth.userId) {
      return res.status(401).json({
        released: false,
        reason: "unauthorized",
        error: "Your session expired. Sign in again.",
        code: "unauthorized",
      });
    }
    const userId = auth.userId;
    const userHash = subjectTag(userId);

    // ONE Privy read answers both "who are they" questions (protected? which wallets?), so the
    // two facts can never come from different answers.
    const profile = await lookupPrivyUserProfile(userId);
    if (!profile.ok) return unavailable("privy profile read failed");
    if (isProtectedSignIn(profile.email)) {
      logger.warn({ userHash }, "release-seat refused: protected sign-in (nothing deleted)");
      return res.json({ released: false, reason: "protected" });
    }
    if (profile.wallets.length === 0) {
      return res.json({ released: false, reason: "no_wallet" });
    }
    // The sweep's age floor. An account Privy cannot date is treated as brand new: the floor
    // is a refusal, and a missing fact must never open the door.
    const minAgeMs = Math.max(0, config.RELEASE_SEAT_MIN_AGE_MINUTES) * 60_000;
    const ageMs = profile.createdAt ? Date.now() - profile.createdAt.getTime() : -1;
    if (ageMs < minAgeMs) {
      return res.json({ released: false, reason: "too_young" });
    }
    const wallets = new Set(profile.wallets);

    // A site mint that has not finalized yet has no tokenId to look up on-chain, but its row
    // already names the wallet (and the Privy subject) it is landing in. Deleting the user in
    // that window would orphan the pet the moment it lands.
    const landing = (await ctx.store.mintingRunners()).some(
      (m) => wallets.has(m.ownerAddress.toLowerCase()) || m.privyUserHash === userHash,
    );
    if (landing) {
      return res.json({ released: false, reason: "has_pet" });
    }

    // The chain's answer: adopt anything unrecorded, then resolve the owner of EVERY minted id.
    // Any failure along the way is a refusal to decide.
    try {
      await adoptUnrecordedPets(ctx);
    } catch (err) {
      return unavailable(`adoption sweep failed: ${String(err)}`);
    }
    // The minted count is read FRESH (never the cached season gate): a pet minted a moment ago
    // sits above the cached count. One extra read per release, and releases are rare.
    let mintedCount: number;
    try {
      mintedCount = (await ctx.relayer.seasonGate()).minted;
    } catch (err) {
      return unavailable(`season gate read failed: ${String(err)}`);
    }
    if (!Number.isSafeInteger(mintedCount) || mintedCount < 0) return unavailable("season gate count unreadable");
    // EVERY id the chain has minted, whether or not the server has a row for it yet (an ops mint
    // writes no row, and the adoption sweep is throttled behind a cached gate), plus any recorded
    // id outside 1..minted (an earlier season; a null owner there means "never existed").
    const ids = new Set<string>();
    for (let id = 1; id <= mintedCount; id++) ids.add(String(id));
    for (const m of await ctx.store.allMintedRunners()) if (m.tokenId) ids.add(m.tokenId);
    const tokenIds = [...ids];
    // A pet found by either pass answers has_pet. The page then reloads by-owner, which reads
    // the cache and the ROWS, so bring both up to date for the tokens found first: a pet the
    // rows do not know yet (an ops mint) is adopted now against a fresh minted count, and a
    // stale cache entry (a gift that just landed) is re-read. Best effort; the verdict stands.
    const hasPet = async (found: string[], refreshCache: boolean) => {
      for (const t of found) {
        if (refreshCache) await freshOwnerOf(ctx, t).catch(() => undefined);
        await adoptPet(ctx, t, { freshGate: true }).catch(() => undefined);
      }
      return res.json({ released: false, reason: "has_pet" });
    };
    const ownedBy = (owners: (string | null)[]) =>
      tokenIds.filter((_, i) => owners[i] && wallets.has(owners[i]!.toLowerCase()));

    // Cheap pass through the 60 s owner cache: a keeper whose pet is already known exits here.
    let owners: (string | null)[];
    try {
      owners = await cachedPetOwnersOf(ctx, tokenIds);
    } catch (err) {
      return unavailable(`ownersOf read failed: ${String(err)}`);
    }
    const cachedFound = ownedBy(owners);
    if (cachedFound.length > 0) return hasPet(cachedFound, false);
    // THE DELETE-TIME READ IS FRESH. The cache is what a pet's PREVIOUS owner looks like for up
    // to 60 s after a transfer or a gift, and a deletion is forever (the embedded wallet's key
    // goes with the user), so the verdict that deletes is taken against the chain now, uncached,
    // over every id. One O(minted) read per release.
    try {
      owners = await ctx.relayer.petOwnersOf(tokenIds);
    } catch (err) {
      return unavailable(`fresh ownersOf read failed: ${String(err)}`);
    }
    const incomplete = tokenIds.some((t, i) => {
      const id = Number(t);
      return !owners[i] && Number.isSafeInteger(id) && id >= 1 && id <= mintedCount;
    });
    if (incomplete) return unavailable("ownersOf read incomplete");
    const freshFound = ownedBy(owners);
    if (freshFound.length > 0) return hasPet(freshFound, true);

    // Proven: a seat, a wallet or two, and nothing in them. Give the seat back.
    const gone = await deletePrivyUser(userId);
    if (!gone.ok) return unavailable(`privy delete failed: ${gone.error}`);
    logger.warn(
      { userHash, wallets: wallets.size, minted: tokenIds.length },
      "released a Privy seat: signed in with no Chi",
    );
    res.json({ released: true });
  }));

  // F4 RETIRED (trustless cutover): care() is OWNER-ONLY on-chain now, so the
  // dashboard care relay is a dead path (the vault rejects the relayer). The
  // web care page sends the owner's signed care straight to the vault; this
  // stub answers old clients honestly and NEVER touches the pet or the chain.
  r.post("/api/pet/care", (_req, res) => {
    res.status(410).json({
      error: "care is now on-chain (owner-signed); open the pet's care link",
      code: "care_moved",
    });
  });

  // The care budget for the website care page (care-budget-read.ts): smart-care verdict for
  // ?action=, cares left in the 24h window, when it reopens, and how long the pet has. Public and
  // read-only (every number is on-chain already). It NEVER blocks a care: an unknown pet, a failed
  // read or a slow read all answer verdict "ok" with nulls, and the whole read is capped at 2.5 s.
  r.get("/api/pet/:tokenId([0-9]+)/care-budget", wrap(async (req, res) => {
    res.setHeader("Cache-Control", "no-store");
    const q = req.query.action;
    const action = typeof q === "string" && (NEED_ACTIONS as readonly string[]).includes(q) ? q : undefined;
    try {
      const runner = await ctx.store.getRunnerByTokenId(req.params.tokenId!);
      if (!runner) return res.json(EMPTY_CARE_BUDGET);
      res.json(await careBudgetReportWithin(ctx, runner, action));
    } catch {
      res.json(EMPTY_CARE_BUDGET);
    }
  }));

  // ---- SILENT CARE: install the pet's on-chain scoped session key ------------
  //
  // The website has the owner sign ONE Alchemy MAv2 grant that scopes a fresh
  // session key to care(uint256,uint8) on the PetVault and nothing else, then
  // POSTs the key + the grant's permissions context here. From then on a wallet
  // pass tap feeds the pet with no website and no signature.
  //
  // AUTH: identical to every other spending path (verified Privy session whose
  // wallet set contains the pet's CURRENT on-chain owner). Without it a stranger
  // could install a key that makes the pet's pass links dead-end.
  //
  // WHAT WE ARE TRUSTED WITH: only the ability to FEED. The grant's scope is
  // enforced by the account's on-chain validation hooks, so this key cannot move
  // the NFT or the pet's tokens anywhere except through the game's burn/pot
  // split. See runner/session-care.ts for the proof and the honest grief ceiling.
  r.get("/api/pet/:tokenId([0-9]+)/care-session", wrap(async (req, res) => {
    // Public read of whether silent care is ON for this pet: no secret is
    // exposed (never the key, never the context), just the switch state the
    // care page needs to decide between "turn it on" and "already on".
    // Uniform answer for an unknown pet: a 404-vs-200 split here would make this
    // public route an existence oracle over tokenId 1..2000, which the comment above
    // says these endpoints are explicitly not.
    const runner = await ctx.store.getRunnerByTokenId(req.params.tokenId!);
    if (!runner) {
      return res.json({ supported: config.modes.silentCareLive, active: false, reason: "none" });
    }
    const session = await ctx.store.getCareSession(runner.serial);
    const verdict = sessionVerdict(session, {
      vaultAddress: config.PETVAULT_ADDRESS,
      ownerAddress: runner.ownerAddress,
      tokenId: runner.tokenId,
    });
    res.json({
      supported: config.modes.silentCareLive,
      active: verdict.ok,
      // Only "armed or not" is public. The specific reason (wrong_owner, wrong_vault)
      // would tell an enumerator which pets changed hands without being claimed.
      ...(verdict.ok ? { expiresAt: verdict.session.expiresAt.toISOString() } : { reason: "none" }),
    });
  }));

  r.post("/api/pet/:tokenId([0-9]+)/care-session", wrap(async (req, res) => {
    const tokenId = req.params.tokenId!;
    if (!config.modes.silentCareLive) {
      return res.status(503).json({
        error: "One-tap care is not open yet.",
        code: "unavailable",
      });
    }
    const parsed = CareSessionBody.safeParse(req.body ?? {});
    if (!parsed.success) {
      return res.status(400).json({ error: parsed.error.issues[0]?.message ?? "invalid body" });
    }
    const { sessionKey, context, publicKey, expiresAtSec, privyToken, walletAddress } = parsed.data;
    const auth = await authedOwnerFor(tokenId, privyToken, walletAddress);
    if (!auth.ok) {
      return sendAuthFailure(res, auth);
    }
    const runner = auth.runner;
    if (auth.wallet !== runner.ownerAddress.toLowerCase()) {
      // The pet changed hands and has not been claimed here yet. Claiming rotates
      // the pass links; installing a session before that would bind a key to a
      // pass the seller still holds.
      return res.status(409).json({
        error: "Claim this pet first, then turn on one-tap care.",
        code: "claim_first",
      });
    }
    // The key must actually be the one the grant was signed for, or every later
    // tap would fail validation and silently fall back forever.
    if (privateKeyToAccount(sessionKey as Hex).address.toLowerCase() !== publicKey.toLowerCase()) {
      return res.status(400).json({ error: "session key does not match its address", code: "key_mismatch" });
    }
    // Bound the lifetime we honour by our own ceiling even if the client asked
    // for longer: a forgotten key must not outlive the season.
    const maxExpiry = Date.now() + config.CARE_SESSION_TTL_HOURS * 3600 * 1000;
    const expiresAt = new Date(Math.min(expiresAtSec * 1000, maxExpiry));
    if (expiresAt.getTime() <= Date.now()) {
      return res.status(400).json({ error: "session already expired", code: "expired" });
    }
    // Prove the grant really is care-only before we hold the key. Reject-known-bad:
    // an inconclusive probe still installs, so an Alchemy blip cannot lock an honest
    // keeper out, but a genuinely over-scoped grant (the compromised-front-end case)
    // is refused instead of silently trusted.
    const scope = await probeGrantScope({ context, ownerAddress: auth.wallet, tokenId });
    if (scope === "allowed") {
      logger.error(
        { serial: runner.serial, tokenId, publicKey: publicKey.toLowerCase() },
        "REFUSED care session: the grant authorizes calls beyond care() on the vault",
      );
      return res.status(400).json({
        error: "That permission grants more than feeding. We will not hold it.",
        code: "scope_too_broad",
      });
    }
    await ctx.store.putCareSession({
      serial: runner.serial,
      tokenId,
      ownerAddress: auth.wallet,
      vaultAddress: config.PETVAULT_ADDRESS!,
      publicKey: publicKey.toLowerCase(),
      secretEnc: await sealSessionKeyAsync(sessionKey as Hex),
      context,
      expiresAt,
    });
    logger.info(
      { serial: runner.serial, tokenId, publicKey: publicKey.toLowerCase(), expiresAt: expiresAt.toISOString() },
      "care session installed (silent pass-tap care on)",
    );
    res.json({ ok: true, active: true, expiresAt: expiresAt.toISOString() });
    // Mint-time arming HATCHED the pet from the browser a moment ago (its first sponsored
    // care), and nothing on the server has seen that care yet. Fold it in now, so the pass
    // and runner.hatched are current before the keeper's first tap instead of waiting for
    // the idle reconciler. After the response and best effort: a read blip just leaves it
    // to the idle cycle, and reconcile is idempotent.
    void (async () => {
      try {
        const state = await ctx.relayer.petState(tokenId);
        await reconcileOnChainCare(ctx, runner, tokenId, state, new Date());
      } catch (err) {
        logger.debug({ err: String(err), serial: runner.serial }, "post-install care reconcile skipped");
      }
      // The card may be showing the FINISH SETUP nudge (setup-nudge.ts). Push it now: the nudge must
      // go the moment setup is done, not on the next routine refresh. The lastPushAt write is
      // bookkeeping only; the push gate (runner/pass-gate.ts) sees the nudge field go and writes the
      // new version itself, and skips the push when the card did not change.
      try {
        await ctx.store.updateRunner(runner.serial, { lastPushAt: new Date() });
        await pushRunnerPass(ctx, runner.serial);
      } catch (err) {
        logger.debug({ err: String(err), serial: runner.serial }, "post-install pass refresh skipped");
      }
    })();
  }));

  // Turn silent care back off. Owner-gated like the install. This stops the
  // SERVER using the key; the on-chain permission still expires on its own
  // schedule, and the pass links fall back to owner-signed care immediately.
  r.delete("/api/pet/:tokenId([0-9]+)/care-session", wrap(async (req, res) => {
    const tokenId = req.params.tokenId!;
    const parsed = OwnerAuthBody.safeParse(req.body ?? {});
    if (!parsed.success) {
      return res.status(400).json({ error: parsed.error.issues[0]?.message ?? "invalid body" });
    }
    const auth = await authedOwnerFor(tokenId, parsed.data.privyToken, parsed.data.walletAddress);
    if (!auth.ok) {
      return sendAuthFailure(res, auth);
    }
    await ctx.store.revokeCareSession(auth.runner.serial, "owner turned one-tap care off");
    logger.info({ serial: auth.runner.serial, tokenId }, "care session revoked by owner");
    res.json({ ok: true, active: false });
  }));

  // Add-to-wallet for a signed-in owner: the same proof as care, returning the
  // pet's capability pass URLs. When the pet changed hands since our record
  // (bought on a marketplace, then signed in here) this IS a claim: rotate the
  // authToken exactly like the SIWE path so the seller's pass + links die.
  r.post("/api/pet/pass-link", wrap(async (req, res) => {
    const parsed = PassLinkBody.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ error: parsed.error.issues[0]?.message ?? "invalid body" });
    }
    const { tokenId, privyToken, walletAddress } = parsed.data;
    const auth = await authedOwnerFor(tokenId, privyToken, walletAddress);
    if (!auth.ok) {
      return sendAuthFailure(res, auth);
    }
    let runner = auth.runner;
    if (await isPetDead(ctx, runner)) {
      return res.status(409).json({
        error: "This pet is a soulbound memorial. Its pass stays where it is.",
        code: "dead_soulbound",
      });
    }
    // The email the keeper signed in with is Privy-attested, so it becomes the pet's contact
    // on claim: receipts and re-delivery reach the new owner with nothing to type. Best effort;
    // a failed lookup leaves the contact as it was.
    const attested = await lookupPrivyUserEmail(auth.privyUserId).catch(() => null);
    const signedInEmail = attested?.ok && attested.email ? attested.email.trim().toLowerCase() : undefined;
    if (auth.wallet !== runner.ownerAddress.toLowerCase()) {
      runner = await rotateRunnerAuth(ctx, runner, { newOwnerAddress: auth.wallet, newOwnerEmail: signedInEmail });
      logger.info(
        { serial: runner.serial, tokenId, newOwner: auth.wallet, emailOnFile: Boolean(signedInEmail) },
        "pet claimed (privy sign-in): authToken rotated",
      );
    } else if (signedInEmail && isPlaceholderEmail(runner.email)) {
      runner = await ctx.store.updateRunner(runner.serial, { email: signedInEmail });
    }
    const applePassUrl = runnerPassDownloadUrl(runner.serial, runner.authToken);
    let googleSaveUrl: string | null = null;
    try {
      googleSaveUrl = await getRunnerGoogle().saveUrl(runner);
    } catch (err) {
      logger.warn({ err: String(err), serial: runner.serial }, "google save url failed on privy pass-link");
    }
    res.json({ applePassUrl, ...(googleSaveUrl ? { googleSaveUrl } : {}) });
  }));

  // ---- ROTATION ON THE OWNER'S REQUEST ("Reset my pass links") -----------------
  //
  // Wallet Pass Extension, capability configuration: acquisition URLs and action
  // links MUST rotate on the owner's request, because under an UNCHANGED owner
  // that is the only remedy for a leaked link (a screenshot of the pass back, a
  // forwarded receipt email, a shared .pkpass). Until now the per-pass secret
  // rotated only when a new owner claimed; a leaked link stayed live for the
  // life of the pet.
  //
  // This is the claim rotation, reused verbatim (rotateRunnerAuth): the old
  // authToken dies (every HMAC care link and the .pkpass capability URL with it),
  // the previous token is kept in the keepsake registry so the old card refreshes
  // into a LINKS RESET keepsake (and can still deregister), APNs + the Google
  // PATCH fire, and the response carries the fresh acquisition URLs in the same
  // shape as pass-link. The owner-of-record, email and care session are
  // untouched: the owner did not change.
  //
  // AUTH: authedOwnerFor, the same helper as the care-session install/revoke and
  // pass-link routes: verified Privy session whose wallet set contains the pet's
  // CURRENT on-chain owner from a FRESH ownerOf read that fails closed. Ownership
  // is checked BEFORE the per-pet limiter is charged, so a stranger cannot spend
  // the owner's window. A proven owner who is not yet the owner of record (bought
  // on a marketplace, never claimed here) is rotated as a claim instead, which is
  // the same rotation with the record rebound.
  r.post("/api/pet/:tokenId([0-9]+)/rotate-links", wrap(async (req, res) => {
    const tokenId = req.params.tokenId!;
    const parsed = OwnerAuthBody.safeParse(req.body ?? {});
    if (!parsed.success) {
      return res.status(400).json({ error: parsed.error.issues[0]?.message ?? "invalid body" });
    }
    const auth = await authedOwnerFor(tokenId, parsed.data.privyToken, parsed.data.walletAddress);
    if (!auth.ok) {
      return sendAuthFailure(res, auth);
    }
    let runner = auth.runner;
    if (await isPetDead(ctx, runner)) {
      // A memorial pass carries no live links, so there is nothing to rotate.
      return res.status(409).json({
        error: "This pet is a soulbound memorial. Its pass stays where it is.",
        code: "dead_soulbound",
      });
    }
    const retryAfter = rotationRateHit(runner.serial);
    if (retryAfter !== null) {
      res.setHeader("Retry-After", String(retryAfter));
      return res.status(429).json({
        error: "These links were reset a moment ago. Please wait a few minutes before resetting them again.",
        code: "rate_limited",
        retryAfterSeconds: retryAfter,
      });
    }
    const firstClaim = auth.wallet !== runner.ownerAddress.toLowerCase();
    runner = await rotateRunnerAuth(
      ctx,
      runner,
      firstClaim ? { newOwnerAddress: auth.wallet } : { reason: "reset" },
    );
    logger.info(
      { serial: runner.serial, tokenId, owner: auth.wallet, firstClaim },
      "pass links rotated on owner request",
    );
    const applePassUrl = runnerPassDownloadUrl(runner.serial, runner.authToken);
    let googleSaveUrl: string | null = null;
    try {
      // saveUrl upserts the Google object (PATCH when it exists) with the links
      // signed by the NEW token, so the Android card is fresh the moment it is saved.
      googleSaveUrl = await getRunnerGoogle().saveUrl(runner);
    } catch (err) {
      logger.warn({ err: String(err), serial: runner.serial }, "google save url failed on link rotation");
    }
    res.json({ ok: true, rotated: true, applePassUrl, ...(googleSaveUrl ? { googleSaveUrl } : {}) });
  }));

  // ---- "GIFT THIS PET" (owner-signed, gas-sponsored ERC-721 transfer) --------------
  //
  // See runner/gift.ts for the whole argument. In short: holders have embedded
  // wallets with no ETH and no transfer UI, so a gift is a sponsored user
  // operation from the owner's 7702 smart account calling
  // Pet721.transferFrom(owner, recipient, tokenId). The gas webhook funds ONLY a
  // transfer that matches an intent prepared here, so this route is where the
  // recipient is resolved and the rule's inputs are pinned.
  //
  // AUTH: authedOwnerFor, like rotate-links: verified Privy session whose wallet
  // set contains the pet's CURRENT on-chain owner from a fresh ownerOf read that
  // fails closed. The op the client signs must come from that owner, and the
  // session key the server holds for one-tap care can NEVER be the signer: its
  // on-chain scope is care() on the vault and nothing else (session-care.ts).
  //
  // REFUSALS, in order: 401 no session, 403 not the owner, 404 unknown pet, 409
  // memorial (a dead pet is soulbound and the token would revert PetIsDead
  // anyway; refusing here keeps the keeper off a signature that cannot land),
  // 400 bad or unknown recipient, 400 gifting to yourself (any wallet of the
  // signed-in session, or the pet's own account), 503 when the token contract
  // is not configured or the recipient directory is down.
  const GiftPrepareBody = OwnerAuthBody.extend({
    recipient: z.string().trim().min(1).max(320),
  });
  const TRANSFER_FROM_ABI = [
    {
      type: "function",
      name: "transferFrom",
      stateMutability: "nonpayable",
      outputs: [],
      inputs: [
        { name: "from", type: "address" },
        { name: "to", type: "address" },
        { name: "tokenId", type: "uint256" },
      ],
    },
  ] as const;

  r.post("/api/pet/:tokenId([0-9]+)/gift/prepare", wrap(async (req, res) => {
    const tokenId = req.params.tokenId!;
    if (claimRateHit(`gift-prepare:${rateKey(clientIp(req))}`) !== null) {
      res.setHeader("Retry-After", "60");
      return res.status(429).json({ error: "Too many requests. Please try again in a minute.", code: "rate_limited" });
    }
    const parsed = GiftPrepareBody.safeParse(req.body ?? {});
    if (!parsed.success) {
      return res.status(400).json({ error: parsed.error.issues[0]?.message ?? "invalid body", code: "bad_request" });
    }
    const auth = await authedOwnerFor(tokenId, parsed.data.privyToken, parsed.data.walletAddress);
    if (!auth.ok) {
      return sendAuthFailure(res, auth);
    }
    const runner = auth.runner;
    if (await isPetDead(ctx, runner)) {
      return res.status(409).json({
        error: "This pet is a soulbound memorial. It has passed on and cannot be given away.",
        code: "dead_soulbound",
      });
    }
    const pet721 = config.pet721Address;
    if (!pet721) {
      return res.status(503).json({ error: "Gifting is not open yet. Please try again soon.", code: "unavailable" });
    }
    const recipient = await resolveGiftRecipient(parsed.data.recipient);
    if (!recipient.ok) {
      if (recipient.status === 503) res.setHeader("Retry-After", "5");
      return res.status(recipient.status).json({ error: recipient.error, code: recipient.code });
    }
    // Gifting to yourself moves nothing worth a sponsored op: the same session's other wallet,
    // the current owner, or the pet's own token-bound account (which the token refuses as a
    // recipient, so it would only burn gas).
    const selfWallets = new Set([auth.wallet, ...auth.wallets.map((w) => w.toLowerCase())]);
    if (runner.tbaAddress) selfWallets.add(runner.tbaAddress.toLowerCase());
    if (selfWallets.has(recipient.address)) {
      return res.status(400).json({
        error: "That is your own wallet. A gift needs someone else's email or address.",
        code: "self_gift",
      });
    }
    const intent = prepareGiftIntent({
      tokenId,
      serial: runner.serial,
      from: auth.wallet,
      to: recipient.address,
      toEmail: recipient.email,
    });
    watchGiftLanding(ctx, intent);
    logger.info(
      { serial: runner.serial, tokenId, from: auth.wallet, to: recipient.address, byEmail: Boolean(recipient.email), intentId: intent.id },
      "gift prepared",
    );
    const data = encodeFunctionData({
      abi: TRANSFER_FROM_ABI,
      functionName: "transferFrom",
      args: [getAddress(auth.wallet), getAddress(recipient.address), BigInt(tokenId)],
    });
    res.json({
      ok: true,
      intentId: intent.id,
      tokenId,
      from: auth.wallet,
      to: recipient.address,
      ...(recipient.email ? { recipientEmail: recipient.email } : {}),
      // The exact call the owner's smart account executes: execute(pet721, 0, data). The webhook
      // decodes it back to (from, to, tokenId) and matches it against the intent above.
      call: { to: pet721, data },
      expiresAt: new Date(intent.expiresAt).toISOString(),
      ttlSeconds: Math.floor(GIFT_INTENT_TTL_MS / 1000),
      claimUrl: `${config.WEB_APP_URL}/claim`,
    });
  }));

  // Progress of a prepared gift. Keyed on the unguessable intent id, so it reveals nothing an
  // enumerator could use; the id exists only in the preparing owner's response. Settles the
  // intent on demand (fresh ownerOf), so the page sees "landed" the moment the chain does and
  // does not depend on the background watcher's cadence.
  r.get("/api/pet/:tokenId([0-9]+)/gift/:intentId([0-9a-f]{32})", wrap(async (req, res) => {
    if (claimRateHit(`gift-status:${rateKey(clientIp(req))}`) !== null) {
      res.setHeader("Retry-After", "60");
      return res.status(429).json({ error: "Too many requests. Please try again in a minute.", code: "rate_limited" });
    }
    const intent = giftIntentById(req.params.intentId!);
    if (!intent || intent.tokenId !== req.params.tokenId) {
      return res.status(404).json({ error: "We could not find that gift.", code: "not_found" });
    }
    const status = await settleGiftIntent(ctx, intent);
    res.setHeader("Cache-Control", "no-store");
    res.json({
      status,
      tokenId: intent.tokenId,
      to: intent.to,
      approvals: intent.approvals,
      ...(intent.landedAt ? { landedAt: new Date(intent.landedAt).toISOString() } : {}),
      claimUrl: `${config.WEB_APP_URL}/claim`,
    });
  }));

  // Player rewards, INFORMATIONAL ONLY (season 2, no claims).
  //
  // The CareRewardsDistributor pays 20% of every care into per-epoch pools, paid
  // pro rata INTO each pet's TBA. Nobody claims them: the 2h push engine
  // (runner/push-rewards.ts) delivers them, so this read exists to show an owner
  // what has accrued and is on its way, not to offer a button. When
  // config.modes.rewardsLive is false it returns { rewardsLive:false } and the
  // panel shows a warming state rather than an error.
  //
  // The JSON keys still say "claimable" because the web client reads them by that
  // name; the value is a pending amount awaiting the next push.

  // Per-tokenId read cache: scanning the epoch window is a burst of view reads and
  // marketplace/dashboard polls repeat, so bound it like the metadata Care Balance.
  const rewardsCache = new Map<string, { body: unknown; at: number }>();

  // GET a pet's pending rewards. Public read (pending rewards are on-chain
  // public); the panel shows them for the owner's pets. Warming state when the
  // distributor is not configured.
  r.get("/api/pet/:tokenId([0-9]+)/rewards", wrap(async (req, res) => {
    const tokenId = req.params.tokenId!;
    // Bound the id to real supply. scanPending is ~31 RPC reads per uncached id, and an
    // unbounded public id is a free cache-busting amplifier: the preview.png route already
    // bounds ids for exactly this reason and this one was missed. Dark today because
    // rewardsLive is false, live the moment the distributor is wired.
    const idNum = Number(tokenId);
    if (!Number.isSafeInteger(idNum) || idNum < 1 || idNum > config.RUNNER_SUPPLY_CAP) {
      return res.status(404).json({ error: "not found", code: "not_found" });
    }
    if (!config.modes.rewardsLive) {
      return res.json({ rewardsLive: false });
    }
    const hit = rewardsCache.get(tokenId);
    if (hit && Date.now() - hit.at < REWARDS_CACHE_TTL_MS) {
      res.setHeader("Cache-Control", "public, max-age=15");
      return res.json(hit.body);
    }
    const decimals = await ctx.relayer.careTokenDecimals();
    const base = 10n ** BigInt(Math.max(0, decimals));
    // ONE CARE distributor now holds BOTH the 20% care-recycling slice AND the
    // swapped player half of the fee stream, so this single read covers all player
    // rewards (the separate fee-leg surface was removed in the audit rework).
    const { epochNow, pending } = await scanPending(ctx, tokenId);
    const totalRaw = pending.reduce((a, c) => a + c.raw, 0n);
    const body = {
      rewardsLive: true,
      epochNow,
      // Key names kept for the web client (web-cub reads claimable /
      // totalClaimableWhole); these are PENDING amounts, not a claim offer.
      claimable: pending.map((c) => ({
        epoch: c.epoch,
        amount: { whole: Number(c.raw / base), raw: c.raw.toString() },
      })),
      totalClaimableWhole: Number(totalRaw / base),
      careTokenDecimals: decimals,
    };
    rewardsCache.set(tokenId, { body, at: Date.now() });
    if (rewardsCache.size > 4000) rewardsCache.clear(); // bounded (2k pets worst case)
    res.setHeader("Cache-Control", "public, max-age=15");
    res.json(body);
  }));

  // RETIRED CLAIM (season 2, no claims). Nobody claims a reward any more: the 2h
  // push engine (runner/push-rewards.ts) pays every pet that earned an epoch
  // straight into its own account, and the calls it makes are permissionless, so
  // an outage of ours delays delivery and strands nothing. This answers 410 Gone
  // with a machine code, like the retired care relays, and never touches the pet
  // or the chain. Same shape as care_moved in routes.ts.
  // ONE-TAP ARMING FAILURE BEACON (2026-09-23). Mint-time arming failed for tester Pretzel's pet
  // with the reason visible only in the keeper's own browser console, so the logs showed nothing
  // but an absence and the cause took a tester's screenshot to find. The client (lib/arming.ts)
  // now reports every arming failure here: the surface it ran on, the stage it died at, and the
  // real error detail. LOG-ONLY and unauthenticated on purpose: it changes nothing, reveals
  // nothing, and is bounded (validated shape, capped strings, per-IP rate limit), so the worst a
  // stranger can do is add a short log line.
  const ArmingReport = z.object({
    surface: z.enum(["mint", "care", "me"]),
    stage: z.string().regex(/^[a-z-]{1,24}$/),
    detail: z.string().max(500),
    owner: z.string().regex(/^0x[0-9a-fA-F]{40}$/).optional(),
  });
  r.post("/api/pet/:tokenId([0-9]+)/arming-report", (req, res) => {
    if (claimRateHit(`arming-report:${rateKey(clientIp(req))}`) !== null) return res.status(429).end();
    const parsed = ArmingReport.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: "invalid report" });
    logger.warn(
      { tokenId: req.params.tokenId, ...parsed.data },
      "one-tap arming failed (client report)",
    );
    return res.status(204).end();
  });

  r.post("/api/pet/:tokenId([0-9]+)/rewards/claim", (_req, res) => {
    res.status(410).json({
      error: "rewards are pushed to your pet automatically now",
      code: "rewards_pushed",
    });
  });

  return r;
}
