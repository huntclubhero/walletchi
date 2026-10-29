// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

// UNAUDITED: PENDING AUDIT WAVE. Tests for the WALLETCHI economy v3 three-leg care split and the
// RewardsDistributor (epoch-based, activity-weighted rewards paid into each pet's TBA).

import {Test} from "forge-std/Test.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";

import {ERC6551Registry} from "erc6551/ERC6551Registry.sol";
import {IERC6551Registry} from "erc6551/interfaces/IERC6551Registry.sol";

import {WalletchiAccount} from "../../src/WalletchiAccount.sol";
import {Pet721} from "../../src/runner/Pet721.sol";
import {PetIssuer} from "../../src/runner/PetIssuer.sol";
import {PetVault, IPetCareSpender} from "../../src/runner/PetVault.sol";
import {MockCareToken} from "../../src/runner/MockCareToken.sol";
import {PonsCareToken} from "../../src/runner/PonsCareToken.sol";
import {RewardsDistributor} from "../../src/runner/RewardsDistributor.sol";
import {IRewardsSink} from "../../src/runner/IRewardsSink.sol";

/// @dev A care token that reenters RewardsDistributor.claim() on transfer, to prove claim is guarded.
contract ReentrantClaimToken is ERC20 {
    RewardsDistributor public dist;
    uint256 public epoch;
    uint256 public tokenId;
    bool public armed;
    bool public reentered;
    bytes public lastRevert;

    constructor() ERC20("Reenter Claim", "RCLM") {}

    function mint(address to, uint256 amount) external {
        _mint(to, amount);
    }

    function arm(RewardsDistributor dist_, uint256 epoch_, uint256 tokenId_) external {
        dist = dist_;
        epoch = epoch_;
        tokenId = tokenId_;
        armed = true;
    }

    function transfer(address to, uint256 amount) public override returns (bool) {
        if (armed) {
            armed = false;
            reentered = true;
            try dist.claim(epoch, tokenId) {
                lastRevert = "";
            } catch (bytes memory err) {
                lastRevert = err;
            }
        }
        return super.transfer(to, amount);
    }
}

/// @dev A minimal contract used as a stand-in "vault" address in unit tests: setVault now requires the
///      vault to be a contract (L-A1 EOA-footgun guard), so tests that drive notifyCare directly (via
///      vm.prank of the vault address) wire this instead of a bare EOA.
contract VaultStub {}

