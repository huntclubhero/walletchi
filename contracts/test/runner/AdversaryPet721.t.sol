// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

// ADVERSARY / BREAK-IT suite for Pet721 v2 (Phase S). Not for commit. Each test tries HARD to defeat
// one of the flagged risks; a PASS means the attack failed (the contract held). Where an attack is
// expected to be neutralized, the test asserts the neutralization (revert / no-op / unchanged state).

import {Test} from "forge-std/Test.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {IERC721} from "@openzeppelin/contracts/token/ERC721/IERC721.sol";
import {IERC721Receiver} from "@openzeppelin/contracts/token/ERC721/IERC721Receiver.sol";

import {ERC6551Registry} from "erc6551/ERC6551Registry.sol";
import {IERC6551Registry} from "erc6551/interfaces/IERC6551Registry.sol";

import {WalletchiAccount} from "../../src/WalletchiAccount.sol";
import {Pet721, ICreatorToken, ITransferValidator} from "../../src/runner/Pet721.sol";
import {PetIssuer} from "../../src/runner/PetIssuer.sol";
import {PetVault, IPetCareSpender} from "../../src/runner/PetVault.sol";
import {MockCareToken} from "../../src/runner/MockCareToken.sol";
import {WalletchiTransferValidator} from "../../src/runner/WalletchiTransferValidator.sol";

// A validator that TRIES to mutate its own state and TRIES to reenter the calling token on every
// validate. Because Pet721 calls validateTransfer through a STATICCALL (the interface fn is `view`),
// both the SSTORE and the reentrant transferFrom must fail, so the whole transfer reverts. This proves
// a hostile validator can only BLOCK a transfer, never corrupt or steal.
contract MutatingValidator {
    uint256 public poked;
    address public target;

    function setTarget(address t) external {
        target = t;
    }

    // Same selector as ITransferValidator.validateTransfer but a MUTATING body. Pet721 still calls it
    // through a STATICCALL (its own interface types the fn as `view`), so the SSTORE + reentry attempt
    // revert at runtime and the transfer is blocked. Not declared `view` on purpose.
    function validateTransfer(address, address from, address to) external {
        poked += 1; // SSTORE: reverts under the caller's STATICCALL
        // Also try to reenter the caller (the token) with a state-changing transfer.
        Pet721(msg.sender).transferFrom(from, to, 1);
    }
}

// A read-only reentrant validator: it STATICCALLs back into the token during validation (allowed under
// staticcall) but cannot change anything. The transfer must still complete with correct final state.
contract ReadOnlyReentrantValidator is ITransferValidator {
    function validateTransfer(address, address, address) external view {
        // Read the caller's state during the transfer. Legal (staticcall-within-staticcall), harmless.
        Pet721(msg.sender).totalMinted();
        Pet721(msg.sender).isDead(1);
    }
}

// A receiver that, on mint, tries to reenter the token: re-mint (must fail, issuer-gated) and move the
// just-minted token. Proves no double-mint and no id corruption via the ERC721 receiver hook.
contract HostileReceiver is IERC721Receiver {
    Pet721 public pet;
    bool public reentered;

    function set(Pet721 p) external {
        pet = p;
    }

    function onERC721Received(address, address, uint256 tokenId, bytes calldata) external returns (bytes4) {
        if (!reentered) {
            reentered = true;
            // Attempt a re-mint: must revert NotIssuer (we are not the issuer). Swallow it.
            try pet.mint(address(this)) {} catch {}
            // Move the token we just received; we are its owner, alive, so this legitimately succeeds.
            try pet.transferFrom(address(this), address(0xBEEF), tokenId) {} catch {}
        }
        return IERC721Receiver.onERC721Received.selector;
    }
}

