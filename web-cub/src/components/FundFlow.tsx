"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { PetPortrait } from "./PetPortrait";
import { AddressQR } from "./AddressQR";
import { getRunnerState } from "@/lib/api";
import { CARE_TOKEN_READY, uniswapSwapUrl, BRAND, SEASON } from "@/lib/brand";

/**
 * The Fund flow: get CARE into a pet's OWN on-chain account (its ERC-6551
 * token-bound account, the tbaAddress). Care fees pull from that account
 * automatically, so once it is funded the owner never signs or pays gas.
 * The one step that needs the user is buying + sending the CARE itself.
 *
 * Opens as a modal for a specific pet. Reused from the mint-success screen
 * ("give your pet its first meal") and the public pet page ("feed this pet").
 */

export interface FundPet {
  serial?: string;
  /** Display number, e.g. "No. 0482". Falls back to a serial slice. */
  number?: string;
  tokenId?: string;
  tbaAddress?: string;
}

/** Clipboard write with a legacy fallback so Copy works everywhere. */
async function copyText(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    try {
      const ta = document.createElement("textarea");
      ta.value = text;
      ta.setAttribute("readonly", "");
      ta.style.position = "fixed";
      ta.style.opacity = "0";
      document.body.appendChild(ta);
      ta.select();
      const ok = document.execCommand("copy");
      document.body.removeChild(ta);
      return ok;
    } catch {
      return false;
    }
  }
}

export function FundFlow({
  open,
  onClose,
  pet,
}: {
  open: boolean;
  onClose: () => void;
  pet: FundPet;
}) {
  // The pet account address may lag the mint by a moment; keep a local copy we
  // can refresh from the live state endpoint without asking the caller to.
  const [tba, setTba] = useState(pet.tbaAddress || "");
  const [checking, setChecking] = useState(false);
  const closeRef = useRef<HTMLButtonElement>(null);
  const modalRef = useRef<HTMLDivElement>(null);

  const refetchTba = useCallback(async () => {
    if (!pet.serial) return;
    setChecking(true);
    const s = await getRunnerState(pet.serial);
    const found = s?.tbaAddress || s?.tba || "";
    if (found) setTba(found);
    setChecking(false);
  }, [pet.serial]);

  // Fetch the pet's account address if we lack it when the modal opens.
  useEffect(() => {
    if (!open) return;
    setTba(pet.tbaAddress || "");
    if (!pet.tbaAddress) refetchTba();
    closeRef.current?.focus();
  }, [open, pet.tbaAddress, refetchTba]);

  // Esc closes; Tab is trapped inside the dialog; the page behind stays put.
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        onClose();
        return;
      }
      if (e.key !== "Tab") return;
      const root = modalRef.current;
      if (!root) return;
      const focusables = Array.from(
        root.querySelectorAll<HTMLElement>(
          'a[href], button:not([disabled]), input:not([disabled]), select, textarea, [tabindex]:not([tabindex="-1"])',
        ),
      ).filter((el) => el.offsetParent !== null || el === document.activeElement);
      if (focusables.length === 0) return;
      const first = focusables[0];
      const last = focusables[focusables.length - 1];
      const active = document.activeElement as HTMLElement | null;
      if (!active || !root.contains(active)) {
        e.preventDefault();
        first.focus();
      } else if (e.shiftKey && active === first) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && active === last) {
        e.preventDefault();
        first.focus();
      }
    };
    window.addEventListener("keydown", onKey);
    document.body.style.overflow = "hidden";
    return () => {
      window.removeEventListener("keydown", onKey);
      document.body.style.overflow = "";
    };
  }, [open, onClose]);

  if (!open) return null;
  // The overlay is position:fixed and must cover the viewport. Portal it to
  // <body> so an ancestor transform / will-change (e.g. [data-reveal],
  // [data-parallax]) can never make it a containing block and trap/offset it.
  if (typeof document === "undefined") return null;

  const number = pet.number || (pet.serial ? `No. ${pet.serial.slice(0, 6)}` : "your pet");

  return createPortal(
    <div
      className="fund-overlay"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div ref={modalRef} className="fund-modal" role="dialog" aria-modal="true" aria-label={`Add CARE to pet ${number}`}>
        <button ref={closeRef} className="fund-close" onClick={onClose} aria-label="Close">
          ✕
        </button>

        {/* header: the pet this funding is for */}
        <div className="flex items-center gap-4">
          <PetPortrait serial={pet.serial} seed={pet.tokenId ?? pet.serial} width={72} />
          <div>
            <div className="eyebrow" style={{ color: "var(--color-salmon-text)" }}>
              Feed the tank
            </div>
            <div className="display" style={{ fontSize: "1.5rem" }}>
              {number}
            </div>
          </div>
        </div>

        <p className="mt-4 text-sm" style={{ color: "var(--color-ink-soft)" }}>
          CARE pays for all five needs: feed, water, play, toy and explore. It lives in your
          pet&apos;s own on-chain account (its 6551), and every care draws from it automatically.
          {CARE_TOKEN_READY
            ? " Buy CARE with crypto and send it over:"
            : ` Every pet starts with ${SEASON.starterCare} test CARE. It is not sold anywhere and has no value, but anyone can send some to this account:`}
        </p>
        <CryptoPath
          tba={tba}
          checking={checking}
          canRecheck={Boolean(pet.serial)}
          onRecheck={refetchTba}
          onBack={onClose}
        />
      </div>
    </div>,
    document.body,
  );
}

/* ....................................................... screen: crypto path */

