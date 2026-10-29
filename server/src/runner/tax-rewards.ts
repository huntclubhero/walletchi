import { keccak256, encodeAbiParameters, concatHex, getAddress, type Hex } from "viem";
import { config } from "../config.js";
import { logger } from "../logger.js";
import { randomUUID } from "node:crypto";
import { hostname } from "node:os";
import type { AppContext } from "../context.js";
import { HolderRoundConflictError } from "../store/types.js";
import { runLaunchpadFeeInlet } from "./launchpad-inlet.js";
import { runShowcaseUsdgDrip } from "./showcase-drip.js";

// TAX ECONOMY (2026-08-17): the 4x/day fee-distribution job + holder airdrop
// machinery. The launchpad creator-fee stream (a pool-level tax on every CARE
// buy/sell) accumulates on the CareFeeSplitter; on each run this job
//   1. pokes splitter.distribute() (permissionless): half of the accumulated
//      stream lands on the HolderMerkleVault, half on the fee-token
//      WeightedRewardsDistributor where players claim it pro rata by their
//      stage-weighted care points (6h epochs = 4 payouts a day);
//   2. snapshots CARE holder balances from the token's Transfer history,
//      allocates the holder vault's unreserved balance pro rata (clamped to the
//      vault's per-round cap), posts the Merkle round on-chain SIGNED BY THE
//      DEDICATED POSTER KEY, and persists the full tree so /api/holder-rewards
//      can serve every holder its proof.
//
// TRUST NOTE, stated once here: the snapshot + allocation is OPERATOR-COMPUTED
// (Hunt chose snapshot airdrops over staking). The contract bounds what the
// poster can do (rounds capped by real balance, payouts only to leaf accounts,
// no owner exit for the reward token); WHO gets HOW MUCH within a round is this
// file's honest arithmetic.
//
// Pet TBAs COUNT as holders on purpose: a pet's care float is the player's own
// money, so topping up your pet keeps earning the holder stream. What never
// counts: the game's own contracts, the burn address, the DEX pool (via
// HOLDER_EXCLUDE_ADDRESSES), and the zero address.

// ---------------------------------------------------------------------------
// Merkle tree (must mirror HolderMerkleVault.sol EXACTLY)
// ---------------------------------------------------------------------------

// leaf = keccak256(bytes.concat(keccak256(abi.encode(roundId, account, amount))))
// (double-hashed per OZ MerkleProof guidance; roundId binds a proof to its round).
export function holderLeaf(roundId: number, account: string, amount: bigint): Hex {
  const inner = keccak256(
    encodeAbiParameters(
      [{ type: "uint256" }, { type: "address" }, { type: "uint256" }],
      [BigInt(roundId), getAddress(account), amount],
    ),
  );
  return keccak256(inner);
}

// OZ MerkleProof pair hashing: commutative keccak over the SORTED pair.
function hashPair(a: Hex, b: Hex): Hex {
  return BigInt(a) < BigInt(b) ? keccak256(concatHex([a, b])) : keccak256(concatHex([b, a]));
}

export interface HolderAllocation {
  account: string; // checksummed
  amount: bigint;
}

export interface BuiltTree {
  root: Hex;
  leaves: Array<{ account: string; amount: bigint; proof: Hex[] }>;
}

// Build the round's tree + a proof per leaf. Level-by-level commutative pairing;
// an odd trailing node is promoted unchanged (its proof simply skips that level),
// which OZ's verify handles because every proof is just the sibling path.
export function buildHolderTree(roundId: number, allocations: HolderAllocation[]): BuiltTree {
  if (allocations.length === 0) throw new Error("buildHolderTree: no allocations");
  const leafHashes = allocations.map((a) => holderLeaf(roundId, a.account, a.amount));
  // proofs[i] collects leaf i's sibling at every level it is paired on.
  const proofs: Hex[][] = allocations.map(() => []);
  // level = current node hashes; owners[n] = which LEAF indexes live under node n.
  let level: Hex[] = [...leafHashes];
  let owners: number[][] = leafHashes.map((_, i) => [i]);
  while (level.length > 1) {
    const nextLevel: Hex[] = [];
    const nextOwners: number[][] = [];
    for (let i = 0; i + 1 < level.length; i += 2) {
      for (const leafIdx of owners[i]!) proofs[leafIdx]!.push(level[i + 1]!);
      for (const leafIdx of owners[i + 1]!) proofs[leafIdx]!.push(level[i]!);
      nextLevel.push(hashPair(level[i]!, level[i + 1]!));
      nextOwners.push([...owners[i]!, ...owners[i + 1]!]);
    }
    if (level.length % 2 === 1) {
      nextLevel.push(level[level.length - 1]!);
      nextOwners.push(owners[level.length - 1]!);
    }
    level = nextLevel;
    owners = nextOwners;
  }
  return {
    root: level[0]!,
    leaves: allocations.map((a, i) => ({ account: a.account, amount: a.amount, proof: proofs[i]! })),
  };
}

// ---------------------------------------------------------------------------
// Holder snapshot + round posting (live-pet gated)
// ---------------------------------------------------------------------------