abstract contract AdversaryBase is Test {
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
    address internal royalty = makeAddr("royalty");

    uint256 internal constant LIFE_TTL = 1 days;
    uint256 internal constant CARE_COST = 1e18;
    uint256 internal constant COOLDOWN = 1 hours;

    function setUp() public {
        registry = new ERC6551Registry();
        accountImpl = new WalletchiAccount();
        care = new MockCareToken();
        pet = new Pet721("WALLETCHI", "WCHI", 2000, owner, royalty, "");
        issuer = new PetIssuer(
            pet,
            IERC6551Registry(address(registry)),
            address(accountImpl),
            IERC20(address(care)),
            relayer,
            owner,
            1e18,
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
                careCooldown: COOLDOWN,
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
        care.mint(address(issuer), 1_000_000e18);
    }

    function _issue(address to) internal returns (uint256 id, address tba) {
        vm.prank(relayer);
        (id, tba) = issuer.issuePet(to);
    }

    /// @dev Kill a pet the only way the model allows: HATCH it first (death needs careCount > 0; a
    ///      never-fed egg has no life timer, audit death-F1) then let its life timer lapse
    ///      (time-based, permanent death; there is no reap step). Care is OWNER-only (audit
    ///      access-H-1), so the hatch is pranked as the pet's current owner (which may be a TBA).
    function _kill(uint256 id) internal {
        vm.warp(block.timestamp + COOLDOWN);
        vm.prank(pet.ownerOf(id));
        vault.care(id, 0);
        vm.warp(block.timestamp + LIFE_TTL + 1);
    }
}

// ================================================================================================
// RISK 1 + 2: the validator STATICCALL cannot reenter or steal; worst case is a block.
// ================================================================================================
contract AdversaryValidatorTest is AdversaryBase {
    function test_MutatingValidator_IsNeutralizedToABlock() public {
        MutatingValidator evil = new MutatingValidator();
        evil.setTarget(address(pet));
        vm.prank(owner);
        pet.setTransferValidator(address(evil));

        (uint256 id,) = _issue(player);
        // The owner-direct transfer invokes the validator via STATICCALL; its SSTORE + reentry attempt
        // revert under staticcall, so the transfer is BLOCKED. Ownership is unchanged: no theft, no
        // reentrancy, no state change slipped through.
        vm.prank(player);
        vm.expectRevert();
        pet.transferFrom(player, buyer, id);

        assertEq(pet.ownerOf(id), player, "owner unchanged: validator could not steal or reenter");
        assertEq(evil.poked(), 0, "validator state never mutated (staticcall)");
    }

    function test_ReadOnlyReentrantValidator_TransferStillCorrect() public {
        ReadOnlyReentrantValidator ro = new ReadOnlyReentrantValidator();
        vm.prank(owner);
        pet.setTransferValidator(address(ro));

        (uint256 id,) = _issue(player);
        vm.prank(player);
        pet.transferFrom(player, buyer, id); // read-only reentry is harmless; transfer completes
        assertEq(pet.ownerOf(id), buyer, "read-only reentry did not corrupt the transfer");
    }

    // A hostile owner-set validator can only ever BLOCK. Even a validator that reverts on EVERY move
    // cannot move a pet to an attacker or change royalties. The owner keeps this power by design and
    // it is not locked, so the owner can always restore trading. Confirm block-only.
    function test_AlwaysRevertValidator_CannotStealOnlyBlocks() public {
        MutatingValidator evil = new MutatingValidator();
        vm.prank(owner);
        pet.setTransferValidator(address(evil));
        (uint256 id,) = _issue(player);

        vm.prank(player);
        vm.expectRevert();
        pet.transferFrom(player, buyer, id);
        assertEq(pet.ownerOf(id), player);

        // Owner restores trading by clearing the validator: not locked, so DoS is always recoverable.
        vm.prank(owner);
        pet.setTransferValidator(address(0));
        vm.prank(player);
        pet.transferFrom(player, buyer, id);
        assertEq(pet.ownerOf(id), buyer);
    }
}

// ================================================================================================
// RISK 3 + 4: death boundary + soulbound permanence, incl. 6551-owned pets and safeTransferFrom.
// ================================================================================================
contract AdversarySoulboundTest is AdversaryBase {
    function test_DeadPet_SafeTransferFrom_Reverts() public {
        (uint256 id,) = _issue(player);
        _issue(buyer);
        _kill(id);
        vm.expectRevert(abi.encodeWithSelector(Pet721.PetIsDead.selector, id));
        vm.prank(player);
        pet.safeTransferFrom(player, buyer, id);
    }

    // A pet may never be parked in ANOTHER pet's 6551 TBA. Allowing both
    // directions creates a circular owner() graph and permanently loses control.
    function test_PetCannotBeOwnedByAnotherPetTba() public {
        (uint256 host,) = _issue(player); // pet A, owned by player
        address hostTba = issuer.accountOf(host);
        (uint256 sub,) = _issue(player); // pet B, minted to player

        vm.expectRevert(abi.encodeWithSelector(Pet721.PetAccountRecipient.selector, sub, hostTba));
        vm.prank(player);
        pet.transferFrom(player, hostTba, sub);
        assertEq(pet.ownerOf(sub), player, "nested ownership was not created");
    }

    // There is no revive. Death is monotonic: isDead stays true forever, across warps and further
    // care attempts (which revert PetIsDead: a dead pet can never be fed back to life).
    function test_Death_IsMonotonic_NoRevivePath() public {
        (uint256 id,) = _issue(player);
        _issue(buyer);
        _kill(id);
        assertTrue(pet.isDead(id));

        // Care on a dead pet reverts even for its own owner (cannot revive to clear the state).
        vm.prank(player);
        vm.expectRevert(PetVault.PetIsDead.selector);
        vault.care(id, 0);

        vm.warp(block.timestamp + 3650 days);
        assertTrue(pet.isDead(id), "death is permanent across a decade of warps");
    }

    // Approvals do not survive as an escape: approve, then die, then the approved operator is blocked.
    function test_DeadPet_PreExistingApproval_Blocked() public {
        (uint256 id,) = _issue(player);
        _issue(buyer);
        vm.prank(player);
        pet.approve(address(this), id); // single-token approval before death
        _kill(id);
        vm.expectRevert(abi.encodeWithSelector(Pet721.PetIsDead.selector, id));
        pet.transferFrom(player, buyer, id);
    }
}

// ================================================================================================
// RISK 5: validator policy isolation cannot be poisoned cross-collection or spoofed.
// ================================================================================================
contract AdversaryPolicyIsolationTest is AdversaryBase {
    function test_ForeignCaller_CannotPoisonPetPolicy() public {
        WalletchiTransferValidator v = new WalletchiTransferValidator(owner);
        vm.startPrank(owner);
        pet.setTransferValidator(address(v));
        v.setSecurityLevel(address(pet), WalletchiTransferValidator.SecurityLevel.OperatorAllowlist);
        vm.stopPrank();

        // An attacker calls validateTransfer directly; msg.sender is the attacker's address, which keys
        // a DIFFERENT (default permissive) policy slot. It cannot make Pet721's slot permissive nor
        // allowlist itself on Pet721's slot.
        address attacker = makeAddr("attacker");
        vm.prank(attacker);
        v.validateTransfer(attacker, attacker, buyer); // hits attacker's own permissive slot, no-op

        assertEq(
            uint256(v.securityLevelOf(address(pet))),
            uint256(WalletchiTransferValidator.SecurityLevel.OperatorAllowlist),
            "pet policy untouched by foreign caller"
        );
        assertFalse(v.isOperatorAllowed(address(pet), attacker), "attacker not on pet allowlist");
    }

    // Under strict policy, an approved operator cannot masquerade as `from`. from is read from storage
    // by the token; the operator's identity is the STATICCALL caller. So caller != from and the move is
    // blocked unless allowlisted.
    function test_Operator_CannotSpoofFrom() public {
        WalletchiTransferValidator v = new WalletchiTransferValidator(owner);
        vm.startPrank(owner);
        pet.setTransferValidator(address(v));
        v.setSecurityLevel(address(pet), WalletchiTransferValidator.SecurityLevel.OperatorAllowlist);
        vm.stopPrank();

        (uint256 id,) = _issue(player);
        address operator = makeAddr("operator");
        vm.prank(player);
        pet.setApprovalForAll(operator, true);

        vm.prank(operator);
        vm.expectRevert(
            abi.encodeWithSelector(WalletchiTransferValidator.OperatorNotAllowed.selector, address(pet), operator)
        );
        pet.transferFrom(player, buyer, id);
    }
}

// ================================================================================================
// RISK 6: mint (from==0) always bypasses the validator, even under the strictest empty allowlist.
// Also proves the ERC721 receiver hook cannot double-mint or corrupt ids.
// ================================================================================================
contract AdversaryMintTest is AdversaryBase {
    function test_Mint_BypassesStrictValidator_AndHostileReceiver() public {
        // Strictest policy: a validator that reverts on EVERY owner-to-owner move.
        MutatingValidator evil = new MutatingValidator();
        vm.prank(owner);
        pet.setTransferValidator(address(evil));

        HostileReceiver rcv = new HostileReceiver();
        rcv.set(pet);

        // Mint to the hostile receiver. Mint is from==0 so the validator is NOT consulted and the mint
        // succeeds. The receiver's reentrant re-mint fails (issuer gate); its onward transfer of the
        // just-minted token would be an owner-to-owner move and is blocked by the evil validator (try/
        // catch swallows it), leaving the token with the receiver. No double-mint, ids stay sequential.
        uint256 before = pet.totalMinted();
        (uint256 id,) = _issue(address(rcv));
        assertEq(id, before + 1, "sequential id, no double-mint via receiver reentry");
        assertEq(pet.totalMinted(), before + 1, "totalMinted advanced exactly once");
        assertEq(pet.ownerOf(id), address(rcv), "mint landed despite strict validator + hostile hook");
    }
}

// ================================================================================================
// RISK 7: ERC-721C interface advertisement is correct + matches Limit Break's canonical interfaceId
// that OpenSea / Seaport 1.6 read.
// ================================================================================================
contract AdversaryInterfaceTest is AdversaryBase {
    function test_CreatorTokenInterfaceId_MatchesCanonical() public view {
        // Canonical Limit Break ICreatorToken (v2/v3) interfaceId = XOR of the three function selectors
        // getTransferValidator() ^ getTransferValidationFunction() ^ setTransferValidator(address).
        bytes4 expected = pet.getTransferValidator.selector ^ pet.getTransferValidationFunction.selector
            ^ pet.setTransferValidator.selector;
        assertEq(type(ICreatorToken).interfaceId, expected, "interfaceId is the XOR of the 3 fn selectors");
        assertTrue(pet.supportsInterface(expected), "advertised via ERC-165");
        // Sanity: the canonical value OpenSea checks for ERC-721C.
        assertEq(uint32(expected), uint32(0xad0d7f6c), "matches Limit Break canonical 0xad0d7f6c");
    }

    function test_ValidationFunction_AdvertisesViewSelector() public view {
        (bytes4 sig, bool isView) = pet.getTransferValidationFunction();
        assertEq(sig, ITransferValidator.validateTransfer.selector);
        assertTrue(isView, "advertised as view so marketplaces STATICCALL it");
    }
}
