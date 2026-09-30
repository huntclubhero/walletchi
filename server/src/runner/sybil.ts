import { createHmac, createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { config } from "../config.js";
import { logger } from "../logger.js";
import type { Store } from "../store/types.js";
import { isDisposableDomain } from "./disposable-domains.js";

// Anti-Sybil compute wall for the free WALLETCHI mint (flag: ANTI_SYBIL_ENABLED).
//
// THREAT MODEL (honest): the mint API is public and the SOLE mint path, so a
// determined attacker calls it directly and skips the browser entirely. Every
// check here is therefore SERVER-SIDE and recomputed from raw inputs; nothing
// trusts a client-asserted "passed" flag. The teeth that survive a direct-API
// attacker: proof-of-work (compute cost per mint, replay-protected), normalized
// email dedup, disposable-domain block, and IP/velocity caps. Fingerprint and
// bot signals are trivially forged in a crafted request, so they only ever add
// cost (rate limits) or catch NAIVE automation (hard block on webdriver), never
// act as sole trust anchors. A patient attacker with residential proxies,
// unlimited real inboxes, and PoW compute still gets through AT COST: this wall
// makes bulk minting expensive, not impossible.
//
// RISK POSTURE: hard-block only high-confidence signals; rate-limit the fuzzy
// ones; log every attempt for tuning. Deterministic checks (PoW, email dedup,
// disposable, honeypot, timing, the atomic reserves) fail CLOSED. The
// infra-dependent velocity reads fail CLOSED wherever real value is at stake and
// fail OPEN only on a value-free deploy, because an attacker can CAUSE a store
// failure and a fail-open cap is a cap that disappears exactly when it is needed.
//
// WHAT KEYS THE SUPPLY WALL: the VERIFIED Privy identity, not an email string.
// Email is still deduped, but on the self-custody path it is only as trustworthy
// as its source, and a wallet-only login attests none at all. See subjectTag.

// ---------------------------------------------------------------------------
// Email normalization + hashing
// ---------------------------------------------------------------------------

/**
 * Canonical form for dedup: lowercase + trim; gmail/googlemail collapse to
 * gmail.com with dots stripped and +tag removed from the local part; every
 * other domain just loses its +tag. Kills the lazy infinite-alias trick.
 */
export function normalizeEmail(email: string): string {
  const trimmed = email.trim().toLowerCase();
  const at = trimmed.lastIndexOf("@");
  if (at < 0) return trimmed;
  let local = trimmed.slice(0, at);
  let domain = trimmed.slice(at + 1);
  if (domain === "googlemail.com") domain = "gmail.com";
  const plus = local.indexOf("+");
  if (plus >= 0) local = local.slice(0, plus);
  if (domain === "gmail.com") local = local.replace(/\./g, "");
  return `${local}@${domain}`;
}

/** Peppered SHA-256 of the normalized email: stored instead of the address. */
export function emailHash(normalizedEmail: string): string {
  return createHmac("sha256", config.SYBIL_PEPPER)
    .update(normalizedEmail)
    .digest("hex");
}

/**
 * Peppered tag for a VERIFIED Privy user id: the mint SUBJECT.
 *
 * WHY A SUBJECT EXISTS AT ALL. Every wall in this file used to key on the email
 * string, and the mint route could not always get a trustworthy one: a wallet-only
 * Privy login attests no email, so the route fell back to the caller's own field
 * and finally to a synthesized `<wallet>@wallet.walletchi.local` that is unique per
 * attacker-generated key BY CONSTRUCTION. One attacker with N self-signed EOAs
 * therefore looked like N keepers to every check here. The verified Privy user id
 * is the one identifier on that path the caller does not choose, so it is what the
 * supply wall and the proof-of-work binding key on.
 *
 * Domain-separated from emailHash ("privy-user:" prefix) so a tag can never collide
 * with an email hash, and peppered so the raw Privy id never reaches the database.
 */
export function subjectTag(privyUserId: string): string {
  return createHmac("sha256", config.SYBIL_PEPPER)
    .update(`privy-user:${privyUserId}`)
    .digest("hex");
}

/**
 * Is this deployment one where a mint is worth stealing? Same fail-secure
 * derivation the routes use (SURVIVAL_ENABLED alone counts), plus mainnet, which
 * is real value whatever the flags say. Read at CALL time, not at import, so a
 * runtime flag flip takes effect immediately.
 */
function realValueAtStake(): boolean {
  return (
    Boolean(config.SURVIVAL_ENABLED) ||
    config.modes.survivalLive ||
    config.ROBINHOOD_NETWORK === "mainnet"
  );
}

/**
 * Must a subject-bearing mint present a challenge that was ISSUED to that subject?
 * Mainnet always, whatever the env says: that is where a drained supply is
 * unrecoverable, and a mainnet launch is a deliberate checklist event rather than
 * something to hope was configured right.
 */
function requireSubjectBinding(): boolean {
  return config.POW_REQUIRE_SUBJECT_BINDING || config.ROBINHOOD_NETWORK === "mainnet";
}

function emailDomain(email: string): string {
  const at = email.lastIndexOf("@");
  return at >= 0 ? email.slice(at + 1).trim().toLowerCase() : "";
}

// Tester allowlist: these keepers bypass the one-per-keeper walls + velocity caps
// so they can mint many pets to exercise wallet-pass states. Stored normalized, so
// gmail dot/plus variants all collapse to the same key.
//
// BOUNDED, AND ON THE SELF-CUSTODY PATH NO LONGER UNVERIFIED. Two things used to
// make this more than a test tool. It was unlimited, so one address was worth the
// whole supply (now capped by TESTER_ALLOWLIST_MINT_CAP, step 6b of the gate). And
// it keyed on whatever email the CALLER typed, so merely knowing an allowlisted
// address bought the bypass; on the self-custody path the mint route now takes the
// email from Privy's attestation only, so claiming an allowlisted address means
// proving control of that inbox to Privy first.
//
// READ FROM ENV, NOT HARDCODED. This used to be two gmail addresses committed in a
// PUBLIC repo, which published the bypass itself: anyone who read the source could
// send one of those addresses (or a +tag / dot variant that normalizes onto it) and
// skip email dedup, the atomic reserve and every velocity cap, one PoW per pet, no
// inbox required. That is a full supply drain by a stranger, on any season where the
// supply is worth anything. The mechanism is fine for a test season; publishing the
// key to it is not. Comma-separated, empty by default.
const TESTER_ALLOWLIST: ReadonlySet<string> = new Set(
  (config.TESTER_ALLOWLIST ?? "")
    .split(",")
    .map((e) => e.trim())
    .filter((e) => e.length > 0)
    .map(normalizeEmail),
);

// SUPPLY-INTEGRITY BOOT GUARD. An allowlisted address skips email dedup, both atomic
// reserves AND every velocity cap. It is now CAPPED rather than unlimited, and on the
// self-custody path the address has to be one Privy attests, but a deliberate hole in
// the supply wall still has no business existing on a mainnet season.
//
// WHAT THIS USED TO KEY ON, AND WHY THAT WAS WRONG. The condition was
//   config.NODE_ENV === "production" && config.ROBINHOOD_NETWORK === "mainnet"
// which required BOTH to be exactly right before it would fire. Either one missing ships the
// bypass live: NODE_ENV is `z.string().default("development")` set only in the Render
// dashboard, so a mainnet launch with NODE_ENV unset or misspelled would have booted happily
// with the allowlist armed. A guard against losing the whole supply must not depend on a
// hand-typed dashboard string being correct.
//
// WHY MAINNET THROWS BUT REAL-VALUE-ON-TESTNET ONLY LOGS. The live testnet season runs with
// real-value care AND a non-empty allowlist on purpose (testers mint many pets to exercise
// wallet-pass states), so keying the throw on realValueAtStake alone would refuse to boot the
// CURRENT production server. Mainnet is the line where the supply is actually worth draining,
// and a mainnet launch is a deliberate checklist event, so mainnet gets the hard refusal and
// everything else gets a loud startup ERROR that cannot be missed in the boot logs.
if (TESTER_ALLOWLIST.size > 0) {
  const msg =
    "TESTER_ALLOWLIST is non-empty. It bypasses the anti-Sybil one-per-keeper walls, both atomic " +
    "reserves and every velocity cap, bounded only by TESTER_ALLOWLIST_MINT_CAP, so anyone who " +
    "reaches an allowlisted inbox mints that many pets past the wall. Unset TESTER_ALLOWLIST " +
    "before a mainnet launch.";
  if (config.ROBINHOOD_NETWORK === "mainnet") {
    throw new Error(`Refusing to boot: ${msg}`);
  }
  if (config.modes.realValueAtStake) {
    logger.error({ allowlistSize: TESTER_ALLOWLIST.size }, `[BOOT GUARD] ${msg}`);
  }
}

// ---------------------------------------------------------------------------
// Proof-of-work (hashcash-style, stateless issue, replay-protected verify)
// ---------------------------------------------------------------------------

export interface PowChallenge {
  nonce: string;
  bits: number;
  exp: number; // unix seconds
  sig: string;
  /** True when the signature also binds a mint subject (see issuePowChallenge). */
  bound: boolean;
}

export interface PowSolution {
  nonce: string;
  counter: string | number;
  sig: string;
  exp: number;
  bits: number;
}

// The challenge signature. An UNBOUND challenge signs exactly what it always did
// (`nonce|bits|exp`), so a challenge already in a browser's hand keeps verifying
// across a deploy; a BOUND one appends the subject tag, which is a fixed-length
// 64-hex string and so cannot smuggle a delimiter into the message.
function powSig(nonce: string, bits: number, exp: number, subject = ""): string {
  const base = `${nonce}|${bits}|${exp}`;
  return createHmac("sha256", config.SYBIL_PEPPER)
    .update(subject ? `${base}|${subject}` : base)
    .digest("hex");
}

/**
 * Issue a challenge, optionally BOUND to a mint subject. Stateless: the HMAC
 * signature binds nonce + difficulty + expiry (+ subject), so the server needs no
 * per-challenge storage until redemption.
 *
 * WHY BINDING. Unbound, a solved challenge was a bearer token for ANY identity:
 * the preimage is just `nonce:counter` and nothing tied it to who redeemed it, so
 * the compute could be farmed anywhere cheap (or precomputed off an anonymous
 * endpoint) and spent against whichever identity the attacker liked. With the
 * subject inside the signature, a challenge issued to identity A does not verify
 * for identity B: the recomputed HMAC simply does not match.
 */
export function issuePowChallenge(subject = "", now = new Date()): PowChallenge {
  const nonce = randomBytes(16).toString("hex");
  const bits = config.POW_DIFFICULTY_BITS;
  const exp = Math.floor(now.getTime() / 1000) + config.POW_TTL_SECONDS;
  return { nonce, bits, exp, sig: powSig(nonce, bits, exp, subject), bound: subject.length > 0 };
}

/** Count leading zero BITS of a hash buffer. */
export function leadingZeroBits(hash: Buffer): number {
  let bits = 0;
  for (const byte of hash) {
    if (byte === 0) {
      bits += 8;
      continue;
    }
    for (let mask = 0x80; mask > 0; mask >>= 1) {
      if (byte & mask) return bits;
      bits++;
    }
    return bits;
  }
  return bits;
}

// Redeemed nonces (single use). In-memory with TTL pruning, same pattern as the
// claim-nonce store: entries expire with the challenge itself, so the set stays
// bounded. A multi-instance deployment would move this to the DB; one Render
// instance serves the mint today.
const usedNonces = new Map<string, number>(); // nonce -> exp ms

function pruneUsedNonces(nowMs: number): void {
  for (const [nonce, expMs] of usedNonces) {
    if (expMs <= nowMs) usedNonces.delete(nonce);
  }
}

export type PowVerdict =
  | { ok: true; issuedAtMs: number; boundToSubject: boolean }
  | {
      ok: false;
      reason: "missing" | "invalid" | "expired" | "replayed" | "insufficient" | "unbound";
    };

function sigMatches(given: string, expected: string): boolean {
  try {
    return (
      given.length === expected.length &&
      timingSafeEqual(Buffer.from(given), Buffer.from(expected))
    );
  } catch {
    return false;
  }
}

/**
 * Verify a PoW solution from raw inputs: signature (covers nonce|bits|exp|subject
 * so the client can neither lower its own difficulty nor spend another identity's
 * solve), expiry, difficulty target, and single-use nonce redemption (replay
 * protection). Marks the nonce used ONLY when everything else passes, so a failed
 * attempt does not burn the challenge.
 *
 * `subject` is the tag of the verified identity this mint is FOR (empty when the
 * mint has no verified identity, e.g. the custodial demo path).
 */
export function verifyPow(
  pow: PowSolution | undefined,
  subject = "",
  now = new Date(),
): PowVerdict {
  if (!pow || typeof pow.nonce !== "string" || pow.nonce.length === 0) {
    return { ok: false, reason: "missing" };
  }
  const nowMs = now.getTime();
  pruneUsedNonces(nowMs);

  // The signed difficulty must be at least the CURRENT config difficulty, so a
  // replayed old low-difficulty challenge cannot undercut a raised bar.
  if (!Number.isInteger(pow.bits) || pow.bits < config.POW_DIFFICULTY_BITS) {
    return { ok: false, reason: "invalid" };
  }
  if (!Number.isInteger(pow.exp)) return { ok: false, reason: "invalid" };
  const given = typeof pow.sig === "string" ? pow.sig : "";
  // Two acceptable shapes, and ONLY two: a challenge issued to THIS subject, or an
  // anonymous one issued to nobody. A challenge issued to a DIFFERENT subject
  // matches neither, so cross-identity redemption fails here unconditionally, with
  // no flag involved. The unbound shape is the compatibility case (the shipped web
  // client asks for its challenge before it can present a token) and is refused
  // outright wherever the supply is worth draining; see requireSubjectBinding.
  let boundToSubject: boolean;
  if (subject && sigMatches(given, powSig(pow.nonce, pow.bits, pow.exp, subject))) {
    boundToSubject = true;
  } else if (sigMatches(given, powSig(pow.nonce, pow.bits, pow.exp))) {
    boundToSubject = false;
  } else {
    return { ok: false, reason: "invalid" };
  }
  if (subject && !boundToSubject && requireSubjectBinding()) {
    return { ok: false, reason: "unbound" };
  }
  if (pow.exp * 1000 <= nowMs) return { ok: false, reason: "expired" };

  const hash = createHash("sha256").update(`${pow.nonce}:${pow.counter}`).digest();
  if (leadingZeroBits(hash) < pow.bits) return { ok: false, reason: "insufficient" };

  if (usedNonces.has(pow.nonce)) return { ok: false, reason: "replayed" };
  usedNonces.set(pow.nonce, pow.exp * 1000);

  // The challenge was issued at exp - TTL: a server-side floor for submit
  // timing that a direct-API caller cannot fake (unlike client elapsedMs).
  return {
    ok: true,
    issuedAtMs: pow.exp * 1000 - config.POW_TTL_SECONDS * 1000,
    boundToSubject,
  };
}

/** Test hook: clear the redeemed-nonce set between smoke sections. */
export function _resetSybilState(): void {
  usedNonces.clear();
}

// ---------------------------------------------------------------------------
// The risk gate
// ---------------------------------------------------------------------------

export interface MintGateInput {
  email: string;
  ip: string;
  subnet: string;
  /**
   * Tag of the VERIFIED Privy identity behind this mint (subjectTag), empty when
   * the mint has no verified identity. THE supply wall keys on this, because it is
   * the only part of a self-custody mint the caller cannot choose.
   */
  subject?: string;
  fingerprint?: string;
  honeypot?: string;
  elapsedMs?: number;
  botSignals?: Record<string, unknown>;
  pow?: PowSolution;
  /** Turnstile response token from the mint page widget (required when captchaLive). */
  captchaToken?: string;
}

export type MintBlockCode =
  | "already_minted"
  | "pow_required"
  | "pow_invalid"
  | "disposable_email"
  | "bot_detected"
  | "too_fast"
  // `too_many` now means ONLY the allowlist ceiling. The three velocity signals
  // used to share it, so a refused keeper and the logs both saw one
  // indistinguishable code and could not tell WHICH cap fired: that is why the
  // iPhone fingerprint collision needed a user to report it instead of showing
  // up in a log line. They are split out below.
  | "too_many"
  | "too_many_ip"
  | "too_many_subnet"
  | "too_many_fingerprint"
  // Turnstile (STEP 8C). An EXPLICIT challenge like PoW, not a fuzzy signal, so
  // blocking on it is correct and the advisory law does not apply: an honest
  // keeper can always complete a captcha, and it costs the same on every device.
  | "captcha_required"
  | "captcha_invalid"
  | "sybil_blocked";

export interface MintGateBlock {
  ok: false;
  status: number;
  code: MintBlockCode;
  message: string; // kind, non-revealing copy for the form
}

export type MintGateResult =
  // velocityFlags: signals that EXCEEDED their advisory threshold but did not
  // refuse the mint. Empty on a clean mint. The caller folds them into the
  // MintSignal forensics record so a cluster is reviewable after the fact, which
  // is the job these signals are actually good at.
  | { ok: true; emailHash: string; privyUserHash: string | null; velocityFlags: string[] }
  | MintGateBlock;

// Kind, non-revealing copy. We never spell out WHICH signal tripped beyond the
// broad category (do not teach the attacker), but a real user always gets a
// warm, actionable sentence.
const BLOCK_COPY: Record<MintBlockCode, { status: number; message: string }> = {
  already_minted: {
    status: 403,
    message:
      "You already have a WALLETCHI on this sign-in, device or email. It is one per keeper.",
  },
  pow_required: {
    status: 403,
    message: "Your browser needs a moment to ready the egg. Please try again.",
  },
  pow_invalid: {
    status: 403,
    message: "We could not verify that mint. Please refresh the page and try again.",
  },
  disposable_email: {
    status: 403,
    message: "Please use a personal email address so your pet can always find its way home.",
  },
  bot_detected: {
    status: 403,
    message: "We could not verify this mint. Please try again from a regular browser.",
  },
  too_fast: {
    status: 403,
    message: "Whoa, quick fingers! Take a breath and try again in a moment.",
  },
  too_many: {
    status: 429,
    message: "This den has hatched a lot of eggs from your network today. Please try again later.",
  },
  // Distinct codes so a support report ("it says X") identifies the cap without a
  // code dive. Copy stays non-revealing: it never tells a prober which signal it
  // tripped, only that it should try later.
  too_many_ip: {
    status: 429,
    message: "This den has hatched a lot of eggs from your network today. Please try again later.",
  },
  too_many_subnet: {
    status: 429,
    message: "This den has hatched a lot of eggs from your network today. Please try again later.",
  },
  too_many_fingerprint: {
    status: 429,
    message: "This den has hatched a lot of eggs from your device today. Please try again later.",
  },
  captcha_required: {
    status: 403,
    message: "One quick check first: complete the verification on the page, then mint again.",
  },
  captcha_invalid: {
    status: 403,
    message: "That verification did not go through. Refresh the page and try the check once more.",
  },
  sybil_blocked: {
    status: 403,
    message: "We could not complete this mint right now. Please try again in a little while.",
  },
};

/** The block payload for a code (also used by gate-adjacent guards in routes). */
export function blockFor(code: MintBlockCode): MintGateBlock {
  const { status, message } = BLOCK_COPY[code];
  return { ok: false, status, code, message };
}
const block = blockFor;

// --- Turnstile captcha verification (STEP 8C) -------------------------------
// The transport is injectable so the smoke suite can exercise the gate branch
// without Cloudflare (same pattern as the Privy directory mock). null = the
// real siteverify endpoint.
type TurnstileTransport = (form: URLSearchParams) => Promise<{ success?: boolean }>;
let turnstileTransport: TurnstileTransport | null = null;
export function _setTurnstileTransportForTests(t: TurnstileTransport | null): void {
  turnstileTransport = t;
}
const TURNSTILE_VERIFY_URL = "https://challenges.cloudflare.com/turnstile/v0/siteverify";

/** True when Cloudflare confirms the token. Throws on transport failure (the
 *  caller decides fail-open vs fail-closed; a thrown error is an OUTAGE, never
 *  a verdict about the token). */
async function verifyTurnstile(token: string, ip: string): Promise<boolean> {
  const form = new URLSearchParams({
    secret: config.TURNSTILE_SECRET_KEY ?? "",
    response: token,
  });
  if (ip) form.set("remoteip", ip);
  if (turnstileTransport) return (await turnstileTransport(form)).success === true;
  const res = await fetch(TURNSTILE_VERIFY_URL, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: form.toString(),
  });
  if (!res.ok) throw new Error(`turnstile siteverify HTTP ${res.status}`);
  return ((await res.json()) as { success?: boolean }).success === true;
}

