// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {Ownable2Step} from "@openzeppelin/contracts/access/Ownable2Step.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {MerkleProof} from "@openzeppelin/contracts/utils/cryptography/MerkleProof.sol";
import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";

/// @title HolderMerkleVault
/// @notice The HOLDER half of the CARE trading-fee stream (in USDG). The CareFeeSplitter deposits
///         here; 4x/day the operator snapshots CARE holders WHO ALSO OWN A LIVE PET (the live-pet gate
///         is applied off-chain by the snapshot job, per Hunt's decision), allocates the accumulated
///         balance pro rata, and posts a Merkle round. Holders claim their slice whenever they like.
///
///         TRUST SHAPE, STATED HONESTLY (corrected after the re-audit proved the earlier wording
///         false). The POSTER fully controls each round's ALLOCATION: it builds the leaves, so it can
///         allocate a round to any address including itself. A single-leaf tree is a valid tree whose
///         root IS its leaf and whose proof is empty, so "post a round to myself and claim it" is a
///         real capability of the poster key, bounded by a rolling posting allowance.
///
///         The OWNER IS A SUPERSET OF THE POSTER: the owner can rotate the poster, therefore the owner
///         can eventually reach that same capability. The earlier claim that "the owner has NO
///         withdrawal path for the reward token" was WRONG and has been removed. What is true, and
///         what this contract enforces:
///           - the owner cannot do it ATOMICALLY. Rotating the poster is a two step, timelocked
///             operation (queuePoster then commitPoster after POSTER_ROTATION_DELAY) that emits
///             PosterQueued the moment it starts, so a stolen owner key cannot rotate and drain in one
///             transaction and holders/monitoring get a full delay of warning.
///           - both one round and aggregate posting are capped. maxRoundTotal MUST be armed (non
///             zero) before ANY round can be posted. It is also the capacity of a token bucket that
///             refills linearly over POSTING_WINDOW, so splitting a theft across many rounds cannot
///             bypass the configured immediate-loss bound.
///           - emergency response is still instant: setPostingPaused(true) stops a leaked POSTER key
///             immediately, with no delay, and never blocks claims.
///           - rescueToken can never touch the reward token, and there is no other transfer path.
///         Everything else the contract enforces regardless of poster intent: a round's total can
///         never exceed the unreserved balance (every posted round is fully backed), a claim pays ONLY
///         the leaf's named account, no round can be edited or deleted once posted, and funds leave
///         ONLY via claim() or a forward-only releaseRound() that moves nothing out of the vault.
///
///         The practical consequence: treat the OWNER key as custodial over undistributed holder
///         funds, with a timelock and a public queue event as the mitigation. It is not trustless.
///
///         LEAF FORMAT (double-hashed, OZ MerkleProof guidance, second-preimage safe):
///           leaf = keccak256(bytes.concat(keccak256(abi.encode(roundId, account, amount))))
///         roundId in the leaf binds a proof to its round (no cross-round replay).
///
///         UNAUDITED: re-audit before mainnet.
contract HolderMerkleVault is Ownable2Step, ReentrancyGuard {
    using SafeERC20 for IERC20;

    /// @notice The airdrop currency (USDG; same token the splitter distributes to holders).
    IERC20 public immutable rewardToken;

    /// @notice The operator key allowed to post rounds (the server snapshot key). NEVER the relayer/
    ///         mint key. Owner-rotatable (timelocked) so a leaked poster key is recoverable without
    ///         redeploying.
    address public poster;

    /// @notice A queued poster rotation and the earliest timestamp it may be committed. Rotation is
    ///         delayed because granting the posting key is the same thing as granting the ability to
    ///         allocate the whole unreserved balance; the delay plus the PosterQueued event turn an
    ///         atomic owner-key drain into a publicly announced one holders can react to.
    address public pendingPoster;
    uint64 public pendingPosterEta;

    /// @notice Emergency stop for posting ONLY. Instant on purpose: revoking a leaked poster key must
    ///         not wait out the rotation timelock. Claims and releases are deliberately NOT gated by
    ///         this, so pausing can never strand a holder's already-posted allocation.
    bool public postingPaused;

    /// @notice How long a poster rotation must sit queued before it can be committed.
    uint256 public constant POSTER_ROTATION_DELAY = 2 days;

    /// @notice Reward tokens promised to posted rounds and not yet claimed/released out.
    uint256 public reserved;

    /// @notice Ceiling on a single round and capacity of the rolling aggregate posting allowance.
    ///         FAIL CLOSED: 0 means "not armed yet" and postRound reverts until the owner sets a real
    ///         value. Capacity spent by successful rounds refills linearly over POSTING_WINDOW.
    uint256 public maxRoundTotal;

    /// @notice Time for an empty posting allowance to refill to maxRoundTotal. Linear refill avoids
    ///         the double burst possible at the boundary of a fixed daily window.
    uint256 public constant POSTING_WINDOW = 1 days;

    /// @notice Stored allowance as of postingAllowanceUpdatedAt. Use postingAllowanceAvailable() for
    ///         the live value including time-based refill.
    uint256 public postingAllowance;
    uint256 public postingAllowanceUpdatedAt;

    /// @notice Seconds after posting before a round's unclaimed remainder may be released forward.
    ///         Each round SNAPSHOTS this at post time (see Round.releaseAt), so changing it later can
    ///         never retroactively shorten a deadline a holder is already relying on.
    uint256 public releaseGrace;

    /// @notice Floor on releaseGrace. Raised from 7 days to 30 days (re-audit MEDIUM): at the 4x/day
    ///         posting cadence a 7 day window meant a holder who went on holiday lost real money to a
    ///         permissionless release, and nothing on chain told them the deadline. 30 days keeps the
    ///         forward-only release (it exists so dust and never-claimed allocations are not stranded
    ///         forever) while making the window survivable.
    uint256 public constant MIN_RELEASE_GRACE = 30 days;

    /// @notice Ceiling on releaseGrace. Without one the owner could set a grace so long that the
    ///         forward-only release never fires in practice, which is the permanent-stranding problem
    ///         the release exists to solve, and a grace near uint256 max would overflow the deadline
    ///         arithmetic in postRound and brick posting outright.
    uint256 public constant MAX_RELEASE_GRACE = 365 days;

    struct Round {
        bytes32 root;
        uint128 total;
        uint128 claimedTotal;
        uint64 postedAt;
        bool released;
        /// @dev Snapshot of postedAt + releaseGrace taken when the round was posted. Appended to the
        ///      end of the struct so the existing getter fields keep their order and meaning.
        uint64 releaseAt;
    }

    Round[] public rounds;

    /// @notice Whether an account has claimed a given round.
    mapping(uint256 => mapping(address => bool)) public claimed;

    event PosterSet(address indexed poster);
    event PosterQueued(address indexed poster, uint256 eta);
    event PosterQueueCancelled(address indexed poster);
    event PostingPausedSet(bool paused);
    event MaxRoundTotalSet(uint256 maxRoundTotal);
    event ReleaseGraceSet(uint256 releaseGrace);
    event RoundPosted(uint256 indexed roundId, bytes32 root, uint256 total);
    event Claimed(uint256 indexed roundId, address indexed account, uint256 amount);
    event RoundReleased(uint256 indexed roundId, uint256 releasedAmount);
    event StrayRescued(address indexed token, address indexed to, uint256 amount);

    error OwnershipCannotBeRenounced();
    error ZeroAddress();
    error NotPoster();
    error BadRound();
    error RoundNotBacked();
    error OverRoundCap();
    error PostingAllowanceExceeded();
    error UnexpectedRoundId();
    error NoSuchRound();
    error AlreadyClaimed();
    error BadProof();
    error OverRoundTotal();
    error CannotRescueRewardToken();
    error GraceNotElapsed();
    error AlreadyReleased();
    error RoundClosed();
    error BadGrace();
    error RoundCapNotArmed();
    error ZeroRoundCap();
    error PostingIsPaused();
    error NoPendingPoster();
    error RotationNotElapsed();

    constructor(address owner_, IERC20 rewardToken_, address poster_) Ownable(owner_) {
        if (address(rewardToken_) == address(0) || poster_ == address(0)) revert ZeroAddress();
        rewardToken = rewardToken_;
        poster = poster_;
        releaseGrace = MIN_RELEASE_GRACE;
        emit PosterSet(poster_);
    }

    // --------------------------------------------------------------------------------------------
    // Admin
    // --------------------------------------------------------------------------------------------

    /// @notice Step 1 of a poster rotation. Announces the new poster and starts the timelock. There is
    ///         deliberately NO instant setPoster: handing over the posting key is handing over the
    ///         ability to allocate the unreserved balance to an arbitrary address, so a stolen owner
    ///         key must not be able to do it in the same transaction as the drain.
    function queuePoster(address poster_) external onlyOwner {
        if (poster_ == address(0)) revert ZeroAddress();
        pendingPoster = poster_;
        // casting to 'uint64' is safe because block.timestamp plus a 2 day constant is ~1.8e9, some
        // ten orders of magnitude below uint64 max, so it cannot truncate this side of year 584942.
        // forge-lint: disable-next-line(unsafe-typecast)
        pendingPosterEta = uint64(block.timestamp + POSTER_ROTATION_DELAY);
        emit PosterQueued(poster_, pendingPosterEta);
    }

    /// @notice Abort a queued rotation. Available to the owner at any time before the eta, so a
    ///         rotation spotted as hostile can be cancelled by a recovered owner key.
    function cancelQueuedPoster() external onlyOwner {
        if (pendingPoster == address(0)) revert NoPendingPoster();
        address cancelled = pendingPoster;
        pendingPoster = address(0);
        pendingPosterEta = 0;
        emit PosterQueueCancelled(cancelled);
    }

    /// @notice Step 2 of a poster rotation, once the timelock has elapsed. Owner-gated (the queue is
    ///         the announcement, the commit is still an owner decision).
    function commitPoster() external onlyOwner {
        address next = pendingPoster;
        if (next == address(0)) revert NoPendingPoster();
        if (block.timestamp < pendingPosterEta) revert RotationNotElapsed();
        pendingPoster = address(0);
        pendingPosterEta = 0;
        poster = next;
        emit PosterSet(next);
    }

    /// @notice Instant emergency stop for POSTING only. This is the fast path a rotation timelock
    ///         would otherwise cost us: a leaked poster key is revoked immediately here, and the slow
    ///         timelocked rotation only governs handing the key to someone NEW. Claims and releases
    ///         stay open, so pausing can never strand an allocation that is already posted.
    function setPostingPaused(bool paused) external onlyOwner {
        postingPaused = paused;
        emit PostingPausedSet(paused);
    }

    /// @notice Arm or retune the per-round and rolling aggregate ceiling. Arming from zero grants one
    ///         full bucket. Retuning an already-armed cap first settles accrued allowance and clamps
    ///         it to the new cap; raising the cap cannot instantly manufacture fresh allowance. Zero
    ///         is not a pause switch: accepting 0 would let the owner immediately re-arm and refill a
    ///         spent bucket. Use setPostingPaused(true) for the reversible emergency stop.
    function setMaxRoundTotal(uint256 maxRoundTotal_) external onlyOwner {
        if (maxRoundTotal_ == 0) revert ZeroRoundCap();
        uint256 oldCap = maxRoundTotal;
        uint256 available = postingAllowanceAvailable();
        maxRoundTotal = maxRoundTotal_;
        if (oldCap == 0 && maxRoundTotal_ != 0) {
            postingAllowance = maxRoundTotal_;
        } else {
            postingAllowance = Math.min(available, maxRoundTotal_);
        }
        postingAllowanceUpdatedAt = block.timestamp;
        emit MaxRoundTotalSet(maxRoundTotal_);
    }

    function setReleaseGrace(uint256 releaseGrace_) external onlyOwner {
        if (releaseGrace_ < MIN_RELEASE_GRACE || releaseGrace_ > MAX_RELEASE_GRACE) revert BadGrace();
        releaseGrace = releaseGrace_;
        emit ReleaseGraceSet(releaseGrace_);
    }

    // --------------------------------------------------------------------------------------------
    // Rounds
    // --------------------------------------------------------------------------------------------

    /// @notice Post a snapshot round. `expectedRoundId` MUST equal rounds.length (the leaves commit to
    ///         it), so a cron retry or nonce race that shifted the id reverts cleanly instead of
    ///         silently posting a root whose proofs no longer verify (MED-3). Total must fit the
    ///         UNRESERVED balance and the owner cap.
    function postRound(uint256 expectedRoundId, bytes32 root, uint256 total)
        external
        nonReentrant
        returns (uint256 roundId)
    {
        if (msg.sender != poster) revert NotPoster();
        // Emergency stop, checked before anything else so a leaked poster key is dead the instant the
        // owner flips it, without waiting out the rotation timelock.
        if (postingPaused) revert PostingIsPaused();
        if (rounds.length != expectedRoundId) revert UnexpectedRoundId();
        if (root == bytes32(0) || total == 0 || total > type(uint128).max) revert BadRound();
        // FAIL CLOSED (re-audit): an unarmed cap used to mean "unlimited", so the single protection
        // bounding a leaked poster key was off by default. Refuse to post at all until it is armed.
        if (maxRoundTotal == 0) revert RoundCapNotArmed();
        if (total > maxRoundTotal) revert OverRoundCap();
        uint256 allowance = postingAllowanceAvailable();
        if (total > allowance) revert PostingAllowanceExceeded();
        uint256 available = _unreserved();
        if (total > available) revert RoundNotBacked();

        roundId = rounds.length;
        postingAllowance = allowance - total;
        postingAllowanceUpdatedAt = block.timestamp;
        reserved += total;
        rounds.push(
            Round({
                root: root,
                total: uint128(total),
                claimedTotal: 0,
                postedAt: uint64(block.timestamp),
                released: false,
                // Snapshot the deadline now. Holders read it from roundDeadline(); an owner who later
                // changes releaseGrace must not be able to pull an existing round's deadline forward
                // under a holder who is relying on it.
                // casting to 'uint64' is safe because releaseGrace is capped at MAX_RELEASE_GRACE
                // (365 days), so the sum stays ~1.8e9, far below uint64 max.
                // forge-lint: disable-next-line(unsafe-typecast)
                releaseAt: uint64(block.timestamp + releaseGrace)
            })
        );
        emit RoundPosted(roundId, root, total);
    }

    /// @notice Aggregate amount the poster can allocate now. Claims and releases do not refill it;
    ///         only elapsed time does, so self-claiming many small rounds cannot bypass the cap.
    function postingAllowanceAvailable() public view returns (uint256) {
        uint256 cap = maxRoundTotal;
        if (cap == 0) return 0;
        uint256 stored = postingAllowance;
        if (stored >= cap) return cap;
        uint256 elapsed = block.timestamp - postingAllowanceUpdatedAt;
        if (elapsed >= POSTING_WINDOW) return cap;
        uint256 refilled = Math.mulDiv(cap, elapsed, POSTING_WINDOW);
        uint256 room = cap - stored;
        if (refilled >= room) return cap;
        return stored + refilled;
    }

    /// @notice Claim `account`'s slice of a round. Permissionless; the money always goes to `account`.
    function claim(uint256 roundId, address account, uint256 amount, bytes32[] calldata proof) external nonReentrant {
        if (roundId >= rounds.length) revert NoSuchRound();
        if (claimed[roundId][account]) revert AlreadyClaimed();
        Round storage r = rounds[roundId];
        // Once a round's remainder has been RELEASED forward, the grace window is a real deadline: a
        // late claim must NOT pay out, because releaseRound already freed that USDG to back a LATER
        // round, and paying it here would double-spend the same balance (re-audit HIGH-2).
        if (r.released) revert RoundClosed();

        bytes32 leaf = keccak256(bytes.concat(keccak256(abi.encode(roundId, account, amount))));
        if (!MerkleProof.verify(proof, r.root, leaf)) revert BadProof();
        if (uint256(r.claimedTotal) + amount > uint256(r.total)) revert OverRoundTotal();

        claimed[roundId][account] = true;
        r.claimedTotal += uint128(amount);
        reserved -= amount;
        if (amount > 0) rewardToken.safeTransfer(account, amount);
        emit Claimed(roundId, account, amount);
    }

    /// @notice Forward-only release of a round's UNCLAIMED remainder after the grace window, so dust
    ///         and never-claimed allocations are not stranded forever (MED-1). Reduces `reserved`
    ///         (freeing the remainder for the NEXT round's holders); moves NOTHING out of the vault,
    ///         so there is no owner exit. Permissionless (anyone may trigger it once grace elapses).
    ///         The deadline is the round's OWN snapshot, not the current releaseGrace, and it is
    ///         readable in advance via roundDeadline() so a client can warn before it bites.
    function releaseRound(uint256 roundId) external nonReentrant {
        if (roundId >= rounds.length) revert NoSuchRound();
        Round storage r = rounds[roundId];
        if (r.released) revert AlreadyReleased();
        if (block.timestamp < uint256(r.releaseAt)) revert GraceNotElapsed();
        r.released = true;
        uint256 remainder = uint256(r.total) - uint256(r.claimedTotal);
        if (remainder > 0) reserved -= remainder;
        emit RoundReleased(roundId, remainder);
    }

    // --------------------------------------------------------------------------------------------
    // Views
    // --------------------------------------------------------------------------------------------

    function roundCount() external view returns (uint256) {
        return rounds.length;
    }

    /// @notice The timestamp after which round `roundId` may be permissionlessly released forward,
    ///         i.e. the last moment a holder can still claim it. Exposed because a claim deadline the
    ///         claimant cannot see is not a fair deadline (re-audit MEDIUM): clients read this to show
    ///         a countdown instead of silently reverting RoundClosed after the fact.
    function roundDeadline(uint256 roundId) public view returns (uint256) {
        if (roundId >= rounds.length) revert NoSuchRound();
        return uint256(rounds[roundId].releaseAt);
    }

    /// @notice Everything a claim client needs for one round in a single call: the deadline, whether
    ///         the window is still open, and how much of the round is still unclaimed.
    function roundInfo(uint256 roundId)
        external
        view
        returns (
            bytes32 root,
            uint256 total,
            uint256 claimedTotal,
            uint256 postedAt,
            uint256 deadline,
            bool released,
            bool claimable
        )
    {
        if (roundId >= rounds.length) revert NoSuchRound();
        Round storage r = rounds[roundId];
        root = r.root;
        total = uint256(r.total);
        claimedTotal = uint256(r.claimedTotal);
        postedAt = uint256(r.postedAt);
        deadline = uint256(r.releaseAt);
        released = r.released;
        // Claimable means claim() would not be refused for round-level reasons. A round past its
        // deadline but not yet released is still claimable, and that is intentional: the deadline is
        // when a release BECOMES possible, not an automatic close.
        claimable = !r.released;
    }

    /// @dev Saturating: an out-of-band balance reduction below `reserved` reads 0 available rather
    ///      than underflowing (LOW-1; matches the distributor's saturating discipline).
    function _unreserved() internal view returns (uint256) {
        uint256 bal = rewardToken.balanceOf(address(this));
        return bal > reserved ? bal - reserved : 0;
    }

    function unreserved() external view returns (uint256) {
        return _unreserved();
    }

    // --------------------------------------------------------------------------------------------
    // Stray rescue (never the reward token)
    // --------------------------------------------------------------------------------------------

    function rescueToken(IERC20 token, address to) external onlyOwner {
        if (address(token) == address(rewardToken)) revert CannotRescueRewardToken();
        if (to == address(0)) revert ZeroAddress();
        uint256 bal = token.balanceOf(address(this));
        token.safeTransfer(to, bal);
        emit StrayRescued(address(token), to, bal);
    }

    function renounceOwnership() public view override onlyOwner {
        revert OwnershipCannotBeRenounced();
    }
}
