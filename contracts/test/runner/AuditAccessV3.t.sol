// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

// ================================================================================================
// ADVERSARIAL AUDIT: ACCESS CONTROL AND PRIVILEGE lens (WALLETCHI economy v3).
// UNAUDITED sources under test. This file ADDS attack tests only; it changes no src and no other
// test file. Each test either PROVES a guard holds (defense confirmed) or DEMONSTRATES a boundary
// (a hostile-owner power or a trusted-care-token dependency), so the report can cite a concrete proof.
// ================================================================================================

import {Test} from "forge-std/Test.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";

import {ERC6551Registry} from "erc6551/ERC6551Registry.sol";
import {IERC6551Registry} from "erc6551/interfaces/IERC6551Registry.sol";

import {WalletchiAccount} from "../../src/WalletchiAccount.sol";
import {Pet721} from "../../src/runner/Pet721.sol";
import {PetIssuer} from "../../src/runner/PetIssuer.sol";
import {PetVault, IPetCareSpender} from "../../src/runner/PetVault.sol";
import {MockCareToken} from "../../src/runner/MockCareToken.sol";
import {RewardsDistributor} from "../../src/runner/RewardsDistributor.sol";
import {IRewardsSink} from "../../src/runner/IRewardsSink.sol";

// ------------------------------------------------------------------------------------------------
// Adversary helper contracts
// ------------------------------------------------------------------------------------------------

/// @dev A minimal contract used as a stand-in "vault" for direct-notifyCare tests: setVault now
///      requires the vault to be a contract (L-A1 EOA-footgun guard).
contract VaultStub {}

/// @dev A care token whose balances can be reduced OUT OF BAND (clawback / blacklist / rebase-down),
///      i.e. without the holder initiating the transfer. A fixed-supply OZ or Pons token CANNOT do
///      this; this stand-in exists solely to probe the required-hook accounting dependency.
contract ClawbackCareToken is ERC20 {
    constructor() ERC20("Clawback Care", "CLAW") {}

    function mint(address to, uint256 amount) external {
        _mint(to, amount);
    }

    /// @notice Reduce `from`'s balance without its consent (models an admin clawback / blacklist zero).
    function clawback(address from, uint256 amount) external {
        _burn(from, amount);
    }
}

/// @dev Any contract the owner might (mistakenly or maliciously) wire as the distributor's vault. It
///      can drive notifyCare with a WHOLLY ARBITRARY account, proving the account is only as honest as
///      the wired vault.
contract HostileVault {
    function spoof(RewardsDistributor d, uint256 tokenId, address account, uint256 amount) external {
        d.notifyCare(tokenId, account, amount);
    }
}

/// @dev A care token that, during a claim payout transfer, reenters notifyCare from the token context.
///      Used to prove notifyCare's vault-gate cannot be bypassed via a payout callback.
contract ReenterNotifyToken is ERC20 {
    RewardsDistributor public dist;
    bool public armed;
    bool public reentered;
    bytes4 public lastRevert;

    constructor() ERC20("Reenter Notify", "RNTF") {}

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
            try dist.notifyCare(42, address(0xBEEF), 1) {
                lastRevert = bytes4(0);
            } catch (bytes memory err) {
                lastRevert = bytes4(err);
            }
        }
        return super.transfer(to, amount);
    }
}

/// @dev A care token that reenters the UNGUARDED sync() DURING a claim payout, BEFORE its own balance
///      is decremented (pre-transfer callback). A standard ERC-20 never calls back at all; this probes
///      whether sync()'s missing reentrancy guard lets a pathological token corrupt the pool accounting.
contract ReenterSyncToken is ERC20 {
    RewardsDistributor public dist;
    bool public armed;
    bool public reentered;

    constructor() ERC20("Reenter Sync", "RSYN") {}

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
            dist.sync(); // reenters BEFORE the balance below is moved
        }
        return super.transfer(to, amount);
    }
}

// ------------------------------------------------------------------------------------------------
// Shared harness (real registry + real WalletchiAccount impl, mirroring the deploy topology)
// ------------------------------------------------------------------------------------------------

