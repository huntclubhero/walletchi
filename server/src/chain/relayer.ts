import { config } from "../config.js";
import { logger } from "../logger.js";
import { MockChain } from "./mock.js";
import { RobinhoodChain } from "./robinhood.js";
import { SerialQueue } from "./queue.js";
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
  MintTicket,
} from "./types.js";

// Relayer = a Chain plus the single-worker queue. Every write is serialized so
// the relayer wallet nonce is safe. Reads bypass the queue.
//
// TWO SIGNERS, TWO QUEUES (mainnet blocker B2). Since the vault hardening, holder
// round posting is signed by a DEDICATED poster key while everything else is signed
// by the relayer, so this class now fronts two independent accounts.
//
// WHY A POSTER TX CANNOT CONSUME THE RELAYER'S NONCE, OR THE REVERSE.
// Neither queue ever assigns a nonce. No call site passes one, so viem asks the RPC
// for the next nonce OF THE SENDING ADDRESS at send time (eth_getTransactionCount on
// that account's pending state) and signs with that account's key. A nonce is a
// property of an ADDRESS, so two different addresses draw from two disjoint counters
// by construction: there is no shared number for one to take from the other. The
// queue's actual job is narrower than it looks: it stops the SAME account from
// having two sends in flight at once, because each queued task awaits its receipt
// before the next task runs, so the next nonce read already sees the mined tx.
//
// That is why the poster gets its OWN SerialQueue rather than sharing the relayer's.
// Sharing would have been equally CORRECT (interleaving different accounts is safe
// for exactly the reason above), but it would put a 6-hourly round post, which sits
// on waitForTransactionReceipt for a block or more, in front of every mint and
// gasless claim queued behind it, and it would let a backed-up relayer shed a round
// post via the MAX_PENDING cap. Separate queues keep each account serial with itself
// and independent of the other, which is precisely the invariant that matters.
export class Relayer {
  private queue = new SerialQueue("relayer");
  // Poster-signed writes only (postRound). Independent FIFO: see the note above.
  private posterQueue = new SerialQueue("holder-poster");
  // Collector-signed writes only (the launchpad claim + the forward to the splitter). A THIRD
  // account, and therefore a third disjoint nonce counter, for exactly the reason spelled out
  // above: a nonce belongs to an address, so separate accounts cannot take each other's numbers.
  // Its own queue rather than the relayer's because these two writes each wait on a receipt, and
  // putting a revenue sweep in front of every mint and gasless claim (or letting a backed-up
  // relayer shed it via MAX_PENDING) would be the wrong trade in both directions.
  //
  // ONE QUEUE FOR BOTH COLLECTOR WRITES, not two, and that is load-bearing: the claim and the
  // forward are ordered steps of one operation, so they MUST stay serial with each other. A
  // forward that overtook its claim would move a balance the claim had not deposited yet.
  private collectorQueue = new SerialQueue("fee-collector");
  constructor(public readonly chain: Chain) {}

  get live(): boolean {
    return this.chain.live;
  }

  // The custodial relayer/signer address (owner of email-only demo pets).
  get address(): string {
    return this.chain.relayerAddress;
  }

  // The dedicated holder-round poster address (null when no poster key is configured).
  // NOT the relayer, by contract requirement.
  get holderPosterAddress(): string | null {
    return this.chain.holderPosterAddress;
  }

  // Pet mint (same relayer key, same nonce queue), PIPELINED (launch fix 1).
  //
  // Only the broadcast rides the queue. The simulate and gas estimate run before it
  // (in parallel across a burst) and the receipt is awaited after it (by the chain's
  // one watcher), so the serialized cost of a mint is a signature and one RPC round
  // trip instead of a receipt wait. The queue still guarantees what it always did:
  // one send in flight per account at the moment of drawing a nonce.
  //
  // `onSigned` runs with the ticket BEFORE the bytes go out (fulfillment persists it
  // to the row), which is what makes a restart recoverable: see recoverMint.
  async issueRunner(to: string, onSigned?: (ticket: MintTicket) => Promise<void>): Promise<IssueResult> {
    this.mintsQueued += 1;
    try {
      const prepared = await this.chain.prepareMint(to);
      const ticket = await this.queue.enqueue("submitMint", () => this.chain.submitMint(prepared, onSigned));
      return await this.chain.awaitMint(ticket);
    } finally {
      this.mintsQueued -= 1;
    }
  }
  // Restart recovery: settle a ticket a previous process broadcast. Not queued (nothing
  // is broadcast here; a replacement, if the head policy needs one, reuses the owned nonce).
  recoverMint(ticket: MintTicket, to: string): Promise<IssueResult> {
    this.mintsQueued += 1;
    return this.chain.recoverMint(ticket, to).finally(() => {
      this.mintsQueued -= 1;
    });
  }
  private mintsQueued = 0;
  /** Mints this process is driving: prepared, queued, broadcast or awaiting a receipt. */
  get mintsInFlight(): number {
    return this.mintsQueued;
  }

