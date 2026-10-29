import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { Router, type Request, type Response, type NextFunction } from "express";
import { config } from "../config.js";
import { logger } from "../logger.js";
import type { AppContext } from "../context.js";
import type { Runner } from "../store/types.js";
import { petName } from "./names.js";
import { runnerNumber } from "./theme.js";
import { traitsFor } from "./traits.js";
import { gameWatchFor } from "./game.js";

// CHI NIGHT: the bullet heaven a pet's pass opens full screen, the second game after CHI SHOT
// and wired the same way. Pure fun: no tokens, no chain, no season state is read or written, and the
// best time lives in the player's own browser. The page is one HTML shell plus two scripts served
// from server/game/night on disk, so content tweaks need no rebuild. The pet is drawn in the page by
// the CHI SHOT art code (art.js) from its trait set, so there is no per-pet image route.

export const NIGHT_TITLE = "CHI NIGHT";

// Parsed once per distinct env value (the env does not change at runtime, but the
// gate check flips it in-process).
let serialsRaw: string | undefined;
let serials: ReadonlySet<string> = new Set();
function nightSerials(): ReadonlySet<string> {
  if (config.NIGHT_SERIALS !== serialsRaw) {
    serialsRaw = config.NIGHT_SERIALS;
    serials = new Set((serialsRaw ?? "").split(",").map((s) => s.trim()).filter((s) => s.length > 0));
  }
  return serials;
}

/**
 * True when this pet's pass carries the CHI NIGHT button and its /night page is served.
 * Memorial (tombstone) pets play too, the same rule CHI SHOT follows.
 */
export function nightEnabledFor(runner: Pick<Runner, "serial" | "gone">): boolean {
  return config.NIGHT_ENABLED || nightSerials().has(runner.serial);
}

export function nightUrl(serial: string): string {
  return `${config.PUBLIC_BASE_URL}/night/${serial}`;
}

const NIGHT_DIR = resolve(process.cwd(), "game", "night");
// Busts the 60 s script cache on every deploy, so a fresh page can never pair a new night.js
// with an old art.js.
const ASSET_VERSION = Date.now().toString(36);
// The only files the asset route will read: a fixed allowlist, never a path from the URL.
// The font is CHI SHOT's own copy (Lilita One, SIL OFL 1.1, OFL-LilitaOne.txt alongside it).
const ASSETS: Record<string, string> = {
  "art.js": resolve(NIGHT_DIR, "art.js"),
  "night.js": resolve(NIGHT_DIR, "night.js"),
  "lilita.ttf": resolve(process.cwd(), "game", "chishot", "LilitaOne-Regular.ttf"),
};

// Same lockdown as the CHI SHOT page: inline boot script plus same-origin scripts, font and
// images; no frames, no forms, no base rewriting, and no network beyond this origin.
export const NIGHT_CSP = [
  "default-src 'none'",
  "script-src 'self' 'unsafe-inline'",
  "style-src 'unsafe-inline'",
  "img-src 'self' data: blob:",
  "font-src 'self'",
  "connect-src 'self'",
  "base-uri 'none'",
  "form-action 'none'",
  "frame-ancestors 'none'",
].join("; ");

type Wrapped = (req: Request, res: Response) => Promise<unknown>;
const wrap = (fn: Wrapped) => (req: Request, res: Response, next: NextFunction) => {
  fn(req, res).catch(next);
};

function escapeJsonForScript(v: unknown): string {
  return JSON.stringify(v).replace(/</g, "\\u003c");
}

export function nightRouter(ctx: AppContext): Router {
  const r = Router();

  // The game page. 404 unless the pet is in the rollout, so the URL shape cannot
  // be used to reach the game before it is switched on for that pet.
  r.get("/night/:serial", wrap(async (req, res) => {
    const runner = await ctx.store.getRunner(req.params.serial!);
    if (!runner || !nightEnabledFor(runner)) return res.status(404).json({ error: "not found" });
    let shell: string;
    try {
      shell = await readFile(resolve(NIGHT_DIR, "index.html"), "utf8");
    } catch (err) {
      logger.error({ err: String(err) }, "night: index.html missing");
      return res.status(503).json({ error: "game unavailable" });
    }
    const traits = traitsFor(runner.tokenId ?? runner.serial);
    const boot = {
      title: NIGHT_TITLE,
      serial: runner.serial,
      name: petName(runner.tokenId),
      number: runnerNumber(runner.tokenId, runner.serial),
      // The shape trait picks the CHI power (TURBO ROLL, TRIPLE ECHO, RAM RUSH, TAIL SLAM), and the
      // full trait set draws the pet as a cartoon of itself, exactly as CHI SHOT does.
      shape: traits.names.shape,
      traits: traits.names,
      palette: { body: traits.palette.B, outline: traits.palette.O, belly: traits.palette.L },
      font: `/night-assets/lilita.ttf?v=${ASSET_VERSION}`,
      // WATCH MODE: the same GAME_WATCH_SERIALS allowlist CHI SHOT uses (one list for both games).
      // Present only for allowlisted pets, so every other page stays byte-identical.
      ...(gameWatchFor(runner) ? { watch: true } : {}),
    };
    // Function replacers: a "$&" or "$'" inside the data must stay literal.
    const json = escapeJsonForScript(boot);
    const html = shell.replace("/*__BOOT__*/null", () => json).replaceAll("__V__", ASSET_VERSION);
    res.setHeader("Content-Security-Policy", NIGHT_CSP);
    res.setHeader("Cache-Control", "no-store");
    res.type("html").send(html);
  }));

  r.get("/night-assets/:file", wrap(async (req, res) => {
    const file = Object.hasOwn(ASSETS, req.params.file!) ? ASSETS[req.params.file!] : undefined;
    if (!file) return res.status(404).json({ error: "not found" });
    let body: Buffer;
    try {
      body = await readFile(file);
    } catch {
      return res.status(404).json({ error: "not found" });
    }
    res.setHeader("Content-Type", file.endsWith(".ttf") ? "font/ttf" : "text/javascript; charset=utf-8");
    // Short cache while the game is being tuned: a fix lands on the next open.
    res.setHeader("Cache-Control", "public, max-age=60");
    res.send(body);
  }));

  return r;
}
