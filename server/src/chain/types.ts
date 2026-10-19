// The Chain interface: everything the app needs from Robinhood Chain.
// Production impl = RobinhoodChain (viem). Smoke impl = MockChain.
// All amounts crossing this boundary are care-token "raw" units (BigInt).

export interface IssueResult {
  txHash: string;
  tokenId: string; // decimal string
  tbaAddress: string;
}

// THE PIPELINED MINT (launch fix 1). One mint is three calls instead of one:
//   prepareMint  (NOT serialized) simulate + gas estimate against the latest state;
//                throws MintBudgetExhaustedError / supply reverts before anything is spent.
//   submitMint   (SERIALIZED by the relayer queue) draw the next nonce, sign, hand the
//                ticket to `onSigned` (the row persists it), then broadcast. Returns the
//                instant the bytes are on the wire.
//   awaitMint    (NOT serialized) resolves when the ticket's nonce mines, with the token
//                decoded from the receipt; rejects on revert, replacement or a stuck head.
// issueRunner() is the three composed, kept for scripts that mint one pet and wait.
export interface PreparedMint {
  to: string;
  /** Which issuer surface the configured address answered to (pet = WALLETCHI PetIssuer). */
  via: "issuePet" | "issueRunner";
  /** Gas limit for the send, with margin. Chain-specific; the mock ignores it. */
  gas: bigint;
}

/** What survives a restart: enough to find the transaction again (or prove it never landed). */
export interface MintTicket {
  txHash: string;
  nonce: number;
}

/** The PetIssuer's rolling mint budget (the brake on a leaked relayer key), read raw. `max` 0 means
 *  uncapped. `windowStart` + `windowSecs` is when the current window rolls over. */
export interface MintBudgetState {
  max: number;
  windowSecs: number;
  windowStart: number;
  used: number;
}

/** issuePet refused with MintBudgetExhausted: the hourly budget is spent. Typed so the mint path
 *  can tell a keeper "busy hour, come back in N minutes" instead of "mint did not complete".
 *  `retryAfterSec` is null when the window could not be read. */
export class MintBudgetExhaustedError extends Error {
  readonly code = "mint_busy";
  constructor(
    readonly budget: MintBudgetState | null,
    readonly retryAfterSec: number | null,
  ) {
    super("MintBudgetExhausted: the issuer's mint budget for this window is spent");
    this.name = "MintBudgetExhaustedError";
  }
}

/** The CareFeeSplitter's swap-rate hint, read raw. The splitter treats a rate older than `maxAge`
 *  as no price at all and PARKS the player half, so a testnet deploy that sets it once goes dark
 *  after `maxAge` unless something re-affirms it. */
export interface SplitterRateState {
  rate: bigint;
  lastNonzeroRate: bigint;
  slippageBps: number;
  updatedAt: number;
  maxAge: number;
  owner: string;
}

// One row of the launchpad hook's pool table, as returned by poolConfigs(bytes32) on the live
// CashCatHookV2. This is the shape the creator-fee inlet checks BEFORE it will send anything.
//
// EVERY FIELD EXCEPT `creator` IS NULLABLE, and that is not defensive noise: the signature is
// configurable (LAUNCHPAD_HOOK_CREATOR_FN), so a differently-shaped hook may return only an address.
// null means UNKNOWN, never "fine": the inlet treats an unknown quote as a refusal, because the
// one thing it must never do is claim into a path that cannot receive the asset.
export interface LaunchpadPoolConfig {
  /** Element 0: the seat that may claim and reassign. Checksummed. */
  creator: string;
  /** Creator's share of the trade tax, in bps of the fee. 9000 = 90% on the live 3% tier. */
  creatorFeeBps: number | null;
  /** Pool fee rate in hundredths of a bip. 30000 = 3%. */
  feeRate: number | null;
  /** Whether the hook has this pool registered at all. false = we are reading a phantom pool. */
  exists: boolean | null;
  /**
   * THE ASSET THE FEE IS PAID IN, and the single most dangerous field in this file.
   * The zero address means the pool is quoted in NATIVE ETH: claim() then pays with
   * .call{value:}, which our ERC-20 forward cannot move and which CareFeeSplitter cannot even
   * receive (it has no receive() and no fallback, deliberately). Checksummed, or null when the
   * configured signature does not report it.
   */
  quote: string | null;
}

