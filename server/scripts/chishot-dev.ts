/*
 * CHI SHOT local preview. Serves the game exactly as /game/:serial does,
 * for any tokenId, with no database: http://localhost:8787/?pet=159
 * Run: npx tsx scripts/chishot-dev.ts
 */
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { petGameSpritePng, GAME_FACES, GAME_SPRITE, type GameFace } from "../src/runner/pet.js";
import { petName } from "../src/runner/names.js";
import { runnerNumber } from "../src/runner/theme.js";
import { traitsFor } from "../src/runner/traits.js";

const DIR = resolve(process.cwd(), "game", "chishot");
const PORT = Number(process.env.SLING_PORT ?? 8787);

createServer(async (req, res) => {
  try {
    const url = new URL(req.url ?? "/", `http://localhost:${PORT}`);
    const pet = url.searchParams.get("pet") ?? "159";
    if (url.pathname === "/" || url.pathname === "/index.html") {
      const traits = traitsFor(pet);
      const boot = {
        title: "CHI SHOT",
        serial: `dev-${pet}`,
        name: petName(pet),
        number: runnerNumber(pet, `dev-${pet}`),
        sprite: GAME_SPRITE,
        faces: Object.fromEntries(GAME_FACES.map((f) => [f, `/sprite/${pet}/${f}.png`])),
        shape: url.searchParams.get("shape") ?? traits.names.shape,
        traits: { ...traits.names, ...(url.searchParams.get("shape") ? { shape: url.searchParams.get("shape") } : {}) },
        v: String(Date.now()),
        palette: { body: traits.palette.B, outline: traits.palette.O, belly: traits.palette.L },
      };
      const shell = await readFile(resolve(DIR, "index.html"), "utf8");
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" });
      const json = JSON.stringify(boot).replace(/</g, "\\u003c");
      return res.end(shell.replace("/*__BOOT__*/null", () => json).replaceAll("__V__", String(Date.now())));
    }
    const sprite = url.pathname.match(/^\/sprite\/([^/]+)\/(\w+)\.png$/);
    if (sprite && GAME_FACES.includes(sprite[2] as GameFace)) {
      const png = await petGameSpritePng(sprite[1]!, sprite[2] as GameFace);
      res.writeHead(200, { "Content-Type": "image/png" });
      return res.end(png);
    }
    const asset = url.pathname.match(/^\/game-assets\/(planck\.min\.js|core\.js|chishot\.js|lilita\.ttf)$/);
    if (asset) {
      const font = asset[1] === "lilita.ttf";
      res.writeHead(200, { "Content-Type": font ? "font/ttf" : "text/javascript; charset=utf-8", "Cache-Control": "no-store" });
      return res.end(await readFile(resolve(DIR, font ? "LilitaOne-Regular.ttf" : asset[1]!)));
    }
    res.writeHead(404);
    res.end("not found");
  } catch (err) {
    res.writeHead(500);
    res.end(String(err));
  }
}).listen(PORT, () => console.log(`CHI SHOT dev: http://localhost:${PORT}/?pet=159`));
