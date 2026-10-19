// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

// REWARD ECONOMY HARDENING (2026-08-22). Regression suite for the adversarial re-audit of the two
// reward streams: the CareFeeSplitter swap floor, the HolderMerkleVault trust model, the
// CareRewardsDistributor auto-claim transfer path, and the conservation properties the audit said
// hold (re-verified here rather than trusted). UNAUDITED: re-audit before mainnet.
//
// Every test in this file corresponds to a PROVEN finding or a conservation property. Nothing here
// replaces TaxEconomy.t.sol; this file only adds the regressions.

import {Test} from "forge-std/Test.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";

import {MockCareToken} from "../../src/runner/MockCareToken.sol";
import {MockUSDG} from "../../src/runner/MockUSDG.sol";
import {MockSwapAdapter} from "../../src/runner/MockSwapAdapter.sol";
import {CareRewardsDistributor, IPetLiveness} from "../../src/runner/CareRewardsDistributor.sol";
import {CareFeeSplitter, IPotState} from "../../src/runner/CareFeeSplitter.sol";
import {HolderMerkleVault} from "../../src/runner/HolderMerkleVault.sol";

/// @dev Season 2 replaced claim(epoch, tokenId) with the permissionless batch pushRewards(epoch,
///      tokenIds), so every one-pet case below wraps its id in a single-element list.
function _one(uint256 tokenId) pure returns (uint256[] memory ids) {
    ids = new uint256[](1);
    ids[0] = tokenId;
}

// ================================================================================================
// Test doubles (kept local to this file so it never depends on another suite's fixtures)
// ================================================================================================

/// @dev Settable liveness + settlement oracle standing in for PetVault.
contract Oracle is IPetLiveness, IPotState {
    mapping(uint256 => bool) public deadOf;
    bool public potClaimedFlag;
    uint256 public leaderId;
    address public pet;

    constructor() {
        pet = address(this);
    }

    function payoutAddress(uint256, address defaultRecipient) external pure returns (address) {
        return defaultRecipient;
    }

    function setDead(uint256 tokenId, bool d) external {
        deadOf[tokenId] = d;
    }

    function setPotClaimed(bool v) external {
        potClaimedFlag = v;
    }

    function setLeader(uint256 id) external {
        leaderId = id;
    }

    function isDead(uint256 tokenId) external view returns (bool) {
        return deadOf[tokenId];
    }

    function potClaimed() external view override(IPetLiveness, IPotState) returns (bool) {
        return potClaimedFlag;
    }

    function leader() external view returns (uint256) {
        return leaderId;
    }
}

/// @dev THE PROVEN ATTACK ADAPTER. Takes the entire input and delivers NOTHING, then lies about the
///      output. Under the old zero floor, "0 >= 0" passed and the player half was gone.
contract ZeroDeliveryAdapter {
    function swap(IERC20 tokenIn, IERC20, uint256 amountIn, uint256, address) external returns (uint256) {
        tokenIn.transferFrom(msg.sender, address(this), amountIn);
        return type(uint256).max; // claim a huge output regardless
    }
}

/// @dev A USDT-style ERC-20: transfer/transferFrom/approve return NO data at all. ABI-decoding a bool
///      from this reverts, which is what silently disabled the auto-claim path.
contract NoReturnDataToken {
    string public name = "No Return Care";
    string public symbol = "NRCARE";
    uint8 public decimals = 18;
    uint256 public totalSupply;
    mapping(address => uint256) public balanceOf;
    mapping(address => mapping(address => uint256)) public allowance;

    function mint(address to, uint256 amount) external {
        balanceOf[to] += amount;
        totalSupply += amount;
    }

    function transfer(address to, uint256 amount) external {
        require(balanceOf[msg.sender] >= amount, "balance");
        balanceOf[msg.sender] -= amount;
        balanceOf[to] += amount;
    }

    function approve(address spender, uint256 amount) external {
        allowance[msg.sender][spender] = amount;
    }

    function transferFrom(address from, address to, uint256 amount) external {
        require(balanceOf[from] >= amount, "balance");
        require(allowance[from][msg.sender] >= amount, "allowance");
        allowance[from][msg.sender] -= amount;
        balanceOf[from] -= amount;
        balanceOf[to] += amount;
    }
}

/// @dev A care token that can be paused, i.e. transfer reverts. Used to prove care() is never bricked
///      and that a failed auto-claim is LOUD and leaves the epoch claimable.
contract PausableCareToken is ERC20 {
    bool public paused;

    constructor() ERC20("Pausable Care", "PCARE") {}

    function setPaused(bool p) external {
        paused = p;
    }

    function mint(address to, uint256 amount) external {
        _mint(to, amount);
    }

    function transfer(address to, uint256 amount) public override returns (bool) {
        require(!paused, "paused");
        return super.transfer(to, amount);
    }
}

abstract contract HardeningBase is Test {
    address internal owner = makeAddr("owner");
    address internal poster = makeAddr("poster");
    address internal stranger = makeAddr("stranger");
    address internal holder1 = makeAddr("holder1");
    address internal holder2 = makeAddr("holder2");

    uint256 internal constant BPS = 10_000;
    uint256 internal constant EPOCH = 6 hours;
    /// @dev The raw-unit rate for USDG(6dp) -> CARE(18dp) at 1 USDG = 1 CARE: 1e18 / 1e6 = 1e12,
    ///      scaled by 1e18 for the hint = 1e30.
    uint256 internal constant RATE_1_TO_1 = 1e30;

    function _leaf(uint256 roundId, address account, uint256 amount) internal pure returns (bytes32) {
        return keccak256(bytes.concat(keccak256(abi.encode(roundId, account, amount))));
    }

    function _hashPair(bytes32 a, bytes32 b) internal pure returns (bytes32) {
        return a < b ? keccak256(bytes.concat(a, b)) : keccak256(bytes.concat(b, a));
    }
}

// ================================================================================================
// FIX 1: the owner can no longer drain the player half through a zero swap floor
// ================================================================================================

