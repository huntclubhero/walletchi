import { randomBytes } from "node:crypto";
import { config } from "../config.js";
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

// Deterministic-ish in-memory chain for the smoke test and stub relayer mode.
// It models pet mint + the LAST-PET-STANDING vault (timer-based permanent death,
// two-slot leader/runnerUp tracker, permissionless finalize) so the season/claim
// machinery can be verified end to end. It never touches a network. Loudly
// labelled STUB.
export class MockChain implements Chain {
  readonly live = false;
  readonly chainId = config.robinhood.chainId;
  readonly explorer = config.robinhood.explorer;
  // Deterministic placeholder relayer address (no real key in stub mode).
  readonly relayerAddress = `0x${Buffer.from("relayer").toString("hex").padEnd(40, "0")}`;
  // Stub gas balance: comfortably above any low-balance threshold.
  async relayerBalanceWei(): Promise<bigint> {
    return 10n ** 18n;
  }
  // Stub burn ledger: a believable number for stats-band renders in dev.
  async burnedCareTotal(): Promise<bigint> {
    return 378_450n * 10n ** 18n;
  }
  // Stub TBA balance: the founder-demo seed amount.
  async careBalanceOf(_address: string): Promise<bigint> {
    return 100n * 10n ** 18n;
  }
  // Legacy runner-era state: a separate token id space + aggregate state per runner.
  private nextRunnerTokenId = 1;
  private runners = new Map<string, RunnerState>(); // tokenId -> runner state
  // Pet721 ownership model (claim flow): tokenId -> current owner. Minting sets
  // the recipient; the setPetOwnerMock hook simulates a secondary-market transfer.
  private petOwners = new Map<string, string>();
  // Spec-floor 1271 fallback: registered contract-account signers (address ->
  // predicate over the signed message + signature). Empty by default, so a plain
  // EOA never matches; a test registers a predicate to exercise the 1271 branch.
  private contractSigners = new Map<string, (message: string, signature: string) => boolean>();
  // WALLETCHI vault (last-pet-standing model, FIVE NEEDS). Each hatched pet
  // carries five per-need stamps (index = canonical actionType 0=FEED 1=WATER
  // 2=PLAY 3=TOY 4=EXPLORE); death is DERIVED from the clock on the WEAKEST
  // need (min(needAt) + lifeTtl <= now): there is no reap step and no revive.
  // The two-slot leader/runnerUpCareAt tracker is derived from the fed pets'
  // MIN-NEED scores (max + second max), which is exactly the invariant the
  // contract's O(1) tracker maintains (Lemma 1 by construction, including for
  // stamps seeded by test hooks). Records care calls so the smoke can assert
  // the seam fires; tracks per-token careCount for the memorial.
  public lastPetCare: { tokenId: string; actionType: number } | null = null;
  public petCareCalls = 0;
  private petCareCounts = new Map<string, number>();
  private petBornSec = new Map<string, number>();
  // Five per-need stamps per pet (index = actionType). Absent = dormant egg
  // (all zeros). Per-need deadline = needAt[i] + lifeTtl; the pet-level
  // deadline is min(needAt) + lifeTtl.
  private petNeedSec = new Map<string, number[]>();
  private lifeTtlSec = 3 * 86400;
  private minPlayers = 2;
  private potRaw = 0n;
  // Settlement (finalize pays the leader; potClaimed ends the game).
  private finalizedFlag = false;
  public settlementWinner: string | null = null;
  public settlementPrize = 0n;
  // Time-advancement hook: all timer math reads nowSec() so a test can warp the
  // clock forward (advanceTimeMock) instead of reaping.
  private timeOffsetSec = 0;
  // Injectable vault-event queue for the drama poller smoke (finalize also
  // enqueues the real Victory event).
  private eventQueue: VaultEvent[] = [];
  private eventBlock = 0;
  // WALLETCHI rewards model (inert stub). A fixed "current" epoch so a handful of
  // FINISHED epochs exist to push; a per-(tokenId,epoch) pending map with a
  // believable default so local dev shows earned rewards; a paid set the push
  // fills so the read drains afterwards.
  private rewardsEpochNowVal = 5;
  private rewardsPoolMap = new Map<string, bigint>(); // `${tokenId}:${epoch}` -> pending raw
  private rewardsClaimedSet = new Set<string>(); // `${tokenId}:${epoch}`
  // Participation points per (tokenId, epoch). Mirrors the contract's separate
  // points ledger, which is what keeps a DEAD pet's share findable: its pending
  // reads 0 (death zeroes it) while its points stay positive, and that pair is
  // exactly the forfeit signal the push engine looks for.
  private rewardsPointsMap = new Map<string, bigint>();
  private residualSweptFlag = false;
  // Season-2 push bookkeeping the smoke asserts on: what actually got paid, what
  // got forfeited, and what was skipped for being dead.
  public pushedRewards: { epoch: number; tokenId: string; raw: bigint }[] = [];
  public forfeitedRewards: { epoch: number; tokenId: string }[] = [];
  public residualSweptTo: string | null = null;
  // ESCROW AND RE-PUSH: prizes finalize() could not deliver. Empty by default (the
  // mock care token never refuses); mockDeferPrize stages the hostile-token case.
  private unpaidPrizeMap = new Map<string, bigint>();
  public prizePushes: { tokenId: string; raw: bigint }[] = [];

  private fakeHash(): string {
    return `0x${randomBytes(32).toString("hex")}`;
  }
  private fakeAddress(seed: string): string {
    return `0x${Buffer.from(seed).toString("hex").padEnd(40, "0").slice(0, 40)}`;
  }
  private nowSec(): number {
    return Math.floor(Date.now() / 1000) + this.timeOffsetSec;
  }

  txUrl(txHash: string): string {
    return `${this.explorer}/tx/${txHash}`;
  }
  addressUrl(address: string): string {
    return `${this.explorer}/address/${address}`;
  }

  // Legacy runner-era surface.

  // One pet, submit-and-wait (scripts). The API mints through the three pipelined calls below.
  async issueRunner(to: string): Promise<IssueResult> {
    const prepared = await this.prepareMint(to);
    const ticket = await this.submitMint(prepared);
    return this.awaitMint(ticket);
  }

  // ---- The pipelined mint, with a SIMULATED BLOCK CLOCK ---------------------
  //
  // The real chain assigns the token when the transaction MINES, not when it is
  // sent, and it mines our transactions in nonce order. The mock keeps that shape
  // so the load rehearsal measures pipelining honestly: submitMint returns at once
  // (a broadcast), and awaitMint resolves `mockBlockMs` later, never before the
  // previous nonce has resolved. With the default of 0 ms the smoke suite sees the
  // old instant mint. The budget is consumed at mining time, exactly where
  // PetIssuer._consumeMintBudget runs, which is why a burst that crosses the hourly
  // line is admitted by the pre-send simulate and refused at the receipt: the same
  // race the checkout pre-check has to close by counting in-flight mints.
  private mockBlockMs = 0;
  private mintNonce = 0;
  private pendingMints = new Map<number, { to: string; hash: string; submittedAt: number; minedPromise: Promise<IssueResult> | null }>();
  private lastMineChain: Promise<unknown> = Promise.resolve();

