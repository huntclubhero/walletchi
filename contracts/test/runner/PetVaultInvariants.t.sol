// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {StdInvariant} from "forge-std/StdInvariant.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";

import {ERC6551Registry} from "erc6551/ERC6551Registry.sol";
import {IERC6551Registry} from "erc6551/interfaces/IERC6551Registry.sol";

import {WalletchiAccount} from "../../src/WalletchiAccount.sol";
import {Pet721} from "../../src/runner/Pet721.sol";
import {PetIssuer} from "../../src/runner/PetIssuer.sol";
import {PetVault, IPetCareSpender} from "../../src/runner/PetVault.sol";
import {RewardsDistributor} from "../../src/runner/RewardsDistributor.sol";
import {MockCareToken} from "../../src/runner/MockCareToken.sol";

// ================================================================================================
// Malicious care token: fee-on-transfer PLUS a reentrant hook that, on every transfer, tries to
// reenter finalize() (catching the revert). Proves the guards hold and the money invariants survive
// a hostile token across a random action sequence. mint() has no fee (like a real faucet).
// ================================================================================================
contract HostileCareToken is ERC20 {
    address public constant FEE_SINK = 0x00000000000000000000000000000000000FEE00;
    uint256 public immutable feeBps;
    PetVault public vault;
    bool public reentrancyOn;

    constructor(uint256 feeBps_) ERC20("Hostile Care", "HCARE") {
        feeBps = feeBps_;
    }

    function decimals() public pure override returns (uint8) {
        return 18;
    }

    function mint(address to, uint256 amount) external {
        _mint(to, amount);
    }

    function setVault(PetVault vault_) external {
        vault = vault_;
        reentrancyOn = true;
    }

    function transfer(address to, uint256 amount) public override returns (bool) {
        if (reentrancyOn && address(vault) != address(0)) {
            try vault.finalize() {} catch {}
        }
        return super.transfer(to, amount);
    }

    function _update(address from, address to, uint256 value) internal override {
        if (from != address(0) && to != address(0) && feeBps > 0) {
            uint256 fee = (value * feeBps) / 10_000;
            super._update(from, to, value - fee);
            if (fee > 0) super._update(from, FEE_SINK, fee);
        } else {
            super._update(from, to, value);
        }
    }
}

