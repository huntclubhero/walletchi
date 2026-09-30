# WALLETCHI Mainnet Launch Runbook | 2026-07-27 (deploy steps updated 2026-08-10; creator-fee inlet + swap adapter added 2026-08-23)

READ FIRST IF YOU ARE LAUNCHING THE TOKEN: **STEP 6C**. Earlier versions of this runbook and of
contracts/script/DeployWalletchi.s.sol instructed pointing the launchpad creator-fee seat at the
CareFeeSplitter. That instruction was WRONG and it is a ONE-WAY mistake: the splitter can call
neither hook.claim nor hook.updateCreator, so following it destroys the entire trade-tax revenue
stream permanently. Step 6C is the corrected sequence.

TWO MORE THINGS IN STEP 6C THAT WILL COST YOU THE WHOLE REVENUE STREAM IF SKIPPED (verified against
the deployed hook bytecode on 2026-08-23):
  1. **THE POOL MUST BE USDG-QUOTED.** 84 of 84 observed launches on this launchpad quoted in NATIVE
     ETH. On an ETH-quoted pool the fee is paid as native value, our ERC-20 forward moves nothing,
     and CareFeeSplitter cannot receive it at all. Unfixable without relaunching. Check the launch
     receipt's poolConfigs read BEFORE configuring anything else.
  2. **THE IRREVERSIBLE updateCreator CALL IS AVOIDABLE.** The factory requires
     params.creator == msg.sender, so LAUNCHING FROM THE COLLECTOR makes the collector the creator
     from block zero and updateCreator is never called at all. Options A / B / C are in step 6C.
Also in 6C: how to dress-rehearse the entire path on mainnet for about 0.0005 ETH before launch day.

Push-button launch sequence. Every env var below is a REAL name verified against
contracts/script/DeployWalletchi.s.sol and server/src/config.ts. Robinhood Chain
MAINNET = chainId 4663, RPC https://rpc.mainnet.chain.robinhood.com, Blockscout
explorer. House rule: no em dashes / "--" anywhere.

PRE-MAINNET SELF-AUDIT FIX BATCH (2026-08-10, 3 commits on origin/main through
267ee4b, 288 forge tests pass): the deploy path is now HARDENED and several steps
below changed. What is new, at a glance:
- CRITICAL fixed: the deploy now REQUIRES a real, code-bearing ACCOUNT_IMPL on
  mainnet (the old default has no code on chainId 4663 = would have bricked the
  launch: free care, stuck pot). You MUST deploy a fresh WalletchiAccount (step 2a).
- Ownership is now Ownable2Step (recoverable): deploy with a hot deployer, then
  hand off to a multisig via FINAL_OWNER (2-step: the multisig must acceptOwnership,
  step 3C). A mistyped handoff is no longer a permanent brick.
- The operator winner-bias is FIXED ON-CHAIN (trustless), not an operational
  promise: mainnet REQUIRES CARE_WINDOW_SECS>0 and the deploy auto-lockConfig()s the
  vault so the care deadline is immutable. Step 8B is now a verification, not a
  manual mitigation.
- New read-only VerifyWalletchiWiring.s.sol asserts the whole wiring+lock+trustless
  checklist in one run (step 3B): make it green before opening the season.

STATUS GATE (all met): Pet721 v2 = 3/3 auditors GO (frozen src 5349ed9); WS2
claim + pass-URL confused-deputy fix + Google PII fix = built, mini-audit GO.
**ENTIRE FLOW PROVEN LIVE ON TESTNET (2026-07-27, a Pons-token-mirror season, see
TEST-SEASON.md):** mint via email+PoW -> on-chain pet + 6551 TBA seeded -> real
signed Apple pass + Google save URL; care = exact 90/10 burn/pot (vault balances
== accounting to the wei); fee-on-transfer safe (5% tax on, splits on received);
permissionless reap by a non-admin; settle paid the full pot into the winner TBA.
All 5 contracts VERIFIED on Blockscout. Money-endpoint auth boundaries all hold.
Mainnet is THIS SAME SEQUENCE with fresh keys + the real Pons token. Blocked only
on Hunt's inputs (step 0).

--------------------------------------------------------------------------------
## STEP 0: what Hunt provides (the only blockers)
- PONS CARE token mainnet address (the ERC-20 care/burn token) + its DECIMALS.
- Mainnet ETH to fund the fresh TREASURY + RELAYER addresses (step 1).
- Render account (server hosting) + funding. Privy app (id + secret). Resend key
  + a verified send domain. Optional: Google Wallet issuer. THE HACKATHON NAME.

--------------------------------------------------------------------------------
## STEP 1: fresh mainnet keys (lead generates, Hunt funds)
Two operational keys. TREASURY is ALSO the deployer and the contract OWNER: the
access audit requires deployer==TREASURY so the deploy script auto-engages all
four one-way locks (otherwise the owner must hand-run ~8 wire+lock calls).
  cast wallet new    # x2: one TREASURY, one RELAYER (or `cast wallet new-mnemonic`)
Store the PRIVATE KEYS in a GITIGNORED file only (never commit): TREASURY key ->
deploy PRIVATE_KEY + initial owner; RELAYER key -> server RELAYER_PRIVATE_KEY.
Ownership is now Ownable2Step (audit batch 2): the deployer owns the contracts at
deploy so the locks auto-engage, then hands off to the real owner (a multisig) via
FINAL_OWNER (step 2/3C). Because handoff is 2-step (transferOwnership sets a PENDING
owner; the new owner must acceptOwnership), a mistyped FINAL_OWNER is recoverable,
not a permanent brick. The trustless care-window fix (step 8B) also removes the
close-timing centralization the old runbook disclosed. Hunt funds: TREASURY with
ETH for deploy + admin gas; RELAYER with ETH for ongoing care-relay gas. Surface
both ADDRESSES to Hunt for funding, plus the multisig address for FINAL_OWNER.

KEY CEREMONY (2026-08-03; do not skip on mainnet):
- Generate BOTH keys OFFLINE on a clean machine (`cast wallet new`), never in a
  shared terminal with history, never reuse the testnet key 0x5a97eF88... for
  anything mainnet.
- Privilege split: RELAYER = the ONLY key the server holds (Render env). It can
  mint via the locked issuer and call care()/reap(), and it pays gas; it can NOT
  move the pot, change config, or transfer ownership. TREASURY/owner key NEVER
  touches the server or Render: it lives offline (password manager + one
  offline copy), used only for deploy, closeSeason, and break-glass admin.
- Multisig check (launch day): if a Safe deployment exists on Robinhood Chain
  mainnet, put TREASURY ownership behind a 2-of-3 Safe (Hunt + lead + backup)
  AFTER deploy-time lock engagement. If no Safe exists yet (likely: young
  chain), the offline-EOA ceremony above is the fallback; revisit when the
  chain's tooling matures.
  RED-TEAM RATIONALE (2026-08-05 final pass, all 6 attacker goals CLOSED): the
  owner key is the ONLY standing recommendation. setRelayer is intentionally not
  lockable, so owner-compromise reduces to relayer-compromise: a stolen owner
  key can appoint a hostile relayer and force-care pets. Even then it CANNOT
  touch user TBA funds, the pot, or the rewards pool (all locked); the metered
  indirect surface is force-care -> pot/rewards/burn only, plus draining the
  operator's OWN starter float. This is why the owner key must be the highest-
  value custody item (multisig/cold); an optional timelock on setRelayer shrinks
  even that residual.
- Standby defender: `server/scripts/defender-standalone.ts` runs from ANY
  machine with just RPC_URL + PETVAULT_ADDRESS (watch-only without a key; armed
  with ANY funded key, claimPot/finalize are permissionless). During the
  challenge window, run one armed copy OUTSIDE Render (laptop or a second
  cloud) so a Render outage cannot cost the pot. The GitHub Actions heartbeat
  (.github/workflows/heartbeat.yml) alerts on API downtime.
