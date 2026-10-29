"use client";

import { useEffect, useState } from "react";
import { getSeasonStats } from "@/lib/api";
import { MintClosed } from "./MintClosed";

// The hero's mint button while MINT_OPEN is on. Hunt 2026-10-19: once the season's slots are
// taken (server RUNNER_SUPPLY_CAP, reported as soldOut by /api/season/stats) the button becomes
// the "Minting is closed" line by itself, with no redeploy. Until the stats answer, the button
// shows as before (a sold-out click only reaches the closed card below).
export function MintCta() {
  const [closed, setClosed] = useState(false);
  useEffect(() => {
    let live = true;
    getSeasonStats()
      .then((s) => {
        if (live && s?.soldOut) setClosed(true);
      })
      .catch(() => {});
    return () => {
      live = false;
    };
  }, []);
  if (closed) return <MintClosed compact />;
  return (
    <a href="#adopt" className="btn tx-cta-btn mt-7">
      Get my pet, free
    </a>
  );
}
