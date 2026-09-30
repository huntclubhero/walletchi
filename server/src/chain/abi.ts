import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { Abi } from "viem";
import { config } from "../config.js";
import { logger } from "../logger.js";

// ---------------------------------------------------------------------------
// FALLBACK ABIs.
//
// Hand-written mirrors of the shipped WALLETCHI contracts, used only when
// ABI_DIR is unset or an artifact is missing; the committed real ABIs under
// ../contracts/abi take precedence via loadAbi. Keep in sync with the
// contracts. (The retired legacy card-issuer surface is removed.)
// ---------------------------------------------------------------------------

// RunnerIssuer fallback ABI. The retired mini-game surface (recordRun /
// idleCatch / run events) is removed; WALLETCHI still mints through
// issueRunner and resolves TBAs via accountOf/runnerState. Used only when
// contracts/abi/RunnerIssuer.json is absent; the committed artifact takes
// precedence via loadAbi. Keep in sync.
export const RUNNER_ISSUER_ABI_FALLBACK = [
  {
    type: "function",
    name: "issueRunner",
    stateMutability: "nonpayable",
    inputs: [{ name: "to", type: "address" }],
    outputs: [
      { name: "tokenId", type: "uint256" },
      { name: "account", type: "address" },
    ],
  },
  {
    type: "function",
    name: "runnerState",
    stateMutability: "view",
    inputs: [{ name: "tokenId", type: "uint256" }],
    outputs: [
      { name: "tba", type: "address" },
      { name: "bestScore", type: "uint256" },
      { name: "totalSalmon", type: "uint256" },
      { name: "totalRuns", type: "uint256" },
    ],
  },
  {
    type: "function",
    name: "accountOf",
    stateMutability: "view",
    inputs: [{ name: "tokenId", type: "uint256" }],
    outputs: [{ name: "", type: "address" }],
  },
  {
    type: "event",
    name: "RunnerIssued",
    inputs: [
      { name: "tokenId", type: "uint256", indexed: true },
      { name: "account", type: "address", indexed: true },
      { name: "to", type: "address", indexed: true },
    ],
  },
  { type: "error", name: "NotRelayer", inputs: [] },
  { type: "error", name: "ZeroAddress", inputs: [] },
] as const satisfies Abi;

