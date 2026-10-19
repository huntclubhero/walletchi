import { randomBytes, randomUUID } from "node:crypto";
import { logger } from "../logger.js";
import type { AppContext } from "../context.js";
import type { Runner } from "../store/types.js";
import { getSeasonGate } from "./season.js";
import { freshOwnerOf } from "./claim.js";

// ADOPTION: a pet that exists on-chain but has no server record.
//
// Every site surface (dashboard, email claim, wallet claim, care page) starts from the
// server's Runner row, and only a site mint writes one. A pet minted any other way (an
// ops script, a direct issuer call) was invisible everywhere even though Pet721 says
// who owns it: the email path answered "We could not find that pet number" and the
// owner's dashboard came up empty. House pet No. 0159 hit exactly this on 2026-10-16.
//
// Adoption builds the missing row from the chain: token id, its ERC-6551 account and
// the current on-chain owner. The email is the wallet placeholder (never counts as
// "on file"), so adoption grants nothing by itself; every ownership check downstream
// still reads the chain. Game state lives in the vault and is read live as for any pet.

// One adoption per token at a time: Runner.tokenId is not unique in the schema, so two
// concurrent first lookups must share one create instead of racing two rows in.
const inFlight = new Map<string, Promise<Runner | null>>();

/**
 * The Runner row for an on-chain pet, creating it from chain state when the server has
 * none. Null when the token does not exist (beyond the minted count). Throws
 * OwnershipUnavailableError when the chain cannot be read, so callers fail retryably
 * instead of telling a real owner their pet does not exist.
 */
export async function adoptPet(ctx: AppContext, tokenId: string): Promise<Runner | null> {
  const existing = await ctx.store.getRunnerByTokenId(tokenId);
  if (existing) return existing;
  const pending = inFlight.get(tokenId);
  if (pending) return pending;
  const work = adoptOnce(ctx, tokenId).finally(() => inFlight.delete(tokenId));
  inFlight.set(tokenId, work);
  return work;
}

async function adoptOnce(ctx: AppContext, tokenId: string): Promise<Runner | null> {
  // Re-check inside the single flight: the row may have landed since the caller looked.
  const again = await ctx.store.getRunnerByTokenId(tokenId);
  if (again) return again;

  // Token ids run 1..minted. Anything outside that range is a typo, not an orphan, and
  // must not cost a chain read per guess.
  const id = Number(tokenId);
  const gate = await getSeasonGate(ctx).catch(() => null);
  if (!gate || !Number.isSafeInteger(id) || id < 1 || id > gate.minted) return null;

  // A site mint lands on-chain a moment before finalizeMint writes its tokenId onto the row.
  // Adopting inside that window would give one token two rows. While any site mint is in
  // flight, wait: the next lookup or idle cycle adopts once the row has settled.
  if ((await ctx.store.stuckMintingRunners(new Date())).length > 0) return null;

  const owner = await freshOwnerOf(ctx, tokenId);
  const tbaAddress = await ctx.relayer.tokenAccountOf(tokenId);
  // A never-fed egg has no care stamp; anything fed has hatched. The idle reconcile owns
  // every later flip (hatch, death, memorial) exactly as for a site-minted pet.
  const life = await ctx.relayer.petState(tokenId);

  const runner = await ctx.store.createRunner({
    serial: randomUUID(),
    tokenId,
    tbaAddress,
    ownerAddress: owner.toLowerCase(),
    email: `${owner.toLowerCase()}@wallet.walletchi.local`,
    bestScore: 0,
    salmon: 0,
    runs: 0,
    authToken: randomBytes(24).toString("hex"),
    status: "ready",
    issueTxHash: null,
    issueNonce: null,
    failureReason: null,
    idleSalmon: 0,
    lastTickAt: null,
    lastEvent: null,
    lastPushAt: null,
    lastIdleCatchAt: null,
    pendingDigest: 0,
    lastHoneyAt: null,
    lastFishAt: null,
    lastExploreAt: null,
    pendingSalmon: 0,
    activeFork: null,
    forkExpiresAt: null,
    hunger: 100,
    thirst: 100,
    joy: 100,
    lastNeedsAt: null,
    lastCareAt: null,
    lastWaterAt: null,
    lastWanderPingAt: null,
    lastPlayAt: null,
    lastToyAt: null,
    hatched: life.lastCareAt > 0,
    toys: 0,
    critical: false,
    gone: false,
    won: false,
    wonPrize: "0",
    lastStage: 0,
    bornAt: null,
    diedAt: null,
    careCount: 0,
    deathRank: 0,
    privyUserHash: null,
  });
  logger.warn({ serial: runner.serial, tokenId, owner }, "adopted an on-chain pet that had no server record");
  return runner;
}

// Public reads (the dashboard) call the sweep too, so a token whose adoption keeps failing
// must not cost a chain read on every request.
const SWEEP_MIN_GAP_MS = 30_000;
let lastSweepAt = 0;

/**
 * Adopt every minted token the server has no row for. Run by the idle cycle so an
 * orphan reaches the dashboard and the reminder engine without anyone looking it up.
 * Cheap when there is nothing to do: one store read, no chain reads.
 */
export async function adoptUnrecordedPets(ctx: AppContext): Promise<number> {
  const gate = await getSeasonGate(ctx).catch(() => null);
  if (!gate || gate.minted < 1) return 0;
  const known = new Set((await ctx.store.allMintedRunners()).map((r) => r.tokenId));
  // Compare ids, not counts: rows from an earlier season can carry token ids this one never
  // minted, so a row count at or above the minted count does not mean every token has a row.
  const missing: string[] = [];
  for (let id = 1; id <= gate.minted; id++) if (!known.has(String(id))) missing.push(String(id));
  if (missing.length === 0) return 0;
  if (Date.now() - lastSweepAt < SWEEP_MIN_GAP_MS) return 0;
  lastSweepAt = Date.now();
  let adopted = 0;
  for (const id of missing) {
    try {
      if (await adoptPet(ctx, id)) adopted += 1;
    } catch (err) {
      logger.warn({ err: String(err), tokenId: id }, "pet adoption failed (next cycle retries)");
    }
  }
  return adopted;
}
