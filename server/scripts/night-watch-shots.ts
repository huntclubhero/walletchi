/*
 * CHI NIGHT WATCH MODE screenshot pass. Serves the game from disk the way /night/:serial does for a
 * GAME_WATCH_SERIALS pet (boot JSON with watch:true), opens it at the five Apple Watch viewports
 * (40, 41, 44, 45 and 49 mm, 2x, touch, a watchOS Safari user agent) and at two phone viewports,
 * and writes title, play, thumb drag, CHI ready, swarm, level up, chest, pause, knocked out and dawn
 * screenshots to out/watch-night/. Every tap target on every watch screen is audited: inside the
 * viewport and at least 44 CSS px a side. The thumb drag is real pointer input and must move the Chi.
 * The swarm screen jumps the night's clock so the scripted waves (the imp ring, the stampede, the
 * brutes) all fire at once and the horde is in the watch's zoomed view, with level-ups held off.
 *
 * With BEFORE_DIR pointing at a copy of main's game files (git show main:server/game/night/...)
 * the phones are rendered from those too, under a frozen clock, and the differing pixels are
 * counted: watch mode must leave a phone at exactly zero. The clock is driven by FRAME COUNT, not
 * milliseconds: runFor(700) was seen to fire 43 frames in one context and 44 in the next, and one
 * extra 16 ms step of a 400-gremlin simulation is a different picture on both builds.
 *
 * Playwright is not a dependency of this package. PLAYWRIGHT_DIR names an install to load it from
 * (default: the lotus checkout). WEBKIT=1 renders the watch sizes in WebKit as well (closer to
 * Safari than Chromium; the audit and the phone diff stay on Chromium).
 *
 * Run: npx tsx scripts/night-watch-shots.ts
 */
