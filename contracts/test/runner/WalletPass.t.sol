// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

// WALLET PASS EXTENSION (ERC draft, IERC721WalletPass, interface id 0xef5f1e71).
//
// WALLETCHI's pets ARE wallet passes, and this suite pins that the showcase contracts conform to the
// on-chain half of the draft: ERC-165 advertises 0xef5f1e71, passURI throws for a token that does not
// exist and otherwise returns the owner-set base plus the decimal id, and the TOKEN CONTRACT emits
// PassUpdate / BatchPassUpdate whenever state a pass renders changes. Most of that state changes in
// PetVault and the rewards distributor, so they ask Pet721 to emit; the last section pins that a
// signal can never block a care.

import {Test, Vm} from "forge-std/Test.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {IERC721} from "@openzeppelin/contracts/token/ERC721/IERC721.sol";
import {IERC721Metadata} from "@openzeppelin/contracts/token/ERC721/extensions/IERC721Metadata.sol";
import {IERC2981} from "@openzeppelin/contracts/interfaces/IERC2981.sol";
import {IERC721Errors} from "@openzeppelin/contracts/interfaces/draft-IERC6093.sol";

import {IERC721WalletPass} from "../../src/IERC721WalletPass.sol";
import {Pet721} from "../../src/runner/Pet721.sol";
import {PetVault} from "../../src/runner/PetVault.sol";
import {MockCareToken} from "../../src/runner/MockCareToken.sol";
import {CareRewardsDistributor} from "../../src/runner/CareRewardsDistributor.sol";
import {PetBase} from "./PetVault.t.sol";
import {LivenessOracle, BlockingCareToken} from "./Season2PushRewards.t.sol";
import {careAll} from "./utils/FiveNeedsTestLib.sol";

