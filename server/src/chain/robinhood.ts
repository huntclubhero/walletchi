import {
  createPublicClient,
  createWalletClient,
  http,
  defineChain,
  decodeEventLog,
  encodeFunctionData,
  getAddress,
  keccak256,
  parseAbiItem,
  TransactionReceiptNotFoundError,
  type Abi,
  type Hex,
  type PublicClient,
  type WalletClient,
  type Account,
  type TransactionReceipt,
} from "viem";
import { privateKeyToAccount, type PrivateKeyAccount } from "viem/accounts";
import { config } from "../config.js";
import { logger } from "../logger.js";
import { sendWithStuckTxPolicy, type StuckTxFees, type StuckTxOverrides } from "./stuck-tx.js";
import { WritePipeline, type PipelineOverrides, type SignedWrite, type WriteHandle } from "./pipeline.js";
import {
  RUNNER_ISSUER_ABI_FALLBACK,
  PET_ISSUER_ABI_FALLBACK,
  PET_VAULT_ABI_FALLBACK,
  PET721_ABI_FALLBACK,
  REWARDS_DISTRIBUTOR_ABI_FALLBACK,
  FEE_SPLITTER_ABI_FALLBACK,
  HOLDER_VAULT_ABI_FALLBACK,
  ERC20_TRANSFER_EVENT_ABI,
  ERC20_ABI,
  ERC721_ABI,
  loadAbi,
} from "./abi.js";
import type {
  Chain,
  IssueResult,
  RunnerState,
  PetVaultConfig,
  PetVaultStats,
  SeasonGate,
  PetMemorial,
  PetLifeState,
  PetNeeds,
  SettlementState,
  VaultEvent,
  LaunchpadPoolConfig,
  MintBudgetState,
  SplitterRateState,
  PreparedMint,
  MintTicket,
  PetSpendState,
} from "./types.js";
import { MintBudgetExhaustedError } from "./types.js";

// ---------------------------------------------------------------------------
// LAUNCHPAD POOL CONFIG DECODER
// ---------------------------------------------------------------------------
//
// SPLIT OUT OF THE CLASS ON PURPOSE so the decode can be exercised directly by the smoke suite
// without an RPC: the shape of this return value is exactly what the previous code got wrong.
//
// poolConfigs(bytes32) returns FIVE values. viem hands a multi-return function back as an ARRAY
// (a named-component tuple can also arrive as an object), while a single-return function comes back
// as a bare value. The old reader did getAddress(result as string) and would have THROWN on the
// array, so the seat read failed every cycle and no fee was ever claimed.
//
// Anything the configured signature does not report stays null = UNKNOWN. The inlet treats an
// unknown quote as a refusal; nothing here is allowed to invent a reassuring default.
export function decodeLaunchpadPoolConfig(result: unknown, fnName: string): LaunchpadPoolConfig {
  // uint16/uint24 come back as JS numbers from viem (integers up to 48 bits), but a different
  // decoder path can hand back a bigint, so both are accepted and anything else stays unknown.
  const num = (v: unknown): number | null =>
    typeof v === "number" ? v : typeof v === "bigint" ? Number(v) : null;
  const addr = (v: unknown): string | null =>
    typeof v === "string" && /^0x[0-9a-fA-F]{40}$/.test(v) ? getAddress(v) : null;
  const flag = (v: unknown): boolean | null => (typeof v === "boolean" ? v : null);

  // The real shape today: [creator, creatorFeeBps, feeRate, exists, quote].
  if (Array.isArray(result)) {
    const creator = addr(result[0]);
    if (!creator) {
      throw new Error(
        `${fnName} returned a ${result.length}-value tuple whose first element is not an address ` +
          `(${String(result[0]).slice(0, 40)}). LAUNCHPAD_HOOK_CREATOR_FN must name a function whose ` +
          `FIRST return value is the pool's creator seat.`,
      );
    }
    return {
      creator,
      creatorFeeBps: num(result[1]),
      feeRate: num(result[2]),
      exists: flag(result[3]),
      quote: addr(result[4]),
    };
  }
  // A struct return with named components.
  if (result && typeof result === "object") {
    const o = result as Record<string, unknown>;
    const creator = addr(o.creator);
    if (creator) {
      return {
        creator,
        creatorFeeBps: num(o.creatorFeeBps),
        feeRate: num(o.feeRate),
        exists: flag(o.exists),
        quote: addr(o.quote),
      };
    }
  }
  // TOLERATED, NOT EXPECTED: a hook whose read returns only the seat. Everything else is unknown,
  // which the inlet's quote guard then refuses to send on, so this degrades loudly instead of
  // hard-breaking on a future hook shape.
  const bare = addr(result);
  if (bare) return { creator: bare, creatorFeeBps: null, feeRate: null, exists: null, quote: null };
  throw new Error(
    `${fnName} returned a value this reader cannot turn into a pool config ` +
      `(${typeof result}: ${String(result).slice(0, 60)}). Check LAUNCHPAD_HOOK_CREATOR_FN against ` +
      `the real hook: the live one is ` +
      `"function poolConfigs(bytes32 poolId) view returns (address creator, uint16 creatorFeeBps, ` +
      `uint24 feeRate, bool exists, address quote)".`,
  );
}

// Runner issuer ABI (committed artifact wins; hand-written fallback otherwise).
const runnerIssuerAbi = loadAbi("RunnerIssuer", RUNNER_ISSUER_ABI_FALLBACK);

// WALLETCHI PetIssuer ABI (mint via issuePet). The mint auto-detects which issuer
// the configured address is, so this works alongside the retired legacy issuer.
const petIssuerAbi = loadAbi("PetIssuer", PET_ISSUER_ABI_FALLBACK);

// WALLETCHI PetVault ABI (committed artifact wins; provisional fallback otherwise).
const petVaultAbi = loadAbi("PetVault", PET_VAULT_ABI_FALLBACK);

// WALLETCHI Pet721 v2 ABI (ownerOf / isDead / royaltyInfo reads for the claim flow).
const pet721Abi = loadAbi("Pet721", PET721_ABI_FALLBACK);

// WALLETCHI CareRewardsDistributor ABI (committed artifact wins; hand-written
// fallback otherwise). Only the read + PUSH surface the server uses: season 2
// deleted claim()/claimMany() outright, so every write here is permissionless
// with contract-enforced amounts.
const rewardsAbi = loadAbi("CareRewardsDistributor", REWARDS_DISTRIBUTOR_ABI_FALLBACK);
const feeSplitterAbi = loadAbi("CareFeeSplitter", FEE_SPLITTER_ABI_FALLBACK);
const holderVaultAbi = loadAbi("HolderMerkleVault", HOLDER_VAULT_ABI_FALLBACK);

// INLINE ABIS for the reads and writes added for the testnet showcase. Deliberately NOT routed
// through loadAbi: without ABI_DIR the loader serves the hand-written fallbacks, which predate these
// functions, and a read of a function the ABI does not know THROWS. Inside seasonGate() that would
// have taken the whole mint gate down with it.
const VAULT_CLOCK_ABI = [
  { type: "function", name: "entryDeadline", stateMutability: "view", inputs: [], outputs: [{ name: "", type: "uint256" }] },
  { type: "function", name: "seasonStart", stateMutability: "view", inputs: [], outputs: [{ name: "", type: "uint256" }] },
] as const;
const ISSUER_BUDGET_ABI = [
  { type: "function", name: "mintsPerWindow", stateMutability: "view", inputs: [], outputs: [{ name: "", type: "uint256" }] },
  { type: "function", name: "mintWindowSecs", stateMutability: "view", inputs: [], outputs: [{ name: "", type: "uint256" }] },
  { type: "function", name: "mintWindowStart", stateMutability: "view", inputs: [], outputs: [{ name: "", type: "uint256" }] },
  { type: "function", name: "mintsThisWindow", stateMutability: "view", inputs: [], outputs: [{ name: "", type: "uint256" }] },
] as const;
const SPLITTER_RATE_ABI = [
  { type: "function", name: "careOutPerFeeToken1e18", stateMutability: "view", inputs: [], outputs: [{ name: "", type: "uint256" }] },
  { type: "function", name: "lastNonzeroRate", stateMutability: "view", inputs: [], outputs: [{ name: "", type: "uint256" }] },
  { type: "function", name: "swapSlippageBps", stateMutability: "view", inputs: [], outputs: [{ name: "", type: "uint256" }] },
  { type: "function", name: "rateUpdatedAt", stateMutability: "view", inputs: [], outputs: [{ name: "", type: "uint256" }] },
  { type: "function", name: "rateMaxAge", stateMutability: "view", inputs: [], outputs: [{ name: "", type: "uint256" }] },
  { type: "function", name: "owner", stateMutability: "view", inputs: [], outputs: [{ name: "", type: "address" }] },
  {
    type: "function", name: "setSwapParams", stateMutability: "nonpayable",
    inputs: [{ name: "slippageBps", type: "uint256" }, { name: "careOutPerFeeToken1e18_", type: "uint256" }],
    outputs: [],
  },
] as const;
const MOCK_FAUCET_ABI = [
  {
    type: "function", name: "mint", stateMutability: "nonpayable",
    inputs: [{ name: "to", type: "address" }, { name: "amount", type: "uint256" }], outputs: [],
  },
] as const;

/** PetIssuer.MintBudgetExhausted(). Matched by NAME (when the loaded ABI declares the error) OR by
 *  raw selector (when it does not), because the fallback ABI carries no error definitions. */
const MINT_BUDGET_EXHAUSTED_SELECTOR = "0xc112cf95";
export function isMintBudgetExhausted(err: unknown): boolean {
  const cause = err instanceof Error ? (err as { cause?: unknown }).cause : undefined;
  const msg = err instanceof Error ? `${err.message} ${String(cause ?? "")}` : String(err);
  return msg.includes("MintBudgetExhausted") || msg.toLowerCase().includes(MINT_BUDGET_EXHAUSTED_SELECTOR);
}

// Receipt cadence for every write path (the pipeline watcher and viem's waitForTransactionReceipt).
const WRITE_POLL_MS = 1_000;
// Gas margin on the mint estimate: the first mint of a budget window writes the
// window start (a cold slot), so a per-mint estimate taken one block earlier can
// be a little low. Unused gas is refunded; a revert on out-of-gas is a failed mint.
const MINT_GAS_MARGIN_NUMERATOR = 125n;
const MINT_GAS_MARGIN_DENOMINATOR = 100n;
// When the estimate itself fails: issuePet mints an ERC-721 and deploys its ERC-6551
// account, which is well under this on every deployment so far. Unused gas is refunded.
const MINT_GAS_FALLBACK = 1_500_000n;

