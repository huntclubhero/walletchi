import { PetSprite } from "@/components/PetSprite";
import { MintForm } from "@/components/MintForm";
import { SeasonStats } from "@/components/SeasonStats";
import { BRAND, NEED_CLOCK_LABEL, SEASON, REMINDERS, petPortraitByToken, MINT_OPEN, FORMS_ON } from "@/lib/brand";
import { PlatformCredentials } from "@/components/PlatformCredentials";
import { StandardBlock } from "@/components/StandardBlock";
import { MintDeadline } from "@/components/MintDeadline";
import { NEED_GLYPHS, NEED_LABELS } from "@/lib/needs";
import { SiteNav, SiteFooter } from "@/components/SiteChrome";
import { ShowcasePet } from "@/components/ShowcasePet";
import { MintClosed } from "@/components/MintClosed";
import { MintCta } from "@/components/MintCta";
import { MergedStamp } from "@/components/MergedStamp";

/* What the visitor is actually holding. Every line here has to stay true of the running build:
   the email wallet (Privy), the pass (pass.ts / google.ts), the care links (HMAC capability URLs,
   re-checked against a fresh ownerOf), the pushes (APNs + Google object updates) and the claim
   rotation (claim.ts). */
const TECH = [
  {
    k: "01",
    title: "No app. No seed phrase.",
    body: "Type an email, enter the code. That sets up a wallet only you control and mints your pet straight into it.",
  },
  {
    k: "02",
    title: "The token is the pass.",
    body: "Your ERC-721 and the card in Apple Wallet or Google Wallet are the same pet. Add it once and it lives there.",
  },
  {
    k: "03",
    title: "Live state on the card.",
    body: "Five need timers, its status, how long it survives, and its CARE balance, all read from the chain.",
  },
  {
    k: "04",
    title: "Tap the back to act on chain.",
    body: "Feed, water, play, toy, explore: each link on the back of the card sends a real care transaction. Gas is sponsored.",
  },
  {
    k: "05",
    title: "It pushes when the chain moves.",
    body: `Every mint, transfer and care emits a PassUpdate event from the contract, and the card updates itself. A reminder reaches your phone when your pet has ${REMINDERS.checkInHours} hours left, a last chance at ${REMINDERS.lastChanceHours}, each naming the taps that fix it. News from the colony shows on the card.`,
  },
  {
    k: "06",
    title: "Transfer it and the pass rotates.",
    body: "Gift it from your account page, or sell it anywhere. Every tap re-reads the owner on chain, so a card that changed hands stops acting at once, and the new owner claims a fresh pass. Leaked a link? Reset them from the same page.",
  },
];

// Real push copy from the server, not invented flavor: the two care reminders (reminders.ts:
// checkInLine at CHECKIN_HOURS left, lastChanceLine at LAST_CHANCE_HOURS left) and the winner line
// (deathwatch.ts). The idle flavor lines ("Hungry. It has opinions about this.") update the card
// quietly now and never banner, so they do not belong in a notification mock.
const NOTIFS = [
  { t: `${REMINDERS.checkInHours - REMINDERS.lastChanceHours}h`, body: `Your Chi dies in ${REMINDERS.checkInHours}h. Tap Water and Toy on the back of this card to keep it alive.`, rot: -2.5 },
  { t: "now", body: `Last chance: your Chi dies in ${REMINDERS.lastChanceHours}h. Tap Water on the back of this card now.`, rot: 2 },
  { t: "1d", body: "Your pet outlasted them all and claimed the Pot.", rot: -1.5 },
];

// The hero fact chips. While the mint is closed they say so, in the past tense: a closed mint that
// still reads "Free, one per email, 1,000 pets" invites a visitor to look for a button that is gone.
const FACTS_OPEN = ["Free", "One per email, one per phone", `${BRAND.supply.toLocaleString("en-US")} pets`, "Test CARE preloaded"];
const FACTS_CLOSED = ["Sold out", "Was free, one per email, one per phone", "Test CARE preloaded"];

