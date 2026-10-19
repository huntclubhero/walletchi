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

/// @notice REGRESSION: a SPARSE hatch sequence must not end the season.
///
///         The bug this pins: `isOver()` reads `runnerUpCareAt`, which only ever tracks pets that have
///         been FED. On the feed that pushes hatchedCount to minPlayers, runnerUpCareAt is assigned the
///         PREVIOUS hatcher's care time. If that was more than lifeTtl ago (a soft launch where the
///         third person to ever feed does so a day after the second) the season is decided the instant
///         that transaction lands: care() and register() revert GameOver forever, every pet starves,
///         and a dead pet is soulbound, so the whole collection becomes untransferable with no recovery
///         path (issuer, vault ref and vault are all one-way locked).
contract SparseHatchFreezeTest is Test {
    uint256 internal constant LIFE_TTL = 86400;
    uint256 internal constant CARE_COOLDOWN = 60;
    uint256 internal constant MIN_PLAYERS = 3;

    Pet721 internal pet;
    PetIssuer internal issuer;
    PetVault internal vault;
    MockCareToken internal care;
    address internal owner = makeAddr("owner");
    address internal relayer = makeAddr("relayer");
    address internal a1 = makeAddr("a1");
    address internal a2 = makeAddr("a2");
    address internal a3 = makeAddr("a3");

    function setUp() public {
        vm.startPrank(owner);
        ERC6551Registry registry = new ERC6551Registry();
        care = new MockCareToken();
        WalletchiAccount impl = new WalletchiAccount();
        pet = new Pet721("WALLETCHI", "WCHI", 2000, owner, owner, "");
        issuer = new PetIssuer(pet, IERC6551Registry(address(registry)), address(impl), IERC20(address(care)), relayer, owner, 1e18, 1000e18, 100e18);
        vault = new PetVault(PetVault.Params({
            careToken: IERC20(address(care)), pet: pet, issuer: IPetCareSpender(address(issuer)), owner: owner,
            lifeTtl: LIFE_TTL, careCost: 1e18, potBps: 1000, burnBps: 9000, rewardsBps: 0,
            rewardsRecipient: address(0),
            gasBps: 0, gasRecipient: address(0), abandonGrace: 90 days,
            minPlayers: MIN_PLAYERS, careCooldown: CARE_COOLDOWN,
            minSeasonDuration: LIFE_TTL,
            // A PRODUCTION-SHAPED ROSTER: seven life windows. The scenario this suite pins is a SOFT
            // LAUNCH where players trickle in over days, so the entry window has to be longer than a
            // life window or the third player is refused at the door instead of being frozen out by
            // the bug. This is the same relation the deploy script now requires of the real season
            // (ENTRY_WINDOW_SECS > LIFE_TTL, default 7 days against a 1 day life window).
            entryWindowSecs: 7 * LIFE_TTL
        , selloutStartsSeason: false}));
        pet.setIssuer(address(issuer)); issuer.setVault(address(vault)); pet.setVaultRef(address(vault));
        pet.lockIssuer(); issuer.lockVault(); pet.lockVaultRef();
        vm.stopPrank();
        care.mint(address(issuer), 1_000_000e18);
    }

    function _mint(address to) internal returns (uint256 id) {
        vm.prank(relayer);
        (id,) = issuer.issuePet(to);
    }

    /// @dev Three players join a slow season, each feeding a day apart. Nothing adversarial.
    function test_SparseHatchDoesNotFreezeTheSeason() public {
        uint256 p1 = _mint(a1);
        uint256 p2 = _mint(a2);
        uint256 p3 = _mint(a3);

        vm.warp(block.timestamp + CARE_COOLDOWN);
        vm.prank(a1);
        vault.care(p1, 0); // day 0: first ever feed

        vm.warp(block.timestamp + 3600); // an hour later
        vm.prank(a2);
        vault.care(p2, 0);

        // The third player shows up the NEXT DAY. Normal for a soft launch.
        vm.warp(block.timestamp + LIFE_TTL + 3600);
        vm.prank(a3);
        vault.care(p3, 0);

        assertFalse(vault.isOver(), "season must NOT be decided just because hatches were spread out");

        // p1 and p2 genuinely starved during the day-long gap: that is the game working, not the bug.
        // What must still hold is that the board is LIVE for everyone who is still alive.
        vm.warp(block.timestamp + CARE_COOLDOWN);
        vm.prank(a3);
        vault.care(p3, 0); // reverts GameOver on the buggy build
        assertFalse(vault.isOver(), "still live after the third player feeds again");

        // And a new player can still join, which the buggy build made impossible forever.
        uint256 p4 = _mint(makeAddr("a4"));
        assertGt(p4, 0, "minting must still work");

        // The endgame clock starts when the race became contested, not from an ancient care.
        assertEq(uint256(vault.contestedAt()), block.timestamp - CARE_COOLDOWN, "contested at the third hatch");
    }
}
