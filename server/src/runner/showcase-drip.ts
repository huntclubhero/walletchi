import { parseUnits } from "viem";
import { config } from "../config.js";
import { logger } from "../logger.js";
import type { AppContext } from "../context.js";

// TESTNET SHOWCASE: SIMULATED TRADING FEES.
//
// On mainnet the CareFeeSplitter is fed by the launchpad trade tax (runner/launchpad-inlet.ts).
// Robinhood testnet has no launchpad, so nothing ever enters the splitter and two of the economy's
// four flows (the USDG holder airdrop, and the USDG -> CARE swap into the player rewards pool) sit
// at zero for the whole showcase. This drip is the stand-in: once per 2h epoch it mints a fixed
// amount of the MOCK fee token straight into the splitter, the push engine's distribute() in the
// same cycle splits and swaps it, and the holder round posts it on the tax cadence, all exactly as
// they would treat real revenue (see runShowcaseFeeLeg for why the two halves run apart). Nothing downstream knows
// or cares where the USDG came from, which is the point: every leg the drip exercises is the real
// mainnet code path.
//
// WHY THE SPLITTER AND NOT THE HOLDER VAULT OR THE DISTRIBUTOR. The splitter is where fee revenue
// ENTERS the system. Funding either leg directly would skip the split, the swap and its floor, and
// would demonstrate a pipeline that does not exist.
//
// IT ALSO KEEPS THE SWAP RATE ALIVE. The splitter refuses to swap on a rate hint older than
// rateMaxAge (12h by default) and PARKS the player half instead. The deploy sets the hint once, so
// without a re-affirm the swap leg goes dark twelve hours into a sixty-day showcase. Re-setting the
// SAME rate is not a decrease, so the contract's rationing does not apply, and it is owner-only,
// which works here only because the testnet deployer (owner) is also the relayer. On any deploy
// where that is not true the re-affirm is skipped with a log line rather than attempted.
//
// OFF BY DEFAULT and refused at boot on mainnet (config.ts): the mint relies on MockUSDG's open
// faucet, and real USDG has none.

/** One drip per this many seconds: the 2h push epoch. */
export const SHOWCASE_DRIP_EPOCH_SECONDS = 2 * 60 * 60;

export interface ShowcaseDripResult {
  dripped: boolean;
  epoch: number | null;
  amountRaw: bigint;
  txHash: string | null;
  rateReaffirmed: boolean;
  /** Why nothing was minted this cycle (null when it dripped). */
  skipped: string | null;
}

export function showcaseDripEpoch(nowMs: number): number {
  return Math.floor(nowMs / 1000 / SHOWCASE_DRIP_EPOCH_SECONDS);
}

/** SHOWCASE_USDG_DRIP_AMOUNT in raw fee-token units, or null when it is unusable or zero. */
export function showcaseDripAmountRaw(): bigint | null {
  try {
    const raw = parseUnits(config.SHOWCASE_USDG_DRIP_AMOUNT.trim(), config.FEE_TOKEN_DECIMALS);
    return raw > 0n ? raw : null;
  } catch {
    return null;
  }
}

/**
 * Re-affirm the splitter's swap-rate hint once it is past half its lifetime, so it can never reach
 * stale between two cycles. Returns true when a re-affirm was sent. Never throws.
 */
export async function reaffirmSplitterRate(ctx: AppContext, nowSec: number): Promise<boolean> {
  try {
    const st = await ctx.relayer.splitterRateState();
    // 0 is the owner's explicit "swap leg off"; re-enabling it is a human decision, not a cron's.
    if (st.rate === 0n) return false;
    if (nowSec - st.updatedAt < Math.floor(st.maxAge / 2)) return false;
    if (st.owner.toLowerCase() !== ctx.relayer.address.toLowerCase()) {
      logger.warn(
        { owner: st.owner, relayer: ctx.relayer.address, ageSec: nowSec - st.updatedAt, maxAge: st.maxAge },
        "showcase drip: the splitter's swap rate is ageing but the relayer is not its owner, so it cannot re-affirm it; the player half will park once it is stale",
      );
      return false;
    }
    const { txHash } = await ctx.relayer.splitterReaffirmRate(st.slippageBps, st.rate);
    logger.info({ txHash, rate: st.rate.toString(), ageSec: nowSec - st.updatedAt }, "showcase drip: splitter swap rate re-affirmed");
    return true;
  } catch (err) {
    logger.warn({ err: String(err) }, "showcase drip: swap rate re-affirm failed (retried next cycle)");
    return false;
  }
}