- RELAYER gas watch: /internal/status relayerHealth.low flips at
  RELAYER_LOW_BALANCE_ETH (default 0.02); top up before it flips.
- JP ops ticket: verify Render Postgres (walletchi-db) automated backups are ON
  and restorable. Pass authTokens are unrecoverable secrets: losing the DB
  bricks every issued pass.

--------------------------------------------------------------------------------
## STEP 2A: deploy the account implementation (mainnet REQUIRED, audit CRITICAL)
The deploy reads ACCOUNT_IMPL (the ERC-6551 WalletchiAccount every pet TBA is cloned
from). Its default 0x0A7eF0f802FA7AE9618F1DF922cB55bd96665e66 has NO CODE on Robinhood
mainnet, so the deploy now HARD-REVERTS ("ACCOUNT_IMPL has no code on this chain" /
"ACCOUNT_IMPL != audited WalletchiAccount") rather than silently shipping pets whose
accounts do nothing (free care, stuck float/pot). Deploy a fresh one FROM THIS COMMIT
and pass its address:
  forge create src/WalletchiAccount.sol:WalletchiAccount \
    --private-key $TREASURY_KEY --rpc-url https://rpc.mainnet.chain.robinhood.com --broadcast
Record the deployed address -> that is ACCOUNT_IMPL in step 2. The deploy re-checks its
runtime codehash == keccak256(type(WalletchiAccount).runtimeCode) on mainnet, so a
drifted or wrong impl is rejected. (Testnet has code at the default, so this is
mainnet-only; setting ACCOUNT_IMPL explicitly is still the safe habit.)

