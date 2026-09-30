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
import {careAll} from "./utils/FiveNeedsTestLib.sol";

/// @dev A care token that can refuse to pay a specific address, the way a real third-party launch
///      with a blacklist or a pause switch would. Models the mainnet care token we do not control.
contract BlacklistCareToken is ERC20 {
    mapping(address => bool) public blocked;

    constructor() ERC20("Blacklist Care", "BCARE") {}

    function decimals() public pure override returns (uint8) {
        return 18;
    }

    function mint(address to, uint256 amount) external {
        _mint(to, amount);
    }

    function setBlocked(address who, bool v) external {
        blocked[who] = v;
    }

    function _update(address from, address to, uint256 value) internal override {
        require(!blocked[to] && !blocked[from], "BLOCKED");
        super._update(from, to, value);
    }
}

/// @notice Regression cover for the wave-4 solidity audit. Each test is the auditor's attack
///         narrative, kept as the thing that must keep failing to work.
abstract contract Wave4Base is Test {
    ERC6551Registry internal registry;
    WalletchiAccount internal accountImpl;
    Pet721 internal pet;
    PetIssuer internal issuer;
    PetVault internal vault;

    address internal owner = makeAddr("owner");
    address internal relayer = makeAddr("relayer");
    address internal attacker = makeAddr("attacker");
    address internal player = makeAddr("player");

    uint256 internal constant MAX_SUPPLY = 2000;
    uint256 internal constant CARE_COST = 1e18;
    uint256 internal constant STARTER = 100e18;
    uint256 internal constant FLOAT = 1_000_000e18;

    struct Cfg {
        uint256 lifeTtl;
        uint256 careCooldown;
        uint256 minPlayers;
        uint256 minSeasonDuration;
        uint256 perTxCap;
        uint256 dailyCap;
        uint256 starter;
    }

    function _wire(IERC20 careToken, Cfg memory c) internal {
        registry = new ERC6551Registry();
        accountImpl = new WalletchiAccount();
        pet = new Pet721("WALLETCHI", "WCHI", MAX_SUPPLY, owner, owner, "");
        issuer = new PetIssuer(
            pet,
            IERC6551Registry(address(registry)),
            address(accountImpl),
            careToken,
            relayer,
            owner,
            c.perTxCap,
            c.dailyCap,
            c.starter
        );
        vault = new PetVault(
            PetVault.Params({
                careToken: careToken,
                pet: pet,
                issuer: IPetCareSpender(address(issuer)),
                owner: owner,
                lifeTtl: c.lifeTtl,
                careCost: CARE_COST,
                potBps: 1000,
                burnBps: 9000,
                rewardsBps: 0,
                rewardsRecipient: address(0),
                gasBps: 0,
                gasRecipient: address(0),
                abandonGrace: 90 days,
                minPlayers: c.minPlayers,
                careCooldown: c.careCooldown,
                minSeasonDuration: c.minSeasonDuration,
                entryWindowSecs: c.minSeasonDuration,
                selloutStartsSeason: false
            })
        );
        vm.startPrank(owner);
        pet.setIssuer(address(issuer));
        issuer.setVault(address(vault));
        pet.setVaultRef(address(vault));
        vm.stopPrank();
        // Historical: the old single-timer cooldown blocked a first care at Foundry's t=1 (hatch is
        // never cooldown-blocked since the five-needs redesign). Kept so every test below starts at
        // a stable, comfortably-elapsed timestamp.
        vm.warp(block.timestamp + c.careCooldown + 1);
    }

    function _defaults() internal pure returns (Cfg memory c) {
        c = Cfg({
            lifeTtl: 1 days,
            careCooldown: 60,
            minPlayers: 3,
            minSeasonDuration: 14 days,
            perTxCap: CARE_COST,
            dailyCap: CARE_COST * 20,
            starter: STARTER
        });
    }

    function _mint(address to) internal returns (uint256 id, address tba) {
        vm.prank(relayer);
        (id, tba) = issuer.issuePet(to);
    }
}

