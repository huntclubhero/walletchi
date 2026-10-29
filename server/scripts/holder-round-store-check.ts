/**
 * HOLDER ROUND PROOF STORE + JOB LEASE CHECK (store putHolderRound / holderRound /
 * deleteUnpostedHolderRound / tryAcquireJobLease / releaseJobLease).
 *
 * Born 2026-10-29. On 2026-10-28 two overlapping deploys both ran the holder round job for round 87;
 * one posted it on-chain and the other then REPLACED the stored tree (the store upserted), so every
 * claim for 87 reverted BadProof. This pins the store half of the fix on BOTH stores:
 *   - a different root for a stored round id is refused (HolderRoundConflictError), the stored tree
 *     is untouched, and a concurrent pair of puts for a NEW id lands exactly one tree;
 *   - the same root is idempotent and never erases a recorded txHash;
 *   - replaceRoot is a compare and swap (naming the wrong root is refused);
 *   - deleteUnpostedHolderRound removes only an unposted tree with the named root;
 *   - leaf reads carry the round's root (the delivery-side root check reads it);
 *   - the lease: one winner among concurrent takers, renewal by its holder, takeover only once
 *     expired, release only by its holder.
 *
 * In-memory store by default. With CHECK_STORE=prisma the same cases run against PrismaStore on the
 * Postgres DATABASE_URL points at (migrations applied).
 *
 * Run: npx tsx scripts/holder-round-store-check.ts
 *      CHECK_STORE=prisma DATABASE_URL=postgres://... npx tsx scripts/holder-round-store-check.ts
 */
process.env.NODE_ENV ??= "test";
process.env.LOG_LEVEL ??= "silent";
process.env.DATABASE_URL ??= "postgres://hr:hr@localhost:5432/hr";

const { InMemoryStore } = await import("../src/store/memory.js");
const { PrismaStore, getPrisma } = await import("../src/store/prisma.js");
const { HolderRoundConflictError } = await import("../src/store/types.js");
import type { HolderLeaf, Store } from "../src/store/types.js";

let failures = 0;
let passes = 0;
function check(name: string, cond: boolean, detail = ""): void {
  if (cond) {
    passes += 1;
    console.log(`  ok   ${name}${detail ? `  (${detail})` : ""}`);
  } else {
    failures += 1;
    console.log(`  FAIL ${name}${detail ? `  (${detail})` : ""}`);
  }
}

const usePrisma = process.env.CHECK_STORE === "prisma";
const prisma = usePrisma ? getPrisma() : null;
const store: Store = prisma ? new PrismaStore(prisma) : new InMemoryStore();
console.log(`store: ${usePrisma ? "PrismaStore (Postgres)" : "InMemoryStore"}`);

// Ids far above anything a real season reaches, cleared first so a re-run starts clean.
const BASE = 4_000_000;
const TOKEN = "0x2020202020202020202020202020202020202020";
const A = "0x5555555555555555555555555555555555555555";
const B = "0x6666666666666666666666666666666666666666";
const rootA = "0x" + "a1".repeat(32);
const rootB = "0x" + "b2".repeat(32);
const leaves = (roundId: number, amount: string): HolderLeaf[] => [
  { roundId, account: A, amount, proof: "[]" },
  { roundId, account: B, amount, proof: "[]" },
];
const round = (id: number, root: string, txHash: string | null = null) => ({ id, root, total: "2", token: TOKEN, txHash });
const thrown = async (fn: () => Promise<unknown>): Promise<unknown> => {
  try {
    await fn();
    return null;
  } catch (err) {
    return err;
  }
};

