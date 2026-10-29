/*
 * CHI SHOT WATCH MODE screenshot pass. Serves the game from disk the way /game/:serial does for a
 * GAME_WATCH_SERIALS pet (boot JSON with watch:true), opens it at the five Apple Watch viewports
 * (40, 41, 44, 45 and 49 mm, 2x, touch, a watchOS Safari user agent) and at two phone viewports,
 * and writes title, picker, sign, aim, pull, mid-shot, win, lose and finale screenshots to out/watch/. Every
 * tap target on every watch screen is audited: inside the viewport and at least 44 CSS px a side.
 *
 * With BEFORE_DIR pointing at a copy of main's game files (git show main:server/game/chishot/...)
 * the phones are rendered from those too, under a frozen clock, and the differing pixels are
 * counted: watch mode must leave a phone at exactly zero.
 *
 * Playwright is not a dependency of this package. PLAYWRIGHT_DIR names an install to load it from
 * (default: the lotus checkout). WEBKIT=1 renders the watch sizes in WebKit as well (closer to
 * Safari than Chromium; the audit and the phone diff stay on Chromium).
 *
 * Run: npx tsx scripts/chishot-watch-shots.ts
 */
import { createServer, type Server } from "node:http";
import { readFile, mkdir, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { resolve } from "node:path";
import type { AddressInfo } from "node:net";

const require = createRequire(import.meta.url);
const PW_DIR = process.env.PLAYWRIGHT_DIR ?? "C:/Users/skadd/lotus/node_modules/playwright";
const AFTER_DIR = resolve(process.cwd(), "game", "chishot");
const BEFORE_DIR = process.env.BEFORE_DIR ? resolve(process.env.BEFORE_DIR) : null;
const OUT = resolve(process.cwd(), "..", "out", "watch");
const WEBKIT = process.env.WEBKIT === "1";
const MIN_TAP = 44;

// watchOS Safari identifies itself like this (approximately; the page never reads it).
const WATCH_UA = "Mozilla/5.0 (Apple Watch; CPU watchOS 11_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1";
const PHONE_UA = "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1";

type Size = { name: string; w: number; h: number; watch: boolean };
const WATCH_SIZES: Size[] = [
  { name: "watch40mm-162x197", w: 162, h: 197, watch: true },
  { name: "watch41mm-176x215", w: 176, h: 215, watch: true },
  { name: "watch44mm-184x224", w: 184, h: 224, watch: true },
  { name: "watch45mm-198x242", w: 198, h: 242, watch: true },
  { name: "watch49mm-205x251", w: 205, h: 251, watch: true },
];
const PHONE_SIZES: Size[] = [
  { name: "phone-390x844", w: 390, h: 844, watch: false },
  { name: "phone-430x932", w: 430, h: 932, watch: false },
];

// The boot JSON /game/:serial would inject for an allowlisted pet (traits fixed, so every run
// draws the same Chi). Hunt's pet number is used for the name on the title screen only.
const BOOT = {
  title: "CHI SHOT",
  serial: "watch-proof",
  name: "Hunt's Chi",
  number: "No. 0159",
  sprite: { w: 1, h: 1 },
  faces: {},
  shape: "Round",
  traits: { eyes: "Round", cheeks: "Peach", marking: "None", accent: "Sprout", pattern: "Solid", shape: "Round", accessory: "None", belly: "Cream" },
  v: "proof",
  palette: { body: "#FFDB4E", outline: "#CE9E17", belly: "#FFF1AE" },
  watch: true,
};

function serveGame(dir: string): Promise<{ server: Server; base: string }> {
  const server = createServer(async (req, res) => {
    try {
      const url = new URL(req.url ?? "/", "http://localhost");
      if (url.pathname === "/") {
        const shell = await readFile(resolve(dir, "index.html"), "utf8");
        const json = JSON.stringify(BOOT).replace(/</g, "\\u003c");
        res.writeHead(200, { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" });
        return res.end(shell.replace("/*__BOOT__*/null", () => json).replaceAll("__V__", "proof"));
      }
      const m = url.pathname.match(/^\/game-assets\/(planck\.min\.js|core\.js|chishot\.js|lilita\.ttf)$/);
      if (m) {
        const font = m[1] === "lilita.ttf";
        res.writeHead(200, { "Content-Type": font ? "font/ttf" : "text/javascript; charset=utf-8", "Cache-Control": "no-store" });
        return res.end(await readFile(resolve(dir, font ? "LilitaOne-Regular.ttf" : m[1]!)));
      }
      res.writeHead(404);
      res.end("not found");
    } catch (err) {
      res.writeHead(500);
      res.end(String(err));
    }
  });
  return new Promise((ok) => {
    server.listen(0, "127.0.0.1", () => ok({ server, base: `http://127.0.0.1:${(server.address() as AddressInfo).port}` }));
  });
}

type Box = { x: number; y: number; w: number; h: number };
type Shot = { file: string; png: Buffer; buttons: Box[]; W: number; H: number; watchMode: boolean };

/* eslint-disable @typescript-eslint/no-explicit-any */
async function renderAll(browser: any, base: string, size: Size, ua: string, tag: string): Promise<Shot[]> {
  const shots: Shot[] = [];
  const context = await browser.newContext({
    viewport: { width: size.w, height: size.h },
    deviceScaleFactor: 2,
    isMobile: true,
    hasTouch: true,
    userAgent: ua,
  });
  // A frozen clock: Date, timers and requestAnimationFrame only move when told to, so the same
  // code draws the same pixels on every run (the phone diff depends on it). An installed clock
  // still ticks with real time until it is paused, so it is paused BEFORE the page loads: no
  // frame runs until runFor says so, however long the scripts and the font take to arrive.
  await context.clock.install({ time: new Date("2026-10-19T12:00:00Z") });
  await context.clock.pauseAt(new Date("2026-10-19T12:01:00Z"));
  const page = await context.newPage();
  const errors: string[] = [];
  page.on("pageerror", (e: Error) => errors.push(String(e)));
  await page.goto(`${base}/`);
  // the display font loads over the (real) network; wait for it before any frame is kept
  for (let i = 0; i < 100; i++) {
    const ok = await page.evaluate("!!(window.__chi && window.__chi.fontLoaded())");
    if (ok) break;
    await new Promise((r) => setTimeout(r, 50));
  }
  const chi = (expr: string) => page.evaluate(`window.__chi.${expr}`);
  const run = (ms: number) => page.clock.runFor(ms);
  const keep = async (screen: string) => {
    const png: Buffer = await page.screenshot({ type: "png" });
    // main's build (the BEFORE run) has none of the watch hooks; it only needs its pixels
    const buttons = (await chi("buttons ? window.__chi.buttons() : []")) as Box[];
    const sz = (await chi("size ? window.__chi.size() : { W: innerWidth, H: innerHeight }")) as { W: number; H: number };
    const watchMode = (await chi("watch ? window.__chi.watch() : false")) as boolean;
    const file = `${tag}-${size.name}-${screen}.png`;
    await writeFile(resolve(OUT, file), png);
    shots.push({ file, png, buttons, W: sz.W, H: sz.H, watchMode });
  };

  await run(1200);
  await keep("1-title");
  await chi("levels()");
  await run(400);
  await keep("2-picker");
  await chi("start(0)");
  await run(600);
  await keep("3-sign");
  await run(1000);
  await keep("4-aim");
  if (size.watch) {
    // a real thumb drag, from the middle of the screen (nowhere near the pet): down, pull back
    // and down-left, release
    const x0 = size.w * 0.55, y0 = size.h * 0.55;
    await page.mouse.move(x0, y0);
    await page.mouse.down();
    for (let i = 1; i <= 6; i++) {
      await page.mouse.move(x0 - (size.w * 0.4 * i) / 6, y0 + (size.h * 0.18 * i) / 6);
      await run(16);
    }
    await run(100);
    await keep("5-pull");
    await page.mouse.up();
    await run(50);
    const st = await chi("state()");
    if (st !== "flying") errors.push(`thumb drag did not launch (state ${String(st)})`);
  } else {
    await chi("shoot(-1.8, -0.9)");
  }
  await run(650);
  await keep("6-midshot");
  await chi("resultPreview(true)");
  await run(2600);
  await keep("7-win");
  await chi("resultPreview(false)");
  await run(1500);
  await keep("8-lose");
  await chi("finalPreview()");
  await run(5600);
  await keep("9-finale");
  await context.close();
  if (errors.length) throw new Error(`${tag} ${size.name}: ${errors.join("; ")}`);
  return shots;
}

// Differing pixels between two PNGs, counted in the browser (no image library needed here).
async function diffPixels(browser: any, a: Buffer, b: Buffer): Promise<number> {
  if (a.equals(b)) return 0;
  const page = await browser.newPage();
  // Sent as source text: tsx would otherwise inline helpers (__name) that do not exist in the page.
  const n = await page.evaluate(`(async function () {
    var load = function (src) { return new Promise(function (ok, bad) { var im = new Image(); im.onload = function () { ok(im); }; im.onerror = bad; im.src = src; }); };
    var ims = await Promise.all([load(${JSON.stringify(`data:image/png;base64,${a.toString("base64")}`)}), load(${JSON.stringify(`data:image/png;base64,${b.toString("base64")}`)})]);
    var ia = ims[0], ib = ims[1];
    if (ia.width !== ib.width || ia.height !== ib.height) return ia.width * ia.height;
    var read = function (im) { var c = document.createElement("canvas"); c.width = im.width; c.height = im.height; var g = c.getContext("2d"); g.drawImage(im, 0, 0); return g.getImageData(0, 0, c.width, c.height).data; };
    var da = read(ia), db = read(ib), diff = 0;
    for (var i = 0; i < da.length; i += 4) if (da[i] !== db[i] || da[i + 1] !== db[i + 1] || da[i + 2] !== db[i + 2] || da[i + 3] !== db[i + 3]) diff++;
    return diff;
  })()`);
  await page.close();
  return n as number;
}

await mkdir(OUT, { recursive: true });
const pw = require(PW_DIR) as any;
const after = await serveGame(AFTER_DIR);
const before = BEFORE_DIR ? await serveGame(BEFORE_DIR) : null;
let failures = 0;
const lines: string[] = [];
const say = (s: string) => { console.log(s); lines.push(s); };

const chromium = await pw.chromium.launch();
try {
  say("\nWATCH sizes (Chromium, watchOS Safari UA, 2x, touch)");
  for (const size of WATCH_SIZES) {
    const shots = await renderAll(chromium, after.base, size, WATCH_UA, "after");
    for (const s of shots) {
      const bad: string[] = [];
      if (!s.watchMode) bad.push("watch mode OFF");
      for (const b of s.buttons) {
        const full = b.w >= s.W && b.h >= s.H; // the tap-to-skip sheet over the whole screen
        if (full) continue;
        if (b.x < 0 || b.y < 0 || b.x + b.w > s.W + 0.5 || b.y + b.h > s.H + 0.5) bad.push(`off screen ${JSON.stringify(b)}`);
        if (b.w < MIN_TAP - 0.5 || b.h < MIN_TAP - 0.5) bad.push(`under ${MIN_TAP}px ${JSON.stringify(b)}`);
      }
      const ok = bad.length === 0;
      if (!ok) failures++;
      say(`  ${ok ? "ok  " : "FAIL"} ${s.file}  targets ${s.buttons.length}${bad.length ? "  " + bad.join("; ") : ""}`);
    }
  }

  say("\nPHONE sizes (Chromium, iPhone UA): watch flag present, watch mode must stay OFF");
  const afterPhones = new Map<string, Shot>();
  for (const size of PHONE_SIZES) {
    const shots = await renderAll(chromium, after.base, size, PHONE_UA, "after");
    for (const s of shots) {
      afterPhones.set(s.file.replace(/^after-/, ""), s);
      const ok = !s.watchMode;
      if (!ok) failures++;
      say(`  ${ok ? "ok  " : "FAIL"} ${s.file}  watch mode ${s.watchMode ? "ON" : "off"}`);
    }
  }
  if (before) {
    say("\nPHONE pixel diff, main's game files vs this branch (same frozen clock, same boot)");
    let total = 0;
    for (const size of PHONE_SIZES) {
      let shots = await renderAll(chromium, before.base, size, PHONE_UA, "before");
      let afters = new Map(afterPhones);
      for (let pass = 1; pass <= 2; pass++) {
        let sizeTotal = 0;
        const rows: string[] = [];
        for (const s of shots) {
          const key = s.file.replace(/^before-/, "");
          const a = afters.get(key);
          const n = a ? await diffPixels(chromium, s.png, a.png) : -1;
          if (n !== 0) sizeTotal += Math.abs(n);
          rows.push(`  ${n === 0 ? "ok  " : "FAIL"} ${key}  ${n < 0 ? "no after shot" : `${n} differing pixels`}${pass === 2 ? "  (second pass)" : ""}`);
        }
        if (sizeTotal === 0 || pass === 2) {
          for (const r of rows) say(r);
          total += sizeTotal;
          if (sizeTotal !== 0) failures++;
          break;
        }
        // A capture can race a frame once in a while (seen once in twenty runs); render both
        // builds of this phone again before believing a difference.
        say(`  ${size.name}: ${sizeTotal} differing pixels on the first pass, rendering both builds again`);
        shots = await renderAll(chromium, before.base, size, PHONE_UA, "before");
        afters = new Map();
        for (const s of await renderAll(chromium, after.base, size, PHONE_UA, "after")) afters.set(s.file.replace(/^after-/, ""), s);
      }
    }
    say(`  TOTAL differing pixels across both phones: ${total}`);
  } else say("\n(BEFORE_DIR not set: phone pixel diff skipped)");
} finally {
  await chromium.close();
}

if (WEBKIT) {
  say("\nWATCH sizes again in WebKit (Safari's engine)");
  const webkit = await pw.webkit.launch();
  try {
    for (const size of WATCH_SIZES) {
      const shots = await renderAll(webkit, after.base, size, WATCH_UA, "webkit");
      for (const s of shots) say(`  ${s.watchMode ? "ok  " : "FAIL"} ${s.file}`);
    }
  } catch (err) {
    say(`  WebKit pass failed: ${String(err)}`);
  } finally {
    await webkit.close();
  }
}

after.server.close();
before?.server.close();
await writeFile(resolve(OUT, "REPORT.txt"), lines.join("\n") + "\n");
console.log(`\nRESULT: ${failures === 0 ? "all checks passed" : `${failures} FAILED`}  (${OUT})`);
process.exit(failures === 0 ? 0 : 1);
