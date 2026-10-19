"use client";

import { useCallback, useEffect, useState } from "react";
import { createPortal } from "react-dom";
import { AddressQR } from "./AddressQR";

// Donations go to the creator's ENS name on Ethereum MAINNET. Resolved and reverse-checked
// 2026-10-14 (huntclubhero.eth -> this address -> huntclubhero.eth). This is real ETH and has
// nothing to do with the testnet game: it never touches a pet, CARE, or the Pot.
export const DONATE_ENS = "huntclubhero.eth";
export const DONATE_ADDRESS = "0x913105f2d2BFb8392F7845EF79E0C2C62f2755dF";

type Variant = "nav" | "button" | "link";

export function DonateButton({ variant = "button", label = "Donate" }: { variant?: Variant; label?: string }) {
  const [open, setOpen] = useState(false);
  const cls =
    variant === "nav"
      ? "whitespace-nowrap text-sm font-bold"
      : variant === "link"
        ? "font-bold"
        : "btn btn-ghost w-full";
  return (
    <>
      <button
        type="button"
        className={cls}
        style={variant === "nav" ? { color: "var(--color-ink-soft)" } : undefined}
        onClick={() => setOpen(true)}
      >
        {variant === "button" && <span aria-hidden>♥ </span>}
        {label}
      </button>
      {open && <DonatePanel onClose={() => setOpen(false)} />}
    </>
  );
}

function DonatePanel({ onClose }: { onClose: () => void }) {
  const [copied, setCopied] = useState(false);
  const [mounted, setMounted] = useState(false);
  useEffect(() => {
    setMounted(true);
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  const copy = useCallback(async () => {
    try {
      await navigator.clipboard.writeText(DONATE_ADDRESS);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      window.prompt("Copy this address:", DONATE_ADDRESS);
    }
  }, []);

  if (!mounted) return null;
  // Portalled to <body>: an ancestor with transform/will-change would otherwise trap position:fixed.
  return createPortal(
    <div
      role="dialog"
      aria-modal="true"
      aria-label="Donate to WALLETCHI"
      onClick={onClose}
      style={{
        position: "fixed", inset: 0, zIndex: 1000, display: "grid", placeItems: "center", padding: 16,
        background: "rgba(7,23,34,0.55)", backdropFilter: "blur(3px)",
      }}
    >
      <div className="soft-card p-6 text-center" style={{ maxWidth: 400, width: "100%", background: "#fffaf5", maxHeight: "calc(100vh - 32px)", overflowY: "auto" }} onClick={(e) => e.stopPropagation()}>
        <div className="eyebrow" style={{ color: "var(--color-teal-deep)" }}>Support the build</div>
        <h2 className="display mt-1" style={{ fontSize: "1.6rem" }}>Donate to {DONATE_ENS}</h2>
        <p className="mt-2 text-sm" style={{ color: "var(--color-ink-soft)" }}>
          Help keep WALLETCHI and ERC-8426 going. Send ETH on Ethereum mainnet to{" "}
          <strong style={{ color: "var(--color-ink)" }}>{DONATE_ENS}</strong>.
        </p>
        <div className="mx-auto mt-4" style={{ width: 160 }}>
          <AddressQR value={DONATE_ADDRESS} size={160} />
        </div>
        <code
          className="mt-3 block break-all rounded-xl px-3 py-2 text-xs"
          style={{ background: "rgba(47,125,122,0.08)", color: "var(--color-ink)" }}
        >
          {DONATE_ADDRESS}
        </code>
        <div className="mt-4 flex flex-col gap-2">
          <button type="button" className="btn btn-cub w-full" onClick={copy}>
            {copied ? "Copied" : "Copy address"}
          </button>
          <a className="btn btn-ghost w-full" href={`ethereum:${DONATE_ADDRESS}@1`}>
            Open in my wallet
          </a>
          <a
            className="text-xs font-bold"
            style={{ color: "var(--color-teal-deep)" }}
            href={`https://etherscan.io/address/${DONATE_ADDRESS}`}
            target="_blank"
            rel="noreferrer"
          >
            Check it on Etherscan ↗
          </a>
        </div>
        <p className="mt-4 text-xs" style={{ color: "var(--color-ink-muted)" }}>
          This is real ETH on mainnet, separate from the testnet game. It doesn&apos;t change your pet or
          its CARE. Thank you.
        </p>
        <button type="button" className="mt-3 text-xs font-bold" style={{ color: "var(--color-ink-muted)" }} onClick={onClose}>
          Close
        </button>
      </div>
    </div>,
    document.body,
  );
}