// ================================================================================================
// HIGH-1. A cheap early freeze must not be able to destroy the collection, and the season must not
// be decidable on day 0.
// ================================================================================================
contract Wave4EarlyFreezeTest is Wave4Base {
    MockCareToken internal care;

    function setUp() public {
        care = new MockCareToken();
        _wire(IERC20(address(care)), _defaults());
        care.mint(address(issuer), FLOAT);
    }

    /// The attack: mint minPlayers pets for free, feed each once entirely out of the project's own
    /// seeded float, and arm the endgame on day 0. The season floor makes it impossible.
    function test_DayZeroSybilCannotDecideTheSeason() public {
        Cfg memory c = _defaults();
        uint256[] memory ids = new uint256[](c.minPlayers);
        for (uint256 i = 0; i < c.minPlayers; i++) {
            (ids[i],) = _mint(attacker);
        }

        uint256 spendBefore = care.balanceOf(attacker);
        for (uint256 i = 0; i < c.minPlayers; i++) {
            vm.prank(attacker);
            vault.care(ids[i], 0);
        }
        assertEq(care.balanceOf(attacker), spendBefore, "the attack costs the attacker nothing");
        assertEq(uint256(vault.contestedAt()), block.timestamp, "the race is contested immediately");

        // One life window later the OLD rule would have decided it. The floor holds it open.
        vm.warp(block.timestamp + c.lifeTtl);
        assertFalse(vault.isOver(), "a day-0 snipe must not decide the season");
        vm.expectRevert(PetVault.GameNotOver.selector);
        vault.finalize();

        // It only becomes decidable once the minimum season has actually elapsed.
        vm.warp(vault.seasonStart() + vault.minSeasonDuration());
        assertTrue(vault.isOver(), "decidable once the season floor passes");
    }

    /// The damage that made it critical: register() reverting bricked the whole collection, because
    /// issuePet calls it unconditionally and every pointer between the contracts is one-way locked.
    function test_DecidedSeasonDoesNotBrickTheCollection() public {
        Cfg memory c = _defaults();
        uint256[] memory ids = new uint256[](c.minPlayers);
        for (uint256 i = 0; i < c.minPlayers; i++) {
            (ids[i],) = _mint(attacker);
        }
        for (uint256 i = 0; i < c.minPlayers; i++) {
            vm.prank(attacker);
            vault.care(ids[i], 0);
        }
        vm.warp(vault.seasonStart() + vault.minSeasonDuration() + c.lifeTtl);
        assertTrue(vault.isOver());
        vault.finalize();

        // THE ORIGINAL FIX (register() no-ops instead of reverting) is what stopped a decided season
        // from bricking the collection, and it is still there: reached directly below, because the
        // roster close now makes it unreachable through issuePet. That branch is the only thing
        // standing between a hand-wired issuer and a permanently unmintable collection, since
        // Pet721.issuer, PetIssuer.vault and Pet721.vault are all one-way locked.
        uint256 registeredBefore = vault.registeredCount();
        vm.prank(address(issuer));
        vault.register(ids[0]); // no revert, no state change
        assertEq(vault.registeredCount(), registeredBefore, "register no-ops rather than bricking");

        // THE BETTER FIX (this wave): minting into a decided season is refused outright instead of
        // producing an inert token the buyer cannot tell from a live pet. Nothing is consumed by the
        // refusal, so no supply is burned and no id is skipped.
        uint256 mintedBefore = pet.totalMinted();
        vm.prank(relayer);
        vm.expectRevert(PetIssuer.EntryWindowClosed.selector);
        issuer.issuePet(player);
        assertEq(pet.totalMinted(), mintedBefore, "a refused late mint consumes nothing");

        vm.warp(block.timestamp + 3650 days);
        vm.prank(relayer);
        vm.expectRevert(PetIssuer.EntryWindowClosed.selector);
        issuer.issuePet(player);
        assertEq(pet.totalMinted(), mintedBefore, "still refused a decade later, still nothing consumed");
    }

    /// The roster close and the season floor must not be able to contradict each other: a mint the
    /// contract ACCEPTS must always land in a season that is still running. This is the property the
    /// entry deadline exists for, checked at the boundary second.
    function test_ASeasonCanNeverBeDecidedWhileEntryIsStillOpen() public {
        Cfg memory c = _defaults();
        uint256[] memory ids = new uint256[](c.minPlayers);
        for (uint256 i = 0; i < c.minPlayers; i++) {
            (ids[i],) = _mint(attacker);
        }
        for (uint256 i = 0; i < c.minPlayers; i++) {
            vm.prank(attacker);
            vault.care(ids[i], 0);
        }
        // One second before the roster closes: entry is open, so the season MUST NOT be decidable,
        // no matter what the care timers say (here every rival lapsed long ago).
        vm.warp(vault.entryDeadline() - 1);
        assertFalse(vault.isOver(), "decidable while entry is still open");
        vm.expectRevert(PetVault.GameNotOver.selector);
        vault.finalize();
        // And a mint accepted at that instant gets a real season: it can hatch immediately.
        vm.prank(relayer);
        (uint256 lastIn,) = issuer.issuePet(player);
        (bool reg,,,,) = vault.petState(lastIn);
        assertTrue(reg, "a pet minted before the close is REGISTERED, not inert");
        vm.prank(player);
        vault.care(lastIn, 0);
        assertTrue(vault.alive(lastIn), "and it can actually play");
    }

    /// The season floor is bounded so it can never be shorter than a single life window.
    function test_SeasonFloorCannotBeShorterThanOneLifeWindow() public {
        Cfg memory c = _defaults();
        vm.expectRevert(PetVault.BadConfig.selector);
        new PetVault(
            PetVault.Params({
                careToken: IERC20(address(care)),
                pet: pet,
                issuer: IPetCareSpender(address(issuer)),
                owner: owner,
                lifeTtl: c.lifeTtl,
                careCost: CARE_COST,
                potBps: 1000,
                burnBps: 9000,
                rewardsBps: 0,
                rewardsRecipient: address(0),
                gasBps: 0,
                gasRecipient: address(0),
                abandonGrace: 90 days,
                minPlayers: c.minPlayers,
                careCooldown: c.careCooldown,
                minSeasonDuration: c.lifeTtl - 1,
                entryWindowSecs: c.lifeTtl - 1,
                selloutStartsSeason: false
            })
        );
    }
}