export class RobinhoodChain implements Chain {
  readonly live = true;
  readonly chainId: number;
  readonly explorer: string;
  readonly relayerAddress: string;
  // PUBLIC address of the dedicated holder-round poster key; null when unconfigured.
  readonly holderPosterAddress: string | null;
  // PUBLIC address of the dedicated launchpad creator-fee collector key; null when unconfigured.
  readonly careFeeCollectorAddress: string | null;
  // READS THAT SERVE TRAFFIC (state, stats, ownership fan-outs). On READ_RPC_URL
  // when set, so a burst against public routes exhausts the READ endpoint's
  // budget, never the write path's (runbook STEP 8C).
  private readonly publicClient: PublicClient;
  // THE WRITE PATH'S OWN READS: pre-write simulations, nonces, fee estimates and
  // receipt polling. Always on the primary (write) RPC: a nonce MUST be read
  // from the node the tx is broadcast to, and a receipt is watched where it was
  // sent. Same object as publicClient when no READ_RPC_URL is configured.
  private readonly writePathClient: PublicClient;
  private readonly walletClient: WalletClient;
  private readonly account: PrivateKeyAccount;
  // THE RELAYER'S WRITE PIPELINE (launch fix 1): the local nonce counter and the
  // one receipt watcher every relayer-signed write goes through. See pipeline.ts
  // for the invariants. The poster and collector keys keep the old send-and-wait
  // path (submitWrite below): they write a few times a day and their callers read
  // state that must already include the previous write.
  private readonly pipeline: WritePipeline;
  // Mints this process broadcast and has not yet settled, by hash: awaitMint finds
  // its handle here. A ticket from a PREVIOUS process is not here and goes through
  // recoverMint instead.
  private readonly mintHandles = new Map<string, { handle: WriteHandle; prepared: PreparedMint }>();
  // Which issuer surface the configured address answers to, learned once from the
  // first successful simulate. The legacy RunnerIssuer is retired but its ABI is
  // still honoured, so the detection stays; it just no longer costs a round trip
  // per mint.
  private issuerVia: "issuePet" | "issueRunner" | null = null;
  // SECOND signer, for exactly one call: HolderMerkleVault.postRound. Separate account,
  // separate wallet client, so no relayer write can ever be signed by the poster key or
  // the reverse. Null when HOLDER_POSTER_PRIVATE_KEY is unset (posting stays dark).
  private readonly posterAccount: Account | null;
  private readonly posterWalletClient: WalletClient | null;
  // THIRD signer, for exactly two calls: hook.claim(poolId) and the ERC-20 transfer that forwards
  // the claimed USDG to the splitter. It is the account that HOLDS THE LAUNCHPAD CREATOR SEAT, so
  // it is deliberately not the relayer and not the poster: whoever holds the seat can reassign it
  // permanently with updateCreator, which makes a leak of this key categorically worse than a leak
  // of the mint key. Null when CARE_FEE_COLLECTOR_PRIVATE_KEY is unset (the inlet stays dark).
  private readonly collectorAccount: Account | null;
  private readonly collectorWalletClient: WalletClient | null;
  private readonly launchpadHook: Hex | null; // the letscash hook; null until configured
  private readonly launchpadPoolId: Hex | null; // our pool id (bytes32); null until configured
  private readonly runnerIssuer: Hex | null; // pet issuer; null until configured
  private readonly petVault: Hex | null; // WALLETCHI vault; null until configured
  private readonly pet721: Hex | null; // WALLETCHI Pet721 v2; null until configured
  private readonly rewards: Hex | null; // CareRewardsDistributor; null until configured
  private readonly splitter: Hex | null; // CareFeeSplitter
  private readonly holderVault: Hex | null; // HolderMerkleVault
  private readonly feeToken: Hex | null; // the fee-stream / holder-airdrop currency (USDG)

  constructor() {
    if (!config.RELAYER_PRIVATE_KEY) {
      throw new Error("RELAYER_PRIVATE_KEY required for live RobinhoodChain");
    }
    this.chainId = config.robinhood.chainId;
    this.explorer = config.robinhood.explorer;
    this.runnerIssuer = config.RUNNER_ISSUER_ADDRESS
      ? getAddress(config.RUNNER_ISSUER_ADDRESS)
      : null;
    this.petVault = config.PETVAULT_ADDRESS
      ? getAddress(config.PETVAULT_ADDRESS)
      : null;
    this.pet721 = config.pet721Address ? getAddress(config.pet721Address) : null;
    this.rewards = config.REWARDS_DISTRIBUTOR_ADDRESS
      ? getAddress(config.REWARDS_DISTRIBUTOR_ADDRESS)
      : null;
    this.splitter = config.FEE_SPLITTER_ADDRESS
      ? getAddress(config.FEE_SPLITTER_ADDRESS)
      : null;
    this.holderVault = config.HOLDER_VAULT_ADDRESS
      ? getAddress(config.HOLDER_VAULT_ADDRESS)
      : null;
    this.feeToken = config.FEE_TOKEN_ADDRESS ? getAddress(config.FEE_TOKEN_ADDRESS) : null;
    this.launchpadHook = config.LAUNCHPAD_HOOK_ADDRESS
      ? getAddress(config.LAUNCHPAD_HOOK_ADDRESS)
      : null;
    // config already validated this to 0x + 64 hex (or downgraded it to null with a loud boot
    // error), so nothing here can pass a truncated pool id to the chain.
    this.launchpadPoolId = (config.LAUNCHPAD_POOL_ID as Hex | null) ?? null;

    const chain = defineChain({
      id: config.robinhood.chainId,
      name: `Robinhood Chain ${config.ROBINHOOD_NETWORK}`,
      nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
      rpcUrls: { default: { http: [config.robinhood.rpcUrl] } },
      blockExplorers: {
        default: { name: "Blockscout", url: config.robinhood.explorer },
      },
    });

    const key = config.RELAYER_PRIVATE_KEY.startsWith("0x")
      ? (config.RELAYER_PRIVATE_KEY as Hex)
      : (`0x${config.RELAYER_PRIVATE_KEY}` as Hex);
    this.account = privateKeyToAccount(key);
    this.relayerAddress = this.account.address;
    // The chain's default http() resolves to the WRITE RPC (defineChain above),
    // which is what every wallet client and the write-path reads use. The
    // serving-read client gets the read URL explicitly; with no READ_RPC_URL the
    // two URLs are equal and one client serves both roles.
    //
    // pollingInterval 1 s (launch fix 1). viem's default is 4 s because the chain
    // definition carries no blockTime, and every receipt wait (the poster's and the
    // collector's writes still use waitForTransactionReceipt) paid that 4 s floor.
    // Robinhood Chain blocks are far shorter than that; a 1 s poll is one extra
    // cheap read per write in exchange for the receipt landing when it lands.
    this.writePathClient = createPublicClient({ chain, transport: http(), pollingInterval: WRITE_POLL_MS });
    this.publicClient =
      config.robinhood.readRpcUrl === config.robinhood.rpcUrl
        ? this.writePathClient
        : createPublicClient({ chain, transport: http(config.robinhood.readRpcUrl), pollingInterval: WRITE_POLL_MS });
    this.walletClient = createWalletClient({
      account: this.account,
      chain,
      transport: http(),
    });
    this.pipeline = new WritePipeline(
      "relayer",
      {
        pendingNonce: () =>
          this.writePathClient.getTransactionCount({ address: this.account.address, blockTag: "pending" }),
        minedNonce: () =>
          this.writePathClient.getTransactionCount({ address: this.account.address, blockTag: "latest" }),
        // A definite "no receipt" is null; anything else THROWS so the watcher never
        // mistakes an RPC blip for a replaced transaction (the verdict that fails a
        // mint and hands its inbox claim back).
        receipt: async (hash) => {
          try {
            return (await this.writePathClient.getTransactionReceipt({ hash: hash as Hex })) as unknown as { status: string };
          } catch (err) {
            if (err instanceof TransactionReceiptNotFoundError) return null;
            throw err;
          }
        },
        fees: () => this.estimateFees(),
        broadcastRaw: (raw) => this.writePathClient.sendRawTransaction({ serializedTransaction: raw as Hex }),
      },
      { waitMs: config.STUCK_TX_WAIT_MS, maxBumps: config.STUCK_TX_MAX_FEE_BUMPS, pollMs: WRITE_POLL_MS },
    );

    // THE SECOND SIGNER (mainnet blocker B2). The hardened HolderMerkleVault gates postRound on a
    // dedicated poster address, and the deploy script now REFUSES to set poster == relayer, so a
    // server with one key posts nothing: every round reverts NotPoster. This client exists solely
    // to sign that one call. It is built ONLY from HOLDER_POSTER_PRIVATE_KEY, and no other method
    // on this class may reference it, which is what makes "the relayer signs everything else"
    // structural rather than a convention someone has to remember.
    //
    // config already parsed and validated the key into an address at boot; a value that could not
    // be parsed leaves holderPosterAddress null there, so re-deriving here cannot throw and take
    // the whole chain client (mint, care reads, claims) down over a rewards-leg typo.
    const posterRaw = config.HOLDER_POSTER_PRIVATE_KEY?.trim();
    if (posterRaw && config.holderPosterAddress) {
      const posterKey = (posterRaw.startsWith("0x") ? posterRaw : `0x${posterRaw}`) as Hex;
      this.posterAccount = privateKeyToAccount(posterKey);
      this.posterWalletClient = createWalletClient({
        account: this.posterAccount,
        chain,
        transport: http(),
      });
    } else {
      this.posterAccount = null;
      this.posterWalletClient = null;
    }
    this.holderPosterAddress = this.posterAccount?.address ?? null;

    // THE THIRD SIGNER: the launchpad creator-fee COLLECTOR. Built the same way and for the same
    // structural reason as the poster above: it signs exactly two calls (hook.claim and the ERC-20
    // forward to the splitter) and no other method on this class may reference it, so "the relayer
    // signs everything else" stays a property of the code rather than a habit.
    //
    // config already derived and validated this key into an address at boot, so re-deriving here
    // cannot throw and take mint, care and claims down over a revenue-leg typo.
    const collectorRaw = config.CARE_FEE_COLLECTOR_PRIVATE_KEY?.trim();
    if (collectorRaw && config.careFeeCollectorAddress) {
      const collectorKey = (collectorRaw.startsWith("0x") ? collectorRaw : `0x${collectorRaw}`) as Hex;
      this.collectorAccount = privateKeyToAccount(collectorKey);
      this.collectorWalletClient = createWalletClient({
        account: this.collectorAccount,
        chain,
        transport: http(),
      });
    } else {
      this.collectorAccount = null;
      this.collectorWalletClient = null;
    }
    this.careFeeCollectorAddress = this.collectorAccount?.address ?? null;

    logger.info(
      {
        chainId: this.chainId,
        relayer: this.account.address,
        petIssuer: this.runnerIssuer,
        // ADDRESSES only, never keys. Logged together on purpose: "these two are the same
        // address" is the single most useful thing this line can tell an operator, because
        // that is the configuration the vault rejects.
        holderPoster: this.holderPosterAddress ?? "(none: holder round posting dark)",
        careFeeCollector: this.careFeeCollectorAddress ?? "(none: creator-fee inlet dark)",
        launchpadHook: this.launchpadHook ?? "(none: nothing claims the creator-fee stream)",
      },
      "RobinhoodChain relayer initialized (LIVE)",
    );
    // A poster key that IS the relayer key is the exact configuration the contract refuses. Say so
    // at boot instead of letting it surface as a NotPoster revert six hours later.
    if (
      this.holderPosterAddress &&
      this.holderPosterAddress.toLowerCase() === this.relayerAddress.toLowerCase()
    ) {
      logger.error(
        { relayer: this.relayerAddress, holderPoster: this.holderPosterAddress },
        "[BOOT GUARD] HOLDER_POSTER_PRIVATE_KEY resolves to the SAME address as RELAYER_PRIVATE_KEY. " +
          "The hardened vault requires a DEDICATED poster key (the deploy script refuses poster == relayer), " +
          "so holder round posting will fail. Set HOLDER_POSTER_PRIVATE_KEY to the separate poster key.",
      );
    }
    // The collector holds the launchpad creator seat, and whoever holds the seat can hand it away
    // permanently with updateCreator. Sharing that seat with the hot mint key turns a relayer leak
    // into a permanent loss of the entire trade-tax stream, so it is named at boot rather than
    // discovered afterwards. Logged (not thrown) because by the time the server boots the seat is
    // already assigned on-chain: refusing to start cannot unassign it, and the fix (updateCreator)
    // needs this process running.
    if (
      this.careFeeCollectorAddress &&
      this.careFeeCollectorAddress.toLowerCase() === this.relayerAddress.toLowerCase()
    ) {
      logger.error(
        { relayer: this.relayerAddress, careFeeCollector: this.careFeeCollectorAddress },
        "[BOOT GUARD] CARE_FEE_COLLECTOR_PRIVATE_KEY resolves to the SAME address as " +
          "RELAYER_PRIVATE_KEY. The collector holds the launchpad creator seat, so a leak of this " +
          "one hot key would cost the entire trade-tax revenue stream permanently (the thief calls " +
          "hook.updateCreator and the seat is gone). Generate a dedicated collector key and move " +
          "the seat to it with hook.updateCreator.",
      );
    }
  }

