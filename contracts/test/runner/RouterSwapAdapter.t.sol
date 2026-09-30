// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

// MAINNET SWAP INLET. Covers RouterSwapAdapter, the real router-backed ISwapAdapter that replaces
// MockSwapAdapter on mainnet, plus its integration with the live CareFeeSplitter.
//
// THE PROPERTY UNDER TEST, stated once: the splitter's careOutPerFeeToken1e18 hint is a
// hand-maintained number refreshed alongside a 4x/day cron, so between refreshes it is stale and a
// poke is sandwichable down to that stale floor. The splitter's header says the adapter MUST enforce
// its own floor from a live source and that the splitter's number is only a backstop. These tests
// are what make that sentence true rather than aspirational: the adapter quotes the router in the
// SAME transaction, derives its own floor, and trades against max(ownFloor, splitterMinOut).
//
// UNAUDITED, and UNVERIFIABLE against a real pool until one exists. See RouterSwapAdapter's MAINNET
// GATE for the four things a human must confirm on launch day.

import {Test} from "forge-std/Test.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

import {MockCareToken} from "../../src/runner/MockCareToken.sol";
import {MockUSDG} from "../../src/runner/MockUSDG.sol";
import {RouterSwapAdapter, IExactInputRouter} from "../../src/runner/RouterSwapAdapter.sol";
import {CareRewardsDistributor} from "../../src/runner/CareRewardsDistributor.sol";
import {CareFeeSplitter, IPotState} from "../../src/runner/CareFeeSplitter.sol";
import {HolderMerkleVault} from "../../src/runner/HolderMerkleVault.sol";

interface IMintable {
    function mint(address to, uint256 amount) external;
}

/// @dev A configurable exact-input router stand-in. ONE mock covers every case the adapter has to
///      survive, driven by three switches:
///        deliverBps    - what fraction of the QUOTED amount it actually delivers (a sandwich, or a
///                        router that quotes high and pays low)
///        honorMinOut   - whether it reverts when it cannot meet amountOutMin (an honest router does;
///                        a hostile one does not, which is exactly why the adapter measures the
///                        recipient's balance delta instead of trusting the return value)
///        shortArray    - returns a malformed amounts array (we are not talking to the router we
///                        think we are)
contract MockExactInputRouter is IExactInputRouter {
    uint256 public rateNum;
    uint256 public rateDen;
    uint256 public deliverBps = 10_000;
    bool public honorMinOut = true;
    bool public shortArray;

    constructor(uint256 rateNum_, uint256 rateDen_) {
        rateNum = rateNum_;
        rateDen = rateDen_;
    }

    function setRate(uint256 num, uint256 den) external {
        rateNum = num;
        rateDen = den;
    }

    function setDeliverBps(uint256 bps) external {
        deliverBps = bps;
    }

    function setHonorMinOut(bool v) external {
        honorMinOut = v;
    }

    function setShortArray(bool v) external {
        shortArray = v;
    }

    function _out(uint256 amountIn) internal view returns (uint256) {
        return rateDen == 0 ? 0 : (amountIn * rateNum) / rateDen;
    }

    function getAmountsOut(uint256 amountIn, address[] calldata path)
        external
        view
        returns (uint256[] memory amounts)
    {
        if (shortArray) return new uint256[](1);
        amounts = new uint256[](path.length);
        amounts[0] = amountIn;
        for (uint256 i = 1; i + 1 < path.length; i++) amounts[i] = amountIn;
        amounts[path.length - 1] = _out(amountIn);
    }

    function swapExactTokensForTokens(
        uint256 amountIn,
        uint256 amountOutMin,
        address[] calldata path,
        address to,
        uint256 deadline
    ) external returns (uint256[] memory amounts) {
        require(deadline >= block.timestamp, "expired");
        IERC20(path[0]).transferFrom(msg.sender, address(this), amountIn);
        uint256 delivered = (_out(amountIn) * deliverBps) / 10_000;
        if (honorMinOut) require(delivered >= amountOutMin, "INSUFFICIENT_OUTPUT_AMOUNT");
        IMintable(path[path.length - 1]).mint(to, delivered);
        amounts = new uint256[](path.length);
        amounts[0] = amountIn;
        // Report the QUOTE, not the delivery, so a test that passes here proves the adapter is not
        // believing this number.
        amounts[path.length - 1] = _out(amountIn);
    }
}