  // Read bypasses the queue.
  runnerState(tokenId: string): Promise<RunnerState> {
    return this.chain.runnerState(tokenId);
  }

  // WALLETCHI PetVault reads (care() is owner-only on-chain now: no care write).
  petVaultConfig(): Promise<PetVaultConfig> {
    return this.chain.petVaultConfig();
  }
  petVaultStats(): Promise<PetVaultStats> {
    return this.chain.petVaultStats();
  }
  // The sellout start gate. Read bypasses the queue; the write rides the relayer
  // queue like every other relayer-signed call.
  seasonGate(): Promise<SeasonGate> {
    return this.chain.seasonGate();
  }
  startSeason(): Promise<{ txHash: string }> {
    return this.queue.enqueue("startSeason", () => this.chain.startSeason());
  }
  petAlive(tokenId: string): Promise<boolean> {
    return this.chain.petAlive(tokenId);
  }
  petState(tokenId: string): Promise<PetLifeState> {
    return this.chain.petState(tokenId);
  }
  // The five raw need stamps (needsOf), index = canonical actionType. Read only.
  petNeeds(tokenId: string): Promise<PetNeeds> {
    return this.chain.petNeeds(tokenId);
  }
  petMemorial(tokenId: string): Promise<PetMemorial> {
    return this.chain.petMemorial(tokenId);
  }
  careTokenDecimals(): Promise<number> {
    return this.chain.careTokenDecimals();
  }
  // Pet721 v2 ownership + soulbound reads (claim flow). Reads bypass the queue.
  petOwnerOf(tokenId: string): Promise<string> {
    return this.chain.petOwnerOf(tokenId);
  }
  petOwnersOf(tokenIds: string[]): Promise<(string | null)[]> {
    return this.chain.petOwnersOf(tokenIds);
  }
  petIsDead(tokenId: string): Promise<boolean> {
    return this.chain.petIsDead(tokenId);
  }
  // ERC-1271 fallback verification (spec-floor signed care path). Read-only.
  isValidErc1271Signature(address: string, message: string, signature: string): Promise<boolean> {
    return this.chain.isValidErc1271Signature(address, message, signature);
  }
  // Settlement (last pet standing): finalize() is the only settlement write
  // (permissionless; the contract re-verifies the win before paying).
  finalizeSeason(): Promise<{ txHash: string }> {
    return this.queue.enqueue("finalize", () => this.chain.finalizeSeason());
  }
  settlementState(): Promise<SettlementState> {
    return this.chain.settlementState();
  }
  isOver(): Promise<boolean> {
    return this.chain.isOver();
  }
  leader(): Promise<string> {
    return this.chain.leader();
  }
  vaultEventsSince(fromBlock: number): Promise<{ events: VaultEvent[]; toBlock: number }> {
    return this.chain.vaultEventsSince(fromBlock);
  }

