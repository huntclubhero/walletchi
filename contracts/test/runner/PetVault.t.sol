// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {IERC721Errors} from "@openzeppelin/contracts/interfaces/draft-IERC6093.sol";

import {ERC6551Registry} from "erc6551/ERC6551Registry.sol";
import {IERC6551Registry} from "erc6551/interfaces/IERC6551Registry.sol";

import {WalletchiAccount} from "../../src/WalletchiAccount.sol";
import {Pet721} from "../../src/runner/Pet721.sol";
import {PetIssuer} from "../../src/runner/PetIssuer.sol";
import {PetVault, IPetCareSpender} from "../../src/runner/PetVault.sol";
import {MockCareToken} from "../../src/runner/MockCareToken.sol";
import {careAll} from "./utils/FiveNeedsTestLib.sol";

/// @dev A care token that skims a fee on every transfer (recipient receives less than sent).
contract FeeOnTransferToken is ERC20 {
    address internal constant FEE_SINK = 0x00000000000000000000000000000000000FEE00;
    uint256 public immutable feeBps;

    constructor(uint256 feeBps_) ERC20("FeeOnTransfer", "FOT") {
        feeBps = feeBps_;
    }

    function decimals() public pure override returns (uint8) {
        return 18;
    }

    function mint(address to, uint256 amount) external {
        _mint(to, amount);
    }

    function _update(address from, address to, uint256 value) internal override {
        if (from != address(0) && to != address(0) && feeBps > 0) {
            uint256 fee = (value * feeBps) / 10_000;
            super._update(from, to, value - fee);
            if (fee > 0) super._update(from, FEE_SINK, fee);
        } else {
            super._update(from, to, value);
        }
    }
}

/// @dev A care token that reenters finalize() on transfer, to prove settlement is guarded.
contract MaliciousCareToken is ERC20 {
    PetVault public target;
    bool public armed;
    bool public reentered;
    bytes public lastRevert;

    constructor() ERC20("Malicious Care", "MCARE") {}

    function decimals() public pure override returns (uint8) {
        return 18;
    }

    function mint(address to, uint256 amount) external {
        _mint(to, amount);
    }

    function arm(PetVault target_) external {
        target = target_;
        armed = true;
    }

    function transfer(address to, uint256 amount) public override returns (bool) {
        if (armed) {
            armed = false;
            reentered = true;
            try target.finalize() {
                lastRevert = "";
            } catch (bytes memory err) {
                lastRevert = err;
            }
        }
        return super.transfer(to, amount);
    }
}

