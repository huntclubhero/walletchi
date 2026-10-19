# WALLETCHI contracts

Foundry suite for WALLETCHI: a Tamagotchi-style pet NFT that lives in a wallet pass. Each pet owns
an ERC-6551 token bound account (TBA) holding a real care-token float; caring for the pet burns 90%
of every care fee and accrues 10% to a season pot paid to the last pet cared for. The full external
interface for the server team is in [INTERFACE-walletchi-v2.md](INTERFACE-walletchi-v2.md).

## Contracts

| Contract | Purpose |
| --- | --- |
| `Pet721` | The pet NFT. `name` / `symbol` set at deploy (env-config), sequential ids from 1, `maxSupply` cap (default 2000), free `mint(to)` restricted to the PetIssuer. ERC-2981 royalties (5% to a dedicated recipient), ERC-721C transfer validator (permissive when unset), and DEATH-SOULBOUND: a reaped pet can never be transferred again. ERC-7572 collection metadata (`contractURI`, owner-updatable via `setContractURI`, not locked). Four one-way locks: `lockIssuer`, `lockRoyalty`, `lockVaultRef`, `lockValidator` (freezes the transfer policy forever, strict OR permissive). |
| `PetIssuer` | Orchestrator. `issuePet` free-mints a pet, creates its TBA, appoints ITSELF as the TBA's capped spender (the WALLETCHI pet-account spender pattern), seeds the TBA with a starter care-token float, and registers the pet in the vault. Issuance refuses caps that would disenfranchise the pet (`perTxCap` must cover the vault's `careCost` and `dailyCap >= perTxCap`). `pullCare` (vault-only) pulls care tokens from a pet's TBA through the spender. `lockVault()` freezes the vault one-way after wiring so the standing spender can never be repointed (audit M-A). |
| `PetVault` | The survival economy: `care` burns 90% of the fee and accrues 10% to the pot; `reap` is memorial-only bookkeeping (no payout); once the season closes, an optimistic `claimPot` + `finalize` settlement pays the whole pot to the pet cared right up to the close. A timelocked owner sweep can take only genuine surplus; a permanently stranded pot is BURNED, never swept to a recipient. |
| `PonsCareToken` | Testnet mirror of a Pons-launchpad token (fixed supply, 18 decimals, optional transfer tax up to 10%) so the economy is proven against both plain and fee-on-transfer care tokens. Mainnet plugs in the real Pons token by address. |
| `MockCareToken` | 18-decimal freely mintable care-token stand-in. Dev/testnet only. |
| `WalletchiTransferValidator` | ERC-721C validator: `None` (permissive) or `OperatorAllowlist` security level per collection, with an owner-managed operator allowlist (e.g. the Seaport conduit) for royalty enforcement. |
| `WalletchiAccount` | ERC-6551 account implementation (erc6551/reference logic) plus an on-chain spending allowance: `initializeSpender` (once, issuer-gated), capped `spend`, owner `revokeSpender`. Owner keeps full `execute()` control. This is the LIVE, already-deployed implementation shared by every pet TBA. |

The suite uses the **canonical ERC-6551 registry** `0x000000006551c19487814612e58FE06813775758`,
which is already deployed on Robinhood Chain **mainnet AND testnet** (verified 2026-07-24). The TBA
salt is fixed at `bytes32(0)` (one account per pet).

### Self-custody model

The pet holder always owns the TBA (via the NFT) and can:
- call `execute()` to move any asset out at any time, and
- call `revokeSpender()` to permanently cut off the PetIssuer.

The PetIssuer is only a **spender**, bounded on-chain by a per-transaction cap and a rolling 24h
daily cap baked into each account at issuance. Caps are enforced inside `WalletchiAccount.spend`.

`initializeSpender` is gated to the bound token's issuer (`msg.sender` must equal the pet
contract's `issuer()`), so even though ERC-6551 account creation is permissionless, only the real
PetIssuer can appoint a spender. A pre-created account cannot be hijacked and cannot block
issuance. The server never calls `initializeSpender` directly; `issuePet` does it internally.

## Build and test

```bash
forge build
forge test            # 164 passed, 1 skipped (the fork rehearsal skips unless FORK_RPC is set)
```

Full-season dress rehearsal against the real chain (deploys the suite onto a pinned fork and runs a
staged season):

