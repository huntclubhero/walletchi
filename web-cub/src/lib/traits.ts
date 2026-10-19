// Client-safe replica of the server trait decoder (server/src/runner/traits.ts). Deterministic
// from tokenId via the same affine permutation + mixed-radix decode + accessory roll, so the
// traits shown on the site are provably identical to the server render and metadata. Kept in sync
// with the server; the axis orders and constants below must match exactly.

export const BODY_NAMES = [
  "Salmon", "Teal", "Lavender", "Mint", "Butter", "Coral", "Sky", "Rose",
  "Sage", "Periwinkle", "Tangerine", "Bubblegum", "Lime", "Aqua", "Grape", "Cherry",
];
const BELLY_STYLES = ["Cream", "Pale"];
const EYE_STYLES = ["Round", "Oval", "Sleepy", "Sparkle", "Big", "Beady"];
const CHEEK_STYLES = ["None", "Pink", "Coral", "Peach"];
const MARKINGS = ["None", "Spots", "Stripe", "Belly Patch", "Star", "Freckles"];
const ACCENTS = ["Sprout", "Ears", "Antenna", "Fin", "Tuft"];
const ACCESSORIES = ["None", "Bow", "Shades", "Party Hat", "Crown", "Halo"];

const RADICES = [16, 2, 6, 4, 6, 5];
const TOTAL_BASE_COMBOS = 23040;
const PERM_C = 9973;
const PERM_K = 12345;

function seedOf(id: string | number): number {
  if (typeof id === "number") return Math.abs(Math.floor(id));
  const t = String(id).trim();
  const n = parseInt(t, 10);
  if (Number.isFinite(n) && String(n) === t) return Math.abs(n);
  let x = 2166136261 >>> 0;
  for (let i = 0; i < t.length; i++) {
    x ^= t.charCodeAt(i);
    x = Math.imul(x, 16777619) >>> 0;
  }
  return x % TOTAL_BASE_COMBOS;
}

function accessoryIndex(seed: number): number {
  let x = (seed ^ 0x9e3779b9) >>> 0;
  x = Math.imul(x ^ (x >>> 16), 0x45d9f3b) >>> 0;
  x = Math.imul(x ^ (x >>> 16), 0x45d9f3b) >>> 0;
  x = (x ^ (x >>> 16)) >>> 0;
  const r = x / 0xffffffff;
  if (r < 0.005) return 5; // Halo
  if (r < 0.015) return 4; // Crown
  if (r < 0.035) return 2; // Shades
  if (r < 0.075) return 3; // Party Hat
  if (r < 0.15) return 1; // Bow
  return 0; // None
}

function rarityOf(accessory: number): string {
  if (accessory === 5 || accessory === 4) return "Grail";
  if (accessory === 2 || accessory === 3) return "Rare";
  if (accessory === 1) return "Uncommon";
  return "Common";
}

export interface TraitName {
  trait: string;
  value: string;
}

/** The 8 generative traits for a tokenId, in the same order as the metadata attributes. */
export function traitsFor(id: string | number): TraitName[] {
  const seed = seedOf(id);
  let idx = (seed * PERM_C + PERM_K) % TOTAL_BASE_COMBOS;
  const body = idx % RADICES[0];
  idx = Math.floor(idx / RADICES[0]);
  const belly = idx % RADICES[1];
  idx = Math.floor(idx / RADICES[1]);
  const eyes = idx % RADICES[2];
  idx = Math.floor(idx / RADICES[2]);
  const cheeks = idx % RADICES[3];
  idx = Math.floor(idx / RADICES[3]);
  const marking = idx % RADICES[4];
  idx = Math.floor(idx / RADICES[4]);
  const accent = idx % RADICES[5];
  const accessory = accessoryIndex(seed);
  return [
    { trait: "Body", value: BODY_NAMES[body] },
    { trait: "Eyes", value: EYE_STYLES[eyes] },
    { trait: "Cheeks", value: CHEEK_STYLES[cheeks] },
    { trait: "Marking", value: MARKINGS[marking] },
    { trait: "Accent", value: ACCENTS[accent] },
    { trait: "Belly", value: BELLY_STYLES[belly] },
    { trait: "Accessory", value: ACCESSORIES[accessory] },
    { trait: "Rarity", value: rarityOf(accessory) },
  ];
}
