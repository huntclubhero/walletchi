// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test, Vm} from "forge-std/Test.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

import {ERC6551Registry} from "erc6551/ERC6551Registry.sol";
import {IERC6551Registry} from "erc6551/interfaces/IERC6551Registry.sol";

import {WalletchiAccount} from "../../src/WalletchiAccount.sol";
import {Pet721} from "../../src/runner/Pet721.sol";
import {PetIssuer} from "../../src/runner/PetIssuer.sol";
import {PetVault, IPetCareSpender} from "../../src/runner/PetVault.sol";
import {MockCareToken} from "../../src/runner/MockCareToken.sol";
import {careAll, minNeedOf, maxNeedOf} from "./utils/FiveNeedsTestLib.sol";

/// @notice THE FIVE-NEEDS REDESIGN, unit-pinned. A pet has five independent needs (0=FEED, 1=WATER,
///         2=PLAY, 3=TOY, 4=EXPLORE); each care refreshes ONLY its own need; the pet dies the
///         instant ANY need goes unserved for a full lifeTtl (dead iff min(needsOf) + lifeTtl <=
///         now). The first care HATCHES the pet, filling all five bowls at once. This suite pins the
///         hatch broadcast, per-need reset, the any-lapsed-need death rule, per-need cooldown, the
///         carer min-need rule (the dailyCap kill-vector fix), and emit-on-change for LeaderChanged.
contract FiveNeedsTest is Test {
    uint256 internal constant MAX_SUPPLY = 2000;
    uint256 internal constant LIFE_TTL = 1 days;
    uint256 internal constant CARE_COST = 1e18;
    uint256 internal constant POT_BPS = 1000;
    uint256 internal constant BURN_BPS = 9000;
    // High so the endgame never arms mid-test: these units warp across many life windows and must
    // never trip the GameOver freeze. Endgame behavior lives in LastPetStanding.t.sol.
    uint256 internal constant MIN_PLAYERS = 50;
    uint256 internal constant PER_TX_CAP = 1e18;
    uint256 internal constant DAILY_CAP = 1000e18;
    uint256 internal constant STARTER = 100e18;
    uint256 internal constant FLOAT = 1_000_000e18;

    ERC6551Registry internal registry;
    MockCareToken internal care;
    WalletchiAccount internal impl;
    Pet721 internal pet;
    PetIssuer internal issuer;
    PetVault internal vault; // careCooldown == 0 (the shipped design)

    address internal owner = makeAddr("owner");
    address internal relayer = makeAddr("relayer");
    address internal alice = makeAddr("alice");
    address internal server = makeAddr("server"); // the approved carer
    uint256 internal t0;

    address internal constant BURN = 0x000000000000000000000000000000000000dEaD;

    bytes32 internal constant LEADER_CHANGED_SIG = keccak256("LeaderChanged(uint256,uint64,uint64)");

    function setUp() public {
        registry = new ERC6551Registry();
        (pet, issuer, vault) = _deployStack(0, DAILY_CAP);
        care.mint(address(issuer), FLOAT);
        t0 = block.timestamp;
    }

    /// @dev Deploy a full pet+issuer+vault stack with a chosen careCooldown and TBA dailyCap. The
    ///      main suite runs on cooldown 0 (shipped); the cooldown and cap-exhaustion pins deploy
    ///      their own instances.
    function _deployStack(uint256 cooldown, uint256 dailyCap)
        internal
        returns (Pet721 pet_, PetIssuer issuer_, PetVault vault_)
    {
        vm.startPrank(owner);
        if (address(care) == address(0)) care = new MockCareToken();
        if (address(impl) == address(0)) impl = new WalletchiAccount();
        pet_ = new Pet721("WALLETCHI", "WCHI", MAX_SUPPLY, owner, owner, "");
        issuer_ = new PetIssuer(
            pet_,
            IERC6551Registry(address(registry)),
            address(impl),
            IERC20(address(care)),
            relayer,
            owner,
            PER_TX_CAP,
            dailyCap,
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
                careCooldown: cooldown,
                minSeasonDuration: LIFE_TTL,
                // THE ROSTER CLOSE IS DELIBERATELY WIDE OPEN IN THIS SUITE. These units are about
                // the five-needs mechanics, and many of them warp across several life windows and
                // then mint or hatch a fresh pet to isolate one rule; a production-shaped entry
                // window would make them fail on the roster close rather than on the thing under
                // test. The endgame is separately disarmed here by MIN_PLAYERS = 50, so a wide window
                // changes nothing else. Roster-close behaviour is pinned in LastPetStanding.t.sol,
                // AuditWave4.t.sol and SeasonRosterClose.t.sol.
                entryWindowSecs: 365 days // == PetVault.MAX_ENTRY_WINDOW
            , selloutStartsSeason: false})
        );
        pet_.setIssuer(address(issuer_));
        issuer_.setVault(address(vault_));
        pet_.setVaultRef(address(vault_));
        vm.stopPrank();
    }

    function _mint(address to) internal returns (uint256 id, address tba) {
        vm.prank(relayer);
        (id, tba) = issuer.issuePet(to);
    }

    function _mintOn(PetIssuer issuer_, address to) internal returns (uint256 id, address tba) {
        vm.prank(relayer);
        (id, tba) = issuer_.issuePet(to);
    }

    function _care(uint256 id, uint8 action) internal {
        vm.prank(pet.ownerOf(id));
        vault.care(id, action);
    }

    function _leaderChangedCount() internal returns (uint256 n) {
        Vm.Log[] memory logs = vm.getRecordedLogs();
        for (uint256 i = 0; i < logs.length; i++) {
            if (logs[i].emitter == address(vault) && logs[i].topics[0] == LEADER_CHANGED_SIG) n++;
        }
    }

    // ---- 1. HATCH: the first care of ANY actionType fills all five bowls at once ------------------
    function test_Hatch_FirstCareStartsAllFiveNeeds() public {
        for (uint8 a = 0; a < 5; a++) {
            (uint256 id,) = _mint(alice);
            vm.warp(block.timestamp + 100);
            uint256 hatchedBefore = vault.hatchedCount();
            _care(id, a);
            uint64[5] memory n = vault.needsOf(id);
            for (uint256 i = 0; i < 5; i++) {
                assertEq(n[i], uint64(block.timestamp), "hatch stamps every need to now");
            }
            (,,, uint32 cc,) = vault.memorialState(id);
            assertEq(cc, 1, "the hatch is ONE care");
            assertEq(vault.hatchedCount(), hatchedBefore + 1, "hatchedCount += 1");
            assertTrue(vault.alive(id), "hatched pets are alive");
        }
    }

    // ---- 2. A non-hatch care resets ONLY the targeted need ----------------------------------------
    function test_Care_ResetsOnlyTargetedNeed() public {
        for (uint8 a = 0; a < 5; a++) {
            (uint256 id,) = _mint(alice);
            _care(id, 0); // hatch
            uint64 t1 = uint64(block.timestamp);
            vm.warp(block.timestamp + 500);
            _care(id, a);
            uint64 t2 = uint64(block.timestamp);
            uint64[5] memory n = vault.needsOf(id);
            for (uint256 i = 0; i < 5; i++) {
                if (i == a) assertEq(n[i], t2, "the targeted need moved to now");
                else assertEq(n[i], t1, "every other need untouched");
            }
        }
    }

    // ---- 3. actionType >= NEED_COUNT reverts BadAction with ZERO movement -------------------------
    function test_Care_BadActionReverts() public {
        (uint256 id, address tba) = _mint(alice);
        _care(id, 0); // hatch so the pet is a fully live subject
        uint64[5] memory before5 = vault.needsOf(id);
        uint256 tbaBefore = care.balanceOf(tba);
        uint256 vaultBefore = care.balanceOf(address(vault));
        uint256 burnBefore = care.balanceOf(BURN);

        vm.prank(alice);
        vm.expectRevert(PetVault.BadAction.selector);
        vault.care(id, 5);
        vm.prank(alice);
        vm.expectRevert(PetVault.BadAction.selector);
        vault.care(id, 255);

        uint64[5] memory after5 = vault.needsOf(id);
        for (uint256 i = 0; i < 5; i++) {
            assertEq(after5[i], before5[i], "needsOf unchanged by a BadAction attempt");
        }
        assertEq(care.balanceOf(tba), tbaBefore, "zero token movement: TBA untouched");
        assertEq(care.balanceOf(address(vault)), vaultBefore, "zero token movement: vault untouched");
        assertEq(care.balanceOf(BURN), burnBefore, "zero token movement: nothing burned");
    }

    // ---- 4. ANY lapsed need kills, exactly at its deadline ----------------------------------------
    function test_Death_AnyLapsedNeedKills() public {
        for (uint8 neglected = 0; neglected < 5; neglected++) {
            (uint256 id,) = _mint(alice);
            _care(id, 0); // hatch: all five at h
            uint256 h = block.timestamp;

            // Refresh the other four mid-window; the neglected need stays at h.
            vm.warp(h + LIFE_TTL / 2);
            for (uint8 a = 0; a < 5; a++) {
                if (a != neglected) _care(id, a);
            }

            vm.warp(h + LIFE_TTL - 1);
            assertTrue(vault.alive(id), "alive one second before the neglected need lapses");
            assertFalse(vault.isDead(id));

            vm.warp(h + LIFE_TTL);
            assertFalse(vault.alive(id), "dead AT the lapse instant exactly");
            assertTrue(vault.isDead(id), "one lapsed need kills, whatever the other four say");

            vm.prank(alice);
            vm.expectRevert(PetVault.PetIsDead.selector);
            vault.care(id, neglected);
        }
    }

    // ---- 5. All five kept fresh = the pet lives on ------------------------------------------------
    function test_Death_AllNeedsFreshLives() public {
        (uint256 id,) = _mint(alice);
        _care(id, 0); // hatch
        for (uint256 w = 0; w < 6; w++) {
            vm.warp(block.timestamp + LIFE_TTL / 2);
            careAll(vault, id);
            assertTrue(vault.alive(id), "serving all five every half-window keeps it alive");
            // secondsLeft == minNeed + lifeTtl - now, sampled mid-window.
            vm.warp(block.timestamp + 1234);
            (,,,, uint256 secondsLeft) = vault.petState(id);
            assertEq(
                secondsLeft,
                uint256(minNeedOf(vault, id)) + LIFE_TTL - block.timestamp,
                "secondsLeft counts down from the min-need deadline"
            );
        }
        assertTrue(vault.alive(id), "alive across many windows on the careAll ritual");
    }

    // ---- 6. petState.lastCareAt IS the min-need stamp ---------------------------------------------
    function test_PetState_LastCareAtIsMinNeed() public {
        (uint256 id,) = _mint(alice);
        _care(id, 0); // hatch
        vm.warp(block.timestamp + 100);
        _care(id, 1);
        vm.warp(block.timestamp + 100);
        _care(id, 3);
        vm.warp(block.timestamp + 100);
        _care(id, 1);

        uint64 expectedMin = minNeedOf(vault, id);
        (,, uint64 lastCareAt,,) = vault.petState(id);
        assertEq(lastCareAt, expectedMin, "petState.lastCareAt == min(needsOf)");
        (, uint64 lifeLastCareAt, uint256 deadline) = vault.lifeState(id);
        assertEq(lifeLastCareAt, expectedMin, "lifeState.lastCareAt == min(needsOf)");
        assertEq(deadline, uint256(expectedMin) + LIFE_TTL, "deadline = min + lifeTtl");

        // After a full careAll the min moves to now and the views follow.
        vm.warp(block.timestamp + 100);
        careAll(vault, id);
        (,, uint64 lastCareAt2,,) = vault.petState(id);
        assertEq(lastCareAt2, uint64(block.timestamp), "careAll lifts the min to now");
    }

    // ---- 7. diedAt = min-need + lifeTtl, even when other stamps are newer -------------------------
    function test_Memorial_DiedAtIsMinNeedPlusTtl() public {
        (uint256 id,) = _mint(alice);
        _care(id, 0); // hatch: all five at h
        uint256 h = block.timestamp;
        vm.warp(h + 1000);
        _care(id, 0);
        _care(id, 1);
        _care(id, 2);
        _care(id, 3); // EXPLORE (4) never redone: it stays at h and binds the deadline

        vm.warp(h + LIFE_TTL + 500);
        (bool dead,, uint64 diedAt,,) = vault.memorialState(id);
        assertTrue(dead, "the neglected explore need killed it");
        assertEq(diedAt, uint64(h + LIFE_TTL), "diedAt = the neglected need's lapse instant");
        assertEq(maxNeedOf(vault, id), uint64(h + 1000), "other stamps are newer and do not matter");
    }

    // ---- 8. Score monotonicity: no care ever lowers the implied deadline --------------------------
    function test_Score_MonotoneNeverLowersAliveUntil() public {
        (uint256 id,) = _mint(alice);
        _care(id, 4); // hatch
        uint256 prevDeadline = uint256(minNeedOf(vault, id)) + LIFE_TTL;
        uint8[7] memory seq = [uint8(0), 2, 2, 1, 4, 3, 0];
        for (uint256 i = 0; i < seq.length; i++) {
            vm.warp(block.timestamp + 777);
            _care(id, seq[i]);
            uint256 newDeadline = uint256(minNeedOf(vault, id)) + LIFE_TTL;
            assertGe(newDeadline, prevDeadline, "a care can never move the death instant earlier");
            prevDeadline = newDeadline;
        }
    }

    // ---- 9. Cooldown is PER NEED (dedicated nonzero-cooldown instance) ----------------------------
    function test_Cooldown_PerNeed() public {
        uint256 cd = 30;
        (, PetIssuer issuer2, PetVault v2) = _deployStack(cd, DAILY_CAP);
        care.mint(address(issuer2), FLOAT);
        (uint256 id,) = _mintOn(issuer2, alice);

        // HATCH is never cooldown-blocked, even at a timestamp below the cooldown itself.
        vm.prank(alice);
        v2.care(id, 0); // pays with FEED
        uint256 h = block.timestamp;

        // Care #2 on a DIFFERENT need in the SAME block as the hatch succeeds: the hatch broadcast
        // fills the bowls but arms a cooldown only for the paying action.
        vm.prank(alice);
        v2.care(id, 1);
        // The paying action itself IS on cooldown: same-need recare in the same block reverts.
        vm.prank(alice);
        vm.expectRevert(PetVault.CareOnCooldown.selector);
        v2.care(id, 0);
        // And the explicitly-cared WATER is now on its own cooldown too.
        vm.prank(alice);
        vm.expectRevert(PetVault.CareOnCooldown.selector);
        v2.care(id, 1);
        // While the never-explicitly-cared needs still are not.
        vm.prank(alice);
        v2.care(id, 2);
        vm.prank(alice);
        v2.care(id, 3);
        vm.prank(alice);
        v2.care(id, 4);

        // One second before a need's own cooldown expires: still blocked; at the boundary: allowed.
        vm.warp(h + cd - 1);
        vm.prank(alice);
        vm.expectRevert(PetVault.CareOnCooldown.selector);
        v2.care(id, 0);
        vm.warp(h + cd);
        vm.prank(alice);
        v2.care(id, 0);

        // Five DIFFERENT actions back-to-back in one block: always allowed once each need's own last
        // explicit care is a full cooldown old.
        vm.warp(block.timestamp + cd);
        careAll(v2, id);
        uint64[5] memory n = v2.needsOf(id);
        for (uint256 i = 0; i < 5; i++) {
            assertEq(n[i], uint64(block.timestamp), "careAll landed all five in one block");
        }

        // cooldown == 0 (the shipped main vault) permits same-need spam: five cares, one block.
        (uint256 id0,) = _mint(alice);
        _care(id0, 0); // hatch
        for (uint256 i = 0; i < 5; i++) {
            _care(id0, 0);
        }
        (,,, uint32 cc,) = vault.memorialState(id0);
        assertEq(cc, 6, "cooldown 0: hatch + five same-need cares in one block");
    }

    // ---- 10. Dormant egg: all-zero needs, neither alive nor dead, transferable --------------------
    function test_DormantEgg_AllZeroNeedsNeitherAliveNorDead() public {
        (uint256 id,) = _mint(alice);
        uint64[5] memory n = vault.needsOf(id);
        for (uint256 i = 0; i < 5; i++) {
            assertEq(n[i], 0, "a dormant egg has no need timers");
        }
        assertFalse(vault.alive(id), "not alive");
        assertFalse(vault.isDead(id), "not dead");
        vm.warp(block.timestamp + 10 * LIFE_TTL); // even far past a life window
        assertFalse(vault.isDead(id), "still not dead: the timers never started");
        address buyer = makeAddr("buyer");
        vm.prank(alice);
        pet.transferFrom(alice, buyer, id);
        assertEq(pet.ownerOf(id), buyer, "dormant eggs transfer freely");
    }

    // ---- 11. D1: an approved carer must serve a currently-weakest need ----------------------------
    function test_Carer_MustServeMinNeed() public {
        (uint256 id,) = _mint(alice);
        vm.prank(alice);
        vault.setCarer(id, server, 0);

        _care(id, 0); // owner hatches: all five at h
        uint256 h = block.timestamp;
        vm.warp(h + 100);
        _care(id, 0); // owner refreshes FEED: feed=h+100, the rest (the min) at h

        // Carer on a NON-min need reverts.
        vm.prank(server);
        vm.expectRevert(PetVault.CarerMustServeMinNeed.selector);
        vault.care(id, 0);
        // Carer on a min need succeeds; any TIED-at-min need qualifies.
        vm.prank(server);
        vault.care(id, 1); // water was at h == min
        vm.prank(server);
        vault.care(id, 3); // toy also at h == min (still tied with play/explore)
        // The OWNER is unrestricted: a non-min care is their money, their choice.
        vm.prank(alice);
        vault.care(id, 0);

        // A carer can still HATCH a dormant egg with ANY actionType (all five stamps are 0 = min).
        address bob = makeAddr("bob");
        (uint256 egg,) = _mint(bob);
        vm.prank(bob);
        vault.setCarer(egg, server, 0);
        vm.prank(server);
        vault.care(egg, 4);
        assertTrue(vault.alive(egg), "carer-hatched via EXPLORE");
    }

    // ---- 12. D1: cap exhaustion by a hostile carer can no longer kill -----------------------------
    //
    // THIS RUNS AT THE EXACT SHIPPED PARAMETERS: LIFE_TTL == 1 days == 86400, careCooldown == 0, the
    // account's SPEND_WINDOW == 1 days, dailyCap == 20 cares. That coincidence of life window and
    // spend window is the whole reason the old code had a deterministic carer KILL, so the fix has to
    // be proven HERE and not at some comfortable longer lifeTtl.
    //
    // THE ORIGINAL KILL, step by step: the carer waits for the account's rolling window to be
    // rollable, spends once (which sets windowStart = now and zeroes the spend ledger), then burns the
    // ENTIRE dailyCap in that same instant. Every one of those cares is legal, because a carer must
    // serve the weakest need and rotating through the five does exactly that, so the pet ends up fully
    // served at time T. The owner's next feed then had to wait for windowStart + 1 day == T + 86400,
    // and the pet died at min-need + lifeTtl == T + 86400. The same instant. The owner got zero
    // seconds in which to act, and the CarerApproval natspec claimed a carer could "never" kill.
    function test_Carer_CapExhaustionCannotKill() public {
        uint256 capCares = 20;
        (, PetIssuer issuer3, PetVault v3) = _deployStack(0, capCares * CARE_COST);
        care.mint(address(issuer3), FLOAT);
        (uint256 id, address tba) = _mintOn(issuer3, alice);
        assertEq(v3.lifeTtl(), 1 days, "this pin only means anything at the shipped 24h life window");
        assertEq(v3.careCooldown(), 0, "and at the shipped zero cooldown");

        // The owner hatches: one care serves all five at T (and spends 1 of the 20 cap slots).
        vm.prank(alice);
        v3.care(id, 0);
        vm.prank(alice);
        v3.setCarer(id, server, 0);

        // The hostile carer tries the old kill: burn every slot on ONE need in one block.
        vm.warp(block.timestamp + 1000);
        uint64 burnTime = uint64(block.timestamp);
        vm.prank(server);
        v3.care(id, 0); // care 1 lands: FEED was tied at the min
        vm.prank(server);
        vm.expectRevert(PetVault.CarerMustServeMinNeed.selector);
        v3.care(id, 0); // care 2 REFUSED: feed is no longer the weakest need

        // Forced to rotate: the only legal path is serving the weakest need each time.
        vm.prank(server);
        v3.care(id, 1);
        vm.prank(server);
        v3.care(id, 2);
        vm.prank(server);
        v3.care(id, 3);
        vm.prank(server);
        v3.care(id, 4);
        // All five now sit at burnTime (tied), so anything qualifies. The carer burns everything it is
        // ALLOWED to burn, which is its sub-cap and no more: carerDailyCap = 50% of dailyCap = 10.
        uint256 carerBudgetCares =
            WalletchiAccount(payable(tba)).carerDailyCap() / CARE_COST;
        assertEq(carerBudgetCares, capCares / 2, "the carer sub-cap is half the daily cap");
        for (uint256 i = 0; i < carerBudgetCares - 5; i++) {
            vm.prank(server);
            v3.care(id, uint8(i % 5));
        }
        // AND THE NEXT ONE IS REFUSED BY THE ACCOUNT, not by the game: the carer is out of budget.
        vm.prank(server);
        vm.expectRevert(WalletchiAccount.OverCarerCap.selector);
        v3.care(id, 0);

        // THE FIX, ASSERTED DIRECTLY: the owner still has headroom IN THE SAME WINDOW. The carer spent
        // its whole sub-cap, and the shared allowance is still only half consumed.
        assertEq(
            care.balanceOf(tba), STARTER - (carerBudgetCares + 1) * CARE_COST, "carer spent its sub-cap and nothing more"
        );
        assertEq(
            WalletchiAccount(payable(tba)).remainingDailyAllowance(),
            (capCares - carerBudgetCares - 1) * CARE_COST,
            "the owner's headroom survived the carer's worst effort"
        );
        assertEq(WalletchiAccount(payable(tba)).remainingCarerAllowance(), 0, "the carer has nothing left");

        // The owner cares immediately, in the very same block the carer was cut off. Under the old
        // code this reverted OverDailyCap and stayed reverting until the pet was already dead.
        vm.prank(alice);
        v3.care(id, 0);
        assertTrue(v3.alive(id), "the pet is alive and its owner is not locked out");

        // And the owner can still serve EVERY need before the deadline, which is what survival needs.
        for (uint8 a = 1; a < 5; a++) {
            vm.prank(alice);
            v3.care(id, a);
        }
        uint64[5] memory n = v3.needsOf(id);
        for (uint256 i = 0; i < 5; i++) {
            assertEq(n[i], uint64(block.timestamp), "the owner re-served every need after the burn");
        }

        // AND THE PET IS ACTUALLY SAVED, not merely warned. Its deadline is burnTime + lifeTtl. Just
        // before that the account's own window has rolled, so the owner has a full fresh cap and can
        // serve every need again. Under the old code the owner reached this point locked out.
        vm.warp(uint256(burnTime) + LIFE_TTL - 100);
        assertTrue(v3.alive(id), "still alive right up to the deadline");
        for (uint8 a = 0; a < 5; a++) {
            vm.prank(alice);
            v3.care(id, a);
        }
        vm.warp(uint256(burnTime) + LIFE_TTL);
        assertTrue(v3.alive(id), "the owner saved it: no carer-driven kill at the shipped parameters");
    }

    /// The kill sequence in its most hostile form: the carer forces the account's rolling window to
    /// ROLL first, so windowStart is pinned to the burn instant and the owner's unlock lines up with
    /// the pet's death instant exactly. This is the arrangement that made it a kill rather than a
    /// nuisance, and the sub-cap has to hold against it specifically.
    function test_Carer_WindowRollTimedBurnStillLeavesTheOwnerAbleToFeed() public {
        uint256 capCares = 20;
        (, PetIssuer issuer3, PetVault v3) = _deployStack(0, capCares * CARE_COST);
        care.mint(address(issuer3), FLOAT);
        (uint256 id, address tba) = _mintOn(issuer3, alice);
        WalletchiAccount acct = WalletchiAccount(payable(tba));

        vm.prank(alice);
        v3.care(id, 0); // hatch, and the first spend of the account's first window
        vm.prank(alice);
        v3.setCarer(id, server, 0);

        // Mid-window the owner serves every need, so the pet's own deadline sits a full life window
        // ahead of the moment the account's spend window becomes rollable. Without this the pet would
        // simply be dead at the roll instant (lifeTtl == SPEND_WINDOW) and there would be no attack to
        // test: the attacker needs a LIVE pet to lock its owner out of.
        vm.warp(block.timestamp + 12 hours);
        for (uint8 a = 0; a < 5; a++) {
            vm.prank(alice);
            v3.care(id, a);
        }

        // Now wait out the account's spend window so the carer's next care ROLLS it and anchors
        // windowStart to the burn instant. This is the attacker's optimal timing.
        vm.warp(acct.windowStart() + acct.SPEND_WINDOW());
        uint256 burnTime = block.timestamp;
        assertTrue(v3.alive(id), "the pet is alive going into the carer's burn");

        // Burn the entire carer budget in this instant, rotating needs so every care is legal.
        uint256 carerCares = acct.carerDailyCap() / CARE_COST;
        for (uint256 i = 0; i < carerCares; i++) {
            vm.prank(server);
            v3.care(id, uint8(i % 5));
        }
        assertEq(acct.windowStart(), burnTime, "the carer did anchor the window to its burn instant");
        vm.prank(server);
        vm.expectRevert(WalletchiAccount.OverCarerCap.selector);
        v3.care(id, 0);

        // THE POINT. The account's shared allowance does not unlock until burnTime + SPEND_WINDOW,
        // and the pet dies at burnTime + lifeTtl, and at the shipped parameters those are the SAME
        // INSTANT. So the only thing that can save the pet is headroom the carer could not touch.
        assertEq(acct.SPEND_WINDOW(), v3.lifeTtl(), "the shipped params really are the degenerate case");
        assertGt(acct.remainingDailyAllowance(), 0, "the owner has headroom the carer could not reach");

        vm.prank(alice);
        v3.care(id, 0); // succeeds, right now, inside the locked window
        assertTrue(v3.alive(id), "no kill: the owner fed inside the window the carer tried to own");
    }

    /// The sub-cap must not break the ordinary product flow: one-tap care runs through an approved
    /// carer, so a carer has to be able to keep a pet alive unattended at the shipped caps.
    function test_Carer_SubCapStillSustainsAPetAtTheShippedCaps() public {
        (, PetIssuer issuer3, PetVault v3) = _deployStack(0, 20 * CARE_COST);
        care.mint(address(issuer3), FLOAT);
        (uint256 id,) = _mintOn(issuer3, alice);
        vm.prank(alice);
        v3.care(id, 0); // hatch
        vm.prank(alice);
        v3.setCarer(id, server, 0);

        // Ten consecutive life windows, fed ONLY by the carer, five needs each window.
        for (uint256 w = 0; w < 10; w++) {
            vm.warp(block.timestamp + LIFE_TTL - 1 hours);
            assertTrue(v3.alive(id), "carer-only care kept the pet alive across the window");
            for (uint8 a = 0; a < 5; a++) {
                vm.prank(server);
                v3.care(id, a);
            }
        }
        assertTrue(v3.alive(id), "a carer alone can sustain a pet at the shipped caps");
    }

    // ---- 13. D2: LeaderChanged emits only on an actual tuple change -------------------------------
    function test_LeaderChanged_SilentOnNoOpCare() public {
        (uint256 a,) = _mint(alice);
        (uint256 b,) = _mint(alice);
        _care(a, 0); // hatch a: leader = a
        vm.warp(block.timestamp + 100);
        _care(b, 0); // hatch b: takeover (strictly greater score)
        vm.warp(block.timestamp + 100);
        careAll(vault, a); // a retakes the lead; runnerUp = b's hatch score

        // A WASTED care: b refreshes FEED only; its min (score) does not move, and it is not above
        // the stored runner-up. No state change => NO LeaderChanged (D2).
        vm.warp(block.timestamp + 50);
        vm.recordLogs();
        _care(b, 0);
        assertEq(_leaderChangedCount(), 0, "no-op care emitted no LeaderChanged");

        // The LEADER's non-min care: leaderCareAt (its min) does not move. Also silent.
        vm.warp(block.timestamp + 50);
        vm.recordLogs();
        _care(a, 0);
        assertEq(_leaderChangedCount(), 0, "leader's non-min care emitted no LeaderChanged");

        // A REAL change still emits: b serves everything and takes the lead.
        vm.warp(block.timestamp + 50);
        vm.recordLogs();
        careAll(vault, b);
        assertEq(_leaderChangedCount(), 1, "the real takeover emitted exactly once");
        assertEq(vault.leader(), b, "b leads");
    }
}

