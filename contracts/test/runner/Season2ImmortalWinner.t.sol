// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

// SEASON 2: THE CHAMPION IS IMMORTAL, AND THE WINNER NEVER SIGNS ANYTHING.
// UNAUDITED: re-audit before mainnet.
//
// Two rulings meet in this file (Hunt 2026-08-30).
//
// 1. IMMORTALITY. finalize() is permissionless and deliberately does not require the leader to be
//    alive, so the NORMAL case is that by the time the last rival lapses the winner has lapsed too.
//    Season 1 therefore turned the single most valuable token in the collection into a permanent
//    memorial at the exact instant it won. Since season 2 the pot winner never reads dead again,
//    anywhere: isDead, alive, petState, memorialState and transferLocked all carve it out.
//
// 2. NO CLAIMS. claimPrize(tokenId, to) is gone. A prize a hostile token merely delayed stays
//    escrowed and is retried by the permissionless pushPrize(tokenId), which can only ever pay the
//    winning pet's OWN account. The redirect lever was also a phishing surface aimed at winners.
//
// The carve-out is asserted POSITIVELY (the champion reads alive) and BOUNDED (every other dead pet
// is checked to be untouched), because an exemption nobody measures is an exemption that spreads.

import {Test} from "forge-std/Test.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";

import {ERC6551Registry} from "erc6551/ERC6551Registry.sol";
import {IERC6551Registry} from "erc6551/interfaces/IERC6551Registry.sol";

import {WalletchiAccount} from "../../src/WalletchiAccount.sol";
import {Pet721} from "../../src/runner/Pet721.sol";
import {PetIssuer} from "../../src/runner/PetIssuer.sol";
import {PetVault, IPetCareSpender} from "../../src/runner/PetVault.sol";
import {CareRewardsDistributor} from "../../src/runner/CareRewardsDistributor.sol";
import {careAll} from "./utils/FiveNeedsTestLib.sol";

/// @dev The mainnet care token we do NOT control, modelled honestly: it can refuse an address
///      (blacklist / pause) and it can take tokens back (a clawback or a rebase down). Both are
///      named in _payWinner's natspec as the reasons the payout must be non-blocking and must pay
///      min(pot, balance) rather than pot.
contract HostileCareToken is ERC20 {
    mapping(address => bool) public blocked;
    // 0=normal, 1=move then return false, 2=move then return malformed bool,
    // 3=return true without moving. These model ERC-20 returndata as adversarial.
    uint8 public returnMode;

    constructor() ERC20("Hostile Care", "HCARE") {}

    function mint(address to, uint256 amount) external {
        _mint(to, amount);
    }

    function setBlocked(address who, bool v) external {
        blocked[who] = v;
    }

    function setReturnMode(uint8 mode) external {
        returnMode = mode;
    }

    function transfer(address to, uint256 value) public override returns (bool) {
        if (returnMode == 3) return true;
        super.transfer(to, value);
        if (returnMode == 1) return false;
        if (returnMode == 2) {
            // A non-canonical ABI bool. `abi.decode(..., (bool))` reverts on this
            // even though the transfer itself already happened.
            assembly ("memory-safe") {
                mstore(0, 2)
                return(0, 32)
            }
        }
        return true;
    }

    /// @dev A clawback / rebase-down: the balance moves out from under the vault's own accounting.
    function seize(address from, uint256 amount) external {
        _burn(from, amount);
    }

    function _update(address from, address to, uint256 value) internal override {
        require(!blocked[to] && !blocked[from], "BLOCKED");
        super._update(from, to, value);
    }
}

