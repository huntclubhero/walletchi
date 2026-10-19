// PAINTED BACKDROPS for the photo album (Hunt 2026-10-17: "backgrounds should be amazing
// visually ... painted style brush strokes that are beautiful", "dont look like svg's or cheap
// ai backgrounds"). The Chis stay crisp pixel art on top.
//
// Painterly rendering in the Hertzmann style, emitted as SVG so sharp/librsvg rasterises it:
//   1. a scene is a reference image: colour + stroke direction at any point. Scenes are built
//      like an animation-film background: a graded sky, sculpted cumulus billows lit from the
//      sun, layered hills with sunlit rims and painted trees, a meadow of grass blades;
//   2. it is repainted with layered brushes, big first, then smaller ones only where the
//      picture has detail. Each stroke follows the scene's flow (sweeps in the sky, wrapping
//      round the cloud billows, along the hill contours, up the grass) and stops when the
//      colour under it changes, so silhouettes stay crisp;
//   3. every stroke is a TAPERED brush shape (loaded at the start, trailing off) with dry-brush
//      bristle streaks, then a canvas grain and a soft vignette go over the whole picture.
// Everything is seeded, so the same pet always gets the same painting.

export type RGB = [number, number, number];
export interface Scene {
  color(x: number, y: number): RGB;
  flow(x: number, y: number): number; // stroke angle, radians
  /** optional per-point stroke length multiplier (long sweeps in the sky, short dabs in detail) */
  reach?(x: number, y: number): number;
}

// ---------------------------------------------------------------- numbers
export function rng(seed: number): () => number {
  let s = seed >>> 0 || 1;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const hash2 = (x: number, y: number, s: number) => {
  let h = (x * 374761393 + y * 668265263 + s * 2147483647) | 0;
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
};
const smooth = (t: number) => t * t * (3 - 2 * t);
export function noise(x: number, y: number, s = 0): number {
  const xi = Math.floor(x), yi = Math.floor(y);
  const xf = smooth(x - xi), yf = smooth(y - yi);
  const a = hash2(xi, yi, s), b = hash2(xi + 1, yi, s), c = hash2(xi, yi + 1, s), d = hash2(xi + 1, yi + 1, s);
  return a + (b - a) * xf + (c - a) * yf + (a - b - c + d) * xf * yf;
}
export function fbm(x: number, y: number, s = 0, oct = 4): number {
  let v = 0, amp = 0.5, f = 1, norm = 0;
  for (let i = 0; i < oct; i++) {
    v += amp * noise(x * f, y * f, s + i * 17);
    norm += amp;
    amp *= 0.5;
    f *= 2.03;
  }
  return v / norm;
}
export const clamp01 = (v: number) => (v < 0 ? 0 : v > 1 ? 1 : v);
export const sstep = (a: number, b: number, v: number) => smooth(clamp01((v - a) / (b - a)));
export const hex = (h: string): RGB => [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16)) as RGB;
export const lerpC = (a: RGB, b: RGB, t: number): RGB => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];
const toHex = (c: RGB) => "#" + c.map((v) => Math.max(0, Math.min(255, Math.round(v))).toString(16).padStart(2, "0")).join("");
const cdist = (a: RGB, b: RGB) => Math.abs(a[0] - b[0]) + Math.abs(a[1] - b[1]) + Math.abs(a[2] - b[2]);
const f1 = (v: number) => v.toFixed(1);

// ---------------------------------------------------------------- the painter
export interface PaintOpts {
  seed: number;
  /** biggest brush as a fraction of the image diagonal (default 1/34) */
  brush?: number;
  /** canvas grain strength 0..1 */
  grain?: number;
  /** vignette strength 0..1 */
  vignette?: number;
}

