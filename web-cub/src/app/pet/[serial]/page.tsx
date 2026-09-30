import type { Metadata } from "next";
import { SiteNav, SiteFooter } from "@/components/SiteChrome";
import { PetPortrait } from "@/components/PetPortrait";
import { FeedPetButton } from "@/components/FundFlow";
import { WithdrawRewards } from "@/components/WithdrawRewards";
import { getRunnerState, type RunnerSession } from "@/lib/api";
import { traitsFor } from "@/lib/traits";
import { BRAND, petImageUrl } from "@/lib/brand";
import { formatDuration } from "@/lib/format";
import { readNeeds } from "@/lib/needs";

type LiveStatus = "alive" | "critical" | "dead";

/** Derive the at-a-glance health status buyers rely on (server state is authoritative). */
function petStatus(state: RunnerSession): LiveStatus {
  if (state.gone === true || (state.status || "").toLowerCase() === "dead") return "dead";
  if (state.critical === true || (state.status || "").toLowerCase() === "critical") return "critical";
  return "alive";
}

const STATUS_COPY: Record<LiveStatus, { label: string; note: string }> = {
  alive: {
    label: "Alive",
    note: "Live from the chain, right now.",
  },
  critical: {
    label: "Critical",
    note: "This pet is hours from fading. Its most urgent need has to be served now, or it will not make it.",
  },
  dead: {
    label: "Soulbound memorial",
    note: "This pet has passed. It can be viewed forever but never transferred.",
  },
};

function StatusBanner({ state }: { state: RunnerSession }) {
  const status = petStatus(state);
  const copy = STATUS_COPY[status];
  const lifeLeft = status === "dead" ? "" : formatDuration(state.secondsLeft);
  return (
    <div data-reveal className={`status-banner status-${status}`} role="status">
      <span className="status-dot" aria-hidden />
      <span className="status-label">{copy.label}</span>
      {lifeLeft && <span className="status-life">{lifeLeft} of life left</span>}
      <span className="status-note">{copy.note}</span>
    </div>
  );
}

export async function generateMetadata({
  params,
}: {
  params: Promise<{ serial: string }>;
}): Promise<Metadata> {
  const { serial } = await params;
  const state = await getRunnerState(serial);
  const num = state?.runnerNumber || `No. ${serial.slice(0, 6)}`;
  const title = `WALLETCHI ${num}`;
  const img = petImageUrl(serial);
  const description = state?.gone
    ? `In memory of WALLETCHI ${num}. A one-of-a-kind pet that lived on-chain.`
    : `Meet WALLETCHI ${num}, a one-of-a-kind pet living in a wallet on ${BRAND.chainName}.`;
  return {
    title,
    description,
    openGraph: { title, description, images: [{ url: img, width: 800, height: 800 }] },
    twitter: { card: "summary_large_image", title, description, images: [img] },
  };
}

const MOODS: Record<string, { label: string; emoji: string }> = {
  egg: { label: "Warming up", emoji: "🥚" },
  happy: { label: "Happy", emoji: "😊" },
  hungry: { label: "Hungry", emoji: "🍯" },
  thirsty: { label: "Thirsty", emoji: "💧" },
  sad: { label: "Lonely", emoji: "🌧️" },
  lonely: { label: "Lonely", emoji: "🌧️" },
  sleeping: { label: "Sleeping", emoji: "😴" },
  sick: { label: "Under the weather", emoji: "🤒" },
  gone: { label: "At rest", emoji: "🌙" },
};

function short(a?: string | null): string {
  return a ? `${a.slice(0, 6)}...${a.slice(-4)}` : "";
}

export default async function PetPage({ params }: { params: Promise<{ serial: string }> }) {
  const { serial } = await params;
  const state = await getRunnerState(serial);

  return (
    <main className="relative" id="top">
      <SiteNav />
      {!state || !state.serial ? (
        <NotFound serial={serial} />
      ) : state.gone ? (
        <Memorial serial={serial} state={state} />
      ) : (
        <Alive serial={serial} state={state} />
      )}
      <SiteFooter />
    </main>
  );
}

/* --------------------------------------------------------------------- alive */