contract SplitterFloorTest is HardeningBase {
    MockCareToken care;
    MockUSDG usdg;
    Oracle oracle;
    CareRewardsDistributor dist;
    HolderMerkleVault holderVault;
    MockSwapAdapter swap;
    CareFeeSplitter splitter;

    function setUp() public {
        care = new MockCareToken();
        usdg = new MockUSDG();
        oracle = new Oracle();
        dist = new CareRewardsDistributor(owner, IERC20(address(care)), EPOCH, 0, 8);
        holderVault = new HolderMerkleVault(owner, IERC20(address(usdg)), poster);
        swap = new MockSwapAdapter(1e12, 1);
        splitter = new CareFeeSplitter(
            owner, IERC20(address(usdg)), address(holderVault), dist, IPotState(address(oracle)), 5000
        );
        vm.startPrank(owner);
        dist.setVault(address(oracle));
        splitter.setSwapAdapter(address(swap));
        splitter.setSwapParams(300, RATE_1_TO_1);
        vm.stopPrank();
    }

    /// @dev A fresh splitter whose rate has never been set, so the rate-move guard does not apply and
    ///      the ONLY thing standing between the attacker and the money is the positive-floor rule.
    function _freshSplitter() internal returns (CareFeeSplitter s) {
        s = new CareFeeSplitter(
            owner, IERC20(address(usdg)), address(holderVault), dist, IPotState(address(oracle)), 5000
        );
    }

    function test_ProvenAttack_HostileAdapterPlusTinyRateCannotTakeThePlayerHalf() public {
        // The exact proven attack: owner points at a hostile adapter and sets a rate so small that
        // minOut integer-divides to ZERO, then ANYONE pokes the permissionless distribute().
        CareFeeSplitter s = _freshSplitter();
        ZeroDeliveryAdapter hostile = new ZeroDeliveryAdapter();
        vm.startPrank(owner);
        s.setSwapAdapter(address(hostile));
        s.setSwapParams(300, 1); // rate of 1 raw CARE per 1e18 raw USDG: expected rounds to 0
        vm.stopPrank();

        usdg.mint(address(s), 100e6);
        vm.prank(stranger);
        (uint256 holderShare, uint256 playerFeeIn) = s.distribute();

        // BEFORE: the hostile adapter took all 50e6 USDG and delivered 0 CARE, and "0 >= 0" passed.
        // AFTER: the poke refuses to swap without a positive floor and parks the player half instead.
        assertEq(holderShare, 50e6, "holder half still lands");
        assertEq(playerFeeIn, 0, "player half reported as not moved");
        assertEq(usdg.balanceOf(address(hostile)), 0, "hostile adapter got NOTHING");
        assertEq(usdg.balanceOf(address(s)), 50e6, "player half is still on the splitter");
        assertEq(s.parkedPlayerFee(), 50e6, "player half parked for retry, not lost");
        assertEq(care.balanceOf(address(dist)), 0, "no CARE was booked");
    }

    function test_ZeroFloorIsReportedAsBlockedNotAsAFreeSwap() public {
        CareFeeSplitter s = _freshSplitter();
        vm.startPrank(owner);
        s.setSwapAdapter(address(swap));
        s.setSwapParams(300, 1);
        vm.stopPrank();
        (uint256 minOut, string memory reason) = s.swapFloor(50e6);
        assertEq(minOut, 0, "no floor can be formed at this rate");
        assertEq(reason, "no price floor", "and the reason says so");
    }

    function test_RateCannotCollapseInOneUpdate() public {
        // The attack needs the rate to fall off a cliff. It can only walk down 25% at a time.
        skip(splitter.RATE_UPDATE_COOLDOWN());
        vm.prank(owner);
        vm.expectRevert(CareFeeSplitter.RateDecreaseTooLarge.selector);
        splitter.setSwapParams(300, 1);

        uint256 lowestAllowed = (RATE_1_TO_1 * (BPS - splitter.MAX_RATE_DECREASE_BPS())) / BPS;
        vm.prank(owner);
        vm.expectRevert(CareFeeSplitter.RateDecreaseTooLarge.selector);
        splitter.setSwapParams(300, lowestAllowed - 1);

        vm.prank(owner);
        splitter.setSwapParams(300, lowestAllowed); // exactly at the bound is fine
        assertEq(splitter.careOutPerFeeToken1e18(), lowestAllowed);
    }

    function test_RateDecreaseIsRateLimited() public {
        skip(splitter.RATE_UPDATE_COOLDOWN());
        uint256 step1 = (RATE_1_TO_1 * 7500) / BPS;
        vm.prank(owner);
        splitter.setSwapParams(300, step1);

        // A second cut in the same block is refused: the cooldown is what turns a collapse into a
        // slow, publicly observable walk.
        vm.prank(owner);
        vm.expectRevert(CareFeeSplitter.RateUpdateTooSoon.selector);
        splitter.setSwapParams(300, (step1 * 7500) / BPS);

        skip(splitter.RATE_UPDATE_COOLDOWN());
        vm.prank(owner);
        splitter.setSwapParams(300, (step1 * 7500) / BPS); // now allowed
        assertEq(splitter.careOutPerFeeToken1e18(), (step1 * 7500) / BPS);
    }

    function test_RaisingOrZeroingTheRateIsAlwaysAllowed() public {
        // Neither direction can hand money to an adapter cheaply, so neither is rationed. Zeroing
        // parks the leg but deliberately preserves the last non-zero rate as the security baseline.
        vm.startPrank(owner);
        splitter.setSwapParams(300, RATE_1_TO_1 * 1000); // huge jump up, same block
        splitter.setSwapParams(300, RATE_1_TO_1 * 5000); // and again
        splitter.setSwapParams(300, 0); // and off entirely
        vm.stopPrank();
        assertEq(splitter.careOutPerFeeToken1e18(), 0);
        assertEq(splitter.lastNonzeroRate(), RATE_1_TO_1 * 5000, "zero did not erase the floor");
        // With the rate at 0 the player half parks rather than swapping at an unknown price.
        usdg.mint(address(splitter), 100e6);
        splitter.distribute();
        assertEq(splitter.parkedPlayerFee(), 50e6, "parked, never swapped without a rate");
    }

    function test_ZeroCannotResetTheRateDecreaseGuard() public {
        uint256 protectedRate = splitter.lastNonzeroRate();
        vm.prank(owner);
        splitter.setSwapParams(300, 0);

        assertEq(splitter.careOutPerFeeToken1e18(), 0, "swap is parked");
        assertEq(splitter.lastNonzeroRate(), protectedRate, "protected baseline survives zero");

        // The old exploit set zero and then dust. Even after waiting out the cooldown, dust remains
        // below the maximum 25% step and cannot become an almost-zero swap floor.
        skip(splitter.RATE_UPDATE_COOLDOWN());
        vm.prank(owner);
        vm.expectRevert(CareFeeSplitter.RateDecreaseTooLarge.selector);
        splitter.setSwapParams(300, 1);

        uint256 lowestAllowed = (protectedRate * (BPS - splitter.MAX_RATE_DECREASE_BPS())) / BPS;
        vm.prank(owner);
        splitter.setSwapParams(300, lowestAllowed);
        assertEq(splitter.lastNonzeroRate(), lowestAllowed, "bounded re-enable remains possible");
    }

    function test_MaxRateCannotOverflowTheDecreaseGuard() public {
        vm.prank(owner);
        splitter.setSwapParams(300, type(uint256).max);
        vm.warp(block.timestamp + splitter.RATE_UPDATE_COOLDOWN());

        // The protected-rate multiplication used to panic at extreme values. It now evaluates the
        // full-precision bound and returns the intended policy error.
        vm.prank(owner);
        vm.expectRevert(CareFeeSplitter.RateDecreaseTooLarge.selector);
        splitter.setSwapParams(300, 1);
    }

    function test_SwapAdapterLockIsOneWay() public {
        address hostile = address(new ZeroDeliveryAdapter());
        vm.prank(owner);
        splitter.lockSwapAdapter();
        assertTrue(splitter.swapAdapterLocked());
        vm.prank(owner);
        vm.expectRevert(CareFeeSplitter.SwapAdapterIsLocked.selector);
        splitter.setSwapAdapter(hostile);
        // Locking does not break the happy path.
        usdg.mint(address(splitter), 100e6);
        splitter.distribute();
        assertEq(care.balanceOf(address(dist)), 50e18, "locked adapter still swaps normally");
    }

    function test_CannotLockAnUnsetAdapter() public {
        CareFeeSplitter s = _freshSplitter();
        vm.prank(owner);
        vm.expectRevert(CareFeeSplitter.ZeroAddress.selector);
        s.lockSwapAdapter(); // locking address(0) would park the player half forever
    }

    function test_OnlyOwnerCanLockOrTuneTheFloor() public {
        vm.prank(stranger);
        vm.expectRevert();
        splitter.lockSwapAdapter();
        vm.prank(stranger);
        vm.expectRevert();
        splitter.setSwapParams(300, RATE_1_TO_1);
        vm.prank(stranger);
        vm.expectRevert();
        splitter.setRateMaxAge(1 days);
    }

    // ==========================================================================================
    // FIX 5: staleness handling for the hand-maintained rate
    // ==========================================================================================

    function test_StaleRateParksInsteadOfSwappingAgainstAnOldFloor() public {
        assertTrue(splitter.rateIsFresh(), "fresh right after setSwapParams");
        skip(splitter.rateMaxAge() + 1);
        assertFalse(splitter.rateIsFresh(), "expired once older than rateMaxAge");

        (uint256 minOut, string memory reason) = splitter.swapFloor(50e6);
        assertEq(minOut, 0);
        assertEq(reason, "rate stale");

        usdg.mint(address(splitter), 100e6);
        splitter.distribute();
        assertEq(splitter.parkedPlayerFee(), 50e6, "parked while the rate is stale");
        assertEq(care.balanceOf(address(dist)), 0, "no swap against a stale floor");

        // Refreshing the hint (same value, so no decrease guard) unparks it on the next poke.
        vm.prank(owner);
        splitter.setSwapParams(300, RATE_1_TO_1);
        splitter.distribute();
        assertEq(splitter.parkedPlayerFee(), 0, "unparked");
        assertEq(care.balanceOf(address(dist)), 50e18, "swapped once the rate was refreshed");
        // MEDIUM-1 conservation: holders were paid on the NEW fees only, never on parked money.
        assertEq(usdg.balanceOf(address(holderVault)), 50e6, "parked player money was never re-taxed");
    }

    function test_RateMaxAgeIsBoundedOnBothSides() public {
        uint256 tooShort = splitter.MIN_RATE_MAX_AGE() - 1;
        uint256 tooLong = splitter.MAX_RATE_MAX_AGE() + 1;
        vm.startPrank(owner);
        vm.expectRevert(CareFeeSplitter.BadRateMaxAge.selector);
        splitter.setRateMaxAge(tooShort);
        vm.expectRevert(CareFeeSplitter.BadRateMaxAge.selector);
        splitter.setRateMaxAge(tooLong);
        splitter.setRateMaxAge(1 days);
        vm.stopPrank();
        assertEq(splitter.rateMaxAge(), 1 days);
    }

    function test_SwapFloorViewMatchesTheEnforcedFloor() public {
        // The view is what a cron reads before poking, so it must equal what distribute() enforces.
        (uint256 minOut, string memory reason) = splitter.swapFloor(50e6);
        uint256 expected = (50e6 * RATE_1_TO_1) / 1e18;
        assertEq(minOut, (expected * (BPS - 300)) / BPS, "view matches the formula distribute uses");
        assertEq(reason, "", "no blocking reason when a floor exists");

        // An adapter that delivers exactly minOut - 1 must be refused by the enforced floor.
        usdg.mint(address(splitter), 100e6);
        splitter.distribute();
        assertGe(care.balanceOf(address(dist)), minOut, "delivered at least the advertised floor");
    }

    function test_MaxSlippageStillCapped() public {
        uint256 tooMuch = splitter.MAX_SLIPPAGE_BPS() + 1;
        vm.prank(owner);
        vm.expectRevert(CareFeeSplitter.BadSlippage.selector);
        splitter.setSwapParams(tooMuch, RATE_1_TO_1);
    }
}

