// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {ERC721} from "@openzeppelin/contracts/token/ERC721/ERC721.sol";
import {ERC2981} from "@openzeppelin/contracts/token/common/ERC2981.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {Ownable2Step} from "@openzeppelin/contracts/access/Ownable2Step.sol";
import {Strings} from "@openzeppelin/contracts/utils/Strings.sol";
import {IERC721WalletPass} from "../IERC721WalletPass.sol";
import {IPassSignal} from "./IPassSignal.sol";

/// @notice The classic ERC-721C creator-token validator surface a marketplace (OpenSea Seaport 1.6)
///         and this token both call on every owner-to-owner transfer. Declared `view` on purpose: the
///         token invokes it through a STATICCALL, which matches Limit Break's canonical
///         `validateTransfer(address,address,address)` view function AND makes the hook incapable of
///         reentering or mutating state. A validator either returns (allow) or reverts (block).
interface ITransferValidator {
    function validateTransfer(address caller, address from, address to) external view;
}

/// @notice Policy-lock surface implemented by WalletchiTransferValidator. A validator address is not
///         meaningfully frozen unless the behavior configured behind that address is frozen too.
interface ILockableTransferValidator {
    function lockPolicy(address collection) external;
    function policyLocked(address collection) external view returns (bool);
}

/// @notice Minimal PetIssuer view used to reject an NFT being minted or transferred into its own
///         deterministic ERC-6551 account, which would make the account its own owner.
interface IPetAccountSource {
    function accountOf(uint256 tokenId) external view returns (address);
    function isPetAccount(address account) external view returns (bool);
}

/// @notice The minimal ERC-721C creator-token interface OpenSea reads to discover the validator and
///         the validation function. `TransferValidatorUpdated` lets indexers track policy changes.
interface ICreatorToken {
    event TransferValidatorUpdated(address oldValidator, address newValidator);

    function getTransferValidator() external view returns (address validator);
    function getTransferValidationFunction() external view returns (bytes4 functionSignature, bool isViewFunction);
    function setTransferValidator(address validator) external;
}

/// @notice The slice of PetVault the pet reads to know whether a pet may still be moved. Death is
///         purely time-based (life timer lapsed) and permanent: there is no separate reaping step. A
///         live pet is freely transferable; a dead pet is a permanent memorial and can never be moved.
/// @dev    TWO reads, on purpose. `isDead` is the MEMORIAL truth and is what the site and the wallet
///         pass show. `transferLocked` is the TRANSFER POLICY, which is "dead" minus the one pet that
///         won the pot: a settled season's prize NFT stays sellable instead of becoming a permanent
///         unsellable memorial. See PetVault.transferLocked for the full argument.
interface IPetDeathOracle {
    function isDead(uint256 tokenId) external view returns (bool);
    function transferLocked(uint256 tokenId) external view returns (bool);
}