abstract contract AccessBase is Test {
    ERC6551Registry internal registry;
    WalletchiAccount internal accountImpl;

    address internal owner = makeAddr("owner");
    address internal relayer = makeAddr("relayer");
    address internal player = makeAddr("player");
    address internal attacker = makeAddr("attacker");
    address internal royalty = makeAddr("royalty");

    address internal constant BURN = 0x000000000000000000000000000000000000dEaD;

    uint256 internal constant BPS = 10_000;
    uint256 internal constant MAX_SUPPLY = 2000;
    uint256 internal constant STARTER = 100e18;
    uint256 internal constant LIFE_TTL = 2 days;
    uint256 internal constant CARE_COST = 1e18;
    uint256 internal constant CARE_COOLDOWN = 1 hours;
    uint256 internal constant EPOCH = 1 days;
    uint256 internal constant FLOAT = 1_000_000e18;

    uint256 internal constant POT_BPS = 7000;
    uint256 internal constant REWARDS_BPS = 2000; // rewardsShare per care = 0.2e18
    uint256 internal constant REWARDS_PER_CARE = (CARE_COST * REWARDS_BPS) / BPS;

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

    /// @dev Build pet + issuer + distributor + vault and wire the pet/issuer side, but LEAVE the
    ///      distributor's vault UNSET so a test can decide what (if anything) to wire it to.
    function _build(IERC20 token) internal returns (Stack memory s) {
        s.pet = new Pet721("WALLETCHI", "WCHI", MAX_SUPPLY, owner, royalty, "");
        s.issuer = new PetIssuer(
            s.pet,
            IERC6551Registry(address(registry)),
            address(accountImpl),
            token,
            relayer,
            owner,
            CARE_COST, // perTxCap
            CARE_COST * 48, // dailyCap
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
            burnBps: BPS - POT_BPS - REWARDS_BPS,
            rewardsBps: REWARDS_BPS,
            rewardsRecipient: address(s.dist),
            gasBps: 0,
            gasRecipient: address(0),
            abandonGrace: 90 days,
            minPlayers: 2,
            careCooldown: CARE_COOLDOWN,
            minSeasonDuration: LIFE_TTL,
            entryWindowSecs: LIFE_TTL,
            selloutStartsSeason: false
        });
        s.vault = new PetVault(p);

        vm.startPrank(owner);
        s.pet.setIssuer(address(s.issuer));
        s.issuer.setVault(address(s.vault));
        vm.stopPrank();
    }

    function _wireDist(Stack memory s, address vault_) internal {
        vm.prank(owner);
        s.dist.setVault(vault_);
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
// A. setVault authorization + front-running
// ================================================================================================

contract SetVaultAccessTest is AccessBase {
    function test_SetVault_StrangerCannotFrontRun() public {
        MockCareToken care = new MockCareToken();
        Stack memory s = _build(IERC20(address(care)));
        // Before the owner wires it, an attacker tries to seize the vault slot with their own contract.
        HostileVault hv = new HostileVault();
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, attacker));
        vm.prank(attacker);
        s.dist.setVault(address(hv));
        // The slot is still open only to the owner.
        assertEq(s.dist.vault(), address(0), "vault stays unset until the owner acts");
    }

    function test_SetVault_FrozenAfterFirstSetEvenForOwner() public {
        MockCareToken care = new MockCareToken();
        Stack memory s = _build(IERC20(address(care)));
        _wireDist(s, address(s.vault));
        // A later owner (compromised key) cannot repoint the caller to a hostile vault.
        HostileVault hv = new HostileVault();
        vm.expectRevert(RewardsDistributor.VaultAlreadySet.selector);
        vm.prank(owner);
        s.dist.setVault(address(hv));
        assertEq(s.dist.vault(), address(s.vault), "vault permanently frozen to the first non-zero set");
    }

    function test_NotifyCare_NoFakeVaultBeforeWire() public {
        MockCareToken care = new MockCareToken();
        Stack memory s = _build(IERC20(address(care)));
        // vault is unset (address(0)); notifyCare is unreachable by ANY real sender (msg.sender != 0).
        care.mint(address(s.dist), 5e18);
        HostileVault hv = new HostileVault();
        vm.expectRevert(RewardsDistributor.NotVault.selector);
        hv.spoof(s.dist, 1, attacker, 5e18);
    }
}

// ================================================================================================
// B. notifyCare spoofing + "funds leave only to the recorded TBA"
// ================================================================================================

