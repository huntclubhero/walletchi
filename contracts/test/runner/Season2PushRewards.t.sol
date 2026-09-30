// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

// SEASON 2: NOBODY CLAIMS. UNAUDITED: re-audit before mainnet.
//
// claim(epoch, tokenId) and claimMany are gone; the only way a finished epoch's money reaches a pet
// is notifyCare's auto-push or the PERMISSIONLESS pushRewards(epoch, tokenIds). The properties that
// make that safe are all new and none of them existed before this file:
//
//   * a caller chooses WHO gets paid EARLIER and nothing else: never how much, never where;
//   * PER-PET NON-BLOCKING, so one hostile TBA or one corpse can never block a batch. This is the
//     property the 2h cron depends on, because a batch is the whole point of a cron;
//   * a DUST THRESHOLD, so 2h cadence cannot spray thousands of near-zero transfers, with the
//     skipped value ROLLED FORWARD rather than dropped;
//   * autoClaimLookback is a constructor parameter now (it was a baked 8, which covered 16h of a
//     24h life window at 2h epochs and so violated the deploy invariant lookback * epoch >= lifeTtl).

import {Test} from "forge-std/Test.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";

import {CareRewardsDistributor, IPetLiveness} from "../../src/runner/CareRewardsDistributor.sol";

