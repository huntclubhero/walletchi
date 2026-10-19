import { config } from "../config.js";
import { logger } from "../logger.js";
import type { AppContext } from "../context.js";
import type { LaunchpadPoolConfig } from "../chain/types.js";

// ---------------------------------------------------------------------------
// LAUNCHPAD CREATOR-FEE INLET
// ---------------------------------------------------------------------------
//
// THE PROBLEM THIS EXISTS TO SOLVE. Everything downstream of the CareFeeSplitter was built and
// tested: distribute() splits, the holder half posts Merkle rounds, the player half swaps into
// CARE. Nothing in the server ever put money INTO the splitter, because the launchpad fee does not
// stream anywhere. CARE launches on letscash.fun (CashCat's Uniswap-v4 launchpad); its pool-level
// trade tax ACCRUES to a "creator" seat inside the hook and is PULL-only:
//
//   hook.claim(poolId)              pulls the accrued fee   [CURRENT CREATOR ONLY]
//   hook.claim(poolId, to)          pulls it to any address [CURRENT CREATOR ONLY]
//   hook.updateCreator(poolId, a)   hands the seat onward   [CURRENT CREATOR ONLY]
//
// WHAT THE LIVE HOOK ACTUALLY EXPOSES, read out of the DEPLOYED RUNTIME BYTECODE of CashCatHookV2 at
// 0x75A54357D9C78a2Db19004a5FDc76c50F9242AEC on Robinhood Chain mainnet (chainId 4663) and
// cross-checked against its verified source. This replaced a set of guesses, and two of those
// guesses were wrong in ways that would have cost the whole revenue stream:
//   poolConfigs(bytes32)           0x07ef2190  PRESENT  -> the seat read, a 5-TUPLE not an address
//   claim(bytes32)                 0xbd66528a  PRESENT
//   claim(bytes32,address)         0x96c144f0  PRESENT  -> lets us claim STRAIGHT to the splitter
//   claim(bytes32,address,uint256) 0x98e5d7e2  PRESENT
//   updateCreator(bytes32,address) 0x3b0bc87e  PRESENT
//   sweep(bytes32)                 0x248eb4ec  PRESENT  -> permissionless; claim() sweeps first
//   creator(bytes32)               0x9f5ac8f7  ABSENT from BOTH the V1 and V2 hooks
// Fees are PULL based and accrue as ERC-6909 claims; sweep(poolId) is permissionless and books the
// creator share into tab[poolId]; claim sweeps and then pays.
//
// THE ONE-WAY MISTAKE, WRITTEN DOWN HERE SO IT IS NEVER REPEATED. The deploy script used to print
// "point the creator-fee stream at the splitter (hook.updateCreator)" as a launch instruction.
// CareFeeSplitter can call NEITHER of those functions: its entire external surface is
// setSwapAdapter / lockSwapAdapter / setSwapParams / setRateMaxAge / distribute / swapFloor /
// rateIsFresh / rescueToken / renounceOwnership plus Ownable2Step, and it contains no low-level
// call, no delegatecall, no receive() and no fallback(). Assigning the creator seat to it would
// make the entire trade-tax revenue stream permanently unclaimable AND permanently
// un-reassignable. Not delayed. Destroyed, with no owner key and no upgrade able to recover it.
//
// THE COLLECTOR, AND WHY IT IS AN EOA. The seat is assigned to a COLLECTOR: a dedicated EOA whose
// key the server holds (CARE_FEE_COLLECTOR_PRIVATE_KEY, exactly the HOLDER_POSTER_PRIVATE_KEY
// pattern). It is an EOA and not a small owned contract for three reasons, in order of weight:
//   1. THE HOOK ABI IS NOT PUBLISHED. letscash's docs give the hook address as n/a and the explorer
//      carries impersonators. The signatures above were recovered from the deployed bytecode rather
//      than from any document, and the hook is NOT upgradeable but it IS replaceable: a future pool
//      can be registered against a different hook with a different surface. A contract has to bake
//      the calldata into bytecode; if it is wrong the seat is held by something that cannot claim,
//      which is the EXACT failure being fixed here, reintroduced one level down. An EOA is
//      ABI-agnostic: whatever the real calldata turns out to be, the seat holder can send it.
//   2. Both hook calls are current-recipient-only, so the seat holder must be able to send
//      ARBITRARY calls to the hook. A contract that can do that is an owner-controlled
//      arbitrary-call proxy sitting on revenue, which is a strictly worse custody object than a
//      plain key: it has the same effective power plus a second failure surface.
//   3. The blast radius is bounded and already-accepted: at most one poke interval's accrual rests
//      on the collector, swept to the splitter on every run, nothing at rest. It is the same bound
//      the poster key already carries.
// A multisig satisfies the same requirement (arbitrary-call capable, ours) and is the better cold
// posture if one exists on this chain; the server simply would not automate the claim in that case.
// THE HARD RULE EITHER WAY: the seat may only ever be assigned to an address that can call claim()
// AND can hand the seat onward.
//
// WHAT THIS JOB DOES, on the same cadence as the fee distribution (4x/day by default), and
// deliberately BEFORE the splitter poke so the money it brings in is distributed the same cycle:
//   1. READ the hook's WHOLE pool config row and refuse to do anything unless ALL THREE of these
//      hold: the pool exists, its QUOTE ASSET is our configured fee token, and the creator seat is
//      our collector. Never blind-send;
//   2. CLAIM. By default straight to the CareFeeSplitter with claim(poolId, splitter), so the
//      collector EOA never custodies revenue and there is no forward transaction to fail. On a hook
//      that only offers claim(poolId) the fallback claims to the collector instead;
//   3. SWEEP whatever fee token is sitting on the collector to the CareFeeSplitter.
// Step 3 sweeps the WHOLE balance rather than just what step 2 claimed, which is what makes the
// fallback path self-healing: a run that claimed but failed to forward is completed by the next
// run. On the claim-to-splitter path it is pure housekeeping and normally moves nothing.
//
// WHY THE QUOTE-ASSET GUARD IS NOT PARANOIA. Our whole pipeline assumes USDG: FEE_TOKEN_DECIMALS is
// 6, the forward is an ERC-20 transfer, and CareFeeSplitter has NO receive() (deliberately, see the
// comment near contracts/src/runner/CareFeeSplitter.sol:61). But EVERY observed launch on this
// launchpad in the last ~600k blocks quoted in NATIVE ETH: 84 of 84 in a 29-hour window. On an
// ETH-quoted pool, claim() pays with .call{value:}, our ERC-20 forward would move nothing, and the
// splitter could not accept the money at all. So the inlet reads the quote and refuses to operate
// unless it is our fee token. CARE MUST LAUNCH ON A USDG-QUOTED CONFIG; see MAINNET-LAUNCH-RUNBOOK.md.
//
// IT IS A SILENT NO-OP UNTIL CONFIGURED. The hook address does not exist until we launch the pool,
// and on testnet there is no launchpad at all, so an unset hook must not produce a 4x/day error
// loop. The boot guards in config.ts are what keep that silence legible.

