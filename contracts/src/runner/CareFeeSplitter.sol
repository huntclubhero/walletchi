// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {Ownable2Step} from "@openzeppelin/contracts/access/Ownable2Step.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";

import {ISwapAdapter} from "./ISwapAdapter.sol";
import {CareRewardsDistributor} from "./CareRewardsDistributor.sol";

/// @dev The one vault read the splitter needs: is the season settled (route everything to holders once
///      the game is over and no pet can earn player rewards anymore).
interface IPotState {
    function potClaimed() external view returns (bool);
}

/// @title CareFeeSplitter
/// @notice Destination of the launchpad creator-fee stream (letscash Standard Mode 3% tier, paid in
///         USDG). A permissionless distribute() poke (the server runs it 4x/day) splits what has
///         accumulated:
///           holderBps      -> HolderMerkleVault, in USDG (snapshot airdrops to holders who own a
///                             live pet; the live-pet gate is applied off-chain by the snapshot job)
///           the remainder  -> SWAPPED USDG -> CARE via the pluggable ISwapAdapter, then donated a
///                             full epoch ahead into the CareRewardsDistributor (players earn in CARE,
///                             the same token they spend, so rewards are price-stable and the swap
///                             creates continuous CARE buy pressure; econ audit headline fix)
///
///         Post-season: once the vault reports potClaimed, no pet can earn player rewards anymore, so
///         100% routes to holders (the swap leg is skipped) rather than stranding in the distributor.
///
///         TRUST SHAPE. The split ratio, both destinations, the fee token and the CARE token are all
///         immutable. distribute() is permissionless. The owner can rescue tokens of OTHER kinds sent
///         here by mistake, but NEVER the fee token or CARE, and has no path to player/holder money.
///         The swap adapter is owner-settable (a router can need replacing) but only ever handles the
///         player half in-flight; it never custodies rewards at rest, and once the live router has
///         been verified the owner can lockSwapAdapter() to give up even that power (same one-way
///         lock discipline used for the issuer/vault/royalty locks elsewhere in the system).
///
///         SWAP FLOOR (re-audit HIGH: owner-drain of the player half). The swap is guarded by a minOut
///         derived from the owner-set careOutPerFeeToken1e18 hint. That hint is the floor, so it is
///         security-critical, not cosmetic:
///           a) minOut must be strictly positive whenever there is money to swap. A zero floor makes
///              "delivered >= minOut" vacuously true, which previously let a hostile adapter take the
///              whole player half and deliver nothing. A poke that cannot form a positive floor PARKS
///              the player half instead of swapping it.
///           b) the hint can only move DOWN by MAX_RATE_DECREASE_BPS per update and no more often than
///              RATE_UPDATE_COOLDOWN, so no single owner transaction can collapse the floor. Moving it
///              UP or to 0 is unrestricted: neither can hand money to an adapter cheaply. Zeroing
///              the active rate does NOT erase the last non-zero floor, so a zero -> dust sequence
///              cannot bypass the decrease bound.
///           c) the hint goes STALE after rateMaxAge. A hint older than that is not a price, so the
///              poke parks rather than swapping against a floor nobody has refreshed.
///         See MAINNET GATE below: these bound the damage, they are not a price oracle.
///
///         DESTINATION SAFETY (contracts-audit HIGH-2): the player half is donated via
///         distributor.donateNext(), which books into epochNow()+1, so the poker can never drop the
///         stream into an epoch they already dominate. distribute() returns (0,0) on an empty balance
///         instead of reverting, so the cron never errors when beaten to the poke.
///
///         USDG-ONLY: Hunt launches the USDG pool, so the fee stream is a plain 6-decimal ERC-20.
///         There is deliberately no receive()/WETH-wrap path (its absence removes the native-vs-
///         wrapped ambiguity and the associated owner-drain finding from the prior design).
///
///         MAINNET GATE (re-audit: no on-chain price source). careOutPerFeeToken1e18 is a hand
///         maintained hint refreshed alongside the 4x/day cron, so BETWEEN refreshes the floor is
///         stale relative to the real pool and a poke is sandwichable down to that stale floor. The
///         in-contract guards above bound the loss (positive floor, bounded downward moves, hard max
///         age) but they cannot price a trade. Before mainnet the adapter MUST enforce its own floor
///         from a live source (a router quote taken in the same transaction, a TWAP, or a private
///         orderflow route), and the cron MUST refresh the hint from a live quote immediately before
///         each poke. Treat the splitter floor as a backstop, never as the primary slippage control.
///
///         UNAUDITED: re-audit before mainnet.
contract CareFeeSplitter is Ownable2Step, ReentrancyGuard {
    using SafeERC20 for IERC20;

    uint256 public constant BPS = 10_000;
    uint256 public constant MAX_SLIPPAGE_BPS = 2000; // 20% hard ceiling

    /// @notice Largest DOWNWARD move of careOutPerFeeToken1e18 allowed in a single update, in bps of
    ///         the previous value. Only downward moves weaken the swap floor (minOut scales linearly
    ///         with the rate), so only downward moves are rationed: this is what stops one owner
    ///         transaction from collapsing the floor to dust before pointing at a hostile adapter.
    uint256 public constant MAX_RATE_DECREASE_BPS = 2500; // 25% down per update, at most

    /// @notice Minimum spacing between rate updates that move the rate DOWN. Combined with
    ///         MAX_RATE_DECREASE_BPS it converts an instant floor collapse into a slow, publicly
    ///         observable walk (each step emits SwapParamsSet), which is the point of the guard.
    uint256 public constant RATE_UPDATE_COOLDOWN = 30 minutes;

    /// @notice Bounds on rateMaxAge, so the owner can tune freshness to the real cron cadence but can
    ///         never turn the staleness guard off (an unbounded max age would restore the "swap
    ///         against a floor nobody refreshed" hole).
    uint256 public constant MIN_RATE_MAX_AGE = 1 hours;
    uint256 public constant MAX_RATE_MAX_AGE = 2 days;

    /// @notice The fee-stream currency (USDG, 6 decimals). Also the holder-airdrop currency.
    IERC20 public immutable feeToken;

    /// @notice The care token (what the player half is swapped into; what the distributor pays).
    IERC20 public immutable careToken;

    /// @notice Where the holder half goes (HolderMerkleVault), in feeToken.
    address public immutable holderVault;

    /// @notice Where the player half goes after the swap (CareRewardsDistributor), in careToken.
    CareRewardsDistributor public immutable distributor;

    /// @notice The vault, read only for potClaimed (post-season routing).
    IPotState public immutable vault;

    /// @notice Holder share of every distribution, in bps (immutable).
    uint256 public immutable holderBps;

    /// @notice The USDG->CARE swap seam (mock on testnet, real router on mainnet). Owner-settable
    ///         until lockSwapAdapter() freezes it forever.
    ISwapAdapter public swapAdapter;

    /// @notice Once true the adapter can never be repointed again. The adapter is the one component
    ///         that ever touches the player half in flight, so freezing it after the live router has
    ///         been verified removes the owner from the swap path entirely.
    bool public swapAdapterLocked;

    /// @notice Player-half USDG that could not be swapped yet (swap unset, or a reverting/price-moved
    ///         swap) and is held here for the next poke. Tracked SEPARATELY so it is NEVER re-counted
    ///         into the holder split on a later distribute() (re-audit MEDIUM-1): only NEW fees since
    ///         the last poke are split holder/player.
    uint256 public parkedPlayerFee;

    /// @notice Max slippage tolerated on the swap, in bps. Owner-tunable up to MAX_SLIPPAGE_BPS.
    uint256 public swapSlippageBps;

    /// @notice Expected CARE-out per 1 feeToken, scaled 1e18 (raw units). Owner hint used to derive
    ///         minOut = feeIn * careOutPerFeeToken1e18 / 1e18 * (BPS - slippage) / BPS. 0 = skip the
    ///         swap leg entirely (park the player half until an adapter + rate are set), so a fresh
    ///         deploy never swaps at an unset/zero rate.
    uint256 public careOutPerFeeToken1e18;

    /// @notice Last non-zero rate accepted by setSwapParams. This is the protected baseline for
    ///         future decreases even while the active rate is zero. Keeping it separate closes the
    ///         zero -> tiny-rate reset that otherwise bypasses MAX_RATE_DECREASE_BPS.
    uint256 public lastNonzeroRate;

    /// @notice When the last non-zero rate was accepted. A rate older than rateMaxAge is treated as
    ///         no rate at all (the poke parks instead of swapping), because a stale hint is not a
    ///         price and would only serve as a floor the market has already moved away from. Writing
    ///         zero deliberately does not refresh this timestamp.
    uint256 public rateUpdatedAt;

    /// @notice How long a rate stays usable. Bounded by MIN/MAX_RATE_MAX_AGE. Default 12h, which is
    ///         two cron periods at the 4x/day cadence, so one missed cron does not park the stream.
    uint256 public rateMaxAge;

    event Distributed(uint256 holderShare, uint256 playerFeeIn, uint256 careOut, bool postSeason);
    event PlayerHalfParked(uint256 feeIn, string reason);
    event ParkedPlayerFeeClamped(uint256 recorded, uint256 available);
    event SwapAdapterSet(address indexed adapter);
    event SwapAdapterLocked(address indexed adapter);
    event SwapParamsSet(uint256 slippageBps, uint256 careOutPerFeeToken1e18);
    event RateMaxAgeSet(uint256 rateMaxAge);
    event StrayRescued(address indexed token, address indexed to, uint256 amount);

    error OwnershipCannotBeRenounced();
    error ZeroAddress();
    error BadBps();
    error TokenMismatch();
    error CannotRescueProtectedToken();
    error BadSlippage();
    error SwapAdapterIsLocked();
    error RateDecreaseTooLarge();
    error RateUpdateTooSoon();
    error BadRateMaxAge();
    error SwapInputNotConsumed(uint256 expected, uint256 consumed);

    /// @param owner_ owner (stray rescue + swap-adapter/param setter only; no reward-money path)
    /// @param feeToken_ the fee-stream + holder-airdrop currency (USDG)
    /// @param holderVault_ HolderMerkleVault receiving the holder half (must pay feeToken)
    /// @param distributor_ CareRewardsDistributor receiving the swapped player half (pays careToken)
    /// @param vault_ PetVault, read only for potClaimed
    /// @param holderBps_ holder share in bps, in (0, BPS)
    constructor(
        address owner_,
        IERC20 feeToken_,
        address holderVault_,
        CareRewardsDistributor distributor_,
        IPotState vault_,
        uint256 holderBps_
    ) Ownable(owner_) {
        if (
            address(feeToken_) == address(0) || holderVault_ == address(0) || address(distributor_) == address(0)
                || address(vault_) == address(0)
        ) revert ZeroAddress();
        if (holderBps_ == 0 || holderBps_ >= BPS) revert BadBps();
        careToken = distributor_.careToken();
        if (address(feeToken_) == address(careToken)) revert TokenMismatch(); // fee stream must differ from CARE
        feeToken = feeToken_;
        holderVault = holderVault_;
        distributor = distributor_;
        vault = vault_;
        holderBps = holderBps_;
        swapSlippageBps = 300; // 3% default; owner tunes to the real pool depth
        // 12h = two periods of the 4x/day poke cron, so a single missed refresh does not park the
        // player half, while a genuinely abandoned rate stops being usable as a floor within a day.
        rateMaxAge = 12 hours;
    }

    // --------------------------------------------------------------------------------------------
    // Admin (swap wiring; never touches reward money)
    // --------------------------------------------------------------------------------------------

    function setSwapAdapter(address adapter) external onlyOwner {
        // One-way lock (re-audit HIGH): repointing the adapter is the owner's only lever on money in
        // flight, so once the live router is verified the owner can give the lever up permanently.
        if (swapAdapterLocked) revert SwapAdapterIsLocked();
        if (adapter == address(0)) revert ZeroAddress();
        swapAdapter = ISwapAdapter(adapter);
        emit SwapAdapterSet(adapter);
    }

    /// @notice Freeze the current adapter forever. Deliberately one-way and deliberately NOT callable
    ///         with an unset adapter: locking address(0) would park the player half permanently.
    ///         After locking, a router that later needs replacing means the player half parks for the
    ///         rest of the season and then routes to holders post-season; that is the accepted cost
    ///         of removing the owner from the swap path.
    function lockSwapAdapter() external onlyOwner {
        if (address(swapAdapter) == address(0)) revert ZeroAddress();
        swapAdapterLocked = true;
        emit SwapAdapterLocked(address(swapAdapter));
    }

    /// @param slippageBps max slippage in bps (<= MAX_SLIPPAGE_BPS)
    /// @param careOutPerFeeToken1e18_ expected CARE-out per 1 feeToken, 1e18-scaled (0 parks the swap)
    /// @dev The rate IS the swap floor, so a downward move is rationed. Raising the rate, or zeroing
    ///      it, is always allowed and always instant: a higher rate only makes the swap harder to
    ///      satisfy (it parks instead), and 0 disables the swap leg outright. The last non-zero rate
    ///      remains the protected baseline while parked, so re-enabling at a lower rate is still a
    ///      decrease and is capped at MAX_RATE_DECREASE_BPS per RATE_UPDATE_COOLDOWN.
    function setSwapParams(uint256 slippageBps, uint256 careOutPerFeeToken1e18_) external onlyOwner {
        if (slippageBps > MAX_SLIPPAGE_BPS) revert BadSlippage();
        uint256 protectedRate = lastNonzeroRate;
        if (careOutPerFeeToken1e18_ != 0) {
            // protectedRate == 0 is the one true bootstrap case. Setting the active rate to zero
            // never clears this baseline, so zero -> dust cannot masquerade as another bootstrap.
            if (protectedRate != 0 && careOutPerFeeToken1e18_ < protectedRate) {
                if (block.timestamp < rateUpdatedAt + RATE_UPDATE_COOLDOWN) {
                    revert RateUpdateTooSoon();
                }
                uint256 lowestAllowed = Math.mulDiv(protectedRate, BPS - MAX_RATE_DECREASE_BPS, BPS);
                if (careOutPerFeeToken1e18_ < lowestAllowed) revert RateDecreaseTooLarge();
            }
            lastNonzeroRate = careOutPerFeeToken1e18_;
            rateUpdatedAt = block.timestamp;
        }
        swapSlippageBps = slippageBps;
        careOutPerFeeToken1e18 = careOutPerFeeToken1e18_;
        emit SwapParamsSet(slippageBps, careOutPerFeeToken1e18_);
    }

    /// @notice Tune how long a rate stays usable as a floor. Bounded on BOTH sides so the guard can
    ///         be matched to the real cron cadence but never disabled.
    function setRateMaxAge(uint256 rateMaxAge_) external onlyOwner {
        if (rateMaxAge_ < MIN_RATE_MAX_AGE || rateMaxAge_ > MAX_RATE_MAX_AGE) revert BadRateMaxAge();
        rateMaxAge = rateMaxAge_;
        emit RateMaxAgeSet(rateMaxAge_);
    }

    // --------------------------------------------------------------------------------------------
    // Distribution
    // --------------------------------------------------------------------------------------------

    /// @notice Permissionless: split the accumulated feeToken balance. Returns (0,0) on empty rather
    ///         than reverting (cron-friendly). Once the season is settled, 100% goes to holders.
    function distribute() external nonReentrant returns (uint256 holderShare, uint256 playerFeeIn) {
        uint256 bal = feeToken.balanceOf(address(this));
        if (bal == 0) return (0, 0);

        bool postSeason = vault.potClaimed();
        if (postSeason) {
            // No pet can earn player rewards anymore; the whole stream (incl. anything parked) goes
            // to holders.
            parkedPlayerFee = 0;
            feeToken.safeTransfer(holderVault, bal);
            emit Distributed(bal, 0, 0, true);
            return (bal, 0);
        }

        // Only NEW fees since the last poke are holder/player-split. Parked player money is excluded
        // so it can never be re-taxed for holders (MEDIUM-1).
        uint256 recordedParked = parkedPlayerFee;
        // External fee tokens can rebase down or exercise an administrative
        // clawback. A recorded parked amount above the real balance used to
        // underflow `bal - parked` and brick distribution indefinitely. Treat
        // only funds that still exist as parked; the loss cannot be recreated,
        // but it must not poison every future deposit.
        uint256 parked = Math.min(recordedParked, bal);
        if (parked != recordedParked) {
            parkedPlayerFee = parked;
            emit ParkedPlayerFeeClamped(recordedParked, parked);
        }
        uint256 newFees = bal - parked;
        holderShare = (newFees * holderBps) / BPS;
        uint256 playerNew = newFees - holderShare;
        if (holderShare > 0) feeToken.safeTransfer(holderVault, holderShare);

        uint256 playerTotal = playerNew + parked;
        playerFeeIn = playerTotal;
        uint256 careOut = 0;
        if (playerTotal > 0) {
            (uint256 minOut, string memory blockedReason) = _swapFloor(playerTotal);
            if (minOut == 0) {
                // NO SWAP WITHOUT A POSITIVE FLOOR (re-audit HIGH). minOut == 0 means this poke has no
                // enforceable price: no adapter, no rate, a stale rate, or a rate so small that the
                // 1e18 integer division rounds the floor away. Swapping anyway is exactly the hole
                // that let a hostile adapter take the whole player half and satisfy "0 >= 0", so the
                // money is parked for the next poke instead. Parked money is never lost: it is retried
                // every poke, is excluded from the holder split, and routes to holders post-season.
                parkedPlayerFee = playerTotal;
                playerFeeIn = 0;
                emit PlayerHalfParked(playerTotal, blockedReason);
            } else {
                uint256 feeBefore = feeToken.balanceOf(address(this));
                uint256 careBefore = careToken.balanceOf(address(distributor));
                feeToken.forceApprove(address(swapAdapter), playerTotal);
                try swapAdapter.swap(feeToken, careToken, playerTotal, minOut, address(distributor)) {
                    feeToken.forceApprove(address(swapAdapter), 0);
                    // Output alone is not enough. A hostile adapter can fund the
                    // minimum CARE from its own balance while leaving all USDG
                    // here. Clearing `parkedPlayerFee` in that state makes the
                    // same player money look like NEW fees on the next poke and
                    // repeatedly diverts the holder share. Require the exact
                    // approved input to have left this contract as well.
                    uint256 feeAfter = feeToken.balanceOf(address(this));
                    uint256 consumed = feeBefore > feeAfter ? feeBefore - feeAfter : 0;
                    if (consumed != playerTotal) revert SwapInputNotConsumed(playerTotal, consumed);
                    // Balance-delta guard (MEDIUM-2): whatever the adapter RETURNED, it must actually
                    // have delivered >= minOut CARE to the distributor, so a lying return value buys
                    // nothing. This makes the check independent of adapter honesty but NOT independent
                    // of the floor itself: minOut comes from the owner-set rate, which is why that
                    // rate is now floored above zero, rationed on the way down, and expired when
                    // stale. A hostile adapter that takes the USDG without delivering reverts the
                    // whole call here, and the USDG is safe because this revert is not caught below.
                    careOut = careToken.balanceOf(address(distributor)) - careBefore;
                    require(careOut >= minOut, "swap under-delivered");
                    parkedPlayerFee = 0;
                    // Book the freshly-arrived CARE a full epoch ahead (never the live epoch).
                    distributor.donateNext();
                } catch {
                    // Price moved / sandwiched / adapter reverted: the USDG transferFrom rolled back,
                    // so the player money is still here. Park it (the holder half already landed) and
                    // let the next poke retry (MEDIUM-3, keeps the cron + holder leg alive).
                    feeToken.forceApprove(address(swapAdapter), 0);
                    parkedPlayerFee = playerTotal;
                    playerFeeIn = 0;
                    emit PlayerHalfParked(playerTotal, "swap failed");
                }
            }
        }
        emit Distributed(holderShare, playerFeeIn, careOut, false);
    }

    /// @notice The floor this contract would enforce on a swap of `amountIn` fee tokens right now, and
    ///         why it is zero when it is. minOut == 0 always means "do not swap, park instead", never
    ///         "swap with no floor". Exposed so the poke cron can see WHY a poke parked without
    ///         replaying logs.
    /// @return minOut the enforced minimum CARE out, 0 when no swap may happen
    /// @return blockedReason empty when minOut > 0, otherwise the reason the swap leg is blocked
    function swapFloor(uint256 amountIn) external view returns (uint256 minOut, string memory blockedReason) {
        return _swapFloor(amountIn);
    }

    /// @notice Whether the rate hint is currently young enough to be used as a floor.
    function rateIsFresh() public view returns (bool) {
        return careOutPerFeeToken1e18 > 0 && block.timestamp <= rateUpdatedAt + rateMaxAge;
    }

    function _swapFloor(uint256 amountIn) internal view returns (uint256 minOut, string memory blockedReason) {
        if (address(swapAdapter) == address(0) || careOutPerFeeToken1e18 == 0) return (0, "swap unset");
        // Staleness (re-audit: no on-chain oracle). The hint is refreshed by the same cron that pokes
        // distribute(); if that cron has been down long enough for the hint to expire, the last known
        // price is not a floor anymore and the poke must park rather than trade against it.
        if (block.timestamp > rateUpdatedAt + rateMaxAge) return (0, "rate stale");
        uint256 expected = Math.mulDiv(amountIn, careOutPerFeeToken1e18, 1e18);
        minOut = Math.mulDiv(expected, BPS - swapSlippageBps, BPS);
        // A floor that rounded to zero is not a floor. Report it as blocked so the caller parks.
        if (minOut == 0) return (0, "no price floor");
    }

    // --------------------------------------------------------------------------------------------
    // Stray rescue (never the fee token, never CARE)
    // --------------------------------------------------------------------------------------------

    /// @notice Owner rescue for tokens of the WRONG kind sent here by mistake. The fee stream and CARE
    ///         are both out of reach, so the owner can never intercept holder or player money.
    function rescueToken(IERC20 token, address to) external onlyOwner {
        if (address(token) == address(feeToken) || address(token) == address(careToken)) {
            revert CannotRescueProtectedToken();
        }
        if (to == address(0)) revert ZeroAddress();
        uint256 bal = token.balanceOf(address(this));
        token.safeTransfer(to, bal);
        emit StrayRescued(address(token), to, bal);
    }

    function renounceOwnership() public view override onlyOwner {
        revert OwnershipCannotBeRenounced();
    }
}
