import type { Metadata } from "next";
import { SiteNav, SiteFooter } from "@/components/SiteChrome";
import { TreasureMap } from "@/components/TreasureMap";
import { StandardBlock } from "@/components/StandardBlock";
import { BRAND, SEASON, STARTER_DAYS, NEED_CLOCK_LABEL, MINT_OPEN, FORMS_ON, EVOLUTION, REMINDERS } from "@/lib/brand";
import { BURN_PCT, REWARDS_PCT, POT_PCT, GAS_PCT } from "@/lib/tokenomics";

export const metadata: Metadata = {
  title: "How it works",
  description:
    "Six steps from an email to a pet that lives in your Apple or Google Wallet, what happens on chain at every tap, and the rules of the game running on the card. A live testnet demo of the Wallet Pass Extension for NFTs.",
};

// What the visitor does, and what the build actually does about it. Each line is checked against
// the running code: Privy embedded wallet, PetIssuer + ERC-6551 account + starter float, the signed
// pass (pass.ts / google.ts), the HMAC care links re-checked with a FRESH ownerOf (routes.ts), the
// care-only session grant, pass pushes, and the claim rotation (claim.ts).
const UNDER_THE_HOOD = [
  {
    you: "Type your email and the code",
    chain: "An embedded wallet is created that only you control. No seed phrase is ever shown to you.",
  },
  {
    you: "Your pet mints",
    chain: `The ERC-721 lands in that wallet, the pet gets its own ERC-6551 account holding ${SEASON.starterCare} test CARE, and a signed Apple pass and Google pass are issued for it.`,
  },
  {
    you: "Tap Feed on the back of the card",
    chain: "The link is an unguessable capability URL for that pet and that action. The server re-reads ownerOf on chain, then sends a sponsored care() from your wallet under a care-only permission you granted once.",
  },
  {
    you: "Anything changes on chain",
    chain: `Every mint, transfer and care emits PassUpdate from the pet contract, and the card is rebuilt from chain state and pushed to your phone. A reminder reaches your phone when your pet has ${REMINDERS.checkInHours} hours left and a last chance at ${REMINDERS.lastChanceHours}, each naming the taps that fix it (or all five needs). News from the colony shows on the card.`,
  },
  {
    you: "The pet changes hands",
    chain: "Gift it from My pets (one signature, no gas) or sell it anywhere. The old card's taps fail the ownerOf check immediately. The new owner proves control, which rotates the pass and every link on it. If a link of yours ever leaks, Reset my pass links on My pets kills every old link and re-sends your card.",
  },
  {
    you: "A wallet or marketplace asks",
    chain: "passURI(tokenId) on the contract points at the pet's pass manifest. Strangers get a 401. The owner signs a one-time challenge and gets the Apple and Google links.",
  },
];

// Every number here comes from one of: lib/brand.ts (SEASON, EVOLUTION, REMINDERS, mirrored from
// server/src/config.ts and contracts/script/showcase.env), lib/tokenomics.ts, or the server's own
// copy (reminders.ts, album.ts, game.ts, night.ts). Nothing is typed in by hand.
const EVOLUTION_LINE = `Care for it and it evolves: egg, hatchling at its first care, grown at ${EVOLUTION.grownCares} cares or ${EVOLUTION.grownDays} days, prime at ${EVOLUTION.primeCares} cares or ${EVOLUTION.primeDays} days, whichever comes first.`;
const RULES = [
  MINT_OPEN
    ? `Mint is free with just an email. One pet per email and one per phone, ${BRAND.supply.toLocaleString("en-US")} in total.`
    : "Minting was free with just an email, one pet per email and one per phone. It is closed now. The Arena shows how many were minted and how many are still alive.",
  `Every pet starts with ${SEASON.starterCare} test CARE in its own account: about ${STARTER_DAYS} days of all five needs at the minimum. Test CARE is fake and has no value.`,
  "Its first feed hatches it and fills all five bowls. Usually that happens during the mint itself.",
  `Feed, water, play, toy, explore: each need has its own ${NEED_CLOCK_LABEL} clock, and a care resets only that one. Miss any one and it dies. Death is forever: the card stays as a soulbound memorial.`,
  "Feeding does not reset the day. If you feed and water at night, play, toy and explore keep counting down on their own clocks and can still run out the next morning. The SURVIVES time on the card is always the oldest need, so care for that one first.",
  `One care for each of the five needs a day is all it takes: a pet dies when its oldest need runs out. Every tap spends and every tap counts. Launch-week pets (No. 1 to ${SEASON.legacyMaxToken}) carry a limit of ${SEASON.dailyCares} cares per 24 hours in their own account; pets minted after that have no such limit.`,
  `Two reminders, no more: one when your pet has ${REMINDERS.checkInHours} hours left and a last chance at ${REMINDERS.lastChanceHours}. Both say how long it has and which taps fix it. The last chance ignores quiet hours: a dying pet is worth waking for.`,
  `Each care costs 1 test CARE: ${BURN_PCT} is burned, ${REWARDS_PCT} goes back to living keepers, ${POT_PCT} goes into the Pot, ${GAS_PCT} pays the gas for pushes.`,
  "Keeper rewards are pushed into each living pet's account every 2 hours. Nothing to claim. A pet that dies forfeits its share to the survivors.",
  "Simulated trading fees: every 2 hours the server mints 100 test USDG into the fee splitter. Half is swapped into test CARE for the keeper rewards pool. Half is airdropped four times a day into every living pet's own account, split by how much CARE each one holds. In a real deployment this stream would come from trading fees; here it is minted so every mechanic runs.",
  FORMS_ON
    ? `${EVOLUTION_LINE} Past prime comes its final form: one of ${EVOLUTION.forms} forms in ${EVOLUTION.families} families (a dragon, a koi, an owl, a slime king), rolled at random for each pet, and it keeps its own colours and face. Launch-week pets (No. 1 to ${SEASON.legacyMaxToken}) take their form as soon as they are prime; newer pets need prime plus ${EVOLUTION.formCares} cares or ${EVOLUTION.formDays} days. The games still draw the base body for now.`
    : EVOLUTION_LINE,
  "The back of the card also opens two games, CHI SHOT and CHI NIGHT, and a photo album with five pictures of your pet: a banner, a PFP, a wallpaper, a poster and the class photo. The album is for living pets. A tombstone keeps the games.",
  MINT_OPEN
    ? `New pets can join for the first ${SEASON.rosterDays} days of the season. After that the roster is locked.`
    : "Minting is closed, so the roster is set: no new pets join this season.",
  `No winner before the season's first ${SEASON.rosterDays} days are up, and never with fewer than ${SEASON.minPlayers} hatched pets.`,
  "The last pet alive takes the whole Pot into its own account and becomes immortal.",
];

