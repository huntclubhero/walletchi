/**
 * NEXORY REVIEW CHECK (2026-10-15 review of punchcard 75af368): items 2 to 5. Item 1 (the device
 * registration cap) lives in push-registration-bounds-check.ts, and the retire retry in
 * google-rotation-check.ts. Drives the REAL code (in-memory store + MockChain, no network):
 *
 *   2. The season start push touches every pet's row first, so Apple's list call reports the pass
 *      as changed and the card actually refreshes.
 *   3. Concurrent season snapshot refreshes share ONE on-chain tally; a forced refresh (deathwatch)
 *      waits for the running one and then runs its own, so it never reports a pre-death count.
 *   4. A rotation whose database write fails leaves nothing half done: the still-current Google
 *      object is not left in the retired set and the previous-token record is restored. When an
 *      overlapping rotation DID commit, the object it retired stays retired.
 *   5. The mint session hands the minter their pet's links (more than once, so a failed fetch can
 *      be retried) until the pass secret rotates, and never after: a pet sold and claimed within
 *      the TTL does not leak the buyer's fresh links to the minter.
 *
 * Run: npx tsx scripts/nexory-review-check.ts
 */
process.env.NODE_ENV ??= "test";
process.env.LOG_LEVEL ??= "silent";
process.env.DATABASE_URL ??= "postgres://nx:nx@localhost:5432/nx";
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
const { Relayer } = await import("../src/chain/relayer.js");
const { MockChain } = await import("../src/chain/mock.js");
const { rotateRunnerAuth, previousAuthTokenFor } = await import("../src/runner/claim.js");
const { getRunnerGoogle } = await import("../src/runner/google.js");
const { announceSeasonStart } = await import("../src/runner/season-start.js");
const { refreshSeasonSnapshot } = await import("../src/runner/season.js");
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
const google = getRunnerGoogle();
const retired = () => (google as unknown as { retiredObjectIds: Set<string> }).retiredObjectIds;

async function mintPet(email: string): Promise<{ serial: string; mintSession: string }> {
  const r = (await fetch(`${base}/api/runner/checkout`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ email }),
  }).then((x) => x.json())) as { id: string; mintSession: string };
  for (let i = 0; i < 60; i++) {
    const row = await store.getRunner(r.id);
    if (row?.status === "ready" && row.tokenId) return { serial: row.serial, mintSession: r.mintSession };
    await sleep(25);
  }
  throw new Error("mint did not complete");
}
const passLink = (id: string, mintSession: string) =>
  fetch(`${base}/api/runner/pass-link`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ id, mintSession }),
  });

