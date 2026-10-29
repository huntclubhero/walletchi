// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {ISwapAdapter} from "./ISwapAdapter.sol";

/// @dev Testnet-only mint interface (MockCareToken / MockUSDG both expose an open faucet mint).
interface IMintable {
    function mint(address to, uint256 amount) external;
}

/// @title MockSwapAdapter
/// @notice TESTNET swap stand-in for ISwapAdapter. Pulls `amountIn` of tokenIn (approved by the
///         splitter), and mints `amountIn * rateNum / rateDen` of tokenOut to `to`. It MINTS the
///         output rather than holding a real pool, so the full fee->swap->distribute pipeline can be
///         rehearsed on testnet without seeding a CARE/USDG market. The pulled tokenIn is parked here
///         (harmless testnet dust). Enforces minOut like the real adapter so slippage-guard code paths
///         are exercised. Refuses to exist on Robinhood mainnet by any path.
contract MockSwapAdapter is ISwapAdapter {
    using SafeERC20 for IERC20;

    uint256 public immutable rateNum;
    uint256 public immutable rateDen;

    error SlippageExceeded();

    /// @param rateNum_ / rateDen_ tokenOut per tokenIn (e.g. 1/1 for a 1:1 rehearsal; decimals are the
    ///        caller's responsibility, matching a real pool's raw-unit behaviour).
    constructor(uint256 rateNum_, uint256 rateDen_) {
        require(block.chainid != 4663, "MockSwapAdapter is testnet-only");
        require(rateNum_ > 0 && rateDen_ > 0, "bad rate");
        rateNum = rateNum_;
        rateDen = rateDen_;
    }

    function swap(IERC20 tokenIn, IERC20 tokenOut, uint256 amountIn, uint256 minOut, address to)
        external
        returns (uint256 amountOut)
    {
        tokenIn.safeTransferFrom(msg.sender, address(this), amountIn);
        amountOut = (amountIn * rateNum) / rateDen;
        if (amountOut < minOut) revert SlippageExceeded();
        IMintable(address(tokenOut)).mint(to, amountOut);
    }
}
