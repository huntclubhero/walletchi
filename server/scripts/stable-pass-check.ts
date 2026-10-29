/**
 * STABLE PASS FIELDS + DEVICE-TRUE DIFF LOG CHECK (runner/pass-memory.ts, runner/pass-diff.ts,
 * runner/pass-refresh.ts). iOS compares a new pass with the copy on the phone, and a field that
 * vanished on a failed read and came back on the next pass read as ADDED, which raised the generic
 * "Pass changed" banner (2026-10-17). This pins:
 *  (a) when the headcount, balance and countdown reads fail, a living pet's pass still carries
 *      ALIVE, CARE and SURVIVES with the last VERIFIED values (and a pet that never had a verified
 *      value gets no placeholder);
 *  (b) after a simulated restart (all in-process state reset, same store) the next pass has the
 *      same field set, and a restart alone serves no new pass before the boot refresh;
 *  (c) the diff log diffs against the snapshot whose Last-Modified is the request's
 *      If-Modified-Since, falls back to the newest one with a flag, is bounded, writes nothing on
 *      a 304, and survives a restart.
 * Real handlers, in-memory store + MockChain.
 *
 * Run: npx tsx scripts/stable-pass-check.ts
 */
process.env.NODE_ENV ??= "test";
process.env.LOG_LEVEL ??= "silent";
process.env.DATABASE_URL ??= "postgres://sp:sp@localhost:5432/sp";
process.env.DEMO_BYPASS_PAYMENT = "true";
process.env.PASS_STUB_MODE = "true";
process.env.EMAIL_STUB = "true";
process.env.GOOGLE_WALLET_STUB = "true";
process.env.PRIVY_APP_ID = "";
process.env.PRIVY_APP_SECRET = "";
process.env.ANTI_SYBIL_ENABLED = "false";

const { config } = await import("../src/config.js");
const { createApp } = await import("../src/app.js");
const { InMemoryStore } = await import("../src/store/memory.js");
const { Relayer } = await import("../src/chain/relayer.js");
const { MockChain } = await import("../src/chain/mock.js");
const { assembleRunnerPass } = await import("../src/runner/pass.js");
const { stablePassInputs, _resetPassFieldMemoryCache } = await import("../src/runner/pass-memory.js");
const { refreshSeasonSnapshot, headcountVerified, _resetSeasonForRestartTest } = await import("../src/runner/season.js");
const { waitForVerifiedHeadcount } = await import("../src/runner/pass-refresh.js");
const { logPassDiff, PASS_DIFF_KEEP } = await import("../src/runner/pass-diff.js");
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
const mock = new MockChain();
const relayer = new Relayer(mock);
const ctx = { store, relayer } as unknown as AppContext;
const server = createApp(ctx).listen(0);
await new Promise((r) => server.once("listening", r));
const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
(config as { PUBLIC_BASE_URL: string }).PUBLIC_BASE_URL = base;
config.modes.survivalLive = true;

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

type F = { key: string; value: string };
type PJ = Record<string, unknown> & { storeCard: Record<string, F[]>; posterGeneric?: Record<string, F[]>; relevantDates?: unknown };
const SECTIONS = ["headerFields", "primaryFields", "secondaryFields", "auxiliaryFields", "footerFields", "backFields"];
function fieldMap(pj: PJ): Map<string, string> {
  const out = new Map<string, string>();
  for (const dict of ["storeCard", "posterGeneric"] as const) {
    const d = pj[dict];
    if (!d) continue;
    for (const s of SECTIONS) for (const f of d[s] ?? []) out.set(`${dict}.${s}.${f.key}`, f.value);
  }
  return out;
}
const keysOf = (m: Map<string, string>) => [...m.keys()].sort().join(",");
async function build(serial: string): Promise<PJ> {
  const r = (await store.getRunner(serial))!;
  return (await assembleRunnerPass(r, await stablePassInputs(ctx, r))).passJson as PJ;
}
const header = (pj: PJ, key: string) => pj.storeCard.headerFields!.find((f) => f.key === key)?.value;
const life = (pj: PJ) => pj.storeCard.secondaryFields!.find((f) => f.key === "life")?.value;

// Chain failure switches: every read the three fields depend on.
const m = mock as unknown as Record<string, (...a: unknown[]) => Promise<unknown>>;
const orig = { petVaultStats: m.petVaultStats!, careBalanceOf: m.careBalanceOf!, petNeeds: m.petNeeds! };
function chainDown(): void {
  const boom = async () => {
    throw new Error("mock: rpc down");
  };
  m.petVaultStats = boom;
  m.careBalanceOf = boom;
  m.petNeeds = boom;
}
function chainUp(): void {
  Object.assign(m, orig);
}
/** The in-process half of a restart: nothing verified, no caches, no remembered values in memory. */
function restart(): void {
  _resetSeasonForRestartTest();
  _resetPassFieldMemoryCache();
}