contract NotifyCareSpoofTest is AccessBase {
    function test_Stranger_CannotInjectArbitraryAccount() public {
        MockCareToken care = new MockCareToken();
        Stack memory s = _build(IERC20(address(care)));
        _wireDist(s, address(s.vault));
        // Attacker tries to record THEIR address as the payout target for a pet.
        vm.expectRevert(RewardsDistributor.NotVault.selector);
        vm.prank(attacker);
        s.dist.notifyCare(1, attacker, 1e18);
        assertEq(s.dist.accountOf(1), address(0), "no account recorded by a non-vault caller");
    }

    function test_HonestVault_AlwaysRecordsTheDeterministicTba() public {
        MockCareToken care = new MockCareToken();
        Stack memory s = _build(IERC20(address(care)));
        _wireDist(s, address(s.vault));
        care.mint(address(s.issuer), FLOAT);

        (uint256 id, address tba) = _issue(s, player);
        vm.warp(block.timestamp + CARE_COOLDOWN);
        _care(s, id);

        // The account the distributor booked is EXACTLY the registry-deterministic TBA, never anything
        // the caller could choose.
        assertEq(s.dist.accountOf(id), tba, "recorded account is the pet TBA");
        assertEq(s.dist.accountOf(id), s.issuer.accountOf(id), "== issuer.accountOf");

        vm.warp(block.timestamp + EPOCH);
        vm.prank(attacker); // permissionless claim, but funds still route to the pet
        s.dist.claim(0, id);
        assertEq(care.balanceOf(tba), STARTER - CARE_COST + REWARDS_PER_CARE, "reward paid into the TBA only");
        assertEq(care.balanceOf(attacker), 0, "claimer receives nothing");
    }
}

// ================================================================================================
// C. Hostile-owner boundary: a wired hostile vault vs the game-fund inflow
// ================================================================================================

contract HostileOwnerBoundaryTest is AccessBase {
    /// If the owner wires a HOSTILE vault, that vault can point a claim at an arbitrary address, and
    /// funds ALREADY present (e.g. a donation) can be drained there. This is the trust cost of setVault.
    function test_HostileVault_CanDrainPreexistingFundsToArbitraryAddress() public {
        MockCareToken care = new MockCareToken();
        Stack memory s = _build(IERC20(address(care)));
        HostileVault hv = new HostileVault();
        _wireDist(s, address(hv)); // owner (mistakenly / maliciously) wires the hostile contract

        // Funds sitting in the distributor (a donation, or anything sent before wiring).
        care.mint(address(s.dist), 40e18);
        // The hostile vault records an ARBITRARY account for a token and folds the donation into the epoch.
        hv.spoof(s.dist, 1, attacker, 0);
        assertEq(s.dist.epochPool(0), 40e18, "donation recognized into the epoch");
        assertEq(s.dist.accountOf(1), attacker, "arbitrary (non-TBA) account recorded by the hostile vault");

        vm.warp(block.timestamp + EPOCH);
        s.dist.claim(0, 1);
        assertEq(care.balanceOf(attacker), 40e18, "pre-existing funds drained to the attacker EOA");
    }

    /// The nuance that BOUNDS the above: wiring a hostile vault SEVERS the real inflow, because the real
    /// vault's care() reverts (its notifyCare no longer matches dist.vault). So a hostile vault cannot
    /// capture ONGOING game rewards; it can only misdirect whatever was already there, and it bricks play.
    function test_HostileVault_SeversRealGameInflow() public {
        MockCareToken care = new MockCareToken();
        Stack memory s = _build(IERC20(address(care)));
        HostileVault hv = new HostileVault();
        _wireDist(s, address(hv));
        care.mint(address(s.issuer), FLOAT);

        (uint256 id,) = _issue(s, player);
        vm.warp(block.timestamp + CARE_COOLDOWN);
        // The real vault's care() fires notifyCare on the distributor, whose vault is now the hostile
        // contract, so the honest care path itself reverts: no game funds ever flow to the distributor.
        vm.expectRevert(RewardsDistributor.NotVault.selector);
        vm.prank(player); // the pet's owner (care is owner-only)
        s.vault.care(id, 0);
    }

    /// After the honest wire + freeze, the distributor has ZERO remaining privileged surface: the owner
    /// cannot repoint, cannot sweep (no such function), cannot pause. It is effectively ownerless.
    function test_PostWire_DistributorIsTrustless() public {
        MockCareToken care = new MockCareToken();
        Stack memory s = _build(IERC20(address(care)));
        _wireDist(s, address(s.vault));
        // The single owner power is now frozen.
        vm.expectRevert(RewardsDistributor.VaultAlreadySet.selector);
        vm.prank(owner);
        s.dist.setVault(attacker);
        // There is no owner path that moves funds: fund a pool and confirm the owner cannot extract it.
        care.mint(address(s.dist), 10e18);
        vm.prank(owner);
        s.dist.sync(); // the only owner-callable state change here is permissionless anyway
        assertEq(care.balanceOf(owner), 0, "owner cannot pull distributor funds by any path");
    }
}

