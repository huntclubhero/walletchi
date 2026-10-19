/**
 * RUNNER PASS PUSH-REGISTRATION BOUNDS CHECK (runner/apple.ts, store/memory.ts).
 *
 * The Apple Wallet registration route stores whatever it is sent, and pushRunnerPass opens one APNs
 * stream per stored token on every refresh. An unbounded set per serial makes the push loop's work
 * grow with whatever a client chose to register. Drives the REAL route (in-memory store + MockChain,
 * no network):
 *
 *   1. A normal registration still works: 201, then 200 for the same device with a rotated token,
 *      and the set stays at one entry.
 *   2. Malformed input is refused with 400 and stores nothing: a pass type that is not ours, a
 *      push token with characters that do not belong in an APNs device path or that is too long,
 *      a non-string token, a device id that is too long or has stray characters.
 *   3. The set per serial is capped WITHOUT eviction (Nexory, 2026-10-15): at the cap a new device
 *      is refused with 403 and stores nothing, every device already there keeps its slot (the
 *      owner's included), a known device still rotates its push token, another serial is untouched.
 *   4. A rotation supersedes the serial's registrations instead of deleting them: the old devices
 *      still answer the list call and still get the rotation's push (so they refresh into the
 *      keepsake), they stop counting toward the cap, so the owner's new pass registers even when a
 *      leaked copy had filled every slot, and their pushes end after the window.
 *   5. The read side is bounded too: rows beyond the cap that never went through the route (a pass
 *      crowded before the cap existed) and concurrent registrations on one serial never make the
 *      list of push tokens longer than the cap; concurrent newcomers never exceed it in storage.

 * The same cases run against either store. By default the in-memory store; with CHECK_STORE=prisma
 * they run against PrismaStore (the production store) on the Postgres that DATABASE_URL points at,
 * which must already have the migrations applied. That mode also checks, directly on the database,
 * that a very large crowded serial refuses newcomers and is superseded in one step.
 *
 * Run: npx tsx scripts/push-registration-bounds-check.ts
 *      CHECK_STORE=prisma DATABASE_URL=postgres://... npx tsx scripts/push-registration-bounds-check.ts
 */
process.env.NODE_ENV ??= "test";
process.env.LOG_LEVEL ??= "silent";
process.env.DATABASE_URL ??= "postgres://pb:pb@localhost:5432/pb";
process.env.DEMO_BYPASS_PAYMENT = "true";
process.env.PASS_STUB_MODE = "true";
process.env.EMAIL_STUB = "true";
process.env.GOOGLE_WALLET_STUB = "true";
process.env.PRIVY_APP_ID = "";
process.env.PRIVY_APP_SECRET = "";
process.env.ANTI_SYBIL_ENABLED = "false";
process.env.PUBLIC_BASE_URL = "https://api.walletchi.test";

const { config } = await import("../src/config.js");
const { createApp } = await import("../src/app.js");
const { InMemoryStore } = await import("../src/store/memory.js");
const { PrismaStore, getPrisma } = await import("../src/store/prisma.js");
const { Relayer } = await import("../src/chain/relayer.js");
const { rotateRunnerAuth } = await import("../src/runner/claim.js");
const { MockChain } = await import("../src/chain/mock.js");
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

const usePrisma = process.env.CHECK_STORE === "prisma";
const prisma = usePrisma ? getPrisma() : null;
const store = prisma ? new PrismaStore(prisma) : new InMemoryStore();
console.log(`store: ${usePrisma ? "PrismaStore (Postgres)" : "InMemoryStore"}`);
const relayer = new Relayer(new MockChain());
const ctx = { store, relayer } as unknown as AppContext;
const server = createApp(ctx).listen(0);
await new Promise((r) => server.once("listening", r));
const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

const PASS_TYPE = config.PASS_TYPE_ID;
const CAP = 10;

async function mintPet(email: string): Promise<{ serial: string; auth: string }> {
  const r = (await fetch(`${base}/api/runner/checkout`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ email }),
  }).then((x) => x.json())) as { id: string };
  for (let i = 0; i < 60; i++) {
    const row = await store.getRunner(r.id);
    if (row?.status === "ready" && row.tokenId) return { serial: row.serial, auth: row.authToken };
    await sleep(25);
  }
  throw new Error("mint did not complete");
}

const register = (serial: string, auth: string, device: string, body: unknown, passType = PASS_TYPE) =>
  fetch(`${base}/runner-apple/v1/devices/${device}/registrations/${passType}/${serial}`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `ApplePass ${auth}` },
    body: JSON.stringify(body),
  });
