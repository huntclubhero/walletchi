/**
 * ROTATION ON THE OWNER'S REQUEST CHECK: POST /api/pet/:tokenId/rotate-links (me-routes.ts).
 *
 * Wallet Pass Extension, capability configuration: acquisition URLs and action links MUST rotate on
 * the owner's request, because under an unchanged owner that is the only remedy for a leaked link.
 * Drives the REAL handlers (in-memory store + MockChain, no network) with a fake Privy directory
 * injected through the existing test seam, so the route runs its LIVE auth path (verified session,
 * fresh ownerOf that fails closed), not the asserted-wallet stub:
 *
 *   1. Refusals: no session 401, unknown pet 404, a signed-in NON-owner 403.
 *   2. The owner rotates: 200 with fresh links in the pass-link shape; the pass secret changed; the
 *      owner of record, email and the installed care session did NOT change.
 *   3. The old links are dead: the previous .pkpass capability URL 404s, the previous Apple auth
 *      token can no longer register a device, and a refresh with it serves the LINKS RESET keepsake
 *      (old token inside, no care link signed by the new one). The new token serves the live pass.
 *   4. The push path fired: the Google object was PATCHed with links signed by the new token, and
 *      the save URL was minted from the rotated runner (APNs runs first in the same pushRunnerPass).
 *   5. Rate limit: a second rotation inside the window is 429 with Retry-After.
 *   6. Fresh read: after a transfer on the mock chain the previous owner is refused 403 even with
 *      a WARM owner cache; with the chain down the route fails closed (503, retryable).
 *
 * Run: npx tsx scripts/rotate-links-check.ts
 */
process.env.NODE_ENV ??= "test";
process.env.LOG_LEVEL ??= "silent";
process.env.DATABASE_URL ??= "postgres://rl:rl@localhost:5432/rl";
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
process.env.CARE_SESSION_SECRET ??= "rotate-links-check-only-care-session-secret-not-real";

const { config } = await import("../src/config.js");
const { createApp } = await import("../src/app.js");
const { InMemoryStore } = await import("../src/store/memory.js");
const { Relayer } = await import("../src/chain/relayer.js");
const { MockChain } = await import("../src/chain/mock.js");
const { _resetClaimState, cachedPetOwnersOf, cachedPetOwner } = await import("../src/runner/claim.js");
const { _setPrivyClientForTests } = await import("../src/services/privy.js");
const { _setRunnerGoogleForTests } = await import("../src/runner/google.js");
const { sealSessionKey } = await import("../src/runner/session-care.js");
const { privateKeyToAccount, generatePrivateKey } = await import("viem/accounts");
const AdmZip = (await import("adm-zip")).default;
import type { AppContext } from "../src/context.js";
import type { Runner } from "../src/store/types.js";
import type { RunnerGoogleWallet } from "../src/runner/google.js";
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

// A fake Privy directory (the same seam smoke.ts uses): "session:<userId>" verifies for a known
// user, and getUser lists that user's wallet. The route reads wallets server-side from here, never
// from the request body.
const alice = privateKeyToAccount(generatePrivateKey());
const bob = privateKeyToAccount(generatePrivateKey());
const mallory = privateKeyToAccount(generatePrivateKey());
const privyDir = new Map<string, string>([
  ["alice", alice.address],
  ["bob", bob.address],
  ["mallory", mallory.address],
]);
_setPrivyClientForTests({
  verifyAuthToken: async (token: string) => {
    const userId = token.startsWith("session:") ? token.slice("session:".length) : "";
    if (!privyDir.has(userId)) throw new Error("invalid privy token");
    return { userId };
  },
  getUser: async (userId: string) => {
    const address = privyDir.get(userId);
    if (!address) throw new Error("unknown privy user");
    return { email: { address: `${userId}@walletchi.test` }, linkedAccounts: [{ type: "wallet", address }] };
  },
});

// A fake Google Wallet client: records every PATCH and every save URL, keyed by the auth token the
// runner carried at the time, so the script can see WHICH links Google was sent.
const googlePatches: string[] = [];
const googleSaves: string[] = [];
const fakeGoogle = {
  live: true,
  async patchObject(runner: Runner) {
    googlePatches.push(runner.authToken);
  },
  async saveUrl(runner: Runner) {
    googleSaves.push(runner.authToken);
    return `https://pay.google.com/gp/v/save/fake-${runner.authToken.slice(0, 12)}`;
  },
  async addMessage() {},
  async ensureObject() {},
} as unknown as RunnerGoogleWallet;
_setRunnerGoogleForTests(fakeGoogle);

