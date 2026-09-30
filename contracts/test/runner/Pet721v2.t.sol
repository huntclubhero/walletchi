// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {IERC721} from "@openzeppelin/contracts/token/ERC721/IERC721.sol";
import {IERC165} from "@openzeppelin/contracts/utils/introspection/IERC165.sol";
import {IERC2981} from "@openzeppelin/contracts/interfaces/IERC2981.sol";
import {ERC2981} from "@openzeppelin/contracts/token/common/ERC2981.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";

import {ERC6551Registry} from "erc6551/ERC6551Registry.sol";
import {IERC6551Registry} from "erc6551/interfaces/IERC6551Registry.sol";

import {WalletchiAccount} from "../../src/WalletchiAccount.sol";
import {Pet721, ICreatorToken, ITransferValidator} from "../../src/runner/Pet721.sol";
import {PetIssuer} from "../../src/runner/PetIssuer.sol";
import {PetVault, IPetCareSpender} from "../../src/runner/PetVault.sol";
import {MockCareToken} from "../../src/runner/MockCareToken.sol";
import {WalletchiTransferValidator} from "../../src/runner/WalletchiTransferValidator.sol";

/// @dev Full-suite base for the Pet721 v2 (ERC-721C + ERC-2981 + death-soulbound) rebase. Wires a
///      real season the same way production does, INCLUDING the death-soulbound vault reference.
abstract contract Pet721v2Base is Test {
    ERC6551Registry internal registry;
    WalletchiAccount internal accountImpl;
    Pet721 internal pet;
    PetIssuer internal issuer;
    PetVault internal vault;
    MockCareToken internal care;

    address internal owner = makeAddr("owner");
    address internal relayer = makeAddr("relayer");
    address internal player = makeAddr("player");
    address internal buyer = makeAddr("buyer");
    address internal stranger = makeAddr("stranger");
    address internal royaltyRecipient = makeAddr("royaltyRecipient");
    address internal marketplace = makeAddr("marketplace");

    uint256 internal constant MAX_SUPPLY = 2000;
    uint256 internal constant PER_TX_CAP = 1e18;
    uint256 internal constant DAILY_CAP = 1000e18;
    uint256 internal constant STARTER = 100e18;
    uint256 internal constant LIFE_TTL = 1 days;
    uint256 internal constant CARE_COST = 1e18;
    uint256 internal constant POT_BPS = 1000;
    uint256 internal constant BURN_BPS = 9000;
    uint256 internal constant MIN_PLAYERS = 3;
    uint256 internal constant CARE_COOLDOWN = 1 hours;
    uint256 internal constant FLOAT = 1_000_000e18;

    function setUp() public {
        registry = new ERC6551Registry();
        accountImpl = new WalletchiAccount();
        care = new MockCareToken();
        pet = new Pet721("WALLETCHI", "WCHI", MAX_SUPPLY, owner, royaltyRecipient, "");
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
                entryWindowSecs: LIFE_TTL,
                selloutStartsSeason: false
            })
        );

        vm.startPrank(owner);
        pet.setIssuer(address(issuer));
        issuer.setVault(address(vault));
        pet.setVaultRef(address(vault));
        vm.stopPrank();

        care.mint(address(issuer), FLOAT);
    }

    function _issue(address to) internal returns (uint256 id, address tba) {
        vm.prank(relayer);
        (id, tba) = issuer.issuePet(to);
    }

    /// @dev Kill a pet the only way the model allows: HATCH it first (death needs careCount > 0; a
    ///      never-fed egg has no life timer, audit death-F1) then let its life timer lapse. Death is
    ///      purely time-based and permanent (there is no reap step). Care is OWNER-only (audit
    ///      access-H-1), so the hatch is pranked as the pet's current owner.
    function _kill(uint256 id) internal {
        vm.warp(block.timestamp + CARE_COOLDOWN);
        vm.prank(pet.ownerOf(id));
        vault.care(id, 0);
        vm.warp(block.timestamp + LIFE_TTL + 1);
    }
}

