import { petGameSpriteSvg, GAME_SPRITE, type GameFace } from "./pet.js";
import { traitsFor, BODY_PALETTES } from "./traits.js";
import { RIVER_COLORS as C, RUNNER_THEME } from "./theme.js";
import type { Stage } from "./stage.js";
import { paint, landscape, colourField, portraitBackdrop, SKIES, hex, lerpC, type Scene, type RGB } from "./album-paint.js";

// PHOTO ALBUM art: five pictures a living pet's keeper can save. Every Chi is
// drawn as its own pass sprite (petGameSpriteSvg: the exact pixel art on the
// pass, same traits, same evolution crest), so a keeper always recognises their
// pet, standing in a PAINTED scene (album-paint.ts). The router rasterises them.
//
//   banner     1500 x 500   X header (Discord crops the same art to its 17:6)
//   pfp        1000 x 1000  one framing for every Chi, like a collection PFP
//   wallpaper  1290 x 2796  iPhone lock screen; the top third stays clear for the clock
//   poster     1600 x 2000  every living Chi, branding only, made to share
//   class      2400 x 1600  every living Chi on the risers, a silly class photo

export type AlbumKind = "banner" | "pfp" | "wallpaper" | "poster" | "class";
export const ALBUM_KINDS: readonly AlbumKind[] = ["banner", "pfp", "wallpaper", "poster", "class"];
export const ALBUM_LABELS: Record<AlbumKind, string> = {
  banner: "Banner",
  pfp: "PFP",
  wallpaper: "Wallpaper",
  poster: "Poster",
  class: "Class photo",
};
export const ALBUM_SIZES: Record<AlbumKind, { w: number; h: number }> = {
  banner: { w: 1500, h: 500 },
  pfp: { w: 1000, h: 1000 },
  wallpaper: { w: 1290, h: 2796 },
  poster: { w: 1600, h: 2000 },
  class: { w: 2400, h: 1600 },
};

export interface AlbumPet {
  seed: string; // tokenId (or serial): the generative traits
  stage?: Stage;
  name: string;
  number: string; // "No. 0159"
}
export type CastPet = Pick<AlbumPet, "seed" | "stage">;

const FONT = "Arial, Helvetica, sans-serif";
const SP = GAME_SPRITE.cell * GAME_SPRITE.cols; // sprite viewBox side (px)

// Deterministic 0..1 noise from integers, so every render of the same art is identical.
function rnd(a: number, b = 0): number {
  let h = (a * 374761393 + b * 668265263) | 0;
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  h ^= h >>> 16;
  return (h >>> 0) / 4294967296;
}
const seedNum = (seed: string) => {
  let h = 0;
  for (const ch of seed) h = (Math.imul(h, 31) + ch.charCodeAt(0)) | 0;
  return Math.abs(h);
};

/** One pet sprite as a nested svg: `size` is the sprite square, (cx, feet) the bottom centre of its body. */
function sprite(pet: CastPet, face: GameFace, cx: number, feet: number, size: number, rot = 0): string {
  const inner = petGameSpriteSvg(pet.seed, face, pet.stage).replace(/^<svg[^>]*>/, "").replace(/<\/svg>\s*$/, "");
  const cell = size / GAME_SPRITE.cols;
  const x = cx - GAME_SPRITE.bodyCx * cell;
  const y = feet - (GAME_SPRITE.bodyCy + GAME_SPRITE.bodyR) * cell;
  const svg = `<svg x="${x.toFixed(1)}" y="${y.toFixed(1)}" width="${size.toFixed(1)}" height="${size.toFixed(1)}" viewBox="0 0 ${SP} ${SP}" shape-rendering="crispEdges">${inner}</svg>`;
  return rot ? `<g transform="rotate(${rot} ${cx.toFixed(1)} ${(feet - size * 0.3).toFixed(1)})">${svg}</g>` : svg;
}
const shadow = (cx: number, feet: number, size: number, op = 0.28) =>
  `<ellipse cx="${cx.toFixed(1)}" cy="${(feet + size * 0.012).toFixed(1)}" rx="${(size * 0.3).toFixed(1)}" ry="${(size * 0.045).toFixed(1)}" fill="#000" fill-opacity="${op}"/>`;