  mockSetBlockTimeMs(ms: number): void {
    this.mockBlockMs = Math.max(0, ms);
  }

  get unminedWrites(): number {
    return this.pendingMints.size;
  }

  /** The pre-send simulate: refuses on a SPENT window (like eth_call against latest state)
   *  but consumes nothing, so in-flight mints are invisible to it, like the real chain. */
  async prepareMint(to: string): Promise<PreparedMint> {
    if (this.mintBudgetVal.max > 0) {
      const nowSec = Math.floor(Date.now() / 1000);
      const rolled = nowSec >= this.mintBudgetVal.windowStart + this.mintBudgetVal.windowSecs;
      if (!rolled && this.mintBudgetVal.used >= this.mintBudgetVal.max) {
        const b = { ...this.mintBudgetVal };
        throw new MintBudgetExhaustedError(b, Math.max(0, b.windowStart + b.windowSecs - nowSec));
      }
    }
    return { to, via: "issuePet", gas: 400_000n };
  }

  async submitMint(prepared: PreparedMint, onSigned?: (ticket: MintTicket) => Promise<void>): Promise<MintTicket> {
    const nonce = this.mintNonce++;
    const ticket: MintTicket = { txHash: this.fakeHash(), nonce };
    // Persist-before-broadcast, like the real path: a throwing persist means no broadcast.
    if (onSigned) {
      try {
        await onSigned(ticket);
      } catch (err) {
        this.mintNonce = nonce;
        throw err;
      }
    }
    this.pendingMints.set(nonce, { to: prepared.to, hash: ticket.txHash, submittedAt: Date.now(), minedPromise: null });
    return ticket;
  }

  async awaitMint(ticket: MintTicket): Promise<IssueResult> {
    const entry = this.pendingMints.get(ticket.nonce);
    if (!entry || entry.hash !== ticket.txHash) {
      throw new Error(`MockChain: transaction ${ticket.txHash} (nonce ${ticket.nonce}) is not known to this chain`);
    }
    if (!entry.minedPromise) {
      // Mines one block time after ITS OWN broadcast, never before the previous nonce:
      // a block takes every pending transaction, so a burst pipelines (throughput is
      // the broadcast rate) while ordering is still by nonce.
      const prev = this.lastMineChain;
      const readyAt = entry.submittedAt + this.mockBlockMs;
      const mine = prev
        .catch(() => undefined)
        .then(() => {
          const wait = readyAt - Date.now();
          return wait > 0 ? new Promise<void>((r) => setTimeout(r, wait)) : undefined;
        })
        .then(() => {
          this.pendingMints.delete(ticket.nonce);
          return this.mintNow(entry.to, ticket.txHash);
        });
      this.lastMineChain = mine;
      entry.minedPromise = mine;
    }
    return entry.minedPromise;
  }

  /** A previous process's ticket: the mock keeps no memory across processes, so an unknown
   *  ticket is exactly what a replaced or never-broadcast transaction looks like on a node. */
  async recoverMint(ticket: MintTicket, _to: string): Promise<IssueResult> {
    return this.awaitMint(ticket);
  }

  // The moment of mining: PetIssuer._consumeMintBudget, then the token.
  private mintNow(to: string, txHash: string): IssueResult {
    // Mirrors PetIssuer._consumeMintBudget (max 0 = uncapped, the default, so every existing path
    // is untouched). A spent window reverts the mint, like the contract.
    if (this.mintBudgetVal.max > 0) {
      const nowSec = Math.floor(Date.now() / 1000);
      if (nowSec >= this.mintBudgetVal.windowStart + this.mintBudgetVal.windowSecs) {
        this.mintBudgetVal = { ...this.mintBudgetVal, windowStart: nowSec, used: 0 };
      }
      if (this.mintBudgetVal.used >= this.mintBudgetVal.max) {
        const b = { ...this.mintBudgetVal };
        throw new MintBudgetExhaustedError(b, Math.max(0, b.windowStart + b.windowSecs - nowSec));
      }
      this.mintBudgetVal = { ...this.mintBudgetVal, used: this.mintBudgetVal.used + 1 };
    }
    const tokenId = String(this.nextRunnerTokenId++);
    const tbaAddress = this.fakeAddress(`runner${tokenId}`);
    this.runners.set(tokenId, {
      tbaAddress,
      bestScore: 0,
      totalSalmon: 0,
      totalRuns: 0,
    });
    this.petOwners.set(tokenId, to);
    // register() sets bornAt but NOT the life timer: a fresh pet is a DORMANT EGG
    // with lastCareAt = 0 (see lastCareOf() ?? 0). The clock starts on the FIRST
    // care/hatch, exactly like PetVault. Stamping lastCareAt here would make a
    // never-fed egg look fed (the "egg dies the moment you feed it" bug) and
    // is why the mock previously could not regression-test that fix.
    this.petBornSec.set(tokenId, this.nowSec());
    return { txHash, tokenId, tbaAddress };
  }

  // Like the live issuer's accountOf: independent of runnerState, which the live issuer reverts.
  async tokenAccountOf(tokenId: string): Promise<string> {
    const s = this.runners.get(tokenId);
    if (!s) throw new Error(`accountOf: unknown token ${tokenId}`);
    return s.tbaAddress;
  }

  async runnerState(tokenId: string): Promise<RunnerState> {
    const s = this.runners.get(tokenId);
    if (!s) {
      return {
        tbaAddress: this.fakeAddress("none"),
        bestScore: 0,
        totalSalmon: 0,
        totalRuns: 0,
      };
    }
    return { ...s };
  }

  // ---- Last-pet-standing internals ----------------------------------------

  // A pet is registered when it exists (issueRunner registers) OR when a test
  // seeded care state for a bare tokenId via mockSetPetCare / mockSetPetNeed.
  private isRegistered(tokenId: string): boolean {
    return (
      this.runners.has(tokenId) ||
      this.petCareCounts.has(tokenId) ||
      this.petNeedSec.has(tokenId)
    );
  }

  // The five raw need stamps, canonical actionType order. All zeros for a
  // dormant egg or an unknown id, exactly like the contract's needsOf.
  private needsOfSync(tokenId: string): number[] {
    const n = this.petNeedSec.get(tokenId);
    return n ? [...n] : [0, 0, 0, 0, 0];
  }

  // The pet's MIN-NEED stamp (its weakest link): the deadline anchor, and what
  // petState.lastCareAt now reports (matching the contract). A never-cared pet
  // reads 0 (the vault does NOT stamp needs at register(): the clock starts on
  // the first feed / hatch). This MUST match the real contract: an earlier
  // `?? nowSec()` fallback made a dormant egg look fully alive in the mock and
  // hid the "egg dies the moment you feed it" bug.
  private lastCareOf(tokenId: string): number {
    const n = this.petNeedSec.get(tokenId);
    if (!n || n.length === 0) return 0;
    return Math.min(...n);
  }

  private careCountOf(tokenId: string): number {
    return this.petCareCounts.get(tokenId) ?? 0;
  }

