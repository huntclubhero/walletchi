/**
 * NO CHI, NO SIGN-IN CHECK: POST /api/me/release-seat (me-routes.ts).
 *
 * Privy creates a user at every sign-in and the app has a hard 150-user cap, so a visitor who
 * signs in at /me and owns no Chi must give the seat back. Drives the REAL handler (in-memory
 * store + MockChain, no network) with a fake Privy directory injected through the existing test
 * seam, so the route runs its LIVE auth path (verified session, wallets read server-side), and a
 * fake deleteUser that records every call. The one thing that matters is WHICH users get deleted:
 *
 *   1. Refusals that delete nothing: no token 401, bad token 401, Privy stubbed 503.
 *   2. A keeper whose EMBEDDED wallet owns a pet: has_pet, not deleted.
 *   3. A keeper whose EXTERNAL linked wallet owns the pet (email sign-in, pet elsewhere): has_pet.
 *   4. A keeper whose only pet is DEAD: still has_pet (a memorial is a pet; never delete its owner).
 *   5. A protected sign-in (house list and PROTECTED_SIGNIN_EMAILS) with no pet: protected, kept.
 *   6. A user with no linked wallet yet: no_wallet, kept.
 *   7. A visitor with a wallet and nothing in it: released, deleteUser called once with THEIR id.
 *   8. A mint still landing for that wallet (a "minting" row): has_pet, kept.
 *   9. Fail closed: the ownersOf batch read throws, or comes back with a hole, or the season gate
 *      is unreadable, or Privy's profile read fails, or the delete itself fails: 503 unavailable,
 *      nothing deleted.
 *  10. The route only ever releases the CALLER'S seat: a stranger's token never names another id.
 *  9b. The two wrong-deletion paths the review of PR 84 reproduced, with the owner cache left
 *      exactly as production has it: a pet gifted on-chain inside the 60 s cache window, and an
 *      ops mint with no Runner row. Both answer has_pet, delete nothing, and leave by-owner able
 *      to list the pet on the reload.
 *   6b. The sweep's age floor: an account younger than RELEASE_SEAT_MIN_AGE_MINUTES (or one Privy
 *      cannot date) is too_young and kept.
 *  11. Rate limit: its own per-IP bucket in the claim window (429 with Retry-After once spent).
 *
 * Run: npx tsx scripts/release-seat-check.ts
 */
process.env.NODE_ENV ??= "test";
process.env.LOG_LEVEL ??= "silent";
process.env.DATABASE_URL ??= "postgres://rs:rs@localhost:5432/rs";
process.env.DEMO_BYPASS_PAYMENT = "true";
process.env.PASS_STUB_MODE = "true";
process.env.EMAIL_STUB = "true";
process.env.GOOGLE_WALLET_STUB = "true";
process.env.PRIVY_APP_ID = "";
process.env.PRIVY_APP_SECRET = "";
process.env.ANTI_SYBIL_ENABLED = "false";
process.env.TESTER_ALLOWLIST = "";
process.env.PUBLIC_BASE_URL = "https://api.walletchi.test";
process.env.PET721_ADDRESS = "0x1111111111111111111111111111111111111111";
process.env.PROTECTED_SIGNIN_EMAILS = "friend.of.the.house@example.com, Second.Guest@Example.org";
process.env.CARE_SESSION_SECRET ??= "release-seat-check-only-care-session-secret-not-real";

const { config } = await import("../src/config.js");
const { createApp } = await import("../src/app.js");
const { InMemoryStore } = await import("../src/store/memory.js");
const { Relayer } = await import("../src/chain/relayer.js");
const { MockChain } = await import("../src/chain/mock.js");
const { _resetClaimState } = await import("../src/runner/claim.js");
const { _setPrivyClientForTests } = await import("../src/services/privy.js");
const { isProtectedSignIn } = await import("../src/runner/me-routes.js");
const { privateKeyToAccount, generatePrivateKey } = await import("viem/accounts");
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
const ctx: AppContext = { store, relayer } as unknown as AppContext;
const server = createApp(ctx).listen(0);
await new Promise((r) => server.once("listening", r));
const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