// Legacy runner-era surface (kept only for deployed-ABI compatibility).

export interface RunnerState {
  tbaAddress: string;
  bestScore: number;
  totalSalmon: number;
  totalRuns: number;
}

// WALLETCHI survival economy (PetVault, LAST PET STANDING, FIVE NEEDS). Each pet
// carries FIVE need timestamps (0=FEED 1=WATER 2=PLAY 3=TOY 4=EXPLORE, the
// canonical actionType order); care(tokenId, actionType) refreshes ONLY the
// targeted need. A pet is DEAD the instant ANY need goes unserved for a full
// lifeTtl: min(needAt) + lifeTtl <= now (pure clock, permanent, no revive, no
// reaping). The last pet still alive wins the whole pot into its TBA via the
// permissionless finalize(). All amounts are care-token "raw" units (bigint).

export interface PetVaultConfig {
  careCostRaw: bigint; // token pulled per care action (pot/burn/rewards split)
  lifeTtlSeconds: number; // per-NEED life window (a need lapses at needAt[i] + lifeTtl)
  careCooldownSeconds: number; // vault-enforced gap between cares of the SAME need (per need, ships 0)
}

// The five raw need timestamps (contract needsOf), indexed by canonical
// actionType. Unix seconds; ALL ZEROS both for a dormant egg AND for an
// unregistered id, so callers must check petState().registered first. The
// stamps freeze at death (care() reverts), so consumers gate any "time left"
// display on the pet being alive. Per-need deadline = needAt[i] + lifeTtl.
export interface PetNeeds {
  needAt: [number, number, number, number, number];
}

export interface PetVaultStats {
  potRaw: bigint; // accumulated pot (care-token raw units)
  registeredCount: number; // pets registered in the season
  hatchedCount: number; // distinct pets fed at least once (entered the race)
  lifeTtlSeconds: number; // current life window (for the off-chain alive tally)
}

/** The season's start gate. Under the SELLOUT model nothing may hatch or feed until the collection
 *  mints out, and every pet's five clocks then start at that one instant, so "has the season
 *  started" is a first-class state the site and the pass have to be able to show. */
export interface SeasonGate {
  /** True when this season starts at sellout; false for the original clock model. */
  selloutStartsSeason: boolean;
  /** Unix seconds when the season started (all clocks began). 0 = not started yet. */
  startedAt: number;
  /** Is the roster still open to new mints? */
  entryOpen: boolean;
  minted: number;
  maxSupply: number;
  /** Clock model only: unix seconds when minting (and hatching an egg) closes for good. null under
   *  the sellout model, where the roster closes on the sellout instead, or when unreadable. */
  entryDeadline: number | null;
  /** Unix seconds the vault was deployed (the clock model's season start). null when unreadable. */
  seasonStart: number | null;
}

export interface PetMemorial {
  dead: boolean;
  bornAt: number; // unix seconds
  diedAt: number; // unix seconds = lastCareAt + lifeTtl once dead (0 while alive)
  careCount: number;
  // Survival rank is OFF-CHAIN in the last-pet-standing model (the contract has
  // no death-order counter and always returns 0 here); the server derives it by
  // counting pets that died earlier. Kept in the shape for that derived value.
  rank: number;
}

export interface PetLifeState {
  registered: boolean;
  dead: boolean; // ANY need lapsed a full lifeTtl: PERMANENT (no revive, no reaping step)
  isAlive: boolean; // the complement of dead for a registered, hatched pet
  // The pet's MIN-NEED stamp (its weakest link) since the five-needs redesign:
  // deadline = lastCareAt + lifeTtl still holds exactly, so every deadline
  // consumer stays literally correct. The true LAST-ACTION instant is
  // max(petNeeds().needAt), not this: use it for deadline math only.
  lastCareAt: number; // unix seconds (deadline = lastCareAt + lifeTtl)
  secondsLeft: number; // 0 once the deadline passes
}

// Settlement (last pet standing): candidate = the current leader (most recently
// fed pet; the pet that wins if nobody else ever feeds), winsAt = the moment
// finalize() succeeds if no rival feeds (runnerUpCareAt + lifeTtl), finalized =
// the pot has been paid (potClaimed).
export interface SettlementState {
  candidate: string; // the leader tokenId ("0" until the first care)
  candidateLastCareAt: number; // leaderCareAt, unix seconds
  winsAt: number; // runnerUpCareAt + lifeTtl, unix seconds (0 while no leader)
  finalized: boolean; // potClaimed
}

