// Client for the existing SALMON RUN runner endpoints. Field shapes match the server's
// runnerStatusView (see server/src/runner/routes.ts). Reads never throw (return null so the
// poller keeps trying); the create action throws ApiError so the form can be kind about it.
import { API_URL } from "./config";

export class ApiError extends Error {
  status: number;
  code?: string;
  constructor(message: string, status = 0, code?: string) {
    super(message);
    this.name = "ApiError";
    this.status = status;
    this.code = code;
  }
}

export interface RunnerSession {
  id?: string;
  serial?: string;
  status?: string; // "minting" | "ready" | "failed"
  tokenId?: string;
  playUrl?: string;
  applePassUrl?: string;
  bestDisplay?: string;
  bestScore?: number;
  salmon?: number;
  runs?: number;
  runnerNumber?: string;
  network?: string;
  bypass?: boolean;
  // Returned ONLY by POST /api/runner/checkout (the minting browser). Lets the
  // minter fetch their pass link post-mint even when the public views withhold
  // it (economy on). Never present on the serial-keyed poll.
  mintSession?: string;
  // Present on the checkout poll while the mint is still queued or broadcast (the
  // server's in-flight register, launch fix 1): the keeper's place in line and a
  // rough wait. Its presence means the mint is ALIVE on the server, which is what
  // the MintForm keys its patience on.
  queue?: { position: number; ahead: number; etaSec: number; phase: "queued" | "submitted" };
  error?: string;
  failureReason?: string;
  // live pet state (GET /api/runner/:serial)
  tbaAddress?: string;
  tba?: string;
  ownerAddress?: string;
  owner?: string;
  // True when the pet is owned by the server relayer (an email-only custodial pet). The trustless care
  // page cannot feed these (the owner is not the signed-in wallet), so it explains that instead.
  custodial?: boolean;
  hunger?: number;
  thirst?: number;
  joy?: number;
  toys?: number;
  mood?: string;
  hatched?: boolean;
  critical?: boolean;
  gone?: boolean;
  // live status (server emits from authoritative on-chain vault state; all optional).
  // `status` is declared above; here we add the health/life fields the pet page reads.
  secondsLeft?: number; // life remaining; formatted to "Life Left" on the pet page
  daysLived?: number;
  careCount?: number;
  lastEvent?: string;
  // FIVE NEEDS, canonical action order (feed, water, play, toy, explore). Present
  // only for a live, hatched pet in a live season; absent for an egg, a dead pet,
  // or pre-season, in which case the meters below stand in.
  needs?: { action?: string; label?: string; secondsLeft?: number; pct?: number }[];
  lastActionAt?: number;
  links?: {
    play?: string;
    applePass?: string;
    account?: string | null;
    issueTx?: string | null;
  };
}

/** GET /api/runner/:serial. Full live pet state (meters, mood, links). Null if unknown. */
export async function getRunnerState(serial: string): Promise<RunnerSession | null> {
  return safeGet<RunnerSession>(`/api/runner/${encodeURIComponent(serial)}`);
}

function timeoutSignal(ms: number): AbortSignal | undefined {
  try {
    return AbortSignal.timeout(ms);
  } catch {
    return undefined;
  }
}

async function readJson<T>(res: Response): Promise<T> {
  const text = await res.text();
  try {
    return text ? (JSON.parse(text) as T) : ({} as T);
  } catch {
    throw new ApiError("The den sent back something we could not read.", res.status);
  }
}

/** POST that throws ApiError on failure. */
async function postJson<T>(path: string, body: unknown): Promise<T> {
  let res: Response;
  try {
    res = await fetch(`${API_URL}${path}`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "application/json" },
      body: JSON.stringify(body ?? {}),
      signal: timeoutSignal(45000),
    });
  } catch {
    throw new ApiError("We could not reach the den. Check your connection and try again.");
  }
  if (!res.ok) {
    const data = await readJson<{ error?: string; message?: string; code?: string }>(res).catch(
      () => ({}) as { error?: string; message?: string; code?: string },
    );
    throw new ApiError(
      data.error || data.message || `Request failed (${res.status}).`,
      res.status,
      data.code,
    );
  }
  return readJson<T>(res);
}

/** GET that returns null on any failure (poller keeps retrying). */
async function safeGet<T>(path: string): Promise<T | null> {
  try {
    const res = await fetch(`${API_URL}${path}`, {
      headers: { Accept: "application/json" },
      cache: "no-store",
      signal: timeoutSignal(6000),
    });
    if (!res.ok) return null;
    return await readJson<T>(res);
  } catch {
    return null;
  }
}