abstract contract PetBase is Test {
    ERC6551Registry internal registry;
    WalletchiAccount internal accountImpl;
    Pet721 internal pet;
    PetIssuer internal issuer;
    PetVault internal vault;

    address internal owner = makeAddr("owner");
    address internal relayer = makeAddr("relayer");
    address internal player = makeAddr("player");
    address internal stranger = makeAddr("stranger");
    address internal royaltyRecipient = makeAddr("royaltyRecipient");

    address internal constant BURN = 0x000000000000000000000000000000000000dEaD;

    uint256 internal constant MAX_SUPPLY = 2000;
    uint256 internal constant PER_TX_CAP = 1e18; // == CARE_COST (tight per-tx bound)
    uint256 internal constant DAILY_CAP = 1000e18;
    uint256 internal constant STARTER = 100e18;
    uint256 internal constant LIFE_TTL = 1 days;
    uint256 internal constant CARE_COST = 1e18;
    uint256 internal constant POT_BPS = 1000; // 10%
    uint256 internal constant BURN_BPS = 9000; // 90%
    uint256 internal constant MIN_PLAYERS = 3;
    uint256 internal constant CARE_COOLDOWN = 1 hours;
    uint256 internal constant FLOAT = 1_000_000e18;

    function _params(IERC20 careToken) internal view returns (PetVault.Params memory) {
        return PetVault.Params({
            careToken: careToken,
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
            entryWindowSecs: LIFE_TTL,
            selloutStartsSeason: false
        });
    }

    function _deploySeason(IERC20 careToken) internal {
        registry = new ERC6551Registry();
        accountImpl = new WalletchiAccount();
        pet = new Pet721("WALLETCHI", "WCHI", MAX_SUPPLY, owner, royaltyRecipient, "");
        issuer = new PetIssuer(
            pet,
            IERC6551Registry(address(registry)),
            address(accountImpl),
            careToken,
            relayer,
            owner,
            PER_TX_CAP,
            DAILY_CAP,
            STARTER
        );
        vault = new PetVault(_params(careToken));

        vm.startPrank(owner);
        pet.setIssuer(address(issuer));
        issuer.setVault(address(vault));
        pet.setVaultRef(address(vault)); // wire the death-soulbound oracle (production posture)
        vm.stopPrank();
    }

    function _issue(address to) internal returns (uint256 id, address tba) {
        vm.prank(relayer);
        (id, tba) = issuer.issuePet(to);
    }

    function _careBy(address who, uint256 id) internal {
        vm.prank(who);
        vault.care(id, 0);
    }

    /// @dev Care as the pet's CURRENT owner (care is owner-only since audit access-H-1). Looks the
    ///      owner up each time since pets can transfer. NOTE: not for vm.expectRevert sites (the
    ///      ownerOf staticcall would consume the expectation); use _careBy with a known owner there.
    function _care(uint256 id) internal {
        _careBy(pet.ownerOf(id), id);
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

contract PetLifecycleTest is PetBase {
    MockCareToken internal care;

    function setUp() public {
        care = new MockCareToken();
        _deploySeason(IERC20(address(care)));
        care.mint(address(issuer), FLOAT);
    }

    function test_Pet_NameSymbolFromConstructor() public view {
        assertEq(pet.name(), "WALLETCHI");
        assertEq(pet.symbol(), "WCHI");
    }

    function test_Issue_RegistersSeedsAndSetsSpender() public {
        (uint256 id, address tba) = _issue(player);

        (bool registered, bool dead, uint64 lastCareAt, bool isAlive,) = vault.petState(id);
        assertTrue(registered);
        assertFalse(dead, "a dormant egg is not dead (audit death-F1)");
        assertEq(lastCareAt, 0, "lastCareAt stays 0 until the first care: the clock starts on hatch");
        assertFalse(isAlive, "a never-fed egg is not yet alive (dormant, not in the race)");
        assertEq(vault.registeredCount(), 1);
        assertEq(vault.hatchedCount(), 0, "registered but never fed: not yet hatched into the race");
        assertEq(care.balanceOf(tba), STARTER, "tba seeded");

        WalletchiAccount acct = WalletchiAccount(payable(tba));
        assertTrue(acct.spenderInitialized());
        assertEq(acct.spender(), address(issuer));
        assertEq(acct.owner(), player);
    }

    function test_Issue_RevertsWhenVaultNotSet() public {
        PetIssuer bare = new PetIssuer(
            pet,
            IERC6551Registry(address(registry)),
            address(accountImpl),
            IERC20(address(care)),
            relayer,
            owner,
            PER_TX_CAP,
            DAILY_CAP,
            STARTER
        );
        vm.prank(owner);
        pet.setIssuer(address(bare));
        vm.expectRevert(PetIssuer.VaultNotSet.selector);
        vm.prank(relayer);
        bare.issuePet(player);
    }

    function test_Issue_OnlyRelayer() public {
        vm.expectRevert(PetIssuer.NotRelayer.selector);
        vm.prank(stranger);
        issuer.issuePet(player);
    }

    /// LOW-4: caps are baked into each pet's TBA at mint, so issuance refuses caps that would make
    /// the pet uncareable (perTxCap below the vault's careCost = every pullCare reverts forever).
    /// The disenfranchised-pet guard now fires at setCaps, one step BEFORE the bad value can be
    /// baked into a pet's account. issuePet re-checks it too (below), so both doors are shut.
    function test_SetCaps_RevertsWhenPerTxCapBelowCareCost() public {
        vm.prank(owner);
        vm.expectRevert(PetIssuer.CapsTooLowForCare.selector);
        issuer.setCaps(CARE_COST - 1, DAILY_CAP);
    }

    /// issuePet is the backstop for caps that were set in the CONSTRUCTOR, before the vault existed
    /// and before careCost/lifeTtl could be read. Those never passed through setCaps.
    function test_Issue_RevertsWhenConstructorCapsCannotFeed() public {
        PetIssuer bad = new PetIssuer(
            pet,
            IERC6551Registry(address(registry)),
            address(accountImpl),
            IERC20(address(care)),
            relayer,
            owner,
            CARE_COST - 1,
            DAILY_CAP,
            0
        );
        vm.prank(owner);
        bad.setVault(address(vault));
        vm.expectRevert(PetIssuer.CapsTooLowForCare.selector);
        vm.prank(relayer);
        bad.issuePet(player);
    }

    /// LOW-4: the zero-cap disenfranchisement shape from the finding.
    function test_SetCaps_RevertsWhenCapsZero() public {
        vm.prank(owner);
        vm.expectRevert(PetIssuer.CapsTooLowForCare.selector);
        issuer.setCaps(0, 0);
    }

    /// dailyCap must leave real headroom, and setCaps now refuses the bad value up front rather than
    /// letting it sit until the next mint fails.
    function test_SetCaps_RejectsDailyCapBelowPerTxCap() public {
        vm.prank(owner);
        vm.expectRevert(PetIssuer.CapsTooLowForCare.selector);
        issuer.setCaps(CARE_COST, CARE_COST - 1);
    }

    /// THE DOOMED-PET BOUNDARY. dailyCap == perTxCap == careCost used to be "the tightest legal
    /// config". It is not legal, it is a guaranteed death sentence: the account's 24h window is
    /// anchored at mint and drifts against the pet's life timer, so a one-feed-per-window pet becomes
    /// feedable at roughly the instant it dies, and the caps are baked into the account at mint so no
    /// owner action can ever rescue it. Both the setter and the mint-time check must refuse it.
    function test_OneFeedPerWindowCapsAreRefused() public {
        vm.prank(owner);
        vm.expectRevert(PetIssuer.CapsTooLowForCare.selector);
        issuer.setCaps(CARE_COST, CARE_COST);
    }

    /// The tightest config that actually leaves a pet able to survive. FIVE NEEDS: one care per
    /// need per one-day life window = 5 cares, +1 phase-drift headroom = a 6-care dailyCap floor.
    function test_Issue_SucceedsWithRealHeadroom() public {
        vm.prank(owner);
        issuer.setCaps(CARE_COST, CARE_COST * 6);
        (uint256 id,) = _issue(player);
        assertEq(id, 1, "caps with real headroom still issue");
    }

    function test_Register_OnlyIssuer() public {
        vm.expectRevert(PetVault.NotIssuer.selector);
        vm.prank(stranger);
        vault.register(1);
    }

    function test_Register_NoDoubleRegister() public {
        (uint256 id,) = _issue(player);
        vm.expectRevert(PetVault.AlreadyRegistered.selector);
        vm.prank(address(issuer));
        vault.register(id);
    }

    function test_PullCare_OnlyVault() public {
        (uint256 id,) = _issue(player);
        vm.expectRevert(PetIssuer.NotVault.selector);
        vm.prank(stranger);
        issuer.pullCare(id, CARE_COST);
    }

    /// The NFT-level supply cap blocks minting past maxSupply (no season flag exists any more).
    function test_MaxSupplyReached_BlocksFurtherMint() public {
        Pet721 smallPet = new Pet721("W", "P", 1, owner, royaltyRecipient, "");
        PetIssuer smallIssuer = new PetIssuer(
            smallPet,
            IERC6551Registry(address(registry)),
            address(accountImpl),
            IERC20(address(care)),
            relayer,
            owner,
            PER_TX_CAP,
            DAILY_CAP,
            0
        );
        PetVault.Params memory p = _params(IERC20(address(care)));
        p.pet = smallPet;
        p.issuer = IPetCareSpender(address(smallIssuer));
        PetVault smallVault = new PetVault(p);
        vm.startPrank(owner);
        smallPet.setIssuer(address(smallIssuer));
        smallIssuer.setVault(address(smallVault));
        vm.stopPrank();

        vm.prank(relayer);
        smallIssuer.issuePet(player); // fills maxSupply (1)

        vm.expectRevert(Pet721.MaxSupplyReached.selector);
        vm.prank(relayer);
        smallIssuer.issuePet(player);
    }

    function test_Pet_LockIssuer_FreezesRotation() public {
        vm.startPrank(owner);
        pet.lockIssuer();
        assertTrue(pet.issuerLocked());
        vm.expectRevert(Pet721.IssuerIsLocked.selector);
        pet.setIssuer(address(0xBEEF));
        vm.stopPrank();
    }

    function test_Pet_LockIssuer_OnlyOwner() public {
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, stranger));
        vm.prank(stranger);
        pet.lockIssuer();
    }
}

