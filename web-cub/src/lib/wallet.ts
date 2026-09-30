// Minimal, self-contained injected-wallet helper (EIP-1193 window.ethereum).
// No external SDK, no network at build: a buyer who bought a WALLETCHI already has a
// wallet, so an injected connect + personal_sign is enough to prove ownership. If no
// wallet is present, the /claim page steers the user to the email fallback instead.

export interface InjectedProvider {
  request(args: { method: string; params?: unknown[] }): Promise<unknown>;
  isMetaMask?: boolean;
}

interface ProviderError {
  code?: number;
  message?: string;
}

/** The injected provider, or null when there is no wallet (server render or no extension). */
export function getInjectedProvider(): InjectedProvider | null {
  if (typeof window === "undefined") return null;
  const eth = (window as unknown as { ethereum?: InjectedProvider }).ethereum;
  return eth ?? null;
}

export function hasWallet(): boolean {
  return getInjectedProvider() !== null;
}

/** Ask the wallet to connect and return the primary address. Throws "no-wallet" / "no-account". */
export async function connectWallet(): Promise<string> {
  const provider = getInjectedProvider();
  if (!provider) throw new Error("no-wallet");
  const accounts = (await provider.request({ method: "eth_requestAccounts" })) as string[];
  const address = accounts?.[0];
  if (!address) throw new Error("no-account");
  return address;
}

/**
 * A readable SIWE-style claim message. The `nonce` MUST be a fresh server-issued
 * value from GET /api/claim/nonce: POST /api/claim only accepts a live, single-use
 * server nonce (a client-generated one would be rejected). The "Address:" and
 * "Nonce:" lines are parsed by the server, so keep their exact shape.
 */
export function buildClaimMessage(address: string, nonce: string): string {
  const domain = typeof window !== "undefined" ? window.location.host : "www.playwalletchi.com";
  return [
    `${domain} wants you to prove you own this pet.`,
    "",
    "I own WALLETCHI and I am claiming its wallet pass.",
    "",
    `Address: ${address}`,
    `Nonce: ${nonce}`,
    `Issued At: ${new Date().toISOString()}`,
  ].join("\n");
}

/** Sign the claim message with personal_sign. Throws on rejection / no wallet. */
export async function signMessage(address: string, message: string): Promise<string> {
  const provider = getInjectedProvider();
  if (!provider) throw new Error("no-wallet");
  return (await provider.request({ method: "personal_sign", params: [message, address] })) as string;
}

/** True when the wallet error means the user dismissed the prompt (EIP-1193 code 4001). */
export function isUserRejection(err: unknown): boolean {
  const e = err as ProviderError;
  if (e && e.code === 4001) return true;
  const msg = (e && e.message ? e.message : String(err)).toLowerCase();
  return msg.includes("reject") || msg.includes("denied") || msg.includes("cancel");
}
