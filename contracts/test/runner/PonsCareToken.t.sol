// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {PonsCareToken} from "../../src/runner/PonsCareToken.sol";

contract PonsCareTokenTest is Test {
    PonsCareToken token;
    address owner = address(0xA11CE);
    address alice = address(0xB0B);
    address bob = address(0xCAFE);
    uint256 constant SUPPLY = 1_000_000_000 ether;

    function setUp() public {
        // The constructor mints directly to its explicit owner_ argument; deployment does not read
        // msg.sender. An unapplied one-shot prank here breaks later pranks on Foundry 1.8.
        token = new PonsCareToken(owner, SUPPLY);
    }

    function test_FixedSupplyToOwner() public view {
        assertEq(token.totalSupply(), SUPPLY);
        assertEq(token.balanceOf(owner), SUPPLY);
        assertEq(token.decimals(), 18);
        assertEq(token.symbol(), "CARE");
    }

    function test_OwnerTransferUntaxed() public {
        // Owner is tax-exempt by default (fresh-launch distribution).
        vm.prank(owner);
        token.transfer(alice, 1000 ether);
        assertEq(token.balanceOf(alice), 1000 ether);
    }

    function test_PlainTransfer_NoTaxByDefault() public {
        vm.prank(owner);
        token.transfer(alice, 1000 ether);
        vm.prank(alice);
        token.transfer(bob, 400 ether);
        assertEq(token.balanceOf(bob), 400 ether); // taxBps default 0
    }

    function test_TaxAppliesToNonExemptSender() public {
        vm.startPrank(owner);
        token.transfer(alice, 1000 ether); // alice not exempt
        token.setTax(500, owner); // 5%
        vm.stopPrank();

        vm.prank(alice);
        token.transfer(bob, 100 ether);
        // 5% of 100 = 5 to owner (taxRecipient), 95 to bob
        assertEq(token.balanceOf(bob), 95 ether);
        assertEq(token.balanceOf(owner), SUPPLY - 1000 ether + 5 ether);
    }

    function test_TaxExemptSenderPaysNoFee() public {
        vm.startPrank(owner);
        token.transfer(alice, 1000 ether);
        token.setTax(500, owner);
        token.setTaxExempt(alice, true);
        vm.stopPrank();

        vm.prank(alice);
        token.transfer(bob, 100 ether);
        assertEq(token.balanceOf(bob), 100 ether); // exempt: full amount
    }

    function test_TaxCapEnforced() public {
        vm.prank(owner);
        vm.expectRevert(bytes("tax too high"));
        token.setTax(1001, owner);
    }
}