  txUrl(txHash: string): string {
    return `${this.explorer}/tx/${txHash}`;
  }
  addressUrl(address: string): string {
    return `${this.explorer}/address/${address}`;
  }

  async relayerBalanceWei(): Promise<bigint> {
    return this.publicClient.getBalance({ address: this.account.address });
  }

  // Gas balance of the DEDICATED poster wallet. A separate key means a separate gas tank that
  // nobody tops up by habit, and an unfunded poster fails every round for a reason no amount of
  // key checking would ever explain. 0n when no poster is configured.
  async holderPosterBalanceWei(): Promise<bigint> {
    if (!this.posterAccount) return 0n;
    return this.publicClient.getBalance({ address: this.posterAccount.address });
  }

  async burnedCareTotal(): Promise<bigint> {
    // The dEaD balance IS the burn ledger (proven on-chain: it matches the
    // vault's accounting to the wei). Same token resolution as decimals: the
    // vault's careToken() first, configured address as fallback.
    let token: Hex | null = config.CARE_TOKEN_ADDRESS ? getAddress(config.CARE_TOKEN_ADDRESS) : null;
    try {
      const vault = this.requirePetVault();
      token = getAddress(
        (await this.publicClient.readContract({
          address: vault,
          abi: petVaultAbi,
          functionName: "careToken",
          args: [],
        })) as string,
      );
    } catch {
      // fall back to the configured address
    }
    if (!token) return 0n;
    return (await this.publicClient.readContract({
      address: token,
      abi: ERC20_ABI,
      functionName: "balanceOf",
      args: ["0x000000000000000000000000000000000000dEaD"],
    })) as bigint;
  }

  async careBalanceOf(address: string): Promise<bigint> {
    let token: Hex | null = config.CARE_TOKEN_ADDRESS ? getAddress(config.CARE_TOKEN_ADDRESS) : null;
    try {
      const vault = this.requirePetVault();
      token = getAddress(
        (await this.publicClient.readContract({
          address: vault,
          abi: petVaultAbi,
          functionName: "careToken",
          args: [],
        })) as string,
      );
    } catch {
      // fall back to the configured address
    }
    if (!token) return 0n;
    return (await this.publicClient.readContract({
      address: token,
      abi: ERC20_ABI,
      functionName: "balanceOf",
      args: [getAddress(address)],
    })) as bigint;
  }

  // Legacy runner-era surface.

  private requireRunnerIssuer(): Hex {
    if (!this.runnerIssuer) {
      throw new Error(
        "RUNNER_ISSUER_ADDRESS not set: deploy the pet issuer and set the env to enable the WALLETCHI mint",
      );
    }
    return this.runnerIssuer;
  }

  // Fee estimate for a write: EIP-1559 when the node estimates it, legacy gasPrice otherwise.
  private async estimateFees(): Promise<StuckTxFees> {
    try {
      const f = await this.writePathClient.estimateFeesPerGas();
      if (f.maxFeePerGas !== undefined && f.maxPriorityFeePerGas !== undefined) {
        return { maxFeePerGas: f.maxFeePerGas, maxPriorityFeePerGas: f.maxPriorityFeePerGas };
      }
    } catch {
      // Node without EIP-1559 estimation: legacy gasPrice fallback below.
    }
    const gp = await this.writePathClient.getGasPrice();
    return { maxFeePerGas: gp * 2n, maxPriorityFeePerGas: gp };
  }

  // EVERY write goes through here (all three signers), and the signer decides the path.
  //
  // THE RELAYER: nonce from the pipeline's local counter, receipt from its watcher.
  // The queue task still awaits the receipt before returning (the caller's contract
  // is unchanged: "resolved means mined"), so a non-mint relayer write holds the
  // queue until it lands, exactly as before. What changed is where "stuck" is judged
  // (the pipeline's head, not this write's own clock), so a rewards push queued
  // behind two hundred unmined mints waits for them instead of fee-bumping itself
  // uselessly and failing. Mints do not come through here: they release the queue
  // right after broadcast (submitMint) and await the receipt outside it (awaitMint).
  //
  // THE POSTER AND THE COLLECTOR: unchanged send-and-wait under the stuck-tx policy.
  // Their nonce is pinned from the node's pending count, which is safe ONLY because
  // each of those accounts is serialized by its own SerialQueue and never has a
  // second send in flight.
  private async submitWrite(
    label: string,
    account: Account,
    send: (ov: StuckTxOverrides) => Promise<Hex>,
  ): Promise<TransactionReceipt> {
    if (account.address.toLowerCase() === this.account.address.toLowerCase()) {
      const viaWallet = async (ov: PipelineOverrides): Promise<SignedWrite> => ({ hash: await send(ov) });
      const handle = await this.pipeline.submit(label, viaWallet, viaWallet);
      return (await handle.receipt) as unknown as TransactionReceipt;
    }
    return (await sendWithStuckTxPolicy(
      label,
      {
        send,
        waitReceipt: async (hash, timeoutMs) =>
          (await this.writePathClient.waitForTransactionReceipt({
            hash: hash as Hex,
            timeout: timeoutMs,
          })) as unknown as { status: string },
        pendingNonce: () =>
          this.writePathClient.getTransactionCount({ address: account.address, blockTag: "pending" }),
        minedNonce: () =>
          this.writePathClient.getTransactionCount({ address: account.address, blockTag: "latest" }),
        fees: () => this.estimateFees(),
      },
      { waitMs: config.STUCK_TX_WAIT_MS, maxBumps: config.STUCK_TX_MAX_FEE_BUMPS },
    )) as unknown as TransactionReceipt;
  }

  get unminedWrites(): number {
    return this.pipeline.unmined;
  }

  // One pet, submit-and-wait: the three pipelined calls composed (scripts use this).
  async issueRunner(to: string): Promise<IssueResult> {
    const prepared = await this.prepareMint(to);
    const ticket = await this.submitMint(prepared);
    return this.awaitMint(ticket);
  }

  // ---- The pipelined mint -------------------------------------------------------
  //
  // WALLETCHI's PetIssuer uses issuePet/PetIssued; the retired RunnerIssuer used
  // issueRunner/RunnerIssued. The surface is detected by simulating the pet path
  // first (once; cached), so this works against either configured issuer.

  private mintAbi(via: "issuePet" | "issueRunner") {
    return via === "issuePet"
      ? { abi: petIssuerAbi, fnName: "issuePet" as const, eventName: "PetIssued" }
      : { abi: runnerIssuerAbi, fnName: "issueRunner" as const, eventName: "RunnerIssued" };
  }