// The real mechanic, stated plainly: every care action costs CARE and resets ONLY that
// need's own 24h clock. One feed does NOT buy a day: the pet dies when ANY of its five
// needs lapses, so a day of life means serving all five. No cooldown.
const AMOUNT_CHIPS = ["1 CARE = 1 care action", "All five needs = another day alive", "One care per need a day keeps it alive"];

function CryptoPath({
  tba,
  checking,
  canRecheck,
  onRecheck,
  onBack,
}: {
  tba: string;
  checking: boolean;
  /** Without a serial there is nothing to re-poll; the button stays disabled. */
  canRecheck: boolean;
  onRecheck: () => void;
  onBack: () => void;
}) {
  return (
    <div className="mt-5 grid gap-3">
      {/* step 1: get CARE */}
      <div className="fund-step">
        <div className="fund-step-head">
          <span className="fund-step-num" aria-hidden>
            1
          </span>
          <span className="display" style={{ fontSize: "1.05rem" }}>
            Get CARE
          </span>
        </div>
        {CARE_TOKEN_READY ? (
          <>
            <p className="mt-1.5 text-sm" style={{ color: "var(--color-ink-soft)" }}>
              Swap for CARE on {BRAND.chainName}. The link opens Uniswap with CARE preselected.
            </p>
            <a href={uniswapSwapUrl()} target="_blank" rel="noreferrer" className="btn btn-teal mt-3 w-full">
              Swap on Uniswap <span aria-hidden>↗</span>
            </a>
          </>
        ) : (
          <>
            <p className="mt-1.5 text-sm" style={{ color: "var(--color-ink-soft)" }}>
              This is the Testnet Experience, so CARE here is a test token: nothing sells it. Any
              keeper holding test CARE can send some to the address below.
            </p>
          </>
        )}
        <div className="mt-3 flex flex-wrap gap-2">
          {AMOUNT_CHIPS.map((c) => (
            <span key={c} className="fund-chip">
              {c}
            </span>
          ))}
        </div>
        <p className="mt-1.5 text-xs" style={{ color: "var(--color-ink-muted)" }}>
          Top up with any amount. Serve all five needs before a day passes on any one of them, or it is gone for good.
        </p>
      </div>

      {/* step 2: send it to the pet's own account */}
      <div className="fund-step">
        <div className="fund-step-head">
          <span className="fund-step-num" aria-hidden>
            2
          </span>
          <span className="display" style={{ fontSize: "1.05rem" }}>
            Send it to your pet
          </span>
        </div>
        {tba ? (
          <>
            <p className="mt-1.5 text-sm" style={{ color: "var(--color-ink-soft)" }}>
              This is your pet&apos;s own on-chain account. Scan it with a phone wallet, or copy it,
              and send your CARE here.
            </p>
            <div className="mt-3 flex justify-center">
              <AddressQR value={tba} />
            </div>
            <AddressCopy address={tba} />
          </>
        ) : (
          <>
            <p className="mt-1.5 text-sm" style={{ color: "var(--color-ink-soft)" }}>
              Your pet&apos;s account is being created. Check back in a moment.
            </p>
            <button className="btn btn-teal mt-3 w-full" onClick={onRecheck} disabled={checking || !canRecheck}>
              {checking ? (
                <>
                  <span className="spin" style={{ borderColor: "rgba(28,127,143,0.3)", borderTopColor: "var(--color-teal-deep)" }} />{" "}
                  Checking
                </>
              ) : (
                <>Check again</>
              )}
            </button>
          </>
        )}
      </div>

      <p className="text-center text-xs" style={{ color: "var(--color-ink-muted)" }}>
        Caring draws from your pet&apos;s account automatically. No signing, no gas for you.
      </p>
      <BackLink onBack={onBack} />
    </div>
  );
}

function AddressCopy({ address }: { address: string }) {
  const [copied, setCopied] = useState(false);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(
    () => () => {
      if (timerRef.current) clearTimeout(timerRef.current);
    },
    [],
  );
  const doCopy = async () => {
    const ok = await copyText(address);
    if (ok) {
      setCopied(true);
      if (timerRef.current) clearTimeout(timerRef.current);
      timerRef.current = setTimeout(() => setCopied(false), 1800);
    }
  };
  return (
    <div className="fund-addr mt-3">
      <span className="mono fund-addr-text" title={address}>
        {address}
      </span>
      <button className={`fund-copy${copied ? " is-copied" : ""}`} onClick={doCopy} aria-live="polite">
        {copied ? "Copied ✓" : "Copy"}
      </button>
    </div>
  );
}

function BackLink({ onBack }: { onBack: () => void }) {
  return (
    <button className="fund-back" onClick={onBack}>
      ← Back
    </button>
  );
}

/* ......................................... trigger button for server pages */

/**
 * Self-contained trigger: a button that owns the open state and renders the
 * FundFlow modal. Lets server components (the pet page) drop it in directly.
 */
export function FeedPetButton({
  pet,
  label = "Feed this pet",
  className = "btn btn-cub",
}: {
  pet: FundPet;
  label?: string;
  className?: string;
}) {
  const [open, setOpen] = useState(false);
  // No dead end: funding a pet means sending it CARE, and in the Testnet Experience CARE is a
  // test token with no market (every pet starts with 500). A button that can only lead to "nothing
  // sells this" is noise, so it is simply absent; care itself happens from the wallet card.
  if (!CARE_TOKEN_READY) return null;
  return (
    <>
      <button className={className} onClick={() => setOpen(true)}>
        <span aria-hidden>🍯</span> {label}
      </button>
      <FundFlow open={open} onClose={() => setOpen(false)} pet={pet} />
    </>
  );
}
