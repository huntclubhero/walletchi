/**
 * STRANDED-RESERVE CHECK (bug hunt 2026-10-19). The mint gate reserves the inbox, the device
 * mark and the Privy identity BEFORE the Runner row is inserted. If that insert throws (a pool
 * timeout under a burst) or the cap says sold out, no row exists for the stuck-mint reaper to
 * find, so the claims used to stay forever: the keeper got already_minted on every retry and
 * their phone device_already_minted. The checkout now releases the claims on both exits.
 * Drives the REAL app over HTTP with an InMemoryStore whose createRunner fails once.
 *
 * Run from server/: npx tsx scripts/mint-store-failure-check.ts
 */
process.env.NODE_ENV = "test";
process.env.LOG_LEVEL = "error";
process.env.DATABASE_URL ??= "postgres://x:y@localhost:5432/z";
process.env.DEMO_BYPASS_PAYMENT = "true";
process.env.PASS_STUB_MODE = "true";
process.env.EMAIL_STUB = "true";
process.env.GOOGLE_WALLET_STUB = "true";
process.env.PRIVY_APP_ID = "";
process.env.PRIVY_APP_SECRET = "";
process.env.PETVAULT_ADDRESS = "";
process.env.CARE_TOKEN_ADDRESS = "";
process.env.REWARDS_DISTRIBUTOR_ADDRESS = "";
process.env.FEE_SPLITTER_ADDRESS = "";
process.env.HOLDER_VAULT_ADDRESS = "";
process.env.FEE_TOKEN_ADDRESS = "";
process.env.HOLDER_POSTER_PRIVATE_KEY = "";
process.env.ANTI_SYBIL_ENABLED = "true";
process.env.SYBIL_PEPPER = "check-pepper";
process.env.POW_DIFFICULTY_BITS = "8";
process.env.MINT_MIN_ELAPSED_MS = "0";
const { createApp } = await import("../src/app.js");
const { InMemoryStore } = await import("../src/store/memory.js");
const { Relayer } = await import("../src/chain/relayer.js");
const { MockChain } = await import("../src/chain/mock.js");
const { emailHash, normalizeEmail, deviceMarkHash } = await import("../src/runner/sybil.js");
const { config } = await import("../src/config.js");
import { createHash } from "node:crypto";
import type { AddressInfo } from "node:net";

let pass = 0;
let fail = 0;
function check(name: string, ok: boolean, detail = ""): void {
  if (ok) pass++;
  else fail++;
  console.log(`  ${ok ? "ok  " : "FAIL"} ${name}${detail ? `  (${detail})` : ""}`);
}
class FlakyStore extends (InMemoryStore as any) {
  failNext = false;
  async createRunner(input: unknown) {
    if (this.failNext) {
      this.failNext = false;
      throw new Error("P2024: timed out fetching a connection from the pool");
    }
    return super.createRunner(input);
  }
}
const store: any = new FlakyStore();
const relayer = new (Relayer as any)(new (MockChain as any)());
const app = createApp({ store, relayer });
const server = app.listen(0);
await new Promise<void>((r) => server.once("listening", () => r()));
const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

function solve(nonce: string, bits: number): number {
  for (let c = 0; c < 50_000_000; c++) {
    const h = createHash("sha256").update(`${nonce}:${c}`).digest();
    let z = 0;
    for (const b of h) {
      if (b === 0) {
        z += 8;
        continue;
      }
      z += Math.clz32(b) - 24;
      break;
    }
    if (z >= bits) return c;
  }
  throw new Error("no solve");
}
async function checkout(email: string, mark: string, ip = "203.0.113.9") {
  const ch = (await (await fetch(`${base}/api/mint/challenge`)).json()) as { nonce: string; bits: number; sig: string; exp: number };
  const pow = { nonce: ch.nonce, counter: solve(ch.nonce, ch.bits), sig: ch.sig, exp: ch.exp, bits: ch.bits };
  const r = await fetch(`${base}/api/runner/checkout`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-forwarded-for": ip },
    body: JSON.stringify({ email, pow, mark, elapsedMs: 5000, botSignals: {} }),
  });
  return { status: r.status, body: (await r.json()) as { code?: string; error?: string } };
}

console.log("stranded reserves after a failed runner insert");
{
  const email = "newholder@example.com";
  const mark = "c".repeat(64);
  const h = emailHash(normalizeEmail(email));
  store.failNext = true;
  const a1 = await checkout(email, mark);
  check("insert throws: the request fails (5xx), nothing pretends to mint", a1.status >= 500, `${a1.status} ${JSON.stringify(a1.body)}`);
  check("the inbox reserve was handed back", !store.mintedEmails.has(h));
  check("the device mark was unbound", store.mintMarks.get(deviceMarkHash(mark)) === undefined);
  check("no 'minted' signal left behind", !store.mintSignals.some((s: { normalizedEmailHash: string; outcome: string }) => s.normalizedEmailHash === h && s.outcome === "minted"));
  const a2 = await checkout(email, mark);
  check("same keeper retries once the store is healthy: the mint proceeds", a2.status === 200 || a2.status === 201 || a2.status === 202, `${a2.status} ${a2.body.code ?? ""} ${a2.body.error ?? ""}`);
  const a3 = await checkout("otherinbox@example.com", mark);
  check("after the real mint, the same phone with another inbox is refused by the mark (as designed)", a3.status === 403 && a3.body.code === "device_already_minted", `${a3.status} ${a3.body.code ?? ""}`);
}
// Sold out at the cap: the claims come back too (no row exists for the reaper).
{
  const cap = config.RUNNER_SUPPLY_CAP;
  config.RUNNER_SUPPLY_CAP = 1; // one row already exists from the mint above
  const email = "latecomer@example.com";
  const mark = "d".repeat(64);
  const h = emailHash(normalizeEmail(email));
  const r = await checkout(email, mark, "203.0.113.10");
  check("sold out: 409", r.status === 409, `${r.status} ${JSON.stringify(r.body)}`);
  check("sold out: the inbox reserve was handed back", !store.mintedEmails.has(h));
  check("sold out: the device mark was unbound", store.mintMarks.get(deviceMarkHash(mark)) === undefined);
  config.RUNNER_SUPPLY_CAP = cap;
}
server.close();
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
