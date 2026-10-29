# WALLETCHI economy v3: ABI delta note (three-leg split + RewardsDistributor)

> STATUS: UNAUDITED, PENDING AUDIT WAVE. This documents the v3 economy changes on top of the v2
> vault interface (`INTERFACE-walletchi-v2.md`). Do NOT wire mainnet against this until the audit
> wave clears it. Source of truth for the ABI: `contracts/abi/PetVault.json`,
> `contracts/abi/RewardsDistributor.json`, `contracts/abi/IRewardsSink.json` (regenerated with these
> changes). All amounts are RAW care-token units.

v3 turns the two-leg care fee split (pot + burn) into a THREE-leg split (pot + rewards + burn) and
adds a `RewardsDistributor` that redistributes the rewards leg to ACTIVE players, paid into each pet's
own ERC-6551 account (the same money-rides-the-pet pattern as the winner pot).

---

## 1. PetVault ABI delta

### Constructor `Params` (two new fields)

`Params` gains two fields (named-argument construction, so field order in the ABI tuple is what
matters; both are appended after `burnBps`):

| field | type | meaning |
| --- | --- | --- |
| `rewardsBps` | `uint256` | rewards slice of each care fee (bps). `0` disables the rewards leg. |
| `rewardsRecipient` | `address` | the `RewardsDistributor` (or any `IRewardsSink`). `address(0)` iff `rewardsBps == 0`. |

Validation (constructor reverts):
- `potBps + burnBps + rewardsBps == BPS` (10000), else `BadBps`.
- `rewardsBps > 0` requires `rewardsRecipient != address(0)`, else `ZeroAddress`.
- Existing pot dust guard unchanged: `careCost * potBps >= BPS`, else `BadConfig`.
- New rewards dust guard (only when enabled): `rewardsBps > 0 => careCost * rewardsBps >= BPS`, else `BadConfig`.

BACKWARDS COMPATIBLE: `rewardsBps: 0, rewardsRecipient: address(0)` reproduces the pre-v3 two-leg
deploy exactly (no rewards transfer, no hook call, `burnShare == received - potShare`).

### New getters

- `rewardsBps() -> uint256`
- `rewardsRecipient() -> address`
- `totalRewards() -> uint256` (lifetime care tokens routed to the rewards recipient, raw units SENT)

### `Care` event (one new field)

Was: `Care(uint256 indexed tokenId, uint8 actionType, uint256 cost, uint256 burned, uint256 potContribution, uint256 potAfter)`

Now: `Care(uint256 indexed tokenId, uint8 actionType, uint256 cost, uint256 burned, uint256 potContribution, uint256 rewardsContribution, uint256 potAfter)`

`rewardsContribution` is inserted before `potAfter`. Any indexer/decoder for `Care` MUST update.

### `care()` behavior

