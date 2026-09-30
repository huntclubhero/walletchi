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
import {careAll, minNeedOf, maxNeedOf} from "./utils/FiveNeedsTestLib.sol";

/// @notice Core correctness for the LAST PET STANDING endgame under FIVE NEEDS: the O(1) two-slot
///         tracker keyed on each pet's MIN-NEED timestamp (its weakest link), permanent time-based
///         death (any lapsed need, no reaping), time-based soulbound, the win condition + payout,
///         the minPlayers gate, and the adversarial surface (operator cannot steer the winner).
contract LastPetStandingTest is Test {
    address internal constant BURN = 0x000000000000000000000000000000000000dEaD;

    uint256 internal constant MAX_SUPPLY = 2000;
    uint256 internal constant LIFE_TTL = 3600; // 1h
    uint256 internal constant CARE_COST = 1e18;
    uint256 internal constant POT_BPS = 1000; // 10%
    uint256 internal constant BURN_BPS = 9000; // 90% (two-leg; rewards leg has its own suite)
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
    address internal player = makeAddr("player");
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

    /// @dev Rebuild the stack with a LONGER roster window and re-anchor t0. The suite's default is
    ///      entryWindowSecs == LIFE_TTL, which keeps `_decidesAt()` bit-identical to the pre-roster
    ///      contract and so leaves every endgame timing assertion below untouched. A couple of
    ///      scenarios genuinely need a roster that outlives one life window (a pet hatching after an
    ///      earlier pet has already died), which is exactly the shape the deploy script now REQUIRES
    ///      of production (ENTRY_WINDOW_SECS > LIFE_TTL). Those tests call this first.
    function _useLongerRoster(uint256 entryWindow) internal {
        vm.startPrank(owner);
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
                entryWindowSecs: entryWindow
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

    /// @dev Care as the pet's CURRENT owner (care is owner-only since audit access-H-1). Not for
    ///      vm.expectRevert sites: the ownerOf staticcall would consume the expectation.
    function _care(uint256 id) internal {
        vm.prank(pet.ownerOf(id));
        vault.care(id, 0);
    }

    // ---- economy sanity (two-leg split to the wei) -------------------------------------------------
    function test_CareSplitsPotAndBurn() public {
        (uint256 a, address tbaA) = _mint(player);
        vm.warp(t0 + CARE_COOLDOWN);
        _care(a);
        assertEq(vault.pot(), CARE_COST * POT_BPS / 10_000, "pot += 10%");
        assertEq(care.balanceOf(BURN), CARE_COST * BURN_BPS / 10_000, "burn += 90%");
        assertEq(care.balanceOf(tbaA), STARTER - CARE_COST, "TBA debits careCost");
    }

    // ---- the O(1) two-slot tracker, MIN-NEED keyed: leader = greatest score, runnerUp = best of
    //      the rest. A hatch scores `now`; a partial care only lifts a score to the pet's oldest
    //      remaining need, so leadership follows full service, not raw care activity. ---------------
    function test_TwoSlotTrackerInvariant() public {
        (uint256 a,) = _mint(player);
        (uint256 b,) = _mint(player);
        (uint256 c,) = _mint(player);

        vm.warp(t0 + CARE_COOLDOWN);
        _care(a); // hatch: leader=a (score t0+30), runnerUp=0
        assertEq(vault.leader(), a);
        assertEq(vault.leaderCareAt(), minNeedOf(vault, a), "leader slot = the leader's min-need");
        assertEq(vault.runnerUpCareAt(), 0);
        vm.warp(t0 + 2 * CARE_COOLDOWN);
        _care(b); // hatch b strictly later: leader=b, runnerUp = a's score (t0+30)
        assertEq(vault.leader(), b);
        assertEq(vault.runnerUpCareAt(), uint64(t0 + CARE_COOLDOWN));
        vm.warp(t0 + 3 * CARE_COOLDOWN);
        _care(c); // hatch c: leader=c, runnerUp = b's score (t0+60)
        assertEq(vault.leader(), c);
        assertEq(vault.runnerUpCareAt(), uint64(t0 + 2 * CARE_COOLDOWN));

        // A SINGLE-ACTION recare does NOT retake the lead: a's min stays at its hatch stamp.
        vm.warp(t0 + 4 * CARE_COOLDOWN);
        _care(a); // feed only: a's score is still t0+30
        assertEq(vault.leader(), c, "a partial care cannot take the seat");
        assertEq(minNeedOf(vault, a), uint64(t0 + CARE_COOLDOWN), "a's weakest need never moved");
        assertEq(vault.runnerUpCareAt(), uint64(t0 + 2 * CARE_COOLDOWN), "runner-up unchanged");

        // A FULL five-need round lifts a's score to now and takes the seat; c demotes to runner-up.
        vm.warp(t0 + 5 * CARE_COOLDOWN);
        careAll(vault, a);
        assertEq(vault.leader(), a);
        assertEq(vault.leaderCareAt(), uint64(t0 + 5 * CARE_COOLDOWN), "leader slot = a's new min");
        assertEq(vault.runnerUpCareAt(), uint64(t0 + 3 * CARE_COOLDOWN), "runnerUp = c's score");

        // The leader's own NON-min care leaves both slots exactly where they were.
        vm.warp(t0 + 6 * CARE_COOLDOWN);
        _care(a); // feed only: a's min is its other four needs at t0+150
        assertEq(vault.leader(), a);
        assertEq(vault.leaderCareAt(), uint64(t0 + 5 * CARE_COOLDOWN), "non-min care: slot holds");
        assertEq(vault.runnerUpCareAt(), uint64(t0 + 3 * CARE_COOLDOWN));
        assertEq(vault.hatchedCount(), 3);
    }

    // ---- permanent death: a lapsed pet can never be fed again --------------------------------------
    function test_PermanentDeath_NoRevive() public {
        (uint256 a,) = _mint(player);
        vm.warp(t0 + CARE_COOLDOWN);
        _care(a);
        assertTrue(vault.alive(a));
        vm.warp(t0 + CARE_COOLDOWN + LIFE_TTL); // exactly at the deadline
        assertFalse(vault.alive(a), "dead at deadline");
        assertTrue(vault.isDead(a), "isDead true");
        vm.prank(player); // not even the owner can revive it
        vm.expectRevert(PetVault.PetIsDead.selector);
        vault.care(a, 0);
    }

    // ---- time-based soulbound: live pet transfers, dead pet is locked ------------------------------
    function test_DeathSoulboundIsTimeBased() public {
        (uint256 a,) = _mint(player);
        vm.warp(t0 + CARE_COOLDOWN);
        _care(a);
        address buyer = makeAddr("buyer");
        // Alive: owner-to-owner transfer allowed.
        vm.prank(player);
        pet.transferFrom(player, buyer, a);
        assertEq(pet.ownerOf(a), buyer);
        // Dead: transfer reverts (permanent memorial).
        vm.warp(t0 + CARE_COOLDOWN + LIFE_TTL);
        assertTrue(vault.isDead(a));
        vm.prank(buyer);
        vm.expectRevert();
        pet.transferFrom(buyer, player, a);
    }

    // ---- the win: last pet standing takes the whole pot -------------------------------------------
    function test_LastPetStandingWins() public {
        (uint256 a, address tbaA) = _mint(player);
        (uint256 b,) = _mint(player);
        (uint256 c,) = _mint(player);

        vm.warp(t0 + CARE_COOLDOWN);
        _care(a);
        _care(b);
        _care(c); // 3 hatches in one second; the FIRST hatch (a) holds the seat on the tie
        vm.warp(t0 + 2 * CARE_COOLDOWN);
        careAll(vault, a); // a serves ALL FIVE: score t0+60. a is the last still fully served.

        // Not over yet: b and c are alive until t0+30+LIFE_TTL.
        assertFalse(vault.isOver());
        vm.expectRevert(PetVault.GameNotOver.selector);
        vault.finalize();

        // At runnerUp + LIFE_TTL, every non-leader pet (b, c) has lapsed. a is the sole survivor.
        vm.warp(t0 + CARE_COOLDOWN + LIFE_TTL);
        assertTrue(vault.isOver(), "game over: only a remains");
        assertTrue(vault.alive(a), "a still alive");
        assertFalse(vault.alive(b));
        assertFalse(vault.alive(c));

        uint256 prize = vault.pot();
        assertEq(prize, 8 * (CARE_COST * POT_BPS / 10_000), "3 hatches + a full five-need round");
        uint256 before = care.balanceOf(tbaA);
        vault.finalize(); // permissionless
        assertEq(vault.leader(), a);
        assertTrue(vault.potClaimed());
        assertEq(vault.pot(), 0);
        assertEq(care.balanceOf(tbaA) - before, prize, "whole pot paid to the winner TBA");
    }

    // ---- the minPlayers gate: too few fed pets can never insta-win ---------------------------------
    function test_MinPlayersGate() public {
        (uint256 a,) = _mint(player);
        (uint256 b,) = _mint(player);
        vm.warp(t0 + CARE_COOLDOWN);
        _care(a);
        _care(b); // only 2 hatched < MIN_PLAYERS
        vm.warp(t0 + CARE_COOLDOWN + LIFE_TTL);
        assertFalse(vault.isOver());
        vm.expectRevert(PetVault.NotEnoughPlayers.selector);
        vault.finalize();
    }

    // ---- a fresh HATCH extends the game (a new competitor is alive) --------------------------------
    function test_NewLeaderResetsTheClock() public {
        (uint256 a,) = _mint(player);
        (uint256 b,) = _mint(player);
        (uint256 c,) = _mint(player);
        vm.warp(t0 + CARE_COOLDOWN);
        _care(a);
        _care(b);
        _care(c); // 3 hatches at t0+30; a holds the seat on the tie
        vm.warp(t0 + 2 * CARE_COOLDOWN);
        careAll(vault, a); // leader=a, score t0+60, runnerUp=t0+30
        // Well before the win, a NEW pet hatches: its score is `now`, strictly the greatest, so it
        // takes the seat and the old leader's score becomes the runner-up slot.
        (uint256 d,) = _mint(player);
        vm.warp(t0 + 1000);
        _care(d); // hatch takeover
        assertEq(vault.leader(), d);
        assertEq(vault.runnerUpCareAt(), uint64(t0 + 2 * CARE_COOLDOWN), "runnerUp = a's score");
        // The finish line moved out to a full window past a's score; still not over.
        vm.warp(t0 + CARE_COOLDOWN + LIFE_TTL);
        assertFalse(vault.isOver(), "game extended by the new competitor");
    }

    // ---- game over is final ------------------------------------------------------------------------
    function test_GameOverIsFinal() public {
        (uint256 a,) = _mint(player);
        (uint256 b,) = _mint(player);
        (uint256 c,) = _mint(player);
        vm.warp(t0 + CARE_COOLDOWN);
        _care(a);
        _care(b);
        _care(c);
        vm.warp(t0 + 2 * CARE_COOLDOWN);
        _care(a);
        vm.warp(t0 + CARE_COOLDOWN + LIFE_TTL);
        vault.finalize();
        // No more caring and no double finalize.
        vm.prank(player); // even the pet's owner is frozen out of a finished game
        vm.expectRevert(PetVault.GameOver.selector);
        vault.care(a, 0);
        vm.expectRevert(PetVault.GameOver.selector);
        vault.finalize();

        // AND MINTING IS SHUT TOO, CLEANLY. It used to stay open forever and quietly produce an
        // unregistered token: a pet that looked live, could never be fed, and could never win. Since
        // the roster close the mint is REFUSED instead, with a named error, and nothing is consumed:
        // totalMinted does not move, so no id and no supply is burned by a late attempt. The season
        // could not have been decided while entry was still open in the first place (the entry
        // deadline floors _decidesAt), so this is unreachable during a live season by construction.
        uint256 mintedBefore = pet.totalMinted();
        vm.prank(relayer);
        vm.expectRevert(PetIssuer.EntryWindowClosed.selector);
        issuer.issuePet(player);
        assertEq(pet.totalMinted(), mintedBefore, "a refused late mint consumes nothing");
        assertGe(block.timestamp, vault.entryDeadline(), "and we really are past the roster close");
    }

    /// The collection-bricking revert that RegisterSkipped was introduced to prevent is still
    /// impossible, even though issuePet now refuses late mints itself. register() remains a no-op
    /// rather than a revert, so a hand-wired or third-party issuer can never brick the collection
    /// against the one-way-locked pointers. Called directly as the issuer to reach the branch that
    /// the roster close otherwise makes unreachable.
    function test_RegisterStillNoOpsRatherThanBrickingTheCollection() public {
        (uint256 a,) = _mint(player);
        (uint256 b,) = _mint(player);
        (uint256 c,) = _mint(player);
        vm.warp(t0 + CARE_COOLDOWN);
        _care(a);
        _care(b);
        _care(c);
        vm.warp(t0 + 2 * CARE_COOLDOWN);
        _care(a);
        vm.warp(t0 + CARE_COOLDOWN + LIFE_TTL);
        vault.finalize();
        assertTrue(vault.potClaimed());

        uint256 registeredBefore = vault.registeredCount();
        vm.prank(address(issuer));
        vault.register(a); // no revert, no state change: the collection can never be bricked
        assertEq(vault.registeredCount(), registeredBefore, "register no-ops once the season is settled");
    }

    // ---- even if the last pet also dies, it was the last standing and still wins -------------------
    function test_LeaderExpiredStillWins() public {
        (uint256 a, address tbaA) = _mint(player);
        (uint256 b,) = _mint(player);
        (uint256 c,) = _mint(player);
        vm.warp(t0 + CARE_COOLDOWN);
        _care(a);
        _care(b);
        _care(c);
        vm.warp(t0 + 2 * CARE_COOLDOWN);
        _care(a); // leader=a@(t0+60)
        // Warp far past everyone's deadline: even a is dead now, but a fed last.
        vm.warp(t0 + 10 * LIFE_TTL);
        assertFalse(vault.alive(a), "even the leader lapsed");
        assertTrue(vault.isOver(), "still over: a was the last standing");
        uint256 prize = vault.pot();
        uint256 before = care.balanceOf(tbaA);
        vault.finalize();
        assertEq(vault.leader(), a);
        assertEq(care.balanceOf(tbaA) - before, prize, "pot pays the last-to-die leader");
    }

    // ================================================================================================
    // FIVE-NEEDS ENDGAME (min-need reduction). The tracker keys on each pet's weakest-link stamp.
    // ================================================================================================

    /// @dev The instant finalize() succeeds, read from the contract (runner-up score / contested +
    ///      lifeTtl; the suite's minSeasonDuration floor equals lifeTtl so it never binds later).
    function _decidesAt() internal view returns (uint256) {
        uint256 from = uint256(vault.runnerUpCareAt());
        if (uint256(vault.contestedAt()) > from) from = uint256(vault.contestedAt());
        return from + LIFE_TTL;
    }

    // ---- 14. leader = the pet with the greatest MIN-NEED, not the most recent care -----------------
    function test_Tracker_LeaderIsMaxMinNeed() public {
        (uint256 a,) = _mint(player);
        (uint256 b,) = _mint(player);
        vm.warp(t0 + CARE_COOLDOWN);
        _care(a); // a hatches: score t0+30
        vm.warp(t0 + 1800);
        _care(a); // a refreshes FEED only: its score is STUCK at t0+30 (four needs untouched)
        vm.warp(t0 + 2000);
        _care(b); // b hatches: score t0+2000
        assertEq(vault.leader(), b, "the fresher MIN wins the seat, not the fresher care");
        assertEq(vault.leaderCareAt(), uint64(t0 + 2000));
        assertEq(vault.runnerUpCareAt(), uint64(t0 + CARE_COOLDOWN), "a's stuck min is the runner-up");
        assertEq(maxNeedOf(vault, a), uint64(t0 + 1800), "a DID care more recently, and it counts for nothing");
    }

    // ---- 15. THE key pin: refreshing one need forever does NOT reset the endgame clock -------------
    function test_Tracker_NonMinCareDoesNotResetTheClock() public {
        (uint256 a,) = _mint(player);
        (uint256 rival,) = _mint(player);
        (uint256 c,) = _mint(player);
        vm.warp(t0 + CARE_COOLDOWN);
        _care(a);
        _care(rival);
        _care(c); // 3 hatches at t0+30: contested arms; every score is t0+30
        vm.warp(t0 + 600);
        careAll(vault, a); // the eventual winner keeps everything served: score t0+600

        // The rival "actively cares": it refreshes WATER every 15 minutes, right up to the end. Its
        // MIN stays at the hatch stamp, so it is walking dead and the clock never moves for it.
        uint256[4] memory waterings = [t0 + 900, t0 + 1800, t0 + 2700, t0 + 3300];
        for (uint256 i = 0; i < 4; i++) {
            vm.warp(waterings[i]);
            vm.prank(player);
            vault.care(rival, 1);
        }
        assertEq(minNeedOf(vault, rival), uint64(t0 + CARE_COOLDOWN), "rival's min never moved");

        uint256 decidesAt = _decidesAt();
        assertEq(decidesAt, t0 + CARE_COOLDOWN + LIFE_TTL, "the clock keys on the rival's MIN, full stop");

        // One second early: not over (the rival is technically still alive on its hatch window).
        vm.warp(decidesAt - 1);
        assertTrue(vault.alive(rival), "rival alive to the last second");
        assertFalse(vault.isOver());
        vm.expectRevert(PetVault.GameNotOver.selector);
        vault.finalize();

        // At the exact instant the rival's neglected needs lapse: over, EVEN THOUGH its latest care
        // was minutes ago.
        vm.warp(decidesAt);
        assertEq(maxNeedOf(vault, rival), uint64(t0 + 3300), "rival cared 330s before dying");
        assertTrue(vault.isOver(), "decided on the min, not the latest care");
        assertTrue(vault.alive(a), "the fully-served leader survives");
        vault.finalize();
        assertEq(vault.leader(), a, "the winner is the pet that served everything");
    }

    // ---- 16. a non-leader care that lifts its min (but not past the leader) raises runnerUp --------
    function test_Tracker_CareWithoutTakeoverRaisesRunnerUp() public {
        (uint256 a,) = _mint(player);
        (uint256 b,) = _mint(player);
        vm.warp(t0 + CARE_COOLDOWN);
        _care(a);
        _care(b); // both hatch at t0+30; a holds the seat on the tie
        vm.warp(t0 + 100);
        _care(b); // b refreshes FEED...
        vm.prank(player);
        vault.care(b, 1); // ...and WATER: both at t0+100, the other three at t0+30; min still t0+30
        vm.warp(t0 + 200);
        careAll(vault, a); // leader a, score t0+200; runnerUp = t0+30
        assertEq(vault.leaderCareAt(), uint64(t0 + 200));
        assertEq(vault.runnerUpCareAt(), uint64(t0 + CARE_COOLDOWN));

        // b serves its three t0+30 needs (play/toy/explore). Its min lifts to t0+100 (its oldest
        // remaining stamps): above the old runner-up, below the leader. The slot updates EXACTLY.
        vm.warp(t0 + 300);
        vm.startPrank(player);
        vault.care(b, 2);
        vault.care(b, 3);
        vault.care(b, 4);
        vm.stopPrank();
        assertEq(minNeedOf(vault, b), uint64(t0 + 100), "b's min is its feed/water stamp");
        assertEq(vault.leader(), a, "no takeover: b's min is below the leader's");
        assertEq(vault.runnerUpCareAt(), uint64(t0 + 100), "runnerUp = b's new min, exactly");
    }

    // ---- 17. Lemma 2 pin: a hatch just before the finish line never insta-wins ---------------------
    function test_Endgame_LateHatchNeverInstantWin() public {
        (uint256 a,) = _mint(player);
        (uint256 b,) = _mint(player);
        (uint256 c,) = _mint(player);
        vm.warp(t0 + CARE_COOLDOWN);
        _care(a);
        _care(b);
        _care(c); // contested at t0+30
        vm.warp(t0 + 600);
        careAll(vault, a); // leader a score t0+600; runnerUp/contested t0+30
        uint256 decidesBefore = _decidesAt();
        assertEq(decidesBefore, t0 + CARE_COOLDOWN + LIFE_TTL);

        // The snipe: a dormant egg hatches as late as the roster still allows. Under the roster close
        // that is entryDeadline - 1, not decidesAt - 1, and the second half of this test pins the
        // difference. Lemma 2 has to hold for every hatch the contract still accepts, which is what
        // this half is for.
        (uint256 d, address tbaD) = _mint(player);
        (uint256 e,) = _mint(player); // a second egg, kept dormant for the roster-close half below
        vm.warp(vault.entryDeadline() - 1);
        assertLt(block.timestamp, decidesBefore, "the latest legal hatch is inside the live season");
        _care(d); // lands: the board is not yet frozen and entry is still open
        assertFalse(vault.isOver(), "no instant win at the moment of the snipe");
        assertEq(vault.leader(), d, "the hatchling's score (now) takes the seat");
        assertEq(vault.runnerUpCareAt(), uint64(t0 + 600), "old leader's score demotes to runner-up");

        // The finish line moved OUT (never in): to a full window past the old leader's score.
        uint256 decidesAfter = _decidesAt();
        assertEq(decidesAfter, t0 + 600 + LIFE_TTL, "decidesAt = oldLeaderScore + lifeTtl");
        assertGe(decidesAfter, decidesBefore, "Lemma 2: the decision time never moves earlier");

        // THE ROSTER CLOSE, which is what actually retires this whole attack shape. One second later
        // entry is shut, and the identical snipe on the identical dormant egg is refused outright
        // rather than merely being made unprofitable. Note the error is specific, so a keeper sees
        // "the roster closed" and not a generic failure.
        vm.warp(vault.entryDeadline());
        vm.prank(player);
        vm.expectRevert(PetVault.EntryWindowClosed.selector);
        vault.care(e, 0);
        // The egg is not damaged by the refusal: it never hatched, so it is neither alive nor dead,
        // and it stays a freely transferable collectible rather than a soulbound brick.
        assertFalse(vault.alive(e));
        assertFalse(vault.isDead(e));

        vm.warp(decidesAfter - 1);
        assertFalse(vault.isOver(), "a is still alive on its t0+600 round");
        vm.warp(decidesAfter);
        assertTrue(vault.isOver());
        uint256 prize = vault.pot();
        uint256 before = care.balanceOf(tbaD);
        vault.finalize();
        assertEq(care.balanceOf(tbaD) - before, prize, "the snipe wins only by outliving everyone");
    }

    // ---- 18. same-second tie: the INCUMBENT keeps the seat (strictly-greater takeover) -------------
    function test_Tracker_SameSecondTieIncumbentHolds() public {
        (uint256 a,) = _mint(player);
        (uint256 b,) = _mint(player);
        (uint256 c,) = _mint(player);
        (uint256 egg,) = _mint(player);
        vm.warp(t0 + CARE_COOLDOWN);
        _care(a);
        _care(b);
        _care(c); // a leads (first hatch of the tied second); contested t0+30
        vm.warp(t0 + 500);
        careAll(vault, a); // the incumbent lifts its min to t0+500
        assertEq(vault.leader(), a);
        assertEq(vault.leaderCareAt(), uint64(t0 + 500));

        _care(egg); // a fresh egg hatches THE SAME SECOND: score t0+500, NOT strictly greater
        assertEq(vault.leader(), a, "tie: the incumbent holds the seat");
        assertEq(vault.leaderCareAt(), uint64(t0 + 500));
        assertEq(vault.runnerUpCareAt(), uint64(t0 + 500), "the tied challenger fills the runner-up");
        (,, uint256 winsAt,) = vault.settlementState();
        assertEq(winsAt, t0 + 500 + LIFE_TTL, "the tie correctly holds the finish a full window out");
    }

    // ---- 19. a takeover past a DEAD ex-leader inherits its frozen score into runnerUp --------------
    function test_Tracker_DeadExLeaderTakeover() public {
        // This scenario needs a pet to hatch AFTER an earlier pet has already died, so the roster
        // has to outlive one life window. That is the production shape (the deploy script requires
        // ENTRY_WINDOW_SECS > LIFE_TTL); the suite default of exactly one window is a migration
        // convenience for the endgame timing assertions elsewhere in this file.
        _useLongerRoster(2 * LIFE_TTL);
        (uint256 a,) = _mint(player);
        (uint256 b,) = _mint(player);
        (uint256 c, address tbaC) = _mint(player);
        vm.warp(t0 + CARE_COOLDOWN);
        _care(a);
        _care(b); // only 2 hatched (< minPlayers): the endgame CANNOT arm; a leads on the tie
        assertEq(vault.leader(), a);

        // Both lapse. The LEADER is now dead with its score frozen at S = t0+30, but the game is
        // held open by the minPlayers gate, so the board is not frozen.
        vm.warp(t0 + CARE_COOLDOWN + LIFE_TTL + 1000);
        assertTrue(vault.isDead(a), "the ex-leader is dead");
        assertTrue(vault.isDead(b));
        assertFalse(vault.isOver(), "under minPlayers the season cannot decide");

        // c hatches PAST the dead leader: strictly greater score takes the seat, and the DEAD
        // leader's frozen score S is inherited into runnerUpCareAt (raising _decidesAt, never
        // lowering it: the tracker never forgets a score).
        uint256 hatchC = block.timestamp;
        _care(c);
        assertEq(vault.leader(), c, "takeover past a dead ex-leader");
        assertEq(vault.runnerUpCareAt(), uint64(t0 + CARE_COOLDOWN), "dead leader's frozen score inherited");
        assertEq(uint256(vault.contestedAt()), hatchC, "contested arms at this third hatch");
        assertFalse(vault.isOver(), "never decided while the new leader's window still runs");

        // finalize refuses while any pet lives; at c's own deadline it pays c (last standing).
        uint256 decidesAt = _decidesAt();
        assertEq(decidesAt, hatchC + LIFE_TTL, "the clock runs from the contested instant");
        vm.warp(decidesAt - 1);
        assertTrue(vault.alive(c));
        vm.expectRevert(PetVault.GameNotOver.selector);
        vault.finalize();
        vm.warp(decidesAt);
        uint256 prize = vault.pot();
        uint256 before = care.balanceOf(tbaC);
        vault.finalize();
        assertEq(care.balanceOf(tbaC) - before, prize, "the sole reachable survivor takes the pot");
    }

    // ---- authorization + cooldown ------------------------------------------------------------------
    function test_CareIsStrictlyOwnerOnly() public {
        (uint256 a,) = _mint(player);
        vm.warp(t0 + CARE_COOLDOWN);
        // NO non-owner may care: not a stranger, and not the issuer's mint relayer either (there is
        // no care relayer on the vault at all since audit access-H-1).
        address stranger = makeAddr("stranger");
        vm.prank(stranger);
        vm.expectRevert(PetVault.NotAuthorizedCarer.selector);
        vault.care(a, 0);
        vm.prank(relayer);
        vm.expectRevert(PetVault.NotAuthorizedCarer.selector);
        vault.care(a, 0);
        // Only the pet's owner may care their own.
        vm.prank(player);
        vault.care(a, 0);
    }

    function test_Cooldown() public {
        (uint256 a,) = _mint(player);
        vm.warp(t0 + CARE_COOLDOWN);
        _care(a);
        vm.prank(player); // the owner itself is rate-limited
        vm.expectRevert(PetVault.CareOnCooldown.selector);
        vault.care(a, 0);
    }

    // ---- adversarial: the operator has NO care lever left at all (audit access-H-1) ----------------
    function test_OperatorCannotForceCareRival_CareIsOwnerOnly() public {
        address opWallet = makeAddr("operatorPet");
        (uint256 op,) = _mint(opWallet);
        (uint256 rival,) = _mint(player);
        (uint256 c,) = _mint(player);
        vm.warp(t0 + CARE_COOLDOWN);
        _care(op);
        _care(c);
        // The OLD steering lever: the operator (relayer key or vault owner) force-feeding the rival's
        // pet to drain it or shuffle the lead. GONE: both revert NotAuthorizedCarer.
        vm.prank(relayer);
        vm.expectRevert(PetVault.NotAuthorizedCarer.selector);
        vault.care(rival, 0);
        vm.prank(owner);
        vm.expectRevert(PetVault.NotAuthorizedCarer.selector);
        vault.care(rival, 0);
        // Only the rival's own owner enters it into the race, and that strictly-later hatch makes
        // the RIVAL the leader.
        vm.warp(t0 + 2 * CARE_COOLDOWN);
        vm.prank(player);
        vault.care(rival, 0);
        assertEq(vault.leader(), rival, "only the rival's own care lands, and it leads the race");
        // For the operator's pet to lead, its OWNER must serve all five needs, like any player.
        vm.warp(t0 + 3 * CARE_COOLDOWN);
        careAll(vault, op);
        assertEq(vault.leader(), op);
    }

    // ---- audit access-H-1 regression: care is OWNER-ONLY and there is NO relayer -------------------
    //      Ownership is the sole care capability and it follows the NFT on transfer.
    function test_Audit_CareIsOwnerOnly_NoRelayer() public {
        (uint256 a,) = _mint(player);
        vm.warp(t0 + CARE_COOLDOWN);

        // A third party cannot care a pet it does not own.
        address thirdParty = makeAddr("thirdParty");
        vm.prank(thirdParty);
        vm.expectRevert(PetVault.NotAuthorizedCarer.selector);
        vault.care(a, 0);

        // The old "relayer" key has no care power either: the relayer path no longer exists.
        vm.prank(relayer);
        vm.expectRevert(PetVault.NotAuthorizedCarer.selector);
        vault.care(a, 0);

        // The owner succeeds.
        vm.prank(player);
        vault.care(a, 0);
        assertEq(vault.leader(), a, "owner care landed");

        // After an owner-to-owner transfer, ONLY the new owner may care; the old owner is now just
        // another stranger to this pet.
        address newOwner = makeAddr("newOwner");
        vm.prank(player);
        pet.transferFrom(player, newOwner, a);
        vm.warp(block.timestamp + CARE_COOLDOWN);
        vm.prank(player);
        vm.expectRevert(PetVault.NotAuthorizedCarer.selector);
        vault.care(a, 0);
        vm.prank(newOwner);
        vault.care(a, 0);
        (,,, uint32 cc,) = vault.memorialState(a);
        assertEq(cc, 2, "the new owner's care landed");
    }

    // ================================================================================================
    // AUDIT REGRESSION SUITE (2026-08 fixes). Each test locks in one audit fix for good.
    // ================================================================================================

    // ---- audit H-1: HIJACK BLOCKED. The instant the game is DECIDED (isOver true, even before
    //      finalize) the board is frozen: no care (not even hatching a dormant egg) and no new
    //      registration. A latecomer fed once can no longer become "leader" of a decided game and
    //      steal the pot; finalize pays the RIGHTFUL leader.
    function test_Audit_HijackBlocked_DecidedGameFreezesCareAndRegister() public {
        (uint256 a,) = _mint(player);
        (uint256 b,) = _mint(player);
        (uint256 c, address tbaC) = _mint(player);
        address late = makeAddr("latecomer");
        (uint256 d, address tbaD) = _mint(late); // the would-be hijacker's egg, registered in time

        vm.warp(t0 + CARE_COOLDOWN);
        _care(a);
        _care(b);
        vm.warp(t0 + 2 * CARE_COOLDOWN);
        _care(c); // leader = c; runnerUp = a/b's feed time; 3 hatched >= minPlayers

        // The game DECIDES a full life window after the LATER of the runner-up's care and the moment
        // the race became contested (PetVault.contestedAt); it is NOT yet finalized.
        uint256 rDecides = uint256(vault.runnerUpCareAt());
        if (uint256(vault.contestedAt()) > rDecides) rDecides = uint256(vault.contestedAt());
        vm.warp(rDecides + LIFE_TTL);
        assertTrue(vault.isOver(), "decided: every rival of the leader has lapsed");
        assertFalse(vault.potClaimed(), "not yet finalized");
        assertEq(vault.leader(), c, "c is the rightful leader");

        // THE OLD HIJACK: feed the dormant egg d once and become leader of a decided game. Frozen.
        vm.prank(late);
        vm.expectRevert(PetVault.GameOver.selector);
        vault.care(d, 0);
        // Even the leader's own owner cannot keep feeding a decided game.
        vm.prank(player);
        vm.expectRevert(PetVault.GameOver.selector);
        vault.care(c, 0);
        // NO NEW PET CAN BE MINTED INTO A DECIDED GAME AT ALL. This used to succeed and hand the buyer
        // an unregistered token that looked live, could never be fed and could never win. It is now
        // refused with a named error, and refused BEFORE pet.mint(), so nothing in the collection is
        // consumed by the attempt. The season could not have been decided while entry was open in the
        // first place, because _decidesAt() is floored at entryDeadline, so a keeper who minted in
        // time is guaranteed a season to play. That is the whole roster-close bargain.
        uint256 mintedBefore = pet.totalMinted();
        vm.prank(relayer);
        vm.expectRevert(PetIssuer.EntryWindowClosed.selector);
        issuer.issuePet(late);
        assertEq(pet.totalMinted(), mintedBefore, "a refused late mint consumes no supply");
        assertGe(block.timestamp, vault.entryDeadline(), "the decision really is at or after the close");

        assertEq(vault.leader(), c, "leader untouched by every hijack attempt");

        // finalize pays the RIGHTFUL leader's TBA the whole pot; the latecomer gets nothing.
        uint256 prize = vault.pot();
        assertGt(prize, 0);
        uint256 beforeC = care.balanceOf(tbaC);
        uint256 beforeD = care.balanceOf(tbaD);
        vault.finalize();
        assertTrue(vault.potClaimed());
        assertEq(care.balanceOf(tbaC) - beforeC, prize, "whole pot to the rightful leader's TBA");
        assertEq(care.balanceOf(tbaD), beforeD, "the latecomer's TBA got nothing");
    }

    // ---- audit H-2: NO RESURRECTION. lifeTtl is a constructor immutable and the whole tuning
    //      surface (setLifeTtl / lockConfig / configLocked) no longer exists on the vault, so a dead
    //      pet can never be revived by lengthening the life window. A dead pet's care always reverts
    //      PetIsDead, forever.
    function test_Audit_NoResurrection_DeadStaysDeadAndNoLifeTtlTuning() public {
        (uint256 a,) = _mint(player);
        vm.warp(t0 + CARE_COOLDOWN);
        _care(a); // hatch
        vm.warp(t0 + CARE_COOLDOWN + LIFE_TTL); // lapse
        assertTrue(vault.isDead(a), "hatched then lapsed: dead");

        // The resurrection lever is gone from the ABI: no setter, no lock, nothing left to re-tune.
        vm.startPrank(owner);
        (bool okSet,) = address(vault).call(abi.encodeWithSignature("setLifeTtl(uint256)", 30 days));
        assertFalse(okSet, "setLifeTtl does not exist on the vault");
        (bool okLock,) = address(vault).call(abi.encodeWithSignature("lockConfig()"));
        assertFalse(okLock, "lockConfig does not exist on the vault");
        (bool okViewLocked,) = address(vault).call(abi.encodeWithSignature("configLocked()"));
        assertFalse(okViewLocked, "configLocked does not exist on the vault");
        vm.stopPrank();
        assertEq(vault.lifeTtl(), LIFE_TTL, "lifeTtl is the constructor value forever");

        // Care on the dead pet always reverts PetIsDead, now and across any amount of time (its own
        // owner is the strongest possible caller under the owner-only rule, and even it is refused).
        vm.prank(player);
        vm.expectRevert(PetVault.PetIsDead.selector);
        vault.care(a, 0);
        vm.warp(block.timestamp + 3650 days);
        assertTrue(vault.isDead(a), "still dead a decade later");
        vm.prank(player);
        vm.expectRevert(PetVault.PetIsDead.selector);
        vault.care(a, 0);
    }

    // ---- audit death-F1: EGG NOT SOULBOUND. A never-fed egg has no life timer: long past lifeTtl it
    //      is neither alive nor dead, transfers owner-to-owner freely, and hatches at ANY time with
    //      no cooldown wait (the life clock starts at that first care). A pet that hatched then
    //      lapsed IS dead + soulbound as before.
    function test_Audit_EggNotSoulbound_TransfersAndHatchesAnytime() public {
        (uint256 e,) = _mint(player); // the long-dormant egg
        (uint256 f,) = _mint(player); // the hatch-then-lapse control pet
        (uint256 g,) = _mint(player); // a second egg, deliberately left dormant past the roster close

        // A full life window has passed since mint with no care at all. Under the old pre-audit rule
        // the egg would already be a bricked memorial; it has no timer, so it is neither.
        vm.warp(vault.entryDeadline() - 1);
        assertGt(block.timestamp, t0 + LIFE_TTL - 2, "the egg really has outlasted a life window");
        assertFalse(vault.isDead(e), "egg: not dead (its timer never started)");
        assertFalse(vault.alive(e), "egg: not alive either (dormant)");
        assertFalse(pet.isDead(e), "Pet721 death oracle agrees: not dead");

        // Owner-to-owner transfers flow freely, both directions: Pet721 does not block the egg.
        address buyer = makeAddr("eggBuyer");
        vm.prank(player);
        pet.transferFrom(player, buyer, e);
        assertEq(pet.ownerOf(e), buyer, "dormant egg transferred");
        vm.prank(buyer);
        pet.transferFrom(buyer, player, e);
        assertEq(pet.ownerOf(e), player, "and back again: never soulbound");

        // HATCH: the first care lands immediately (no cooldown wait: nothing was ever on cooldown)
        // and starts the life clock NOW.
        uint256 hatchAt = block.timestamp;
        vm.prank(player);
        vault.care(e, 0);
        assertTrue(vault.alive(e), "hatched: alive");
        (, uint64 lastCareAt, uint256 deadline) = vault.lifeState(e);
        assertEq(lastCareAt, uint64(hatchAt), "life clock starts at the first care");
        assertEq(deadline, hatchAt + LIFE_TTL, "deadline = hatch + lifeTtl");
        // ...and the per-pet cooldown only starts ticking from the hatch.
        vm.prank(player);
        vm.expectRevert(PetVault.CareOnCooldown.selector);
        vault.care(e, 0);

        // CONTROL: pet f hatches then lapses -> dead + soulbound exactly as before.
        vm.prank(player);
        vault.care(f, 0); // f's first care also lands instantly
        vm.warp(block.timestamp + LIFE_TTL);
        assertTrue(vault.isDead(f), "hatched-then-lapsed pet is dead");
        vm.prank(player);
        vm.expectRevert(abi.encodeWithSelector(Pet721.PetIsDead.selector, f));
        pet.transferFrom(player, buyer, f);

        // AND THE ROSTER CLOSE DOES NOT REINTRODUCE THE BRICK IT WAS ADDED ALONGSIDE. Egg g sat
        // dormant straight through the deadline. Its hatch is refused with a named error, but it is
        // still not dead, so it is still freely transferable, forever. An egg that missed the roster
        // is a collectible, never an unsellable memorial: that is the exact distinction audit
        // death-F1 established and the roster close must not blur.
        assertGe(block.timestamp, vault.entryDeadline(), "we are past the roster close");
        vm.prank(player);
        vm.expectRevert(PetVault.EntryWindowClosed.selector);
        vault.care(g, 0);
        assertFalse(vault.isDead(g), "a missed-roster egg is never dead");
        vm.prank(player);
        pet.transferFrom(player, buyer, g);
        assertEq(pet.ownerOf(g), buyer, "and it still trades freely after the roster closed");
    }

    // ---- audit econ-F1: SWEEP is surplus-only ALWAYS while the pot is unclaimed. With a live
    //      winnable pot the owner cannot sweep a single wei of it, and there is no stranded-pot burn
    //      path any more: the sweep never burns and never touches `pot`.
    function test_Audit_Sweep_SurplusOnlyNeverTouchesLivePot() public {
        (uint256 a,) = _mint(player);
        (uint256 b,) = _mint(player);
        (uint256 c,) = _mint(player);
        vm.warp(t0 + CARE_COOLDOWN);
        _care(a);
        _care(b);
        _care(c); // 3 hatched >= minPlayers: a live, winnable pot
        uint256 pot = vault.pot();
        assertGt(pot, 0);
        uint256 burnBefore = care.balanceOf(BURN);
        uint256 totalBurnedBefore = vault.totalBurned();

        // Zero surplus: even a 1-wei careToken sweep reverts after the full timelock.
        vm.startPrank(owner);
        vault.queueSweep(address(care), owner, 1);
        vm.warp(block.timestamp + vault.SWEEP_TIMELOCK());
        vm.expectRevert(PetVault.SweepExceedsSurplus.selector);
        vault.executeSweep();
        assertEq(vault.pot(), pot, "live pot untouched");

        // Donated dust ABOVE the pot is the only sweepable careToken value; pot and the burn ledgers
        // are untouched by the sweep (no stranded-pot burn path exists).
        care.mint(address(vault), 3e18);
        vault.queueSweep(address(care), owner, 3e18);
        vm.warp(block.timestamp + vault.SWEEP_TIMELOCK());
        vault.executeSweep();
        vm.stopPrank();

        assertEq(care.balanceOf(owner), 3e18, "owner got exactly the donated surplus");
        assertEq(vault.pot(), pot, "pot preserved");
        assertEq(care.balanceOf(address(vault)), pot, "vault still fully backs the pot");
        assertEq(care.balanceOf(BURN), burnBefore, "sweep burned nothing");
        assertEq(vault.totalBurned(), totalBurnedBefore, "no burn accounting from the sweep");
    }
}
