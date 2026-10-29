// PHOTO ALBUM RENDER PROCESS. Painting an album picture is heavy: ~0.1 to 0.4 s of synchronous
// JavaScript per picture (thousands of brush strokes) plus a multi-megabyte SVG raster. Done on
// the API's main thread it froze every other request while it ran: care taps waited 0.7 to 3.3 s
// and were abandoned, a pass download took 7 s, and the shared raster queue shed portraits with
// 503s (2026-10-17). So the API forks THIS process, at the lowest CPU priority with a single
// libvips thread, and it does all album painting and encoding. The API's own work (care taps, pass
// downloads, portraits) always wins the CPU.
//
// Protocol (IPC, advanced serialization): { id, job } in, { id, ok, jpeg } or { id, ok: false,
// error } out. Jobs are handled one at a time, in order.
import os from "node:os";
import sharp from "sharp";
import { bannerSvg, pfpSvg, wallpaperSvg, posterSvg, classSvg, type AlbumPet, type CastPet } from "./album-art.js";

export type AlbumJob =
  | { kind: "banner" | "pfp" | "wallpaper"; pet: AlbumPet }
  | { kind: "poster" | "class"; cast: CastPet[] };

try {
  os.setPriority(19); // nicest: the scheduler only gives us what the API is not using
} catch {
  // not permitted on this host: still isolated from the API's event loop
}
sharp.concurrency(1);
sharp.cache(false);

function svgFor(job: AlbumJob): string {
  switch (job.kind) {
    case "banner": return bannerSvg(job.pet);
    case "pfp": return pfpSvg(job.pet);
    case "wallpaper": return wallpaperSvg(job.pet);
    case "poster": return posterSvg(job.cast);
    case "class": return classSvg(job.cast);
  }
}

let chain = Promise.resolve();
process.on("message", (msg: { id: number; job: AlbumJob }) => {
  chain = chain.then(async () => {
    try {
      const svg = svgFor(msg.job);
      const jpeg = await sharp(Buffer.from(svg)).jpeg({ quality: 88, mozjpeg: true, chromaSubsampling: "4:4:4" }).toBuffer();
      process.send?.({ id: msg.id, ok: true, jpeg });
    } catch (err) {
      process.send?.({ id: msg.id, ok: false, error: String(err).slice(0, 300) });
    }
  });
});
process.on("disconnect", () => process.exit(0));
