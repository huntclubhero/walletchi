import type { Metadata } from "next";
import { SiteNav, SiteFooter } from "@/components/SiteChrome";
import { ClaimFlow } from "@/components/ClaimFlow";
import { BRAND } from "@/lib/brand";

export const metadata: Metadata = {
  title: `Claim your pet | ${BRAND.name}`,
  description:
    "Got a WALLETCHI from someone? Prove you own it and add its living wallet pass to Apple or Google Wallet. Claiming rotates the pass, so the previous owner's card stops working.",
};

export default function ClaimPage() {
  return (
    <main className="relative" id="top">
      <SiteNav />

      <section className="mx-auto w-[min(1020px,90vw)] py-8 md:py-12">
        <div className="mx-auto max-w-[720px] text-center">
          <div data-reveal className="eyebrow" style={{ color: "var(--color-salmon-text)" }}>
            New owner
          </div>
          <h1
            data-reveal
            className="display mt-3"
            style={{ fontSize: "clamp(1.75rem, 6vw, 3.6rem)", transitionDelay: "0.05s" }}
          >
            Got a WALLETCHI from someone? Claim its wallet pass.
          </h1>
          <p
            data-reveal
            className="mx-auto mt-4 max-w-[560px] text-lg"
            style={{ color: "var(--color-ink-soft)", transitionDelay: "0.1s" }}
          >
            Prove the pet is yours and we hand you its living card for Apple or Google Wallet. Then
            feed it, water it, play, toy, and explore: five needs a day keep it alive, all from your
            phone.
          </p>
        </div>

        {/* Reassurance: claiming never harms the pet; dead pets are soulbound memorials. */}
        <div
          data-reveal
          className="soft-card mx-auto mt-8 max-w-[720px] p-5"
          style={{ transitionDelay: "0.12s" }}
        >
          <ul className="grid gap-3 text-sm sm:grid-cols-3">
            <Reassure emoji="💛" title="Nothing resets">
              Your pet keeps all its stats, care, and history. A transfer is not what kills a pet, but the
              five need clocks keep running right through the handover, so care for it as soon as it
              lands.
            </Reassure>
            <Reassure emoji="🔒" title="Only you control it">
              Verifying rotates the pass, so the previous owner&rsquo;s card can no longer feed or move
              your pet.
            </Reassure>
            <Reassure emoji="🌙" title="Memorials stay put">
              A pet that has passed is a soulbound keepsake: viewable forever, but it cannot be claimed
              for transfer.
            </Reassure>
          </ul>
        </div>

        <div className="mx-auto mt-8 max-w-[860px]">
          <ClaimFlow />
        </div>

        <p
          className="mx-auto mt-8 max-w-[560px] text-center text-sm"
          style={{ color: "var(--color-ink-muted)" }}
        >
          Not sure a pet is healthy? Its live page is the source of truth (marketplace listings can
          show stale info). Open{" "}
          <span className="mono" style={{ color: "var(--color-teal-deep)" }}>
            playwalletchi.com/pet/&lt;id&gt;
          </span>{" "}
          before you take one.
        </p>
      </section>

      <SiteFooter />
    </main>
  );
}

function Reassure({
  emoji,
  title,
  children,
}: {
  emoji: string;
  title: string;
  children: React.ReactNode;
}) {
  return (
    <li className="flex gap-3 sm:flex-col sm:gap-2">
      <span className="text-2xl" aria-hidden>
        {emoji}
      </span>
      <span>
        <span className="block font-bold" style={{ color: "var(--color-ink)" }}>
          {title}
        </span>
        <span className="mt-1 block" style={{ color: "var(--color-ink-soft)" }}>
          {children}
        </span>
      </span>
    </li>
  );
}
