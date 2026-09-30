# WALLETCHI Testnet Showcase: deploy runbook

WALLETCHI will not launch on mainnet (Hunt, final). This runbook relaunches it on Robinhood
testnet (chain 46630) as a public "Testnet Experience" for the Wallet Pass Extension ERC:
1,000 free mints, one per email, fake CARE and MockUSDG, a pet that hatches the moment it is
minted, and simulated trading fees so every leg of the economy visibly moves.

**The showcase contracts are a live, conforming implementation of the draft.** Pet721 implements
`IERC721WalletPass` (ERC-165 id `0xef5f1e71`), `passURI(id)` resolves to a gated pass manifest on
the API, and the token contract emits `PassUpdate` / `BatchPassUpdate` whenever state a pass
renders changes. See section 2b.

Every step says who runs it and whether it needs **Hunt's go**. "No" means it is read-only or
purely local.

## LIVE RECORD (deployed 2026-09-23)

The showcase is live: `main` at `a8911ea` is deployed on Render (API) and Vercel (site), env
swapped, DB wiped (2 runners, 251 holder rounds and 926 holder leaves deleted), and every
post-deploy check passed (chain-config, stats, the manifest's 401 gate, the new vault in the site
bundle). VerifyWalletchiWiring: ALL CHECKS PASSED.

| Contract | Address (Robinhood testnet 46630) |
|---|---|
| Pet721 (IERC721WalletPass, 0xef5f1e71) | `0x96100112afec4a034270d96a133c8952e8c63f45` |
| PetVault | `0x11a2d10ee8e15ba5193e6e231a825541cb216f38` |
| PetIssuer | `0x44e0ec044bcaad3bcb9afe08050b70b6212245e0` |
| MockCareToken (CARE) | `0xae0ad0ec295e9b1d1c579a442bc9c126744de8d8` |
| MockUSDG (fee token) | `0x0243e60ca97ed4e3e642a260a028b1ad4f304603` |
| CareRewardsDistributor | `0xf9c34a544f965a8c61ef33beac5f568f6b4a7818` |
| HolderMerkleVault | `0xbd9b8ca0aebcd911186459899a259d7b7ba59657` |
| CareFeeSplitter | `0xd89d34b6d741743878763ffda13c3882b58fc7c8` |
| MockSwapAdapter | `0xd778610e65d7d02309d20e08050c9e0ebf127c60` |
| WalletchiTransferValidator | `0x1d90c8e3c39446084836a652e57fd047439ccf50` |

- First block (`FEE_SNAPSHOT_FROM_BLOCK`): **122998637**.
- Validator lock tx (`Pet721.lockValidator()`): `0xb5dc3aa7238d2ca3aff461629f7330de633718e486db195319c7188c7d3f9764`.
- Alchemy Gas Manager policy: **`<policy id>`**. Limits: 1,500 ops per
  sender, 1.5M ops in total, spend unlimited, ends at deploy + 75 days, and the same sponsorship
  webhook as before.
- `passBaseURI` read live: `https://api.playwalletchi.com/wallet-pass/eip155/46630/0x96100112afec4a034270d96a133c8952e8c63f45/`.
  `supportsInterface(0xef5f1e71)` is true, and the distributor is a pass signaler. Before mint
  No. 1, `passURI(1)` reverts `ERC721NonexistentToken(1)`, as the interface requires.

## 0. The model in one paragraph

This showcase runs on the **clock model** (`SELLOUT_STARTS_SEASON=false`), not the sellout
model season 2 used. The season is live from the deploy block. A mint hatches its pet
immediately through mint-time arming, and every mechanic works from then on. Minting stays
open for `ENTRY_WINDOW_SECS` (60 days). The season **cannot be decided** before
`max(entryDeadline, deploy + MIN_SEASON_DURATION)`, which is also day 60. After day 60 minting
closes. Live pets play on until only one is left alive: once the runner-up's weakest need has
lapsed a full `LIFE_TTL`, the pot goes to the last pet standing and that pet becomes immortal.
No contract change was needed for any of this.

## 1. Parameters (`contracts/script/showcase.env`)