import { createServer, type Server } from "node:http";
import { readFile, mkdir, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { resolve } from "node:path";
import type { AddressInfo } from "node:net";

const require = createRequire(import.meta.url);
const PW_DIR = process.env.PLAYWRIGHT_DIR ?? "C:/Users/skadd/lotus/node_modules/playwright";
const AFTER_DIR = resolve(process.cwd(), "game", "night");
const FONT = resolve(process.cwd(), "game", "chishot", "LilitaOne-Regular.ttf");
const BEFORE_DIR = process.env.BEFORE_DIR ? resolve(process.env.BEFORE_DIR) : null;
const OUT = resolve(process.cwd(), "..", "out", "watch-night");
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

// The boot JSON /night/:serial would inject for an allowlisted pet (traits fixed, so every run
// draws the same Chi), plus dev:true so the page exposes its test hook (the real page never does).
const BOOT = {
  title: "CHI NIGHT",
  serial: "watch-proof",
  name: "Hunt's Chi",
  number: "No. 0159",
  shape: "Round",
  traits: { eyes: "Round", cheeks: "Peach", marking: "None", accent: "Sprout", pattern: "Solid", shape: "Round", accessory: "None", belly: "Cream" },
  palette: { body: "#FFDB4E", outline: "#CE9E17", belly: "#FFF1AE" },
  font: "/night-assets/lilita.ttf",
  watch: true,
  dev: true,
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
      const m = url.pathname.match(/^\/night-assets\/(art\.js|night\.js|lilita\.ttf)$/);
      if (m) {
        const font = m[1] === "lilita.ttf";
        res.writeHead(200, { "Content-Type": font ? "font/ttf" : "text/javascript; charset=utf-8", "Cache-Control": "no-store" });
        return res.end(await readFile(font ? FONT : resolve(dir, m[1]!)));
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
  // every animation frame the page gets is counted, so the clock can be stepped by frames
  await page.addInitScript("(function () { var raf = window.requestAnimationFrame; window.__rafN = 0; window.requestAnimationFrame = function (cb) { return raf.call(window, function (ts) { window.__rafN += 1; cb(ts); }); }; })()");
  const errors: string[] = [];
  page.on("pageerror", (e: Error) => errors.push(String(e)));
  await page.goto(`${base}/`);
  // the page boots (and exposes its hook) once the display font has loaded over the real network
  for (let i = 0; i < 200; i++) {
    const ok = await page.evaluate("!!window.__GN");
    if (ok) break;
    await new Promise((r) => setTimeout(r, 50));
  }
  if (!(await page.evaluate("!!window.__GN"))) throw new Error(`${tag} ${size.name}: the page never booted`);
  const gn = (expr: string) => page.evaluate(`window.__GN.${expr}`);
  const frames = async () => (await page.evaluate("window.__rafN")) as number;
  // Advance the clock until exactly round(ms / 16) more frames have run. Frames come every 16 ms
  // of clock time, so 8 ms steps never skip past one.
  const run = async (ms: number) => {
    const target = (await frames()) + Math.max(1, Math.round(ms / 16));
    while ((await frames()) < target) await page.clock.runFor(8);
  };
  const keep = async (screen: string) => {
    const png: Buffer = await page.screenshot({ type: "png" });
    // main's build (the BEFORE run) has none of the watch hooks; it only needs its pixels
    const buttons = (await gn("buttons ? window.__GN.buttons() : []")) as Box[];
    const sz = (await gn("size ? window.__GN.size() : { W: innerWidth, H: innerHeight }")) as { W: number; H: number };
    const watchMode = (await gn("watch ? window.__GN.watch() : false")) as boolean;
    const file = `${tag}-${size.name}-${screen}.png`;
    await writeFile(resolve(OUT, file), png);
    shots.push({ file, png, buttons, W: sz.W, H: sz.H, watchMode });
  };
  const petPos = async () => (await gn("S ? { x: window.__GN.S.p.x, y: window.__GN.S.p.y } : null")) as { x: number; y: number } | null;

  await run(1200);
  await keep("1-title");
  // one tap starts the night (the title's whole screen is the button on a wrist)
  await page.mouse.click(size.w / 2, size.h / 2);
  // long enough for the first gremlins to walk in from the simulation's edge
  await run(4200);
  await keep("2-play");
  // a real thumb drag from the lower half of the screen: down, slide up and to the left, hold
  const before = await petPos();
  const x0 = size.w * 0.5, y0 = size.h * 0.66;
  await page.mouse.move(x0, y0);
  await page.mouse.down();
  for (let i = 1; i <= 6; i++) {
    await page.mouse.move(x0 - (size.w * 0.22 * i) / 6, y0 - (size.h * 0.16 * i) / 6);
    await run(16);
  }
  await run(400);
  await keep("3-drag");
  const after = await petPos();
  await page.mouse.up();
  await run(50);
  if (!before || !after || Math.hypot(after.x - before.x, after.y - before.y) < 0.5) {
    errors.push(`thumb drag did not move the Chi (${JSON.stringify(before)} to ${JSON.stringify(after)})`);
  }
  // the CHI power meter filled: the corner button becomes a live target
  await gn("S.special.meter = window.__GN.S.special.need");
  await run(200);
  await keep("4-chiready");
  await gn("S.t = 190; window.__GN.S.need = 1e9");
  await run(2600);
  await keep("5-swarm");
  await gn("openLevelUp()");
  await run(700);
  await keep("6-levelup");
  await gn("pick(0)");
  await run(500);
  await gn("openChest('elite')");
  await run(3600);
  await keep("7-chest");
  await page.mouse.click(size.w / 2, size.h * 0.5);
  await run(400);
  await gn("setMode('pause')");
  await run(300);
  await keep("8-pause");
  await gn("setMode('play')");
  await run(100);
  // the end screens, entered the way endRun leaves the run (same on both builds)
  await gn("S.endT = 0; window.__GN.S.newBest = false; window.__GN.S.endConf = false; window.__GN.S.bestFx = false; window.__GN.setMode('dead')");
  await run(2600);
  await keep("9-dead");
  await gn("S.endT = 0; window.__GN.S.newBest = true; window.__GN.S.endConf = false; window.__GN.S.bestFx = false; window.__GN.setMode('win')");
  await run(3200);
  await keep("10-dawn");
  await context.close();
  if (errors.length) throw new Error(`${tag} ${size.name}: ${errors.join("; ")}`);
  return shots;
}

// Differing pixels between two PNGs, counted in the browser (no image library needed here), with
// the largest channel difference seen: 1 or 2 is raster noise, 200 is a different picture.
type Diff = { n: number; max: number };
async function diffPixels(browser: any, a: Buffer, b: Buffer): Promise<Diff> {
  if (a.equals(b)) return { n: 0, max: 0 };
  const page = await browser.newPage();
  // Sent as source text: tsx would otherwise inline helpers (__name) that do not exist in the page.
  const n = await page.evaluate(`(async function () {
    var load = function (src) { return new Promise(function (ok, bad) { var im = new Image(); im.onload = function () { ok(im); }; im.onerror = bad; im.src = src; }); };
    var ims = await Promise.all([load(${JSON.stringify(`data:image/png;base64,${a.toString("base64")}`)}), load(${JSON.stringify(`data:image/png;base64,${b.toString("base64")}`)})]);
    var ia = ims[0], ib = ims[1];
    if (ia.width !== ib.width || ia.height !== ib.height) return { n: ia.width * ia.height, max: 255 };
    var read = function (im) { var c = document.createElement("canvas"); c.width = im.width; c.height = im.height; var g = c.getContext("2d"); g.drawImage(im, 0, 0); return g.getImageData(0, 0, c.width, c.height).data; };
    var da = read(ia), db = read(ib), diff = 0, max = 0;
    for (var i = 0; i < da.length; i += 4) {
      var d = Math.max(Math.abs(da[i] - db[i]), Math.abs(da[i + 1] - db[i + 1]), Math.abs(da[i + 2] - db[i + 2]), Math.abs(da[i + 3] - db[i + 3]));
      if (d > 0) { diff += 1; if (d > max) max = d; }
    }
    return { n: diff, max: max };
  })()`);
  await page.close();
  return n as Diff;
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
        const full = b.w >= s.W && b.h >= s.H; // a tap-anywhere sheet over the whole screen
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
          const d = a ? await diffPixels(chromium, s.png, a.png) : { n: -1, max: 0 };
          if (d.n !== 0) sizeTotal += Math.abs(d.n);
          rows.push(`  ${d.n === 0 ? "ok  " : "FAIL"} ${key}  ${d.n < 0 ? "no after shot" : `${d.n} differing pixels${d.n > 0 ? `, largest channel difference ${d.max}` : ""}`}${pass === 2 ? "  (second pass)" : ""}`);
        }
        if (sizeTotal === 0 || pass === 2) {
          for (const r of rows) say(r);
          total += sizeTotal;
          if (sizeTotal !== 0) failures++;
          break;
        }
        // A capture can race a frame once in a while; render both builds of this phone again
        // before believing a difference. The first pass is still reported, so a repeat can be told
        // from raster noise.
        say(`  ${size.name}: ${sizeTotal} differing pixels on the first pass, rendering both builds again`);
        for (const r of rows) say(`  (first pass)${r}`);
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
    failures++;
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
