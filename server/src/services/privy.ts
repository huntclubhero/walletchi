import { config } from "../config.js";
import { logger } from "../logger.js";

// Verify a Privy access token from the buy flow. When Privy creds are absent (dev / stub)
// verification is IMPOSSIBLE, so verifyPrivyToken() reports ok:false with method:"bypass"
// rather than waving the caller through. A caller that deliberately supports an
// unauthenticated demo path checks config.modes.privyLive itself and takes its own branch;
// see the note on verifyPrivyToken below for why the old ok:true stub was a latent bypass.

export type PrivyUserRecord = {
  email?: { address?: string };
  linkedAccounts?: Array<{ type?: string; address?: string; walletClientType?: string; chainType?: string }>;
};

export type PrivyClient = {
  verifyAuthToken: (token: string) => Promise<{ userId: string }>;
  getUser: (userId: string) => Promise<PrivyUserRecord>;
  // The directory lookup behind "Gift this pet" (an email typed by the owner resolves to the
  // recipient's embedded wallet). Optional so the older test fakes keep type-checking; a client
  // without it answers "lookup unavailable", never "no such user".
  getUserByEmail?: (email: string) => Promise<PrivyUserRecord | null>;
};

// TEST SEAM (smoke only, same `_`-prefixed convention as _resetSybilState and the
// MockChain setters). The self-custody mint path only exists when Privy is live,
// so without an injectable client the entire branch that guards the supply wall
// was unreachable from the suite and could only be reasoned about. Set from inside
// the process by an import; nothing on the request path can reach it.
let clientOverride: PrivyClient | null = null;
export function _setPrivyClientForTests(client: PrivyClient | null): void {
  clientOverride = client;
}

let clientPromise: Promise<PrivyClient> | null = null;
async function getClient(): Promise<PrivyClient> {
  if (clientOverride) return clientOverride;
  if (!clientPromise) {
    clientPromise = import("@privy-io/server-auth").then(
      (m) =>
        new m.PrivyClient(
          config.PRIVY_APP_ID!,
          config.PRIVY_APP_SECRET!,
        ) as unknown as PrivyClient,
    );
  }
  return clientPromise;
}

export interface PrivyVerifyResult {
  ok: boolean;
  userId?: string;
  method: "privy" | "bypass";
  error?: string;
}

/** What Privy attests about a verified user's email, or why we do not know. */
export type PrivyEmailLookup =
  | { ok: true; email: string | null } // ok:true, email:null = Privy attests NO email
  | { ok: false; error: string }; // we could not ask; we know nothing

/**
 * The email Privy attests for a verified user.
 *
 * WHY THIS RETURNS A RESULT AND NOT `string | null`. It used to collapse three very
 * different answers into one null: "this user has no email", "Privy is stubbed",
 * and "the lookup threw". The mint route then treated null as "fall back to
 * something else", which is how a caller-chosen string ended up keying the
 * one-inbox-one-pet wall. A transient Privy outage and a wallet-only account are
 * not the same fact and must not produce the same mint decision: one is a retry,
 * the other is a refusal. Callers must handle both explicitly.
 */
export async function lookupPrivyUserEmail(
  userId: string | undefined,
): Promise<PrivyEmailLookup> {
  if (!config.modes.privyLive) {
    return { ok: false, error: "Privy is not configured; no email can be attested" };
  }
  if (!userId) return { ok: false, error: "no verified Privy user id" };
  try {
    const client = await getClient();
    const user = await client.getUser(userId);
    if (user.email?.address) return { ok: true, email: user.email.address };
    const linkedEmail = user.linkedAccounts?.find(
      (a) => a.type === "email" && a.address,
    )?.address;
    return { ok: true, email: linkedEmail ?? null };
  } catch (err) {
    logger.warn({ err: String(err) }, "privy getUser email lookup failed");
    return { ok: false, error: String(err) };
  }
}

/** Where an email typed by a gifting owner leads, or why we cannot say. */
export type PrivyWalletLookup =
  | { ok: true; address: string | null } // ok:true, address:null = Privy has no user, or one with no wallet
  | { ok: false; error: string }; // we could not ask; we know nothing

