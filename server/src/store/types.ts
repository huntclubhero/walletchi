// Domain entities + the Store interface. The Store abstracts persistence so the
// production app runs on Prisma/Postgres while the smoke test runs in-memory.
// Both implementations are real; neither fakes results.

// Legacy runner-era surface (kept only for deployed-ABI compatibility).

export type RunnerStatus = "minting" | "ready" | "failed";

export interface Runner {
  serial: string;
  tokenId: string | null;
  tbaAddress: string | null;
  ownerAddress: string;
  email: string;
  bestScore: number;
  salmon: number;
  runs: number;
  authToken: string;
  status: string; // RunnerStatus
  issueTxHash: string | null;
  // The mint transaction's nonce, persisted WITH the hash before the broadcast
  // (launch fix 1). Together they let a restarted process find the transaction
  // again, or prove it never landed, instead of guessing from the row's age.
  issueNonce: number | null;
  failureReason: string | null;
  // Idle pet layer.
  idleSalmon: number;
  lastTickAt: Date | null;
  lastEvent: string | null;
  lastPushAt: Date | null;
  lastIdleCatchAt: Date | null;
  pendingDigest: number;
  // Card Play.
  lastHoneyAt: Date | null;
  lastFishAt: Date | null;
  lastExploreAt: Date | null;
  pendingSalmon: number;
  activeFork: string | null;
  forkExpiresAt: Date | null;
  // Pet needs.
  hunger: number;
  thirst: number;
  joy: number;
  lastNeedsAt: Date | null;
  lastCareAt: Date | null;
  lastWaterAt: Date | null;
  lastWanderPingAt: Date | null;
  lastPlayAt: Date | null;
  lastToyAt: Date | null;
  // WALLETCHI pixel pet.
  hatched: boolean;
  toys: number;
  critical: boolean; // approaching the life-timer deadline (fading; death is permanent once it passes)
  gone: boolean;
  won: boolean; // won the season (Victory)
  wonPrize: string; // prize paid at Victory (raw care-token units)
  lastStage: number; // highest evolution stage celebrated (0 egg..3 prime)
  // WALLETCHI memorial (persisted from the vault memorialState on the death flip;
  // diedAt = lastCareAt + lifeTtl, the instant the timer lapsed).
  bornAt: Date | null;
  diedAt: Date | null;
  careCount: number;
  deathRank: number; // death order, derived OFF-CHAIN (1 = first to die; 0 = unknown/survivor)
  // Peppered hash of the VERIFIED Privy identity that minted this pet (null for a
  // custodial/demo mint with no verified session). Only consumer: the failed-mint
  // release path, which must give the identity its claim back.
  privyUserHash: string | null;
  // Google Wallet object suffix the pet's links currently live in, rotated with authToken so
  // fresh links never land in a shared object a previous holder saved (google.ts objectId).
  // Null or absent = the legacy id runner_<serial>. Optional so create paths need not set it.
  googleObjectId?: string | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface RunnerEvent {
  id: string;
  serial: string;
  type: string; // fork | action | run
  message: string;
  createdAt: Date;
}

// Most devices one runner pass keeps registered for push. The push loop opens one APNs stream per
// stored token, so the set per serial is bounded. At the cap a NEW device is refused; nobody is ever
// evicted (Nexory, 2026-10-15: eviction let anyone holding a leaked pass copy push the owner's own
// devices out). A known device always re-registers, and APNs 410 pruning frees slots of phones that
// are gone. If a leaked copy fills the slots, the owner's "Reset my pass links" supersedes them.
export const MAX_RUNNER_REGISTRATIONS_PER_SERIAL = 10;

// A rotation (claim.ts rotateRunnerAuth) SUPERSEDES a serial's registrations instead of deleting
// them: a superseded row still answers the device's list call, so the old pass can refresh into its
// keepsake view after the rotation's push, but it no longer counts toward the cap, and it gets
// pushes only for this long after the rotation.
export const SUPERSEDED_REGISTRATION_PUSH_WINDOW_MS = 24 * 60 * 60 * 1000;

export interface RunnerDeviceRegistration {
  deviceLibraryId: string;
  passTypeId: string;
  serial: string;
  pushToken: string;
  createdAt: Date;
  supersededAt?: Date | null;
}

// Anti-Sybil mint gate: one row per mint ATTEMPT (blocked or minted), for
// normalized-email dedup, IP/fingerprint velocity caps, and forensics. The
// email is stored ONLY as a peppered hash, never in the clear.
export interface MintSignal {
  id: string;
  normalizedEmailHash: string;
  fingerprint: string | null;
  ip: string | null;
  subnet: string | null;
  outcome: string; // "minted" | a block code (already_minted, pow_invalid, ...)
  botFlags: string | null; // compact JSON of client bot signals (forensics only)
  createdAt: Date;
}

// One pet's on-chain scoped care session. `secretEnc` is the AES-256-GCM sealed
// session private key; nothing outside runner/session-care.ts should open it.
export interface CareSession {
  serial: string;
  tokenId: string;
  ownerAddress: string;
  vaultAddress: string;
  publicKey: string;
  secretEnc: string;
  context: string;
  expiresAt: Date;
  revokedAt: Date | null;
  revokedReason: string | null;
  lastUsedAt: Date | null;
  useCount: number;
  createdAt: Date;
  updatedAt: Date;
}

// TAX ECONOMY holder airdrops: one posted Merkle round + its leaves. The chain
// (HolderMerkleVault) is the source of truth for claimed state and backing; these
// rows are the PROOF STORE the claim API serves.
export interface HolderRound {
  id: number; // on-chain roundId
  root: string;
  total: string; // raw units, decimal string
  token: string; // fee token address
  txHash: string | null;
  postedAt: Date;
}

export interface HolderLeaf {
  roundId: number;
  account: string; // checksummed
  amount: string; // raw units, decimal string
  proof: string; // JSON array of 0x sibling hashes
}

export interface Store {
  ping(): Promise<void>;