  // NOT serialized: runs in parallel across a burst, against the latest state. The
  // simulate is what refuses a spent budget, a sold-out collection or a closed
  // roster BEFORE gas is spent; the gas estimate is per mint (the first mint of a
  // window costs more) with a margin. Neither needs the nonce.
  async prepareMint(to: string): Promise<PreparedMint> {
    const issuer = this.requireRunnerIssuer();
    const recipient = getAddress(to);
    let via = this.issuerVia;
    if (via !== "issueRunner") {
      try {
        await this.writePathClient.simulateContract({
          address: issuer, abi: petIssuerAbi, functionName: "issuePet", args: [recipient], account: this.account,
        });
        via = "issuePet";
      } catch (err) {
        // A PetIssuer refusing on its mint budget PROVES this is a PetIssuer, so the legacy
        // issueRunner fallback below would only send a transaction that certainly reverts, pay gas
        // for it, and bury the real reason under "issueRunner tx reverted". Surface it instead.
        if (isMintBudgetExhausted(err)) {
          const budget = await this.mintBudgetState().catch(() => null);
          const nowSec = Math.floor(Date.now() / 1000);
          const retryAfterSec = budget ? Math.max(0, budget.windowStart + budget.windowSecs - nowSec) : null;
          throw new MintBudgetExhaustedError(budget, retryAfterSec);
        }
        // Once we KNOW it is a PetIssuer, any other simulate failure is a real refusal
        // (sold out, roster closed, paused): surface it rather than sending a certain revert.
        if (via === "issuePet") throw err;
        via = "issueRunner";
      }
    }
    this.issuerVia = via;
    const { abi, fnName } = this.mintAbi(via);
    let gas: bigint;
    try {
      const est = await this.writePathClient.estimateContractGas({ address: issuer, abi, functionName: fnName, args: [recipient], account: this.account });
      gas = (est * MINT_GAS_MARGIN_NUMERATOR) / MINT_GAS_MARGIN_DENOMINATOR;
    } catch (err) {
      if (via === "issueRunner") {
        // The legacy surface refused too: whichever issuer this is, it will not mint.
        throw err;
      }
      logger.warn({ err: String(err), fn: fnName }, "mint gas estimate failed; using the conservative default");
      gas = MINT_GAS_FALLBACK;
    }
    return { to: recipient, via, gas };
  }

  // Sign locally, hand the ticket to the caller BEFORE broadcast, then broadcast.
  private mintSigner(prepared: PreparedMint) {
    const issuer = this.requireRunnerIssuer();
    const { abi, fnName } = this.mintAbi(prepared.via);
    const data = encodeFunctionData({ abi: abi as Abi, functionName: fnName, args: [prepared.to as Hex] });
    const sign = async (ov: PipelineOverrides): Promise<SignedWrite> => {
      const raw = await this.account.signTransaction({
        chainId: this.chainId,
        to: issuer,
        data,
        gas: prepared.gas,
        nonce: ov.nonce,
        maxFeePerGas: ov.maxFeePerGas,
        maxPriorityFeePerGas: ov.maxPriorityFeePerGas,
        type: "eip1559",
      });
      return { hash: keccak256(raw), raw };
    };
    const resend = async (ov: PipelineOverrides): Promise<SignedWrite> => {
      const signed = await sign(ov);
      await this.writePathClient.sendRawTransaction({ serializedTransaction: signed.raw as Hex });
      return signed;
    };
    return { sign, resend, fnName };
  }

  // SERIALIZED by the relayer queue. Returns the instant the bytes are on the wire.
  async submitMint(prepared: PreparedMint, onSigned?: (ticket: MintTicket) => Promise<void>): Promise<MintTicket> {
    const { sign, resend, fnName } = this.mintSigner(prepared);
    const handle = await this.pipeline.submit(
      fnName,
      sign,
      resend,
      onSigned ? (t) => onSigned({ txHash: t.hash, nonce: t.nonce }) : undefined,
    );
    // Nobody may be awaiting yet; a rejection must not surface as unhandled before awaitMint attaches.
    handle.receipt.catch(() => undefined);
    this.mintHandles.set(handle.hash, { handle, prepared });
    return { txHash: handle.hash, nonce: handle.nonce };
  }

  // NOT serialized: resolves when the ticket's nonce mines.
  async awaitMint(ticket: MintTicket): Promise<IssueResult> {
    const entry = this.mintHandles.get(ticket.txHash);
    if (!entry) {
      throw new Error(`awaitMint: ${ticket.txHash} was not submitted by this process (use recoverMint after a restart)`);
    }
    try {
      const receipt = (await entry.handle.receipt) as unknown as TransactionReceipt;
      return await this.decodeMint(receipt, entry.prepared);
    } finally {
      this.mintHandles.delete(ticket.txHash);
    }
  }

  // RESTART RECOVERY. The row persisted the hash and nonce before the broadcast, so a
  // ticket found at boot is one of: mined (settle it now), still in the mempool (watch
  // it, bump it if it becomes a stuck head), or never broadcast (a gap the counter's
  // resync will fill with the next write, after which the watcher reports the nonce
  // consumed by an unknown hash and the mint fails cleanly). The resend closure is
  // rebuilt from the row's recipient; a mint's calldata is a pure function of it.
  async recoverMint(ticket: MintTicket, to: string): Promise<IssueResult> {
    const recipient = getAddress(to);
    let prepared: PreparedMint;
    try {
      prepared = await this.prepareMint(recipient);
    } catch (err) {
      // The simulate can refuse NOW (sold out since) while the broadcast transaction is
      // already mined or queued: recovery must still settle what the node says, so fall
      // back to the pet surface with the default gas for any replacement.
      logger.warn({ err: String(err), hash: ticket.txHash }, "recoverMint: simulate refused; watching the existing transaction anyway");
      prepared = { to: recipient, via: this.issuerVia ?? "issuePet", gas: MINT_GAS_FALLBACK };
    }
    const { resend, fnName } = this.mintSigner(prepared);
    const handle = this.pipeline.attach({ label: fnName, nonce: ticket.nonce, hash: ticket.txHash }, resend, await this.estimateFees().catch(() => undefined));
    const receipt = (await handle.receipt) as unknown as TransactionReceipt;
    return this.decodeMint(receipt, prepared);
  }

  // The receipt is the source of truth for the token: the pre-send simulate ran
  // against state that did not include the mints ahead of this one, so its result
  // would name the wrong id under a burst.
  private async decodeMint(receipt: TransactionReceipt, prepared: PreparedMint): Promise<IssueResult> {
    const issuer = this.requireRunnerIssuer();
    const { abi, fnName, eventName } = this.mintAbi(prepared.via);
    if (receipt.status !== "success") {
      // A revert has no reason in the receipt. The one reason worth naming to the keeper is
      // the spent budget (the race between the pre-send simulate and mining, under a burst).
      const budget = await this.mintBudgetState().catch(() => null);
      if (budget && budget.max > 0 && budget.used >= budget.max) {
        const nowSec = Math.floor(Date.now() / 1000);
        throw new MintBudgetExhaustedError(budget, Math.max(0, budget.windowStart + budget.windowSecs - nowSec));
      }
      throw new Error(`${fnName} tx reverted: ${receipt.transactionHash}`);
    }
    let tokenId: string | null = null;
    let account: string | null = null;
    for (const log of receipt.logs) {
      try {
        const decoded = decodeEventLog({ abi, data: log.data, topics: log.topics });
        if (decoded.eventName === eventName) {
          const a = decoded.args as unknown as Record<string, unknown>;
          tokenId = String(a.tokenId);
          account = getAddress(a.account as string);
        }
      } catch {
        try {
          const t = decodeEventLog({ abi: ERC721_ABI, data: log.data, topics: log.topics });
          if (t.eventName === "Transfer" && (t.args as unknown as Record<string, unknown>).from === "0x0000000000000000000000000000000000000000") {
            tokenId = String((t.args as unknown as Record<string, unknown>).tokenId);
          }
        } catch {
          /* unrelated log */
        }
      }
    }

    const hash = receipt.transactionHash;
    if (!tokenId) throw new Error(`${fnName}: could not determine tokenId from tx ${hash}`);
    if (!account) {
      try {
        account = getAddress((await this.publicClient.readContract({ address: issuer, abi, functionName: "accountOf", args: [BigInt(tokenId)] })) as string);
      } catch {
        account = (await this.runnerState(tokenId)).tbaAddress;
      }
    }
    logger.info({ hash, tokenId, account, via: fnName }, "mint confirmed");
    return { txHash: hash, tokenId, tbaAddress: account };
  }

  async tokenAccountOf(tokenId: string): Promise<string> {
    const issuer = this.requireRunnerIssuer();
    try {
      return getAddress((await this.publicClient.readContract({ address: issuer, abi: runnerIssuerAbi, functionName: "accountOf", args: [BigInt(tokenId)] })) as string);
    } catch {
      return (await this.runnerState(tokenId)).tbaAddress;
    }
  }

  async runnerState(tokenId: string): Promise<RunnerState> {
    const issuer = this.requireRunnerIssuer();
    const res = (await this.publicClient.readContract({
      address: issuer,
      abi: runnerIssuerAbi,
      functionName: "runnerState",
      args: [BigInt(tokenId)],
    })) as [string, bigint, bigint, bigint];
    return {
      tbaAddress: getAddress(res[0]),
      bestScore: Number(res[1]),
      totalSalmon: Number(res[2]),
      totalRuns: Number(res[3]),
    };
  }

  // WALLETCHI PetVault (survival economy). Redesign-STABLE surface only.

  private requirePetVault(): Hex {
    if (!this.petVault) {
      throw new Error(
        "PETVAULT_ADDRESS not set: the survival season is not deployed yet (set SURVIVAL_ENABLED + PETVAULT_ADDRESS)",
      );
    }
    return this.petVault;
  }

  // NOTE: there is no careForPet write anymore. care() is OWNER-ONLY on-chain
  // (the vault rejects the relayer); owners sign it from the web care page and
  // the server folds it back into the DB via petState/memorialState READS.

  // Death is a pure read in the last-pet-standing model: petState().dead flips
  // the instant lastCareAt + lifeTtl <= now. There is no reap write.
  async petState(tokenId: string): Promise<PetLifeState> {
    const vault = this.requirePetVault();
    const res = (await this.publicClient.readContract({
      address: vault,
      abi: petVaultAbi,
      functionName: "petState",
      args: [BigInt(tokenId)],
    })) as [boolean, boolean, bigint, boolean, bigint];
    return {
      registered: Boolean(res[0]),
      dead: Boolean(res[1]),
      lastCareAt: Number(res[2]),
      isAlive: Boolean(res[3]),
      secondsLeft: Number(res[4]),
    };
  }

