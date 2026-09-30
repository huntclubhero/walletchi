// PROBE: can we arm one-tap care AT MINT TIME, without feeding the pet?
//
// The constraint: Alchemy refuses wallet_createSession for an EOA that is not yet
// EIP-7702 delegated, and the delegation only lands on the wallet's first sponsored
// op. At mint a fresh Privy wallet has none. Feeding to install it would auto-hatch
// the egg and burn the hatch moment, so we need a HARMLESS op that still delegates.
//
// This probe answers, on the real policy, with a real zero-balance wallet:
//   A. does a no-op (0 value, empty calldata, to 0x..dEaD) get SPONSORED?
//   B. if it lands, does the wallet come out delegated?
//   C. does grantPermissions then succeed with no feed having happened?
//
// Run: OWNER_PK=0x<fresh throwaway> node scripts/probe-mint-time-arm.mjs
import { createSmartWalletClient, alchemyWalletTransport } from "@alchemy/wallet-apis";
import { privateKeyToAccount } from "viem/accounts";
import { createPublicClient, http, defineChain } from "viem";

const ALCHEMY_API_KEY = process.env.ALCHEMY_API_KEY || "";
const GAS_POLICY_ID = process.env.GAS_POLICY_ID || "a98a174b-510a-40ed-b759-32f1d7b2ff2f";
const PETVAULT = "0x90349bF1461F0BADCE9b9d3486cc3Dd991E816e6";
const DEAD = "0x000000000000000000000000000000000000dEaD";
const OWNER_PK = process.env.OWNER_PK;
if (!OWNER_PK) throw new Error("OWNER_PK required (use a FRESH throwaway with no delegation)");

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
  return out.join(" | ").slice(0, 400) || String(e).slice(0, 300);
}

console.log("owner        :", owner.address);
console.log("eth balance  :", (await pub.getBalance({ address: owner.address })).toString());
console.log("code before  :", (await pub.getCode({ address: owner.address })) ?? "(none)");

const client = createSmartWalletClient({
  signer: owner,
  transport: alchemyWalletTransport({ apiKey: ALCHEMY_API_KEY }),
  chain,
  paymaster: { policyId: GAS_POLICY_ID },
});

// A: is a harmless no-op sponsored for an undelegated, zero balance wallet?
console.log("\n[A] sending a no-op (to 0x..dEaD, empty calldata, no value) ...");
let bootOk = false;
try {
  const sent = await client.sendCalls({ calls: [{ to: DEAD, data: "0x" }] });
  const id = sent.id ?? sent.preparedCallIds?.[0];
  const final = await client.waitForCallsStatus({ id });
  bootOk = final.status === "success";
  console.log("    status:", final.status, "tx:", final.receipts?.[0]?.transactionHash ?? "(none)");
} catch (e) {
  console.log("    REJECTED:", why(e));
}

// B: did it delegate?
const code = await pub.getCode({ address: owner.address });
console.log("\n[B] code after   :", code ?? "(none)");
console.log("    delegated    :", Boolean(code && code !== "0x"));

// C: can we now grant, with NO feed having happened?
console.log("\n[C] grantPermissions scoped to care() on the vault ...");
try {
  const sk = privateKeyToAccount(`0x${"22".repeat(32)}`);
  const g = await client.grantPermissions({
    account: owner.address,
    expirySec: Math.floor(Date.now() / 1000) + 3600,
    key: { publicKey: sk.address, type: "secp256k1" },
    permissions: [{ type: "functions-on-contract", data: { address: PETVAULT, functions: ["0x966664bd"] } }],
  });
  console.log("    GRANT OK, context len", g.context.length);
  console.log("\nRESULT: mint-time arming IS possible with a no-op bootstrap.");
} catch (e) {
  console.log("    GRANT FAILED:", why(e));
  console.log("\nRESULT: mint-time arming blocked at the grant step.");
}
