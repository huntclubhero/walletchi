> **HISTORICAL: superseded by WALLETCHI-SPEC.md.** PUNCHCARD was scrapped as a product on 2026-07-26; this spec is kept for reference only.

# PUNCHCARD | Hackathon Spec | 2026-07-24

The loyalty punch card, reinvented: an NFT you buy with just an email and a debit card, that lands in your Apple/Google Wallet as a real card, holds real dollars (USDG) and punches on Robinhood Chain in an ERC-6551 account, and updates live in your pocket every time a vendor scans it.

**Deadline: this weekend (hackathon). Ship a REAL working product, happy path bulletproof.**

## 0. Brand

- **Name: PUNCHCARD** (alternates considered: TAB, CREMA). The OG coffee loyalty card, on-chain.
- Voice: clean, confident, slightly playful. "10 punches. Free coffee. Real dollars. Your card, your keys."
- Visual: matte black card, cream/espresso accent, bold wordmark, punch dots that fill in. NO em dashes in any copy anywhere (hard rule).
- Demo story: coffee shop. Judge buys card on their phone, walks to the "counter" (our terminal page on a laptop), barista scans, $4.50 latte paid in USDG from the card, punch added, lock screen lights up.

## 1. The 3-minute judge demo

1. punchcard site on judge's phone: "Get the card. $20." Email + debit card only (Privy modal: email login, embedded wallet, Stripe onramp card/Apple Pay payment, USDC on Base).
2. Backend sees payment, mints PunchCard NFT on Robinhood Chain to the buyer's wallet address, creates its ERC-6551 token-bound account, seeds it with USDG + 0 punches from treasury.
3. Email arrives (Resend): card art + "Add to Apple Wallet" + "Save to Google Wallet" buttons.
4. Card in Apple Wallet: balance, punches, QR.
5. Vendor terminal (web page, second device) scans QR, charges $4.50: server verifies token, executes USDG transfer out of the TBA + mints 1 PUNCH into it, pushes pass update. Lock screen: "Punch! $x.xx left. 9 punches to a free coffee."
6. Blockscout tab open the whole time: real chain, real NFT, real money moving.

## 2. Architecture

### Payment leg (Base) vs asset leg (Robinhood Chain)
Privy/Stripe onramp CANNOT deliver to Robinhood Chain (supported USDC networks: Base, Polygon, Solana, Avalanche). So:
- User's embedded wallet is funded with USDC on **Base** via onramp, then pays our **treasury address on Base** (USDC transfer, client-initiated via Privy embedded wallet, no extra signing UX beyond confirm).
- Server watches for the payment (poll Base RPC / Alchemy webhook), then the **relayer wallet on Robinhood Chain** mints + funds. Same user address on both chains (EVM).
- Treasury holds a **pre-bridged USDG float on Robinhood Chain** (bridge USDC in via Across before the event; arrives as USDG).

### Chains (verified literals)
- Robinhood Chain mainnet: chainId **4663**, RPC `https://rpc.mainnet.chain.robinhood.com`, explorer `https://robinhoodchain.blockscout.com`. Gas = ETH.
- Robinhood Chain testnet: chainId **46630**, RPC `https://rpc.testnet.chain.robinhood.com`, explorer `https://explorer.testnet.chain.robinhood.com`, faucet `https://faucet.testnet.chain.robinhood.com`.
- Base mainnet USDC: `0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913` (6 decimals).
- USDG on Robinhood Chain: DO NOT invent the address. Resolve from Blockscout / Robinhood docs and set via env `USDG_ADDRESS`. Until resolved, dev uses our own MockUSDG on testnet.
- ERC-6551 registry canonical: `0x000000006551c19487814612e58FE06813775758`. If absent on target chain, deploy via Nick's Factory `0x4e59b44847b379578588920cA78FbF26c0B4956C` with salt `0x0000000000000000000000000000000000000000fd8eb4e1dca713016c518e31` (bytecode from erc6551/reference). Check testnet AND mainnet; HOODIES project suggests mainnet may already have it.

