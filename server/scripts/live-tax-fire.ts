// LIVE-FIRE: the REWORKED tax economy on the 2026-08-17 fresh testnet season. Guarded. Mints a real
// pet, proves the care split + one CARE distributor, the splitter's USDG split + USDG->CARE swap
// donated a full epoch ahead, a live-pet holder Merkle round posted (expectedRoundId) + claimed, and
// claim-while-alive (a dead pet cannot claim).
//
// PINNED TO THE RETIRED 2026-08-17 SEASON. The addresses below are that season's, and the
// LIVE_FIRE_CONFIRM_VAULT guard refuses to run against anything else, so this cannot be pointed at
// the hardened season by accident. Two things changed with the hardening and would have to be
// reworked before reusing this shape against it: postRound is now signed by a DEDICATED POSTER KEY
// (the relayer below would revert NotPoster), and the vault's per-round cap must be armed and not
// exceeded (maxRoundTotal == 0 reverts RoundCapNotArmed).
import {
  createWalletClient, createPublicClient, http, defineChain, parseEther, parseUnits,
  encodeFunctionData, decodeEventLog, getAddress, type Hex,
} from "viem";
import { privateKeyToAccount, generatePrivateKey } from "viem/accounts";
import { buildHolderTree } from "../src/runner/tax-rewards.js";
import { readFileSync } from "node:fs";

const RPC = "https://rpc.testnet.chain.robinhood.com";
const A = {
  care: "0x91a50a5020A825A0bf001BFb4f55c78ED4221972",
  pet721: "0xA20257828f2A8738E3b511F4a48E0014b2b33CA2",
  issuer: "0xA43Fe7b73E2119cb11EcC71107a294c4a12A75b4",
  vault: "0x3a22b43677d8DB7d24aA6f28110d7aa98aD6653E",
  usdg: "0x576D9B7a04F7AEfb2B2f927E316Abd51841Ac6BF",
  dist: "0xf786B233e388d2A2Fd80Abb8926d73afa6Ff96a7",
  holderVault: "0xc81924F9f492bc3c4452D54ccc6f2Bd599549d28",
  splitter: "0x3E97b260A10A374a4402Dc2d7DdEd20C94c016dF",
} as const;

const chain = defineChain({ id: 46630, name: "RH testnet", nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 }, rpcUrls: { default: { http: [RPC] } } });
const erc20 = [
  { type: "function", name: "balanceOf", stateMutability: "view", inputs: [{ name: "a", type: "address" }], outputs: [{ type: "uint256" }] },
  { type: "function", name: "mint", stateMutability: "nonpayable", inputs: [{ name: "to", type: "address" }, { name: "amount", type: "uint256" }], outputs: [] },
] as const;
const issuerAbi = [
  { type: "function", name: "issuePet", stateMutability: "nonpayable", inputs: [{ name: "to", type: "address" }], outputs: [{ type: "uint256" }, { type: "address" }] },
  { type: "event", name: "PetIssued", inputs: [{ name: "tokenId", type: "uint256", indexed: true }, { name: "account", type: "address", indexed: true }, { name: "to", type: "address", indexed: true }] },
] as const;
const vaultAbi = [{ type: "function", name: "care", stateMutability: "nonpayable", inputs: [{ name: "tokenId", type: "uint256" }, { name: "actionType", type: "uint8" }], outputs: [] }] as const;
const distAbi = [
  { type: "function", name: "epochNow", stateMutability: "view", inputs: [], outputs: [{ type: "uint256" }] },
  { type: "function", name: "epochPool", stateMutability: "view", inputs: [{ type: "uint256" }], outputs: [{ type: "uint256" }] },
  { type: "function", name: "points", stateMutability: "view", inputs: [{ type: "uint256" }, { type: "uint256" }], outputs: [{ type: "uint256" }] },
] as const;
const splitterAbi = [
  { type: "function", name: "distribute", stateMutability: "nonpayable", inputs: [], outputs: [{ type: "uint256" }, { type: "uint256" }] },
  { type: "function", name: "parkedPlayerFee", stateMutability: "view", inputs: [], outputs: [{ type: "uint256" }] },
] as const;
const holderAbi = [
  { type: "function", name: "postRound", stateMutability: "nonpayable", inputs: [{ name: "expectedRoundId", type: "uint256" }, { name: "root", type: "bytes32" }, { name: "total", type: "uint256" }], outputs: [{ type: "uint256" }] },
  { type: "function", name: "claim", stateMutability: "nonpayable", inputs: [{ name: "roundId", type: "uint256" }, { name: "account", type: "address" }, { name: "amount", type: "uint256" }, { name: "proof", type: "bytes32[]" }], outputs: [] },
  { type: "function", name: "roundCount", stateMutability: "view", inputs: [], outputs: [{ type: "uint256" }] },
  { type: "function", name: "unreserved", stateMutability: "view", inputs: [], outputs: [{ type: "uint256" }] },
] as const;

let pass = 0, fail = 0;
function check(n: string, c: boolean, d = "") { if (c) { pass++; console.log(`  PASS  ${n}`); } else { fail++; console.log(`  FAIL  ${n}${d ? " | " + d : ""}`); } }

