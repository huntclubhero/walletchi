// SILENT CARE: feed the pet straight from the wallet pass, with no website and no
// per-care signature, after the owner signs exactly ONCE.
//
// HOW IT WORKS
//   1. On the website the owner signs one Alchemy MAv2 grant (ERC-7715
//      `functions-on-contract`) that scopes a freshly generated session key to
//      care(uint256,uint8) on the PetVault and NOTHING else.
//   2. That key + the grant's permissions context are POSTed here and sealed into
//      the CareSession table.
//   3. Every later tap of a pass care link is a gas-sponsored UserOp signed by the
//      session key. The owner never sees a prompt again.
//
// WHY THIS IS NOT THE OLD RELAYER
// The retired care relay held an UNRESTRICTED key and acted for whoever presented
// a valid HMAC link: a confused deputy. This key's authority is bounded ON-CHAIN by
// the account's validation hooks, not by our code. A leaked row can only ever FEED
// the pet: it cannot transfer the NFT, and it cannot move the pet's tokens anywhere
// except through the game's own burn/pot split. That is grief, not theft, and it is
// chain-enforced. PROVEN on Robinhood testnet 46630 (2026-08-12): the same session
// key attempting an NFT transferFrom is rejected at UserOp validation with
// PreUserOpValidationHookReverted(AddressNotAllowed()), selectors 0x4db96e31 /
// 0x2b53784e. The honest grief ceiling is "force-care every cooldown until the
// pet's whole stake is burned/potted and it starves".
//
// SESSION LIFECYCLE GOTCHA (learned the hard way, 2026-08-12): Alchemy refuses
// wallet_createSession for an EOA that is not yet EIP-7702 delegated
// ("7702 account must be delegated before calling `wallet_createSession`"). The
// delegation is installed by the owner's FIRST sponsored op, so the website must
// send one owner-signed care before granting. That first care is the one the user
// came to do anyway, so the flow still costs them a single deliberate action.
import { createCipheriv, createDecipheriv, randomBytes, scrypt as scryptCb, scryptSync } from "node:crypto";
import { createSmartWalletClient, alchemyWalletTransport } from "@alchemy/wallet-apis";
import { privateKeyToAccount } from "viem/accounts";
import { defineChain, encodeFunctionData, type Address, type Hex } from "viem";
import { config } from "../config.js";
import { logger } from "../logger.js";
import type { CareSession } from "../store/types.js";
import type { CareAction } from "./actions.js";

// care(uint256,uint8): the ONE function a session key may call. All five care
// actions are this selector with a different actionType byte, so a single
// permission entry covers the whole game. Keep in lockstep with gas-sponsor.ts
// and the web client (web-cub/src/lib/care.ts).
export const CARE_SELECTOR = "0x966664bd" as const;

// Must match the contract + web client ordering (FEED..EXPLORE = 0..4).
const CARE_ACTIONS: CareAction[] = ["feed", "water", "play", "toy", "explore"];

export function careActionType(action: CareAction): number {
  return CARE_ACTIONS.indexOf(action);
}

