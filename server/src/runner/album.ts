import { Router, type Request, type Response, type NextFunction } from "express";
import { config } from "../config.js";
import { logger } from "../logger.js";
import type { AppContext } from "../context.js";
import type { Runner } from "../store/types.js";
import { createHash } from "node:crypto";
import { fork, type ChildProcess } from "node:child_process";
import { fileURLToPath } from "node:url";
import { petGameSpriteSvg, RenderBusyError } from "./pet.js";
import type { AlbumJob } from "./album-worker.js";
import { petName } from "./names.js";
import { runnerNumber } from "./theme.js";
import { traitsFor } from "./traits.js";
import { petVisualFor } from "./stage.js";
import {
  ALBUM_KINDS, ALBUM_LABELS, ALBUM_SIZES,
  type AlbumKind, type AlbumPet, type CastPet,
} from "./album-art.js";

// PHOTO ALBUM: a "Photo album" link on a living pet's pass opens one page with
// five buttons (banner, PFP, wallpaper, poster, class photo); each opens its
// picture with Save and Copy. Pure keepsake: no tokens, no chain, no season
// state is read or written. Memorials (tombstones) never get an album.

export const ALBUM_TITLE = "Photo album";
// The one-time announcement, word for word as Hunt approved it (2026-10-17). It is the album
// plain albumNote line's value (pass.ts), so Apple's "%@" banner reads exactly this.
export const ALBUM_NOTICE = "Your Chi went to a photoshoot. Check out your album. P.S. I love you";
// The neutral text the line carries before the banner step changes it to ALBUM_NOTICE.
export const ALBUM_PRIME = "Your Chi has a photo album.";

let serialsRaw: string | undefined;
let serials: ReadonlySet<string> = new Set();
function albumSerials(): ReadonlySet<string> {
  if (config.ALBUM_SERIALS !== serialsRaw) {
    serialsRaw = config.ALBUM_SERIALS;
    serials = new Set((serialsRaw ?? "").split(",").map((s) => s.trim()).filter((s) => s.length > 0));
  }
  return serials;
}

/** True when this pet's pass carries the album link and its /album pages are served. Living pets only. */
export function albumEnabledFor(runner: Pick<Runner, "serial" | "gone">): boolean {
  if (runner.gone) return false;
  return config.ALBUM_ENABLED || albumSerials().has(runner.serial);
}

let noteRaw: string | undefined;
let noteSerials: ReadonlySet<string> = new Set();
/** The announcement line's mode for this card: the catch-up list wins, else the global switch. */
export function albumNoteMode(runner: Pick<Runner, "serial">): "off" | "prime" | "quiet" | "banner" {
  if (config.ALBUM_NOTE_SERIALS !== noteRaw) {
    noteRaw = config.ALBUM_NOTE_SERIALS;
    noteSerials = new Set((noteRaw ?? "").split(",").map((s) => s.trim()).filter((s) => s.length > 0));
  }
  return noteSerials.has(runner.serial) ? config.ALBUM_NOTE_MODE : config.ALBUM_ANNOUNCE;
}

export function albumUrl(serial: string): string {
  return `${config.PUBLIC_BASE_URL}/album/${serial}`;
}

const ALBUM_CSP = [
  "default-src 'none'",
  "script-src 'unsafe-inline'",
  "style-src 'unsafe-inline'",
  "img-src 'self' data: blob:",
  "connect-src 'self'",
  "base-uri 'none'",
  "form-action 'none'",
  "frame-ancestors 'none'",
].join("; ");

type Wrapped = (req: Request, res: Response) => Promise<unknown>;
const wrap = (fn: Wrapped) => (req: Request, res: Response, next: NextFunction) => {
  fn(req, res).catch(next);
};

const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

function albumPet(runner: Runner): AlbumPet {
  return {
    seed: runner.tokenId ?? runner.serial,
    stage: petVisualFor(runner, new Date()).stage,
    name: petName(runner.tokenId),
    number: runnerNumber(runner.tokenId, runner.serial),
  };
}

