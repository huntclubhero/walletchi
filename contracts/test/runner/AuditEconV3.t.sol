// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

// ================================================================================================
// ADVERSARIAL ECONOMIC AUDIT of the WALLETCHI economy v3 (three-leg care split + RewardsDistributor).
// Lens: ECONOMIC ACCOUNTING. Goal: BREAK the money math, not praise it.
//
// This file only ADDS tests; it touches no source. It reuses the RewardsBase harness declared in
// RewardsV3.t.sol (imported, not modified) for the full vault stack, and builds bare distributors
// for the pure accounting attacks.
//
// Findings proven below (see the per test banners):
//   [FIXED, was MED]  rollForward used to dump a zero point epoch's pool into a FINISHED, already
//          claimed epoch, trapping those funds. FIX: rollForward now credits the LIVE epoch, so a
//          rolled pool is always rescued into a still-claimable epoch. The former strand PoC now
//          asserts the rescue. (test_H_RollForwardRescuesDonationIntoLiveEpoch)
//   [FIXED, was MED]  rollForward used to mutate a finished pool mid settlement, giving equal-point
//          pets a claim-ordering-dependent payout. FIX: a roll no longer touches a finished pointed
//          epoch, so equal points earn equal payouts regardless of ordering.
//          (test_H_RollForwardDoesNotBreakProRataMidSettlement)
//   [LOW]  A direct donation is attributed to whichever epoch first triggers recognition, so a sole
//          carer can capture a donation it did not fund by timing its care.
//          (test_M_DonationEpochAttributionIsTimingControlled)
//   [INFO] vault.totalRewards() is a NOMINAL "sent" counter; under a taxed care token it overstates
//          the funds the distributor actually received / can pay out.
//          (test_M_VaultTotalRewardsOverstatesDistributorUnderFoT)
//
// Resilience confirmed (things that did NOT break, see banners): claimMany duplicate ids, accounted
// underflow via a timely rollForward, epoch boundary claim timing, and two fuzz / invariant campaigns
// for pro rata conservation and distributor solvency.
// ================================================================================================

import {Test} from "forge-std/Test.sol";
import {StdInvariant} from "forge-std/StdInvariant.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

import {PetVault, IPetCareSpender} from "../../src/runner/PetVault.sol";
import {RewardsDistributor} from "../../src/runner/RewardsDistributor.sol";
import {MockCareToken} from "../../src/runner/MockCareToken.sol";
import {PonsCareToken} from "../../src/runner/PonsCareToken.sol";

import {RewardsBase, VaultStub} from "./RewardsV3.t.sol";

/// @dev Shared helpers for the bare distributor attacks: a fresh distributor + mock care token wired to
///      a stand in vault EOA we can prank as, so we can drive notifyCare directly and control epochs.
abstract contract AuditBase is RewardsBase {
    address internal distVault = address(new VaultStub());

    function _freshDist() internal returns (RewardsDistributor d, MockCareToken c) {
        c = new MockCareToken();
        d = new RewardsDistributor(owner, IERC20(address(c)), EPOCH);
        vm.prank(owner);
        d.setVault(distVault);
    }

    function _notify(RewardsDistributor d, uint256 id, address acct, uint256 declared) internal {
        vm.prank(distVault);
        d.notifyCare(id, acct, declared);
    }
}

// ================================================================================================
// FIX 1 (was MED): rollForward now credits the LIVE epoch, so a zero-point pool is always rescued into
// a still-claimable epoch and never strands on a settled one. These tests assert the fix.
// ================================================================================================

