/**
 * PHOTO ALBUM preview: renders all five pictures for a few pets (and the shared poster and
 * class photo for a cast of N) to a folder, no database. Run:
 *   npx tsx scripts/album-preview.ts <outDir> [castSize]
 */
import sharp from "sharp";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { bannerSvg, pfpSvg, wallpaperSvg, posterSvg, classSvg } from "../src/runner/album-art.js";
import { petName } from "../src/runner/names.js";

const out = process.argv[2] ?? "album-preview";
const castN = Number(process.argv[3] ?? 100);
mkdirSync(out, { recursive: true });
const png = (svg: string, f: string) => sharp(Buffer.from(svg)).png().toFile(join(out, f));
for (const id of ["159", "27", "50", "140"]) {
  const pet = { seed: id, stage: 3 as const, name: petName(id), number: `No. ${id.padStart(4, "0")}` };
  await png(bannerSvg(pet), `banner-${id}.png`);
  await png(pfpSvg(pet), `pfp-${id}.png`);
  await png(wallpaperSvg(pet), `wallpaper-${id}.png`);
}
const cast = Array.from({ length: castN }, (_, i) => ({ seed: String(i + 1), stage: 3 as const }));
await png(posterSvg(cast), "poster.png");
await png(classSvg(cast), "class.png");
console.log("wrote", out);