  // The five raw need stamps (needsOf), index = canonical actionType. One read;
  // all zeros for a dormant egg AND an unregistered id (callers gate on
  // petState().registered), frozen stamps for a dead pet (gate display on alive).
  async petNeeds(tokenId: string): Promise<PetNeeds> {
    const vault = this.requirePetVault();
    const res = (await this.publicClient.readContract({
      address: vault,
      abi: petVaultAbi,
      functionName: "needsOf",
      args: [BigInt(tokenId)],
    })) as readonly bigint[];
    return {
      needAt: [
        Number(res[0] ?? 0n),
        Number(res[1] ?? 0n),
        Number(res[2] ?? 0n),
        Number(res[3] ?? 0n),
        Number(res[4] ?? 0n),
      ],
    };
  }

  async petSpendState(account: string): Promise<PetSpendState | null> {
    const abi = [
      { type: "function", name: "dailyCap", stateMutability: "view", inputs: [], outputs: [{ name: "", type: "uint256" }] },
      { type: "function", name: "windowStart", stateMutability: "view", inputs: [], outputs: [{ name: "", type: "uint256" }] },
      { type: "function", name: "spentInWindow", stateMutability: "view", inputs: [], outputs: [{ name: "", type: "uint256" }] },
    ] as const;
    try {
      const address = account as `0x${string}`;
      const [dailyCap, windowStart, spentInWindow] = await Promise.all([
        this.publicClient.readContract({ address, abi, functionName: "dailyCap" }),
        this.publicClient.readContract({ address, abi, functionName: "windowStart" }),
        this.publicClient.readContract({ address, abi, functionName: "spentInWindow" }),
      ]);
      return { dailyCap: dailyCap as bigint, windowStart: Number(windowStart as bigint), spentInWindow: spentInWindow as bigint };
    } catch {
      return null;
    }
  }

  async petVaultConfig(): Promise<PetVaultConfig> {
    const vault = this.requirePetVault();
    const [careCostRaw, lifeTtl, careCooldown] = (await Promise.all([
      this.publicClient.readContract({ address: vault, abi: petVaultAbi, functionName: "careCost", args: [] }),
      this.publicClient.readContract({ address: vault, abi: petVaultAbi, functionName: "lifeTtl", args: [] }),
      this.publicClient.readContract({ address: vault, abi: petVaultAbi, functionName: "careCooldown", args: [] }),
    ])) as [bigint, bigint, bigint];
    return { careCostRaw, lifeTtlSeconds: Number(lifeTtl), careCooldownSeconds: Number(careCooldown) };
  }

  // No on-chain aliveCount exists anymore: the "N alive" scoreboard is computed
  // OFF-CHAIN from timers over the server's known pets (display-only).
  async petVaultStats(): Promise<PetVaultStats> {
    const vault = this.requirePetVault();
    const [potRaw, registered, hatched, lifeTtl] = (await Promise.all([
      this.publicClient.readContract({ address: vault, abi: petVaultAbi, functionName: "pot", args: [] }),
      this.publicClient.readContract({ address: vault, abi: petVaultAbi, functionName: "registeredCount", args: [] }),
      this.publicClient.readContract({ address: vault, abi: petVaultAbi, functionName: "hatchedCount", args: [] }),
      this.publicClient.readContract({ address: vault, abi: petVaultAbi, functionName: "lifeTtl", args: [] }),
    ])) as [bigint, bigint, bigint, bigint];
    return {
      potRaw,
      registeredCount: Number(registered),
      hatchedCount: Number(hatched),
      lifeTtlSeconds: Number(lifeTtl),
    };
  }

  async seasonGate(): Promise<SeasonGate> {
    const vault = this.requirePetVault();
    const pet721 = this.requirePet721();
    const [sellout, startedAt, entryOpen, minted, maxSupply] = (await Promise.all([
      this.publicClient.readContract({ address: vault, abi: petVaultAbi, functionName: "selloutStartsSeason", args: [] }),
      this.publicClient.readContract({ address: vault, abi: petVaultAbi, functionName: "seasonStartedAt", args: [] }),
      this.publicClient.readContract({ address: vault, abi: petVaultAbi, functionName: "entryOpen", args: [] }),
      this.publicClient.readContract({ address: pet721, abi: pet721Abi, functionName: "totalMinted", args: [] }),
      this.publicClient.readContract({ address: pet721, abi: pet721Abi, functionName: "maxSupply", args: [] }),
    ])) as [boolean, bigint, boolean, bigint, bigint];
    // BEST EFFORT, and separate from the reads above on purpose: these two are display facts ("mint
    // open until <date>"), while the five above gate every mint. A vault that cannot answer them
    // must cost the site a date, never the mint gate.
    const [deadline, start] = await Promise.all([
      this.publicClient
        .readContract({ address: vault, abi: VAULT_CLOCK_ABI, functionName: "entryDeadline", args: [] })
        .then((v) => Number(v))
        .catch(() => null),
      this.publicClient
        .readContract({ address: vault, abi: VAULT_CLOCK_ABI, functionName: "seasonStart", args: [] })
        .then((v) => Number(v))
        .catch(() => null),
    ]);
    return {
      selloutStartsSeason: Boolean(sellout),
      startedAt: Number(startedAt),
      entryOpen: Boolean(entryOpen),
      minted: Number(minted),
      maxSupply: Number(maxSupply),
      // Under the sellout model the roster closes on the sellout and entryDeadline governs nothing,
      // so publishing it would put a meaningless date on the site.
      entryDeadline: sellout ? null : deadline,
      seasonStart: start,
    };
  }

  async mintBudgetState(): Promise<MintBudgetState> {
    const issuer = this.requireRunnerIssuer();
    const read = (functionName: "mintsPerWindow" | "mintWindowSecs" | "mintWindowStart" | "mintsThisWindow") =>
      this.publicClient.readContract({ address: issuer, abi: ISSUER_BUDGET_ABI, functionName, args: [] });
    const [max, windowSecs, windowStart, used] = (await Promise.all([
      read("mintsPerWindow"),
      read("mintWindowSecs"),
      read("mintWindowStart"),
      read("mintsThisWindow"),
    ])) as [bigint, bigint, bigint, bigint];
    return {
      max: Number(max),
      windowSecs: Number(windowSecs),
      windowStart: Number(windowStart),
      used: Number(used),
    };
  }

  async startSeason(): Promise<{ txHash: string }> {
    const vault = this.requirePetVault();
    const receipt = await this.submitWrite("startSeason", this.account, (ov) =>
      this.walletClient.writeContract({
        address: vault, abi: petVaultAbi, functionName: "startSeason", args: [],
        account: this.account, chain: this.walletClient.chain, ...ov,
      }),
    );
    if (receipt.status !== "success") throw new Error(`startSeason reverted: ${receipt.transactionHash}`);
    logger.info({ hash: receipt.transactionHash }, "season STARTED: roster closed, every pet's clock begins now");
    return { txHash: receipt.transactionHash };
  }

  async petAlive(tokenId: string): Promise<boolean> {
    const vault = this.requirePetVault();
    return (await this.publicClient.readContract({
      address: vault,
      abi: petVaultAbi,
      functionName: "alive",
      args: [BigInt(tokenId)],
    })) as boolean;
  }

  async petMemorial(tokenId: string): Promise<PetMemorial> {
    const vault = this.requirePetVault();
    const res = (await this.publicClient.readContract({
      address: vault,
      abi: petVaultAbi,
      functionName: "memorialState",
      args: [BigInt(tokenId)],
    })) as [boolean, bigint, bigint, number, number];
    return {
      dead: Boolean(res[0]),
      bornAt: Number(res[1]),
      diedAt: Number(res[2]),
      careCount: Number(res[3]),
      rank: Number(res[4]),
    };
  }

  async careTokenDecimals(): Promise<number> {
    // Prefer the vault's own careToken() so we read the exact token in play; fall
    // back to CARE_TOKEN_ADDRESS. Never hardcode: mainnet Pons decimals are unknown.
    let token: Hex | null = config.CARE_TOKEN_ADDRESS
      ? getAddress(config.CARE_TOKEN_ADDRESS)
      : null;
    try {
      const vault = this.requirePetVault();
      token = getAddress(
        (await this.publicClient.readContract({
          address: vault,
          abi: petVaultAbi,
          functionName: "careToken",
          args: [],
        })) as string,
      );
    } catch {
      // fall back to the configured address
    }
    if (!token) return config.CARE_TOKEN_DECIMALS;
    const d = (await this.publicClient.readContract({
      address: token,
      abi: ERC20_ABI,
      functionName: "decimals",
      args: [],
    })) as number;
    return Number(d);
  }

  // Pet721 v2 ownership + soulbound reads (secondary-market claim).

  private requirePet721(): Hex {
    if (!this.pet721) {
      throw new Error(
        "PET721_ADDRESS not set: the pet NFT contract address is required for ownership reads (claim)",
      );
    }
    return this.pet721;
  }

  async petOwnerOf(tokenId: string): Promise<string> {
    const pet721 = this.requirePet721();
    return getAddress(
      (await this.publicClient.readContract({
        address: pet721,
        abi: pet721Abi,
        functionName: "ownerOf",
        args: [BigInt(tokenId)],
      })) as string,
    );
  }

  async petOwnersOf(tokenIds: string[]): Promise<(string | null)[]> {
    // Chunked parallel reads (no multicall3 assumption on RH Chain). Supply is
    // capped at 2,000 and claim-time resolution touches only known-minted ids.
    const CHUNK = 25;
    const out: (string | null)[] = [];
    for (let i = 0; i < tokenIds.length; i += CHUNK) {
      const chunk = tokenIds.slice(i, i + CHUNK);
      const owners = await Promise.all(
        chunk.map((id) => this.petOwnerOf(id).catch(() => null)),
      );
      out.push(...owners);
    }
    return out;
  }

  async petIsDead(tokenId: string): Promise<boolean> {
    const pet721 = this.requirePet721();
    return (await this.publicClient.readContract({
      address: pet721,
      abi: pet721Abi,
      functionName: "isDead",
      args: [BigInt(tokenId)],
    })) as boolean;
  }