contract AuditEconV3_RollForwardStrand is AuditBase {
    /// A benefactor's donation to a point-less epoch is rescued by rollForward. The fix credits
    /// epochNow() (the live epoch), NOT epoch+1, so even a LATE roll (after the next epoch finished and
    /// was fully claimed) lands the donation in the current, still-claimable epoch. A pet caring there
    /// then collects it: no strand, honoring the "never trapped, claimable forever" promise.
    function test_H_RollForwardRescuesDonationIntoLiveEpoch() public {
        (RewardsDistributor d, MockCareToken c) = _freshDist();
        address tbaA = makeAddr("tbaStrandA");
        address tbaB = makeAddr("tbaStrandB");

        // Epoch 0: a sponsor donates 100e18 and syncs it in; nobody cares (zero point pool).
        c.mint(address(d), 100e18);
        d.sync();
        assertEq(d.epochPool(0), 100e18, "epoch 0 holds the donation");
        assertEq(d.totalPoints(0), 0, "epoch 0 is point less");

        // Epoch 1: pet 1 cares once, funding and earning a single point in epoch 1.
        vm.warp(block.timestamp + EPOCH);
        c.mint(address(d), 10e18);
        _notify(d, 1, tbaA, 10e18);
        assertEq(d.epochPool(1), 10e18, "epoch 1 pool is its own care");

        // Epoch 2: epoch 1 is finished; pet 1 claims its whole epoch 1 pool and is now marked claimed.
        vm.warp(block.timestamp + EPOCH);
        assertEq(d.claim(1, 1), 10e18, "pet 1 takes its epoch 1 pool");
        assertEq(c.balanceOf(tbaA), 10e18);

        // The (late) rollForward of dead epoch 0 now credits the LIVE epoch (2), NOT the finished,
        // already-claimed epoch 1. The donation is rescued into a still-claimable epoch.
        assertEq(d.epochNow(), 2, "live epoch is 2");
        d.rollForward(0);
        assertEq(d.epochPool(0), 0, "epoch 0 drained");
        assertEq(d.epochPool(1), 10e18, "settled epoch 1 untouched (no strand piled on)");
        assertEq(d.epochPool(2), 100e18, "donation rolled into the LIVE epoch");

        // A pet caring in epoch 2 earns a point and can then claim the rescued donation.
        _notify(d, 2, tbaB, 0); // recognizes 0 new funds, adds a point in epoch 2
        vm.warp(block.timestamp + EPOCH); // finish epoch 2
        assertEq(d.claim(2, 2), 100e18, "rescued donation is claimable, not stranded");
        assertEq(c.balanceOf(tbaB), 100e18, "donation reaches a real claimant");
        assertEq(c.balanceOf(address(d)), 0, "nothing stranded in the distributor");
        assertEq(d.accounted(), 0, "all funds paid out");
    }

    /// The fix also removes the mid-settlement pro-rata break: a roll no longer mutates a finished
    /// pointed epoch's pool, so two pets with the SAME one point claim the SAME amount regardless of
    /// claim ordering. The donation lands in the live epoch instead.
    function test_H_RollForwardDoesNotBreakProRataMidSettlement() public {
        (RewardsDistributor d, MockCareToken c) = _freshDist();
        address tbaA = makeAddr("tbaFairA");
        address tbaB = makeAddr("tbaFairB");

        // Epoch 0: donation 100e18 synced into a point less epoch.
        c.mint(address(d), 100e18);
        d.sync();

        // Epoch 1: pets A and B each care once => one point each, pool 50e18.
        vm.warp(block.timestamp + EPOCH);
        c.mint(address(d), 50e18);
        _notify(d, 1, tbaA, 50e18); // first notify recognizes the 50e18
        _notify(d, 2, tbaB, 0);
        assertEq(d.totalPoints(1), 2);
        assertEq(d.epochPool(1), 50e18);

        // Epoch 2: settle. A claims first.
        vm.warp(block.timestamp + EPOCH);
        uint256 payA = d.claim(1, 1);
        assertEq(payA, 25e18, "A claims 1/2 of 50e18");

        // A late rollForward now credits the LIVE epoch (2), NOT the finished epoch 1 mid-settlement.
        d.rollForward(0);
        assertEq(d.epochPool(1), 50e18, "finished epoch 1 pool is NOT mutated mid settlement");
        assertEq(d.epochPool(2), 100e18, "donation rolled into the live epoch instead");

        // B, with the identical single point, claims the SAME amount as A. No ordering advantage.
        uint256 payB = d.claim(1, 2);
        assertEq(payB, 25e18, "B claims 1/2 of 50e18 for the same one point");
        assertEq(payA, payB, "identical activity, identical payout");

        // The donation is not stranded: it sits in the live epoch, claimable by epoch-2 carers.
        assertEq(c.balanceOf(address(d)), 100e18, "only the rolled donation remains, still claimable");
        assertEq(d.accounted(), 100e18);
    }
}

// ================================================================================================
// FINDING 3 (LOW): donation epoch attribution is controlled by whoever triggers recognition first.
// ================================================================================================

