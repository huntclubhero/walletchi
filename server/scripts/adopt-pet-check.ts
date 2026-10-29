/**
 * ADOPTION CHECK: a pet that exists on-chain but has no server record (minted outside the site,
 * e.g. by an ops script) is adopted from the chain, so its owner can sign in and claim it with no
 * pet number. runner/adopt.ts plus its callers in me-routes.ts, claim-routes.ts, idle.ts and the
 * metadata route.
 *
 * Drives the REAL handlers (in-memory store + MockChain, no network) with the fake Privy directory
 * seam the gift and rotate-links checks use:
 *
 *   1. The dashboard (GET /api/pets/by-owner) adopts unrecorded tokens before listing: the owner
 *      sees the pet, the row is built from the chain (owner, TBA, placeholder email, ready), and a
 *      site-minted pet never gets a second row.
 *   2. The Privy claim (POST /api/pet/pass-link) works on an adopted pet and puts the keeper's
 *      Privy-attested sign-in email on file.
 *   3. The email path needs no number: an email whose Privy wallet owns a pet gets its pass
 *      emailed (and the email bound); an email with no pet is 404; a pet the email does not speak
 *      for is still refused; an unclaimed transfer to the email's wallet is claimed (secret
 *      rotated, seller's email gone).
 *   4. Out-of-range numbers are refused without adopting anything.
 *   5. The metadata route adopts a pet minted after the dashboard sweep.
 *
 * Run: npx tsx scripts/adopt-pet-check.ts
 */
process.env.NODE_ENV ??= "test";
process.env.LOG_LEVEL ??= "silent";
process.env.DATABASE_URL ??= "postgres://ap:ap@localhost:5432/ap";
process.env.DEMO_BYPASS_PAYMENT = "true";
process.env.PASS_STUB_MODE = "true";
process.env.EMAIL_STUB = "true";
process.env.GOOGLE_WALLET_STUB = "true";
process.env.PRIVY_APP_ID = "";
process.env.PRIVY_APP_SECRET = "";
process.env.ANTI_SYBIL_ENABLED = "false";
process.env.TESTER_ALLOWLIST = "";
process.env.PUBLIC_BASE_URL = "https://api.walletchi.test";
process.env.WEB_APP_URL = "https://www.walletchi.test";
process.env.PET721_ADDRESS = "0x1111111111111111111111111111111111111111";
process.env.CARE_SESSION_SECRET ??= "adopt-pet-check-only-care-session-secret-not-real";

const { config } = await import("../src/config.js");
const { createApp } = await import("../src/app.js");
const { InMemoryStore } = await import("../src/store/memory.js");
const { Relayer } = await import("../src/chain/relayer.js");
const { MockChain } = await import("../src/chain/mock.js");
const { _resetClaimState } = await import("../src/runner/claim.js");
const { _setPrivyClientForTests } = await import("../src/services/privy.js");
const { _setRunnerGoogleForTests } = await import("../src/runner/google.js");
const { privateKeyToAccount, generatePrivateKey } = await import("viem/accounts");
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

const alice = privateKeyToAccount(generatePrivateKey());
const bob = privateKeyToAccount(generatePrivateKey());
const dave = privateKeyToAccount(generatePrivateKey());
type FakeUser = { email: string; wallets: { address: string; walletClientType: string }[] };
const privyDir = new Map<string, FakeUser>([
  ["alice", { email: "alice@walletchi.test", wallets: [{ address: alice.address, walletClientType: "privy" }] }],
  ["bob", { email: "bob@walletchi.test", wallets: [{ address: bob.address, walletClientType: "privy" }] }],
]);
const userRecord = (u: FakeUser) => ({
  email: { address: u.email },
  linkedAccounts: u.wallets.map((w) => ({ type: "wallet", address: w.address, walletClientType: w.walletClientType, chainType: "ethereum" })),
});
_setPrivyClientForTests({
  verifyAuthToken: async (token: string) => {
    const userId = token.startsWith("session:") ? token.slice("session:".length) : "";
    if (!privyDir.has(userId)) throw new Error("invalid privy token");
    return { userId };
  },
  getUser: async (userId: string) => {
    const u = privyDir.get(userId);
    if (!u) throw new Error("unknown privy user");
    return userRecord(u);
  },
  getUserByEmail: async (email: string) => {
    for (const u of privyDir.values()) if (u.email === email.toLowerCase()) return userRecord(u);
    return null;
  },
});
_setRunnerGoogleForTests({
  live: true,
  objectId: (runner: Pick<Runner, "serial" | "googleObjectId">) => `issuer.${runner.googleObjectId ?? `runner_${runner.serial}`}`,
  markRetired() {},
  async retireObject() {},
  async patchObject() {},
  async saveUrl(runner: Runner) {
    return `https://pay.google.com/gp/v/save/fake-${runner.authToken.slice(0, 12)}`;
  },
  async addMessage() {},
  async ensureObject() {},
} as unknown as RunnerGoogleWallet);

