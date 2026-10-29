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

/// @notice REGRESSION: a seller must not be able to permanently brick a pet before selling it.
///
///         revokeSpender() left `spenderInitialized` true, so initializeSpender reverted forever and
///         pullCare reverted NotSpender forever: the pet could never be fed by anyone again. A seller
///         could revoke, list at full price, and hand the buyer an asset that dies within lifeTtl and
///         is then soulbound so it cannot even be resold. restoreIssuerSpender() makes it recoverable,
///         and can only ever point back at the bound token's own locked issuer.
contract SpenderRestoreTest is Test {
    Pet721 internal pet;
    PetIssuer internal issuer;
    PetVault internal vault;
    MockCareToken internal care;
    address internal owner = makeAddr("owner");
    address internal relayer = makeAddr("relayer");
    address internal seller = makeAddr("seller");
    address internal buyer = makeAddr("buyer");

    function setUp() public {
        vm.startPrank(owner);
        ERC6551Registry registry = new ERC6551Registry();
        care = new MockCareToken();
        WalletchiAccount impl = new WalletchiAccount();
        pet = new Pet721("WALLETCHI", "WCHI", 2000, owner, owner, "");
        issuer = new PetIssuer(pet, IERC6551Registry(address(registry)), address(impl), IERC20(address(care)), relayer, owner, 1e18, 20e18, 100e18);
        vault = new PetVault(PetVault.Params({
            careToken: IERC20(address(care)), pet: pet, issuer: IPetCareSpender(address(issuer)), owner: owner,
            lifeTtl: 86400, careCost: 1e18, potBps: 1000, burnBps: 9000, rewardsBps: 0,
            rewardsRecipient: address(0),
            gasBps: 0, gasRecipient: address(0), abandonGrace: 90 days,
            minPlayers: 3, careCooldown: 60,
            minSeasonDuration: 86400,
            entryWindowSecs: 86400
        , selloutStartsSeason: false}));
        pet.setIssuer(address(issuer)); issuer.setVault(address(vault)); pet.setVaultRef(address(vault));
        pet.lockIssuer(); issuer.lockVault(); pet.lockVaultRef();
        vm.stopPrank();
        care.mint(address(issuer), 1_000_000e18);
    }

    function test_BuyerCanUndoASellersSabotage() public {
        vm.prank(relayer);
        (uint256 id, address tba) = issuer.issuePet(seller);
        WalletchiAccount acct = WalletchiAccount(payable(tba));

        // The seller sabotages the pet, then sells it. Nothing warns the buyer.
        vm.prank(seller);
        acct.revokeSpender();
        vm.prank(seller);
        pet.transferFrom(seller, buyer, id);

        // The pet is unfeedable in the buyer's hands.
        vm.warp(block.timestamp + 60);
        vm.prank(buyer);
        vm.expectRevert(WalletchiAccount.NotSpender.selector);
        vault.care(id, 0);

        // The buyer restores it themselves, with no help from us and no help from the seller.
        vm.prank(buyer);
        acct.restoreIssuerSpender();
        assertEq(acct.spender(), address(issuer), "restored to the bound token's canonical issuer");

        vm.prank(buyer);
        vault.care(id, 0);
        (,,, uint32 careCount,) = vault.memorialState(id);
        assertEq(careCount, 1, "the pet is feedable again");
    }

    function test_OnlyOwnerCanRestore() public {
        vm.prank(relayer);
        (, address tba) = issuer.issuePet(seller);
        WalletchiAccount acct = WalletchiAccount(payable(tba));
        vm.prank(seller);
        acct.revokeSpender();

        vm.prank(buyer); // not the owner
        vm.expectRevert(WalletchiAccount.NotOwner.selector);
        acct.restoreIssuerSpender();
    }

    /// @dev The destination is read from the bound token, never chosen by the caller, so an owner
    ///      cannot use restore to appoint an arbitrary spender over their pet's funds.
    function test_RestoreCanOnlyEverPointAtTheCanonicalIssuer() public {
        vm.prank(relayer);
        (, address tba) = issuer.issuePet(seller);
        WalletchiAccount acct = WalletchiAccount(payable(tba));
        vm.prank(seller);
        acct.revokeSpender();
        vm.prank(seller);
        acct.restoreIssuerSpender();
        assertEq(acct.spender(), pet.issuer(), "spender == Pet721.issuer(), which is one-way locked");
    }

    /// @dev The natspec used to claim restore RE-READS the caps from the issuer. It does not, and it
    ///      must not: caps are baked per pet at mint with no setter, so re-reading them would let the
    ///      issuer owner retune an ALREADY MINTED pet's spending limits by inviting its holder to
    ///      restore. This pins the actual behaviour so the corrected comment cannot drift back.
    function test_RestoreDoesNotReReadTheCapsFromTheIssuer() public {
        vm.prank(relayer);
        (, address tba) = issuer.issuePet(seller);
        WalletchiAccount acct = WalletchiAccount(payable(tba));
        uint256 perTxBefore = acct.perTxCap();
        uint256 dailyBefore = acct.dailyCap();

        // The issuer owner changes the caps for FUTURE mints.
        vm.prank(owner);
        issuer.setCaps(perTxBefore, dailyBefore * 3);
        assertEq(issuer.dailyCap(), dailyBefore * 3, "the issuer's caps did change");

        vm.prank(seller);
        acct.revokeSpender();
        vm.prank(seller);
        acct.restoreIssuerSpender();

        assertEq(acct.perTxCap(), perTxBefore, "an already-minted pet keeps its baked perTxCap");
        assertEq(acct.dailyCap(), dailyBefore, "and its baked dailyCap: restore touches the spender only");
    }
}