contract WalletPassTest is PetBase {
    MockCareToken internal care;

    bytes32 internal constant PASS_UPDATE = keccak256("PassUpdate(uint256)");
    string internal constant BASE = "https://api.playwalletchi.com/wallet-pass/eip155/46630/0xpet/";

    event PassUpdate(uint256 indexed tokenId);
    event BatchPassUpdate(uint256 fromTokenId, uint256 toTokenId);

    function setUp() public {
        care = new MockCareToken();
        _deploySeason(IERC20(address(care)));
        care.mint(address(issuer), FLOAT);
        vm.prank(owner);
        pet.setPassBaseURI(BASE);
    }

    // ---------------------------------------------------------------- interface + ERC-165

    function test_InterfaceIdIsTheOneTheDraftPublishes() public pure {
        assertEq(type(IERC721WalletPass).interfaceId, bytes4(0xef5f1e71));
    }

    function test_SupportsInterfaceAdvertisesWalletPass() public view {
        assertTrue(pet.supportsInterface(type(IERC721WalletPass).interfaceId));
        assertTrue(pet.supportsInterface(0xef5f1e71));
        // ...without losing anything it already advertised.
        assertTrue(pet.supportsInterface(type(IERC721).interfaceId));
        assertTrue(pet.supportsInterface(type(IERC721Metadata).interfaceId));
        assertTrue(pet.supportsInterface(type(IERC2981).interfaceId));
        assertTrue(pet.supportsInterface(0x01ffc9a7)); // ERC-165 itself
        assertFalse(pet.supportsInterface(0xffffffff));
    }

    // ---------------------------------------------------------------- passURI

    function test_PassURIThrowsForATokenThatDoesNotExist() public {
        vm.expectRevert(abi.encodeWithSelector(IERC721Errors.ERC721NonexistentToken.selector, 1));
        pet.passURI(1);
    }

    function test_PassURIIsTheBasePlusTheDecimalId() public {
        (uint256 id,) = _issue(player);
        assertEq(pet.passURI(id), string.concat(BASE, "1"));
        for (uint256 i = 0; i < 11; i++) _issue(player);
        assertEq(pet.passURI(12), string.concat(BASE, "12"));
        assertEq(pet.passBaseURI(), BASE);
    }

    function test_PassBaseIsOwnerSettableOnly() public {
        vm.prank(stranger);
        vm.expectRevert();
        pet.setPassBaseURI("https://evil.example/");
        vm.prank(owner);
        pet.setPassBaseURI("https://passes.example/");
        (uint256 id,) = _issue(player);
        assertEq(pet.passURI(id), "https://passes.example/1");
    }

    // ---------------------------------------------------------------- PassUpdate from Pet721 itself

    function test_MintEmitsPassUpdateFromTheTokenContract() public {
        vm.expectEmit(true, false, false, true, address(pet));
        emit PassUpdate(1);
        _issue(player);
    }

    function test_TransferEmitsPassUpdate() public {
        (uint256 id,) = _issue(player);
        vm.expectEmit(true, false, false, true, address(pet));
        emit PassUpdate(id);
        vm.prank(player);
        pet.transferFrom(player, stranger, id);
    }

    // ---------------------------------------------------------------- PassUpdate on care (vault -> pet)

    function test_HatchAndEveryCareEmitPassUpdateFromTheTokenContract() public {
        (uint256 id,) = _issue(player);
        vm.expectEmit(true, false, false, true, address(pet));
        emit PassUpdate(id);
        _careBy(player, id); // the hatch

        skip(2 hours);
        vm.recordLogs();
        vm.prank(player);
        vault.care(id, 1);
        assertEq(_passUpdatesFrom(address(pet), id), 1, "exactly one PassUpdate per care");
    }

    // ---------------------------------------------------------------- settlement: every pass changes

    function test_FinalizeEmitsOneBatchPassUpdateOverTheWholeCollection() public {
        (uint256 a,) = _issue(player);
        (uint256 b,) = _issue(stranger);
        (uint256 c,) = _issue(makeAddr("third"));
        _care(a);
        _care(b);
        _care(c);
        skip(23 hours);
        careAll(vault, a); // only `a` keeps every need fed
        vm.warp(_decidesAt() + 1);

        vm.expectEmit(false, false, false, true, address(pet));
        emit BatchPassUpdate(1, 3);
        vault.finalize();
        assertEq(vault.leader(), a);
    }

    // ---------------------------------------------------------------- who may signal

    function test_OnlyTheVaultASignalerOrTheOwnerMaySignal() public {
        vm.prank(stranger);
        vm.expectRevert(abi.encodeWithSelector(Pet721.NotPassSignaler.selector, stranger));
        pet.signalPassUpdate(1);

        vm.prank(stranger);
        vm.expectRevert(abi.encodeWithSelector(Pet721.NotPassSignaler.selector, stranger));
        pet.signalBatchPassUpdate(1, 5);

        // The vault (via vaultRef) and the owner are implicitly allowed.
        vm.prank(address(vault));
        pet.signalPassUpdate(1);
        vm.prank(owner);
        pet.signalBatchPassUpdate(1, 5);

        // A registered signaler (the rewards distributor in production) may signal.
        vm.prank(stranger);
        vm.expectRevert();
        pet.setPassSignaler(stranger, true); // not the owner
        vm.prank(owner);
        pet.setPassSignaler(stranger, true);
        vm.expectEmit(true, false, false, true, address(pet));
        emit PassUpdate(7);
        vm.prank(stranger);
        pet.signalPassUpdate(7);
        vm.prank(owner);
        pet.setPassSignaler(stranger, false);
        vm.prank(stranger);
        vm.expectRevert(abi.encodeWithSelector(Pet721.NotPassSignaler.selector, stranger));
        pet.signalPassUpdate(7);
    }

    function test_BatchRangeIsInclusiveAndRejectsAnInvertedRange() public {
        vm.expectEmit(false, false, false, true, address(pet));
        emit BatchPassUpdate(4, 4); // a one-token range is legal: both ends inclusive
        vm.prank(owner);
        pet.signalBatchPassUpdate(4, 4);

        vm.prank(owner);
        vm.expectRevert(abi.encodeWithSelector(Pet721.InvalidTokenRange.selector, 5, 4));
        pet.signalBatchPassUpdate(5, 4);
    }

    // ---------------------------------------------------------------- a signal can never block a care

    function test_ASignalThatFailsNeverBlocksACare() public {
        // Point the pet's vault reference somewhere else, so the REAL vault is no longer an authorized
        // signaler and every signal it sends reverts NotPassSignaler inside Pet721.
        vm.prank(owner);
        pet.setVaultRef(address(0xBEEF));

        (uint256 id,) = _issue(player);
        vm.recordLogs();
        vm.prank(player);
        vault.care(id, 0); // must not revert
        (,, uint64 stamp, bool isAlive,) = vault.petState(id);
        assertTrue(isAlive && stamp == block.timestamp, "the care landed (the pet hatched)");
        assertEq(_passUpdatesFrom(address(pet), id), 0, "and the refused signal emitted nothing");
    }

    // ---------------------------------------------------------------- helpers

    function _passUpdatesFrom(address emitter, uint256 tokenId) internal returns (uint256 n) {
        Vm.Log[] memory logs = vm.getRecordedLogs();
        for (uint256 i = 0; i < logs.length; i++) {
            if (logs[i].emitter != emitter || logs[i].topics.length < 2) continue;
            if (logs[i].topics[0] == PASS_UPDATE && uint256(logs[i].topics[1]) == tokenId) n++;
        }
    }
}

