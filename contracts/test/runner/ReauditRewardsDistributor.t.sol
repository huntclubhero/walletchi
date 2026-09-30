// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

// ================================================================================================
// RE-AUDIT of the post-audit FIX DIFF to RewardsDistributor.sol (INTERFACE-walletchi-v3.md sec 7).
// Adversarial re-verification of each fix: (a) does it close its finding, (b) did it introduce a NEW
// bug. READ-ONLY on src/: every test here is a PoC or a proven-safe negative result. No src edits.
//
// Fixes under re-audit (RewardsDistributor only; the PetVault H-1/H-2 fixes are re-audited elsewhere):
//   L-A2  saturating _recognize  (bal > accounted ? bal - accounted : 0)
//   L-A3  nonReentrant on sync() + rollForward()  (claim/claimMany already guarded)
//   econ  rollForward credits epochNow() (the LIVE epoch) instead of epoch + 1
//   L-A1  setVault rejects an EOA (code.length == 0 => VaultNotContract)
// ================================================================================================

import {Test} from "forge-std/Test.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";

import {IERC6551Registry} from "erc6551/interfaces/IERC6551Registry.sol";

import {Pet721} from "../../src/runner/Pet721.sol";
import {PetIssuer} from "../../src/runner/PetIssuer.sol";
import {PetVault, IPetCareSpender} from "../../src/runner/PetVault.sol";
import {MockCareToken} from "../../src/runner/MockCareToken.sol";
import {PonsCareToken} from "../../src/runner/PonsCareToken.sol";
import {RewardsDistributor} from "../../src/runner/RewardsDistributor.sol";

import {RewardsBase, VaultStub} from "./RewardsV3.t.sol";

// ================================================================================================
// Attacker / adversarial tokens
// ================================================================================================

/// @dev A care token whose balance can be reduced OUT OF BAND (clawback / blacklist / rebase-down),
///      exactly the misbehavior the L-A2 saturating _recognize is meant to survive without bricking.
contract ClawbackToken is ERC20 {
    constructor() ERC20("Clawback", "CLAW") {}

    function mint(address to, uint256 amount) external {
        _mint(to, amount);
    }

    /// @notice Remove tokens from `from` without a transfer the contract initiated: models a token
    ///         admin clawback / blacklist burn that silently drops a holder's balance.
    function clawback(address from, uint256 amount) external {
        _burn(from, amount);
    }
}

/// @dev A pathological care token that OWNS a pet and, from inside the payout transfer of a
///      RewardsDistributor.claim(), reenters vault.care(itsPet). That care routes a fresh rewards
///      slice into the distributor and calls the UNGUARDED notifyCare hook -- the same corruption the
///      L-A3 guards close on sync()/rollForward(), but via the one sibling entrypoint that was NOT
///      guarded. Implements onERC721Received so it can hold the pet.
contract PetOwningReenterToken is ERC20 {
    PetVault public vault;
    uint256 public attackerPet;
    bool public armed;
    bool public reentered;

    constructor() ERC20("ReenterNotify", "RNOT") {}

    function mint(address to, uint256 amount) external {
        _mint(to, amount);
    }

    function onERC721Received(address, address, uint256, bytes calldata) external pure returns (bytes4) {
        return this.onERC721Received.selector;
    }

    function arm(PetVault vault_, uint256 attackerPet_) external {
        vault = vault_;
        attackerPet = attackerPet_;
        armed = true;
    }

    function transfer(address to, uint256 amount) public override returns (bool) {
        if (armed) {
            armed = false; // reenter exactly once (the outer claim payout), then behave normally
            reentered = true;
            vault.care(attackerPet, 0); // fresh vault.care during the claim payout -> notifyCare
        }
        return super.transfer(to, amount);
    }
}