const tokensOf = (serial: string) => store.listRunnerPushTokensForSerial(serial);
const hex = (n: number, len = 64) => n.toString(16).padStart(len, "0");

type Reg = { deviceLibraryId: string; passTypeId: string; serial: string; pushToken: string; createdAt: Date; supersededAt?: Date | null };
const memRows = () => (store as unknown as { runnerRegistrations: Map<string, Reg> }).runnerRegistrations;
// Rows written straight into the store, not through the route or upsertRunnerRegistration: how a
// pass looks that was crowded before the cap existed. old-1 is the oldest, old-N the newest.
async function seedOld(serial: string, n: number): Promise<void> {
  const now = Date.now();
  const rows: Reg[] = [];
  for (let i = 1; i <= n; i++) {
    rows.push({
      deviceLibraryId: `old-${i}`,
      passTypeId: PASS_TYPE,
      serial,
      pushToken: `old-token-${i}`,
      createdAt: new Date(now - (n + 1 - i) * 60_000),
    });
  }
  if (prisma) {
    await prisma.runnerDeviceRegistration.createMany({ data: rows });
    return;
  }
  for (const r of rows) memRows().set(`${r.deviceLibraryId}::${r.passTypeId}::${r.serial}`, r);
}
// Rows held for a serial, counted in the store itself (not through the bounded read).
const rowCount = async (serial: string): Promise<number> =>
  prisma
    ? prisma.runnerDeviceRegistration.count({ where: { serial } })
    : [...memRows().values()].filter((r) => r.serial === serial).length;