try {
  // ------------------------------------------------------------------ 5. the mint session
  console.log("\n5. the mint session ends when the pass secret rotates");
  const a = await mintPet("alpha@walletchi.test");
  check("the checkout returned a mint session", typeof a.mintSession === "string" && a.mintSession.length > 0);
  const first = await passLink(a.serial, a.mintSession);
  const firstBody = (await first.json()) as { applePassUrl?: string };
  check("the minter gets their pet's pass link", first.status === 200 && !!firstBody.applePassUrl, String(first.status));
  const again = await passLink(a.serial, a.mintSession);
  check("and can fetch it again within the TTL (a failed fetch can be retried)", again.status === 200, String(again.status));
  const b = await mintPet("bravo@walletchi.test");
  check("the session is bound to its own pet", (await passLink(b.serial, a.mintSession)).status === 403);
  await rotateRunnerAuth(ctx, (await store.getRunner(a.serial))!, {
    newOwnerAddress: "0x2222222222222222222222222222222222222222",
  });
  const afterSale = await passLink(a.serial, a.mintSession);
  check("after the pet is sold and claimed the session is refused", afterSale.status === 403, String(afterSale.status));
  check("and the refusal carries no link", !((await afterSale.json()) as { applePassUrl?: string }).applePassUrl);
  check("and it stays dead", (await passLink(a.serial, a.mintSession)).status === 403);

  // ------------------------------------------------------------------ 4. a failed rotation write
  console.log("\n4. a rotation whose write fails leaves nothing half done");
  const c = await mintPet("charlie@walletchi.test");
  const r0 = (await store.getRunner(c.serial))!;
  const firstRotation = await rotateRunnerAuth(ctx, r0, { reason: "reset" });
  const objAfterFirst = google.objectId(firstRotation);
  check("a committed rotation retires the old object", retired().has(google.objectId(r0)));
  const realUpdate = store.updateRunner.bind(store);
  let failNext = true;
  store.updateRunner = (async (serial: string, patch: Parameters<typeof realUpdate>[1]) => {
    if (failNext && "authToken" in patch) {
      failNext = false;
      throw new Error("db timeout");
    }
    return realUpdate(serial, patch);
  }) as typeof store.updateRunner;
  let threw = false;
  try {
    await rotateRunnerAuth(ctx, (await store.getRunner(c.serial))!, { reason: "reset" });
  } catch {
    threw = true;
  }
  const r1 = (await store.getRunner(c.serial))!;
  check("the failed rotation throws to its caller", threw);
  check("the row still names the same token and object", r1.authToken === firstRotation.authToken && google.objectId(r1) === objAfterFirst);
  check("the still-current Google object is NOT left in the retired set", !retired().has(objAfterFirst));
  check("the previous-token record is the committed rotation's, restored", previousAuthTokenFor(c.serial) === r0.authToken);
  check("the first rotation's retired object stays retired", retired().has(google.objectId(r0)));
  // An overlapping pair: a rotation that read the row BEFORE another one committed, then failed.
  failNext = true;
  try {
    await rotateRunnerAuth(ctx, r0, { reason: "reset" }); // stale copy: it names the old object
  } catch {
    /* expected */
  }
  check("a stale rotation that failed leaves the committed retirement in place", retired().has(google.objectId(r0)));
  check("and does not retire the current object", !retired().has(objAfterFirst));
  store.updateRunner = realUpdate as typeof store.updateRunner;
  const healed = await rotateRunnerAuth(ctx, (await store.getRunner(c.serial))!, { reason: "reset" });
  check("a retry rotates normally", healed.authToken !== firstRotation.authToken && retired().has(objAfterFirst));

  // ------------------------------------------------------------------ 2. the season start push
  console.log("\n2. the season start push refreshes Apple cards");
  const runners = await store.allMintedRunners();
  const before = new Map(runners.map((r) => [r.serial, r.updatedAt.getTime()]));
  await sleep(5);
  await announceSeasonStart(ctx);
  const after = await store.allMintedRunners();
  const touched = after.filter((r) => !r.gone && r.updatedAt.getTime() > (before.get(r.serial) ?? Infinity)).length;
  check(`every living pet's row was touched before its push (${after.length} pets)`, touched === after.filter((r) => !r.gone).length, `${touched} touched`);
  const device = "season-device";
  await store.upsertRunnerRegistration({ deviceLibraryId: device, passTypeId: config.PASS_TYPE_ID, serial: b.serial, pushToken: "ab".repeat(32) });
  const seen = new Date();
  await sleep(5);
  await announceSeasonStart(ctx);
  const listed = await store.listRunnerSerialsForDevice(device, config.PASS_TYPE_ID, seen);
  check("a device that fetched before the announcement sees its pass as changed", listed.serials.includes(b.serial));

  // ------------------------------------------------------------------ 3. one tally at a time
  console.log("\n3. concurrent snapshot refreshes share one tally");
  config.modes.survivalLive = true;
  let petStateReads = 0;
  const REGISTERED = 30;
  const chainCtx = {
    store,
    relayer: {
      async petVaultStats() {
        return { registeredCount: REGISTERED, hatchedCount: REGISTERED, potRaw: 0n };
      },
      async careTokenDecimals() {
        return 18;
      },
      async burnedCareTotal() {
        return 0n;
      },
      async petState() {
        petStateReads += 1;
        await sleep(20);
        return { registered: true, dead: false, lastCareAt: 0, isAlive: true, secondsLeft: 0 };
      },
    },
  } as unknown as AppContext;
  const burst = await Promise.all(Array.from({ length: 12 }, () => refreshSeasonSnapshot(chainCtx)));
  check(`12 concurrent refreshes ran ONE tally (${REGISTERED} reads, not ${12 * REGISTERED})`, petStateReads === REGISTERED, String(petStateReads));
  check("and all 12 got the same verified count", burst.every((s) => s.verified && s.aliveCount === REGISTERED));
  petStateReads = 0;
  const cached = await refreshSeasonSnapshot(chainCtx);
  check("inside the TTL a refresh reads nothing", petStateReads === 0 && cached.aliveCount === REGISTERED);
  const forced1 = refreshSeasonSnapshot(chainCtx, true);
  const joined = refreshSeasonSnapshot(chainCtx);
  const forced2 = refreshSeasonSnapshot(chainCtx, true);
  await Promise.all([forced1, joined, forced2]);
  check("a forced refresh during a running one waits and runs its own (2 tallies, the plain one joins)", petStateReads === 2 * REGISTERED, String(petStateReads));
  config.modes.survivalLive = false;
} finally {
  server.close();
}

console.log(`\nRESULT: ${passes} passed, ${failures} failed`);
console.log(failures === 0 ? "ALL CHECKS PASSED" : `${failures} CHECK(S) FAILED`);
process.exit(failures === 0 ? 0 : 1);
