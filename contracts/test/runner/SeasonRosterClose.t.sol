// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

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
import {DeployWalletchi} from "../../script/DeployWalletchi.s.sol";

/// @dev A USDT-style ERC-20: `transfer` moves the tokens but returns NO DATA. Perfectly common, and
///      the exact shape that silently routes every PetVault.finalize() payout into its catch branch,
///      because the `try ... returns (bool ok)` decode fails on empty returndata.
contract NoReturnCareToken {
    mapping(address => uint256) public balanceOf;

    function mint(address to, uint256 amount) external {
        balanceOf[to] += amount;
    }

    // Deliberately no `returns (bool)`.
    function transfer(address to, uint256 amount) external {
        require(balanceOf[msg.sender] >= amount, "balance");
        balanceOf[msg.sender] -= amount;
        balanceOf[to] += amount;
    }
}

/// @dev An ERC-20 that returns a bool but always returns FALSE, the other half of the return-value
///      hazard: the call succeeds, the decode succeeds, and the answer is "no".
contract FalseReturnCareToken {
    function transfer(address, uint256) external pure returns (bool) {
        return false;
    }
}

/// @dev A stub that looks like an ERC-20, reports balances, returns true from transfer, and moves
///      nothing. This is what a mistyped or not-yet-deployed token address behaves like from the
///      caller's side once "no return data" has to be tolerated for USDT-style tokens.
contract SilentStubToken {
    mapping(address => uint256) public balanceOf;

    function setBalance(address who, uint256 amount) external {
        balanceOf[who] = amount;
    }

    function transfer(address, uint256) external pure returns (bool) {
        return true; // says yes, does nothing
    }
}

/// @dev A conforming ERC-20 that can be told to start returning false, so the payout path can be
///      driven into the "returned false" branch at exactly the moment of settlement.
contract FlakyCareToken is ERC20 {
    bool public returnFalse;

    constructor() ERC20("Flaky Care", "FCARE") {}

    function setReturnFalse(bool v) external {
        returnFalse = v;
    }

    function mint(address to, uint256 amount) external {
        _mint(to, amount);
    }

    function transfer(address to, uint256 amount) public override returns (bool) {
        if (returnFalse) return false; // moves nothing, reports failure honestly
        return super.transfer(to, amount);
    }
}