  // Timer-based permanent death: registered && cared at least once && ANY need
  // unserved for a full lifeTtl (min-need stamp + lifeTtl <= now). A never-fed
  // egg (careCount == 0) is DORMANT, not dead: its clocks have not started, so
  // it can never be past a deadline it does not have.
  //
  // ONE EXEMPTION (season 2): the champion is IMMORTAL. Once the pot is paid, the
  // winning pet reads alive and never dead, forever, so the trophy carrying the
  // whole prize is never a memorial. By the time the last rival lapses the leader
  // has usually lapsed too, so this is the ordinary case and not a corner.
  //
  // The seat is FROZEN at finalize, exactly as on-chain: care() reverts GameOver
  // from then on, so nothing can move the leader afterwards. That freeze is what
  // makes immortality safe to hang off it, and it is why a champion whose clock
  // lapses after the win does not quietly hand the crown to a livelier pet.
  private currentLeader(): string {
    if (this.finalizedFlag && this.settlementWinner) return this.settlementWinner;
    return this.twoSlot().leader;
  }
  private immortal(tokenId: string): boolean {
    return this.finalizedFlag && tokenId === this.currentLeader();
  }
  private isDeadNow(tokenId: string): boolean {
    if (!this.isRegistered(tokenId)) return false;
    if (this.immortal(tokenId)) return false;
    if (this.careCountOf(tokenId) === 0) return false;
    return this.lastCareOf(tokenId) + this.lifeTtlSec <= this.nowSec();
  }

  private hatchedCountNow(): number {
    let n = 0;
    for (const c of this.petCareCounts.values()) if (c > 0) n += 1;
    return n;
  }

  // The two-slot tracker, derived and MIN-NEED KEYED since the five-needs
  // redesign (leader = fed pet with the global max MIN-NEED score;
  // runnerUpCareAt = the best min-need score of any OTHER fed pet). A care on a
  // non-weakest need does NOT move a pet's score, exactly like the contract.
  // Deriving from the full map preserves the contract's proven invariant by
  // construction, including for stamps seeded by test hooks.
  private twoSlot(): { leader: string; leaderCareAt: number; runnerUpCareAt: number } {
    let leader = "0";
    let leaderCareAt = 0;
    let runnerUpCareAt = 0;
    for (const [tokenId, count] of this.petCareCounts) {
      if (count <= 0) continue;
      const at = this.lastCareOf(tokenId); // min-need score
      if (leader === "0" || at > leaderCareAt) {
        if (leader !== "0") runnerUpCareAt = Math.max(runnerUpCareAt, leaderCareAt);
        leader = tokenId;
        leaderCareAt = at;
      } else {
        runnerUpCareAt = Math.max(runnerUpCareAt, at);
      }
    }
    return { leader, leaderCareAt, runnerUpCareAt };
  }

  private isOverNow(): boolean {
    if (this.finalizedFlag) return false;
    const { leader, runnerUpCareAt } = this.twoSlot();
    if (leader === "0") return false;
    if (this.hatchedCountNow() < this.minPlayers) return false;
    return this.nowSec() >= runnerUpCareAt + this.lifeTtlSec;
  }

  // WALLETCHI PetVault (last-pet-standing stub). TEST HOOK, no longer on the
  // Chain interface: care() is OWNER-ONLY on-chain now, so the server never
  // relays it. Tests call this directly to simulate an OWNER-SIGNED on-chain
  // care (the web AA path) that the server then reconciles via petState reads.
  // Mirrors the contract's guards: GameOver once the pot is claimed, PERMANENT
  // death (PetIsDead on a lapsed pet: no revive), then records the call, resets
  // the life timer, and accrues a believable pot slice.
  async careForPet(tokenId: string, actionType: number): Promise<{ txHash: string }> {
    // Five needs: an out-of-range actionType has no need to reset (BadAction).
    if (!Number.isInteger(actionType) || actionType < 0 || actionType >= 5) {
      throw new Error("mock: BadAction");
    }
    if (this.finalizedFlag) throw new Error("mock: GameOver");
    if (this.isDeadNow(tokenId)) throw new Error("mock: PetIsDead");
    const now = this.nowSec();
    if (this.careCountOf(tokenId) === 0) {
      // HATCH: the first care fills ALL FIVE bowls at this instant, whatever
      // the paid actionType (the contract stamps all five in the hatch tx).
      this.petNeedSec.set(tokenId, [now, now, now, now, now]);
    } else {
      // Post-hatch: care refreshes ONLY the targeted need.
      const needs = this.petNeedSec.get(tokenId) ?? [0, 0, 0, 0, 0];
      needs[actionType] = now;
      this.petNeedSec.set(tokenId, needs);
    }
    this.lastPetCare = { tokenId, actionType };
    this.petCareCalls += 1;
    this.petCareCounts.set(tokenId, (this.petCareCounts.get(tokenId) ?? 0) + 1);
    this.potRaw += 10n ** 17n; // 10% pot slice of the 1e18 careCost
    return { txHash: this.fakeHash() };
  }

  async careTokenDecimals(): Promise<number> {
    return 18; // MockCareToken is 18dp
  }

  async petVaultConfig(): Promise<PetVaultConfig> {
    return { careCostRaw: 1_000_000_000_000_000_000n, lifeTtlSeconds: this.lifeTtlSec, careCooldownSeconds: 30 };
  }

  async petVaultStats(): Promise<PetVaultStats> {
    return {
      potRaw: this.potRaw,
      registeredCount: this.runners.size,
      hatchedCount: this.hatchedCountNow(),
      lifeTtlSeconds: this.lifeTtlSec,
    };
  }

  /// MockChain models the CLOCK season (started at construction), which keeps every existing
  /// stub-mode path behaving exactly as before. The sellout lifecycle is pinned on the real
  /// contract by forge (SelloutSeason.t.sol), not simulated here.
  async seasonGate(): Promise<SeasonGate> {
    return {
      selloutStartsSeason: false,
      startedAt: this.seasonStartSec,
      entryOpen: true,
      minted: this.runners.size,
      maxSupply: 0,
      entryDeadline: this.seasonStartSec + 60 * 86400,
      seasonStart: this.seasonStartSec,
    };
  }
  private readonly seasonStartSec = Math.floor(Date.now() / 1000);

  // --- Mint budget (PetIssuer). Uncapped by default; tests arm it via mockSetMintBudget. ---
  private mintBudgetVal: MintBudgetState = { max: 0, windowSecs: 0, windowStart: 0, used: 0 };
  async mintBudgetState(): Promise<MintBudgetState> {
    return { ...this.mintBudgetVal };
  }
  mockSetMintBudget(state: MintBudgetState): void {
    this.mintBudgetVal = { ...state };
  }

  async startSeason(): Promise<{ txHash: string }> {
    throw new Error("MockChain: startSeason is only meaningful on a live sellout season");
  }

  async petAlive(tokenId: string): Promise<boolean> {
    return this.isRegistered(tokenId) && !this.isDeadNow(tokenId);
  }

