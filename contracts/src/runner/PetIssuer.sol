// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {Ownable2Step} from "@openzeppelin/contracts/access/Ownable2Step.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";

import {IERC6551Registry} from "erc6551/interfaces/IERC6551Registry.sol";

import {Pet721} from "./Pet721.sol";
import {WalletchiAccount} from "../WalletchiAccount.sol";

/// @notice Minimal view of the PetVault used by the issuer to register pets at mint and to read
///         the per-care cost when validating the caps baked into a new pet's TBA.
interface IPetRegistrar {
    function register(uint256 tokenId) external;
    function careCost() external view returns (uint256);
    function lifeTtl() external view returns (uint256);
    function entryDeadline() external view returns (uint256);
    /// @dev The vault's own answer to "is the roster still open". Asked instead of comparing a
    ///      clock here, because the two season models close the roster on different facts (a
    ///      timestamp, or the collection minting out) and only the vault knows which it is running.
    function entryOpen() external view returns (bool);
}

/// @title PetIssuer
/// @notice WALLETCHI pet issuer. Free-mints a pet, creates its ERC-6551 token bound account (TBA),
///         appoints ITSELF as the TBA's capped spender (the WALLETCHI pet-account spender pattern:
///         WalletchiAccount initializeSpender, gated to the bound token's issuer, which is this
///         contract), seeds the
///         TBA with a starter float of the care token, and registers the pet in the PetVault so its
///         survival life timer starts.
///
///         The spender allowance lets the vault pull the care token out of the pet's own account
///         through `pullCare`, without the vault ever taking custody. This issuer never mints the
///         care token: it only moves an EXTERNAL ERC-20 (MockCareToken on testnet, a Pons-launched
///         token on mainnet). There is no game token here: the runner game is retired.
contract PetIssuer is Ownable2Step, ReentrancyGuard {
    using SafeERC20 for IERC20;

    /// @notice The WALLETCHI pet NFT collection.
    Pet721 public immutable pet;

    /// @notice The canonical ERC-6551 registry (passed at deploy).
    IERC6551Registry public immutable registry;

    /// @notice The ERC-6551 account implementation for every pet's TBA (the shared, already-deployed
    ///         WalletchiAccount implementation).
    address public immutable accountImpl;

    /// @notice The care token (external ERC-20). Seeded into each TBA at mint and pulled by the vault.
    IERC20 public immutable careToken;

    /// @notice The relayer role: the only address allowed to mint pets (the server pays gas).
    address public relayer;

    /// @notice The PetVault. Set once after deploy (setVault); issuePet registers each pet here, and
    ///         only the vault may call `pullCare`.
    address public vault;

    /// @notice Once true, the vault is frozen and can never be repointed. This is the standing-spender
    ///         trust anchor: because this issuer is the on-chain spender on every pet's TBA, a mutable
    ///         vault would let a compromised owner repoint `pullCare` to a hostile vault and drain
    ///         accounts (incl. a winner's prize). The deploy locks it immediately after wiring.
    bool public vaultLocked;

    /// @notice Issuance kill switch (owner only). The relayer is a single hot key.
    bool public paused;

    /// @notice Rolling mint budget bounding a leaked relayer key. 0 = uncapped.
    uint256 public mintsPerWindow;
    uint256 public mintWindowSecs;
    uint256 public mintWindowStart;
    uint256 public mintsThisWindow;

    /// @notice Care tokens seeded into each new pet's TBA at mint (raw units), from this issuer float.
    uint256 public starterAmount;

    /// @notice Per-transaction spend cap (raw care-token units) baked into each pet's TBA at mint.
    uint256 public perTxCap;

    /// @notice Rolling 24h spend cap (raw care-token units) baked into each pet's TBA at mint.
    uint256 public dailyCap;

    /// @notice The ERC-6551 salt used for every pet account. Fixed at 0 (one account per NFT).
    bytes32 public constant ACCOUNT_SALT = bytes32(0);

    /// @notice Every Walletchi TBA created by this issuer. Pet721 consults this
    ///         registry to prevent pets being nested inside each other's accounts,
    ///         which can create circular ownership and permanently lose control.
    mapping(address account => bool) public isPetAccount;

    event RelayerSet(address indexed relayer);
    event VaultSet(address indexed vault);
    event VaultLocked();
    event CapsSet(uint256 perTxCap, uint256 dailyCap);
    event PausedSet(bool paused);
    event MintBudgetSet(uint256 mintsPerWindow, uint256 windowSecs);
    event StarterAmountSet(uint256 starterAmount);
    event PetIssued(uint256 indexed tokenId, address indexed account, address indexed to);

    error OwnershipCannotBeRenounced();
    error NotRelayer();
    error NotVault();
    error ZeroAddress();
    error VaultNotSet();
    error VaultIsLocked();
    error VaultUnset();
    error CapsTooLowForCare();
    error IssuancePaused();
    error MintBudgetExhausted();
    error EntryWindowClosed();

    modifier onlyRelayer() {
        if (msg.sender != relayer) revert NotRelayer();
        _;
    }

    /// @param pet_ the WALLETCHI pet NFT (this issuer must be set as its issuer via setIssuer)
    /// @param registry_ the ERC-6551 registry (canonical address on live chains)
    /// @param accountImpl_ the already-deployed WalletchiAccount implementation address
    /// @param careToken_ the external care token (raw units)
    /// @param relayer_ initial relayer
    /// @param owner_ contract owner (deployer / operator)
    /// @param perTxCap_ per-transaction spend cap baked into each pet TBA (raw care-token units)
    /// @param dailyCap_ rolling 24h spend cap baked into each pet TBA (raw care-token units)
    /// @param starterAmount_ care tokens seeded into each pet TBA at mint (raw units)
    constructor(
        Pet721 pet_,
        IERC6551Registry registry_,
        address accountImpl_,
        IERC20 careToken_,
        address relayer_,
        address owner_,
        uint256 perTxCap_,
        uint256 dailyCap_,
        uint256 starterAmount_
    ) Ownable(owner_) {
        if (
            address(pet_) == address(0) || address(registry_) == address(0) || accountImpl_ == address(0)
                || address(careToken_) == address(0) || relayer_ == address(0)
        ) revert ZeroAddress();

        pet = pet_;
        registry = registry_;
        accountImpl = accountImpl_;
        careToken = careToken_;
        relayer = relayer_;
        perTxCap = perTxCap_;
        dailyCap = dailyCap_;
        starterAmount = starterAmount_;
    }

    // --------------------------------------------------------------------------------------------
    // Admin
    // --------------------------------------------------------------------------------------------

    function setRelayer(address relayer_) external onlyOwner {
        if (relayer_ == address(0)) revert ZeroAddress();
        relayer = relayer_;
        emit RelayerSet(relayer_);
    }

    /// @notice Wire the PetVault. Re-settable by owner until locked, after which it is permanent.
    function setVault(address vault_) external onlyOwner {
        if (vaultLocked) revert VaultIsLocked();
        if (vault_ == address(0)) revert ZeroAddress();
        vault = vault_;
        emit VaultSet(vault_);
    }

    /// @notice Permanently freeze the vault after wiring (one-way). No repointing afterwards, so the
    ///         standing spender can never be redirected to drain pet accounts (audit M-A).
    function lockVault() external onlyOwner {
        if (vault == address(0)) revert VaultUnset();
        vaultLocked = true;
        emit VaultLocked();
    }

    /// @notice Update the spend caps baked into pets minted from now on (existing pets keep theirs).
    function setCaps(uint256 perTxCap_, uint256 dailyCap_) external onlyOwner {
        _requireCapsFeedable(perTxCap_, dailyCap_);
        perTxCap = perTxCap_;
        dailyCap = dailyCap_;
        emit CapsSet(perTxCap_, dailyCap_);
    }

    /// @notice Update the starter care-token amount seeded into pets minted from now on.
    function setStarterAmount(uint256 starterAmount_) external onlyOwner {
        starterAmount = starterAmount_;
        emit StarterAmountSet(starterAmount_);
    }

    /// @notice Withdraw idle care-token float from this issuer (owner only, e.g. after the season).
    function sweepCare(address to, uint256 amount) external onlyOwner {
        if (to == address(0)) revert ZeroAddress();
        careToken.safeTransfer(to, amount);
    }

    /// @notice Stop issuing pets. The relayer is a single hot key; this is the only way to cut it off
    ///         without waiting on an ownership transfer. Does not touch pets already minted.
    function setPaused(bool paused_) external onlyOwner {
        paused = paused_;
        emit PausedSet(paused_);
    }

    /// @notice Set the rolling mint budget: at most `max` pets per `windowSecs`. 0 disables the cap.
    function setMintBudget(uint256 max, uint256 windowSecs) external onlyOwner {
        if (max > 0 && windowSecs == 0) revert MintBudgetExhausted();
        mintsPerWindow = max;
        mintWindowSecs = windowSecs;
        emit MintBudgetSet(max, windowSecs);
    }

    /// @dev The number of independent needs a pet must serve per life window. MUST equal
    ///      PetVault.NEED_COUNT (kept in lockstep by comment; the vault is the source of truth).
    uint256 internal constant NEED_COUNT_LOCAL = 5;

    /// @dev A pet must be able to actually LIVE on the caps baked into its account at mint.
    ///
    ///      Two independent ways to fail. It must afford one care at all (perTxCap >= careCost), and
    ///      its rolling 24h allowance must cover the CARE RATE its life window demands: since the
    ///      five-needs redesign every one of the pet's FIVE needs must be served at least once per
    ///      life window (each at careCost), so the survival rate is five cares per window, not one.
    ///      A dailyCap sized for the old one-need rate would bless a config where every pet in the
    ///      collection starves against its own spend cap while holding most of its starter float.
    ///      Caps are baked at mint with no setter, so an under-capped pet is doomed for life and no
    ///      owner action saves it. Guards BOTH setCaps and issuePet.
    function _requireCapsFeedable(uint256 perTxCap_, uint256 dailyCap_) internal view {
        if (vault == address(0)) return; // pre-wiring; issuePet re-checks once the vault is set
        uint256 cost = IPetRegistrar(vault).careCost();
        uint256 ttl = IPetRegistrar(vault).lifeTtl();
        if (perTxCap_ < cost) revert CapsTooLowForCare();
        uint256 caresPerWindow = ttl == 0 ? 2 : (1 days + ttl - 1) / ttl; // ceil, per need
        // Five needs per window; +1 covers the phase drift between the account's mint-anchored
        // window and the pet's need timers.
        uint256 needed = cost * (NEED_COUNT_LOCAL * caresPerWindow + 1);
        if (dailyCap_ < needed) revert CapsTooLowForCare();
    }

    /// @dev Bound what a single leaked relayer key can do in one window. Every mint pushes
    ///      `starterAmount` into a TBA the recipient fully controls, so an unbounded relayer converts
    ///      directly into maxSupply * starterAmount of stolen float plus a guaranteed endgame.
    function _consumeMintBudget() internal {
        if (mintsPerWindow == 0) return;
        if (block.timestamp >= mintWindowStart + mintWindowSecs) {
            mintWindowStart = block.timestamp;
            mintsThisWindow = 0;
        }
        if (mintsThisWindow >= mintsPerWindow) revert MintBudgetExhausted();
        mintsThisWindow += 1;
    }

    // --------------------------------------------------------------------------------------------
    // Issuance
    // --------------------------------------------------------------------------------------------

    /// @notice Free-mint a pet to `to`, create its TBA, appoint this issuer as the capped spender,
    ///         seed the TBA with the starter care float, and register the pet in the vault.
    /// @return tokenId the new pet id
    /// @return account the pet's token bound account (TBA)
    function issuePet(address to) external onlyRelayer nonReentrant returns (uint256 tokenId, address account) {
        if (paused) revert IssuancePaused();
        if (to == address(0)) revert ZeroAddress();
        if (vault == address(0)) revert VaultNotSet();

        // THE ROSTER CLOSE, MINT SIDE. Read live from the vault rather than mirrored here, because
        // this contract is constructed BEFORE the vault exists (the vault takes this address), so a
        // mirror would need a setter and a setter is a drift risk on the one number that decides
        // whether a mint is playable. One staticcall, one source of truth, no owner lever.
        //
        // WHY IT REVERTS INSTEAD OF MINTING AN INERT PET. It used to mint, and PetVault.register()
        // would silently no-op (RegisterSkipped) once the season was decided. The buyer got a token
        // that looked exactly like a live pet, could never be fed (care() reverts GameOver), and could
        // never win. Reverting BEFORE pet.mint() is the safe direction too: totalMinted does not
        // advance, so nothing in the collection is consumed or bricked by a late attempt.
        if (!IPetRegistrar(vault).entryOpen()) revert EntryWindowClosed();

        _requireCapsFeedable(perTxCap, dailyCap);
        _consumeMintBudget();

        tokenId = pet.mint(to);
        account = registry.createAccount(accountImpl, ACCOUNT_SALT, block.chainid, address(pet), tokenId);
        isPetAccount[account] = true;

        // Appoint this issuer as the capped spender (self-appoint; gated to the pet's issuer).
        WalletchiAccount(payable(account)).initializeSpender(address(this), perTxCap, dailyCap);

        // Seed the pet's TBA with a starter care float so it can pay for its first care actions.
        if (starterAmount > 0) {
            careToken.safeTransfer(account, starterAmount);
        }

        // Register the pet in the survival vault (starts its life timer, increments alive count).
        IPetRegistrar(vault).register(tokenId);

        emit PetIssued(tokenId, account, to);
    }

    /// @notice Vault-only: pull `amount` care token from a pet's TBA into the vault, using this
    ///         issuer's on-chain spender allowance. Enforces the TBA's per-tx / daily caps.
    ///         This is the OWNER path: it draws on the pet account's full daily allowance.
    function pullCare(uint256 tokenId, uint256 amount) external {
        if (msg.sender != vault) revert NotVault();
        WalletchiAccount(payable(accountOf(tokenId))).spend(address(careToken), vault, amount);
    }

    /// @notice Vault-only: the same pull, declared as coming from an owner-APPROVED CARER.
    /// @dev    WHY A SECOND ENTRY POINT RATHER THAN A FLAG ON THE FIRST. The pet account authorizes
    ///         its spender, not the human behind the call, so it cannot tell an owner-driven care from
    ///         a carer-driven one. Splitting the pull in two makes the distinction part of the
    ///         call itself: `spendAsCarer` charges the CARER SUB-CAP, so a carer can never eat the
    ///         owner's daily headroom (which, at lifeTtl equal to the account's spend window, was a
    ///         deterministic kill and not merely griefing). Both entry points are vault-only, and the
    ///         vault picks between them from its own `msg.sender == ownerOf` check, which no caller
    ///         can influence.
    function pullCareAsCarer(uint256 tokenId, uint256 amount) external {
        if (msg.sender != vault) revert NotVault();
        WalletchiAccount(payable(accountOf(tokenId))).spendAsCarer(address(careToken), vault, amount);
    }

    // --------------------------------------------------------------------------------------------
    // Views
    // --------------------------------------------------------------------------------------------

    /// @notice The deterministic token bound account address for a pet id.
    function accountOf(uint256 tokenId) public view returns (address) {
        return registry.account(accountImpl, ACCOUNT_SALT, block.chainid, address(pet), tokenId);
    }

    /// @notice Disabled. Renouncing would permanently disarm the issuance pause and relayer rotation,
    ///         which are the only remediation paths this contract has. Ownership can still be
    ///         TRANSFERRED (Ownable2Step, so the new owner must accept), which is the safe move.
    function renounceOwnership() public view override onlyOwner {
        revert OwnershipCannotBeRenounced();
    }
}
