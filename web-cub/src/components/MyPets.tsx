"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { PetPortrait } from "./PetPortrait";
import { OpenInSafariHint } from "./OpenInSafariHint";
import { FundFlow } from "./FundFlow";
import { RewardsPanel } from "./RewardsPanel";
import { PrivyGate, type PrivySessionInfo } from "./PrivyGate";
import {
  getPetsByOwner,
  getRunnerState,
  fetchOwnerPassLink,
  resetOwnerPassLinks,
  prepareGift,
  getGiftStatus,
  ApiError,
  type OwnedPet,
  type CareActionResult,
  type GiftPrepared,
  getCareSessionStatus,
} from "@/lib/api";
import { sponsoredGift } from "@/lib/aa";
import { aaErrorDetail } from "@/lib/aa-errors";
import type { Address, Hex } from "viem";
import { formatDuration } from "@/lib/format";
import { safeUrl } from "@/lib/safe-url";
import { CARE_TOKEN_READY, MINT_OPEN } from "@/lib/brand";
import { NEED_ACTIONS, NEED_GLYPHS, NEED_LABELS, readNeeds } from "@/lib/needs";

/**
 * The /me dashboard: sign in with email (Privy), see the pet(s) your wallet
 * owns, feed them from the site, top up their tank, add their pass. When Privy
 * is not configured this renders a gentle "warming up" card so the page never
 * breaks a demo build.
 */
export function MyPets() {
  return (
    <PrivyGate fallback={<NotConfigured />}>{(s) => <Dashboard session={s} />}</PrivyGate>
  );
}

function NotConfigured() {
  return (
    <div className="soft-card mx-auto max-w-[520px] p-6 text-center sm:p-8">
      <div className="mx-auto mb-4 grid h-16 w-16 place-items-center rounded-full" style={{ background: "var(--color-teal-soft)", fontSize: 28 }}>
        🔑
      </div>
      <h1 className="display" style={{ fontSize: "clamp(1.6rem, 4vw, 2.1rem)" }}>
        Sign-in is warming up
      </h1>
      <p className="mt-2 text-sm" style={{ color: "var(--color-ink-soft)" }}>
        Email sign-in is not switched on for this build yet. Your pet still lives happily in your
        wallet pass, and you can always claim a pass on the claim page.
      </p>
      <div className="mt-5 flex flex-wrap justify-center gap-3">
        {MINT_OPEN && <a href="/#adopt" className="btn btn-cub">Get my pet</a>}
        <a href="/claim" className="btn btn-ghost">Claim a pass</a>
      </div>
    </div>
  );
}

function short(a?: string | null): string {
  return a ? `${a.slice(0, 6)}...${a.slice(-4)}` : "";
}

/* ------------------------------------------------------------- dashboard */

function Dashboard({ session }: { session: PrivySessionInfo }) {
  if (!session.ready) {
    return (
      <div className="flex items-center justify-center gap-3 py-20">
        <span className="spin" />
        <span className="text-sm font-bold" style={{ color: "var(--color-ink-muted)" }}>
          Opening your den
        </span>
      </div>
    );
  }
  if (!session.authenticated) {
    return <SignInCard onLogin={session.login} />;
  }
  return <SignedIn session={session} />;
}

function SignInCard({ onLogin }: { onLogin: () => void }) {
  return (
    <div className="soft-card mx-auto max-w-[520px] p-6 text-center sm:p-8">
      <div className="mx-auto mb-4 grid h-16 w-16 place-items-center rounded-full cub-bounce" style={{ background: "var(--color-lav-soft)", fontSize: 28 }}>
        🐾
      </div>
      <div className="eyebrow" style={{ color: "var(--color-lav-deep)" }}>
        Your den
      </div>
      <h1 className="display mt-1" style={{ fontSize: "clamp(1.6rem, 4vw, 2.1rem)" }}>
        Sign in to see your pets
      </h1>
      <p className="mt-2 text-sm" style={{ color: "var(--color-ink-soft)" }}>
        Just your email: we send a quick code, no passwords, no app. Your pets, their meters, and
        the feed buttons all live right here.
      </p>
      <button className="btn btn-cub mt-5 w-full" onClick={onLogin}>
        Sign in with email
      </button>
      <p className="mt-3 text-xs" style={{ color: "var(--color-ink-muted)" }}>
        First time? Signing in also sets up a wallet for you, invisibly.
      </p>
    </div>
  );
}