/// @dev A care token that reenters rollForward() from inside a claim payout, to confirm the L-A3
///      guard blocks it (rollForward makes no external call itself; the guard defends the case where
///      it is reentered while claim holds the lock).
contract RollForwardReentrantToken is ERC20 {
    RewardsDistributor public dist;
    uint256 public rollEpoch;
    bool public armed;
    bool public reentered;
    bytes public lastRevert;

    constructor() ERC20("RollReenter", "RRE") {}

    function mint(address to, uint256 amount) external {
        _mint(to, amount);
    }

    function arm(RewardsDistributor dist_, uint256 rollEpoch_) external {
        dist = dist_;
        rollEpoch = rollEpoch_;
        armed = true;
    }

    function transfer(address to, uint256 amount) public override returns (bool) {
        if (armed) {
            armed = false;
            reentered = true;
            // try/catch so the OUTER claim completes: we capture the reentrant revert to prove the
            // guard fired, rather than reverting the whole claim (which would roll back this flag).
            try dist.rollForward(rollEpoch) {
                lastRevert = "";
            } catch (bytes memory err) {
                lastRevert = err;
            }
        }
        return super.transfer(to, amount);
    }
}

// ================================================================================================
// FIX L-A2: saturating _recognize
// ================================================================================================

contract Fix_LA2_SaturatingRecognize is RewardsBase {
    ClawbackToken internal claw;
    RewardsDistributor internal dist;
    address internal vaultStub = address(new VaultStub());

    function setUp() public override {
        super.setUp();
        claw = new ClawbackToken();
        dist = new RewardsDistributor(owner, IERC20(address(claw)), EPOCH);
        vm.prank(owner);
        dist.setVault(vaultStub);
    }

    function _notify(uint256 id, address acct, uint256 declared) internal {
        vm.prank(vaultStub);
        dist.notifyCare(id, acct, declared);
    }

    /// PROVES (fix closes finding): after an out-of-band balance drop below `accounted`, the next
    /// recognition returns 0 rather than underflow-reverting, so the REQUIRED notifyCare hook is not
    /// bricked. Under the OLD `bal - accounted` this notify would revert (arithmetic underflow),
    /// freezing care() for the entire game.
    function test_LA2_ClawbackDoesNotBrickNotify() public {
        claw.mint(address(dist), 100e18);
        _notify(1, makeAddr("t1"), 100e18);
        assertEq(dist.accounted(), 100e18);
        assertEq(dist.epochPool(0), 100e18);

        // Out-of-band clawback drops the balance below accounted (dist did not initiate this transfer).
        claw.clawback(address(dist), 60e18);
        assertEq(claw.balanceOf(address(dist)), 40e18);
        assertGt(dist.accounted(), claw.balanceOf(address(dist)), "clawback made it transiently insolvent");

        // The next care still records its point and does NOT revert (saturating recognize == 0).
        _notify(2, makeAddr("t2"), 0);
        assertEq(dist.points(0, 2), 1, "care not bricked: point still recorded");
        assertEq(dist.accounted(), 100e18, "accounted not lowered by a saturating recognize");
    }

    /// PROVES (no new bug): the under-credit from a saturation is bounded EXACTLY by the out-of-band
    /// drop, and recognition SELF-HEALS the instant balance climbs back above the stale `accounted`.
    /// The fix loses no more credit than the clawback removed; it does not silently drop legitimate
    /// inflows beyond the hole, and it never over-credits.
    function test_LA2_UnderCreditBoundedByClawback_AndSelfHeals() public {
        claw.mint(address(dist), 100e18);
        _notify(1, makeAddr("t1"), 100e18); // epochPool[0] = 100, accounted = 100
        claw.clawback(address(dist), 60e18); // bal 40, accounted 100 (hole = 60)

        uint256 poolBefore = dist.epochPool(0);

        // Inflow #1 of 30: bal 70, still < 100 => recognized 0 (goes to backfilling the hole).
        claw.mint(address(dist), 30e18);
        _notify(3, makeAddr("t3"), 0);
        assertEq(dist.epochPool(0), poolBefore, "inflow inside the hole is not newly credited");
        assertEq(dist.accounted(), 100e18, "accounted still stale (not yet recovered)");

        // Inflow #2 of 40: bal 110, now > 100 => recognizes exactly the 10 above the stale accounted.
        claw.mint(address(dist), 40e18);
        _notify(4, makeAddr("t4"), 0);
        assertEq(dist.epochPool(0), poolBefore + 10e18, "only the amount above the hole is credited");
        assertEq(dist.accounted(), 110e18, "accounted healed up to the real balance");
        assertEq(claw.balanceOf(address(dist)), dist.accounted(), "balanceOf == accounted after heal");

        // Total credited from the 70 of inflow == 10; the 60 unrecognized == the clawback. No more lost.
        uint256 totalInflow = 70e18;
        uint256 credited = dist.epochPool(0) - poolBefore; // == 10e18
        assertEq(totalInflow - credited, 60e18, "unrecognized inflow equals the out-of-band drop, no extra loss");
    }

    /// PROVES (no theft / no strand attack): a saturation cannot be leveraged to steal or mis-route a
    /// later legitimate inflow. Funds that arrive during the hole simply back the already-recognized
    /// pools; nobody can withdraw more than the real balance (the token's own transfer enforces it), so
    /// no attacker gains and no THIRD party's funds are captured.
    function test_LA2_NoAttackerGainFromSaturation() public {
        address tba1 = makeAddr("t1");
        claw.mint(address(dist), 100e18);
        _notify(1, tba1, 100e18);
        claw.clawback(address(dist), 60e18); // bal 40, accounted 100

        vm.warp(block.timestamp + EPOCH); // finish epoch 0

        // The epoch-0 claimant tries to claim the full 100 pool, but only 40 is really there: the
        // payout transfer reverts on insufficient balance. The clawback loss cannot be socialized into
        // a phantom overpayment, and accounted is not corrupted (claim reverts atomically).
        vm.expectRevert();
        dist.claim(0, 1);
        assertEq(dist.accounted(), 100e18, "accounted intact after the reverted over-claim");
        assertEq(claw.balanceOf(address(dist)), 40e18, "balance unchanged: no funds leaked");
    }

    /// PROVES (production model): with the real-shaped token (Pons: fixed supply, optional tax, NO
    /// clawback / rebase / callback), balanceOf >= accounted is preserved through a hostile mix of
    /// donations, syncs and claims. The saturating branch is UNREACHABLE for the production token, so
    /// the fix changes nothing in the honest model -- it only removes a brick under a misbehaving token.
    function test_LA2_ProductionTokenNeverSaturates() public {
        PonsCareToken pons = new PonsCareToken(address(this), FLOAT);
        RewardsDistributor d = new RewardsDistributor(owner, IERC20(address(pons)), EPOCH);
        vm.prank(owner);
        d.setVault(vaultStub);

        // Fund + a real care.
        pons.transfer(address(d), 50e18);
        vm.prank(vaultStub);
        d.notifyCare(1, makeAddr("pt1"), 50e18);
        assertLe(d.accounted(), pons.balanceOf(address(d)), "invariant holds after care");

        // Hostile donation + sync cannot lower the balance below accounted.
        pons.transfer(address(d), 25e18);
        d.sync();
        assertLe(d.accounted(), pons.balanceOf(address(d)), "invariant holds after donation + sync");

        // Claim drains balance and accounted by the SAME payout; the invariant still holds.
        vm.warp(block.timestamp + EPOCH);
        d.claim(0, 1);
        assertLe(d.accounted(), pons.balanceOf(address(d)), "invariant holds after claim");
    }
}