contract PetCareTest is PetBase {
    MockCareToken internal care;

    function setUp() public {
        care = new MockCareToken();
        _deploySeason(IERC20(address(care)));
        care.mint(address(issuer), FLOAT);
    }

    function test_Care_ByOwner_PullsBurnsPotsResets() public {
        (uint256 id, address tba) = _issue(player);
        uint256 potShare = (CARE_COST * POT_BPS) / 10_000;
        uint256 burnShare = CARE_COST - potShare;

        vm.warp(block.timestamp + CARE_COOLDOWN);
        vm.expectEmit(true, false, false, true, address(vault));
        emit PetVault.Care(id, 4, CARE_COST, burnShare, potShare, 0, 0, potShare);
        vm.prank(player);
        vault.care(id, 4);

        assertEq(care.balanceOf(tba), STARTER - CARE_COST, "tba debited");
        assertEq(vault.pot(), potShare, "pot 10%");
        assertEq(care.balanceOf(BURN), burnShare, "90% burned");
        assertEq(vault.totalBurned(), burnShare);
        (,, uint64 lastCareAt,,) = vault.petState(id);
        assertEq(lastCareAt, uint64(block.timestamp), "timer reset");
        assertEq(vault.hatchedCount(), 1, "first care hatches the pet into the race");
        assertEq(vault.leader(), id, "sole fed pet is the standing leader");
    }

    function test_Care_ByOwner_Works() public {
        (uint256 id, address tba) = _issue(player);
        vm.warp(block.timestamp + CARE_COOLDOWN);
        _careBy(player, id); // the pet's NFT owner
        assertEq(care.balanceOf(tba), STARTER - CARE_COST);
    }

    /// Owner-only guardrail (audit access-H-1): NO non-owner may care someone else's pet. Not a
    /// stranger, and not the issuer's mint relayer either (the vault has no care relayer at all).
    function test_Care_ForceCareBlockedForAnyNonOwner() public {
        (uint256 id,) = _issue(player);
        vm.warp(block.timestamp + CARE_COOLDOWN);
        vm.expectRevert(PetVault.NotAuthorizedCarer.selector);
        vm.prank(stranger);
        vault.care(id, 0);
        vm.expectRevert(PetVault.NotAuthorizedCarer.selector);
        vm.prank(relayer);
        vault.care(id, 0);
    }

    /// Cooldown bounds the drain rate (even the owner cannot machine-gun its own pet).
    function test_Care_CooldownEnforced() public {
        (uint256 id,) = _issue(player);
        vm.warp(block.timestamp + CARE_COOLDOWN);
        _care(id);

        vm.expectRevert(PetVault.CareOnCooldown.selector);
        _careBy(player, id); // immediate second care blocked

        vm.warp(block.timestamp + CARE_COOLDOWN - 1);
        vm.expectRevert(PetVault.CareOnCooldown.selector);
        _careBy(player, id); // one second early still blocked

        vm.warp(block.timestamp + 1);
        _care(id); // exactly at the cooldown boundary succeeds
        assertEq(vault.pot(), 2 * ((CARE_COST * POT_BPS) / 10_000));
    }

    function test_Care_RevertsWhenNotRegistered() public {
        // A nonexistent token: the owner lookup inside care() itself reverts (no owner to authorize).
        vm.expectRevert(abi.encodeWithSelector(IERC721Errors.ERC721NonexistentToken.selector, 999));
        vm.prank(stranger);
        vault.care(999, 0);

        // An existing pet that THIS vault never registered (a parallel vault sharing the same pet
        // and issuer): its owner passes the auth check but the pet is NotCareable there.
        (uint256 id,) = _issue(player);
        PetVault other = new PetVault(_params(IERC20(address(care))));
        vm.warp(block.timestamp + CARE_COOLDOWN);
        vm.expectRevert(PetVault.NotCareable.selector);
        vm.prank(player);
        other.care(id, 0);
    }

    /// Permanent death: once a HATCHED pet's life timer lapses it can NEVER be fed again (no
    /// revive). The clock starts on the FIRST care (audit death-F1), so hatch first, then lapse.
    function test_Care_RevertsOnDeadPet() public {
        (uint256 id,) = _issue(player);
        vm.warp(block.timestamp + CARE_COOLDOWN);
        _care(id); // hatch: the life clock starts here
        vm.warp(block.timestamp + LIFE_TTL + 1);
        assertFalse(vault.alive(id), "lapsed == dead");
        assertTrue(vault.isDead(id));
        vm.expectRevert(PetVault.PetIsDead.selector);
        _careBy(player, id);
    }

    /// The renamed petState view: a dormant egg has no running timer; after HATCH (first care)
    /// secondsLeft counts down to the deadline and zeroes at death.
    function test_PetState_SecondsLeftCountsDown() public {
        (uint256 id,) = _issue(player);
        (, bool deadEgg,, bool aliveEgg, uint256 sEgg) = vault.petState(id);
        assertFalse(aliveEgg, "dormant egg: not alive");
        assertFalse(deadEgg, "dormant egg: not dead");
        assertEq(sEgg, 0, "no timer before the first care");

        vm.warp(block.timestamp + CARE_COOLDOWN);
        _care(id); // hatch starts the clock
        (,,,, uint256 s0) = vault.petState(id);
        assertEq(s0, LIFE_TTL, "full window at hatch");
        vm.warp(block.timestamp + 100);
        (,,,, uint256 s1) = vault.petState(id);
        assertEq(s1, LIFE_TTL - 100, "counts down");
        vm.warp(block.timestamp + LIFE_TTL); // past the deadline
        (, bool dead,, bool isAlive, uint256 s2) = vault.petState(id);
        assertTrue(dead);
        assertFalse(isAlive);
        assertEq(s2, 0, "no seconds left once dead");
    }
}