abstract contract ChampionBase is Test {
    ERC6551Registry internal registry;
    WalletchiAccount internal accountImpl;
    Pet721 internal pet;
    PetIssuer internal issuer;
    PetVault internal vault;
    HostileCareToken internal care;
    CareRewardsDistributor internal dist;

    address internal owner = makeAddr("owner");
    address internal relayer = makeAddr("relayer");
    address internal champ = makeAddr("championKeeper");
    address internal rival = makeAddr("rivalKeeper");
    address internal buyer = makeAddr("buyer");
    address internal anyone = makeAddr("anyone"); // proves every push is permissionless

    uint256 internal constant MAX_SUPPLY = 2000;
    uint256 internal constant CARE_COST = 1e18;
    uint256 internal constant LIFE_TTL = 1 days;
    uint256 internal constant EPOCH = 2 hours;

    uint256 internal winnerId;
    uint256[] internal rivals;

    /// @param rewardsBps 0 for the two-leg shape; 2000 wires a REAL CareRewardsDistributor so the
    ///        immortality-to-rewards interaction is exercised end to end rather than assumed.
    function _wire(uint256 rewardsBps) internal {
        care = new HostileCareToken();
        registry = new ERC6551Registry();
        accountImpl = new WalletchiAccount();
        pet = new Pet721("WALLETCHI", "WCHI", MAX_SUPPLY, owner, owner, "");
        issuer = new PetIssuer(
            pet,
            IERC6551Registry(address(registry)),
            address(accountImpl),
            IERC20(address(care)),
            relayer,
            owner,
            CARE_COST,
            CARE_COST * 20,
            CARE_COST * 100
        );
        address rewardsTo = address(0);
        if (rewardsBps > 0) {
            dist = new CareRewardsDistributor(owner, IERC20(address(care)), EPOCH, 0, 12);
            rewardsTo = address(dist);
        }
        vault = new PetVault(
            PetVault.Params({
                careToken: IERC20(address(care)),
                pet: pet,
                issuer: IPetCareSpender(address(issuer)),
                owner: owner,
                lifeTtl: LIFE_TTL,
                careCost: CARE_COST,
                potBps: 1000,
                burnBps: 9000 - rewardsBps,
                rewardsBps: rewardsBps,
                rewardsRecipient: rewardsTo,
                gasBps: 0,
                gasRecipient: address(0),
                abandonGrace: 7 days,
                minPlayers: 2,
                careCooldown: 0,
                // The shortest legal season, so a decided season is a few warps away rather than a
                // fortnight of feeding. The endgame arithmetic is identical at any length.
                minSeasonDuration: LIFE_TTL,
                entryWindowSecs: LIFE_TTL,
                selloutStartsSeason: false
            })
        );
        vm.startPrank(owner);
        pet.setIssuer(address(issuer));
        issuer.setVault(address(vault));
        pet.setVaultRef(address(vault));
        if (rewardsBps > 0) dist.setVault(address(vault));
        vm.stopPrank();
        care.mint(address(issuer), CARE_COST * 100 * 50);
    }

    function _mint(address to) internal returns (uint256 id) {
        vm.prank(relayer);
        (id,) = issuer.issuePet(to);
    }

    /// @dev Run a real season to the instant it is decidable.
    /// @param keepWinnerAlive true to refresh the champion's five needs mid-season, so finalize()
    ///        lands on a LIVING leader. False is the ordinary shape: the poke arrives after the
    ///        winner's own clock has lapsed too, which is exactly why immortality had to exist.
    function _runSeason(bool keepWinnerAlive) internal {
        uint256 start = block.timestamp;
        winnerId = _mint(champ);
        for (uint256 i = 0; i < 2; i++) {
            rivals.push(_mint(rival));
        }
        // Everyone hatches together at the start line.
        vm.prank(champ);
        vault.care(winnerId, 0);
        for (uint256 i = 0; i < rivals.length; i++) {
            vm.prank(rival);
            vault.care(rivals[i], 0);
        }
        if (keepWinnerAlive) {
            // Half a life window in, only the champion's keeper shows up. That single round of care
            // is what makes it the last pet standing.
            vm.warp(start + LIFE_TTL / 2);
            careAll(vault, winnerId);
        }
        vm.warp(start + LIFE_TTL + 1);
        assertTrue(vault.isOver(), "the season is decidable");
        assertEq(vault.leader(), winnerId, "the champion is the standing leader");
    }

    function _decide(bool keepWinnerAlive) internal {
        _runSeason(keepWinnerAlive);
        vault.finalize();
        assertTrue(vault.potClaimed());
    }

    /// @dev Every immortality read, in one place, so no consumer can be quietly left behind.
    function _assertReadsAsChampion(uint256 id) internal view {
        assertFalse(vault.isDead(id), "isDead");
        assertTrue(vault.alive(id), "alive");
        assertFalse(vault.transferLocked(id), "transferLocked");
        (, bool psDead,, bool psAlive,) = vault.petState(id);
        assertFalse(psDead, "petState.dead");
        assertTrue(psAlive, "petState.isAlive");
        (bool memDead,, uint64 diedAt,,) = vault.memorialState(id);
        assertFalse(memDead, "memorialState.dead");
        assertEq(diedAt, 0, "memorialState.diedAt");
    }

    /// @dev The complement: an ordinary lapsed pet, unchanged by the carve-out.
    function _assertReadsAsMemorial(uint256 id) internal view {
        assertTrue(vault.isDead(id), "isDead");
        assertFalse(vault.alive(id), "alive");
        assertTrue(vault.transferLocked(id), "transferLocked");
        (, bool psDead,, bool psAlive,) = vault.petState(id);
        assertTrue(psDead, "petState.dead");
        assertFalse(psAlive, "petState.isAlive");
        (bool memDead,, uint64 diedAt,,) = vault.memorialState(id);
        assertTrue(memDead, "memorialState.dead");
        assertGt(diedAt, 0, "memorialState.diedAt");
    }
}