/**
 * Evaluate one mint attempt. Order: cheap deterministic hard-blocks first
 * (honeypot, automation, subject-bound PoW, timing, disposable, email dedup read,
 * allowlist ceiling), then the velocity caps, then the two ATOMIC reserves as the
 * final steps: the inbox, and then the VERIFIED IDENTITY, which is the wall the
 * fixed supply actually rests on. Nothing runs after them, so a mint that reserves
 * always gets its pet. Every decision is recomputed here from raw inputs.
 */
export async function evaluateMintGate(
  store: Store,
  input: MintGateInput,
  now = new Date(),
): Promise<MintGateResult> {
  // 1. Honeypot: the hidden input a human never sees, let alone fills.
  if (typeof input.honeypot === "string" && input.honeypot.trim().length > 0) {
    return block("bot_detected");
  }

  // 2. Automation self-report: navigator.webdriver is set by real automation
  // stacks (Selenium/Playwright/Puppeteer default). A crafted direct call just
  // omits it, which is fine: this catches the NAIVE script tier only.
  const signals = input.botSignals ?? {};
  if (signals["webdriver"] === true) return block("bot_detected");

  // 3. Proof-of-work: the compute cost per mint. Verified from raw inputs
  // (signature, expiry, difficulty, single-use nonce) and BOUND to this mint's
  // subject, so a solve farmed against one identity cannot be spent for another.
  // Fail closed.
  const subject = input.subject ?? "";
  const pow = verifyPow(input.pow, subject, now);
  if (!pow.ok) {
    return block(pow.reason === "missing" ? "pow_required" : "pow_invalid");
  }
  if (subject && !pow.boundToSubject) {
    // Accepted for now (the shipped web client fetches its challenge before it
    // can present a Privy token), but this is the compatibility path, not the
    // intended one, and requireSubjectBinding() closes it on mainnet.
    logger.warn(
      "mint redeemed an UNBOUND pow challenge for a verified identity; the client should send its Privy token to GET /api/mint/challenge",
    );
  }

  // 4. Submit timing. Server-side floor from the challenge issue time (a direct
  // caller cannot fake it), plus the client-reported elapsedMs when present
  // (naive scripts report their own haste honestly).
  const minMs = config.MINT_MIN_ELAPSED_MS;
  if (minMs > 0) {
    if (now.getTime() - pow.issuedAtMs < minMs) return block("too_fast");
    if (typeof input.elapsedMs === "number" && input.elapsedMs < minMs) {
      return block("too_fast");
    }
  }

  // 5. Disposable-domain block (deterministic, bundled list).
  if (isDisposableDomain(emailDomain(input.email))) return block("disposable_email");

  // 6. Normalized-email dedup FAST PATH (read-only, keeps the block code
  // accurate even when a velocity cap would also trip). The atomic wall is
  // step 8. A store failure here fails CLOSED (deterministic wall).
  const hash = emailHash(normalizeEmail(input.email));
  // Tester allowlist bypasses the dedup / velocity / reserves so a tester can mint
  // repeatedly; the bot / PoW / timing / disposable checks above still apply, and
  // step 6b puts a hard ceiling on the bypass.
  const allowlisted = TESTER_ALLOWLIST.has(normalizeEmail(input.email));
  try {
    if (!allowlisted && (await store.emailAlreadyMinted(hash))) return block("already_minted");
  } catch (err) {
    logger.error({ err: String(err) }, "sybil email-dedup read failed (failing closed)");
    return block("sybil_blocked");
  }

  // 6b. ALLOWLIST CEILING. The allowlist is a deliberate testnet tool, but it used
  // to be UNBOUNDED: an allowlisted address skipped the dedup read, the atomic
  // reserve and every velocity cap, so one address was worth the entire supply to
  // anyone who learned it. The wrong assumption was that "trusted tester" implies
  // "no limit needed"; a bypass with no ceiling is a whole-supply hole whatever we
  // call it. Testers get a generous, finite budget instead. Fails CLOSED: this is a
  // wall, not a rate-limit signal.
  if (allowlisted) {
    try {
      if ((await store.countMintedByEmailHash(hash)) >= config.TESTER_ALLOWLIST_MINT_CAP) {
        return block("too_many");
      }
    } catch (err) {
      logger.error({ err: String(err) }, "sybil allowlist cap read failed (failing closed)");
      return block("sybil_blocked");
    }
  }

  // 6c. CAPTCHA (Turnstile, STEP 8C). Armed only when captchaLive (full key
  // pair). An EXPLICIT challenge like PoW, so blocking is correct: an honest
  // keeper can always complete it, on any device, which is exactly what the
  // fingerprint could not offer. Runs AFTER the cheap deterministic checks (it
  // costs a network round-trip, so a mint that would fail dedup anyway never
  // burns one) and BEFORE the atomic reserves (nothing runs after those).
  // Deliberately NOT skipped for allowlisted testers: the allowlist already
  // bypasses both reserves, and gates are not widened speculatively.
  if (config.modes.captchaLive) {
    if (!input.captchaToken) return block("captcha_required");
    try {
      if (!(await verifyTurnstile(input.captchaToken, input.ip))) {
        return block("captcha_invalid");
      }
    } catch (err) {
      // Same posture as the velocity read: a siteverify OUTAGE (not a verdict)
      // fails closed only where the mint is worth stealing, because an attacker
      // gains nothing from our egress failing on a value-free deploy while
      // honest minters would lose their mint window.
      const failClosed = realValueAtStake();
      logger.error(
        { err: String(err), realValue: failClosed },
        failClosed
          ? "turnstile siteverify unreachable (failing CLOSED: real value at stake)"
          : "turnstile siteverify unreachable (failing OPEN: no real value at stake)",
      );
      if (failClosed) return block("sybil_blocked");
    }
  }

  // 7. Velocity signals: IP, /24 subnet, fingerprint. ADVISORY BY DEFAULT.
  //
  // These are fuzzy by nature (shared wifi, carrier NAT, family devices,
  // spoofable headers) and the code has always described them as rate-limit
  // signals rather than walls, but they were implemented as hard refusals. That
  // cost real keepers: the device fingerprint is MODEL-level on iOS, so two
  // people in one city on the same iPhone hash identically and the second one
  // could not mint. The deeper problem is that no threshold fixes this, because
  // the same count means "one attacker" or "forty real neighbours" and the
  // signal cannot tell them apart. Since an attacker randomizes both for free
  // while an honest keeper cannot change either, blocking on them only ever
  // refuses honest people.
  //
  // So: always COUNT, always FLAG (the flags ride into the MintSignal forensics
  // record), and only REFUSE when VELOCITY_CAPS_ENFORCED is explicitly on.
  // Clusters stay visible for review; they just stop being a gate. The supply
  // wall is the two atomic reserves in steps 8 and 9, and floods are handled by
  // the HTTP rate limiter and PoW.
  const velocityFlags: string[] = [];
  try {
    const since = new Date(now.getTime() - 24 * 3600 * 1000);
    const [byIp, bySubnet, byFp] = await Promise.all([
      store.countByIpSince(input.ip, since),
      store.countBySubnetSince(input.subnet, since),
      input.fingerprint
        ? store.countByFingerprintSince(input.fingerprint, since)
        : Promise.resolve(0),
    ]);
    const overIp = byIp >= config.MINTS_PER_IP_PER_DAY;
    const overSubnet = bySubnet >= config.MINTS_PER_SUBNET_PER_DAY;
    const overFp = Boolean(input.fingerprint) && byFp >= config.FINGERPRINT_MINT_CAP;
    if (overIp) velocityFlags.push(`ip=${byIp}`);
    if (overSubnet) velocityFlags.push(`subnet=${bySubnet}`);
    if (overFp) velocityFlags.push(`fp=${byFp}`);
    if (velocityFlags.length) {
      logger.warn(
        { ip: input.ip, subnet: input.subnet, byIp, bySubnet, byFp, enforced: config.VELOCITY_CAPS_ENFORCED },
        config.VELOCITY_CAPS_ENFORCED
          ? "velocity cap exceeded (ENFORCED: refusing the mint)"
          : "velocity cap exceeded (advisory: flagging, not blocking)",
      );
    }
    if (config.VELOCITY_CAPS_ENFORCED && !allowlisted) {
      if (overIp) return block("too_many_ip");
      if (overSubnet) return block("too_many_subnet");
      if (overFp) return block("too_many_fingerprint");
    }
  } catch (err) {
    // FAIL CLOSED WHERE THE MINT IS WORTH STEALING. The old comment ("infra
    // failures fail OPEN with a log") was reasoned about the caps as fuzzy
    // signals, and for a fuzzy signal failing open is right. What it missed is
    // that an attacker can CAUSE the failure: hammer the mint endpoint hard
    // enough that the velocity reads time out and every cap silently stops
    // existing, exactly during the burst they were built to stop. A store
    // outage must cost a real-value season a few refused mints, never the
    // supply. Dev and value-free testnet deploys still fail open, so a local
    // Postgres hiccup is not fatal to a demo.
    //
    // THAT REASONING ONLY APPLIES WHILE THE CAPS ACTUALLY BLOCK. Under the
    // advisory default there is no cap to suppress, so a failed read costs an
    // attacker nothing and refusing here would just turn a store blip into
    // refused honest mints. So fail closed only when enforcement is ON (and real
    // value is at stake); otherwise drop the flags and carry on.
    const failClosed = config.VELOCITY_CAPS_ENFORCED && realValueAtStake();
    logger.error(
      { err: String(err), realValue: realValueAtStake(), enforced: config.VELOCITY_CAPS_ENFORCED },
      failClosed
        ? "sybil velocity read failed (failing CLOSED: enforced + real value at stake)"
        : "sybil velocity read failed (advisory or no real value: continuing without flags)",
    );
    if (failClosed) return block("sybil_blocked");
  }

  // 8. ATOMIC email reserve: the one-inbox-one-pet wall. Backed by a unique
  // constraint (Prisma) / synchronous has-then-add (memory): two concurrent
  // same-email requests can never both pass, closing the check-then-act race the
  // step-6 read alone would leave open. Store errors fail CLOSED (deterministic
  // wall).
  try {
    if (!allowlisted && !(await store.reserveEmail(hash))) return block("already_minted");
  } catch (err) {
    logger.error({ err: String(err) }, "sybil email reserve failed (failing closed)");
    return block("sybil_blocked");
  }

  // 9. ATOMIC identity reserve: THE one-verified-keeper-one-pet wall, and the
  // only one on the self-custody path that keys on something the caller cannot
  // choose. Step 8 alone was defeated by simply not having an email: a wallet-only
  // Privy login attests none, the route synthesized one per wallet address, and N
  // free self-signed EOAs read as N keepers. Same race-safety pattern as step 8
  // (unique-constraint insert / synchronous has-then-add), so two concurrent mints
  // from one Privy session can never both pass. Runs LAST, so nothing after it can
  // block and a reserved identity always gets its pet.
  //
  // COMPENSATION, NOT A LEAK: if this refuses, the email claimed one line above
  // must be handed back, or an identity that changed its Privy email between
  // attempts would strand that fresh inbox reserved-forever with no pet. The
  // release is safe precisely because the claim was FRESH in this request (step 6
  // proved the hash had no prior mint), so it can only ever undo our own insert.
  let privyUserHash: string | null = null;
  if (subject && !allowlisted) {
    const undoEmail = async () => {
      try {
        await store.releaseEmail(hash);
      } catch (relErr) {
        logger.error({ err: String(relErr) }, "sybil email reserve rollback failed");
      }
    };
    try {
      if (!(await store.reservePrivyUser(subject))) {
        await undoEmail();
        return block("already_minted");
      }
      privyUserHash = subject;
    } catch (err) {
      logger.error({ err: String(err) }, "sybil identity reserve failed (failing closed)");
      await undoEmail();
      return block("sybil_blocked");
    }
  }

  return { ok: true, emailHash: hash, privyUserHash, velocityFlags };
}

/** Compact the bot-signals object for the forensics record. */
export function botFlagsLabel(signals: Record<string, unknown> | undefined): string | null {
  if (!signals) return null;
  try {
    const s = JSON.stringify(signals);
    return s.length > 500 ? s.slice(0, 500) : s;
  } catch {
    return null;
  }
}
