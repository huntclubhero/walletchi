/**
 * WALLET PASS EXTENSION END TO END, against a LOCAL FORK (never a real chain).
 *
 * Driven by contracts/script/showcase-rehearse.sh with REHEARSE_E2E=1, after it has deployed the
 * showcase suite onto an anvil fork running as chain 46630 (the server pins the Robinhood testnet id).
 * This runs the REAL server (RobinhoodChain + viem against the fork, in-memory store) and proves the
 * whole discovery loop a wallet or marketplace would run:
 *
 *   mint through the real checkout -> transfer to a keeper on chain -> read Pet721.passURI(id) ON
 *   CHAIN -> fetch it (401 gated) -> fetch the acquire challenge -> sign it with the keeper -> fetch
 *   the manifest (200) -> download formats.apple -> check PassUpdate was emitted by the token contract.
 *
 * Env (set by the rehearsal): E2E_RPC, E2E_PORT, E2E_PET, E2E_ISSUER, E2E_VAULT, E2E_CARE,
 * E2E_RELAYER_PK (the fork's deployer/relayer), E2E_KEEPER_PK.
 */
const need = (k: string) => {
  const v = process.env[k];
  if (!v) throw new Error(`${k} is required`);
  return v;
};
const RPC = need("E2E_RPC");
const PORT = Number(need("E2E_PORT"));
const PET = need("E2E_PET");

process.env.NODE_ENV = "test";
process.env.LOG_LEVEL ??= "warn";
process.env.DATABASE_URL ??= "postgres://e2e:e2e@localhost:5432/e2e"; // unused: in-memory store
process.env.ROBINHOOD_NETWORK = "testnet";
process.env.ROBINHOOD_RPC_URL = RPC;
process.env.READ_RPC_URL = RPC;
process.env.RELAYER_PRIVATE_KEY = need("E2E_RELAYER_PK");
process.env.RUNNER_ISSUER_ADDRESS = need("E2E_ISSUER");
process.env.PET721_ADDRESS = PET;
process.env.PETVAULT_ADDRESS = need("E2E_VAULT");
process.env.CARE_TOKEN_ADDRESS = need("E2E_CARE");
process.env.SURVIVAL_ENABLED = "false";
process.env.PUBLIC_BASE_URL = `http://127.0.0.1:${PORT}`;
process.env.DEMO_BYPASS_PAYMENT = "true";
process.env.PASS_STUB_MODE = "true";
process.env.EMAIL_STUB = "true";
process.env.GOOGLE_WALLET_STUB = "true";
process.env.ANTI_SYBIL_ENABLED = "false";
process.env.PRIVY_APP_ID = "";
process.env.PRIVY_APP_SECRET = "";
process.env.TESTER_ALLOWLIST = "";
process.env.HOLDER_POSTER_PRIVATE_KEY = "";
process.env.FEE_SPLITTER_ADDRESS = "";
process.env.HOLDER_VAULT_ADDRESS = "";
process.env.REWARDS_DISTRIBUTOR_ADDRESS = "";

const { createApp } = await import("../src/app.js");
const { InMemoryStore } = await import("../src/store/memory.js");
const { createRelayer } = await import("../src/chain/relayer.js");
const { createPublicClient, createWalletClient, http, defineChain, parseAbi, getAddress, keccak256, toHex } = await import("viem");
const { privateKeyToAccount } = await import("viem/accounts");
import type { AppContext } from "../src/context.js";

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

const chain = defineChain({
  id: 46630,
  name: "fork",
  nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
  rpcUrls: { default: { http: [RPC] } },
});
const pub = createPublicClient({ chain, transport: http(RPC) });
const relayerAccount = privateKeyToAccount(need("E2E_RELAYER_PK") as `0x${string}`);
const keeper = privateKeyToAccount(need("E2E_KEEPER_PK") as `0x${string}`);
const relayerWallet = createWalletClient({ chain, transport: http(RPC), account: relayerAccount });
const petAbi = parseAbi([
  "function passURI(uint256) view returns (string)",
  "function supportsInterface(bytes4) view returns (bool)",
  "function transferFrom(address,address,uint256)",
  "function ownerOf(uint256) view returns (address)",
  "event PassUpdate(uint256 indexed tokenId)",
]);

const store = new InMemoryStore();
const relayer = createRelayer();
const ctx: AppContext = { store, relayer } as unknown as AppContext;
const server = createApp(ctx).listen(PORT);
await new Promise((r) => server.once("listening", r));
const base = `http://127.0.0.1:${PORT}`;