contract AuditEconV3_DonationTiming is AuditBase {
    /// A direct transfer to the distributor is NOT bound to the epoch in which it arrives; it is booked
    /// into whatever epoch first calls sync()/notifyCare. An attacker who is the sole carer in the next
    /// epoch sweeps the whole donation into an epoch where it owns 100% of the points, capturing money
    /// it did not fund. There is no "fair" distribution of a donation to assume.
    function test_M_DonationEpochAttributionIsTimingControlled() public {
        (RewardsDistributor d, MockCareToken c) = _freshDist();
        address tbaAtk = makeAddr("tbaAtk");

        // Epoch 0: a benefactor sends 100e18 DIRECTLY (no sync, no care): unrecognized.
        c.mint(address(d), 100e18);
        assertEq(d.epochPool(0), 0, "donation not yet attributed to any epoch");

        // Epoch 1: the attacker is the sole carer; the first care recognizes the whole donation into
        // epoch 1, where the attacker holds every point.
        vm.warp(block.timestamp + EPOCH);
        _notify(d, 1, tbaAtk, 0);
        assertEq(d.epochPool(1), 100e18, "epoch 0 donation captured by the epoch 1 sole carer");
        assertEq(d.totalPoints(1), 1);

        vm.warp(block.timestamp + EPOCH);
        d.claim(1, 1);
        assertEq(c.balanceOf(tbaAtk), 100e18, "attacker pockets a donation it did not fund");
    }
}

// ================================================================================================
// FINDING 4 (INFO): vault.totalRewards() is nominal-sent, not funds actually distributed.
// ================================================================================================

contract AuditEconV3_VaultCounters is AuditBase {
    /// The vault increments totalRewards by the NOMINAL slice it sends. Under a taxed care token the
    /// distributor books only the taxed delta, so any surface that reads totalRewards as "rewards
    /// distributed" overstates the pool that players can actually claim. Documented as "raw units SENT",
    /// so this is a labeling hazard rather than a fund bug, but it is a real accounting divergence.
    function test_M_VaultTotalRewardsOverstatesDistributorUnderFoT() public {
        PonsCareToken care = new PonsCareToken(address(this), FLOAT);
        Stack memory s = _stack(IERC20(address(care)), POT_BPS, REWARDS_BPS, CARE_COST);
        care.setTax(500, address(this)); // 5% transfer tax
        care.setTaxExempt(address(s.issuer), true); // clean seeding
        care.transfer(address(s.issuer), FLOAT / 2);

        (uint256 id,) = _issue(s, player);
        _issue(s, makeAddr("p2counters")); // keep minPlayers happy

        vm.warp(block.timestamp + CARE_COOLDOWN);
        uint256 distBefore = care.balanceOf(address(s.dist));
        _care(s, id);
        uint256 recognized = care.balanceOf(address(s.dist)) - distBefore;

        assertEq(s.dist.epochPool(0), recognized, "distributor books the measured (taxed) receipt");
        assertGt(s.vault.totalRewards(), recognized, "vault counter overstates funds actually landed");
        assertGt(s.vault.totalRewards(), s.dist.epochPool(0), "nominal sent > distributable");
    }
}

// ================================================================================================
// RESILIENCE: things I attacked that did NOT break (explicitly, this matters).
// ================================================================================================