/**
 * The EMBEDDED EVM wallet Privy holds for the user who signs in with `email`, lowercased.
 *
 * For "Gift this pet": the recipient is named by the email they sign in with, and the pet must
 * land in the wallet that email controls, which is the Privy embedded wallet (walletClientType
 * "privy") created at their first sign-in. A linked EXTERNAL wallet is deliberately not used: the
 * site cannot sign for it, so a pet sent there could not be armed or fed from the pass. Same
 * three-way result shape as the email lookup above, for the same reason: "no such user" is a
 * refusal the owner can act on, "Privy is down" is a retry, and they must never look alike.
 */
export async function lookupPrivyWalletByEmail(email: string): Promise<PrivyWalletLookup> {
  if (!config.modes.privyLive) {
    return { ok: false, error: "Privy is not configured; no directory to look up" };
  }
  try {
    const client = await getClient();
    if (!client.getUserByEmail) return { ok: false, error: "Privy client has no email directory lookup" };
    const user = await client.getUserByEmail(email);
    if (!user) return { ok: true, address: null };
    const wallets = (user.linkedAccounts ?? []).filter(
      (a) =>
        a.type === "wallet" &&
        /^0x[0-9a-fA-F]{40}$/.test(a.address ?? "") &&
        (a.chainType === undefined || a.chainType === "ethereum"),
    );
    const embedded = wallets.find((a) => a.walletClientType === "privy");
    return { ok: true, address: embedded?.address ? embedded.address.toLowerCase() : null };
  } catch (err) {
    logger.warn({ err: String(err) }, "privy getUserByEmail wallet lookup failed");
    return { ok: false, error: String(err) };
  }
}

// The verified user's linked EVM wallet addresses (embedded + external),
// lowercased. This is the server-side source of truth for "which wallet does
// this Privy session control": ownership checks must use THIS, never a
// client-asserted address. Empty in stub mode or on any failure.
export async function getPrivyUserWallets(
  userId: string | undefined,
): Promise<string[]> {
  if (!config.modes.privyLive || !userId) return [];
  try {
    const client = await getClient();
    const user = await client.getUser(userId);
    return (user.linkedAccounts ?? [])
      .filter((a) => a.type === "wallet" && /^0x[0-9a-fA-F]{40}$/.test(a.address ?? ""))
      .map((a) => a.address!.toLowerCase());
  } catch (err) {
    logger.warn({ err: String(err) }, "privy getUser wallet lookup failed");
    return [];
  }
}

/**
 * Verify a Privy access token. NEVER returns ok:true without a real verification.
 *
 * FAIL CLOSED WHEN PRIVY IS UNCONFIGURED. This used to return `{ ok: true, method: "bypass" }`
 * when PRIVY_APP_ID/SECRET were absent. Every caller today happens to be safe because each one
 * checks `config.modes.privyLive` BEFORE calling and handles the stub posture itself, so this
 * flip changes no behaviour at all right now (the stub branch below is unreachable from both
 * call sites). But the API shape was the trap: a function named verifyPrivyToken that answers
 * "yes, verified" for an unconfigured deployment is one future `if (auth.ok)` away from an
 * authentication bypass, and it would read as correct in review. The stub decision belongs to
 * the caller, which alone knows whether an unauthenticated path is acceptable there; this
 * function's only job is to answer whether the token actually verified.
 */
export async function verifyPrivyToken(
  token: string | undefined,
): Promise<PrivyVerifyResult> {
  if (!config.modes.privyLive) {
    logger.warn(
      "PRIVY STUB: PRIVY_APP_ID/SECRET not set; cannot verify a token. Returning NOT verified. " +
        "Callers that intend to allow an unauthenticated demo path must gate on config.modes.privyLive themselves.",
    );
    return {
      ok: false,
      method: "bypass",
      error: "Privy is not configured (PRIVY_APP_ID/PRIVY_APP_SECRET unset); token not verified",
    };
  }
  if (!token) {
    return { ok: false, method: "privy", error: "missing Privy access token" };
  }
  try {
    const client = await getClient();
    const claims = await client.verifyAuthToken(token);
    return { ok: true, method: "privy", userId: claims.userId };
  } catch (err) {
    return { ok: false, method: "privy", error: String(err) };
  }
}