// PetVault fallback ABI (WALLETCHI survival economy, LAST PET STANDING).
// Reconciled against the rewritten contract (contracts/src/runner/PetVault.sol +
// committed contracts/abi/PetVault.json). loadAbi("PetVault", ...) prefers the
// committed artifact; this is the safety net covering the surface the server
// uses: care + finalize writes, the timer-based death reads, the two-slot
// settlement reads, the escrowed-prize retry, and the
// Care/LeaderChanged/Victory events. There is NO reap, NO season close, NO
// claimPot: death is the clock (permanent) and finalize() pays the last pet
// standing.
//
// SEASON 2 (no claims): claimPrize(tokenId, to) is GONE. A prize the care token
// refused at finalize() stays escrowed in unpaidPrize and anyone may retry it
// with the permissionless pushPrize(tokenId), which can only ever pay the
// winning pet's own TBA. The winner signs nothing.
export const PET_VAULT_ABI_FALLBACK = [
  {
    type: "function",
    name: "care",
    stateMutability: "nonpayable",
    inputs: [
      { name: "tokenId", type: "uint256" },
      { name: "actionType", type: "uint8" },
    ],
    outputs: [],
  },
  { type: "function", name: "finalize", stateMutability: "nonpayable", inputs: [], outputs: [] },
  { type: "function", name: "careCost", stateMutability: "view", inputs: [], outputs: [{ name: "", type: "uint256" }] },
  { type: "function", name: "pot", stateMutability: "view", inputs: [], outputs: [{ name: "", type: "uint256" }] },
  { type: "function", name: "totalBurned", stateMutability: "view", inputs: [], outputs: [{ name: "", type: "uint256" }] },
  { type: "function", name: "registeredCount", stateMutability: "view", inputs: [], outputs: [{ name: "", type: "uint256" }] },
  { type: "function", name: "hatchedCount", stateMutability: "view", inputs: [], outputs: [{ name: "", type: "uint256" }] },
  { type: "function", name: "lifeTtl", stateMutability: "view", inputs: [], outputs: [{ name: "", type: "uint256" }] },
  { type: "function", name: "careCooldown", stateMutability: "view", inputs: [], outputs: [{ name: "", type: "uint256" }] },
  { type: "function", name: "careToken", stateMutability: "view", inputs: [], outputs: [{ name: "", type: "address" }] },
  { type: "function", name: "potClaimed", stateMutability: "view", inputs: [], outputs: [{ name: "", type: "bool" }] },
  { type: "function", name: "isOver", stateMutability: "view", inputs: [], outputs: [{ name: "", type: "bool" }] },
  { type: "function", name: "leader", stateMutability: "view", inputs: [], outputs: [{ name: "", type: "uint256" }] },
  { type: "function", name: "leaderCareAt", stateMutability: "view", inputs: [], outputs: [{ name: "", type: "uint64" }] },
  { type: "function", name: "runnerUpCareAt", stateMutability: "view", inputs: [], outputs: [{ name: "", type: "uint64" }] },
  // The pet that won the pot, 0 while the season is unsettled. Frozen once
  // potClaimed, which is what makes the champion's immortality stable.
  { type: "function", name: "prizeWinner", stateMutability: "view", inputs: [], outputs: [{ name: "", type: "uint256" }] },
  // ESCROW AND RE-PUSH (season 2). unpaidPrize is what finalize() could not
  // deliver; pushPrize is the PERMISSIONLESS retry and its destination is never
  // caller-chosen (it pays the winning pet's own TBA, exactly where finalize()
  // tried to put it). NothingToPush when the escrow is empty.
  {
    type: "function",
    name: "unpaidPrize",
    stateMutability: "view",
    inputs: [{ name: "", type: "uint256" }],
    outputs: [{ name: "", type: "uint256" }],
  },
  { type: "function", name: "totalUnpaidPrize", stateMutability: "view", inputs: [], outputs: [{ name: "", type: "uint256" }] },
  {
    type: "function",
    name: "pushPrize",
    stateMutability: "nonpayable",
    inputs: [{ name: "tokenId", type: "uint256" }],
    outputs: [],
  },
  // Season 2 made the abandon grace an IMMUTABLE constructor parameter (it
  // shipped as a hardcoded 90 days in season 1), so it is a call, not a constant.
  { type: "function", name: "abandonGrace", stateMutability: "view", inputs: [], outputs: [{ name: "", type: "uint256" }] },
  // The fourth care leg (season 2): 1% of every care routes to an ops wallet that
  // pays the gas for these pushes. 6900 burn / 2000 rewards / 1000 pot / 100 gas.
  { type: "function", name: "gasBps", stateMutability: "view", inputs: [], outputs: [{ name: "", type: "uint256" }] },
  { type: "function", name: "gasRecipient", stateMutability: "view", inputs: [], outputs: [{ name: "", type: "address" }] },
  { type: "function", name: "totalGas", stateMutability: "view", inputs: [], outputs: [{ name: "", type: "uint256" }] },
  {
    type: "function",
    name: "alive",
    stateMutability: "view",
    inputs: [{ name: "tokenId", type: "uint256" }],
    outputs: [{ name: "", type: "bool" }],
  },
  {
    type: "function",
    name: "isDead",
    stateMutability: "view",
    inputs: [{ name: "tokenId", type: "uint256" }],
    outputs: [{ name: "", type: "bool" }],
  },
  {
    type: "function",
    name: "lifeState",
    stateMutability: "view",
    inputs: [{ name: "tokenId", type: "uint256" }],
    outputs: [
      { name: "isAlive", type: "bool" },
      { name: "lastCareAt", type: "uint64" },
      { name: "deadline", type: "uint256" },
    ],
  },
  {
    type: "function",
    name: "petState",
    stateMutability: "view",
    inputs: [{ name: "tokenId", type: "uint256" }],
    outputs: [
      { name: "registered", type: "bool" },
      { name: "dead", type: "bool" },
      { name: "lastCareAt", type: "uint64" },
      { name: "isAlive", type: "bool" },
      { name: "secondsLeft", type: "uint256" },
    ],
  },
  // Five-needs redesign: the raw per-need stamps, index = canonical actionType
  // (0=FEED 1=WATER 2=PLAY 3=TOY 4=EXPLORE). All zeros for a dormant egg AND an
  // unregistered id (callers check petState().registered first).
  {
    type: "function",
    name: "needsOf",
    stateMutability: "view",
    inputs: [{ name: "tokenId", type: "uint256" }],
    outputs: [{ name: "needAt", type: "uint64[5]" }],
  },
  {
    type: "function",
    name: "memorialState",
    stateMutability: "view",
    inputs: [{ name: "tokenId", type: "uint256" }],
    outputs: [
      { name: "dead", type: "bool" },
      { name: "bornAt", type: "uint64" },
      { name: "diedAt", type: "uint64" },
      { name: "careCount", type: "uint32" },
      { name: "rank", type: "uint32" },
    ],
  },
  {
    type: "function",
    name: "settlementState",
    stateMutability: "view",
    inputs: [],
    outputs: [
      { name: "candidate", type: "uint256" },
      { name: "candidateLastCareAt", type: "uint64" },
      { name: "winsAt", type: "uint256" },
      { name: "finalized", type: "bool" },
    ],
  },
  {
    type: "event",
    name: "Care",
    inputs: [
      { name: "tokenId", type: "uint256", indexed: true },
      { name: "actionType", type: "uint8", indexed: false },
      { name: "cost", type: "uint256", indexed: false },
      { name: "burned", type: "uint256", indexed: false },
      { name: "potContribution", type: "uint256", indexed: false },
      { name: "rewardsContribution", type: "uint256", indexed: false },
      // Season 2's fourth leg, between rewards and potAfter. Position matters:
      // these are non-indexed, so a fallback missing it decodes potAfter off the
      // gas slice and reports a wrong pot.
      { name: "gasContribution", type: "uint256", indexed: false },
      { name: "potAfter", type: "uint256", indexed: false },
    ],
  },
  {
    type: "event",
    name: "PrizeDeferred",
    inputs: [
      { name: "tokenId", type: "uint256", indexed: true },
      { name: "amount", type: "uint256", indexed: false },
    ],
  },
  {
    type: "event",
    name: "PrizePushed",
    inputs: [
      { name: "tokenId", type: "uint256", indexed: true },
      { name: "tba", type: "address", indexed: true },
      { name: "amount", type: "uint256", indexed: false },
    ],
  },
  {
    type: "event",
    name: "LeaderChanged",
    inputs: [
      { name: "leader", type: "uint256", indexed: true },
      { name: "leaderCareAt", type: "uint64", indexed: false },
      { name: "runnerUpCareAt", type: "uint64", indexed: false },
    ],
  },
  {
    type: "event",
    name: "Victory",
    inputs: [
      { name: "tokenId", type: "uint256", indexed: true },
      { name: "tba", type: "address", indexed: true },
      { name: "prize", type: "uint256", indexed: false },
    ],
  },
  { type: "error", name: "NotAuthorizedCarer", inputs: [] },
  { type: "error", name: "NotCareable", inputs: [] },
  { type: "error", name: "PetIsDead", inputs: [] },
  { type: "error", name: "CareOnCooldown", inputs: [] },
  { type: "error", name: "GameOver", inputs: [] },
  { type: "error", name: "GameNotOver", inputs: [] },
  { type: "error", name: "NotEnoughPlayers", inputs: [] },
  // pushPrize with an empty escrow. The 2h engine reads unpaidPrize first, so
  // this is only ever a benign race with another pusher.
  { type: "error", name: "NothingToPush", inputs: [] },
  // Five-needs redesign errors: actionType >= 5 has no need to reset (charge
  // refused), and an approved third-party carer must serve a currently-min need.
  { type: "error", name: "BadAction", inputs: [] },
  { type: "error", name: "CarerMustServeMinNeed", inputs: [] },
] as const satisfies Abi;