  // WALLETCHI player rewards (SEASON 2, NO CLAIMS). Reads bypass the queue; the
  // PUSH writes share the relayer nonce queue. Every one of them is permissionless
  // with contract-enforced amounts and destinations, so the relayer signing them
  // buys players gasless delivery and buys us no authority whatsoever.
  rewardsEpochNow(): Promise<number> {
    return this.chain.rewardsEpochNow();
  }
  rewardsPending(tokenId: string, epoch: number): Promise<bigint> {
    return this.chain.rewardsPending(tokenId, epoch);
  }
  rewardsClaimed(tokenId: string, epoch: number): Promise<boolean> {
    return this.chain.rewardsClaimed(tokenId, epoch);
  }
  rewardsPoints(tokenId: string, epoch: number): Promise<bigint> {
    return this.chain.rewardsPoints(tokenId, epoch);
  }
  rewardsResidualSwept(): Promise<boolean> {
    return this.chain.rewardsResidualSwept();
  }
  rewardsPushMany(epoch: number, tokenIds: string[]): Promise<{ txHash: string }> {
    return this.queue.enqueue("rewardsPushMany", () =>
      this.chain.rewardsPushMany(epoch, tokenIds),
    );
  }
  rewardsSweepForfeited(epoch: number, tokenIds: string[]): Promise<{ txHash: string }> {
    return this.queue.enqueue("rewardsSweepForfeited", () =>
      this.chain.rewardsSweepForfeited(epoch, tokenIds),
    );
  }
  rewardsSweepResidual(): Promise<{ txHash: string }> {
    return this.queue.enqueue("rewardsSweepResidual", () => this.chain.rewardsSweepResidual());
  }
  // ESCROW AND RE-PUSH: the winner's prize when finalize()'s transfer was refused.
  // Read bypasses the queue; the retry rides it like every other relayer write.
  vaultUnpaidPrize(tokenId: string): Promise<bigint> {
    return this.chain.vaultUnpaidPrize(tokenId);
  }
  vaultPushPrize(tokenId: string): Promise<{ txHash: string }> {
    return this.queue.enqueue("vaultPushPrize", () => this.chain.vaultPushPrize(tokenId));
  }

  // TAX ECONOMY (2026-08-17): splitter poke + USDG holder airdrops. Reads bypass the
  // queue. The splitter poke and the gasless claims are permissionless, so the RELAYER
  // signs them on the relayer queue; ROUND POSTING is poster-gated on-chain, so it is
  // signed by the dedicated poster key on its own queue (see the class note). Player
  // fee rewards fold into the CARE distributor above, so there is no separate
  // tax-claim surface here.
  splitterBalance(): Promise<bigint> {
    return this.chain.splitterBalance();
  }
  splitterDistribute(): Promise<{ txHash: string }> {
    return this.queue.enqueue("splitterDistribute", () => this.chain.splitterDistribute());
  }
  // TESTNET SHOWCASE drip + rate re-affirm (runner/showcase-drip.ts). Both relayer-signed on the
  // relayer queue: the mint is MockUSDG's open faucet, the re-affirm is owner-only and only works
  // because the testnet deployer (the owner) IS the relayer.
  showcaseMintFeeToSplitter(amount: bigint): Promise<{ txHash: string }> {
    return this.queue.enqueue("showcaseMintFeeToSplitter", () => this.chain.showcaseMintFeeToSplitter(amount));
  }
  splitterRateState(): Promise<SplitterRateState> {
    return this.chain.splitterRateState();
  }
  splitterReaffirmRate(slippageBps: number, rate: bigint): Promise<{ txHash: string }> {
    return this.queue.enqueue("splitterReaffirmRate", () => this.chain.splitterReaffirmRate(slippageBps, rate));
  }
  mintBudgetState(): Promise<MintBudgetState> {
    return this.chain.mintBudgetState();
  }
  holderRoundCount(): Promise<number> {
    return this.chain.holderRoundCount();
  }
  holderUnreserved(): Promise<bigint> {
    return this.chain.holderUnreserved();
  }
  holderPoster(): Promise<string> {
    return this.chain.holderPoster();
  }
  holderMaxRoundTotal(): Promise<bigint> {
    return this.chain.holderMaxRoundTotal();
  }
  holderPostingPaused(): Promise<boolean> {
    return this.chain.holderPostingPaused();
  }
  // POSTER-SIGNED, so it rides the POSTER queue, not the relayer's. This is the only
  // method on this class that does.
  holderPostRound(expectedRoundId: number, root: string, total: bigint): Promise<{ txHash: string }> {
    return this.posterQueue.enqueue("holderPostRound", () =>
      this.chain.holderPostRound(expectedRoundId, root, total),
    );
  }
  holderClaimed(roundId: number, account: string): Promise<boolean> {
    return this.chain.holderClaimed(roundId, account);
  }
  holderClaim(
    roundId: number,
    account: string,
    amount: bigint,
    proof: string[],
  ): Promise<{ txHash: string }> {
    // Same rule as RobinhoodChain.holderClaim, so the signer and its nonce-pinning queue always agree.
    const viaPoster = config.HOLDER_CLAIM_SIGNER === "poster" && Boolean(this.chain.holderPosterAddress);
    return (viaPoster ? this.posterQueue : this.queue).enqueue("holderClaim", () =>
      this.chain.holderClaim(roundId, account, amount, proof),
    );
  }
  tokenHolderBalances(token: string, fromBlock: number): Promise<Map<string, bigint>> {
    return this.chain.tokenHolderBalances(token, fromBlock);
  }