| Var | Value | Why |
|---|---|---|
| `MAX_SUPPLY` | 1000 | Hunt's number. |
| `SELLOUT_STARTS_SEASON` | false | The clock starts at mint, so a visitor's pet is live the moment the pass lands. |
| `ENTRY_WINDOW_SECS` | 5184000 (60 d) | The mint window IS the showcase. A visitor on day 20, or day 59, still gets a live pet. |
| `MIN_SEASON_DURATION` | 5184000 (60 d) | Must be at least the entry window (script require), so the season cannot end while anyone can still join. Equal is the tightest legal value. |
| `LIFE_TTL` | 86400 (24 h) | **Hunt ruling 2026-09-22: stays 24h.** The product clock: every need served once per 24h. |
| `MIN_PLAYERS` | 3 | The contested threshold. Timing is held by the 60-day floor, not by this number, so a small value only guarantees finalize can be shown even at low turnout. |
| `ABANDON_GRACE` | 604800 (7 d) | Only matters if fewer than 3 pets ever hatch. Unchanged from season 2. |
| `MINT_BUDGET_MAX` / `MINT_BUDGET_WINDOW` | 200 / 3600 | 200 mints per hour absorbs a launch-post spike. A leaked relayer key could drain the full 1,000 in 5 hours, not in one burst, and the owner has `setPaused`. Required check: 200 x (60 d / 1 h) = 288,000 >= 1,000. A keeper who arrives in a spent hour now gets "Busy hour: the showcase mints 200 an hour, try again in N minutes." |
| `CARE_COST` / `PER_TX_CAP` / `DAILY_CAP` | 1e18 / 1e18 / 20e18 | Unchanged. DAILY_CAP 20 >= 5 x 1 + 1; carer sub-cap 10 >= 5. |
| `CARE_COOLDOWN` | 0 | Shipped design. |
| `STARTER_TOKENS` | 500e18 | Five needs cost at least 5 CARE a day, so 100e18 bought ~20 days, which would starve a day-1 pet before the showcase ends. 500e18 buys ~100 pet-days at the survival rate, before the rewards legs pay CARE back. The mainnet "at most 5 x careCost" guard does not apply on testnet. `issuer.setStarterAmount` retunes it for later mints with no redeploy. |
| `MOCK_CARE_FLOAT` | 600000e18 | 1,000 x 500e18 plus 20% headroom. MockCareToken `mint` is open, so the issuer float can be topped up at any time. |
| `POT_BPS` / `REWARDS_BPS` / `GAS_BPS` | 1000 / 2000 / 100 | 69/20/10/1 as locked. BURN_BPS derives to 6900. |
| `EPOCH_LENGTH` | 7200 | The 2 h push cadence. Lookback derives to 12 (12 x 2 h >= 24 h). |
| `ACCOUNT_IMPL` | 0xb73E98C4262d61C8Fbe6F60b2ea43B2621b4090D | The season-2 impl (CARER_CAP_BPS 5000, has code on 46630). |
| `BASE_URI` | https://api.playwalletchi.com/metadata/runner/ | Season 2 shipped an EMPTY tokenURI. The route is live (HTTP 200) and keys on tokenId, which restarts at 1 after the wipe. |
| `CONTRACT_URI` | https://api.playwalletchi.com/api/collection.json | Same reason; live (HTTP 200). |
| `PASS_BASE_URI` | https://api.playwalletchi.com/wallet-pass/ | The Wallet Pass Extension manifest host. The deploy appends `eip155/<chainId>/<Pet721>/`, so `passURI(id)` names chain, contract and token. **MUST equal the API's `PUBLIC_BASE_URL` + `/wallet-pass/`**, or passURI points somewhere that does not serve the manifest. Owner-settable later (`setPassBaseURI`). |

Set at deploy time, never in the file: `PRIVATE_KEY` (the deployer/relayer key
0x5a97eF885F4369b52dbb23E7cA2FDAe05fB62e6F, which also owns every contract, as in season 2) and
`POSTER=0xf7481a5b3541B7DbFaa362c38fa19ECb13cc4134` (the existing dedicated poster; the script
refuses POSTER == RELAYER).

### What late minters hit (and the answer to each)

1. **Mint closes at day 60.** `issuePet` reverts `EntryWindowClosed` and the API answers 409.
   That is intended, and `/api/chain-config` now publishes `season.entryDeadline` so the site
   can say "mint open until <date>". To keep the showcase open longer, deploy a fresh season
   (this runbook again) before day 60. There is no in-place extension: `entryDeadline` is
   immutable by design.
2. **An egg that never hatched is stuck after day 60.** A pet whose mint-time arming failed
   stays an egg (eggs never die under the clock model) and can hatch at any time until
   `entryDeadline`, then never. It only affects a pet minted in the last hours whose arming
   also failed.
3. **Starter runs dry.** About 100 days at the minimum rate, so it cannot happen inside 60
   days at 5 cares/day. At the 20-care daily cap every day it could. Remedy: anyone can mint
   mock CARE to a TBA (MockCareToken.mint is open).
4. **One-tap care lapses after 7 days.** The server clamps stored sessions to
   `CARE_SESSION_TTL_HOURS` (168). The client already asks for 30 days. Set it to **720** so a
   visitor who never comes back keeps pass-tap care for 30 days.
5. **The finale.** From day 60, the season ends when the runner-up dies. After `finalize`,
   `care()` reverts `GameOver` for every pet and the champion is immortal. That is the "last
   pet standing" mechanic working, not a bug.
6. **Heartbeat false alarm.** `.github/workflows/heartbeat.yml` treats "1 alive of >= 2
   registered" as "champion crowned". Before day 60 that cannot be a champion (the season is
   undecidable). If it fires early, confirm on-chain `isOver() == false` and ack it.

## 2. Simulated trading fees (Hunt ruling 2026-09-22: YES to a MockUSDG drip)

On mainnet the CareFeeSplitter is fed by the launchpad trade tax. Testnet has none, so without a
stand-in the holder airdrop and the USDG to CARE swap never move. With `SHOWCASE_USDG_DRIP=true`:

- **Every 2h epoch** (the push engine), the relayer mints `SHOWCASE_USDG_DRIP_AMOUNT` MockUSDG
  (default **100**) straight into the splitter and calls `distribute()`: 50 USDG lands in the
  holder vault and 50 USDG is swapped 1:1 into 50 CARE for the player rewards pool. That runs at
  most once per epoch: a `ShowcaseDrip` row keyed on (fee token, epoch) is reserved before the
  mint is sent, and a failed mint releases it for retry.
- **The swap rate stays alive.** The splitter parks the player half once its rate hint is older
  than `rateMaxAge` (12h), and the deploy sets it once. The drip re-affirms the same rate past half
  its life. This is owner-only, and it works because the testnet deployer (the owner) is the
  relayer.
- **Holder rounds post on `TAX_DISTRIBUTION_MINUTES`**, set to **720** (twice a day). Every live
  pet's TBA holds CARE and is an eligible holder, so one round means about one delivery
  transaction per live pet (1,000 at full supply). `HOLDER_CLAIM_SIGNER=poster` carries those
  deliveries on the poster key's own queue. At ~4s per receipt, 1,000 deliveries on the relayer
  would hold new mints for over an hour.
- Sizing: 1,200 USDG a day in total, 600 to holders and 600 CARE to player rewards. The care leg
  alone recycles roughly 1,000 CARE a day at 1,000 pets x 5 cares x 20%, so the drip is visible
  without swamping the game.
- Mainnet cannot run it: the server refuses to boot with `SHOWCASE_USDG_DRIP` on mainnet, and the
  drip itself skips on mainnet.
- Site label (sent to ShowcaseCopy): **"simulated trading fees"**.

## 2b. Wallet Pass Extension (ERC draft, interface id 0xef5f1e71)

What is on chain (Pet721, PetVault, CareRewardsDistributor):

- `supportsInterface(0xef5f1e71)` is true, next to ERC-721, ERC-2981 and ERC-721C.
- `passURI(id)` reverts `ERC721NonexistentToken` for an unminted id. Otherwise it returns
  `passBaseURI + id`, e.g.
  `https://api.playwalletchi.com/wallet-pass/eip155/46630/<pet721 lowercase>/12`.
- `PassUpdate(id)` comes from the TOKEN CONTRACT on mint and transfer (Pet721 `_update`) and on
  every care, including the hatch. PetVault asks Pet721 to emit, since the events belong to the
  token contract. It also comes on a prize push and, from the rewards distributor, on a
  residual sweep to the champion.
- `BatchPassUpdate(from, to)` (inclusive) comes on season start (sellout model), finalize and
  abandon, all as `(1, totalMinted)`, and on each reward push batch as `(min paid id, max paid id)`.
- Who may ask Pet721 to emit: the vault (via its locked `vaultRef`), the owner, and addresses the
  owner registers with `setPassSignaler`. The deploy registers the distributor. This authority is
  emit-only: a signaler moves nothing.
- The signal calls are try/catch: a failed signal can never revert a care or a settlement (pinned
  in `WalletPass.t.sol`).
- Gas: **+4,055 per care** (hatch 338,549 to 342,604; repeat care 134,189 to 138,244, isolated
  transactions) and +1,231 per mint. That is about 0.00000004 ETH per care at 0.01 gwei, paid by
  the Alchemy policy.
- Death is passive (a timer lapsing, no transaction), so no event marks it. The pass's relative
  countdown already shows it, and the next state change or push catches it.

What the manifest does (`server/src/runner/wallet-pass-routes.ts`). WALLETCHI runs the **gated
configuration**, with pass action links in the **capability configuration**:

- `GET <passURI>` with no proof returns **401** `{"error":"proof_required","configuration":"gated",...}`
  and **no acquisition URL**. passURI is a public view, and the pkpass download and action links
  are capability URLs, which a public manifest would publish.
- Proof of control, either of two ways:
  - The draft's interoperable path, the same as the reference server: `GET <passURI>/challenge?address=<owner>`
    returns an ERC-4361 message. Its resources are the CAIP-19 token first, then
    `urn:wallet-pass:action:acquire`, plus a single-use nonce, an expiry, and the domain line.
    Sign it and resend with `X-Wallet-Pass-Proof` (the message, base64url) and
    `X-Wallet-Pass-Signature`.
  - The site's path: a Privy access token (`Authorization: Bearer`).
  - Both end in a fresh `ownerOf` read that fails closed.
- A proven owner gets **200** `{"formats":{"apple":<capability .pkpass URL>,"google":<save link>},"updatedAt":<unix s>}`
  with `Cache-Control: no-store`. A proven owner who is not the owner of record (a sale) triggers
  a **rotation** before any URL is minted. That kills the seller's pass download and action links.
- The optional `wallet_pass` mirror in `tokenURI` is **not** served: tokenURI is public, so it
  would leak the capability URLs.

Fresh-read MUST (fixed in this pass). Every state-changing, pass-reachable request reads `ownerOf`
at request time, and on failure retries once (250 ms), then refuses with a retryable 503
(`ownership_unavailable`, `Retry-After: 5`). It never falls back to the last-known-good owner.
This covers:

- the pass-tap care POST (`careOwnerGuard` fresh);
- the signed-in session install and revoke, pass-link issue, and the owner-requested link
  rotation (`authedOwnerFor`);