  // Legacy runner-era surface.
  // Runners
  createRunner(input: Omit<Runner, "createdAt" | "updatedAt">): Promise<Runner>;
  getRunner(serial: string): Promise<Runner | null>;
  getRunnerByTokenId(tokenId: string): Promise<Runner | null>;
  getRunnerByAuthToken(authToken: string): Promise<Runner | null>;
  /** Apply `patch` ONLY if the runner is not yet `gone`, atomically. Returns the updated row when THIS
   *  call made the transition, null when another caller already had (the death path's exactly-once
   *  guard: memorial mail, pushes and the OpenSea nudge go out only for the winner). */
  markRunnerGone(serial: string, patch: Partial<Runner>): Promise<Runner | null>;
  updateRunner(
    serial: string,
    patch: Partial<
      Pick<
        Runner,
        | "tokenId"
        | "tbaAddress"
        | "ownerAddress"
        | "email"
        | "authToken"
        | "bestScore"
        | "salmon"
        | "runs"
        | "status"
        | "issueTxHash"
        | "issueNonce"
        | "googleObjectId"
        | "failureReason"
        | "idleSalmon"
        | "lastTickAt"
        | "lastEvent"
        | "lastPushAt"
        | "lastIdleCatchAt"
        | "pendingDigest"
        | "lastHoneyAt"
        | "lastFishAt"
        | "lastExploreAt"
        | "pendingSalmon"
        | "activeFork"
        | "forkExpiresAt"
        | "hunger"
        | "thirst"
        | "joy"
        | "lastNeedsAt"
        | "lastCareAt"
        | "lastWaterAt"
        | "lastWanderPingAt"
        | "lastPlayAt"
        | "lastToyAt"
        | "hatched"
        | "toys"
        | "critical"
        | "gone"
        | "won"
        | "wonPrize"
        | "lastStage"
        | "bornAt"
        | "diedAt"
        | "careCount"
        | "deathRank"
      >
    >,
  ): Promise<Runner>;
  // Pets counting against RUNNER_SUPPLY_CAP. Excludes status "failed": a mint
  // that never produced a token must not consume supply forever.
  countRunners(): Promise<number>;
  // Every minted pet (tokenId set), for claim-time ownership resolution and the
  // OpenSea sweep. Bounded by the supply cap (2,000).
  allMintedRunners(): Promise<Runner[]>;
  // Ready pets for the idle tick engine.
  readyRunners(limit: number): Promise<Runner[]>;
  // Rows abandoned mid-mint: status "minting" and created before `cutoff`. They
  // still hold an inbox + verified-identity claim, so the reaper needs them to
  // hand those back (see reapStuckMints).
  stuckMintingRunners(cutoff: Date): Promise<Runner[]>;
  // Every row still at status "minting", whatever its age: what a fresh process
  // must re-attach (ticket persisted) or fail (no ticket) at boot, before the
  // reaper's age-based sweep gets to judge any of them.
  mintingRunners(): Promise<Runner[]>;
  // A bounded batch of alive pets that have NOT had a drama ping since `notPingedBefore`
  // (least-recently pinged first). Drives the death-feed fan-out without a 2000 broadcast.
  deathFeedBatch(limit: number, notPingedBefore: Date): Promise<Runner[]>;
  // Survival board reads (read-only, bounded; consumed by GET /api/season/board).
  // The freshest fallen pets (gone = true, minted), newest death first.
  recentlyFallen(limit: number): Promise<Runner[]>;
  // Living minted pets ranked by careCount desc (the most devoted keepers).
  topByCareCount(limit: number): Promise<Runner[]>;
  // Card Play history.
  addRunnerEvent(serial: string, type: string, message: string): Promise<RunnerEvent>;
  recentRunnerEvents(serial: string, limit: number): Promise<RunnerEvent[]>;