/** A tapered brush shape along a centreline: loaded at the start, trailing off at the end. */
function brushShape(pts: [number, number][], width: number, R: () => number): string {
  // resample to at least 6 points so the taper reads
  const P: [number, number][] = [];
  for (let i = 0; i < pts.length - 1; i++) {
    const [x0, y0] = pts[i]!, [x1, y1] = pts[i + 1]!;
    const k = pts.length === 2 ? 5 : 2;
    for (let j = 0; j < k; j++) P.push([x0 + ((x1 - x0) * j) / k, y0 + ((y1 - y0) * j) / k]);
  }
  P.push(pts[pts.length - 1]!);
  const n = P.length;
  const L: string[] = [], Rt: string[] = [];
  const wob = 0.12 + R() * 0.12;
  for (let i = 0; i < n; i++) {
    const t = i / (n - 1);
    const a = P[Math.max(0, i - 1)]!, b = P[Math.min(n - 1, i + 1)]!;
    let dx = b[0] - a[0], dy = b[1] - a[1];
    const len = Math.hypot(dx, dy) || 1;
    dx /= len;
    dy /= len;
    // fat round head, a body that wavers a little, a dry trailing tail
    const prof = Math.pow(Math.sin(Math.PI * Math.min(1, t * 1.15 + 0.08)), 0.55) * (1 - 0.35 * t);
    const hw = (width / 2) * Math.max(0.08, prof) * (1 + (R() - 0.5) * wob);
    L.push(`${f1(P[i]![0] - dy * hw)} ${f1(P[i]![1] + dx * hw)}`);
    Rt.push(`${f1(P[i]![0] + dy * hw)} ${f1(P[i]![1] - dx * hw)}`);
  }
  return `M${L.join(" L")} L${Rt.reverse().join(" L")}Z`;
}

export function paint(w: number, h: number, scene: Scene, opts: PaintOpts): string {
  const R = rng(opts.seed);
  const diag = Math.hypot(w, h);
  const big = diag * (opts.brush ?? 1 / 34);
  const layers = [
    { size: big, spacing: big * 0.55, keep: 1, len: 7, thresh: 80, jit: 0.025 },
    { size: big * 0.5, spacing: big * 0.3, keep: 0.75, len: 6, thresh: 60, jit: 0.035 },
    { size: big * 0.25, spacing: big * 0.16, keep: 0.0, len: 5, thresh: 45, jit: 0.05 },
  ];
  const out: string[] = [];
  out.push(`<rect width="${w}" height="${h}" fill="${toHex(scene.color(w / 2, h / 2))}"/>`);
  for (let li = 0; li < layers.length; li++) {
    const Ly = layers[li]!;
    const pts: [number, number][] = [];
    for (let y = -Ly.spacing / 2; y < h + Ly.spacing; y += Ly.spacing) {
      for (let x = -Ly.spacing / 2; x < w + Ly.spacing; x += Ly.spacing) {
        const px = x + (R() - 0.5) * Ly.spacing;
        const py = y + (R() - 0.5) * Ly.spacing;
        if (li >= 2) {
          // fine brushes only where the picture has detail (plus a light sprinkle elsewhere)
          const d = Ly.size * 1.4;
          const edge = cdist(scene.color(px - d, py), scene.color(px + d, py)) + cdist(scene.color(px, py - d), scene.color(px, py + d));
          if (edge < 55 && R() >= Ly.keep) continue;
        } else if (R() > Ly.keep) continue;
        pts.push([px, py]);
      }
    }
    for (let i = pts.length - 1; i > 0; i--) {
      const j = Math.floor(R() * (i + 1));
      [pts[i], pts[j]] = [pts[j]!, pts[i]!];
    }
    for (const [sx, sy] of pts) {
      const base = scene.color(sx, sy);
      const jv = 1 + (R() - 0.5) * 2 * Ly.jit;
      const jh = (R() - 0.5) * 30 * Ly.jit;
      const c: RGB = [base[0] * jv + jh, base[1] * jv, base[2] * jv - jh];
      const reach = scene.reach ? scene.reach(sx, sy) : 1;
      const step = Ly.size * 0.5;
      let x = sx, y = sy;
      const line: [number, number][] = [[x, y]];
      let prev = scene.flow(x, y);
      const n = Math.max(1, Math.round((1 + R() * Ly.len) * reach));
      for (let k = 0; k < n; k++) {
        let a = scene.flow(x, y);
        if (Math.cos(a - prev) < 0) a += Math.PI;
        prev = a;
        const nx = x + Math.cos(a) * step;
        const ny = y + Math.sin(a) * step;
        if (cdist(scene.color(nx, ny), base) > Ly.thresh) break;
        x = nx;
        y = ny;
        line.push([x, y]);
      }
      if (line.length < 2) line.push([x + Math.cos(prev) * step * 0.7, y + Math.sin(prev) * step * 0.7]);
      const sw = Ly.size * (0.75 + R() * 0.5);
      out.push(`<path d="${brushShape(line, sw, R)}" fill="${toHex(c)}" fill-opacity="${(0.86 + R() * 0.14).toFixed(2)}"/>`);
      // dry-brush bristles: two thin streaks riding the stroke, one lighter, one darker
      if (li < 2 && line.length >= 3) {
        for (const [off, lift, op] of [[-0.22, 1.08, 0.22], [0.26, 0.93, 0.18]] as const) {
          const o = sw * off;
          const d =
            "M" +
            line
              .map(([px, py], i) => {
                const q = line[Math.min(line.length - 1, i + 1)]!, p0 = line[Math.max(0, i - 1)]!;
                const ang = Math.atan2(q[1] - p0[1], q[0] - p0[0]);
                return `${f1(px - Math.sin(ang) * o)} ${f1(py + Math.cos(ang) * o)}`;
              })
              .slice(0, Math.max(2, line.length - 1))
              .join(" L");
          out.push(`<path d="${d}" fill="none" stroke="${toHex([c[0] * lift, c[1] * lift, c[2] * lift])}" stroke-width="${f1(sw * 0.07)}" stroke-opacity="${op}" stroke-linecap="round"/>`);
        }
      }
    }
  }
  const grain = opts.grain ?? 0.5;
  const vig = opts.vignette ?? 0.35;
  const defs =
    `<filter id="cv" x="0" y="0" width="100%" height="100%"><feTurbulence type="fractalNoise" baseFrequency="0.85" numOctaves="2" seed="${opts.seed % 997}"/>` +
    `<feColorMatrix values="0 0 0 0 0.45  0 0 0 0 0.4  0 0 0 0 0.35  0 0 0 ${(0.2 * grain).toFixed(3)} 0"/></filter>` +
    `<radialGradient id="vg" cx="0.5" cy="0.5" r="0.75"><stop offset="0.55" stop-color="#140c1e" stop-opacity="0"/><stop offset="1" stop-color="#140c1e" stop-opacity="${vig}"/></radialGradient>`;
  return `<defs>${defs}</defs><g>${out.join("")}</g><rect width="${w}" height="${h}" filter="url(#cv)"/><rect width="${w}" height="${h}" fill="url(#vg)"/>`;
}

