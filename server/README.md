# WALLETCHI server

Node 20 + TypeScript + Express + Prisma (Postgres). The heart of WALLETCHI: the
pet mint relayer (Robinhood Chain), Apple Wallet passes (PKPass + full web
service protocol + APNs push), Google Wallet loyalty objects, HMAC-signed care
actions, the idle pet engine, the survival-season reflect layer, the
secondary-market claim flow, and the Resend receipt email.

Every external subsystem runs in a loud **stub mode** until its credentials are
present, so the whole thing builds, boots, and demos before certs land. Nothing
fakes success silently.

Live API: `https://api.playwalletchi.com` | Web app: `https://playwalletchi.com`

## Quickstart

```bash
npm install

# 1. Postgres (docker one-liner)
docker run --name punchcard-pg -e POSTGRES_PASSWORD=punchcard \
  -e POSTGRES_DB=punchcard -p 5432:5432 -d postgres:16
#    or use a Neon project (neon.tech) and paste its pooled connection string.

cp .env.example .env            # then edit DATABASE_URL if needed
npm run prisma:migrate          # creates tables

npm run dev                     # boots on :8080 in stub mode
```

The server **fails loudly and exits 1** if Postgres is unreachable. It never
falls back to SQLite or an in-memory store in production. Boot log prints the
stub-mode matrix.

Verify:

```bash
curl localhost:8080/health      # { status: ok, network, chainId, time }
npm run smoke                   # 200+ checks: mint -> egg -> hatch -> care -> season -> claim, Apple web service, anti-Sybil gate
```

## Scripts

| script | what |
| --- | --- |
| `npm run dev` | tsx watch, boots `src/index.ts` |
| `npm run build` | `prisma generate` + `tsc` to `dist/` |
| `npm start` | runs `dist/src/index.js` |
| `npm run smoke` | end to end smoke test (in-memory store + MockChain, no Postgres) |
| `npm run prisma:migrate` | dev migration |
| `npm run prisma:deploy` | apply migrations (prod / CI) |
| `npm run typecheck` | tsc noEmit |

## Environment

Full list with defaults is in `.env.example`. Highlights:

| var | default | notes |
| --- | --- | --- |
| `DATABASE_URL` | (required) | Postgres. No fallback. |
| `PORT` | 8080 | |
| `PUBLIC_BASE_URL` | http://localhost:8080 | this server's URL; used for pass `webServiceURL` + email links. Prod: `https://api.playwalletchi.com` |
| `WEB_APP_URL` | http://localhost:3000 | web app origin (CORS + email fallback links). Prod: `https://playwalletchi.com` |
| `ROBINHOOD_NETWORK` | testnet | `mainnet` (4663) or `testnet` (46630); RPC auto-selected |
| `RELAYER_PRIVATE_KEY` | | relayer wallet; **relayer stubs to MockChain without it** |
| `RUNNER_ISSUER_ADDRESS` | | PetIssuer contract; the relayer is live only when the key AND this are set |
| `PET721_ADDRESS` | | Pet721 v2 (ownership + soulbound reads for `/api/claim`); falls back to `RUNNER_721_ADDRESS` |
| `ABI_DIR` | auto `../contracts/abi` | committed ABI dir, auto-resolved; falls back to hand-written ABI if missing |
| `DEMO_BYPASS_PAYMENT` | false | free-mint gate: the checkout only mints while true |
| `RUNNER_SUPPLY_CAP` | 2000 | pet supply for the season |
| `SURVIVAL_ENABLED` + `PETVAULT_ADDRESS` + `CARE_TOKEN_ADDRESS` | | survival economy; fail-secures public pass downloads even half-configured |
| `CRITICAL_WINDOW_HOURS` | 12 | fading window BEFORE the on-chain deadline (death is permanent once it passes) |
| `SETTLEMENT_FINALIZE_POKE` | true | poke the permissionless `finalize()` when `isOver()` flips true (contract re-verifies) |
| `ANTI_SYBIL_ENABLED` + `POW_*` + `MINTS_PER_*` + `SYBIL_PEPPER` | off | server-side mint risk gate (PoW, email dedup, velocity caps) |
| `CLAIM_NONCE_TTL_SECONDS` | 300 | wallet-proof claim nonce TTL |
| `OPENSEA_API_KEY` / `OPENSEA_CHAIN` | | marketplace metadata-refresh pings (no-op without the key) |
| `INTERNAL_STATUS_TOKEN` | (empty) | bearer for `/internal/status`; empty = route 404s |
| `TRUST_PROXY_HOPS` | 1 | Express `trust proxy` hop count behind Render |
| `PRIVY_APP_ID` / `PRIVY_APP_SECRET` | | checkout token verification; **bypassed with a warning if unset** |
| `PASS_CERT_P12_BASE64` / `PASS_CERT_PASSWORD` | | Apple pass signing cert; `PASS_STUB_MODE=true` forces unsigned |
| `PASS_TYPE_ID` | pass.com.walletchi.pet | |
| `APPLE_WWDR_PEM_BASE64` | | WWDR G4 intermediate cert (PEM, base64); see below |
| `GOOGLE_SA_KEY_BASE64` / `GOOGLE_ISSUER_ID` | | Google Wallet; **stubbed without them** |
| `RESEND_API_KEY` / `EMAIL_FROM` | | receipt email; **stubbed without the key** |

