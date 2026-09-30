// WALLETCHI care scenes: small animated pixel vignettes that play on the pass-tap
// care page while a feed lands on-chain and on the confirmation that follows. The
// creature is the keeper's ACTUAL pet hue (traitsFor(seed).palette), and each
// action has a few variants picked at random, so the every-day touchpoint of
// feeding is a tiny moment instead of a blank spinner that closes itself.
//
// Everything here is self-contained inline SVG + CSS keyframes (no images, no
// script, no network): the care/confirm pages are standalone wallet-webview HTML,
// so a scene has to carry its own art and motion. Pixels stay crisp via
// shape-rendering="crispEdges". Motion is translate-based (widely supported on
// iOS Safari); the few scale/rotate effects set transform-box:fill-box so their
// origin is the element's own box.

import { traitsFor, BODY_PALETTES, type BodyPalette } from "./traits.js";
import type { CareAction } from "./actions.js";

// The canonical 16x16 WALLETCHI sprite (mirror of web-cub PetSprite / the server
// card art vocabulary): a round blob, big eyes, salmon cheeks, a lavender sprout,
// tiny feet. Recolored per pet via the hue legend below.
const PET_SPRITE = [
  "......oSSo......",
  ".....oBBBBo.....",
  "....oBBBBBBo....",
  "...oBBBBBBBBo...",
  "..oBBBBBBBBBBo..",
  "..oBBBBBBBBBBo..",
  "..oBBEEBBEEBBo..",
  "..oBBEWBBWEBBo..",
  "..oBBEEBBEEBBo..",
  "..oCCBBmmBBCCo..",
  "..oBBBLLLLBBBo..",
  "..oBBLLLLLLBBo..",
  "...oBLLLLLLBo...",
  "...oBBBBBBBBo...",
  "....oBBBBBBo....",
  ".....bb..bb.....",
];

// Fixed (non-hue) sprite colors. o/B/b/L are overwritten per pet from its palette.
const PET_FIXED: Record<string, string> = {
  o: "#2f7d7a", // outline
  B: "#7fd0cb", // body
  b: "#5cb8b2", // body shade / feet
  L: "#f6eede", // belly / light
  C: "#ff9d82", // cheek (salmon)
  E: "#241f38", // eye
  W: "#ffffff", // eye shine
  S: "#a68fd8", // sprout (lavender)
  m: "#e07a72", // mouth
};

function darken(hex: string, amt: number): string {
  const n = parseInt(hex.slice(1), 16);
  const r = Math.round(((n >> 16) & 255) * (1 - amt));
  const g = Math.round(((n >> 8) & 255) * (1 - amt));
  const b = Math.round((n & 255) * (1 - amt));
  return `#${((r << 16) | (g << 8) | b).toString(16).padStart(6, "0")}`;
}

// The full pixel legend for a given body hue: the pet's own outline/body/belly
// over the fixed eyes/cheeks/sprout/mouth.
function legendFor(bp: BodyPalette): Record<string, string> {
  return { ...PET_FIXED, o: bp.O, B: bp.B, b: darken(bp.B, 0.16), L: bp.L };
}

// Render a pixel grid (string rows + a color legend) to <rect>s in local units,
// skipping "." and spaces. width/height 1.02 hides hairline seams between cells.
function pixels(rows: string[], legend: Record<string, string>): string {
  let out = "";
  for (let y = 0; y < rows.length; y++) {
    const row = rows[y]!;
    for (let x = 0; x < row.length; x++) {
      const ch = row[x]!;
      if (ch === "." || ch === " ") continue;
      const fill = legend[ch];
      if (!fill) continue;
      out += `<rect x="${x}" y="${y}" width="1.02" height="1.02" fill="${fill}"/>`;
    }
  }
  return out;
}

// Place a grid at (x,y) scaled by s. The OUTER group positions via a presentation
// attribute (never animated); the INNER group carries the CSS animation class, so
// a keyframe's transform composes with the placement instead of overriding it.
// An optional second class lets a scene stack two motions (e.g. reveal + idle).
function place(
  rows: string[],
  legend: Record<string, string>,
  x: number,
  y: number,
  s: number,
  cls = "",
  delay = 0,
  innerCls = "",
): string {
  const guts = innerCls ? `<g class="${innerCls}">${pixels(rows, legend)}</g>` : pixels(rows, legend);
  const anim = cls ? ` class="${cls}"` : "";
  const ds = delay ? ` style="animation-delay:${delay}s"` : "";
  return `<g transform="translate(${x} ${y}) scale(${s})"><g${anim}${ds}>${guts}</g></g>`;
}