  async petState(tokenId: string): Promise<PetLifeState> {
    const registered = this.isRegistered(tokenId);
    const dead = this.isDeadNow(tokenId);
    // MIN-NEED stamp (the weakest link), matching the contract's petState:
    // deadline = lastCareAt + lifeTtl still holds exactly under five needs.
    const lastCareAt = this.lastCareOf(tokenId);
    const deadline = lastCareAt + this.lifeTtlSec;
    const now = this.nowSec();
    // isAlive requires HATCHED (careCount > 0), matching the vault: a dormant
    // egg reports isAlive == false and secondsLeft == 0 because its clock has
    // not started, NOT because it is dead (dead stays false until it is fed and
    // then lapses). Consumers must treat (!dead && lastCareAt == 0) as a live egg.
    const hatched = this.careCountOf(tokenId) > 0;
    return {
      registered,
      dead,
      isAlive: registered && !dead && hatched,
      lastCareAt,
      secondsLeft: registered && !dead && hatched && deadline > now ? deadline - now : 0,
    };
  }

  // The five raw need stamps (contract needsOf). All zeros for a dormant egg
  // AND an unknown id; frozen stamps once dead (view honesty, gate on alive).
  // Spend windows for tests (keyed by lower-case account address); unknown accounts read as null.
  readonly spendStates = new Map<string, PetSpendState>();
  async petSpendState(account: string): Promise<PetSpendState | null> {
    return this.spendStates.get(account.toLowerCase()) ?? null;
  }

  async petNeeds(tokenId: string): Promise<PetNeeds> {
    const n = this.needsOfSync(tokenId);
    return { needAt: [n[0]!, n[1]!, n[2]!, n[3]!, n[4]!] };
  }

  async petMemorial(tokenId: string): Promise<PetMemorial> {
    const dead = this.isDeadNow(tokenId);
    return {
      dead,
      bornAt: this.petBornSec.get(tokenId) ?? 0,
      // diedAt = min-need stamp + lifeTtl: the exact instant the weakest need
      // lapsed, even though other stamps may be newer (they freeze at death).
      diedAt: dead ? this.lastCareOf(tokenId) + this.lifeTtlSec : 0,
      careCount: this.petCareCounts.get(tokenId) ?? 0,
      rank: 0, // rank is off-chain in the last-pet-standing model (contract returns 0)
    };
  }

  // Pet721 ownership + soulbound reads (claim flow).

  async petOwnerOf(tokenId: string): Promise<string> {
    const owner = this.petOwners.get(tokenId);
    if (!owner) throw new Error(`mock: ownerOf unknown token ${tokenId}`);
    return owner;
  }

  async petOwnersOf(tokenIds: string[]): Promise<(string | null)[]> {
    return tokenIds.map((id) => this.petOwners.get(id) ?? null);
  }

  // Pet721.isDead reads the vault's time-based death (soulbound memorial).
  async petIsDead(tokenId: string): Promise<boolean> {
    return this.isDeadNow(tokenId);
  }

  // ERC-1271 fallback: no on-chain code in the mock, so consult the registered
  // contract-signer predicate (default: none, returns false).
  async isValidErc1271Signature(
    address: string,
    message: string,
    signature: string,
  ): Promise<boolean> {
    const predicate = this.contractSigners.get(address.toLowerCase());
    return predicate ? predicate(message, signature) : false;
  }

  // Settlement (last pet standing). The game is over the instant no pet other
  // than the leader has been fed within a full life window; finalize() re-checks
  // that and pays the leader. Mirrors the contract's revert set exactly so the
  // poke loop's "the contract is the judge" posture is exercised for real.
  async settlementState(): Promise<SettlementState> {
    const { leaderCareAt, runnerUpCareAt } = this.twoSlot();
    const leader = this.currentLeader();
    return {
      candidate: leader,
      candidateLastCareAt: leaderCareAt,
      winsAt: leader === "0" ? 0 : runnerUpCareAt + this.lifeTtlSec,
      finalized: this.finalizedFlag,
    };
  }

  async isOver(): Promise<boolean> {
    return this.isOverNow();
  }

  async leader(): Promise<string> {
    return this.currentLeader();
  }

  async finalizeSeason(): Promise<{ txHash: string }> {
    if (this.finalizedFlag) throw new Error("mock: GameOver");
    const { leader, runnerUpCareAt } = this.twoSlot();
    if (leader === "0" || this.hatchedCountNow() < this.minPlayers) {
      throw new Error("mock: NotEnoughPlayers");
    }
    if (this.nowSec() < runnerUpCareAt + this.lifeTtlSec) throw new Error("mock: GameNotOver");
    this.finalizedFlag = true;
    this.settlementWinner = leader;
    this.settlementPrize = this.potRaw;
    this.potRaw = 0n;
    this.eventQueue.push({
      kind: "victory",
      tokenId: leader,
      tba: this.runners.get(leader)?.tbaAddress ?? this.fakeAddress(`tba${leader}`),
      prize: this.settlementPrize,
      block: ++this.eventBlock,
    });
    return { txHash: this.fakeHash() };
  }

  async vaultEventsSince(_fromBlock: number): Promise<{ events: VaultEvent[]; toBlock: number }> {
    const events = this.eventQueue;
    this.eventQueue = [];
    return { events, toBlock: _fromBlock + events.length };
  }

  // WALLETCHI player rewards (inert stub). Believable numbers so the smoke +
  // local dev exercise the read/push without a chain: a fixed current epoch, a
  // small default pending in the most recent finished epochs, and a paid set the
  // push fills. mockSetReward pins an epoch for deterministic assertions.
  async rewardsEpochNow(): Promise<number> {
    return this.rewardsEpochNowVal;
  }

  /** The stub's raw entitlement, BEFORE the paid/dead zeroing pendingReward applies. */
  private rewardShareOf(tokenId: string, epoch: number): bigint {
    const key = `${tokenId}:${epoch}`;
    if (this.rewardsPoolMap.has(key)) return this.rewardsPoolMap.get(key)!;
    // Default: reward only in the three most recent FINISHED epochs, amount derived
    // from the tokenId so it is stable and non-zero for a demo pet.
    const now = this.rewardsEpochNowVal;
    if (epoch >= now || epoch < now - 3) return 0n;
    const whole = (BigInt(tokenId) % 7n) + 1n; // 1..7 whole CARE
    return whole * 10n ** 18n;
  }

  async rewardsPending(tokenId: string, epoch: number): Promise<bigint> {
    if (this.rewardsClaimedSet.has(`${tokenId}:${epoch}`)) return 0n;
    // THE SPLIT THE PUSH ENGINE KEYS OFF, mirrored from the contract: a dead pet's
    // pending is 0 while its points stay positive, so a share that reads 0 with
    // points behind it is a FORFEIT, not an empty epoch. The champion is exempt
    // (isDeadNow honours immortality), so it is pushed like any living pet.
    if (this.isDeadNow(tokenId)) return 0n;
    return this.rewardShareOf(tokenId, epoch);
  }

  async rewardsClaimed(tokenId: string, epoch: number): Promise<boolean> {
    return this.rewardsClaimedSet.has(`${tokenId}:${epoch}`);
  }

