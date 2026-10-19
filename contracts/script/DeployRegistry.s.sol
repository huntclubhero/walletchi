// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Script, console} from "forge-std/Script.sol";

/// @title DeployRegistry
/// @notice Ensures the canonical ERC-6551 registry exists on the target chain.
///         If it is already present (as it is on Robinhood Chain mainnet AND testnet, verified
///         2026-07-24), this is a no-op. Otherwise it deploys the registry through Nick's
///         deterministic-deployment factory using the exact vendored creation bytecode, which is
///         checked against the canonical address before any broadcast (revert on mismatch).
///
///         The creation bytecode below was reconstructed from the on-chain registry runtime
///         (solc 0.8.17, optimizer 200) and VERIFIED: CREATE2(factory, salt, keccak(code)) yields
///         0x000000006551c19487814612e58FE06813775758. See the RegistryBytecode test.
contract DeployRegistry is Script {
    address public constant CANONICAL_REGISTRY = 0x000000006551c19487814612e58FE06813775758;
    address public constant NICKS_FACTORY = 0x4e59b44847b379578588920cA78FbF26c0B4956C;
    bytes32 public constant REGISTRY_SALT =
        0x0000000000000000000000000000000000000000fd8eb4e1dca713016c518e31;

    /// @dev Exact canonical ERC-6551 v0.3.1 registry creation code.
    bytes public constant REGISTRY_CREATION_CODE =
        hex"608060405234801561001057600080fd5b5061023b806100206000396000f3fe608060405234801561001057600080fd5b50600436106100365760003560e01c8063246a00211461003b5780638a54c52f1461006a575b600080fd5b61004e6100493660046101b7565b61007d565b6040516001600160a01b03909116815260200160405180910390f35b61004e6100783660046101b7565b6100e1565b600060806024608c376e5af43d82803e903d91602b57fd5bf3606c5285605d52733d60ad80600a3d3981f3363d3d373d3d3d363d7360495260ff60005360b76055206035523060601b60015284601552605560002060601b60601c60005260206000f35b600060806024608c376e5af43d82803e903d91602b57fd5bf3606c5285605d52733d60ad80600a3d3981f3363d3d373d3d3d363d7360495260ff60005360b76055206035523060601b600152846015526055600020803b61018b578560b760556000f580610157576320188a596000526004601cfd5b80606c52508284887f79f19b3655ee38b1ce526556b7731a20c8f218fbda4a3990b6cc4172fdf887226060606ca46020606cf35b8060601b60601c60005260206000f35b80356001600160a01b03811681146101b257600080fd5b919050565b600080600080600060a086880312156101cf57600080fd5b6101d88661019b565b945060208601359350604086013592506101f46060870161019b565b94979396509194608001359291505056fea2646970667358221220ea2fe53af507453c64dd7c1db05549fa47a298dfb825d6d11e1689856135f16764736f6c63430008110033";

    /// @notice The CREATE2 address the vendored creation code deploys to through Nick's factory.
    function computedRegistryAddress() public pure returns (address) {
        bytes32 hash = keccak256(
            abi.encodePacked(
                bytes1(0xff), NICKS_FACTORY, REGISTRY_SALT, keccak256(REGISTRY_CREATION_CODE)
            )
        );
        return address(uint160(uint256(hash)));
    }

    function run() external {
        // Safety gate: the vendored bytecode MUST reproduce the canonical address, or we abort.
        require(computedRegistryAddress() == CANONICAL_REGISTRY, "registry bytecode mismatch");

        if (CANONICAL_REGISTRY.code.length > 0) {
            console.log("ERC-6551 registry already present, nothing to do:", CANONICAL_REGISTRY);
            return;
        }

        require(NICKS_FACTORY.code.length > 0, "Nick's factory absent on this chain");

        console.log("Deploying ERC-6551 registry via Nick's factory...");
        vm.startBroadcast();
        (bool ok,) = NICKS_FACTORY.call(abi.encodePacked(REGISTRY_SALT, REGISTRY_CREATION_CODE));
        require(ok, "registry deploy failed");
        vm.stopBroadcast();

        require(CANONICAL_REGISTRY.code.length > 0, "registry not deployed to canonical address");
        console.log("Deployed ERC-6551 registry at", CANONICAL_REGISTRY);
    }
}