export default function HowTo() {
  return (
    <main className="relative" id="top">
      <SiteNav />

      {/* ------------------------------------------------------------ THE MAP */}
      <section className="tx-band">
        <div className="mx-auto w-[min(1120px,90vw)] text-center">
          <div data-reveal className="eyebrow" style={{ color: "var(--color-teal-deep)" }}>
            The map
          </div>
          <h1 data-reveal className="display mt-3" style={{ fontSize: "clamp(2rem, 6.5vw, 4.6rem)", lineHeight: 0.98, transitionDelay: "0.05s" }}>
            From an email
            <br />
            <span style={{ color: "var(--color-salmon-text)" }}>to a living card.</span>
          </h1>
          <p data-reveal className="mx-auto mt-4 max-w-lg text-lg" style={{ color: "var(--color-ink-soft)", transitionDelay: "0.1s" }}>
            Six steps, no app, no seed phrase. Pick your wallet and follow the footprints.
          </p>
        </div>
        <div className="mx-auto mt-10 w-[min(1120px,90vw)]">
          <TreasureMap />
        </div>
      </section>

      {/* --------------------------------------------------- UNDER THE HOOD */}
      <section id="hood" className="tx-band tx-band-river">
        <div className="mx-auto w-[min(1120px,90vw)]">
          <div className="max-w-2xl">
            <div data-reveal className="eyebrow">Under the hood</div>
            <h2 data-reveal className="display mt-3" style={{ fontSize: "clamp(1.8rem, 5vw, 3.6rem)", color: "#f4f8f7", transitionDelay: "0.05s" }}>
              What each tap does
              <br />
              <span style={{ color: "#ffd9c9" }}>on chain.</span>
            </h2>
          </div>
          <div className="mt-10 grid gap-[2px] overflow-hidden rounded-3xl" style={{ background: "rgba(255,255,255,0.1)" }}>
            {UNDER_THE_HOOD.map((r, i) => (
              <div key={r.you} data-reveal className="grid gap-2 p-5 md:grid-cols-[0.8fr_1.6fr] md:gap-8 md:p-6" style={{ background: "#1a4a60", transitionDelay: `${i * 0.05}s` }}>
                <div className="flex items-baseline gap-3">
                  <span className="lcd" style={{ color: "#ffd9c9", fontSize: "0.9rem" }}>
                    {String(i + 1).padStart(2, "0")}
                  </span>
                  <span className="display text-lg" style={{ color: "#f4f8f7" }}>
                    {r.you}
                  </span>
                </div>
                <p className="text-sm leading-relaxed md:text-base" style={{ color: "#cfe3e5" }}>
                  {r.chain}
                </p>
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* ------------------------------------------------------- THE RULES */}
      <section id="rules" className="tx-band tx-band-teal">
        <div className="mx-auto w-[min(1120px,90vw)]">
          <div className="grid items-end gap-6 lg:grid-cols-[1fr_1fr]">
            <div>
              <div data-reveal className="eyebrow" style={{ color: "var(--color-salmon-text)" }}>
                The game on the card
              </div>
              <h2 data-reveal className="display mt-3" style={{ fontSize: "clamp(1.8rem, 5vw, 3.6rem)", transitionDelay: "0.05s" }}>
                Cute pet.
                <br />
                Life and death on chain.
              </h2>
            </div>
            <p data-reveal className="text-lg" style={{ color: "var(--color-ink-soft)", transitionDelay: "0.1s" }}>
              The game is what makes the card worth watching: clocks that tick, a balance that moves,
              a colony that shrinks. Life, death, the roster and the Pot all live in the contracts,
              not on a server.
            </p>
          </div>

          <ol className="tx-rules mt-10" style={{ background: "rgba(22,63,82,0.18)" }}>
            {RULES.map((rule, i) => (
              <li key={rule} data-reveal className="tx-rule" style={{ background: "#fff", color: "var(--color-ink-soft)", transitionDelay: `${(i % 2) * 0.05}s` }}>
                <span className="tx-rule-n" style={{ color: "var(--color-salmon-text)" }}>
                  {String(i + 1).padStart(2, "0")}
                </span>
                <span className="min-w-0 text-sm sm:text-base">{rule}</span>
              </li>
            ))}
          </ol>

          <div data-reveal className="mt-8 flex flex-wrap justify-center gap-3">
            {MINT_OPEN && (
              <a href="/#adopt" className="btn btn-cub">
                Get my pet, free
              </a>
            )}
            <a href="/arena" className="btn btn-ghost">
              Watch the Arena live
            </a>
          </div>
        </div>
      </section>

      <StandardBlock />

      <SiteFooter />
    </main>
  );
}