function Alive({ serial, state }: { serial: string; state: RunnerSession }) {
  const num = state.runnerNumber || `No. ${serial.slice(0, 6)}`;
  const traits = state.tokenId ? traitsFor(state.tokenId) : [];
  const rarity = traits.find((t) => t.trait === "Rarity")?.value || "Common";
  const mood = MOODS[state.mood || ""] || { label: "Doing great", emoji: "🐾" };
  const hatched = state.hatched === true;

  return (
    <section className="mx-auto w-[min(1120px,90vw)] py-8 md:py-14">
      <StatusBanner state={state} />
      <div className="grid items-start gap-10 md:grid-cols-[0.9fr_1.1fr]">
      {/* portrait */}
      <div data-reveal className="flex flex-col items-center">
        <PetPortrait serial={serial} seed={state.tokenId ?? serial} width={400} className="w-full" />
        <div className="mt-4 flex flex-wrap justify-center gap-2">
          <span className="pill">
            {mood.emoji} {mood.label}
          </span>
          <span className="pill">{hatched ? "Hatched" : "Still an egg"}</span>
          <RarityPill rarity={rarity} />
        </div>
      </div>

      {/* details */}
      <div>
        <div data-reveal className="eyebrow" style={{ color: "var(--color-lav-deep)" }}>
          {BRAND.name} pet
        </div>
        <h1 data-reveal className="display mt-2" style={{ fontSize: "clamp(1.85rem, 6vw, 4rem)", transitionDelay: "0.05s" }}>
          {num}
        </h1>
        <p data-reveal className="mt-2 text-lg" style={{ color: "var(--color-ink-soft)", transitionDelay: "0.1s" }}>
          {state.lastEvent ? `"${state.lastEvent}"` : "A one-of-a-kind pet, living on-chain."}
        </p>

        {/* ALL FIVE needs, most urgent first, the same order and glyphs as the
            wallet card. Three bars used to stand in for five needs (play, toy
            and explore shared one "Joy"), which hid the clock most likely to
            kill the pet. */}
        <div data-reveal className="mt-7 grid gap-3" style={{ maxWidth: 460, transitionDelay: "0.12s" }}>
          {readNeeds(state.needs, state).map((n) => (
            <Meter
              key={n.action}
              label={n.label}
              glyph={n.glyph}
              value={n.pct}
              color={n.color}
              {...(typeof n.secondsLeft === "number" ? { secondsLeft: n.secondsLeft } : {})}
            />
          ))}
        </div>

        {/* traits */}
        <div data-reveal className="mt-8" style={{ transitionDelay: "0.15s" }}>
          <div className="lcd mb-3" style={{ fontSize: "0.72rem", color: "var(--color-teal-deep)" }}>
            Traits
          </div>
          <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
            {traits.map((t) => (
              <div key={t.trait} className="trait-chip">
                <div className="lcd" style={{ fontSize: "0.6rem", color: "var(--color-ink-muted)" }}>
                  {t.trait}
                </div>
                <div className="mt-0.5 text-sm font-bold" style={{ color: "var(--color-ink)" }}>
                  {t.value}
                </div>
              </div>
            ))}
          </div>
        </div>

        {/* on-chain */}
        <div data-reveal className="soft-card mt-8 p-5" style={{ transitionDelay: "0.18s" }}>
          <div className="lcd mb-3" style={{ fontSize: "0.72rem", color: "var(--color-lav-deep)" }}>
            On-chain
          </div>
          <dl className="grid gap-2 text-sm">
            <OnchainRow label="Token ID" value={state.tokenId ? `#${state.tokenId}` : "pending"} />
            <OnchainRow label="Pet account" value={short(state.tbaAddress ?? state.tba)} href={state.links?.account ?? undefined} />
            <OnchainRow label="Owner" value={short(state.ownerAddress ?? state.owner)} />
            {state.links?.issueTx && <OnchainRow label="Mint" value="View transaction" href={state.links.issueTx} />}
          </dl>
        </div>

        <div data-reveal className="mt-7 flex flex-wrap gap-3" style={{ transitionDelay: "0.2s" }}>
          <FeedPetButton
            pet={{
              serial,
              number: num,
              tokenId: state.tokenId,
              tbaAddress: state.tbaAddress ?? state.tba,
            }}
          />
          <a href="/#adopt" className="btn btn-teal">
            Get your own pet
          </a>
          <a href="/how-to" className="btn btn-ghost">
            How it works
          </a>
        </div>

        {(state.tbaAddress ?? state.tba) && (state.ownerAddress ?? state.owner) && (
          <WithdrawRewards
            tba={(state.tbaAddress ?? state.tba) as string}
            ownerAddress={(state.ownerAddress ?? state.owner) as string}
          />
        )}
      </div>
      </div>
    </section>
  );
}

/* ------------------------------------------------------------------ memorial */