/// @dev A payout resolver that records pass signals, standing in for Pet721 behind the distributor.
contract SignalRecorder {
    event PassUpdate(uint256 indexed tokenId);
    event BatchPassUpdate(uint256 fromTokenId, uint256 toTokenId);

    function payoutAddress(uint256, address defaultRecipient) external pure returns (address) {
        return defaultRecipient;
    }

    function signalPassUpdate(uint256 tokenId) external {
        emit PassUpdate(tokenId);
    }

    function signalBatchPassUpdate(uint256 fromTokenId, uint256 toTokenId) external {
        emit BatchPassUpdate(fromTokenId, toTokenId);
    }
}

contract WalletPassDistributorTest is Test {
    BlockingCareToken internal care;
    LivenessOracle internal oracle;
    CareRewardsDistributor internal dist;
    SignalRecorder internal recorder;

    event BatchPassUpdate(uint256 fromTokenId, uint256 toTokenId);
    event PassUpdate(uint256 indexed tokenId);

    address internal owner = makeAddr("owner");

    function setUp() public {
        care = new BlockingCareToken();
        oracle = new LivenessOracle();
        recorder = new SignalRecorder();
        oracle.setPet(address(recorder));
        dist = new CareRewardsDistributor(owner, IERC20(address(care)), 2 hours, 0, 12);
        vm.prank(owner);
        dist.setVault(address(oracle));
    }

    function _care(uint256 tokenId, address account, uint256 slice) internal {
        care.mint(address(dist), slice);
        vm.prank(address(oracle));
        dist.notifyCare(tokenId, account, slice);
    }

    function test_APushEmitsOneBatchPassUpdateOverThePaidRange() public {
        _care(3, makeAddr("tba3"), 1e18);
        _care(9, makeAddr("tba9"), 1e18);
        _care(5, makeAddr("tba5"), 1e18);
        skip(2 hours);
        uint256[] memory ids = new uint256[](4);
        (ids[0], ids[1], ids[2], ids[3]) = (9, 3, 5, 42); // 42 has no points: skipped, not in range
        vm.expectEmit(false, false, false, true, address(recorder));
        emit BatchPassUpdate(3, 9);
        dist.pushRewards(0, ids);
    }

    function test_ASinglePaidPetGetsAPlainPassUpdate() public {
        _care(4, makeAddr("tba4"), 1e18);
        skip(2 hours);
        uint256[] memory ids = new uint256[](1);
        ids[0] = 4;
        vm.expectEmit(true, false, false, true, address(recorder));
        emit PassUpdate(4);
        dist.pushRewards(0, ids);
    }

    function test_APushThatPaysNobodySignalsNothing() public {
        _care(4, makeAddr("tba4"), 1e18);
        skip(2 hours);
        oracle.setDead(4, true);
        uint256[] memory ids = new uint256[](1);
        ids[0] = 4;
        vm.recordLogs();
        dist.pushRewards(0, ids);
        Vm.Log[] memory logs = vm.getRecordedLogs();
        for (uint256 i = 0; i < logs.length; i++) {
            assertTrue(logs[i].emitter != address(recorder), "no pass signal for a push that paid nobody");
        }
    }
}
