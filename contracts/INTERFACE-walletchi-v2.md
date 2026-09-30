# WALLETCHI vault: external interface (endgame redesign v2)

Audience: server-dev2, wiring the WALLETCHI server seam (behind `SURVIVAL_ENABLED`).
Reflects the frozen contract state at commit `36328b0`. Source of truth for the ABI:
`contracts/abi/PetVault.json`, `contracts/abi/PetIssuer.json`, `contracts/abi/Pet721.json`
(regenerated at this commit). Consume those directly via loadAbi and you match the contracts exactly.

> STATUS: PENDING RE-AUDIT. The access + spender + reentrancy + care surface is redesign-STABLE and
> safe to wire now. The SETTLEMENT surface (claimPot / finalize / settlementState / the settlement
> events) may still change if the re-audit routes a fix. WIRE NOW: `careCost`, `pot`, `aliveCount`,
> `registeredCount`, `alive`, `memorialState`, plus the `care` seam. HOLD until the lead hands the
> final post-audit ABI: `claimPot`, `finalize`, `settlementState`, `closeSeason`, and the
> `CandidateProposed` / `Victory` settlement events. Addresses come with the lead's handoff.

The care token is an EXTERNAL ERC-20 injected by address (MockCareToken on testnet, a Pons-launched
token on mainnet). All amounts on the vault are RAW token units.

---

## 1. Contracts

| Contract | Role |
| --- | --- |
| `PetIssuer` | Free-mints a pet, creates its ERC-6551 TBA, self-appoints as the TBA's capped spender, seeds a starter care-token float, registers the pet in the vault. `lockVault()` (owner, one-way, called at deploy) permanently freezes the spender's vault so it can never be repointed to drain accounts (audit M-A). The server does not call it. |
| `PetVault` | The survival economy: care (burn + pot), reap (memorial), and settlement (claim + challenge + finalize). |
| `Pet721` | The pet NFT (ERC-721). `ownerOf(tokenId)` is the pet's owner (used by the care gate). |
| `MockCareToken` | 18-decimal testnet stand-in for the care token. |

---

## 2. Functions the server calls

Access legend: [RELAYER] only the relayer; [OWNER-OR-RELAYER] the pet's NFT owner or the relayer;
[PERMISSIONLESS] anyone; [OWNER] the contract owner (season operator, normally the lead, not the server).

### PetIssuer (mint)
```solidity
function issuePet(address to) external returns (uint256 tokenId, address account); // [RELAYER]
function accountOf(uint256 tokenId) external view returns (address);               // deterministic TBA
```
`issuePet` mints, creates the TBA, seeds the starter float, and registers the pet in one call.
`account` is the pet's TBA (where care tokens are pulled from and where a win is paid).

### PetVault: care (STABLE, wire now)
```solidity
function care(uint256 tokenId, uint8 actionType) external; // [OWNER-OR-RELAYER], nonReentrant
```
Gate: `msg.sender == relayer() || msg.sender == Pet721.ownerOf(tokenId)`, else `NotAuthorizedCarer()`.
Never fully open (force-caring a rival could drain its TBA to death). Pulls `careCost` from the pet's
own TBA, burns the burn slice to `0x...dEaD`, accrues the pot slice, resets the life timer, bumps
`careCount`. Rate-limited by an on-chain per-pet cooldown. A lapsed-but-not-reaped pet CAN be re-cared
(revival): care needs only `!reaped` + season open + cooldown elapsed (there is NO `NotAlive` revert).

`actionType` is OPAQUE to the contract (stored/emitted only). The `feed/water/play/toy/explore = 0..4`
mapping is entirely a server-side convention; pick any scheme, the chain just echoes it.

Reverts:
- `NotAuthorizedCarer()`: caller is neither the pet owner nor the relayer.
- `SeasonIsClosed()`: the season has closed (no more caring).
- `NotCareable()`: pet not registered, or already reaped (GONE).
- `CareOnCooldown()`: `block.timestamp < lastCareAt + careCooldown()`.
- Insufficient TBA balance / revoked spender / cap hit are NOT PetVault errors: they bubble up from
  the pull path (`PetIssuer.pullCare` -> `WalletchiAccount.spend` -> SafeERC20), so you may see the token's
  `ERC20InsufficientBalance`, or `WalletchiAccount.NotSpender()`, or `WalletchiAccount.OverPerTxCap()` /
  `OverDailyCap()`. Treat any of these as "care failed, the pet will lapse."

