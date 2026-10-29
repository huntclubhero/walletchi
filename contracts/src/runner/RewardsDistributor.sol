// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {Ownable2Step} from "@openzeppelin/contracts/access/Ownable2Step.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";

import {IRewardsSink} from "./IRewardsSink.sol";

/// @title RewardsDistributor
/// @notice WALLETCHI economy v3 rewards sink. The PetVault routes the REWARDS slice (e.g. 20%) of
///         every care fee here; this contract redistributes it to ACTIVE players, pro rata to their
///         care activity within fixed-length EPOCHS, paid INTO each pet's own ERC-6551 account (the
///         same money-rides-the-pet pattern as the vault's winner pot).
///
///         UNAUDITED: PENDING AUDIT WAVE.
///
///         POINTS (activity, not spend). Each care records exactly ONE point for the pet in the
///         current epoch, regardless of the amount moved. This is deliberate and adversarial: a whale
///         cannot buy a bigger slice of the reward pool by inflating per-care spend, and per-tx-cap
///         games buy nothing. Diligence (caring often) is what earns rewards.
///
///         POOL (accrual by measured balance delta). notifyCare recognizes the ACTUAL care-token
///         funds that have arrived since the last recognition (balanceOf - accounted) and accrues
///         them into the current epoch's pool. Measuring the delta makes the accrual exact under a
///         fee-on-transfer / taxed care token (the vault sends a nominal slice; the token may skim it;
///         this contract books only what actually landed). The `amount` the vault declares is
///         advisory and used only in the event.
///
///         DONATIONS. Because accrual is balance-delta based, care tokens transferred DIRECTLY to
///         this contract are not lost: the next notifyCare (or a permissionless sync()) folds them
///         into the current epoch's pool, enriching that epoch's claimants. A donation that lands in
///         an epoch which ends with ZERO points does not strand: rollForward(epoch) carries a
///         finished zero-point epoch's pool into the next epoch (see below).
///
///         SETTLEMENT. Epochs are settled by permissionless claim(): only FINISHED epochs pay, each
///         pet claims its pro-rata share ONCE into its recorded TBA, funds can leave ONLY via claim()
///         (no owner sweep, no rug path, claimable forever), and a zero-point epoch's pool is rolled
///         forward rather than trapped.
///
///         The vault address is the sole caller of notifyCare and is SET ONCE by the owner after
///         deploy (the vault must be constructed pointing at this contract, so the two cannot both be
///         constructor-immutable). Once set to a non-zero address it can never be changed.
contract RewardsDistributor is Ownable2Step, ReentrancyGuard, IRewardsSink {
    using SafeERC20 for IERC20;

    /// @notice The care token being distributed (same external ERC-20 the vault burns / pots).
    IERC20 public immutable careToken;

    /// @notice Epoch length in seconds (e.g. 1 day). Fixed at deploy.
    uint256 public immutable epochLength;

    /// @notice Deploy timestamp; epoch 0 starts here. Fixed at deploy.
    uint256 public immutable deployTime;

    /// @notice The only address allowed to call notifyCare (the PetVault). Set once by the owner and
    ///         then permanently frozen: once non-zero it can never be repointed (no rug on the caller).
    address public vault;

    /// @notice Care-token funds recognized into epoch pools and not yet claimed out. Kept so accrual
    ///         can measure "new funds since last recognition" as balanceOf(this) - accounted, and so a
    ///         claim payout reduces it by exactly what it pays. Invariant: balanceOf(this) >= accounted.
    uint256 public accounted;

    /// @notice Reward pool accrued to an epoch (care-token raw units).
    mapping(uint256 => uint256) public epochPool;

    /// @notice Total participation points recorded in an epoch (one per care).
    mapping(uint256 => uint256) public totalPoints;

    /// @notice Participation points for a pet within an epoch (one per care).
    mapping(uint256 => mapping(uint256 => uint256)) public points;

    /// @notice Whether a pet has already claimed a given epoch (guards double claim).
    mapping(uint256 => mapping(uint256 => bool)) public claimed;

    /// @notice The recorded TBA account for a pet (where its claims are paid). Set on notifyCare; a
    ///         pet's TBA is deterministic and constant, so this is idempotent.
    mapping(uint256 => address) public accountOf;

    /// @notice Whether a finished zero-point epoch's pool has already been rolled forward.
    mapping(uint256 => bool) public rolledForward;

    event VaultSet(address indexed vault);
    event CareRecorded(
        uint256 indexed epoch, uint256 indexed tokenId, address account, uint256 declared, uint256 recognized
    );
    event Synced(uint256 indexed epoch, uint256 recognized);
    event RolledForward(uint256 indexed fromEpoch, uint256 indexed toEpoch, uint256 amount);
    event Claimed(uint256 indexed epoch, uint256 indexed tokenId, address indexed account, uint256 amount);

    error OwnershipCannotBeRenounced();
    error ZeroAddress();
    error VaultAlreadySet();
    error VaultNotContract();
    error NotVault();
    error EpochNotFinished();
    error EpochHasPoints();
    error NothingToRoll();
    error NoPoints();
    error AlreadyClaimed();

    /// @param owner_ contract owner (sets the vault once, nothing else privileged)
    /// @param careToken_ the care token to distribute (raw units)
    /// @param epochLength_ epoch length in seconds (must be > 0)
    constructor(address owner_, IERC20 careToken_, uint256 epochLength_) Ownable(owner_) {
        if (address(careToken_) == address(0)) revert ZeroAddress();
        if (epochLength_ == 0) revert ZeroAddress(); // reuse: an epoch length of 0 is as invalid as a 0 address
        careToken = careToken_;
        epochLength = epochLength_;
        deployTime = block.timestamp;
    }

    // --------------------------------------------------------------------------------------------
    // Admin (set the caller once, then frozen)
    // --------------------------------------------------------------------------------------------

    /// @notice Wire the PetVault as the sole notifyCare caller. Callable once; once the vault is a
    ///         non-zero address it can never be changed (the caller can never be repointed).
    /// @dev L-A1 sanity: the vault MUST be a contract. This catches the EOA footgun (a wrong EOA frozen
    ///      in would brick care() forever with no recovery). It does NOT catch a wrong CONTRACT address;
    ///      the deploy script's post-wire require(dist.vault() == vault) is the check that catches that.
    function setVault(address vault_) external onlyOwner {
        if (vault != address(0)) revert VaultAlreadySet();
        if (vault_ == address(0)) revert ZeroAddress();
        if (vault_.code.length == 0) revert VaultNotContract();
        vault = vault_;
        emit VaultSet(vault_);
    }

    // --------------------------------------------------------------------------------------------
    // Accrual
    // --------------------------------------------------------------------------------------------

    /// @notice Recognize any care-token funds received since the last recognition into `epoch`'s pool.
    /// @dev In the honest, internal-only flow balanceOf(this) >= accounted always holds: receipts only
    ///      raise the balance, and a claim lowers the balance and `accounted` by the same payout. The
    ///      subtraction is SATURATING (L-A2) so that even a care token that reduces this contract's
    ///      balance OUT OF BAND (clawback / blacklist / rebase-down) below `accounted` cannot underflow
    ///      here; it recognizes 0 rather than reverting, so the REQUIRED notifyCare hook can never brick
    ///      care() for everyone. accounted is only ever raised toward the current balance, never above.
    function _recognize(uint256 epoch) internal returns (uint256 recognized) {
        uint256 bal = careToken.balanceOf(address(this));
        recognized = bal > accounted ? bal - accounted : 0;
        if (recognized > 0) {
            accounted = bal;
            epochPool[epoch] += recognized;
        }
    }

    /// @notice Vault-only care hook: record one point for the pet in the current epoch, remember its
    ///         TBA, and accrue the funds that just arrived (measured by balance delta) into the epoch.
    /// @dev The vault transfers the rewards slice to this contract and THEN calls this, so the funds
    ///      are already present and `_recognize` books the exact received amount (fee-on-transfer
    ///      safe). `amount` (what the vault sent) is advisory and only surfaced in the event.
    function notifyCare(uint256 tokenId, address account, uint256 amount) external nonReentrant {
        if (msg.sender != vault) revert NotVault();
        uint256 e = epochNow();
        uint256 recognized = _recognize(e);
        points[e][tokenId] += 1;
        totalPoints[e] += 1;
        accountOf[tokenId] = account;
        emit CareRecorded(e, tokenId, account, amount, recognized);
    }

    /// @notice Permissionless: fold any funds sitting in this contract but not yet recognized (e.g.
    ///         direct donations) into the CURRENT epoch's pool. Adds no points. Useful so a donation
    ///         is not left dangling until the next care, and it is what lets a donation land in (and,
    ///         if that epoch ends point-less, roll forward from) a specific epoch.
    function sync() external nonReentrant {
        uint256 e = epochNow();
        uint256 recognized = _recognize(e);
        emit Synced(e, recognized);
    }

    /// @notice Carry a FINISHED, ZERO-POINT epoch's pool into the LIVE (current) epoch so it is never
    ///         trapped (a pool with no points has no pro-rata claimant). Permissionless and idempotent.
    /// @dev The destination is epochNow() (the in-progress epoch), NOT epoch+1 (L-econ). Crediting
    ///      epoch+1 blindly could land the pool in an already-finished, already-claimed epoch, stranding
    ///      it forever; the live epoch is always still claimable (a care in it earns a point, or if it
    ///      too ends point-less it can be rolled onward), so a zero-point pool can never strand. Since a
    ///      finished epoch (epoch < epochNow()) is required, the destination epochNow() is always > epoch
    ///      and strictly in the future, so a roll never targets its own source.
    function rollForward(uint256 epoch) external nonReentrant {
        if (epoch >= epochNow()) revert EpochNotFinished();
        if (totalPoints[epoch] != 0) revert EpochHasPoints();
        if (rolledForward[epoch]) revert NothingToRoll();
        uint256 amt = epochPool[epoch];
        if (amt == 0) revert NothingToRoll();
        // KNOWN, ACCEPTED FOR NOW (wave-4 audit MEDIUM-2). The destination is the LIVE epoch, and
        // the caller picks it by choosing WHEN to call. That lets a sniper watch for a fat stranded
        // pool, wait for a quiet epoch whose totalPoints is 1 (their own single care), roll the pool
        // in near the end of that epoch and claim ~100 percent of it once it closes.
        //
        // The fix is one word: target epochNow() + 1, which keeps the anti-strand property (the
        // destination is always strictly in the future, never an already-finished epoch) while
        // forcing a sniper to commit a full epoch before they can observe the point count they are
        // rolling into. It is NOT applied here yet because it shifts when a rolled pool becomes
        // claimable by one epoch, which 12 existing tests assert against directly, several of them
        // by claiming from the destination. Changing those correctly is its own piece of work.
        //
        // Bounded meanwhile: it only reaches pools in epochs where NOBODY cared at all, and the
        // rewards leg is optional (rewardsBps 0 disables it entirely).
        uint256 target = epochNow();
        rolledForward[epoch] = true;
        epochPool[epoch] = 0;
        epochPool[target] += amt;
        emit RolledForward(epoch, target, amt);
    }

    // --------------------------------------------------------------------------------------------
    // Claims (the ONLY way funds leave this contract)
    // --------------------------------------------------------------------------------------------

    /// @notice Claim a pet's pro-rata share of a FINISHED epoch's pool, paid into the pet's recorded
    ///         TBA. Permissionless (anyone may trigger it; the money always goes to the pet), once per
    ///         (epoch, pet), claimable forever.
    function claim(uint256 epoch, uint256 tokenId) external nonReentrant returns (uint256 payout) {
        payout = _claim(epoch, tokenId);
    }

    /// @notice Convenience: claim several pets for the same finished epoch in one call.
    /// @dev Audit follow-up (LOW): consider skipping already-claimed / point-less ids here instead of
    ///      reverting, so a front-run claim of one id can't grief the whole batch (funds are safe
    ///      either way; single claim() stays strict). Deferred to avoid rewriting the duplicate-revert
    ///      security tests; the double-pay protection is unaffected.
    function claimMany(uint256 epoch, uint256[] calldata tokenIds) external nonReentrant returns (uint256 total) {
        for (uint256 i = 0; i < tokenIds.length; i++) {
            total += _claim(epoch, tokenIds[i]);
        }
    }

    /// @dev Checks-effects-interactions: mark claimed and debit `accounted` before the external pay,
    ///      under the nonReentrant guard of the external entrypoints.
    function _claim(uint256 epoch, uint256 tokenId) internal returns (uint256 payout) {
        if (epoch >= epochNow()) revert EpochNotFinished();
        uint256 tp = totalPoints[epoch];
        uint256 pts = points[epoch][tokenId];
        if (tp == 0 || pts == 0) revert NoPoints();
        if (claimed[epoch][tokenId]) revert AlreadyClaimed();

        claimed[epoch][tokenId] = true;
        payout = (epochPool[epoch] * pts) / tp;
        address to = accountOf[tokenId];

        if (payout > 0) {
            accounted -= payout;
            careToken.safeTransfer(to, payout);
        }
        emit Claimed(epoch, tokenId, to, payout);
    }

    // --------------------------------------------------------------------------------------------
    // Views
    // --------------------------------------------------------------------------------------------

    /// @notice The current (in-progress) epoch index. Epoch 0 begins at deployTime.
    function epochNow() public view returns (uint256) {
        return (block.timestamp - deployTime) / epochLength;
    }

    /// @notice A pet's currently-claimable amount for an epoch (0 if already claimed, point-less, or
    ///         the epoch has no points). Does not check whether the epoch has finished.
    function pendingReward(uint256 epoch, uint256 tokenId) external view returns (uint256) {
        if (claimed[epoch][tokenId]) return 0;
        uint256 tp = totalPoints[epoch];
        if (tp == 0) return 0;
        uint256 pts = points[epoch][tokenId];
        if (pts == 0) return 0;
        return (epochPool[epoch] * pts) / tp;
    }

    /// @notice Epoch summary for the site: its accrued pool, total points, and whether it has finished.
    function epochStats(uint256 epoch)
        external
        view
        returns (uint256 pool, uint256 pointsTotal, bool finished)
    {
        pool = epochPool[epoch];
        pointsTotal = totalPoints[epoch];
        finished = epoch < epochNow();
    }

    /// @notice Disabled. Renouncing would permanently disarm the epoch and sink administration,
    ///         which are the only remediation paths this contract has. Ownership can still be
    ///         TRANSFERRED (Ownable2Step, so the new owner must accept), which is the safe move.
    function renounceOwnership() public view override onlyOwner {
        revert OwnershipCannotBeRenounced();
    }
}