// ================================================================================================
// Immortality: every read, both season shapes, forever, and bounded to exactly one pet.
// ================================================================================================
contract ImmortalWinnerTest is ChampionBase {
    function setUp() public {
        _wire(0);
    }

    /// THE ORDINARY SHAPE, and the one season 1 got wrong: the poke lands after the winner's own
    /// clock has lapsed. Before settlement it reads dead like anything else; the instant the pot is
    /// paid it reads alive, and it never goes back.
    function test_ALapsedLeaderBecomesImmortalTheInstantItWins() public {
        _runSeason(false);

        // Before finalize there is no exemption at all, not even for the standing leader.
        assertEq(vault.prizeWinner(), 0, "no winner exists until the pot is claimed");
        _assertReadsAsMemorial(winnerId);

        vault.finalize();

        assertEq(vault.prizeWinner(), winnerId);
        _assertReadsAsChampion(winnerId);
    }

    /// A winner that was still ALIVE at settlement must not quietly die afterwards when its own
    /// timer runs out. Immortality is a state, not a snapshot.
    function test_ALivingWinnerNeverLapsesAfterwards() public {
        _decide(true);
        _assertReadsAsChampion(winnerId);

        // Blow straight past the deadline its stamps still imply.
        (,, uint256 deadline) = vault.lifeState(winnerId);
        assertGt(deadline, block.timestamp, "this winner really was alive at settlement");
        vm.warp(deadline + 1);
        _assertReadsAsChampion(winnerId);
    }

    /// Not a grace period. Ten years on, every read still says champion.
    function test_ImmortalityIsPermanent() public {
        _decide(false);
        vm.warp(block.timestamp + 3650 days);
        _assertReadsAsChampion(winnerId);
    }

    /// THE CARVE-OUT IS EXACTLY ONE PET WIDE. Every other dead pet stays a permanent memorial, which
    /// is the product promise the collection is sold on.
    function test_EveryOtherDeadPetIsUntouched() public {
        _decide(false);
        uint256 checked;
        for (uint256 i = 0; i < rivals.length; i++) {
            _assertReadsAsMemorial(rivals[i]);
            address holder = pet.ownerOf(rivals[i]);
            vm.prank(holder);
            vm.expectRevert(abi.encodeWithSignature("PetIsDead(uint256)", rivals[i]));
            pet.transferFrom(holder, buyer, rivals[i]);
            checked++;
        }
        assertGt(checked, 0, "the season really did leave other dead pets to check");
    }

    /// The trophy is TRADEABLE, and not just once: the whole point is a living champion that can
    /// change hands forever, carrying its TBA (and any still-escrowed prize) with it.
    function test_TheChampionCanBeTradedRepeatedlyForever() public {
        _decide(false);
        vm.prank(champ);
        pet.transferFrom(champ, buyer, winnerId);
        assertEq(pet.ownerOf(winnerId), buyer);

        vm.warp(block.timestamp + 365 days);
        vm.prank(buyer);
        pet.transferFrom(buyer, rival, winnerId);
        assertEq(pet.ownerOf(winnerId), rival, "still moving a year later");
        _assertReadsAsChampion(winnerId);
    }

    /// IMMORTALITY IS NOT A LICENCE TO KEEP PLAYING. The season is over for everyone, champion
    /// included: care() refuses, so an immortal pet can never be fed to extend or reopen anything.
    function test_TheChampionStillCannotBeCaredAfterTheSeason() public {
        _decide(true); // alive by every read, and by its own clock too
        assertTrue(vault.alive(winnerId));
        vm.prank(champ);
        vm.expectRevert(PetVault.GameOver.selector);
        vault.care(winnerId, 0);
    }

    /// A DELIBERATE ASYMMETRY, pinned so it reads as a decision rather than an oversight: carerOf
    /// keeps the RAW clock read. care() reverts GameOver post-season, so telling a wallet pass that
    /// one-tap care is live on the champion would be a lie.
    function test_CarerOfDeliberatelyKeepsTheRawClockRead() public {
        _runSeason(false);
        address carer = makeAddr("carer");
        vm.prank(champ);
        vault.setCarer(winnerId, carer, 0);
        vault.finalize();

        assertFalse(vault.isDead(winnerId), "the champion reads alive everywhere else");
        assertEq(vault.carerOf(winnerId), address(0), "but carerOf still reports no live carer");
    }

    /// The exemption is keyed to an id nobody can steer: it appears only at settlement, and only for
    /// the pet the tracker had already elected.
    function test_TheExemptionIsKeyedToTheSettledLeaderAndNothingElse() public {
        _runSeason(false);
        assertEq(vault.prizeWinner(), 0);
        vault.finalize();
        assertEq(vault.prizeWinner(), vault.leader(), "prizeWinner is exactly the settled leader");
        for (uint256 i = 0; i < rivals.length; i++) {
            assertTrue(rivals[i] != vault.prizeWinner());
        }
    }
}