// PetIssuer fallback ABI (WALLETCHI mint). The committed contracts/abi/PetIssuer.json
// wins. issuePet(to) -> (tokenId, account) mints the Pet721 + creates its 6551 account
// + seeds starter care tokens + registers it in the vault. Mirrors issueRunner's shape
// (the retired legacy issuer) but with the pet function/event names.
export const PET_ISSUER_ABI_FALLBACK = [
  {
    type: "function",
    name: "issuePet",
    stateMutability: "nonpayable",
    inputs: [{ name: "to", type: "address" }],
    outputs: [
      { name: "tokenId", type: "uint256" },
      { name: "account", type: "address" },
    ],
  },
  {
    type: "function",
    name: "accountOf",
    stateMutability: "view",
    inputs: [{ name: "tokenId", type: "uint256" }],
    outputs: [{ name: "", type: "address" }],
  },
  {
    type: "function",
    name: "careToken",
    stateMutability: "view",
    inputs: [],
    outputs: [{ name: "", type: "address" }],
  },
  {
    type: "event",
    name: "PetIssued",
    inputs: [
      { name: "tokenId", type: "uint256", indexed: true },
      { name: "account", type: "address", indexed: true },
      { name: "to", type: "address", indexed: true },
    ],
  },
  { type: "error", name: "NotRelayer", inputs: [] },
  { type: "error", name: "ZeroAddress", inputs: [] },
] as const satisfies Abi;

