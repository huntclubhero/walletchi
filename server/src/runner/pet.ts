import sharp from "sharp";
import {
  RUNNER_THEME,
  RIVER_COLORS as C,
  MEMORIAL_COPY,
  VICTORY_COPY,
  EVOLUTION_COPY,
  skyStops,
  timeOfDayFor,
  type TimeOfDay,
} from "./theme.js";
import { traitsFor, type PetTraits } from "./traits.js";
import type { Stage } from "./stage.js";

// WALLETCHI pixel pet. Chunky modern-retro LCD-pet energy in the soft palette: a
// round salmon blob with big eyes and tiny feet. Drawn from small grids so it
// reads crisply as pixel art. Moods drive the whole card-front scene.

export type PetMood =
  | "egg"
  | "happy"
  | "hungry"
  | "thirsty"
  | "sad"
  | "sleeping"
  | "sick"
  | "critical"
  | "gone";

export interface PetSceneOpts {
  mood: PetMood;
  timeOfDay?: TimeOfDay;
  toys?: number; // 0..3, accumulates ball -> duck -> crown
  label?: string; // short pet id (e.g. "0042"), engraved on the memorial headstone
  seed?: string; // tokenId (or serial) -> deterministic generative traits
  traits?: PetTraits; // precomputed traits (overrides seed)
  // Evolution stage (v2). Undefined / 2 render today's GROWN size; 1 shrinks the
  // hatchling, 3 grows PRIME with its crest + aura. Egg/memorial ignore it.
  stage?: Stage;
  shellCap?: boolean; // day-one hatchling wears a cracked eggshell cap
  // Drop the in-scene wordmark. The bare pass strip keeps it (a screenshot of the
  // strip alone has to trace back to the mint), but the social card and the square
  // portrait already print the mark in their own chrome, so a second one inside the
  // art window is just a duplicate sitting on the water.
  hideWordmark?: boolean;
}

type Pal = Record<string, string>;

// The per-pet colour map (body outline/body/belly + fixed eye colours + egg tint).
// Belly "Pale" swaps the cream belly for a near-white one; the egg shell/band are
// tinted by the body hue so even un-hatched pets hint the creature inside.
function palFor(traits: PetTraits): Pal {
  const p = traits.palette;
  const belly = traits.belly === 1 ? "#FBF3EC" : p.L;
  return {
    O: p.O,
    B: p.B,
    L: belly,
    W: "#FFFFFF",
    K: "#2A2320",
    P: p.L, // egg cream (tinted)
    Q: p.B, // egg band (body hue)
    o: p.O, // egg outline
  };
}

// A tucked-in wordmark so any screenshot of the strip traces back to the mint.
// Subtle: small, low-opacity, bottom-right.
// baselineY lifts the mark off the bottom edge when something else owns that
// row (the stats HUD band), so the two never sit on top of each other.
function wordmark(w: number, h: number, opacity = 0.42, baselineY?: number): string {
  const fs = Math.max(8, Math.round(h * 0.075));
  const y = baselineY ?? h - fs * 0.5;
  return `<text x="${w - fs * 0.5}" y="${y}" text-anchor="end" font-family="Arial, Helvetica, sans-serif" font-size="${fs}" font-weight="800" letter-spacing="0.4" fill="${C.foam}" fill-opacity="${opacity}">${RUNNER_THEME.gameName}</text>`;
}

const PAL: Record<string, string> = {
  O: "#C25A48", // outline (deep salmon)
  B: "#F98F76", // body (salmon)
  L: "#FFCBB0", // belly light
  W: "#FFFFFF", // eye white
  K: "#2A2320", // pupil / dark
  P: "#F1DEB6", // egg cream
  Q: "#CBAE78", // egg band
  o: "#B98A5C", // egg outline
};

// Round blob body (14 wide x 13 tall). Face is drawn on top per mood.
const BODY = [
  "....OOOOOO....",
  "..OOBBBBBBOO..",
  ".OBBBBBBBBBBO.",
  "OBBBBBBBBBBBBO",
  "OBBBBBBBBBBBBO",
  "OBBBBBBBBBBBBO",
  "OBBBBBBBBBBBBO",
  ".OBBBBBBBBBBO.",
  ".OBBBLLLLBBBO.",
  "..OBBLLLLBBO..",
  "..OOBBBBBBOO..",
  "...BB....BB...",
  "...OO....OO...",
];

const EGG = [
  "....QQQQ....",
  "..QPPPPPPQ..",
  ".QPPPPPPPPQ.",
  "QPPPPPPPPPPQ",
  "QPPQQPPQQPPQ",
  "QPPPPPPPPPPQ",
  "oPPQQPPQQPPo",
  "oPPPPPPPPPPo",
  ".oPPPPPPPPo.",
  "..oPPPPPPo..",
  "...oooooo...",
];

function renderGrid(grid: string[], ox: number, oy: number, cell: number, pal: Pal = PAL): string {
  let out = "";
  for (let r = 0; r < grid.length; r++) {
    const row = grid[r]!;
    for (let c = 0; c < row.length; c++) {
      const color = pal[row[c]!];
      if (color) out += `<rect x="${ox + c * cell}" y="${oy + r * cell}" width="${cell + 0.6}" height="${cell + 0.6}" fill="${color}"/>`;
    }
  }
  return out;
}

// Render a grid as a single-color silhouette (used for the memorial spirit).
function renderGridTinted(grid: string[], ox: number, oy: number, cell: number, fill: string): string {
  let out = "";
  for (let r = 0; r < grid.length; r++) {
    const row = grid[r]!;
    for (let c = 0; c < row.length; c++) {
      if (row[c] !== ".") out += `<rect x="${ox + c * cell}" y="${oy + r * cell}" width="${cell + 0.6}" height="${cell + 0.6}" fill="${fill}"/>`;
    }
  }
  return out;
}

// A single pixel at grid coords (col,row) relative to the pet origin.
function px(ox: number, oy: number, cell: number, col: number, row: number, fill: string, span = 1): string {
  return `<rect x="${ox + col * cell}" y="${oy + row * cell}" width="${cell * span + 0.6}" height="${cell + 0.6}" fill="${fill}"/>`;
}

// Blend two #RRGGBB colours (t = 0 keeps a, 1 keeps b). Used to derive pattern
// shades from the pet's own hue so a pattern reads clearly on every body colour.
function hexMix(a: string, b: string, t: number): string {
  const pa = parseInt(a.slice(1), 16), pb = parseInt(b.slice(1), 16);
  const mix = (sh: number) => {
    const ca = (pa >> sh) & 255, cb = (pb >> sh) & 255;
    return Math.round(ca + (cb - ca) * t);
  };
  return `#${((1 << 24) | (mix(16) << 16) | (mix(8) << 8) | mix(0)).toString(16).slice(1)}`;
}

// True only where the BODY grid is a body-fill cell, so pattern pixels stay
// inside the silhouette (never on the outline, the cream belly, or the gaps).
function bodyIsFill(col: number, row: number): boolean {
  return (BODY[row]?.[col] ?? ".") === "B";
}

// Trait: v2 body PATTERN. Chunky overlay on the body fill in darker/lighter
// shades of the hue, clipped to the silhouette. Composes under the face,
// markings, and accessories (drawn after the body, before the face).
function patternMarkup(traits: PetTraits | undefined, ox: number, oy: number, cell: number, pal: Pal): string {
  const pat = traits?.pattern ?? 0;
  if (pat === 0) return ""; // Solid
  const PD = hexMix(pal.B!, pal.O!, 0.68); // pattern dark (toward the outline)
  const PL = hexMix(pal.B!, "#FFFFFF", 0.5); // pattern light
  const cells: Array<[number, number, string]> = [];
  const put = (c: number, r: number, col: string) => { if (bodyIsFill(c, r)) cells.push([c, r, col]); };
  const band = (rows: number[], col: string) => { for (const r of rows) for (let c = 1; c <= 12; c++) put(c, r, col); };
  switch (pat) {
    case 1: // Stripes: three vertical dark bands down the body
      for (let r = 1; r <= 10; r++) for (const c of [3, 6, 9]) put(c, r, PD);
      break;
    case 2: // Spots: dark dabs scattered over the body
      for (const [c, r] of [[3, 2], [8, 2], [10, 3], [5, 4], [9, 5], [3, 6], [7, 7]] as const) put(c, r, PD);
      break;
    case 3: // Patch: one big dark blotch on the left side (cow-patch)
      for (let r = 2; r <= 7; r++) for (let c = 2; c <= 5; c++) put(c, r, PD);
      break;
    case 4: { // Star: a bright light star on the chest
      for (const [c, r] of [[6, 2], [5, 3], [6, 3], [7, 3], [6, 4], [6, 5]] as const) put(c, r, PL);
      break;
    }
    case 5: // Two-Tone: the whole lower body dipped in the dark shade
      band([6, 7, 8, 9, 10], PD);
      for (const c of [3, 4, 9, 10]) put(c, 11, PD); // feet tops
      break;
    case 6: // Saddle: a thick dark band across the back
      band([3, 4], PD);
      break;
    case 7: // Mask: dark patches framing the eyes
      for (let r = 3; r <= 5; r++) for (const c of [2, 3, 4, 9, 10, 11]) put(c, r, PD);
      break;
  }
  let out = "";
  for (const [c, r, col] of cells) out += px(ox, oy, cell, c, r, col);
  return out;
}

// Trait: v2 SHAPE. Silhouette extensions drawn BEHIND the body so they read as
// attached (the body grid overlaps their base). Round adds nothing.
function shapeMarkup(traits: PetTraits | undefined, ox: number, oy: number, cell: number, pal: Pal): string {
  const s = traits?.shape ?? 0;
  if (s === 0) return ""; // Round (today's silhouette)
  const B = pal.B!, O = pal.O!, L = pal.L!;
  const sw = Math.max(1, cell * 0.32);
  if (s === 1) {
    // Ears: two soft rounded nubs on the head top.
    const ear = (cx: number) =>
      `<path d="M ${ox + (cx - 1.1) * cell} ${oy + 1.2 * cell} Q ${ox + cx * cell} ${oy - 1.9 * cell} ${ox + (cx + 1.1) * cell} ${oy + 1.2 * cell} Z" fill="${B}" stroke="${O}" stroke-width="${sw}" stroke-linejoin="round"/>` +
      `<path d="M ${ox + (cx - 0.5) * cell} ${oy + 0.9 * cell} Q ${ox + cx * cell} ${oy - 0.7 * cell} ${ox + (cx + 0.5) * cell} ${oy + 0.9 * cell} Z" fill="${L}"/>`;
    return ear(3.4) + ear(10.6);
  }
  if (s === 2) {
    // Horns: two tiny bone horns curving up from the head corners.
    const bone = "#F1E6C6";
    const horn = (cx: number, dir: number) =>
      `<path d="M ${ox + cx * cell} ${oy + 0.8 * cell} Q ${ox + (cx + dir * 0.2) * cell} ${oy - 1.4 * cell} ${ox + (cx + dir * 0.9) * cell} ${oy - 2.2 * cell} Q ${ox + (cx + dir * 0.1) * cell} ${oy - 1.1 * cell} ${ox + (cx + dir * 0.75) * cell} ${oy + 0.8 * cell} Z" fill="${bone}" stroke="${O}" stroke-width="${sw}" stroke-linejoin="round"/>`;
    return horn(3.6, -1) + horn(10.4, 1);
  }
  // Tail: a small curled nub off the lower-right side.
  const tx = ox + 11.6 * cell, ty = oy + 8.6 * cell;
  return `<path d="M ${tx} ${ty} Q ${tx + 2.1 * cell} ${ty - 0.4 * cell} ${tx + 1.9 * cell} ${ty + 1.7 * cell} Q ${tx + 1.5 * cell} ${ty + 0.5 * cell} ${tx} ${ty + 1.2 * cell} Z" fill="${B}" stroke="${O}" stroke-width="${sw}" stroke-linejoin="round"/>`;
}

