// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Script, console} from "forge-std/Script.sol";
import {Strings} from "@openzeppelin/contracts/utils/Strings.sol";

import {Pet721} from "../src/runner/Pet721.sol";
import {PetIssuer} from "../src/runner/PetIssuer.sol";
import {PetVault} from "../src/runner/PetVault.sol";
import {CareRewardsDistributor} from "../src/runner/CareRewardsDistributor.sol";
import {CareFeeSplitter} from "../src/runner/CareFeeSplitter.sol";
import {HolderMerkleVault} from "../src/runner/HolderMerkleVault.sol";
import {WalletchiTransferValidator} from "../src/runner/WalletchiTransferValidator.sol";
import {WalletchiAccount} from "../src/WalletchiAccount.sol";
import {IERC721WalletPass} from "../src/IERC721WalletPass.sol";

/// @title VerifyWalletchiWiring
/// @notice Read-only post-deploy assertion of the FULL wiring + lock checklist (pre-mainnet audit).
///         Run it against a fresh deploy BEFORE opening the season: if it exits cleanly, the system is
///         fully wired and every one-way lock is engaged; any failure aborts with the exact check that
///         failed. This is the safety net for the multisig hand-wiring path (where the deploy script
///         intentionally wires/locks nothing).
///
///         Env: PET, ISSUER, VAULT, VALIDATOR, CARE_TOKEN, ROYALTY_RECIPIENT, ACCOUNT_IMPL required.
///         Rewards leg (set ALL of these when REWARDS_BPS > 0, none otherwise): DIST (the
///         CareRewardsDistributor), HOLDER_VAULT, SPLITTER, FEE_TOKEN (USDG). Optional: POSTER
///         (asserts the holder-vault poster), RELAYER (asserts poster != relayer), EXPECTED_OWNER,
///         ALLOW_UNWIRED_SWAP (skip the swap-adapter-wired assertion), PASS_BASE_URI (the manifest
///         host prefix the deploy used; asserts passBaseURI == <prefix>eip155/<chainId>/<pet>/).
///
///         Usage: forge script script/VerifyWalletchiWiring.s.sol --rpc-url <chain>
contract VerifyWalletchiWiring is Script {
    uint256 constant RH_MAINNET = 4663;

    /// @dev TRUE when the mainnet-only assertions must run: really on mainnet, or the operator asked
    ///      for a rehearsal with DRY_RUN_AS_MAINNET=true. Mirrors DeployWalletchi so the same env var
    ///      rehearses BOTH halves of the mainnet path, not just the deploy half.
    function _asMainnet() internal view returns (bool) {
        return block.chainid == RH_MAINNET || vm.envOr("DRY_RUN_AS_MAINNET", false);
    }

    function run() external {
        Pet721 pet = Pet721(vm.envAddress("PET"));
        PetIssuer issuer = PetIssuer(vm.envAddress("ISSUER"));
        PetVault vault = PetVault(vm.envAddress("VAULT"));
        address validator = vm.envAddress("VALIDATOR");
        address careToken = vm.envAddress("CARE_TOKEN");
        address royaltyRecipient = vm.envAddress("ROYALTY_RECIPIENT");
        address accountImpl = vm.envAddress("ACCOUNT_IMPL");
        address dist = vm.envOr("DIST", address(0));

        // --- Pet721: wiring + one-way locks + royalty ---
        require(pet.issuer() == address(issuer), "pet.issuer != issuer");
        require(pet.issuerLocked(), "pet.issuer NOT locked");
        require(pet.vault() == address(vault), "pet.vault != vault");
        require(pet.vaultRefLocked(), "pet.vaultRef NOT locked");
        require(pet.transferValidator() == validator, "pet.transferValidator != validator");
        require(validator.code.length > 0, "validator has no code");
        require(pet.validatorLocked(), "pet.validator NOT locked");
        require(WalletchiTransferValidator(validator).policyLocked(address(pet)), "validator policy for pet NOT locked");
        require(pet.royaltyLocked(), "pet.royalty NOT locked");
        (address rr, uint256 amt) = pet.royaltyInfo(1, 10_000);
        require(rr == royaltyRecipient && amt == 500, "royalty != recipient/5%");

        _verifyWalletPass(pet, dist);

        // --- PetIssuer: wiring + lock + cross-refs ---
        require(issuer.vault() == address(vault), "issuer.vault != vault");
        require(issuer.vaultLocked(), "issuer.vault NOT locked");
        require(address(issuer.pet()) == address(pet), "issuer.pet != pet");
        require(issuer.accountImpl() == accountImpl, "issuer.accountImpl != accountImpl");
        // THE MINT BUDGET MUST BE ARMED. PetIssuer treats 0 as UNCAPPED, and the deploy script used to
        // never call setMintBudget at all, so this reads 0 on every deploy made before that was fixed:
        // one leaked relayer key mints the whole collection and walks off with every starter float.
        require(issuer.mintsPerWindow() > 0, "issuer.mintsPerWindow == 0 (UNCAPPED: arm the mint budget)");
        require(issuer.mintWindowSecs() > 0, "issuer.mintWindowSecs == 0 with a budget set");

        // --- PetVault: cross-refs ---
        require(address(vault.issuer()) == address(issuer), "vault.issuer != issuer");
        require(address(vault.pet()) == address(pet), "vault.pet != pet");
        require(address(vault.careToken()) == careToken, "vault.careToken != careToken");
        // THE ROSTER CLOSE. What closes it depends on the season model, so ask the vault rather than
        // assuming a clock: under the sellout model entry closes when the collection mints out and
        // `entryDeadline` governs nothing at all.
        require(vault.entryOpen(), "vault entry is already closed: nothing can be minted or hatched");
        if (vault.selloutStartsSeason()) {
            // A freshly deployed sellout season must be UNSTARTED, or pets would be minted into a
            // race whose clocks are already running.
            require(vault.seasonStartedAt() == 0, "sellout season already started before any mint");
            // The sellout can only ever start a decidable season (mirrors the vault's own guard).
            require(
                pet.maxSupply() >= vault.minPlayers(),
                "maxSupply < minPlayers: a sellout could never make this season decidable"
            );
        } else {
            require(
                vault.entryDeadline() > block.timestamp,
                "vault.entryDeadline already passed: nothing can be minted or hatched"
            );
            // And the season must not be decidable while entry is open (PetVault floors _decidesAt at
            // the entry deadline; this asserts the deploy did not configure the two so they contradict).
            require(
                vault.entryDeadline() <= vault.seasonStart() + vault.minSeasonDuration(),
                "entryDeadline > the season floor: the season would be all mint phase"
            );
        }

        // --- Rewards leg: the tax-economy stack (only when configured) ---
        if (dist != address(0)) {
            _verifyTaxStack(vault, careToken, dist);
        } else {
            require(vault.rewardsRecipient() == address(0), "vault.rewardsRecipient set but no DIST env");
        }

        // --- Account impl integrity (the CRITICAL): real code + audited bytecode on mainnet ---
        require(accountImpl.code.length > 0, "accountImpl has no code");
        require(issuer.accountImpl().code.length > 0, "issuer.accountImpl has no code");
        require(careToken.code.length > 0, "careToken has no code");
        if (_asMainnet()) {
            require(
                accountImpl.codehash == keccak256(type(WalletchiAccount).runtimeCode),
                "accountImpl != audited WalletchiAccount"
            );
            // lifeTtl is immutable on the vault (audit H-2), so there is no config-lock to assert.
        }

        // Ownership handoff (audit integration-F3): set EXPECTED_OWNER to catch a deploy where the
        // FINAL_OWNER handoff was forgotten (hot deployer still owns, or the multisig never accepted).
        // Ownable2Step is pending-until-accepted, so verify the LIVE owner is the intended one.
        address expectedOwner = vm.envOr("EXPECTED_OWNER", address(0));
        if (expectedOwner != address(0)) {
            require(pet.owner() == expectedOwner, "pet.owner != EXPECTED_OWNER (handoff incomplete)");
            require(issuer.owner() == expectedOwner, "issuer.owner != EXPECTED_OWNER");
            require(vault.owner() == expectedOwner, "vault.owner != EXPECTED_OWNER");
            if (dist != address(0)) {
                require(CareRewardsDistributor(dist).owner() == expectedOwner, "dist.owner != EXPECTED_OWNER");
                require(
                    HolderMerkleVault(vm.envAddress("HOLDER_VAULT")).owner() == expectedOwner,
                    "holderVault.owner != EXPECTED_OWNER"
                );
                require(
                    CareFeeSplitter(vm.envAddress("SPLITTER")).owner() == expectedOwner,
                    "splitter.owner != EXPECTED_OWNER"
                );
            }
        }

        console.log("VerifyWalletchiWiring: ALL CHECKS PASSED. System fully wired + locked.");
    }

    /// @dev The Wallet Pass Extension (ERC draft): ERC-165 advertises 0xef5f1e71, the pass base is set
    ///      (and, when PASS_BASE_URI is given, is exactly what the deploy composed), passURI round-trips
    ///      as base + id for a minted token and reverts for one that does not exist, and the rewards
    ///      distributor may signal pass updates.
    function _verifyWalletPass(Pet721 pet, address dist) internal view {
        require(type(IERC721WalletPass).interfaceId == bytes4(0xef5f1e71), "IERC721WalletPass id drifted");
        require(pet.supportsInterface(0xef5f1e71), "pet does not advertise IERC721WalletPass (0xef5f1e71)");
        string memory base = pet.passBaseURI();
        require(bytes(base).length > 0, "pet.passBaseURI is empty: passURI resolves to nothing");
        string memory prefix = vm.envOr("PASS_BASE_URI", string(""));
        if (bytes(prefix).length > 0) {
            string memory expected = string.concat(
                prefix, "eip155/", Strings.toString(block.chainid), "/", Strings.toHexString(address(pet)), "/"
            );
            require(
                keccak256(bytes(base)) == keccak256(bytes(expected)), "pet.passBaseURI != PASS_BASE_URI composition"
            );
        }
        uint256 minted = pet.totalMinted();
        if (minted > 0) {
            require(
                keccak256(bytes(pet.passURI(1))) == keccak256(bytes(string.concat(base, "1"))),
                "passURI(1) != passBaseURI + 1"
            );
        }
        // The interface requires passURI to throw for a token that does not exist.
        try pet.passURI(minted + 1) returns (string memory) {
            revert("passURI did not revert for a nonexistent token");
        } catch {}
        if (dist != address(0)) {
            require(pet.isPassSignaler(dist), "distributor is not a pass signaler: reward pushes emit no PassUpdate");
        }
        console.log("  wallet pass: 0xef5f1e71 advertised, passBaseURI:", base);
    }

    /// @dev The tax-economy wiring: vault -> mux -> both weighted distributors, splitter -> holder
    ///      vault + fee distributor, every token cross-ref consistent. Reverts name the exact check.
    function _verifyTaxStack(PetVault vault, address careToken, address dist) internal view {
        CareRewardsDistributor distributor = CareRewardsDistributor(dist);
        HolderMerkleVault holderVault = HolderMerkleVault(vm.envAddress("HOLDER_VAULT"));
        CareFeeSplitter splitter = CareFeeSplitter(vm.envAddress("SPLITTER"));
        address feeToken = vm.envAddress("FEE_TOKEN");

        // The CARE distributor is the vault's rewardsRecipient AND its liveness oracle (one address).
        require(vault.rewardsRecipient() == address(distributor), "vault.rewardsRecipient != DIST");
        require(address(distributor.vault()) == address(vault), "distributor.vault != vault");
        require(address(distributor.careToken()) == careToken, "distributor.careToken != careToken");
        require(
            address(distributor.payoutResolver()) == address(vault.pet()), "distributor.payoutResolver != vault.pet"
        );

        // The splitter: fee token in, holder half to the holder vault, player half swapped to the
        // distributor's CARE, and it reads the same vault for potClaimed.
        require(address(splitter.feeToken()) == feeToken, "splitter.feeToken != feeToken");
        require(address(splitter.careToken()) == careToken, "splitter.careToken != careToken");
        require(splitter.holderVault() == address(holderVault), "splitter.holderVault != HOLDER_VAULT");
        require(address(splitter.distributor()) == address(distributor), "splitter.distributor != DIST");
        require(address(splitter.vault()) == address(vault), "splitter.vault != vault");
        require(address(holderVault.rewardToken()) == feeToken, "holderVault.rewardToken != feeToken");
        require(feeToken.code.length > 0, "feeToken has no code");

        // The swap adapter AND its price hint must both be set (else the player half parks forever;
        // re-audit MEDIUM-1). Allow unset only when the operator has explicitly deferred via
        // ALLOW_UNWIRED_SWAP.
        if (!vm.envOr("ALLOW_UNWIRED_SWAP", false)) {
            require(
                address(splitter.swapAdapter()) != address(0), "splitter.swapAdapter unset (player half would park)"
            );
            require(splitter.careOutPerFeeToken1e18() > 0, "splitter swap rate hint unset (player half would park)");
        }

        // THE HOLDER-ROUND CAP MUST BE ARMED ON EVERY CHAIN, not just mainnet. It used to bound a
        // leaked poster key (re-audit MEDIUM-4); it now also GATES posting entirely, because
        // HolderMerkleVault fails closed on an unarmed cap. A zero here is not a weaker deploy, it is
        // a holder airdrop that cannot post a single round and gives no signal until someone tries.
        require(
            holderVault.maxRoundTotal() > 0,
            "holderVault.maxRoundTotal == 0: NOT ARMED, postRound fails closed and the airdrop is dead"
        );
        require(
            holderVault.postingAllowanceAvailable() <= holderVault.maxRoundTotal(),
            "holderVault posting allowance exceeds cap"
        );
        // Posting must not be left paused by the emergency stop, and no poster rotation should be
        // sitting half-committed when a season opens (poster changes take POSTER_ROTATION_DELAY, so
        // a pending one means the runbook step was started and not finished).
        require(!holderVault.postingPaused(), "holderVault posting is PAUSED");
        require(holderVault.pendingPoster() == address(0), "holderVault has an uncommitted poster rotation");
        require(holderVault.releaseGrace() >= holderVault.MIN_RELEASE_GRACE(), "holderVault releaseGrace below floor");

        // The poster must NOT be the relayer/mint key (contracts-audit HIGH-5). RELAYER is optional
        // env; when provided, assert the poster differs from it.
        address relayer = vm.envOr("RELAYER", address(0));
        if (relayer != address(0)) {
            require(holderVault.poster() != relayer, "holderVault.poster == RELAYER (must be a dedicated key)");
        }
        address poster = vm.envOr("POSTER", address(0));
        if (poster != address(0)) {
            require(holderVault.poster() == poster, "holderVault.poster != POSTER");
        }
    }
}