## Stub-mode matrix (what works without which credential)

| subsystem | live when | stub behaviour |
| --- | --- | --- |
| Relayer (pet mint / care / finalize) | `RELAYER_PRIVATE_KEY` + `RUNNER_ISSUER_ADDRESS` | MockChain: in-memory pets + last-pet-standing vault; real API shape, fake tx hashes |
| Survival season | above + `SURVIVAL_ENABLED` + `PETVAULT_ADDRESS` | seasonActive false; care is free; no life timers |
| Apple pass signing | `PASS_CERT_P12_BASE64` + `PASS_CERT_PASSWORD` (and not `PASS_STUB_MODE`) | emits a valid-structure **unsigned** `.pkpass` (not installable), header `X-Walletchi-Pass: unsigned-stub` |
| APNs push | same Apple cert | logs the intended push, sends nothing |
| Google Wallet | `GOOGLE_SA_KEY_BASE64` + `GOOGLE_ISSUER_ID` | class/object/patch skipped; save link omitted (`/google/runner/save/:serial` returns 501) |
| Email | `RESEND_API_KEY` | builds the HTML, logs it, does not send |
| Privy auth | `PRIVY_APP_ID` + `PRIVY_APP_SECRET` | checkout accepted without token verification (warning) |
| Anti-Sybil gate | `ANTI_SYBIL_ENABLED=true` | off: checkout behaves exactly as before the gate existed |

Everything else (mint state machine, pass JSON, care actions + cooldowns, idle
engine, claim flow, Apple web service protocol) is fully real in every mode.

## HTTP endpoints

Public state endpoints are serial/tokenId-keyed and NEVER carry capability pass
URLs while real-value care is possible (`SURVIVAL_ENABLED` or the live vault).

