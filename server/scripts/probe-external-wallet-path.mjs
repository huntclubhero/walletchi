// PROBE: can an EXTERNAL wallet (MetaMask) get the full gasless + one-tap
// experience, given that dapps cannot ask it to sign an EIP-7702 authorization?
//
// 7702-on-own-address is only ONE way onto Alchemy's Modular Account v2. The other
// is requestAccount: a COUNTERFACTUAL smart account whose OWNER is the external
// EOA. That needs no authorization signature at all, only personal_sign and
// eth_signTypedData_v4, both of which MetaMask supports. If session keys work on
// that account type, an external-wallet owner can have gasless care AND one-tap
// care from the pass, controlled by their own MetaMask key.
//
// The question this answers: does grantPermissions work for a requestAccount
// MAv2 account, or is it 7702-only?
//
// Run: OWNER_PK=0x<fresh throwaway> node scripts/probe-external-wallet-path.mjs
import { createSmartWalletClient, alchemyWalletTransport } from "@alchemy/wallet-apis";
import { privateKeyToAccount } from "viem/accounts";
import { createPublicClient, http, defineChain } from "viem";

const ALCHEMY_API_KEY = process.env.ALCHEMY_API_KEY || "";
const GAS_POLICY_ID = process.env.GAS_POLICY_ID || "";
const PETVAULT = "0x90349bF1461F0BADCE9b9d3486cc3Dd991E816e6";
const OWNER_PK = process.env.OWNER_PK;
if (!OWNER_PK) throw new Error("OWNER_PK required (fresh throwaway)");

const chain = defineChain({
  id: 46630,
  name: "Robinhood Chain Testnet",
  nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
  rpcUrls: { default: { http: ["https://rpc.testnet.chain.robinhood.com"] } },
});
const pub = createPublicClient({ chain, transport: http() });
const owner = privateKeyToAccount(OWNER_PK);

function why(e) {
  const seen = new Set();
  let cur = e, out = [];
  while (cur && typeof cur === "object" && !seen.has(cur)) {
    seen.add(cur);
    if (cur.shortMessage) out.push(cur.shortMessage);
    if (cur.details) out.push(cur.details);
    if (cur.data?.revertData) out.push("revertData " + cur.data.revertData.slice(0, 10));
    cur = cur.cause;
  }
  return [...new Set(out)].join(" | ").slice(0, 400) || String(e).slice(0, 300);
}

console.log("external-wallet stand-in EOA:", owner.address);
console.log("(a MetaMask user signs the same way: personal_sign + eth_signTypedData_v4)\n");

const client = createSmartWalletClient({
  signer: owner,
  transport: alchemyWalletTransport({ apiKey: ALCHEMY_API_KEY }),
  chain,
  paymaster: { policyId: GAS_POLICY_ID },
});

// 1. Counterfactual MAv2 account owned by the external EOA. No 7702 anywhere.
let account;
try {
  account = await client.requestAccount();
  console.log("[1] requestAccount OK");
  console.log("    smart account:", account.address);
  console.log("    deployed     :", Boolean((await pub.getCode({ address: account.address })) ?? "0x") && (await pub.getCode({ address: account.address })) !== "0x");
} catch (e) {
  console.log("[1] requestAccount FAILED:", why(e));
  process.exit(1);
}

// 2. THE question: can we grant a care-scoped session key on this account type,
//    without any 7702 delegation? If yes, MetaMask users can have one-tap care.
console.log("\n[2] grantPermissions on the counterfactual account (no 7702) ...");
let context = null;
try {
  const sk = privateKeyToAccount(`0x${"33".repeat(32)}`);
  const g = await client.grantPermissions({
    account: account.address,
    expirySec: Math.floor(Date.now() / 1000) + 3600,
    key: { publicKey: sk.address, type: "secp256k1" },
    permissions: [{ type: "functions-on-contract", data: { address: PETVAULT, functions: ["0x966664bd"] } }],
  });
  context = g.context;
  console.log("    GRANT OK. context len", g.context.length);
} catch (e) {
  console.log("    GRANT FAILED:", why(e));
}

// 3. Would a care from that account even be sponsored? (It will revert on
//    NotAuthorizedCarer because the smart account owns no pet, which is the
//    EXPECTED answer: reaching a vault revert means sponsorship + validation passed.)
console.log("\n[3] does the policy sponsor a care() from this account? ...");
try {
  await client.prepareCalls({
    calls: [{ to: PETVAULT, data: "0x966664bd" + "0".repeat(63) + "1" + "0".repeat(64) }],
    account: account.address,
    capabilities: { paymaster: { policyId: GAS_POLICY_ID } },
  });
  console.log("    prepareCalls OK (sponsored, would have executed)");
} catch (e) {
  const w = why(e);
  if (/0x93c356cf/.test(w)) console.log("    reached the vault and hit NotAuthorizedCarer: sponsorship + validation PASSED (expected, it owns no pet)");
  else console.log("    ", w);
}

console.log("\nVERDICT:", context ? "external wallets CAN have session keys via requestAccount" : "session keys are 7702-only");