// ================================================================================================
// Handler: the invariant fuzzer calls these actions in random order with random args. Every vault
// call is try/catch so invalid sequences are no-ops; ghosts double-entry the careToken so the
// invariant contract can check conservation. No assertions live here (they would be swallowed by
// fail_on_revert); the invariant_* functions do all the checking.
// ================================================================================================
contract PetVaultHandler is Test {
    address internal constant BURN = 0x000000000000000000000000000000000000dEaD;
    // Epoch length for the live rewards distributor in the 3-leg campaign. Short relative to the
    // warp range (1..7200) so epochs finish DURING the fuzz and the claim path is actually exercised.
    uint256 internal constant EPOCH_LENGTH = 300;

    IERC20 public careToken;
    WalletchiAccount public accountImpl;
    Pet721 public pet;
    PetIssuer public issuer;
    PetVault public vault;
    // The live rewards sink, deployed + wired ONLY when the campaign runs with rewardsBps > 0
    // (the 3-leg campaign). address(0) for the two-leg Standard / Hostile campaigns.
    RewardsDistributor public dist;

    address public owner;
    address public relayer;
    address[] public actors;
    /// @dev The one approved-carer identity used by the carer actions (approved fresh per call by
    ///      the pet's current owner). Never among the careNonOwner caller pool, so INV13 stays exact.
    address public carer;

    uint256[] public petIds;
    mapping(uint256 => address) public petOwner;

    // Ghost accounting (all careToken flows through the vault).
    uint256 public gPulledIn; // received into the vault from cares (pot + burn slices)
    uint256 public gBurned; // sent to the burn sink (care burn legs only; the sweep never burns)
    uint256 public gSwept; // careToken swept out to the sweep recipient
    uint256 public gDonated; // careToken donated in
    uint256 public gHatchedExpected; // distinct pets first-fed (mirror of hatchedCount)

    uint256 public gFinalizeCount;
    bool public gSettled;
    bool public gPostSettleViolation; // a forbidden action succeeded after the pot was claimed
    bool public gPostSettleRegistered; // a pet minted after settlement was registered into the game
    bool public gBadCareDebit;
    bool public gDeadCareSucceeded; // INV5: care() succeeded on an already-dead pet (must stay false)
    bool public gNonOwnerCareSucceeded; // INV13: care() succeeded for a non-owner caller (must stay false)
    bool public gCarerNonMinSucceeded; // INV13b: an approved carer cared a NON-min need (must stay false)
    bool public gBadActionSucceeded; // INV13c: care() succeeded with actionType >= 5 (must stay false)
    bool public gBadActionMoved; // INV13c: a BadAction attempt moved tokens (must stay false)
    bool public gScoreDecreased; // INV16: a pet's min-need went DOWN across a successful care (must stay false)
    mapping(uint256 => uint64) public ghostMinSeen; // INV16 ghost: highest min-need observed per pet
    bool public gDeadTransferSucceeded; // INV9: a dead NON-WINNER moved owner-to-owner (must stay false)
    bool public gAliveTransferReverted; // INV9: a live pet's owner transfer blocked (must stay false)
    // INV9b (the pot-winner soulbound carve-out, pinned to EXACTLY one pet). A settled season's
    // winning pet is deliberately exempt from the death-soulbound rule so the prize NFT is not a
    // permanently unsellable memorial. These two ghosts exist so the campaign can prove the exemption
    // is that narrow rather than taking it on trust: every dead pet that ever moves is recorded, and
    // the invariant asserts the pot was settled and the mover was the leader.
    uint256 public gWinnerDeadTransfers; // how many times a DEAD pet moved while exempt
    uint256 public gWinnerDeadTransferId; // the last such pet id (asserted == leader)
    bool public gDeadMovedWhileUnsettled; // a dead pet moved with potClaimed false (must stay false)
    bool public gFinalizeVaultSentExact;
    bool public gFinalizeUnderMinPlayers; // finalize succeeded with hatchedCount < minPlayers
    bool public gFinalizeBeforeOver; // finalize succeeded while isOver() read false
    uint256 public gFinalizePot;
    uint256 public gFinalizeTbaReceived;

    constructor(
        IERC20 careToken_,
        ERC6551Registry registry_,
        address owner_,
        address relayer_,
        uint256 lifeTtl,
        uint256 careCost,
        uint256 careCooldown,
        uint256 minPlayers,
        uint256 rewardsBps_
    ) {
        careToken = careToken_;
        owner = owner_;
        relayer = relayer_;
        carer = makeAddr("approvedCarer");

        for (uint256 i = 0; i < 4; i++) {
            actors.push(makeAddr(string(abi.encodePacked("actor", vm.toString(i)))));
        }

        // Three-leg split: pot stays 1000 bps; a live rewards leg (rewardsBps_ > 0) carves out of the
        // burn slice so pot + burn + rewards == 10000. rewardsBps_ == 0 reproduces the two-leg deploy.
        uint256 burnBpsLocal = 9000 - rewardsBps_;

        vm.startPrank(owner);
        accountImpl = new WalletchiAccount();
        pet = new Pet721("WALLETCHI", "WCHI", 100_000, owner, owner, "");
        issuer = new PetIssuer(
            pet,
            IERC6551Registry(address(registry_)),
            address(accountImpl),
            careToken_,
            relayer_,
            owner_,
            careCost, // perTxCap == careCost
            1_000_000e18, // dailyCap: generous so the fuzz is not cap-starved
            1000e18 // starter float per pet
        );
        // Deploy the real rewards sink BEFORE the vault (the vault needs its address as
        // rewardsRecipient, and the sink needs the vault address post-deploy, so neither can be the
        // other's constructor-immutable). Left as address(0) for the two-leg campaigns.
        address rewardsRecipientLocal = address(0);
        if (rewardsBps_ > 0) {
            dist = new RewardsDistributor(owner_, careToken_, EPOCH_LENGTH);
            rewardsRecipientLocal = address(dist);
        }
        // Populate field-by-field so the non-via-IR compiler never has to keep the constructor's
        // inputs plus every struct expression on the EVM stack at once. The prior literal hit
        // "stack too deep" under the default profile and excluded this invariant file from an
        // ordinary `forge test` run.
        PetVault.Params memory vaultParams;
        vaultParams.careToken = careToken_;
        vaultParams.pet = pet;
        vaultParams.issuer = IPetCareSpender(address(issuer));
        vaultParams.owner = owner_;
        vaultParams.lifeTtl = lifeTtl;
        vaultParams.careCost = careCost;
        vaultParams.potBps = 1000;
        vaultParams.burnBps = burnBpsLocal;
        vaultParams.rewardsBps = rewardsBps_;
        vaultParams.rewardsRecipient = rewardsRecipientLocal;
        vaultParams.gasBps = 0;
        vaultParams.gasRecipient = address(0);
        vaultParams.abandonGrace = 90 days;
        vaultParams.minPlayers = minPlayers;
        vaultParams.careCooldown = careCooldown;
        vaultParams.minSeasonDuration = lifeTtl;
        vaultParams.entryWindowSecs = lifeTtl;
        vaultParams.selloutStartsSeason = false;
        vault = new PetVault(vaultParams);
        pet.setIssuer(address(issuer));
        issuer.setVault(address(vault));
        pet.setVaultRef(address(vault)); // wire the death-soulbound oracle
        pet.lockIssuer();
        issuer.lockVault(); // production posture: the spender's vault is frozen (audit M-A)
        pet.lockVaultRef(); // production posture: the death oracle is frozen
        if (rewardsBps_ > 0) {
            dist.setVault(address(vault)); // freeze the sink's sole caller to the real vault (one-way)
        }
        vm.stopPrank();

        // Seed the issuer with a large float so it can seed every minted pet's TBA.
        MockCareToken(address(careToken_)).mint(address(issuer), 100_000_000e18);
    }

    function petCount() external view returns (uint256) {
        return petIds.length;
    }

    function _pick(uint256 seed) internal view returns (uint256 tid, bool ok) {
        if (petIds.length == 0) return (0, false);
        return (petIds[bound(seed, 0, petIds.length - 1)], true);
    }

    // -------- actions --------------------------------------------------------------------------

    function mintPet(uint256 actorSeed) public {
        address to = actors[bound(actorSeed, 0, actors.length - 1)];
        bool wasClaimed = vault.potClaimed();
        vm.prank(relayer);
        try issuer.issuePet(to) returns (uint256 tid, address) {
            petIds.push(tid);
            petOwner[tid] = to;
            // Minting AFTER settlement is intended: register() no-ops instead of reverting so the
            // collection can still be minted out once the season ends. What must never happen is
            // such a pet becoming REGISTERED, because that would put it back in the game.
            (bool registered,,,,) = vault.petState(tid);
            if (wasClaimed && registered) gPostSettleRegistered = true;
        } catch {}
    }

    /// @dev The pet's min-need stamp, derived from the vault's needsOf (the ground truth).
    function _minNeed(uint256 tid) internal view returns (uint64 m) {
        uint64[5] memory n = vault.needsOf(tid);
        m = n[0];
        for (uint256 i = 1; i < 5; i++) {
            if (n[i] < m) m = n[i];
        }
    }

    /// @dev Owner care over the five REAL actions (action % 5) so the fuzz exercises actual per-need
    ///      resets rather than bouncing off BadAction. ownerOf is the ground truth, so cares stay
    ///      valid across randomized transfers.
    function careOwner(uint256 petSeed, uint8 action) public {
        (uint256 tid, bool ok) = _pick(petSeed);
        if (!ok) return;
        _care(tid, action % 5, pet.ownerOf(tid));
    }

    /// @dev Adversarial action: a NON-owner (the mint relayer, the deploy owner, or a random actor
    ///      that does not own the pet), never carer-approved, tries to force-care. Owner-or-carer
    ///      auth means this must ALWAYS revert; any success trips gNonOwnerCareSucceeded (INV13).
    function careNonOwner(uint256 petSeed, uint8 action, uint256 callerSeed) public {
        (uint256 tid, bool ok) = _pick(petSeed);
        if (!ok) return;
        address realOwner = pet.ownerOf(tid);
        address caller;
        uint256 pick = bound(callerSeed, 0, actors.length + 1);
        if (pick == 0) caller = relayer;
        else if (pick == 1) caller = owner;
        else caller = actors[pick - 2];
        if (caller == realOwner) caller = relayer; // relayer never owns a pet (mints go to actors)
        if (caller == realOwner) return;
        vm.prank(caller);
        try vault.care(tid, action % 5) {
            gNonOwnerCareSucceeded = true; // INV13 violation: a non-owner cared someone else's pet
        } catch {}
    }

    /// @dev An APPROVED carer serving the pet's currently-weakest need: the one legal carer move
    ///      under the min-need rule. Approval is granted fresh by the pet's current owner, then the
    ///      carer targets a tied-at-min action (any action for a dormant egg: all stamps are 0).
    function careCarerMin(uint256 petSeed, uint8 actionSeed) public {
        (uint256 tid, bool ok) = _pick(petSeed);
        if (!ok) return;
        address realOwner = pet.ownerOf(tid);
        vm.prank(realOwner);
        try vault.setCarer(tid, carer, 0) {}
        catch {
            return;
        }
        uint64 mn = _minNeed(tid);
        uint64[5] memory n = vault.needsOf(tid);
        uint8 action = actionSeed % 5;
        if (n[action] != mn) {
            for (uint8 a = 0; a < 5; a++) {
                if (n[a] == mn) {
                    action = a;
                    break;
                }
            }
        }
        _care(tid, action, carer);
    }

    /// @dev PROBE: an approved carer targeting a strictly NON-min need. Must always revert
    ///      (CarerMustServeMinNeed, or an earlier guard); any success trips gCarerNonMinSucceeded.
    function careCarerNonMin(uint256 petSeed) public {
        (uint256 tid, bool ok) = _pick(petSeed);
        if (!ok) return;
        uint64 mn = _minNeed(tid);
        uint64[5] memory n = vault.needsOf(tid);
        uint8 action = 5; // sentinel: no strictly-non-min need exists
        for (uint8 a = 0; a < 5; a++) {
            if (n[a] != mn) {
                action = a;
                break;
            }
        }
        if (action == 5) return; // all five tied (dormant egg or freshly served): nothing to probe
        address realOwner = pet.ownerOf(tid);
        vm.prank(realOwner);
        try vault.setCarer(tid, carer, 0) {}
        catch {
            return;
        }
        vm.prank(carer);
        try vault.care(tid, action) {
            gCarerNonMinSucceeded = true; // the min-need rule was bypassed
        } catch {}
    }

    /// @dev PROBE: actionType >= NEED_COUNT must always revert BadAction with ZERO token movement.
    function careBadAction(uint256 petSeed, uint8 badSeed) public {
        (uint256 tid, bool ok) = _pick(petSeed);
        if (!ok) return;
        uint8 bad = uint8(bound(badSeed, 5, 255));
        address tba = issuer.accountOf(tid);
        uint256 vaultBefore = careToken.balanceOf(address(vault));
        uint256 tbaBefore = careToken.balanceOf(tba);
        vm.prank(pet.ownerOf(tid));
        try vault.care(tid, bad) {
            gBadActionSucceeded = true; // an out-of-range action was accepted
        } catch {}
        if (careToken.balanceOf(address(vault)) != vaultBefore || careToken.balanceOf(tba) != tbaBefore) {
            gBadActionMoved = true;
        }
    }

    /// @dev THE RAW CLOCK VERDICT, and deliberately NOT vault.isDead(). Since season 2 the champion
    ///      is IMMORTAL: isDead() answers false for the pot winner forever, even though its own
    ///      timer has almost always lapsed by the time finalize() lands. Classifying the adversarial
    ///      ghosts off that view would quietly retire them: a dead-pet transfer would stop being
    ///      RECORDED at all, so INV9b could no longer measure how wide the carve-out really is, and
    ///      INV5 would stop watching the one pet the exemption touches. Deriving death from the
    ///      stamps keeps both at their original force and keeps the exemption something this
    ///      campaign MEASURES rather than inherits.
    function _clockLapsed(uint256 tid) internal view returns (bool) {
        (bool registered,,,,) = vault.petState(tid);
        if (!registered) return false;
        (,,, uint32 careCount,) = vault.memorialState(tid);
        if (careCount == 0) return false; // a dormant egg has no timers at all
        (,, uint256 deadline) = vault.lifeState(tid);
        return deadline <= block.timestamp;
    }

    function _care(uint256 tid, uint8 action, address caller) internal {
        bool wasClaimed = vault.potClaimed();
        bool wasDead = _clockLapsed(tid); // time-based, permanent: a success on a dead pet = violation
        (,,, uint32 ccBefore,) = vault.memorialState(tid);
        address tba = issuer.accountOf(tid);
        uint256 balBefore = careToken.balanceOf(address(vault));
        uint256 potBefore = vault.pot();
        uint256 burnedBefore = vault.totalBurned();
        uint256 tbaBefore = careToken.balanceOf(tba);

        vm.prank(caller);
        try vault.care(tid, action) {
            if (wasClaimed) gPostSettleViolation = true;
            if (wasDead) gDeadCareSucceeded = true;
            if (ccBefore == 0) gHatchedExpected += 1; // first feed hatches the pet exactly once
            uint256 balDelta = careToken.balanceOf(address(vault)) - balBefore;
            uint256 potDelta = vault.pot() - potBefore;
            uint256 burnDelta = vault.totalBurned() - burnedBefore;
            gPulledIn += (potDelta + burnDelta); // = received minus the rewards slice (which is pass-through)
            gBurned += burnDelta;
            if (tbaBefore - careToken.balanceOf(tba) != vault.careCost()) gBadCareDebit = true;
            // vault must retain exactly the pot slice, nothing leaked.
            if (balDelta != potDelta) gBadCareDebit = true;
            _trackMinAfterCare(tid);
        } catch {}
    }

    /// @dev INV16 ghost: a pet's min-need (its score / deadline anchor) may never decrease.
    function _trackMinAfterCare(uint256 tid) internal {
        uint64 mn = _minNeed(tid);
        if (mn < ghostMinSeen[tid]) gScoreDecreased = true;
        else ghostMinSeen[tid] = mn;
    }

    function warpTime(uint256 secs) public {
        vm.warp(block.timestamp + bound(secs, 1, 7200));
    }

    // INV9 (death-soulbound): attempt an owner-initiated transfer of a pet. No validator is wired in
    // the campaign (permissive), so the ONLY thing that may block an owner move is death. A DEAD
    // (life timer lapsed) pet must always revert; a live pet must always move.
    //
    // ONE EXEMPTION, AND IT IS MEASURED RATHER THAN ASSUMED. A settled season's pot winner is
    // deliberately exempt (PetVault.transferLocked), because finalize() normally lands after the
    // leader's own timer has lapsed, which used to turn the single most valuable token in the
    // collection into a permanent unsellable memorial at the exact moment it won. The exemption is
    // read here from the SAME state the contract uses, and every dead-pet move it permits is recorded
    // so the invariant can assert it really was one settled winner and nothing else. `gDeadTransfer
    // Succeeded` keeps its original full force for every other pet in the collection.
    function transferPet(uint256 petSeed, uint256 toSeed) public {
        (uint256 tid, bool ok) = _pick(petSeed);
        if (!ok) return;
        address from = pet.ownerOf(tid);
        address to = actors[bound(toSeed, 0, actors.length - 1)];
        bool dead = _clockLapsed(tid); // the raw clock, not the immortality-carved view (see _clockLapsed)
        bool settled = vault.potClaimed();
        bool exempt = settled && tid == vault.leader();
        vm.prank(from);
        try pet.transferFrom(from, to, tid) {
            if (dead && !exempt) gDeadTransferSucceeded = true; // an ordinary dead pet must never move
            if (dead) {
                gWinnerDeadTransfers += 1;
                gWinnerDeadTransferId = tid;
                if (!settled) gDeadMovedWhileUnsettled = true; // no exemption exists before settlement
            }
            petOwner[tid] = to;
        } catch {
            if (!dead) gAliveTransferReverted = true; // a live pet's owner move must never be blocked
        }
    }

    // Permissionless settlement poke. On success we snapshot everything the INV7 family asserts:
    // the win conditions held pre-call, the vault sent exactly the pot, the leader's TBA received it.
    function finalize() public {
        bool wasClaimed = vault.potClaimed();
        bool overNow = vault.isOver();
        uint256 potBefore = vault.pot();
        uint256 hatched = vault.hatchedCount();
        uint256 leaderId = vault.leader();
        address leaderTba = leaderId == 0 ? address(0) : issuer.accountOf(leaderId);
        uint256 vaultBefore = careToken.balanceOf(address(vault));
        uint256 tbaBefore = leaderTba == address(0) ? 0 : careToken.balanceOf(leaderTba);

        try vault.finalize() {
            if (wasClaimed) gPostSettleViolation = true; // a second finalize must never succeed
            if (hatched < vault.minPlayers()) gFinalizeUnderMinPlayers = true;
            if (!overNow) gFinalizeBeforeOver = true; // success implies isOver() held pre-call
            gFinalizeCount += 1;
            // NOT tracked here. finalize() is permissionless AND reachable by reentrancy from a
            // hostile care token during another contract's call (the issuer seeding a TBA at mint
            // is guarded by the ISSUER's lock, not the vault's), so a settlement can happen inside
            // an action that is not this one. The vault's own prizeDebited counter is read in the
            // conservation invariant instead, which observes the gross debit wherever it was
            // triggered.
            gSettled = true;
            gFinalizePot = potBefore;
            gFinalizeVaultSentExact = (vaultBefore - careToken.balanceOf(address(vault)) == potBefore);
            gFinalizeTbaReceived = careToken.balanceOf(leaderTba) - tbaBefore;
        } catch {}
    }

    function donate(uint256 amtSeed) public {
        uint256 amt = bound(amtSeed, 1, 1000e18);
        MockCareToken(address(careToken)).mint(address(vault), amt);
        gDonated += amt;
    }

    // --- rewards-leg actions (no-ops for the two-leg campaigns where dist == address(0)) ----------

    // Drop a raw donation straight into the distributor. This creates a balanceOf(dist) > accounted
    // state that the solvency invariant must tolerate and that a later notifyCare folds into the live
    // epoch (exercising _recognize's delta-based donation path). No vault ghost: the distributor keeps
    // its own accounting, wholly separate from the vault's conservation ledger.
    function donateDist(uint256 amtSeed) public {
        if (address(dist) == address(0)) return;
        uint256 amt = bound(amtSeed, 1, 1000e18);
        MockCareToken(address(careToken)).mint(address(dist), amt);
    }

    // Claim a random pet's share of a random FINISHED epoch. This is the ONLY path funds leave the
    // distributor, so it is where solvency (balanceOf >= accounted) could break if the debit were
    // wrong; try/catch swallows the expected NoPoints / AlreadyClaimed / EpochNotFinished reverts.
    function claimReward(uint256 petSeed, uint256 epochSeed) public {
        if (address(dist) == address(0)) return;
        (uint256 tid, bool ok) = _pick(petSeed);
        if (!ok) return;
        uint256 en = dist.epochNow();
        if (en == 0) return; // no finished epoch yet
        uint256 epoch = bound(epochSeed, 0, en - 1);
        try dist.claim(epoch, tid) {} catch {}
    }

    // M-A attack: a hostile owner keeps trying to repoint the standing spender's vault (which would
    // let it drain any TBA). The one-way lock must make this impossible for the whole campaign.
    function ownerRepointVault(uint256 seed) public {
        address evil = address(uint160(bound(seed, 1, type(uint160).max)));
        vm.prank(owner);
        try issuer.setVault(evil) {} catch {}
    }

    function queueSweep(uint256 amtSeed, bool careTokenChoice) public {
        address token = careTokenChoice ? address(careToken) : address(0xBEEF);
        uint256 amt = bound(amtSeed, 0, careToken.balanceOf(address(vault)) + 1);
        vm.prank(owner);
        try vault.queueSweep(token, owner, amt) {} catch {}
    }

    function execSweep() public {
        // Only careToken sweeps affect the accounting. The sweep is surplus-only while the pot is
        // unclaimed (audit econ-F1: the stranded-pot burn is gone), so a successful sweep moves value
        // on exactly ONE leg: the payment to the recipient. The pot must never change here; if the
        // vault ever burned or drained pot in a sweep again, the conservation + pot invariants break.
        uint256 balBefore = careToken.balanceOf(address(vault));
        vm.prank(owner);
        try vault.executeSweep() {
            gSwept += balBefore - careToken.balanceOf(address(vault));
        } catch {}
    }
}