// ================================================================================================
// FIX L-A3: nonReentrant on sync() + rollForward()  --  and the RESIDUAL notifyCare gap
// ================================================================================================

contract Fix_LA3_ReentrancyGuards is RewardsBase {
    /// PROVES (guard added): rollForward() is now nonReentrant, so a care token reentering it from
    /// inside a claim payout reverts the whole claim atomically (companion to the existing sync() test).
    function test_LA3_RollForwardReentrancyGuarded() public {
        RollForwardReentrantToken evil = new RollForwardReentrantToken();
        RewardsDistributor d = new RewardsDistributor(owner, IERC20(address(evil)), EPOCH);
        address vaultStub = address(new VaultStub());
        vm.prank(owner);
        d.setVault(vaultStub);

        // Epoch 0: a claimable pool (pet 1, one point).
        evil.mint(address(d), 30e18);
        vm.prank(vaultStub);
        d.notifyCare(1, makeAddr("t1"), 30e18);

        // Epoch 1: a separate donated, point-less pool to be the rollForward source.
        vm.warp(block.timestamp + EPOCH);
        evil.mint(address(d), 10e18);
        d.sync(); // folds 10e18 into epoch 1 (no points)

        // Epoch 2: epoch 1 is finished + point-less, so rollForward(1) is now callable. Arm the token to
        // reenter rollForward(1) during the epoch-0 claim payout. The guard blocks the reentrant call.
        vm.warp(block.timestamp + EPOCH);
        evil.arm(d, 1);
        d.claim(0, 1);

        assertTrue(evil.reentered(), "token attempted the reentrant rollForward");
        assertEq(
            bytes4(evil.lastRevert()),
            ReentrancyGuard.ReentrancyGuardReentrantCall.selector,
            "reentrant rollForward blocked by the guard"
        );
        assertEq(d.epochPool(1), 10e18, "point-less epoch 1 pool NOT rolled (reentry blocked)");
        assertFalse(d.rolledForward(1), "epoch 1 never marked rolled (reentry blocked)");
        assertEq(evil.balanceOf(makeAddr("t1")), 30e18, "legit claim still paid exactly once");
        assertEq(d.accounted(), 10e18, "only epoch 1's unclaimed pool remains accounted");
    }

    /// RESOLVED (re-audit F, L-A3 completeness): the fix wave guarded sync() and rollForward() but not
    /// notifyCare(), the sibling function that also runs _recognize. A pathological care token that owns
    /// a careable pet could, from inside a claim payout, reenter vault.care() -> notifyCare() ->
    /// _recognize() and book the outgoing payout as a phantom inflow (the exact corruption the sync()
    /// guard closes). notifyCare is now nonReentrant too, so the reentered call reverts and the whole
    /// claim rolls back atomically. It is entered once per real care on the honest path (never nested),
    /// so the guard is side-effect free. This test now PROVES the attack is blocked with no corruption.
    function test_LA3_NotifyCareReentrancy_NowBlockedByGuard() public {
        PetOwningReenterToken evil = new PetOwningReenterToken();
        Stack memory s = _stack(IERC20(address(evil)), POT_BPS, REWARDS_BPS, CARE_COST);
        evil.mint(address(s.issuer), FLOAT);

        // Victim pet (honest player) and the attacker pet, OWNED BY THE TOKEN CONTRACT itself.
        (uint256 victimId, address victimTba) = _issue(s, player);
        (uint256 atkId,) = _issue(s, address(evil));
        assertEq(s.pet.ownerOf(atkId), address(evil), "token contract holds a careable pet");

        // Epoch 0: the victim cares once, funding a claimable reward pool it solely owns.
        vm.warp(block.timestamp + CARE_COOLDOWN);
        _care(s, victimId);
        uint256 rewardsShare = (CARE_COST * REWARDS_BPS) / BPS;
        assertEq(s.dist.epochPool(0), rewardsShare);
        assertEq(s.dist.accounted(), rewardsShare);

        // Finish epoch 0 (also clears the attacker pet's care cooldown).
        vm.warp(block.timestamp + EPOCH);
        uint256 liveEpoch = s.dist.epochNow();

        // Arm and trigger: claiming the victim's epoch-0 pool pays into victimTba via the malicious
        // token, whose transfer hook reenters vault.care(attackerPet) -> notifyCare during the payout.
        // notifyCare is now nonReentrant, and claim() holds the guard, so the reentered notifyCare
        // reverts, which reverts the reentered care, which reverts the payout transfer, which reverts
        // the WHOLE claim atomically (re-audit F: L-A3 completeness fix).
        evil.arm(s.vault, atkId);
        vm.expectRevert();
        s.dist.claim(0, victimId);

        // No corruption: the claim rolled back entirely. The invariant holds, the live epoch pool was
        // never inflated by a phantom payout, and the victim's epoch-0 pool is intact and still unclaimed.
        assertGe(evil.balanceOf(address(s.dist)), s.dist.accounted(), "balanceOf >= accounted PRESERVED");
        assertEq(s.dist.accounted(), rewardsShare, "accounted unchanged by the reverted attack");
        assertEq(s.dist.epochPool(liveEpoch), 0, "live epoch pool never inflated");
        assertEq(s.dist.epochPool(0), rewardsShare, "victim epoch-0 pool intact");
        assertEq(s.dist.claimed(0, victimId), false, "victim's claim not consumed by the reverted attack");
    }
}

