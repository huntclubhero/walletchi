"use client";

import { useEffect, useState } from "react";
import { getSeasonStats, type SeasonStats as Stats } from "@/lib/api";
import { BRAND } from "@/lib/brand";
import { BURN_PCT, REWARDS_PCT, POT_PCT, GAS_PCT } from "@/lib/tokenomics";

/**
 * The Pot ticker for the dark survival scene. Polls GET /api/season/stats (confirmed shape
 * {potDisplay, potRaw, cubsAlive, cubsTotal, careToken, seasonActive}; "cubs" are shown as
 * "pets"). Falls back to a calm "opens with the first care" state on 404 or seasonActive false.
 */
export function SeasonStats() {
  const [stats, setStats] = useState<Stats | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [grow, setGrow] = useState(false);

  useEffect(() => {
    let alive = true;
    const poll = async () => {
      const s = await getSeasonStats();
      if (!alive) return;
      if (s) setStats(s); // keep the last good stats on a blip (matches ArenaBoard)
      setLoaded(true);
    };
    poll();
    const t = setInterval(poll, 12000);
    const g = setTimeout(() => setGrow(true), 350);
    return () => {
      alive = false;
      clearInterval(t);
      clearTimeout(g);
    };
  }, []);

  const potDisplay =
    stats?.potDisplay ??
    (stats?.potRaw != null ? String(stats.potRaw) : stats?.pot != null ? String(stats.pot) : null);
  const token = stats?.careToken ?? stats?.symbol ?? stats?.tokenSymbol ?? "";
  // THE CAP IS NOT A HEADCOUNT. 2,000 is the mint ceiling; it is shown as such
  // and never used as the alive denominator. This ticker used to pin aliveN to
  // the cap pre-season, so the site claimed 2,000 pets were alive before a
  // single one had hatched.
  const cap = stats?.cubsTotal ?? BRAND.supply;
  const aliveRaw = stats?.cubsAlive ?? stats?.alive ?? stats?.petsAlive ?? stats?.aliveCount ?? null;
  const active = (stats?.seasonActive ?? stats?.active) === true;
  const hasSeason = loaded && stats != null && active && (potDisplay != null || aliveRaw != null);
  const aliveN = aliveRaw ?? 0;
  // Pets actually in play: hatched when the season is live, else the minted
  // count. Never the cap.
  const inPlay = Math.max(stats?.hatched ?? 0, stats?.registered ?? 0, aliveN);
  const ratio = inPlay > 0 ? Math.max(0, Math.min(1, aliveN / inPlay)) : 0;

  return (
    <div className="grid items-center gap-8 lg:grid-cols-[1.1fr_0.9fr]">
      <div>
        <div className="flex items-center gap-2">
          <span className="live-dot" />
          <span className="eyebrow">{hasSeason ? "Live pot · test CARE" : "The Pot"}</span>
        </div>
        {hasSeason && potDisplay != null ? (
          <div className="display mt-3" style={{ fontSize: "clamp(2.5rem, 11vw, 7rem)", lineHeight: 0.88 }}>
            {potDisplay}
            {token ? (
              <span className="lcd" style={{ fontSize: "0.2em", marginLeft: "0.4em", opacity: 0.85, letterSpacing: "0.1em" }}>
                {token}
              </span>
            ) : null}
          </div>
        ) : (
          // Pre-season: a promise, not a dead zero.
          <div className="display mt-3 max-w-md" style={{ fontSize: "clamp(1.55rem, 5vw, 3rem)", lineHeight: 1.05 }}>
            The Pot opens when the first meal is served.
          </div>
        )}
        <p className="mt-3 max-w-md text-lg" style={{ color: "rgba(231,239,238,0.82)" }}>
          {BURN_PCT} of every meal is burned, {REWARDS_PCT} goes back to the players, {POT_PCT} drops in here, and {GAS_PCT} pays the gas. It only grows.
        </p>
      </div>

      <div
        className="rounded-3xl p-6"
        style={{ background: "rgba(255,255,255,0.06)", border: "1px solid rgba(255,255,255,0.12)" }}
      >
        <div className="lcd" style={{ fontSize: "0.72rem", color: "#bcd0cf" }}>
          Pets alive
        </div>
        {/* "···" until the first read lands: a real zero and an unknown are not
            the same thing, and the old code filled the gap with the supply cap. */}
        <div className="display mt-1" style={{ fontSize: "clamp(1.6rem, 6vw, 3rem)" }}>
          {!loaded ? "···" : active && aliveRaw == null ? "—" : aliveN.toLocaleString("en-US")}
          <span style={{ opacity: 0.55, fontSize: "0.55em" }}>
            {" "}
            / {!loaded ? "···" : active && aliveRaw == null ? "—" : inPlay.toLocaleString("en-US")}
          </span>
        </div>
        <div className="lcd mt-1" style={{ fontSize: "0.62rem", color: "#8fb0ad" }}>
          {hasSeason ? "of the pets in the race" : "minted so far"} · {cap.toLocaleString("en-US")} mint cap
        </div>
        <div className="survivor-track mt-4">
          <div
            className="survivor-fill"
            style={{ transform: `scaleX(${grow ? ratio : 0})`, transition: "transform 1.2s cubic-bezier(0.22,0.61,0.36,1)" }}
          />
        </div>
        <div className="lcd mt-3" style={{ fontSize: "0.7rem", color: "#8fb0ad" }}>
          One will remain.
        </div>
      </div>
    </div>
  );
}
