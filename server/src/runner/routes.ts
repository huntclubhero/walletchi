import { Router } from "express";
import { randomBytes, randomUUID } from "node:crypto";
import { z } from "zod";
import { config } from "../config.js";
import { logger } from "../logger.js";
import type { AppContext } from "../context.js";
import type { Runner } from "../store/types.js";
import { fulfillRunner, mintQueueInfo } from "./fulfillment.js";
import { generateRunnerPkpass, runnerPassDownloadUrl } from "./pass.js";
import { petCardPng, petPortraitPng, petHeroPng, brandLogoPng, RenderBusyError } from "./pet.js";
import { getRunnerGoogle, recordWalletCallback } from "./google.js";
import { reconcilePet, reconcileOnChainCare, careHatchedThePet, chainCareCountOf } from "./idle.js";
import { confirmPage, interstitialPage, isCareAction, type CareAction } from "./actions.js";
import { careScene, hatchScene } from "./scenes.js";
import { sessionVerdict, submitSessionCare, type CareFailureKind } from "./session-care.js";
import { signTag, verifyTag, actionPayload, verifyPassDownloadCap } from "./sign.js";
import { moodFor, NEED_GLYPHS } from "./needs.js";
import { verifyPrivyToken, lookupPrivyUserEmail, getPrivyUserWallets } from "../services/privy.js";
import { RUNNER_THEME, runnerNumber } from "./theme.js";
import {
  refreshSeasonSnapshot,
  formatCareToken,
  getSeasonSnapshot,
  memorialLivedDays,
  outlastedFromRank,
  passStatsFrom,
  getVaultConfig,
  cachedPetNeeds,
  petNeedPctFor,
  petNeedSecondsLeftFor,
  petCareBalanceFor,
  needsSecondsLeft,
  careCooldownSecondsLeft,
  getSeasonGate,
  NEED_ACTIONS,
  NEED_LABELS,
  CARE_ACTION_TYPE,
} from "./season.js";
import { traitAttributes } from "./traits.js";
import { petName } from "./names.js";
import { MINT_BUSY_PREFIX, admitMint } from "./mint-budget.js";
import { stageFor, petVisualFor } from "./stage.js";
import { STAGE_NAMES } from "./theme.js";
import { petLiveStatus, careOwnerGuard } from "./claim.js";
import { issueMintSession, resolveMintSession } from "./mint-session.js";
import { recordCareOpened, recordCarePerformed } from "./care-metrics.js";
import { clientIp, subnetOf } from "../util/client-ip.js";
import { wrap } from "../util/async-handler.js";
import {
  issuePowChallenge,
  evaluateMintGate,
  botFlagsLabel,
  blockFor,
  normalizeEmail,
  emailHash,
  subjectTag,
  type PowSolution,
} from "./sybil.js";
import { setupNudgeFor } from "./setup-nudge.js";

// Confirmation copy for a silent pass-tap care, one entry per action. FIVE
// NEEDS: each action IS a need, so `stat` is that need's own meter (canonical
// labels), the copy names the refilled need, and a successful care shows it
// at 100%. `from` maps from the DB meters (feed=hunger, water=thirst, the
// three joy needs share the joy meter).
//
// The GLYPH is never written here: it comes from NEED_GLYPHS, the canonical set
// the wallet card renders. This page used to draw feed as 🍖, play as 🎈 and
// explore as 🐾, so the confirmation for a tap looked like a different action
// than the button the keeper had just pressed.
const CARE_CONFIRM: Record<
  CareAction,
  { title: string; body: string; emoji: string; stat: "Feed" | "Water" | "Play" | "Toy" | "Explore" }
> = {
  feed: { title: "Yum!", body: "Food refilled. Your pet gobbled it right up.", emoji: NEED_GLYPHS[0], stat: "Feed" },
  water: { title: "Refreshing!", body: "Water refilled. Your pet lapped it up and perked right up.", emoji: NEED_GLYPHS[1], stat: "Water" },
  play: { title: "Wheee!", body: "Play refilled. You played together and your pet bounced with joy.", emoji: NEED_GLYPHS[2], stat: "Play" },
  toy: { title: "New toy!", body: "Toy time refilled. Your pet adores its new toy and shows it off.", emoji: NEED_GLYPHS[3], stat: "Toy" },
  explore: { title: "Off exploring!", body: "Exploring refilled. Your pet padded around and found something delightful.", emoji: NEED_GLYPHS[4], stat: "Explore" },
};

// The present-tense title shown over the animated scene while a care lands on-chain.
const CARE_LOADING: Record<CareAction, string> = {
  feed: "Feeding your pet",
  water: "Watering your pet",
  play: "Playing together",
  toy: "Sharing a toy",
  explore: "Off exploring",
};

// Map a session-care failure onto an errPage(...) argument tuple. The caller
// handles "permission" (retire and fall back), "validation" and "unreadable"
// (fall back WITHOUT retiring) and "pending" (accepted, still confirming), so
// none of those reach here.
function careFailurePage(kind: CareFailureKind): [number, string, string, string] {
  switch (kind) {
    case "cooldown":
      // Overwritten at the call site with the exact seconds remaining. This is the fallback for
      // when that read is unavailable.
      return [429, "Just fed", "Your pet is still full from its last meal. Try again in a moment.", "✅"];
    case "dead":
      return [409, "This pet has passed on", "Its story is complete. It lives on its page forever.", "🌙"];
    case "over":
      return [409, "The season is decided", "The last pet standing has been found. Caring is closed.", "🏁"];
    case "not_owner":
      return [403, "This pet has a new home", "This pet moved to a new wallet. Claim it to care for it.", "🔒"];
    case "needs_tokens":
      // Retrying will never fix this, so do not say "try again". The care cost is
      // pulled from the pet's OWN account and that account has run dry.
      return [402, "Needs care tokens", "Your pet's account is low on care tokens. Top it up (send tokens to its address) to keep caring for it.", "🪙"];
    case "spender_revoked":
      // Irreversible on-chain: revokeSpender() leaves spenderInitialized true, so the issuer can never
      // be re-appointed and this pet can never be fed by anyone again. Do not offer hope and do not
      // suggest a top-up, which would send the keeper to spend money on an unrecoverable pet.
      return [409, "This pet cannot be fed", "Its account gave up the right to spend, and that cannot be undone. Anything added to it can never be used.", "🔒"];
    case "capped":
      return [429, "That is enough for today", "Your pet has hit its spending limit for now. It will be ready again soon.", "🪙"];
    default:
      return [502, "Could not care right now", "That did not go through on-chain. Your pet is fine. Please try again in a moment.", "⏳"];
  }
}

// One silent care SUBMISSION in flight per pet. Without this a double tap (or an
// interstitial that submits twice) puts two ops in the same nonce window: both
// pass estimation, one lands, and the paymaster pays for the other reverting
// after inclusion. Mirrors the inFlightMints pattern below. The value is the
// ACTION in flight, so a duplicate tap of the same need can be told apart from
// the honest next-need tap of the five-tap ritual.
const inFlightCare = new Map<string, string>();

// NO DOUBLE-CHARGE (audit #2). At the shipped careCooldown = 0 the vault happily
// accepts the SAME need twice back to back, so the server is the only layer that
// can dedup a double tap: without this stamp, a second tap parked on the D6
// waiting page auto-retries the same signed link after the first care lands and
// spends careCost a SECOND time. Once a care for (pet, need) is known to be
// charged (a confirmed land, or a bundler-accepted "pending" that will land),
// any further tap on that same pair inside the window is answered with a 200
// "already taken care of" page and NEVER reaches the chain. Two call sites
// check it: a cheap early check before any RPC, and a synchronous re-check in
// the same tick as the in-flight latch, which closes the race where a second
// tap passed the early check while the first flight was still landing. The
// window comfortably covers the waiting loop's worst case (10 retries x 3s)
// plus a slow flight, and there is no honest reason to re-serve a need that
// was set to 100 percent under a minute ago.
const CARE_DEDUP_WINDOW_MS = 60_000;
const recentCareCharged = new Map<string, number>(); // `${serial}:${action}` -> charged-at ms

/** Stamp a (pet, need) as charged on-chain (landed or bundler-accepted). */
export function markCareCharged(serial: string, action: string): void {
  if (recentCareCharged.size > 16000) recentCareCharged.clear(); // bounded; keys are ours, not caller-supplied
  recentCareCharged.set(`${serial}:${action}`, Date.now());
}

/** True when this (pet, need) was charged inside the dedup window: a new tap is a duplicate. */
export function careRecentlyCharged(serial: string, action: string): boolean {
  const at = recentCareCharged.get(`${serial}:${action}`);
  return at !== undefined && Date.now() - at < CARE_DEDUP_WINDOW_MS;
}

// Per-PET-per-NEED care attempt limit. The global limiter is per-IP, which bounds nothing
// against a distributed drain. FIVE NEEDS: the honest ritual is five DIFFERENT actions
// back to back (the vault's cooldown is per need and ships at 0), so the throttle keys on
// `${serial}:${action}`: five honest different-need taps never throttle, while a leaked
// link drains at most 3 attempts per need per window (15/min/pet, still far under the
// on-chain dailyCap brake). Every attempt past that costs us a fresh ownerOf read, a KDF
// and an Alchemy round trip even when the vault is going to reject it.
const CARE_ATTEMPT_WINDOW_MS = 60_000;
const CARE_ATTEMPTS_PER_WINDOW = 3; // per need; leaves room for honest retries
const careAttempts = new Map<string, { windowStart: number; count: number }>();

/** True when this pet+need has had too many care attempts in the current window. */
export function careAttemptThrottled(serial: string, action: string): boolean {
  const now = Date.now();
  const key = `${serial}:${action}`;
  const cur = careAttempts.get(key);
  if (!cur || now - cur.windowStart >= CARE_ATTEMPT_WINDOW_MS) {
    if (careAttempts.size > 16000) careAttempts.clear(); // bounded; serials+actions are ours, not caller-supplied
    careAttempts.set(key, { windowStart: now, count: 1 });
    return false;
  }
  cur.count += 1;
  return cur.count > CARE_ATTEMPTS_PER_WINDOW;
}

// (The per-pet rewards-claim flight latch that used to live here is gone with the
// claim surfaces it guarded. It existed because two user-triggered claim paths
// shared the relayer write queue and a duplicate tap burned gas on a certain
// revert. Season 2 has no user-triggered reward write at all: the 2h push engine
// is the only caller, and it holds its own in-flight latch.)

// Test hooks for the smoke: drive the throttle keying, the in-flight waiting
// page, and the no-double-charge dedup deterministically without a live bundler.
export function _careThrottleReset(): void {
  careAttempts.clear();
}
export function _careInFlight(): Map<string, string> {
  return inFlightCare;
}
export function _careDedupReset(): void {
  recentCareCharged.clear();
}

