// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {Ownable2Step} from "@openzeppelin/contracts/access/Ownable2Step.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";

import {IRewardsSink} from "./IRewardsSink.sol";
import {IPassSignal} from "./IPassSignal.sol";

/// @dev The minimal PetVault surface the distributor reads for liveness + settlement. All views.
interface IPetLiveness {
    function isDead(uint256 tokenId) external view returns (bool);
    function potClaimed() external view returns (bool);
    function leader() external view returns (uint256);
    function pet() external view returns (address);
}

/// @dev Pet721 payout resolver. The current owner can select an alternate destination, and Pet721
///      clears it on transfer so a seller's choice never survives into the buyer's ownership.
interface IPetPayoutResolver {
    function payoutAddress(uint256 tokenId, address defaultRecipient) external view returns (address);
}

/// @title CareRewardsDistributor
/// @notice WALLETCHI player-rewards sink, CLAIM-WHILE-ALIVE edition (Hunt, 2026-08-17). Successor to
///         the audited RewardsDistributor and its short-lived weighted fork. It keeps that contract's
///         proven machinery verbatim (fixed EPOCHS, balance-delta accrual, pro-rata claims paid into
///         each pet's own ERC-6551 account, funds leave ONLY via claim(), no owner sweep) and layers
///         four deliberate changes on top:
///
///           1. FLAT POINTS. Every care is worth exactly one point (Hunt flattened the evolution
///              multiplier: pets still visibly evolve as status, but leveling no longer buys reward
///              share, which the econ audit showed cancels out in steady state and taxes newcomers).
///
///           2. PUSH-WHILE-ALIVE (season-2 no-claims law; was claim-while-alive). NOBODY CLAIMS.
///              A living pet's finished epochs reach its TBA two ways, both pushes: notifyCare
///              AUTO-PUSHES on every care, and the permissionless pushRewards() (the 2h bot's
///              trigger, callable by anyone, amounts and destinations contract-enforced) covers
///              pets that are not currently caring. Only genuinely abandoned pets ever forfeit.
///
///           3. FORFEIT-TO-SURVIVORS. A dead pet's unclaimed finished-epoch share does not strand and
///              is not burned: permissionless sweepForfeited() moves it into a FUTURE epoch's pool
///              (epochNow() + 1), where only pets that care in that epoch collect it. This is the
///              survivorship curve: aggregate rewards never exceed 20% of spend, but a survivor's take
///              can far exceed their own spend as the fallen forfeit into the pool.
///
///           4. NEVER THE LIVE EPOCH FOR EXTERNAL MONEY. The care slice still books into the CURRENT
///              epoch alongside the point that earned it (money rides the care, the audited property).
///              But money that arrives WITHOUT a care (the CareFeeSplitter's swapped player half,
///              donations, forfeited rolls) always lands a full epoch in the FUTURE via donateNext() /
///              epochNow()+1, so no one can watch a quiet epoch and drop money into one they already
///              dominate (contracts-audit HIGH-1/HIGH-2).
///
///         Plus a bounded post-season escape (sweepResidualToWinner): once the vault has paid the pot,
///         care() reverts forever and no epoch can ever earn a point again, so any residual here would
///         otherwise be locked. It is permissionlessly swept to the winner's resolved payout address
///         (TBA by default, current-owner override when its TBA is unreachable; econ audit #11.3).
///
///         The vault is BOTH the sole notifyCare caller (it is the vault's rewardsRecipient) AND the
///         liveness/settlement oracle; it is set once by the owner and then frozen.
///
///         UNAUDITED: re-audit before mainnet.
contract CareRewardsDistributor is Ownable2Step, ReentrancyGuard, IRewardsSink {
    using SafeERC20 for IERC20;

    /// @notice The care token being distributed.
    IERC20 public immutable careToken;

    /// @notice Epoch length in seconds (e.g. 6h for 4 payouts a day). Fixed at deploy.
    uint256 public immutable epochLength;

    /// @notice Deploy timestamp; epoch 0 starts here. Fixed at deploy.
    uint256 public immutable deployTime;

    /// @notice The PetVault: sole notifyCare caller AND the liveness/settlement oracle. Set once,
    ///         then permanently frozen (never repointable).
    IPetLiveness public vault;

    /// @notice Pet721 associated with the immutable vault wiring; resolves owner-authorized payout
    ///         overrides. Address(0) is allowed only for isolated legacy test oracles and falls back
    ///         to the recorded TBA.
    IPetPayoutResolver public payoutResolver;

    /// @notice Payouts below this roll into a future epoch instead of transferring (see constructor).
    uint256 public immutable dustThreshold;

    /// @notice Finished epochs the care hook's auto-push looks back over (see constructor).
    uint256 public immutable autoClaimLookback;

    /// @notice Funds recognized into epoch pools and not yet claimed/swept out. Invariant:
    ///         balanceOf(this) >= accounted always holds under the honest internal flow.
    uint256 public accounted;

    /// @notice Reward pool accrued to an epoch (raw units).
    mapping(uint256 => uint256) public epochPool;

    /// @notice Total participation points recorded in an epoch (one per care).
    mapping(uint256 => uint256) public totalPoints;

    /// @notice Participation points for a pet within an epoch (one per care).
    mapping(uint256 => mapping(uint256 => uint256)) public points;

    /// @notice Whether a pet has already claimed (or forfeited) a given epoch.
    mapping(uint256 => mapping(uint256 => bool)) public claimed;

    /// @notice The recorded TBA account for a pet (where its claims are paid). Set on notifyCare.
    mapping(uint256 => address) public accountOf;

    /// @notice Whether a finished zero-point epoch's pool has already been rolled forward.
    mapping(uint256 => bool) public rolledForward;

    /// @notice Set once the post-season residual has been swept to the winner (idempotent guard).
    bool public residualSwept;

    event VaultSet(address indexed vault);
    event CareRecorded(uint256 indexed epoch, uint256 indexed tokenId, address account, uint256 recognized);
    event AutoClaimed(uint256 indexed epoch, uint256 indexed tokenId, uint256 amount);
    /// @dev Emitted when an auto-claim transfer did NOT go through, so a silently-off claim-while-alive
    ///      guarantee is observable instead of invisible. The epoch stays unclaimed and remains
    ///      claimable by an explicit claim() while the pet is alive.
    event AutoClaimFailed(uint256 indexed epoch, uint256 indexed tokenId, uint256 amount);
    event DonatedNext(uint256 indexed epoch, uint256 recognized);
    event RolledForward(uint256 indexed fromEpoch, uint256 indexed toEpoch, uint256 amount);
    event RewardsPushed(uint256 indexed epoch, uint256 indexed tokenId, address indexed account, uint256 amount);
    /// @dev A push transfer failed (token paused, blacklisting, hostile). The epoch stays unpushed
    ///      and the next cycle retries; loud so an off pipeline is visible in logs, never silent.
    event RewardsPushFailed(uint256 indexed epoch, uint256 indexed tokenId, uint256 amount);
    /// @dev A payout below dustThreshold rolled forward instead of transferring (value conserved).
    event DustRolled(uint256 indexed epoch, uint256 indexed tokenId, uint256 toEpoch, uint256 amount);
    event Forfeited(uint256 indexed epoch, uint256 indexed tokenId, uint256 toEpoch, uint256 amount);
    event ResidualSwept(uint256 indexed winner, address indexed account, uint256 amount);

    error OwnershipCannotBeRenounced();
    error ZeroAddress();
    error VaultAlreadySet();
    error VaultNotContract();
    error PayoutResolverNotContract();
    error NotVault();
    error EpochNotFinished();
    error EpochHasPoints();
    error NothingToRoll();
    error NoPoints();
    error PetIsAlive();
    error SeasonNotOver();
    error SeasonSettled();
    error AlreadySwept();
    error BadLookback();

    /// @dev CARE TOKEN ASSUMPTIONS. Mainnet CARE is a third-party letscash.fun launch, so this
    ///      contract assumes as little as possible about it: transfers tolerate a missing return value
    ///      (USDT style), a reverting transfer can never brick care(), and a balance that moves out of
    ///      band is handled with saturating arithmetic. What is NOT tolerated and must be checked at
    ///      DEPLOY time (deploy-script handoff, not enforceable here): a fee-on-transfer or rebasing
    ///      CARE would make the balance-delta accrual under-recognize, and a token with no code at the
    ///      configured address would make every transfer silently "succeed" under the empty-returndata
    ///      rule. The deploy script must assert code.length > 0 and a round-trip transfer of 1 unit.
    /// @param dustThreshold_ payouts below this are not transferred but ROLLED into a future epoch's
    ///        pool (value conserved, spam transfers avoided; season-2 push model). 0 disables.
    /// @param autoClaimLookback_ how many finished epochs notifyCare's auto-push looks back. Was a
    ///        baked constant 8; with 2h epochs that covered 16h of a 24h life window, violating the
    ///        deploy invariant autoClaimLookback * epochLength >= lifeTtl. Bounded 1..64 (a gas-bound
    ///        loop inside the REQUIRED care hook).
    constructor(
        address owner_,
        IERC20 careToken_,
        uint256 epochLength_,
        uint256 dustThreshold_,
        uint256 autoClaimLookback_
    ) Ownable(owner_) {
        if (address(careToken_) == address(0)) revert ZeroAddress();
        if (epochLength_ == 0) revert ZeroAddress();
        if (autoClaimLookback_ == 0 || autoClaimLookback_ > 64) revert BadLookback();
        careToken = careToken_;
        epochLength = epochLength_;
        dustThreshold = dustThreshold_;
        autoClaimLookback = autoClaimLookback_;
        deployTime = block.timestamp;
    }

    // --------------------------------------------------------------------------------------------
    // Admin (set the vault once, then frozen)
    // --------------------------------------------------------------------------------------------

    /// @notice Wire the PetVault (sole notifyCare caller + liveness oracle). Callable once; frozen.
    function setVault(address vault_) external onlyOwner {
        if (address(vault) != address(0)) revert VaultAlreadySet();
        if (vault_ == address(0)) revert ZeroAddress();
        if (vault_.code.length == 0) revert VaultNotContract();
        vault = IPetLiveness(vault_);
        address resolver = vault.pet();
        if (resolver.code.length == 0) revert PayoutResolverNotContract();
        payoutResolver = IPetPayoutResolver(resolver);
        emit VaultSet(vault_);
    }

    // --------------------------------------------------------------------------------------------
    // Accrual
    // --------------------------------------------------------------------------------------------

    /// @dev Recognize funds received since the last recognition into `epoch`'s pool. Saturating
    ///      subtraction (an out-of-band balance reduction recognizes 0, never underflows), so the
    ///      REQUIRED notifyCare hook can never brick care() for everyone.
    function _recognize(uint256 epoch) internal returns (uint256 recognized) {
        uint256 bal = careToken.balanceOf(address(this));
        recognized = bal > accounted ? bal - accounted : 0;
        if (recognized > 0) {
            accounted = bal;
            epochPool[epoch] += recognized;
        }
    }

    /// @notice Vault-only care hook. Book the care slice (just transferred here) into the CURRENT
    ///         epoch, record one point + the pet's TBA, and AUTO-CLAIM the pet's finished unclaimed
    ///         epochs into its TBA so a caring pet can never forfeit. Money-rides-the-care holds: the
    ///         funds and the point that earned them land in the same epoch.
    function notifyCare(uint256 tokenId, address account, uint256 amount) external nonReentrant {
        if (msg.sender != address(vault)) revert NotVault();
        uint256 e = epochNow();
        // Book only the DECLARED care slice into the LIVE epoch (money rides the care). Any EXCESS
        // over `amount` is a stray donation that arrived without a care, and booking it live would let
        // a care front-run a 2-tx donation into an epoch it dominates (re-audit finding 2); route that
        // excess a full epoch ahead instead. `amount` is what the vault sent; under a fee-on-transfer
        // care token the actual delta is <= amount, so `min` also keeps this exact.
        uint256 bal = careToken.balanceOf(address(this));
        uint256 recognized = bal > accounted ? bal - accounted : 0;
        if (recognized > 0) {
            accounted = bal;
            uint256 live = recognized > amount ? amount : recognized;
            epochPool[e] += live;
            uint256 excess = recognized - live;
            if (excess > 0) epochPool[epochNow() + 1] += excess;
        }
        points[e][tokenId] += 1;
        totalPoints[e] += 1;
        accountOf[tokenId] = account;
        emit CareRecorded(e, tokenId, account, recognized);
        // Claim-while-alive guarantee: sweep this (alive, since it is caring) pet's finished epochs
        // into its TBA now, so it can never be forfeited out from under an active keeper.
        _autoClaimFinished(tokenId, account, e);
    }

    /// @dev The auto-push on care looks back `autoClaimLookback` finished epochs (a constructor
    ///      parameter since season 2; the deploy script asserts autoClaimLookback * epochLength >=
    ///      lifeTtl so a pet caring at the edge of each life window always auto-collects everything;
    ///      re-audit LOW-3). Anything older is still pushable by pushRewards() while the pet remains
    ///      alive, or forfeits if it dies.
    function _autoClaimFinished(uint256 tokenId, address account, uint256 currentEpoch) internal {
        address recipient = _payoutAddress(tokenId, account);
        uint256 from = currentEpoch > autoClaimLookback ? currentEpoch - autoClaimLookback : 0;
        for (uint256 e = from; e < currentEpoch; e++) {
            if (claimed[e][tokenId]) continue;
            uint256 pts = points[e][tokenId];
            if (pts == 0) continue;
            uint256 tp = totalPoints[e];
            uint256 payout = (epochPool[e] * pts) / tp;
            if (payout == 0) {
                claimed[e][tokenId] = true;
                emit AutoClaimed(e, tokenId, 0);
                continue;
            }
            // NON-BRICKING (re-audit LOW-2): this runs inside the REQUIRED care hook, so a pausable /
            // blacklisting mainnet care token must never revert care() here. Pay on success (mark
            // claimed + debit); on any failure, LEAVE the epoch unpushed (the next pushRewards()
            // cycle retries it while the pet is alive) and move on, mirroring the try/pay pattern.
            //
            // NON-STANDARD ERC-20 (re-audit HIGH): this used to be `try careToken.transfer(...)
            // returns (bool ok)`, which ABI-decodes the return value. A USDT-style token that returns
            // NO data fails that decode and lands in catch on EVERY care, so claim-while-alive was
            // silently off with zero signal. Mainnet CARE is a third-party letscash launch we do not
            // control, so the transfer must tolerate a missing return value. trySafeTransfer treats
            // empty returndata from a contract as success (the OZ SafeERC20 rule), requires an
            // explicit true when data IS returned, and returns false instead of reverting on any
            // failure, so care() still cannot be bricked by a hostile or paused token.
            bool ok = careToken.trySafeTransfer(recipient, payout);
            if (ok) {
                claimed[e][tokenId] = true;
                accounted -= payout;
                emit AutoClaimed(e, tokenId, payout);
            } else {
                // LOUD ON FAILURE: token paused, blacklisting, or hostile. Never revert care(), but
                // never fail silently either, so an off guarantee is visible in the logs.
                emit AutoClaimFailed(e, tokenId, payout);
            }
        }
    }

    /// @notice Permissionless: recognize any un-booked funds (the splitter's swapped player half, or
    ///         a direct donation) into a FUTURE epoch (epochNow() + 1), never the live one, so the
    ///         caller can never drop money into an epoch they already dominate.
    function donateNext() external nonReentrant {
        uint256 e = epochNow() + 1;
        uint256 recognized = _recognize(e);
        emit DonatedNext(e, recognized);
    }

    /// @notice Carry a FINISHED, ZERO-POINT epoch's pool into a FUTURE epoch (epochNow() + 1) so it
    ///         is never trapped. Permissionless, idempotent. Destination is a full epoch ahead
    ///         (contracts-audit HIGH-1 fix), never the live epoch.
    function rollForward(uint256 epoch) external nonReentrant {
        if (epoch >= epochNow()) revert EpochNotFinished();
        if (totalPoints[epoch] != 0) revert EpochHasPoints();
        if (rolledForward[epoch]) revert NothingToRoll();
        uint256 amt = epochPool[epoch];
        if (amt == 0) revert NothingToRoll();
        uint256 target = epochNow() + 1;
        rolledForward[epoch] = true;
        epochPool[epoch] = 0;
        epochPool[target] += amt;
        emit RolledForward(epoch, target, amt);
    }

    // --------------------------------------------------------------------------------------------
    // Push (the ONLY way funds leave to a pet; NOBODY claims. Season-2 no-claims law.)
    // --------------------------------------------------------------------------------------------

    /// @notice PERMISSIONLESS: push each LIVING pet's pro-rata share of a FINISHED epoch into its
    ///         resolved payout address (recorded TBA by default, current-owner override if set).
    ///         Amounts and destination are contract-enforced, so a caller can only choose WHO gets
    ///         paid EARLIER, never how much or where. The 2h server bot is a convenience, not an
    ///         authority; anyone can run the same pushes.
    ///
    ///         PER-PET NON-BLOCKING: a hostile TBA or a pausing token must never let one pet block a
    ///         batch, so ineligible pets are SKIPPED (dead ones are sweepForfeited's job, already-
    ///         pushed ones are done, pointless ones have nothing) and a failed transfer leaves that
    ///         epoch unpushed for the next cycle, loudly (RewardsPushFailed).
    ///
    ///         DUST (season-2): a payout below `dustThreshold` is not transferred; it rolls into a
    ///         FUTURE epoch's pool (epochNow() + 1, the same forward-only destination every other
    ///         roll here uses) so 2h cadence cannot spray near-zero transfers. Value conserved.
    function pushRewards(uint256 epoch, uint256[] calldata tokenIds) external nonReentrant returns (uint256 total) {
        // After the post-season residual sweep, the whole balance is with the winner, so any
        // remaining epoch pool is unbacked; a late push would underflow `accounted`.
        if (residualSwept) revert SeasonSettled();
        if (epoch >= epochNow()) revert EpochNotFinished();
        uint256 tp = totalPoints[epoch];
        if (tp == 0) revert NoPoints();
        // The id range that actually received CARE, for ONE BatchPassUpdate after the loop.
        uint256 paidMin = type(uint256).max;
        uint256 paidMax = 0;
        for (uint256 i = 0; i < tokenIds.length; i++) {
            uint256 tokenId = tokenIds[i];
            if (claimed[epoch][tokenId]) continue;
            uint256 pts = points[epoch][tokenId];
            if (pts == 0) continue;
            if (vault.isDead(tokenId)) continue; // forfeits via sweepForfeited, never pushed
            uint256 payout = (epochPool[epoch] * pts) / tp;
            if (payout == 0) {
                claimed[epoch][tokenId] = true;
                emit RewardsPushed(epoch, tokenId, _payoutAddress(tokenId, accountOf[tokenId]), 0);
                continue;
            }
            if (payout < dustThreshold) {
                // Roll, do not transfer. Same conservation shape as sweepForfeited: epochPool is a
                // DENOMINATOR BASIS (never debited by payouts), `claimed` stops this slice from ever
                // paying out of `epoch`, and the credited future pool is backed by the untouched
                // `accounted` funds still sitting here.
                claimed[epoch][tokenId] = true;
                uint256 target = epochNow() + 1;
                epochPool[target] += payout;
                emit DustRolled(epoch, tokenId, target, payout);
                continue;
            }
            address to = _payoutAddress(tokenId, accountOf[tokenId]);
            // Same non-blocking transfer discipline as the care hook's auto-push (see that comment
            // for the USDT-style returndata rules): pay on success, leave unpushed on failure.
            bool ok = careToken.trySafeTransfer(to, payout);
            if (ok) {
                claimed[epoch][tokenId] = true;
                accounted -= payout;
                total += payout;
                emit RewardsPushed(epoch, tokenId, to, payout);
                if (tokenId < paidMin) paidMin = tokenId;
                if (tokenId > paidMax) paidMax = tokenId;
            } else {
                emit RewardsPushFailed(epoch, tokenId, payout);
            }
        }
        // A pet's pass shows its CARE balance, which this push just raised. One inclusive range
        // covers the batch: ids inside it that were not paid get a redundant refresh, which the
        // ERC permits and costs a distributor nothing, where one event per pet would cost ~1k gas
        // each on a 200-pet batch.
        if (paidMax != 0) _signalPasses(paidMin, paidMax);
    }

    /// @notice Permissionless: forfeit a DEAD pet's unclaimed finished-epoch share to survivors by
    ///         moving it into a FUTURE epoch's pool (epochNow() + 1). Idempotent per (epoch, pet);
    ///         preserves `accounted` (funds never leave the contract here, they change epoch).
    function sweepForfeited(uint256 epoch, uint256[] calldata tokenIds) external nonReentrant {
        if (epoch >= epochNow()) revert EpochNotFinished();
        uint256 target = epochNow() + 1;
        uint256 tp = totalPoints[epoch];
        if (tp == 0) revert NoPoints();
        uint256 moved = 0;
        for (uint256 i = 0; i < tokenIds.length; i++) {
            uint256 tokenId = tokenIds[i];
            if (claimed[epoch][tokenId]) continue;
            uint256 pts = points[epoch][tokenId];
            if (pts == 0) continue;
            if (!vault.isDead(tokenId)) revert PetIsAlive();
            claimed[epoch][tokenId] = true;
            uint256 share = (epochPool[epoch] * pts) / tp;
            if (share > 0) {
                // Credit the forfeited share to the future epoch. Do NOT debit epochPool[epoch]:
                // pro-rata uses a CONSTANT denominator (totalPoints), so every surviving pet's claim
                // is computed against the full pool; shrinking it here would underpay the survivors
                // (re-audit HIGH-1). epochPool is a DENOMINATOR BASIS, not a running balance (claim()
                // never decrements it either), so leaving it is correct: `claimed[epoch][tokenId]`
                // stops this dead pet's slice from ever being paid out here, and it is instead paid
                // via the `share` credited to `target`. Conservation: survivor claims (P*alive/T) plus
                // forfeits (P*dead/T) sum to exactly P, timing-independent.
                epochPool[target] += share;
                moved += share;
            }
            emit Forfeited(epoch, tokenId, target, share);
        }
        // Reaching here with moved == 0 means nothing had a positive share;
        // that is intentionally idempotent. Keep the accumulator explicit so
        // static analyzers do not confuse its zero case with an uninitialized
        // accounting value.
        if (moved == 0) return;
    }

    /// @notice Permissionless post-season escape: once the vault has settled (potClaimed), no epoch
    ///         can ever earn another point, so the entire remaining balance is swept to the winning
    ///         pet's resolved payout address rather than locked forever. Idempotent.
    function sweepResidualToWinner() external nonReentrant {
        if (!vault.potClaimed()) revert SeasonNotOver();
        if (residualSwept) revert AlreadySwept();
        residualSwept = true;
        uint256 winner = vault.leader();
        address recorded = accountOf[winner];
        if (recorded == address(0)) revert ZeroAddress(); // winner must have cared at least once
        address to = _payoutAddress(winner, recorded);
        uint256 amt = careToken.balanceOf(address(this));
        if (amt > 0) {
            accounted = accounted > amt ? accounted - amt : 0;
            careToken.safeTransfer(to, amt);
        }
        emit ResidualSwept(winner, to, amt);
        if (amt > 0) _signalPasses(winner, winner);
    }

    /// @dev Ask the token contract (the payout resolver, which is Pet721) to emit the Wallet Pass
    ///      Extension's freshness event. NON-BLOCKING: a push must never fail because a signal did,
    ///      and a deploy without a resolver, or one where the distributor was never registered as a
    ///      pass signaler, simply emits nothing.
    function _signalPasses(uint256 fromTokenId, uint256 toTokenId) internal {
        address resolver = address(payoutResolver);
        if (resolver == address(0) || resolver.code.length == 0) return;
        if (fromTokenId == toTokenId) {
            try IPassSignal(resolver).signalPassUpdate(fromTokenId) {} catch {}
        } else {
            try IPassSignal(resolver).signalBatchPassUpdate(fromTokenId, toTokenId) {} catch {}
        }
    }

    function _payoutAddress(uint256 tokenId, address defaultRecipient) internal view returns (address) {
        IPetPayoutResolver resolver = payoutResolver;
        if (address(resolver) == address(0)) return defaultRecipient;
        return resolver.payoutAddress(tokenId, defaultRecipient);
    }

    // --------------------------------------------------------------------------------------------
    // Views
    // --------------------------------------------------------------------------------------------

    function epochNow() public view returns (uint256) {
        return (block.timestamp - deployTime) / epochLength;
    }

    /// @notice A pet's currently-claimable amount for an epoch (0 if claimed, point-less, no points,
    ///         or the pet is dead). Does not check whether the epoch has finished.
    function pendingReward(uint256 epoch, uint256 tokenId) external view returns (uint256) {
        if (claimed[epoch][tokenId]) return 0;
        if (address(vault) != address(0) && vault.isDead(tokenId)) return 0;
        uint256 tp = totalPoints[epoch];
        if (tp == 0) return 0;
        uint256 pts = points[epoch][tokenId];
        if (pts == 0) return 0;
        return (epochPool[epoch] * pts) / tp;
    }

    function epochStats(uint256 epoch) external view returns (uint256 pool, uint256 pointsTotal, bool finished) {
        pool = epochPool[epoch];
        pointsTotal = totalPoints[epoch];
        finished = epoch < epochNow();
    }

    function renounceOwnership() public view override onlyOwner {
        revert OwnershipCannotBeRenounced();
    }
}
