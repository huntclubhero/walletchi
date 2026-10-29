// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

// ================================================================================================
// WALLETCHI economy v3 : INDEPENDENT ECONOMIC-ACCOUNTING AUDIT (value conservation lens).
//
// This file is READ-ONLY on production src: it only ADDS tests. It proves (passing tests) or
// disproves (labelled PoC tests) value-conservation properties of the three-leg care split
// (PetVault) and the RewardsDistributor pool. Every test name is prefixed by the class it targets.
//
// FINDING tests are clearly labelled `test_FINDING_*`: they PASS by asserting the anomalous end
// state, so `forge test` stays green while documenting the defect. Read the header comment on each.
// ================================================================================================

import {Test} from "forge-std/Test.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";

import {ERC6551Registry} from "erc6551/ERC6551Registry.sol";
import {IERC6551Registry} from "erc6551/interfaces/IERC6551Registry.sol";

import {WalletchiAccount} from "../../src/WalletchiAccount.sol";
import {Pet721} from "../../src/runner/Pet721.sol";
import {PetIssuer} from "../../src/runner/PetIssuer.sol";
import {PetVault, IPetCareSpender} from "../../src/runner/PetVault.sol";
import {MockCareToken} from "../../src/runner/MockCareToken.sol";
import {PonsCareToken} from "../../src/runner/PonsCareToken.sol";
import {RewardsDistributor} from "../../src/runner/RewardsDistributor.sol";

/// @dev Minimal contract used as a stand-in "vault" for direct-notifyCare unit tests (setVault now
///      requires a contract; L-A1 EOA-footgun guard).
contract VaultStub {}

abstract contract EconBase is Test {
    ERC6551Registry internal registry;
    WalletchiAccount internal accountImpl;

    address internal owner = makeAddr("owner");
    address internal relayer = makeAddr("relayer");
    address internal royalty = makeAddr("royalty");

    address internal constant BURN = 0x000000000000000000000000000000000000dEaD;

    uint256 internal constant BPS = 10_000;
    uint256 internal constant MAX_SUPPLY = 2000;
    uint256 internal constant STARTER = 100e18;
    uint256 internal constant LIFE_TTL = 30 days; // long: pets never lapse mid-test
    uint256 internal constant CARE_COST = 1e18;
    uint256 internal constant CARE_COOLDOWN = 1 hours;
    uint256 internal constant EPOCH = 1 days;
    uint256 internal constant FLOAT = 5_000_000e18;

    struct Stack {
        Pet721 pet;
        PetIssuer issuer;
        PetVault vault;
        RewardsDistributor dist;
    }

    function setUp() public virtual {
        registry = new ERC6551Registry();
        accountImpl = new WalletchiAccount();
    }

    /// @dev Full three-leg stack (rewards leg live) wired for `token`, split, careCost.
    function _stack(IERC20 token, uint256 potBps, uint256 rewardsBps, uint256 careCost)
        internal
        returns (Stack memory s)
    {
        s.pet = new Pet721("WALLETCHI", "WCHI", MAX_SUPPLY, owner, royalty, "");
        s.issuer = new PetIssuer(
            s.pet, IERC6551Registry(address(registry)), address(accountImpl),
            token, relayer, owner, careCost, careCost * 48, STARTER
        );
        s.dist = new RewardsDistributor(owner, token, EPOCH);
        PetVault.Params memory p = PetVault.Params({
            careToken: token,
            pet: s.pet,
            issuer: IPetCareSpender(address(s.issuer)),
            owner: owner,
            lifeTtl: LIFE_TTL,
            careCost: careCost,
            potBps: potBps,
            burnBps: BPS - potBps - rewardsBps,
            rewardsBps: rewardsBps,
            rewardsRecipient: address(s.dist),
            gasBps: 0,
            gasRecipient: address(0),
            abandonGrace: 90 days,
            minPlayers: 2,
            careCooldown: CARE_COOLDOWN,
            minSeasonDuration: LIFE_TTL,
            entryWindowSecs: LIFE_TTL
        , selloutStartsSeason: false});
        s.vault = new PetVault(p);
        vm.startPrank(owner);
        s.pet.setIssuer(address(s.issuer));
        s.issuer.setVault(address(s.vault));
        s.dist.setVault(address(s.vault));
        vm.stopPrank();
    }

    /// @dev Two-leg stack (rewards disabled), same careCost/potBps: the pre-v3 baseline for parity.
    function _twoLegStack(IERC20 token, uint256 potBps, uint256 careCost) internal returns (Stack memory s) {
        s.pet = new Pet721("WALLETCHI", "WCHI", MAX_SUPPLY, owner, royalty, "");
        s.issuer = new PetIssuer(
            s.pet, IERC6551Registry(address(registry)), address(accountImpl),
            token, relayer, owner, careCost, careCost * 48, STARTER
        );
        PetVault.Params memory p = PetVault.Params({
            careToken: token,
            pet: s.pet,
            issuer: IPetCareSpender(address(s.issuer)),
            owner: owner,
            lifeTtl: LIFE_TTL,
            careCost: careCost,
            potBps: potBps,
            burnBps: BPS - potBps,
            rewardsBps: 0,
            rewardsRecipient: address(0),
            gasBps: 0,
            gasRecipient: address(0),
            abandonGrace: 90 days,
            minPlayers: 2,
            careCooldown: CARE_COOLDOWN,
            minSeasonDuration: LIFE_TTL,
            entryWindowSecs: LIFE_TTL
        , selloutStartsSeason: false});
        s.vault = new PetVault(p);
        vm.startPrank(owner);
        s.pet.setIssuer(address(s.issuer));
        s.issuer.setVault(address(s.vault));
        vm.stopPrank();
    }

    function _issue(Stack memory s, address to) internal returns (uint256 id, address tba) {
        vm.prank(relayer);
        (id, tba) = s.issuer.issuePet(to);
    }

    /// @dev Care as the pet's CURRENT owner (owner-only since audit access-H-1). Not for
    ///      vm.expectRevert sites: the ownerOf staticcall would consume the expectation.
    function _care(Stack memory s, uint256 id) internal {
        vm.prank(s.pet.ownerOf(id));
        s.vault.care(id, 0);
    }
}

