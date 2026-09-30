import "dotenv/config";
import { resolve } from "node:path";
import { existsSync } from "node:fs";
import { z } from "zod";
import { getAddress, isAddress } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { assertNameSpaceCovers } from "./runner/names.js";

// Normalize a configured contract address to its EIP-55 checksum form.
//
// This exists because viem REJECTS a mixed-case address whose checksum does not validate, and an
// address is something an operator types into a dashboard by hand. A single wrong-cased character
// made every on-chain read from the gas-sponsorship webhook throw, which the webhook (correctly)
// treats as "cannot establish authorization" and fails closed. The visible symptom was every
// sponsored care being refused with "denied by webhook", which points at Alchemy, the gas policy
// and the paymaster long before it points at the letter case of an env var. Accepting any valid
// casing removes the whole class. An address that is not an address at all is still left alone,
// so a genuinely malformed value still fails loudly at the point of use.
function normalizeAddress<T extends string | undefined>(v: T): T {
  if (!v) return v;
  const t = v.trim();
  return (isAddress(t, { strict: false }) ? getAddress(t) : t) as T;
}

// Derive the PUBLIC address of a configured private key, without ever surfacing the key itself.
//
// Every consumer of HOLDER_POSTER_PRIVATE_KEY needs the address and nothing else: the boot guard
// compares it against the vault's on-chain poster(), /internal/status publishes it, and the logs
// name it. Deriving it once here means no other module ever has to touch the raw secret to answer
// "which key is this". A malformed value returns null plus a reason (a hand-typed key is exactly
// the kind of env var that arrives with a missing character), so the caller can complain LOUDLY
// instead of throwing an unreadable viem error from somewhere deep in a background job.
function deriveAddressFromKey(raw: string | undefined): { address: string | null; error: string | null } {
  if (!raw || !raw.trim()) return { address: null, error: null };
  const t = raw.trim();
  const hex = t.startsWith("0x") ? t : `0x${t}`;
  try {
    return { address: privateKeyToAccount(hex as `0x${string}`).address, error: null };
  } catch (err) {
    // NEVER echo the value: the error text is the only thing that leaves this function.
    return { address: null, error: String((err as Error)?.message ?? err).slice(0, 200) };
  }
}

// Robinhood Chain literals (verified in SPEC). Selected by ROBINHOOD_NETWORK.
export const ROBINHOOD_CHAINS = {
  mainnet: {
    chainId: 4663,
    rpcUrl: "https://rpc.mainnet.chain.robinhood.com",
    explorer: "https://robinhoodchain.blockscout.com",
  },
  testnet: {
    chainId: 46630,
    rpcUrl: "https://rpc.testnet.chain.robinhood.com",
    explorer: "https://explorer.testnet.chain.robinhood.com",
  },
} as const;

// Committed dev-only pepper default. Kept as a named constant so the schema
// default and the production boot guard below can never drift apart.
const DEV_SYBIL_PEPPER = "dev-sybil-pepper-change-me";

const bool = (def: boolean) =>
  z
    .string()
    .optional()
    .transform((v) => (v === undefined ? def : v === "true" || v === "1"));

const intWithDefault = (def: number) =>
  z
    .string()
    .optional()
    .transform((v) => (v === undefined || v === "" ? def : Number(v)))
    .pipe(z.number().int());

