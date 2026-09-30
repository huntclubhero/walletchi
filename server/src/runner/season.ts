import { config } from "../config.js";
import { logger } from "../logger.js";
import type { AppContext } from "../context.js";
import type { Runner } from "../store/types.js";
import type { PetVaultConfig, SeasonGate } from "../chain/types.js";
import { chainNeedsToMeters } from "./needs.js";

// WALLETCHI survival season: the redesign-STABLE reflect layer. The care()
// payment write + memorialState/settlement reads live on the chain client; this
// module holds the cached snapshot the pass front reads (so the survivor count
// piggybacks on pushes we already send, never a per-death fan-out) plus the small
// display helpers. Settlement/finalize/victory wiring is HELD for the frozen ABI.

// actionType uint8 the vault's care() expects. CANONICAL AND LOCKED (five-needs
// redesign, matches contract NEED_COUNT order + web-cub CARE_ACTIONS): each
// action IS a need, and care(tokenId, actionType) refreshes only that need.
export const CARE_ACTION_TYPE: Record<string, number> = {
  feed: 0,
  water: 1,
  play: 2,
  toy: 3,
  explore: 4,
};

// The five needs in canonical actionType order: action slugs (API/care links)
// and display labels (wallet card meters, push copy).
export const NEED_ACTIONS = ["feed", "water", "play", "toy", "explore"] as const;
export const NEED_LABELS = ["Feed", "Water", "Play", "Toy", "Explore"] as const;

// Per-need seconds left, clamped at 0: needAt[i] + lifeTtl - now. Index =
// canonical actionType. Shared by the pass meters, the state payload, and the
// cooldown math so every surface derives deadlines one way.
export function needsSecondsLeft(
  needAt: readonly number[],
  lifeTtlSeconds: number,
  nowSec: number,
): number[] {
  return [0, 1, 2, 3, 4].map((i) => Math.max(0, (needAt[i] ?? 0) + lifeTtlSeconds - nowSec));
}

// The index of the BINDING need (the one that dies first): the min stamp.
// First index wins a tie, matching the contract's min derivation order.
export function bindingNeedIndex(needAt: readonly number[]): number {
  let minIdx = 0;
  for (let i = 1; i < 5; i++) {
    if ((needAt[i] ?? 0) < (needAt[minIdx] ?? 0)) minIdx = i;
  }
  return minIdx;
}

export interface SeasonSnapshot {
  aliveCount: number;
  // Pets actually registered (minted) in the season. `total` is the supply CAP
  // (2000); `registered` is how many exist so far. Fallen = registered - alive,
  // never cap - alive (unminted supply is not "fallen").
  registered: number;
  // Pets fed at least once, so actually IN the race. The cap is a ceiling on
  // how many could ever hatch, never a count of how many did: a surface that
  // says "2,000 hatched" while two pets exist is simply wrong.
  hatched: number;
  total: number;
  potRaw: bigint;
  burnedRaw: bigint; // care token at dEaD (the burn ledger); stats-band display
  careTokenDecimals: number;
  seasonActive: boolean;
  fetchedAt: number;
}

// Pre-season stub: full supply alive, season inactive. So the survivor-count field
// renders a real "N / 2,000" layout even before the vault lands.
let snapshot: SeasonSnapshot = {
  aliveCount: config.RUNNER_SUPPLY_CAP,
  registered: 0,
  hatched: 0,
  total: config.RUNNER_SUPPLY_CAP,
  potRaw: 0n,
  burnedRaw: 0n,
  careTokenDecimals: config.CARE_TOKEN_DECIMALS,
  seasonActive: false,
  fetchedAt: 0,
};

const SNAPSHOT_TTL_MS = 60_000;

export function getSeasonSnapshot(): SeasonSnapshot {
  return snapshot;
}

// The vault's immutable-ish config (careCost + lifeTtl + careCooldown), read once
// and cached. Used by the life-timer math (deadline = lastCareAt + lifeTtl) and
// the cooldown countdown on the "Easy there" page.
let cachedVaultConfig: PetVaultConfig | null = null;
export async function getVaultConfig(ctx: AppContext): Promise<PetVaultConfig> {
  if (cachedVaultConfig) return cachedVaultConfig;
  cachedVaultConfig = await ctx.relayer.petVaultConfig();
  return cachedVaultConfig;
}

