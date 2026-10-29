import { randomUUID } from "node:crypto";
import {
  chatNameDecision,
  HolderRoundConflictError,
  MAX_RUNNER_REGISTRATIONS_PER_SERIAL,
  SUPERSEDED_REGISTRATION_PUSH_WINDOW_MS,
} from "./types.js";
import { versionChangedAt } from "../runner/pass-time.js";
import type {
  CareSession,
  ChatMessage,
  HolderLeaf,
  HolderRound,
  MintSignal,
  Runner,
  RunnerDeviceRegistration,
  RunnerEvent,
  ServedPassSnapshot,
  Store,
} from "./types.js";

// In-memory Store. Used by scripts/smoke.ts so the state machine can be exercised
// without Postgres. Production uses PrismaStore. Same interface, real logic.
export class InMemoryStore implements Store {
  private runners = new Map<string, Runner>();
  private runnersByToken = new Map<string, string>(); // tokenId -> serial
  private runnerRegistrations = new Map<string, RunnerDeviceRegistration>();
  private runnerEvents: RunnerEvent[] = [];
  private chatMessages: ChatMessage[] = []; // ascending id
  private nextChatId = 1;
  private chatNames = new Map<string, { name: string; nameKey: string }>();
  private mintSignals: MintSignal[] = [];
  private mintedEmails = new Set<string>();
  private mintedPrivyUsers = new Set<string>();
  private mintMarks = new Map<string, string>(); // markHash -> emailHash
  private careSessions = new Map<string, CareSession>();

  async ping(): Promise<void> {}

  async createRunner(input: Omit<Runner, "createdAt" | "updatedAt">): Promise<Runner> {
    const now = new Date();
    const runner: Runner = { ...input, createdAt: now, updatedAt: now };
    this.runners.set(runner.serial, runner);
    if (runner.tokenId) this.runnersByToken.set(runner.tokenId, runner.serial);
    return runner;
  }

  async getRunner(serial: string): Promise<Runner | null> {
    return this.runners.get(serial) ?? null;
  }

  async getRunnerByTokenId(tokenId: string): Promise<Runner | null> {
    const serial = this.runnersByToken.get(tokenId);
    return serial ? (this.runners.get(serial) ?? null) : null;
  }

  async getRunnerByAuthToken(authToken: string): Promise<Runner | null> {
    for (const rnr of this.runners.values()) {
      if (rnr.authToken === authToken) return rnr;
    }
    return null;
  }

  async updateRunner(serial: string, patch: Partial<Runner>): Promise<Runner> {
    const rnr = this.runners.get(serial);
    if (!rnr) throw new Error(`runner ${serial} not found`);
    const next = { ...rnr, ...patch, updatedAt: new Date() };
    this.runners.set(serial, next);
    if (next.tokenId) this.runnersByToken.set(next.tokenId, serial);
    return next;
  }

  async markRunnerGone(serial: string, patch: Partial<Runner>): Promise<Runner | null> {
    const rnr = this.runners.get(serial);
    if (!rnr || rnr.gone) return null;
    return this.updateRunner(serial, { ...patch, gone: true });
  }

  async countRunners(): Promise<number> {
    // Failed mints never got a token; they must not consume supply forever.
    return [...this.runners.values()].filter((r) => r.status !== "failed").length;
  }