  // ERC-1271 fallback for a smart-contract account: viem's verifyMessage is
  // 1271-aware (and 6492-aware), so it validates a contract-account signature
  // over the same EIP-191 personal_sign message the EOA path uses. Only called
  // after EOA recovery already failed to match the claimed owner, so a true here
  // means the claimed contract account itself attests the signature.
  async isValidErc1271Signature(
    address: string,
    message: string,
    signature: string,
  ): Promise<boolean> {
    try {
      return await this.publicClient.verifyMessage({
        address: getAddress(address),
        message,
        signature: signature as `0x${string}`,
      });
    } catch {
      return false;
    }
  }

  // Settlement (last pet standing). finalize() is the only settlement write:
  // permissionless, re-verified on-chain, pays the whole pot to the leader's
  // TBA. The server pokes it when isOver() flips true; the contract is the
  // judge (GameNotOver / NotEnoughPlayers / GameOver reverts are benign races).
  async finalizeSeason(): Promise<{ txHash: string }> {
    const vault = this.requirePetVault();
    const receipt = await this.submitWrite("finalize", this.account, (ov) =>
      this.walletClient.writeContract({
        address: vault, abi: petVaultAbi, functionName: "finalize",
        args: [], account: this.account, chain: this.walletClient.chain, ...ov,
      }),
    );
    if (receipt.status !== "success") throw new Error(`finalize tx reverted: ${receipt.transactionHash}`);
    logger.info({ hash: receipt.transactionHash }, "finalize confirmed");
    return { txHash: receipt.transactionHash };
  }

  async settlementState(): Promise<SettlementState> {
    const vault = this.requirePetVault();
    const res = (await this.publicClient.readContract({
      address: vault, abi: petVaultAbi, functionName: "settlementState", args: [],
    })) as [bigint, bigint, bigint, boolean];
    return {
      candidate: String(res[0]),
      candidateLastCareAt: Number(res[1]),
      winsAt: Number(res[2]),
      finalized: Boolean(res[3]),
    };
  }

  async isOver(): Promise<boolean> {
    const vault = this.requirePetVault();
    return (await this.publicClient.readContract({
      address: vault, abi: petVaultAbi, functionName: "isOver", args: [],
    })) as boolean;
  }

  async leader(): Promise<string> {
    const vault = this.requirePetVault();
    return String(
      (await this.publicClient.readContract({
        address: vault, abi: petVaultAbi, functionName: "leader", args: [],
      })) as bigint,
    );
  }

  // WALLETCHI player rewards (CareRewardsDistributor). Address gated: every method
  // throws a clear error when the distributor is unconfigured, and the config
  // `rewardsLive` gate keeps callers away until it is deployed and wired.
  //
  // SEASON 2, NO CLAIMS: the writes below are PERMISSIONLESS and their amounts and
  // destinations are contract-enforced, so the relayer signing them buys the
  // player gasless delivery and buys us no authority at all.
  private requireRewards(): Hex {
    if (!this.rewards) {
      throw new Error(
        "REWARDS_DISTRIBUTOR_ADDRESS not set: the v3 rewards distributor is not deployed yet",
      );
    }
    return this.rewards;
  }

  async rewardsEpochNow(): Promise<number> {
    const dist = this.requireRewards();
    return Number(
      (await this.publicClient.readContract({
        address: dist, abi: rewardsAbi, functionName: "epochNow", args: [],
      })) as bigint,
    );
  }

  async rewardsPending(tokenId: string, epoch: number): Promise<bigint> {
    const dist = this.requireRewards();
    return (await this.publicClient.readContract({
      address: dist, abi: rewardsAbi, functionName: "pendingReward",
      args: [BigInt(epoch), BigInt(tokenId)],
    })) as bigint;
  }

  async rewardsClaimed(tokenId: string, epoch: number): Promise<boolean> {
    const dist = this.requireRewards();
    return (await this.publicClient.readContract({
      address: dist, abi: rewardsAbi, functionName: "claimed",
      args: [BigInt(epoch), BigInt(tokenId)],
    })) as boolean;
  }

  async rewardsPoints(tokenId: string, epoch: number): Promise<bigint> {
    const dist = this.requireRewards();
    return (await this.publicClient.readContract({
      address: dist, abi: rewardsAbi, functionName: "points",
      args: [BigInt(epoch), BigInt(tokenId)],
    })) as bigint;
  }

  async rewardsResidualSwept(): Promise<boolean> {
    const dist = this.requireRewards();
    return (await this.publicClient.readContract({
      address: dist, abi: rewardsAbi, functionName: "residualSwept", args: [],
    })) as boolean;
  }

  // PUSH one finished epoch to a batch of pets. ONE transaction per epoch: the
  // on-chain loop skips (never reverts on) an already-paid, point-less or dead
  // pet, so the caller does not have to pre-clean the list to protect the rest of
  // the batch. Only a batch-level problem reverts, and every one of those is a
  // reason not to retry the same call blind (the season is settled, the epoch has
  // not finished, or nobody earned a point in it), so the error propagates.
  async rewardsPushMany(epoch: number, tokenIds: string[]): Promise<{ txHash: string }> {
    const dist = this.requireRewards();
    const ids = tokenIds.map((t) => BigInt(t));
    const receipt = await this.submitWrite("pushRewards", this.account, (ov) =>
      this.walletClient.writeContract({
        address: dist, abi: rewardsAbi, functionName: "pushRewards",
        args: [BigInt(epoch), ids],
        account: this.account, chain: this.walletClient.chain, ...ov,
      }),
    );
    if (receipt.status !== "success") throw new Error(`pushRewards tx reverted: ${receipt.transactionHash}`);
    logger.info({ hash: receipt.transactionHash, epoch, pets: ids.length }, "rewards push confirmed");
    return { txHash: receipt.transactionHash };
  }

  // Forfeit dead pets' unclaimed shares into a future epoch's pool. ONE live pet
  // in the list reverts the WHOLE call (PetIsAlive), so the caller filters on the
  // vault's death read before it gets here.
  async rewardsSweepForfeited(epoch: number, tokenIds: string[]): Promise<{ txHash: string }> {
    const dist = this.requireRewards();
    const ids = tokenIds.map((t) => BigInt(t));
    const receipt = await this.submitWrite("sweepForfeited", this.account, (ov) =>
      this.walletClient.writeContract({
        address: dist, abi: rewardsAbi, functionName: "sweepForfeited",
        args: [BigInt(epoch), ids],
        account: this.account, chain: this.walletClient.chain, ...ov,
      }),
    );
    if (receipt.status !== "success") throw new Error(`sweepForfeited tx reverted: ${receipt.transactionHash}`);
    logger.info({ hash: receipt.transactionHash, epoch, pets: ids.length }, "forfeit sweep confirmed");
    return { txHash: receipt.transactionHash };
  }

  async rewardsSweepResidual(): Promise<{ txHash: string }> {
    const dist = this.requireRewards();
    const receipt = await this.submitWrite("sweepResidualToWinner", this.account, (ov) =>
      this.walletClient.writeContract({
        address: dist, abi: rewardsAbi, functionName: "sweepResidualToWinner", args: [],
        account: this.account, chain: this.walletClient.chain, ...ov,
      }),
    );
    if (receipt.status !== "success") throw new Error(`sweepResidualToWinner tx reverted: ${receipt.transactionHash}`);
    logger.info({ hash: receipt.transactionHash }, "rewards residual swept to the champion");
    return { txHash: receipt.transactionHash };
  }

  // ESCROW AND RE-PUSH: what finalize() could not deliver to the winner's TBA.
  async vaultUnpaidPrize(tokenId: string): Promise<bigint> {
    const vault = this.requirePetVault();
    return (await this.publicClient.readContract({
      address: vault, abi: petVaultAbi, functionName: "unpaidPrize", args: [BigInt(tokenId)],
    })) as bigint;
  }

  // The permissionless prize retry. The destination is NOT an argument: the vault
  // pays the winning pet's own TBA, so this call cannot be aimed anywhere.
  async vaultPushPrize(tokenId: string): Promise<{ txHash: string }> {
    const vault = this.requirePetVault();
    const receipt = await this.submitWrite("pushPrize", this.account, (ov) =>
      this.walletClient.writeContract({
        address: vault, abi: petVaultAbi, functionName: "pushPrize", args: [BigInt(tokenId)],
        account: this.account, chain: this.walletClient.chain, ...ov,
      }),
    );
    if (receipt.status !== "success") throw new Error(`pushPrize tx reverted: ${receipt.transactionHash}`);
    logger.info({ hash: receipt.transactionHash, tokenId }, "escrowed prize pushed to the winner's TBA");
    return { txHash: receipt.transactionHash };
  }

  // --- TAX ECONOMY (2026-08-17): splitter + holder vault (USDG airdrops) ---
  // Same address-gating discipline as the CARE distributor: every method throws a
  // clear error when unconfigured, and config.modes.holderRewardsLive keeps callers away.

  private requireSplitter(): Hex {
    if (!this.splitter) {
      throw new Error("FEE_SPLITTER_ADDRESS not set: the CareFeeSplitter is not deployed yet");
    }
    return this.splitter;
  }

  private requireHolderVault(): Hex {
    if (!this.holderVault) {
      throw new Error("HOLDER_VAULT_ADDRESS not set: the HolderMerkleVault is not deployed yet");
    }
    return this.holderVault;
  }

  async splitterBalance(): Promise<bigint> {
    const splitter = this.requireSplitter();
    if (!this.feeToken) throw new Error("FEE_TOKEN_ADDRESS not set");
    return (await this.publicClient.readContract({
      address: this.feeToken, abi: ERC20_ABI, functionName: "balanceOf", args: [splitter],
    })) as bigint;
  }

  async splitterDistribute(): Promise<{ txHash: string }> {
    const splitter = this.requireSplitter();
    const receipt = await this.submitWrite("splitterDistribute", this.account, (ov) =>
      this.walletClient.writeContract({
        address: splitter, abi: feeSplitterAbi, functionName: "distribute", args: [],
        account: this.account, chain: this.walletClient.chain, ...ov,
      }),
    );
    if (receipt.status !== "success") throw new Error(`splitter distribute reverted: ${receipt.transactionHash}`);
    return { txHash: receipt.transactionHash };
  }