contract PetSettlementTest is PetBase {
    MockCareToken internal care;
    address internal p2 = makeAddr("p2");
    address internal p3 = makeAddr("p3");

    function setUp() public {
        care = new MockCareToken();
        _deploySeason(IERC20(address(care)));
        care.mint(address(issuer), FLOAT);
    }

    /// Mint 3, care them at increasing times so c is the last-fed pet (the standing winner) and b's
    /// feed time is the runner-up slot.
    function _threeCaredAscending() internal returns (uint256 a, uint256 b, uint256 c, address tbaC) {
        (a,) = _issue(player);
        (b,) = _issue(p2);
        address t;
        (c, t) = _issue(p3);
        tbaC = t;
        vm.warp(block.timestamp + CARE_COOLDOWN);
        _care(a);
        vm.warp(block.timestamp + CARE_COOLDOWN);
        _care(b);
        vm.warp(block.timestamp + CARE_COOLDOWN);
        _care(c); // c fed last => the leader
    }

    /// The core settlement path: permissionless finalize pays the WHOLE pot to the leader's TBA the
    /// instant no other pet has been fed within a full life window, with an exact boundary check.
    function test_Finalize_PaysWholePotToLeaderTba() public {
        (, uint256 b, uint256 c, address tbaC) = _threeCaredAscending();
        uint256 prize = vault.pot();
        assertGt(prize, 0);
        assertEq(vault.leader(), c, "last-fed pet is the standing winner");
        (, uint64 lastB,) = vault.lifeState(b);
        assertEq(vault.runnerUpCareAt(), lastB, "runner-up slot = b's last feed");

        // Not over while the runner-up is still within its life window.
        assertFalse(vault.isOver());
        vm.expectRevert(PetVault.GameNotOver.selector);
        vault.finalize();

        // The leader keeps its own pet alive, which is the realistic winning line: a survival game is
        // won by still being served, not by being the least stale corpse. FIVE NEEDS: only serving
        // ALL FIVE lifts the leader's min-need past the decision time (a single action would leave
        // its other needs at the hatch stamp and it would die at the finish line). Caring the LEADER
        // moves neither runnerUpCareAt nor contestedAt, so the decision time below is unchanged.
        vm.warp(block.timestamp + CARE_COOLDOWN);
        careAll(vault, c);
        prize = vault.pot(); // those cares grew the pot; the winner takes the WHOLE of it

        // BOUNDARY: one second before the decision time, still not over. The decision time is a full
        // life window after the LATER of the runner-up's care and the moment the race became contested.
        uint256 decidesAt = _decidesAt();
        assertGe(decidesAt, uint256(lastB) + LIFE_TTL, "decision time is never earlier than the runner-up deadline");
        vm.warp(decidesAt - 1);
        assertFalse(vault.isOver());
        vm.expectRevert(PetVault.GameNotOver.selector);
        vault.finalize();

        // At the exact deadline every non-leader pet has lapsed: finalize (permissionless) pays.
        vm.warp(decidesAt);
        assertTrue(vault.isOver(), "game over at the decision time exactly");
        assertTrue(vault.alive(c), "leader is the sole survivor");
        uint256 tbaBefore = care.balanceOf(tbaC);
        vm.expectEmit(true, true, false, true, address(vault));
        emit PetVault.Victory(c, tbaC, prize);
        vm.prank(stranger); // anyone may poke; the money always goes to the winner's TBA
        vault.finalize();

        assertEq(care.balanceOf(tbaC) - tbaBefore, prize, "whole pot to the winner TBA");
        assertEq(vault.pot(), 0);
        assertTrue(vault.potClaimed());
        assertFalse(vault.isOver(), "isOver reads false once the pot is claimed");
    }

    /// With no pet ever fed there is no leader, so the game can never settle.
    function test_Finalize_RevertsWhenNothingEverFed() public {
        _issue(player);
        _issue(p2);
        _issue(p3); // registered but nobody fed: leader == 0
        vm.warp(block.timestamp + LIFE_TTL + 1); // even after every egg lapsed
        vm.expectRevert(PetVault.NotEnoughPlayers.selector);
        vault.finalize();
    }

    /// hatchedCount counts DISTINCT fed pets: repeat cares of one pet cannot fake a full field, so a
    /// lone player can never insta-win the pot.
    function test_Finalize_HatchedCountsDistinctPetsOnly() public {
        (uint256 a,) = _issue(player);
        _issue(p2);
        _issue(p3);
        for (uint256 i = 0; i < 3; i++) {
            vm.warp(block.timestamp + CARE_COOLDOWN);
            _care(a);
        }
        assertEq(vault.hatchedCount(), 1, "three cares of one pet hatch it once");

        vm.warp(block.timestamp + LIFE_TTL); // time-over, but the field never filled
        vm.expectRevert(PetVault.NotEnoughPlayers.selector);
        vault.finalize();
    }

    /// The settlementState view maps the new model: candidate=leader, winsAt=runnerUp+lifeTtl.
    function test_SettlementState_TracksLeaderRunnerUpAndWinsAt() public {
        (uint256 candidate0, uint64 lastCare0, uint256 winsAt0, bool finalized0) = vault.settlementState();
        assertEq(candidate0, 0, "no leader before the first care");
        assertEq(lastCare0, 0);
        assertEq(winsAt0, 0, "winsAt 0 while no leader");
        assertFalse(finalized0);

        (,, uint256 c,) = _threeCaredAscending();
        (uint256 candidate, uint64 candidateLastCareAt, uint256 winsAt, bool finalized) = vault.settlementState();
        assertEq(candidate, c, "candidate is the leader");
        (, uint64 lastC,) = vault.lifeState(c);
        assertEq(candidateLastCareAt, lastC, "candidateLastCareAt = leader's last feed");
        // Read the decision time from the contract rather than restating the predicate: the season is
        // decided a full life window after the LATER of the runner-up's care and the moment the race
        // became contested (see PetVault.contestedAt / SparseHatchFreeze.t.sol).
        uint256 expectedWinsAt = _decidesAt();
        assertEq(winsAt, expectedWinsAt, "winsAt = a full life window after the season was decided");
        assertFalse(finalized);

        vm.warp(winsAt);
        vault.finalize();
        (,,, bool finalizedAfter) = vault.settlementState();
        assertTrue(finalizedAfter, "finalized tracks potClaimed");
    }

    /// Game over is final at the vault level: no care, no re-finalize, no new registration.
    function test_Finalize_GameOverBlocksEverything() public {
        (uint256 a,, uint256 c,) = _resolveGame();
        vm.prank(player); // even a's own owner cannot care into a finished game
        vm.expectRevert(PetVault.GameOver.selector);
        vault.care(a, 0);
        vm.expectRevert(PetVault.GameOver.selector);
        vault.finalize();
        // register() NO-OPS rather than reverting, so issuePet (which calls it unconditionally)
        // keeps working and the collection is not destroyed by the season ending. The pet is
        // simply never registered, so it can never be fed or win.
        vm.prank(address(issuer));
        vault.register(c + 1);
        (bool registered,,,,) = vault.petState(c + 1);
        assertFalse(registered, "post-settlement register is a no-op, not a registration");
    }

    function _resolveGame() internal returns (uint256 a, uint256 b, uint256 c, address tbaC) {
        (a, b, c, tbaC) = _threeCaredAscending();
        vm.warp(_decidesAt());
        vault.finalize();
    }
}

