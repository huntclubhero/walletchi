/**
 * PASS REFRESH CHECK (runner/pass-refresh.ts). The bug this pins: a setting that changes a card
 * without touching the pet's row (here GAME_SERIALS adding the Play button) never reached the card,
 * because a pinged phone was told "nothing new". After a refresh the same phone must hear "this pass
 * changed" and get the new pass, with the Play button on it.
 * Real handlers, in-memory store + MockChain.
 *
 * Run: npx tsx scripts/pass-refresh-check.ts
 */
process.env.NODE_ENV ??= "test";
process.env.LOG_LEVEL ??= "silent";
process.env.DATABASE_URL ??= "postgres://pr:pr@localhost:5432/pr";
process.env.DEMO_BYPASS_PAYMENT = "true";
process.env.PASS_STUB_MODE = "true";
process.env.EMAIL_STUB = "true";
process.env.GOOGLE_WALLET_STUB = "true";
process.env.PRIVY_APP_ID = "";
process.env.PRIVY_APP_SECRET = "";
process.env.ANTI_SYBIL_ENABLED = "false";
process.env.GAME_ENABLED = "false";
process.env.GAME_SERIALS = "";

const { config } = await import("../src/config.js");
const { createApp } = await import("../src/app.js");
const { InMemoryStore } = await import("../src/store/memory.js");
const { Relayer } = await import("../src/chain/relayer.js");
const { MockChain } = await import("../src/chain/mock.js");
const { refreshAllPasses, passRefreshState } = await import("../src/runner/pass-refresh.js");
const { formatUpdatedTag } = await import("../src/runner/pass-time.js");
const AdmZip = (await import("adm-zip")).default;
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
const cfg = config as { GAME_SERIALS?: string };

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