function creature(bp: BodyPalette, x: number, y: number, s: number, cls = "", delay = 0, innerCls = ""): string {
  return place(PET_SPRITE, legendFor(bp), x, y, s, cls, delay, innerCls);
}

// A soft contact shadow so a standing pet reads as grounded, not floating.
function shadow(cx: number, cy: number, rx: number): string {
  return `<ellipse cx="${cx}" cy="${cy}" rx="${rx}" ry="${(rx * 0.34).toFixed(1)}" fill="#06181c" fill-opacity="0.20"/>`;
}

/* ------------------------------------------------------------------ props */

const APPLE = ["..b..", ".bl..", "RRRRR", "RhRRR", "RRRRR", ".RRR."];
const APPLE_LEGEND = { b: "#7a5230", l: "#5fae5f", R: "#e0574f", h: "#ff9e91" };

const BALL = [".gg.", "gGgg", "gggg", ".gg."];
const BALL_LEGEND = { g: "#bcee49", G: "#eafab8" };

const CUP = ["ttttt", "twwwt", "twwwt", ".ttt.", "..t.."];
const CUP_LEGEND = { t: "#8fd3e8", w: "#4fe6e2" };

const TEDDY = [".b..b.", ".bbbb.", "bEbbEb", "bbnnbb", "bLLLLb", ".b..b."];
const TEDDY_LEGEND = { b: "#b07a4a", E: "#2a1c12", n: "#7a5230", L: "#e9cfa8" };

const FLAG = ["pfff", "pff.", "pf..", "p...", "p...", "p..."];
const FLAG_LEGEND = { p: "#8a6b4a", f: "#ff9d82" };

const MAP = [".pppppp.", "pLLLLLLp", "pLLxLLLp", "pLLLLxLp", "pLLLLLLp", ".pppppp."];
const MAP_LEGEND = { p: "#c9a86a", L: "#f3e6c8", x: "#d9614f" };

const CLOUD = [".www.", "wwwww"];
const CLOUD_LEGEND = { w: "#dcebef" };

// Two contrasting friend hues offset from the pet's own body index, so "together"
// scenes show the pet playing with differently colored WALLETCHIs (never clones).
function friends(bodyIdx: number, palettes: BodyPalette[]): [BodyPalette, BodyPalette] {
  return [palettes[(bodyIdx + 6) % 16]!, palettes[(bodyIdx + 11) % 16]!];
}

function stage(inner: string): string {
  return `<svg class="wtc-stage" viewBox="0 0 120 68" shape-rendering="crispEdges" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">${inner}</svg>`;
}

// Feet-at-baseline helper: place() anchors a grid by its top-left, so a 16-tall
// sprite whose feet should rest on y=BASE starts at y = BASE - 16*s.
const BASE = 54;
const feetY = (s: number) => BASE - 16 * s;

/* --------------------------------------------------------------- scenes: feed */

// Two WALLETCHIs eating together at a little table; apples bob to their mouths.
function feedTable(me: BodyPalette, f: BodyPalette): string {
  const s = 1.55;
  const y = feetY(s);
  return (
    shadow(34, BASE + 1, 15) +
    shadow(86, BASE + 1, 15) +
    creature(me, 34 - 12.4, y, s, "b0", 0, "chew") +
    creature(f, 86 - 12.4, y, s, "b0", -0.9, "chew") +
    // table
    `<rect x="42" y="50" width="36" height="4" rx="1" fill="#8a5a34"/>` +
    `<rect x="45" y="54" width="3" height="9" fill="#6f4526"/>` +
    `<rect x="72" y="54" width="3" height="9" fill="#6f4526"/>` +
    // a shared plate + apples on the table
    `<ellipse cx="60" cy="50" rx="10" ry="2.4" fill="#eaf3f5" fill-opacity="0.85"/>` +
    place(APPLE, APPLE_LEGEND, 52, 44, 1.0, "b0", -0.4) +
    place(APPLE, APPLE_LEGEND, 62, 45, 0.9, "b0", -1.3)
  );
}