// ================================================================================================
// Immortality reaches ACROSS contracts: the distributor reads the same oracle.
// ================================================================================================
contract ImmortalWinnerRewardsTest is ChampionBase {
    function setUp() public {
        _wire(2000); // a real CareRewardsDistributor on the rewards leg
    }

    /// A dead pet's unclaimed rewards forfeit to the survivors. The champion is not dead, so its
    /// rewards CANNOT be forfeited out from under it: sweepForfeited refuses. This is the
    /// cross-contract consequence of immortality, and it is worth an assertion because the two
    /// contracts agree only because they share one oracle.
    function test_TheChampionsRewardsCanNeverBeForfeited() public {
        _decide(false);
        uint256 e0 = 0;
        skip(EPOCH); // finish the epoch the cares landed in

        uint256[] memory justTheChampion = new uint256[](1);
        justTheChampion[0] = winnerId;
        vm.expectRevert(CareRewardsDistributor.PetIsAlive.selector);
        dist.sweepForfeited(e0, justTheChampion);

        // A lapsed rival in the same epoch forfeits exactly as it always did.
        uint256[] memory justARival = new uint256[](1);
        justARival[0] = rivals[0];
        dist.sweepForfeited(e0, justARival);
        assertTrue(dist.claimed(e0, rivals[0]), "the rival forfeited");
    }

    /// And the push pays it: the champion is the one pet in a settled season that a rewards push
    /// still delivers to, while every lapsed rival is skipped.
    function test_ThePushStillPaysTheChampionAndSkipsTheDead() public {
        _decide(false);
        skip(EPOCH);

        uint256[] memory batch = new uint256[](3);
        batch[0] = winnerId;
        batch[1] = rivals[0];
        batch[2] = rivals[1];
        address champTba = issuer.accountOf(winnerId);
        uint256 before = care.balanceOf(champTba);

        vm.prank(anyone);
        uint256 moved = dist.pushRewards(0, batch);

        assertGt(moved, 0, "the champion was paid");
        assertEq(care.balanceOf(champTba) - before, moved, "into its own TBA");
        assertFalse(dist.claimed(0, rivals[0]), "the dead rivals were skipped, not paid");
        assertFalse(dist.claimed(0, rivals[1]));
    }
}