  async showcaseMintFeeToSplitter(amount: bigint): Promise<{ txHash: string }> {
    const splitter = this.requireSplitter();
    if (!this.feeToken) throw new Error("FEE_TOKEN_ADDRESS not set");
    const feeToken = this.feeToken;
    const receipt = await this.submitWrite("showcaseMintFeeToSplitter", this.account, (ov) =>
      this.walletClient.writeContract({
        address: feeToken, abi: MOCK_FAUCET_ABI, functionName: "mint", args: [splitter, amount],
        account: this.account, chain: this.walletClient.chain, ...ov,
      }),
    );
    if (receipt.status !== "success") throw new Error(`showcase fee mint reverted: ${receipt.transactionHash}`);
    return { txHash: receipt.transactionHash };
  }

  async splitterRateState(): Promise<SplitterRateState> {
    const splitter = this.requireSplitter();
    const read = (
      functionName: "careOutPerFeeToken1e18" | "lastNonzeroRate" | "swapSlippageBps" | "rateUpdatedAt" | "rateMaxAge" | "owner",
    ) => this.publicClient.readContract({ address: splitter, abi: SPLITTER_RATE_ABI, functionName, args: [] });
    const [rate, lastNonzeroRate, slippageBps, updatedAt, maxAge, owner] = (await Promise.all([
      read("careOutPerFeeToken1e18"),
      read("lastNonzeroRate"),
      read("swapSlippageBps"),
      read("rateUpdatedAt"),
      read("rateMaxAge"),
      read("owner"),
    ])) as [bigint, bigint, bigint, bigint, bigint, string];
    return {
      rate,
      lastNonzeroRate,
      slippageBps: Number(slippageBps),
      updatedAt: Number(updatedAt),
      maxAge: Number(maxAge),
      owner: getAddress(owner),
    };
  }

  async splitterReaffirmRate(slippageBps: number, rate: bigint): Promise<{ txHash: string }> {
    const splitter = this.requireSplitter();
    const receipt = await this.submitWrite("splitterReaffirmRate", this.account, (ov) =>
      this.walletClient.writeContract({
        address: splitter, abi: SPLITTER_RATE_ABI, functionName: "setSwapParams",
        args: [BigInt(slippageBps), rate],
        account: this.account, chain: this.walletClient.chain, ...ov,
      }),
    );
    if (receipt.status !== "success") throw new Error(`splitter rate re-affirm reverted: ${receipt.transactionHash}`);
    return { txHash: receipt.transactionHash };
  }

  async holderRoundCount(): Promise<number> {
    const hv = this.requireHolderVault();
    return Number(
      (await this.publicClient.readContract({
        address: hv, abi: holderVaultAbi, functionName: "roundCount", args: [],
      })) as bigint,
    );
  }

  async holderUnreserved(): Promise<bigint> {
    const hv = this.requireHolderVault();
    return (await this.publicClient.readContract({
      address: hv, abi: holderVaultAbi, functionName: "unreserved", args: [],
    })) as bigint;
  }

  // The vault's CURRENT poster. Read (not assumed) so a rotation on-chain shows up as a
  // mismatch we can report, rather than as a NotPoster revert nobody sees.
  async holderPoster(): Promise<string> {
    const hv = this.requireHolderVault();
    return getAddress(
      (await this.publicClient.readContract({
        address: hv, abi: holderVaultAbi, functionName: "poster", args: [],
      })) as string,
    );
  }

  // Per-round ceiling. FAIL CLOSED on-chain: 0 blocks every round (RoundCapNotArmed).
  async holderMaxRoundTotal(): Promise<bigint> {
    const hv = this.requireHolderVault();
    return (await this.publicClient.readContract({
      address: hv, abi: holderVaultAbi, functionName: "maxRoundTotal", args: [],
    })) as bigint;
  }

  // Owner emergency stop; postRound reverts PostingIsPaused while true.
  async holderPostingPaused(): Promise<boolean> {
    const hv = this.requireHolderVault();
    return (await this.publicClient.readContract({
      address: hv, abi: holderVaultAbi, functionName: "postingPaused", args: [],
    })) as boolean;
  }

  // THE ONE POSTER-SIGNED WRITE. Signed by posterWalletClient / posterAccount, never by the
  // relayer: the vault checks msg.sender != poster and reverts NotPoster, and the deploy script
  // guarantees those two keys differ. Everything else on this class keeps using this.walletClient.
  async holderPostRound(expectedRoundId: number, root: string, total: bigint): Promise<{ txHash: string }> {
    const hv = this.requireHolderVault();
    // Fail with a sentence an operator can act on. Signing this with the relayer as a "fallback"
    // would be strictly worse: a guaranteed revert that still costs gas and still posts nothing.
    if (!this.posterWalletClient || !this.posterAccount) {
      throw new Error(
        "HOLDER_POSTER_PRIVATE_KEY not set: HolderMerkleVault.postRound is gated on a DEDICATED " +
          "poster key (never the relayer), so no holder airdrop round can be posted. Set it in the " +
          "environment to the poster key for this deployment.",
      );
    }
    const posterClient = this.posterWalletClient;
    const posterAccount = this.posterAccount;
    const receipt = await this.submitWrite("holderPostRound", posterAccount, (ov) =>
      posterClient.writeContract({
        address: hv, abi: holderVaultAbi, functionName: "postRound",
        args: [BigInt(expectedRoundId), root as Hex, total],
        account: posterAccount, chain: posterClient.chain, ...ov,
      }),
    );
    if (receipt.status !== "success") throw new Error(`holder postRound reverted: ${receipt.transactionHash}`);
    logger.info(
      { hash: receipt.transactionHash, roundId: expectedRoundId, poster: posterAccount.address },
      "holder round posted (poster-signed)",
    );
    return { txHash: receipt.transactionHash };
  }

  async holderClaimed(roundId: number, account: string): Promise<boolean> {
    const hv = this.requireHolderVault();
    return (await this.publicClient.readContract({
      address: hv, abi: holderVaultAbi, functionName: "claimed",
      args: [BigInt(roundId), getAddress(account)],
    })) as boolean;
  }

  async holderClaim(
    roundId: number,
    account: string,
    amount: bigint,
    proof: string[],
  ): Promise<{ txHash: string }> {
    const hv = this.requireHolderVault();
    // claim() is permissionless and pays the leaf's account whoever sends it, so the signer only
    // decides whose queue and gas carry the burst (config.HOLDER_CLAIM_SIGNER). MUST match the queue
    // Relayer.holderClaim picks, because each signer's nonce is pinned by exactly one serial queue.
    const viaPoster = config.HOLDER_CLAIM_SIGNER === "poster" && this.posterWalletClient && this.posterAccount;
    const client = viaPoster ? this.posterWalletClient! : this.walletClient;
    const signer = viaPoster ? this.posterAccount! : this.account;
    const receipt = await this.submitWrite("holderClaim", signer, (ov) =>
      client.writeContract({
        address: hv, abi: holderVaultAbi, functionName: "claim",
        args: [BigInt(roundId), getAddress(account), amount, proof as Hex[]],
        account: signer, chain: client.chain, ...ov,
      }),
    );
    if (receipt.status !== "success") throw new Error(`holder claim reverted: ${receipt.transactionHash}`);
    return { txHash: receipt.transactionHash };
  }

  // --- LAUNCHPAD CREATOR-FEE INLET: claim the seat, forward to the splitter ---
  //
  // THE HOOK ABI IS NOT PUBLISHED, so the two signatures live in the environment
  // (LAUNCHPAD_HOOK_CREATOR_FN / LAUNCHPAD_HOOK_CLAIM_FN) and are parsed here. Hardcoding a guessed
  // signature would be the same class of mistake as pointing the creator seat at a contract that
  // cannot claim: it looks configured, and it silently cannot work. Parsed per call rather than at
  // import time so a malformed signature surfaces as ONE named error from the job (which then
  // skips) instead of throwing during module load and taking the whole server down.

  private requireLaunchpad(): { hook: Hex; poolId: Hex } {
    if (!this.launchpadHook) {
      throw new Error(
        "LAUNCHPAD_HOOK_ADDRESS not set: nothing can claim the launchpad creator-fee stream. " +
          "Capture the hook address from our own launch transaction receipt.",
      );
    }
    if (!this.launchpadPoolId) {
      throw new Error(
        "LAUNCHPAD_POOL_ID not set (or not a 32-byte hex value): the inlet does not know which " +
          "pool to claim for. Capture the pool id from our own launch transaction receipt.",
      );
    }
    return { hook: this.launchpadHook, poolId: this.launchpadPoolId };
  }

  /// Parse one human-readable signature from the environment into an ABI viem can use.
  private hookAbi(signature: string, envName: string): Abi {
    try {
      return [parseAbiItem(signature)] as Abi;
    } catch (err) {
      throw new Error(
        `${envName} is not a valid function signature (${String(err).slice(0, 120)}). It must be ` +
          `the human-readable form, e.g. "function claim(bytes32 poolId)". Read the real signature ` +
          `off the verified hook; the launchpad does not publish its ABI.`,
      );
    }
  }

  async careFeeCollectorBalanceWei(): Promise<bigint> {
    if (!this.collectorAccount) return 0n;
    return this.publicClient.getBalance({ address: this.collectorAccount.address });
  }

  // The hook's WHOLE config row for our pool. Read on every cycle, never cached and never assumed:
  // the seat is reassignable by whoever holds it, so "we still hold it" is a fact with an expiry,
  // and the quote asset decides whether a claim can land anywhere our pipeline can use.
  //
  // THE WRONG ASSUMPTION THIS METHOD CLOSES. It used to do getAddress(result as string). The real
  // read, poolConfigs(bytes32), returns FIVE values, and viem decodes a multi-return function as an
  // ARRAY. getAddress(array) throws, so even after the signature was corrected the read would still
  // have failed on every cycle and the inlet would still have claimed nothing. Element 0 is taken
  // explicitly, and a bare-address return is still accepted so a differently-shaped future hook
  // degrades to "seat only" instead of hard-breaking.
  async launchpadPoolConfig(): Promise<LaunchpadPoolConfig> {
    const { hook, poolId } = this.requireLaunchpad();
    const abi = this.hookAbi(config.LAUNCHPAD_HOOK_CREATOR_FN, "LAUNCHPAD_HOOK_CREATOR_FN");
    const fn = (abi[0] as { name: string }).name;
    const result = await this.publicClient.readContract({
      address: hook, abi, functionName: fn, args: [poolId],
    });
    return decodeLaunchpadPoolConfig(result, fn);
  }