// ================================================================================================
// D. Once-frozen setVault with no validation: a wrong address permanently bricks care()
// ================================================================================================

contract WrongVaultBrickTest is AccessBase {
    /// FIX (L-A1): setVault now REJECTS a wrong EOA (VaultNotContract), so the classic fat-finger of
    /// freezing an EOA in and bricking care() forever can no longer happen; the slot stays open for a
    /// correct retry.
    function test_WrongEOAVault_RejectedBySetVault() public {
        MockCareToken care = new MockCareToken();
        Stack memory s = _build(IERC20(address(care)));
        address wrongEOA = makeAddr("wrongVault"); // has no code
        vm.expectRevert(RewardsDistributor.VaultNotContract.selector);
        vm.prank(owner);
        s.dist.setVault(wrongEOA);
        assertEq(s.dist.vault(), address(0), "wrong EOA not frozen in; slot stays open");
        // The owner can still wire the correct vault afterward.
        _wireDist(s, address(s.vault));
        assertEq(s.dist.vault(), address(s.vault), "correct vault wires cleanly");
    }

    /// RESIDUAL (documented): the EOA guard does NOT catch a wrong CONTRACT address. Freezing an
    /// unrelated contract in still bricks care() permanently with no on-chain recovery; the deploy
    /// script's post-wire require(dist.vault() == vault) is what guards this in production.
    function test_WrongContractVault_StillBricksCare_NoRecovery() public {
        MockCareToken care = new MockCareToken();
        Stack memory s = _build(IERC20(address(care)));
        address wrongContract = address(new VaultStub()); // a real contract, but not the paired vault
        _wireDist(s, wrongContract);
        care.mint(address(s.issuer), FLOAT);

        (uint256 id,) = _issue(s, player);
        vm.warp(block.timestamp + CARE_COOLDOWN);
        // Every care() reverts forever (the required hook rejects the real vault as not-the-vault).
        vm.expectRevert(RewardsDistributor.NotVault.selector);
        vm.prank(player); // the pet's owner (care is owner-only)
        s.vault.care(id, 0);
        // And there is NO recovery: setVault is frozen.
        vm.expectRevert(RewardsDistributor.VaultAlreadySet.selector);
        vm.prank(owner);
        s.dist.setVault(address(s.vault));
    }
}

// ================================================================================================
// E. Required-hook DoS: can distributor state brick care() forever?
// ================================================================================================

contract RequiredHookDoSTest is AccessBase {
    /// The honest, internal-only case: no sequence of cares/claims/syncs/rolls can push accounted above
    /// balance, so _recognize never underflows and care() is never self-bricked with a well-behaved token.
    function test_HonestToken_ManyCares_NeverBrick() public {
        MockCareToken care = new MockCareToken();
        Stack memory s = _build(IERC20(address(care)));
        _wireDist(s, address(s.vault));
        care.mint(address(s.issuer), FLOAT);

        (uint256 id,) = _issue(s, player);
        for (uint256 i = 0; i < 10; i++) {
            vm.warp(block.timestamp + CARE_COOLDOWN);
            _care(s, id); // never reverts
        }
        assertLe(s.dist.accounted(), care.balanceOf(address(s.dist)), "invariant: accounted <= balance");
    }

    /// FIX (L-A2, saturating _recognize): if a care token reduces the distributor's balance OUT OF BAND
    /// (clawback / blacklist / rebase-down) below `accounted`, _recognize now returns 0 instead of
    /// underflowing, so the REQUIRED hook does NOT revert and care() STILL SUCCEEDS for everyone. The
    /// core loop can no longer be bricked by an out-of-band balance drop.
    function test_OutOfBandBalanceDrop_DoesNotBrickCare() public {
        ClawbackCareToken care = new ClawbackCareToken();
        Stack memory s = _build(IERC20(address(care)));
        _wireDist(s, address(s.vault));
        care.mint(address(s.issuer), FLOAT);

        (uint256 id,) = _issue(s, player);
        // Accumulate several cares so `accounted` climbs to 3 * REWARDS_PER_CARE.
        for (uint256 i = 0; i < 3; i++) {
            vm.warp(block.timestamp + CARE_COOLDOWN);
            _care(s, id);
        }
        uint256 acc = s.dist.accounted();
        assertEq(acc, 3 * REWARDS_PER_CARE, "accounted after three cares");
        assertEq(care.balanceOf(address(s.dist)), acc, "balance tracks accounted");

        // Out-of-band: wipe the distributor's balance below `accounted`.
        care.clawback(address(s.dist), acc);
        assertLt(care.balanceOf(address(s.dist)), acc, "balance now below accounted");

        // The next care transfers only REWARDS_PER_CARE in, still far below `accounted`, but saturating
        // _recognize returns 0 rather than underflowing, so care() SUCCEEDS and still books its point.
        vm.warp(block.timestamp + CARE_COOLDOWN);
        _care(s, id); // no revert: the game loop keeps running

        // A second pet is equally unaffected: this is a whole-game survival, not a one-pet fluke.
        (uint256 id2,) = _issue(s, makeAddr("p2"));
        vm.warp(block.timestamp + CARE_COOLDOWN);
        _care(s, id2); // no revert
        assertEq(s.dist.points(s.dist.epochNow(), id2), 1, "second pet still records its care point");
    }
}

