/**
 * GAS SPONSORSHIP WITHDRAW CHECK: the owner-withdraw rule of the webhook in runner/gas-sponsor.ts.
 *
 * The rule sponsors execute(account, 0, account.execute(CARE|USDG, 0, transfer(sender, n), 0)).
 * "account" is chosen by the caller, so it must be proven to be the pet's real ERC-6551 account.
 * A contract that merely answers token() with our Pet721 and the caller's own token id is not.
 *
 * Drives the REAL webhook handler behind the same raw-body express route as app.ts, with the chain
 * reads stubbed through the _setReadClientForTests seam (no network):
 *
 *   1. The genuine withdraw (CARE and USDG) from the pet's owner to themselves is approved.
 *   2. A contract that forges token() (own token id, our Pet721) but is not the issuer's account
 *      for that token is denied, for both tokens.
 *   3. Still denied: a non-owner on the genuine account, a payout to a third address, a token other
 *      than CARE/USDG, and an unset issuer address (fail closed).
 *   4. TOP-UP: the owner's CARE.transfer(petAccount, n) into their OWN pet is approved; into someone
 *      else's pet, a forged account, a plain address, with USDG, or for zero is denied.
 *
 * Run: npx tsx scripts/gas-withdraw-check.ts
 */
process.env.NODE_ENV ??= "test";
process.env.LOG_LEVEL ??= "silent";
process.env.DATABASE_URL ??= "postgres://gw:gw@localhost:5432/gw";
process.env.PET721_ADDRESS = "0x1111111111111111111111111111111111111111";
process.env.CARE_TOKEN_ADDRESS = "0x2222222222222222222222222222222222222222";
process.env.FEE_TOKEN_ADDRESS = "0x3333333333333333333333333333333333333333";
process.env.RUNNER_ISSUER_ADDRESS = "0x4444444444444444444444444444444444444444";
process.env.GAS_WEBHOOK_SIGNING_KEY = "";

const { config } = await import("../src/config.js");
const { gasSponsorWebhook, _setReadClientForTests } = await import("../src/runner/gas-sponsor.js");
const { default: express } = await import("express");
const { encodeFunctionData, getAddress } = await import("viem");
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

const PET721 = config.pet721Address as string;
const CARE = config.CARE_TOKEN_ADDRESS as string;
const USDG = config.FEE_TOKEN_ADDRESS as string;
const ISSUER = config.RUNNER_ISSUER_ADDRESS as string;
const ALICE = "0xaAaAaAaaAaAaAaaAaAAAAAAAAaaaAaAaAaaAaaAa";
const BOB = "0xbBbBBBBbbBBBbbbBbbBbbbbBBbBbbbbBbBbbBBbB";
const CAROL = "0xcCcCCCcCCCCcCCCcCcCCCcCcCCcCCCCcCcCCCCcC";
const ALICE_PET = 7n;
const BOB_PET = 8n;
const ACCOUNT_OF_ALICE_PET = "0x5555555555555555555555555555555555555555"; // what the issuer derives for pet 7
const ACCOUNT_OF_BOB_PET = "0x6666666666666666666666666666666666666666";
const EVIL = "0x7777777777777777777777777777777777777777"; // alice's own contract: forged token()
const OTHER_TOKEN = "0x8888888888888888888888888888888888888888";

// The stubbed chain. token() answers for the genuine account AND for the forged one: that is
// the whole point, it is reported by the target and costs the caller nothing to fake.
type ReadArgs = { address: string; functionName: string; args?: readonly unknown[] };
const reads: string[] = [];
const fakeClient = {
  async readContract(p: ReadArgs): Promise<unknown> {
    const at = getAddress(p.address);
    reads.push(`${p.functionName}@${at}`);
    if (p.functionName === "token") {
      if (at === getAddress(ACCOUNT_OF_ALICE_PET) || at === getAddress(EVIL)) return [BigInt(config.robinhood.chainId), PET721, ALICE_PET];
      if (at === getAddress(ACCOUNT_OF_BOB_PET)) return [BigInt(config.robinhood.chainId), PET721, BOB_PET];
      throw new Error("token() reverted");
    }
    if (p.functionName === "ownerOf") {
      const id = p.args?.[0];
      if (id === ALICE_PET) return ALICE;
      if (id === BOB_PET) return BOB;
      throw new Error("nonexistent token");
    }
    if (p.functionName === "accountOf") {
      if (at !== getAddress(ISSUER)) throw new Error("not the issuer");
      const id = p.args?.[0];
      if (id === ALICE_PET) return ACCOUNT_OF_ALICE_PET;
      if (id === BOB_PET) return ACCOUNT_OF_BOB_PET;
      throw new Error("unknown pet");
    }
    throw new Error(`unexpected read ${p.functionName}`);
  },
};
_setReadClientForTests(fakeClient as never);

