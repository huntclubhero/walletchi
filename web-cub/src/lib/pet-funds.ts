// How much CARE is inside a pet, and how much one care costs.
//
// WHY THIS EXISTS (2026-10-15, keeper of No. 0091): every care pays careCost out of the
// PET'S OWN account (its 6551 TBA), not the keeper's wallet. A keeper who withdrew all of
// it to their wallet then got "execution reverted" under "Your pet is fine, try again",
// tried again all night, and nearly lost the pet with 2,499 CARE sitting in their wallet.
// The care page asks this BEFORE spending a tap, and the withdraw card uses it to warn.
import { createPublicClient, http, getAddress, type Address } from "viem";
import { robinhoodChain } from "./chain";
import { liveCareTokenAddress, liveVaultAddress } from "./chain-config";

const publicClient = createPublicClient({ chain: robinhoodChain, transport: http() });

const BALANCE_OF_ABI = [
  {
    type: "function",
    name: "balanceOf",
    stateMutability: "view",
    inputs: [{ name: "a", type: "address" }],
    outputs: [{ type: "uint256" }],
  },
] as const;

const CARE_COST_ABI = [
  { type: "function", name: "careCost", stateMutability: "view", inputs: [], outputs: [{ type: "uint256" }] },
] as const;

export interface PetCareFunds {
  balance: bigint;
  cost: bigint;
}

/** The pet account's CARE balance and the vault's careCost. null when either read
 *  fails: callers must treat null as "unknown" and never block a care on it. */
export async function readPetCareFunds(tba: string): Promise<PetCareFunds | null> {
  try {
    const [token, vault] = await Promise.all([liveCareTokenAddress(), liveVaultAddress()]);
    if (!token || !vault) return null;
    const [balance, cost] = await Promise.all([
      publicClient.readContract({
        address: token as Address,
        abi: BALANCE_OF_ABI,
        functionName: "balanceOf",
        args: [getAddress(tba)],
      }),
      publicClient.readContract({ address: vault as Address, abi: CARE_COST_ABI, functionName: "careCost" }),
    ]);
    return { balance, cost };
  } catch {
    return null;
  }
}

/** Whole-CARE display of a raw 18-decimal amount ("1", "2.5"). */
export function careAmount(raw: bigint): string {
  const base = 10n ** 18n;
  const whole = raw / base;
  const frac = ((raw % base) * 100n) / base;
  return frac === 0n ? whole.toString() : `${whole}.${frac.toString().padStart(2, "0").replace(/0$/, "")}`;
}

/** The CARE in a WALLET (the keeper's own), for the "put CARE back" card. null when unreadable. */
export async function readWalletCare(wallet: string): Promise<{ token: Address; balance: bigint } | null> {
  try {
    const token = await liveCareTokenAddress();
    if (!token) return null;
    const balance = await publicClient.readContract({
      address: token as Address,
      abi: BALANCE_OF_ABI,
      functionName: "balanceOf",
      args: [getAddress(wallet)],
    });
    return { token: token as Address, balance };
  } catch {
    return null;
  }
}