// ================================================================================================
// FIX 2 + FIX 3: HolderMerkleVault trust model and the claim deadline
// ================================================================================================

contract HolderVaultHardeningTest is HardeningBase {
    MockUSDG usdg;
    HolderMerkleVault vault;

    function setUp() public {
        usdg = new MockUSDG();
        vault = new HolderMerkleVault(owner, IERC20(address(usdg)), poster);
        usdg.mint(address(vault), 100e6);
        vm.prank(owner);
        vault.setMaxRoundTotal(1_000e6);
    }

    // ==========================================================================================
    // FIX 2: the owner is a superset of the poster, and the drain is no longer atomic
    // ==========================================================================================

    function test_OwnerCannotPostAndDrainAtomically() public {
        // The proven drain was: setPoster(owner) then postRound(single-leaf) then claim(empty proof),
        // all in one transaction. The instant setPoster is gone.
        vm.startPrank(owner);
        vault.queuePoster(owner);
        // Committing immediately is refused: the rotation must sit out the timelock in public.
        vm.expectRevert(HolderMerkleVault.RotationNotElapsed.selector);
        vault.commitPoster();
        vm.stopPrank();

        // And the owner is still not the poster, so the drain cannot even start.
        uint256 bal = usdg.balanceOf(address(vault));
        vm.prank(owner);
        vm.expectRevert(HolderMerkleVault.NotPoster.selector);
        vault.postRound(0, _leaf(0, owner, bal), bal);
        assertEq(usdg.balanceOf(address(vault)), bal, "nothing left the vault");
    }

    function test_PosterRotationRequiresTheFullDelayAndIsAnnounced() public {
        uint256 delay = vault.POSTER_ROTATION_DELAY();
        uint256 eta = block.timestamp + delay;
        vm.expectEmit(true, false, false, true, address(vault));
        emit HolderMerkleVault.PosterQueued(stranger, eta);
        vm.prank(owner);
        vault.queuePoster(stranger);
        assertEq(vault.pendingPoster(), stranger);

        skip(delay - 1);
        vm.prank(owner);
        vm.expectRevert(HolderMerkleVault.RotationNotElapsed.selector);
        vault.commitPoster();

        skip(1);
        vm.prank(owner);
        vault.commitPoster();
        assertEq(vault.poster(), stranger, "rotated only after the full delay");
        assertEq(vault.pendingPoster(), address(0), "queue cleared");

        // Committing twice is refused (no replay of a consumed rotation).
        vm.prank(owner);
        vm.expectRevert(HolderMerkleVault.NoPendingPoster.selector);
        vault.commitPoster();
    }

    function test_QueuedRotationCanBeCancelled() public {
        vm.startPrank(owner);
        vault.queuePoster(stranger);
        vault.cancelQueuedPoster();
        vm.stopPrank();
        skip(vault.POSTER_ROTATION_DELAY() + 1);
        vm.prank(owner);
        vm.expectRevert(HolderMerkleVault.NoPendingPoster.selector);
        vault.commitPoster();
        assertEq(vault.poster(), poster, "original poster untouched");
    }

    function test_OnlyOwnerCanQueueOrCommit() public {
        vm.prank(stranger);
        vm.expectRevert();
        vault.queuePoster(stranger);
        vm.prank(owner);
        vault.queuePoster(stranger);
        skip(vault.POSTER_ROTATION_DELAY());
        vm.prank(stranger);
        vm.expectRevert();
        vault.commitPoster();
    }

    function test_RoundCapMustBeArmedBeforeAnyRoundCanBePosted() public {
        // FAIL CLOSED: the old default of 0 meant "uncapped", so the one bound on a leaked poster key
        // was off unless someone remembered to arm it.
        HolderMerkleVault fresh = new HolderMerkleVault(owner, IERC20(address(usdg)), poster);
        usdg.mint(address(fresh), 100e6);
        vm.prank(poster);
        vm.expectRevert(HolderMerkleVault.RoundCapNotArmed.selector);
        fresh.postRound(0, _leaf(0, holder1, 100e6), 100e6);

        vm.prank(owner);
        fresh.setMaxRoundTotal(40e6);
        vm.prank(poster);
        vm.expectRevert(HolderMerkleVault.OverRoundCap.selector);
        fresh.postRound(0, _leaf(0, holder1, 100e6), 100e6);
        vm.prank(poster);
        fresh.postRound(0, _leaf(0, holder1, 40e6), 40e6); // within the armed cap
        assertEq(fresh.reserved(), 40e6);
    }

    function test_AZeroThenRearmCannotRefillASpentPostingBucket() public {
        HolderMerkleVault fresh = new HolderMerkleVault(owner, IERC20(address(usdg)), poster);
        usdg.mint(address(fresh), 20e6);
        vm.prank(owner);
        fresh.setMaxRoundTotal(10e6);

        bytes32[] memory emptyProof = new bytes32[](0);
        vm.prank(poster);
        fresh.postRound(0, _leaf(0, poster, 10e6), 10e6);
        fresh.claim(0, poster, 10e6, emptyProof);
        assertEq(fresh.postingAllowanceAvailable(), 0, "the bucket is fully spent");

        // Before this guard, set cap to 0 then back to 10 immediately granted a fresh full bucket,
        // bypassing the aggregate-loss bound without waiting for its rolling refill.
        vm.prank(owner);
        vm.expectRevert(HolderMerkleVault.ZeroRoundCap.selector);
        fresh.setMaxRoundTotal(0);
        assertEq(fresh.maxRoundTotal(), 10e6, "failed reset leaves the cap armed");
        assertEq(fresh.postingAllowanceAvailable(), 0, "failed reset grants no new capacity");
    }

    function test_RepeatedRoundsCannotBypassTheAggregatePostingAllowance() public {
        HolderMerkleVault fresh = new HolderMerkleVault(owner, IERC20(address(usdg)), poster);
        usdg.mint(address(fresh), 100e6);
        vm.prank(owner);
        fresh.setMaxRoundTotal(10e6);

        // A malicious poster can allocate and permissionlessly claim one self-paying round, but that
        // claim does not restore posting capacity. Splitting the theft into a second round is blocked.
        bytes32[] memory emptyProof = new bytes32[](0);
        vm.prank(poster);
        fresh.postRound(0, _leaf(0, poster, 10e6), 10e6);
        fresh.claim(0, poster, 10e6, emptyProof);
        assertEq(fresh.postingAllowanceAvailable(), 0, "claim does not refill allowance");

        vm.prank(poster);
        vm.expectRevert(HolderMerkleVault.PostingAllowanceExceeded.selector);
        fresh.postRound(1, _leaf(1, poster, 1), 1);
        assertEq(usdg.balanceOf(address(fresh)), 90e6, "aggregate same-block drain stopped");

        // The bucket refills continuously, not at a sharp boundary that permits a double burst.
        skip(fresh.POSTING_WINDOW() / 2);
        assertEq(fresh.postingAllowanceAvailable(), 5e6, "half the window restores half the cap");
        vm.prank(poster);
        fresh.postRound(1, _leaf(1, holder1, 5e6), 5e6);
        assertEq(fresh.postingAllowanceAvailable(), 0);
    }

    function test_PostingPauseIsInstantAndNeverBlocksClaims() public {
        bytes32 l1 = _leaf(0, holder1, 40e6);
        bytes32 l2 = _leaf(0, holder2, 60e6);
        vm.prank(poster);
        vault.postRound(0, _hashPair(l1, l2), 100e6);

        // Emergency stop: a leaked poster key is dead immediately, with no timelock.
        vm.prank(owner);
        vault.setPostingPaused(true);
        vm.prank(poster);
        vm.expectRevert(HolderMerkleVault.PostingIsPaused.selector);
        vault.postRound(1, _leaf(1, holder1, 1), 1);

        // Claims on already-posted rounds keep working: pausing must never strand an allocation.
        bytes32[] memory p1 = new bytes32[](1);
        p1[0] = l2;
        vault.claim(0, holder1, 40e6, p1);
        assertEq(usdg.balanceOf(holder1), 40e6, "claims unaffected by the posting pause");

        // Releases keep working too (the forward-only anti-stranding path is not an admin lever).
        vm.warp(vault.roundDeadline(0));
        vault.releaseRound(0);

        vm.prank(owner);
        vault.setPostingPaused(false);
        vm.prank(poster);
        vault.postRound(1, _leaf(1, holder1, 1e6), 1e6);
        assertEq(vault.roundCount(), 2, "posting resumes when unpaused");
    }

    function test_OwnerStillHasNoDirectTransferPath() public {
        // The natspec no longer claims the owner cannot reach the funds, but it IS still true that
        // there is no DIRECT transfer: rescueToken can never touch the reward token.
        vm.prank(owner);
        vm.expectRevert(HolderMerkleVault.CannotRescueRewardToken.selector);
        vault.rescueToken(IERC20(address(usdg)), owner);
    }

    // ==========================================================================================
    // FIX 3: the release grace and a visible deadline
    // ==========================================================================================

    function test_ReleaseGraceFloorIsThirtyDays() public view {
        assertEq(vault.MIN_RELEASE_GRACE(), 30 days, "7 days was too harsh at a 4x/day cadence");
        assertEq(vault.releaseGrace(), 30 days, "default is the floor");
    }

    function test_GraceCannotBeSetBelowTheFloor() public {
        vm.prank(owner);
        vm.expectRevert(HolderMerkleVault.BadGrace.selector);
        vault.setReleaseGrace(30 days - 1);
        vm.prank(owner);
        vault.setReleaseGrace(60 days);
        assertEq(vault.releaseGrace(), 60 days);
    }

    function test_GraceCannotExceedTheCeiling() public {
        // A grace so long the forward-only release never fires would recreate the permanent-stranding
        // problem that release exists to solve, and an absurd value would overflow the deadline math.
        uint256 ceiling = vault.MAX_RELEASE_GRACE();
        vm.prank(owner);
        vm.expectRevert(HolderMerkleVault.BadGrace.selector);
        vault.setReleaseGrace(ceiling + 1);
        vm.prank(owner);
        vault.setReleaseGrace(ceiling);
        assertEq(vault.releaseGrace(), 365 days);
    }

    function test_SlowHolderKeepsItsAirdropWellPastTheOldSevenDayWindow() public {
        bytes32 l1 = _leaf(0, holder1, 40e6);
        bytes32 l2 = _leaf(0, holder2, 60e6);
        vm.prank(poster);
        vault.postRound(0, _hashPair(l1, l2), 100e6);

        // Under the old 7 day rule anyone could have closed this round by now and holder2 would have
        // lost its allocation. It must still be releasable-proof AND claimable.
        skip(20 days);
        vm.expectRevert(HolderMerkleVault.GraceNotElapsed.selector);
        vault.releaseRound(0);

        bytes32[] memory p2 = new bytes32[](1);
        p2[0] = l1;
        vault.claim(0, holder2, 60e6, p2);
        assertEq(usdg.balanceOf(holder2), 60e6, "slow holder still paid at day 20");
    }

    function test_RoundDeadlineIsVisibleAndSnapshottedAtPostTime() public {
        vm.prank(poster);
        vault.postRound(0, _leaf(0, holder1, 10e6), 10e6);
        uint256 posted = block.timestamp;
        assertEq(vault.roundDeadline(0), posted + 30 days, "deadline is readable on chain");

        // An owner who later lengthens the grace must not retroactively move an existing round's
        // deadline, and must not be able to pull it forward under a holder relying on it either.
        vm.prank(owner);
        vault.setReleaseGrace(90 days);
        assertEq(vault.roundDeadline(0), posted + 30 days, "existing deadline is frozen");

        vm.prank(poster);
        vault.postRound(1, _leaf(1, holder2, 10e6), 10e6);
        assertEq(vault.roundDeadline(1), block.timestamp + 90 days, "new rounds use the new grace");

        // The forward-only release still exists; it just fires on the round's own deadline.
        vm.warp(vault.roundDeadline(0));
        vault.releaseRound(0);
        assertTrue(vault.roundDeadline(1) > block.timestamp, "round 1 is still open");
        vm.expectRevert(HolderMerkleVault.GraceNotElapsed.selector);
        vault.releaseRound(1);
    }

    function test_RoundInfoReportsTheClaimWindow() public {
        vm.prank(poster);
        vault.postRound(0, _leaf(0, holder1, 10e6), 10e6);
        (
            bytes32 root,
            uint256 total,
            uint256 claimedTotal,
            uint256 postedAt,
            uint256 deadline,
            bool released,
            bool claimable
        ) = vault.roundInfo(0);
        assertEq(root, _leaf(0, holder1, 10e6));
        assertEq(total, 10e6);
        assertEq(claimedTotal, 0);
        assertEq(postedAt, block.timestamp);
        assertEq(deadline, block.timestamp + 30 days);
        assertFalse(released);
        assertTrue(claimable);

        vm.warp(deadline);
        vault.releaseRound(0);
        (,,,,, released, claimable) = vault.roundInfo(0);
        assertTrue(released);
        assertFalse(claimable, "a released round is no longer claimable");
    }

    function test_DeadlineViewsRevertOnUnknownRounds() public {
        vm.expectRevert(HolderMerkleVault.NoSuchRound.selector);
        vault.roundDeadline(0);
        vm.expectRevert(HolderMerkleVault.NoSuchRound.selector);
        vault.roundInfo(0);
    }
}