contract PetTokenSafetyTest is PetBase {
    FeeOnTransferToken internal fot;
    uint256 internal constant FEE_BPS = 500; // 5%

    function setUp() public {
        fot = new FeeOnTransferToken(FEE_BPS);
        _deploySeason(IERC20(address(fot)));
        fot.mint(address(issuer), FLOAT);
    }

    /// M-5: the pot is accounted on the balance ACTUALLY received, not the nominal careCost.
    function test_Care_FeeOnTransferAccountsReceived() public {
        (uint256 id,) = _issue(player);
        vm.warp(block.timestamp + CARE_COOLDOWN);

        uint256 received = (CARE_COST * (10_000 - FEE_BPS)) / 10_000; // 0.95e18
        uint256 expectedPot = (received * POT_BPS) / 10_000;
        uint256 expectedBurn = received - expectedPot;

        _care(id);

        assertEq(vault.pot(), expectedPot, "pot on received, not nominal careCost");
        assertEq(vault.totalBurned(), expectedBurn);
        assertEq(fot.balanceOf(address(vault)), expectedPot, "vault holds exactly the pot");
    }
}

contract PetConfigTest is PetBase {
    MockCareToken internal care;

    function setUp() public {
        care = new MockCareToken();
        _deploySeason(IERC20(address(care)));
        care.mint(address(issuer), FLOAT);
    }

    /// lifeTtl is IMMUTABLE (audit H-2): fixed at construction, no setter, no lock to manage. The
    /// whole tuning surface (setLifeTtl / lockConfig / configLocked) no longer exists on the
    /// contract, so no owner can ever move the finish line, mass-kill pets, or resurrect the dead.
    function test_LifeTtl_ImmutableNoTuningSurface() public {
        assertEq(vault.lifeTtl(), LIFE_TTL, "constructor value is the forever value");
        vm.startPrank(owner); // not even the owner has a tuning selector to call
        (bool okSet,) = address(vault).call(abi.encodeWithSignature("setLifeTtl(uint256)", 2 days));
        assertFalse(okSet, "setLifeTtl does not exist");
        (bool okLock,) = address(vault).call(abi.encodeWithSignature("lockConfig()"));
        assertFalse(okLock, "lockConfig does not exist");
        (bool okView,) = address(vault).call(abi.encodeWithSignature("configLocked()"));
        assertFalse(okView, "configLocked does not exist");
        vm.stopPrank();
        assertEq(vault.lifeTtl(), LIFE_TTL, "still the constructor value");
    }

    /// audit access-H-1: the care relayer is GONE from the vault. There is no relayer state var, no
    /// setRelayer, and no privileged carer of any kind left on the ABI: care() is strictly owner-only.
    function test_NoRelayerSurface_RemovedFromABI() public {
        vm.startPrank(owner); // not even the owner has a relayer selector to call
        (bool okSet,) = address(vault).call(abi.encodeWithSignature("setRelayer(address)", makeAddr("newRelayer")));
        assertFalse(okSet, "setRelayer does not exist");
        (bool okView,) = address(vault).call(abi.encodeWithSignature("relayer()"));
        assertFalse(okView, "relayer() does not exist");
        vm.stopPrank();
    }
}