// PRIME (stage 3) flourish: a soft aura of sparkles behind the pet + a little
// gold crest on the head. The crest sits low on the scalp so a head accessory
// still crowns it, and the aura hugs the pet (never the bottom stats band).
function primeAura(w: number, h: number, ox: number, oy: number, cell: number, petW: number): string {
  const spark = (x: number, y: number, s: number, op: number) =>
    `<path d="M ${x} ${y - s} Q ${x + s * 0.16} ${y - s * 0.16} ${x + s} ${y} Q ${x + s * 0.16} ${y + s * 0.16} ${x} ${y + s} Q ${x - s * 0.16} ${y + s * 0.16} ${x - s} ${y} Q ${x - s * 0.16} ${y - s * 0.16} ${x} ${y - s} Z" fill="#FFF3C4" fill-opacity="${op}"/>`;
  const cx = ox + petW / 2;
  const cy = oy + 6 * cell;
  return (
    `<ellipse cx="${cx}" cy="${cy}" rx="${petW * 0.72}" ry="${petW * 0.66}" fill="#FFE9A8" fill-opacity="0.12"/>` +
    spark(ox - cell * 0.6, oy + cell * 1.5, cell * 1.1, 0.9) +
    spark(ox + petW + cell * 0.6, oy + cell * 2.5, cell * 1.0, 0.85) +
    spark(ox + petW + cell * 0.2, oy + cell * 7, cell * 0.8, 0.7) +
    spark(ox - cell * 0.2, oy + cell * 6, cell * 0.7, 0.7)
  );
}

function primeCrest(ox: number, oy: number, cell: number): string {
  const cx = ox + 7 * cell;
  const gold = "#FFD98A", edge = "#E0A93E";
  const spike = (dx: number, hgt: number) =>
    `<path d="M ${cx + (dx - 0.55) * cell} ${oy + 0.6 * cell} L ${cx + dx * cell} ${oy - hgt * cell} L ${cx + (dx + 0.55) * cell} ${oy + 0.6 * cell} Z" fill="${gold}" stroke="${edge}" stroke-width="${cell * 0.14}" stroke-linejoin="round"/>`;
  return spike(-1.3, 1.4) + spike(0, 2.1) + spike(1.3, 1.4);
}

// Day-one HATCHLING keepsake: a cracked half-eggshell perched on the head, in the
// pet's own egg tint. Drawn on top of the head, clear of the face.
function hatchlingShell(ox: number, oy: number, cell: number, pal: Pal): string {
  const cream = pal.P ?? "#F1DEB6", shell = pal.o ?? "#B98A5C";
  const cx = ox + 7 * cell;
  const left = ox + 3 * cell, right = ox + 11 * cell, base = oy + 0.7 * cell;
  // Zigzag cracked bottom edge, right -> left.
  let crack = `M ${right} ${base}`;
  const teeth = 5;
  for (let i = 1; i <= teeth; i++) {
    const t = i / teeth;
    const x = right + (left - right) * t;
    const y = base + (i % 2 === 0 ? -cell * 0.5 : cell * 0.35);
    crack += ` L ${x} ${y}`;
  }
  const dome = `M ${left} ${base} Q ${cx} ${oy - 2.7 * cell} ${right} ${base}`;
  return (
    `<path d="${dome} L ${right} ${base} Z" fill="${cream}" stroke="${shell}" stroke-width="${cell * 0.2}" stroke-linejoin="round"/>` +
    `<path d="${crack} Z" fill="${cream}" stroke="${shell}" stroke-width="${cell * 0.18}" stroke-linejoin="round"/>` +
    px(ox, oy, cell, 5, 0, shell) + px(ox, oy, cell, 8, 0, shell)
  );
}

// Trait-driven cheek blush (color + none). Fixed positions under the eyes.
function cheekMarkup(traits: PetTraits | undefined, ox: number, oy: number, cell: number): string {
  const c = traits?.cheeks ?? 0;
  if (c === 0) return "";
  const color = c === 1 ? "#FF9EC4" : c === 2 ? "#FF8A6E" : "#FFC58A";
  return px(ox, oy, cell, 2, 7, color) + px(ox, oy, cell, 11, 7, color);
}

// Per-mood face: eyes + mouth (+ cheeks), all pixel blocks over the body. The OPEN
// (happy/neutral) eyes vary by the pet's eye-style trait; distressed moods keep their
// expression but the body colour + markings + cheeks still make each pet distinct.
function face(mood: PetMood, ox: number, oy: number, cell: number, pal: Pal = PAL, traits?: PetTraits): string {
  const K = pal.K!;
  const W = pal.W!;
  const O = pal.O!;
  const p = (col: number, row: number, fill: string, span = 1) => px(ox, oy, cell, col, row, fill, span);
  const style = traits?.eyes ?? 0;
  // One open eye at (col,row), varied by style.
  const openEye = (col: number, row: number): string => {
    switch (style) {
      case 1: // Oval: short + wide
        return p(col, row + 1, W) + p(col + 1, row + 1, W) + p(col + 1, row + 1, K);
      case 2: // Sleepy: half-lidded line
        return p(col, row + 1, K) + p(col + 1, row + 1, K);
      case 3: // Sparkle: glossy white with a small pupil + glint
        return p(col, row, W) + p(col + 1, row, W) + p(col, row + 1, W) + p(col + 1, row + 1, W) + p(col + 1, row + 1, K);
      case 4: // Big: three rows tall
        return p(col, row - 1, W) + p(col + 1, row - 1, W) + p(col, row, W) + p(col + 1, row, W) +
          p(col, row + 1, W) + p(col + 1, row + 1, W) + p(col + 1, row, K) + p(col + 1, row + 1, K);
      case 5: // Beady: tiny dark dots
        return p(col + 1, row + 1, K);
      default: // Round
        return p(col, row, W) + p(col + 1, row, W) + p(col, row + 1, W) + p(col + 1, row + 1, W) +
          p(col + 1, row, K) + p(col + 1, row + 1, K);
    }
  };
  const cheeks = cheekMarkup(traits, ox, oy, cell);
  const halfEye = (col: number, row: number) => p(col, row + 1, K, 2);

  if (mood === "sleeping") {
    return p(3, 5, K, 2) + p(9, 5, K, 2) + p(6, 7, O, 2);
  }
  if (mood === "hungry") {
    return halfEye(3, 5) + halfEye(9, 5) + cheeks +
      p(6, 8, O) + p(7, 7, O) + p(8, 8, O);
  }
  if (mood === "thirsty") {
    return halfEye(3, 5) + halfEye(9, 5) +
      p(6, 7, K, 2) + p(6, 8, "#E8768A", 2);
  }
  if (mood === "sad") {
    const big = (col: number) =>
      p(col, 4, W) + p(col + 1, 4, W) + p(col, 5, W) + p(col + 1, 5, W) + p(col, 5, K) + p(col + 1, 5, K);
    return big(3) + big(9) + p(3, 4, W) + p(9, 4, W) +
      p(6, 8, O) + p(7, 7, O) + p(8, 8, O);
  }
  if (mood === "sick") {
    return halfEye(3, 5) + halfEye(9, 5) +
      p(2, 7, "#8FBF6A") + p(11, 7, "#8FBF6A") +
      p(6, 7, O) + p(7, 8, O) + p(8, 7, O);
  }
  if (mood === "critical") {
    return p(3, 5, K, 2) + p(2, 6, K) + p(9, 5, K, 2) + p(11, 6, K) +
      p(2, 7, "#B8C6D2") + p(11, 7, "#B8C6D2") + p(7, 8, K);
  }
  // happy (default): open eyes (styled) + cheeks + a smile in the outline colour.
  return openEye(3, 4) + openEye(9, 4) + cheeks +
    p(5, 7, O) + p(6, 8, O, 2) + p(8, 7, O);
}

// Trait: body marking/pattern (drawn over the body, under the face).
function markingMarkup(traits: PetTraits | undefined, ox: number, oy: number, cell: number, pal: Pal): string {
  const m = traits?.marking ?? 0;
  const O = pal.O!;
  const p = (c: number, r: number, f: string, span = 1) => px(ox, oy, cell, c, r, f, span);
  switch (m) {
    case 1: return p(3, 3, O) + p(10, 3, O) + p(5, 6, O) + p(9, 6, O); // spots
    case 2: return p(4, 2, O) + p(5, 2, O) + p(6, 1, O) + p(7, 1, O) + p(8, 2, O) + p(9, 2, O); // brow stripe
    case 3: return p(5, 9, O) + p(8, 9, O) + p(6, 10, O) + p(7, 10, O); // belly patch
    case 4: return p(6, 1, "#FFF3C4") + p(5, 2, "#FFF3C4") + p(6, 2, "#FFF3C4") + p(7, 2, "#FFF3C4") + p(6, 3, "#FFF3C4"); // forehead star
    case 5: return p(4, 6, O) + p(5, 6, O) + p(9, 6, O) + p(10, 6, O); // freckles
    default: return "";
  }
}

