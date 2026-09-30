// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {Ownable2Step} from "@openzeppelin/contracts/access/Ownable2Step.sol";

/// @title WalletchiTransferValidator
/// @notice A minimal, self-contained ERC-721C transfer validator for the WALLETCHI pet. It is the
///         enforcement target a creator token (Pet721) points at via setTransferValidator, and it
///         exposes exactly the classic `validateTransfer(address caller, address from, address to)`
///         view function OpenSea Seaport 1.6 and the token both call on every owner-to-owner move.
///
///         WHY OUR OWN validator (vs vendoring Limit Break's full CreatorTokenTransferValidator):
///         enforcement of ERC-721C is fundamentally ON-CHAIN. The token reverts a disallowed
///         transfer in its own _update hook, so ANY validator it calls enforces the policy, whether
///         or not a marketplace pre-knows the validator. Limit Break's canonical validator is worth
///         pointing at ONLY for its curated operator allowlist (so a strict policy does not brick
///         Seaport itself). While the policy is PERMISSIVE there is zero behavioral difference, and a
///         small audited validator is far safer to re-audit than a large vendored dependency tree.
///         On mainnet the operator MAY instead point Pet721 at Limit Break's canonical validator once
///         it is deployed on Robinhood Chain: the selector and semantics match.
///
///         POLICY MODEL (per collection, keyed on the calling token = msg.sender):
///         - `Permissive`: every transfer is allowed. This is the default (level 0) and the launch
///           posture, so secondary trading is never bricked.
///         - `OperatorAllowlist`: an owner-initiated transfer (caller == from) is always allowed, but
///           a transfer moved by an OPERATOR (a marketplace conduit) is allowed only if that operator
///           is on the collection's allowlist. This is the royalty-enforcing posture the operator can
///           flip to after a live OpenSea enforced-listing test.
///         - either the validator owner or the collection itself may permanently lock that
///           collection's configured level and allowlist. Pet721 invokes this when its own validator
///           pointer is locked, so "locked" freezes behavior rather than only freezing an address.
///
///         validateTransfer is `view`: it only reads policy and reverts, so the token can call it
///         through a STATICCALL, which makes the hook incapable of reentering the token.
contract WalletchiTransferValidator is Ownable2Step {
    enum SecurityLevel {
        Permissive, // 0: allow all transfers (launch default, trading never bricked)
        OperatorAllowlist // 1: owner-direct always ok; operator moves need an allowlisted caller
    }

    /// @notice The active policy for a collection (the token contract that calls validateTransfer).
    mapping(address collection => SecurityLevel) public securityLevelOf;

    /// @notice Per-collection operator allowlist consulted only under OperatorAllowlist.
    mapping(address collection => mapping(address operator => bool)) public isOperatorAllowed;

    /// @notice Once true, neither the security level nor allowlist for this collection can change.
    mapping(address collection => bool) public policyLocked;

    event SecurityLevelSet(address indexed collection, SecurityLevel level);
    event OperatorAllowed(address indexed collection, address indexed operator, bool allowed);
    event PolicyLocked(address indexed collection);

    error OperatorNotAllowed(address collection, address operator);
    error PolicyIsLocked(address collection);
    error UnauthorizedPolicyLocker(address caller, address collection);
    error ZeroAddress();

    constructor(address initialOwner) Ownable(initialOwner) {}

    /// @notice Set the transfer policy for a collection. Owner only (the WALLETCHI operator). Level 0
    ///         (Permissive) is the safe default and never bricks trading; level 1 (OperatorAllowlist)
    ///         enforces the operator allowlist.
    function setSecurityLevel(address collection, SecurityLevel level) external onlyOwner {
        if (collection == address(0)) revert ZeroAddress();
        if (policyLocked[collection]) revert PolicyIsLocked(collection);
        securityLevelOf[collection] = level;
        emit SecurityLevelSet(collection, level);
    }

    /// @notice Add or remove an operator (e.g. the Seaport conduit) from a collection's allowlist.
    function setOperatorAllowed(address collection, address operator, bool allowed) external onlyOwner {
        if (collection == address(0) || operator == address(0)) revert ZeroAddress();
        if (policyLocked[collection]) revert PolicyIsLocked(collection);
        isOperatorAllowed[collection][operator] = allowed;
        emit OperatorAllowed(collection, operator, allowed);
    }

    /// @notice Permanently freeze one collection's policy. The validator owner may lock any managed
    ///         collection, and a collection may lock only itself. The latter lets Pet721 make its
    ///         validator-address lock and policy lock atomic even when the two contracts have
    ///         different owners.
    function lockPolicy(address collection) external {
        if (collection == address(0)) revert ZeroAddress();
        if (msg.sender != owner() && msg.sender != collection) {
            revert UnauthorizedPolicyLocker(msg.sender, collection);
        }
        if (!policyLocked[collection]) {
            policyLocked[collection] = true;
            emit PolicyLocked(collection);
        }
    }

    /// @notice The ERC-721C validation hook. Called by the collection (msg.sender) on every
    ///         owner-to-owner transfer with the transfer's operator (`caller`) and endpoints. Reverts
    ///         to BLOCK the transfer, returns to ALLOW it. View, so it is safe to STATICCALL.
    /// @param caller the operator moving the token (msg.sender of the token's transfer call)
    /// @param from the current owner
    /// @param to the recipient (unused by the current policies; kept for signature compatibility)
    function validateTransfer(address caller, address from, address to) external view {
        to; // silence unused-parameter warning; retained for ERC-721C signature compatibility
        if (securityLevelOf[msg.sender] == SecurityLevel.Permissive) return;

        // OperatorAllowlist: the owner may always move their own token; an operator must be allowed.
        if (caller == from) return;
        if (!isOperatorAllowed[msg.sender][caller]) revert OperatorNotAllowed(msg.sender, caller);
    }
}
