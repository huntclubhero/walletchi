/*
 * Spec-floor conformance test for the ERC-4361 signed care path.
 *
 * Exercises the additive strong-proof-of-control care flow end to end against an
 * in-memory Store + MockChain (same hermetic posture as smoke.ts): challenge
 * issuance, single-use nonce, expiry, domain binding, action/token binding, a
 * fresh ownerOf read that catches a transfer between issuance and use, the happy
 * path, and the ERC-1271 contract-account fallback. Prints PASS/FAIL and exits
 * nonzero on any failure.
 */

process.env.NODE_ENV ??= "test";
process.env.LOG_LEVEL ??= "warn";
process.env.DATABASE_URL ??= "postgres://smoke:smoke@localhost:5432/smoke";
process.env.DEMO_BYPASS_PAYMENT = "true";
process.env.PASS_STUB_MODE = "true";
process.env.EMAIL_STUB = "true";
process.env.GOOGLE_WALLET_STUB = "true";
process.env.PRIVY_APP_ID = "";
process.env.PRIVY_APP_SECRET = "";

const { config } = await import("../src/config.js");
const { createApp } = await import("../src/app.js");
const { InMemoryStore } = await import("../src/store/memory.js");
const { Relayer } = await import("../src/chain/relayer.js");
const { MockChain } = await import("../src/chain/mock.js");
const { verifierDomain, _resetChallengeState } = await import("../src/runner/challenge.js");
const { privateKeyToAccount } = await import("viem/accounts");
import type { AppContext } from "../src/context.js";
import type { AddressInfo } from "node:net";

