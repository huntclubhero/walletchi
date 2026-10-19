// Trustless gasless care: turn a care() call into a gas-sponsored, owner-signed UserOp.
//
// PROVEN on Robinhood testnet 46630 (2026-08-11): a fresh, zero-balance owner cared for its pet through
// this exact path (sponsoredCare) and it landed via EntryPoint v0.7, gas paid by the Gas Manager policy,
// CARE pulled from the pet TBA (90/10 split to the wei), owner-only gate satisfied. The account is
// EIP-7702 on the SIGNER'S OWN address (no requestAccount, no new address, no migration), so pet.ownerOf
// stays the user's known Privy wallet.
//
// Signer: follows the official Alchemy x Privy 7702 example. The Privy embedded wallet becomes a viem
// WalletClient over its EIP-1193 provider (personal_sign / eth_signTypedData_v4 for the UserOp), with
// signAuthorization OVERRIDDEN to delegate to Privy's dedicated 7702 hook (a generic provider does not
// expose 7702 authorization signing). The SDK's getAction picks up the override.
import { createSmartWalletClient, alchemyWalletTransport } from "@alchemy/wallet-apis";
import {
  createWalletClient,
  createPublicClient,
  custom,
  encodeFunctionData,
  http,
  type Account,
  type Address,
  type Chain,
  type Hex,
  type LocalAccount,
  type Transport,
  type WalletClient,
} from "viem";
import { ALCHEMY_API_KEY, GAS_POLICY_ID } from "./aa-config";
import { robinhoodChain, explorerTxUrl } from "./chain";
import { careCall, type CareAction } from "./care";
import { liveVaultAddress } from "./chain-config";

// The two signer shapes the Alchemy SDK accepts (SmartWalletSigner = LocalAccount | SignerClient). The
// on-chain proof used a LocalAccount; the Privy path builds the WalletClient variant.
export type AaSigner = LocalAccount | WalletClient<Transport, Chain | undefined, Account>;

// The minimal EIP-1193 surface we use off the Privy embedded wallet (wallet.getEthereumProvider()).
export type Eip1193Provider = { request: (args: { method: string; params?: unknown[] }) => Promise<unknown> };

// Privy's useSign7702Authorization().signAuthorization: signs a 7702 delegation and returns the ECDSA
// components. The SDK derives yParity from v when yParity is absent.
export type Sign7702Authorization = (input: {
  contractAddress: Address;
  chainId: number;
  nonce: number;
}) => Promise<{ r: Hex; s: Hex; v?: bigint; yParity?: number }>;

// Alchemy's released SemiModularAccount7702 delegates, copied from Alchemy's own registry
// (@alchemy/wallet-api-types sma7702.js SMA_7702_DELEGATION_ADDRESSES). The 7702 override refuses to
// sign a delegation to anything else, so a compromised transport cannot redirect the delegation to an
// attacker contract. Alchemy's backend moved new wallets from v1.0.0 to v1.1.0 in September 2026, and
// allowing only v1.0.0 made every fresh wallet fail arming while wallets delegated earlier kept working.
// When Alchemy ships a new version, add it here from that registry, never from a transport response.
const ALLOWED_7702_DELEGATES = new Set([
  "0x69007702764179f14f51cdce752f4f775d74e139", // SemiModularAccount7702 v1.0.0
  "0x77021100bd87b7008e5e1989d0eb38555d0d0000", // SemiModularAccount7702 v1.1.0
]);

// Build an Alchemy-compatible signer from a Privy embedded wallet, per the official example.
export function privyWalletToSigner(opts: {
  provider: Eip1193Provider;
  address: Address;
  sign7702Authorization: Sign7702Authorization;
}): AaSigner {
  const walletClient = createWalletClient({
    account: opts.address,
    chain: robinhoodChain,
    transport: custom(opts.provider),
  });
  // Override signAuthorization: a WalletClient's built-in action would ask the provider to sign a 7702
  // authorization, which Privy's embedded provider does not expose; its dedicated hook does. getAction
  // prefers this own-property override over viem's imported action.
  return Object.assign(walletClient, {
    async signAuthorization(unsigned: {
      address?: Address;
      contractAddress?: Address;
      chainId: number;
      nonce: number;
    }) {
      // Defense in depth: a 7702 authorization is the single most dangerous signature in the product (a
      // malicious delegate = full EOA takeover). Only ever sign a delegation for THIS chain AND to the
      // expected Alchemy delegate. Reject the all-chains sentinel (chainId 0), any other chain, and any
      // delegate the transport hands back that is not the known impl (a compromised/MITM transport
      // otherwise gets the wallet to delegate to an attacker contract).
      if (unsigned.chainId !== robinhoodChain.id) {
        throw new Error(`refusing to sign a 7702 authorization for chain ${unsigned.chainId}`);
      }
      const delegate = (unsigned.address ?? unsigned.contractAddress)?.toLowerCase();
      if (!delegate || !ALLOWED_7702_DELEGATES.has(delegate)) {
        throw new Error(`refusing to sign a 7702 authorization to an unexpected delegate ${delegate}`);
      }
      const sig = await opts.sign7702Authorization({
        contractAddress: (unsigned.address ?? unsigned.contractAddress) as Address,
        chainId: unsigned.chainId,
        nonce: unsigned.nonce,
      });
      return { ...unsigned, ...sig };
    },
  }) as unknown as AaSigner;
}