/** Which claim shape this run used. Explicit and logged, never inferred from a revert. */
export type LaunchpadClaimPath = "claim-to-splitter" | "claim-then-forward";

export interface LaunchpadInletResult {
  /** A claim transaction landed this run. */
  claimed: boolean;
  /** Raw fee-token units the claim moved (decimal string). */
  claimedRaw?: string;
  /** The claim paid the splitter directly, so no forward was needed for it. */
  claimedToSplitter?: boolean;
  /** Money reached the splitter this run, by either path. */
  forwarded: boolean;
  /** Raw fee-token units that reached the splitter (decimal string). */
  forwardedRaw?: string;
  /** Which claim shape was used. */
  claimPath?: LaunchpadClaimPath;
  /** Why nothing (or not everything) happened: unconfigured, a guard, or an error. */
  skipReason?: string;
}

export interface LaunchpadInletAttempt {
  at: string;
  ok: boolean;
  step?: "pool-config-read" | "claim" | "claim-to-splitter" | "forward";
  txHash?: string;
  raw?: string;
  error?: string;
}

// ---------------------------------------------------------------------------
// INLET HEALTH (the same observability contract the holder rounds got)
// ---------------------------------------------------------------------------
//
// The audited lesson from the holder-round failure was not that a background job can fail; it is
// that it failed INVISIBLY. This leg is worse in one specific way: when the inlet is dark, every
// downstream leg reports success while distributing nothing, so the whole system looks like a
// healthy season with no trade volume. That is indistinguishable from "nobody is claiming the
// revenue" unless something publishes this block. In memory and reset on restart, like
// care-metrics and the holder-round health: this is an operational pulse, not analytics.
export interface LaunchpadInletHealth {
  /** config.modes.launchpadInletLive: every piece of the claim -> forward path is configured. */
  inletLive: boolean;
  hookAddress: string | null;
  poolId: string | null;
  collectorConfigured: boolean;
  /** Our configured collector KEY's address (public). */
  collectorAddress: string | null;
  /** Which claim shape the inlet will use, decided by config and never by a revert. */
  claimPath: LaunchpadClaimPath;
  /** Element 0 of the hook's poolConfigs() row for our pool: the creator seat. */
  onChainCreator: string | null;
  /** null until checked, or when the read failed (an RPC blip is not a verdict). */
  creatorMatchesCollector: boolean | null;
  /**
   * The pool's QUOTE ASSET from the same read. The zero address means NATIVE ETH, which this
   * pipeline cannot handle and the splitter cannot even receive.
   */
  onChainQuote: string | null;
  /** null = unknown (the configured signature does not report a quote), which is NOT a pass. */
  quoteMatchesFeeToken: boolean | null;
  /** The hook's `exists` flag for our pool id. false means we are addressing a phantom pool. */
  poolExists: boolean | null;
  /** Economics, surfaced but not asserted. 9000 / 30000 on the live 3% tier. */
  poolCreatorFeeBps: number | null;
  poolFeeRate: number | null;
  creatorCheckedAt: string | null;
  creatorCheckError: string | null;
  lastRunAt: string | null;
  lastSkipReason: string | null;
  lastClaimAt: string | null;
  lastClaimTxHash: string | null;
  lastClaimedRaw: string | null;
  lastForwardAt: string | null;
  lastForwardTxHash: string | null;
  lastForwardedRaw: string | null;
  /** Cumulative forwarded since this process started. Not a ledger; a "is anything arriving" pulse. */
  totalForwardedRaw: string;
  /** Fee token sitting on the collector wallet at the last read: money in transit, not at rest. */
  collectorFeeTokenRaw: string | null;
  lastAttempt: LaunchpadInletAttempt | null;
  /** Consecutive failed CLAIMS. See the escalation note in _run: a lone revert is often normal. */
  consecutiveClaimFailures: number;
  /** Consecutive failed FORWARDS. Never normal: money is stranded on a hot key while this is > 0. */
  consecutiveForwardFailures: number;
}

