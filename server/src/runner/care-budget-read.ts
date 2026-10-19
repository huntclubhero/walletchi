import type { AppContext } from "../context.js";
import type { PetSpendState } from "../chain/types.js";
import type { Runner } from "../store/types.js";
import { cachedPetNeeds, getVaultConfig, NEED_ACTIONS, NEED_LABELS, CARE_ACTION_TYPE } from "./season.js";
import { careBudgetVerdict, caresLeft, stalestNeed, windowReopensAt } from "./care-budget.js";
import { config } from "../config.js";

// The care budget as the WEBSITE care page needs it (GET /api/pet/:tokenId/care-budget). The pass
// taps already run smart care on the server (routes.ts); the website signs its own care, so it asks
// here first and shows the same answers: a free "this need can wait" instead of a spend, cares left
// in the 24h window, when the window reopens, and how long the pet has. Public and read-only: every
// number here is already readable on-chain by anyone (needsOf, the account's dailyCap/windowStart/
// spentInWindow), and nothing from the store beyond the pet's own public account address is used.
export interface CareBudgetReport {
  verdict: "ok" | "fresh" | "reserve";
  stalestAction: string | null;
  stalestLabel: string | null;
  stalestSecondsLeft: number | null;
  caresLeft: number | null; // null when the account limit is unreadable
  dailyCares: number | null;
  reopensInSeconds: number | null; // 0 = the window is open now
  lifeSecondsLeft: number | null; // until the stalest need lapses
}

export const EMPTY_CARE_BUDGET: CareBudgetReport = {
  verdict: "ok",
  stalestAction: null,
  stalestLabel: null,
  stalestSecondsLeft: null,
  caresLeft: null,
  dailyCares: null,
  reopensInSeconds: null,
  lifeSecondsLeft: null,
};

// A public route must stay cheap: the spend window is three chain reads, so cache it briefly per
// account and coalesce concurrent reads (same shape as cachedPetNeeds). A failed or slow read is
// null and never cached.
const SPEND_TTL_MS = 5_000;
const SPEND_TIMEOUT_MS = 1_500;
const spendCache = new Map<string, { spend: PetSpendState | null; at: number }>();
const spendInFlight = new Map<string, Promise<PetSpendState | null>>();

function withTimeout<T>(p: Promise<T>, ms: number): Promise<T | null> {
  return new Promise((resolve) => {
    const t = setTimeout(() => resolve(null), ms);
    t.unref?.();
    p.then(
      (v) => {
        clearTimeout(t);
        resolve(v);
      },
      () => {
        clearTimeout(t);
        resolve(null);
      },
    );
  });
}

async function cachedSpendState(ctx: AppContext, account: string): Promise<PetSpendState | null> {
  const key = account.toLowerCase();
  const hit = spendCache.get(key);
  if (hit && Date.now() - hit.at < SPEND_TTL_MS) return hit.spend;
  const inFlight = spendInFlight.get(key);
  if (inFlight) return inFlight;
  const read = withTimeout(ctx.relayer.petSpendState(account), SPEND_TIMEOUT_MS)
    .then((spend) => {
      if (spend) {
        spendCache.set(key, { spend, at: Date.now() });
        if (spendCache.size > 4000) spendCache.clear(); // bounded
      }
      return spend;
    })
    .finally(() => {
      spendInFlight.delete(key);
    });
  spendInFlight.set(key, read);
  return read;
}

/** Test hook: clear the spend cache between scenarios. */
export function _resetCareBudgetCache(): void {
  spendCache.clear();
  spendInFlight.clear();
}

export async function careBudgetReport(ctx: AppContext, runner: Runner, action?: string): Promise<CareBudgetReport> {
  if (!runner.tokenId || runner.gone) return EMPTY_CARE_BUDGET;
  const readSpend = runner.tbaAddress ? cachedSpendState(ctx, runner.tbaAddress) : Promise.resolve(null);
  const [{ needAt }, vcfg, spend] = await Promise.all([cachedPetNeeds(ctx, runner.tokenId), getVaultConfig(ctx), readSpend]);
  if (needAt.length !== 5 || needAt.every((t) => t === 0)) return EMPTY_CARE_BUDGET; // egg or unknown: nothing to say
  const now = Math.floor(Date.now() / 1000);
  const lifeSecondsLeft = Math.max(0, Math.min(...needAt) + vcfg.lifeTtlSeconds - now);
  if (lifeSecondsLeft === 0) return EMPTY_CARE_BUDGET; // lapsed: the vault answers, not us
  const actionType = action ? CARE_ACTION_TYPE[action] : undefined;
  // SMART CARE OFF (config.SMART_CARE_ENABLED, Hunt 2026-10-18): every tap spends, and the website
  // shows no cares-left counter (caresLeft / dailyCares null hide it). The stalest need and the
  // life clock stay: they are the card's SURVIVES truth, not a limit warning.
  const smart = config.SMART_CARE_ENABLED;
  const v =
    actionType === undefined || !smart
      ? { kind: "ok" as const }
      : careBudgetVerdict({ actionType, needAt, lifeTtl: vcfg.lifeTtlSeconds, now, careCost: vcfg.careCostRaw, spend });
  const stalest = stalestNeed(needAt);
  const left = smart ? caresLeft(spend, vcfg.careCostRaw, now) : Infinity;
  return {
    verdict: v.kind,
    stalestAction: NEED_ACTIONS[stalest]!,
    stalestLabel: NEED_LABELS[stalest]!,
    stalestSecondsLeft: Math.max(0, needAt[stalest]! + vcfg.lifeTtlSeconds - now),
    caresLeft: Number.isFinite(left) ? left : null,
    dailyCares: smart && spend && vcfg.careCostRaw > 0n ? Number(spend.dailyCap / vcfg.careCostRaw) : null,
    reopensInSeconds: spend ? Math.max(0, windowReopensAt(spend, now) - now) : null,
    lifeSecondsLeft,
  };
}

/** The whole report under a hard deadline: a slow needs read answers "ok" rather than stall a care. */
export async function careBudgetReportWithin(ctx: AppContext, runner: Runner, action: string | undefined, ms = 2_500): Promise<CareBudgetReport> {
  return (await withTimeout(careBudgetReport(ctx, runner, action), ms)) ?? EMPTY_CARE_BUDGET;
}

// The reminder engine's view of the spend window (idle.ts): how many cares the pet's account has
// left right now and when the window reopens. Uncached and under a short deadline; null whenever
// anything is unreadable or slow, and the caller then behaves exactly as if this did not exist.
export async function spendWindowFor(
  ctx: AppContext,
  account: string | null,
  nowSec: number,
  ms = SPEND_TIMEOUT_MS,
): Promise<{ caresLeft: number; reopensAt: number } | null> {
  if (!account) return null;
  const read = await withTimeout(Promise.all([ctx.relayer.petSpendState(account), getVaultConfig(ctx)]), ms);
  if (!read || !read[0]) return null;
  const [spend, vcfg] = read;
  const left = caresLeft(spend, vcfg.careCostRaw, nowSec);
  if (!Number.isFinite(left)) return null;
  return { caresLeft: left, reopensAt: windowReopensAt(spend, nowSec) };
}