const DEVICE = "a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6";
try {
  const pet = await mint("keeper@walletchi.test");
  const gone = await mint("memorial@walletchi.test");
  await store.updateRunner(gone.serial, { gone: true });
  await store.upsertRunnerRegistration({ deviceLibraryId: DEVICE, passTypeId: config.PASS_TYPE_ID, serial: pet.serial, pushToken: "ab".repeat(32) });
  // the same phone also holds a memorial card
  await store.upsertRunnerRegistration({ deviceLibraryId: DEVICE, passTypeId: config.PASS_TYPE_ID, serial: gone.serial, pushToken: "ab".repeat(32) });
  const fresh = (await store.getRunner(pet.serial))!;

  const regsUrl = (since: Date) =>
    `${base}/runner-apple/v1/devices/${DEVICE}/registrations/${config.PASS_TYPE_ID}?passesUpdatedSince=${formatUpdatedTag(since)}`;
  const passGet = (ims: Date) =>
    fetch(`${base}/runner-apple/v1/passes/${config.PASS_TYPE_ID}/${pet.serial}`, {
      headers: { authorization: `ApplePass ${fresh.authToken}`, "if-modified-since": ims.toUTCString() },
    });

  await sleep(1100);
  const seen = new Date(); // the phone last synced now, after the pet's last row change
  console.log("\nbefore: the phone is up to date");
  check("asking what changed: nothing (204)", (await fetch(regsUrl(seen))).status === 204);
  check("the pass itself: not modified (304)", (await passGet(new Date(seen.getTime() + 1000))).status === 304);

  console.log("\na setting changes the card without touching the pet's row");
  cfg.GAME_SERIALS = pet.serial;
  check("THE BUG: the phone is still told nothing changed", (await fetch(regsUrl(seen))).status === 204);

  console.log("\nthe refresh runs");
  await sleep(1100);
  check("a refresh starts", await refreshAllPasses(ctx, "test"));
  check("a second one cannot start while it runs", !(await refreshAllPasses(ctx, "test")));
  check("it covers living pets only", passRefreshState().total === 1, `total ${passRefreshState().total}`);
  const regs = await fetch(regsUrl(seen));
  const body = regs.status === 200 ? ((await regs.json()) as { serialNumbers: string[]; lastUpdated: string }) : null;
  check("now the phone hears this pass changed", regs.status === 200 && !!body?.serialNumbers.includes(pet.serial));
  check("but NOT the memorial card on the same phone (it never changes)", !!body && !body.serialNumbers.includes(gone.serial), body?.serialNumbers.join(","));
  check("and its new sync tag is past the phone's last sync", body !== null && Number(body.lastUpdated) > seen.getTime());
  // the phone presents what it actually holds: the version from its last sync
  const got = await passGet(new Date(seen.getTime() - 1000));
  check("the pass download returns the new pass (200)", got.status === 200, String(got.status));
  if (got.status === 200) {
    const pass = JSON.parse(new AdmZip(Buffer.from(await got.arrayBuffer())).readAsText("pass.json")) as { storeCard?: { backFields?: Array<{ key: string }> } };
    check("and the Play button is on it", pass.storeCard?.backFields?.[0]?.key === "game");
  }
  const lm = got.headers.get("last-modified");
  const again = await fetch(`${base}/runner-apple/v1/passes/${config.PASS_TYPE_ID}/${pet.serial}`, {
    headers: { authorization: `ApplePass ${fresh.authToken}`, "if-modified-since": lm ?? "" },
  });
  check("fetching again with the Last-Modified it got: 304 (content unchanged)", again.status === 304, String(again.status));

  console.log("\nafter syncing again the phone is quiet");
  const synced = new Date(Number(body?.lastUpdated ?? Date.now()));
  check("asking again with the new tag: nothing (204)", (await fetch(regsUrl(synced))).status === 204);
  for (let i = 0; i < 40 && passRefreshState().running; i++) await sleep(50);
  check("the run finishes", !passRefreshState().running && passRefreshState().done === 1);

  console.log("\na launch that changes tombstones too (the game button on memorials)");
  await sleep(1100);
  check("a memorials refresh starts", await refreshAllPasses(ctx, "test", { memorials: true }));
  check("it covers the memorial pets as well", passRefreshState().total === 2, `total ${passRefreshState().total}`);
  // Each card is marked changed right before its own push now (no global epoch), so let the run walk.
  for (let i = 0; i < 60 && passRefreshState().running; i++) await sleep(50);
  const regs2 = await fetch(regsUrl(synced));
  const body2 = regs2.status === 200 ? ((await regs2.json()) as { serialNumbers: string[] }) : null;
  check("this time the memorial card IS re-sent, once", !!body2 && body2.serialNumbers.includes(gone.serial), body2?.serialNumbers.join(","));
  for (let i = 0; i < 60 && passRefreshState().running; i++) await sleep(50);
  const synced2 = regs2.status === 200 ? new Date(Number(((await fetch(regsUrl(synced)).then((r) => r.json())) as { lastUpdated: string }).lastUpdated)) : synced;
  await sleep(1100);
  check("a second memorials refresh starts", await refreshAllPasses(ctx, "test", { memorials: true }));
  for (let i = 0; i < 60 && passRefreshState().running; i++) await sleep(50);
  check("but nothing changed, so it pushed nobody", passRefreshState().pushed === 0 && passRefreshState().unchanged === 2, JSON.stringify(passRefreshState()));
  check("and the phone is told nothing changed", (await fetch(regsUrl(synced2))).status === 204);
  cfg.GAME_SERIALS = "";

  console.log("\nNEWS: the announcement line");
  const { assembleRunnerPass } = await import("../src/runner/pass.js");
  const { getRunnerGoogle } = await import("../src/runner/google.js");
  const newsCfg = config as { NEWS_TEXT?: string; NEWS_BANNER: boolean };
  type F = { key: string; value: string; changeMessage?: string };
  const backOf = async (r: Awaited<ReturnType<typeof mint>>) => ((await assembleRunnerPass(r, {})).passJson as { storeCard?: { backFields?: F[] } }).storeCard?.backFields ?? [];
  newsCfg.NEWS_TEXT = undefined;
  check("unset: no NEWS field on any card", !(await backOf(pet)).some((f) => f.key === "news"));
  newsCfg.NEWS_TEXT = "Your Chi learned a new trick. Tap to play CHI SHOT. P.S. I love you";
  newsCfg.NEWS_BANNER = false;
  const quiet = (await backOf(pet)).find((f) => f.key === "news");
  check("by default the NEWS line is SILENT (no changeMessage, so no banner ever)", !!quiet && quiet.changeMessage === undefined);
  newsCfg.NEWS_BANNER = true;
  const nf = (await backOf(pet)).find((f) => f.key === "news");
  check("only with NEWS_BANNER on does it carry a banner (changeMessage %@)", !!nf && nf.value === newsCfg.NEWS_TEXT && nf.changeMessage === "%@");
  newsCfg.NEWS_BANNER = false;
  const tomb = (await store.getRunner(gone.serial))!;
  check("the memorial card carries it too", (await backOf(tomb)).some((f) => f.key === "news"));
  const g = getRunnerGoogle() as unknown as { loyaltyObject: (...a: unknown[]) => { textModulesData: Array<{ id: string }> }; addMessage: (...a: unknown[]) => Promise<void> };
  check("the Google card leads with it", g.loyaltyObject(pet, null, null, null, false).textModulesData[0]?.id === "news");
  const sent: Array<{ serial: string; notify: boolean }> = [];
  const orig = g.addMessage;
  g.addMessage = async (r: unknown, _h: unknown, _b: unknown, notify: unknown) => { sent.push({ serial: (r as { serial: string }).serial, notify: notify === true }); };
  await sleep(1100);
  check("a news refresh starts", await refreshAllPasses(ctx, "test", { memorials: true, news: true }));
  for (let i = 0; i < 80 && passRefreshState().running; i++) await sleep(50);
  check("Google gets a NOTIFYING message for every pet, living and memorial", sent.length === 2 && sent.every((x) => x.notify) && sent.some((x) => x.serial === gone.serial), JSON.stringify(sent));
  g.addMessage = orig;
  newsCfg.NEWS_TEXT = undefined;
} finally {
  server.close();
}

console.log(`\nRESULT: ${passes} passed, ${failures} failed`);
process.exit(failures === 0 ? 0 : 1);
