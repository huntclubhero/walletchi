/**
 * "GIFT THIS PET" CHECK: POST /api/pet/:tokenId/gift/prepare, GET /api/pet/:tokenId/gift/:intentId
 * (me-routes.ts), the prepared-gift rule in the gas sponsorship webhook (gas-sponsor.ts), and the
 * landing settlement (runner/gift.ts).
 *
 * Drives the REAL handlers (in-memory store + MockChain, no network) with a fake Privy directory
 * injected through the existing test seam (so the route runs its LIVE auth path: verified session,
 * fresh ownerOf that fails closed, and the email-to-wallet directory lookup), a fake Google client,
 * and the webhook's authorization-read seam pointed at the mock chain:
 *
 *   1. Prepare refusals: no session 401, a signed-in NON-owner 403, unknown pet 404, memorial 409,
 *      gifting to yourself 400 (own address, own email, the pet's own account), an email nobody has
 *      signed in with 400, an email whose user has only an external wallet 400, a bad address 400.
 *      None of them records an intent.
 *   2. Happy path: 200 with an unguessable intent id, the recipient resolved from their email to
 *      their EMBEDDED wallet, and calldata that decodes to transferFrom(owner, recipient, tokenId)
 *      on the configured Pet721. An address recipient works too, and a re-prepare replaces.
 *   3. Webhook: approves the prepared transfer (and only that): denies a token with no intent, a
 *      transfer whose sender is not the owner, a `from` that is not the sender, a recipient other
 *      than the prepared one, an approve() on the token, an unreadable chain, and the (N+1)th
 *      approval inside the hourly window.
 *   4. Landing: once ownerOf reads the recipient the status read settles the intent, the seller's
 *      one-tap care session is revoked, and a further approval is refused. The recipient's first
 *      sign-in pass-link is their claim: secret rotated, record rebound, the seller's card refreshes
 *      into the TRANSFERRED keepsake, and the seller's rotate-links is 403. The recipient can gift
 *      onward; the seller cannot prepare again.
 *   5. The background watcher settles a landing with no status read at all.
 *
 * Run: npx tsx scripts/gift-pet-check.ts
 */
process.env.NODE_ENV ??= "test";
process.env.LOG_LEVEL ??= "silent";
process.env.DATABASE_URL ??= "postgres://gp:gp@localhost:5432/gp";
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
process.env.GAS_WEBHOOK_SIGNING_KEY = "";
process.env.CARE_SESSION_SECRET ??= "gift-pet-check-only-care-session-secret-not-real";

const { config } = await import("../src/config.js");
const { createApp } = await import("../src/app.js");
const { InMemoryStore } = await import("../src/store/memory.js");
const { Relayer } = await import("../src/chain/relayer.js");
const { MockChain } = await import("../src/chain/mock.js");
const { _resetClaimState } = await import("../src/runner/claim.js");
const { _setPrivyClientForTests } = await import("../src/services/privy.js");
const { _setRunnerGoogleForTests } = await import("../src/runner/google.js");
const { _setAuthorizationReaderForTests } = await import("../src/runner/gas-sponsor.js");
const { _resetGiftState, giftIntentById, GIFT_SPONSOR_MAX_PER_HOUR } = await import("../src/runner/gift.js");
const { sealSessionKey } = await import("../src/runner/session-care.js");
const { privateKeyToAccount, generatePrivateKey } = await import("viem/accounts");
const { decodeFunctionData, encodeFunctionData, getAddress } = await import("viem");
import type { AppContext } from "../src/context.js";
import type { Runner } from "../src/store/types.js";
import type { RunnerGoogleWallet } from "../src/runner/google.js";
import type { AddressInfo } from "node:net";
import type { Hex } from "viem";

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

