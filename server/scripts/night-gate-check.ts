/**
 * CHI NIGHT GATE CHECK (runner/night.ts): the CHI NIGHT button and the /night page exist
 * ONLY for the pets the rollout names (NIGHT_SERIALS), or for every pet once NIGHT_ENABLED is on.
 * Every other pass must be unchanged, CHI SHOT must be untouched, and the button must never carry
 * a changeMessage (turning it on is silent). Also pins the asset allowlist, the page CSP, and that
 * the test switches are off on the real page. Real handlers, in-memory store + MockChain.
 *
 * Run: npx tsx scripts/night-gate-check.ts
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
process.env.NIGHT_ENABLED = "false";
process.env.NIGHT_SERIALS = "";

const { config } = await import("../src/config.js");
const { createApp } = await import("../src/app.js");
const { InMemoryStore } = await import("../src/store/memory.js");
const { Relayer } = await import("../src/chain/relayer.js");
const { MockChain } = await import("../src/chain/mock.js");
const { assembleRunnerPass } = await import("../src/runner/pass.js");
const { getRunnerGoogle } = await import("../src/runner/google.js");
const { nightEnabledFor } = await import("../src/runner/night.js");
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
const cfg = config as { GAME_ENABLED: boolean; GAME_SERIALS?: string; NIGHT_ENABLED: boolean; NIGHT_SERIALS?: string };

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

type BackField = { key: string; attributedValue?: string; changeMessage?: string };
async function appleBack(r: Awaited<ReturnType<typeof mint>>): Promise<BackField[]> {
  const p = await assembleRunnerPass(r, {});
  return (p.passJson as { storeCard?: { backFields?: BackField[] } }).storeCard?.backFields ?? [];
}
const google = getRunnerGoogle() as unknown as { loyaltyObject: (...a: unknown[]) => { linksModuleData: { uris: Array<{ id: string; uri: string }> } } };
const gLinks = (r: Awaited<ReturnType<typeof mint>>) => google.loyaltyObject(r, null, null, null, false).linksModuleData.uris;

try {
  const hunt = await mint("hunt@walletchi.test");
  const other = await mint("other@walletchi.test");
  const huntBefore = JSON.stringify(await appleBack(hunt));
  const otherBefore = JSON.stringify(await appleBack(other));
  const otherGoogleBefore = JSON.stringify(gLinks(other));

  console.log("\nswitched off (the default)");
  check("no pet is enabled", !nightEnabledFor(hunt) && !nightEnabledFor(other));
  check("/night is a 404", (await fetch(`${base}/night/${hunt.serial}`)).status === 404);
  check("no CHI NIGHT field on the Apple pass", !(await appleBack(hunt)).some((f) => f.key === "night"));
  check("no CHI NIGHT link on the Google pass", !gLinks(hunt).some((l) => l.id === "night"));

  console.log("\nallowlisted to one pet");
  cfg.NIGHT_SERIALS = ` ${hunt.serial} `;
  const hb = await appleBack(hunt);
  const nf = hb.find((f) => f.key === "night");
  check("the allowlisted pet's Apple pass has the CHI NIGHT field", !!nf);
  check("it links to its /night page", (nf?.attributedValue ?? "").includes(`/night/${hunt.serial}"`));
  check("it carries NO changeMessage (silent)", nf !== undefined && nf.changeMessage === undefined);
  check("it is the only change to that pass", JSON.stringify(hb.filter((f) => f.key !== "night")) === huntBefore);
  check("the allowlisted pet's Google pass has the link", gLinks(hunt).some((l) => l.id === "night" && l.uri.endsWith(`/night/${hunt.serial}`)));
  check("every OTHER Apple pass is byte-identical", JSON.stringify(await appleBack(other)) === otherBefore);
  check("every OTHER Google pass is byte-identical", JSON.stringify(gLinks(other)) === otherGoogleBefore);

  const page = await fetch(`${base}/night/${hunt.serial}`);
  const html = await page.text();
  const csp = page.headers.get("content-security-policy") ?? "";
  check("the game page is served", page.status === 200 && html.includes("<canvas"));
  check("the boot JSON is injected", !html.includes("/*__BOOT__*/") && html.includes(`"serial":"${hunt.serial}"`));
  check("the boot carries the pet's traits and palette", /"traits":\{/.test(html) && /"palette":\{"body":"#/.test(html));
  check("the test switches are OFF on the real page", !/"dev":true/.test(html));
  check("script URLs carry the deploy version", !html.includes("__V__") && /night\.js\?v=[0-9a-z]+/.test(html) && /art\.js\?v=[0-9a-z]+/.test(html));
  check("the page CSP lets it load its own scripts and font", /script-src 'self'/.test(csp) && /font-src 'self'/.test(csp));
  check("and still forbids framing and forms", /frame-ancestors 'none'/.test(csp) && /form-action 'none'/.test(csp));
  check("no-store on the page", (page.headers.get("cache-control") ?? "").includes("no-store"));
  check("another pet's /night is a 404", (await fetch(`${base}/night/${other.serial}`)).status === 404);
  check("an unknown serial is a 404", (await fetch(`${base}/night/not-a-pet`)).status === 404);

  for (const f of ["art.js", "night.js", "lilita.ttf"]) {
    const a = await fetch(`${base}/night-assets/${f}`);
    const want = f.endsWith(".ttf") ? "font/ttf" : "text/javascript";
    const len = Number(a.headers.get("content-length") ?? (await a.clone().arrayBuffer()).byteLength);
    check(`asset ${f} is served as ${want}`, a.status === 200 && (a.headers.get("content-type") ?? "").startsWith(want) && len > 1000);
  }
  for (const f of ["index.html", "chishot.js", "constructor", "__proto__", "..%2Fsrc%2Fconfig.ts", "..%2F..%2Fpackage.json"]) {
    check(`asset ${decodeURIComponent(f)} is refused`, (await fetch(`${base}/night-assets/${f}`)).status === 404);
  }

  console.log("\nCHI SHOT is untouched");
  check("CHI SHOT stays off while only CHI NIGHT is on", !(await appleBack(hunt)).some((f) => f.key === "game") && (await fetch(`${base}/game/${hunt.serial}`)).status === 404);
  cfg.GAME_SERIALS = hunt.serial;
  const both = (await appleBack(hunt)).map((f) => f.key);
  check("with both on, CHI SHOT leads and CHI NIGHT sits right under it", both.indexOf("game") >= 0 && both.indexOf("night") === both.indexOf("game") + 1, both.slice(0, 4).join(","));
  const gb = gLinks(hunt).map((l) => l.id);
  check("same order on Google", gb.indexOf("night") === gb.indexOf("game") + 1, gb.slice(0, 3).join(","));
  cfg.GAME_SERIALS = "";

  console.log("\nswitched on for everyone");
  cfg.NIGHT_SERIALS = "";
  cfg.NIGHT_ENABLED = true;
  check("every pet is enabled", nightEnabledFor(hunt) && nightEnabledFor(other));
  await store.updateRunner(other.serial, { gone: true });
  const tomb = (await store.getRunner(other.serial))!;
  check("a tombstone (passed-on) pet gets the game too", nightEnabledFor(tomb) && (await fetch(`${base}/night/${other.serial}`)).status === 200);
  check("and its memorial card carries the button", (await appleBack(tomb)).some((f) => f.key === "night"));
  cfg.NIGHT_ENABLED = false;
  check("switching off removes it again", !(await appleBack(hunt)).some((f) => f.key === "night") && (await fetch(`${base}/night/${hunt.serial}`)).status === 404);
} finally {
  server.close();
}

console.log(`\nRESULT: ${passes} passed, ${failures} failed`);
process.exit(failures === 0 ? 0 : 1);
