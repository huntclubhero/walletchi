/*
 * CHI NIGHT local preview. Serves the game exactly as /night/:serial does (same shell, boot
 * shape and page CSP), for any tokenId, with no database, plus the test switches:
 *   http://localhost:8788/?pet=159   (&god=1 can't die, &t=200 jump to 3:20, &fps=1, &shape=Tail)
 * Run: npx tsx scripts/night-dev.ts   (port: NIGHT_PORT, default 8788)
 */
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { petName } from "../src/runner/names.js";
import { runnerNumber } from "../src/runner/theme.js";
import { traitsFor } from "../src/runner/traits.js";
import { NIGHT_CSP, NIGHT_TITLE } from "../src/runner/night.js";

const DIR = resolve(process.cwd(), "game", "night");
const FONT = resolve(process.cwd(), "game", "chishot", "LilitaOne-Regular.ttf");
const PORT = Number(process.env.NIGHT_PORT ?? 8788);

createServer(async (req, res) => {
  try {
    const url = new URL(req.url ?? "/", `http://localhost:${PORT}`);
    const pet = url.searchParams.get("pet") ?? "159";
    if (url.pathname === "/" || url.pathname === "/index.html") {
      const traits = traitsFor(pet);
      const shape = url.searchParams.get("shape");
      const boot = {
        title: NIGHT_TITLE,
        serial: `dev-${pet}`,
        name: petName(pet),
        number: runnerNumber(pet, `dev-${pet}`),
        shape: shape ?? traits.names.shape,
        traits: { ...traits.names, ...(shape ? { shape } : {}) },
        palette: { body: traits.palette.B, outline: traits.palette.O, belly: traits.palette.L },
        font: "/night-assets/lilita.ttf",
        dev: true,
      };
      const shell = await readFile(resolve(DIR, "index.html"), "utf8");
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store", "Content-Security-Policy": NIGHT_CSP });
      const json = JSON.stringify(boot).replace(/</g, "\u003c");
      return res.end(shell.replace("/*__BOOT__*/null", () => json).replaceAll("__V__", String(Date.now())));
    }
    const asset = url.pathname.match(/^\/night-assets\/(art\.js|night\.js|lilita\.ttf)$/);
    if (asset) {
      const font = asset[1] === "lilita.ttf";
      res.writeHead(200, { "Content-Type": font ? "font/ttf" : "text/javascript; charset=utf-8", "Cache-Control": "no-store" });
      return res.end(await readFile(font ? FONT : resolve(DIR, asset[1]!)));
    }
    res.writeHead(404);
    res.end("not found");
  } catch (err) {
    res.writeHead(500);
    res.end(String(err));
  }
}).listen(PORT, () => console.log(`CHI NIGHT dev: http://localhost:${PORT}/?pet=159`));