function wordmark(x: number, y: number, size: number, anchor: "start" | "middle" | "end" = "start", fill: string = C.foam, op = 1): string {
  return `<text x="${x}" y="${y}" text-anchor="${anchor}" font-family="${FONT}" font-size="${size}" font-weight="800" letter-spacing="${(size * 0.02).toFixed(1)}" fill="${fill}" fill-opacity="${op}">${RUNNER_THEME.gameName}<tspan fill="${C.salmon}" fill-opacity="1">.</tspan></text>`;
}

const paletteIndex = (seed: string) => Math.max(0, BODY_PALETTES.findIndex((p) => p.name === traitsFor(seed).palette.name));

// Mix two #rrggbb colours (t = 0 -> a, 1 -> b).
function mix(a: string, b: string, t: number): string {
  const pa = [1, 3, 5].map((i) => parseInt(a.slice(i, i + 2), 16));
  const pb = [1, 3, 5].map((i) => parseInt(b.slice(i, i + 2), 16));
  return "#" + pa.map((v, i) => Math.round(v + (pb[i]! - v) * t).toString(16).padStart(2, "0")).join("");
}

const doc = (w: number, h: number, body: string, defs = "") =>
  `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}"><defs>${defs}</defs>${body}</svg>`;

// Which painted sky a pet gets: fixed per pet (its seed), so its banner and wallpaper match.
const skyFor = (seed: string) => SKIES[seedNum(seed) % SKIES.length]!;
const glowDef = (c: string, op: number) =>
  `<radialGradient id="glow"><stop offset="0" stop-color="${c}" stop-opacity="${op}"/><stop offset="1" stop-color="${c}" stop-opacity="0"/></radialGradient>`;

// ===========================================================================
// BANNER: a painted landscape, the Chi standing in the meadow on the right
// third (X puts the avatar over the lower left). No words: the art is the brand.
// ===========================================================================
export function bannerSvg(pet: AlbumPet): string {
  const { w, h } = ALBUM_SIZES.banner;
  const n = seedNum(pet.seed);
  const sky = skyFor(pet.seed);
  const scene = landscape(w, h, sky, n, { horizon: 0.6, sunX: 0.3, sunY: 0.36, cloud: 0.6 });
  const size = 420;
  const cx = 1110;
  const feet = 462;
  const body = `
    ${paint(w, h, scene, { seed: n, brush: 1 / 30 })}
    <circle cx="${cx}" cy="${feet - size * 0.35}" r="${size * 0.55}" fill="url(#glow)"/>
    ${shadow(cx, feet, size, 0.3)}
    ${sprite(pet, "happy", cx, feet, size)}`;
  return doc(w, h, body, glowDef(sky.sun, 0.32));
}

// ===========================================================================
// PFP: one framing for every Chi (a collection look): a painted gouache ground
// in a pastel opposite its body hue, the whole Chi centred, a soft light pool.
// ===========================================================================
export function pfpSvg(pet: CastPet): string {
  const { w, h } = ALBUM_SIZES.pfp;
  const i = paletteIndex(pet.seed);
  const opp = BODY_PALETTES[(i + 8) % BODY_PALETTES.length]!;
  const base = mix(opp.B, "#ffffff", 0.35);
  const light = mix(opp.L, "#ffffff", 0.45);
  const n = seedNum(pet.seed);
  const scene = colourField(w, h, base, light, n, 0.5, 0.46);
  const size = 760;
  const feet = 850;
  const body = `
    ${paint(w, h, scene, { seed: n, brush: 1 / 22, grain: 0.6 })}
    ${shadow(w / 2, feet, size, 0.18)}
    ${sprite(pet, "happy", w / 2, feet, size)}`;
  return doc(w, h, body);
}

// ===========================================================================
// WALLPAPER: a tall painted landscape under its sky (the clock owns the top
// third), the Chi standing in the meadow.
// ===========================================================================
export function wallpaperSvg(pet: AlbumPet): string {
  const { w, h } = ALBUM_SIZES.wallpaper;
  const n = seedNum(pet.seed);
  const sky = skyFor(pet.seed);
  const scene = landscape(w, h, sky, n + 5, { horizon: 0.66, sunX: 0.72, sunY: 0.42, cloud: 0.5 });
  const size = 860;
  const feet = h * 0.86;
  const body = `
    ${paint(w, h, scene, { seed: n + 5, brush: 1 / 32 })}
    <circle cx="${w / 2}" cy="${feet - size * 0.35}" r="${size * 0.6}" fill="url(#glow)"/>
    ${shadow(w / 2, feet, size, 0.3)}
    ${sprite(pet, "happy", w / 2, feet, size)}`;
  return doc(w, h, body, glowDef(sky.sun, 0.28));
}

