"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { usePrivy, useWallets, useSign7702Authorization } from "@privy-io/react-auth";
import { PetPortrait } from "./PetPortrait";
import { getCareBudget, getCareSessionStatus, getRunnerState, installCareSession, isCareLimitError, shortDuration, type CareBudget, type RunnerSession } from "@/lib/api";
import { AA_CARE_ENABLED } from "@/lib/aa-config";
import {
  privyWalletToSigner,
  sponsoredCare,
  isDelegated,
  bootstrapDelegation,
  type CareResult,
  type Sign7702Authorization,
} from "@/lib/aa";
import { grantCareSession } from "@/lib/session";
import { fetchLiveChainConfig, liveVaultAddress } from "@/lib/chain-config";
import { BURN_PCT, REWARDS_PCT, POT_PCT, GAS_PCT } from "@/lib/tokenomics";
import { aaErrorDetail } from "@/lib/aa-errors";
import type { CareAction } from "@/lib/care";
import { needGlyph } from "@/lib/needs";
import type { Address } from "viem";
import { armOnce, armOneTap, liveArmDeps } from "@/lib/arming";
import { readPetCareFunds, careAmount, type PetCareFunds } from "@/lib/pet-funds";
import { PutCareBack } from "./PutCareBack";
import { SEASON } from "@/lib/brand";

// Every care is paid from the PET'S OWN CARE balance, so an empty pet cannot be fed no matter
// how often the keeper retries. Say exactly that, with the fix, instead of "try again".
function outOfCareMessage(name: string, funds: PetCareFunds, tba: string): string {
  return `${name} is out of CARE, so it can't be cared for. Every care costs ${careAmount(funds.cost)} CARE, and it is paid from the CARE inside your pet, not from your wallet. Your pet has ${careAmount(funds.balance)} CARE right now. Put some CARE back into your pet (its address is ${tba}), then tap again.`;
}

// Verb per action, present and past tense (the pass link opens exactly one action).
// The GLYPH is never written here: it comes from the shared set (lib/needs.ts,
// mirroring server/src/runner/needs.ts). This page used to draw feed as 🍎 and
// explore as 🗺️ while the wallet card drew 🍯 and 🧭, so the same tap looked
// like a different action depending on where the keeper saw it.
const ACTION_COPY: Record<CareAction, { verb: string; past: string }> = {
  feed: { verb: "Feed", past: "Fed" },
  water: { verb: "Water", past: "Watered" },
  play: { verb: "Play with", past: "Played with" },
  toy: { verb: "Give a toy to", past: "Gave a toy to" },
  explore: { verb: "Explore with", past: "Explored with" },
};

type Phase = "loading" | "signin" | "wallet" | "custodial" | "wrong-wallet" | "memorial" | "ready" | "caring" | "done" | "error";

export function CareClient({ serial, action }: { serial: string; action: CareAction }) {
  // Ships dark: until JP's Alchemy key + policy are set (and Privy is on), the gasless path is gated and
  // this page tells the user to use the link from their wallet pass (the current server flow).
  if (!AA_CARE_ENABLED) {
    return (
      <Card>
        <Eyebrow>Gasless care</Eyebrow>
        <h1 className="display mt-2" style={{ fontSize: "1.6rem" }}>Warming up</h1>
        <p className="mt-2 text-sm" style={{ color: "var(--color-ink-soft)" }}>
          Gasless care from this page is almost ready. For now, use the care buttons on the back of
          your wallet pass.
        </p>
      </Card>
    );
  }
  return <CareInner serial={serial} action={action} />;
}

