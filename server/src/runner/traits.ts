// WALLETCHI generative traits. 2000 PROVABLY-UNIQUE pets, deterministic from
// tokenId, cute + colourful + fun + cool. All drawn in code (pixel art), applied
// across every state (egg, moods, critical, memorial, social cards).
//
// TWO GENERATIONS live here, switched by config.TRAITS_V2_ENABLED:
//
// v1 (flag OFF, today): a base combo over body(16) x belly(2) x eyes(6) x
// cheeks(4) x marking(6) x accent(5) = 23,040, mapped by an affine permutation
// idx=(id*9973+12345) mod N (gcd=1, a bijection). Provably unique, but only 284
// distinct high-visibility looks: 94% of pets read the same across the room.
//
// v2 (flag ON): uniqueness lives in the VISIBLE axes. The heavy subspace is
// hue(16) x pattern(8) x eyes(6) x shape(4) = 3,072, mapped by an affine
// permutation over Z_3072 with a multiplier coprime to 3,072 (a bijection), so
// every one of tokenIds 1..2000 differs from every other in at least one
// across-the-room trait (hue, pattern, eyes, or silhouette). The light axes
// (belly, cheeks, marking, accent) come from a SEPARATE deterministic hash
// (repeats allowed): they add per-pet flavor without affecting the heavy-tuple
// uniqueness guarantee. Rare accessories are a third independent hash on top.
// Because the heavy tuple is a component of the full tuple, distinct heavy
// tuples force distinct full tuples too. Everything stays deterministic from
// tokenId and pre-mint safe.

import { config } from "../config.js";

export interface BodyPalette {
  name: string;
  O: string; // outline
  B: string; // body
  L: string; // belly (cream variant)
}

// 16 vivid, joyful hues (no muted tones): the "colourful" half of the vibe bar.
export const BODY_PALETTES: BodyPalette[] = [
  { name: "Salmon", O: "#C25A48", B: "#F98F76", L: "#FFD3BE" },
  { name: "Teal", O: "#12807C", B: "#3FD1CB", L: "#BEF6F1" },
  { name: "Lavender", O: "#6A4FA3", B: "#A98BEA", L: "#E7DBFB" },
  { name: "Mint", O: "#2E9B5B", B: "#6FE39B", L: "#CFF7DC" },
  { name: "Butter", O: "#CE9E17", B: "#FFDB4E", L: "#FFF1AE" },
  { name: "Coral", O: "#C43C5A", B: "#FF7C95", L: "#FFC9D3" },
  { name: "Sky", O: "#2472C8", B: "#63B8F5", L: "#CCE8FF" },
  { name: "Rose", O: "#B23A82", B: "#FF77BE", L: "#FFCBEA" },
  { name: "Sage", O: "#6F9142", B: "#AED47C", L: "#E4F2C7" },
  { name: "Periwinkle", O: "#4551BE", B: "#8E97F4", L: "#D7DCFD" },
  { name: "Tangerine", O: "#CE6415", B: "#FF9F3D", L: "#FFDBAF" },
  { name: "Bubblegum", O: "#C63CA4", B: "#FF86E0", L: "#FFCBF5" },
  { name: "Lime", O: "#72A814", B: "#BCEE49", L: "#EAFAB8" },
  { name: "Aqua", O: "#159AA8", B: "#4FE6E2", L: "#C4F9F6" },
  { name: "Grape", O: "#7C3AB8", B: "#BF6DF2", L: "#EBD1FC" },
  { name: "Cherry", O: "#B92838", B: "#FF5D6F", L: "#FFC4CB" },
];