// A decoded PetVault event (drama feed: leadership changes + the victory).
// Deaths are NOT events in the last-pet-standing model: they derive from timers.
export type VaultEvent =
  | { kind: "leaderChanged"; tokenId: string; leaderCareAt: number; runnerUpCareAt: number; block: number }
  | { kind: "victory"; tokenId: string; tba: string; prize: bigint; block: number };

export interface PetSpendState {
  dailyCap: bigint;
  windowStart: number;
  spentInWindow: bigint;
}

export interface Chain {
  readonly live: boolean;
  readonly chainId: number;
  readonly explorer: string;
  // The relayer wallet address (the custodial signer). Used as the owner for the
  // email-only demo mint. A deterministic placeholder in the mock/stub chain.
  readonly relayerAddress: string;
  // Native (gas) balance of the relayer wallet in wei. Ops-only read for
  // /internal/status: on mainnet a dry relayer silently stalls every care and
  // mint, so the heartbeat needs a number to alert on. Stubbed in the mock.
  relayerBalanceWei(): Promise<bigint>;
  // Care tokens burned so far = the care token's balance at the dEaD address
  // (the vault holds no burn counter; dEaD IS the ledger). Stats-band read.
  burnedCareTotal(): Promise<bigint>;
  // Care-token balance of an arbitrary address (a pet's TBA): the "Care
  // Balance" marketplace attribute reads the pet's own bank account.
  careBalanceOf(address: string): Promise<bigint>;

  // Mint a pet 721 + create its 6551 account (custodial demo).
  // (Legacy name kept for deployed-ABI compatibility; scripts that mint one pet and
  // wait use it. The API's mint path uses the three pipelined calls below.)
  issueRunner(to: string): Promise<IssueResult>;
  prepareMint(to: string): Promise<PreparedMint>;
  submitMint(prepared: PreparedMint, onSigned?: (ticket: MintTicket) => Promise<void>): Promise<MintTicket>;
  awaitMint(ticket: MintTicket): Promise<IssueResult>;
  // Restart recovery: re-attach a ticket a PREVIOUS process broadcast (read back from
  // the row) and settle it exactly like awaitMint would have.
  recoverMint(ticket: MintTicket, to: string): Promise<IssueResult>;
  // Relayer-signed writes broadcast but not yet mined (the receipt watcher's depth).
  readonly unminedWrites: number;
  // Read aggregate runner state (legacy view; kept as the mint TBA fallback).
  runnerState(tokenId: string): Promise<RunnerState>;
  // The pet's ERC-6551 account: the issuer's accountOf, falling back to the legacy runnerState
  // view (the live issuer reverts runnerState, so never read the account through it alone).
  tokenAccountOf(tokenId: string): Promise<string>;

  // WALLETCHI PetVault (survival economy). care() is OWNER-ONLY on-chain now:
  // the owner signs it from the web care page (AA flow) and the vault rejects
  // the relayer, so there is NO server-side care write on this surface. The
  // server only READS the vault and folds off-server cares into the DB
  // (reconcileOnChainCare in runner/idle.ts).
  // Reads (bypass the queue). Death is a pure read: petState().dead / isDead.
  petVaultConfig(): Promise<PetVaultConfig>;
  petVaultStats(): Promise<PetVaultStats>;
  /** The sellout start gate (read). */
  seasonGate(): Promise<SeasonGate>;
  /** Close the roster and start every pet's clock together. Permissionless once the collection has
   *  minted out; the vault itself enforces that, so this is safe to poke on a timer. */
  startSeason(): Promise<{ txHash: string }>;
  petAlive(tokenId: string): Promise<boolean>;
  petState(tokenId: string): Promise<PetLifeState>;
  // The five raw need stamps (contract needsOf), index = canonical actionType.
  // All zeros for a dormant egg AND an unregistered id: check registered first.
  petNeeds(tokenId: string): Promise<PetNeeds>;
  // The pet account's rolling spend window (WalletchiAccount dailyCap / windowStart / spentInWindow),
  // read from the pet's own account address. null when the account cannot be read.
  petSpendState(account: string): Promise<PetSpendState | null>;
  petMemorial(tokenId: string): Promise<PetMemorial>;
  // The care token's decimals, read off-chain at runtime (Pons decimals are unknown
  // until Hunt delivers the address, so never hardcode 18 for display formatting).
  careTokenDecimals(): Promise<number>;