// ================================================================================================
// ERC-2981 royalties: 5% to the dedicated recipient, owner-settable, one-way lockable.
// ================================================================================================
contract Pet721RoyaltyTest is Pet721v2Base {
    function test_RoyaltyInfo_FivePercentToDedicatedRecipient() public view {
        (address recv, uint256 amount) = pet.royaltyInfo(1, 1 ether);
        assertEq(recv, royaltyRecipient, "dedicated recipient");
        assertEq(amount, 0.05 ether, "5% of sale price");
        assertEq(pet.DEFAULT_ROYALTY_BPS(), 500, "500 bps constant");
    }

    function test_RoyaltyInfo_ScalesWithSalePrice() public view {
        (, uint256 amount) = pet.royaltyInfo(7, 200 ether);
        assertEq(amount, 10 ether, "5% of 200");
    }

    function test_SetRoyalty_OwnerCanRepointBeforeLock() public {
        address newRecv = makeAddr("newRoyalty");
        vm.prank(owner);
        pet.setRoyalty(newRecv, 250); // 2.5%
        (address recv, uint256 amount) = pet.royaltyInfo(1, 1 ether);
        assertEq(recv, newRecv);
        assertEq(amount, 0.025 ether);
        assertEq(pet.royaltyReceiver(), newRecv);
    }

    function test_SetRoyalty_OnlyOwner() public {
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, stranger));
        vm.prank(stranger);
        pet.setRoyalty(stranger, 100);
    }

    function test_LockRoyalty_FreezesRecipientAndRate() public {
        vm.startPrank(owner);
        pet.lockRoyalty();
        assertTrue(pet.royaltyLocked());
        vm.expectRevert(Pet721.RoyaltyIsLocked.selector);
        pet.setRoyalty(stranger, 100);
        vm.stopPrank();

        // The 5% royalty is still intact and readable after the lock.
        (address recv, uint256 amount) = pet.royaltyInfo(1, 1 ether);
        assertEq(recv, royaltyRecipient);
        assertEq(amount, 0.05 ether);
    }

    function test_LockRoyalty_OnlyOwner() public {
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, stranger));
        vm.prank(stranger);
        pet.lockRoyalty();
    }

    function test_Constructor_RejectsZeroRoyaltyRecipient() public {
        vm.expectRevert(abi.encodeWithSelector(ERC2981.ERC2981InvalidDefaultRoyaltyReceiver.selector, address(0)));
        new Pet721("W", "W", 10, owner, address(0), "");
    }

    function test_SetRoyalty_RejectsTooHighBps() public {
        vm.expectRevert(
            abi.encodeWithSelector(ERC2981.ERC2981InvalidDefaultRoyalty.selector, uint256(10_001), uint256(10_000))
        );
        vm.prank(owner);
        pet.setRoyalty(royaltyRecipient, 10_001);
    }
}

