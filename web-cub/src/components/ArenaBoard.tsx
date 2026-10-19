"use client";

import { useEffect, useRef, useState } from "react";
import { getSeasonBoard, type SeasonBoard, type FallenPet, type KeeperPet } from "@/lib/api";
import { BRAND, MINT_OPEN } from "@/lib/brand";
import { BURN_PCT, REWARDS_PCT, POT_PCT, GAS_PCT } from "@/lib/tokenomics";
import { PetPortrait } from "./PetPortrait";

/**
 * The Arena: the live survival board. One poll of GET /api/season/board every
 * 5s drives everything: the Pot count-up, the survivor ticker + deathometer,
 * the sliding death feed, and the Most Devoted keeper ranks. All motion is
 * CSS keyframes + one rAF count-up, compositor-friendly, and it runs on mobile;
 * prefers-reduced-motion snaps every value instantly. Pre-season the board
 * renders a calm "the season has not begun" posture with real minted counts.
 */

const POLL_MS = 5000;

/** rAF count-up toward a moving target; snaps under prefers-reduced-motion. */
function useCountUp(target: number, duration = 1100): number {
  const [shown, setShown] = useState(0);
  const shownRef = useRef(0);
  useEffect(() => {
    if (!Number.isFinite(target)) return;
    const reduce = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    const from = shownRef.current;
    if (reduce || from === target) {
      shownRef.current = target;
      setShown(target);
      return;
    }
    const start = performance.now();
    let raf = 0;
    const step = (now: number) => {
      const p = Math.min(1, (now - start) / duration);
      const eased = 1 - Math.pow(1 - p, 3);
      const v = from + (target - from) * eased;
      shownRef.current = v;
      setShown(v);
      if (p < 1) raf = requestAnimationFrame(step);
    };
    raf = requestAnimationFrame(step);
    return () => cancelAnimationFrame(raf);
  }, [target, duration]);
  return shown;
}

function deathKey(d: FallenPet): string {
  return d.serial ?? d.tokenId ?? d.number ?? "";
}

function timeAgo(iso?: string): string {
  if (!iso) return "";
  const t = new Date(iso).getTime();
  if (!Number.isFinite(t)) return "";
  const s = Math.max(0, Math.floor((Date.now() - t) / 1000));
  if (s < 60) return "just now";
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  return `${Math.floor(h / 24)}d ago`;
}