  // Runner Apple registrations (separate from card registrations)
  /** "full" when `reg` is a new (or superseded) device and the serial already holds the cap. */
  upsertRunnerRegistration(
    reg: Omit<RunnerDeviceRegistration, "createdAt" | "supersededAt">,
  ): Promise<"stored" | "full">;
  /** Mark every live registration of `serial` superseded (an auth rotation). Returns the count. */
  supersedeRunnerRegistrations(serial: string): Promise<number>;
  /** Drop every registration of `serial` that carries `pushToken` (APNs said the token is dead). */
  deleteRunnerRegistrationsByPushToken(serial: string, pushToken: string): Promise<number>;
  deleteRunnerRegistration(
    deviceLibraryId: string,
    passTypeId: string,
    serial: string,
  ): Promise<boolean>;
  // notBefore / memorialNotBefore are the pass epochs (runner/pass-refresh.ts): a living pass counts
  // as updated no earlier than the first, a memorial no earlier than the second.
  listRunnerSerialsForDevice(
    deviceLibraryId: string,
    passTypeId: string,
    updatedSince?: Date,
    notBefore?: Date,
    memorialNotBefore?: Date,
  ): Promise<{ serials: string[]; lastUpdated: Date }>;
  listRunnerPushTokensForSerial(serial: string): Promise<string[]>;

  // Anti-Sybil mint signals (dedup + velocity + forensics).
  recordMintAttempt(input: Omit<MintSignal, "id" | "createdAt">): Promise<MintSignal>;
  // True when this normalized-email hash has a SUCCESSFUL mint on record.
  // Read-only fast path + forensics; the WALL is the atomic reserveEmail below.
  emailAlreadyMinted(normalizedEmailHash: string): Promise<boolean>;
  // ATOMICALLY claim this normalized-email hash for a mint: true when the claim
  // is fresh, false when the email was already claimed. Backed by a unique
  // constraint (Prisma insert + P2002 catch) / a synchronous has-then-add
  // (memory), so two concurrent same-email requests can never both get true.
  // Closes the check-then-act race a read-based dedup leaves open.
  reserveEmail(normalizedEmailHash: string): Promise<boolean>;
  // Release a reservation after a mint GENUINELY failed (fulfillment marked the
  // runner "failed"): drops the atomic claim AND re-labels the hash's "minted"
  // signals to "mint_failed" (so the dedup read clears and velocity counts stop
  // charging the failed attempt). Lets the same inbox retry instead of being
  // stranded reserved-forever with no pet.
  releaseEmail(normalizedEmailHash: string): Promise<void>;
  // ATOMICALLY claim this VERIFIED Privy identity for a mint: true when the claim
  // is fresh, false when that identity already has a pet. Same race-safety pattern
  // as reserveEmail (unique-constraint insert + P2002 catch in Prisma, synchronous
  // has-then-add in memory), because it is the same kind of wall: the difference is
  // only WHAT it keys on. The email wall keys on a string that a wallet-only Privy
  // login lets the caller choose; this keys on the one identifier on that path the
  // caller cannot pick.
  reservePrivyUser(subjectHash: string): Promise<boolean>;
  // Give the identity its claim back after a mint GENUINELY failed (fulfillment
  // marked the runner "failed"), mirroring releaseEmail. Without it a keeper whose
  // mint died on an RPC error is locked out of the whole season.
  releasePrivyUser(subjectHash: string): Promise<void>;
  // DEVICE MARK (one Chi per phone). Atomically bind this browser's mark to the inbox
  // minting from it: "fresh" when the mark had no mint, "same" when it already minted
  // THIS inbox (a retry), "taken" when it minted a different inbox. Unique-constraint
  // insert (Prisma) / synchronous has-then-set (memory), like the two reserves.
  reserveDeviceMark(markHash: string, emailHash: string): Promise<"fresh" | "same" | "taken">;
  // Hand the mark back when a mint GENUINELY failed (the row went "failed"), keyed by the
  // inbox because that is what fulfillment knows. A no-op when nothing is bound.
  releaseDeviceMarkByEmail(emailHash: string): Promise<void>;
  // Undo THIS request's own fresh bind when a later gate step refuses the mint.
  releaseDeviceMark(markHash: string): Promise<void>;
  // How many pets this normalized-email hash has actually minted. Used ONLY to put
  // a ceiling on the TESTER_ALLOWLIST bypass, which otherwise skips every wall.
  countMintedByEmailHash(normalizedEmailHash: string): Promise<number>;
  // Successful-mint counts for the velocity caps (rate-limit signals).
  countByIpSince(ip: string, since: Date): Promise<number>;
  countBySubnetSince(subnet: string, since: Date): Promise<number>;
  countByFingerprintSince(fingerprint: string, since: Date): Promise<number>;