// ================================================================================================
// DEATH-SOULBOUND: a DEAD (life timer lapsed) pet is permanently non-transferable; mint is OK.
// ================================================================================================
contract Pet721DeathSoulboundTest is Pet721v2Base {
    function test_Mint_AlwaysAllowed() public {
        (uint256 id, address tba) = _issue(player);
        assertEq(pet.ownerOf(id), player);
        assertEq(WalletchiAccount(payable(tba)).owner(), player, "6551 owner read intact after mint");
    }

    function test_Transfer_AliveOK() public {
        (uint256 id,) = _issue(player);
        vm.prank(player);
        pet.transferFrom(player, buyer, id);
        assertEq(pet.ownerOf(id), buyer);
    }

    function test_Transfer_DeadReverts() public {
        (uint256 id,) = _issue(player);
        _issue(stranger); // second pet so the season stays interesting; not required
        _kill(id);
        assertTrue(pet.isDead(id), "life timer lapsed == dead");
        assertFalse(vault.alive(id), "dead == not alive (single time-based definition)");

        vm.expectRevert(abi.encodeWithSelector(Pet721.PetIsDead.selector, id));
        vm.prank(player);
        pet.transferFrom(player, buyer, id);
        assertEq(pet.ownerOf(id), player, "dead pet stays with its owner (memorial)");
    }

    function test_Transfer_DeadReverts_EvenViaOperator() public {
        (uint256 id,) = _issue(player);
        _issue(stranger);
        vm.prank(player);
        pet.setApprovalForAll(marketplace, true);
        _kill(id);

        vm.expectRevert(abi.encodeWithSelector(Pet721.PetIsDead.selector, id));
        vm.prank(marketplace);
        pet.transferFrom(player, buyer, id);
    }

    function test_Transfer_DoesNotResetLifeTimer() public {
        (uint256 id,) = _issue(player);
        vm.warp(block.timestamp + CARE_COOLDOWN);
        vm.prank(player); // owner-only care
        vault.care(id, 0);
        (, uint64 lastBefore,) = vault.lifeState(id);

        vm.prank(player);
        pet.transferFrom(player, buyer, id);

        (, uint64 lastAfter,) = vault.lifeState(id);
        assertEq(lastAfter, lastBefore, "transfer must not touch the survival timer");
    }

    function test_Transfer_6551OwnerFollowsNft() public {
        (uint256 id, address tba) = _issue(player);
        assertEq(WalletchiAccount(payable(tba)).owner(), player);
        vm.prank(player);
        pet.transferFrom(player, buyer, id);
        assertEq(WalletchiAccount(payable(tba)).owner(), buyer, "6551 owner follows the NFT after sale");
    }

    function test_Transfer_ToOwn6551AccountReverts() public {
        (uint256 id, address tba) = _issue(player);
        vm.expectRevert(abi.encodeWithSelector(Pet721.OwnTokenBoundAccount.selector, id, tba));
        vm.prank(player);
        pet.transferFrom(player, tba, id);
        assertEq(pet.ownerOf(id), player, "self-owned account cycle was not created");
        assertEq(WalletchiAccount(payable(tba)).owner(), player, "TBA remains controlled by the player");
    }

    function test_Mint_DirectlyToOwn6551AccountReverts() public {
        uint256 nextId = pet.totalMinted() + 1;
        address predictedTba = issuer.accountOf(nextId);
        vm.expectRevert(abi.encodeWithSelector(Pet721.OwnTokenBoundAccount.selector, nextId, predictedTba));
        vm.prank(relayer);
        issuer.issuePet(predictedTba);
        assertEq(pet.totalMinted(), 0, "failed self-owning mint consumes no token id");
    }

    function test_Transfer_ToAnotherPets6551AccountReverts() public {
        (uint256 first, address firstTba) = _issue(player);
        (uint256 second, address secondTba) = _issue(player);

        vm.expectRevert(abi.encodeWithSelector(Pet721.PetAccountRecipient.selector, first, secondTba));
        vm.prank(player);
        pet.transferFrom(player, secondTba, first);

        vm.expectRevert(abi.encodeWithSelector(Pet721.PetAccountRecipient.selector, second, firstTba));
        vm.prank(player);
        pet.transferFrom(player, firstTba, second);

        assertEq(pet.ownerOf(first), player, "first pet stays under EOA control");
        assertEq(pet.ownerOf(second), player, "second pet stays under EOA control");
    }

    function test_Mint_DirectlyToExistingPetAccountReverts() public {
        (, address existingTba) = _issue(player);
        uint256 nextId = pet.totalMinted() + 1;
        vm.expectRevert(abi.encodeWithSelector(Pet721.PetAccountRecipient.selector, nextId, existingTba));
        vm.prank(relayer);
        issuer.issuePet(existingTba);
        assertEq(pet.totalMinted(), nextId - 1, "failed nested mint consumes no token id");
    }

    function test_PayoutAddress_OnlyOwnerAndTransferClearsItPermanently() public {
        (uint256 id, address tba) = _issue(player);
        address recovery = makeAddr("recovery");

        vm.expectRevert(abi.encodeWithSelector(Pet721.NotTokenOwner.selector, id, stranger));
        vm.prank(stranger);
        pet.setPayoutAddress(id, recovery);

        vm.prank(player);
        pet.setPayoutAddress(id, recovery);
        assertEq(pet.payoutAddress(id, tba), recovery);
        assertEq(pet.payoutAddressOverride(id), recovery);

        vm.prank(player);
        pet.transferFrom(player, buyer, id);
        assertEq(pet.payoutAddressOverride(id), address(0), "seller redirect cleared on transfer");
        assertEq(pet.payoutAddress(id, tba), tba, "buyer defaults to the pet account");

        // Even a round trip to the same address cannot revive the old seller preference.
        vm.prank(buyer);
        pet.transferFrom(buyer, player, id);
        assertEq(pet.payoutAddress(id, tba), tba);
    }

    function test_IsDead_FalseWhenNoVaultWired() public {
        Pet721 lone = new Pet721("W", "W", 10, owner, royaltyRecipient, "");
        assertFalse(lone.isDead(1), "no vault wired => never dead => freely transferable");
    }
}

