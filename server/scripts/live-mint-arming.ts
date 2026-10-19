/*
 * LIVE-FIRE proof of the MINT-TIME ARMING sequence.
 *
 * This is the flow testers rejected being sent back to a website for, and it is the
 * one that now decides the whole first run. The browser half runs inside Privy and
 * cannot be driven headlessly, but the MECHANICS underneath it can, and they are
 * where the ordering constraints bite:
 *
 *   1. mint a pet to a wallet that has NEVER been used (no EIP-7702 delegation)
 *   2. that wallet sends ONE owner-signed sponsoredCare
 *        -> installs the 7702 delegation (the hard prerequisite for step 3)
 *        -> hatches the pet (the dormant egg is deliberately gone)
 *   3. grantPermissions now succeeds, scoped to care() on the vault
 *   4. install the session exactly as POST /api/pet/:tokenId/care-session does
 *   5. the pass tap works IMMEDIATELY, first try, with no website
 *
 * Step 5 is the whole point: a brand-new keeper's FIRST tap must just feed.
 *
 * Required env: PETVAULT_ADDRESS, PET721_ADDRESS, RUNNER_ISSUER_ADDRESS,
 * CARE_TOKEN_ADDRESS, RELAYER_PRIVATE_KEY (to mint), and ALCHEMY_API_KEY /
 * GAS_POLICY_ID / CARE_SESSION_SECRET. Generates its own fresh owner wallet.
 *
 *   npx tsx scripts/live-mint-arming.ts
 */
process.env.NODE_ENV ??= "test";
process.env.LOG_LEVEL ??= "warn";
process.env.DATABASE_URL ??= "postgres://live:live@localhost:5432/live";
process.env.PASS_STUB_MODE = "true";
process.env.EMAIL_STUB = "true";
process.env.GOOGLE_WALLET_STUB = "true";
process.env.PRIVY_APP_ID = "";
process.env.PRIVY_APP_SECRET = "";
process.env.ROBINHOOD_NETWORK ??= "testnet";
process.env.SURVIVAL_ENABLED = "true";
// The config boot guards key on "is real value at stake", not on NODE_ENV, and the line above
// puts this harness squarely in that bucket. These three are what a real-value deployment is
// required to have; local-only values keep the harness self-consistent (it signs and verifies
// its own care links in one process) without needing a deployment secret. ANTI_SYBIL_ENABLED is
// inert here: this script mints straight through the relayer, never the checkout endpoint that
// runs the gate.
process.env.CARE_LINK_SECRET ??= "live-fire-only-care-link-secret-not-a-deployment-key";
process.env.ANTI_SYBIL_ENABLED ??= "true";
process.env.SYBIL_PEPPER ??= "live-fire-only-sybil-pepper-not-a-deployment-key";
if (!process.env.ALCHEMY_API_KEY) throw new Error("set ALCHEMY_API_KEY");
if (!process.env.GAS_POLICY_ID) throw new Error("set GAS_POLICY_ID");
process.env.CARE_SESSION_SECRET ??= "live-fire-only-care-session-secret-not-a-deployment-key";
process.env.WEB_APP_URL ??= "https://www.playwalletchi.com";

if (!process.env.PETVAULT_ADDRESS || !process.env.RUNNER_ISSUER_ADDRESS) {
  console.error("PETVAULT_ADDRESS and RUNNER_ISSUER_ADDRESS are required.");
  process.exit(2);
}
// This harness MINTS AND HATCHES REAL PETS on whatever vault it is pointed at, which moves the
// season's endgame state. It used to read PETVAULT_ADDRESS straight from ambient env, so a shell
// that happened to have production loaded pointed it at production, which is how a live season
// ended up with four harness pets driving its contested clock. Naming the vault twice makes that
// impossible by accident: the confirm value has to be typed for THIS run.
const confirmVault = (process.env.LIVE_FIRE_CONFIRM_VAULT ?? "").toLowerCase();
if (confirmVault !== process.env.PETVAULT_ADDRESS.toLowerCase()) {
  console.error(
    "Refusing to run. This harness mints and hatches real pets and shifts the season clock.\n" +
      `Set LIVE_FIRE_CONFIRM_VAULT=${process.env.PETVAULT_ADDRESS} to confirm you mean THIS vault.`,
  );
  process.exit(2);
}
if (!process.env.RELAYER_PRIVATE_KEY) {
  console.error("RELAYER_PRIVATE_KEY is required (it mints the test pet).");
  process.exit(2);
}