// ================================================================================================
// F. Reentrancy through the claim payout
// ================================================================================================

contract ClaimReentrancyTest is AccessBase {
    RewardsDistributor internal dist;
    address internal vaultEOA = address(new VaultStub());

    /// A payout-transfer callback cannot bypass notifyCare's vault gate: from the token context the
    /// caller is the token, not the vault, so the reentrant notifyCare reverts NotVault.
    function test_ClaimPayout_CannotReenterNotifyCare() public {
        ReenterNotifyToken evil = new ReenterNotifyToken();
        dist = new RewardsDistributor(owner, IERC20(address(evil)), EPOCH);
        vm.prank(owner);
        dist.setVault(vaultEOA);

        address tba = makeAddr("tbaN");
        evil.mint(address(dist), 20e18);
        vm.prank(vaultEOA);
        dist.notifyCare(1, tba, 20e18);
        vm.warp(block.timestamp + EPOCH);

        evil.arm(dist);
        dist.claim(0, 1);

        assertTrue(evil.reentered(), "token attempted the reentrant notifyCare");
        // notifyCare is now nonReentrant (re-audit L-A3 completeness fix), so the reentry trips the
        // ReentrancyGuard (the modifier fires before the NotVault body check) rather than NotVault.
        // Still rejected, harder, and the claim still pays exactly once.
        assertEq(
            evil.lastRevert(),
            bytes4(keccak256("ReentrancyGuardReentrantCall()")),
            "reentrant notifyCare blocked by the reentrancy guard"
        );
        assertEq(evil.balanceOf(tba), 20e18, "claim still paid exactly once to the TBA");
    }

    /// The plain-transfer recipient (a TBA) never gets a callback from an OZ ERC-20, so the guarded
    /// claim cannot be reentered by the honest token path. Documents that the ONLY reentrancy avenue is
    /// a pathological, actively-calling care token (out of the trusted-token model).
    function test_ClaimPayout_StandardTokenHasNoCallback() public {
        MockCareToken care = new MockCareToken();
        Stack memory s = _build(IERC20(address(care)));
        _wireDist(s, address(s.vault));
        care.mint(address(s.issuer), FLOAT);
        (uint256 id, address tba) = _issue(s, player);
        vm.warp(block.timestamp + CARE_COOLDOWN);
        _care(s, id);
        vm.warp(block.timestamp + EPOCH);
        s.dist.claim(0, id);
        assertEq(care.balanceOf(tba), STARTER - CARE_COST + REWARDS_PER_CARE, "single clean payout");
    }

    /// FIX (L-A3): sync() is now nonReentrant. A care token that reenters sync() during claim's payout
    /// transfer (pre-transfer callback) can no longer fold the still-present payout back into the pool:
    /// the reentrant sync reverts and bubbles up, reverting the whole claim atomically. No corruption,
    /// and the balanceOf >= accounted invariant is preserved.
    function test_UnguardedSync_ReentrancyNowRevertsNoCorruption() public {
        ReenterSyncToken evil = new ReenterSyncToken();
        dist = new RewardsDistributor(owner, IERC20(address(evil)), EPOCH);
        vm.prank(owner);
        dist.setVault(vaultEOA);

        address tba = makeAddr("tbaS");
        evil.mint(address(dist), 30e18);
        vm.prank(vaultEOA);
        dist.notifyCare(1, tba, 30e18); // sole claimant of a 30e18 pool
        vm.warp(block.timestamp + EPOCH);

        evil.arm(dist);
        // The reentrant sync() during the payout reverts (nonReentrant), bubbling up to revert the claim.
        vm.expectRevert(ReentrancyGuard.ReentrancyGuardReentrantCall.selector);
        dist.claim(0, 1);

        // The claim reverted atomically: state is exactly as before, invariant intact, no phantom funds.
        assertEq(dist.accounted(), 30e18, "accounted unchanged (claim reverted)");
        assertEq(evil.balanceOf(address(dist)), 30e18, "balance unchanged (payout reverted)");
        assertLe(dist.accounted(), evil.balanceOf(address(dist)), "balanceOf >= accounted preserved");
        assertEq(dist.epochPool(1), 0, "no phantom funds recognized into the next epoch");
    }
}