// ================================================================================================
// FIX 4: the auto-claim transfer path tolerates a non-standard ERC-20 and is loud when it fails
// ================================================================================================

contract AutoClaimTransferTest is HardeningBase {
    Oracle oracle;

    function setUp() public {
        oracle = new Oracle();
    }

    function test_AutoClaimWorksWithANoReturnDataToken() public {
        // Mainnet CARE is a third-party launch we do not control. A USDT-style token used to land in
        // catch on EVERY care, silently switching the claim-while-alive guarantee off.
        NoReturnDataToken tok = new NoReturnDataToken();
        CareRewardsDistributor dist = new CareRewardsDistributor(owner, IERC20(address(tok)), EPOCH, 0, 8);
        vm.prank(owner);
        dist.setVault(address(oracle));

        tok.mint(address(dist), 2e18);
        vm.prank(address(oracle));
        dist.notifyCare(1, holder1, 2e18); // epoch 0

        skip(EPOCH); // epoch 0 finished
        tok.mint(address(dist), 2e18);
        vm.prank(address(oracle));
        dist.notifyCare(1, holder1, 2e18); // caring in epoch 1 must auto-claim epoch 0

        assertTrue(dist.claimed(0, 1), "epoch 0 auto-claimed despite the missing return value");
        assertEq(tok.balanceOf(holder1), 2e18, "the pet's TBA was actually paid");
        assertEq(dist.accounted(), 2e18, "accounted debited by exactly the payout");
    }

    function test_ExplicitPushAlsoWorksWithANoReturnDataToken() public {
        NoReturnDataToken tok = new NoReturnDataToken();
        CareRewardsDistributor dist = new CareRewardsDistributor(owner, IERC20(address(tok)), EPOCH, 0, 8);
        vm.prank(owner);
        dist.setVault(address(oracle));
        tok.mint(address(dist), 5e18);
        vm.prank(address(oracle));
        dist.notifyCare(1, holder1, 5e18);
        skip(EPOCH);
        dist.pushRewards(0, _one(1));
        assertEq(tok.balanceOf(holder1), 5e18);
    }

    function test_FailedAutoClaimIsLoudAndNeverBricksCare() public {
        PausableCareToken tok = new PausableCareToken();
        CareRewardsDistributor dist = new CareRewardsDistributor(owner, IERC20(address(tok)), EPOCH, 0, 8);
        vm.prank(owner);
        dist.setVault(address(oracle));

        tok.mint(address(dist), 4e18);
        vm.prank(address(oracle));
        dist.notifyCare(1, holder1, 4e18); // epoch 0
        skip(EPOCH);

        tok.setPaused(true);
        tok.mint(address(dist), 4e18);
        // care() must still succeed, and the failure must be observable rather than silent.
        vm.expectEmit(true, true, false, true, address(dist));
        emit CareRewardsDistributor.AutoClaimFailed(0, 1, 4e18);
        vm.prank(address(oracle));
        dist.notifyCare(1, holder1, 4e18);

        assertFalse(dist.claimed(0, 1), "epoch left unclaimed, so nothing was forfeited by the failure");
        assertEq(tok.balanceOf(holder1), 0, "nothing paid while paused");

        // Once the token works again, the epoch is still payable by the permissionless push.
        tok.setPaused(false);
        dist.pushRewards(0, _one(1));
        assertEq(tok.balanceOf(holder1), 4e18, "no money was lost to the failed auto-claim");
    }

    function test_AutoClaimNeverPaysTwice() public {
        NoReturnDataToken tok = new NoReturnDataToken();
        CareRewardsDistributor dist = new CareRewardsDistributor(owner, IERC20(address(tok)), EPOCH, 0, 8);
        vm.prank(owner);
        dist.setVault(address(oracle));
        tok.mint(address(dist), 3e18);
        vm.prank(address(oracle));
        dist.notifyCare(1, holder1, 3e18);
        skip(EPOCH);
        vm.prank(address(oracle));
        dist.notifyCare(1, holder1, 0); // auto-claims epoch 0
        assertEq(tok.balanceOf(holder1), 3e18);
        skip(EPOCH);
        vm.prank(address(oracle));
        dist.notifyCare(1, holder1, 0); // epoch 0 already claimed, epoch 1 pool is empty
        assertEq(tok.balanceOf(holder1), 3e18, "no double payment");
        // Season 2: a second push does not revert (a batch must never be blocked by one done pet),
        // it SKIPS the already-pushed epoch and moves nothing.
        assertEq(dist.pushRewards(0, _one(1)), 0, "an already-pushed epoch is skipped, not repaid");
        assertEq(tok.balanceOf(holder1), 3e18, "still no double payment");
    }
}