const PASS_TYPE = config.PASS_TYPE_ID;
const post = (path: string, body: unknown, headers: Record<string, string> = {}) =>
  fetch(`${base}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify(body),
  });
const rotate = (tokenId: string, user: string | null) =>
  post(`/api/pet/${tokenId}/rotate-links`, user ? { privyToken: `session:${user}` } : {});
const applePass = (serial: string, token: string) =>
  fetch(`${base}/runner-apple/v1/passes/${PASS_TYPE}/${serial}`, { headers: { authorization: `ApplePass ${token}` } });
const appleRegister = (serial: string, token: string, device: string) =>
  post(`/runner-apple/v1/devices/${device}/registrations/${PASS_TYPE}/${serial}`, { pushToken: `apns-${device}` }, { authorization: `ApplePass ${token}` });
const toLocal = (url: string) => url.replace("https://api.walletchi.test", base);
const capRe = /^https:\/\/api\.walletchi\.test\/runner-passes\/[^/]+\/[0-9a-f]+\.pkpass$/;

async function mintPet(email: string): Promise<{ serial: string; tokenId: string }> {
  const r = (await fetch(`${base}/api/runner/checkout`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ email }),
  }).then((x) => x.json())) as { id: string };
  for (let i = 0; i < 60; i++) {
    const row = await store.getRunner(r.id);
    if (row?.status === "ready" && row.tokenId) return { serial: row.serial, tokenId: row.tokenId };
    await sleep(25);
  }
  throw new Error("mint did not complete");
}

function passJsonOf(buffer: ArrayBuffer): Record<string, any> {
  const zip = new AdmZip(Buffer.from(buffer));
  const entry = zip.getEntry("pass.json");
  if (!entry) throw new Error("pkpass has no pass.json");
  return JSON.parse(entry.getData().toString("utf8")) as Record<string, any>;
}

try {
  config.modes.privyLive = true; // the real auth path: verified session + fresh ownerOf
  config.modes.survivalLive = true; // real value at stake: every fail-closed branch is live
  const { serial, tokenId } = await mintPet("keeper@walletchi.test");
  mock.setPetOwnerMock(tokenId, alice.address);

  // Alice's first sign-in pass-link is her claim (custodial mint -> her wallet), exactly the state a
  // real keeper is in before they ever reach the reset button. From here the owner does not change.
  const claim = await post("/api/pet/pass-link", { tokenId, privyToken: "session:alice" });
  const claimBody = (await claim.json()) as Record<string, any>;
  check("precondition: the owner's pass-link claim succeeds", claim.status === 200 && capRe.test(claimBody.applePassUrl ?? ""), JSON.stringify(claimBody).slice(0, 120));
  const before = (await store.getRunner(serial))!;
  check("precondition: the owner of record is the signed-in wallet", before.ownerAddress.toLowerCase() === alice.address.toLowerCase());
  const oldToken = before.authToken;
  const oldAppleUrl = claimBody.applePassUrl as string;

  // The keeper's iPhone holds the old card and is registered for pushes with the old token.
  const reg = await appleRegister(serial, oldToken, "iphone-old");
  check("precondition: the old token registers a device (201)", reg.status === 201, String(reg.status));
  const livePass = await applePass(serial, oldToken);
  check("precondition: the old token serves the LIVE pass", livePass.status === 200 && livePass.headers.get("x-walletchi-pass") !== "transferred" && livePass.headers.get("x-walletchi-pass") !== "links-reset", String(livePass.status));

  // One-tap care is on for this pet; a reset must not switch it off (the owner did not change).
  const sessionKey = generatePrivateKey();
  await store.putCareSession({
    serial,
    tokenId,
    ownerAddress: alice.address.toLowerCase(),
    vaultAddress: "0x2222222222222222222222222222222222222222",
    publicKey: privateKeyToAccount(sessionKey).address.toLowerCase(),
    secretEnc: sealSessionKey(sessionKey),
    context: "0xabcd",
    expiresAt: new Date(Date.now() + 3600_000),
  });

  // ---------------------------------------------------------------- 1. refusals
  console.log("\n1. refusals");
  const anon = await rotate(tokenId, null);
  check("no session: 401", anon.status === 401, String(anon.status));
  const unknown = await rotate("999999", "alice");
  const unknownBody = (await unknown.json()) as Record<string, any>;
  check("unknown pet: 404 not_found", unknown.status === 404 && unknownBody.code === "not_found", JSON.stringify(unknownBody));
  const stranger = await rotate(tokenId, "mallory");
  const strangerBody = (await stranger.json()) as Record<string, any>;
  check("a signed-in NON-owner: 403 not_owner", stranger.status === 403 && strangerBody.code === "not_owner", JSON.stringify(strangerBody));
  check("and the refusals rotated nothing", (await store.getRunner(serial))!.authToken === oldToken);
  // The stranger's refusal must not have charged the owner's once-per-10-minutes window: section 2
  // proves it by rotating as the owner immediately after this.

  // ---------------------------------------------------------------- 2. the owner rotates
  console.log("\n2. the owner rotates");
  googlePatches.length = 0;
  googleSaves.length = 0;
  const ok = await rotate(tokenId, "alice");
  const okBody = (await ok.json()) as Record<string, any>;
  check("owner: 200 ok rotated", ok.status === 200 && okBody.ok === true && okBody.rotated === true, JSON.stringify(okBody).slice(0, 160));
  check("the response carries a fresh Apple capability URL (pass-link shape)", capRe.test(okBody.applePassUrl ?? ""), okBody.applePassUrl);
  check("and it differs from the one issued before", okBody.applePassUrl !== oldAppleUrl);
  check("and a Google save URL", typeof okBody.googleSaveUrl === "string" && okBody.googleSaveUrl.startsWith("https://pay.google.com/gp/v/save/"), okBody.googleSaveUrl);
  const after = (await store.getRunner(serial))!;
  const newToken = after.authToken;
  check("the pass secret changed", newToken !== oldToken && newToken.length === 48);
  check("the owner of record did NOT change", after.ownerAddress.toLowerCase() === alice.address.toLowerCase());
  check("the email on file did NOT change", after.email === before.email, after.email);
  const session = await store.getCareSession(serial);
  check("the installed care session is untouched (no revoke)", Boolean(session) && session!.revokedAt === null, JSON.stringify({ revokedAt: session?.revokedAt ?? null }));

  // ---------------------------------------------------------------- 3. the old links are dead
  console.log("\n3. the old links are dead");
  const staleDownload = await fetch(toLocal(oldAppleUrl));
  check("the previous .pkpass capability URL 404s", staleDownload.status === 404, String(staleDownload.status));
  const freshDownload = await fetch(toLocal(okBody.applePassUrl));
  check("the fresh .pkpass capability URL serves the pass", freshDownload.status === 200, String(freshDownload.status));
  const regOld = await appleRegister(serial, oldToken, "iphone-new");
  check("the old Apple auth token can no longer register a device (401)", regOld.status === 401, String(regOld.status));
  const regNew = await appleRegister(serial, newToken, "iphone-new");
  // 200, not 201: Apple's web service answers 200 when the serial already has a registration (the
  // old phone is still registered at this point), 201 only for the first device.
  check("the new Apple auth token registers a device (200/201)", regNew.status === 200 || regNew.status === 201, String(regNew.status));
  const keepsake = await applePass(serial, oldToken);
  check("the old token's refresh is the LINKS RESET keepsake, not the live pass", keepsake.status === 200 && keepsake.headers.get("x-walletchi-pass") === "links-reset", `${keepsake.status} ${keepsake.headers.get("x-walletchi-pass")}`);
  const keepsakeJson = passJsonOf(await keepsake.arrayBuffer());
  const keepsakeText = JSON.stringify(keepsakeJson);
  check("the keepsake says the links were reset (never 'moved to a new wallet')", /LINKS RESET/.test(keepsakeText) && !/moved to a new wallet/.test(keepsakeText));
  check("the keepsake carries the OLD token and leaks nothing signed by the new one", keepsakeJson.authenticationToken === oldToken && !keepsakeText.includes(newToken) && !/\/care\//.test(keepsakeText), keepsakeText.slice(0, 80));
  const livePassNew = await applePass(serial, newToken);
  const liveJson = passJsonOf(await livePassNew.arrayBuffer());
  check("the new token serves the live pass with the new token inside", livePassNew.status === 200 && liveJson.authenticationToken === newToken, String(livePassNew.status));
  const unregister = await fetch(`${base}/runner-apple/v1/devices/iphone-old/registrations/${PASS_TYPE}/${serial}`, { method: "DELETE", headers: { authorization: `ApplePass ${oldToken}` } });
  check("the old registration may still deregister with the old token (200)", unregister.status === 200, String(unregister.status));

  // ---------------------------------------------------------------- 4. the push path fired
  console.log("\n4. the push path fired");
  check("Google: the object was PATCHed after rotation (pushRunnerPass)", googlePatches.length >= 1, `${googlePatches.length} patch(es)`);
  check("and the PATCH carried the ROTATED token's links", googlePatches.every((t) => t === newToken), googlePatches.map((t) => t.slice(0, 8)).join(","));
  check("and the save URL was minted from the rotated runner", googleSaves.length === 1 && googleSaves[0] === newToken, googleSaves.map((t) => t.slice(0, 8)).join(","));

  // ---------------------------------------------------------------- 5. rate limit
  console.log("\n5. rate limit");
  const again = await rotate(tokenId, "alice");
  const againBody = (await again.json()) as Record<string, any>;
  check("a second rotation inside 10 minutes is 429 rate_limited", again.status === 429 && againBody.code === "rate_limited", JSON.stringify(againBody));
  const retryAfter = Number(again.headers.get("retry-after"));
  check("with a Retry-After inside the window", retryAfter > 0 && retryAfter <= 600, String(retryAfter));
  check("and the secret did not rotate again", (await store.getRunner(serial))!.authToken === newToken);
  const otherPet = await mintPet("second@walletchi.test");
  mock.setPetOwnerMock(otherPet.tokenId, alice.address);
  await post("/api/pet/pass-link", { tokenId: otherPet.tokenId, privyToken: "session:alice" });
  const otherRotate = await rotate(otherPet.tokenId, "alice");
  check("the limit is per PET: the same owner's other pet rotates now", otherRotate.status === 200, String(otherRotate.status));

  // ---------------------------------------------------------------- 6. fresh read
  console.log("\n6. the fresh ownership read");
  _resetClaimState(); // clears the rotation window AND the owner cache...
  await cachedPetOwnersOf(ctx, [tokenId]); // ...so warm the cache with alice again on purpose
  check("control: the owner cache says alice", cachedPetOwner(tokenId)?.toLowerCase() === alice.address.toLowerCase());
  mock.setPetOwnerMock(tokenId, bob.address);
  const seller = await rotate(tokenId, "alice");
  const sellerBody = (await seller.json()) as Record<string, any>;
  check("after a transfer the previous owner is refused 403 despite the warm cache (fresh read)", seller.status === 403 && sellerBody.code === "not_owner", JSON.stringify(sellerBody));
  check("and nothing rotated for the seller", (await store.getRunner(serial))!.authToken === newToken);
  const realOwnerOf = mock.petOwnerOf.bind(mock);
  let reads = 0;
  mock.petOwnerOf = async () => {
    reads += 1;
    throw new Error("rpc down");
  };
  const down = await rotate(tokenId, "bob");
  const downBody = (await down.json()) as Record<string, any>;
  check("with the chain down the route fails closed: 503 ownership_unavailable, retryable", down.status === 503 && downBody.code === "ownership_unavailable" && downBody.retryable === true && !downBody.applePassUrl, JSON.stringify(downBody));
  check("after exactly one retry", reads === 2, `${reads} reads`);
  check("with a Retry-After", down.headers.get("retry-after") === "5");
  mock.petOwnerOf = realOwnerOf;
  // The buyer's first request here is their claim: same rotation, record rebound to them.
  const buyer = await rotate(tokenId, "bob");
  const buyerRow = (await store.getRunner(serial))!;
  check("the buyer's first rotate-links is a claim: 200, record rebound, secret rotated", buyer.status === 200 && buyerRow.ownerAddress.toLowerCase() === bob.address.toLowerCase() && buyerRow.authToken !== newToken, String(buyer.status));
  const buyerKeepsake = await applePass(serial, newToken);
  check("and alice's card refreshes into the TRANSFERRED keepsake (a sale, not a reset)", buyerKeepsake.status === 200 && buyerKeepsake.headers.get("x-walletchi-pass") === "transferred", `${buyerKeepsake.status} ${buyerKeepsake.headers.get("x-walletchi-pass")}`);
  check("and the seller's care session was revoked with the sale", (await store.getCareSession(serial))?.revokedAt instanceof Date);
} finally {
  _setPrivyClientForTests(null);
  _setRunnerGoogleForTests(null);
  server.close();
}

console.log(`\nRESULT: ${passes} passed, ${failures} failed`);
console.log(failures === 0 ? "ALL CHECKS PASSED" : `${failures} CHECK(S) FAILED`);
process.exit(failures === 0 ? 0 : 1);
