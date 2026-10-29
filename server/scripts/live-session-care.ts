/*
 * LIVE-FIRE proof of silent care: drive the REAL pass-link HTTP path against the
 * REAL deployed PetVault and assert the pet's on-chain careCount actually moves.
 *
 * The smoke suite proves the routing, the gates, and the fallback with a mock
 * chain. This proves the part a mock cannot: that a wallet-pass tap, with no
 * website and no signature, lands care() on-chain signed by a session key whose
 * authority is scoped by the account's own validation hooks.
 *
 * It runs the production request handlers over an in-memory store (so it needs no
 * Postgres) wired to a LIVE RobinhoodChain relayer, then:
 *   1. grants a scoped session from the pet owner's key (the ONE owner signature)
 *   2. installs it exactly as POST /api/pet/:tokenId/care-session would
 *   3. GETs the pass care link  -> expects the auto-POST interstitial
 *   4. POSTs the pass care link -> expects the care confirmation page
 *   5. re-reads the vault       -> expects careCount + 1
 *   6. optionally proves the scope: the same key cannot move the NFT
 *
 * Required env:
 *   OWNER_PK   the pet owner's private key (a throwaway self-custody test pet)
 *   TOKEN_ID   that pet's token id
 * Everything else defaults to the live testnet season. This script SPENDS one
 * care from the pet's own token-bound account, so point it at a test pet.
 *
 *   npx tsx scripts/live-session-care.ts
 */
process.env.NODE_ENV ??= "test";
process.env.LOG_LEVEL ??= "warn";
process.env.DATABASE_URL ??= "postgres://live:live@localhost:5432/live";
// Pass/email/Google are irrelevant to the care path; stub them so no credential
// is needed and no real push or mail goes out.
process.env.PASS_STUB_MODE = "true";
process.env.EMAIL_STUB = "true";
process.env.GOOGLE_WALLET_STUB = "true";
process.env.PRIVY_APP_ID = "";
process.env.PRIVY_APP_SECRET = "";

// The LIVE testnet season (2026-08-13) unless overridden. NOTE the `??=`: an ambient env WINS over
// every default below, so a shell with production loaded silently repoints this whole harness.
process.env.ROBINHOOD_NETWORK ??= "testnet";
process.env.SURVIVAL_ENABLED = "true";
// The config boot guards key on "is real value at stake", not on NODE_ENV, and the line above
// puts this harness squarely in that bucket. These three are what a real-value deployment is
// required to have; local-only values keep the harness self-consistent (it signs and verifies
// its own care links in one process) without needing a deployment secret. ANTI_SYBIL_ENABLED is
// inert here: this script never calls the checkout endpoint that runs the gate.
process.env.CARE_LINK_SECRET ??= "live-fire-only-care-link-secret-not-a-deployment-key";
process.env.ANTI_SYBIL_ENABLED ??= "true";
process.env.SYBIL_PEPPER ??= "live-fire-only-sybil-pepper-not-a-deployment-key";
process.env.PETVAULT_ADDRESS ??= "0x1Bc7D85DFBd92f7eD7A0dc2ef76AC22C35517290";
process.env.PET721_ADDRESS ??= "0x2dE09b27c0dC320c9989424A21B0855cD85fa03e";
process.env.RUNNER_ISSUER_ADDRESS ??= "0x1352fE5e29C6e4D513B83cf0eeAD8bCaD2EC5566";
process.env.CARE_TOKEN_ADDRESS ??= "0x4f1fe5BF3B41A9a1598552FFbe42297ec7075AbC";
process.env.ALCHEMY_API_KEY ??= "";
process.env.GAS_POLICY_ID ??= "";
process.env.CARE_SESSION_SECRET ??= "live-fire-only-care-session-secret-not-a-deployment-key";
process.env.WEB_APP_URL ??= "https://www.playwalletchi.com";
// Reads only. The session-care path never touches the relayer key (that is the
// whole point), but RobinhoodChain requires A key to construct, so a throwaway
// one keeps the real relayer key off this script entirely.
process.env.RELAYER_PRIVATE_KEY ??= "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d";

const OWNER_PK = process.env.OWNER_PK as `0x${string}` | undefined;
const TOKEN_ID = process.env.TOKEN_ID;
const ACTION = (process.env.ACTION ?? "feed") as "feed" | "water" | "play" | "toy" | "explore";
if (!OWNER_PK || !TOKEN_ID) {
  console.error("OWNER_PK and TOKEN_ID are required (use a throwaway self-custody test pet).");
  process.exit(2);
}