// Trait: head accent feature (drawn BEHIND the body so it peeks out from the head).
function accentMarkup(traits: PetTraits | undefined, ox: number, oy: number, cell: number, pal: Pal): string {
  const a = traits?.accent ?? 0;
  const cx = ox + 6.5 * cell;
  const topY = oy;
  switch (a) {
    case 1: // Ears
      return `<circle cx="${ox + 3.5 * cell}" cy="${oy + 0.3 * cell}" r="${cell * 1.2}" fill="${pal.B}"/><circle cx="${ox + 10.5 * cell}" cy="${oy + 0.3 * cell}" r="${cell * 1.2}" fill="${pal.B}"/><circle cx="${ox + 3.5 * cell}" cy="${oy + 0.4 * cell}" r="${cell * 0.5}" fill="${pal.L}"/><circle cx="${ox + 10.5 * cell}" cy="${oy + 0.4 * cell}" r="${cell * 0.5}" fill="${pal.L}"/>`;
    case 2: // Antenna
      return `<line x1="${cx}" y1="${topY}" x2="${cx}" y2="${topY - cell * 2.2}" stroke="${pal.O}" stroke-width="${cell * 0.5}"/><circle cx="${cx}" cy="${topY - cell * 2.4}" r="${cell * 0.85}" fill="#FFE06B"/>`;
    case 3: // Fin
      return `<path d="M ${ox + 8.5 * cell} ${topY + cell} L ${ox + 12 * cell} ${topY - cell * 1.6} L ${ox + 11.5 * cell} ${topY + cell * 1.8} Z" fill="${pal.O}"/>`;
    case 4: // Tuft
      return `<path d="M ${cx - cell} ${topY + cell * 0.5} q ${cell * 0.4} ${-cell * 2.2} ${cell} ${-cell} q ${cell * 0.3} ${-cell * 1.8} ${cell} ${-cell * 0.4} q ${cell * 0.3} ${-cell * 1.2} ${cell} ${cell * 0.2} L ${cx + cell * 1.4} ${topY + cell * 0.5} Z" fill="${pal.O}"/>`;
    default: // Sprout
      return `<line x1="${cx}" y1="${topY}" x2="${cx}" y2="${topY - cell * 1.8}" stroke="#4E9B54" stroke-width="${cell * 0.5}"/><ellipse cx="${cx + cell * 0.7}" cy="${topY - cell * 1.7}" rx="${cell}" ry="${cell * 0.5}" fill="#68C46E" transform="rotate(-28 ${cx + cell * 0.7} ${topY - cell * 1.7})"/>`;
  }
}

// Trait: rare accessory overlay (drawn LAST so shades sit over the eyes + hats on top).
function accessoryMarkup(traits: PetTraits | undefined, ox: number, oy: number, cell: number): string {
  const a = traits?.accessory ?? 0;
  const cx = ox + 7 * cell;
  const topY = oy;
  switch (a) {
    case 1: { // Bow
      const bx = ox + 3.6 * cell;
      const by = oy - cell * 0.1;
      return `<g fill="#FF5C8A"><path d="M ${bx} ${by} L ${bx - cell * 1.4} ${by - cell} L ${bx - cell * 1.4} ${by + cell} Z"/><path d="M ${bx} ${by} L ${bx + cell * 1.4} ${by - cell} L ${bx + cell * 1.4} ${by + cell} Z"/><circle cx="${bx}" cy="${by}" r="${cell * 0.55}" fill="#D63A6A"/></g>`;
    }
    case 2: // Shades
      return `<g fill="#20232A"><rect x="${ox + 2.6 * cell}" y="${oy + 4 * cell}" width="${cell * 3}" height="${cell * 1.9}" rx="${cell * 0.5}"/><rect x="${ox + 8.4 * cell}" y="${oy + 4 * cell}" width="${cell * 3}" height="${cell * 1.9}" rx="${cell * 0.5}"/><rect x="${ox + 5.6 * cell}" y="${oy + 4.6 * cell}" width="${cell * 2.8}" height="${cell * 0.4}"/></g><rect x="${ox + 3.1 * cell}" y="${oy + 4.4 * cell}" width="${cell * 0.9}" height="${cell * 0.5}" fill="#6B7686"/>`;
    case 3: // Party hat
      return `<path d="M ${cx - cell * 1.7} ${topY + cell * 0.2} L ${cx} ${topY - cell * 3.4} L ${cx + cell * 1.7} ${topY + cell * 0.2} Z" fill="#FF7AC0" stroke="#D64AA0" stroke-width="${cell * 0.15}" stroke-linejoin="round"/><circle cx="${cx}" cy="${topY - cell * 3.4}" r="${cell * 0.6}" fill="#FFE06B"/><circle cx="${cx - cell * 0.5}" cy="${topY - cell * 1.3}" r="${cell * 0.3}" fill="#FFF"/><circle cx="${cx + cell * 0.5}" cy="${topY - cell * 2.2}" r="${cell * 0.3}" fill="#8FE0FF"/>`;
    case 4: // Crown
      return `<path d="M ${cx - cell * 2.2} ${topY + cell * 0.2} L ${cx - cell * 2.2} ${topY - cell * 1.6} L ${cx - cell} ${topY - cell * 0.5} L ${cx} ${topY - cell * 2.1} L ${cx + cell} ${topY - cell * 0.5} L ${cx + cell * 2.2} ${topY - cell * 1.6} L ${cx + cell * 2.2} ${topY + cell * 0.2} Z" fill="#F4C542" stroke="#D9A62E" stroke-width="${cell * 0.2}" stroke-linejoin="round"/><circle cx="${cx}" cy="${topY - cell * 1.3}" r="${cell * 0.35}" fill="#FF5C6E"/><circle cx="${cx - cell * 1.6}" cy="${topY - cell * 1.1}" r="${cell * 0.22}" fill="#5CC8E0"/><circle cx="${cx + cell * 1.6}" cy="${topY - cell * 1.1}" r="${cell * 0.22}" fill="#5CC8E0"/>`;
    case 5: // Halo
      return `<ellipse cx="${cx}" cy="${topY - cell * 1.9}" rx="${cell * 2.5}" ry="${cell * 0.85}" fill="none" stroke="#FFE884" stroke-width="${cell * 0.55}"/><ellipse cx="${cx}" cy="${topY - cell * 1.9}" rx="${cell * 2.5}" ry="${cell * 0.85}" fill="none" stroke="#FFF7C8" stroke-width="${cell * 0.2}"/>`;
    case 6: { // Scarf: a cozy wrap around the neck, with a trailing end
      const ny = oy + 9.6 * cell;
      return `<g fill="#5CC5D6"><path d="M ${ox + 2.4 * cell} ${ny} Q ${ox + 7 * cell} ${ny + cell * 1.1} ${ox + 11.6 * cell} ${ny} L ${ox + 11.6 * cell} ${ny + cell * 0.9} Q ${ox + 7 * cell} ${ny + cell * 2} ${ox + 2.4 * cell} ${ny + cell * 0.9} Z"/><path d="M ${ox + 9.6 * cell} ${ny + cell * 0.6} l ${cell * 1.1} 0 l 0 ${cell * 2.4} l ${-cell * 0.55} ${-cell * 0.6} l ${-cell * 0.55} ${cell * 0.6} Z"/></g><path d="M ${ox + 2.4 * cell} ${ny} Q ${ox + 7 * cell} ${ny + cell * 1.1} ${ox + 11.6 * cell} ${ny}" fill="none" stroke="#3D93A2" stroke-width="${cell * 0.16}"/>`;
    }
    case 7: { // Leaf: a little sprout leaf tucked on the head
      const lx = cx + cell * 1.1, ly = topY - cell * 0.3;
      return `<line x1="${cx}" y1="${topY}" x2="${lx - cell * 0.5}" y2="${ly - cell * 0.6}" stroke="#4E9B54" stroke-width="${cell * 0.45}"/><path d="M ${lx - cell * 0.5} ${ly - cell * 0.6} Q ${lx + cell * 1.4} ${ly - cell * 1.9} ${lx + cell * 1.9} ${ly - cell * 0.2} Q ${lx + cell * 0.6} ${ly + cell * 0.3} ${lx - cell * 0.5} ${ly - cell * 0.6} Z" fill="#68C46E" stroke="#3F8A46" stroke-width="${cell * 0.12}"/><path d="M ${lx - cell * 0.2} ${ly - cell * 0.55} Q ${lx + cell * 0.7} ${ly - cell * 0.9} ${lx + cell * 1.5} ${ly - cell * 0.35}" fill="none" stroke="#3F8A46" stroke-width="${cell * 0.1}"/>`;
    }
    case 8: { // Ribbon: a small neck bow-tie at the chest
      const rx = ox + 7 * cell, ry = oy + 9.4 * cell;
      return `<g fill="#FF7AA8"><path d="M ${rx} ${ry} L ${rx - cell * 1.5} ${ry - cell * 0.9} L ${rx - cell * 1.5} ${ry + cell * 0.9} Z"/><path d="M ${rx} ${ry} L ${rx + cell * 1.5} ${ry - cell * 0.9} L ${rx + cell * 1.5} ${ry + cell * 0.9} Z"/></g><circle cx="${rx}" cy="${ry}" r="${cell * 0.55}" fill="#E14E82"/>`;
    }
    default: return "";
  }
}

// Sky + soft ground band, shared by all pet scenes.
function backdrop(w: number, h: number, groundY: number, t: TimeOfDay, tint?: string): string {
  const sky = skyStops(t);
  return `<defs>
    <linearGradient id="psky" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="${sky.top}"/><stop offset="1" stop-color="${sky.bottom}"/></linearGradient>
    <linearGradient id="pgnd" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="${C.riverLight}"/><stop offset="1" stop-color="${C.riverDeep}"/></linearGradient>
  </defs>
  <rect width="${w}" height="${groundY}" fill="url(#psky)"/>
  <rect y="${groundY}" width="${w}" height="${h - groundY}" fill="url(#pgnd)"/>
  <rect y="${groundY - h * 0.01}" width="${w}" height="${h * 0.02}" fill="${C.foam}" fill-opacity="0.12"/>
  ${tint ? `<rect width="${w}" height="${h}" fill="${tint}" fill-opacity="0.12"/>` : ""}`;
}

