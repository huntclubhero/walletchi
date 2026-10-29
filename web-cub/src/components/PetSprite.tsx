/**
 * The WALLETCHI creature as a 16x16 pixel sprite. Rendered as crisp SVG rects so it stays
 * sharp at any size. A `palette` override recolors it into distinct variants. The variant
 * palettes below are the CANONICAL 16 body hues from the server trait system
 * (server/src/runner/traits.ts), including the exact outline + belly per hue, so client-side
 * swatches match the server-rendered pets. Body hue is the dominant differentiator; the server
 * render remains the source of truth for a specific pet (per serial via /api/runner/:serial/card.png).
 */
export const PET_COLORS: Record<string, string> = {
  o: "#2f7d7a", // outline (deep teal)
  B: "#7fd0cb", // body (soft aqua)
  b: "#5cb8b2", // body shade / feet
  L: "#f6eede", // belly / light
  C: "#ff9d82", // cheek (salmon)
  E: "#241f38", // eye
  W: "#ffffff", // eye shine
  S: "#a68fd8", // sprout (lavender)
  m: "#e07a72", // mouth
};

export const PET_SPRITE = [
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

// Canonical 16 body hues (name, outline O, body B, belly L) from server traits.ts.
export const BODY_PALETTES = [
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

function darken(hex: string, amt: number): string {
  const n = parseInt(hex.slice(1), 16);
  const r = Math.round(((n >> 16) & 255) * (1 - amt));
  const g = Math.round(((n >> 8) & 255) * (1 - amt));
  const b = Math.round((n & 255) * (1 - amt));
  return `#${((r << 16) | (g << 8) | b).toString(16).padStart(6, "0")}`;
}

// Mirror the server's tokenId -> body-index mapping so a swatch for a tokenId matches its pet.
function bodyIndexForSeed(seed: string | number): number {
  let n: number;
  if (typeof seed === "number") n = Math.abs(Math.floor(seed));
  else {
    const p = parseInt(seed.trim(), 10);
    if (Number.isFinite(p) && String(p) === seed.trim()) n = Math.abs(p);
    else {
      let x = 2166136261 >>> 0;
      for (let i = 0; i < seed.length; i++) {
        x ^= seed.charCodeAt(i);
        x = Math.imul(x, 16777619) >>> 0;
      }
      n = x % 23040;
    }
  }
  const idx = (((n * 9973 + 12345) % 23040) + 23040) % 23040;
  return idx % 16;
}

/** Palette for a specific canonical body hue index (0..15). */
export function paletteForBody(i: number): Record<string, string> {
  const bp = BODY_PALETTES[((i % 16) + 16) % 16];
  return { ...PET_COLORS, o: bp.O, B: bp.B, b: darken(bp.B, 0.16), L: bp.L };
}

/** Deterministic palette variant from a seed (tokenId or serial), matching the server body hue. */
export function paletteFromSeed(seed: string | number): Record<string, string> {
  return paletteForBody(bodyIndexForSeed(seed));
}

export function PetSprite({
  size,
  className = "",
  palette,
}: {
  size?: number;
  className?: string;
  palette?: Record<string, string>;
}) {
  const colors = palette ? { ...PET_COLORS, ...palette } : PET_COLORS;
  return (
    <svg
      viewBox="0 0 16 16"
      width={size}
      height={size}
      className={className}
      shapeRendering="crispEdges"
      style={{ display: "block", overflow: "visible" }}
      aria-hidden
    >
      {PET_SPRITE.flatMap((row, y) =>
        row.split("").map((ch, x) =>
          ch === "." ? null : (
            <rect key={`${x}-${y}`} x={x} y={y} width={1.06} height={1.06} fill={colors[ch]} />
          ),
        ),
      )}
    </svg>
  );
}
