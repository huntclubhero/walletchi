// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";

/// @title MockUSDG
/// @notice A 6-DECIMAL, freely mintable stand-in for USDG (Global Dollar), the fee-stream + holder-
///         airdrop currency. Real USDG on Robinhood Chain is 6 decimals (verified on-chain:
///         0x5fc5360d0400a0fd4f2af552add042d716f1d168), so testnet rehearsal MUST use 6 to exercise
///         the real dust thresholds, Merkle allocations and display scale. Testnet only; refuses to
///         exist on Robinhood mainnet by any path.
contract MockUSDG is ERC20 {
    constructor() ERC20("Mock Global Dollar", "USDG") {
        require(block.chainid != 4663, "MockUSDG is testnet-only");
    }

    function decimals() public pure override returns (uint8) {
        return 6;
    }

    /// @notice Open faucet mint. MOCK ONLY: never deploy this on mainnet.
    function mint(address to, uint256 amount) external {
        _mint(to, amount);
    }
}