// ---------------------------------------------------------------- palettes
// Curated skies, hand-picked so every one is pleasing; the pets bring the colour.
export interface Sky {
  name: string;
  top: string; mid: string; low: string; sun: string;
  cloudL: string; cloudM: string; cloudS: string;
  far: string; midHill: string; near: string; rim: string; tree: string;
  grassL: string; grassD: string;
  night?: boolean;
}
export const SKIES: Sky[] = [
  { name: "goldenHour", top: "#2B4C8C", mid: "#9C7BB8", low: "#FFB487", sun: "#FFF1C4", cloudL: "#FFE2BD", cloudM: "#F2A88F", cloudS: "#8E6E9F",
    far: "#8F84B5", midHill: "#5F8A7A", near: "#3F7650", rim: "#FFD29A", tree: "#2F5A45", grassL: "#B3D46E", grassD: "#356B3C" },
  { name: "brightDay", top: "#2272CC", mid: "#5FAEEB", low: "#CDEBFA", sun: "#FFFCEB", cloudL: "#FFFFFF", cloudM: "#DCE9F5", cloudS: "#93AFD3",
    far: "#8DB6D0", midHill: "#69AE70", near: "#4A9A4B", rim: "#E4F7B0", tree: "#2E7040", grassL: "#ADE077", grassD: "#41863A" },
  { name: "pinkDawn", top: "#4C66B4", mid: "#E09BBE", low: "#FFE0B0", sun: "#FFF7DD", cloudL: "#FFF0EA", cloudM: "#F1B5C3", cloudS: "#A983AE",
    far: "#A898CC", midHill: "#82AD92", near: "#5B9470", rim: "#FFE4C0", tree: "#3E6E58", grassL: "#C2E294", grassD: "#548A54" },
  { name: "starryNight", top: "#0A1030", mid: "#1D2B63", low: "#46609F", sun: "#F7F1CF", cloudL: "#8B9AD0", cloudM: "#4F5E9C", cloudS: "#232C5A",
    far: "#283863", midHill: "#1D3E4C", near: "#173530", rim: "#7F96C9", tree: "#0F2622", grassL: "#3A7259", grassD: "#11301F", night: true },
];