// Pet721 v2 fallback ABI (WALLETCHI pet NFT). Only the reads the server needs
// for the secondary-market claim: ownerOf (authoritative current owner), isDead
// (TIME-BASED via the vault clock == soulbound memorial), royaltyInfo (2981).
// The committed contracts/abi/Pet721.json wins via loadAbi.
export const PET721_ABI_FALLBACK = [
  {
    type: "function",
    name: "ownerOf",
    stateMutability: "view",
    inputs: [{ name: "tokenId", type: "uint256" }],
    outputs: [{ name: "", type: "address" }],
  },
  {
    type: "function",
    name: "isDead",
    stateMutability: "view",
    inputs: [{ name: "tokenId", type: "uint256" }],
    outputs: [{ name: "", type: "bool" }],
  },
  {
    type: "function",
    name: "royaltyInfo",
    stateMutability: "view",
    inputs: [
      { name: "tokenId", type: "uint256" },
      { name: "salePrice", type: "uint256" },
    ],
    outputs: [
      { name: "receiver", type: "address" },
      { name: "amount", type: "uint256" },
    ],
  },
  {
    type: "function",
    name: "totalMinted",
    stateMutability: "view",
    inputs: [],
    outputs: [{ name: "", type: "uint256" }],
  },
] as const satisfies Abi;

// CareRewardsDistributor fallback ABI (WALLETCHI player rewards).
//
// SEASON 2 (no claims): there is no claim() and no claimMany(). Rewards are
// PUSHED. pushRewards(epoch, tokenIds) is permissionless, pays each pet's
// RECORDED TBA, and SKIPS rather than reverts on an already-paid, point-less or
// dead pet, so one bad id in a batch never costs the rest their payout. Only
// batch-level problems revert (SeasonSettled / EpochNotFinished / NoPoints).
// Its companions are permissionless too: sweepForfeited moves a DEAD pet's
// unclaimed share into a future epoch (reverting PetIsAlive if a listed pet is
// alive, so callers must filter first) and sweepResidualToWinner empties the
// contract to the champion once the vault has settled.
//
// The committed contracts/abi/CareRewardsDistributor.json wins via loadAbi; this
// is the safety net. Keep in sync.
export const REWARDS_DISTRIBUTOR_ABI_FALLBACK = [
  {
    type: "function",
    name: "epochNow",
    stateMutability: "view",
    inputs: [],
    outputs: [{ name: "", type: "uint256" }],
  },
  {
    type: "function",
    name: "pendingReward",
    stateMutability: "view",
    inputs: [
      { name: "epoch", type: "uint256" },
      { name: "tokenId", type: "uint256" },
    ],
    outputs: [{ name: "", type: "uint256" }],
  },
  {
    type: "function",
    name: "claimed",
    stateMutability: "view",
    inputs: [
      { name: "", type: "uint256" },
      { name: "", type: "uint256" },
    ],
    outputs: [{ name: "", type: "bool" }],
  },
  // Participation points for a pet in an epoch, mapping order (epoch, tokenId).
  // The forfeit signal: points > 0 with pendingReward 0 and not claimed means the
  // pet is DEAD, because pendingReward zeroes for a dead pet.
  {
    type: "function",
    name: "points",
    stateMutability: "view",
    inputs: [
      { name: "", type: "uint256" },
      { name: "", type: "uint256" },
    ],
    outputs: [{ name: "", type: "uint256" }],
  },
  {
    type: "function",
    name: "residualSwept",
    stateMutability: "view",
    inputs: [],
    outputs: [{ name: "", type: "bool" }],
  },
  {
    type: "function",
    name: "pushRewards",
    stateMutability: "nonpayable",
    inputs: [
      { name: "epoch", type: "uint256" },
      { name: "tokenIds", type: "uint256[]" },
    ],
    outputs: [{ name: "total", type: "uint256" }],
  },
  {
    type: "function",
    name: "sweepForfeited",
    stateMutability: "nonpayable",
    inputs: [
      { name: "epoch", type: "uint256" },
      { name: "tokenIds", type: "uint256[]" },
    ],
    outputs: [],
  },
  {
    type: "function",
    name: "sweepResidualToWinner",
    stateMutability: "nonpayable",
    inputs: [],
    outputs: [],
  },
  {
    type: "event",
    name: "RewardsPushed",
    inputs: [
      { name: "epoch", type: "uint256", indexed: true },
      { name: "tokenId", type: "uint256", indexed: true },
      { name: "account", type: "address", indexed: true },
      { name: "amount", type: "uint256", indexed: false },
    ],
  },
  {
    type: "event",
    name: "RewardsPushFailed",
    inputs: [
      { name: "epoch", type: "uint256", indexed: true },
      { name: "tokenId", type: "uint256", indexed: true },
      { name: "amount", type: "uint256", indexed: false },
    ],
  },
  {
    type: "event",
    name: "DustRolled",
    inputs: [
      { name: "epoch", type: "uint256", indexed: true },
      { name: "tokenId", type: "uint256", indexed: true },
      { name: "toEpoch", type: "uint256", indexed: false },
      { name: "amount", type: "uint256", indexed: false },
    ],
  },
  {
    type: "event",
    name: "Forfeited",
    inputs: [
      { name: "epoch", type: "uint256", indexed: true },
      { name: "tokenId", type: "uint256", indexed: true },
      { name: "toEpoch", type: "uint256", indexed: false },
      { name: "amount", type: "uint256", indexed: false },
    ],
  },
  // The batch-level reverts, declared so a failed push logs a NAMED error rather
  // than a raw selector.
  { type: "error", name: "EpochNotFinished", inputs: [] },
  { type: "error", name: "NoPoints", inputs: [] },
  { type: "error", name: "SeasonSettled", inputs: [] },
  { type: "error", name: "PetIsAlive", inputs: [] },
  { type: "error", name: "SeasonNotOver", inputs: [] },
  { type: "error", name: "AlreadySwept", inputs: [] },
] as const satisfies Abi;