contract AuditEconV3_Resilience is AuditBase {
    /// claimMany with duplicate ids cannot double pay: the second _claim reverts AlreadyClaimed and the
    /// whole call reverts, so no payout leaks.
    function test_R_ClaimManyDuplicateIdsCannotDoublePay() public {
        (RewardsDistributor d, MockCareToken c) = _freshDist();
        address tba = makeAddr("tbaDup");
        c.mint(address(d), 30e18);
        _notify(d, 1, tba, 30e18);
        vm.warp(block.timestamp + EPOCH);

        uint256[] memory ids = new uint256[](2);
        ids[0] = 1;
        ids[1] = 1;
        vm.expectRevert(RewardsDistributor.AlreadyClaimed.selector);
        d.claimMany(0, ids);
        assertEq(c.balanceOf(tba), 0, "no payout: the whole claimMany reverted atomically");
    }

    /// A rollForward into the LIVE epoch is clean: accounted does NOT underflow and nothing is
    /// stranded. The rolled donation lands in the current epoch; a pet caring there earns a point and
    /// claims it alongside its own prior-epoch pool.
    function test_R_RollForwardIntoLiveEpochIsCleanNoUnderflow() public {
        (RewardsDistributor d, MockCareToken c) = _freshDist();
        address tbaA = makeAddr("tbaClean");

        // Epoch 0: donation 100e18 synced into a point less epoch.
        c.mint(address(d), 100e18);
        d.sync();

        // Epoch 1: pet A cares (pool 10e18, one point).
        vm.warp(block.timestamp + EPOCH);
        c.mint(address(d), 10e18);
        _notify(d, 1, tbaA, 10e18);

        // Epoch 2: roll epoch 0 into the LIVE epoch (2), then pet A cares again so it can claim it.
        vm.warp(block.timestamp + EPOCH);
        d.rollForward(0);
        assertEq(d.epochPool(2), 100e18, "donation lands in the live epoch");
        assertEq(d.epochPool(1), 10e18, "epoch 1 keeps only its own care pool");
        _notify(d, 1, tbaA, 0); // pet A earns a point in epoch 2 too

        vm.warp(block.timestamp + EPOCH); // finish epoch 2
        uint256 pay1 = d.claim(1, 1); // epoch 1 own pool
        uint256 pay2 = d.claim(2, 1); // rolled donation, now claimable
        assertEq(pay1, 10e18, "epoch 1 own pool");
        assertEq(pay2, 100e18, "rolled donation claimable in the live epoch");
        assertEq(c.balanceOf(tbaA), 110e18, "pet A collected both, nothing underflowed or stranded");
        assertEq(d.accounted(), 0, "fully paid out");
        assertEq(c.balanceOf(address(d)), 0, "nothing stranded");
    }

    /// Epoch boundary claim timing is exact: a pet's epoch is claimable the instant the next epoch
    /// begins, and not one second earlier. No off by one gives an early or double window.
    function test_R_EpochBoundaryClaimableExactlyAtRollover() public {
        (RewardsDistributor d, MockCareToken c) = _freshDist();
        address tba = makeAddr("tbaBoundary");
        uint256 start = block.timestamp;

        c.mint(address(d), 7e18);
        _notify(d, 1, tba, 7e18); // epoch 0

        vm.warp(start + EPOCH - 1); // last second of epoch 0
        assertEq(d.epochNow(), 0);
        vm.expectRevert(RewardsDistributor.EpochNotFinished.selector);
        d.claim(0, 1);

        vm.warp(start + EPOCH); // epoch 1 begins
        assertEq(d.epochNow(), 1);
        assertEq(d.claim(0, 1), 7e18, "claimable to the wei exactly at rollover");
    }

    /// FUZZ CAMPAIGN 1: single epoch pro rata conservation and dust bound across many pets, point
    /// distributions and pool sizes. The distributor never pays out more than the pool, each pet gets
    /// exactly floor(pool * pts / totalPoints), and the residue left behind is strictly below the total
    /// point count (bounded dust, never a leak).
    /// forge-config: default.fuzz.runs = 20000
    function testFuzz_ProRataConservationAndDustBound(
        uint256 poolSeed,
        uint256 p1,
        uint256 p2,
        uint256 p3,
        uint256 p4,
        uint256 p5
    ) public {
        (RewardsDistributor d, MockCareToken c) = _freshDist();
        uint256 pool = bound(poolSeed, 1, 1e30);

        uint256[5] memory pts;
        pts[0] = bound(p1, 0, 50);
        pts[1] = bound(p2, 0, 50);
        pts[2] = bound(p3, 0, 50);
        pts[3] = bound(p4, 0, 50);
        pts[4] = bound(p5, 0, 50);
        uint256 totalPts;
        for (uint256 i = 0; i < 5; i++) totalPts += pts[i];
        vm.assume(totalPts > 0);

        c.mint(address(d), pool);
        bool recognizedYet = false;
        address[5] memory tbas;
        for (uint256 i = 0; i < 5; i++) {
            tbas[i] = address(uint160(0xBEEF0000 + i + 1));
            for (uint256 j = 0; j < pts[i]; j++) {
                _notify(d, i + 1, tbas[i], recognizedYet ? 0 : pool);
                recognizedYet = true;
            }
        }
        assertEq(d.epochPool(0), pool, "whole pool recognized into epoch 0");
        assertEq(d.totalPoints(0), totalPts);

        vm.warp(block.timestamp + EPOCH);
        uint256 paidSum;
        for (uint256 i = 0; i < 5; i++) {
            if (pts[i] == 0) continue;
            uint256 expect = pool * pts[i] / totalPts;
            assertEq(d.claim(0, i + 1), expect, "exact floor pro rata");
            paidSum += expect;
        }
        assertLe(paidSum, pool, "never pays out more than the pool");
        uint256 dust = pool - paidSum;
        assertLt(dust, totalPts, "residual dust strictly below total points");
        assertEq(c.balanceOf(address(d)), dust, "only rounding dust remains in the contract");
        assertEq(d.accounted(), dust, "accounted matches the leftover dust");
    }
}