// ===========================================================================
// POSTER: every living Chi gathered on a painted golden-hour hillside, the sun
// behind them, the WALLETCHI mark in the sky. No words but the brand.
// ===========================================================================
export function posterSvg(cast: CastPet[]): string {
  const { w, h } = ALBUM_SIZES.poster;
  const sky = SKIES[0]!;
  const scene = landscape(w, h, sky, 4242, { horizon: 0.5, sunX: 0.5, sunY: 0.4, cloud: 0.7 });
  const crowd = crowdLayout(cast.length, w, h * 0.6, h * 0.97);
  let pets = "";
  for (const slot of crowd) pets += shadow(slot.x, slot.y, slot.size, 0.22) + sprite(cast[slot.index]!, "happy", slot.x, slot.y, slot.size);
  const body = `
    ${paint(w, h, scene, { seed: 4242, brush: 1 / 30 })}
    ${wordmark(w / 2, 300, 236, "middle")}
    ${pets}`;
  return doc(w, h, body);
}

interface Slot { index: number; x: number; y: number; size: number }

// Rows of a crowd between yTop (back row feet) and yBot (front row feet), sized
// so every pet fits. Back rows are smaller (perspective); slots are jittered.
function crowdLayout(n: number, w: number, yTop: number, yBot: number): Slot[] {
  if (n === 0) return [];
  let rows = 1;
  while (rows < 12) {
    const sizes = Array.from({ length: rows }, (_, r) => rowSize(r, rows, yTop, yBot));
    const cap = sizes.reduce((a, s) => a + Math.floor((w * 0.94) / (s * 0.62)), 0);
    if (cap >= n) break;
    rows += 1;
  }
  const sizes = Array.from({ length: rows }, (_, r) => rowSize(r, rows, yTop, yBot));
  const caps = sizes.map((s) => Math.max(1, Math.floor((w * 0.94) / (s * 0.62))));
  // fill from the front row back, so the front is always full
  const counts = new Array(rows).fill(0) as number[];
  let left = n;
  for (let r = rows - 1; r >= 0 && left > 0; r--) {
    counts[r] = Math.min(caps[r]!, left);
    left -= counts[r]!;
  }
  const out: Slot[] = [];
  let idx = 0;
  for (let r = 0; r < rows; r++) {
    const c = counts[r]!;
    const s = sizes[r]!;
    const y = rows === 1 ? yBot : yTop + ((yBot - yTop) * r) / (rows - 1);
    const span = Math.min(w * 0.94, c * s * 0.62);
    for (let i = 0; i < c; i++) {
      const x = w / 2 - span / 2 + (span * (i + 0.5)) / c + (rnd(r, i) - 0.5) * s * 0.12;
      out.push({ index: idx++, x, y: y + (rnd(i, r + 50) - 0.5) * s * 0.05, size: s });
    }
  }
  return out;
}
const rowSize = (r: number, rows: number, yTop: number, yBot: number) => {
  const t = rows === 1 ? 1 : r / (rows - 1);
  const front = Math.min(300, (yBot - yTop) * 0.9);
  return front * (0.55 + 0.45 * t);
};

