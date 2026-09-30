// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {Ownable2Step} from "@openzeppelin/contracts/access/Ownable2Step.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";

import {Pet721} from "./Pet721.sol";
import {IRewardsSink} from "./IRewardsSink.sol";
import {IPassSignal} from "./IPassSignal.sol";

/// @notice Minimal view of the PetIssuer the vault leans on: it pulls care tokens out of a pet's TBA
///         through the issuer (the on-chain spender) and reads the pet's TBA address.
interface IPetCareSpender {
    function pullCare(uint256 tokenId, uint256 amount) external;
    /// @notice Same pull, but declared as coming from an APPROVED CARER rather than the owner, so the
    ///         TBA can charge it against the carer sub-cap instead of the owner's full daily headroom.
    function pullCareAsCarer(uint256 tokenId, uint256 amount) external;
    function accountOf(uint256 tokenId) external view returns (address);
}

/// @title PetVault
/// @notice WALLETCHI survival economy (LAST PET STANDING). Caring for a pet costs care tokens pulled
///         from the pet's own ERC-6551 account; each care BURNS the burn slice (to the dead address),
///         accrues the pot slice to a growing POT, and routes the optional rewards slice to the sink.
///
///         GAME (FIVE NEEDS). A pet has FIVE independent needs: FEED(0), WATER(1), PLAY(2), TOY(3),
///         EXPLORE(4). Each care action costs `careCost` and refreshes ONLY its own need's timestamp.
///         A pet is DEAD the instant ANY need goes unserved for a full `lifeTtl`: equivalently,
///         `now >= min(the five need stamps) + lifeTtl`. Pure clock, no action, no culling step.
///         Death is PERMANENT (a dead pet can never be cared again, so no one can reanimate a pet to
///         drag the game out). The first care (HATCH) fills all five bowls at once, so the keeper then
///         has exactly one life window to serve EACH need at least once. The LAST pet still alive wins
///         the WHOLE pot into its own TBA. There is no operator and no operator-run close: the game
///         ends when exactly one pet is left.
///
///         THE ROSTER CLOSES ONCE, AT `entryDeadline`. Entering the season (minting a pet, and
///         HATCHING an already-minted egg) is open from `seasonStart` until `entryDeadline`, and shut
///         forever after it. The season can never be DECIDED before `entryDeadline` either, because
///         `_decidesAt()` is floored at it. Those two facts together are the whole point: while anyone
///         can still enter, nobody can win, so a mint can never land into an already-finished season.
///         Before this floor existed the endgame clock armed on the `minPlayers`-th hatch while
///         minting stayed open forever, so a season could be settled on day 2 and every later mint was
///         permanently inert: register() silently no-opped, care() reverted GameOver, and every
///         pointer between the contracts is one-way locked, so nothing could reopen it. 1,990 of 2,000
///         pets could be dead on arrival. After the deadline the roster is frozen, already-hatched
///         pets keep playing normally forever, and an egg that never hatched stays a transferable
///         collectible (never dead, so never soulbound).
///
///         HOW THE CONTRACT KNOWS THE WINNER IN O(1). It does not scan 2000 pets or keep a culled
///         headcount. Each pet's SCORE is its weakest-link stamp: min over its five need timestamps
///         (a pet stays alive until score + lifeTtl). The tracker keeps two facts, updated on every
///         care: `leader` (the pet with the greatest score) and `runnerUpCareAt` (the greatest score
///         of any OTHER hatched pet). The game is over the instant `now >= runnerUpCareAt + lifeTtl`,
///         because at that point every pet except the leader has let at least one need lapse a full
///         life window. finalize() re-checks that on-chain and pays the leader. Gated by
///         hatchedCount >= minPlayers so a lone player can never insta-win. This removes the old
///         operator-close winner-bias entirely: nobody can time or seed a close; the winner is whoever
///         keeps their own pet's every need served longest, in the open, at care cost per action.
///
///         The pot is accounted on the balance actually received (fee-on-transfer safe). A timelocked
///         owner sweep is the backstop for stranded / donated tokens; the live pot is never ruggable.
contract PetVault is Ownable2Step, ReentrancyGuard {
    using SafeERC20 for IERC20;

    /// @notice The canonical burn sink. Care tokens sent here are provably out of circulation.
    address public constant BURN_ADDRESS = 0x000000000000000000000000000000000000dEaD;

    uint256 public constant BPS = 10_000;
    uint256 public constant MIN_LIFE_TTL = 1 hours;
    uint256 public constant MAX_LIFE_TTL = 30 days;

    /// @notice The number of independent needs. Canonical actionType order is LOCKED:
    ///         0=FEED, 1=WATER, 2=PLAY, 3=TOY, 4=EXPLORE. Never reorder.
    uint8 public constant NEED_COUNT = 5;

    /// @notice Upper bound on how long a season must run before it can be decided at all. The
    ///         lower bound is `lifeTtl` itself (see the constructor).
    uint256 public constant MAX_SEASON_DURATION = 365 days;
    uint256 public constant SWEEP_TIMELOCK = 3 days;

    /// @notice Bounds on the season ENTRY WINDOW (seasonStart .. entryDeadline). The lower bound stops
    ///         a fat-fingered one-second window from bricking minting the moment the vault is wired;
    ///         the upper bound reuses the season ceiling so an entry window can never outlive the
    ///         longest legal season. Production policy (a window long enough to mint out a 2000-piece
    ///         collection) is enforced in the deploy script, not here: this contract only refuses
    ///         nonsense so the short-window rehearsal configs stay testable.
    uint256 public constant MIN_ENTRY_WINDOW = 1 hours;
    uint256 public constant MAX_ENTRY_WINDOW = MAX_SEASON_DURATION;

    /// @notice Bounds on `abandonGrace` (a CONSTRUCTOR parameter since season 2: the season-1 deploy
    ///         baked `constant 90 days`, which left a five-pet tester season's 0.5 mock-CARE pot
    ///         solemnly timelocked for three months). The floor keeps the wait meaningful (nobody can
    ///         argue the season was cut short); the ceiling reuses the season bound so an
    ///         under-subscribed pot can never be frozen past the longest legal season.
    uint256 public constant MIN_ABANDON_GRACE = 1 hours;
    uint256 public constant MAX_ABANDON_GRACE = MAX_SEASON_DURATION;

    /// @notice The care token (external ERC-20; any token by address).
    IERC20 public immutable careToken;

    /// @notice The WALLETCHI pet NFT collection (validates ids and bounds the mint phase).
    Pet721 public immutable pet;

    /// @notice The issuer: mints pets, is the TBA spender, and the only address that may register.
    IPetCareSpender public immutable issuer;

    /// @notice Seconds any single NEED may go unserved before the pet dies (the pet dies the instant
    ///          `min(need stamps) + lifeTtl <= now`; the hatch stamps all five needs at once, so each
    ///          need must then be served at least once per life window).
    ///          IMMUTABLE (audit H-2): a tunable lifeTtl was a winner-steering lever (shorten to
    ///          mass-kill + pull the finish line; lengthen to RESURRECT dead pets, breaking permanent
    ///          death). Fixing it at construction removes the lever entirely and makes death truly final.
    uint256 public immutable lifeTtl;

    /// @notice Care token pulled from a pet's TBA on each care() call (raw units).
    uint256 public immutable careCost;

    /// @notice Fraction of each care fee accrued to the pot (basis points).
    ///         potBps + burnBps + rewardsBps + gasBps == BPS.
    uint256 public immutable potBps;

    /// @notice Fraction of each care fee burned to BURN_ADDRESS (basis points). Takes the rounding dust.
    uint256 public immutable burnBps;

    /// @notice Fraction of each care fee routed to the rewards recipient (basis points). 0 disables it.
    uint256 public immutable rewardsBps;

    /// @notice The rewards recipient (RewardsDistributor). address(0) iff rewardsBps == 0.
    address public immutable rewardsRecipient;

    /// @notice Fraction of each care fee routed to the push-gas ops wallet (basis points). The
    ///         season-2 fourth leg (Hunt 2026-08-30): the burn pays for delivering rewards, so the
    ///         reward-push bot's gas is funded by the game itself. 0 disables it.
    uint256 public immutable gasBps;

    /// @notice The push-gas ops wallet. address(0) iff gasBps == 0. Receives CARE (converting to
    ///         native gas is an ops concern, never a contract one).
    address public immutable gasRecipient;

    /// @notice How long after the roster closes an under-subscribed season stays frozen before anyone
    ///         may settle it via abandonSeason(). See MIN/MAX_ABANDON_GRACE.
    uint256 public immutable abandonGrace;

    /// @notice Minimum DISTINCT fed pets before the pot can be won (prevents a trivial one-player win).
    uint256 public immutable minPlayers;

    /// @notice Minimum seconds between EXPLICIT cares of the SAME NEED on a given pet. The cooldown
    ///          is PER NEED, not per pet: five DIFFERENT actions never block each other (even in one
    ///          block), and the hatch broadcast (which fills all five bowls at once) arms a cooldown
    ///          only for the need that actually paid for the hatch. NOTE the changed threat math:
    ///          under per-need semantics a rotating carer can land up to five cares per cooldown
    ///          window per pet, so this is no longer the drain bound; the TBA dailyCap is the spend
    ///          brake, and the carer min-need rule (see the CarerApproval natspec) makes every forced
    ///          care serve the pet's weakest need. Ships at 0 (no cooldown).
    uint256 public immutable careCooldown;

    /// @notice When this vault was deployed, and the shortest possible season measured from it.
    ///         `_decidesAt()` is floored at seasonStart + minSeasonDuration.
    uint256 public immutable seasonStart;
    uint256 public immutable minSeasonDuration;

    /// @notice THE ROSTER CLOSE. The instant the season stops accepting new entrants, measured
    ///         absolutely (seasonStart + the constructor's entryWindowSecs). It does exactly three
    ///         things, and they are three faces of one rule:
    ///           1. PetIssuer.issuePet REVERTS from here on, so no pet is ever minted into a season it
    ///              cannot play. It reverts rather than minting an inert token, because the previous
    ///              behaviour (mint, then silently skip registration) produced a collectible the buyer
    ///              could never feed and could not tell apart from a live pet.
    ///           2. care() refuses to HATCH an egg from here on (already-hatched pets are untouched),
    ///              so a pet cannot sit dormant through the whole season and then enter with a full
    ///              fresh life window and take the leader seat from everyone who actually played.
    ///           3. `_decidesAt()` is FLOORED here, so the season is provably undecidable while entry
    ///              is still open. This is the half that makes 1 and 2 safe rather than merely tidy:
    ///              it is what guarantees a mint accepted at entryDeadline - 1 lands in a season that
    ///              is still running.
    ///         IMMUTABLE on purpose: a settable roster close would be a winner-steering lever (shut
    ///         entry early to freeze out rivals, or extend it to keep resetting the finish line).
    uint256 public immutable entryDeadline;

    /// @notice THE SEASON MODEL (see Params.selloutStartsSeason). True: the season starts when the
    ///         collection mints out. False: the season is live from deployment and `entryDeadline`
    ///         is the roster close. Immutable, because it decides what every timestamp in this
    ///         contract MEANS.
    bool public immutable selloutStartsSeason;

    /// @notice The instant the season actually started: the roster closed and every registered pet's
    ///         five need clocks began TOGETHER. Under the clock model this is the deployment
    ///         timestamp, set in the constructor. Under the sellout model it is 0 until `startSeason`
    ///         and is the single anchor every deadline is measured from afterwards.
    ///
    ///         WHY 0 IS SAFE AS "NOT STARTED": care() refuses outright while it is 0, so no need
    ///         stamp, no leader and no pot can exist before it is set, and `_decidesAt()` returns
    ///         "never" so the season is provably undecidable while the collection is still minting.
    uint64 public seasonStartedAt;

    /// @notice Prize owed to a winning pet whose payout could not be delivered at finalize().
    ///         Escrowed for a permissionless `pushPrize` retry to the pet's resolved payout address.
    ///         The token owner can select an alternate receiver in Pet721 if its TBA is unreachable.
    mapping(uint256 => uint256) public unpaidPrize;

    /// @notice Sum of every outstanding `unpaidPrize`. Reserved from the timelocked sweep so a prize
    ///         a hostile token merely delayed can never be swept as residual.
    uint256 public totalUnpaidPrize;

    /// @notice Care tokens actually RECEIVED by prize recipients (finalize plus any later pushPrize).
    ///         Zero for a prize that was deferred and not yet claimed. A fee-on-transfer token can
    ///         make this smaller than `prizeDebited`.
    uint256 public prizePaid;

    /// @notice Gross care-token balance debited from this vault by prize-transfer attempts that
    ///         produced a measurable recipient credit. This keeps vault-flow accounting exact even
    ///         when an ERC-20 charges a transfer fee. It is deliberately distinct from `prizePaid`:
    ///         return bytes are untrusted and the recipient balance delta is the payment proof.
    uint256 public prizeDebited;

    /// @notice The accumulated prize pot (care-token raw units).
    uint256 public pot;

    /// @notice Lifetime care tokens sent to the burn sink this season (raw units).
    uint256 public totalBurned;

    /// @notice Lifetime care tokens routed to the rewards recipient this season (raw units sent).
    uint256 public totalRewards;

    /// @notice Lifetime care tokens routed to the push-gas wallet this season (raw units sent).
    uint256 public totalGas;

    /// @notice Pets ever registered (minted into the vault) this season.
    uint256 public registeredCount;

    /// @notice Distinct pets that have been fed at least once (entered the survival race). The win is
    ///          gated on this reaching minPlayers so a lone hatched pet can never insta-claim.
    uint256 public hatchedCount;

    /// @notice True once the pot has been won and paid to the last pet standing: the game is over.
    bool public potClaimed;

    // ---- Last-pet-standing tracker (the whole endgame, maintained O(1) on every care) -------------
    // NOTE: since the five-needs redesign these three slots track MIN-NEED timestamps (each pet's
    // weakest-link stamp, min over its five need timers), not last-care times. Names and types are
    // kept for ABI stability.

    /// @notice The pet with the greatest SCORE (min-need timestamp): the standing winner. 0 until the
    ///          first care. Caring no longer auto-takes this seat: a care that leaves a pet's weakest
    ///          need old leaves its score old.
    /// @dev     TIES KEEP THE INCUMBENT. The takeover test is STRICTLY greater (`newScore >
    ///          leaderCareAt`), so a challenger that merely matches the leader's score does not take
    ///          the seat, and neither pet's clock is disturbed. This is deliberate and it is what
    ///          makes the O(1) two-slot reduction exact: an equal-score challenger is recorded as the
    ///          runner-up instead, `runnerUpCareAt` therefore equals `leaderCareAt`, and `_decidesAt()`
    ///          will not let the season resolve until BOTH have lapsed. A tie can never silently
    ///          resolve in the challenger's favour, and it can never resolve early.
    uint256 public leader;

    /// @notice `leader`'s SCORE: its min-need timestamp (cached so the win check is one comparison).
    uint64 public leaderCareAt;

    /// @notice The greatest SCORE (min-need timestamp) of any hatched pet OTHER than the leader. The
    ///          game is over once this is a full lifeTtl in the past (no non-leader pet is still
    ///          alive: every rival has let at least one need lapse a full life window).
    uint64 public runnerUpCareAt;

    /// @notice When the season became CONTESTED: the moment `hatchedCount` first reached `minPlayers`.
    ///          0 until then.
    /// @dev    THIS EXISTS TO STOP A SPARSE START FROM ENDING THE SEASON INSTANTLY. `runnerUpCareAt`
    ///          only ever tracks pets that have been FED, so on the very feed that reaches minPlayers it
    ///          is assigned the PREVIOUS hatcher's care time. If those two hatches were more than a
    ///          lifeTtl apart, which is the ordinary shape of a slow launch and needs no attacker, the
    ///          old predicate `now >= runnerUpCareAt + lifeTtl` was true the instant that transaction
    ///          landed. The season would end on its third ever feed, and because care() and register()
    ///          both revert GameOver afterwards, every pet would starve and soulbound itself with no
    ///          recovery (issuer, vault and vaultRef are all one-way locked). The endgame clock must
    ///          therefore never start before the game is actually contested. Pinned by
    ///          SparseHatchFreeze.t.sol.
    uint64 public contestedAt;

    // Timelocked sweep queue (stranded / donated token backstop).
    address public sweepToken;
    address public sweepTo;
    uint256 public sweepAmount;
    uint256 public sweepReadyAt;

    /// @dev Two storage slots per pet. Slot 0: registered + careCount + bornAt + needFeedAt +
    ///      needWaterAt + servedMask (30/32 bytes). Slot 1: needPlayAt + needToyAt + needExploreAt
    ///      (24/32 bytes). There is deliberately NO cached min-need field: every death check loads
    ///      both slots anyway, so a cache would save zero SLOADs and add a drift invariant.
    ///      Derivation (_minNeedAt) is the safety choice.
    struct Pet {
        bool registered; // ever joined the season
        uint32 careCount; // successful care actions, all needs ("cared X times")
        uint64 bornAt; // block.timestamp of registration (for "lived N days")
        uint64 needFeedAt; // actionType 0: last FEED;    0 until hatch
        uint64 needWaterAt; // actionType 1: last WATER;   0 until hatch
        /// @dev Which needs have been EXPLICITLY cared at least once (bit i = actionType i). The
        ///      cooldown anchors on this, NOT on the hatch broadcast: the hatch fills all five bowls
        ///      (deadline anchors) but arms a cooldown only for the need that paid for it, so caring a
        ///      different need right after hatch is never cooldown-blocked and five DIFFERENT actions
        ///      back-to-back are always allowed. Inert when careCooldown == 0 (the shipped config).
        uint8 servedMask;
        // slot boundary: 30 bytes above in slot 0
        uint64 needPlayAt; // actionType 2: last PLAY;    0 until hatch
        uint64 needToyAt; // actionType 3: last TOY;     0 until hatch
        uint64 needExploreAt; // actionType 4: last EXPLORE; 0 until hatch
    }

    mapping(uint256 => Pet) internal _pets;

    /// @dev THE SHARED START LINE. Every need stamp is read as at least this value, so under the
    ///      sellout model a pet that has never been cared reads as if all five of its needs were
    ///      served at the sellout instant. That is what starts 2,000 clocks simultaneously without
    ///      touching 2,000 storage slots: the baseline is one SLOAD, not a per-pet write.
    ///      0 under the clock model, so every read below is byte-for-byte the original behaviour.
    function _baseline() internal view returns (uint64) {
        return selloutStartsSeason ? seasonStartedAt : 0;
    }

    /// @dev Is this pet's survival clock RUNNING? Under the sellout model every registered pet is in
    ///      the race the instant the season starts, fed or not. Under the clock model a pet enters
    ///      only by hatching. This is the one place that difference is expressed; `alive`, `_isDead`
    ///      and the care death-guard all defer to it rather than re-deriving it.
    function _inPlay(Pet storage p) internal view returns (bool) {
        if (!p.registered) return false;
        return selloutStartsSeason ? seasonStartedAt != 0 : p.careCount > 0;
    }

    /// @dev The pet's weakest-link timestamp: min of the five need stamps, floored at the shared
    ///      start line. 0 for a dormant egg under the clock model (all five are 0). This is the ONLY
    ///      deadline anchor: the pet dies at _minNeedAt(p) + lifeTtl.
    function _minNeedAt(Pet storage p) internal view returns (uint64 m) {
        m = p.needFeedAt;
        if (p.needWaterAt < m) m = p.needWaterAt;
        if (p.needPlayAt < m) m = p.needPlayAt;
        if (p.needToyAt < m) m = p.needToyAt;
        if (p.needExploreAt < m) m = p.needExploreAt;
        uint64 base = _baseline();
        if (m < base) m = base;
    }

    /// @dev Read one need stamp by canonical actionType (0..4), floored at the shared start line.
    ///      Caller has validated actionType.
    function _needAt(Pet storage p, uint8 actionType) internal view returns (uint64 v) {
        if (actionType == 0) v = p.needFeedAt;
        else if (actionType == 1) v = p.needWaterAt;
        else if (actionType == 2) v = p.needPlayAt;
        else if (actionType == 3) v = p.needToyAt;
        else v = p.needExploreAt;
        uint64 base = _baseline();
        if (v < base) v = base;
    }

    /// @dev Write one need stamp by canonical actionType (0..4). Caller has validated actionType.
    function _setNeed(Pet storage p, uint8 actionType, uint64 t) internal {
        if (actionType == 0) p.needFeedAt = t;
        else if (actionType == 1) p.needWaterAt = t;
        else if (actionType == 2) p.needPlayAt = t;
        else if (actionType == 3) p.needToyAt = t;
        else p.needExploreAt = t;
    }

    /// @notice An owner-approved carer: an address the pet's owner has authorized to call care() for
    ///         them, and NOTHING else. This is what lets a keeper tap a link in their wallet pass and
    ///         have the pet fed with no signature, from ANY wallet (an off-chain session key can only
    ///         be granted by wallets that expose EIP-7702 authorization signing, which browser
    ///         extension wallets deliberately do not).
    ///
    ///         SAFETY, and the whole reason this is not the retired global relayer:
    ///         1. OPT IN, PER PET. Only ownerOf(tokenId) can set it. A pet whose owner never calls
    ///            setCarer keeps exactly the owner-only guarantee it has today.
    ///         2. NO NEW POWER, AND STRICTLY LESS CHOICE. A carer can only do what the owner could
    ///            already do, minus two freedoms.
    ///            (a) NEED CHOICE: a carer may only care a need that is currently the pet's WEAKEST
    ///                (its stamp equals the pet's min-need; any tied-at-min need qualifies; anything
    ///                else reverts CarerMustServeMinNeed). Owners are unrestricted. Without this a
    ///                hostile carer could burn the shared dailyCap on ONE need and let the other four
    ///                lapse. With it, every forced care serves a weakest need, so a carer can never
    ///                reduce the pet's time-to-death.
    ///            (b) BUDGET: a carer's spend is charged against a SUB-CAP of the pet account's
    ///                rolling daily allowance (WalletchiAccount.carerDailyCap, a fixed fraction of
    ///                dailyCap), never the whole of it.
    ///            WHY (b) EXISTS, AND WHAT THIS NATSPEC USED TO GET WRONG. It used to claim a carer
    ///            could grief but "never a kill". That was FALSE at the live parameters. The pet
    ///            account's spend window is exactly 1 day, and the live lifeTtl was exactly 1 day too.
    ///            A carer could force the account's window to roll, burn the ENTIRE dailyCap in that
    ///            instant (legally, serving weakest needs throughout), and the owner's allowance then
    ///            unlocked at windowStart + 1 day while the pet died at that same instant: zero
    ///            seconds of warning, a deterministic kill by an approved carer. The sub-cap removes
    ///            it structurally rather than by parameter choice: a carer that spends every unit it
    ///            is allowed still leaves the owner a guaranteed remainder of the daily cap IN THE
    ///            SAME WINDOW, so the owner can always feed back. (Deployments should ALSO set
    ///            lifeTtl strictly greater than the account's 1 day spend window, which the deploy
    ///            script now requires, so even a self-inflicted full-cap burn by the OWNER frees up
    ///            before the pet's own deadline.) A carer can never transfer the pet, and it cannot
    ///            move the pet's tokens anywhere except through this contract's own burn / pot /
    ///            rewards split. Nothing ever reaches the carer. The honest ceiling is grief: burning
    ///            part of the pet's stake through the sub-cap. That is stake loss, never theft, and
    ///            no longer a kill.
    ///         3. DIES ON TRANSFER, BY CONSTRUCTION. `setBy` records the owner who granted it, and an
    ///            approval only counts while setBy is still the current owner. So a sale, a gift, or any
    ///            transfer silently voids it with no hook in Pet721, no cross-contract call, and no way
    ///            to forget. Without this, a seller could keep griefing a buyer's pet forever, which is
    ///            precisely the confused-deputy shape this design exists to avoid.
    ///         4. EXPIRES. A forgotten approval stops working on its own.
    ///
    ///         KNOWN, DELIBERATE EDGE: because the check is "setBy is still the owner", an approval
    ///         that went dormant on a sale becomes live again if that SAME owner reacquires the pet.
    ///         That is not third-party exploitable (the beneficiary is the carer this exact owner
    ///         chose, on a pet this exact owner holds, revocable at will). Making it never revive would
    ///         require a per-token transfer counter in Pet721, which adds gas to every transfer and
    ///         re-touches an audited hot path to close an edge no attacker can reach. Tested explicitly
    ///         in CarerRegistry.t.sol so the behaviour is a decision on the record, not an accident.
    struct CarerApproval {
        address carer; // may call care() for this pet
        address setBy; // the owner at approval time; must still be the owner for it to count
        uint64 expiresAt; // 0 means no expiry
    }

    mapping(uint256 => CarerApproval) internal _carers;

    event Registered(uint256 indexed tokenId, uint256 registeredCount);
    event CarerSet(uint256 indexed tokenId, address indexed carer, address indexed setBy, uint64 expiresAt);
    event Care(
        uint256 indexed tokenId,
        uint8 actionType,
        uint256 cost,
        uint256 burned,
        uint256 potContribution,
        uint256 rewardsContribution,
        uint256 gasContribution,
        uint256 potAfter
    );
    event LeaderChanged(uint256 indexed leader, uint64 leaderCareAt, uint64 runnerUpCareAt);
    event Victory(uint256 indexed tokenId, address indexed recipient, uint256 prize);

    /// @notice A pet was minted after the season was decided, so it was never registered and can
    ///         never be fed. Emitted instead of reverting, so the collection can still complete.
    event RegisterSkipped(uint256 indexed tokenId);

    /// @notice The winner's prize could not be transferred (a hostile or paused care token) and is
    ///         being held in escrow for a permissionless `pushPrize` retry. The season is still
    ///         settled, and the winner never has to claim anything (season-2 no-claims law).
    event PrizeDeferred(uint256 indexed tokenId, uint256 amount);
    event PrizePushed(uint256 indexed tokenId, address indexed recipient, uint256 amount);

    /// @notice The season closed its roster with fewer than `minPlayers` hatched pets and was settled
    ///         by the permissionless recovery path instead of the ordinary endgame. `leader` is 0 only
    ///         when literally no pet ever hatched, in which case `prize` is 0 as well.
    event SeasonAbandoned(uint256 indexed leader, uint256 hatchedCount, uint256 prize);

    /// @notice The roster closed and every registered pet's clock started, together, at `startedAt`.
    event SeasonStarted(uint64 startedAt, uint256 minted, uint256 registeredCount);
    event SweepQueued(address indexed token, address indexed to, uint256 amount, uint256 readyAt);
    event SweepCancelled();
    event SweepExecuted(address indexed token, address indexed to, uint256 amount);

    error OwnershipCannotBeRenounced();
    error NotAuthorizedCarer();
    error NotIssuer();
    error ZeroAddress();
    error BadToken();
    error DependencyNotContract(address dependency);
    error AlreadyRegistered();
    error NotRegistered();
    error NotCareable();
    error PetIsDead(); // care() attempted on a pet with a lapsed need (permanent death)
    error CareOnCooldown();
    error BadAction(); // actionType >= NEED_COUNT: no such need, so nothing to reset (charge refused)
    error CarerMustServeMinNeed(); // an approved carer may only care a currently-weakest need
    error GameOver();
    error GameNotOver(); // finalize() attempted before the last pet is standing
    error NotEnoughPlayers();
    error EntryWindowClosed(); // the roster closed at entryDeadline: no new pet may hatch
    error EntryWindowOutOfBounds();
    error SeasonNotStarted(); // care() before the collection minted out (sellout model)
    error SeasonAlreadyStarted(); // startSeason() twice
    error SelloutRequired(); // non-owner called startSeason() before the collection minted out
    error SeasonNotAbandoned(); // abandonSeason() before the grace elapsed, or on a viable season
    error LifeTtlOutOfBounds();
    error BadBps();
    error BadConfig();
    error NoSweepQueued();
    error SweepTimelocked();
    error SweepExceedsSurplus();
    error NothingToPush(); // pushPrize() with no deferred prize owed (or none payable right now)
    error PrizeTransferFailed(); // pushPrize() produced no measurable balance increase at the recipient

    struct Params {
        IERC20 careToken;
        Pet721 pet;
        IPetCareSpender issuer;
        address owner;
        uint256 lifeTtl;
        uint256 careCost;
        uint256 potBps;
        uint256 burnBps;
        uint256 rewardsBps;
        address rewardsRecipient;
        /// @dev The season-2 fourth leg: push-gas bps + its ops wallet. 0 / address(0) disables it.
        uint256 gasBps;
        address gasRecipient;
        /// @dev How long an under-subscribed season stays frozen before abandonSeason() may settle
        ///      it. A REQUIRED parameter (no zero-means-default) for the same forcing-function reason
        ///      as entryWindowSecs: season 1 shipped a baked 90 days and guarded half a mock token
        ///      for three months.
        uint256 abandonGrace;
        uint256 minPlayers;
        uint256 careCooldown;
        uint256 minSeasonDuration;
        /// @dev Seconds from seasonStart during which the season accepts new entrants (mints and
        ///      hatches). Becomes the immutable `entryDeadline`. Required, with no zero-means-default
        ///      shortcut, so that adding it is a COMPILE-TIME forcing function: every deployment and
        ///      every harness has to state its roster close on purpose.
        ///      IGNORED as a hatch gate when `selloutStartsSeason` is true (the sellout IS the roster
        ///      close); still constructor-validated so one config path cannot silently go unchecked.
        uint256 entryWindowSecs;
        /// @dev THE SEASON MODEL. False is the original: the season is live from deployment and the
        ///      roster closes on the clock at `entryDeadline`. True is the SELLOUT model: nothing can
        ///      hatch or feed until the collection has minted out, and every pet's five need clocks
        ///      then start at that ONE instant.
        ///
        ///      WHY THE SELLOUT MODEL EXISTS. On the clock model a pet's life window starts when its
        ///      own keeper first feeds it, so a collection that mints over days has its earliest
        ///      buyers dying while it is still selling, and a late entrant hatches with a full fresh
        ///      window against keepers who have been paying care costs since day one. Both are the
        ///      same defect: the start line moved per player. Starting every clock at the sellout
        ///      makes the race simultaneous by construction and removes the hatch-snipe advantage
        ///      that `entryDeadline` could only ever bound, never eliminate.
        bool selloutStartsSeason;
    }

    /// @param p packed constructor config (see Params). Bounds enforced below.
    constructor(Params memory p) Ownable(p.owner) {
        if (address(p.careToken) == address(0) || address(p.pet) == address(0) || address(p.issuer) == address(0)) {
            revert ZeroAddress();
        }
        // The care token must be a real contract. A raw call to a CODELESS address succeeds and
        // returns nothing. The payout path measures the recipient's balance change rather than
        // trusting returndata, but pinning code here still stops a mistyped address from reaching
        // every other token interaction and balance read.
        if (address(p.careToken).code.length == 0) revert BadToken();
        // These immutable dependencies are called throughout the pet lifecycle. Accepting an EOA
        // here would permanently brick registration, ownership checks, or care spending, and a
        // rewards EOA would silently consume a live fee leg without providing accounting hooks.
        if (address(p.pet).code.length == 0) revert DependencyNotContract(address(p.pet));
        if (address(p.issuer).code.length == 0) revert DependencyNotContract(address(p.issuer));
        if (p.lifeTtl < MIN_LIFE_TTL || p.lifeTtl > MAX_LIFE_TTL) revert LifeTtlOutOfBounds();
        if (p.careCost == 0) revert BadConfig();
        // Four-leg split: pot + burn + rewards + gas must partition the whole fee.
        if (p.potBps + p.burnBps + p.rewardsBps + p.gasBps != BPS) revert BadBps();
        // A live rewards leg needs a real recipient (and none is needed when the leg is disabled).
        if (p.rewardsBps > 0 && p.rewardsRecipient == address(0)) revert ZeroAddress();
        if (p.rewardsBps > 0 && p.rewardsRecipient.code.length == 0) {
            revert DependencyNotContract(p.rewardsRecipient);
        }
        // Same rule for the gas leg, both directions: enabled needs a wallet, disabled must not
        // carry one (a recipient with no leg is a config typo worth refusing loudly).
        if (p.gasBps > 0 && p.gasRecipient == address(0)) revert ZeroAddress();
        if (p.gasBps == 0 && p.gasRecipient != address(0)) revert BadConfig();
        // Guarantee every care contributes at least 1 unit to the pot (no silent zero-pot).
        if (p.careCost * p.potBps < BPS) revert BadConfig();
        // Equivalent dust guard for the rewards leg: when enabled it must yield at least 1 unit.
        if (p.rewardsBps > 0 && p.careCost * p.rewardsBps < BPS) revert BadConfig();
        // And for the gas leg.
        if (p.gasBps > 0 && p.careCost * p.gasBps < BPS) revert BadConfig();
        if (p.abandonGrace < MIN_ABANDON_GRACE || p.abandonGrace > MAX_ABANDON_GRACE) {
            revert BadConfig();
        }
        if (p.minPlayers < 2) revert BadConfig();
        // careCooldown == 0 is ALLOWED (Hunt 2026-08-17: no cooldown, feed as often as you like). The
        // per-pet dailyCap on the TBA remains the spend brake; owner-only care means rapid feeding only
        // spends the owner's own CARE faster. Still must be < lifeTtl so a cooldown can never outlast a
        // life window.
        if (p.careCooldown >= p.lifeTtl) revert BadConfig();
        // The season cannot be decided before this much time has passed, no matter what the
        // care timers say. Without it, minPlayers pets fed once on day 0 arm the endgame on
        // day 0, and one quiet life window later the season is over with the collection barely
        // minted. minPlayers counts PETS, not owners, and mints are free, so that is a cheap
        // buy rather than an exotic attack.
        //
        // The floor scales with the life window rather than being a fixed number of days: at
        // minimum a season must outlast one full life window, which is the shortest interval
        // that can possibly decide it. Deployments are expected to set this far higher (the
        // deploy script defaults to 14 days); this bound only stops a nonsense config.
        if (p.minSeasonDuration < p.lifeTtl || p.minSeasonDuration > MAX_SEASON_DURATION) {
            revert BadConfig();
        }
        // THE ROSTER CLOSE. Bounded only against nonsense here (see MIN_ENTRY_WINDOW): a zero or
        // one-second window would shut minting before a single pet could be issued, and a window
        // longer than the longest legal season would hold the finish line open past it. The
        // production-scale value (long enough to actually mint out the collection) is a deploy-script
        // policy, because this contract is also deployed at rehearsal scale in the test matrix.
        if (p.entryWindowSecs < MIN_ENTRY_WINDOW || p.entryWindowSecs > MAX_ENTRY_WINDOW) {
            revert EntryWindowOutOfBounds();
        }

        careToken = p.careToken;
        pet = p.pet;
        issuer = p.issuer;
        lifeTtl = p.lifeTtl;
        careCost = p.careCost;
        potBps = p.potBps;
        burnBps = p.burnBps;
        rewardsBps = p.rewardsBps;
        rewardsRecipient = p.rewardsRecipient;
        gasBps = p.gasBps;
        gasRecipient = p.gasRecipient;
        abandonGrace = p.abandonGrace;
        minPlayers = p.minPlayers;
        careCooldown = p.careCooldown;
        minSeasonDuration = p.minSeasonDuration;
        seasonStart = block.timestamp;
        entryDeadline = block.timestamp + p.entryWindowSecs;
        selloutStartsSeason = p.selloutStartsSeason;
        // Under the clock model the season is live the moment it is deployed, so the anchor is now
        // and every read below behaves exactly as it always has. Under the sellout model it stays 0
        // until the collection mints out (or the owner starts a season that already has enough
        // players), which is what makes "nothing can hatch or feed yet" a state rather than a rule
        // scattered across call sites.
        if (!p.selloutStartsSeason) seasonStartedAt = uint64(block.timestamp);
        // The sellout can only ever start a season that is a real race: a collection whose entire
        // supply is smaller than the player minimum could mint out and still never be decidable,
        // which would lock every care fee in the pot forever.
        if (p.selloutStartsSeason && p.pet.maxSupply() < p.minPlayers) revert BadConfig();
    }

    // --------------------------------------------------------------------------------------------
    // Admin
    // --------------------------------------------------------------------------------------------

    // NOTE (audit access-H-1): there is NO care relayer. care() is owner-only, so no privileged key can
    // force-care a rival's pet. In production the owner signs a gas-sponsored UserOp (ERC-4337/EIP-7702)
    // via the embedded wallet, so caring is gasless AND trustless. NOTE (audit H-2): lifeTtl is immutable
    // (no setLifeTtl / lockConfig) so the owner cannot shorten it to mass-kill or lengthen it to resurrect.

    // Timelocked sweep for DONATED / surplus tokens only. Two-step with a SWEEP_TIMELOCK. The care-token
    // sweep is strictly surplus-only (balanceOf minus the live pot) until the pot is claimed, so the pot
    // is never owner-touchable while the game is live (audit econ-F1: the old stranded-pot burn could
    // destroy a pot a still-alive unfed pet could revive, so it was removed). A genuinely stranded pot
    // just stays locked in the vault; it is never burned and never handed to the sweep recipient.

    function queueSweep(address token, address to, uint256 amount) external onlyOwner {
        if (to == address(0)) revert ZeroAddress();
        sweepToken = token;
        sweepTo = to;
        sweepAmount = amount;
        sweepReadyAt = block.timestamp + SWEEP_TIMELOCK;
        emit SweepQueued(token, to, amount, sweepReadyAt);
    }

    function cancelSweep() external onlyOwner {
        sweepReadyAt = 0;
        emit SweepCancelled();
    }

    function executeSweep() external onlyOwner nonReentrant {
        if (sweepReadyAt == 0) revert NoSweepQueued();
        if (block.timestamp < sweepReadyAt) revert SweepTimelocked();
        address token = sweepToken;
        address to = sweepTo;
        uint256 amount = sweepAmount;
        sweepReadyAt = 0;

        // The LIVE pot is unruggable: a careToken sweep may take only genuine surplus (donated dust,
        // above the pot), UNLESS the pot is finished (potClaimed): then the residual is sweepable. The
        // pot is NEVER owner-touchable while the game is live (audit econ-F1: the old _unwinnable-burn
        // could destroy a pot a still-alive unfed pet could revive, so it was removed). A genuinely
        // stranded under-subscribed pot simply stays locked in the vault; it is never handed out.
        // A deferred prize is the WINNER's money, not residual, so it is reserved from the sweep in
        // both phases. Without this the owner could sweep a prize a hostile token merely delayed.
        if (token == address(careToken)) {
            uint256 remaining = careToken.balanceOf(address(this));
            uint256 reserved = potClaimed ? totalUnpaidPrize : pot + totalUnpaidPrize;
            uint256 surplus = remaining > reserved ? remaining - reserved : 0;
            if (amount > surplus) revert SweepExceedsSurplus();
        }

        IERC20(token).safeTransfer(to, amount);
        emit SweepExecuted(token, to, amount);
    }

    // --------------------------------------------------------------------------------------------
    // Lifecycle
    // --------------------------------------------------------------------------------------------

    /// @notice Register a freshly minted pet. Issuer only, called from issuePet. Starts the life timer
    ///         The pet is a DORMANT egg until its first care: the death clock starts on HATCH (first
    ///         care), not at mint (audit death-F1), so a never-fed egg is transferable, not a bricked
    ///         soulbound memorial.
    ///
    ///         Registration NO-OPS once the season is decided, rather than reverting. This is the
    ///         difference between "the game is finished" and "the product is destroyed". register()
    ///         is called unconditionally by issuePet, and Pet721.issuer, PetIssuer.vault and
    ///         Pet721.vault are all ONE-WAY LOCKED, so a revert here means no further NFT in the
    ///         collection can ever be minted by anyone, with no recovery short of redeploying every
    ///         contract. A single quiet life window during a soft launch was enough to trigger it.
    ///
    ///         SINCE THE ROSTER CLOSE, THAT NO-OP IS UNREACHABLE FROM issuePet AND IS PURE BELT AND
    ///         BRACES. PetIssuer.issuePet reverts once `block.timestamp >= entryDeadline`, and
    ///         `_decidesAt()` is floored at `entryDeadline`, so any call that gets this far is at a
    ///         timestamp strictly before entryDeadline, hence strictly before the earliest instant
    ///         `isOver()` or `potClaimed` can be true. The branch is KEPT anyway: it costs one SLOAD,
    ///         it is the only thing standing between a hand-wired or third-party issuer and the
    ///         collection-bricking revert described above, and defence in depth on a one-way-locked
    ///         pointer is worth more than the gas. An unregistered pet can never be fed and can never
    ///         win; it is a collectible.
    function register(uint256 tokenId) external {
        if (msg.sender != address(issuer)) revert NotIssuer();
        if (potClaimed || isOver()) {
            emit RegisterSkipped(tokenId);
            return;
        }
        // Defence in depth on the roster close, mirroring the branch above: PetIssuer already asks
        // entryOpen() before minting, so a pet can only reach here while entry is open. A hand-wired
        // or third-party issuer must not be able to register a pet into a season that has already
        // started, because its clock would begin mid-race at a baseline everyone else has long since
        // had to defend.
        if (selloutStartsSeason && seasonStartedAt != 0) {
            emit RegisterSkipped(tokenId);
            return;
        }
        if (tokenId == 0 || tokenId > pet.totalMinted()) revert BadToken();

        Pet storage p = _pets[tokenId];
        if (p.registered) revert AlreadyRegistered();

        p.registered = true;
        p.bornAt = uint64(block.timestamp);
        // All five need stamps stay 0 until the first care (hatch): a dormant egg has no timers yet.
        registeredCount += 1;

        emit Registered(tokenId, registeredCount);
    }

    /// @notice Is the roster still open to new entrants? PetIssuer asks this before every mint, so
    ///         the two season models share ONE definition of "entry is open" instead of the issuer
    ///         hard-coding a clock the vault might not be using.
    function entryOpen() public view returns (bool) {
        return selloutStartsSeason ? seasonStartedAt == 0 : block.timestamp < entryDeadline;
    }

    /// @notice START THE SEASON: close the roster and begin every registered pet's five need clocks
    ///         at this one instant. Sellout model only.
    ///
    ///         PERMISSIONLESS once the collection has minted out, which is the intended path and
    ///         needs no privileged key: the sellout is a public on-chain fact anyone can prove by
    ///         calling this.
    ///
    ///         OWNER-CALLABLE once `minPlayers` pets are registered, which is two things at once. It
    ///         is the testnet affordance (a 2,000-pet collection cannot wait for 2,000 testers, so a
    ///         small season is started as soon as it is a real race), and it is the mainnet failsafe
    ///         for a mint that stalls above the minimum: without it a collection that never quite
    ///         sells out would leave every keeper holding an egg that can never play. It cannot be
    ///         used to steer a winner, because at this instant no pet has ever been fed: there is no
    ///         leader, no pot and no score to protect. All it can do is make the race start.
    function startSeason() external {
        if (!selloutStartsSeason) revert BadConfig();
        if (seasonStartedAt != 0) revert SeasonAlreadyStarted();
        uint256 minted = pet.totalMinted();
        if (minted < pet.maxSupply()) {
            if (msg.sender != owner()) revert SelloutRequired();
            if (registeredCount < minPlayers) revert NotEnoughPlayers();
        }
        uint64 startedAt = uint64(block.timestamp);
        seasonStartedAt = startedAt;
        // The race is contested from the start line by definition: every registered pet is in it, so
        // there is no sparse-start window for `contestedAt` to protect against here.
        contestedAt = startedAt;
        emit SeasonStarted(startedAt, minted, registeredCount);
        _signalAllPasses(); // every pass's five clocks just started
    }

    /// @notice Authorize `carer` to call care() for your pet, and nothing else. Pass address(0) to
    ///         revoke. Only the pet's CURRENT owner may call this.
    /// @dev    This is the wallet-agnostic half of one-tap care: any wallet can send this ordinary
    ///         transaction, whereas an off-chain session key requires EIP-7702 authorization signing
    ///         that browser extension wallets do not expose to sites.
    /// @param expiresAt Unix seconds after which the approval stops counting; 0 for no expiry. A past
    ///         timestamp is rejected so a typo cannot silently create a dead approval.
    function setCarer(uint256 tokenId, address carer, uint64 expiresAt) external {
        address petOwner = pet.ownerOf(tokenId);
        if (msg.sender != petOwner) revert NotAuthorizedCarer();
        if (expiresAt != 0 && uint256(expiresAt) <= block.timestamp) revert BadConfig();
        // The owner may approve a carer for a pet that has not been registered or has already died;
        // care() applies its own registration, death, cooldown and game-over rules regardless, so there
        // is nothing extra to gate here.
        _carers[tokenId] = CarerApproval({carer: carer, setBy: petOwner, expiresAt: expiresAt});
        emit CarerSet(tokenId, carer, petOwner, expiresAt);
    }

    /// @notice The address currently allowed to feed `tokenId` on the owner's behalf, or address(0).
    ///         Returns address(0) once the pet changes hands or the approval expires, so a stale
    ///         approval is never visible as live.
    function carerOf(uint256 tokenId) external view returns (address) {
        // A dead pet can never be cared for again, so reporting a live carer would make any UI reading
        // this say "one-tap care is on" about a pet nothing can help. It also never auto-voids, because
        // a dead pet is soulbound and so `setBy` can never stop being the owner.
        if (_isDead(_pets[tokenId])) return address(0);
        return _activeCarer(tokenId, pet.ownerOf(tokenId));
    }

    /// @dev The approval counts only while the owner who granted it still owns the pet. That single
    ///      comparison is what makes a sale void the seller's carer with no transfer hook anywhere.
    function _activeCarer(uint256 tokenId, address petOwner) internal view returns (address) {
        CarerApproval storage a = _carers[tokenId];
        if (a.carer == address(0)) return address(0);
        if (a.setBy != petOwner) return address(0); // the pet changed hands: the approval is void
        if (a.expiresAt != 0 && block.timestamp >= uint256(a.expiresAt)) return address(0);
        return a.carer;
    }

    /// @notice Care for a pet: pull `careCost` care token from its TBA (through the issuer spender),
    ///         burn the burn slice, accrue the pot slice, route the rewards slice, and refresh ONLY
    ///         the targeted need's timestamp (`actionType`). The FIRST successful care HATCHES the
    ///         pet: it fills all five bowls at once, whatever action paid for it. OWNER-OR-CARER
    ///         (audit access-H-1): only the pet's current owner, or a carer that owner approved, may
    ///         care it, so no privileged relayer can force-care a rival's pet to drain it or steer
    ///         the winner; an approved carer must additionally serve a currently-weakest need. In
    ///         production the owner signs a gas-sponsored UserOp (ERC-4337 / EIP-7702 via the
    ///         embedded wallet); there is no trusted care relayer. Rate-limited by an on-chain
    ///         PER-NEED cooldown. Reverts on a DEAD pet (any need lapsed a full life window): death
    ///         is permanent, so a lapsed pet can never be revived.
    /// @param tokenId the pet id
    /// @param actionType the need to serve: 0=FEED, 1=WATER, 2=PLAY, 3=TOY, 4=EXPLORE. Anything
    ///         >= NEED_COUNT reverts BadAction: there is no such need to reset, and silently clamping
    ///         would charge careCost while misreporting what happened.
    function care(uint256 tokenId, uint8 actionType) external nonReentrant {
        // FREEZE THE BOARD ONCE DECIDED (audit H-1): once every rival has lapsed a full life window the
        // sole survivor has already won; no further care may reset that (a latecomer must not be able to
        // feed once and hijack the decided pot). isOver() is false once potClaimed, so this covers both.
        if (potClaimed || isOver()) revert GameOver();
        if (actionType >= NEED_COUNT) revert BadAction();
        Pet storage p = _pets[tokenId];
        bool byCarer;
        {
            // The owner, or an address the CURRENT owner explicitly approved to feed this pet. ownerOf
            // is read once and reused by the carer check, so the delegated path costs no extra call.
            address petOwner = pet.ownerOf(tokenId);
            bool callerIsOwner = msg.sender == petOwner;
            if (!callerIsOwner && msg.sender != _activeCarer(tokenId, petOwner)) {
                revert NotAuthorizedCarer();
            }
            byCarer = !callerIsOwner;

            if (!p.registered) revert NotCareable();
            // THE SELLOUT GATE. Nothing hatches and nothing feeds until the collection has minted
            // out (or the owner started a season that already has enough players). This is what
            // makes the start line shared: no pet can burn a care, take the leader seat or begin its
            // life window while other keepers are still buying in.
            if (selloutStartsSeason && seasonStartedAt == 0) revert SeasonNotStarted();
            // THE ROSTER CLOSE, HATCH SIDE. An egg may only be woken while entry is open. WHY: a hatch
            // stamps all five needs at `now`, which is by definition the greatest score on the board,
            // so it TAKES THE LEADER SEAT and demotes the standing leader to runner-up. A pet that sat
            // dormant for the whole season could therefore enter at the last moment with a full fresh
            // life window and outlast keepers who had been paying care costs since day one. Closing
            // the hatch at the same instant minting closes makes "who is in the race" a fact settled
            // at entryDeadline. Already-hatched pets are untouched and play on forever. An egg that
            // never hatched is not dead (careCount == 0), so it stays freely transferable rather than
            // bricking into a soulbound memorial.
            // Under the SELLOUT model this clock check is not merely skipped, it is meaningless: the
            // roster closes at the sellout, and once it has closed `entryOpen()` is false so nothing
            // can be minted either. There is no window left for a dormant egg to sneak through.
            if (!selloutStartsSeason && p.careCount == 0 && block.timestamp >= entryDeadline) {
                revert EntryWindowClosed();
            }
            uint64 minBefore = _minNeedAt(p);
            // Permanent death: ANY lapsed need kills a pet whose clock is running, for good (no
            // revive). Under the clock model a dormant egg has no timers yet and may still hatch;
            // under the sellout model every registered pet's clock started at the sellout, so a pet
            // nobody fed within one life window of the start line is dead exactly like any other.
            if (_inPlay(p) && uint256(minBefore) + lifeTtl <= block.timestamp) revert PetIsDead();
            // Cooldown is PER NEED, anchored on the need's last EXPLICIT care (servedMask bit):
            // refreshing the same need within careCooldown reverts; a need only ever filled by the
            // hatch broadcast is never on cooldown, so hatch is never cooldown-blocked and five
            // DIFFERENT actions back-to-back (even in one block) are always allowed.
            if (
                careCooldown != 0 && (p.servedMask & (uint8(1) << actionType)) != 0
                    && block.timestamp < uint256(_needAt(p, actionType)) + careCooldown
            ) {
                revert CareOnCooldown();
            }
            // THE CARER MIN-NEED RULE: a non-owner (approved carer) may only serve a need whose stamp
            // equals the pet's current min (any tied-at-min need qualifies). On a dormant egg all five
            // stamps are 0, so any actionType qualifies and a carer can still hatch. See CarerApproval.
            if (!callerIsOwner && _needAt(p, actionType) != minBefore) revert CarerMustServeMinNeed();
        }

        // Account every leg on the balance ACTUALLY received (fee-on-transfer / rebasing safe).
        uint256 balBefore = careToken.balanceOf(address(this));
        // WHY THE TWO PULL PATHS: the pet account cannot see who called care(), only that its spender
        // asked. Declaring the carer case lets the account charge it against the CARER SUB-CAP so a
        // carer can never consume the owner's daily headroom (see the CarerApproval natspec: at
        // lifeTtl == the account's spend window that was a deterministic kill, not just grief).
        if (byCarer) issuer.pullCareAsCarer(tokenId, careCost);
        else issuer.pullCare(tokenId, careCost);
        uint256 received = careToken.balanceOf(address(this)) - balBefore;

        // Four-leg split. pot, rewards and gas take floor(received * bps / BPS); burn takes the
        // remainder, so the legs always sum EXACTLY to `received` and any rounding dust falls to
        // the burn.
        uint256 potShare = (received * potBps) / BPS;
        uint256 rewardsShare = (received * rewardsBps) / BPS;
        uint256 gasShare = (received * gasBps) / BPS;
        uint256 burnShare = received - potShare - rewardsShare - gasShare;

        // Effects before the external transfers (CEI; care() is nonReentrant).
        pot += potShare;
        totalRewards += rewardsShare;
        totalGas += gasShare;
        totalBurned += burnShare;
        if (p.careCount == 0) {
            hatchedCount += 1; // first care = entered the race
            // The instant the race is properly contested, start the endgame clock. Everyone then gets a
            // full life window to respond, no matter how spread out the hatches were.
            if (contestedAt == 0 && hatchedCount >= minPlayers) contestedAt = uint64(block.timestamp);
            // HATCH: one care fills all five bowls at this instant. The keeper then has exactly one
            // life window to serve EACH need at least once; the paying action gets no head start.
            uint64 t = uint64(block.timestamp);
            p.needFeedAt = t;
            p.needWaterAt = t;
            p.needPlayAt = t;
            p.needToyAt = t;
            p.needExploreAt = t;
        } else {
            _setNeed(p, actionType, uint64(block.timestamp)); // refreshes ONLY this need
        }
        p.servedMask |= uint8(1) << actionType; // this need has now been explicitly cared
        p.careCount += 1;

        {
            // Last-pet-standing tracker (O(1)), keyed on SCORE = min-need. The invariant: `leader` is
            // the hatched pet with the global max score and `runnerUpCareAt` is the max score of any
            // OTHER hatched pet. A care generally lifts the cared pet's score only to its oldest OTHER
            // need (a PAST time), so caring no longer auto-takes the seat: the update compares. Scores
            // never decrease (a care sets one stamp to now >= every stored stamp), which is what keeps
            // this two-slot reduction exact. Ties keep the INCUMBENT (strictly-greater takeover).
            uint64 newScore = _minNeedAt(p); // == block.timestamp on hatch
            uint256 prevLeader = leader;
            uint64 prevLc = leaderCareAt;
            uint64 prevRc = runnerUpCareAt;
            if (leader == 0) {
                leader = tokenId; // first hatch: trivially the max
                leaderCareAt = newScore;
            } else if (tokenId == leader) {
                leaderCareAt = newScore; // can only rise (scores are monotone)
            } else if (newScore > leaderCareAt) {
                runnerUpCareAt = leaderCareAt; // old leader demotes to best-of-rest
                leader = tokenId;
                leaderCareAt = newScore;
            } else if (newScore > runnerUpCareAt) {
                runnerUpCareAt = newScore; // best non-leader improved
            }
            if (leader != prevLeader || leaderCareAt != prevLc || runnerUpCareAt != prevRc) {
                emit LeaderChanged(leader, leaderCareAt, runnerUpCareAt); // no no-op emits
            }
        }

        // Interactions. Rewards leg first: transfer the slice to the recipient, then fire the REQUIRED
        // hook so the sink books the funds it just received (a reverting hook reverts the whole care).
        if (rewardsBps > 0) {
            if (rewardsShare > 0) {
                careToken.safeTransfer(rewardsRecipient, rewardsShare);
            }
            IRewardsSink(rewardsRecipient).notifyCare(tokenId, issuer.accountOf(tokenId), rewardsShare);
        }
        // The gas leg pays the ops wallet that funds reward pushes. A plain safeTransfer on purpose:
        // gasRecipient is our own EOA, chosen at deploy, so the only way this reverts is the care
        // token itself misbehaving, which already reverts the burn leg below identically.
        if (gasShare > 0) {
            careToken.safeTransfer(gasRecipient, gasShare);
        }
        if (burnShare > 0) {
            careToken.safeTransfer(BURN_ADDRESS, burnShare);
        }

        emit Care(tokenId, actionType, received, burnShare, potShare, rewardsShare, gasShare, pot);
        // The pass renders this pet's need timers, hatch state and CARE balance, all of which this
        // care just changed. Leader changes also move the rival's standing, but a pass shows its own
        // pet, so one signal is enough.
        _signalPass(tokenId);
    }

    // --------------------------------------------------------------------------------------------
    // Settlement (last pet standing)
    // --------------------------------------------------------------------------------------------

    /// @notice Pay the WHOLE pot to the last pet standing. Permissionless (anyone or a bot may poke;
    ///         the money always goes to the winner's TBA). The contract re-verifies on-chain that the
    ///         game is genuinely over before paying, so a poker can never steer or rush the outcome.
    function finalize() external nonReentrant {
        if (potClaimed) revert GameOver();
        if (leader == 0 || hatchedCount < minPlayers) revert NotEnoughPlayers();
        // Over the instant no OTHER pet has been fed within a full life window: only the leader remains.
        if (block.timestamp < _decidesAt()) revert GameNotOver();

        potClaimed = true;
        _payWinner(leader);
        // Every pass changes: one pet is now the immortal champion and every other pass shows the
        // season as over (care is refused from here on).
        _signalAllPasses();
    }

    /// @notice PERMISSIONLESS RECOVERY FOR A SEASON THAT NEVER FILLED. If fewer than `minPlayers`
    ///         pets ever hatched, finalize() reverts NotEnoughPlayers at EVERY future timestamp, so
    ///         `potClaimed` could never become true, `executeSweep` reserved the entire pot forever
    ///         (it is surplus-only until the pot is claimed), and every care token those few real
    ///         players contributed was destroyed in place. This is the way out.
    ///
    ///         WHY IT CANNOT TOUCH A LIVE SEASON. `hatchedCount` can only rise on a HATCH, and the
    ///         roster close shuts hatching at `entryDeadline`. So `hatchedCount` is FROZEN from
    ///         `entryDeadline` onwards, and "this season never reached minPlayers" is a settled,
    ///         unchangeable fact from that instant. Requiring a further abandonGrace on top is pure
    ///         courtesy. The moment `hatchedCount` reaches `minPlayers` this path is closed forever
    ///         and the ordinary endgame is the only exit, so the normal game is untouched.
    ///
    ///         WHY IT IS NOT AN OWNER LEVER. It takes no arguments, has no access control, and its
    ///         destination is not caller-chosen: the money goes to the standing leader's own TBA
    ///         through the same non-blocking payout finalize() uses, or, if literally nobody ever
    ///         hatched, nowhere (the pot is provably zero in that case, since the pot only grows on a
    ///         care and the first care is a hatch). The owner gains nothing by calling it and cannot
    ///         redirect it; the only thing it changes for the owner is that the season is settled, so
    ///         residual dust stops being reserved by the sweep.
    function abandonSeason() external nonReentrant {
        if (potClaimed) revert GameOver();
        // Only ever reachable for a season the roster close already proved under-subscribed.
        if (hatchedCount >= minPlayers) revert SeasonNotAbandoned();
        // The grace runs from the ROSTER CLOSE, which is the start line under the sellout model and
        // `entryDeadline` under the clock model. A sellout season that never started has provably
        // nothing to settle (no care can have happened, so the pot is 0 and no pet is registered
        // into a decided season), so there is nothing to abandon and the call is refused.
        if (selloutStartsSeason && seasonStartedAt == 0) revert SeasonNotAbandoned();
        uint256 closedAt = selloutStartsSeason ? uint256(seasonStartedAt) : entryDeadline;
        if (block.timestamp < closedAt + abandonGrace) revert SeasonNotAbandoned();

        potClaimed = true;
        uint256 winnerId = leader;
        // Explicit rather than relying on Solidity's zero-initialized local: in
        // the no-hatch branch the event must unambiguously report a zero prize.
        uint256 prize = 0;
        if (winnerId != 0) {
            prize = _payWinner(winnerId);
        } else {
            pot = 0; // provably already 0: no hatch means no care means no pot contribution
        }
        emit SeasonAbandoned(winnerId, hatchedCount, prize);
        _signalAllPasses();
    }

    /// @dev The shared payout. Sets `pot` to 0 and moves what is actually payable to the winning pet's
    ///      resolved payout address, escrowing it for a later push if the care token refuses. Callers
    ///      set `potClaimed` first.
    function _payWinner(uint256 winnerId) internal returns (uint256 prize) {
        // Pay what we can actually pay. `pot` is our own accounting, but the care token is an EXTERNAL
        // ERC-20 we do not control (on mainnet a third-party launch). A rebase down, a clawback or a
        // blacklist could leave balanceOf(this) below pot, and a bare safeTransfer(pot) would then
        // revert forever, stranding the prize with no way to ever pay the winner. Paying the lesser
        // amount degrades to "the winner gets everything that is still here" instead of "nobody gets
        // anything, permanently". Under every honest token the two are identical.
        uint256 available = careToken.balanceOf(address(this));
        prize = pot > available ? available : pot;
        pot = 0;

        address recipient = pet.payoutAddress(winnerId, issuer.accountOf(winnerId));
        if (prize > 0) {
            // NON-BLOCKING. On mainnet the care token is a third-party launch: it may be pausable,
            // it may blacklist, it may simply revert. If its transfer were the only way to settle,
            // one blacklisted winner TBA would revert finalize() forever, and by then care() and
            // register() already refuse and the sweep is surplus-only PRECISELY BECAUSE potClaimed
            // is false. Every exit shut, pot unreachable, permanently. So the season settles either
            // way and the prize becomes a claim the winner's owner can retry to an address of their
            // choosing.
            //
            // Returndata is NOT proof of payment. A token may return true without moving anything,
            // return false after moving, return no data (USDT-style), or return a malformed ABI bool
            // that would make abi.decode revert. Measure what the winner actually received instead.
            // This simultaneously keeps finalize non-blocking and prevents a lying token from
            // creating either a phantom payout or a second full claim after already paying once.
            (uint256 delivered, uint256 debited) = _deliverPrize(recipient, prize);
            prizeDebited += debited;
            if (delivered > 0) {
                prizePaid += delivered;
                emit Victory(winnerId, recipient, delivered);
            }
            uint256 remaining = prize - delivered;
            if (remaining > 0) {
                unpaidPrize[winnerId] = remaining;
                totalUnpaidPrize += remaining;
                emit PrizeDeferred(winnerId, remaining);
            }
        } else {
            emit Victory(winnerId, recipient, 0);
        }
    }

    /// @notice Retry a prize that finalize() could not deliver. PERMISSIONLESS, and the destination
    ///         is never chosen by the pusher: Pet721 resolves either the TBA or an alternate address
    ///         previously selected by the current NFT owner. The season-2 no-claims law remains: a
    ///         bot (or anyone) pushes the contract-computed amount and receives nothing. A failed
    ///         transfer reverts wholesale here (state intact, prize stays escrowed).
    function pushPrize(uint256 tokenId) external nonReentrant {
        uint256 owed = unpaidPrize[tokenId];
        if (owed == 0) revert NothingToPush();
        uint256 available = careToken.balanceOf(address(this));
        uint256 amount = owed > available ? available : owed;
        if (amount == 0) revert NothingToPush();
        address recipient = pet.payoutAddress(tokenId, issuer.accountOf(tokenId));
        (uint256 delivered, uint256 debited) = _deliverPrize(recipient, amount);
        // A retry is allowed to fail loudly: reverting here rolls back any token-side effects as
        // well and leaves the escrow untouched for a later address/token recovery.
        if (delivered == 0) revert PrizeTransferFailed();
        prizeDebited += debited;
        // Whatever was not ACTUALLY received stays owed, so a fee-on-transfer, partial movement, or
        // under-backed recovery is never mistaken for a full payout.
        unpaidPrize[tokenId] = owed - delivered;
        totalUnpaidPrize -= delivered;
        prizePaid += delivered;
        emit PrizePushed(tokenId, recipient, delivered);
        _signalPass(tokenId); // the champion's pass shows its balance
    }

    // --------------------------------------------------------------------------------------------
    // Wallet Pass Extension signalling
    // --------------------------------------------------------------------------------------------

    /// @dev The ERC puts `PassUpdate` on the TOKEN CONTRACT (the address pass distributors watch), so
    ///      the vault asks Pet721 to emit it rather than emitting a look-alike event here.
    ///      NON-BLOCKING ON PURPOSE: a freshness signal must never be able to revert a care or a
    ///      settlement. `pet` is an immutable contract address, so the call always has code to hit.
    function _signalPass(uint256 tokenId) internal {
        try IPassSignal(address(pet)).signalPassUpdate(tokenId) {} catch {}
    }

    /// @dev Season-wide change (start, finalize, abandon): one BatchPassUpdate over every minted id.
    function _signalAllPasses() internal {
        uint256 minted = pet.totalMinted();
        if (minted == 0) return;
        try IPassSignal(address(pet)).signalBatchPassUpdate(1, minted) {} catch {}
    }

    /// @dev Raw-call the third-party care token, then return only the recipient balance increase.
    ///      Return bytes are deliberately ignored: observable token movement is the postcondition.
    ///      Capped at `amount` so an unrelated positive rebase cannot over-credit prize accounting.
    function _deliverPrize(address recipient, uint256 amount) internal returns (uint256 delivered, uint256 debited) {
        uint256 vaultBefore = careToken.balanceOf(address(this));
        uint256 beforeBalance = careToken.balanceOf(recipient);
        (bool ok,) = address(careToken).call(abi.encodeCall(IERC20.transfer, (recipient, amount)));
        if (!ok) return (0, 0);
        uint256 vaultAfter = careToken.balanceOf(address(this));
        uint256 afterBalance = careToken.balanceOf(recipient);
        if (vaultAfter < vaultBefore) {
            uint256 decrease = vaultBefore - vaultAfter;
            debited = decrease > amount ? amount : decrease;
        }
        // A recipient-side mint is not a prize payment unless this vault was also debited. If the
        // vault was debited but the recipient received nothing, report the debit for conservation
        // accounting while leaving `delivered == 0` so the winner's debt is never erased.
        if (debited == 0 || afterBalance <= beforeBalance) return (0, debited);
        uint256 increase = afterBalance - beforeBalance;
        delivered = increase > amount ? amount : increase;
    }

    // --------------------------------------------------------------------------------------------
    // Views
    // --------------------------------------------------------------------------------------------

    /// @notice True once the game is decidable: enough distinct pets have played and no pet other than
    ///         the leader is still alive (its last competitor lapsed a full life window ago). At this
    ///         point finalize() pays the leader. False after the pot has been claimed.
    function isOver() public view returns (bool) {
        return !potClaimed && leader != 0 && hatchedCount >= minPlayers && block.timestamp >= _decidesAt();
    }

    /// @dev The earliest instant the season can be decided:
    ///
    ///          _decidesAt() = MAX( max(runnerUpCareAt, contestedAt) + lifeTtl,
    ///                              seasonStart + minSeasonDuration,
    ///                              entryDeadline )
    ///
    ///      TERM 1 is the endgame proper. Taking the later of the runner-up's score and the moment the
    ///      race became contested is what stops a sparse start from deciding the game on its own (see
    ///      `contestedAt`).
    ///      TERM 2, the season floor, covers what that does not: `contestedAt` is armed exactly ONCE,
    ///      by the mere fact of minPlayers pets having hatched, and mints are free. Without it,
    ///      minPlayers pets minted and fed once on day 0 arm the endgame on day 0 and the season is
    ///      decided one life window later with the collection barely minted. The floor makes the
    ///      season length a deployment parameter rather than a race outcome.
    ///      TERM 3, the ROSTER CLOSE, is the one that makes the whole thing safe to mint into: while
    ///      entry is open the season is not decidable, full stop.
    ///
    ///      ===== THE TWO INVARIANTS, RE-DERIVED WITH TERM 3 IN PLACE =====
    ///
    ///      (I) MONOTONE NON-DECREASING, so isOver() can never flicker back to false.
    ///          `runnerUpCareAt` never decreases. Its only two writes are `runnerUpCareAt =
    ///          leaderCareAt` on a takeover, taken only when the challenger's score strictly exceeds
    ///          leaderCareAt (and leaderCareAt >= runnerUpCareAt holds by the tracker invariant, so
    ///          this assignment is upward), and `runnerUpCareAt = newScore` guarded by `newScore >
    ///          runnerUpCareAt` (strictly upward). Per-pet scores themselves never decrease, because a
    ///          care only ever sets one need stamp to `now`, which is >= every stored stamp.
    ///          `contestedAt` is written once and never again. `lifeTtl`, `seasonStart`,
    ///          `minSeasonDuration` and `entryDeadline` are immutable. So term 1 is monotone
    ///          non-decreasing and terms 2 and 3 are constants; the max of a monotone non-decreasing
    ///          function and any constants is monotone non-decreasing. Term 3 is a CONSTANT, so
    ///          adding it cannot break this. Hence `block.timestamp >= _decidesAt()` is a one-way
    ///          switch in time and isOver() never flickers.
    ///
    ///      (II) finalize() NEVER PAYS WHILE ANOTHER HATCHED PET IS ALIVE.
    ///          finalize() requires `now >= _decidesAt() >= runnerUpCareAt + lifeTtl` (term 1 alone
    ///          already gives that; the max can only make it later). By the tracker invariant every
    ///          hatched pet other than `leader` has score <= runnerUpCareAt, and a hatched pet is dead
    ///          once `score + lifeTtl <= now`. So for every such pet, score + lifeTtl <=
    ///          runnerUpCareAt + lifeTtl <= now: all of them are dead. Term 3 only ever DELAYS
    ///          finalize(), and a strictly later payout instant cannot resurrect a rival, so the proof
    ///          is unaffected by it. This is why the roster close was added as an additional floor
    ///          rather than as a replacement for anything.
    ///
    ///      (III) NEW, AND THE POINT OF TERM 3: A PET CAN NEVER BE MINTED INTO A DECIDED SEASON.
    ///          Entry (PetIssuer.issuePet, and the hatch branch of care()) is refused once
    ///          `now >= entryDeadline`. Decidability requires `now >= _decidesAt() >= entryDeadline`.
    ///          The two windows are therefore disjoint: at any instant a new entrant is accepted,
    ///          `now < entryDeadline <= _decidesAt()`, so isOver() is false and potClaimed is false
    ///          (potClaimed can only be set by finalize(), which needs `now >= _decidesAt()`, or by
    ///          abandonSeason(), which needs `now >= entryDeadline + abandonGrace`). Every pet that
    ///          is minted gets a real season to play.
    function _decidesAt() internal view returns (uint256) {
        // SELLOUT MODEL: a season that has not started is NEVER decidable. This is the strongest
        // form of invariant III rather than a weakening of it: entry closes at the very instant the
        // season starts, so the entry window and the decidable window cannot merely be disjoint,
        // they cannot even touch. Returning "never" also makes the ordering explicit to a reader
        // instead of leaving it to be re-derived from "leader is 0 anyway".
        if (selloutStartsSeason && seasonStartedAt == 0) return type(uint256).max;
        uint256 from = uint256(runnerUpCareAt);
        if (uint256(contestedAt) > from) from = uint256(contestedAt);
        uint256 t = from + lifeTtl;
        // The season floor is measured from the START LINE, which under the sellout model is the
        // sellout and under the clock model is the deployment.
        uint256 floorAt = (selloutStartsSeason ? uint256(seasonStartedAt) : seasonStart) + minSeasonDuration;
        // The roster close is an ADDITIONAL floor, never a replacement: take the later of the two so
        // neither protection can be traded away by a config that sets the other one high. Under the
        // sellout model the roster closed at the start line, which the floor above already exceeds.
        if (!selloutStartsSeason && entryDeadline > floorAt) floorAt = entryDeadline;
        return t < floorAt ? floorAt : t;
    }

    /// @dev THE death rule: a HATCHED pet is DEAD the instant ANY of its five needs has gone unserved
    ///      for a full lifeTtl (min-need stamp + lifeTtl <= now). One definition, shared by the care
    ///      guard, the transfer-soulbound oracle, and the memorial read. Permanent (no revive). A
    ///      dormant egg (careCount == 0) is never "dead": it has no timers, so it stays transferable
    ///      and hatchable rather than bricking into an unsellable soulbound memorial (audit death-F1).
    function _isDead(Pet storage p) internal view returns (bool) {
        return _inPlay(p) && uint256(_minNeedAt(p)) + lifeTtl <= block.timestamp;
    }

    /// @dev THE CHAMPION IS IMMORTAL (season-2 ruling, Hunt 2026-08-30). Once the pot is claimed the
    ///      winning pet never reads dead again, anywhere: not on the site, not on the wallet pass,
    ///      not to the rewards distributor. The clock verdict underneath is usually "lapsed" (the
    ///      normal finalize() poke lands well after the leader's own clock ran out), but a memorial
    ///      champion was the wrong product: the trophy is a LIVING pet that won, holding the prize
    ///      in its own account, tradeable forever (transferLocked already carved it out). One pet
    ///      id, fixed at settlement, steerable by nobody. `carerOf` deliberately keeps the raw clock
    ///      read: care() reverts GameOver post-season, so advertising a live carer would be a lie.
    function _immortal(uint256 tokenId) internal view returns (bool) {
        return potClaimed && tokenId == leader;
    }

    /// @notice The death read every consumer shares: a HATCHED pet whose weakest need lapsed a full
    ///         life window ago, EXCEPT the champion (see _immortal), which never reads dead.
    /// @dev    NOTE: this is no longer the transfer gate. Pet721 asks `transferLocked` instead
    ///         (same carve-out, one definition).
    function isDead(uint256 tokenId) external view returns (bool) {
        if (_immortal(tokenId)) return false;
        return _isDead(_pets[tokenId]);
    }

    /// @notice The pet that won the pot, or 0 while the season is unsettled. `leader` is frozen once
    ///         `potClaimed` is true (care() reverts GameOver from then on, so nothing can move the
    ///         seat), which is what makes this stable enough to hang a transfer exemption off.
    function prizeWinner() public view returns (uint256) {
        return potClaimed ? leader : 0;
    }

    /// @notice THE TRANSFER GATE Pet721 reads on every owner-to-owner move. A dead pet is a permanent
    ///         memorial and can never be moved again, WITH ONE CARVE-OUT: the pet that won the pot.
    ///
    ///         WHY THE CARVE-OUT. finalize() is permissionless and deliberately does not require the
    ///         leader to still be alive, because requiring it would either strand the pot (revert
    ///         forever if the poke is late) or hand someone a reason to withhold the poke. But a late
    ///         poke is the NORMAL case: by the time the last rival lapses, the leader has usually
    ///         lapsed too. So the ordinary outcome was that the single most valuable token in the
    ///         collection, the one carrying the entire prize, became permanently unsellable the
    ///         instant it was awarded. The prize itself was never stuck (the holder owns the winning
    ///         pet's TBA and can always execute() the tokens out), but the trophy was: a permanent
    ///         unsellable memorial. Exempting the winner costs nothing in game terms, since the season
    ///         is already settled and no transfer can change any outcome, and it keeps the prize NFT
    ///         and any still-escrowed `pushPrize` entitlement tradeable together (the push pays the
    ///         pet's TBA, and the TBA follows the NFT).
    ///
    ///         Every OTHER dead pet stays soulbound exactly as before. The exemption is decided by
    ///         on-chain state that nobody can steer: one pet id, fixed at settlement.
    function transferLocked(uint256 tokenId) external view returns (bool) {
        if (_immortal(tokenId)) return false; // the champion stays tradeable
        return _isDead(_pets[tokenId]);
    }

    /// @notice True if the pet has HATCHED (been cared at least once) and EVERY one of its five needs
    ///         has been served within the last lifeTtl (min-need stamp + lifeTtl > now). A dormant,
    ///         never-fed egg reads not-alive (it is not yet a living pet in the race).
    function alive(uint256 tokenId) public view returns (bool) {
        if (_immortal(tokenId)) return true; // the champion lives forever
        Pet storage p = _pets[tokenId];
        return _inPlay(p) && (uint256(_minNeedAt(p)) + lifeTtl > block.timestamp);
    }

    /// @notice The five raw need timestamps, indexed by canonical actionType (0=FEED, 1=WATER,
    ///         2=PLAY, 3=TOY, 4=EXPLORE). Per-need deadline = needAt[i] + lifeTtl.
    /// @dev    Returns all zeros BOTH for a dormant egg AND for an unregistered id: callers must
    ///         disambiguate via petState().registered FIRST. Returns the raw stamps even when the pet
    ///         is dead (view honesty: the stamps freeze at death because care() reverts); consumers
    ///         gate any "time left" display on alive().
    /// @dev Routed through the floored accessor, NOT the raw slots. Under the sellout model an
    ///      unfed pet's stamps are all still 0 in storage while its real deadline is one life window
    ///      after the start line, and this view is what the server and the wallet pass build every
    ///      countdown from. Reading raw here would have told every keeper their pet had no clock
    ///      running on the one day it mattered most.
    function needsOf(uint256 tokenId) external view returns (uint64[5] memory needAt) {
        Pet storage p = _pets[tokenId];
        for (uint8 i = 0; i < 5; i++) {
            needAt[i] = _needAt(p, i);
        }
    }

    /// @notice One-call pet survival state for the server / site. `dead` is the time-based death (there
    ///         is no separate reaping step); it is the complement of `isAlive` for a registered pet.
    /// @dev    ABI shape unchanged from the single-timer game. `lastCareAt` is the pet's MIN-NEED
    ///         stamp (the deadline-binding one): deadline = lastCareAt + lifeTtl still holds exactly.
    ///         The true last-action instant is max(needsOf), not this. Dormant egg: (true, false, 0,
    ///         false, 0).
    function petState(uint256 tokenId)
        external
        view
        returns (bool registered, bool dead, uint64 lastCareAt, bool isAlive, uint256 secondsLeft)
    {
        Pet storage p = _pets[tokenId];
        registered = p.registered;
        isAlive = alive(tokenId);
        // Time-based death of a HATCHED pet (a dormant egg is neither alive nor dead), except the
        // champion, which is immortal: alive true, dead false, and secondsLeft 0 because no clock
        // binds it any more (clients render the champion off prizeWinner(), not a countdown).
        dead = _immortal(tokenId) ? false : _isDead(p);
        lastCareAt = _minNeedAt(p);
        uint256 deadline = uint256(lastCareAt) + lifeTtl;
        // The champion's secondsLeft is 0 UNCONDITIONALLY: no clock binds it, and during the
        // fast-finalize window (leader still alive when the poke lands) the raw arithmetic would
        // otherwise render a countdown on a pet that cannot die (caught by the season-2 invariant
        // campaign's INV14 on first run).
        secondsLeft = _immortal(tokenId) ? 0 : (isAlive && deadline > block.timestamp ? deadline - block.timestamp : 0);
    }

    /// @notice The minimal life read for the server: liveness, the deadline-binding (min-need) stamp,
    ///         and the exact deadline (lastCareAt + lifeTtl) after which the pet dies.
    function lifeState(uint256 tokenId) external view returns (bool isAlive, uint64 lastCareAt, uint256 deadline) {
        Pet storage p = _pets[tokenId];
        isAlive = alive(tokenId);
        lastCareAt = _minNeedAt(p);
        deadline = uint256(lastCareAt) + lifeTtl;
    }

    /// @notice The forever-keepsake memorial read for a pet's wallet pass. All on-chain, no indexer.
    /// @dev diedAt = min-need stamp + lifeTtl once dead (the exact instant its weakest need lapsed,
    ///      even though other stamps may be newer; the stamps freeze at death because care() reverts).
    ///      Survival RANK (how many peers it outlasted) is derived off-chain from the pets' death
    ///      times; there is no on-chain death-order counter now that death is passive.
    function memorialState(uint256 tokenId)
        external
        view
        returns (bool dead, uint64 bornAt, uint64 diedAt, uint32 careCount, uint32 rank)
    {
        Pet storage p = _pets[tokenId];
        // The champion never becomes a memorial: dead false, diedAt 0, forever (see _immortal).
        dead = _immortal(tokenId) ? false : _isDead(p);
        bornAt = p.bornAt;
        diedAt = dead ? uint64(uint256(_minNeedAt(p)) + lifeTtl) : 0;
        careCount = p.careCount;
        rank = 0; // derived off-chain (no on-chain death-order counter in the last-pet-standing model)
    }

    /// @notice Current standing for the site. `candidate` is the leader (the pet that wins if the game
    ///         ends now); `candidateLastCareAt` is the leader's SCORE (min-need stamp); `winsAt` is
    ///         the timestamp finalize() succeeds if no one else cares (the last competitor's
    ///         deadline); `finalized` is whether the pot has been paid.
    function settlementState()
        external
        view
        returns (uint256 candidate, uint64 candidateLastCareAt, uint256 winsAt, bool finalized)
    {
        candidate = leader;
        candidateLastCareAt = leaderCareAt;
        // Zero when the season is not DECIDABLE, not merely when there is no leader. finalize()
        // reverts NotEnoughPlayers below minPlayers at every future timestamp, so returning a
        // deadline there would have the site count down to a payout that can never happen.
        winsAt = (leader == 0 || hatchedCount < minPlayers) ? 0 : _decidesAt();
        finalized = potClaimed;
    }

    /// @notice Disabled. Renouncing would permanently disarm the stranded-funds sweep and the deferred-prize path,
    ///         which are the only remediation paths this contract has. Ownership can still be
    ///         TRANSFERRED (Ownable2Step, so the new owner must accept), which is the safe move.
    function renounceOwnership() public view override onlyOwner {
        revert OwnershipCannotBeRenounced();
    }
}