contract PetConstructorTest is PetBase {
    MockCareToken internal care;

    function setUp() public {
        care = new MockCareToken();
        registry = new ERC6551Registry();
        accountImpl = new WalletchiAccount();
        pet = new Pet721("W", "W", MAX_SUPPLY, owner, royaltyRecipient, "");
        issuer = new PetIssuer(
            pet,
            IERC6551Registry(address(registry)),
            address(accountImpl),
            IERC20(address(care)),
            relayer,
            owner,
            PER_TX_CAP,
            DAILY_CAP,
            STARTER
        );
    }

    function test_Constructor_RevertsBadBpsSum() public {
        PetVault.Params memory p = _params(IERC20(address(care)));
        p.potBps = 1000;
        p.burnBps = 8000; // sum 9000 != 10000
        vm.expectRevert(PetVault.BadBps.selector);
        new PetVault(p);
    }

    function test_Constructor_RevertsCareCostZero() public {
        PetVault.Params memory p = _params(IERC20(address(care)));
        p.careCost = 0;
        vm.expectRevert(PetVault.BadConfig.selector);
        new PetVault(p);
    }

    /// L-6: careCost * potBps must be >= BPS so every care yields a non-zero pot contribution.
    function test_Constructor_RevertsPotContributionTooSmall() public {
        PetVault.Params memory p = _params(IERC20(address(care)));
        p.careCost = 1; // 1 wei
        p.potBps = 1;
        p.burnBps = 9999; // 1 * 1 = 1 < 10000
        vm.expectRevert(PetVault.BadConfig.selector);
        new PetVault(p);
    }

    function test_Constructor_RevertsLifeTtlOutOfBounds() public {
        PetVault.Params memory p = _params(IERC20(address(care)));
        p.lifeTtl = 30 minutes;
        vm.expectRevert(PetVault.LifeTtlOutOfBounds.selector);
        new PetVault(p);
    }

    function test_Constructor_CooldownZeroAllowed_TooLargeReverts() public {
        // careCooldown == 0 is now ALLOWED (Hunt: no cooldown, feed as often as you like).
        PetVault.Params memory p = _params(IERC20(address(care)));
        p.careCooldown = 0;
        PetVault noCd = new PetVault(p);
        assertEq(noCd.careCooldown(), 0, "zero cooldown constructs fine");

        // But a cooldown that meets or exceeds the life window is still refused.
        PetVault.Params memory p2 = _params(IERC20(address(care)));
        p2.careCooldown = LIFE_TTL; // >= lifeTtl
        vm.expectRevert(PetVault.BadConfig.selector);
        new PetVault(p2);
    }

    function test_Constructor_RevertsMinPlayersTooLow() public {
        PetVault.Params memory p = _params(IERC20(address(care)));
        p.minPlayers = 1;
        vm.expectRevert(PetVault.BadConfig.selector);
        new PetVault(p);
    }

    function test_Constructor_RevertsZeroAddress() public {
        PetVault.Params memory p = _params(IERC20(address(0)));
        vm.expectRevert(PetVault.ZeroAddress.selector);
        new PetVault(p);
    }

    function test_Constructor_RevertsCodelessPet() public {
        PetVault.Params memory p = _params(IERC20(address(care)));
        address codelessPet = makeAddr("codelessPet");
        p.pet = Pet721(codelessPet);
        vm.expectRevert(abi.encodeWithSelector(PetVault.DependencyNotContract.selector, codelessPet));
        new PetVault(p);
    }

    function test_Constructor_RevertsCodelessIssuer() public {
        PetVault.Params memory p = _params(IERC20(address(care)));
        address codelessIssuer = makeAddr("codelessIssuer");
        p.issuer = IPetCareSpender(codelessIssuer);
        vm.expectRevert(abi.encodeWithSelector(PetVault.DependencyNotContract.selector, codelessIssuer));
        new PetVault(p);
    }
}