const schema = z.object({
  NODE_ENV: z.string().default("development"),
  PORT: intWithDefault(8080),
  LOG_LEVEL: z.string().default("info"),
  // Public base URL of THIS server. Used for pass webServiceURL + email links.
  PUBLIC_BASE_URL: z.string().url().default("http://localhost:8080"),
  // The web app origin (landing/terminal). Used for CORS + email fallback links.
  WEB_APP_URL: z.string().url().default("http://localhost:3000"),

  DATABASE_URL: z.string().min(1, "DATABASE_URL is required (Postgres)"),

  // --- Robinhood Chain (asset leg) ---
  ROBINHOOD_NETWORK: z.enum(["mainnet", "testnet"]).default("testnet"),
  ROBINHOOD_RPC_URL: z.string().optional(), // override the built-in RPC if set
  // DEDICATED read RPC (runbook STEP 8C). Public preview/metadata/season routes
  // fan out reads per request; pointed at its own endpoint, a burst against them
  // cannot starve or rate-limit the relayer's care/mint transaction path. Unset
  // = reads share the write RPC, byte-identical to today.
  READ_RPC_URL: z.string().optional(),
  // Stuck-tx policy (STEP 8C): how long a write waits for its receipt before
  // being replaced with a fee-bumped copy of the same nonce, and how many
  // replacements to attempt before the loud StuckTxError.
  STUCK_TX_WAIT_MS: intWithDefault(30_000),
  STUCK_TX_MAX_FEE_BUMPS: intWithDefault(2),
  RELAYER_PRIVATE_KEY: z.string().optional(), // 0x-prefixed; stubbed if missing
  ERC6551_REGISTRY_ADDRESS: z
    .string()
    .default("0x000000006551c19487814612e58FE06813775758"),
  ABI_DIR: z.string().optional(), // path to Foundry `out` dir; falls back to hand-written ABI

  // --- Product ---
  DEMO_BYPASS_PAYMENT: bool(false),

  // WALLETCHI pet issuer.
  // RunnerIssuer/PetIssuer contract on Robinhood Chain. Pet mint stubs loudly
  // until this is set (relayer must also be live). Reuses the same relayer key.
  RUNNER_ISSUER_ADDRESS: z.string().optional(),
  RUNNER_721_ADDRESS: z.string().optional(), // optional, for reads/metadata
  // WALLETCHI Pet721 v2 (ownership + soulbound reads for /api/claim). Falls back
  // to RUNNER_721_ADDRESS when unset so a single env covers both names.
  PET721_ADDRESS: z.string().optional(),
  // Secondary-market claim: server-issued nonce TTL for the SIWE-style wallet proof.
  CLAIM_NONCE_TTL_SECONDS: intWithDefault(300),
  // Spec-floor care challenge: TTL for the single-use ERC-4361 action challenge
  // (the strong proof-of-control path a self-custody wallet holder can sign).
  CHALLENGE_TTL_SECONDS: intWithDefault(300),
  // OpenSea metadata-refresh pings (death/critical transitions + periodic sweep).
  // No-ops with a log when the key is absent. OPENSEA_CHAIN is OpenSea's chain
  // identifier for Robinhood Chain in their v2 API (verify before enabling).
  OPENSEA_API_KEY: z.string().optional(),
  OPENSEA_CHAIN: z.string().default("robinhood"),
  OPENSEA_SWEEP_MINUTES: intWithDefault(30),
  RUNNER_SUPPLY_CAP: intWithDefault(2000), // WALLETCHI supply (2000 pets)
  // Comma-separated emails that bypass the anti-Sybil wall so testers can mint many pets to
  // exercise wallet-pass states. Deliberately env-only: hardcoding it published the bypass.
  // Must be UNSET for a mainnet launch (sybil.ts refuses to boot otherwise).
  TESTER_ALLOWLIST: z.string().optional(),

  // Idle pet layer: the card lives between visits.
  IDLE_ENABLED: bool(true),
  IDLE_TICK_MINUTES: intWithDefault(45), // scheduler + catch-up tick size
  IDLE_MAX_PUSHES_PER_HOUR: intWithDefault(2), // hard cap on lock-screen pings per pet
  IDLE_QUIET_START_HOUR: intWithDefault(23), // quiet hours start (QUIET_TZ, inclusive)
  IDLE_QUIET_END_HOUR: intWithDefault(8), // quiet hours end (QUIET_TZ, exclusive)
  // The zone the quiet window is measured in. Node in a container runs on UTC
  // unless TZ is set, so the hours above used to resolve in UTC: a 23:00-08:00
  // window actually muted 19:00-04:00 Eastern, silencing the exact evening a
  // keeper is holding their phone and pinging them at 4am instead. Naming the
  // zone makes the window mean what it reads. One global window is still an
  // approximation for a worldwide roster; it only ever gates FLAVOUR, because a
  // fading pet now pushes regardless of the hour (see CRITICAL_QUIET_MIN_GAP_HOURS).
  QUIET_TZ: z.string().default("America/Toronto"),
  IDLE_MAX_CATCHUP_TICKS: intWithDefault(16), // bound lazy catch-up work per read

  // Card Play: interact on the wallet card (signed action links).
  ACTION_COOLDOWN_MINUTES: intWithDefault(10), // per-action server cooldown

  // Pet needs: virtual-pet meters (hunger/thirst/joy 0-100, decay on the tick engine).
  NEED_DECAY_PER_HOUR: intWithDefault(5), // points lost per AWAKE hour (paused at night)
  NEED_LOW_THRESHOLD: intWithDefault(30), // at or below = the pet is unhappy + pings once
  NEED_HAPPY_THRESHOLD: intWithDefault(60), // all needs at or above = happy
  WANDER_DAYS: intWithDefault(3), // full neglect this long = the pet wanders off (no permadeath)
  FEED_HUNGER_RESTORE: intWithDefault(45),
  WATER_THIRST_RESTORE: intWithDefault(45),
  EXPLORE_JOY_RESTORE: intWithDefault(15),
  PLAY_JOY_RESTORE: intWithDefault(35),
  TOY_JOY_RESTORE: intWithDefault(25),

  // WALLETCHI survival economy. seasonActive is off until SURVIVAL_ENABLED and the
  // vault env exist; the on-chain care-fee wiring lands with the PetVault handoff.
  SURVIVAL_ENABLED: bool(false),
  PETVAULT_ADDRESS: z.string().optional(),
  CARE_TOKEN_ADDRESS: z.string().optional(),
  CARE_TOKEN_DECIMALS: intWithDefault(18), // for pot / careCost display formatting
  // WALLETCHI player rewards (SEASON 2, NO CLAIMS). The CareRewardsDistributor
  // pays 20% of every care into per-epoch pools split pro rata into each pet's
  // TBA, and the 2h push engine delivers them: nobody claims anything. Optional
  // and UNDEPLOYED for now: when unset, the rewards read degrades to a gentle
  // "warming up" state and the push engine is inert (never an error, never a
  // phantom payout). Receives BOTH the 20% care-recycling slice AND the swapped
  // player half of the fee stream, so ONE distributor covers all player rewards.
  REWARDS_DISTRIBUTOR_ADDRESS: z.string().optional(),
  // --- TAX ECONOMY (2026-08-17, simplified post-audit): HOLDER airdrop pipeline ---
  // The letscash creator-fee stream (USDG) is pointed at the CareFeeSplitter; a
  // 4x/day job pokes distribute() (holder half -> HolderMerkleVault in USDG; the
  // player half is swapped USDG->CARE into the SAME rewards distributor above) and
  // posts holder Merkle rounds to holders who own a LIVE pet. All optional +
  // address-gated: unset => holderRewardsLive=false and surfaces warm gracefully.
  FEE_SPLITTER_ADDRESS: z.string().optional(), // CareFeeSplitter (the fee-stream target)
  HOLDER_VAULT_ADDRESS: z.string().optional(), // HolderMerkleVault (USDG snapshot airdrops)
  // DEDICATED holder-round poster key (0x-prefixed), SEPARATE from the relayer.
  // The hardened HolderMerkleVault gates postRound on a poster address that the
  // deploy script now REFUSES to set equal to the relayer: one key that mints,
  // cares, claims AND posts airdrop rounds was an audited finding, because a leak
  // of the hot relayer key would also hand over the airdrop ledger. So the server
  // needs a second signer for exactly one call. Optional: absent, the posting leg
  // stays dark (a loud boot error) while every relayer-signed write, every read
  // and every already-posted round's gasless claim keeps working untouched.
  // SECRET: like RELAYER_PRIVATE_KEY it is never logged; only the derived ADDRESS
  // (public information) is ever printed or served.
  HOLDER_POSTER_PRIVATE_KEY: z.string().optional(),
  FEE_TOKEN_ADDRESS: z.string().optional(), // the fee-stream / holder-airdrop currency (USDG)
  FEE_TOKEN_DECIMALS: intWithDefault(6), // USDG is 6 decimals; display formatting only
  // --- LAUNCHPAD CREATOR-FEE INLET (the thing that actually gets money INTO the splitter) ---
  //
  // CARE launches on letscash.fun (CashCat's Uniswap-v4 launchpad). Its pool-level trade tax does
  // NOT stream to an address: it ACCRUES to a "creator" seat inside the hook, and only the CURRENT
  // creator can pull it with hook.claim(poolId) or hand the seat on with
  // hook.updateCreator(poolId, addr). Both calls are current-recipient-only.
  //
  // THE SEAT MUST NEVER BE ASSIGNED TO CareFeeSplitter. The splitter cannot call claim() and cannot
  // call updateCreator(): it has no low-level call, no delegatecall, no receive() and no fallback().
  // Pointing the seat at it destroys the entire trade-tax revenue stream permanently, with no owner
  // key and no upgrade able to recover it. The seat goes to a COLLECTOR: an account that can send
  // arbitrary calls to the hook, which here is a dedicated EOA whose key the server holds (below),
  // or a multisig.
  //
  // The hook address. CAPTURE IT FROM OUR OWN LAUNCH TRANSACTION RECEIPT, never from docs and never
  // from a block-explorer search: letscash does not publish it (their docs say n/a) and the explorer
  // is full of impersonator contracts. A wrong address here means claiming from, and potentially
  // handing our creator seat to, a stranger's contract. UNSET on testnet and today, which is why the
  // whole inlet is a silent no-op until it is set.
  LAUNCHPAD_HOOK_ADDRESS: z.string().optional(),
  // Our pool's id, bytes32, ALSO from our own launch receipt. Validated in build(): a malformed
  // value is treated as unset (with a loud boot error) rather than sent to the chain as garbage.
  LAUNCHPAD_POOL_ID: z.string().optional(),
  // The COLLECTOR key: the EOA that holds the creator seat, claims the fee stream and forwards it to
  // the CareFeeSplitter. Same pattern, and the same reasoning, as HOLDER_POSTER_PRIVATE_KEY: a
  // dedicated signer for one job, never the relayer, because a relayer leak must not also hand over
  // the fee stream (whoever holds the seat can updateCreator it away permanently).
  // SECRET: never logged. Only the derived ADDRESS (public) is ever printed or served.
  CARE_FEE_COLLECTOR_PRIVATE_KEY: z.string().optional(),
  // The hook's ABI is NOT published, so the signatures the inlet needs are configurable rather than
  // hardcoded. Human-readable viem form. WHY CONFIGURABLE: baking in a guessed signature is the same
  // class of mistake as pointing the seat at a contract that cannot claim. If a future hook takes a
  // PoolKey struct, this is a dashboard edit instead of a redeploy.
  //
  // THE DEFAULTS ARE NO LONGER GUESSES. They were read out of the DEPLOYED RUNTIME BYTECODE of the
  // live hook on Robinhood Chain mainnet (chainId 4663), CashCatHookV2 at
  // 0x75A54357D9C78a2Db19004a5FDc76c50F9242AEC, cross-checked against its verified source:
  //   poolConfigs(bytes32)          0x07ef2190  PRESENT
  //   claim(bytes32)                0xbd66528a  PRESENT
  //   claim(bytes32,address)        0x96c144f0  PRESENT
  //   claim(bytes32,address,uint256)0x98e5d7e2  PRESENT
  //   updateCreator(bytes32,address)0x3b0bc87e  PRESENT
  //   sweep(bytes32)                0x248eb4ec  PRESENT
  //   creator(bytes32)              0x9f5ac8f7  ABSENT from BOTH the V1 and V2 hooks
  //
  // THE WRONG ASSUMPTION THIS CLOSES: the previous default here was
  // "function creator(bytes32 poolId) view returns (address)". That selector does not exist on
  // either hook, so EVERY cycle's seat read would have reverted, the inlet would have skipped
  // forever with "could not read the hook's creator()", and the entire trade-tax revenue stream
  // would have gone unclaimed while every downstream leg reported a healthy season. The real read is
  // the poolConfigs mapping getter, which returns a 5-TUPLE and not a bare address.
  LAUNCHPAD_HOOK_CREATOR_FN: z
    .string()
    .default(
      "function poolConfigs(bytes32 poolId) view returns (address creator, uint16 creatorFeeBps, uint24 feeRate, bool exists, address quote)",
    ),
  LAUNCHPAD_HOOK_CLAIM_FN: z.string().default("function claim(bytes32 poolId)"),
  // CLAIM STRAIGHT TO THE SPLITTER. claim(bytes32,address) exists on the live V2 hook and pays the
  // creator's accrued share to any address that is neither zero nor the hook itself, so the collector
  // can send revenue to the CareFeeSplitter in ONE transaction. That deletes the separate forward
  // step: one fewer transaction, one fewer failure mode, and the collector EOA never custodies
  // revenue at all. Set this to an EMPTY STRING to force the old claim-then-forward path (a V1 hook
  // at 0xEfe669814e5Eec33406Bd50ffa8331618D076aEc only offers the one-argument claim).
  LAUNCHPAD_HOOK_CLAIM_TO_FN: z.string().default("function claim(bytes32 poolId, address to)"),
  // Minimum collector USDG balance (raw 6dp units, decimal string) before it is forwarded to the
  // splitter, so a dust balance does not burn a transfer's gas every cycle. Default 0 = forward
  // everything; nothing is ever withheld beyond one cycle because the check re-runs each poke.
  LAUNCHPAD_MIN_FORWARD_RAW: z.string().optional(),
  TAX_DISTRIBUTION_MINUTES: intWithDefault(360), // 4x/day distribution + snapshot cadence
  // --- TESTNET SHOWCASE: simulated trading fees ---
  // On mainnet the splitter is fed by the launchpad trade tax (the inlet above). Testnet has no
  // launchpad, so without a stand-in the holder airdrop and the USDG->CARE swap leg never move and
  // half the economy is invisible to anyone trying the showcase. When on, each fee-distribution
  // cycle mints SHOWCASE_USDG_DRIP_AMOUNT of the MOCK fee token straight into the splitter (at most
  // once per 2h epoch, recorded in ShowcaseDrip), then the normal distribute() + holder round run
  // exactly as they would on real revenue. It also re-affirms the splitter's swap-rate hint, which
  // otherwise goes stale after rateMaxAge and parks the player half for the rest of the showcase.
  // OFF by default so the mainnet-shaped code path is untouched, and REFUSED AT BOOT on mainnet
  // (it depends on MockUSDG's open faucet mint, which real USDG does not have).
  SHOWCASE_USDG_DRIP: bool(false),
  // Whole fee-token units (USDG, 6dp) per drip, decimal string. 100 per 2h epoch = 50 USDG to the
  // holder airdrop and 50 CARE (1:1 mock swap) into the player rewards pool each epoch.
  SHOWCASE_USDG_DRIP_AMOUNT: z.string().default("100"),
  // Comma-separated extra addresses excluded from holder snapshots (e.g. the DEX
  // pool). The game's own contracts + the burn address are always excluded.
  HOLDER_EXCLUDE_ADDRESSES: z.string().optional(),
  // First block of the care token's Transfer history (its deploy block). The
  // holder snapshot scans Transfer logs from here; 0 scans from genesis.
  FEE_SNAPSHOT_FROM_BLOCK: intWithDefault(0),
  // Minimum unreserved holder-vault balance (raw units, decimal string) before a
  // round is posted, so dust does not generate empty airdrop rounds.
  HOLDER_MIN_ROUND_RAW: z.string().optional(),
  // Alchemy Gas Manager sponsorship webhook signing key. Alchemy signs each
  // webhook POST with HMAC-SHA256 over the raw body (header X-Alchemy-Signature);
  // set this to that key so the endpoint can reject forged calls. Optional: when
  // unset the endpoint still runs (chain + care()-only checks) but skips the
  // signature check. Only meaningful once a Gas Manager policy points its custom
  // webhook at /api/gas-sponsorship/webhook (a MAINNET hardening; testnet leans
  // on the policy spend caps instead).
  GAS_WEBHOOK_SIGNING_KEY: z.string().optional(),

  // --- Silent care from the wallet pass (on-chain scoped session key) ---
  // The pet owner signs ONE Alchemy MAv2 grant scoping a session key to
  // care(uint256,uint8) on the PetVault; the server holds that key and submits
  // every later pass tap as a gas-sponsored UserOp. No website, no signature.
  // The scope is enforced by the account's on-chain validation hooks, so the
  // held key can only ever FEED (proven: a non-care target reverts
  // AddressNotAllowed at validation). See runner/session-care.ts.
  //
  // Alchemy Wallet APIs key + Gas Manager policy. Same values the web app uses
  // (NEXT_PUBLIC_ALCHEMY_API_KEY / NEXT_PUBLIC_GAS_POLICY_ID): neither is a
  // spending secret, they only authorize bundler + policy-scoped sponsorship.
  ALCHEMY_API_KEY: z.string().optional(),
  GAS_POLICY_ID: z.string().optional(),
  // AES-256-GCM key for the session private keys at rest. REQUIRED for silent
  // care: with no secret the feature stays dark and every pass tap falls back to
  // the owner-signed care page, rather than storing raw keys.
  CARE_SESSION_SECRET: z.string().optional(),
  // Session lifetime. Bounded so a forgotten key cannot linger past a season;
  // the site re-grants transparently when it lapses.
  // Cut from 30 days: a stored key that outlives the season is pure downside, and a
  // keeper who still wants one-tap care re-arms transparently on their next visit.
  CARE_SESSION_TTL_HOURS: intWithDefault(168), // 7 days
  // Minutes after mint before an UNARMED pet's pass says "Tap any action to finish setup"
  // (runner/setup-nudge.ts). Long enough to stay off the card while mint-time arming normally runs.
  SETUP_NUDGE_MINUTES: intWithDefault(10),
  // Server-only pepper for the pass care-link HMAC and the pass-download capability.
  // See runner/sign.ts: without it, a READ-ONLY database leak is full capability
  // theft, because the authToken in the Runner table is itself the link key.
  // Unset falls back to the raw token (byte-identical to the old behaviour) so dev
  // and smoke are unaffected; set it anywhere real value can be spent.
  CARE_LINK_SECRET: z.string().optional(),
  // Last pet standing: there is NO revive and NO reap grace. A pet is DEAD the
  // instant lastCareAt + lifeTtl passes (permanent). CRITICAL/fading now means
  // APPROACHING the deadline: within this many hours of it, the server flags the
  // pet critical and pings the keeper so there is still time to save it.
  CRITICAL_WINDOW_HOURS: intWithDefault(12),
  // A FADING PET IS NEVER SILENT, but it must not be an alarm clock either. The
  // fade warning ignores quiet hours (it is the one push that is worth a
  // keeper's sleep); overnight it is merely SPACED this far apart instead of
  // running on the normal per-hour push budget. At a 6h fade window that is two
  // or three pings across a night rather than eight.
  CRITICAL_QUIET_MIN_GAP_HOURS: intWithDefault(3),

  // Settlement + drama layer (one timer-sweep poller; inert until survivalLive).
  SETTLEMENT_POLL_MINUTES: intWithDefault(10), // finalize-poke cadence
  DRAMA_POLL_MINUTES: intWithDefault(10), // death-feed + milestone cadence
  DRAMA_LOOKBACK_BLOCKS: intWithDefault(5000), // cold-start event lookback
  DEATHFEED_MIN_HOURS: intWithDefault(8), // min hours between drama pings per owner
  DRAMA_MAX_PUSHES_PER_CYCLE: intWithDefault(200), // hard per-cycle fan-out cap (never 2000)
  // Finalize poke (replaces the retired auto-defender/closer): on the settlement
  // interval the server reads isOver() and, when true, submits the permissionless
  // finalize(). The contract re-verifies the win on-chain, so the poke can never
  // steer or rush the outcome; it only makes payout prompt. Default ON.
  SETTLEMENT_FINALIZE_POKE: bool(true),
  // SEASON 2, NO CLAIMS: the reward push cadence (Hunt's ruling, every 2 hours).
  // The engine pushes each finished epoch to the pets that earned it, forfeits
  // dead pets' shares, and retries any escrowed prize. Every call it makes is
  // permissionless, so this timer is a convenience: an outage of ours delays
  // delivery and strands nothing, because anyone can run the same pushes.
  REWARDS_PUSH_MINUTES: intWithDefault(120),
  // How many FINISHED epochs each push cycle sweeps. The default is exactly
  // ceil(LIFE_TTL / EPOCH_LENGTH) at the shipped deploy parameters (a 2h epoch
  // against a 1 day life window), which is the same span the distributor derives
  // its own autoClaimLookback from.
  //
  // WHY IT IS A KNOB AND NOT A CONSTANT: an epoch we never push is not lost, but
  // it is not neutral either. It stays pushable right up until the season settles,
  // and then the residual sweep hands it to the CHAMPION instead of the pets that
  // earned it. So an outage longer than window * EPOCH_LENGTH (24h by default)
  // quietly redistributes individual shares, and the fix has to be available
  // WITHOUT a deploy: widen this, run one cycle, put it back. Widening costs reads
  // only (pets x epochs view calls per cycle), never a wrong payment, because the
  // amounts are contract-enforced and an already-paid epoch is skipped on-chain.
  REWARDS_PUSH_EPOCH_WINDOW: intWithDefault(12),
  // How many recent holder-airdrop ROUNDS each push cycle delivers. Rounds post
  // 4x/day by default, so 12 covers three days of them. Same widenable-knob logic
  // as the epoch window above, and the deadline here is harder: the vault releases
  // an unclaimed round's funds back once its grace elapses, so a round that falls
  // out of this window before anyone is paid loses its holders their share.
  HOLDER_PUSH_ROUND_WINDOW: intWithDefault(12),
  // WHICH KEY SIGNS THE HOLDER AIRDROP DELIVERIES. HolderMerkleVault.claim is permissionless and always
  // pays the leaf's own account, so the signer is purely a question of whose queue and gas it uses.
  // Every live pet's TBA holds CARE and is an eligible holder, so ONE posted round is roughly one
  // claim transaction per live pet. On the relayer that burst shares the serial queue with every
  // mint: at ~4s per receipt, 1,000 claims hold new mints for over an hour. "poster" moves the burst
  // onto the dedicated poster key's own queue (fund that key accordingly) and leaves the relayer
  // free to mint. Default "relayer" keeps the audited mainnet posture unchanged. Falls back to the
  // relayer when no poster key is configured.
  HOLDER_CLAIM_SIGNER: z.enum(["relayer", "poster"]).default("relayer"),

  // --- Anti-Sybil compute wall (free mint gate) ---
  // Default OFF: with the flag off, POST /api/runner/checkout behaves exactly as
  // today (founder demo + existing smoke untouched). When on, the mint API
  // enforces the SERVER-SIDE risk gate: PoW, normalized-email dedup, disposable
  // block, honeypot/timing/bot signals, IP + fingerprint velocity caps.
  // HONEST POSTURE: fingerprint/IP/email are deterrents, not walls. A determined
  // attacker has proxies, anti-detect browsers, and infinite emails; this gate
  // makes bulk minting COSTLY (real compute + real infra per pet), not impossible.
  ANTI_SYBIL_ENABLED: bool(false),
  // Hashcash difficulty in leading zero BITS. ~20 bits is ~1-3s on a phone.
  POW_DIFFICULTY_BITS: intWithDefault(20),
  POW_TTL_SECONDS: intWithDefault(300), // challenge validity window
  // Refuse a mint that redeems an UNBOUND proof-of-work challenge (one issued
  // without proving a Privy identity) for a mint that DOES have a verified
  // identity. A challenge issued for identity A never verifies for identity B
  // regardless of this flag: the subject is inside the challenge signature. What
  // this flag adds is refusing the anonymous challenge entirely, so a solution
  // cannot be farmed from an unauthenticated context at all.
  //
  // DEFAULT OFF, FORCED ON FOR MAINNET IN sybil.ts. The shipped web client fetches
  // GET /api/mint/challenge with no Authorization header, so requiring the binding
  // today would refuse every live testnet mint. Mainnet is where the supply is
  // worth draining and a launch is a deliberate checklist event, so the mainnet
  // posture is closed by derivation rather than by remembering to set this.
  POW_REQUIRE_SUBJECT_BINDING: bool(false),
  // Ceiling on how many pets ONE allowlisted tester email may mint. The allowlist
  // deliberately skips the one-per-keeper walls; unbounded, that is a whole-supply
  // hole behind a single address, so the bypass gets a budget instead of a blank
  // cheque. Set generously (5% of supply per tester) on purpose: the allowlist can
  // only ever be armed on a NON-mainnet season (sybil.ts refuses to boot mainnet
  // with it set), so this number's job is to bound a test season, not to protect
  // real value, and a tight cap that stops a tester mid-season costs more than it
  // buys. Raise it in the environment if a tester ever hits it.
  TESTER_ALLOWLIST_MINT_CAP: intWithDefault(100),
  // THESE THREE ARE CALIBRATED FOR DESKTOP ENTROPY AND MOBILE HAS NONE. They were
  // 2 / 8 / 2, which refused real keepers on iPhones:
  //   - The device fingerprint (web-cub/src/lib/sybil.ts collectFingerprint) is
  //     built from canvas, WebGL, font metrics, screen, platform and timezone.
  //     Every one of those is MODEL-level on iOS, not device-level: Safari
  //     normalizes canvas, blocks WEBGL_debug_renderer_info (every iPhone reports
  //     "Apple Inc.|Apple GPU"), ships a fixed font set with no user fonts, and
  //     does not implement deviceMemory at all. nav.platform is "iPhone" for all
  //     of them. So the hash collapses to roughly (model, iOS version, timezone,
  //     language) and TWO people in one city on the same iPhone collide exactly.
  //     At a cap of 2 the third such keeper could not mint for 24h.
  //   - Mobile carriers NAT many subscribers behind one address, so a per-IP cap
  //     of 2 (and a /24 cap of 8) refuses cellular users for reasons they cannot
  //     see or fix.
  // Raised so a fuzzy signal stops acting as a hard gate. THE SUPPLY WALL IS
  // UNCHANGED: it rests on the two ATOMIC reserves (one verified Privy identity
  // one pet, one inbox one pet), which cannot collide by accident and are
  // untouched here. Keep the subnet cap a multiple of the IP cap, or the /24
  // check binds first and raising the IP cap silently does nothing.
  // MAINNET: a finite per-fingerprint cap cannot survive 2,000 mostly-iOS mints
  // (the population collapses into a few dozen buckets, putting ~100 real people
  // behind each). Demote these to advisory before launch; see LAUNCH-PUNCHLIST.md.
  MINTS_PER_IP_PER_DAY: intWithDefault(10), // ADVISORY flag threshold (see below)
  MINTS_PER_SUBNET_PER_DAY: intWithDefault(40), // /24 (v4) / /64 (v6); 4x the IP cap
  FINGERPRINT_MINT_CAP: intWithDefault(15), // near-zero entropy on iOS: see above
  /**
   * Do the three velocity signals above REFUSE a mint, or merely flag it?
   *
   * OFF by default, because none of them can separate an attack from honest
   * clustering at ANY threshold. A fingerprint is model-level on iOS and an IP is
   * shared by every subscriber behind a carrier NAT, so the same number means
   * "one attacker" or "forty real neighbours" with no way to tell. Worse, the
   * incentives are inverted: an attacker randomizes fingerprint and IP for free,
   * while an honest keeper cannot change either. Used as a gate, they only ever
   * refuse honest people. Used as a flag, they are genuinely useful forensics.
   *
   * NOTHING IS UNGUARDED BY THIS. Floods are stopped at the HTTP layer (app.ts,
   * 120 req/60s) and by 20-bit PoW, which is where flood control belongs. The
   * SUPPLY wall is the two atomic reserves (one verified Privy identity one pet,
   * one inbox one pet); normalizeEmail is alias-proof (+tags stripped on every
   * domain, dots and googlemail collapsed on Gmail), so an inbox cannot be
   * multiplied into extra pets.
   *
   * Set true to restore hard blocking (the pre-2026-08-24 behaviour). When it is
   * on, a velocity READ FAILURE fails closed wherever real value is at stake, so
   * an attacker cannot disable the caps by making the store time out. When it is
   * off there is nothing to disable, so a read failure just drops the flags.
   */
  VELOCITY_CAPS_ENFORCED: bool(false),
  /**
   * How long a row may sit at status "minting" before the reaper treats it as
   * ABANDONED and hands its anti-Sybil claims back. A mint takes seconds, so
   * anything past this is not in flight: the process died mid-mint (deploy,
   * restart, OOM) and fulfillRunner never reached the catch block that releases.
   * Until this existed, such a keeper held their inbox and verified identity
   * forever, owned no pet, and got "already_minted" on every retry for a reason
   * they could not see or fix. Generous enough to never race a live mint.
   */
  MINT_STUCK_MINUTES: intWithDefault(15),
  MINT_MIN_ELAPSED_MS: intWithDefault(1200), // faster than a human = automation
  // Pepper for email hashing + PoW HMAC signatures (QR_SECRET pattern).
  // The committed default is for dev/test ONLY: build() refuses to boot a
  // production deployment that enables the anti-Sybil gate on this value.
  SYBIL_PEPPER: z.string().default(DEV_SYBIL_PEPPER),
  // Bearer that unlocks the detailed /internal/status readiness matrix. Empty =>
  // the route 404s (off by default), so the public /health stays non-sensitive.
  INTERNAL_STATUS_TOKEN: z.string().default(""),
  // Relayer gas warning threshold in ETH: /internal/status flags low=true below
  // this so the heartbeat can alert BEFORE care/mint writes start failing.
  RELAYER_LOW_BALANCE_ETH: z.coerce.number().default(0.02),
  // Stats band on the pass art (ALIVE / POT / BURNED, FDV when a pool exists).
  // Default OFF: art changes gate on Hunt's adorability review, and flipping
  // this env on Render is the approval switch (no redeploy of code needed).
  STATS_BAND_ENABLED: bool(false),

  // Traits v2 + pet evolution. ONE switch gates the whole redesign: the trait
  // mapping (visible hue x pattern x eyes x shape uniqueness), the pattern/shape
  // art, and the four-stage evolution system. Now default ON: v2 is the final,
  // reviewed art system and the intended mainnet state, so it is the baseline
  // (mainnet mints v2 from birth, the live test season previews it). Flipping the
  // trait mapping MORPHS every existing pet's look; set the env to false only to
  // deliberately fall back to the v1 render.
  TRAITS_V2_ENABLED: bool(true),
  // Evolution thresholds (a season-tuning knob; all env-tunable). A pet reaches
  // the next stage by EITHER enough cares OR enough days, whichever comes first,
  // so an active keeper evolves through care and a patient one through time.
  STAGE2_CARES: intWithDefault(10), // cares to reach GROWN
  STAGE2_AGE_DAYS: intWithDefault(3), // OR days lived to reach GROWN
  STAGE3_CARES: intWithDefault(30), // cares to reach PRIME
  STAGE3_AGE_DAYS: intWithDefault(10), // OR days lived to reach PRIME
  // How many reverse-proxy hops front this server (Express `trust proxy`).
  // With the RIGHT count, req.ip is the address the PLATFORM appended to
  // x-forwarded-for, not a client-prepended spoof. Default 1 = one proxy
  // (Render's edge). VERIFY against Render's real hop count at wire time; if
  // it is wrong, req.ip resolves to a client-controllable entry and the
  // clientIp() helper falls back to header heuristics. Either way IP remains
  // a RATE-LIMIT signal only, never a sole hard-block.
  TRUST_PROXY_HOPS: intWithDefault(1),

  // --- Privy (checkout auth) ---
  PRIVY_APP_ID: z.string().optional(),
  PRIVY_APP_SECRET: z.string().optional(),
  // Self-custody gate. When true, the free mint REFUSES to custody: a pet only
  // mints to a wallet the caller PROVED with a verified Privy token. No proof =
  // no mint (we never hold anyone's pet). Requires privyLive. Default off so the
  // demo/test season's email-only custodial mint stays byte-identical; flip on
  // for mainnet so every pet lands in its keeper's own wallet.
  REQUIRE_SELF_CUSTODY: bool(false),

  // --- Apple Wallet ---
  PASS_STUB_MODE: z.string().optional(), // "true" forces stub; auto-on when cert missing
  PASS_CERT_P12_BASE64: z.string().optional(),
  PASS_CERT_PASSWORD: z.string().optional(),
  PASS_TYPE_ID: z.string().default("pass.com.walletchi.pet"),
  APPLE_TEAM_ID: z.string().default("TEAMID0000"),
  APPLE_WWDR_PEM_BASE64: z.string().optional(),
  ORGANIZATION_NAME: z.string().default("WALLETCHI"),
  APNS_HOST: z.string().default("api.push.apple.com"),
  APNS_PORT: intWithDefault(443),

  // --- Google Wallet ---
  GOOGLE_WALLET_STUB: z.string().optional(),
  GOOGLE_SA_KEY_BASE64: z.string().optional(),
  GOOGLE_ISSUER_ID: z.string().optional(),
  GOOGLE_LOYALTY_CLASS_SUFFIX: z.string().default("walletchi_v1"),

  // --- Email (Resend) ---
  RESEND_API_KEY: z.string().optional(),
  EMAIL_FROM: z.string().default("WALLETCHI <onboarding@resend.dev>"),
  EMAIL_STUB: z.string().optional(),

  // --- Mint-time captcha (Cloudflare Turnstile, runbook STEP 8C) ---
  // The mobile-appropriate Sybil defense: identical on every device, unlike a
  // fingerprint iOS deliberately makes uninformative. ARMED ONLY when BOTH keys
  // are set (captchaLive); a half pair is a loud boot error and stays OFF,
  // because secret-without-sitekey refuses every honest mint (server demands a
  // token the page can never render) and sitekey-without-secret is captcha
  // theater (widget shown, nothing verified). Both unset = today, byte for byte.
  TURNSTILE_SECRET_KEY: z.string().optional(),
  TURNSTILE_SITE_KEY: z.string().optional(),
});

