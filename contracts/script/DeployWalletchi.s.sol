// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Script, console} from "forge-std/Script.sol";
import {Strings} from "@openzeppelin/contracts/utils/Strings.sol";

import {Pet721} from "../src/runner/Pet721.sol";
import {PetIssuer} from "../src/runner/PetIssuer.sol";
import {PetVault, IPetCareSpender} from "../src/runner/PetVault.sol";
import {CareRewardsDistributor} from "../src/runner/CareRewardsDistributor.sol";
import {CareFeeSplitter, IPotState} from "../src/runner/CareFeeSplitter.sol";
import {HolderMerkleVault} from "../src/runner/HolderMerkleVault.sol";
import {MockSwapAdapter} from "../src/runner/MockSwapAdapter.sol";
import {MockCareToken} from "../src/runner/MockCareToken.sol";
import {MockUSDG} from "../src/runner/MockUSDG.sol";
import {WalletchiTransferValidator} from "../src/runner/WalletchiTransferValidator.sol";
import {IERC6551Registry} from "erc6551/interfaces/IERC6551Registry.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {IERC20Metadata} from "@openzeppelin/contracts/token/ERC20/extensions/IERC20Metadata.sol";
import {WalletchiAccount} from "../src/WalletchiAccount.sol";

/// @title DeployWalletchi
/// @notice Deploys the WALLETCHI suite fresh (ENDGAME REDESIGN v2): Pet721 (env-config name/symbol,
///         maxSupply 2000) + PetIssuer + PetVault, plus a MockCareToken when CARE_TOKEN_ADDRESS is
///         unset. Reuses the shared, already-deployed WalletchiAccount implementation. Additive: it
///         touches none of the pre-existing on-chain contracts. After wiring, it LOCKS
///         the pet's issuer (one-way, audit L-2) so the auditors see a frozen mint path.
///
/// Env vars:
///   PRIVATE_KEY        (required) deployer key. Also the fallback owner / relayer.
///   RELAYER            (optional) relayer (mints pets, may care). Default: deployer.
///   TREASURY           (optional) owner of all three contracts. Default: deployer.
///   ACCOUNT_IMPL       (optional) WalletchiAccount impl. Default: 0x0A7eF0f802FA7AE9618F1DF922cB55bd96665e66.
///   CARE_TOKEN_ADDRESS (optional) real care token. Empty / 0x0 => deploy MockCareToken (18dp).
///   PET_NAME           (optional) NFT collection name. Default: "WALLETCHI".
///   PET_SYMBOL         (optional) NFT collection symbol. Default: "WCHI".
///   MAX_SUPPLY         (optional) pet supply cap. Default: 2000.
///   BASE_URI           (optional) metadata base URI; applied if the deployer owns the pet contract.
///   PASS_BASE_URI      (optional) Wallet Pass Extension (ERC draft, 0xef5f1e71) manifest host PREFIX, e.g.
///                                 https://api.playwalletchi.com/wallet-pass/ . The script appends
///                                 eip155/<chainId>/<Pet721 address>/ so passURI(id) is
///                                 <prefix>eip155/<chainId>/<pet>/<id>, which names the chain and
///                                 contract the way the ERC's reference implementation recommends.
///                                 Empty => no pass base is set (passURI then returns a bare id).
///   CONTRACT_URI       (optional) ERC-7572 collection metadata URI (e.g. https://<host>/api/collection.json).
///                                 Default: empty (owner can set it later via setContractURI).
///   ROYALTY_RECIPIENT  (optional) dedicated 5% ERC-2981 royalty recipient. Default: TREASURY/owner.
///                                 Set at deploy, then locked one-way (lockRoyalty).
///   TRANSFER_VALIDATOR (optional) an existing ERC-721C validator to point Pet721 at (e.g. Limit
///                                 Break's canonical validator once live on RH Chain). Empty / 0x0 =>
///                                 deploy a fresh WalletchiTransferValidator (owned by TREASURY). The
///                                 policy ships PERMISSIVE so secondary trading is never bricked; the
///                                 operator flips to strict AFTER a live OpenSea enforcement test,
///                                 then calls Pet721.lockValidator() to atomically freeze both the
///                                 pointer and this collection's validator policy. An existing
///                                 validator must implement lockPolicy/policyLocked for that final lock.
///   DRY_RUN_AS_MAINNET (optional) true => run EVERY mainnet-only require on whatever chain this is,
///                                 so the mainnet deploy path can be rehearsed on testnet first.
///                                 Before this flag existed none of those requires had ever executed.
///   LIFE_TTL           (optional) seconds a pet survives per UNSERVED NEED. Default: 1 day (the
///                                 product: a 24h clock, five interactions a day). Bounds [1h, 30d].
///                                 At <= 1 day the deploy prints a carer-boundary warning; the carer
///                                 sub-cap in WalletchiAccount is what makes that setting safe.
///   ENTRY_WINDOW_SECS  (optional) THE ROSTER CLOSE. Seconds from deploy during which pets may be
///                                 MINTED and eggs may be HATCHED. After it, both are refused and the
///                                 roster is frozen; the season also cannot be decided before it.
///                                 Default: 7 days. Must be >= 1 day, > LIFE_TTL, and <=
///                                 MIN_SEASON_DURATION. A REAL PRODUCT PARAMETER: it is how long
///                                 players get to join.
///   MINT_BUDGET_MAX    (optional) max pets the relayer may mint per MINT_BUDGET_WINDOW. Default: 100.
///                                 Must be non-zero: PetIssuer treats 0 as UNCAPPED.
///   MINT_BUDGET_WINDOW (optional) the mint-budget window in seconds. Default: 3600.
///   CARE_COST          (optional) care token pulled per care (raw units). Default: 1e18.
///   POT_BPS            (optional) pot slice of each fee (bps). Default: 1000 (10%).
///   GAS_BPS            (optional) push-gas slice of each fee (bps), season-2 fourth leg funding the
///                                 reward-push bot. Default: 100 (1%), taken out of the burn.
///   GAS_RECIPIENT      (optional) the ops wallet receiving the gas leg (in CARE). Default: owner.
///   ABANDON_GRACE      (optional) seconds an under-subscribed season stays frozen before anyone may
///                                 abandonSeason() it. Default: 7 days. RAISE ON MAINNET.
///   REWARDS_DUST       (optional) push payouts below this many raw CARE roll forward instead of
///                                 transferring. Default: 0 (disabled).
///   AUTO_CLAIM_LOOKBACK (optional) finished epochs the care hook auto-pushes over. Default: derived
///                                 as ceil(lifeTtl / epochLength) so the LOW-3 invariant holds.
///   REWARDS_BPS        (optional) rewards slice of each fee (bps), routed to a RewardsDistributor.
///                                 Default: 2000 (20%). 0 => no rewards leg and NO distributor deployed.
///                                 POT_BPS + BURN_BPS + REWARDS_BPS + GAS_BPS == 10000.
///   BURN_BPS           (optional) burned slice (bps). Default: the remainder (10000 - POT_BPS -
///                                 REWARDS_BPS - GAS_BPS), i.e. 6900 with the defaults: the season-2
///                                 69/20/10/1 split (Hunt 2026-08-30, SEASON2-NO-CLAIMS-SPEC.md).
///   EPOCH_LENGTH       (optional) care-leg distributor epoch length in seconds. Default: 7200 (2h,
///                                 the push cadence). Only used when REWARDS_BPS > 0.
///
/// TAX ECONOMY (2026-08-17, simplified; all only used when REWARDS_BPS > 0). The launchpad creator-
/// fee stream (letscash Standard Mode 3% tier, paid in USDG) is CLAIMED FROM THE HOOK BY A COLLECTOR
/// ACCOUNT and forwarded to the CareFeeSplitter, which sends HOLDER_BPS to the HolderMerkleVault
/// (USDG snapshot airdrops to holders who own a LIVE pet; the live-pet gate is applied off-chain by
/// the server snapshot job) and SWAPS the remainder USDG -> CARE via a pluggable adapter, donating it
/// a full epoch ahead into the CareRewardsDistributor (CARE, claim-while-alive, flat points).
/// Evolution is visual-only now (no reward multiplier).
///
/// READ THIS BEFORE LAUNCH DAY. THE CREATOR SEAT MUST NEVER BE POINTED AT THE SPLITTER.
/// The launchpad hook's creator fee is PULL-BASED: it accrues to a "creator" seat and is claimable
/// only by hook.claim(poolId) FROM THE CURRENT CREATOR, and the seat is reassignable only by
/// hook.updateCreator(poolId, addr) FROM THE CURRENT CREATOR. Both are current-recipient-only.
/// CareFeeSplitter has NO function that can call either one: its entire external surface is
/// setSwapAdapter / lockSwapAdapter / setSwapParams / setRateMaxAge / distribute / swapFloor /
/// rateIsFresh / rescueToken / renounceOwnership plus Ownable2Step, and it has no low-level call,
/// no delegatecall, no receive() and no fallback(). So pointing the creator seat at the splitter
/// would make the ENTIRE trade-tax revenue stream permanently unclaimable AND permanently
/// un-reassignable. Not delayed: destroyed, with no owner key and no upgrade able to recover it.
/// An earlier version of this script printed exactly that instruction; it is corrected below.
/// POINT THE SEAT AT THE COLLECTOR: an account that can send ARBITRARY calls to the hook, i.e. an
/// EOA whose key the server holds (CARE_FEE_COLLECTOR_PRIVATE_KEY, the same pattern as
/// HOLDER_POSTER_PRIVATE_KEY) or a multisig. The server then claims on the poke cadence and forwards
/// the USDG to the splitter. See server/src/runner/launchpad-inlet.ts and MAINNET-LAUNCH-RUNBOOK.md
/// step 6C. THE HARD RULE: the seat may only ever be assigned to an address that can call claim()
/// AND can hand the seat onward. Verify both with a real transaction before the season opens.
///   FEE_TOKEN_ADDRESS  (optional) the fee-stream currency (USDG). Empty => deploy MockUSDG (6dp,
///                                 testnet only; REQUIRED real on mainnet).
///   HOLDER_BPS         (optional) holder share of each fee distribution, bps. Default: 5000 (half).
///   POSTER             (EFFECTIVELY REQUIRED whenever REWARDS_BPS > 0) holder-vault round poster: a
///                                 DEDICATED server snapshot key. It defaults to TREASURY/owner, and
///                                 TREASURY and RELAYER both default to the deployer, so on a deploy
///                                 with no env vars set POSTER would equal RELAYER. That is exactly
///                                 the one-key-does-everything shape the live deploy has today, and
///                                 the script now REFUSES it. Set POSTER to its own key.
///   HOLDER_MAX_ROUND   (optional) per-round ceiling on the holder airdrop vault, raw USDG (6dp).
///                                 Default: 100000e6. MUST be non-zero: HolderMerkleVault treats 0 as
///                                 "cap not armed" and refuses to post any round at all.
///   SWAP_ADAPTER       (optional) ISwapAdapter for USDG->CARE. Empty on testnet => a MockSwapAdapter
///                                 is deployed (1:1 value); REQUIRED real router on mainnet or the
///                                 player half parks until one is wired. ON MAINNET USE
///                                 RouterSwapAdapter (src/runner/RouterSwapAdapter.sol): it takes a
///                                 LIVE router quote in the same transaction and enforces its own
///                                 floor, so the splitter's hand-maintained hint is only a backstop,
///                                 which is what the splitter's own header requires. It is deployed
///                                 SEPARATELY (it needs the splitter address, which does not exist
///                                 until this script runs) and wired with splitter.setSwapAdapter.
///                                 UNVERIFIED until a real CARE/USDG pool exists: see its MAINNET
///                                 GATE for the four checks a human must do first.
///   CARE_OUT_PER_FEE_TOKEN_1E18 (optional, mainnet) expected CARE-out per 1 USDG, 1e18-scaled, to
///                                 derive the swap minOut. On testnet the mock sets this automatically.
///                                 It is the BACKSTOP floor, never the primary slippage control:
///                                 refresh it from a live quote (RouterSwapAdapter.quoteFloor reads
///                                 the same router the trade will hit) before each poke.
///   SWAP_SLIPPAGE_BPS  (optional) max swap slippage bps (<= 2000). Default: 300 (3%).
///   MIN_PLAYERS        (optional) min DISTINCT fed pets before the pot can be won. Default: 10.
///   CARE_COOLDOWN      (optional) min seconds between explicit cares of the SAME NEED per pet
///                                 (per-need since the five-needs redesign). Default: 0 (the shipped
///                                 design: no cooldown; the TBA dailyCap is the spend brake). Must be
///                                 < LIFE_TTL.
///   PER_TX_CAP         (optional) TBA per-tx spend cap (raw units). Default: CARE_COST.
///   DAILY_CAP          (optional) TBA rolling 24h spend cap (raw units). Default: CARE_COST * 20
///                                 (see DEFAULT_MAX_CARES_PER_DAY).
///   STARTER_TOKENS     (optional) care tokens seeded into each pet TBA at mint. Default: 100e18.
///                                 NOTE (five needs): staying alive burns at least 5 * CARE_COST per
///                                 life window, so at the defaults the seed funds ~20 pet-days, not 100.
///   MOCK_CARE_FLOAT    (optional) with MockCareToken, raw units minted to the issuer float for
///                                 seeding. Default: 200000e18 (2000 pets x 100e18 starter).
///
/// RPC_URL is passed on the command line as --rpc-url. The canonical ERC-6551 registry must already
/// exist on the target chain (it does on Robinhood mainnet and testnet).
contract DeployWalletchi is Script {
    address constant CANONICAL_REGISTRY = 0x000000006551c19487814612e58FE06813775758;
    address constant DEFAULT_ACCOUNT_IMPL = 0x0A7eF0f802FA7AE9618F1DF922cB55bd96665e66;
    uint256 constant RH_MAINNET = 4663;

    struct Config {
        /// @dev TRUE when every mainnet-only require must be enforced: either we really are on RH
        ///      mainnet, or the operator asked for a mainnet REHEARSAL with DRY_RUN_AS_MAINNET=true.
        ///      Before this existed, not one mainnet require had ever executed, on any chain: the
        ///      whole mainnet branch of this script was unrehearsed code that would first run for
        ///      real during the only deploy that matters.
        bool asMainnet;
        uint256 pk;
        address deployer;
        address owner;
        address relayer;
        address accountImpl;
        address careTokenEnv;
        string petName;
        string petSymbol;
        uint256 maxSupply;
        string baseURI;
        string passBaseURIPrefix;
        string contractURI;
        address royaltyRecipient;
        address transferValidatorEnv;
        uint256 lifeTtl;
        uint256 careCost;
        uint256 potBps;
        uint256 burnBps;
        uint256 rewardsBps;
        uint256 gasBps;
        address gasRecipient;
        uint256 abandonGrace;
        uint256 dustThreshold;
        uint256 autoClaimLookback;
        uint256 epochLength;
        address feeTokenEnv;
        uint256 holderBps;
        uint256 holderMaxRound;
        address poster;
        address swapAdapterEnv;
        uint256 careOutPerFeeToken1e18;
        uint256 swapSlippageBps;
        uint256 minPlayers;
        uint256 careCooldown;
        uint256 minSeasonDuration;
        uint256 entryWindowSecs;
        bool selloutStartsSeason;
        uint256 perTxCap;
        uint256 dailyCap;
        uint256 starterAmount;
        uint256 mockFloat;
        uint256 mintsPerWindow;
        uint256 mintWindowSecs;
    }

    /// @dev Per-pet rolling-24h care allowance baked into each new pet account. See _config().
    ///      Under FIVE NEEDS the honest survival baseline is 5 cares/day (one per need per one-day
    ///      life window), so 20 is 4x headroom over the minimum, not 20x.
    uint256 internal constant DEFAULT_MAX_CARES_PER_DAY = 20;

    /// @dev The five-needs care rate: the shipped design ships with CARE_COOLDOWN = 0 in code, so a
    ///      missing env var can never silently revert the redesign to the old one-hour cooldown.
    uint256 internal constant DEFAULT_CARE_COOLDOWN = 0;
    uint256 internal constant NEED_COUNT = 5; // MUST equal PetVault.NEED_COUNT

    /// @dev The pet account's rolling spend window (WalletchiAccount.SPEND_WINDOW). LIFE_TTL must be
    ///      STRICTLY GREATER than this. WHY: the account's daily allowance unlocks at
    ///      windowStart + SPEND_WINDOW, and a pet dies at its last care + LIFE_TTL. When the two are
    ///      equal (the live testnet config: LIFE_TTL 86400 against a 1 day window) a full-cap burn
    ///      timed at a window roll frees the next slot at the exact instant the pet dies, so the
    ///      keeper is locked out for the pet's entire remaining life. The carer sub-cap in
    ///      WalletchiAccount removes the hostile version of this (a carer can never take the owner's
    ///      whole allowance), but an owner can still burn its own cap, so the parameter relation is
    ///      enforced here too. Strictly greater, not >=, because equality IS the failure case.
    uint256 internal constant SPEND_WINDOW = 1 days;

    /// @dev MIRROR of WalletchiAccount.CARER_CAP_BPS. Solidity will not let a script read another
    ///      contract's constant by type, so it is duplicated here and then asserted against the LIVE
    ///      implementation in run(): if the two ever drift, the deploy fails rather than sizing the
    ///      carer budget off a stale number.
    uint256 internal constant CARER_CAP_BPS = 5_000;

    /// @dev Default roster close: entry (mint AND first hatch) stays open this long from seasonStart.
    ///      Sized for a 2000-piece collection: a week is long enough to mint out through a relayer
    ///      that is also rate-limited, and short enough that the season is not all mint phase.
    uint256 internal constant DEFAULT_ENTRY_WINDOW = 7 days;

    /// @dev Default rolling mint budget. Bounds a leaked relayer key to MINT_BUDGET_MAX pets per
    ///      MINT_BUDGET_WINDOW, i.e. that many starter floats, and gives the owner time to setPaused.
    ///      100/hour still mints 16,800 pets across a 7 day entry window, so it never throttles a
    ///      real mint-out of 2000.
    uint256 internal constant DEFAULT_MINT_BUDGET_MAX = 100;
    uint256 internal constant DEFAULT_MINT_BUDGET_WINDOW = 1 hours;

    /// @dev Default per-round ceiling on the holder airdrop vault, in raw FEE TOKEN units (USDG, 6dp)
    ///      = 100,000 USDG. Must be NON-ZERO: HolderMerkleVault treats 0 as "cap not armed" and
    ///      refuses to post any round at all, so a zero default silently disables the holder airdrop.
    uint256 internal constant DEFAULT_HOLDER_MAX_ROUND = 100_000e6;

    function _config() internal view returns (Config memory c) {
        // DRY_RUN_AS_MAINNET forces every mainnet-only require to execute on a testnet deploy, so the
        // mainnet path can be rehearsed before it is run for real. Without it the mainnet branch is
        // dead code everywhere except the one deploy nobody gets to retry.
        c.asMainnet = block.chainid == RH_MAINNET || vm.envOr("DRY_RUN_AS_MAINNET", false);
        c.pk = vm.envUint("PRIVATE_KEY");
        c.deployer = vm.addr(c.pk);
        c.owner = vm.envOr("TREASURY", c.deployer);
        c.relayer = vm.envOr("RELAYER", c.deployer);
        c.accountImpl = vm.envOr("ACCOUNT_IMPL", DEFAULT_ACCOUNT_IMPL);
        c.careTokenEnv = vm.envOr("CARE_TOKEN_ADDRESS", address(0));
        c.petName = vm.envOr("PET_NAME", string("WALLETCHI"));
        c.petSymbol = vm.envOr("PET_SYMBOL", string("WCHI"));
        c.maxSupply = vm.envOr("MAX_SUPPLY", uint256(2000));
        c.baseURI = vm.envOr("BASE_URI", string(""));
        c.contractURI = vm.envOr("CONTRACT_URI", string(""));
        c.passBaseURIPrefix = vm.envOr("PASS_BASE_URI", string(""));
        c.royaltyRecipient = vm.envOr("ROYALTY_RECIPIENT", c.owner);
        c.transferValidatorEnv = vm.envOr("TRANSFER_VALIDATOR", address(0));
        // 1 days IS THE PRODUCT: "24 hour clock, 5 must-do interactions in 24 hours or it dies".
        // It is deliberately NOT raised to dodge the carer-kill boundary, because that would silently
        // turn a 24h game into a 48h game. The boundary is closed structurally instead, by the carer
        // sub-cap in WalletchiAccount, which holds at ANY lifeTtl including exactly 86400. A deploy at
        // lifeTtl <= SPEND_WINDOW still prints a loud warning in run() so the operator knows it is the
        // sub-cap, and not the parameter, doing the work.
        c.lifeTtl = vm.envOr("LIFE_TTL", uint256(1 days));
        c.careCost = vm.envOr("CARE_COST", uint256(1e18));
        c.potBps = vm.envOr("POT_BPS", uint256(1000));
        c.rewardsBps = vm.envOr("REWARDS_BPS", uint256(2000));
        // THE FOURTH LEG (season 2, Hunt 2026-08-30): 1% of every care funds the reward-push bot's
        // gas, taken OUT OF THE BURN (69/20/10/1; SEASON2-NO-CLAIMS-SPEC.md). GAS_RECIPIENT is the
        // ops wallet that receives it (in CARE; converting to native gas is ops, not contracts).
        // Defaults to the treasury/owner so a fresh deploy never invents a hot key.
        c.gasBps = vm.envOr("GAS_BPS", uint256(100));
        c.gasRecipient = c.gasBps > 0 ? vm.envOr("GAS_RECIPIENT", c.owner) : address(0);
        // How long an under-subscribed season stays frozen before permissionless abandonSeason() can
        // settle it. A PARAMETER since season 2: the baked 90 days guarded a five-pet tester season's
        // 0.5 mock-CARE pot for three months. Default sized for tester cadence; RAISE it on mainnet.
        c.abandonGrace = vm.envOr("ABANDON_GRACE", uint256(7 days));
        // 2h epochs = the "push every 2 hours" cadence (Hunt, 2026-08-30; was 6h / 4-a-day).
        c.epochLength = vm.envOr("EPOCH_LENGTH", uint256(2 hours));
        // Push payouts below this roll forward instead of transferring (0 disables). Raw CARE units.
        c.dustThreshold = vm.envOr("REWARDS_DUST", uint256(0));
        // Derived so the LOW-3 invariant (lookback * epochLength >= lifeTtl) holds by construction
        // at ANY epoch length; an env override must still pass the same require below.
        c.autoClaimLookback = vm.envOr("AUTO_CLAIM_LOOKBACK", (c.lifeTtl + c.epochLength - 1) / c.epochLength);
        c.feeTokenEnv = vm.envOr("FEE_TOKEN_ADDRESS", address(0));
        c.holderBps = vm.envOr("HOLDER_BPS", uint256(5000));
        // Per-round AND rolling 24-hour cap on the holder vault: bounds how much a leaked poster key
        // can allocate even when it splits a theft across many self-paying rounds.
        //
        // 0 NO LONGER MEANS "NO CAP", IT MEANS "NOT ARMED": HolderMerkleVault.postRound now FAILS
        // CLOSED until this is set, so the old 0 default would have produced a holder vault that
        // could not post a single round, i.e. a silently dead holder airdrop. It is therefore armed
        // UNCONDITIONALLY, on every chain, with a real default.
        //
        // Units are raw FEE TOKEN (USDG, 6 decimals), so the default below is a 100,000 USDG maximum
        // burst and 100,000 USDG of refill per 24 hours. This is a POLICY number: size it for expected
        // DAILY holder distributions, not merely one snapshot. Retune with HOLDER_MAX_ROUND once real
        // volume is known; setMaxRoundTotal settles and clamps the live allowance when changed.
        c.holderMaxRound = vm.envOr("HOLDER_MAX_ROUND", DEFAULT_HOLDER_MAX_ROUND);
        // POSTER defaults to the TREASURY/owner, NEVER the relayer/mint key (contracts-audit HIGH-5).
        c.poster = vm.envOr("POSTER", c.owner);
        c.swapAdapterEnv = vm.envOr("SWAP_ADAPTER", address(0));
        c.careOutPerFeeToken1e18 = vm.envOr("CARE_OUT_PER_FEE_TOKEN_1E18", uint256(0));
        c.swapSlippageBps = vm.envOr("SWAP_SLIPPAGE_BPS", uint256(300));
        // Burn takes the remainder by default so the four legs always sum to BPS: 6900 with the
        // defaults (69/20/10/1). REWARDS_BPS=0 + GAS_BPS=0 collapses this to the historical two-leg
        // 90% burn. An explicit BURN_BPS still overrides.
        c.burnBps = vm.envOr("BURN_BPS", uint256(10_000) - c.potBps - c.rewardsBps - c.gasBps);
        c.minPlayers = vm.envOr("MIN_PLAYERS", uint256(10));
        c.careCooldown = vm.envOr("CARE_COOLDOWN", DEFAULT_CARE_COOLDOWN);
        // The season cannot be decided before this much time has passed, whatever the care timers
        // say. minPlayers counts PETS and mints are free, so without a floor a handful of pets fed
        // once on day 0 arm the endgame on day 0 and the season is over before the collection mints.
        //
        // DEFAULT RAISED FROM 14 days TO 30 days. It now has to cover the roster close as well as the
        // old job: a 2000-piece collection needs about a week of entry window before the roster even
        // shuts, and 14 days would have left barely a week of actual play after it. 30 days leaves
        // roughly three weeks of survival play past a 7 day entry window. Both numbers are PRODUCT
        // choices, not safety limits, and both are env-overridable.
        c.minSeasonDuration = vm.envOr("MIN_SEASON_DURATION", uint256(30 days));
        // THE ROSTER CLOSE. Entry (mint AND first hatch) is open for this long from seasonStart, and
        // the season cannot be decided before it. See PetVault.entryDeadline.
        c.entryWindowSecs = vm.envOr("ENTRY_WINDOW_SECS", DEFAULT_ENTRY_WINDOW);
        // THE SEASON MODEL. True: nothing hatches or feeds until the collection mints out, and every
        // pet's clock then starts at that one instant. False: the original clock model, where the
        // season is live from deployment and ENTRY_WINDOW_SECS is the roster close.
        c.selloutStartsSeason = vm.envOr("SELLOUT_STARTS_SEASON", false);
        c.mintsPerWindow = vm.envOr("MINT_BUDGET_MAX", DEFAULT_MINT_BUDGET_MAX);
        c.mintWindowSecs = vm.envOr("MINT_BUDGET_WINDOW", DEFAULT_MINT_BUDGET_WINDOW);
        c.perTxCap = vm.envOr("PER_TX_CAP", c.careCost);
        // THE PER-PET DAILY CAP IS A GRIEFING BRAKE, so it must NOT be derived from the cooldown.
        // Deriving it (careCost * 1 days / careCooldown) sets it to exactly the number of cares the
        // cooldown already allows, so the cap can never engage: it looks like a control and is a
        // no-op (and the shipped cooldown is 0, which makes the derivation nonsense outright).
        // Under FIVE NEEDS real survival play is five care actions a day (one per need per one-day
        // life window), so a flat 20 leaves 4x headroom for the most active keeper while capping a
        // hostile approved carer at a TENTH of the stake per day (the carer sub-cap is half the daily
        // cap). THE TWO CARER INVARIANTS: a carer must always serve the pet's currently-weakest need
        // (PetVault reverts CarerMustServeMinNeed otherwise), and a carer's spend is charged against
        // WalletchiAccount.carerDailyCap rather than the shared allowance, so the owner always keeps
        // half the window's headroom no matter what the carer does. Cap-burn griefing is pure stake
        // loss, never a kill and never theft.
        // THE BOUNDARY THAT USED TO BE MERELY NOTED HERE IS NOW ENFORCED: if LIFE_TTL <= the account's
        // rolling 24h spend window, a full-cap burn at T frees its first slot only at or after the
        // death instant. That was a live carer KILL before the sub-cap (see the require on LIFE_TTL in
        // run()), and it is still an owner self-lockout, so LIFE_TTL > 1 days is now required.
        c.dailyCap = vm.envOr("DAILY_CAP", c.careCost * DEFAULT_MAX_CARES_PER_DAY);
        c.starterAmount = vm.envOr("STARTER_TOKENS", uint256(100e18));
        c.mockFloat = vm.envOr("MOCK_CARE_FLOAT", uint256(200000e18));
    }

    function run() external {
        Config memory c = _config();

        require(CANONICAL_REGISTRY.code.length > 0, "ERC-6551 registry missing on this chain");
        require(c.accountImpl != address(0), "ACCOUNT_IMPL=0");
        // CRITICAL (audit): the hardcoded default impl has NO CODE on Robinhood mainnet, so every pet
        // TBA proxies to nothing and silently no-ops (free care, stuck float/pot, dead economy, zero
        // reverts). Require real code always; on mainnet require it be byte-identical to the audited
        // WalletchiAccount (i.e. freshly deployed from THIS commit), not the drifted default.
        require(c.accountImpl.code.length > 0, "ACCOUNT_IMPL has no code on this chain");
        // AND it must be an account from THIS commit, not the older shared implementation. The carer
        // path now calls `spendAsCarer`, which the previous impl does not have, so a deploy that
        // reused the old default would leave every one-tap (carer) care reverting with an opaque
        // failure at play time instead of a clear one at deploy time. Probing the sub-cap constant is
        // the cheapest unambiguous marker of the new ABI.
        {
            (bool okImpl, bytes memory implRet) = c.accountImpl.staticcall(abi.encodeWithSignature("CARER_CAP_BPS()"));
            require(
                okImpl && implRet.length >= 32 && abi.decode(implRet, (uint256)) > 0,
                "ACCOUNT_IMPL predates the carer sub-cap: deploy a fresh WalletchiAccount from this commit"
            );
            // And the mirror below must match the LIVE impl, so the carer-budget arithmetic in this
            // script can never be computed against a stale number.
            require(
                abi.decode(implRet, (uint256)) == CARER_CAP_BPS,
                "ACCOUNT_IMPL CARER_CAP_BPS != this script's mirror (update DeployWalletchi)"
            );
        }
        if (c.asMainnet) {
            require(
                c.accountImpl.codehash == keccak256(type(WalletchiAccount).runtimeCode),
                "ACCOUNT_IMPL != audited WalletchiAccount (deploy fresh from this commit)"
            );
            require(c.minPlayers >= 2, "MIN_PLAYERS too low for mainnet");
        }
        // THE ROSTER CLOSE (see PetVault.entryDeadline). Three relations, each with teeth:
        //  1. It must be long enough to actually mint the collection, or pets go unminted forever.
        //  2. It must not exceed the minimum season, or the season would be all entry phase and the
        //     MIN_SEASON_DURATION floor would be silently overridden by the entry floor.
        //  3. It must outlast one life window, or a pet hatched near the close could die before the
        //     season is even decidable, which would waste the entry it just paid for.
        //
        // ALL THREE ARE ABOUT A CLOCK-BASED ROSTER CLOSE, so none of them apply under the sellout
        // model, where the roster closes on the collection minting out and `entryWindowSecs` governs
        // nothing. Enforcing them there would be worse than merely useless: relation 2 caps the
        // entry window at the season length, which on 2026-08-26 forced a 36-hour window onto a
        // 2-day testnet season, and that window expired during an outage and permanently bricked
        // every unhatched egg. The sellout model has no such window to expire.
        if (!c.selloutStartsSeason) {
            require(c.entryWindowSecs >= 1 days, "ENTRY_WINDOW_SECS too short to mint out a collection");
            require(
                c.entryWindowSecs <= c.minSeasonDuration,
                "ENTRY_WINDOW_SECS > MIN_SEASON_DURATION: the season would be all mint phase"
            );
            require(c.entryWindowSecs > c.lifeTtl, "ENTRY_WINDOW_SECS must outlast one life window");
        } else {
            // Mirrors the vault's own constructor guard, but fails HERE with a sentence naming the
            // two knobs, because this is where an operator actually sets them.
            require(
                c.maxSupply >= c.minPlayers,
                "MAX_SUPPLY < MIN_PLAYERS: a sellout could never make this season decidable"
            );
        }
        // ARM THE MINT BUDGET. PetIssuer ships with mintsPerWindow == 0, which means UNCAPPED, and
        // this script never called setMintBudget, so every deploy to date handed a single hot relayer
        // key the whole collection plus maxSupply * STARTER_TOKENS of float in one transaction burst.
        // The budget must still be able to mint out the collection inside the entry window, or the
        // brake becomes the bug.
        require(c.mintsPerWindow > 0 && c.mintWindowSecs > 0, "mint budget must be armed (non-zero)");
        require(
            c.mintsPerWindow * (c.entryWindowSecs / c.mintWindowSecs) >= c.maxSupply,
            "mint budget cannot mint out MAX_SUPPLY before the entry window closes"
        );
        // Cap calibration (audit I-3): a single care must fit the per-tx cap and the daily cap.
        require(c.careCost <= c.perTxCap, "careCost > perTxCap");
        require(c.careCost <= c.dailyCap, "careCost > dailyCap");
        // Audit deploy-F4: fail at deploy (not at the first mint) if the caps are inconsistent.
        require(c.perTxCap <= c.dailyCap, "perTxCap > dailyCap");
        // The caps must sustain the CARE RATE the life window demands, not just one care. Under FIVE
        // NEEDS every need must be served once per life window, so the survival rate is
        // 5 * ceil(1 day / lifeTtl) cares per rolling 24h window (mirrors PetIssuer's
        // _requireCapsFeedable; +1 covers the phase drift between the mint-anchored spend window and
        // the need timers). Defaults pass: 20 >= 5*1 + 1 = 6. Fail here rather than at the first mint.
        {
            uint256 needsPerWindow = NEED_COUNT * ((1 days + c.lifeTtl - 1) / c.lifeTtl); // 5 * ceil
            require(c.dailyCap >= c.careCost * (needsPerWindow + 1), "dailyCap cannot sustain lifeTtl");
            // THE CARER SUB-CAP MUST ALSO SUSTAIN THE PET. One-tap care from a wallet pass runs
            // through an owner-approved CARER, so in the intended product flow the carer does most of
            // the feeding. Its budget is a fraction of dailyCap (WalletchiAccount.CARER_CAP_BPS), and
            // the statutory dailyCap minimum above is computed WITHOUT that fraction, so a deploy
            // could satisfy it and still ship a collection no carer could keep alive. Checked here
            // rather than in PetIssuer because the contract-level minimum has to stay permissive for
            // the short-window rehearsal configs in the test matrix.
            uint256 carerBudget = (c.dailyCap * CARER_CAP_BPS) / 10_000;
            require(
                carerBudget >= c.careCost * needsPerWindow,
                "DAILY_CAP too low: the carer sub-cap could not keep a pet alive on one-tap care alone"
            );
        }
        // THE CARER-KILL BOUNDARY, ANNOUNCED RATHER THAN LEGISLATED. The pet account's daily allowance
        // unlocks at windowStart + SPEND_WINDOW; a pet dies at its last care + LIFE_TTL. When those are
        // equal (LIFE_TTL == 86400, which IS the product: a 24 hour clock and five interactions a day)
        // a full-cap burn frees the next spend slot at the exact instant the pet dies. This is NOT
        // refused, because the game's clock is a product decision and not the deployer's to change.
        // What closes it is structural: WalletchiAccount charges an approved carer against its own
        // sub-cap, so a carer can never take the owner's share of the window and the owner always has
        // headroom to feed back. The residual at this setting is an OWNER burning its own full cap,
        // which is self-inflicted. Pinned at exactly 86400 by the carer-kill regression test.
        if (c.lifeTtl <= SPEND_WINDOW) {
            console.log("WARNING: LIFE_TTL <= the pet account spend window (1 days).");
            console.log("  LIFE_TTL (s):", c.lifeTtl);
            console.log("  account SPEND_WINDOW (s):", SPEND_WINDOW);
            console.log("  A single full-cap burn at a window roll unlocks exactly when the pet dies.");
            console.log("  This is SAFE against an approved carer ONLY because of the carer sub-cap");
            console.log("  (WalletchiAccount.CARER_CAP_BPS): a carer can never consume the owner's");
            console.log("  headroom, so the owner can always feed back inside the same window.");
            console.log("  An OWNER can still burn its own full cap and lock itself out until death.");
            console.log("  Proceeding: you are choosing this tight configuration knowingly.");
        }
        // THE STARTER SEED DECIDES THE FIRST RUN. Mint-time arming sends ONE owner-signed care as its
        // first step: that care is what installs the EIP-7702 delegation and hatches the pet (filling
        // all five need bowls at once), and it is paid out of the pet's own seeded float. A seed below
        // careCost means pullCare reverts on that first care, so there is no delegation, no session
        // and no hatch, and every keeper is bounced back to the website for their first feed. That is
        // the exact experience testers rejected. NOTE (five needs): a life window burns at least
        // 5 * careCost, so the default 100e18 seed funds roughly 20 pet-days, not 100.
        //
        // The other direction is the reason not to seed generously: mints are free, so a large seed
        // hands a fresh pet a free run of cares, and because care() takes the leader seat, a free mint
        // becomes a free bid for the pot. A SMALL non-zero seed resolves both: the first tap works, and
        // holding the lead past one life window requires the owner to actually buy care tokens.
        require(c.starterAmount >= c.careCost, "STARTER_TOKENS below careCost: no pet could ever hatch");
        if (c.asMainnet) {
            require(
                c.starterAmount <= c.careCost * 5,
                "STARTER_TOKENS too generous for mainnet: a free mint becomes a free bid for the pot"
            );
        }
        // THE POSTER MUST NOT BE THE RELAYER (contracts-audit HIGH-5). Two roles, two threat models:
        // the relayer is a hot key the server hammers to mint, the poster allocates holder-airdrop
        // rounds. One leaked key must not be able to do both. The live deploy has poster == relayer ==
        // owner == deployer, which is exactly what this script's own comments said must never happen
        // and which nothing ever actually checked. Checked on EVERY chain, not just mainnet, because
        // testnet is where the operator builds the habit of which key is which.
        if (c.rewardsBps > 0) {
            require(c.poster != c.relayer, "POSTER == RELAYER: the round poster must be a dedicated key");
        }
        // THE CARE TOKEN MUST RETURN A BOOL FROM transfer(). PetVault.finalize() pays the winner with
        // `try careToken.transfer(...) returns (bool ok)`. A USDT-style token that returns NO data
        // makes that decode fail, so EVERY payout lands in the catch branch and is deferred: auto-pay
        // is permanently dead and every prize has to be manually claimed. Mainnet CARE is a
        // third-party letscash launch, so this is a real token we do not control. Probed before the
        // broadcast so it costs nothing and produces no transaction.
        if (c.careTokenEnv != address(0)) {
            requireBoolReturningTransfer(c.careTokenEnv);
            // AND prove it moves value. "Succeeded with empty return data" is treated as success by
            // both the vault payout and the distributor auto-claim (a USDT-style token needs that),
            // and a codeless or stub address produces exactly that while moving nothing.
            requireTokenReallyMoves(c.careTokenEnv, c.deployer);
        }
        // The FEE token (USDG) gets the cheap half of the same treatment: code presence and a real
        // bool return. NOT the value-movement probe, because the fee stream is paid by the launchpad
        // and the deployer is not expected to hold USDG at deploy time, so requiring a balance would
        // block a correct deploy. The splitter accounts its legs on balances received, so a stub fee
        // token surfaces as zero distributions rather than as silently vanished value.
        if (c.feeTokenEnv != address(0)) requireBoolReturningTransfer(c.feeTokenEnv);

        vm.startBroadcast(c.pk);

        // 1. Resolve the care token (real or mock). HIGH (audit): the mock is openly mintable, so it
        // must NEVER be the mainnet season currency; hard-require a real, code-bearing, 18-decimal
        // token on mainnet (all raw-unit defaults assume 18dp).
        bool usingMock = c.careTokenEnv == address(0);
        require(!usingMock || !c.asMainnet, "CARE_TOKEN_ADDRESS required on mainnet (no mock)");
        if (!usingMock) {
            require(c.careTokenEnv.code.length > 0, "care token has no code");
            require(IERC20Metadata(c.careTokenEnv).decimals() == 18, "care token must be 18 decimals");
        }
        IERC20 careToken = usingMock ? IERC20(address(new MockCareToken())) : IERC20(c.careTokenEnv);

        // 2. Pet NFT (env-config name/symbol), fresh season supply, dedicated 5% royalty recipient.
        Pet721 pet = new Pet721(c.petName, c.petSymbol, c.maxSupply, c.owner, c.royaltyRecipient, c.contractURI);

        // 2b. ERC-721C validator: reference an existing one (env), else deploy a fresh permissive one
        //     owned by the treasury. The launch policy is PERMISSIVE so secondary trading is not
        //     bricked; the operator flips to strict AFTER a live OpenSea enforcement test, then calls
        //     pet.lockValidator() to freeze the address AND this collection's policy atomically.
        bool deployedValidator = c.transferValidatorEnv == address(0);
        address validator = c.transferValidatorEnv;
        if (deployedValidator) {
            WalletchiTransferValidator wv = new WalletchiTransferValidator(c.owner);
            validator = address(wv);
            if (wv.owner() == c.deployer) {
                wv.setSecurityLevel(address(pet), WalletchiTransferValidator.SecurityLevel.Permissive);
            }
        }

        // 3. Issuer (reuses the shared WalletchiAccount impl; no game token).
        PetIssuer issuer = new PetIssuer(
            pet,
            IERC6551Registry(CANONICAL_REGISTRY),
            c.accountImpl,
            careToken,
            c.relayer,
            c.owner,
            c.perTxCap,
            c.dailyCap,
            c.starterAmount
        );

        // 4. Survival vault + the tax-economy reward stack when REWARDS_BPS > 0 (ONE CARE claim-while-
        //    alive distributor wired straight to the vault, a USDG holder-airdrop vault, a fee splitter
        //    with a USDG->CARE swap adapter). Empty in the two-leg (REWARDS_BPS == 0) case. The
        //    splitter is deployed in step 5b (it needs the vault address for potClaimed).
        (PetVault vault, TaxStack memory ts) = _deployVault(c, careToken, pet, issuer);

        // 5. Wire everything if the deployer owns the contracts; else the owner must do it. Every
        //    one-way lock (issuer, royalty, vault reference on the pet; vault on the issuer) is called
        //    here so production ships fully frozen (audit L-2 / M-A and the Phase S royalty rug guard).
        if (pet.owner() == c.deployer) {
            pet.setIssuer(address(issuer));
            if (bytes(c.baseURI).length > 0) pet.setBaseURI(c.baseURI);
            // Wallet Pass Extension: point passURI at the manifest endpoint for THIS chain + contract.
            if (bytes(c.passBaseURIPrefix).length > 0) {
                pet.setPassBaseURI(_passBase(c.passBaseURIPrefix, address(pet)));
            }
            // ERC-721C: point at the validator. It deliberately stays mutable until the live market
            // test; the final runbook step is pet.lockValidator(), which now also locks policy state.
            pet.setTransferValidator(validator);
            // ERC-2981: set the dedicated 5% recipient, then freeze it one-way.
            pet.setRoyalty(c.royaltyRecipient, pet.DEFAULT_ROYALTY_BPS());
            pet.lockRoyalty();
            // Death-soulbound: wire the vault reference, then freeze it one-way.
            pet.setVaultRef(address(vault));
            pet.lockVaultRef();
            pet.lockIssuer();
        } else {
            console.log(
                "NOTE: pet owner != deployer; owner must wire issuer/validator/royalty/vaultRef + lock:",
                address(issuer)
            );
        }
        if (issuer.owner() == c.deployer) {
            issuer.setVault(address(vault));
            issuer.lockVault(); // M-A: freeze the spender's vault so no owner can ever repoint pullCare
            // ARM THE MINT BUDGET. PetIssuer ships with mintsPerWindow == 0, which its own code treats
            // as UNCAPPED, and this script never called setMintBudget: every deploy so far left a
            // single hot relayer key able to mint the entire collection, and every starter float with
            // it, in one burst. The budget is the only thing between a leaked relayer key and that.
            issuer.setMintBudget(c.mintsPerWindow, c.mintWindowSecs);
            require(issuer.mintsPerWindow() > 0, "gate: mint budget not armed");
        } else {
            console.log("NOTE: issuer owner != deployer; owner must setVault + lockVault:", address(vault));
            console.log(
                "NOTE: owner must ALSO call issuer.setMintBudget (max, windowSecs):", c.mintsPerWindow, c.mintWindowSecs
            );
        }

        // 5b. Wire the reward stack. The CARE distributor is the vault's rewardsRecipient and its sole
        //     notifyCare caller + liveness oracle, so distributor.setVault(vault) MUST be set before the
        //     season opens (care() reverts until it is). The splitter is deployed HERE (it needs the
        //     vault for potClaimed) and its testnet swap adapter wired.
        if (c.rewardsBps > 0) {
            // LOW-3: a pet caring at the edge of each life window must always auto-collect everything,
            // which needs the auto-claim lookback to span at least one life window.
            require(
                ts.distributor.autoClaimLookback() * c.epochLength >= c.lifeTtl,
                "autoClaimLookback * epochLength < lifeTtl (pets could lose epochs)"
            );
            // The per-round + rolling allowance must be armed. Without the aggregate half, a leaked
            // poster could split the whole balance across many individually capped rounds.
            // On EVERY chain, not just mainnet: 0 means the holder vault cannot post a round at all.
            require(
                c.holderMaxRound > 0, "HOLDER_MAX_ROUND must be non-zero: 0 means NOT ARMED and postRound fails closed"
            );
            if (ts.distributor.owner() == c.deployer) {
                ts.distributor.setVault(address(vault));
                require(address(ts.distributor.vault()) == address(vault), "distributor setVault failed");
            } else {
                console.log(
                    "NOTE: distributor owner != deployer; owner must call distributor.setVault:", address(vault)
                );
            }
            // ARM THE ROUND CAP UNCONDITIONALLY. Skipping it leaves postRound reverting
            // RoundCapNotArmed forever, which reads as "the holder airdrop is broken" with no signal.
            if (ts.holderVault.owner() == c.deployer) {
                ts.holderVault.setMaxRoundTotal(c.holderMaxRound);
                require(ts.holderVault.maxRoundTotal() > 0, "gate: holder round cap not armed");
                require(
                    ts.holderVault.postingAllowanceAvailable() == c.holderMaxRound,
                    "gate: initial holder posting allowance not fully armed"
                );
            } else {
                console.log(
                    "NOTE: holderVault owner != deployer; owner MUST call setMaxRoundTotal or NO round can be posted:",
                    c.holderMaxRound
                );
            }
            // Reward pushes change the CARE balance a pass shows, so the distributor may ask Pet721 to
            // emit the ERC's PassUpdate / BatchPassUpdate (the vault is allowed implicitly via vaultRef).
            if (pet.owner() == c.deployer) {
                pet.setPassSignaler(address(ts.distributor), true);
            } else {
                console.log(
                    "NOTE: pet owner != deployer; owner must call pet.setPassSignaler(distributor, true):",
                    address(ts.distributor)
                );
            }
            // Deploy the splitter now that the vault exists (immutable vault ref for potClaimed).
            ts.splitter = new CareFeeSplitter(
                c.owner, ts.feeToken, address(ts.holderVault), ts.distributor, IPotState(address(vault)), c.holderBps
            );
            // Wire the swap adapter: the testnet mock, or a real router from SWAP_ADAPTER on mainnet.
            address adapter = address(ts.mockSwap) != address(0) ? address(ts.mockSwap) : c.swapAdapterEnv;
            if (ts.splitter.owner() == c.deployer && adapter != address(0)) {
                ts.splitter.setSwapAdapter(adapter);
                // careOutPerFeeToken1e18: with the 1:1 testnet mock and USDG(6dp)->CARE(18dp), 1 USDG
                // (1e6 raw) maps to 1 CARE (1e18 raw) at rate 1/1 ONLY if decimals matched; the mock is
                // raw-unit 1:1, so set the hint to the raw ratio 1e18/1e6 = 1e30 so minOut is derived
                // correctly. On mainnet set this from the real pool price.
                uint256 hint = ts.usingMockFee ? uint256(1e30) : c.careOutPerFeeToken1e18;
                if (hint > 0) ts.splitter.setSwapParams(c.swapSlippageBps, hint);
            } else if (adapter == address(0)) {
                console.log("NOTE: no swap adapter (SWAP_ADAPTER unset on mainnet); player half parks until wired");
            }
        }

        // 5b-2. (Audit H-2) lifeTtl is now IMMUTABLE on the vault, so there is nothing to lock: the life
        //       window is fixed at construction and the operator can neither shorten it (mass-kill +
        //       pick a winner) nor lengthen it (resurrect dead pets). No lockConfig step is needed.

        // 5c. Ownership handoff (audit): after wiring+locking with a hot deployer, hand off to the real
        //     owner (e.g. a multisig). Ownable2Step means this only SETS the pending owner, so FINAL_OWNER
        //     must acceptOwnership() to complete, so a typo'd address is recoverable, not a bricked rug.
        //     This gives a safe mainnet path: atomic wire+lock, then 2-step handoff (current owner stays
        //     the deployer until acceptance, so the gate-check below still sees a fully-owned deploy).
        address finalOwner = vm.envOr("FINAL_OWNER", address(0));
        if (finalOwner != address(0) && finalOwner != c.deployer) {
            if (pet.owner() == c.deployer) pet.transferOwnership(finalOwner);
            if (issuer.owner() == c.deployer) issuer.transferOwnership(finalOwner);
            if (vault.owner() == c.deployer) vault.transferOwnership(finalOwner);
            if (c.rewardsBps > 0) {
                if (ts.distributor.owner() == c.deployer) ts.distributor.transferOwnership(finalOwner);
                if (ts.holderVault.owner() == c.deployer) ts.holderVault.transferOwnership(finalOwner);
                if (ts.splitter.owner() == c.deployer) ts.splitter.transferOwnership(finalOwner);
            }
            if (deployedValidator && WalletchiTransferValidator(validator).owner() == c.deployer) {
                WalletchiTransferValidator(validator).transferOwnership(finalOwner);
            }
            console.log("Ownership handoff PENDING to FINAL_OWNER (must acceptOwnership):", finalOwner);
        }

        // 6. Seed the issuer care float when using the mock so issuePet can seed each pet TBA.
        if (usingMock) MockCareToken(address(careToken)).mint(address(issuer), c.mockFloat);

        vm.stopBroadcast();

        _report(c, pet, issuer, vault, ts, careToken, usingMock, validator);
        _gateCheck(c, pet, issuer);

        // HIGH (audit): a mainnet deploy where owner != deployer (a multisig, the correct posture)
        // wires and locks NOTHING here: it must be hand-wired per the multisig runbook and verified
        // with a wiring-assertion script. Refuse to exit green so a half-wired, unlocked deploy
        // (ruggable royalty, repointable spender, soulbound off) is never mistaken for done. The
        // operator sets ALLOW_MANUAL_WIRING=true to acknowledge, then hand-wires + verifies.
        if (c.asMainnet && (pet.owner() != c.deployer || issuer.owner() != c.deployer)) {
            require(
                vm.envOr("ALLOW_MANUAL_WIRING", false),
                "mainnet: owner != deployer -> hand-wire+lock per the runbook, verify on-chain, and set ALLOW_MANUAL_WIRING=true to acknowledge"
            );
        }
    }

    /// @notice Probe that `token.transfer` actually RETURNS a bool, and revert with a specific message
    ///         if it does not. Public so the regression suite can point it at a USDT-style token
    ///         without needing env vars or a broadcast.
    /// @dev    WHY A PROBE AND NOT A STATIC READ. There is no way to ask a deployed ERC-20 what its
    ///         transfer returns without calling it: the ABI is a claim, the bytecode is the truth. So
    ///         this performs a zero-amount transfer to itself, which every conforming token accepts and
    ///         which moves nothing, and inspects the RETURNDATA LENGTH. A compliant token returns one
    ///         32-byte word; a USDT-style token returns nothing, and that is precisely the case that
    ///         silently routes every PetVault.finalize() payout into its catch branch.
    function requireBoolReturningTransfer(address token) public {
        require(token.code.length > 0, "care token has no code");
        (bool ok, bytes memory ret) =
            token.call(abi.encodeWithSelector(IERC20.transfer.selector, address(this), uint256(0)));
        require(ok, "care token transfer(0) reverted: its ERC20 return value cannot be verified");
        require(
            ret.length >= 32,
            "care token transfer returns no data (USDT-style): finalize() could never auto-pay a prize"
        );
        require(abi.decode(ret, (bool)), "care token transfer(0) returned false");
    }

    /// @notice Prove the care token actually MOVES VALUE, by sending one raw unit from `holder` and
    ///         checking the balance really left. Public so the regression suite can drive it.
    /// @dev    WHY THIS IS NEEDED ON TOP OF THE RETURN-VALUE PROBE. Both the vault payout and the
    ///         distributor's auto-claim treat "call succeeded, no return data" as success, which they
    ///         must in order to support USDT-style tokens. A raw call to an address with NO CODE also
    ///         succeeds with no return data. So a mistyped or not-yet-deployed token address would
    ///         make every transfer report success while moving nothing, and rewards would vanish with
    ///         zero signal. Code presence is checked first; this then proves the code is a real ERC-20
    ///         and not a stub that accepts everything.
    ///
    ///         The SENDER debit is asserted exactly, not the recipient credit, because the system is
    ///         deliberately fee-on-transfer safe (every leg is accounted on the balance actually
    ///         received) and a fee-taking token would legitimately deliver less than it debits.
    ///
    ///         Run BEFORE vm.startBroadcast, so it executes against forked state locally and produces
    ///         no transaction and no real transfer.
    function requireTokenReallyMoves(address token, address holder) public {
        require(token.code.length > 0, "care token has no code");
        uint256 holderBefore = IERC20(token).balanceOf(holder);
        require(
            holderBefore > 0, "deployer holds no CARE: fund the deployer before deploying so the token can be verified"
        );
        address probe = address(uint160(uint256(keccak256("walletchi.token.probe"))));
        uint256 probeBefore = IERC20(token).balanceOf(probe);

        vm.prank(holder);
        (bool ok, bytes memory ret) = token.call(abi.encodeCall(IERC20.transfer, (probe, 1)));
        require(ok, "care token transfer(1) reverted");
        require(ret.length == 0 || abi.decode(ret, (bool)), "care token transfer(1) returned false");

        require(
            IERC20(token).balanceOf(holder) == holderBefore - 1,
            "care token did not debit the sender: it is not a real ERC-20 and rewards would vanish"
        );
        if (IERC20(token).balanceOf(probe) != probeBefore + 1) {
            console.log("NOTE: care token appears to take a transfer fee (recipient credit != debit).");
            console.log("  That is supported (every leg is accounted on the balance actually received),");
            console.log("  but size CARE_COST and the caps with the fee in mind.");
        }
    }

    /// @dev `<prefix>eip155/<chainId>/<pet>/`. VerifyWalletchiWiring composes the same shape to
    ///      assert the round trip.
    function _passBase(string memory prefix, address pet) internal view returns (string memory) {
        return string.concat(prefix, "eip155/", Strings.toString(block.chainid), "/", Strings.toHexString(pet), "/");
    }

    /// @dev Post-deploy gate-check: print and (when the deployer wired everything) REQUIRE that every
    ///      production lock is engaged, so a half-wired deploy fails loudly rather than shipping open.
    function _gateCheck(Config memory c, Pet721 pet, PetIssuer issuer) internal view {
        bool issuerLocked = pet.issuerLocked();
        bool royaltyLocked = pet.royaltyLocked();
        bool vaultRefLocked = pet.vaultRefLocked();
        bool vaultLocked = issuer.vaultLocked();
        console.log("=== POST-DEPLOY GATE-CHECK (all must be true in production) ===");
        console.log("  pet.issuerLocked:", issuerLocked);
        console.log("  pet.royaltyLocked:", royaltyLocked);
        console.log("  pet.vaultRefLocked:", vaultRefLocked);
        console.log("  issuer.vaultLocked:", vaultLocked);
        console.log("  issuer.mintsPerWindow (0 == UNCAPPED, must be non-zero):", issuer.mintsPerWindow());
        if (pet.owner() == c.deployer && issuer.owner() == c.deployer) {
            require(issuerLocked, "gate: issuer not locked");
            require(royaltyLocked, "gate: royalty not locked");
            require(vaultRefLocked, "gate: vault ref not locked");
            require(vaultLocked, "gate: issuer vault not locked");
            // A leaked relayer key with an unarmed budget mints the whole collection.
            require(issuer.mintsPerWindow() > 0, "gate: mint budget not armed");
            console.log("  ALL LOCKS ENGAGED: production is frozen.");
        } else {
            console.log("  NOTE: owner != deployer; the owner must engage the locks above.");
        }
    }

    /// @dev The tax-economy reward stack (empty when REWARDS_BPS == 0, the clean two-leg deploy).
    ///      Simplified 2026-08-17 (Hunt): ONE CARE claim-while-alive distributor wired straight to the
    ///      vault (no mux, no weighting fork), a USDG holder-airdrop vault, and a splitter that swaps
    ///      the player half USDG->CARE via a pluggable adapter.
    struct TaxStack {
        CareRewardsDistributor distributor; // CARE, claim-while-alive; = the vault's rewardsRecipient
        HolderMerkleVault holderVault; // the holder half: USDG snapshot airdrop rounds (live-pet gated off-chain)
        // Where the claimed creator fee is FORWARDED to (USDG), and the 4x/day poke target. It is the
        // destination of the MONEY and never of the creator SEAT: it cannot call hook.claim or
        // hook.updateCreator, so holding the seat would destroy the stream. See the header.
        CareFeeSplitter splitter;
        MockSwapAdapter mockSwap; // testnet USDG->CARE swap stand-in (address(0) with a real adapter)
        IERC20 feeToken; // USDG (mock on a bare testnet deploy)
        bool usingMockFee;
    }

    /// @dev Deploys the fee token (or resolves the real USDG), the CARE distributor, the holder vault
    ///      and the splitter (+ a mock swap adapter on testnet). Wiring happens in run(); everything
    ///      here is construction only so a revert cannot leave a half-wired stack.
    function _deployTaxStack(Config memory c, IERC20 careToken) internal returns (TaxStack memory ts) {
        ts.usingMockFee = c.feeTokenEnv == address(0);
        require(!ts.usingMockFee || !c.asMainnet, "FEE_TOKEN_ADDRESS required on mainnet (no mock)");
        if (!ts.usingMockFee) {
            require(c.feeTokenEnv.code.length > 0, "fee token has no code");
            require(c.feeTokenEnv != address(careToken), "fee token must differ from the care token");
        }
        ts.feeToken = ts.usingMockFee ? IERC20(address(new MockUSDG())) : IERC20(c.feeTokenEnv);

        // Owner is the treasury throughout: the distributor exposes only a one-time setVault and no
        // owner withdrawal path; the holder vault pays only via Merkle claims; the splitter's owner
        // can rescue stray tokens + set the swap adapter, but never touches reward money.
        ts.distributor =
            new CareRewardsDistributor(c.owner, careToken, c.epochLength, c.dustThreshold, c.autoClaimLookback);
        // POSTER is a DEDICATED key, NEVER the relayer/mint key (contracts-audit HIGH-5). Defaults to
        // the treasury/owner when unset, so a fresh deploy never hands round-posting to the hot key.
        ts.holderVault = new HolderMerkleVault(c.owner, ts.feeToken, c.poster);
        // A testnet swap stand-in so the fee->swap->distribute path is rehearsable without a real
        // CARE/USDG pool. Rate 1e12/1 maps 1 USDG (1e6 raw, 6dp) -> 1 CARE (1e18 raw, 18dp), a 1:1
        // VALUE swap across the decimal gap. On mainnet a real router adapter is wired via SWAP_ADAPTER.
        if (ts.usingMockFee) ts.mockSwap = new MockSwapAdapter(1e12, 1);
        // The splitter needs the vault (potClaimed), which does not exist yet, so it is deployed in
        // run() right after the vault and then its swap adapter is wired.
    }

    /// @dev Deploys the vault and (when REWARDS_BPS > 0) the tax-economy stack. The vault's
    ///      rewardsRecipient is the CARE distributor directly. The splitter needs the vault address
    ///      for potClaimed, so it is redeployed with the real vault once the vault exists (below).
    function _deployVault(Config memory c, IERC20 careToken, Pet721 pet, PetIssuer issuer)
        internal
        returns (PetVault vault, TaxStack memory ts)
    {
        require(c.potBps + c.burnBps + c.rewardsBps + c.gasBps == 10_000, "bps sum != 10000");

        address rewardsRecipient = address(0);
        if (c.rewardsBps > 0) {
            ts = _deployTaxStack(c, careToken);
            rewardsRecipient = address(ts.distributor);
        }

        PetVault.Params memory p = PetVault.Params({
            careToken: careToken,
            pet: pet,
            issuer: IPetCareSpender(address(issuer)),
            owner: c.owner,
            lifeTtl: c.lifeTtl,
            careCost: c.careCost,
            potBps: c.potBps,
            burnBps: c.burnBps,
            rewardsBps: c.rewardsBps,
            rewardsRecipient: rewardsRecipient,
            gasBps: c.gasBps,
            gasRecipient: c.gasRecipient,
            abandonGrace: c.abandonGrace,
            minPlayers: c.minPlayers,
            careCooldown: c.careCooldown,
            minSeasonDuration: c.minSeasonDuration,
            entryWindowSecs: c.entryWindowSecs,
            selloutStartsSeason: c.selloutStartsSeason
        });
        vault = new PetVault(p);
    }

    function _report(
        Config memory c,
        Pet721 pet,
        PetIssuer issuer,
        PetVault vault,
        TaxStack memory ts,
        IERC20 careToken,
        bool usingMock,
        address validator
    ) internal view {
        console.log("--------------------------------------------------");
        console.log("Pet721:", address(pet));
        console.log("  name/symbol:", pet.name(), pet.symbol());
        console.log("  issuerLocked:", pet.issuerLocked());
        console.log("  royaltyReceiver:", pet.royaltyReceiver());
        console.log("  royaltyBps (5%):", pet.DEFAULT_ROYALTY_BPS());
        console.log("  royaltyLocked:", pet.royaltyLocked());
        console.log("  transferValidator:", validator);
        console.log("  validatorLocked (lock only AFTER live marketplace test):", pet.validatorLocked());
        console.log("  vaultRef:", pet.vault());
        console.log("  vaultRefLocked:", pet.vaultRefLocked());
        console.log("  walletPass (0xef5f1e71):", pet.supportsInterface(0xef5f1e71));
        console.log("  passBaseURI:", pet.passBaseURI());
        console.log("PetIssuer:", address(issuer));
        console.log("  vaultLocked:", issuer.vaultLocked());
        console.log("PetVault:", address(vault));
        if (c.rewardsBps > 0) {
            console.log("CareRewardsDistributor (CARE, claim-while-alive):", address(ts.distributor));
            console.log("  epochLength (s):", c.epochLength);
            console.log("  distributor.vault == vault:", address(ts.distributor.vault()) == address(vault));
            console.log("HolderMerkleVault (USDG airdrops):", address(ts.holderVault));
            console.log("  poster (must NOT be the relayer):", ts.holderVault.poster());
            console.log("  maxRoundTotal (0 == NOT ARMED, no round can post):", ts.holderVault.maxRoundTotal());
            console.log("  postingAllowanceAvailable (rolling 24h):", ts.holderVault.postingAllowanceAvailable());
            console.log("  posting window (s):", ts.holderVault.POSTING_WINDOW());
            console.log("  releaseGrace (s):", ts.holderVault.releaseGrace());
            console.log("  RUNBOOK CHANGE: rotating the poster is now queuePoster then commitPoster");
            console.log("  after POSTER_ROTATION_DELAY (s):", ts.holderVault.POSTER_ROTATION_DELAY());
            console.log("  Emergency stop is setPostingPaused(true), which is instant.");
            console.log("CareFeeSplitter (USDG in):", address(ts.splitter));
            console.log("  holderBps:", c.holderBps);
            console.log("  swapAdapter:", address(ts.splitter.swapAdapter()));
            console.log(ts.usingMockFee ? "FeeToken MockUSDG (6dp):" : "FeeToken USDG:", address(ts.feeToken));
            console.log("=== LAUNCHPAD CREATOR-FEE SEAT: READ BEFORE YOU TOUCH hook.updateCreator ===");
            console.log("  DO **NOT** POINT THE CREATOR SEAT AT THE SPLITTER ABOVE. THIS SCRIPT USED TO");
            console.log("  SAY TO, AND IT WAS WRONG. hook.claim(poolId) and hook.updateCreator(poolId,addr)");
            console.log("  are BOTH current-recipient-only, and CareFeeSplitter can call NEITHER (it has");
            console.log("  no low-level call, no delegatecall, no receive, no fallback). Assigning the seat");
            console.log("  to it destroys the whole trade-tax stream permanently: unclaimable AND");
            console.log("  un-reassignable, with no owner key or upgrade able to undo it.");
            console.log("  POINT IT AT THE COLLECTOR instead: an account that can send arbitrary calls to");
            console.log("  the hook (the CARE_FEE_COLLECTOR_PRIVATE_KEY EOA the server holds, or a");
            console.log("  multisig). The server claims on the poke cadence and pays the splitter.");
            console.log("  BETTER: DO NOT CALL updateCreator AT ALL. The letscash factory requires");
            console.log("  params.creator == msg.sender, so LAUNCHING THE TOKEN FROM THE COLLECTOR makes");
            console.log("  the collector the creator from block zero and the irreversible call never");
            console.log("  happens. Verified on mainnet 2026-08-23. Runbook step 6C Option A.");
            console.log("  QUOTE-ASSET TRAP: launch on a USDG config (1010/1026/1042/1058). Every");
            console.log("  observed launch lately quoted NATIVE ETH, and an ETH-quoted pool pays the");
            console.log("  seat in ETH, which this splitter CANNOT receive (no receive, on purpose).");
            console.log("  BEFORE THE SEASON OPENS, prove BOTH with real transactions: (1) the collector");
            console.log("  can hook.claim(poolId) and USDG actually arrives, (2) the collector can");
            console.log("  hook.updateCreator the seat onward and back. A seat you have not proven you can");
            console.log("  claim from is a seat you may already have lost.");
            console.log("  Capture the hook address + poolId from YOUR OWN LAUNCH TRANSACTION RECEIPT.");
            console.log("  letscash does not publish the hook address (their docs say n/a) and the");
            console.log("  explorer is full of impersonators: a wrong address here sends the seat to a");
            console.log("  stranger. Never take it from docs or a block explorer search.");
        } else {
            console.log("Rewards stack: none (REWARDS_BPS=0, two-leg deploy)");
        }
        console.log(usingMock ? "MockCareToken (18dp):" : "CareToken:", address(careToken));
        console.log("WalletchiAccount impl (reused):", c.accountImpl);
        console.log("Registry:", CANONICAL_REGISTRY);
        console.log("Owner/Treasury:", c.owner);
        console.log("Relayer:", c.relayer);
        console.log("maxSupply:", c.maxSupply);
        console.log("lifeTtl (s):", c.lifeTtl);
        console.log("careCost (raw):", c.careCost);
        console.log("potBps / burnBps:", c.potBps, c.burnBps);
        console.log("rewardsBps:", c.rewardsBps);
        console.log("minPlayers:", c.minPlayers);
        console.log("minSeasonDuration (s):", c.minSeasonDuration);
        console.log("entryWindowSecs (s) / entryDeadline (unix):", c.entryWindowSecs, vault.entryDeadline());
        console.log("mint budget (max per window / window s):", c.mintsPerWindow, c.mintWindowSecs);
        console.log("careCooldown (s):", c.careCooldown);
        console.log("lifeTtl (s):", c.lifeTtl);
        console.log("perTxCap / dailyCap (raw):", c.perTxCap, c.dailyCap);
        console.log("starterTokens (raw):", c.starterAmount);
        console.log("burn sink:", vault.BURN_ADDRESS());
        console.log("--------------------------------------------------");
        if (!usingMock) {
            console.log("REMINDER: fund the PetIssuer with a care-token float before minting pets.");
        }
    }
}