contract PetSweepTest is PetBase {
    MockCareToken internal care;

    function setUp() public {
        care = new MockCareToken();
        _deploySeason(IERC20(address(care)));
        care.mint(address(issuer), FLOAT);
    }

    function test_Sweep_Timelocked() public {
        care.mint(address(vault), 500e18); // donated tokens

        vm.startPrank(owner);
        vault.queueSweep(address(care), owner, 500e18);
        vm.expectRevert(PetVault.SweepTimelocked.selector);
        vault.executeSweep(); // too early

        vm.warp(block.timestamp + vault.SWEEP_TIMELOCK());
        vault.executeSweep();
        vm.stopPrank();

        assertEq(care.balanceOf(owner), 500e18, "swept after the timelock");
    }

    function test_Sweep_OnlyOwner() public {
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, stranger));
        vm.prank(stranger);
        vault.queueSweep(address(care), stranger, 1);
    }

    function test_Sweep_Cancel() public {
        vm.startPrank(owner);
        vault.queueSweep(address(care), owner, 1);
        vault.cancelSweep();
        vm.warp(block.timestamp + vault.SWEEP_TIMELOCK());
        vm.expectRevert(PetVault.NoSweepQueued.selector);
        vault.executeSweep();
        vm.stopPrank();
    }

    /// econ-F1 (audit): the stranded-pot burn path is GONE. A pot stranded because too few players
    /// ever fed a pet (hatchedCount < minPlayers AND the last fed pet is dead) simply STAYS LOCKED
    /// in the vault: the careToken sweep is surplus-only ALWAYS while the pot is unclaimed, and the
    /// sweep path burns nothing.
    function test_Sweep_StrandedPotStaysLockedRecipientGetsOnlySurplus() public {
        (uint256 a,) = _issue(player); // only 1 hatched player, minPlayers is 3
        vm.warp(block.timestamp + CARE_COOLDOWN);
        _care(a);
        vm.expectRevert(PetVault.NotEnoughPlayers.selector);
        vault.finalize(); // under-subscribed: the pot can never be won

        uint256 strandedPot = vault.pot();
        assertGt(strandedPot, 0);
        care.mint(address(vault), 5e18); // donated surplus on top of the stranded pot
        uint256 burnBefore = care.balanceOf(BURN);
        uint256 totalBurnedBefore = vault.totalBurned();

        // Queueing MORE than the surplus reverts: the stranded pot itself is never sweepable, even
        // once the pot is provably unwinnable (the 3-day timelock outlives the 1-day lifeTtl, so
        // the lone fed pet is dead at execution and nobody can ever claim).
        vm.startPrank(owner);
        vault.queueSweep(address(care), owner, 5e18 + 1);
        vm.warp(block.timestamp + vault.SWEEP_TIMELOCK());
        assertTrue(vault.isDead(a), "the last fed pet has died: the pot is genuinely stranded");
        vm.expectRevert(PetVault.SweepExceedsSurplus.selector);
        vault.executeSweep();
        assertEq(vault.pot(), strandedPot, "failed sweep leaves the pot intact");

        // Sweeping exactly the surplus succeeds; the stranded pot STAYS in the vault, unburned.
        vault.queueSweep(address(care), owner, 5e18);
        vm.warp(block.timestamp + vault.SWEEP_TIMELOCK());
        vault.executeSweep();
        vm.stopPrank();

        assertEq(care.balanceOf(owner), 5e18, "recipient got only the genuine surplus");
        assertEq(care.balanceOf(BURN), burnBefore, "sweep burned NOTHING (no stranded-pot burn)");
        assertEq(vault.totalBurned(), totalBurnedBefore, "totalBurned untouched by the sweep");
        assertEq(vault.pot(), strandedPot, "the stranded pot stays locked in the vault");
        assertEq(care.balanceOf(address(vault)), strandedPot, "vault still holds exactly the pot");
    }

    // Build a live pot with a full field (hatchedCount >= minPlayers): the pot is winnable, so it
    // stays sweep-protected forever until someone actually wins it.
    function _liveOpenPot() internal returns (uint256 pot) {
        (uint256 a,) = _issue(player);
        (uint256 b,) = _issue(makeAddr("s2"));
        (uint256 c,) = _issue(makeAddr("s3"));
        vm.warp(block.timestamp + CARE_COOLDOWN);
        _care(a);
        _care(b);
        _care(c); // 3 hatched >= minPlayers: the pot is winnable
        pot = vault.pot();
        assertGt(pot, 0);
    }

    /// N-1 (HIGH): the owner cannot sweep the live (winnable, unclaimed) pot.
    function test_Sweep_CannotDrainLivePot() public {
        uint256 pot = _liveOpenPot(); // unclaimed, surplus == 0
        vm.startPrank(owner);
        vault.queueSweep(address(care), owner, 1); // even 1 wei is over the (zero) surplus
        vm.warp(block.timestamp + vault.SWEEP_TIMELOCK());
        vm.expectRevert(PetVault.SweepExceedsSurplus.selector);
        vault.executeSweep();
        vm.stopPrank();
        assertEq(vault.pot(), pot, "live pot untouched");
    }

    /// N-1: the owner CAN sweep genuine surplus / donated dust, but never dip into the pot.
    function test_Sweep_SurplusOnly() public {
        uint256 pot = _liveOpenPot();
        care.mint(address(vault), 5e18); // donated dust on top of the pot

        vm.startPrank(owner);
        vault.queueSweep(address(care), owner, 5e18); // exactly the surplus
        vm.warp(block.timestamp + vault.SWEEP_TIMELOCK());
        vault.executeSweep();
        assertEq(care.balanceOf(owner), 5e18, "swept the surplus");
        assertEq(vault.pot(), pot, "pot preserved");

        // Nothing left above the pot: any further careToken sweep reverts.
        vault.queueSweep(address(care), owner, 1);
        vm.warp(block.timestamp + vault.SWEEP_TIMELOCK());
        vm.expectRevert(PetVault.SweepExceedsSurplus.selector);
        vault.executeSweep();
        vm.stopPrank();
    }

    /// N-1: after a clean finish (potClaimed) the residual is fully sweepable (e.g. late donations).
    function test_Sweep_ResidualAfterPotClaimed() public {
        (uint256 a,) = _issue(player);
        (uint256 b,) = _issue(makeAddr("s2"));
        (uint256 c,) = _issue(makeAddr("s3"));
        vm.warp(block.timestamp + CARE_COOLDOWN);
        _care(a);
        _care(b);
        vm.warp(block.timestamp + CARE_COOLDOWN);
        _care(c); // c fed last: the standing winner
        vm.warp(_decidesAt()); // a and b lapse; only c's feed stands
        vault.finalize();
        assertTrue(vault.potClaimed());

        care.mint(address(vault), 7e18); // late donation after the game ended
        vm.startPrank(owner);
        vault.queueSweep(address(care), owner, 7e18);
        vm.warp(block.timestamp + vault.SWEEP_TIMELOCK());
        vault.executeSweep();
        vm.stopPrank();
        assertEq(care.balanceOf(owner), 7e18, "post-finish residual sweepable");
    }

    /// N-1: a NON-care token is unrestricted (no pot to protect), even mid-game.
    function test_Sweep_NonCareTokenUnrestricted() public {
        _liveOpenPot(); // live careToken pot exists
        MockCareToken other = new MockCareToken();
        other.mint(address(vault), 9e18);

        vm.startPrank(owner);
        vault.queueSweep(address(other), owner, 9e18);
        vm.warp(block.timestamp + vault.SWEEP_TIMELOCK());
        vault.executeSweep();
        vm.stopPrank();
        assertEq(other.balanceOf(owner), 9e18, "unrelated token swept freely");
    }
}

contract PetMemorialTest is PetBase {
    MockCareToken internal care;

    function setUp() public {
        care = new MockCareToken();
        _deploySeason(IERC20(address(care)));
        care.mint(address(issuer), FLOAT);
    }

    function test_Memorial_BornAtCareCountAndDeath() public {
        uint256 bornTs = block.timestamp;
        (uint256 id,) = _issue(player);
        _issue(makeAddr("p2"));

        vm.warp(block.timestamp + CARE_COOLDOWN);
        _care(id); // hatch: all five needs start here
        vm.warp(block.timestamp + CARE_COOLDOWN);
        careAll(vault, id); // a full five-need round lifts the min (the deadline anchor) to now
        uint256 lastFullRound = block.timestamp;

        (bool dead0,, uint64 diedAt0, uint32 cc0, uint32 rank0) = vault.memorialState(id);
        assertFalse(dead0);
        assertEq(cc0, 6, "hatch + a full five-need round = 6 cares");
        assertEq(diedAt0, 0, "alive");
        assertEq(rank0, 0);

        // Death is the instant the weakest need lapses; diedAt is that instant, not the read time.
        vm.warp(lastFullRound + LIFE_TTL + 123);
        (bool dead, uint64 bornAt, uint64 diedAt, uint32 cc, uint32 rank) = vault.memorialState(id);
        assertTrue(dead);
        assertEq(bornAt, uint64(bornTs));
        assertEq(diedAt, uint64(lastFullRound + LIFE_TTL), "diedAt = min-need + lifeTtl exactly");
        assertEq(cc, 6, "careCount preserved through death");
        assertEq(rank, 0, "rank is derived off-chain in the last-pet-standing model");
    }
}

