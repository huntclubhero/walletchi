// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {ERC721} from "@openzeppelin/contracts/token/ERC721/ERC721.sol";
import {ERC1155} from "@openzeppelin/contracts/token/ERC1155/ERC1155.sol";
import {Multicall} from "@openzeppelin/contracts/utils/Multicall.sol";
import {ERC6551Registry} from "erc6551/ERC6551Registry.sol";
import {IERC6551Registry} from "erc6551/interfaces/IERC6551Registry.sol";
import {WalletchiAccount} from "../../src/WalletchiAccount.sol";
import {Pet721} from "../../src/runner/Pet721.sol";
import {PetIssuer} from "../../src/runner/PetIssuer.sol";
import {PetVault, IPetCareSpender} from "../../src/runner/PetVault.sol";
import {MockCareToken} from "../../src/runner/MockCareToken.sol";

/// @dev A collection the pet's account can hold, so the ERC-721 approval paths have a real target.
contract HeldCollection is ERC721 {
    constructor() ERC721("Held", "HELD") {}

    function mint(address to, uint256 id) external {
        _mint(to, id);
    }
}

/// @dev A token that really grants on increaseAllowance and increaseApproval (the latter is what
///      the Paxos token code behind USDG has), unlike the OpenZeppelin 5 mock, which has neither
///      function. With this token a refused call is told apart from a call that simply reverts.
contract GrantingToken is ERC20 {
    constructor() ERC20("Granting", "GRT") {}

    function mint(address to, uint256 amount) external {
        _mint(to, amount);
    }

    function increaseAllowance(address spender, uint256 added) external returns (bool) {
        _approve(msg.sender, spender, allowance(msg.sender, spender) + added);
        return true;
    }

    function increaseApproval(address spender, uint256 added) external returns (bool) {
        _approve(msg.sender, spender, allowance(msg.sender, spender) + added);
        return true;
    }
}

/// @dev An ERC-1155 the account can hold. Its setApprovalForAll shares the ERC-721 selector, so the
///      guard must treat it the same way.
contract HeldMulti is ERC1155 {
    constructor() ERC1155("") {}
}

/// @dev An ERC-20 that mixes in OpenZeppelin Multicall. multicall() delegatecalls the token to
///      itself with msg.sender preserved, so approve(seller, max) wrapped in it would set a real
///      allowance while the outer calldata's selector is multicall, not approve.
contract MulticallToken is ERC20, Multicall {
    constructor() ERC20("Multi", "MLT") {}

    function mint(address to, uint256 amount) external {
        _mint(to, amount);
    }
}