export const BELLY_STYLES = ["Cream", "Pale"] as const;
export const EYE_STYLES = ["Round", "Oval", "Sleepy", "Sparkle", "Big", "Beady"] as const;
export const CHEEK_STYLES = ["None", "Pink", "Coral", "Peach"] as const;
export const MARKINGS = ["None", "Spots", "Stripe", "Belly Patch", "Star", "Freckles"] as const;
export const ACCENTS = ["Sprout", "Ears", "Antenna", "Fin", "Tuft"] as const;
// v2 high-visibility axes, drawn in the same chunky cell language. PATTERN tints
// the body via darker/lighter shades of its own hue so every pattern reads on
// every hue; SHAPE extends the silhouette (soft nubs / horns / a side tail).
export const PATTERNS = ["Solid", "Stripes", "Spots", "Patch", "Star", "Two-Tone", "Saddle", "Mask"] as const;
export const SHAPES = ["Round", "Ears", "Horns", "Tail"] as const;
// Accessories: v2 appends three drawn commons (Scarf, Leaf, Ribbon) AFTER the v1
// entries, so indices 0..5 keep their exact v1 meaning (flag-off byte-identical).
export const ACCESSORIES = [
  "None", "Bow", "Shades", "Party Hat", "Crown", "Halo", "Scarf", "Leaf", "Ribbon",
] as const;

// v1 base radices (order fixed: the mixed-radix decode + uniqueness proof depend on it).
const RADICES = [
  BODY_PALETTES.length, // 16
  BELLY_STYLES.length, //  2
  EYE_STYLES.length, //    6
  CHEEK_STYLES.length, //  4
  MARKINGS.length, //      6
  ACCENTS.length, //       5
] as const;

export const TOTAL_BASE_COMBOS = RADICES.reduce((a, b) => a * b, 1); // 23,040

// A large multiplier coprime to N = 23,040 = 2^9 * 3^2 * 5. 9973 is prime and not
// 2/3/5, so gcd(9973, N) = 1: the map id -> (id*9973 + 12345) mod N is a bijection.
const PERM_C = 9973;
const PERM_K = 12345;

// v2 heavy subspace: hue x pattern x eyes x shape (decode order fixed).
const HEAVY_RADICES = [
  BODY_PALETTES.length, // 16
  PATTERNS.length, //       8
  EYE_STYLES.length, //     6
  SHAPES.length, //         4
] as const;
export const TOTAL_HEAVY_COMBOS = HEAVY_RADICES.reduce((a, b) => a * b, 1); // 3,072
// v2 light subspace (repeats allowed): belly x cheeks x marking x accent.
const LIGHT_RADICES = [
  BELLY_STYLES.length, //   2
  CHEEK_STYLES.length, //   4
  MARKINGS.length, //       6
  ACCENTS.length, //        5
] as const;
const TOTAL_LIGHT_COMBOS = LIGHT_RADICES.reduce((a, b) => a * b, 1); // 240

// A multiplier coprime to N2 = 3,072 = 2^10 * 3. 1897 is odd (coprime to 2) and
// 1897 mod 3 = 1 (coprime to 3), so gcd(1897, 3,072) = 1 and id -> (id*1897 + K)
// mod N2 is a bijection on Z_3072. 1897 ~= 0.618 * 3072 (near the golden ratio),
// so consecutive ids scatter across the space instead of marching in a line.
const HEAVY_PERM_C = 1897;
const HEAVY_PERM_K = 421;

// Robust numeric seed: the integer tokenId when it is one (the uniqueness domain),
// else a stable hash of the string (e.g. a pre-mint serial's egg).
function seedOf(id: string | number): number {
  if (typeof id === "number") return Math.abs(Math.floor(id));
  const trimmed = id.trim();
  const n = parseInt(trimmed, 10);
  if (Number.isFinite(n) && String(n) === trimmed) return Math.abs(n);
  let x = 2166136261 >>> 0;
  for (let i = 0; i < trimmed.length; i++) {
    x ^= trimmed.charCodeAt(i);
    x = Math.imul(x, 16777619) >>> 0;
  }
  return x % TOTAL_BASE_COMBOS;
}

