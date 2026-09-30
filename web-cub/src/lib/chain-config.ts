// LIVE chain config: the CURRENT season's contract addresses, fetched from the
// API at runtime. Runtime wins; the baked NEXT_PUBLIC env is only the fallback
// when the endpoint is unreachable.
//
// Why this exists: NEXT_PUBLIC values are frozen into the bundle at build time,
// so every season redeploy silently left the site signing care into the DEAD
// season's vault until someone remembered a dashboard edit plus a rebuild. On
// 2026-08-26 that cost a real tester their first feed. The API already knows
// the season it serves; the browser now asks it.

import type { Address } from "viem";
import { API_URL } from "./config";

/** The sellout start gate. Absent on a clock-model season or when the API could
 *  not read the vault; callers must treat "absent" as "do not assume started". */
export interface LiveSeasonGate {
  selloutStartsSeason: boolean;
  startedAt: number;
  started: boolean;
  entryOpen: boolean;
  minted: number;
  maxSupply: number;
  /** Clock model: unix seconds when minting closes for good ("mint open until <date>"). null under
   *  the sellout model or when unreadable; absent from an older API. */
  entryDeadline?: number | null;
  /** Unix seconds the season's vault was deployed. null when unreadable; absent from an older API. */
  seasonStart?: number | null;
}

export interface LiveChainConfig {
  season?: LiveSeasonGate | null;
  chainId: number;
  network: string;
  petVault: string | null;
  pet721: string | null;
  careToken: string | null;
  careTokenDecimals: number;
  feeToken: string | null;
  feeTokenDecimals: number;
}

const ADDR_RE = /^0x[0-9a-fA-F]{40}$/;

let inflight: Promise<LiveChainConfig | null> | null = null;

/** Memoized fetch of the live config. A failed fetch resolves null (callers
 *  fall back to the baked env) and clears the memo so a later action retries. */
export function fetchLiveChainConfig(): Promise<LiveChainConfig | null> {
  if (!inflight) {
    inflight = (async () => {
      // Manual abort rather than AbortSignal.timeout: older iOS Safari lacks
      // the static, and throwing here would kill the fallback path with it.
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 5000);
      try {
        const res = await fetch(`${API_URL}/api/chain-config`, { signal: controller.signal });
        if (!res.ok) throw new Error(`chain-config HTTP ${res.status}`);
        return (await res.json()) as LiveChainConfig;
      } catch {
        inflight = null;
        return null;
      } finally {
        clearTimeout(timer);
      }
    })();
  }
  return inflight;
}

/** The PetVault every care signature must target: live value first, baked env
 *  as the fallback. Empty string only when BOTH are missing. */
export async function liveVaultAddress(): Promise<Address | ""> {
  const cfg = await fetchLiveChainConfig();
  const runtime = cfg?.petVault;
  if (runtime && ADDR_RE.test(runtime)) return runtime as Address;
  return (process.env.NEXT_PUBLIC_PETVAULT_ADDRESS?.trim() || "") as Address | "";
}
