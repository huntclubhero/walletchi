"use client";

import { useEffect, useState } from "react";
import { fetchLiveChainConfig } from "@/lib/chain-config";

/**
 * "Mint open until <date>", read live from the vault's entryDeadline via /api/chain-config.
 * Renders NOTHING when the API has no date (sellout model, unreadable, older API): a guessed
 * date is worse than none. Rendered as an <li> so it sits in the hero's fact chips.
 */
export function MintDeadline() {
  const [deadline, setDeadline] = useState<number | null>(null);

  useEffect(() => {
    let alive = true;
    void fetchLiveChainConfig().then((cfg) => {
      const d = cfg?.season?.entryDeadline;
      if (alive && typeof d === "number" && d > 0) setDeadline(d);
    });
    return () => {
      alive = false;
    };
  }, []);

  if (deadline == null) return null;
  const date = new Date(deadline * 1000).toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
  });
  return <li>{Date.now() < deadline * 1000 ? `Mint open until ${date}` : `Mint closed ${date}`}</li>;
}
