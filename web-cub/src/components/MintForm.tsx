"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { PetSprite } from "./PetSprite";
import { PetPortrait } from "./PetPortrait";
import { FundFlow } from "./FundFlow";
import { PrivyGate, type PrivySessionInfo } from "./PrivyGate";
import { MintClosed } from "./MintClosed";
import { AppleGlyph, GoogleGlyph } from "./WalletPass";
import { SELF_CUSTODY_ENABLED } from "@/lib/privy";
import {
  createRunnerCheckout,
  getRunnerCheckout,
  fetchMintPassLink,
  getSeasonStats,
  sessionId,
  runnerLinks,
  ApiError,
  type MintExtras,
  type RunnerSession,
} from "@/lib/api";
import { BRAND, CARE_TOKEN_READY, SEASON, STARTER_DAYS } from "@/lib/brand";
import {
  fetchMintChallenge,
  solvePowChallenge,
  collectFingerprint,
  collectBotSignals,
  type PowChallenge,
  type PowSolution,
} from "@/lib/sybil";
import { loadTurnstileScript, turnstileApi } from "@/lib/turnstile";
import { fetchLiveChainConfig } from "@/lib/chain-config";
import { safeUrl } from "@/lib/safe-url";
import { detectBrowserContext, inAppLabel, type BrowserContext } from "@/lib/browser-context";

type Stage = "idle" | "submitting" | "minting" | "done" | "error";

// Machine codes the anti-Sybil gate can return. The server's `error` copy is
// already kind, so we show it verbatim for these instead of the generic
// "adoption closed" fallback (which would read wrong for e.g. already_minted).
const SYBIL_CODES = new Set([
  "already_minted",
  "pow_required",
  "pow_invalid",
  "disposable_email",
  "bot_detected",
  "too_fast",
  "too_many",
  // The split velocity codes (adc9634): only fire when VELOCITY_CAPS_ENFORCED
  // is on, but without them here an enforced block would show the generic
  // "adoption closed" copy instead of the server's kind explanation.
  "too_many_ip",
  "too_many_subnet",
  "too_many_fingerprint",
  "sybil_blocked",
  // Server refused a custodial mint (self-custody required): its copy already
  // tells the user to sign in, so show it verbatim.
  "self_custody_required",
  // Wallet-only sign-in tried to mint: minting is email-only by design. The
  // server copy explains both exits (add an email, or the Claim page for a
  // secondary buy); the error card adds a real link to /claim for that code.
  "verified_email_required",
  // Mint-time captcha (STEP 8C): both refusals carry their own recovery copy.
  "captcha_required",
  "captcha_invalid",
  // Device mark (one Chi per phone): the server copy explains it, and the error
  // card offers "Open my pet" like already_minted.
  "device_already_minted",
  // Showcase hourly mint budget spent (HTTP 429). The server sentence already says
  // when to come back ("try again in N minutes"); the generic 4xx fallback below
  // would have replaced it with "Adoption is not open", which is false.
  "mint_busy",
  // Per-IP HTTP rate limit (many minters on one wifi): the server says "slow down a
  // moment", which is true; "Adoption is not open" is not.
  "rate_limited",
]);

const POLL_MS = 2000;
// PATIENCE (launch fix 5). The old rule was a flat 120 s: after that the keeper
// read "taking much longer than usual" and was sent to their inbox, while their
// pet was still queued behind a burst and about to land. Now 120 s is how long
// we tolerate NO SIGN OF LIFE from the server; every poll that carries a queue
// position (the mint is alive: queued or broadcast) resets that clock, and only
// a terminal status (ready, failed) ends the wait. The absolute cap is the
// "never poll forever" backstop, sized to a full collection draining through
// the relayer at a few mints a second: nothing legitimate outlasts it.
const POLL_TIMEOUT_MS = 120_000;
const POLL_ABSOLUTE_CAP_MS = 30 * 60_000;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
/** The emailed sign-in code is always six digits: one per box. */
const CODE_LEN = 6;
/** Seconds before "Resend code" unlocks again. Stops the panic double-send and
    keeps a bored visitor from hammering Privy. */
const RESEND_LOCK_S = 30;
/** A fresh, empty row. Never share one array: each box position must stay put. */
const emptyCode = () => Array<string>(CODE_LEN).fill("");

const MINT_STEPS = ["Laying your egg", "Tucking it into your wallet", "Warming it up"];

/** "about 20 seconds" / "about 3 minutes": the server's ETA is already rounded up to 5 s. */
function queueWait(etaSec: number): string {
  if (etaSec < 60) return `about ${etaSec} seconds`;
  const mins = Math.ceil(etaSec / 60);
  return `about ${mins} minute${mins === 1 ? "" : "s"}`;
}

/**
 * Privy-aware entry: when the visitor is signed in, the mint carries their
 * access token + wallet so the server mints the pet straight to THEIR wallet
 * (non-custodial). Signed out, or with Privy unconfigured, the email-only
 * custodial mint runs exactly as before.
 */
export function MintForm() {
  return (
    <PrivyGate fallback={<MintFormInner privy={null} />}>
      {(s) => <MintFormInner privy={s} />}
    </PrivyGate>
  );
}

/** Season closed: the whole supply is minted, so minting gives way to this. */
function SoldOutCard() {
  return (
    <div className="soft-card p-6 text-center sm:p-7" style={{ maxWidth: 460 }}>
      <div
        className="mx-auto mb-3 grid h-14 w-14 place-items-center rounded-2xl"
        style={{ background: "var(--color-lav-soft)", fontSize: 26 }}
        aria-hidden
      >
        🥚
      </div>
      {/* Minted, not hatched: an egg only hatches on its first care, so the
          sold-out state cannot claim the whole supply is in the race. */}
      <div className="display" style={{ fontSize: "1.5rem" }}>
        All {BRAND.supply.toLocaleString()} pets are out
      </div>
      <p className="mx-auto mt-2 max-w-sm text-sm" style={{ color: "var(--color-ink-soft)" }}>
        Every {BRAND.name} in this Testnet Experience has a keeper now, and only one will outlast
        the rest to take the Pot. Watch it play out live, or get one from a keeper and claim its
        pass.
      </p>
      <div className="mt-5 flex flex-wrap justify-center gap-3">
        <a href="/arena" className="btn btn-cub">
          Watch the Arena
        </a>
        <a href="/claim" className="btn btn-ghost">
          Got one from someone? Claim its pass
        </a>
      </div>
    </div>
  );
}

/**
 * The code row: six separate boxes, the 2FA pattern every keeper already knows
 * from their bank. Typing auto-advances, backspace walks back and clears, arrows
 * navigate, and pasting the code (or a whole "your code is 123456" line) into ANY
 * box fills all six at once, which is the path most people actually take.
 *
 * Deliberately NO placeholder. The old single field said "123456" in grey and
 * testers read that as a real, already-entered value and skipped it.
 *
 * The row is held as a fixed six-slot array (not a string) so an empty box in the
 * middle stays an empty box instead of silently shifting the digits left.
 */
