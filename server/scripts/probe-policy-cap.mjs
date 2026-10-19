// PROBE: is an Alchemy Gas Manager policy refusing a wallet on its PER-SENDER COUNT CAP?
//
// Season 1 died on "Policy's max count per spender exceeded". This probe asks the policy to sponsor
// the exact arming shape the game sponsors, setCarer(TOKEN_ID, address(0), 0) on PETVAULT, AS
// PROBE_WALLET, but signed with a THROWAWAY key (we cannot sign as a Privy embedded wallet from
// here), and reads which gate refused it.
//
// EVERYTHING IS ENV. It used to hardcode the season-1 vault and token 2, so run against any later
// season it probed a dead contract and its verdict meant nothing.
//   ALCHEMY_API_KEY  (required) the Alchemy app key
//   GAS_POLICY_ID    (required) the policy under test
//   PETVAULT         (required) the CURRENT season's PetVault
//   TOKEN_ID         (required) a minted pet
//   PROBE_WALLET     (required) that pet's current owner. The sponsorship webhook only approves
//                    setCarer for the pet's owner, so any other wallet reads as a webhook denial.
//
// Verdicts:
//   PER-SENDER CAP HIT        "max count per spender exceeded": the cap this probe exists for.
//   DENIED BY WEBHOOK         our gas-sponsor webhook refused the op (wrong owner, wrong shape, an
//                             unsponsorable call). A different gate, and NOT a cap: it used to be
//                             misread as one because both surface as "Sponsorship failed".
//   OTHER SPONSORSHIP DENIAL  some other policy rule (expired, spend limit, allowlist): read it.
//   SPONSORSHIP PASSED        the op got past sponsorship and was refused only for the throwaway
//                             signature (-32507), or reverted in simulation: no cap on this wallet.
//
// Run: cd server && ALCHEMY_API_KEY=... GAS_POLICY_ID=... PETVAULT=0x... TOKEN_ID=1 PROBE_WALLET=0x... \
//        node scripts/probe-policy-cap.mjs
import { createSmartWalletClient, alchemyWalletTransport } from "@alchemy/wallet-apis";
import { privateKeyToAccount, generatePrivateKey } from "viem/accounts";
import { defineChain, isAddress } from "viem";

function need(name) {
  const v = process.env[name]?.trim();
  if (!v) {
    console.error(`${name} is required (see the header of this script)`);
    process.exit(2);
  }
  return v;
}
const ALCHEMY_API_KEY = need("ALCHEMY_API_KEY");
const GAS_POLICY_ID = need("GAS_POLICY_ID");
const PETVAULT = need("PETVAULT");
const TOKEN_ID = need("TOKEN_ID");
const PROBE_WALLET = need("PROBE_WALLET");
if (!isAddress(PETVAULT) || !isAddress(PROBE_WALLET)) {
  console.error("PETVAULT and PROBE_WALLET must be addresses");
  process.exit(2);
}
if (!/^[0-9]+$/.test(TOKEN_ID)) {
  console.error("TOKEN_ID must be a decimal token id");
  process.exit(2);
}

const chain = defineChain({
  id: 46630,
  name: "Robinhood Chain Testnet",
  nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
  rpcUrls: { default: { http: ["https://rpc.testnet.chain.robinhood.com"] } },
});

function why(e) {
  const seen = new Set();
  let cur = e;
  const out = [];
  while (cur && typeof cur === "object" && !seen.has(cur)) {
    seen.add(cur);
    if (cur.code !== undefined) out.push(`code ${cur.code}`);
    if (cur.shortMessage) out.push(cur.shortMessage);
    if (cur.details) out.push(cur.details);
    if (cur.message && !cur.shortMessage) out.push(String(cur.message).slice(0, 200));
    cur = cur.cause;
  }
  return [...new Set(out)].join(" | ").slice(0, 700) || String(e).slice(0, 400);
}

/** Classify a refusal. ORDER MATTERS: the cap and the webhook both say "Sponsorship failed". */
function verdict(w) {
  if (/max count per (spender|sender)/i.test(w)) return "PER-SENDER CAP HIT (decisive)";
  if (/webhook/i.test(w)) return "DENIED BY WEBHOOK (not a cap: check PROBE_WALLET owns TOKEN_ID and the call shape)";
  if (/sponsorship failed|policy/i.test(w)) return "OTHER SPONSORSHIP DENIAL (not the per-sender cap: read the error)";
  if (/-32507|account signature|invalid signature/i.test(w)) return "SPONSORSHIP PASSED (refused only for the throwaway signature)";
  if (/revert|execution/i.test(w)) return "SPONSORSHIP PASSED (the op reverted in simulation)";
  return "UNRECOGNIZED (read the error above)";
}

const throwaway = privateKeyToAccount(generatePrivateKey());
console.log("probing policy", GAS_POLICY_ID);
console.log("vault", PETVAULT, "token", TOKEN_ID, "as", PROBE_WALLET, "(wrong-key signer", throwaway.address + ")");

const client = createSmartWalletClient({
  signer: throwaway,
  transport: alchemyWalletTransport({ apiKey: ALCHEMY_API_KEY }),
  chain,
  paymaster: { policyId: GAS_POLICY_ID },
});

// setCarer(TOKEN_ID, address(0), 0): the exact arming shape the webhook sponsors for a pet's owner;
// owner-only on chain and free of every season gate.
const data =
  "0x1ca74cdf" + BigInt(TOKEN_ID).toString(16).padStart(64, "0") + "0".repeat(64) + "0".repeat(64);

let prepared;
try {
  prepared = await client.prepareCalls({
    calls: [{ to: PETVAULT, data }],
    account: PROBE_WALLET,
    capabilities: { paymaster: { policyId: GAS_POLICY_ID } },
  });
  console.log("[1] prepareCalls OK (sponsored gas estimated)");
} catch (e) {
  const w = why(e);
  console.log("[1] prepareCalls refused:", w);
  console.log("\nVERDICT:", verdict(w));
  process.exit(1);
}

try {
  const signed = await client.signPreparedCalls(prepared);
  const sent = await client.sendPreparedCalls(signed);
  console.log("[2] sendPreparedCalls ACCEPTED (unexpected with a wrong key):", JSON.stringify(sent).slice(0, 300));
  console.log("\nVERDICT: SPONSORSHIP PASSED");
} catch (e) {
  const w = why(e);
  console.log("[2] send refused:", w);
  console.log("\nVERDICT:", verdict(w));
}