// ---------------------------------------------------------------- clouds
interface Billow { x: number; y: number; r: number }
interface Cloud { billows: Billow[]; base: number }

/** Cumulus banks: each a cluster of billows sitting on a flat-ish base line. */
function makeClouds(w: number, horizon: number, seed: number, amount: number): Cloud[] {
  const R = rng(seed * 7 + 3);
  const n = Math.round(2 + amount * 4);
  const clouds: Cloud[] = [];
  for (let i = 0; i < n; i++) {
    const cx = (i + 0.3 + R() * 0.4) / n * w * 1.1 - w * 0.05;
    const base = horizon * (0.3 + R() * 0.42);
    const width = w * (0.12 + R() * 0.16);
    const tall = width * (0.26 + R() * 0.18);
    const billows: Billow[] = [];
    const m = 7 + Math.floor(R() * 6);
    for (let k = 0; k < m; k++) {
      const t = k / (m - 1);
      const r = tall * (0.32 + 0.5 * Math.sin(Math.PI * t) * (0.6 + R() * 0.5));
      billows.push({ x: cx - width / 2 + width * t + (R() - 0.5) * width * 0.08, y: base - r * (0.55 + R() * 0.35), r });
    }
    // a crown or two on the tallest part
    for (let k = 0; k < 2; k++) billows.push({ x: cx + (R() - 0.5) * width * 0.4, y: base - tall * (0.85 + R() * 0.3), r: tall * (0.3 + R() * 0.15) });
    clouds.push({ billows, base });
  }
  return clouds;
}

/** Signed distance to a cloud (negative inside), smooth-unioned billows, flat bottom. */
function cloudSdf(c: Cloud, x: number, y: number): number {
  let d = 1e9;
  const k = 18;
  for (const b of c.billows) {
    const db = Math.hypot(x - b.x, y - b.y) - b.r;
    // polynomial smooth min, so billows melt into each other
    const hmix = clamp01(0.5 + (0.5 * (db - d)) / k);
    d = db * (1 - hmix) + d * hmix - k * hmix * (1 - hmix);
  }
  return Math.max(d, y - c.base);
}

// ---------------------------------------------------------------- scenes
/** An animation-film landscape: graded sky, lit cumulus, sun or moon, three hills with
 *  sunlit rims and painted trees, a meadow of grass blades and flowers. */