// ================================================================================================
// Conservation properties the audit said HOLD, re-verified rather than trusted
// ================================================================================================

contract ConservationTest is HardeningBase {
    MockCareToken care;
    Oracle oracle;
    CareRewardsDistributor dist;

    function setUp() public {
        care = new MockCareToken();
        oracle = new Oracle();
        dist = new CareRewardsDistributor(owner, IERC20(address(care)), EPOCH, 0, 8);
        vm.prank(owner);
        dist.setVault(address(oracle));
    }

    function _care(uint256 tokenId, address account, uint256 slice) internal {
        if (slice > 0) care.mint(address(dist), slice);
        vm.prank(address(oracle));
        dist.notifyCare(tokenId, account, slice);
    }

    function test_SurvivorClaimsPlusForfeitsSumToExactlyThePool() public {
        _care(1, holder1, 3e18);
        _care(2, holder2, 3e18);
        _care(3, stranger, 3e18);
        uint256 pool = dist.epochPool(0);
        assertEq(pool, 9e18);
        skip(EPOCH);

        oracle.setDead(3, true);
        uint256 target = dist.epochNow() + 1;

        uint256 paid = dist.pushRewards(0, _one(1)) + dist.pushRewards(0, _one(2));
        uint256[] memory dead = new uint256[](1);
        dead[0] = 3;
        dist.sweepForfeited(0, dead);
        uint256 forfeited = dist.epochPool(target);

        // Timing-independent conservation: nothing is created, nothing is destroyed.
        assertEq(paid + forfeited, pool, "survivor claims plus forfeits equal the pool exactly");
        assertEq(care.balanceOf(address(dist)), forfeited, "the forfeited money is still here");
        assertEq(dist.accounted(), forfeited, "accounted tracks the real balance");
    }

    function test_SweepForfeitedIsIdempotentAndCannotDoubleCredit() public {
        _care(1, holder1, 2e18);
        _care(2, holder2, 2e18);
        skip(EPOCH);
        oracle.setDead(2, true);
        uint256 target = dist.epochNow() + 1;

        uint256[] memory dead = new uint256[](1);
        dead[0] = 2;
        dist.sweepForfeited(0, dead);
        uint256 afterFirst = dist.epochPool(target);
        assertEq(afterFirst, 2e18);

        // Second call in the same epoch: the claimed flag makes it a no-op, not a double credit.
        dist.sweepForfeited(0, dead);
        assertEq(dist.epochPool(target), afterFirst, "no double credit");
        // And with the SAME id repeated inside one call.
        uint256[] memory twice = new uint256[](2);
        twice[0] = 2;
        twice[1] = 2;
        dist.sweepForfeited(0, twice);
        assertEq(dist.epochPool(target), afterFirst, "repeating an id in one call credits nothing extra");
        assertEq(care.balanceOf(address(dist)), 4e18, "the contract still holds exactly what came in");
    }

    function test_SweepForfeitedLeavesTheEpochPoolAsADenominatorBasis() public {
        _care(1, holder1, 5e18);
        _care(2, holder2, 5e18);
        skip(EPOCH);
        oracle.setDead(2, true);
        uint256[] memory dead = new uint256[](1);
        dead[0] = 2;
        dist.sweepForfeited(0, dead);
        assertEq(dist.epochPool(0), 10e18, "the denominator basis is never debited");
        assertEq(dist.pendingReward(0, 1), 5e18, "so the survivor's pro rata is still the FULL share");
        assertEq(dist.pushRewards(0, _one(1)), 5e18);
    }

    function test_EveryExternalMoneyPathTargetsTheNextEpochNeverTheLiveOne() public {
        // 1. donateNext
        uint256 e = dist.epochNow();
        care.mint(address(dist), 5e18);
        dist.donateNext();
        assertEq(dist.epochPool(e), 0, "donation never lands live");
        assertEq(dist.epochPool(e + 1), 5e18);

        // 2. the stray-excess branch of notifyCare
        care.mint(address(dist), 7e18); // stray, unbooked
        _care(1, holder1, 1e18);
        assertEq(dist.epochPool(e), 1e18, "only the declared care slice is live");
        assertEq(dist.epochPool(e + 1), 12e18, "stray excess routed a full epoch ahead");

        // 3. sweepForfeited
        _care(2, holder2, 1e18);
        skip(EPOCH);
        uint256 e1 = dist.epochNow();
        oracle.setDead(2, true);
        uint256[] memory dead = new uint256[](1);
        dead[0] = 2;
        dist.sweepForfeited(e, dead);
        assertEq(dist.epochPool(e1 + 1), 1e18, "forfeit lands a full epoch ahead");
        assertEq(dist.epochPool(e1), 12e18, "and never in the live epoch (only the earlier donation)");

        // 4. rollForward of a finished, point-less epoch
        skip(2 * EPOCH);
        uint256 e3 = dist.epochNow();
        dist.rollForward(e1 + 1);
        assertEq(dist.epochPool(e3 + 1), 1e18, "roll lands a full epoch ahead");
    }

    function test_AFinishedEpochPoolCanNeverGrow() public {
        _care(1, holder1, 2e18);
        uint256 e0 = dist.epochNow();
        uint256 pool0 = dist.epochPool(e0);
        skip(EPOCH);

        // Everything that moves money afterwards must leave the finished epoch's pool alone, because
        // claims against it are computed from that number.
        care.mint(address(dist), 9e18);
        dist.donateNext();
        _care(2, holder2, 4e18);
        assertEq(dist.epochPool(e0), pool0, "still frozen after a donation and a later care");

        skip(EPOCH);
        oracle.setDead(2, true);
        uint256[] memory dead = new uint256[](1);
        dead[0] = 2;
        dist.sweepForfeited(e0 + 1, dead);
        assertEq(dist.epochPool(e0), pool0, "still frozen after a forfeit sweep");
        assertEq(dist.pushRewards(e0, _one(1)), pool0, "so the pet claims exactly what it was owed");
    }

    function test_RoundingCannotZeroARealClaimAtSixVersusEighteenDecimals() public {
        // A realistic poke: 50 USDG (6dp) of fee becomes 50e18 CARE (18dp) donated a full epoch ahead,
        // then split across 49 caring pets. Nobody's real claim may round to zero.
        care.mint(address(dist), 50e18);
        dist.donateNext(); // -> epoch 1
        skip(EPOCH);
        uint256 e1 = dist.epochNow();
        for (uint256 i = 1; i <= 49; i++) {
            _care(i, address(uint160(0x1000 + i)), 0); // points only, the pool is already funded
        }
        assertEq(dist.epochPool(e1), 50e18);
        assertEq(dist.totalPoints(e1), 49);

        skip(EPOCH);
        uint256 totalPaid;
        for (uint256 i = 1; i <= 49; i++) {
            uint256 pending = dist.pendingReward(e1, i);
            assertGt(pending, 0, "a real share never rounds to zero at this scale");
            uint256 paid = dist.pushRewards(e1, _one(i));
            assertEq(paid, pending, "pendingReward is exactly what claim pays");
            totalPaid += paid;
        }
        // Floor division leaves at most (totalPoints - 1) raw units of dust behind, which is less than
        // 1e-18 CARE and is NOT lost: it stays in the contract balance.
        assertLe(totalPaid, 50e18);
        assertLt(50e18 - totalPaid, dist.totalPoints(e1), "dust is bounded by the point count");
        assertEq(care.balanceOf(address(dist)), 50e18 - totalPaid, "the dust is still held, not burned");
    }

    function test_SubWeiDustIsTheOnlyCaseAClaimPaysZero() public {
        // The one case where claim() marks an epoch claimed while paying 0 is a pool smaller than the
        // point count, i.e. strictly sub-1-wei-per-point. Documented, not a silent loss of real money.
        care.mint(address(dist), 2);
        dist.donateNext();
        skip(EPOCH);
        uint256 e1 = dist.epochNow();
        _care(1, holder1, 0);
        _care(2, holder2, 0);
        _care(3, stranger, 0);
        assertLt(dist.epochPool(e1), dist.totalPoints(e1), "pool is smaller than the point count");
        skip(EPOCH);
        assertEq(dist.pushRewards(e1, _one(1)), 0, "sub-wei share pays 0");
        assertTrue(dist.claimed(e1, 1));
    }

    function test_MoneyInIsAlwaysEitherClaimedOrProvablySwept() public {
        // Full lifecycle: fees in, two epochs of play, one pet dies, survivor claims, season settles,
        // residual swept to the winner. The contract must end at exactly zero.
        uint256 totalIn;

        _care(1, holder1, 4e18);
        _care(2, holder2, 4e18);
        totalIn += 8e18;

        care.mint(address(dist), 20e18); // the splitter's swapped player half
        dist.donateNext();
        totalIn += 20e18;

        skip(EPOCH);
        oracle.setDead(2, true);
        uint256[] memory dead = new uint256[](1);
        dead[0] = 2;
        dist.sweepForfeited(0, dead);
        uint256 paid = dist.pushRewards(0, _one(1));

        skip(EPOCH);
        _care(1, holder1, 1e18);
        totalIn += 1e18;

        oracle.setLeader(1);
        oracle.setPotClaimed(true);
        dist.sweepResidualToWinner();

        assertEq(care.balanceOf(address(dist)), 0, "nothing is stranded in the distributor");
        // holder1 is pet 1's recorded account, and the winner's TBA, so it ends up with everything
        // that ever entered minus nothing. Money is conserved end to end.
        assertEq(care.balanceOf(holder1), totalIn, "every unit that entered was paid out");
        assertGt(paid, 0, "the survivor really did get an interim claim");
    }

    function test_ResidualSweepRequiresTheWinnerToHaveCared() public {
        // Documented residual edge, asserted so it cannot regress silently: the post-season escape
        // pays the WINNER'S recorded TBA, and that address is only recorded by notifyCare. A leader
        // that never cared through THIS distributor has no recorded account, so the sweep refuses
        // rather than sending to address(0). Deliberately not "fixed" with an owner fallback here:
        // any such fallback would create an owner money path, which this contract must never have.
        _care(1, holder1, 5e18);
        oracle.setLeader(99); // a leader that never cared through this distributor
        oracle.setPotClaimed(true);
        vm.expectRevert(CareRewardsDistributor.ZeroAddress.selector);
        dist.sweepResidualToWinner();
        // Pets that DID care are unaffected: their money is still claimable.
        skip(EPOCH);
        assertEq(dist.pushRewards(0, _one(1)), 5e18, "a caring pet's money is never held hostage by this edge");
    }

    function test_ClaimAndSweepCannotUnderflowAccounted() public {
        // accounted must never be driven negative by any ordering of claim, forfeit and residual sweep.
        _care(1, holder1, 6e18);
        _care(2, holder2, 6e18);
        skip(EPOCH);
        dist.pushRewards(0, _one(1));
        oracle.setDead(2, true);
        uint256[] memory dead = new uint256[](1);
        dead[0] = 2;
        dist.sweepForfeited(0, dead);
        assertEq(dist.accounted(), care.balanceOf(address(dist)), "accounted tracks the balance exactly");
        oracle.setLeader(1);
        oracle.setPotClaimed(true);
        dist.sweepResidualToWinner();
        assertEq(dist.accounted(), 0);
        assertEq(care.balanceOf(address(dist)), 0);
    }
}