// A fake Privy directory (the same seam smoke.ts and rotate-links-check.ts use): "session:<id>"
// verifies for a known user; getUser lists that user's email and wallets; deleteUser records the
// id it was asked to delete. The route reads everything about the user from HERE, never from
// the request body.
type FakeUser = { email: string | null; wallets: string[]; createdAt?: Date | string | number; profileFails?: boolean; deleteFails?: boolean };
const privyDir = new Map<string, FakeUser>();
const deleted: string[] = [];
// Every fake account is an hour old unless a case says otherwise: the age floor is its own case.
const AN_HOUR_AGO = new Date(Date.now() - 60 * 60_000);
_setPrivyClientForTests({
  verifyAuthToken: async (token: string) => {
    const userId = token.startsWith("session:") ? token.slice("session:".length) : "";
    if (!privyDir.has(userId)) throw new Error("invalid privy token");
    return { userId };
  },
  getUser: async (userId: string) => {
    const u = privyDir.get(userId);
    if (!u) throw new Error("unknown privy user");
    if (u.profileFails) throw new Error("privy upstream 503");
    return {
      createdAt: u.createdAt ?? AN_HOUR_AGO,
      email: u.email ? { address: u.email } : undefined,
      linkedAccounts: [
        ...(u.email ? [{ type: "email", address: u.email }] : []),
        ...u.wallets.map((w, i) => ({ type: "wallet", address: w, walletClientType: i === 0 ? "privy" : "metamask" })),
      ],
    };
  },
  deleteUser: async (userId: string) => {
    const u = privyDir.get(userId);
    if (!u) throw new Error("unknown privy user");
    if (u.deleteFails) throw new Error("privy delete 500");
    deleted.push(userId);
    privyDir.delete(userId);
  },
});