/// @notice PetIssuer under five needs: the caps baked into a pet's TBA must sustain FIVE cares per
///         life window per rolling day, or the pet starves against its own spend cap (audit critical
///         2). Guards both setCaps and the issuePet backstop.
contract PetIssuerFiveNeedsTest is Test {
    ERC6551Registry internal registry;
    MockCareToken internal care;
    WalletchiAccount internal impl;
    Pet721 internal pet;
    PetIssuer internal issuer;
    PetVault internal vault;

    address internal owner = makeAddr("owner");
    address internal relayer = makeAddr("relayer");
    address internal player = makeAddr("player");

    uint256 internal constant CARE_COST = 1e18;
    uint256 internal constant LIFE_TTL = 1 days; // caresPerWindow = 1 => needed = cost * (5*1 + 1)

    function setUp() public {
        vm.startPrank(owner);
        registry = new ERC6551Registry();
        care = new MockCareToken();
        impl = new WalletchiAccount();
        pet = new Pet721("WALLETCHI", "WCHI", 2000, owner, owner, "");
        issuer = new PetIssuer(
            pet,
            IERC6551Registry(address(registry)),
            address(impl),
            IERC20(address(care)),
            relayer,
            owner,
            CARE_COST,
            1000e18,
            100e18
        );
        vault = new PetVault(
            PetVault.Params({
                careToken: IERC20(address(care)),
                pet: pet,
                issuer: IPetCareSpender(address(issuer)),
                owner: owner,
                lifeTtl: LIFE_TTL,
                careCost: CARE_COST,
                potBps: 1000,
                burnBps: 9000,
                rewardsBps: 0,
                rewardsRecipient: address(0),
                gasBps: 0,
                gasRecipient: address(0),
                abandonGrace: 90 days,
                minPlayers: 3,
                careCooldown: 0,
                minSeasonDuration: LIFE_TTL,
                entryWindowSecs: 365 days // wide open: this suite pins CAP math, not the roster close
            , selloutStartsSeason: false})
        );
        pet.setIssuer(address(issuer));
        issuer.setVault(address(vault));
        vm.stopPrank();
        care.mint(address(issuer), 1_000_000e18);
    }

    /// The five-need rate: dailyCap must cover cost * (5 * caresPerWindow + 1). At a one-day lifeTtl
    /// that is 6 cares, not the old 2: a cap sized for the one-timer game starves every pet.
    function test_SetCaps_RevertsBelowFiveNeedRate() public {
        vm.prank(owner);
        vm.expectRevert(PetIssuer.CapsTooLowForCare.selector);
        issuer.setCaps(CARE_COST, CARE_COST * 5); // one short of the five-need rate

        vm.prank(owner);
        issuer.setCaps(CARE_COST, CARE_COST * 6); // exactly the rate: accepted
        assertEq(issuer.dailyCap(), CARE_COST * 6);
    }

    /// The issuePet backstop: constructor-set caps never passed through setCaps, so the mint path
    /// re-checks the five-need rate and refuses to bake a doomed account.
    function test_Issue_RevertsWhenConstructorCapsCannotSustainFiveNeeds() public {
        PetIssuer bad = new PetIssuer(
            pet,
            IERC6551Registry(address(registry)),
            address(impl),
            IERC20(address(care)),
            relayer,
            owner,
            CARE_COST,
            CARE_COST * 5, // below the five-need rate, set before the vault existed
            0
        );
        vm.prank(owner);
        bad.setVault(address(vault));
        vm.prank(owner);
        pet.setIssuer(address(bad));
        vm.expectRevert(PetIssuer.CapsTooLowForCare.selector);
        vm.prank(relayer);
        bad.issuePet(player);
    }
}