// ===========================================================================
// CLASS PHOTO: the painted school-portrait cloth, painted risers, every living
// Chi in rows, a few pulling faces, one tilting, the last one jumping in late.
// Bunting overhead and a felt letter board in front.
// ===========================================================================
export function classSvg(cast: CastPet[], year = new Date().getUTCFullYear()): string {
  const { w, h } = ALBUM_SIZES.class;
  const n = cast.length;
  const perRow = Math.max(6, Math.ceil(Math.sqrt(n * 2.9)));
  const rows = Math.max(1, Math.ceil(n / perRow));
  const size = Math.min(300, (w * 0.9) / (perRow * 0.6));
  const rowGap = size * 0.64;
  const frontFeet = h * 0.82;
  const feetOf = (r: number) => frontFeet - (rows - 1 - r) * rowGap;
  const insetOf = (r: number) => (rows - 1 - r) * size * 0.12;
  // the risers are painted into the scene, so they share the brushwork
  const back = portraitBackdrop(w, h, frontFeet + rowGap * 0.6, 777);
  const step = hex("#9AA7B5"), stepD = hex("#7F8C9B"), lip = hex("#D3DCE6");
  const scene: Scene = {
    color(x, y) {
      for (let r = rows - 1; r >= 0; r--) {
        const top = feetOf(r);
        const inset = insetOf(r);
        if (y >= top && y < top + rowGap + 4 && x > w * 0.04 + inset && x < w * 0.96 - inset) {
          if (y < top + 10) return lip;
          return lerpC(step, stepD, (y - top) / rowGap) as RGB;
        }
      }
      return back.color(x, y);
    },
    flow(x, y) {
      for (let r = 0; r < rows; r++) if (y >= feetOf(r) && y < feetOf(r) + rowGap) return 0;
      return back.flow(x, y);
    },
  };
  const faces: GameFace[] = ["yell", "dizzy", "aim"];
  const per: number[] = [];
  let leftN = n;
  for (let r = rows - 1; r >= 0; r--) {
    per[r] = Math.min(perRow, leftN);
    leftN -= per[r]!;
  }
  let pets = "";
  let k = 0;
  for (let r = 0; r < rows; r++) {
    const c = per[r]!;
    const feet = feetOf(r);
    const span = Math.min(w * 0.9 - 2 * insetOf(r), c * size * 0.6);
    for (let i = 0; i < c; i++) {
      const pet = cast[k]!;
      const roll = rnd(k, 1234);
      // about one in seven pulls a face; a few tilt their heads; the last one jumps in late
      const face: GameFace = roll < 0.15 ? faces[Math.floor(rnd(k, 99) * faces.length)]! : "happy";
      let rot = roll > 0.93 ? (rnd(k, 5) < 0.5 ? -12 : 12) : (rnd(k, 7) - 0.5) * 4;
      let lift = 0;
      if (k === n - 1 && n > 3) {
        lift = size * 0.55;
        rot = -14;
      }
      const x = w / 2 - span / 2 + (span * (i + 0.5)) / c;
      pets += (lift ? "" : shadow(x, feet, size, 0.25)) + sprite(pet, lift ? "yell" : face, x, feet - lift, size, rot);
      k++;
    }
  }
  let bunting = `<path d="M0 60 Q${w / 2} 200 ${w} 60" fill="none" stroke="#2A2320" stroke-width="4"/>`;
  const flags = [C.salmon, "#FFDB4E", "#3FD1CB", "#A98BEA", "#6FE39B", "#FF77BE"];
  for (let i = 0; i < 26; i++) {
    const x0 = (w / 26) * i;
    const sag = (t: number) => 60 + 70 * Math.sin(Math.PI * t);
    const y0 = sag(i / 26);
    const y1 = sag((i + 1) / 26);
    bunting += `<path d="M${x0.toFixed(0)} ${y0.toFixed(0)} L${(x0 + w / 26).toFixed(0)} ${y1.toFixed(0)} L${(x0 + w / 52).toFixed(0)} ${((y0 + y1) / 2 + 80).toFixed(0)} Z" fill="${flags[i % flags.length]}"/>`;
  }
  const bw = 620;
  const bh = 200;
  const bx = w / 2 - bw / 2;
  const by = h - bh - 40;
  const board = `
    <rect x="${bx}" y="${by}" width="${bw}" height="${bh}" rx="10" fill="#B07A4A"/>
    <rect x="${bx + 14}" y="${by + 14}" width="${bw - 28}" height="${bh - 28}" rx="4" fill="#1E1E22"/>
    <g stroke="#2A2A30" stroke-width="2">${Array.from({ length: 9 }, (_, i) => `<line x1="${bx + 14}" x2="${bx + bw - 14}" y1="${by + 30 + i * 18}" y2="${by + 30 + i * 18}"/>`).join("")}</g>
    <text x="${w / 2}" y="${by + 84}" text-anchor="middle" font-family="${FONT}" font-size="48" font-weight="700" letter-spacing="6" fill="#F4F1EA">${RUNNER_THEME.gameName}</text>
    <text x="${w / 2}" y="${by + 150}" text-anchor="middle" font-family="${FONT}" font-size="44" font-weight="700" letter-spacing="5" fill="#F4F1EA">CLASS OF ${year}</text>`;
  const body = `
    ${paint(w, h, scene, { seed: 777, brush: 1 / 34 })}
    ${bunting}
    ${pets}
    ${board}`;
  return doc(w, h, body);
}