- `GET /health` public liveness (status/network/chainId only, no mode matrix)
- `GET /internal/status` full readiness matrix; requires `Authorization: Bearer <INTERNAL_STATUS_TOKEN>` (404 when the env is empty)
- `GET /api/mint/challenge` anti-Sybil PoW challenge (`required:false` while the gate is off)
- `POST /api/runner/checkout` `{ email }` (or Privy token + walletAddress) free custodial mint, `DEMO_BYPASS_PAYMENT`-gated. Returns the status view + a one-shot `mintSession` token
- `GET /api/runner/checkout/:id` poll status (`minting` -> `ready` | `failed`)
- `POST /api/runner/pass-link` `{ id, mintSession }` exchange the mint-session token for the capability pass URLs
- `GET /api/runner/:serial` public pet state (needs, mood, life status; lazily reconciles idle ticks)
- `GET /api/runner/:serial/action/:action?s=<hmac>` care action (feed/water/play/toy/explore), HMAC-signed per pass
- `GET /api/runner/:serial/card.png` shareable card PNG (alive/memorial/victory)
- `GET /api/runner/:serial/portrait.png` square portrait for a minted pet
- `GET /api/pet/:tokenId/preview.png` public trait preview (works pre-mint; ids 1..supply cap)
- `GET /metadata/runner/:tokenId` ERC-721 metadata (image-only; live Status / Life Left / Care Count attributes)
- `GET /api/season/stats` survival snapshot `{ potDisplay, potRaw, cubsAlive, cubsTotal, careToken, seasonActive }` (60s server cache)
- `GET /api/season/board` the one-call Arena payload (survivors, pot, recent deaths, top keepers)
- `GET /api/claim/nonce` + `POST /api/claim` secondary-market claim: wallet personal_sign proof (rotates the pass authToken) or email re-delivery
- `GET /api/pets/by-owner?address=0x..` pets an address owns (on-chain ownerOf through a 60s cache)
- `POST /api/pet/care` + `POST /api/pet/pass-link` Privy-authenticated on-site care / add-to-wallet
- `GET /runner-passes/:serial/:cap.pkpass` capability pass download (cap = HMAC of the pet's authToken)
- `GET /runner-passes/:serial.pkpass` LEGACY public download; 404 whenever real-value care is possible
- `GET /google/runner/save/:serial` Google Wallet save redirect; same fail-secure 404 gate as the legacy Apple route
- `GET /assets/logo.png` hosted square brand logo (the Google loyalty-class programLogo; must stay a live 200)
- Apple Wallet Web Service mounted at `/runner-apple/v1` (passes carry `webServiceURL <PUBLIC_BASE_URL>/runner-apple`)

### Apple Wallet Web Service URLs

Passes carry `webServiceURL = <PUBLIC_BASE_URL>/runner-apple` and Apple appends
`/v1/...`. The implemented routes:

- `POST   /runner-apple/v1/devices/:deviceLibraryId/registrations/:passTypeId/:serial`
- `DELETE /runner-apple/v1/devices/:deviceLibraryId/registrations/:passTypeId/:serial`
- `GET    /runner-apple/v1/devices/:deviceLibraryId/registrations/:passTypeId?passesUpdatedSince=`
- `GET    /runner-apple/v1/passes/:passTypeId/:serial`
- `POST   /runner-apple/v1/log`

Auth on the per-pass routes is `Authorization: ApplePass <runner.authToken>`.
After a secondary-market claim rotates the token, the PREVIOUS token still
refreshes into a "transferred" keepsake (and can unregister) but can never
register new devices.

### Apple WWDR G4 certificate

Pass signing needs Apple's WWDR intermediate (G4). Fetch and encode:

```bash
curl -o wwdr.cer https://www.apple.com/certificateauthority/AppleWWDRCAG4.cer
openssl x509 -inform der -in wwdr.cer -out wwdr.pem
base64 -w0 wwdr.pem            # paste into APPLE_WWDR_PEM_BASE64
```

Encode the pass cert `.p12` the same way for `PASS_CERT_P12_BASE64`
(`base64 -w0 pass.p12`). Never commit either file.

## Chain integration notes

- The relayer mints via the PetIssuer: `issuePet(address to) returns (uint256
  tokenId, address account)` (auto-detected; the retired SALMON `issueRunner`
  shape still works against an old issuer). tokenId + TBA come from the
  `PetIssued` event, with 721 `Transfer` and `accountOf` fallbacks.
- Survival economy (PetVault, LAST PET STANDING): `care(tokenId, actionType)`
  pulls the care cost from the pet's own TBA (pot/burn/rewards split) and
  resets its life timer. A pet is DEAD the instant `lastCareAt + lifeTtl`
  passes: pure clock, permanent, no reap step and no revive. The last pet
  standing wins the whole pot via the permissionless `finalize()` (gated by
  `isOver()`; the contract re-verifies, so the server's poke never steers the
  outcome). Reads: `petState`, `memorialState`, `pot`/`registeredCount`/
  `hatchedCount`, `settlementState`, `isOver`. The "N alive" scoreboard is
  computed OFF-CHAIN from timers (display-only; the contract keeps no
  headcount).
- Pet721 v2: `ownerOf` (authoritative current owner for claims + the care
  guard) and `isDead` (time-based soulbound memorial).
- The committed ABI (`../contracts/abi/*.json`) is the default `ABI_DIR`;
  `src/chain/abi.ts` mirrors the used surface as a fallback.
- All relayer writes go through a single worker queue (`SerialQueue`, bounded
  depth) so the relayer nonce is never reused concurrently.

## Architecture

```
src/
  config.ts          env + stub-mode derivation
  app.ts             express app factory (used by prod AND smoke) + global rate limit
  index.ts           prod bootstrap (Prisma + live relayer + engines)
  context.ts         AppContext { store, relayer }
  store/             Store interface + PrismaStore (prod) + InMemoryStore (smoke)
  chain/             Chain interface, RobinhoodChain (viem), MockChain,
                     SerialQueue, Relayer, ABIs
  passes/            Apple pkpass build/sign, APNs, cert extract
  runner/            WALLETCHI: routes, pet renderer, pass, care actions, idle
                     engine, season/settlement/drama, claim, anti-Sybil, email
  routes/            health + internal status
  services/          privy
scripts/smoke.ts     end to end smoke test
prisma/              schema + migrations
```

The smoke test and production share `createApp` and every service and route.
The only swap is the Store (Prisma vs in-memory) and the Chain (viem vs mock),
so what the smoke test exercises is the real code path.