// A claim that reverts is NOT automatically a fault: with no trades since the last cycle there is
// nothing to claim and a hook will typically revert rather than no-op. Logging that at ERROR four
// times a day would train everyone to ignore the one that matters. So a claim revert is a WARN
// carrying the full context, it always lands in this health block, and it ESCALATES to a loud
// ERROR once it has failed this many cycles in a row. At the default 4x/day cadence that is a full
// day of a stream that should be earning on every trade earning nothing, which is a real fault.
const CLAIM_FAILURE_ALERT_AFTER = 4;

// The NATIVE-ASSET sentinel. letscash writes address(0) into a pool's `quote` field when the pool is
// quoted in the chain's native coin. It is spelled out here because it is the single value that
// turns a working revenue inlet into a silent total loss.
const NATIVE_QUOTE = "0x0000000000000000000000000000000000000000";

// Read from config every time rather than captured once: the smoke suite flips these at runtime and
// an operator reading /internal/status wants the CURRENT posture. The choice is made HERE, from
// configuration, and never inferred from a revert: "claim(poolId,to) reverted" is indistinguishable
// from "nothing has accrued", so auto-falling-back on a failure would silently downgrade the path
// on every quiet cycle.
function claimPath(): LaunchpadClaimPath {
  return config.modes.launchpadClaimToSplitter && config.FEE_SPLITTER_ADDRESS
    ? "claim-to-splitter"
    : "claim-then-forward";
}

const inletHealth: LaunchpadInletHealth = {
  inletLive: config.modes.launchpadInletLive,
  hookAddress: config.LAUNCHPAD_HOOK_ADDRESS ?? null,
  poolId: config.LAUNCHPAD_POOL_ID ?? null,
  collectorConfigured: Boolean(config.careFeeCollectorAddress),
  collectorAddress: config.careFeeCollectorAddress ?? null,
  claimPath: claimPath(),
  onChainCreator: null,
  creatorMatchesCollector: null,
  onChainQuote: null,
  quoteMatchesFeeToken: null,
  poolExists: null,
  poolCreatorFeeBps: null,
  poolFeeRate: null,
  creatorCheckedAt: null,
  creatorCheckError: null,
  lastRunAt: null,
  lastSkipReason: null,
  lastClaimAt: null,
  lastClaimTxHash: null,
  lastClaimedRaw: null,
  lastForwardAt: null,
  lastForwardTxHash: null,
  lastForwardedRaw: null,
  totalForwardedRaw: "0",
  collectorFeeTokenRaw: null,
  lastAttempt: null,
  consecutiveClaimFailures: 0,
  consecutiveForwardFailures: 0,
};

export function getLaunchpadInletHealth(): LaunchpadInletHealth {
  // Re-read the config-derived fields on every call: the smoke flips them at runtime, and an
  // operator reading /internal/status wants the CURRENT posture, not the one captured at import.
  inletHealth.inletLive = config.modes.launchpadInletLive;
  inletHealth.hookAddress = config.LAUNCHPAD_HOOK_ADDRESS ?? null;
  inletHealth.poolId = config.LAUNCHPAD_POOL_ID ?? null;
  inletHealth.collectorConfigured = Boolean(config.careFeeCollectorAddress);
  inletHealth.collectorAddress = config.careFeeCollectorAddress ?? null;
  inletHealth.claimPath = claimPath();
  return { ...inletHealth };
}

/** Test hook. */
export function _resetLaunchpadInletHealth(): void {
  inletHealth.onChainCreator = null;
  inletHealth.creatorMatchesCollector = null;
  inletHealth.onChainQuote = null;
  inletHealth.quoteMatchesFeeToken = null;
  inletHealth.poolExists = null;
  inletHealth.poolCreatorFeeBps = null;
  inletHealth.poolFeeRate = null;
  inletHealth.creatorCheckedAt = null;
  inletHealth.creatorCheckError = null;
  inletHealth.lastRunAt = null;
  inletHealth.lastSkipReason = null;
  inletHealth.lastClaimAt = null;
  inletHealth.lastClaimTxHash = null;
  inletHealth.lastClaimedRaw = null;
  inletHealth.lastForwardAt = null;
  inletHealth.lastForwardTxHash = null;
  inletHealth.lastForwardedRaw = null;
  inletHealth.totalForwardedRaw = "0";
  inletHealth.collectorFeeTokenRaw = null;
  inletHealth.lastAttempt = null;
  inletHealth.consecutiveClaimFailures = 0;
  inletHealth.consecutiveForwardFailures = 0;
}