export type RawConfig = z.infer<typeof schema>;

// The inputs every boot guard reads: raw env plus the derived "is this subsystem live" flags.
export interface BootGuardInput {
  NODE_ENV: string;
  ROBINHOOD_NETWORK: "mainnet" | "testnet";
  ANTI_SYBIL_ENABLED: boolean;
  SYBIL_PEPPER: string;
  CARE_SESSION_SECRET?: string;
  CARE_LINK_SECRET?: string;
  SURVIVAL_ENABLED: boolean;
  REQUIRE_SELF_CUSTODY: boolean;
  HOLDER_EXCLUDE_ADDRESSES?: string;
  GAS_WEBHOOK_SIGNING_KEY?: string;
  relayerLive: boolean;
  survivalLive: boolean;
  holderRewardsLive: boolean;
  privyLive: boolean;
  /** A DEDICATED holder-round poster key is configured and parsed to an address. */
  holderPosterConfigured: boolean;
  /** HOLDER_POSTER_PRIVATE_KEY was set but is not a usable private key (never carries the value). */
  holderPosterKeyInvalid: boolean;
  /** LAUNCHPAD_HOOK_ADDRESS is set (the creator-fee inlet has somewhere to claim from). */
  launchpadHookConfigured: boolean;
  /** LAUNCHPAD_POOL_ID is set and is a well-formed bytes32. */
  launchpadPoolIdConfigured: boolean;
  /** LAUNCHPAD_POOL_ID was set but is not 32 bytes of hex. */
  launchpadPoolIdInvalid: boolean;
  /** A DEDICATED collector key is configured and parsed to an address. */
  collectorConfigured: boolean;
  /** CARE_FEE_COLLECTOR_PRIVATE_KEY was set but is not a usable private key (never carries the value). */
  collectorKeyInvalid: boolean;
  /** The collector key resolves to the SAME address as the relayer key. */
  collectorIsRelayer: boolean;
  /** The collector key resolves to the SAME address as the holder-round poster key. */
  collectorIsPoster: boolean;
  /** TURNSTILE_SECRET_KEY is set. */
  captchaSecretConfigured: boolean;
  /** TURNSTILE_SITE_KEY is set. */
  captchaSiteConfigured: boolean;
  /** SHOWCASE_USDG_DRIP is on (the testnet stand-in for the launchpad fee stream). */
  SHOWCASE_USDG_DRIP?: boolean;
}