// A separate integer hash for the accessory roll (independent of the base combo).
function accessoryRoll(seed: number): number {
  let x = (seed ^ 0x9e3779b9) >>> 0;
  x = Math.imul(x ^ (x >>> 16), 0x45d9f3b) >>> 0;
  x = Math.imul(x ^ (x >>> 16), 0x45d9f3b) >>> 0;
  x = (x ^ (x >>> 16)) >>> 0;
  return x / 0xffffffff;
}

// v1 accessory distribution: None ~85.6%, then the rare tiers.
function accessoryIndex(seed: number): number {
  const r = accessoryRoll(seed);
  if (r < 0.005) return 5; // Halo (0.5%, grail)
  if (r < 0.015) return 4; // Crown (1%, grail)
  if (r < 0.035) return 2; // Shades (2%, rare)
  if (r < 0.075) return 3; // Party Hat (4%, rare)
  if (r < 0.15) return 1; //  Bow (7.5%, uncommon)
  return 0; //               None (~85%)
}

// v2 accessory distribution: ~50% of pets wear something. The rare tier is
// unchanged in weight; four drawn commons fill the rest up to the 50% line.
function accessoryIndexV2(seed: number): number {
  const r = accessoryRoll(seed);
  if (r < 0.005) return 5; // Halo (0.5%, grail)
  if (r < 0.015) return 4; // Crown (1%, grail)
  if (r < 0.035) return 2; // Shades (2%, rare)
  if (r < 0.075) return 3; // Party Hat (4%, rare)
  if (r < 0.185) return 1; // Bow (11%, common)
  if (r < 0.295) return 6; // Scarf (11%, common)
  if (r < 0.395) return 8; // Ribbon (10%, common)
  if (r < 0.5) return 7; //   Leaf (10.5%, common)
  return 0; //               None (50%)
}

// A distinct hash for the v2 light axes (independent of the heavy affine map and
// the accessory roll), so belly/cheeks/marking/accent vary without touching the
// heavy-tuple uniqueness guarantee.
function lightHash(seed: number): number {
  let x = (seed ^ 0x85ebca6b) >>> 0;
  x = Math.imul(x ^ (x >>> 15), 0xc2b2ae35) >>> 0;
  x = Math.imul(x ^ (x >>> 13), 0x27d4eb2f) >>> 0;
  x = (x ^ (x >>> 16)) >>> 0;
  return x;
}

export interface PetTraits {
  body: number;
  belly: number;
  eyes: number;
  cheeks: number;
  marking: number;
  accent: number;
  pattern: number; // v2 body pattern (0 = Solid; always 0 under v1)
  shape: number; // v2 silhouette (0 = Round; always 0 under v1)
  accessory: number;
  palette: BodyPalette;
  names: {
    body: string;
    belly: string;
    eyes: string;
    cheeks: string;
    marking: string;
    accent: string;
    pattern: string;
    shape: string;
    accessory: string;
    rarity: string;
  };
}

function rarityOf(accessory: number): string {
  if (accessory === 5 || accessory === 4) return "Grail"; // Halo, Crown
  if (accessory === 2 || accessory === 3) return "Rare"; // Shades, Party Hat
  // Bow + the v2 drawn commons (Scarf, Leaf, Ribbon) are the Uncommon tier.
  if (accessory === 1 || accessory === 6 || accessory === 7 || accessory === 8) return "Uncommon";
  return "Common"; // None
}

function namesFor(t: Omit<PetTraits, "palette" | "names">): PetTraits["names"] {
  return {
    body: BODY_PALETTES[t.body]!.name,
    belly: BELLY_STYLES[t.belly]!,
    eyes: EYE_STYLES[t.eyes]!,
    cheeks: CHEEK_STYLES[t.cheeks]!,
    marking: MARKINGS[t.marking]!,
    accent: ACCENTS[t.accent]!,
    pattern: PATTERNS[t.pattern]!,
    shape: SHAPES[t.shape]!,
    accessory: ACCESSORIES[t.accessory]!,
    rarity: rarityOf(t.accessory),
  };
}

