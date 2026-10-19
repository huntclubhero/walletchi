import { PetSprite } from "./PetSprite";
import { DonateButton } from "./DonateButton";

/** Shown in place of the mint form while MINT_OPEN is off. */
export function MintClosed({ compact = false }: { compact?: boolean }) {
  if (compact) {
    return (
      <p className="mt-6 max-w-md text-lg" style={{ color: "#fff4ee", fontWeight: 800 }}>
        Minting is closed. Thank you for playing. If you got a pet, love it. It&apos;s rare.
      </p>
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
      <h2 className="display mt-1" style={{ fontSize: "clamp(1.6rem, 4vw, 2.1rem)" }}>
        Minting is closed.
      </h2>
      <p className="mt-3 text-sm" style={{ color: "var(--color-ink-soft)" }}>
        Thank you to everyone who hopped in, hatched a pet, and sent us feedback. We ran through the
        infra we had for this round, and ERC-8426 keeps moving.
      </p>
      <p className="mt-3 text-sm" style={{ color: "var(--color-ink)", fontWeight: 800 }}>
        If you got a pet, love it. It&apos;s rare. Keep all five of its needs served from your wallet card.
      </p>
      <p className="mt-3 text-sm" style={{ color: "var(--color-ink-muted)" }}>
        We&apos;ll be back soon... maybe?
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