// Copy one poolConfigs() row into the health block. Recording and JUDGING are kept apart on purpose:
// the boot assertion and the 4x/day job publish the same facts and then say their own thing about
// them, so /internal/status can never show a verdict that came from a different read than its data.
function recordPoolConfig(pool: LaunchpadPoolConfig): void {
  inletHealth.onChainCreator = pool.creator;
  inletHealth.onChainQuote = pool.quote;
  inletHealth.poolExists = pool.exists;
  inletHealth.poolCreatorFeeBps = pool.creatorFeeBps;
  inletHealth.poolFeeRate = pool.feeRate;
  const feeToken = config.FEE_TOKEN_ADDRESS;
  inletHealth.quoteMatchesFeeToken =
    pool.quote && feeToken ? pool.quote.toLowerCase() === feeToken.toLowerCase() : null;
  inletHealth.creatorCheckedAt = new Date().toISOString();
  inletHealth.creatorCheckError = null;
}

// THE QUOTE-ASSET GATE. Returns null when the pool pays in the asset this pipeline can actually
// handle, or the sentence explaining the refusal.
//
// THE WRONG ASSUMPTION IT CLOSES: "the pool is quoted in USDG because that is what we designed for."
// Every observed launch on this launchpad in the last ~600k blocks was quoted in NATIVE ETH (84 of
// 84 over 29 hours). On such a pool the hook pays the creator with .call{value:}, so our ERC-20
// forward would move nothing, and CareFeeSplitter has no receive() and no fallback, so it could not
// take delivery even if we sent it. Claiming anyway would either strand ETH on a hot key or revert;
// neither is allowed to happen quietly. An UNKNOWN quote is treated exactly like a mismatch: this
// guard exists to make blind-claiming impossible, and "I could not read it" is not proof of safety.
function quoteRefusal(pool: LaunchpadPoolConfig): string | null {
  const feeToken = config.FEE_TOKEN_ADDRESS;
  if (!feeToken) {
    return "FEE_TOKEN_ADDRESS is unset, so there is nothing to check the pool's quote asset against";
  }
  if (!pool.quote) {
    return (
      "the hook read did not report a quote asset, so we cannot prove the pool pays in " +
      `${feeToken}. Point LAUNCHPAD_HOOK_CREATOR_FN at a signature that returns it (the live hook's ` +
      "is poolConfigs(bytes32), whose fifth return value is the quote)"
    );
  }
  if (pool.quote.toLowerCase() === feeToken.toLowerCase()) return null;
  if (pool.quote.toLowerCase() === NATIVE_QUOTE.toLowerCase()) {
    return (
      `the pool is quoted in NATIVE ETH (quote = ${NATIVE_QUOTE}), not in our fee token ${feeToken}. ` +
      "The hook would pay the creator fee with a raw value transfer: the ERC-20 forward cannot move " +
      "it and CareFeeSplitter cannot receive it at all (no receive(), no fallback, by design). CARE " +
      "must be launched on a USDG-quoted config; a relaunch is the only fix"
    );
  }
  return (
    `the pool's quote asset is ${pool.quote} but our fee token is ${feeToken}. Every downstream leg ` +
    "(decimals, the ERC-20 forward, the splitter) is built for the fee token, so nothing is claimed"
  );
}

// BOOT ASSERTION. Confirm at boot that the seat we think we hold is the seat the hook says we
// hold, and that the pool we are pointed at is one this pipeline can be paid from, instead of
// discovering either from a revert six hours later, or worse, never discovering it because a claim
// revert also looks like "no trades yet".
//
// NEVER BLOCKS BOOT, mirroring verifyHolderPoster and verifyRpcChainId:
//   - inlet not configured: nothing to check, and the config boot guard already said so.
//   - RPC unreadable: a WARN and we carry on. A cold RPC is not a verdict about a seat, and the
//     job re-reads creator() before every claim anyway.
//   - DEFINITE mismatch: a LOUD error naming BOTH addresses. This is the single most important
//     alarm in the whole revenue path, because a creator seat that is not ours is either a
//     misconfiguration or a stream that has already been redirected away from us.
export async function verifyLaunchpadCollector(ctx: AppContext): Promise<void> {
  if (!config.modes.launchpadInletLive) return;
  const configured = config.careFeeCollectorAddress;
  if (!configured) return; // config.ts already printed the loud [BOOT GUARD] line
  let pool: LaunchpadPoolConfig;
  try {
    // BOUNDED, for the same reason verifyHolderPoster is: this is awaited before app.listen, and a
    // diagnostic never gets to be the slow path on a cold start.
    pool = await Promise.race([
      ctx.relayer.launchpadPoolConfig(),
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error("timed out after 10s")), 10_000).unref?.(),
      ),
    ]);
  } catch (err) {
    inletHealth.creatorCheckError = String(err).slice(0, 200);
    inletHealth.creatorCheckedAt = new Date().toISOString();
    logger.warn(
      { err: String(err), hook: config.LAUNCHPAD_HOOK_ADDRESS, collector: configured },
      "could not read the launchpad hook's pool config; skipping the creator-seat check at boot",
    );
    return;
  }
  recordPoolConfig(pool);
  const onChain = pool.creator;
  const matches = onChain.toLowerCase() === configured.toLowerCase();
  inletHealth.creatorMatchesCollector = matches;

  // THE POOL ITSELF, checked before the seat, because a seat on a pool that cannot pay us is not a
  // working revenue stream no matter whose name is on it. Both of these are LOUD and neither blocks
  // boot: the job re-checks them before every claim and refuses there too.
  if (pool.exists === false) {
    logger.error(
      { hook: config.LAUNCHPAD_HOOK_ADDRESS, poolId: config.LAUNCHPAD_POOL_ID },
      `[BOOT GUARD] the launchpad hook reports NO registered pool for LAUNCHPAD_POOL_ID ` +
        `${config.LAUNCHPAD_POOL_ID} (exists = false). The id is wrong, or it belongs to a different ` +
        `hook. Take it from OUR OWN launch transaction receipt; nothing will be claimed until it is right.`,
    );
  }
  const quoteProblem = quoteRefusal(pool);
  if (quoteProblem) {
    logger.error(
      {
        hook: config.LAUNCHPAD_HOOK_ADDRESS,
        poolId: config.LAUNCHPAD_POOL_ID,
        onChainQuote: pool.quote,
        feeToken: config.FEE_TOKEN_ADDRESS,
      },
      `[BOOT GUARD] launchpad QUOTE ASSET problem: ${quoteProblem}. The creator-fee inlet will refuse ` +
        `to claim, so the splitter will receive nothing.`,
    );
  }
  if (matches) {
    logger.info(
      {
        collector: configured,
        hook: config.LAUNCHPAD_HOOK_ADDRESS,
        poolId: config.LAUNCHPAD_POOL_ID,
        quote: pool.quote,
        creatorFeeBps: pool.creatorFeeBps,
        feeRate: pool.feeRate,
        exists: pool.exists,
        claimPath: claimPath(),
      },
      "launchpad creator seat is held by our collector key",
    );
    return;
  }
  logger.error(
    { configuredCollector: configured, onChainCreator: onChain, hook: config.LAUNCHPAD_HOOK_ADDRESS },
    `[BOOT GUARD] launchpad creator MISMATCH: CARE_FEE_COLLECTOR_PRIVATE_KEY resolves to ${configured} ` +
      `but the hook's poolConfigs() reports creator = ${onChain} for pool ${config.LAUNCHPAD_POOL_ID}. No fee can be ` +
      `claimed and the splitter will receive nothing. If ${onChain} is an address we control, use it to ` +
      `call hook.updateCreator(poolId, ${configured}). If it is NOT an address we control, the revenue ` +
      `stream has been redirected away from us and this is an incident. NOTE: if ${onChain} is the ` +
      `CareFeeSplitter, the seat is UNRECOVERABLE (the splitter can call neither claim nor ` +
      `updateCreator) and the pool must be relaunched.`,
  );
}

