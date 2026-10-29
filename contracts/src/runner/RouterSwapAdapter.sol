// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";

import {ISwapAdapter} from "./ISwapAdapter.sol";

/// @notice The exact-input router surface this adapter drives. Deliberately the two-call
///         quote-then-swap shape (the Uniswap-v2 router ABI that virtually every fork and
///         aggregator on an EVM chain exposes), because the adapter's whole job is to take a LIVE
///         quote in the SAME transaction as the trade and derive its own floor from it.
/// @dev    UNVERIFIED AGAINST THE LIVE VENUE. See the MAINNET GATE on RouterSwapAdapter: the router
///         we will actually use does not exist yet, so this interface is the assumption a human has
///         to confirm on launch day BEFORE any money is routed through it.
interface IExactInputRouter {
    function getAmountsOut(uint256 amountIn, address[] calldata path)
        external
        view
        returns (uint256[] memory amounts);

    function swapExactTokensForTokens(
        uint256 amountIn,
        uint256 amountOutMin,
        address[] calldata path,
        address to,
        uint256 deadline
    ) external returns (uint256[] memory amounts);
}

/// @title RouterSwapAdapter
/// @notice The MAINNET ISwapAdapter for CareFeeSplitter: swaps the player half of the launchpad fee
///         stream (USDG, 6dp) into CARE through a live router and hands it straight to the
///         CareRewardsDistributor. Replaces MockSwapAdapter, which mints its output and refuses to
///         exist on Robinhood mainnet by construction.
///
///         WHY THIS EXISTS AT ALL (CareFeeSplitter's own header says it): the splitter's
///         careOutPerFeeToken1e18 hint is a HAND-MAINTAINED number refreshed alongside a 4x/day
///         cron. Between refreshes it is stale relative to the real pool, so a poke is sandwichable
///         all the way down to that stale floor. The splitter's guards (positive floor, rationed
///         downward moves, hard max age) BOUND that loss; they cannot price a trade. The fix has to
///         live in the adapter, and it is the two properties below.
///
///         PROPERTY 1: THE ADAPTER ENFORCES ITS OWN FLOOR, FROM A LIVE SOURCE.
///         Every swap takes getAmountsOut() from the router in the SAME transaction, derives
///         ownFloor = quoted * (BPS - maxSlippageBps) / BPS, and trades against
///         max(ownFloor, the splitter's minOut). The splitter's number is therefore a BACKSTOP that
///         can only ever make the floor stricter, never looser, which is exactly the relationship
///         the splitter documents and previously had no way to enforce.
///
///         PROPERTY 2: DELIVERY IS MEASURED, NOT REPORTED.
///         The floor is checked against the balance the recipient ACTUALLY gained, not against the
///         router's return value, so a router that lies about its output buys nothing.
///
///         HONEST LIMIT, STATED BEFORE ANYONE RELIES ON IT: a same-transaction spot quote is taken
///         from the same pool the trade hits, so an attacker who moves the pool first moves the
///         quote with it. This adapter therefore raises the cost of a sandwich and removes the
///         "trade against a floor nobody refreshed" hole; it does NOT make the trade unsandwichable.
///         The things that actually would are a TWAP or oracle price independent of the spot pool,
///         or private orderflow. Until one of those exists on this chain, the splitter's independent
///         hand-set floor is the second opinion, which is why max() and not "trust the quote" is the
///         rule here.
///
///         TRUST SHAPE: THERE IS NO OWNER, AND THAT IS THE POINT. This contract has no admin, no
///         setter, no pause, no rescue-to-an-operator. It custodies nothing between transactions:
///         tokens arrive from the splitter and leave to the distributor inside one call. A router
///         that later needs replacing is handled one level up, by the splitter's owner-settable
///         swapAdapter (until lockSwapAdapter freezes it), so the replaceable part stays where it
///         was already audited to live instead of being duplicated here as a fresh privileged lever
///         sitting on top of money.
///
///         CALLER-PINNED: swap() is callable ONLY by the splitter this adapter was deployed for.
///         WHY: it is the cheapest closure of router callback reentry (a hostile router calling back
///         gets msg.sender == router, not the splitter, so it is refused), and it means the approval
///         this contract grants the router can only ever be created by the one contract whose money
///         it is.
///
///         MAINNET GATE. UNAUDITED, AND UNVERIFIABLE UNTIL A REAL CARE/USDG POOL EXISTS. Before the
///         season opens a human MUST confirm, against the deployed router and the real pool:
///           1. the router really implements getAmountsOut + swapExactTokensForTokens with these
///              exact signatures and exact-input semantics (a Uniswap-v4 Universal Router does NOT:
///              it takes an encoded command stream, and pointing this adapter at one would revert
///              every swap and park the player half forever);
///           2. `path` actually routes USDG to CARE with real depth at the size the 4x/day poke
///              trades, and getAmountsOut on that path returns a non-zero, sane number;
///           3. maxSlippageBps is sized to the REAL pool depth (too tight parks the player half
///              every poke; too loose is a licence to be sandwiched);
///           4. one real end-to-end swap of a small amount has settled and delivered >= the floor.
///         Until all four are done this contract is UNVERIFIED. Do not call it production-proven.
contract RouterSwapAdapter is ISwapAdapter {
    using SafeERC20 for IERC20;

    uint256 public constant BPS = 10_000;

    /// @notice Hard ceiling on the adapter's own slippage tolerance. Mirrors
    ///         CareFeeSplitter.MAX_SLIPPAGE_BPS so the two floors cannot be configured to disagree
    ///         about what "obviously too loose" means.
    uint256 public constant MAX_SLIPPAGE_BPS = 2000; // 20%

    /// @notice The live router. Immutable: replacing it means deploying a new adapter and pointing
    ///         the splitter at it, which is a decision the splitter's owner already gets to make
    ///         (and gets to give up permanently via lockSwapAdapter).
    IExactInputRouter public immutable router;

    /// @notice The ONLY address allowed to call swap(). The CareFeeSplitter this adapter serves.
    address public immutable splitter;

    /// @notice The token pair this adapter is pinned to (USDG in, CARE out). Pinned rather than
    ///         trusted from the call arguments so a mis-wired splitter fails on the first poke with
    ///         a named error instead of quietly routing the wrong asset down the wrong path.
    IERC20 public immutable tokenIn;
    IERC20 public immutable tokenOut;

    /// @notice The adapter's own slippage tolerance against the LIVE quote, in bps.
    uint256 public immutable maxSlippageBps;

    /// @dev The swap path, path[0] == tokenIn and path[last] == tokenOut. Stored rather than
    ///      immutable because Solidity has no immutable arrays; never written after construction and
    ///      there is no function that could write it.
    address[] private _path;

    event Swapped(uint256 amountIn, uint256 quoted, uint256 floor, uint256 delivered, address indexed to);
    event DustSwept(uint256 amount);

    error NotSplitter();
    error ZeroAddress();
    error BadSlippage();
    error BadPath();
    error TokenMismatch();
    error ZeroAmount();
    error NoLiveQuote();
    error UnderFloor(uint256 delivered, uint256 floor);

    /// @param router_ the live exact-input router
    /// @param splitter_ the CareFeeSplitter that is allowed to call swap()
    /// @param path_ the swap path; path_[0] is the fee token (USDG), path_[last] is CARE
    /// @param maxSlippageBps_ the adapter's own tolerance against the live quote (<= MAX_SLIPPAGE_BPS)
    constructor(IExactInputRouter router_, address splitter_, address[] memory path_, uint256 maxSlippageBps_) {
        if (address(router_) == address(0) || splitter_ == address(0)) revert ZeroAddress();
        // A single-element path is not a swap, and an empty one indexes out of range below.
        if (path_.length < 2) revert BadPath();
        if (maxSlippageBps_ > MAX_SLIPPAGE_BPS) revert BadSlippage();
        for (uint256 i = 0; i < path_.length; i++) {
            if (path_[i] == address(0)) revert BadPath();
            _path.push(path_[i]);
        }
        router = router_;
        splitter = splitter_;
        tokenIn = IERC20(path_[0]);
        tokenOut = IERC20(path_[path_.length - 1]);
        // A path that starts and ends on the same token would "succeed" while swapping nothing, and
        // the splitter refuses a feeToken == careToken deploy for the same reason.
        if (address(tokenIn) == address(tokenOut)) revert TokenMismatch();
        maxSlippageBps = maxSlippageBps_;
    }

    /// @notice The configured swap path (path[0] = USDG, path[last] = CARE).
    function path() external view returns (address[] memory) {
        return _path;
    }

    /// @notice The floor this adapter would enforce on `amountIn` RIGHT NOW, from a live quote, and
    ///         the quote it came from. Exposed so the cron can refresh the splitter's hint from the
    ///         same source the adapter will actually trade against, and so an operator can check the
    ///         path is alive without sending a transaction.
    /// @return quoted the router's live exact-input quote
    /// @return floor  quoted less maxSlippageBps (0 means the adapter would refuse to trade)
    function quoteFloor(uint256 amountIn) external view returns (uint256 quoted, uint256 floor) {
        if (amountIn == 0) return (0, 0);
        quoted = _quote(amountIn);
        floor = (quoted * (BPS - maxSlippageBps)) / BPS;
    }

    /// @inheritdoc ISwapAdapter
    function swap(IERC20 tokenIn_, IERC20 tokenOut_, uint256 amountIn, uint256 minOut, address to)
        external
        returns (uint256 amountOut)
    {
        // CALLER PIN. Also the reentrancy closure: a hostile router calling back into this function
        // arrives as msg.sender == router and is refused here, so there is no path that re-enters
        // with a fresh approval outstanding.
        if (msg.sender != splitter) revert NotSplitter();
        // The pair is a deploy-time fact, not a caller claim. A splitter wired to the wrong adapter
        // fails loudly on its first poke (the splitter catches the revert and PARKS the player half,
        // which is recoverable) instead of routing an unexpected asset down this path.
        if (tokenIn_ != tokenIn || tokenOut_ != tokenOut) revert TokenMismatch();
        if (amountIn == 0) revert ZeroAmount();
        if (to == address(0)) revert ZeroAddress();

        // THE LIVE FLOOR (property 1). Quoted in the SAME transaction as the trade, so it cannot be
        // a price nobody refreshed. A zero or dust quote is refused rather than treated as a floor:
        // "delivered >= 0" is vacuously true and is exactly the hole the splitter closed on its own
        // side, so the adapter must not reintroduce it.
        uint256 quoted = _quote(amountIn);
        uint256 ownFloor = (quoted * (BPS - maxSlippageBps)) / BPS;
        if (ownFloor == 0) revert NoLiveQuote();
        // STRICTEST WINS. The splitter's minOut is an INDEPENDENT, hand-maintained second opinion;
        // taking the max means a manipulated live quote can only ever be overruled by it, never used
        // to lower the bar beneath it. This is the "backstop, never the primary" relationship the
        // splitter's header describes, enforced rather than assumed.
        uint256 floor = ownFloor > minOut ? ownFloor : minOut;

        tokenIn.safeTransferFrom(msg.sender, address(this), amountIn);
        // forceApprove (not approve) because a USDT-style token reverts on a non-zero-to-non-zero
        // approve, and it resets cleanly to 0 below so no standing allowance is ever left behind.
        tokenIn.forceApprove(address(router), amountIn);

        // MEASURED, NOT REPORTED (property 2). The recipient's balance delta is the only number that
        // cannot be faked by the router's return value.
        uint256 beforeBal = tokenOut.balanceOf(to);
        // deadline == block.timestamp is correct here and is NOT the "deadline: 0" antipattern: the
        // quote and the trade are the same transaction, so any later block is already a different
        // price and must not execute.
        router.swapExactTokensForTokens(amountIn, floor, _path, to, block.timestamp);
        tokenIn.forceApprove(address(router), 0);

        amountOut = tokenOut.balanceOf(to) - beforeBal;
        if (amountOut < floor) revert UnderFloor(amountOut, floor);
        emit Swapped(amountIn, quoted, floor, amountOut, to);
    }

    /// @notice Permissionless: push any stray fee token sitting here back to the splitter, where it
    ///         re-enters the normal distribution.
    /// @dev    WHY THERE IS NO OWNER AND NO DESTINATION ARGUMENT. A normal exact-input swap consumes
    ///         exactly amountIn and delivers straight to `to`, so nothing should ever rest here; this
    ///         exists only for the case where a router leaves a remainder or someone sends tokens by
    ///         mistake. Hardcoding the destination to the splitter means this can never become an
    ///         exit: the only place the money can go is back into the same 70/20/10 pipeline it came
    ///         from. Deliberately fee-token ONLY: CARE forwarded to the splitter would be stranded
    ///         there (the splitter accounts only its fee token and its rescue path protects CARE), so
    ///         adding a CARE sweep would make that case worse rather than better.
    function sweepFeeTokenToSplitter() external {
        uint256 bal = tokenIn.balanceOf(address(this));
        if (bal == 0) return; // no-op rather than a revert, so a keeper script never errors on empty
        tokenIn.safeTransfer(splitter, bal);
        emit DustSwept(bal);
    }

    /// @dev The live quote for the configured path. Reverts NoLiveQuote on a router that answers with
    ///      a malformed array, because a short array means we are not talking to the router we think
    ///      we are and must not trade on the assumption that we are.
    function _quote(uint256 amountIn) internal view returns (uint256) {
        uint256[] memory amounts = router.getAmountsOut(amountIn, _path);
        if (amounts.length != _path.length) revert NoLiveQuote();
        return amounts[amounts.length - 1];
    }
}