  // Points survive death, which is what makes a dead pet's forfeit findable.
  async rewardsPoints(tokenId: string, epoch: number): Promise<bigint> {
    const key = `${tokenId}:${epoch}`;
    if (this.rewardsPointsMap.has(key)) return this.rewardsPointsMap.get(key)!;
    // Default: a pet has a point in any epoch it has a share in, so the stub's
    // "believable default" rewards are pushable without staging points by hand.
    return this.rewardShareOf(tokenId, epoch) > 0n ? 1n : 0n;
  }

  async rewardsResidualSwept(): Promise<boolean> {
    return this.residualSweptFlag;
  }

  // PUSH: mirrors pushRewards. Batch-level reverts are real (SeasonSettled,
  // EpochNotFinished, NoPoints); per-pet problems are SKIPPED, never thrown, so a
  // dead or already-paid id in the batch cannot cost the others their payout.
  async rewardsPushMany(epoch: number, tokenIds: string[]): Promise<{ txHash: string }> {
    if (this.residualSweptFlag) throw new Error("mock: SeasonSettled");
    if (epoch >= this.rewardsEpochNowVal) throw new Error("mock: EpochNotFinished");
    let anyPoints = false;
    for (const id of tokenIds) {
      if ((await this.rewardsPoints(id, epoch)) > 0n) anyPoints = true;
    }
    if (!anyPoints) throw new Error("mock: NoPoints");
    for (const tokenId of tokenIds) {
      const key = `${tokenId}:${epoch}`;
      if (this.rewardsClaimedSet.has(key)) continue;
      if ((await this.rewardsPoints(tokenId, epoch)) === 0n) continue;
      if (this.isDeadNow(tokenId)) continue; // forfeits via sweepForfeited, never pushed
      this.rewardsClaimedSet.add(key);
      this.pushedRewards.push({ epoch, tokenId, raw: this.rewardShareOf(tokenId, epoch) });
    }
    return { txHash: this.fakeHash() };
  }

  // FORFEIT: a dead pet's unclaimed share moves to a future pool. ONE live pet in
  // the list reverts the whole call, exactly as on-chain, so a caller that forgets
  // to filter fails here rather than in production.
  async rewardsSweepForfeited(epoch: number, tokenIds: string[]): Promise<{ txHash: string }> {
    if (epoch >= this.rewardsEpochNowVal) throw new Error("mock: EpochNotFinished");
    for (const tokenId of tokenIds) {
      const key = `${tokenId}:${epoch}`;
      if (this.rewardsClaimedSet.has(key)) continue;
      if ((await this.rewardsPoints(tokenId, epoch)) === 0n) continue;
      if (!this.isDeadNow(tokenId)) throw new Error("mock: PetIsAlive");
      this.rewardsClaimedSet.add(key);
      this.forfeitedRewards.push({ epoch, tokenId });
    }
    return { txHash: this.fakeHash() };
  }

  async rewardsSweepResidual(): Promise<{ txHash: string }> {
    if (!this.finalizedFlag) throw new Error("mock: SeasonNotOver");
    if (this.residualSweptFlag) throw new Error("mock: AlreadySwept");
    this.residualSweptFlag = true;
    this.residualSweptTo = this.currentLeader();
    return { txHash: this.fakeHash() };
  }

  // ESCROW AND RE-PUSH. The mock care token never refuses, so nothing is escrowed
  // until a test stages it with mockDeferPrize.
  async vaultUnpaidPrize(tokenId: string): Promise<bigint> {
    return this.unpaidPrizeMap.get(tokenId) ?? 0n;
  }

  async vaultPushPrize(tokenId: string): Promise<{ txHash: string }> {
    const owed = this.unpaidPrizeMap.get(tokenId) ?? 0n;
    if (owed === 0n) throw new Error("mock: NothingToPush");
    this.unpaidPrizeMap.set(tokenId, 0n);
    this.prizePushes.push({ tokenId, raw: owed });
    return { txHash: this.fakeHash() };
  }

  // Test hooks: pin the current epoch, set an explicit per-epoch pending, give a
  // pet points without a share, and stage a prize the care token refused.
  setRewardsEpochNowMock(epoch: number): void {
    this.rewardsEpochNowVal = epoch;
  }
  mockSetReward(tokenId: string, epoch: number, raw: bigint): void {
    this.rewardsPoolMap.set(`${tokenId}:${epoch}`, raw);
    this.rewardsPointsMap.set(`${tokenId}:${epoch}`, raw > 0n ? 1n : 0n);
    this.rewardsClaimedSet.delete(`${tokenId}:${epoch}`);
  }
  mockSetRewardPoints(tokenId: string, epoch: number, points: bigint): void {
    this.rewardsPointsMap.set(`${tokenId}:${epoch}`, points);
  }
  mockDeferPrize(tokenId: string, raw: bigint): void {
    this.unpaidPrizeMap.set(tokenId, raw);
  }

  // --- TAX ECONOMY (inert stub): splitter + holder vault (USDG airdrops) ---
  // Deterministic state the smoke drives via the mock hooks below; empty at start
  // the way a fresh season is.
  private splitterBalanceVal = 0n;
  private holderRoundsMock: { root: string; total: bigint; claimed: Set<string> }[] = [];
  private holderUnreservedVal = 0n;
  private holderBalancesFixture = new Map<string, bigint>();

  // POSTER SEAM (mainnet blocker B2). The live vault gates postRound on a DEDICATED poster key
  // that is never the relayer, so the stub models the same gate: a round posted with the wrong
  // signer throws NotPoster here exactly as it reverts on-chain.
  //
  // DEFAULTS MODEL A CORRECTLY CONFIGURED SEASON (poster key present, matching the vault's
  // poster, cap armed, not paused), because that is the deployed reality and it keeps the stub
  // usable as a plain fixture. Every failure mode this file has to prove (no key, wrong key,
  // unarmed cap, over cap, paused) is driven deliberately through the hooks below, so no test
  // can accidentally depend on a broken default.
  private posterKeyAddressVal: string | null =
    config.holderPosterAddress ?? `0x${Buffer.from("poster").toString("hex").padEnd(40, "0")}`;
  private onChainPosterVal: string =
    config.holderPosterAddress ?? `0x${Buffer.from("poster").toString("hex").padEnd(40, "0")}`;
  // Armed high enough to be inert unless a test lowers it; the deployed vault is armed at
  // 100000e6 USDG. 0 would mean RoundCapNotArmed, which is the unarmed case, not the normal one.
  private maxRoundTotalVal = 10n ** 30n;
  private postingPausedVal = false;
  /** The address that signed the LAST successful postRound. The smoke asserts it is the poster, not the relayer. */
  public lastPostRoundSigner: string | null = null;

  // The configured poster key's PUBLIC address (null = posting dark), mirroring RobinhoodChain.
  get holderPosterAddress(): string | null {
    return this.posterKeyAddressVal;
  }

