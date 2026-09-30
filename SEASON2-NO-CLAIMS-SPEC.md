# SEASON 2 rebuild: NO CLAIMS, PUSH EVERYTHING | Hunt's ruling 2026-08-30

House rule: no em dashes / "--". Supersedes the claim-based reward flows. The
last-pet-standing core (two-slot tracker, isOver, pure-clock death) is KEPT:
it passed its live audit in season 1 (see walletchi-feed-rescue-2026-08-29
memory). This spec is about what happens to VALUE: the winner's pot, the care
rewards, and the holder rewards.

## Hunt's ruling, verbatim intent

1. The winner's pot is DROPPED ON the winning pet by the contract the moment
   the game is decided. The winner signs nothing, claims nothing.
2. The winning pet becomes IMMORTAL: it can never die after winning, so the
   value it holds is never trapped behind a memorial state.
3. NO CLAIM FUNCTIONS ANYWHERE. Every reward is pushed to where the asset
   lives: pet rewards to the pet's ERC-6551 account, wallet rewards to the
   holding wallet, NFT-holder rewards to the NFT's 6551 account.
4. Push cadence: EVERY 2 HOURS.
5. Funding: rewards come from trading fees (letscash hook). Roughly 1% of the
   flow stays in an ops wallet to pay Robinhood gas for the pushes.

## Design translation (what the chain can actually promise)