### PetVault: reap (STABLE, wire now if you drive GONE)
```solidity
function reap(uint256 tokenId) external; // [PERMISSIONLESS]
```
Pure memorial bookkeeping. Pays NOTHING (the reaper bounty was removed, so culling can never drain the
pot). Records `diedAt` / `rank`, decrements `aliveCount`, flips the card to GONE. Reverts
`NotReapable()` (not registered or already reaped) or `NotExpired()` (still alive). The server/relayer
calls this for drama; no incentive is needed.

### PetVault: settlement (HOLD until post-audit ABI)
```solidity
function closeSeason(uint256 seedTokenId) external; // [OWNER] one-way close; 0 = no seed, else seed the initial candidate
function claimPot(uint256 tokenId) external; // [PERMISSIONLESS] record / supersede a candidate
function finalize() external;                // [PERMISSIONLESS] pay the winner after the window
```
After the season closes, the winner is the pet cared latest: MAX `lastCareAt`, tiebroken by higher
`careCount` then LOWER `tokenId`. `closeSeason(seedTokenId)` optionally seeds the initial candidate at
close (0 = none). `claimPot(tokenId)` records a candidate; calling it again with a STRICTLY-better pet
supersedes and resets the challenge window (there is no separate "supersede" function: claimPot IS the
supersede). Once `challengeDeadline` passes with no better candidate, `finalize()` (no args) pays the
WHOLE pot to the winning pet's TBA. A candidate must have `careCount > 0`.

`claimPot` reverts: `SeasonNotClosed()`, `GameOver()` (already finalized), `NotEnoughPlayers()`
(`registeredCount < minPlayers`), `NotRegistered()`, `NeverCared()`, `NotBetterCandidate()`.
`finalize` reverts: `SeasonNotClosed()`, `GameOver()`, `NoCandidate()`, `ChallengeOngoing()`.

---

## 3. Reads

### Redesign-STABLE (wire now)
```solidity
function careCost() external view returns (uint256);        // pulled per care (raw units)
function pot() external view returns (uint256);             // live prize pot (raw units)
function totalBurned() external view returns (uint256);     // lifetime care tokens burned
function aliveCount() external view returns (uint256);      // live survivor scoreboard
function registeredCount() external view returns (uint256); // pets ever registered
function deathCount() external view returns (uint256);      // running reap count
function alive(uint256 tokenId) external view returns (bool);
function lifeTtl() external view returns (uint256);         // GLOBAL, not per-pet
function careCooldown() external view returns (uint256);

// Per-pet life read. There is NO bare lastCareAt(uint256) getter: read it from here.
function lifeState(uint256 tokenId)
    external view returns (bool isAlive, uint64 lastCareAt, uint256 deadline);
//   deadline = lastCareAt + lifeTtl (the timestamp at which the pet lapses)

function petState(uint256 tokenId)
    external view returns (bool registered, bool reaped, uint64 lastCareAt, bool isAlive, uint256 secondsLeft);
//   secondsLeft = seconds until lapse (0 if dead / expired)

// Forever-keepsake memorial; all on-chain, no event indexer needed.
function memorialState(uint256 tokenId)
    external view returns (bool dead, uint64 bornAt, uint64 diedAt, uint32 careCount, uint32 rank);
//   dead      : has been reaped (GONE)
//   bornAt    : registration timestamp
//   diedAt    : reap timestamp (0 while alive)
//   careCount : lifetime successful care actions ("cared X times")
//   rank      : DEATH ORDER (1 = first pet reaped this season; higher = outlived more peers).
//               0 while alive AND for the sole survivor (the winner is never reaped).
//   "lived N days" = diedAt - bornAt (or now - bornAt while still alive).
```

### Phase + settlement (safe to READ; the flow they gate is HOLD)
```solidity
function isClosed() external view returns (bool);        // OPEN (mint + care) vs SETTLEMENT
function careDeadline() external view returns (uint256); // 0 = no auto-close (owner / maxSupply closes)
function seasonClosed() external view returns (bool);
function potClaimed() external view returns (bool);
function minPlayers() external view returns (uint256);
function winnerCandidate() external view returns (uint256);
function challengeDeadline() external view returns (uint256);
function challengeWindow() external view returns (uint256);
function settlementState()
    external view returns (uint256 candidate, uint64 candidateLastCareAt, uint256 challengeEndsAt, bool finalized);
```

Also available as plain getters: `careToken()`, `pet()`, `issuer()`, `relayer()`, `owner()`,
`potBps()`, `burnBps()`, `BURN_ADDRESS()`, `SWEEP_TIMELOCK()`, `MIN_LIFE_TTL()`, `MAX_LIFE_TTL()`.

