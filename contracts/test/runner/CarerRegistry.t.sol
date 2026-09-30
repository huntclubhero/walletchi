// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

import {ERC6551Registry} from "erc6551/ERC6551Registry.sol";
import {IERC6551Registry} from "erc6551/interfaces/IERC6551Registry.sol";

import {WalletchiAccount} from "../../src/WalletchiAccount.sol";
import {Pet721} from "../../src/runner/Pet721.sol";
import {PetIssuer} from "../../src/runner/PetIssuer.sol";
import {PetVault, IPetCareSpender} from "../../src/runner/PetVault.sol";
import {MockCareToken} from "../../src/runner/MockCareToken.sol";

/// @notice The owner-approved carer registry: the on-chain half of one-tap care, and the ONLY path
///         that works for wallets which do not expose EIP-7702 authorization signing to sites (every
///         browser extension wallet, deliberately).
///
///         This suite exists to prove the registry is a DELEGATION, not a back door. The load-bearing
///         property is #4 below: an approval must die the instant the pet changes hands, or a seller
///         could grief a buyer's pet forever, which is exactly the confused-deputy shape this design
///         is meant to avoid.
///
///           1. only the current owner may approve
///           2. an approved carer can feed
///           3. an unapproved address cannot, and revocation takes effect immediately
///           4. TRANSFER VOIDS THE APPROVAL, with no hook and no bookkeeping
///           5. approvals expire
///           6. a carer gains NO power the owner did not already have (cooldown, death, game over,
///              and the money split all apply identically)
contract CarerRegistryTest is Test {
    uint256 internal constant MAX_SUPPLY = 2000;
    uint256 internal constant LIFE_TTL = 3600;
    uint256 internal constant CARE_COST = 1e18;
    uint256 internal constant POT_BPS = 1000;
    uint256 internal constant BURN_BPS = 9000;
    uint256 internal constant CARE_COOLDOWN = 30;
    uint256 internal constant MIN_PLAYERS = 3;
    uint256 internal constant PER_TX_CAP = 1e18;
    uint256 internal constant DAILY_CAP = 1000e18;
    uint256 internal constant STARTER = 100e18;
    uint256 internal constant FLOAT = 1_000_000e18;

    ERC6551Registry internal registry;
    MockCareToken internal care;
    WalletchiAccount internal impl;
    Pet721 internal pet;
    PetIssuer internal issuer;
    PetVault internal vault;

    address internal owner = makeAddr("owner");
    address internal relayer = makeAddr("relayer");
    address internal alice = makeAddr("alice"); // pet owner
    address internal bob = makeAddr("bob"); // buyer
    address internal server = makeAddr("server"); // the approved carer (our care-link server)
    address internal mallory = makeAddr("mallory"); // unapproved
    uint256 internal t0;

    function setUp() public {
        vm.startPrank(owner);
        registry = new ERC6551Registry();
        care = new MockCareToken();
        impl = new WalletchiAccount();
        pet = new Pet721("WALLETCHI", "WCHI", MAX_SUPPLY, owner, owner, "");
        issuer = new PetIssuer(
            pet, IERC6551Registry(address(registry)), address(impl), IERC20(address(care)),
            relayer, owner, PER_TX_CAP, DAILY_CAP, STARTER
        );
        vault = new PetVault(
            PetVault.Params({
                careToken: IERC20(address(care)),
                pet: pet,
                issuer: IPetCareSpender(address(issuer)),
                owner: owner,
                lifeTtl: LIFE_TTL,
                careCost: CARE_COST,
                potBps: POT_BPS,
                burnBps: BURN_BPS,
                rewardsBps: 0,
                rewardsRecipient: address(0),
                gasBps: 0,
                gasRecipient: address(0),
                abandonGrace: 90 days,
                minPlayers: MIN_PLAYERS,
                careCooldown: CARE_COOLDOWN,
                minSeasonDuration: LIFE_TTL,
                entryWindowSecs: LIFE_TTL
            , selloutStartsSeason: false})
        );
        pet.setIssuer(address(issuer));
        issuer.setVault(address(vault));
        pet.setVaultRef(address(vault));
        pet.lockIssuer();
        issuer.lockVault();
        pet.lockVaultRef();
        vm.stopPrank();
        care.mint(address(issuer), FLOAT);
        t0 = block.timestamp;
    }

    function _mint(address to) internal returns (uint256 id, address tba) {
        vm.prank(relayer);
        (id, tba) = issuer.issuePet(to);
    }

    // ---- 1. only the current owner may approve ----------------------------------------------------

    function test_OnlyOwnerCanSetCarer() public {
        (uint256 id,) = _mint(alice);
        vm.prank(mallory);
        vm.expectRevert(PetVault.NotAuthorizedCarer.selector);
        vault.setCarer(id, mallory, 0);
        assertEq(vault.carerOf(id), address(0), "no approval was created");
    }

    function test_OwnerCanApproveAndRevoke() public {
        (uint256 id,) = _mint(alice);
        vm.prank(alice);
        vault.setCarer(id, server, 0);
        assertEq(vault.carerOf(id), server, "approved");

        vm.prank(alice);
        vault.setCarer(id, address(0), 0);
        assertEq(vault.carerOf(id), address(0), "revoked");
    }

    // ---- 2. an approved carer can feed ------------------------------------------------------------

    function test_ApprovedCarerCanCare() public {
        (uint256 id, address tba) = _mint(alice);
        vm.prank(alice);
        vault.setCarer(id, server, 0);

        vm.warp(t0 + CARE_COOLDOWN);
        vm.prank(server);
        vault.care(id, 0);

        (,, , , uint256 careCount) = _state(id);
        assertEq(careCount, 1, "the carer's feed counted");
        assertEq(care.balanceOf(tba), STARTER - CARE_COST, "paid from the PET's account, not the carer's");
        assertEq(care.balanceOf(server), 0, "nothing ever reaches the carer");
        assertEq(vault.pot(), CARE_COST * POT_BPS / 10_000, "money split is identical to an owner care");
    }

    // ---- 3. an unapproved address cannot, and revocation is immediate -----------------------------

    function test_UnapprovedCannotCare() public {
        (uint256 id,) = _mint(alice);
        vm.warp(t0 + CARE_COOLDOWN);
        vm.prank(mallory);
        vm.expectRevert(PetVault.NotAuthorizedCarer.selector);
        vault.care(id, 0);
    }

    function test_RevokedCarerCannotCare() public {
        (uint256 id,) = _mint(alice);
        vm.prank(alice);
        vault.setCarer(id, server, 0);
        vm.prank(alice);
        vault.setCarer(id, address(0), 0);

        vm.warp(t0 + CARE_COOLDOWN);
        vm.prank(server);
        vm.expectRevert(PetVault.NotAuthorizedCarer.selector);
        vault.care(id, 0);
    }

    function test_ApprovingOneCarerReplacesTheLast() public {
        (uint256 id,) = _mint(alice);
        vm.prank(alice);
        vault.setCarer(id, server, 0);
        vm.prank(alice);
        vault.setCarer(id, mallory, 0);
        assertEq(vault.carerOf(id), mallory, "one carer at a time");

        vm.warp(t0 + CARE_COOLDOWN);
        vm.prank(server);
        vm.expectRevert(PetVault.NotAuthorizedCarer.selector);
        vault.care(id, 0);
    }

    // ---- 4. THE LOAD-BEARING ONE: a transfer voids the approval -----------------------------------

    /// @dev If this ever fails, a seller can force-care a buyer's pet every cooldown until its whole
    ///      stake is burned and it starves. That is the attack this whole design is shaped around.
    function test_TransferVoidsTheSellersCarer() public {
        (uint256 id,) = _mint(alice);
        vm.prank(alice);
        vault.setCarer(id, server, 0);
        assertEq(vault.carerOf(id), server, "live while alice owns it");

        // Alice sells to Bob. She sets nothing, clears nothing, and signs nothing extra.
        vm.prank(alice);
        pet.transferFrom(alice, bob, id);

        assertEq(vault.carerOf(id), address(0), "the seller's approval is void the instant it moves");
        vm.warp(t0 + CARE_COOLDOWN);
        vm.prank(server);
        vm.expectRevert(PetVault.NotAuthorizedCarer.selector);
        vault.care(id, 0);
    }

    /// @dev DELIBERATE, TESTED SEMANTICS: the approval is bound to the OWNER who granted it, so if that
    ///      same owner reacquires the pet their own approval is live again. Documented rather than
    ///      "fixed" because it is not third-party exploitable: the only beneficiary is the carer that
    ///      this exact owner chose, on a pet this exact owner holds, and they can revoke at any time.
    ///      Making it never revive would need a per-token transfer counter in Pet721, adding gas to
    ///      every transfer and re-touching an audited hot path to close an edge nobody can attack.
    ///      Whoever reads this next: it is a choice, not an oversight.
    function test_ApprovalRevivesOnlyForTheSameOwnerWhoGrantedIt() public {
        (uint256 id,) = _mint(alice);
        vm.prank(alice);
        vault.setCarer(id, server, 0);

        vm.prank(alice);
        pet.transferFrom(alice, bob, id);
        assertEq(vault.carerOf(id), address(0), "void while bob holds it");

        // A DIFFERENT owner never inherits it, which is the property that actually matters.
        vm.warp(t0 + CARE_COOLDOWN);
        vm.prank(server);
        vm.expectRevert(PetVault.NotAuthorizedCarer.selector);
        vault.care(id, 0);

        vm.prank(bob);
        pet.transferFrom(bob, alice, id);
        assertEq(vault.carerOf(id), server, "alice's own approval is live again for alice");
    }

    function test_BuyerCanApproveTheirOwnCarer() public {
        (uint256 id,) = _mint(alice);
        vm.prank(alice);
        vault.setCarer(id, server, 0);
        vm.prank(alice);
        pet.transferFrom(alice, bob, id);

        vm.prank(bob);
        vault.setCarer(id, server, 0);
        assertEq(vault.carerOf(id), server, "the new owner grants their own");

        vm.warp(t0 + CARE_COOLDOWN);
        vm.prank(server);
        vault.care(id, 0);
        (,, , , uint256 careCount) = _state(id);
        assertEq(careCount, 1, "and it works");
    }

    // ---- 5. approvals expire ----------------------------------------------------------------------

    function test_ApprovalExpires() public {
        (uint256 id,) = _mint(alice);
        uint64 expiry = uint64(t0 + 1000);
        vm.prank(alice);
        vault.setCarer(id, server, expiry);
        assertEq(vault.carerOf(id), server, "live before expiry");

        vm.warp(t0 + 1000);
        assertEq(vault.carerOf(id), address(0), "dead AT the expiry instant");
        vm.prank(server);
        vm.expectRevert(PetVault.NotAuthorizedCarer.selector);
        vault.care(id, 0);
    }

    function test_PastExpiryIsRejectedAtSetTime() public {
        (uint256 id,) = _mint(alice);
        vm.warp(t0 + 5000);
        vm.prank(alice);
        vm.expectRevert(PetVault.BadConfig.selector);
        vault.setCarer(id, server, uint64(t0 + 1000));
    }

    // ---- 6. a carer gains NO power the owner did not have -----------------------------------------

    function test_CarerIsBoundByTheCooldown() public {
        (uint256 id,) = _mint(alice);
        vm.prank(alice);
        vault.setCarer(id, server, 0);
        vm.warp(t0 + CARE_COOLDOWN);
        vm.prank(server);
        vault.care(id, 0);

        vm.prank(server);
        vm.expectRevert(PetVault.CareOnCooldown.selector);
        vault.care(id, 0);
    }

    function test_CarerCannotReviveADeadPet() public {
        (uint256 id,) = _mint(alice);
        vm.prank(alice);
        vault.setCarer(id, server, 0);
        vm.warp(t0 + CARE_COOLDOWN);
        vm.prank(server);
        vault.care(id, 0); // hatch: the life timer starts

        vm.warp(block.timestamp + LIFE_TTL + 1);
        vm.prank(server);
        vm.expectRevert(PetVault.PetIsDead.selector);
        vault.care(id, 0);
    }

    /// @dev The grief ceiling, stated honestly as a test: a carer can spend the pet's stake down to
    ///      nothing (bounded by the TBA dailyCap). That is a total loss of the STAKE and never a
    ///      transfer of value to the carer, which is the whole "grief, not theft" claim. FIVE NEEDS:
    ///      the carer must serve the pet's currently-weakest need each time (CarerMustServeMinNeed
    ///      otherwise), so the burn ROTATES through the needs and leaves the pet fully served: the
    ///      forced spend can never be concentrated into a kill.
    function test_GriefCeilingIsStakeLossNeverTheft() public {
        (uint256 id, address tba) = _mint(alice);
        vm.prank(alice);
        vault.setCarer(id, server, 0);

        uint256 feeds = 5;
        for (uint256 i = 0; i < feeds; i++) {
            vm.warp(block.timestamp + CARE_COOLDOWN);
            vm.prank(server);
            // Care 0 hatches (all needs tied); every later care must hit a tied-at-min hatch stamp.
            vault.care(id, uint8(i));
        }
        assertEq(care.balanceOf(tba), STARTER - feeds * CARE_COST, "the pet's stake drained");
        assertEq(care.balanceOf(server), 0, "the carer received NOTHING");
        assertEq(pet.ownerOf(id), alice, "and never touched the NFT");
    }

    /// @dev FIVE NEEDS: a carer is welded to the pet's weakest need. Serving anything fresher
    ///      reverts CarerMustServeMinNeed, while the owner stays free to care whatever they like.
    ///      This is what turns cap-burn griefing back into pure stake loss: every forced care serves
    ///      the need that was binding the pet's deadline.
    function test_CarerMustServeTheWeakestNeed() public {
        (uint256 id,) = _mint(alice);
        vm.prank(alice);
        vault.setCarer(id, server, 0);
        vm.warp(t0 + CARE_COOLDOWN);
        vm.prank(alice);
        vault.care(id, 0); // owner hatches: all five needs tied at now
        vm.warp(block.timestamp + CARE_COOLDOWN);
        vm.prank(alice);
        vault.care(id, 0); // owner refreshes FEED: feed is now fresher than the rest

        vm.warp(block.timestamp + CARE_COOLDOWN); // clear feed's own cooldown so the MIN rule decides
        vm.prank(server);
        vm.expectRevert(PetVault.CarerMustServeMinNeed.selector);
        vault.care(id, 0); // the carer may NOT re-serve the fresh need
        vm.prank(server);
        vault.care(id, 2); // but any tied-at-min need is fair game
        // The owner remains unrestricted on non-min needs.
        vm.warp(block.timestamp + CARE_COOLDOWN);
        vm.prank(alice);
        vault.care(id, 0);
    }

    /// @dev A carer cannot move the pet: the registry authorizes care() and nothing else.
    function test_CarerCannotTransferThePet() public {
        (uint256 id,) = _mint(alice);
        vm.prank(alice);
        vault.setCarer(id, server, 0);

        vm.prank(server);
        vm.expectRevert();
        pet.transferFrom(alice, server, id);
        assertEq(pet.ownerOf(id), alice, "still alice's");
    }

    function test_CarerCannotCareOnceTheGameIsOver() public {
        (uint256 a,) = _mint(alice);
        (uint256 b,) = _mint(bob);
        (uint256 c,) = _mint(mallory);
        vm.prank(alice);
        vault.setCarer(a, server, 0);

        vm.warp(t0 + CARE_COOLDOWN);
        vm.prank(alice);
        vault.care(a, 0);
        vm.prank(bob);
        vault.care(b, 0);
        vm.prank(mallory);
        vault.care(c, 0);
        // Leader is c; once no OTHER pet has been fed for a full life window the board is decided.
        vm.warp(block.timestamp + LIFE_TTL + 1);

        vm.prank(server);
        vm.expectRevert(PetVault.GameOver.selector);
        vault.care(a, 0);
    }

    // ---- plumbing ---------------------------------------------------------------------------------

    function _state(uint256 id)
        internal
        view
        returns (bool registered, bool dead, uint64 lastCareAt, bool isAlive, uint256 careCount)
    {
        (registered, dead, lastCareAt, isAlive,) = vault.petState(id);
        (, , , uint32 cc,) = vault.memorialState(id);
        careCount = cc;
    }
}