// ================================================================================================
// ERC-721C: permissive by default; owner can tighten to an operator allowlist; mint bypasses policy.
// ================================================================================================
contract Pet721CreatorTokenTest is Pet721v2Base {
    WalletchiTransferValidator internal validator;

    function setUp2() internal {
        validator = new WalletchiTransferValidator(owner);
    }

    function test_Permissive_ByDefault_TransfersWork() public {
        // No validator wired: fully permissive.
        assertEq(pet.getTransferValidator(), address(0));
        (uint256 id,) = _issue(player);
        vm.prank(player);
        pet.setApprovalForAll(marketplace, true);
        vm.prank(marketplace); // an arbitrary operator can move it (nothing is enforced yet)
        pet.transferFrom(player, buyer, id);
        assertEq(pet.ownerOf(id), buyer);
    }

    function test_ValidatorWiring_SetGetAndFunction() public {
        setUp2();
        vm.expectEmit(true, true, true, true, address(pet));
        emit ICreatorToken.TransferValidatorUpdated(address(0), address(validator));
        vm.prank(owner);
        pet.setTransferValidator(address(validator));
        assertEq(pet.getTransferValidator(), address(validator));

        (bytes4 sig, bool isView) = pet.getTransferValidationFunction();
        assertEq(sig, ITransferValidator.validateTransfer.selector, "classic 721-C validate selector");
        assertTrue(isView, "validation function is a view (STATICCALL safe)");
    }

    function test_SetTransferValidator_OnlyOwner() public {
        setUp2();
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, stranger));
        vm.prank(stranger);
        pet.setTransferValidator(address(validator));
    }

    function test_Strict_BlocksNonAllowlistedOperatorButAllowsOwnerAndAllowlisted() public {
        setUp2();
        vm.startPrank(owner);
        pet.setTransferValidator(address(validator));
        validator.setSecurityLevel(address(pet), WalletchiTransferValidator.SecurityLevel.OperatorAllowlist);
        vm.stopPrank();

        (uint256 id,) = _issue(player);

        // 1. Owner-direct transfer (caller == from) always allowed, even in strict mode.
        vm.prank(player);
        pet.transferFrom(player, buyer, id);
        assertEq(pet.ownerOf(id), buyer);

        // 2. A non-allowlisted operator is blocked by the validator.
        vm.prank(buyer);
        pet.setApprovalForAll(marketplace, true);
        vm.expectRevert(
            abi.encodeWithSelector(WalletchiTransferValidator.OperatorNotAllowed.selector, address(pet), marketplace)
        );
        vm.prank(marketplace);
        pet.transferFrom(buyer, stranger, id);

        // 3. Allowlist the operator (e.g. the Seaport conduit): the transfer now goes through.
        vm.prank(owner);
        validator.setOperatorAllowed(address(pet), marketplace, true);
        vm.prank(marketplace);
        pet.transferFrom(buyer, stranger, id);
        assertEq(pet.ownerOf(id), stranger);
    }

    function test_Strict_MintStillBypassesPolicy() public {
        setUp2();
        vm.startPrank(owner);
        pet.setTransferValidator(address(validator));
        // Strictest posture with NO operator allowlisted at all.
        validator.setSecurityLevel(address(pet), WalletchiTransferValidator.SecurityLevel.OperatorAllowlist);
        vm.stopPrank();

        // Mint (from == address(0)) is not an owner-to-owner move, so the validator is never consulted.
        (uint256 id, address tba) = _issue(player);
        assertEq(pet.ownerOf(id), player, "mint bypasses the transfer policy");
        assertEq(WalletchiAccount(payable(tba)).owner(), player);
    }

    /// Validator lockability (prior design L-1): the lock is one-way and freezes the policy forever.
    function test_LockValidator_OneWay_SetRevertsAfterLock() public {
        setUp2();
        vm.startPrank(owner);
        pet.setTransferValidator(address(validator));
        assertFalse(pet.validatorLocked());

        vm.expectEmit(true, true, true, true, address(pet));
        emit Pet721.ValidatorLocked();
        pet.lockValidator();
        assertTrue(pet.validatorLocked());
        assertTrue(validator.policyLocked(address(pet)), "the behavior behind the pointer is frozen too");

        // Locked: the validator can never be repointed, not even cleared back to permissive.
        vm.expectRevert(Pet721.ValidatorIsLocked.selector);
        pet.setTransferValidator(address(0));
        vm.expectRevert(Pet721.ValidatorIsLocked.selector);
        pet.setTransferValidator(address(validator));
        vm.expectRevert(Pet721.ValidatorIsLocked.selector);
        pet.lockValidator();

        // The validator owner cannot silently weaken or mutate the locked collection policy.
        vm.expectRevert(abi.encodeWithSelector(WalletchiTransferValidator.PolicyIsLocked.selector, address(pet)));
        validator.setSecurityLevel(address(pet), WalletchiTransferValidator.SecurityLevel.OperatorAllowlist);
        vm.expectRevert(abi.encodeWithSelector(WalletchiTransferValidator.PolicyIsLocked.selector, address(pet)));
        validator.setOperatorAllowed(address(pet), marketplace, true);
        vm.stopPrank();
        assertEq(pet.getTransferValidator(), address(validator), "validator frozen");
    }

    function test_LockValidator_RejectsAddressWithoutPolicyLockSupport() public {
        address addressOnlyValidator = makeAddr("addressOnlyValidator");
        vm.startPrank(owner);
        pet.setTransferValidator(addressOnlyValidator);
        vm.expectRevert(Pet721.ValidatorPolicyLockFailed.selector);
        pet.lockValidator();
        vm.stopPrank();

        assertFalse(pet.validatorLocked(), "failed behavior lock cannot leave a misleading lock flag");
        assertEq(pet.getTransferValidator(), addressOnlyValidator);
    }

    /// Locking with the validator UNSET is legal: it makes the permissive policy permanent.
    function test_LockValidator_PermissiveForever() public {
        assertEq(pet.getTransferValidator(), address(0));
        vm.prank(owner);
        pet.lockValidator();

        setUp2();
        vm.expectRevert(Pet721.ValidatorIsLocked.selector);
        vm.prank(owner);
        pet.setTransferValidator(address(validator));

        // Transfers stay unrestricted forever.
        (uint256 id,) = _issue(player);
        vm.prank(player);
        pet.transferFrom(player, buyer, id);
        assertEq(pet.ownerOf(id), buyer);
    }

    function test_LockValidator_OnlyOwner() public {
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, stranger));
        vm.prank(stranger);
        pet.lockValidator();
    }

    function test_Strict_DeathStillBlocksEvenIfPolicyWouldAllow() public {
        setUp2();
        vm.startPrank(owner);
        pet.setTransferValidator(address(validator));
        validator.setSecurityLevel(address(pet), WalletchiTransferValidator.SecurityLevel.OperatorAllowlist);
        vm.stopPrank();

        (uint256 id,) = _issue(player);
        _issue(stranger);
        _kill(id);

        // Owner-direct transfer would pass the validator (caller == from), but death-soulbound wins.
        vm.expectRevert(abi.encodeWithSelector(Pet721.PetIsDead.selector, id));
        vm.prank(player);
        pet.transferFrom(player, buyer, id);
    }
}

