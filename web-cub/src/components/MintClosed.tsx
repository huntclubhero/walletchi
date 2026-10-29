import { PetSprite } from "./PetSprite";
import { DonateButton } from "./DonateButton";
import { BRAND } from "../lib/brand";

/** Shown in place of the mint form once the season sells out (stats soldOut) or MINT_OPEN is off. */
export function MintClosed({ compact = false }: { compact?: boolean }) {
  if (compact) {
    return (
      <div className="mt-6 max-w-md">
        <div
          className="display inline-block"
          style={{
            fontSize: "clamp(2.6rem, 9vw, 4.2rem)",
            lineHeight: 1,
            color: "#fff4ee",
            border: "6px solid #fff4ee",
            borderRadius: 14,
            padding: "6px 18px 10px",
            transform: "rotate(-4deg)",
            letterSpacing: "0.04em",
          }}
        >
          SOLD OUT
        </div>
        <p className="mt-5 text-lg" style={{ color: "#fff4ee", fontWeight: 800 }}>
          All {BRAND.supply.toLocaleString("en-US")} Chis found a home. If you got one, love it. It&apos;s rare.
        </p>
      </div>
    );
  }
  return (
    <div className="soft-card p-6 text-center sm:p-8" style={{ maxWidth: 460 }}>
      <div className="mx-auto" style={{ width: 64 }}>
        <PetSprite size={64} />
      </div>
      <div className="eyebrow mt-3" style={{ color: "var(--color-teal-deep)" }}>
        Season one
      </div>
      <h2
        className="display mx-auto mt-3 inline-block"
        style={{
          fontSize: "clamp(2.8rem, 10vw, 4rem)",
          lineHeight: 1,
          color: "var(--color-salmon-deep)",
          border: "6px solid currentColor",
          borderRadius: 14,
          padding: "6px 18px 10px",
          transform: "rotate(-4deg)",
          letterSpacing: "0.04em",
        }}
      >
        SOLD OUT
      </h2>
      <p className="mt-5 text-base" style={{ color: "var(--color-ink)", fontWeight: 800 }}>
        All {BRAND.supply.toLocaleString("en-US")} Chis found a home.
      </p>
      <p className="mt-2 text-sm" style={{ color: "var(--color-ink-soft)" }}>
        Thank you to everyone who hopped in, hatched a pet, and sent us feedback.
      </p>
      <p className="mt-3 text-sm" style={{ color: "var(--color-ink)", fontWeight: 800 }}>
        If you got a pet, love it. It&apos;s rare. Keep all five of its needs served from your wallet card.
      </p>
      <div className="mt-5 flex flex-col gap-3">
        <a href="/me" className="btn btn-cub w-full">
          Open my pets
        </a>
        <a href="/arena" className="btn btn-ghost w-full">
          Watch the Arena
        </a>
        <DonateButton label="Donate to keep it going" />
      </div>
    </div>
  );
}