const CARE_ABI = [
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

// --- sealing the session key at rest -----------------------------------------

// AES-256-GCM under a scrypt-stretched CARE_SESSION_SECRET. Format:
// v1.<salt>.<iv>.<tag>.<ciphertext>, all base64url. The salt is per-row so two
// pets never share a derived key, and scrypt makes a stolen ciphertext expensive
// to attack even if the secret were weak (build() also refuses short secrets).
const SEAL_VERSION = "v1";

// scrypt at N=16384 costs tens of milliseconds (49 ms measured on the dev box),
// and Node is single threaded, so running it on EVERY care POST would let one
// valid care link stall the whole API (a link holder at the global 120/min limit
// burns seconds of event loop per minute, and the cheapest attacker is an honest
// owner tapping their own pass). A row's salt is fixed for the life of the
// session, so the derived key is memoized by salt: only the FIRST care for each
// pet pays the KDF, and only the seal at install pays it with a fresh salt.
//
// THE REQUEST PATHS USE THE ASYNC VARIANT (launch fix 4). The old note here argued
// for scryptSync ("async just moves the stall onto the 4-thread libuv pool and
// starves fs and dns"). Under a mint burst that trade reverses: the install runs
// once per keeper right after their mint, fifty of them inside a minute behind a
// campus NAT, and 50 x 49 ms of synchronous scrypt is 2.5 s during which NO poll,
// health check or pass download is answered at all. On the pool it costs a
// thread for 49 ms and the loop keeps serving. The pool is shared with sharp's
// rasters, so under load an install may queue behind a render, which is the
// right order of things: a slow install is a slow install, a stalled loop is an
// outage. The synchronous functions stay for scripts and tests (they must not
// change ciphertext format: same KDF, same parameters, same cache).
//
// The cache holds derived keys, so it is bounded hard and cleared whenever the
// secret changes identity. Bounded by simple eviction: 2,000 pets is the supply
// cap, so this never grows past a few hundred KB in practice.
const derivedKeys = new Map<string, Buffer>();
const MAX_DERIVED_KEYS = 4096;
let derivedFor: string | null = null;

function deriveCacheKey(salt: Buffer): string {
  const secret = config.CARE_SESSION_SECRET;
  if (!secret) throw new Error("CARE_SESSION_SECRET is not set");
  // A secret change must never serve keys derived from the old one.
  if (derivedFor !== secret) {
    derivedKeys.clear();
    derivedFor = secret;
  }
  return salt.toString("base64url");
}

function remember(key: string, out: Buffer): Buffer {
  if (derivedKeys.size >= MAX_DERIVED_KEYS) derivedKeys.clear();
  derivedKeys.set(key, out);
  return out;
}

function derive(salt: Buffer): Buffer {
  const key = deriveCacheKey(salt);
  const hit = derivedKeys.get(key);
  if (hit) return hit;
  return remember(key, scryptSync(config.CARE_SESSION_SECRET!, salt, 32));
}

async function deriveAsync(salt: Buffer): Promise<Buffer> {
  const key = deriveCacheKey(salt);
  const hit = derivedKeys.get(key);
  if (hit) return hit;
  const out = await new Promise<Buffer>((resolve, reject) =>
    scryptCb(config.CARE_SESSION_SECRET!, salt, 32, (err, derived) => (err ? reject(err) : resolve(derived))),
  );
  return remember(key, out);
}

function sealWith(privateKey: Hex, salt: Buffer, key: Buffer): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const ct = Buffer.concat([cipher.update(privateKey, "utf8"), cipher.final()]);
  const b64 = (b: Buffer) => b.toString("base64url");
  return [SEAL_VERSION, b64(salt), b64(iv), b64(cipher.getAuthTag()), b64(ct)].join(".");
}

function parseSealed(sealed: string): { salt: Buffer; iv: Buffer; tag: Buffer; ct: Buffer } {
  const parts = sealed.split(".");
  if (parts.length !== 5 || parts[0] !== SEAL_VERSION) {
    throw new Error("sealed session key is malformed");
  }
  const [, saltB64, ivB64, tagB64, ctB64] = parts as [string, string, string, string, string];
  const buf = (s: string) => Buffer.from(s, "base64url");
  return { salt: buf(saltB64), iv: buf(ivB64), tag: buf(tagB64), ct: buf(ctB64) };
}

function openWith(p: { iv: Buffer; tag: Buffer; ct: Buffer }, key: Buffer): Hex {
  const decipher = createDecipheriv("aes-256-gcm", key, p.iv);
  decipher.setAuthTag(p.tag);
  const pt = Buffer.concat([decipher.update(p.ct), decipher.final()]).toString("utf8");
  if (!/^0x[0-9a-fA-F]{64}$/.test(pt)) throw new Error("sealed session key did not decode to a key");
  return pt as Hex;
}

/** Synchronous seal (scripts, tests). Request paths use sealSessionKeyAsync. */
export function sealSessionKey(privateKey: Hex): string {
  const salt = randomBytes(16);
  return sealWith(privateKey, salt, derive(salt));
}

