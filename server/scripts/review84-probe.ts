/**
 * REVIEW PROBE for PR 84, kept as a permanent check (npm run release-seat:probe). Drives the REAL /api/me/release-seat handler the
 * same way release-seat-check.ts does (in-memory store, MockChain, fake Privy through the test
 * seam) but WITHOUT calling _resetClaimState() between steps, so the 60 s owner cache behaves as
 * it does in production. Two wrong-deletion paths:
 *
 *   A. STALE OWNER CACHE: a keeper's dashboard (by-owner) warms the owner cache, then pet 1 is
 *      transferred on-chain to a signed-in user with no other pet, and that user's /me fires the
 *      release inside the cache window.
 *   B. UNRECORDED MINT: a pet is minted on-chain straight into a signed-in user's wallet (the ops
 *      mint path: No. 0160 and 0161 were minted that way) and the server has no Runner row for it
 *      yet (adoption sweep throttled / season gate cached). The user signs in.
 *
 * Expected if the route is safe: both answer has_pet or 503, nothing deleted. Exits 1 otherwise.
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
process.env.CARE_SESSION_SECRET ??= "review84-probe-only-care-session-secret-not-real";

const { config } = await import("../src/config.js");
const { createApp } = await import("../src/app.js");
const { InMemoryStore } = await import("../src/store/memory.js");
const { Relayer } = await import("../src/chain/relayer.js");
const { MockChain } = await import("../src/chain/mock.js");
const { _setPrivyClientForTests } = await import("../src/services/privy.js");
const { privateKeyToAccount, generatePrivateKey } = await import("viem/accounts");
import type { AppContext } from "../src/context.js";
import type { AddressInfo } from "node:net";

const store = new InMemoryStore();
const mock = new MockChain();
const relayer = new Relayer(mock);
const ctx: AppContext = { store, relayer } as unknown as AppContext;
const server = createApp(ctx).listen(0);
await new Promise((r) => server.once("listening", r));
const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const addr = () => privateKeyToAccount(generatePrivateKey()).address;

type FakeUser = { email: string | null; wallets: string[] };
const privyDir = new Map<string, FakeUser>();
const deleted: string[] = [];
_setPrivyClientForTests({
  verifyAuthToken: async (token: string) => {
    const userId = token.startsWith("session:") ? token.slice("session:".length) : "";
    if (!privyDir.has(userId)) throw new Error("invalid privy token");
    return { userId };
  },
  getUser: async (userId: string) => {
    const u = privyDir.get(userId);
    if (!u) throw new Error("unknown privy user");
    return {
      // Past the age floor, so the probe reaches the ownership passes it exists to test.
      createdAt: new Date(Date.now() - 60 * 60_000),
      email: u.email ? { address: u.email } : undefined,
      linkedAccounts: [
        ...(u.email ? [{ type: "email", address: u.email }] : []),
        ...u.wallets.map((w) => ({ type: "wallet", address: w, walletClientType: "privy" })),
      ],
    };
  },
  deleteUser: async (userId: string) => {
    deleted.push(userId);
    privyDir.delete(userId);
  },
});

const post = (path: string, body: unknown) =>
  fetch(`${base}${path}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
const release = async (user: string) => {
  const res = await post("/api/me/release-seat", { privyToken: `session:${user}` });
  return { status: res.status, body: (await res.json()) as Record<string, unknown> };
};
const byOwner = async (address: string) => {
  const res = await fetch(`${base}/api/pets/by-owner?address=${address}`);
  return (await res.json()) as { pets: unknown[] };
};
async function mintPet(email: string): Promise<{ serial: string; tokenId: string }> {
  const r = (await post("/api/runner/checkout", { email }).then((x) => x.json())) as { id: string };
  for (let i = 0; i < 60; i++) {
    const row = await store.getRunner(r.id);
    if (row?.status === "ready" && row.tokenId) return { serial: row.serial, tokenId: row.tokenId };
    await sleep(25);
  }
  throw new Error("mint did not complete");
}

config.modes.privyLive = true;
config.modes.survivalLive = true;

try {
  // ====== A. stale owner cache after an on-chain transfer ======
  console.log("\nA. stale owner cache: pet transferred on-chain to a no-pet user inside the 60 s window");
  const keeper = addr();
  const friend = addr();
  privyDir.set("friend", { email: "friend@example.com", wallets: [friend] });
  const pet = await mintPet("keeper@walletchi.test");
  mock.setPetOwnerMock(pet.tokenId, keeper);
  const warm = await byOwner(keeper); // the keeper's own dashboard warms the owner cache
  console.log(`  keeper's dashboard sees ${warm.pets.length} pet(s) (cache warmed for token ${pet.tokenId})`);
  mock.setPetOwnerMock(pet.tokenId, friend); // the transfer lands on-chain
  console.log(`  chain now says token ${pet.tokenId} owner = friend:`, (await mock.petOwnerOf(pet.tokenId)).toLowerCase() === friend.toLowerCase());
  const friendList = await byOwner(friend);
  console.log(`  friend's dashboard (by-owner) sees ${friendList.pets.length} pet(s)`);
  const ra = await release("friend");
  console.log(`  release-seat for friend -> ${ra.status} ${JSON.stringify(ra.body)}`);
  console.log(`  RESULT A: ${deleted.includes("friend") ? "WRONG DELETION (friend's Privy user deleted while owning the pet on-chain)" : "safe"}`);

  // ====== B. on-chain mint with no server row (ops mint path) ======
  console.log("\nB. unrecorded on-chain mint: pet minted straight into a signed-in user's wallet, no Runner row yet");
  const josh = addr();
  privyDir.set("josh", { email: "josh@example.com", wallets: [josh] });
  const gateBefore = await mock.seasonGate();
  // The ops mint path: the chain mints (issueRunner is the mock's on-chain mint), no Runner row.
  const issued = await mock.issueRunner(josh);
  const newId = issued.tokenId;
  const bumped = (await mock.seasonGate()).minted === gateBefore.minted + 1;
  if (!bumped) {
    console.log("  could not bump the mock's minted counter; skipping B");
  } else {
    console.log(`  chain: totalMinted=${(await mock.seasonGate()).minted}, ownerOf(${newId})=josh; server rows with a tokenId: ${(await store.allMintedRunners()).length}`);
    const joshList = await byOwner(josh);
    console.log(`  josh's dashboard (by-owner) sees ${joshList.pets.length} pet(s)`);
    const rb = await release("josh");
    console.log(`  release-seat for josh -> ${rb.status} ${JSON.stringify(rb.body)}`);
    console.log(`  RESULT B: ${deleted.includes("josh") ? "WRONG DELETION (josh's Privy user deleted while owning a freshly minted pet on-chain)" : "safe"}`);
    console.log(`  rows now: ${(await store.allMintedRunners()).length} (adoption sweep ${(await store.allMintedRunners()).some((r) => r.tokenId === newId) ? "DID" : "did NOT"} record token ${newId})`);
  }
} finally {
  _setPrivyClientForTests(null);
  server.close();
}
console.log(`\ndeleted: ${JSON.stringify(deleted)}`);
console.log(deleted.length === 0 ? "RESULT: both probes safe" : "RESULT: WRONG DELETION");
process.exit(deleted.length === 0 ? 0 : 1);