// ================================================================================================
// Vault reference (death oracle) wiring: set once, one-way lockable.
// ================================================================================================
contract Pet721VaultRefTest is Pet721v2Base {
    function test_SetVaultRef_OnlyOwner() public {
        Pet721 fresh = new Pet721("W", "W", 10, owner, royaltyRecipient, "");
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, stranger));
        vm.prank(stranger);
        fresh.setVaultRef(address(vault));
    }

    function test_SetVaultRef_RejectsZero() public {
        Pet721 fresh = new Pet721("W", "W", 10, owner, royaltyRecipient, "");
        vm.expectRevert(Pet721.ZeroAddress.selector);
        vm.prank(owner);
        fresh.setVaultRef(address(0));
    }

    function test_LockVaultRef_FreezesRepoint() public {
        vm.startPrank(owner);
        pet.lockVaultRef();
        assertTrue(pet.vaultRefLocked());
        vm.expectRevert(Pet721.VaultRefIsLocked.selector);
        pet.setVaultRef(makeAddr("evilVault"));
        vm.stopPrank();
    }

    function test_LockVaultRef_RevertsIfUnset() public {
        Pet721 fresh = new Pet721("W", "W", 10, owner, royaltyRecipient, "");
        vm.expectRevert(Pet721.VaultRefUnset.selector);
        vm.prank(owner);
        fresh.lockVaultRef();
    }

    function test_LockVaultRef_OnlyOwner() public {
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, stranger));
        vm.prank(stranger);
        pet.lockVaultRef();
    }
}