// The sellout start gate, cached briefly. NOT cached forever like the vault config
// above: `startedAt` flips exactly once, from 0, and every off-chain deadline in
// this file is measured from it, so a stale zero would keep reporting a whole
// colony as clock-less minutes after the race began.
const SEASON_GATE_TTL_MS = 15_000;
let cachedSeasonGate: { gate: SeasonGate; at: number } | null = null;

// RUNNER_SUPPLY_CAP IS AN ENV MIRROR OF THE CHAIN'S maxSupply, and the mint route
// checks the mirror FIRST. A season redeploy that changes the supply (5 for the
// tester season, 1000 for the showcase) without the env edit either refuses mints
// as "sold out" while the collection still has room, or reports a cap the chain
// will never honour. Nothing else compares the two, so say it once, loudly.
let supplyCapDriftLogged = false;
function warnOnSupplyCapDrift(chainMaxSupply: number): void {
  if (supplyCapDriftLogged || chainMaxSupply <= 0 || chainMaxSupply === config.RUNNER_SUPPLY_CAP) return;
  supplyCapDriftLogged = true;
  logger.error(
    { runnerSupplyCap: config.RUNNER_SUPPLY_CAP, chainMaxSupply },
    "RUNNER_SUPPLY_CAP does not match the collection's on-chain maxSupply: set RUNNER_SUPPLY_CAP to the chain value",
  );
}

export async function getSeasonGate(ctx: AppContext): Promise<SeasonGate | null> {
  if (!config.modes.survivalLive) return null;
  if (cachedSeasonGate && Date.now() - cachedSeasonGate.at < SEASON_GATE_TTL_MS) {
    return cachedSeasonGate.gate;
  }
  try {
    const gate = await ctx.relayer.seasonGate();
    cachedSeasonGate = { gate, at: Date.now() };
    warnOnSupplyCapDrift(gate.maxSupply);
    return gate;
  } catch {
    return cachedSeasonGate?.gate ?? null; // best effort: last good reading beats none
  }
}

// Short per-tokenId cache + in-flight coalescer for the petNeeds read (mirrors
// claim.ts cachedPetState): the five need stamps sit on the pass front, the
// state payload, and the reconcile copy, so a polling crowd on one pet must
// cost ONE vault read per TTL window. Errors are never cached.
type PetNeedsRead = Awaited<ReturnType<AppContext["relayer"]["petNeeds"]>>;
const PET_NEEDS_TTL_MS = 5_000;
const petNeedsCache = new Map<string, { needs: PetNeedsRead; at: number }>();
const petNeedsInFlight = new Map<string, Promise<PetNeedsRead>>();

export async function cachedPetNeeds(ctx: AppContext, tokenId: string): Promise<PetNeedsRead> {
  const hit = petNeedsCache.get(tokenId);
  if (hit && Date.now() - hit.at < PET_NEEDS_TTL_MS) return hit.needs;
  const inFlight = petNeedsInFlight.get(tokenId);
  if (inFlight) return inFlight;
  const read = ctx.relayer
    .petNeeds(tokenId)
    .then((needs) => {
      petNeedsCache.set(tokenId, { needs, at: Date.now() });
      if (petNeedsCache.size > 4000) petNeedsCache.clear(); // bounded (2k pets worst case)
      return needs;
    })
    .finally(() => {
      petNeedsInFlight.delete(tokenId);
    });
  petNeedsInFlight.set(tokenId, read);
  return read;
}

// Test hook: clear the needs cache between smoke scenarios (a 5s TTL would
// otherwise serve pre-mutation stamps across back-to-back mock fixtures).
export function _resetPetNeedsCache(): void {
  petNeedsCache.clear();
  petNeedsInFlight.clear();
}

// Seconds until the vault will accept a care of `action` again. Cooldown is
// PER NEED since the redesign: readyAt = needAt[action] + careCooldown, so a
// different need is never blocked by this one's cooldown. Falls back to the
// pet-level min stamp when the per-need read fails (conservative: the min is
// the OLDEST stamp, so the fallback can only under-state the wait, never park
// the keeper on a countdown longer than the truth). Dead code at the shipped
// careCooldown = 0, but the page that renders it must stay correct.
export async function careCooldownSecondsLeft(
  ctx: AppContext,
  tokenId: string,
  action: string,
): Promise<number> {
  const nowSec = Math.floor(Date.now() / 1000);
  const cfg = await getVaultConfig(ctx);
  const idx = CARE_ACTION_TYPE[action];
  if (idx !== undefined) {
    try {
      const { needAt } = await cachedPetNeeds(ctx, tokenId);
      const stamp = needAt[idx] ?? 0;
      if (stamp > 0) return Math.max(0, stamp + cfg.careCooldownSeconds - nowSec);
      return 0; // dormant egg: no stamps, no cooldown
    } catch {
      // fall through to the pet-level stamp
    }
  }
  const state = await ctx.relayer.petState(tokenId);
  if (state.lastCareAt <= 0) return 0;
  return Math.max(0, state.lastCareAt + cfg.careCooldownSeconds - nowSec);
}