// ---- the render process (album-worker.ts) ----
// Every album picture is painted and encoded in a separate low-priority process, never on the
// API's event loop (care taps and pass downloads must never wait behind a painting). One process,
// jobs in order, restarted on exit; a job that takes too long fails as "busy" and is retried on
// the next ask.
const JOB_TIMEOUT_MS = 90_000;
const MAX_QUEUED_JOBS = 400;
let child: ChildProcess | null = null;
let nextId = 1;
const waiting = new Map<number, { ok: (b: Buffer) => void; no: (e: Error) => void; timer: NodeJS.Timeout }>();

function workerPath(): string {
  const self = fileURLToPath(import.meta.url);
  return self.replace(/album\.(ts|js)$/, "album-worker.$1");
}

function renderChild(): ChildProcess {
  if (child && child.connected) return child;
  const c = fork(workerPath(), [], { serialization: "advanced", execArgv: process.execArgv, stdio: ["ignore", "inherit", "inherit", "ipc"] });
  c.on("message", (m: { id: number; ok: boolean; jpeg?: Uint8Array; error?: string }) => {
    const w = waiting.get(m.id);
    if (!w) return;
    waiting.delete(m.id);
    clearTimeout(w.timer);
    if (m.ok && m.jpeg) w.ok(Buffer.from(m.jpeg));
    else w.no(new Error(m.error ?? "album render failed"));
  });
  c.on("exit", (code) => {
    if (child === c) child = null;
    for (const [id, w] of waiting) {
      clearTimeout(w.timer);
      w.no(new RenderBusyError());
      waiting.delete(id);
    }
    if (code) logger.warn({ code }, "album: render process exited; restarting on next job");
  });
  c.unref();
  child = c;
  return c;
}

function renderAlbum(job: AlbumJob): Promise<Buffer> {
  if (waiting.size >= MAX_QUEUED_JOBS) return Promise.reject(new RenderBusyError());
  return new Promise<Buffer>((ok, no) => {
    const id = nextId++;
    const timer = setTimeout(() => {
      waiting.delete(id);
      no(new RenderBusyError());
    }, JOB_TIMEOUT_MS);
    waiting.set(id, { ok, no, timer });
    try {
      renderChild().send({ id, job });
    } catch (err) {
      clearTimeout(timer);
      waiting.delete(id);
      no(err instanceof Error ? err : new Error(String(err)));
    }
  });
}

/** Stop the render process (tests and shutdown). */
export function stopAlbumRenderer(): void {
  child?.kill();
  child = null;
}

// ---- shared pictures (poster, class photo): every living pet ----
// Kept until the cast changes (a death or a mint), and repainted in the background when it does
// (warmAlbum), so a keeper never waits on a ~5 s painting. The version is a short hash of the
// cast: the picture URLs carry it, so phones can cache them for a day and still never show a
// stale class.
// `last` is the most recent finished picture for the kind: when the cast changes, a keeper gets it
// at once (STALE WHILE REPAINT, 2026-10-19) instead of waiting behind the warm queue for the new
// cast's ~8 s painting; the fresh one replaces it for the next ask.
const shared = new Map<string, { key: string; img: Promise<Buffer>; last?: Buffer }>();
const castVersion = (key: string) => createHash("sha1").update(key).digest("hex").slice(0, 10);
const castKey = (cast: CastPet[]) => cast.map((c) => `${c.seed}:${c.stage ?? ""}`).join(",");

async function castOf(ctx: AppContext): Promise<CastPet[]> {
  const now = new Date();
  return (await ctx.store.allMintedRunners())
    .filter((r) => r.status === "ready" && !r.gone)
    .sort((a, b) => Number(a.tokenId ?? 0) - Number(b.tokenId ?? 0) || a.serial.localeCompare(b.serial))
    .map((r) => ({ seed: r.tokenId ?? r.serial, stage: petVisualFor(r, now).stage }));
}