// ================================================================================================
// Invariant base: wires a handler over a chosen careToken and asserts the invariant families.
// ================================================================================================
abstract contract PetVaultInvariantsBase is StdInvariant, Test {
    ERC6551Registry internal registry;
    PetVaultHandler internal handler;
    PetVault internal vault;
    IERC20 internal careToken;

    uint256 internal constant LIFE_TTL = 3600;
    uint256 internal constant CARE_COST = 1e18;
    uint256 internal constant CARE_COOLDOWN = 30;
    uint256 internal constant MIN_PLAYERS = 3;

    function _careToken() internal virtual returns (IERC20);
    function _tokenTakesFee() internal view virtual returns (bool);

    /// @dev Rewards-leg basis points for the campaign. 0 (the default) is the two-leg deploy; a
    ///      derived campaign returns > 0 to wire a live RewardsDistributor as the third leg.
    function _rewardsBps() internal view virtual returns (uint256) {
        return 0;
    }

    function setUp() public {
        registry = new ERC6551Registry();
        careToken = _careToken();
        handler = new PetVaultHandler(
            careToken,
            registry,
            makeAddr("owner"),
            makeAddr("relayer"),
            LIFE_TTL,
            CARE_COST,
            CARE_COOLDOWN,
            MIN_PLAYERS,
            _rewardsBps()
        );
        vault = handler.vault();

        // Fuzz only the handler's action functions.
        bytes4[] memory sel = new bytes4[](15);
        sel[0] = handler.mintPet.selector;
        sel[1] = handler.careOwner.selector;
        sel[2] = handler.careNonOwner.selector; // adversarial: must always revert (INV13)
        sel[3] = handler.warpTime.selector;
        sel[4] = handler.finalize.selector;
        sel[5] = handler.donate.selector;
        sel[6] = handler.queueSweep.selector;
        sel[7] = handler.execSweep.selector;
        sel[8] = handler.ownerRepointVault.selector;
        sel[9] = handler.transferPet.selector;
        sel[10] = handler.donateDist.selector; // no-op unless the rewards leg is live
        sel[11] = handler.claimReward.selector; // no-op unless the rewards leg is live
        sel[12] = handler.careCarerMin.selector; // the one legal carer move (min-need rule)
        sel[13] = handler.careCarerNonMin.selector; // probe: must always revert (INV13b)
        sel[14] = handler.careBadAction.selector; // probe: must always revert (INV13c)
        targetSelector(FuzzSelector({addr: address(handler), selectors: sel}));
        targetContract(address(handler));

        _afterDeploy();
    }

    /// @dev Hook for a derived campaign to finish wiring (e.g. arm the hostile token).
    function _afterDeploy() internal virtual {}

    /// @notice All invariant families, checked after every randomized action. Kept in one campaign so
    ///         the everyday suite stays fast; each property is an internal check with a distinct
    ///         assert message. Campaign depth/runs are set in foundry.toml [profile.default.invariant].
    function invariant_all() public view {
        _inv1_potFullyBacked();
        _inv2_3_conservationOfFlows();
        _inv4_twoSlotTracker();
        _inv5_permanentDeath();
        _inv6_capBounded();
        _inv7_settledIsFinalAndWholePot();
        _inv8_vaultImmutable();
        _inv9_deathSoulbound();
        _inv10_distributorSolvent();
        _inv11_hatchedCount();
        _inv12_dormantEggNeitherAliveNorDead();
        _inv13_careIsOwnerOnly();
        _inv14_deathIffAnyNeedLapsed();
        _inv15_minNeedExposedConsistently();
        _inv16_scoreMonotone();
    }

    /// @dev The pet's min-need stamp derived from needsOf (the raw five-timer ground truth).
    function _minNeedOf(uint256 tid) internal view returns (uint64 m) {
        uint64[5] memory n = vault.needsOf(tid);
        m = n[0];
        for (uint256 i = 1; i < 5; i++) {
            if (n[i] < m) m = n[i];
        }
    }

    // 1. POT FULLY BACKED while unclaimed: the vault's balance always covers the accounted pot, so
    //    the standing prize is never under-collateralized. (The sweep is surplus-only while the pot
    //    is unclaimed and never burns the pot, so the bound holds throughout; a stranded pot simply
    //    stays locked.)
    function _inv1_potFullyBacked() internal view {
        if (!vault.potClaimed()) {
            assertGe(careToken.balanceOf(address(vault)), vault.pot(), "INV1 pot under-collateralized");
        }
    }

    // 2 + 3. CONSERVATION: the vault's careToken balance equals every inflow minus every outflow.
    //        (in = cares received + donations; out = burns + payout + sweeps.) Nothing appears or
    //        disappears, so total out can never exceed total in.
    function _inv2_3_conservationOfFlows() internal view {
        uint256 lhs = careToken.balanceOf(address(vault));
        uint256 rhs =
            handler.gPulledIn() + handler.gDonated() - handler.gBurned() - vault.prizeDebited() - handler.gSwept();
        assertEq(lhs, rhs, "INV2/3 careToken conservation broken");
    }

    // 4. TWO-SLOT TRACKER, MIN-NEED KEYED: the whole endgame state. runnerUpCareAt never exceeds
    //    leaderCareAt; the leader (once one exists) is a registered, hatched pet, and the cached
    //    leaderCareAt equals the leader's DERIVED min(needsOf) (so the O(1) win check reads the true
    //    weakest-link state, not a stale cache).
    function _inv4_twoSlotTracker() internal view {
        uint256 leaderId = vault.leader();
        assertLe(vault.runnerUpCareAt(), vault.leaderCareAt(), "INV4 runnerUp newer than the leader");
        if (leaderId == 0) {
            assertEq(vault.leaderCareAt(), 0, "INV4 leaderCareAt set with no leader");
            assertEq(vault.runnerUpCareAt(), 0, "INV4 runnerUpCareAt set with no leader");
            return;
        }
        (bool registered,,,,) = vault.petState(leaderId);
        assertTrue(registered, "INV4 leader not a registered pet");
        (,,, uint32 careCount,) = vault.memorialState(leaderId);
        assertGt(careCount, 0, "INV4 leader was never fed");
        assertEq(_minNeedOf(leaderId), vault.leaderCareAt(), "INV4 leaderCareAt != leader's min(needsOf)");

        // PROPERTY B (the tracker is HONEST): runnerUpCareAt is exactly the greatest min(needsOf)
        // among every non-leader pet (a dormant egg's min is 0 and never binds). This is the value
        // the endgame is decided on, and nothing above checks it: the assertions so far only relate
        // the two slots to each other and to the leader. A tracker that drifted LOW here would end
        // the season while rivals were still alive, which is precisely the shape of the sparse-start
        // bug that got through before.
        uint256 n = handler.petCount();
        uint256 maxOther;
        for (uint256 i = 0; i < n; i++) {
            uint256 tid = handler.petIds(i);
            if (tid == leaderId) continue;
            uint64 mn = _minNeedOf(tid);
            if (mn > maxOther) maxOther = mn;
        }
        assertEq(uint256(vault.runnerUpCareAt()), maxOther, "INV4 runnerUpCareAt != best non-leader min-need");

        // PROPERTY A (the game never ends while a rival lives): if the season is decidable, every
        // hatched pet other than the leader has actually lapsed. Follows from B, but asserted
        // directly so a future change to _decidesAt cannot quietly break it.
        if (vault.isOver()) {
            for (uint256 i = 0; i < n; i++) {
                uint256 tid = handler.petIds(i);
                if (tid == leaderId) continue;
                assertFalse(vault.alive(tid), "INV4 season decided while a rival was still alive");
            }
        }
    }

    // 5. PERMANENT DEATH: across the whole random sequence, no care() ever succeeded on a pet whose
    //    life timer had already lapsed. There is no revive.
    function _inv5_permanentDeath() internal view {
        assertFalse(handler.gDeadCareSucceeded(), "INV5 a dead pet was fed back to life");
    }

    // 6. CAP BOUNDED: every care debited the TBA exactly careCost and the vault retained exactly the
    //    pot slice (no leak / over-pull). The custodial half (owner can always revoke + drain) is the
    //    deterministic PetVaultCustodyTest below.
    function _inv6_capBounded() internal view {
        assertFalse(handler.gBadCareDebit(), "INV6 a care over-pulled or leaked");
    }

    // 7 (+ payout). SETTLED IS FINAL: at most one finalize, monotonic potClaimed, no register/care/
    //    finalize after settlement, the win conditions (minPlayers gate + isOver) held at the moment
    //    of settlement, the pot fully drained, and the WHOLE pot left the vault to the leader's TBA
    //    (a fee-on-transfer token delivers pot minus its fee, but the vault paid it all).
    function _inv7_settledIsFinalAndWholePot() internal view {
        assertLe(handler.gFinalizeCount(), 1, "INV7 double finalize / double pay");
        assertFalse(handler.gPostSettleViolation(), "INV7 forbidden action succeeded after settlement");
        assertFalse(handler.gPostSettleRegistered(), "INV7 a pet minted after settlement was registered into the game");
        assertFalse(handler.gFinalizeUnderMinPlayers(), "INV7 finalize succeeded under the minPlayers gate");
        assertFalse(handler.gFinalizeBeforeOver(), "INV7 finalize succeeded while isOver() was false");
        if (!handler.gSettled()) return;
        assertTrue(vault.potClaimed(), "INV7 settled but potClaimed false");
        assertEq(vault.pot(), 0, "INV7 settled but pot not drained");
        assertTrue(handler.gFinalizeVaultSentExact(), "INV7 vault did not pay the whole pot");
        if (!_tokenTakesFee()) {
            assertEq(handler.gFinalizeTbaReceived(), handler.gFinalizePot(), "INV7 winner TBA underpaid");
        } else {
            assertLe(handler.gFinalizeTbaReceived(), handler.gFinalizePot(), "INV7 winner TBA overpaid");
        }
    }

    // M-A CLOSED: the standing spender's vault is locked at deploy, so no hostile-owner repoint ever
    // takes effect across the whole random sequence. If it ever changed, the pot / TBAs would be
    // drainable: that is exactly the finding this campaign fuzzes.
    function _inv8_vaultImmutable() internal view {
        assertEq(handler.issuer().vault(), address(vault), "INV8 spender vault was repointed");
    }

    // 9. DEATH-SOULBOUND: across the whole random sequence, no dead pet was ever transferred
    //    owner-to-owner, and no live pet's owner transfer was ever blocked. This is the Pet721
    //    time-based isDead oracle, fuzzed against care / warp / mint interleavings.
    //
    //    9b bounds the ONE carve-out (a settled season's pot winner) to exactly its stated width:
    //    a dead pet may only ever move after the pot is claimed, and only if it IS the winner. If the
    //    exemption were ever broadened by accident, this trips even though 9 alone might not, because
    //    the campaign records every dead-pet move rather than only the disallowed ones.
    function _inv9_deathSoulbound() internal view {
        assertFalse(handler.gDeadMovedWhileUnsettled(), "INV9b a dead pet moved before settlement");
        if (handler.gWinnerDeadTransfers() > 0) {
            assertTrue(vault.potClaimed(), "INV9b a dead pet moved without the pot being settled");
            assertEq(handler.gWinnerDeadTransferId(), vault.leader(), "INV9b a dead NON-winner moved");
        }
        assertFalse(handler.gDeadTransferSucceeded(), "INV9 a dead pet was transferred");
        assertFalse(handler.gAliveTransferReverted(), "INV9 a live pet transfer was wrongly blocked");
    }

    // 10. REWARDS-LEG SOLVENCY (3-leg campaign only): the distributor always holds at least what it
    //     has booked for distribution. This is the RewardsDistributor's core invariant
    //     (balanceOf(this) >= accounted); asserting it across the FULL vault->sink integration proves
    //     the care split routes the rewards slice exactly, notifyCare books exactly what arrives, and
    //     no claim ever over-pays. No-op for the two-leg campaigns (dist == address(0)).
    function _inv10_distributorSolvent() internal view {
        RewardsDistributor d = handler.dist();
        if (address(d) == address(0)) return;
        assertGe(careToken.balanceOf(address(d)), d.accounted(), "INV10 distributor insolvent (balance < accounted)");
    }

    // 11. HATCHED COUNT: hatchedCount (the minPlayers gate's input) counts exactly the distinct pets
    //     that were fed at least once, mirrored by the handler's first-feed ghost.
    function _inv11_hatchedCount() internal view {
        assertEq(vault.hatchedCount(), handler.gHatchedExpected(), "INV11 hatchedCount drifted");
    }

    // 13. CARE AUTHORIZATION RULES: across the whole random sequence, (a) no non-owner that was
    //     never carer-approved ever cared a pet it did not own (audit access-H-1); (b) no approved
    //     carer ever served a strictly non-min need (the five-needs kill-vector fix); (c) no
    //     actionType >= NEED_COUNT was ever accepted, and no BadAction attempt moved a single token.
    function _inv13_careIsOwnerOnly() internal view {
        assertFalse(handler.gNonOwnerCareSucceeded(), "INV13 a non-owner cared someone else's pet");
        assertFalse(handler.gCarerNonMinSucceeded(), "INV13b a carer served a non-min need");
        assertFalse(handler.gBadActionSucceeded(), "INV13c an out-of-range actionType was accepted");
        assertFalse(handler.gBadActionMoved(), "INV13c a BadAction attempt moved tokens");
    }

    // 12. DORMANT EGG (audit death-F1): a registered pet that has NEVER been fed has no timers at
    //     all: ALL FIVE need stamps stay zero until the first care. Across every warp / care /
    //     transfer interleaving it reads neither alive nor dead, so it can never lapse into a
    //     soulbound memorial before it ever hatched.
    function _inv12_dormantEggNeitherAliveNorDead() internal view {
        uint256 n = handler.petCount();
        for (uint256 i = 0; i < n; i++) {
            uint256 tid = handler.petIds(i);
            (,,, uint32 careCount,) = vault.memorialState(tid);
            if (careCount == 0) {
                assertFalse(vault.isDead(tid), "INV12 a never-fed egg read dead");
                (bool registered,, uint64 lastCareAt, bool isAlive,) = vault.petState(tid);
                // A pet minted after settlement is deliberately NOT registered (register() no-ops
                // so the collection survives the season ending). It is a collectible, not an egg.
                if (!registered) continue;
                assertFalse(isAlive, "INV12 a never-fed egg read alive");
                assertEq(lastCareAt, 0, "INV12 register seeded a need stamp");
                uint64[5] memory needs = vault.needsOf(tid);
                for (uint256 j = 0; j < 5; j++) {
                    assertEq(needs[j], 0, "INV12 a dormant egg has a non-zero need stamp");
                }
            }
        }
    }

    // 14. DEATH IFF ANY NEED LAPSED: for every hatched pet, isDead is EXACTLY "some need has gone
    //     unserved a full lifeTtl" (min(needsOf) + lifeTtl <= now), and alive is exactly "all five
    //     are fresh". A dormant egg is neither.
    //
    //     ONE EXEMPTION, BOUNDED THE SAME WAY INV9b BOUNDS THE TRANSFER CARVE-OUT: the champion is
    //     IMMORTAL from settlement on (season 2). It is checked POSITIVELY (alive, never dead, never
    //     a memorial) rather than skipped, and it is exactly one pet id read from the contract's own
    //     state, so every other pet in the collection is still held to the raw clock below.
    function _inv14_deathIffAnyNeedLapsed() internal view {
        uint256 lifeTtl = vault.lifeTtl();
        uint256 n = handler.petCount();
        bool settled = vault.potClaimed();
        uint256 champion = settled ? vault.leader() : 0;
        for (uint256 i = 0; i < n; i++) {
            uint256 tid = handler.petIds(i);
            (bool registered,,,,) = vault.petState(tid);
            (,,, uint32 careCount,) = vault.memorialState(tid);
            if (settled && tid == champion) {
                assertFalse(vault.isDead(tid), "INV14 the champion read dead");
                assertTrue(vault.alive(tid), "INV14 the champion did not read alive");
                (, bool psDead,,, uint256 secondsLeft) = vault.petState(tid);
                assertFalse(psDead, "INV14 petState marked the champion dead");
                // The champion's secondsLeft is 0 UNCONDITIONALLY (no clock binds it): the earlier
                // divergence (a countdown rendered during the fast-finalize window) was fixed in
                // petState after this campaign caught it, so the documented value is now pinned
                // in full rather than only once the winner's own deadline had passed.
                assertEq(secondsLeft, 0, "INV14 the champion is still on a countdown");
                (bool memDead,, uint64 diedAt,,) = vault.memorialState(tid);
                assertFalse(memDead, "INV14 the champion became a memorial");
                assertEq(diedAt, 0, "INV14 the champion was given a death time");
                continue;
            }
            if (!registered || careCount == 0) {
                assertFalse(vault.isDead(tid), "INV14 unhatched pet read dead");
                assertFalse(vault.alive(tid), "INV14 unhatched pet read alive");
                continue;
            }
            bool anyLapsed = uint256(_minNeedOf(tid)) + lifeTtl <= block.timestamp;
            assertEq(vault.isDead(tid), anyLapsed, "INV14 isDead != (any need lapsed)");
            assertEq(vault.alive(tid), !anyLapsed, "INV14 alive != (all five fresh)");
        }
    }

    // 15. MIN-NEED EXPOSED CONSISTENTLY: every life view reports the SAME deadline anchor: the
    //     derived min of the five need stamps (petState.lastCareAt == lifeState.lastCareAt ==
    //     min(needsOf); lifeState.deadline == min + lifeTtl). No cached copy can drift.
    function _inv15_minNeedExposedConsistently() internal view {
        uint256 lifeTtl = vault.lifeTtl();
        uint256 n = handler.petCount();
        for (uint256 i = 0; i < n; i++) {
            uint256 tid = handler.petIds(i);
            uint64 mn = _minNeedOf(tid);
            (,, uint64 psLast,,) = vault.petState(tid);
            (, uint64 lsLast, uint256 deadline) = vault.lifeState(tid);
            assertEq(psLast, mn, "INV15 petState.lastCareAt != min(needsOf)");
            assertEq(lsLast, mn, "INV15 lifeState.lastCareAt != min(needsOf)");
            assertEq(deadline, uint256(mn) + lifeTtl, "INV15 deadline != min + lifeTtl");
        }
    }

    // 16. SCORE MONOTONE: across every successful care, no pet's min-need ever decreased (a care
    //     writes `now` into one stamp, and `now >=` every stored stamp, so the min can only rise or
    //     hold). This is the fact that keeps the O(1) two-slot reduction exact.
    function _inv16_scoreMonotone() internal view {
        assertFalse(handler.gScoreDecreased(), "INV16 a care lowered a pet's min-need");
    }
}