const { config } = await import("../src/config.js");
const { createApp } = await import("../src/app.js");
const { InMemoryStore } = await import("../src/store/memory.js");
const { Relayer } = await import("../src/chain/relayer.js");
const { RobinhoodChain } = await import("../src/chain/robinhood.js");
const { signTag, actionPayload } = await import("../src/runner/sign.js");
const { sealSessionKey } = await import("../src/runner/session-care.js");
const { createSmartWalletClient, alchemyWalletTransport } = await import("@alchemy/wallet-apis");
const { privateKeyToAccount } = await import("viem/accounts");
const { createPublicClient, http, defineChain, encodeFunctionData } = await import("viem");
const { randomBytes, randomUUID } = await import("node:crypto");
import type { AppContext } from "../src/context.js";
import type { AddressInfo } from "node:net";

let pass = 0;
let fail = 0;
function check(name: string, cond: boolean, detail = ""): void {
  if (cond) {
    pass++;
    console.log(`  PASS  ${name}`);
  } else {
    fail++;
    console.log(`  FAIL  ${name} ${detail ? "| " + detail : ""}`);
  }
}

const chain = defineChain({
  id: config.robinhood.chainId,
  name: `Robinhood Chain ${config.ROBINHOOD_NETWORK}`,
  nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
  rpcUrls: { default: { http: [config.robinhood.rpcUrl] } },
  blockExplorers: { default: { name: "Blockscout", url: config.robinhood.explorer } },
});
const pub = createPublicClient({ chain, transport: http() });

const VAULT_READ_ABI = [
  { type: "function", name: "careCooldown", stateMutability: "view", inputs: [], outputs: [{ type: "uint256" }] },
  {
    type: "function",
    name: "petState",
    stateMutability: "view",
    inputs: [{ name: "tokenId", type: "uint256" }],
    outputs: [
      { name: "registered", type: "bool" },
      { name: "dead", type: "bool" },
      { name: "lastCareAt", type: "uint64" },
      { name: "isAlive", type: "bool" },
      { name: "secondsLeft", type: "uint256" },
    ],
  },
  {
    type: "function",
    name: "memorialState",
    stateMutability: "view",
    inputs: [{ name: "tokenId", type: "uint256" }],
    outputs: [
      { name: "dead", type: "bool" },
      { name: "bornAt", type: "uint64" },
      { name: "diedAt", type: "uint64" },
      { name: "careCount", type: "uint32" },
      { name: "rank", type: "uint32" },
    ],
  },
] as const;

const vault = config.PETVAULT_ADDRESS as `0x${string}`;
// Same two-key confirmation as live-mint-arming.ts: this harness cares for real pets, which moves
// the season's leader and runner-up clocks, so the vault has to be named explicitly for THIS run.
if ((process.env.LIVE_FIRE_CONFIRM_VAULT ?? "").toLowerCase() !== vault.toLowerCase()) {
  console.error(
    "Refusing to run. This harness cares for real pets and shifts the season clock.\n" +
      `Set LIVE_FIRE_CONFIRM_VAULT=${vault} to confirm you mean THIS vault.`,
  );
  process.exit(2);
}

async function careCount(): Promise<number> {
  const m = await pub.readContract({ address: vault, abi: VAULT_READ_ABI, functionName: "memorialState", args: [BigInt(TOKEN_ID!)] });
  return Number(m[3]);
}

// care() is rate limited per pet. Wait the window out so a cooldown revert never
// masquerades as a session-key failure.
async function waitForCooldown(): Promise<void> {
  const cd = Number(await pub.readContract({ address: vault, abi: VAULT_READ_ABI, functionName: "careCooldown" }));
  const s = await pub.readContract({ address: vault, abi: VAULT_READ_ABI, functionName: "petState", args: [BigInt(TOKEN_ID!)] });
  const readyAt = Number(s[2]) + cd;
  let left = readyAt - Math.floor(Date.now() / 1000);
  if (left > 0) console.log(`  ..    waiting ${left + 5}s for the per-pet care cooldown`);
  while (left > -5) {
    await new Promise((r) => setTimeout(r, 5000));
    left = readyAt - Math.floor(Date.now() / 1000);
  }
}

