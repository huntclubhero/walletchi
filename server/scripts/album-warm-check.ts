/**
 * PHOTO ALBUM WARM + CACHE CHECK (runner/album.ts). The 2026-10-22 to 10-25 incident: a
 * 600-entry picture cache under more than 200 pets evicted its own warm work every cycle, so the
 * warm loop repainted every picture every 5 minutes (one CPU core for three days). This check
 * pins the new shape with real paintings in the render process and a tiny byte budget:
 *   - the warm loop paints only MISSING pictures, at most ALBUM_WARM_PER_CYCLE per cycle, and
 *     carries on where it stopped;
 *   - the warm loop NEVER evicts: once the cache is full a cycle paints nothing and ends in ms;
 *   - a keeper's own request still gets a picture (painted on demand, evicting the coldest);
 *   - the cache is a true LRU: a picture that was just served survives the next eviction;
 *   - the API's event loop never stalls while all of this paints;
 *   - /internal/status reports the shape.
 * Real handlers, in-memory store + MockChain.
 *
 * Run: npx tsx scripts/album-warm-check.ts
 */
process.env.NODE_ENV ??= "test";
process.env.LOG_LEVEL ??= "silent";
process.env.DATABASE_URL ??= "postgres://sg:sg@localhost:5432/sg";
process.env.DEMO_BYPASS_PAYMENT = "true";
process.env.PASS_STUB_MODE = "true";
process.env.EMAIL_STUB = "true";
process.env.GOOGLE_WALLET_STUB = "true";
process.env.PRIVY_APP_ID = "";
process.env.PRIVY_APP_SECRET = "";
process.env.ANTI_SYBIL_ENABLED = "false";
process.env.ALBUM_ENABLED = "true";
process.env.ALBUM_SERIALS = "";
process.env.ALBUM_ANNOUNCE = "off";
process.env.ALBUM_CACHE_MB = "1";
process.env.ALBUM_WARM_PER_CYCLE = "2";
process.env.INTERNAL_STATUS_TOKEN = "warm-check-token";

const { config } = await import("../src/config.js");
const { createApp } = await import("../src/app.js");
const { InMemoryStore } = await import("../src/store/memory.js");
const { Relayer } = await import("../src/chain/relayer.js");
const { MockChain } = await import("../src/chain/mock.js");
const { warmAlbum, albumStats, albumCacheKeysForTest, stopAlbumRenderer } = await import("../src/runner/album.js");
import type { AppContext } from "../src/context.js";
import type { AddressInfo } from "node:net";

let failures = 0;
let passes = 0;
function check(name: string, cond: boolean, detail = ""): void {
  if (cond) {
    passes += 1;
    console.log(`  ok   ${name}${detail ? `  (${detail})` : ""}`);
  } else {
    failures += 1;
    console.log(`  FAIL ${name}${detail ? `  (${detail})` : ""}`);
  }
}
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const store = new InMemoryStore();
const relayer = new Relayer(new MockChain());
const ctx = { store, relayer } as unknown as AppContext;
const server = createApp(ctx).listen(0);
await new Promise((r) => server.once("listening", r));
const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
(config as { PUBLIC_BASE_URL: string }).PUBLIC_BASE_URL = base;
const cfg = config as { ALBUM_CACHE_MB: number; ALBUM_WARM_PER_CYCLE: number };

type Stats = { cache: { entries: number; bytes: number; maxBytes: number; hits: number; misses: number; evictions: number; dropped: number; largestBytes: number }; warm: { ms: number; personal: number; skippedFull: number; pets: number; cachedPets: number } };
const stats = () => albumStats() as unknown as Stats;

async function mint(email: string) {
  const co = (await fetch(`${base}/api/runner/checkout`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ email }),
  }).then((r) => r.json())) as { id: string };
  let runner = await store.getRunner(co.id);
  for (let i = 0; i < 60 && runner?.status !== "ready"; i++) {
    await sleep(25);
    runner = await store.getRunner(co.id);
  }
  return runner!;
}