On each care, the fee (measured on the balance ACTUALLY received, fee-on-transfer safe) is split:
`potShare = received * potBps / BPS`, `rewardsShare = received * rewardsBps / BPS`, and
`burnShare = received - potShare - rewardsShare` (burn takes the rounding dust so the three legs sum
EXACTLY to `received`). When `rewardsBps > 0`, the vault transfers `rewardsShare` to
`rewardsRecipient` and then calls the REQUIRED hook `IRewardsSink.notifyCare(tokenId, account, rewardsShare)`
(`account` = the pet's TBA from `issuer.accountOf`). A reverting hook reverts the care, so reward
accounting can never silently drift from the funds moved.

---

## 2. IRewardsSink

```
interface IRewardsSink {
    function notifyCare(uint256 tokenId, address account, uint256 amount) external;
}
```

`amount` is the slice the vault SENT (advisory; the sink recognizes the ACTUAL received funds by its
own balance delta, so a taxed care token is booked exactly).

---

## 3. RewardsDistributor surface

Epoch-based, activity-weighted rewards. `epochNow() = (block.timestamp - deployTime) / epochLength`.

Deploy/wire: construct `RewardsDistributor(owner, careToken, epochLength)`, deploy the vault pointing
`rewardsRecipient` at it, then `setVault(vault)` on the distributor (settable ONCE by owner, then
permanently frozen: `notifyCare` accepts only the vault).

Writes:
- `notifyCare(tokenId, account, amount)` VAULT-ONLY. Records ONE point for the pet in the current
  epoch (activity, NOT amount-weighted, so a whale cannot buy the pool), remembers the pet TBA, and
  accrues the funds received (measured by balance delta) into the epoch pool.
- `claim(epoch, tokenId) -> payout` permissionless; only for FINISHED epochs; pays
  `epochPool * points / totalPoints` INTO the pet's recorded TBA; once per (epoch, pet); claimable
  forever. Funds leave the contract ONLY via claim (no owner sweep, no rug path).
- `claimMany(epoch, tokenId[]) -> total` convenience.
- `sync()` permissionless; folds any not-yet-recognized balance (e.g. a direct donation) into the
  current epoch's pool.
- `rollForward(epoch)` permissionless; carries a FINISHED, ZERO-POINT epoch's pool into the next
  epoch so it is never trapped (a pointless epoch has no pro-rata claimant).

Views: `epochNow()`, `pendingReward(epoch, tokenId)`, `epochStats(epoch) -> (pool, points, finished)`,
plus public mappings `epochPool`, `totalPoints`, `points`, `claimed`, `accountOf`, `rolledForward`,
and `accounted`, `vault`, `careToken`, `epochLength`, `deployTime`.

Events: `VaultSet`, `CareRecorded(epoch, tokenId, account, declared, recognized)`, `Synced`,
`RolledForward(fromEpoch, toEpoch, amount)`, `Claimed(epoch, tokenId, account, amount)`.

### Accounting decisions (for auditors)

- POINTS: exactly one point per care, not amount-weighted. Documented anti-whale choice.
- POOL: accrual by MEASURED balance delta (`balanceOf - accounted`), exact under a fee-on-transfer /
  taxed care token. A claim debits `accounted` by the payout, preserving `balanceOf >= accounted`.
- DONATIONS: care tokens sent directly to the contract are NOT lost; the next `notifyCare` or a
  `sync()` folds them into the current epoch (enriching that epoch's claimants). A donation that lands
  in an epoch which ends point-less is carried by `rollForward` rather than stranded. (Floor-division
  dust from pro-rata claims stays in the contract, permanently unclaimable, i.e. effectively burned.)
- NO ADMIN WITHDRAWAL: the owner's only power is the one-time `setVault`. There is no sweep.

---

## 4. Pet721 ABI delta (ERC-7572 collection metadata)

Pet721 gains ERC-7572 collection-level metadata (for the OpenSea and other marketplace collection page):

- Constructor: one new trailing param `string contractURI_` (the initial URI; may be empty). All
  `new Pet721(...)` call sites gain a 6th argument.
- `contractURI() external view returns (string)`: the ERC-7572 collection metadata URI.
- `setContractURI(string) external onlyOwner`: updates it and emits `ContractURIUpdated`.
- `event ContractURIUpdated()`: emitted on every change AND once from the constructor (indexers refresh).
- Metadata-only: deliberately NOT locked (owner-key custody covers it; collection art/copy may change).
  The server serves the target at `/api/collection.json`; wire it via the new deploy env `CONTRACT_URI`
  (default empty) or the owner's `setContractURI` post-deploy.

## 5. Deploy note (three-leg wiring)

`script/DeployWalletchi.s.sol` now wires the full three-leg deploy:

- New envs: `REWARDS_BPS` (default 2000), `EPOCH_LENGTH` (seconds, default 86400), `CONTRACT_URI`
  (plain string, default empty). `BURN_BPS` now defaults to the remainder `10000 - POT_BPS -
  REWARDS_BPS` (so 7000 with the defaults; 9000 when `REWARDS_BPS=0`); an explicit `BURN_BPS` overrides.
- When `REWARDS_BPS > 0`: deploys `RewardsDistributor(owner, careToken, EPOCH_LENGTH)`, deploys the
  vault with `rewardsRecipient` = the distributor, then (owner==deployer) calls `distributor.setVault(vault)`
  and require()s it took. `notifyCare` accepts only that vault, so the wiring MUST happen before the
  season opens; when owner != deployer the script prints a NOTE for the owner to call setVault.
- When `REWARDS_BPS == 0`: NO distributor is deployed and the vault is a clean two-leg deploy
  (`rewardsRecipient = address(0)`), byte-identical to the pre-v3 behavior.
- Defensive `require(POT_BPS + BURN_BPS + REWARDS_BPS == 10000)` in the deploy helper fails a
  misconfigured split loudly before any wiring (the vault constructor also enforces it via `BadBps`).
- `forge test` does not exercise scripts; this wiring is validated live in the dress rehearsal.

## 6. Account contract rename (WalletchiAccount) and a CHANGED ERROR SELECTOR

The shared ERC-6551 account contract was renamed `PunchAccount` -> `WalletchiAccount` (identifier +
comments only, zero logic change; the deployed testnet bytecode is unaffected). Its ABI artifact moved
from `abi/PunchAccount.json` to `abi/WalletchiAccount.json`.

AUDITOR NOTE (selector change): two internal identifiers in that contract were also renamed:
`interface ICardIssuerSource` -> `IPetIssuerSource`, and `error NotCardIssuer()` -> `error NotPetIssuer()`.
The custom-error name change means the ERROR SELECTOR changes:
`NotCardIssuer()` (0x...) is replaced by `NotPetIssuer()`. This is intentional and accepted: mainnet
deploys fresh from this source, and a legacy testnet revert that no longer decodes by name in server
logs is cosmetic. No function/event signature changed, so all call selectors are unchanged.

## 7. FIX WAVE (post-audit), pending re-audit

> STATUS: applied after the 3-lens audit, PENDING RE-AUDIT. ABIs regenerated
> (`abi/PetVault.json`, `abi/RewardsDistributor.json`). Every item below is a surgical fix to a named
> finding; no unrelated behavior changed. `via_ir` stays `false`.

### PetVault

- **H-1 reap grace window (new `reapGrace`).** `reap()` used to let anyone reap a pet the instant its
  life timer lapsed, while `care()` still accepts a lapsed-but-not-reaped pet (revival). A griefer
  could front-run a revival to permanently soulbound-kill any pet that lapsed once. Fix:
  - New constant `MAX_REAP_GRACE = 7 days` and new immutable `reapGrace` (getter `reapGrace()`).
  - New `Params` field `reapGrace` (a `uint256`, inserted after `careCooldown`, before `careDeadline`).
    EVERY `new PetVault(...)` construction gains it. Validation: `reapGrace <= MAX_REAP_GRACE`, else
    `BadConfig`. `reapGrace: 0` reproduces the old no-grace timing (reapable the instant `lifeTtl`
    lapses).
  - `reap()` now requires `lastCareAt + lifeTtl + reapGrace <= block.timestamp` (was `+ lifeTtl`), so a
    pet is reapable only AFTER the grace also elapses. `alive()` / `petState` / `lifeState` are
    UNCHANGED: a pet still reads not-alive (fading) at `lifeTtl`; it is just not yet reapable, so its
    owner/relayer can always revive it via `care()` during the grace.
- **H-2 owner-seeded close only (`isClosed` semantics + `closeSeason` seed requirement).** The season
  used to auto-close on `careDeadline` OR `maxSupply`, and those paths opened settlement UNSEEDED,
  letting an attacker `claimPot` an inferior pet as the first candidate. Fix:
  - `isClosed()` now returns ONLY `seasonClosed`. The season closes EXCLUSIVELY via the owner's
    `closeSeason()`. `careDeadline` is retained as an ADVISORY close-time signal the off-chain server
    reads to decide WHEN to call `closeSeason` (its constructor validation is unchanged); it no longer
    auto-closes. The NFT-level `maxSupply` cap still bounds minting in `Pet721`, independent of this
    flag.
  - `closeSeason(seedTokenId)`: after setting `seasonClosed`, a settleable season MUST be seeded. New
    body intent: `if (seedTokenId != 0) _proposeCandidate(seedTokenId); else if (pot > 0 &&
    registeredCount >= minPlayers) revert SeedRequired();`. New `error SeedRequired()`. Rationale:
    `pot > 0` iff at least one care happened (`potBps >= 1` is guaranteed at construction), so a real,
    settleable season must seed the true-max candidate; once the true max is seeded the strictly-better
    rule means no inferior pet can supersede it. A no-care season (`pot == 0`) may close unseeded. A
    season with a pot but too few players to settle (`registeredCount < minPlayers`) may also close
    unseeded: settlement is already blocked by the player floor, so no empty-window attack exists there,
    and the unseeded close lets the `executeSweep` stranded-pot burn backstop run (a hard seed
    requirement would otherwise be unseedable and brick the owner's close). See the residual note below.

### RewardsDistributor

- **L-A2 saturating `_recognize`.** `recognized = balanceOf - accounted` is now
  `recognized = bal > accounted ? bal - accounted : 0`. A care token that reduces this contract's
  balance OUT OF BAND (clawback / blacklist / rebase-down) below `accounted` can no longer underflow
  and revert; it recognizes 0. Because the `notifyCare` hook is REQUIRED, this stops such a drop from
  bricking `care()` for everyone. `accounted` is only ever raised toward the current balance.
- **L-A3 guarded `sync()` / `rollForward()`.** Both are now `nonReentrant` (`claim`/`claimMany` already
  were). This closes the pathological-token reentrancy where a care token reenters `sync()` during a
  claim payout and re-recognizes the outgoing payout, corrupting the pool. The reentrant call now
  reverts and unwinds the claim atomically.
- **econ-Low rollForward stranding.** `rollForward(epoch)` now credits `epochPool[epochNow()]` (the LIVE
  epoch) instead of `epochPool[epoch + 1]`, and the `RolledForward` event's `toEpoch` is `epochNow()`.
  Crediting `epoch+1` blindly could land a zero-point pool in an already-finished, already-claimed epoch
  and strand it forever; the live epoch is always still claimable, so a rolled pool can never strand.
  (This also incidentally closes the L-2 zero-payout-claim forfeiture: a finished epoch's pool is now
  immutable, so a zero-payout claim can no longer forfeit a later-rolled reward.)
- **L-A1 `setVault` sanity.** `setVault` now reverts `VaultNotContract` if `vault_.code.length == 0`.
  This catches the EOA footgun (a wrong EOA frozen in would brick `care()` forever with no recovery). It
  does NOT catch a wrong CONTRACT address; the deploy script's post-wire `require(dist.vault() ==
  vault)` is the check that catches that. New `error VaultNotContract()`.

### Deploy + ABI

- `script/DeployWalletchi.s.sol` gains a `REAP_GRACE` env (default `86400` = 24h, mirroring the server
  grace; bounded by `MAX_REAP_GRACE`) threaded into `Params`, plus a report line.
- `abi/PetVault.json` and `abi/RewardsDistributor.json` regenerated: `Params` gains `reapGrace`; new
  getters `reapGrace()` and `MAX_REAP_GRACE()`; new errors `SeedRequired` (PetVault) and
  `VaultNotContract` (RewardsDistributor). No event signatures changed.

### Residual edges flagged for re-audit

- `closeSeason` seed requirement is intentionally gated on `registeredCount >= minPlayers` (not on
  `pot > 0` alone) so the owner can still close a too-few-players season and trigger the stranded-pot
  burn backstop. This deviates from a strict "any pot must seed" reading but is necessary: with a pure
  `pot > 0` guard, a 1-player-cared season would be both unseedable (`_proposeCandidate` reverts
  `NotEnoughPlayers`) and unclose-able (`SeedRequired`), permanently trapping the pot with no backstop.
- `setVault`'s contract check is EOA-only; a wrong contract address is still freezable. Production
  relies on the deploy-script post-wire assertion.
- The rollForward destination is now the live epoch. If the live epoch itself ends point-less, the pool
  is still recoverable via a subsequent `rollForward` into the next live epoch (idempotent, never
  stranded), but a keeper must keep rolling until an epoch with points claims it.

## 8. RE-AUDIT FOLLOW-UPS (applied)

> STATUS: applied after the 2-lens re-audit of section 7. Full suite 262 passed / 0 failed / 1 skipped,
> lead-verified. Both re-audit lenses returned GO (PetVault) / GO-WITH-FIXES (RewardsDistributor); the
> two items below close the only non-blocking findings the re-audit raised.

- **L-A3 completeness (`notifyCare` now `nonReentrant`).** The section-7 fix guarded `sync()` and
  `rollForward()` but left `notifyCare()` (the third `_recognize` caller) unguarded. A pathological
  care token that owns a careable pet could, from inside a claim payout, reenter
  `vault.care() -> notifyCare() -> _recognize()` and book the outgoing payout as a phantom inflow (the
  same corruption the `sync` guard closes). Not production-reachable (the Pons token has no transfer
  callback), but `notifyCare` is now `nonReentrant` for completeness: it is entered exactly once per
  honest care (never nested), so the guard is side-effect free on the honest path. No ABI change (a
  modifier does not alter the signature).
- **F1 deploy-time `reapGrace > 0` assertion.** The constructor permits `reapGrace == 0` (tests use it
  for the old reap-at-`lifeTtl` timing), but 0 in production silently reintroduces H-1. The deploy
  script now hard-requires `REAP_GRACE > 0`, so the vulnerable config cannot ship. (A constructor floor
  was declined to avoid churning the many timing tests that legitimately use `reapGrace: 0`.)