// ================================================================================================
// G. claimMany double-spend + H. rollForward griefing
// ================================================================================================

contract ClaimManyAndRollTest is AccessBase {
    RewardsDistributor internal dist;
    address internal vaultEOA = address(new VaultStub());
    MockCareToken internal care;

    function setUp() public override {
        super.setUp();
        care = new MockCareToken();
        dist = new RewardsDistributor(owner, IERC20(address(care)), EPOCH);
        vm.prank(owner);
        dist.setVault(vaultEOA);
    }

    function _notify(uint256 tokenId, address account, uint256 declared) internal {
        vm.prank(vaultEOA);
        dist.notifyCare(tokenId, account, declared);
    }

    function test_ClaimMany_DuplicateTokenIdCannotDoublePay() public {
        address tba = makeAddr("dup");
        care.mint(address(dist), 100e18);
        _notify(1, tba, 100e18);
        vm.warp(block.timestamp + EPOCH);

        uint256[] memory ids = new uint256[](2);
        ids[0] = 1;
        ids[1] = 1; // same pet twice in one call
        vm.expectRevert(RewardsDistributor.AlreadyClaimed.selector);
        dist.claimMany(0, ids);
        assertEq(care.balanceOf(tba), 0, "no payout: the whole duplicate claim reverts");
    }

    function test_RollForward_CannotDrainAPointedEpoch() public {
        address tba = makeAddr("pt");
        care.mint(address(dist), 50e18);
        _notify(1, tba, 50e18); // epoch 0 has a point and a real claimant
        vm.warp(block.timestamp + EPOCH);
        // An attacker tries to roll the pool away from the claimant into a future epoch.
        vm.prank(attacker);
        vm.expectRevert(RewardsDistributor.EpochHasPoints.selector);
        dist.rollForward(0);
        // The claimant is unaffected.
        dist.claim(0, 1);
        assertEq(care.balanceOf(tba), 50e18, "pointed epoch pays its claimant intact");
    }

    function test_RollForward_PermissionlessButFundsStayInContract() public {
        care.mint(address(dist), 25e18);
        dist.sync(); // recognized into epoch 0, zero points
        vm.warp(block.timestamp + EPOCH);
        uint256 balBefore = care.balanceOf(address(dist));
        vm.prank(attacker); // anyone may roll a finished zero-point epoch
        dist.rollForward(0);
        assertEq(care.balanceOf(address(dist)), balBefore, "roll moves buckets, not funds out");
        assertEq(dist.epochPool(1), 25e18, "carried into the next epoch, still only claimable by real pets");
    }
}

// ================================================================================================
// I. Pet721 setContractURI owner power (the one unlockable surface)
// ================================================================================================

