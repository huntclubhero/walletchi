"use client";

import { useEffect, useRef } from "react";
import { PrivyGate, type PrivySessionInfo } from "./PrivyGate";
import { SELF_CUSTODY_ENABLED } from "@/lib/privy";
import { getPetsByOwner } from "@/lib/api";

/**
 * The sign-in entry in the site chrome. Hidden entirely when Privy is not
 * configured; otherwise "My pets" once signed in. The un-signed-in "Sign in"
 * prompt only appears once the self-custody mint is live: during the custodial
 * phase a visitor has nothing to sign in FOR (the mint is email-only), so the
 * prompt would just read as an unexplained hoop. Plain anchor to match the nav.
 *
 * It also carries the SITE-WIDE SELF-HEAL, because it is the one component on every page.
 */
export function AccountNavLink() {
  return (
    <PrivyGate>
      {(s) => {
        if (!s.authenticated && !SELF_CUSTODY_ENABLED) return null;
        return (
          <>
            <SelfHeal session={s} />
            <a
              href="/me"
              className="flex items-center gap-1.5 whitespace-nowrap text-sm font-bold"
              style={{ color: "var(--color-ink-soft)" }}
            >
              <span aria-hidden>{s.authenticated ? "🐾" : "👤"}</span>
              {s.authenticated ? "My pets" : "Sign in"}
            </a>
          </>
        );
      }}
    </PrivyGate>
  );
}

/**
 * SELF-HEAL ON ANY SIGN-IN (2026-09-23, tester Pretzel's pet No. 2). A pet whose one-tap arming never
 * completed makes every pass tap open the website. Whatever page its owner next signs in on (home, the
 * pet page the receipt email links to, the mint page, /me), arm it: once per page load, only pets the
 * server says are NOT armed, and in sign-in mode, which never hatches (lib/arming.ts). Invisible when
 * it works; a failure is beaconed to the server, and /me and the care page offer a "Finish one-tap
 * setup" button. Renders nothing.
 */
function SelfHeal({ session }: { session: PrivySessionInfo }) {
  const ranFor = useRef<string | null>(null);
  const wallet = session.authenticated ? session.walletAddress : null;
  const signerReady = session.signerReady;
  useEffect(() => {
    // Wait for the embedded signer, and latch only once a real attempt is possible.
    if (!wallet || !signerReady || ranFor.current === wallet) return;
    ranFor.current = wallet;
    void (async () => {
      const pets = await getPetsByOwner(wallet).catch(() => null);
      for (const pet of pets ?? []) {
        if (!pet.tokenId || (pet.status ?? "").toLowerCase() === "dead") continue;
        // Sequential on purpose: a keeper with several pets signs one bootstrap, not several at once.
        await session.armOnSignIn(pet.tokenId).catch(() => false);
      }
    })();
  }, [wallet, signerReady, session]);
  return null;
}