export function ArenaBoard() {
  const [board, setBoard] = useState<SeasonBoard | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [newKeys, setNewKeys] = useState<Set<string>>(new Set());
  const prevKeysRef = useRef<Set<string> | null>(null);
  // Monotonic tick id: a slow poll that resolves late must never overwrite
  // data a newer poll already applied.
  const pollSeqRef = useRef(0);

  useEffect(() => {
    let alive = true;
    const poll = async () => {
      const tick = ++pollSeqRef.current;
      const b = await getSeasonBoard();
      if (!alive || tick !== pollSeqRef.current) return;
      setLoaded(true);
      if (!b) return; // keep the last good board on a blip
      const keys = new Set((b.recentDeaths ?? []).map(deathKey));
      if (prevKeysRef.current) {
        const fresh = new Set<string>();
        keys.forEach((k) => {
          if (!prevKeysRef.current!.has(k)) fresh.add(k);
        });
        if (fresh.size > 0) setNewKeys(fresh);
      }
      prevKeysRef.current = keys;
      setBoard(b);
    };
    poll();
    const t = setInterval(poll, POLL_MS);
    return () => {
      alive = false;
      clearInterval(t);
    };
  }, []);

  const active = board?.seasonActive === true;
  // THE CAP IS NOT A HEADCOUNT. `total` is the 2,000 supply ceiling: using it as
  // the denominator made the page read "2,000 hatched" and "1 / 2,000 alive"
  // while two pets existed. The real field is how many pets are actually in the
  // race (hatched, else minted), and alive/fallen are measured against THAT.
  const cap = board?.survivors?.total ?? BRAND.supply;
  // Live season with no verified on-chain headcount: the server sends null and the
  // page shows a dash, never a 0 or a cap.
  const countsUnknown = active && board?.survivors?.alive == null;
  const aliveN = board?.survivors?.alive ?? 0;
  const fallenN = board?.survivors?.fallen ?? 0;
  // Prefer the hatched count; fall back to registered, then to what we can see
  // (alive + fallen), never to the cap.
  const inPlay = Math.max(
    board?.survivors?.hatched ?? 0,
    board?.survivors?.registered ?? 0,
    aliveN + fallenN,
  );
  const potTarget = parseFloat((board?.pot?.display ?? "0").replace(/,/g, "")) || 0;
  const deaths = board?.recentDeaths ?? [];
  const keepers = board?.topKeepers ?? [];

  const potShown = useCountUp(potTarget, 1400);
  const aliveShown = Math.round(useCountUp(aliveN, 900));
  const fallenShown = Math.round(useCountUp(fallenN, 900));
  // The bar has to agree with the two numbers printed beside it, so it is
  // fallen out of the pets in play, not out of the supply cap.
  const fallenRatio = inPlay > 0 ? Math.max(0, Math.min(1, fallenN / inPlay)) : 0;

  const potText = potShown.toLocaleString("en-US", {
    maximumFractionDigits: potTarget % 1 === 0 ? 0 : 2,
  });
  // Clash Display has no tabular figures: give each digit a fixed-width span
  // so the rolling count-up does not jitter the layout.
  const potDigits = potText
    .split("")
    .map((ch, i) =>
      /\d/.test(ch) ? (
        <span key={i} className="arena-pot-digit">{ch}</span>
      ) : (
        <span key={i} className="arena-pot-sep">{ch}</span>
      ),
    );

  return (
    <section className="scene-dark arena">
      {/* ambient drama layer */}
      <div aria-hidden className="pointer-events-none absolute inset-0 overflow-hidden">
        <span className="sparkle" style={{ top: "8%", left: "6%", fontSize: 18 }}>✦</span>
        <span className="sparkle" style={{ top: "18%", right: "10%", fontSize: 14, animationDelay: "0.9s" }}>✦</span>
        <span className="sparkle" style={{ bottom: "14%", left: "12%", fontSize: 16, animationDelay: "1.6s" }}>✦</span>
        <span className="floaty" style={{ top: "10%", right: "5%", fontSize: 24, opacity: 0.5, animationDelay: "0.6s" }}>👻</span>
      </div>

      <div className="relative mx-auto w-[min(1120px,90vw)] py-9 md:py-20">
        {/* -------------------------------------------------- header */}
        <div className="flex flex-wrap items-center gap-3">
          <span className="live-dot" />
          <span className="eyebrow">{active ? "Live from the Arena" : "The Arena"}</span>
          <span className={`arena-status ${active ? "is-live" : ""}`}>
            {active ? "SEASON LIVE" : "SEASON NOT STARTED"}
          </span>
        </div>
        {/* The headline counts pets that have actually hatched. It used to print
            the supply cap, so a two-pet season announced "2,000 hatched". */}
        <h1 className="display mt-4" style={{ fontSize: "clamp(1.9rem, 7vw, 4.6rem)" }}>
          {countsUnknown ? null : inPlay > 0 ? `${inPlay.toLocaleString("en-US")} hatched.` : "The eggs are waiting."}
          {countsUnknown ? null : <br />}
          <span style={{ color: "#ffd9c9" }}>One walks out with the Pot.</span>
        </h1>
        <p className="lcd mt-3" style={{ fontSize: "0.7rem", color: "#8fb0ad", letterSpacing: "0.14em" }}>
          {cap.toLocaleString("en-US")} is the mint cap, not a headcount
        </p>

        {/* -------------------------------------------------- pot + survivors */}
        <div className="mt-10 grid items-end gap-8 lg:grid-cols-[1.15fr_0.85fr]">
          <div>
            <div className="lcd" style={{ fontSize: "0.78rem", color: "#ffd9c9", letterSpacing: "0.16em" }}>
              THE POT · winner takes all
            </div>
            <div className="arena-pot mt-2">
              {loaded ? potDigits : "···"}
              <span className="arena-pot-unit">CARE</span>
            </div>
            {/* No USD line, ever: this is the Testnet Experience and test CARE has no value, so a
                dollar figure would be a false claim whatever the API sends. */}
            <p className="mt-2 max-w-md text-base" style={{ color: "rgba(231,239,238,0.75)" }}>
              Test CARE. Every meal burns {BURN_PCT}, sends {REWARDS_PCT} back to the players, drops {POT_PCT} in here, and {GAS_PCT} pays the gas. It only grows.
            </p>
          </div>

          <div className="arena-panel p-6">
            <div className="flex items-baseline justify-between gap-3">
              <div className="lcd" style={{ fontSize: "0.72rem", color: "#bcd0cf" }}>
                Still alive
              </div>
              <div className="lcd" style={{ fontSize: "0.66rem", color: "#8fb0ad" }}>
                updates every 5s
              </div>
            </div>
            <div className="display mt-1" style={{ fontSize: "clamp(1.75rem, 6vw, 3.4rem)", lineHeight: 1 }}>
              {countsUnknown ? "—" : aliveShown.toLocaleString("en-US")}
              <span style={{ opacity: 0.55, fontSize: "0.5em" }}> / {countsUnknown ? "—" : inPlay.toLocaleString("en-US")}</span>
            </div>
            <div className="deathometer mt-4" role="img" aria-label={`${fallenN} of ${inPlay} pets in the race have fallen`}>
              <div className="deathometer-fill" style={{ transform: `scaleX(${loaded && !countsUnknown ? fallenRatio : 0})` }} />
            </div>
            <div className="mt-3 flex items-center justify-between">
              <span className="lcd" style={{ fontSize: "0.7rem", color: "#ff9d82" }}>
                {countsUnknown ? "—" : fallenShown.toLocaleString("en-US")} fallen
              </span>
              <span className="lcd" style={{ fontSize: "0.7rem", color: "#8fb0ad" }}>
                one will remain
              </span>
            </div>
          </div>
        </div>

        {/* -------------------------------------------------- feed + keepers */}
        <div className="mt-12 grid gap-6 lg:grid-cols-2">
          {/* the fallen */}
          <div className="arena-panel p-6">
            <div className="flex items-center gap-2">
              <span aria-hidden style={{ fontSize: 18 }}>🪦</span>
              <h2 className="display text-xl">The Fallen</h2>
              <span className="lcd ml-auto" style={{ fontSize: "0.66rem", color: "#8fb0ad" }}>
                live feed
              </span>
            </div>
            {deaths.length === 0 ? (
              <p className="arena-empty">
                {active
                  ? "No pet has fallen yet. All of them are still breathing."
                  : "The season has not begun. Every egg is safe. For now."}
              </p>
            ) : (
              <ul className="arena-feed mt-4" aria-live="polite">
                {deaths.map((d) => {
                  const remainLine = countsUnknown ? "" : `${aliveN.toLocaleString("en-US")} remain`;
                  return (
                    <li key={deathKey(d)} className={`arena-death ${newKeys.has(deathKey(d)) ? "is-new" : ""}`}>
                      <div className="arena-thumb">
                        <PetPortrait
                          serial={d.serial}
                          seed={d.tokenId ?? d.serial}
                          width={46}
                          alt={d.number ? `Pet ${d.number}` : "A fallen pet"}
                        />
                      </div>
                      <div className="min-w-0 flex-1">
                        <div className="flex items-baseline justify-between gap-2">
                          <span className="display text-sm" style={{ color: "#f4f8f7" }}>
                            {d.number ?? "A pet"} has fallen
                          </span>
                          <span className="lcd flex-none" style={{ fontSize: "0.6rem", color: "#8fb0ad" }}>
                            {timeAgo(d.diedAt)}
                          </span>
                        </div>
                        <div className="lcd mt-0.5" style={{ fontSize: "0.62rem", color: "#ff9d82" }}>
                          {d.outlasted != null ? `outlasted ${d.outlasted.toLocaleString("en-US")} pets · ` : ""}
                          {remainLine}
                        </div>
                      </div>
                    </li>
                  );
                })}
              </ul>
            )}
          </div>

          {/* most devoted */}
          <div className="arena-panel p-6">
            <div className="flex items-center gap-2">
              <span aria-hidden style={{ fontSize: 18 }}>💛</span>
              <h2 className="display text-xl">Most Devoted</h2>
              <span className="lcd ml-auto" style={{ fontSize: "0.66rem", color: "#8fb0ad" }}>
                by lifetime care
              </span>
            </div>
            {/* This board ranks care actions for ALL TIME. Rewards do not work
                that way: they settle per epoch, so an all-time rank is a
                devotion board, not an earnings board. Say so. */}
            <p className="mt-2 text-sm" style={{ color: "#a9c6c2" }}>
              {REWARDS_PCT} of every care action flows back to the keepers, pushed into each living
              pet&apos;s own account every couple of hours. What a pet receives tracks its care inside
              each window, not this all-time count. Nothing to claim: a pet that dies forfeits its
              share to the survivors.
            </p>
            {keepers.length === 0 ? (
              <p className="arena-empty">
                {active
                  ? "The first meal has not been served. The throne is empty."
                  : "When the season opens, the best-kept pets climb this board."}
              </p>
            ) : (
              <ol className="arena-keepers mt-4">
                {keepers.map((k, i) => (
                  <li key={k.serial ?? k.tokenId ?? i} className={`arena-keeper ${i === 0 ? "is-top" : ""}`}>
                    <span className={`arena-rank ${i === 0 ? "is-gold" : ""}`}>{i === 0 ? "👑" : i + 1}</span>
                    <div className="arena-thumb">
                      <PetPortrait
                        serial={k.serial}
                        seed={k.tokenId ?? k.serial}
                        width={46}
                        alt={k.number ? `Pet ${k.number}` : "A devoted pet"}
                      />
                    </div>
                    <div className="min-w-0 flex-1">
                      <div className="display truncate text-sm" style={{ color: "#f4f8f7" }}>
                        {k.number ?? "A pet"}
                      </div>
                      <div className="lcd mt-0.5" style={{ fontSize: "0.62rem", color: "#8fd6c9" }}>
                        cared for {(k.careCount ?? 0).toLocaleString("en-US")}x{i === 0 ? " · most devoted" : ""}
                      </div>
                    </div>
                    <span className="arena-care-bar" aria-hidden>
                      <i
                        style={{
                          width: `${Math.max(
                            8,
                            Math.round(((k.careCount ?? 0) / Math.max(1, keepers[0]?.careCount ?? 1)) * 100),
                          )}%`,
                        }}
                      />
                    </span>
                  </li>
                ))}
              </ol>
            )}
          </div>
        </div>

        {/* -------------------------------------------------- cta */}
        <div className="mt-12 flex flex-wrap items-center justify-center gap-4 text-center">
          {MINT_OPEN && (
            <a href="/#adopt" className="btn btn-cub">
              Put a pet in the fight
            </a>
          )}
          <a href="/how-to" className="btn btn-ghost" style={{ background: "rgba(255,255,255,0.1)", color: "#f4f8f7" }}>
            How survival works
          </a>
        </div>
      </div>
    </section>
  );
}