// Mood props drawn around the pet (sparkles, rain cloud, zzz, thermometer, shimmer).
function props(mood: PetMood, w: number, h: number, ox: number, oy: number, cell: number, petW: number): string {
  const cx = ox + petW / 2;
  if (mood === "happy") {
    const sp = (x: number, y: number, s: number) =>
      `<path d="M ${x} ${y - s} Q ${x + s * 0.18} ${y - s * 0.18} ${x + s} ${y} Q ${x + s * 0.18} ${y + s * 0.18} ${x} ${y + s} Q ${x - s * 0.18} ${y + s * 0.18} ${x - s} ${y} Q ${x - s * 0.18} ${y - s * 0.18} ${x} ${y - s} Z" fill="#FFF3C4"/>`;
    return sp(ox - cell, oy + cell * 2, cell * 1.1) + sp(ox + petW + cell * 0.6, oy + cell * 3.5, cell * 0.9) + sp(ox + petW - cell, oy - cell, cell * 0.7);
  }
  if (mood === "sad") {
    const clx = cx;
    const cly = oy - cell * 1.6;
    return `<g fill="#8f9aa8"><ellipse cx="${clx}" cy="${cly}" rx="${cell * 2.4}" ry="${cell}" /><circle cx="${clx - cell * 1.4}" cy="${cly - cell * 0.3}" r="${cell}"/><circle cx="${clx + cell * 1.3}" cy="${cly - cell * 0.2}" r="${cell * 1.1}"/><circle cx="${clx}" cy="${cly - cell * 0.8}" r="${cell * 1.2}"/></g>
      <g stroke="#9fd0e0" stroke-width="${cell * 0.35}" stroke-linecap="round"><line x1="${clx - cell * 1.2}" y1="${cly + cell}" x2="${clx - cell * 1.2}" y2="${cly + cell * 1.7}"/><line x1="${clx}" y1="${cly + cell * 1.1}" x2="${clx}" y2="${cly + cell * 1.8}"/><line x1="${clx + cell * 1.2}" y1="${cly + cell}" x2="${clx + cell * 1.2}" y2="${cly + cell * 1.7}"/></g>`;
  }
  if (mood === "sleeping") {
    const zx = ox + petW + cell * 0.4;
    const zy = oy + cell;
    return `<g font-family="monospace" font-weight="700" fill="${C.foam}"><text x="${zx}" y="${zy}" font-size="${cell * 2}">z</text><text x="${zx + cell * 1.4}" y="${zy - cell * 1.4}" font-size="${cell * 1.4}" fill-opacity="0.8">z</text><text x="${zx + cell * 2.4}" y="${zy - cell * 2.6}" font-size="${cell}" fill-opacity="0.6">z</text></g>`;
  }
  if (mood === "thirsty") {
    const s = (x: number) => `<path d="M ${x} ${oy - cell * 0.4} q ${cell * 0.5} ${-cell * 0.5} 0 ${-cell} q ${-cell * 0.5} ${-cell * 0.5} 0 ${-cell}" stroke="${C.foam}" stroke-opacity="0.2" stroke-width="${cell * 0.28}" fill="none"/>`;
    return s(ox + cell) + s(ox + petW - cell);
  }
  if (mood === "sick") {
    const tx = ox + petW - cell * 0.6;
    const ty = oy + cell * 6;
    return `<g><rect x="${tx}" y="${ty}" width="${cell * 0.5}" height="${cell * 2.4}" rx="${cell * 0.25}" fill="#eef2f4"/><circle cx="${tx + cell * 0.25}" cy="${ty + cell * 2.4}" r="${cell * 0.5}" fill="#d9534f"/></g>`;
  }
  if (mood === "critical") {
    // a heavy sweat bead + a faint fading pulse ring: weak, urgent, still here.
    const cy = oy + cell * 6.5;
    const sx = ox + petW - cell * 0.2;
    const sy = oy + cell * 1.2;
    const sweat = `<path d="M ${sx} ${sy} q ${cell * 0.55} ${cell * 0.9} 0 ${cell * 1.4} q ${-cell * 0.55} ${-cell * 0.5} 0 ${-cell * 1.4} Z" fill="#8FC7E8" fill-opacity="0.9"/>`;
    const ring = `<ellipse cx="${ox + petW / 2}" cy="${cy}" rx="${petW * 0.72}" ry="${cell * 8}" fill="none" stroke="#CBD8E2" stroke-opacity="0.35" stroke-width="${cell * 0.32}" stroke-dasharray="${cell} ${cell}"/>`;
    return ring + sweat;
  }
  return "";
}

// Toys accumulate as ground props: ball, then duck, then a crown on the head.
function toysMarkup(toys: number, ox: number, oy: number, cell: number, petW: number): string {
  let out = "";
  if (toys >= 1) {
    const bx = ox - cell * 2.2;
    const by = oy + cell * 11.5;
    out += `<circle cx="${bx}" cy="${by}" r="${cell * 1.1}" fill="#EF6D6D"/><path d="M ${bx - cell} ${by} h ${cell * 2}" stroke="#fff" stroke-width="${cell * 0.28}"/><path d="M ${bx} ${by - cell} v ${cell * 2}" stroke="#fff" stroke-width="${cell * 0.28}" stroke-opacity="0.7"/>`;
  }
  if (toys >= 2) {
    const dx = ox + petW + cell * 1.4;
    const dy = oy + cell * 11.2;
    out += `<g fill="#F4C542"><ellipse cx="${dx}" cy="${dy}" rx="${cell * 1.2}" ry="${cell * 0.85}"/><circle cx="${dx + cell * 0.9}" cy="${dy - cell}" r="${cell * 0.7}"/></g><path d="M ${dx + cell * 1.5} ${dy - cell} l ${cell * 0.7} ${cell * 0.15}" stroke="#E8963A" stroke-width="${cell * 0.4}" stroke-linecap="round"/><circle cx="${dx + cell}" cy="${dy - cell * 1.1}" r="${cell * 0.12}" fill="#2A2320"/>`;
  }
  if (toys >= 3) {
    const kx = ox + petW / 2;
    const ky = oy - cell * 0.4;
    out += `<path d="M ${kx - cell * 2.2} ${ky} L ${kx - cell * 2.2} ${ky - cell * 1.6} L ${kx - cell} ${ky - cell * 0.5} L ${kx} ${ky - cell * 2} L ${kx + cell} ${ky - cell * 0.5} L ${kx + cell * 2.2} ${ky - cell * 1.6} L ${kx + cell * 2.2} ${ky} Z" fill="#F4C542" stroke="#D9A62E" stroke-width="${cell * 0.2}" stroke-linejoin="round"/><circle cx="${kx}" cy="${ky - cell * 1.4}" r="${cell * 0.35}" fill="#F98F76"/>`;
  }
  return out;
}

// A little headstone bearing the pet's number (or a heart). Bottom sits on baseY.
function headstone(cx: number, baseY: number, sw: number, sh: number, label?: string): string {
  const top = baseY - sh;
  const shoulder = top + sw / 2;
  const left = cx - sw / 2;
  const right = cx + sw / 2;
  const outline = `M ${left} ${baseY} L ${left} ${shoulder} A ${sw / 2} ${sw / 2} 0 0 1 ${right} ${shoulder} L ${right} ${baseY} Z`;
  const engrave = label
    ? `<text x="${cx}" y="${top + sh * 0.62}" text-anchor="middle" font-family="Arial, Helvetica, sans-serif" font-size="${Math.round(sw * 0.26)}" font-weight="800" fill="#6B7686">No.${label}</text>`
    : `<path d="M ${cx} ${top + sh * 0.5} q ${-sw * 0.13} ${-sw * 0.13} 0 ${-sw * 0.02} q ${sw * 0.13} ${-sw * 0.11} 0 ${sw * 0.02} Z" fill="#F98F76" fill-opacity="0.85" transform="translate(0 ${sw * 0.02})"/><circle cx="${cx - sw * 0.05}" cy="${top + sh * 0.44}" r="${sw * 0.055}" fill="#F98F76" fill-opacity="0.85"/><circle cx="${cx + sw * 0.05}" cy="${top + sh * 0.44}" r="${sw * 0.055}" fill="#F98F76" fill-opacity="0.85"/><path d="M ${cx - sw * 0.1} ${top + sh * 0.46} L ${cx} ${top + sh * 0.6} L ${cx + sw * 0.1} ${top + sh * 0.46} Z" fill="#F98F76" fill-opacity="0.85"/>`;
  return `<ellipse cx="${cx}" cy="${baseY}" rx="${sw * 0.72}" ry="${sh * 0.05}" fill="#0E0A1C" fill-opacity="0.45"/>
    <path d="${outline}" fill="#AEB8C6"/>
    <path d="${outline}" fill="#C7D0DC" clip-path="none" transform="translate(0 0)" opacity="0.0"/>
    <path d="M ${left} ${baseY} L ${left} ${shoulder} A ${sw / 2} ${sw / 2} 0 0 1 ${cx} ${top} L ${cx} ${baseY} Z" fill="#C7D0DC"/>
    ${engrave}`;
}

// The pet as a soft drifting spirit: a glow behind a pale silhouette with two
// peaceful closed eyes.
function spirit(sx: number, sy: number, cell: number, tint = "#DEE9F1"): string {
  const petW = 14 * cell;
  return `<ellipse cx="${sx + petW / 2}" cy="${sy + 6.5 * cell}" rx="${petW * 0.66}" ry="${petW * 0.6}" fill="url(#mglow)"/>
    <g opacity="0.66">${renderGridTinted(BODY, sx, sy, cell, tint)}
    ${px(sx, sy, cell, 3, 5, "#5A6B7E", 2)}${px(sx, sy, cell, 9, 5, "#5A6B7E", 2)}</g>`;
}

// The memorial keepsake scene: a cemetery hill at dusk-to-night, a soft spirit of
// the pet above a little headstone. Tasteful and pretty, a keepsake not a grave.
// Two layouts so it reads at the wide pass strip AND the squarer social card.
function memorialScene(w: number, h: number, label?: string, spiritTint = "#DEE9F1", hideWordmark = false): string {
  const horizon = Math.round(h * 0.68);
  const stars = Array.from({ length: 16 }, (_, i) => {
    const rx = (i * 96.7) % w;
    const ry = (i * 41.3) % Math.round(horizon * 0.82);
    const rr = i % 4 === 0 ? 1.7 : 1;
    return `<circle cx="${rx.toFixed(1)}" cy="${ry.toFixed(1)}" r="${rr}" fill="#EAF3F5" fill-opacity="${(0.3 + (i % 3) * 0.2).toFixed(2)}"/>`;
  }).join("");
  const moon = `<circle cx="${(w * 0.2).toFixed(1)}" cy="${(h * 0.22).toFixed(1)}" r="${(Math.min(w, h) * 0.07).toFixed(1)}" fill="url(#mmoon)"/>`;
  const hills = `<path d="M0 ${horizon + h * 0.05} Q ${w * 0.3} ${horizon - h * 0.05} ${w * 0.62} ${horizon + h * 0.01} T ${w} ${horizon + h * 0.02} V ${h} H 0 Z" fill="#2A2145"/>
    <path d="M0 ${horizon + h * 0.12} Q ${w * 0.5} ${horizon + h * 0.02} ${w} ${horizon + h * 0.09} V ${h} H 0 Z" fill="#1C1533"/>`;

  const wide = w / h >= 1.5;
  let stoneMarkup: string;
  let spiritMarkup: string;
  let flowerX: number;
  if (wide) {
    const sw = Math.round(h * 0.42);
    const sh = Math.round(sw * 1.35);
    const scx = Math.round(w * 0.66);
    stoneMarkup = headstone(scx, horizon + h * 0.03, sw, sh, label);
    const cell = Math.max(3, Math.floor((h * 0.34) / 13));
    const petW = 14 * cell;
    spiritMarkup = spirit(Math.round(w * 0.3 - petW / 2), Math.round(horizon - 13 * cell - h * 0.03), cell, spiritTint);
    flowerX = scx - sw * 0.72;
  } else {
    const sw = Math.round(w * 0.2);
    const sh = Math.round(sw * 1.4);
    const scx = Math.round(w * 0.5);
    stoneMarkup = headstone(scx, horizon + h * 0.03, sw, sh, label);
    const cell = Math.max(4, Math.floor(Math.min((w * 0.46) / 14, (h * 0.34) / 13)));
    const petW = 14 * cell;
    spiritMarkup = spirit(Math.round(scx - petW / 2), Math.round(Math.max(h * 0.02, horizon - sh - 13 * cell - h * 0.01)), cell, spiritTint);
    flowerX = scx - sw * 0.85;
  }
  const flowerBaseY = horizon + h * 0.03;
  const flowerTopY = flowerBaseY - h * 0.1;
  const flower = `<line x1="${flowerX.toFixed(1)}" y1="${flowerBaseY}" x2="${flowerX.toFixed(1)}" y2="${flowerTopY}" stroke="#4E7A4A" stroke-width="${Math.max(1, w * 0.004)}"/>
    <circle cx="${flowerX.toFixed(1)}" cy="${flowerTopY}" r="${w * 0.013}" fill="#F6B0C0"/><circle cx="${flowerX.toFixed(1)}" cy="${flowerTopY}" r="${w * 0.006}" fill="#FFE59A"/>`;

  return `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}">
    <defs>
      <linearGradient id="msky" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#20183A"/><stop offset="0.62" stop-color="#4A3C63"/><stop offset="1" stop-color="#8A6E8E"/></linearGradient>
      <radialGradient id="mglow" cx="0.5" cy="0.5" r="0.5"><stop offset="0" stop-color="#EAF3F5" stop-opacity="0.5"/><stop offset="1" stop-color="#EAF3F5" stop-opacity="0"/></radialGradient>
      <radialGradient id="mmoon" cx="0.4" cy="0.4" r="0.6"><stop offset="0" stop-color="#FFF7E8"/><stop offset="1" stop-color="#DBCBAE"/></radialGradient>
    </defs>
    <rect width="${w}" height="${h}" fill="url(#msky)"/>
    ${stars}${moon}${hills}${flower}${stoneMarkup}${spiritMarkup}${hideWordmark ? "" : wordmark(w, h, 0.5)}
  </svg>`;
}

