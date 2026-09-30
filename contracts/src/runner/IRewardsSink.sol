// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @title IRewardsSink
/// @notice The care-notification hook the PetVault calls on the rewards recipient after routing the
///         rewards slice of a care fee to it. The canonical implementer is RewardsDistributor.
///
///         UNAUDITED: PENDING AUDIT WAVE. New in the WALLETCHI economy v3 (three-leg care split).
///
///         Flow: on every care(), the vault transfers the rewards slice to the recipient and then
///         calls notifyCare(tokenId, account, amount). `amount` is the slice the vault SENT (nominal,
///         pre any fee-on-transfer tax on the vault to recipient hop); the implementer is expected to
///         recognize the ACTUAL received funds by its own balance delta and treat `amount` as
///         advisory (see RewardsDistributor). When the vault runs with rewardsBps > 0 the call is
///         REQUIRED (not best-effort): a reverting hook reverts the care, so reward accounting can
///         never silently drift from the funds actually moved.
interface IRewardsSink {
    /// @param tokenId the pet that was cared for (earns one participation point this epoch)
    /// @param account the pet's ERC-6551 token bound account (the address a later claim pays into)
    /// @param amount  the rewards slice the vault SENT (advisory; the sink measures its own delta)
    function notifyCare(uint256 tokenId, address account, uint256 amount) external;
}
