/**
 * VELOCITY-SIGNAL ADVISORY CHECK
 *
 * The bug this guards: IP / subnet / fingerprint velocity caps were implemented
 * as hard refusals. On iOS the device fingerprint is MODEL-level (Safari
 * normalizes canvas, blocks WEBGL_debug_renderer_info, ships a fixed font set,
 * has no deviceMemory, and nav.platform is "iPhone" for all of them), so two
 * people in one city on the same iPhone hash identically and the second one
 * could not mint. Carrier NAT does the same to the per-IP cap.
 *
 * The rule now: these three are ADVISORY. Always counted, always flagged into
 * the forensics record, never a refusal unless VELOCITY_CAPS_ENFORCED is on.
 *
 * CRITICALLY, this also asserts the SUPPLY WALL still holds while they are
 * advisory: one inbox one pet, one verified identity one pet, and Gmail aliasing
 * closed. Demoting a fuzzy signal is only safe if the real walls are intact, so
 * those are tested here rather than assumed.
 *
 * Drives the REAL exported evaluateMintGate against the real InMemoryStore.
 * Run BOTH ways:
 *   npx tsx scripts/velocity-advisory-check.ts
 *   VELOCITY_CAPS_ENFORCED=true npx tsx scripts/velocity-advisory-check.ts
 */
import { createHash } from "node:crypto";
import { config } from "../src/config.js";
import { InMemoryStore } from "../src/store/memory.js";
import {
  evaluateMintGate,
  issuePowChallenge,
  subjectTag,
  type PowSolution,
} from "../src/runner/sybil.js";

let failures = 0;
function check(name: string, cond: boolean, detail = ""): void {
  if (cond) console.log(`  ok   ${name}${detail ? `  (${detail})` : ""}`);
  else {
    failures += 1;
    console.log(`  FAIL ${name}${detail ? `  (${detail})` : ""}`);
  }
}

function leadingZeroBits(buf: Buffer): number {
  let bits = 0;
  for (const byte of buf) {
    if (byte === 0) {
      bits += 8;
      continue;
    }
    for (let mask = 0x80; mask > 0; mask >>= 1) {
      if (byte & mask) return bits;
      bits++;
    }
    return bits;
  }
  return bits;
}

/** Solve a real challenge the same way the browser does. */
function solve(nonce: string, bits: number): number {
  for (let c = 0; c < 50_000_000; c++) {
    if (leadingZeroBits(createHash("sha256").update(`${nonce}:${c}`).digest()) >= bits) return c;
  }
  throw new Error("pow solve exhausted");
}

const ENFORCED = config.VELOCITY_CAPS_ENFORCED;
const issuedAt = new Date("2026-08-24T12:00:00Z");
// Past MINT_MIN_ELAPSED_MS so the timing gate does not fire.
const evalAt = new Date(issuedAt.getTime() + 5_000);

/** One full, honest mint attempt through the real gate. */
async function attempt(
  store: InMemoryStore,
  opts: { email: string; ip: string; subnet: string; fingerprint?: string; privyId?: string },
) {
  const subject = opts.privyId ? subjectTag(opts.privyId) : "";
  const ch = issuePowChallenge(subject, issuedAt);
  const pow: PowSolution = {
    nonce: ch.nonce,
    counter: solve(ch.nonce, ch.bits),
    sig: ch.sig,
    exp: ch.exp,
    bits: ch.bits,
  };
  return evaluateMintGate(
    store,
    {
      email: opts.email,
      ip: opts.ip,
      subnet: opts.subnet,
      subject: subject || undefined,
      fingerprint: opts.fingerprint,
      elapsedMs: 5_000,
      botSignals: {},
      pow,
    },
    evalAt,
  );
}

/** Seed N COMPLETED mints so the velocity counters actually read high. */
async function seed(
  store: InMemoryStore,
  n: number,
  f: (i: number) => { ip: string; subnet: string; fingerprint: string | null },
) {
  for (let i = 0; i < n; i++) {
    const r = f(i);
    await store.recordMintAttempt({
      normalizedEmailHash: `seed-${i}-${Math.random()}`,
      fingerprint: r.fingerprint,
      ip: r.ip,
      subnet: r.subnet,
      outcome: "minted",
      botFlags: null,
    });
  }
}

console.log(`=== velocity signals: ${ENFORCED ? "ENFORCED" : "ADVISORY (default)"} ===`);
console.log(
  `caps ip=${config.MINTS_PER_IP_PER_DAY} subnet=${config.MINTS_PER_SUBNET_PER_DAY} fp=${config.FINGERPRINT_MINT_CAP}  powBits=${config.POW_DIFFICULTY_BITS}  antiSybil=${config.ANTI_SYBIL_ENABLED}\n`,
);

// --- 1. The iPhone collision: a fingerprint way over its cap ---------------
{
  const store = new InMemoryStore();
  const FP = "identical-iphone-hash";
  await seed(store, config.FINGERPRINT_MINT_CAP + 5, () => ({
    ip: `10.0.0.${Math.floor(Math.random() * 250)}`,
    subnet: "10.0.99",
    fingerprint: FP,
  }));
  const r = await attempt(store, {
    email: "newkeeper@example.com",
    ip: "203.0.113.7",
    subnet: "203.0.113",
    fingerprint: FP,
  });
  if (ENFORCED) {
    check("enforced: a colliding fingerprint is refused", !r.ok, r.ok ? "MINTED" : r.code);
    check(
      "enforced: the code names the fingerprint, not a generic too_many",
      !r.ok && r.code === "too_many_fingerprint",
      r.ok ? "-" : r.code,
    );
  } else {
    check("advisory: a colliding fingerprint STILL MINTS", r.ok, r.ok ? "ok" : r.code);
    check(
      "advisory: the collision is flagged for forensics",
      r.ok && r.velocityFlags.some((f) => f.startsWith("fp=")),
      r.ok ? JSON.stringify(r.velocityFlags) : "-",
    );
  }
}

