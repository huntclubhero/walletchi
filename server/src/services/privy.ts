import { config } from "../config.js";
import { logger } from "../logger.js";

// Verify a Privy access token from the buy flow. When Privy creds are absent (dev / stub)
// verification is IMPOSSIBLE, so verifyPrivyToken() reports ok:false with method:"bypass"
// rather than waving the caller through. A caller that deliberately supports an
// unauthenticated demo path checks config.modes.privyLive itself and takes its own branch;
// see the note on verifyPrivyToken below for why the old ok:true stub was a latent bypass.

export type PrivyUserRecord = {
  /** Privy's user id (did:privy:...). Present on every real record; optional for the older fakes. */
  id?: string;
  email?: { address?: string };
  /** When the Privy user was created (the SDK gives a Date; a fake may give epoch seconds or ms). */
  createdAt?: Date | string | number;
  linkedAccounts?: Array<{ type?: string; address?: string; walletClientType?: string; chainType?: string }>;
};

export type PrivyClient = {
  verifyAuthToken: (token: string) => Promise<{ userId: string }>;
  getUser: (userId: string) => Promise<PrivyUserRecord>;
  // The directory lookup behind "Gift this pet" (an email typed by the owner resolves to the
  // recipient's embedded wallet). Optional so the older test fakes keep type-checking; a client
  // without it answers "lookup unavailable", never "no such user".
  getUserByEmail?: (email: string) => Promise<PrivyUserRecord | null>;
  // Delete a user (DELETE /api/v1/users/:id on the Privy REST API, Basic app:secret). The only
  // caller is the no-Chi seat release (me-routes.ts), which proves "no linked wallet owns a pet"
  // on-chain first. Optional so the older test fakes keep type-checking; a client without it
  // answers "unavailable", never "released".
  deleteUser?: (userId: string) => Promise<void>;
  // Create a user server-side with an embedded EVM wallet (POST /api/v1/users on the Privy REST
  // API). The only caller is the internal gift mint (routes/internal-gift.ts): a keeper named by
  // email gets a wallet before the pet is issued into it, exactly what the old ops script did by
  // hand. Optional so the older test fakes keep type-checking; a client without it answers
  // "unavailable", never "created".
  importUser?: (input: {
    linkedAccounts: Array<{ type: "email"; address: string }>;
    createEthereumWallet?: boolean;
  }) => Promise<PrivyUserRecord>;
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
): Promise<string[] | null> {
  if (!config.modes.privyLive || !userId) return [];
  try {
    const client = await getClient();
    const user = await client.getUser(userId);
    return (user.linkedAccounts ?? [])
      .filter((a) => a.type === "wallet" && /^0x[0-9a-fA-F]{40}$/.test(a.address ?? ""))
      .map((a) => a.address!.toLowerCase());
  } catch (err) {
    // null = Privy could not be asked (transport); [] = asked, no wallets. The checkout answers
    // 503 retry for null instead of the misleading 403 self_custody_required.
    logger.warn({ err: String(err) }, "privy getUser wallet lookup failed");
    return null;
  }
}

/** A verified user's sign-in profile for the seat release, or why we do not know. */
export type PrivyProfileLookup =
  | { ok: true; email: string | null; wallets: string[]; createdAt: Date | null } // asked and answered
  | { ok: false; error: string }; // could not ask; we know nothing, so nothing may be deleted

/**
 * The SDK gives a Date; a REST shape gives epoch seconds; a fake may give ms. Null when absent or
 * unreadable, and ALSO null for anything that is not a real creation time: an empty string, 0,
 * a negative number or a boolean all used to parse as 1970, which is "older than any floor" and
 * would have opened the door the age floor exists to close. Privy was founded in 2021, so any
 * instant before 2020 is a sentinel, not a date.
 */
const EARLIEST_PRIVY_CREATED_AT_MS = Date.UTC(2020, 0, 1);
function privyCreatedAt(raw: Date | string | number | undefined): Date | null {
  let d: Date | null = null;
  if (raw instanceof Date) {
    d = raw;
  } else if (typeof raw === "number") {
    d = Number.isFinite(raw) && raw > 0 ? new Date(raw < 1e12 ? raw * 1000 : raw) : null;
  } else if (typeof raw === "string" && raw.trim() !== "") {
    const n = Number(raw);
    if (Number.isFinite(n)) d = n > 0 ? new Date(n < 1e12 ? n * 1000 : n) : null;
    else d = new Date(raw);
  }
  if (!d || Number.isNaN(d.getTime()) || d.getTime() < EARLIEST_PRIVY_CREATED_AT_MS) return null;
  return d;
}

/**
 * ONE getUser read for the no-Chi seat release: the attested email (for the protected list),
 * every linked EVM wallet (embedded and external, lowercased) and when the account was created
 * (for the age floor). All three facts come from the same answer, so a user can never be judged
 * "unprotected" on one read and "walletless" on another; and a failed read is a refusal to
 * decide, never "no wallets, delete".
 */