  // LAUNCHPAD CREATOR-FEE INLET. The SOURCE of everything the splitter distributes: the trade tax
  // accrues to a creator seat inside the launchpad hook and only the current creator can pull it.
  // Reads bypass the queue; both writes are COLLECTOR-signed and ride the collector queue, in
  // order, because the forward depends on the claim having landed.
  get careFeeCollectorAddress(): string | null {
    return this.chain.careFeeCollectorAddress;
  }
  careFeeCollectorBalanceWei(): Promise<bigint> {
    return this.chain.careFeeCollectorBalanceWei();
  }
  launchpadPoolConfig(): Promise<LaunchpadPoolConfig> {
    return this.chain.launchpadPoolConfig();
  }
  launchpadCreator(): Promise<string> {
    return this.chain.launchpadCreator();
  }
  launchpadClaim(): Promise<{ txHash: string }> {
    return this.collectorQueue.enqueue("launchpadClaim", () => this.chain.launchpadClaim());
  }
  // Same queue as the other collector-signed write: two claims in flight from one key would collide
  // on the nonce exactly as a claim and a forward would.
  launchpadClaimToSplitter(): Promise<{ txHash: string }> {
    return this.collectorQueue.enqueue("launchpadClaimToSplitter", () =>
      this.chain.launchpadClaimToSplitter(),
    );
  }
  collectorFeeTokenBalance(): Promise<bigint> {
    return this.chain.collectorFeeTokenBalance();
  }
  collectorForwardToSplitter(amount: bigint): Promise<{ txHash: string }> {
    return this.collectorQueue.enqueue("collectorForwardToSplitter", () =>
      this.chain.collectorForwardToSplitter(amount),
    );
  }

  // Gas balance read for /internal/status (bypasses the queue).
  relayerBalanceWei(): Promise<bigint> {
    return this.chain.relayerBalanceWei();
  }
  // Poster gas balance for /internal/status (bypasses the queue). A separate signer has a
  // separate gas tank, and an empty one stalls rounds just as silently as a wrong key.
  holderPosterBalanceWei(): Promise<bigint> {
    return this.chain.holderPosterBalanceWei();
  }
  // Burn-ledger read for the stats band (bypasses the queue).
  burnedCareTotal(): Promise<bigint> {
    return this.chain.burnedCareTotal();
  }
  // TBA balance read for the Care Balance metadata attribute (bypasses the queue).
  careBalanceOf(address: string): Promise<bigint> {
    return this.chain.careBalanceOf(address);
  }

  get pending(): number {
    return this.queue.pending;
  }
  /** Relayer-signed writes broadcast but not yet mined (the pipeline watcher's depth). */
  get unminedWrites(): number {
    return this.chain.unminedWrites;
  }
  /** Pending poster-signed writes (round posts). Separate counter, separate account. */
  get posterPending(): number {
    return this.posterQueue.pending;
  }
  /** Pending collector-signed writes (creator-fee claim + forward). Separate account again. */
  get collectorPending(): number {
    return this.collectorQueue.pending;
  }
}

// Pick the live chain when relayer creds are present, else a loud stub.
export function createRelayer(): Relayer {
  if (config.modes.relayerLive) {
    return new Relayer(new RobinhoodChain());
  }
  logger.warn(
    "RELAYER STUB MODE: no RELAYER_PRIVATE_KEY/RUNNER_ISSUER_ADDRESS. " +
      "Pets mint against an in-memory MockChain. Set the env to go live.",
  );
  return new Relayer(new MockChain());
}