// Addresses that must NEVER be eligible even if they somehow "own a live pet": the burn address
// (holds the burn leg, ~69-70% of all CARE ever spent), the zero address, the game's own contracts, and the
// operator-supplied DEX pool(s). This is the DENY-LIST that the live-pet gate alone does not provide:
// a griefer can transferFrom a LIVE hatched pet to the burn address (only DEAD pets are soulbound),
// making burn "own a live pet" and, without this list, capturing ~100% of every holder round with a
// bag it did not pay for (re-audit finding 3). Lowercased.
export function holderDenyList(): Set<string> {
  const fixed = [
    "0x0000000000000000000000000000000000000000",
    "0x000000000000000000000000000000000000dead",
    config.PETVAULT_ADDRESS,
    config.RUNNER_ISSUER_ADDRESS,
    config.REWARDS_DISTRIBUTOR_ADDRESS,
    config.FEE_SPLITTER_ADDRESS,
    config.HOLDER_VAULT_ADDRESS,
    config.CARE_TOKEN_ADDRESS,
    config.FEE_TOKEN_ADDRESS,
  ];
  const extra = (config.HOLDER_EXCLUDE_ADDRESSES ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  const out = new Set<string>();
  for (const a of [...fixed, ...extra]) if (a) out.add(a.toLowerCase());
  return out;
}

// Hunt's live-pet gate: only holders who ALSO own a LIVE pet earn the airdrop. Eligibility is read
// from ON-CHAIN state at snapshot time, NOT the DB: `gone` lags the 10-min death sweep (and is gated
// on survivalLive independently of holderRewardsLive), and `ownerAddress` only updates on the /claim
// flow, so a sold-on-OpenSea pet's DB owner is stale and the seller would keep drawing airdrops
// (re-audit finding 3). For each minted pet we read isAlive + the current on-chain owner; a live
// pet's owner and its own TBA become eligible, unless the owner is on the deny-list (a griefed /
// orphaned pet). Chunked to bound the RPC burst; a failed read fails CLOSED (excluded).
export async function eligibleHolderAddresses(ctx: AppContext): Promise<Set<string>> {
  const minted = (await ctx.store.allMintedRunners()).filter((r) => r.tokenId);
  const denied = holderDenyList();
  const out = new Set<string>();
  const CHUNK = 40;
  for (let i = 0; i < minted.length; i += CHUNK) {
    const batch = minted.slice(i, i + CHUNK);
    const results = await Promise.all(
      batch.map(async (r) => {
        try {
          const [state, owner] = await Promise.all([
            ctx.relayer.petState(r.tokenId as string),
            ctx.relayer.petOwnerOf(r.tokenId as string),
          ]);
          return { alive: state.isAlive === true, owner, tba: r.tbaAddress ?? null };
        } catch {
          return null;
        }
      }),
    );
    for (const res of results) {
      if (!res || !res.alive || !res.owner) continue;
      if (denied.has(res.owner.toLowerCase())) continue; // griefed / orphaned -> not eligible
      out.add(res.owner.toLowerCase());
      if (res.tba && !denied.has(res.tba.toLowerCase())) out.add(res.tba.toLowerCase());
    }
  }
  return out;
}

// Pro-rata allocation of `pool` across the snapshot balances, KEEPING ONLY the
// eligible (live-pet-linked) addresses. Floor division (dust stays for the next
// round). Deterministic order (amount desc, then address) so a re-run over the
// same snapshot rebuilds the identical tree.
export function allocateProRata(
  pool: bigint,
  balances: Map<string, bigint>,
  eligible: Set<string>,
): HolderAllocation[] {
  let totalHeld = 0n;
  const holders: Array<[string, bigint]> = [];
  for (const [account, bal] of balances) {
    if (bal <= 0n || !eligible.has(account.toLowerCase())) continue;
    holders.push([account, bal]);
    totalHeld += bal;
  }
  if (totalHeld === 0n) return [];
  const out: HolderAllocation[] = [];
  for (const [account, bal] of holders) {
    const amount = (pool * bal) / totalHeld;
    if (amount > 0n) out.push({ account: getAddress(account), amount });
  }
  out.sort((a, b) =>
    a.amount === b.amount
      ? a.account.toLowerCase() < b.account.toLowerCase()
        ? -1
        : 1
      : a.amount > b.amount
        ? -1
        : 1,
  );
  return out;
}

// ---------------------------------------------------------------------------
// The 4x/day job
// ---------------------------------------------------------------------------

export interface FeeDistributionResult {
  distributed: boolean;
  roundPosted: boolean;
  roundId?: number;
  holders?: number;
  total?: string;
  /** Why no round was posted this run (dark leg, no funds, no eligible holders, a fail-closed gate, an error). */
  skipReason?: string;
  /** True when the round total was clamped down to the vault's per-round cap. */
  clamped?: boolean;
  /** Unreserved balance deliberately left for the NEXT round (raw units, decimal string). */
  carryForward?: string;
}

// ---------------------------------------------------------------------------
// HOLDER ROUND HEALTH (the signal this failure mode never had)
// ---------------------------------------------------------------------------
//
// The audited complaint was not that posting could fail; it was that it failed INVISIBLY. A
// poster-gated postRound signed by the relayer reverts NotPoster, the catch below logged a warn,
// and the airdrop leg was dark forever with nothing to look at. So every run now records what it
// found and what it did, and /internal/status publishes it. In memory and reset on restart on
// purpose, exactly like care-metrics: this is an operational pulse, not analytics.

export interface HolderRoundAttempt {
  at: string;
  ok: boolean;
  roundId?: number;
  txHash?: string;
  holders?: number;
  total?: string;
  error?: string;
}

export interface HolderRoundHealth {
  /** config.modes.holderRewardsLive: reads + gasless claims. */
  holderRewardsLive: boolean;
  /** config.modes.holderPostingLive: the poster-gated write specifically. */
  postingLive: boolean;
  posterConfigured: boolean;
  /** Our configured poster KEY's address (public). */
  posterAddress: string | null;
  /** The vault's on-chain poster(). */
  onChainPoster: string | null;
  /** null until checked, or when the read failed (an RPC blip is not a verdict). */
  posterMatchesOnChain: boolean | null;
  posterCheckedAt: string | null;
  posterCheckError: string | null;
  postingPaused: boolean | null;
  /** Per-round ceiling, raw units. "0" means UNARMED, which fails closed on-chain. */
  maxRoundTotalRaw: string | null;
  unreservedRaw: string | null;
  roundsPosted: number | null;
  lastRunAt: string | null;
  lastSkipReason: string | null;
  lastPostedAt: string | null;
  lastAttempt: HolderRoundAttempt | null;
  consecutiveFailures: number;
  /** The last run clamped its total to the cap and carried the rest forward. */
  lastRoundClamped: boolean;
  carryForwardRaw: string | null;
  /**
   * Stored rounds whose root DIFFERS from the vault's on-chain root (from the last push cycle).
   * Their claims would all revert BadProof, so delivery skips them. Non-empty means a stored tree
   * was replaced after posting (the 2026-10-28 overlap) and needs a human.
   */
  rootMismatchRounds: number[];
  rootCheckedAt: string | null;
}

const holderHealth: HolderRoundHealth = {
  holderRewardsLive: config.modes.holderRewardsLive,
  postingLive: config.modes.holderPostingLive,
  posterConfigured: Boolean(config.holderPosterAddress),
  posterAddress: config.holderPosterAddress ?? null,
  onChainPoster: null,
  posterMatchesOnChain: null,
  posterCheckedAt: null,
  posterCheckError: null,
  postingPaused: null,
  maxRoundTotalRaw: null,
  unreservedRaw: null,
  roundsPosted: null,
  lastRunAt: null,
  lastSkipReason: null,
  lastPostedAt: null,
  lastAttempt: null,
  consecutiveFailures: 0,
  lastRoundClamped: false,
  carryForwardRaw: null,
  rootMismatchRounds: [],
  rootCheckedAt: null,
};

export function getHolderRoundHealth(): HolderRoundHealth {
  // Re-read the mode flags on every call: the smoke flips them at runtime, and an operator
  // reading /internal/status wants the CURRENT posture, not the one captured at import time.
  holderHealth.holderRewardsLive = config.modes.holderRewardsLive;
  holderHealth.postingLive = config.modes.holderPostingLive;
  holderHealth.posterConfigured = Boolean(config.holderPosterAddress);
  holderHealth.posterAddress = config.holderPosterAddress ?? null;
  return { ...holderHealth, rootMismatchRounds: [...holderHealth.rootMismatchRounds] };
}

/** Test hook. */
export function _resetHolderRoundHealth(): void {
  holderHealth.onChainPoster = null;
  holderHealth.posterMatchesOnChain = null;
  holderHealth.posterCheckedAt = null;
  holderHealth.posterCheckError = null;
  holderHealth.postingPaused = null;
  holderHealth.maxRoundTotalRaw = null;
  holderHealth.unreservedRaw = null;
  holderHealth.roundsPosted = null;
  holderHealth.lastRunAt = null;
  holderHealth.lastSkipReason = null;
  holderHealth.lastPostedAt = null;
  holderHealth.lastAttempt = null;
  holderHealth.consecutiveFailures = 0;
  holderHealth.lastRoundClamped = false;
  holderHealth.carryForwardRaw = null;
  holderHealth.rootMismatchRounds = [];
  holderHealth.rootCheckedAt = null;
  onChainRootCache.clear();
}

// BOOT ASSERTION (mainnet blocker B2). Confirm the key we hold is the key the vault will accept,
// at boot, instead of discovering it from a NotPoster revert on the first round six hours later.
//
// NEVER BLOCKS BOOT, mirroring verifyRpcChainId in index.ts:
//   - no poster key while holder rewards are live: config's boot guard already printed the loud
//     [BOOT GUARD] line and holderPostingLive is false, so posting is off and nothing else is
//     touched. Refusing to boot here would take mint, care, passes and claims down for a rewards
//     leg that loses nothing by waiting.
//   - RPC unreadable: a WARN and we carry on. A cold RPC must never be treated as a verdict about
//     a key, and the pre-post check inside the job re-reads poster() before every round anyway.
//   - DEFINITE mismatch: a LOUD error naming BOTH addresses, and posting is skipped until it
//     agrees, so the job never burns gas on a guaranteed revert.
export async function verifyHolderPoster(ctx: AppContext): Promise<void> {
  if (!config.modes.holderRewardsLive) return;
  const configured = config.holderPosterAddress;
  if (!configured) {
    // config.ts already refused to call this leg live; restate it where the operator is looking.
    logger.error(
      { holderVault: config.HOLDER_VAULT_ADDRESS },
      "[BOOT GUARD] holder rewards are LIVE but no usable HOLDER_POSTER_PRIVATE_KEY is configured. " +
        "HolderMerkleVault.postRound is gated on a DEDICATED poster key (never the relayer), so no " +
        "airdrop round can be posted. Round posting is DISABLED; reads and gasless claims are unaffected.",
    );
    return;
  }
  let onChain: string;
  try {
    // BOUNDED. This is awaited before app.listen, so an RPC that hangs would delay the port
    // opening (viem retries an HTTP read three times before giving up) and could fail a platform
    // health check on a cold start. verifyRpcChainId caps its own probe at 10s for the same
    // reason; a diagnostic never gets to be the slow path on boot.
    onChain = await Promise.race([
      ctx.relayer.holderPoster(),
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error("timed out after 10s")), 10_000).unref?.(),
      ),
    ]);
  } catch (err) {
    holderHealth.posterCheckError = String(err).slice(0, 200);
    holderHealth.posterCheckedAt = new Date().toISOString();
    logger.warn(
      { err: String(err), holderVault: config.HOLDER_VAULT_ADDRESS, holderPoster: configured },
      "could not read HolderMerkleVault.poster(); skipping the poster-key match check at boot",
    );
    return;
  }
  holderHealth.onChainPoster = onChain;
  holderHealth.posterCheckedAt = new Date().toISOString();
  holderHealth.posterCheckError = null;
  const matches = onChain.toLowerCase() === configured.toLowerCase();
  holderHealth.posterMatchesOnChain = matches;
  if (matches) {
    logger.info(
      { holderPoster: configured, holderVault: config.HOLDER_VAULT_ADDRESS },
      "holder round poster key matches the on-chain poster()",
    );
    return;
  }
  logger.error(
    { configuredPoster: configured, onChainPoster: onChain, holderVault: config.HOLDER_VAULT_ADDRESS },
    `[BOOT GUARD] holder poster MISMATCH: HOLDER_POSTER_PRIVATE_KEY resolves to ${configured} but ` +
      `HolderMerkleVault ${config.HOLDER_VAULT_ADDRESS} has poster() = ${onChain}. Every postRound would ` +
      `revert NotPoster, so holder round posting is DISABLED until they agree. Set HOLDER_POSTER_PRIVATE_KEY ` +
      `to the key for ${onChain} (or rotate the vault's poster to ${configured}).`,
  );
}