// The fake Privy directory (the same seam smoke.ts and rotate-links-check.ts use). Each user has
// an EMBEDDED wallet (walletClientType "privy"), except carol, who only ever linked MetaMask: the
// email lookup must not hand a pet to a wallet the site cannot sign for.
const alice = privateKeyToAccount(generatePrivateKey());
const bob = privateKeyToAccount(generatePrivateKey());
const mallory = privateKeyToAccount(generatePrivateKey());
const carol = privateKeyToAccount(generatePrivateKey());
type FakeUser = { email: string; wallets: { address: string; walletClientType: string }[] };
const privyDir = new Map<string, FakeUser>([
  ["alice", { email: "alice@walletchi.test", wallets: [{ address: alice.address, walletClientType: "privy" }] }],
  ["bob", { email: "bob@walletchi.test", wallets: [{ address: bob.address, walletClientType: "privy" }] }],
  ["mallory", { email: "mallory@walletchi.test", wallets: [{ address: mallory.address, walletClientType: "privy" }] }],
  ["carol", { email: "carol@walletchi.test", wallets: [{ address: carol.address, walletClientType: "metamask" }] }],
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

// Records the objects the rotation retires: a gift is a transfer, so the giver's shared Google
// object must be retired (expired, links cleared) and the recipient's links go into a new one.
const googleRetired: { id: string; reason: string }[] = [];
const fakeGoogle = {
  live: true,
  objectId: (runner: Pick<Runner, "serial" | "googleObjectId">) => `issuer.${runner.googleObjectId ?? `runner_${runner.serial}`}`,
  markRetired() {},
  async retireObject(_runner: Runner, id: string, reason: string) {
    googleRetired.push({ id, reason });
  },
  async patchObject() {},
  async saveUrl(runner: Runner) {
    return `https://pay.google.com/gp/v/save/fake-${runner.authToken.slice(0, 12)}`;
  },
  async addMessage() {},
  async ensureObject() {},
} as unknown as RunnerGoogleWallet;
_setRunnerGoogleForTests(fakeGoogle);

// The webhook's ownership read, pointed at the mock chain (no carer registry in the mock).
const readOwner = async (tokenId: bigint) => {
  try {
    return { owner: await mock.petOwnerOf(tokenId.toString()), carer: "0x0000000000000000000000000000000000000000" };
  } catch {
    return null;
  }
};
_setAuthorizationReaderForTests(readOwner);

const PET721 = config.pet721Address!;
const PASS_TYPE = config.PASS_TYPE_ID;
const post = (path: string, body: unknown, headers: Record<string, string> = {}) =>
  fetch(`${base}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify(body),
  });
const prepare = (tokenId: string, user: string | null, recipient: string) =>
  post(`/api/pet/${tokenId}/gift/prepare`, { recipient, ...(user ? { privyToken: `session:${user}` } : {}) });
const status = (tokenId: string, intentId: string) => fetch(`${base}/api/pet/${tokenId}/gift/${intentId}`);
const applePass = (serial: string, token: string) =>
  fetch(`${base}/runner-apple/v1/passes/${PASS_TYPE}/${serial}`, { headers: { authorization: `ApplePass ${token}` } });

// Alchemy's webhook payload for a single execute(target, 0, data) from `sender`.
const EXECUTE_ABI = [
  {
    type: "function",
    name: "execute",
    stateMutability: "payable",
    outputs: [],
    inputs: [
      { name: "target", type: "address" },
      { name: "value", type: "uint256" },
      { name: "data", type: "bytes" },
    ],
  },
] as const;
const TRANSFER_ABI = [
  { type: "function", name: "transferFrom", stateMutability: "nonpayable", outputs: [], inputs: [{ name: "from", type: "address" }, { name: "to", type: "address" }, { name: "tokenId", type: "uint256" }] },
  { type: "function", name: "safeTransferFrom", stateMutability: "nonpayable", outputs: [], inputs: [{ name: "from", type: "address" }, { name: "to", type: "address" }, { name: "tokenId", type: "uint256" }] },
  { type: "function", name: "approve", stateMutability: "nonpayable", outputs: [], inputs: [{ name: "to", type: "address" }, { name: "tokenId", type: "uint256" }] },
] as const;
async function webhook(sender: string, target: string, data: Hex): Promise<boolean> {
  const callData = encodeFunctionData({ abi: EXECUTE_ABI, functionName: "execute", args: [getAddress(target), 0n, data] });
  const res = await fetch(`${base}/api/gas-sponsorship/webhook`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ userOperation: { sender, callData }, chainId: config.robinhood.chainId, policyId: "gift-check" }),
  });
  const body = (await res.json()) as { approved?: boolean };
  if (res.status !== 200) throw new Error(`webhook HTTP ${res.status}`);
  return body.approved === true;
}
const transferData = (from: string, to: string, tokenId: string, fn: "transferFrom" | "safeTransferFrom" = "transferFrom") =>
  encodeFunctionData({ abi: TRANSFER_ABI, functionName: fn, args: [getAddress(from), getAddress(to), BigInt(tokenId)] });

async function mintPet(email: string): Promise<{ serial: string; tokenId: string; tbaAddress: string | null }> {
  const r = (await fetch(`${base}/api/runner/checkout`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ email }),
  }).then((x) => x.json())) as { id: string };
  for (let i = 0; i < 60; i++) {
    const row = await store.getRunner(r.id);
    if (row?.status === "ready" && row.tokenId) return { serial: row.serial, tokenId: row.tokenId, tbaAddress: row.tbaAddress ?? null };
    await sleep(25);
  }
  throw new Error("mint did not complete");
}

async function installSession(serial: string, tokenId: string, owner: string): Promise<void> {
  const sessionKey = generatePrivateKey();
  await store.putCareSession({
    serial,
    tokenId,
    ownerAddress: owner.toLowerCase(),
    vaultAddress: "0x2222222222222222222222222222222222222222",
    publicKey: privateKeyToAccount(sessionKey).address.toLowerCase(),
    secretEnc: sealSessionKey(sessionKey),
    context: "0xabcd",
    expiresAt: new Date(Date.now() + 3600_000),
  });
}

try {
  config.modes.privyLive = true; // the real auth path: verified session + fresh ownerOf + directory lookup
  config.modes.survivalLive = true; // real value at stake: every fail-closed branch is live
  const pet = await mintPet("keeper@walletchi.test");
  const { serial, tokenId } = pet;
  mock.setPetOwnerMock(tokenId, alice.address);
  // Alice's first sign-in pass-link is her claim (custodial mint -> her wallet): the state every
  // keeper is in before they see the gift button.
  const claim = await post("/api/pet/pass-link", { tokenId, privyToken: "session:alice" });
  check("precondition: the owner's pass-link claim succeeds", claim.status === 200, String(claim.status));
  const before = (await store.getRunner(serial))!;
  check("precondition: the owner of record is alice", before.ownerAddress.toLowerCase() === alice.address.toLowerCase());
  const aliceToken = before.authToken;
  await installSession(serial, tokenId, alice.address);
  check("precondition: alice's one-tap care session is installed", (await store.getCareSession(serial))?.revokedAt === null);

  // ---------------------------------------------------------------- 1. prepare refusals
  console.log("\n1. prepare refusals");
  const anon = await prepare(tokenId, null, "bob@walletchi.test");
  check("no session: 401", anon.status === 401, String(anon.status));
  const stranger = await prepare(tokenId, "mallory", "bob@walletchi.test");
  const strangerBody = (await stranger.json()) as Record<string, any>;
  check("a signed-in NON-owner: 403 not_owner", stranger.status === 403 && strangerBody.code === "not_owner", JSON.stringify(strangerBody));
  const unknown = await prepare("999999", "alice", "bob@walletchi.test");
  const unknownBody = (await unknown.json()) as Record<string, any>;
  check("unknown pet: 404 not_found", unknown.status === 404 && unknownBody.code === "not_found", JSON.stringify(unknownBody));
  const memorial = await mintPet("memorial@walletchi.test");
  mock.setPetOwnerMock(memorial.tokenId, alice.address);
  await store.updateRunner(memorial.serial, { gone: true });
  const dead = await prepare(memorial.tokenId, "alice", "bob@walletchi.test");
  const deadBody = (await dead.json()) as Record<string, any>;
  check("a memorial: 409 dead_soulbound", dead.status === 409 && deadBody.code === "dead_soulbound", JSON.stringify(deadBody));
  const selfAddr = await prepare(tokenId, "alice", alice.address);
  const selfAddrBody = (await selfAddr.json()) as Record<string, any>;
  check("gifting to your own address: 400 self_gift", selfAddr.status === 400 && selfAddrBody.code === "self_gift", JSON.stringify(selfAddrBody));
  const selfEmail = await prepare(tokenId, "alice", "Alice@walletchi.test");
  const selfEmailBody = (await selfEmail.json()) as Record<string, any>;
  check("gifting to your own email: 400 self_gift", selfEmail.status === 400 && selfEmailBody.code === "self_gift", JSON.stringify(selfEmailBody));
  if (pet.tbaAddress) {
    const selfTba = await prepare(tokenId, "alice", pet.tbaAddress);
    const selfTbaBody = (await selfTba.json()) as Record<string, any>;
    check("gifting to the pet's own account: 400 self_gift", selfTba.status === 400 && selfTbaBody.code === "self_gift", JSON.stringify(selfTbaBody));
  }
  const nobody = await prepare(tokenId, "alice", "nobody@walletchi.test");
  const nobodyBody = (await nobody.json()) as Record<string, any>;
  check("an email nobody signed in with: 400 recipient_unknown", nobody.status === 400 && nobodyBody.code === "recipient_unknown", JSON.stringify(nobodyBody));
  check("and the refusal tells the owner what to do (sign in once at /me)", /sign in once/i.test(nobodyBody.error ?? "") && /\/me/.test(nobodyBody.error ?? ""), nobodyBody.error);
  const external = await prepare(tokenId, "alice", "carol@walletchi.test");
  const externalBody = (await external.json()) as Record<string, any>;
  check("an email whose user has only an external wallet: 400 recipient_unknown", external.status === 400 && externalBody.code === "recipient_unknown", JSON.stringify(externalBody));
  const badAddr = await prepare(tokenId, "alice", "0x1234");
  const badAddrBody = (await badAddr.json()) as Record<string, any>;
  check("a bad recipient: 400 bad_recipient", badAddr.status === 400 && badAddrBody.code === "bad_recipient", JSON.stringify(badAddrBody));
  const zero = await prepare(tokenId, "alice", "0x0000000000000000000000000000000000000000");
  check("the zero address: 400 bad_recipient", zero.status === 400, String(zero.status));
  const unprepared = await webhook(alice.address.toLowerCase(), PET721, transferData(alice.address, bob.address, tokenId));
  check("and none of the refusals recorded an intent: the webhook denies the transfer", unprepared === false);

  // ---------------------------------------------------------------- 2. the owner prepares
  console.log("\n2. the owner prepares a gift");
  const byAddress = await prepare(tokenId, "alice", mallory.address);
  const byAddressBody = (await byAddress.json()) as Record<string, any>;
  check("an address recipient: 200 with no recipientEmail", byAddress.status === 200 && byAddressBody.ok === true && byAddressBody.to === mallory.address.toLowerCase() && byAddressBody.recipientEmail === undefined, JSON.stringify(byAddressBody).slice(0, 160));
  const ok = await prepare(tokenId, "alice", "Bob@walletchi.test");
  const okBody = (await ok.json()) as Record<string, any>;
  check("an email recipient: 200 ok", ok.status === 200 && okBody.ok === true, JSON.stringify(okBody).slice(0, 200));
  check("resolved to bob's EMBEDDED wallet", okBody.to === bob.address.toLowerCase() && okBody.recipientEmail === "bob@walletchi.test", `${okBody.to} ${okBody.recipientEmail}`);
  check("from is the current owner", okBody.from === alice.address.toLowerCase(), okBody.from);
  const intentId = String(okBody.intentId ?? "");
  check("an unguessable intent id (32 hex)", /^[0-9a-f]{32}$/.test(intentId), intentId);
  check("and it replaced the address intent (the earlier id is gone)", giftIntentById(byAddressBody.intentId) === null);
  check("the call targets the configured Pet721", okBody.call?.to?.toLowerCase() === PET721.toLowerCase(), okBody.call?.to);
  // Named type: with a null initializer, `typeof decoded` narrows to null and the cast fails
  // to compile (tsc runs over scripts/ in the Render build, so this would block the deploy).
  type DecodedTransfer = { functionName: string; args: readonly unknown[] };
  let decoded: DecodedTransfer | null = null;
  try {
    decoded = decodeFunctionData({ abi: TRANSFER_ABI, data: okBody.call.data as Hex }) as unknown as DecodedTransfer;
  } catch {
    decoded = null;
  }
  check(
    "and its calldata is transferFrom(owner, recipient, tokenId)",
    decoded?.functionName === "transferFrom" &&
      String(decoded.args[0]).toLowerCase() === alice.address.toLowerCase() &&
      String(decoded.args[1]).toLowerCase() === bob.address.toLowerCase() &&
      decoded.args[2] === BigInt(tokenId),
    decoded ? `${decoded.functionName}(${decoded.args.map(String).join(", ")})` : "undecodable",
  );
  check("the response names the claim page for the recipient", okBody.claimUrl === "https://www.walletchi.test/claim", okBody.claimUrl);
  const expiresIn = (Date.parse(okBody.expiresAt) - Date.now()) / 1000;
  check("the intent is short-lived (about 15 minutes)", expiresIn > 14 * 60 && expiresIn <= 15 * 60 + 5, `${Math.round(expiresIn)}s`);
  const pending = await status(tokenId, intentId);
  const pendingBody = (await pending.json()) as Record<string, any>;
  check("status: prepared, 0 approvals, nothing landed", pending.status === 200 && pendingBody.status === "prepared" && pendingBody.approvals === 0 && !pendingBody.landedAt, JSON.stringify(pendingBody));
  const wrongPet = await status(memorial.tokenId, intentId);
  check("status under another pet's number: 404", wrongPet.status === 404, String(wrongPet.status));
  check("and nothing rotated on prepare", (await store.getRunner(serial))!.authToken === aliceToken);

  // ---------------------------------------------------------------- 3. the webhook rule
  console.log("\n3. the webhook rule");
  const preparedData = okBody.call.data as Hex;
  check("approves the prepared transfer from the owner", (await webhook(alice.address.toLowerCase(), PET721, preparedData)) === true);
  const approved = (await (await status(tokenId, intentId)).json()) as Record<string, any>;
  check("status: approved, 1 approval", approved.status === "approved" && approved.approvals === 1, JSON.stringify(approved));
  const other = await mintPet("other@walletchi.test");
  mock.setPetOwnerMock(other.tokenId, alice.address);
  check("denies a transfer of a token with no prepared gift", (await webhook(alice.address.toLowerCase(), PET721, transferData(alice.address, bob.address, other.tokenId))) === false);
  check("denies a transfer for a token the sender does not own", (await webhook(mallory.address.toLowerCase(), PET721, transferData(mallory.address, bob.address, tokenId))) === false);
  check("denies a `from` that is not the sender", (await webhook(mallory.address.toLowerCase(), PET721, preparedData)) === false);
  check("denies a recipient other than the prepared one", (await webhook(alice.address.toLowerCase(), PET721, transferData(alice.address, mallory.address, tokenId))) === false);
  const approveData = encodeFunctionData({ abi: TRANSFER_ABI, functionName: "approve", args: [getAddress(mallory.address), BigInt(tokenId)] });
  check("denies approve() on the token (only the two 3-arg transfers qualify)", (await webhook(alice.address.toLowerCase(), PET721, approveData)) === false);
  check("denies the same transfer aimed at another contract", (await webhook(alice.address.toLowerCase(), "0x3333333333333333333333333333333333333333", preparedData)) === false);
  _setAuthorizationReaderForTests(async () => null);
  check("denies when the ownership read is unavailable (fail closed)", (await webhook(alice.address.toLowerCase(), PET721, preparedData)) === false);
  _setAuthorizationReaderForTests(readOwner);
  check("still 1 approval: denials never count against the window", ((await (await status(tokenId, intentId)).json()) as Record<string, any>).approvals === 1);
  // The retry budget: GIFT_SPONSOR_MAX_PER_HOUR approvals in the hour (the gift plus a retry after
  // a dropped op), then a refusal, even for the same honest owner and the same prepared shape.
  let extra = 0;
  for (let i = 1; i < GIFT_SPONSOR_MAX_PER_HOUR; i++) {
    if (await webhook(alice.address.toLowerCase(), PET721, transferData(alice.address, bob.address, tokenId, "safeTransferFrom"))) extra += 1;
  }
  check(`approves up to ${GIFT_SPONSOR_MAX_PER_HOUR} per pet per hour (the safeTransferFrom shape counts the same)`, extra === GIFT_SPONSOR_MAX_PER_HOUR - 1, `${extra + 1} approvals`);
  check(`denies approval ${GIFT_SPONSOR_MAX_PER_HOUR + 1} inside the window`, (await webhook(alice.address.toLowerCase(), PET721, preparedData)) === false);
  const capped = (await (await status(tokenId, intentId)).json()) as Record<string, any>;
  check("status reflects the approvals granted", capped.approvals === GIFT_SPONSOR_MAX_PER_HOUR, JSON.stringify(capped));

  // ---------------------------------------------------------------- 4. the gift lands
  console.log("\n4. the gift lands");
  mock.setPetOwnerMock(tokenId, bob.address); // the sponsored transferFrom was mined
  const landed = await status(tokenId, intentId);
  const landedBody = (await landed.json()) as Record<string, any>;
  check("status: landed, with a timestamp", landed.status === 200 && landedBody.status === "landed" && typeof landedBody.landedAt === "string", JSON.stringify(landedBody));
  const revoked = await store.getCareSession(serial);
  check("the seller's care session was revoked on landing", revoked?.revokedAt instanceof Date && /gifted/.test(revoked.revokedReason ?? ""), JSON.stringify({ revokedAt: revoked?.revokedAt ?? null, reason: revoked?.revokedReason ?? null }));
  check("the record is not rebound yet (rotation waits for the recipient's first claim)", (await store.getRunner(serial))!.ownerAddress.toLowerCase() === alice.address.toLowerCase());
  check("a further approval after landing is refused (no live intent)", (await webhook(bob.address.toLowerCase(), PET721, transferData(bob.address, alice.address, tokenId))) === false);
  const sellerAgain = await prepare(tokenId, "alice", "bob@walletchi.test");
  const sellerAgainBody = (await sellerAgain.json()) as Record<string, any>;
  check("the seller cannot prepare again: 403 not_owner (fresh read)", sellerAgain.status === 403 && sellerAgainBody.code === "not_owner", JSON.stringify(sellerAgainBody));
  const sellerRotate = await post(`/api/pet/${tokenId}/rotate-links`, { privyToken: "session:alice" });
  check("and the seller's rotate-links is 403", sellerRotate.status === 403, String(sellerRotate.status));
  // The recipient's first sign-in pass-link IS the claim (existing machinery, untouched here).
  const giverRow = (await store.getRunner(serial))!;
  googleRetired.length = 0;
  const bobClaim = await post("/api/pet/pass-link", { tokenId, privyToken: "session:bob" });
  const bobClaimBody = (await bobClaim.json()) as Record<string, any>;
  const afterClaim = (await store.getRunner(serial))!;
  check("the recipient's first pass-link is their claim: 200 with a fresh Apple link", bobClaim.status === 200 && typeof bobClaimBody.applePassUrl === "string", JSON.stringify(bobClaimBody).slice(0, 120));
  check("the pass secret rotated", afterClaim.authToken !== aliceToken && afterClaim.authToken.length === 48);
  check("the giver's Google object was retired as a transfer and the recipient got a new one", googleRetired.length === 1 && googleRetired[0]!.reason === "transfer" && googleRetired[0]!.id === fakeGoogle.objectId(giverRow) && fakeGoogle.objectId(afterClaim) !== fakeGoogle.objectId(giverRow), JSON.stringify(googleRetired));
  check("the owner of record is now the recipient", afterClaim.ownerAddress.toLowerCase() === bob.address.toLowerCase(), afterClaim.ownerAddress);
  check("the seller's email was unbound", afterClaim.email !== before.email, afterClaim.email);
  check("and the recipient's Privy-attested sign-in email is on file instead", afterClaim.email === "bob@walletchi.test", afterClaim.email);
  const keepsake = await applePass(serial, aliceToken);
  check("the seller's card refreshes into the TRANSFERRED keepsake", keepsake.status === 200 && keepsake.headers.get("x-walletchi-pass") === "transferred", `${keepsake.status} ${keepsake.headers.get("x-walletchi-pass")}`);
  const live = await applePass(serial, afterClaim.authToken);
  check("the new token serves the live pass", live.status === 200 && live.headers.get("x-walletchi-pass") !== "transferred", String(live.status));
  const onward = await prepare(tokenId, "bob", mallory.address);
  check("the recipient can gift onward (200)", onward.status === 200, String(onward.status));

  // ---------------------------------------------------------------- 5. the background watcher
  console.log("\n5. the background watcher");
  const watched = await mintPet("watched@walletchi.test");
  mock.setPetOwnerMock(watched.tokenId, alice.address);
  await post("/api/pet/pass-link", { tokenId: watched.tokenId, privyToken: "session:alice" });
  await installSession(watched.serial, watched.tokenId, alice.address);
  const watchedPrep = (await (await prepare(watched.tokenId, "alice", "bob@walletchi.test")).json()) as Record<string, any>;
  check("precondition: prepared", watchedPrep.ok === true, JSON.stringify(watchedPrep).slice(0, 80));
  mock.setPetOwnerMock(watched.tokenId, bob.address);
  let settled = false;
  for (let i = 0; i < 40 && !settled; i++) {
    await sleep(250);
    settled = giftIntentById(watchedPrep.intentId)?.status === "landed";
  }
  check("the watcher settled the landing with no status read (within 10s)", settled);
  const watchedSession = await store.getCareSession(watched.serial);
  check("and revoked the seller's session", watchedSession?.revokedAt instanceof Date, JSON.stringify({ revokedAt: watchedSession?.revokedAt ?? null }));
} finally {
  _setPrivyClientForTests(null);
  _setRunnerGoogleForTests(null);
  _setAuthorizationReaderForTests(null);
  _resetGiftState();
  _resetClaimState();
  server.close();
}

console.log(`\nRESULT: ${passes} passed, ${failures} failed`);
console.log(failures === 0 ? "ALL CHECKS PASSED" : `${failures} CHECK(S) FAILED`);
process.exit(failures === 0 ? 0 : 1);
