# WALLETCHI endgame rebuild: LAST PET STANDING | spec 2026-08-10

Replaces the timed-season / MAX-lastCareAt / operator-close model with pure last-pet-standing.
House rule: no em dashes / "--". Branch: `last-pet-standing`.

## The game
- Feed your pet or it dies. A pet is DEAD the instant `now >= lastCareAt + lifeTtl`. Pure clock, no
  action, no "reaping". Death is PERMANENT: a dead pet can never be fed again (no revive).
- The last pet still alive wins the whole pot, paid into that pet's ERC-6551 account.
- No operator, no season close, no deadline. It ends when one is left. If that never happens, it
  never ends (accepted).

## How the contract knows the winner in O(1) (no reap, no scan, no headcount)
The contract tracks TWO facts, updated on every care:
- `leader` / `leaderCareAt`: the most-recently-fed pet (the standing winner).
- `runnerUpCareAt`: the most recent care time of ANY pet OTHER than the leader.
Invariant (proven): `leader` is always the pet with the global max lastCareAt among fed pets, and
`runnerUpCareAt` is always the second. Update rule on care(pet, now):
- if pet == leader: `leaderCareAt = now`.
- else: `if (leader != 0) runnerUpCareAt = leaderCareAt; leader = pet; leaderCareAt = now`.

The game is OVER the instant `now >= runnerUpCareAt + lifeTtl`: that means no pet other than the
leader has been fed within a full life window, so every other pet has lapsed and the leader is the
sole survivor (or the last to die). `finalize()` is permissionless, re-checks that on-chain, and pays
the pot to the leader's TBA. Gated by `hatchedCount >= minPlayers` (>= 2 fed pets) so a one-player
season can never insta-win.

## Contract changes (PetVault)
REMOVE: reap()/reaped/rank/diedCount/reapGrace, closeSeason()/seasonClosed/isClosed-as-close,
careDeadline + the trustless care-cutoff/close-gate (CareWindowClosed/CareWindowOpen), claimPot /
_proposeCandidate / winnerCandidate / challengeDeadline / challengeWindow / _isBetter, on-chain
aliveCount (moves off-chain to the site).
ADD: two-slot tracker (leader/leaderCareAt/runnerUpCareAt), hatchedCount, isOver() view, permanent
death guard in care(), finalize() gated on isOver(). KEEP: the 3-leg care split (pot/burn/rewards),
pot, Ownable2Step, sweep (surplus-only + unwinnable-pot burn), lifeTtl + lockConfig (fairness freeze).
Death = `registered && lastCareAt + lifeTtl <= now` (one definition, used by care-guard, soulbound,
memorial). View signatures kept where possible (petState/memorialState/lifeState/settlementState) with
remapped semantics so the server change stays small.

## Pet721
Death-soulbound now reads `vault.isDead(tokenId)` (time-based) instead of a stored `reaped` flag.

## Deploy / Verify
Drop CARE_WINDOW_SECS / careDeadline / reapGrace / the mainnet auto-lockConfig-for-deadline and the
close-gate asserts. Keep the account-impl CRITICAL guards, real-token guard, Ownable2Step FINAL_OWNER
handoff, 3-leg wiring. The operator-winner-bias HIGH is GONE by construction (no close to time), so
the whole trustless-close apparatus is removed rather than hardened.

## Server (WALLETCHI)
Remove the reap bot + the auto-closer/settlement supersede logic. Add: an off-chain "N alive" tally
(computed from timers) for the scoreboard, and a bot that pokes finalize() when isOver() flips true
(contract re-verifies, so the bot is a trigger, never the judge). Death feed derives from timers.

## Security note
No operator lever remains: the winner is whoever keeps their own pet alive longest, paying care fees
in the open. The relayer feeding others only helps THOSE pets. Under-subscribed pot (never reaches
minPlayers and all players die) is burnable via the timelocked sweep (player value, never handed out).