function Memorial({ serial, state }: { serial: string; state: RunnerSession }) {
  const num = state.runnerNumber || `No. ${serial.slice(0, 6)}`;
  const traits = state.tokenId ? traitsFor(state.tokenId) : [];

  return (
    <section className="scene-dark">
      <div className="relative mx-auto w-[min(1120px,90vw)] pt-10">
        <StatusBanner state={state} />
      </div>
      <div className="relative mx-auto grid w-[min(1120px,90vw)] items-center gap-10 pb-14 md:grid-cols-[0.9fr_1.1fr] md:pb-20">
        <div data-reveal className="flex flex-col items-center">
          <PetPortrait serial={serial} seed={state.tokenId ?? serial} width={400} className="w-full" />
          <div className="lcd mt-4" style={{ color: "#bcd0cf", letterSpacing: "0.14em" }}>
            🌙 At rest
          </div>
        </div>
        <div>
          <div data-reveal className="eyebrow">In memory of</div>
          <h1 data-reveal className="display mt-2" style={{ fontSize: "clamp(1.85rem, 6vw, 4rem)", transitionDelay: "0.05s" }}>
            {num}
          </h1>
          <p data-reveal className="mt-3 max-w-md text-lg" style={{ color: "rgba(231,239,238,0.85)", transitionDelay: "0.1s" }}>
            This little one has wandered off for good. Its card stays in the wallet forever, a keepsake
            of one of the {BRAND.supply.toLocaleString("en-US")}. Gone, but not forgotten.
          </p>

          <div data-reveal className="mt-7 flex flex-wrap gap-2" style={{ transitionDelay: "0.14s" }}>
            {traits.map((t) => (
              <span key={t.trait} className="rounded-full px-3 py-1 text-xs" style={{ background: "rgba(255,255,255,0.08)", border: "1px solid rgba(255,255,255,0.14)" }}>
                {t.trait}: {t.value}
              </span>
            ))}
          </div>

          <div data-reveal className="mt-8 flex flex-wrap gap-3" style={{ transitionDelay: "0.18s" }}>
            {state.links?.account && (
              <a href={state.links.account} target="_blank" rel="noreferrer" className="btn btn-teal">
                See it on the explorer <span aria-hidden>↗</span>
              </a>
            )}
            <a href="/#adopt" className="btn btn-cub">
              Adopt a new pet
            </a>
          </div>

          {(state.tbaAddress ?? state.tba) && (state.ownerAddress ?? state.owner) && (
            <WithdrawRewards
              tba={(state.tbaAddress ?? state.tba) as string}
              ownerAddress={(state.ownerAddress ?? state.owner) as string}
            />
          )}
        </div>
      </div>
    </section>
  );
}

/* -------------------------------------------------------------------- not found */

function NotFound({ serial }: { serial: string }) {
  return (
    <section className="mx-auto w-[min(680px,90vw)] py-20 text-center">
      <div className="mx-auto mb-5 grid h-20 w-20 place-items-center rounded-full" style={{ background: "var(--color-lav-soft)", fontSize: 34 }}>
        🐾
      </div>
      <h1 className="display" style={{ fontSize: "clamp(1.6rem, 5vw, 3rem)" }}>
        No pet here yet.
      </h1>
      <p className="mx-auto mt-3 max-w-md text-lg" style={{ color: "var(--color-ink-soft)" }}>
        We could not find a pet at{" "}
        <span className="lcd" style={{ fontSize: "0.85em", color: "var(--color-ink-muted)" }}>
          {serial.slice(0, 12)}
        </span>
        . It may not have hatched yet, or the den is warming up.
      </p>
      <a href="/#adopt" className="btn btn-cub mt-7">
        Get your own pet
      </a>
    </section>
  );
}

/* ---------------------------------------------------------------------- bits */

function Meter({
  label,
  glyph,
  value,
  color,
  secondsLeft,
}: {
  label: string;
  glyph?: string;
  value?: number;
  color: string;
  secondsLeft?: number;
}) {
  const v = Math.max(0, Math.min(100, typeof value === "number" ? value : 0));
  // A lapsed clock formats to "", so fall back to the percent instead of a blank.
  const left = typeof secondsLeft === "number" ? formatDuration(secondsLeft) : "";
  return (
    <div>
      <div className="mb-1 flex items-center justify-between text-sm">
        <span className="lcd" style={{ fontSize: "0.68rem", color: "var(--color-ink-muted)" }}>
          {glyph ? <span aria-hidden>{glyph} </span> : null}
          {label}
        </span>
        <span className="mono" style={{ color: "var(--color-ink-soft)", fontSize: "0.8rem" }}>
          {left || `${v}%`}
        </span>
      </div>
      <div className="meter-mini" style={{ height: 10 }}>
        <i style={{ width: `${v}%`, background: color }} />
      </div>
    </div>
  );
}

function TraitRarityColor(rarity: string): string {
  if (rarity === "Grail") return "#c79f52";
  if (rarity === "Rare") return "#a48fd6";
  if (rarity === "Uncommon") return "#33a7b5";
  return "#74898b";
}

function RarityPill({ rarity }: { rarity: string }) {
  const color = TraitRarityColor(rarity);
  return (
    <span className="pill" style={{ color, boxShadow: `0 0 0 1.5px ${color}44 inset` }}>
      {rarity === "Grail" ? "👑 " : ""}
      {rarity}
    </span>
  );
}

function OnchainRow({ label, value, href }: { label: string; value: string; href?: string }) {
  return (
    <div className="flex items-center justify-between gap-3">
      <dt style={{ color: "var(--color-ink-muted)" }}>{label}</dt>
      <dd className="mono" style={{ color: "var(--color-ink)" }}>
        {href ? (
          <a href={href} target="_blank" rel="noreferrer" style={{ color: "var(--color-teal-deep)", fontWeight: 700 }}>
            {value} <span aria-hidden>↗</span>
          </a>
        ) : (
          value
        )}
      </dd>
    </div>
  );
}