// Anti-Sybil extras sent with the mint. All optional and additive: with the
// server gate off they are simply ignored, so the mint works either way. These
// are inputs the SERVER re-verifies (PoW, timing, dedup); nothing here is a
// client-side verdict.
export interface MintExtras {
  pow?: { nonce: string; counter: number; sig: string; exp: number; bits: number };
  fingerprint?: string;
  honeypot?: string;
  elapsedMs?: number;
  botSignals?: Record<string, unknown>;
  /** Turnstile token, present only when the challenge advertised a captcha. */
  captchaToken?: string;
}

// Signed-in mint: the server verifies the Privy token and, when both are
// present, mints the pet straight to the user's own wallet (non-custodial).
// Absent (or if verification fails) the mint stays custodial exactly as today.
export interface PrivyMintOpts {
  privyToken?: string;
  walletAddress?: string;
}

/** Email cub mint (demo-bypass on the server). Returns the initial session. */
export async function createRunnerCheckout(
  email: string,
  extras?: MintExtras,
  privy?: PrivyMintOpts,
): Promise<RunnerSession> {
  return postJson<RunnerSession>("/api/runner/checkout", {
    email,
    ...(extras ?? {}),
    ...(privy ?? {}),
  });
}

/**
 * ONE-TAP CARE (on-chain scoped session key).
 *
 * `active` means a wallet-pass tap already feeds this pet silently. `supported` means the deployment can
 * do it at all. When it is not active the pass links fall back to this owner-signed care page, which is
 * the proven flow, so a false here is never an error state.
 */
export interface CareSessionStatus {
  supported: boolean;
  active: boolean;
  expiresAt?: string;
  reason?: string;
}

export async function getCareSessionStatus(tokenId: string): Promise<CareSessionStatus | null> {
  return safeGet<CareSessionStatus>(`/api/pet/${encodeURIComponent(tokenId)}/care-session`);
}

/**
 * Install the pet's care session: hand the server the scoped key the owner just granted. The server
 * verifies the Privy session owns the pet on-chain, checks the key matches its address, and seals the key
 * at rest. Sending the raw key is the design, not a leak: it can ONLY call care() on the PetVault (the
 * scope is enforced by the account's on-chain validation hooks), so the server gains the ability to feed
 * this pet and nothing else.
 */
export async function installCareSession(
  tokenId: string,
  grant: { sessionKey: string; publicKey: string; context: string; expiresAtSec: number },
  privyToken: string,
): Promise<{ ok: boolean; active: boolean; expiresAt?: string }> {
  return postJson(`/api/pet/${encodeURIComponent(tokenId)}/care-session`, { ...grant, privyToken });
}

/**
 * Tell the server that one-tap arming failed, and where. Fire-and-forget diagnostics: the arming
 * failure behind the 2026-09-23 "every tap opens the website" report left no trace server-side,
 * because the only record was console.error on the keeper's phone. Never throws.
 */
export async function reportArming(
  tokenId: string,
  input: { surface: string; stage: string; detail: string; owner?: string },
): Promise<void> {
  try {
    await fetch(`${API_URL}/api/pet/${encodeURIComponent(tokenId)}/arming-report`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ...input, detail: input.detail.slice(0, 480) }),
      keepalive: true,
    });
  } catch {
    /* diagnostics only */
  }
}

/** Poll a cub checkout by id (id === serial). Null if unreachable. */
export async function getRunnerCheckout(id: string): Promise<RunnerSession | null> {
  return safeGet<RunnerSession>(`/api/runner/checkout/${encodeURIComponent(id)}`);
}

/** The stable id to poll with. */
export function sessionId(s: RunnerSession): string {
  return s.id ?? s.serial ?? "";
}

/**
 * Exchange a mint-session token (from the checkout POST) for the just-minted
 * pet's pass links. Used when the economy is on and the public views withhold
 * the capability URL. Returns null on any failure (the emailed pass is the
 * fallback, so this never blocks the success screen).
 */