/** The picture for this cast, plus the previous cast's finished picture while the new one paints. */
function sharedFor(cast: CastPet[], kind: "poster" | "class"): { img: Promise<Buffer>; stale: Buffer | null } {
  const key = castKey(cast);
  const hit = shared.get(kind);
  if (hit && hit.key === key) return { img: hit.img, stale: hit.last ?? null };
  const img = renderAlbum({ kind, cast });
  const entry = { key, img, last: hit?.last };
  shared.set(kind, entry);
  img.then(
    (buf) => {
      if (shared.get(kind) === entry) entry.last = buf;
    },
    () => {
      // a shed or failed render is retried on the next ask; the last good picture stays servable
      if (shared.get(kind) === entry) {
        if (entry.last) entry.key = "";
        else shared.delete(kind);
      }
    },
  );
  return { img, stale: entry.last ?? null };
}

/**
 * STALE WHILE REPAINT. After a mint-day rollover a keeper's poster took 9.6 s and the phone gave
 * up: the cast had changed (a death, a hatch) and the new painting sat behind the warm queue.
 * When the fresh picture is not done yet but an older cast's is, hand that one back now with
 * `stale: true` (the route then caches it only briefly); the fresh one is ready for the next ask.
 */
async function sharedImage(ctx: AppContext, kind: "poster" | "class"): Promise<{ body: Buffer; stale: boolean }> {
  const { img, stale } = sharedFor(await castOf(ctx), kind);
  if (!stale) return { body: await img, stale: false };
  const fresh = await Promise.race([img.then((b) => b, () => null), new Promise<null>((ok) => setTimeout(() => ok(null), 250))]);
  return fresh ? { body: fresh, stale: false } : { body: stale, stale: true };
}

// ---- personal pictures (banner, PFP, wallpaper): one pet each ----
// WHY A BYTE BUDGET (2026-10-26): the first cache was a 600-entry map that dropped its oldest
// entry on every insert. With more than 200 album pets (3 pictures each) the warm loop evicted
// its own work as it went, so every 5-minute cycle repainted every picture again: about 25
// minutes of painting per cycle, back to back, one CPU core for three days (Oct 22 to Oct 25)
// until deaths brought the cast under 200 pets. Now the cache is bounded by BYTES
// (ALBUM_CACHE_MB) and is a true LRU (a hit moves the entry to the back); the warm loop only
// fills FREE room and never evicts; a keeper's own request always paints on demand and may drop
// the coldest picture to make room. So the album always serves, and the painter is never busy
// for more than one short budgeted burst per cycle.
type PersonalKind = "banner" | "pfp" | "wallpaper";
type PersonalEntry = { img: Promise<Buffer>; bytes: number; done: boolean; warm: boolean };
const PERSONAL_KINDS: readonly PersonalKind[] = ["banner", "pfp", "wallpaper"];
const personal = new Map<string, PersonalEntry>();
let personalBytes = 0;
let largestPicture = 0; // the biggest JPEG painted so far: the warm's idea of "does one more fit"
const personalStats = { hits: 0, misses: 0, evictions: 0, dropped: 0 };
const maxPersonalBytes = () => Math.max(1, config.ALBUM_CACHE_MB) * 1024 * 1024;
const personalKey = (pet: AlbumPet, kind: PersonalKind) => `${kind}:${pet.seed}:${pet.stage ?? ""}`;
const personalCached = (pet: AlbumPet, kind: PersonalKind) => personal.get(personalKey(pet, kind))?.done === true;

/**
 * A keeper's request (`warm` false) always ends with the picture cached, evicting the coldest
 * pictures to make room. A warm painting (`warm` true) is kept only if it fits in the free room:
 * the warm NEVER evicts, so it can never undo its own earlier work (the 2026-10-22 thrash).
 */