  // On-chain scoped care sessions (one per pet). See runner/session-care.ts.
  getCareSession(serial: string): Promise<CareSession | null>;
  // Install or replace a pet's session. Replacing is how a re-grant works: the
  // superseded key stays valid on-chain until it expires or is revoked there, so
  // rotating the row is a convenience, not a security boundary.
  putCareSession(input: Omit<CareSession, "createdAt" | "updatedAt" | "revokedAt" | "revokedReason" | "lastUsedAt" | "useCount">): Promise<CareSession>;
  // Mark a session unusable by the SERVER (expired, pet sold, permission error).
  // The on-chain permission is what actually bounds the key; this stops us using it.
  revokeCareSession(serial: string, reason: string): Promise<void>;
  // Bump usage stats after a successful silent care (audit trail).
  touchCareSession(serial: string): Promise<void>;

  // TAX ECONOMY holder airdrops (proof store; see runner/tax-rewards.ts).
  // Persist a posted round with its full leaf set (idempotent by roundId).
  putHolderRound(round: Omit<HolderRound, "postedAt">, leaves: HolderLeaf[]): Promise<void>;
  // Every leaf allocated to this account across all rounds (its claim set).
  holderLeavesForAccount(account: string): Promise<Array<HolderLeaf & { token: string }>>;
  // Every leaf in rounds at or after `fromRoundId`, ACROSS ALL ACCOUNTS. The 2h
  // push engine's holder leg reads this: under the no-claims law it has to find
  // the holders itself rather than wait for each one to come and ask, and
  // unclaimed rounds are eventually released back on-chain, so "nobody asked" is
  // not a state we can leave them in.
  holderLeavesSince(fromRoundId: number): Promise<Array<HolderLeaf & { token: string }>>;

  // TESTNET SHOWCASE simulated-fee drip (runner/showcase-drip.ts). reserveShowcaseDrip is an atomic
  // insert-or-conflict on (token, epoch): true = this caller owns the epoch's drip, false = it was
  // already dripped (or is being dripped right now). release undoes a reservation whose mint failed.
  reserveShowcaseDrip(token: string, epoch: number, amountRaw: string): Promise<boolean>;
  recordShowcaseDripTx(token: string, epoch: number, txHash: string): Promise<void>;
  releaseShowcaseDrip(token: string, epoch: number): Promise<void>;

  // STABLE PASS FIELDS (runner/pass-memory.ts): the last on-chain-verified value of a pass field,
  // by key ("alive", "carebal:<serial>", "life:<serial>"). Never touches Runner.updatedAt.
  getPassFieldMemory(key: string): Promise<string | null>;
  putPassFieldMemory(key: string, value: string): Promise<void>;

  // DEVICE-TRUE PASS DIFF LOG (runner/pass-diff.ts): field snapshots of served passes, keyed by
  // (serial, Last-Modified). put upserts and then keeps only the `keep` newest by lastModified.
  // list returns them newest first.
  putServedPassSnapshot(serial: string, lastModified: Date, fields: string, keep: number): Promise<void>;
  listServedPassSnapshots(serial: string): Promise<ServedPassSnapshot[]>;

  // ONE-TIME ANNOUNCEMENT (runner/announce.ts): the single active announcement text, or null.
  // The event line carries a changeMessage only while it shows exactly this text.
  getActiveAnnouncement(): Promise<string | null>;
  setActiveAnnouncement(text: string | null): Promise<void>;

  // PER-CARD ANNOUNCEMENT DELIVERY (runner/announce.ts): which cards have had their event line set
  // to a given text, ever. record is idempotent (a second call for the same pair is a no-op); list
  // returns the serials recorded for that exact text. Never touches Runner.updatedAt.
  recordAnnouncementDelivery(serial: string, text: string): Promise<void>;
  listAnnouncementDeliveries(text: string): Promise<Set<string>>;
}

export interface ServedPassSnapshot {
  serial: string;
  lastModified: Date;
  fields: string;
  servedAt: Date;
}