export type CareResult = { status: "success" | "failure"; txHash: Hex; explorerUrl: string };

/**
 * Is this wallet already EIP-7702 delegated? A delegated account can be granted a
 * one-tap session straight away, with no bootstrapping op at all: `eth_getCode`
 * returns the 0xef0100-prefixed designator once the delegation is installed.
 *
 * Worth asking BEFORE spending anything, because a keeper who has played a
 * previous season is already delegated, and making them pay for a bootstrap they
 * do not need is both wasteful and (before the sellout, where the only other
 * bootstrap is refused) the difference between arming and not arming at all.
 *
 * TRI-STATE, and the null matters (season-1 post-mortem). This used to return
 * false on a failed read, calling that "the safe direction". Under a per-spender
 * sponsorship cap it was the EXPENSIVE direction: every indeterminate read
 * triggered another sponsored bootstrap op, and one wallet burned seven ops on
 * arming retries before its first real care, which exhausted its sponsorship
 * budget and bricked every later feed. Unknown now means unknown; callers only
 * bootstrap on a CONFIRMED false, and otherwise try the free grant first (a
 * genuinely undelegated wallet just gets Alchemy's refusal back, costing nothing).
 */
export async function isDelegated(address: Address): Promise<boolean | null> {
  try {
    const client = createPublicClient({ chain: robinhoodChain, transport: http() });
    const code = await client.getCode({ address });
    return Boolean(code && code !== "0x");
  } catch {
    return null; // unknown: never worth a sponsored op
  }
}

// ONE BOOTSTRAP ATTEMPT PER WALLET PER BROWSER CONTEXT (season-1 post-mortem).
// Each bootstrap is a sponsored op charged against the wallet's per-spender
// sponsorship budget, so an arming flow that can re-enter (re-renders, retries,
// impatient taps) must never be able to burn more than one. sessionStorage
// survives reloads within the tab; the in-memory set covers contexts where
// storage is blocked. The latch marks ATTEMPTS, not successes: a wallet whose
// one attempt failed arms later via the grant path once the delegation (which
// usually landed even when the flow around it broke) is visible on-chain.
const bootstrapAttempted = new Set<string>();
function bootstrapLatched(address: Address): boolean {
  const key = `walletchi:bootstrap:${address.toLowerCase()}`;
  if (bootstrapAttempted.has(key)) return true;
  try {
    if (sessionStorage.getItem(key)) return true;
  } catch {
    /* storage blocked: the in-memory set still holds for this context */
  }
  bootstrapAttempted.add(key);
  try {
    sessionStorage.setItem(key, String(Date.now()));
  } catch {
    /* ditto */
  }
  return false;
}

/**
 * THE ARMING BOOTSTRAP for a season that has not started.
 *
 * One-tap care needs the wallet delegated, and the delegation only lands on the
 * account's first sponsored op. Before the sellout there is no care() to spend,
 * so this sends the one harmless call the paymaster funds instead:
 * setCarer(tokenId, address(0), 0), a revoke of a carer a fresh pet never had.
 * Its only real effect is the delegation.
 */
