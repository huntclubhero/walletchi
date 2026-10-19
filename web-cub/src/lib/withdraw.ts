// Withdraw rewards from a pet's ERC-6551 account to its owner.
//
// WHY THIS EXISTS (econ audit): player rewards (CARE) and the trade-tax holder airdrop (USDG) can
// land in the pet's own token-bound account. CARE there funds the next feed, but USDG is otherwise
// unspendable by an embedded-wallet user, and any balance is stranded once a pet dies. This sweeps a
// token balance out of the pet's account to the owner, as an OWNER-SIGNED WalletchiAccount.execute():
// only ownerOf(tokenId) can move the account's funds, and it can only ever go to the owner here.
//
// Gaslessness note: like sponsoredCare, this is an owner-signed op sent via the Alchemy Smart Wallet.
// The Gas Manager policy must APPROVE the execute()-to-account shape for the gas to be sponsored (the
// same class of policy gate as the care webhook). Until it does, the op requires the owner to hold a
// little ETH. The button ships behind AA_CARE_ENABLED and is a no-op otherwise.
import { createSmartWalletClient, alchemyWalletTransport } from "@alchemy/wallet-apis";
import { createPublicClient, http, encodeFunctionData, getAddress, type Address, type Hex } from "viem";
import { ALCHEMY_API_KEY, GAS_POLICY_ID } from "./aa-config";
import { robinhoodChain, explorerTxUrl } from "./chain";
import { CARE_TOKEN_ADDRESS } from "./brand";
import type { AaSigner } from "./aa";

// USDG (the fee-stream / holder-airdrop currency). Env-driven; empty until the season is wired.
export const FEE_TOKEN_ADDRESS = process.env.NEXT_PUBLIC_FEE_TOKEN_ADDRESS?.trim() || "";
export const FEE_TOKEN_DECIMALS = Number(process.env.NEXT_PUBLIC_FEE_TOKEN_DECIMALS?.trim() || "6");
export const CARE_TOKEN_DECIMALS = Number(process.env.NEXT_PUBLIC_CARE_TOKEN_DECIMALS?.trim() || "18");

const ERC20_BALANCE_ABI = [
  {
    type: "function",
    name: "balanceOf",
    stateMutability: "view",
    inputs: [{ name: "a", type: "address" }],
    outputs: [{ type: "uint256" }],
  },
  {
    type: "function",
    name: "transfer",
    stateMutability: "nonpayable",
    inputs: [
      { name: "to", type: "address" },
      { name: "amount", type: "uint256" },
    ],
    outputs: [{ type: "bool" }],
  },
] as const;

// WalletchiAccount.execute(to, value, data, operation): the 6551 account's owner-gated call.
const ACCOUNT_EXECUTE_ABI = [
  {
    type: "function",
    name: "execute",
    stateMutability: "payable",
    inputs: [
      { name: "to", type: "address" },
      { name: "value", type: "uint256" },
      { name: "data", type: "bytes" },
      { name: "operation", type: "uint8" },
    ],
    outputs: [{ type: "bytes" }],
  },
] as const;

const publicClient = createPublicClient({ chain: robinhoodChain, transport: http() });

export interface TokenBalance {
  token: Address;
  symbol: "CARE" | "USDG";
  decimals: number;
  raw: bigint;
  display: string;
}

function fmt(raw: bigint, decimals: number): string {
  const base = 10n ** BigInt(decimals);
  const whole = raw / base;
  const frac = raw % base;
  if (frac === 0n) return whole.toString();
  const fracStr = frac.toString().padStart(decimals, "0").slice(0, 4).replace(/0+$/, "");
  return fracStr ? `${whole}.${fracStr}` : whole.toString();
}