/** The install route's seal: the KDF runs on the libuv pool, the loop keeps serving. */
export async function sealSessionKeyAsync(privateKey: Hex): Promise<string> {
  const salt = randomBytes(16);
  return sealWith(privateKey, salt, await deriveAsync(salt));
}

/** Synchronous open (scripts, tests). Request paths use openSessionKeyAsync. */
export function openSessionKey(sealed: string): Hex {
  const p = parseSealed(sealed);
  return openWith(p, derive(p.salt));
}

/** The care path's open: a cache hit after the first tap; the first tap's KDF runs off the loop. */
export async function openSessionKeyAsync(sealed: string): Promise<Hex> {
  const p = parseSealed(sealed);
  return openWith(p, await deriveAsync(p.salt));
}

// --- submitting a care with a session key ------------------------------------

// Local chain definition so this module does not depend on the relayer seam (the
// session path never touches the relayer key: that is the whole point).
function robinhoodChain() {
  const rh = config.robinhood;
  return defineChain({
    id: rh.chainId,
    name: `Robinhood Chain ${config.ROBINHOOD_NETWORK}`,
    nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
    rpcUrls: { default: { http: [rh.rpcUrl] } },
    blockExplorers: { default: { name: "Blockscout", url: rh.explorer } },
  });
}

// Why a stored session is not usable right now. `fallback` results send the tap to
// the owner-signed care page; `terminal` results are the pet's own state and the
// care page would say the same thing.
export type SessionUnusable =
  | "none" // no session installed yet
  | "revoked"
  | "expired"
  | "wrong_vault" // granted against a previous season's vault
  | "wrong_owner" // pet changed hands since the grant
  | "wrong_pet" // the row is not for the pet being cared for
  | "off"; // silent care not configured on this deployment

export type SessionVerdict =
  | { ok: true; session: CareSession }
  | { ok: false; reason: SessionUnusable };

// Is this pet's stored session usable for a tap RIGHT NOW? Pure: the caller does
// the DB read and the authoritative ownership read, so this stays testable and
// free of import cycles. Season-bound and owner-bound on purpose: a new PetVault
// or a sold pet must fall back to the owner-signed page, never silently care with
// a key the current owner never granted.
export function sessionVerdict(
  session: CareSession | null,
  expect: { vaultAddress: string | null | undefined; ownerAddress: string; tokenId?: string | null; now?: Date },
): SessionVerdict {
  if (!config.modes.silentCareLive) return { ok: false, reason: "off" };
  if (!session) return { ok: false, reason: "none" };
  if (session.revokedAt) return { ok: false, reason: "revoked" };
  // The care call is built from the STORED tokenId, so refuse to act on a row
  // that is not for the pet in front of us. The install path keeps these in step,
  // which makes this belt and braces: it turns any future bug that decouples them
  // into a harmless fallback instead of caring for the wrong pet.
  if (expect.tokenId !== undefined && session.tokenId !== expect.tokenId) {
    return { ok: false, reason: "wrong_pet" };
  }
  const now = expect.now ?? new Date();
  if (session.expiresAt.getTime() <= now.getTime()) return { ok: false, reason: "expired" };
  if (!expect.vaultAddress || session.vaultAddress.toLowerCase() !== expect.vaultAddress.toLowerCase()) {
    return { ok: false, reason: "wrong_vault" };
  }
  if (session.ownerAddress.toLowerCase() !== expect.ownerAddress.toLowerCase()) {
    return { ok: false, reason: "wrong_owner" };
  }
  return { ok: true, session };
}

// How long to wait for the bundle to confirm before answering the keeper. Short
// enough that a wallet in-app browser is not left hanging (viem's own default is
// 60s), and a timeout is reported as "on its way", not as a failure.
const WAIT_TIMEOUT_MS = 25_000;

export type CareFailureKind =
  | "cooldown"
  | "dead"
  | "over"
  | "not_owner"
  | "needs_tokens"
  | "capped"
  | "spender_revoked" // the pet's account revoked its spender: it can NEVER be fed again
  | "permission" // CONFIRMED out-of-scope or revoked on-chain: safe to retire the row
  | "validation" // validation-side rejection we could NOT confirm: fall back, do NOT retire
  | "unreadable" // we cannot open our own seal: our problem, never the permission's
  | "pending" // accepted by the bundler, not confirmed inside our wait window
  | "chain";