async function run() {
  const owner = privateKeyToAccount(OWNER_PK!);
  const store = new (InMemoryStore as any)();
  const relayer = new (Relayer as any)(new (RobinhoodChain as any)());
  const ctx: AppContext = { store, relayer };
  const app = createApp(ctx);
  const server = app.listen(0);
  await new Promise((r) => server.once("listening", r));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

  console.log(`\nWALLETCHI live-fire silent care on ${base}`);
  console.log(`  vault ${vault}  tokenId ${TOKEN_ID}  owner ${owner.address}  action ${ACTION}\n`);

  try {
    check("silent care is configured (modes.silentCareLive)", config.modes.silentCareLive, JSON.stringify(config.modes));

    // The pet, as our DB would hold it.
    const serial = randomUUID();
    const authToken = randomBytes(24).toString("hex");
    const onChainOwner = await relayer.petOwnerOf(TOKEN_ID!);
    check("on-chain owner matches OWNER_PK", onChainOwner.toLowerCase() === owner.address.toLowerCase(), `${onChainOwner} vs ${owner.address}`);
    await store.createRunner({
      serial,
      tokenId: TOKEN_ID,
      tbaAddress: null,
      ownerAddress: onChainOwner,
      email: `live-fire@walletchi.local`,
      bestScore: 0, salmon: 0, runs: 0,
      authToken, status: "ready", issueTxHash: null, failureReason: null,
      idleSalmon: 0, lastTickAt: null, lastEvent: null, lastPushAt: null, lastIdleCatchAt: null,
      pendingDigest: 0, lastHoneyAt: null, lastFishAt: null, lastExploreAt: null, pendingSalmon: 0,
      activeFork: null, forkExpiresAt: null,
      hunger: 40, thirst: 40, joy: 40,
      lastNeedsAt: null, lastCareAt: null, lastWaterAt: null, lastWanderPingAt: null,
      lastPlayAt: null, lastToyAt: null,
      hatched: true, toys: 0, critical: false, gone: false, won: false, wonPrize: "0", lastStage: 1,
      bornAt: null, diedAt: null, careCount: 0, deathRank: 0, privyUserHash: null,
    });

    const careUrl = `${base}/api/runner/${serial}/care/${ACTION}?s=${signTag(authToken, actionPayload(serial, ACTION))}&src=livefire`;

    // With no session installed the tap MUST fall back to the owner-signed page.
    const fallbackGet = await fetch(careUrl, { redirect: "manual" });
    const fallbackLoc = fallbackGet.headers.get("location") ?? "";
    check(
      "no session: pass tap falls back to the owner-signed care page",
      fallbackGet.status >= 300 && fallbackGet.status < 400 && fallbackLoc.includes(`/care/${serial}/${ACTION}`),
      `status ${fallbackGet.status} location ${fallbackLoc}`,
    );

    // ---- the ONE owner signature -------------------------------------------
    const ownerClient = createSmartWalletClient({
      signer: owner,
      transport: alchemyWalletTransport({ apiKey: config.ALCHEMY_API_KEY! }),
      chain,
      paymaster: { policyId: config.GAS_POLICY_ID! },
    });
    const code = await pub.getCode({ address: owner.address });
    check("owner wallet is EIP-7702 delegated (grant prerequisite)", Boolean(code && code !== "0x"), `code ${code ?? "none"}`);
    if (!code || code === "0x") {
      console.log("  ..    owner is not delegated; send one owner-signed sponsoredCare first, then re-run");
      throw new Error("owner not delegated");
    }
    const sessionPk = `0x${randomBytes(32).toString("hex")}` as `0x${string}`;
    const sessionAccount = privateKeyToAccount(sessionPk);
    const expiresAtSec = Math.floor(Date.now() / 1000) + 24 * 3600;
    const granted = await ownerClient.grantPermissions({
      account: owner.address,
      expirySec: expiresAtSec,
      key: { publicKey: sessionAccount.address, type: "secp256k1" },
      permissions: [{ type: "functions-on-contract", data: { address: vault, functions: ["0x966664bd"] } }],
    });
    check("owner granted a care-scoped session key", Boolean(granted.context?.startsWith("0x")), granted.context?.slice(0, 20) ?? "");

    // Install exactly as POST /api/pet/:tokenId/care-session does.
    await store.putCareSession({
      serial,
      tokenId: TOKEN_ID!,
      ownerAddress: onChainOwner.toLowerCase(),
      vaultAddress: vault,
      publicKey: sessionAccount.address.toLowerCase(),
      secretEnc: sealSessionKey(sessionPk),
      context: granted.context,
      expiresAt: new Date(expiresAtSec * 1000),
    });

    // ---- the pass tap, from here on there is no signature ------------------
    // Sample BEFORE the GET. Sampling after it and comparing to a second read only
    // proves careCount is stable over a few hundred ms, which is true no matter what
    // the GET did. This is the prefetch-safety proof, so it has to straddle the GET.
    const before = await careCount();
    const armedGet = await fetch(careUrl, { redirect: "manual" });
    check("session installed: pass tap serves the auto-POST interstitial", armedGet.status === 200, `status ${armedGet.status}`);
    const afterGet = await careCount();
    check(`interstitial GET did not care (prefetch safe, careCount stayed ${before})`, afterGet === before, `before ${before} after ${afterGet}`);

    await waitForCooldown();
    const started = Date.now();
    const posted = await fetch(careUrl, { method: "POST", redirect: "manual" });
    const body = await posted.text();
    check("pass tap POST returns the care confirmation page", posted.status === 200, `status ${posted.status} body ${body.slice(0, 200)}`);
    check("confirmation page links the on-chain tx", body.includes("/tx/0x"), "");

    const after = await careCount();
    check(`on-chain careCount advanced (${before} -> ${after})`, after === before + 1, `before ${before} after ${after}`);
    console.log(`  ..    round trip ${(Date.now() - started) / 1000}s`);

    // The DB + pass reflection folded the care back in.
    const row = await store.getRunner(serial);
    check("care reflected into the pet row (meters restored)", row.hunger === 100 && row.thirst === 100 && row.joy === 100, JSON.stringify({ h: row.hunger, t: row.thirst, j: row.joy }));
    const sess = await store.getCareSession(serial);
    check("session usage recorded", sess.useCount === 1 && sess.revokedAt === null, JSON.stringify({ useCount: sess.useCount, revokedAt: sess.revokedAt }));

    // ---- grief, not theft: the same key cannot move the NFT ----------------
    if (process.env.SCOPE_TEST !== "0") {
      const sessionClient = createSmartWalletClient({
        signer: sessionAccount,
        transport: alchemyWalletTransport({ apiKey: config.ALCHEMY_API_KEY! }),
        chain,
        paymaster: { policyId: config.GAS_POLICY_ID! },
      });
      // The load-bearing grief-not-theft proof. A bare catch would pass on a network
      // blip or a client-side viem error, so we require the ACTUAL on-chain rejection
      // selectors: PreUserOpValidationHookReverted(bytes24,bytes) 0x4db96e31 wrapping
      // AddressNotAllowed() 0x2b53784e.
      const SCOPE_SELECTORS = ["0x4db96e31", "0x2b53784e"];
      let scopeHeld = false;
      let detail = "the session key was allowed to prepare an NFT transfer";
      try {
        await sessionClient.prepareCalls({
          calls: [{
            to: config.pet721Address as `0x${string}`,
            data: encodeFunctionData({
              abi: [{ type: "function", name: "transferFrom", stateMutability: "nonpayable", inputs: [{ name: "from", type: "address" }, { name: "to", type: "address" }, { name: "tokenId", type: "uint256" }], outputs: [] }],
              functionName: "transferFrom",
              args: [owner.address, "0x000000000000000000000000000000000000dEaD", BigInt(TOKEN_ID!)],
            }),
          }],
          account: owner.address,
          capabilities: { paymaster: { policyId: config.GAS_POLICY_ID! }, permissions: { context: granted.context } },
        });
      } catch (err) {
        const rd = (err as { data?: { revertData?: string }; cause?: { data?: { revertData?: string } } })?.data?.revertData
          ?? (err as { cause?: { data?: { revertData?: string } } })?.cause?.data?.revertData
          ?? "";
        const sel = rd.slice(0, 10);
        scopeHeld = SCOPE_SELECTORS.includes(sel);
        detail = scopeHeld
          ? `rejected on-chain with ${sel}`
          : `threw, but NOT with a permission-hook selector (revertData ${sel || "absent"}): ${String((err as Error)?.message ?? err).slice(0, 160)}`;
      }
      check(`GRIEF NOT THEFT: the care key cannot move the NFT (${detail})`, scopeHeld, detail);
    }
  } finally {
    server.close();
  }

  console.log(`\nRESULT: ${pass} passed, ${fail} failed\n`);
  process.exit(fail === 0 ? 0 : 1);
}

await run();