---

## 4. Events

### PetIssuer
```solidity
event PetIssued(uint256 indexed tokenId, address indexed account, address indexed to);
```

### PetVault (STABLE)
```solidity
event Registered(uint256 indexed tokenId, uint256 aliveCount, uint256 registeredCount);
event Care(uint256 indexed tokenId, uint8 actionType, uint256 cost, uint256 burned, uint256 potContribution, uint256 potAfter);
event Reaped(uint256 indexed tokenId, address indexed reaper, uint32 rank, uint256 aliveCount);
```
`Care` is your "care applied" event (name is `Care`). `cost` is the amount ACTUALLY received
(fee-on-transfer safe), `burned` the burn slice, `potContribution` the pot slice this care, `potAfter`
the running pot total. `Reaped` is the death-feed (NO bounty field: the bounty was removed). `rank` is
the memorial death order.

### PetVault (SETTLEMENT: HOLD)
```solidity
event SeasonClosed(uint256 at);
event CandidateProposed(uint256 indexed tokenId, uint64 lastCareAt, uint256 challengeDeadline);
event Victory(uint256 indexed tokenId, address indexed tba, uint256 prize);
```
`Victory` IS the finalize / win event: there is NO separate `Finalized` event. `tba` is the winning
pet's account that received the pot. `CandidateProposed` fires on each claim/supersede for a live
settlement leaderboard.

Admin events (usually not consumed by the server): `RelayerSet`, `LifeTtlSet`, `CareDeadlineSet`,
`ConfigLocked`, `SweepQueued`, `SweepCancelled`, `SweepExecuted`.

---

## 5. Care token decimals

The care token is external, so its decimals are NOT fixed by our contracts:
- Testnet: `MockCareToken`, 18 decimals.
- Mainnet: Hunt's Pons token, decimals UNKNOWN until he delivers the address.

Read `decimals()` off the care-token contract at runtime and format `careCost()`, `pot()`, and
`totalBurned()` by it. Do NOT hardcode 18.

---

## 6. Deploy values (testnet defaults at commit 36328b0)

These are the `DeployWalletchi.s.sol` defaults, all env-overridable. The deploy asserts
`careCost <= perTxCap` and `careCost <= dailyCap`.

| Value | Default | Notes |
| --- | --- | --- |
| `careCost` | `1e18` | pulled from the pet's TBA per care |
| `perTxCap` | `1e18` (= `careCost`) | TBA per-transaction spend cap (on the issuer / TBA) |
| `dailyCap` | `24e18` (= `careCost * (1 day / careCooldown)`) | realistic 24h drain headroom |
| `careCooldown` | `3600` (1 hour) | min seconds between cares per pet; must be `< lifeTtl` |
| `challengeWindow` | `86400` (1 day) | settlement challenge window (recommended mainnet minimum 24h) |
| `lifeTtl` | `86400` (1 day) | per-care survival; owner-tunable in [1h, 30d] until lockConfig |
| `minPlayers` | `10` | registered pets required before a settlement (RAISE on mainnet) |
| `potBps` / `burnBps` | `1000` / `9000` | 10% pot, 90% burned |
| `careDeadline` | `0` | no auto-close (owner `closeSeason` or `maxSupply` closes) |
| `maxSupply` | `2000` | |
| `starterTokens` | `100e18` | seeded into each pet TBA at mint |

For the testnet dress rehearsal the operator will pass a SHORT `CARE_WINDOW_SECS`, `CARE_COOLDOWN`,
and `CHALLENGE_WINDOW` to stage a full-season victory quickly. So do not hardcode any of these: read
them from the vault (`careCost()`, `careCooldown()`, `challengeWindow()`, `lifeTtl()`, `minPlayers()`,
`careDeadline()`) at runtime.

---

## 7. Wiring plan

1. NOW: mint via `issuePet`; drive `care(tokenId, actionType)`; render the card from `lifeState` /
   `petState` / `memorialState`; show the pot + scoreboard from `pot` / `aliveCount` /
   `registeredCount` / `deathCount`; watch `Care` and `Reaped` for the tick engine + death-feed.
2. HOLD: `claimPot` / `finalize` / `settlementState` and the `CandidateProposed` / `Victory` events,
   plus the winner payout flow, until the lead hands the final post-audit ABI. `isClosed()` is safe to
   read to show the phase, but keep the settlement actions dark until then.

Ping runner-contracts if you want a trimmed human-readable ABI fragment for just the calls you use, or
if anything here does not match `abi/PetVault.json`.