function CodeBoxes({
  value,
  onChange,
  disabled,
  invalid,
  focusKey,
  describedBy,
}: {
  value: string[];
  onChange: (next: string[]) => void;
  disabled?: boolean;
  invalid?: boolean;
  /** Bump to pull focus back to box one: the step opening, or a wrong code wiping the row. */
  focusKey: number;
  describedBy?: string;
}) {
  const refs = useRef<Array<HTMLInputElement | null>>([]);

  const focusBox = useCallback((i: number) => {
    const el = refs.current[Math.max(0, Math.min(CODE_LEN - 1, i))];
    if (!el) return;
    el.focus();
    // Select what is there so the next keystroke replaces it instead of
    // appending: that is what keeps a single character per box.
    el.select();
  }, []);

  useEffect(() => {
    // Next tick, so the boxes exist (and any disabled state has settled) before
    // the caret lands on box one.
    const t = setTimeout(() => focusBox(0), 0);
    return () => clearTimeout(t);
  }, [focusKey, focusBox]);

  const setAt = (i: number, digit: string) => {
    const next = [...value];
    next[i] = digit;
    onChange(next);
  };

  /** Write a run of digits starting at `start`, then park focus after the last one. */
  const fillFrom = (start: number, digits: string) => {
    const next = [...value];
    let i = start;
    for (const d of digits) {
      if (i >= CODE_LEN) break;
      next[i] = d;
      i += 1;
    }
    onChange(next);
    focusBox(i);
  };

  const handleChange = (i: number, raw: string) => {
    const digits = raw.replace(/\D/g, "");
    if (!digits) {
      setAt(i, "");
      return;
    }
    if (digits.length === 1) {
      setAt(i, digits);
      focusBox(i + 1);
      return;
    }
    // Two characters where the first is what was already here: a typed-over box
    // (the caret sat after the old digit), so keep the new one.
    const cur = value[i] ?? "";
    if (digits.length === 2 && cur && digits[0] === cur) {
      setAt(i, digits[1]);
      focusBox(i + 1);
      return;
    }
    // Anything longer is a paste or an OS one-time-code autofill: a full code
    // always starts at box one, a partial run continues from here.
    fillFrom(digits.length >= CODE_LEN ? 0 : i, digits.slice(0, CODE_LEN));
  };

  const handleKeyDown = (i: number, e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "Backspace") {
      e.preventDefault();
      if (value[i]) {
        setAt(i, "");
        return;
      }
      if (i > 0) {
        const next = [...value];
        next[i - 1] = "";
        onChange(next);
        focusBox(i - 1);
      }
      return;
    }
    if (e.key === "Delete") {
      e.preventDefault();
      setAt(i, "");
      return;
    }
    if (e.key === "ArrowLeft") {
      e.preventDefault();
      focusBox(i - 1);
      return;
    }
    if (e.key === "ArrowRight") {
      e.preventDefault();
      focusBox(i + 1);
    }
  };

  const handlePaste = (i: number, e: React.ClipboardEvent<HTMLInputElement>) => {
    const digits = e.clipboardData.getData("text").replace(/\D/g, "");
    if (!digits) return;
    e.preventDefault();
    fillFrom(digits.length >= CODE_LEN ? 0 : i, digits.slice(0, CODE_LEN));
  };

  return (
    <div
      className={`otp-row${invalid ? " is-error" : ""}`}
      role="group"
      aria-label={`${CODE_LEN} digit code from your email`}
      aria-describedby={describedBy}
    >
      {Array.from({ length: CODE_LEN }, (_, i) => (
        <input
          key={i}
          ref={(el) => {
            refs.current[i] = el;
          }}
          className={`otp-box${value[i] ? " is-filled" : ""}`}
          type="text"
          inputMode="numeric"
          pattern="[0-9]*"
          // The OS autofill hook belongs on the first box only; the handler above
          // spreads the delivered code across all six.
          autoComplete={i === 0 ? "one-time-code" : "off"}
          aria-label={`Digit ${i + 1} of ${CODE_LEN}`}
          value={value[i] ?? ""}
          disabled={disabled}
          onChange={(e) => handleChange(i, e.target.value)}
          onKeyDown={(e) => handleKeyDown(i, e)}
          onPaste={(e) => handlePaste(i, e)}
          onFocus={(e) => e.currentTarget.select()}
        />
      ))}
    </div>
  );
}

