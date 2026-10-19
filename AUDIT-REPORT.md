# WALLETCHI — Adversarial Security Audit (Consolidated)

Date: 2026-07-28 · Scope: live testnet deployment (Robinhood Chain 46630) — contracts, off-chain relayer, anti-Sybil, live infra.
Method: 5 independent specialist auditors (distinct attack lenses) + chief synthesis; findings adversarially re-checked against live on-chain state and source. No state-changing transactions were sent against the live season.

## Verdict

**The money game is not hackable for funds.** Three independent auditors confirmed on the live deployment that the pot and every pet's token-bound account are safe: the pot is fully backed (`vaultBalance == pot`), there is no way to steal it, no reentrancy, no accounting desync, all four one-way locks are engaged on-chain, and the off-chain confused-deputy fix holds (no path lets attacker A act on pet B; the pass secret never leaks).

The real findings are: **(1)** the anti-Sybil mint wall does not meet the "no farming" goal (a product decision, not a fund drain); **(2)** two operational items that could disrupt a live demo; and **(3)** contract game-design / liveness + centralization items that are mainnet-hardening.

## Severity summary

| # | Finding | Severity | Class | Status |
|---|---|---|---|---|
| S1 | Free + unverified-email mint is farmable | High (defeats goal) | Sybil / product | Product decision |
| I1 | Unauthenticated PNG-render DoS (single instance) | High (availability) | Infra / demo | Fix applied |
| E1 | Un-seeded-close 120s squatter race for the pot | Medium | Contract / liveness | Mainnet |
| A1 | Single EOA owns all contracts + is relayer | Medium | Centralization | Mainnet (multisig) |
| R1 | Care-owner guard fails OPEN on RPC error | Low | Relayer (confused-deputy class) | Fix applied |
| — | MEV "care-last-to-win" snipe + tokenId tiebreak | Low/Info | Game design | Document / redesign |
| — | Velocity caps hard-block (2/IP) + trust-proxy mis-set behind Cloudflare | Low/ops | Infra | Demo config note |
| — | Email-claim oracle + bomb (no rate limit) | Low | Relayer | Fix applied (rate-limit) |
| — | googleSaveUrl leaks on public view | Low | Relayer/infra | Fix applied |
| — | setTransferValidator not lockable | Low | Contract | Next deploy |
| — | Sub-minPlayers close strands pot to owner | Low | Contract | Mainnet |
| — | No app-layer rate limiting; CORS/CSP hardening | Low/Info | Infra | Partial fix |

## Findings (detail)

### S1 — Anti-Sybil mint wall does not hold (High, product)
Minting is free and email ownership is never verified (emails are stubbed; no magic-link/code step). So "one inbox = one pet" is really "one arbitrary string = one pet": a script POSTs distinct email strings and mints. Velocity caps (2/IP/day, /64 IPv6 keying) and the 20-bit PoW cost pennies to rotate/solve. Cheapest cost to farm the whole 2000 supply: ~$0 (home IPv6 /56) to ~$200 (rotating proxies).
Impact scoping: this is NOT a fund/pot/TBA drain (those are provably safe), and farming does not cheaply win the pot (the endgame is a one-care snipe for a farmer or a single honest player alike). The real harm is **supply monopolization** (one person grabbing the 2000 mint, denying real users) and free lottery-entries.
Fix (mainnet): verified email ownership before mint (one-time code / signed magic-link bound to the PoW nonce) **plus** a mint-time captcha (hCaptcha/Turnstile), or a small mint cost. Velocity/PoW are supporting signals, not the wall. A free, unverified-email mint is fundamentally a speed bump, not Sybil-proof.

### I1 — Unauthenticated PNG-render DoS (High, availability)
`GET /api/pet/<any-number>/preview.png` (and card.png/portrait.png) rasterizes an 800×800–1080×1080 image per request — no auth, no cache at the edge (Cloudflare returns DYNAMIC), attacker-chosen unbounded tokenId = unique cache key = guaranteed origin render, on a single 0.5-vCPU instance. A few dozen concurrent distinct requests saturate CPU and take the whole server down (mint/care/arena included).
Fix (applied): render concurrency semaphore (bounds CPU), in-process LRU cache (repeats render once), and tokenId bounded to the supply cap on the public preview route.

### E1 — Un-seeded-close squatter race (Medium, liveness)
Only `closeSeason(seedTokenId)` installs a protective initial winner candidate. The other close triggers (careDeadline elapsing, `registeredCount >= maxSupply`) flip the season closed with no seed, starting a bare `claimPot` race: the first claimer sets the standing candidate and the 120s challenge timer; if the true max-lastCareAt pet isn't proposed within 120s, the squatter finalizes and takes the pot. Mitigated because supersede is permissionless (the true winner is strictly better; the server or anyone can propose it in-window). Not active in the demo (5/2000 minted; the demo settles via `closeSeason(correctSeed)`).
Fix (mainnet): always settle via `closeSeason(seed)` with the correct max; make close seed-mandatory and/or lengthen the challenge window well past 120s so a backup watcher can respond.

### A1 — Single-key centralization (Medium)
One EOA owns all five contracts and is the relayer. On key compromise the attacker can mint the unminted supply to itself (each pet seeds starter CARE from the issuer float on testnet) and brick/censor secondary trading. It **cannot** drain existing pet TBAs or the pot — the engaged `vaultLocked`/`vaultRefLocked` close the owner-repoint drain path, and the transfer validator is a view (STATICCALL). Blast radius is bounded to "mint remaining supply + grief trading."
Fix (mainnet): owner + relayer to a 2-of-3/3-of-5 multisig + timelock; split a hot mint-only relayer from a cold owner; `lockConfig()` once pacing is final.

