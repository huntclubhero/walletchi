/**
 * CARE CHIP OVERLAP AUDIT (runner/pet.ts careChipSvg, runner/usdg-front.ts). Local renders only.
 *
 * For every FINAL FORM (forced) plus stages 1, 2 and 3 on a spread of real seeds, every image
 * surface (Apple strip with and without the stats band, iOS 27 poster artwork, Google hero), day and
 * night, and four moods (their props and toys), it finds the scene's FOREGROUND and tests the CARE
 * chip's box (plus a 2 cell margin) against it for every chip width ("5,038", "12,481", "22,482",
 * "199,999"). Foreground is measured, not guessed:
 *   - the pet layer: the real render vs the same render on a bare backdrop (pet.ts _setAuditBarePet),
 *     so the pet, its form parts, accessories, sparkles, z's, cloud, toys, shadow and wordmark all
 *     count;
 *   - the chrome: the stats band (strip/hero with the band vs without, on the bare plate) and the
 *     hero's name and number (with vs without them), so overlays count too;
 *   - the poster's Apple overlays, which our art cannot see: a top band (logo + header row) and a
 *     bottom band (primary fields + footer over the material strip), as fractions of the artwork
 *     height (POSTER_TOP, POSTER_BOTTOM below).
 * Any foreground pixel inside the box, or a box past the image edge, is a FAIL.
 *
 * Writes AUDIT.json (every failure) and one contact sheet per surface (every form and stage, light
 * and dark, widest chip) to --out.
 *
 * Run: npx tsx scripts/care-chip-audit.ts [--out <dir>] [--quick]
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

process.env.LOG_LEVEL ??= "silent";
process.env.DATABASE_URL ??= "postgres://audit:audit@localhost:5432/audit"; // never connected
process.env.TRAITS_V2_ENABLED = "true";

const sharp = (await import("sharp")).default;
const pet = await import("../src/runner/pet.js");
const { FORMS } = await import("../src/runner/forms.js");
const { traitsFor, ACCESSORIES, SHAPES } = await import("../src/runner/traits.js");
const { petName } = await import("../src/runner/names.js");
const { runnerNumber } = await import("../src/runner/theme.js");
type ImageOpts = Parameters<typeof pet.petPassImages>[0];
type HeroOpts = Parameters<typeof pet.petHeroPng>[0];

const args = process.argv.slice(2);
const outIdx = args.indexOf("--out");
const OUT = path.resolve(outIdx >= 0 ? args[outIdx + 1]! : path.join(os.tmpdir(), "care-chip-audit"));
const QUICK = args.includes("--quick");
const surfIdx = args.indexOf("--surface");
const ONLY = surfIdx >= 0 ? args[surfIdx + 1] : undefined;
// --legacy: audit the placement main shipped before this rule (feedb6a): the strip chip with no
// corner reserve, the poster chip at a fixed 60% / 4.5% centred under the pet. The "before" count.
const LEGACY = args.includes("--legacy");
fs.mkdirSync(OUT, { recursive: true });

// The iOS 27 poster overlays (fractions of the artwork height), shared with the renderer
// (pet.ts POSTER_HEADER_BOTTOM / POSTER_FIELDS_TOP). Apple's poster layout puts the primary logo and
// the ONE header field in a top row and the primary fields (up to four) plus the footer on a material
// strip across the bottom. Estimated from the 358x448 pt artwork: the top row is about 30 pt of logo
// plus margins (14%, 63 pt); the bottom is one label + value row of primary fields, the footer line
// and the strip's padding, about 134 pt (30%, so it starts at 70%).
const POSTER_TOP = pet.POSTER_HEADER_BOTTOM;
const POSTER_BOTTOM = pet.POSTER_FIELDS_TOP;
const WIDTHS = ["5,038", "12,481", "22,482", "199,999"];
const MOODS: Array<{ mood: ImageOpts["mood"]; toys: number }> = QUICK
  ? [{ mood: "happy", toys: 3 }]
  : [{ mood: "happy", toys: 3 }, { mood: "sleeping", toys: 0 }, { mood: "sad", toys: 2 }, { mood: "critical", toys: 1 }];
const TODS = ["day", "night"] as const;
const STATS = { alive: 141, total: 1000, pot: "12.4K", burned: "378K" };

// ---- seeds: every accessory and every silhouette shape, from real seeds ----------------------
const seedFor = new Map<string, string>();
for (let i = 1; i <= 6000 && seedFor.size < ACCESSORIES.length + SHAPES.length; i++) {
  const t = traitsFor(String(i));
  const a = `acc:${t.accessory}`;
  const sh = `shape:${t.shape}`;
  if (!seedFor.has(a)) seedFor.set(a, String(i));
  if (!seedFor.has(sh)) seedFor.set(sh, String(i));
}
const STAGE_SEEDS = [...new Set(seedFor.values())];
// Forms: the tallest head prop (Party Hat), a Crown, and a Horns silhouette.
const FORM_SEEDS = [...new Set([seedFor.get("acc:3"), seedFor.get("acc:4"), seedFor.get("shape:2")].filter(Boolean) as string[])];
type Variant = { label: string; stage: 1 | 2 | 3 | 4; form?: string; seeds: string[] };
const VARIANTS: Variant[] = [
  ...([1, 2, 3] as const).map((stage) => ({ label: `stage${stage}`, stage, seeds: QUICK ? STAGE_SEEDS.slice(0, 2) : STAGE_SEEDS })),
  ...FORMS.map((f) => ({ label: f.key, stage: 4 as const, form: f.key, seeds: QUICK ? FORM_SEEDS.slice(0, 1) : FORM_SEEDS })),
];

// ---- surfaces: the size, the chip box and the extra forbidden zones ----------------------------
type Box = { x: number; y: number; w: number; h: number; cell: number };
type Surface = {
  key: "strip-band" | "strip-noband" | "poster" | "hero";
  W: number;
  H: number;
  // The chip box for a width in this scene (the poster's depends on the pet's layout).
  chip: (text: string, o: ImageOpts) => Box;
  // True when the scene's layout depends on the chip (the strip's corner reserve): then each width
  // is rendered with the chip laid out but unpainted (pet.ts _setAuditHideChip).
  perWidth: boolean;
  render: (o: ImageOpts, bare: boolean, extra?: Record<string, unknown>) => Promise<Buffer>;
  zones: Array<{ x: number; y: number; w: number; h: number; why: string }>;
};
const toBox = (b: { x: number; y: number; w: number; h: number; cell: number }): Box =>
  // the painted box: the drop shadow reaches one cell past the pill's right edge
  ({ x: b.x, y: b.y, w: b.w + b.cell, h: b.h, cell: b.cell });
const tag = (bare: boolean, extra?: Record<string, unknown>) => ({ _audit: `${bare ? "bare" : "full"}:${JSON.stringify(extra ?? {})}` });
async function withBare<T>(bare: boolean, run: () => Promise<T>): Promise<T> {
  pet._setAuditBarePet(bare);
  try {
    return await run();
  } finally {
    pet._setAuditBarePet(false);
  }
}
async function hidden<T>(run: () => Promise<T>): Promise<T> {
  pet._setAuditHideChip(true);
  try {
    return await run();
  } finally {
    pet._setAuditHideChip(false);
  }
}
const posterScene = (o: ImageOpts) => ({ mood: o.mood, toys: o.toys, timeOfDay: o.timeOfDay, seed: o.seed, stage: o.stage, shellCap: o.shellCap, form: o.form, hideWordmark: true, groundFrac: 0.5 });
const SURFACES: Surface[] = [
  {
    key: "strip-band", W: 1125, H: 432, perWidth: !LEGACY,
    chip: (t) => toBox(pet.stripChipBox(t, 1125, 432)),
    render: (o, bare, extra) => withBare(bare, async () => (await pet.petPassImages({ ...o, stats: STATS, ...extra, ...tag(bare, extra) } as ImageOpts))["strip@3x.png"]!),
    zones: [],
  },
  {
    key: "strip-noband", W: 1125, H: 432, perWidth: !LEGACY,
    chip: (t) => toBox(pet.stripChipBox(t, 1125, 432)),
    render: (o, bare, extra) => withBare(bare, async () => (await pet.petPassImages({ ...o, ...extra, ...tag(bare, extra) } as ImageOpts))["strip@3x.png"]!),
    zones: [],
  },
  {
    key: "poster", W: 1074, H: 1344, perWidth: false,
    chip: (t, o) => {
      if (LEGACY) return toBox(pet.careChipBox(t, 1074 * 0.5, 1344 * 0.6, 1344 * 0.045, true));
      const at = pet.posterChipPlace(t, 1074, 1344, posterScene(o));
      return toBox(pet.careChipBox(t, at.right, at.top, at.height, true));
    },
    render: (o, bare, extra) => withBare(bare, async () => (await pet.petPosterImages({ ...o, ...extra, ...tag(bare, extra) } as ImageOpts))["artwork@3x.png"]!),
    zones: [
      { x: 0, y: 0, w: 1074, h: Math.round(1344 * POSTER_TOP), why: "Apple top row (logo + header)" },
      { x: 0, y: Math.round(1344 * POSTER_BOTTOM), w: 1074, h: 1344 - Math.round(1344 * POSTER_BOTTOM), why: "Apple bottom fields strip" },
    ],
  },
  {
    key: "hero", W: 2064, H: 672, perWidth: false,
    chip: (t) => toBox(pet.careChipBox(t, 2064 - Math.round(2064 * 0.027), Math.round(672 * 0.2), Math.round(672 * 0.09))),
    render: (o, bare, extra) =>
      withBare(bare, () =>
        pet.petHeroPng({ ...o, name: petName(o.seed ?? "1"), number: runnerNumber(o.seed ?? "1", o.seed ?? "1"), stats: STATS, ...extra, ...tag(bare, extra) } as HeroOpts),
      ),
    zones: [],
  },
];

// ---- masks -----------------------------------------------------------------------------------
type Raw = { data: Buffer; W: number; H: number };
const raw = async (png: Buffer): Promise<Raw> => {
  const { data, info } = await sharp(png).removeAlpha().raw().toBuffer({ resolveWithObject: true });
  return { data, W: info.width, H: info.height };
};
const THRESH = 10;
function diffMask(a: Raw, b: Raw, into: Uint8Array): void {
  for (let i = 0, p = 0; p < a.W * a.H; p++, i += 3) {
    if (Math.abs(a.data[i]! - b.data[i]!) > THRESH || Math.abs(a.data[i + 1]! - b.data[i + 1]!) > THRESH || Math.abs(a.data[i + 2]! - b.data[i + 2]!) > THRESH) into[p] = 1;
  }
}
function hits(mask: Uint8Array, W: number, H: number, box: Box): { count: number; x0: number; y0: number; x1: number; y1: number } {
  const m = box.cell * 2;
  const x0 = Math.max(0, box.x - m), y0 = Math.max(0, box.y - m);
  const x1 = Math.min(W - 1, box.x + box.w + m), y1 = Math.min(H - 1, box.y + box.h + m);
  let count = 0, hx0 = W, hy0 = H, hx1 = -1, hy1 = -1;
  for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) {
    if (mask[y * W + x]) {
      count++;
      if (x < hx0) hx0 = x;
      if (y < hy0) hy0 = y;
      if (x > hx1) hx1 = x;
      if (y > hy1) hy1 = y;
    }
  }
  return { count, x0: hx0, y0: hy0, x1: hx1, y1: hy1 };
}

// Chrome masks depend on the surface, the time of day and (hero) the seed's name, never on the pet.
const chromeCache = new Map<string, Uint8Array>();
async function chromeMask(s: Surface, tod: (typeof TODS)[number], seed: string): Promise<Uint8Array> {
  const key = `${s.key}|${tod}|${s.key === "hero" ? seed : ""}`;
  const hit = chromeCache.get(key);
  if (hit) return hit;
  const mask = new Uint8Array(s.W * s.H);
  const base: ImageOpts = { mood: "happy", toys: 0, timeOfDay: tod, seed };
  if (s.key === "strip-band") {
    const withBand = await raw(await s.render(base, true));
    const noBand = await raw(await SURFACES[1]!.render(base, true));
    diffMask(withBand, noBand, mask);
  } else if (s.key === "hero") {
    const full = await raw(await s.render(base, true));
    const plain = await raw(await withBare(true, () => pet.petHeroPng({ ...base, name: "", number: "", ...tag(true, { plain: 1 }) } as HeroOpts)));
    diffMask(full, plain, mask);
  }
  for (const z of s.zones) for (let y = z.y; y < z.y + z.h; y++) for (let x = z.x; x < z.x + z.w; x++) mask[y * s.W + x] = 1;
  chromeCache.set(key, mask);
  return mask;
}

// ---- the run ---------------------------------------------------------------------------------
type Fail = { surface: string; variant: string; seed: string; tod: string; mood: string; width: string; pixels: number; where: string };
const fails: Fail[] = [];
let configs = 0;
let tests = 0;
const t0 = Date.now();
const RUN = SURFACES.filter((x) => !ONLY || x.key === ONLY);
// Geometry sanity: the box we test is where the chip actually paints (same layout, chip on vs off).
for (const s of LEGACY ? [] : RUN) {
  for (const o of [{ mood: "happy", toys: 3, timeOfDay: "day", seed: FORM_SEEDS[0] ?? "1", stage: 4, form: "butterfly" }, { mood: "happy", toys: 3, timeOfDay: "night", seed: FORM_SEEDS[0] ?? "1", stage: 4, form: "octo" }] as ImageOpts[]) {
    const a = await raw(await s.render(o, true, { careChip: "199,999" }));
    const b = await raw(await hidden(() => s.render(o, true, { careChip: "199,999", _h: 1 })));
    const m = new Uint8Array(s.W * s.H);
    diffMask(a, b, m);
    const box = s.chip("199,999", o);
    let outside = 0, inside = 0;
    for (let y = 0; y < s.H; y++) for (let x = 0; x < s.W; x++) {
      if (!m[y * s.W + x]) continue;
      if (x >= box.x && x < box.x + box.w && y >= box.y && y < box.y + box.h) inside++;
      else outside++;
    }
    console.log(`geometry ${s.key} ${o.form}: ${inside} chip pixels inside the tested box, ${outside} outside`);
    if (outside > 0 || inside === 0) fails.push({ surface: s.key, variant: "geometry", seed: o.seed!, tod: o.timeOfDay!, mood: "-", width: "199,999", pixels: outside, where: "chip paints outside the tested box" });
  }
}
for (const s of RUN) {
  for (const v of VARIANTS) {
    for (const seed of v.seeds) {
      for (const tod of TODS) {
        const chrome = await chromeMask(s, tod, seed);
        for (const { mood, toys } of MOODS) {
          configs++;
          const o: ImageOpts = { mood, toys, timeOfDay: tod, seed, stage: v.stage, ...(v.form ? { form: v.form } : {}) };
          let shared: Uint8Array | null = null;
          for (const width of WIDTHS) {
            tests++;
            let mask: Uint8Array;
            if (s.perWidth) {
              const full = await raw(await hidden(() => s.render(o, false, { careChip: width, _hidden: 1 })));
              const bare = await raw(await hidden(() => s.render(o, true, { careChip: width, _hidden: 1 })));
              mask = Uint8Array.from(chrome);
              diffMask(full, bare, mask);
            } else {
              if (!shared) {
                const full = await raw(await s.render(o, false));
                const bare = await raw(await s.render(o, true));
                shared = Uint8Array.from(chrome);
                diffMask(full, bare, shared);
              }
              mask = shared;
            }
            const box = s.chip(width, o);
            const off = box.x < 0 || box.y < 0 || box.x + box.w > s.W || box.y + box.h > s.H;
            const h = hits(mask, s.W, s.H, box);
            if (off || h.count > 0) {
              fails.push({ surface: s.key, variant: v.label, seed, tod, mood, width, pixels: off ? -1 : h.count, where: off ? "box past the image edge" : `foreground at x ${h.x0}..${h.x1}, y ${h.y0}..${h.y1}` });
            }
          }
        }
      }
    }
    process.stdout.write(`\r${s.key} ${v.label.padEnd(12)} configs ${configs} fails ${fails.length} (${Math.round((Date.now() - t0) / 1000)} s)   `);
  }
}
console.log("");

// ---- contact sheets: every form and stage, light and dark, widest chip -------------------------
const sheetSeed = FORM_SEEDS[0] ?? "1";
for (const s of LEGACY ? [] : RUN) {
  const tileW = s.key === "poster" ? 240 : s.key === "hero" ? 520 : 375;
  const tileH = Math.round((tileW * s.H) / s.W);
  const labelH = 22;
  const cols = 2 * (s.key === "poster" ? 4 : 2);
  const tiles: Array<{ input: Buffer; left: number; top: number }> = [];
  let i = 0;
  for (const v of VARIANTS) {
    for (const tod of TODS) {
      const o: ImageOpts = { mood: "happy", toys: 3, timeOfDay: tod, seed: v.stage === 4 ? sheetSeed : sheetSeed, stage: v.stage, ...(v.form ? { form: v.form } : {}) };
      const png = await s.render(o, false, { careChip: "199,999" });
      const img = await sharp(png).resize(tileW, tileH).png().toBuffer();
      const col = i % cols, row = Math.floor(i / cols);
      const left = col * (tileW + 8), top = row * (tileH + labelH + 8);
      const failed = fails.some((f) => f.surface === s.key && f.variant === v.label && f.tod === tod);
      const label = Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="${tileW}" height="${labelH}"><rect width="100%" height="100%" fill="${failed ? "#7a1010" : "#111"}"/><text x="6" y="16" font-family="Arial" font-size="13" fill="#fff">${v.label} ${tod === "day" ? "light" : "dark"}${failed ? "  FAIL" : ""}</text></svg>`);
      tiles.push({ input: label, left, top }, { input: img, left, top: top + labelH });
      i++;
    }
  }
  const rows = Math.ceil(i / cols);
  const sheet = await sharp({ create: { width: cols * (tileW + 8), height: rows * (tileH + labelH + 8), channels: 3, background: "#000" } }).composite(tiles).png().toBuffer();
  fs.writeFileSync(path.join(OUT, `contact-${s.key}.png`), sheet);
}

const bySurface: Record<string, number> = {};
for (const f of fails) bySurface[f.surface] = (bySurface[f.surface] ?? 0) + 1;
const summary = { configs, tests, fails: fails.length, bySurface, seeds: { stages: STAGE_SEEDS, forms: FORM_SEEDS }, posterZones: { top: POSTER_TOP, bottom: POSTER_BOTTOM }, seconds: Math.round((Date.now() - t0) / 1000) };
fs.writeFileSync(path.join(OUT, `AUDIT${LEGACY ? "-before" : ""}${ONLY ? `-${ONLY}` : ""}.json`), JSON.stringify({ summary, fails }, null, 1));
console.log(JSON.stringify(summary));
const groups = new Map<string, number>();
for (const f of fails) groups.set(`${f.surface} ${f.variant} ${f.width}`, (groups.get(`${f.surface} ${f.variant} ${f.width}`) ?? 0) + 1);
for (const [k, n] of [...groups].slice(0, 60)) console.log(`  FAIL ${k} x${n}`);
