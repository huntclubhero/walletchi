import { PrismaClient } from "@prisma/client";
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

// Production Store backed by Prisma/Postgres.
export class PrismaStore implements Store {
  constructor(public readonly prisma: PrismaClient) {}

  async ping(): Promise<void> {
    await this.prisma.$queryRaw`SELECT 1`;
  }

  // Legacy runner-era surface.

  async createRunner(input: Omit<Runner, "createdAt" | "updatedAt">): Promise<Runner> {
    const r = await this.prisma.runner.create({ data: input });
    return r as Runner;
  }

  async getRunner(serial: string): Promise<Runner | null> {
    return (await this.prisma.runner.findUnique({ where: { serial } })) as Runner | null;
  }

  async getRunnerByTokenId(tokenId: string): Promise<Runner | null> {
    return (await this.prisma.runner.findFirst({
      where: { tokenId },
    })) as Runner | null;
  }

  async getRunnerByAuthToken(authToken: string): Promise<Runner | null> {
    return (await this.prisma.runner.findUnique({
      where: { authToken },
    })) as Runner | null;
  }

  async updateRunner(serial: string, patch: Partial<Runner>): Promise<Runner> {
    return (await this.prisma.runner.update({
      where: { serial },
      data: patch,
    })) as Runner;
  }

  async markRunnerGone(serial: string, patch: Partial<Runner>): Promise<Runner | null> {
    const { count } = await this.prisma.runner.updateMany({
      where: { serial, gone: false },
      data: { ...patch, gone: true },
    });
    if (count !== 1) return null;
    return (await this.prisma.runner.findUnique({ where: { serial } })) as Runner | null;
  }

  async countRunners(): Promise<number> {
    // Failed mints never got a token; they must not consume supply forever.
    return this.prisma.runner.count({ where: { NOT: { status: "failed" } } });
  }

  async allMintedRunners(): Promise<Runner[]> {
    const rows = await this.prisma.runner.findMany({
      where: { NOT: { tokenId: null } },
      orderBy: { createdAt: "asc" },
    });
    return rows as Runner[];
  }

  async stuckMintingRunners(cutoff: Date): Promise<Runner[]> {
    const rows = await this.prisma.runner.findMany({
      where: { status: "minting", createdAt: { lt: cutoff } },
      orderBy: { createdAt: "asc" },
    });
    return rows as Runner[];
  }

  async mintingRunners(): Promise<Runner[]> {
    const rows = await this.prisma.runner.findMany({
      where: { status: "minting" },
      orderBy: { createdAt: "asc" },
    });
    return rows as Runner[];
  }

  async readyRunners(limit: number): Promise<Runner[]> {
    // Every ready pet (the engine decays needs for all; legacy idle surfaces are gated to
    // runs > 0 inside reconcilePet).
    const rows = await this.prisma.runner.findMany({
      where: { status: "ready", NOT: { tokenId: null } },
      orderBy: { createdAt: "asc" },
      take: limit,
    });
    return rows as Runner[];
  }

  async deathFeedBatch(limit: number, notPingedBefore: Date): Promise<Runner[]> {
    const rows = await this.prisma.runner.findMany({
      where: {
        status: "ready",
        NOT: { tokenId: null },
        gone: false,
        OR: [{ lastWanderPingAt: null }, { lastWanderPingAt: { lt: notPingedBefore } }],
      },
      orderBy: { lastWanderPingAt: { sort: "asc", nulls: "first" } },
      take: limit,
    });
    return rows as Runner[];
  }

  async recentlyFallen(limit: number): Promise<Runner[]> {
    // Newest death first; diedAt may lag persistence, so updatedAt breaks ties.
    const rows = await this.prisma.runner.findMany({
      where: { gone: true, NOT: { tokenId: null } },
      orderBy: [{ diedAt: { sort: "desc", nulls: "last" } }, { updatedAt: "desc" }],
      take: limit,
    });
    return rows as Runner[];
  }

  async topByCareCount(limit: number): Promise<Runner[]> {
    const rows = await this.prisma.runner.findMany({
      where: { gone: false, NOT: { tokenId: null } },
      orderBy: [{ careCount: "desc" }, { createdAt: "asc" }],
      take: limit,
    });
    return rows as Runner[];
  }