### Winner: instant by poke, immortal by flag
- `finalize()` stays permissionless and pays DIRECTLY into the leader's TBA
  (already true in season 1's contract). "Instant" is delivered by the server
  watcher poking finalize() the moment isOver() flips; anyone else can too.
- IMMORTAL WINNER: after `potClaimed`, `isDead(prizeWinner)` returns false
  forever. The winner stays alive, transferable, and displayable as champion.
  (Note: death never forfeited TBA contents even in season 1; immortality is
  about the trophy staying live, not about rescuing funds.)
- The non-blocking payout stays, but its fallback changes from "winner may
  claim" to ESCROW AND RE-PUSH: if the token refuses the transfer, the prize
  stays escrowed and any later permissionless `pushPrize()` retries it. The
  winner never signs.
- `minPlayers` and the abandon grace become CONSTRUCTOR PARAMETERS (season 1
  shipped `constant 90 days`, which guarded 0.5 mock CARE for two months).
  Tester deploys set days, mainnet sets weeks.

### Rewards: accrue on-chain, push on a timer, never claim
- Replace epoch+claim distributors (CareRewardsDistributor claim flow,
  HolderMerkleVault merkle claims) with ACCRUAL + PERMISSIONLESS PUSH:
  - Contracts track accrued balances per recipient (per pet tokenId for pet
    rewards, per address for wallet rewards). Accrual happens at the same
    events that fund it today (care splits, fee snapshots).
  - `push(recipients[])` is PERMISSIONLESS: amounts are contract-enforced
    from accrual, so a caller can only choose WHO gets paid EARLIER, never
    how much. The 2h server bot is a convenience, not an authority.
  - Per-recipient transfers are NON-BLOCKING (the raw-call pattern from
    _payWinner): one hostile recipient must never block the batch. A failed
    push stays accrued and retries next cycle.
  - DUST THRESHOLD: skip pushes below a minimum so 2h cadence does not spray
    thousands of near-zero transfers. Below-threshold amounts keep accruing.
- Pet-earned rewards (the 20% care leg) accrue to the PET and push to its
  6551 TBA. Wallet-level rewards push to the wallet. NFT-holder rewards push
  to the NFT's TBA.

### Gas funding (DECIDED by Hunt 2026-08-30)
- The 1% gas skim comes OUT OF THE BURN LEG. Care split becomes
  69% burn / 20% player rewards / 10% pot / 1% push gas
  (6900/2000/1000/100 bps). Rewards and pot untouched. At mainnet careCost
  5,000: per care = 3,450 burned + 1,000 rewards + 500 pot + 50 gas.
- The skim accrues in CARE to the ops wallet. Converting CARE to native gas
  is an ops concern (swap adapter or manual top-up with the skim as the
  offsetting revenue); the contract only routes the 1%.
- Robinhood chain gas is near-zero today; the skim is sized for mainnet
  headroom, not testnet reality.

### Cadence
- One server cron, every 2 hours: collect fees if any, then push pet rewards,
  wallet rewards, holder rewards, and retry any escrowed prize. Every call it
  makes is permissionless, so an outage of ours never strands funds: anyone
  can run the same pushes.

## Carry-over fix list (client chain, from season 1's post-mortem)
- RouterSwapAdapter.sol:228 comment still says "the same 70/20/10 pipeline";
  update alongside the four-leg contract rework (comment only, no behavior).
- Alchemy Gas Manager "max count per spender" sized for 5 needs/day/pet plus
  arming, or moved into the gas-sponsor webhook where our server decides.
- Arming must not retry unbounded (season 1: 7 sponsored ops burned on one
  wallet pre-season, which exhausted the cap and killed every later care).
- Surface arming/grant failures; never swallow.
- Error copy shows the LAST line of a viem error, not the first 160 chars
  (the truncation hid "Policy's max count per spender exceeded" for a day).

## Still unproven, season 2 must demonstrate
- A human tapping a wallet pass and seeing silent care.
- finalize() paying a living winner (needs hatchedCount >= minPlayers by
  design of the roster: mint at least minPlayers pets across controlled
  keepers).
- The push pipeline end to end under the 2h cron.
- minSeasonDuration floors the earliest win (48h in season 1): set it
  deliberately for the test cadence.

## Season 2 launch protocol (Hunt's ruling 2026-08-30)

Five minters, real people, some returning from season 1. Nobody faces an
error a founder did not face first.

FOUNDERS-FIRST MINT ORDER: Claude mints No. 1 through the real site (real
browser, real inbox, real pass), then Hunt mints No. 2 from his phone. Each
mint is verified POSITIVELY before the next step: receipt email correct,
pass delivered with working buttons, and ARMING CONFIRMED as an active
care-session row in the DB (never inferred from an absence of errors: that
inference is how season 1 shipped a keeper with 7 burned ops and no
session). Only after both founder mints are clean do the other 3 testers
get the link.

FRESH-START CHECKLIST, each a hard gate before mint 1:
1. DB reset: `RESET_CONFIRM_DB=<db> npx tsx scripts/reset-season-data.ts
   --sybil` (wipes Runner + cascades, CheckoutSession, MintedEmail,
   MintedPrivyUser, MintSignal: returning minters start clean).
   DECIDED (Hunt 2026-08-30): full wipe, season-1 memorials included ("it
   was just a test season"). NOTE for MAINNET: a real season's memorial
   promise ("lives on its page forever") will need season-scoped data
   instead of this wipe; do not carry the full-wipe habit past testnet.
2. ALCHEMY RESET, the one that killed season 1: the per-spender sponsorship
   counters live in the Gas Manager POLICY, not our DB. Create a FRESH
   policy for season 2 (fresh policy = zeroed counters for every returning
   wallet) sized for the game: >= 100 ops per spender or webhook-gated.
   Update GAS_POLICY_ID (server) + NEXT_PUBLIC_GAS_POLICY_ID (web) + the
   webhook wiring. GATE: prove a season-1-capped wallet (the operator's
   0xD5f9...) can prepare AND send a sponsored op before anyone mints.
3. Client fixes deployed and browser-verified BEFORE mint 1: single-attempt
   arming with surfaced failures, error copy showing the LAST line of a
   viem error, and the already-delegated returning-wallet path (both
   founder wallets are 7702-delegated from season 1, so they exercise it).
4. `SEASON_END_ACK` cleared (currently "5-0") so the new season alarms
   honestly.
5. `RUNNER_SUPPLY_CAP` matches the chain MAX_SUPPLY (5).
6. ALL start-moment behavior deployed BEFORE the sellout (season-1 lesson:
   the start is an unrepeatable instant).

## IMPLEMENTATION STATUS (2026-08-31, branch season2-no-claims)

BUILT AND VERIFIED: contracts (four-leg split, immortal winner, pushPrize,
abandonGrace and gas params, pushRewards with dust roll and per-pet
non-blocking skips; forge 492 passed 0 failed, new Season2 suites
mutation-tested), server (2h push engine with push/forfeit/holder/prize/
residual legs, settlement tail on every tick, a DEADLINE-ARMED finalize
watcher instead of an impossible log subscription: isOver flips because a
deadline passes, nothing emits at that instant, so the watcher arms for the
vault's published winsAt, which is monotonically non-decreasing so early
fires are free re-checks; claim endpoints answer 410 rewards_pushed; smoke
555 passed 0 failed), web (tri-state isDelegated so an unknown read never
spends a sponsored op, one-bootstrap-per-session latch, arming failures
surfaced, viem error detail extraction, claim UI removed; tsc clean).

RESOLVED (Hunt 2026-08-31): "no claim, always airdrops." The holder-vault
user-facing CLAIM ENDPOINT (POST /api/holder-rewards/:address/claim) is
RETIRED, answers 410 rewards_pushed, touches no chain. Holder rewards arrive
only via the 2h push engine (pushHolderRewards walks every posted leaf and
delivers it). The GET proof-lookup stays (informational + on-chain escape
hatch). The contract HolderMerkleVault.claim() stays too (it is what the push
bot calls to deliver, and the public escape hatch), but WE offer no claim
button anywhere. This was the last claim surface in the product.

FOLLOW-UPS: wire rollForward() for zero-point epochs (money not stranded,
just idle until settlement); surface the push engine's last-cycle summary on
/internal/status for the heartbeat; RouterSwapAdapter comment (listed above).

## Security posture
- Nothing here adds an owner lever: pushes are permissionless with
  contract-enforced amounts, the winner payout is unchanged in trust terms,
  and immortality is a pure view-level exemption for one tokenId.
- Full forge coverage before deploy, same bar as season 1 (439/0), plus new
  suites: push accounting, non-blocking batch behavior, dust threshold,
  escrowed-prize retry, immortal-winner invariants (soulbound rules, care
  gating, memorial exclusion).