// The five per-need meter percents for a pet's wallet-card render, CHAIN
// AUTHORITATIVE when the season is live and the pet is a hatched, living
// on-chain pet (survivalLive AND alive: dead stamps freeze and would show
// phantom time). Returns null when the chain is not authoritative (pre-season
// demo, dormant egg, memorial, read failure): callers fall back to the DB
// meters (needs.ts dbNeedPct). Index = canonical actionType.
export async function petNeedPctFor(ctx: AppContext, runner: Runner): Promise<number[] | null> {
  // NOT gated on the DB `hatched` flag. Under the sellout model a pet's five
  // clocks start at the SELLOUT whether or not anyone has fed it, so `hatched`
  // (which only flips on the first observed care) would hide the countdown from
  // exactly the keepers who most need it: the ones who have not fed yet and are
  // one life window from losing the pet. The on-chain stamps below are the
  // truth, and they already read 0 for a genuinely dormant pet, so the proxy
  // was redundant even before it became wrong.
  if (!config.modes.survivalLive || !runner.tokenId || runner.gone) return null;
  try {
    const [{ needAt }, cfg] = await Promise.all([
      cachedPetNeeds(ctx, runner.tokenId),
      getVaultConfig(ctx),
    ]);
    if (!needAt.some((t) => t > 0)) return null; // dormant on-chain: no timers yet
    const nowSec = Math.floor(Date.now() / 1000);
    return chainNeedsToMeters(needAt, cfg.lifeTtlSeconds, nowSec).perNeed;
  } catch {
    return null; // best effort: the DB meters stand in
  }
}

// Per-need SECONDS LEFT for the wallet-card countdowns (audit #3: the combined
// five-need field shows real time, not just dots). Same gates and null-fallback
// contract as petNeedPctFor; shares the cached petNeeds read, so calling both
// costs one vault read per TTL window. Index = canonical actionType.
export async function petNeedSecondsLeftFor(ctx: AppContext, runner: Runner): Promise<number[] | null> {
  // NOT gated on the DB `hatched` flag. Under the sellout model a pet's five
  // clocks start at the SELLOUT whether or not anyone has fed it, so `hatched`
  // (which only flips on the first observed care) would hide the countdown from
  // exactly the keepers who most need it: the ones who have not fed yet and are
  // one life window from losing the pet. The on-chain stamps below are the
  // truth, and they already read 0 for a genuinely dormant pet, so the proxy
  // was redundant even before it became wrong.
  if (!config.modes.survivalLive || !runner.tokenId || runner.gone) return null;
  try {
    const [{ needAt }, cfg] = await Promise.all([
      cachedPetNeeds(ctx, runner.tokenId),
      getVaultConfig(ctx),
    ]);
    if (!needAt.some((t) => t > 0)) return null; // dormant on-chain: no timers yet
    return needsSecondsLeft(needAt, cfg.lifeTtlSeconds, Math.floor(Date.now() / 1000));
  } catch {
    return null; // best effort: the percent fallback stands in
  }
}

// The pet's LIVE bank balance for the wallet-card front: the CARE tokens held
// by its own ERC-6551 account, formatted number-first ("98 CARE", whole
// tokens). Same posture as petNeedPctFor: read fresh at pass-build/push time,
// null when the balance cannot be shown truthfully (memorial, champion, no TBA
// yet, read failure): callers OMIT the field, never render a wrong "0 CARE".
// Short TTL + in-flight coalescing bounds RPC cost when a device fleet
// re-fetches after a broadcast push; a failed read serves the last known value
// inside the map (stale beats absent) and null when there is none.
const CARE_BALANCE_TTL_MS = 30_000;
const careBalanceCache = new Map<string, { value: string; at: number }>();
const careBalanceInFlight = new Map<string, Promise<string | null>>();