// ================================================================================================
// HIGH-2. The doomed-pet cap guard must scale with lifeTtl, not assume a one-day life window.
// ================================================================================================
contract Wave4DoomedCapsTest is Wave4Base {
    MockCareToken internal care;

    /// The exact config the old `dailyCap >= perTxCap * 2` guard blessed: at a 4h life window a pet
    /// needs six cares per rolling 24h window and the caps permitted two, so EVERY pet in the
    /// collection died after two cares still holding 98 of its 100 starter tokens.
    function test_ShortSeasonCapsAreRejectedAtMint() public {
        care = new MockCareToken();
        Cfg memory c = _defaults();
        c.lifeTtl = 4 hours;
        c.careCooldown = 1 hours;
        c.minSeasonDuration = 14 days;
        c.perTxCap = CARE_COST;
        c.dailyCap = CARE_COST * 2; // exactly the floor the OLD guard demanded
        _wire(IERC20(address(care)), c);
        care.mint(address(issuer), FLOAT);

        vm.expectRevert(PetIssuer.CapsTooLowForCare.selector);
        vm.prank(relayer);
        issuer.issuePet(player);
    }

    /// With caps that respect the life window, the same 4h season produces a pet that survives on
    /// perfect play, which is the property that actually matters.
    function test_ShortSeasonPetSurvivesOnAdequateCaps() public {
        care = new MockCareToken();
        Cfg memory c = _defaults();
        c.lifeTtl = 4 hours;
        c.careCooldown = 1 hours;
        c.perTxCap = CARE_COST;
        // FIVE NEEDS: the issuer demands cost * (5 * ceil(1 day / 4h) + 1) = 31; the actual survival
        // cadence below lands up to 7 full five-need rounds inside one spend window, so leave real
        // headroom rather than the exact statutory floor.
        c.dailyCap = CARE_COST * 36;
        _wire(IERC20(address(care)), c);
        care.mint(address(issuer), FLOAT);

        // Care at a realistic cadence: a full five-need round just inside each 4h life window, which
        // is the ~30 cares a day survival actually demands under five needs. The cap must have room
        // for that rate plus phase drift.
        (uint256 id,) = _mint(player);
        uint256 rounds;
        for (uint256 i = 0; i < 12; i++) {
            vm.warp(block.timestamp + c.lifeTtl - 30 minutes);
            assertFalse(vault.isDead(id), "pet died mid-run despite every need served in its window");
            careAll(vault, id);
            rounds++;
        }
        assertFalse(vault.isDead(id), "a well-capped pet survives perfect play");
        assertEq(rounds, 12, "every five-need round in the run was affordable under the caps");
    }

    /// setCaps enforces the same rule, so a bad value cannot sit waiting to break the next mint.
    function test_SetCapsRejectsCapsThatCannotSustainTheLifeWindow() public {
        care = new MockCareToken();
        Cfg memory c = _defaults();
        c.lifeTtl = 4 hours;
        c.careCooldown = 1 hours;
        c.perTxCap = CARE_COST;
        c.dailyCap = CARE_COST * 7;
        _wire(IERC20(address(care)), c);

        vm.prank(owner);
        vm.expectRevert(PetIssuer.CapsTooLowForCare.selector);
        issuer.setCaps(CARE_COST, CARE_COST * 2);
    }
}