  // Stub poster gas balance: funded when a poster exists, 0 when there is none (same shape as
  // the live read, which returns 0n for an unconfigured poster).
  async holderPosterBalanceWei(): Promise<bigint> {
    return this.posterKeyAddressVal ? this.posterBalanceWeiVal : 0n;
  }
  private posterBalanceWeiVal = 10n ** 18n;
  /** Drive the poster's gas tank (0 models the unfunded key that stalls every round). */
  mockSetPosterBalanceWei(wei: bigint): void {
    this.posterBalanceWeiVal = wei;
  }

  async splitterBalance(): Promise<bigint> {
    return this.splitterBalanceVal;
  }

  // TESTNET SHOWCASE: the MockUSDG faucet mint into the splitter, and the splitter's rate hint.
  // The rate starts FRESH (as a fresh deploy leaves it) and owned by the relayer, like the testnet
  // deploy where the deployer is both. Tests age it or reassign the owner through the hooks.
  public showcaseMints: bigint[] = [];
  async showcaseMintFeeToSplitter(amount: bigint): Promise<{ txHash: string }> {
    this.splitterBalanceVal += amount;
    this.showcaseMints.push(amount);
    return { txHash: this.fakeHash() };
  }
  private splitterRateVal: SplitterRateState = {
    rate: 10n ** 30n,
    lastNonzeroRate: 10n ** 30n,
    slippageBps: 300,
    updatedAt: Math.floor(Date.now() / 1000),
    maxAge: 12 * 3600,
    owner: this.relayerAddress,
  };
  public rateReaffirms = 0;
  async splitterRateState(): Promise<SplitterRateState> {
    return { ...this.splitterRateVal };
  }
  async splitterReaffirmRate(slippageBps: number, rate: bigint): Promise<{ txHash: string }> {
    // Mirrors setSwapParams: onlyOwner, and a non-decreasing rate re-stamps rateUpdatedAt.
    if (this.splitterRateVal.owner.toLowerCase() !== this.relayerAddress.toLowerCase()) {
      throw new Error("OwnableUnauthorizedAccount");
    }
    if (rate < this.splitterRateVal.lastNonzeroRate) throw new Error("RateUpdateTooSoon");
    this.splitterRateVal = {
      ...this.splitterRateVal,
      rate,
      lastNonzeroRate: rate,
      slippageBps,
      updatedAt: Math.floor(Date.now() / 1000),
    };
    this.rateReaffirms += 1;
    return { txHash: this.fakeHash() };
  }
  mockSetSplitterRate(patch: Partial<SplitterRateState>): void {
    this.splitterRateVal = { ...this.splitterRateVal, ...patch };
  }

  async splitterDistribute(): Promise<{ txHash: string }> {
    if (this.splitterBalanceVal === 0n) throw new Error("NothingToDistribute");
    // Mirror the contract: half to the holder vault, half to the player pool of
    // the CURRENT epoch (readable back via taxPending once a test assigns points;
    // the stub just tracks the holder side, which is what the job asserts on).
    this.holderUnreservedVal += this.splitterBalanceVal / 2n;
    this.splitterBalanceVal = 0n;
    return { txHash: this.fakeHash() };
  }

  async holderRoundCount(): Promise<number> {
    return this.holderRoundsMock.length;
  }

  async holderUnreserved(): Promise<bigint> {
    return this.holderUnreservedVal;
  }

  async holderPoster(): Promise<string> {
    return this.onChainPosterVal;
  }

  async holderMaxRoundTotal(): Promise<bigint> {
    return this.maxRoundTotalVal;
  }

  async holderPostingPaused(): Promise<boolean> {
    return this.postingPausedVal;
  }

  // Mirrors the hardened contract's revert ladder IN ORDER, so a test that passes here is
  // testing the same fail-closed behaviour the vault enforces:
  //   no poster key -> the client cannot sign at all (RobinhoodChain throws the same way)
  //   msg.sender != poster -> NotPoster
  //   postingPaused -> PostingIsPaused
  //   rounds.length != expectedRoundId -> UnexpectedRoundId
  //   maxRoundTotal == 0 -> RoundCapNotArmed (FAIL CLOSED: unarmed is not "unlimited")
  //   total > maxRoundTotal -> OverRoundCap
  //   total > unreserved -> RoundNotBacked
  async holderPostRound(expectedRoundId: number, root: string, total: bigint): Promise<{ txHash: string }> {
    if (!this.posterKeyAddressVal) {
      throw new Error(
        "HOLDER_POSTER_PRIVATE_KEY not set: HolderMerkleVault.postRound is gated on a DEDICATED poster key",
      );
    }
    if (this.posterKeyAddressVal.toLowerCase() !== this.onChainPosterVal.toLowerCase()) {
      throw new Error("NotPoster");
    }
    if (this.postingPausedVal) throw new Error("PostingIsPaused");
    if (this.holderRoundsMock.length !== expectedRoundId) throw new Error("UnexpectedRoundId");
    if (this.maxRoundTotalVal === 0n) throw new Error("RoundCapNotArmed");
    if (total > this.maxRoundTotalVal) throw new Error("OverRoundCap");
    if (total === 0n || total > this.holderUnreservedVal) throw new Error("RoundNotBacked");
    this.holderUnreservedVal -= total;
    this.holderRoundsMock.push({ root, total, claimed: new Set() });
    // Record WHICH identity signed: the relayer signing this is the exact bug B2 is about, and an
    // assertion on the signer is the only way a stub can prove the right client was used.
    this.lastPostRoundSigner = this.posterKeyAddressVal;
    return { txHash: this.fakeHash() };
  }

  async holderClaimed(roundId: number, account: string): Promise<boolean> {
    return this.holderRoundsMock[roundId]?.claimed.has(account.toLowerCase()) ?? false;
  }

  async holderClaim(
    roundId: number,
    account: string,
    _amount: bigint,
    _proof: string[],
  ): Promise<{ txHash: string }> {
    const round = this.holderRoundsMock[roundId];
    if (!round) throw new Error("NoSuchRound");
    const key = account.toLowerCase();
    if (round.claimed.has(key)) throw new Error("AlreadyClaimed");
    round.claimed.add(key);
    return { txHash: this.fakeHash() };
  }

  async tokenHolderBalances(_token: string, _fromBlock: number): Promise<Map<string, bigint>> {
    return new Map(this.holderBalancesFixture);
  }

