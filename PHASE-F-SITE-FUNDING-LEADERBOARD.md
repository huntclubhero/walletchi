# WALLETCHI Phase F: on-site play, funding, leaderboard | brief | 2026-07-27

Durable spec for the next build wave. Greenlit by Hunt ("go ahead with everything").
Repo Halldon-Inc/punchcard, local C:\Users\skadd\punchcard. Site web-cub/, server server/.
House rule: no em dashes / "--". No deploy/restart/dist-rebuild/commit by agents (lead freezes).

## LOCKED DECISIONS (Hunt, 2026-07-27)
- NO APP. Everything on the WEBSITE. Sign in with your email on the site; feed/fund/manage the pet there.
- NO SEED. STARTER_TOKENS = 0 on mainnet: mint is free, but to play you must buy a bit of token. Buying feeds the prize pool (90% burn / 10% pot on every care), so the pot grows from players paying to play.
- MINT OFFERS A TOP-UP immediately: right after the free mint, offer "give your pet its first meal -> buy tokens".
- BUY = a fork: "Card or Crypto?" The user chooses the flow.
  - CARD = full fiat flow, no wallet tech needed (for newbies).
  - CRYPTO = experienced users self-fund: show them the pet's account address + amounts + a swap link, and just tell them what to do.
- FUNDING HAPPENS ON THE SITE (Privy embedded wallet), so newbies need no real wallet tech.
- LEADERBOARD: yes, build it.

## KEY MECHANIC (why funding targets the pet's account)
Care pulls the fee from the pet's OWN ERC-6551 token-bound account (TBA), via the vault spender
(initializeSpender is set at mint). So CARE tokens must land in the PET'S TBA (a deterministic
address we always know), NOT the user's wallet as the final destination. Feeding itself needs NO
per-action signature (the relayer submits, pulling from the pre-funded TBA). The ONLY step that needs
the user's authorization is BUYING/funding (spending their own money): make it one tap, no addresses.

## F1: LIVE SURVIVAL LEADERBOARD  (BUILDING NOW: agent leaderboard-dev)
Unblocked (data exists). New read-only GET /api/season/board (survivors {alive,total,fallen}, pot
{display,raw}, recentDeaths[], topKeepers[] by careCount, optional usdValue hook). Site "Arena":
big animated pot count-up, survivors ticking down + deathometer, live death feed (newest slides in,
portraits), most-devoted keepers. Polls every 4-6s, motion on mobile, matches the design system.
The pot $ USD value is a hooked slot that snaps in when the token launches (needs a price source).

## F2: SIGN-IN WITH EMAIL -> pet dashboard on the site  (GATED on Privy keys)
Privy email login (OTP) recovers the user's embedded wallet -> a "my pet" dashboard on the site:
pet face + live meters + care buttons + a Top-up button. This is the on-site home for returning
users (not only the wallet pass). Build on Privy (NEXT_PUBLIC_PRIVY_APP_ID + secret). Blocked until
Hunt provides the Privy app.

## F3: FUNDING FLOW (Card | Crypto)  (GATED on CARE token address + onramp verify)
Trigger points: the mint-success screen ("feed your pet") + a Top-up button on the dashboard + when
a care action fails for low balance. Chooser: "How do you want to pay? [Card] [Crypto]".
- CRYPTO path (buildable as soon as the token address is set; no onramp needed):
  show the pet's TBA address (prefilled, copy button, QR), a Uniswap swap deep-link (already wired:
  uniswapSwapUrl() in brand.ts, prefills outputCurrency=CARE), suggested amounts, and clear steps.
  Experienced users self-serve. Destination is always the pet's TBA (never hunt for it).
- CARD path (needs onramp provider + RH Chain support verified: see FINDING below):
  one tap "Buy with card" -> Privy fiat onramp (Meld/MoonPay/Coinbase) or Robinhood's own onramp ->
  a supported asset (USDC/ETH) on Robinhood Chain -> WE orchestrate an on-chain swap to CARE and a
  deposit into the pet's TBA. User taps once, sees no addresses. Suggested "buy N care credits = $X".
- Both paths END in the pet's TBA funded. After that, feeding is signature-free.

## F4: ON-SITE CARE ("feed the tank" on the website)  (GATED on F2 auth)
A signed-in owner (Privy-proven to own the pet) taps feed/water/play on the dashboard -> server
verifies current owner -> relayer submits care() (no per-action signature; pulls from the TBA). Same
economy as the wallet-pass care links, just from the site. Reuse the existing care action + the
current-owner guard.

## ONRAMP FINDING (research 2026-07-27, verify at wire time)
- Privy ships a built-in fiat onramp that routes through Meld / MoonPay / Coinbase by region
  (docs.privy.io/wallets/funding/fiat-onramp): so the card path is mostly Privy-native once Privy is wired.
- Robinhood itself runs a fiat-to-crypto onramp for self-custody wallets, and this is ROBINHOOD Chain,
  so Robinhood's own onramp is the most native funding path to verify.
- MoonPay acquired Glide (ex-Robinhood Wallet engineers): card deposits auto-routed across 100+ tokens
  / 30+ chains with no manual swap/bridge (MoonPay Deposits). This is the "card -> any token, no
  bridge" primitive.
- CAVEAT (the real unknown): onramps sell MAJOR assets (USDC/ETH), NOT a day-old launchpad token. So
  the CARD path realistically = card -> USDC/ETH on Robinhood Chain -> we swap to CARE -> deposit to
  the TBA. Two things to CONFIRM when wiring (needs the Privy app + token live): (1) does Privy's
  provider set / Robinhood's onramp support Robinhood Chain as a destination network; (2) route the
  final USDC/ETH -> CARE swap + TBA deposit. If chain support is missing, fall back to: card -> a
  supported chain -> bridge (Across) -> swap -> TBA (more hops, still one-tap orchestrated).

## SEQUENCING
- NOW: F1 leaderboard (agent building). Record decisions (this file + runbook STARTER_TOKENS=0).
- ON PRIVY KEYS: F2 sign-in + dashboard, F4 on-site care.
- ON TOKEN ADDRESS: F3 crypto path (immediately), then card path after verifying onramp chain support.
- Full re-verify (tsc + smoke + build) each wave; funding + care touch money-adjacent flows, so a
  security pass on the on-site care auth + the funding orchestration before mainnet.