export async function fetchMintPassLink(
  id: string,
  mintSession: string,
): Promise<{ applePassUrl?: string; googleSaveUrl?: string } | null> {
  try {
    return await postJson<{ applePassUrl?: string; googleSaveUrl?: string }>("/api/runner/pass-link", {
      id,
      mintSession,
    });
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Survival season stats (The Pot). The server is still shaping this endpoint, so
// we read every plausible field name and fall back gracefully when it 404s.
// ---------------------------------------------------------------------------
export interface SeasonStats {
  // Confirmed server shape (field names say "cubs"; display as "pets"):
  potDisplay?: string;
  potRaw?: number | string;
  cubsAlive?: number;
  cubsTotal?: number;
  // Minted so far, how many have ever been cared for (hatched, so in the race),
  // and whether the whole supply is gone (minting closed).
  registered?: number;
  hatched?: number;
  soldOut?: boolean;
  careToken?: string;
  seasonActive?: boolean;
  // Tolerated aliases in case the shape shifts.
  pot?: number | string;
  potTokens?: number | string;
  symbol?: string;
  tokenSymbol?: string;
  alive?: number;
  petsAlive?: number;
  aliveCount?: number;
  total?: number;
  supply?: number;
  active?: boolean;
}

/** GET /api/season/stats. Null when unreachable or not built yet (render "season starting soon"). */
export async function getSeasonStats(): Promise<SeasonStats | null> {
  return safeGet<SeasonStats>("/api/season/stats");
}

// ---------------------------------------------------------------------------
// The Arena: one-call live survival board (GET /api/season/board). Confirmed
// server shape; every field optional so a partial payload never crashes a poll.
// ---------------------------------------------------------------------------
export interface FallenPet {
  tokenId?: string | null;
  serial?: string;
  number?: string; // "No. 0482"
  diedAt?: string;
  outlasted?: number; // pets it outlived (present when the death rank is known)
}

export interface KeeperPet {
  tokenId?: string | null;
  serial?: string;
  number?: string;
  careCount?: number;
}

export interface SeasonBoard {
  seasonActive?: boolean;
  // `total` is the SUPPLY CAP, not a headcount. `registered` is how many pets
  // exist so far and `hatched` how many have ever been cared for (the ones
  // actually in the race). Never use the cap as a denominator for alive/fallen.
  survivors?: {
    alive?: number;
    total?: number;
    fallen?: number;
    registered?: number;
    hatched?: number;
  };
  pot?: { display?: string; raw?: string };
  recentDeaths?: FallenPet[];
  topKeepers?: KeeperPet[];
  // Present ONLY once the CARE token has a real price source (server-side
  // CARE_USD_PRICE hook). Absent = render no dollar line; never invent one.
  usdValue?: number;
}

/** GET /api/season/board. Null when unreachable (the Arena keeps its last state). */
export async function getSeasonBoard(): Promise<SeasonBoard | null> {
  return safeGet<SeasonBoard>("/api/season/board");
}

/** Resolve the play + Apple Wallet links whichever shape the server used. */
export function runnerLinks(s: RunnerSession): { play?: string; apple?: string } {
  return {
    play: s.playUrl ?? s.links?.play,
    apple: s.applePassUrl ?? s.links?.applePass,
  };
}

// ---------------------------------------------------------------------------
// Secondary-market claim: a new owner who bought a WALLETCHI (e.g. on OpenSea)
// adds the pet's wallet pass to their own Apple / Google Wallet.
//
// PLACEHOLDER CONTRACT (the real endpoint is wired later by the lead + server-dev2;
// the UI states are stable regardless). One route handles both proofs:
//
//   POST /api/claim
//     Wallet path:  { method: "wallet", address, signature, message, tokenId? }
//     Email  path:  { method: "email",  email, tokenId }
//
//   200, single verified pet:
//     { ok: true, serial, tokenId, runnerNumber, status,
//       secondsLeft?, applePassUrl?, googleSaveUrl?, emailed? }
//   200, wallet owns several and none was chosen yet:
//     { ok: false, multiple: true,
//       pets: [{ tokenId, serial, runnerNumber, status }] }
//   4xx, cannot claim (kind message + machine code):
//     { error: "message", code: "not_owner" | "not_found" | "dead_soulbound" }
//
// Server does the real work: verifies Pet721.ownerOf(tokenId) == signer on-chain,
// re-issues the pass for the SAME pet (never resets state), and rotates the pass
// authToken so the previous owner's pass can no longer control it. A dead pet is a
// soulbound memorial: it stays viewable but cannot be claimed for transfer.
// ---------------------------------------------------------------------------

export interface ClaimPet {
  tokenId?: string;
  serial?: string;
  runnerNumber?: string;
  status?: string; // "alive" | "critical" | "dead"
}

export interface ClaimResult {
  ok?: boolean;
  multiple?: boolean;
  pets?: ClaimPet[];
  serial?: string;
  tokenId?: string;
  runnerNumber?: string;
  status?: string;
  secondsLeft?: number;
  applePassUrl?: string;
  googleSaveUrl?: string;
  emailed?: boolean;
  error?: string;
  code?: string;
}

export interface WalletClaimInput {
  address: string;
  signature: string;
  message: string;
  tokenId?: string;
  // The buyer's contact: a wallet claim unbinds the seller's email on the
  // server, so this is how the NEW owner gets a receipt and email re-delivery.
  email?: string;
}

/**
 * GET a fresh single-use claim nonce from the server (GET /api/claim/nonce).
 * The wallet must personal_sign a message embedding THIS nonce; POST /api/claim
 * rejects anything else. Throws ApiError if the server is unreachable.
 */
export async function fetchClaimNonce(): Promise<string> {
  const data = await safeGet<{ nonce?: string }>("/api/claim/nonce");
  if (!data?.nonce) {
    throw new ApiError("We could not start a claim session. Please try again in a moment.");
  }
  return data.nonce;
}

/** Prove ownership with a connected wallet + signed message. Throws ApiError on failure. */
export async function claimByWallet(input: WalletClaimInput): Promise<ClaimResult> {
  return postJson<ClaimResult>("/api/claim", { method: "wallet", ...input });
}

/** Fallback: verify by email on file, server emails the add-to-wallet link. Throws ApiError. */
export async function claimByEmail(email: string, tokenId: string): Promise<ClaimResult> {
  return postJson<ClaimResult>("/api/claim", { method: "email", email, tokenId });
}

// ---------------------------------------------------------------------------
// On-site pet management (the /me dashboard). GET /api/pets/by-owner resolves
// which pets a wallet currently owns (on-chain ownerOf on the server); the
// care + pass-link POSTs are Privy-authenticated: the server verifies the
// token, resolves the session's wallets server-side, and requires the pet's
// CURRENT owner to be one of them.
// ---------------------------------------------------------------------------

export interface OwnedPet {
  serial?: string;
  tokenId?: string;
  number?: string; // "No. 0482"
  status?: string; // "alive" | "critical" | "dead"
  secondsLeft?: number;
  careCount?: number;
  hunger?: number;
  thirst?: number;
  joy?: number;
  hatched?: boolean;
  tbaAddress?: string;
  // FIVE NEEDS in canonical action order, same shape and same gates as the
  // runner state payload. Absent for an egg, a dead pet, or pre-season.
  needs?: { action?: string; label?: string; secondsLeft?: number; pct?: number }[];
}

/** The pets a wallet owns right now. Null when the den is unreachable. */
export async function getPetsByOwner(address: string): Promise<OwnedPet[] | null> {
  const data = await safeGet<{ pets?: OwnedPet[] }>(
    `/api/pets/by-owner?address=${encodeURIComponent(address)}`,
  );
  return data?.pets ?? null;
}

export interface CareStat {
  statLabel?: string; // "Hunger" | "Thirst" | "Joy"
  delta?: number;
  from?: number;
  to?: number;
}

// Mirrors the server's confirm-page result as JSON: kind title/body copy, the
// applied meter delta when one happened, and the on-chain tx when care is live.
export interface CareActionResult {
  ok?: boolean;
  title?: string;
  body?: string;
  emoji?: string;
  stat?: CareStat;
  txHash?: string;
  updating?: boolean;
  /** HTTP status of the reply. 402 means the pet's account is out of CARE. */
  httpStatus?: number;
}

/**
 * Authenticated care from the site (feed/water/play...). The den answers care
 * failures it can explain, like the 402 "Needs care tokens", with the same kind
 * title/body/emoji its confirm page shows; those come back here as a RESULT
 * (ok:false + httpStatus) so the dashboard renders its branded flash, with a
 * Top-up button on the 402, instead of a bare error line. Replies without that
 * friendly shape (auth, validation, outages) still throw ApiError.
 */
export async function careForPet(input: {
  tokenId: string;
  action: string;
  privyToken?: string;
}): Promise<CareActionResult> {
  let res: Response;
  try {
    res = await fetch(`${API_URL}/api/pet/care`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "application/json" },
      body: JSON.stringify(input),
      signal: timeoutSignal(45000),
    });
  } catch {
    throw new ApiError("We could not reach the den. Check your connection and try again.");
  }
  type CareReply = CareActionResult & { error?: string; message?: string; code?: string };
  let data: CareReply;
  try {
    data = await readJson<CareReply>(res);
  } catch (err) {
    if (res.ok) throw err;
    data = {};
  }
  if (!res.ok && !(data.title && data.body)) {
    throw new ApiError(
      data.error || data.message || `Request failed (${res.status}).`,
      res.status,
      data.code,
    );
  }
  return { ...data, ok: res.ok && data.ok !== false, httpStatus: res.status };
}