/// @dev Shared harness: canonical registry + shared WalletchiAccount impl, plus a full three-leg stack
///      builder (pet + issuer + distributor + vault, wired and seeded) for a given token and split.
abstract contract RewardsBase is Test {
    ERC6551Registry internal registry;
    WalletchiAccount internal accountImpl;

    address internal owner = makeAddr("owner");
    address internal relayer = makeAddr("relayer");
    address internal player = makeAddr("player");
    address internal stranger = makeAddr("stranger");
    address internal royalty = makeAddr("royalty");

    address internal constant BURN = 0x000000000000000000000000000000000000dEaD;

    uint256 internal constant BPS = 10_000;
    uint256 internal constant MAX_SUPPLY = 2000;
    uint256 internal constant STARTER = 100e18;
    uint256 internal constant LIFE_TTL = 2 days;
    uint256 internal constant CARE_COST = 1e18;
    uint256 internal constant CARE_COOLDOWN = 1 hours;
    uint256 internal constant EPOCH = 1 days;
    uint256 internal constant FLOAT = 1_000_000e18;

    // A representative three-leg split: 70% pot, 20% rewards, 10% burn.
    uint256 internal constant POT_BPS = 7000;
    uint256 internal constant REWARDS_BPS = 2000;
    uint256 internal constant BURN_BPS = 1000;

    struct Stack {
        Pet721 pet;
        PetIssuer issuer;
        PetVault vault;
        RewardsDistributor dist;
    }

    function setUp() public virtual {
        registry = new ERC6551Registry();
        accountImpl = new WalletchiAccount();
    }

    /// @dev Build and wire a full three-leg stack for `token` with the given split and careCost.
    function _stack(IERC20 token, uint256 potBps, uint256 rewardsBps, uint256 careCost)
        internal
        returns (Stack memory s)
    {
        s.pet = new Pet721("WALLETCHI", "WCHI", MAX_SUPPLY, owner, royalty, "");
        s.issuer = new PetIssuer(
            s.pet,
            IERC6551Registry(address(registry)),
            address(accountImpl),
            token,
            relayer,
            owner,
            careCost, // perTxCap == careCost (tight)
            careCost * 48, // dailyCap: 48 cares of headroom
            STARTER
        );
        s.dist = new RewardsDistributor(owner, token, EPOCH);
        PetVault.Params memory p = PetVault.Params({
            careToken: token,
            pet: s.pet,
            issuer: IPetCareSpender(address(s.issuer)),
            owner: owner,
            lifeTtl: LIFE_TTL,
            careCost: careCost,
            potBps: potBps,
            burnBps: BPS - potBps - rewardsBps,
            rewardsBps: rewardsBps,
            rewardsRecipient: address(s.dist),
            gasBps: 0,
            gasRecipient: address(0),
            abandonGrace: 90 days,
            minPlayers: 2,
            careCooldown: CARE_COOLDOWN,
            minSeasonDuration: LIFE_TTL,
            entryWindowSecs: LIFE_TTL,
            selloutStartsSeason: false
        });
        s.vault = new PetVault(p);

        vm.startPrank(owner);
        s.pet.setIssuer(address(s.issuer));
        s.issuer.setVault(address(s.vault));
        s.dist.setVault(address(s.vault));
        vm.stopPrank();
    }

    function _issue(Stack memory s, address to) internal returns (uint256 id, address tba) {
        vm.prank(relayer);
        (id, tba) = s.issuer.issuePet(to);
    }

    /// @dev Care as the pet's CURRENT owner (owner-only since audit access-H-1). Not for
    ///      vm.expectRevert sites: the ownerOf staticcall would consume the expectation.
    function _care(Stack memory s, uint256 id) internal {
        vm.prank(s.pet.ownerOf(id));
        s.vault.care(id, 0);
    }
}

// ================================================================================================
// BUILD 1: three-leg split in the vault (exactness, backwards compat, validation)
// ================================================================================================

