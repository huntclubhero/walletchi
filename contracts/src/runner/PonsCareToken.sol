// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";

/// @title PonsCareToken
/// @notice A TESTNET stand-in that MIRRORS the shape of a token launched on the Pons launchpad
///         (pons.money, Robinhood Chain): a fixed-supply ERC-20 (18 decimals, whole supply minted
///         to the deployer at launch, no ongoing mint) with an OPTIONAL transaction tax. Pons tokens
///         are standard fixed-supply ERC-20s; some enable a reflection-style transfer tax on
///         buys/sells. This mirror lets the WALLETCHI survival economy be tested against BOTH the
///         plain case (taxBps = 0) and the taxed / fee-on-transfer case, so the 90% burn / 10% pot
///         split (which the vault computes on the balance ACTUALLY received) is proven either way.
///         TESTNET ONLY: on mainnet WALLETCHI plugs in the real Pons token by address (CARE_TOKEN_ADDRESS).
contract PonsCareToken is ERC20, Ownable {
    /// @notice Transfer tax in basis points (0 = none). Applied to every non-mint, non-burn transfer
    ///         from a non-exempt sender, sent to `taxRecipient`. A flat tax is STRICTER than a Pons
    ///         buy/sell-only tax, so if the economy survives this it survives the real token.
    uint96 public taxBps;
    address public taxRecipient;
    uint96 public constant MAX_TAX_BPS = 1000; // 10% cap, matching typical launchpad limits

    /// @notice Addresses exempt from the tax (e.g. the vault / issuer, to mirror LP/router exemptions).
    mapping(address => bool) public taxExempt;

    event TaxSet(uint96 bps, address recipient);
    event TaxExemptSet(address indexed account, bool exempt);

    /// @param initialOwner receives the ENTIRE fixed supply and controls the tax knobs.
    /// @param totalSupply_ whole-token supply in wei (e.g. 1_000_000_000 ether for 1B tokens).
    constructor(address initialOwner, uint256 totalSupply_)
        ERC20("Care", "CARE")
        Ownable(initialOwner)
    {
        taxRecipient = initialOwner;
        taxExempt[initialOwner] = true; // the deployer distributes untaxed, like a fresh launch
        _mint(initialOwner, totalSupply_);
    }

    /// @notice Owner-tunable tax, to test the plain and taxed cases. Capped at MAX_TAX_BPS.
    function setTax(uint96 bps, address recipient) external onlyOwner {
        require(bps <= MAX_TAX_BPS, "tax too high");
        require(recipient != address(0), "recipient=0");
        taxBps = bps;
        taxRecipient = recipient;
        emit TaxSet(bps, recipient);
    }

    /// @notice Exempt/unexempt an address from the transfer tax (mirror LP/router/vault exemptions).
    function setTaxExempt(address account, bool exempt) external onlyOwner {
        taxExempt[account] = exempt;
        emit TaxExemptSet(account, exempt);
    }

    /// @dev OZ v5 single hook. Skims the tax on real transfers (from != 0 && to != 0) when a tax is
    ///      set and the sender is not exempt; mint and burn are never taxed.
    function _update(address from, address to, uint256 value) internal override {
        if (from != address(0) && to != address(0) && taxBps > 0 && !taxExempt[from]) {
            uint256 fee = (value * taxBps) / 10_000;
            if (fee > 0) {
                super._update(from, taxRecipient, fee);
                value -= fee;
            }
        }
        super._update(from, to, value);
    }
}