// ---- Concrete campaign 1: a well-behaved 18-decimal token. --------------------------------------
contract PetVaultInvariantsStandard is PetVaultInvariantsBase {
    function _careToken() internal override returns (IERC20) {
        return IERC20(address(new MockCareToken()));
    }

    function _tokenTakesFee() internal pure override returns (bool) {
        return false;
    }
}

// ---- Concrete campaign 2: fee-on-transfer + reentrant-on-transfer hostile token. ----------------
contract PetVaultInvariantsHostile is PetVaultInvariantsBase {
    function _careToken() internal override returns (IERC20) {
        HostileCareToken t = new HostileCareToken(100); // 1% fee, reentrancy armed after wiring
        return IERC20(address(t));
    }

    function _tokenTakesFee() internal pure override returns (bool) {
        return true;
    }

    function _afterDeploy() internal override {
        // Arm reentrancy on the hostile token now that the vault exists.
        HostileCareToken(address(careToken)).setVault(vault);
    }
}

// ---- Concrete campaign 3: the production THREE-leg economy (pot 1000 / rewards 2000 / burn 7000). -
// Wires a REAL RewardsDistributor as the rewards recipient, so every care runs the full split ->
// transfer -> notifyCare integration. Asserts the vault families (the split must not disturb the
// pot/burn/winner accounting) PLUS INV10 (the distributor stays solvent across accrual, donation-
// folding, and claims).
contract PetVaultInvariants3Leg is PetVaultInvariantsBase {
    function _careToken() internal override returns (IERC20) {
        return IERC20(address(new MockCareToken()));
    }

    function _tokenTakesFee() internal pure override returns (bool) {
        return false;
    }

    function _rewardsBps() internal pure override returns (uint256) {
        return 2000;
    }
}