contract ContractURIAccessTest is AccessBase {
    Pet721 internal pet;

    function setUp() public override {
        super.setUp();
        pet = new Pet721("WALLETCHI", "WCHI", MAX_SUPPLY, owner, royalty, "ipfs://initial");
    }

    function test_SetContractURI_OnlyOwner() public {
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, attacker));
        vm.prank(attacker);
        pet.setContractURI("ipfs://evil");
        assertEq(pet.contractURI(), "ipfs://initial", "non-owner cannot change collection metadata");
    }

    /// setContractURI is deliberately NOT lockable: it remains an owner power AFTER every other lock is
    /// engaged (issuer, royalty, validator, vault ref). A compromised owner key can always reposition the
    /// collection page metadata (phishing / defacement surface), though it moves no funds.
    function test_SetContractURI_SurvivesEveryOtherLock() public {
        vm.startPrank(owner);
        pet.setIssuer(makeAddr("iss"));
        pet.lockIssuer();
        pet.lockRoyalty();
        pet.lockValidator();
        pet.setVaultRef(makeAddr("vaultRef"));
        pet.lockVaultRef();
        // Everything else is frozen, yet the collection metadata can still be swapped at will.
        pet.setContractURI("ipfs://swapped-after-all-locks");
        vm.stopPrank();
        assertEq(pet.contractURI(), "ipfs://swapped-after-all-locks", "contractURI still mutable post-lock");

        // Confirm the locks really are engaged (so the above is a genuine survivor, not an un-set lock).
        assertTrue(pet.issuerLocked() && pet.royaltyLocked() && pet.validatorLocked() && pet.vaultRefLocked());
    }
}

// ================================================================================================
// J. Constructor validation vs weird-but-valid configs
// ================================================================================================

contract ConstructorEdgeTest is AccessBase {
    MockCareToken internal care;
    Pet721 internal pet;
    PetIssuer internal issuer;

    function setUp() public override {
        super.setUp();
        care = new MockCareToken();
        pet = new Pet721("W", "W", MAX_SUPPLY, owner, royalty, "");
        issuer = new PetIssuer(
            pet,
            IERC6551Registry(address(registry)),
            address(accountImpl),
            IERC20(address(care)),
            relayer,
            owner,
            CARE_COST,
            CARE_COST * 48,
            STARTER
        );
    }

    function _params() internal returns (PetVault.Params memory p) {
        p = PetVault.Params({
            careToken: IERC20(address(care)),
            pet: pet,
            issuer: IPetCareSpender(address(issuer)),
            owner: owner,
            lifeTtl: LIFE_TTL,
            careCost: CARE_COST,
            potBps: POT_BPS,
            burnBps: BPS - POT_BPS - REWARDS_BPS,
            rewardsBps: REWARDS_BPS,
            rewardsRecipient: address(new VaultStub()),
            gasBps: 0,
            gasRecipient: address(0),
            abandonGrace: 90 days,
            minPlayers: 2,
            careCooldown: CARE_COOLDOWN,
            minSeasonDuration: LIFE_TTL,
            entryWindowSecs: LIFE_TTL,
            selloutStartsSeason: false
        });
    }

    /// rewardsBps = 9999, potBps = 1, burnBps = 0 is a valid extreme: the three legs still sum to BPS,
    /// both dust guards pass at a large careCost, and burn simply takes only the rounding remainder.
    /// No validation gap: the near-total rewards split is accepted by design.
    function test_Constructor_RewardsBps9999_Accepted() public {
        PetVault.Params memory p = _params();
        p.careCost = 1e18; // large enough that careCost * 1 >= BPS and careCost * 9999 >= BPS
        p.potBps = 1;
        p.rewardsBps = 9999;
        p.burnBps = 0;
        PetVault v = new PetVault(p);
        assertEq(v.rewardsBps(), 9999);
        assertEq(v.burnBps(), 0);
    }

    /// SPEC vs CODE: the doc says rewardsRecipient is address(0) "iff rewardsBps == 0", but the
    /// constructor only enforces one direction (rewardsBps > 0 requires a recipient). A dead recipient
    /// with rewardsBps == 0 is ACCEPTED and inert (care() never touches it). Harmless, but a mismatch.
    function test_Constructor_RewardsBpsZeroWithNonZeroRecipient_AcceptedInert() public {
        PetVault.Params memory p = _params();
        p.potBps = 1000;
        p.burnBps = 9000;
        p.rewardsBps = 0;
        p.rewardsRecipient = makeAddr("deadSink"); // non-zero, but the leg is disabled
        PetVault v = new PetVault(p);
        assertEq(v.rewardsBps(), 0);
        assertEq(v.rewardsRecipient(), makeAddr("deadSink"), "non-zero recipient stored despite zero bps");
    }
}