--------------------------------------------------------------------------------
## STEP 2: deploy contracts (forge script, deployer==TREASURY)
From contracts/. Set env (deploy reads these exact names):
  PRIVATE_KEY           = TREASURY private key (deployer==owner so locks auto-engage)
  TREASURY              = TREASURY address (owner + royalty default)
  RELAYER               = RELAYER address (on-chain care()/reap caller)
  CARE_TOKEN_ADDRESS    = PONS token address. REQUIRED on mainnet: the deploy hard-requires a real,
                          code-bearing, 18-decimal ERC-20 here. address(0) tries to deploy a MockCareToken,
                          which now REVERTS on chainId 4663 (testnet-only); it is banned as mainnet currency.
  ACCOUNT_IMPL          = the WalletchiAccount address from step 2A. REQUIRED on mainnet (the default has no
                          code there and the deploy reverts). Verified by codehash against this commit.
  ROYALTY_RECIPIENT     = a DEDICATED 5% recipient (defaults to TREASURY if unset; set it explicitly)
  MAX_SUPPLY            = 2000 (default)
  PET_NAME=WALLETCHI  PET_SYMBOL=WCHI  (defaults)
  CARE_COST             = care fee in PONS BASE UNITS (default 1e18 assumes 18 decimals: MATCH Pons decimals)
  FOUR-LEG SPLIT (v4, Hunt amendment 2026-08-30, SEASON2-NO-CLAIMS-SPEC.md;
  supersedes the v3 70/20/10):
  POT_BPS=1000  REWARDS_BPS=2000  GAS_BPS=100  (BURN_BPS auto-defaults to the
  6900 remainder) = 69% burn / 20% player rewards / 10% pot / 1% push gas.
  NOTE: GAS_BPS does not exist in the season-1 deploy script; it lands with
  the season-2 contract rework. REWARDS_BPS=0 restores the old
  two-leg 90/10 with NO distributor deployed. The script deploys
    RewardsDistributor(owner, careToken, EPOCH_LENGTH) and wires
    distributor.setVault(vault); rewards pay INTO pet TBAs pro rata by care
    points per epoch, claim() is permissionless, no admin sweep exists.
  EPOCH_LENGTH=86400  (rewards epoch, seconds; 1 day)
  CONTRACT_URI=https://api.playwalletchi.com/api/collection.json  (ERC-7572
    collection metadata; owner can update later via setContractURI)
  LIFE_TTL              = 172800  (2 days; Hunt decision 2026-08-03: 24h felt too quick. With the
                              server's REAP_GRACE_HOURS=24 CRITICAL rescue window on top, true
                              death lands 72h after the last care: 48h healthy, 24h fading.)
  REAP_GRACE            = 86400  (24h ON-CHAIN revival grace, audit fix H-1. The deploy script
                              HARD-REQUIRES this be > 0: reapGrace=0 lets a griefer front-run a
                              revival to permanently soulbound-kill any lapsed pet. Keep the server's
                              REAP_GRACE_HOURS >= this value so the server never attempts a reap the
                              chain rejects.)
  CARE_COOLDOWN         = 45  (SET EXPLICITLY: the contract default is 1 HOUR, which blocks
                              feed-then-water for an hour and kills the play session. The vault
                              cooldown only needs to stop careCount machine-gunning; the server's
                              per-action 10 minute cooldowns do the pacing. Hunt decision 2026-08-03.)
  CHALLENGE_WINDOW      = settlement challenge window (default 1 days = the audit's >=24h floor: keep >= 1 days)
  CARE_WINDOW_SECS      = seconds from deploy until the committed care deadline (careDeadline =
                          deployTime + this). REQUIRED > 0 on mainnet (the deploy reverts without it):
                          this is the TRUSTLESS winner-bias fix (audit HIGH, step 8B). It sets a PUBLIC,
                          immutable clock at which caring freezes and before which closeSeason is blocked,
                          so the operator can no longer care a favored pet and time the close to pick the
                          winner. Set it to your intended season length (e.g. 604800 = 7 days). The deploy
                          auto-lockConfig()s the vault on mainnet so this deadline can never be shortened.
                          0 (testnet/demo) leaves both guards inert = old owner-closes-anytime flow.
  MIN_PLAYERS           = default 10. Mainnet REQUIRES >= 2 (deploy reverts below it); raise for a real
                          2000 season if desired.
  STARTER_TOKENS        = a SMALL non-zero seed, ~1-2 cares (e.g. 2e18 when careCost is 1e18).
                          REVISED 2026-08-14. The 2026-07-27 decision was 0 ("mint is free, playing
                          costs a buy"), and the intent still holds, but 0 is now unshippable: the
                          mint-time arming flow sends ONE owner-signed care as its first step, and
                          that care is what installs the EIP-7702 delegation and hatches the pet. It
                          is paid from the pet's own seeded float, so with a zero seed pullCare
                          reverts on the first care: no delegation, no session, no hatch, and every
                          keeper is bounced to the website for their first feed. That is precisely
                          the first run testers rejected.
                          Do NOT swing to the 100e18 default either: mints are free and care() takes
                          the leader seat, so a generous seed makes a free mint a free bid for the
                          pot. A small seed keeps both properties: the first tap works, and holding
                          the lead past one life window requires actually buying care tokens.
                          The deploy script now enforces both bounds (>= careCost always, and
                          <= 5x careCost on mainnet), so a misconfiguration fails at deploy.
  TRANSFER_VALIDATOR    = leave unset: the script deploys WalletchiTransferValidator PERMISSIVE (flip strict later, step 8)
  FINAL_OWNER           = the multisig (or cold owner) to hand every contract off to after wiring. OPTIONAL:
                          if set (and != deployer) the deploy transferOwnership()s all 5 contracts to it as
                          a PENDING owner (Ownable2Step), which the multisig completes in step 3C. Leave
                          unset to keep the deployer as owner (then hand off manually later).
  ALLOW_MANUAL_WIRING   = false (default). Only set true for the mainnet path where the deployer does NOT
                          own the contracts (owner is a multisig from the start): the deploy then wires
                          nothing and you hand-wire + lock via the multisig, then run step 3B to verify.
Run the deploy (broadcast). The script deploys PetVault, PetIssuer, Pet721 v2, and
the validator, wires Pet721<->vault + royalty + validator, CALLS every one-way lock,
lockConfig()s the vault on mainnet (freezes careDeadline + lifeTtl immutable), and,
if FINAL_OWNER is set, transfers each contract's ownership to it as a pending 2-step
handoff. It prints the POST-DEPLOY GATE-CHECK. Record all four addresses plus the
ACCOUNT_IMPL and RewardsDistributor (when REWARDS_BPS>0) addresses.

--------------------------------------------------------------------------------
## STEP 3: POST-DEPLOY on-chain gate-check (do NOT fund/open the season until ALL true)
`cast call <addr> "<fn>() (bool)" --rpc-url https://rpc.mainnet.chain.robinhood.com`
  PetIssuer.vaultLocked()      == true
  Pet721.issuerLocked()        == true
  Pet721.royaltyLocked()       == true
  Pet721.vaultRefLocked()      == true
  PetVault.configLocked()      == true    (trustless fix: careDeadline is now immutable)
Also confirm: Pet721.royaltyInfo(1, 10000) returns (ROYALTY_RECIPIENT, 500);
Pet721.getTransferValidator() == the deployed validator; Pet721.vault()/vaultRef
== PetVault; PetVault.careDeadline() > 0 (the committed care window is live, step 8B);
PetIssuer.accountImpl() == your step-2A WalletchiAccount and has code. If any lock is
false, the M-A owner-repoint drain path is OPEN: stop. If configLocked is false or
careDeadline is 0, the operator winner-bias is NOT closed: stop.

--------------------------------------------------------------------------------
## STEP 3B: one-shot wiring verification (VerifyWalletchiWiring, audit batch 2)
Instead of eyeballing the cast calls above, run the read-only assertion script. It
checks the ENTIRE wiring + one-way-lock + royalty + rewards-leg + account-impl +
trustless-gate checklist in one pass and reverts on the first thing that is wrong
(this is also the required safety net if you took the ALLOW_MANUAL_WIRING path).
Set the addresses from step 2 (DIST only when REWARDS_BPS>0), then:
  PET=<Pet721> ISSUER=<PetIssuer> VAULT=<PetVault> VALIDATOR=<validator> \
  CARE_TOKEN=<PONS> ROYALTY_RECIPIENT=<recipient> ACCOUNT_IMPL=<step 2A> DIST=<RewardsDistributor> \
  forge script script/VerifyWalletchiWiring.s.sol --rpc-url https://rpc.mainnet.chain.robinhood.com
Expect it to log "VerifyWalletchiWiring: ALL CHECKS PASSED." On mainnet it also asserts
the account impl codehash, careDeadline>0, and configLocked. Any revert = do not open
the season; fix the wiring and re-run.

--------------------------------------------------------------------------------
## STEP 3C: complete the 2-step ownership handoff (if FINAL_OWNER was set)
The deploy only set FINAL_OWNER as the PENDING owner (Ownable2Step). Until the multisig
accepts, the deployer is still the live owner. From the FINAL_OWNER multisig, call
acceptOwnership() on EACH contract to finish the handoff:
  Pet721.acceptOwnership(), PetIssuer.acceptOwnership(), PetVault.acceptOwnership(),
  WalletchiTransferValidator.acceptOwnership(), and RewardsDistributor.acceptOwnership()
  (the last only when REWARDS_BPS>0).
Verify owner() == the multisig on each. Accept BEFORE opening the season so no admin
action (closeSeason, validator policy) is ever stranded on the hot deployer key. If a
wrong FINAL_OWNER was set, just re-run transferOwnership from the deployer to the right
one and accept from there (recoverable, because pending ownership is not ownership).

--------------------------------------------------------------------------------
## STEP 3D: post-deploy owner setup (baseURI + explorer verification)
Two owner actions the deploy script does NOT do (learned on the test season, where
the Pet721 shipped with an EMPTY baseURI = blank tokenURI on OpenSea/wallets).
OWNER CONTEXT: these are owner-only. If you already completed the FINAL_OWNER handoff
(step 3C), run them from the multisig, not $TREASURY_KEY; otherwise defer the handoff
until after this step so the hot deployer can still sign them.
1. SET THE METADATA baseURI (owner, not locked, so do it once now). It must equal
   PUBLIC_BASE_URL + "/metadata/runner/" so tokenURI(id) resolves to the live
   dynamic-status metadata:
     cast send <Pet721> "setBaseURI(string)" "https://<PUBLIC_BASE_URL>/metadata/runner/" \
       --private-key $TREASURY_KEY --rpc-url https://rpc.mainnet.chain.robinhood.com
   Verify: `cast call <Pet721> "tokenURI(uint256)(string)" 1` == that URL + "1".
   (Do this AFTER the server + PUBLIC_BASE_URL domain are live, step 4/5.)
2. VERIFY ALL 5 CONTRACTS on the mainnet Blockscout (judges/holders read real
   source; on testnet this took a black-box tester from confusion to trust). Reads
   solc + optimizer from foundry.toml automatically:
     forge verify-contract <addr> src/runner/<File>.sol:<Name> --chain-id 4663 \
       --verifier blockscout --verifier-url https://<mainnet-explorer>/api \
       --constructor-args <cast abi-encode ...> --watch
   Do all of Pet721, PetVault, PetIssuer, the care token (if we deployed it; on
   mainnet we do NOT: it is Pons's, already verified), and the validator. Confirm
   is_verified:true on each contract page.

--------------------------------------------------------------------------------
## STEP 4: Render web service (server hosting, replaces the tunnel)
New Web Service -> connect Halldon-Inc/punchcard.
  Root directory:   server
  Build command:    npm ci && npm run build   (runs prisma generate + tsc)
  Start command:    npm run start              (node dist/src/index.js)
  Health check:     /health   (NOTE: 200 health is NOT go-live proof: verify an
                    authenticated pass load per step 9)
  Instance:         Starter or higher (free tier cold-starts and stalls pass push)
Provision a managed Postgres (Render or Neon) and set DATABASE_URL; run
`npm run prisma:deploy` (migrations) once before opening the season.
Server env (real names; addresses from step 2):
  NODE_ENV=production  PORT=(Render sets)  LOG_LEVEL=info
  PUBLIC_BASE_URL      = https://api.playwalletchi.com (the branded custom domain on Render), NOT the
                         *.onrender.com default: this string appears in the pass QR + care links, so
                         the tester's "replace the TryCloudflare URL with a branded domain" is exactly
                         setting this to your domain (add the domain in Render + point DNS). Pass web-
                         service + capability URLs hang off this.
  WEB_APP_URL          = the Vercel site URL (https://www.playwalletchi.com)
  DATABASE_URL         = managed Postgres URL
  ROBINHOOD_NETWORK=mainnet   ROBINHOOD_RPC_URL=https://rpc.mainnet.chain.robinhood.com
  ERC6551_REGISTRY_ADDRESS=0x000000006551c19487814612e58FE06813775758
  RELAYER_PRIVATE_KEY  = RELAYER key (step 1)
  RUNNER_ISSUER_ADDRESS = PetIssuer (step 2)     RUNNER_721_ADDRESS = Pet721 (step 2)
  CHAIN-SELECTION GATE: the server goes live on-chain when RELAYER_PRIVATE_KEY AND
    RUNNER_ISSUER_ADDRESS are BOTH set (config.ts runnerLive); otherwise it stubs.
    The retired PUNCHCARD envs (CARD_ISSUER_ADDRESS, USDG_ADDRESS, QR_SECRET) are
    NOT part of Walletchi: do not set them.
  PET721_ADDRESS        = Pet721 (step 2)          PETVAULT_ADDRESS = PetVault (step 2)
  CARE_TOKEN_ADDRESS    = PONS token   (CARE_TOKEN_DECIMALS is read on-chain at runtime: only set to override)
  REWARDS_DISTRIBUTOR_ADDRESS = RewardsDistributor (step 2). Activates the whole v3 player-rewards
    surface: the /me rewards panel, the pass "Collect rewards" link next to the care actions, and the
    gasless relayer claim. UNSET => rewards degrade to a "warming up" no-op everywhere (inert, never an
    error), so set it once the distributor is deployed + wired. On-chain rewards only accrue when the
    vault was deployed with REWARDS_BPS>0.
  TAX ECONOMY (the fee stream). Set together or the leg is dark:
    FEE_SPLITTER_ADDRESS  = CareFeeSplitter (step 2)
    HOLDER_VAULT_ADDRESS  = HolderMerkleVault (step 2)
    FEE_TOKEN_ADDRESS     = USDG (the pool denomination)
    HOLDER_POSTER_PRIVATE_KEY = the DEDICATED round-poster key (never the relayer)
    HOLDER_EXCLUDE_ADDRESSES  = the DEX pool address. HARD MAINNET REQUIREMENT: the server
                            REFUSES TO BOOT on mainnet without it, because the pool would
                            otherwise capture the majority of every holder round and those funds
                            reserve permanently.
  THE CREATOR-FEE INLET (step 6C: what actually puts money into the splitter). All THREE are
  needed or the inlet is a silent no-op and the splitter receives nothing at all:
    LAUNCHPAD_HOOK_ADDRESS         = the letscash hook, FROM OUR OWN LAUNCH RECEIPT (never docs,
                                     never an explorer search: the explorer has impersonators)
    LAUNCHPAD_POOL_ID              = our pool id, same source; 0x + 64 hex or it is ignored
    CARE_FEE_COLLECTOR_PRIVATE_KEY = the DEDICATED collector key that HOLDS THE CREATOR SEAT.
                                     Never the relayer and never the poster: whoever holds the
                                     seat can give it away permanently.
    LAUNCHPAD_HOOK_CREATOR_FN / LAUNCHPAD_HOOK_CLAIM_FN / LAUNCHPAD_HOOK_CLAIM_TO_FN = only if you
                                     are launching against a hook OTHER than CashCatHookV2
                                     (0x75A54357D9C78a2Db19004a5FDc76c50F9242AEC). The defaults were
                                     read off its deployed bytecode: poolConfigs(bytes32) for the
                                     read, claim(bytes32) and claim(bytes32,address) for the writes.
                                     creator(bytes32) does NOT exist on it; never set that.
    LAUNCHPAD_MIN_FORWARD_RAW      = optional dust floor, raw USDG (6dp). Default 0 forwards all.
    THE POOL MUST BE USDG-QUOTED. The inlet reads the pool's quote asset and refuses to claim or
    transfer anything unless it equals FEE_TOKEN_ADDRESS. See THE QUOTE-ASSET TRAP in step 6C:
    84 of 84 observed launches on this launchpad were quoted in NATIVE ETH, which this pipeline
    cannot handle and the splitter cannot even receive.
  RUNNER_SUPPLY_CAP=2000
  ART FLAGS: TRAITS_V2_ENABLED defaults ON (v2 art + the 4-stage evolution from the first mint; the
    mainnet collection IS v2, so leave it on. Set =false only to force the legacy v1 render). Optional:
    STATS_BAND_ENABLED=true adds the ALIVE / POT / BURNED band to the pass art. Evolution pacing knobs
    STAGE2_CARES / STAGE3_CARES / STAGE2_AGE_DAYS / STAGE3_AGE_DAYS are env-tunable (defaults 10 / 30 /
    3d / 10d, tuned for the 48h-life mainnet season).
  Apple pass: PASS_STUB_MODE=false PASS_CERT_P12_BASE64=... PASS_CERT_PASSWORD=...
    PASS_TYPE_ID=pass.com.halldon.punchcard APPLE_TEAM_ID=H9743FD53A
    APPLE_WWDR_PEM_BASE64=... APNS_HOST=api.push.apple.com APNS_PORT=443
    (reuse JP's working cert; do NOT override the Node CA store with the WWDR cert)
    PASS_TYPE_ID AUTHORITATIVE VALUE: pass.com.halldon.punchcard (JP's real signed
    cert; this is the value that works). NOTE the config.ts default is
    pass.com.walletchi.pet, which does NOT match any cert we hold: you MUST set
    PASS_TYPE_ID=pass.com.halldon.punchcard explicitly or pass signing fails.
  PRIVY_APP_ID=...  PRIVY_APP_SECRET=...   (real ownership mints)
  RESEND_API_KEY=...  EMAIL_FROM=noreply@<verified-domain>  EMAIL_STUB=false
  GOOGLE (optional): GOOGLE_WALLET_STUB=false GOOGLE_SA_KEY_BASE64=... GOOGLE_ISSUER_ID=...
  OpenSea refresh (optional): OPENSEA_API_KEY=...  OPENSEA_CHAIN=<verify RH Chain v2 id before enabling>
  CLAIM_NONCE_TTL_SECONDS=300 (default)
  ANTI-SYBIL (arm the mint wall): ANTI_SYBIL_ENABLED=true  SYBIL_PEPPER=<real random secret>
    TRUST_PROXY_HOPS=1 (VERIFY against Render's real proxy-hop count so req.ip is the attested
    client IP, not a spoofable header) ; thresholds have safe defaults (POW_DIFFICULTY_BITS 20,
    MINTS_PER_IP_PER_DAY 10, MINTS_PER_SUBNET_PER_DAY 40, FINGERPRINT_MINT_CAP 15,
    MINT_MIN_ELAPSED_MS 1200) : tune only if needed. NOTE: leave ANTI_SYBIL_ENABLED unset for the
    free founder demo.
    THESE THREE WERE 2 / 8 / 2 AND REFUSED REAL IPHONE KEEPERS (raised 2026-08-24). The device
    fingerprint is MODEL-level on iOS, not device-level: Safari normalizes canvas, blocks
    WEBGL_debug_renderer_info (every iPhone reports "Apple Inc.|Apple GPU"), ships a fixed font set,
    and has no deviceMemory; nav.platform is "iPhone" for all of them. Two people in one city on the
    same iPhone hash IDENTICALLY, so at a cap of 2 the third could not mint for 24h. Carrier NAT does
    the same to the per-IP cap. Keep the subnet cap a MULTIPLE of the IP cap or the /24 check binds
    first and raising the IP cap does nothing.
    BEFORE MAINNET: a finite per-fingerprint cap cannot survive 2,000 mostly-iOS mints (the population
    collapses into a few dozen buckets, ~100 real people behind each). Demote fingerprint/IP/subnet to
    ADVISORY and add the STEP 8C captcha; the supply wall is the two atomic reserves, not these.
    Also split the "too_many" block code: IP, subnet and fingerprint are indistinguishable today,
    which is why this needed a user report to surface instead of showing up in logs.
  GOOGLE WALLET (optional, Android): GOOGLE_WALLET_STUB=false GOOGLE_ISSUER_ID=... GOOGLE_SA_KEY_BASE64=...
    (SA key = base64 of the service-account JSON, with that SA authorized on the issuer).
    Unset = Apple-only (Google Save button just hides).
    HARD-WON (2026-08-03): GOOGLE_ISSUER_ID must be the NUMERIC Issuer ID from the
    Google Wallet API section of pay.google.com/business/console. The alphanumeric
    MERCHANT id (BCR2DN...) is a different thing: the Wallet REST API rejects it
    (400 Invalid class_id) and every class/object call fails silently, leaving only
    the fat save JWT working (flaky adds, frozen art, no live updates). Also publish
    the issuer out of demo mode or only allowlisted test accounts can add passes.
    VERIFY AFTER SETTING (in order):
      1. POST /internal/google/probe   (Bearer INTERNAL_STATUS_TOKEN; expect ok:true)
      2. POST /internal/google/backfill (upserts every minted pet's object; progress
         on /internal/status google.backfill)
      3. npx tsx scripts/live-verify.ts <fresh-email>  (expect "THIN JWT: YES";
         NOTE: mints a REAL pet)
      4. Existing Google-pass holders remove + re-add their pass once (old passes
         were saved from fat JWTs and are not attached to REST-patchable objects).
    /internal/status also carries google.probe/backfill/callbacks + care-by-source
    counters (apple vs google care engagement since last restart).
  SURVIVAL_ENABLED = false FIRST (see step 6 sequencing)
DB MIGRATIONS: `npm run prisma:deploy` applies ALL additive migrations (walletchi_* + anti_sybil +
minted_email). No destructive changes. Run once before opening the season.

--------------------------------------------------------------------------------
## STEP 5: site (Vercel, project walletchi, domain https://www.playwalletchi.com)
  NEXT_PUBLIC_API_URL           = https://api.playwalletchi.com (kills the cloudflared tunnel)
  NEXT_PUBLIC_PRIVY_APP_ID      = Privy app id
  NEXT_PUBLIC_CARE_TOKEN_ADDRESS= PONS token (enables the swap/get-token out-links)
Redeploy walletchi on Vercel. /claim already fetches GET /api/claim/nonce and the
preview flag is gone (commit 87c39c1).

--------------------------------------------------------------------------------
## STEP 6: go-live sequencing (survival OFF first, then ON)
1. Deploy contracts (steps 2-3) + Render up with SURVIVAL_ENABLED=false.
2. Smoke with survival OFF: mint a pet (Privy email), confirm it is traited +
   vault-registered + pass lands in a wallet + /pet page + /claim wallet-proof
   round-trip. Care is FREE here (clean shakeout). The pass-URL gate is ALSO off
   here (legacy public route allowed) by design.
3. Flip SURVIVAL_ENABLED=true (+ PETVAULT_ADDRESS/CARE_TOKEN_ADDRESS set) and
   restart. This ONE flip simultaneously turns on real-value care AND the
   fail-secure pass-URL capability gate (public pass download now 404s; owners
   get the pass via mint receipt email or /claim).
   RENDER ENV-RACE GOTCHA (hit on the test season): setting env vars via the API/
   dashboard and deploying can boot the container with STALE env (survival stays
   OFF). ALWAYS verify after: `curl <PUBLIC_BASE_URL>/api/season/stats` must show
   `seasonActive:true` AND a vault-backed count (not the 2000 pre-season stub). If
   it still reads seasonActive:false, trigger a SECOND deploy (env is now settled)
   and re-check. Only then continue.
   Then verify one real care: PONS pulled from the pet TBA, 90% to 0x...dEaD, 10%
   to the pot. And confirm /health is non-sensitive (the mode matrix now lives
   behind /internal/status; set INTERNAL_STATUS_TOKEN if you want that readout).
4. Open the season / mint eggs. Fund nothing into the pot directly: the pot grows
   from care fees.

--------------------------------------------------------------------------------
## STEP 6C: THE LAUNCHPAD CREATOR-FEE INLET (added 2026-08-23; do NOT improvise this)
This step is what actually gets revenue INTO the CareFeeSplitter. Everything downstream of the
splitter (holder Merkle rounds, the swapped player half) was built and tested long before anything
was putting money in, so treat this as the step the whole tax economy hangs on.

HOW THE MONEY ACTUALLY MOVES. CARE launches on letscash.fun (CashCat's Uniswap-v4 launchpad). The
pool-level trade tax does NOT stream to an address. It ACCRUES to a "creator" seat inside the hook,
and it is PULL-only:
    hook.claim(poolId)                pulls the accrued fee   CURRENT CREATOR ONLY
    hook.claim(poolId, to)            pulls it to ANY address CURRENT CREATOR ONLY
    hook.updateCreator(poolId, addr)  hands the seat onward   CURRENT CREATOR ONLY

### WHAT IS ACTUALLY DEPLOYED (read off the bytecode on 2026-08-23, not from docs)
Mainnet chainId 4663, RPC https://rpc.mainnet.chain.robinhood.com, explorer
https://robinhoodchain.blockscout.com.
    factory (ERC1967 proxy)  0x5bd1Fbe78a78fe8236fa00CF48fbEBA74ae34661  CashCatFactoryVNext
    LIVE hook                0x75A54357D9C78a2Db19004a5FDc76c50F9242AEC  CashCatHookV2 (verified
                                                                        source, solc 0.8.28, NOT
                                                                        upgradeable)
    older hook               0xEfe669814e5Eec33406Bd50ffa8331618D076aEc  CashCatHookV1
    USDG                     0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168  6 decimals
Selectors PRESENT in the V2 runtime bytecode:
    poolConfigs(bytes32)           0x07ef2190
    claim(bytes32)                 0xbd66528a
    claim(bytes32,address)         0x96c144f0
    claim(bytes32,address,uint256) 0x98e5d7e2
    updateCreator(bytes32,address) 0x3b0bc87e
    sweep(bytes32)                 0x248eb4ec
Selector ABSENT from BOTH hooks:
    creator(bytes32)               0x9f5ac8f7   <- the old runbook and the old server default asked
                                                   for this. It does not exist. Every read reverted.
Fees are PULL based and accrue as ERC-6909 claims. sweep(poolId) is permissionless and books the
creator share into tab[poolId]; claim sweeps first and then pays, so there is nothing to "trigger"
before claiming. The read is the poolConfigs mapping getter and it returns FIVE values:
    poolConfigs(bytes32) -> (address creator, uint16 creatorFeeBps, uint24 feeRate, bool exists,
                             address quote)
The 3% tier really is 2.7% creator / 0.3% platform: creatorFeeBps 9000, feeRate 30000, confirmed
across 1000 real PoolRegistered events. (A "70/30" figure in the press is the 1% tier's
creatorFeeBps, misread.)

### THE QUOTE-ASSET TRAP: READ THIS BEFORE YOU CLICK LAUNCH
**CARE MUST BE LAUNCHED ON A USDG-QUOTED CONFIG. Check the launch receipt for this BEFORE anything
else is configured.**

Every piece of our pipeline assumes USDG: FEE_TOKEN_DECIMALS is 6, the collector forward is an ERC-20
transfer, and CareFeeSplitter deliberately has NO receive() and no fallback (see the comment near
contracts/src/runner/CareFeeSplitter.sol:61). But EVERY observed launch on this launchpad in the last
~600k blocks was quoted in NATIVE ETH: 84 of 84 in a 29-hour window. The default is not USDG, and
nothing in the UI stops you.

If CARE launches on an ETH-quoted config, the failure is total and silent-ish: claim() pays native
ETH with .call{value:}, our ERC-20 forward moves nothing, and the splitter cannot even receive the
money. There is no fix short of relaunching the token on a new pool.

USDG-quoted configs verified ENABLED on 2026-08-23 (all creatorFeeBps 9000, feeRate 30000,
selfBurn false):
    config id 1010   1B supply
    config id 1026   10B supply
    config id 1042   100B supply
    config id 1058   1T supply
The server now enforces this: the inlet reads the pool's `quote` from poolConfigs on every cycle and
REFUSES to claim or transfer anything unless it equals FEE_TOKEN_ADDRESS. An unknown quote is treated
exactly like a mismatch. So a mis-quoted launch shows up as a loud, repeated refusal on
/internal/status instead of as revenue that quietly never arrives.

### THE ONE-WAY MISTAKE (this runbook and the deploy script used to instruct it)
The old instruction was "point the creator-fee stream at the splitter (hook.updateCreator)".
DO NOT DO THAT. CareFeeSplitter can call NEITHER of the two functions above. Its entire external
surface is setSwapAdapter, lockSwapAdapter, setSwapParams, setRateMaxAge, distribute, swapFloor,
rateIsFresh, rescueToken, renounceOwnership plus Ownable2Step, and it contains no low-level call,
no delegatecall, no receive() and no fallback(). Assigning the creator seat to it makes the ENTIRE
trade-tax revenue stream permanently unclaimable AND permanently un-reassignable. Not delayed.
DESTROYED, with no owner key, no multisig and no upgrade able to recover it. The only remedy would
be relaunching the token on a new pool.

THE RULE, in one sentence: the creator seat may only ever be assigned to an address that can call
claim() AND can hand the seat onward.

### THE COLLECTOR
Point the seat at a COLLECTOR: a DEDICATED EOA whose key the server holds
(CARE_FEE_COLLECTOR_PRIVATE_KEY, the same pattern and the same ceremony as
HOLDER_POSTER_PRIVATE_KEY). A multisig satisfies the same rule and is the better cold posture if a
Safe exists on this chain, but then the claim is a manual/scripted action rather than an automated
one. It is an EOA and not a small owned contract because the hook's ABI is NOT published: a contract
has to bake a guessed function signature into bytecode, and a wrong guess produces a seat holder
that cannot claim, which is the exact failure this whole step exists to prevent, reintroduced one
level down. An EOA can send whatever the real calldata turns out to be.

KEY CEREMONY: generate it OFFLINE (`cast wallet new`), never reuse the relayer or the poster key,
and fund it with a little ETH for gas. Three dedicated keys now: RELAYER (mint/care), POSTER
(holder rounds), COLLECTOR (creator fee). The server logs a loud [BOOT GUARD] error if any two
collapse to the same address, because whoever holds the creator seat can give it away permanently.

### THE IRREVERSIBLE updateCreator CALL IS AVOIDABLE (pick an option before you launch)
updateCreator is the single most dangerous transaction in this whole runbook: one wrong argument and
the revenue stream is gone permanently. It is also OPTIONAL. The factory requires
`params.creator == msg.sender`, so whoever sends the launch transaction IS the creator from block
zero.

  OPTION A (PREFERRED): LAUNCH FROM THE COLLECTOR.
    Send the launch transaction itself from CARE_FEE_COLLECTOR_PRIVATE_KEY's address. The collector
    holds the seat from the first block, updateCreator is NEVER called, and the entire class of
    one-way seat mistakes disappears from launch day. Cost: the collector key has to be hot enough to
    sign one launch, which it already is (the server signs claims with it 4x/day).

  OPTION B: launchWithFeeSplit WITH EXACTLY ONE RECIPIENT.
    Call launchWithFeeSplit with a single recipient at shares 10000. The factory returns THAT address
    directly as the creator and deploys no splitter clone. Use this if the launch must be sent from a
    different address than the seat holder. Verify the resulting creator with the poolConfigs read
    below before trading starts.

  OPTION C (LAST RESORT): plain launch, then updateCreator.
    Only if A and B are both impossible. This is the sequence in "LAUNCH DAY" below, and its step 4
    is the irreversible one. Triple-check the arguments; a seat handed to an address that cannot call
    claim() AND updateCreator() is destroyed, not delayed.

### DRESS-REHEARSE THE WHOLE PATH ON MAINNET FOR ABOUT 0.0005 ETH
The launch fee is the only real cost, so there is no excuse for launch day being the first time this
runs. Before the real launch:
  1. Launch a THROWAWAY token on a USDG 3% config (ids 1010 / 1026 / 1042 / 1058), from a throwaway
     key, for the ~0.0005 ETH launch fee.
  2. Trade it a little (one small buy, one small sell) so the creator seat accrues something real.
  3. Point a scratch deployment of the REAL server at it: LAUNCHPAD_HOOK_ADDRESS, LAUNCHPAD_POOL_ID
     and CARE_FEE_COLLECTOR_PRIVATE_KEY set to the rehearsal values. Run the inlet end to end and
     watch the money land in the splitter.
  4. Round-trip the seat: updateCreator to a second address you control and straight back. That
     proves reversibility on the real chain, with the real hook, at throwaway stakes.
Everything that can be wrong (a signature, the pool id, the quote asset, the claim path, a dry
collector) surfaces here instead of on launch day with real supply in the pool.

### LAUNCH DAY, IN ORDER (do not reorder steps 3 and 4)
1. Launch CARE on letscash.fun, Standard Mode 3% tier, **USDG-quoted config** (see THE QUOTE-ASSET
   TRAP above: ids 1010 / 1026 / 1042 / 1058 are the verified USDG ones). Prefer OPTION A and send
   this transaction FROM THE COLLECTOR, which makes steps 4 and 5's updateCreator unnecessary.
2. From YOUR OWN LAUNCH TRANSACTION RECEIPT, record:
     - the HOOK ADDRESS
     - the POOL ID (bytes32)
   NEVER take either value from letscash's docs (they list the hook as n/a) or from a block-explorer
   search: the explorer carries impersonator contracts, and a wrong address here means you hand your
   creator seat to a stranger. The receipt is the only source.
   THEN READ THE POOL CONFIG BACK, BEFORE ANYTHING ELSE IS CONFIGURED:
     cast call <HOOK> "poolConfigs(bytes32)(address,uint16,uint24,bool,address)" <POOL_ID> \
       --rpc-url https://rpc.mainnet.chain.robinhood.com
   Expect, in order: creator = the address that launched, creatorFeeBps = 9000, feeRate = 30000,
   exists = true, quote = 0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168 (USDG).
   **If `quote` is 0x0000000000000000000000000000000000000000 the pool is NATIVE-ETH quoted and the
   token must be relaunched. Stop here. Nothing downstream can be made to work.**
   The server defaults now match this hook exactly, so LAUNCHPAD_HOOK_CREATOR_FN /
   LAUNCHPAD_HOOK_CLAIM_FN / LAUNCHPAD_HOOK_CLAIM_TO_FN only need setting if you are launching
   against a DIFFERENT hook than 0x75A54357D9C78a2Db19004a5FDc76c50F9242AEC.
3. PROVE claim() WORKS, WITH A REAL TRANSACTION, WHILE THE SEAT IS STILL ON THE LAUNCH ADDRESS.
   Do at least one small buy and one small sell so the seat has accrued something, then:
     cast send <HOOK> "claim(bytes32)" <POOL_ID> --private-key $LAUNCH_KEY --rpc-url <mainnet>
     cast call <USDG> "balanceOf(address)(uint256)" <LAUNCH_ADDRESS> --rpc-url <mainnet>
   The balance MUST have gone up. If the call reverts or nothing arrives, STOP: the signature or the
   pool id is wrong, and moving the seat now would move it based on a value you have not verified.
   (sweep(poolId) is permissionless and claim() sweeps first, so there is nothing to trigger before
   this. If claim reverts with nothing accrued, trade again rather than reaching for sweep.)
4. HAND THE SEAT TO THE COLLECTOR. **SKIP THIS ENTIRELY UNDER OPTION A OR B: the collector already
   holds the seat and this irreversible call is never made.** Option C only:
     cast send <HOOK> "updateCreator(bytes32,address)" <POOL_ID> <COLLECTOR> \
       --private-key $LAUNCH_KEY --rpc-url <mainnet>
   Verify with the poolConfigs read (creator(bytes32) DOES NOT EXIST on either hook and reverts):
     cast call <HOOK> "poolConfigs(bytes32)(address,uint16,uint24,bool,address)" <POOL_ID> \
       --rpc-url <mainnet>
   The FIRST returned value must equal COLLECTOR, and the fifth must still be USDG.
5. PROVE THE COLLECTOR CAN CLAIM, AND CAN HAND THE SEAT ON. Trade a little more, then repeat the
   step-3 claim signed by $COLLECTOR_KEY and confirm USDG arrives at the collector. Prove the
   claim-to-splitter path too, since that is what the server uses by default:
     cast send <HOOK> "claim(bytes32,address)" <POOL_ID> <FEE_SPLITTER> \
       --private-key $COLLECTOR_KEY --rpc-url <mainnet>
     cast call <USDG> "balanceOf(address)(uint256)" <FEE_SPLITTER> --rpc-url <mainnet>
   Then prove reassignment round-trips: updateCreator to a second address we control and straight
   back to the collector. A seat you have not proven you can claim from AND hand onward is a seat you
   may have already lost. DO NOT OPEN THE SEASON UNTIL BOTH ARE PROVEN.
6. SET THE SERVER ENV (Render) and restart:
     LAUNCHPAD_HOOK_ADDRESS         = the hook from step 2
     LAUNCHPAD_POOL_ID              = the pool id from step 2 (0x + 64 hex; a malformed value is
                                      IGNORED with a loud boot error rather than sent to the chain)
     CARE_FEE_COLLECTOR_PRIVATE_KEY = the collector key
     LAUNCHPAD_HOOK_CREATOR_FN      = only if the hook is not CashCatHookV2. Default is the real
                                      read: "function poolConfigs(bytes32 poolId) view returns
                                      (address creator, uint16 creatorFeeBps, uint24 feeRate,
                                      bool exists, address quote)"
     LAUNCHPAD_HOOK_CLAIM_FN        = only if the real signature differs from the default
     LAUNCHPAD_HOOK_CLAIM_TO_FN     = default "function claim(bytes32 poolId, address to)". SET IT
                                      TO AN EMPTY STRING to force the old claim-then-forward path
                                      (a V1 hook only offers the one-argument claim)
     LAUNCHPAD_MIN_FORWARD_RAW      = optional dust floor in raw USDG (6dp); default 0 forwards all
     HOLDER_EXCLUDE_ADDRESSES       = the DEX pool address (this is a HARD mainnet boot requirement:
                                      without it the pool captures the majority of every holder
                                      round and those funds reserve permanently)
   RENDER GOTCHA: Render only redeploys on server/ changes, and env-only edits can boot with STALE
   env. Verify with step 7 rather than assuming.
7. VERIFY IT IS ACTUALLY RUNNING. GET /internal/status (Bearer INTERNAL_STATUS_TOKEN) and read the
   `launchpadInlet` block:
     inletLive                true
     claimPath                "claim-to-splitter"  (the default one-tx path; "claim-then-forward"
                                                    means LAUNCHPAD_HOOK_CLAIM_TO_FN was cleared)
     creatorMatchesCollector  true          (false names BOTH addresses: fix before opening)
     quoteMatchesFeeToken     true          (false or null = the inlet is REFUSING to send anything;
                                             check onChainQuote against feeToken in the same block)
     onChainQuote             the USDG address, NOT 0x000...0
     poolExists               true          (false = wrong pool id, nothing will ever be claimed)
     poolCreatorFeeBps / poolFeeRate        9000 / 30000 on the 3% tier
     collectorGasLow          false         (a dry collector claims nothing, silently)
     lastClaimTxHash / lastForwardTxHash    non-null after the first cycle (they are the SAME hash on
                                             the claim-to-splitter path: one transaction does both)
     totalForwardedRaw                      climbing
   And `modes.launchpadFeeInlet` should read LIVE and name the claim path. To force a cycle instead
   of waiting up to 6h:
     POST /internal/tax/distribute   (Bearer INTERNAL_STATUS_TOKEN)
   Then confirm on Blockscout: on the default path, ONE hook.claim transaction from the collector
   depositing USDG straight into the splitter, then the splitter's distribute() splitting it. WHY
   THIS CHECK IS NOT OPTIONAL: with the inlet dark, the splitter is empty, distribute() returns (0,0)
   without reverting, and the holder job reports "nothing unreserved to distribute". The entire
   system looks like a healthy season with no trading. `launchpadInlet` is the only place that tells
   the two apart.

### WHAT THE SERVER DOES ON ITS OWN, ONCE ARMED
Every distribution cycle (TAX_DISTRIBUTION_MINUTES, default 360 = 4x/day), BEFORE the splitter poke
so the same cycle distributes what it just claimed:
  a. reads the hook's poolConfigs(poolId) ONCE and REFUSES to send anything unless ALL THREE hold:
       - the pool EXISTS (exists = true),
       - the pool's QUOTE asset equals FEE_TOKEN_ADDRESS (an unknown quote counts as a refusal),
       - the creator seat IS our collector.
     A mismatch, or an unreadable read, is a loud error and a skip: it never blind-sends;
  b. claims. By DEFAULT with claim(poolId, splitter), so the money lands in the CareFeeSplitter in
     one transaction and the collector EOA never custodies revenue at all. On a hook that only offers
     claim(poolId) it claims to the collector instead and step c forwards;
  c. sweeps the collector's WHOLE fee-token balance to the splitter. On the default path this is
     housekeeping that normally moves nothing; on the fallback path it is the delivery, and sweeping
     the whole balance (not just this cycle's claim) is what makes a cycle that claimed and then
     failed to forward self-healing;
  d. pokes distribute() as before. Nothing needs notifying: distribute() is permissionless and works
     off the splitter's balance.
A lone claim revert is normal (nothing accrued since the last cycle) and is recorded, not shouted; a
run of four in a row raises a loud error. A failed FORWARD is always a loud error, because claimed
revenue is then sitting on a hot single-key wallet.

--------------------------------------------------------------------------------
## STEP 6D: THE MAINNET SWAP ADAPTER (RouterSwapAdapter)
The splitter swaps the player half of the fee stream USDG -> CARE through a pluggable ISwapAdapter.
Testnet ships MockSwapAdapter, which MINTS its output and refuses to exist on chainId 4663. Mainnet
needs a real one.

WHY A NEW CONTRACT AND NOT JUST A ROUTER ADDRESS. The splitter's own header says its
careOutPerFeeToken1e18 hint is a hand-maintained number refreshed alongside a 4x/day cron, so
between refreshes it is stale relative to the real pool and a poke is sandwichable down to that
stale floor. Its guards (positive floor, rationed downward moves, hard max age) BOUND that loss but
cannot price a trade. RouterSwapAdapter (contracts/src/runner/RouterSwapAdapter.sol) is where the
pricing lives: it takes a LIVE router quote in the SAME transaction, derives its own floor, and
trades against max(its own floor, the splitter's minOut), so the splitter's number becomes the
backstop it was always documented to be. It also measures delivery as the recipient's balance delta,
so a router that lies about its output gains nothing. It has NO owner, no setter and no rescue: it
custodies nothing between transactions, and replacing the router means deploying a new adapter and
calling splitter.setSwapAdapter, which is a lever the splitter's owner already has (and can give up
permanently with lockSwapAdapter).

DEPLOY (after step 2, because it needs the splitter address):
  forge create src/runner/RouterSwapAdapter.sol:RouterSwapAdapter \
    --private-key $TREASURY_KEY --rpc-url https://rpc.mainnet.chain.robinhood.com --broadcast \
    --constructor-args <ROUTER> <SPLITTER> "[<USDG>,<CARE>]" 300
Then: splitter.setSwapAdapter(<adapter>) and splitter.setSwapParams(300, <CARE per 1 USDG, 1e18
scaled, taken from a live quote>). RouterSwapAdapter.quoteFloor(amountIn) reads the same router the
trade will hit, so use it to refresh that hint before each poke.

UNVERIFIED UNTIL A REAL POOL EXISTS. This contract is UNAUDITED and cannot be called
production-proven before launch day, because the venue it talks to does not exist yet. Confirm ALL
FOUR against the deployed router and the real pool BEFORE the season opens:
  1. the router really implements getAmountsOut(uint256,address[]) and
     swapExactTokensForTokens(uint256,uint256,address[],address,uint256) with exact-input
     semantics. A Uniswap-v4 Universal Router does NOT: it takes an encoded command stream, and
     pointing this adapter at one reverts every swap and parks the player half forever. If that is
     what the live venue exposes, a different adapter is needed and this one must not be wired.
  2. `path` actually routes USDG to CARE with real depth at the size a 4x/day poke trades, and
     getAmountsOut on that path returns a non-zero, sane number (call quoteFloor to check).
  3. maxSlippageBps is sized to the REAL pool depth. Too tight parks the player half every poke;
     too loose is a licence to be sandwiched.
  4. ONE real end-to-end swap of a small amount has settled and delivered at or above the floor.
HONEST LIMIT to state out loud: a same-transaction spot quote comes from the same pool the trade
hits, so an attacker who moves the pool first moves the quote with it. This raises the cost of a
sandwich and removes the "trade against a floor nobody refreshed" hole; it does not make the trade
unsandwichable. A TWAP, an independent oracle, or private orderflow would. Until one exists on this
chain, the splitter's independent hand-set floor is the second opinion, which is why the adapter
takes the MAX of the two rather than trusting its own quote.

--------------------------------------------------------------------------------
## STEP 7: royalty enforcement (permissive -> strict, AFTER a live test)
Ships PERMISSIVE (trading never bricked). To ENFORCE royalties strictly:
1. List a pet on OpenSea (RH Chain) and confirm OpenSea reads/honors the
   ERC-2981 + ERC-721C signal on this chain (enforced listing).
2. Only then owner-call Pet721.setTransferValidator / the validator policy to the
   strict operator-allowlist (allow OpenSea's Seaport conduit). setTransferValidator
   is intentionally UNLOCKED for exactly this. Re-test a sale still settles.
Do NOT flip strict before the live test: a wrong allowlist bricks secondary
trading of live pets (recoverable, but avoid).

--------------------------------------------------------------------------------
## STEP 8: final verification (not health-200)
- Load a pass as an authenticated owner (real mint), not just /health.
- Confirm a care tx on Blockscout: TBA -> vault, burn to 0x...dEaD, pot +10%.
- Confirm a secondary flow: buy -> /claim (wallet sign) -> new pass, seller's old
  capability URL 404s. Confirm a dead pet's transfer reverts (soulbound).
- Confirm OpenSea shows live Status/Life Left metadata (may lag: /pet is live truth).
- REVENUE (step 6C, do NOT skip): /internal/status launchpadInlet shows inletLive:true,
  creatorMatchesCollector:true, collectorGasLow:false, and a non-null lastForwardTxHash. Then
  confirm on Blockscout that a real claim landed on the collector and a real forward landed on the
  splitter. An empty splitter is INDISTINGUISHABLE from a quiet market everywhere else in the
  system, so this is the only place the difference is visible.
- SWAP (step 6D): if RouterSwapAdapter is wired, confirm one real distribute() actually delivered
  CARE to the distributor at or above the floor. Until that transaction exists the adapter is
  UNVERIFIED and must not be described as production-proven.

--------------------------------------------------------------------------------
## STEP 8B: MAINNET FAIRNESS GATE (audit HIGH, now FIXED ON-CHAIN: verify, do not mitigate)
The winner is the pet with MAX lastCareAt. The operator holds both the owner key
(closeSeason timing) and the relayer key (care txs), so the OLD design let it care a
favored pet and time the close to pick the winner (it could never STEAL the pot;
finalize always pays the winner's own TBA). As of 2026-08-10 (commit 267ee4b) this is
fixed TRUSTLESSLY in PetVault, not accepted operationally. When a careDeadline is set:
  - care() reverts at/after careDeadline (CareWindowClosed): the winner metric freezes
    at a PUBLIC, pre-announced instant for everyone.
  - closeSeason() reverts before careDeadline (CareWindowOpen): the owner cannot close
    early to freeze the race at a favorable moment.
The deploy makes this active + immutable on mainnet automatically: CARE_WINDOW_SECS>0
is REQUIRED (sets careDeadline in the constructor) and the vault is auto-lockConfig()d
so the deadline can never be shortened. Both privileged levers are gone; the residual
is only the public last-second care race (Low/Info, symmetric, the intended "care last
to win" mechanic). finalize still always pays the winner TBA.

WHAT TO ACTUALLY DO:
1. VERIFY the gate is live + frozen (already in step 3/3B): PetVault.careDeadline() > 0
   AND PetVault.configLocked() == true. If either fails, the fix is inert: STOP and
   redeploy with CARE_WINDOW_SECS>0. This is the whole gate now.
2. KEY HYGIENE (defense in depth, not the fix): keep the relayer key separate from the
   owner key (step 1), and put the owner behind a multisig (FINAL_OWNER, step 3C). The
   trustless gate holds even with a single hot owner, but multisig custody shrinks the
   residual force-care surface (see step 1 red-team rationale).
3. OPTIONAL transparency: you MAY still publicly state that treasury/relayer-held pets
   are not played. It is no longer load-bearing (the operator cannot pick the winner),
   but it is good optics.
4. SETTLEMENT DISCIPLINE (audit E1, unchanged): the season still closes ONLY via the
   owner's seeded closeSeason (no auto-close; careDeadline gates WHEN the close is
   allowed but does not itself close). ALWAYS settle via closeSeason(seed) with the true
   max-lastCareAt pet as seed; a settleable pot cannot close unseeded (reverts
   SeedRequired). Keep CHALLENGE_WINDOW >= 1 day so a backup watcher can supersede a
   squatter claim.
   SERVER-CLOSER REQUIREMENT (Hunt decision 2026-08-03): because nothing auto-closes,
   set SETTLEMENT_SERVER_CLOSES=true; the server's closeSeasonWithTrueMax computes the
   true max and closes with it AT/AFTER the careDeadline (the close gate now enforces
   "not before"). Trade-off (re-audit F2): if BOTH the server and the owner never close,
   the pot locks with no time fallback (strictly safer than the theft it replaced);
   mitigation = the heartbeat + standby defender + owner-key custody. No server code
   change is needed; closeSeasonWithTrueMax already IS the closer.

--------------------------------------------------------------------------------
## STEP 8C: MAINNET OPS HARDENING (audit follow-ups, before opening the season)
- READ RPC vs WRITE RPC: give the server a DEDICATED read RPC endpoint separate
  from the relayer's write RPC. Public preview/metadata/season endpoints fan out
  reads per request (RPC-amplification DoS): a burst against public routes must
  never starve or rate-limit the relayer's care/mint transaction path.
- STUCK-TX HANDLING: the relayer needs nonce management + a replacement policy
  (rebroadcast with a fee bump after N blocks, alert on repeated failure). A
  stuck care tx during the endgame is a fairness incident, not just an ops one.
- REAL SYBIL RESISTANCE: PoW + velocity caps are speed bumps only (audit S1). On
  mainnet require VERIFIED email ownership (one-time code or signed magic link
  bound to the PoW nonce) PLUS a mint-time captcha (hCaptcha/Turnstile) before
  any mint. Also verify TRUST_PROXY_HOPS against the real proxy topology (prefer
  CF-Connecting-IP behind Cloudflare) so the IP caps act on the true client IP.

--------------------------------------------------------------------------------
## OPEN / NON-BLOCKING
- Task 33 (inline mint button on mainnet): DONE (commit b65c7b7). The mint-session
  token (POST /api/runner/checkout response) exchanges at POST /api/runner/pass-link
  for the cap URL, so the inline Add-to-Wallet button works with the economy on.
- OPENSEA_CHAIN v2 identifier for RH Chain is unverified: check before enabling
  the refresh, else leave OPENSEA_API_KEY unset (no-op).
- Legal: prize-pool mechanics flagged; ships for-fun degen-grade.