```bash
# The public RPCs are not archive nodes and the chain is fast, so pin a recent block.
FORK_RPC=https://rpc.testnet.chain.robinhood.com FORK_BLOCK=<recent block> \
  forge test --match-path test/runner/RehearsalFork.t.sol -vv
```

## WALLETCHI (survival pet economy, endgame redesign v2)

> **SUPERSEDED (noted 2026-10-17).** The Phases / Economy / Reaping text below describes the v2
> endgame (`closeSeason`, `careDeadline`, `claimPot`, challenge window, `reap`, a one-hour cooldown,
> a single life timer). None of those exist in `src/runner/PetVault.sol` today. Current rules, from
> the code: five needs (feed, water, play, toy, explore); a care resets only the need it serves; a
> pet is dead once `min(need stamps) + lifeTtl` has passed; `lifeTtl` is immutable (default 1 day);
> `careCooldown` defaults to 0 (live: 0); the season ends on the contract's own clock and
> `finalize()` / `pushPrize()` settle it. Read the PetVault natspec,
> not the paragraphs below. The Deploy section has been updated to the current script defaults.

**Phases.** One boundary splits the season. While OPEN, pets mint (register) and are cared for.
The season CLOSES on the first of: owner `closeSeason()` (one-way), the `careDeadline` timestamp, or
`maxSupply` reached. After close there is no minting or caring, and SETTLEMENT opens. `isClosed()`
reports the phase.

**Economy.** Each `care` pulls `careCost` from the pet's own ERC-6551 account, accounted on the
balance ACTUALLY received (fee-on-transfer safe): `potBps` (default 1000 = 10%) accrues to the pot and
the remainder (default 9000 = 90%) is burned to `0x…dEaD`. There is no treasury. `potBps + burnBps`
must equal 10000, and `careCost * potBps >= 10000` (every care contributes at least one unit to the
pot). Care is callable by the pet's OWNER or the relayer only (never fully open: force-care would let
a griefer drain a rival's TBA), and is rate-limited by an on-chain per-pet cooldown (`careCooldown`,
which must be `< lifeTtl`). Each care resets the life timer (`lifeTtl`, owner-tunable in [1h, 30d]
until `lockConfig`).

