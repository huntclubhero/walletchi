/**
 * PHOTO ALBUM GATE CHECK (runner/album.ts): the "Photo album" link and the /album pages exist
 * ONLY for the living pets the rollout names (ALBUM_SERIALS), or for every living pet once
 * ALBUM_ENABLED is on. Tombstones never get one. Every other pass must be unchanged, and the
 * banner lives on a separate PLAIN announcement line (ALBUM_ANNOUNCE), never on the link.
 * Real handlers, in-memory store + MockChain.
 *
 * Run: npx tsx scripts/album-gate-check.ts
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
process.env.ALBUM_ENABLED = "false";
process.env.ALBUM_SERIALS = "";
process.env.ALBUM_ANNOUNCE = "off";

const { config } = await import("../src/config.js");
const { createApp } = await import("../src/app.js");
const { InMemoryStore } = await import("../src/store/memory.js");
const { Relayer } = await import("../src/chain/relayer.js");
const { MockChain } = await import("../src/chain/mock.js");
const { assembleRunnerPass } = await import("../src/runner/pass.js");
const { getRunnerGoogle } = await import("../src/runner/google.js");
const { albumEnabledFor, ALBUM_NOTICE, ALBUM_PRIME, stopAlbumRenderer } = await import("../src/runner/album.js");
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
const cfg = config as { ALBUM_ENABLED: boolean; ALBUM_SERIALS?: string; ALBUM_ANNOUNCE: "off" | "prime" | "quiet" | "banner" };

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

type BackField = { key: string; value?: string; attributedValue?: string; changeMessage?: string };
async function appleBack(r: Awaited<ReturnType<typeof mint>>): Promise<BackField[]> {
  const p = await assembleRunnerPass(r, {});
  return (p.passJson as { storeCard?: { backFields?: BackField[] } }).storeCard?.backFields ?? [];
}
const google = getRunnerGoogle() as unknown as {
  loyaltyObject: (...a: unknown[]) => { linksModuleData: { uris: Array<{ id: string; uri: string; description?: string }> } };
};
const links = (r: Awaited<ReturnType<typeof mint>>) => google.loyaltyObject(r, null, null, null, false).linksModuleData.uris;

try {
  const hunt = await mint("hunt@walletchi.test");
  const other = await mint("other@walletchi.test");
  const otherBefore = JSON.stringify(await appleBack(other));
  const otherGoogleBefore = JSON.stringify(links(other));
  const huntBefore = JSON.stringify(await appleBack(hunt));

  console.log("\nswitched off (the default)");
  check("no pet is enabled", !albumEnabledFor(hunt) && !albumEnabledFor(other));
  check("/album is a 404", (await fetch(`${base}/album/${hunt.serial}`)).status === 404);
  check("/album image is a 404", (await fetch(`${base}/album/${hunt.serial}/pfp.png`)).status === 404);
  check("no album field on the Apple pass", !(await appleBack(hunt)).some((f) => f.key === "album"));

  cfg.ALBUM_SERIALS = ` ${hunt.serial} `;
  console.log("\nallowlisted to one pet, banner off");
  let hb = await appleBack(hunt);
  let af = hb.find((f) => f.key === "album");
  check("the allowlisted pet's Apple pass has the album field", !!af);
  check('it links to its /album page as "Photo album"', (af?.attributedValue ?? "") === `<a href="${base}/album/${hunt.serial}">Photo album</a>`, af?.attributedValue);
  check("the link field never carries a changeMessage", af !== undefined && af.changeMessage === undefined);
  check("no announcement line while ALBUM_ANNOUNCE is off", !hb.some((f) => f.key === "albumNote"));
  const hg = links(hunt);
  check("the Google pass carries the album link", hg.some((u) => u.id === "album" && u.uri.endsWith(`/album/${hunt.serial}`) && u.description === "Photo album"));
  check("every OTHER Apple pass is byte-identical", JSON.stringify(await appleBack(other)) === otherBefore);
  check("every OTHER Google pass is byte-identical", JSON.stringify(links(other)) === otherGoogleBefore);
  check("the only change to the named pass is the album field", JSON.stringify(hb.filter((f) => f.key !== "album")) === huntBefore);

  cfg.ALBUM_ANNOUNCE = "prime";
  console.log("\nannouncement: prime (quiet, neutral text)");
  const pr = (await appleBack(hunt)).find((f) => f.key === "albumNote");
  check("prime: the line carries the neutral text", pr?.value === ALBUM_PRIME && (ALBUM_PRIME as string) !== ALBUM_NOTICE);
  check("prime: no changeMessage, so adding it is silent", pr !== undefined && pr.changeMessage === undefined);
  check("prime: nothing on any other pass", JSON.stringify(await appleBack(other)) === otherBefore);
  cfg.ALBUM_ANNOUNCE = "banner";
  console.log("\nannouncement: banner (the value CHANGES to the message)");
  hb = await appleBack(hunt);
  af = hb.find((f) => f.key === "album");
  const note = hb.find((f) => f.key === "albumNote");
  check("the link still has no changeMessage", af !== undefined && af.changeMessage === undefined);
  check(
    "the announcement line is Hunt's exact sentence",
    note?.value === ALBUM_NOTICE && ALBUM_NOTICE === "Your Chi went to a photoshoot. Check out your album. P.S. I love you",
  );
  check("it is PLAIN text (no attributedValue, so the banner has no HTML)", note !== undefined && note.attributedValue === undefined && !/[<>]/.test(note.value ?? ""));
  check("it carries the %@ changeMessage", note?.changeMessage === "%@");
  check("it sits right under the album link", hb.findIndex((f) => f.key === "albumNote") === hb.findIndex((f) => f.key === "album") + 1);
  check("and still nothing on any other pass", JSON.stringify(await appleBack(other)) === otherBefore);
  cfg.ALBUM_ANNOUNCE = "quiet";
  const quiet = (await appleBack(hunt)).find((f) => f.key === "albumNote");
  check("quiet: the line stays, with no changeMessage", quiet?.value === ALBUM_NOTICE && quiet.changeMessage === undefined);
  cfg.ALBUM_ANNOUNCE = "off";
  check("off: the line is gone", !(await appleBack(hunt)).some((f) => f.key === "albumNote"));

  console.log("\ncatch-up for named cards only");
  const ncfg = config as { ALBUM_NOTE_SERIALS?: string; ALBUM_NOTE_MODE: "prime" | "quiet" | "banner" };
  cfg.ALBUM_ANNOUNCE = "off";
  cfg.ALBUM_ENABLED = true;
  const otherOn = JSON.stringify(await appleBack(other));
  ncfg.ALBUM_NOTE_SERIALS = hunt.serial;
  ncfg.ALBUM_NOTE_MODE = "prime";
  const cp = (await appleBack(hunt)).find((f) => f.key === "albumNote");
  check("the named card primes quietly with the neutral text", cp?.value === ALBUM_PRIME && cp.changeMessage === undefined);
  check("every other card is untouched while priming", JSON.stringify(await appleBack(other)) === otherOn);
  ncfg.ALBUM_NOTE_MODE = "banner";
  const cn = (await appleBack(hunt)).find((f) => f.key === "albumNote");
  check("then the named card's text CHANGES to the message, with the banner", cn?.value === ALBUM_NOTICE && cn.changeMessage === "%@");
  check("every other card is untouched (no line, no banner)", JSON.stringify(await appleBack(other)) === otherOn);
  ncfg.ALBUM_NOTE_MODE = "quiet";
  const cq = (await appleBack(hunt)).find((f) => f.key === "albumNote");
  check("quiet: the named card keeps the line, silent", cq?.value === ALBUM_NOTICE && cq.changeMessage === undefined);
  ncfg.ALBUM_NOTE_SERIALS = "";
  check("cleared: the line is gone from the named card", !(await appleBack(hunt)).some((f) => f.key === "albumNote"));
  ncfg.ALBUM_NOTE_MODE = "prime";
  cfg.ALBUM_ENABLED = false;

  console.log("\nthe pages");
  const page = await fetch(`${base}/album/${hunt.serial}`);
  const html = await page.text();
  const csp = page.headers.get("content-security-policy") ?? "";
  check("the album page is served", page.status === 200 && html.includes("Photo album"));
  for (const k of ["banner", "pfp", "wallpaper", "poster", "class"]) {
    check(`it has the ${k} button`, html.includes(`href="/album/${hunt.serial}/${k}"`));
  }
  check("its CSP forbids framing, forms and outside scripts", /frame-ancestors 'none'/.test(csp) && /form-action 'none'/.test(csp) && !/https?:/.test(csp));
  check("no-store on the page", (page.headers.get("cache-control") ?? "").includes("no-store"));
  const view = await fetch(`${base}/album/${hunt.serial}/class`);
  const vhtml = await view.text();
  check("a picture page is served with Save and Copy", view.status === 200 && vhtml.includes('id="save"') && vhtml.includes('id="copy"'));
  const sizes: Record<string, [number, number]> = { banner: [1500, 500], pfp: [1000, 1000], wallpaper: [1290, 2796], poster: [1600, 2000], class: [2400, 1600] };
  // the painting happens in the render process: the API's event loop must stay responsive
  let worstLag = 0;
  let last = performance.now();
  const tick = setInterval(() => {
    const now = performance.now();
    worstLag = Math.max(worstLag, now - last - 10);
    last = now;
  }, 10);
  await fetch(`${base}/album/${hunt.serial}/poster.jpg`);
  clearInterval(tick);
  check("painting a picture never stalls the API (event-loop lag < 60 ms)", worstLag < 60, `${worstLag.toFixed(0)} ms`);
  const sharp = (await import("sharp")).default;
  for (const [k, [w, h]] of Object.entries(sizes)) {
    const r = await fetch(`${base}/album/${hunt.serial}/${k}.jpg`);
    const b = Buffer.from(await r.arrayBuffer());
    const m = r.status === 200 ? await sharp(b).metadata() : { width: 0, height: 0, format: "" };
    check(`${k}.jpg renders at ${w}x${h}`, r.headers.get("content-type") === "image/jpeg" && m.format === "jpeg" && m.width === w && m.height === h, `${m.width}x${m.height} ${(b.length / 1024).toFixed(0)} KB`);
  }
  const old = await fetch(`${base}/album/${hunt.serial}/class.png`, { redirect: "manual" });
  check("an old .png link redirects to the JPEG", old.status === 301 && (old.headers.get("location") ?? "").endsWith(`/album/${hunt.serial}/class.jpg`));
  check("the picture page links a versioned JPEG", /class\.jpg\?v=[0-9a-f]{10}/.test(vhtml));
  const v2 = await fetch(`${base}/album/${hunt.serial}/class.jpg?v=abc`);
  check("a versioned picture is cacheable for a day", (v2.headers.get("cache-control") ?? "").includes("max-age=86400"));
  check("an unknown picture is a 404", (await fetch(`${base}/album/${hunt.serial}/selfie`)).status === 404);
  check("an unknown picture file is a 404", (await fetch(`${base}/album/${hunt.serial}/constructor.jpg`)).status === 404);
  check("another pet's /album is a 404", (await fetch(`${base}/album/${other.serial}`)).status === 404);
  check("an unknown serial is a 404", (await fetch(`${base}/album/not-a-pet`)).status === 404);
  const { warmAlbum } = await import("../src/runner/album.js");
  const warmed = await warmAlbum(ctx);
  check("warm paints the shared pictures and every album pet's own three", warmed.shared === 2 && warmed.personal === 3, JSON.stringify(warmed));
  const t0 = Date.now();
  await fetch(`${base}/album/${hunt.serial}/wallpaper.jpg`);
  check("a warmed picture is served from cache", Date.now() - t0 < 400, `${Date.now() - t0} ms`);

  console.log("\nswitched on for everyone");
  cfg.ALBUM_SERIALS = "";
  cfg.ALBUM_ENABLED = true;
  check("every living pet is enabled", albumEnabledFor(hunt) && albumEnabledFor(other));
  await store.updateRunner(other.serial, { gone: true });
  const tomb = (await store.getRunner(other.serial))!;
  check("a tombstone is NOT enabled", !albumEnabledFor(tomb));
  check("its memorial card has no album field", !(await appleBack(tomb)).some((f) => f.key === "album"));
  check("its Google card has no album link", !links(tomb).some((u) => u.id === "album"));
  check("its /album is a 404", (await fetch(`${base}/album/${other.serial}`)).status === 404);
  cfg.ALBUM_ENABLED = false;
} finally {
  stopAlbumRenderer();
  server.close();
}

console.log(`\nRESULT: ${passes} passed, ${failures} failed`);
process.exit(failures === 0 ? 0 : 1);