// TOCTOU guard for the anti-Sybil email dedup: the dedup is a store READ and
// the "minted" record lands several awaits later, so N parallel requests with
// the same email (each with its own valid PoW) could all pass the read before
// the first record persists. Same in-process pattern as inFlightRuns below.
const inFlightMints = new Set<string>();

// Supply-cap TOCTOU guard: countRunners() and createRunner() are separated by
// several awaits (Privy verify, the sybil gate), so a parallel burst at 1999
// could over-mint past RUNNER_SUPPLY_CAP. The authoritative count-then-create
// runs inside this in-process serial section (one Render instance serves the
// mint; the early count check stays as the cheap fast path).
let mintCapChain: Promise<unknown> = Promise.resolve();
function withMintCapLock<T>(task: () => Promise<T>): Promise<T> {
  const run = mintCapChain.then(task);
  mintCapChain = run.catch(() => undefined);
  return run;
}

const CheckoutBody = z.object({
  email: z.string().email("invalid email").optional(),
  walletAddress: z.string().regex(/^0x[0-9a-fA-F]{40}$/, "invalid EVM address").optional(),
  privyToken: z.string().optional(),
  // Anti-Sybil inputs (all optional so the flag-off path is byte-identical).
  // These are INPUTS the server re-verifies, never trusted assertions.
  fingerprint: z.string().max(128).optional(),
  honeypot: z.string().max(256).optional(),
  elapsedMs: z.number().int().nonnegative().optional(),
  botSignals: z.record(z.unknown()).optional(),
  pow: z
    .object({
      nonce: z.string().max(64),
      counter: z.union([z.string().max(32), z.number().int().nonnegative()]),
      sig: z.string().max(128),
      exp: z.number().int(),
      bits: z.number().int(),
    })
    .optional(),
  // Turnstile response token (STEP 8C). Optional so the captcha-off path is
  // byte-identical; the gate demands it only when captchaLive.
  captchaToken: z.string().max(4096).optional(),
});

// Human "Life Left" label for metadata attributes, e.g. "2d 4h" / "3h 12m".
function lifeLeftLabel(secondsLeft: number): string {
  const s = Math.max(0, Math.floor(secondsLeft));
  const d = Math.floor(s / 86_400);
  const h = Math.floor((s % 86_400) / 3600);
  const m = Math.floor((s % 3600) / 60);
  if (d > 0) return `${d}d ${h}h`;
  if (h > 0) return `${h}h ${m}m`;
  return `${m}m`;
}

// Real-value care is possible (or intended) for this deployment. Fail-secure:
// SURVIVAL_ENABLED alone counts even when the vault env is incomplete, so a
// half-configured mainnet deployment never re-opens the public pass download.
// Read at request time so a runtime flag flip takes effect immediately.
function realValueCarePossible(): boolean {
  return Boolean(config.SURVIVAL_ENABLED) || config.modes.survivalLive;
}

function runnerStatusView(runner: Runner, opts: { relayerAddress?: string } = {}) {
  const explorer = config.robinhood.explorer;
  // The pass download URL is a CAPABILITY (unguessable without the pet's
  // authToken). This view is served on public serial-keyed endpoints, so while
  // real-value care is possible the URL is withheld here: owners get it from
  // the mint email or the ownership-proven /api/claim response instead.
  const passUrl = realValueCarePossible()
    ? null
    : runnerPassDownloadUrl(runner.serial, runner.authToken);
  // Custodial = the pet is owned by the server's relayer wallet (an email-only
  // mint the user cannot sign care for), as opposed to a self-custody pet in
  // the user's own wallet. The web care page uses this to explain why an
  // owner-signed care is not possible for a custodial pet. Owner-of-record is
  // the comparison base (it rotates to the buyer on every claim path).
  const custodial = opts.relayerAddress
    ? runner.ownerAddress.toLowerCase() === opts.relayerAddress.toLowerCase()
    : undefined;
  // PUBLIC failure signal only: failureReason carries raw revert/RPC text
  // (String(err.message) in fulfillment) and this view is served on public
  // serial-keyed endpoints, so internals must not leak here. The raw detail
  // stays in the DB row + server logs; clients still see THAT a mint failed.
  // The ONE exception is a reason written with MINT_BUSY_PREFIX (fulfillment.ts): it is composed
  // by us from public on-chain numbers, never from revert or RPC text, so it is shown verbatim.
  const publicFailure = runner.failureReason
    ? runner.failureReason.startsWith(MINT_BUSY_PREFIX)
      ? runner.failureReason.slice(MINT_BUSY_PREFIX.length)
      : "Mint did not complete. Please try again."
    : undefined;
  return {
    id: runner.serial,
    serial: runner.serial,
    status: runner.status,
    tokenId: runner.tokenId ?? undefined,
    tbaAddress: runner.tbaAddress ?? undefined,
    tba: runner.tbaAddress ?? undefined,
    ownerAddress: runner.ownerAddress,
    owner: runner.ownerAddress,
    ...(custodial !== undefined ? { custodial } : {}),
    lastEvent: runner.lastEvent ?? undefined,
    hunger: runner.hunger,
    thirst: runner.thirst,
    joy: runner.joy,
    mood: moodFor(runner, new Date()),
    hatched: runner.hatched,
    toys: runner.toys,
    critical: runner.critical,
    gone: runner.gone,
    won: runner.won,
    runnerNumber: runnerNumber(runner.tokenId, runner.serial),
    petName: petName(runner.tokenId),
    network: config.ROBINHOOD_NETWORK,
    applePassUrl: passUrl ?? undefined,
    error: publicFailure,
    failureReason: publicFailure,
    links: {
      applePass: passUrl,
      account: runner.tbaAddress
        ? `${explorer}/address/${runner.tbaAddress}`
        : null,
      issueTx: runner.issueTxHash ? `${explorer}/tx/${runner.issueTxHash}` : null,
    },
    createdAt: runner.createdAt,
  };
}