// ================================================================================================
// Deterministic custodial guarantee (invariant 6, funds-safe half): the pet OWNER can ALWAYS revoke
// the issuer's spender and drain their own TBA via execute(). Asserted directly (not an invariant).
// ================================================================================================
contract PetVaultCustodyTest is Test {
    function test_OwnerCanAlwaysRevokeAndDrain() public {
        ERC6551Registry registry = new ERC6551Registry();
        address owner = makeAddr("owner");
        address relayer = makeAddr("relayer");
        address player = makeAddr("player");

        vm.startPrank(owner);
        WalletchiAccount impl = new WalletchiAccount();
        Pet721 pet = new Pet721("W", "W", 100, owner, owner, "");
        MockCareToken care = new MockCareToken();
        PetIssuer issuer = new PetIssuer(
            pet,
            IERC6551Registry(address(registry)),
            address(impl),
            IERC20(address(care)),
            relayer,
            owner,
            1e18,
            1000e18,
            100e18
        );
        PetVault vault = new PetVault(
            PetVault.Params({
                careToken: IERC20(address(care)),
                pet: pet,
                issuer: IPetCareSpender(address(issuer)),
                owner: owner,
                lifeTtl: 3600,
                careCost: 1e18,
                potBps: 1000,
                burnBps: 9000,
                rewardsBps: 0,
                rewardsRecipient: address(0),
                gasBps: 0,
                gasRecipient: address(0),
                abandonGrace: 90 days,
                minPlayers: 3,
                careCooldown: 30,
                minSeasonDuration: 3600,
                entryWindowSecs: 3600,
                selloutStartsSeason: false
            })
        );
        pet.setIssuer(address(issuer));
        issuer.setVault(address(vault));
        vm.stopPrank();
        care.mint(address(issuer), 1_000_000e18);

        vm.prank(relayer);
        (uint256 tid, address tba) = issuer.issuePet(player);
        assertEq(care.balanceOf(tba), 100e18);

        // The owner revokes the spender and drains the TBA: funds are always recoverable.
        vm.startPrank(player);
        WalletchiAccount(payable(tba)).revokeSpender();
        bytes memory data = abi.encodeWithSelector(IERC20.transfer.selector, player, 100e18);
        WalletchiAccount(payable(tba)).execute(address(care), 0, data, 0);
        vm.stopPrank();

        assertEq(care.balanceOf(tba), 0, "TBA drained by owner");
        assertEq(care.balanceOf(player), 100e18, "owner recovered the funds");

        // After revoking, even the OWNER's own care can no longer pull from this pet (warp past the
        // cooldown so the care reaches the spend, which now reverts NotSpender, not CareOnCooldown).
        vm.warp(block.timestamp + 31);
        vm.expectRevert(WalletchiAccount.NotSpender.selector);
        vm.prank(player);
        vault.care(tid, 0);
    }
}
