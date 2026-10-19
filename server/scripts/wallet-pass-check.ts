/**
 * WALLET PASS EXTENSION CHECK (ERC draft, IERC721WalletPass, 0xef5f1e71)
 *
 * Drives the REAL handlers (in-memory store + MockChain, no network) for the off-chain half of the
 * draft as WALLETCHI runs it, the GATED configuration:
 *
 *   1. The manifest at passURI refuses an unauthenticated fetch with 401 proof_required and leaks no
 *      acquisition URL; the wrong chain or contract is 404.
 *   2. The acquire challenge is the draft's recommended ERC-4361 shape (CAIP-19 token first, the
 *      action URN second, nonce, expiry, verifier domain).
 *   3. A signed proof from the owner resolves the manifest ({formats:{apple,...}, updatedAt}, no-store);
 *      a replay, a non-owner, and a proof for another token are each refused.
 *   4. A new owner's first proven fetch ROTATES the pass secret, so the previous owner's pass download
 *      URL stops matching.
 *   5. THE FRESH-READ MUST: when ownerOf is down, the manifest, the care guard's fresh path and the
 *      signed-in owner endpoints fail CLOSED with a retryable error even with a warm owner cache, after
 *      exactly one retry; the read paths keep using the cache.
 *   6. tokenURI metadata carries no capability URL (no wallet_pass mirror).
 *
 * Run: npx tsx scripts/wallet-pass-check.ts
 */
process.env.NODE_ENV ??= "test";
process.env.LOG_LEVEL ??= "silent";
process.env.DATABASE_URL ??= "postgres://wp:wp@localhost:5432/wp";
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

const { config } = await import("../src/config.js");
const { createApp } = await import("../src/app.js");
const { InMemoryStore } = await import("../src/store/memory.js");
const { Relayer } = await import("../src/chain/relayer.js");
const { MockChain } = await import("../src/chain/mock.js");
const { careOwnerGuard, freshOwnerOf, OwnershipUnavailableError, _resetClaimState } = await import("../src/runner/claim.js");
const { _resetChallengeState } = await import("../src/runner/challenge.js");
const { walletPassUri } = await import("../src/runner/wallet-pass-routes.js");
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
const app = createApp(ctx);
const server = app.listen(0);
await new Promise((r) => server.once("listening", r));
const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

const alice = privateKeyToAccount(generatePrivateKey());
const bob = privateKeyToAccount(generatePrivateKey());
const mallory = privateKeyToAccount(generatePrivateKey());
const PET = config.pet721Address!;
const CHAIN = config.robinhood.chainId;

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

const pathFor = (tokenId: string) => `/wallet-pass/eip155/${CHAIN}/${PET.toLowerCase()}/${tokenId}`;

async function challenge(tokenId: string, address: string) {
  return (await fetch(`${base}${pathFor(tokenId)}/challenge?address=${address}`).then((r) => r.json())) as {
    message: string;
  };
}

async function proveAndFetch(tokenId: string, signer: typeof alice, atTokenId = tokenId) {
  const ch = await challenge(tokenId, signer.address);
  const signature = await signer.signMessage({ message: ch.message });
  const headers = {
    "x-wallet-pass-proof": Buffer.from(ch.message, "utf8").toString("base64url"),
    "x-wallet-pass-signature": signature,
  };
  const res = await fetch(`${base}${pathFor(atTokenId)}`, { headers });
  return { res, body: (await res.json()) as Record<string, any>, headers };
}

