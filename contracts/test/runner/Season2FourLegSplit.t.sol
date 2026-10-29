// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

// SEASON 2: THE FOUR-LEG CARE SPLIT AND THE NEW CONSTRUCTOR PARAMETERS.
// UNAUDITED: re-audit before mainnet.
//
// Season 1 shipped a three-leg split (pot / rewards / burn) and baked `abandonGrace` as a constant
// 90 days, which left a five-pet tester season's half a mock CARE solemnly timelocked for three
// months. Season 2 adds a FOURTH leg (the 1% push-gas skim, taken out of the burn) and makes the
// grace a constructor parameter. Every existing suite in this repo runs the legacy economics
// (gasBps 0, gasRecipient address(0), abandonGrace 90 days) on purpose, so before this file the gas
// leg had NO coverage at all: not its arithmetic, not its transfer, not its constructor validation.
//
// The shipped mainnet shape is 6900 burn / 2000 rewards / 1000 pot / 100 gas.

import {Test} from "forge-std/Test.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

import {ERC6551Registry} from "erc6551/ERC6551Registry.sol";
import {IERC6551Registry} from "erc6551/interfaces/IERC6551Registry.sol";

import {WalletchiAccount} from "../../src/WalletchiAccount.sol";
import {Pet721} from "../../src/runner/Pet721.sol";
import {PetIssuer} from "../../src/runner/PetIssuer.sol";
import {PetVault, IPetCareSpender} from "../../src/runner/PetVault.sol";
import {MockCareToken} from "../../src/runner/MockCareToken.sol";
import {IRewardsSink} from "../../src/runner/IRewardsSink.sol";

/// @dev A rewards sink that only records. The vault's REQUIRED hook must be satisfied, but these
///      tests are about the VAULT's arithmetic, so the sink deliberately does no accounting of its
///      own: anything it did would be a second thing that could explain a passing assertion.
contract RecordingSink is IRewardsSink {
    uint256 public calls;
    uint256 public lastTokenId;
    address public lastAccount;
    uint256 public lastAmount;

    function notifyCare(uint256 tokenId, address account, uint256 amount) external {
        calls += 1;
        lastTokenId = tokenId;
        lastAccount = account;
        lastAmount = amount;
    }
}

abstract contract FourLegBase is Test {
    ERC6551Registry internal registry;
    WalletchiAccount internal accountImpl;
    Pet721 internal pet;
    PetIssuer internal issuer;
    PetVault internal vault;
    MockCareToken internal care;
    RecordingSink internal sink;

    address internal owner = makeAddr("owner");
    address internal relayer = makeAddr("relayer");
    address internal player = makeAddr("player");
    address internal ops = makeAddr("opsGasWallet");

    uint256 internal constant BPS = 10_000;
    uint256 internal constant MAX_SUPPLY = 2000;
    uint256 internal constant LIFE_TTL = 1 days;
    uint256 internal constant MIN_SEASON = 14 days;

    struct Split {
        uint256 careCost;
        uint256 potBps;
        uint256 burnBps;
        uint256 rewardsBps;
        uint256 gasBps;
        uint256 abandonGrace;
    }

    /// @dev The season-2 mainnet shape (Hunt 2026-08-30): the 1% gas skim comes OUT OF THE BURN.
    function _mainnetSplit(uint256 careCost) internal pure returns (Split memory s) {
        s = Split({
            careCost: careCost,
            potBps: 1000,
            burnBps: 6900,
            rewardsBps: 2000,
            gasBps: 100,
            abandonGrace: 7 days
        });
    }

    function _params(Split memory s, address rewardsTo, address gasTo)
        internal
        view
        returns (PetVault.Params memory)
    {
        return PetVault.Params({
            careToken: IERC20(address(care)),
            pet: pet,
            issuer: IPetCareSpender(address(issuer)),
            owner: owner,
            lifeTtl: LIFE_TTL,
            careCost: s.careCost,
            potBps: s.potBps,
            burnBps: s.burnBps,
            rewardsBps: s.rewardsBps,
            rewardsRecipient: rewardsTo,
            gasBps: s.gasBps,
            gasRecipient: gasTo,
            abandonGrace: s.abandonGrace,
            minPlayers: 2,
            careCooldown: 0,
            minSeasonDuration: MIN_SEASON,
            entryWindowSecs: MIN_SEASON,
            selloutStartsSeason: false
        });
    }

    /// @dev Wire a whole collection at an arbitrary split. Caps and the starter float scale with
    ///      careCost so no test is ever measuring a spend cap by accident.
    function _wire(Split memory s) internal {
        care = new MockCareToken();
        sink = new RecordingSink();
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
            s.careCost, // perTxCap
            s.careCost * 20, // dailyCap: comfortably above the five-needs survival rate
            s.careCost * 100 // starter float per pet
        );
        address rewardsTo = s.rewardsBps > 0 ? address(sink) : address(0);
        address gasTo = s.gasBps > 0 ? ops : address(0);
        vault = new PetVault(_params(s, rewardsTo, gasTo));
        vm.startPrank(owner);
        pet.setIssuer(address(issuer));
        issuer.setVault(address(vault));
        pet.setVaultRef(address(vault));
        vm.stopPrank();
        care.mint(address(issuer), s.careCost * 100 * 50);
    }

    function _mint(address to) internal returns (uint256 id, address tba) {
        vm.prank(relayer);
        (id, tba) = issuer.issuePet(to);
    }
}