// ================================================================================================
// The escrowed prize: no claims, ever. A hostile token can delay the payout, nothing more.
// ================================================================================================
contract EscrowedPrizeRetryTest is ChampionBase {
    function setUp() public {
        _wire(0);
    }

    function test_NothingToPushWhenNothingIsOwed() public {
        _decide(false); // the happy path paid straight through
        assertEq(vault.unpaidPrize(winnerId), 0);
        vm.prank(anyone);
        vm.expectRevert(PetVault.NothingToPush.selector);
        vault.pushPrize(winnerId);
    }

    function test_TheHappyPathNeverEscrowsAnything() public {
        _runSeason(false);
        address tba = issuer.accountOf(winnerId);
        uint256 before = care.balanceOf(tba);
        uint256 prize = vault.pot();
        vault.finalize();
        assertEq(care.balanceOf(tba) - before, prize, "paid directly at finalize");
        assertEq(vault.totalUnpaidPrize(), 0);
        assertEq(vault.prizePaid(), prize);
    }

    /// ERC-20 return bytes are attacker-controlled. A token that moves the prize but returns false
    /// used to pay the winner AND record the same full prize as unpaid, enabling a second payout if
    /// the vault was later funded. Observable recipient movement is now the only source of truth.
    function test_AFalseReturnAfterMovementCannotDoubleCreditThePrize() public {
        _runSeason(false);
        address tba = issuer.accountOf(winnerId);
        uint256 before = care.balanceOf(tba);
        uint256 prize = vault.pot();
        care.setReturnMode(1);

        vault.finalize();

        assertEq(care.balanceOf(tba) - before, prize, "the token really moved the prize");
        assertEq(vault.prizePaid(), prize, "measured delivery is credited once");
        assertEq(vault.unpaidPrize(winnerId), 0, "the same prize is not also escrowed");
        assertEq(vault.totalUnpaidPrize(), 0);
    }

    /// A malformed bool used to make finalize's ABI decoder revert after the token returned. The
    /// payout now ignores returndata and verifies the balance postcondition instead.
    function test_AMalformedReturnCannotBrickSettlement() public {
        _runSeason(false);
        address tba = issuer.accountOf(winnerId);
        uint256 before = care.balanceOf(tba);
        uint256 prize = vault.pot();
        care.setReturnMode(2);

        vault.finalize();

        assertTrue(vault.potClaimed());
        assertEq(care.balanceOf(tba) - before, prize);
        assertEq(vault.prizePaid(), prize);
        assertEq(vault.totalUnpaidPrize(), 0);
    }

    /// The inverse lie is just as dangerous: `true` with no movement used to erase the winner's
    /// claim. Finalize now escrows it, and a retry that still moves nothing reverts without reducing
    /// the debt.
    function test_ATrueReturnWithoutMovementCannotEraseThePrize() public {
        _runSeason(false);
        address tba = issuer.accountOf(winnerId);
        uint256 before = care.balanceOf(tba);
        uint256 prize = vault.pot();
        care.setReturnMode(3);

        vault.finalize();

        assertEq(care.balanceOf(tba), before, "nothing actually moved");
        assertEq(vault.prizePaid(), 0);
        assertEq(vault.unpaidPrize(winnerId), prize, "the undelivered prize remains owed");

        vm.expectRevert(PetVault.PrizeTransferFailed.selector);
        vault.pushPrize(winnerId);
        assertEq(vault.unpaidPrize(winnerId), prize, "a lying retry cannot reduce the debt");

        care.setReturnMode(0);
        vault.pushPrize(winnerId);
        assertEq(care.balanceOf(tba) - before, prize, "the honest retry makes the winner whole");
        assertEq(vault.unpaidPrize(winnerId), 0);
        assertEq(vault.prizePaid(), prize);
    }

    /// The full escrow-and-repush cycle, poked by an address with no stake in the season.
    function test_ADeferredPrizeIsRecoveredByAnyPermissionlessPoke() public {
        _runSeason(false);
        address tba = issuer.accountOf(winnerId);
        uint256 prize = vault.pot();
        care.setBlocked(tba, true);

        vault.finalize();
        assertTrue(vault.potClaimed(), "the season settles either way");
        assertEq(vault.pot(), 0);
        assertEq(vault.unpaidPrize(winnerId), prize, "held, not lost");
        assertEq(vault.totalUnpaidPrize(), prize);
        assertEq(vault.prizePaid(), 0);

        care.setBlocked(tba, false);
        uint256 before = care.balanceOf(tba);
        vm.expectEmit(true, true, false, true, address(vault));
        emit PetVault.PrizePushed(winnerId, tba, prize);
        vm.prank(anyone);
        vault.pushPrize(winnerId);

        assertEq(care.balanceOf(tba) - before, prize, "delivered to the pet's own account");
        assertEq(care.balanceOf(anyone), 0, "the poker takes nothing");
        assertEq(vault.unpaidPrize(winnerId), 0);
        assertEq(vault.totalUnpaidPrize(), 0);
        assertEq(vault.prizePaid(), prize);
    }

    /// While the token still refuses, the push reverts WHOLESALE and leaves the escrow intact.
    /// Unlike finalize() there is nothing else this call has to protect, so swallowing the failure
    /// would only hide it.
    function test_APushThatCannotDeliverLeavesTheEscrowUntouched() public {
        _runSeason(false);
        address tba = issuer.accountOf(winnerId);
        uint256 prize = vault.pot();
        care.setBlocked(tba, true);
        vault.finalize();

        vm.prank(anyone);
        vm.expectRevert(PetVault.PrizeTransferFailed.selector);
        vault.pushPrize(winnerId);

        assertEq(vault.unpaidPrize(winnerId), prize, "still owed in full");
        assertEq(vault.totalUnpaidPrize(), prize);
        assertEq(vault.prizePaid(), 0, "and nothing was counted as paid");
    }

    /// A PARTIAL RECOVERY IS NOT A FORFEIT. If a clawback or a rebase-down leaves the vault holding
    /// less than it owes, the push delivers what is actually there and the rest stays owed for a
    /// later poke. Named in _payWinner's natspec as a real mainnet possibility.
    function test_APartialRecoveryLeavesTheRemainderOwed() public {
        _runSeason(false);
        address tba = issuer.accountOf(winnerId);
        uint256 prize = vault.pot();
        care.setBlocked(tba, true);
        vault.finalize();
        assertEq(vault.unpaidPrize(winnerId), prize);

        // The token takes back most of the vault's balance out of band.
        uint256 left = prize / 4;
        care.seize(address(vault), care.balanceOf(address(vault)) - left);
        care.setBlocked(tba, false);

        uint256 before = care.balanceOf(tba);
        vm.prank(anyone);
        vault.pushPrize(winnerId);
        assertEq(care.balanceOf(tba) - before, left, "paid exactly what was actually there");
        assertEq(vault.unpaidPrize(winnerId), prize - left, "the shortfall stays owed");
        assertEq(vault.totalUnpaidPrize(), prize - left);
        assertEq(vault.prizePaid(), left);

        // When the tokens come back, the same permissionless poke finishes the job.
        care.mint(address(vault), prize - left);
        vm.prank(anyone);
        vault.pushPrize(winnerId);
        assertEq(care.balanceOf(tba) - before, prize, "the winner ends up whole");
        assertEq(vault.unpaidPrize(winnerId), 0);
    }

    /// An empty vault has nothing to push, and says so rather than emitting a zero-value payout the
    /// cron would read as success.
    function test_APushWithNothingAvailableRefuses() public {
        _runSeason(false);
        address tba = issuer.accountOf(winnerId);
        care.setBlocked(tba, true);
        vault.finalize();
        care.seize(address(vault), care.balanceOf(address(vault)));

        care.setBlocked(tba, false);
        vm.prank(anyone);
        vm.expectRevert(PetVault.NothingToPush.selector);
        vault.pushPrize(winnerId);
    }

    /// THE ESCROW IS THE WINNER'S MONEY, NOT RESIDUAL. The timelocked owner sweep reserves it even
    /// after the season is settled, so a prize a hostile token merely delayed can never be swept.
    function test_AnEscrowedPrizeIsReservedFromTheOwnerSweep() public {
        _runSeason(false);
        address tba = issuer.accountOf(winnerId);
        uint256 prize = vault.pot();
        care.setBlocked(tba, true);
        vault.finalize();

        vm.startPrank(owner);
        vault.queueSweep(address(care), owner, prize);
        vm.warp(block.timestamp + vault.SWEEP_TIMELOCK());
        vm.expectRevert(PetVault.SweepExceedsSurplus.selector);
        vault.executeSweep();
        vm.stopPrank();
        assertEq(vault.unpaidPrize(winnerId), prize, "the winner's money is still the winner's");

        // Genuine surplus above the escrow is still sweepable, so the reservation is exactly as wide
        // as the debt and no wider.
        care.mint(address(vault), 5e18);
        vm.startPrank(owner);
        vault.queueSweep(address(care), owner, 5e18);
        vm.warp(block.timestamp + vault.SWEEP_TIMELOCK());
        vault.executeSweep();
        vm.stopPrank();
        assertEq(care.balanceOf(owner), 5e18, "donated surplus above the escrow still sweeps");
        assertEq(vault.unpaidPrize(winnerId), prize, "and the escrow is untouched by it");
    }

    /// The recovery path for an under-subscribed season escrows and re-pushes identically: both
    /// settlement routes go through the same non-blocking payout, so neither can strand a prize.
    function test_AnAbandonedSeasonEscrowsAndPushesTheSameWay() public {
        _wire(0);
        uint256 lonely = _mint(champ);
        vm.prank(champ);
        vault.care(lonely, 0); // one player: the roster closes under-subscribed
        uint256 prize = vault.pot();
        assertGt(prize, 0);

        address tba = issuer.accountOf(lonely);
        care.setBlocked(tba, true);
        vm.warp(vault.entryDeadline() + vault.abandonGrace());
        vault.abandonSeason();
        assertTrue(vault.potClaimed());
        assertEq(vault.unpaidPrize(lonely), prize, "the abandon path escrows too");

        care.setBlocked(tba, false);
        uint256 before = care.balanceOf(tba);
        vm.prank(anyone);
        vault.pushPrize(lonely);
        assertEq(care.balanceOf(tba) - before, prize, "and the same permissionless push recovers it");
    }
}