// One pet happily munching a big apple held up to its face.
function feedMunch(me: BodyPalette): string {
  const s = 2.0;
  const y = feetY(s);
  return (
    shadow(60, BASE + 1, 18) +
    creature(me, 60 - 16, y, s, "", 0, "chew") +
    place(APPLE, APPLE_LEGEND, 74, 30, 1.7, "b0")
  );
}

// A pet bouncing with joy over a full food bowl.
function feedBowl(me: BodyPalette): string {
  const s = 1.9;
  const y = feetY(s);
  return (
    shadow(50, BASE + 1, 17) +
    creature(me, 50 - 15.2, y, s, "hop") +
    // bowl of kibble
    `<path d="M74 47 q11 0 11 -6 h-22 q0 6 11 6 z" fill="#3f8f8a"/>` +
    `<rect x="65" y="39" width="18" height="3" rx="1.5" fill="#e0a15a"/>` +
    `<rect x="67" y="37" width="4" height="3" fill="#f0c27b"/>` +
    `<rect x="74" y="36" width="4" height="4" fill="#f0c27b"/>`
  );
}

/* -------------------------------------------------------------- scenes: water */

// Two pets bobbing in a lake, ripples spreading around them. Layering makes them
// read as IN the water: opaque lake behind, pets, then a translucent front band
// over their lower bodies with a bright waterline and ripples on top.
function waterLake(me: BodyPalette, f: BodyPalette): string {
  const s = 1.6; // pet height ~25.6; place so bottoms sit ~58 (submerged past the belly)
  const y = 58 - 16 * s;
  return (
    // opaque lake body BEHIND the pets
    `<rect x="0" y="42" width="120" height="26" fill="#1c6675"/>` +
    creature(me, 34 - 12.8, y, s, "float0") +
    creature(f, 86 - 12.8, y, s, "float1") +
    // translucent water in FRONT of the pets' lower halves + a bright surface line
    `<rect x="0" y="48" width="120" height="20" fill="#2a8ea0" fill-opacity="0.55"/>` +
    `<rect x="0" y="47" width="120" height="1.6" fill="#7fe6e2" fill-opacity="0.9"/>` +
    // ripples around each pet at the surface
    `<g class="ripple"><ellipse cx="34" cy="49" rx="13" ry="2.2" fill="none" stroke="#aef6f2" stroke-width="0.8" stroke-opacity="0.75"/></g>` +
    `<g class="ripple" style="animation-delay:-1.3s"><ellipse cx="86" cy="49" rx="13" ry="2.2" fill="none" stroke="#aef6f2" stroke-width="0.8" stroke-opacity="0.75"/></g>`
  );
}

// One pet tipping a cup for a drink, a droplet falling.
function waterSip(me: BodyPalette): string {
  const s = 2.0;
  const y = feetY(s);
  return (
    shadow(56, BASE + 1, 18) +
    creature(me, 56 - 16, y, s, "", 0, "sip") +
    place(CUP, CUP_LEGEND, 74, 30, 1.7, "sip") +
    // a little falling droplet, on loop
    `<g class="drop"><rect x="80" y="44" width="2" height="3" rx="1" fill="#4fe6e2"/></g>`
  );
}

// A pet catching rain in its mouth, drops falling from above.
function waterRain(me: BodyPalette): string {
  const s = 1.95;
  const y = feetY(s);
  const drops = [30, 52, 70, 92]
    .map((x, i) => `<g class="drop" style="animation-delay:${(-i * 0.4).toFixed(1)}s"><rect x="${x}" y="8" width="2" height="4" rx="1" fill="#7fdff0"/></g>`)
    .join("");
  return shadow(60, BASE + 1, 17) + drops + creature(me, 60 - 15.6, y, s, "b0");
}

/* --------------------------------------------------------------- scenes: play */

// Two pets lobbing a ball back and forth in an arc.
function playCatch(me: BodyPalette, f: BodyPalette): string {
  const s = 1.6;
  const y = feetY(s);
  return (
    shadow(28, BASE + 1, 14) +
    shadow(92, BASE + 1, 14) +
    creature(me, 28 - 12.8, y, s, "hop") +
    creature(f, 92 - 12.8, y, s, "hop", -0.55) +
    // ball arcs between them (outer arc translate, inner spin)
    `<g class="arc"><g transform="translate(40 34)"><g class="spin">${pixels(BALL, BALL_LEGEND)}</g></g></g>`
  );
}