contract PetReentrancyTest is PetBase {
    MaliciousCareToken internal mal;
    address internal p2 = makeAddr("p2");
    address internal p3 = makeAddr("p3");

    function setUp() public {
        mal = new MaliciousCareToken();
        _deploySeason(IERC20(address(mal)));
        mal.mint(address(issuer), FLOAT);
    }

    function test_Finalize_ReentrancyGuarded() public {
        (uint256 a,) = _issue(player);
        (uint256 b,) = _issue(p2);
        (uint256 c, address tbaC) = _issue(p3);
        vm.warp(block.timestamp + CARE_COOLDOWN);
        _care(a);
        _care(b);
        vm.warp(block.timestamp + CARE_COOLDOWN);
        _care(c); // c fed last: the standing winner
        vm.warp(_decidesAt()); // every rival lapsed: game over

        uint256 prize = vault.pot();
        assertGt(prize, 0);
        uint256 tbaBefore = mal.balanceOf(tbaC);
        mal.arm(vault); // reenter finalize on the prize transfer

        vault.finalize();

        assertTrue(mal.reentered(), "token attempted reentrancy");
        assertEq(
            bytes4(mal.lastRevert()),
            ReentrancyGuard.ReentrancyGuardReentrantCall.selector,
            "reentrant finalize blocked"
        );
        assertTrue(vault.potClaimed());
        assertEq(mal.balanceOf(tbaC) - tbaBefore, prize, "winner TBA paid exactly once");
    }
}

contract PetFuzzTest is PetBase {
    MockCareToken internal care;

    function setUp() public {
        care = new MockCareToken();
        _deploySeason(IERC20(address(care)));
        care.mint(address(issuer), FLOAT);
    }

    /// Fuzz the fee split across bps configs: pot gets floor(received*potBps/BPS), burn the rest.
    function testFuzz_CareFeeSplit(uint256 potBpsFuzz, uint256 careCostFuzz) public {
        uint256 pb = bound(potBpsFuzz, 1, 10_000);
        uint256 bb = 10_000 - pb;
        uint256 cc = bound(careCostFuzz, 1e18, PER_TX_CAP); // >= 1e18 so cc*pb >= BPS always

        PetVault.Params memory p = _params(IERC20(address(care)));
        p.careCost = cc;
        p.potBps = pb;
        p.burnBps = bb;
        PetVault v = new PetVault(p);
        vm.startPrank(owner);
        issuer.setVault(address(v));
        issuer.setCaps(cc, cc * 100); // ensure the pull fits the caps
        vm.stopPrank();

        (uint256 id, address tba) = _issue(player);
        vm.warp(block.timestamp + CARE_COOLDOWN);
        uint256 burnBefore = care.balanceOf(BURN);

        vm.prank(player); // owner-only care
        v.care(id, 0);

        uint256 expectedPot = (cc * pb) / 10_000;
        assertEq(v.pot(), expectedPot, "pot share");
        assertEq(care.balanceOf(BURN) - burnBefore, cc - expectedPot, "burn remainder");
        assertEq(care.balanceOf(tba), STARTER - cc, "tba debited exactly careCost");
    }
}

contract PetIssuerVaultLockTest is PetBase {
    MockCareToken internal care;
    address internal p2 = makeAddr("p2");
    address internal p3 = makeAddr("p3");

    function setUp() public {
        care = new MockCareToken();
        _deploySeason(IERC20(address(care))); // base wires setVault but does NOT lock (prod locks)
        care.mint(address(issuer), FLOAT);
    }

    function test_LockVault_FreezesRotation() public {
        assertFalse(issuer.vaultLocked());
        // setVault still works before the lock.
        vm.prank(owner);
        issuer.setVault(address(vault));

        vm.prank(owner);
        issuer.lockVault();
        assertTrue(issuer.vaultLocked());

        vm.expectRevert(PetIssuer.VaultIsLocked.selector);
        vm.prank(owner);
        issuer.setVault(makeAddr("evilVault"));
    }

    function test_LockVault_OnlyOwner() public {
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, stranger));
        vm.prank(stranger);
        issuer.lockVault();
    }

    function test_LockVault_RevertsIfVaultUnset() public {
        PetIssuer bare = new PetIssuer(
            pet,
            IERC6551Registry(address(registry)),
            address(accountImpl),
            IERC20(address(care)),
            relayer,
            owner,
            PER_TX_CAP,
            DAILY_CAP,
            STARTER
        );
        vm.expectRevert(PetIssuer.VaultUnset.selector);
        vm.prank(owner);
        bare.lockVault();
    }

    /// M-A: once the vault is locked, the owner cannot repoint the standing spender to an evil vault,
    /// so the drain path (setVault(Evil) -> Evil.pullCare) reverts at its first step.
    function test_MA_DrainPathRevertsOnceLocked() public {
        vm.prank(owner);
        issuer.lockVault();

        vm.expectRevert(PetIssuer.VaultIsLocked.selector);
        vm.prank(owner);
        issuer.setVault(makeAddr("evilVault"));
    }

    /// M-A: the honest winner keeps the whole prize even against a hostile owner, once locked.
    function test_MA_HonestWinnerKeepsPrizeAgainstHostileOwner() public {
        vm.prank(owner);
        issuer.lockVault(); // production posture

        (uint256 a,) = _issue(player);
        (uint256 b,) = _issue(p2);
        (uint256 c, address tbaC) = _issue(p3);
        vm.warp(block.timestamp + CARE_COOLDOWN);
        _care(a);
        vm.warp(block.timestamp + CARE_COOLDOWN);
        _care(b);
        vm.warp(block.timestamp + CARE_COOLDOWN);
        _care(c); // c fed last: the standing winner
        uint256 prize = vault.pot();

        // A full life window past the runner-up's feed, only c's feed stands: c wins the whole pot.
        vm.warp(_decidesAt());
        vault.finalize();

        uint256 winnerBal = care.balanceOf(tbaC);
        assertEq(winnerBal, STARTER - CARE_COST + prize, "winner TBA holds its float plus the prize");

        // Hostile owner tries the M-A claw-back: repoint the spender to drain the winner's TBA. Blocked.
        vm.expectRevert(PetIssuer.VaultIsLocked.selector);
        vm.prank(owner);
        issuer.setVault(makeAddr("evilVault"));

        assertEq(care.balanceOf(tbaC), winnerBal, "winner prize untouchable by the owner");
    }
}