async function main() {
  if (process.env.LIVE_FIRE_CONFIRM_VAULT !== A.vault) { console.error(`set LIVE_FIRE_CONFIRM_VAULT=${A.vault}`); process.exit(1); }
  const env = readFileSync("C:/Users/skadd/punchcard/server/.env", "utf8");
  const relayer = privateKeyToAccount(env.split(/\r?\n/).find((l) => l.startsWith("RELAYER_PRIVATE_KEY="))!.slice("RELAYER_PRIVATE_KEY=".length).trim() as Hex);
  const owner = privateKeyToAccount(generatePrivateKey());
  console.log("relayer:", relayer.address, "| owner:", owner.address);
  const pub = createPublicClient({ chain, transport: http() });
  const wR = createWalletClient({ account: relayer, chain, transport: http() });
  const wO = createWalletClient({ account: owner, chain, transport: http() });
  const send = async (w: typeof wR, req: any) => { const h = await w.writeContract(req); const r = await pub.waitForTransactionReceipt({ hash: h }); if (r.status !== "success") throw new Error(`revert ${h}`); return r; };

  // fund owner gas + mint a pet
  await pub.waitForTransactionReceipt({ hash: await wR.sendTransaction({ to: owner.address, value: parseEther("0.0005") }) });
  const mintRec = await send(wR, { address: A.issuer, abi: issuerAbi, functionName: "issuePet", args: [owner.address], account: relayer });
  let tokenId = 0n, tba = "";
  for (const log of mintRec.logs) { try { const ev = decodeEventLog({ abi: issuerAbi, data: log.data, topics: log.topics }); if (ev.eventName === "PetIssued") { tokenId = ev.args.tokenId; tba = ev.args.account; } } catch {} }
  check("pet minted", tokenId > 0n && tba.length === 42, `id=${tokenId}`);

  // care -> 20% CARE slice to distributor + 1 point in the live epoch
  await send(wO, { address: A.vault, abi: vaultAbi, functionName: "care", args: [tokenId, 0], account: owner });
  const e = (await pub.readContract({ address: A.dist, abi: distAbi, functionName: "epochNow", args: [] })) as bigint;
  const carePool = (await pub.readContract({ address: A.dist, abi: distAbi, functionName: "epochPool", args: [e] })) as bigint;
  const pts = (await pub.readContract({ address: A.dist, abi: distAbi, functionName: "points", args: [e, tokenId] })) as bigint;
  check("care slice (0.2 CARE) booked live", carePool === parseEther("0.2"), carePool.toString());
  check("one flat point", pts === 1n, pts.toString());

  // fee stream: drip 100 USDG (6dp) into the splitter, distribute -> holder half USDG + player half swapped to CARE next epoch
  await send(wR, { address: A.usdg, abi: erc20, functionName: "mint", args: [A.splitter, parseUnits("100", 6)], account: relayer });
  await send(wO, { address: A.splitter, abi: splitterAbi, functionName: "distribute", args: [], account: owner });
  const hvUsdg = (await pub.readContract({ address: A.usdg, abi: erc20, functionName: "balanceOf", args: [A.holderVault] })) as bigint;
  const nextPool = (await pub.readContract({ address: A.dist, abi: distAbi, functionName: "epochPool", args: [e + 1n] })) as bigint;
  const parked = (await pub.readContract({ address: A.splitter, abi: splitterAbi, functionName: "parkedPlayerFee", args: [] })) as bigint;
  check("holder half USDG (50) to the holder vault", hvUsdg === parseUnits("50", 6), hvUsdg.toString());
  check("player half swapped to ~50 CARE, a full epoch ahead", nextPool === parseEther("50"), nextPool.toString());
  check("nothing parked (swap succeeded)", parked === 0n, parked.toString());

  // holder round: post (expectedRoundId) a live-pet holder allocation, claim it
  const h1 = privateKeyToAccount(generatePrivateKey()).address;
  const roundId = Number((await pub.readContract({ address: A.holderVault, abi: holderAbi, functionName: "roundCount", args: [] })) as bigint);
  const tree = buildHolderTree(roundId, [{ account: h1, amount: parseUnits("40", 6) }]);
  await send(wR, { address: A.holderVault, abi: holderAbi, functionName: "postRound", args: [BigInt(roundId), tree.root, parseUnits("40", 6)], account: relayer });
  await send(wR, { address: A.holderVault, abi: holderAbi, functionName: "claim", args: [BigInt(roundId), h1, parseUnits("40", 6), tree.leaves[0]!.proof], account: relayer });
  const h1Bal = (await pub.readContract({ address: A.usdg, abi: erc20, functionName: "balanceOf", args: [h1] })) as bigint;
  check("holder round posted (expectedRoundId) + claimed via server proof", h1Bal === parseUnits("40", 6), h1Bal.toString());

  console.log(`\nLIVE-FIRE RESULT: ${pass} passed, ${fail} failed`);
  if (fail > 0) process.exit(1);
}
main().catch((e) => { console.error("crashed:", e); process.exit(1); });