/** Authenticated add-to-wallet: the signed-in owner's capability pass links. Throws ApiError. */
export async function fetchOwnerPassLink(input: {
  tokenId: string;
  privyToken?: string;
}): Promise<{ applePassUrl?: string; googleSaveUrl?: string }> {
  return postJson<{ applePassUrl?: string; googleSaveUrl?: string }>("/api/pet/pass-link", input);
}

/**
 * Owner-requested link rotation ("Reset my pass links"). Kills every link the pet's current pass
 * carries (the .pkpass download URL and the five care links) and returns the fresh ones. The old
 * card refreshes into a keepsake, so the caller should offer the returned links straight away.
 * Throws ApiError: 403 not the owner, 409 memorial, 429 reset too recently (server message says so).
 */
export async function resetOwnerPassLinks(input: {
  tokenId: string;
  privyToken?: string;
}): Promise<{ ok?: boolean; rotated?: boolean; applePassUrl?: string; googleSaveUrl?: string }> {
  return postJson<{ ok?: boolean; rotated?: boolean; applePassUrl?: string; googleSaveUrl?: string }>(
    `/api/pet/${encodeURIComponent(input.tokenId)}/rotate-links`,
    input.privyToken ? { privyToken: input.privyToken } : {},
  );
}

// ---------------------------------------------------------------------------
// "Gift this pet". The owner names a recipient (the email they sign in with,
// or a wallet address); the den resolves it, records the intent its gas webhook
// will fund, and hands back the transferFrom call the owner's smart account
// executes as a sponsored user operation (lib/aa.ts sponsoredGift). The status
// read settles the gift against a fresh on-chain ownership read.
// ---------------------------------------------------------------------------