export type CareSubmitResult =
  | { ok: true; txHash: string }
  | { ok: false; kind: CareFailureKind; revertData?: string; detail: string };

// Revert selectors we can speak to the keeper about, verified against
// contracts/abi/PetVault.json and WalletchiAccount.json. Everything else is
// "chain". The token-side entries matter: care() pulls careCost from the pet's
// OWN token-bound account, so a pet that has run out is the single most likely
// real-world failure, and telling that keeper to "try again in a moment" would
// be a lie (retrying never helps; they need to top the pet up).
const VAULT_REVERTS: Record<string, CareFailureKind> = {
  "0x6250c485": "cooldown", // PetVault.CareOnCooldown()
  "0x5dbaefb7": "dead", // PetVault.PetIsDead()
  "0x808b8a1f": "dead", // PetVault.NotCareable()
  "0xdf469ccb": "over", // PetVault.GameOver()
  "0x93c356cf": "not_owner", // PetVault.NotAuthorizedCarer()
  "0x5274afe7": "needs_tokens", // SafeERC20FailedOperation(address): the pull failed, pet is out
  // NOT needs_tokens. revokeSpender() is IRREVERSIBLE (spenderInitialized stays true, so the issuer can
  // never be re-appointed), which means this pet can never be fed again by anyone. Telling the keeper to
  // top it up would send them to spend money on a pet that is already unrecoverable.
  "0xe79dd391": "spender_revoked", // WalletchiAccount.NotSpender()
  "0x2da7c2d3": "capped", // WalletchiAccount.OverPerTxCap()
  "0xc4891db5": "capped", // WalletchiAccount.OverDailyCap()
  "0xe3111719": "capped", // WalletchiAccount.OverCarerCap()
};

// MAv2 rejects an out-of-scope op at validation with
// PreUserOpValidationHookReverted(bytes24,bytes) wrapping AddressNotAllowed(). Only
// these CONFIRMED selectors justify retiring a session: they are proof the on-chain
// permission will never authorize this call. Anything vaguer is treated as
// "validation" and falls back WITHOUT retiring, because revocation is irreversible
// (the owner must sign a fresh grant) and a transient bundler failure must not cost
// every armed keeper their one-tap care.
const PERMISSION_REVERT_PREFIXES = ["0x4db96e31", "0x2b53784e"];

function revertDataOf(err: unknown): string | null {
  const seen = new Set<unknown>();
  let cur: unknown = err;
  while (cur && typeof cur === "object" && !seen.has(cur)) {
    seen.add(cur);
    const data = (cur as { data?: { revertData?: unknown } }).data;
    const rd = data?.revertData;
    if (typeof rd === "string" && rd.startsWith("0x")) return rd;
    cur = (cur as { cause?: unknown }).cause;
  }
  return null;
}