/// @notice THE ROSTER CLOSE and the UNDER-SUBSCRIBED SEASON RECOVERY.
///
///         Two audit findings live here, and they are the same shape: the season could reach a state
///         from which nothing could ever move again.
///
///         1. SEASON FREEZE / COLLECTION LOCKOUT (highest). The endgame clock armed on the
///            minPlayers-th hatch while minting stayed open forever, so a season could be decided on
///            day 2 and every pet minted afterwards was permanently inert: register() silently
///            no-opped, care() reverted GameOver, and every pointer between the contracts is one-way
///            locked, so nothing could reopen it. 1,990 of 2,000 pets could be dead on arrival. The
///            fix is a single immutable `entryDeadline` that closes minting AND hatching, and that
///            also floors `_decidesAt()`, so the "you may still enter" window and the "the season may
///            be decided" window are provably disjoint.
///
///         2. PERMANENT LOCK-UP BELOW minPlayers. If fewer than minPlayers pets ever hatched,
///            finalize() reverted NotEnoughPlayers at every future timestamp, `potClaimed` never
///            became true, and the timelocked sweep reserves the whole pot while it is false. The
///            care tokens those few real players paid in were destroyed in place. The fix is
///            `abandonSeason()`, permissionless and unsteerable, available only long after the roster
///            has closed with the season provably under-subscribed.
contract SeasonRosterCloseTest is Test {
    uint256 internal constant MAX_SUPPLY = 2000;
    uint256 internal constant LIFE_TTL = 1 days;
    uint256 internal constant ENTRY_WINDOW = 7 days;
    uint256 internal constant MIN_SEASON = 30 days;
    uint256 internal constant CARE_COST = 1e18;
    uint256 internal constant MIN_PLAYERS = 5;
    uint256 internal constant PER_TX_CAP = 1e18;
    uint256 internal constant DAILY_CAP = 20e18;
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
    address internal poker = makeAddr("poker"); // an unrelated third party
    uint256 internal t0;

    function setUp() public {
        registry = new ERC6551Registry();
        care = new MockCareToken();
        impl = new WalletchiAccount();
        _deploy(ENTRY_WINDOW, MIN_PLAYERS);
        t0 = block.timestamp;
    }

    function _deploy(uint256 entryWindow, uint256 minPlayers) internal {
        vm.startPrank(owner);
        pet = new Pet721("WALLETCHI", "WCHI", MAX_SUPPLY, owner, owner, "");
        issuer = new PetIssuer(
            pet,
            IERC6551Registry(address(registry)),
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
                potBps: 1000,
                burnBps: 9000,
                rewardsBps: 0,
                rewardsRecipient: address(0),
                gasBps: 0,
                gasRecipient: address(0),
                abandonGrace: 90 days,
                minPlayers: minPlayers,
                careCooldown: 0,
                minSeasonDuration: MIN_SEASON,
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
    }

    function _mint(address to) internal returns (uint256 id, address tba) {
        vm.prank(relayer);
        (id, tba) = issuer.issuePet(to);
    }

    // ============================================================================================
    // 1. THE ROSTER CLOSE
    // ============================================================================================

    /// A mint AT or after the deadline is refused with a named error. It reverts BEFORE pet.mint(),
    /// so no id and no supply is consumed by the attempt: a late mint cannot damage the collection.
    function test_MintIsRefusedAtAndAfterTheDeadline() public {
        (uint256 early,) = _mint(player);
        assertEq(early, 1);

        vm.warp(vault.entryDeadline() - 1);
        (uint256 lastIn,) = _mint(player); // the final legal second still works
        assertEq(lastIn, 2, "minting is open right up to the deadline");

        uint256 mintedBefore = pet.totalMinted();
        vm.warp(vault.entryDeadline()); // AT the deadline, not after: the boundary is inclusive
        vm.prank(relayer);
        vm.expectRevert(PetIssuer.EntryWindowClosed.selector);
        issuer.issuePet(player);
        assertEq(pet.totalMinted(), mintedBefore, "a refused mint consumes no supply");

        vm.warp(vault.entryDeadline() + 3650 days);
        vm.prank(relayer);
        vm.expectRevert(PetIssuer.EntryWindowClosed.selector);
        issuer.issuePet(player);
        assertEq(pet.totalMinted(), mintedBefore, "still refused a decade later, still nothing consumed");
    }

    /// THE FINDING IN ONE TEST: a late mint used to SUCCEED and hand the buyer a token that looked
    /// exactly like a live pet, was never registered, could never be fed, and could never win.
    function test_ALateMintCanNeverProduceAnInertPet() public {
        vm.warp(vault.entryDeadline() + 1);
        vm.prank(relayer);
        vm.expectRevert(PetIssuer.EntryWindowClosed.selector);
        issuer.issuePet(player);
        // Nothing was created, so there is no unregistered token to be confused about.
        assertEq(pet.totalMinted(), 0, "no inert pet exists");
    }

    /// An egg minted in time but never woken cannot hatch once the roster closes, and the error says
    /// exactly that rather than something generic. Already-hatched pets are untouched.
    function test_AnUnhatchedEggCannotHatchAfterTheDeadline() public {
        (uint256 egg,) = _mint(player);
        (uint256 live,) = _mint(player);

        // Hatch the control pet late enough in the window that it is still alive at the close, so the
        // assertion below really is about the roster and not about a starved pet.
        vm.warp(vault.entryDeadline() - 1 hours);
        vm.prank(player);
        vault.care(live, 0); // hatched in time

        vm.warp(vault.entryDeadline());
        vm.prank(player);
        vm.expectRevert(PetVault.EntryWindowClosed.selector);
        vault.care(egg, 0);

        // The refusal does not damage the egg: it never hatched, so it is neither alive nor dead and
        // it stays freely transferable. A missed roster is a collectible, never a bricked memorial.
        assertFalse(vault.alive(egg));
        assertFalse(vault.isDead(egg));
        assertFalse(vault.transferLocked(egg));
        address buyer = makeAddr("buyer");
        vm.prank(player);
        pet.transferFrom(player, buyer, egg);
        assertEq(pet.ownerOf(egg), buyer);

        // And the pet that DID hatch in time plays on normally, forever.
        vm.prank(player);
        vault.care(live, 1);
        assertTrue(vault.alive(live), "a hatched pet is unaffected by the roster close");
    }

    /// THE INVARIANT THAT MAKES THE OTHER TWO SAFE: while entry is open the season cannot be decided,
    /// even in the most extreme case the endgame allows (a single surviving pet with every rival long
    /// since lapsed). Checked one second before the close and again exactly at it.
    function test_TheSeasonCannotBeDecidedWhileEntryIsOpen() public {
        uint256[] memory ids = new uint256[](MIN_PLAYERS);
        for (uint256 i = 0; i < MIN_PLAYERS; i++) {
            (ids[i],) = _mint(player);
            vm.prank(player);
            vault.care(ids[i], 0);
        }
        // Let every rival lapse many times over. Under the pre-roster rule this alone decided it.
        vm.warp(t0 + 5 * LIFE_TTL);
        assertLt(block.timestamp, vault.entryDeadline(), "still inside the entry window");
        assertFalse(vault.isOver(), "decidable while anyone could still enter");
        vm.expectRevert(PetVault.GameNotOver.selector);
        vault.finalize();

        vm.warp(vault.entryDeadline() - 1);
        assertFalse(vault.isOver(), "still not decidable at the last open second");
        vm.expectRevert(PetVault.GameNotOver.selector);
        vault.finalize();

        // The season floor (30 days here) is ALSO still in force: entryDeadline is an ADDITIONAL
        // floor, never a replacement, so whichever is later binds.
        vm.warp(vault.entryDeadline());
        assertFalse(vault.isOver(), "the min-season floor still binds after the roster closes");
        vm.warp(vault.seasonStart() + MIN_SEASON);
        assertTrue(vault.isOver(), "decidable once BOTH floors have passed");
    }

    /// `_decidesAt()` must be monotone non-decreasing so `isOver()` can never flicker back to false.
    /// Fuzzed over a random care/warp interleaving, with the roster close in the max.
    function testFuzz_DecidesAtIsMonotoneWithTheRosterClose(uint8 steps, uint256 seed) public {
        uint256 n = uint256(steps) % 12 + 3;
        uint256[] memory ids = new uint256[](n);
        for (uint256 i = 0; i < n; i++) {
            (ids[i],) = _mint(player);
        }
        (,, uint256 prevWins,) = vault.settlementState();
        for (uint256 i = 0; i < n * 3; i++) {
            seed = uint256(keccak256(abi.encode(seed, i)));
            vm.warp(block.timestamp + (seed % 6 hours) + 1);
            if (block.timestamp >= vault.entryDeadline()) break;
            uint256 pick = ids[seed % n];
            if (vault.isDead(pick) || vault.isOver() || vault.potClaimed()) continue;
            vm.prank(player);
            try vault.care(pick, uint8(seed % 5)) {} catch {}
            (,, uint256 winsAt,) = vault.settlementState();
            if (winsAt != 0 && prevWins != 0) {
                assertGe(winsAt, prevWins, "decidesAt moved EARLIER: isOver() could flicker");
            }
            if (winsAt != 0) {
                assertGe(winsAt, vault.entryDeadline(), "decidesAt fell below the roster close");
                prevWins = winsAt;
            }
        }
    }

    /// The ordinary season is untouched: it still finalizes, and it still pays the whole pot to the
    /// last pet standing. The roster close must not have broken the happy path.
    function test_ANormalSeasonStillFinalizesAndPaysTheWinner() public {
        uint256[] memory ids = new uint256[](MIN_PLAYERS);
        for (uint256 i = 0; i < MIN_PLAYERS; i++) {
            (ids[i],) = _mint(player);
            vm.prank(player);
            vault.care(ids[i], 0);
        }
        // One keeper actually plays: serve every need each window, right through the entry window.
        for (uint256 w = 0; w < 6; w++) {
            vm.warp(block.timestamp + LIFE_TTL - 1 hours);
            for (uint8 a = 0; a < 5; a++) {
                vm.prank(player);
                vault.care(ids[0], a);
            }
        }
        assertEq(vault.leader(), ids[0], "the keeper who played leads");

        vm.warp(vault.seasonStart() + MIN_SEASON + LIFE_TTL);
        assertTrue(vault.isOver(), "a normal season decides once the floors pass");
        uint256 prize = vault.pot();
        assertGt(prize, 0);
        address tba = issuer.accountOf(ids[0]);
        uint256 before = care.balanceOf(tba);

        vm.prank(poker); // permissionless: an unrelated party pokes it
        vault.finalize();
        assertTrue(vault.potClaimed());
        assertEq(vault.pot(), 0);
        assertEq(care.balanceOf(tba) - before, prize, "the whole pot went to the winner's TBA");
        assertEq(vault.prizePaid(), prize);
    }

    /// Bounds: a nonsense entry window is refused at construction rather than bricking the season.
    function test_EntryWindowBoundsAreEnforcedAtConstruction() public {
        PetVault.Params memory p = PetVault.Params({
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
            minPlayers: MIN_PLAYERS,
            careCooldown: 0,
            minSeasonDuration: MIN_SEASON,
            entryWindowSecs: 0
        , selloutStartsSeason: false});
        vm.expectRevert(PetVault.EntryWindowOutOfBounds.selector);
        new PetVault(p);

        p.entryWindowSecs = 1 hours - 1; // below MIN_ENTRY_WINDOW
        vm.expectRevert(PetVault.EntryWindowOutOfBounds.selector);
        new PetVault(p);

        p.entryWindowSecs = 366 days; // above MAX_ENTRY_WINDOW
        vm.expectRevert(PetVault.EntryWindowOutOfBounds.selector);
        new PetVault(p);

        p.entryWindowSecs = 1 hours; // exactly the floor: accepted
        PetVault v = new PetVault(p);
        assertEq(v.entryDeadline(), block.timestamp + 1 hours);
        assertEq(v.MIN_ENTRY_WINDOW(), 1 hours);
        assertEq(v.MAX_ENTRY_WINDOW(), v.MAX_SEASON_DURATION());
    }

    // ============================================================================================
    // 2. THE UNDER-SUBSCRIBED SEASON
    // ============================================================================================

    /// THE FINDING: below minPlayers, finalize() reverts forever, so potClaimed stays false, so the
    /// sweep reserves the entire pot as unswept forever. Every care token those players paid in was
    /// destroyed in place with no path out for anyone, including the owner.
    function test_UnderSubscribedSeasonIsRecoveredNotDestroyed() public {
        // Four hatch; minPlayers is five. The season can never be won.
        uint256[] memory ids = new uint256[](4);
        for (uint256 i = 0; i < 4; i++) {
            (ids[i],) = _mint(player);
            vm.prank(player);
            vault.care(ids[i], 0);
        }
        uint256 pot = vault.pot();
        assertGt(pot, 0, "real players really did pay into the pot");

        // The lockup, demonstrated: finalize is refused at every future timestamp.
        vm.warp(vault.entryDeadline() + 3650 days);
        vm.expectRevert(PetVault.NotEnoughPlayers.selector);
        vault.finalize();
        assertFalse(vault.potClaimed());
        // ...and while potClaimed is false the sweep reserves the whole pot, so not even the owner
        // could recover it. This is the destruction the fallback exists to prevent.
        vm.startPrank(owner);
        vault.queueSweep(address(care), owner, pot);
        vm.warp(block.timestamp + vault.SWEEP_TIMELOCK());
        vm.expectRevert(PetVault.SweepExceedsSurplus.selector);
        vault.executeSweep();
        vm.stopPrank();

        // THE WAY OUT. Permissionless, no arguments, destination not caller-chosen: it pays the
        // standing leader's own TBA, exactly as finalize() would have.
        uint256 winnerId = vault.leader();
        address tba = issuer.accountOf(winnerId);
        uint256 before = care.balanceOf(tba);
        vm.prank(poker); // a total stranger can settle it
        vault.abandonSeason();
        assertTrue(vault.potClaimed(), "the season is settled");
        assertEq(vault.pot(), 0);
        assertEq(care.balanceOf(tba) - before, pot, "the money went to a real player, not nowhere");
        assertEq(vault.prizePaid(), pot);
    }

    /// It cannot be poked early, and it cannot be poked twice.
    function test_AbandonRequiresTheFullGraceAndIsOneShot() public {
        (uint256 a,) = _mint(player);
        vm.prank(player);
        vault.care(a, 0);

        vm.expectRevert(PetVault.SeasonNotAbandoned.selector);
        vault.abandonSeason();

        vm.warp(vault.entryDeadline() + vault.abandonGrace() - 1);
        vm.expectRevert(PetVault.SeasonNotAbandoned.selector);
        vault.abandonSeason();

        vm.warp(vault.entryDeadline() + vault.abandonGrace());
        vault.abandonSeason();
        vm.expectRevert(PetVault.GameOver.selector);
        vault.abandonSeason();
        vm.expectRevert(PetVault.GameOver.selector);
        vault.finalize();
    }

    /// THE THING THAT MUST NOT HAPPEN: the recovery path must never touch a viable season. Once
    /// hatchedCount reaches minPlayers it is shut forever, and hatchedCount can only rise before the
    /// roster closes, so viability is a settled fact from entryDeadline onwards.
    function test_AbandonCanNeverTouchAViableSeason() public {
        uint256[] memory ids = new uint256[](MIN_PLAYERS);
        for (uint256 i = 0; i < MIN_PLAYERS; i++) {
            (ids[i],) = _mint(player);
            vm.prank(player);
            vault.care(ids[i], 0);
        }
        assertEq(vault.hatchedCount(), MIN_PLAYERS);

        vm.warp(vault.entryDeadline() + vault.abandonGrace());
        vm.expectRevert(PetVault.SeasonNotAbandoned.selector);
        vault.abandonSeason();
        vm.warp(block.timestamp + 3650 days);
        vm.expectRevert(PetVault.SeasonNotAbandoned.selector);
        vault.abandonSeason();

        // The ordinary endgame is the only exit, and it still works.
        vault.finalize();
        assertTrue(vault.potClaimed());
    }

    /// It is not an owner lever: an owner calling it gets exactly what a stranger gets, and gains no
    /// ability to redirect the money. The only owner-visible effect is that residual dust stops being
    /// reserved by the sweep once the season is genuinely settled.
    function test_AbandonIsNotAnOwnerSteerableLever() public {
        (uint256 a,) = _mint(player);
        vm.prank(player);
        vault.care(a, 0);
        uint256 pot = vault.pot();
        address tba = issuer.accountOf(a);

        vm.warp(vault.entryDeadline() + vault.abandonGrace());
        uint256 ownerBefore = care.balanceOf(owner);
        vm.prank(owner);
        vault.abandonSeason();
        assertEq(care.balanceOf(owner), ownerBefore, "the owner receives nothing by calling it");
        assertEq(care.balanceOf(tba), STARTER - CARE_COST + pot, "the player's TBA received the pot");
    }

    /// A season where literally nobody ever hatched: the pot is provably zero, so there is nothing to
    /// pay and nothing to lose, and the call still settles the season cleanly rather than reverting.
    function test_AbandonWithNoHatchesSettlesCleanly() public {
        _mint(player); // minted, never woken
        vm.warp(vault.entryDeadline() + vault.abandonGrace());
        assertEq(vault.leader(), 0);
        assertEq(vault.pot(), 0);
        vm.prank(poker);
        vault.abandonSeason();
        assertTrue(vault.potClaimed());
        assertEq(vault.prizePaid(), 0);
    }

    // ============================================================================================
    // 3. DEPLOY GUARD: the care token must return a bool from transfer()
    // ============================================================================================

    /// A USDT-style token that returns no data makes `try careToken.transfer(...) returns (bool)`
    /// land in the CATCH branch on every single payout, so auto-pay is permanently dead and every
    /// prize has to be claimed by hand. Mainnet CARE is a third-party launch, so the deploy has to
    /// find this out at deploy time and not at settlement time.
    function test_DeployGuardRejectsANoReturnDataCareToken() public {
        DeployWalletchi script = new DeployWalletchi();
        NoReturnCareToken bad = new NoReturnCareToken();
        vm.expectRevert(
            bytes("care token transfer returns no data (USDT-style): finalize() could never auto-pay a prize")
        );
        script.requireBoolReturningTransfer(address(bad));
    }

    function test_DeployGuardRejectsAFalseReturningCareToken() public {
        DeployWalletchi script = new DeployWalletchi();
        FalseReturnCareToken bad = new FalseReturnCareToken();
        vm.expectRevert(bytes("care token transfer(0) returned false"));
        script.requireBoolReturningTransfer(address(bad));
    }

    function test_DeployGuardRejectsAnAddressWithNoCode() public {
        DeployWalletchi script = new DeployWalletchi();
        vm.expectRevert(bytes("care token has no code"));
        script.requireBoolReturningTransfer(makeAddr("notAToken"));
    }

    function test_DeployGuardAcceptsAConformingCareToken() public {
        DeployWalletchi script = new DeployWalletchi();
        script.requireBoolReturningTransfer(address(care)); // must not revert
    }

    /// The second half of the token guard: prove value really MOVES. Both the vault payout and the
    /// distributor auto-claim treat "call succeeded with no return data" as success (a USDT-style
    /// token requires that), and a codeless or stub address produces exactly that while moving
    /// nothing, so rewards would vanish with no signal at all.
    function test_DeployGuardRejectsAStubTokenThatMovesNothing() public {
        DeployWalletchi script = new DeployWalletchi();
        SilentStubToken stub = new SilentStubToken();
        stub.setBalance(player, 1000e18); // it CLAIMS a balance, it just never moves any
        vm.expectRevert(
            bytes("care token did not debit the sender: it is not a real ERC-20 and rewards would vanish")
        );
        script.requireTokenReallyMoves(address(stub), player);
    }

    function test_DeployGuardRejectsACodelessTokenInTheMovementProbe() public {
        DeployWalletchi script = new DeployWalletchi();
        vm.expectRevert(bytes("care token has no code"));
        script.requireTokenReallyMoves(makeAddr("notAToken"), player);
    }

    function test_DeployGuardRequiresTheDeployerToActuallyHoldSome() public {
        DeployWalletchi script = new DeployWalletchi();
        vm.expectRevert(
            bytes("deployer holds no CARE: fund the deployer before deploying so the token can be verified")
        );
        script.requireTokenReallyMoves(address(care), makeAddr("brokeDeployer"));
    }

    function test_DeployGuardAcceptsARealTokenThatMoves() public {
        DeployWalletchi script = new DeployWalletchi();
        care.mint(player, 1000e18);
        uint256 before = care.balanceOf(player);
        script.requireTokenReallyMoves(address(care), player); // must not revert
        assertEq(care.balanceOf(player), before - 1, "the probe really moved one raw unit");
    }

    /// And the reason it matters, demonstrated end to end on the vault itself.
    ///
    /// WORSE THAN THE AUDIT SAID. `try careToken.transfer(...) returns (bool ok)` does NOT degrade to
    /// the catch branch against a token that returns no data: Solidity's try/catch catches a revert
    /// BY THE CALLEE, not a failure to DECODE the declared return value, so finalize() reverted
    /// outright and uncatchably. With care(), register() and the surplus-only sweep all already shut
    /// at that point, the pot was unreachable PERMANENTLY. The payout now uses a raw call with the
    /// SafeERC20 tolerance, so a no-return-data token settles the season and pays normally.
    function test_ANoReturnDataTokenStillSettlesAndPays() public {
        NoReturnCareToken bad = new NoReturnCareToken();
        vm.startPrank(owner);
        Pet721 p2 = new Pet721("WALLETCHI", "WCHI", MAX_SUPPLY, owner, owner, "");
        PetIssuer i2 = new PetIssuer(
            p2,
            IERC6551Registry(address(registry)),
            address(impl),
            IERC20(address(bad)),
            relayer,
            owner,
            PER_TX_CAP,
            DAILY_CAP,
            STARTER
        );
        PetVault v2 = new PetVault(
            PetVault.Params({
                careToken: IERC20(address(bad)),
                pet: p2,
                issuer: IPetCareSpender(address(i2)),
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
                minPlayers: 2,
                careCooldown: 0,
                minSeasonDuration: MIN_SEASON,
                entryWindowSecs: ENTRY_WINDOW
            , selloutStartsSeason: false})
        );
        p2.setIssuer(address(i2));
        i2.setVault(address(v2));
        p2.setVaultRef(address(v2));
        vm.stopPrank();
        bad.mint(address(i2), FLOAT);

        (uint256 x,) = _mintOn(i2, player);
        (uint256 y,) = _mintOn(i2, player);
        vm.prank(player);
        v2.care(x, 0);
        vm.warp(block.timestamp + 60);
        vm.prank(player);
        v2.care(y, 0);
        vm.warp(v2.seasonStart() + MIN_SEASON + LIFE_TTL);
        assertTrue(v2.isOver());
        uint256 prize = v2.pot();
        assertGt(prize, 0);
        address winnerTba = i2.accountOf(v2.leader());
        uint256 before = bad.balanceOf(winnerTba);

        v2.finalize(); // used to revert here, permanently, with every other exit already shut
        assertTrue(v2.potClaimed(), "the season settles against a no-return-data token");
        assertEq(v2.prizePaid(), prize, "and the prize is actually PAID, not merely deferred");
        assertEq(v2.unpaidPrize(v2.leader()), 0);
        assertEq(bad.balanceOf(winnerTba) - before, prize, "the winner's TBA really received it");
    }

    /// The other half of the tolerance: a token that returns FALSE must still be treated as a
    /// failure and deferred, not waved through as if empty data had come back.
    function test_AFalseReturningTokenDefersRatherThanBeingWavedThrough() public {
        // A dedicated care token that pays normally until the moment of settlement, then returns
        // false. Modelling a token that flips a switch at exactly the wrong time.
        FlakyCareToken flaky = new FlakyCareToken();
        vm.startPrank(owner);
        Pet721 p2 = new Pet721("WALLETCHI", "WCHI", MAX_SUPPLY, owner, owner, "");
        PetIssuer i2 = new PetIssuer(
            p2,
            IERC6551Registry(address(registry)),
            address(impl),
            IERC20(address(flaky)),
            relayer,
            owner,
            PER_TX_CAP,
            DAILY_CAP,
            STARTER
        );
        PetVault v2 = new PetVault(
            PetVault.Params({
                careToken: IERC20(address(flaky)),
                pet: p2,
                issuer: IPetCareSpender(address(i2)),
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
                minPlayers: 2,
                careCooldown: 0,
                minSeasonDuration: MIN_SEASON,
                entryWindowSecs: ENTRY_WINDOW
            , selloutStartsSeason: false})
        );
        p2.setIssuer(address(i2));
        i2.setVault(address(v2));
        p2.setVaultRef(address(v2));
        vm.stopPrank();
        flaky.mint(address(i2), FLOAT);

        (uint256 x,) = _mintOn(i2, player);
        (uint256 y,) = _mintOn(i2, player);
        vm.prank(player);
        v2.care(x, 0);
        vm.warp(block.timestamp + 60);
        vm.prank(player);
        v2.care(y, 0);
        vm.warp(v2.seasonStart() + MIN_SEASON + LIFE_TTL);
        uint256 prize = v2.pot();
        assertGt(prize, 0);

        flaky.setReturnFalse(true);
        v2.finalize();
        assertTrue(v2.potClaimed(), "the season still settles");
        assertEq(v2.prizePaid(), 0, "a false return is NOT treated as payment");
        assertEq(v2.unpaidPrize(v2.leader()), prize, "the prize is held for pushPrize");

        // ...and ANYONE pokes it back out once the token behaves again, into the winning pet's own
        // TBA (season-2 no-claims law: the destination is never caller-chosen). Read the leader
        // BEFORE the prank: an intervening staticcall from the test contract would consume it.
        uint256 winnerId = v2.leader();
        address winnerTba = i2.accountOf(winnerId);
        uint256 tbaBefore = flaky.balanceOf(winnerTba);
        flaky.setReturnFalse(false);
        vm.prank(makeAddr("anyBot"));
        v2.pushPrize(winnerId);
        assertEq(flaky.balanceOf(winnerTba) - tbaBefore, prize, "the winner is made whole in its TBA");
    }

    /// A codeless care-token address can never be configured, so "call succeeded with empty return
    /// data" can never mean "nothing happened but we counted it as paid".
    function test_ACodelessCareTokenIsRefusedAtConstruction() public {
        PetVault.Params memory p = PetVault.Params({
            careToken: IERC20(makeAddr("notAToken")),
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
            minPlayers: MIN_PLAYERS,
            careCooldown: 0,
            minSeasonDuration: MIN_SEASON,
            entryWindowSecs: ENTRY_WINDOW
        , selloutStartsSeason: false});
        vm.expectRevert(PetVault.BadToken.selector);
        new PetVault(p);
    }

    function _mintOn(PetIssuer issuer_, address to) internal returns (uint256 id, address tba) {
        vm.prank(relayer);
        (id, tba) = issuer_.issuePet(to);
    }
}