// One pet chasing / batting a bouncing ball.
function playChase(me: BodyPalette): string {
  const s = 1.9;
  const y = feetY(s);
  return (
    shadow(46, BASE + 1, 16) +
    creature(me, 46 - 15.2, y, s, "b0") +
    `<g class="bounce"><g transform="translate(74 40)"><g class="spin">${pixels(BALL, BALL_LEGEND)}</g></g></g>`
  );
}

/* ---------------------------------------------------------------- scenes: toy */

// A pet hugging a teddy and wiggling with delight.
function toyHug(me: BodyPalette): string {
  const s = 2.0;
  const y = feetY(s);
  return (
    shadow(54, BASE + 1, 18) +
    creature(me, 54 - 16, y, s, "", 0, "wag") +
    place(TEDDY, TEDDY_LEGEND, 72, 34, 2.0, "wag")
  );
}

// Two pets sharing a pile of toys (teddy + ball) between them.
function toyShare(me: BodyPalette, f: BodyPalette): string {
  const s = 1.55;
  const y = feetY(s);
  return (
    shadow(32, BASE + 1, 14) +
    shadow(88, BASE + 1, 14) +
    creature(me, 32 - 12.4, y, s, "b0", 0, "wag") +
    creature(f, 88 - 12.4, y, s, "b0", -0.8, "wag") +
    place(TEDDY, TEDDY_LEGEND, 52, 40, 1.7, "b0") +
    // Position and animation on separate groups (a CSS transform animation replaces the SVG
    // transform attribute on the same element; see hatchReveal's sparks).
    `<g transform="translate(66 46)"><g class="b0"><g class="spin">${pixels(BALL, BALL_LEGEND)}</g></g></g>`
  );
}

/* ------------------------------------------------------------ scenes: explore */

// A pet on a little hill with a planted flag; clouds drift by.
function exploreHill(me: BodyPalette): string {
  const s = 1.9;
  const y = feetY(s) - 3; // stand a touch higher, on the hill crown
  return (
    // clouds
    place(CLOUD, CLOUD_LEGEND, 12, 12, 1.6, "drift") +
    place(CLOUD, CLOUD_LEGEND, 78, 8, 1.3, "drift", -3) +
    // hill
    `<path d="M0 68 q60 -26 120 0 z" fill="#2b6f56"/>` +
    `<path d="M0 68 q60 -20 120 0 z" fill="#347f61"/>` +
    shadow(52, BASE - 2, 15) +
    creature(me, 52 - 15.2, y, s, "b0") +
    // planted flag (pole base sits on the hill crown), gently bobbing
    place(FLAG, FLAG_LEGEND, 82, 40, 2.0, "b0")
  );
}

// A pet studying a treasure map, an X to chase; a bobbing compass-star above.
function exploreMap(me: BodyPalette): string {
  const s = 1.9;
  const y = feetY(s);
  return (
    shadow(40, BASE + 1, 16) +
    creature(me, 40 - 15.2, y, s, "", 0, "b0") +
    place(MAP, MAP_LEGEND, 66, 34, 2.4, "b0") +
    // a twinkling guiding star
    `<g transform="translate(96 16)"><g class="twinkle"><rect x="-1" y="-3" width="2" height="6" fill="#ffe59a"/><rect x="-3" y="-1" width="6" height="2" fill="#ffe59a"/></g></g>`
  );
}

/* --------------------------------------------------------------- scenes: hatch */

// The egg: a hue-tinted pixel shell with a jagged crack, so it hints the creature
// inside. Width is a strict 12 columns.
const EGG = [
  "....SSSS....",
  "..SSSSSSSS..",
  ".SSSSSSSSSS.",
  ".SSSSHSSSSS.",
  "SSSSSSSSSSSS",
  "SSSSSSSSSSSS",
  "SSSSkSSSSSSS",
  "SSSkSkSSSSSS",
  "SSkSSSkkSSSS",
  "SSSSSSSSSSSS",
  ".SSSSSSSSSS.",
  ".SSSSSSSSSS.",
  "..SSSSSSSS..",
  "....SSSS....",
];

