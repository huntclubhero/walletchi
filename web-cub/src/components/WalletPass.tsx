"use client";

import { PrivyGate } from "./PrivyGate";

/**
 * The wallet marks and the site-chrome wallet pills.
 *
 * The pass IS the product, so the two add-to-wallet buttons live in the chrome
 * and follow the visitor across every page instead of only showing up once, at
 * the end of the mint. They sit in normal flow under the nav: always in reach,
 * never floating over anything.
 *
 * The real pass URL is capability-scoped per pet (server/runner/pass.ts), so
 * these are ROUTES, not download links: a signed-in keeper goes to their pets,
 * where the live Apple/Google buttons are; anyone else goes to the mint. Same
 * glyphs and the same .btn-apple / .btn-google skin as the buttons at the end of
 * the mint and the claim, just at pill scale.
 */

const HREF_PETS = "/me";
const HREF_MINT = "/#adopt";

export function AppleGlyph({ size = 18 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="currentColor" aria-hidden>
      <path d="M16.365 1.43c0 1.14-.42 2.2-1.12 2.98-.77.84-2.02 1.5-3.05 1.42-.13-1.1.42-2.26 1.1-3 .77-.83 2.1-1.45 3.07-1.4zM20.7 17.2c-.55 1.27-.82 1.84-1.53 2.96-.99 1.57-2.4 3.52-4.14 3.53-1.55.02-1.95-1.02-4.05-1-2.1.01-2.54 1.02-4.09 1.01-1.74-.02-3.07-1.78-4.06-3.35C-.02 16.4-.38 11.9 1.06 9.5c1.02-1.7 2.63-2.7 4.14-2.7 1.54 0 2.5 1.02 3.77 1.02 1.23 0 1.98-1.02 3.76-1.02 1.35 0 2.78.73 3.8 2-3.34 1.83-2.8 6.6.17 8.4z" />
    </svg>
  );
}

export function GoogleGlyph({ size = 18 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" aria-hidden>
      <path fill="#4285F4" d="M23.5 12.3c0-.8-.1-1.6-.2-2.3H12v4.5h6.5a5.6 5.6 0 0 1-2.4 3.6v3h3.9c2.3-2.1 3.5-5.2 3.5-8.8z" />
      <path fill="#34A853" d="M12 24c3.2 0 6-1.1 8-2.9l-3.9-3c-1.1.7-2.5 1.2-4.1 1.2-3.1 0-5.8-2.1-6.7-5H1.3v3.1A12 12 0 0 0 12 24z" />
      <path fill="#FBBC05" d="M5.3 14.3a7.2 7.2 0 0 1 0-4.6V6.6H1.3a12 12 0 0 0 0 10.8l4-3.1z" />
      <path fill="#EA4335" d="M12 4.8c1.8 0 3.3.6 4.6 1.8l3.4-3.4A12 12 0 0 0 1.3 6.6l4 3.1c.9-2.9 3.6-5 6.7-5z" />
    </svg>
  );
}

function Pills({ href }: { href: string }) {
  return (
    <>
      <a href={href} className="btn btn-apple wallet-pill" aria-label="Add your pet to Apple Wallet">
        <AppleGlyph size={15} />
        <span>
          <span className="wallet-pill-verb">Add to </span>Apple Wallet
        </span>
      </a>
      <a href={href} className="btn btn-google wallet-pill" aria-label="Save your pet to Google Wallet">
        <GoogleGlyph size={15} />
        <span>
          <span className="wallet-pill-verb">Save to </span>Google Wallet
        </span>
      </a>
    </>
  );
}

export function WalletPassPills() {
  return (
    <div className="wallet-bar">
      <div className="wallet-bar-inner">
        {/* No Privy, no signed-in state to read: the pills still show, pointed at
            the mint, so the promise is never missing from a page. */}
        <PrivyGate fallback={<Pills href={HREF_MINT} />}>
          {(s) => <Pills href={s.authenticated ? HREF_PETS : HREF_MINT} />}
        </PrivyGate>
      </div>
    </div>
  );
}