/**
 * One drip attempt. Idempotent per (fee token, 2h epoch): the ledger row is reserved BEFORE the mint
 * is sent, so a restart or a second instance can never drip the same epoch twice, and a failed mint
 * releases its row so the next cycle retries. Never throws: a showcase convenience must not be able
 * to take the real distribution cycle down with it.
 */
export async function runShowcaseUsdgDrip(ctx: AppContext, nowMs = Date.now()): Promise<ShowcaseDripResult> {
  const out: ShowcaseDripResult = {
    dripped: false,
    epoch: null,
    amountRaw: 0n,
    txHash: null,
    rateReaffirmed: false,
    skipped: null,
  };
  if (!config.SHOWCASE_USDG_DRIP) {
    out.skipped = "disabled";
    return out;
  }
  // Belt and braces: the boot guard already refuses this combination.
  if (config.ROBINHOOD_NETWORK === "mainnet") {
    out.skipped = "mainnet";
    return out;
  }
  const token = config.FEE_TOKEN_ADDRESS;
  if (!config.FEE_SPLITTER_ADDRESS || !token) {
    out.skipped = "splitter or fee token not configured";
    return out;
  }

  out.rateReaffirmed = await reaffirmSplitterRate(ctx, Math.floor(nowMs / 1000));

  const amountRaw = showcaseDripAmountRaw();
  if (amountRaw === null) {
    out.skipped = "SHOWCASE_USDG_DRIP_AMOUNT is zero or not a number";
    logger.error({ amount: config.SHOWCASE_USDG_DRIP_AMOUNT }, "showcase drip: unusable SHOWCASE_USDG_DRIP_AMOUNT; nothing minted");
    return out;
  }
  const epoch = showcaseDripEpoch(nowMs);
  out.epoch = epoch;
  out.amountRaw = amountRaw;

  let reserved: boolean;
  try {
    reserved = await ctx.store.reserveShowcaseDrip(token, epoch, amountRaw.toString());
  } catch (err) {
    out.skipped = "ledger unavailable";
    logger.warn({ err: String(err), epoch }, "showcase drip: could not reserve the epoch (retried next cycle)");
    return out;
  }
  if (!reserved) {
    out.skipped = "already dripped this epoch";
    return out;
  }

  try {
    const { txHash } = await ctx.relayer.showcaseMintFeeToSplitter(amountRaw);
    out.dripped = true;
    out.txHash = txHash;
    await ctx.store.recordShowcaseDripTx(token, epoch, txHash).catch((err) =>
      logger.warn({ err: String(err), epoch, txHash }, "showcase drip: minted but could not record the tx hash"),
    );
    logger.info(
      { txHash, epoch, raw: amountRaw.toString(), splitter: config.FEE_SPLITTER_ADDRESS },
      "showcase drip: simulated trading fees minted into the splitter",
    );
  } catch (err) {
    out.skipped = "mint failed";
    // Hand the epoch back so the next cycle retries it. If this release itself fails the epoch is
    // simply skipped: one missing drip, never a double one.
    await ctx.store.releaseShowcaseDrip(token, epoch).catch(() => {});
    logger.warn({ err: String(err), epoch }, "showcase drip: mint failed (retried next cycle)");
  }
  return out;
}

/**
 * The 2h leg of the showcase fee flow, run by the push engine: drip, then distribute(). Kept apart
 * from the holder ROUND on purpose. distribute() is one cheap transaction, and it is what makes the
 * swap leg and the holder vault visibly move every epoch. Posting a round is the expensive half: every
 * live pet's TBA is an eligible holder, so one round is about one delivery transaction per live pet.
 * That stays on TAX_DISTRIBUTION_MINUTES, whose cycle also calls the drip, harmlessly, because the
 * drip is idempotent per epoch. Never throws.
 */
export async function runShowcaseFeeLeg(ctx: AppContext): Promise<{ dripped: boolean; distributed: boolean }> {
  const out = { dripped: false, distributed: false };
  if (!config.SHOWCASE_USDG_DRIP || !config.modes.holderRewardsLive) return out;
  out.dripped = (await runShowcaseUsdgDrip(ctx)).dripped;
  try {
    if ((await ctx.relayer.splitterBalance()) > 0n) {
      const { txHash } = await ctx.relayer.splitterDistribute();
      out.distributed = true;
      logger.info({ txHash }, "showcase fee leg: splitter distributed (holder half to the vault, player half swapped to CARE)");
    }
  } catch (err) {
    logger.warn({ err: String(err) }, "showcase fee leg: distribute failed (retried next cycle)");
  }
  return out;
}