// ================================================================================================
// CLASS 1 + 4: split exactness / conservation / dust direction (plain + fee-on-transfer)
// ================================================================================================

contract SplitConservationTest is EconBase {
    struct Quad {
        uint256 received;
        uint256 potShare;
        uint256 rewardsRouted;
        uint256 burned;
    }

    /// @dev Care pet `id` once and measure the four on-chain movements from balances (no reliance on
    ///      the contract's own counters). Kept in a helper so the fuzz frame stays shallow (no viaIR).
    function _measureCare(Stack memory s, MockCareToken care, uint256 id) internal returns (Quad memory q) {
        address tba = s.issuer.accountOf(id);
        uint256 tbaBefore = care.balanceOf(tba);
        uint256 burnBefore = care.balanceOf(BURN);
        uint256 distBefore = care.balanceOf(address(s.dist));
        uint256 vaultBefore = care.balanceOf(address(s.vault));
        _care(s, id);
        q.received = tbaBefore - care.balanceOf(tba);
        q.potShare = care.balanceOf(address(s.vault)) - vaultBefore;
        q.rewardsRouted = care.balanceOf(address(s.dist)) - distBefore;
        q.burned = care.balanceOf(BURN) - burnBefore;
    }

    /// Every wei pulled is accounted: pot(kept) + rewards(routed) + burn(sent) == received, dust to
    /// burn, and NO wei created. Fuzzed over the whole valid (potBps, rewardsBps, careCost) space on
    /// a plain token. Independent re-derivation of the invariant from measured balances.
    function testFuzz_Conservation_Plain(uint256 potF, uint256 rewF, uint256 costF) public {
        uint256 potBps = bound(potF, 1, BPS - 2);
        uint256 rewardsBps = bound(rewF, 1, BPS - 1 - potBps);
        uint256 careCost = bound(costF, 1e15, 5e18);
        // honor the constructor dust guards so construction succeeds
        vm.assume(careCost * potBps >= BPS);
        vm.assume(careCost * rewardsBps >= BPS);

        MockCareToken care = new MockCareToken();
        Stack memory s = _stack(IERC20(address(care)), potBps, rewardsBps, careCost);
        care.mint(address(s.issuer), FLOAT);
        (uint256 id,) = _issue(s, makeAddr("p1"));
        _issue(s, makeAddr("p2"));
        vm.warp(block.timestamp + CARE_COOLDOWN);

        Quad memory q = _measureCare(s, care, id);

        // Conservation: what left the TBA equals what landed in the three sinks. No mint, no leak.
        assertEq(q.potShare + q.rewardsRouted + q.burned, q.received, "pot+rewards+burn == received");
        // The vault's own counters agree with the on-chain movement.
        assertEq(s.vault.pot(), q.potShare, "pot counter == kept");
        assertEq(s.vault.totalRewards(), q.rewardsRouted, "rewards counter == routed (plain: no tax)");
        assertEq(s.vault.totalBurned(), q.burned, "burn counter == sent");
        // Dust falls to burn: burn == received - floor(pot) - floor(rewards).
        assertEq(q.burned, q.received - (q.received * potBps) / BPS - (q.received * rewardsBps) / BPS, "dust->burn");
    }

    /// Same conservation under the taxed Pons care token. The vault splits the amount ACTUALLY
    /// received (post pull-tax); the burn leg still swallows the dust; nothing is created.
    function testFuzz_Conservation_FeeOnTransfer(uint256 potF, uint256 rewF, uint256 taxF) public {
        uint256 potBps = bound(potF, 1, BPS - 2);
        uint256 rewardsBps = bound(rewF, 1, BPS - 1 - potBps);
        uint256 taxBps = bound(taxF, 1, 1000);

        PonsCareToken care = new PonsCareToken(address(this), FLOAT);
        Stack memory s = _stack(IERC20(address(care)), potBps, rewardsBps, CARE_COST);
        care.setTax(uint96(taxBps), address(this));
        care.setTaxExempt(address(s.issuer), true);
        care.transfer(address(s.issuer), FLOAT / 2);
        (uint256 id,) = _issue(s, makeAddr("p1"));
        _issue(s, makeAddr("p2"));
        vm.warp(block.timestamp + CARE_COOLDOWN);

        uint256 potShareBefore = s.vault.pot();
        uint256 vaultBefore = care.balanceOf(address(s.vault));

        _care(s, id);

        uint256 potShare = s.vault.pot() - potShareBefore;
        uint256 rewardsNominal = s.vault.totalRewards();
        uint256 burnNominal = s.vault.totalBurned();
        uint256 received = potShare + rewardsNominal + burnNominal;

        // The three nominal legs partition `received` to the wei, dust to burn.
        assertEq((received * potBps) / BPS, potShare, "pot on received");
        assertEq((received * rewardsBps) / BPS, rewardsNominal, "rewards on received");
        assertEq(received - potShare - rewardsNominal, burnNominal, "burn = remainder");
        // The vault keeps EXACTLY the pot slice (rewards + burn left as transfers).
        assertEq(care.balanceOf(address(s.vault)) - vaultBefore, potShare, "vault holds exactly the pot");
        // Distributor booked only what it actually received (<= nominal because of the reward-hop tax).
        assertLe(s.dist.epochPool(0), rewardsNominal, "distributor books <= nominal (tax skims the hop)");
        assertEq(s.dist.epochPool(0), care.balanceOf(address(s.dist)), "epoch pool == measured balance");
    }

    /// A direct donation to the VAULT cannot inflate `received` or the pot: `care()` measures the
    /// pull as a balance DELTA, so pre-existing balance (a donation) is invisible to the split. The
    /// rewards leg does not change this. Guards against a fake-fee / self-donation pot inflation.
    function test_VaultDonationDoesNotInflatePotOrReceived() public {
        MockCareToken care = new MockCareToken();
        Stack memory s = _stack(IERC20(address(care)), 7000, 2000, CARE_COST);
        care.mint(address(s.issuer), FLOAT);
        (uint256 id,) = _issue(s, makeAddr("p1"));
        _issue(s, makeAddr("p2"));

        // Donate a large sum straight to the vault before the care.
        care.mint(address(s.vault), 1_000e18);
        uint256 potBefore = s.vault.pot();

        vm.warp(block.timestamp + CARE_COOLDOWN);
        _care(s, id);

        uint256 expectedPot = (CARE_COST * 7000) / BPS;
        assertEq(s.vault.pot() - potBefore, expectedPot, "pot grows only by the real pull's pot slice");
        assertEq(s.vault.totalRewards(), (CARE_COST * 2000) / BPS, "rewards slice unaffected by donation");
        // The 1000e18 donation is inert surplus (sweepable via the timelock), never counted as pot.
        assertGe(care.balanceOf(address(s.vault)), s.vault.pot(), "vault solvent for the pot");
    }

    /// Dust ALWAYS favors burn and is never negative (never a mint) across tiny careCosts near the
    /// constructor guard floor. burn == received - floor(pot) - floor(rewards) >= 0.
    function testFuzz_DustToBurnNeverMint(uint256 potF, uint256 rewF, uint256 costF) public {
        uint256 potBps = bound(potF, 1, BPS - 2);
        uint256 rewardsBps = bound(rewF, 1, BPS - 1 - potBps);
        uint256 burnBps = BPS - potBps - rewardsBps;
        uint256 careCost = bound(costF, 1, 3e18);
        vm.assume(careCost * potBps >= BPS);
        vm.assume(careCost * rewardsBps >= BPS);

        // Pure math re-derivation of the exact split the contract performs.
        uint256 potShare = (careCost * potBps) / BPS;
        uint256 rewardsShare = (careCost * rewardsBps) / BPS;
        uint256 burnShare = careCost - potShare - rewardsShare;

        assertEq(potShare + rewardsShare + burnShare, careCost, "exact partition");
        assertGe(burnShare, (careCost * burnBps) / BPS, "burn >= its floor share (absorbs dust upward)");
        // burnShare can never be < 0 (would revert in-contract); assert the algebraic guarantee holds.
        assertLe(potShare + rewardsShare, careCost, "floors never exceed the whole");
    }
}

