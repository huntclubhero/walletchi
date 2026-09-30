// Robinhood Chain viem definitions. Used by the account-abstraction care flow (Alchemy Smart Wallets
// via EIP-7702 on the Privy embedded wallet) and any direct on-chain read. Robinhood Chain is an
// OP-stack L2 with native ERC-4337 + EIP-7702 support (EntryPoint v0.6/0.7/0.8 deployed; AA powered by
// Alchemy). No em dashes anywhere in this repo.
import { defineChain } from "viem";

export const robinhoodTestnet = defineChain({
  id: 46630,
  name: "Robinhood Chain Testnet",
  nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
  rpcUrls: { default: { http: ["https://rpc.testnet.chain.robinhood.com"] } },
  blockExplorers: {
    default: { name: "Blockscout", url: "https://explorer.testnet.chain.robinhood.com" },
  },
  testnet: true,
});

export const robinhoodMainnet = defineChain({
  id: 4663,
  name: "Robinhood Chain",
  nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
  rpcUrls: { default: { http: ["https://rpc.mainnet.chain.robinhood.com"] } },
  blockExplorers: {
    default: { name: "Blockscout", url: "https://robinhoodchain.blockscout.com" },
  },
});

// The active chain is picked from NEXT_PUBLIC_ROBINHOOD_NETWORK ("mainnet" | "testnet"); defaults to
// testnet, matching the server's ROBINHOOD_NETWORK gate. Keep this the single source of truth so the
// AA client, the explorer links, and any read all agree.
export const ACTIVE_NETWORK =
  (process.env.NEXT_PUBLIC_ROBINHOOD_NETWORK?.trim() || "testnet") === "mainnet"
    ? "mainnet"
    : "testnet";

export const robinhoodChain = ACTIVE_NETWORK === "mainnet" ? robinhoodMainnet : robinhoodTestnet;

export function explorerTxUrl(txHash: string): string {
  return `${robinhoodChain.blockExplorers.default.url}/tx/${txHash}`;
}