// CareFeeSplitter fallback ABI (tax economy). Only the surface the 4x/day job
// uses: the permissionless distribute() poke. The committed
// contracts/abi/CareFeeSplitter.json wins via loadAbi.
export const FEE_SPLITTER_ABI_FALLBACK = [
  {
    type: "function",
    name: "distribute",
    stateMutability: "nonpayable",
    inputs: [],
    outputs: [
      { name: "holderShare", type: "uint256" },
      { name: "playerShare", type: "uint256" },
    ],
  },
  { type: "error", name: "NothingToDistribute", inputs: [] },
] as const satisfies Abi;

// HolderMerkleVault fallback ABI (tax economy holder airdrops). Round posting is
// poster-gated by a DEDICATED poster key that is never the relayer; claim() is
// permissionless and pays the leaf's account, so the server relays holder claims
// gaslessly. The committed contracts/abi/HolderMerkleVault.json wins via loadAbi.
// Kept in sync with the hardened vault: poster(), maxRoundTotal() and
// postingPaused() are read here because postRound now FAILS CLOSED on all three
// (NotPoster / RoundCapNotArmed / OverRoundCap / PostingIsPaused), and a fallback
// ABI missing them would turn every one of those into an unreadable client error.
export const HOLDER_VAULT_ABI_FALLBACK = [
  {
    type: "function",
    name: "postRound",
    stateMutability: "nonpayable",
    inputs: [
      { name: "expectedRoundId", type: "uint256" },
      { name: "root", type: "bytes32" },
      { name: "total", type: "uint256" },
    ],
    outputs: [{ name: "roundId", type: "uint256" }],
  },
  {
    type: "function",
    name: "claim",
    stateMutability: "nonpayable",
    inputs: [
      { name: "roundId", type: "uint256" },
      { name: "account", type: "address" },
      { name: "amount", type: "uint256" },
      { name: "proof", type: "bytes32[]" },
    ],
    outputs: [],
  },
  {
    type: "function",
    name: "claimed",
    stateMutability: "view",
    inputs: [
      { name: "", type: "uint256" },
      { name: "", type: "address" },
    ],
    outputs: [{ name: "", type: "bool" }],
  },
  {
    type: "function",
    name: "roundCount",
    stateMutability: "view",
    inputs: [],
    outputs: [{ name: "", type: "uint256" }],
  },
  {
    type: "function",
    name: "unreserved",
    stateMutability: "view",
    inputs: [],
    outputs: [{ name: "", type: "uint256" }],
  },
  {
    type: "function",
    name: "poster",
    stateMutability: "view",
    inputs: [],
    outputs: [{ name: "", type: "address" }],
  },
  {
    type: "function",
    name: "maxRoundTotal",
    stateMutability: "view",
    inputs: [],
    outputs: [{ name: "", type: "uint256" }],
  },
  {
    type: "function",
    name: "postingPaused",
    stateMutability: "view",
    inputs: [],
    outputs: [{ name: "", type: "bool" }],
  },
  { type: "error", name: "NotPoster", inputs: [] },
  { type: "error", name: "RoundNotBacked", inputs: [] },
  { type: "error", name: "AlreadyClaimed", inputs: [] },
  { type: "error", name: "BadProof", inputs: [] },
  { type: "error", name: "RoundCapNotArmed", inputs: [] },
  { type: "error", name: "OverRoundCap", inputs: [] },
  { type: "error", name: "PostingIsPaused", inputs: [] },
  { type: "error", name: "UnexpectedRoundId", inputs: [] },
] as const satisfies Abi;