try {
  if (prisma) {
    await prisma.holderRewardRound.deleteMany({ where: { id: { gte: BASE } } });
    await prisma.jobLease.deleteMany({ where: { name: { startsWith: "check-" } } });
  }

  console.log("\nthe proof store never overwrites a different root");
  const id = BASE + 1;
  await store.putHolderRound(round(id, rootA), leaves(id, "1"));
  const refused = await thrown(() => store.putHolderRound(round(id, rootB), leaves(id, "9")));
  check("a different root for a stored id is refused with HolderRoundConflictError", refused instanceof HolderRoundConflictError, String(refused));
  const kept = (await store.holderLeavesSince(id)).filter((l) => l.roundId === id);
  check("the stored tree is untouched (root and leaves)",
    (await store.holderRound(id))?.root === rootA && kept.length === 2 && kept.every((l) => l.amount === "1" && l.root === rootA),
    JSON.stringify(kept));
  await store.putHolderRound(round(id, rootA, "0xfeed"), leaves(id, "1"));
  await store.putHolderRound(round(id, rootA, null), leaves(id, "1"));
  check("the same root is idempotent and a recorded txHash is never erased", (await store.holderRound(id))?.txHash === "0xfeed");
  check("root compare ignores hex case", (await thrown(() => store.putHolderRound(round(id, rootA.toUpperCase().replace("0X", "0x")), leaves(id, "1")))) === null);
  check("replaceRoot naming the WRONG root is refused",
    (await thrown(() => store.putHolderRound(round(id, rootB), leaves(id, "9"), { replaceRoot: rootB }))) instanceof HolderRoundConflictError &&
      (await store.holderRound(id))?.root === rootA);
  const accountLeaves = await store.holderLeavesForAccount(A);
  check("leaf reads carry the round's root", accountLeaves.some((l) => l.roundId === id && l.root === rootA));

  console.log("\nreplace and delete only what the caller proves");
  const id2 = BASE + 2;
  await store.putHolderRound(round(id2, rootA), leaves(id2, "1"));
  await store.putHolderRound(round(id2, rootB), leaves(id2, "7"), { replaceRoot: rootA });
  const swapped = (await store.holderLeavesSince(id2)).filter((l) => l.roundId === id2);
  check("replaceRoot with the stored root swaps the whole tree", (await store.holderRound(id2))?.root === rootB && swapped.length === 2 && swapped.every((l) => l.amount === "7" && l.root === rootB));
  check("deleteUnpostedHolderRound refuses the wrong root", (await store.deleteUnpostedHolderRound(id2, rootA)) === false && (await store.holderRound(id2)) !== null);
  check("deleteUnpostedHolderRound removes an unposted tree and its leaves",
    (await store.deleteUnpostedHolderRound(id2, rootB)) === true && (await store.holderRound(id2)) === null &&
      (await store.holderLeavesSince(id2)).every((l) => l.roundId !== id2));
  check("deleteUnpostedHolderRound never removes a round recorded as posted", (await store.deleteUnpostedHolderRound(id, rootA)) === false && (await store.holderRound(id)) !== null);

  console.log("\ntwo instances racing to store a NEW round id");
  const id3 = BASE + 3;
  const race = await Promise.allSettled([
    store.putHolderRound(round(id3, rootA), leaves(id3, "1")),
    store.putHolderRound(round(id3, rootB), leaves(id3, "2")),
  ]);
  const won = race.filter((r) => r.status === "fulfilled").length;
  const stored3 = await store.holderRound(id3);
  const leaves3 = (await store.holderLeavesSince(id3)).filter((l) => l.roundId === id3);
  check("exactly one tree lands, and its leaves all belong to its root",
    won === 1 && !!stored3 && leaves3.length === 2 && leaves3.every((l) => l.root === stored3.root && l.amount === (stored3.root === rootA ? "1" : "2")),
    JSON.stringify({ won, root: stored3?.root, leaves3 }));

  console.log("\nthe job lease");
  const name = `check-${Date.now()}`;
  const takers = await Promise.all(Array.from({ length: 8 }, (_, i) => store.tryAcquireJobLease(name, `instance-${i}`, 60_000)));
  const winners = takers.filter(Boolean).length;
  const winner = `instance-${takers.indexOf(true)}`;
  check("eight concurrent takers: exactly one wins", winners === 1, JSON.stringify(takers));
  const loser = winner === "instance-0" ? "instance-1" : "instance-0";
  check("the holder renews its own lease", (await store.tryAcquireJobLease(name, winner, 60_000)) === true);
  check("another instance cannot take an unexpired lease", (await store.tryAcquireJobLease(name, loser, 60_000)) === false);
  await store.releaseJobLease(name, loser);
  check("release by a non-holder is a no-op", (await store.tryAcquireJobLease(name, loser, 60_000)) === false);
  await store.releaseJobLease(name, winner);
  check("after the holder releases, the next taker wins", (await store.tryAcquireJobLease(name, loser, -1_000)) === true);
  check("an EXPIRED lease is taken over", (await store.tryAcquireJobLease(name, winner, 60_000)) === true);
  const expiredRace = await Promise.all([
    store.tryAcquireJobLease(`${name}-x`, "seed", -1_000),
  ]);
  const overTaken = await Promise.all(Array.from({ length: 6 }, (_, i) => store.tryAcquireJobLease(`${name}-x`, `taker-${i}`, 60_000)));
  check("six concurrent takers of one expired lease: exactly one wins", expiredRace[0] === true && overTaken.filter(Boolean).length === 1, JSON.stringify(overTaken));
} finally {
  if (prisma) {
    await prisma.holderRewardRound.deleteMany({ where: { id: { gte: BASE } } }).catch(() => undefined);
    await prisma.jobLease.deleteMany({ where: { name: { startsWith: "check-" } } }).catch(() => undefined);
    await prisma.$disconnect();
  }
}

console.log(`\nRESULT: ${passes} passed, ${failures} failed`);
process.exit(failures === 0 ? 0 : 1);
