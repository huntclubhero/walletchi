// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IERC165} from "@openzeppelin/contracts/utils/introspection/IERC165.sol";
import {IERC721} from "@openzeppelin/contracts/token/ERC721/IERC721.sol";
import {IERC1271} from "@openzeppelin/contracts/interfaces/IERC1271.sol";
import {SignatureChecker} from "@openzeppelin/contracts/utils/cryptography/SignatureChecker.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";

import {IERC6551Account} from "erc6551/interfaces/IERC6551Account.sol";
import {IERC6551Executable} from "erc6551/interfaces/IERC6551Executable.sol";

/// @notice Minimal view of the bound token contract used to authorize spender appointment.
///         The WALLETCHI pet 721 exposes `issuer()`. Kept as a tiny interface so WalletchiAccount
///         does not depend on the concrete token contract.
interface IPetIssuerSource {
    function issuer() external view returns (address);
}

/// @title WalletchiAccount
/// @notice ERC-6551 token bound account for a WALLETCHI pet. Built on the erc6551/reference
///         `ERC6551Account` logic (token()/owner()/execute()/isValidSignature) with an added,
///         on-chain spending allowance so a designated spender (the pet issuer) can move funds
///         within a per-transaction cap and a rolling 24h daily cap.
///
///         SELF-CUSTODY GUARANTEE: the NFT holder is always the account owner and can call
///         execute() to move any asset out at any time, and revokeSpender() to cut off the
///         spender entirely. The spender is a convenience for tap-to-pay, never a custodian.
///
///         This contract is the implementation behind ERC-1167 minimal proxies created by the
///         ERC-6551 registry; all state below lives in each proxy (per pet).
contract WalletchiAccount is
    IERC165,
    IERC1271,
    IERC6551Account,
    IERC6551Executable,
    ReentrancyGuard
{
    using SafeERC20 for IERC20;

    /// @notice Increments on every state-changing action (ERC-6551 convention).
    uint256 public state;

    /// @notice Approved spender (the pet issuer). address(0) when unset or revoked.
    address public spender;

    /// @notice True once a spender has been appointed. Guards initializeSpender to exactly once.
    bool public spenderInitialized;

    /// @notice Max amount (raw token units) the spender may move in a single spend() call.
    uint256 public perTxCap;

    /// @notice Max amount (raw token units) the spender may move within the current 24h window.
    uint256 public dailyCap;

    /// @notice Start of the current rolling 24h window.
    uint256 public windowStart;

    /// @notice Amount already spent by the spender in the current window.
    uint256 public spentInWindow;

    /// @notice The slice of `spentInWindow` that was spent on behalf of an owner-APPROVED CARER
    ///         rather than the owner. Reset with the window.
    uint256 public carerSpentInWindow;

    /// @notice The rolling spend window. PUBLIC because the game's life window has to be compared
    ///         against it: a lifeTtl at or below this value lets a single full-cap burn line up its
    ///         unlock with the pet's death instant. The deploy script requires lifeTtl > SPEND_WINDOW
    ///         for that reason.
    uint256 public constant SPEND_WINDOW = 1 days;

    /// @notice Share of `dailyCap` an owner-approved CARER may consume in one window, in basis points.
    ///
    ///         WHY THIS EXISTS. Carers share the account's daily allowance with the owner, and the
    ///         window rolls lazily from whenever the first spend of the window lands. A carer could
    ///         therefore force the window to roll and immediately burn the ENTIRE dailyCap, every unit
    ///         of it legal (a carer must serve the pet's weakest need, so the pet ends up fully
    ///         served). The owner's next feed then had to wait for windowStart + SPEND_WINDOW, which,
    ///         at the shipped lifeTtl of exactly 1 day, was the very instant the pet died. Zero
    ///         seconds of warning: an approved carer could deterministically KILL the pet it was
    ///         trusted to feed, and the CarerApproval natspec promised the opposite.
    ///
    ///         Capping the carer at half leaves the owner a guaranteed half of the daily cap in the
    ///         SAME window, no matter what the carer does or when it does it, so the owner can always
    ///         feed back. Half rather than something smaller because a carer is meant to be able to
    ///         actually keep a pet alive unattended: at the shipped caps (dailyCap = 20 cares, five
    ///         needs per day) half is ten cares a day, comfortably above the survival rate of five.
    uint256 public constant CARER_CAP_BPS = 5_000;

    /// @notice Absolute ceiling on an owner-approved CARER, in per-transaction-cap-sized spends per
    ///         window. The carer sub-cap is the LESSER of this and CARER_CAP_BPS of dailyCap.
    ///
    ///         WHY BOTH. The owner's dailyCap is now sized as a near-unlimited ceiling (owners kept
    ///         hitting a 20-care cap in real play, Hunt ruling 2026-10-16). Half of a near-unlimited
    ///         cap is no brake at all: with no care cooldown, an approved carer could burn the pet's
    ///         entire balance in minutes, every care legal, and leave a pet that cannot be fed. This
    ///         fixed ceiling keeps the carer brake where it was (ten cares a day, twice the five-need
    ///         survival rate) no matter how high the owner's cap goes. At the old caps (dailyCap = 20
    ///         cares) both bounds agree on ten, so the behaviour of older configs is unchanged.
    uint256 public constant CARER_MAX_SPENDS_PER_WINDOW = 10;
    uint256 private constant BPS = 10_000;

    uint256 private constant WINDOW = SPEND_WINDOW;

    /// @dev increaseAllowance(address,uint256) and increaseApproval(address,uint256): neither is in
    ///      IERC20, so the selectors are spelled out. The second one is what the Paxos token code
    ///      behind USDG exposes.
    bytes4 private constant INCREASE_ALLOWANCE = 0x39509351;
    bytes4 private constant INCREASE_APPROVAL = 0xd73dd623;
    /// @dev multicall(bytes[]): OpenZeppelin Multicall delegatecalls the token to itself with
    ///      msg.sender preserved, so a token that mixes it in would let approve(seller, max) ride
    ///      inside a call whose outer selector is not approve. The account never needs to multicall
    ///      a token, so the whole selector is refused.
    bytes4 private constant MULTICALL = 0xac9650d8;

    event SpenderInitialized(address indexed spender, uint256 perTxCap, uint256 dailyCap);
    event SpenderRevoked(address indexed spender);
    event Spent(address indexed token, address indexed to, uint256 amount);

    error NotOwner();
    error NotSpender();
    error SpenderAlreadySet();
    error OnlySelfAppoint();
    error NotPetIssuer();
    error ZeroSpender();
    error OverPerTxCap();
    error OverDailyCap();
    error OverCarerCap();
    error InvalidOperation();
    error ApprovalNotAllowed();

    receive() external payable {}

    // --------------------------------------------------------------------------------------------
    // Spending allowance
    // --------------------------------------------------------------------------------------------

    /// @notice Appoint the spender and set caps. Callable exactly once, only when unset, only by
    ///         the spender-to-be (msg.sender must equal `spender_`), AND only by the issuer of the
    ///         bound token (msg.sender must equal the bound token contract's issuer()). In the
    ///         issuance flow the pet issuer calls this on the freshly created account, appointing
    ///         itself, and it is the pet's issuer, so all three conditions hold.
    /// @dev MITIGATION (pre-initialization griefing): ERC-6551 account creation is permissionless
    ///      and account addresses are deterministic, so anyone can pre-create a future pet's
    ///      account. The issuer gate below means only the bound token's issuer can appoint a
    ///      spender, so a pre-creating attacker cannot initialize a spender on that account and
    ///      cannot block issuance: the issuer's issuePet reuses the pre-created account (createAccount
    ///      is idempotent) and its own initializeSpender call still succeeds. No funds are ever at
    ///      risk regardless: the holder owns the account and can execute()/revokeSpender() freely.
    /// @param spender_ the address being appointed (must equal msg.sender and the bound token's issuer)
    /// @param perTxCap_ per-transaction cap in raw token units
    /// @param dailyCap_ rolling 24h cap in raw token units
    function initializeSpender(address spender_, uint256 perTxCap_, uint256 dailyCap_) external {
        if (spenderInitialized) revert SpenderAlreadySet();
        if (spender_ == address(0)) revert ZeroSpender();
        if (msg.sender != spender_) revert OnlySelfAppoint();

        // Only the issuer of the bound token may appoint a spender.
        (, address tokenContract,) = token();
        if (msg.sender != IPetIssuerSource(tokenContract).issuer()) revert NotPetIssuer();

        spender = spender_;
        perTxCap = perTxCap_;
        dailyCap = dailyCap_;
        windowStart = block.timestamp;
        spenderInitialized = true;

        emit SpenderInitialized(spender_, perTxCap_, dailyCap_);
    }

    /// @notice Move `amount` of `token` from this account to `to`. Spender only.
    ///         Enforces the per-transaction cap and the rolling 24h daily cap on-chain.
    ///         Effects are applied before the external transfer and the call is nonReentrant.
    ///         This is the OWNER path: it may use the whole daily cap.
    function spend(address token_, address to, uint256 amount) external nonReentrant {
        _spend(token_, to, amount, false);
    }

    /// @notice The same spend, declared as being on behalf of an owner-APPROVED CARER. Spender only.
    ///         Additionally bounded by the CARER SUB-CAP (`carerDailyCap`), so a carer can never
    ///         consume the owner's share of the window. See CARER_CAP_BPS for why that matters.
    function spendAsCarer(address token_, address to, uint256 amount) external nonReentrant {
        _spend(token_, to, amount, true);
    }

    function _spend(address token_, address to, uint256 amount, bool byCarer) internal {
        if (msg.sender != spender || spender == address(0)) revert NotSpender();
        if (amount > perTxCap) revert OverPerTxCap();

        // Roll the window forward if 24h have elapsed since it started. The carer sub-ledger rolls
        // with it, so a carer gets its own fresh allowance each window and never carries debt.
        if (block.timestamp >= windowStart + WINDOW) {
            windowStart = block.timestamp;
            spentInWindow = 0;
            carerSpentInWindow = 0;
        }
        if (spentInWindow + amount > dailyCap) revert OverDailyCap();
        // THE CARER SUB-CAP. Checked in ADDITION to the shared cap, never instead of it, so a carer is
        // strictly more limited than the owner and can never be the reason the owner is locked out of
        // its own account for a whole window. Without it an approved carer could burn the full daily
        // cap at a window roll and the owner's next feed unlocked exactly when the pet died.
        if (byCarer) {
            if (carerSpentInWindow + amount > carerDailyCap()) revert OverCarerCap();
            carerSpentInWindow += amount;
        }

        // Effects before interaction (checks-effects-interactions + nonReentrant).
        spentInWindow += amount;
        unchecked {
            ++state;
        }

        IERC20(token_).safeTransfer(to, amount);

        emit Spent(token_, to, amount);
    }

    /// @notice The most an owner-approved carer may spend from this account in one window: the lesser
    ///         of CARER_CAP_BPS of dailyCap and CARER_MAX_SPENDS_PER_WINDOW per-tx-sized spends.
    function carerDailyCap() public view returns (uint256) {
        uint256 share = (dailyCap * CARER_CAP_BPS) / BPS;
        uint256 ceiling = perTxCap * CARER_MAX_SPENDS_PER_WINDOW;
        return share < ceiling ? share : ceiling;
    }

    /// @notice Remaining amount an approved CARER may spend in the current window. Always the lesser
    ///         of the carer's own remaining sub-cap and the account's remaining shared allowance.
    function remainingCarerAllowance() external view returns (uint256) {
        uint256 cap = carerDailyCap();
        if (block.timestamp >= windowStart + WINDOW) {
            return cap < dailyCap ? cap : dailyCap;
        }
        uint256 carerLeft = carerSpentInWindow >= cap ? 0 : cap - carerSpentInWindow;
        uint256 sharedLeft = spentInWindow >= dailyCap ? 0 : dailyCap - spentInWindow;
        return carerLeft < sharedLeft ? carerLeft : sharedLeft;
    }

    /// @notice Revoke the spender. Only the NFT owner. Disables spend() until the owner restores it
    ///         with `restoreIssuerSpender()`. The owner always keeps full control via execute().
    function revokeSpender() external {
        if (msg.sender != owner()) revert NotOwner();
        address prev = spender;
        spender = address(0);
        unchecked {
            ++state;
        }
        emit SpenderRevoked(prev);
    }

    /// @notice Re-appoint the bound token's canonical issuer as spender after a revoke.
    ///
    /// @dev    WHY THIS EXISTS. Revocation used to be irreversible: `spenderInitialized` stayed true,
    ///         so `initializeSpender` reverted SpenderAlreadySet forever and `pullCare` reverted
    ///         NotSpender forever, meaning the pet could never be fed by anyone again. That handed a
    ///         seller a silent, total rug: revoke, list on a marketplace, sell at full price, and the
    ///         buyer receives a pet that cannot be fed, dies within lifeTtl, and is then soulbound so
    ///         it cannot even be resold. Nothing on-chain or in any marketplace UI advertised the
    ///         difference between that pet and a healthy one.
    ///
    ///         Restoring is safe because the destination is NOT caller-chosen: it is read from the
    ///         bound token contract's `issuer()`, and Pet721's issuer is one-way locked at deploy, so
    ///         this can only ever point back at the same canonical spender the account was issued
    ///         with. An owner therefore cannot appoint an arbitrary spender, and a buyer can always
    ///         undo a seller's sabotage.
    ///
    ///         THE CAPS ARE NOT RE-READ, AND THAT IS DELIBERATE. An earlier version of this comment
    ///         claimed they were, which is simply false: this function touches `spender` only, and
    ///         `perTxCap` / `dailyCap` keep whatever values were baked in at mint. That is the correct
    ///         behaviour, because re-reading them would let the issuer owner change the caps on an
    ///         ALREADY MINTED pet by inviting its holder to restore, which is exactly the mutable-cap
    ///         power the mint-time bake exists to remove. Caps are per-pet and permanent; only the
    ///         spender pointer is recoverable. `SpenderInitialized` is re-emitted with the EXISTING
    ///         caps so indexers see the unchanged values rather than a silent gap.
    function restoreIssuerSpender() external {
        if (msg.sender != owner()) revert NotOwner();
        (, address tokenContract,) = token();
        address canonical = IPetIssuerSource(tokenContract).issuer();
        if (canonical == address(0)) revert ZeroSpender();
        spender = canonical;
        unchecked {
            ++state;
        }
        emit SpenderInitialized(canonical, perTxCap, dailyCap);
    }

    /// @notice Remaining amount the spender may spend in the current window, given the caps.
    function remainingDailyAllowance() external view returns (uint256) {
        if (block.timestamp >= windowStart + WINDOW) return dailyCap;
        if (spentInWindow >= dailyCap) return 0;
        return dailyCap - spentInWindow;
    }

    // --------------------------------------------------------------------------------------------
    // ERC-6551 core (owner-controlled execution): mirrors erc6551/reference ERC6551Account
    // --------------------------------------------------------------------------------------------

    /// @notice Execute an arbitrary call from this account. Owner only. operation must be 0 (CALL).
    ///         This is the self-custody path: the owner can always withdraw everything, regardless
    ///         of the spender or caps.
    ///
    ///         The one thing it will not do through THIS path is leave a STANDING approval behind.
    ///         An allowance set on the account belongs to the account, not to whoever owned the pet
    ///         when it was set, so it would survive a sale: a seller could approve themselves, sell
    ///         the pet, and later pull whatever the buyer's account receives (rewards, top-ups, an
    ///         escrowed prize) through transferFrom. Calls to approve, increaseAllowance,
    ///         increaseApproval, setApprovalForAll and multicall are therefore refused, except the
    ///         ones that only remove an approval, so a holder can still clear one planted before the
    ///         sale. Moving assets out with transfer is unaffected.
    ///
    ///         SCOPE: this guard closes the execute() path only. It does NOT stop an approval that
    ///         a token grants on the strength of a signature: `isValidSignature` below accepts any
    ///         signature by the current owner, so a seller can sign an EIP-2612 `permit`
    ///         (owner = this account, spender = seller, deadline = max) before listing and the
    ///         token sets the allowance itself through ERC-1271, never touching execute(). The same
    ///         holds for Permit2, ERC-4494 NFT permits, ERC-777 authorizeOperator, and any token
    ///         that lets a trusted ERC-2771 forwarder or an executeMetaTransaction entry point act
    ///         as this account. None of those can be caught from inside the account; they are
    ///         handled by a buyer-side allowance scan before purchase (see LAUNCH-PUNCHLIST.md).
    function execute(address to, uint256 value, bytes calldata data, uint8 operation)
        external
        payable
        returns (bytes memory result)
    {
        if (!_isValidSigner(msg.sender)) revert NotOwner();
        if (operation != 0) revert InvalidOperation();
        _requireNoStandingApproval(to, data);

        unchecked {
            ++state;
        }

        bool success;
        (success, result) = to.call{value: value}(data);
        if (!success) {
            assembly {
                revert(add(result, 32), mload(result))
            }
        }
    }

    /// @dev Refuses calldata that would grant an approval from this account (approve,
    ///      increaseAllowance, increaseApproval, setApprovalForAll with true) and any multicall,
    ///      since a self-delegatecalling multicall would carry an approve past the selector check.
    ///      Revocations pass: approve(x, 0) on an ERC-20 (only if the target answers allowance(),
    ///      so an ERC-721 whose token id is 0 cannot slip through as a zero amount),
    ///      approve(address(0), id) on an ERC-721, and setApprovalForAll(x, false). Malformed
    ///      calldata for these selectors fails closed through abi.decode. Calldata shorter than a
    ///      selector is not a function call and passes.
    ///
    ///      Only the execute() path is covered. Signature-granted approvals (EIP-2612 permit,
    ///      Permit2, ERC-4494, ERC-777 operators) and meta-transaction entry points that let a
    ///      forwarder speak as this account (ERC-2771, executeMetaTransaction) never pass through
    ///      here and are out of this guard's reach.
    function _requireNoStandingApproval(address target, bytes calldata data) internal view {
        if (data.length < 4) return;
        bytes4 selector = bytes4(data[:4]);

        if (selector == MULTICALL) revert ApprovalNotAllowed();

        if (selector == IERC20.approve.selector) {
            (address approved, uint256 amount) = abi.decode(data[4:], (address, uint256));
            if (approved == address(0)) return;
            if (amount == 0) {
                (bool ok, bytes memory ret) =
                    target.staticcall(abi.encodeCall(IERC20.allowance, (address(this), approved)));
                if (ok && ret.length == 32) return;
            }
            revert ApprovalNotAllowed();
        }
        if (selector == INCREASE_ALLOWANCE || selector == INCREASE_APPROVAL) revert ApprovalNotAllowed();
        if (selector == IERC721.setApprovalForAll.selector) {
            (, bool approved) = abi.decode(data[4:], (address, bool));
            if (approved) revert ApprovalNotAllowed();
        }
    }

    function isValidSigner(address signer, bytes calldata) external view returns (bytes4) {
        if (_isValidSigner(signer)) {
            return IERC6551Account.isValidSigner.selector;
        }
        return bytes4(0);
    }

    function isValidSignature(bytes32 hash, bytes memory signature)
        external
        view
        returns (bytes4 magicValue)
    {
        bool isValid = SignatureChecker.isValidSignatureNow(owner(), hash, signature);
        if (isValid) {
            return IERC1271.isValidSignature.selector;
        }
        return bytes4(0);
    }

    function supportsInterface(bytes4 interfaceId) external pure returns (bool) {
        return interfaceId == type(IERC165).interfaceId
            || interfaceId == type(IERC6551Account).interfaceId
            || interfaceId == type(IERC6551Executable).interfaceId;
    }

    /// @notice The NFT that owns this account: (chainId, tokenContract, tokenId). Read from the
    ///         ERC-6551 footer appended to this account's own bytecode.
    function token() public view returns (uint256, address, uint256) {
        bytes memory footer = new bytes(0x60);
        assembly {
            extcodecopy(address(), add(footer, 0x20), 0x4d, 0x60)
        }
        return abi.decode(footer, (uint256, address, uint256));
    }

    /// @notice Current owner of this account = current holder of the bound NFT.
    function owner() public view returns (address) {
        (uint256 chainId, address tokenContract, uint256 tokenId) = token();
        if (chainId != block.chainid) return address(0);
        return IERC721(tokenContract).ownerOf(tokenId);
    }

    function _isValidSigner(address signer) internal view returns (bool) {
        return signer == owner();
    }
}