/// @notice Direct unit cover for the CARER SUB-CAP on the account itself, independent of the game.
///         The vault-level proof lives in FiveNeeds.t.sol; this pins the accounting.
contract WalletchiAccountCarerCapTest is Test {
    ERC6551Registry internal registry;
    WalletchiAccount internal impl;
    Pet721 internal pet;
    PetIssuer internal issuer;
    MockCareToken internal care;

    address internal owner = makeAddr("owner");
    address internal relayer = makeAddr("relayer");
    address internal holder = makeAddr("holder");
    address internal sink = makeAddr("sink");

    uint256 internal constant PER_TX = 1e18;
    uint256 internal constant DAILY = 20e18;

    WalletchiAccount internal acct;

    function setUp() public {
        vm.startPrank(owner);
        registry = new ERC6551Registry();
        care = new MockCareToken();
        impl = new WalletchiAccount();
        pet = new Pet721("WALLETCHI", "WCHI", 2000, owner, owner, "");
        issuer = new PetIssuer(
            pet, IERC6551Registry(address(registry)), address(impl), IERC20(address(care)),
            relayer, owner, PER_TX, DAILY, 0
        );
        // The issuer needs a wired vault to mint at all (it registers each pet and reads the roster
        // close). The game itself is irrelevant here: these units drive the ACCOUNT directly.
        PetVault vault = new PetVault(
            PetVault.Params({
                careToken: IERC20(address(care)),
                pet: pet,
                issuer: IPetCareSpender(address(issuer)),
                owner: owner,
                lifeTtl: 1 days,
                careCost: PER_TX,
                potBps: 1000,
                burnBps: 9000,
                rewardsBps: 0,
                rewardsRecipient: address(0),
                gasBps: 0,
                gasRecipient: address(0),
                abandonGrace: 90 days,
                minPlayers: 2,
                careCooldown: 0,
                minSeasonDuration: 30 days,
                entryWindowSecs: 7 days
            , selloutStartsSeason: false})
        );
        pet.setIssuer(address(issuer));
        issuer.setVault(address(vault));
        vm.stopPrank();
        vm.prank(relayer);
        (, address tba) = issuer.issuePet(holder);
        acct = WalletchiAccount(payable(tba));
        care.mint(tba, 1000e18);
    }

    function test_CarerCapConstantsAreWhatTheDeployScriptAssumes() public view {
        assertEq(acct.CARER_CAP_BPS(), 5000, "DeployWalletchi mirrors this constant");
        assertEq(acct.carerDailyCap(), DAILY / 2);
        assertEq(acct.SPEND_WINDOW(), 1 days, "the window LIFE_TTL is compared against");
    }

    /// @dev Drive the account directly as its spender, which is what PetIssuer does.
    function test_CarerSpendIsBoundedAndTheOwnerKeepsHeadroom() public {
        for (uint256 i = 0; i < 10; i++) {
            vm.prank(address(issuer));
            acct.spendAsCarer(address(care), sink, PER_TX);
        }
        assertEq(acct.carerSpentInWindow(), DAILY / 2, "the carer used exactly its sub-cap");
        assertEq(acct.spentInWindow(), DAILY / 2, "and it counts against the shared ledger too");
        assertEq(acct.remainingCarerAllowance(), 0);
        assertEq(acct.remainingDailyAllowance(), DAILY / 2, "the owner's half is untouched");

        vm.prank(address(issuer));
        vm.expectRevert(WalletchiAccount.OverCarerCap.selector);
        acct.spendAsCarer(address(care), sink, PER_TX);

        // The OWNER path is unrestricted up to the shared cap, in the very same window.
        for (uint256 i = 0; i < 10; i++) {
            vm.prank(address(issuer));
            acct.spend(address(care), sink, PER_TX);
        }
        assertEq(acct.spentInWindow(), DAILY);
        vm.prank(address(issuer));
        vm.expectRevert(WalletchiAccount.OverDailyCap.selector);
        acct.spend(address(care), sink, PER_TX);
    }

    function test_TheCarerLedgerRollsWithTheWindow() public {
        for (uint256 i = 0; i < 10; i++) {
            vm.prank(address(issuer));
            acct.spendAsCarer(address(care), sink, PER_TX);
        }
        vm.prank(address(issuer));
        vm.expectRevert(WalletchiAccount.OverCarerCap.selector);
        acct.spendAsCarer(address(care), sink, PER_TX);

        vm.warp(acct.windowStart() + acct.SPEND_WINDOW());
        assertEq(acct.remainingCarerAllowance(), DAILY / 2, "a fresh window, a fresh sub-cap");
        vm.prank(address(issuer));
        acct.spendAsCarer(address(care), sink, PER_TX);
        assertEq(acct.carerSpentInWindow(), PER_TX, "the carer ledger reset with the window");
        assertEq(acct.spentInWindow(), PER_TX, "and so did the shared one");
    }

    /// The shared cap still binds a carer even when its own sub-cap has room: the sub-cap is checked
    /// IN ADDITION to the daily cap, never instead of it.
    function test_TheSharedCapStillBindsACarer() public {
        // The owner burns almost everything first, leaving less than the carer's sub-cap.
        for (uint256 i = 0; i < 19; i++) {
            vm.prank(address(issuer));
            acct.spend(address(care), sink, PER_TX);
        }
        assertEq(acct.remainingDailyAllowance(), PER_TX);
        assertGt(acct.remainingCarerAllowance(), 0);
        assertEq(acct.remainingCarerAllowance(), PER_TX, "the view reports the binding constraint");

        vm.prank(address(issuer));
        acct.spendAsCarer(address(care), sink, PER_TX); // the last shared unit
        vm.prank(address(issuer));
        vm.expectRevert(WalletchiAccount.OverDailyCap.selector);
        acct.spendAsCarer(address(care), sink, PER_TX);
    }

    function test_OnlyTheSpenderCanUseTheCarerPath() public {
        vm.prank(holder); // the owner is NOT the spender
        vm.expectRevert(WalletchiAccount.NotSpender.selector);
        acct.spendAsCarer(address(care), sink, PER_TX);
    }
}