contract ThreeLegSplitTest is RewardsBase {
    function test_Split_PlainToken_ThreeLegsSumToReceived() public {
        MockCareToken care = new MockCareToken();
        Stack memory s = _stack(IERC20(address(care)), POT_BPS, REWARDS_BPS, CARE_COST);
        care.mint(address(s.issuer), FLOAT);

        (uint256 id, address tba) = _issue(s, player);
        vm.warp(block.timestamp + CARE_COOLDOWN);

        uint256 received = CARE_COST; // no fee on a plain token
        uint256 potShare = (received * POT_BPS) / BPS;
        uint256 rewardsShare = (received * REWARDS_BPS) / BPS;
        uint256 burnShare = received - potShare - rewardsShare;

        vm.expectEmit(true, false, false, true, address(s.vault));
        emit PetVault.Care(id, 0, received, burnShare, potShare, rewardsShare, 0, potShare);
        _care(s, id);

        assertEq(potShare + rewardsShare + burnShare, received, "three legs sum to received");
        assertEq(s.vault.pot(), potShare, "pot leg");
        assertEq(s.vault.totalRewards(), rewardsShare, "rewards leg (declared)");
        assertEq(s.vault.totalBurned(), burnShare, "burn leg");
        assertEq(care.balanceOf(BURN), burnShare, "burned to dead");
        assertEq(care.balanceOf(address(s.dist)), rewardsShare, "rewards routed to distributor");
        assertEq(s.dist.epochPool(0), rewardsShare, "distributor booked the rewards");
        assertEq(s.dist.points(0, id), 1, "one activity point");
        assertEq(s.dist.accountOf(id), tba, "pet TBA recorded");
    }

    function test_Split_FeeOnTransfer_ThreeLegsSumToReceived() public {
        // Pons token with a 5% transfer tax; issuer exempt so seeding stays clean, everyone else taxed.
        PonsCareToken care = new PonsCareToken(address(this), FLOAT);
        Stack memory s = _stack(IERC20(address(care)), POT_BPS, REWARDS_BPS, CARE_COST);
        care.setTax(500, address(this));
        care.setTaxExempt(address(s.issuer), true);
        care.transfer(address(s.issuer), FLOAT / 2); // fund issuer float untaxed (issuer is exempt)

        (uint256 id,) = _issue(s, player);
        vm.warp(block.timestamp + CARE_COOLDOWN);

        uint256 vaultBefore = care.balanceOf(address(s.vault));
        uint256 distBefore = care.balanceOf(address(s.dist));
        _care(s, id);
        // `received` is what the vault actually got from the taxed pull.
        uint256 potShare = s.vault.pot();
        uint256 burnShare = s.vault.totalBurned();
        uint256 rewardsShare = s.vault.totalRewards();
        uint256 received = potShare + rewardsShare + burnShare;

        // The vault keeps exactly the pot; the rest left as rewards + burn transfers.
        assertEq(care.balanceOf(address(s.vault)) - vaultBefore, potShare, "vault holds exactly the pot");
        // Exactness: the three legs the vault computed partition the received amount to the wei.
        assertEq((received * POT_BPS) / BPS, potShare, "pot share on received");
        assertEq((received * REWARDS_BPS) / BPS, rewardsShare, "rewards share on received");
        assertEq(received - potShare - rewardsShare, burnShare, "burn takes the remainder / dust");
        // The distributor booked what it ACTUALLY received (rewardsShare minus the transfer tax).
        uint256 distDelta = care.balanceOf(address(s.dist)) - distBefore;
        assertEq(s.dist.epochPool(0), distDelta, "distributor books the measured delta, not the nominal");
        assertLt(distDelta, rewardsShare, "fee-on-transfer skimmed the reward hop");
    }

    function test_BackwardsCompat_RewardsZeroBehavesTwoLeg() public {
        MockCareToken care = new MockCareToken();
        // rewardsBps == 0, rewardsRecipient == address(0): the pre-v3 two-leg deploy.
        Stack memory sThree; // unused distributor path
        sThree.pet = new Pet721("W", "W", MAX_SUPPLY, owner, royalty, "");
        sThree.issuer = new PetIssuer(
            sThree.pet,
            IERC6551Registry(address(registry)),
            address(accountImpl),
            IERC20(address(care)),
            relayer,
            owner,
            CARE_COST,
            CARE_COST * 48,
            STARTER
        );
        PetVault.Params memory p = PetVault.Params({
            careToken: IERC20(address(care)),
            pet: sThree.pet,
            issuer: IPetCareSpender(address(sThree.issuer)),
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
            careCooldown: CARE_COOLDOWN,
            minSeasonDuration: LIFE_TTL,
            entryWindowSecs: LIFE_TTL,
            selloutStartsSeason: false
        });
        sThree.vault = new PetVault(p);
        vm.startPrank(owner);
        sThree.pet.setIssuer(address(sThree.issuer));
        sThree.issuer.setVault(address(sThree.vault));
        vm.stopPrank();
        care.mint(address(sThree.issuer), FLOAT);

        (uint256 id,) = _issue(sThree, player);
        vm.warp(block.timestamp + CARE_COOLDOWN);

        uint256 potShare = (CARE_COST * 1000) / BPS; // exactly the old two-leg math
        uint256 burnShare = CARE_COST - potShare;
        vm.expectEmit(true, false, false, true, address(sThree.vault));
        emit PetVault.Care(id, 0, CARE_COST, burnShare, potShare, 0, 0, potShare);
        _care(sThree, id);

        assertEq(sThree.vault.pot(), potShare, "pot unchanged from two-leg");
        assertEq(sThree.vault.totalBurned(), burnShare, "burn == remainder, no rewards leg");
        assertEq(sThree.vault.totalRewards(), 0, "no rewards accrued");
        assertEq(sThree.vault.rewardsBps(), 0);
        assertEq(sThree.vault.rewardsRecipient(), address(0));
        assertEq(care.balanceOf(BURN), burnShare);
    }

    /// Fuzz the three-leg split across many bps configs and careCosts on a plain token: the three
    /// legs always partition `received` exactly, with the dust falling to burn.
    function testFuzz_Split_PlainExact(uint256 potFuzz, uint256 rewardsFuzz, uint256 careCostFuzz) public {
        uint256 potBps = bound(potFuzz, 1, BPS - 2);
        uint256 rewardsBps = bound(rewardsFuzz, 1, BPS - 1 - potBps);
        uint256 careCost = bound(careCostFuzz, 1e18, 2e18);

        MockCareToken care = new MockCareToken();
        Stack memory s = _stack(IERC20(address(care)), potBps, rewardsBps, careCost);
        care.mint(address(s.issuer), FLOAT);

        (uint256 id,) = _issue(s, player);
        vm.warp(block.timestamp + CARE_COOLDOWN);
        _care(s, id);

        uint256 received = careCost;
        uint256 expPot = (received * potBps) / BPS;
        uint256 expRewards = (received * rewardsBps) / BPS;
        uint256 expBurn = received - expPot - expRewards;

        assertEq(s.vault.pot(), expPot, "pot");
        assertEq(s.vault.totalRewards(), expRewards, "rewards");
        assertEq(s.vault.totalBurned(), expBurn, "burn (dust)");
        assertEq(expPot + expRewards + expBurn, received, "exact partition");
        assertEq(s.dist.epochPool(0), expRewards, "distributor booked rewards (plain: no tax)");
    }

    /// Fuzz the split with a fee-on-transfer token: the three legs still partition the RECEIVED amount
    /// exactly, and the distributor books the measured (post-tax) reward delta.
    function testFuzz_Split_FeeOnTransferExact(uint256 potFuzz, uint256 rewardsFuzz, uint256 taxFuzz) public {
        uint256 potBps = bound(potFuzz, 1, BPS - 2);
        uint256 rewardsBps = bound(rewardsFuzz, 1, BPS - 1 - potBps);
        uint256 taxBps = bound(taxFuzz, 1, 1000); // Pons cap is 10%

        PonsCareToken care = new PonsCareToken(address(this), FLOAT);
        Stack memory s = _stack(IERC20(address(care)), potBps, rewardsBps, CARE_COST);
        care.setTax(uint96(taxBps), address(this));
        care.setTaxExempt(address(s.issuer), true);
        care.transfer(address(s.issuer), FLOAT / 2);

        (uint256 id,) = _issue(s, player);
        vm.warp(block.timestamp + CARE_COOLDOWN);

        uint256 distBefore = care.balanceOf(address(s.dist));
        _care(s, id);

        uint256 potShare = s.vault.pot();
        uint256 rewardsShare = s.vault.totalRewards();
        uint256 burnShare = s.vault.totalBurned();
        uint256 received = potShare + rewardsShare + burnShare;

        assertEq((received * potBps) / BPS, potShare, "pot on received");
        assertEq((received * rewardsBps) / BPS, rewardsShare, "rewards on received");
        assertEq(received - potShare - rewardsShare, burnShare, "burn remainder");
        assertEq(potShare + rewardsShare + burnShare, received, "exact partition under FoT");

        uint256 distDelta = care.balanceOf(address(s.dist)) - distBefore;
        assertEq(s.dist.epochPool(0), distDelta, "distributor books measured post-tax delta");
    }
}