export async function petCareBalanceFor(ctx: AppContext, runner: Runner): Promise<string | null> {
  if (runner.gone || runner.won || !runner.tbaAddress) return null;
  const key = runner.tbaAddress.toLowerCase();
  const hit = careBalanceCache.get(key);
  if (hit && Date.now() - hit.at < CARE_BALANCE_TTL_MS) return hit.value;
  const inFlight = careBalanceInFlight.get(key);
  if (inFlight) return inFlight;
  const read = ctx.relayer
    .careBalanceOf(runner.tbaAddress)
    .then((raw) => {
      const value = `${formatCareToken(raw, undefined, 0)} CARE`; // no "$": a ticker reads as a tradable token
      careBalanceCache.set(key, { value, at: Date.now() });
      if (careBalanceCache.size > 4000) careBalanceCache.clear(); // bounded (2k pets worst case)
      return value;
    })
    .catch(() => (hit ? hit.value : null))
    .finally(() => {
      careBalanceInFlight.delete(key);
    });
  careBalanceInFlight.set(key, read);
  return read;
}

// The OFF-CHAIN alive tally (last pet standing: the contract keeps no headcount,
// so "N alive" is computed server-side and is DISPLAY-ONLY, never settlement).
// Cheap store-based estimate for the request path: a known pet is alive when it
// is not memorialized and its last known care (registration at worst) is within
// lifeTtl. The drama poller's chain-read timer sweep refreshes the snapshot
// with the authoritative on-chain clock on every poll.
async function offchainAliveTally(ctx: AppContext, lifeTtlSeconds: number): Promise<number> {
  const minted = await ctx.store.allMintedRunners();
  const now = Date.now();
  // THE START LINE, off-chain. This tally used to fall back to bornAt, i.e. it
  // assumed a pet's clock starts when it is MINTED. Under the sellout model that
  // is simply false: nothing can be fed until the collection mints out, so a
  // collection that takes longer than one life window to sell would have had
  // every waiting pet counted as dead. That is not a cosmetic miscount, it is
  // what the heartbeat reads: it would have reported ZERO PETS ALIVE and paged
  // Hunt about a season that had not even begun.
  const gate = await getSeasonGate(ctx);
  const selloutPending = gate?.selloutStartsSeason && gate.startedAt === 0;
  if (selloutPending) return minted.filter((r) => !r.gone).length; // no clock has started: all alive
  const startedMs = gate?.selloutStartsSeason ? gate.startedAt * 1000 : 0;
  let alive = 0;
  for (const r of minted) {
    if (r.gone) continue;
    // An unfed pet's deadline is measured from the start line, exactly as the
    // contract floors its need stamps there.
    const lastCareMs = Math.max((r.lastCareAt ?? r.bornAt ?? r.createdAt).getTime(), startedMs);
    if (lastCareMs + lifeTtlSeconds * 1000 > now) alive += 1;
  }
  return alive;
}

// Refresh the cached snapshot from the vault (only when the season is live). TTL
// throttled so reads that trigger it (e.g. the stats endpoint) do not hammer RPC.
export async function refreshSeasonSnapshot(
  ctx: AppContext,
  force = false,
): Promise<SeasonSnapshot> {
  if (!config.modes.survivalLive) {
    snapshot = {
      aliveCount: config.RUNNER_SUPPLY_CAP,
      registered: 0,
      hatched: 0,
      total: config.RUNNER_SUPPLY_CAP,
      potRaw: 0n,
      burnedRaw: 0n,
      careTokenDecimals: config.CARE_TOKEN_DECIMALS,
      seasonActive: false,
      fetchedAt: Date.now(),
    };
    return snapshot;
  }
  // The TTL only honors a snapshot taken while the season was LIVE: a cached
  // pre-season stub must never mask the first live read after the flag flips.
  if (!force && snapshot.seasonActive && Date.now() - snapshot.fetchedAt < SNAPSHOT_TTL_MS) {
    return snapshot;
  }
  try {
    // Read the care-token decimals on the first LIVE refresh (they do not change),
    // so we never format the pot against a hardcoded 18.
    const needDecimals = !snapshot.seasonActive;
    const [s, decimals, burnedRaw] = await Promise.all([
      ctx.relayer.petVaultStats(),
      needDecimals ? ctx.relayer.careTokenDecimals() : Promise.resolve(snapshot.careTokenDecimals),
      // Best effort: a burn-ledger read failure must not block the snapshot.
      ctx.relayer.burnedCareTotal().catch(() => snapshot.burnedRaw),
    ]);
    // aliveCount is OFF-CHAIN now (the vault keeps no headcount): derive it from
    // the timers over the pets the server knows about.
    const aliveCount = await offchainAliveTally(ctx, s.lifeTtlSeconds);
    snapshot = {
      aliveCount,
      registered: s.registeredCount,
      hatched: s.hatchedCount,
      total: config.RUNNER_SUPPLY_CAP,
      potRaw: s.potRaw,
      burnedRaw,
      careTokenDecimals: decimals,
      seasonActive: true,
      fetchedAt: Date.now(),
    };
  } catch (err) {
    logger.error({ err: String(err) }, "refreshSeasonSnapshot failed");
  }
  return snapshot;
}