// --- 2. Carrier NAT: an IP over its cap ------------------------------------
{
  const store = new InMemoryStore();
  await seed(store, config.MINTS_PER_IP_PER_DAY + 3, (i) => ({
    ip: "198.51.100.42",
    subnet: `198.51.${i}`,
    fingerprint: `fp-${i}`,
  }));
  const r = await attempt(store, {
    email: "cellular@example.com",
    ip: "198.51.100.42",
    subnet: "198.51.200",
    fingerprint: "unique-fp",
  });
  if (ENFORCED) {
    check("enforced: a shared carrier IP is refused", !r.ok && r.code === "too_many_ip", r.ok ? "MINTED" : r.code);
  } else {
    check("advisory: a shared carrier IP STILL MINTS", r.ok, r.ok ? "ok" : r.code);
    check(
      "advisory: the IP cluster is flagged",
      r.ok && r.velocityFlags.some((f) => f.startsWith("ip=")),
      r.ok ? JSON.stringify(r.velocityFlags) : "-",
    );
  }
}

// --- 3. Subnet over its cap ------------------------------------------------
{
  const store = new InMemoryStore();
  await seed(store, config.MINTS_PER_SUBNET_PER_DAY + 3, (i) => ({
    ip: `192.0.2.${i % 250}`,
    subnet: "192.0.2",
    fingerprint: `fpx-${i}`,
  }));
  const r = await attempt(store, {
    email: "subnetuser@example.com",
    ip: "192.0.2.251",
    subnet: "192.0.2",
    fingerprint: "another-fp",
  });
  if (ENFORCED) {
    check("enforced: a saturated subnet is refused", !r.ok && r.code === "too_many_subnet", r.ok ? "MINTED" : r.code);
  } else {
    check("advisory: a saturated subnet STILL MINTS", r.ok, r.ok ? "ok" : r.code);
  }
}

// --- 4. A clean mint carries NO flags --------------------------------------
{
  const store = new InMemoryStore();
  const r = await attempt(store, {
    email: "clean@example.com",
    ip: "203.0.113.99",
    subnet: "203.0.113",
    fingerprint: "lonely-fp",
  });
  check("a clean mint is admitted", r.ok, r.ok ? "ok" : r.code);
  check("a clean mint carries no velocity flags", r.ok && r.velocityFlags.length === 0, r.ok ? JSON.stringify(r.velocityFlags) : "-");
}

// --- 5. THE SUPPLY WALL, while the fuzzy signals are advisory ---------------
console.log("\n--- supply wall (must hold regardless of the above) ---");
{
  const store = new InMemoryStore();
  const first = await attempt(store, {
    email: "onepet@example.com",
    ip: "203.0.113.1",
    subnet: "203.0.113",
    fingerprint: "fp-a",
  });
  check("first mint for an inbox is admitted", first.ok, first.ok ? "ok" : first.code);
  // Different IP, different device: only the inbox repeats.
  const second = await attempt(store, {
    email: "onepet@example.com",
    ip: "8.8.8.8",
    subnet: "8.8.8",
    fingerprint: "totally-different-fp",
  });
  check(
    "ONE INBOX ONE PET still holds",
    !second.ok && second.code === "already_minted",
    second.ok ? "SECOND PET ISSUED" : second.code,
  );
}
{
  const store = new InMemoryStore();
  const first = await attempt(store, {
    email: "keeper1@example.com",
    ip: "203.0.113.2",
    subnet: "203.0.113",
    fingerprint: "fp-b",
    privyId: "did:privy:abc123",
  });
  check("first mint for an identity is admitted", first.ok, first.ok ? "ok" : first.code);
  // Fresh inbox, fresh device, fresh network: only the VERIFIED IDENTITY repeats.
  const second = await attempt(store, {
    email: "keeper2@example.com",
    ip: "8.8.4.4",
    subnet: "8.8.4",
    fingerprint: "fp-c",
    privyId: "did:privy:abc123",
  });
  check(
    "ONE VERIFIED IDENTITY ONE PET still holds",
    !second.ok && second.code === "already_minted",
    second.ok ? "SECOND PET ISSUED" : second.code,
  );
}
{
  const store = new InMemoryStore();
  await attempt(store, {
    email: "aliasuser@gmail.com",
    ip: "203.0.113.3",
    subnet: "203.0.113",
    fingerprint: "fp-d",
  });
  const aliased = await attempt(store, {
    email: "A.Lias.User+walletchi@googlemail.com",
    ip: "8.8.8.1",
    subnet: "8.8.8",
    fingerprint: "fp-e",
  });
  check(
    "Gmail aliasing cannot mint a second pet",
    !aliased.ok && aliased.code === "already_minted",
    aliased.ok ? "ALIAS MINTED A SECOND PET" : aliased.code,
  );
}

console.log(`\n${failures === 0 ? "ALL CHECKS PASSED" : `${failures} CHECK(S) FAILED`}`);
process.exit(failures === 0 ? 0 : 1);