### Spending authorization (the honest custody story)
TBA is owned by the NFT holder. At mint, the account is initialized with a **spender permission** for our CardIssuer contract: per-tx cap (e.g. $25) and daily cap (e.g. $100), enforced ON-CHAIN in the account implementation. Server relayer calls CardIssuer.charge(tokenId, amount, vendor) which pulls USDG from the TBA within caps + mints PUNCH. Holder can revoke the spender or withdraw everything at any time (it is their account). Pitch line: "contract-enforced spending limits: tap-to-pay convenience, self-custody guarantees."

## 3. Monorepo layout (`C:\Users\skadd\punchcard\`)

```
punchcard/
  contracts/   Foundry. PunchCard721, PunchAccount (6551 impl + spender caps),
               CardIssuer (mint/fund/charge orchestrator), PUNCH (ERC-20, issuer-mintable),
               MockUSDG (testnet), deploy scripts (testnet + mainnet), registry deploy script.
  server/      Node 20 + Express + Prisma/Postgres. Payment watcher, relayer,
               pass service (Apple PKPass + web service protocol + APNs push; Google Wallet API),
               redemption API, Resend email. Deploy: Render.
  web/         Next.js 15 App Router. Landing + buy flow (Privy React SDK),
               success page, vendor terminal (QR camera scanner + charge UI). Deploy: Vercel.
```

## 4. Contracts (Foundry, Solidity 0.8.24+)

- **PunchCard721**: ERC-721, sequential ids, max supply config, `mint(to)` onlyIssuer. tokenURI: hosted JSON (server endpoint) for the weekend; on-chain SVG only if time remains.
- **PunchAccount** (ERC-6551 account impl, based on erc6551/reference `ERC6551Account`): standard `execute` for owner; plus `spendAllowance(spender, perTxCap, dailyCap)` set once at creation via CardIssuer; `spend(token, to, amount)` callable by approved spender within caps (daily window tracked on-chain); owner can `revokeSpender()`.
- **CardIssuer**: onlyRelayer `issueCard(to, usdgAmount)` = mint 721 + createAccount via registry + transfer USDG in + set spender caps; `charge(tokenId, amount, vendorId)` = TBA.spend(USDG, vendorWallet, amount) + PUNCH.mint(tba, 1); punch #10 auto-redeems: burns 10 PUNCH, emits FreeCoffee event, no USDG charged.
- **PUNCH**: ERC-20, 0 decimals, mint/burn onlyIssuer.
- Tests: full Foundry suite (mint, fund, charge, caps enforced, cap window rollover, revoke, free-coffee redemption, non-owner attacks). Green before any deploy.
- Deploy scripts: `Deploy.s.sol` reading env (RPC, USDG_ADDRESS or MockUSDG, relayer, treasury). Registry existence check + Nick's-factory deploy path.

## 5. Server (the heart)

- **Postgres** (Neon or Render PG): cards (serial, tokenId, tba, owner, email, balances cache), devices/registrations (Apple pass web service), redemptions (jti replay guard), vendors.
- **Payment watcher**: watch Base USDC Transfer logs to treasury; match sender = buyer wallet from checkout session; idempotent.
- **Relayer**: viem wallet client on Robinhood Chain; calls CardIssuer.issueCard, charge. Nonce-safe queue (single worker).
- **Apple pass service** (passkit-generator):
  - Pass type: storeCard. Fields: balance (USDG), punches (dots in strip art or field), holder, card #. Barcode: QR = JWT `{serial, jti, iat}` signed HS256 server secret; refreshed on every pass update push.
  - Full Apple Wallet Web Service protocol: POST/DELETE device registration, GET serials, GET latest pass, log endpoint. Auth via pass authenticationToken.
  - Push updates via APNs using the PASS certificate (node-apn / apn2). On charge: update balance/punches, new QR jti, changeMessage on the balance field so the lock screen shows "Punch! ...".
  - Cert config via env: `PASS_CERT_P12_BASE64`, `PASS_CERT_PASSWORD`, `PASS_TYPE_ID`, `TEAM_ID`, plus Apple WWDR G4 cert. UNTIL JP delivers the .p12: build everything, unit-test pass JSON, keep a `PASS_STUB_MODE` that serves the .pkpass unsigned for structure inspection. Do NOT fake signing.