const OUTER_ABI = [
  { type: "function", name: "execute", stateMutability: "payable", outputs: [], inputs: [{ name: "target", type: "address" }, { name: "value", type: "uint256" }, { name: "data", type: "bytes" }] },
] as const;
const ACCOUNT_ABI = [
  { type: "function", name: "execute", stateMutability: "payable", outputs: [{ type: "bytes" }], inputs: [{ name: "to", type: "address" }, { name: "value", type: "uint256" }, { name: "data", type: "bytes" }, { name: "operation", type: "uint8" }] },
] as const;
const ERC20_ABI = [
  { type: "function", name: "transfer", stateMutability: "nonpayable", outputs: [{ type: "bool" }], inputs: [{ name: "to", type: "address" }, { name: "amount", type: "uint256" }] },
] as const;

function withdrawCallData(account: string, token: string, to: string): Hex {
  const transfer = encodeFunctionData({ abi: ERC20_ABI, functionName: "transfer", args: [getAddress(to), 5n] });
  const inner = encodeFunctionData({ abi: ACCOUNT_ABI, functionName: "execute", args: [getAddress(token), 0n, transfer, 0] });
  return encodeFunctionData({ abi: OUTER_ABI, functionName: "execute", args: [getAddress(account), 0n, inner] });
}

function topUpCallData(token: string, to: string, amount = 5n): Hex {
  const transfer = encodeFunctionData({ abi: ERC20_ABI, functionName: "transfer", args: [getAddress(to), amount] });
  return encodeFunctionData({ abi: OUTER_ABI, functionName: "execute", args: [getAddress(token), 0n, transfer] });
}

const app = express();
app.post("/hook", express.raw({ type: "*/*", limit: "256kb" }), (req, res) => {
  void gasSponsorWebhook(req, res);
});
const server = app.listen(0);
await new Promise((r) => server.once("listening", r));
const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/hook`;

async function sponsored(sender: string, callData: Hex): Promise<boolean> {
  const res = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ userOperation: { sender: sender.toLowerCase(), callData }, chainId: config.robinhood.chainId }),
  });
  if (res.status !== 200) throw new Error(`webhook HTTP ${res.status}`);
  return ((await res.json()) as { approved?: boolean }).approved === true;
}

console.log("1. the genuine withdraw");
check("owner sweeps CARE from their pet account to themselves: approved", (await sponsored(ALICE, withdrawCallData(ACCOUNT_OF_ALICE_PET, CARE, ALICE))) === true);
check("owner sweeps USDG from their pet account to themselves: approved", (await sponsored(ALICE, withdrawCallData(ACCOUNT_OF_ALICE_PET, USDG, ALICE))) === true);

console.log("\n2. a target that only claims to be the pet account");
check("forged token() on the caller's own contract, CARE withdraw: denied", (await sponsored(ALICE, withdrawCallData(EVIL, CARE, ALICE))) === false);
check("forged token() on the caller's own contract, USDG withdraw: denied", (await sponsored(ALICE, withdrawCallData(EVIL, USDG, ALICE))) === false);

console.log("\n3. the other refusals still hold");
check("a non-owner on the genuine account: denied", (await sponsored(BOB, withdrawCallData(ACCOUNT_OF_ALICE_PET, CARE, BOB))) === false);
check("a payout to a third address: denied", (await sponsored(ALICE, withdrawCallData(ACCOUNT_OF_ALICE_PET, CARE, CAROL))) === false);
check("a token other than CARE or USDG: denied", (await sponsored(ALICE, withdrawCallData(ACCOUNT_OF_ALICE_PET, OTHER_TOKEN, ALICE))) === false);
const cfg = config as { RUNNER_ISSUER_ADDRESS?: string | null };
cfg.RUNNER_ISSUER_ADDRESS = null;
check("no issuer address configured, genuine withdraw: denied (fail closed)", (await sponsored(ALICE, withdrawCallData(ACCOUNT_OF_ALICE_PET, CARE, ALICE))) === false);
cfg.RUNNER_ISSUER_ADDRESS = ISSUER;

console.log("\n4. top-up: owner puts CARE back into their own pet");
check("owner sends CARE into their own pet account: approved", (await sponsored(ALICE, topUpCallData(CARE, ACCOUNT_OF_ALICE_PET))) === true);
check("owner sends CARE into someone else's pet: denied", (await sponsored(ALICE, topUpCallData(CARE, ACCOUNT_OF_BOB_PET))) === false);
check("CARE into a forged account (own contract claiming the pet): denied", (await sponsored(ALICE, topUpCallData(CARE, EVIL))) === false);
check("CARE to a plain address: denied", (await sponsored(ALICE, topUpCallData(CARE, CAROL))) === false);
check("USDG into own pet (top-up is CARE only): denied", (await sponsored(ALICE, topUpCallData(USDG, ACCOUNT_OF_ALICE_PET))) === false);
check("zero-amount top-up: denied", (await sponsored(ALICE, topUpCallData(CARE, ACCOUNT_OF_ALICE_PET, 0n))) === false);
check("a non-owner topping up a pet: denied", (await sponsored(BOB, topUpCallData(CARE, ACCOUNT_OF_ALICE_PET))) === false);
check("the stubbed chain was actually read", reads.length > 0 && reads.some((r) => r.startsWith("ownerOf")), `${reads.length} reads`);

_setReadClientForTests(null);
server.close();
console.log(`\n${passes} passed, ${failures} failed`);
process.exit(failures === 0 ? 0 : 1);
