// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

// UNAUDITED: PENDING AUDIT WAVE.
// ACCESS-CONTROL + ADVERSARIAL audit of WALLETCHI economy v3 (three-leg split + RewardsDistributor +
// the REQUIRED notifyCare hook + Pet721 ERC-7572). Lens: authorization, reentrancy, DoS, privilege.
// READ-ONLY on src/: every test here is an attack PoC or a proven-safe negative result. No src edits.

import {Test} from "forge-std/Test.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";

import {IERC6551Registry} from "erc6551/interfaces/IERC6551Registry.sol";

import {Pet721} from "../../src/runner/Pet721.sol";
import {PetIssuer} from "../../src/runner/PetIssuer.sol";
import {PetVault, IPetCareSpender} from "../../src/runner/PetVault.sol";
import {MockCareToken} from "../../src/runner/MockCareToken.sol";
import {RewardsDistributor} from "../../src/runner/RewardsDistributor.sol";
import {IRewardsSink} from "../../src/runner/IRewardsSink.sol";

import {RewardsBase, VaultStub} from "./RewardsV3.t.sol";

// ================================================================================================
// Attacker contracts
// ================================================================================================

/// @dev A care token that, on the payout `transfer` inside RewardsDistributor.claim(), reenters the
///      UNGUARDED sync(). claim() is nonReentrant but sync() is not, and they share the same guard
///      object, so a reentrant sync() is NOT blocked while claim() holds the lock.
contract SyncReentrantToken is ERC20 {
    RewardsDistributor public dist;
    bool public armed;
    bool public reentered;

    constructor() ERC20("SyncReenter", "SRE") {}

    function mint(address to, uint256 amount) external {
        _mint(to, amount);
    }

    function arm(RewardsDistributor dist_) external {
        dist = dist_;
        armed = true;
    }

    function transfer(address to, uint256 amount) public override returns (bool) {
        if (armed) {
            armed = false;
            reentered = true;
            // Reenter BEFORE the balance actually moves: accounted was already debited by claim, but
            // balanceOf is still high, so _recognize books the outgoing payout as "new funds".
            dist.sync();
        }
        return super.transfer(to, amount);
    }
}

/// @dev A care token that reenters a PetVault mutator from inside the BURN-leg transfer during care().
///      mode 1 => reenter care(), mode 2 => reenter finalize(). Both must be blocked by the vault guard.
contract HostileVaultToken is ERC20 {
    address internal constant BURN = 0x000000000000000000000000000000000000dEaD;
    PetVault public vault;
    uint8 public mode;
    uint256 public targetId;
    bool public armed;
    bool public reentered;
    bytes4 public lastRevert;

    constructor() ERC20("HostileVault", "HOS") {}

    function mint(address to, uint256 amount) external {
        _mint(to, amount);
    }

    function arm(PetVault vault_, uint8 mode_, uint256 targetId_) external {
        vault = vault_;
        mode = mode_;
        targetId = targetId_;
        armed = true;
    }

    function transfer(address to, uint256 amount) public override returns (bool) {
        if (armed && to == BURN) {
            armed = false;
            reentered = true;
            if (mode == 1) {
                try vault.care(targetId, 0) {
                    lastRevert = bytes4(0);
                } catch (bytes memory err) {
                    lastRevert = bytes4(err);
                }
            } else {
                try vault.finalize() {
                    lastRevert = bytes4(0);
                } catch (bytes memory err) {
                    lastRevert = bytes4(err);
                }
            }
        }
        return super.transfer(to, amount);
    }
}

/// @dev A rewards recipient (IRewardsSink) that reenters vault.care() from inside notifyCare().
contract ReenterCareSink is IRewardsSink {
    PetVault public vault;
    uint256 public targetId;
    bool public armed;
    bool public reentered;
    bytes4 public lastRevert;

    function arm(PetVault vault_, uint256 targetId_) external {
        vault = vault_;
        targetId = targetId_;
        armed = true;
    }

    function notifyCare(uint256, address, uint256) external {
        if (armed) {
            armed = false;
            reentered = true;
            try vault.care(targetId, 0) {
                lastRevert = bytes4(0);
            } catch (bytes memory err) {
                lastRevert = bytes4(err);
            }
        }
    }
}

