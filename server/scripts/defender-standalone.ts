/**
 * WALLETCHI standalone finalize poker (break-glass).
 *
 * LAST PET STANDING: the contract itself decides the winner (leader/runnerUp
 * two-slot tracker; the game is over the instant runnerUpCareAt + lifeTtl
 * passes) and finalize() is permissionless and re-verified on-chain. Nothing
 * needs "defending" anymore: this script exists only so the payout still lands
 * promptly if the main server is down when the game ends. It polls isOver()
 * from ANY machine with an RPC url and submits finalize() once true. It can
 * never steer, rush, or bias the outcome: a losing race simply reverts
 * (GameNotOver / GameOver) and the next poll re-checks.
 *
 * Usage (watch-only, no key: prints what it WOULD do):
 *   RPC_URL=https://... PETVAULT_ADDRESS=0x... npx tsx scripts/defender-standalone.ts
 *
 * Armed (can send finalize; any funded key works, it is permissionless):
 *   DEFENDER_PRIVATE_KEY=0x... RPC_URL=... PETVAULT_ADDRESS=0x... npx tsx scripts/defender-standalone.ts
 *
 * Optional env: CHAIN_ID (default 46630 testnet; mainnet 4663), POLL_SECONDS
 * (default 60).
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  createPublicClient,
  createWalletClient,
  defineChain,
  http,
  type Abi,
  type Address,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";

const RPC_URL = process.env.RPC_URL;
const VAULT = process.env.PETVAULT_ADDRESS as Address | undefined;
const KEY = process.env.DEFENDER_PRIVATE_KEY;
const CHAIN_ID = Number(process.env.CHAIN_ID ?? 46630);
const POLL_SECONDS = Number(process.env.POLL_SECONDS ?? 60);

if (!RPC_URL || !VAULT) {
  console.error("Usage: RPC_URL=... PETVAULT_ADDRESS=0x... [DEFENDER_PRIVATE_KEY=0x...] npx tsx scripts/defender-standalone.ts");
  process.exit(2);
}

// The committed real ABI (contracts/abi/PetVault.json). Loaded directly so this
// script has ZERO dependence on server config/env (no DATABASE_URL etc).
const here = dirname(fileURLToPath(import.meta.url));
const abiPath = join(here, "..", "..", "contracts", "abi", "PetVault.json");
const artifact = JSON.parse(readFileSync(abiPath, "utf8")) as unknown;
const vaultAbi: Abi = Array.isArray(artifact)
  ? (artifact as Abi)
  : (((artifact as { abi?: Abi }).abi ?? []) as Abi);
if (!Array.isArray(vaultAbi) || vaultAbi.length === 0) {
  console.error(`could not load PetVault ABI from ${abiPath}`);
  process.exit(2);
}

const chain = defineChain({
  id: CHAIN_ID,
  name: `robinhood-${CHAIN_ID}`,
  nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
  rpcUrls: { default: { http: [RPC_URL] } },
});
const pub = createPublicClient({ chain, transport: http(RPC_URL) });
const account = KEY ? privateKeyToAccount(KEY as `0x${string}`) : null;
const wallet = account ? createWalletClient({ account, chain, transport: http(RPC_URL) }) : null;

const read = <T>(functionName: string, args: unknown[] = []): Promise<T> =>
  pub.readContract({ address: VAULT!, abi: vaultAbi, functionName, args }) as Promise<T>;

async function sendFinalize(): Promise<void> {
  if (!wallet || !account) {
    console.log("WATCH-ONLY: would finalize() (pay the pot to the last pet standing)");
    return;
  }
  const { request } = await pub.simulateContract({
    address: VAULT!,
    abi: vaultAbi,
    functionName: "finalize",
    args: [],
    account,
  });
  const hash = await wallet.writeContract(request);
  const receipt = await pub.waitForTransactionReceipt({ hash });
  if (receipt.status !== "success") throw new Error(`finalize reverted: ${hash}`);
  console.log(`finalize confirmed: ${hash}`);
}

async function pass(): Promise<void> {
  const finalized = await read<boolean>("potClaimed");
  if (finalized) {
    console.log(`${new Date().toISOString()} pot already claimed; nothing to do`);
    return;
  }
  const over = await read<boolean>("isOver");
  if (!over) {
    // Show the standing for the log line: leader + when it wins if nobody feeds.
    const st = await read<[bigint, bigint, bigint, boolean]>("settlementState");
    const winsAt = Number(st[2]);
    const secsToWin = winsAt === 0 ? null : winsAt - Math.floor(Date.now() / 1000);
    console.log(
      `${new Date().toISOString()} game on; leader=${st[0]}${secsToWin === null ? "" : ` winsAt=${winsAt} (${Math.max(0, secsToWin)}s away if nobody feeds)`}`,
    );
    return;
  }
  console.log(`${new Date().toISOString()} GAME OVER on-chain; poking finalize()`);
  await sendFinalize();
}

console.log(
  `WALLETCHI standalone finalize poker: vault=${VAULT} chain=${CHAIN_ID} mode=${account ? `ARMED (${account.address})` : "WATCH-ONLY"} poll=${POLL_SECONDS}s`,
);
const loop = async (): Promise<void> => {
  try {
    await pass();
  } catch (err) {
    console.error(`pass failed: ${String(err)}`);
  }
  setTimeout(loop, POLL_SECONDS * 1000);
};
void loop();