**Reaping and settlement.** A lapsed timer lets ANYONE `reap` a pet: this is pure memorial bookkeeping
(records `diedAt` / `rank`, flips the card to GONE) and pays NOTHING from the pot, so culling can never
drain the prize. The winner is decided by who was cared latest: after the season closes, `claimPot`
records a candidate and anyone may supersede it with a STRICTLY-better pet, each supersede resetting
the `challengeWindow`. Once the window elapses, `finalize()` pays the WHOLE pot to the winning pet's
TBA. Ordering: greater `lastCareAt`, then on a tie the higher `careCount` (sustained diligence beats
a low-id buzzer tap), then the lower `tokenId`. This is O(1) per call, always terminates, and always
yields a settleable winner even if every timer has lapsed. A candidate must have been cared at least
once (a last-second mint cannot win). `minPlayers` registered pets are required before a settlement.
`closeSeason` can seed the initial candidate at close (`closeSeason(seedTokenId)`, `0` = none) so
there is never an empty challenge window. **Buying the winning NFT before `finalize` buys the pot**
(it pays the pet's TBA, controlled by whoever holds the NFT): intended.

**Backstops.** A two-step, `SWEEP_TIMELOCK`-delayed owner sweep (`queueSweep` / `executeSweep`)
rescues donated or unrelated tokens. The LIVE pot is UNRUGGABLE: a careToken sweep may take only
genuine surplus (vault balance above the pot) unless the pot is finished (`potClaimed`), when the
residual is fully sweepable. A pot permanently STRANDED (season closed with fewer than `minPlayers`)
is player-funded value: the sweep BURNS it to the dead address (`StrandedPotBurned`) and the sweep
recipient still receives only genuine surplus. The timelock also guarantees a live pot can always be
`finalize`d first.

**Secondary market (Pet721 v2).** ERC-2981 5% royalties to a dedicated recipient (owner-settable,
then `lockRoyalty`). ERC-721C validator, permissive by default; the operator can flip
`WalletchiTransferValidator` to `OperatorAllowlist` after a live enforced-listing test, then
`lockValidator` freezes the policy forever (locking while unset makes PERMISSIVE permanent instead).
DEATH-SOULBOUND ships hard: a reaped pet is a permanent memorial in the wallet that lost it.

### Deploy

Step 1: ensure the registry exists (a no-op on Robinhood, both networks):

```bash
forge script script/DeployRegistry.s.sol:DeployRegistry \
  --rpc-url https://rpc.testnet.chain.robinhood.com --broadcast
```

This checks for the canonical registry and, only if absent, deploys it through Nick's factory using
the exact vendored creation bytecode. It reverts before broadcasting if that bytecode does not
reproduce the canonical address.

Step 2: deploy the WALLETCHI suite:

```bash
# Testnet dry-run (simulate; the lead adds --broadcast to send)
PRIVATE_KEY=0x... RELAYER=0x... PET_NAME=WALLETCHI PET_SYMBOL=WCHI \
ACCOUNT_IMPL=<fresh WalletchiAccount from this commit> \
  forge script script/DeployWalletchi.s.sol:DeployWalletchi \
  --rpc-url https://rpc.testnet.chain.robinhood.com
```

`ACCOUNT_IMPL` must be a `WalletchiAccount` deployed from the current commit. The script refuses any
impl without `CARER_CAP_BPS()` and `CARER_MAX_SPENDS_PER_WINDOW()` (both the old default
`0x0A7eF0f8...6e66` and the season-2 impl `0xb73E98C4...090D` are refused), and on mainnet it also
requires the codehash to match.

Env vars (all optional except `PRIVATE_KEY`; the full list with reasons is the header of
`script/DeployWalletchi.s.sol`): `PET_NAME` (default `WALLETCHI`), `PET_SYMBOL` (default `WCHI`),
`CARE_TOKEN_ADDRESS` (unset deploys MockCareToken), `MAX_SUPPLY` (2000), `LIFE_TTL` (1 day, per
unserved need; immutable once deployed), `CARE_COST` (1e18), `POT_BPS` / `REWARDS_BPS` / `GAS_BPS`
(1000 / 2000 / 100; `BURN_BPS` defaults to the remainder), `MIN_PLAYERS` (10), `CARE_COOLDOWN` (0: no
cooldown; must be `< LIFE_TTL`), `ENTRY_WINDOW_SECS` (7 days), `MIN_SEASON_DURATION` (30 days),
`PER_TX_CAP` (default `CARE_COST`), `DAILY_CAP` (default `CARE_COST * 500`, PR #36; an approved carer
is held to the lesser of half of it and 10 cares per window by `WalletchiAccount`), `STARTER_TOKENS`
(100e18), `MOCK_CARE_FLOAT` (200000e18). `DAILY_CAP` and `PER_TX_CAP` are written into each pet
account at mint, so changing them only affects pets minted by a new deploy. The script deploys,
wires (`setIssuer` + `lockIssuer`, `setVault` + `lockVault`), and seeds the mock float. Both one-way
locks fire at deploy so the mint path and the spender's vault are frozen in production.

Chain facts: Robinhood mainnet chainId **4663** (`https://rpc.mainnet.chain.robinhood.com`),
testnet **46630** (`https://rpc.testnet.chain.robinhood.com`), gas is ETH.

### Server / relayer integration

```solidity
// PetIssuer (relayer mints; the server pays gas).
function issuePet(address to) external returns (uint256 tokenId, address account); // onlyRelayer
function accountOf(uint256 tokenId) external view returns (address);

// PetVault mutations.
function care(uint256 tokenId, uint8 actionType) external;   // pet OWNER or relayer; FEED/WATER/PLAY/TOY/EXPLORE
function reap(uint256 tokenId) external;                      // permissionless, memorial-only (no payout)
function claimPot(uint256 tokenId) external;                  // after close: record/supersede a candidate
function finalize() external;                                 // after the challenge window: pay the winner
function closeSeason(uint256 seedTokenId) external;           // owner one-way close; seedTokenId 0 = no seed, else seed the initial candidate

// Reads for the server / site (stable, exported names).
function isClosed() external view returns (bool);            // OPEN vs SETTLEMENT phase
function careCost() external view returns (uint256);
function pot() external view returns (uint256);              // live prize pot
function totalBurned() external view returns (uint256);
function aliveCount() external view returns (uint256);       // live survivor scoreboard
function registeredCount() external view returns (uint256);
function deathCount() external view returns (uint256);
function careDeadline() external view returns (uint256);
function alive(uint256 tokenId) external view returns (bool);
function lifeState(uint256 tokenId)
    external view returns (bool isAlive, uint64 lastCareAt, uint256 deadline);
function petState(uint256 tokenId)
    external view returns (bool registered, bool reaped, uint64 lastCareAt, bool isAlive, uint256 secondsLeft);
function memorialState(uint256 tokenId)                      // forever-keepsake, all on-chain
    external view returns (bool dead, uint64 bornAt, uint64 diedAt, uint32 careCount, uint32 rank);
function settlementState()
    external view returns (uint256 candidate, uint64 candidateLastCareAt, uint256 challengeEndsAt, bool finalized);

// Owner (before lockConfig / close).
function setLifeTtl(uint256 lifeTtl_) external;   // within [1h, 30d], must stay > careCooldown
function setCareDeadline(uint256 ts) external;    // 0 clears; must be in the future; before close
function lockConfig() external;                   // one-way freeze of lifeTtl / careDeadline
function queueSweep(address token, address to, uint256 amount) external; // then executeSweep after SWEEP_TIMELOCK
```

Events:

```solidity
event PetIssued(uint256 indexed tokenId, address indexed account, address indexed to);
event Registered(uint256 indexed tokenId, uint256 aliveCount, uint256 registeredCount);
event Care(uint256 indexed tokenId, uint8 actionType, uint256 cost, uint256 burned, uint256 potContribution, uint256 potAfter);
event Reaped(uint256 indexed tokenId, address indexed reaper, uint32 rank, uint256 aliveCount); // no bounty
event SeasonClosed(uint256 at);
event CandidateProposed(uint256 indexed tokenId, uint64 lastCareAt, uint256 challengeDeadline);
event Victory(uint256 indexed tokenId, address indexed tba, uint256 prize);
event StrandedPotBurned(uint256 amount);
```

The memorial keepsake reads entirely on-chain via `memorialState` (no event indexer needed): `bornAt`
is the registration time, `diedAt` the reap time (so **lived N days = `diedAt - bornAt`**), `careCount`
the lifetime number of successful cares ("cared X times"), and `rank` the pet's **death order:
`rank == 1` is the first pet reaped this season, incrementing by one per reap, so a higher rank means
the pet outlived more of its peers**. `rank` is `0` while a pet is alive and stays `0` for the sole
survivor (it wins the pot and is never reaped). `deathCount` is the running total of reaps; the live
survivor count is `aliveCount`. `Reaped` / `Victory` events drive the death-feed and milestone pings.
ABIs: `abi/Pet721.json`, `abi/PetIssuer.json`, `abi/PetVault.json`. Economy v3 (UNAUDITED, pending
audit wave) adds the three-leg care split plus `abi/RewardsDistributor.json` / `abi/IRewardsSink.json`;
see `INTERFACE-walletchi-v3.md` for the ABI delta (new `Care` field, new vault getters, distributor).

## ERC-6551 registry provenance

The vendored registry creation bytecode in `script/DeployRegistry.s.sol` was reconstructed from the
on-chain registry runtime (solc 0.8.17, optimizer 200) and verified: with Nick's factory
`0x4e59b44847b379578588920cA78FbF26c0B4956C` and salt
`0x0000000000000000000000000000000000000000fd8eb4e1dca713016c518e31` it CREATE2s to the canonical
`0x000000006551c19487814612e58FE06813775758`. `test/RegistryBytecode.t.sol` asserts this and that the
bytecode deploys a functional registry.

## Heritage note

WALLETCHI grew out of earlier Halldon card and runner projects. Those contracts are deleted from
`src/` (the deployed testnet instances are immutable and unaffected); `WalletchiAccount` (renamed
from the original account contract, same already-deployed bytecode) remains because it is the LIVE,
shared ERC-6551 account implementation every pet TBA runs on, and its ABI is `abi/WalletchiAccount.json`.
`abi/RunnerIssuer.json` remains because the server still import-loads it by name (the deployed-issuer
auto-detect path): it is a legacy on-chain contract whose function/event/error names are on-chain selectors.