// ================================================================================================
// End to end: the splitter's parked money is never re-taxed and always reaches players eventually
// ================================================================================================

contract SplitterConservationTest is HardeningBase {
    MockCareToken care;
    MockUSDG usdg;
    Oracle oracle;
    CareRewardsDistributor dist;
    HolderMerkleVault holderVault;
    MockSwapAdapter swap;
    CareFeeSplitter splitter;

    function setUp() public {
        care = new MockCareToken();
        usdg = new MockUSDG();
        oracle = new Oracle();
        dist = new CareRewardsDistributor(owner, IERC20(address(care)), EPOCH, 0, 8);
        holderVault = new HolderMerkleVault(owner, IERC20(address(usdg)), poster);
        swap = new MockSwapAdapter(1e12, 1);
        splitter = new CareFeeSplitter(
            owner, IERC20(address(usdg)), address(holderVault), dist, IPotState(address(oracle)), 5000
        );
        vm.prank(owner);
        dist.setVault(address(oracle));
    }

    function test_ParkedFeeIsNeverReTaxedAcrossManyPokesThenClearsInFull() public {
        // Three pokes with no adapter wired: holders take exactly half of each NEW batch and never a
        // second bite of the growing parked pile.
        usdg.mint(address(splitter), 100e6);
        splitter.distribute();
        usdg.mint(address(splitter), 60e6);
        splitter.distribute();
        usdg.mint(address(splitter), 40e6);
        splitter.distribute();
        assertEq(usdg.balanceOf(address(holderVault)), 100e6, "exactly half of 200 total, never more");
        assertEq(splitter.parkedPlayerFee(), 100e6, "the other half is parked intact");

        // Wire the swap: the whole parked pile converts in one poke and lands a full epoch ahead.
        vm.startPrank(owner);
        splitter.setSwapAdapter(address(swap));
        splitter.setSwapParams(300, RATE_1_TO_1);
        vm.stopPrank();
        uint256 next = dist.epochNow() + 1;
        splitter.distribute();
        assertEq(splitter.parkedPlayerFee(), 0, "parked cleared");
        assertEq(usdg.balanceOf(address(splitter)), 0, "no USDG left behind");
        assertEq(usdg.balanceOf(address(holderVault)), 100e6, "holders got no extra cut from the parked pile");
        assertEq(dist.epochPool(next), 100e18, "the whole player half reached players, a full epoch ahead");
        assertEq(dist.epochPool(dist.epochNow()), 0, "never the live epoch");
    }

    function test_PostSeasonParkedMoneyRoutesToHoldersRatherThanStranding() public {
        usdg.mint(address(splitter), 100e6);
        splitter.distribute(); // no adapter: 50 to holders, 50 parked
        assertEq(splitter.parkedPlayerFee(), 50e6);

        // Once the season settles no pet can earn player rewards, so parked money must not strand.
        oracle.setPotClaimed(true);
        splitter.distribute();
        assertEq(splitter.parkedPlayerFee(), 0, "parked accumulator cleared post-season");
        assertEq(usdg.balanceOf(address(splitter)), 0, "nothing stranded on the splitter");
        assertEq(usdg.balanceOf(address(holderVault)), 100e6, "all of it reached holders");
    }
}
