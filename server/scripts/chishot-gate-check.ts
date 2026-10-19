/**
 * CHI SHOT GATE CHECK (runner/game.ts): the Play button and the /game page exist ONLY for
 * the pets the rollout names (GAME_SERIALS), or for every living pet once GAME_ENABLED is on.
 * Every other pass must be unchanged. Also pins the asset allowlist and the page CSP.
 * Real handlers, in-memory store + MockChain.
 *
 * Run: npx tsx scripts/chishot-gate-check.ts
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
process.env.GAME_ENABLED = "false";
process.env.GAME_SERIALS = "";

const { config } = await import("../src/config.js");
const { createApp } = await import("../src/app.js");
const { InMemoryStore } = await import("../src/store/memory.js");
const { Relayer } = await import("../src/chain/relayer.js");
const { MockChain } = await import("../src/chain/mock.js");
const { assembleRunnerPass } = await import("../src/runner/pass.js");
const { getRunnerGoogle } = await import("../src/runner/google.js");
const { gameEnabledFor } = await import("../src/runner/game.js");
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
const cfg = config as { GAME_ENABLED: boolean; GAME_SERIALS?: string };

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

type BackField = { key: string; attributedValue?: string };
async function appleBack(r: Awaited<ReturnType<typeof mint>>): Promise<BackField[]> {
  const p = await assembleRunnerPass(r, {});
  return (p.passJson as { storeCard?: { backFields?: BackField[] } }).storeCard?.backFields ?? [];
}
const google = getRunnerGoogle() as unknown as { loyaltyObject: (...a: unknown[]) => { linksModuleData: { uris: Array<{ id: string; uri: string }> } } };

try {
  const hunt = await mint("hunt@walletchi.test");
  const other = await mint("other@walletchi.test");
  const otherBefore = JSON.stringify(await appleBack(other));
  const otherGoogleBefore = JSON.stringify(google.loyaltyObject(other, null, null, null, false).linksModuleData);

  console.log("\nswitched off (the default)");
  check("no pet is enabled", !gameEnabledFor(hunt) && !gameEnabledFor(other));
  check("/game is a 404", (await fetch(`${base}/game/${hunt.serial}`)).status === 404);
  check("no Play field on the Apple pass", !(await appleBack(hunt)).some((f) => f.key === "game"));

  cfg.GAME_SERIALS = ` ${hunt.serial} `;
  console.log("\nallowlisted to one pet");
  const hb = await appleBack(hunt);
  check("the allowlisted pet's Apple pass leads with the Play field", hb[0]?.key === "game", hb[0]?.key);
  check("the Play field links to its /game page", (hb[0]?.attributedValue ?? "").includes(`/game/${hunt.serial}"`));
  const hg = google.loyaltyObject(hunt, null, null, null, false).linksModuleData.uris;
  check("the allowlisted pet's Google pass leads with the Play link", hg[0]?.id === "game" && hg[0]?.uri.endsWith(`/game/${hunt.serial}`));
  check("every OTHER Apple pass is byte-identical", JSON.stringify(await appleBack(other)) === otherBefore);
  check("every OTHER Google pass is byte-identical", JSON.stringify(google.loyaltyObject(other, null, null, null, false).linksModuleData) === otherGoogleBefore);

  const page = await fetch(`${base}/game/${hunt.serial}`);
  const html = await page.text();
  const csp = page.headers.get("content-security-policy") ?? "";
  check("the game page is served", page.status === 200 && html.includes("<canvas"));
  check("the boot JSON is injected", !html.includes("/*__BOOT__*/") && html.includes(`"serial":"${hunt.serial}"`));
  check("script URLs carry the deploy version", !html.includes("__V__") && /core\.js\?v=[0-9a-z]+/.test(html));
  check("the page CSP lets it load its own scripts and font", /script-src 'self'/.test(csp) && /font-src 'self'/.test(csp));
  check("and still forbids framing and forms", /frame-ancestors 'none'/.test(csp) && /form-action 'none'/.test(csp));
  check("no-store on the page", (page.headers.get("cache-control") ?? "").includes("no-store"));
  check("another pet's /game is a 404", (await fetch(`${base}/game/${other.serial}`)).status === 404);
  check("an unknown serial is a 404", (await fetch(`${base}/game/not-a-pet`)).status === 404);

  const sprite = await fetch(`${base}/game/${hunt.serial}/sprite/yell.png`);
  check("the pet's sprite renders", sprite.status === 200 && sprite.headers.get("content-type") === "image/png");
  check("an unknown face is a 404", (await fetch(`${base}/game/${hunt.serial}/sprite/evil.png`)).status === 404);
  check("another pet's sprite is a 404", (await fetch(`${base}/game/${other.serial}/sprite/happy.png`)).status === 404);

  for (const f of ["planck.min.js", "core.js", "chishot.js", "lilita.ttf"]) {
    const a = await fetch(`${base}/game-assets/${f}`);
    const want = f.endsWith(".ttf") ? "font/ttf" : "text/javascript";
    check(`asset ${f} is served as ${want}`, a.status === 200 && (a.headers.get("content-type") ?? "").startsWith(want));
  }
  for (const f of ["index.html", "constructor", "__proto__", "..%2Fsrc%2Fconfig.ts", "..%2F..%2Fpackage.json"]) {
    check(`asset ${decodeURIComponent(f)} is refused`, (await fetch(`${base}/game-assets/${f}`)).status === 404);
  }

  console.log("\nswitched on for everyone");
  cfg.GAME_SERIALS = "";
  cfg.GAME_ENABLED = true;
  check("every living pet is enabled", gameEnabledFor(hunt) && gameEnabledFor(other));
  check("a tombstone (passed-on) pet gets the game too", gameEnabledFor({ ...other, gone: true }));
  check("and its /game page is served", await (async () => {
    await store.updateRunner(other.serial, { gone: true });
    return (await fetch(`${base}/game/${other.serial}`)).status === 200;
  })());
  const tomb = (await store.getRunner(other.serial))!;
  check("and its memorial card carries the Play button", (await appleBack(tomb)).some((f) => f.key === "game"));
  cfg.GAME_ENABLED = false;
} finally {
  server.close();
}

console.log(`\nRESULT: ${passes} passed, ${failures} failed`);
process.exit(failures === 0 ? 0 : 1);