  async allMintedRunners(): Promise<Runner[]> {
    return [...this.runners.values()]
      .filter((r) => Boolean(r.tokenId))
      .sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime());
  }

  async stuckMintingRunners(cutoff: Date): Promise<Runner[]> {
    return [...this.runners.values()]
      .filter((r) => r.status === "minting" && r.createdAt.getTime() < cutoff.getTime())
      .sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime());
  }

  async mintingRunners(): Promise<Runner[]> {
    return [...this.runners.values()]
      .filter((r) => r.status === "minting")
      .sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime());
  }

  async readyRunners(limit: number): Promise<Runner[]> {
    // Every ready pet (the engine decays needs for all; legacy idle surfaces are gated to
    // runs > 0 inside reconcilePet).
    return [...this.runners.values()]
      .filter((r) => r.status === "ready" && Boolean(r.tokenId))
      .sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime())
      .slice(0, limit);
  }

  async deathFeedBatch(limit: number, notPingedBefore: Date): Promise<Runner[]> {
    return [...this.runners.values()]
      .filter(
        (r) =>
          r.status === "ready" &&
          Boolean(r.tokenId) &&
          !r.gone &&
          (!r.lastWanderPingAt || r.lastWanderPingAt.getTime() < notPingedBefore.getTime()),
      )
      .sort((a, b) => (a.lastWanderPingAt?.getTime() ?? 0) - (b.lastWanderPingAt?.getTime() ?? 0))
      .slice(0, limit);
  }

  async recentlyFallen(limit: number): Promise<Runner[]> {
    // Newest death first; diedAt may lag persistence, so updatedAt is the fallback.
    const deathTime = (r: Runner) => (r.diedAt ?? r.updatedAt).getTime();
    return [...this.runners.values()]
      .filter((r) => r.gone && Boolean(r.tokenId))
      .sort((a, b) => deathTime(b) - deathTime(a))
      .slice(0, limit);
  }

  async topByCareCount(limit: number): Promise<Runner[]> {
    return [...this.runners.values()]
      .filter((r) => !r.gone && Boolean(r.tokenId))
      .sort((a, b) => b.careCount - a.careCount || a.createdAt.getTime() - b.createdAt.getTime())
      .slice(0, limit);
  }

  private runnerRegKey(d: string, p: string, s: string) {
    return `${d}::${p}::${s}`;
  }

  async upsertRunnerRegistration(
    reg: Omit<RunnerDeviceRegistration, "createdAt" | "supersededAt">,
  ): Promise<"stored" | "full"> {
    const key = this.runnerRegKey(reg.deviceLibraryId, reg.passTypeId, reg.serial);
    const existing = this.runnerRegistrations.get(key);
    // A live device only rotates its push token: it keeps its slot and its place in the order.
    if (existing && !existing.supersededAt) {
      existing.pushToken = reg.pushToken;
      return "stored";
    }
    const live = [...this.runnerRegistrations.values()].filter((r) => r.serial === reg.serial && !r.supersededAt);
    if (live.length >= MAX_RUNNER_REGISTRATIONS_PER_SERIAL) return "full";
    // Delete first so Map order is registration order (a superseded device rejoins as the newest).
    this.runnerRegistrations.delete(key);
    this.runnerRegistrations.set(key, { ...reg, createdAt: new Date(), supersededAt: null });
    return "stored";
  }

  async supersedeRunnerRegistrations(serial: string): Promise<number> {
    const at = new Date();
    let n = 0;
    for (const r of this.runnerRegistrations.values()) {
      if (r.serial === serial && !r.supersededAt) {
        r.supersededAt = at;
        n += 1;
      }
    }
    return n;
  }

  async deleteRunnerRegistrationsByPushToken(serial: string, pushToken: string): Promise<number> {
    let n = 0;
    for (const [k, r] of this.runnerRegistrations) {
      if (r.serial === serial && r.pushToken === pushToken) {
        this.runnerRegistrations.delete(k);
        n += 1;
      }
    }
    return n;
  }

  async deleteRunnerRegistration(
    deviceLibraryId: string,
    passTypeId: string,
    serial: string,
  ): Promise<boolean> {
    return this.runnerRegistrations.delete(
      this.runnerRegKey(deviceLibraryId, passTypeId, serial),
    );
  }

  async listRunnerSerialsForDevice(
    deviceLibraryId: string,
    passTypeId: string,
    updatedSince?: Date,
  ): Promise<{ serials: string[]; lastUpdated: Date }> {
    const serials: string[] = [];
    let lastUpdated = new Date(0);
    for (const r of this.runnerRegistrations.values()) {
      if (r.deviceLibraryId !== deviceLibraryId || r.passTypeId !== passTypeId)
        continue;
      const runner = this.runners.get(r.serial);
      if (!runner) continue;
      // A pass counts as updated when its content changed (see store/types.ts).
      const v = this.servedPassSnapshots.get(r.serial)?.[0];
      const changedAt = v ? versionChangedAt(v) : runner.updatedAt;
      if (!updatedSince || changedAt > updatedSince) {
        serials.push(r.serial);
        if (changedAt > lastUpdated) lastUpdated = changedAt;
      }
    }
    return { serials, lastUpdated: lastUpdated.getTime() ? lastUpdated : new Date() };
  }

  async listRunnerPushTokensForSerial(serial: string): Promise<string[]> {
    const live: string[] = [];
    const superseded: { token: string; at: number }[] = [];
    const since = Date.now() - SUPERSEDED_REGISTRATION_PUSH_WINDOW_MS;
    for (const r of this.runnerRegistrations.values()) {
      if (r.serial !== serial) continue;
      if (!r.supersededAt) live.push(r.pushToken);
      else if (r.supersededAt.getTime() >= since) superseded.push({ token: r.pushToken, at: r.supersededAt.getTime() });
    }
    // Map order is registration order: the live set newest first (at most MAX), then the passes a
    // recent rotation superseded, so they refresh into the keepsake view (as prisma.ts).
    const recent = superseded.sort((a, b) => b.at - a.at).slice(0, MAX_RUNNER_REGISTRATIONS_PER_SERIAL).map((s) => s.token);
    return [...new Set([...live.slice(-MAX_RUNNER_REGISTRATIONS_PER_SERIAL).reverse(), ...recent])];
  }

  async hasLiveRunnerRegistration(serial: string): Promise<boolean> {
    for (const r of this.runnerRegistrations.values()) if (r.serial === serial && !r.supersededAt) return true;
    return false;
  }

  async getRunnerByGoogleObjectId(suffix: string): Promise<Runner | null> {
    for (const r of this.runners.values()) if (r.googleObjectId === suffix) return r;
    const legacy = /^runner_(.+)$/.exec(suffix);
    if (!legacy) return null;
    const r = this.runners.get(legacy[1]!) ?? null;
    return r && !r.googleObjectId ? r : null;
  }

  async addRunnerEvent(serial: string, type: string, message: string): Promise<RunnerEvent> {
    const ev: RunnerEvent = { id: randomUUID(), serial, type, message, createdAt: new Date() };
    this.runnerEvents.push(ev);
    return ev;
  }

  async recentRunnerEvents(serial: string, limit: number): Promise<RunnerEvent[]> {
    return this.runnerEvents
      .filter((e) => e.serial === serial)
      .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime())
      .slice(0, limit);
  }

  // CHI CHAT (parity with PrismaStore; the chat check needs no DB).

  async addChatMessage(serial: string, tokenId: string, body: string, gif: string | null = null): Promise<ChatMessage> {
    const m: ChatMessage = { id: this.nextChatId++, serial, tokenId, body, gif, deletedAt: null, createdAt: new Date() };
    this.chatMessages.push(m);
    return { ...m };
  }

  async latestChatMessages(limit: number, beforeId?: number): Promise<ChatMessage[]> {
    const live = this.chatMessages.filter((m) => m.deletedAt === null && (beforeId === undefined || m.id < beforeId));
    return live.slice(Math.max(0, live.length - limit)).map((m) => ({ ...m }));
  }

  async chatMessagesAfter(afterId: number, limit: number): Promise<ChatMessage[]> {
    return this.chatMessages.filter((m) => m.deletedAt === null && m.id > afterId).slice(0, limit).map((m) => ({ ...m }));
  }

  async deleteChatMessage(id: number): Promise<ChatMessage | null> {
    const m = this.chatMessages.find((x) => x.id === id);
    if (!m) return null;
    if (m.deletedAt === null) m.deletedAt = new Date();
    return { ...m };
  }

  async getChatName(serial: string): Promise<string | null> {
    return this.chatNames.get(serial)?.name ?? null;
  }

  async getChatNames(serials: string[]): Promise<Map<string, string>> {
    const out = new Map<string, string>();
    for (const s of serials) {
      const n = this.chatNames.get(s);
      if (n) out.set(s, n.name);
    }
    return out;
  }

  async setChatName(serial: string, name: string, nameKey: string, keyOf?: (name: string) => string): Promise<"ok" | "taken"> {
    const rows = [...this.chatNames].map(([s, n]) => ({ serial: s, name: n.name, nameKey: n.nameKey }));
    const decision = chatNameDecision(rows, serial, nameKey, keyOf);
    if (decision === "taken") return "taken";
    this.chatNames.set(serial, { name, nameKey: decision.storeKey });
    return "ok";
  }

  /** Test hook: plant a row saved under an older key rule (the review's legacy-key case). */
  _putLegacyChatName(serial: string, name: string, nameKey: string): void {
    this.chatNames.set(serial, { name, nameKey });
  }

  async clearChatName(serial: string): Promise<void> {
    this.chatNames.delete(serial);
  }

  // Anti-Sybil mint signals (parity with PrismaStore; smoke needs no DB).

  async recordMintAttempt(input: Omit<MintSignal, "id" | "createdAt">): Promise<MintSignal> {
    const rec: MintSignal = { ...input, id: randomUUID(), createdAt: new Date() };
    this.mintSignals.push(rec);
    return rec;
  }

  async emailAlreadyMinted(normalizedEmailHash: string): Promise<boolean> {
    return (
      this.mintedEmails.has(normalizedEmailHash) ||
      this.mintSignals.some(
        (s) => s.outcome === "minted" && s.normalizedEmailHash === normalizedEmailHash,
      )
    );
  }

  async reserveEmail(normalizedEmailHash: string): Promise<boolean> {
    // Synchronous has-then-add: no await between check and claim, so two
    // concurrent requests can never both reserve (parity with the Prisma
    // unique-constraint insert).
    if (this.mintedEmails.has(normalizedEmailHash)) return false;
    this.mintedEmails.add(normalizedEmailHash);
    return true;
  }

  async releaseEmail(normalizedEmailHash: string): Promise<void> {
    this.mintedEmails.delete(normalizedEmailHash);
    for (const s of this.mintSignals) {
      if (s.normalizedEmailHash === normalizedEmailHash && s.outcome === "minted") {
        s.outcome = "mint_failed";
      }
    }
  }

  async reservePrivyUser(subjectHash: string): Promise<boolean> {
    // Synchronous has-then-add, exactly like reserveEmail: no await between the
    // check and the claim, so two concurrent mints from one verified Privy
    // session can never both reserve (parity with the Prisma unique insert).
    if (this.mintedPrivyUsers.has(subjectHash)) return false;
    this.mintedPrivyUsers.add(subjectHash);
    return true;
  }

  async releasePrivyUser(subjectHash: string): Promise<void> {
    this.mintedPrivyUsers.delete(subjectHash);
  }

  async reserveDeviceMark(markHash: string, emailHash: string): Promise<"fresh" | "same" | "taken"> {
    // Synchronous has-then-set, parity with the Prisma unique insert.
    const bound = this.mintMarks.get(markHash);
    if (bound !== undefined) return bound === emailHash ? "same" : "taken";
    this.mintMarks.set(markHash, emailHash);
    return "fresh";
  }

  async releaseDeviceMarkByEmail(emailHash: string): Promise<void> {
    for (const [k, v] of this.mintMarks) if (v === emailHash) this.mintMarks.delete(k);
  }

  async releaseDeviceMark(markHash: string): Promise<void> {
    this.mintMarks.delete(markHash);
  }

  async countMintedByEmailHash(normalizedEmailHash: string): Promise<number> {
    return this.mintSignals.filter(
      (s) => s.outcome === "minted" && s.normalizedEmailHash === normalizedEmailHash,
    ).length;
  }

  async countByIpSince(ip: string, since: Date): Promise<number> {
    return this.mintSignals.filter(
      (s) => s.outcome === "minted" && s.ip === ip && s.createdAt >= since,
    ).length;
  }

  async countBySubnetSince(subnet: string, since: Date): Promise<number> {
    return this.mintSignals.filter(
      (s) => s.outcome === "minted" && s.subnet === subnet && s.createdAt >= since,
    ).length;
  }

  async countByFingerprintSince(fingerprint: string, since: Date): Promise<number> {
    return this.mintSignals.filter(
      (s) => s.outcome === "minted" && s.fingerprint === fingerprint && s.createdAt >= since,
    ).length;
  }

  // --- On-chain scoped care sessions ---

  async getCareSession(serial: string): Promise<CareSession | null> {
    return this.careSessions.get(serial) ?? null;
  }

  async putCareSession(
    input: Omit<CareSession, "createdAt" | "updatedAt" | "revokedAt" | "revokedReason" | "lastUsedAt" | "useCount">,
  ): Promise<CareSession> {
    const now = new Date();
    const existing = this.careSessions.get(input.serial);
    // A re-grant replaces the row outright (fresh permission, cleared revoke state).
    const row: CareSession = {
      ...input,
      revokedAt: null,
      revokedReason: null,
      lastUsedAt: null,
      useCount: 0,
      createdAt: existing?.createdAt ?? now,
      updatedAt: now,
    };
    this.careSessions.set(row.serial, row);
    return row;
  }

  async revokeCareSession(serial: string, reason: string): Promise<void> {
    const row = this.careSessions.get(serial);
    if (!row || row.revokedAt) return;
    row.revokedAt = new Date();
    row.revokedReason = reason.slice(0, 200);
    row.secretEnc = ""; // destroy the sealed key, matching PrismaStore
    row.updatedAt = new Date();
  }

  async touchCareSession(serial: string): Promise<void> {
    const row = this.careSessions.get(serial);
    if (!row) return;
    row.lastUsedAt = new Date();
    row.useCount += 1;
    row.updatedAt = new Date();
  }

  // --- TAX ECONOMY holder airdrops (proof store) ---
  private holderRounds = new Map<number, HolderRound>();
  // TESTNET SHOWCASE drip ledger, keyed `${token}:${epoch}`. Synchronous has-then-set, so two
  // concurrent cycles can never both reserve (parity with the Prisma primary-key insert).
  readonly showcaseDrips = new Map<string, { amountRaw: string; txHash: string | null }>();

  async reserveShowcaseDrip(token: string, epoch: number, amountRaw: string): Promise<boolean> {
    const key = `${token.toLowerCase()}:${epoch}`;
    if (this.showcaseDrips.has(key)) return false;
    this.showcaseDrips.set(key, { amountRaw, txHash: null });
    return true;
  }

  async recordShowcaseDripTx(token: string, epoch: number, txHash: string): Promise<void> {
    const row = this.showcaseDrips.get(`${token.toLowerCase()}:${epoch}`);
    if (row) row.txHash = txHash;
  }

  async releaseShowcaseDrip(token: string, epoch: number): Promise<void> {
    this.showcaseDrips.delete(`${token.toLowerCase()}:${epoch}`);
  }

  // --- STABLE PASS FIELDS + DEVICE-TRUE PASS DIFF LOG ---
  readonly passFieldMemory = new Map<string, string>();
  readonly servedPassSnapshots = new Map<string, ServedPassSnapshot[]>();

  async getPassFieldMemory(key: string): Promise<string | null> {
    return this.passFieldMemory.get(key) ?? null;
  }

  async putPassFieldMemory(key: string, value: string): Promise<void> {
    this.passFieldMemory.set(key, value);
  }

  async putServedPassSnapshot(serial: string, lastModified: Date, fields: string, keep: number, servedAt?: Date): Promise<void> {
    const all = this.servedPassSnapshots.get(serial) ?? [];
    const same = all.find((r) => r.lastModified.getTime() === lastModified.getTime());
    const rows = all.filter((r) => r !== same);
    // servedAt is the FIRST write of this version; an update keeps it (as prisma.ts).
    rows.push({ serial, lastModified: new Date(lastModified), fields, servedAt: same?.servedAt ?? new Date(servedAt ?? Date.now()) });
    rows.sort((a, b) => b.lastModified.getTime() - a.lastModified.getTime());
    this.servedPassSnapshots.set(serial, rows.slice(0, Math.max(1, keep)));
  }

  async listServedPassSnapshots(serial: string): Promise<ServedPassSnapshot[]> {
    return (this.servedPassSnapshots.get(serial) ?? []).map((r) => ({ ...r }));
  }

  // ONE-TIME ANNOUNCEMENT (runner/announce.ts)
  activeAnnouncement: string | null = null;

  async getActiveAnnouncement(): Promise<string | null> {
    return this.activeAnnouncement;
  }

  async setActiveAnnouncement(text: string | null): Promise<void> {
    this.activeAnnouncement = text;
  }

  // PER-CARD ANNOUNCEMENT DELIVERY (runner/announce.ts): text -> serials that got it.
  private announcementDeliveries = new Map<string, Set<string>>();

  async recordAnnouncementDelivery(serial: string, text: string): Promise<void> {
    let set = this.announcementDeliveries.get(text);
    if (!set) {
      set = new Set();
      this.announcementDeliveries.set(text, set);
    }
    set.add(serial);
  }

  async listAnnouncementDeliveries(text: string): Promise<Set<string>> {
    return new Set(this.announcementDeliveries.get(text) ?? []);
  }

  private holderLeaves = new Map<number, HolderLeaf[]>();
  private jobLeases = new Map<string, { holder: string; expiresAt: number }>();

  // Same contract as PrismaStore.putHolderRound: same root is idempotent, a different root is
  // refused unless the caller names the root it replaces.
  async putHolderRound(
    round: Omit<HolderRound, "postedAt">,
    leaves: HolderLeaf[],
    opts?: { replaceRoot?: string },
  ): Promise<void> {
    const existing = this.holderRounds.get(round.id);
    const same = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();
    if (existing && !same(existing.root, round.root)) {
      if (!opts?.replaceRoot || !same(opts.replaceRoot, existing.root)) {
        throw new HolderRoundConflictError(round.id, existing.root, round.root);
      }
      this.holderRounds.delete(round.id);
    }
    const kept = this.holderRounds.get(round.id);
    this.holderRounds.set(round.id, {
      ...round,
      root: kept?.root ?? round.root,
      txHash: round.txHash ?? kept?.txHash ?? null,
      postedAt: kept?.postedAt ?? new Date(),
    });
    this.holderLeaves.set(round.id, leaves.map((l) => ({ ...l, roundId: round.id })));
  }

  async holderRound(id: number): Promise<HolderRound | null> {
    const r = this.holderRounds.get(id);
    return r ? { ...r } : null;
  }

  async deleteUnpostedHolderRound(id: number, root: string): Promise<boolean> {
    const r = this.holderRounds.get(id);
    if (!r || r.txHash || r.root.toLowerCase() !== root.toLowerCase()) return false;
    this.holderRounds.delete(id);
    this.holderLeaves.delete(id);
    return true;
  }

  /** Test hook: backdate a stored round so the stale-unposted rule can be exercised. */
  _backdateHolderRound(id: number, postedAt: Date): void {
    const r = this.holderRounds.get(id);
    if (r) r.postedAt = postedAt;
  }

  async holderLeavesForAccount(account: string): Promise<Array<HolderLeaf & { token: string; root: string }>> {
    const out: Array<HolderLeaf & { token: string; root: string }> = [];
    for (const [roundId, leaves] of [...this.holderLeaves.entries()].sort((a, b) => a[0] - b[0])) {
      const round = this.holderRounds.get(roundId);
      const token = round?.token ?? "";
      const root = round?.root ?? "";
      for (const l of leaves) if (l.account === account) out.push({ ...l, token, root });
    }
    return out;
  }

  async holderLeavesSince(fromRoundId: number): Promise<Array<HolderLeaf & { token: string; root: string }>> {
    const out: Array<HolderLeaf & { token: string; root: string }> = [];
    for (const [roundId, leaves] of [...this.holderLeaves.entries()].sort((a, b) => a[0] - b[0])) {
      if (roundId < fromRoundId) continue;
      const round = this.holderRounds.get(roundId);
      const token = round?.token ?? "";
      const root = round?.root ?? "";
      for (const l of leaves) out.push({ ...l, token, root });
    }
    return out;
  }

  async tryAcquireJobLease(name: string, holder: string, ttlMs: number): Promise<boolean> {
    const now = Date.now();
    const cur = this.jobLeases.get(name);
    if (cur && cur.holder !== holder && cur.expiresAt >= now) return false;
    this.jobLeases.set(name, { holder, expiresAt: now + ttlMs });
    return true;
  }

  async releaseJobLease(name: string, holder: string): Promise<void> {
    if (this.jobLeases.get(name)?.holder === holder) this.jobLeases.delete(name);
  }
}
