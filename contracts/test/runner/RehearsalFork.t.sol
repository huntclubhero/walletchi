// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test, console} from "forge-std/Test.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {IERC6551Registry} from "erc6551/interfaces/IERC6551Registry.sol";

import {WalletchiAccount} from "../../src/WalletchiAccount.sol";
import {Pet721} from "../../src/runner/Pet721.sol";
import {PetIssuer} from "../../src/runner/PetIssuer.sol";
import {PetVault, IPetCareSpender} from "../../src/runner/PetVault.sol";
import {RewardsDistributor} from "../../src/runner/RewardsDistributor.sol";
import {MockCareToken} from "../../src/runner/MockCareToken.sol";
import {careAll} from "./utils/FiveNeedsTestLib.sol";

/// @notice FULL-SEASON dress rehearsal against the REAL Robinhood Chain state, using the canonical
///         ERC-6551 registry that already lives there. Deploys a fresh FIVE-NEEDS WALLETCHI
///         LAST-PET-STANDING game onto a fork with short rehearsal timers (lifeTtl 1h, PER-NEED
///         cooldown 30s) and stages the ENTIRE lifecycle: mint -> hatch (all five bowls fill at
///         once) -> the careAll survival ritual (min-need two-slot tracker) -> per-need cooldown ->
///         time-based any-need-lapsed deaths + the death-soulbound -> the last survivor ->
///         permissionless finalize pays the WHOLE pot into the winner's TBA -> game-over, asserting
///         the on-chain money + life/death at every step. vm.warp drives time since the 1h lifeTtl
///         cannot be waited out live.
///
///         Skipped unless FORK_RPC is set (keeps the offline suite green). The public RPCs are not
///         archive nodes, so pin a recent FORK_BLOCK. Run with:
///           FORK_RPC=https://rpc.testnet.chain.robinhood.com FORK_BLOCK=<recent> \
///             forge test --match-path test/runner/RehearsalFork.t.sol -vv
contract RehearsalForkTest is Test {
    address constant CANONICAL_REGISTRY = 0x000000006551c19487814612e58FE06813775758;
    address internal constant BURN = 0x000000000000000000000000000000000000dEaD;

    // Rehearsal params.
    uint256 internal constant MAX_SUPPLY = 2000;
    uint256 internal constant MIN_PLAYERS = 3;
    uint256 internal constant LIFE_TTL = 3600; // 1h (== MIN_LIFE_TTL)
    uint256 internal constant CARE_COST = 1e18;
    uint256 internal constant POT_BPS = 1000; // 10%
    uint256 internal constant BURN_BPS = 9000; // 90% (two-leg rehearsal)
    uint256 internal constant CARE_COOLDOWN = 30;
    uint256 internal constant PER_TX_CAP = 1e18;
    uint256 internal constant DAILY_CAP = 1000e18;
    uint256 internal constant STARTER = 100e18;
    uint256 internal constant FLOAT = 10_000e18;

    MockCareToken internal care;
    WalletchiAccount internal impl;
    Pet721 internal pet;
    PetIssuer internal issuer;
    PetVault internal vault;

    address internal owner;
    address internal relayer;
    address internal player;
    address internal poker;

    uint256[7] internal id; // 1-indexed: id[1..6]
    address[7] internal tba;
    uint256 internal t0;

    function test_FullSeasonRehearsal() public {
        string memory rpc = vm.envOr("FORK_RPC", string(""));
        if (bytes(rpc).length == 0) {
            vm.skip(true);
            return;
        }
        uint256 forkBlock = vm.envOr("FORK_BLOCK", uint256(0));
        if (forkBlock > 0) {
            vm.createSelectFork(rpc, forkBlock);
        } else {
            vm.createSelectFork(rpc);
        }
        assertGt(CANONICAL_REGISTRY.code.length, 0, "registry not on this chain");

        _deploy();
        _mintSix();
        _carePhase();
        _deathPhase();
        _settlePhase();
    }

    // ------------------------------------------------------------------------------------------------
    // 0. Deploy a fresh WALLETCHI game onto the fork (real registry, fresh account impl), wired and
    //    locked in the production posture.
    // ------------------------------------------------------------------------------------------------
    function _deploy() internal {
        owner = makeAddr("owner");
        relayer = makeAddr("relayer");
        player = makeAddr("player");
        poker = makeAddr("poker");

        vm.startPrank(owner);
        care = new MockCareToken();
        impl = new WalletchiAccount();
        pet = new Pet721("WALLETCHI", "WCHI", MAX_SUPPLY, owner, owner, "");
        issuer = new PetIssuer(
            pet,
            IERC6551Registry(CANONICAL_REGISTRY),
            address(impl),
            IERC20(address(care)),
            relayer,
            owner,
            PER_TX_CAP,
            DAILY_CAP,
            STARTER
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
        pet.setVaultRef(address(vault)); // wire the death-soulbound oracle
        pet.lockIssuer();
        issuer.lockVault(); // production posture: freeze the spender's vault (audit M-A)
        pet.lockVaultRef();
        vm.stopPrank();

        care.mint(address(issuer), FLOAT);
        t0 = block.timestamp;

        console.log("== DEPLOYED on fork ==");
        console.log("PetVault:", address(vault));
        console.log("PetIssuer:", address(issuer));
        console.log("MockCareToken:", address(care));
        console.log("t0:", t0);
    }

    // ------------------------------------------------------------------------------------------------
    // 1. Mint 6 pets; each TBA is seeded with the starter float.
    // ------------------------------------------------------------------------------------------------
    function _mintSix() internal {
        console.log("== 1. MINT 6 (each TBA seeded) ==");
        for (uint256 i = 1; i <= 6; i++) {
            vm.prank(relayer);
            (uint256 tid, address acct) = issuer.issuePet(player);
            id[i] = tid;
            tba[i] = acct;
            assertGt(acct.code.length, 0, "real-registry TBA created");
            assertEq(care.balanceOf(acct), STARTER, "TBA seeded with starter");
            assertEq(issuer.accountOf(tid), acct, "accountOf matches");
            console.log("minted pet id:", tid);
            console.log("  TBA:", acct);
            console.log("  seeded:", care.balanceOf(acct));
        }
        assertEq(vault.registeredCount(), 6);
        assertEq(vault.hatchedCount(), 0, "nobody fed yet");
    }

    // ------------------------------------------------------------------------------------------------
    // 2. Care phase under FIVE NEEDS. Schedule (per-need 30s cooldown): pets 1-4 hatch at t0+30 (one
    //    care each fills all five bowls; pet 1, first hatch of the tied second, holds the leader
    //    seat). Per-need cooldown is pinned right at the hatch: re-serving the hatch's paying need in
    //    the same block reverts, a DIFFERENT need in the same block lands. Pets 2 and 3 then trade
    //    the lead on full careAll rounds (a pet's SCORE is its min-need, so only serving all five
    //    moves it); pet 2's round at t0+120 is the last, so it is the standing winner and the
    //    runner-up slot ends at pet 3's round (t0+90), setting the finish line at t0+90+lifeTtl.
    // ------------------------------------------------------------------------------------------------
    function _carePhase() internal {
        console.log("== 2. CARE PHASE (five needs) ==");
        vm.warp(t0 + 30);
        _hatchAndAssert(1);
        _hatchAndAssert(2);

        // PER-NEED COOLDOWN, pinned on the fork right after pet 2's hatch (same block):
        // the hatch paid with FEED, so FEED is on its 30s cooldown...
        vm.prank(player);
        vm.expectRevert(PetVault.CareOnCooldown.selector);
        vault.care(id[2], 0);
        // ...but WATER (a different need, never explicitly cared) lands in the SAME block...
        vm.prank(player);
        vault.care(id[2], 1);
        // ...and immediately re-serving WATER now reverts on ITS own cooldown.
        vm.prank(player);
        vm.expectRevert(PetVault.CareOnCooldown.selector);
        vault.care(id[2], 1);

        _hatchAndAssert(3);
        _hatchAndAssert(4);
        assertEq(vault.leader(), id[1], "tied hatches: the FIRST hatch of the second holds the seat");

        vm.warp(t0 + 60);
        careAll(vault, id[2]); // pet 2 serves all five: score t0+60, takes the lead
        assertEq(vault.leader(), id[2], "a full five-need round takes the seat");
        careAll(vault, id[3]); // pet 3 ties at t0+60: the incumbent holds
        assertEq(vault.leader(), id[2], "same-second tie: incumbent keeps the lead");
        assertEq(vault.runnerUpCareAt(), uint64(t0 + 60), "the tied round fills the runner-up slot");

        vm.warp(t0 + 90);
        careAll(vault, id[3]); // pet 3 strictly later: takes the lead
        assertEq(vault.leader(), id[3]);

        vm.warp(t0 + 120);
        careAll(vault, id[2]); // pet 2's final round: the last full service of the season
        assertEq(vault.leader(), id[2]);

        // 4 hatches + 1 water + 4 careAll rounds (20) = 25 cares total.
        assertEq(vault.pot(), 25 * _potShare(), "pot after care phase");
        assertEq(vault.totalBurned(), 25 * _burnShare(), "burned after care phase");
        assertEq(care.balanceOf(BURN), 25 * _burnShare(), "dead address holds the burn");
        assertEq(vault.hatchedCount(), 4, "pets 1-4 hatched into the race");

        // The min-need two-slot tracker: pet 2 (greatest min-need, t0+120) leads; the best OTHER
        // score is pet 3's t0+90 round, so the game ends at t0+90+lifeTtl unless someone else
        // serves a full round.
        assertEq(vault.leader(), id[2], "leader = the pet with the freshest weakest-link");
        assertEq(vault.leaderCareAt(), uint64(t0 + 120), "leaderCareAt = pet 2's min-need");
        assertEq(vault.runnerUpCareAt(), uint64(t0 + 90), "runnerUp = pet 3's min-need");
        uint64[5] memory n2 = vault.needsOf(id[2]);
        for (uint256 k = 0; k < 5; k++) {
            assertEq(n2[k], uint64(t0 + 120), "pet 2's five needs all sit at its final round");
        }
        (,,, uint32 cc2,) = vault.memorialState(id[2]);
        assertEq(cc2, 12, "pet 2: hatch + water + two full five-need rounds");
        console.log("care phase pot:", vault.pot());
        console.log("leader:", vault.leader());
        console.log("runnerUpCareAt:", vault.runnerUpCareAt());
    }

    function _hatchAndAssert(uint256 i) internal {
        uint256 tid = id[i];
        address acct = tba[i];

        uint256 potBefore = vault.pot();
        uint256 burnBefore = care.balanceOf(BURN);
        uint256 acctBefore = care.balanceOf(acct);

        vm.prank(pet.ownerOf(tid)); // owner-only care (audit access-H-1); every pet here is player's
        vault.care(tid, 0); // the hatch: ONE care, all five bowls fill at this instant

        (bool aliveAfter, uint64 lastCareAt,) = vault.lifeState(tid);
        (,,, uint32 ccAfter,) = vault.memorialState(tid);
        uint64[5] memory needs = vault.needsOf(tid);

        assertEq(vault.pot() - potBefore, _potShare(), "pot grows by potBps");
        assertEq(care.balanceOf(BURN) - burnBefore, _burnShare(), "dead address grows by burnBps");
        assertEq(acctBefore - care.balanceOf(acct), CARE_COST, "TBA debits careCost");
        assertEq(ccAfter, 1, "the hatch is one care");
        for (uint256 k = 0; k < 5; k++) {
            assertEq(needs[k], uint64(block.timestamp), "hatch stamps every need to now");
        }
        assertEq(lastCareAt, uint64(block.timestamp), "min-need == now at hatch");
        assertTrue(aliveAfter, "pet alive after hatch");

        console.log("hatched pet id:", tid);
        console.log("  pot:", vault.pot());
        console.log("  min-need:", lastCareAt);
    }

    // ------------------------------------------------------------------------------------------------
    // 3. TIME-BASED DEATH: the two never-cared pets (5, 6) are DORMANT EGGS (audit death-F1): they
    //    have no life timer, read neither alive nor dead, and stay freely transferable. The fed-once
    //    pets (1, 4) lapse at t0+30+lifeTtl with no reap step and become permanent soulbound
    //    memorials; the recently fed pets are still alive; the game is not yet over.
    // ------------------------------------------------------------------------------------------------
    function _deathPhase() internal {
        console.log("== 3. TIME-BASED DEATHS (no reap step; eggs are dormant) ==");
        // A full life window past MINT: the never-fed eggs do NOT die (their clock never started).
        vm.warp(t0 + LIFE_TTL + 1);
        assertFalse(vault.alive(id[5]), "egg 5 is not alive (never hatched)");
        assertFalse(vault.isDead(id[5]), "egg 5 is NOT dead either: a dormant egg has no timer");
        assertFalse(vault.alive(id[6]), "egg 6 is not alive");
        assertFalse(vault.isDead(id[6]), "egg 6 is not dead");
        assertTrue(vault.alive(id[1]), "pet 1 (fed at t0+30) still alive");
        assertTrue(vault.alive(id[2]), "pet 2 still alive");

        // The dormant egg's memorial read: not dead, no diedAt, zero cares.
        (bool deadEgg,, uint64 diedAtEgg, uint32 ccEgg,) = vault.memorialState(id[5]);
        assertFalse(deadEgg, "egg 5 is no memorial");
        assertEq(diedAtEgg, 0, "no death instant for a dormant egg");
        assertEq(ccEgg, 0, "never cared");

        // NOT soulbound: the never-fed egg transfers owner-to-owner freely (it never bricked).
        vm.prank(player);
        pet.transferFrom(player, poker, id[5]);
        assertEq(pet.ownerOf(id[5]), poker, "dormant egg transferred freely");
        vm.prank(player);
        pet.transferFrom(player, poker, id[1]); // a live fed pet also moves freely
        assertEq(pet.ownerOf(id[1]), poker, "live pet transferred");

        // A full life window past the FED-ONCE pets' hatch (t0+30): pets 1 and 4 are dead by the
        // clock; the recently fed pets 2 (t0+150) and 3 (t0+90) are still alive.
        vm.warp(t0 + 30 + LIFE_TTL + 1);
        assertFalse(vault.alive(id[1]), "pet 1 lapsed");
        assertTrue(vault.isDead(id[1]), "pet 1 DEAD purely by the clock");
        assertFalse(vault.alive(id[4]), "pet 4 lapsed");
        assertTrue(vault.isDead(id[4]), "pet 4 dead");
        assertTrue(vault.alive(id[2]), "pet 2 still alive");
        assertTrue(vault.alive(id[3]), "pet 3 still alive");

        // The memorial read: diedAt is the exact lapse instant of the WEAKEST need (for a
        // hatched-once pet all five sit at the hatch, so every need lapsed together), careCount
        // preserved, rank off-chain.
        (bool dead, uint64 bornAt, uint64 diedAt, uint32 careCount, uint32 rank) = vault.memorialState(id[1]);
        assertTrue(dead, "pet 1 memorialized");
        assertEq(bornAt, uint64(t0), "bornAt = mint time");
        assertEq(diedAt, uint64(t0 + 30 + LIFE_TTL), "diedAt = min-need + lifeTtl exactly");
        assertEq(careCount, 1, "cared once");
        assertEq(rank, 0, "rank derived off-chain");
        uint64[5] memory n1 = vault.needsOf(id[1]);
        for (uint256 k = 0; k < 5; k++) {
            assertEq(n1[k], uint64(t0 + 30), "hatch-only pet: every need froze at the hatch stamp");
        }

        // Death is permanent: a dead pet can never be fed again (not even by its current owner).
        vm.prank(poker); // pet 1 was transferred to poker above
        vm.expectRevert(PetVault.PetIsDead.selector);
        vault.care(id[1], 0);

        // Death-soulbound (time-based oracle): the dead hatched pet cannot move.
        vm.prank(poker);
        vm.expectRevert(abi.encodeWithSelector(Pet721.PetIsDead.selector, id[1]));
        pet.transferFrom(poker, player, id[1]);

        // The game is NOT over yet: pet 3's feed (t0+90) is still inside its life window.
        assertFalse(vault.isOver(), "not over while a non-leader is still alive");
        vm.expectRevert(PetVault.GameNotOver.selector);
        vault.finalize();

        console.log("dead so far: pets 1 and 4 (hatched then lapsed); eggs 5 and 6 stay dormant");
        console.log("  diedAt:", diedAt);
    }

    // ------------------------------------------------------------------------------------------------
    // 4-6. THE WIN: at runnerUpCareAt + lifeTtl every pet but the leader has lapsed. finalize() is
    //      permissionless and pays the WHOLE pot into the winner's TBA; then the game is over for good.
    // ------------------------------------------------------------------------------------------------
    function _settlePhase() internal {
        console.log("== 4-6. LAST PET STANDING ==");
        uint256 winnerId = id[2];
        uint256 finishLine = _decidesAt(); // a full life window after the season was decided

        vm.warp(finishLine);
        assertTrue(vault.isOver(), "game over: only the leader's feed stands");
        assertTrue(vault.alive(winnerId), "pet 2 is the last pet standing");
        assertFalse(vault.alive(id[1]), "pet 1 lapsed");
        assertFalse(vault.alive(id[3]), "pet 3 lapsed at the finish line");
        assertFalse(vault.alive(id[4]), "pet 4 lapsed");

        // HIJACK FREEZE (audit H-1), proven on the fork: the game is decided but not yet finalized;
        // hatching the dormant egg 6 now must NOT steal the decided pot: the board is frozen.
        vm.prank(player); // egg 6's own owner
        vm.expectRevert(PetVault.GameOver.selector);
        vault.care(id[6], 0);
        // Minting deliberately still works into a decided game (register() NO-OPS so the collection
        // is never bricked by the season ending), but the pet is NOT registered: it can never be
        // fed, never hatch, and never win.
        vm.prank(relayer);
        (uint256 lateId,) = issuer.issuePet(player);
        (bool lateRegistered,,,,) = vault.petState(lateId);
        assertFalse(lateRegistered, "a post-decision pet is never registered into the game");

        uint256 potFinal = vault.pot();
        address winnerTba = issuer.accountOf(winnerId);
        assertEq(winnerTba, tba[2], "winner TBA is accountOf(winnerId)");
        uint256 tbaBefore = care.balanceOf(winnerTba);

        (uint256 candidate,, uint256 winsAt, bool finalized) = vault.settlementState();
        assertEq(candidate, winnerId, "settlementState candidate = leader");
        assertEq(winsAt, finishLine, "winsAt = runnerUpCareAt + lifeTtl");
        assertFalse(finalized);

        vm.prank(poker); // PERMISSIONLESS: any bot can poke; the money goes to the winner's TBA
        vault.finalize();

        assertEq(vault.leader(), winnerId, "winner is the last-fed pet");
        assertTrue(vault.potClaimed(), "potClaimed true");
        assertEq(vault.pot(), 0, "pot drained to the winner");
        assertEq(care.balanceOf(winnerTba) - tbaBefore, potFinal, "WHOLE pot paid to the winner TBA");

        // Game over is final: no more caring, no double finalize; minting still works but the pet
        // is never registered (a collectible, not a competitor).
        vm.prank(player); // the winner's own owner
        vm.expectRevert(PetVault.GameOver.selector);
        vault.care(winnerId, 0);
        vm.expectRevert(PetVault.GameOver.selector);
        vault.finalize();
        vm.prank(relayer);
        (uint256 postId,) = issuer.issuePet(player);
        (bool postRegistered,,,,) = vault.petState(postId);
        assertFalse(postRegistered, "post-settlement mints are never registered");

        console.log("== FINAL NUMBERS ==");
        console.log("winner id:", winnerId);
        console.log("winner TBA:", winnerTba);
        console.log("pot paid to winner:", potFinal);
        console.log("total burned:", vault.totalBurned());
    }

    function _potShare() internal pure returns (uint256) {
        return (CARE_COST * POT_BPS) / 10_000;
    }

    function _burnShare() internal pure returns (uint256) {
        return CARE_COST - _potShare();
    }

    // ================================================================================================
    // THREE-LEG dress rehearsal: mirrors the MAINNET posture on the real testnet fork = the three-leg
    // economy (pot 1000 / rewards 2000 / burn 7000) with a live RewardsDistributor and an
    // Ownable2Step handoff to a multisig. It proves, against real chain state:
    //   A. lifeTtl is IMMUTABLE at construction (audit H-2): there is no setLifeTtl / lockConfig at
    //      all, so the operator can never move the finish line, mass-kill pets, or resurrect the dead.
    //   B. every care routes the 3-leg split to the wei (pot kept, rewards to the distributor, burn to
    //      the dead address) and the distributor books exactly what arrives (solvent throughout).
    //   C. the 2-step ownership handoff (pending until acceptOwnership) actually transfers control.
    //   D. last-pet-standing settlement on the fork: the last-fed pet takes the WHOLE pot, and the
    //      distributor pays each pet's epoch reward pro-rata to the wei, staying solvent to the end.
    // ================================================================================================
    function test_ThreeLegSeasonRehearsal() public {
        string memory rpc = vm.envOr("FORK_RPC", string(""));
        if (bytes(rpc).length == 0) {
            vm.skip(true);
            return;
        }
        uint256 forkBlock = vm.envOr("FORK_BLOCK", uint256(0));
        if (forkBlock > 0) {
            vm.createSelectFork(rpc, forkBlock);
        } else {
            vm.createSelectFork(rpc);
        }
        assertGt(CANONICAL_REGISTRY.code.length, 0, "registry not on this chain");

        // Mainnet-mirroring params.
        uint256 rewardsBps = 2000;
        uint256 burnBps3 = 7000; // 10000 - POT_BPS(1000) - rewardsBps(2000)
        uint256 epochLength = 100;

        owner = makeAddr("owner");
        relayer = makeAddr("relayer");
        player = makeAddr("player");
        poker = makeAddr("poker");
        address multisig = makeAddr("multisig"); // the FINAL_OWNER handoff target

        RewardsDistributor dist;
        vm.startPrank(owner);
        care = new MockCareToken();
        impl = new WalletchiAccount();
        pet = new Pet721("WALLETCHI", "WCHI", MAX_SUPPLY, owner, owner, "");
        issuer = new PetIssuer(
            pet,
            IERC6551Registry(CANONICAL_REGISTRY),
            address(impl),
            IERC20(address(care)),
            relayer,
            owner,
            PER_TX_CAP,
            DAILY_CAP,
            STARTER
        );
        dist = new RewardsDistributor(owner, IERC20(address(care)), epochLength);
        t0 = block.timestamp;
        vault = new PetVault(
            PetVault.Params({
                careToken: IERC20(address(care)),
                pet: pet,
                issuer: IPetCareSpender(address(issuer)),
                owner: owner,
                lifeTtl: LIFE_TTL,
                careCost: CARE_COST,
                potBps: POT_BPS,
                burnBps: burnBps3,
                rewardsBps: rewardsBps,
                rewardsRecipient: address(dist),
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
        dist.setVault(address(vault));
        pet.setVaultRef(address(vault));
        pet.lockIssuer();
        issuer.lockVault();
        pet.lockVaultRef();
        vm.stopPrank();
        care.mint(address(issuer), FLOAT);

        console.log("== 3-LEG DEPLOY on fork (pot 1000 / rewards 2000 / burn 7000) ==");
        console.log("PetVault:", address(vault));
        console.log("RewardsDistributor:", address(dist));

        // A. lifeTtl immutability (audit H-2): the life window is a constructor immutable with NO
        //    tuning surface at all. The setter is gone from the ABI, so even the owner cannot move
        //    the finish line; prove the selector is dead on the fork.
        assertEq(vault.lifeTtl(), LIFE_TTL, "lifeTtl fixed at construction");
        vm.prank(owner);
        (bool okSet,) = address(vault).call(abi.encodeWithSignature("setLifeTtl(uint256)", 2 hours));
        assertFalse(okSet, "setLifeTtl does not exist (immutable lifeTtl)");
        assertEq(vault.lifeTtl(), LIFE_TTL, "still the constructor value");

        // Mint 3 pets.
        uint256[4] memory tids;
        address[4] memory accts;
        for (uint256 i = 1; i <= 3; i++) {
            vm.prank(relayer);
            (uint256 tid, address acct) = issuer.issuePet(player);
            tids[i] = tid;
            accts[i] = acct;
            assertEq(care.balanceOf(acct), STARTER, "TBA seeded with starter float");
        }
        assertEq(vault.registeredCount(), 3);

        // B. Care phase under FIVE NEEDS; pet 2 is the clear winner: it is the only pet to serve a
        // FULL five-need round, which is what lifts a score (min-need) since the redesign. Every
        // care asserts the 3-leg split to the wei and that the rewards slice reached the sink.
        vm.warp(t0 + 30);
        _care3(tids[1], accts[1], rewardsBps, address(dist), 0); // hatches: all five bowls fill
        _care3(tids[2], accts[2], rewardsBps, address(dist), 0);
        _care3(tids[3], accts[3], rewardsBps, address(dist), 0);
        vm.warp(t0 + 60);
        for (uint8 a = 0; a < 5; a++) {
            _care3(tids[2], accts[2], rewardsBps, address(dist), a); // pet 2's full round
        }
        assertEq(vault.hatchedCount(), 3, "all three hatched");
        assertEq(vault.leader(), tids[2], "pet 2 leads (only full five-need service moves a score)");
        assertEq(vault.runnerUpCareAt(), uint64(t0 + 30), "runner-up slot = the rivals' hatch scores");

        // The distributor received exactly the routed rewards and booked all of it (solvent).
        uint256 rewardsShare = (CARE_COST * rewardsBps) / 10_000;
        assertEq(care.balanceOf(address(dist)), 8 * rewardsShare, "all 8 reward slices arrived");
        assertEq(care.balanceOf(address(dist)), dist.accounted(), "distributor booked every received unit");

        // Not over yet: the rivals' feeds (t0+30) are still inside their life window.
        assertFalse(vault.isOver());
        vm.expectRevert(PetVault.GameNotOver.selector);
        vault.finalize();

        // C. Ownable2Step handoff to the multisig (pending until acceptance).
        vm.startPrank(owner);
        vault.transferOwnership(multisig);
        pet.transferOwnership(multisig);
        issuer.transferOwnership(multisig);
        dist.transferOwnership(multisig);
        vm.stopPrank();
        assertEq(vault.owner(), owner, "still the deployer until acceptance (2-step)");
        assertEq(vault.pendingOwner(), multisig, "multisig is the pending owner");
        vm.startPrank(multisig);
        vault.acceptOwnership();
        pet.acceptOwnership();
        issuer.acceptOwnership();
        dist.acceptOwnership();
        vm.stopPrank();
        assertEq(vault.owner(), multisig, "handoff complete: vault owned by the multisig");
        assertEq(pet.owner(), multisig, "pet owned by the multisig");
        console.log("Ownable2Step handoff complete (owner is now the multisig)");

        // D. Settlement: at the rivals' deadline only pet 2's feed stands. Permissionless finalize
        //    pays the WHOLE pot to the winner's TBA; no owner action is involved at all.
        vm.warp(t0 + 30 + LIFE_TTL);
        assertTrue(vault.isOver(), "game over on the fork");
        assertTrue(vault.alive(tids[2]), "pet 2 is the last pet standing");
        assertFalse(vault.alive(tids[1]));
        assertFalse(vault.alive(tids[3]));

        uint256 potFinal = vault.pot();
        assertEq(potFinal, 8 * ((CARE_COST * POT_BPS) / 10_000), "pot = 8 pot slices");
        uint256 tbaBefore = care.balanceOf(accts[2]);
        vm.prank(poker);
        vault.finalize();
        assertTrue(vault.potClaimed(), "potClaimed");
        assertEq(vault.pot(), 0, "pot drained");
        assertEq(care.balanceOf(accts[2]) - tbaBefore, potFinal, "WHOLE pot paid to the winner TBA");

        // The distributor pays each pet's epoch-0 reward pro-rata TO THE WEI (8 points: 1/8, 6/8,
        // 1/8 of the 8-slice pool) and empties out exactly, staying solvent at every step.
        uint256 pool = 8 * rewardsShare;
        assertEq(dist.epochPool(0), pool, "epoch 0 pool = the eight reward slices");
        uint256[3] memory before3 =
            [care.balanceOf(accts[1]), care.balanceOf(accts[2]), care.balanceOf(accts[3])];
        dist.claim(0, tids[1]);
        assertGe(care.balanceOf(address(dist)), dist.accounted(), "solvent after first claim");
        dist.claim(0, tids[2]);
        dist.claim(0, tids[3]);
        assertEq(care.balanceOf(accts[1]) - before3[0], pool / 8, "pet 1: 1/8 of the pool");
        assertEq(care.balanceOf(accts[2]) - before3[1], pool * 6 / 8, "pet 2: 6/8 of the pool");
        assertEq(care.balanceOf(accts[3]) - before3[2], pool / 8, "pet 3: 1/8 of the pool");
        assertEq(dist.accounted(), 0, "all recognized funds paid out");
        assertGe(care.balanceOf(address(dist)), dist.accounted(), "distributor solvent post-settle");

        console.log("== 3-LEG REHEARSAL PASSED ==");
        console.log("winner id:", tids[2]);
        console.log("pot paid to winner:", potFinal);
        console.log("rewards pool paid out:", pool);
    }

    // 3-leg care with an exact split assertion (pot 10% stays, 20% to the rewards sink, 70% burned).
    function _care3(uint256 tid, address acct, uint256 rewardsBps, address dist, uint8 action) internal {
        uint256 potShare = (CARE_COST * POT_BPS) / 10_000;
        uint256 rewardsShare = (CARE_COST * rewardsBps) / 10_000;
        uint256 burnShare = CARE_COST - potShare - rewardsShare;

        uint256 potBefore = vault.pot();
        uint256 burnBefore = care.balanceOf(BURN);
        uint256 distBefore = care.balanceOf(dist);
        uint256 acctBefore = care.balanceOf(acct);

        vm.prank(pet.ownerOf(tid)); // owner-only care (audit access-H-1)
        vault.care(tid, action);

        assertEq(vault.pot() - potBefore, potShare, "pot += potShare (10%)");
        assertEq(care.balanceOf(dist) - distBefore, rewardsShare, "distributor += rewardsShare (20%)");
        assertEq(care.balanceOf(BURN) - burnBefore, burnShare, "burn += burnShare (70%)");
        assertEq(acctBefore - care.balanceOf(acct), CARE_COST, "TBA debits the full careCost");
    }

    /// @dev The instant finalize() succeeds: a full life window after the LATER of the runner-up's
    ///      last care and the moment the race became contested. Mirrors PetVault._decidesAt so a
    ///      test can never quietly encode a different endgame rule than the contract.
    function _decidesAt() internal view returns (uint256) {
        uint256 from = uint256(vault.runnerUpCareAt());
        if (uint256(vault.contestedAt()) > from) from = uint256(vault.contestedAt());
        return from + LIFE_TTL;
    }
}