// In-process guard against overlapping runs (the boot catch-up timer + the
// interval, or a manual poke). The snapshot takes real time, and two runs reading
// the same roundId would post conflicting trees (server-audit HIGH-1). This flag
// closes the common single-process window cheaply; the cross-process guards are
// below.
let feeDistributionInFlight = false;

// CROSS-INSTANCE GUARDS (2026-10-29). On 2026-10-28 two deploys overlapped, both instances ran the
// boot round job and both read next round id 87. Instance A posted 87 on-chain; instance B then
// REPLACED the stored tree with its own (the store used to upsert) and its own post reverted
// UnexpectedRoundId. The chain kept A's root, the store kept B's leaves, and every claim for 87
// reverted BadProof from then on. Three layers now, each enough on its own for that sequence:
//   1. a job LEASE row in Postgres (store.tryAcquireJobLease) so only one instance snapshots and
//      posts at a time. A row with an expiry, not a session advisory lock, because the database
//      may sit behind a pooler and session locks leak there;
//   2. the store REFUSES to replace a stored round with a different root (HolderRoundConflictError)
//      unless the caller names the root it replaces, and this job only does that for a tree that is
//      provably unposted (chain roundCount still equals its id) AND older than the lease TTL, so a
//      fresh tree from an instance that is mid-post (an old build ignoring the lease) is left alone;
//   3. a post that loses the race (the chain holds a different root at our id) DELETES the tree
//      this run stored, so a tree whose post failed is never left behind as the round's proofs.
// And the delivery side compares stored and on-chain roots before relaying anything (see
// verifyRoundRoots), which is what stops the BadProof loop for a round that is already split.
const HOLDER_ROUND_LEASE = "holder-round";
const HOLDER_ROUND_LEASE_TTL_MS = 15 * 60_000;
const leaseHolder = `${hostname()}:${process.pid}:${randomUUID().slice(0, 8)}`;

