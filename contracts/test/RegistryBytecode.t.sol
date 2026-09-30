// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {IERC6551Registry} from "erc6551/interfaces/IERC6551Registry.sol";

import {DeployRegistry} from "../script/DeployRegistry.s.sol";
import {WalletchiAccount} from "../src/WalletchiAccount.sol";
import {Pet721} from "../src/runner/Pet721.sol";

/// @notice Locks in the vendored canonical ERC-6551 registry creation bytecode: it must both
///         reproduce the canonical address via Nick's factory + salt, and deploy a functional
///         registry.
contract RegistryBytecodeTest is Test {
    DeployRegistry internal script;

    function setUp() public {
        script = new DeployRegistry();
    }

    function test_ComputedAddressMatchesCanonical() public view {
        assertEq(
            script.computedRegistryAddress(),
            script.CANONICAL_REGISTRY(),
            "vendored bytecode must CREATE2 to the canonical registry address"
        );
    }

    function test_VendoredBytecodeDeploysFunctionalRegistry() public {
        bytes memory code = script.REGISTRY_CREATION_CODE();
        address deployed;
        assembly {
            deployed := create(0, add(code, 0x20), mload(code))
        }
        assertGt(deployed.code.length, 0, "registry deployed");
        assertEq(deployed.code.length, 571, "canonical registry runtime is 571 bytes");

        // Functional check: createAccount is deterministic and produces a live account.
        IERC6551Registry reg = IERC6551Registry(deployed);
        WalletchiAccount impl = new WalletchiAccount();
        Pet721 c = new Pet721("WALLETCHI", "WCHI", 10, address(this), address(this), "");

        address predicted = reg.account(address(impl), bytes32(0), block.chainid, address(c), 1);
        address created = reg.createAccount(address(impl), bytes32(0), block.chainid, address(c), 1);

        assertEq(created, predicted, "account address deterministic");
        assertGt(created.code.length, 0, "account proxy deployed");
    }
}
