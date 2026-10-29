import { config } from "../config.js";
import type { Runner } from "../store/types.js";

// USDG ON THE FACE (Hunt 2026-10-29: "show the usdg like the balance instead of care on the face of
// the card, as if its REAL ... the care can be the chip"), behind a per-card switch,
// USDG_FRONT_SERIALS. For a listed living card:
//   - the Apple header slot that shows CARE (key "carebal", KEPT so iOS sees a value change, not a
//     removed and re-added field) shows the pet account's USDG like real money: "USDG" / "$10,000".
//     Google's CARE BALANCE row reads USDG BALANCE the same way. A failed USDG read shows today's
//     CARE field exactly;
//   - the ALIVE header shows just the verified alive number ("141", not "141 / 1,000");
//   - the CARE balance moves INTO the art as a small chip (runner/pet.ts careChipSvg) on every image
//     surface: the Apple strip, the iOS 27 poster artwork and the Google hero. The chip's figure is
//     in the image cache keys and the Google art version, so the picture moves with the balance. A
//     failed CARE read draws no chip.
// Never: an unlisted card changes by a byte, the switch feeds passTemplateHash, or anything carries
// a changeMessage.

// Parsed once per distinct env value (the env does not change at runtime, but checks flip it).
let seenRaw: string | undefined;
let serials: ReadonlySet<string> = new Set();
function listed(): ReadonlySet<string> {
  const raw = config.USDG_FRONT_SERIALS;
  if (raw !== seenRaw) {
    seenRaw = raw;
    serials = new Set((raw ?? "").split(",").map((s) => s.trim()).filter((s) => s.length > 0));
  }
  return serials;
}

/** True when this card shows USDG on its face: listed, living (not gone, not the champion). */
export function usdgFrontEnabledFor(runner: Pick<Runner, "serial" | "gone" | "won">): boolean {
  if (runner.gone || runner.won) return false;
  // "all" (any case) is the rollout to every living card; otherwise the comma list of serials.
  if ((config.USDG_FRONT_SERIALS ?? "").trim().toLowerCase() === "all") return true;
  return listed().has(runner.serial);
}

/**
 * The face value, like money: "$10,000" (whole dollars, separators, floored), cents only under $100
 * ("$12.50"), and "$1.2M" from a million up so the header never truncates.
 */
export function usdgFaceText(raw: bigint, decimals = config.FEE_TOKEN_DECIMALS): string {
  const base = 10n ** BigInt(decimals);
  const whole = raw / base;
  if (whole >= 1_000_000n) {
    const tenths = whole / 100_000n; // floored to 0.1M
    return `$${tenths / 10n}${tenths % 10n === 0n ? "" : `.${tenths % 10n}`}M`;
  }
  if (whole >= 100n) return `$${whole.toLocaleString("en-US")}`;
  const cents = ((raw % base) * 100n) / base;
  return `$${whole.toString()}.${cents.toString().padStart(2, "0")}`;
}

/** The CARE chip's figure from the pass's CARE balance ("12,481 CARE" -> "12,481"); null draws none. */
export function careChipFigure(careBalance: string | null | undefined): string | undefined {
  if (!careBalance) return undefined;
  return careBalance.replace(/\s*CARE$/, "") || undefined;
}