/// @notice REGRESSION: an approval granted from a pet's token bound account must not outlive the
///         sale of the pet. The allowance belongs to the account, so a seller who approved
///         themselves before selling could pull whatever the buyer's account later received.
///         execute() now refuses calls that grant an approval and still allows the ones that remove
///         one, so a buyer can clear an allowance planted earlier.
contract TbaStandingApprovalTest is Test {
    Pet721 internal pet;
    PetIssuer internal issuer;
    PetVault internal vault;
    MockCareToken internal care;
    HeldCollection internal nft;
    WalletchiAccount internal acct;
    uint256 internal petId;
    address internal owner = makeAddr("owner");
    address internal relayer = makeAddr("relayer");
    address internal seller = makeAddr("seller");
    address internal buyer = makeAddr("buyer");

    function setUp() public {
        vm.startPrank(owner);
        ERC6551Registry registry = new ERC6551Registry();
        care = new MockCareToken();
        WalletchiAccount impl = new WalletchiAccount();
        pet = new Pet721("WALLETCHI", "WCHI", 2000, owner, owner, "");
        issuer = new PetIssuer(
            pet,
            IERC6551Registry(address(registry)),
            address(impl),
            IERC20(address(care)),
            relayer,
            owner,
            1e18,
            20e18,
            100e18
        );
        vault = new PetVault(
            PetVault.Params({
                careToken: IERC20(address(care)),
                pet: pet,
                issuer: IPetCareSpender(address(issuer)),
                owner: owner,
                lifeTtl: 86400,
                careCost: 1e18,
                potBps: 1000,
                burnBps: 9000,
                rewardsBps: 0,
                rewardsRecipient: address(0),
                gasBps: 0,
                gasRecipient: address(0),
                abandonGrace: 90 days,
                minPlayers: 3,
                careCooldown: 60,
                minSeasonDuration: 86400,
                entryWindowSecs: 86400,
                selloutStartsSeason: false
            })
        );
        pet.setIssuer(address(issuer));
        issuer.setVault(address(vault));
        pet.setVaultRef(address(vault));
        pet.lockIssuer();
        issuer.lockVault();
        pet.lockVaultRef();
        vm.stopPrank();
        care.mint(address(issuer), 1_000_000e18);
        nft = new HeldCollection();

        vm.prank(relayer);
        (uint256 id, address tba) = issuer.issuePet(seller);
        petId = id;
        acct = WalletchiAccount(payable(tba));
    }

    function _exec(address who, address to, bytes memory data) internal returns (bool ok, bytes memory ret) {
        vm.prank(who);
        (ok, ret) = address(acct).call(abi.encodeCall(acct.execute, (to, 0, data, 0)));
    }

    function _isBlocked(bool ok, bytes memory ret) internal pure returns (bool) {
        return !ok && ret.length == 4 && bytes4(ret) == bytes4(keccak256("ApprovalNotAllowed()"));
    }

    /// @dev The sale itself: the seller plants an allowance, sells, and the buyer's account then
    ///      receives a top-up. The old allowance must not be able to move any of it.
    function test_SellersAllowanceCannotMoveTheBuyersFunds() public {
        _exec(seller, address(care), abi.encodeCall(IERC20.approve, (seller, type(uint256).max)));

        vm.prank(seller);
        pet.transferFrom(seller, buyer, petId);
        care.mint(address(acct), 50e18); // the buyer tops the pet up
        uint256 held = care.balanceOf(address(acct));

        vm.prank(seller);
        (bool pulled,) = address(care).call(abi.encodeCall(IERC20.transferFrom, (address(acct), seller, held)));

        assertFalse(pulled, "the old owner pulled the buyer's funds with a pre-sale allowance");
        assertEq(care.balanceOf(address(acct)), held, "the account balance is untouched");
        assertEq(care.balanceOf(seller), 0, "the seller received nothing");
    }

    function test_ExecuteRefusesToGrantAnErc20Allowance() public {
        (bool ok, bytes memory ret) = _exec(seller, address(care), abi.encodeCall(IERC20.approve, (seller, 1)));
        assertTrue(_isBlocked(ok, ret), "approve(spender, 1) must revert ApprovalNotAllowed");
        assertEq(care.allowance(address(acct), seller), 0);
    }

    function test_ExecuteRefusesIncreaseAllowance() public {
        assertEq(bytes4(keccak256("increaseAllowance(address,uint256)")), bytes4(0x39509351), "selector pinned");
        GrantingToken token = new GrantingToken();
        (bool ok, bytes memory ret) =
            _exec(seller, address(token), abi.encodeCall(token.increaseAllowance, (seller, type(uint256).max)));
        assertEq(token.allowance(address(acct), seller), 0, "no allowance may be left behind");
        assertTrue(_isBlocked(ok, ret), "increaseAllowance must revert ApprovalNotAllowed");
    }

    function test_ExecuteRefusesIncreaseApproval() public {
        assertEq(bytes4(keccak256("increaseApproval(address,uint256)")), bytes4(0xd73dd623), "selector pinned");
        GrantingToken token = new GrantingToken();
        (bool ok, bytes memory ret) =
            _exec(seller, address(token), abi.encodeCall(token.increaseApproval, (seller, type(uint256).max)));
        assertEq(token.allowance(address(acct), seller), 0, "no allowance may be left behind");
        assertTrue(_isBlocked(ok, ret), "increaseApproval must revert ApprovalNotAllowed");
    }

    function test_ExecuteRefusesOperatorApprovalForAll() public {
        nft.mint(address(acct), 7);
        (bool ok, bytes memory ret) = _exec(seller, address(nft), abi.encodeCall(nft.setApprovalForAll, (seller, true)));
        assertTrue(_isBlocked(ok, ret), "setApprovalForAll(x, true) must revert ApprovalNotAllowed");
        assertFalse(nft.isApprovedForAll(address(acct), seller));
    }

    /// @dev A token id of 0 makes an ERC-721 approve look like an ERC-20 approve of amount 0. It
    ///      must still be refused, or the seller keeps a way to pull the NFT out after the sale.
    function test_ExecuteRefusesErc721ApproveEvenForTokenIdZero() public {
        nft.mint(address(acct), 0);
        (bool ok, bytes memory ret) = _exec(seller, address(nft), abi.encodeCall(nft.approve, (seller, 0)));
        assertTrue(_isBlocked(ok, ret), "approve(seller, 0) on an ERC-721 must be refused");
        assertEq(nft.getApproved(0), address(0));
    }

    // ------------------------------------------------------------------------------------------
    // What must keep working
    // ------------------------------------------------------------------------------------------

    function test_OwnerCanStillMoveTokensAndEthOut() public {
        vm.deal(address(acct), 1 ether);
        (bool ok,) = _exec(seller, address(care), abi.encodeCall(IERC20.transfer, (seller, 100e18)));
        assertTrue(ok, "a plain transfer out is unaffected");
        assertEq(care.balanceOf(seller), 100e18);

        vm.prank(seller);
        acct.execute(buyer, 1 ether, "", 0);
        assertEq(buyer.balance, 1 ether, "a value transfer with empty calldata is unaffected");
    }

    function test_NonOwnerStillCannotExecute() public {
        (bool ok, bytes memory ret) = _exec(buyer, address(care), abi.encodeCall(IERC20.transfer, (buyer, 1)));
        assertFalse(ok);
        assertEq(bytes4(ret), WalletchiAccount.NotOwner.selector);
    }

    /// @dev An allowance that already exists (set before this guard, or by a path execute() does
    ///      not see) can be cleared by the current owner.
    function test_BuyerCanRevokeAnAllowancePlantedEarlier() public {
        vm.prank(address(acct));
        care.approve(seller, type(uint256).max);
        vm.prank(seller);
        pet.transferFrom(seller, buyer, petId);

        (bool ok,) = _exec(buyer, address(care), abi.encodeCall(IERC20.approve, (seller, 0)));
        assertTrue(ok, "approve(spender, 0) on an ERC-20 is a revocation and must pass");
        assertEq(care.allowance(address(acct), seller), 0);
    }

    function test_OwnerCanClearErc721Approvals() public {
        nft.mint(address(acct), 3);
        vm.prank(address(acct));
        nft.approve(seller, 3);
        vm.prank(address(acct));
        nft.setApprovalForAll(seller, true);

        (bool ok1,) = _exec(seller, address(nft), abi.encodeCall(nft.approve, (address(0), 3)));
        (bool ok2,) = _exec(seller, address(nft), abi.encodeCall(nft.setApprovalForAll, (seller, false)));
        assertTrue(ok1 && ok2, "clearing an ERC-721 approval must pass");
        assertEq(nft.getApproved(3), address(0));
        assertFalse(nft.isApprovedForAll(address(acct), seller));
    }

    function test_OwnerCanStillTransferHeldNftOut() public {
        nft.mint(address(acct), 9);
        (bool ok,) = _exec(seller, address(nft), abi.encodeCall(nft.transferFrom, (address(acct), seller, 9)));
        assertTrue(ok);
        assertEq(nft.ownerOf(9), seller);
    }

    // ------------------------------------------------------------------------------------------
    // Wrappers and edge shapes of the calldata
    // ------------------------------------------------------------------------------------------

    /// @dev First prove the bypass is real: called straight from the account, a multicall-wrapped
    ///      approve sets the allowance. Then prove execute() refuses the wrapper outright.
    function test_ExecuteRefusesMulticallWrappedApprove() public {
        assertEq(bytes4(keccak256("multicall(bytes[])")), bytes4(0xac9650d8), "selector pinned");
        MulticallToken token = new MulticallToken();
        token.mint(address(acct), 10e18);
        bytes[] memory inner = new bytes[](1);
        inner[0] = abi.encodeCall(IERC20.approve, (seller, type(uint256).max));

        vm.prank(address(acct));
        token.multicall(inner);
        assertEq(token.allowance(address(acct), seller), type(uint256).max, "multicall really grants");

        vm.prank(address(acct));
        token.approve(seller, 0);

        (bool ok, bytes memory ret) = _exec(seller, address(token), abi.encodeCall(token.multicall, (inner)));
        assertTrue(_isBlocked(ok, ret), "multicall([approve]) must revert ApprovalNotAllowed");
        assertEq(token.allowance(address(acct), seller), 0, "no allowance may be left behind");
    }

    /// @dev Even a multicall that carries nothing dangerous is refused: the account never needs to
    ///      multicall a token, and inspecting the inner calls would only invite the next wrapper.
    function test_ExecuteRefusesAnyMulticall() public {
        MulticallToken token = new MulticallToken();
        token.mint(address(acct), 10e18);
        bytes[] memory inner = new bytes[](1);
        inner[0] = abi.encodeCall(IERC20.transfer, (seller, 1e18));
        (bool ok, bytes memory ret) = _exec(seller, address(token), abi.encodeCall(token.multicall, (inner)));
        assertTrue(_isBlocked(ok, ret), "multicall([transfer]) is refused too");
        assertEq(token.balanceOf(address(acct)), 10e18);
    }

    /// @dev No balance is set up: the account has no onERC1155Received, so a safe mint to it is
    ///      rejected by the token. setApprovalForAll needs no balance and that is the path under test.
    function test_ExecuteRefusesErc1155OperatorApprovalAndAllowsClearingIt() public {
        HeldMulti multi = new HeldMulti();

        (bool ok, bytes memory ret) =
            _exec(seller, address(multi), abi.encodeCall(multi.setApprovalForAll, (seller, true)));
        assertTrue(_isBlocked(ok, ret), "ERC-1155 setApprovalForAll(x, true) must revert ApprovalNotAllowed");
        assertFalse(multi.isApprovedForAll(address(acct), seller));

        vm.prank(address(acct));
        multi.setApprovalForAll(seller, true);
        (bool ok2,) = _exec(seller, address(multi), abi.encodeCall(multi.setApprovalForAll, (seller, false)));
        assertTrue(ok2, "ERC-1155 setApprovalForAll(x, false) is a revocation and must pass");
        assertFalse(multi.isApprovedForAll(address(acct), seller));
    }

    /// @dev PINNED BEHAVIOUR: approve(address(0), amount) is let through by the guard, whatever the
    ///      amount. Intent: address(0) can never call transferFrom, so an allowance to it is not a
    ///      standing approval anyone can use, and the same calldata shape is the ERC-721 revocation
    ///      approve(address(0), id), which must keep working. The token decides what to do with it:
    ///      an OpenZeppelin ERC-20 reverts with its own ERC20InvalidSpender, not ApprovalNotAllowed.
    function test_ExecutePassesApproveToZeroAddressThroughToTheToken() public {
        GrantingToken token = new GrantingToken();
        token.mint(address(acct), 10e18);
        (bool ok, bytes memory ret) =
            _exec(seller, address(token), abi.encodeCall(IERC20.approve, (address(0), 7e18)));
        assertFalse(ok, "the OZ token itself rejects a zero spender");
        assertFalse(_isBlocked(ok, ret), "but the guard did not refuse it");
        assertEq(bytes4(ret), bytes4(keccak256("ERC20InvalidSpender(address)")), "the revert is the token's");
        assertEq(token.allowance(address(acct), address(0)), 0);
    }

    /// @dev Calldata shorter than a selector is not a function call and is passed through
    ///      untouched, with its value.
    function test_ExecutePassesCalldataShorterThanASelector() public {
        vm.deal(address(acct), 1 ether);
        vm.prank(seller);
        acct.execute(buyer, 0.5 ether, hex"095ea7", 0); // the first three bytes of approve's selector
        assertEq(buyer.balance, 0.5 ether, "a sub-selector payload is not an approve and goes through");
    }

    /// @dev approve calldata with its arguments cut short fails closed inside the guard (abi.decode
    ///      reverts), so no odd encoding reaches the token.
    function test_ExecuteFailsClosedOnTruncatedApproveArgs() public {
        bytes memory full = abi.encodeCall(IERC20.approve, (seller, type(uint256).max));
        bytes memory truncated = new bytes(4 + 32); // selector + spender, no amount
        for (uint256 i = 0; i < truncated.length; i++) {
            truncated[i] = full[i];
        }
        (bool ok,) = _exec(seller, address(care), truncated);
        assertFalse(ok, "approve with a missing amount must revert");
        assertEq(care.allowance(address(acct), seller), 0);

        bytes memory fullOp = abi.encodeCall(nft.setApprovalForAll, (seller, true));
        bytes memory truncatedOp = new bytes(4 + 32); // selector + operator, no flag
        for (uint256 i = 0; i < truncatedOp.length; i++) {
            truncatedOp[i] = fullOp[i];
        }
        (bool ok2,) = _exec(seller, address(nft), truncatedOp);
        assertFalse(ok2, "setApprovalForAll with a missing flag must revert");
        assertFalse(nft.isApprovedForAll(address(acct), seller));
    }

    /// @dev operation != 0 (delegatecall and friends) is refused before the approval guard runs:
    ///      the revert is InvalidOperation even when the calldata is an approve.
    function test_ExecuteRefusesNonCallOperationsBeforeTheGuard() public {
        bytes memory approveData = abi.encodeCall(IERC20.approve, (seller, type(uint256).max));
        for (uint8 op = 1; op < 4; op++) {
            vm.prank(seller);
            (bool ok, bytes memory ret) =
                address(acct).call(abi.encodeCall(acct.execute, (address(care), 0, approveData, op)));
            assertFalse(ok, "operation other than CALL must revert");
            assertEq(
                bytes4(ret), WalletchiAccount.InvalidOperation.selector, "InvalidOperation, not ApprovalNotAllowed"
            );
        }
        bytes memory transferData = abi.encodeCall(IERC20.transfer, (seller, 1));
        vm.prank(seller);
        (bool okT, bytes memory retT) =
            address(acct).call(abi.encodeCall(acct.execute, (address(care), 0, transferData, 1)));
        assertFalse(okT);
        assertEq(bytes4(retT), WalletchiAccount.InvalidOperation.selector);
        assertEq(care.allowance(address(acct), seller), 0);
    }
}
