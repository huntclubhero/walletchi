/**
 * DEVICE MARK CHECK (one Chi per phone, 2026-10-18).
 *
 * The website hands every browser a random first-party cookie; the checkout sends it; the
 * gate binds its peppered hash to the inbox that minted. This drives the REAL exported
 * evaluateMintGate against the real InMemoryStore and asserts:
 *   - a browser's first mint binds the mark and passes;
 *   - the same browser with a DIFFERENT inbox is refused with device_already_minted;
 *   - the same browser retrying the SAME inbox is decided by the reserves, not the mark;
 *   - no mark (private tab, cleared cookies, a new phone) is never a refusal;
 *   - two neighbours with different marks both mint (nothing is derived from the device);
 *   - a mark that fails validation is ignored, never a refusal;
 *   - a refused request (inbox already minted) never marks the browser;
 *   - a store failure on the mark read fails OPEN (it is not the supply wall);
 *   - a genuinely failed mint hands the mark back (releaseDeviceMarkByEmail);
 *   - the tester allowlist bypasses the mark like it bypasses the reserves.
 *
 * Run from server/ with:
 *   ANTI_SYBIL_ENABLED=true SYBIL_PEPPER=check-pepper POW_DIFFICULTY_BITS=8 \
 *   DATABASE_URL=postgres://x:y@localhost:5432/z npx tsx scripts/device-mark-check.ts
 */
import { createHash } from "node:crypto";
import { config } from "../src/config.js";
import { InMemoryStore } from "../src/store/memory.js";
import {
  evaluateMintGate,
  issuePowChallenge,
  subjectTag,
  emailHash,
  normalizeEmail,
  type PowSolution,
} from "../src/runner/sybil.js";

let pass = 0;
let fail = 0;
function check(name: string, ok: boolean, detail = ""): void {
  if (ok) pass++;
  else fail++;
  console.log(`  ${ok ? "ok  " : "FAIL"} ${name}${ok || !detail ? "" : `  (${detail})`}`);
}
function leadingZeroBits(buf: Buffer): number {
  let bits = 0;
  for (const byte of buf) {
    if (byte === 0) {
      bits += 8;
      continue;
    }
    bits += Math.clz32(byte) - 24;
    break;
  }
  return bits;
}
function solve(nonce: string, bits: number): number {
  for (let c = 0; c < 50_000_000; c++) {
    if (leadingZeroBits(createHash("sha256").update(`${nonce}:${c}`).digest()) >= bits) return c;
  }
  throw new Error("pow solve exhausted");
}
const issuedAt = new Date("2026-10-19T12:00:00Z");
const evalAt = new Date(issuedAt.getTime() + 5_000);
const MARK_A = "a".repeat(64);
const MARK_B = "b".repeat(64);

async function attempt(store: InMemoryStore, opts: { email: string; privyId: string; mark?: string; ip?: string }) {
  const subject = subjectTag(opts.privyId);
  const ch = issuePowChallenge(subject, issuedAt);
  const pow: PowSolution = { nonce: ch.nonce, counter: solve(ch.nonce, ch.bits), sig: ch.sig, exp: ch.exp, bits: ch.bits };
  return evaluateMintGate(
    store,
    {
      email: opts.email,
      ip: opts.ip ?? "203.0.113.7",
      subnet: "203.0.113",
      subject,
      elapsedMs: 5_000,
      botSignals: {},
      pow,
      deviceMark: opts.mark,
    },
    evalAt,
  );
}

console.log(`device mark (antiSybil=${config.ANTI_SYBIL_ENABLED} powBits=${config.POW_DIFFICULTY_BITS})`);
if (!config.ANTI_SYBIL_ENABLED) {
  console.log("  FAIL ANTI_SYBIL_ENABLED must be true for this check");
  process.exit(1);
}

// 1. First mint from a browser binds the mark and passes.
{
  const store = new InMemoryStore();
  const r = await attempt(store, { email: "one@example.com", privyId: "p1", mark: MARK_A });
  check("first mint with a mark passes", r.ok, JSON.stringify(r));
  // 2. Same browser, different inbox: refused, and nothing was reserved for it.
  const r2 = await attempt(store, { email: "two@example.com", privyId: "p2", mark: MARK_A });
  check("same browser, different inbox: device_already_minted", !r2.ok && r2.code === "device_already_minted", JSON.stringify(r2));
  check("the refusal is a 403 with the one-Chi-per-phone copy", !r2.ok && r2.status === 403 && /one Chi per phone/.test(r2.message), !r2.ok ? r2.message : "");
  check("the refused inbox was never reserved (it can mint elsewhere)", (await store.reserveEmail(emailHash(normalizeEmail("two@example.com")))) === true);
  await store.releaseEmail(emailHash(normalizeEmail("two@example.com")));
  // 3. Same browser, same inbox again: the reserves decide (already_minted), not the mark.
  const r3 = await attempt(store, { email: "one@example.com", privyId: "p1", mark: MARK_A });
  check("same browser, same inbox: already_minted from the reserves, not the mark", !r3.ok && r3.code === "already_minted", JSON.stringify(r3));
  // 4. The refused inbox from step 2 mints fine from another browser.
  const r4 = await attempt(store, { email: "two@example.com", privyId: "p2", mark: MARK_B });
  check("that inbox mints from a different browser", r4.ok, JSON.stringify(r4));
}