function SignedIn({ session }: { session: PrivySessionInfo }) {
  const wallet = session.walletAddress;
  const [pets, setPets] = useState<OwnedPet[] | null>(null);
  const [loading, setLoading] = useState(true);

  const refresh = useCallback(async () => {
    if (!wallet) {
      setLoading(false);
      return;
    }
    const list = await getPetsByOwner(wallet);
    setPets(list);
    setLoading(false);
  }, [wallet]);

  useEffect(() => {
    refresh();
  }, [refresh]);

  return (
    <div>
      {/* who is signed in */}
      <div className="soft-card flex flex-wrap items-center justify-between gap-3 p-4 sm:p-5">
        <div className="flex min-w-0 items-center gap-3">
          <span className="grid h-10 w-10 flex-none place-items-center rounded-2xl" style={{ background: "var(--color-teal-soft)", fontSize: 18 }} aria-hidden>
            👤
          </span>
          <div className="min-w-0">
            <div className="truncate text-sm font-bold" style={{ color: "var(--color-ink)" }}>
              {session.email || "Signed in"}
            </div>
            {wallet ? (
              <div className="mono text-xs" style={{ color: "var(--color-ink-muted)" }} title={wallet}>
                Wallet {short(wallet)}
              </div>
            ) : (
              <div className="text-xs" style={{ color: "var(--color-ink-muted)" }}>
                Setting up your wallet...
              </div>
            )}
          </div>
        </div>
        <button className="btn btn-ghost" style={{ padding: "0.5rem 1rem", minHeight: 40, fontSize: "0.85rem" }} onClick={() => session.logout()}>
          Sign out
        </button>
      </div>

      <div className="mt-8">
        <div className="eyebrow" style={{ color: "var(--color-salmon-text)" }}>
          My pets
        </div>
        {loading ? (
          <div className="mt-6 flex items-center gap-3">
            <span className="spin" />
            <span className="text-sm font-bold" style={{ color: "var(--color-ink-muted)" }}>
              Looking for your pets
            </span>
          </div>
        ) : !pets || pets.length === 0 ? (
          // A first-time user whose Privy wallet is still provisioning has pets === null
          // simply because we never fetched: that is "wallet on its way", not "den napping".
          <EmptyDen unreachable={Boolean(wallet) && pets === null} walletPending={!wallet} />
        ) : (
          <div className="mt-5 grid gap-6 md:grid-cols-2">
            {pets.map((p) => (
              <PetCard key={p.serial ?? p.tokenId} pet={p} session={session} />
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

function EmptyDen({ unreachable, walletPending }: { unreachable: boolean; walletPending: boolean }) {
  return (
    <div className="soft-card mt-5 max-w-[560px] p-6 sm:p-7">
      <h2 className="display" style={{ fontSize: "1.4rem" }}>
        {unreachable
          ? "The den is napping"
          : walletPending
            ? "Your wallet is on its way"
            : "No pet lives here yet"}
      </h2>
      <p className="mt-2 text-sm" style={{ color: "var(--color-ink-soft)" }}>
        {unreachable
          ? "We could not reach the den just now. Give it a moment and refresh."
          : walletPending
            ? "We are finishing your wallet setup. This usually takes a few seconds; refresh in a moment."
            : "This wallet does not hold a WALLETCHI yet. Hatch one free, or if someone sent you one it will appear here once it is in this wallet."}
      </p>
      <div className="mt-4 flex flex-wrap gap-3">
        {MINT_OPEN && <a href="/#adopt" className="btn btn-cub">Get my pet, free</a>}
        <a href="/claim" className="btn btn-ghost">Someone sent me one</a>
      </div>
    </div>
  );
}

/* --------------------------------------------------------------- pet card */

// ALL FIVE needs. Toy and Explore used to be missing here, which meant a keeper who used this
// dashboard as their care surface could not keep a pet alive: the two needs with no button still
// lapsed, and any lapsed need kills the pet. Actions, labels and glyphs come from the shared set
// (lib/needs.ts, mirroring server/src/runner/needs.ts), so the same action looks the same on the
// card, the care page, the confirm page and here.
const CARE_BUTTONS = NEED_ACTIONS.map((action, i) => ({
  action,
  label: NEED_LABELS[i]!,
  emoji: NEED_GLYPHS[i]!,
}));

const STATUS_LABEL: Record<string, string> = {
  alive: "Alive",
  critical: "Critical",
  dead: "At rest",
};

function PetCard({ pet, session }: { pet: OwnedPet; session: PrivySessionInfo }) {
  const [live, setLive] = useState<OwnedPet>(pet);
  const [busyAction, setBusyAction] = useState<string | null>(null);
  const [result, setResult] = useState<CareActionResult | null>(null);
  const [careError, setCareError] = useState("");
  const [fundOpen, setFundOpen] = useState(false);
  const [passLinks, setPassLinks] = useState<{ applePassUrl?: string; googleSaveUrl?: string } | null>(null);
  const [passBusy, setPassBusy] = useState(false);
  const [passError, setPassError] = useState("");
  // RESET MY PASS LINKS (Wallet Pass Extension: links rotate on the owner's request). A three-step
  // strip: idle button, confirm, then a status line. On success the fresh Apple / Google buttons
  // take over the pass slot above, because the old card is a keepsake from this moment.
  const [resetStep, setResetStep] = useState<"idle" | "confirm" | "busy" | "done">("idle");
  const [resetStatus, setResetStatus] = useState("");
  const [resetError, setResetError] = useState("");
  // GIFT THIS PET. idle -> recipient (who) -> preparing (the den resolves them and records the
  // intent its gas webhook will fund) -> confirm (what goes with the pet) -> signing (ONE owner
  // signature, a sponsored transferFrom from the embedded wallet's smart account) -> waiting (the
  // den watches ownerOf) -> sent. The care session key is never involved: it cannot transfer.
  const [giftStep, setGiftStep] = useState<
    "idle" | "recipient" | "preparing" | "confirm" | "signing" | "waiting" | "sent" | "failed"
  >("idle");
  const [giftRecipient, setGiftRecipient] = useState("");
  const [giftPrepared, setGiftPrepared] = useState<GiftPrepared | null>(null);
  const [giftTxUrl, setGiftTxUrl] = useState("");
  const [giftError, setGiftError] = useState("");
  const [giftLanded, setGiftLanded] = useState(false);
  // SIGN-IN ARMING (2026-09-23): a signed-in owner whose pet was never armed gets it armed here, once,
  // without hatching it (lib/arming.ts, sign-in mode). Only a pet the server says is NOT armed is
  // touched, and a failure leaves a "Finish one-tap setup" button with the real reason.
  const [oneTap, setOneTap] = useState<"unknown" | "arming" | "on" | "off" | "failed">("unknown");
  const armTriedRef = useRef(false);
  const resultTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(
    () => () => {
      if (resultTimer.current) clearTimeout(resultTimer.current);
    },
    [],
  );

  const status = (live.status || "alive").toLowerCase();

  const armNow = useCallback(async () => {
    if (!live.tokenId) return;
    setOneTap("arming");
    const ok = await session.armOnSignIn(live.tokenId).catch(() => false);
    setOneTap(ok ? "on" : "failed");
  }, [live.tokenId, session]);

  useEffect(() => {
    // Wait for the embedded signer (session.signerReady) before the one attempt, or the attempt
    // fires into "no embedded wallet yet" and the ref blocks the retry.
    if (armTriedRef.current || !live.tokenId || status === "dead" || !session.walletAddress || !session.signerReady) return;
    armTriedRef.current = true;
    void getCareSessionStatus(live.tokenId).then((st) => {
      if (!st || !st.supported) return;
      if (st.active) {
        setOneTap("on");
        return;
      }
      setOneTap("off");
      void armNow();
    });
  }, [live.tokenId, status, session.walletAddress, armNow, session.signerReady]);
  const number = live.number || (live.tokenId ? `No. ${live.tokenId}` : "Your pet");
  const lifeLeft = status === "dead" ? "" : formatDuration(live.secondsLeft);
  const needs = readNeeds(live.needs, live);

  // Pull the fresh meters after a care action (the by-owner shape and the
  // runner state share the meter field names).
  const refreshMeters = useCallback(async () => {
    if (!pet.serial) return;
    const s = await getRunnerState(pet.serial);
    if (s) {
      setLive((prev) => ({
        ...prev,
        hunger: s.hunger ?? prev.hunger,
        thirst: s.thirst ?? prev.thirst,
        joy: s.joy ?? prev.joy,
        // Per-need clocks, so the five meters refresh with the same authority
        // (the chain) as the three legacy ones.
        needs: s.needs ?? prev.needs,
        hatched: s.hatched ?? prev.hatched,
        status: s.gone ? "dead" : s.critical ? "critical" : "alive",
        secondsLeft: s.secondsLeft ?? prev.secondsLeft,
        careCount: s.careCount ?? prev.careCount,
      }));
    }
  }, [pet.serial]);

  const care = useCallback(
    (action: string) => {
      // Care is trustless + on-chain now: the owner signs a gas-sponsored care() on the /care page. The
      // old server relay is retired (410), so the dashboard hands off to that page for the chosen action
      // instead of relaying. Keeps a single, proven care path (same as the wallet-pass buttons).
      if (!pet.serial) return;
      window.location.href = `/care/${pet.serial}/${action}`;
    },
    [pet.serial],
  );

  const addToWallet = useCallback(async () => {
    if (!live.tokenId || passBusy) return;
    setPassBusy(true);
    setPassError("");
    try {
      const token = await session.getAccessToken();
      const links = await fetchOwnerPassLink({
        tokenId: live.tokenId,
        ...(token ? { privyToken: token } : {}),
      });
      // A 200 with no links is still a miss: keep the button so the user can retry.
      if (links && (links.applePassUrl || links.googleSaveUrl)) {
        setPassLinks(links);
      } else {
        setPassError("The den did not hand back a pass link. Please try again in a moment.");
      }
    } catch (err) {
      setPassError(
        err instanceof ApiError ? err.message : "We could not fetch your pass link. Try again.",
      );
    } finally {
      setPassBusy(false);
    }
  }, [live.tokenId, passBusy, session]);

  const resetLinks = useCallback(async () => {
    if (!live.tokenId || resetStep === "busy") return;
    setResetStep("busy");
    setResetError("");
    setResetStatus("Resetting your pass links");
    try {
      const token = await session.getAccessToken();
      const fresh = await resetOwnerPassLinks({
        tokenId: live.tokenId,
        ...(token ? { privyToken: token } : {}),
      });
      setResetStep("done");
      setResetStatus("Links reset. Your card will update in a moment.");
      // The response carries the fresh acquisition links in the pass-link shape: show them in the
      // pass slot so the keeper can re-add the card without a second tap.
      if (fresh && (fresh.applePassUrl || fresh.googleSaveUrl)) {
        setPassLinks({
          ...(fresh.applePassUrl ? { applePassUrl: fresh.applePassUrl } : {}),
          ...(fresh.googleSaveUrl ? { googleSaveUrl: fresh.googleSaveUrl } : {}),
        });
        setPassError("");
      }
    } catch (err) {
      setResetStep("idle");
      setResetStatus("");
      setResetError(
        err instanceof ApiError ? err.message : "We could not reset your links. Try again in a moment.",
      );
    }
  }, [live.tokenId, resetStep, session]);

  const giftPrepare = useCallback(async () => {
    const who = giftRecipient.trim();
    if (!live.tokenId || !who) {
      setGiftError("Enter the email they sign in with, or their wallet address.");
      return;
    }
    setGiftStep("preparing");
    setGiftError("");
    try {
      const token = await session.getAccessToken();
      const prepared = await prepareGift({
        tokenId: live.tokenId,
        recipient: who,
        ...(token ? { privyToken: token } : {}),
      });
      if (!prepared.intentId || !prepared.call?.to || !prepared.call?.data) {
        throw new ApiError("The den did not hand back a gift to sign. Please try again in a moment.");
      }
      setGiftPrepared(prepared);
      setGiftStep("confirm");
    } catch (err) {
      setGiftStep("recipient");
      setGiftError(err instanceof ApiError ? err.message : "We could not prepare the gift. Try again in a moment.");
    }
  }, [giftRecipient, live.tokenId, session]);

  const giftSend = useCallback(async () => {
    if (!live.tokenId || !giftPrepared?.call?.to || !giftPrepared.call.data || !giftPrepared.intentId) return;
    setGiftStep("signing");
    setGiftError("");
    try {
      // The intent is short-lived. Past its window the webhook would refuse the op, so re-prepare
      // the same recipient first rather than sending the keeper into a refusal.
      let prepared = giftPrepared;
      if (prepared.expiresAt && Date.parse(prepared.expiresAt) - Date.now() < 30_000) {
        const token = await session.getAccessToken();
        prepared = await prepareGift({
          tokenId: live.tokenId,
          recipient: prepared.recipientEmail ?? prepared.to ?? giftRecipient.trim(),
          ...(token ? { privyToken: token } : {}),
        });
        setGiftPrepared(prepared);
      }
      const signer = await session.getOwnerSigner();
      if (!signer) throw new Error("Your wallet is still setting up. Give it a moment and try again.");
      const res = await sponsoredGift(signer, { to: prepared.call!.to as Address, data: prepared.call!.data as Hex });
      setGiftTxUrl(res.explorerUrl);
      if (res.status !== "success") throw new Error("The transfer did not go through on-chain. Nothing moved; you can try again.");
      setGiftStep("waiting");
      // The den settles the gift against a fresh ownerOf read and retires this wallet's one-tap
      // session; the recipient's first sign-in then rotates the pass. Poll briefly so the card can
      // say "landed" instead of "sent" when the read catches up.
      let landed = false;
      for (let i = 0; i < 20 && !landed; i++) {
        const st = await getGiftStatus(live.tokenId, prepared.intentId!);
        landed = st?.status === "landed";
        if (!landed) await new Promise((r) => setTimeout(r, 2000));
      }
      setGiftLanded(landed);
      setGiftStep("sent");
    } catch (err) {
      setGiftStep("failed");
      setGiftError(err instanceof ApiError ? err.message : aaErrorDetail(err));
    }
  }, [giftPrepared, giftRecipient, live.tokenId, session]);

  // Once the gift is signed the pet is no longer this wallet's to feed, fund or re-add: the card
  // becomes the hand-off note, with the recipient's next step and the transaction.
  if (giftStep === "sent" && giftPrepared) {
    const claimHost = (() => {
      try {
        return new URL(giftPrepared.claimUrl ?? "/claim", window.location.origin).host;
      } catch {
        return window.location.host;
      }
    })();
    const to = giftPrepared.recipientEmail ?? short(giftPrepared.to);
    return (
      <div className="soft-card p-5 sm:p-6">
        <div className="flex items-start gap-4">
          <PetPortrait serial={pet.serial} seed={pet.tokenId ?? pet.serial} width={104} className="flex-none" />
          <div className="min-w-0 flex-1">
            <div className="flex flex-wrap items-center gap-2">
              <h2 className="display" style={{ fontSize: "1.35rem" }}>
                {number}
              </h2>
              <span className="status-tag status-tag-alive">Gifted</span>
            </div>
            <p className="mt-1 text-xs" style={{ color: "var(--color-ink-muted)" }}>
              {giftLanded ? `Now living with ${to}.` : `On its way to ${to}.`}
            </p>
          </div>
        </div>
        <div className="mt-4 rounded-2xl p-3 text-sm" style={{ background: "var(--color-teal-soft)" }} role="status">
          <span aria-hidden>🎁 </span>
          <span className="font-bold">{giftLanded ? "Gift landed." : "Gift sent."}</span>
          <span style={{ color: "var(--color-ink-soft)" }}>
            {" "}
            Tell them to open <span className="mono">{claimHost}/claim</span>
            {giftPrepared.recipientEmail ? (
              <>
                , or to sign in at <span className="mono">{claimHost}/me</span> with {giftPrepared.recipientEmail} and tap Add to wallet.
              </>
            ) : (
              <> and connect the wallet you sent it to.</>
            )}{" "}
            Their first claim hands them the pass and turns your card into a keepsake.
          </span>
        </div>
        {safeUrl(giftTxUrl) && (
          <a href={safeUrl(giftTxUrl)} target="_blank" rel="noreferrer" className="mt-2 inline-block text-xs font-bold" style={{ color: "var(--color-teal-deep)" }}>
            See the transfer on the explorer
          </a>
        )}
      </div>
    );
  }

  return (
    <div className="soft-card p-5 sm:p-6">
      <div className="flex items-start gap-4">
        <PetPortrait serial={pet.serial} seed={pet.tokenId ?? pet.serial} width={104} className="flex-none" />
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <h2 className="display" style={{ fontSize: "1.35rem" }}>
              {number}
            </h2>
            <span className={`status-tag status-tag-${status}`}>{STATUS_LABEL[status] || "Alive"}</span>
          </div>
          <p className="mt-1 text-xs" style={{ color: "var(--color-ink-muted)" }}>
            {status === "dead"
              ? "A soulbound memorial. Gone, but not forgotten."
              : live.hatched === false
                ? "Still an egg. Any care hatches it."
                : lifeLeft
                  ? `${lifeLeft} of life left`
                  : "Living happily on-chain"}
          </p>
          {pet.serial && (
            <a href={`/pet/${pet.serial}`} className="mt-1 inline-block text-xs font-bold" style={{ color: "var(--color-teal-deep)" }}>
              See its live page
            </a>
          )}
        </div>
      </div>

      {/* ALL FIVE needs, most urgent first, exactly like the wallet card. Three
          meters used to stand in for five needs (play, toy and explore shared
          one "Joy" bar), so a keeper could not see which clock was about to
          kill the pet. */}
      <div className="mt-4 grid gap-2">
        {needs.map((n) => (
          <MiniMeter
            key={n.action}
            label={n.label}
            glyph={n.glyph}
            value={n.pct}
            color={n.color}
            {...(typeof n.secondsLeft === "number" ? { secondsLeft: n.secondsLeft } : {})}
          />
        ))}
      </div>

      {/* funding nudge: a fresh pet is seeded with a starter float of CARE, so
          its first meals go through, but that float is finite and every care
          spends from it. Point at the Top-up flow BEFORE the tank runs dry.
          Disappears after the first successful care. */}
      {CARE_TOKEN_READY && status !== "dead" && (live.careCount ?? 0) === 0 && !result && (
        <div className="mt-4 rounded-2xl p-3" style={{ background: "var(--color-sky-3)", boxShadow: "inset 0 0 0 1.5px rgba(209,85,46,0.2)" }}>
          <div className="text-sm font-bold" style={{ color: "var(--color-ink)" }}>
            <span aria-hidden>🪙 </span>Keep your pet&apos;s tank full
          </div>
          <p className="mt-1 text-xs" style={{ color: "var(--color-ink-soft)" }}>
            Every care action spends CARE from your pet&apos;s own account. It hatches with a
            starter float, and when that runs dry its meals stop. Top it up so they keep going.
          </p>
          <button className="btn btn-cub mt-2 w-full" style={{ minHeight: 42, fontSize: "0.85rem" }} onClick={() => setFundOpen(true)}>
            <span aria-hidden>🍯</span> Fund my pet
          </button>
        </div>
      )}

      {/* care result flash: the same branded card for happy results and for the
          den's kind failures; a 402 (tank empty) brings the Top-up right here. */}
      {result && (
        <div
          className="mt-4 rounded-2xl p-3 text-sm"
          style={{
            background: result.ok === false ? "var(--color-sky-3)" : "var(--color-teal-soft)",
            ...(result.ok === false ? { boxShadow: "inset 0 0 0 1.5px rgba(209,85,46,0.2)" } : {}),
          }}
          role="status"
        >
          <span aria-hidden>{result.emoji} </span>
          <span className="font-bold">{result.title}</span>
          {result.stat?.statLabel && typeof result.stat.delta === "number" && (
            <span className="font-bold" style={{ color: "var(--color-salmon-text)" }}>
              {" "}
              {result.stat.statLabel} +{result.stat.delta}
            </span>
          )}
          <span style={{ color: "var(--color-ink-soft)" }}> {result.body}</span>
          {result.httpStatus === 402 && status !== "dead" && (
            <button
              className="btn btn-cub mt-3 w-full"
              style={{ minHeight: 42, fontSize: "0.85rem" }}
              onClick={() => {
                setResult(null);
                setFundOpen(true);
              }}
            >
              <span aria-hidden>🍯</span> Top up its tank
            </button>
          )}
        </div>
      )}
      {careError && (
        <p className="mt-4 text-sm" style={{ color: "var(--color-salmon-text)" }}>
          {careError}
        </p>
      )}

      {/* one-tap care status: only shown while it is being set up or when it needs a hand */}
      {status !== "dead" && oneTap === "arming" && (
        <p className="mt-4 text-sm" style={{ color: "var(--color-ink-soft)" }}>
          <span className="spin" /> Turning on one-tap care for your wallet pass
        </p>
      )}
      {status !== "dead" && oneTap === "failed" && (
        <div className="mt-4">
          <button className="btn btn-teal w-full" style={{ minHeight: 44 }} onClick={() => void armNow()}>
            Finish one-tap setup
          </button>
          <p className="mt-2 text-xs" style={{ color: "var(--color-ink-muted)" }}>
            Until this is done, the buttons on your wallet pass open the website instead of feeding {number} directly.
          </p>
        </div>
      )}

      {/* care buttons */}
      {status !== "dead" && (
        <div className="mt-4 grid grid-cols-3 gap-2">
          {CARE_BUTTONS.map((b) => (
            <button
              key={b.action}
              className="btn btn-teal"
              style={{ padding: "0.55rem 0.5rem", minHeight: 42, fontSize: "0.85rem" }}
              disabled={busyAction !== null}
              onClick={() => care(b.action)}
            >
              {busyAction === b.action ? (
                <span className="spin" style={{ borderColor: "rgba(28,127,143,0.3)", borderTopColor: "var(--color-teal-deep)" }} />
              ) : (
                <span aria-hidden>{b.emoji}</span>
              )}{" "}
              {b.label}
            </button>
          ))}
        </div>
      )}

      {/* top up + pass */}
      <div className="mt-3 grid gap-2 sm:grid-cols-2">
        {/* Testnet: CARE has no market and every pet starts with 500, so there is nothing to
            buy. The top-up stays reachable where it matters: the tank-empty (402) result above. */}
        {CARE_TOKEN_READY && status !== "dead" && (
          <button className="btn btn-cub" style={{ minHeight: 44 }} onClick={() => setFundOpen(true)}>
            <span aria-hidden>🍯</span> Top up its tank
          </button>
        )}
        {status !== "dead" &&
          (passLinks ? (
            <div className="grid gap-2">
              {safeUrl(passLinks.applePassUrl) && (
                <a href={safeUrl(passLinks.applePassUrl)} target="_blank" rel="noreferrer" className="btn btn-apple">
                  Add to Apple Wallet
                </a>
              )}
              {passLinks.googleSaveUrl && (
                <a href={safeUrl(passLinks.googleSaveUrl)} target="_blank" rel="noreferrer" className="btn btn-google">
                  Save to Google Wallet
                </a>
              )}
            </div>
          ) : (
            <button className="btn btn-ghost" style={{ minHeight: 44 }} disabled={passBusy} onClick={addToWallet}>
              {passBusy ? (
                <>
                  <span className="spin" /> Fetching
                </>
              ) : (
                <>Add to wallet</>
              )}
            </button>
          ))}
      </div>
      {passError && (
        <p className="mt-2 text-xs" style={{ color: "var(--color-salmon-text)" }}>
          {passError}
        </p>
      )}
      {/* in-app browsers (X, Instagram...) cannot add the pass: say so right under the result */}
      {status !== "dead" && (passLinks || passError) && (
        <OpenInSafariHint className="mt-2" appleUrl={passLinks?.applePassUrl} googleUrl={passLinks?.googleSaveUrl} />
      )}

      {/* reset my pass links: the owner's remedy for a leaked link. Every link the current
          card carries dies and the fresh Apple / Google buttons appear in the pass slot above.
          Secondary on purpose (ghost, small): it retires the card on the keeper's own phone too. */}
      {status !== "dead" && (
        <div className="mt-3">
          {resetStep === "idle" && (
            <button
              type="button"
              className="btn btn-ghost w-full"
              style={{ minHeight: 40, fontSize: "0.85rem" }}
              onClick={() => {
                setResetError("");
                setResetStep("confirm");
              }}
            >
              Reset my pass links
            </button>
          )}
          {resetStep === "confirm" && (
            <div className="rounded-2xl p-3" style={{ background: "var(--color-sky-3)", boxShadow: "inset 0 0 0 1.5px rgba(209,85,46,0.2)" }}>
              <div className="text-sm font-bold" style={{ color: "var(--color-ink)" }}>
                Reset the links on {number}&apos;s card?
              </div>
              <p className="mt-1 text-xs" style={{ color: "var(--color-ink-soft)" }}>
                If a link on your card leaked, this kills every old link and re-sends the card. The
                card already on your phone stops working too, so add the fresh one right after.
              </p>
              <div className="mt-2 grid grid-cols-2 gap-2">
                <button type="button" className="btn btn-cub" style={{ minHeight: 42, fontSize: "0.85rem" }} onClick={() => void resetLinks()}>
                  Yes, reset them
                </button>
                <button type="button" className="btn btn-ghost" style={{ minHeight: 42, fontSize: "0.85rem" }} onClick={() => setResetStep("idle")}>
                  Keep them
                </button>
              </div>
            </div>
          )}
          {resetStep === "busy" && (
            <p className="text-sm" style={{ color: "var(--color-ink-soft)" }}>
              <span className="spin" /> Resetting your pass links
            </p>
          )}
          {resetStep === "done" && (
            <div className="rounded-2xl p-3 text-sm" style={{ background: "var(--color-teal-soft)" }}>
              <span aria-hidden>🔒 </span>
              <span className="font-bold">Links reset.</span>
              <span style={{ color: "var(--color-ink-soft)" }}> Your card will update in a moment. Add the fresh card from the buttons above.</span>
            </div>
          )}
          {/* One live region for every state change, so a screen reader hears the outcome
              without the strip re-announcing itself on each re-render. */}
          <p className="sr-only" aria-live="polite" role="status">
            {resetError || resetStatus}
          </p>
          {resetError && (
            <p className="mt-2 text-xs" style={{ color: "var(--color-salmon-text)" }}>
              {resetError}
            </p>
          )}
        </div>
      )}

      {/* gift this pet: hand a living pet to someone else. Secondary on purpose (ghost, small): it
          is the one action that moves the pet out of this wallet for good. The pet, its pass and its
          CARE account go together; this card becomes a keepsake once the new owner claims. */}
      {status !== "dead" && (
        <div className="mt-3">
          {giftStep === "idle" && (
            <button
              type="button"
              className="btn btn-ghost w-full"
              style={{ minHeight: 40, fontSize: "0.85rem" }}
              onClick={() => {
                setGiftError("");
                setGiftStep("recipient");
              }}
            >
              Gift this pet
            </button>
          )}
          {(giftStep === "recipient" || giftStep === "preparing") && (
            <form
              className="rounded-2xl p-3"
              style={{ background: "var(--color-sky-3)", boxShadow: "inset 0 0 0 1.5px rgba(209,85,46,0.2)" }}
              onSubmit={(ev) => {
                ev.preventDefault();
                void giftPrepare();
              }}
            >
              <div className="text-sm font-bold" style={{ color: "var(--color-ink)" }}>
                Who gets {number}?
              </div>
              <p className="mt-1 text-xs" style={{ color: "var(--color-ink-soft)" }}>
                The email they sign in to WALLETCHI with (they need to have signed in once), or their
                wallet address.
              </p>
              <input
                type="text"
                inputMode="email"
                autoComplete="off"
                className="field mt-2"
                placeholder="friend@email.com or 0x..."
                value={giftRecipient}
                disabled={giftStep === "preparing"}
                onChange={(ev) => setGiftRecipient(ev.target.value)}
                aria-label="Who receives this pet"
              />
              <div className="mt-2 grid grid-cols-2 gap-2">
                <button type="submit" className="btn btn-cub" style={{ minHeight: 42, fontSize: "0.85rem" }} disabled={giftStep === "preparing"}>
                  {giftStep === "preparing" ? (
                    <>
                      <span className="spin" /> Finding them
                    </>
                  ) : (
                    <>Continue</>
                  )}
                </button>
                <button type="button" className="btn btn-ghost" style={{ minHeight: 42, fontSize: "0.85rem" }} disabled={giftStep === "preparing"} onClick={() => setGiftStep("idle")}>
                  Never mind
                </button>
              </div>
            </form>
          )}
          {giftStep === "confirm" && giftPrepared && (
            <div className="rounded-2xl p-3" style={{ background: "var(--color-sky-3)", boxShadow: "inset 0 0 0 1.5px rgba(209,85,46,0.2)" }}>
              <div className="text-sm font-bold" style={{ color: "var(--color-ink)" }}>
                Give {number} to {giftPrepared.recipientEmail ?? short(giftPrepared.to)}?
              </div>
              {giftPrepared.recipientEmail && (
                <p className="mono mt-1 text-xs" style={{ color: "var(--color-ink-muted)" }} title={giftPrepared.to}>
                  Their wallet {short(giftPrepared.to)}
                </p>
              )}
              <p className="mt-1 text-xs" style={{ color: "var(--color-ink-soft)" }}>
                The pet, its wallet pass and its CARE account all go with it. Its clocks keep running
                through the hand-off, so they should claim it soon. Your card becomes a keepsake the
                moment they claim, and the new owner claims the pass at {(() => {
                  try {
                    return new URL(giftPrepared.claimUrl ?? "/claim", window.location.origin).host;
                  } catch {
                    return window.location.host;
                  }
                })()}/claim. You sign once; there is no gas to pay.
              </p>
              <div className="mt-2 grid grid-cols-2 gap-2">
                <button type="button" className="btn btn-cub" style={{ minHeight: 42, fontSize: "0.85rem" }} onClick={() => void giftSend()}>
                  Yes, gift it
                </button>
                <button type="button" className="btn btn-ghost" style={{ minHeight: 42, fontSize: "0.85rem" }} onClick={() => setGiftStep("recipient")}>
                  Go back
                </button>
              </div>
            </div>
          )}
          {giftStep === "signing" && (
            <p className="text-sm" style={{ color: "var(--color-ink-soft)" }}>
              <span className="spin" /> Sending {number} on its way (one signature, no gas)
            </p>
          )}
          {giftStep === "waiting" && (
            <p className="text-sm" style={{ color: "var(--color-ink-soft)" }}>
              <span className="spin" /> Transfer sent. Waiting for the den to see it land
            </p>
          )}
          {giftStep === "failed" && (
            <div className="rounded-2xl p-3 text-sm" style={{ background: "var(--color-sky-3)", boxShadow: "inset 0 0 0 1.5px rgba(209,85,46,0.2)" }}>
              <span className="font-bold">The gift did not go through.</span>
              <span style={{ color: "var(--color-ink-soft)" }}> {number} is still yours. </span>
              {safeUrl(giftTxUrl) && (
                <a href={safeUrl(giftTxUrl)} target="_blank" rel="noreferrer" className="text-xs font-bold" style={{ color: "var(--color-teal-deep)" }}>
                  See the attempt
                </a>
              )}
              <div className="mt-2 grid grid-cols-2 gap-2">
                <button type="button" className="btn btn-cub" style={{ minHeight: 42, fontSize: "0.85rem" }} onClick={() => setGiftStep("confirm")}>
                  Try again
                </button>
                <button type="button" className="btn btn-ghost" style={{ minHeight: 42, fontSize: "0.85rem" }} onClick={() => setGiftStep("idle")}>
                  Keep it
                </button>
              </div>
            </div>
          )}
          <p className="sr-only" aria-live="polite" role="status">
            {giftError || (giftStep === "signing" ? "Sending the gift" : giftStep === "waiting" ? "Waiting for the transfer to land" : "")}
          </p>
          {giftError && (
            <p className="mt-2 text-xs" style={{ color: "var(--color-salmon-text)" }}>
              {giftError}
            </p>
          )}
        </div>
      )}

      {/* player rewards: a pet's share of the care pool, claimed gaslessly into
          its own account. Self-contained and degrades to a warming note when the
          distributor is not live yet. */}
      <RewardsPanel pet={{ tokenId: live.tokenId, serial: pet.serial }} session={session} />

      <FundFlow
        open={fundOpen}
        onClose={() => setFundOpen(false)}
        pet={{
          serial: pet.serial,
          number: live.number,
          tokenId: live.tokenId,
          tbaAddress: live.tbaAddress,
        }}
      />
    </div>
  );
}

function MiniMeter({
  label,
  glyph,
  value,
  color,
  secondsLeft,
}: {
  label: string;
  glyph?: string;
  value?: number;
  color: string;
  secondsLeft?: number;
}) {
  const v = Math.max(0, Math.min(100, typeof value === "number" ? value : 0));
  // A lapsed clock formats to "", so fall back to the percent rather than
  // showing a blank where a countdown should be.
  const left = typeof secondsLeft === "number" ? formatDuration(secondsLeft) : "";
  return (
    <div>
      <div className="mb-0.5 flex items-center justify-between">
        <span className="lcd" style={{ fontSize: "0.62rem", color: "var(--color-ink-muted)" }}>
          {glyph ? <span aria-hidden>{glyph} </span> : null}
          {label}
        </span>
        <span className="mono" style={{ color: "var(--color-ink-soft)", fontSize: "0.72rem" }}>
          {left || `${v}%`}
        </span>
      </div>
      <div className="meter-mini" style={{ height: 8 }}>
        <i style={{ width: `${v}%`, background: color }} />
      </div>
    </div>
  );
}
