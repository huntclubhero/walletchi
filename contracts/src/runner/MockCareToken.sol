// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";

/// @title MockCareToken
/// @notice An 18-decimal, freely mintable stand-in for the SURVIVAL SEASON care token. For local
///         tests and testnet only. The real season takes ANY ERC-20 by address (on mainnet a token
///         launched on Pons), injected via CARE_TOKEN_ADDRESS. Nothing here hardcodes a real token.
contract MockCareToken is ERC20 {
    constructor() ERC20("Mock Care Token", "CARE") {
        // Defense-in-depth (audit): this open-faucet token must never exist on Robinhood mainnet by
        // ANY path, not just the deploy script's guard. 4663 = Robinhood mainnet chainid.
        require(block.chainid != 4663, "MockCareToken is testnet-only");
    }

    /// @notice Open faucet mint. MOCK ONLY: never deploy this on mainnet.
    function mint(address to, uint256 amount) external {
        _mint(to, amount);
    }
}
