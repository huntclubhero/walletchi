import { PrismaClient } from "@prisma/client";
import { MAX_RUNNER_REGISTRATIONS_PER_SERIAL } from "./types.js";
import type {
  CareSession,
  HolderLeaf,
  HolderRound,
  MintSignal,
  Runner,
  RunnerDeviceRegistration,
  RunnerEvent,
  Store,
} from "./types.js";

// Most stale registrations one upsert deletes (two bind parameters each; Postgres allows 32767).
const RUNNER_REGISTRATION_TRIM_BATCH = 500;

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
    reg: Omit<RunnerDeviceRegistration, "createdAt">,
  ): Promise<void> {
    await this.prisma.runnerDeviceRegistration.upsert({
      where: {
        deviceLibraryId_passTypeId_serial: {
          deviceLibraryId: reg.deviceLibraryId,
          passTypeId: reg.passTypeId,
          serial: reg.serial,
        },
      },
      create: reg,
      // createdAt doubles as "last registered", so a rotating device is never the oldest.
      update: { pushToken: reg.pushToken, createdAt: new Date() },
    });
    // Keep the newest MAX per serial (this row is always among them). A serial that was crowded
    // before the cap existed is trimmed oldest first, at most TRIM_BATCH rows per registration, so
    // one request never builds a delete too large for Postgres; the rest goes on later registrations.
    const others = {
      serial: reg.serial,
      NOT: { deviceLibraryId: reg.deviceLibraryId, passTypeId: reg.passTypeId },
    };
    const surplus =
      (await this.prisma.runnerDeviceRegistration.count({ where: others })) -
      (MAX_RUNNER_REGISTRATIONS_PER_SERIAL - 1);
    if (surplus > 0) {
      const stale = await this.prisma.runnerDeviceRegistration.findMany({
        where: others,
        orderBy: { createdAt: "asc" },
        take: Math.min(surplus, RUNNER_REGISTRATION_TRIM_BATCH),
        select: { deviceLibraryId: true, passTypeId: true },
      });
      await this.prisma.runnerDeviceRegistration.deleteMany({
        where: { serial: reg.serial, OR: stale },
      });
    }
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
      include: { runner: true },
    });
    const serials: string[] = [];
    let lastUpdated = new Date(0);
    for (const r of regs) {
      const updatedAt = r.runner.updatedAt;
      if (!updatedSince || updatedAt > updatedSince) {
        serials.push(r.serial);
        if (updatedAt > lastUpdated) lastUpdated = updatedAt;
      }
    }
    return {
      serials,
      lastUpdated: lastUpdated.getTime() ? lastUpdated : new Date(),
    };
  }

  async listRunnerPushTokensForSerial(serial: string): Promise<string[]> {
    // Only the newest MAX, the ones the trim keeps, so rows past the cap never get a push.
    const regs = await this.prisma.runnerDeviceRegistration.findMany({
      where: { serial },
      orderBy: { createdAt: "desc" },
      take: MAX_RUNNER_REGISTRATIONS_PER_SERIAL,
      select: { pushToken: true },
    });
    return regs.map((r) => r.pushToken);
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

  async putHolderRound(round: Omit<HolderRound, "postedAt">, leaves: HolderLeaf[]): Promise<void> {
    // Idempotent by roundId: re-posting after a crash replaces the leaf set
    // atomically with the round row (the on-chain round is append-only, so a
    // replacement can only ever be the same data recomputed).
    await this.prisma.$transaction([
      this.prisma.holderRewardRound.upsert({
        where: { id: round.id },
        create: { ...round },
        update: { root: round.root, total: round.total, token: round.token, txHash: round.txHash },
      }),
      this.prisma.holderRewardLeaf.deleteMany({ where: { roundId: round.id } }),
      this.prisma.holderRewardLeaf.createMany({
        data: leaves.map((l) => ({ ...l, roundId: round.id })),
      }),
    ]);
  }

  async holderLeavesForAccount(account: string): Promise<Array<HolderLeaf & { token: string }>> {
    const rows = await this.prisma.holderRewardLeaf.findMany({
      where: { account },
      include: { round: { select: { token: true } } },
      orderBy: { roundId: "asc" },
    });
    return rows.map((r) => ({
      roundId: r.roundId,
      account: r.account,
      amount: r.amount,
      proof: r.proof,
      token: r.round.token,
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

  async holderLeavesSince(fromRoundId: number): Promise<Array<HolderLeaf & { token: string }>> {
    const rows = await this.prisma.holderRewardLeaf.findMany({
      where: { roundId: { gte: fromRoundId } },
      include: { round: { select: { token: true } } },
      orderBy: [{ roundId: "asc" }, { account: "asc" }],
    });
    return rows.map((r) => ({
      roundId: r.roundId,
      account: r.account,
      amount: r.amount,
      proof: r.proof,
      token: r.round.token,
    }));
  }
}

// Cache the client across hot reloads / serverless invocations.
let _prisma: PrismaClient | null = null;
export function getPrisma(): PrismaClient {
  if (!_prisma) {
    _prisma = new PrismaClient();
  }
  return _prisma;
}