const { config } = await import("../src/config.js");
const { createApp } = await import("../src/app.js");
const { InMemoryStore } = await import("../src/store/memory.js");
const { Relayer } = await import("../src/chain/relayer.js");
const { RobinhoodChain } = await import("../src/chain/robinhood.js");
const { signTag, actionPayload } = await import("../src/runner/sign.js");
const { sealSessionKey } = await import("../src/runner/session-care.js");
const { petName } = await import("../src/runner/names.js");
const { createSmartWalletClient, alchemyWalletTransport } = await import("@alchemy/wallet-apis");
const { privateKeyToAccount, generatePrivateKey } = await import("viem/accounts");
const { createPublicClient, http, defineChain, encodeFunctionData } = await import("viem");
const { randomBytes, randomUUID } = await import("node:crypto");
import type { AppContext } from "../src/context.js";
import type { AddressInfo } from "node:net";

let pass = 0;
let fail = 0;
function check(name: string, cond: boolean, detail = ""): void {
  if (cond) { pass++; console.log(`  PASS  ${name}`); }
  else { fail++; console.log(`  FAIL  ${name} ${detail ? "| " + detail : ""}`); }
}

const chain = defineChain({
  id: config.robinhood.chainId,
  name: `Robinhood ${config.ROBINHOOD_NETWORK}`,
  nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
  rpcUrls: { default: { http: [config.robinhood.rpcUrl] } },
  blockExplorers: { default: { name: "Blockscout", url: config.robinhood.explorer } },
});
const pub = createPublicClient({ chain, transport: http() });
const VAULT = config.PETVAULT_ADDRESS as `0x${string}`;

const VAULT_ABI = [
  { type: "function", name: "care", stateMutability: "nonpayable", inputs: [{ name: "tokenId", type: "uint256" }, { name: "actionType", type: "uint8" }], outputs: [] },
  { type: "function", name: "careCooldown", stateMutability: "view", inputs: [], outputs: [{ type: "uint256" }] },
  { type: "function", name: "memorialState", stateMutability: "view", inputs: [{ name: "tokenId", type: "uint256" }], outputs: [{ name: "dead", type: "bool" }, { name: "bornAt", type: "uint64" }, { name: "diedAt", type: "uint64" }, { name: "careCount", type: "uint32" }, { name: "rank", type: "uint32" }] },
  { type: "function", name: "petState", stateMutability: "view", inputs: [{ name: "tokenId", type: "uint256" }], outputs: [{ name: "registered", type: "bool" }, { name: "dead", type: "bool" }, { name: "lastCareAt", type: "uint64" }, { name: "isAlive", type: "bool" }, { name: "secondsLeft", type: "uint256" }] },
] as const;

async function careCount(id: bigint): Promise<number> {
  const m = await pub.readContract({ address: VAULT, abi: VAULT_ABI, functionName: "memorialState", args: [id] });
  return Number(m[3]);
}