function sameRoot(a: string, b: string): boolean {
  return a.toLowerCase() === b.toLowerCase();
}

export async function runFeeDistribution(ctx: AppContext): Promise<FeeDistributionResult> {
  // THE INLET RUNS FIRST, AND OUTSIDE THE holderRewardsLive GATE.
  //
  // Order matters: this is what puts money INTO the splitter (it claims the launchpad creator seat
  // and forwards the USDG), so running it before the distribute() poke below means a cycle's
  // revenue is claimed AND distributed in the same cycle instead of always waiting for the next
  // one. It sits above the gate because the inlet has its OWN live-ness inputs (hook address, pool
  // id, collector key) and can legitimately be live while the holder leg is not.
  //
  // It never throws: it is a whole separate failure domain, and a revenue-claim problem must not
  // take the distribute + holder-round path down with it. Its own health block on /internal/status
  // is what keeps the swallowed failure visible.
  await runLaunchpadFeeInlet(ctx).catch((err) =>
    logger.error({ err: String(err) }, "launchpad fee inlet threw (continuing to distribution)"),
  );
  if (!config.modes.holderRewardsLive) return { distributed: false, roundPosted: false };
  if (feeDistributionInFlight) {
    logger.info("fee distribution already in flight; skipping this tick");
    return { distributed: false, roundPosted: false };
  }
  feeDistributionInFlight = true;
  try {
    return await _runFeeDistribution(ctx);
  } finally {
    feeDistributionInFlight = false;
  }
}

async function _runFeeDistribution(ctx: AppContext): Promise<FeeDistributionResult> {
  // 0. TESTNET SHOWCASE: simulated trading fees (a no-op unless SHOWCASE_USDG_DRIP). Runs HERE, before
  // the poke, for the same reason the launchpad inlet runs first: the cycle that mints the fees also
  // distributes them. It also keeps the splitter's swap rate fresh so step 1 swaps instead of parking.
  // Never throws.
  if (config.SHOWCASE_USDG_DRIP) await runShowcaseUsdgDrip(ctx);

  // 1. Poke the splitter when the fee stream has accumulated anything.
  let distributed = false;
  try {
    const bal = await ctx.relayer.splitterBalance();
    if (bal > 0n) {
      const { txHash } = await ctx.relayer.splitterDistribute();
      distributed = true;
      logger.info({ txHash, raw: bal.toString() }, "fee splitter distributed");
    }
  } catch (err) {
    logger.warn({ err: String(err) }, "fee splitter distribute failed; will retry next cycle");
  }

  // 2. Post a holder round over whatever the vault holds unallocated.
  holderHealth.lastRunAt = new Date().toISOString();
  holderHealth.lastSkipReason = null;
  holderHealth.lastRoundClamped = false;
  holderHealth.carryForwardRaw = null;

  // THE POSTER GATE, checked before any work. postRound is signed by the DEDICATED poster key;
  // with no such key the write cannot even be attempted (the chain layer throws), so skip the
  // whole snapshot rather than spending a minute of RPC reads on a round that cannot be posted.
  // The splitter poke above still ran, so the fee stream keeps flowing and the holder half simply
  // accumulates unreserved until the key is fixed, at which point it posts in full.
  if (!config.modes.holderPostingLive) {
    const reason = config.holderPosterAddress
      ? "holder rewards are not live"
      : "no usable HOLDER_POSTER_PRIVATE_KEY (postRound is gated on a dedicated poster key)";
    holderHealth.lastSkipReason = reason;
    // ERROR, not warn: this is the silent-failure mode the audit called out. It repeats once per
    // distribution cycle (4x/day by default), which is the point.
    logger.error({ reason }, "holder round posting is DISABLED; no round will be posted");
    return { distributed, roundPosted: false, skipReason: reason };
  }

  // THE LEASE. Fail closed: a database we cannot reach is a database we cannot persist proofs to.
  let leased = false;
  try {
    leased = await ctx.store.tryAcquireJobLease(HOLDER_ROUND_LEASE, leaseHolder, HOLDER_ROUND_LEASE_TTL_MS);
  } catch (err) {
    const reason = "could not take the holder round lease";
    holderHealth.lastSkipReason = reason;
    logger.error({ err: String(err) }, `holder round skipped: ${reason}`);
    return { distributed, roundPosted: false, skipReason: reason };
  }
  if (!leased) {
    const reason = "another instance holds the holder round lease";
    holderHealth.lastSkipReason = reason;
    logger.info({ leaseHolder }, `holder round skipped: ${reason}`);
    return { distributed, roundPosted: false, skipReason: reason };
  }
  try {
    return await postHolderRound(ctx, distributed);
  } finally {
    await ctx.store
      .releaseJobLease(HOLDER_ROUND_LEASE, leaseHolder)
      .catch((err) => logger.warn({ err: String(err) }, "holder round lease release failed (it expires on its own)"));
  }
}

