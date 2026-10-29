"use client";

import { useCallback, useEffect, useState } from "react";
import { fetchOwnerPassLink, type OwnedPet } from "@/lib/api";
import { safeUrl } from "@/lib/safe-url";
import { OpenInSafariHint } from "./OpenInSafariHint";
import type { PrivySessionInfo } from "./PrivyGate";

/**
 * THE WALLET BANNER (Hunt, 2026-10-22). 476 Chis died in one day; most of them were never in any
 * wallet, so no reminder ever reached a phone and the games, the art and the one-flip care were
 * never seen. A keeper who signs in here with a living pet that the server says is in NO wallet
 * (pet.wallet.apple false and pet.wallet.google false) gets this, loud, above the list, with the
 * real Add buttons for every such pet. "It is already in my wallet" hides it on this browser
 * (Google saves are reported by an unverified callback and can be missed, so the keeper has the
 * last word). Pets the server does not describe (older API) get nothing: never nag on a guess.
 */
export function needsWalletBanner(p: OwnedPet): boolean {
  if (!p.wallet) return false;
  if ((p.status || "alive").toLowerCase() === "dead") return false;
  return !p.wallet.apple && !p.wallet.google;
}

const DISMISS_KEY = "wchi_wallet_banner_dismissed";

function readDismissed(): Set<string> {
  try {
    const raw = window.localStorage.getItem(DISMISS_KEY);
    return new Set(raw ? (JSON.parse(raw) as string[]) : []);
  } catch {
    return new Set();
  }
}

export function WalletBanner({ pets, session }: { pets: OwnedPet[]; session: PrivySessionInfo }) {
  // Starts hidden so the server and the first client render agree; the stored dismissals decide.
  const [dismissed, setDismissed] = useState<Set<string> | null>(null);
  useEffect(() => {
    setDismissed(readDismissed());
  }, []);
  const dismiss = useCallback(() => {
    const next = new Set(dismissed ?? []);
    for (const p of pets) next.add(p.serial ?? p.tokenId ?? "");
    setDismissed(next);
    try {
      window.localStorage.setItem(DISMISS_KEY, JSON.stringify([...next]));
    } catch {
      // private mode: the banner simply returns next visit
    }
  }, [dismissed, pets]);

  if (!dismissed) return null;
  const shown = pets.filter((p) => !dismissed.has(p.serial ?? p.tokenId ?? ""));
  if (shown.length === 0) return null;

  return (
    <section className="wallet-banner mt-6" role="region" aria-label="Add your Chi to your wallet">
      <div className="wallet-banner-grid" aria-hidden />
      <div className="relative">
        <div className="eyebrow" style={{ color: "#ffd9c9" }}>
          {shown.length === 1 ? "Your Chi is not in a wallet yet" : "Your Chis are not in a wallet yet"}
        </div>
        <h2 className="display wallet-banner-title">
          Add it to your Apple or Google Wallet
          <span className="wallet-banner-accent"> or you are missing the whole experience.</span>
        </h2>
        <p className="wallet-banner-body">
          The card is the game. Reminders when a need runs low, five taps on the back of the card,
          the games, the art, the rewards. None of it reaches a phone without the card. Add it now,
          it takes ten seconds.
        </p>
        <ul className="wallet-banner-list">
          <li>
            <b>Reminders.</b> Your lock screen pings you at 8 hours and 2 hours left.
          </li>
          <li>
            <b>One-flip care.</b> Flip the card, tap Feed. No website, no sign-in.
          </li>
          <li>
            <b>Games and art.</b> CHI SHOT, CHI NIGHT, the photo album and new tricks land on the card.
          </li>
        </ul>
        <div className="mt-5 grid gap-4">
          {shown.map((p) => (
            <BannerPet key={p.serial ?? p.tokenId} pet={p} session={session} />
          ))}
        </div>
        <button type="button" className="wallet-banner-dismiss" onClick={dismiss}>
          It is already in my wallet
        </button>
      </div>
    </section>
  );
}

function BannerPet({ pet, session }: { pet: OwnedPet; session: PrivySessionInfo }) {
  const [links, setLinks] = useState<{ applePassUrl?: string; googleSaveUrl?: string } | null>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const number = pet.number || (pet.tokenId ? `No. ${pet.tokenId}` : "Your Chi");

  const load = useCallback(async () => {
    if (!pet.tokenId || busy) return;
    setBusy(true);
    setError("");
    try {
      const token = await session.getAccessToken();
      const got = await fetchOwnerPassLink({ tokenId: pet.tokenId, ...(token ? { privyToken: token } : {}) });
      if (got && (got.applePassUrl || got.googleSaveUrl)) setLinks(got);
      else setError("The den did not hand back a pass link. Tap again in a moment.");
    } catch {
      setError("We could not fetch your pass link. Tap again in a moment.");
    } finally {
      setBusy(false);
    }
  }, [pet.tokenId, busy, session]);

  // The real buttons, ready before the keeper scrolls: one owner-proof fetch per pet.
  useEffect(() => {
    void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pet.tokenId]);

  return (
    <div className="wallet-banner-pet">
      <div className="wallet-banner-pet-name">
        {number}
        {pet.hatched === false && <span className="wallet-banner-egg"> still an egg: add it, then tap Feed to hatch it</span>}
      </div>
      {links ? (
        <div className="mt-3 flex flex-wrap gap-3">
          {/* same tab on purpose: Safari shows the Add sheet over this page */}
          {safeUrl(links.applePassUrl) && (
            <a href={safeUrl(links.applePassUrl)} className="btn btn-apple wallet-banner-btn">
              Add to Apple Wallet
            </a>
          )}
          {links.googleSaveUrl && (
            <a href={safeUrl(links.googleSaveUrl)} target="_blank" rel="noreferrer" className="btn btn-google wallet-banner-btn">
              Save to Google Wallet
            </a>
          )}
        </div>
      ) : (
        <button type="button" className="btn btn-cub wallet-banner-btn mt-3" disabled={busy} onClick={load}>
          {busy ? "Getting your card" : "Get my card"}
        </button>
      )}
      {error && (
        <p className="mt-2 text-sm" style={{ color: "#ffd9c9" }} role="alert">
          {error}
        </p>
      )}
      <OpenInSafariHint className="mt-3" appleUrl={links?.applePassUrl} googleUrl={links?.googleSaveUrl} />
    </div>
  );
}