  async upsertRunnerRegistration(
    reg: Omit<RunnerDeviceRegistration, "createdAt" | "supersededAt">,
  ): Promise<"stored" | "full"> {
    const key = {
      deviceLibraryId_passTypeId_serial: {
        deviceLibraryId: reg.deviceLibraryId,
        passTypeId: reg.passTypeId,
        serial: reg.serial,
      },
    };
    // One registration at a time per serial. A transaction-scoped advisory lock serialises the
    // count and the insert, so a burst of newcomers can never leave more than MAX live rows.
    // (The earlier count-then-upsert-then-withdraw dance raced: two inserts whose commits land in
    // a different order than their createdAt both saw themselves inside the keep set, an eleventh
    // row survived, and the push list, newest first, silently dropped the OLDEST device, which is
    // normally the owner's first phone.) The lock is released with the transaction.
    return this.prisma.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${reg.serial}))`;
      const existing = await tx.runnerDeviceRegistration.findUnique({
        where: key,
        select: { supersededAt: true },
      });
      // A live device only rotates its push token: it already holds its slot.
      if (existing && !existing.supersededAt) {
        await tx.runnerDeviceRegistration.update({ where: key, data: { pushToken: reg.pushToken } });
        return "stored" as const;
      }
      const live = { serial: reg.serial, supersededAt: null };
      if ((await tx.runnerDeviceRegistration.count({ where: live })) >= MAX_RUNNER_REGISTRATIONS_PER_SERIAL) {
        return "full" as const;
      }
      // New, or a superseded device adding the current pass: it joins the live set as the newest.
      await tx.runnerDeviceRegistration.upsert({
        where: key,
        create: reg,
        update: { pushToken: reg.pushToken, createdAt: new Date(), supersededAt: null },
      });
      return "stored" as const;
    });
  }

  async supersedeRunnerRegistrations(serial: string): Promise<number> {
    const { count } = await this.prisma.runnerDeviceRegistration.updateMany({
      where: { serial, supersededAt: null },
      data: { supersededAt: new Date() },
    });
    return count;
  }

  async deleteRunnerRegistrationsByPushToken(serial: string, pushToken: string): Promise<number> {
    const { count } = await this.prisma.runnerDeviceRegistration.deleteMany({ where: { serial, pushToken } });
    return count;
  }

  async deleteRunnerRegistration(
    deviceLibraryId: string,
    passTypeId: string,
    serial: string,
  ): Promise<boolean> {
    try {
      await this.prisma.runnerDeviceRegistration.delete({
        where: {
          deviceLibraryId_passTypeId_serial: {
            deviceLibraryId,
            passTypeId,
            serial,
          },
        },
      });
      return true;
    } catch {
      return false;
    }
  }

  async listRunnerSerialsForDevice(
    deviceLibraryId: string,
    passTypeId: string,
    updatedSince?: Date,
  ): Promise<{ serials: string[]; lastUpdated: Date }> {
    const regs = await this.prisma.runnerDeviceRegistration.findMany({
      where: { deviceLibraryId, passTypeId },
      include: { runner: { select: { updatedAt: true } } },
    });
    // The newest content version per serial (at most PASS_DIFF_KEEP rows each).
    const rows = regs.length
      ? await this.prisma.passServedSnapshot.findMany({
          where: { serial: { in: regs.map((r) => r.serial) } },
          orderBy: { lastModified: "desc" },
          select: { serial: true, lastModified: true, servedAt: true },
        })
      : [];
    const newest = new Map<string, { lastModified: Date; servedAt: Date }>();
    for (const row of rows) if (!newest.has(row.serial)) newest.set(row.serial, row);
    const serials: string[] = [];
    let lastUpdated = new Date(0);
    for (const r of regs) {
      const v = newest.get(r.serial);
      const changedAt = v ? versionChangedAt(v) : r.runner.updatedAt;
      if (!updatedSince || changedAt > updatedSince) {
        serials.push(r.serial);
        if (changedAt > lastUpdated) lastUpdated = changedAt;
      }
    }
    return {
      serials,
      lastUpdated: lastUpdated.getTime() ? lastUpdated : new Date(),
    };
  }

  async listRunnerPushTokensForSerial(serial: string): Promise<string[]> {
    // The live set (at most MAX, newest first; a serial crowded before the cap keeps its newest),
    // then passes a recent rotation superseded, so they refresh into the keepsake view.
    const [live, superseded] = await Promise.all([
      this.prisma.runnerDeviceRegistration.findMany({
        where: { serial, supersededAt: null },
        orderBy: { createdAt: "desc" },
        take: MAX_RUNNER_REGISTRATIONS_PER_SERIAL,
        select: { pushToken: true },
      }),
      this.prisma.runnerDeviceRegistration.findMany({
        where: { serial, supersededAt: { gte: new Date(Date.now() - SUPERSEDED_REGISTRATION_PUSH_WINDOW_MS) } },
        orderBy: { supersededAt: "desc" },
        take: MAX_RUNNER_REGISTRATIONS_PER_SERIAL,
        select: { pushToken: true },
      }),
    ]);
    return [...new Set([...live, ...superseded].map((r) => r.pushToken))];
  }

  async hasLiveRunnerRegistration(serial: string): Promise<boolean> {
    return (await this.prisma.runnerDeviceRegistration.count({ where: { serial, supersededAt: null } })) > 0;
  }

  async getRunnerByGoogleObjectId(suffix: string): Promise<Runner | null> {
    const legacy = /^runner_(.+)$/.exec(suffix);
    const byRotated = (await this.prisma.runner.findFirst({ where: { googleObjectId: suffix } })) as Runner | null;
    if (byRotated) return byRotated;
    // A never-rotated pet keeps the legacy id: only match it while it still has no rotated suffix.
    if (!legacy) return null;
    const r = await this.getRunner(legacy[1]!);
    return r && !r.googleObjectId ? r : null;
  }

  async addRunnerEvent(serial: string, type: string, message: string): Promise<RunnerEvent> {
    const ev = await this.prisma.runnerEvent.create({ data: { serial, type, message } });
    return ev as RunnerEvent;
  }

  async recentRunnerEvents(serial: string, limit: number): Promise<RunnerEvent[]> {
    const rows = await this.prisma.runnerEvent.findMany({
      where: { serial },
      orderBy: { createdAt: "desc" },
      take: limit,
    });
    return rows as RunnerEvent[];
  }

  // CHI CHAT (runner/chat.ts).

  async addChatMessage(serial: string, tokenId: string, body: string, gif: string | null = null): Promise<ChatMessage> {
    return (await this.prisma.chatMessage.create({ data: { serial, tokenId, body, gif } })) as ChatMessage;
  }

  async latestChatMessages(limit: number, beforeId?: number): Promise<ChatMessage[]> {
    const rows = await this.prisma.chatMessage.findMany({
      where: { deletedAt: null, ...(beforeId !== undefined ? { id: { lt: beforeId } } : {}) },
      orderBy: { id: "desc" },
      take: limit,
    });
    return (rows as ChatMessage[]).reverse();
  }

  async chatMessagesAfter(afterId: number, limit: number): Promise<ChatMessage[]> {
    const rows = await this.prisma.chatMessage.findMany({
      where: { deletedAt: null, id: { gt: afterId } },
      orderBy: { id: "asc" },
      take: limit,
    });
    return rows as ChatMessage[];
  }

  async deleteChatMessage(id: number): Promise<ChatMessage | null> {
    const row = await this.prisma.chatMessage.findUnique({ where: { id } });
    if (!row) return null;
    if (row.deletedAt) return row as ChatMessage;
    return (await this.prisma.chatMessage.update({ where: { id }, data: { deletedAt: new Date() } })) as ChatMessage;
  }

  async getChatName(serial: string): Promise<string | null> {
    const row = await this.prisma.chatName.findUnique({ where: { serial } });
    return row?.name ?? null;
  }

  async getChatNames(serials: string[]): Promise<Map<string, string>> {
    if (serials.length === 0) return new Map();
    const rows = await this.prisma.chatName.findMany({ where: { serial: { in: serials } } });
    return new Map(rows.map((r) => [r.serial, r.name]));
  }

  async setChatName(serial: string, name: string, nameKey: string, keyOf?: (name: string) => string): Promise<"ok" | "taken"> {
    // The room is one table of at most a few thousand rows, so the re-keyed compare reads it whole.
    const rows = await this.prisma.chatName.findMany({ select: { serial: true, name: true, nameKey: true } });
    const decision = chatNameDecision(rows, serial, nameKey, keyOf);
    if (decision === "taken") return "taken";
    try {
      await this.prisma.chatName.upsert({
        where: { serial },
        create: { serial, name, nameKey: decision.storeKey },
        update: { name, nameKey: decision.storeKey },
      });
      return "ok";
    } catch (err) {
      // Two keepers picking the same name in the same instant: the unique index decides.
      if ((err as { code?: string }).code === "P2002") return "taken";
      throw err;
    }
  }

  async clearChatName(serial: string): Promise<void> {
    await this.prisma.chatName.deleteMany({ where: { serial } });
  }

  // Anti-Sybil mint signals (dedup + velocity + forensics).

  async recordMintAttempt(input: Omit<MintSignal, "id" | "createdAt">): Promise<MintSignal> {
    const rec = await this.prisma.mintSignal.create({ data: input });
    return rec as MintSignal;
  }

  async emailAlreadyMinted(normalizedEmailHash: string): Promise<boolean> {
    const claimed = await this.prisma.mintedEmail.findUnique({
      where: { emailHash: normalizedEmailHash },
      select: { emailHash: true },
    });
    if (claimed) return true;
    const row = await this.prisma.mintSignal.findFirst({
      where: { normalizedEmailHash, outcome: "minted" },
      select: { id: true },
    });
    return Boolean(row);
  }

  async reserveEmail(normalizedEmailHash: string): Promise<boolean> {
    // Atomic claim via the UNIQUE constraint: the insert either lands (fresh
    // claim) or throws P2002 (already claimed). No read-then-write window.
    try {
      await this.prisma.mintedEmail.create({ data: { emailHash: normalizedEmailHash } });
      return true;
    } catch (err) {
      if (
        typeof err === "object" &&
        err !== null &&
        (err as { code?: string }).code === "P2002"
      ) {
        return false;
      }
      throw err; // real infra error: the gate fails CLOSED on it
    }
  }

  async releaseEmail(normalizedEmailHash: string): Promise<void> {
    // deleteMany (not delete): a no-op when the row is already gone.
    await this.prisma.mintedEmail.deleteMany({ where: { emailHash: normalizedEmailHash } });
    await this.prisma.mintSignal.updateMany({
      where: { normalizedEmailHash, outcome: "minted" },
      data: { outcome: "mint_failed" },
    });
  }

  async reservePrivyUser(subjectHash: string): Promise<boolean> {
    // Identical race-safety pattern to reserveEmail above, deliberately: the
    // UNIQUE primary key makes this an insert-or-conflict, so of two concurrent
    // mints from one verified Privy session exactly one insert lands and the
    // other gets P2002. There is no read-then-write window to lose.
    try {
      await this.prisma.mintedPrivyUser.create({ data: { subjectHash } });
      return true;
    } catch (err) {
      if (
        typeof err === "object" &&
        err !== null &&
        (err as { code?: string }).code === "P2002"
      ) {
        return false;
      }
      throw err; // real infra error: the gate fails CLOSED on it
    }
  }

  async releasePrivyUser(subjectHash: string): Promise<void> {
    // deleteMany (not delete): a no-op when the row is already gone.
    await this.prisma.mintedPrivyUser.deleteMany({ where: { subjectHash } });
  }

  async reserveDeviceMark(markHash: string, emailHash: string): Promise<"fresh" | "same" | "taken"> {
    // Insert-or-conflict on the primary key, the same race-safety as the two reserves:
    // two concurrent mints from one browser can never both bind.
    try {
      await this.prisma.mintMark.create({ data: { markHash, emailHash } });
      return "fresh";
    } catch (err) {
      if (typeof err === "object" && err !== null && (err as { code?: string }).code === "P2002") {
        const row = await this.prisma.mintMark.findUnique({ where: { markHash } });
        return row && row.emailHash === emailHash ? "same" : "taken";
      }
      throw err;
    }
  }

  async releaseDeviceMarkByEmail(emailHash: string): Promise<void> {
    await this.prisma.mintMark.deleteMany({ where: { emailHash } });
  }

  async releaseDeviceMark(markHash: string): Promise<void> {
    await this.prisma.mintMark.deleteMany({ where: { markHash } });
  }

  async countMintedByEmailHash(normalizedEmailHash: string): Promise<number> {
    return this.prisma.mintSignal.count({
      where: { normalizedEmailHash, outcome: "minted" },
    });
  }

  async countByIpSince(ip: string, since: Date): Promise<number> {
    return this.prisma.mintSignal.count({
      where: { ip, outcome: "minted", createdAt: { gte: since } },
    });
  }

  async countBySubnetSince(subnet: string, since: Date): Promise<number> {
    return this.prisma.mintSignal.count({
      where: { subnet, outcome: "minted", createdAt: { gte: since } },
    });
  }

  async countByFingerprintSince(fingerprint: string, since: Date): Promise<number> {
    return this.prisma.mintSignal.count({
      where: { fingerprint, outcome: "minted", createdAt: { gte: since } },
    });
  }

  // --- On-chain scoped care sessions ---

  async getCareSession(serial: string): Promise<CareSession | null> {
    return this.prisma.careSession.findUnique({ where: { serial } });
  }

  async putCareSession(
    input: Omit<CareSession, "createdAt" | "updatedAt" | "revokedAt" | "revokedReason" | "lastUsedAt" | "useCount">,
  ): Promise<CareSession> {
    // A re-grant REPLACES the row and clears the revoke/usage state: the new key
    // is a fresh permission, so it must not inherit the old one's revocation.
    const fresh = { ...input, revokedAt: null, revokedReason: null, lastUsedAt: null, useCount: 0 };
    return this.prisma.careSession.upsert({
      where: { serial: input.serial },
      create: fresh,
      update: fresh,
    });
  }

  async revokeCareSession(serial: string, reason: string): Promise<void> {
    // HARD-DELETE the sealed key, do not merely flag the row. A revoked-but-retained
    // key is a live credential we have promised not to use, which is not the same as
    // not having it: it still sits in every backup and every DB dump. Keeping the row
    // (for the audit trail) while destroying `secretEnc` gives us the history without
    // the liability. updateMany (not update): a no-op when there is no session.
    await this.prisma.careSession.updateMany({
      where: { serial, revokedAt: null },
      data: { revokedAt: new Date(), revokedReason: reason.slice(0, 200), secretEnc: "" },
    });
  }

  async touchCareSession(serial: string): Promise<void> {
    await this.prisma.careSession.updateMany({
      where: { serial },
      data: { lastUsedAt: new Date(), useCount: { increment: 1 } },
    });
  }

  // --- TAX ECONOMY holder airdrops (proof store) ---

  async putHolderRound(
    round: Omit<HolderRound, "postedAt">,
    leaves: HolderLeaf[],
    opts?: { replaceRoot?: string },
  ): Promise<void> {
    // NEVER a blind upsert. The old version upserted and rebuilt the leaves on the theory that a
    // replacement "can only ever be the same data recomputed". 2026-10-28 proved otherwise: two
    // overlapping instances snapshotted the same round id, one posted on-chain, and the other then
    // overwrote that posted tree with its own, so every claim for the round reverted BadProof.
    // Same root is idempotent; a different root needs the caller to name the root it replaces.
    await this.prisma.$transaction(
      async (tx) => {
        const existing = await tx.holderRewardRound.findUnique({
          where: { id: round.id },
          select: { root: true, txHash: true },
        });
        if (!existing) {
          // A concurrent create for the same id fails here on the primary key: loud, never a merge.
          await tx.holderRewardRound.create({ data: { ...round } });
        } else if (sameRoot(existing.root, round.root)) {
          const n = await tx.holderRewardRound.updateMany({
            where: { id: round.id, root: existing.root },
            // A recorded txHash is never erased by a later put that does not know it.
            data: { total: round.total, token: round.token, txHash: round.txHash ?? existing.txHash },
          });
          if (n.count !== 1) throw new HolderRoundConflictError(round.id, existing.root, round.root);
          await tx.holderRewardLeaf.deleteMany({ where: { roundId: round.id } });
        } else if (opts?.replaceRoot && sameRoot(opts.replaceRoot, existing.root)) {
          await tx.holderRewardLeaf.deleteMany({ where: { roundId: round.id } });
          const n = await tx.holderRewardRound.deleteMany({ where: { id: round.id, root: existing.root } });
          if (n.count !== 1) throw new HolderRoundConflictError(round.id, existing.root, round.root);
          await tx.holderRewardRound.create({ data: { ...round } });
        } else {
          throw new HolderRoundConflictError(round.id, existing.root, round.root);
        }
        await tx.holderRewardLeaf.createMany({
          data: leaves.map((l) => ({ ...l, roundId: round.id })),
        });
      },
      { timeout: 30_000 },
    );
  }

  async holderRound(id: number): Promise<HolderRound | null> {
    return this.prisma.holderRewardRound.findUnique({
      where: { id },
      select: { id: true, root: true, total: true, token: true, txHash: true, postedAt: true },
    });
  }

  async deleteUnpostedHolderRound(id: number, root: string): Promise<boolean> {
    const row = await this.prisma.holderRewardRound.findUnique({ where: { id }, select: { root: true } });
    if (!row || !sameRoot(row.root, root)) return false;
    // Conditional on root AND a null txHash, so a round that got recorded as posted is never removed.
    // The leaves go with it (ON DELETE CASCADE).
    const n = await this.prisma.holderRewardRound.deleteMany({ where: { id, root: row.root, txHash: null } });
    return n.count === 1;
  }

  async tryAcquireJobLease(name: string, holder: string, ttlMs: number): Promise<boolean> {
    // Typed queries only (no raw SQL with Date parameters): Prisma writes DateTime as UTC, and a
    // raw Date parameter would be read through the session time zone.
    const now = new Date();
    const expiresAt = new Date(now.getTime() + ttlMs);
    // INSERT ... ON CONFLICT DO NOTHING: exactly one instance creates the row.
    const created = await this.prisma.jobLease.createMany({
      data: [{ name, holder, expiresAt }],
      skipDuplicates: true,
    });
    if (created.count === 1) return true;
    // Renew our own lease, or take over an expired one. Postgres re-checks the WHERE under the row
    // lock, so two instances racing for the same expired lease cannot both win.
    const taken = await this.prisma.jobLease.updateMany({
      where: { name, OR: [{ holder }, { expiresAt: { lt: now } }] },
      data: { holder, expiresAt },
    });
    return taken.count === 1;
  }

  async releaseJobLease(name: string, holder: string): Promise<void> {
    await this.prisma.jobLease.deleteMany({ where: { name, holder } });
  }

  async holderLeavesForAccount(account: string): Promise<Array<HolderLeaf & { token: string; root: string }>> {
    const rows = await this.prisma.holderRewardLeaf.findMany({
      where: { account },
      include: { round: { select: { token: true, root: true } } },
      orderBy: { roundId: "asc" },
    });
    return rows.map((r) => ({
      roundId: r.roundId,
      account: r.account,
      amount: r.amount,
      proof: r.proof,
      token: r.round.token,
      root: r.round.root,
    }));
  }

  async reserveShowcaseDrip(token: string, epoch: number, amountRaw: string): Promise<boolean> {
    // Same race-safety pattern as reserveEmail: the composite primary key makes this an
    // insert-or-conflict, so exactly one caller per (token, epoch) ever sends the mint.
    try {
      await this.prisma.showcaseDrip.create({ data: { token: token.toLowerCase(), epoch, amountRaw } });
      return true;
    } catch (err) {
      if (typeof err === "object" && err !== null && (err as { code?: string }).code === "P2002") {
        return false;
      }
      throw err;
    }
  }

  async recordShowcaseDripTx(token: string, epoch: number, txHash: string): Promise<void> {
    await this.prisma.showcaseDrip.updateMany({ where: { token: token.toLowerCase(), epoch }, data: { txHash } });
  }

  async releaseShowcaseDrip(token: string, epoch: number): Promise<void> {
    await this.prisma.showcaseDrip.deleteMany({ where: { token: token.toLowerCase(), epoch } });
  }

  async getActiveAnnouncement(): Promise<string | null> {
    const row = await this.prisma.announcement.findUnique({ where: { id: "active" }, select: { text: true } });
    return row?.text ?? null;
  }

  async setActiveAnnouncement(text: string | null): Promise<void> {
    if (text === null) {
      await this.prisma.announcement.deleteMany({ where: { id: "active" } });
      return;
    }
    await this.prisma.announcement.upsert({
      where: { id: "active" },
      create: { id: "active", text },
      update: { text, setAt: new Date() },
    });
  }

  async recordAnnouncementDelivery(serial: string, text: string): Promise<void> {
    // Idempotent: the (serial, text) pair is the primary key and a repeat changes nothing, not even
    // deliveredAt (the first delivery is the one that mattered).
    await this.prisma.announcementDelivery.createMany({ data: [{ serial, text }], skipDuplicates: true });
  }

  async listAnnouncementDeliveries(text: string): Promise<Set<string>> {
    const rows = await this.prisma.announcementDelivery.findMany({ where: { text }, select: { serial: true } });
    return new Set(rows.map((r) => r.serial));
  }

  async getPassFieldMemory(key: string): Promise<string | null> {
    const row = await this.prisma.passFieldMemory.findUnique({ where: { key }, select: { value: true } });
    return row?.value ?? null;
  }

  async putPassFieldMemory(key: string, value: string): Promise<void> {
    await this.prisma.passFieldMemory.upsert({ where: { key }, create: { key, value }, update: { value } });
  }

  async putServedPassSnapshot(serial: string, lastModified: Date, fields: string, keep: number, servedAt?: Date): Promise<void> {
    // servedAt is the FIRST write of this version (runner/pass-gate.ts); an update keeps it.
    await this.prisma.passServedSnapshot.upsert({
      where: { serial_lastModified: { serial, lastModified } },
      create: { serial, lastModified, fields, servedAt: servedAt ?? new Date() },
      update: { fields },
    });
    // Bounded: keep only the newest `keep` snapshots for this serial.
    const stale = await this.prisma.passServedSnapshot.findMany({
      where: { serial },
      orderBy: { lastModified: "desc" },
      skip: Math.max(1, keep),
      select: { lastModified: true },
    });
    if (stale.length) {
      await this.prisma.passServedSnapshot.deleteMany({
        where: { serial, lastModified: { in: stale.map((s) => s.lastModified) } },
      });
    }
  }

  async listServedPassSnapshots(serial: string): Promise<ServedPassSnapshot[]> {
    return this.prisma.passServedSnapshot.findMany({ where: { serial }, orderBy: { lastModified: "desc" } });
  }

  async holderLeavesSince(fromRoundId: number): Promise<Array<HolderLeaf & { token: string; root: string }>> {
    const rows = await this.prisma.holderRewardLeaf.findMany({
      where: { roundId: { gte: fromRoundId } },
      include: { round: { select: { token: true, root: true } } },
      orderBy: [{ roundId: "asc" }, { account: "asc" }],
    });
    return rows.map((r) => ({
      roundId: r.roundId,
      account: r.account,
      amount: r.amount,
      proof: r.proof,
      token: r.round.token,
      root: r.round.root,
    }));
  }
}

function sameRoot(a: string, b: string): boolean {
  return a.toLowerCase() === b.toLowerCase();
}

// Cache the client across hot reloads / serverless invocations.
let _prisma: PrismaClient | null = null;
export function getPrisma(): PrismaClient {
  if (!_prisma) {
    _prisma = new PrismaClient();
  }
  return _prisma;
}
