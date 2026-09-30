# WALLETCHI Pass-URL Capability Fix (Phase S, security) | brief | 2026-07-27

SELF-CONTAINED brief. Closes the CRITICAL pre-mainnet blocker (task 31). OFF-CHAIN only, NO contract redeploy. Repo Halldon-Inc/punchcard, local C:\Users\skadd\punchcard. Work in server/ (+ a small web-cub/ touch if the site builds pass URLs client-side). DO NOT deploy, DO NOT restart the live :8080 process, DO NOT rebuild dist (the running demo serves compiled dist and must stay up), DO NOT commit (lead freezes commits). House rule: NEVER use em dashes or "--" in any output/strings/comments; use colons/parentheses/restructure.

## The vulnerability being closed (confused-deputy -> permissionless rival-drain)
- `/runner-passes/:serial.pkpass` (server/src/runner/routes.ts:595) is UNAUTHENTICATED and serves the full signed pass, which EMBEDS the HMAC-signed care-action links.
- The care-link HMAC is sound (keyed to the per-pet secret `authToken`, `randomBytes(24)`, verifyTag at routes.ts:350), BUT the pass file PUBLISHES those already-signed links.
- The `serial` LEAKS via public `/metadata` image URLs (required for OpenSea).
- A care link, when hit, causes the server (which is the on-chain `relayer`) to execute `PetVault.care(tokenId)` (contracts/src/runner/PetVault.sol:357, gated `msg.sender==relayer||owner`), which pulls `careCost` from the CARED pet's OWN 6551 TBA (90% burned, 10% to pot) and resets its life timer.
- => ANY attacker can enumerate tokenId -> read metadata -> get serial -> download that pet's pass -> replay its care links -> drain any rival pet's TBA (rate-limited only by careCooldown). Force-drain rivals to empty so they can no longer self-care -> they die -> attacker is last-alive -> wins the (inflated) pot. Attacker cost = gas only; the burned tokens are the victims'.
- The CONTRACTS are correct; this is an OFF-CHAIN relayer confused-deputy bug. server-ws2 already added a current-owner care guard (stops a STALE SELLER's links) but NOT a fresh downloader of the CURRENT pass. This fix closes that.

## Required invariants (the mini-audit will check these)
1. When real-value care is possible for a pet, downloading its pass REQUIRES a capability secret that is UNGUESSABLE without the pet's `authToken` and is NOT derivable from the public `serial`/`tokenId`.
2. The capability is NOT the raw `authToken` (authToken is the Apple web-service auth header; do not expose it in a URL). Derive a dedicated download capability from it, e.g. `cap = HMAC_SHA256(authToken, "pkpass-download-v1")` hex (>= 128 bits / 32 hex chars). No schema change (derive at request time; server-ws2 kept zero migrations, preserve that).
3. The capability ROTATES with `authToken`. WS2's `rotateRunnerAuth` rotates authToken on a wallet claim, so a NEW owner's pass gets a NEW cap AND new care-link HMACs; the SELLER's old pass URL (old cap) must 404 after rotation. Verify pass regeneration re-derives care-link HMACs from the CURRENT authToken (WS2 already does this).
4. The capability is verified with a constant-time compare (crypto.timingSafeEqual). A wrong/absent cap returns 404 (stay opaque; do not confirm serial existence differently for right-serial-wrong-cap).
5. The DEMO (real-value care OFF: founder pet, free care) is NOT broken. Fail-SECURE: if the server cannot affirmatively determine real-value care is OFF for a deployment, it REQUIRES the capability.
6. NO endpoint leaks the cap: metadata/image endpoints stay keyed on serial/tokenId (images carry no care links, so serial there is fine). Grep to be sure the cap never appears in metadata, portrait, preview, or any public listing.
7. The Apple Wallet WEB-SERVICE update path (`/v1/passes/...`, authToken header) is UNCHANGED and still works (installed passes keep updating). This fix only touches the INITIAL/re-download of the `.pkpass` file.

## Build
1. NEW canonical capability download route, e.g. `GET /runner-passes/:serial/:cap.pkpass` (pick a clean shape): look up runner by serial, derive expected cap from its authToken, timing-safe compare, else 404. On success serve exactly as today (same pkpass bytes, same 304/Last-Modified logic).
2. LEGACY `GET /runner-passes/:serial.pkpass`: gate it. Serve ONLY when real-value care is OFF for this deployment (demo/testnet). When the real economy is live, return 404. FIND the correct "real economy is on" signal in the codebase (e.g. a survival/economy flag, the live CARE token address being set, the live vault vs the demo vault) and use it; if no clean signal exists, add an explicit env `ALLOW_PUBLIC_PASS_DOWNLOAD` that DEFAULTS TO FALSE (fail-secure) and document it. Report exactly which signal you used.
3. Google Wallet save route `/google/runner/save/:serial` (routes.ts:614): CHECK whether the Google pass embeds the same care links. If YES, apply the same capability gating. If NO (Google uses a different care mechanism or carries no care links), document that it is not a care-link leak and leave it. Report your finding.
4. Update EVERY emitter of the pass URL to emit the CAPABILITY url: grep server/src for `/runner-passes/`, `.pkpass`, `applePassUrl`, `applePass`, `googleSaveUrl`. Includes: the mint response (routes.ts ~89/94), the WS2 claim response (claim-routes.ts / claim.ts), the email delivery path, and any pet-page/state field. After a claim, the returned `applePassUrl` MUST be the new-owner capability URL.
5. web-cub/ check: grep the site for client-side pass-URL construction (any place it builds `/runner-passes/${serial}.pkpass` itself instead of consuming the API's `applePassUrl`/`googleSaveUrl` field). If the site hardcodes the serial URL, note EXACTLY what the site must change (the lead will handle web). If the site just consumes the API field, no web change is needed. Report which.
6. Keep server-ws2's current-owner care guard (defense-in-depth). Do not weaken it.

## Verify (do all, report results)
- `npx tsc --noEmit` clean.
- Run the smoke suite; keep it green; ADD focused tests: (a) legacy public route blocked when economy-on / flag-off; (b) capability route serves with the correct cap; (c) wrong/absent cap -> 404; (d) after rotateRunnerAuth (claim), the OLD cap 404s and the NEW cap serves; (e) demo/economy-off path still serves (invariant 5); (f) metadata/image endpoints do NOT expose the cap.
- Confirm you did NOT touch the Apple web-service `/v1/passes` path.

## Report (SHORT, no code dumps)
Files changed (path + one line each); the exact route shape + cap derivation; the "economy-on" signal you gated on (+ any new env, its default); the Google-save finding; the web-cub finding (does the site need a change, exactly what); smoke/tsc results incl. the new tests; anything the lead must wire for mainnet. Remember: no deploy, no dist rebuild, no :8080 restart, no commit.