contract ThreeLegValidationTest is RewardsBase {
    MockCareToken internal care;
    PetIssuer internal issuer;
    Pet721 internal pet;

    function setUp() public override {
        super.setUp();
        care = new MockCareToken();
        pet = new Pet721("W", "W", MAX_SUPPLY, owner, royalty, "");
        issuer = new PetIssuer(
            pet,
            IERC6551Registry(address(registry)),
            address(accountImpl),
            IERC20(address(care)),
            relayer,
            owner,
            CARE_COST,
            CARE_COST * 48,
            STARTER
        );
    }

    function _baseParams() internal returns (PetVault.Params memory p) {
        p = PetVault.Params({
            careToken: IERC20(address(care)),
            pet: pet,
            issuer: IPetCareSpender(address(issuer)),
            owner: owner,
            lifeTtl: LIFE_TTL,
            careCost: CARE_COST,
            potBps: POT_BPS,
            burnBps: BURN_BPS,
            rewardsBps: REWARDS_BPS,
            rewardsRecipient: address(new VaultStub()),
            gasBps: 0,
            gasRecipient: address(0),
            abandonGrace: 90 days,
            minPlayers: 2,
            careCooldown: CARE_COOLDOWN,
            minSeasonDuration: LIFE_TTL,
            entryWindowSecs: LIFE_TTL,
            selloutStartsSeason: false
        });
    }

    function test_Constructor_RevertsThreeLegBadBps() public {
        PetVault.Params memory p = _baseParams();
        p.potBps = 7000;
        p.rewardsBps = 2000;
        p.burnBps = 2000; // sum 11000 != 10000
        vm.expectRevert(PetVault.BadBps.selector);
        new PetVault(p);
    }

    function test_Constructor_RevertsRewardsRecipientZero() public {
        PetVault.Params memory p = _baseParams();
        p.rewardsRecipient = address(0); // rewardsBps > 0 requires a recipient
        vm.expectRevert(PetVault.ZeroAddress.selector);
        new PetVault(p);
    }

    function test_Constructor_RevertsCodelessRewardsRecipient() public {
        PetVault.Params memory p = _baseParams();
        address codelessRecipient = makeAddr("codelessRewardsRecipient");
        p.rewardsRecipient = codelessRecipient;
        vm.expectRevert(abi.encodeWithSelector(PetVault.DependencyNotContract.selector, codelessRecipient));
        new PetVault(p);
    }

    function test_Constructor_RevertsRewardsDustTooSmall() public {
        // careCost chosen so the POT dust guard passes (2*9999 >= BPS) but the REWARDS dust guard
        // trips (2*1 = 2 < BPS), isolating the new rewards-leg guard.
        PetVault.Params memory p = _baseParams();
        p.careCost = 2;
        p.potBps = 9999;
        p.rewardsBps = 1;
        p.burnBps = 0; // sum 10000
        vm.expectRevert(PetVault.BadConfig.selector);
        new PetVault(p);
    }

    /// rewardsBps == 0 with a zero recipient is explicitly allowed (backwards-compatible two-leg).
    function test_Constructor_TwoLegZeroRecipientAllowed() public {
        PetVault.Params memory p = _baseParams();
        p.potBps = 1000;
        p.burnBps = 9000;
        p.rewardsBps = 0;
        p.rewardsRecipient = address(0);
        PetVault v = new PetVault(p);
        assertEq(v.rewardsBps(), 0);
        assertEq(v.rewardsRecipient(), address(0));
    }
}