async function postHolderRound(ctx: AppContext, distributed: boolean): Promise<FeeDistributionResult> {
  try {
    // One batched read of every fail-closed gate the hardened vault applies, so a skip can name
    // the ACTUAL reason instead of surfacing as an opaque revert (or worse, as nothing at all).
    const [unreserved, maxRoundTotal, postingPaused, onChainPoster, roundId] = await Promise.all([
      ctx.relayer.holderUnreserved(),
      ctx.relayer.holderMaxRoundTotal(),
      ctx.relayer.holderPostingPaused(),
      ctx.relayer.holderPoster(),
      ctx.relayer.holderRoundCount(),
    ]);
    holderHealth.unreservedRaw = unreserved.toString();
    holderHealth.maxRoundTotalRaw = maxRoundTotal.toString();
    holderHealth.postingPaused = postingPaused;
    holderHealth.onChainPoster = onChainPoster;
    holderHealth.roundsPosted = roundId;
    holderHealth.posterCheckedAt = new Date().toISOString();
    holderHealth.posterCheckError = null;

    // Re-verified EVERY run, not just at boot: the owner can rotate the poster at any time
    // (queuePoster/commitPoster behind a timelock), and a rotation after boot would otherwise
    // turn back into the invisible NotPoster loop this whole change exists to remove.
    const posterMatches =
      Boolean(config.holderPosterAddress) &&
      onChainPoster.toLowerCase() === config.holderPosterAddress!.toLowerCase();
    holderHealth.posterMatchesOnChain = posterMatches;
    if (!posterMatches) {
      const reason =
        `poster mismatch: configured ${config.holderPosterAddress} but the vault's poster() is ${onChainPoster}`;
      holderHealth.lastSkipReason = reason;
      logger.error(
        { configuredPoster: config.holderPosterAddress, onChainPoster, holderVault: config.HOLDER_VAULT_ADDRESS },
        `holder round skipped: ${reason}. Every postRound would revert NotPoster. Fix HOLDER_POSTER_PRIVATE_KEY.`,
      );
      return { distributed, roundPosted: false, skipReason: reason };
    }
    // The owner's emergency stop. A pause is a deliberate act, so report it as a pause.
    if (postingPaused) {
      const reason = "posting is PAUSED on the vault (owner emergency stop)";
      holderHealth.lastSkipReason = reason;
      logger.error({ holderVault: config.HOLDER_VAULT_ADDRESS }, `holder round skipped: ${reason}`);
      return { distributed, roundPosted: false, skipReason: reason };
    }
    // FAIL CLOSED on-chain since the hardening: maxRoundTotal == 0 is not "unlimited", it blocks
    // every round (RoundCapNotArmed). The owner has to arm it once per deployment, and a season
    // that shipped without it would otherwise look healthy while posting nothing.
    if (maxRoundTotal === 0n) {
      const reason = "the vault's per-round cap is UNARMED (maxRoundTotal == 0, postRound fails closed)";
      holderHealth.lastSkipReason = reason;
      logger.error(
        { holderVault: config.HOLDER_VAULT_ADDRESS },
        `holder round skipped: ${reason}. The vault owner must call setMaxRoundTotal before any round can post.`,
      );
      return { distributed, roundPosted: false, skipReason: reason };
    }

    const minRound = BigInt(config.HOLDER_MIN_ROUND_RAW ?? "0");
    if (unreserved === 0n || unreserved < minRound) {
      holderHealth.lastSkipReason =
        unreserved === 0n ? "nothing unreserved to distribute" : "unreserved balance below HOLDER_MIN_ROUND_RAW";
      return { distributed, roundPosted: false, skipReason: holderHealth.lastSkipReason };
    }

    // CLAMP TO THE CAP, CARRY THE REST FORWARD.
    //
    // postRound reverts OverRoundCap when total > maxRoundTotal. Allocating the FULL unreserved
    // balance therefore had a trap in it: once the vault holds more than one cap's worth, every
    // round reverts, nothing is ever reserved, the unreserved balance keeps growing, and the
    // pipeline is permanently stuck in exactly the state it can never post its way out of.
    // Clamping is what makes it self-healing: this round pays out one cap's worth, the remainder
    // stays unreserved (nothing moves out of the vault), and the very next cycle picks it up.
    // Because reserved only ever grows by what we actually posted, the carry-forward needs no
    // bookkeeping of its own: it IS the next run's holderUnreserved().
    const pool = unreserved > maxRoundTotal ? maxRoundTotal : unreserved;
    const carryForward = unreserved - pool;
    if (carryForward > 0n) {
      holderHealth.lastRoundClamped = true;
      holderHealth.carryForwardRaw = carryForward.toString();
      logger.info(
        {
          unreserved: unreserved.toString(),
          cap: maxRoundTotal.toString(),
          pool: pool.toString(),
          carryForward: carryForward.toString(),
        },
        "holder round clamped to the vault's per-round cap; the remainder carries into the next round",
      );
    }

    const [balances, eligible] = await Promise.all([
      ctx.relayer.tokenHolderBalances(config.CARE_TOKEN_ADDRESS!, config.FEE_SNAPSHOT_FROM_BLOCK),
      eligibleHolderAddresses(ctx),
    ]);
    const allocations = allocateProRata(pool, balances, eligible);
    if (allocations.length === 0) {
      holderHealth.lastSkipReason = "no eligible (live-pet-owning) holders in the snapshot";
      logger.warn("holder round skipped: no eligible (live-pet-owning) holders in the snapshot");
      return { distributed, roundPosted: false, skipReason: holderHealth.lastSkipReason };
    }
    const tree = buildHolderTree(roundId, allocations);
    // Floor division keeps this at or below `pool`, and `pool` is at or below the cap, so the
    // total the contract sees can never trip OverRoundCap. Asserted rather than assumed, because
    // the whole point of the clamp is that a total over the cap bricks the pipeline.
    const total = allocations.reduce((acc, a) => acc + a.amount, 0n);
    if (total > maxRoundTotal) {
      const reason = `computed total ${total} exceeds the cap ${maxRoundTotal}; refusing to post`;
      holderHealth.lastSkipReason = reason;
      logger.error({ total: total.toString(), cap: maxRoundTotal.toString() }, `holder round skipped: ${reason}`);
      return { distributed, roundPosted: false, skipReason: reason };
    }

    // The snapshot took real time: confirm this instance still owns the lease before it writes.
    if (!(await ctx.store.tryAcquireJobLease(HOLDER_ROUND_LEASE, leaseHolder, HOLDER_ROUND_LEASE_TTL_MS))) {
      const reason = "lost the holder round lease during the snapshot";
      holderHealth.lastSkipReason = reason;
      logger.error({ roundId }, `holder round skipped: ${reason}`);
      return { distributed, roundPosted: false, skipReason: reason };
    }

    // A tree already stored under this id. The chain's roundCount still equals roundId (read
    // above), so nobody has posted this id yet; a stored tree here is either our own recompute
    // (same root, idempotent) or one whose post never landed.
    const leafRows = tree.leaves.map((l) => ({
      roundId,
      account: l.account,
      amount: l.amount.toString(),
      proof: JSON.stringify(l.proof),
    }));
    let replaceRoot: string | undefined;
    const stored = await ctx.store.holderRound(roundId);
    if (stored && !sameRoot(stored.root, tree.root)) {
      if (stored.txHash) {
        // Recorded as posted, yet the chain says this id is free: the store and the chain disagree
        // about history. Never paper over that by overwriting it.
        const reason = `round ${roundId} is stored as posted (tx ${stored.txHash}) but the vault's roundCount says it is not`;
        holderHealth.lastSkipReason = reason;
        logger.error({ roundId, storedRoot: stored.root, txHash: stored.txHash }, `holder round skipped: ${reason}`);
        return { distributed, roundPosted: false, skipReason: reason };
      }
      const ageMs = Date.now() - stored.postedAt.getTime();
      if (ageMs < HOLDER_ROUND_LEASE_TTL_MS) {
        // Young enough to belong to another instance that is about to post it (an old build that
        // does not take the lease, during a rolling deploy). Leave it; the next cycle decides.
        const reason = `round ${roundId} already has a fresh unposted tree from another run; not replacing it`;
        holderHealth.lastSkipReason = reason;
        logger.warn({ roundId, storedRoot: stored.root, ageMs }, `holder round skipped: ${reason}`);
        return { distributed, roundPosted: false, skipReason: reason };
      }
      replaceRoot = stored.root;
      logger.warn(
        { roundId, staleRoot: stored.root, newRoot: tree.root, ageMs },
        "replacing a stale UNPOSTED holder tree (its post never landed; the vault's roundCount has not moved)",
      );
    }

    // Persist the proofs BEFORE posting: a round on-chain without its stored tree would strand that
    // round's funds (the snapshot cannot be replayed later). The store refuses a different root
    // for an id it already holds, so this can never overwrite a round another instance posted.
    await ctx.store.putHolderRound(
      { id: roundId, root: tree.root, total: total.toString(), token: config.FEE_TOKEN_ADDRESS!, txHash: null },
      leafRows,
      { replaceRoot },
    );
    // expectedRoundId == roundId: a cron/nonce race that shifted the id reverts
    // cleanly on-chain (UnexpectedRoundId) instead of posting a root whose proofs
    // no longer verify. SIGNED BY THE POSTER KEY (the relayer would revert NotPoster).
    let txHash: string;
    try {
      ({ txHash } = await ctx.relayer.holderPostRound(roundId, tree.root, total));
    } catch (postErr) {
      await dropTreeIfRaceLost(ctx, roundId, tree.root);
      throw postErr;
    }
    holderHealth.lastPostedAt = new Date().toISOString();
    holderHealth.consecutiveFailures = 0;
    holderHealth.lastAttempt = {
      at: new Date().toISOString(),
      ok: true,
      roundId,
      txHash,
      holders: allocations.length,
      total: total.toString(),
    };
    // txHash backfill. The post succeeded, so the chain's root at roundId IS tree.root, which makes
    // this tree the one true proof set for the round. If the stored row was replaced in between (an
    // old build that still upserts, overlapping a deploy), put the posted tree back: that is the
    // one replacement that is always correct.
    try {
      await ctx.store.putHolderRound(
        { id: roundId, root: tree.root, total: total.toString(), token: config.FEE_TOKEN_ADDRESS!, txHash },
        leafRows,
      );
    } catch (err) {
      if (err instanceof HolderRoundConflictError) {
        logger.error(
          { roundId, postedRoot: tree.root, storedRoot: err.storedRoot, txHash },
          "the stored tree for a round we JUST POSTED was replaced by another instance; restoring the posted tree",
        );
        await ctx.store
          .putHolderRound(
            { id: roundId, root: tree.root, total: total.toString(), token: config.FEE_TOKEN_ADDRESS!, txHash },
            leafRows,
            { replaceRoot: err.storedRoot },
          )
          .catch((e) =>
            logger.error({ err: String(e), roundId }, "could not restore the posted holder tree (rootMismatchRounds will show it)"),
          );
      }
      // Any other failure: the round + proofs were persisted before the post; a missing txHash is display-only.
    }
    logger.info(
      {
        roundId,
        txHash,
        holders: allocations.length,
        total: total.toString(),
        poster: config.holderPosterAddress,
        clamped: carryForward > 0n,
        carryForward: carryForward.toString(),
      },
      "holder airdrop round posted",
    );
    return {
      distributed,
      roundPosted: true,
      roundId,
      holders: allocations.length,
      total: total.toString(),
      clamped: carryForward > 0n,
      carryForward: carryForward.toString(),
    };
  } catch (err) {
    // ERROR, not warn (the audited finding): a failed round post used to be a warn nobody read, so
    // a poster-gated pipeline could be dark for a whole season with no signal. It is recorded on
    // /internal/status as well, with the consecutive-failure count that tells a stuck loop apart
    // from a one-off RPC blip.
    holderHealth.consecutiveFailures += 1;
    holderHealth.lastSkipReason = "round posting threw";
    holderHealth.lastAttempt = {
      at: new Date().toISOString(),
      ok: false,
      error: String(err).slice(0, 300),
    };
    logger.error(
      { err: String(err), consecutiveFailures: holderHealth.consecutiveFailures },
      "holder round posting FAILED; will retry next cycle (see /internal/status holderRounds)",
    );
    return { distributed, roundPosted: false, skipReason: "round posting threw" };
  }
}

