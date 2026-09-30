// PROBE: can a BRAND-NEW keeper arm one-tap care at mint time on a season that
// has NOT started yet?
//
// This is the whole onboarding promise. Under the sellout model care() is
// refused until the collection mints out, so the old bootstrap (a first
// sponsored care that both delegates and hatches) is unavailable, and Alchemy
// refuses wallet_createSession for an account that is not yet 7702 delegated.
// The answer is a single harmless sponsored call the paymaster webhook now
// funds: setCarer(tokenId, address(0), 0), a revoke of a carer a fresh pet
// never had.
//
// Mirrors web-cub/src/lib/aa.ts (bootstrapDelegation) + lib/session.ts
// (grantCareSession) exactly, so a pass here is a pass for the real client.
//
//   OWNER_PK=0x<key that OWNS TOKEN_ID> TOKEN_ID=3 node scripts/probe-sellout-arming.mjs
import { createSmartWalletClient, alchemyWalletTransport } from "@alchemy/wallet-apis";
import { privateKeyToAccount, generatePrivateKey } from "viem/accounts";
import { createPublicClient, http, defineChain, encodeFunctionData } from "viem";

const ALCHEMY_API_KEY = process.env.ALCHEMY_API_KEY || "";
const GAS_POLICY_ID = process.env.GAS_POLICY_ID || "a98a174b-510a-40ed-b759-32f1d7b2ff2f";
const VAULT = process.env.PETVAULT_ADDRESS;
const TOKEN_ID = BigInt(process.env.TOKEN_ID ?? "0");
const OWNER_PK = process.env.OWNER_PK;
if (!OWNER_PK || !VAULT || TOKEN_ID === 0n) {
  throw new Error("OWNER_PK, PETVAULT_ADDRESS and TOKEN_ID are required");
}
const CARE_SELECTOR = "0x966664bd";

const chain = defineChain({
  id: 46630,
  name: "Robinhood Chain Testnet",
  nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
  rpcUrls: { default: { http: ["https://rpc.testnet.chain.robinhood.com"] } },
});
const pub = createPublicClient({ chain, transport: http() });
const owner = privateKeyToAccount(OWNER_PK);

const SET_CARER_ABI = [
  {
    type: "function",
    name: "setCarer",
    stateMutability: "nonpayable",
    outputs: [],
    inputs: [
      { name: "tokenId", type: "uint256" },
      { name: "carer", type: "address" },
      { name: "expiresAt", type: "uint64" },
    ],
  },
];

function why(e) {
  const seen = new Set();
  let cur = e, out = [];
  while (cur && typeof cur === "object" && !seen.has(cur)) {
    seen.add(cur);
    if (cur.shortMessage) out.push(cur.shortMessage);
    if (cur.details) out.push(cur.details);
    cur = cur.cause;
  }
  return [...new Set(out)].join(" | ").slice(0, 300) || String(e).slice(0, 200);
}

console.log("keeper wallet :", owner.address);
console.log("eth balance   :", (await pub.getBalance({ address: owner.address })).toString());
const codeBefore = await pub.getCode({ address: owner.address });
console.log("delegated     :", Boolean(codeBefore && codeBefore !== "0x"), "(false = a real new keeper)");

const client = createSmartWalletClient({
  signer: owner,
  transport: alchemyWalletTransport({ apiKey: ALCHEMY_API_KEY }),
  chain,
  paymaster: { policyId: GAS_POLICY_ID },
});

let ok = true;

// [A] The bootstrap: is the harmless setCarer revoke SPONSORED for a zero-balance keeper?
console.log("\n[A] sponsored setCarer(tokenId, 0x0, 0) ...");
try {
  const data = encodeFunctionData({
    abi: SET_CARER_ABI,
    functionName: "setCarer",
    args: [TOKEN_ID, "0x0000000000000000000000000000000000000000", 0n],
  });
  const sent = await client.sendCalls({ calls: [{ to: VAULT, data }] });
  const id = sent.id ?? sent.preparedCallIds?.[0];
  const final = await client.waitForCallsStatus({ id });
  console.log("    status:", final.status, "tx:", final.receipts?.[0]?.transactionHash ?? "(none)");
  if (final.status !== "success") ok = false;
} catch (e) {
  console.log("    REJECTED:", why(e));
  ok = false;
}

// [B] Did that install the 7702 delegation?
const codeAfter = await pub.getCode({ address: owner.address });
const delegated = Boolean(codeAfter && codeAfter !== "0x");
console.log("\n[B] delegated after:", delegated, codeAfter ?? "");
if (!delegated) ok = false;

// [C] The grant: one-tap care scoped to care() on the vault, with NO feed ever having happened.
console.log("\n[C] grantPermissions scoped to care() on the vault ...");
try {
  const sk = privateKeyToAccount(generatePrivateKey());
  const g = await client.grantPermissions({
    account: owner.address,
    expirySec: Math.floor(Date.now() / 1000) + 3600,
    key: { publicKey: sk.address, type: "secp256k1" },
    permissions: [{ type: "functions-on-contract", data: { address: VAULT, functions: [CARE_SELECTOR] } }],
  });
  console.log("    GRANT OK, context len", g.context.length);
} catch (e) {
  console.log("    GRANT FAILED:", why(e));
  ok = false;
}

// [D] The pet must still be an untouched egg: the bootstrap must not have fed it.
const alive = await pub.readContract({
  address: VAULT,
  abi: [{ type: "function", name: "alive", stateMutability: "view", inputs: [{ name: "t", type: "uint256" }], outputs: [{ type: "bool" }] }],
  functionName: "alive",
  args: [TOKEN_ID],
});
console.log("\n[D] pet alive (must be FALSE, season has not started):", alive);
if (alive !== false) ok = false;

console.log(ok ? "\nRESULT: NEW KEEPER ARMS AT MINT. First pass tap will feed silently." : "\nRESULT: FAILED");
process.exit(ok ? 0 : 1);