// ================================================================================================
// BUILD 2/3: RewardsDistributor unit + integration
// ================================================================================================

contract RewardsDistributorUnitTest is RewardsBase {
    MockCareToken internal care;
    RewardsDistributor internal dist;
    address internal vaultEOA = address(new VaultStub()); // a stand-in (contract) vault to drive notifyCare

    function setUp() public override {
        super.setUp();
        care = new MockCareToken();
        dist = new RewardsDistributor(owner, IERC20(address(care)), EPOCH);
        vm.prank(owner);
        dist.setVault(vaultEOA);
    }

    function _notify(uint256 tokenId, address account, uint256 declared) internal {
        vm.prank(vaultEOA);
        dist.notifyCare(tokenId, account, declared);
    }

    function test_SetVault_OnceThenFrozen() public {
        assertEq(dist.vault(), vaultEOA);
        vm.prank(owner);
        vm.expectRevert(RewardsDistributor.VaultAlreadySet.selector);
        dist.setVault(makeAddr("other"));
    }

    function test_SetVault_OnlyOwner() public {
        RewardsDistributor d = new RewardsDistributor(owner, IERC20(address(care)), EPOCH);
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, stranger));
        vm.prank(stranger);
        d.setVault(vaultEOA);
    }

    function test_NotifyCare_OnlyVault() public {
        vm.expectRevert(RewardsDistributor.NotVault.selector);
        vm.prank(stranger);
        dist.notifyCare(1, makeAddr("tba"), 1e18);
    }

    function test_SinglePlayerEpoch_ClaimsWholePool() public {
        address tba = makeAddr("tba1");
        care.mint(address(dist), 50e18); // vault "sent" the reward slice
        _notify(1, tba, 50e18);
        assertEq(dist.epochPool(0), 50e18);
        assertEq(dist.totalPoints(0), 1);

        vm.warp(block.timestamp + EPOCH); // finish epoch 0
        assertEq(dist.epochNow(), 1);

        uint256 payout = dist.claim(0, 1);
        assertEq(payout, 50e18, "sole participant takes the whole pool");
        assertEq(care.balanceOf(tba), 50e18, "paid into the recorded TBA");
        assertEq(dist.accounted(), 0, "fully paid out");
    }

    function test_Claim_PaysTbaNotCaller() public {
        address tba = makeAddr("tbaX");
        care.mint(address(dist), 10e18);
        _notify(7, tba, 10e18);
        vm.warp(block.timestamp + EPOCH);

        vm.prank(stranger); // a random caller triggers the claim
        dist.claim(0, 7);
        assertEq(care.balanceOf(tba), 10e18, "funds go to the pet TBA");
        assertEq(care.balanceOf(stranger), 0, "caller gets nothing");
    }

    function test_Claim_DoubleClaimReverts() public {
        address tba = makeAddr("tba2");
        care.mint(address(dist), 30e18);
        _notify(1, tba, 30e18);
        vm.warp(block.timestamp + EPOCH);

        dist.claim(0, 1);
        vm.expectRevert(RewardsDistributor.AlreadyClaimed.selector);
        dist.claim(0, 1);
    }

    function test_Claim_UnfinishedEpochReverts() public {
        address tba = makeAddr("tba3");
        care.mint(address(dist), 5e18);
        _notify(1, tba, 5e18);
        // still epoch 0 (in progress)
        vm.expectRevert(RewardsDistributor.EpochNotFinished.selector);
        dist.claim(0, 1);
        // a future epoch is likewise unfinished
        vm.expectRevert(RewardsDistributor.EpochNotFinished.selector);
        dist.claim(5, 1);
    }

    function test_Claim_ZeroPointPetReverts() public {
        address tba = makeAddr("tba4");
        care.mint(address(dist), 8e18);
        _notify(1, tba, 8e18); // only pet 1 has a point
        vm.warp(block.timestamp + EPOCH);
        vm.expectRevert(RewardsDistributor.NoPoints.selector);
        dist.claim(0, 999); // a pet with no points in the epoch
    }

    function test_MultiPlayerProRata() public {
        // pet 1: 1 point, pet 2: 2 points, pet 3: 3 points => pool splits 1/6, 2/6, 3/6.
        address t1 = makeAddr("t1");
        address t2 = makeAddr("t2");
        address t3 = makeAddr("t3");
        uint256 pool = 600e18;
        care.mint(address(dist), pool);
        _notify(1, t1, pool); // first notify recognizes the whole minted pool
        _notify(2, t2, 0);
        _notify(2, t2, 0);
        _notify(3, t3, 0);
        _notify(3, t3, 0);
        _notify(3, t3, 0);
        assertEq(dist.epochPool(0), pool);
        assertEq(dist.totalPoints(0), 6);

        vm.warp(block.timestamp + EPOCH);
        dist.claim(0, 1);
        dist.claim(0, 2);
        dist.claim(0, 3);
        assertEq(care.balanceOf(t1), pool * 1 / 6, "1/6 pro rata");
        assertEq(care.balanceOf(t2), pool * 2 / 6, "2/6 pro rata");
        assertEq(care.balanceOf(t3), pool * 3 / 6, "3/6 pro rata");
    }

    /// Fuzz points across three pets; each pet's payout is exactly pool * pts / totalPoints.
    function testFuzz_ProRata(uint256 a, uint256 b, uint256 c, uint256 poolFuzz) public {
        uint256 pa = bound(a, 1, 20);
        uint256 pb = bound(b, 1, 20);
        uint256 pc = bound(c, 1, 20);
        uint256 pool = bound(poolFuzz, 1e18, 1_000e18);
        address t1 = makeAddr("f1");
        address t2 = makeAddr("f2");
        address t3 = makeAddr("f3");

        care.mint(address(dist), pool);
        for (uint256 i = 0; i < pa; i++) {
            _notify(1, t1, i == 0 ? pool : 0);
        }
        for (uint256 i = 0; i < pb; i++) {
            _notify(2, t2, 0);
        }
        for (uint256 i = 0; i < pc; i++) {
            _notify(3, t3, 0);
        }

        uint256 total = pa + pb + pc;
        assertEq(dist.totalPoints(0), total);

        vm.warp(block.timestamp + EPOCH);
        dist.claim(0, 1);
        dist.claim(0, 2);
        dist.claim(0, 3);
        assertEq(care.balanceOf(t1), pool * pa / total);
        assertEq(care.balanceOf(t2), pool * pb / total);
        assertEq(care.balanceOf(t3), pool * pc / total);
        // Only floor-division dust may remain unclaimed in the contract.
        uint256 paid = pool * pa / total + pool * pb / total + pool * pc / total;
        assertEq(care.balanceOf(address(dist)), pool - paid, "only rounding dust left behind");
    }

    function test_ClaimMany() public {
        address t1 = makeAddr("m1");
        address t2 = makeAddr("m2");
        care.mint(address(dist), 300e18);
        _notify(1, t1, 300e18);
        _notify(2, t2, 0);
        vm.warp(block.timestamp + EPOCH);

        uint256[] memory ids = new uint256[](2);
        ids[0] = 1;
        ids[1] = 2;
        uint256 total = dist.claimMany(0, ids);
        assertEq(total, 300e18, "both shares paid");
        assertEq(care.balanceOf(t1), 150e18);
        assertEq(care.balanceOf(t2), 150e18);
    }

    /// Zero-point epoch rollover: a donation synced into a care-less epoch rolls into the next epoch
    /// (where it becomes claimable), rather than being trapped.
    function test_ZeroPointEpochRollsForward() public {
        // Epoch 0: donate + sync, NO care => pool with zero points.
        care.mint(address(dist), 40e18);
        dist.sync();
        assertEq(dist.epochPool(0), 40e18);
        assertEq(dist.totalPoints(0), 0);

        vm.warp(block.timestamp + EPOCH); // epoch 0 finished, epoch 1 current
        // Cannot claim a zero-point epoch.
        vm.expectRevert(RewardsDistributor.NoPoints.selector);
        dist.claim(0, 1);

        dist.rollForward(0);
        assertEq(dist.epochPool(0), 0, "epoch 0 drained");
        assertEq(dist.epochPool(1), 40e18, "rolled into epoch 1");
        // A double roll is rejected.
        vm.expectRevert(RewardsDistributor.NothingToRoll.selector);
        dist.rollForward(0);

        // Epoch 1: a pet cares (earns the rolled pool), then epoch 1 finishes and it claims.
        address tba = makeAddr("rollTba");
        _notify(1, tba, 0); // recognizes 0 new funds (all already accounted), adds a point
        assertEq(dist.epochPool(1), 40e18, "no double count");
        vm.warp(block.timestamp + EPOCH); // finish epoch 1
        dist.claim(1, 1);
        assertEq(care.balanceOf(tba), 40e18, "rolled pool claimable in the next epoch");
        assertEq(dist.accounted(), 0);
    }

    function test_RollForward_RejectsUnfinishedAndPointed() public {
        care.mint(address(dist), 10e18);
        _notify(1, makeAddr("t"), 10e18); // epoch 0 has a point
        // current (unfinished) epoch cannot roll
        vm.expectRevert(RewardsDistributor.EpochNotFinished.selector);
        dist.rollForward(0);
        vm.warp(block.timestamp + EPOCH);
        // finished, but it has points => not a rollover candidate
        vm.expectRevert(RewardsDistributor.EpochHasPoints.selector);
        dist.rollForward(0);
    }

    /// A malicious care token that reenters claim() during the payout is blocked by the guard, and the
    /// legitimate claim still pays exactly once.
    function test_Claim_ReentrancyGuarded() public {
        ReentrantClaimToken evil = new ReentrantClaimToken();
        RewardsDistributor d = new RewardsDistributor(owner, IERC20(address(evil)), EPOCH);
        vm.prank(owner);
        d.setVault(vaultEOA);

        address tba = makeAddr("evilTba");
        evil.mint(address(d), 25e18);
        vm.prank(vaultEOA);
        d.notifyCare(1, tba, 25e18);
        vm.warp(block.timestamp + EPOCH);

        evil.arm(d, 0, 1); // reenter claim(0,1) during the payout transfer
        d.claim(0, 1);

        assertTrue(evil.reentered(), "token attempted reentrancy");
        assertEq(
            bytes4(evil.lastRevert()),
            ReentrancyGuard.ReentrancyGuardReentrantCall.selector,
            "reentrant claim blocked by the guard"
        );
        assertEq(evil.balanceOf(tba), 25e18, "paid exactly once");
        assertEq(d.accounted(), 0);
    }
}