// A post failed. If the vault now holds a DIFFERENT root at our id, another poster won the race
// (UnexpectedRoundId) and the tree this run stored is not the round's proof set: remove it, or it
// would sit there serving proofs that revert BadProof. If the vault holds OUR root (the post
// landed and only the receipt wait failed) or nothing yet, keep it: deleting a tree that might be
// on-chain is the one mistake that strands a round's funds.
async function dropTreeIfRaceLost(ctx: AppContext, roundId: number, ourRoot: string): Promise<void> {
  let chainRoot: string | null;
  try {
    chainRoot = await ctx.relayer.holderRoundRoot(roundId);
  } catch (err) {
    logger.warn({ err: String(err), roundId }, "holder post failed and the on-chain root is unreadable; keeping the stored tree");
    return;
  }
  if (!chainRoot || sameRoot(chainRoot, ourRoot)) return;
  const removed = await ctx.store.deleteUnpostedHolderRound(roundId, ourRoot).catch(() => false);
  logger.error(
    { roundId, ourRoot, chainRoot, removed },
    "holder post LOST THE RACE: the vault already holds a different root at this id; our unposted tree was removed",
  );
}

// ---------------------------------------------------------------------------
// Stored root vs on-chain root (the delivery-side guard)
// ---------------------------------------------------------------------------
//
// A posted round's root is immutable on-chain, so one read per (vault, round) per process is
// enough and the answer is cached forever. "Not posted yet" and read failures are not cached.