  // Element 0 of the row above, for the call sites that only care about the seat.
  async launchpadCreator(): Promise<string> {
    return (await this.launchpadPoolConfig()).creator;
  }

  // COLLECTOR-SIGNED. Never falls back to the relayer: claim() is current-creator-only, so a
  // relayer-signed claim is a guaranteed revert that still costs gas and still claims nothing.
  async launchpadClaim(): Promise<{ txHash: string }> {
    const { hook, poolId } = this.requireLaunchpad();
    if (!this.collectorWalletClient || !this.collectorAccount) {
      throw new Error(
        "CARE_FEE_COLLECTOR_PRIVATE_KEY not set: the launchpad creator fee can only be claimed by " +
          "the account holding the creator seat, so there is no key that could sign this. Set it in " +
          "the environment to the collector key for this deployment.",
      );
    }
    const abi = this.hookAbi(config.LAUNCHPAD_HOOK_CLAIM_FN, "LAUNCHPAD_HOOK_CLAIM_FN");
    const fn = (abi[0] as { name: string }).name;
    const collectorClient = this.collectorWalletClient;
    const collectorAccount = this.collectorAccount;
    const receipt = await this.submitWrite("launchpadClaim", collectorAccount, (ov) =>
      collectorClient.writeContract({
        address: hook, abi, functionName: fn, args: [poolId],
        account: collectorAccount, chain: collectorClient.chain, ...ov,
      }),
    );
    if (receipt.status !== "success") throw new Error(`launchpad claim reverted: ${receipt.transactionHash}`);
    logger.info(
      { hash: receipt.transactionHash, poolId, collector: collectorAccount.address },
      "launchpad creator fee claimed (collector-signed)",
    );
    return { txHash: receipt.transactionHash };
  }

  // COLLECTOR-SIGNED: hook.claim(poolId, splitter). THE DEFAULT PATH.
  //
  // WHY THIS EXISTS AT ALL: claim(bytes32,address) is present in the live hook's runtime bytecode
  // (selector 0x96c144f0) and pays the creator's accrued share to any address that is neither the
  // zero address nor the hook itself. The CareFeeSplitter is a valid destination, so the two-step
  // "claim to the collector, then ERC-20 transfer to the splitter" collapses into one transaction.
  // The failure mode it removes is real: a forward that fails leaves claimed revenue sitting on a
  // hot single-key wallet until a later cycle finishes the job.
  //
  // NO RECIPIENT ARGUMENT, exactly like collectorForwardToSplitter: the destination is pinned to the
  // configured splitter here, so no caller and no future edit at a call site can point the revenue
  // inlet at an arbitrary address.
  async launchpadClaimToSplitter(): Promise<{ txHash: string }> {
    const { hook, poolId } = this.requireLaunchpad();
    const splitter = this.requireSplitter();
    if (!this.collectorWalletClient || !this.collectorAccount) {
      throw new Error(
        "CARE_FEE_COLLECTOR_PRIVATE_KEY not set: the launchpad creator fee can only be claimed by " +
          "the account holding the creator seat, so there is no key that could sign this. Set it in " +
          "the environment to the collector key for this deployment.",
      );
    }
    const signature = config.LAUNCHPAD_HOOK_CLAIM_TO_FN?.trim();
    if (!signature) {
      throw new Error(
        "LAUNCHPAD_HOOK_CLAIM_TO_FN is empty, so there is no two-argument claim to send. Clear this " +
          "only to fall back to the claim-then-forward path (config.modes.launchpadClaimToSplitter " +
          "is derived from it, and the inlet reads that flag before calling this).",
      );
    }
    const abi = this.hookAbi(signature, "LAUNCHPAD_HOOK_CLAIM_TO_FN");
    const fn = (abi[0] as { name: string }).name;
    const collectorClient = this.collectorWalletClient;
    const collectorAccount = this.collectorAccount;
    const receipt = await this.submitWrite("launchpadClaimToSplitter", collectorAccount, (ov) =>
      collectorClient.writeContract({
        address: hook, abi, functionName: fn, args: [poolId, splitter],
        account: collectorAccount, chain: collectorClient.chain, ...ov,
      }),
    );
    if (receipt.status !== "success") throw new Error(`launchpad claim-to-splitter reverted: ${receipt.transactionHash}`);
    logger.info(
      { hash: receipt.transactionHash, poolId, splitter, collector: collectorAccount.address },
      "launchpad creator fee claimed STRAIGHT to the CareFeeSplitter (collector-signed, no forward needed)",
    );
    return { txHash: receipt.transactionHash };
  }

  async collectorFeeTokenBalance(): Promise<bigint> {
    if (!this.feeToken) throw new Error("FEE_TOKEN_ADDRESS not set");
    if (!this.collectorAccount) return 0n;
    return (await this.publicClient.readContract({
      address: this.feeToken, abi: ERC20_ABI, functionName: "balanceOf",
      args: [this.collectorAccount.address],
    })) as bigint;
  }

  // COLLECTOR-SIGNED forward. The destination is the CareFeeSplitter and nothing else: this method
  // takes no recipient argument on purpose, so no caller, and no future edit to a call site, can
  // turn the revenue inlet into a withdrawal.
  async collectorForwardToSplitter(amount: bigint): Promise<{ txHash: string }> {
    const splitter = this.requireSplitter();
    if (!this.feeToken) throw new Error("FEE_TOKEN_ADDRESS not set");
    if (!this.collectorWalletClient || !this.collectorAccount) {
      throw new Error(
        "CARE_FEE_COLLECTOR_PRIVATE_KEY not set: the claimed fee sits on the collector wallet and " +
          "only its key can move it. Set it in the environment.",
      );
    }
    if (amount <= 0n) throw new Error("collectorForwardToSplitter: amount must be positive");
    const feeToken = this.feeToken;
    const collectorClient = this.collectorWalletClient;
    const collectorAccount = this.collectorAccount;
    // Status, not the decoded return value: a USDT-style token returns no data, and the receipt is
    // the only signal that works for both shapes.
    const receipt = await this.submitWrite("collectorForwardToSplitter", collectorAccount, (ov) =>
      collectorClient.writeContract({
        address: feeToken, abi: ERC20_ABI, functionName: "transfer",
        args: [splitter, amount],
        account: collectorAccount, chain: collectorClient.chain, ...ov,
      }),
    );
    if (receipt.status !== "success") throw new Error(`fee forward to the splitter reverted: ${receipt.transactionHash}`);
    logger.info(
      { hash: receipt.transactionHash, raw: amount.toString(), splitter, collector: collectorAccount.address },
      "claimed creator fee forwarded to the CareFeeSplitter",
    );
    return { txHash: receipt.transactionHash };
  }

  // Fold the token's ENTIRE Transfer history into a balance map, in bounded
  // chunks (public RPCs refuse unbounded getLogs ranges). Exact by construction:
  // balances are transfer-conserved, so replaying every event reproduces
  // balanceOf for every holder without needing an indexer. Suited to the season
  // scale (one token, thousands of transfers); a mainnet token with millions of
  // transfers would graduate to the Blockscout holders API instead.
  async tokenHolderBalances(token: string, fromBlock: number): Promise<Map<string, bigint>> {
    const addr = getAddress(token);
    const latest = await this.publicClient.getBlockNumber();
    const balances = new Map<string, bigint>();
    const CHUNK = 5000n;
    let from = BigInt(Math.max(0, fromBlock));
    while (from <= latest) {
      const to = from + CHUNK - 1n < latest ? from + CHUNK - 1n : latest;
      const logs = await this.publicClient.getLogs({
        address: addr,
        event: ERC20_TRANSFER_EVENT_ABI[0],
        fromBlock: from,
        toBlock: to,
      });
      for (const log of logs) {
        const { from: src, to: dst } = log.args as { from: Hex; to: Hex };
        const value = (log.args as { value: bigint }).value;
        if (value === 0n) continue;
        const s = getAddress(src);
        const d = getAddress(dst);
        if (s !== "0x0000000000000000000000000000000000000000") {
          const next = (balances.get(s) ?? 0n) - value;
          if (next <= 0n) balances.delete(s);
          else balances.set(s, next);
        }
        if (d !== "0x0000000000000000000000000000000000000000") {
          balances.set(d, (balances.get(d) ?? 0n) + value);
        }
      }
      from = to + 1n;
    }
    return balances;
  }

  async vaultEventsSince(fromBlock: number): Promise<{ events: VaultEvent[]; toBlock: number }> {
    const vault = this.requirePetVault();
    const latest = await this.publicClient.getBlockNumber();
    const lookback = BigInt(config.DRAMA_LOOKBACK_BLOCKS);
    // `fromBlock` is the last block ALREADY processed, so scan from the next one
    // (an event on the boundary block is never double-processed). Clamp the scan
    // to a bounded window per poll: after a long RPC outage the cursor advances
    // incrementally instead of one unbounded getLogs that a provider would refuse.
    const from = fromBlock > 0 ? BigInt(fromBlock) + 1n : latest > lookback ? latest - lookback : 0n;
    if (from > latest) return { events: [], toBlock: fromBlock };
    const MAX_RANGE = 5000n;
    const to = from + MAX_RANGE - 1n < latest ? from + MAX_RANGE - 1n : latest;
    const evs: VaultEvent[] = [];
    const grab = async (
      eventName: string,
      map: (a: Record<string, unknown>, block: number) => VaultEvent,
    ) => {
      const logs = await this.publicClient.getContractEvents({
        address: vault, abi: petVaultAbi, eventName, fromBlock: from, toBlock: to,
      });
      for (const l of logs) evs.push(map(l.args as Record<string, unknown>, Number(l.blockNumber)));
    };
    // Deaths are NOT events in the last-pet-standing model (they derive from
    // timers); the drama layer listens for the leadership churn + the Victory.
    await grab("LeaderChanged", (a, b) => ({ kind: "leaderChanged", tokenId: String(a.leader), leaderCareAt: Number(a.leaderCareAt), runnerUpCareAt: Number(a.runnerUpCareAt), block: b }));
    await grab("Victory", (a, b) => ({ kind: "victory", tokenId: String(a.tokenId), tba: String(a.tba), prize: BigInt(a.prize as bigint), block: b }));
    evs.sort((x, y) => x.block - y.block);
    return { events: evs, toBlock: Number(to) };
  }
}