export default function Home() {
  return (
    <main className="relative" id="top">
      <SiteNav />

      {/* ------------------------------------------------------------------ HERO */}
      {/* Full-bleed split: the pitch and the mint on cream, the card itself on river ink. */}
      <section className="tx-split">
        <div className="tx-split-copy">
          <div className="tx-split-copy-inner">
            <div data-reveal>
              <MergedStamp />
            </div>
            <div data-reveal className="eyebrow mt-6" style={{ color: "var(--color-salmon-text)" }}>
              {BRAND.name} · Testnet Experience
            </div>
            <h1 data-reveal className="display mt-4" style={{ fontSize: "clamp(2.3rem, 6.4vw + 0.4rem, 5.4rem)", lineHeight: 0.95, transitionDelay: "0.05s" }}>
              The NFT
              <br />
              <span style={{ color: "var(--color-salmon-text)" }}>is the pass.</span>
            </h1>
            <p data-reveal className="mt-5 max-w-lg text-lg" style={{ color: "var(--color-ink-soft)", transitionDelay: "0.1s" }}>
              A pixel pet that lives in Apple Wallet or Google Wallet. The token and the card are one
              thing: its state is live on the front, the back acts on chain, and your phone hears
              about it when anything changes. No app. No seed phrase. Just an email.
            </p>
            <ul data-reveal className="tx-facts mt-5" style={{ transitionDelay: "0.14s" }}>
              {(MINT_OPEN ? FACTS_OPEN : FACTS_CLOSED).map((f) => (
                <li key={f}>{f}</li>
              ))}
              {/* The vault's entryDeadline outlives the sellout: only show it while minting is open. */}
              {MINT_OPEN && <MintDeadline />}
            </ul>
            <div data-reveal id="adopt" className="mt-6" style={{ transitionDelay: "0.2s" }}>
              {MINT_OPEN ? <MintForm /> : <MintClosed />}
            </div>
            <div data-reveal className="mt-4" style={{ transitionDelay: "0.25s" }}>
              <a href="/how-to" className="lcd" style={{ fontSize: "0.8rem", color: "var(--color-lav-deep)", borderBottom: "2px dotted rgba(107,85,168,0.45)", paddingBottom: 2 }}>
                How the pass works, step by step →
              </a>
              <a href="/docs" className="lcd ml-5" style={{ fontSize: "0.8rem", color: "var(--color-lav-deep)", borderBottom: "2px dotted rgba(107,85,168,0.45)", paddingBottom: 2 }}>
                Docs →
              </a>
            </div>
          </div>
        </div>

        <div className="tx-split-stage" aria-hidden>
          <div className="tx-stage-grid" />
          <div className="tx-stage-inner">
            <div data-reveal className="relative w-full" style={{ maxWidth: 380 }}>
              <LivingPass />
              <div className="absolute" style={{ top: -14, left: -10 }}>
                <LcdChip label="STATE" value="LIVE" tone="good" />
              </div>
              <div className="absolute" style={{ bottom: -16, right: -8 }}>
                <LcdChip label="PUSH" value="ON CHAIN CHANGE" tone="warn" />
              </div>
            </div>
            <div className="tx-stage-caption lcd">front of the card · no app installed</div>
          </div>
        </div>
      </section>

      {/* ------------------------------------------------ PLATFORM CREDENTIALS */}
      {/* Straight under the hero: the claim "it lives in Apple and Google Wallet" is backed by
          the credentials themselves (masked), before any explainer. */}
      <PlatformCredentials />

      {/* ------------------------------------------------------ WHAT YOU HOLD */}
      <section className="tx-band tx-band-teal">
        <div className="mx-auto w-[min(1180px,92vw)]">
          <div className="max-w-2xl">
            <div data-reveal className="eyebrow" style={{ color: "var(--color-teal-deep)" }}>
              What you are holding
            </div>
            <h2 data-reveal className="display mt-3" style={{ fontSize: "clamp(1.8rem, 5vw, 3.6rem)", transitionDelay: "0.05s" }}>
              Six things a wallet pass
              <br />
              was never supposed to do.
            </h2>
          </div>
          <div className="tx-tiles mt-10">
            {TECH.map((t, i) => (
              <div key={t.k} data-reveal className="tx-tile" style={{ transitionDelay: `${(i % 3) * 0.06}s` }}>
                <div className="tx-tile-k lcd">{t.k}</div>
                <h3 className="display mt-3 text-xl">{t.title}</h3>
                <p className="mt-2 text-sm leading-relaxed" style={{ color: "var(--color-ink-soft)" }}>
                  {t.body}
                </p>
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* --------------------------------------------------- BOTH SIDES OF THE CARD */}
      <section className="tx-band tx-band-river">
        <div className="mx-auto w-[min(1180px,92vw)]">
          <div className="max-w-2xl">
            <div data-reveal className="eyebrow">One card, both sides</div>
            <h2 data-reveal className="display mt-3" style={{ fontSize: "clamp(1.8rem, 5vw, 3.6rem)", color: "#f4f8f7", transitionDelay: "0.05s" }}>
              The front reads the chain.
              <br />
              <span style={{ color: "#ffd9c9" }}>The back writes to it.</span>
            </h2>
          </div>

          <div className="mt-12 grid items-start gap-10 lg:grid-cols-3">
            <div data-reveal className="flex flex-col items-center gap-4">
              <LivingPass />
              <div className="lcd tx-side-label">Front: live state</div>
            </div>
            <div data-reveal className="flex flex-col items-center gap-4" style={{ transitionDelay: "0.08s" }}>
              <PassBack />
              <div className="lcd tx-side-label">Back: on-chain actions</div>
            </div>
            <div data-reveal className="flex flex-col gap-3" style={{ transitionDelay: "0.16s" }}>
              {NOTIFS.map((nn, i) => (
                <div key={i} className="notif" style={{ transform: `rotate(${nn.rot}deg)` }}>
                  <div className="notif-icon">
                    <PetSprite size={26} />
                  </div>
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center justify-between">
                      <span className="display text-sm" style={{ color: "var(--color-ink)" }}>
                        {BRAND.name}
                      </span>
                      <span className="lcd text-xs" style={{ color: "var(--color-ink-muted)" }}>
                        {nn.t}
                      </span>
                    </div>
                    <p className="text-sm" style={{ color: "var(--color-ink-soft)" }}>
                      {nn.body}
                    </p>
                  </div>
                </div>
              ))}
              <div className="lcd tx-side-label mt-2 self-center">Pushes: when the chain changes</div>
            </div>
          </div>
        </div>
      </section>

      {/* ------------------------------------------------------------ THE GAME */}
      <section className="tx-band">
        <div className="mx-auto w-[min(1180px,92vw)]">
          <div className="grid items-end gap-6 lg:grid-cols-[1.1fr_0.9fr]">
            <div>
              <div data-reveal className="eyebrow" style={{ color: "var(--color-salmon-text)" }}>
                The game on the card
              </div>
              <h2 data-reveal className="display mt-3" style={{ fontSize: "clamp(1.8rem, 5vw, 3.6rem)", transitionDelay: "0.05s" }}>
                Five needs. Five clocks.
                <br />
                One life.
              </h2>
            </div>
            <p data-reveal className="text-lg" style={{ color: "var(--color-ink-soft)", transitionDelay: "0.1s" }}>
              The pet gives the pass a reason to change. It hatches the moment it is minted, and every
              need runs its own {NEED_CLOCK_LABEL} clock from there. Let any one lapse and it dies on chain, for
              good. The last pet alive takes the Pot and can never die.
            </p>
          </div>

          <div data-reveal className="tx-needs mt-10" style={{ transitionDelay: "0.12s" }}>
            {NEED_GLYPHS.map((g, i) => (
              <div key={g} className="tx-need">
                <span className="tx-need-glyph" aria-hidden>{g}</span>
                <span className="display text-lg">{NEED_LABELS[i]}</span>
                <span className="lcd" style={{ fontSize: "0.66rem", color: "var(--color-ink-muted)" }}>{SEASON.needClockHours}h clock</span>
              </div>
            ))}
          </div>

          <div className="mt-12 grid gap-10 lg:grid-cols-2">
            <div data-reveal>
              <div className="lcd mb-4" style={{ fontSize: "0.72rem", color: "var(--color-lav-deep)" }}>
                {BRAND.supply.toLocaleString("en-US")} pets · no two alike
              </div>
              <PetShowcase />
            </div>
            <div data-reveal style={{ transitionDelay: "0.08s" }}>
              <div className="lcd mb-4" style={{ fontSize: "0.72rem", color: "var(--color-teal-deep)" }}>
                care for it and it grows up
              </div>
              <EvolutionRow />
            </div>
          </div>
        </div>
      </section>

      {/* ---------------------------------------------------------------- THE POT */}
      <section id="pot" className="scene-dark py-12 md:py-24">
        <div className="relative mx-auto w-[min(1180px,92vw)]">
          <div className="max-w-3xl">
            <div data-reveal className="eyebrow">The Pot</div>
            <h2 data-reveal className="display mt-3" style={{ fontSize: "clamp(1.8rem, 6vw, 4.4rem)", transitionDelay: "0.05s" }}>
              The last one alive
              <br />
              takes everything.
            </h2>
          </div>
          <div data-reveal className="mt-10" style={{ transitionDelay: "0.1s" }}>
            <SeasonStats />
          </div>
          <div data-reveal className="mt-8" style={{ transitionDelay: "0.15s" }}>
            <a href="/arena" className="btn btn-teal">
              Enter the Arena: watch it live <span aria-hidden>→</span>
            </a>
          </div>
        </div>
      </section>

      {/* ------------------------------------------------------ THE STANDARD */}
      <StandardBlock />

      {/* -------------------------------------------------------------- CTA */}
      <section className="tx-cta">
        <div className="mx-auto flex w-[min(1180px,92vw)] flex-col items-center text-center">
          <div className="cub-bounce grid place-items-center rounded-full" style={{ width: 84, height: 84, background: "#fff" }}>
            <PetSprite size={58} />
          </div>
          <h2 className="display mt-5" style={{ fontSize: "clamp(1.9rem, 5.5vw, 4rem)", color: "#fff" }}>
            {MINT_OPEN ? "Put one in your wallet." : "Got one? Keep it alive."}
          </h2>
          <p className="mt-3 max-w-md text-lg" style={{ color: "#fff4ee" }}>
            {MINT_OPEN
              ? "Free, one per email, and preloaded with test CARE so you can try every mechanic."
              : "Every tap on the back of your card is a real care on chain, paid from your pet's own test CARE. Five needs, one life."}
          </p>
          {MINT_OPEN ? <MintCta /> : <MintClosed compact />}
        </div>
      </section>

      <SiteFooter />
    </main>
  );
}

/* -------------------------------------------------------------------- chrome */

function LcdChip({ label, value, tone }: { label: string; value: string; tone: "good" | "warn" }) {
  const color = tone === "good" ? "#2f9e6f" : "#d1552e";
  return (
    <div
      className="lcd flex items-center gap-2 rounded-full px-3 py-1.5"
      style={{ background: "#fff", boxShadow: "0 8px 18px -10px rgba(0,0,0,0.5)", fontSize: "0.66rem", whiteSpace: "nowrap" }}
    >
      <span style={{ width: 7, height: 7, borderRadius: 999, background: color }} />
      <span style={{ color: "var(--color-ink-muted)" }}>{label}</span>
      <span style={{ color }}>{value}</span>
    </div>
  );
}

/**
 * The colony: one pixel pet per canonical body hue (the exact 16 from the server trait system),
 * so a visitor immediately sees the collection's variety.
 */
const SHOWCASE_IDS = [1, 42, 87, 137, 288, 404, 500, 777, 999, 64, 333, 512, 640, 808, 900, 1000];

function PetShowcase() {
  return (
    <div className="showcase-grid">
      {SHOWCASE_IDS.map((id, i) => (
        <div key={id} className="showcase-tile" style={{ transform: `translateY(${i % 2 ? 8 : -8}px)` }}>
          <ShowcasePet tokenId={id} hueIndex={i} />
        </div>
      ))}
    </div>
  );
}

/* ------------------------------------------------------------------- evolution */

// The real evolution art, rendered by the server at each forced stage
// (preview.png?stage=0..3). The fallback pixel sprite shows instantly while the
// render loads, so there is never a broken-image flash.
const EVO_TOKEN = 7;
// The tiles plus their arrows have to share one line on a 320px phone, so
// every size is expressed against the row's own width.
const EVO_STAGES = [
  { label: "Egg", stage: 0, box: 66, crown: false },
  { label: "Hatchling", stage: 1, box: 74, crown: false },
  { label: "Grown", stage: 2, box: 88, crown: false },
  { label: "Prime", stage: 3, box: 104, crown: true },
  // The FINAL FORM: one of 28 (the API picks the showcase pet's own roll).
  ...(FORMS_ON ? [{ label: "Final Form", stage: 4, box: 112, crown: false }] : []),
];
const EVO_UNITS = EVO_STAGES.reduce((a, s) => a + s.box, 0); // 332, or 444 with the fifth tile
const EVO_GAPS = (EVO_STAGES.length - 1) * 22;
const evoSize = (px: number) => `min(${px}px, calc((88vw - ${EVO_GAPS}px) * ${px} / ${EVO_UNITS}))`;

function EvolutionRow() {
  const stages = EVO_STAGES;
  return (
    <div className="flex items-end justify-center gap-1 sm:gap-3">
      {stages.map((s, i) => (
        <div key={s.label} className="contents">
          <div className="flex min-w-0 flex-col items-center gap-2">
            <div className="relative grid place-items-center" style={{ height: evoSize(112) }}>
              {s.crown ? (
                <span aria-hidden className="absolute" style={{ top: -6, fontSize: 18, zIndex: 2 }}>
                  👑
                </span>
              ) : null}
              <EvoStage token={EVO_TOKEN} stage={s.stage} box={s.box} />
            </div>
            <span className="lcd" style={{ fontSize: "0.6rem", color: "var(--color-lav-deep)" }}>
              {s.label}
            </span>
          </div>
          {i < stages.length - 1 ? (
            <span aria-hidden className="flex-none pb-8 text-sm sm:text-lg" style={{ color: "var(--color-ink-muted)" }}>
              →
            </span>
          ) : null}
        </div>
      ))}
    </div>
  );
}

function EvoStage({ token, stage, box }: { token: number; stage: number; box: number }) {
  const side = evoSize(box);
  return (
    <div style={{ width: side, height: side, position: "relative", overflow: "hidden", borderRadius: 16 }}>
      <div className="absolute inset-0 grid place-items-center">
        <PetSprite size={Math.round(box * 0.6)} />
      </div>
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img
        src={`${petPortraitByToken(token)}?stage=${stage}`}
        alt={`Evolution stage ${stage}`}
        width={box}
        height={box}
        loading="lazy"
        decoding="async"
        style={{ position: "absolute", inset: 0, width: "100%", height: "100%", objectFit: "contain", borderRadius: 16 }}
      />
    </div>
  );
}

/* ----------------------------------------------------------- living pass mock */

function LivingPass() {
  return (
    <div className="pass w-full" style={{ maxWidth: 360 }}>
      <div className="pass-sun" />
      <div className="absolute left-0 right-0 top-0 flex items-center gap-2 px-5 pt-4">
        <span className="grid h-7 w-7 place-items-center rounded-lg" style={{ background: "rgba(255,255,255,0.9)" }}>
          <PetSprite size={20} />
        </span>
        <span className="display text-sm" style={{ letterSpacing: "0.01em" }}>
          {BRAND.name}
        </span>
        <span className="lcd ml-auto text-xs" style={{ opacity: 0.85 }}>
          No. 042
        </span>
      </div>

      <div className="absolute" style={{ left: "50%", bottom: "36%", transform: "translateX(-50%)", filter: "drop-shadow(0 4px 6px rgba(0,0,0,0.28))" }}>
        <PetSprite size={62} />
      </div>

      <div className="absolute bottom-0 left-0 right-0 flex flex-col justify-between" style={{ height: "34%", padding: "9px 16px 14px" }}>
        {/* Mirrors the real pass, field for field: one combined NEEDS line (most
            urgent first, each at most 1d because every clock is 24h), then the
            real card's STATUS / SURVIVES / CARE row. */}
        <div className="flex items-baseline gap-2">
          <span className="lcd" style={{ fontSize: 8, letterSpacing: "0.14em", opacity: 0.8 }}>
            NEEDS
          </span>
          <span style={{ fontSize: 10.5, fontWeight: 700 }}>🧭2h 🍯11h 💧14h 🎾19h 🧸1d</span>
        </div>
        <div className="flex items-end justify-between gap-3">
          <div className="flex gap-3.5">
            <PassField label="STATUS" value="ALIVE" />
            <PassField label="SURVIVES" value="in 2h" />
            <PassField label="CARE" value="98 CARE" />
          </div>
          <div className="grid flex-none grid-cols-4 gap-[3px] rounded-lg bg-white p-1.5" style={{ width: 40, height: 40 }} aria-hidden>
            {Array.from({ length: 16 }).map((_, i) => (
              <span key={i} style={{ background: (i * 7) % 3 === 0 ? "#163f52" : "transparent", borderRadius: 1 }} />
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}

function PassField({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <div className="lcd" style={{ fontSize: 8, letterSpacing: "0.14em", opacity: 0.8 }}>
        {label}
      </div>
      <div className="display" style={{ fontSize: 13, lineHeight: 1.15, whiteSpace: "nowrap" }}>
        {value}
      </div>
    </div>
  );
}

/** The back of the card, mirroring the real back fields in server/src/runner/pass.ts. */
function PassBack() {
  return (
    <div className="pass-back w-full" style={{ maxWidth: 360 }}>
      <div className="pass-back-row">
        <div className="pass-back-label">CARE FOR YOUR PET</div>
        <div>Tap an action to keep your pet happy.</div>
      </div>
      {NEED_GLYPHS.map((g, i) => (
        <div key={g} className="pass-back-row">
          <span className="pass-back-link">
            <span aria-hidden>{g} </span>
            {["Feed", "Give water", "Play", "Give a toy", "Explore"][i]}
          </span>
        </div>
      ))}
      <div className="pass-back-row">
        <div className="pass-back-label">TOKEN-BOUND ACCOUNT (ERC-6551)</div>
        <div className="mono">0x8f3a...c21e</div>
      </div>
      <div className="pass-back-row">
        <div className="pass-back-label">NETWORK</div>
        <div>Robinhood Chain (testnet)</div>
      </div>
    </div>
  );
}