try {
  console.log("\nwallet pass end to end (real server, fork chain 46630)");
  check("the relayer is the LIVE chain client, not the stub", relayer.live === true);
  check(
    "Pet721 advertises IERC721WalletPass on chain",
    (await pub.readContract({ address: PET as `0x${string}`, abi: petAbi, functionName: "supportsInterface", args: ["0xef5f1e71"] })) === true,
  );

  // 1. Mint through the REAL checkout (custodial, to the relayer), exactly as the showcase does.
  const co = (await fetch(`${base}/api/runner/checkout`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ email: "e2e-keeper@walletchi.test" }),
  }).then((r) => r.json())) as { id?: string; error?: string };
  check("checkout accepted", Boolean(co.id), JSON.stringify(co));
  let tokenId = "";
  for (let i = 0; i < 120 && !tokenId; i++) {
    const row = await store.getRunner(co.id!);
    if (row?.status === "failed") break;
    if (row?.status === "ready" && row.tokenId) tokenId = row.tokenId;
    else await sleep(250);
  }
  check("the server minted a pet on the fork", tokenId !== "", tokenId || String((await store.getRunner(co.id!))?.failureReason));

  // 2. The relayer (custodial owner) transfers it on chain to the keeper, as a sale would.
  const hash = await relayerWallet.writeContract({
    address: PET as `0x${string}`, abi: petAbi, functionName: "transferFrom",
    args: [relayerAccount.address, keeper.address, BigInt(tokenId)],
  });
  const rcpt = await pub.waitForTransactionReceipt({ hash });
  const passUpdateTopic = keccak256(toHex("PassUpdate(uint256)"));
  const emitted = rcpt.logs.some(
    (l) => l.address.toLowerCase() === PET.toLowerCase() && l.topics[0] === passUpdateTopic && BigInt(l.topics[1] ?? "0x0") === BigInt(tokenId),
  );
  check("the transfer emitted PassUpdate(tokenId) from the token contract", emitted);

  // 3. Discovery: passURI straight off the chain.
  const passUri = (await pub.readContract({ address: PET as `0x${string}`, abi: petAbi, functionName: "passURI", args: [BigInt(tokenId)] })) as string;
  check(
    "passURI(id) on chain resolves to this server's manifest route",
    passUri === `${base}/wallet-pass/eip155/46630/${PET.toLowerCase()}/${tokenId}`,
    passUri,
  );

  // 4. Unauthenticated: gated.
  const anon = await fetch(passUri);
  const anonBody = await anon.text();
  check("an unauthenticated fetch of passURI is 401 proof_required", anon.status === 401 && anonBody.includes("proof_required"));
  check("and leaks no acquisition URL", !/runner-passes|\.pkpass/.test(anonBody));

  // 5. The keeper proves control and resolves the manifest.
  const ch = (await fetch(`${passUri}/challenge?address=${keeper.address}`).then((r) => r.json())) as { message: string };
  check("the challenge names the CAIP-19 token", ch.message.includes(`- eip155:46630/erc721:${getAddress(PET)}/${tokenId}`));
  const signature = await keeper.signMessage({ message: ch.message });
  const res = await fetch(passUri, {
    headers: {
      "x-wallet-pass-proof": Buffer.from(ch.message, "utf8").toString("base64url"),
      "x-wallet-pass-signature": signature,
    },
  });
  const manifest = (await res.json()) as { formats?: Record<string, string>; updatedAt?: number; error?: string };
  check("the owner's signed proof resolves the manifest (200)", res.status === 200, JSON.stringify(manifest).slice(0, 160));
  check("formats.apple is present", typeof manifest.formats?.apple === "string");
  check("updatedAt is integer seconds", Number.isInteger(manifest.updatedAt));

  // 6. The acquisition URL actually delivers a pass.
  if (manifest.formats?.apple) {
    const pk = await fetch(manifest.formats.apple);
    const bytes = new Uint8Array(await pk.arrayBuffer());
    check("formats.apple downloads a .pkpass (200)", pk.status === 200, `${pk.status} ${pk.headers.get("content-type")}`);
    check("served as application/vnd.apple.pkpass", (pk.headers.get("content-type") ?? "").startsWith("application/vnd.apple.pkpass"));
    check("and it is a zip archive (PK header)", bytes[0] === 0x50 && bytes[1] === 0x4b);
  }
} finally {
  server.close();
}

console.log(`\nE2E RESULT: ${passes} passed, ${failures} failed`);
process.exit(failures === 0 ? 0 : 1);