export type RootVerdict = "ok" | "mismatch" | "unposted" | "unreadable";
const onChainRootCache = new Map<string, string>(); // `${vault}:${roundId}` -> lowercased root

export async function verifyRoundRoots(
  ctx: AppContext,
  storedRoots: Map<number, string>,
): Promise<Map<number, RootVerdict>> {
  const out = new Map<number, RootVerdict>();
  const vault = (config.HOLDER_VAULT_ADDRESS ?? "").toLowerCase();
  for (const [roundId, storedRoot] of storedRoots) {
    const key = `${vault}:${roundId}`;
    let chainRoot = onChainRootCache.get(key) ?? null;
    if (chainRoot === null) {
      try {
        chainRoot = await ctx.relayer.holderRoundRoot(roundId);
      } catch {
        out.set(roundId, "unreadable");
        continue;
      }
      if (chainRoot === null) {
        out.set(roundId, "unposted");
        continue;
      }
      onChainRootCache.set(key, chainRoot.toLowerCase());
    }
    out.set(roundId, sameRoot(chainRoot, storedRoot) ? "ok" : "mismatch");
  }
  return out;
}

// ---------------------------------------------------------------------------
// Gasless holder claim relay
// ---------------------------------------------------------------------------

export interface HolderClaimResult {
  roundId: number;
  amount: string;
  txHash: string;
}

// FIX (server review, HIGH): in-process in-flight guards for the claim relay.
// The endpoint is UNAUTHENTICATED by design (relaying pays the leaf's account,
// never the caller), but concurrent POSTs for one address all read
// holderClaimed=false before the first tx lands, so each one used to enqueue a
// duplicate on-chain holderClaim. The duplicates revert, yet they still burn
// relayer ETH and occupy the SHARED write queue that mints, care and finalize
// ride on. Mirrors the care path's inFlightCare pattern in routes.ts:
//   - the ROUTE acquires the per-account flight (begin/end below) and answers a
//     duplicate with a friendly 202 instead of a second relay;
//   - the per-(roundId, account) set inside relayHolderClaims is the
//     belt-and-suspenders for any OTHER caller in the same tick.
const holderClaimsInFlight = new Set<string>(); // lowercased account
const holderRoundClaimsInFlight = new Set<string>(); // `${roundId}:${account.toLowerCase()}`

/** Try to acquire the per-account claim flight. False = a claim for this address is already in flight. */
export function beginHolderClaimFlight(account: string): boolean {
  const key = account.toLowerCase();
  if (holderClaimsInFlight.has(key)) return false;
  holderClaimsInFlight.add(key);
  return true;
}

/** Release the per-account claim flight (call in a finally). */
export function endHolderClaimFlight(account: string): void {
  holderClaimsInFlight.delete(account.toLowerCase());
}