export function landscape(w: number, h: number, sky: Sky, seed: number, o: { horizon?: number; sunX?: number; sunY?: number; cloud?: number; trees?: number } = {}): Scene {
  const top = hex(sky.top), mid = hex(sky.mid), low = hex(sky.low), sun = hex(sky.sun);
  const cL = hex(sky.cloudL), cM = hex(sky.cloudM), cS = hex(sky.cloudS);
  const far = hex(sky.far), mh = hex(sky.midHill), near = hex(sky.near), rim = hex(sky.rim), tree = hex(sky.tree);
  const gL = hex(sky.grassL), gD = hex(sky.grassD);
  const hz = (o.horizon ?? 0.62) * h;
  const sx = (o.sunX ?? 0.3) * w, sy = (o.sunY ?? 0.42) * h;
  const S = Math.max(w, h);
  const clouds = makeClouds(w, hz, seed, (o.cloud ?? 0.55) * (sky.night ? 0.5 : 1)).filter((c) => {
    const xs = c.billows.map((b) => b.x);
    return Math.max(...xs) < sx - w * 0.07 || Math.min(...xs) > sx + w * 0.07;
  });
  const ridge = (x: number, base: number, amp: number, f: number, s: number) =>
    base - amp * (0.55 * Math.sin((x / S) * f * 6.283 + s) + 0.45 * (fbm((x / S) * f * 2, s, seed + s, 3) - 0.5) * 2);
  const farY = (x: number) => ridge(x, hz - h * 0.025, h * 0.075, 1.3, 1.7);
  const midY = (x: number) => ridge(x, hz + h * 0.06, h * 0.06, 0.9, 4.1);
  const nearY = (x: number) => ridge(x, hz + h * 0.16, h * 0.05, 0.6, 7.3);
  // round trees on the middle hill
  const TR = rng(seed + 99);
  const trees: Billow[] = [];
  const nt = Math.round((o.trees ?? 1) * (4 + TR() * 5));
  for (let i = 0; i < nt; i++) {
    const tx = TR() * w;
    const r = h * (0.022 + TR() * 0.02);
    trees.push({ x: tx, y: midY(tx) + r * 0.3 + h * 0.01, r });
  }
  const toSunAt = (x: number, y: number) => {
    const dx = sx - x, dy = sy - y;
    const l = Math.hypot(dx, dy) || 1;
    return [dx / l, dy / l] as const;
  };
  const cloudAt = (x: number, y: number): { c: RGB; d: number; nx: number; ny: number } | null => {
    for (const cl of clouds) {
      const d = cloudSdf(cl, x, y);
      if (d < 0) {
        const e = 3;
        const nx = cloudSdf(cl, x + e, y) - cloudSdf(cl, x - e, y);
        const ny = cloudSdf(cl, x, y + e) - cloudSdf(cl, x, y - e);
        const l = Math.hypot(nx, ny) || 1;
        const [tx, ty] = toSunAt(x, y);
        // light: facing the sun, plus a general top light; three painted values
        // outward normal: up-facing billows catch the light, sun-facing ones glow
        const lit = clamp01(0.62 + 0.45 * (-(ny / l)) + 0.25 * ((nx / l) * tx + (ny / l) * ty));
        const depth = clamp01(-d / 60);
        let c = lit > 0.55 ? lerpC(cM, cL, sstep(0.55, 0.8, lit)) : lerpC(cS, cM, sstep(0.2, 0.55, lit));
        // the shaded belly near the flat base
        c = lerpC(c, cS, sstep(-22, 0, y - cl.base) * 0.35);
        c = lerpC(c, cL, (1 - depth) * 0.15 * lit);
        return { c, d, nx: nx / l, ny: ny / l };
      }
    }
    return null;
  };
  const skyAt = (x: number, y: number): RGB => {
    const t = clamp01(y / hz);
    let c = t < 0.5 ? lerpC(top, mid, sstep(0, 0.5, t)) : lerpC(mid, low, sstep(0.5, 1, t));
    const dsun = Math.hypot(x - sx, y - sy) / S;
    c = lerpC(c, sun, clamp01(0.9 * Math.exp((-dsun * dsun) / 0.015)));
    if (dsun < 0.032) c = lerpC(c, sun, 0.97);
    const cl = cloudAt(x, y);
    if (cl) c = cl.c;
    if (sky.night && !cl) {
      const st = hash2(Math.floor(x / 10), Math.floor(y / 10), seed);
      if (st > 0.994 && y < hz * 0.85) c = lerpC(c, [255, 250, 225], 0.95);
    }
    return c;
  };
  return {
    color(x, y) {
      if (y < farY(x)) return skyAt(x, y);
      if (y < midY(x)) {
        // distant hills: hazy, lit along the ridge
        const c = lerpC(lerpC(far, low, 0.3), far, sstep(0, h * 0.06, y - farY(x)));
        return lerpC(c, rim, sstep(h * 0.012, 0, y - farY(x)) * 0.5);
      }
      for (const t of trees) {
        const d = Math.hypot(x - t.x, (y - t.y) * 1.1) - t.r * (0.92 + 0.16 * noise(x / 9, y / 9, seed));
        if (d < 0) {
          const [lx, ly] = toSunAt(x, y);
          const lit = clamp01(0.5 + (((x - t.x) / t.r) * lx + ((y - t.y) / t.r) * ly) * 0.6);
          return lerpC(tree, lerpC(mh, rim, 0.3), lit * 0.75);
        }
      }
      if (y < nearY(x)) {
        let c = lerpC(lerpC(mh, low, 0.12), mh, sstep(0, h * 0.08, y - midY(x)));
        c = lerpC(c, rim, sstep(h * 0.014, 0, y - midY(x)) * 0.55);
        return c;
      }
      const t = clamp01((y - nearY(x)) / (h - nearY(x) + 1));
      let c = lerpC(lerpC(gL, rim, 0.3), gL, sstep(0, 0.12, t));
      c = lerpC(c, gD, sstep(0.1, 1, t));
      // grass blades: light and dark streaks
      const blade = noise(x / 14, y / 90, seed + 5);
      c = lerpC(c, blade > 0.5 ? lerpC(gL, rim, 0.35) : gD, Math.abs(blade - 0.5) * 0.5);
      const fl = hash2(Math.floor(x / 16), Math.floor(y / 16), seed + 9);
      if (fl > 0.986 && t > 0.08) c = lerpC(c, fl > 0.994 ? hex("#FFF4D6") : fl > 0.99 ? hex("#FF9DB8") : hex(sky.cloudL), 0.9);
      return c;
    },
    flow(x, y) {
      if (y < farY(x)) {
        const cl = cloudAt(x, y);
        // strokes wrap around the billows (perpendicular to the surface normal)
        if (cl) return Math.atan2(cl.ny, cl.nx) + Math.PI / 2;
        return (fbm((x / S) * 2, (y / S) * 2, seed + 11, 2) - 0.5) * 0.5;
      }
      if (y < nearY(x)) {
        const e = 4;
        const f = y < midY(x) ? farY : midY;
        return Math.atan2(f(x + e) - f(x - e), 2 * e) + (noise(x / 60, y / 60, seed) - 0.5) * 0.4;
      }
      return -Math.PI / 2 + (fbm((x / S) * 4, (y / S) * 4, seed + 21, 2) - 0.5) * 0.9;
    },
    reach(x, y) {
      if (y < farY(x)) return cloudAt(x, y) ? 0.8 : 1.8; // long sweeps of open sky
      if (y > nearY(x)) return 1.6; // grass blades
      return 1;
    },
  };
}