function personalImage(pet: AlbumPet, kind: PersonalKind, opts: { warm?: boolean } = {}): Promise<Buffer> {
  const key = personalKey(pet, kind);
  const hit = personal.get(key);
  if (hit) {
    // LRU: a hit is the newest entry again; a keeper waiting on a warm painting makes it theirs
    personal.delete(key);
    personal.set(key, hit);
    if (!opts.warm) hit.warm = false;
    personalStats.hits += 1;
    return hit.img;
  }
  personalStats.misses += 1;
  const entry: PersonalEntry = { img: renderAlbum({ kind, pet }), bytes: 0, done: false, warm: !!opts.warm };
  personal.set(key, entry);
  entry.img.then(
    (buf) => {
      largestPicture = Math.max(largestPicture, buf.length);
      if (personal.get(key) !== entry) return;
      if (entry.warm && personalBytes + buf.length > maxPersonalBytes()) {
        personal.delete(key);
        personalStats.dropped += 1;
        return;
      }
      entry.bytes = buf.length;
      entry.done = true;
      personalBytes += buf.length;
      evictPersonal();
    },
    () => {
      // a shed or failed painting is retried on the next ask
      if (personal.get(key) === entry) personal.delete(key);
    },
  );
  return entry.img;
}

/** Drop the coldest FINISHED pictures until the cache fits its byte budget. A painting still in
 *  flight is never dropped: it holds no bytes yet and someone is waiting on it. */
function evictPersonal(): void {
  const max = maxPersonalBytes();
  for (const [key, e] of personal) {
    if (personalBytes <= max) break;
    if (!e.done) continue;
    personal.delete(key);
    personalBytes -= e.bytes;
    personalStats.evictions += 1;
  }
}

/** Cache keys, oldest first. Tests only. */
export function albumCacheKeysForTest(): string[] {
  return [...personal.keys()];
}

let warming = false;
let warmCursor = 0;
const warmLast = { at: null as string | null, ms: 0, shared: 0, personal: 0, skippedFull: 0, pets: 0, cachedPets: 0 };

/**
 * Paint the album ahead of time, so a keeper's first tap rarely waits on a painting: the poster
 * and class photo whenever the cast has changed, then the pets' own banner, PFP and wallpaper
 * that are not cached yet. Bounded three ways so a cycle ends in seconds, never minutes: only
 * pictures that are missing, only while the cache has free room (the warm never evicts), and at
 * most ALBUM_WARM_PER_CYCLE paintings per cycle; the cursor carries on where the last cycle
 * stopped so every pet gets its turn. One picture at a time, so the render queue always has room
 * for a keeper's live request. When the cache is full the rest paint on first open, as designed.
 */
export async function warmAlbum(ctx: AppContext): Promise<{ shared: number; personal: number; skippedFull: number }> {
  const done = { shared: 0, personal: 0, skippedFull: 0 };
  if (warming || (!config.ALBUM_ENABLED && !(config.ALBUM_SERIALS ?? "").trim())) return done;
  warming = true;
  const t0 = Date.now();
  try {
    const cast = await castOf(ctx);
    for (const kind of ["poster", "class"] as const) {
      try {
        await sharedFor(cast, kind).img;
        done.shared += 1;
      } catch (err) {
        logger.warn({ err: String(err), kind }, "album: warm render skipped");
      }
    }
    const pets = (await ctx.store.allMintedRunners()).filter((r) => r.status === "ready" && albumEnabledFor(r));
    const todo: Array<{ pet: AlbumPet; kind: PersonalKind; serial: string }> = [];
    let cachedPets = 0;
    for (const r of pets) {
      const pet = albumPet(r);
      const missing = PERSONAL_KINDS.filter((k) => !personalCached(pet, k));
      if (missing.length === 0) cachedPets += 1;
      for (const kind of missing) todo.push({ pet, kind, serial: r.serial });
    }
    const budget = Math.max(0, Math.floor(config.ALBUM_WARM_PER_CYCLE));
    if (todo.length > 0) {
      warmCursor %= todo.length;
      // "full" = one more picture of the largest size seen would not fit; a painting that turns
      // out not to fit is dropped (not cached) and also ends the cycle
      const full = () => personalBytes + largestPicture > maxPersonalBytes();
      let i = 0;
      for (; i < todo.length && done.personal < budget && !full(); i++) {
        const { pet, kind, serial } = todo[(warmCursor + i) % todo.length]!;
        try {
          await personalImage(pet, kind, { warm: true });
          if (!personalCached(pet, kind)) break;
          done.personal += 1;
        } catch (err) {
          logger.warn({ err: String(err), kind, serial }, "album: warm render skipped");
        }
      }
      if (i < todo.length && (full() || done.personal < budget)) done.skippedFull = todo.length - i;
      warmCursor = (warmCursor + i) % todo.length;
    }
    const ms = Date.now() - t0;
    Object.assign(warmLast, { at: new Date().toISOString(), ms, ...done, pets: pets.length, cachedPets });
    logger.info({ ...done, pets: pets.length, cachedPets, cacheMb: Number((personalBytes / 1048576).toFixed(1)), ms }, "album: warm done");
    return done;
  } finally {
    warming = false;
  }
}

