// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Vm} from "forge-std/Vm.sol";
import {PetVault} from "../../../src/runner/PetVault.sol";

// Shared five-needs test plumbing (free functions; there is no shared test base to hang these on).
// Under the five-needs redesign a pet is dead the instant ANY of its five needs goes unserved for a
// full lifeTtl, so any suite that keeps a pet alive across life windows must serve ALL FIVE needs
// each window, not re-send a single action. `careAll` is that ritual: it performs the five
// canonical care actions (0=FEED..4=EXPLORE) as the pet's CURRENT owner at the current timestamp,
// lifting the pet's min-need (its score) to `now`.
//
// Cooldown note: the per-need cooldown anchors on each need's last EXPLICIT care, so careAll is
// legal in a single block as long as every need's own last explicit care is at least careCooldown
// old (a hatch broadcast arms only the paying action's cooldown).
Vm constant _vm = Vm(address(uint160(uint256(keccak256("hevm cheat code")))));

/// @dev Serve all five needs of `tokenId` as its current owner (5 cares, 5 x careCost).
function careAll(PetVault vault, uint256 tokenId) {
    address petOwner = vault.pet().ownerOf(tokenId);
    for (uint8 a = 0; a < 5; a++) {
        _vm.prank(petOwner);
        vault.care(tokenId, a);
    }
}

/// @dev Serve all five needs of `tokenId` as an explicit caller (e.g. an approved carer working
///      through tied-at-min needs after a hatch, or an owner under vm.startPrank discipline).
function careAllAs(PetVault vault, uint256 tokenId, address caller) {
    for (uint8 a = 0; a < 5; a++) {
        _vm.prank(caller);
        vault.care(tokenId, a);
    }
}

/// @dev The pet's min-need stamp (its SCORE / deadline anchor), derived from needsOf. 0 for a
///      dormant egg or an unregistered id (check petState().registered first).
function minNeedOf(PetVault vault, uint256 tokenId) view returns (uint64 m) {
    uint64[5] memory n = vault.needsOf(tokenId);
    m = n[0];
    for (uint256 i = 1; i < 5; i++) {
        if (n[i] < m) m = n[i];
    }
}

/// @dev The pet's newest need stamp (the true "last acted" instant, max of needsOf).
function maxNeedOf(PetVault vault, uint256 tokenId) view returns (uint64 m) {
    uint64[5] memory n = vault.needsOf(tokenId);
    m = n[0];
    for (uint256 i = 1; i < 5; i++) {
        if (n[i] > m) m = n[i];
    }
}