// In-process guard against overlapping runs (the boot catch-up timer, the interval, or a manual
// poke). Two concurrent runs would both read the collector balance before either forward landed and
// the second forward would revert on an insufficient balance. The collector SerialQueue is the
// cross-call backstop; this flag closes the common window cheaply, exactly like the fee
// distribution's own in-flight guard.
let inletInFlight = false;

export async function runLaunchpadFeeInlet(ctx: AppContext): Promise<LaunchpadInletResult> {
  // SILENT NO-OP WHEN UNCONFIGURED. This is the state on testnet and the state before the token
  // launches, so it must not log an error four times a day. The reason is still RECORDED, so
  // /internal/status can answer "why is the splitter empty" without anyone reading logs.
  if (!config.modes.launchpadInletLive) {
    const reason = config.LAUNCHPAD_HOOK_ADDRESS
      ? "the creator-fee inlet is not fully configured (pool id, collector key, fee token or splitter missing)"
      : "no LAUNCHPAD_HOOK_ADDRESS: the creator-fee inlet is off (nothing claims the trade tax)";
    inletHealth.lastSkipReason = reason;
    return { claimed: false, forwarded: false, skipReason: reason };
  }
  if (inletInFlight) {
    logger.info("launchpad fee inlet already in flight; skipping this tick");
    return { claimed: false, forwarded: false, skipReason: "already in flight" };
  }
  inletInFlight = true;
  try {
    return await _run(ctx);
  } finally {
    inletInFlight = false;
  }
}