  // --- LAUNCHPAD CREATOR-FEE INLET (stub) ---
  //
  // Models the letscash hook's PULL semantics, which is the whole reason the inlet exists: the fee
  // does not stream anywhere, it accrues to a creator seat and only the CURRENT creator can pull
  // it. So the stub keeps an "accrued" bucket, refuses claim() from anyone who is not the seat
  // holder, and moves the money onto the collector's own fee-token balance rather than anywhere
  // useful. A test that passes against this is testing the same fail-closed shape the chain has.
  //
  // DEFAULTS MODEL A CORRECTLY CONFIGURED INLET (collector key present and holding the seat),
  // because that is the state the launch checklist produces; every failure mode is driven
  // deliberately through the hooks below so nothing can accidentally depend on a broken default.
  private collectorKeyAddressVal: string | null =
    config.careFeeCollectorAddress ?? `0x${Buffer.from("collector").toString("hex").padEnd(40, "0").slice(0, 40)}`;
  private onChainCreatorVal: string =
    config.careFeeCollectorAddress ?? `0x${Buffer.from("collector").toString("hex").padEnd(40, "0").slice(0, 40)}`;
  private hookAccruedVal = 0n;
  private collectorFeeTokenVal = 0n;
  private collectorBalanceWeiVal = 10n ** 18n;
  // THE QUOTE ASSET. undefined means "model a correctly configured pool", which is USDG-quoted:
  // resolved against config.FEE_TOKEN_ADDRESS at read time because the smoke suite sets that at
  // runtime. The ZERO ADDRESS models the trap every observed letscash launch fell into (a NATIVE ETH
  // quote, which the ERC-20 pipeline cannot move and the splitter cannot receive). null models a
  // hook whose read does not report a quote at all, which is UNKNOWN and must not read as a pass.
  private poolQuoteVal: string | null | undefined = undefined;
  private poolExistsVal = true;
  private poolCreatorFeeBpsVal: number | null = 9000; // the live 3% tier: 2.7% creator / 0.3% platform
  private poolFeeRateVal: number | null = 30000; // hundredths of a bip = 3%
  /** The address that signed the LAST successful claim. A relayer-signed claim is the bug. */
  public lastLaunchpadClaimSigner: string | null = null;
  /** Where the LAST claim was paid. null for the one-argument claim (paid to the seat holder). */
  public lastClaimToRecipient: string | null = null;
  /** The address that signed the LAST successful forward, and where it went. */
  public lastForwardSigner: string | null = null;

  get careFeeCollectorAddress(): string | null {
    return this.collectorKeyAddressVal;
  }

  async careFeeCollectorBalanceWei(): Promise<bigint> {
    return this.collectorKeyAddressVal ? this.collectorBalanceWeiVal : 0n;
  }

  // The WHOLE pool row, the same shape poolConfigs(bytes32) returns on the live hook. Defaults model
  // a correctly configured USDG pool on the 3% tier; every failure mode is driven deliberately
  // through the mockSet* hooks below.
  async launchpadPoolConfig(): Promise<LaunchpadPoolConfig> {
    return {
      creator: this.onChainCreatorVal,
      creatorFeeBps: this.poolCreatorFeeBpsVal,
      feeRate: this.poolFeeRateVal,
      exists: this.poolExistsVal,
      quote: this.poolQuoteVal === undefined ? (config.FEE_TOKEN_ADDRESS ?? null) : this.poolQuoteVal,
    };
  }

  async launchpadCreator(): Promise<string> {
    return (await this.launchpadPoolConfig()).creator;
  }

  // Mirrors the hook's revert ladder IN ORDER:
  //   no collector key   -> the client cannot sign at all (RobinhoodChain throws the same way)
  //   msg.sender != creator -> NotCreator (current-recipient-only, the property that makes
  //                            pointing the seat at the splitter unrecoverable)
  //   nothing accrued    -> NothingToClaim (a NORMAL state between trades, not a failure)
  async launchpadClaim(): Promise<{ txHash: string }> {
    if (!this.collectorKeyAddressVal) {
      throw new Error(
        "CARE_FEE_COLLECTOR_PRIVATE_KEY not set: the launchpad creator fee can only be claimed by " +
          "the account holding the creator seat",
      );
    }
    if (this.collectorKeyAddressVal.toLowerCase() !== this.onChainCreatorVal.toLowerCase()) {
      throw new Error("NotCreator");
    }
    if (this.hookAccruedVal === 0n) throw new Error("NothingToClaim");
    this.collectorFeeTokenVal += this.hookAccruedVal;
    this.hookAccruedVal = 0n;
    this.lastLaunchpadClaimSigner = this.collectorKeyAddressVal;
    this.lastClaimToRecipient = null;
    return { txHash: this.fakeHash() };
  }

  // The two-argument claim: SAME revert ladder, different destination. The accrued fee lands on the
  // splitter directly, which is exactly the balance distribute() then splits, so the collector's own
  // fee-token balance is untouched. That is the whole point of this path.
  async launchpadClaimToSplitter(): Promise<{ txHash: string }> {
    if (!this.collectorKeyAddressVal) {
      throw new Error(
        "CARE_FEE_COLLECTOR_PRIVATE_KEY not set: the launchpad creator fee can only be claimed by " +
          "the account holding the creator seat",
      );
    }
    if (this.collectorKeyAddressVal.toLowerCase() !== this.onChainCreatorVal.toLowerCase()) {
      throw new Error("NotCreator");
    }
    if (this.hookAccruedVal === 0n) throw new Error("NothingToClaim");
    this.splitterBalanceVal += this.hookAccruedVal;
    this.hookAccruedVal = 0n;
    this.lastLaunchpadClaimSigner = this.collectorKeyAddressVal;
    this.lastClaimToRecipient = config.FEE_SPLITTER_ADDRESS ?? null;
    return { txHash: this.fakeHash() };
  }

  async collectorFeeTokenBalance(): Promise<bigint> {
    return this.collectorFeeTokenVal;
  }

  async collectorForwardToSplitter(amount: bigint): Promise<{ txHash: string }> {
    if (!this.collectorKeyAddressVal) {
      throw new Error("CARE_FEE_COLLECTOR_PRIVATE_KEY not set: only the collector key can move the claimed fee");
    }
    if (amount <= 0n) throw new Error("collectorForwardToSplitter: amount must be positive");
    if (amount > this.collectorFeeTokenVal) throw new Error("ERC20InsufficientBalance");
    this.collectorFeeTokenVal -= amount;
    // The forward lands on the SPLITTER, which is exactly the balance splitterDistribute() splits.
    this.splitterBalanceVal += amount;
    this.lastForwardSigner = this.collectorKeyAddressVal;
    return { txHash: this.fakeHash() };
  }

  // Test hooks (launchpad inlet).
  /** Accrue trade tax to the creator seat inside the hook (what a buy/sell would do). */
  mockAccrueLaunchpadFee(raw: bigint): void {
    this.hookAccruedVal += raw;
  }
  /** Set the seat's accrued balance outright. 0 models a QUIET pool: claim() reverts, which is a
   *  normal state and not a fault, and is the case the inlet must not cry wolf about. */
  mockSetLaunchpadAccrued(raw: bigint): void {
    this.hookAccruedVal = raw;
  }
  /** What our configured collector KEY resolves to. null = no collector key (inlet dark). */
  mockSetCollectorKeyAddress(address: string | null): void {
    this.collectorKeyAddressVal = address;
  }
  /** The hook's ON-CHAIN creator. Set it different from the key to model a lost/rotated seat. */
  mockSetOnChainCreator(address: string): void {
    this.onChainCreatorVal = address;
  }
  /**
   * The pool's QUOTE asset. undefined = "whatever FEE_TOKEN_ADDRESS is" (a correct USDG pool);
   * the zero address models a NATIVE ETH pool, which is what every observed letscash launch
   * actually used and which our ERC-20 pipeline cannot handle at all; null models a hook shape
   * that does not report a quote (UNKNOWN, which the inlet must refuse on rather than assume).
   */
  mockSetPoolQuote(address: string | null | undefined): void {
    this.poolQuoteVal = address;
  }
  /** exists=false models a pool id the hook has never registered (a typo'd or phantom id). */
  mockSetPoolExists(exists: boolean): void {
    this.poolExistsVal = exists;
  }
  /** The economics fields, surfaced (not asserted) so /internal/status can show the real tier. */
  mockSetPoolFees(creatorFeeBps: number | null, feeRate: number | null): void {
    this.poolCreatorFeeBpsVal = creatorFeeBps;
    this.poolFeeRateVal = feeRate;
  }
  /** Seed the collector's fee-token balance directly (models a claim that never got forwarded). */
  mockSetCollectorFeeToken(raw: bigint): void {
    this.collectorFeeTokenVal = raw;
  }
  /** Drive the collector's gas tank (0 models the unfunded key that stalls the whole inlet). */
  mockSetCollectorBalanceWei(wei: bigint): void {
    this.collectorBalanceWeiVal = wei;
  }