- **Google Wallet service**: Loyalty class + object via REST API, Save link = signed JWT (service account key env `GOOGLE_SA_KEY_BASE64`, issuer id env). PATCH object on charge.
- **Redemption API**: `POST /api/redeem` {qrToken, amountCents, vendorId} from terminal: verify JWT + jti unused + amount ≤ caps, call relayer charge, mark jti used, trigger pass updates (Apple push + Google PATCH), return receipt {txHash, newBalance, punches}.
- **Email** (Resend): purchase receipt with card art, Add to Apple Wallet button (link to `GET /passes/:serial.pkpass`, content-type `application/vnd.apple.pkpass`) + Save to Google Wallet button (JWT save URL). Plain HTML, dark card hero, bulletproof buttons.
- **Checkout API**: create checkout session (email via Privy auth token verification, wallet address), status polling endpoint the success page uses.

## 6. Web (Next.js 15, Vercel)

- **Landing**: bold single page, matte black. Hero card mock, "Get the card | $20", how-it-works 3 steps, live counter of cards issued. frontend-design quality bar; no wimpy gradients; edge-to-edge.
- **Buy flow**: Privy React SDK: email login → embedded wallet → funding (pay with card / Apple Pay, USDC on Base) → one confirm to pay treasury → progress screen (paying → minting on Robinhood Chain → card ready) → success page shows card + "check your email" + both wallet buttons inline too (do not depend on email deliverability on stage).
- **Vendor terminal** `/terminal`: PIN-gated page. Camera QR scanner (html5-qrcode or zxing). Product buttons (Latte $4.50, Espresso $3.00, Cold Brew $5.50). Scan → charge → big green receipt with tx link + punch animation. This page IS the vendor scan visibility: every scan logged and shown in a live feed panel.
- **Card page** `/card/:serial`: public status (balance, punches, tx history via Blockscout links).

## 7. Environments and demo-day risk

- **Dev**: Robinhood testnet 46630 + MockUSDG; Base Sepolia for payment leg watcher tests; Privy test app; Google Wallet demo mode (register our test Google accounts); Apple pass on real device as soon as .p12 arrives.
- **Demo day**: Robinhood MAINNET (real USDG float bridged via Across) + Base mainnet payment. Rehearse full flow with a real debit card BEFORE the demo (KYC pre-cleared on our accounts).
- **Fallback path** (stage insurance): `DEMO_BYPASS_PAYMENT=true` flag: checkout can skip the live onramp and use a pre-funded wallet, everything downstream identical and real. Never advertised, only if Stripe KYC stalls on stage.
- **KYC risk**: onramp on a fresh judge account may require light KYC. Primary demo uses OUR pre-verified account for purchase; judge's phone gets the email + wallet card + does the scan.

## 8. External prerequisites (Hunt, tonight)

1. **JP: Apple Pass Type ID + cert (.p12)**: instructions doc written at `C:\Users\skadd\punchcard-jp-apple-cert-2026-07-24.md`. THE critical path; send tonight.
2. **Privy dashboard**: create app, enable email login + embedded wallets + "Pay with card" funding (User management > Account funding). Need App ID + secret.
3. **Google Wallet issuer**: free signup (any Google account) at pay.google.com/business/console: get Issuer ID, create GCP service account key. 10 minutes.
4. **Wallets**: relayer + treasury keys; fund relayer with ETH gas on Robinhood Chain (bridge small ETH via Across); bridge ~$200 USDC → USDG float for demo cards; testnet ETH from faucet for dev.
5. **Resend**: domain or resend.dev sender for the email.
6. **Hackathon logistics**: which event, submission requirements, judging format (tell me and I fit the pitch).

## 9. Open decisions (defaulted, flag if wrong)

- Price $20 = $18 loaded USDG + $2 to cover gas/bridge/margin (adjustable env).
- Supply cap 500 for the event.
- Punch target: 10 punches = free coffee (burns punches, no charge).
- Card art: generated SVG/PNG per card number, matte black + cream punch dots.

## 10. Build team plan

- **contracts** teammate: Foundry suite + tests + testnet deploy readiness.
- **server** teammate: Express + Prisma + pass services + redemption + email.
- **web** teammate: landing + buy flow + terminal.
- Integration + live-fire + polish: main session after teammates land. Verify end-to-end per house rules before calling anything shipped.