/// @dev Settable potClaimed oracle so the splitter's post-season branch can be driven without a vault.
contract PotStub is IPotState {
    bool public flag;

    function setPotClaimed(bool v) external {
        flag = v;
    }

    function potClaimed() external view returns (bool) {
        return flag;
    }
}

contract RouterSwapAdapterTest is Test {
    // USDG is 6dp and CARE is 18dp, so a 1:1 VALUE swap is a raw-unit rate of 1e12.
    uint256 constant RATE = 1e12;
    uint256 constant ADAPTER_SLIPPAGE_BPS = 300; // 3%

    MockUSDG usdg;
    MockCareToken care;
    MockExactInputRouter router;
    RouterSwapAdapter adapter;

    address splitterEOA = address(0xB0B); // stands in for the splitter in the unit tests
    address recipient = address(0xD157);

    function setUp() public {
        usdg = new MockUSDG();
        care = new MockCareToken();
        router = new MockExactInputRouter(RATE, 1);
        adapter = new RouterSwapAdapter(router, splitterEOA, _path(), ADAPTER_SLIPPAGE_BPS);
        usdg.mint(splitterEOA, 1_000_000e6);
        vm.prank(splitterEOA);
        usdg.approve(address(adapter), type(uint256).max);
    }

    function _path() internal view returns (address[] memory p) {
        p = new address[](2);
        p[0] = address(usdg);
        p[1] = address(care);
    }

    function _doSwap(uint256 amountIn, uint256 minOut) internal returns (uint256) {
        vm.prank(splitterEOA);
        return adapter.swap(IERC20(address(usdg)), IERC20(address(care)), amountIn, minOut, recipient);
    }

    // ---------------------------------------------------------------------------------------
    // Construction
    // ---------------------------------------------------------------------------------------

    function test_constructor_storesConfig() public view {
        assertEq(address(adapter.router()), address(router));
        assertEq(adapter.splitter(), splitterEOA);
        assertEq(address(adapter.tokenIn()), address(usdg));
        assertEq(address(adapter.tokenOut()), address(care));
        assertEq(adapter.maxSlippageBps(), ADAPTER_SLIPPAGE_BPS);
        address[] memory p = adapter.path();
        assertEq(p.length, 2);
        assertEq(p[0], address(usdg));
        assertEq(p[1], address(care));
    }

    function test_constructor_rejectsZeroRouterOrSplitter() public {
        vm.expectRevert(RouterSwapAdapter.ZeroAddress.selector);
        new RouterSwapAdapter(IExactInputRouter(address(0)), splitterEOA, _path(), 300);
        vm.expectRevert(RouterSwapAdapter.ZeroAddress.selector);
        new RouterSwapAdapter(router, address(0), _path(), 300);
    }

    function test_constructor_rejectsShortPathAndZeroHop() public {
        address[] memory one = new address[](1);
        one[0] = address(usdg);
        vm.expectRevert(RouterSwapAdapter.BadPath.selector);
        new RouterSwapAdapter(router, splitterEOA, one, 300);

        address[] memory withZero = new address[](3);
        withZero[0] = address(usdg);
        withZero[1] = address(0);
        withZero[2] = address(care);
        vm.expectRevert(RouterSwapAdapter.BadPath.selector);
        new RouterSwapAdapter(router, splitterEOA, withZero, 300);
    }

    function test_constructor_rejectsSlippageAboveCeiling() public {
        vm.expectRevert(RouterSwapAdapter.BadSlippage.selector);
        new RouterSwapAdapter(router, splitterEOA, _path(), 2001);
    }

    /// A path that starts and ends on the same token would "succeed" while swapping nothing, which
    /// is the same failure the splitter refuses at deploy (feeToken must differ from CARE).
    function test_constructor_rejectsSameInAndOutToken() public {
        address[] memory p = new address[](2);
        p[0] = address(usdg);
        p[1] = address(usdg);
        vm.expectRevert(RouterSwapAdapter.TokenMismatch.selector);
        new RouterSwapAdapter(router, splitterEOA, p, 300);
    }

    // ---------------------------------------------------------------------------------------
    // Access + argument pinning
    // ---------------------------------------------------------------------------------------

    /// The caller pin is also the reentrancy closure: a hostile router calling back arrives as
    /// msg.sender == router, which is not the splitter, so it is refused.
    function test_swap_onlySplitterMayCall() public {
        usdg.mint(address(this), 100e6);
        usdg.approve(address(adapter), type(uint256).max);
        vm.expectRevert(RouterSwapAdapter.NotSplitter.selector);
        adapter.swap(IERC20(address(usdg)), IERC20(address(care)), 100e6, 0, recipient);
    }

    function test_swap_rejectsWrongTokens() public {
        MockUSDG other = new MockUSDG();
        vm.prank(splitterEOA);
        vm.expectRevert(RouterSwapAdapter.TokenMismatch.selector);
        adapter.swap(IERC20(address(other)), IERC20(address(care)), 100e6, 0, recipient);
        vm.prank(splitterEOA);
        vm.expectRevert(RouterSwapAdapter.TokenMismatch.selector);
        adapter.swap(IERC20(address(usdg)), IERC20(address(other)), 100e6, 0, recipient);
    }

    function test_swap_rejectsZeroAmountAndZeroRecipient() public {
        vm.prank(splitterEOA);
        vm.expectRevert(RouterSwapAdapter.ZeroAmount.selector);
        adapter.swap(IERC20(address(usdg)), IERC20(address(care)), 0, 0, recipient);
        vm.prank(splitterEOA);
        vm.expectRevert(RouterSwapAdapter.ZeroAddress.selector);
        adapter.swap(IERC20(address(usdg)), IERC20(address(care)), 100e6, 0, address(0));
    }

    // ---------------------------------------------------------------------------------------
    // The live floor (the headline property)
    // ---------------------------------------------------------------------------------------

    function test_quoteFloor_readsTheLiveRouter() public view {
        (uint256 quoted, uint256 floor) = adapter.quoteFloor(1_000e6);
        assertEq(quoted, 1_000e6 * RATE);
        assertEq(floor, (1_000e6 * RATE * (10_000 - ADAPTER_SLIPPAGE_BPS)) / 10_000);
        (uint256 q0, uint256 f0) = adapter.quoteFloor(0);
        assertEq(q0, 0);
        assertEq(f0, 0);
    }

    function test_swap_happyPathDeliversToRecipient() public {
        uint256 amountIn = 1_000e6;
        uint256 out = _doSwap(amountIn, 0);
        assertEq(out, amountIn * RATE);
        assertEq(care.balanceOf(recipient), amountIn * RATE);
        assertEq(usdg.balanceOf(address(adapter)), 0, "adapter custodies nothing at rest");
    }

    /// THE POINT OF THE WHOLE CONTRACT. The splitter passes minOut = 0 (which is what a stale or
    /// unset hint amounts to), and the adapter still refuses a bad fill because it derived its own
    /// floor from a live quote. Against MockSwapAdapter, or any adapter that only honours the
    /// caller's minOut, this trade goes through and the player half is taken.
    function test_swap_ownFloorRefusesABadFillEvenWhenCallerMinOutIsZero() public {
        router.setHonorMinOut(false); // a hostile router ignores the amountOutMin it is handed
        router.setDeliverBps(1000); // and delivers 10% of the quote
        uint256 amountIn = 1_000e6;
        uint256 quoted = amountIn * RATE;
        uint256 ownFloor = (quoted * (10_000 - ADAPTER_SLIPPAGE_BPS)) / 10_000;
        vm.prank(splitterEOA);
        vm.expectRevert(
            abi.encodeWithSelector(RouterSwapAdapter.UnderFloor.selector, quoted / 10, ownFloor)
        );
        adapter.swap(IERC20(address(usdg)), IERC20(address(care)), amountIn, 0, recipient);
    }

    /// STRICTEST WINS, in the other direction: when the splitter's independent hint is HIGHER than
    /// the live quote's floor, the splitter's number is the one enforced. A manipulated live quote
    /// can therefore only ever be overruled by the splitter, never used to lower the bar under it.
    function test_swap_callerMinOutWinsWhenItIsStricter() public {
        router.setHonorMinOut(false);
        uint256 amountIn = 1_000e6;
        uint256 quoted = amountIn * RATE;
        uint256 strictMinOut = quoted + 1; // above anything the pool can deliver
        vm.prank(splitterEOA);
        vm.expectRevert(
            abi.encodeWithSelector(RouterSwapAdapter.UnderFloor.selector, quoted, strictMinOut)
        );
        adapter.swap(IERC20(address(usdg)), IERC20(address(care)), amountIn, strictMinOut, recipient);
    }

    /// A fill just inside the tolerance settles; a fill just outside it does not. This is what pins
    /// maxSlippageBps as a real boundary rather than a decorative constant.
    function test_swap_toleranceBoundaryIsExact() public {
        router.setHonorMinOut(false);
        router.setDeliverBps(10_000 - ADAPTER_SLIPPAGE_BPS); // exactly at the floor
        uint256 amountIn = 1_000e6;
        uint256 out = _doSwap(amountIn, 0);
        assertEq(out, (amountIn * RATE * (10_000 - ADAPTER_SLIPPAGE_BPS)) / 10_000);

        router.setDeliverBps(10_000 - ADAPTER_SLIPPAGE_BPS - 1); // one bp worse
        vm.prank(splitterEOA);
        vm.expectRevert();
        adapter.swap(IERC20(address(usdg)), IERC20(address(care)), amountIn, 0, recipient);
    }

    /// A dead or empty path quotes zero. Zero is NOT a floor ("delivered >= 0" is vacuously true),
    /// so the adapter refuses to trade at all rather than swapping unpriced.
    function test_swap_refusesWhenTheLiveQuoteIsZero() public {
        router.setRate(0, 1);
        vm.prank(splitterEOA);
        vm.expectRevert(RouterSwapAdapter.NoLiveQuote.selector);
        adapter.swap(IERC20(address(usdg)), IERC20(address(care)), 1_000e6, 0, recipient);
    }

    /// A malformed amounts array means we are not talking to the router we think we are. Trading on
    /// that assumption is exactly the class of mistake this whole change exists to remove.
    function test_swap_refusesAMalformedRouterResponse() public {
        router.setShortArray(true);
        vm.prank(splitterEOA);
        vm.expectRevert(RouterSwapAdapter.NoLiveQuote.selector);
        adapter.swap(IERC20(address(usdg)), IERC20(address(care)), 1_000e6, 0, recipient);
    }

    /// Delivery is MEASURED at the recipient, not read off the router's return value, so a router
    /// that reports a huge output while paying nothing gains nothing.
    function test_swap_ignoresALyingReturnValue() public {
        router.setHonorMinOut(false);
        router.setDeliverBps(0); // reports the full quote, delivers nothing
        vm.prank(splitterEOA);
        vm.expectRevert(abi.encodeWithSelector(RouterSwapAdapter.UnderFloor.selector, 0, (1_000e6 * RATE * 9700) / 10_000));
        adapter.swap(IERC20(address(usdg)), IERC20(address(care)), 1_000e6, 0, recipient);
    }

    function test_swap_leavesNoStandingRouterAllowance() public {
        _doSwap(1_000e6, 0);
        assertEq(usdg.allowance(address(adapter), address(router)), 0);
    }

    function test_swap_worksOverAMultiHopPath() public {
        MockUSDG weth = new MockUSDG(); // a stand-in intermediate hop
        address[] memory p = new address[](3);
        p[0] = address(usdg);
        p[1] = address(weth);
        p[2] = address(care);
        RouterSwapAdapter hopAdapter = new RouterSwapAdapter(router, splitterEOA, p, ADAPTER_SLIPPAGE_BPS);
        vm.prank(splitterEOA);
        usdg.approve(address(hopAdapter), type(uint256).max);
        vm.prank(splitterEOA);
        uint256 out = hopAdapter.swap(IERC20(address(usdg)), IERC20(address(care)), 500e6, 0, recipient);
        assertEq(out, 500e6 * RATE);
    }

    // ---------------------------------------------------------------------------------------
    // Dust sweep (no owner, one hardcoded destination)
    // ---------------------------------------------------------------------------------------

    function test_sweep_sendsStrayFeeTokenBackToTheSplitterOnly() public {
        usdg.mint(address(adapter), 42e6);
        uint256 before = usdg.balanceOf(splitterEOA);
        adapter.sweepFeeTokenToSplitter(); // permissionless on purpose: the destination is fixed
        assertEq(usdg.balanceOf(address(adapter)), 0);
        assertEq(usdg.balanceOf(splitterEOA), before + 42e6);
    }

    function test_sweep_isANoOpWhenEmpty() public {
        adapter.sweepFeeTokenToSplitter();
        assertEq(usdg.balanceOf(address(adapter)), 0);
    }

    // ---------------------------------------------------------------------------------------
    // Integration with the real CareFeeSplitter
    // ---------------------------------------------------------------------------------------

    struct Stack {
        CareRewardsDistributor dist;
        HolderMerkleVault hv;
        CareFeeSplitter splitter;
        RouterSwapAdapter live;
        PotStub pot;
    }

    function _stack() internal returns (Stack memory s) {
        address owner = address(this);
        s.dist = new CareRewardsDistributor(owner, IERC20(address(care)), 6 hours, 0, 8);
        s.hv = new HolderMerkleVault(owner, IERC20(address(usdg)), address(0xF057E4));
        s.pot = new PotStub();
        s.splitter = new CareFeeSplitter(owner, IERC20(address(usdg)), address(s.hv), s.dist, IPotState(address(s.pot)), 5000);
        address[] memory p = _path();
        s.live = new RouterSwapAdapter(router, address(s.splitter), p, ADAPTER_SLIPPAGE_BPS);
        s.splitter.setSwapAdapter(address(s.live));
        // The splitter's own hint: the hand-maintained backstop, set to the same 1:1 value rate.
        s.splitter.setSwapParams(300, uint256(RATE) * 1e18);
    }

    function test_integration_splitterRoutesThePlayerHalfThroughTheRealAdapter() public {
        Stack memory s = _stack();
        usdg.mint(address(s.splitter), 1_000e6);
        (uint256 holderShare, uint256 playerFeeIn) = s.splitter.distribute();
        assertEq(holderShare, 500e6, "holder half in USDG");
        assertEq(playerFeeIn, 500e6, "player half swapped");
        assertEq(usdg.balanceOf(address(s.hv)), 500e6);
        assertEq(care.balanceOf(address(s.dist)), 500e6 * RATE, "CARE landed on the distributor");
        assertEq(s.splitter.parkedPlayerFee(), 0, "nothing parked on a good swap");
        // Booked a FULL epoch ahead by donateNext, never into the live epoch.
        assertEq(s.dist.epochPool(s.dist.epochNow() + 1), 500e6 * RATE);
    }

    /// A SANDWICHED POOL MUST PARK, NOT TRADE. The live quote collapses to half; the splitter's
    /// independent hint has not been refreshed, so it is still the stricter number and the adapter
    /// enforces it. The router cannot fill it, the adapter reverts, the splitter CATCHES that and
    /// parks the player half for the next poke. No money is lost and the holder leg still lands.
    function test_integration_aCollapsedQuoteParksThePlayerHalfInsteadOfTrading() public {
        Stack memory s = _stack();
        usdg.mint(address(s.splitter), 1_000e6);
        router.setRate(RATE / 2, 1);
        (uint256 holderShare, uint256 playerFeeIn) = s.splitter.distribute();
        assertEq(holderShare, 500e6, "the holder leg still lands");
        assertEq(playerFeeIn, 0, "the player half did not trade");
        assertEq(s.splitter.parkedPlayerFee(), 500e6, "it is parked, not lost");
        assertEq(care.balanceOf(address(s.dist)), 0);

        // And it is retried: once the pool recovers, the very next poke settles the parked amount.
        router.setRate(RATE, 1);
        (, uint256 retried) = s.splitter.distribute();
        assertEq(retried, 500e6);
        assertEq(s.splitter.parkedPlayerFee(), 0);
        assertEq(care.balanceOf(address(s.dist)), 500e6 * RATE);
    }

    /// The parked half is NEVER re-taxed for holders on the retry (the splitter's MEDIUM-1 rule),
    /// and the real adapter does not change that.
    function test_integration_parkedMoneyIsNotReTaxedForHolders() public {
        Stack memory s = _stack();
        usdg.mint(address(s.splitter), 1_000e6);
        router.setRate(RATE / 2, 1);
        s.splitter.distribute();
        uint256 holderAfterPark = usdg.balanceOf(address(s.hv));
        router.setRate(RATE, 1);
        s.splitter.distribute();
        assertEq(usdg.balanceOf(address(s.hv)), holderAfterPark, "no second holder cut on the retry");
    }
}