async function run() {
  const store = new (InMemoryStore as any)();
  const relayer = new (Relayer as any)(new (RobinhoodChain as any)());
  const ctx: AppContext = { store, relayer };
  const app = createApp(ctx);
  const server = app.listen(0);
  await new Promise((r) => server.once("listening", r));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

  console.log(`\nWALLETCHI live-fire: MINT-TIME ARMING (the new first-run)\n  vault ${VAULT}\n`);

  try {
    // A wallet that has never touched this chain: exactly a new keeper's Privy wallet.
    const ownerPk = generatePrivateKey();
    const owner = privateKeyToAccount(ownerPk);
    console.log(`  fresh keeper wallet: ${owner.address}`);
    check("keeper wallet starts with NO 7702 delegation", ((await pub.getCode({ address: owner.address })) ?? "0x") === "0x", "");
    check("keeper wallet starts with 0 ETH", (await pub.getBalance({ address: owner.address })) === 0n, "");

    // 1. Mint to them, as the site's mint flow does.
    const minted = await relayer.issueRunner(owner.address);
    const tokenId = BigInt(minted.tokenId);
    console.log(`  minted tokenId ${tokenId} -> ${petName(minted.tokenId)}`);
    check("pet minted to the keeper", Boolean(minted.tokenId), JSON.stringify(minted).slice(0, 120));
    check("pet has a NAME derived from its tokenId", petName(minted.tokenId).includes(" "), petName(minted.tokenId));
    const stateAfterMint = await pub.readContract({ address: VAULT, abi: VAULT_ABI, functionName: "petState", args: [tokenId] });
    check("pet is registered but NOT yet hatched (lastCareAt 0)", stateAfterMint[0] === true && Number(stateAfterMint[2]) === 0, JSON.stringify(stateAfterMint.map(String)));

    const client = createSmartWalletClient({
      signer: owner,
      transport: alchemyWalletTransport({ apiKey: config.ALCHEMY_API_KEY! }),
      chain,
      paymaster: { policyId: config.GAS_POLICY_ID! },
    });

    // 2. THE ONE ACTION THE KEEPER TAKES. Installs the delegation and hatches the pet.
    const sent = await client.sendCalls({
      calls: [{ to: VAULT, data: encodeFunctionData({ abi: VAULT_ABI, functionName: "care", args: [tokenId, 0] }) }],
    });
    const done = await client.waitForCallsStatus({ id: sent.id ?? sent.preparedCallIds?.[0] });
    check("mint-time care landed, gas fully sponsored", done.status === "success", String(done.status));
    check("keeper wallet is now EIP-7702 delegated", ((await pub.getCode({ address: owner.address })) ?? "0x") !== "0x", "");
    check("keeper STILL has 0 ETH (they never paid for anything)", (await pub.getBalance({ address: owner.address })) === 0n, "");
    check("pet hatched at mint (careCount 1)", (await careCount(tokenId)) === 1, "");

    // 3. The grant, which is only possible because step 2 delegated the wallet.
    const sessionPk = generatePrivateKey();
    const sessionKey = privateKeyToAccount(sessionPk);
    const expiresAtSec = Math.floor(Date.now() / 1000) + 7 * 24 * 3600;
    const granted = await client.grantPermissions({
      account: owner.address,
      expirySec: expiresAtSec,
      key: { publicKey: sessionKey.address, type: "secp256k1" },
      permissions: [{ type: "functions-on-contract", data: { address: VAULT, functions: ["0x966664bd"] } }],
    });
    check("care-scoped session granted at mint time", Boolean(granted.context?.startsWith("0x")), "");

    // 4. Install it, exactly as the server endpoint does.
    const serial = randomUUID();
    const authToken = randomBytes(24).toString("hex");
    await store.createRunner({
      serial, tokenId: String(tokenId), tbaAddress: null, ownerAddress: owner.address,
      email: "mint-arming@walletchi.local", bestScore: 0, salmon: 0, runs: 0, authToken,
      status: "ready", issueTxHash: null, failureReason: null, idleSalmon: 0, lastTickAt: null,
      lastEvent: null, lastPushAt: null, lastIdleCatchAt: null, pendingDigest: 0, lastHoneyAt: null,
      lastFishAt: null, lastExploreAt: null, pendingSalmon: 0, activeFork: null, forkExpiresAt: null,
      hunger: 40, thirst: 40, joy: 40, lastNeedsAt: null, lastCareAt: null, lastWaterAt: null,
      lastWanderPingAt: null, lastPlayAt: null, lastToyAt: null, hatched: true, toys: 0,
      critical: false, gone: false, won: false, wonPrize: "0", lastStage: 1, bornAt: null,
      diedAt: null, careCount: 0, deathRank: 0, privyUserHash: null,
    });
    await store.putCareSession({
      serial, tokenId: String(tokenId), ownerAddress: owner.address.toLowerCase(), vaultAddress: VAULT,
      publicKey: sessionKey.address.toLowerCase(), secretEnc: sealSessionKey(sessionPk),
      context: granted.context, expiresAt: new Date(expiresAtSec * 1000),
    });

    // 5. THE TEST THAT MATTERS: the keeper's FIRST pass tap must just feed.
    const url = `${base}/api/runner/${serial}/care/water?s=${signTag(authToken, actionPayload(serial, "water"))}&src=apple`;
    const armedGet = await fetch(url, { redirect: "manual" });
    check("FIRST pass tap does NOT bounce the keeper to a website", armedGet.status === 200, `status ${armedGet.status} location ${armedGet.headers.get("location") ?? "none"}`);

    const cd = Number(await pub.readContract({ address: VAULT, abi: VAULT_ABI, functionName: "careCooldown" }));
    console.log(`  ..    waiting ${cd + 5}s for the per-pet cooldown`);
    await new Promise((r) => setTimeout(r, (cd + 5) * 1000));

    const before = await careCount(tokenId);
    const posted = await fetch(url, { method: "POST", redirect: "manual" });
    const body = await posted.text();
    check("first pass tap FEEDS the pet", posted.status === 200, `status ${posted.status} ${body.slice(0, 160)}`);
    check(`careCount advanced (${before} -> ${await careCount(tokenId)})`, (await careCount(tokenId)) === before + 1, "");
    check("keeper never paid gas at any point", (await pub.getBalance({ address: owner.address })) === 0n, "");
  } finally {
    server.close();
  }

  console.log(`\nRESULT: ${pass} passed, ${fail} failed\n`);
  process.exit(fail === 0 ? 0 : 1);
}

await run();