// ================================================================================================
// FIX econ-Low: rollForward credits epochNow() (the LIVE epoch)
// ================================================================================================

contract Fix_Econ_RollForwardLiveEpoch is RewardsBase {
    RewardsDistributor internal dist;
    MockCareToken internal care;
    address internal vaultStub = address(new VaultStub());

    function setUp() public override {
        super.setUp();
        care = new MockCareToken();
        dist = new RewardsDistributor(owner, IERC20(address(care)), EPOCH);
        vm.prank(owner);
        dist.setVault(vaultStub);
    }

    function _notify(uint256 id, address acct, uint256 declared) internal {
        vm.prank(vaultStub);
        dist.notifyCare(id, acct, declared);
    }

    /// PROVES (no new bug): rollForward never targets its own source epoch, even when called at the
    /// exact instant the source epoch just finished. The destination epochNow() is strictly greater
    /// than the (required-finished) source, so amt is moved forward, never re-added in place.
    function test_Econ_NoSelfTargetAtEpochBoundary() public {
        uint256 start = block.timestamp;
        care.mint(address(dist), 40e18);
        dist.sync(); // epoch 0 pool, point-less

        // Warp to the FIRST second of epoch 1: epoch 0 is just-finished, epochNow() == 1.
        vm.warp(start + EPOCH);
        assertEq(dist.epochNow(), 1);
        dist.rollForward(0);
        assertEq(dist.epochPool(0), 0, "source drained, not re-added to itself");
        assertEq(dist.epochPool(1), 40e18, "moved to the live epoch (source+1 here), never self-targeted");
    }

    /// PROVES (no new bug): rollForward is a pure internal bucket move. It does NOT touch `accounted`
    /// (the funds were already recognized), and it does NOT touch the real balance, so balanceOf ==
    /// accounted is preserved across the roll. No value is minted or destroyed.
    function test_Econ_RollForwardConservesAccountedAndBalance() public {
        care.mint(address(dist), 40e18);
        dist.sync();
        uint256 accBefore = dist.accounted();
        uint256 balBefore = care.balanceOf(address(dist));

        vm.warp(block.timestamp + EPOCH);
        dist.rollForward(0);

        assertEq(dist.accounted(), accBefore, "accounted unchanged by a bucket move");
        assertEq(care.balanceOf(address(dist)), balBefore, "balance unchanged by a bucket move");
        assertEq(dist.accounted(), care.balanceOf(address(dist)), "balanceOf == accounted preserved");
    }

    /// PROVES (documented, intended -- NOT a new theft): a pet that joins the live epoch AFTER a
    /// donation is rolled into it claims a share of value it did not fund. This is the accepted
    /// "donations enrich whoever is active" semantics (same class as the pre-existing donation-timing
    /// LOW), and it conserves funds: total paid never exceeds what entered. No pet is over-paid beyond
    /// its pro-rata, and nothing is stranded.
    function test_Econ_LateJoinerClaimsRolledDonation_IntendedAndConservative() public {
        // Epoch 0: sponsor donation, point-less.
        care.mint(address(dist), 100e18);
        dist.sync();

        // Epoch 1: roll the donation into the live epoch, THEN two pets care (join late).
        vm.warp(block.timestamp + EPOCH);
        dist.rollForward(0);
        assertEq(dist.epochPool(1), 100e18, "donation now lives in the live epoch");
        address tbaA = makeAddr("lateA");
        address tbaB = makeAddr("lateB");
        _notify(1, tbaA, 0); // funded 0, but earns a point in the live epoch
        _notify(2, tbaB, 0);

        // Finish epoch 1: each late joiner takes half the rolled donation. Funds conserved, no strand.
        vm.warp(block.timestamp + EPOCH);
        uint256 payA = dist.claim(1, 1);
        uint256 payB = dist.claim(1, 2);
        assertEq(payA, 50e18);
        assertEq(payB, 50e18);
        assertEq(payA + payB, 100e18, "all rolled value distributed, nothing minted or stranded");
        assertEq(care.balanceOf(address(dist)), 0);
        assertEq(dist.accounted(), 0);
    }

    /// PROVES (idempotence): a source epoch can be rolled only once (rolledForward flag), so repeated
    /// calls cannot double-count the pool into the live epoch.
    function test_Econ_RepeatedRollCannotDoubleCount() public {
        care.mint(address(dist), 15e18);
        dist.sync();
        vm.warp(block.timestamp + EPOCH);
        dist.rollForward(0);
        vm.expectRevert(RewardsDistributor.NothingToRoll.selector);
        dist.rollForward(0);
    }
}