// ================================================================================================
// CLASS 5: the rewards leg does NOT change the pot / settlement / winner payout vs the two-leg base
// ================================================================================================

contract PotSettlementParityTest is EconBase {
    /// Same potBps + careCost, plain token, identical care sequence: the three-leg pot and the
    /// two-leg pot are byte-equal after N cares, and the finalize() prize paid to the winner TBA is
    /// identical. Proves the rewards leg is orthogonal to the pot and to settlement.
    function test_RewardsLeg_DoesNotAlterPotOrWinnerPayout() public {
        uint256 potBps = 1000;

        MockCareToken careA = new MockCareToken();
        MockCareToken careB = new MockCareToken();
        Stack memory three = _stack(IERC20(address(careA)), potBps, 2000, CARE_COST); // 10/20/70
        Stack memory two = _twoLegStack(IERC20(address(careB)), potBps, CARE_COST); // 10/90
        careA.mint(address(three.issuer), FLOAT);
        careB.mint(address(two.issuer), FLOAT);

        (uint256 a1,) = _issue(three, makeAddr("a1"));
        (uint256 a2,) = _issue(three, makeAddr("a2"));
        (uint256 b1,) = _issue(two, makeAddr("b1"));
        (uint256 b2,) = _issue(two, makeAddr("b2"));

        // Identical care cadence on both stacks. FIVE NEEDS: a repeat single-action care no longer
        // lifts a pet's score (its min-need stays at the hatch), so the leader is decided by the
        // strictly-later HATCH: a1/b1 hatch first, a2/b2 one cooldown later and hold the seat.
        vm.warp(block.timestamp + CARE_COOLDOWN);
        _care(three, a1);
        _care(two, b1);
        vm.warp(block.timestamp + CARE_COOLDOWN);
        _care(three, a2);
        _care(two, b2);
        for (uint256 k = 0; k < 4; k++) {
            vm.warp(block.timestamp + CARE_COOLDOWN);
            _care(three, a1);
            _care(three, a2);
            _care(two, b1);
            _care(two, b2);
        }

        assertEq(three.vault.pot(), two.vault.pot(), "three-leg pot == two-leg pot for same potBps");
        assertEq(three.vault.pot(), (CARE_COST * potBps / BPS) * 10, "pot == potShare * cares");

        // a2 / b2 cared last on each stack => the standing leader on both. Warp a full life window
        // past the runner-up's last feed so every other pet lapses, then finalize (permissionless).
        assertEq(three.vault.leader(), a2, "a2 is the three-leg leader");
        assertEq(two.vault.leader(), b2, "b2 is the two-leg leader");
        vm.warp(block.timestamp + LIFE_TTL);
        assertTrue(three.vault.isOver(), "three-leg game over");
        assertTrue(two.vault.isOver(), "two-leg game over");

        address tbaThree = three.issuer.accountOf(a2);
        address tbaTwo = two.issuer.accountOf(b2);
        uint256 potThree = three.vault.pot();
        uint256 potTwo = two.vault.pot();
        uint256 threeTbaBefore = careA.balanceOf(tbaThree);
        uint256 twoTbaBefore = careB.balanceOf(tbaTwo);

        three.vault.finalize();
        two.vault.finalize();

        assertEq(careA.balanceOf(tbaThree) - threeTbaBefore, potThree, "three-leg winner paid whole pot");
        assertEq(careB.balanceOf(tbaTwo) - twoTbaBefore, potTwo, "two-leg winner paid whole pot");
        assertEq(potThree, potTwo, "identical prize regardless of rewards leg");
        assertEq(three.vault.pot(), 0, "pot drained");
        assertEq(two.vault.pot(), 0, "pot drained");
    }
}