// The full WALLETCHI pet scene. The creature's appearance is generated from its
// tokenId (opts.seed) via the trait system; only its look varies, not the layout.
export function petScene(w: number, h: number, opts: PetSceneOpts): string {
  const t = opts.timeOfDay ?? "dusk";
  const traits = opts.traits ?? traitsFor(opts.seed ?? "1");
  const pal = palFor(traits);
  const groundY = Math.round(h * 0.72);
  const svg = (inner: string) =>
    `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}">${inner}</svg>`;

  if (opts.mood === "gone") {
    // The memorial keepsake: a cemetery hill, the pet as a soft spirit (tinted by its
    // own hue) above its headstone. A pretty obituary, not a grave.
    return memorialScene(w, h, opts.label, pal.L, opts.hideWordmark);
  }

  const cols = 14;
  const rows = opts.mood === "egg" ? EGG.length : BODY.length;
  const exactCell = Math.min((w * 0.9) / cols, (h * 0.6) / 13);
  const baseCell = Math.floor(exactCell);
  // Head clearance, in cells above the body's top row. The tallest things a pet
  // can wear reach about four cells up: a party hat plus its pompom (4.0), an
  // antenna bulb (3.25), a halo (3.0), the PRIME aura (3.24) and crest (2.1).
  const HEAD_CELLS = 4;
  // The pet stands with its feet at groundY + 1.5 cells, so the body occupies
  // 11.5 cells above the ground line and the head props another HEAD_CELLS on
  // top. That is the whole vertical budget, and it bounds how big the pet may
  // ever be drawn: past this cap a PRIME pet grew straight out of the top of the
  // frame and its hat/crest/aura got sliced off (visible on the strip, the
  // square portrait, and the social card). GROWN already sits at the cap, so it
  // renders exactly as before; PRIME reads through its crest and aura instead of
  // extra size, and never clips.
  const capCell = Math.max(1, Math.floor((groundY - h * 0.015) / (11.5 + HEAD_CELLS)));
  // Evolution scales the pet from the ground: HATCHLING shrinks, PRIME grows up
  // to the clearance cap, GROWN (and any flag-off / unstaged render) keeps
  // today's exact size. Scaling the UNROUNDED base keeps the shrink honest at
  // every strip resolution (@1x/@2x/@3x stayed proportional to each other).
  const scale = opts.mood === "egg" ? 1 : opts.stage === 1 ? 0.75 : opts.stage === 3 ? 1.25 : 1;
  const cell =
    scale === 1
      ? baseCell
      : Math.max(1, Math.min(Math.round(exactCell * scale), Math.max(baseCell, capCell)));
  const petW = (opts.mood === "egg" ? 12 : cols) * cell;
  const petH = rows * cell;
  const ox = Math.round(w * 0.5 - petW / 2);
  const oy = Math.round(groundY - petH + cell * 1.5);
  const tint =
    opts.mood === "sick" ? "#8FBF6A" : opts.mood === "critical" ? "#8AA0B4" : undefined;

  if (opts.mood === "egg") {
    // Even un-hatched eggs vary: the shell + band are tinted by the pet's body hue.
    // The egg shows NO pattern/shape/stage flourish; the pet reveals them at hatch.
    return svg(`${backdrop(w, h, groundY, t)}
      <ellipse cx="${ox + petW / 2}" cy="${oy + petH + cell * 0.2}" rx="${petW * 0.4}" ry="${cell * 0.7}" fill="#06181c" fill-opacity="0.3"/>
      ${renderGrid(EGG, ox, oy, cell, pal)}
      ${props("happy", w, h, ox, oy, cell, petW)}
      ${opts.hideWordmark ? "" : wordmark(w, h)}`);
  }

  const isPrime = opts.stage === 3;
  // Accessories on the head suppress the toy crown so they never collide (Leaf
  // rides the head too, so it joins the set).
  const headOccupied = [1, 3, 4, 5, 7].includes(traits.accessory);
  const toyCount = headOccupied ? Math.min(opts.toys ?? 0, 2) : opts.toys ?? 0;

  return svg(`${backdrop(w, h, groundY, t, tint)}
    ${isPrime ? primeAura(w, h, ox, oy, cell, petW) : ""}
    <ellipse cx="${ox + petW / 2}" cy="${oy + petH + cell * 0.1}" rx="${petW * 0.42}" ry="${cell * 0.7}" fill="#06181c" fill-opacity="0.3"/>
    ${props(opts.mood, w, h, ox, oy, cell, petW)}
    ${accentMarkup(traits, ox, oy, cell, pal)}
    ${shapeMarkup(traits, ox, oy, cell, pal)}
    ${renderGrid(BODY, ox, oy, cell, pal)}
    ${patternMarkup(traits, ox, oy, cell, pal)}
    ${markingMarkup(traits, ox, oy, cell, pal)}
    ${isPrime ? primeCrest(ox, oy, cell) : ""}
    ${face(opts.mood, ox, oy, cell, pal, traits)}
    ${toysMarkup(toyCount, ox, oy, cell, petW)}
    ${opts.shellCap ? hatchlingShell(ox, oy, cell, pal) : ""}
    ${accessoryMarkup(traits, ox, oy, cell)}
    ${opts.hideWordmark ? "" : wordmark(w, h)}`);
}

async function svgToPng(svg: string): Promise<Buffer> {
  return sharp(Buffer.from(svg)).png().toBuffer();
}

// ---- Render hardening (public PNG endpoints) ----
// sharp/libvips rasterization is the CPU-heavy step, so a flood of PNG requests
// could saturate the process. The public card/portrait renders go through a
// small semaphore (bounded concurrency, bounded wait queue: excess sheds as
// RenderBusyError, which the routes map to 503) plus a tiny in-process LRU
// keyed by the FULL render inputs so repeated/enumerated ids raster once.
// Pass generation (petPassImages) is intentionally NOT routed through this:
// wallet pass delivery must never shed.
export class RenderBusyError extends Error {
  constructor() {
    super("render busy");
  }
}

const RASTER_CONCURRENCY = 4;
const RASTER_MAX_PENDING = 24;
let rasterActive = 0;
const rasterWaiters: (() => void)[] = [];

async function boundedRaster<T>(run: () => Promise<T>): Promise<T> {
  if (rasterActive >= RASTER_CONCURRENCY) {
    if (rasterWaiters.length >= RASTER_MAX_PENDING) throw new RenderBusyError();
    await new Promise<void>((resolve) => rasterWaiters.push(resolve));
  }
  rasterActive++;
  try {
    return await run();
  } finally {
    rasterActive--;
    rasterWaiters.shift()?.();
  }
}

// LRU capped by total BYTES, not entry count: 1080px cards run 150-400KB each,
// so an entry-count cap alone could pin hundreds of MB. Entries may also carry
// a TTL (the card render embeds a shared survivor count that must age out).
const RENDER_CACHE_MAX_BYTES = 32 * 1024 * 1024;
const renderCache = new Map<string, { png: Buffer; expiresAt: number | null }>();
let renderCacheBytes = 0;

function renderCacheGet(key: string): Buffer | undefined {
  const hit = renderCache.get(key);
  if (!hit) return undefined;
  if (hit.expiresAt !== null && hit.expiresAt <= Date.now()) {
    renderCache.delete(key);
    renderCacheBytes -= hit.png.length;
    return undefined;
  }
  // Refresh recency (Map iterates in insertion order, so oldest is first).
  renderCache.delete(key);
  renderCache.set(key, hit);
  return hit.png;
}

function renderCachePut(key: string, png: Buffer, ttlMs: number | null = null): void {
  const prev = renderCache.get(key);
  if (prev) {
    renderCache.delete(key);
    renderCacheBytes -= prev.png.length;
  }
  renderCache.set(key, { png, expiresAt: ttlMs === null ? null : Date.now() + ttlMs });
  renderCacheBytes += png.length;
  while (renderCacheBytes > RENDER_CACHE_MAX_BYTES) {
    const oldest = renderCache.keys().next().value;
    if (oldest === undefined) break;
    const evicted = renderCache.get(oldest)!;
    renderCache.delete(oldest);
    renderCacheBytes -= evicted.png.length;
  }
}

// Rounded app icon: a tiny pixel pet face on a river tile. Clean at 29 px.
// radius overrides the corner rounding (0 = full-bleed square for hosted logos).
function iconSvg(size: number, radius?: number): string {
  const r = radius ?? size * 0.22;
  const u = size / 12;
  const eye = (col: number) =>
    `<rect x="${col * u}" y="${5 * u}" width="${u * 1.6}" height="${u * 1.6}" fill="#FFFFFF"/><rect x="${col * u + u * 0.7}" y="${5.7 * u}" width="${u}" height="${u}" fill="#2A2320"/>`;
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 ${size} ${size}">
    <defs><radialGradient id="ibg" cx="0.5" cy="0.2" r="1.1"><stop offset="0" stop-color="${C.riverLight}"/><stop offset="1" stop-color="${C.riverDeep}"/></radialGradient></defs>
    <rect width="${size}" height="${size}" rx="${r}" ry="${r}" fill="url(#ibg)"/>
    <rect x="${2.5 * u}" y="${3 * u}" width="${7 * u}" height="${7 * u}" rx="${u * 2}" fill="#F98F76"/>
    ${eye(3.4)}${eye(6.4)}
    <rect x="${5.2 * u}" y="${8 * u}" width="${1.6 * u}" height="${u}" fill="#B0433F"/>
  </svg>`;
}

// Square hosted brand logo (the Google Wallet loyalty-class programLogo, and
// any other integration that needs a plain HTTPS PNG). FULL-BLEED square, no
// transparent rounded corners: Google circle-crops the logo itself and a
// broken/absent programLogo fails the whole class (and with it the save flow).
// One asset, cached; Google's recommended size is ~660px square.
export async function brandLogoPng(size = 660): Promise<Buffer> {
  const key = `brandlogo:${size}`;
  const hit = renderCacheGet(key);
  if (hit) return hit;
  const png = await svgToPng(iconSvg(size, 0));
  renderCachePut(key, png);
  return png;
}

// WALLETCHI wordmark: foam caps with a salmon period, trimmed to fit.
async function logoPng(boxW: number, boxH: number): Promise<Buffer> {
  const fs = 200;
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="3600" height="${fs + 48}" viewBox="0 0 3600 ${fs + 48}">
    <text x="24" y="${24 + fs * 0.8}" font-family="Arial, Helvetica, sans-serif" font-size="${fs}" font-weight="800" letter-spacing="-2" fill="${C.foam}">${RUNNER_THEME.gameName}<tspan fill="${C.salmon}">.</tspan></text>
  </svg>`;
  return sharp(Buffer.from(svg)).trim().resize({ width: boxW, height: boxH, fit: "inside", background: { r: 0, g: 0, b: 0, alpha: 0 } }).png().toBuffer();
}