export interface BootGuardVerdict {
  /** Whether the guard block applied at all. */
  enforced: boolean;
  realValueAtStake: boolean;
  /** The refusal message, if this configuration must not boot. */
  fatal: string | null;
  /** Loud but non-fatal misconfigurations, logged at boot. */
  errors: string[];
}

/**
 * Every boot guard, as a PURE function of the environment.
 *
 * Extracted from build() so the rules can be exercised against crafted environments in the smoke
 * suite. Inline, each guard was only ever observable in whichever branch the suite's own env
 * happened to take, which for a set of checks whose entire job is to refuse a BAD environment
 * means the interesting branches were never tested at all.
 *
 * WHY THE ENFORCEMENT PREDICATE IS NOT `NODE_ENV === "production"`.
 *
 * Every guard here used to sit inside `if (NODE_ENV === "production")`. NODE_ENV is
 * `z.string().default("development")` and is set ONLY in the Render dashboard, nowhere in this
 * repo, so the whole security posture hung on one hand-typed dashboard string. The wrong
 * inference was "this is a real deployment" == "NODE_ENV happens to say production": unset that
 * var, typo it, or clone the service without it, and every guard below silently evaporates while
 * the deployment keeps custody of real money. NODE_ENV is a PROXY for the thing we care about;
 * the thing itself (is value at stake, is this mainnet) is already known here.
 *
 * SUPERSET, NEVER A REPLACEMENT. The predicate is true everywhere `NODE_ENV === "production"`
 * was true, plus the real-value and mainnet cases that were previously unguarded, so it can only
 * ADD protection. It cannot refuse a boot that succeeds today.
 */