try {
  const pets = [];
  for (let i = 0; i < 6; i++) pets.push(await mint(`keeper${i}@walletchi.test`));
  const dead = await mint("tomb@walletchi.test");
  await store.updateRunner(dead.serial, { gone: true });
  // hatched day-one pets: stage 1 and stable for the whole check (an unhatched pet that hatches
  // mid-check would change every cache key, which is correct in production but noise here)
  for (const p of pets) await store.updateRunner(p.serial, { hatched: true });

  console.log("\nwarm cycle 1: a budgeted burst of MISSING pictures only");
  let lagWorst = 0;
  let lagLast = Date.now();
  const lagTimer = setInterval(() => {
    const now = Date.now();
    lagWorst = Math.max(lagWorst, now - lagLast - 20);
    lagLast = now;
  }, 20);
  const w1 = await warmAlbum(ctx);
  check("it painted both shared pictures", w1.shared === 2, `${w1.shared}`);
  check("it painted exactly ALBUM_WARM_PER_CYCLE personal pictures", w1.personal === 2, `${w1.personal}`);
  check("a tombstone is not in the warm set", stats().warm.pets === 6, `${stats().warm.pets} pets`);
  check("no eviction during the warm", stats().cache.evictions === 0);
  const after1 = albumCacheKeysForTest();
  check("the two pictures are cached", after1.length === 2, after1.join(" "));

  console.log("\nwarm cycle 2: carries on where it stopped (no repaint of cycle 1's work)");
  const w2 = await warmAlbum(ctx);
  const after2 = albumCacheKeysForTest();
  check("another burst of at most the budget", w2.personal <= 2 && w2.personal >= 1, `${w2.personal}`);
  check("cycle 1's pictures are still cached (not repainted)", after1.every((k) => after2.includes(k)));
  check("new keys were added, none repeated", new Set(after2).size === after2.length && after2.length > after1.length, `${after2.length} entries`);
  check("still no eviction", stats().cache.evictions === 0);

  console.log("\nfill the cache: once full, a warm cycle paints nothing and ends in milliseconds");
  let cycles = 0;
  for (; cycles < 40 && stats().warm.skippedFull === 0; cycles++) await warmAlbum(ctx);
  const full = stats();
  check("the warm stopped at the byte budget (one more largest picture would not fit)", full.warm.skippedFull > 0 && full.cache.bytes <= full.cache.maxBytes && full.cache.bytes + full.cache.largestBytes > full.cache.maxBytes, `${(full.cache.bytes / 1024).toFixed(0)} KB of ${(full.cache.maxBytes / 1024).toFixed(0)} KB after ${cycles} cycles, largest ${(full.cache.largestBytes / 1024).toFixed(0)} KB`);
  check("the warm never evicted to get there", full.cache.evictions === 0, `${full.cache.evictions} evictions, ${full.cache.dropped} dropped`);
  check("at most one painting was dropped for not fitting", full.cache.dropped <= 1, `${full.cache.dropped}`);
  const wFull = await warmAlbum(ctx);
  check("a full-cache cycle paints no personal picture", wFull.personal === 0, `${wFull.personal}`);
  check("and reports what it skipped because the cache is full", wFull.skippedFull > 0, `${wFull.skippedFull} skipped`);
  check("and ends in under a second", stats().warm.ms < 1000, `${stats().warm.ms} ms`);
  check("every warmed picture is still cached (nothing repainted)", stats().cache.misses === stats().cache.entries + stats().cache.dropped, `${stats().cache.misses} paintings for ${stats().cache.entries} cached`);
  check("the warm cycles left the event loop responsive (< 60 ms lag)", lagWorst < 60, `${lagWorst.toFixed(0)} ms worst`);
  lagWorst = 0;
  lagLast = Date.now();

  console.log("\na keeper still gets their art: on-demand paint evicts the coldest picture");
  const keys = albumCacheKeysForTest();
  const uncached = pets.find((p) => !keys.some((k) => k.endsWith(`:${p.tokenId ?? p.serial}:${keys[0]?.split(":")[2] ?? ""}`) && k.startsWith("wallpaper:")))!;
  const before = stats().cache.evictions;
  const t0 = Date.now();
  const r = await fetch(`${base}/album/${uncached.serial}/wallpaper.jpg`);
  const body = Buffer.from(await r.arrayBuffer());
  check("the picture is served (200 image/jpeg)", r.status === 200 && r.headers.get("content-type") === "image/jpeg" && body.length > 10_000, `${(body.length / 1024).toFixed(0)} KB in ${Date.now() - t0} ms`);
  await sleep(50);
  check("painting it never stalled the API (< 60 ms lag)", lagWorst < 60, `${lagWorst.toFixed(0)} ms worst`);
  check("the cache evicted to make room", stats().cache.evictions > before, `${stats().cache.evictions - before} evicted`);
  check("the cache is back under its budget", stats().cache.bytes <= stats().cache.maxBytes);

  console.log("\ntrue LRU: a picture that was just served survives the next eviction");
  const order = albumCacheKeysForTest();
  const coldest = order[0]!;
  const [cKind, cSeed] = coldest.split(":");
  const coldPet = pets.find((p) => String(p.tokenId ?? p.serial) === cSeed)!;
  const touch = await fetch(`${base}/album/${coldPet.serial}/${cKind}.jpg`);
  check("serving the coldest picture is a cache hit", touch.status === 200 && albumCacheKeysForTest().at(-1) === coldest, "moved to the back");
  // paint another uncached picture to force one more eviction
  const other = pets.find((p) => !albumCacheKeysForTest().some((k) => k.startsWith(`banner:${p.tokenId ?? p.serial}:`)))!;
  await fetch(`${base}/album/${other.serial}/banner.jpg`);
  await sleep(50);
  check("the touched picture survived the eviction", albumCacheKeysForTest().includes(coldest));
  check("the oldest untouched one went instead", !albumCacheKeysForTest().includes(order[1]!), order[1]);

  console.log("\n/internal/status reports the album shape");
  const st = (await fetch(`${base}/internal/status`, { headers: { authorization: "Bearer warm-check-token" } }).then((r) => r.json())) as { album?: Stats };
  check("album.cache has entries, bytes, maxBytes, evictions", !!st.album && typeof st.album.cache.entries === "number" && st.album.cache.maxBytes === 1024 * 1024 && typeof st.album.cache.evictions === "number");
  check("album.warm has ms, personal, skippedFull, pets, cachedPets", !!st.album && ["ms", "personal", "skippedFull", "pets", "cachedPets"].every((k) => typeof (st.album!.warm as Record<string, unknown>)[k] === "number"));

  console.log("\nbudget knobs");
  cfg.ALBUM_WARM_PER_CYCLE = 0;
  const w0 = await warmAlbum(ctx);
  check("ALBUM_WARM_PER_CYCLE=0 paints no personal picture", w0.personal === 0);
  cfg.ALBUM_CACHE_MB = 64;
  cfg.ALBUM_WARM_PER_CYCLE = 100;
  const wBig = await warmAlbum(ctx);
  check("with room again the warm finishes every missing picture", wBig.personal > 0 && wBig.skippedFull === 0, `${wBig.personal} painted`);
  const wNone = await warmAlbum(ctx);
  check("and a rerun paints nothing: every pet's three pictures are cached", wNone.personal === 0 && wNone.skippedFull === 0 && stats().warm.cachedPets === 6, `${stats().warm.cachedPets} pets complete, ${stats().warm.ms} ms`);
  clearInterval(lagTimer);
} finally {
  stopAlbumRenderer();
  server.close();
}

console.log(`\nRESULT: ${passes} passed, ${failures} failed`);
process.exit(failures === 0 ? 0 : 1);