// v1 (flag OFF): the exact mapping shipped today. pattern/shape are pinned to 0
// (Solid / Round), so the renderer draws the original silhouette with no overlay.
function traitsV1(seed: number): PetTraits {
  let idx = (seed * PERM_C + PERM_K) % TOTAL_BASE_COMBOS;
  const body = idx % RADICES[0]!; idx = Math.floor(idx / RADICES[0]!);
  const belly = idx % RADICES[1]!; idx = Math.floor(idx / RADICES[1]!);
  const eyes = idx % RADICES[2]!; idx = Math.floor(idx / RADICES[2]!);
  const cheeks = idx % RADICES[3]!; idx = Math.floor(idx / RADICES[3]!);
  const marking = idx % RADICES[4]!; idx = Math.floor(idx / RADICES[4]!);
  const accent = idx % RADICES[5]!;
  const accessory = accessoryIndex(seed);
  const core = { body, belly, eyes, cheeks, marking, accent, pattern: 0, shape: 0, accessory };
  return { ...core, palette: BODY_PALETTES[body]!, names: namesFor(core) };
}

// v2 (flag ON): heavy tuple by affine bijection over Z_3072, light axes by a
// separate hash. Distinct ids -> distinct heavy tuples -> distinct full tuples.
function traitsV2(seed: number): PetTraits {
  let h = (seed * HEAVY_PERM_C + HEAVY_PERM_K) % TOTAL_HEAVY_COMBOS;
  const body = h % HEAVY_RADICES[0]!; h = Math.floor(h / HEAVY_RADICES[0]!);
  const pattern = h % HEAVY_RADICES[1]!; h = Math.floor(h / HEAVY_RADICES[1]!);
  const eyes = h % HEAVY_RADICES[2]!; h = Math.floor(h / HEAVY_RADICES[2]!);
  const shape = h % HEAVY_RADICES[3]!;
  let l = lightHash(seed) % TOTAL_LIGHT_COMBOS;
  const belly = l % LIGHT_RADICES[0]!; l = Math.floor(l / LIGHT_RADICES[0]!);
  const cheeks = l % LIGHT_RADICES[1]!; l = Math.floor(l / LIGHT_RADICES[1]!);
  const marking = l % LIGHT_RADICES[2]!; l = Math.floor(l / LIGHT_RADICES[2]!);
  const accent = l % LIGHT_RADICES[3]!;
  const accessory = accessoryIndexV2(seed);
  const core = { body, belly, eyes, cheeks, marking, accent, pattern, shape, accessory };
  return { ...core, palette: BODY_PALETTES[body]!, names: namesFor(core) };
}

// Deterministic traits for a tokenId (or any stable id string). The generation
// switches on the flag; both paths are pure functions of the id, pre-mint safe.
export function traitsFor(id: string | number): PetTraits {
  const seed = seedOf(id);
  return config.TRAITS_V2_ENABLED ? traitsV2(seed) : traitsV1(seed);
}

// ERC-721 attributes for the metadata endpoint. Pattern + Shape appear only under
// v2 (flag OFF keeps the exact 8-attribute set shipped today). Stage is appended
// by the metadata route, which has the runner + clock to derive it.
export function traitAttributes(id: string | number): { trait_type: string; value: string }[] {
  const t = traitsFor(id);
  const attrs = [
    { trait_type: "Body", value: t.names.body },
    { trait_type: "Belly", value: t.names.belly },
    { trait_type: "Eyes", value: t.names.eyes },
    { trait_type: "Cheeks", value: t.names.cheeks },
    { trait_type: "Marking", value: t.names.marking },
    { trait_type: "Accent", value: t.names.accent },
    { trait_type: "Accessory", value: t.names.accessory },
    { trait_type: "Rarity", value: t.names.rarity },
  ];
  if (config.TRAITS_V2_ENABLED) {
    // Keep names stable + title-cased; insert next to the other look axes.
    attrs.splice(6, 0, { trait_type: "Pattern", value: t.names.pattern });
    attrs.splice(7, 0, { trait_type: "Shape", value: t.names.shape });
  }
  return attrs;
}