// ================================================================================================
// The split itself: four legs, exact, with the dust falling to the burn.
// ================================================================================================
contract FourLegSplitExactnessTest is FourLegBase {
    /// The literal mainnet arithmetic from the spec, pinned as numbers rather than as a formula that
    /// could agree with a wrong implementation: at careCost 5,000 a care is 3,450 burned + 1,000
    /// rewards + 500 pot + 50 gas.
    function test_MainnetShapeSplitsExactlyAsSpecified() public {
        _wire(_mainnetSplit(5_000));
        (uint256 id, address tba) = _mint(player);
        uint256 tbaBefore = care.balanceOf(tba);

        vm.prank(player);
        vault.care(id, 0);

        assertEq(care.balanceOf(tba), tbaBefore - 5_000, "the TBA paid exactly careCost");
        assertEq(vault.totalBurned(), 3_450, "burn leg");
        assertEq(vault.totalRewards(), 1_000, "rewards leg");
        assertEq(vault.pot(), 500, "pot leg");
        assertEq(vault.totalGas(), 50, "gas leg");
        assertEq(
            vault.totalBurned() + vault.totalRewards() + vault.pot() + vault.totalGas(),
            uint256(5_000),
            "the four legs partition the whole fee"
        );

        // And the money is really where the counters say it is.
        assertEq(care.balanceOf(vault.BURN_ADDRESS()), 3_450, "burned tokens reached the burn sink");
        assertEq(care.balanceOf(address(sink)), 1_000, "the rewards slice reached the sink");
        assertEq(care.balanceOf(ops), 50, "the gas skim reached the ops wallet");
        assertEq(care.balanceOf(address(vault)), 500, "the vault holds only the pot");
    }

    /// The gas leg is funded OUT OF THE BURN, not out of the pot or the players' rewards. Same
    /// careCost, same pot, same rewards, and the burn is exactly 1% lighter.
    function test_TheGasSkimComesOutOfTheBurnAndNothingElse() public {
        Split memory three = _mainnetSplit(5_000);
        three.burnBps = 7000;
        three.gasBps = 0;
        _wire(three);
        (uint256 idA,) = _mint(player);
        vm.prank(player);
        vault.care(idA, 0);
        uint256 potThreeLeg = vault.pot();
        uint256 rewardsThreeLeg = vault.totalRewards();
        uint256 burnThreeLeg = vault.totalBurned();
        assertEq(vault.totalGas(), 0, "no gas leg when gasBps is 0");

        _wire(_mainnetSplit(5_000));
        (uint256 idB,) = _mint(player);
        vm.prank(player);
        vault.care(idB, 0);

        assertEq(vault.pot(), potThreeLeg, "the pot is untouched by the gas leg");
        assertEq(vault.totalRewards(), rewardsThreeLeg, "player rewards are untouched by the gas leg");
        assertEq(burnThreeLeg - vault.totalBurned(), vault.totalGas(), "the skim came entirely from the burn");
    }

    /// forge-config: default.fuzz.runs = 200
    /// Whatever the split and whatever the fee, the four legs sum to EXACTLY what was received: pot,
    /// rewards and gas take floor(cost * bps / BPS) and the burn takes the remainder, so rounding
    /// dust is destroyed rather than accruing anywhere someone could withdraw it.
    function testFuzz_FourLegsAlwaysPartitionTheFeeWithDustToTheBurn(
        uint256 costSeed,
        uint256 potSeed,
        uint256 rewardsSeed,
        uint256 gasSeed
    ) public {
        Split memory s;
        s.careCost = bound(costSeed, 1e6, 1e24);
        s.potBps = bound(potSeed, 100, 3000);
        s.rewardsBps = bound(rewardsSeed, 0, 3000);
        s.gasBps = bound(gasSeed, 0, 1000);
        s.burnBps = BPS - s.potBps - s.rewardsBps - s.gasBps;
        s.abandonGrace = 7 days;
        _wire(s);

        (uint256 id, address tba) = _mint(player);
        uint256 tbaBefore = care.balanceOf(tba);
        vm.prank(player);
        vault.care(id, 0);

        uint256 received = tbaBefore - care.balanceOf(tba);
        assertEq(received, s.careCost, "an honest token delivers the whole fee");

        uint256 potShare = (received * s.potBps) / BPS;
        uint256 rewardsShare = (received * s.rewardsBps) / BPS;
        uint256 gasShare = (received * s.gasBps) / BPS;
        assertEq(vault.pot(), potShare, "pot leg is floor(received * potBps / BPS)");
        assertEq(vault.totalRewards(), rewardsShare, "rewards leg is floor(received * rewardsBps / BPS)");
        assertEq(vault.totalGas(), gasShare, "gas leg is floor(received * gasBps / BPS)");
        // THE PARTITION. Asserted as a sum rather than as a fourth formula, so a burn leg that
        // silently dropped the dust could never satisfy it.
        assertEq(
            vault.pot() + vault.totalRewards() + vault.totalGas() + vault.totalBurned(),
            received,
            "the four legs must partition the fee exactly, dust included"
        );
        assertEq(vault.totalBurned(), received - potShare - rewardsShare - gasShare, "the burn takes the dust");

        // Every leg that was configured actually MOVED money to its own destination.
        assertEq(care.balanceOf(vault.BURN_ADDRESS()), vault.totalBurned(), "burn destination");
        if (s.rewardsBps > 0) assertEq(care.balanceOf(address(sink)), rewardsShare, "rewards destination");
        if (s.gasBps > 0) assertEq(care.balanceOf(ops), gasShare, "gas destination");
        else assertEq(care.balanceOf(ops), 0, "a disabled gas leg pays nobody");
    }

    /// The rounding dust falls to the BURN and to nothing else. Chosen so all three floor-divisions
    /// lose something: 10,001 raw units against 1000 / 2000 / 100 bps.
    function test_RoundingDustFallsEntirelyToTheBurn() public {
        _wire(_mainnetSplit(10_001));
        (uint256 id,) = _mint(player);
        vm.prank(player);
        vault.care(id, 0);

        assertEq(vault.pot(), 1_000, "pot floors down");
        assertEq(vault.totalRewards(), 2_000, "rewards floor down");
        assertEq(vault.totalGas(), 100, "gas floors down");
        // 10001 - 1000 - 2000 - 100 = 6901: the exact 6900-bps share (6900) plus the whole 1 unit of
        // dust the three floors gave up.
        assertEq(vault.totalBurned(), 6_901, "the burn absorbs its share plus all the rounding dust");
    }

    /// The Care event carries the gas contribution as its own field, so an indexer can reconcile all
    /// four legs from the log alone rather than diffing balances.
    function test_CareEventReportsTheGasContribution() public {
        _wire(_mainnetSplit(5_000));
        (uint256 id,) = _mint(player);

        vm.expectEmit(true, false, false, true, address(vault));
        emit PetVault.Care(id, 2, 5_000, 3_450, 500, 1_000, 50, 500);
        vm.prank(player);
        vault.care(id, 2);
    }

    /// Repeated cares accumulate every leg independently, and the ops wallet's balance is always
    /// exactly the lifetime counter (nothing else can pay it, and nothing takes it back).
    function test_GasLegAccumulatesAcrossManyCares() public {
        _wire(_mainnetSplit(5_000));
        (uint256 id,) = _mint(player);
        for (uint8 a = 0; a < 5; a++) {
            vm.prank(player);
            vault.care(id, a);
        }
        assertEq(vault.totalGas(), 5 * 50, "five cares, five skims");
        assertEq(care.balanceOf(ops), vault.totalGas(), "the ops wallet holds exactly the lifetime skim");
        assertEq(vault.totalBurned(), 5 * 3_450);
        assertEq(vault.pot(), 5 * 500);
    }

    /// The legacy posture stays byte-for-byte what season 1 did: with the leg disabled there is no
    /// gas recipient, no skim, and the event field reads 0.
    function test_ADisabledGasLegIsTrulyInert() public {
        Split memory s = _mainnetSplit(5_000);
        s.burnBps = 7000;
        s.gasBps = 0;
        _wire(s);
        assertEq(vault.gasBps(), 0);
        assertEq(vault.gasRecipient(), address(0), "no wallet is carried when the leg is off");

        (uint256 id,) = _mint(player);
        vm.expectEmit(true, false, false, true, address(vault));
        emit PetVault.Care(id, 0, 5_000, 3_500, 500, 1_000, 0, 500);
        vm.prank(player);
        vault.care(id, 0);
        assertEq(vault.totalGas(), 0);
    }
}