function CareInner({ serial, action }: { serial: string; action: CareAction }) {
  const copy = { ...ACTION_COPY[action], emoji: needGlyph(action) };
  const { ready, authenticated, login, logout, getAccessToken } = usePrivy();
  const { wallets } = useWallets();
  const { signAuthorization } = useSign7702Authorization();

  const [session, setSession] = useState<RunnerSession | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [caring, setCaring] = useState(false);
  const [result, setResult] = useState<CareResult | null>(null);
  // One-tap care. `supported` is whether this deployment can do it at all; `active` is whether a pass tap
  // already feeds THIS pet with no website and no signature. Both start null (unknown). Purely additive
  // to the flow below: every care still goes through the proven owner-signed path first, so failing to
  // arm one-tap care never costs the keeper their feed.
  const [oneTap, setOneTap] = useState<{ supported: boolean; active: boolean } | null>(null);
  const [arming, setArming] = useState(false);
  // The real reason a post-care arming attempt failed, shown on the done card so a
  // keeper whose pass will keep opening this page knows why (never swallowed).
  const [armNote, setArmNote] = useState("");
  // Only ever ask for the extra grant signature when the server can actually use it. Without this a
  // deployment with silent care switched off would prompt for a grant on every feed and then 503.
  const canArm = oneTap?.supported === true && oneTap.active === false;
  // SIGN-IN ARMING (2026-09-23, tester Pretzel): a pet whose mint-time arming failed used to stay
  // unarmed forever, so EVERY pass tap landed here. Now the first time its owner is signed in on this
  // page, it arms itself: no hatch, no care spent, just the delegation bootstrap and the session
  // grant. `autoArm` is the visible state; the ref stops re-renders from starting a second attempt.
  const [autoArm, setAutoArm] = useState<"idle" | "arming" | "done" | "failed">("idle");
  const [autoArmNote, setAutoArmNote] = useState("");
  const autoArmTriedRef = useRef(false);
  // A care failure is RECOVERABLE (retry the button); it must NOT collapse into the
  // terminal "could not find that pet" load-error card. Kept separate so a failed
  // feed leaves the user on "ready" with a retry, not stranded until a page reload.
  const [careError, setCareError] = useState("");
  // Set when a feed was refused because the pet holds less CARE than one care costs: shows the
  // one-tap "put CARE back" card right under the message.
  const [emptyPet, setEmptyPet] = useState(false);
  // The care budget (cares left in the 24h window, when it reopens, how long the pet has, and whether
  // THIS need is worth a care right now). Read on load and after every care; null never blocks a care.
  const [budget, setBudget] = useState<CareBudget | null>(null);
  // When a care is held back or refused, the need to care for instead (a one-tap link).
  const [careInstead, setCareInstead] = useState<string | null>(null);

  // Care page login is EMAIL-ONLY: the care flow signs strictly with the Privy
  // embedded wallet, so letting a user pick an external wallet just dead-ends them
  // on the "getting your wallet ready" spinner (no embedded wallet ever appears).
  const loginWithEmail = useCallback(() => login({ loginMethods: ["email"] }), [login]);

  // The user's embedded (email-provisioned) wallet is the pet owner + the signer. It MUST be the Privy
  // embedded wallet: the 7702 authorization is signed by it, so an external wallet (walletClientType !=
  // "privy") would sign with the wrong key and every op would fail. No fallback to wallets[0].
  const embedded = useMemo(() => wallets.find((w) => w.walletClientType === "privy"), [wallets]);
  const walletAddress = embedded?.address as Address | undefined;

  useEffect(() => {
    let live = true;
    getRunnerState(serial)
      .then((s) => {
        if (live) setSession(s);
      })
      .finally(() => {
        if (live) setLoaded(true);
      });
    return () => {
      live = false;
    };
  }, [serial]);

  // Is one-tap care already armed for this pet? Public read (no secret in the response).
  const tokenId = session?.tokenId;
  useEffect(() => {
    if (!tokenId) return;
    let live = true;
    getCareSessionStatus(tokenId).then((s) => {
      // An unreachable status read means we do not know, so treat it as unsupported: never prompt for a
      // grant we cannot be sure the server wants.
      if (live) setOneTap({ supported: Boolean(s?.supported), active: Boolean(s?.active) });
    });
    return () => {
      live = false;
    };
  }, [tokenId]);

  const phase: Phase = !ready || !loaded
    ? "loading"
    : result
      ? "done"
      : !session || !session.tokenId
          ? "error"
          : session.gone
            ? "memorial"
            : session.custodial
              ? "custodial"
              : !authenticated
                ? "signin"
                : !walletAddress
                  ? "wallet"
                  : session.ownerAddress && session.ownerAddress.toLowerCase() !== walletAddress.toLowerCase()
                    ? "wrong-wallet"
                    : caring
                      ? "caring"
                      : "ready";

  // The owner's embedded wallet as an Alchemy signer. Shared by the care and the one-time grant so both
  // sign with the same key on the same account.
  const buildSigner = useCallback(async () => {
    if (!embedded || !walletAddress) throw new Error("no wallet");
    const provider = (await embedded.getEthereumProvider()) as { request: (a: { method: string; params?: unknown[] }) => Promise<unknown> };
    return privyWalletToSigner({
      provider,
      address: walletAddress,
      // Bind the 7702 authorization to THIS embedded wallet so the signature always recovers to the
      // UserOp sender (never a stray connected wallet).
      sign7702Authorization: (input) =>
        signAuthorization(
          { contractAddress: input.contractAddress, chainId: input.chainId, nonce: input.nonce },
          { address: walletAddress },
        ) as ReturnType<Sign7702Authorization>,
    });
  }, [embedded, walletAddress, signAuthorization]);

  const runSignInArm = useCallback(async () => {
    if (!session?.tokenId || !walletAddress) return;
    setAutoArm("arming");
    setAutoArmNote("");
    try {
      const tokenId = session.tokenId;
      const owner = walletAddress;
      // Shared with the chrome's self-heal on this same page (armOnce): one run, one result.
      const r = await armOnce(tokenId, async () =>
        armOneTap(
          liveArmDeps({ tokenId, owner, signer: await buildSigner(), getAccessToken, surface: "care" }),
          { mode: "signin", owner },
        ),
      );
      if (r.armed) {
        setOneTap({ supported: true, active: true });
        setAutoArm("done");
      } else {
        setAutoArm("failed");
        setAutoArmNote(r.detail ?? r.stage);
      }
    } catch (err) {
      setAutoArm("failed");
      setAutoArmNote(aaErrorDetail(err));
    }
  }, [session?.tokenId, walletAddress, buildSigner, getAccessToken]);

  useEffect(() => {
    if (phase !== "ready" || !canArm || autoArmTriedRef.current) return;
    autoArmTriedRef.current = true;
    void runSignInArm();
  }, [phase, canArm, runSignInArm]);

  useEffect(() => {
    if (!session?.tokenId) return;
    let live = true;
    void getCareBudget(session.tokenId, action).then((b) => {
      if (live) setBudget(b);
    });
    return () => {
      live = false;
    };
  }, [session?.tokenId, action]);

  // The honest line for a refused or held-back care: why, when to come back, how long the pet has.
  const limitMessage = (b: CareBudget | null): string => {
    const head = `Your pet's daily care limit (${b?.dailyCares ?? SEASON.dailyCares} cares per 24 hours) is used up, so nothing was spent.`;
    const life = b?.lifeSecondsLeft ? ` Your pet has ${shortDuration(b.lifeSecondsLeft)} left.` : "";
    if (b && b.reopensInSeconds) {
      const safe = b.lifeSecondsLeft != null && b.lifeSecondsLeft > b.reopensInSeconds;
      return safe
        ? `${head} Care opens again in ${shortDuration(b.reopensInSeconds)}.${life} That is enough time, so come back then and tap again.`
        : `${head} Care opens again in ${shortDuration(b.reopensInSeconds)}.${life}`;
    }
    return `${head} It opens again 24 hours after the first care in the window.${life} Check its card, then come back.`;
  };

  const onCare = useCallback(async () => {
    if (!session?.tokenId || !embedded || !walletAddress) return;
    if (caring) return; // ignore re-entry while a care is in flight (double-tap insurance)
    setCareError("");
    setEmptyPet(false);
    setCareInstead(null);
    setCaring(true);
    try {
      // THE SELLOUT GATE, answered before the keeper spends anything. The vault
      // refuses every care until the collection mints out, and a raw revert here
      // reads as "the feed failed" when nothing is wrong: the race simply has not
      // started. Say so, with the count, so the wait is legible.
      const cfg = await fetchLiveChainConfig();
      const s = cfg?.season;
      if (s?.selloutStartsSeason && !s.started) {
        // DO NOT WASTE THE TAP. The keeper came here to act, and the one thing
        // that CAN be done before the race starts is the thing that decides
        // whether they ever have to come back: arm one-tap care. Doing it now
        // means their first real feed happens on the card, silently, which is
        // the entire promise of the pass.
        let armedNow = false;
        let armFailure = "";
        if (canArm && walletAddress) {
          setArming(true);
          try {
            const signer = await buildSigner();
            // SPEND ORDER (season-1 post-mortem): the bootstrap is a SPONSORED OP
            // charged against this wallet's per-spender budget, so it fires ONLY on
            // a CONFIRMED undelegated read. Unknown (null) means try the free grant
            // first: a genuinely undelegated wallet just gets Alchemy's refusal
            // back, which costs nothing, whereas season 1 burned seven ops on
            // exactly this branch and bricked the wallet's whole care budget.
            const delegated = await isDelegated(walletAddress as Address);
            const ready =
              delegated !== false ||
              (await bootstrapDelegation(signer, BigInt(session.tokenId), await liveVaultAddress() as Address));
            if (ready) {
              const [grant, privyToken] = await Promise.all([
                grantCareSession(signer, walletAddress),
                getAccessToken(),
              ]);
              if (privyToken) {
                const installed = await installCareSession(session.tokenId, grant, privyToken);
                armedNow = Boolean(installed.active);
                setOneTap({ supported: true, active: armedNow });
              }
            }
          } catch (err) {
            // SURFACED, not swallowed (season-1 post-mortem): the keeper deserves the
            // real reason, and so do we when they read it back.
            armFailure = aaErrorDetail(err);
            console.error("[walletchi] pre-season arming failed:", err);
          } finally {
            setArming(false);
          }
        }
        setCareError(
          armedNow
            ? `The season has not started yet, so there is nothing to feed: it begins the moment the collection mints out (${s.minted} of ${s.maxSupply} so far), and every pet starts together at that instant. One-tap care is now set up, so when it starts you can feed straight from your wallet card and never come back here.`
            : `The season has not started yet, so nothing can be fed. It begins the moment the collection mints out: ${s.minted} of ${s.maxSupply} so far. Your pet's clock has not started either, so it is in no danger.${armFailure ? ` (One-tap setup hit a snag: ${armFailure})` : ""}`,
        );
        setCaring(false);
        return;
      }
      // THE EMPTY-PET GATE (2026-10-15, No. 0091). A care pulls careCost from the pet's own
      // account; with less than that inside, the op reverts and no retry can ever land. Ask first
      // so the keeper learns the real fix while there is still time. Unknown funds never block.
      const tba = session.tbaAddress ?? session.tba;
      const funds = tba ? await readPetCareFunds(tba) : null;
      if (tba && funds && funds.balance < funds.cost) {
        setCareError(outOfCareMessage(session.runnerNumber || `No. ${session.tokenId}`, funds, tba));
        setEmptyPet(true);
        return;
      }
      // SMART CARE (2026-10-17, pet No. 0038). The pet's account allows a fixed number of cares per
      // 24h and a pet dies when its STALEST need lapses, so a care on a need that can wait spends the
      // limit for nothing. Ask the server first; this need may be answered for free with the need that
      // is running out. Unknown (null) never blocks.
      const b = await getCareBudget(session.tokenId, action);
      if (b) setBudget(b);
      if (b && b.verdict !== "ok" && b.stalestAction && b.stalestAction !== action) {
        // Hunt 2026-10-18: lead with the clock and the tap that keeps the pet alive; "already cared
        // for" read as "done for today" and pets died of the need nobody tapped.
        const stalest = String(b.stalestLabel ?? b.stalestAction).toLowerCase();
        const dies = b.stalestSecondsLeft != null ? `Your Chi dies in ${shortDuration(b.stalestSecondsLeft)} unless you care for ${stalest}.` : `Your Chi needs ${stalest} next.`;
        setCareError(
          b.verdict === "fresh"
            ? `Not done yet. ${dies} This need was cared for under an hour ago, so nothing was spent.`
            : `Not done yet. ${dies} This need can wait, so nothing was spent.`,
        );
        setCareInstead(b.stalestAction);
        return;
      }
      const signer = await buildSigner();
      // Proven gasless care: the owner's embedded wallet signs one sponsored care() UserOp. This op also
      // installs the EIP-7702 delegation on a wallet that does not have one yet, which is a PREREQUISITE
      // for the one-tap grant below (Alchemy refuses wallet_createSession for an undelegated account).
      const res = await sponsoredCare(signer, BigInt(session.tokenId), action);
      if (res.status !== "success") throw new Error("failure");
      setResult(res);

      // Arm one-tap care while the wallet is warm, so this is the LAST time the keeper touches a website
      // for this pet. Strictly best effort: the feed above already landed, so any failure here just
      // leaves the pass links on this owner-signed page.
      if (canArm) {
        setArming(true);
        try {
          const [grant, privyToken] = await Promise.all([
            grantCareSession(signer, walletAddress),
            getAccessToken(),
          ]);
          if (!privyToken) throw new Error("no session token");
          const installed = await installCareSession(session.tokenId, grant, privyToken);
          setOneTap({ supported: true, active: Boolean(installed.active) });
        } catch (err) {
          // The feed above already landed, so this failure only costs one-tap; but it must be
          // SEEN (season-1 post-mortem: a bare catch here is why an armless keeper could not be
          // diagnosed). Shown on the done card via armNote; logged in full here.
          console.error("[walletchi] post-care arming failed:", err);
          setArmNote(aaErrorDetail(err));
          setOneTap({ supported: true, active: false });
        } finally {
          setArming(false);
        }
      }
    } catch (err) {
      // Ownership + death are pre-checked above, so a failure here is a transient chain/cooldown issue.
      // Recoverable: stay on "ready" and show the retry copy under the button (NOT the terminal card).
      //
      // KEEP THE REAL REASON, AND THE RIGHT PART OF IT. This used to slice the first 160 chars of
      // err.message, which for a viem JSON-RPC error is the GENERIC wrapper text: the server's
      // actual verdict lives in the Details line past the cut. Season 1 proved the cost: the message
      // Hunt read back for a day said "Invalid parameters were provided to the RPC method" while the
      // truncated tail held "Sponsorship failed: Policy's max count per spender exceeded", the
      // entire diagnosis. aaErrorDetail extracts the deepest details line from the cause chain.
      // The pet may have been emptied between the gate above and the op (a withdraw in another
      // tab), so re-read before blaming the network. "Your pet is fine" is gone on purpose: it was
      // shown to a keeper whose pet was 30 minutes from death.
      const detail = aaErrorDetail(err);
      console.error("[walletchi] sponsored care failed:", err);
      // THE DAILY LIMIT (2026-10-16, pet No. 0038): the account refused because its 24h care limit
      // is spent. "Give it a moment and try again" is a lie there; say when it reopens and how long
      // the pet has, so the keeper knows exactly when to come back.
      if (isCareLimitError(`${detail} ${err instanceof Error ? err.message : String(err)}`)) {
        const b = await getCareBudget(session.tokenId, action);
        if (b) setBudget(b);
        setCareError(limitMessage(b));
        return;
      }
      const tba = session.tbaAddress ?? session.tba;
      const funds = tba ? await readPetCareFunds(tba) : null;
      if (tba && funds && funds.balance < funds.cost) setEmptyPet(true);
      const life = budget?.lifeSecondsLeft ? ` Your pet has ${shortDuration(budget.lifeSecondsLeft)} left.` : "";
      // A wait that timed out may still land: never promise "nothing was spent" for it.
      const unconfirmed = /timeout|timed out/i.test(`${err instanceof Error ? err.name : ""} ${detail}`);
      setCareError(
        tba && funds && funds.balance < funds.cost
          ? outOfCareMessage(session.runnerNumber || `No. ${session.tokenId}`, funds, tba)
          : unconfirmed
            ? `That care is taking longer than usual to confirm. Check your pet's card in a minute before tapping again.${life} (${detail})`
            : `That did not go through, and nothing was spent. Tap again in a minute.${life} (${detail})`,
      );
    } finally {
      setCaring(false);
    }
  }, [session, embedded, walletAddress, buildSigner, getAccessToken, action, caring, canArm, budget]);

  const number = session?.runnerNumber || (session?.tokenId ? `No. ${session.tokenId}` : "your pet");
  const seed = session?.tokenId ?? serial;

  return (
    <Card>
      {session?.tokenId && phase !== "error" && (
        <div className="mx-auto" style={{ width: 168, maxWidth: "70%" }}>
          <PetPortrait serial={serial} seed={seed} width={168} />
        </div>
      )}

      {phase === "loading" && (
        <p className="mt-5 text-center text-sm" style={{ color: "var(--color-ink-soft)" }}>
          <Spin /> Waking up your pet
        </p>
      )}

      {phase === "error" && (
        <>
          <Eyebrow>We hit a snag</Eyebrow>
          <h1 className="display mt-2" style={{ fontSize: "1.5rem" }}>Could not find that pet</h1>
          <p className="mt-2 text-sm" style={{ color: "var(--color-ink-soft)" }}>
            Double-check the link from your wallet pass and try again.
          </p>
        </>
      )}

      {phase === "memorial" && (
        <>
          <Eyebrow>In memory</Eyebrow>
          <h1 className="display mt-2" style={{ fontSize: "1.5rem" }}>{number} has passed on</h1>
          <p className="mt-2 text-sm" style={{ color: "var(--color-ink-soft)" }}>
            This pet is a soulbound memorial now. It lives on its page forever, but it can no longer be cared for.
          </p>
          <a href={`/pet/${serial}`} className="btn btn-teal mt-5 w-full">See its page</a>
        </>
      )}

      {phase === "signin" && (
        <>
          <Eyebrow>{copy.emoji} {copy.verb} {number}</Eyebrow>
          <h1 className="display mt-2" style={{ fontSize: "1.5rem" }}>Sign in to care</h1>
          <p className="mt-2 text-sm" style={{ color: "var(--color-ink-soft)" }}>
            Sign in with the email that owns this pet. Gas is on us, so your own wallet never needs a
            balance. The care itself spends CARE from your pet&apos;s own account.
          </p>
          <button className="btn btn-cub mt-5 w-full" onClick={loginWithEmail}>Sign in with email</button>
        </>
      )}

      {phase === "wallet" && (
        <>
          <Eyebrow>Almost there</Eyebrow>
          <p className="mt-4 text-center text-sm" style={{ color: "var(--color-ink-soft)" }}>
            <Spin /> Getting your WALLETCHI wallet ready. Care is signed by the email wallet that owns this
            pet, so be sure you signed in with that email.
          </p>
          {/* Escape hatch: a stale external-wallet session never provisions an embedded wallet and would
              spin here forever. Let them sign out and come back through the email-only sign-in. */}
          <button className="btn btn-teal mt-5 w-full" onClick={logout}>Sign in with a different email</button>
        </>
      )}

      {phase === "custodial" && (
        <>
          <Eyebrow>Demo pet</Eyebrow>
          <h1 className="display mt-2" style={{ fontSize: "1.5rem" }}>{number} cannot be fed here</h1>
          <p className="mt-2 text-sm" style={{ color: "var(--color-ink-soft)" }}>
            This pet lives in the WALLETCHI demo wallet, not your own, so it cannot be fed. Trustless care
            only works for a pet held in your wallet. It will pass on when the first of its five need
            timers runs out.
          </p>
          <a href={`/pet/${serial}`} className="btn btn-teal mt-5 w-full">See its page</a>
        </>
      )}

      {phase === "wrong-wallet" && (
        <>
          <Eyebrow>Different wallet</Eyebrow>
          <h1 className="display mt-2" style={{ fontSize: "1.5rem" }}>{number} lives in another wallet</h1>
          <p className="mt-2 text-sm" style={{ color: "var(--color-ink-soft)" }}>
            The signed-in wallet does not own this pet. Claim it first, then come back to care for it.
          </p>
          <a href="/claim" className="btn btn-cub mt-5 w-full">Claim this pet</a>
        </>
      )}

      {(phase === "ready" || phase === "caring") && (
        <>
          <Eyebrow>{copy.emoji} {copy.verb} {number}</Eyebrow>
          <h1 className="display mt-2" style={{ fontSize: "1.6rem" }}>{copy.verb} your pet</h1>
          <p className="mt-2 text-sm" style={{ color: "var(--color-ink-soft)" }}>
            One tap, no gas: we sponsor that. The care cost is spent from your pet&apos;s own CARE
            account, and {BURN_PCT} of it burns. This resets this one need&apos;s timer, not the other four. Each need has its own 24 hour
            clock, and your pet dies when the OLDEST one runs out: that is the SURVIVES time on its card.
          </p>
          {autoArm === "arming" && (
            <p className="mt-2 text-sm" style={{ color: "var(--color-ink-soft)" }}>
              <Spin /> Turning on one-tap care, so your wallet pass buttons feed {number} without opening this page.
            </p>
          )}
          {oneTap?.active === true && autoArm === "done" && (
            <p className="mt-2 text-sm" style={{ color: "var(--color-teal-deep)" }}>
              <strong>One-tap care is on.</strong> From now on the buttons on your wallet pass feed {number}
              directly. This is the last time a tap opens this page.
            </p>
          )}
          {autoArm === "failed" && canArm && (
            <div className="mt-3">
              <button className="btn btn-teal w-full" onClick={() => void runSignInArm()}>
                Finish one-tap setup
              </button>
              <p className="mt-2 text-xs" style={{ color: "var(--color-ink-muted)" }}>
                One-tap setup did not finish, so your pass buttons open this page for now. ({autoArmNote})
              </p>
            </div>
          )}
          {canArm && autoArm === "idle" && (
            <p className="mt-2 text-sm" style={{ color: "var(--color-ink-soft)" }}>
              This also turns on one-tap care, so the buttons on the back of your wallet pass feed {number}
              from then on without opening this page again.
            </p>
          )}
          <button className="btn btn-cub mt-5 w-full" onClick={onCare} disabled={phase === "caring"}>
            {phase === "caring" ? (<><Spin /> Caring for {number}</>) : (<>{copy.emoji} {copy.verb} {number}</>)}
          </button>
          {budget?.stalestAction && budget.stalestSecondsLeft != null && (
            <p className="mt-3 text-sm" style={{ color: "var(--color-ink)" }}>
              {budget.stalestAction === action
                ? <>This is the need running out first: {shortDuration(budget.stalestSecondsLeft)} left.</>
                : <>Running out first: <strong>{String(budget.stalestLabel ?? budget.stalestAction).toLowerCase()}</strong>, {shortDuration(budget.stalestSecondsLeft)} left. That is the time your card shows under SURVIVES.</>}
            </p>
          )}
          {budget?.caresLeft != null && budget.dailyCares != null && (
            <p className="mt-2 text-xs" style={{ color: "var(--color-ink-muted)" }}>
              {budget.caresLeft} of {budget.dailyCares} cares left in this 24h window
              {budget.reopensInSeconds ? ` (refills in ${shortDuration(budget.reopensInSeconds)})` : ""}. One care for each of the five needs a day keeps your pet alive.
            </p>
          )}
          {careError && <p className="mt-3 text-sm" style={{ color: "var(--color-salmon-text)" }}>{careError}</p>}
          {careInstead && (
            <a className="btn btn-teal mt-3 w-full" href={`/care/${serial}/${careInstead}`}>
              {needGlyph(careInstead as CareAction)} {ACTION_COPY[careInstead as CareAction]?.verb ?? "Care for"} {number} instead
            </a>
          )}
          {emptyPet && (session?.tbaAddress ?? session?.tba) && (session?.ownerAddress ?? session?.owner) && (
            <PutCareBack
              tba={(session?.tbaAddress ?? session?.tba) as string}
              ownerAddress={(session?.ownerAddress ?? session?.owner) as string}
              onDone={() => {
                setEmptyPet(false);
                setCareError("");
              }}
            />
          )}
        </>
      )}

      {phase === "done" && result && (
        <>
          <Eyebrow>Done</Eyebrow>
          <h1 className="display mt-2" style={{ fontSize: "1.6rem" }}>{copy.past} {number} {copy.emoji}</h1>
          <p className="mt-2 text-sm" style={{ color: "var(--color-ink-soft)" }}>
            This care reset only this need&apos;s 24 hour timer. The other four keep
            their own clocks, and the SURVIVES time on your card is still the oldest one. You paid no gas. The CARE came out
            of your pet&apos;s own account: {BURN_PCT} burned, {REWARDS_PCT} to keepers, {POT_PCT} to
            the Pot, {GAS_PCT} to gas.
          </p>
          {budget?.caresLeft != null && budget.dailyCares != null && (
            <p className="mt-2 text-xs" style={{ color: "var(--color-ink-muted)" }}>
              {Math.max(0, budget.caresLeft - 1)} of {budget.dailyCares} cares left in this 24h window. One care for each of the five needs a day keeps your pet alive; a need you just cared for gains nothing.
            </p>
          )}
          {arming && (
            <p className="mt-4 text-sm" style={{ color: "var(--color-ink-soft)" }}>
              <Spin /> Setting up one-tap care
            </p>
          )}
          {!arming && oneTap?.active === true && (
            <div className="mt-4 rounded-xl px-4 py-3 text-sm" style={{ background: "rgba(47,125,122,0.10)", color: "var(--color-ink-soft)" }}>
              <strong style={{ color: "var(--color-teal-deep)" }}>One-tap care is on.</strong> From now on, the care
              buttons on the back of your wallet pass care for {number} on their own. No website, no signing. You
              gave permission for care actions only: it can never move your pet or its coins.
            </div>
          )}
          {!arming && armNote && oneTap?.active !== true && (
            <p className="mt-4 text-sm" style={{ color: "var(--color-ink-soft)" }}>
              One-tap setup did not finish this time, so your pass buttons will open this page for now.
              It will try again on your next care. ({armNote})
            </p>
          )}
          <div className="mt-5 flex flex-col gap-3">
            <a href={`/pet/${serial}`} className="btn btn-teal w-full">See its page</a>
            <a href={result.explorerUrl} target="_blank" rel="noreferrer" className="text-center text-sm font-bold" style={{ color: "var(--color-ink-muted)" }}>
              View on the explorer
            </a>
          </div>
        </>
      )}
    </Card>
  );
}

/* --------------------------------------------------------------- chrome bits */

function Card({ children }: { children: React.ReactNode }) {
  return <div className="soft-card mx-auto max-w-[480px] p-6 text-center sm:p-8">{children}</div>;
}
function Eyebrow({ children }: { children: React.ReactNode }) {
  return <div className="eyebrow" style={{ color: "var(--color-teal-deep)" }}>{children}</div>;
}
function Spin() {
  return <span className="spin" style={{ borderTopColor: "var(--color-teal-deep)", borderColor: "rgba(28,127,143,0.35)" }} />;
}