// ================================================================================================
// CLASS 2 + 3: RewardsDistributor pool solvency, rounding, epoch/points integrity
// ================================================================================================

contract DistributorSolvencyTest is EconBase {
    /// The master solvency invariant, hammered with an adversarial random op stream:
    /// care(any pet) / donate+sync / advance epoch / claim / rollForward, in fuzzed order. After
    /// EVERY op, balanceOf(dist) >= accounted, and the balance covers the sum of ALL still-pending
    /// claims across every finished epoch and pet. i.e. the pool is never insolvent and total
    /// claimable never exceeds funds held.
    function testFuzz_PoolSolvencyInvariant(uint256 seed) public {
        MockCareToken care = new MockCareToken();
        Stack memory s = _stack(IERC20(address(care)), 7000, 2000, CARE_COST);
        care.mint(address(s.issuer), FLOAT);

        uint256[3] memory ids;
        (ids[0],) = _issue(s, makeAddr("s1"));
        (ids[1],) = _issue(s, makeAddr("s2"));
        (ids[2],) = _issue(s, makeAddr("s3"));

        RewardsDistributor dist = s.dist;

        for (uint256 i = 0; i < 24; i++) {
            uint256 op = uint256(keccak256(abi.encode(seed, i))) % 6;
            if (op == 0 || op == 1) {
                // care a pet (needs cooldown to have elapsed since its last care)
                vm.warp(block.timestamp + CARE_COOLDOWN);
                uint256 id = ids[op == 0 ? 0 : 1];
                _care(s, id);
            } else if (op == 2) {
                // direct donation then permissionless sync into the current epoch
                uint256 amt = (uint256(keccak256(abi.encode(seed, i, "d"))) % 50e18) + 1;
                care.mint(address(dist), amt);
                dist.sync();
            } else if (op == 3) {
                vm.warp(block.timestamp + EPOCH); // finish the current epoch
            } else if (op == 4) {
                // try to claim a finished epoch for a random pet
                uint256 e = uint256(keccak256(abi.encode(seed, i, "e"))) % 5;
                uint256 id = ids[uint256(keccak256(abi.encode(seed, i, "p"))) % 3];
                try dist.claim(e, id) {} catch {}
            } else {
                // try to roll a finished zero-point epoch forward
                uint256 e = uint256(keccak256(abi.encode(seed, i, "r"))) % 5;
                try dist.rollForward(e) {} catch {}
            }

            // INVARIANT 1: recognized funds never exceed funds held.
            assertGe(care.balanceOf(address(dist)), dist.accounted(), "balance >= accounted");
        }

        // INVARIANT 2: the balance held covers every still-pending claim in aggregate (no state where
        // the sum of what pets can still claim exceeds the token balance => never insolvent).
        uint256 nowEpoch = dist.epochNow();
        uint256 pending;
        for (uint256 e = 0; e < nowEpoch; e++) {
            for (uint256 k = 0; k < 3; k++) {
                pending += dist.pendingReward(e, ids[k]);
            }
        }
        assertGe(care.balanceOf(address(dist)), pending, "held balance covers all pending claims");
    }

    /// Rounding cannot let the sum of per-pet claims exceed an epoch pool, for any point distribution
    /// over many pets. Floor-division dust stays behind (favouring the pool, never over-paying).
    function testFuzz_ClaimsNeverExceedPool(uint256 poolF, uint256 nF, uint256 ptSeed) public {
        MockCareToken care = new MockCareToken();
        RewardsDistributor dist = new RewardsDistributor(owner, IERC20(address(care)), EPOCH);
        address vaultEOA = address(new VaultStub());
        vm.prank(owner);
        dist.setVault(vaultEOA);

        uint256 pool = bound(poolF, 1, 1_000_000e18);
        uint256 n = bound(nF, 1, 12);
        care.mint(address(dist), pool);

        // First notify recognizes the whole pool; subsequent notifies add points only.
        uint256 totalPts;
        for (uint256 k = 0; k < n; k++) {
            uint256 pts = (uint256(keccak256(abi.encode(ptSeed, k))) % 7) + 1; // 1..7
            for (uint256 j = 0; j < pts; j++) {
                vm.prank(vaultEOA);
                dist.notifyCare(k + 1, address(uint160(0x1000 + k)), (totalPts == 0 && j == 0) ? pool : 0);
            }
            totalPts += pts;
        }
        assertEq(dist.epochPool(0), pool, "whole donation recognized into epoch 0");
        assertEq(dist.totalPoints(0), totalPts);

        vm.warp(block.timestamp + EPOCH);
        uint256 paid;
        for (uint256 k = 0; k < n; k++) {
            paid += dist.claim(0, k + 1);
        }
        assertLe(paid, pool, "sum of claims never exceeds the epoch pool");
        assertEq(care.balanceOf(address(dist)), pool - paid, "only floor dust remains, nothing over-paid");
        assertEq(dist.accounted(), pool - paid, "accounted tracks the residual dust exactly");
    }

    /// Points integrity: a pet cannot double-claim, cannot claim an epoch it earned nothing in, and
    /// cannot claim points earned in epoch N against epoch M's pool.
    function test_PointsIntegrity_NoDoubleNoCrossEpoch() public {
        MockCareToken care = new MockCareToken();
        RewardsDistributor dist = new RewardsDistributor(owner, IERC20(address(care)), EPOCH);
        address vaultEOA = address(new VaultStub());
        vm.prank(owner);
        dist.setVault(vaultEOA);

        // epoch 0: pet 1 cares. epoch 1: pet 2 cares.
        care.mint(address(dist), 100e18);
        vm.prank(vaultEOA);
        dist.notifyCare(1, makeAddr("t1"), 100e18);
        vm.warp(block.timestamp + EPOCH);
        care.mint(address(dist), 40e18);
        vm.prank(vaultEOA);
        dist.notifyCare(2, makeAddr("t2"), 40e18);
        vm.warp(block.timestamp + EPOCH); // now epoch 2, both 0 and 1 finished

        // pet 1 claims epoch 0 once
        dist.claim(0, 1);
        vm.expectRevert(RewardsDistributor.AlreadyClaimed.selector);
        dist.claim(0, 1);

        // pet 1 has NO points in epoch 1 => cannot claim epoch 1's pool
        vm.expectRevert(RewardsDistributor.NoPoints.selector);
        dist.claim(1, 1);

        // pet 2 has no points in epoch 0 => cannot reach epoch 0's pool
        vm.expectRevert(RewardsDistributor.NoPoints.selector);
        dist.claim(0, 2);
    }

    /// rollForward can never DoS or over-pay a legitimate, care-funded (pointed) claim. With the fix,
    /// a roll now credits the LIVE epoch, so it never even touches a finished pointed epoch: each
    /// point-holder claims EXACTLY its own care-funded pro-rata, the claim never reverts for
    /// insolvency, and the summed payouts never exceed the pool. The rolled donation lands live.
    function test_RollForward_NeverDosesOrOverpaysPointedClaims() public {
        MockCareToken care = new MockCareToken();
        RewardsDistributor dist = new RewardsDistributor(owner, IERC20(address(care)), EPOCH);
        address vaultEOA = address(new VaultStub());
        vm.prank(owner);
        dist.setVault(vaultEOA);

        // Epoch 0: zero-point donation (roll fodder).
        care.mint(address(dist), 33e18);
        dist.sync();

        // Epoch 1: two pets care (pet1 x1, pet2 x2) => a real pooled epoch with 3 points.
        vm.warp(block.timestamp + EPOCH);
        care.mint(address(dist), 9e18);
        vm.prank(vaultEOA);
        dist.notifyCare(1, makeAddr("h1"), 9e18);
        vm.prank(vaultEOA);
        dist.notifyCare(2, makeAddr("h2"), 0);
        vm.prank(vaultEOA);
        dist.notifyCare(2, makeAddr("h2"), 0);

        // Finish both epochs, then roll epoch 0. The donation now lands in the LIVE epoch, NOT the
        // finished pointed epoch 1, so epoch 1's holders are unaffected by the roll.
        vm.warp(block.timestamp + EPOCH);
        dist.rollForward(0);
        uint256 pool = dist.epochPool(1); // just its own 9e18 care pool, untouched by the roll
        assertEq(pool, 9e18, "pointed epoch 1 pool unchanged by the roll");
        assertEq(dist.epochPool(dist.epochNow()), 33e18, "donation parked in the live epoch");

        // Both holders claim; each gets exactly pool*pts/tp; the claim path stays solvent throughout.
        uint256 p1 = dist.claim(1, 1);
        assertGe(care.balanceOf(address(dist)), dist.accounted(), "solvent after first claim");
        uint256 p2 = dist.claim(1, 2);
        assertEq(p1, pool * 1 / 3, "pet1 exact pro-rata of its own epoch pool");
        assertEq(p2, pool * 2 / 3, "pet2 exact pro-rata of its own epoch pool");
        assertLe(p1 + p2, pool, "summed payouts never exceed the pool");
        assertGe(care.balanceOf(address(dist)), dist.accounted(), "still solvent after full claim");
    }

    /// Points can only be minted by the vault. No care => no point => no reward. A stranger cannot
    /// forge participation.
    function test_PointsIntegrity_OnlyVaultMintsPoints() public {
        MockCareToken care = new MockCareToken();
        RewardsDistributor dist = new RewardsDistributor(owner, IERC20(address(care)), EPOCH);
        VaultStub stub = new VaultStub(); // deploy before the prank so the CREATE does not consume it
        vm.prank(owner);
        dist.setVault(address(stub));

        vm.expectRevert(RewardsDistributor.NotVault.selector);
        vm.prank(makeAddr("attacker"));
        dist.notifyCare(1, makeAddr("attackerTba"), 1e18);
        assertEq(dist.totalPoints(0), 0, "no phantom points");
    }

    /// claimMany with a duplicate id reverts the whole batch (no double-pay through the batch path).
    function test_PointsIntegrity_ClaimManyDuplicateReverts() public {
        MockCareToken care = new MockCareToken();
        RewardsDistributor dist = new RewardsDistributor(owner, IERC20(address(care)), EPOCH);
        address vaultEOA = address(new VaultStub());
        vm.prank(owner);
        dist.setVault(vaultEOA);

        care.mint(address(dist), 20e18);
        vm.prank(vaultEOA);
        dist.notifyCare(1, makeAddr("t1"), 20e18);
        vm.warp(block.timestamp + EPOCH);

        uint256[] memory ids = new uint256[](2);
        ids[0] = 1;
        ids[1] = 1; // duplicate
        vm.expectRevert(RewardsDistributor.AlreadyClaimed.selector);
        dist.claimMany(0, ids);
        // nothing paid: the batch reverted atomically
        assertEq(care.balanceOf(makeAddr("t1")), 0, "no payout from a reverted batch");
    }
}