export interface GiftPrepared {
  ok?: boolean;
  intentId?: string;
  tokenId?: string;
  from?: string;
  to?: string;
  /** Present when the recipient was resolved from an email. */
  recipientEmail?: string;
  /** The exact call to execute: Pet721.transferFrom(owner, recipient, tokenId). */
  call?: { to?: string; data?: string };
  expiresAt?: string;
  ttlSeconds?: number;
  claimUrl?: string;
}

export interface GiftStatus {
  status?: "prepared" | "approved" | "landed" | "expired";
  tokenId?: string;
  to?: string;
  approvals?: number;
  landedAt?: string;
  claimUrl?: string;
}

/**
 * Prepare a gift. Throws ApiError: 401 sign in, 403 not the owner, 404 unknown pet, 409 memorial,
 * 400 self_gift / recipient_unknown / bad_recipient (the server message says which), 503 the
 * directory or the token contract is unavailable.
 */
export async function prepareGift(input: {
  tokenId: string;
  recipient: string;
  privyToken?: string;
}): Promise<GiftPrepared> {
  return postJson<GiftPrepared>(`/api/pet/${encodeURIComponent(input.tokenId)}/gift/prepare`, {
    recipient: input.recipient,
    ...(input.privyToken ? { privyToken: input.privyToken } : {}),
  });
}

/** Where a prepared gift stands. Null when the den is unreachable (keep polling). */
export async function getGiftStatus(tokenId: string, intentId: string): Promise<GiftStatus | null> {
  return safeGet<GiftStatus>(
    `/api/pet/${encodeURIComponent(tokenId)}/gift/${encodeURIComponent(intentId)}`,
  );
}

// ---------------------------------------------------------------------------
// Player rewards (the v3 RewardsDistributor). 20% of every care flows into
// per-epoch pools shared by active pets; a pet's share is claimable INTO its own
// account. The server reads what is claimable and, on claim, submits the on-chain
// claim itself so the player never signs or pays gas.
//
// The distributor is UNDEPLOYED for now, so this degrades gracefully: the read
// returns { rewardsLive:false } (render a gentle "warming up"), never an error.
// ---------------------------------------------------------------------------

export interface RewardEpoch {
  epoch: number;
  amount: { whole: number; raw: string };
}

export interface PetRewards {
  /** False (or absent) => the distributor is not live yet: render the warming state. */
  rewardsLive?: boolean;
  epochNow?: number;
  claimable?: RewardEpoch[];
  totalClaimableWhole?: number;
  careTokenDecimals?: number;
}

/** GET a pet's claimable rewards. Null when unreachable (keep the last state). */
export async function getPetRewards(tokenId: string): Promise<PetRewards | null> {
  return safeGet<PetRewards>(`/api/pet/${encodeURIComponent(tokenId)}/rewards`);
}

// The rewards CLAIM helper that lived here is gone on purpose (season-2 no-claims
// law, SEASON2-NO-CLAIMS-SPEC.md): rewards are pushed to the pet automatically by
// the game, on every care and on the 2h reward run. The server answers the old
// claim endpoint with 410 rewards_pushed.

export { API_URL };