// ERC-20 Transfer event, for the holder-snapshot log scan.
export const ERC20_TRANSFER_EVENT_ABI = [
  {
    type: "event",
    name: "Transfer",
    inputs: [
      { name: "from", type: "address", indexed: true },
      { name: "to", type: "address", indexed: true },
      { name: "value", type: "uint256", indexed: false },
    ],
  },
] as const satisfies Abi;

// Minimal ERC-20 for reading USDG balance and PUNCH balance directly off the TBA.
export const ERC20_ABI = [
  {
    type: "function",
    name: "balanceOf",
    stateMutability: "view",
    inputs: [{ name: "account", type: "address" }],
    outputs: [{ name: "", type: "uint256" }],
  },
  {
    type: "function",
    name: "decimals",
    stateMutability: "view",
    inputs: [],
    outputs: [{ name: "", type: "uint8" }],
  },
  // transfer(): used by the launchpad creator-fee inlet to move claimed USDG off the collector
  // wallet and onto the CareFeeSplitter. Declared with a bool return, which real USDG has; the
  // caller checks the RECEIPT status rather than the decoded return value, so a USDT-style token
  // that returns no data still works and a reverting transfer is still caught.
  {
    type: "function",
    name: "transfer",
    stateMutability: "nonpayable",
    inputs: [
      { name: "to", type: "address" },
      { name: "amount", type: "uint256" },
    ],
    outputs: [{ name: "", type: "bool" }],
  },
] as const satisfies Abi;

// ERC-721 Transfer, in case tokenId must be recovered from the mint log.
export const ERC721_ABI = [
  {
    type: "event",
    name: "Transfer",
    inputs: [
      { name: "from", type: "address", indexed: true },
      { name: "to", type: "address", indexed: true },
      { name: "tokenId", type: "uint256", indexed: true },
    ],
  },
] as const satisfies Abi;

// ERC-6551 registry account() view, to derive the TBA if the issuer does not
// return / emit it.
export const ERC6551_REGISTRY_ABI = [
  {
    type: "function",
    name: "account",
    stateMutability: "view",
    inputs: [
      { name: "implementation", type: "address" },
      { name: "salt", type: "bytes32" },
      { name: "chainId", type: "uint256" },
      { name: "tokenContract", type: "address" },
      { name: "tokenId", type: "uint256" },
    ],
    outputs: [{ name: "account", type: "address" }],
  },
] as const satisfies Abi;

// Load a Foundry artifact ABI by contract name from ABI_DIR, falling back to the
// hand-written ABI. Foundry writes out/<Name>.sol/<Name>.json with an `abi` key.
export function loadAbi(contractName: string, fallback: Abi): Abi {
  if (!config.ABI_DIR) return fallback;
  const candidates = [
    join(config.ABI_DIR, `${contractName}.sol`, `${contractName}.json`),
    join(config.ABI_DIR, `${contractName}.json`),
  ];
  for (const p of candidates) {
    try {
      const raw = JSON.parse(readFileSync(p, "utf8"));
      const abi = (raw.abi ?? raw) as Abi;
      if (Array.isArray(abi) && abi.length) {
        logger.info({ contract: contractName, path: p }, "loaded ABI artifact");
        return abi;
      }
    } catch {
      // try next candidate
    }
  }
  logger.warn(
    { contract: contractName, abiDir: config.ABI_DIR },
    "ABI artifact not found; using hand-written fallback ABI (verify it matches the contract)",
  );
  return fallback;
}
