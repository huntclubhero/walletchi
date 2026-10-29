import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { Router, type Request, type Response, type NextFunction } from "express";
import { config } from "../config.js";
import { logger } from "../logger.js";
import type { AppContext } from "../context.js";
import type { Runner } from "../store/types.js";
import { petGameFramePng, petGameSpritePng, GAME_FACES, GAME_POSES, GAME_SPRITE, RenderBusyError, type GameFace, type GamePose } from "./pet.js";
import { petName } from "./names.js";
import { runnerNumber } from "./theme.js";
import { traitsFor } from "./traits.js";
import { stageFor } from "./stage.js";
import { valleyOrigin, valleyTokenSecret } from "./valley.js";

// CHI SHOT: the arcade game a pet's pass opens full screen. Pure fun: no
// tokens, no chain, no season state is read or written, so a tap here can never
// touch the game that holds value. The page is one HTML shell plus two scripts
// served from server/game/chishot on disk (the same way the old runner game
// shipped), so content tweaks need no rebuild.

export const GAME_TITLE = "CHI SHOT";

// Parsed once per distinct env value (the env does not change at runtime, but the
// gate check flips it in-process).
let serialsRaw: string | undefined;
let serials: ReadonlySet<string> = new Set();
function gameSerials(): ReadonlySet<string> {
  if (config.GAME_SERIALS !== serialsRaw) {
    serialsRaw = config.GAME_SERIALS;
    serials = new Set((serialsRaw ?? "").split(",").map((s) => s.trim()).filter((s) => s.length > 0));
  }
  return serials;
}

/**
 * True when this pet's pass carries the Play button and its /game page is served. Memorial
 * (tombstone) pets play too: a keeper whose pet has passed still gets the game on its card.
 */
export function gameEnabledFor(runner: Pick<Runner, "serial" | "gone">): boolean {
  return config.GAME_ENABLED || gameSerials().has(runner.serial);
}

// WATCH MODE allowlist (GAME_WATCH_SERIALS), parsed the same way.
let watchRaw: string | undefined;
let watchSerials: ReadonlySet<string> = new Set();
function gameWatchSerials(): ReadonlySet<string> {
  if (config.GAME_WATCH_SERIALS !== watchRaw) {
    watchRaw = config.GAME_WATCH_SERIALS;
    watchSerials = new Set((watchRaw ?? "").split(",").map((s) => s.trim()).filter((s) => s.length > 0));
  }
  return watchSerials;
}

/**
 * True when this pet's game page may lay itself out for an Apple Watch screen. The page still
 * only does so on a screen under 260 CSS px (or with ?watch=1); this gate decides whether the
 * boot JSON tells it that it is allowed to. No allowlist = no pet, and the page is unchanged.
 */
export function gameWatchFor(runner: Pick<Runner, "serial">): boolean {
  return gameWatchSerials().has(runner.serial);
}

export function gameUrl(serial: string): string {
  return `${config.PUBLIC_BASE_URL}/game/${serial}`;
}

const GAME_DIR = resolve(process.cwd(), "game", "chishot");
// Busts the 60 s script cache on every deploy, so a fresh page can never pair a new core.js
// with an old chishot.js.
const ASSET_VERSION = Date.now().toString(36);
// The only files the asset route will read: a fixed allowlist, never a path from the URL.
const ASSETS: Record<string, string> = {
  "planck.min.js": "planck.min.js",
  "core.js": "core.js",
  "chishot.js": "chishot.js",
  "lilita.ttf": "LilitaOne-Regular.ttf", // Lilita One, SIL OFL 1.1 (OFL-LilitaOne.txt alongside)
};

