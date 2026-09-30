# WALLETCHI Secondary-Market Revision (Phase S) | brief | 2026-07-27

SELF-CONTAINED brief for the agent team. Impactful base-contract changes -> FULL re-audit after. Source specs: WALLETCHI-SPEC.md (sections: SECONDARY MARKET, LIVE STATS METADATA + DEATH-SOULBOUND, ROYALTY APPROACH REVISED: ERC-721C, ERC-721C ENFORCEMENT ON RH CHAIN VERIFIED). Current audited-clean contract commit: b27a40c (Pet721/PetIssuer/PetVault/PunchAccount). Repo Halldon-Inc/punchcard, local C:\Users\skadd\punchcard.

## Goal
Make WALLETCHI pets safe + valuable on the OpenSea secondary market: enforceable-ready royalties (ERC-721C + ERC-2981), dead pets permanently non-transferable (soulbound memorial), live unspoofable status in the NFT metadata, and a /claim flow so a buyer can add the pet to their wallet.

## Verified facts (do not re-litigate)
- OpenSea IS live on Robinhood Chain. Seaport 1.6 IS deployed on RH mainnet 4663 (0x0000000000000068F116a894984e2DB1123eB395, 47965 bytes) = the 721-C enforcement protocol layer is present.
- The ERC-721C CreatorTokenTransferValidator is NOT deployed on RH Chain (both canonical 0x721c0078.../0x721C008f... empty). WE must deploy Limit Break's open-source validator on RH Chain and point Pet721 at it (setTransferValidator).
- OpenSea's Operator Filter (the old "block marketplaces" tool) is DEAD (2023). Do NOT use it. ERC-721C is the live enforceable standard.