// ================================================================================================
// HIGH-3. A hostile care token can delay the payout but must never destroy it.
// ================================================================================================
contract Wave4PrizeRecoveryTest is Wave4Base {
    BlacklistCareToken internal care;

    function setUp() public {
        care = new BlacklistCareToken();
        _wire(IERC20(address(care)), _defaults());
        care.mint(address(issuer), FLOAT);
    }

    function _decideSeason() internal returns (uint256 winnerId, uint256 potNow) {
        Cfg memory c = _defaults();
        uint256[] memory ids = new uint256[](c.minPlayers);
        for (uint256 i = 0; i < c.minPlayers; i++) {
            (ids[i],) = _mint(attacker);
        }
        for (uint256 i = 0; i < c.minPlayers; i++) {
            vm.prank(attacker);
            vault.care(ids[i], 0);
        }
        vm.warp(vault.seasonStart() + vault.minSeasonDuration() + c.lifeTtl);
        assertTrue(vault.isOver());
        winnerId = vault.leader();
        potNow = vault.pot();
    }

    function test_BlacklistedWinnerDefersThePrizeAndAnyonePushesIt() public {
        (uint256 winnerId, uint256 potNow) = _decideSeason();
        assertGt(potNow, 0);

        // The winner's own TBA cannot receive. Under the old code this reverted finalize() forever,
        // and by then care(), register() and the surplus-only sweep were ALL already shut, so the
        // pot was unreachable permanently.
        address tba = issuer.accountOf(winnerId);
        care.setBlocked(tba, true);

        vault.finalize();
        assertTrue(vault.potClaimed(), "the season still settles");
        assertEq(vault.pot(), 0);
        assertEq(vault.unpaidPrize(winnerId), potNow, "the prize is held, not lost");
        assertEq(vault.totalUnpaidPrize(), potNow);
        assertEq(vault.prizePaid(), 0);

        // The retry is a PERMISSIONLESS PUSH once the token lets the TBA receive again. The winner
        // signs nothing and the destination is fixed at the pet's own account.
        care.setBlocked(tba, false);
        uint256 tbaBefore = care.balanceOf(tba);
        vm.prank(makeAddr("anyBot"));
        vault.pushPrize(winnerId);
        assertEq(care.balanceOf(tba) - tbaBefore, potNow, "the winner is made whole in its own TBA");
        assertEq(vault.unpaidPrize(winnerId), 0);
        assertEq(vault.totalUnpaidPrize(), 0);
        assertEq(vault.prizePaid(), potNow);
    }

    function test_DeferredPrizeIsNotSweepableAsResidual() public {
        (uint256 winnerId, uint256 potNow) = _decideSeason();
        care.setBlocked(issuer.accountOf(winnerId), true);
        vault.finalize();

        vm.startPrank(owner);
        vault.queueSweep(address(care), owner, potNow);
        vm.warp(block.timestamp + vault.SWEEP_TIMELOCK());
        vm.expectRevert(PetVault.SweepExceedsSurplus.selector);
        vault.executeSweep();
        vm.stopPrank();
        assertEq(vault.unpaidPrize(winnerId), potNow, "the winner's money is still the winner's");
    }

    function test_ADeferredPrizeCanRecoverFromAPermanentlyBlockedTba() public {
        (uint256 winnerId, uint256 potNow) = _decideSeason();
        address tba = issuer.accountOf(winnerId);
        care.setBlocked(tba, true);
        vault.finalize();

        // Before the NFT owner configures recovery, the blocked default still fails safely and the
        // prize stays fully escrowed.
        vm.prank(player);
        vm.expectRevert(PetVault.PrizeTransferFailed.selector);
        vault.pushPrize(winnerId);
        assertEq(vault.unpaidPrize(winnerId), potNow, "still escrowed");
        assertEq(vault.prizePaid(), 0);

        // THE PRIZE PET IS EXEMPT FROM THE SOULBOUND RULE, and this is the case that made it matter.
        // finalize() is permissionless and deliberately does not require the leader to be alive
        // (requiring it would either strand the pot when the poke is late or reward withholding the
        // poke), so by settlement the winner has normally outlived its own timer too. Under the old
        // rule that turned the single most valuable token in the collection into a permanent
        // unsellable memorial at the exact moment it won. Since season 2 the champion is IMMORTAL:
        // the clock verdict underneath is still "lapsed", but it never reads dead anywhere.
        assertFalse(vault.isDead(winnerId), "the champion never reads dead once it has won");
        assertTrue(vault.alive(winnerId), "it reads alive, forever");
        assertFalse(vault.transferLocked(winnerId), "the winner is exempt from the transfer lock");
        assertEq(vault.prizeWinner(), winnerId, "and the exemption is keyed to exactly that one id");
        vm.prank(attacker);
        pet.transferFrom(attacker, player, winnerId);
        assertEq(pet.ownerOf(winnerId), player, "the prize NFT is sellable, not a bricked memorial");

        // The new owner may select a recovery address without pulling money or choosing an amount.
        // The old owner cannot leave or install a redirect after the sale.
        address recovery = makeAddr("winnerRecovery");
        vm.expectRevert(abi.encodeWithSelector(Pet721.NotTokenOwner.selector, winnerId, attacker));
        vm.prank(attacker);
        pet.setPayoutAddress(winnerId, recovery);
        vm.prank(player);
        pet.setPayoutAddress(winnerId, recovery);

        // A total stranger performs the push and gets nothing. The TBA remains blacklisted; the
        // owner-authorized alternate is what makes the otherwise permanent escrow reachable.
        address stranger = makeAddr("stranger");
        vm.prank(stranger);
        vault.pushPrize(winnerId);
        assertEq(care.balanceOf(recovery), potNow, "the owner-authorized receiver is made whole");
        assertEq(care.balanceOf(tba), STARTER - CARE_COST, "blocked TBA receives no prize");
        assertEq(care.balanceOf(stranger), 0, "and never at whoever poked it");
        assertEq(vault.prizePaid(), potNow);
    }

    /// The soulbound carve-out is EXACTLY one pet wide. Every other dead pet in the collection stays
    /// a permanent memorial, which is the product property, and nothing is exempt before settlement.
    function test_TheSoulboundCarveOutIsOnlyEverThePotWinner() public {
        (uint256 winnerId,) = _decideSeason();

        // Before finalize there is no exemption at all, not even for the standing leader.
        assertEq(vault.prizeWinner(), 0, "no winner exists until the pot is claimed");
        assertTrue(vault.isDead(winnerId));
        assertTrue(vault.transferLocked(winnerId), "the leader is locked while the season is unsettled");
        vm.prank(attacker);
        vm.expectRevert(abi.encodeWithSignature("PetIsDead(uint256)", winnerId));
        pet.transferFrom(attacker, player, winnerId);

        vault.finalize();

        // After finalize: the winner moves, and every OTHER dead pet is still frozen forever.
        uint256 checked;
        for (uint256 id = 1; id <= pet.totalMinted(); id++) {
            if (id == winnerId) continue;
            if (!vault.isDead(id)) continue;
            assertTrue(vault.transferLocked(id), "a dead non-winner must stay soulbound");
            address holder = pet.ownerOf(id);
            vm.prank(holder);
            vm.expectRevert(abi.encodeWithSignature("PetIsDead(uint256)", id));
            pet.transferFrom(holder, player, id);
            checked++;
        }
        assertGt(checked, 0, "the season really did leave other dead pets to check");

        vm.prank(attacker);
        pet.transferFrom(attacker, player, winnerId);
        assertEq(pet.ownerOf(winnerId), player, "only the winner moves");
    }

    function test_NormalTokenStillPaysStraightThrough() public {
        (uint256 winnerId, uint256 potNow) = _decideSeason();
        address tba = issuer.accountOf(winnerId);
        uint256 before = care.balanceOf(tba);
        vault.finalize();
        assertEq(care.balanceOf(tba) - before, potNow, "the happy path is unchanged");
        assertEq(vault.unpaidPrize(winnerId), 0);
        assertEq(vault.prizePaid(), potNow);
    }
}