export async function bootstrapDelegation(signer: AaSigner, tokenId: bigint, vault: Address): Promise<boolean> {
  if (!ALCHEMY_API_KEY || !GAS_POLICY_ID) return false;
  // The wallet address the op will be charged against (per-spender sponsorship).
  const spender = ((signer as { account?: { address?: Address } }).account?.address ??
    (signer as { address?: Address }).address) as Address | undefined;
  if (!spender) return false;
  if (bootstrapLatched(spender)) {
    console.warn("[walletchi] bootstrap already attempted this session; refusing a second sponsored op");
    return false;
  }
  try {
    const client = createSmartWalletClient({
      signer,
      transport: alchemyWalletTransport({ apiKey: ALCHEMY_API_KEY }),
      chain: robinhoodChain,
      paymaster: { policyId: GAS_POLICY_ID },
    });
    const data = encodeFunctionData({
      abi: SET_CARER_ABI,
      functionName: "setCarer",
      args: [tokenId, "0x0000000000000000000000000000000000000000", 0n],
    });
    const sent = await client.sendCalls({ calls: [{ to: vault, data }] });
    const id = (sent.id ?? sent.preparedCallIds?.[0]) as Hex;
    const final = await client.waitForCallsStatus({ id });
    return final.status === "success";
  } catch (err) {
    console.error("[walletchi] arming bootstrap failed:", err);
    return false;
  }
}

const SET_CARER_ABI = [
  {
    type: "function",
    name: "setCarer",
    stateMutability: "nonpayable",
    outputs: [],
    inputs: [
      { name: "tokenId", type: "uint256" },
      { name: "carer", type: "address" },
      { name: "expiresAt", type: "uint64" },
    ],
  },
] as const;

// Send a gas-sponsored care(tokenId, action) as the pet owner. `signer` is a LocalAccount or the Privy
// signer from privyWalletToSigner(). Resolves once the op is mined; throws on send/validation error
// (e.g. a non-owner is rejected at prepareCalls before any op or sponsorship is spent).
export async function sponsoredCare(signer: AaSigner, tokenId: bigint, action: CareAction): Promise<CareResult> {
  if (!ALCHEMY_API_KEY || !GAS_POLICY_ID) throw new Error("account abstraction is not configured");
  const client = createSmartWalletClient({
    signer,
    transport: alchemyWalletTransport({ apiKey: ALCHEMY_API_KEY }),
    chain: robinhoodChain,
    paymaster: { policyId: GAS_POLICY_ID },
  });
  // No requestAccount: defaults to EIP-7702 on the signer's own address (proof: eth_getCode shows 0xef0100).
  // The LIVE season's vault, not the baked one: a stale bundle after a season
  // redeploy signed care into the dead vault (2026-08-26).
  const vault = await liveVaultAddress();
  const sent = await client.sendCalls({ calls: [careCall(tokenId, action, vault)] });
  const id = (sent.id ?? sent.preparedCallIds?.[0]) as Hex;
  const final = await client.waitForCallsStatus({ id });
  // The mined on-chain tx that included the bundle is what the explorer resolves; fall back to the bundle id.
  const txHash = (final.receipts?.[0]?.transactionHash ?? id) as Hex;
  return { status: final.status === "success" ? "success" : "failure", txHash, explorerUrl: explorerTxUrl(txHash) };
}

/**
 * "GIFT THIS PET": send the prepared Pet721.transferFrom(owner, recipient, tokenId) as a gas-sponsored,
 * OWNER-signed user operation. `call` is exactly what POST /api/pet/:id/gift/prepare returned; the gas
 * webhook funds it only because the server recorded that intent, and only from the pet's owner.
 *
 * WHY THIS IS A SEPARATE OWNER SIGNATURE AND NEVER THE CARE SESSION KEY. The one-tap session key the
 * server holds is scoped on-chain to care() on the vault and nothing else (lib/session.ts, proven with
 * a rejected transferFrom on 46630). A transfer is the one action that must always cost the owner a
 * deliberate signature, which is why this goes through the same owner signer the arming path uses and
 * never touches the session. Same shape and same wait as sponsoredCare; a refused sponsorship or a
 * revert surfaces as a thrown viem error (aaErrorDetail reads the real line).
 */
export async function sponsoredGift(signer: AaSigner, call: { to: Address; data: Hex }): Promise<CareResult> {
  if (!ALCHEMY_API_KEY || !GAS_POLICY_ID) throw new Error("account abstraction is not configured");
  const client = createSmartWalletClient({
    signer,
    transport: alchemyWalletTransport({ apiKey: ALCHEMY_API_KEY }),
    chain: robinhoodChain,
    paymaster: { policyId: GAS_POLICY_ID },
  });
  const sent = await client.sendCalls({ calls: [{ to: call.to, data: call.data }] });
  const id = (sent.id ?? sent.preparedCallIds?.[0]) as Hex;
  const final = await client.waitForCallsStatus({ id });
  const txHash = (final.receipts?.[0]?.transactionHash ?? id) as Hex;
  return { status: final.status === "success" ? "success" : "failure", txHash, explorerUrl: explorerTxUrl(txHash) };
}