export async function lookupPrivyUserProfile(userId: string): Promise<PrivyProfileLookup> {
  if (!config.modes.privyLive) {
    return { ok: false, error: "Privy is not configured; no profile to read" };
  }
  try {
    const client = await getClient();
    const user = await client.getUser(userId);
    const linkedEmail = user.linkedAccounts?.find((a) => a.type === "email" && a.address)?.address;
    const email = (user.email?.address ?? linkedEmail ?? null)?.trim().toLowerCase() ?? null;
    const wallets = (user.linkedAccounts ?? [])
      .filter((a) => a.type === "wallet" && /^0x[0-9a-fA-F]{40}$/.test(a.address ?? ""))
      .map((a) => a.address!.toLowerCase());
    return { ok: true, email, wallets, createdAt: privyCreatedAt(user.createdAt) };
  } catch (err) {
    logger.warn({ err: String(err) }, "privy getUser profile lookup failed");
    return { ok: false, error: String(err) };
  }
}

/**
 * Delete a Privy user: the seat release itself. The caller (me-routes.ts release-seat) has
 * already proven on-chain that no linked wallet owns a pet and that the email is not protected;
 * this function only carries the call. False when the client cannot delete or Privy refused,
 * so the route answers "unavailable" and the user keeps the seat (the ops sweep catches it).
 */
export async function deletePrivyUser(userId: string): Promise<{ ok: true } | { ok: false; error: string }> {
  if (!config.modes.privyLive) return { ok: false, error: "Privy is not configured; no user to delete" };
  try {
    const client = await getClient();
    if (!client.deleteUser) return { ok: false, error: "Privy client cannot delete users" };
    await client.deleteUser(userId);
    return { ok: true };
  } catch (err) {
    logger.warn({ err: String(err) }, "privy deleteUser failed");
    return { ok: false, error: String(err) };
  }
}

/** The internal gift mint's view of a keeper named by email, or why we cannot say. */
export type PrivyUserEnsure =
  | { ok: true; userId: string; wallet: string; created: boolean } // wallet = the EMBEDDED wallet, lowercased
  // created: true when Privy made the user (the seat is spent) but the answer still cannot be minted
  // into; "unknown" when the create call itself threw (Privy may or may not have kept the user).
  | { ok: false; code: "no_embedded_wallet" | "unavailable"; error: string; created?: boolean | "unknown" };

function embeddedWalletOf(user: PrivyUserRecord): string | null {
  const w = (user.linkedAccounts ?? []).find(
    (a) =>
      a.type === "wallet" &&
      a.walletClientType === "privy" &&
      /^0x[0-9a-fA-F]{40}$/.test(a.address ?? "") &&
      (a.chainType === undefined || a.chainType === "ethereum"),
  );
  return w?.address ? w.address.toLowerCase() : null;
}

/**
 * The Privy user behind `email`, with the EMBEDDED wallet a gift pet must land in, creating the
 * user (and that wallet) when nobody has signed in with the email yet and `create` is true.
 * A user that exists without an embedded wallet (external wallet only) is a refusal, never a
 * silent fallback to a wallet the site cannot sign for (same rule as the gift-by-email lookup).
 * Every failure to ASK is "unavailable": the caller must not mint into a guess.
 */
export async function ensurePrivyUserWithWallet(email: string, opts: { create: boolean }): Promise<PrivyUserEnsure> {
  if (!config.modes.privyLive) return { ok: false, code: "unavailable", error: "Privy is not configured" };
  let createAttempted = false;
  try {
    const client = await getClient();
    if (!client.getUserByEmail) return { ok: false, code: "unavailable", error: "Privy client has no email directory lookup" };
    const existing = await client.getUserByEmail(email);
    if (existing) {
      const wallet = embeddedWalletOf(existing);
      if (!existing.id) return { ok: false, code: "unavailable", error: "Privy record carries no user id" };
      if (!wallet) return { ok: false, code: "no_embedded_wallet", error: "the Privy user has no embedded wallet" };
      return { ok: true, userId: existing.id, wallet, created: false };
    }
    if (!opts.create) return { ok: false, code: "unavailable", error: "no Privy user for that email (dry run creates none)" };
    if (!client.importUser) return { ok: false, code: "unavailable", error: "Privy client cannot create users" };
    createAttempted = true;
    const made = await client.importUser({ linkedAccounts: [{ type: "email", address: email }], createEthereumWallet: true });
    const wallet = embeddedWalletOf(made);
    if (!made.id) return { ok: false, code: "unavailable", error: "Privy created a user but returned no id", created: true };
    if (!wallet) return { ok: false, code: "no_embedded_wallet", error: "Privy created the user but no embedded wallet came back", created: true };
    return { ok: true, userId: made.id, wallet, created: true };
  } catch (err) {
    // Privy's error text can echo the address (a duplicate-email refusal does): never log an email.
    const safe = String(err).replace(/[^\s@"'<>]+@[^\s@"'<>]+/g, "<email>");
    logger.warn({ err: safe, createAttempted }, "privy ensure user for gift mint failed");
    return { ok: false, code: "unavailable", error: safe, created: createAttempted ? "unknown" : false };
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