function MintFormInner({ privy }: { privy: PrivySessionInfo | null }) {
  const [stage, setStage] = useState<Stage>("idle");
  const [email, setEmail] = useState("");
  const [session, setSession] = useState<RunnerSession | null>(null);
  const [error, setError] = useState("");
  // Machine code behind `error`, kept so the error card can offer a real exit
  // for codes that have one (verified_email_required links to /claim).
  const [errorCode, setErrorCode] = useState("");
  const [note, setNote] = useState("");
  const [step, setStep] = useState(0);
  // The keeper's place in line while the mint is queued or broadcast (from the poll).
  const [queue, setQueue] = useState<NonNullable<RunnerSession["queue"]> | null>(null);
  // When the whole supply is minted, the email form gives way to a closed state.
  const [soldOut, setSoldOut] = useState(false);
  // Self-custody (Privy) inline flow: email -> code -> auto-mint. `phase` picks
  // the front (email vs code); `pendingMint` means the code verified and we're
  // waiting on the embedded wallet so the mint can fire itself. Both are inert on
  // the custodial (Privy-unconfigured) path, which never leaves phase "email".
  const [phase, setPhase] = useState<"email" | "code">("email");
  // One slot per box, so a gap in the middle stays a gap (see CodeBoxes).
  const [code, setCode] = useState<string[]>(emptyCode);
  // Bumped to send focus back to box one: the code step opening, a resend, or a
  // wrong code wiping the row.
  const [codeFocusKey, setCodeFocusKey] = useState(0);
  // A friendly line under the boxes (currently only "we sent a new one").
  const [codeNote, setCodeNote] = useState("");
  // Seconds left on the resend lockout. 0 = the link is live again.
  const [resendIn, setResendIn] = useState(0);
  // Our own verifying flag. Privy's otpStatus lags a render behind the call, and
  // `pendingMint` swaps the whole card for the wallet takeover, so this is what
  // keeps the code screen up (button spinning, boxes locked) while the code is
  // actually being checked. Without it a wrong code flashes "Setting up your
  // wallet" for a frame and then bounces back, which reads as a glitch.
  const [verifying, setVerifying] = useState(false);
  const [pendingMint, setPendingMint] = useState(false);
  // Fires the auto-mint exactly once per verified sign-in (the wallet address can
  // settle across several renders; without this the mint could fire twice).
  const autoMintFiredRef = useRef(false);
  // Fires the code submit exactly once when all 6 digits land (guards a paste
  // that lands the full code in one change from also firing on a later render).
  const codeSubmitRef = useRef(false);
  // One-tap arming runs once, right after the pet is ready, while the keeper is still
  // on the page. null = not attempted, true/false = the outcome.
  const [armed, setArmed] = useState<boolean | null>(null);
  // Set when the live season is sellout-gated and has NOT started, so the copy
  // after a mint can explain the wait instead of reporting a fault.
  const [seasonPending, setSeasonPending] = useState<{ minted: number; maxSupply: number } | null>(null);
  const [arming, setArming] = useState(false);
  const armedOnceRef = useRef(false);
  const pollRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const stepRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const resendRef = useRef<ReturnType<typeof setInterval> | null>(null);
  // Poll generation: bumped by every stopTimers(), so a poll whose answer arrives
  // after the flow stopped (terminal state, a new mint, unmount) finds itself
  // retired and neither writes state nor schedules another poll.
  const pollGenRef = useRef(0);
  // The mint-session token only comes back on the initial POST; the poll's GET
  // responses overwrite `session` without it, so keep it here for PetReady.
  const mintSessionRef = useRef<string | undefined>(undefined);
  // Anti-Sybil client pieces. The PoW starts solving on mount (in a worker, or
  // chunked on the main thread) so the ~1-3s of compute is finished long before
  // a human is done typing an email; the "Readying your egg" state hides any
  // remainder. Everything is best-effort: when the server gate is off (or the
  // challenge endpoint unreachable) the mint proceeds exactly as before.
  const [honeypot, setHoneypot] = useState("");
  const challengeRef = useRef<PowChallenge | null>(null);
  const challengeAtRef = useRef<number>(0);
  const solutionRef = useRef<Promise<PowSolution> | null>(null);
  const fingerprintRef = useRef<string | undefined>(undefined);
  // DEVICE MARK (one Chi per phone): the random first-party cookie this site set for
  // this browser, read back through /api/mark (it is HttpOnly). Best effort: a failed
  // read sends no mark, and no mark never refuses a mint.
  const markRef = useRef<string | undefined>(undefined);
  // Mint-time captcha (Turnstile, STEP 8C). The challenge response advertises
  // it; empty site key = off, which is the default everywhere today. The token
  // lives in a ref because the widget callback fires outside React's flow.
  const [captchaSiteKey, setCaptchaSiteKey] = useState("");
  const captchaTokenRef = useRef("");
  const captchaWidgetIdRef = useRef<string | null>(null);
  const captchaBoxRef = useRef<HTMLDivElement | null>(null);

  // The live Privy session, read through a ref so priming the challenge can pick
  // up a token that arrived AFTER mount without re-running the mount effect (a
  // new effect run would throw away a challenge that is already being solved).
  const privyRef = useRef(privy);
  privyRef.current = privy;

  const primeChallenge = useCallback(async (): Promise<PowSolution | undefined> => {
    // Drop any previous challenge/solution first: a retry must never resubmit
    // a consumed nonce.
    challengeRef.current = null;
    solutionRef.current = null;
    challengeAtRef.current = 0;
    // Bind the challenge to the signed-in identity when there is one. Mainnet
    // REFUSES an unbound challenge, so a signed-in minter has to send the token.
    // Never wait on sign-in for it: an anonymous prime is the normal case on a
    // first visit, and the server re-issues a bound one on the mint retry.
    const p = privyRef.current;
    const token =
      p && p.ready && p.authenticated ? await p.getAccessToken().catch(() => null) : null;
    const challenge = await fetchMintChallenge(token);
    if (!challenge) return undefined;
    challengeRef.current = challenge;
    challengeAtRef.current = Date.now();
    setCaptchaSiteKey(
      challenge.captcha?.required && challenge.captcha.siteKey ? challenge.captcha.siteKey : "",
    );
    if (!challenge.required) return undefined; // gate off: skip the compute
    const solving = solvePowChallenge(challenge);
    solutionRef.current = solving;
    return solving.catch(() => undefined);
  }, []);

  useEffect(() => {
    void primeChallenge();
    collectFingerprint().then((fp) => {
      fingerprintRef.current = fp;
    });
    fetch("/api/mark", { credentials: "same-origin", cache: "no-store" })
      .then((r) => (r.ok ? r.json() : null))
      .then((j: { mark?: string } | null) => {
        if (j && typeof j.mark === "string") markRef.current = j.mark;
      })
      .catch(() => undefined);
    void fetchLiveChainConfig().then((cfg) => {
      const season = cfg?.season;
      setSeasonPending(
        season?.selloutStartsSeason && !season.started
          ? { minted: season.minted, maxSupply: season.maxSupply }
          : null,
      );
    });
    // Sold-out gate: swap the form for the closed state when the supply is gone.
    // `?soldout=1` forces the view for preview/QA without an actual sellout.
    const preview =
      typeof window !== "undefined" &&
      new URLSearchParams(window.location.search).get("soldout") === "1";
    if (preview) {
      setSoldOut(true);
      return;
    }
    getSeasonStats()
      .then((s) => {
        if (s?.soldOut) setSoldOut(true);
      })
      .catch(() => {});
  }, [primeChallenge]);

  // Render the Turnstile widget once the challenge advertises a captcha and the
  // container exists. Script load failure is tolerated: the server then refuses
  // with captcha_required and its copy tells the keeper what to do.
  useEffect(() => {
    if (!captchaSiteKey) return;
    let cancelled = false;
    void (async () => {
      try {
        await loadTurnstileScript();
        if (cancelled || captchaWidgetIdRef.current !== null) return;
        const ts = turnstileApi();
        const box = captchaBoxRef.current;
        if (!ts || !box) return;
        captchaWidgetIdRef.current = ts.render(box, {
          sitekey: captchaSiteKey,
          theme: "light",
          callback: (token: string) => {
            captchaTokenRef.current = token;
          },
          "expired-callback": () => {
            captchaTokenRef.current = "";
          },
          "error-callback": () => {
            captchaTokenRef.current = "";
          },
        });
      } catch {
        // Blocked script (adblock, CSP): nothing to render; the server-side
        // refusal copy carries the recovery.
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [captchaSiteKey]);

  // Signed-in nicety: prefill the email field once from the Privy account so a
  // returning user just taps the button. Still editable (the receipt email).
  const signedIn = Boolean(privy?.ready && privy.authenticated);
  const privyWallet = signedIn ? (privy?.walletAddress ?? null) : null;
  const prefilledRef = useRef(false);
  useEffect(() => {
    if (signedIn && privy?.email && !prefilledRef.current) {
      prefilledRef.current = true;
      setEmail((cur) => cur || privy.email || "");
    }
  }, [signedIn, privy?.email]);

  // Arm one-tap care the moment the pet exists, so the pass that lands in their wallet
  // already works on the first tap. This is the whole point: nobody should ever be sent
  // back to a website after their pass is in their wallet.
  const armNow = useCallback(async (s: RunnerSession) => {
    if (armedOnceRef.current) return;
    if (!privy?.armOneTapCare || !s.tokenId) return;
    armedOnceRef.current = true;
    setArming(true);
    try {
      setArmed(await privy.armOneTapCare(s.tokenId));
    } catch {
      setArmed(false);
    } finally {
      setArming(false);
    }
  }, [privy]);

  // FINISH SETUP (2026-09-23, tester Pretzel): a failed mint-time arming used to end with a note and
  // nothing to press, so the keeper left with a pet whose every pass tap opens the website. The
  // arming itself now retries and beacons its failure to the server (lib/arming.ts); this is the one
  // button that runs it again, in the same tab, while the keeper is still here.
  const retryArm = useCallback(async () => {
    if (!session?.tokenId || !privy?.armOneTapCare || arming) return;
    setArming(true);
    try {
      setArmed(await privy.armOneTapCare(session.tokenId));
    } catch {
      setArmed(false);
    } finally {
      setArming(false);
    }
  }, [session?.tokenId, privy, arming]);

  // The poll interval below is created ONCE (deliberately: adding armNow to its deps
  // would tear down and restart the interval on every Privy render). That means it
  // would otherwise capture the FIRST render's armNow, whose `wallets` array is still
  // empty because the embedded wallet does not exist until after the OTP verifies.
  // Arming would then no-op on the only path that actually runs. Route the call
  // through a ref so the interval always reaches the CURRENT closure.
  const armNowRef = useRef(armNow);
  useEffect(() => {
    armNowRef.current = armNow;
  }, [armNow]);

  const stopTimers = () => {
    pollGenRef.current += 1;
    if (pollRef.current) clearTimeout(pollRef.current);
    if (stepRef.current) clearInterval(stepRef.current);
    pollRef.current = null;
    stepRef.current = null;
  };
  useEffect(() => () => stopTimers(), []);

  // Resend lockout: one tick a second down to zero, then the link is live again.
  const startResendLock = useCallback(() => {
    if (resendRef.current) clearInterval(resendRef.current);
    setResendIn(RESEND_LOCK_S);
    resendRef.current = setInterval(() => {
      setResendIn((s) => {
        if (s <= 1) {
          if (resendRef.current) clearInterval(resendRef.current);
          resendRef.current = null;
          return 0;
        }
        return s - 1;
      });
    }, 1000);
  }, []);
  useEffect(
    () => () => {
      if (resendRef.current) clearInterval(resendRef.current);
    },
    [],
  );

  const startPolling = useCallback((id: string) => {
    stopTimers();
    setQueue(null);
    const gen = pollGenRef.current;
    const started = Date.now();
    // The last poll that proved the mint alive on the server (a place in line).
    let lastAlive = started;
    let slowNoteShown = false;
    stepRef.current = setInterval(() => setStep((s) => (s + 1) % MINT_STEPS.length), 1600);
    // ONE poll at a time (launch fix 5). A fixed setInterval fired every 2 s no matter
    // how long the last answer took, so under exactly the burst this flow exists for
    // (a slow server) every open tab stacked overlapping polls onto it. Each poll now
    // schedules the next only after its answer is handled.
    const poll = async () => {
      const s = await getRunnerCheckout(id);
      if (gen !== pollGenRef.current) return; // stopped while this poll was in flight
      if (s) {
        setSession(s);
        if (s.status === "ready") {
          stopTimers();
          setQueue(null);
          setStage("done");
          void armNowRef.current(s);
          return;
        } else if (s.status === "failed" || s.failureReason) {
          // Terminal failure: stop at once, whatever the queue said before.
          stopTimers();
          setQueue(null);
          setError(s.failureReason || "The egg got a little shy on its way out. Please try again.");
          setStage("error");
          return;
        }
        if (s.queue) {
          // Alive: queued or on the chain. Keep waiting, and say where they stand.
          lastAlive = Date.now();
          setQueue(s.queue);
          if (slowNoteShown) {
            slowNoteShown = false;
            setNote("");
          }
        } else {
          // Still minting but no place in line: the server is not driving this mint
          // right now (a restart re-attaching it, or the post-chain pass steps). Not
          // proof of life, so the quiet clock keeps running.
          setQueue(null);
        }
      }
      const now = Date.now();
      // Hard stop: never poll forever. The emailed pass is the fallback. Only when the
      // server has gone quiet about this mint (no place in line and no terminal answer
      // for POLL_TIMEOUT_MS: unreachable, rate limited, or a row nobody is driving), or
      // at the absolute cap.
      if (now - lastAlive > POLL_TIMEOUT_MS || now - started > POLL_ABSOLUTE_CAP_MS) {
        stopTimers();
        setQueue(null);
        setError(
          "Your egg is taking much longer than usual. If it hatched, its card is in your email; otherwise give it another go.",
        );
        setStage("error");
        return;
      }
      if (now - lastAlive > POLL_TIMEOUT_MS / 2 && !slowNoteShown) {
        slowNoteShown = true;
        setNote("Almost there, your egg is taking its time.");
      }
      pollRef.current = setTimeout(() => void poll(), POLL_MS);
    };
    pollRef.current = setTimeout(() => void poll(), POLL_MS);
  }, []);

  const submit = useCallback(async () => {
    const clean = email.trim();
    if (!EMAIL_RE.test(clean)) {
      setError("Pop in a real email so we can send your pet home.");
      setStage("idle");
      return;
    }
    setError("");
    setNote("");
    setStage("submitting");

    const buildExtras = async (): Promise<MintExtras> => {
      // Await the mount-time solve (usually already settled); pow stays absent
      // when the challenge fetch failed or the gate did not require one.
      const pow = solutionRef.current
        ? await solutionRef.current.catch(() => undefined)
        : undefined;
      return {
        ...(pow ? { pow } : {}),
        ...(fingerprintRef.current ? { fingerprint: fingerprintRef.current } : {}),
        ...(markRef.current ? { mark: markRef.current } : {}),
        honeypot,
        elapsedMs: challengeAtRef.current ? Date.now() - challengeAtRef.current : undefined,
        botSignals: collectBotSignals(),
        ...(captchaTokenRef.current ? { captchaToken: captchaTokenRef.current } : {}),
      };
    };

    // Signed in with a wallet: the server verifies this token and mints the
    // pet to the user's own wallet. Best-effort: a token hiccup simply falls
    // back to the custodial mint (never blocks the happy path).
    const buildPrivyOpts = async () => {
      if (!privy || !signedIn || !privyWallet) return undefined;
      const token = await privy.getAccessToken().catch(() => null);
      return token ? { privyToken: token, walletAddress: privyWallet } : undefined;
    };

    try {
      let s: RunnerSession;
      const privyOpts = await buildPrivyOpts();
      try {
        s = await createRunnerCheckout(clean, await buildExtras(), privyOpts);
      } catch (err) {
        // The server wanted (fresh) proof-of-work: solve a new challenge and
        // retry once. Covers a stale/consumed nonce or the gate flipping on
        // after this page primed with required:false.
        if (
          err instanceof ApiError &&
          (err.code === "pow_required" || err.code === "pow_invalid")
        ) {
          await primeChallenge();
          // THE RETRY MUST NOT REFUSE ITSELF. The fresh challenge is seconds
          // old and the server enforces a minimum age server-side (too_fast),
          // plus checks our self-reported elapsedMs against the same floor.
          // Production logs showed real minters cycling pow_invalid ->
          // too_fast through this exact path. Wait out the advertised floor
          // (small margin for clock skew), THEN build extras so the reported
          // elapsedMs reflects the wait.
          const floor = (challengeRef.current?.minElapsedMs ?? 1500) + 250;
          const age = challengeAtRef.current ? Date.now() - challengeAtRef.current : 0;
          if (age < floor) await new Promise((r) => setTimeout(r, floor - age));
          s = await createRunnerCheckout(clean, await buildExtras(), privyOpts);
        } else {
          throw err;
        }
      }
      mintSessionRef.current = s.mintSession;
      setSession(s);
      if (s.status === "ready") {
        setStage("done");
        void armNow(s);
        return;
      }
      setErrorCode("");
      setStage("minting");
      startPolling(sessionId(s));
    } catch (err) {
      if (err instanceof ApiError && err.status === 409) {
        // Sold out (all minted), or a race just lost the last egg: show the
        // closed state, not the generic "try again in a little while" copy.
        setSoldOut(true);
        setStage("idle");
        return;
      }
      setErrorCode(err instanceof ApiError && typeof err.code === "string" ? err.code : "");
      // A refused or consumed captcha token is single-use: reset the widget so
      // the retry starts from a fresh check instead of resubmitting a dead one.
      if (
        err instanceof ApiError &&
        (err.code === "captcha_required" || err.code === "captcha_invalid")
      ) {
        captchaTokenRef.current = "";
        try {
          turnstileApi()?.reset(captchaWidgetIdRef.current ?? undefined);
        } catch {
          // Widget gone (page state changed): the next render recreates it.
        }
      }
      // The machine code drives the one extra button the error card can offer
      // (already_minted: open the pet you already have; verified_email_required:
      // claim a gifted pet). It was declared but never set before 2026-10-13.
      setErrorCode(err instanceof ApiError && err.code ? err.code : "");
      if (err instanceof ApiError && err.code && SYBIL_CODES.has(err.code)) {
        // The gate's copy is already kind (e.g. already_minted: "You already
        // have a WALLETCHI on this device or email. It is one per keeper.").
        setError(err.message);
      } else if (err instanceof ApiError && err.status >= 400 && err.status < 500) {
        setError("Adoption is not open on this den right now. Try again in a little while.");
      } else {
        setError(
          err instanceof ApiError
            ? err.message
            : "Something ruffled the fur. No worries, give it another go.",
        );
      }
      setStage("error");
    }
  }, [email, honeypot, startPolling, primeChallenge, privy, signedIn, privyWallet]);

  // THE code-send path. Step 1 and Resend both go through this exact call, so
  // there is only ever one way a code leaves Privy.
  const deliverCode = useCallback(async (): Promise<boolean> => {
    if (!privy) return false;
    const clean = email.trim();
    if (!EMAIL_RE.test(clean)) {
      setError("Pop in a real email so we can send your code.");
      return false;
    }
    setError("");
    try {
      await privy.sendCode(clean);
      startResendLock();
      return true;
    } catch {
      setError("We could not send your code. Check the email and give it another go.");
      return false;
    }
  }, [privy, email, startResendLock]);

  // Self-custody step 1: email the code, then show the code step. Only reachable
  // when Privy is configured (the custodial path never calls this).
  const sendOtp = useCallback(async () => {
    setCodeNote("");
    setCode(emptyCode());
    codeSubmitRef.current = false;
    if (await deliverCode()) {
      setPhase("code");
      setCodeFocusKey((k) => k + 1);
    }
  }, [deliverCode]);

  // Resend: same send, fresh row. The old code stops working the moment Privy
  // issues a new one, so wipe the boxes rather than leave a dead code sitting in them.
  const resendOtp = useCallback(async () => {
    setCodeNote("");
    if (!(await deliverCode())) {
      setError("That resend did not go through. Give it another go in a moment.");
      return;
    }
    setCode(emptyCode());
    codeSubmitRef.current = false;
    setCodeFocusKey((k) => k + 1);
    setCodeNote("New code sent. Use the newest one.");
  }, [deliverCode]);

  // Self-custody step 2: verify the code. This ALSO is the mint trigger: on a
  // good code we arm `pendingMint` and the effect below fires the checkout as
  // soon as the embedded wallet exists, so there is no separate "mint" click.
  const verifyAndMint = useCallback(async () => {
    if (!privy) return;
    const c = code.join("");
    if (c.length < CODE_LEN) {
      setError("Pop in all six digits from your email.");
      return;
    }
    setError("");
    setCodeNote("");
    autoMintFiredRef.current = false;
    // Both flip in one render: `verifying` holds the code screen up (spinning
    // button, locked boxes) and `pendingMint` arms the auto-mint exactly as before.
    setVerifying(true);
    setPendingMint(true);
    try {
      await privy.loginWithCode(c);
    } catch {
      // Wrong code: empty the row and put the caret back on box one, so a retry
      // is one action instead of six deletions.
      setVerifying(false);
      setPendingMint(false);
      setCode(emptyCode());
      codeSubmitRef.current = false;
      setCodeFocusKey((k) => k + 1);
      setError("That code did not match. Give it another go.");
      return;
    }
    // Verified: the card can hand over to the wallet takeover now.
    setVerifying(false);
    // Headless login does NOT auto-create the embedded wallet, so make it now.
    // A returning keeper who already has one throws here: harmless, the auto-mint
    // effect just uses the existing wallet. Once a wallet exists, privyWallet
    // flips non-null and the effect fires the mint.
    try {
      await privy.createWallet();
    } catch {
      /* already has a wallet, or a concurrent create resolved it */
    }
  }, [privy, code]);

  // Auto-submit the instant the sixth digit lands (last keystroke, a paste, or an
  // OS autofill), so nobody has to hunt for a button. It never reads as a glitch
  // because the Verify button flips to its spinning "Verifying code" state in the
  // same beat, exactly as if it had been tapped.
  const codeComplete = code.every((d) => d !== "");
  const submittingCode = privy?.otpStatus === "submitting-code";
  useEffect(() => {
    if (!codeComplete) {
      codeSubmitRef.current = false;
      return;
    }
    if (phase === "code" && !submittingCode && !pendingMint && !codeSubmitRef.current) {
      codeSubmitRef.current = true;
      void verifyAndMint();
    }
  }, [codeComplete, phase, submittingCode, pendingMint, verifyAndMint]);

  // The auto-mint: once the code verified (pendingMint) AND the embedded wallet
  // is live, fire the checkout once. `submit` reads the fresh signedIn/wallet, so
  // the pet mints straight to the user's own wallet (non-custodial).
  useEffect(() => {
    if (pendingMint && signedIn && privyWallet && !autoMintFiredRef.current && stage === "idle") {
      autoMintFiredRef.current = true;
      void submit();
    }
  }, [pendingMint, signedIn, privyWallet, stage, submit]);

  // WALLET SETUP WATCHDOG (bug hunt 2026-10-19): after the code verifies, the embedded wallet
  // normally appears within seconds. If Privy never provisions it (iframe or network failure on a
  // brand-new user) the takeover used to spin forever with no exit. Retry createWallet once at
  // 20 s; at 40 s show the error card with Try again.
  useEffect(() => {
    if (!pendingMint || !signedIn || privyWallet || !privy) return undefined;
    const retry = setTimeout(() => {
      privy.createWallet().catch(() => undefined);
    }, 20_000);
    const giveUp = setTimeout(() => {
      setError("Your wallet did not finish setting up. Tap Try again, it usually works the second time.");
      setStage("error");
    }, 40_000);
    return () => {
      clearTimeout(retry);
      clearTimeout(giveUp);
    };
  }, [pendingMint, signedIn, privyWallet, privy]);

  // A mint error must drop us out of the pending-mint takeover so the error card
  // (and its Try again) shows; the retry re-arms cleanly.
  useEffect(() => {
    if (stage === "error" && pendingMint) {
      setPendingMint(false);
      autoMintFiredRef.current = false;
    }
  }, [stage, pendingMint]);

  if (stage === "done" && session) {
    return (
      <PetReady
        session={session}
        mintSession={mintSessionRef.current}
        arming={arming}
        armed={armed}
        seasonPending={seasonPending}
        onRetryArm={retryArm}
        email={email}
      />
    );
  }

  // Hunt 2026-10-19: when the season's slots are taken (server RUNNER_SUPPLY_CAP, reported as
  // soldOut by /api/season/stats and as 409 on checkout), the form becomes the same "Minting is
  // closed" card the site shows between rounds, by itself, with no redeploy.
  if (soldOut && stage !== "minting" && stage !== "done") {
    return <MintClosed />;
  }

  const emailValid = EMAIL_RE.test(email.trim());
  const busy = stage === "submitting" || stage === "minting";
  // Self-custody front: shown when Privy is configured and the visitor is not yet
  // signed in (email -> code), or the code just verified and we're minting into
  // their fresh wallet (pendingMint). A signed-in returning keeper skips it and
  // uses the one-button form below (their wallet already exists).
  const selfCustodyFront = SELF_CUSTODY_ENABLED && Boolean(privy) && (!signedIn || pendingMint);
  const otpStatus = privy?.otpStatus ?? "initial";
  const sendingCode = otpStatus === "sending-code";
  const codeBusy = verifying || otpStatus === "submitting-code" || pendingMint;

  return (
    <div className="soft-card p-6 sm:p-7" style={{ maxWidth: 460 }}>
      {stage === "minting" ? (
        <div className="flex flex-col items-center py-3 text-center">
          <div className="cub-bounce mb-4 grid place-items-center rounded-full" style={{ width: 78, height: 78, background: "linear-gradient(160deg,#e6f6f6,#f1ecfb)", boxShadow: "0 10px 24px -10px rgba(47,125,122,0.4)" }}>
            <PetSprite size={54} />
          </div>
          <div className="display text-2xl">Readying your egg</div>
          <p className="mt-1 text-sm" style={{ color: "var(--color-ink-muted)" }}>
            {MINT_STEPS[step]}
            <span className="dotty" />
          </p>
          {queue && (
            // The place in line, so a keeper deep in a burst knows the wait is real
            // and moving, not a hang. Position 1 with nothing ahead reads as "next".
            <p className="mt-3 text-sm" aria-live="polite" style={{ color: "var(--color-ink-soft)" }}>
              {queue.phase === "submitted" && queue.ahead === 0
                ? "Your egg is on the chain now"
                : queue.ahead === 0
                  ? "Your egg is next in line"
                  : `You are number ${queue.position} in line`}
              {" "}({queueWait(queue.etaSec)})
            </p>
          )}
          {note && (
            <p className="mt-3 text-xs" style={{ color: "var(--color-ink-muted)" }}>
              {note}
            </p>
          )}
        </div>
      ) : selfCustodyFront ? (
        pendingMint && !verifying ? (
          // Code verified: creating the wallet, then the mint fires itself.
          <div className="flex flex-col items-center py-3 text-center">
            <div
              className="cub-bounce mb-4 grid place-items-center rounded-full"
              style={{ width: 78, height: 78, background: "linear-gradient(160deg,#e6f6f6,#f1ecfb)", boxShadow: "0 10px 24px -10px rgba(47,125,122,0.4)" }}
            >
              <PetSprite size={54} />
            </div>
            <div className="display text-2xl">Setting up your wallet</div>
            <p className="mt-1 text-sm" style={{ color: "var(--color-ink-muted)" }}>
              Your pet is on its way in<span className="dotty" />
            </p>
          </div>
        ) : phase === "email" ? (
          // Step 1: email -> send OTP.
          <form
            onSubmit={(e) => {
              e.preventDefault();
              sendOtp();
            }}
          >
            <label htmlFor="pet-email" className="eyebrow" style={{ color: "var(--color-salmon-text)" }}>
              Hatch your pet
            </label>
            <p className="mt-2 text-sm" style={{ color: "var(--color-ink-soft)" }}>
              Your email gets a 6-digit code. That code sets up a wallet only you control, and your
              pet mints straight into it, where nobody else can ever move it. No app, no seed phrase.
            </p>
            <div className="mt-4">
              <input
                id="pet-email"
                type="email"
                inputMode="email"
                autoComplete="email"
                className="field"
                placeholder="you@email.com"
                value={email}
                disabled={sendingCode}
                onChange={(e) => setEmail(e.target.value)}
              />
            </div>
            {/* Honeypot (see custodial form): tab-skipped, off-screen, human-blank. */}
            <div
              aria-hidden="true"
              style={{ position: "absolute", left: "-9999px", top: 0, width: 1, height: 1, overflow: "hidden" }}
            >
              <label htmlFor="den-code">Leave this field empty</label>
              <input
                id="den-code"
                name="den-code"
                type="text"
                tabIndex={-1}
                autoComplete="off"
                value={honeypot}
                onChange={(e) => setHoneypot(e.target.value)}
              />
            </div>
            <button type="submit" className="btn btn-cub mt-3 w-full" disabled={sendingCode || !emailValid}>
              {sendingCode ? (
                <>
                  <span className="spin" /> Sending your code
                </>
              ) : (
                <>Email me a code</>
              )}
            </button>
            {error && (
              <p className="mt-3 text-sm" style={{ color: "var(--color-salmon-text)" }}>
                {error}
              </p>
            )}
            <p className="mt-3 text-center text-xs" style={{ color: "var(--color-ink-muted)" }}>
              Free to hatch. Yours to keep alive.
            </p>
          </form>
        ) : (
          // Step 2: the code. The whole job of this screen is to move the keeper
          // to their INBOX, so it opens with an envelope, a heading, and their own
          // address in bold before it shows a single box. Submitting verifies AND
          // auto-mints: there is no separate mint tap.
          <form
            onSubmit={(e) => {
              e.preventDefault();
              verifyAndMint();
            }}
          >
            <div className="text-center">
              <div
                className="cub-bounce mx-auto grid place-items-center rounded-2xl"
                style={{
                  width: 64,
                  height: 64,
                  fontSize: 30,
                  background: "var(--color-lav-soft)",
                  boxShadow: "0 12px 24px -14px rgba(107,85,168,0.55)",
                }}
                aria-hidden
              >
                ✉️
              </div>
              <div className="eyebrow mt-3" style={{ color: "var(--color-salmon-text)" }}>
                Last step
              </div>
              <h2 className="display mt-1" style={{ fontSize: "1.75rem" }}>
                Check your email
              </h2>
              <p className="mx-auto mt-2 max-w-xs text-sm" style={{ color: "var(--color-ink-soft)" }}>
                We sent a 6-digit code to{" "}
                <strong style={{ color: "var(--color-ink)", overflowWrap: "anywhere" }}>{email}</strong>.
                Go grab it, then type or paste it below.
              </p>
            </div>
            <div className="mt-5">
              <CodeBoxes
                value={code}
                disabled={codeBusy}
                invalid={Boolean(error)}
                focusKey={codeFocusKey}
                describedBy="otp-help"
                onChange={(next) => {
                  setCode(next);
                  // Typing again is the retry: drop the stale red state with it.
                  if (error) setError("");
                  if (codeNote) setCodeNote("");
                }}
              />
            </div>
            {codeNote && (
              <p
                className="mt-3 text-center text-sm"
                style={{ color: "var(--color-teal-deep)", fontWeight: 700 }}
                role="status"
              >
                {codeNote}
              </p>
            )}
            {error && (
              <p
                className="mt-3 text-center text-sm"
                style={{ color: "var(--color-salmon-text)", fontWeight: 700 }}
                role="alert"
              >
                {error}
              </p>
            )}
            <button type="submit" className="btn btn-cub mt-4 w-full" disabled={codeBusy || !codeComplete}>
              {verifying || otpStatus === "submitting-code" ? (
                <>
                  <span className="spin" /> Verifying code
                </>
              ) : pendingMint ? (
                <>
                  <span className="spin" /> Hatching your pet
                </>
              ) : (
                <>Verify code</>
              )}
            </button>
            <p id="otp-help" className="mt-3 text-center text-sm" style={{ color: "var(--color-ink-muted)" }}>
              No code yet?{" "}
              {resendIn > 0 ? (
                <span style={{ fontWeight: 700 }}>Resend in {resendIn}s</span>
              ) : (
                <button
                  type="button"
                  className="otp-link"
                  disabled={codeBusy || sendingCode}
                  onClick={() => void resendOtp()}
                >
                  {sendingCode ? "Sending" : "Resend code"}
                </button>
              )}
              <br />
              <span className="text-xs">It lands in seconds. If not, check your spam folder.</span>
            </p>
            <button
              type="button"
              className="btn btn-ghost mt-3 w-full"
              disabled={codeBusy}
              onClick={() => {
                setPhase("email");
                setCode(emptyCode());
                codeSubmitRef.current = false;
                setCodeNote("");
                setError("");
              }}
            >
              Use a different email
            </button>
          </form>
        )
      ) : (
        <form
          onSubmit={(e) => {
            e.preventDefault();
            submit();
          }}
        >
          <label htmlFor="pet-email" className="eyebrow" style={{ color: "var(--color-salmon-text)" }}>
            Hatch your pet
          </label>
          <p className="mt-2 text-sm" style={{ color: "var(--color-ink-soft)" }}>
            Just your email. We mint a real on-chain pet and pack it into your wallet. No app and no
            gas: playing spends test CARE from your pet&apos;s own account.
          </p>
          {/* THE LIVE START LINE. Under the sellout model this is the single most
              important thing a newcomer needs to understand, and it is also the
              honest answer to "why can I not feed it yet". Hidden once the race
              is running, where it would be noise. */}
          {seasonPending && (
            <div
              className="mt-3 rounded-xl px-4 py-3 text-sm"
              style={{ background: "var(--color-lav-soft)", color: "var(--color-ink-soft)" }}
            >
              <strong style={{ color: "var(--color-lav-deep)" }}>
                {seasonPending.minted} of {seasonPending.maxSupply} claimed.
              </strong>{" "}
              The season starts the moment the last one goes, and every pet begins its life at that
              same instant. Nobody gets a head start.
            </div>
          )}
          <div className="mt-4">
            <input
              id="pet-email"
              type="email"
              inputMode="email"
              autoComplete="email"
              className="field"
              placeholder="you@email.com"
              value={email}
              disabled={busy}
              onChange={(e) => setEmail(e.target.value)}
            />
          </div>
          {/* Honeypot: visually hidden, tab-skipped, non-autofill name. A human
              never sees or fills it; the server hard-blocks when it arrives
              non-empty. Off-screen (not display:none) so naive bots still
              consider it fillable. */}
          <div
            aria-hidden="true"
            style={{
              position: "absolute",
              left: "-9999px",
              top: 0,
              width: 1,
              height: 1,
              overflow: "hidden",
            }}
          >
            <label htmlFor="den-code">Leave this field empty</label>
            <input
              id="den-code"
              name="den-code"
              type="text"
              tabIndex={-1}
              autoComplete="off"
              value={honeypot}
              onChange={(e) => setHoneypot(e.target.value)}
            />
          </div>
          {privyWallet && (
            <p className="mt-2 text-xs" style={{ color: "var(--color-teal-deep)", fontWeight: 700 }}>
              Signed in: your pet mints straight to your wallet ({privyWallet.slice(0, 6)}...
              {privyWallet.slice(-4)}).
            </p>
          )}
          {/* Turnstile mount point: renders only when the server advertises a
              captcha on the mint challenge (captchaLive). Empty div otherwise
              costs nothing. */}
          {captchaSiteKey && <div ref={captchaBoxRef} className="mt-3 flex justify-center" />}
          <button type="submit" className="btn btn-cub mt-3 w-full" disabled={busy || !emailValid}>
            {stage === "submitting" ? (
              <>
                <span className="spin" /> Getting your pet
              </>
            ) : (
              <>Get my pet, free</>
            )}
          </button>
          {error && stage !== "error" && (
            <p className="mt-3 text-sm" style={{ color: "var(--color-salmon-text)" }}>
              {error}
            </p>
          )}
          {stage === "error" && (
            <div
              className="mt-4 rounded-2xl p-4 text-sm"
              style={{ background: "rgba(255,138,99,0.12)", color: "var(--color-ink)" }}
            >
              <div className="display" style={{ fontSize: "1rem" }}>
                Aw, hiccup.
              </div>
              <p className="mt-1" style={{ color: "var(--color-ink-soft)" }}>
                {error}
              </p>
              {errorCode === "verified_email_required" && (
                <a href="/claim" className="btn btn-teal mt-3 w-full">
                  Someone sent me this pet: claim its pass
                </a>
              )}
              {errorCode === "already_minted" && (
                <a href="/me" className="btn btn-teal mt-3 w-full">
                  Open my pet
                </a>
              )}
              {errorCode === "device_already_minted" && (
                <p className="mt-3 text-center text-xs" style={{ color: "var(--color-ink-muted)" }}>
                  To open it, go to My pets and sign in with the email you minted with.
                </p>
              )}
              <button className="btn btn-cub mt-3 w-full" onClick={() => setStage("idle")}>
                Try again
              </button>
            </div>
          )}
          <p className="mt-3 text-center text-xs" style={{ color: "var(--color-ink-muted)" }}>
            Free to hatch. Yours to keep alive.
          </p>
        </form>
      )}
    </div>
  );
}

/** The joyful success state: a little burst, then the pet's Apple Wallet link. */
function PetReady({
  session,
  mintSession,
  arming,
  armed,
  seasonPending,
  onRetryArm,
  email,
}: {
  session: RunnerSession;
  mintSession?: string;
  /** The address the receipt went to, so the "check your email" line can name it. */
  email?: string;
  arming?: boolean;
  armed?: boolean | null;
  /** Run arming again (the Finish setup button). */
  onRetryArm?: () => void;
  /** Set when the season is sellout-gated and has not started: arming CANNOT
   *  succeed yet, which is expected rather than a fault. */
  seasonPending?: { minted: number; maxSupply: number } | null;
}) {
  const { apple: initialApple } = runnerLinks(session);
  const [apple, setApple] = useState<string | undefined>(initialApple);
  const [google, setGoogle] = useState<string | undefined>(undefined);
  const [fundOpen, setFundOpen] = useState(false);
  // Where are we? Decided on the client only (never during SSR) so the markup hydrates clean.
  // Inside X / Instagram / TikTok the wallet buttons mostly do nothing, and on a computer a
  // .pkpass is a download, so both get a callout that points at the emailed card instead.
  const [ctx, setCtx] = useState<BrowserContext | null>(null);
  useEffect(() => {
    setCtx(detectBrowserContext(typeof navigator === "undefined" ? "" : navigator.userAgent));
  }, []);
  const [copied, setCopied] = useState(false);
  const copyLink = useCallback(async () => {
    const link = ctx?.platform === "android" ? (google ?? apple) : (apple ?? google);
    if (!link) return;
    try {
      await navigator.clipboard.writeText(link);
      setCopied(true);
      setTimeout(() => setCopied(false), 2500);
    } catch {
      // Clipboard API blocked (some embedded browsers): the prompt is selectable text.
      window.prompt("Copy this link, then paste it into Safari or Chrome:", link);
    }
  }, [ctx, apple, google]);
  const realBrowser = ctx?.platform === "android" ? "Chrome" : "Safari";
  const walletButton = ctx?.platform === "android" ? "Save to Google Wallet" : "Add to Apple Wallet";
  const passFetchedRef = useRef(false);

  // When the economy is on, the public views withhold the pass links, so exchange
  // the mint-session token for BOTH here. Fetched once (not gated on `apple`), so a
  // pet whose Apple link was already inline still gets its Google link. The emailed
  // pass is the fallback, so a failure just leaves the buttons hidden (never blocks
  // the success screen).
  useEffect(() => {
    if (passFetchedRef.current || !mintSession || !session.serial) return;
    passFetchedRef.current = true;
    let cancelled = false;
    fetchMintPassLink(session.serial, mintSession).then((r) => {
      if (cancelled) return;
      if (r?.applePassUrl) setApple(r.applePassUrl);
      if (r?.googleSaveUrl) setGoogle(r.googleSaveUrl);
    });
    return () => {
      cancelled = true;
    };
  }, [mintSession, session.serial]);

  const number = session.runnerNumber || (session.serial ? session.serial.slice(0, 8) : "your pet");
  const burst = ["🥚", "✨", "🐾", "💛", "✨", "🥚", "💫", "✨"];

  return (
    <div className="soft-card relative overflow-hidden p-6 text-center sm:p-8" style={{ maxWidth: 460 }}>
      <div className="pointer-events-none absolute inset-0" aria-hidden>
        {burst.map((c, i) => (
          <span
            key={i}
            className="burst"
            style={
              {
                left: `${12 + i * 10}%`,
                top: "36%",
                animationDelay: `${i * 0.05}s`,
                ["--bx" as string]: `${(i % 2 ? 1 : -1) * (30 + (i % 4) * 22)}px`,
                ["--by" as string]: `${-70 - (i % 3) * 26}px`,
              } as React.CSSProperties
            }
          >
            {c}
          </span>
        ))}
      </div>

      <div className="cub-bounce mx-auto" style={{ width: 280, maxWidth: "100%" }}>
        <PetPortrait serial={session.serial} seed={session.tokenId ?? session.serial} width={280} />
      </div>
      <div className="eyebrow mt-4" style={{ color: "var(--color-teal-deep)" }}>
        Your egg is on the way
      </div>
      <h2 className="display mt-1" style={{ fontSize: "clamp(1.6rem, 4vw, 2.1rem)" }}>
        Meet your pet!
      </h2>
      <p className="mt-2 text-sm" style={{ color: "var(--color-ink-soft)" }}>
        Pet {number} is live on-chain with its own account. The whole game, in three beats:
      </p>

      {/* THE POINT OF THE WHOLE MINT FLOW: everything the keeper ever has to approve happens HERE,
          while they are already on the site. After this the pass is self-sufficient. */}
      {arming && (
        <p className="mt-3 text-sm" style={{ color: "var(--color-ink-soft)" }}>
          Waking your pet and setting up one-tap care...
        </p>
      )}
      {!arming && armed === true && (
        <div
          className="mt-3 rounded-xl px-4 py-3 text-sm"
          style={{ background: "rgba(47,125,122,0.10)", color: "var(--color-ink-soft)" }}
        >
          <strong style={{ color: "var(--color-teal-deep)" }}>You are all set.</strong> Caring works
          straight from your wallet card from now on. It starts with {SEASON.starterCare} test CARE, about{" "}
          {STARTER_DAYS} days of care at the minimum.
        </div>
      )}
      {/* A pre-sellout season CANNOT arm one-tap care: arming bootstraps on a real
          care(), and the vault refuses every care until the collection mints out.
          That is expected, not a fault, and saying "did not finish setting up"
          here would report the system as broken at the exact moment a keeper is
          deciding whether to trust it. */}
      {!arming && armed === false && seasonPending && (
        <div
          className="mt-3 rounded-xl px-4 py-3 text-sm"
          style={{ background: "rgba(47,125,122,0.10)", color: "var(--color-ink-soft)" }}
        >
          <strong style={{ color: "var(--color-teal-deep)" }}>Your pet is safely yours.</strong> The
          season begins the moment the collection mints out ({seasonPending.minted} of{" "}
          {seasonPending.maxSupply} so far), and every pet starts its life together at that instant.
          Nothing is ticking yet. Your first feed opens this site once to set up one-tap care, and
          the card takes over after that.
        </div>
      )}
      {!arming && armed === false && !seasonPending && (
        <div
          className="mt-3 rounded-xl px-4 py-3 text-sm"
          style={{ background: "rgba(249,143,118,0.12)", color: "var(--color-ink-soft)" }}
        >
          Your pet is safely yours. One more step makes the buttons on your wallet card work on their own.
          {onRetryArm && (
            <button className="btn btn-cub mt-3 w-full" onClick={onRetryArm}>
              Finish setup
            </button>
          )}
        </div>
      )}

      <ol className="mt-4 grid gap-2.5 text-left">
        {[
          {
            t: "Add it to your wallet.",
            b: "Apple or Google: tap below. That card is where your pet lives.",
          },
          {
            t: "Care for it from the card.",
            b: "On iPhone, open the card and tap ••• at the top right: the buttons are on the back. On Android they sit right on the card. If it is still an egg, tap FEED to hatch it. Then keep all five needs served every day: feed, water, play, toy, explore. No website and no signing to care. Miss any one and it is gone for good.",
          },
          {
            t: "Outlast the rest.",
            b: "The last pet still alive takes the whole Pot and becomes immortal. Along the way, 20% of every care is pushed back to the living pets every 2 hours. All of it is test CARE with no value: it is here so you can try every mechanic.",
          },
        ].map((s, i) => (
          <li key={i} className="flex gap-3">
            <span
              aria-hidden
              style={{
                flex: "0 0 auto",
                width: 22,
                height: 22,
                borderRadius: 999,
                background: "var(--color-lav-soft)",
                color: "var(--color-teal-deep)",
                fontWeight: 800,
                fontSize: 12,
                display: "grid",
                placeItems: "center",
                marginTop: 1,
              }}
            >
              {i + 1}
            </span>
            <span className="text-sm" style={{ color: "var(--color-ink-soft)" }}>
              <strong style={{ color: "var(--color-ink)" }}>{s.t}</strong> {s.b}
            </span>
          </li>
        ))}
      </ol>

      {ctx?.inApp && (
        <div
          className="mt-5 rounded-2xl p-4 text-left text-sm"
          style={{ background: "rgba(255,138,99,0.14)", color: "var(--color-ink)" }}
          role="status"
        >
          <div className="display" style={{ fontSize: "1rem" }}>
            You are inside {inAppLabel(ctx)}. Wallet buttons need a real browser.
          </div>
          <p className="mt-1" style={{ color: "var(--color-ink-soft)" }}>
            Easiest: open the email we just sent{email ? ` to ${email}` : ""} on this phone and tap{" "}
            {walletButton}. Or copy the link below and paste it into {realBrowser}.
          </p>
          {(apple || google) && (
            <button type="button" className="btn btn-cub mt-3 w-full" onClick={copyLink}>
              {copied ? `Copied. Now paste it into ${realBrowser}` : "Copy wallet link"}
            </button>
          )}
        </div>
      )}
      {ctx && !ctx.inApp && ctx.platform === "desktop" && (
        <div
          className="mt-5 rounded-2xl p-4 text-left text-sm"
          style={{ background: "rgba(47,125,122,0.10)", color: "var(--color-ink)" }}
          role="status"
        >
          <div className="display" style={{ fontSize: "1rem" }}>
            On a computer? Add it from your phone.
          </div>
          <p className="mt-1" style={{ color: "var(--color-ink-soft)" }}>
            We emailed the card{email ? ` to ${email}` : ""}. Open that email on your phone and tap Add
            to Apple Wallet or Save to Google Wallet. The pass lives on the phone.
          </p>
        </div>
      )}
      <div className="mt-5 flex flex-col gap-3">
        {apple && (
          <a href={safeUrl(apple)} target="_blank" rel="noreferrer" className="btn btn-apple w-full">
            <AppleGlyph /> Add to Apple Wallet
          </a>
        )}
        {google && (
          <a href={safeUrl(google)} target="_blank" rel="noreferrer" className="btn btn-google w-full">
            <GoogleGlyph /> Save to Google Wallet
          </a>
        )}
        {/* Funding is a top-up, not a first step: a pet has its own account and the
            care draws from it. Only surface it once CARE actually has a market, so
            a normie is never sent to a "swap opens at launch" dead end. */}
        {CARE_TOKEN_READY && (
          <button className="btn btn-ghost w-full" onClick={() => setFundOpen(true)}>
            <span aria-hidden>🍯</span> Top up its tank
          </button>
        )}
        <a
          href="/how-to"
          className="text-xs font-bold"
          style={{ color: "var(--color-teal-deep)" }}
        >
          See how it all works →
        </a>
      </div>
      <p className="mt-4 text-xs" style={{ color: "var(--color-ink-muted)" }}>
        We emailed its card{email ? ` to ${email}` : ""} too. Check your inbox.
      </p>

      <FundFlow
        open={fundOpen}
        onClose={() => setFundOpen(false)}
        pet={{
          serial: session.serial,
          number: session.runnerNumber,
          tokenId: session.tokenId,
          tbaAddress: session.tbaAddress ?? session.tba,
        }}
      />
    </div>
  );
}