// ================================================================================================
// The new constructor parameters: gasBps / gasRecipient, and abandonGrace.
// ================================================================================================
contract FourLegConstructorParamsTest is FourLegBase {
    function setUp() public {
        _wire(_mainnetSplit(5_000)); // a valid deployment to borrow the wiring from
    }

    function _deploy(Split memory s, address rewardsTo, address gasTo) internal {
        new PetVault(_params(s, rewardsTo, gasTo));
    }

    function test_ALiveGasLegNeedsARealWallet() public {
        Split memory s = _mainnetSplit(5_000);
        vm.expectRevert(PetVault.ZeroAddress.selector);
        _deploy(s, address(sink), address(0));
    }

    /// The other direction, and it is the one a config typo actually produces: a wallet with no leg
    /// behind it. Refused loudly rather than deployed as a dead pointer nobody notices.
    function test_ADisabledGasLegMustNotCarryAWallet() public {
        Split memory s = _mainnetSplit(5_000);
        s.burnBps = 7000;
        s.gasBps = 0;
        vm.expectRevert(PetVault.BadConfig.selector);
        _deploy(s, address(sink), ops);
    }

    /// The four legs must partition the fee. A split that still adds to BPS across the OLD three
    /// legs while carrying a gas leg is exactly the mistake this catches.
    function test_TheFourLegsMustSumToBps() public {
        Split memory s = _mainnetSplit(5_000);
        s.burnBps = 7000; // 1000 + 7000 + 2000 + 100 = 10100
        vm.expectRevert(PetVault.BadBps.selector);
        _deploy(s, address(sink), ops);
    }

    /// The dust guard the other three legs already had: an enabled leg that would round to zero on
    /// every single care is a misconfiguration, not a rounding detail.
    function test_AGasLegThatWouldAlwaysRoundToZeroIsRefused() public {
        Split memory s = _mainnetSplit(99); // 99 * 100 = 9_900 < BPS
        vm.expectRevert(PetVault.BadConfig.selector);
        _deploy(s, address(sink), ops);

        // One unit more of careCost and the leg yields a whole unit, so it is accepted.
        s.careCost = 100; // 100 * 100 = 10_000 == BPS
        _deploy(s, address(sink), ops);
    }

    function test_AbandonGraceIsBoundedAtBothEnds() public {
        Split memory s = _mainnetSplit(5_000);

        s.abandonGrace = 0;
        vm.expectRevert(PetVault.BadConfig.selector);
        _deploy(s, address(sink), ops);

        s.abandonGrace = 1 hours - 1;
        vm.expectRevert(PetVault.BadConfig.selector);
        _deploy(s, address(sink), ops);

        s.abandonGrace = 365 days + 1;
        vm.expectRevert(PetVault.BadConfig.selector);
        _deploy(s, address(sink), ops);
    }

    /// Both bounds are INCLUSIVE, asserted positively so a future off-by-one in either direction is
    /// a failure rather than a silently narrowed window.
    function test_AbandonGraceAcceptsExactlyItsBounds() public {
        Split memory s = _mainnetSplit(5_000);

        s.abandonGrace = vault.MIN_ABANDON_GRACE();
        PetVault low = new PetVault(_params(s, address(sink), ops));
        assertEq(low.abandonGrace(), 1 hours, "the floor is accepted and stored");

        s.abandonGrace = vault.MAX_ABANDON_GRACE();
        PetVault high = new PetVault(_params(s, address(sink), ops));
        assertEq(high.abandonGrace(), 365 days, "the ceiling is accepted and stored");
    }

    function test_TheStoredGasParametersAreExactlyWhatWasPassed() public view {
        assertEq(vault.gasBps(), 100);
        assertEq(vault.gasRecipient(), ops);
        assertEq(vault.abandonGrace(), 7 days);
        assertEq(vault.potBps() + vault.burnBps() + vault.rewardsBps() + vault.gasBps(), BPS);
    }

    /// WHY abandonGrace STOPPED BEING A CONSTANT. Season 1 baked 90 days, so a five-pet tester
    /// season that never reached minPlayers had its pot frozen for three months with no way out.
    /// A short grace is the whole point of the parameter, so it is proven to actually govern the
    /// recovery path rather than merely being stored.
    function test_AShortAbandonGraceReallyShortensTheFreeze() public {
        Split memory s = _mainnetSplit(5_000);
        s.abandonGrace = 2 hours;
        _wire(s); // fresh collection so the roster genuinely closes under-subscribed

        (uint256 id,) = _mint(player);
        vm.prank(player);
        vault.care(id, 0); // one lonely player: hatchedCount 1 < minPlayers 2
        uint256 pot = vault.pot();
        assertGt(pot, 0, "there is real money to rescue");

        vm.warp(vault.entryDeadline() + 2 hours - 1);
        vm.expectRevert(PetVault.SeasonNotAbandoned.selector);
        vault.abandonSeason();

        vm.warp(vault.entryDeadline() + 2 hours);
        address tba = issuer.accountOf(id);
        uint256 tbaBefore = care.balanceOf(tba);
        vault.abandonSeason(); // permissionless
        assertTrue(vault.potClaimed(), "the under-subscribed season is settled two hours later");
        assertEq(care.balanceOf(tba) - tbaBefore, pot, "and the pot went to the only player's own TBA");
        // Under the season-1 constant this money would still have been frozen for another 89 days.
        assertLt(block.timestamp, vault.entryDeadline() + 90 days);
    }
}
