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
import {minNeedOf} from "./utils/FiveNeedsTestLib.sol";

/// @notice THE SELLOUT SEASON MODEL. Nothing hatches and nothing feeds until the collection has
///         minted out; at that instant every registered pet's five need clocks start TOGETHER.
///
///         The defect this replaces is not a bug in any one line, it is that the clock model let the
///         start line move per player: the earliest buyer's pet was already dying while the
///         collection was still selling, and a late entrant hatched with a full fresh window against
///         keepers who had been paying care costs for days. `entryDeadline` could bound that skew
///         but never remove it. Here the start line is a single shared timestamp, so the skew is
///         zero by construction and hatch-sniping has nothing left to buy.
///
///         The suite runs at TESTER SCALE on purpose (supply 5, minimum 3): a 2,000-pet collection
///         cannot wait for 2,000 testers, and the owner-start path is exactly what makes a small
///         season startable. Both start paths are pinned here.
contract SelloutSeasonTest is Test {
    uint256 internal constant MAX_SUPPLY = 5; // tester scale: five mints and the season is on
    uint256 internal constant MIN_PLAYERS = 3;
    uint256 internal constant LIFE_TTL = 1 days;
    uint256 internal constant CARE_COST = 1e18;
    uint256 internal constant POT_BPS = 1000;
    uint256 internal constant BURN_BPS = 9000;
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
    address internal alice = makeAddr("alice");
    address internal bob = makeAddr("bob");
    address internal carol = makeAddr("carol");

    function setUp() public {
        registry = new ERC6551Registry();
        (pet, issuer, vault) = _deployStack(true, MAX_SUPPLY);
        care.mint(address(issuer), FLOAT);
    }

    function _deployStack(bool sellout, uint256 supply)
        internal
        returns (Pet721 pet_, PetIssuer issuer_, PetVault vault_)
    {
        vm.startPrank(owner);
        if (address(care) == address(0)) care = new MockCareToken();
        if (address(impl) == address(0)) impl = new WalletchiAccount();
        pet_ = new Pet721("WALLETCHI", "WCHI", supply, owner, owner, "");
        issuer_ = new PetIssuer(
            pet_,
            IERC6551Registry(address(registry)),
            address(impl),
            IERC20(address(care)),
            relayer,
            owner,
            PER_TX_CAP,
            DAILY_CAP,
            STARTER
        );
        vault_ = new PetVault(
            PetVault.Params({
                careToken: IERC20(address(care)),
                pet: pet_,
                issuer: IPetCareSpender(address(issuer_)),
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
                careCooldown: 0,
                minSeasonDuration: LIFE_TTL,
                // Irrelevant under the sellout model (the sellout IS the roster close); still a real
                // value because the constructor validates it on every config path.
                entryWindowSecs: 365 days,
                selloutStartsSeason: sellout
            })
        );
        pet_.setIssuer(address(issuer_));
        issuer_.setVault(address(vault_));
        pet_.setVaultRef(address(vault_));
        vm.stopPrank();
    }

    function _mint(address to) internal returns (uint256 id) {
        vm.prank(relayer);
        (id,) = issuer.issuePet(to);
    }

    /// @dev Mint the whole collection so the sellout condition is genuinely met.
    function _mintOut() internal {
        for (uint256 i = pet.totalMinted(); i < MAX_SUPPLY; i++) _mint(alice);
    }

    function _care(uint256 id, uint8 action) internal {
        vm.prank(pet.ownerOf(id));
        vault.care(id, action);
    }

    // ---------------------------------------------------------------- before the sellout

    function test_CareRefusedBeforeSellout() public {
        uint256 id = _mint(alice);
        vm.prank(alice);
        vm.expectRevert(PetVault.SeasonNotStarted.selector);
        vault.care(id, 0);
    }

    /// The whole point: an early buyer's pet is NOT quietly running down while the collection sells.
    function test_EarlyPetHasNoRunningClockBeforeSellout() public {
        uint256 id = _mint(alice);
        skip(30 days); // a long, slow mint
        assertFalse(vault.alive(id), "not in play before the season starts");
        assertFalse(vault.isDead(id), "and emphatically not dead: no clock has run");
        _mintOut();
        vault.startSeason();
        assertTrue(vault.alive(id), "alive the instant the season starts, unfed, 30 days after mint");
    }

    function test_MintingOpenBeforeSelloutAndClosedAfter() public {
        assertTrue(vault.entryOpen(), "entry open while minting");
        _mintOut();
        vault.startSeason();
        assertFalse(vault.entryOpen(), "roster closed at the start line");
        vm.prank(relayer);
        vm.expectRevert(PetIssuer.EntryWindowClosed.selector);
        issuer.issuePet(bob);
    }

    function test_SeasonNotDecidableBeforeStart() public {
        _mint(alice);
        skip(3650 days);
        assertFalse(vault.isOver(), "a season that never started can never be decided");
    }

    // ---------------------------------------------------------------- starting the season

    function test_SelloutStartsSeasonPermissionlessly() public {
        _mintOut();
        vm.prank(bob); // a stranger: the sellout is a public fact
        vault.startSeason();
        assertEq(uint256(vault.seasonStartedAt()), block.timestamp, "start line stamped");
    }

    function test_NonOwnerCannotStartBeforeSellout() public {
        _mint(alice);
        _mint(alice);
        _mint(alice);
        vm.prank(bob);
        vm.expectRevert(PetVault.SelloutRequired.selector);
        vault.startSeason();
    }

    /// THE TESTER PATH: a 2,000-pet collection cannot wait for 2,000 testers.
    function test_OwnerStartsEarlyOnceItIsARealRace() public {
        _mint(alice);
        _mint(bob);
        _mint(carol);
        assertEq(vault.registeredCount(), MIN_PLAYERS, "exactly at the minimum");
        vm.prank(owner);
        vault.startSeason();
        assertGt(uint256(vault.seasonStartedAt()), 0, "started without minting out");
        assertFalse(vault.entryOpen(), "and the roster closed behind it");
    }

    function test_OwnerCannotStartBelowMinPlayers() public {
        _mint(alice);
        _mint(bob);
        vm.prank(owner);
        vm.expectRevert(PetVault.NotEnoughPlayers.selector);
        vault.startSeason();
    }

    function test_StartSeasonIsOneWay() public {
        _mintOut();
        vault.startSeason();
        vm.expectRevert(PetVault.SeasonAlreadyStarted.selector);
        vault.startSeason();
    }

    function test_StartSeasonRejectedOnClockModelVault() public {
        (,, PetVault clockVault) = _deployStack(false, MAX_SUPPLY);
        vm.expectRevert(PetVault.BadConfig.selector);
        clockVault.startSeason();
    }

    /// A collection whose entire supply is under the player minimum could mint out and STILL never
    /// be decidable, locking every care fee in the pot forever. Refused at construction.
    function test_ConstructorRejectsSupplySmallerThanMinPlayers() public {
        vm.startPrank(owner);
        Pet721 tiny = new Pet721("WALLETCHI", "WCHI", MIN_PLAYERS - 1, owner, owner, "");
        // expectRevert binds to the very NEXT call, so the vault construction must be it.
        vm.expectRevert(PetVault.BadConfig.selector);
        new PetVault(
            PetVault.Params({
                careToken: IERC20(address(care)),
                pet: tiny,
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
                careCooldown: 0,
                minSeasonDuration: LIFE_TTL,
                entryWindowSecs: 365 days,
                selloutStartsSeason: true
            })
        );
        vm.stopPrank();
    }

    // ---------------------------------------------------------------- the shared start line

    /// THE CORE PROPERTY. Every pet, minted at wildly different times, gets the SAME deadline.
    function test_EveryPetSharesOneDeadlineRegardlessOfMintTime() public {
        uint256 a = _mint(alice);
        skip(5 days);
        uint256 b = _mint(bob);
        skip(9 days);
        uint256 c = _mint(carol);
        _mintOut();
        vault.startSeason();
        uint64 startedAt = vault.seasonStartedAt();

        assertEq(minNeedOf(vault, a), startedAt, "first minted starts at the start line");
        assertEq(minNeedOf(vault, b), startedAt, "so does the middle one");
        assertEq(minNeedOf(vault, c), startedAt, "so does the last one");
    }

    function test_UnfedPetDiesExactlyOneLifeWindowAfterStart() public {
        uint256 id = _mint(alice);
        _mintOut();
        vault.startSeason();
        uint64 startedAt = vault.seasonStartedAt();

        vm.warp(uint256(startedAt) + LIFE_TTL - 1);
        assertTrue(vault.alive(id), "alive right up to the deadline");
        vm.warp(uint256(startedAt) + LIFE_TTL);
        assertFalse(vault.alive(id), "dead the instant the window closes");
        assertTrue(vault.isDead(id), "and reads dead to the memorial");
    }

    function test_FirstCareAfterStartFillsAllFiveNeeds() public {
        uint256 id = _mint(alice);
        _mintOut();
        vault.startSeason();
        skip(1 hours);
        _care(id, 0);
        uint64[5] memory n = vault.needsOf(id);
        for (uint256 i = 0; i < 5; i++) {
            assertEq(n[i], uint64(block.timestamp), "the hatch fills every bowl at once");
        }
    }

    /// HATCH-SNIPE IS GONE, not merely bounded: waiting is fatal, so there is no late entry to buy.
    function test_LateHatcherCannotStealAFreshWindow() public {
        uint256 early = _mint(alice);
        uint256 late = _mint(bob);
        _mintOut();
        vault.startSeason();

        // The diligent keeper serves all five needs inside the window.
        skip(LIFE_TTL - 1 hours);
        for (uint8 i = 0; i < 5; i++) _care(early, i);

        // The sniper tries to wake up afterwards with a "fresh" pet.
        skip(2 hours); // now past start + lifeTtl
        assertFalse(vault.alive(late), "the dormant pet is dead, not fresh");
        vm.prank(bob);
        vm.expectRevert(PetVault.PetIsDead.selector);
        vault.care(late, 0);
        assertTrue(vault.alive(early), "the keeper who actually played is still in it");
    }

    function test_PetsStayTransferableBeforeTheSeasonStarts() public {
        uint256 id = _mint(alice);
        skip(10 days);
        vm.prank(alice);
        pet.transferFrom(alice, bob, id); // an unstarted season must not brick the secondary market
        assertEq(pet.ownerOf(id), bob, "egg traded freely while the collection is still minting");
    }

    function test_RegisteredCountIsThePlayerCountAtStart() public {
        _mintOut();
        vault.startSeason();
        assertEq(vault.registeredCount(), MAX_SUPPLY, "everyone who minted is in the race");
        for (uint256 id = 1; id <= MAX_SUPPLY; id++) {
            assertTrue(vault.alive(id), "and every one of them is alive, unfed, at the start line");
        }
    }
}
