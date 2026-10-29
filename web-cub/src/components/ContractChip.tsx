"use client";

import { useEffect, useRef, useState } from "react";
import { BRAND, PET721_CONFIGURED } from "@/lib/brand";

function shortAddr(a: string): string {
  return `${a.slice(0, 6)}...${a.slice(-4)}`;
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

/**
 * Footer trust chip: the pet contract, truncated + copyable, with an explorer
 * out-link. Styled as an LCD label so it reads as chrome, not content.
 */
export function ContractChip() {
  const [copied, setCopied] = useState(false);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(
    () => () => {
      if (timerRef.current) clearTimeout(timerRef.current);
    },
    [],
  );

  const doCopy = async () => {
    const ok = await copyText(BRAND.contract);
    if (ok) {
      setCopied(true);
      if (timerRef.current) clearTimeout(timerRef.current);
      timerRef.current = setTimeout(() => setCopied(false), 1800);
    }
  };

  // Never show a plausible-looking wrong address. With no configured collection
  // the chip says so plainly instead of handing out something copyable.
  if (!PET721_CONFIGURED) {
    return (
      <span className="lcd" style={{ fontSize: "0.7rem", color: "var(--color-ink-muted)" }}>
        Contract: not configured
      </span>
    );
  }

  return (
    <span className="inline-flex items-center gap-1.5">
      <span className="lcd" style={{ fontSize: "0.7rem", color: "var(--color-ink-muted)" }}>
        Contract
      </span>
      <button
        className="mono"
        onClick={doCopy}
        title={BRAND.contract}
        aria-label={copied ? "Contract address copied" : `Copy contract address ${BRAND.contract}`}
        aria-live="polite"
        style={{ fontSize: "0.72rem", fontWeight: 700, color: "var(--color-ink-soft)", cursor: "pointer" }}
      >
        {copied ? "Copied ✓" : shortAddr(BRAND.contract)}
      </button>
    </span>
  );
}