  // Test hooks (tax economy).
  mockSetSplitterBalance(raw: bigint): void {
    this.splitterBalanceVal = raw;
  }
  mockSetHolderBalance(account: string, raw: bigint): void {
    if (raw === 0n) this.holderBalancesFixture.delete(account);
    else this.holderBalancesFixture.set(account, raw);
  }
  /** Seed the holder vault's unreserved balance directly (a splitter poke is the other way in). */
  mockSetHolderUnreserved(raw: bigint): void {
    this.holderUnreservedVal = raw;
  }
  /** The address our configured poster KEY resolves to. null = no poster key (posting dark). */
  mockSetPosterKeyAddress(address: string | null): void {
    this.posterKeyAddressVal = address;
  }
  /** The vault's ON-CHAIN poster(). Set it different from the key address to model a rotation. */
  mockSetOnChainPoster(address: string): void {
    this.onChainPosterVal = address;
  }
  /** The per-round ceiling. 0 models an UNARMED cap, which fails closed on-chain. */
  mockSetMaxRoundTotal(raw: bigint): void {
    this.maxRoundTotalVal = raw;
  }
  /** The owner's emergency stop. */
  mockSetPostingPaused(paused: boolean): void {
    this.postingPausedVal = paused;
  }

  // Test hooks (last pet standing).
  // Warp the mock clock forward: every timer (death deadlines, isOver) sees the
  // advanced time. The smoke drives time-past-deadline death with this or with
  // the per-pet expirePet below.
  advanceTimeMock(seconds: number): void {
    this.timeOffsetSec += seconds;
  }
  resetSeasonMock(): void {
    this.finalizedFlag = false;
    this.settlementWinner = null;
    this.settlementPrize = 0n;
    // Season-2 post-settlement state goes with it: a reset season has no swept
    // residual and no escrowed prize, or the next scenario inherits a settled one.
    this.residualSweptFlag = false;
    this.residualSweptTo = null;
    this.unpaidPrizeMap.clear();
  }
  /**
   * Put the season into its SETTLED state with a chosen champion: what
   * finalizeSeason() does, minus the requirement that the whole roster be arranged
   * so isOver() flips. The smoke needs the settled posture (immortal winner,
   * escrowed-prize retry, residual sweep) without re-killing every pet in the
   * store, and a scenario that has to expire twelve unrelated pets to reach the
   * state it wants tests the setup, not the behaviour.
   */
  mockSettleSeason(tokenId: string): void {
    this.finalizedFlag = true;
    this.settlementWinner = tokenId;
  }
  pushVaultEvent(ev: VaultEvent): void {
    this.eventQueue.push(ev);
  }
  // Seed a pet's care history (lastCareAt + careCount). Signature kept from the
  // single-timer game; under five needs it stamps ALL FIVE needs to lastCareSec
  // ("a fully cared pet at that instant"), which preserves the meaning of every
  // existing scenario: min == lastCareSec, deadline = lastCareSec + lifeTtl.
  // A careCount > 0 marks the pet as fed (hatched), which feeds the tracker.
  mockSetPetCare(tokenId: string, lastCareSec: number, careCount: number): void {
    this.petNeedSec.set(tokenId, [lastCareSec, lastCareSec, lastCareSec, lastCareSec, lastCareSec]);
    this.petCareCounts.set(tokenId, careCount);
  }
  // Seed ONE need stamp (index = canonical actionType 0..4), for single-need
  // death / binding-need scenarios. Seeds the needs array (and with it
  // registration: isRegistered consults the petNeedSec map) without touching
  // careCount, so pair it with mockSetPetCare (or careForPet) for a hatched pet.
  mockSetPetNeed(tokenId: string, actionType: number, sec: number): void {
    if (!Number.isInteger(actionType) || actionType < 0 || actionType >= 5) {
      throw new Error("mock: BadAction");
    }
    const needs = this.petNeedSec.get(tokenId) ?? [0, 0, 0, 0, 0];
    needs[actionType] = sec;
    this.petNeedSec.set(tokenId, needs);
  }
  // Simulate a secondary-market transfer (OpenSea sale): flips ownerOf only.
  setPetOwnerMock(tokenId: string, owner: string): void {
    this.petOwners.set(tokenId, owner);
  }
  // Register a contract-account (ERC-1271) signer predicate for the spec-floor
  // signed care path test: `address` validates a signature when the predicate
  // returns true. Passing null clears it.
  setContractSignerMock(
    address: string,
    predicate: ((message: string, signature: string) => boolean) | null,
  ): void {
    if (predicate) this.contractSigners.set(address.toLowerCase(), predicate);
    else this.contractSigners.delete(address.toLowerCase());
  }

  // Test hooks: push a pet's deadline into the past. `hoursPast` hours beyond
  // the deadline == DEAD (permanent; death is the clock, there is no revive).
  // Five-needs shape: ONE lapsed need kills, so FEED is pushed past its
  // deadline while the other four are refreshed to now (strictly within
  // lifeTtl). The scenario therefore proves the weakest link alone is fatal,
  // not "everything went stale at once". min == the lapsed FEED stamp, so the
  // pet-level deadline (and diedAt) matches the old single-timer math exactly.
  expirePet(tokenId: string, hoursPast = 1): void {
    const now = this.nowSec();
    const lapsed = now - hoursPast * 3600 - this.lifeTtlSec;
    this.petNeedSec.set(tokenId, [lapsed, now, now, now, now]);
    if (!this.petBornSec.has(tokenId)) this.petBornSec.set(tokenId, now - 6 * 86400);
    // A pet only DIES if it was fed at least once (isDead requires careCount > 0;
    // a never-fed egg is dormant, not dead: see lastCareOf/petState). Expiring a
    // pet models "fed, then a need lapsed", so a bare dormant egg being expired
    // must gain a care, or the lapsed timer alone would never mark it dead.
    if ((this.petCareCounts.get(tokenId) ?? 0) === 0) this.petCareCounts.set(tokenId, 1);
  }
  killPet(tokenId: string): void {
    this.expirePet(tokenId, 100000);
  }
}
