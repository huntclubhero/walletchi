// The single on-chain call the account-abstraction care flow sends: PetVault.care(tokenId, actionType).
// care() is OWNER-ONLY on the vault (audit access-H-1), so the caller must be the pet's owner, which is
// exactly the user's embedded wallet when it signs the sponsored UserOp. This module owns the ABI
// fragment, the action mapping, and the encoded calldata so the AA client stays thin.
import { encodeFunctionData, type Address, type Hex } from "viem";

// PetVault.care(uint256 tokenId, uint8 actionType). Full ABI lives in contracts/abi/PetVault.json; only
// care() is needed client-side (all reads go through the server API).
export const CARE_ABI = [
  {
    type: "function",
    name: "care",
    stateMutability: "nonpayable",
    inputs: [
      { name: "tokenId", type: "uint256" },
      { name: "actionType", type: "uint8" },
    ],
    outputs: [],
  },
] as const;

// Opaque action ids the server reads for flavor (must match server/contract: FEED..EXPLORE = 0..4).
export const CARE_ACTIONS = ["feed", "water", "play", "toy", "explore"] as const;
export type CareAction = (typeof CARE_ACTIONS)[number];

export function actionType(action: CareAction): number {
  return CARE_ACTIONS.indexOf(action);
}

export function isCareAction(x: string): x is CareAction {
  return (CARE_ACTIONS as readonly string[]).includes(x);
}

// The PetVault address the care call targets. Set per deploy (NEXT_PUBLIC_PETVAULT_ADDRESS).
export const PETVAULT_ADDRESS = (process.env.NEXT_PUBLIC_PETVAULT_ADDRESS?.trim() || "") as Address | "";

/// Encode a care(tokenId, action) call. Returns the { to, data } the AA client passes to sendCalls.
/// `vault` lets action paths pass the LIVE season's address (lib/chain-config);
/// the baked env stays as the default so non-async callers keep working.
export function careCall(tokenId: bigint, action: CareAction, vault: Address | "" = PETVAULT_ADDRESS): { to: Address; data: Hex } {
  if (!vault) throw new Error("PetVault address unavailable (live config unreachable and no baked NEXT_PUBLIC_PETVAULT_ADDRESS)");
  return {
    to: vault,
    data: encodeFunctionData({ abi: CARE_ABI, functionName: "care", args: [tokenId, actionType(action)] }),
  };
}