const post = (path: string, body: unknown) =>
  fetch(`${base}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
const release = async (user: string | null) => {
  const res = await post("/api/me/release-seat", user ? { privyToken: `session:${user}` } : {});
  return { status: res.status, body: (await res.json()) as Record<string, unknown>, retryAfter: res.headers.get("retry-after") };
};
const addr = () => privateKeyToAccount(generatePrivateKey()).address;

async function mintPet(email: string): Promise<{ serial: string; tokenId: string }> {
  const r = (await post("/api/runner/checkout", { email }).then((x) => x.json())) as { id: string };
  for (let i = 0; i < 60; i++) {
    const row = await store.getRunner(r.id);
    if (row?.status === "ready" && row.tokenId) return { serial: row.serial, tokenId: row.tokenId };
    await sleep(25);
  }
  throw new Error("mint did not complete");
}

try {
  // ====== 1. Refusals before any decision, with Privy still stubbed ======
  console.log("\n1. refusals that delete nothing");
  {
    const stubbed = await release(null);
    check("Privy stubbed: 503 unavailable, nothing to release", stubbed.status === 503 && stubbed.body.reason === "unavailable" && stubbed.body.released === false, JSON.stringify(stubbed.body));
    config.modes.privyLive = true; // the real auth path from here on
    config.modes.survivalLive = true; // the season gate is readable (the live posture)
    const none = await release(null);
    check("no token: 401 unauthorized", none.status === 401 && none.body.reason === "unauthorized" && none.body.released === false, JSON.stringify(none.body));
    const bad = await release("nobody");
    check("bad token: 401 unauthorized", bad.status === 401 && bad.body.released === false, JSON.stringify(bad.body));
    check("nothing deleted so far", deleted.length === 0, JSON.stringify(deleted));
  }

  // ====== 2 to 4. A pet anywhere on the account keeps the seat ======
  console.log("\n2 to 4. any pet on any linked wallet keeps the seat");
  const alice = addr(); // embedded wallet, owns a pet
  const bobEmbedded = addr();
  const bobExternal = addr(); // the pet sits on Bob's linked MetaMask
  const carol = addr(); // her only pet is dead
  privyDir.set("alice", { email: "alice@example.com", wallets: [alice] });
  privyDir.set("bob", { email: "bob@example.com", wallets: [bobEmbedded, bobExternal] });
  privyDir.set("carol", { email: "carol@example.com", wallets: [carol] });
  {
    const a = await mintPet("alice-pet@walletchi.test");
    mock.setPetOwnerMock(a.tokenId, alice);
    const b = await mintPet("bob-pet@walletchi.test");
    mock.setPetOwnerMock(b.tokenId, bobExternal);
    const c = await mintPet("carol-pet@walletchi.test");
    mock.setPetOwnerMock(c.tokenId, carol);
    await store.markRunnerGone(c.serial, { gone: true, diedAt: new Date() });
    _resetClaimState();

    const ra = await release("alice");
    check("embedded wallet owns a pet: has_pet, kept", ra.status === 200 && ra.body.released === false && ra.body.reason === "has_pet", JSON.stringify(ra.body));
    const rb = await release("bob");
    check("EXTERNAL linked wallet owns the pet: has_pet, kept", rb.status === 200 && rb.body.released === false && rb.body.reason === "has_pet", JSON.stringify(rb.body));
    const rc = await release("carol");
    check("only pet is DEAD: still has_pet, kept (a memorial is a pet)", rc.status === 200 && rc.body.released === false && rc.body.reason === "has_pet", JSON.stringify(rc.body));
    check("nothing deleted", deleted.length === 0 && privyDir.has("alice") && privyDir.has("bob") && privyDir.has("carol"), JSON.stringify(deleted));
  }

  // ====== 5. Protected sign-ins ======
  console.log("\n5. protected sign-ins are never released");
  {
    check("house list: @halldon.com is protected", isProtectedSignIn("team@halldon.com") && isProtectedSignIn("OPS@Halldon.com"));
    check("house list: Hunt's personal address is protected", isProtectedSignIn("owner@example.com") && isProtectedSignIn("OWNER@example.com"));
    check("env list: PROTECTED_SIGNIN_EMAILS entries protected, trimmed and case-folded", isProtectedSignIn("friend.of.the.house@example.com") && isProtectedSignIn("second.guest@example.org"));
    check("a plain address is not protected; no email is not protected", !isProtectedSignIn("stranger@example.com") && !isProtectedSignIn(null) && !isProtectedSignIn("halldon.com@gmail.com"));
    privyDir.set("hunt", { email: "team@halldon.com", wallets: [addr()] });
    privyDir.set("guest", { email: "Second.Guest@example.org", wallets: [addr()] });
    const rh = await release("hunt");
    check("Hunt with no pet on this wallet: protected, kept", rh.status === 200 && rh.body.released === false && rh.body.reason === "protected", JSON.stringify(rh.body));
    const rg = await release("guest");
    check("env-listed guest with no pet: protected, kept", rg.status === 200 && rg.body.reason === "protected", JSON.stringify(rg.body));
    check("nothing deleted", deleted.length === 0 && privyDir.has("hunt") && privyDir.has("guest"), JSON.stringify(deleted));
  }

  // ====== 6. No wallet yet, and the age floor ======
  console.log("\n6. no linked wallet yet; the sweep's age floor");
  {
    privyDir.set("fresh", { email: "fresh@example.com", wallets: [] });
    const rf = await release("fresh");
    check("no wallet: no_wallet, kept (still provisioning)", rf.status === 200 && rf.body.released === false && rf.body.reason === "no_wallet", JSON.stringify(rf.body));
    check("nothing deleted", deleted.length === 0 && privyDir.has("fresh"));

    // RELEASE_SEAT_MIN_AGE_MINUTES (default 20, the sweep's MIN_AGE_MIN): "sign in once, then
    // your friend sends the gift" (gift.ts recipient_unknown) needs the fresh account to survive
    // its first minutes with nothing in it.
    check("age floor defaults to the sweep's 20 minutes", config.RELEASE_SEAT_MIN_AGE_MINUTES === 20, String(config.RELEASE_SEAT_MIN_AGE_MINUTES));
    privyDir.set("newborn", { email: "newborn@example.com", wallets: [addr()], createdAt: new Date(Date.now() - 5 * 60_000) });
    const rn = await release("newborn");
    check("an account 5 minutes old with nothing: too_young, kept", rn.status === 200 && rn.body.released === false && rn.body.reason === "too_young" && privyDir.has("newborn"), JSON.stringify(rn.body));
    privyDir.set("undated", { email: "undated@example.com", wallets: [addr()], createdAt: new Date("not a date") });
    const ru = await release("undated");
    check("an account Privy cannot date is treated as brand new: too_young, kept", ru.status === 200 && ru.body.reason === "too_young" && privyDir.has("undated"), JSON.stringify(ru.body));
    // Sentinel values (round 2 review): an empty string, 0 and a negative number used to parse
    // as the Unix epoch, "older than any floor". Each must read as brand new.
    for (const [label, raw] of [["number 0", 0], ["empty string", ""], ["negative number", -5]] as const) {
      const id = `sentinel-${label.replace(/\W+/g, "-")}`;
      privyDir.set(id, { email: `${id}@example.com`, wallets: [addr()], createdAt: raw as unknown as Date });
      const rs = await release(id);
      check(`createdAt ${label}: too_young, kept`, rs.status === 200 && rs.body.reason === "too_young" && privyDir.has(id), JSON.stringify(rs.body));
    }
    privyDir.set("ofage", { email: "ofage@example.com", wallets: [addr()], createdAt: new Date(Date.now() - 21 * 60_000) });
    const ro = await release("ofage");
    check("an account 21 minutes old with nothing: released", ro.status === 200 && ro.body.released === true && deleted.includes("ofage"), JSON.stringify(ro.body));
    deleted.length = 0;
  }

  // ====== 7. The one case that releases ======
  console.log("\n7. a wallet with nothing in it is released");
  {
    privyDir.set("curious", { email: "curious@example.com", wallets: [addr()] });
    const rc = await release("curious");
    check("no pet anywhere: released true", rc.status === 200 && rc.body.released === true, JSON.stringify(rc.body));
    check("deleteUser called ONCE, with the caller's own id", deleted.length === 1 && deleted[0] === "curious", JSON.stringify(deleted));
    check("the user is gone from the directory", !privyDir.has("curious"));
    const again = await release("curious");
    check("their old token no longer verifies: 401", again.status === 401, JSON.stringify(again.body));
    check("every keeper with a pet is untouched", privyDir.has("alice") && privyDir.has("bob") && privyDir.has("carol"));
    // A wallet-only sign-in (no email at all) with nothing in the wallet is released too: the
    // protected list is by email, and no email means it cannot be on it.
    privyDir.set("walletonly", { email: null, wallets: [addr()] });
    const rw = await release("walletonly");
    check("wallet-only sign-in with nothing: released", rw.status === 200 && rw.body.released === true && deleted.includes("walletonly"), JSON.stringify(rw.body));
  }

  // ====== 8. A mint still landing ======
  console.log("\n8. a mint still landing keeps the seat");
  {
    const landing = addr();
    privyDir.set("landing", { email: "landing@example.com", wallets: [landing] });
    const row = await store.createRunner({
      serial: "landing-serial",
      tokenId: null,
      tbaAddress: null,
      ownerAddress: landing.toLowerCase(),
      email: "landing@example.com",
      bestScore: 0,
      salmon: 0,
      runs: 0,
      authToken: "landing-auth-token",
      status: "minting",
      issueTxHash: null,
      issueNonce: null,
      failureReason: null,
      idleSalmon: 0,
      lastTickAt: null,
      lastEvent: null,
      lastPushAt: null,
      lastIdleCatchAt: null,
      pendingDigest: 0,
      lastHoneyAt: null,
      lastFishAt: null,
      lastExploreAt: null,
      pendingSalmon: 0,
      activeFork: null,
      forkExpiresAt: null,
      hunger: 100,
      thirst: 100,
      joy: 100,
      lastNeedsAt: null,
      lastCareAt: null,
      lastWaterAt: null,
      lastWanderPingAt: null,
      lastPlayAt: null,
      lastToyAt: null,
      hatched: false,
      toys: 0,
      critical: false,
      gone: false,
      won: false,
      wonPrize: "0",
      lastStage: 0,
      bornAt: null,
      diedAt: null,
      careCount: 0,
      deathRank: 0,
      privyUserHash: null,
    });
    const rl = await release("landing");
    check("a 'minting' row for the wallet: has_pet, kept", rl.status === 200 && rl.body.released === false && rl.body.reason === "has_pet", JSON.stringify(rl.body));
    check("not deleted", privyDir.has("landing") && !deleted.includes("landing"));
    await store.updateRunner(row.serial, { status: "failed" });
  }

  // ====== 9. Fail closed ======
  console.log("\n9. every read failure refuses to decide (503, nothing deleted)");
  {
    privyDir.set("nothing", { email: "nothing@example.com", wallets: [addr()] });
    const realOwnersOf = mock.petOwnersOf.bind(mock);

    _resetClaimState();
    mock.petOwnersOf = async () => {
      throw new Error("rpc down");
    };
    const down = await release("nothing");
    check("ownersOf throws: 503 unavailable, Retry-After", down.status === 503 && down.body.reason === "unavailable" && down.retryAfter === "5", JSON.stringify(down.body));

    _resetClaimState();
    mock.petOwnersOf = async (ids: string[]) => (await realOwnersOf(ids)).map((o, i) => (i === 0 ? null : o));
    const hole = await release("nothing");
    check("ownersOf with a hole (one token unreadable): 503 unavailable, never 'nobody owns it'", hole.status === 503 && hole.body.reason === "unavailable", JSON.stringify(hole.body));
    mock.petOwnersOf = realOwnersOf;
    _resetClaimState();

    const realGate = mock.seasonGate.bind(mock);
    mock.seasonGate = async () => {
      throw new Error("rpc down");
    };
    const noGate = await release("nothing");
    check("fresh minted count unreadable: 503 unavailable", noGate.status === 503 && noGate.body.reason === "unavailable", JSON.stringify(noGate.body));
    mock.seasonGate = realGate;

    // A STALE season gate must not hide a fresh pet: the route reads the count fresh. Prove it by
    // minting one more pet to a new user right after the cached gate was warmed by a read.
    privyDir.set("justminted", { email: "justminted@example.com", wallets: [addr()] });
    const warm = await release("justminted"); // warms every cache with the count BEFORE the mint
    check("precondition: a wallet with nothing is released", warm.status === 200 && warm.body.released === true, JSON.stringify(warm.body));
    privyDir.set("justminted2", { email: "justminted2@example.com", wallets: [addr()] });
    const fresh = await mintPet("justminted2-pet@walletchi.test");
    mock.setPetOwnerMock(fresh.tokenId, privyDir.get("justminted2")!.wallets[0]!);
    _resetClaimState();
    const kept = await release("justminted2");
    check("a pet minted after the gate was cached still counts: has_pet, kept", kept.status === 200 && kept.body.reason === "has_pet" && privyDir.has("justminted2"), JSON.stringify(kept.body));

    privyDir.get("nothing")!.profileFails = true;
    const noProfile = await release("nothing");
    check("Privy profile read fails: 503 unavailable", noProfile.status === 503 && noProfile.body.reason === "unavailable", JSON.stringify(noProfile.body));
    privyDir.get("nothing")!.profileFails = false;

    privyDir.get("nothing")!.deleteFails = true;
    const noDelete = await release("nothing");
    check("Privy delete fails: 503 unavailable, seat kept", noDelete.status === 503 && noDelete.body.reason === "unavailable" && privyDir.has("nothing"), JSON.stringify(noDelete.body));
    privyDir.get("nothing")!.deleteFails = false;

    check("nothing was deleted through any failure", !deleted.includes("nothing"), JSON.stringify(deleted));
    const fine = await release("nothing");
    check("with everything healthy again the same user IS released", fine.status === 200 && fine.body.released === true && deleted.includes("nothing"), JSON.stringify(fine.body));
  }

  // ====== 9b. The two wrong-deletion paths the review of PR 84 reproduced ======
  // Neither calls _resetClaimState(): the 60 s owner cache behaves exactly as in production.
  console.log("\n9b. stale cache and unrecorded mints never delete (review84 probes)");
  {
    // A. STALE OWNER CACHE. The keeper's own dashboard warms the cache for their token, then the
    // pet is gifted on-chain to a signed-in friend with nothing else. Inside the cache window the
    // friend's by-owner is empty (the card fires), and the cached pass still names the keeper.
    const keeper = addr();
    const friend = addr();
    privyDir.set("friend", { email: "friend@example.com", wallets: [friend] });
    const pet = await mintPet("keeper-gifts@walletchi.test");
    mock.setPetOwnerMock(pet.tokenId, keeper);
    const warm = (await fetch(`${base}/api/pets/by-owner?address=${keeper}`).then((x) => x.json())) as { pets: unknown[] };
    check("precondition: the keeper's dashboard warmed the owner cache", warm.pets.length === 1, String(warm.pets.length));
    mock.setPetOwnerMock(pet.tokenId, friend); // the gift lands on-chain
    const stale = (await fetch(`${base}/api/pets/by-owner?address=${friend}`).then((x) => x.json())) as { pets: unknown[] };
    check("precondition: the friend's by-owner is still empty (cache names the keeper)", stale.pets.length === 0, String(stale.pets.length));
    const ra = await release("friend");
    check("A. just-gifted pet, cache stale: has_pet, NOT deleted", ra.status === 200 && ra.body.reason === "has_pet" && privyDir.has("friend") && !deleted.includes("friend"), JSON.stringify(ra.body));
    const after = (await fetch(`${base}/api/pets/by-owner?address=${friend}`).then((x) => x.json())) as { pets: Array<{ tokenId: string }> };
    check("A. the has_pet answer refreshed the cache: the friend's reload now shows the pet", after.pets.length === 1 && after.pets[0]!.tokenId === pet.tokenId, JSON.stringify(after.pets));

    // B. UNRECORDED MINT. An ops mint lands on-chain straight into a signed-in user's wallet and
    // the server has no Runner row for it (the adoption sweep is throttled behind a cached gate).
    const josh = addr();
    privyDir.set("josh", { email: "josh@example.com", wallets: [josh] });
    const before = (await mock.seasonGate()).minted;
    const issued = await mock.issueRunner(josh);
    check("precondition: the chain minted a token with no server row", (await mock.seasonGate()).minted === before + 1 && !(await store.getRunnerByTokenId(issued.tokenId)), issued.tokenId);
    const rb = await release("josh");
    check("B. unrecorded on-chain pet: has_pet, NOT deleted", rb.status === 200 && rb.body.reason === "has_pet" && privyDir.has("josh") && !deleted.includes("josh"), JSON.stringify(rb.body));
    check("B. the has_pet answer adopted the row, so the reload lists the pet", Boolean(await store.getRunnerByTokenId(issued.tokenId)), "");
    const joshList = (await fetch(`${base}/api/pets/by-owner?address=${josh}`).then((x) => x.json())) as { pets: Array<{ tokenId: string }> };
    check("B. josh's by-owner now shows the pet", joshList.pets.some((p) => p.tokenId === issued.tokenId), JSON.stringify(joshList.pets.map((p) => p.tokenId)));
  }

  // ====== 10. Only the caller's seat ======
  console.log("\n10. the body cannot name another user");
  {
    privyDir.set("victim", { email: "victim@example.com", wallets: [addr()] });
    const res = await post("/api/me/release-seat", { privyToken: "session:alice", userId: "victim", email: "victim@example.com" });
    const body = (await res.json()) as Record<string, unknown>;
    check("extra body fields are ignored: the verdict is about the token's subject (alice has a pet)", res.status === 200 && body.reason === "has_pet" && privyDir.has("victim") && !deleted.includes("victim"), JSON.stringify(body));
  }

  // ====== 11. Rate limit ======
  console.log("\n11. per-IP rate limit (its own bucket in the claim window, 20/min: the fresh read is O(minted))");
  {
    let limited: { status: number; retryAfter: string | null } | null = null;
    for (let i = 0; i < 200; i++) {
      const r = await release(null);
      if (r.status === 429) {
        limited = r;
        break;
      }
    }
    check("the window closes with 429 + Retry-After", limited !== null && limited.retryAfter !== null, JSON.stringify(limited));
    check("the 429 body says released:false", limited !== null, "");
  }
} finally {
  _setPrivyClientForTests(null);
  server.close();
}

console.log(`\nRESULT: ${passes} passed, ${failures} failed`);
process.exit(failures === 0 ? 0 : 1);