/// @title Pet721
/// @notice The WALLETCHI pet: a Tamagotchi-style digital pet NFT that lives in a wallet pass. One
///         NFT per pet, sequential ids from 1. Name and symbol are set at deploy (env-config) so the
///         working brand can change without a code edit. Minting is free (gas paid by the relayer)
///         and restricted to the PetIssuer. Metadata is served from a hosted base URI (image only:
///         the living card hero PNG); there is no animation_url.
///
///         SECONDARY-MARKET REVISION (Phase S). This is the v2 rebase that makes the pet safe and
///         valuable on OpenSea:
///         1. ERC-2981 royalties: royaltyInfo returns (recipient, 5% = 500 bps). Recipient and bps
///            are owner-settable, then one-way LOCKABLE (lockRoyalty) so they can never be rugged.
///         2. ERC-721C: a creator-definable transfer validator, PERMISSIVE by default (validator
///            unset => nothing is blocked, so trading is never bricked). The validator is
///            owner-settable so the operator can flip to strict royalty-enforcement AFTER a live
///            OpenSea enforced-listing test confirms enforcement works on Robinhood Chain.
///         3. DEATH-SOULBOUND (marketplace-independent, ships hard): a DEAD (reaped) pet can never be
///            transferred owner-to-owner again. It becomes a permanent memorial in the wallet that
///            lost it. Minting is always allowed; the 6551 owner() read is untouched.
contract Pet721 is ERC721, ERC2981, Ownable2Step, ICreatorToken, IERC721WalletPass, IPassSignal {
    using Strings for uint256;

    /// @notice The permanent royalty rate for every pet: 5% (500 basis points).
    uint96 public constant DEFAULT_ROYALTY_BPS = 500;

    /// @notice Hard cap on the number of pets that can ever be minted.
    uint256 public immutable maxSupply;

    /// @notice Number of pets minted so far. Also the id of the most recent pet.
    uint256 public totalMinted;

    /// @notice The PetIssuer contract. Only address permitted to mint.
    address public issuer;

    /// @notice Once true, the issuer is frozen and can never be rotated (audit L-2: no-rotation).
    bool public issuerLocked;

    /// @notice The dedicated royalty recipient (separate from owner / treasury), set at deploy.
    address public royaltyReceiver;

    /// @notice Once true, the royalty recipient and rate are frozen forever (one-way, no rug).
    bool public royaltyLocked;

    /// @notice The ERC-721C transfer validator. address(0) = PERMISSIVE (no transfer checks at all).
    ///         Owner-settable so the policy can be tightened post-launch without a redeploy.
    address public transferValidator;

    /// @notice Once true, the transfer validator address and its per-collection policy are frozen
    ///         forever (one-way, mirrors the other locks).
    bool public validatorLocked;

    /// @notice The PetVault used to read a pet's DEAD (reaped) state for the death-soulbound rule.
    ///         Set once after deploy (setVaultRef); then frozen (lockVaultRef). address(0) before
    ///         wiring means no pet is considered dead, so transfers are unrestricted.
    address public vault;

    /// @notice Once true, the vault reference is frozen and can never be repointed (one-way).
    bool public vaultRefLocked;

    /// @notice Optional payout destination selected by the current token owner. Rewards and prizes
    ///         use it instead of the pet TBA when non-zero. Every ownership transfer clears it before
    ///         the new owner takes possession, so a seller can never leave a redirect behind.
    mapping(uint256 tokenId => address recipient) public payoutAddressOverride;

    string private _base;

    /// @notice ERC-7572 collection-level metadata URI (owner-updatable; not locked).
    string private _contractURI;

    /// @notice WALLET PASS EXTENSION (ERC draft, interface id 0xef5f1e71). `passURI(id)` is this base
    ///         plus the decimal token id, and resolves to the pass manifest. Owner-updatable and NOT
    ///         locked, like `tokenURI`'s base: the manifest is off-chain infrastructure, and moving
    ///         the host must not need a redeploy. The deploy script composes it as
    ///         `<PASS_BASE_URI>eip155/<chainId>/<this contract>/` so the endpoint can resolve a
    ///         manifest without any other context.
    string private _passBase;

    /// @notice Contracts besides the vault that may ask this contract to emit the pass events (the
    ///         rewards distributor, whose pushes change the CARE balance a pass shows). Emit-only
    ///         authority: a signaler moves nothing and can at worst emit a redundant event.
    mapping(address signaler => bool) public isPassSignaler;

    event IssuerSet(address indexed issuer);
    event IssuerLocked();
    event BaseURISet(string baseURI);
    /// @notice ERC-7572: emitted whenever the collection metadata URI changes (and once at deploy).
    event ContractURIUpdated();
    event RoyaltySet(address indexed receiver, uint96 bps);
    event RoyaltyLocked();
    event VaultRefSet(address indexed vault);
    event VaultRefLocked();
    event ValidatorLocked();
    event PayoutAddressSet(uint256 indexed tokenId, address indexed owner, address indexed recipient);
    event PassBaseURISet(string passBaseURI);
    event PassSignalerSet(address indexed signaler, bool allowed);

    error OwnershipCannotBeRenounced();
    error NotIssuer();
    error MaxSupplyReached();
    error IssuerIsLocked();
    error IssuerUnset();
    error RoyaltyIsLocked();
    error RoyaltyUnset();
    error VaultRefIsLocked();
    error VaultRefUnset();
    error ValidatorIsLocked();
    error ValidatorPolicyLockFailed();
    error ZeroAddress();
    error PetIsDead(uint256 tokenId);
    error OwnTokenBoundAccount(uint256 tokenId, address account);
    error PetAccountRecipient(uint256 tokenId, address account);
    error NotTokenOwner(uint256 tokenId, address caller);
    error NotPassSignaler(address caller);
    error InvalidTokenRange(uint256 fromTokenId, uint256 toTokenId);

    /// @param name_ collection name (env-config, e.g. "WALLETCHI").
    /// @param symbol_ collection symbol (env-config, e.g. "WCHI").
    /// @param maxSupply_ supply cap (spec default 2000, configurable at deploy).
    /// @param initialOwner owner able to set issuer, base URI, royalty, validator, and vault ref.
    /// @param royaltyRecipient_ dedicated 5% royalty recipient (must be non-zero; owner-settable then lockable).
    /// @param contractURI_ initial ERC-7572 collection metadata URI (owner-updatable; may be empty at deploy).
    constructor(
        string memory name_,
        string memory symbol_,
        uint256 maxSupply_,
        address initialOwner,
        address royaltyRecipient_,
        string memory contractURI_
    ) ERC721(name_, symbol_) Ownable(initialOwner) {
        require(maxSupply_ > 0, "maxSupply=0");
        maxSupply = maxSupply_;

        // Seed the 5% default royalty to the dedicated recipient. _setDefaultRoyalty reverts if the
        // recipient is address(0), so a fresh collection always ships with a valid royalty target.
        _setDefaultRoyalty(royaltyRecipient_, DEFAULT_ROYALTY_BPS);
        royaltyReceiver = royaltyRecipient_;
        emit RoyaltySet(royaltyRecipient_, DEFAULT_ROYALTY_BPS);

        _contractURI = contractURI_;
        emit ContractURIUpdated();
    }

    // Issuer wiring (unchanged from v1).

    /// @notice Wire the PetIssuer. Re-settable by owner until locked, after which it is permanent.
    function setIssuer(address issuer_) external onlyOwner {
        if (issuerLocked) revert IssuerIsLocked();
        require(issuer_ != address(0), "issuer=0");
        issuer = issuer_;
        emit IssuerSet(issuer_);
    }

    /// @notice Permanently freeze the issuer after wiring (one-way). No rotation afterwards.
    function lockIssuer() external onlyOwner {
        if (issuer == address(0)) revert IssuerUnset();
        issuerLocked = true;
        emit IssuerLocked();
    }

    /// @notice Set the hosted metadata base URI. tokenURI(id) resolves to baseURI + id.
    function setBaseURI(string calldata uri) external onlyOwner {
        _base = uri;
        emit BaseURISet(uri);
    }

    // Collection metadata (ERC-7572): a single JSON document describing the collection (name, image,
    // description, royalty display) that marketplaces read once per collection.

    /// @notice ERC-7572 collection-level metadata URI. Marketplaces (OpenSea and others) read this for
    ///         the collection page. Owner-updatable; deliberately NOT locked (owner-key custody covers
    ///         it, and collection art / copy may need to change).
    function contractURI() external view returns (string memory) {
        return _contractURI;
    }

    /// @notice Update the ERC-7572 collection metadata URI. Owner only. Emits ContractURIUpdated so
    ///         marketplaces refresh the collection metadata.
    function setContractURI(string calldata uri) external onlyOwner {
        _contractURI = uri;
        emit ContractURIUpdated();
    }

    // ERC-2981 royalties (owner-settable, one-way lockable).

    /// @notice Update the royalty recipient and rate for the whole collection. Owner only, until the
    ///         royalty is locked. `bps` is basis points of the sale price (500 = 5%). Reverts if the
    ///         receiver is address(0) or bps exceeds the fee denominator (via ERC2981).
    function setRoyalty(address receiver, uint96 bps) external onlyOwner {
        if (royaltyLocked) revert RoyaltyIsLocked();
        _setDefaultRoyalty(receiver, bps);
        royaltyReceiver = receiver;
        emit RoyaltySet(receiver, bps);
    }

    /// @notice Permanently freeze the royalty recipient and rate (one-way). No changes afterwards.
    function lockRoyalty() external onlyOwner {
        if (royaltyReceiver == address(0)) revert RoyaltyUnset();
        royaltyLocked = true;
        emit RoyaltyLocked();
    }

    // ERC-721C transfer policy (owner-settable so it can be tightened post-launch, then one-way
    // lockable so the final policy, strict OR permissive, can be made permanent).

    /// @inheritdoc ICreatorToken
    function setTransferValidator(address validator) external onlyOwner {
        if (validatorLocked) revert ValidatorIsLocked();
        address old = transferValidator;
        transferValidator = validator;
        emit TransferValidatorUpdated(old, validator);
    }

    /// @notice Permanently freeze the transfer validator and, when set, its policy for this
    ///         collection. Valid with the validator unset too: that locks in the PERMISSIVE policy
    ///         forever. A configured validator must implement ILockableTransferValidator; otherwise
    ///         this reverts instead of advertising an address-only lock while behavior stays mutable.
    function lockValidator() external onlyOwner {
        if (validatorLocked) revert ValidatorIsLocked();
        validatorLocked = true;
        emit ValidatorLocked();

        address validator = transferValidator;
        if (validator != address(0)) {
            (bool lockOk,) = validator.call(abi.encodeCall(ILockableTransferValidator.lockPolicy, (address(this))));
            if (!lockOk) revert ValidatorPolicyLockFailed();

            (bool readOk, bytes memory result) =
                validator.staticcall(abi.encodeCall(ILockableTransferValidator.policyLocked, (address(this))));
            // Require the canonical ABI encoding of true. This also rejects EOAs, address-only
            // validators, empty return data, and contracts that pretend to support the surface.
            if (!readOk || result.length != 32) revert ValidatorPolicyLockFailed();
            uint256 lockedWord;
            assembly ("memory-safe") {
                lockedWord := mload(add(result, 0x20))
            }
            if (lockedWord != 1) revert ValidatorPolicyLockFailed();
        }
    }

    /// @inheritdoc ICreatorToken
    function getTransferValidator() external view returns (address) {
        return transferValidator;
    }

    /// @inheritdoc ICreatorToken
    /// @dev The token calls `validateTransfer(address caller, address from, address to)` on the
    ///      validator (a view function invoked via STATICCALL). This is the classic ERC-721C
    ///      validation function a Limit Break CreatorTokenTransferValidator implements.
    function getTransferValidationFunction() external pure returns (bytes4 functionSignature, bool isViewFunction) {
        return (ITransferValidator.validateTransfer.selector, true);
    }

    // Vault reference for the death-soulbound rule (set once, one-way lockable).

    /// @notice Wire the PetVault used to read a pet's DEAD (reaped) state. Re-settable by owner until
    ///         locked, after which it is permanent (mirrors the issuer / vault lock discipline).
    function setVaultRef(address vault_) external onlyOwner {
        if (vaultRefLocked) revert VaultRefIsLocked();
        if (vault_ == address(0)) revert ZeroAddress();
        vault = vault_;
        emit VaultRefSet(vault_);
    }

    /// @notice Permanently freeze the vault reference after wiring (one-way).
    function lockVaultRef() external onlyOwner {
        if (vault == address(0)) revert VaultRefUnset();
        vaultRefLocked = true;
        emit VaultRefLocked();
    }

    /// @notice True if the pet is DEAD per the vault (its life timer has lapsed). False when no vault
    ///         is wired yet and when the pet is still alive. This is the MEMORIAL read; the transfer
    ///         gate is `transferLocked`, which differs for exactly one pet (the pot winner).
    function isDead(uint256 tokenId) public view returns (bool) {
        address v = vault;
        if (v == address(0)) return false;
        return IPetDeathOracle(v).isDead(tokenId);
    }

    /// @notice True if the pet can never be moved owner-to-owner again: dead AND not the pot winner.
    ///         False when no vault is wired yet, so trading is never bricked by a missing pointer.
    /// @dev    WHY THIS IS NOT JUST isDead: the season's winner is normally awarded the pot AFTER its
    ///         own timer has lapsed (finalize() is permissionless and typically poked late), so under
    ///         the old rule the single most valuable token in the collection became a permanent
    ///         unsellable memorial at the exact moment it won. The vault carves that one id out. Every
    ///         other dead pet is still soulbound forever.
    function transferLocked(uint256 tokenId) public view returns (bool) {
        address v = vault;
        if (v == address(0)) return false;
        return IPetDeathOracle(v).transferLocked(tokenId);
    }

    // Owner-authorized payout recovery.

    /// @notice Select an alternate receiver for this pet's future rewards and prize. This moves no
    ///         funds and grants the caller no pushing authority: distributor/vault payouts remain
    ///         permissionless with contract-enforced amounts. Set address(0) to restore the TBA.
    function setPayoutAddress(uint256 tokenId, address recipient) external {
        address tokenOwner = _requireOwned(tokenId);
        if (_msgSender() != tokenOwner) revert NotTokenOwner(tokenId, _msgSender());
        payoutAddressOverride[tokenId] = recipient;
        emit PayoutAddressSet(tokenId, tokenOwner, recipient);
    }

    /// @notice Resolve a payout destination. Consumers pass the pet's deterministic TBA as the
    ///         default; a current-owner override wins only until the token next changes hands.
    function payoutAddress(uint256 tokenId, address defaultRecipient) external view returns (address) {
        _requireOwned(tokenId);
        address recipient = payoutAddressOverride[tokenId];
        return recipient == address(0) ? defaultRecipient : recipient;
    }

    // Wallet Pass Extension (ERC draft, IERC721WalletPass, interface id 0xef5f1e71).

    /// @inheritdoc IERC721WalletPass
    /// @dev Reverts for a token that does not exist (ERC721NonexistentToken), as the interface
    ///      requires. What the URI resolves to is WALLETCHI's GATED manifest: without a control proof
    ///      it answers 401 and no acquisition URL, because those URLs are capabilities.
    function passURI(uint256 tokenId) external view returns (string memory) {
        _requireOwned(tokenId);
        return string.concat(_passBase, tokenId.toString());
    }

    /// @notice The base `passURI` composes from.
    function passBaseURI() external view returns (string memory) {
        return _passBase;
    }

    /// @notice Point every pet's `passURI` at a new manifest host.
    function setPassBaseURI(string calldata uri) external onlyOwner {
        _passBase = uri;
        emit PassBaseURISet(uri);
    }

    /// @notice Allow (or stop) a contract other than the vault to ask for pass events.
    function setPassSignaler(address signaler, bool allowed) external onlyOwner {
        if (signaler == address(0)) revert ZeroAddress();
        isPassSignaler[signaler] = allowed;
        emit PassSignalerSet(signaler, allowed);
    }

    /// @notice Emit `PassUpdate` for one pet. Callable by the vault (care, champion, prize), a
    ///         registered signaler (reward pushes) or the owner (an issuer-side refresh).
    function signalPassUpdate(uint256 tokenId) external {
        _requirePassSignaler();
        emit PassUpdate(tokenId);
    }

    /// @notice Emit `BatchPassUpdate` for an inclusive range: the season settling or starting touches
    ///         every pass at once, and a reward push touches a batch.
    function signalBatchPassUpdate(uint256 fromTokenId, uint256 toTokenId) external {
        _requirePassSignaler();
        if (fromTokenId > toTokenId) revert InvalidTokenRange(fromTokenId, toTokenId);
        emit BatchPassUpdate(fromTokenId, toTokenId);
    }

    function _requirePassSignaler() internal view {
        address caller = _msgSender();
        if (caller != vault && !isPassSignaler[caller] && caller != owner()) revert NotPassSignaler(caller);
    }

    // Mint.

    /// @notice Mint the next pet to `to`. Returns the new sequential token id. PetIssuer only.
    function mint(address to) external returns (uint256 id) {
        if (msg.sender != issuer) revert NotIssuer();
        if (totalMinted >= maxSupply) revert MaxSupplyReached();
        id = ++totalMinted; // ids start at 1
        _safeMint(to, id);
    }

    // Views / overrides.

    function _baseURI() internal view override returns (string memory) {
        return _base;
    }

    /// @inheritdoc ERC721
    /// @dev The single transfer hook. Every non-burn first rejects putting a pet in its own ERC-6551
    ///      account. On an owner-to-owner move (from != 0 && to != 0) it then enforces, in order:
    ///      (1) DEATH-SOULBOUND, a reaped pet can never change hands; (2) the ERC-721C policy,
    ///      delegating to the configured validator (STATICCALL, permissive when unset). Burns skip
    ///      all checks; mints skip death and validation but still cannot create self-ownership.
    function _update(address to, uint256 tokenId, address auth) internal override returns (address from) {
        from = _ownerOf(tokenId);

        if (to != address(0)) {
            address issuer_ = issuer;
            if (issuer_ != address(0)) {
                // Some isolated tests intentionally wire a minimal issuer without accountOf. Treat a
                // missing view as "not a known TBA"; production locks the real PetIssuer here.
                try IPetAccountSource(issuer_).accountOf(tokenId) returns (address account) {
                    if (account != address(0) && to == account) {
                        revert OwnTokenBoundAccount(tokenId, account);
                    }
                } catch {}
                // Blocking only the token's OWN TBA leaves a two-pet cycle:
                // A can be transferred to B's account and B to A's, after which
                // neither account has an EOA owner that can execute a recovery.
                // The real issuer records every account it creates, so reject any
                // known Walletchi TBA as a recipient. Minimal test issuers that do
                // not implement the view remain compatible through try/catch.
                try IPetAccountSource(issuer_).isPetAccount(to) returns (bool known) {
                    if (known) revert PetAccountRecipient(tokenId, to);
                } catch {}
            }
        }

        if (from != address(0) && to != address(0)) {
            // DEATH-SOULBOUND, minus the pot winner. `transferLocked` and not `isDead` so a settled
            // season's prize NFT is still sellable; see PetVault.transferLocked.
            if (transferLocked(tokenId)) revert PetIsDead(tokenId);

            address validator = transferValidator;
            if (validator != address(0)) {
                ITransferValidator(validator).validateTransfer(_msgSender(), from, to);
            }
        }

        // Clear before every real ownership change (including burn). If super._update later reverts,
        // this deletion and event revert with it. A transfer away and back therefore cannot revive a
        // seller's old payout redirect.
        if (from != address(0) && from != to && payoutAddressOverride[tokenId] != address(0)) {
            delete payoutAddressOverride[tokenId];
            emit PayoutAddressSet(tokenId, from, address(0));
        }

        from = super._update(to, tokenId, auth);
        // Mint, transfer and burn all change what the pass shows (the pass exists, has a new holder,
        // or is gone), and all of them pass through here, so this one line covers every case.
        emit PassUpdate(tokenId);
    }

    /// @inheritdoc ERC721
    function supportsInterface(bytes4 interfaceId) public view override(ERC721, ERC2981) returns (bool) {
        return interfaceId == type(ICreatorToken).interfaceId || interfaceId == type(IERC721WalletPass).interfaceId
            || super.supportsInterface(interfaceId);
    }

    /// @notice Disabled. Renouncing would permanently disarm royalty and transfer-policy administration,
    ///         which are the only remediation paths this contract has. Ownership can still be
    ///         TRANSFERRED (Ownable2Step, so the new owner must accept), which is the safe move.
    function renounceOwnership() public view override onlyOwner {
        revert OwnershipCannotBeRenounced();
    }
}
