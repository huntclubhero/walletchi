"use client";

import { useState } from "react";
import { PetSprite } from "./PetSprite";
import { NEED_COLORS, NEED_GLYPHS, NEED_LABELS } from "@/lib/needs";
import { MINT_OPEN, REMINDERS } from "@/lib/brand";

type Platform = "apple" | "google";

// The five needs, from the one shared set, so this illustration can never drift
// from the wallet card, the care page or the confirm page.
const CARE = NEED_GLYPHS.map((e, i) => ({ e, l: NEED_LABELS[i]!.toUpperCase() }));

export function TreasureMap() {
  const [platform, setPlatform] = useState<Platform>("apple");
  const isApple = platform === "apple";

  const stops: { title: string; caption: string; screen: React.ReactNode }[] = [
    {
      title: "Enter your email",
      caption: "No app, no wallet, no crypto words. Just type your email and tap the button.",
      screen: <ScreenEmail />,
    },
    {
      title: "Add it to your wallet",
      caption: isApple
        ? "Tap Add to Apple Wallet in Safari. Your new card slides right in. Inside the X or Instagram app it will not: open the link from your email in Safari."
        : "Tap Save to Google Wallet in Chrome. Your new card lands in your wallet. Inside the X or Instagram app it will not: open the link from your email in Chrome.",
      screen: <ScreenWallet platform={platform} />,
    },
    {
      title: "Your card arrives",
      caption: "Open your wallet and there it is: your pet's own card, with its number on it. That card is the NFT.",
      screen: <ScreenEgg />,
    },
    {
      title: "Flip the card over",
      caption: isApple
        ? "Tap the ••• button at the top right. The card flips to its back, where the buttons live."
        : "Open the pass and tap Details. That is where the care buttons live.",
      screen: <ScreenFlip platform={platform} />,
    },
    {
      title: "Tap an action on the back",
      caption: "Each button sends a real care transaction on chain, and the gas is on us. The first feed hatches the egg with all five bowls full (usually during the mint itself).",
      screen: <ScreenHatch />,
    },
    {
      title: "It is alive. Keep it that way.",
      caption: `Feed, water, play, toy, and explore: five needs, every day, each on its own timer. The card updates itself and pings you when it has ${REMINDERS.checkInHours} hours left, and once more at ${REMINDERS.lastChanceHours}.`,
      screen: <ScreenAlive />,
    },
  ];

  return (
    <div>
      {/* platform toggle: plain toggle buttons (not a tab pattern; the content
          below is one trail whose captions adapt, not separate tabpanels) */}
      <div className="flex justify-center">
        <div className="map-toggle" role="group" aria-label="Choose your wallet">
          <button
            className={`toggle-btn ${isApple ? "on" : ""}`}
            onClick={() => setPlatform("apple")}
            aria-pressed={isApple}
          >
            Apple Wallet
          </button>
          <button
            className={`toggle-btn ${!isApple ? "on" : ""}`}
            onClick={() => setPlatform("google")}
            aria-pressed={!isApple}
          >
            Google Wallet
          </button>
        </div>
      </div>

      {/* the trail */}
      <div className="trail mt-12">
        <div data-reveal className="flex flex-col items-center gap-2">
          <div className="pixel-pet" style={{ width: 92 }}>
            <div className="pp-breathe">
              <PetSprite className="pp-svg" />
              <span className="pp-lid pp-lid-l" />
              <span className="pp-lid pp-lid-r" />
            </div>
          </div>
          <div className="lcd" style={{ fontSize: "0.72rem", color: "var(--color-lav-deep)" }}>
            Start here, follow me!
          </div>
        </div>

        <Connector i={0} />

        {stops.map((s, i) => (
          <div key={i}>
            <div data-reveal className={`soft-card stop-card ${i % 2 === 1 ? "flip" : ""}`} style={{ transitionDelay: `${(i % 2) * 0.05}s` }}>
              <span className="stop-node">{i + 1}</span>
              <PhoneMock>{s.screen}</PhoneMock>
              <div className={i % 2 === 1 ? "text-right" : ""}>
                <h3 className="display text-xl">{s.title}</h3>
                <p className="mt-2 text-sm leading-relaxed" style={{ color: "var(--color-ink-soft)" }}>
                  {s.caption}
                </p>
              </div>
            </div>
            {i < stops.length - 1 && <Connector i={i + 1} />}
          </div>
        ))}

        <Connector i={stops.length} />

        <div data-reveal className="flex flex-col items-center gap-2">
          <div className="cub-bounce grid place-items-center rounded-full" style={{ width: 84, height: 84, background: "linear-gradient(160deg,#ffe7d8,#e6f6f6)", boxShadow: "0 12px 26px -12px rgba(47,125,122,0.45)" }}>
            <PetSprite size={58} />
          </div>
          <div className="display text-2xl">You did it!</div>
          <p className="max-w-xs text-center text-sm" style={{ color: "var(--color-ink-soft)" }}>
            That is the whole setup. Next: what each tap does on chain, and the rules the pet lives by.
          </p>
          <div className="mt-2 flex flex-wrap justify-center gap-3">
            <a href="#hood" className="btn btn-ghost">
              Under the hood <span aria-hidden>↓</span>
            </a>
            {MINT_OPEN && (
              <a href="/#adopt" className="btn btn-cub">
                Get my pet, free
              </a>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ pieces */

function PhoneMock({ children }: { children: React.ReactNode }) {
  return (
    <div className="phone">
      <div className="phone-notch" />
      <div className="phone-screen">{children}</div>
    </div>
  );
}

function Connector({ i }: { i: number }) {
  const lr = i % 2 === 0;
  const d = lr ? "M120,4 C 30,32 210,56 120,84" : "M120,4 C 210,32 30,56 120,84";
  return (
    <div className="conn" aria-hidden>
      <svg className="conn-curve" viewBox="0 0 240 88" fill="none" preserveAspectRatio="xMidYMid meet">
        <path d={d} stroke="#a48fd6" strokeWidth="3" strokeDasharray="1.5 9" strokeLinecap="round" opacity="0.7" />
        <path d="M112,79 L120,88 L128,79" stroke="#a48fd6" strokeWidth="3" fill="none" strokeLinecap="round" strokeLinejoin="round" />
      </svg>
      <span className="conn-foot" style={{ left: lr ? "38%" : "56%", top: "40%" }}>
        🐾
      </span>
      <div className="conn-vert" />
    </div>
  );
}

function Egg({ size = 44 }: { size?: number }) {
  return (
    <div
      style={{
        width: size,
        height: size * 1.28,
        borderRadius: "50% 50% 50% 50% / 60% 60% 42% 42%",
        background: "radial-gradient(60% 55% at 42% 30%, #fffaf0, #f4e6cf 78%)",
        boxShadow: "inset 0 -4px 8px rgba(200,170,120,0.35), 0 4px 10px -4px rgba(107,85,168,0.3)",
        position: "relative",
      }}
    >
      <span style={{ position: "absolute", left: "26%", top: "44%", width: 4, height: 4, borderRadius: 9, background: "#a68fd8", opacity: 0.7 }} />
      <span style={{ position: "absolute", right: "26%", top: "58%", width: 5, height: 5, borderRadius: 9, background: "#ff9d82", opacity: 0.7 }} />
    </div>
  );
}

function ScreenEmail() {
  return (
    <>
      <PetSprite size={30} />
      <div className="lcd" style={{ fontSize: 8, color: "var(--color-lav-deep)" }}>
        Hatch your pet
      </div>
      <div style={{ width: "100%", borderRadius: 8, background: "#fff", padding: "6px 8px", fontSize: 8, color: "#9aacae", boxShadow: "inset 0 0 0 1.5px rgba(164,143,214,0.3)" }}>
        you@email.com
      </div>
      <div style={{ width: "100%", borderRadius: 999, padding: "6px", textAlign: "center", fontSize: 8, fontWeight: 800, color: "#fff", background: "linear-gradient(160deg,#ff9d78,#ef6a41)" }}>
        Get my pet
      </div>
    </>
  );
}

function ScreenWallet({ platform }: { platform: Platform }) {
  const apple = platform === "apple";
  return (
    <>
      <div className="lcd" style={{ fontSize: 8, color: "var(--color-teal-deep)" }}>
        Save your pet
      </div>
      {apple ? (
        <div style={{ width: "100%", borderRadius: 8, padding: "8px", textAlign: "center", fontSize: 8, fontWeight: 800, color: "#fff", background: "#1c1c1e" }}>
          Add to Apple Wallet
        </div>
      ) : (
        <div style={{ width: "100%", borderRadius: 8, padding: "8px", textAlign: "center", fontSize: 8, fontWeight: 800, color: "#3c4043", background: "#fff", boxShadow: "inset 0 0 0 1.5px #dadce0" }}>
          Save to Google Wallet
        </div>
      )}
      <div style={{ fontSize: 20 }}>👇</div>
    </>
  );
}

function ScreenEgg() {
  return (
    <div className="mini-pass" style={{ paddingBottom: 12 }}>
      <div style={{ display: "flex", alignItems: "center", gap: 4 }}>
        <PetSprite size={12} />
        <span className="lcd" style={{ fontSize: 7 }}>
          WALLETCHI
        </span>
        <span className="lcd" style={{ fontSize: 7, marginLeft: "auto", opacity: 0.85 }}>
          No. 042
        </span>
      </div>
      <div style={{ display: "grid", placeItems: "center", padding: "8px 0 2px" }}>
        <Egg size={34} />
      </div>
    </div>
  );
}

function ScreenFlip({ platform }: { platform: Platform }) {
  const apple = platform === "apple";
  return (
    <>
      <div className="mini-pass">
        <div style={{ display: "flex", alignItems: "center", gap: 4 }}>
          <PetSprite size={12} />
          <span className="lcd" style={{ fontSize: 7 }}>
            WALLETCHI
          </span>
          {apple ? (
            // The iOS 15+ pass "more" button: a round ••• at the top right. It
            // replaced the old ⓘ, and it is the ONLY way to the care buttons on
            // the back, so the mock has to show the glyph a keeper will hunt for.
            <span className="more-dot" style={{ marginLeft: "auto", boxShadow: "0 0 0 4px rgba(255,255,255,0.35)" }}>
              •••
            </span>
          ) : (
            <span className="lcd" style={{ fontSize: 7, marginLeft: "auto", background: "rgba(255,255,255,0.9)", color: "#163f52", borderRadius: 6, padding: "1px 4px" }}>
              Details
            </span>
          )}
        </div>
        <div style={{ display: "grid", placeItems: "center", padding: "6px 0 2px" }}>
          <Egg size={26} />
        </div>
      </div>
      <div style={{ fontSize: 18 }}>🔄</div>
      <div className="lcd" style={{ fontSize: 7.5, color: "var(--color-lav-deep)", textAlign: "center" }}>
        {apple ? "tap ••• to flip" : "tap Details for actions"}
      </div>
    </>
  );
}

function ScreenHatch() {
  return (
    <>
      {/* All five care buttons: the back of a real pass carries one per need. */}
      <div style={{ display: "flex", gap: 4, flexWrap: "wrap", justifyContent: "center" }}>
        <span className="care-pill on">{CARE[0]!.e} {CARE[0]!.l}</span>
        {CARE.slice(1).map((c) => (
          <span key={c.l} className="care-pill">{c.e}</span>
        ))}
      </div>
      <div style={{ position: "relative", display: "grid", placeItems: "center", marginTop: 4 }}>
        <div style={{ position: "relative" }}>
          <Egg size={40} />
          <span style={{ position: "absolute", left: "18%", top: "42%", right: "18%", height: 2, background: "#8a6a32", clipPath: "polygon(0 40%, 20% 0, 40% 60%, 60% 0, 80% 60%, 100% 0, 100% 100%, 0 100%)", opacity: 0.7 }} />
        </div>
        <span className="sparkle" style={{ position: "absolute", right: -8, top: -6, fontSize: 12, color: "#ffb59b" }}>
          ✦
        </span>
      </div>
      <div className="lcd" style={{ fontSize: 7.5, color: "var(--color-salmon-text)" }}>
        crack!
      </div>
    </>
  );
}

function ScreenAlive() {
  return (
    <>
      <PetSprite size={40} />
      {/* FIVE bars for five needs. Three used to stand in for five, which drew
          a card that cannot exist: play, toy and explore each run their own
          clock. Values are illustrative and all sub-full, since a real card is
          only ever full right after a care. */}
      <div style={{ width: "100%", display: "flex", flexDirection: "column", gap: 3 }}>
        {[82, 68, 90, 54, 73].map((pct, i) => (
          <div key={NEED_LABELS[i]} className="meter-mini">
            <i style={{ width: `${pct}%`, background: NEED_COLORS[i] }} />
          </div>
        ))}
      </div>
      <div style={{ display: "flex", gap: 3, flexWrap: "wrap", justifyContent: "center" }}>
        {CARE.map((c) => (
          <span key={c.l} className="care-pill" style={{ fontSize: "0.5rem", padding: "3px 5px" }}>
            {c.e} {c.l}
          </span>
        ))}
      </div>
    </>
  );
}