// ================================================================================================
// FIXED (post-audit): rollForward now credits the LIVE epoch, not epoch+1, so a zero-point donation is
// ALWAYS rescued into a still-claimable epoch and can never strand. These tests, formerly PoCs that
// asserted the strand, now assert the fix. See RewardsDistributor.rollForward.
// ================================================================================================

contract RollForwardStrandingFinding is EconBase {
    /// FIX (was Low/Med strand): rollForward(epoch) now credits epochNow() (the live epoch), never
    /// epoch+1. Even when rolled LATE (after the intervening epoch was finished and fully claimed), the
    /// donation lands in the current, still-claimable epoch instead of a settled one, so it is never
    /// stranded. A pet caring in the live epoch can then collect it.
    function test_RollForwardIntoClaimedEpoch_RescuesDonationToLiveEpoch() public {
        MockCareToken care = new MockCareToken();
        RewardsDistributor dist = new RewardsDistributor(owner, IERC20(address(care)), EPOCH);
        address vaultEOA = address(new VaultStub());
        vm.prank(owner);
        dist.setVault(vaultEOA);

        // Epoch 0: a pure donation lands with NO care (zero points).
        uint256 donation = 40e18;
        care.mint(address(dist), donation);
        dist.sync();
        assertEq(dist.epochPool(0), donation);
        assertEq(dist.totalPoints(0), 0);

        // Epoch 1: pet 1 cares once => epoch 1 has a real, care-funded pool with one point-holder.
        vm.warp(block.timestamp + EPOCH);
        uint256 careReward = 10e18;
        care.mint(address(dist), careReward);
        vm.prank(vaultEOA);
        dist.notifyCare(1, makeAddr("t1"), careReward);
        assertEq(dist.epochPool(1), careReward);
        assertEq(dist.totalPoints(1), 1);

        // Epoch 2: both prior epochs finished. Pet 1 claims epoch 1 and gets exactly its pool.
        vm.warp(block.timestamp + EPOCH);
        uint256 paid = dist.claim(1, 1);
        assertEq(paid, careReward, "pet 1 claimed epoch 1's care-funded pool");
        assertTrue(dist.claimed(1, 1), "epoch 1 is now claimed out for its sole point-holder");

        // Roll the OLD zero-point epoch 0 forward. It now credits the LIVE epoch (2), NOT the finished,
        // already-claimed epoch 1: the donation is never piled onto a settled epoch.
        assertEq(dist.epochNow(), 2, "live epoch is 2");
        dist.rollForward(0);
        assertEq(dist.epochPool(0), 0, "epoch 0 emptied");
        assertEq(dist.epochPool(1), careReward, "settled epoch 1 untouched by the roll");
        assertEq(dist.epochPool(2), donation, "donation rescued into the LIVE epoch");

        // A pet caring in the live epoch earns a point and can then claim the rescued donation.
        vm.prank(vaultEOA);
        dist.notifyCare(2, makeAddr("t2"), 0); // recognizes 0 new funds, adds a point in epoch 2
        vm.warp(block.timestamp + EPOCH); // finish epoch 2
        uint256 rescued = dist.claim(2, 2);
        assertEq(rescued, donation, "rescued donation is claimable, not stranded");
        assertEq(care.balanceOf(makeAddr("t2")), donation, "donation reached a real claimant");
        assertEq(care.balanceOf(address(dist)), 0, "nothing stranded in the distributor");
        assertEq(dist.accounted(), 0, "all funds paid out");
    }

    /// FIX corollary: a roll is now safe no matter HOW late it happens. Rolling a very old zero-point
    /// epoch always credits the current live epoch (never a stale finished one), so the keeper no
    /// longer has to chain rolls one epoch at a time to avoid stranding.
    function test_RollForward_AnyLateRollLandsInLiveEpoch() public {
        MockCareToken care = new MockCareToken();
        RewardsDistributor dist = new RewardsDistributor(owner, IERC20(address(care)), EPOCH);
        address vaultEOA = address(new VaultStub());
        vm.prank(owner);
        dist.setVault(vaultEOA);

        // Epoch 0: zero-point donation.
        care.mint(address(dist), 30e18);
        dist.sync();

        // Epoch 1: a care happens (epoch 1 now has a point) and is later claimed out.
        vm.warp(block.timestamp + EPOCH);
        care.mint(address(dist), 5e18);
        vm.prank(vaultEOA);
        dist.notifyCare(9, makeAddr("t9"), 5e18);

        // Advance far so both are old finished epochs; settle epoch 1 first.
        vm.warp(block.timestamp + 3 * EPOCH);
        assertEq(dist.claim(1, 9), 5e18, "epoch 1 paid its own care pool");

        // A very late rollForward(0) credits the LIVE epoch, NOT the finished, already-claimed epoch 1.
        uint256 live = dist.epochNow();
        dist.rollForward(0);
        assertEq(dist.epochPool(1), 5e18, "settled epoch 1 untouched");
        assertEq(dist.epochPool(live), 30e18, "donation parked in the live epoch, still claimable");

        // A pet caring in the live epoch can claim the rescued donation.
        vm.prank(vaultEOA);
        dist.notifyCare(10, makeAddr("t10"), 0);
        vm.warp(block.timestamp + EPOCH);
        assertEq(dist.claim(live, 10), 30e18, "rescued donation reaches a real claimant");
    }
}