// The hatch: the egg wobbles, then vanishes as the pet pops out with a burst of
// sparkles. A ONE-SHOT reveal (the confirm page holds it, it does not auto-close),
// which is exactly the moment that was missing before.
function hatchReveal(me: BodyPalette): string {
  const es = 2.0; // egg scale
  const eggLegend = { S: me.L, H: "#ffffff", k: me.O };
  const ex = 60 - 6 * es; // egg is 12 wide
  const ey = BASE - 14 * es; // egg is 14 tall
  const ps = 2.0; // pet scale
  const py = feetY(ps);
  const px = 60 - 8 * ps;
  const sparks = [
    [40, 22],
    [82, 20],
    [34, 40],
    [88, 42],
    [60, 12],
  ]
    .map(
      ([x, y], i) =>
        // Position on the OUTER group, animation on the INNER one. A CSS transform animation
        // REPLACES an SVG transform attribute on the same element, so with both on one <g>
        // every spark lost its translate while animating and all five stacked at the scene's
        // 0,0: a lone sparkle hanging off the top-left of the hatch page.
        `<g transform="translate(${x} ${y})"><g class="spark" style="animation-delay:${(2.4 + i * 0.18).toFixed(2)}s"><rect x="-1" y="-3" width="2" height="6" fill="#ffe59a"/><rect x="-3" y="-1" width="6" height="2" fill="#ffe59a"/></g></g>`,
    )
    .join("");
  return (
    shadow(60, BASE + 1, 16) +
    // egg (wobbles, then fades away)
    place(EGG, eggLegend, ex, ey, es, "egg-gone", 0, "egg-wob") +
    // pet (pops in after the egg goes, then idles with a gentle bob)
    place(PET_SPRITE, legendFor(me), px, py, ps, "pet-pop", 0, "b0") +
    sparks
  );
}

/* ------------------------------------------------------------ public surface */

// How many variants each action has, so callers/tests know the range.
export const SCENE_VARIANTS: Record<CareAction, number> = {
  feed: 3,
  water: 3,
  play: 2,
  toy: 2,
  explore: 2,
};

// Build a random care scene for an action, colored to the keeper's real pet hue.
// `variant` can be forced (preview/tests); otherwise it is chosen at random.
export function careScene(action: CareAction, seed: string | number, variant?: number): string {
  const t = traitsFor(seed);
  const me = t.palette;
  const [f1, f2] = friends(t.body, BODY_PALETTES);
  const v = variant ?? Math.floor(Math.random() * SCENE_VARIANTS[action]);
  let inner: string;
  switch (action) {
    case "feed":
      inner = v === 0 ? feedTable(me, f1) : v === 1 ? feedMunch(me) : feedBowl(me);
      break;
    case "water":
      inner = v === 0 ? waterLake(me, f2) : v === 1 ? waterSip(me) : waterRain(me);
      break;
    case "play":
      inner = v === 0 ? playCatch(me, f1) : playChase(me);
      break;
    case "toy":
      inner = v === 0 ? toyHug(me) : toyShare(me, f2);
      break;
    case "explore":
      inner = v === 0 ? exploreHill(me) : exploreMap(me);
      break;
    default:
      inner = feedMunch(me);
  }
  return stage(inner);
}

// The hatch reveal, colored to the pet that just hatched.
export function hatchScene(seed: string | number): string {
  return stage(hatchReveal(traitsFor(seed).palette));
}