// ================================================================================================
// HIGH-4. A leaked relayer key must not be able to mint the whole supply and walk off with the float.
// ================================================================================================
contract Wave4RelayerBoundsTest is Wave4Base {
    MockCareToken internal care;

    function setUp() public {
        care = new MockCareToken();
        _wire(IERC20(address(care)), _defaults());
        care.mint(address(issuer), FLOAT);
    }

    function test_OwnerCanPauseIssuance() public {
        _mint(player); // works before

        vm.prank(owner);
        issuer.setPaused(true);
        vm.expectRevert(PetIssuer.IssuancePaused.selector);
        vm.prank(relayer);
        issuer.issuePet(attacker);

        vm.prank(owner);
        issuer.setPaused(false);
        _mint(player); // and resumes cleanly
    }

    function test_MintBudgetBoundsALeakedRelayerToOneWindow() public {
        vm.prank(owner);
        issuer.setMintBudget(3, 1 hours);

        for (uint256 i = 0; i < 3; i++) {
            _mint(attacker);
        }
        vm.expectRevert(PetIssuer.MintBudgetExhausted.selector);
        vm.prank(relayer);
        issuer.issuePet(attacker);

        // The float a leaked key can reach in one window is bounded by that budget.
        assertEq(care.balanceOf(address(issuer)), FLOAT - 3 * STARTER);

        // Next window reopens.
        vm.warp(block.timestamp + 1 hours);
        _mint(attacker);
    }

    function test_MintBudgetOfZeroIsUncapped() public {
        vm.prank(owner);
        issuer.setMintBudget(0, 0);
        for (uint256 i = 0; i < 5; i++) {
            _mint(attacker);
        }
        assertEq(pet.totalMinted(), 5);
    }

    function test_OnlyOwnerCanPauseOrBudget() public {
        vm.prank(attacker);
        vm.expectRevert();
        issuer.setPaused(true);
        vm.prank(attacker);
        vm.expectRevert();
        issuer.setMintBudget(1, 1 hours);
    }
}