// Pets actually IN THE RACE, the only honest denominator for "N alive". The
// supply cap is a ceiling on how many could ever exist, not a headcount: using
// it made a two-pet season read "1 / 2,000". Prefers hatched (fed at least
// once), then registered (minted), and never goes below the alive count.
// Pre-season the snapshot is the full-supply stub, so this returns the cap
// exactly as before.
export function petsInRace(s: SeasonSnapshot = snapshot): number {
  return Math.max(s.hatched, s.registered, s.aliveCount);
}

// Survivor-count line for the pass front, e.g. "1,847 / 1,981".
export function survivorLine(): string {
  return `${snapshot.aliveCount.toLocaleString("en-US")} / ${petsInRace().toLocaleString("en-US")}`;
}

// Compact token amount for the stats band: "978", "12.4K", "3.5M", "1.2B".
// Quantized on purpose: these strings feed the Google art cache-buster, so
// they must be stable between meaningful changes.
export function compactCare(raw: bigint, decimals: number): string {
  const units = Number(raw / 10n ** BigInt(Math.max(0, decimals))) + Number(raw % 10n ** BigInt(Math.max(0, decimals))) / 10 ** decimals;
  const fmt = (v: number, suffix: string) => `${v >= 100 ? Math.round(v) : v.toFixed(1).replace(/\.0$/, "")}${suffix}`;
  if (units >= 1e9) return fmt(units / 1e9, "B");
  if (units >= 1e6) return fmt(units / 1e6, "M");
  if (units >= 1e3) return fmt(units / 1e3, "K");
  return `${Math.round(units).toLocaleString("en-US")}`;
}

// The pass-art stats band payload (see pet.ts PassStats). fdv joins once a CARE
// pool exists to read a price from; POT holds the middle seat until then.
export function passStatsFrom(s: SeasonSnapshot): import("./pet.js").PassStats {
  return {
    alive: s.aliveCount,
    // Pets in the race, not the mint cap (see petsInRace).
    total: petsInRace(s),
    pot: compactCare(s.potRaw, s.careTokenDecimals),
    burned: compactCare(s.burnedRaw, s.careTokenDecimals),
  };
}

// Update the cached alive count from the drama poller's timer sweep (the
// authoritative on-chain-clock tally) so passes reflect the survivor count
// without extra vault reads. Marks the season active.
export function setSnapshotAlive(aliveCount: number): void {
  snapshot = { ...snapshot, aliveCount, seasonActive: true, fetchedAt: Date.now() };
}

// The pot, formatted for a drama/victory line.
export function potDisplay(): string {
  return formatCareToken(snapshot.potRaw);
}

// Format a raw care-token amount for display (thousands-separated, trimmed). The
// decimals come from the token at runtime (via the snapshot), never hardcoded.
export function formatCareToken(raw: bigint, decimals = snapshot.careTokenDecimals, maxFrac = 2): string {
  const base = 10n ** BigInt(decimals);
  const whole = (raw / base).toLocaleString("en-US");
  if (maxFrac <= 0) return whole;
  const frac = (raw % base).toString().padStart(decimals, "0").slice(0, maxFrac).replace(/0+$/, "");
  return frac ? `${whole}.${frac}` : whole;
}

// Rank is DEATH ORDER, derived OFF-CHAIN in the last-pet-standing model (1 =
// first to die = worst; 0 = survivor / unknown). Present owner-friendly:
// "Outlasted N" pets = rank - 1 while the season runs.
export function outlastedFromRank(rank: number): number {
  return Math.max(0, rank - 1);
}

// Days a pet lived: the vault's bornAt..diedAt once persisted (on the death
// flip), else the pet's own timestamps as a pre-persistence fallback.
export function memorialLivedDays(runner: Runner): number {
  const start = runner.bornAt ?? runner.createdAt;
  const end = runner.diedAt ?? runner.updatedAt;
  return Math.max(1, Math.round((end.getTime() - start.getTime()) / 86_400_000));
}