export function evaluateBootGuards(i: BootGuardInput): BootGuardVerdict {
  // Same fail-secure test the routes use (the realValueCarePossible() helpers in routes.ts and
  // me-routes.ts): SURVIVAL_ENABLED alone counts, so a half-configured deployment is treated as
  // live rather than as safe.
  const realValueAtStake = Boolean(i.SURVIVAL_ENABLED) || i.survivalLive;
  const enforced =
    i.ROBINHOOD_NETWORK === "mainnet" || realValueAtStake || i.NODE_ENV === "production";
  const errors: string[] = [];
  const fatals: string[] = [];
  const mainnet = i.ROBINHOOD_NETWORK === "mainnet";

  if (enforced) {
    // The pepper keys the anti-Sybil email-hash + PoW HMACs; the committed
    // default would let anyone forge PoW signatures and precompute dedup hashes.
    if (i.ANTI_SYBIL_ENABLED && i.SYBIL_PEPPER === DEV_SYBIL_PEPPER) {
      fatals.push(
        "Refusing to boot: ANTI_SYBIL_ENABLED=true but SYBIL_PEPPER is still the committed dev default. " +
          "Set SYBIL_PEPPER to a unique secret value in the environment (it is the HMAC key for the " +
          "email dedup hashes and PoW challenge signatures).",
      );
    }
    // The session-key secret seals every stored care key. A short/guessable one
    // would let anyone who reads the DB unseal the keys, which turns the "grief,
    // not theft" ceiling from "needs the DB AND the secret" into "needs the DB".
    if (i.CARE_SESSION_SECRET && i.CARE_SESSION_SECRET.length < 32) {
      fatals.push(
        "Refusing to boot: CARE_SESSION_SECRET is shorter than 32 characters. It is the AES-256-GCM key " +
          "sealing the stored care session keys; set it to a long random value (or unset it to keep " +
          "silent pass-tap care off and fall back to owner-signed care).",
      );
    }
    // The care-link pepper is what stops a READ-ONLY database leak from being full
    // capability theft. Without it, linkKey() falls back to the raw authToken, which
    // lives in the Runner table, so a snapshot alone lets an attacker mint a valid
    // care link for every pet and drive this server as an oracle to burn every pet's
    // stake. The fix is real code but it is an env var, and an env var that nothing
    // enforces will eventually be unset on launch day. Refuse to boot instead.
    //
    // ORDERING NOTE: setting this later invalidates every already-issued care link and
    // pass-download URL, so it has to be in place BEFORE passes reach wallets.
    if (realValueAtStake && !i.CARE_LINK_SECRET) {
      fatals.push(
        "Refusing to boot: real-value care is enabled but CARE_LINK_SECRET is unset. It is the pepper " +
          "for the wallet-pass care links; without it a read-only database leak lets an attacker forge a " +
          "care link for every pet. Set it BEFORE any passes are issued (changing it later invalidates " +
          "every existing care link and pass-download URL).",
      );
    }
    // The free mint has exactly one gate. Shipping a real-value season with it off
    // means unlimited supply to anyone with a script.
    if (realValueAtStake && !i.ANTI_SYBIL_ENABLED) {
      fatals.push(
        "Refusing to boot: real-value care is enabled but ANTI_SYBIL_ENABLED is false. It is the only " +
          "gate on a free mint; without it one script can take the entire supply.",
      );
    }
    // Mainnet mints move real value: a mainnet deploy without live Privy auth
    // plus the self-custody gate would run unauthenticated custodial mints.
    // NO LONGER NESTED UNDER NODE_ENV: the wrong inference was that a mainnet deploy is only
    // dangerous when NODE_ENV also says production. Mainnet is mainnet whatever NODE_ENV says.
    if (mainnet && !(i.privyLive && i.REQUIRE_SELF_CUSTODY)) {
      fatals.push(
        "Refusing to boot: ROBINHOOD_NETWORK=mainnet requires verified self-custody mints. " +
          "Set PRIVY_APP_ID and PRIVY_APP_SECRET (so Privy auth is live) and REQUIRE_SELF_CUSTODY=true, " +
          "or set ROBINHOOD_NETWORK=testnet for a non-mainnet deployment.",
      );
    }
    // MOCKCHAIN. createRelayer() picks MockChain SILENTLY whenever relayerLive is false
    // (missing RELAYER_PRIVATE_KEY or RUNNER_ISSUER_ADDRESS), and MockChain hands out
    // colliding tokenIds from 1 and answers every balance read with a hardcoded 100 CARE.
    // A real-value deployment that fell back to it would look perfectly healthy while
    // writing fabricated state over a live season. Nothing refused this before.
    if (realValueAtStake && !i.relayerLive) {
      fatals.push(
        "Refusing to boot: real-value care is enabled but the relayer is not live, so the server would " +
          "run against the in-memory MockChain (colliding tokenIds, fake balances) while presenting " +
          "itself as a live season. Set RELAYER_PRIVATE_KEY and RUNNER_ISSUER_ADDRESS.",
      );
    }
    // HALF-CONFIGURED SEASON: the flag is on but the vault/relayer wiring is not, so survivalLive
    // stays false. That combination silences the death engine while the routes still treat the
    // season as live.
    //
    // LOGGED, NOT THROWN, DELIBERATELY: this half-state is a SUPPORTED transitional posture in
    // this codebase (the routes deliberately fail secure on SURVIVAL_ENABLED alone, and the smoke
    // suite asserts that behaviour). Turning a deliberately fail-secure state into a refusal to
    // boot would strand a mainnet launch sequence that sets the flag before the vault address.
    // Loud enough to catch, safe enough to never take the site down.
    if (i.SURVIVAL_ENABLED && !i.survivalLive) {
      errors.push(
        "SURVIVAL_ENABLED=true but the season is NOT live (survivalLive=false): PETVAULT_ADDRESS " +
          "and/or RELAYER_PRIVATE_KEY are missing. The death engine will not run and the vault seam " +
          "stubs. Routes still fail secure, but this deployment is half-configured. Set both envs.",
      );
    }
    // HALF-CONFIGURED CAPTCHA. Armed only on the full pair (captchaLive), so a half pair does not
    // break anything: it silently runs WITHOUT the captcha the operator thought they turned on.
    // That silence is the hazard: secret-without-sitekey would refuse every honest mint if it
    // armed, and sitekey-without-secret would render a widget nothing verifies. Loud, not fatal:
    // the mint keeps every other gate while the captcha waits for its missing half.
    if (i.captchaSecretConfigured !== i.captchaSiteConfigured) {
      errors.push(
        i.captchaSecretConfigured
          ? "TURNSTILE_SECRET_KEY is set but TURNSTILE_SITE_KEY is not: the captcha is OFF (the page " +
            "could never render the widget the server would demand). Set both to arm it."
          : "TURNSTILE_SITE_KEY is set but TURNSTILE_SECRET_KEY is not: the captcha is OFF (a widget " +
            "with no server verification is theater). Set both to arm it.",
      );
    }
    // HOLDER AIRDROP EXCLUSIONS. HOLDER_EXCLUDE_ADDRESSES is the only thing that keeps the DEX
    // pool out of the holder snapshot. Left empty on a real market, the pool is far and away the
    // largest "holder", captures the majority of every round, and those funds reserve forever
    // because no one can claim for the pool. Hard-refuse only on mainnet, where a real pool
    // exists and the loss is permanent; on testnet there is often no pool at all, so an empty
    // list is legitimate and a throw would be a false alarm.
    if (i.holderRewardsLive && !i.HOLDER_EXCLUDE_ADDRESSES) {
      const msg =
        "holder rewards are LIVE but HOLDER_EXCLUDE_ADDRESSES is empty. It is the only thing " +
        "excluding the DEX pool from the holder snapshot; with a real pool it would capture the " +
        "majority of every airdrop round and those funds would reserve permanently.";
      if (mainnet) fatals.push(`Refusing to boot: ${msg}`);
      else errors.push(msg);
    }
    // HOLDER ROUND POSTER KEY (mainnet blocker B2). The hardened HolderMerkleVault gates postRound
    // on a DEDICATED poster address that is never the relayer, so a server holding only the relayer
    // key posts nothing: every round reverts NotPoster, the 4x/day job swallowed it as a warn, and
    // the airdrop leg went dark with no signal at all. That silence is the actual finding.
    //
    // LOGGED, NOT THROWN, EVEN ON MAINNET, and that is a deliberate judgement:
    //   - The blast radius of refusing is the WHOLE server. Mint, care, passes, claims and the
    //     season all die for a misconfiguration in a rewards leg that loses NOTHING while it waits.
    //     Unposted fees simply stay unreserved in the vault and post in the next round once the key
    //     lands, so the failure is fully recoverable in a way that the HOLDER_EXCLUDE_ADDRESSES
    //     omission (funds reserved permanently to an unclaimable pool) is not. That asymmetry is
    //     why that guard is fatal on mainnet and this one is not.
    //   - The silence was the bug, and this fixes the silence: a loud boot error, holderPostingLive
    //     false so the job never burns gas on a guaranteed revert, and the whole poster picture on
    //     the authenticated /internal/status.
    if (i.holderRewardsLive && !i.holderPosterConfigured) {
      errors.push(
        i.holderPosterKeyInvalid
          ? "HOLDER_POSTER_PRIVATE_KEY is set but is NOT a usable private key, so no holder airdrop " +
            "round can be posted (the vault gates postRound on a dedicated poster key and would " +
            "revert NotPoster). Holder round posting is DISABLED; reads and gasless claims for " +
            "already-posted rounds are unaffected. Fix the key value in the environment."
          : "holder rewards are LIVE but HOLDER_POSTER_PRIVATE_KEY is unset. The hardened " +
            "HolderMerkleVault gates postRound on a DEDICATED poster key (never the relayer), so " +
            "every round would revert NotPoster. Holder round posting is DISABLED until the key is " +
            "set; fees keep accruing unreserved in the vault and post once it is. Reads and gasless " +
            "claims for already-posted rounds are unaffected.",
      );
    }
    // LAUNCHPAD CREATOR-FEE INLET. The splitter is the DESTINATION of the trade tax, not its
    // source: the tax accrues to a "creator" seat inside the launchpad hook and somebody has to
    // pull it with hook.claim(poolId) and forward it. With no hook address, no pool id or no
    // collector key, nothing ever claims, the splitter stays empty, and every downstream leg
    // (holder airdrops, the swapped player half) is correctly reporting "nothing to distribute"
    // while the actual revenue piles up unclaimed inside a third-party contract.
    //
    // LOGGED, NOT THROWN, EVEN ON MAINNET, and deliberately so:
    //   - The hook address genuinely does not exist until we launch the pool (letscash does not
    //     publish it, so it comes off our own launch receipt). A launch sequence that brings the
    //     server up before the token exists is the NORMAL order, and refusing to boot would make
    //     the correct sequence impossible.
    //   - Nothing is lost while it waits: the fees keep accruing to the seat and a later claim
    //     collects the whole backlog. That is the same recoverable-failure asymmetry that makes
    //     the poster-key guard non-fatal and the HOLDER_EXCLUDE_ADDRESSES guard fatal.
    // What this guard fixes is the SILENCE: without it, "no revenue is arriving" and "the inlet was
    // never configured" look identical from the outside.
    // The showcase drip mints a MOCK fee token through its open faucet. On mainnet the fee token is
    // real USDG, which has no such mint, so the drip could only ever revert every cycle while
    // announcing that "simulated fees" are flowing. There is no mainnet reading of this flag.
    if (mainnet && i.SHOWCASE_USDG_DRIP) {
      fatals.push(
        "Refusing to boot: SHOWCASE_USDG_DRIP is on for MAINNET. It is the testnet showcase's " +
          "stand-in for the launchpad fee stream and mints a mock fee token; unset it.",
      );
    }
    // With the showcase drip on, the drip IS the fee source, so "nothing feeds the splitter" is
    // false and saying it every boot would train everyone to ignore this line.
    if (i.holderRewardsLive && !i.launchpadHookConfigured && !i.SHOWCASE_USDG_DRIP) {
      errors.push(
        "holder rewards are LIVE but LAUNCHPAD_HOOK_ADDRESS is unset, so NOTHING claims the " +
          "launchpad creator-fee stream. The trade tax accrues to a creator seat inside the hook " +
          "and only the current creator can pull it; the CareFeeSplitter is the destination, not " +
          "the collector. Until the hook address, LAUNCHPAD_POOL_ID and " +
          "CARE_FEE_COLLECTOR_PRIVATE_KEY are all set, the splitter receives nothing. Capture the " +
          "hook address and pool id from OUR OWN launch transaction receipt (letscash does not " +
          "publish them and the explorer is full of impersonators).",
      );
    }
    // A hook address with no way to claim from it is the worst of the partial states: it reads as
    // configured while being just as dark, so it gets its own sentence rather than being folded in.
    if (i.launchpadHookConfigured && !i.collectorConfigured) {
      errors.push(
        i.collectorKeyInvalid
          ? "CARE_FEE_COLLECTOR_PRIVATE_KEY is set but is NOT a usable private key, so the " +
            "launchpad creator-fee inlet cannot claim or forward anything. Fix the key value in " +
            "the environment."
          : "LAUNCHPAD_HOOK_ADDRESS is set but CARE_FEE_COLLECTOR_PRIVATE_KEY is unset. The " +
            "creator seat can only be claimed by the account that holds it, so with no collector " +
            "key the inlet is dark and the fee stream stays unclaimed inside the hook.",
      );
    }
    if (i.launchpadHookConfigured && !i.launchpadPoolIdConfigured) {
      errors.push(
        i.launchpadPoolIdInvalid
          ? "LAUNCHPAD_POOL_ID is set but is not a 32-byte hex value (0x + 64 hex characters), so " +
            "it is being IGNORED and the creator-fee inlet is dark. Take the pool id from our own " +
            "launch transaction receipt."
          : "LAUNCHPAD_HOOK_ADDRESS is set but LAUNCHPAD_POOL_ID is unset, so the inlet does not " +
            "know which pool to claim for and stays dark. Take the pool id from our own launch " +
            "transaction receipt.",
      );
    }
    // ONE KEY MUST NOT DO TWO JOBS. Whoever holds the creator seat can hand it away permanently
    // with updateCreator, so a collector that is also the hot relayer means a relayer leak is a
    // permanent loss of the entire trade-tax stream, not just a mint/care incident. Same finding
    // shape as poster == relayer, which the deploy script hard-refuses on-chain.
    //
    // NOT FATAL, because refusing to boot cannot fix it: the seat is already assigned on-chain by
    // then, so a refusal would take the whole site down while changing nothing about the risk. The
    // fix is to rotate the seat with updateCreator, which needs the server up.
    if (i.collectorConfigured && i.collectorIsRelayer) {
      errors.push(
        "CARE_FEE_COLLECTOR_PRIVATE_KEY resolves to the SAME address as RELAYER_PRIVATE_KEY. The " +
          "collector holds the launchpad creator seat, and whoever holds that seat can reassign it " +
          "permanently, so one leaked hot key would cost the entire trade-tax stream and not just " +
          "the mint/care surface. Generate a dedicated collector key and move the seat to it with " +
          "hook.updateCreator.",
      );
    }
    if (i.collectorConfigured && i.collectorIsPoster) {
      errors.push(
        "CARE_FEE_COLLECTOR_PRIVATE_KEY resolves to the SAME address as HOLDER_POSTER_PRIVATE_KEY. " +
          "Two separate jobs with two separate threat models are sharing one key; split them.",
      );
    }
    // GAS SPONSORSHIP WEBHOOK SIGNATURE. gas-sponsor.ts only verifies the Alchemy HMAC when
    // GAS_WEBHOOK_SIGNING_KEY is set, so an unset key leaves the endpoint anonymous: anyone can
    // POST it. The endpoint still fail-closes on chain id, calldata shape and an on-chain care
    // authorization read, so this is a defence-in-depth gap, not an open door.
    //
    // LOGGED, NOT THROWN, OUTSIDE MAINNET: this key could NOT be verified against the live Render
    // environment when this guard was written, and the live testnet season depends on this
    // webhook APPROVING in order for anyone to feed a pet. A hard throw on an unverifiable env
    // var would have been a coin flip on taking production down. Mainnet gets the throw because
    // the mainnet launch is a deliberate, checklist-driven event.
    if (realValueAtStake && !i.GAS_WEBHOOK_SIGNING_KEY) {
      const msg =
        "real-value care is enabled but GAS_WEBHOOK_SIGNING_KEY is unset, so the gas-sponsorship " +
        "webhook accepts UNSIGNED calls from anyone (it still checks chain id, that the op is a " +
        "care()/withdraw, and the on-chain authorization). Set it to the Alchemy Gas Manager " +
        "webhook signing key.";
      if (mainnet) fatals.push(`Refusing to boot: ${msg}`);
      else errors.push(msg);
    }
  }

  return { enforced, realValueAtStake, fatal: fatals[0] ?? null, errors };
}