try {
  const pet = await mint("stable@walletchi.test");
  await mock.careForPet(pet.tokenId!, 0); // hatch: five clocks start
  check("setup: the pet has a token and an account", !!pet.tokenId && !!pet.tbaAddress);

  console.log("\n(a) a failed read keeps the last verified value");
  await refreshSeasonSnapshot(ctx, true);
  check("headcount verified on-chain", headcountVerified());
  const good = await build(pet.serial);
  const goodMap = fieldMap(good);
  check(
    "healthy pass: ALIVE, CARE and SURVIVES are all on it",
    !!header(good, "alive") && !!header(good, "carebal") && !!life(good),
    `${header(good, "alive")} | ${header(good, "carebal")} | ${life(good)}`,
  );
  check("the values were remembered in the store", store.passFieldMemory.get("alive") === header(good, "alive") &&
    store.passFieldMemory.get(`carebal:${pet.serial}`) === header(good, "carebal") &&
    store.passFieldMemory.get(`life:${pet.serial}`) === life(good));

  chainDown();
  _resetSeasonForRestartTest(); // headcount no longer verified, balance cache gone; same process
  check("reads failing: headcount is NOT verified", !headcountVerified());
  const failed = await build(pet.serial);
  check("ALIVE kept with the last verified line", header(failed, "alive") === header(good, "alive"), String(header(failed, "alive")));
  check("CARE kept with the last verified balance", header(failed, "carebal") === header(good, "carebal"), String(header(failed, "carebal")));
  check("SURVIVES kept with the last known deadline", life(failed) === life(good), String(life(failed)));
  check("the field set is identical to the healthy pass", keysOf(fieldMap(failed)) === keysOf(goodMap));
  check("a remembered deadline never sets the lock-screen window", failed.relevantDates === undefined);

  // A pet that has NEVER had a verified balance or countdown gets no placeholder.
  chainUp();
  const fresh = await mint("never-verified@walletchi.test");
  await mock.careForPet(fresh.tokenId!, 0);
  chainDown();
  _resetSeasonForRestartTest();
  const neverPj = await build(fresh.serial);
  check("never verified: no CARE field (no made-up balance)", header(neverPj, "carebal") === undefined);
  check("never verified: no SURVIVES field (no made-up clock)", life(neverPj) === undefined);
  check("never verified: ALIVE is the global last verified line", header(neverPj, "alive") === header(good, "alive"));

  // An honest "no value" never falls back: season switched off.
  config.modes.survivalLive = false;
  const off = await build(pet.serial);
  check("season not live: no ALIVE fallback", header(off, "alive") === undefined);
  check("season not live: no SURVIVES fallback", life(off) === undefined);
  config.modes.survivalLive = true;

  console.log("\n(b) a restart keeps the field set");
  restart();
  check("after restart: the process remembers nothing in memory, nothing verified", !headcountVerified());
  const afterRestart = await build(pet.serial);
  check("after restart with reads failing: same field set as before", keysOf(fieldMap(afterRestart)) === keysOf(goodMap), keysOf(fieldMap(afterRestart)));
  check("after restart: same ALIVE / CARE / SURVIVES values", header(afterRestart, "alive") === header(good, "alive") &&
    header(afterRestart, "carebal") === header(good, "carebal") && life(afterRestart) === life(good));
  chainUp();
  restart();
  const healed = await build(pet.serial);
  check("after restart before the headcount is verified: same field set", keysOf(fieldMap(healed)) === keysOf(goodMap));

  // The boot refresh waits for a verified headcount, and a restart alone serves no new pass.
  chainDown();
  _resetSeasonForRestartTest();
  check("boot wait: gives up (false) while the headcount cannot be verified", !(await waitForVerifiedHeadcount(ctx, { maxWaitMs: 60, retryMs: 20 })));
  chainUp();
  check("boot wait: true once the headcount is verified", await waitForVerifiedHeadcount(ctx, { maxWaitMs: 60, retryMs: 20 }) && headcountVerified());
  check("a restart marks no pass changed (no content version written)", (await store.listServedPassSnapshots(pet.serial)).length === 0);
  const row = (await store.getRunner(pet.serial))!;
  const passUrl = `${base}/runner-apple/v1/passes/${config.PASS_TYPE_ID}/${pet.serial}`;
  const auth = { authorization: `ApplePass ${row.authToken}` };
  const upToDate = await fetch(passUrl, { headers: { ...auth, "if-modified-since": new Date(row.updatedAt.getTime() + 1000).toUTCString() } });
  check("a phone holding the current copy gets 304 after a restart", upToDate.status === 304, String(upToDate.status));

  console.log("\n(c) the diff log diffs against the copy the device holds");
  check("a 304 wrote no snapshot", (await store.listServedPassSnapshots(pet.serial)).length === 0);
  const first = await fetch(passUrl, { headers: auth });
  const lm1 = first.headers.get("last-modified")!;
  await first.arrayBuffer();
  await sleep(50); // the diff log is not awaited by the route
  let snaps = await store.listServedPassSnapshots(pet.serial);
  check("a served pass stores its snapshot keyed by the Last-Modified it sent", snaps.length === 1 && snaps[0]!.lastModified.toUTCString() === lm1, `${snaps[0]?.lastModified.toUTCString()} vs ${lm1}`);

  // Device-held copy (T1) has no album; a later pass (T2) served to ANOTHER device has the album; now
  // the T1 device fetches T3. The process-memory diff would compare against T2; the device-true one
  // must compare against T1 and report the album as ADDED.
  const t1 = new Date(Date.UTC(2026, 9, 17, 12, 0, 0));
  const t2 = new Date(t1.getTime() + 60_000);
  const t3 = new Date(t1.getTime() + 120_000);
  const passA = { storeCard: { headerFields: [{ key: "petno", value: "1" }], backFields: [{ key: "care", value: "x" }] } };
  const passB = { storeCard: { headerFields: [{ key: "petno", value: "1" }], backFields: [{ key: "care", value: "x" }, { key: "album", value: "Photo album" }] } };
  const S = "diff-serial";
  const r1 = await logPassDiff(ctx, S, passA, t1, undefined);
  check("first pass for a serial: baseline", r1?.base === "none");
  await logPassDiff(ctx, S, passB, t2, t1.toUTCString());
  const r3 = await logPassDiff(ctx, S, passB, t3, t1.toUTCString());
  check("diff base is the If-Modified-Since snapshot", r3?.base === "ims" && r3.baseLastModified === t1.toUTCString(), JSON.stringify(r3?.baseLastModified));
  check("and it reports the field the DEVICE lacks as added", r3?.changes.length === 1 && r3.changes[0]!.kind === "added" && r3.changes[0]!.path === "storeCard.backFields.album", JSON.stringify(r3?.changes));

  // Restart: a fresh module instance of the diff log, same store.
  restart();
  const fresh2 = (await import(`../src/runner/pass-diff.js?restart=${Date.now()}`)) as typeof import("../src/runner/pass-diff.js");
  const r4 = await fresh2.logPassDiff(ctx, S, passB, new Date(t3.getTime() + 60_000), t2.toUTCString());
  check("after a restart it still diffs against the device's copy (T2)", r4?.base === "ims" && r4.baseLastModified === t2.toUTCString() && r4.changes.length === 0, JSON.stringify(r4));
  const r5 = await fresh2.logPassDiff(ctx, S, passA, new Date(t3.getTime() + 120_000), new Date(t1.getTime() - 3_600_000).toUTCString());
  check("an unknown If-Modified-Since falls back to the newest snapshot, flagged", r5?.base === "latest-ims-unmatched" && r5.changes.some((c) => c.kind === "removed"), JSON.stringify(r5?.base));
  const r6 = await fresh2.logPassDiff(ctx, S, passA, new Date(t3.getTime() + 180_000), undefined);
  check("no If-Modified-Since falls back to the newest snapshot, flagged", r6?.base === "latest-no-ims" && r6.changes.length === 0, JSON.stringify(r6?.base));
  for (let i = 0; i < 4; i++) await fresh2.logPassDiff(ctx, S, passA, new Date(t3.getTime() + (240 + i * 60) * 1000), undefined);
  snaps = await store.listServedPassSnapshots(S);
  check(`bounded: at most ${PASS_DIFF_KEEP} snapshots per serial, newest kept`, snaps.length === PASS_DIFF_KEEP &&
    snaps[0]!.lastModified.getTime() === t3.getTime() + 420_000, String(snaps.length));
} finally {
  server.close();
}

console.log(`\nRESULT: ${passes} passed, ${failures} failed`);
process.exit(failures === 0 ? 0 : 1);