// Error text for the log: every URL cut down to its origin (an RPC or bundler URL carries its API
// key in the path, and a pass link carries its tag in the query), capped in length.
export function logSafeDetail(detail: string): string {
  return detail.replace(/(https?:\/\/[^\s/?#"']+)[^\s"']*/gi, "$1").slice(0, 300);
}

function classify(err: unknown): CareSubmitResult {
  const rd = revertDataOf(err);
  const detail = String((err as { shortMessage?: string; message?: string })?.shortMessage ?? (err as Error)?.message ?? err).slice(0, 300);
  if (rd) {
    const sel = rd.slice(0, 10);
    const known = VAULT_REVERTS[sel];
    if (known) return { ok: false, kind: known, revertData: sel, detail };
    if (PERMISSION_REVERT_PREFIXES.includes(sel)) {
      return { ok: false, kind: "permission", revertData: sel, detail };
    }
  }
  // AA23 with no decodable revert data is the EntryPoint's GENERIC validation-phase
  // failure. It covers an expired or revoked permission, but equally a transient
  // condition such as validation-phase out of gas from a low verificationGasLimit
  // estimate. We cannot tell them apart, so we fall back without retiring the row.
  if (/AA23|validation reverted/i.test(detail)) {
    return { ok: false, kind: "validation", revertData: rd ?? undefined, detail };
  }
  return { ok: false, kind: "chain", revertData: rd ?? undefined, detail };
}

// INSTALL-TIME SCOPE PROOF.
//
// The whole "grief, not theft" ceiling rests on the grant being scoped to care()
// on the PetVault. But the client generates that grant, and the `context` we
// receive is an opaque blob: on its own, an owner-attested claim. If a compromised
// front end (XSS, a poisoned bundle, a hijacked CDN) swapped in a ROOT-scoped
// grant, we would store it and drive it happily, and the blast radius would stop
// being the pet's stake and become the owner's whole 7702 account.
//
// So before storing a key we ask the chain the same question the audit asks: does
// this context authorize something that is NOT care() on the vault? We prepare an
// out-of-scope op (an ERC-721 transferFrom on the pet contract) and expect the
// account's validation hooks to REJECT it.
//
// Deliberately REJECT-KNOWN-BAD, not require-known-good: we refuse the install only
// when the probe SUCCEEDS (proof the scope is too wide). An inconclusive probe (an
// Alchemy blip, a network error) allows the install, so this can never lock an
// honest keeper out of one-tap care. That makes it a real barrier against a
// compromised client without becoming a new availability dependency.
const ERC721_TRANSFER_ABI = [
  {
    type: "function",
    name: "transferFrom",
    stateMutability: "nonpayable",
    inputs: [
      { name: "from", type: "address" },
      { name: "to", type: "address" },
      { name: "tokenId", type: "uint256" },
    ],
    outputs: [],
  },
] as const;

export type ScopeProbe = "rejected" | "allowed" | "inconclusive";

export async function probeGrantScope(opts: {
  context: string;
  ownerAddress: string;
  tokenId: string;
}): Promise<ScopeProbe> {
  const apiKey = config.ALCHEMY_API_KEY;
  const policyId = config.GAS_POLICY_ID;
  const pet721 = config.pet721Address;
  if (!apiKey || !policyId || !pet721) return "inconclusive";
  try {
    const client = createSmartWalletClient({
      // The probe only needs a syntactically valid signer to build the request; it
      // never signs or sends. Validation is what we are testing, and that happens
      // during prepareCalls simulation.
      signer: privateKeyToAccount(`0x${"11".repeat(32)}` as Hex),
      transport: alchemyWalletTransport({ apiKey }),
      chain: robinhoodChain(),
      paymaster: { policyId },
    });
    await client.prepareCalls({
      calls: [
        {
          to: pet721 as Address,
          data: encodeFunctionData({
            abi: ERC721_TRANSFER_ABI,
            functionName: "transferFrom",
            args: [opts.ownerAddress as Address, DEAD_ADDRESS, BigInt(opts.tokenId)],
          }),
        },
      ],
      account: opts.ownerAddress as Address,
      capabilities: { paymaster: { policyId }, permissions: { context: opts.context as Hex } },
    });
    // It built an out-of-scope op without the hooks objecting. The grant is wider
    // than care(), so this key must not be stored.
    return "allowed";
  } catch (err) {
    const rd = revertDataOf(err);
    const sel = rd?.slice(0, 10);
    if (sel && PERMISSION_REVERT_PREFIXES.includes(sel)) return "rejected";
    const detail = String((err as { shortMessage?: string; message?: string })?.shortMessage ?? (err as Error)?.message ?? err);
    if (/AA23|validation reverted/i.test(detail)) return "rejected";
    return "inconclusive";
  }
}

const DEAD_ADDRESS = "0x000000000000000000000000000000000000dEaD" as Address;

// Submit care(tokenId, action) signed by the pet's stored session key, gas paid by
// the Gas Manager policy. Never touches the relayer key and never sees the owner.
// TEST SEAM (smoke only): replaces the Alchemy submission so the pass-tap POST route can be
// driven end to end against the MockChain. Null in production; nothing else sets it.
let submitOverrideForTests: ((session: CareSession, action: CareAction) => Promise<CareSubmitResult>) | null = null;
export function _setSessionCareSubmitterForTests(
  fn: ((session: CareSession, action: CareAction) => Promise<CareSubmitResult>) | null,
): void {
  submitOverrideForTests = fn;
}

export async function submitSessionCare(
  session: CareSession,
  action: CareAction,
): Promise<CareSubmitResult> {
  if (submitOverrideForTests) return submitOverrideForTests(session, action);
  const apiKey = config.ALCHEMY_API_KEY;
  const policyId = config.GAS_POLICY_ID;
  if (!apiKey || !policyId) {
    return { ok: false, kind: "chain", detail: "silent care is not configured" };
  }
  let signer;
  try {
    signer = privateKeyToAccount(await openSessionKeyAsync(session.secretEnc));
  } catch (err) {
    // We could not open OUR OWN seal. That is an operator problem (most likely a
    // rotated or mismatched CARE_SESSION_SECRET), not evidence about the on-chain
    // permission. Retiring the row here would turn one env mistake into every
    // armed keeper being permanently disarmed, so this gets its own kind.
    return { ok: false, kind: "unreadable", detail: `session key unreadable: ${String(err).slice(0, 120)}` };
  }
  const client = createSmartWalletClient({
    signer,
    transport: alchemyWalletTransport({ apiKey }),
    chain: robinhoodChain(),
    paymaster: { policyId },
  });
  // `account` stays the OWNER's 7702 account; `permissions.context` is what
  // authorizes this key to act on it. The resulting userOp is a plain
  // execute(target,value,data) (selector 0xb61d27f6), which is exactly the shape
  // the care-only sponsorship webhook approves.
  const permissions = { context: session.context as Hex };
  const call = {
    to: session.vaultAddress as Address,
    data: encodeFunctionData({
      abi: CARE_ABI,
      functionName: "care",
      args: [BigInt(session.tokenId), careActionType(action)],
    }),
  };
  let sentId: Hex | null = null;
  try {
    const prepared = await client.prepareCalls({
      calls: [call],
      account: session.ownerAddress as Address,
      capabilities: { paymaster: { policyId }, permissions },
    });
    const signed = await client.signPreparedCalls(prepared);
    const sent = await client.sendPreparedCalls({ ...signed, capabilities: { permissions } });
    // SEND AND WAIT ARE DIFFERENT FACTS. Once the bundler has accepted the op the
    // care is in flight and WILL most likely land, so a slow confirmation must not
    // be reported as a failure: that would tell a keeper their pet was not fed
    // when it was, and their retry would just hit CareOnCooldown. Anything after
    // this line is a CONFIRMATION problem, never a care problem.
    // A resolved send means the bundler took it, even if the response carries no
    // usable id. Mark it sent BEFORE anything that can throw, so a missing id is
    // reported as "on its way" rather than as a failure for an op that did land.
    sentId = ((sent.id ?? sent.preparedCallIds?.[0]) ?? "0x") as Hex;
    const final = await client.waitForCallsStatus({ id: sentId, timeout: WAIT_TIMEOUT_MS });
    const txHash = final.receipts?.[0]?.transactionHash ?? sentId;
    if (final.status !== "success") {
      return { ok: false, kind: "chain", detail: `bundle status ${String(final.status)}` };
    }
    return { ok: true, txHash };
  } catch (err) {
    if (sentId) {
      logger.warn(
        { serial: session.serial, tokenId: session.tokenId, action, id: sentId, detail: String((err as Error)?.message ?? err).slice(0, 200) },
        "session care submitted but not confirmed in the wait window",
      );
      return { ok: false, kind: "pending", detail: `submitted as ${sentId}, not confirmed within ${WAIT_TIMEOUT_MS}ms` };
    }
    const res = classify(err);
    logger.warn(
      {
        serial: session.serial,
        tokenId: session.tokenId,
        action,
        kind: res.ok ? "ok" : res.kind,
        revertData: res.ok ? undefined : res.revertData,
        // The error text classify() already built; without it a rejection only said "chain".
        detail: res.ok ? undefined : logSafeDetail(res.detail),
      },
      "session care rejected",
    );
    return res;
  }
}