// Live season stats for the pass-art band (pre-formatted display strings so the
// renderer stays a pure function). fdv appears once a CARE pool exists.
export interface PassStats {
  alive: number;
  total: number;
  pot: string; // compact, e.g. "12.4K"
  burned: string; // compact, e.g. "378K"
  fdv?: string; // compact, e.g. "2.1M HOOD"
}

export interface PetImageOpts {
  mood: PetMood;
  toys?: number;
  timeOfDay?: TimeOfDay;
  seed?: string; // tokenId (or serial) for the generative traits
  stats?: PassStats; // stats band across the strip bottom (flag-gated by callers)
  stage?: Stage; // evolution stage (v2); undefined renders today's GROWN size
  shellCap?: boolean; // day-one hatchling eggshell cap
}

// --- Stats band art -----------------------------------------------------------
// Tiny pixel glyphs in the same cell language as the pet: a heart (alive), a
// gem (FDV / POT), a flame (burned). Drawn at any cell size so they stay crisp
// on the 1080 card and the @1x strip alike.
const GLYPHS: Record<"heart" | "gem" | "flame", { grid: string[]; pal: Record<string, string> }> = {
  heart: {
    grid: [".AA.AA.", "AAAAAAA", "AABAAAA", ".AAAAA.", "..AAA..", "...A..."],
    pal: { A: "#F98F76", B: "#FFC0A6" },
  },
  gem: {
    grid: ["..AAA..", ".ABBBA.", "AABBBAA", ".AABAA.", "..AAA..", "...A..."],
    pal: { A: "#D9A521", B: "#F8DB7E" },
  },
  flame: {
    grid: ["...A...", "..AA...", ".AABA..", "AABBAA.", "AABBBA.", ".AABA.."],
    pal: { A: "#FF9E80", B: "#FFE1B0" },
  },
};

function statGlyph(kind: keyof typeof GLYPHS, x: number, y: number, cell: number): string {
  const { grid, pal } = GLYPHS[kind];
  let out = "";
  grid.forEach((row, r) => {
    for (let c = 0; c < row.length; c++) {
      const ch = row[c]!;
      if (ch === ".") continue;
      out += `<rect x="${x + c * cell}" y="${y + r * cell}" width="${cell}" height="${cell}" fill="${pal[ch]}"/>`;
    }
  });
  return out;
}

// Fit a value into a width: shrink the font until the estimated run fits with
// comfortable air on both sides (the reason FDV never kisses a chip edge).
function fitFont(plainLen: number, maxWidth: number, base: number, min = 12): number {
  return Math.max(min, Math.min(base, Math.floor(maxWidth / (Math.max(1, plainLen) * 0.62))));
}

