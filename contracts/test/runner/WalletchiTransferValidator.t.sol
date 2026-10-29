// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";

import {WalletchiTransferValidator} from "../../src/runner/WalletchiTransferValidator.sol";

/// @dev Direct unit tests of the standalone ERC-721C validator: access control on the config surface,
///      the two policy levels, and per-collection isolation (the policy keys on the CALLING token).
contract WalletchiTransferValidatorTest is Test {
    WalletchiTransferValidator internal validator;

    address internal owner = makeAddr("owner");
    address internal stranger = makeAddr("stranger");
    address internal collectionA = makeAddr("collectionA");
    address internal collectionB = makeAddr("collectionB");
    address internal seller = makeAddr("seller");
    address internal operator = makeAddr("operator");

    function setUp() public {
        validator = new WalletchiTransferValidator(owner);
    }

    function test_DefaultPolicyIsPermissive() public view {
        assertEq(uint256(validator.securityLevelOf(collectionA)), 0, "default level 0 = permissive");
    }

    function test_Permissive_AllowsAnyOperator() public {
        // msg.sender is collectionA; permissive => never reverts, whoever the caller is.
        vm.prank(collectionA);
        validator.validateTransfer(operator, seller, makeAddr("to")); // does not revert
    }

    function test_SetSecurityLevel_OnlyOwner() public {
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, stranger));
        vm.prank(stranger);
        validator.setSecurityLevel(collectionA, WalletchiTransferValidator.SecurityLevel.OperatorAllowlist);
    }

    function test_SetOperatorAllowed_OnlyOwner() public {
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, stranger));
        vm.prank(stranger);
        validator.setOperatorAllowed(collectionA, operator, true);
    }

    function test_ConfigRejectsZeroAddresses() public {
        vm.startPrank(owner);
        vm.expectRevert(WalletchiTransferValidator.ZeroAddress.selector);
        validator.setSecurityLevel(address(0), WalletchiTransferValidator.SecurityLevel.OperatorAllowlist);
        vm.expectRevert(WalletchiTransferValidator.ZeroAddress.selector);
        validator.setOperatorAllowed(address(0), operator, true);
        vm.expectRevert(WalletchiTransferValidator.ZeroAddress.selector);
        validator.setOperatorAllowed(collectionA, address(0), true);
        vm.stopPrank();
    }

    function test_LockPolicy_FreezesLevelAndAllowlist() public {
        vm.startPrank(owner);
        validator.setSecurityLevel(collectionA, WalletchiTransferValidator.SecurityLevel.OperatorAllowlist);
        validator.setOperatorAllowed(collectionA, operator, true);
        validator.lockPolicy(collectionA);
        vm.stopPrank();

        assertTrue(validator.policyLocked(collectionA));
        vm.startPrank(owner);
        vm.expectRevert(abi.encodeWithSelector(WalletchiTransferValidator.PolicyIsLocked.selector, collectionA));
        validator.setSecurityLevel(collectionA, WalletchiTransferValidator.SecurityLevel.Permissive);
        vm.expectRevert(abi.encodeWithSelector(WalletchiTransferValidator.PolicyIsLocked.selector, collectionA));
        validator.setOperatorAllowed(collectionA, operator, false);
        vm.stopPrank();

        assertEq(
            uint256(validator.securityLevelOf(collectionA)),
            uint256(WalletchiTransferValidator.SecurityLevel.OperatorAllowlist)
        );
        assertTrue(validator.isOperatorAllowed(collectionA, operator));
    }

    function test_CollectionMayLockOnlyItsOwnPolicy() public {
        vm.prank(collectionA);
        validator.lockPolicy(collectionA);
        assertTrue(validator.policyLocked(collectionA), "collection can make its policy permanent");

        vm.expectRevert(
            abi.encodeWithSelector(WalletchiTransferValidator.UnauthorizedPolicyLocker.selector, stranger, collectionB)
        );
        vm.prank(stranger);
        validator.lockPolicy(collectionB);
        assertFalse(validator.policyLocked(collectionB));
    }

    function test_Allowlist_OwnerDirectAlwaysAllowed() public {
        vm.prank(owner);
        validator.setSecurityLevel(collectionA, WalletchiTransferValidator.SecurityLevel.OperatorAllowlist);
        // caller == from: the seller is moving their own token. Always allowed.
        vm.prank(collectionA);
        validator.validateTransfer(seller, seller, makeAddr("to"));
    }

    function test_Allowlist_BlocksUnlistedOperator() public {
        vm.prank(owner);
        validator.setSecurityLevel(collectionA, WalletchiTransferValidator.SecurityLevel.OperatorAllowlist);
        vm.expectRevert(
            abi.encodeWithSelector(WalletchiTransferValidator.OperatorNotAllowed.selector, collectionA, operator)
        );
        vm.prank(collectionA);
        validator.validateTransfer(operator, seller, makeAddr("to"));
    }

    function test_Allowlist_PassesListedOperator() public {
        vm.startPrank(owner);
        validator.setSecurityLevel(collectionA, WalletchiTransferValidator.SecurityLevel.OperatorAllowlist);
        validator.setOperatorAllowed(collectionA, operator, true);
        vm.stopPrank();
        vm.prank(collectionA);
        validator.validateTransfer(operator, seller, makeAddr("to")); // allowed
    }

    /// The policy is scoped per calling collection: tightening A must not affect B, and A's allowlist
    /// must not leak to B.
    function test_PolicyIsPerCollection() public {
        vm.startPrank(owner);
        validator.setSecurityLevel(collectionA, WalletchiTransferValidator.SecurityLevel.OperatorAllowlist);
        validator.setOperatorAllowed(collectionA, operator, true);
        vm.stopPrank();

        // collectionB is still permissive: the same operator passes with no allowlist entry.
        vm.prank(collectionB);
        validator.validateTransfer(operator, seller, makeAddr("to"));

        // A's allowlist does not apply to B once B is tightened.
        vm.prank(owner);
        validator.setSecurityLevel(collectionB, WalletchiTransferValidator.SecurityLevel.OperatorAllowlist);
        vm.expectRevert(
            abi.encodeWithSelector(WalletchiTransferValidator.OperatorNotAllowed.selector, collectionB, operator)
        );
        vm.prank(collectionB);
        validator.validateTransfer(operator, seller, makeAddr("to"));
    }
}