/// @dev Settable liveness + settlement oracle standing in for PetVault (kept local to this file so
///      it never depends on another suite's fixtures).
contract LivenessOracle is IPetLiveness {
    mapping(uint256 => bool) public deadOf;
    bool public potClaimedFlag;
    uint256 public leaderId;
    address public pet;

    function setPet(address pet_) external {
        pet = pet_;
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

    function potClaimed() external view returns (bool) {
        return potClaimedFlag;
    }

    function leader() external view returns (uint256) {
        return leaderId;
    }
}

/// @dev Isolates the distributor's resolver integration. Pet721's owner authorization and automatic
///      transfer clearing are covered against the real NFT in Pet721v2.t.sol.
contract PayoutResolver {
    mapping(uint256 => address) public overrideOf;

    function setPayoutAddress(uint256 tokenId, address recipient) external {
        overrideOf[tokenId] = recipient;
    }

    function payoutAddress(uint256 tokenId, address defaultRecipient) external view returns (address) {
        address recipient = overrideOf[tokenId];
        return recipient == address(0) ? defaultRecipient : recipient;
    }
}

/// @dev A care token that refuses to pay specific addresses, the way a real third-party launch with
///      a blacklist or a pause switch would. Models the mainnet CARE we do not control.
contract BlockingCareToken is ERC20 {
    mapping(address => bool) public blocked;

    constructor() ERC20("Blocking Care", "BCARE") {}

    function mint(address to, uint256 amount) external {
        _mint(to, amount);
    }

    function setBlocked(address who, bool v) external {
        blocked[who] = v;
    }

    function _update(address from, address to, uint256 value) internal override {
        require(!blocked[to] && !blocked[from], "BLOCKED");
        super._update(from, to, value);
    }
}

abstract contract PushBase is Test {
    BlockingCareToken internal care;
    LivenessOracle internal oracle;
    CareRewardsDistributor internal dist;
    PayoutResolver internal resolver;

    address internal owner = makeAddr("owner");
    address internal bot = makeAddr("pushBot"); // the 2h cron: a convenience, never an authority
    address internal stranger = makeAddr("stranger");
    address internal tba1 = makeAddr("tba1");
    address internal tba2 = makeAddr("tba2");
    address internal tba3 = makeAddr("tba3");

    uint256 internal constant EPOCH = 2 hours; // the season-2 push cadence

    function _deploy(uint256 dustThreshold, uint256 lookback) internal {
        care = new BlockingCareToken();
        oracle = new LivenessOracle();
        resolver = new PayoutResolver();
        oracle.setPet(address(resolver));
        dist = new CareRewardsDistributor(owner, IERC20(address(care)), EPOCH, dustThreshold, lookback);
        vm.prank(owner);
        dist.setVault(address(oracle));
    }

    /// @dev One care: the vault sends the slice, then calls the hook. Mirrors PetVault.care exactly.
    function _care(uint256 tokenId, address account, uint256 slice) internal {
        if (slice > 0) care.mint(address(dist), slice);
        vm.prank(address(oracle));
        dist.notifyCare(tokenId, account, slice);
    }

    function _ids(uint256 a) internal pure returns (uint256[] memory ids) {
        ids = new uint256[](1);
        ids[0] = a;
    }

    function _ids(uint256 a, uint256 b, uint256 c) internal pure returns (uint256[] memory ids) {
        ids = new uint256[](3);
        ids[0] = a;
        ids[1] = b;
        ids[2] = c;
    }
}

// ================================================================================================
// Push accounting: permissionless, contract-enforced amounts, contract-fixed destinations.
// ================================================================================================
contract PushAccountingTest is PushBase {
    function setUp() public {
        _deploy(0, 8); // no dust threshold: the legacy payout shape
    }

    /// The 2h bot has no authority. A total stranger can run the identical push, the money lands in
    /// the pet's RECORDED account, and the caller takes nothing for having paid the gas.
    function test_PushIsPermissionlessAndPaysOnlyTheRecordedAccount() public {
        _care(1, tba1, 6e18);
        skip(EPOCH);

        vm.prank(stranger);
        uint256 moved = dist.pushRewards(0, _ids(1));

        assertEq(moved, 6e18, "the push reports what it actually moved");
        assertEq(care.balanceOf(tba1), 6e18, "paid into the pet's own account");
        assertEq(care.balanceOf(stranger), 0, "and never a unit to whoever poked it");
        assertTrue(dist.claimed(0, 1));
        assertEq(dist.accounted(), 0, "accounted debited by exactly the payout");
        assertEq(care.balanceOf(address(dist)), 0);
    }

    /// The destination is not merely un-chosen by the caller, it TRACKS the pet: notifyCare re-records
    /// the account on every care, so a pet that changed hands is paid at its current account.
    function test_ThePayoutFollowsTheAccountTheContractRecorded() public {
        _care(1, tba1, 4e18); // epoch 0, recorded to tba1
        skip(EPOCH);
        _care(1, tba2, 0); // a later care re-records the account (the pet moved)

        assertEq(dist.accountOf(1), tba2, "the recorded account is the newest one");
        // Epoch 0's money follows the RECORDED account, which the auto-push already delivered.
        assertEq(care.balanceOf(tba2), 4e18, "the current account was paid");
        assertEq(care.balanceOf(tba1), 0, "and the stale one was not");
    }

    function test_TheReturnValueCountsOnlyWhatReallyTransferred() public {
        _care(1, tba1, 3e18);
        _care(2, tba2, 3e18);
        skip(EPOCH);
        oracle.setDead(2, true); // pet 2 forfeits instead of being pushed

        vm.prank(bot);
        uint256 moved = dist.pushRewards(0, _ids(1, 2, 999));
        assertEq(moved, 3e18, "only the one living, pointed pet's payout is counted");
        assertEq(care.balanceOf(tba1), 3e18);
        assertEq(care.balanceOf(tba2), 0);
    }

    /// Everything ineligible is SKIPPED, never reverted, and the eligible pet in the same batch is
    /// still paid. This is the property the 2h cron rests on: a batch must not be all-or-nothing.
    function test_IneligiblePetsAreSkippedAndNeverBlockTheBatch() public {
        _care(1, tba1, 5e18); // will be pushed first, then re-listed as already-pushed
        _care(2, tba2, 5e18); // will be dead
        _care(3, tba3, 5e18); // the one that must still get paid
        skip(EPOCH);

        vm.prank(bot);
        dist.pushRewards(0, _ids(1)); // pet 1 is now already-pushed
        oracle.setDead(2, true);

        uint256 before3 = care.balanceOf(tba3);
        vm.prank(bot);
        // already-pushed (1), dead (2), zero-point (999) and payable (3) in ONE batch.
        uint256[] memory batch = new uint256[](4);
        batch[0] = 1;
        batch[1] = 2;
        batch[2] = 999;
        batch[3] = 3;
        uint256 moved = dist.pushRewards(0, batch);

        assertEq(moved, 5e18, "exactly the one payable pet moved");
        assertEq(care.balanceOf(tba3) - before3, 5e18, "and it really was paid");
        assertEq(care.balanceOf(tba1), 5e18, "the already-pushed pet was not paid twice");
        assertEq(care.balanceOf(tba2), 0, "the dead pet was not paid");
        assertFalse(dist.claimed(0, 2), "a dead pet is left for sweepForfeited, not marked done");
        assertFalse(dist.claimed(0, 999), "a pet with no points in the epoch is left untouched");
    }

    /// A second push moves nothing rather than reverting. Idempotence is what lets the cron re-run a
    /// batch after a partial failure without hand-picking which pets are still owed.
    function test_PushingTwiceIsIdempotent() public {
        _care(1, tba1, 7e18);
        skip(EPOCH);
        vm.prank(bot);
        assertEq(dist.pushRewards(0, _ids(1)), 7e18);
        vm.prank(bot);
        assertEq(dist.pushRewards(0, _ids(1)), 0, "the second push moves nothing");
        assertEq(care.balanceOf(tba1), 7e18, "and pays nothing twice");
    }

    /// The same id repeated INSIDE one batch cannot double pay either: the claimed flag is written
    /// before the loop moves on, so the duplicate reads as already-pushed.
    function test_DuplicateIdsInOneBatchCannotDoublePay() public {
        _care(1, tba1, 9e18);
        skip(EPOCH);
        vm.prank(bot);
        uint256 moved = dist.pushRewards(0, _ids(1, 1, 1));
        assertEq(moved, 9e18, "one payout, not three");
        assertEq(care.balanceOf(tba1), 9e18);
        assertEq(dist.accounted(), 0, "accounting cannot go negative on a duplicate");
    }

    /// A sub-wei share pays 0 but must still close the epoch out, or the cron would retry it forever.
    function test_AZeroPayoutStillMarksTheEpochDone() public {
        care.mint(address(dist), 2);
        dist.donateNext(); // -> epoch 1
        skip(EPOCH);
        _care(1, tba1, 0);
        _care(2, tba2, 0);
        _care(3, tba3, 0); // 3 points against a 2-unit pool
        uint256 e1 = dist.epochNow();
        skip(EPOCH);

        vm.expectEmit(true, true, true, true, address(dist));
        emit CareRewardsDistributor.RewardsPushed(e1, 1, tba1, 0);
        vm.prank(bot);
        assertEq(dist.pushRewards(e1, _ids(1)), 0);
        assertTrue(dist.claimed(e1, 1), "closed out, so the cron never retries it");
    }

    /// The batch-level refusals are unchanged from the claim era: they describe the EPOCH, not a pet,
    /// so there is no per-pet outcome to skip to.
    function test_TheBatchLevelRefusalsStillRevert() public {
        _care(1, tba1, 5e18);

        vm.expectRevert(CareRewardsDistributor.EpochNotFinished.selector);
        dist.pushRewards(0, _ids(1)); // epoch 0 is still live

        skip(EPOCH);
        skip(EPOCH); // now epoch 2, so epoch 1 is finished and nobody ever scored in it
        vm.expectRevert(CareRewardsDistributor.NoPoints.selector);
        dist.pushRewards(1, _ids(1));

        oracle.setLeader(1);
        oracle.setPotClaimed(true);
        dist.sweepResidualToWinner();
        vm.expectRevert(CareRewardsDistributor.SeasonSettled.selector);
        dist.pushRewards(0, _ids(1)); // the balance is with the winner; a late push would underflow
    }

    /// Conservation across a full cycle: every unit that entered is either in a pet's account or
    /// still here backing `accounted`. Nothing is minted and nothing evaporates.
    function test_AccountedAlwaysTracksTheRealBalance() public {
        _care(1, tba1, 4e18);
        _care(2, tba2, 4e18);
        care.mint(address(dist), 10e18);
        dist.donateNext();
        skip(EPOCH);

        vm.prank(bot);
        dist.pushRewards(0, _ids(1));
        assertEq(dist.accounted(), care.balanceOf(address(dist)), "after a partial push");
        vm.prank(bot);
        dist.pushRewards(0, _ids(2));
        assertEq(dist.accounted(), care.balanceOf(address(dist)), "after the rest of the batch");
        assertEq(care.balanceOf(tba1) + care.balanceOf(tba2) + care.balanceOf(address(dist)), 18e18);
    }
}

// ================================================================================================
// NON-BLOCKING: one hostile recipient must never hold a batch (or the whole cron) hostage.
// ================================================================================================
contract PushNonBlockingTest is PushBase {
    function setUp() public {
        _deploy(0, 8);
    }

    /// THE ATTACK: a pet whose TBA the care token refuses. Under an all-or-nothing batch this one
    /// pet would revert every push for every other pet in the epoch, and the 2h cron would stop
    /// delivering rewards to the entire collection.
    function test_AHostileRecipientCannotBlockTheRestOfTheBatch() public {
        _care(1, tba1, 5e18);
        _care(2, tba2, 5e18);
        _care(3, tba3, 5e18);
        skip(EPOCH);

        care.setBlocked(tba2, true);

        // The failure is LOUD: an off pipeline must be visible in the logs, never silent.
        vm.expectEmit(true, true, false, true, address(dist));
        emit CareRewardsDistributor.RewardsPushFailed(0, 2, 5e18);
        vm.prank(bot);
        uint256 moved = dist.pushRewards(0, _ids(1, 2, 3));

        assertEq(moved, 10e18, "the two healthy pets were paid in full");
        assertEq(care.balanceOf(tba1), 5e18);
        assertEq(care.balanceOf(tba3), 5e18);
        assertEq(care.balanceOf(tba2), 0, "the blocked pet got nothing");
        assertFalse(dist.claimed(0, 2), "and its epoch is left UNPUSHED for the next cycle");
        assertTrue(dist.claimed(0, 1));
        assertTrue(dist.claimed(0, 3));
    }

    /// A failed push is a delay, not a forfeit: the next cycle collects it once the token behaves.
    function test_AFailedPushIsRetriedByTheNextCycle() public {
        _care(1, tba1, 8e18);
        skip(EPOCH);
        care.setBlocked(tba1, true);

        vm.prank(bot);
        assertEq(dist.pushRewards(0, _ids(1)), 0, "nothing moved while the token refused");
        assertEq(dist.accounted(), 8e18, "the money is still here, still booked");

        care.setBlocked(tba1, false);
        vm.prank(bot);
        assertEq(dist.pushRewards(0, _ids(1)), 8e18, "the very next cycle delivers it");
        assertEq(care.balanceOf(tba1), 8e18);
    }

    function test_ABlockedTbaCanUseTheOwnerAuthorizedAlternateDestination() public {
        _care(1, tba1, 8e18);
        skip(EPOCH);
        care.setBlocked(tba1, true);
        address recovery = makeAddr("ownerRecovery");
        resolver.setPayoutAddress(1, recovery);

        // The pusher still chooses neither amount nor destination and receives nothing. The token's
        // owner configured the resolver separately; the blocked TBA can stay blocked permanently.
        vm.prank(stranger);
        assertEq(dist.pushRewards(0, _ids(1)), 8e18);
        assertEq(care.balanceOf(recovery), 8e18, "alternate destination receives the full reward");
        assertEq(care.balanceOf(tba1), 0, "blocked TBA remains untouched");
        assertEq(care.balanceOf(stranger), 0, "permissionless pusher cannot redirect to itself");
    }

    /// The blocked pet's slice is not silently redirected to the survivors either: the pool is a
    /// denominator basis, so a failed push changes nobody else's arithmetic.
    function test_AFailedPushDoesNotInflateAnybodyElsesShare() public {
        _care(1, tba1, 5e18);
        _care(2, tba2, 5e18);
        skip(EPOCH);
        care.setBlocked(tba2, true);

        vm.prank(bot);
        dist.pushRewards(0, _ids(1, 2, 2));
        assertEq(care.balanceOf(tba1), 5e18, "the survivor got its own share and not a unit more");
        assertEq(dist.pendingReward(0, 2), 5e18, "the blocked pet is still owed exactly its share");
    }
}

// ================================================================================================
// The dust threshold: 2h cadence must not spray near-zero transfers, and must not lose the value.
// ================================================================================================
contract PushDustThresholdTest is PushBase {
    function setUp() public {
        _deploy(1e18, 8); // anything under 1 CARE rolls instead of transferring
    }

    function test_ADustPayoutRollsForwardInsteadOfTransferring() public {
        _care(1, tba1, 0.4e18); // below the 1e18 threshold
        skip(EPOCH);
        uint256 target = dist.epochNow() + 1;
        uint256 balBefore = care.balanceOf(address(dist));
        uint256 accountedBefore = dist.accounted();

        vm.expectEmit(true, true, false, true, address(dist));
        emit CareRewardsDistributor.DustRolled(0, 1, target, 0.4e18);
        vm.prank(bot);
        uint256 moved = dist.pushRewards(0, _ids(1));

        assertEq(moved, 0, "nothing was transferred");
        assertEq(care.balanceOf(tba1), 0, "no spam transfer to the pet");
        assertTrue(dist.claimed(0, 1), "the epoch is closed so the cron stops retrying it");
        // VALUE CONSERVED: the money never left, it changed epoch.
        assertEq(dist.epochPool(target), 0.4e18, "credited a full epoch ahead");
        assertEq(care.balanceOf(address(dist)), balBefore, "the contract still holds it");
        assertEq(dist.accounted(), accountedBefore, "and it is still booked");
    }

    /// The threshold is STRICTLY less: a payout exactly at the threshold is real money and pays out.
    function test_APayoutExactlyAtTheThresholdIsPaidNotRolled() public {
        _care(1, tba1, 1e18);
        skip(EPOCH);
        vm.prank(bot);
        assertEq(dist.pushRewards(0, _ids(1)), 1e18, "exactly at the threshold transfers");
        assertEq(care.balanceOf(tba1), 1e18);
        assertEq(dist.epochPool(dist.epochNow() + 1), 0, "nothing was rolled");
    }

    /// Rolled dust is not stranded: it lands in a real future pool and a pet that cares in THAT epoch
    /// collects it. Dust accumulates into a payable amount instead of being sprayed or lost.
    function test_RolledDustIsCollectableInTheEpochItRolledInto() public {
        _care(1, tba1, 0.4e18);
        _care(2, tba2, 0.4e18);
        skip(EPOCH);
        uint256 target = dist.epochNow() + 1;
        vm.prank(bot);
        dist.pushRewards(0, _ids(1, 2, 2));
        assertEq(dist.epochPool(target), 0.8e18, "both dust slices pooled together");

        skip(EPOCH); // now IN the target epoch: score a point in it
        assertEq(dist.epochNow(), target);
        _care(1, tba1, 0.4e18);
        skip(EPOCH); // finish it

        vm.prank(bot);
        uint256 moved = dist.pushRewards(target, _ids(1));
        assertEq(moved, 1.2e18, "the accumulated dust plus the new slice is one payable amount");
        assertEq(care.balanceOf(tba1), 1.2e18);
    }

    /// A dust roll must not double-credit if the batch repeats the id, and must not leave the
    /// contract holding less than it has booked.
    function test_DustRollsCannotDoubleCreditOrBreakSolvency() public {
        _care(1, tba1, 0.4e18);
        skip(EPOCH);
        uint256 target = dist.epochNow() + 1;
        vm.prank(bot);
        dist.pushRewards(0, _ids(1, 1, 1));
        assertEq(dist.epochPool(target), 0.4e18, "credited once, not three times");
        assertGe(care.balanceOf(address(dist)), dist.accounted(), "still solvent");
    }

    /// A zero threshold is the legacy shape, asserted positively so "dust rolling" can never be on
    /// by accident in a deployment that did not ask for it.
    function test_AZeroThresholdTransfersEverything() public {
        _deploy(0, 8);
        _care(1, tba1, 1); // one raw unit
        skip(EPOCH);
        vm.prank(bot);
        assertEq(dist.pushRewards(0, _ids(1)), 1, "with no threshold even one wei transfers");
        assertEq(care.balanceOf(tba1), 1);
        assertEq(dist.epochPool(dist.epochNow() + 1), 0, "and nothing rolls");
    }
}

// ================================================================================================
// autoClaimLookback: a constructor parameter, because the baked 8 was too short for the live config.
// ================================================================================================
contract AutoClaimLookbackTest is PushBase {
    function test_TheLookbackIsBoundedAndStored() public {
        _deploy(0, 1);
        assertEq(dist.autoClaimLookback(), 1, "the floor is accepted");
        _deploy(0, 64);
        assertEq(dist.autoClaimLookback(), 64, "the ceiling is accepted");

        care = new BlockingCareToken();
        vm.expectRevert(CareRewardsDistributor.BadLookback.selector);
        new CareRewardsDistributor(owner, IERC20(address(care)), EPOCH, 0, 0);
        vm.expectRevert(CareRewardsDistributor.BadLookback.selector);
        new CareRewardsDistributor(owner, IERC20(address(care)), EPOCH, 0, 65);
    }

    /// WHY IT IS A PARAMETER. The auto-push on care only reaches back `autoClaimLookback` finished
    /// epochs; anything older needs an explicit push. At the season-1 baked 8 with 2h epochs that
    /// covered 16h of a 24h life window, so a keeper caring once per window silently left epochs
    /// behind. Proven here at lookback 1, then proven recoverable by the permissionless push.
    function test_AShortLookbackLeavesOlderEpochsToTheExplicitPush() public {
        _deploy(0, 1);
        _care(1, tba1, 5e18); // epoch 0
        skip(EPOCH);
        skip(EPOCH);
        skip(EPOCH); // now epoch 3, so epoch 0 is three finished epochs back

        uint256 balBefore = care.balanceOf(tba1);
        _care(1, tba1, 0); // caring in epoch 3 looks back exactly ONE epoch (epoch 2, empty)
        assertEq(care.balanceOf(tba1) - balBefore, 0, "epoch 0 is outside the lookback window");
        assertFalse(dist.claimed(0, 1), "so it was never auto-pushed");

        // Nothing is lost: the pet is alive, so anyone can still push the older epoch.
        vm.prank(bot);
        assertEq(dist.pushRewards(0, _ids(1)), 5e18, "the explicit push reaches back as far as needed");
        assertEq(dist.claimed(0, 1), true);
    }

    /// And a lookback wide enough for the life window collects the same epochs automatically, which
    /// is the deploy invariant (autoClaimLookback * epochLength >= lifeTtl) doing its job.
    function test_AWideEnoughLookbackAutoCollectsTheSameEpochs() public {
        _deploy(0, 12); // 12 * 2h = 24h, one full life window
        _care(1, tba1, 5e18); // epoch 0
        skip(EPOCH);
        skip(EPOCH);
        skip(EPOCH); // now epoch 3

        _care(1, tba1, 0);
        assertEq(care.balanceOf(tba1), 5e18, "epoch 0 was swept in automatically by the care hook");
        assertTrue(dist.claimed(0, 1));
    }
}