contract RewardsIntegrationTest is RewardsBase {
    /// Full loop through the vault with a fee-on-transfer care token: register pets, care, advance an
    /// epoch, claim, and assert the winning TBA balances to the wei.
    function test_FullLoop_TaxedToken_ClaimToTheWei() public {
        PonsCareToken care = new PonsCareToken(address(this), FLOAT);
        Stack memory s = _stack(IERC20(address(care)), POT_BPS, REWARDS_BPS, CARE_COST);
        uint256 taxBps = 500;
        care.setTax(uint96(taxBps), address(this));
        care.setTaxExempt(address(s.issuer), true); // clean seeding
        care.transfer(address(s.issuer), FLOAT / 2);

        (uint256 id, address tba) = _issue(s, player);
        (uint256 id2,) = _issue(s, makeAddr("p2")); // a second pet keeps minPlayers happy in the vault

        vm.warp(block.timestamp + CARE_COOLDOWN);
        uint256 distBefore = care.balanceOf(address(s.dist));
        _care(s, id); // only pet `id` cares this epoch => it owns the whole reward pool
        uint256 recognized = care.balanceOf(address(s.dist)) - distBefore;

        assertEq(s.dist.epochPool(0), recognized, "epoch pool == measured received");
        assertEq(s.dist.points(0, id), 1);
        assertEq(s.dist.points(0, id2), 0);
        assertEq(s.dist.accountOf(id), tba);

        vm.warp(block.timestamp + EPOCH); // finish epoch 0
        assertEq(s.dist.epochNow() >= 1, true);

        uint256 tbaBefore = care.balanceOf(tba);
        uint256 pool = s.dist.epochPool(0);
        s.dist.claim(0, id);
        // The claim pays `pool` from the distributor into the TBA; that final hop is taxed too.
        uint256 expectedToTba = pool - (pool * taxBps) / BPS;
        assertEq(care.balanceOf(tba) - tbaBefore, expectedToTba, "TBA credited pool minus final-hop tax, to the wei");
        assertEq(s.dist.accounted(), 0, "all recognized funds left via claim");
        assertEq(care.balanceOf(address(s.dist)), 0, "distributor emptied");
    }

    /// Two pets, both care once in the same epoch: each claims half of the reward pool into its TBA.
    function test_FullLoop_PlainToken_TwoPetsSplit() public {
        MockCareToken care = new MockCareToken();
        Stack memory s = _stack(IERC20(address(care)), POT_BPS, REWARDS_BPS, CARE_COST);
        care.mint(address(s.issuer), FLOAT);

        (uint256 id1, address tba1) = _issue(s, player);
        (uint256 id2, address tba2) = _issue(s, makeAddr("p2"));
        vm.warp(block.timestamp + CARE_COOLDOWN);
        _care(s, id1);
        _care(s, id2);

        uint256 rewardsPerCare = (CARE_COST * REWARDS_BPS) / BPS;
        assertEq(s.dist.epochPool(0), rewardsPerCare * 2, "both cares funded the epoch");
        assertEq(s.dist.totalPoints(0), 2);

        vm.warp(block.timestamp + EPOCH);
        uint256 b1 = care.balanceOf(tba1); // TBAs still hold their seeded starter float
        uint256 b2 = care.balanceOf(tba2);
        s.dist.claim(0, id1);
        s.dist.claim(0, id2);
        assertEq(care.balanceOf(tba1) - b1, rewardsPerCare, "pet 1 got half");
        assertEq(care.balanceOf(tba2) - b2, rewardsPerCare, "pet 2 got half");
        assertEq(s.dist.accounted(), 0);
    }
}
