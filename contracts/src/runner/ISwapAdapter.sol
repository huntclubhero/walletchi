// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

/// @title ISwapAdapter
/// @notice The seam the CareFeeSplitter uses to convert the player half of the fee stream (USDG) into
///         CARE before distributing, so player rewards are denominated in the same immutable-priced
///         token players spend (econ audit headline fix). Pluggable on purpose: a MockSwapAdapter
///         (fixed rate) rehearses the whole pipeline on testnet where no real CARE/USDG pool exists,
///         and a real Uniswap-router adapter is wired on mainnet. The splitter approves the adapter
///         for exactly the input amount and calls swap(); the adapter must send at least `minOut`
///         of `tokenOut` to `to` or revert (slippage guard lives in the caller-provided minOut).
interface ISwapAdapter {
    /// @param tokenIn the token being sold (USDG)
    /// @param tokenOut the token being bought (CARE)
    /// @param amountIn exact input amount (the splitter has approved this much)
    /// @param minOut minimum acceptable output; the adapter MUST revert if it cannot meet it
    /// @param to recipient of tokenOut
    /// @return amountOut the amount of tokenOut delivered to `to`
    function swap(IERC20 tokenIn, IERC20 tokenOut, uint256 amountIn, uint256 minOut, address to)
        external
        returns (uint256 amountOut);
}