let passCount = 0;
let failCount = 0;
function check(name: string, cond: boolean, detail = ""): void {
  if (cond) {
    passCount++;
    console.log(`  PASS  ${name}`);
  } else {
    failCount++;
    console.log(`  FAIL  ${name} ${detail ? "| " + detail : ""}`);
  }
}
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function run() {
  const store = new (InMemoryStore as any)();
  const relayer = new (Relayer as any)(new (MockChain as any)());
  const mock = relayer.chain as any;
  const ctx: AppContext = { store, relayer };
  const app = createApp(ctx);
  const server = app.listen(0);
  await new Promise((r) => server.once("listening", r));
  const port = (server.address() as AddressInfo).port;
  const base = `http://127.0.0.1:${port}`;
  const j = (r: Response) => r.json() as Promise<any>;

  console.log(`\nWALLETCHI spec-floor conformance test on ${base}\n`);
  console.log(`  verifier domain: ${verifierDomain()}\n`);

  _resetChallengeState();

  // The owner wallet (a self-custody holder who signs). Well-known anvil dev key.
  const owner = privateKeyToAccount("0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d");
  const stranger = privateKeyToAccount("0x5de4111afa1a4b94908f83103eb1f1706367c2e68ca870fc3fb9a804cdab365a");

  // Mint a pet through the real checkout flow, then flip its on-chain owner to
  // the self-custody wallet (simulates a holder who exported their key).
  async function mintPetOwnedBy(email: string, ownerAddress: string): Promise<{ serial: string; tokenId: string }> {
    const co = await fetch(`${base}/api/runner/checkout`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ email }),
    }).then(j);
    for (let i = 0; i < 40; i++) {
      const s = await fetch(`${base}/api/runner/checkout/${co.serial}`).then(j);
      if (s.status === "ready" || s.status === "failed") break;
      await sleep(50);
    }
    const row = (await store.getRunner(co.serial))!;
    mock.setPetOwnerMock(row.tokenId, ownerAddress);
    return { serial: co.serial, tokenId: row.tokenId };
  }

  async function getChallenge(serial: string, action: string, address: string) {
    return fetch(`${base}/api/runner/${serial}/action/${action}/challenge?address=${address}`).then(j);
  }
  async function postSigned(serial: string, action: string, message: string, signature: string) {
    const r = await fetch(`${base}/api/runner/${serial}/action/${action}/signed`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ message, signature }),
    });
    return { status: r.status, body: (await r.json()) as any };
  }

  try {
    // ==== Challenge shape ====
    {
      const pet = await mintPetOwnedBy("floor-shape@walletchi.test", owner.address);
      const ch = await getChallenge(pet.serial, "feed", owner.address);
      check(
        "challenge is ERC-4361, names domain + chain id + nonce + expiration",
        typeof ch.message === "string" &&
          ch.message.includes(`${verifierDomain()} wants you to sign in`) &&
          ch.message.includes(`Chain ID: ${config.robinhood.chainId}`) &&
          ch.message.includes(`Nonce: ${ch.nonce}`) &&
          /Expiration Time:/.test(ch.message) &&
          ch.message.includes(`for pet #${pet.tokenId}`),
        JSON.stringify(ch).slice(0, 200),
      );
    }

    // ==== Happy path ====
    let replayMsg = "";
    let replaySig = "";
    let replaySerial = "";
    {
      const pet = await mintPetOwnedBy("floor-happy@walletchi.test", owner.address);
      const ch = await getChallenge(pet.serial, "feed", owner.address);
      const sig = await owner.signMessage({ message: ch.message });
      const res = await postSigned(pet.serial, "feed", ch.message, sig);
      check("happy path: valid signed challenge is accepted (200 ok)", res.status === 200 && res.body.ok === true, JSON.stringify(res));
      replayMsg = ch.message;
      replaySig = sig;
      replaySerial = pet.serial;
    }

    // ==== Replayed nonce ====
    {
      const res = await postSigned(replaySerial, "feed", replayMsg, replaySig);
      check("replayed nonce is rejected (single use)", res.status === 400 && res.body.code === "replayed", JSON.stringify(res));
    }

    // ==== Expired challenge ====
    {
      const pet = await mintPetOwnedBy("floor-expired@walletchi.test", owner.address);
      const savedTtl = config.CHALLENGE_TTL_SECONDS;
      config.CHALLENGE_TTL_SECONDS = 1; // 1-second window
      const ch = await getChallenge(pet.serial, "feed", owner.address);
      config.CHALLENGE_TTL_SECONDS = savedTtl;
      const sig = await owner.signMessage({ message: ch.message });
      await sleep(1200); // let it lapse
      const res = await postSigned(pet.serial, "feed", ch.message, sig);
      check("expired challenge is rejected", res.status === 400 && res.body.code === "expired", JSON.stringify(res));
    }

    // ==== Wrong domain ====
    {
      const pet = await mintPetOwnedBy("floor-domain@walletchi.test", owner.address);
      const ch = await getChallenge(pet.serial, "feed", owner.address);
      // Tamper the SIWE domain line (and the URI) to a different origin, re-sign.
      const tampered = ch.message
        .replace(`${verifierDomain()} wants you to sign in`, "evil.example.com wants you to sign in")
        .replace(/URI: \S+/, "URI: https://evil.example.com");
      const sig = await owner.signMessage({ message: tampered });
      const res = await postSigned(pet.serial, "feed", tampered, sig);
      check("wrong-domain challenge is rejected", res.status === 400 && res.body.code === "bad_domain", JSON.stringify(res));
    }

    // ==== Wrong action / token binding ====
    {
      const pet = await mintPetOwnedBy("floor-binding@walletchi.test", owner.address);
      // Challenge issued for FEED, replayed against the WATER endpoint.
      const ch = await getChallenge(pet.serial, "feed", owner.address);
      const sig = await owner.signMessage({ message: ch.message });
      const res = await postSigned(pet.serial, "water", ch.message, sig);
      check("challenge for one action cannot authorize another (bad_binding)", res.status === 400 && res.body.code === "bad_binding", JSON.stringify(res));
    }

    // ==== Ownership transferred between challenge and action ====
    {
      const pet = await mintPetOwnedBy("floor-transfer@walletchi.test", owner.address);
      const ch = await getChallenge(pet.serial, "feed", owner.address);
      const sig = await owner.signMessage({ message: ch.message });
      // The pet sells to someone else AFTER the challenge was issued + signed.
      mock.setPetOwnerMock(pet.tokenId, stranger.address);
      const res = await postSigned(pet.serial, "feed", ch.message, sig);
      check("transfer between challenge and action is rejected (fresh ownerOf)", res.status === 403 && res.body.code === "not_owner", JSON.stringify(res));
    }

    // ==== Signature by a non-owner is rejected ====
    {
      const pet = await mintPetOwnedBy("floor-wrongsigner@walletchi.test", owner.address);
      // Challenge is issued FOR the owner, but the stranger signs it.
      const ch = await getChallenge(pet.serial, "feed", owner.address);
      const sig = await stranger.signMessage({ message: ch.message });
      const res = await postSigned(pet.serial, "feed", ch.message, sig);
      check("a signature not made by the claimed account is rejected", res.status === 401 && res.body.code === "bad_signature", JSON.stringify(res));
    }

    // ==== ERC-1271 contract-account happy path ====
    {
      // A smart-contract wallet owns the pet. EOA recovery cannot match it, so the
      // server falls back to isValidErc1271Signature, which the mock resolves via a
      // registered predicate (stands in for the account's isValidSignature).
      const contractAddr = "0x00000000000000000000000000000000c0ffee01";
      const pet = await mintPetOwnedBy("floor-1271@walletchi.test", contractAddr);
      const ch = await getChallenge(pet.serial, "feed", contractAddr);
      // Any well-formed signature; the contract account attests it via 1271.
      const sig = await stranger.signMessage({ message: ch.message });
      mock.setContractSignerMock(contractAddr, (m: string, s: string) => m === ch.message && s === sig);
      const res = await postSigned(pet.serial, "feed", ch.message, sig);
      check("ERC-1271 contract-account signature is accepted via fallback", res.status === 200 && res.body.ok === true, JSON.stringify(res));
      // And a signature the contract does NOT attest is rejected.
      const ch2 = await getChallenge(pet.serial, "water", contractAddr);
      const badSig = await stranger.signMessage({ message: ch2.message });
      mock.setContractSignerMock(contractAddr, () => false);
      const res2 = await postSigned(pet.serial, "water", ch2.message, badSig);
      check("ERC-1271 fallback rejects a signature the account does not attest", res2.status === 401 && res2.body.code === "bad_signature", JSON.stringify(res2));
    }

    // ==== A client-invented nonce (never issued) is rejected ====
    {
      const pet = await mintPetOwnedBy("floor-fakenonce@walletchi.test", owner.address);
      // Build a syntactically valid SIWE message with a nonce the server never issued.
      const ch = await getChallenge(pet.serial, "feed", owner.address);
      const forged = ch.message.replace(/Nonce: \S+/, "Nonce: deadbeefdeadbeef");
      const sig = await owner.signMessage({ message: forged });
      const res = await postSigned(pet.serial, "feed", forged, sig);
      check("a nonce the server never issued is rejected", res.status === 400 && res.body.code === "bad_nonce", JSON.stringify(res));
    }

    // ==== Mutating guard reads ownership fresh, never through the 60s cache ====
    {
      const { careOwnerGuard } = await import("../src/runner/claim.js");
      const pet = await mintPetOwnedBy("floor-freshguard@walletchi.test", owner.address);
      const runner = (await store.getRunner(pet.serial))!;
      // The guard compares the chain owner against the runner ROW's recorded
      // address (the custodial account), so align the mock with the record.
      mock.setPetOwnerMock(pet.tokenId, runner.ownerAddress);

      // Warm the cache with the current owner via a fresh read.
      const before = await careOwnerGuard(ctx, runner, { fresh: true });
      check("fresh guard passes for the current owner", before === "ok", String(before));

      // The pet sells. The cache still holds the seller for up to 60s.
      mock.setPetOwnerMock(pet.tokenId, stranger.address);
      const stale = await careOwnerGuard(ctx, runner);
      check("cached guard still trusts the stale owner (the read-path posture)", stale === "ok", String(stale));

      // The mutating path must refuse immediately, cache or no cache.
      const fresh = await careOwnerGuard(ctx, runner, { fresh: true });
      check("fresh guard refuses the very next action after a transfer", fresh === "transferred", String(fresh));

      // RPC-blip fallback is preserved: with the read down, the fresh guard
      // falls back to the last-known-good cached owner instead of failing.
      const origOwnerOf = relayer.petOwnerOf.bind(relayer);
      (relayer as any).petOwnerOf = async () => { throw new Error("rpc down"); };
      const blip = await careOwnerGuard(ctx, runner, { fresh: true });
      (relayer as any).petOwnerOf = origOwnerOf;
      check("fresh guard degrades to last-known-good on an RPC blip", blip === "transferred", String(blip));
    }
  } finally {
    server.close();
  }

  console.log(`\nRESULT: ${passCount} passed, ${failCount} failed\n`);
  if (failCount > 0) process.exit(1);
}

run().catch((err) => {
  console.error(err);
  process.exit(1);
});