// The strip HUD: a bottom fade band with three anchored stat groups, each led
// by its pixel glyph. Scales with the strip so @1x/@2x/@3x all stay crisp.
// showWordmark=false is for compositions that print the mark themselves (the wide
// Google hero puts it in its own left-hand lockup, where it cannot land on the
// horizon line). The Apple strip callers keep the default and are unchanged.
function stripWithBand(w: number, h: number, scene: PetSceneOpts, stats: PassStats, showWordmark = true): string {
  // The band owns the bottom-right corner, so the scene's own wordmark is drawn
  // separately, lifted clear of the fade (it used to print straight through the
  // BURNED figure).
  const inner = embedScene(petScene(w, h, { ...scene, hideWordmark: true }));
  const bandH = Math.round(h * 0.22);
  const fadeTop = h - bandH * 1.2;
  // Side inset, so the outer figures never run to the strip edge.
  const pad = w * 0.035;
  const segW = (w - pad * 2) / 3;
  const mid = stats.fdv ? `FDV ${stats.fdv}` : `POT ${stats.pot}`;
  const segs: Array<{ icon: keyof typeof GLYPHS; text: string }> = [
    { icon: "heart", text: `${stats.alive.toLocaleString("en-US")} ALIVE` },
    { icon: "gem", text: mid },
    { icon: "flame", text: `${stats.burned} BURNED` },
  ];
  const longest = Math.max(...segs.map((s) => s.text.length));
  const cell = Math.max(1, Math.round(bandH * 0.1));
  const iconW = 7 * cell;
  const gap = Math.max(2, cell * 1.4);
  // The floor tracks the strip width so @1x/@2x/@3x compose identically. A flat
  // 12px floor made the @1x band overflow its own segment.
  const fs = fitFont(longest, segW - iconW - gap, bandH * 0.5, w * 0.024);
  const baseY = h - bandH / 2;
  const parts = segs
    .map((s, i) => {
      // Lay the glyph + figure out as ONE group, centred in its own segment, so
      // the run always sits inside the segment however long the figure gets.
      const estW = s.text.length * fs * 0.62;
      const groupW = iconW + gap + estW;
      const segLeft = pad + segW * i;
      const groupX = segLeft + Math.max(0, (segW - groupW) / 2);
      return (
        statGlyph(s.icon, groupX, baseY - 3 * cell, cell) +
        `<text x="${groupX + iconW + gap}" y="${baseY + fs * 0.36}" font-family="Arial, Helvetica, sans-serif" font-size="${fs}" font-weight="800" letter-spacing="0.6" fill="#F4FAFC">${s.text}</text>`
      );
    })
    .join("");
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}">
    <defs><linearGradient id="hud" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#08161E" stop-opacity="0"/><stop offset="0.45" stop-color="#08161E" stop-opacity="0.62"/><stop offset="1" stop-color="#050E14" stop-opacity="0.9"/></linearGradient></defs>
    ${inner}
    ${showWordmark ? wordmark(w, h, 0.42, fadeTop - h * 0.035) : ""}
    <rect x="0" y="${fadeTop}" width="${w}" height="${h - fadeTop}" fill="url(#hud)"/>
    ${parts}
  </svg>`;
}

// Apple pass images for a WALLETCHI pet (storeCard sizes with @2x/@3x). The strip
// is the living pixel-pet scene.
export async function petPassImages(opts: PetImageOpts): Promise<Record<string, Buffer>> {
  const scene: PetSceneOpts = { mood: opts.mood, toys: opts.toys, timeOfDay: opts.timeOfDay ?? timeOfDayFor(new Date()), seed: opts.seed, stage: opts.stage, shellCap: opts.shellCap };
  const strip = (w: number, h: number) =>
    opts.stats ? stripWithBand(w, h, scene, opts.stats) : petScene(w, h, scene);
  const [i1, i2, i3, l1, l2, l3, s1, s2, s3] = await Promise.all([
    svgToPng(iconSvg(29)), svgToPng(iconSvg(58)), svgToPng(iconSvg(87)),
    // 120pt wide (not the 160pt max): header fields share this row, and a full-
    // width logo gets CROPPED by Apple ("WALLETCh..."). 120pt always fits beside
    // the "NO." + "ALIVE" headers, so the wordmark shows in full.
    logoPng(120, 50), logoPng(240, 100), logoPng(360, 150),
    svgToPng(strip(375, 144)), svgToPng(strip(750, 288)), svgToPng(strip(1125, 432)),
  ]);
  return {
    "icon.png": i1, "icon@2x.png": i2, "icon@3x.png": i3,
    "logo.png": l1, "logo@2x.png": l2, "logo@3x.png": l3,
    "strip.png": s1, "strip@2x.png": s2, "strip@3x.png": s3,
  };
}

function embedScene(sceneSvg: string): string {
  return sceneSvg.replace(/^<svg[^>]*>/, "").replace(/<\/svg>$/, "");
}

// --- Google Wallet WIDE hero --------------------------------------------------
//
// Google's loyalty heroImage is a roughly 3:1 slot (Google's own guidance is
// 1032x336). The square 1080 card render used to be served into it, so an Android
// keeper got a 1:1 image in a 3:1 frame: the pet stretched tall and the card's own
// header, stat chips and footer collapsed into an unreadable smear. This is the
// same living scene COMPOSED for that ratio instead.
//
// 2064x672 is exactly 2x Google's recommended 1032x336, so the ratio matches the
// slot to the pixel and the art still resolves on a 3x-density phone (a hero is
// drawn at card width, about 400dp, which is at most ~1200 physical pixels). It is
// a SINGLE render, not an @2x/@3x family: that file convention belongs to the
// Apple pass bundle (petPassImages), while every hosted PNG here (the 1080 card,
// the 800 portrait) is one high-resolution image behind one URL.
export const HERO_W = 2064;
export const HERO_H = 672;

export interface PetHeroOpts {
  mood: PetMood;
  toys?: number;
  timeOfDay?: TimeOfDay;
  seed?: string; // tokenId (or serial) for the generative traits
  name?: string; // the pet's own name, e.g. "Nutmeg Thicket"
  number?: string; // e.g. "No. 0042"
  stats?: PassStats; // season band across the bottom (flag-gated by callers)
  stage?: Stage; // evolution stage (v2); undefined renders today's GROWN size
  shellCap?: boolean; // day-one hatchling eggshell cap
}

// The wide hero: pet centre stage in a full-bleed river scene, its name on the
// left, its number on the right, and the season band along the bottom when the
// caller has stats. Nothing is letterboxed and nothing is squashed: the scene is
// drawn at the hero's real dimensions, so the sky and water fill the width and the
// pet is sized by the SAME head-clearance cap the strip and the card use (see
// capCell in petScene), which is what keeps a party hat, a halo or the PRIME crest
// inside the frame.
export async function petHeroPng(opts: PetHeroOpts): Promise<Buffer> {
  // Same cache contract as the card: stats are shared global state that moves on
  // every death, so keying on them would invalidate every hero at once. They stay
  // out of the key and the entry gets a short TTL instead.
  const { stats: _st, ...keyOpts } = opts;
  const cacheKey = `hero:${JSON.stringify(keyOpts)}`;
  const hit = renderCacheGet(cacheKey);
  if (hit) return hit;
  const w = HERO_W;
  const h = HERO_H;
  const number = opts.number ?? "";
  const numBare = number.replace(/^No\.\s*/i, "");
  const scene: PetSceneOpts = {
    mood: opts.mood,
    toys: opts.toys ?? 0,
    timeOfDay: opts.timeOfDay ?? timeOfDayFor(new Date()),
    seed: opts.seed,
    stage: opts.stage,
    shellCap: opts.shellCap,
    // A memorial engraves the pet's number on its headstone, as the square card's
    // memorial variant does. Ignored by every living scene.
    label: numBare || undefined,
    // The mark is printed once, by the lockup below: left it landed on the horizon
    // line in the banded composition and read as a smudge.
    hideWordmark: true,
  };
  // A memorial carries no season stats (same gate as the pass: dead pets show no
  // live figures), so it always takes the bare scene, which lays its cemetery out
  // for a wide frame on its own.
  const body =
    opts.stats && opts.mood !== "gone"
      ? stripWithBand(w, h, scene, opts.stats, false)
      : petScene(w, h, scene);

  // Identity, kept to the outer thirds so it can never touch the pet: the pet
  // block is centred and about a fifth of the width, and its props (sparkles, the
  // rain cloud, the sleep zs, the ball and the duck) reach at most ~2.5 cells past
  // it. Name plus mark on the left, number on the right, all sitting on a soft
  // edge scrim so foam type stays legible against a bright day sky as well as a
  // night one. The scrim is deliberately EDGE-ONLY: a full-width top bar would
  // wash over the very head props this frame exists to protect.
  const pad = Math.round(w * 0.027);
  const textTop = Math.round(h * 0.14);
  const markY = Math.round(h * 0.225);
  const scrimW = Math.round(w * 0.36);
  const name = opts.name ?? "";
  const nameFs = fitFont(name.length, w * 0.3, Math.round(h * 0.12), 34);
  const numFs = Math.round(h * 0.058);
  const markFs = Math.round(h * 0.05);
  const idMarkup =
    (name
      ? `<text x="${pad}" y="${textTop}" font-family="Arial, Helvetica, sans-serif" font-size="${nameFs}" font-weight="800" letter-spacing="0.5" fill="${C.foam}">${name}</text>`
      : "") +
    `<text x="${pad}" y="${markY}" font-family="Arial, Helvetica, sans-serif" font-size="${markFs}" font-weight="800" letter-spacing="4" fill="${C.foamDim}" fill-opacity="0.8">${RUNNER_THEME.gameName}<tspan fill="${C.salmon}">.</tspan></text>` +
    (number
      ? `<text x="${w - pad}" y="${textTop}" text-anchor="end" font-family="Arial, Helvetica, sans-serif" font-size="${numFs}" font-weight="700" fill="${C.foamDim}">${number}</text>`
      : "");

  const hero = `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}">
    <defs>
      <linearGradient id="hsl" x1="0" y1="0" x2="1" y2="0"><stop offset="0" stop-color="#061820" stop-opacity="0.55"/><stop offset="1" stop-color="#061820" stop-opacity="0"/></linearGradient>
      <linearGradient id="hsr" x1="1" y1="0" x2="0" y2="0"><stop offset="0" stop-color="#061820" stop-opacity="0.55"/><stop offset="1" stop-color="#061820" stop-opacity="0"/></linearGradient>
    </defs>
    ${embedScene(body)}
    <rect x="0" y="0" width="${scrimW}" height="${h}" fill="url(#hsl)"/>
    <rect x="${w - scrimW}" y="0" width="${scrimW}" height="${h}" fill="url(#hsr)"/>
    ${idMarkup}
  </svg>`;
  const png = await boundedRaster(() => svgToPng(hero));
  // Short TTL for the same reason the card has one: the band's figures are not in
  // the cache key.
  renderCachePut(cacheKey, png, 60_000);
  return png;
}

export interface PetPortraitOpts {
  seed?: string; // tokenId (or serial) -> generative traits (works pre-mint)
  mood?: PetMood;
  toys?: number;
  number?: string; // "No. 0042"
  size?: number;
  stage?: Stage; // evolution stage (v2); undefined renders today's GROWN size
  shellCap?: boolean; // day-one hatchling eggshell cap
}

// A clean, cacheable SQUARE portrait: the generative pet on a branded rounded tile
// with the WALLETCHI mark + number + a rarity badge. Same renderer as the pass /
// variety sheet, keyed by tokenId (so the site can show sample pets pre-mint).
export async function petPortraitPng(opts: PetPortraitOpts): Promise<Buffer> {
  const cacheKey = `portrait:${JSON.stringify(opts)}`;
  const cached = renderCacheGet(cacheKey);
  if (cached) return cached;
  const S = opts.size ?? 800;
  const inner = embedScene(
    petScene(S, S, { mood: opts.mood ?? "happy", toys: opts.toys ?? 0, timeOfDay: "day", seed: opts.seed, stage: opts.stage, shellCap: opts.shellCap, hideWordmark: true }),
  );
  const traits = traitsFor(opts.seed ?? "1");
  const badgeColor =
    traits.names.rarity === "Grail" ? "#F4C542" : traits.names.rarity === "Rare" ? "#8FE0FF" : traits.names.rarity === "Uncommon" ? "#FF9EC4" : null;
  const badge = badgeColor
    ? `<rect x="${S - S * 0.30}" y="${S * 0.03}" width="${S * 0.26}" height="${S * 0.07}" rx="${S * 0.035}" fill="${badgeColor}"/><text x="${S - S * 0.17}" y="${S * 0.083}" text-anchor="middle" font-family="Arial, Helvetica, sans-serif" font-size="${S * 0.035}" font-weight="800" fill="#1A1A1A">${traits.names.accessory.toUpperCase()}</text>`
    : "";
  const card = `<svg xmlns="http://www.w3.org/2000/svg" width="${S}" height="${S}" viewBox="0 0 ${S} ${S}">
    <defs><clipPath id="pw"><rect x="0" y="0" width="${S}" height="${S}" rx="${S * 0.06}"/></clipPath></defs>
    <g clip-path="url(#pw)">${inner}</g>
    <rect x="0" y="0" width="${S}" height="${S * 0.14}" fill="#0A1E28" fill-opacity="0.4"/>
    <text x="${S * 0.05}" y="${S * 0.1}" font-family="Arial, Helvetica, sans-serif" font-size="${S * 0.06}" font-weight="800" letter-spacing="1" fill="${C.foam}">${RUNNER_THEME.gameName}<tspan fill="${C.salmon}">.</tspan></text>
    ${opts.number ? `<text x="${S * 0.05}" y="${S * 0.96}" font-family="Arial, Helvetica, sans-serif" font-size="${S * 0.045}" font-weight="700" fill="${C.foam}">${opts.number}</text>` : ""}
    ${badge}
    <rect x="1.5" y="1.5" width="${S - 3}" height="${S - 3}" rx="${S * 0.06}" fill="none" stroke="${C.riverLight}" stroke-width="3"/>
  </svg>`;
  const png = await boundedRaster(() => svgToPng(card));
  renderCachePut(cacheKey, png);
  return png;
}

const fmtN = (n: number) => n.toLocaleString("en-US");

export type PetCardVariant = "alive" | "memorial" | "final" | "victory" | "evolved";

export interface PetCardOpts {
  mood: PetMood;
  toys?: number;
  timeOfDay?: TimeOfDay;
  number?: string; // e.g. "No. 0042"
  seed?: string; // tokenId (or serial) for the generative traits
  survivorCount?: { alive: number; total: number };
  variant?: PetCardVariant;
  memorial?: { livedDays: number; cared: number; outlasted?: number; epitaph?: string };
  potDisplay?: string; // victory pot, e.g. "12,400 CARE"
  stats?: PassStats; // triple stat band (flag-gated by callers); wins over survivorCount
  stage?: Stage; // evolution stage (v2); drives the pet size + the evolved banner
  shellCap?: boolean; // day-one hatchling eggshell cap
}

// The shareable social card: the metadata / email hero, and the emotional peak
// compositions. Composed as a SELF-CONTAINED image: the WALLETCHI mark + the pet
// number stay legible in a bare screenshot, and the status (survivor count, stats,
// pot) is the bold screenshottable brag. Square (1080) for social + NFT galleries.
export async function petCardPng(opts: PetCardOpts): Promise<Buffer> {
  // The cache key deliberately EXCLUDES survivorCount: it is shared, global
  // state that changes on every death, so keying on it would invalidate every
  // cached card at once (a re-raster storm across the collection). Instead the
  // entry gets a short TTL, so the count on a cached card is at most a minute
  // stale. potDisplay stays in the key: it is per-pet and only set at Victory.
  const { survivorCount: _sc, stats: _st, ...keyOpts } = opts;
  const cacheKey = `card:${JSON.stringify(keyOpts)}`;
  const hit = renderCacheGet(cacheKey);
  if (hit) return hit;
  const S = 1080;
  const variant = opts.variant ?? "alive";
  const number = opts.number ?? "";
  const numBare = number.replace(/^No\.\s*/i, "");
  const winX = 60;
  const winY = 196;
  const winW = S - 120;
  const winH = 560;

  const sceneOpts: PetSceneOpts =
    variant === "victory"
      ? { mood: "happy", toys: 3, timeOfDay: "day", seed: opts.seed, stage: opts.stage, shellCap: opts.shellCap }
      : variant === "evolved"
        ? { mood: "happy", toys: opts.toys ?? 0, timeOfDay: "day", seed: opts.seed, stage: opts.stage ?? 3, shellCap: false }
        : variant === "memorial"
          ? { mood: "gone", label: numBare || undefined, seed: opts.seed }
          : { mood: opts.mood, toys: opts.toys ?? 0, timeOfDay: opts.timeOfDay ?? "dusk", seed: opts.seed, stage: opts.stage, shellCap: opts.shellCap };
  // The card prints the wordmark in its header AND its footer, so the art window
  // does not need a third one sitting on the water.
  const sceneInner = embedScene(petScene(winW, winH, { ...sceneOpts, hideWordmark: true }));

  // Per-variant palette.
  const V = {
    alive: { bgA: "#0E2A3A", bgB: "#15505F", ink: C.foam, sub: C.foamDim, accent: C.salmon, border: C.riverLight },
    memorial: { bgA: "#20183A", bgB: "#4A3C63", ink: "#EAE6F2", sub: "#C6BBD8", accent: "#F6B0C0", border: "#6E5A86" },
    final: { bgA: "#160B10", bgB: "#080506", ink: "#F7EFD6", sub: "#C7A98F", accent: "#F4C542", border: "#7A2A2E" },
    victory: { bgA: "#FFE9A8", bgB: "#D2861F", ink: "#3A2A08", sub: "#6B4E12", accent: "#B4341F", border: "#F6D67A" },
    // The evolved card keeps the alive palette (this pet is thriving, not gone)
    // with the salmon accent leading the celebratory banner.
    evolved: { bgA: "#0E2A3A", bgB: "#15505F", ink: C.foam, sub: C.foamDim, accent: C.salmon, border: C.riverLight },
  }[variant];

  // Header: wordmark (always legible) + pet number.
  const header = `<text x="64" y="132" font-family="Arial, Helvetica, sans-serif" font-size="60" font-weight="800" letter-spacing="1" fill="${V.ink}">${RUNNER_THEME.gameName}<tspan fill="${V.accent}">.</tspan></text>
    ${number ? `<text x="${S - 64}" y="128" text-anchor="end" font-family="Arial, Helvetica, sans-serif" font-size="40" font-weight="700" fill="${V.sub}">${number}</text>` : ""}`;

  // The flex band under the scene: the screenshottable brag, per variant.
  const bandTop = winY + winH + 26; // ~782
  const ctext = (y: number, size: number, weight: number, fill: string, str: string, ls = 0) =>
    `<text x="${S / 2}" y="${y}" text-anchor="middle" font-family="Arial, Helvetica, sans-serif" font-size="${size}" font-weight="${weight}" letter-spacing="${ls}" fill="${fill}">${str}</text>`;

  let band = "";
  let bgDefs = "";
  let bgFill = `<rect width="${S}" height="${S}" fill="url(#cbg)"/>`;
  let overlay = "";

  if (variant === "alive") {
    bgDefs = `<linearGradient id="cbg" x1="0" y1="0" x2="0.3" y2="1"><stop offset="0" stop-color="${V.bgA}"/><stop offset="1" stop-color="${V.bgB}"/></linearGradient>`;
    if (opts.stats) {
      // The season ticker: three SEPARATE stat chips, each with its own pixel
      // glyph, accent-tinted border, and value halo. FDV takes the middle chip
      // once a CARE pool exists; POT holds it until then. Values auto-fit so a
      // long FDV string never touches a chip edge.
      const st = opts.stats;
      const bx = 60;
      const bw = S - 120;
      const gap = 24;
      const chipW = (bw - 2 * gap) / 3;
      const chipH = 158;
      const chips: Array<{ icon: keyof typeof GLYPHS; label: string; value: string; plainLen: number; fill: string }> = [
        {
          icon: "heart",
          label: "ALIVE",
          value: `${fmtN(st.alive)} <tspan fill="${V.sub}" font-size="34" font-weight="700">/ ${fmtN(st.total)}</tspan>`,
          plainLen: fmtN(st.alive).length + Math.ceil((fmtN(st.total).length + 2) * 0.6),
          fill: V.accent,
        },
        st.fdv
          ? { icon: "gem", label: "FDV", value: st.fdv, plainLen: st.fdv.length, fill: "#F6CE53" }
          : { icon: "gem", label: "POT", value: st.pot, plainLen: st.pot.length, fill: "#F6CE53" },
        { icon: "flame", label: "BURNED", value: st.burned, plainLen: st.burned.length, fill: "#FF9E80" },
      ];
      band = chips
        .map((c, i) => {
          const x = bx + i * (chipW + gap);
          const cx = x + chipW / 2;
          const fs = fitFont(c.plainLen, chipW - 56, 56);
          const labelFs = 24;
          const cell = 3;
          const iconW = 7 * cell;
          const labelEst = c.label.length * labelFs * 0.62;
          const iconX = cx - (labelEst + iconW + 10) / 2;
          return (
            // Soft outer glow, then the chip, then glyph + label row, then the
            // haloed value (stroke halo first, crisp fill on top).
            `<rect x="${x - 3}" y="${bandTop - 3}" width="${chipW + 6}" height="${chipH + 6}" rx="27" fill="none" stroke="${c.fill}" stroke-opacity="0.22" stroke-width="6"/>` +
            `<rect x="${x}" y="${bandTop}" width="${chipW}" height="${chipH}" rx="24" fill="#08161E" fill-opacity="0.78" stroke="${c.fill}" stroke-opacity="0.85" stroke-width="2.5"/>` +
            statGlyph(c.icon, iconX, bandTop + 26, cell) +
            `<text x="${iconX + iconW + 10}" y="${bandTop + 44}" font-family="Arial, Helvetica, sans-serif" font-size="${labelFs}" font-weight="700" letter-spacing="5" fill="${V.sub}">${c.label}</text>` +
            `<text x="${cx}" y="${bandTop + 118}" text-anchor="middle" font-family="Arial, Helvetica, sans-serif" font-size="${fs}" font-weight="800" fill="none" stroke="${c.fill}" stroke-opacity="0.18" stroke-width="8">${c.value}</text>` +
            `<text x="${cx}" y="${bandTop + 118}" text-anchor="middle" font-family="Arial, Helvetica, sans-serif" font-size="${fs}" font-weight="800" fill="${c.fill}">${c.value}</text>`
          );
        })
        .join("");
    } else if (opts.survivorCount) {
      const { alive, total } = opts.survivorCount;
      band =
        `<rect x="${S / 2 - 320}" y="${bandTop}" width="640" height="150" rx="30" fill="#08161E" fill-opacity="0.55" stroke="${V.border}" stroke-width="2"/>` +
        ctext(bandTop + 52, 30, 700, V.sub, "PETS ALIVE", 4) +
        ctext(bandTop + 120, 76, 800, V.accent, `${fmtN(alive)} <tspan fill="${V.sub}" font-size="46">/ ${fmtN(total)}</tspan>`);
    } else {
      band = ctext(bandTop + 70, 34, 600, V.sub, RUNNER_THEME.tagline);
    }
  } else if (variant === "memorial") {
    bgDefs = `<linearGradient id="cbg" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="${V.bgA}"/><stop offset="1" stop-color="${V.bgB}"/></linearGradient>`;
    const m = opts.memorial ?? { livedDays: 0, cared: 0 };
    band =
      ctext(bandTop + 30, 26, 700, V.accent, "IN LOVING MEMORY", 5) +
      ctext(bandTop + 92, 52, 800, V.ink, `LIVED ${fmtN(m.livedDays)} DAY${m.livedDays === 1 ? "" : "S"}`) +
      ctext(bandTop + 146, 40, 700, V.sub, `Cared for ${fmtN(m.cared)} time${m.cared === 1 ? "" : "s"}${m.outlasted != null ? `  |  Outlasted ${fmtN(m.outlasted)}` : ""}`);
  } else if (variant === "final") {
    bgDefs = `<radialGradient id="cbg" cx="0.5" cy="0.42" r="0.75"><stop offset="0" stop-color="${V.bgA}"/><stop offset="1" stop-color="${V.bgB}"/></radialGradient>`;
    const alive = opts.survivorCount?.alive ?? 2;
    const total = opts.survivorCount?.total ?? 2000;
    overlay = `<rect width="${S}" height="${S}" fill="url(#cbg)" opacity="0"/>`;
    band =
      ctext(bandTop + 24, 28, 700, V.accent, "THE SURVIVORS", 6) +
      ctext(bandTop + 128, 116, 800, V.ink, `${fmtN(alive)} LEFT`) +
      ctext(bandTop + 172, 32, 700, V.sub, `of ${fmtN(total)}`);
  } else if (variant === "evolved") {
    // The shareable evolution moment: victory-style rays but in the alive palette
    // (foam over teal), a salmon banner, and the "EVOLVED TO <STAGE>" brag.
    bgDefs = `<radialGradient id="cbg" cx="0.5" cy="0.4" r="0.9"><stop offset="0" stop-color="#1C6675"/><stop offset="0.55" stop-color="${V.bgA}"/><stop offset="1" stop-color="#081A24"/></radialGradient>`;
    const rays = Array.from({ length: 12 }, (_, i) => {
      const a = (i * 30 * Math.PI) / 180;
      const x = S / 2 + Math.cos(a) * S;
      const y = winY + winH / 2 + Math.sin(a) * S;
      const x2 = S / 2 + Math.cos(a + 0.12) * S;
      const y2 = winY + winH / 2 + Math.sin(a + 0.12) * S;
      return `<path d="M ${S / 2} ${winY + winH / 2} L ${x.toFixed(0)} ${y.toFixed(0)} L ${x2.toFixed(0)} ${y2.toFixed(0)} Z" fill="#EAF3F5" fill-opacity="0.08"/>`;
    }).join("");
    overlay = rays;
    band =
      `<rect x="${S / 2 - 300}" y="${bandTop + 6}" width="600" height="60" rx="30" fill="${V.accent}"/>` +
      ctext(bandTop + 48, 30, 800, "#FFF6E0", EVOLUTION_COPY.cardBanner(opts.stage ?? 3), 4) +
      ctext(bandTop + 138, 84, 800, V.ink, "IT EVOLVED") +
      ctext(bandTop + 182, 32, 700, V.sub, "Loved, grown, and thriving.");
  } else {
    // victory
    bgDefs = `<radialGradient id="cbg" cx="0.5" cy="0.4" r="0.85"><stop offset="0" stop-color="#FFF6D8"/><stop offset="0.5" stop-color="${V.bgA}"/><stop offset="1" stop-color="${V.bgB}"/></radialGradient>`;
    const rays = Array.from({ length: 12 }, (_, i) => {
      const a = (i * 30 * Math.PI) / 180;
      const x = S / 2 + Math.cos(a) * S;
      const y = winY + winH / 2 + Math.sin(a) * S;
      const x2 = S / 2 + Math.cos(a + 0.12) * S;
      const y2 = winY + winH / 2 + Math.sin(a + 0.12) * S;
      return `<path d="M ${S / 2} ${winY + winH / 2} L ${x.toFixed(0)} ${y.toFixed(0)} L ${x2.toFixed(0)} ${y2.toFixed(0)} Z" fill="#FFF6D8" fill-opacity="0.10"/>`;
    }).join("");
    overlay = rays;
    band =
      `<rect x="${S / 2 - 260}" y="${bandTop + 6}" width="520" height="60" rx="30" fill="${V.accent}"/>` +
      ctext(bandTop + 48, 30, 800, "#FFF6E0", VICTORY_COPY.banner, 4) +
      ctext(bandTop + 132, 92, 800, V.ink, "WINNER") +
      (opts.potDisplay ? ctext(bandTop + 178, 36, 700, V.sub, `POT ${opts.potDisplay}`) : "");
  }

  const footer = `<text x="64" y="${S - 40}" font-family="Arial, Helvetica, sans-serif" font-size="24" fill="${V.sub}" fill-opacity="0.9">${RUNNER_THEME.tagline}</text>
    <text x="${S - 64}" y="${S - 40}" text-anchor="end" font-family="Arial, Helvetica, sans-serif" font-size="24" font-weight="700" fill="${V.sub}" fill-opacity="0.9">${RUNNER_THEME.gameName}</text>`;

  const card = `<svg xmlns="http://www.w3.org/2000/svg" width="${S}" height="${S}" viewBox="0 0 ${S} ${S}">
    <defs>${bgDefs}<clipPath id="cwin"><rect x="${winX}" y="${winY}" width="${winW}" height="${winH}" rx="36"/></clipPath></defs>
    ${bgFill}${overlay}
    <g clip-path="url(#cwin)"><g transform="translate(${winX} ${winY})">${sceneInner}</g></g>
    <rect x="${winX}" y="${winY}" width="${winW}" height="${winH}" rx="36" fill="none" stroke="${V.border}" stroke-width="3"/>
    ${header}${band}${footer}
  </svg>`;
  const png = await boundedRaster(() => svgToPng(card));
  // Short TTL: the survivor count is not in the key (see above), so the cached
  // composition must refresh on its own clock.
  renderCachePut(cacheKey, png, 60_000);
  return png;
}