function build() {
  const parsed = schema.safeParse(process.env);
  if (!parsed.success) {
    const issues = parsed.error.issues
      .map((i) => `  - ${i.path.join(".")}: ${i.message}`)
      .join("\n");
    throw new Error(`Invalid environment configuration:\n${issues}`);
  }
  const c = parsed.data;

  const rh = ROBINHOOD_CHAINS[c.ROBINHOOD_NETWORK];
  const robinhoodRpc = c.ROBINHOOD_RPC_URL || rh.rpcUrl;

  // Default ABI_DIR to the committed monorepo ABIs so the real artifacts load
  // without env config. The hand-written fallback in abi.ts covers the case
  // where the directory is absent. Server runs from the server/ package dir.
  let abiDir = c.ABI_DIR;
  if (!abiDir) {
    const monorepoAbi = resolve(process.cwd(), "..", "contracts", "abi");
    if (existsSync(monorepoAbi)) abiDir = monorepoAbi;
  }

  // Stub-mode derivations: a subsystem is "live" only when its credentials exist.
  // WALLETCHI posture: the relayer is live when the key AND the pet issuer are
  // both set (the retired legacy CARD_ISSUER/USDG envs no longer gate it).
  const relayerLive = Boolean(c.RELAYER_PRIVATE_KEY && c.RUNNER_ISSUER_ADDRESS);
  const appleForcedStub = c.PASS_STUB_MODE === "true" || c.PASS_STUB_MODE === "1";
  const appleLive =
    !appleForcedStub &&
    Boolean(c.PASS_CERT_P12_BASE64 && c.PASS_CERT_PASSWORD);
  const googleForcedStub =
    c.GOOGLE_WALLET_STUB === "true" || c.GOOGLE_WALLET_STUB === "1";
  const googleLive =
    !googleForcedStub && Boolean(c.GOOGLE_SA_KEY_BASE64 && c.GOOGLE_ISSUER_ID);
  const emailForcedStub = c.EMAIL_STUB === "true" || c.EMAIL_STUB === "1";
  const emailLive = !emailForcedStub && Boolean(c.RESEND_API_KEY);
  const privyLive = Boolean(c.PRIVY_APP_ID && c.PRIVY_APP_SECRET);
  // Mint-time captcha: armed only on the FULL pair (see the schema note; a half
  // pair degrades to OFF and the boot guard says so loudly).
  const captchaLive = Boolean(c.TURNSTILE_SECRET_KEY && c.TURNSTILE_SITE_KEY);
  // Pet mint is live only when the relayer key AND the RunnerIssuer address are
  // both present (same gate as the relayer itself since the legacy-card retirement).
  // Otherwise it stubs against MockChain so nothing fakes an on-chain pet write.
  const runnerLive = relayerLive;
  // The survival season is "live" (real vault reads/writes) only when the flag is
  // on AND the vault address AND the relayer key are present. Otherwise the vault
  // seam stubs loudly and the card behaves exactly as it does pre-season.
  const survivalLive = Boolean(
    c.SURVIVAL_ENABLED && c.PETVAULT_ADDRESS && c.RELAYER_PRIVATE_KEY,
  );
  // Player rewards are "live" only when the relayer can submit the pushes AND the
  // distributor address is set. Otherwise rewardsLive=false, the reward read
  // returns an empty/warming state and the 2h push engine never starts, so a
  // missing distributor is graceful.
  const rewardsLive = Boolean(relayerLive && c.REWARDS_DISTRIBUTOR_ADDRESS);
  // The holder-airdrop pipeline is live only when the relayer can write AND every
  // piece is addressed (splitter to poke, holder vault to post rounds into, fee
  // token + care token for the live-pet-gated holder snapshot).
  const holderRewardsLive = Boolean(
    relayerLive &&
      c.FEE_SPLITTER_ADDRESS &&
      c.HOLDER_VAULT_ADDRESS &&
      c.FEE_TOKEN_ADDRESS &&
      c.CARE_TOKEN_ADDRESS,
  );
  // The DEDICATED poster key, resolved to its PUBLIC address once at boot. The secret itself is
  // read exactly twice in this process: here, and by the poster wallet client in chain/robinhood.ts.
  const poster = deriveAddressFromKey(c.HOLDER_POSTER_PRIVATE_KEY);
  const holderPosterAddress = poster.address;
  const holderPosterKeyInvalid = Boolean(c.HOLDER_POSTER_PRIVATE_KEY?.trim() && !poster.address);
  // POSTING is a NARROWER gate than holderRewardsLive on purpose. postRound is the ONLY poster-gated
  // call on the vault; claim() is permissionless and relayer-signed, and every read is unauthenticated.
  // Folding the poster key into holderRewardsLive itself would therefore have taken the gasless claim
  // relay and the /api/holder-rewards proof lookups dark along with it, stranding money that is
  // already posted and claimable, to punish a key that only the POSTING leg needs.
  const holderPostingLive = Boolean(holderRewardsLive && holderPosterAddress);

  // --- LAUNCHPAD CREATOR-FEE INLET ---
  // The relayer's PUBLIC address, derived here purely so the boot guards can compare the dedicated
  // keys against it. Never the secret: only the address leaves deriveAddressFromKey. null when the
  // relayer key is unset or unusable, and the comparisons below treat null as "no verdict" rather
  // than as a match, so two unset keys are never reported as the same key.
  const relayerAddress = deriveAddressFromKey(c.RELAYER_PRIVATE_KEY).address;
  // The COLLECTOR key, resolved to its PUBLIC address once at boot, exactly like the poster above.
  const collector = deriveAddressFromKey(c.CARE_FEE_COLLECTOR_PRIVATE_KEY);
  const careFeeCollectorAddress = collector.address;
  const collectorKeyInvalid = Boolean(c.CARE_FEE_COLLECTOR_PRIVATE_KEY?.trim() && !collector.address);
  // VALIDATED HERE, NOT AT THE POINT OF USE. A pool id is 32 bytes of hex copied by hand out of a
  // transaction receipt, which is precisely the kind of value that arrives with a missing character.
  // A malformed one is treated as UNSET (the inlet stays dark and says why) rather than being sent
  // to the chain, where it would either revert opaquely 4x/day or, worse, address a different pool.
  const rawPoolId = c.LAUNCHPAD_POOL_ID?.trim();
  const poolIdWellFormed = Boolean(rawPoolId && /^0x[0-9a-fA-F]{64}$/.test(rawPoolId));
  const launchpadPoolId = poolIdWellFormed ? (rawPoolId as string).toLowerCase() : null;
  const launchpadPoolIdInvalid = Boolean(rawPoolId && !poolIdWellFormed);
  const launchpadHookAddress = normalizeAddress(c.LAUNCHPAD_HOOK_ADDRESS) || null;
  // The inlet is live only when EVERY piece of the claim -> forward path exists: a chain client that
  // can sign, a hook + pool id to claim from, a collector key that holds the seat, and both the
  // token and the destination to forward to. Anything missing keeps it a silent no-op (the boot
  // guards above are what make the silence legible), which is the state on testnet and today.
  const launchpadInletLive = Boolean(
    relayerLive &&
      launchpadHookAddress &&
      launchpadPoolId &&
      careFeeCollectorAddress &&
      c.FEE_TOKEN_ADDRESS &&
      c.FEE_SPLITTER_ADDRESS,
  );
  // CLAIM-TO-SPLITTER is the DEFAULT path, and it is a separate signal from launchpadInletLive on
  // purpose: it answers "which claim shape does this hook offer", not "is the inlet configured".
  // Derived from the signature alone so an operator can fall back to claim-then-forward by clearing
  // LAUNCHPAD_HOOK_CLAIM_TO_FN, without having to touch anything else.
  const launchpadClaimToSplitter = Boolean(c.LAUNCHPAD_HOOK_CLAIM_TO_FN?.trim());

  // Silent pass-tap care is live only when the season is live AND we can both
  // talk to Alchemy (key + sponsorship policy) and seal a session key at rest.
  // Anything missing keeps the pass links pointed at the owner-signed care page,
  // which is the proven fallback: the feature degrades, it never half-works.
  const silentCareLive = Boolean(
    survivalLive && c.ALCHEMY_API_KEY && c.GAS_POLICY_ID && c.CARE_SESSION_SECRET,
  );

  // The Pet721 address used for ownership/soulbound reads (claim + care guard).
  const pet721Address = normalizeAddress(c.PET721_ADDRESS || c.RUNNER_721_ADDRESS) || null;

  // Not scoped to production: this is a correctness invariant, not a security posture. Every pet's
  // NFT metadata publishes a name we claim is unique across the supply, and that claim holds only
  // while the supply fits inside the name space. Break it and two holders own identically named
  // pets, on-chain, permanently. Cheap to check, impossible to notice at the 2,561st mint.
  assertNameSpaceCovers(c.RUNNER_SUPPLY_CAP);

  // Boot guards: refuse to start a half-configured deployment rather than run with a silently
  // broken security posture. The rules live in evaluateBootGuards() above as a PURE function so
  // the smoke suite can exercise every branch against crafted environments; see the note there
  // for why the enforcement predicate is no longer NODE_ENV.
  const guards = evaluateBootGuards({
    NODE_ENV: c.NODE_ENV,
    ROBINHOOD_NETWORK: c.ROBINHOOD_NETWORK,
    ANTI_SYBIL_ENABLED: c.ANTI_SYBIL_ENABLED,
    SYBIL_PEPPER: c.SYBIL_PEPPER,
    CARE_SESSION_SECRET: c.CARE_SESSION_SECRET,
    CARE_LINK_SECRET: c.CARE_LINK_SECRET,
    SURVIVAL_ENABLED: c.SURVIVAL_ENABLED,
    REQUIRE_SELF_CUSTODY: c.REQUIRE_SELF_CUSTODY,
    HOLDER_EXCLUDE_ADDRESSES: c.HOLDER_EXCLUDE_ADDRESSES,
    GAS_WEBHOOK_SIGNING_KEY: c.GAS_WEBHOOK_SIGNING_KEY,
    relayerLive,
    survivalLive,
    holderRewardsLive,
    privyLive,
    holderPosterConfigured: Boolean(holderPosterAddress),
    holderPosterKeyInvalid,
    launchpadHookConfigured: Boolean(launchpadHookAddress),
    launchpadPoolIdConfigured: Boolean(launchpadPoolId),
    launchpadPoolIdInvalid,
    collectorConfigured: Boolean(careFeeCollectorAddress),
    collectorKeyInvalid,
    SHOWCASE_USDG_DRIP: c.SHOWCASE_USDG_DRIP,
    // Compared on ADDRESSES, never on the key material, and only when both sides actually resolved:
    // two unset keys are not "the same key".
    collectorIsRelayer: Boolean(
      careFeeCollectorAddress &&
        relayerAddress &&
        careFeeCollectorAddress.toLowerCase() === relayerAddress.toLowerCase(),
    ),
    collectorIsPoster: Boolean(
      careFeeCollectorAddress &&
        holderPosterAddress &&
        careFeeCollectorAddress.toLowerCase() === holderPosterAddress.toLowerCase(),
    ),
    captchaSecretConfigured: Boolean(c.TURNSTILE_SECRET_KEY),
    captchaSiteConfigured: Boolean(c.TURNSTILE_SITE_KEY),
  });
  const realValueAtStake = guards.realValueAtStake;
  // Loud non-fatal misconfigurations first, so they stay visible even when a refusal follows.
  // console.error and NOT the logger: logger.ts imports config, so importing it here would be a
  // circular import. These fire once, at boot, before anything serves a request.
  for (const msg of guards.errors) console.error(`[BOOT GUARD] ${msg}`);
  if (guards.fatal) throw new Error(guards.fatal);

  return {
    ...c,
    // Every contract address, in checksum form regardless of how it was typed into the dashboard.
    // See normalizeAddress: a wrong-cased character here silently disabled gasless care.
    PETVAULT_ADDRESS: normalizeAddress(c.PETVAULT_ADDRESS),
    CARE_TOKEN_ADDRESS: normalizeAddress(c.CARE_TOKEN_ADDRESS),
    RUNNER_ISSUER_ADDRESS: normalizeAddress(c.RUNNER_ISSUER_ADDRESS),
    RUNNER_721_ADDRESS: normalizeAddress(c.RUNNER_721_ADDRESS),
    PET721_ADDRESS: normalizeAddress(c.PET721_ADDRESS),
    FEE_SPLITTER_ADDRESS: normalizeAddress(c.FEE_SPLITTER_ADDRESS),
    HOLDER_VAULT_ADDRESS: normalizeAddress(c.HOLDER_VAULT_ADDRESS),
    FEE_TOKEN_ADDRESS: normalizeAddress(c.FEE_TOKEN_ADDRESS),
    // Checksummed, or null. Captured from OUR OWN launch receipt (see the schema comment): letscash
    // does not publish this address and the explorer carries impersonators.
    LAUNCHPAD_HOOK_ADDRESS: launchpadHookAddress,
    // Lower-cased bytes32, or null when unset OR malformed. A malformed pool id is DELIBERATELY
    // downgraded to null instead of being passed through, so no code path can send a truncated id
    // to the hook; the boot guard above is what makes that downgrade visible.
    LAUNCHPAD_POOL_ID: launchpadPoolId,
    ABI_DIR: abiDir,
    pet721Address,
    // PUBLIC address of the dedicated creator-fee collector key (null when unset/unusable). Safe to
    // log and to serve on /internal/status; it is what the hook's on-chain creator() must equal.
    careFeeCollectorAddress,
    // PUBLIC address of the dedicated holder-round poster key (null when unset/unusable). Safe to
    // log and to serve on /internal/status; it is what the on-chain poster() must equal.
    holderPosterAddress,
    robinhood: { ...rh, rpcUrl: robinhoodRpc, readRpcUrl: c.READ_RPC_URL || robinhoodRpc },
    modes: {
      relayerLive,
      appleLive,
      googleLive,
      emailLive,
      privyLive,
      // Mint-time Turnstile captcha (STEP 8C): full key pair present, gate armed.
      captchaLive,
      runnerLive,
      survivalLive,
      rewardsLive,
      holderRewardsLive,
      // Holder ROUND POSTING (the poster-gated postRound write) specifically. False with the
      // rest of the holder leg still live means "claims and reads work, no new round can be
      // posted": exactly the state a missing or wrong poster key leaves the season in.
      holderPostingLive,
      // The claim -> forward inlet that puts money INTO the splitter. Separate from
      // holderRewardsLive because it fails on its own inputs (hook address, pool id, collector key)
      // and because the two are live at different moments: the season runs with holder rewards live
      // and the inlet dark for as long as the token has not launched yet.
      launchpadInletLive,
      // True when the hook offers claim(bytes32,address), so the collector claims STRAIGHT to the
      // CareFeeSplitter and never custodies revenue. False falls back to claim-then-forward.
      launchpadClaimToSplitter,
      silentCareLive,
      // The SHARED fail-secure signal, exported so other modules key their own boot guards on
      // the SAME derivation instead of re-deriving it (or, as sybil.ts did, keying on the
      // NODE_ENV/network literals and shipping the bypass live whenever either one was wrong).
      // Boot-time value: routes that need a runtime read still use realValueCarePossible().
      realValueAtStake,
    },
  };
}