try {
  config.modes.survivalLive = true; // real value at stake: every fail-closed branch is live
  const { serial, tokenId } = await mintPet("keeper@walletchi.test");
  mock.setPetOwnerMock(tokenId, alice.address);

  // ---------------------------------------------------------------- 1. the gate
  console.log("\n1. the gated manifest");
  check("passURI composes to this route", walletPassUri(tokenId) === `https://api.walletchi.test${pathFor(tokenId)}`);
  const anon = await fetch(`${base}${pathFor(tokenId)}`);
  const anonText = await anon.text();
  check("unauthenticated: 401 proof_required", anon.status === 401 && JSON.parse(anonText).error === "proof_required", anonText.slice(0, 80));
  check("and it leaks NO acquisition URL", !/runner-passes|\.pkpass|pay\.google\.com/.test(anonText));
  check("it says which configuration it runs", JSON.parse(anonText).configuration === "gated");
  const wrongChain = await fetch(`${base}/wallet-pass/eip155/1/${PET.toLowerCase()}/${tokenId}`);
  check("another chain id is 404", wrongChain.status === 404);
  const wrongContract = await fetch(`${base}/wallet-pass/eip155/${CHAIN}/0x2222222222222222222222222222222222222222/${tokenId}`);
  check("another contract is 404", wrongContract.status === 404);

  // ---------------------------------------------------------------- 2. the challenge shape
  console.log("\n2. the acquire challenge");
  const ch = await challenge(tokenId, alice.address);
  const lines = ch.message.split("\n");
  const resIdx = lines.indexOf("Resources:");
  check("the verifier domain is the first line", lines[0] === "api.walletchi.test wants you to sign in with your Ethereum account:", lines[0]);
  check("the claimed account is the address line", lines[1] === alice.address);
  check(
    "the FIRST resource is the CAIP-19 token",
    lines[resIdx + 1] === `- eip155:${CHAIN}/erc721:0x1111111111111111111111111111111111111111/${tokenId}`,
    lines[resIdx + 1],
  );
  check("the SECOND resource is the action URN", lines[resIdx + 2] === "- urn:wallet-pass:action:acquire", lines[resIdx + 2]);
  check("it carries a nonce and an expiry", /\nNonce: \S+/.test(ch.message) && /\nExpiration Time: \S+/.test(ch.message));
  check("the statement restates the action", ch.message.includes("Authorize the acquire action for wallet pass token"));

  // ---------------------------------------------------------------- 3. proven owner
  console.log("\n3. owner-authenticated manifest");
  const first = await proveAndFetch(tokenId, alice);
  check("a signed proof from the owner resolves it (200)", first.res.status === 200, JSON.stringify(first.body).slice(0, 120));
  check("the manifest is the draft's shape", typeof first.body.formats === "object" && typeof first.body.updatedAt === "number");
  check("formats.apple is the capability .pkpass URL", /^https:\/\/api\.walletchi\.test\/runner-passes\/[^/]+\/[0-9a-f]+\.pkpass$/.test(first.body.formats?.apple ?? ""), first.body.formats?.apple);
  check("updatedAt is integer seconds", Number.isInteger(first.body.updatedAt) && first.body.updatedAt > 1_700_000_000);
  check("served no-store (acquisition URLs are not durable)", first.res.headers.get("cache-control") === "no-store");
  const replay = await fetch(`${base}${pathFor(tokenId)}`, { headers: first.headers });
  check("the same proof a second time is refused (single-use nonce)", replay.status === 401 && ((await replay.json()) as any).error === "replayed");

  const notOwner = await proveAndFetch(tokenId, mallory);
  check("a valid signature from a NON-owner is refused 403", notOwner.res.status === 403 && notOwner.body.error === "not_owner", JSON.stringify(notOwner.body));

  const other = await mintPet("second@walletchi.test");
  mock.setPetOwnerMock(other.tokenId, alice.address);
  const crossToken = await proveAndFetch(tokenId, alice, other.tokenId);
  check("a proof for one token cannot resolve another", crossToken.res.status === 401 && crossToken.body.error === "bad_binding", JSON.stringify(crossToken.body));

  // The first proven fetch was ALSO a new owner's first claim (the pet was minted custodially and
  // alice proved ownership), so it rotated. A second fetch by the same owner must NOT rotate again.
  const second = await proveAndFetch(tokenId, alice);
  check("the same owner again: same acquisition URL (no gratuitous rotation)", second.body.formats?.apple === first.body.formats?.apple);

  // ---------------------------------------------------------------- 4. transfer -> rotation
  console.log("\n4. transfer rotates the capability");
  const beforeSale = (await store.getRunner(serial))!.authToken;
  mock.setPetOwnerMock(tokenId, bob.address);
  const sellerTry = await proveAndFetch(tokenId, alice);
  check("after the sale the SELLER is refused by the fresh read", sellerTry.res.status === 403 && sellerTry.body.error === "not_owner");
  const buyer = await proveAndFetch(tokenId, bob);
  const afterSale = (await store.getRunner(serial))!;
  check("the buyer resolves the manifest", buyer.res.status === 200);
  check("and the pass secret rotated on that first claim", afterSale.authToken !== beforeSale && afterSale.ownerAddress.toLowerCase() === bob.address.toLowerCase());
  check("so the seller's pass download URL no longer matches", buyer.body.formats?.apple !== first.body.formats?.apple);
  const staleDownload = await fetch(first.body.formats.apple.replace("https://api.walletchi.test", base));
  check("and the stale .pkpass capability 404s", staleDownload.status === 404, String(staleDownload.status));

  // ---------------------------------------------------------------- 5. fresh read fails closed
  console.log("\n5. the fresh-read MUST fails closed");
  _resetClaimState();
  // Warm the owner cache with a successful read, then take the chain down.
  const warm = await careOwnerGuard(ctx, afterSale, { fresh: true });
  check("control: with the chain up the fresh guard passes", warm === "ok");
  const realOwnerOf = mock.petOwnerOf.bind(mock);
  let calls = 0;
  mock.petOwnerOf = async () => {
    calls += 1;
    throw new Error("rpc down");
  };
  calls = 0;
  const guard = await careOwnerGuard(ctx, afterSale, { fresh: true });
  check("care guard (fresh): a down chain is 'unavailable' even with a warm cache", guard === "unavailable", guard);
  check("after exactly one retry", calls === 2, `${calls} reads`);
  const readPath = await careOwnerGuard(ctx, afterSale);
  check("the READ path may still answer from the cache", readPath === "ok", readPath);

  calls = 0;
  let threw: unknown = null;
  try {
    await freshOwnerOf(ctx, tokenId);
  } catch (e) {
    threw = e;
  }
  check("freshOwnerOf throws a typed retryable error", threw instanceof OwnershipUnavailableError && (threw as any).code === "ownership_unavailable");

  _resetChallengeState();
  const downManifest = await proveAndFetch(tokenId, bob);
  check("the manifest fails closed: 503, retryable, no URL", downManifest.res.status === 503 && downManifest.body.error === "ownership_unavailable" && downManifest.body.retryable === true && !downManifest.body.formats, JSON.stringify(downManifest.body));
  check("with a Retry-After", downManifest.res.headers.get("retry-after") === "5");

  // One blip then recovery: the retry absorbs it.
  let flaky = 0;
  mock.petOwnerOf = async (id: string) => {
    flaky += 1;
    if (flaky === 1) throw new Error("blip");
    return realOwnerOf(id);
  };
  const recovered = await freshOwnerOf(ctx, tokenId);
  check("a single blip is absorbed by the one retry", recovered.toLowerCase() === bob.address.toLowerCase() && flaky === 2);
  mock.petOwnerOf = realOwnerOf;

  // The signed-in owner endpoints (session install, pass links) are all mutating: they must refuse
  // too. Privy is stubbed here, so they refuse earlier for another reason; the shared helper above is
  // the code path they now use, and its behaviour is what this section pins.

  // ---------------------------------------------------------------- 6. no mirror leak
  console.log("\n6. tokenURI metadata");
  const meta = await fetch(`${base}/metadata/runner/${tokenId}`);
  const metaText = await meta.text();
  check("metadata resolves", meta.status === 200, String(meta.status));
  check("and carries no capability URL (no wallet_pass mirror)", !/runner-passes|\.pkpass|pay\.google\.com|wallet_pass/.test(metaText));
} finally {
  server.close();
}

console.log(`\nRESULT: ${passes} passed, ${failures} failed`);
console.log(failures === 0 ? "ALL CHECKS PASSED" : `${failures} CHECK(S) FAILED`);
process.exit(failures === 0 ? 0 : 1);
