// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @title IPassSignal
/// @notice The WALLETCHI-internal half of the Wallet Pass Extension's freshness signal. The ERC puts
///         `PassUpdate` / `BatchPassUpdate` on the TOKEN CONTRACT, because that is the address pass
///         distributors watch. But most pass-rendered state (need timers, the champion, the pet's CARE
///         balance) changes inside PetVault and the rewards distributor, not inside Pet721. These two
///         calls let exactly those contracts ask Pet721 to emit the standard events. They move nothing
///         and grant nothing: the worst an authorized caller can do is emit a redundant event.
interface IPassSignal {
    function signalPassUpdate(uint256 tokenId) external;
    function signalBatchPassUpdate(uint256 fromTokenId, uint256 toTokenId) external;
}