export function runnerRouter(ctx: AppContext): Router {
  const r = Router();

  // 0. Anti-Sybil PoW challenge (hashcash-style, stateless issue). The client
  // solves sha256(nonce + ":" + counter) to `bits` leading zero bits during the
  // "Readying your egg" moment; the mint POST re-verifies everything server-side.
  // Served even with the flag off (`required:false`) so the client can skip the
  // solve when the gate is dormant.
  //
  // SUBJECT BINDING (optional here, enforced at redemption): when the caller
  // presents a Privy access token, the challenge signature also binds THAT
  // identity, so the solved counter is spendable only by it. Unbound, a solved
  // challenge was a bearer token any identity could redeem, which made the
  // compute farmable from anywhere cheap. The token is optional because the
  // shipped web client asks for its challenge before it holds one; a mint that
  // redeems an unbound challenge is warned about here and refused outright on
  // mainnet (see requireSubjectBinding in sybil.ts).
  r.get("/api/mint/challenge", wrap(async (req, res) => {
    const bearer = /^Bearer\s+(.+)$/i.exec(req.headers.authorization ?? "");
    const qToken = typeof req.query.privyToken === "string" ? req.query.privyToken : undefined;
    const token = bearer?.[1]?.trim() || qToken;
    let subject = "";
    if (config.modes.privyLive && token) {
      const auth = await verifyPrivyToken(token);
      if (auth.ok && auth.userId) subject = subjectTag(auth.userId);
    }
    const challenge = issuePowChallenge(subject);
    // The captcha advertisement rides the SAME response the client already asks
    // for, and the site key is served rather than baked into the web build, so
    // arming the captcha is an env change on this service alone: no web deploy.
    res.json({
      ...challenge,
      required: config.ANTI_SYBIL_ENABLED,
      // The submit-timing floor, advertised so the client's pow retry can WAIT
      // IT OUT instead of guessing. Production logs (2026-08-26) showed real
      // minters cycling pow_invalid -> too_fast: the auto-retry re-primed and
      // resubmitted before the fresh challenge was old enough for this floor,
      // so the retry refused itself.
      minElapsedMs: config.MINT_MIN_ELAPSED_MS,
      captcha: config.modes.captchaLive
        ? { required: true, siteKey: config.TURNSTILE_SITE_KEY }
        : { required: false },
    });
  }));

  // Season chain config, served LIVE so the browser targets the CURRENT
  // contracts without a web rebake. The 2026-08-26 season flip proved the
  // baked-env failure mode: the API minted on the new season while the site's
  // baked address signed care into the DEAD vault, so the first feed failed.
  // The web treats these as the source of truth and keeps its baked env only
  // as the fallback when this endpoint is unreachable. Addresses are public
  // on-chain facts; nothing here is secret.
  r.get("/api/chain-config", wrap(async (_req, res) => {
    res.setHeader("Cache-Control", "public, max-age=60");
    // The sellout start gate rides along, because the browser needs it for the same reason it
    // needs the addresses: to tell a keeper WHY a feed is refused right now ("the season has not
    // started, 6 of 10 minted") instead of surfacing a raw revert. Best effort: a chain hiccup
    // must not take the address config down with it.
    let season: Record<string, unknown> | null = null;
    if (config.modes.survivalLive) {
      try {
        const g = await ctx.relayer.seasonGate();
        season = {
          selloutStartsSeason: g.selloutStartsSeason,
          startedAt: g.startedAt,
          started: g.startedAt !== 0,
          entryOpen: g.entryOpen,
          minted: g.minted,
          maxSupply: g.maxSupply,
          // Additive (older clients ignore them). Clock model: the unix second minting closes for
          // good, so the site can say "mint open until <date>". null under the sellout model, where
          // the roster closes on the sellout instead, or when the vault could not answer.
          entryDeadline: g.entryDeadline,
          seasonStart: g.seasonStart,
        };
      } catch (err) {
        logger.warn({ err: String(err) }, "chain-config: season gate read failed");
      }
    }
    res.json({
      season,
      chainId: config.robinhood.chainId,
      network: config.ROBINHOOD_NETWORK,
      petVault: config.PETVAULT_ADDRESS || null,
      pet721: config.pet721Address || null,
      careToken: config.CARE_TOKEN_ADDRESS || null,
      careTokenDecimals: config.CARE_TOKEN_DECIMALS,
      feeToken: config.FEE_TOKEN_ADDRESS || null,
      feeTokenDecimals: config.FEE_TOKEN_DECIMALS,
    });
  }));

  // Hosted brand logo. Google Wallet fetches the loyalty-class programLogo from
  // <PUBLIC_BASE_URL>/assets/logo.png when the class is created; a 404 here
  // fails the class and with it every Save-to-Google attempt, so this MUST
  // serve a real square PNG over HTTPS.
  r.get("/assets/logo.png", wrap(async (_req, res) => {
    const png = await brandLogoPng(660);
    res.setHeader("Content-Type", "image/png");
    res.setHeader("Cache-Control", "public, max-age=86400");
    res.send(png);
  }));

  // 1. Email-only custodial checkout (DEMO_BYPASS gated). Mints a RUNNER to the
  // relayer, emails the play link. Poll GET /api/runner/checkout/:id.
  r.post("/api/runner/checkout", wrap(async (req, res) => {
    const parsed = CheckoutBody.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ error: parsed.error.issues[0]?.message ?? "invalid body" });
    }
    if (!config.DEMO_BYPASS_PAYMENT) {
      return res.status(400).json({
        error: "WALLETCHI free mint is disabled: enable DEMO_BYPASS_PAYMENT to mint a pet.",
      });
    }
    const issued = await ctx.store.countRunners();
    if (issued >= config.RUNNER_SUPPLY_CAP) {
      return res.status(409).json({ error: "WALLETCHI is sold out for this season" });
    }
    // THE CHAIN IS THE SUPPLY, NOT OUR ROW COUNT. countRunners() only sees pets minted
    // THROUGH this API, so any pet issued directly on-chain (a seeded season, a manual
    // mint, a second deployment sharing the collection) is invisible to it and the gate
    // above lets a keeper through into a mint the chain then reverts as MaxSupplyReached.
    // They would pay for that with a generic failure at the one moment they are deciding
    // whether this thing works. Ask the collection instead, and refuse politely.
    //
    // Also refuses once the ROSTER HAS CLOSED (sellout model: the season started), where
    // issuePet reverts EntryWindowClosed for the same reason. Best effort: an unreadable
    // gate leaves the original behaviour rather than blocking every mint on an RPC blip.
    const supplyGate = await getSeasonGate(ctx).catch(() => null);
    if (supplyGate) {
      if (supplyGate.maxSupply > 0 && supplyGate.minted >= supplyGate.maxSupply) {
        return res.status(409).json({ error: "WALLETCHI is sold out for this season" });
      }
      if (!supplyGate.entryOpen) {
        return res.status(409).json({
          error: "This season has already started, so its roster is closed. Watch the Arena, or pick up a pet from a keeper and claim its pass.",
        });
      }
    }

    // THE HOURLY MINT BUDGET, checked BEFORE the keeper spends anything. issuePet reverts
    // MintBudgetExhausted once the issuer's rolling budget is spent (the brake on a leaked relayer
    // key). Refusing here, with the actual wait, beats accepting the checkout, burning the keeper's
    // proof-of-work and one-per-email claim on a transaction that cannot land, and then reporting a
    // generic failure. Best effort: an unreadable budget leaves the mint path exactly as it was,
    // and a race lost after this check is still named precisely by the fulfillment catch.
    //
    // COUNTS IN-FLIGHT MINTS (launch fix 2). The chain's `used` moves only when a mint mines, so
    // under a burst the keepers already admitted are invisible to it and a wave that crosses the
    // hourly line used to be admitted here and fail after polling. admitMint reserves a slot
    // against used + admitted in the same tick as the decision; the slot is handed back on every
    // exit below (a later refusal, or the mint settling either way), never leaked.
    let budget: Awaited<ReturnType<AppContext["relayer"]["mintBudgetState"]>> | null = null;
    try {
      budget = await ctx.relayer.mintBudgetState();
    } catch {
      budget = null;
    }
    const verdict = admitMint(budget, Math.floor(Date.now() / 1000));
    if (!verdict.ok) {
      res.setHeader("Retry-After", String(verdict.retryAfterSec));
      return res.status(429).json({
        error: verdict.message,
        code: "mint_busy",
        retryAfterSec: verdict.retryAfterSec,
      });
    }
    const admission = verdict.admission;
    let handedOff = false; // true once fulfillment owns the slot
    try {
      // Privy-aware free mint: with Privy configured and a verified token + wallet,
      // the pet mints to the user's own wallet and the VERIFIED identity becomes the
      // mint subject; otherwise custodial (demo path, relayer keeps the pet).
      const bearer = /^Bearer\s+(.+)$/i.exec(req.headers.authorization ?? "");
      const token = parsed.data.privyToken ?? bearer?.[1]?.trim();
      let ownerAddress = ctx.relayer.address; // custodial default
      let selfCustody = false; // flips true only when a verified wallet takes ownership
      let email = parsed.data.email;
      // The mint SUBJECT: the tag of the verified Privy identity, empty when there is
      // none. This, not the email, is what the supply wall keys on.
      let subject = "";
      let privyEmailUnavailable = false; // we could not ASK Privy (outage), a retry not a refusal
      if (config.modes.privyLive && token && parsed.data.walletAddress) {
        const auth = await verifyPrivyToken(token);
        if (auth.ok) {
          // The asserted wallet must be one the verified Privy session actually
          // controls (server-to-server getUser, the same standard as the /me
          // routes). An address the session does not control is treated as no
          // proof at all: the mint falls back to the custodial path, and the
          // REQUIRE_SELF_CUSTODY gate below refuses it when self-custody is
          // mandatory. Never mint to a merely client-asserted address.
          const wallets = await getPrivyUserWallets(auth.userId);
          // auth.userId is required, not merely expected: it IS the identity the
          // supply wall reserves, so a verification that somehow produced no user id
          // is not a self-custody mint. Without this the tag would fall back to a
          // single shared "undefined" subject for every such caller.
          if (auth.userId && wallets.includes(parsed.data.walletAddress.toLowerCase())) {
            ownerAddress = parsed.data.walletAddress;
            selfCustody = true;
            subject = subjectTag(auth.userId);
            // ONLY THE VERIFIED EMAIL, INCLUDING WHEN THERE IS NONE. This used to be
            // `if (verifiedEmail) email = verifiedEmail`, which reads as "the
            // verified email wins" but is really "the verified email wins WHEN THERE
            // IS ONE". A wallet-only Privy login attests none, and Privy is enabled
            // for wallet login on the live app, so on that branch the caller's own
            // string survived and the synthesized fallback below invented a unique
            // address per wallet. Every downstream gate (normalizeEmail, emailHash,
            // emailAlreadyMinted, the atomic reserveEmail) then keyed on a value the
            // minter picked, so the one-inbox-one-pet wall bounded nothing: N free
            // self-signed EOAs read as N keepers. Overwrite unconditionally, so a
            // verified session with no attested email lands on the hard block below
            // rather than falling back to anything at all.
            const attested = await lookupPrivyUserEmail(auth.userId);
            email = attested.ok ? (attested.email ?? undefined) : undefined;
            privyEmailUnavailable = !attested.ok;
          } else {
            logger.warn(
              { wallet: parsed.data.walletAddress },
              "checkout: asserted wallet is not linked to the verified Privy user; ignoring assertion",
            );
          }
        }
      }
      // Self-custody gate: when required (mainnet), a mint MUST land in a wallet the
      // caller proved. If nothing swapped ownership off the relayer above, minting
      // would custody the pet, which this mode forbids. Refuse so we never hold it.
      if (config.REQUIRE_SELF_CUSTODY && !selfCustody) {
        return res.status(403).json({
          code: "self_custody_required",
          error: "Sign in so your pet mints to your own wallet. WALLETCHI never holds a pet for you.",
        });
      }
      // A verified session could not be ASKED for its email (Privy outage). That is
      // not the same fact as "this account has no email", and the two must not
      // produce the same decision: refusing forever would be wrong, and proceeding
      // would hand the wall back to the caller's string. Say retry.
      if (selfCustody && privyEmailUnavailable) {
        return res.status(503).json({
          code: "verification_unavailable",
          error: "We could not confirm your sign-in just now. Please try again in a moment.",
        });
      }
      // HARD BLOCK: verified session, no attested email. This is the exact case the
      // synthesized fallback below used to swallow, and swallowing it is what let one
      // attacker look like the whole keeper base: `<wallet>@wallet.walletchi.local` is
      // unique per attacker-generated key by construction, so every email-keyed gate
      // saw a brand new keeper each time. On a self-custody mint the attested email is
      // the only acceptable one, and no email means no mint.
      if (selfCustody && !email) {
        // Wallet-only sign-ins land here by design (minting is email-only, per
        // Hunt 2026-08-26). The copy has to route BOTH kinds of arrival: a minter
        // who just needs to add an email, and a secondary buyer who should not be
        // minting at all: their pet already exists and the Claim page is theirs.
        return res.status(403).json({
          code: "verified_email_required",
          error:
            "Minting needs an email: add one to your WALLETCHI sign-in so your pet can find its way home, then mint again. Bought your pet from another keeper? No mint needed: get its pass on the Claim page.",
        });
      }
      // Synthesized placeholder, DEMO PATH ONLY (no verified session, so ownership
      // stays with the relayer). Harmless here because it is the relayer's own
      // address for every custodial mint: one shared value that dedups against
      // itself, not a fresh identity per caller. It can never be reached on a
      // self-custody mint, and REQUIRE_SELF_CUSTODY (mandatory on mainnet) refuses
      // any mint that is not one.
      if (!email) email = `${ownerAddress.toLowerCase()}@wallet.walletchi.local`;

      // Anti-Sybil risk gate (flag-gated so the flag-off path is exactly today's).
      // Every check runs SERVER-SIDE from raw inputs: the public mint API is the
      // sole mint path, so a direct-API attacker gets the same wall as a browser.
      // The WALLS are the two atomic reserves inside the gate: reservePrivyUser on
      // the verified identity (the one a self-custody caller cannot choose) and
      // reserveEmail on the inbox, both unique-constraint claims and race-proof.
      // MintSignal records are forensics + velocity fuel and are best-effort on
      // every path: once a reserve has landed, a failed record must never block
      // (that would orphan the claim: reserved forever, no pet).
      let privyUserHash: string | null = null;
      if (config.ANTI_SYBIL_ENABLED) {
        const ip = clientIp(req);
        const subnet = subnetOf(ip);
        const { fingerprint, honeypot, elapsedMs, botSignals } = parsed.data;
        const normalizedHash = emailHash(normalizeEmail(email));
        // Velocity signals that exceeded their ADVISORY threshold without refusing
        // the mint. Assigned from the gate verdict below, then folded into the
        // forensics record so a cluster stays reviewable after the fact. Declared
        // here because `record` closes over it and runs both before and after the
        // gate; empty on a clean mint and on every blocked one.
        let velocityFlags: string[] = [];
        const record = (outcome: string) =>
          ctx.store.recordMintAttempt({
            normalizedEmailHash: normalizedHash,
            fingerprint: fingerprint ?? null,
            ip,
            subnet,
            outcome,
            botFlags: (() => {
              const bot = botFlagsLabel(botSignals);
              if (!velocityFlags.length) return bot;
              const vel = `velocity:${velocityFlags.join(",")}`;
              return bot ? `${bot} ${vel}` : vel;
            })(),
          });
        const sendBlock = async (verdict: { status: number; code: string; message: string }) => {
          try {
            await record(verdict.code);
          } catch (err) {
            logger.error({ err: String(err) }, "mint-signal record failed (blocked attempt)");
          }
          logger.warn({ code: verdict.code, ip, subnet }, "anti-sybil mint blocked");
          return res.status(verdict.status).json({ error: verdict.message, code: verdict.code });
        };
        // In-process fast path for a concurrent same-email burst: cheaper than
        // letting every duplicate burn a PoW verify + a reserve round-trip. The
        // ATOMIC backstop is reserveEmail inside the gate, which holds even
        // across instances (unique constraint), so this set is an optimization,
        // not the wall.
        if (inFlightMints.has(normalizedHash)) {
          return sendBlock(blockFor("already_minted"));
        }
        inFlightMints.add(normalizedHash);
        try {
          const verdict = await evaluateMintGate(ctx.store, {
            email,
            ip,
            subnet,
            subject,
            fingerprint,
            honeypot,
            elapsedMs,
            botSignals,
            pow: parsed.data.pow as PowSolution | undefined,
            captchaToken: parsed.data.captchaToken,
          });
          if (!verdict.ok) {
            return await sendBlock(verdict);
          }
          // Carried onto the Runner row so a genuinely failed mint can hand the
          // identity claim back (fulfillment does the same for the email claim);
          // without it an RPC blip would lock that keeper out of the season.
          privyUserHash = verdict.privyUserHash;
          // Carried into the forensics record written just below.
          velocityFlags = verdict.velocityFlags;
          // Reserved: this mint WILL proceed. The record only feeds
          // velocity counts + forensics now, so its failure is logged, never
          // blocking (blocking here would strand the reserved email).
          try {
            await record("minted");
          } catch (err) {
            logger.error({ err: String(err) }, "mint-signal record failed (minted attempt)");
          }
        } finally {
          inFlightMints.delete(normalizedHash);
        }
      }

      const serial = randomUUID();
      const authToken = randomBytes(24).toString("hex");
      // Authoritative supply gate: count + create inside the serial section so a
      // parallel burst at the cap can never over-mint (the check above is only a
      // cheap early exit).
      const runner = await withMintCapLock(async () => {
        if ((await ctx.store.countRunners()) >= config.RUNNER_SUPPLY_CAP) return null;
        return ctx.store.createRunner({
        serial,
        tokenId: null,
        tbaAddress: null,
        ownerAddress,
        email,
        bestScore: 0,
        salmon: 0,
        runs: 0,
        authToken,
        status: "minting",
        issueTxHash: null,
        issueNonce: null,
        failureReason: null,
        idleSalmon: 0,
        lastTickAt: null,
        lastEvent: null,
        lastPushAt: null,
        lastIdleCatchAt: null,
        pendingDigest: 0,
        lastHoneyAt: null,
        lastFishAt: null,
        lastExploreAt: null,
        pendingSalmon: 0,
        activeFork: null,
        forkExpiresAt: null,
        hunger: 100,
        thirst: 100,
        joy: 100,
        lastNeedsAt: null,
        lastCareAt: null,
        lastWaterAt: null,
        lastWanderPingAt: null,
        lastPlayAt: null,
        lastToyAt: null,
        hatched: false,
        toys: 0,
        critical: false,
        gone: false,
        won: false,
        wonPrize: "0",
        lastStage: 0,
        bornAt: null,
        diedAt: null,
        careCount: 0,
        deathRank: 0,
        privyUserHash,
        });
      });
      if (!runner) {
        return res.status(409).json({ error: "WALLETCHI is sold out for this season" });
      }

      // PII discipline: log the anti-sybil email hash, never the raw address. The
      // hash is of the email the mint actually USED (Privy's attestation on a
      // self-custody mint), not of the caller's field: forensics that key on a
      // string the caller chose describe the attacker's fiction, not the mint.
      logger.warn(
        { serial, emailHash: emailHash(normalizeEmail(email)), selfCustody },
        "WALLETCHI checkout: pet mint, no payment (demo bypass)",
      );
      // The slot travels with the mint: fulfillment hands it back when the row settles.
      handedOff = true;
      void fulfillRunner(ctx, serial, admission.release);

      const view = runnerStatusView(runner, { relayerAddress: ctx.relayer.address });
      // The mint-session token goes ONLY in this POST response (to the minting
      // browser), never in the serial-keyed poll/state views. It lets the minter
      // fetch their pass capability URL after mint (POST /api/runner/pass-link)
      // even when the economy is on and the URL is withheld from public views.
      const { mintSession } = issueMintSession(serial);
      res.json({ ...view, bypass: true, demoBypass: true, mintSession });
    } finally {
      // Every path that did not hand the slot to fulfillment (a refusal below the
      // pre-check, a thrown error) gives it back here. Idempotent, so the handed-off
      // case is a no-op.
      if (!handedOff) admission.release();
    }
  }));

  // 2. Poll checkout status (id === serial). Serial-keyed and public, so it
  // NEVER carries the capability pass URL or the mint-session token.
  //
  // While the row is still minting, the view carries the keeper's place in line
  // (launch fix 1): position, how many are ahead, a rough wait, and whether the
  // transaction is already on the wire. A Map lookup, no chain or DB cost. The
  // web client keeps polling for as long as this is present (the mint is alive on
  // the server) and only gives up on a terminal status, so a keeper deep in a
  // burst is never told "taking too long" while their pet is about to land.
  r.get("/api/runner/checkout/:id", wrap(async (req, res) => {
    const runner = await ctx.store.getRunner(req.params.id!);
    if (!runner) return res.status(404).json({ error: "not found" });
    const view = runnerStatusView(runner, { relayerAddress: ctx.relayer.address });
    const queue = runner.status === "minting" ? mintQueueInfo(runner.serial) : null;
    res.json(queue ? { ...view, queue } : view);
  }));

  // 2b. Exchange a mint-session token for the just-minted pet's capability pass
  // URL. This is the ONLY public path to the cap when the economy is on, and it
  // is gated by the unguessable, serial-bound mint-session token from the POST
  // above, so it does not reopen the confused-deputy hole: an attacker cannot
  // forge the token or obtain one for a pet they did not mint.
  const PassLinkBody = z.object({
    id: z.string().min(1),
    mintSession: z.string().min(1),
  });
  r.post("/api/runner/pass-link", wrap(async (req, res) => {
    const parsed = PassLinkBody.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ error: parsed.error.issues[0]?.message ?? "invalid body" });
    }
    const { id, mintSession } = parsed.data;
    if (!resolveMintSession(mintSession, id)) {
      return res.status(403).json({ error: "not found" });
    }
    const runner = await ctx.store.getRunner(id);
    if (!runner) return res.status(403).json({ error: "not found" });
    const applePassUrl = runnerPassDownloadUrl(runner.serial, runner.authToken);
    let googleSaveUrl: string | null = null;
    try {
      googleSaveUrl = await getRunnerGoogle().saveUrl(runner);
    } catch (err) {
      logger.warn({ err: String(err), serial: runner.serial }, "google save url failed on pass-link");
    }
    res.json({ applePassUrl, googleSaveUrl: googleSaveUrl ?? undefined });
  }));

  // Card Play: pet-care action links on the pass back (HMAC-signed; owner only).
  const errPage = (res: import("express").Response, code: number, title: string, body: string, emoji: string) =>
    res.status(code).type("html").send(confirmPage({ code, title, body, emoji }));

  // Shared validation for both verbs: known action, pet exists, HMAC cap valid.
  const validateCareLink = async (
    req: import("express").Request,
    res: import("express").Response,
  ): Promise<{ runner: Runner; action: CareAction; src: string } | null> => {
    const { serial, action } = req.params as { serial: string; action: string };
    const src = typeof req.query.src === "string" ? req.query.src.slice(0, 16) : "untagged";
    if (!isCareAction(action)) {
      errPage(res, 404, "Unknown action", "That care action does not exist.", "❓");
      return null;
    }
    const runner = await ctx.store.getRunner(serial);
    if (!runner) {
      errPage(res, 404, "Pet not found", "We could not find this pet.", "🐾");
      return null;
    }
    if (!verifyTag(runner.authToken, actionPayload(serial, action), req.query.s)) {
      errPage(res, 403, "Not your pet", "This care link is not valid for you.", "🔒");
      return null;
    }
    return { runner, action, src };
  };

  const webCareUrl = (serial: string, action: string) => `${config.WEB_APP_URL}/care/${serial}/${action}`;

  // Next-need guidance (D6, REQUIRED): the four OTHER needs sorted by urgency
  // (soonest-lapsing first) with one-tap signed care links. Best effort: a
  // failed needs read lists the remaining needs unsorted and untimed, never
  // nothing. Shared by the care confirm page and the duplicate-tap dedup page.
  const buildNextNeeds = async (
    runner: Runner,
    action: string,
    src: string,
  ): Promise<{ action: string; label: string; href: string; timeLabel?: string }[]> => {
    let nextNeeds: { action: string; label: string; href: string; timeLabel?: string }[] =
      NEED_ACTIONS.filter((a) => a !== action).map((a) => ({
        action: a,
        label: NEED_LABELS[CARE_ACTION_TYPE[a]!]!,
        href: `${config.PUBLIC_BASE_URL}/api/runner/${runner.serial}/care/${a}?s=${signTag(runner.authToken, actionPayload(runner.serial, a))}&src=${encodeURIComponent(src)}`,
      }));
    if (!runner.tokenId) return nextNeeds;
    try {
      const [{ needAt }, vcfg] = await Promise.all([
        cachedPetNeeds(ctx, runner.tokenId),
        getVaultConfig(ctx),
      ]);
      if (needAt.some((t) => t > 0)) {
        const left = needsSecondsLeft(needAt, vcfg.lifeTtlSeconds, Math.floor(Date.now() / 1000));
        const short = (s: number) =>
          s >= 86_400 ? `${Math.floor(s / 86_400)}d left` : s >= 3600 ? `${Math.floor(s / 3600)}h left` : `${Math.max(1, Math.floor(s / 60))}m left`;
        nextNeeds = nextNeeds
          .map((n) => ({ ...n, secondsLeft: left[CARE_ACTION_TYPE[n.action]!]! }))
          .sort((a, b) => a.secondsLeft - b.secondsLeft)
          .map(({ secondsLeft, ...n }) => ({ ...n, timeLabel: short(secondsLeft) }));
      }
    } catch {
      /* unsorted fallback stands */
    }
    return nextNeeds;
  };

  // ---- SILENT CARE from the wallet pass (on-chain scoped session key) --------
  //
  // The keeper signs ONE grant on the website that scopes a session key to
  // care(uint256,uint8) on the PetVault and nothing else; the server holds that
  // key. From then on a pass tap lands the care with no website and no signature.
  //
  // GET is SIDE-EFFECT FREE: wallet care links get prefetched by mail scanners
  // and link previews, and a prefetch must never spend CARE or reset the life
  // timer. It only decides where the tap goes:
  //   usable session -> auto-submitting interstitial (one invisible hop -> POST)
  //   no usable session -> the owner-signed web care page (the proven fallback)
  // Reads here are DB + cache only, so a prefetch storm cannot amplify into RPC.
  const careLinkPath = "/api/runner/:serial/care/:action";

  r.get(careLinkPath, wrap(async (req, res) => {
    const v = await validateCareLink(req, res);
    if (!v) return;
    const { runner, action, src } = v;
    recordCareOpened(src);
    const verdict = sessionVerdict(await ctx.store.getCareSession(runner.serial), {
      vaultAddress: config.PETVAULT_ADDRESS,
      // Owner-of-record: the authoritative fresh ownerOf read happens on the POST,
      // where it gates the actual spend. Keeping GET off the chain keeps prefetch cheap.
      ownerAddress: runner.ownerAddress,
      tokenId: runner.tokenId,
    });
    if (!verdict.ok) {
      logger.info({ serial: runner.serial, action, src, reason: verdict.reason }, "pass care tap -> owner-signed fallback");
      return res.redirect(302, webCareUrl(runner.serial, action));
    }
    logger.info({ serial: runner.serial, action, src }, "pass care tap -> silent session care");
    // The interstitial is what's on screen WHILE the care lands on-chain, so it carries the
    // animated scene: the pet (in its own hue) already eating/drinking/playing. Seed by tokenId
    // so the creature matches this exact pet.
    const seed = runner.tokenId ? String(runner.tokenId) : runner.serial;
    res.type("html").send(
      interstitialPage(req.originalUrl, { sceneMarkup: careScene(action, seed), title: CARE_LOADING[action] }),
    );
  }));

  // POST performs the care with the pet's stored session key. Gas is paid by the
  // Gas Manager policy and the care cost comes from the pet's own account, so the
  // keeper pays nothing and signs nothing.
  r.post(careLinkPath, wrap(async (req, res) => {
    const v = await validateCareLink(req, res);
    if (!v) return;
    const { runner, action, src } = v;
    if (runner.gone || !runner.tokenId) {
      return errPage(res, 409, "This pet has passed on", "Its story is complete. It lives on its page forever.", "🌙");
    }
    // NO DOUBLE-CHARGE (audit #2), checked before any DB or RPC read: this
    // (pet, need) was charged moments ago, so this tap is a duplicate (a double
    // tap of the same link, or the waiting page's auto-retry coming back after
    // the first care landed). Answer with the friendly dedup page and NEVER
    // submit again: at careCooldown = 0 the vault would happily charge twice.
    const alreadyServedPage = async () => {
      logger.info({ serial: runner.serial, action, src }, "duplicate care tap deduped (need already charged)");
      return confirmPage({
        code: 200,
        title: "Already taken care of",
        body: "That care just landed on-chain, so this tap was not charged again. Pick your pet's next need below.",
        emoji: "🐾",
        updating: true,
        nextNeeds: await buildNextNeeds(runner, action, src),
      });
    };
    if (careRecentlyCharged(runner.serial, action)) {
      return res.status(200).type("html").send(await alreadyServedPage());
    }
    // Cheap DB check first, so a tap that is going to fall back never costs an
    // RPC read. Normally this only fails here when a revoke/expiry raced the GET.
    // 303 so the browser follows with a GET onto the owner-signed care page.
    const verdict = sessionVerdict(await ctx.store.getCareSession(runner.serial), {
      vaultAddress: config.PETVAULT_ADDRESS,
      ownerAddress: runner.ownerAddress,
      tokenId: runner.tokenId,
    });
    if (!verdict.ok) {
      logger.info({ serial: runner.serial, action, reason: verdict.reason }, "silent care unavailable at POST -> fallback");
      return res.redirect(303, webCareUrl(runner.serial, action));
    }
    // Only now, on a tap that WILL spend: the authoritative fresh ownership read.
    // A pet sold since the last cache fill must not be cared for on the seller's
    // still-valid link, and sessionVerdict cannot catch that on its own because
    // the owner of record only moves on a claim.
    const guard = await careOwnerGuard(ctx, runner, { fresh: true });
    if (guard === "unavailable") {
      return errPage(res, 503, "One moment", "We could not check on your pet just now. Please try again in a moment.", "⏳");
    }
    if (guard === "transferred") {
      // The pet moved. The stored session was granted by the SELLER, so retire it
      // here rather than leaving a stranger's key installed against a new owner.
      await ctx.store.revokeCareSession(runner.serial, "pet transferred on-chain");
      return errPage(res, 403, "This pet has a new home", "This pet moved to a new wallet. Claim it on the WALLETCHI claim page to care for it.", "🔒");
    }

    // One care SUBMISSION in flight per pet: a double tap must not put two ops
    // in the same nonce window (the second reverts after inclusion and the
    // paymaster pays). FIVE NEEDS (D6): the five-tap ritual makes a tap DURING
    // a flight the NORMAL case, not an error, so the second tap gets a 200
    // WAITING page that auto-retries this same signed link every ~3s (up to
    // ~10 tries) and then proceeds normally: five back-to-back pass taps land
    // sequentially with zero error screens. Checked BEFORE the attempt throttle
    // so the waiting retries never burn throttle slots (only real submissions
    // count). The retry is IDEMPOTENT for the SAME need (audit #2): once the
    // in-flight care lands, careRecentlyCharged answers the retry with the
    // dedup page above instead of a second charge; if the flight FAILED, the
    // retry submits and the keeper's tap still becomes exactly one care.
    const flying = inFlightCare.get(runner.serial);
    if (flying !== undefined) {
      const waits = Number(req.query.wt ?? 0);
      if (!Number.isFinite(waits) || waits >= 10) {
        return res.status(200).type("html").send(
          confirmPage({
            code: 200,
            title: "Still on its way",
            body: "That care is taking longer than usual. Your pet is fine. Check its card in a moment.",
            emoji: "🐾",
            updating: true,
          }),
        );
      }
      const u = new URL(req.originalUrl, config.PUBLIC_BASE_URL);
      u.searchParams.set("wt", String(waits + 1));
      return res.status(200).type("html").send(
        confirmPage({
          code: 200,
          title: "Care in flight",
          body:
            flying === action
              ? "This exact care is already landing on-chain. Hang on, it counts once and you will not be charged twice."
              : "A care for this pet is landing on-chain right now. Hang on, this one will follow by itself.",
          emoji: "🐾",
          countdown: { seconds: 3, retryUrl: `${u.pathname}${u.search}` },
        }),
      );
    }
    // HATCH TRUTH: the chain's care count BEFORE this care is submitted. A pet hatched by
    // mint-time arming in the browser already reads >= 1 here even though runner.hatched
    // may still say false, so its first pass tap is correctly NOT called the hatch. Read
    // here, above the dedup re-check, because nothing may await between that re-check and
    // the in-flight latch. A failed read (null) falls back to the post-care count.
    const careCountBeforeTx = await chainCareCountOf(ctx, runner.tokenId);
    // Last-moment dedup RE-CHECK (audit #2), in the same synchronous tick as
    // the in-flight latch below (no await between this line and the .set), so
    // it is atomic under Node's single thread: it closes the race where a
    // second tap passed the early check, sat through its own awaits while the
    // first flight was still landing, and arrived here after that flight
    // completed and stamped the charge. Before the throttle so a deduped tap
    // never burns an attempt slot.
    if (careRecentlyCharged(runner.serial, action)) {
      return res.status(200).type("html").send(await alreadyServedPage());
    }
    // Bound attempts per PET per NEED, not just per IP: a leaked care link is a bearer
    // capability that spends, and every attempt past this costs a fresh ownerOf read, a
    // KDF and an Alchemy round trip for a call the vault will reject anyway. Keyed on
    // serial:action so the honest five-different-needs ritual never throttles.
    if (careAttemptThrottled(runner.serial, action)) {
      return errPage(res, 429, "Easy there", "Your pet was just cared for that way. Give it a moment and try again.", "⏳");
    }
    inFlightCare.set(runner.serial, action);
    const before = { hunger: runner.hunger, thirst: runner.thirst, joy: runner.joy };
    let result;
    try {
      result = await submitSessionCare(verdict.session, action);
    } finally {
      inFlightCare.delete(runner.serial);
    }
    // Stamp the charge the moment we know the bundler took the op, BEFORE any
    // further await, so a duplicate tap parked on the waiting page can never
    // re-submit this need (audit #2). Both arms spend: ok is a confirmed land,
    // and "pending" means the op is accepted and will almost certainly land
    // after the wait window. Failures are NOT stamped on purpose: if this
    // flight died, a waiting duplicate retrying is exactly-once, not a double.
    if (result.ok || result.kind === "pending") {
      markCareCharged(runner.serial, action);
    }
    if (!result.ok) {
      if (result.kind === "pending") {
        // The bundler accepted the op; only the confirmation was slow. Saying
        // "could not care" here would be a lie, and the keeper's retry would just
        // hit CareOnCooldown. The idle reconciler folds the care in when it lands.
        // Deliberately NOT touchCareSession: the op can still revert, and useCount
        // is an audit trail of cares that actually landed, not of cares attempted.
        recordCarePerformed(`session:${src}`);
        logger.info({ serial: runner.serial, action, src }, "silent care submitted, confirmation pending");
        return res.status(202).type("html").send(
          confirmPage({
            code: 202,
            title: "On its way",
            body: "Your pet's care is confirming on-chain now. Its card will update in a moment.",
            emoji: "🐾",
            updating: true,
            scene: careScene(action, String(runner.tokenId)),
          }),
        );
      }
      if (result.kind === "permission") {
        // CONFIRMED out of scope or revoked on-chain (a permission-hook selector we
        // recognize). This is proof the key will never work again, so retire the row
        // and let every later tap fall straight through to the owner-signed page.
        await ctx.store.revokeCareSession(runner.serial, `permission rejected: ${result.revertData ?? "hook"}`);
        logger.warn({ serial: runner.serial, action, revertData: result.revertData, detail: result.detail }, "silent care permission rejected; session retired");
        return res.redirect(303, webCareUrl(runner.serial, action));
      }
      if (result.kind === "validation" || result.kind === "unreadable") {
        // We could NOT confirm the permission is dead: a generic AA23, or our own
        // seal failing to open (most likely a rotated CARE_SESSION_SECRET). Retiring
        // here is irreversible and would cost the keeper a fresh owner signature, so
        // a transient blip must not do it. Fall back and leave the session installed.
        logger.warn({ serial: runner.serial, action, kind: result.kind, detail: result.detail }, "silent care unavailable; falling back WITHOUT retiring the session");
        return res.redirect(303, webCareUrl(runner.serial, action));
      }
      if (result.kind === "not_owner") {
        // The vault itself said the granter is not the owner. That is terminal for
        // this session, so retire it rather than repeating the whole RPC + KDF +
        // Alchemy round trip forever for a key that can never succeed.
        await ctx.store.revokeCareSession(runner.serial, "vault rejected the granter as non-owner");
        logger.warn({ serial: runner.serial, action }, "silent care rejected as non-owner; session retired");
      }
      if (result.kind === "cooldown") {
        // NOT a failure, and it must not look like one. Mint-time arming feeds the pet as part of
        // minting, so the very first tap a brand-new keeper makes lands inside the vault's per-pet
        // cooldown, at peak excitement about a pass that just appeared in their wallet. A static
        // "try again in a moment" over an error page reads as "the thing you just got is broken".
        //
        // Show the real number, tick it down in front of them, and re-POST this same signed link
        // the instant the vault will accept it, so their one tap still becomes one feed.
        // Cooldown is PER NEED since the five-needs redesign: readyAt keys on
        // the TARGETED need's own stamp (needsOf[action] + careCooldown), so a
        // countdown here never blocks the keeper's other four needs and never
        // overstates the wait. Dead code at the shipped careCooldown = 0, but
        // it must be correct (season.ts careCooldownSecondsLeft; falls back to
        // the pet-level min stamp when the per-need read fails).
        let secs = 0;
        try {
          secs = await careCooldownSecondsLeft(ctx, runner.tokenId, action);
        } catch {
          // Fall through to plain copy rather than failing the page over a read.
        }
        return res
          .status(429)
          .type("html")
          .send(
            confirmPage({
              code: 429,
              title: secs > 0 ? "Almost ready" : "Ready now",
              body:
                secs > 0
                  ? "Your pet is still full from its last meal. Hang on, this feed will go through by itself."
                  : "Feeding now.",
              emoji: "⏳",
              // req.originalUrl keeps the signed query intact, so the retry carries the same
              // capability the keeper already presented. Same origin, so form-action 'self' allows it.
              countdown: { seconds: Math.max(1, secs), retryUrl: req.originalUrl },
            }),
          );
      }
      return errPage(res, ...careFailurePage(result.kind));
    }

    await ctx.store.touchCareSession(runner.serial);
    recordCarePerformed(`session:${src}`);
    // Fold the on-chain care back into the pass + DB (hatch, meters, careCount,
    // push). Same path an off-server owner-signed care takes.
    let updated = runner;
    try {
      const state = await ctx.relayer.petState(runner.tokenId);
      updated = await reconcileOnChainCare(ctx, runner, runner.tokenId, state, new Date());
    } catch (err) {
      // The care LANDED; only the reflection failed. Say so honestly and let the
      // idle reconciler catch the pass up on its next pass.
      logger.error({ err: String(err), serial: runner.serial }, "silent care landed but pass reconcile failed");
    }
    const copy = CARE_CONFIRM[action];
    // FIVE NEEDS: the served need's meter is at 100% right after the care. The
    // "from" value comes from the DB meters (chain-projected on reconcile):
    // feed reads hunger, water reads thirst, the three joy needs share joy.
    const to = 100;
    const from =
      copy.stat === "Feed" ? before.hunger : copy.stat === "Water" ? before.thirst : before.joy;
    // Did THIS care hatch the egg? The pet mints un-hatched and its FIRST care hatches it.
    // If so, the confirm page is the hatch reveal: the egg opens to the pet, and it does
    // NOT auto-close. Otherwise it is the regular action scene.
    //
    // DECIDED BY THE CHAIN, NOT BY THE DB FLAG ALONE. Mint-time arming hatches the pet from
    // the BROWSER (its first sponsored care), and runner.hatched only learns that when a
    // reconcile runs. Hunt's first pass tap (2026-09-23, 26s after that browser hatch) read
    // the stale flag and was labeled "Your egg hatched!" although it was his SECOND care.
    // careHatchedThePet (idle.ts) calls it the hatch only when the chain held ZERO cares
    // right before this one was submitted (careCountBeforeTx above).
    const justHatched = careHatchedThePet(runner, updated, careCountBeforeTx);
    const seed = String(runner.tokenId);
    // Next-need guidance (D6, REQUIRED): the four remaining needs sorted by
    // urgency with one-tap signed care links, headlined "Next: <most urgent>".
    const nextNeeds = await buildNextNeeds(runner, action, src);
    logger.info({ serial: runner.serial, action, src, txHash: result.txHash, justHatched }, "silent session care landed");
    return res.status(200).type("html").send(
      confirmPage(
        justHatched
          ? {
              code: 200,
              title: "Your egg hatched!",
              body: "Say hello to your WALLETCHI. All five needs start full. Keep every one of them served and it stays by your side.",
              emoji: "🐣",
              scene: hatchScene(seed),
              hatch: true,
              txHash: result.txHash,
              link: { href: `${config.WEB_APP_URL}/pet/${runner.serial}`, label: "Meet your pet" },
            }
          : {
              code: 200,
              title: copy.title,
              body: copy.body,
              emoji: copy.emoji,
              ...(to > from ? { stat: { statLabel: copy.stat, delta: to - from, from, to } } : {}),
              scene: careScene(action, seed),
              txHash: result.txHash,
              updating: true,
              nextNeeds,
            },
      ),
    );
  }));

  // Legacy pass links (already sitting in wallets) point at .../action/:action.
  // Redirect them onto the silent care link above, re-signing the same HMAC
  // payload, so existing passes pick up silent care with no re-add.
  r.get("/api/runner/:serial/action/:action", wrap(async (req, res) => {
    const v = await validateCareLink(req, res);
    if (!v) return;
    const { runner, action, src } = v;
    const sig = signTag(runner.authToken, actionPayload(runner.serial, action));
    res.redirect(
      302,
      `${config.PUBLIC_BASE_URL}/api/runner/${runner.serial}/care/${action}?s=${sig}&src=${encodeURIComponent(src)}`,
    );
  }));

  // RETIRED CARE RELAYS (trustless cutover): care() is OWNER-ONLY on-chain now,
  // so the vault rejects the relayer and these server relay paths are dead:
  //   POST /api/runner/:serial/action/:action           (the pass-link relay)
  //   GET  /api/runner/:serial/action/:action/challenge (ERC-4361 issue)
  //   POST /api/runner/:serial/action/:action/signed    (signed-challenge relay)
  // They answer 410 Gone with a machine code and NEVER touch the pet or the
  // chain. The GET above still 302-redirects old passes to the web care page,
  // where the owner signs the care themselves (gas-sponsored AA flow).
  const careMoved = (res: import("express").Response) =>
    res.status(410).json({
      error: "care is now on-chain (owner-signed); open the pet's care link",
      code: "care_moved",
    });
  r.post("/api/runner/:serial/action/:action", (_req, res) => {
    careMoved(res);
  });
  r.get("/api/runner/:serial/action/:action/challenge", (_req, res) => {
    careMoved(res);
  });
  r.post("/api/runner/:serial/action/:action/signed", (_req, res) => {
    careMoved(res);
  });

  // RETIRED COLLECT LINK (season 2, no claims). The "Collect rewards" button on
  // the pass back used to have the relayer claim a pet's finished epochs. Nobody
  // collects anything now: the 2h push engine (runner/push-rewards.ts) pays every
  // pet that earned an epoch straight into its own account, and every call it
  // makes is permissionless, so the rewards arrive whether or not anyone taps
  // anything and whether or not this server is up.
  //
  // Passes ALREADY IN WALLETS still carry this link, so it has to answer kindly
  // rather than break: the GET (the tap) is a friendly page explaining that the
  // rewards come by themselves, and the POST is the machine-readable 410 that
  // matches the retired care relays above. Neither spends an RPC call or touches
  // the pet: there is nothing left for either to do, so the HMAC is not checked
  // and no pet lookup happens (the page reveals nothing a stranger could not
  // already read on the site).
  r.get("/api/runner/:serial/rewards/collect", (_req, res) => {
    res
      .status(200)
      .type("html")
      .send(confirmPage({
        code: 200,
        title: "Rewards come to you now",
        body: "No collecting needed. Every reward your pet earns is sent to its own account by itself, every couple of hours.",
        emoji: "🎁",
      }));
  });

  r.post("/api/runner/:serial/rewards/collect", (_req, res) => {
    res.status(410).json({
      error: "rewards are pushed to your pet automatically now",
      code: "rewards_pushed",
    });
  });

  // Google Wallet save/delete callback (see loyaltyClass callbackOptions).
  // Informational ONLY and unverified (no signature validation), so it feeds
  // the ops ring buffer and nothing else. Always 200: Google retries failures.
  r.post("/api/google/wallet-callback", (req, res) => {
    try {
      const b = (req.body ?? {}) as Record<string, unknown>;
      const sm =
        typeof b.signedMessage === "string"
          ? (JSON.parse(b.signedMessage) as Record<string, unknown>)
          : ((b.signedMessage ?? b) as Record<string, unknown>);
      recordWalletCallback(String(sm.eventType ?? "unknown"), String(sm.objectId ?? ""));
    } catch (err) {
      logger.warn({ err: String(err) }, "google wallet callback unparseable");
    }
    res.status(200).end();
  });

  // WALLETCHI survival season stats (consumed by the site). Reads pot + alive counts
  // from the PetVault when the season is live; a pre-season stub otherwise. Response
  // shape: { potDisplay, potRaw, cubsAlive, cubsTotal, registered, hatched,
  // soldOut, careToken, seasonActive } (registered + hatched + soldOut are
  // additive; older clients ignore).
  r.get("/api/season/stats", wrap(async (_req, res) => {
    // No force: the 60s snapshot cache absorbs a polling crowd (a per-request
    // force here was an RPC-amplification vector: N browsers = N vault reads).
    const snap = await refreshSeasonSnapshot(ctx);
    // Pre-season: cubsAlive reflects minted pets (nothing has died). Live: the vault.
    const cubsAlive = snap.seasonActive ? snap.aliveCount : await ctx.store.countRunners();
    // Minted count with no extra DB read: live season carries it in the vault
    // snapshot; pre-season every minted pet is still alive, so cubsAlive already
    // IS the minted count. soldOut latches once the whole supply is minted, which
    // is what closes the mint form on the site.
    const registered = snap.seasonActive ? snap.registered : cubsAlive;
    const soldOut = registered >= config.RUNNER_SUPPLY_CAP;
    res.setHeader("Cache-Control", "public, max-age=10");
    res.json({
      potDisplay: formatCareToken(snap.potRaw),
      potRaw: snap.potRaw.toString(),
      cubsAlive,
      cubsTotal: config.RUNNER_SUPPLY_CAP,
      registered,
      // Pets fed at least once, so actually in the race. Zero pre-season: an egg
      // that has never been cared for has not hatched.
      hatched: snap.seasonActive ? snap.hatched : 0,
      soldOut,
      careToken: config.CARE_TOKEN_ADDRESS ?? null,
      seasonActive: snap.seasonActive,
    });
  }));

  // WALLETCHI survival board: everything the site's live Arena page needs in ONE
  // call. Bounded reads (20 fallen + 10 keepers) on top of the TTL-cached vault
  // snapshot, so a few-second poll from many browsers stays cheap. Pre-season
  // safe: alive mirrors the minted count, fallen is 0, both feeds are empty.
  r.get("/api/season/board", wrap(async (_req, res) => {
    const snap = await refreshSeasonSnapshot(ctx);
    const minted = await ctx.store.countRunners();
    const alive = snap.seasonActive ? snap.aliveCount : minted;
    // Fallen = pets that were minted and then died, NOT unminted supply. Use the
    // vault's registered count, never the supply cap, or a barely-started season
    // reads "1997 fallen" out of 2000 when only 3 pets exist.
    const fallen = snap.seasonActive ? Math.max(0, snap.registered - snap.aliveCount) : 0;
    const [fallenRows, keeperRows] = await Promise.all([
      ctx.store.recentlyFallen(20),
      ctx.store.topByCareCount(10),
    ]);
    const recentDeaths = fallenRows.map((rn) => ({
      tokenId: rn.tokenId,
      serial: rn.serial,
      number: runnerNumber(rn.tokenId, rn.serial),
      diedAt: rn.diedAt ?? rn.updatedAt,
      // Rank is death order on-chain (1 = first to die; 0 = unknown/not persisted).
      ...(rn.deathRank > 0 ? { outlasted: outlastedFromRank(rn.deathRank) } : {}),
    }));
    const topKeepers = keeperRows
      .filter((rn) => rn.careCount > 0)
      .map((rn) => ({
        tokenId: rn.tokenId,
        serial: rn.serial,
        number: runnerNumber(rn.tokenId, rn.serial),
        careCount: rn.careCount,
      }));
    // Optional USD framing for the pot. The CARE token has not launched, so there
    // is no honest price source yet and we NEVER invent one: usdValue is simply
    // omitted. At token launch, set CARE_USD_PRICE (USD per whole CARE) in the
    // env (or swap this read for a real oracle/DEX quote) and every client's $
    // line snaps on. Read at request time so a flag flip needs no restart.
    const usdPrice = Number(process.env.CARE_USD_PRICE ?? "");
    let usdValue: number | undefined;
    if (Number.isFinite(usdPrice) && usdPrice > 0) {
      const base = 10n ** BigInt(snap.careTokenDecimals);
      const potCare = Number(snap.potRaw / base) + Number(snap.potRaw % base) / Number(base);
      usdValue = potCare * usdPrice;
    }
    res.setHeader("Cache-Control", "public, max-age=3");
    res.json({
      seasonActive: snap.seasonActive,
      // `total` is the supply CAP and is labelled as such by every client.
      // `registered` (minted) and `hatched` (fed at least once, so actually in
      // the race) are the REAL headcounts: without them the site divided by the
      // cap and read "1 / 2,000 alive" when two pets existed.
      survivors: {
        alive,
        total: snap.total,
        fallen,
        registered: snap.seasonActive ? snap.registered : minted,
        hatched: snap.seasonActive ? snap.hatched : 0,
      },
      pot: { display: formatCareToken(snap.potRaw), raw: snap.potRaw.toString() },
      recentDeaths,
      topKeepers,
      ...(usdValue !== undefined ? { usdValue } : {}),
    });
  }));

  // Shed an over-capacity render as a retryable 503 (see boundedRaster in pet.ts).
  const renderBusy = (res: import("express").Response) => {
    res.setHeader("Retry-After", "2");
    return res.status(503).json({ error: "render busy" });
  };

  // 5. Runner card PNG (metadata image + email hero).
  r.get("/api/runner/:serial/card.png", wrap(async (req, res) => {
    const runner = await ctx.store.getRunner(req.params.serial!);
    if (!runner) return res.status(404).json({ error: "not found" });
    const snap = getSeasonSnapshot();
    let png: Buffer;
    try {
      const vis = petVisualFor(runner, new Date());
      png = await petCardPng({
      mood: moodFor(runner, new Date()),
      toys: runner.toys,
      number: runnerNumber(runner.tokenId, runner.serial),
      seed: runner.tokenId ?? runner.serial,
      variant: runner.won ? "victory" : runner.gone ? "memorial" : "alive",
      stage: vis.stage,
      shellCap: vis.shellCap,
      survivorCount: snap.seasonActive ? { alive: snap.aliveCount, total: snap.total } : undefined,
      stats: config.STATS_BAND_ENABLED && snap.seasonActive ? passStatsFrom(snap) : undefined,
      potDisplay: runner.won ? `${formatCareToken(BigInt(runner.wonPrize || "0"))} CARE` : undefined,
      memorial: runner.gone
        ? {
            livedDays: memorialLivedDays(runner),
            cared: runner.careCount,
            outlasted: runner.deathRank > 0 ? outlastedFromRank(runner.deathRank) : undefined,
          }
        : undefined,
      });
    } catch (err) {
      if (err instanceof RenderBusyError) return renderBusy(res);
      throw err;
    }
    res.setHeader("Content-Type", "image/png");
    res.setHeader("Cache-Control", "public, max-age=30");
    res.send(png);
  }));

  // 5a2. WIDE hero PNG for the Google Wallet loyalty object. Google's heroImage is
  // a roughly 3:1 slot, and it used to be fed the SQUARE card render above, which
  // Android drew tall and cropped. This is the same pet composed for that ratio.
  // Serial-keyed and public for the same reason card.png is: Google fetches the
  // URL itself, unauthenticated, and drops the art silently if it 401s.
  // Apple and the NFT metadata still take card.png, untouched.
  r.get("/api/runner/:serial/hero.png", wrap(async (req, res) => {
    const runner = await ctx.store.getRunner(req.params.serial!);
    if (!runner) return res.status(404).json({ error: "not found" });
    const snap = getSeasonSnapshot();
    let png: Buffer;
    try {
      const vis = petVisualFor(runner, new Date());
      png = await petHeroPng({
        mood: moodFor(runner, new Date()),
        toys: runner.toys,
        seed: runner.tokenId ?? runner.serial,
        name: petName(runner.tokenId),
        number: runnerNumber(runner.tokenId, runner.serial),
        stage: vis.stage,
        shellCap: vis.shellCap,
        stats: config.STATS_BAND_ENABLED && snap.seasonActive && !runner.gone ? passStatsFrom(snap) : undefined,
      });
    } catch (err) {
      if (err instanceof RenderBusyError) return renderBusy(res);
      throw err;
    }
    res.setHeader("Content-Type", "image/png");
    res.setHeader("Cache-Control", "public, max-age=30");
    res.send(png);
  }));

  // 5b. Public SQUARE preview by tokenId (traits are tokenId-derived, so this works
  // pre-mint: the site hero/showcase can render sample pets #1/#87/#500 without a DB
  // row). Clean branded tile, happy pose. Cacheable.
  r.get("/api/pet/:tokenId([0-9]+)/preview.png", wrap(async (req, res) => {
    const tokenId = req.params.tokenId!;
    // Bound the render key space to real ids (1..supply cap): out-of-range ids
    // would each be a distinct cache-busting raster for free.
    const idNum = Number(tokenId);
    if (!Number.isSafeInteger(idNum) || idNum < 1 || idNum > config.RUNNER_SUPPLY_CAP) {
      return res.status(404).json({ error: "not found" });
    }
    // Optional ?stage=0..3 forces the evolution stage (egg / hatchling / grown /
    // prime) for the site's evolution showcase. Omitted = the pet's default look.
    // v2-only: with the trait flag off, stage is ignored (byte-identical render).
    let stage: import("./stage.js").Stage | undefined;
    const sq = Number(req.query.stage);
    if (config.TRAITS_V2_ENABLED && (sq === 0 || sq === 1 || sq === 2 || sq === 3)) stage = sq;
    let png: Buffer;
    try {
      png = await petPortraitPng({
        seed: tokenId,
        // Stage 0 is the pre-hatch EGG, which the renderer draws from mood "egg"
        // (not the stage scale). Later stages render the pet at their size.
        mood: stage === 0 ? "egg" : "happy",
        number: `No. ${tokenId.padStart(4, "0")}`,
        stage,
        shellCap: stage === 1, // the eggshell cap remnant on a fresh hatchling
      });
    } catch (err) {
      if (err instanceof RenderBusyError) return renderBusy(res);
      throw err;
    }
    res.setHeader("Content-Type", "image/png");
    res.setHeader("Cache-Control", "public, max-age=86400"); // traits + stage are immutable per (id, stage)
    res.send(png);
  }));

  // 5c. Square portrait for a MINTED pet (reflects its live mood + toys). Serial-keyed.
  r.get("/api/runner/:serial/portrait.png", wrap(async (req, res) => {
    const runner = await ctx.store.getRunner(req.params.serial!);
    if (!runner) return res.status(404).json({ error: "not found" });
    let png: Buffer;
    try {
      const vis = petVisualFor(runner, new Date());
      png = await petPortraitPng({
        seed: runner.tokenId ?? runner.serial,
        mood: moodFor(runner, new Date()),
        toys: runner.toys,
        number: runnerNumber(runner.tokenId, runner.serial),
        stage: vis.stage,
        shellCap: vis.shellCap,
      });
    } catch (err) {
      if (err instanceof RenderBusyError) return renderBusy(res);
      throw err;
    }
    res.setHeader("Content-Type", "image/png");
    res.setHeader("Cache-Control", "public, max-age=30");
    res.send(png);
  }));

  // 6. Public runner state. Lazily reconciles idle ticks so a sleeping server
  // catches up on read.
  r.get("/api/runner/:serial", wrap(async (req, res) => {
    let runner = await ctx.store.getRunner(req.params.serial!);
    if (!runner) return res.status(404).json({ error: "not found" });
    try {
      runner = await reconcilePet(ctx, runner, { now: new Date() });
    } catch (err) {
      logger.error({ err: String(err), serial: runner.serial }, "idle reconcile on read failed");
    }
    // Like the Apple pass URL above (runnerStatusView), the Google save URL is a
    // capability: withheld from this public serial-keyed view while real-value
    // care is possible. Owners get it from the mint/pass-link/claim channels.
    let googleSaveUrl: string | null = null;
    if (!realValueCarePossible()) {
      try {
        googleSaveUrl = await getRunnerGoogle().saveUrl(runner);
      } catch {
        googleSaveUrl = null;
      }
    }
    // Live life-status extras for the site's status banner + /claim (secondsLeft
    // is authoritative from the vault when the season is live; omitted before).
    const live = await petLiveStatus(ctx, runner);
    // FIVE-NEEDS payload (8.2), ALIVE-GATED: per-need countdowns in canonical
    // action order (clients sort for display) + lastActionAt = max(needsOf),
    // the true last-care instant (recency display; deadline math stays on the
    // min-keyed secondsLeft). OMITTED for a dormant egg (no timers yet) and for
    // a dead pet (frozen stamps would show phantom hours).
    let needsPayload: { action: string; label: string; secondsLeft: number }[] | undefined;
    let lastActionAt: number | undefined;
    if (
      config.modes.survivalLive &&
      runner.tokenId &&
      runner.hatched &&
      !runner.gone &&
      live.status !== "dead"
    ) {
      try {
        const [{ needAt }, vcfg] = await Promise.all([
          cachedPetNeeds(ctx, runner.tokenId),
          getVaultConfig(ctx),
        ]);
        if (needAt.some((t) => t > 0)) {
          const left = needsSecondsLeft(needAt, vcfg.lifeTtlSeconds, Math.floor(Date.now() / 1000));
          needsPayload = NEED_ACTIONS.map((action, i) => ({
            action,
            label: NEED_LABELS[i]!,
            secondsLeft: left[i]!,
          }));
          lastActionAt = Math.max(...needAt);
        }
      } catch {
        /* best effort: the payload simply omits needs */
      }
    }
    // A short shared-cache window lets Cloudflare absorb a polling crowd on one
    // pet page; the payload is already serial-keyed and capability-free.
    res.setHeader("Cache-Control", "public, max-age=5");
    res.json({
      ...runnerStatusView(runner, { relayerAddress: ctx.relayer.address }),
      googleSaveUrl: googleSaveUrl ?? undefined,
      secondsLeft: live.secondsLeft,
      daysLived: live.daysLived,
      careCount: live.careCount ?? runner.careCount,
      ...(needsPayload ? { needs: needsPayload, lastActionAt } : {}),
    });
  }));

  // 8. ERC-721 metadata (keyed by tokenId). Image-only living card hero: no
  // animation_url (the game is retired). Live status attributes come from the
  // authoritative on-chain vault state when the season is live (DB flags before).
  // HONEST: OpenSea caches this JSON; the /pet page is the always-live source.
  // The opensea.ts refresh pings nudge their cache on death/critical flips.
  // Care Balance attribute cache: the pet's TBA token balance is a per-pet RPC
  // read and marketplace crawlers hammer metadata, so bound it hard. Best
  // effort: a read failure omits the attribute rather than failing the JSON.
  const careBalCache = new Map<string, { whole: number; at: number }>();
  const CARE_BAL_TTL_MS = 60_000;
  const careBalanceWhole = async (runner: Runner): Promise<number | null> => {
    if (!runner.tbaAddress) return null;
    const hit = careBalCache.get(runner.serial);
    if (hit && Date.now() - hit.at < CARE_BAL_TTL_MS) return hit.whole;
    try {
      const raw = await ctx.relayer.careBalanceOf(runner.tbaAddress);
      const decimals = getSeasonSnapshot().careTokenDecimals;
      const whole = Number(raw / 10n ** BigInt(Math.max(0, decimals)));
      careBalCache.set(runner.serial, { whole, at: Date.now() });
      if (careBalCache.size > 4000) careBalCache.clear(); // bounded, 2k pets x 2 keys worst case
      return whole;
    } catch {
      return hit ? hit.whole : null;
    }
  };

  r.get("/metadata/runner/:tokenId", wrap(async (req, res) => {
    const runner = await ctx.store.getRunnerByTokenId(req.params.tokenId!);
    if (!runner) return res.status(404).json({ error: "not found" });
    const live = await petLiveStatus(ctx, runner);
    const statusLabel = live.status === "dead" ? "Dead" : live.status === "critical" ? "Critical" : "Alive";
    // display_type "number" puts the numeric attrs in the marketplace stats
    // section with range filters (searchable "amount fed", balance, age).
    const num = (trait_type: string, value: number) => ({ display_type: "number", trait_type, value });
    const lifeAttributes: Array<Record<string, string | number>> = [
      // Filterable on any marketplace, and it makes the name part of the provenance rather than just
      // a label we render. Deterministic from tokenId, so it is verifiable, not asserted.
      { trait_type: "Name", value: petName(runner.tokenId) },
      { trait_type: "Status", value: statusLabel },
    ];
    if (live.status !== "dead" && live.secondsLeft !== undefined) {
      lifeAttributes.push({ trait_type: "Life Left", value: lifeLeftLabel(live.secondsLeft) });
    }
    if (live.daysLived !== undefined) {
      lifeAttributes.push(num("Days Lived", live.daysLived));
    }
    lifeAttributes.push(num("Care Count", live.careCount ?? runner.careCount));
    // The pet's own bank account, as a wallet-visible flex: whole CARE tokens.
    const careBal = await careBalanceWhole(runner);
    if (careBal !== null) lifeAttributes.push(num("Care Balance", careBal));
    // Evolution stage (v2 only, so flag-off metadata is byte-identical to today).
    // Title-cased stage name, derived from the same stageFor the art uses.
    if (config.TRAITS_V2_ENABLED) {
      lifeAttributes.push({ trait_type: "Stage", value: STAGE_NAMES[stageFor(runner, new Date())] ?? "Egg" });
    }
    // Marketplace crawlers re-fetch aggressively; let the CDN absorb repeats.
    res.setHeader("Cache-Control", "public, max-age=15");
    res.json({
      // The pet's own NAME, not its serial. "No. 0002" is a receipt; this is a pet you keep alive for
      // weeks and grieve when it dies, so it gets called something. Derived purely from tokenId
      // (runner/names.ts), so any holder can recompute it without trusting this server, and it exists
      // before the pet is minted. The number is preserved in the attributes below.
      name: `${petName(runner.tokenId)} (${RUNNER_THEME.nftName} #${runner.tokenId})`,
      description: `${RUNNER_THEME.description}. ${RUNNER_THEME.tagline}`,
      image: `${config.PUBLIC_BASE_URL}/api/runner/${runner.serial}/card.png`,
      external_url: `${config.WEB_APP_URL}/pet/${runner.serial}`,
      attributes: [
        ...traitAttributes(runner.tokenId ?? runner.serial),
        ...lifeAttributes,
        num("Hunger", runner.hunger),
        num("Thirst", runner.thirst),
        num("Joy", runner.joy),
        num("Toys", runner.toys),
        { trait_type: "Hatched", value: runner.hatched ? "Yes" : "No" },
      ],
    });
  }));

  // Collection-level metadata (ERC-7572 contractURI target): marketplaces read
  // this for the collection name, description, and imagery.
  r.get("/api/collection.json", (_req, res) => {
    res.setHeader("Cache-Control", "public, max-age=3600");
    res.json({
      name: RUNNER_THEME.gameName,
      description: `${RUNNER_THEME.description}. ${RUNNER_THEME.tagline}`,
      image: `${config.PUBLIC_BASE_URL}/assets/logo.png`,
      external_link: config.WEB_APP_URL,
    });
  });

  // Serve the .pkpass bytes (shared by the capability + legacy download routes).
  async function serveRunnerPass(
    req: import("express").Request,
    res: import("express").Response,
    runner: Runner,
  ) {
    const since = req.headers["if-modified-since"];
    if (since && new Date(since).getTime() >= runner.updatedAt.getTime()) {
      return res.status(304).end();
    }
    // The combined five-need field straight from the vault when live + alive
    // (null falls back to the DB percents inside the assembler). Both reads
    // share the cached petNeeds fetch. The live CARE balance (the pet's own
    // TBA holdings) is read fresh here too; null omits its header field.
    const needPct = await petNeedPctFor(ctx, runner);
    const needSecondsLeft = await petNeedSecondsLeftFor(ctx, runner);
    const careBalance = await petCareBalanceFor(ctx, runner);
    const setupNudge = await setupNudgeFor(ctx, runner);
    const { buffer, signed } = await generateRunnerPkpass(runner, { needPct, needSecondsLeft, careBalance, setupNudge });
    res.setHeader("Content-Type", "application/vnd.apple.pkpass");
    res.setHeader(
      "Content-Disposition",
      `attachment; filename="walletchi-${runner.serial}.pkpass"`,
    );
    res.setHeader("Last-Modified", runner.updatedAt.toUTCString());
    if (!signed) res.setHeader("X-Walletchi-Pass", "unsigned-stub");
    res.send(buffer);
  }

  // 9. Downloadable runner pass, capability URL (the canonical download). The
  // pass embeds the already-signed care links, so the :cap segment must be an
  // unguessable secret: HMAC of the pet's authToken (see sign.ts), rotated with
  // it on every claim. Wrong or malformed caps are indistinguishable from an
  // unknown serial (opaque 404, constant-time compare).
  r.get("/runner-passes/:serial/:cap.pkpass", wrap(async (req, res) => {
    const runner = await ctx.store.getRunner(req.params.serial!);
    if (!runner || !verifyPassDownloadCap(runner.authToken, req.params.cap)) {
      return res.status(404).json({ error: "not found" });
    }
    return serveRunnerPass(req, res, runner);
  }));

  // 9b. LEGACY public download (serial only). The serial leaks via public
  // metadata, so this route is a rival-drain vector whenever care moves real
  // value: it stays available ONLY while real-value care is affirmatively OFF
  // (demo / pre-season). Fail-secure 404 otherwise, before any lookup.
  r.get("/runner-passes/:serial.pkpass", wrap(async (req, res) => {
    if (realValueCarePossible()) {
      return res.status(404).json({ error: "not found" });
    }
    const runner = await ctx.store.getRunner(req.params.serial!);
    if (!runner) return res.status(404).json({ error: "not found" });
    return serveRunnerPass(req, res, runner);
  }));

  // 10. Save to Google Wallet redirect for a runner (501 in stub). Serial-only
  // and public, so it gets the SAME fail-secure gate as the legacy Apple route
  // above: while real-value care is possible a signed Google save URL (whose
  // pass mirrors the pet + its links) must not be mintable from a bare serial.
  // Owners get their save URL from the mint email / pass-link / claim channels.
  r.get("/google/runner/save/:serial", wrap(async (req, res) => {
    if (realValueCarePossible()) {
      return res.status(404).json({ error: "not found" });
    }
    const runner = await ctx.store.getRunner(req.params.serial!);
    if (!runner) return res.status(404).json({ error: "not found" });
    const url = await getRunnerGoogle().saveUrl(runner);
    if (!url) {
      return res
        .status(501)
        .json({ error: "Google Wallet not configured (set GOOGLE_SA_KEY_BASE64 + GOOGLE_ISSUER_ID)" });
    }
    res.redirect(302, url);
  }));

  return r;
}