### R1 — Care-owner guard fails OPEN on RPC error (Low, confused-deputy class)
`careOwnerGuard` returns "ok" on a read exception, and the Privy `authedOwnerFor` falls back to the stale DB owner. During a Robinhood RPC outage, on a recently-sold-but-unclaimed pet, the previous owner's still-valid care link (or Privy session) would be accepted → relayer burns the new owner's pet's CARE. Griefing (cooldown-limited), not theft; narrow window (RPC error + unclaimed transfer + past the 60s owner cache). Same class as the prior confused-deputy.
Fix (applied): when survival is live, fail CLOSED for that pet on read failure (reuse last-known-good owner if cached; else 503-retry).

### Lower findings (summary)
- **Game design (Low/Info):** winner = MAX lastCareAt makes the endgame a final-block gas-auction snipe (~1 care captures any pot); the lowest-tokenId tiebreak gives pet #1 a structural edge. Arguably the intended "care last to win" mechanic — document, or score on cumulative care / freeze lastCareAt near close.
- **Velocity caps + trust proxy (Low/ops):** the caps are hard blocks (2/IP/day) — a demo where judges share venue WiFi would block everyone after two mints. `TRUST_PROXY_HOPS` is likely mis-set for the Cloudflare→Render topology (req.ip may resolve to a Cloudflare egress IP), making the IP caps either meaningless or a source of false 429s. Verify `req.ip` on the live server; prefer `CF-Connecting-IP`.
- **Email-claim oracle + bomb (Low):** `POST /api/claim` (email) returns 200/403 by ownership (a deanonymization oracle) and has no throttle (an inbox-flood once the email is known). Moot until Resend is live. Fix (applied): rate-limit `/api/claim` + `/api/claim/nonce`; bound the nonce map. Consider a uniform response on mainnet.
- **googleSaveUrl leak (Low):** the public serial-keyed view included `googleSaveUrl` without the withhold that gates the Apple pass URL. Fix (applied): gate it identically.
- **Contract (Low, next deploy):** `setTransferValidator` has no one-way lock (owner can brick trading at will) — add an optional `validatorLocked` after the strict-policy marketplace test. Sub-minPlayers close strands the pot to the owner instead of refunding contributors.
- **Infra (Low/Info):** no app-layer rate-limiting (add a global limiter); CORS reflects any `*.vercel.app` (read-only — no credentials, so not session-riding); no CSP. `SYBIL_PEPPER` is correctly set to a real secret in the live env (the "insecure default" is not live-exploitable) — add a boot-fail if unset when anti-Sybil is on.

## Verified CLEAN (the important stuff)
- **Economics:** care 90/10 split + fee-on-transfer balBefore/after accounting; pot vs balance (fuzzed, incl. hostile FoT + reentrant token); reap pays nothing + can't grief a rival out; settlement supersede is a strict total order (finalize always terminates, no front-run benefit); winner can only be YOUR own pet cared last; rounding routes remainder to burn (no farmable dust); reentrancy guards + CEI throughout.
- **Access / standards:** mint gating (onlyIssuer, capped at 2000, monotonic ids); death-soulbound `_update` (blocks reaped transfers only, no approval/6551/validator bypass, can't be griefed into reverting a live pet); the four one-way locks are truly irreversible and engaged on-chain; 6551 TBA binding + pullCare (onlyVault) + PunchAccount spender (issuer-gated, exactly-once, capped, nonReentrant); royalty one-way lockable; PonsCareToken fixed supply + tax cap + mint/burn never taxed.
- **Relayer / off-chain:** HMAC capability pass-download URLs (256-bit, timingSafeEqual, opaque 404, not cross-pet); back-of-pass care links bind the serial (no cross-pet replay); Privy owner-binding is server-side + fail-secure (503) while survival live; mint-session bound to its serial + the pass secret at issue (dies on rotation) + TTL (corrected 2026-10-17: it was never single-use, Nexory review); claim SIWE nonce single-use + address-pinned + rotates the authToken (kills the seller's pass) + dead-soulbound 409; authToken never appears in any response or log.
- **Infra:** no secret/PII leak in any probed endpoint or error; `/internal/status` is dark (404 without token); security headers present + sane (nosniff, frame DENY, no-referrer, HSTS, x-powered-by off); 256kb body limit; the pass-capability withhold + legacy fail-secure 404 hold live; PoW challenge is stateless.
- Prior fixes re-verified holding: PoW difficulty-lowering is blocked (HMAC-signed bits + floor); the trust-proxy XFF-spoof is handled.

## Prioritized fix plan

**Demo window (now):**
- (config, your call — currently left as-is) anti-Sybil caps block judges on shared WiFi; raise or disable for the demo if judges will self-mint.
- (applied) PNG-render DoS mitigation; care-guard fail-closed; googleSaveUrl gate; claim rate-limit + nonce-map cap.

**Before mainnet (blocks a real-value launch):**
1. Verified email + captcha (or a mint cost) — the only way to meet the anti-farming goal [S1].
2. Owner + relayer to multisig + timelock; split hot relayer from cold owner [A1].
3. Settlement: always `closeSeason(seed)`; make it seed-mandatory; lengthen the challenge window [E1].
4. Verify `TRUST_PROXY_HOPS` / adopt `CF-Connecting-IP` so velocity caps and geo behave [ops].
5. Add a global rate-limiter; uniform `/api/claim` response; boot-fail on missing `SYBIL_PEPPER`.
6. Add `validatorLocked` after the strict-policy marketplace test; decide the sub-minPlayers refund policy.
7. Decide the endgame mechanic (accept "care-last-to-win" snipe, or score on cumulative care) [game design].

**Standing note:** on mainnet the CARE token is Pons's external token (fixed-supply, non-rebasing assumed) — the accounting depends on that; document the real token's tax and confirm it's non-rebasing before launch.