const post = (path: string, body: unknown) =>
  fetch(`${base}${path}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
const byOwner = async (address: string) =>
  (await (await fetch(`${base}/api/pets/by-owner?address=${address}`)).json()) as { pets: { tokenId: string; serial: string }[] };
const emailClaim = (email: string, tokenId?: string) => post("/api/claim", { method: "email", email, ...(tokenId ? { tokenId } : {}) });
const rowsFor = async (tokenId: string) => (await store.allMintedRunners()).filter((r) => r.tokenId === tokenId);

async function mintOnSite(email: string): Promise<{ serial: string; tokenId: string }> {
  const r = (await post("/api/runner/checkout", { email }).then((x) => x.json())) as { id: string };
  for (let i = 0; i < 60; i++) {
    const row = await store.getRunner(r.id);
    if (row?.status === "ready" && row.tokenId) return { serial: row.serial, tokenId: row.tokenId };
    await sleep(25);
  }
  throw new Error("mint did not complete");
}

try {
  config.modes.privyLive = true; // the real auth path: verified session + fresh ownerOf
  config.modes.survivalLive = true; // real value at stake: every fail-closed branch is live
  // The live issuer reverts the legacy runnerState view (found on 2026-10-16, when the first
  // adoption deploy could not resolve No. 0159's account). Mirror that here.
  mock.runnerState = async () => {
    throw new Error("runnerState reverted (legacy view, as on the live issuer)");
  };

  // A site mint (has a row) and two pets minted straight on the chain (no rows), like house pet
  // No. 0159. The checkout read the season gate, which caches the minted count for 15 s, so wait
  // that out before anything looks for orphans.
  const site = await mintOnSite("keeper@walletchi.test");
  const orphanBob = (await mock.issueRunner(bob.address)).tokenId;
  const orphanAlice = (await mock.issueRunner(alice.address)).tokenId;
  await sleep(15_500);
  check("precondition: the script-minted pets have no server row", (await rowsFor(orphanBob)).length === 0 && (await rowsFor(orphanAlice)).length === 0);

  // ==== 1. the dashboard adopts
  console.log("\n1. the dashboard adopts unrecorded pets");
  const bobPets = await byOwner(bob.address);
  check("bob's dashboard lists the script-minted pet", bobPets.pets.some((p) => p.tokenId === orphanBob), JSON.stringify(bobPets.pets.map((p) => p.tokenId)));
  const adopted = await rowsFor(orphanBob);
  check("exactly one row was built for it", adopted.length === 1, String(adopted.length));
  const row = adopted[0]!;
  check("the row carries the on-chain owner", row.ownerAddress === bob.address.toLowerCase(), row.ownerAddress);
  check("the row carries the pet's token account", typeof row.tbaAddress === "string" && /^0x[0-9a-fA-F]{40}$/.test(row.tbaAddress), String(row.tbaAddress));
  check("the row is ready, with the wallet placeholder email (never counts as on file)", row.status === "ready" && row.email.endsWith("@wallet.walletchi.local"), `${row.status} ${row.email}`);
  check("the same sweep adopted the other unrecorded pet", (await rowsFor(orphanAlice)).length === 1);
  check("the site-minted pet still has exactly one row", (await rowsFor(site.tokenId)).length === 1);
  await byOwner(bob.address);
  check("a second dashboard read adds no rows", (await rowsFor(orphanBob)).length === 1 && (await store.allMintedRunners()).length === 3, String((await store.allMintedRunners()).length));

  // ==== 2. the Privy claim
  console.log("\n2. the Privy claim on an adopted pet");
  const claim = await post("/api/pet/pass-link", { tokenId: orphanBob, privyToken: "session:bob" });
  const claimBody = (await claim.json()) as Record<string, unknown>;
  check("bob's Add to wallet returns his pass links", claim.status === 200 && typeof claimBody.applePassUrl === "string", JSON.stringify(claimBody).slice(0, 100));
  check("and his sign-in email is now on file", (await store.getRunner(row.serial))!.email === "bob@walletchi.test", (await store.getRunner(row.serial))!.email);
  const stranger = await post("/api/pet/pass-link", { tokenId: orphanBob, privyToken: "session:alice" });
  check("a signed-in non-owner is still refused (403)", stranger.status === 403, String(stranger.status));

  // ==== 3. the email path, no number
  console.log("\n3. the email path needs no number");
  _resetClaimState();
  const aliceEmail = await emailClaim("alice@walletchi.test");
  const aliceBody = (await aliceEmail.json()) as Record<string, unknown>;
  check("alice's email alone finds her pet and emails the pass", aliceEmail.status === 200 && aliceBody.emailed === true && aliceBody.tokenId === orphanAlice, JSON.stringify(aliceBody).slice(0, 120));
  check("and returns no capability links (typing an email is not proof)", aliceBody.applePassUrl === undefined && aliceBody.googleSaveUrl === undefined);
  check("and her email is now on file", (await rowsFor(orphanAlice))[0]!.email === "alice@walletchi.test");
  const nobody = await emailClaim("nobody@walletchi.test");
  check("an email with no pet is 404", nobody.status === 404, String(nobody.status));
  const notTheirs = await emailClaim("bob@walletchi.test", site.tokenId);
  check("an email that does not speak for the numbered pet is refused (403)", notTheirs.status === 403, String(notTheirs.status));
  const onFile = await emailClaim("keeper@walletchi.test");
  check("the minting email on file still works with no number", onFile.status === 200, String(onFile.status));

  const siteBefore = (await store.getRunner(site.serial))!;
  mock.setPetOwnerMock(site.tokenId, bob.address); // the keeper sold it to bob, unclaimed
  _resetClaimState();
  const sellerTry = await emailClaim("keeper@walletchi.test", site.tokenId);
  check("after the sale the seller's email is refused", sellerTry.status === 403, String(sellerTry.status));
  const buyer = await emailClaim("bob@walletchi.test");
  const siteAfter = (await store.getRunner(site.serial))!;
  check("the buyer's email alone claims the transferred pet", buyer.status === 200 && siteAfter.ownerAddress === bob.address.toLowerCase(), `${buyer.status} ${siteAfter.ownerAddress}`);
  check("the pass secret rotated (the seller's links are dead)", siteAfter.authToken !== siteBefore.authToken);
  check("and the buyer's email replaced the seller's", siteAfter.email === "bob@walletchi.test", siteAfter.email);

  // ==== 4. out of range
  console.log("\n4. numbers outside the minted range");
  const beyond = await emailClaim("bob@walletchi.test", "999999");
  check("an unminted number is 404", beyond.status === 404, String(beyond.status));
  check("and no row was created for it", (await rowsFor("999999")).length === 0);

  // ==== 5. the metadata route
  console.log("\n5. the metadata route adopts a later orphan");
  const late = (await mock.issueRunner(dave.address)).tokenId;
  await sleep(15_500); // the season gate caches the minted count for 15 s
  const meta = await fetch(`${base}/metadata/runner/${late}`);
  check("metadata for a script-minted pet resolves (200)", meta.status === 200, String(meta.status));
  check("and it now has exactly one row", (await rowsFor(late)).length === 1);
} finally {
  _setPrivyClientForTests(null);
  _setRunnerGoogleForTests(null);
  server.close();
}

console.log(`\nRESULT: ${passes} passed, ${failures} failed`);
console.log(failures === 0 ? "ALL CHECKS PASSED" : `${failures} CHECK(S) FAILED`);
process.exit(failures === 0 ? 0 : 1);