export const config = build();
export type Config = ReturnType<typeof build>;

// One-line summary of what is live vs stubbed, logged at boot.
export function stubMatrix(cfg: Config = config): Record<string, string> {
  const m = cfg.modes;
  const s = (live: boolean) => (live ? "LIVE" : "STUB");
  return {
    relayer: `${s(m.relayerLive)} (Robinhood ${cfg.ROBINHOOD_NETWORK})`,
    applePass: s(m.appleLive),
    googleWallet: s(m.googleLive),
    email: s(m.emailLive),
    privyAuth: m.privyLive ? "LIVE" : "STUB (bypass verify)",
    mintCaptcha: m.captchaLive ? "LIVE (Turnstile)" : "off (set TURNSTILE_SECRET_KEY + TURNSTILE_SITE_KEY)",
    demoBypassPayment: cfg.DEMO_BYPASS_PAYMENT ? "ON" : "off",
    runnerIssuer: m.runnerLive
      ? `LIVE (Robinhood ${cfg.ROBINHOOD_NETWORK})`
      : "STUB (MockChain)",
    survivalSeason: m.survivalLive
      ? `LIVE (vault ${cfg.PETVAULT_ADDRESS})`
      : cfg.SURVIVAL_ENABLED
        ? "STUB (set PETVAULT_ADDRESS + RELAYER_PRIVATE_KEY)"
        : "off (pre-season)",
    silentPassCare: m.silentCareLive
      ? "LIVE (on-chain scoped session keys)"
      : "off (set ALCHEMY_API_KEY + GAS_POLICY_ID + CARE_SESSION_SECRET)",
    playerRewards: m.rewardsLive
      ? `LIVE (distributor ${cfg.REWARDS_DISTRIBUTOR_ADDRESS})`
      : "off (set REWARDS_DISTRIBUTOR_ADDRESS + relayer; warming state)",
    holderRewards: m.holderRewardsLive
      ? `LIVE (splitter ${cfg.FEE_SPLITTER_ADDRESS})`
      : "off (set FEE_SPLITTER/HOLDER_VAULT/FEE_TOKEN addresses + relayer)",
    // Called out separately from holderRewards because it fails on its own: the posting leg can be
    // dark (no poster key) while reads and gasless claims are perfectly healthy, and that split is
    // precisely the state nobody could see before.
    holderRoundPosting: m.holderPostingLive
      ? `LIVE (poster ${cfg.holderPosterAddress})`
      : m.holderRewardsLive
        ? "DARK (no usable HOLDER_POSTER_PRIVATE_KEY: postRound would revert NotPoster)"
        : "off (holder rewards not live)",
    // The INLET, called out separately because it is the only leg that puts money INTO the
    // splitter. Everything downstream can be perfectly healthy and still distribute nothing when
    // this is dark, which reads as "no trade volume" and is actually "nobody is claiming".
    launchpadFeeInlet: m.launchpadInletLive
      ? `LIVE (hook ${cfg.LAUNCHPAD_HOOK_ADDRESS}, collector ${cfg.careFeeCollectorAddress}, ` +
        `${m.launchpadClaimToSplitter ? "claim-to-splitter" : "claim-then-forward"})`
      : cfg.LAUNCHPAD_HOOK_ADDRESS
        ? "DARK (hook set but pool id / collector key / fee token / splitter missing)"
        : "off (no LAUNCHPAD_HOOK_ADDRESS: nothing claims the creator-fee stream)",
  };
}