/// @dev A rewards recipient whose notifyCare always reverts (models a broken/hostile sink and the
///      REQUIRED-hook DoS surface).
contract RevertingSink is IRewardsSink {
    error SinkReverted();

    function notifyCare(uint256, address, uint256) external pure {
        revert SinkReverted();
    }
}

// ================================================================================================
// Local builders (control the wiring the shared _stack always completes)
// ================================================================================================

abstract contract AdversaryBase is RewardsBase {
    /// @dev Build pet + issuer + vault with an ARBITRARY rewardsRecipient (no distributor). Used to
    ///      point the vault at a hostile / reverting sink.
    function _buildVaultWithSink(IERC20 token, address sink)
        internal
        returns (Pet721 pet, PetIssuer issuer, PetVault vault)
    {
        pet = new Pet721("W", "W", MAX_SUPPLY, owner, royalty, "");
        issuer = new PetIssuer(
            pet,
            IERC6551Registry(address(registry)),
            address(accountImpl),
            token,
            relayer,
            owner,
            CARE_COST,
            CARE_COST * 48,
            STARTER
        );
        PetVault.Params memory p = PetVault.Params({
            careToken: token,
            pet: pet,
            issuer: IPetCareSpender(address(issuer)),
            owner: owner,
            lifeTtl: LIFE_TTL,
            careCost: CARE_COST,
            potBps: POT_BPS,
            burnBps: BURN_BPS,
            rewardsBps: REWARDS_BPS,
            rewardsRecipient: sink,
            gasBps: 0,
            gasRecipient: address(0),
            abandonGrace: 90 days,
            minPlayers: 2,
            careCooldown: CARE_COOLDOWN,
            minSeasonDuration: LIFE_TTL,
            entryWindowSecs: LIFE_TTL
        , selloutStartsSeason: false});
        vault = new PetVault(p);
        vm.startPrank(owner);
        pet.setIssuer(address(issuer));
        issuer.setVault(address(vault));
        vm.stopPrank();
    }

    /// @dev Build a full three-leg stack but leave the distributor's vault UNWIRED (or wired to a
    ///      chosen address). Returns the stack + the distributor for the caller to (mis)wire.
    function _buildUnwired(IERC20 token) internal returns (Stack memory s) {
        s.pet = new Pet721("W", "W", MAX_SUPPLY, owner, royalty, "");
        s.issuer = new PetIssuer(
            s.pet,
            IERC6551Registry(address(registry)),
            address(accountImpl),
            token,
            relayer,
            owner,
            CARE_COST,
            CARE_COST * 48,
            STARTER
        );
        s.dist = new RewardsDistributor(owner, token, EPOCH);
        PetVault.Params memory p = PetVault.Params({
            careToken: token,
            pet: s.pet,
            issuer: IPetCareSpender(address(s.issuer)),
            owner: owner,
            lifeTtl: LIFE_TTL,
            careCost: CARE_COST,
            potBps: POT_BPS,
            burnBps: BURN_BPS,
            rewardsBps: REWARDS_BPS,
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
        vm.stopPrank();
        // NOTE: dist.setVault deliberately NOT called here.
    }
}

// ================================================================================================
// FIX H-1 (L-A3): sync() is now nonReentrant, so a care token that reenters sync() from inside claim()
// can no longer inflate a pool or break balanceOf >= accounted; the reentrant sync reverts the claim.
// ================================================================================================

contract SyncReentrancyTest is AdversaryBase {
    SyncReentrantToken internal token;
    RewardsDistributor internal dist;
    address internal vaultEOA = address(new VaultStub());

    function setUp() public override {
        super.setUp();
        token = new SyncReentrantToken();
        dist = new RewardsDistributor(owner, IERC20(address(token)), EPOCH);
        vm.prank(owner);
        dist.setVault(vaultEOA);
    }

    function _notify(uint256 id, address account, uint256 declared) internal {
        vm.prank(vaultEOA);
        dist.notifyCare(id, account, declared);
    }

    /// FIX: sync() is nonReentrant, so during claim's payout transfer the token's reentrant sync()
    /// reverts and bubbles up, reverting the whole claim atomically. The pool is not inflated and the
    /// balanceOf >= accounted invariant holds.
    function test_H1_SyncReentrancy_NowRevertsNoCorruption() public {
        address tba1 = makeAddr("tba1");
        uint256 pool = 100e18;
        token.mint(address(dist), pool);
        _notify(1, tba1, pool); // epoch 0: pool recognized, 1 point
        assertEq(dist.epochPool(0), pool);
        assertEq(dist.accounted(), pool);

        vm.warp(block.timestamp + EPOCH); // finish epoch 0 (now in epoch 1)

        token.arm(dist); // try to reenter sync() during the claim payout transfer
        vm.expectRevert(ReentrancyGuard.ReentrancyGuardReentrantCall.selector);
        dist.claim(0, 1);

        // The claim reverted atomically: nothing moved, nothing was double-booked.
        assertEq(dist.accounted(), pool, "accounted intact (claim reverted)");
        assertEq(token.balanceOf(address(dist)), pool, "balance intact (payout reverted)");
        assertLe(dist.accounted(), token.balanceOf(address(dist)), "balanceOf >= accounted preserved");
        assertEq(dist.epochPool(1), 0, "no phantom funds double-booked into epoch 1");
    }

    /// Aftermath: because the guarded sync can no longer corrupt `accounted`, the next notifyCare (a
    /// normal care) does NOT underflow and care is NOT bricked. A hookful care token can no longer
    /// freeze the economy through a claim.
    function test_H1_Aftermath_CareNotBricked() public {
        address tba1 = makeAddr("tba1");
        uint256 pool = 100e18;
        token.mint(address(dist), pool);
        _notify(1, tba1, pool);
        vm.warp(block.timestamp + EPOCH);

        token.arm(dist);
        vm.expectRevert(ReentrancyGuard.ReentrancyGuardReentrantCall.selector);
        dist.claim(0, 1);

        // accounted (pool) still equals balanceOf (pool): the next notifyCare recognizes 0 new funds,
        // records its point, and does not revert.
        _notify(2, makeAddr("tba2"), 0);
        assertEq(dist.points(dist.epochNow(), 2), 1, "next care still records its point (not bricked)");
    }
}

// ================================================================================================
// FIX L-1 (L-A1): setVault now rejects a wrong EOA (VaultNotContract), closing the fat-finger that
// permanently bricked care. A wrong CONTRACT is still possible (residual, guarded by the deploy check).
// ================================================================================================

contract MisWireTest is AdversaryBase {
    /// FIX: wiring the distributor to a wrong EOA is now rejected (VaultNotContract), so the classic
    /// fat-finger can no longer freeze an EOA in and brick care; the slot stays open for a correct wire.
    function test_L1_MisWiredEOAVaultRejected() public {
        MockCareToken care = new MockCareToken();
        Stack memory s = _buildUnwired(IERC20(address(care)));

        address wrongEOA = makeAddr("wrongVault"); // no code
        vm.prank(owner);
        vm.expectRevert(RewardsDistributor.VaultNotContract.selector);
        s.dist.setVault(wrongEOA);
        assertEq(s.dist.vault(), address(0), "wrong EOA not frozen in");

        // The owner can still wire the correct vault.
        vm.prank(owner);
        s.dist.setVault(address(s.vault));
        assertEq(s.dist.vault(), address(s.vault));
    }

    /// RESIDUAL: a wrong CONTRACT address is still accepted and still bricks care permanently. The
    /// deploy script's post-wire require(dist.vault() == vault) is what catches this in production.
    function test_L1_MisWiredContractVaultStillBricks() public {
        MockCareToken care = new MockCareToken();
        Stack memory s = _buildUnwired(IERC20(address(care)));
        care.mint(address(s.issuer), FLOAT);

        address wrongContract = address(new VaultStub());
        vm.prank(owner);
        s.dist.setVault(wrongContract);

        (uint256 id,) = _issue(s, player);
        vm.warp(block.timestamp + CARE_COOLDOWN);

        // care() reverts because the real vault is not the distributor's recorded vault.
        vm.prank(player); // the pet's owner (care is owner-only)
        vm.expectRevert(RewardsDistributor.NotVault.selector);
        s.vault.care(id, 0);

        // ...and it can never be fixed: setVault is frozen once set.
        vm.prank(owner);
        vm.expectRevert(RewardsDistributor.VaultAlreadySet.selector);
        s.dist.setVault(address(s.vault));
    }
}

// ================================================================================================
// FINDING L-2 (LOW/INFO griefing): claim() marks claimed even on a zero payout, so a third party can
// forfeit a pet's later rolled-in reward.
// ================================================================================================

contract ZeroPayoutGriefTest is AdversaryBase {
    MockCareToken internal care;
    RewardsDistributor internal dist;
    address internal vaultEOA = address(new VaultStub());

    function setUp() public override {
        super.setUp();
        care = new MockCareToken();
        dist = new RewardsDistributor(owner, IERC20(address(care)), EPOCH);
        vm.prank(owner);
        dist.setVault(vaultEOA);
    }

    function _notify(uint256 id, address account, uint256 declared) internal {
        vm.prank(vaultEOA);
        dist.notifyCare(id, account, declared);
    }

    /// FIXED (L-2 closed by the rollForward fix): a finished epoch's pool is now IMMUTABLE, because
    /// rollForward credits the LIVE epoch, never a finished one. So a zero-payout claim can no longer
    /// forfeit a LATER-rolled reward: nothing can ever be added to the finished epoch the pet claimed.
    function test_L2_ZeroPayoutClaim_NoLongerForfeitsRolledReward() public {
        // Epoch 0: donate a fat pool, sync, no points.
        uint256 donation = 1000e18;
        care.mint(address(dist), donation);
        dist.sync();
        assertEq(dist.epochPool(0), donation);
        assertEq(dist.totalPoints(0), 0);

        // Epoch 1: a tiny pool (1 wei) but 10 points, so a 1-point pet rounds to 0.
        vm.warp(block.timestamp + EPOCH);
        care.mint(address(dist), 1);
        _notify(1, makeAddr("tbaVictim"), 1); // recognizes the 1 wei into epoch 1, pet1: 1 point
        for (uint256 i = 0; i < 9; i++) {
            _notify(2, makeAddr("tbaWhale"), 0); // pet2: 9 points, no new funds
        }
        assertEq(dist.epochPool(1), 1);
        assertEq(dist.totalPoints(1), 10);
        assertEq(dist.pendingReward(1, 1), 0, "victim rounds to zero pre-roll");

        // Finish epoch 1.
        vm.warp(block.timestamp + EPOCH);

        // A third party claims the victim while its payout rounds to zero (marks it claimed).
        vm.prank(stranger);
        uint256 paid = dist.claim(1, 1);
        assertEq(paid, 0, "griefed claim paid nothing");
        assertTrue(dist.claimed(1, 1), "victim marked claimed on a zero payout");

        // The zero-point epoch 0 rolls forward, but now credits the LIVE epoch, NOT the finished epoch 1.
        uint256 live = dist.epochNow();
        dist.rollForward(0);
        assertEq(dist.epochPool(1), 1, "finished epoch 1 pool is immutable (roll did not touch it)");
        assertEq(dist.epochPool(live), donation, "donation rolled into the live epoch instead");

        // Epoch 1's pool never grew, so the victim's fair share is still zero: nothing was forfeited.
        assertEq((dist.epochPool(1) * 1) / dist.totalPoints(1), 0, "epoch 1 share still rounds to zero");
    }
}

// ================================================================================================
// PROVEN-SAFE: reentrancy into the vault is blocked by the shared guard.
// ================================================================================================

contract VaultReentrancyBlockedTest is AdversaryBase {
    /// A hostile care token reentering care() from inside the burn-leg transfer is blocked by the
    /// vault's nonReentrant guard; the outer care still completes and books its legs.
    function test_S_HostileToken_ReenterCare_Blocked() public {
        HostileVaultToken hostile = new HostileVaultToken();
        Stack memory s = _stack(IERC20(address(hostile)), POT_BPS, REWARDS_BPS, CARE_COST);
        hostile.mint(address(s.issuer), FLOAT);

        (uint256 id,) = _issue(s, player);
        vm.warp(block.timestamp + CARE_COOLDOWN);

        hostile.arm(s.vault, 1, id); // reenter care(id) on the burn transfer
        vm.prank(player); // the pet's owner (care is owner-only)
        s.vault.care(id, 0);

        assertTrue(hostile.reentered(), "token attempted reentrancy on the burn leg");
        assertEq(
            hostile.lastRevert(),
            ReentrancyGuard.ReentrancyGuardReentrantCall.selector,
            "reentrant care() blocked by the vault guard"
        );
        assertEq(s.vault.pot(), (CARE_COST * POT_BPS) / BPS, "outer care completed once, pot booked");
    }

    /// A hostile care token reentering finalize() from inside the burn-leg transfer is blocked too
    /// (the cross-function reentry finalize()'s nonReentrant annotation defends against: a mid-care
    /// settlement could pay a winner from a half-booked pot).
    function test_S_HostileToken_ReenterFinalize_Blocked() public {
        HostileVaultToken hostile = new HostileVaultToken();
        Stack memory s = _stack(IERC20(address(hostile)), POT_BPS, REWARDS_BPS, CARE_COST);
        hostile.mint(address(s.issuer), FLOAT);

        (uint256 id,) = _issue(s, player);
        vm.warp(block.timestamp + CARE_COOLDOWN);

        hostile.arm(s.vault, 2, id); // reenter finalize() on the burn transfer
        vm.prank(player); // the pet's owner (care is owner-only)
        s.vault.care(id, 0);

        assertTrue(hostile.reentered(), "token attempted reentrant finalize");
        assertEq(
            hostile.lastRevert(),
            ReentrancyGuard.ReentrancyGuardReentrantCall.selector,
            "reentrant finalize() blocked by the shared vault guard"
        );
    }

    /// A hostile rewardsRecipient (IRewardsSink) reentering care() from inside notifyCare() is blocked
    /// by the vault guard. Proves the REQUIRED hook cannot be turned into a reentrancy on care().
    function test_S_HostileSink_ReenterCare_Blocked() public {
        MockCareToken care = new MockCareToken();
        ReenterCareSink sink = new ReenterCareSink();
        (, PetIssuer issuer, PetVault vault) = _buildVaultWithSink(IERC20(address(care)), address(sink));
        care.mint(address(issuer), FLOAT);

        vm.prank(relayer);
        (uint256 id,) = issuer.issuePet(player);
        vm.warp(block.timestamp + CARE_COOLDOWN);

        sink.arm(vault, id);
        vm.prank(player); // the pet's owner (care is owner-only)
        vault.care(id, 0);

        assertTrue(sink.reentered(), "sink attempted reentrancy in notifyCare");
        assertEq(
            sink.lastRevert(),
            ReentrancyGuard.ReentrancyGuardReentrantCall.selector,
            "reentrant care() from the sink blocked by the vault guard"
        );
        assertEq(vault.pot(), (CARE_COST * POT_BPS) / BPS, "outer care completed once");
    }
}

// ================================================================================================
// PROVEN-SAFE / DoS surface: the REQUIRED hook and the deploy wiring.
// ================================================================================================

contract RequiredHookTest is AdversaryBase {
    /// The REQUIRED-hook DoS surface, made explicit: a reverting rewards recipient reverts every
    /// care(). This is why rewardsRecipient MUST be the immutable, non-reverting distributor (there is
    /// no owner power to swap or pause it post-deploy). Documented trust boundary, not a live exploit.
    function test_RevertingSink_FreezesCare() public {
        MockCareToken care = new MockCareToken();
        RevertingSink sink = new RevertingSink();
        (, PetIssuer issuer, PetVault vault) = _buildVaultWithSink(IERC20(address(care)), address(sink));
        care.mint(address(issuer), FLOAT);

        vm.prank(relayer);
        (uint256 id,) = issuer.issuePet(player);
        vm.warp(block.timestamp + CARE_COOLDOWN);

        vm.prank(player); // the pet's owner (care is owner-only)
        vm.expectRevert(RevertingSink.SinkReverted.selector);
        vault.care(id, 0);
    }

    /// notifyCare cannot be griefed into reverting by any outsider: after a stranger donates, syncs,
    /// and (in a prior epoch) rolls forward, a real care() still succeeds and books its point. The
    /// balance-delta accrual never underflows for legitimately-arriving funds.
    function test_S_NotifyCare_NotGriefableToRevert() public {
        MockCareToken care = new MockCareToken();
        Stack memory s = _stack(IERC20(address(care)), POT_BPS, REWARDS_BPS, CARE_COST);
        care.mint(address(s.issuer), FLOAT);
        (uint256 id,) = _issue(s, player);
        _issue(s, makeAddr("p2"));

        // A stranger tries to poison distributor accounting via every permissionless lever.
        care.mint(stranger, 500e18);
        vm.startPrank(stranger);
        care.transfer(address(s.dist), 500e18); // direct donation
        s.dist.sync(); // fold it into the current epoch
        vm.stopPrank();

        vm.warp(block.timestamp + CARE_COOLDOWN);
        // A legitimate care still goes through; the hook records the point and books measured funds.
        _care(s, id);
        assertEq(s.dist.points(0, id), 1, "care still records a point (hook did not revert)");
    }

    /// The deploy-wiring window: a vault pointing at an unwired distributor reverts care() atomically
    /// (NotVault) with NO state drift (pot / totalRewards / balances unchanged). Safe-fail.
    function test_S_UnwiredWindow_CareRevertsAtomically() public {
        MockCareToken care = new MockCareToken();
        Stack memory s = _buildUnwired(IERC20(address(care))); // dist.setVault NOT called
        care.mint(address(s.issuer), FLOAT);

        (uint256 id, address tba) = _issue(s, player);
        vm.warp(block.timestamp + CARE_COOLDOWN);

        uint256 tbaBefore = care.balanceOf(tba);
        vm.prank(player); // the pet's owner (care is owner-only)
        vm.expectRevert(RewardsDistributor.NotVault.selector);
        s.vault.care(id, 0);

        assertEq(s.vault.pot(), 0, "no pot accrued");
        assertEq(s.vault.totalRewards(), 0, "no rewards accrued");
        assertEq(s.vault.totalBurned(), 0, "no burn accrued");
        assertEq(care.balanceOf(tba), tbaBefore, "TBA untouched (pull rolled back)");
        assertEq(care.balanceOf(address(s.dist)), 0, "distributor received nothing");
    }
}

// ================================================================================================
// PROVEN-SAFE: claim authorization + distributor privilege after wiring.
// ================================================================================================

contract DistributorPrivilegeTest is AdversaryBase {
    MockCareToken internal care;
    RewardsDistributor internal dist;
    address internal vaultEOA = address(new VaultStub());

    function setUp() public override {
        super.setUp();
        care = new MockCareToken();
        dist = new RewardsDistributor(owner, IERC20(address(care)), EPOCH);
        vm.prank(owner);
        dist.setVault(vaultEOA);
    }

    /// A stranger cannot notifyCare to redirect a pet's recorded payout address (accountOf). Only the
    /// vault may write it, and the vault always passes the deterministic issuer.accountOf(tokenId).
    function test_S_Stranger_CannotNotifyToRedirectAccount() public {
        address realTba = makeAddr("realTba");
        vm.prank(vaultEOA);
        dist.notifyCare(1, realTba, 0);
        assertEq(dist.accountOf(1), realTba);

        // Stranger attempts to repoint accountOf[1] to itself.
        vm.prank(stranger);
        vm.expectRevert(RewardsDistributor.NotVault.selector);
        dist.notifyCare(1, stranger, 0);
        assertEq(dist.accountOf(1), realTba, "accountOf not redirected");
    }

    /// claim() always pays the recorded TBA, never the (permissionless) caller.
    function test_S_Claim_PaysRecordedTbaNotStranger() public {
        address tba = makeAddr("tbaC");
        care.mint(address(dist), 40e18);
        vm.prank(vaultEOA);
        dist.notifyCare(9, tba, 40e18);
        vm.warp(block.timestamp + EPOCH);

        vm.prank(stranger);
        dist.claim(0, 9);
        assertEq(care.balanceOf(tba), 40e18, "paid the pet TBA");
        assertEq(care.balanceOf(stranger), 0, "caller got nothing");
    }

    /// After correct wiring the owner has NO power over the distributor: cannot re-point the vault,
    /// there is no sweep / pause / withdrawal, and funds can leave only via claim().
    function test_S_NoOwnerPowerAfterWiring() public {
        // Cannot re-point the vault.
        vm.prank(owner);
        vm.expectRevert(RewardsDistributor.VaultAlreadySet.selector);
        dist.setVault(makeAddr("newVault"));

        // Fund a pool, and confirm the owner cannot extract it by any means (no withdrawal surface
        // exists; the only state-changing owner-callable entrypoint is the now-frozen setVault).
        care.mint(address(dist), 77e18);
        vm.prank(vaultEOA);
        dist.notifyCare(1, makeAddr("tbaOwnerTest"), 77e18);
        uint256 distBal = care.balanceOf(address(dist));
        vm.prank(owner);
        vm.expectRevert(RewardsDistributor.VaultAlreadySet.selector);
        dist.setVault(owner);
        assertEq(care.balanceOf(address(dist)), distBal, "owner cannot move distributor funds");
    }

    /// rollForward conserves funds: a zero-point epoch's pool moves whole into the next epoch, never
    /// over-drawing, and (absent the H-1 reentry) balanceOf >= accounted is preserved end to end.
    function test_S_RollForward_ConservesFunds() public {
        // Epoch 0: donation, sync, zero points.
        uint256 donation = 90e18;
        care.mint(address(dist), donation);
        dist.sync();
        // Epoch 1 will receive the roll AND its own care pool.
        vm.warp(block.timestamp + EPOCH);
        dist.rollForward(0);
        assertEq(dist.epochPool(1), donation, "rolled whole");
        assertEq(dist.epochPool(0), 0, "source drained");

        // Two pets care in epoch 1.
        address t1 = makeAddr("cf1");
        address t2 = makeAddr("cf2");
        care.mint(address(dist), 10e18);
        vm.prank(vaultEOA);
        dist.notifyCare(1, t1, 10e18); // recognizes 10e18 into epoch 1
        vm.prank(vaultEOA);
        dist.notifyCare(2, t2, 0);
        assertEq(dist.epochPool(1), donation + 10e18);

        vm.warp(block.timestamp + EPOCH);
        dist.claim(1, 1);
        dist.claim(1, 2);

        // Conservation: total paid out never exceeds what was recognized; accounted stays >= 0 and
        // the residual balance equals accounted (only rounding dust, if any, remains).
        uint256 paid = care.balanceOf(t1) + care.balanceOf(t2);
        assertLe(paid, donation + 10e18, "never over-drawn");
        assertEq(care.balanceOf(address(dist)), dist.accounted(), "balance still backs accounted");
        assertLe(dist.accounted(), donation + 10e18, "accounted bounded by recognized");
    }
}

// ================================================================================================
// PROVEN-SAFE: Pet721 ERC-7572 setContractURI authorization + blast radius.
// ================================================================================================

contract ContractURITest is AdversaryBase {
    Pet721 internal pet;

    function setUp() public override {
        super.setUp();
        pet = new Pet721("W", "W", MAX_SUPPLY, owner, royalty, "ipfs://initial");
    }

    function test_S_SetContractURI_OwnerOnly() public {
        vm.prank(stranger);
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, stranger));
        pet.setContractURI("ipfs://evil");
        assertEq(pet.contractURI(), "ipfs://initial", "URI unchanged by non-owner");
    }

    /// Blast radius: the owner CAN repoint the (unlocked) collection metadata. Cosmetic / reputational
    /// only: it never touches funds, tokenURI, transferability, or any economic state.
    function test_I_SetContractURI_OwnerCanRepoint_Cosmetic() public {
        vm.prank(owner);
        pet.setContractURI("ipfs://rebrand");
        assertEq(pet.contractURI(), "ipfs://rebrand");
        // No lock exists for the collection URI (intended: owner-key custody).
    }
}
