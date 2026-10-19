"use client";

import { useCallback, useEffect, useState } from "react";
import { detectBrowserContext, type BrowserContext } from "@/lib/browser-context";

/**
 * ONE LINE for keepers stuck inside an in-app browser (X, Instagram, Facebook, TikTok...).
 * Those browsers download a .pkpass as a file and never show the Apple Wallet sheet, so the
 * Add to Apple Wallet button looks broken. A holder's first three card downloads came from
 * the X app and could not be added; she succeeded in Safari. Renders nothing in a real browser.
 *
 * Copy link copies the pass link for this phone when the caller has one (pasting it into
 * Safari or Chrome opens the pass sheet straight away, same as the mint success screen does),
 * otherwise the page URL.
 */
export function OpenInSafariHint({
  appleUrl,
  googleUrl,
  className = "",
}: {
  appleUrl?: string;
  googleUrl?: string;
  className?: string;
}) {
  // Decided on the client only (never during SSR) so the markup hydrates clean.
  const [ctx, setCtx] = useState<BrowserContext | null>(null);
  useEffect(() => {
    setCtx(detectBrowserContext(typeof navigator === "undefined" ? "" : navigator.userAgent));
  }, []);
  const [copied, setCopied] = useState(false);

  const browser = ctx?.platform === "ios" ? "Safari" : ctx?.platform === "android" ? "Chrome" : "your browser";

  const copyLink = useCallback(async () => {
    const pass = ctx?.platform === "android" ? (googleUrl ?? appleUrl) : (appleUrl ?? googleUrl);
    const link = pass || window.location.href;
    try {
      await navigator.clipboard.writeText(link);
      setCopied(true);
      setTimeout(() => setCopied(false), 2500);
    } catch {
      // Clipboard API blocked (some embedded browsers): the prompt is selectable text.
      window.prompt(`Copy this link, then paste it into ${browser}:`, link);
    }
  }, [ctx, appleUrl, googleUrl, browser]);

  if (!ctx?.inApp) return null;

  return (
    <div
      className={`flex flex-wrap items-center justify-between gap-2 rounded-2xl p-3 text-left text-sm ${className}`}
      style={{ background: "rgba(255,138,99,0.14)", color: "var(--color-ink)" }}
      role="status"
    >
      <span className="font-bold">To add your card, open this page in {browser}.</span>
      <button
        type="button"
        className="btn btn-ghost"
        style={{ minHeight: 36, padding: "0.35rem 0.8rem", fontSize: "0.8rem" }}
        onClick={copyLink}
      >
        {copied ? "Copied" : "Copy link"}
      </button>
    </div>
  );
}