  // Pet721 v2 ownership + soulbound reads (secondary-market claim, WS2).
  // ownerOf is the AUTHORITATIVE current owner (the wallet-proof path checks the
  // recovered signer against it). Throws when the Pet721 address is not configured.
  petOwnerOf(tokenId: string): Promise<string>;
  // Bounded batch ownerOf for resolving which known pets a signer owns (tokenId
  // omitted on claim). null for a tokenId whose read failed (unminted/burned).
  petOwnersOf(tokenIds: string[]): Promise<(string | null)[]>;
  // Pet721.isDead: TIME-BASED (vault clock) == soulbound memorial (no claim, no
  // transfer). True the instant the life timer lapses.
  petIsDead(tokenId: string): Promise<boolean>;
  // ERC-1271 signature check for a smart-contract account. Used by the spec-floor
  // signed care path as the fallback when EOA recovery does not match the claimed
  // owner. Returns false for a plain EOA or an invalid signature. In production
  // the email-onboarded owner is an embedded EOA, so this is a generic safety net.
  isValidErc1271Signature(address: string, message: string, signature: string): Promise<boolean>;

  // Settlement (last pet standing). finalize() is the ONLY settlement write:
  // permissionless, re-verified on-chain (GameNotOver / NotEnoughPlayers /
  // GameOver), pays the whole pot to the leader's TBA. The server merely POKES
  // it when isOver() flips true; it can never steer or rush the outcome.
  finalizeSeason(): Promise<{ txHash: string }>;
  settlementState(): Promise<SettlementState>;
  // True once the game is decidable: enough distinct fed pets and no pet other
  // than the leader alive (now >= runnerUpCareAt + lifeTtl). False after payout.
  isOver(): Promise<boolean>;
  // The current leader tokenId ("0" until the first care). FROZEN once the pot is
  // claimed, so after settlement this IS the champion: the settlement tail reads
  // it to aim pushPrize and to name the residual sweep's recipient.
  leader(): Promise<string>;
  // Drama feed: decoded PetVault events since `fromBlock` (0 = from a lookback).
  vaultEventsSince(fromBlock: number): Promise<{ events: VaultEvent[]; toBlock: number }>;

  // WALLETCHI player rewards (CareRewardsDistributor). Epoch-based, activity
  // weighted pools paid pro rata INTO each pet's TBA.
  //
  // SEASON 2, NO CLAIMS: nobody claims anything. Every write here is
  // PERMISSIONLESS with contract-enforced amounts, so the 2h push engine
  // (runner/push-rewards.ts) is a convenience and never an authority: if our
  // server goes dark, anyone can run the identical calls and no pet is stranded.
  // Reads bypass the queue; writes go through it. All amounts are raw units.
  rewardsEpochNow(): Promise<number>;
  // What a pet would be paid for a finished epoch. ZERO for a pet that is
  // already paid, has no points, or is DEAD: that last case is the split the
  // push engine keys off (dead pets forfeit, they are never pushed).
  rewardsPending(tokenId: string, epoch: number): Promise<bigint>;
  rewardsClaimed(tokenId: string, epoch: number): Promise<boolean>;
  // Participation points for a pet in an epoch. Non-zero points with a zero
  // pending and claimed false is the FORFEIT signal (the pet died holding a share).
  rewardsPoints(tokenId: string, epoch: number): Promise<bigint>;
  // PUSH one finished epoch to a batch of pets. Per-pet problems are skipped
  // on-chain, never reverted, so a hostile or dead pet cannot block the batch.
  // Reverts only at batch level (SeasonSettled / EpochNotFinished / NoPoints).
  rewardsPushMany(epoch: number, tokenIds: string[]): Promise<{ txHash: string }>;
  // Forfeit DEAD pets' unclaimed shares from a finished epoch into a future pool.
  // Reverts PetIsAlive if ANY listed pet is alive, so callers filter first.
  rewardsSweepForfeited(epoch: number, tokenIds: string[]): Promise<{ txHash: string }>;
  // Post-season escape: once the vault has settled, the whole remaining balance
  // goes to the champion's TBA rather than sitting locked. Reverts AlreadySwept
  // on a repeat, so callers check rewardsResidualSwept() first.
  rewardsSweepResidual(): Promise<{ txHash: string }>;
  rewardsResidualSwept(): Promise<boolean>;