// Submit every unclaimed round for `account`. claim() always pays the leaf's
// account regardless of caller, so relaying is a pure gas gift, never a risk.
//
// Only rounds whose stored root matches the vault's on-chain root are relayed: a mismatched
// round's proofs revert BadProof every time, at our gas cost. `verdicts` lets the push cycle hand
// over the checks it already made (and logged once); without it they are made here, quietly.
export async function relayHolderClaims(
  ctx: AppContext,
  account: string,
  verdicts?: Map<number, RootVerdict>,
): Promise<HolderClaimResult[]> {
  const leaves = await ctx.store.holderLeavesForAccount(getAddress(account));
  const missing = new Map<number, string>();
  for (const leaf of leaves) if (!verdicts?.has(leaf.roundId)) missing.set(leaf.roundId, leaf.root);
  const checked = new Map(verdicts ?? []);
  if (missing.size > 0) for (const [id, v] of await verifyRoundRoots(ctx, missing)) checked.set(id, v);
  const results: HolderClaimResult[] = [];
  for (const leaf of leaves) {
    if (checked.get(leaf.roundId) !== "ok") continue;
    // Skip a (roundId, account) whose claim is already in flight this tick: the
    // holderClaimed read below would still say false while the first tx is
    // landing, and a second enqueue is a guaranteed revert at our gas cost.
    const flightKey = `${leaf.roundId}:${leaf.account.toLowerCase()}`;
    if (holderRoundClaimsInFlight.has(flightKey)) continue;
    holderRoundClaimsInFlight.add(flightKey);
    try {
      const already = await ctx.relayer.holderClaimed(leaf.roundId, leaf.account);
      if (already) continue;
      const proof = JSON.parse(leaf.proof) as string[];
      const { txHash } = await ctx.relayer.holderClaim(
        leaf.roundId,
        leaf.account,
        BigInt(leaf.amount),
        proof,
      );
      results.push({ roundId: leaf.roundId, amount: leaf.amount, txHash });
    } catch (err) {
      logger.warn(
        { err: String(err), roundId: leaf.roundId, account: leaf.account },
        "holder claim relay failed for round; skipping",
      );
    } finally {
      holderRoundClaimsInFlight.delete(flightKey);
    }
  }
  return results;
}

// ---------------------------------------------------------------------------
// Holder reward PUSH (season 2, no claims)
// ---------------------------------------------------------------------------

export interface HolderPushResult {
  /** Rounds scanned this cycle. */
  rounds: number;
  /** Distinct accounts that still had an unclaimed leaf. */
  accounts: number;
  /** Leaves actually delivered on-chain this cycle. */
  pushed: number;
}

/**
 * Deliver every unclaimed holder airdrop in the recent rounds, without anyone
 * asking. The 2h engine's holder leg.
 *
 * WHY THIS EXISTS AND IS NOT OPTIONAL. The gasless claim relay above is
 * PULL-shaped: a holder has to arrive at the site before their USDG moves. The
 * vault releases an unclaimed round's funds back after its grace period, so
 * "nobody came to ask" is not a neutral resting state, it is a deadline nobody
 * told the holder about. Under the no-claims law the server goes and finds them.
 *
 * It reuses relayHolderClaims per account rather than calling holderClaim
 * directly, so the engine and the still-live claim endpoint share ONE set of
 * in-flight guards: a holder who taps claim at the same moment this cycle reaches
 * them cannot produce two transactions for the same leaf.
 */
export async function pushHolderRewards(ctx: AppContext): Promise<HolderPushResult> {
  const out: HolderPushResult = { rounds: 0, accounts: 0, pushed: 0 };
  if (!config.modes.holderRewardsLive) return out;

  let roundCount: number;
  try {
    roundCount = await ctx.relayer.holderRoundCount();
  } catch (err) {
    logger.warn({ err: String(err) }, "holder push: roundCount read failed; skipping this cycle");
    return out;
  }
  if (roundCount <= 0) return out;

  // Round ids are ZERO-BASED and append-only: postRound takes expectedRoundId ==
  // roundCount, so the first round posted is id 0 and roundCount is the NEXT id,
  // not the highest one. The window is the same idea as the reward epoch window:
  // bounded work per cycle, widenable by config when an outage leaves rounds behind.
  const window = Math.max(1, config.HOLDER_PUSH_ROUND_WINDOW);
  const fromRoundId = Math.max(0, roundCount - window);

  let leaves: Awaited<ReturnType<typeof ctx.store.holderLeavesSince>>;
  try {
    leaves = await ctx.store.holderLeavesSince(fromRoundId);
  } catch (err) {
    logger.warn({ err: String(err), fromRoundId }, "holder push: leaf read failed; skipping this cycle");
    return out;
  }
  const roundIds = new Set(leaves.map((l) => l.roundId));
  out.rounds = roundIds.size;

  // STORED ROOT vs ON-CHAIN ROOT, once per round per cycle (cached), BEFORE any relay. A round
  // whose stored tree disagrees with the vault (round 87 since 2026-10-28) used to cost one
  // reverting claim() per leaf every cycle; now it is skipped with ONE warn line per cycle and
  // published as holderRounds.rootMismatchRounds on /internal/status.
  const storedRoots = new Map<number, string>();
  for (const l of leaves) if (!storedRoots.has(l.roundId)) storedRoots.set(l.roundId, l.root);
  const verdicts = await verifyRoundRoots(ctx, storedRoots);
  const mismatched = [...verdicts].filter(([, v]) => v === "mismatch").map(([id]) => id).sort((a, b) => a - b);
  holderHealth.rootMismatchRounds = mismatched;
  holderHealth.rootCheckedAt = new Date().toISOString();
  if (mismatched.length > 0) {
    logger.warn(
      { rounds: mismatched, holderVault: config.HOLDER_VAULT_ADDRESS },
      "holder push: stored root differs from the on-chain root; skipping these rounds (every claim would revert BadProof)",
    );
  }
  const relayable = leaves.filter((l) => verdicts.get(l.roundId) === "ok");

  // One relay pass per ACCOUNT: relayHolderClaims already walks that account's
  // whole unclaimed set and skips what the chain says is paid.
  const accounts = [...new Set(relayable.map((l) => l.account))];
  out.accounts = accounts.length;
  for (const account of accounts) {
    if (!beginHolderClaimFlight(account)) continue; // a live claim is landing; leave it alone
    try {
      const results = await relayHolderClaims(ctx, account, verdicts);
      out.pushed += results.length;
    } catch (err) {
      logger.warn({ err: String(err), account }, "holder push failed for account (retried next cycle)");
    } finally {
      endHolderClaimFlight(account);
    }
  }
  if (out.pushed > 0) {
    logger.info(out, "holder push: airdrops delivered without anyone asking");
  }
  return out;
}
