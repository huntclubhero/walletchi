// Centralized WALLETCHI user-facing copy + palette. Every product name lives here
// so a rename is a one-file change (the mechanics never reference these strings).
// WALLETCHI: a virtual pixel pet living in your wallet, soft palette
// (river blues/teals, salmon pink, dusk lavender).
import type { PetMood } from "./pet.js";
export const RUNNER_THEME = {
  gameName: "WALLETCHI",
  collection: "WALLETCHI",
  nftName: "WALLETCHI", // metadata renders "WALLETCHI #n"
  petLabel: "PET", // pass aux label ("PET No.")
  description: "WALLETCHI, a virtual pet that lives in your wallet",
  // changeMessage on the STATUS field: %@ is replaced with the fresh line.
  statusChangeMessage: "%@",
  tagline: "A pet NFT that is its own Apple Wallet or Google Wallet pass.",
} as const;

// The Testnet Experience label for the pass back + emails. Said once per surface, and only
// when the build runs on testnet (callers gate on config.ROBINHOOD_NETWORK), so a mainnet
// build can never carry it and a testnet build can never omit it.
export const TESTNET_COPY = {
  label: "TESTNET EXPERIENCE",
  body: "Runs on Robinhood Chain testnet. Every token here is fake and has no value. This pet is a live demo of the wallet pass standard for NFTs.",
} as const;

// Gentle pet-flavor idle lines (no legacy game brand). The idle engine narrates
// one of these on a flavor tick now that the runnable game is retired.
export const PET_IDLE_EVENTS = [
  "Your pet napped in a sunbeam",
  "Your pet chased a little butterfly",
  "Your pet rolled in the soft grass",
  "Your pet watched the clouds drift by",
  "Your pet found a shiny pebble",
  "Your pet stretched and yawned",
  "Your pet blew a tiny bubble",
  "Your pet did a happy wiggle",
  "Your pet dozed by the window",
  "Your pet sniffed a wildflower",
  "Your pet booped its favorite toy",
  "Your pet hummed a little tune",
] as const;

// Memorial + victory copy (the emotional peak moments). Kept here so the wording
// is one-file swappable. No em dashes anywhere.
export const MEMORIAL_COPY = {
  epitaph: "Cared for, then not. One of the colony, and the only one exactly like it.",
  backNote:
    "This pet has passed on. Its pass stays with you as a keepsake. Its final state lives forever on-chain.",
} as const;

export const VICTORY_COPY = {
  banner: "LAST ONE STANDING",
  note: "Every other pet in the colony is a memorial. This one is not. It took the whole Pot.",
} as const;

// Evolution stage names (indexed by stage 0..3) + the celebratory copy for an
// evolution moment. Kept here so the wording is one-file swappable. The pet
// EVOLVES into GROWN then PRIME; the hatch is its own separate moment.
export const STAGE_NAMES = ["Egg", "Hatchling", "Grown", "Prime"] as const;

export const EVOLUTION_COPY = {
  pushHeader: "Evolution!",
  // The freshest-event line shown on the pass STATUS field when a pet evolves.
  eventLine(stage: number): string {
    const name = (STAGE_NAMES[stage] ?? "new").toUpperCase();
    return `Your pet evolved! Say hello to its ${name} form.`;
  },
  // The care-confirm page copy when a care action IS the evolution moment.
  confirmTitle: "It evolved!",
  confirmBody(stage: number): string {
    const name = (STAGE_NAMES[stage] ?? "new").toUpperCase();
    return `Your pet shimmered, stretched, and grew. Say hello to its ${name} form.`;
  },
  // The banner line on the shareable evolved social card.
  cardBanner(stage: number): string {
    return `EVOLVED TO ${(STAGE_NAMES[stage] ?? "NEW").toUpperCase()}`;
  },
} as const;