// ================================================================================================
// FIX L-A1: setVault rejects an EOA
// ================================================================================================

contract Fix_LA1_SetVaultContractCheck is RewardsBase {
    RewardsDistributor internal dist;

    function setUp() public override {
        super.setUp();
        MockCareToken care = new MockCareToken();
        dist = new RewardsDistributor(owner, IERC20(address(care)), EPOCH);
    }

    /// PROVES (fix closes finding): a plain EOA (no code) is rejected with VaultNotContract, and the
    /// slot stays open so the owner can still wire a correct contract vault afterwards. It does not
    /// consume the one-shot set.
    function test_LA1_RejectsEOA_SlotStaysOpen() public {
        vm.prank(owner);
        vm.expectRevert(RewardsDistributor.VaultNotContract.selector);
        dist.setVault(makeAddr("plainEOA"));
        assertEq(dist.vault(), address(0), "EOA not frozen in");

        // A real contract still wires cleanly (does not break the legit deploy path).
        address realVault = address(new VaultStub());
        vm.prank(owner);
        dist.setVault(realVault);
        assertEq(dist.vault(), realVault, "contract vault accepted");
    }

    /// PROVES (no new bug): the check is code.length-only, so it does not reject a legitimately-deployed
    /// vault, and it does not add any owner power beyond the existing one-shot freeze.
    function test_LA1_FreshDeployedVaultPasses() public {
        // A full-blown PetVault (has code) is the real production shape; confirm it is accepted.
        RewardsBase.Stack memory s = _stack(IERC20(address(new MockCareToken())), POT_BPS, REWARDS_BPS, CARE_COST);
        assertEq(s.dist.vault(), address(s.vault), "real PetVault wired without tripping the code check");
        assertGt(address(s.vault).code.length, 0, "vault has code");
    }
}