// ================================================================================================
// FUZZ CAMPAIGN 2 (stateful invariant): distributor conservation + solvency under an adversarial mix
// of care, direct donations, sync, rollForward, epoch warps and claims. Proves the ledger never mints
// or loses money (balance == minted - paid) and that recognized-but-unpaid funds are always backed by
// balance (balance >= accounted), EVEN in the presence of the stranding bug above (stranded funds stay
// IN the contract, so solvency holds while the money is nonetheless trapped).
// ================================================================================================

contract DistHandler is Test {
    RewardsDistributor public dist;
    MockCareToken public care;
    uint256 public gMinted; // total care ever minted into the distributor (care legs + donations)
    uint256 public gPaid; // total care ever paid out via claims
    uint256 internal immutable epochLen;

    constructor(RewardsDistributor d, MockCareToken c, uint256 epochLen_) {
        dist = d;
        care = c;
        epochLen = epochLen_;
    }

    function _acct(uint256 id) internal pure returns (address) {
        return address(uint160(0xCAFE0000 + (id % 6) + 1));
    }

    function care_(uint256 id, uint256 amt) public {
        id = bound(id, 1, 6);
        amt = bound(amt, 0, 1e24);
        care.mint(address(dist), amt);
        gMinted += amt;
        dist.notifyCare(id, _acct(id), amt); // handler is the wired vault
    }

    function donate(uint256 amt) public {
        amt = bound(amt, 0, 1e24);
        care.mint(address(dist), amt);
        gMinted += amt;
    }

    function sync_() public {
        dist.sync();
    }

    function roll(uint256 epoch) public {
        uint256 en = dist.epochNow();
        epoch = bound(epoch, 0, en);
        try dist.rollForward(epoch) {} catch {}
    }

    function warp_(uint256 dt) public {
        dt = bound(dt, 1, epochLen * 2);
        vm.warp(block.timestamp + dt);
    }

    function claim_(uint256 epochSeed, uint256 id) public {
        id = bound(id, 1, 6);
        uint256 en = dist.epochNow();
        if (en == 0) return;
        uint256 epoch = bound(epochSeed, 0, en - 1);
        try dist.claim(epoch, id) returns (uint256 pay) {
            gPaid += pay;
        } catch {}
    }
}

contract AuditEconV3_SolvencyInvariant is StdInvariant, Test {
    RewardsDistributor internal dist;
    MockCareToken internal care;
    DistHandler internal handler;
    address internal owner = makeAddr("invOwner");
    uint256 internal constant EPOCH = 1 days;

    function setUp() public {
        care = new MockCareToken();
        dist = new RewardsDistributor(owner, IERC20(address(care)), EPOCH);
        handler = new DistHandler(dist, care, EPOCH);
        vm.prank(owner);
        dist.setVault(address(handler));

        bytes4[] memory sel = new bytes4[](6);
        sel[0] = handler.care_.selector;
        sel[1] = handler.donate.selector;
        sel[2] = handler.sync_.selector;
        sel[3] = handler.roll.selector;
        sel[4] = handler.warp_.selector;
        sel[5] = handler.claim_.selector;
        targetSelector(FuzzSelector({addr: address(handler), selectors: sel}));
        targetContract(address(handler));
    }

    /// forge-config: default.invariant.runs = 300
    /// forge-config: default.invariant.depth = 250
    function invariant_ConservationAndSolvency() public view {
        uint256 bal = care.balanceOf(address(dist));
        // Conservation: only mints raise the balance and only claims lower it, so the balance is exactly
        // the difference. Any drift here would be minted or vanished money.
        assertEq(bal, handler.gMinted() - handler.gPaid(), "conservation: balance == minted - paid");
        // Solvency: recognized-but-unpaid funds are always fully backed by real balance.
        assertGe(bal, dist.accounted(), "solvency: balance >= accounted");
    }
}