// Soft pixel-pet palette (river blues/teals, salmon pink). Kept separate from the
// legacy card COLORS so the card art stays black-and-gold and the pet stays soft.
export const RIVER_COLORS = {
  riverDeep: "#0E2A3A", // deep river blue
  river: "#15505F", // teal water
  riverLight: "#2E7D8A", // teal highlight
  foam: "#EAF3F5", // light foam / foreground text
  foamDim: "#B7D2DA", // secondary text
  foamMuted: "#7FA4AE", // labels / tertiary
  salmon: "#F98F76", // salmon pink accent (fish body)
  fishLight: "#FFC0A6", // fish highlight
  fishDeep: "#D45D48", // fish shadow
  bear: "#9C6B41", // warm brown fuzzy bear toy
  bearLight: "#C08A55", // bear highlight
  bearDark: "#5C3A22", // bear shadow
  sky: "#6B5B95", // dusk lavender
} as const;

// Explicit pass STATUS + per-status pass colors. The pass front's background,
// label tint, and STATUS word all derive from the same mood the scene art uses,
// so the artwork, the word, and the color always agree. Colors are "rgb(r,g,b)"
// strings because pass.json wants that form. Every ground is dark enough that
// the foam foreground stays legible.
export interface StatusTheme {
  status: string; // short uppercase status word for the pass field
  background: string;
  foreground: string;
  labelColor: string;
}

const FOAM_FG = "rgb(234,243,245)";

export const STATUS_THEMES: Record<PetMood, StatusTheme> = {
  egg: { status: "EGG", background: "rgb(14,42,58)", foreground: FOAM_FG, labelColor: "rgb(249,143,118)" }, // brand deep river
  happy: { status: "HAPPY", background: "rgb(15,74,62)", foreground: FOAM_FG, labelColor: "rgb(146,226,196)" }, // teal-green
  hungry: { status: "HUNGRY", background: "rgb(104,62,14)", foreground: FOAM_FG, labelColor: "rgb(255,204,138)" }, // warm amber
  thirsty: { status: "THIRSTY", background: "rgb(15,55,102)", foreground: FOAM_FG, labelColor: "rgb(146,199,255)" }, // blue
  sleeping: { status: "SLEEPING", background: "rgb(32,28,80)", foreground: FOAM_FG, labelColor: "rgb(177,171,240)" }, // deep indigo
  sad: { status: "SAD", background: "rgb(56,66,82)", foreground: FOAM_FG, labelColor: "rgb(197,208,222)" }, // muted slate; five needs: toy/explore deficits land here (joy = weakest of play/toy/explore)
  sick: { status: "SICK", background: "rgb(43,68,48)", foreground: FOAM_FG, labelColor: "rgb(168,213,160)" }, // mossy (matches the sick tint)
  critical: { status: "CRITICAL", background: "rgb(122,34,24)", foreground: FOAM_FG, labelColor: "rgb(255,177,153)" }, // urgent red-orange
  gone: { status: "GONE", background: "rgb(43,39,58)", foreground: FOAM_FG, labelColor: "rgb(198,187,216)" }, // memorial grey-lavender
} as const;

// A season winner keeps the healthy teal ground with a gold label tint.
export const WINNER_STATUS_THEME: StatusTheme = {
  status: "WINNER",
  background: "rgb(15,74,62)",
  foreground: FOAM_FG,
  labelColor: "rgb(244,197,66)",
};

export function statusThemeFor(mood: PetMood, won: boolean): StatusTheme {
  return won ? WINNER_STATUS_THEME : STATUS_THEMES[mood];
}

// tokenId / serial -> "No. 0042" style pet number (label applied by caller).
export function runnerNumber(tokenId: string | null, serial: string): string {
  if (tokenId) return `No. ${tokenId.padStart(4, "0")}`;
  return `No. ${serial.slice(0, 8).toUpperCase()}`;
}

// Time of day drives the idle river scene sky tint.
export type TimeOfDay = "dawn" | "day" | "dusk" | "night";

export function timeOfDayFor(date: Date): TimeOfDay {
  const h = date.getHours();
  if (h >= 5 && h < 9) return "dawn";
  if (h >= 9 && h < 17) return "day";
  if (h >= 17 && h < 21) return "dusk";
  return "night";
}

export function skyStops(t: TimeOfDay): { top: string; bottom: string } {
  switch (t) {
    case "dawn":
      return { top: "#5B6B9E", bottom: "#E7A98C" };
    case "day":
      return { top: "#5FA8D3", bottom: "#BFE6F2" };
    case "dusk":
      return { top: "#3E3A63", bottom: "#E0956F" };
    case "night":
      return { top: "#0C1430", bottom: "#26325C" };
  }
}