// ================================================================================================
// ERC-165 introspection: ERC-721, ERC-721 Metadata, ERC-2981, ERC-721C, ERC-165 all advertised.
// ================================================================================================
contract Pet721InterfaceTest is Pet721v2Base {
    function test_SupportsInterface() public view {
        assertTrue(pet.supportsInterface(type(IERC165).interfaceId), "ERC165");
        assertTrue(pet.supportsInterface(type(IERC721).interfaceId), "ERC721");
        assertTrue(pet.supportsInterface(type(IERC2981).interfaceId), "ERC2981 royalties");
        assertTrue(pet.supportsInterface(type(ICreatorToken).interfaceId), "ERC721C creator token");
        assertFalse(pet.supportsInterface(0xffffffff), "sanity: unknown interface");
    }
}

// ================================================================================================
// ERC-7572 collection metadata: contractURI() from a constructor param, owner-updatable, event-emitting.
// ================================================================================================

contract Pet721CollectionMetadataTest is Pet721v2Base {
    function test_ContractURI_InitialFromConstructor() public {
        Pet721 fresh = new Pet721("W", "W", 10, owner, royaltyRecipient, "https://x/collection.json");
        assertEq(fresh.contractURI(), "https://x/collection.json", "initial URI from the constructor param");
    }

    function test_ContractURI_EmptyByDefault() public view {
        assertEq(pet.contractURI(), "", "base fixture deploys with an empty collection URI");
    }

    function test_Constructor_EmitsContractURIUpdated() public {
        vm.expectEmit(false, false, false, false);
        emit Pet721.ContractURIUpdated();
        new Pet721("W", "W", 10, owner, royaltyRecipient, "ipfs://seed");
    }

    function test_SetContractURI_UpdatesAndEmits() public {
        vm.expectEmit(false, false, false, false, address(pet));
        emit Pet721.ContractURIUpdated();
        vm.prank(owner);
        pet.setContractURI("https://api.playwalletchi.com/api/collection.json");
        assertEq(pet.contractURI(), "https://api.playwalletchi.com/api/collection.json");
    }

    function test_SetContractURI_OnlyOwner() public {
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, stranger));
        vm.prank(stranger);
        pet.setContractURI("https://evil/collection.json");
    }

    /// Metadata-only: there is deliberately no lock, so the owner can keep updating it.
    function test_SetContractURI_NotLockedRepeatable() public {
        vm.startPrank(owner);
        pet.setContractURI("v1");
        pet.setContractURI("v2");
        vm.stopPrank();
        assertEq(pet.contractURI(), "v2", "collection URI stays owner-updatable");
    }
}