  // ESCROW AND RE-PUSH (season 2). finalize() pays the winner's TBA directly, but
  // its transfer is non-blocking: a care token that refuses leaves the prize
  // escrowed in unpaidPrize instead of stranding the season. pushPrize is the
  // PERMISSIONLESS retry and its destination is not caller-chosen (the winning
  // pet's own TBA, always), so the winner never signs anything.
  vaultUnpaidPrize(tokenId: string): Promise<bigint>;
  vaultPushPrize(tokenId: string): Promise<{ txHash: string }>;

  // TAX ECONOMY (2026-08-17, simplified). Player fee rewards fold into the ONE CARE
  // distributor (the splitter swaps the player half USDG->CARE into it), so there is
  // no separate fee-token claim surface. What remains here is the HOLDER airdrop
  // pipeline in USDG. All address-gated by config.modes.holderRewardsLive.
  // The splitter's undistributed fee-token (USDG) balance, and the permissionless
  // poke that splits it (holder half -> holder vault; player half swapped to CARE).
  splitterBalance(): Promise<bigint>;
  splitterDistribute(): Promise<{ txHash: string }>;
  // TESTNET SHOWCASE ONLY (SHOWCASE_USDG_DRIP; refused on mainnet at boot). Mint `amount` of the
  // MOCK fee token straight into the splitter: a stand-in for the launchpad trade tax, which does
  // not exist on testnet. Relies on MockUSDG's open faucet mint, so it can never work against
  // real USDG.
  showcaseMintFeeToSplitter(amount: bigint): Promise<{ txHash: string }>;
  // The splitter's swap-rate hint, and the OWNER-ONLY re-affirm of it (setSwapParams with the same
  // values). On testnet the deployer owns the splitter and is also the relayer, which is the only
  // reason the relayer can sign this at all.
  splitterRateState(): Promise<SplitterRateState>;
  splitterReaffirmRate(slippageBps: number, rate: bigint): Promise<{ txHash: string }>;
  // The issuer's mint budget, for a pre-check that refuses a mint BEFORE the keeper spends
  // proof-of-work and their one-per-email claim on a transaction that would revert.
  mintBudgetState(): Promise<MintBudgetState>;
  // Holder airdrop vault. postRound is poster-gated (a DEDICATED poster key, never
  // the relayer); expectedRoundId guards a cron/nonce race. claim() is permissionless
  // and always pays the leaf's account, so the server relays holder claims gaslessly.
  //
  // postRound is the ONLY call on this whole interface signed by a key OTHER than the
  // relayer. Verified against HolderMerkleVault.sol: releaseRound is permissionless
  // (anyone may trigger it once the grace elapses) and queuePoster / commitPoster /
  // setPostingPaused / setMaxRoundTotal are onlyOWNER, not onlyPoster, so the server
  // could not sign them with the poster key even if it wanted to, and it never calls them.
  //
  // The PUBLIC address of the configured poster key, or null when no poster key is
  // configured (posting dark). Compared against the on-chain poster() at boot.
  readonly holderPosterAddress: string | null;
  // Native (gas) balance of the POSTER wallet in wei, 0n when unconfigured. The poster is a
  // brand new dedicated key that nobody has funded yet by default, and a dry poster stalls
  // every round exactly as invisibly as a wrong one, so /internal/status needs the number.
  holderPosterBalanceWei(): Promise<bigint>;
  holderRoundCount(): Promise<number>;
  holderUnreserved(): Promise<bigint>;
  // The vault's CURRENT poster address. The boot guard reads this and refuses to let the
  // job burn gas on a guaranteed NotPoster revert when it disagrees with our key.
  holderPoster(): Promise<string>;
  // Per-round ceiling. FAIL CLOSED on-chain since the hardening: 0 means NO round can be
  // posted at all (RoundCapNotArmed), and any total above it reverts OverRoundCap. The
  // 4x/day job clamps to this and carries the remainder into the next round.
  holderMaxRoundTotal(): Promise<bigint>;
  // Owner emergency stop. postRound reverts PostingIsPaused while true, so the job checks
  // it and reports a pause as a pause instead of as an unexplained failure.
  holderPostingPaused(): Promise<boolean>;
  // POSTER-SIGNED (not the relayer). Throws a clear error when no poster key is configured.
  holderPostRound(expectedRoundId: number, root: string, total: bigint): Promise<{ txHash: string }>;
  holderClaimed(roundId: number, account: string): Promise<boolean>;
  holderClaim(
    roundId: number,
    account: string,
    amount: bigint,
    proof: string[],
  ): Promise<{ txHash: string }>;
  // LAUNCHPAD CREATOR-FEE INLET (mainnet). The splitter is the DESTINATION of the trade tax; this
  // is its SOURCE. The letscash hook accrues the pool-level tax to a "creator" seat and only the
  // CURRENT creator can pull it (hook.claim) or hand it on (hook.updateCreator), so a COLLECTOR
  // account holds the seat and the server claims + forwards on the distribution cadence.
  //
  // The seat is NEVER assigned to the CareFeeSplitter: it can call neither of those functions (no
  // low-level call, no delegatecall, no receive, no fallback), so the seat would be permanently
  // unclaimable AND permanently un-reassignable. See runner/launchpad-inlet.ts.
  //
  // Every method here throws a clear, actionable error when the inlet is unconfigured, and
  // config.modes.launchpadInletLive keeps callers away, so an unset hook is a silent no-op rather
  // than a 4x/day error loop.
  //
  // The PUBLIC address of the configured collector key, or null when there is none (inlet dark).
  // Compared against the hook's on-chain creator() before any claim is attempted.
  readonly careFeeCollectorAddress: string | null;
  // Native (gas) balance of the COLLECTOR wallet in wei, 0n when unconfigured. A third dedicated
  // signer is a third gas tank nobody tops up by habit, and a dry collector stalls the whole
  // revenue inlet exactly as invisibly as a wrong key.
  careFeeCollectorBalanceWei(): Promise<bigint>;
  // The hook's WHOLE config row for our pool id. READ, never assumed, on every cycle.
  //
  // WHY THE WHOLE ROW AND NOT JUST THE SEAT. The real read on the live hook is the poolConfigs
  // mapping getter, which hands back the creator seat AND the quote token AND the exists flag in one
  // call. Reading only the seat threw away the two facts that decide whether a claim can land
  // anywhere useful, for no extra RPC. See LaunchpadPoolConfig.
  launchpadPoolConfig(): Promise<LaunchpadPoolConfig>;
  // Convenience: element 0 of the row above. Kept because the seat is the single most important
  // field and several call sites only care about it.
  launchpadCreator(): Promise<string>;
  // COLLECTOR-SIGNED: hook.claim(poolId). Pulls whatever the creator seat has accrued to the
  // collector wallet. Throws a clear error when no collector key is configured.
  launchpadClaim(): Promise<{ txHash: string }>;
  // COLLECTOR-SIGNED: hook.claim(poolId, splitter). The DEFAULT path on a hook that offers the
  // two-argument claim. Pays the accrued creator share STRAIGHT to the CareFeeSplitter, so there is
  // no forward transaction to fail and the collector EOA never holds revenue at any point.
  // Like collectorForwardToSplitter it takes NO recipient argument on purpose: the destination is
  // fixed in the chain layer so no call site, present or future, can turn the inlet into a
  // withdrawal.
  launchpadClaimToSplitter(): Promise<{ txHash: string }>;
  // The collector wallet's fee-token (USDG) balance: what is waiting to be forwarded. Read
  // separately from the claim so a run that claimed successfully but failed to forward is picked
  // up and completed by the next run.
  collectorFeeTokenBalance(): Promise<bigint>;
  // COLLECTOR-SIGNED: move `amount` of the fee token from the collector to the CareFeeSplitter,
  // where the existing permissionless distribute() takes over. The ONLY destination, on purpose.
  collectorForwardToSplitter(amount: bigint): Promise<{ txHash: string }>;

  // Balance map of an ERC-20's holders, folded from its Transfer history starting at
  // `fromBlock`. Returns EVERY non-zero balance; the snapshot job then keeps only
  // addresses linked to a LIVE pet (owner or the pet's TBA), Hunt's live-pet gate.
  tokenHolderBalances(token: string, fromBlock: number): Promise<Map<string, bigint>>;

  txUrl(txHash: string): string;
  addressUrl(address: string): string;
}