// Read the pet account's withdrawable balances (CARE + USDG). Returns only positive ones.
export async function readWithdrawable(tba: string): Promise<TokenBalance[]> {
  const account = getAddress(tba);
  const out: TokenBalance[] = [];
  const tokens: Array<{ addr: string; symbol: "CARE" | "USDG"; decimals: number }> = [];
  if (CARE_TOKEN_ADDRESS) tokens.push({ addr: CARE_TOKEN_ADDRESS, symbol: "CARE", decimals: CARE_TOKEN_DECIMALS });
  if (FEE_TOKEN_ADDRESS) tokens.push({ addr: FEE_TOKEN_ADDRESS, symbol: "USDG", decimals: FEE_TOKEN_DECIMALS });
  for (const t of tokens) {
    try {
      const raw = (await publicClient.readContract({
        address: getAddress(t.addr),
        abi: ERC20_BALANCE_ABI,
        functionName: "balanceOf",
        args: [account],
      })) as bigint;
      if (raw > 0n) {
        out.push({ token: getAddress(t.addr), symbol: t.symbol, decimals: t.decimals, raw, display: fmt(raw, t.decimals) });
      }
    } catch {
      // a token read failing (unwired address) just omits it
    }
  }
  return out;
}

export type WithdrawResult = { status: "success" | "failure"; txHash: Hex; explorerUrl: string };

// Sweep the FULL balance of `token` from the pet's account `tba` to `owner`, as an owner-signed,
// gas-sponsored WalletchiAccount.execute(). The signer MUST be the pet's current owner (execute()
// reverts NotOwner otherwise, before any sponsorship is spent).
export async function sponsoredWithdraw(
  signer: AaSigner,
  tba: string,
  token: Address,
  owner: Address,
  amount: bigint,
): Promise<WithdrawResult> {
  if (!ALCHEMY_API_KEY || !GAS_POLICY_ID) throw new Error("account abstraction is not configured");
  const transferData = encodeFunctionData({
    abi: ERC20_BALANCE_ABI,
    functionName: "transfer",
    args: [owner, amount],
  });
  const executeData = encodeFunctionData({
    abi: ACCOUNT_EXECUTE_ABI,
    functionName: "execute",
    args: [token, 0n, transferData, 0],
  });
  const client = createSmartWalletClient({
    signer,
    transport: alchemyWalletTransport({ apiKey: ALCHEMY_API_KEY }),
    chain: robinhoodChain,
    paymaster: { policyId: GAS_POLICY_ID },
  });
  const sent = await client.sendCalls({ calls: [{ to: getAddress(tba), data: executeData }] });
  const id = (sent.id ?? sent.preparedCallIds?.[0]) as Hex;
  const final = await client.waitForCallsStatus({ id });
  const txHash = (final.receipts?.[0]?.transactionHash ?? id) as Hex;
  return {
    status: final.status === "success" ? "success" : "failure",
    txHash,
    explorerUrl: explorerTxUrl(txHash),
  };
}

// The reverse of a withdraw: the owner sends CARE from their own wallet INTO their pet's account,
// because every care is paid from there. A plain CARE.transfer(tba, amount) from the owner's smart
// wallet; the gas webhook sponsors it only when the recipient is a genuine pet account owned by the
// sender (gas-sponsor.ts ownerTopUpOk).
export async function sponsoredTopUp(
  signer: AaSigner,
  careToken: Address,
  tba: string,
  amount: bigint,
): Promise<WithdrawResult> {
  if (!ALCHEMY_API_KEY || !GAS_POLICY_ID) throw new Error("account abstraction is not configured");
  const data = encodeFunctionData({
    abi: ERC20_BALANCE_ABI,
    functionName: "transfer",
    args: [getAddress(tba), amount],
  });
  const client = createSmartWalletClient({
    signer,
    transport: alchemyWalletTransport({ apiKey: ALCHEMY_API_KEY }),
    chain: robinhoodChain,
    paymaster: { policyId: GAS_POLICY_ID },
  });
  const sent = await client.sendCalls({ calls: [{ to: getAddress(careToken), data }] });
  const id = (sent.id ?? sent.preparedCallIds?.[0]) as Hex;
  const final = await client.waitForCallsStatus({ id });
  const txHash = (final.receipts?.[0]?.transactionHash ?? id) as Hex;
  return {
    status: final.status === "success" ? "success" : "failure",
    txHash,
    explorerUrl: explorerTxUrl(txHash),
  };
}