async function _run(ctx: AppContext): Promise<LaunchpadInletResult> {
  inletHealth.lastRunAt = new Date().toISOString();
  inletHealth.lastSkipReason = null;

  const path = claimPath();
  inletHealth.claimPath = path;

  // ---- GUARD 1: read the WHOLE pool config ----
  // Re-read EVERY cycle, not just at boot. The seat is reassignable by whoever holds it, so "we
  // hold it" is a fact with an expiry, and a claim signed against a seat we no longer hold is a
  // guaranteed revert at our gas cost that also looks exactly like "no trades this cycle".
  //
  // ONE READ, THREE FACTS. poolConfigs(bytes32) hands back the seat, the quote asset and the exists
  // flag together, so asserting the whole row costs nothing beyond the read we were already doing.
  // The previous version asked for creator(bytes32), a selector that is present in NEITHER deployed
  // hook, and then decoded the answer as a bare address, which a 5-tuple return is not.
  let pool: LaunchpadPoolConfig;
  try {
    pool = await ctx.relayer.launchpadPoolConfig();
  } catch (err) {
    // A FAILED READ IS NOT PERMISSION TO SEND. We cannot prove the seat is ours, so we do not
    // spend gas guessing. This is an ERROR and not a warn because an unreadable pool config on a
    // configured inlet means either the RPC is down or the hook address / read signature is
    // wrong, and every one of those stops all revenue.
    const reason = `could not read the hook's poolConfigs(): ${String(err).slice(0, 160)}`;
    inletHealth.creatorCheckError = String(err).slice(0, 200);
    inletHealth.creatorCheckedAt = new Date().toISOString();
    inletHealth.creatorMatchesCollector = null;
    inletHealth.quoteMatchesFeeToken = null;
    inletHealth.lastSkipReason = reason;
    inletHealth.lastAttempt = { at: new Date().toISOString(), ok: false, step: "pool-config-read", error: String(err).slice(0, 300) };
    logger.error(
      { err: String(err), hook: config.LAUNCHPAD_HOOK_ADDRESS, poolId: config.LAUNCHPAD_POOL_ID, creatorFn: config.LAUNCHPAD_HOOK_CREATOR_FN },
      "launchpad inlet skipped: the hook's pool config could not be read, so we cannot prove the " +
        "creator seat is ours and will not blind-send a claim. Check the RPC, LAUNCHPAD_HOOK_ADDRESS, " +
        "LAUNCHPAD_POOL_ID and LAUNCHPAD_HOOK_CREATOR_FN (the live hook's read is " +
        "poolConfigs(bytes32); creator(bytes32) does not exist on it).",
    );
    return { claimed: false, forwarded: false, claimPath: path, skipReason: reason };
  }
  const collector = config.careFeeCollectorAddress;
  recordPoolConfig(pool);
  const onChainCreator = pool.creator;

  // ---- GUARD 2: is this pool even registered? ----
  // exists = false means the id addresses nothing in this hook, so every claim would revert and the
  // seat comparison below would be a comparison against a default-zero struct. Refuse first.
  if (pool.exists === false) {
    const reason = `the hook has no registered pool for id ${config.LAUNCHPAD_POOL_ID} (exists = false)`;
    inletHealth.lastSkipReason = reason;
    logger.error(
      { hook: config.LAUNCHPAD_HOOK_ADDRESS, poolId: config.LAUNCHPAD_POOL_ID, onChainCreator },
      `launchpad inlet skipped: ${reason}. Nothing is claimed and no gas is burned. Take the pool id ` +
        `from OUR OWN launch transaction receipt: a wrong id reads as a configured inlet while ` +
        `claiming nothing forever.`,
    );
    return { claimed: false, forwarded: false, claimPath: path, skipReason: reason };
  }

  // ---- GUARD 3: is the pool paid in the asset this pipeline can handle? ----
  // THE TRAP THIS CLOSES, in one line: 84 of 84 observed launches on this launchpad were quoted in
  // NATIVE ETH, and on such a pool the claim pays with .call{value:} into a splitter that has no
  // receive(). Never blind-claim into a path that cannot receive what it is paid.
  const quoteProblem = quoteRefusal(pool);
  if (quoteProblem) {
    const reason = `quote asset mismatch: ${quoteProblem}`;
    inletHealth.lastSkipReason = reason;
    logger.error(
      {
        hook: config.LAUNCHPAD_HOOK_ADDRESS,
        poolId: config.LAUNCHPAD_POOL_ID,
        onChainQuote: pool.quote,
        feeToken: config.FEE_TOKEN_ADDRESS,
        feeTokenDecimals: config.FEE_TOKEN_DECIMALS,
        splitter: config.FEE_SPLITTER_ADDRESS,
      },
      `launchpad inlet REFUSING TO OPERATE: ${quoteProblem}. No claim and no transfer is attempted. ` +
        `This is deliberate: claiming an asset this pipeline cannot move would either revert or ` +
        `strand the money, and a claim that "succeeded" into a dead end is worse than one that never ran.`,
    );
    return { claimed: false, forwarded: false, claimPath: path, skipReason: reason };
  }

  // ---- GUARD 4: do we actually hold the seat? ----
  const holdsSeat = Boolean(collector) && onChainCreator.toLowerCase() === collector!.toLowerCase();
  inletHealth.creatorMatchesCollector = holdsSeat;
  if (!holdsSeat) {
    // NEVER BLIND-SEND. Same shape as the holder-round poster mismatch: name BOTH addresses, skip,
    // and say what to do. The extra sentence about the splitter is here because that is the one
    // value of onChainCreator that is not fixable, and an operator staring at this line at 3am
    // should not have to work that out.
    const reason = `creator mismatch: configured collector ${collector} but the hook's poolConfigs() creator is ${onChainCreator}`;
    inletHealth.lastSkipReason = reason;
    logger.error(
      {
        configuredCollector: collector,
        onChainCreator,
        hook: config.LAUNCHPAD_HOOK_ADDRESS,
        poolId: config.LAUNCHPAD_POOL_ID,
        splitter: config.FEE_SPLITTER_ADDRESS,
      },
      `launchpad inlet skipped: ${reason}. Every claim would revert, so none is attempted and no ` +
        `gas is burned. If the on-chain creator is an address we control, call ` +
        `hook.updateCreator(poolId, collector) from it. If it is the CareFeeSplitter, the seat is ` +
        `UNRECOVERABLE: the splitter can call neither claim() nor updateCreator().`,
    );
    return { claimed: false, forwarded: false, claimPath: path, skipReason: reason };
  }

  // ---- STEP 2: claim ----
  //
  // TWO PATHS, CHOSEN EXPLICITLY AND LOGGED, never inferred from a revert:
  //
  //   claim-to-splitter (DEFAULT). claim(poolId, splitter) exists on the live V2 hook, so the
  //     accrued fee goes straight where it is going. This deletes the separate forward transaction
  //     entirely: one fewer send, one fewer thing that can fail with money already claimed, and the
  //     collector EOA never custodies revenue at all. Nothing needs notifying afterwards, because
  //     CareFeeSplitter.distribute() is permissionless and works off its own balance.
  //
  //   claim-then-forward (FALLBACK). A hook that only offers claim(poolId) pays the seat holder,
  //     so the collector receives it and step 3 sweeps it onward. This is the V1 hook's shape.
  //
  // Both paths keep the identical seat / quote / exists guards above, and both feed the same health
  // block, so the choice changes the transaction count and nothing else about what is asserted.
  const toSplitter = path === "claim-to-splitter";
  let claimed = false;
  let claimedRaw = 0n;
  let claimSkipReason: string | undefined;
  let claimedStraightToSplitter = false;
  try {
    if (toSplitter) {
      // Measured on the SPLITTER's balance, because that is where the money lands and the collector
      // balance never moves on this path.
      const before = await ctx.relayer.splitterBalance();
      const { txHash } = await ctx.relayer.launchpadClaimToSplitter();
      const after = await ctx.relayer.splitterBalance();
      claimedRaw = after > before ? after - before : 0n;
      claimed = true;
      claimedStraightToSplitter = true;
      inletHealth.consecutiveClaimFailures = 0;
      // consecutiveForwardFailures is deliberately NOT cleared here. It counts failures of the sweep
      // that rescues money stranded on the collector, and a successful claim-to-splitter says nothing
      // about whether that stranded balance moved. Only a successful sweep clears it.
      const at = new Date().toISOString();
      inletHealth.lastClaimAt = at;
      inletHealth.lastClaimTxHash = txHash;
      inletHealth.lastClaimedRaw = claimedRaw.toString();
      // The claim IS the delivery on this path, so it counts as a forward too: an operator reading
      // /internal/status must see money arriving at the splitter, not an eternally stale
      // lastForwardAt just because no transfer transaction exists any more.
      inletHealth.lastForwardAt = at;
      inletHealth.lastForwardTxHash = txHash;
      inletHealth.lastForwardedRaw = claimedRaw.toString();
      inletHealth.totalForwardedRaw = (BigInt(inletHealth.totalForwardedRaw) + claimedRaw).toString();
      inletHealth.lastAttempt = { at, ok: true, step: "claim-to-splitter", txHash, raw: claimedRaw.toString() };
      logger.info(
        { txHash, raw: claimedRaw.toString(), splitter: config.FEE_SPLITTER_ADDRESS, poolId: config.LAUNCHPAD_POOL_ID },
        "launchpad creator fee claimed STRAIGHT to the CareFeeSplitter (no forward transaction needed)",
      );
    } else {
      const beforeClaim = await ctx.relayer.collectorFeeTokenBalance();
      const { txHash } = await ctx.relayer.launchpadClaim();
      const afterClaim = await ctx.relayer.collectorFeeTokenBalance();
      // Measured, not assumed: the hook tells us nothing useful in a return value, and the balance
      // delta is the only number that says how much actually arrived.
      claimedRaw = afterClaim > beforeClaim ? afterClaim - beforeClaim : 0n;
      claimed = true;
      inletHealth.consecutiveClaimFailures = 0;
      inletHealth.lastClaimAt = new Date().toISOString();
      inletHealth.lastClaimTxHash = txHash;
      inletHealth.lastClaimedRaw = claimedRaw.toString();
      inletHealth.lastAttempt = { at: new Date().toISOString(), ok: true, step: "claim", txHash, raw: claimedRaw.toString() };
      logger.info(
        { txHash, raw: claimedRaw.toString(), collector, poolId: config.LAUNCHPAD_POOL_ID },
        "launchpad creator fee claimed to the collector wallet (claim-then-forward fallback path)",
      );
    }
  } catch (err) {
    // ESCALATING, NOT SPAMMING. See CLAIM_FAILURE_ALERT_AFTER: a lone revert is usually "nothing
    // accrued since the last cycle", which is a normal state on a quiet pool and must not cry wolf
    // four times a day. A RUN of them is a real fault (wrong claim signature, a paused hook, a dry
    // collector wallet), so the run is what gets the loud error. Either way it is recorded here and
    // published on /internal/status, so the state is never invisible.
    inletHealth.consecutiveClaimFailures += 1;
    claimSkipReason = `claim failed: ${String(err).slice(0, 160)}`;
    inletHealth.lastAttempt = {
      at: new Date().toISOString(),
      ok: false,
      step: toSplitter ? "claim-to-splitter" : "claim",
      error: String(err).slice(0, 300),
    };
    const ctxLog = {
      err: String(err),
      consecutiveClaimFailures: inletHealth.consecutiveClaimFailures,
      hook: config.LAUNCHPAD_HOOK_ADDRESS,
      poolId: config.LAUNCHPAD_POOL_ID,
      claimPath: path,
      claimFn: toSplitter ? config.LAUNCHPAD_HOOK_CLAIM_TO_FN : config.LAUNCHPAD_HOOK_CLAIM_FN,
      collector,
    };
    if (inletHealth.consecutiveClaimFailures >= CLAIM_FAILURE_ALERT_AFTER) {
      logger.error(
        ctxLog,
        `launchpad claim has failed ${inletHealth.consecutiveClaimFailures} cycles in a row on the ` +
          `${path} path. A single revert is normal (nothing accrued since the last cycle); this many is ` +
          `not. Check the claim signature against the real hook ABI, the collector's gas balance, and ` +
          `whether the pool is trading at all (see /internal/status launchpadInlet). If this hook only ` +
          `offers claim(bytes32), clear LAUNCHPAD_HOOK_CLAIM_TO_FN to fall back to claim-then-forward.`,
      );
    } else {
      logger.warn(
        ctxLog,
        "launchpad claim reverted; continuing to the forward step in case an earlier claim is still " +
          "waiting on the collector wallet (a lone revert usually just means nothing has accrued)",
      );
    }
  }

  // ---- STEP 3: sweep whatever is on the collector, claimed this run or not ----
  // SWEEPING THE WHOLE BALANCE, not just this run's delta, is what makes the inlet self-healing: a
  // previous cycle that claimed successfully and then failed to forward leaves money on a hot key,
  // and this is the step that finishes the job without anyone intervening. It is also why the
  // forward runs even when the claim above reverted.
  //
  // ON THE CLAIM-TO-SPLITTER PATH THIS IS PURE HOUSEKEEPING and normally moves nothing: the money
  // never touches the collector. It still runs, because a deployment that used to run the fallback
  // path (or an operator who claimed by hand) can leave a residue behind, and money on a hot key
  // must never wait for someone to notice it.
  let forwarded = claimedStraightToSplitter;
  let forwardedRaw = claimedStraightToSplitter ? claimedRaw : 0n;
  let forwardSkipReason: string | undefined;
  try {
    const balance = await ctx.relayer.collectorFeeTokenBalance();
    inletHealth.collectorFeeTokenRaw = balance.toString();
    const minForward = BigInt(config.LAUNCHPAD_MIN_FORWARD_RAW ?? "0");
    if (balance === 0n) {
      // An empty collector is the EXPECTED state after a successful claim-to-splitter, so saying
      // "nothing to forward" there would report a normal cycle as a partial one.
      if (!claimedStraightToSplitter) forwardSkipReason = "nothing on the collector wallet to forward";
    } else if (balance < minForward) {
      // Dust: not worth a transfer's gas this cycle. Nothing is withheld beyond one cycle, because
      // this check re-runs every poke and the balance only grows.
      forwardSkipReason = `collector balance ${balance} is below LAUNCHPAD_MIN_FORWARD_RAW ${minForward}`;
      logger.info({ balance: balance.toString(), minForward: minForward.toString() }, forwardSkipReason);
    } else {
      const { txHash } = await ctx.relayer.collectorForwardToSplitter(balance);
      forwarded = true;
      // Added, not overwritten: on the claim-to-splitter path this run may have delivered money by
      // both routes, and the number reported has to be everything that reached the splitter.
      forwardedRaw += balance;
      inletHealth.consecutiveForwardFailures = 0;
      inletHealth.lastForwardAt = new Date().toISOString();
      inletHealth.lastForwardTxHash = txHash;
      inletHealth.lastForwardedRaw = balance.toString();
      inletHealth.totalForwardedRaw = (BigInt(inletHealth.totalForwardedRaw) + balance).toString();
      inletHealth.collectorFeeTokenRaw = "0";
      inletHealth.lastAttempt = { at: new Date().toISOString(), ok: true, step: "forward", txHash, raw: balance.toString() };
      logger.info(
        { txHash, raw: balance.toString(), splitter: config.FEE_SPLITTER_ADDRESS },
        "creator fee forwarded to the CareFeeSplitter",
      );
    }
  } catch (err) {
    // ALWAYS A LOUD ERROR, with no escalation threshold and no "this might be normal". A failed
    // forward means claimed revenue is sitting on a hot single-key wallet instead of in the
    // splitter, which is the one state in this whole pipeline that is never acceptable and never
    // self-corrects without either this job or a human.
    inletHealth.consecutiveForwardFailures += 1;
    forwardSkipReason = `forward failed: ${String(err).slice(0, 160)}`;
    inletHealth.lastAttempt = { at: new Date().toISOString(), ok: false, step: "forward", error: String(err).slice(0, 300) };
    logger.error(
      {
        err: String(err),
        consecutiveForwardFailures: inletHealth.consecutiveForwardFailures,
        collector,
        splitter: config.FEE_SPLITTER_ADDRESS,
        feeToken: config.FEE_TOKEN_ADDRESS,
      },
      "creator fee FORWARD FAILED: claimed revenue is stranded on the collector wallet instead of " +
        "the splitter. It will be retried in full on the next cycle (the forward sweeps the whole " +
        "balance), but until it lands the money is on a hot key. Check the collector's gas balance.",
    );
  }

  const skipReason = [claimSkipReason, forwardSkipReason].filter(Boolean).join("; ") || undefined;
  if (skipReason) inletHealth.lastSkipReason = skipReason;
  return {
    claimed,
    claimedRaw: claimed ? claimedRaw.toString() : undefined,
    claimedToSplitter: claimedStraightToSplitter || undefined,
    forwarded,
    forwardedRaw: forwarded ? forwardedRaw.toString() : undefined,
    claimPath: path,
    skipReason,
  };
}