// The stylesheet every scene relies on. Injected once into the <style> of any page
// that renders a scene. Kept namespaced (wtc-*) so it never collides with the page.
export const SCENE_CSS = `
  .wtc-stage{display:block;margin:2px auto 12px;width:min(330px,82vw);height:auto;overflow:visible}
  .b0{transform-box:fill-box;animation:wtcbob 2s ease-in-out infinite}
  @keyframes wtcbob{0%,100%{transform:translateY(0)}50%{transform:translateY(-1.4px)}}
  .float0{transform-box:fill-box;animation:wtcfloat 2.6s ease-in-out infinite}
  .float1{transform-box:fill-box;animation:wtcfloat 2.6s ease-in-out infinite;animation-delay:-1.3s}
  @keyframes wtcfloat{0%,100%{transform:translateY(0)}50%{transform:translateY(-2.6px)}}
  .chew{transform-box:fill-box;transform-origin:50% 100%;animation:wtcchew .46s ease-in-out infinite}
  @keyframes wtcchew{0%,100%{transform:scaleY(1)}50%{transform:translateY(.5px) scaleY(.93)}}
  .hop{transform-box:fill-box;transform-origin:50% 100%;animation:wtchop 1.1s cubic-bezier(.28,.7,.4,1) infinite}
  @keyframes wtchop{0%,100%{transform:translateY(0) scale(1,1)}12%{transform:scale(1.08,.92)}45%{transform:translateY(-7px) scale(.95,1.05)}78%{transform:translateY(0) scale(1.06,.94)}}
  .sip{transform-box:fill-box;transform-origin:50% 90%;animation:wtcsip 2.2s ease-in-out infinite}
  @keyframes wtcsip{0%,55%,100%{transform:rotate(0)}30%{transform:rotate(-9deg)}}
  .wag{transform-box:fill-box;transform-origin:50% 100%;animation:wtcwag 1s ease-in-out infinite}
  @keyframes wtcwag{0%,100%{transform:rotate(-4deg)}50%{transform:rotate(4deg)}}
  .spin{transform-box:fill-box;transform-origin:50% 50%;animation:wtcspin 1.1s linear infinite}
  @keyframes wtcspin{to{transform:rotate(360deg)}}
  .arc{animation:wtcarc 1.15s ease-in-out infinite alternate}
  @keyframes wtcarc{0%{transform:translate(0,0)}50%{transform:translate(24px,-18px)}100%{transform:translate(52px,0)}}
  .bounce{animation:wtcbounce 1s ease-in-out infinite alternate}
  @keyframes wtcbounce{0%{transform:translate(0,0)}100%{transform:translate(-30px,-12px)}}
  .ripple{transform-box:fill-box;transform-origin:50% 50%;animation:wtcripple 2.6s ease-in-out infinite}
  @keyframes wtcripple{0%,100%{opacity:.45;transform:scaleX(.88)}50%{opacity:1;transform:scaleX(1.12)}}
  .drop{animation:wtcdrop 1.2s ease-in infinite}
  @keyframes wtcdrop{0%{transform:translateY(0);opacity:0}20%{opacity:1}100%{transform:translateY(18px);opacity:0}}
  .drift{animation:wtcdrift 7s linear infinite}
  @keyframes wtcdrift{0%{transform:translateX(-8px)}100%{transform:translateX(16px)}}
  .twinkle{transform-box:fill-box;transform-origin:50% 50%;animation:wtctwk 1.5s ease-in-out infinite}
  @keyframes wtctwk{0%,100%{opacity:.3;transform:scale(.7)}50%{opacity:1;transform:scale(1.1)}}
  .egg-wob{transform-box:fill-box;transform-origin:50% 100%;animation:wtcwob 2.2s ease-in-out}
  @keyframes wtcwob{0%,100%{transform:rotate(0)}14%{transform:rotate(-6deg)}28%{transform:rotate(6deg)}42%{transform:rotate(-5deg)}56%{transform:rotate(5deg)}70%{transform:rotate(0)}}
  .egg-gone{animation:wtceggone .5s ease-in 2.2s forwards}
  @keyframes wtceggone{to{opacity:0;transform:translateY(4px) scale(.9)}}
  .pet-pop{transform-box:fill-box;transform-origin:50% 100%;opacity:0;animation:wtcpop .7s cubic-bezier(.2,1.35,.5,1) 2.3s forwards}
  @keyframes wtcpop{0%{opacity:0;transform:translateY(6px) scale(.2)}60%{opacity:1;transform:translateY(-3px) scale(1.12)}100%{opacity:1;transform:translateY(0) scale(1)}}
  .spark{transform-box:fill-box;transform-origin:50% 50%;opacity:0;animation:wtcspark 1.1s ease-out infinite}
  @keyframes wtcspark{0%{opacity:0;transform:scale(.3)}40%{opacity:1;transform:scale(1)}100%{opacity:0;transform:scale(.4) translateY(-7px)}}
  @media (prefers-reduced-motion: reduce){
    .b0,.float0,.float1,.chew,.hop,.sip,.wag,.spin,.arc,.bounce,.ripple,.drop,.drift,.twinkle,.egg-wob,.spark{animation:none}
    .egg-gone{animation:wtceggone .4s ease-in 1.4s forwards}
    .pet-pop{opacity:1;animation:none}
  }
`;