/** The album's shape for /internal/status: cache fill, warm cadence, render queue depth. */
export function albumStats(): Record<string, unknown> {
  return {
    cache: {
      entries: personal.size,
      bytes: personalBytes,
      maxBytes: maxPersonalBytes(),
      hits: personalStats.hits,
      misses: personalStats.misses,
      evictions: personalStats.evictions,
      dropped: personalStats.dropped,
      largestBytes: largestPicture,
    },
    sharedKinds: [...shared.keys()],
    warm: { running: warming, ...warmLast },
    renderQueue: waiting.size,
  };
}

const NOTES: Record<AlbumKind, string> = {
  banner: "For your X and Discord header",
  pfp: "Your Chi, collection style",
  wallpaper: "For your lock screen",
  poster: "Every living Chi, made to share",
  class: "The whole class, say cheese",
};

function shell(title: string, accent: string, body: string, script = ""): string {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<meta name="theme-color" content="#081218"><title>${esc(title)}</title>
<style>
*{box-sizing:border-box;margin:0;padding:0}
html,body{min-height:100%;background:#081218;color:#EAF3F5;font-family:-apple-system,BlinkMacSystemFont,"SF Pro Display","Segoe UI",Roboto,Arial,sans-serif;-webkit-font-smoothing:antialiased}
body{background:radial-gradient(120% 70% at 50% 0%,${accent}55 0%,#0b1a22 55%,#081218 100%) fixed;min-height:100vh;display:flex;flex-direction:column;align-items:center;padding:calc(env(safe-area-inset-top) + 28px) 20px calc(env(safe-area-inset-bottom) + 28px)}
.mark{font-weight:800;letter-spacing:.04em;font-size:15px;color:#B7D2DA}.mark b{color:#F98F76}
.pet{width:132px;height:132px;margin:18px 0 6px;image-rendering:pixelated;animation:bob 2.4s ease-in-out infinite}
@keyframes bob{50%{transform:translateY(-6px)}}
h1{font-size:30px;font-weight:800;letter-spacing:-.01em;margin-top:6px}
.sub{color:#B7D2DA;font-size:15px;margin-top:6px}
.list{width:100%;max-width:380px;display:flex;flex-direction:column;gap:12px;margin-top:28px}
.btn{display:flex;flex-direction:column;justify-content:center;min-height:72px;padding:14px 22px;border-radius:20px;text-decoration:none;color:#EAF3F5;background:rgba(255,255,255,.07);border:1px solid rgba(255,255,255,.12);transition:transform .12s}
.btn:active{transform:scale(.98);background:rgba(255,255,255,.12)}
.btn b{font-size:19px;font-weight:700}.btn span{font-size:13px;color:#93B3BC;margin-top:3px}
.btn.main{background:#F98F76;border-color:#F98F76;color:#1d0f0b;align-items:center}
.btn.main b{font-size:18px}
.photo{width:100%;max-width:520px;margin-top:20px;border-radius:16px;box-shadow:0 20px 60px rgba(0,0,0,.5);-webkit-touch-callout:default}
.row{display:flex;gap:12px;width:100%;max-width:380px;margin-top:20px}.row .btn{flex:1;min-height:58px;align-items:center}
.back{margin-top:22px;color:#93B3BC;font-size:15px;text-decoration:none}
.hint{color:#7FA4AE;font-size:13px;margin-top:12px;text-align:center}
.toast{position:fixed;left:50%;bottom:calc(env(safe-area-inset-bottom) + 30px);transform:translateX(-50%);background:#EAF3F5;color:#081218;font-weight:700;padding:12px 20px;border-radius:999px;opacity:0;transition:opacity .2s}
.toast.on{opacity:1}
</style></head><body>${body}${script ? `<script>${script}</script>` : ""}</body></html>`;
}

function spriteDataUri(pet: AlbumPet): string {
  return "data:image/svg+xml;base64," + Buffer.from(petGameSpriteSvg(pet.seed, "happy", pet.stage)).toString("base64");
}

function albumPage(runner: Runner): string {
  const pet = albumPet(runner);
  const accent = traitsFor(pet.seed).palette.B;
  const buttons = ALBUM_KINDS.map(
    (k) => `<a class="btn" href="/album/${runner.serial}/${k}"><b>${ALBUM_LABELS[k]}</b><span>${NOTES[k]}</span></a>`,
  ).join("");
  return shell(
    `${pet.name} | Photo album`,
    accent,
    `<div class="mark">WALLETCHI<b>.</b></div>
     <img class="pet" src="${spriteDataUri(pet)}" alt="${esc(pet.name)}">
     <h1>Photo album</h1>
     <div class="sub">${esc(pet.name)} &middot; ${esc(pet.number)}</div>
     <div class="list">${buttons}</div>`,
  );
}

function photoPage(runner: Runner, kind: AlbumKind, version: string): string {
  const pet = albumPet(runner);
  const accent = traitsFor(pet.seed).palette.B;
  const src = `/album/${runner.serial}/${kind}.jpg?v=${version}`;
  const file = `walletchi-${(runner.tokenId ?? runner.serial.slice(0, 8)).padStart(4, "0")}-${kind}.jpg`;
  const script = `
const src=${JSON.stringify(src)},file=${JSON.stringify(file)};
const toast=(t)=>{const e=document.getElementById('toast');e.textContent=t;e.classList.add('on');setTimeout(()=>e.classList.remove('on'),1600)};
const blob=()=>fetch(src).then(r=>{if(!r.ok)throw new Error('busy');return r.blob()});
document.getElementById('save').onclick=async()=>{
  try{const b=await blob();const f=new File([b],file,{type:'image/jpeg'});
    if(navigator.canShare&&navigator.canShare({files:[f]})){await navigator.share({files:[f]});return}
    const a=document.createElement('a');a.href=URL.createObjectURL(b);a.download=file;document.body.appendChild(a);a.click();a.remove();toast('Saved')}
  catch(e){if(e&&e.name==='AbortError')return;toast('Press and hold the picture to save')}};
document.getElementById('copy').onclick=async()=>{
  // the clipboard only takes PNG: redraw the JPEG onto a canvas and copy that
  const png=()=>blob().then(createImageBitmap).then(bm=>{const c=document.createElement('canvas');c.width=bm.width;c.height=bm.height;c.getContext('2d').drawImage(bm,0,0);return new Promise((ok,no)=>c.toBlob(b=>b?ok(b):no(new Error('png')),'image/png'))});
  try{await navigator.clipboard.write([new ClipboardItem({'image/png':png()})]);toast('Copied')}
  catch(e){toast('Press and hold the picture to copy')}};`;
  const { w, h } = ALBUM_SIZES[kind];
  return shell(
    `${ALBUM_LABELS[kind]} | ${pet.name}`,
    accent,
    `<div class="mark">WALLETCHI<b>.</b></div>
     <h1 style="margin-top:14px">${ALBUM_LABELS[kind]}</h1>
     <div class="sub">${NOTES[kind]}</div>
     <img class="photo" src="${src}" width="${w}" height="${h}" alt="${ALBUM_LABELS[kind]}" style="height:auto${kind === "wallpaper" ? ";max-width:300px" : ""}">
     <div class="row"><a class="btn main" id="save" href="#" onclick="return false"><b>Save</b></a><a class="btn" id="copy" href="#" onclick="return false"><b>Copy</b></a></div>
     <div class="hint">Or press and hold the picture</div>
     <a class="back" href="/album/${runner.serial}">&larr; Back to the album</a>
     <div class="toast" id="toast"></div>`,
    script,
  );
}

export function albumRouter(ctx: AppContext): Router {
  const r = Router();
  // Pre-paint the shared pictures shortly after boot and whenever the cast has changed.
  if (process.env.NODE_ENV !== "test") {
    const warm = () => void warmAlbum(ctx).catch((err) => logger.warn({ err: String(err) }, "album: warm failed"));
    const boot = setTimeout(warm, 20_000);
    const timer = setInterval(warm, 5 * 60_000);
    boot.unref?.();
    timer.unref?.();
  }
  const runnerFor = async (serial: string) => {
    const runner = await ctx.store.getRunner(serial);
    return runner && runner.status === "ready" && albumEnabledFor(runner) ? runner : null;
  };
  const html = (res: Response, body: string) => {
    res.setHeader("Content-Security-Policy", ALBUM_CSP);
    res.setHeader("Cache-Control", "no-store");
    res.type("html").send(body);
  };
  const isKind = (k: string | undefined): k is AlbumKind => !!k && (ALBUM_KINDS as readonly string[]).includes(k);

  r.get("/album/:serial", wrap(async (req, res) => {
    const runner = await runnerFor(req.params.serial!);
    if (!runner) return res.status(404).json({ error: "not found" });
    html(res, albumPage(runner));
  }));

  r.get("/album/:serial/:file", wrap(async (req, res) => {
    const file = req.params.file!;
    const ext = /\.(jpg|png)$/.exec(file)?.[1];
    const kind = ext ? file.slice(0, -4) : file;
    if (!isKind(kind)) return res.status(404).json({ error: "not found" });
    const runner = await runnerFor(req.params.serial!);
    if (!runner) return res.status(404).json({ error: "not found" });
    const isShared = kind === "poster" || kind === "class";
    if (!ext) {
      const pet = albumPet(runner);
      const version = isShared ? castVersion(castKey(await castOf(ctx))) : `${pet.stage ?? 0}`;
      return html(res, photoPage(runner, kind, version));
    }
    // the first build served .png: send old links to the JPEG
    if (ext === "png") return res.redirect(301, `/album/${runner.serial}/${kind}.jpg`);
    let body: Buffer;
    let stale = false;
    try {
      if (isShared) ({ body, stale } = await sharedImage(ctx, kind));
      else body = await personalImage(albumPet(runner), kind);
    } catch (err) {
      if (err instanceof RenderBusyError) return res.status(503).json({ error: "busy" });
      logger.error({ err: String(err), kind }, "album: render failed");
      throw err;
    }
    res.setHeader("Content-Type", "image/jpeg");
    // versioned links (?v=) are safe to keep for a day; a bare link only briefly
    // versioned links (?v=) are safe to keep for a day; a bare link only briefly; a stale picture
    // (previous cast, the new one still painting) only for a minute so the fresh one lands soon
    res.setHeader("Cache-Control", stale ? "public, max-age=60" : req.query.v ? "public, max-age=86400" : "public, max-age=300");
    res.send(body);
  }));

  return r;
}