- the email claim, which used to let the DB record stand;
- ERC-4361 challenge verification.

Read-only views keep the cache. The deployment notes in the ERC assets say the opposite ("falls
back to the last successful read"), so SpecSmith has been told to update them.

Rotation on request (capability configuration MUST: acquisition URLs and action links rotate on
the owner's request, the only remedy for a leaked link while the owner is unchanged).

- Route: `POST /api/pet/:tokenId/rotate-links` (`server/src/runner/me-routes.ts`), body
  `{ privyToken }`. Same auth as the care-session install: verified Privy session whose wallet set
  contains the CURRENT on-chain owner from a fresh `ownerOf` read that fails closed. Answers 401 no
  session, 403 not the owner, 404 unknown pet, 409 memorial, 429 when the pet's links were reset
  inside the last 10 minutes (`Retry-After` set), 503 retryable when the chain is down.
- What it does: the claim rotation (`rotateRunnerAuth`) with the owner unchanged. The old pass
  secret dies, so the previous `.pkpass` capability URL 404s and every care link signed by it
  stops verifying. The old Apple token can no longer register a device; a refresh with it serves a
  LINKS RESET keepsake (old token inside, no live links) and can still deregister. APNs and the
  Google object PATCH fire through `pushRunnerPass`, then the Google save URL is re-minted from
  the rotated links. Owner of record, email and the installed care session are untouched. A proven
  owner who is not yet the owner of record is rotated as a claim instead (record rebound).
- Response: `{ ok, rotated, applePassUrl, googleSaveUrl? }`, the pass-link shape. Log line:
  `pass links rotated on owner request`.
- Where the button lives: the account page (`/me`, `web-cub/src/components/MyPets.tsx`), a
  ghost "Reset my pass links" action under each living pet's Add-to-wallet row. It confirms first
  ("If a link on your card leaked, this kills every old link and re-sends the card."), then shows
  "Links reset. Your card will update in a moment." and the fresh Apple / Google buttons. The card
  already on the keeper's own phone becomes the keepsake too, so they re-add from those buttons.
- Check: `npm run rotate-links:check` in `server/` (real handlers, in-memory store + MockChain,
  fake Privy directory and a recording Google client through the test seams).

"Gift this pet" (an owner hands a living pet to another person; branch `gift-pet`).

- Why it needs its own path: holders have embedded wallets with no external transfer UI and no
  ETH, so the only way a pet moves is a gas-sponsored user operation from the owner's EIP-7702
  smart account calling `Pet721.transferFrom(owner, recipient, tokenId)`. The one-tap care
  session key can never be the signer: its on-chain scope is `care()` on the vault and nothing
  else, so the gift is a separate, deliberate OWNER signature. `transferFrom` and not
  `safeTransferFrom`: the recipient is always a Privy embedded EOA address, so no receiver hook is
  needed; a recipient already delegated to SemiModularAccount7702 would pass `onERC721Received`
  too (the v2 account implements it), but the plain transfer removes that dependency.
- Route: `POST /api/pet/:tokenId/gift/prepare` (`server/src/runner/me-routes.ts`), body
  `{ privyToken, recipient }`. Same auth as rotate-links (verified Privy session whose wallet set
  contains the CURRENT on-chain owner from a fresh `ownerOf` read that fails closed). `recipient`
  is the email the recipient signs in with (resolved through Privy's directory to their EMBEDDED
  wallet; they must have signed in once) or a `0x` address. Answers 401 no session, 403 not the
  owner, 404 unknown pet, 409 memorial, 400 `self_gift` (any wallet of the session, or the pet's
  own account), 400 `recipient_unknown` (no embedded wallet for that email), 400 `bad_recipient`,
  503 when the directory or the token contract is unavailable, 429 per IP. On success it records
  a 15-minute INTENT `(tokenId, from, to)` in process and returns `{ intentId, from, to,
  recipientEmail?, call: { to: <Pet721>, data: transferFrom(...) }, expiresAt, claimUrl }`. Log
  line: `gift prepared`.
- Webhook rule (`server/src/runner/gas-sponsor.ts`): a `transferFrom` or 3-argument
  `safeTransferFrom` on the configured Pet721 is approved ONLY when the op's sender is the pet's
  current owner (on-chain read, fail closed), `from` equals the sender, `(tokenId, from, to)` is a
  live prepared intent, and at most 2 approvals per pet per hour (the gift plus one retry). Every
  other call on the token (approve, setApprovalForAll, the 4-argument safeTransferFrom, a
  recipient the server never heard of) stays denied, and denials never count against the window.
  Log line: `gas sponsorship webhook: approve` with `kind: "gift"`. The Alchemy policy's allowlist,
  if it uses one, must also carry Pet721 `transferFrom(address,address,uint256)` or the op is
  refused before the webhook is asked.
- Landing (`server/src/runner/gift.ts`): the status read `GET /api/pet/:tokenId/gift/:intentId`
  and a background watcher (every 4 s until the intent lands or expires) settle the intent against
  a fresh `ownerOf`. The moment the recipient is the owner, the seller's one-tap care session is
  revoked (`pet gifted on-chain`, the same revoke the pass-tap path does on a detected sale). Log
  line: `gift landed: seller's care session revoked, pass rotates on the recipient's first claim`.
  Everything after that is the EXISTING transfer machinery: the recipient's first claim (pass-link
  on /me, rotate-links, the gated manifest, or /claim) rotates the pass secret, rebinds the owner
  of record, unbinds the seller's email, and pushes the seller's card into the TRANSFERRED
  keepsake; `PassUpdate(tokenId)` comes from `Pet721._update` on the transfer itself.
- Where the button lives: the account page (`/me`, `web-cub/src/components/MyPets.tsx`), a ghost
  "Gift this pet" action under each living pet, below "Reset my pass links". Steps: who gets it
  (email or address) -> the den resolves them -> confirm ("The pet, its wallet pass and its CARE
  account all go with it... Your card becomes a keepsake the moment they claim, and the new owner
  claims the pass at www.playwalletchi.com/claim. You sign once; there is no gas to pay.") -> one
  owner signature (`lib/aa.ts sponsoredGift`, the embedded signer from `PrivyGate.getOwnerSigner`)
  -> the card becomes the hand-off note with the recipient's next step and the explorer link. A
  recipient who signs in with email finds the pet on /me (the by-owner list reads the chain) and
  "Add to wallet" is their claim; the /claim page now says so.
- Check: `npm run gift-pet:check` in `server/` (58 checks: prepare refusals, the calldata, every
  webhook deny, the hourly window, landing + revoke, the recipient's first-claim rotation and the
  seller's keepsake, the background watcher).

## 3. Capacity

Measured, not assumed. Gas price on 46630 is 0.01 gwei (`cast gas-price`, every season-2
receipt).

| Cost path | Signer | Gas | 60 days, 1,000 pets |
|---|---|---|---|
| Deploy (26 txs) + `lockValidator` | deployer/relayer | ~19.5 M (fork rehearsal) | ~0.0002 ETH |
| `issuePet` (mint + TBA + spender init + starter + register, ONE tx) | relayer | 361k to 464k live, 454k cold on the fork | ~0.0045 ETH |
| Hatch care, EIP-7702 delegation, session grant, every care | **Alchemy Gas Manager** | n/a | see 3.1 |
| 2h `pushRewards` | relayer | ~34.5k per pet (forge: 200 pets = 6.91 M) | worst case ~0.29 ETH (every pet bot-pushed every epoch; `notifyCare` auto-pushes inside keepers' own cares, so the real figure is lower) |
| Drip: MockUSDG mint + `distribute()` + rate re-affirm, every 2h | relayer | ~60k + ~118k (measured) + ~35k | ~0.0015 ETH |
| `postRound` twice a day | poster | ~119k (measured, 16 past rounds) | < 0.0002 ETH |
| Holder deliveries, ~1,000 per round, twice a day | poster (`HOLDER_CLAIM_SIGNER=poster`) | ~85k each (**estimated**: no claim has ever landed on this chain) | **~0.1 ETH** |
| `sweepForfeited`, `finalize`, `pushPrize`, residual sweep | relayer | small | < 0.01 ETH |

**Balances read 2026-09-22: relayer 0x5a97eF885F4369b52dbb23E7cA2FDAe05fB62e6F holds 0.0241 ETH,
poster 0xf7481a5b3541B7DbFaa362c38fa19ECb13cc4134 holds 0.01 ETH.** Hunt reports the relayer as
funded, but 0.0241 ETH is only just above the old 0.02 floor and below the new 0.05 one. **Top the
relayer up to 0.5 ETH and the poster to 0.2 ETH** before the deploy. `RELAYER_LOW_BALANCE_ETH=0.05`
stays. The same floor alarms on the poster in the heartbeat.

### 3.1 Alchemy Gas Manager policy (main session, after contracts deploy: it needs the new vault address)

Season 1 died on the per-spender count cap (`-32602 Policy's max count per spender exceeded`).
The main session creates a **FRESH** policy with the access key it holds. A fresh policy zeroes
every returning wallet's counter, which is the proven path (2026-08-31). Exact limits:

| Setting | Value | Why |
|---|---|---|
| Network | Robinhood testnet (46630) | |
| Max count per sender | **1,500** | 1 bootstrap/hatch + up to 20 cares a day (the on-chain cap) x 60 days = 1,201, plus headroom |
| Global max count | **1,500,000** (or unlimited) | worst case 1,000 x 20 x 60 = 1.2 M; typical ~300k |
| Max spend per sender / global max spend | unlimited (testnet) | spend caps are the season-1 failure class; sponsorship is free on testnet |
| Policy end / sponsorship expiry | **deploy date + 75 days** | 60 days of minting, then the finale |
| Allowlist (if the policy uses one) | the NEW PetVault: `care(uint256,uint8)` and the pinned `setCarer(tokenId, 0x0, 0)` bootstrap | the only two shapes the game sponsors |

Then swap `GAS_POLICY_ID` (Render) and `NEXT_PUBLIC_GAS_POLICY_ID` (Vercel), and run the gate:

```bash
cd server
ALCHEMY_API_KEY=<app key> GAS_POLICY_ID=<policy id> \
PETVAULT=0x11a2d10ee8e15ba5193e6e231a825541cb216f38 TOKEN_ID=<a minted pet> PROBE_WALLET=<that pet's owner> \
node scripts/probe-policy-cap.mjs
```

The verdict must not be `PER-SENDER CAP HIT`. The probe used to hardcode the season-1 vault and
token 2, so against any later season its verdict was meaningless. It also counted every
"Sponsorship failed" as a cap hit, including a denial by the sponsorship webhook, which is a
different gate (the webhook refuses shapes and owners it does not recognise). It now reads the
vault, token and wallet from env and tells the three outcomes apart.

### 3.2 Other third-party ceilings to check before announcing (not verified here)

- **Resend**: every mint sends a receipt email. Check the plan's daily and monthly send limits
  against a 1,000-mint launch.
- **Privy**: check the plan's monthly-active-user limit against 1,000 keepers.
- **RPC read volume**: each 2h push cycle reads up to pets x `REWARDS_PUSH_EPOCH_WINDOW` x 3
  view calls. With `REWARDS_PUSH_EPOCH_WINDOW=4` that is 12k per cycle at full supply. Active pets
  auto-collect a full life window inside their own cares, so 4 epochs (8h of outage tolerance) is
  enough; widen it for one cycle after a longer outage.
- **Push cycle length**: the holder leg runs inside the 2h push cycle and waits on each delivery.
  With the poster carrying ~1,000 deliveries at ~4s each, the cycle after a round runs about an
  hour. The engine skips a tick that would overlap, so nothing double-sends. The only cost is
  that one tick's settlement tail waits.

## 4. Steps

### 4.1 Local rehearsal (runs: this agent or anyone; Hunt's go: **no**, local fork only)

```bash
cd contracts
bash script/showcase-rehearse.sh
```

It deploys with `showcase.env` on an anvil fork of 46630 (running as chain 31337, so forge
never overwrites `broadcast/.../46630/run-latest.json`), locks the validator, runs
VerifyWalletchiWiring (which also checks `0xef5f1e71`, the pass base composition, and the passURI
round trip), mints one pet, and checks `passURI(1)`. It must end with `SHOWCASE REHEARSAL PASSED`.
Passed 2026-09-22.

`REHEARSE_E2E=1 bash script/showcase-rehearse.sh` also runs the real server against a fork
reporting 46630, with forge's broadcast and cache redirected to a temp folder so the live record
is safe. The server mints through the checkout and the pet is transferred on chain.
`passURI(id)` is then read on chain and fetched: 401 without a proof. The acquire challenge is
signed, the manifest returns 200, and `formats.apple` downloads a `.pkpass`
(`application/vnd.apple.pkpass`, zip). Passed 2026-09-22 (15/15).

### 4.2 Fund the keys (Hunt's go: **yes**)

Top up on Robinhood testnet: relayer `0x5a97eF885F4369b52dbb23E7cA2FDAe05fB62e6F` to 0.5 ETH,
poster `0xf7481a5b3541B7DbFaa362c38fa19ECb13cc4134` to 0.2 ETH. Confirm each with
`cast balance <addr> --rpc-url https://rpc.testnet.chain.robinhood.com -e`.

### 4.3 Deploy (Hunt's go: **yes**)

```bash
cd contracts
set -a; . script/showcase.env; set +a
export PRIVATE_KEY=<deployer/relayer key for 0x5a97...2e6F>
export POSTER=0xf7481a5b3541B7DbFaa362c38fa19ECb13cc4134
# PASS_BASE_URI comes from showcase.env; it must equal the API's PUBLIC_BASE_URL + /wallet-pass/
forge script script/DeployWalletchi.s.sol \
  --rpc-url https://rpc.testnet.chain.robinhood.com --broadcast --slow \
  --gas-estimate-multiplier 250
```

**`--gas-estimate-multiplier 250` is REQUIRED on Robinhood Chain.** It is an Arbitrum Orbit chain,
where a transaction's gas also pays for its L1 data (the L1 gas component). Forge's per-transaction
estimate did not cover that component, so the first live deploy (2026-09-23) failed with
`setSecurityLevel` out of gas at exactly its limit. The default multiplier (130) leaves no room for
the L1 component; 250 did. The extra limit is not spent (only gas used is charged), so it costs
nothing at 0.01 gwei.

It must print `ALL LOCKS ENGAGED`. Record every address from the report, and the deploy block
(the first receipt's `blockNumber` in `broadcast/DeployWalletchi.s.sol/46630/run-latest.json`)
as `FEE_SNAPSHOT_FROM_BLOCK`.

Then freeze the validator (VerifyWalletchiWiring requires it; permissive forever is fine on
testnet):

```bash
cast send <Pet721> "lockValidator()" --private-key $PRIVATE_KEY \
  --rpc-url https://rpc.testnet.chain.robinhood.com
```

### 4.4 Verify wiring (Hunt's go: **no**, read-only)

```bash
PET=<Pet721> ISSUER=<PetIssuer> VAULT=<PetVault> VALIDATOR=<validator> CARE_TOKEN=<MockCareToken> \
ROYALTY_RECIPIENT=0x5a97eF885F4369b52dbb23E7cA2FDAe05fB62e6F \
ACCOUNT_IMPL=0xb73E98C4262d61C8Fbe6F60b2ea43B2621b4090D \
DIST=<CareRewardsDistributor> HOLDER_VAULT=<HolderMerkleVault> SPLITTER=<CareFeeSplitter> \
FEE_TOKEN=<MockUSDG> RELAYER=0x5a97eF885F4369b52dbb23E7cA2FDAe05fB62e6F \
POSTER=0xf7481a5b3541B7DbFaa362c38fa19ECb13cc4134 \
PASS_BASE_URI=https://api.playwalletchi.com/wallet-pass/ \
forge script script/VerifyWalletchiWiring.s.sol --rpc-url https://rpc.testnet.chain.robinhood.com
```

It also prints `wallet pass: 0xef5f1e71 advertised, passBaseURI: ...`, and it fails if the pass
base is empty or differs from the PASS_BASE_URI composition, if passURI does not revert for an
unminted id, or if the distributor is not a pass signaler. Re-run it after Hunt's mint No. 1 so
the passURI(1) round trip runs too.

It must print `ALL CHECKS PASSED`. Also confirm the model and the drip preconditions:

```bash
cast call <PetVault> "selloutStartsSeason()(bool)"   # false
cast call <PetVault> "entryDeadline()(uint256)"      # deploy time + 5184000
cast call <Pet721>   "maxSupply()(uint256)"          # 1000
cast call <CareFeeSplitter> "owner()(address)"       # 0x5a97...2e6F (the relayer: the rate re-affirm needs this)
cast call <Pet721>   "supportsInterface(bytes4)(bool)" 0xef5f1e71   # true
cast call <Pet721>   "passBaseURI()(string)"         # https://api.playwalletchi.com/wallet-pass/eip155/46630/<pet lowercase>/
cast call <Pet721>   "isPassSignaler(address)(bool)" <CareRewardsDistributor>   # true
```

### 4.5 Alchemy policy (runs: **main session**, after 4.4, needs the new vault address; Hunt's go: **yes**)

Create the fresh policy with the limits in 3.1. Live policy: **`<policy id>`**
(1,500 per sender, 1.5M total, spend unlimited, ends at +75 days, same webhook).

### 4.6 Regenerate ABIs if contracts changed (Hunt's go: **no**)

**The ABIs DID change for this deploy.** The Wallet Pass Extension added `passURI`, `passBaseURI`,
`setPassBaseURI`, `setPassSignaler`, `isPassSignaler`, `signalPassUpdate`, `signalBatchPassUpdate`,
the `PassUpdate` / `BatchPassUpdate` / `PassBaseURISet` / `PassSignalerSet` events and two errors to
Pet721. `contracts/abi/Pet721.json` was regenerated from `out/` in `1b0ee1d` (additive only).
PetVault's and CareRewardsDistributor's external ABIs are unchanged: their pass signals are
internal functions.

The rule stands for any future change: the server loads `contracts/abi/*.json`, not `out/`, so
regenerate the committed artifact whenever a contract's external surface changes. The server's
showcase and wallet-pass reads use inline ABIs, so they work even on the hand-written fallbacks.

### 4.7 Render env, API service `srv-d9jrhp0u01pc73cgkvdg` (Hunt's go: **yes**)

The build runs `prisma migrate deploy`, which adds the `ShowcaseDrip` table
(`20260922120000_showcase_drip`, additive).

| Var | New value |
|---|---|
| `RUNNER_ISSUER_ADDRESS` | new PetIssuer |
| `PET721_ADDRESS` (and `RUNNER_721_ADDRESS` if set) | new Pet721 |
| `PETVAULT_ADDRESS` | new PetVault |
| `CARE_TOKEN_ADDRESS` | new MockCareToken |
| `REWARDS_DISTRIBUTOR_ADDRESS` | new CareRewardsDistributor |
| `FEE_SPLITTER_ADDRESS` | new CareFeeSplitter |
| `HOLDER_VAULT_ADDRESS` | new HolderMerkleVault |
| `FEE_TOKEN_ADDRESS` | new MockUSDG |
| `FEE_SNAPSHOT_FROM_BLOCK` | the deploy block |
| `RUNNER_SUPPLY_CAP` | **1000** (was 5. A stale 5 refuses mint No. 6 as "sold out"; the server logs an error when this disagrees with the chain) |
| `CARE_SESSION_TTL_HOURS` | 720 |
| `REWARDS_PUSH_EPOCH_WINDOW` | 4 |
| `RELAYER_LOW_BALANCE_ETH` | 0.05 |
| `SHOWCASE_USDG_DRIP` | **true** |
| `SHOWCASE_USDG_DRIP_AMOUNT` | 100 |
| `TAX_DISTRIBUTION_MINUTES` | 720 |
| `HOLDER_CLAIM_SIGNER` | poster |
| `HOLDER_EXCLUDE_ADDRESSES` | keep the current value; if empty set `0x000000000000000000000000000000000000dEaD` (testnet has no DEX pool; empty only logs a boot error) |
| `GAS_POLICY_ID` | the new policy id from 4.5 |
| `TESTER_ALLOWLIST` | **delete** (it bypasses one-per-email; a public showcase has no testers) |

Keep: `ANTI_SYBIL_ENABLED=true`, `SURVIVAL_ENABLED=true`, `DEMO_BYPASS_PAYMENT=true`,
`HOLDER_POSTER_PRIVATE_KEY`, `RELAYER_PRIVATE_KEY`, `SYBIL_PEPPER`, `CARE_SESSION_SECRET`,
`CARE_LINK_SECRET`.

### 4.8 Vercel env, web-cub (Hunt's go: **yes**)

`NEXT_PUBLIC_PETVAULT_ADDRESS`, `NEXT_PUBLIC_PET721_ADDRESS`, `NEXT_PUBLIC_CARE_TOKEN_ADDRESS`,
`NEXT_PUBLIC_FEE_TOKEN_ADDRESS`, `NEXT_PUBLIC_GAS_POLICY_ID`. These are only the fallback (the
site reads `/api/chain-config` at runtime), but a stale bundle is how 2026-08-26 broke a real
first feed, so rebuild and verify the bundle.

### 4.9 Wipe the season DB (Hunt's go: **yes**; approved in principle, irreversible)

**As a Render job, not locally.** The production database's IP allowlist blocks external
connections, so a run from this machine cannot reach it. Run it as a one-off job on the API
service, which is inside the allowlist and already has `DATABASE_URL`:

```bash
cd server
RESET_CONFIRM_DB=<database name in DATABASE_URL> npx tsx scripts/reset-season-data.ts --sybil
```

It wipes Runner (plus cascades), CheckoutSession, MintedEmail, MintedPrivyUser, MintSignal, and
now also HolderRewardRound + HolderRewardLeaf. Those are the old holder vault's proofs: the new
vault restarts round ids at 0, so leftover rows would make the push engine try to deliver a dead
season's airdrop. It does not touch the PUNCHCARD tables or the ShowcaseDrip ledger (keyed per
fee token, so a new MockUSDG starts clean).

### 4.10 Redeploy API + site, clear the ack (Hunt's go: **yes**)

Redeploy Render after the env change, and Vercel after its env change. Then clear the heartbeat
ack so a real season end alarms again:

```bash
gh variable delete SEASON_END_ACK --repo Halldon-Inc/punchcard
```

## 5. Post-deploy verification (Hunt's go: **no** for 1 to 8; step 9 is Hunt)

0. **Wallet pass conformance, live.** After mint No. 1: `cast call <Pet721> "passURI(uint256)(string)" 1`
   returns `https://api.playwalletchi.com/wallet-pass/eip155/46630/<pet>/1`. `curl -i` on that URL
   returns 401 `proof_required` with no `.pkpass` in the body. `curl <that URL>/challenge?address=<Hunt's wallet>`
   returns an ERC-4361 message whose first resource is `eip155:46630/erc721:<Pet721>/1`.
1. `GET https://api.playwalletchi.com/api/chain-config` names the NEW vault and pet721, and
   `season.selloutStartsSeason` is false, `season.entryOpen` true, `season.maxSupply` 1000,
   `season.entryDeadline` = deploy time + 5184000, and `season.seasonStart` = the deploy time.
2. `GET /api/season/stats`: `cubsTotal` 1000, `registered` 0, `seasonActive` true.
3. Render logs show NO "RUNNER_SUPPLY_CAP does not match the collection's on-chain maxSupply"
   and NO "Refusing to boot".
4. `/internal/status` (bearer INTERNAL_STATUS_TOKEN): relayer about 0.5 ETH and poster about
   0.2 ETH, both `low` false.
5. `probe-policy-cap.mjs` against the new policy, the new vault and a minted pet (env as in 3.1):
   the verdict is not `PER-SENDER CAP HIT`.
6. Within 2h of boot the logs show "showcase drip: simulated trading fees minted into the
   splitter" then "showcase fee leg: splitter distributed". On chain, the holder vault's MockUSDG
   balance and the distributor's CARE balance both rose.
7. Within 12h a holder round posts ("holder airdrop round posted", or `holderRounds.roundsPosted`
   > 0 on /internal/status), and the next push cycle logs "holder push: airdrops delivered
   without anyone asking". Those delivery txs are signed by the poster address, not the relayer.
8. The site bundle carries the new vault address (the fallback), and the heartbeat workflow run
   after deploy is green.
9. **Hunt mints No. 1 on his phone and confirms the pass lands, updates, and a pass-tap care
   works.** Positive checks, not an absence of errors: receipt email arrives, the pass is in
   Wallet, the pet is HATCHED (need meters counting down, not an egg), an active care-session
   row exists for tokenId 1, and one pass tap moves a need meter and the TBA CARE balance
   drops by 1.

## 6. After launch

- Watch both balances. The heartbeat alarms at 0.05 ETH for the relayer and the poster.
- Starter drain: if keepers run dry, raise `issuer.setStarterAmount` for new mints, or mint
  mock CARE to a TBA directly.
- Before day 60: decide whether to close gracefully (finale) or deploy the next season.
- To tune the drip: change `SHOWCASE_USDG_DRIP_AMOUNT` and redeploy the API; `false` stops it at
  the next cycle.