/** A gouache colour field (the PFP ground): one hue, mottled, a light pool behind the pet. */
export function colourField(w: number, h: number, base: string, light: string, seed: number, cx = 0.5, cy = 0.45): Scene {
  const B = hex(base), Lc = hex(light);
  const S = Math.max(w, h);
  return {
    color(x, y) {
      const n = fbm((x / S) * 3, (y / S) * 3, seed, 4);
      const d = Math.hypot(x / w - cx, y / h - cy);
      let c = lerpC(B, Lc, clamp01(0.85 - d * 1.5));
      c = lerpC(c, n > 0.5 ? Lc : B, Math.abs(n - 0.5) * 0.5);
      return c;
    },
    flow(x, y) {
      return -0.5 + (fbm((x / S) * 2, (y / S) * 2, seed + 3, 2) - 0.5) * 1.4;
    },
    reach() {
      return 1.4;
    },
  };
}

/** The school-portrait backdrop: mottled blue cloth, lighter in the middle, a floor below. */
export function portraitBackdrop(w: number, h: number, floorY: number, seed: number): Scene {
  const deep = hex("#2C4670"), mid = hex("#6A8DBB"), lite = hex("#BED2EA"), floor = hex("#6B5443"), floorD = hex("#3E2F25");
  const S = Math.max(w, h);
  return {
    color(x, y) {
      if (y > floorY) return lerpC(floor, floorD, clamp01((y - floorY) / (h - floorY)));
      const n = fbm((x / S) * 2.5, (y / S) * 2.5, seed, 5);
      const d = Math.hypot((x / w - 0.5) * 1.2, y / h - 0.38);
      let c = lerpC(lite, mid, sstep(0.05, 0.5, d));
      c = lerpC(c, deep, sstep(0.45, 0.85, d));
      return lerpC(c, n > 0.5 ? lite : deep, Math.abs(n - 0.5) * 1.0);
    },
    flow(x, y) {
      if (y > floorY) return 0;
      return fbm((x / S) * 1.5, (y / S) * 1.5, seed + 5, 3) * Math.PI * 2;
    },
  };
}