try {
  const a = await mintPet("alpha@walletchi.test");
  const b = await mintPet("bravo@walletchi.test");

  console.log("\na normal registration");
  const first = await register(a.serial, a.auth, "device-0", { pushToken: hex(1) });
  check("first registration is 201", first.status === 201, String(first.status));
  const again = await register(a.serial, a.auth, "device-0", { pushToken: hex(2) });
  check("same device with a rotated token is 200", again.status === 200, String(again.status));
  const t1 = await tokensOf(a.serial);
  check("and the set holds one entry with the new token", t1.length === 1 && t1[0] === hex(2), JSON.stringify(t1));

  console.log("\nmalformed input is refused and stores nothing");
  const before = (await tokensOf(a.serial)).length;
  const refused = async (name: string, res: Response, error?: string) => {
    check(`${name}: 400`, res.status === 400, String(res.status));
    if (error) {
      const body = (await res.json().catch(() => ({}))) as { error?: string };
      check(`${name}: says "${error}"`, body.error === error, String(body.error));
    }
  };
  await refused("a pass type that is not ours", await register(a.serial, a.auth, "device-x", { pushToken: hex(3) }, "pass.com.example.other"));
  await refused("a token with a path separator", await register(a.serial, a.auth, "device-x", { pushToken: "ab/../cd" }));
  await refused("a token with a query separator", await register(a.serial, a.auth, "device-x", { pushToken: "abcd?x=1" }));
  await refused("a token far too long", await register(a.serial, a.auth, "device-x", { pushToken: "a".repeat(5000) }));
  await refused("a non-string token", await register(a.serial, a.auth, "device-x", { pushToken: 12345 }), "invalid pushToken");
  await refused("an object token", await register(a.serial, a.auth, "device-x", { pushToken: { a: 1 } }), "invalid pushToken");
  await refused("an empty token", await register(a.serial, a.auth, "device-x", { pushToken: "" }), "missing pushToken");
  await refused("no token at all", await register(a.serial, a.auth, "device-x", {}), "missing pushToken");
  await refused("a device id that is too long", await register(a.serial, a.auth, "d".repeat(500), { pushToken: hex(4) }));
  await refused("a device id with stray characters", await register(a.serial, a.auth, "dev%20ice%2e", { pushToken: hex(5) }));
  check("none of those stored anything", (await tokensOf(a.serial)).length === before, `${before} -> ${(await tokensOf(a.serial)).length}`);

  console.log("\nthe set per serial is capped, nobody is evicted");
  // device-0 already holds one slot (its token rotated to hex(2) above); fill the rest, then try more.
  for (let i = 1; i < CAP; i++) {
    const res = await register(a.serial, a.auth, `device-${i}`, { pushToken: hex(100 + i) });
    if (res.status !== 200 && res.status !== 201) check(`device-${i} accepted`, false, String(res.status));
  }
  const over1 = await register(a.serial, a.auth, `device-${CAP}`, { pushToken: hex(100 + CAP) });
  const over2 = await register(a.serial, a.auth, `device-${CAP + 1}`, { pushToken: hex(100 + CAP + 1) });
  check("a new device at the cap is refused with 403", over1.status === 403 && over2.status === 403, `${over1.status}, ${over2.status}`);
  check("and says why", ((await over1.json().catch(() => ({}))) as { error?: string }).error === "registration_limit");
  const full = await tokensOf(a.serial);
  check(`the set holds exactly ${CAP}`, full.length === CAP, String(full.length));
  check("the first device (the owner's) was NOT evicted", full.includes(hex(2)));
  check("and the refused devices stored nothing", !full.includes(hex(100 + CAP)) && !full.includes(hex(100 + CAP + 1)));
  check("nothing past the cap is held in the store", (await rowCount(a.serial)) === CAP, String(await rowCount(a.serial)));

  console.log("\nre-registering at the cap");
  const known = await register(a.serial, a.auth, "device-5", { pushToken: hex(900) });
  const afterKnown = await tokensOf(a.serial);
  check("a known device rotating its token is accepted", known.status === 200, String(known.status));
  check("the set is still at the cap", afterKnown.length === CAP, String(afterKnown.length));
  check("and the rotated token replaced the old one", afterKnown.includes(hex(900)) && !afterKnown.includes(hex(105)));
  check("and nobody else was evicted", afterKnown.includes(hex(2)) && afterKnown.includes(hex(101)));
  const owner = await register(a.serial, a.auth, "device-0", { pushToken: hex(901) });
  check("the first device still rotates its token at the cap", owner.status === 200 && (await tokensOf(a.serial)).includes(hex(901)), String(owner.status));

  console.log("\nthe cap is per serial");
  const other = await register(b.serial, b.auth, "device-0", { pushToken: hex(7) });
  check("another pet registers normally", other.status === 201, String(other.status));
  check("and holds one entry while the first stays at the cap", (await tokensOf(b.serial)).length === 1 && (await tokensOf(a.serial)).length === CAP);

  console.log("\na rotation supersedes the registrations instead of deleting them");
  // The leaked-copy case: the slots of `a` are full. The owner resets their links.
  const runnerA = (await store.getRunner(a.serial))!;
  const rotated = await rotateRunnerAuth(ctx, runnerA, { reason: "reset" });
  check("the rotation issued a new token", rotated.authToken !== a.auth);
  const afterReset = await tokensOf(a.serial);
  check("the old devices still get the rotation's push (refresh into the keepsake)", afterReset.includes(hex(901)) && afterReset.includes(hex(101)), String(afterReset.length));
  const listed = await store.listRunnerSerialsForDevice("device-1", PASS_TYPE);
  check("and an old device's list call still names the pet", listed.serials.includes(a.serial));
  const staleToken = await register(a.serial, a.auth, "device-x1", { pushToken: hex(950) });
  check("the old token can no longer register", staleToken.status === 401, String(staleToken.status));
  const fresh = await register(a.serial, rotated.authToken, "device-fresh", { pushToken: hex(951) });
  check("the owner's new pass registers although the old set was full", fresh.status === 200 || fresh.status === 201, String(fresh.status));
  const back = await register(a.serial, rotated.authToken, "device-0", { pushToken: hex(952) });
  check("an old device adding the new pass rejoins the live set", back.status === 200 || back.status === 201, String(back.status));
  const liveNow = await tokensOf(a.serial);
  check("with its new token in the push list", liveNow.includes(hex(952)) && !liveNow.includes(hex(901)));
  for (let i = 0; i < CAP; i++) await register(a.serial, rotated.authToken, `device-n${i}`, { pushToken: hex(960 + i) });
  const nextFull = await register(a.serial, rotated.authToken, "device-n-over", { pushToken: hex(990) });
  check("the new live set is capped again at its own ten", nextFull.status === 403, String(nextFull.status));
  // Past the window the superseded rows stop receiving pushes (they stay for the list call).
  const past = new Date(Date.now() - 25 * 60 * 60 * 1000);
  if (prisma) {
    await prisma.runnerDeviceRegistration.updateMany({ where: { serial: a.serial, NOT: { supersededAt: null } }, data: { supersededAt: past } });
  } else {
    for (const r of memRows().values()) if (r.serial === a.serial && r.supersededAt) r.supersededAt = past;
  }
  const afterWindow = await tokensOf(a.serial);
  check("after the window only the live set gets pushes", afterWindow.length === CAP && !afterWindow.includes(hex(101)), String(afterWindow.length));
  check("and the superseded rows still answer the list call", (await store.listRunnerSerialsForDevice("device-1", PASS_TYPE)).serials.includes(a.serial));

  console.log("\nrows beyond the cap that did not come through the route");
  const d = await mintPet("delta@walletchi.test");
  await seedOld(d.serial, 25);
  check("seeded 25 rows straight into the store", (await rowCount(d.serial)) === 25, String(await rowCount(d.serial)));
  const crowdedList = await tokensOf(d.serial);
  const newestTen = Array.from({ length: CAP }, (_, k) => `old-token-${16 + k}`);
  check(`the read list holds at most ${CAP}`, crowdedList.length <= CAP, String(crowdedList.length));
  check("and it is exactly the newest ten", crowdedList.length === CAP && newestTen.every((t) => crowdedList.includes(t)), String(crowdedList.length));
  const regNew = await register(d.serial, d.auth, "device-new", { pushToken: hex(2000) });
  check("a new device there is refused and nothing is deleted", regNew.status === 403 && (await rowCount(d.serial)) === 25, `${regNew.status}, ${await rowCount(d.serial)}`);
  const regOld = await register(d.serial, d.auth, "old-3", { pushToken: hex(2001) });
  check("a device already there still rotates its token", regOld.status === 200, String(regOld.status));

  console.log("\nconcurrent registrations on one serial");
  const e = await mintPet("echo@walletchi.test");
  const concurrent = await Promise.all(
    Array.from({ length: 30 }, (_, i) => register(e.serial, e.auth, `device-c${i}`, { pushToken: hex(3000 + i) })),
  );
  const okCount = concurrent.filter((r) => r.status === 200 || r.status === 201).length;
  const codes = [...new Set(concurrent.map((r) => r.status))].join(",");
  check(`exactly ${CAP} of 30 concurrent newcomers are accepted, the rest refused`, okCount === CAP && concurrent.every((r) => [200, 201, 403].includes(r.status)), `${okCount} ok, codes ${codes}`);
  const concurrentList = await tokensOf(e.serial);
  check(`and the store holds exactly ${CAP}`, concurrentList.length === CAP && (await rowCount(e.serial)) === CAP, `${concurrentList.length} listed, ${await rowCount(e.serial)} stored`);

  if (prisma) {
    console.log("\na very large crowded serial");
    // An already crowded serial (registered before the cap existed): 1200 rows, inserted directly.
    const c = await mintPet("charlie@walletchi.test");
    await prisma.$executeRawUnsafe(
      `INSERT INTO "RunnerDeviceRegistration" ("deviceLibraryId","passTypeId","serial","pushToken","createdAt")
       SELECT 'bulk-' || g, $1, $2, 'bulk-token-' || g, now() - (g || ' seconds')::interval
       FROM generate_series(1, 1200) AS g`,
      PASS_TYPE,
      c.serial,
    );
    const total = () => rowCount(c.serial);
    check("seeded 1200 rows", (await total()) === 1200, String(await total()));
    const crowded1200 = await tokensOf(c.serial);
    check(
      "the read list of those 1200 rows is the newest ten",
      crowded1200.length === CAP && Array.from({ length: CAP }, (_, k) => `bulk-token-${k + 1}`).every((t) => crowded1200.includes(t)),
      String(crowded1200.length),
    );
    const r1 = await register(c.serial, c.auth, "device-fresh", { pushToken: hex(1000) });
    check("a newcomer there is refused", r1.status === 403, String(r1.status));
    const rc = await rotateRunnerAuth(ctx, (await store.getRunner(c.serial))!, { reason: "reset" });
    check("one rotation supersedes all 1200 in one step", (await prisma.runnerDeviceRegistration.count({ where: { serial: c.serial, supersededAt: null } })) === 0);
    const r2 = await register(c.serial, rc.authToken, "device-fresh", { pushToken: hex(1000) });
    check("and the owner's new pass registers after it", r2.status === 200 || r2.status === 201, String(r2.status));
    const pushList = await tokensOf(c.serial);
    check(`the push list stays bounded (live + at most ${CAP} superseded)`, pushList.length <= 2 * CAP && pushList.includes(hex(1000)), String(pushList.length));
  }
} finally {
  server.close();
  if (prisma) await prisma.$disconnect();
}

console.log(`\nRESULT: ${passes} passed, ${failures} failed`);
console.log(failures === 0 ? "ALL CHECKS PASSED" : `${failures} CHECK(S) FAILED`);
process.exit(failures === 0 ? 0 : 1);
