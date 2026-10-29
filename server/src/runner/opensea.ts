import { config } from "../config.js";
import { logger } from "../logger.js";
import type { AppContext } from "../context.js";

// OpenSea metadata-refresh pings (WS2). When a pet's public status flips (alive
// -> critical -> dead) we ask OpenSea to re-pull /metadata/runner/:tokenId so
// listings show the truth sooner. HONEST LIMITS: OpenSea caches on its own
// schedule and refresh is best-effort; the /pet page is the always-live source
// of truth and the on-chain soulbound gate is what actually protects buyers.
// Guarded behind OPENSEA_API_KEY: absent key == no-op with a log line.

const REFRESH_API = "https://api.opensea.io/api/v2/chain";

export function openseaEnabled(): boolean {
  return Boolean(config.OPENSEA_API_KEY && config.pet721Address);
}

// Fire one refresh ping. Never throws; failures are logged and dropped (the
// periodic sweep retries naturally on the next status comparison).
export async function refreshOpenSeaMetadata(tokenId: string): Promise<void> {
  if (!openseaEnabled()) {
    logger.debug({ tokenId }, "opensea refresh skipped (OPENSEA_API_KEY not set)");
    return;
  }
  const url = `${REFRESH_API}/${config.OPENSEA_CHAIN}/contract/${config.pet721Address}/nfts/${tokenId}/refresh`;
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: { "x-api-key": config.OPENSEA_API_KEY!, accept: "application/json" },
    });
    if (!res.ok) {
      logger.warn({ tokenId, status: res.status }, "opensea refresh rejected");
      return;
    }
    logger.info({ tokenId }, "opensea metadata refresh requested");
  } catch (err) {
    logger.warn({ err: String(err), tokenId }, "opensea refresh failed");
  }
}

// Last status we told OpenSea about, per tokenId. In-process (a restart just
// causes one redundant refresh per pet on the first sweep after a change).
const lastPushedStatus = new Map<string, string>();

// Transition hook: call whenever a pet's public status flips (death, critical
// fade, revival). Debounced by the last-pushed record so repeated reconciles do
// not spam the refresh API.
export function noteStatusForOpenSea(tokenId: string | null, status: "alive" | "critical" | "dead"): void {
  if (!tokenId) return;
  if (lastPushedStatus.get(tokenId) === status) return;
  lastPushedStatus.set(tokenId, status);
  void refreshOpenSeaMetadata(tokenId);
}

// Periodic sweep: catch transitions that happened outside our hooks (a rival
// reaping on-chain, a revive we did not observe). DB flags are the cheap truth
// here; the hooks cover the immediate on-transition ping.
export async function runOpenSeaSweep(ctx: AppContext): Promise<void> {
  if (!openseaEnabled()) return;
  const minted = await ctx.store.allMintedRunners();
  for (const r of minted) {
    if (!r.tokenId) continue;
    const status = r.gone ? "dead" : r.critical ? "critical" : "alive";
    noteStatusForOpenSea(r.tokenId, status);
  }
}

export function startOpenSeaSweep(ctx: AppContext): { stop: () => void } {
  if (!openseaEnabled()) {
    logger.info("opensea refresh OFF (set OPENSEA_API_KEY + PET721_ADDRESS to enable)");
    return { stop: () => {} };
  }
  const t = setInterval(
    () => void runOpenSeaSweep(ctx).catch((e) => logger.error({ err: String(e) }, "opensea sweep failed")),
    config.OPENSEA_SWEEP_MINUTES * 60_000,
  );
  t.unref?.();
  logger.info({ sweepMinutes: config.OPENSEA_SWEEP_MINUTES }, "opensea refresh sweep started");
  return { stop: () => clearInterval(t) };
}

// Test hook.
export function _resetOpenSeaState(): void {
  lastPushedStatus.clear();
}
