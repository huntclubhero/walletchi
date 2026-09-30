/**
 * STUCK-MINT REAPER CHECK
 *
 * The lockout this guards: fulfillRunner releases both anti-Sybil claims when a
 * mint FAILS, but only if it reaches its catch block. If the process dies
 * mid-mint (deploy, Render restart, OOM) the row is left at status "minting"
 * still holding the inbox AND the verified identity. That keeper owns no pet,
 * and every retry answers "already_minted" for a reason they cannot see, cannot
 * fix, and did not cause. Nothing swept these before.
 *
 * Drives the REAL reapStuckMints + the REAL evaluateMintGate against the real
 * InMemoryStore, so the claim actually has to be released for the retry to pass.
 */
import { createHash } from "node:crypto";
import { config } from "../src/config.js";
import { InMemoryStore } from "../src/store/memory.js";
import { reapStuckMints } from "../src/runner/fulfillment.js";
import {
  evaluateMintGate,
  issuePowChallenge,
  subjectTag,
  emailHash,
  normalizeEmail,
  type PowSolution,
} from "../src/runner/sybil.js";
import type { AppContext } from "../src/context.js";

let failures = 0;
function check(name: string, cond: boolean, detail = ""): void {
  if (cond) console.log(`  ok   ${name}${detail ? `  (${detail})` : ""}`);
  else {
    failures += 1;
    console.log(`  FAIL ${name}${detail ? `  (${detail})` : ""}`);
  }
}

function lz(buf: Buffer): number {
  let bits = 0;
  for (const byte of buf) {
    if (byte === 0) { bits += 8; continue; }
    for (let mask = 0x80; mask > 0; mask >>= 1) { if (byte & mask) return bits; bits++; }
    return bits;
  }
  return bits;
}
function solve(nonce: string, bits: number): number {
  for (let c = 0; c < 50_000_000; c++) {
    if (lz(createHash("sha256").update(`${nonce}:${c}`).digest()) >= bits) return c;
  }
  throw new Error("pow solve exhausted");
}

const EMAIL = "strandedkeeper@example.com";
const PRIVY_ID = "did:privy:strandeduser";
const issuedAt = new Date("2026-08-24T12:00:00Z");
const evalAt = new Date(issuedAt.getTime() + 5_000);

async function mintAttempt(store: InMemoryStore) {
  const subject = subjectTag(PRIVY_ID);
  const ch = issuePowChallenge(subject, issuedAt);
  const pow: PowSolution = {
    nonce: ch.nonce, counter: solve(ch.nonce, ch.bits), sig: ch.sig, exp: ch.exp, bits: ch.bits,
  };
  return evaluateMintGate(
    store,
    { email: EMAIL, ip: "203.0.113.10", subnet: "203.0.113", subject,
      fingerprint: "fp-stranded", elapsedMs: 5000, botSignals: {}, pow },
    evalAt,
  );
}

console.log("=== stuck-mint reaper ===");
console.log(`MINT_STUCK_MINUTES=${config.MINT_STUCK_MINUTES}\n`);

const store = new InMemoryStore();
const ctx = { store, relayer: {} } as unknown as AppContext;

// 1. A keeper passes the gate: both claims are now RESERVED.
const first = await mintAttempt(store);
check("the gate admits a first-time keeper", first.ok, first.ok ? "ok" : first.code);
check(
  "the inbox claim is held after the gate passes",
  await store.emailAlreadyMinted(emailHash(normalizeEmail(EMAIL))),
  "reserved",
);

// 2. Simulate the process dying mid-mint: the row exists, stuck at "minting".
const stranded = await store.createRunner({
  serial: "stranded-1", tokenId: null, tbaAddress: null,
  ownerAddress: "0x000000000000000000000000000000000000dEaD",
  email: EMAIL, bestScore: 0, salmon: 0, runs: 0,
  authToken: "tok-stranded", status: "minting", issueTxHash: null, failureReason: null,
  idleSalmon: 0, lastTickAt: null,
  privyUserHash: first.ok ? first.privyUserHash : null,
} as never);
// Backdate past the stuck threshold, exactly as a real abandoned row would be.
await store.updateRunner(stranded.serial, {
  createdAt: new Date(Date.now() - (config.MINT_STUCK_MINUTES + 5) * 60_000),
} as never);

// 3. The keeper retries BEFORE any sweep: this is the lockout they reported.
const retryBefore = await mintAttempt(store);
check(
  "before the sweep, the retry is locked out (the reported bug)",
  !retryBefore.ok && retryBefore.code === "already_minted",
  retryBefore.ok ? "ADMITTED" : retryBefore.code,
);

// 4. The reaper runs.
const reaped = await reapStuckMints(ctx, new Date());
check("the reaper finds and reaps the abandoned mint", reaped === 1, `reaped ${reaped}`);
const after = await store.getRunner(stranded.serial);
check("the abandoned row is marked failed", after?.status === "failed", String(after?.status));
check(
  "the inbox claim was handed back",
  !(await store.emailAlreadyMinted(emailHash(normalizeEmail(EMAIL)))),
  "released",
);

// 5. The same keeper can now mint. This is the whole point.
const retryAfter = await mintAttempt(store);
check("after the sweep, the SAME keeper can mint again", retryAfter.ok, retryAfter.ok ? "ok" : retryAfter.code);

// 6. Idempotent: a second sweep must not re-reap or disturb anything.
const reapedAgain = await reapStuckMints(ctx, new Date());
check("a second sweep is a no-op", reapedAgain === 0, `reaped ${reapedAgain}`);

// 7. A mint genuinely IN FLIGHT must never be reaped out from under itself.
{
  const s2 = new InMemoryStore();
  const ctx2 = { store: s2, relayer: {} } as unknown as AppContext;
  await s2.createRunner({
    serial: "inflight-1", tokenId: null, tbaAddress: null,
    ownerAddress: "0x000000000000000000000000000000000000bEEF",
    email: "inflight@example.com", bestScore: 0, salmon: 0, runs: 0,
    authToken: "tok-inflight", status: "minting", issueTxHash: null, failureReason: null,
    idleSalmon: 0, lastTickAt: null, privyUserHash: null,
  } as never);
  const n = await reapStuckMints(ctx2, new Date());
  const still = await s2.getRunner("inflight-1");
  check("a fresh in-flight mint is NOT reaped", n === 0 && still?.status === "minting", `reaped ${n}, status ${still?.status}`);
}

console.log(`\n${failures === 0 ? "ALL CHECKS PASSED" : `${failures} CHECK(S) FAILED`}`);
process.exit(failures === 0 ? 0 : 1);