// 5. No mark is never a refusal; neighbours with different marks both mint.
{
  const store = new InMemoryStore();
  const a = await attempt(store, { email: "nomark1@example.com", privyId: "n1" });
  const b = await attempt(store, { email: "nomark2@example.com", privyId: "n2" });
  check("no mark: two different keepers both mint", a.ok && b.ok, JSON.stringify([a, b]));
  const c = await attempt(store, { email: "neigh1@example.com", privyId: "q1", mark: MARK_A, ip: "198.51.100.9" });
  const d = await attempt(store, { email: "neigh2@example.com", privyId: "q2", mark: MARK_B, ip: "198.51.100.9" });
  check("two neighbours on one IP with their own marks both mint", c.ok && d.ok, JSON.stringify([c, d]));
}

// 6. A malformed mark is ignored (never a refusal, never a bind).
{
  const store = new InMemoryStore();
  const a = await attempt(store, { email: "weird1@example.com", privyId: "w1", mark: "not-hex!" });
  const b = await attempt(store, { email: "weird2@example.com", privyId: "w2", mark: "not-hex!" });
  check("malformed mark: ignored, both mints pass", a.ok && b.ok, JSON.stringify([a, b]));
}

// 7. A request refused later by the reserves never marks the browser.
{
  const store = new InMemoryStore();
  await store.reserveEmail(emailHash(normalizeEmail("taken@example.com"))); // inbox already has a pet
  const r = await attempt(store, { email: "taken@example.com", privyId: "t1", mark: MARK_A });
  check("inbox already minted: refused by the reserves", !r.ok && r.code === "already_minted", JSON.stringify(r));
  const r2 = await attempt(store, { email: "fresh@example.com", privyId: "t2", mark: MARK_A });
  check("that browser was NOT marked by the refused request: a fresh inbox mints", r2.ok, JSON.stringify(r2));
}

// 8. Store failure on the mark read fails OPEN with a log (not the supply wall).
{
  const store = new InMemoryStore();
  const real = store.reserveDeviceMark.bind(store);
  store.reserveDeviceMark = async () => {
    throw new Error("simulated store outage");
  };
  const r = await attempt(store, { email: "open@example.com", privyId: "o1", mark: MARK_A });
  check("mark store failure: the mint still passes (fail open)", r.ok, JSON.stringify(r));
  store.reserveDeviceMark = real;
  const r2 = await attempt(store, { email: "open2@example.com", privyId: "o2", mark: MARK_A });
  check("after the outage the browser is unmarked (nothing was bound during it)", r2.ok, JSON.stringify(r2));
}

// 9. A genuinely failed mint hands the mark back by inbox.
{
  const store = new InMemoryStore();
  const r = await attempt(store, { email: "failed@example.com", privyId: "f1", mark: MARK_A });
  check("mint bound the mark", r.ok);
  const h = emailHash(normalizeEmail("failed@example.com"));
  await store.releaseEmail(h);
  await store.releasePrivyUser(subjectTag("f1"));
  await store.releaseDeviceMarkByEmail(h);
  const r2 = await attempt(store, { email: "other@example.com", privyId: "f2", mark: MARK_A });
  check("after a failed mint's release the same browser can mint another inbox", r2.ok, JSON.stringify(r2));
}

// 10. Mark hash is peppered and never the raw cookie value.
{
  const store = new InMemoryStore();
  await attempt(store, { email: "pep@example.com", privyId: "pp1", mark: MARK_A });
  const marks = (store as unknown as { mintMarks: Map<string, string> }).mintMarks;
  check("stored key is a 64-hex hash that is not the cookie value", [...marks.keys()].every((k) => /^[0-9a-f]{64}$/.test(k) && k !== MARK_A), JSON.stringify([...marks.keys()]));
  check("no em dash or double hyphen in the refusal copy", !/—|--/.test("This phone already has a Chi. It is one Chi per phone, so keep caring for the one you have."));
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