## WORKSTREAM 1 (contracts, the foundation): Pet721 v2 rebase
Rebase Pet721 on Limit Break's ERC-721C creator-token base (creator-token-standards, OZ-compatible ERC721C) + ERC-2981 royaltyInfo. New Pet721 (Pet721v2) must:
1. ERC-2981: royaltyInfo returns (recipient, 5% = 500 bps). recipient + bps owner-settable, then LOCKABLE (one-way, mirror lockIssuer/lockVault pattern) so it cannot be rug-changed. Dedicated royalty recipient address (separate from owner/treasury) passed at deploy.
2. ERC-721C: creator-definable transfer security policy via a validator. Deploy with a PERMISSIVE policy initially (trading not bricked). Policy is owner-settable post-deploy so we can flip to strict royalty-enforcement AFTER a live OpenSea enforced-listing test confirms enforcement works on RH Chain. Do NOT ship strict-block by default (would brick all secondary trading if the marketplace path is not allowlisted).
3. DEATH-SOULBOUND (marketplace-independent, ships hard): override the transfer hook (_update in OZ v5 / 721-C equivalent) to REVERT owner-to-owner transfers when the pet is DEAD (reaped) per the vault. MUST still ALLOW: mint (from == address(0)), and must not break the 6551 owner() reads. Pet721 needs a reference to PetVault to query deadness: add an immutable-or-lockable vault pointer (mirror the lockVault safety: set once, lock). isDead(tokenId) = vault.petState(tokenId).reaped (or the vault's dead flag). Ensure a pet that is merely lapsed-but-not-reaped is NOT blocked (only truly reaped = dead). Coordinate exact deadness source with the vault interface (INTERFACE-walletchi-v2.md).
4. DEPLOY SCRIPT: extend DeployWalletchi to deploy the 721-C validator (or reference it), set the permissive policy, set royalty recipient/bps, wire Pet721<->vault, and CALL all the lock functions (issuer lockVault + lockIssuer + Pet721 royalty-lock + vault-pointer-lock) so production is fully locked at deploy. Post-deploy gate-check list: vaultLocked, issuerLocked, royaltyLocked, vaultPointerLocked all == true.
5. PRESERVE (must-not-regress, verified in prior audits): initializeSpender issuer-gate, pullCare vault-only, spend caps, owner revokeSpender/execute, reap permissionless+guarded, alive() requires registered, settlement/pot/burn/sweep math (PetVault/PunchAccount UNCHANGED ideally), the game's transfer-does-not-reset-timer invariant, mint path.
6. TESTS: full forge suite green + NEW: royaltyInfo 5%, royalty lock, dead pet transfer reverts, lapsed-not-reaped transfers OK, mint OK, 721-C policy permissive-by-default + owner can tighten, validator wiring, and EXTEND the invariant fuzzer with transfer attempts (alive transfers succeed, dead revert) as INV9. Regenerate ABIs. Dry-run on RH testnet.

## WORKSTREAM 2 (server): dynamic status metadata + claim endpoint
1. /metadata/runner/:tokenId adds LIVE status attributes from on-chain vault state: Status (Alive/Critical/Dead), Life Left, Days Lived, Care Count. Read authoritative (petState/lifeState). Trigger OpenSea metadata-refresh (their API) on death + critical transitions + a periodic sweep. HONEST: OpenSea caches; the /pet page is the always-live source.
2. POST /api/claim: verify NFT ownership. Accept {address, signature (SIWE-style over a nonce), tokenId?} OR {email, tokenId}. Verify signer == Pet721.ownerOf(tokenId) on-chain (for the wallet path); for email, verify differently / require the wallet path for trustless proof (email path may just email the pass if we can bind email->owner, else gate to wallet-proof). On success: issue/re-issue a pass for that EXISTING tokenId + serial reflecting CURRENT persisted state (NO reset, NO death, NO timer change), and ROTATE the pass authenticationToken so the prior owner's pass + its HMAC care links are invalidated. Care actions must verify CURRENT on-chain ownership (or only honor the latest-claimed pass) so a prior owner cannot care/spend a sold pet. Old owner's pass shows "transferred" on its next push.
3. Keep everything behind flags where it touches the (still off) survival economy; the claim + metadata are safe to run with survival off.

## WORKSTREAM 3 (site): /claim + pet-page status (SCAFFOLD ALREADY DONE by web-dev, pending lead review)
- /claim page (WalletConnect/injected + email fallback, verify->success->add-to-wallet). Wire to the real POST /api/claim once server workstream 2 lands.
- /pet/[serial] STATUS banner (Alive/Critical/Dead + Life Left). Already built against state.
- Lead reviews + deploys.

## AUDIT (after workstream 1 + 2 land): FULL re-audit
Re-run all THREE auditors (econ, access, adversary) + the invariant fuzzer against the new frozen Pet721v2 commit. Focus: the transfer hook (death-soulbound + 721-C policy) did not open any new attack (can a dead-check be gamed to block a live pet or allow a dead one; can the validator policy be abused; does the royalty-lock hold; any reentrancy via the validator hook; mint still works; does Pet721<->vault coupling create a griefing/DoS or break the spender model). This is the "huge audit" Hunt flagged. Do NOT deploy the economy to mainnet until this passes clean.

## Sequencing / ownership
- runner-contracts: workstream 1 (Pet721v2). Foundation; everything waits on its interface.
- server-dev2: workstream 2 (after WS1's Pet721 interface for the dead-check + royalty is known).
- web-dev: workstream 3 (scaffold done; wire endpoint after WS2).
- Lead: reviews, commits (agents do not), broadcasts, runs the tri-audit + fuzzer, deploys, saves session files.
NOTE: server-dev2 + runner-contracts hit session limits ~2026-07-27 02:00 (reset ~9:30pm America/Toronto). Dispatch WS1/WS2 when they reset (or fresh agents with THIS brief). WS3 scaffold is done now.

## Context-hygiene note (Hunt directive)
This brief is the durable source of truth so the team does NOT depend on the lead's (large) context. Save session files as phases complete. Keep the demo (survival off, founder pet) untouched throughout.

## WS2 /api/claim CONTRACT (locked to web-dev's built scaffold, server-dev2 build to THIS exactly)
web-dev built /claim against this; server-dev2 must match it (no renames):
POST /api/claim
  wallet: { method:"wallet", address, signature, message, tokenId? }   // SIWE-style personal_sign over a nonce
  email:  { method:"email", email, tokenId }
Responses:
  200 single: { ok:true, serial, tokenId, runnerNumber, status, secondsLeft?, applePassUrl?, googleSaveUrl?, emailed? }
  200 multi:  { ok:false, multiple:true, pets:[{ tokenId, serial, runnerNumber, status }] }  // signer owns several
  4xx:        { error, code:"not_owner"|"not_found"|"dead_soulbound" }
Also for the /pet status banner + claim: ADD secondsLeft (+ optional daysLived/careCount) to GET /api/runner/:serial state. NEW field googleSaveUrl needed on claim (Google Wallet JWT save link). NONCE: add GET /api/claim/nonce (server-issued + verified) instead of the client nonce web-dev placeholdered. EMAIL path: verify email-on-file for the pet (a secondary buyer who did not mint via email uses the wallet path). Verify signer == Pet721.ownerOf(tokenId) on-chain. On success: re-issue pass for the EXISTING pet (no reset/death/timer change) + ROTATE the pass authToken (invalidate the prior owner's pass + its HMAC care links); care actions verify CURRENT owner. web-dev left a ?preview=success|multi|dead|error debug param on /claim: STRIP it before the final Phase-S deploy.