// The API's global CSP allows inline script only. The game page loads its two
// scripts from this origin, so it gets its own policy: same lockdown otherwise
// (no frames, no forms, no base rewriting), plus 'self' scripts and images.
const GAME_CSP = [
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

// CHI VALLEY may load the sprite and frame PNGs as WebGL textures straight from its own origin (it
// proxies by default). Only that one origin, and only while the valley is configured; otherwise the
// response is exactly what it was.
function valleyCors(req: Request, res: Response): void {
  if (!valleyTokenSecret()) return;
  res.vary("Origin");
  const origin = valleyOrigin();
  if (origin && req.headers.origin === origin) res.setHeader("Access-Control-Allow-Origin", origin);
}

function escapeJsonForScript(v: unknown): string {
  return JSON.stringify(v).replace(/</g, "\\u003c");
}

export function gameRouter(ctx: AppContext): Router {
  const r = Router();

  // The game page. 404 unless the pet is in the rollout, so the URL shape cannot
  // be used to reach the game before it is switched on for that pet.
  r.get("/game/:serial", wrap(async (req, res) => {
    const runner = await ctx.store.getRunner(req.params.serial!);
    if (!runner || !gameEnabledFor(runner)) return res.status(404).json({ error: "not found" });
    let shell: string;
    try {
      shell = await readFile(resolve(GAME_DIR, "index.html"), "utf8");
    } catch (err) {
      logger.error({ err: String(err) }, "game: index.html missing");
      return res.status(503).json({ error: "game unavailable" });
    }
    const seed = runner.tokenId ?? runner.serial;
    const traits = traitsFor(seed);
    const boot = {
      title: GAME_TITLE,
      serial: runner.serial,
      name: petName(runner.tokenId),
      number: runnerNumber(runner.tokenId, runner.serial),
      sprite: GAME_SPRITE,
      faces: Object.fromEntries(GAME_FACES.map((f) => [f, `/game/${runner.serial}/sprite/${f}.png`])),
      // The pet's trait set picks its mid-flight power, so pets genuinely play differently.
      shape: traits.names.shape,
      // The full trait set, so the game draws the pet as a cartoon of ITSELF (same eyes, ears or
      // horns, pattern, markings and accessory as its pass).
      traits: traits.names,
      v: ASSET_VERSION,
      palette: { body: traits.palette.B, outline: traits.palette.O, belly: traits.palette.L },
      // Present only for allowlisted pets, so every other page stays byte-identical.
      ...(gameWatchFor(runner) ? { watch: true } : {}),
    };
    // Function replacers: a "$&" or "$'" inside the data must stay literal.
    const json = escapeJsonForScript(boot);
    const html = shell.replace("/*__BOOT__*/null", () => json).replaceAll("__V__", ASSET_VERSION);
    res.setHeader("Content-Security-Policy", GAME_CSP);
    res.setHeader("Cache-Control", "no-store");
    res.type("html").send(html);
  }));

  // The pet's own sprite in a game face. Public like card.png (it is the same art).
  r.get("/game/:serial/sprite/:face.png", wrap(async (req, res) => {
    const face = req.params.face as GameFace;
    if (!GAME_FACES.includes(face)) return res.status(404).json({ error: "not found" });
    const runner = await ctx.store.getRunner(req.params.serial!);
    if (!runner || !gameEnabledFor(runner)) return res.status(404).json({ error: "not found" });
    let png: Buffer;
    try {
      png = await petGameSpritePng(runner.tokenId ?? runner.serial, face, stageFor(runner, new Date()));
    } catch (err) {
      if (err instanceof RenderBusyError) return res.status(503).json({ error: "busy" });
      throw err;
    }
    res.setHeader("Content-Type", "image/png");
    res.setHeader("Cache-Control", "public, max-age=3600");
    valleyCors(req, res);
    res.send(png);
  }));

  // The same sprite in a CHI VALLEY walk pose (stand, step, hop): same frame, gate and cache.
  // stand is byte-identical to /sprite/:face.png.
  r.get("/game/:serial/frame/:face/:pose.png", wrap(async (req, res) => {
    const face = req.params.face as GameFace;
    const pose = req.params.pose as GamePose;
    if (!GAME_FACES.includes(face) || !GAME_POSES.includes(pose)) return res.status(404).json({ error: "not found" });
    const runner = await ctx.store.getRunner(req.params.serial!);
    if (!runner || !gameEnabledFor(runner)) return res.status(404).json({ error: "not found" });
    let png: Buffer;
    try {
      png = await petGameFramePng(runner.tokenId ?? runner.serial, face, stageFor(runner, new Date()), pose);
    } catch (err) {
      if (err instanceof RenderBusyError) return res.status(503).json({ error: "busy" });
      throw err;
    }
    res.setHeader("Content-Type", "image/png");
    res.setHeader("Cache-Control", "public, max-age=3600");
    valleyCors(req, res);
    res.send(png);
  }));

  r.get("/game-assets/:file", wrap(async (req, res) => {
    const file = Object.hasOwn(ASSETS, req.params.file!) ? ASSETS[req.params.file!] : undefined;
    if (!file) return res.status(404).json({ error: "not found" });
    let body: Buffer;
    try {
      body = await readFile(resolve(GAME_DIR, file));
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
