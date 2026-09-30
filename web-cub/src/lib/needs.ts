// THE FIVE NEEDS, defined ONCE for the whole site.
//
// There used to be three competing emoji sets for the same five actions (the
// wallet card, the care page, the care confirm page, the homepage art), so the
// exact same tap looked like a different action depending on where a keeper saw
// it. This module is the web side's single source; it mirrors NEED_GLYPHS in
// server/src/runner/needs.ts, which is the canonical set for the card, the
// confirm page and the pass. Index = canonical actionType (0=FEED 1=WATER
// 2=PLAY 3=TOY 4=EXPLORE).
import type { CareAction } from "./care";

export const NEED_ACTIONS = ["feed", "water", "play", "toy", "explore"] as const satisfies readonly CareAction[];

export const NEED_GLYPHS = ["🍯", "💧", "🎾", "🧸", "🧭"] as const;

/** Noun label per need (matches NEED_LABELS on the server). */
export const NEED_LABELS = ["Feed", "Water", "Play", "Toy", "Explore"] as const;

/** Meter tint per need. Feed/Water/Play keep the colors the old three meters used. */
export const NEED_COLORS = ["#ffcf8f", "#8fd6ff", "#ffb0c6", "#c7b3f0", "#8fe0c4"] as const;

export function needIndex(action: string): number {
  return (NEED_ACTIONS as readonly string[]).indexOf(action);
}

export function needGlyph(action: string): string {
  const i = needIndex(action);
  return i >= 0 ? NEED_GLYPHS[i]! : "🐾";
}

export function needLabel(action: string): string {
  const i = needIndex(action);
  return i >= 0 ? NEED_LABELS[i]! : action;
}

/** One need, ready to render. */
export interface NeedReading {
  action: string;
  label: string;
  glyph: string;
  color: string;
  /** 0-100 fullness. */
  pct: number;
  /** Chain-derived time left on this need's own clock, when the API knows it. */
  secondsLeft?: number;
}

/** The per-need shape the API returns on a live pet. */
export interface ApiNeed {
  action?: string;
  label?: string;
  secondsLeft?: number;
  pct?: number;
}

/** The legacy three meters, used as a stand-in when per-need data is absent. */
export interface MeterFallback {
  hunger?: number;
  thirst?: number;
  joy?: number;
}

function clampPct(v: unknown): number {
  const n = typeof v === "number" && Number.isFinite(v) ? v : 0;
  return Math.max(0, Math.min(100, Math.round(n)));
}

/**
 * All five needs, MOST URGENT FIRST, exactly like the wallet card.
 *
 * Prefers the chain-derived per-need payload. Without it the legacy meters
 * stand in the way the server does (feed = hunger, water = thirst, and the
 * three joy needs share the joy meter, which IS their minimum), so a surface
 * can never claim a need is fuller than the pet's own worst one.
 */
export function readNeeds(needs: ApiNeed[] | undefined, fallback: MeterFallback): NeedReading[] {
  const byAction = new Map((needs ?? []).map((n) => [String(n.action ?? ""), n]));
  const dbPct = [fallback.hunger, fallback.thirst, fallback.joy, fallback.joy, fallback.joy];
  const rows: NeedReading[] = NEED_ACTIONS.map((action, i) => {
    const api = byAction.get(action);
    return {
      action,
      label: NEED_LABELS[i]!,
      glyph: NEED_GLYPHS[i]!,
      color: NEED_COLORS[i]!,
      pct: clampPct(api?.pct ?? dbPct[i]),
      ...(typeof api?.secondsLeft === "number" ? { secondsLeft: api.secondsLeft } : {}),
    };
  });
  // Urgency order: real countdowns when we have them, percent otherwise. Sort is
  // stable, so ties keep canonical order.
  const timed = rows.every((r) => typeof r.secondsLeft === "number");
  return rows.slice().sort((a, b) => (timed ? a.secondsLeft! - b.secondsLeft! : a.pct - b.pct));
}
