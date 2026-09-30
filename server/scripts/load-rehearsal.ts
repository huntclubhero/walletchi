/*
 * WALLETCHI LOAD REHEARSAL: the mint path under a burst.
 *
 * Boots the REAL request handlers the way scripts/smoke.ts does (in-memory Store, MockChain behind
 * the Relayer's serial queue, stubbed Apple signing, stubbed email, a recording fake Google client)
 * and fires N concurrent mint flows with distinct synthetic identities. Nothing here touches a
 * network, a database, Render, Alchemy, APNs, Google Wallet or a chain.
 *
 * Each flow does exactly what the web client does (web-cub/src/components/MintForm.tsx + lib/api.ts):
 *   GET  /api/mint/challenge                       proof-of-work challenge
 *   POST /api/runner/checkout                      the mint (anti-Sybil gate ON, PoW verified)
 *   GET  /api/runner/checkout/:serial   (poll)     every POLL_MS until ready / failed
 *   POST /api/runner/pass-link                     Apple capability URL + Google save URL
 *   GET  <applePassUrl>                            the .pkpass bytes (9 sharp rasters + zip)
 *   POST /runner-apple/v1/devices/.../:serial      Apple Wallet device registration
 *   POST /api/pet/:tokenId/care-session            one-tap care install (scrypt seal), mixed scenario
 *
 * Realism knobs, passed as key=value (every external hop the mock answers instantly in the smoke gets
 * a delay here):
 *   chain-ms=150    every MockChain call (reads, the serialized submitMint broadcast, the receipt read)
 *   block-ms=1000   the MockChain block clock: a submitted mint mines this long after the previous
 *                   nonce mined (the real chain assigns the token at mining, in nonce order)
 *   google-ms=250   every fake Google Wallet call (ensureObject, saveUrl, patchObject, addMessage)
 *   bundler-ms=1500 the stubbed Alchemy care submission (userop + receipt), mixed scenario only
 *   poll-ms=2000    client poll cadence (the shipped client uses 2000)
 *   budget=200      PetIssuer hourly mint budget armed on the mock (200 = the showcase value)
 *   n=10,50,200     burst sizes for the plain mint scenarios
 *   only=<name>     run one scenario (mint-10, mint-50, mint-200, mint-250-budget, budget-1000,
 *                     mixed, nat, budget-waves)
 *
 * Measures per flow: stage latencies and the whole flow (p50 / p95 / max), mints per minute,
 * errors by kind, event-loop lag (perf_hooks.monitorEventLoopDelay), heap, relayer queue depth,
 * process CPU time. After every scenario it checks the invariants a burst could break: unique
 * serials, unique tokenIds, one pet per email, one registration per device, chain-issued count
 * equals ready count.
 *
 * Run: npm run load:rehearsal                                  (all scenarios)
 *      npx tsx scripts/load-rehearsal.ts only=mint-50 chain-ms=300   (one scenario, knobs as key=value)
 */

// Env MUST be set before importing anything that builds config. Same hermetic posture as smoke.ts:
// `=` not `??=` for every value that flips a mode, so a developer's server/.env cannot change the
// posture this rehearsal reports on.
process.env.NODE_ENV ??= "test";
process.env.LOG_LEVEL = process.env.LOAD_LOG_LEVEL ?? "silent";
process.env.DATABASE_URL ??= "postgres://load:load@localhost:5432/load";
process.env.DEMO_BYPASS_PAYMENT = "true";
process.env.PASS_STUB_MODE = "true";
process.env.EMAIL_STUB = "true";
process.env.GOOGLE_WALLET_STUB = "true";
process.env.PRIVY_APP_ID = "";
process.env.PRIVY_APP_SECRET = "";
process.env.RELAYER_PRIVATE_KEY = "";
process.env.RUNNER_ISSUER_ADDRESS = "";
process.env.REWARDS_DISTRIBUTOR_ADDRESS = "";
process.env.PETVAULT_ADDRESS = "";
process.env.CARE_TOKEN_ADDRESS = "";
process.env.FEE_SPLITTER_ADDRESS = "";
process.env.HOLDER_VAULT_ADDRESS = "";
process.env.FEE_TOKEN_ADDRESS = "";
process.env.HOLDER_POSTER_PRIVATE_KEY = "";
process.env.SURVIVAL_ENABLED = "false";
process.env.ALCHEMY_API_KEY = "";
process.env.GAS_POLICY_ID = "";
process.env.TESTER_ALLOWLIST = "";
process.env.TURNSTILE_SECRET_KEY = "";
process.env.TURNSTILE_SITE_KEY = "";
// The anti-Sybil gate is ON, like production: PoW verify, disposable-domain check, dedup read,
// velocity reads, the two atomic reserves and the forensics record all run per mint.
process.env.ANTI_SYBIL_ENABLED = "true";
process.env.SYBIL_PEPPER = "load-rehearsal-pepper-not-a-real-secret-0123456789abcdef";
// Difficulty is a CLIENT cost (the server verifies one sha256 whatever the bits), so the synthetic
// minters solve a cheap challenge; production ships 20 bits.
process.env.POW_DIFFICULTY_BITS ??= "12";
process.env.RUNNER_SUPPLY_CAP = "1000";
process.env.PUBLIC_BASE_URL = "https://api.walletchi.test";
process.env.WEB_APP_URL = "https://www.walletchi.test";
process.env.CARE_SESSION_SECRET ??= "load-rehearsal-care-session-secret-not-a-real-key";
process.env.INTERNAL_STATUS_TOKEN ??= "load-rehearsal-internal-status-token";

import { createHash } from "node:crypto";
import { monitorEventLoopDelay, performance } from "node:perf_hooks";
import type { AddressInfo } from "node:net";
import type { AppContext } from "../src/context.js";
import type { Runner } from "../src/store/types.js";
import type { RunnerGoogleWallet } from "../src/runner/google.js";
import type { Chain, MintBudgetState } from "../src/chain/types.js";

const { config } = await import("../src/config.js");
const { createApp, _resetGlobalRateLimit } = await import("../src/app.js");
const { InMemoryStore } = await import("../src/store/memory.js");
const { Relayer } = await import("../src/chain/relayer.js");
const { MockChain } = await import("../src/chain/mock.js");
const { _setRunnerGoogleForTests } = await import("../src/runner/google.js");
const { _setSessionCareSubmitterForTests, sealSessionKey } = await import("../src/runner/session-care.js");
const { leadingZeroBits } = await import("../src/runner/sybil.js");
const { signTag, actionPayload } = await import("../src/runner/sign.js");
const { _careThrottleReset, _careDedupReset } = await import("../src/runner/routes.js");
const { _resetMintAdmissionForTests } = await import("../src/runner/mint-budget.js");
const { privateKeyToAccount, generatePrivateKey } = await import("viem/accounts");

// ===========================================================================
// CLI
// ===========================================================================

const argv = new Map<string, string>();
for (const a of process.argv.slice(2)) {
  const m = /^(?:[-]{2})?([a-z-]+)(?:=(.*))?$/.exec(a);
  if (m) argv.set(m[1]!, m[2] ?? "true");
}
const num = (key: string, dflt: number) => {
  const v = argv.get(key);
  return v === undefined ? dflt : Number(v);
};
const OPTS = {
  chainMs: num("chain-ms", 150),
  blockMs: num("block-ms", 1000),
  googleMs: num("google-ms", 250),
  bundlerMs: num("bundler-ms", 1500),
  pollMs: num("poll-ms", 2000),
  budget: num("budget", 200),
  sizes: (argv.get("n") ?? "10,50,200").split(",").map((s) => Number(s.trim())).filter((n) => n > 0),
  only: argv.get("only") ?? null,
  // The shipped client (web-cub MintForm): 120 s without the server reporting the mint alive
  // (a queue position) is a timeout; while it reports one, keep polling, up to an absolute cap.
  pollTimeoutMs: 120_000,
  pollAbsoluteCapMs: 10 * 60_000,
};

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const nowSec = () => Math.floor(Date.now() / 1000);

// Connection-refused retries. Under a several-hundred-socket burst the OS accept queue can refuse a
// connect before the server even sees it; a browser retries that transparently, so the harness does
// too, and COUNTS it so a refused connect is never silently folded into a latency number.
let connectRetries = 0;
async function fetchRetry(url: string, init?: RequestInit): Promise<Response> {
  for (let attempt = 0; ; attempt++) {
    try {
      return await fetch(url, init);
    } catch (err) {
      const cause = String((err as { cause?: unknown })?.cause ?? err);
      if (attempt >= 8 || !/ECONNREFUSED|ECONNRESET|EADDRINUSE|UND_ERR_SOCKET/.test(cause)) throw err;
      connectRetries += 1;
      await sleep(50 + attempt * 100 + Math.random() * 100);
    }
  }
}

// ===========================================================================
// Latency proxy over the MockChain: every async method waits `ms` BEFORE it runs, which is what a
// network round trip looks like to the caller. Sync mock helpers (mockSetPetCare, ...) pass through.
// Counts calls by method so the report can say how many RPC round trips one mint / one care costs.
// ===========================================================================

function withLatency<T extends object>(target: T, ms: number, calls: Map<string, number>): T {
  return new Proxy(target, {
    get(t, prop, _recv) {
      const v = Reflect.get(t, prop, t);
      if (typeof v !== "function") return v;
      return (...args: unknown[]) => {
        // Only Promise-returning members are network hops on the real chain.
        const probe = (t as unknown as Record<string, unknown>)[String(prop)];
        if (typeof probe !== "function") return (v as (...a: unknown[]) => unknown).apply(t, args);
        const name = String(prop);
        if (name.startsWith("mock")) return (v as (...a: unknown[]) => unknown).apply(t, args);
        calls.set(name, (calls.get(name) ?? 0) + 1);
        return sleep(ms).then(() => (v as (...a: unknown[]) => unknown).apply(t, args));
      };
    },
  });
}

// Fake Google Wallet client with latency + counters. `live: true` so fulfillment takes the real
// branch (ensureObject + saveUrl), pass-link mints a save URL, and pushes PATCH the object.
function fakeGoogle(ms: number, calls: Map<string, number>): RunnerGoogleWallet {
  const hit = (k: string) => calls.set(k, (calls.get(k) ?? 0) + 1);
  return {
    live: true,
    async ensureObject(_runner: Runner) {
      hit("ensureObject");
      await sleep(ms);
    },
    async saveUrl(runner: Runner) {
      hit("saveUrl");
      await sleep(ms);
      return `https://pay.google.com/gp/v/save/fake-${runner.serial.slice(0, 8)}`;
    },
    async patchObject(_runner: Runner) {
      hit("patchObject");
      await sleep(ms);
    },
    async addMessage(_runner: Runner) {
      hit("addMessage");
      await sleep(ms);
    },
    async probe() {
      return { at: Date.now(), ok: true, detail: "fake" };
    },
  } as unknown as RunnerGoogleWallet;
}

// ===========================================================================
// Stats helpers
// ===========================================================================

function pct(sorted: number[], p: number): number {
  if (!sorted.length) return 0;
  const idx = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1));
  return sorted[idx]!;
}
function summarize(values: number[]): { n: number; p50: number; p95: number; max: number } {
  const s = [...values].sort((a, b) => a - b);
  return { n: s.length, p50: pct(s, 50), p95: pct(s, 95), max: s.length ? s[s.length - 1]! : 0 };
}
const fmt = (ms: number) => (ms >= 10_000 ? `${(ms / 1000).toFixed(1)}s` : `${Math.round(ms)}ms`);
const fmtSum = (v: { p50: number; p95: number; max: number }) => `${fmt(v.p50)} / ${fmt(v.p95)} / ${fmt(v.max)}`;
const mb = (bytes: number) => `${(bytes / 1024 / 1024).toFixed(0)}MB`;

// A "public" IP per synthetic identity: distinct per flow so the per-IP HTTP limiter (120/min) and the
// per-IP velocity count behave as they would for real minters on real networks. 11.x.x.x is public.
function ipFor(scenario: number, i: number): string {
  return `11.${scenario & 255}.${(i >> 8) & 255}.${i & 255}`;
}

// ===========================================================================
// One booted app per scenario: fresh store, fresh mock chain, fresh queue depth.
// ===========================================================================

interface Booted {
  store: InstanceType<typeof InMemoryStore>;
  mock: InstanceType<typeof MockChain>;
  relayer: InstanceType<typeof Relayer>;
  ctx: AppContext;
  base: string;
  chainCalls: Map<string, number>;
  googleCalls: Map<string, number>;
  close: () => Promise<void>;
}

async function boot(opts: { chainMs: number; googleMs: number; budget: number }): Promise<Booted> {
  const store = new InMemoryStore();
  const mock = new MockChain();
  mock.mockSetBlockTimeMs(OPTS.blockMs);
  const chainCalls = new Map<string, number>();
  const googleCalls = new Map<string, number>();
  if (opts.budget > 0) {
    mock.mockSetMintBudget({ max: opts.budget, windowSecs: 3600, windowStart: nowSec(), used: 0 });
  }
  const chain = withLatency(mock as unknown as Chain, opts.chainMs, chainCalls);
  const relayer = new Relayer(chain);
  const ctx: AppContext = { store, relayer } as unknown as AppContext;
  _setRunnerGoogleForTests(fakeGoogle(opts.googleMs, googleCalls));
  _resetGlobalRateLimit();
  _careThrottleReset();
  _careDedupReset();
  _resetMintAdmissionForTests();
  // Explicit backlog: a 250-connection burst on the Windows loopback otherwise overflows the default
  // accept queue and surfaces as ECONNREFUSED in the client (a harness artifact, not server logic).
  const server = createApp(ctx).listen(0, "127.0.0.1", 4096);
  await new Promise((r) => server.once("listening", r));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return {
    store,
    mock,
    relayer,
    ctx,
    base,
    chainCalls,
    googleCalls,
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections?.();
        server.close(() => resolve());
      }),
  };
}

// ===========================================================================
// The mint flow (one synthetic keeper)
// ===========================================================================

interface FlowResult {
  i: number;
  ok: boolean;
  errorKind: string | null;
  serial: string | null;
  tokenId: string | null;
  stages: Record<string, number>; // ms per stage
  totalMs: number;
  readyAt: number | null; // epoch ms when the poll first saw ready
}

interface Challenge {
  nonce: string;
  bits: number;
  exp: number;
  sig: string;
  counter: number;
  issuedAtMs: number;
}

async function fetchAndSolveChallenge(base: string, ip: string): Promise<Challenge> {
  const res = await fetchRetry(`${base}/api/mint/challenge`, { headers: { "x-forwarded-for": ip } });
  if (res.status !== 200) throw new Error(`challenge ${res.status}`);
  const c = (await res.json()) as { nonce: string; bits: number; exp: number; sig: string };
  let counter = 0;
  for (;;) {
    const h = createHash("sha256").update(`${c.nonce}:${counter}`).digest();
    if (leadingZeroBits(h) >= c.bits) break;
    counter++;
  }
  return { ...c, counter, issuedAtMs: c.exp * 1000 - config.POW_TTL_SECONDS * 1000 };
}

async function mintFlow(
  b: Booted,
  scenario: number,
  i: number,
  chal: Challenge,
  opts: { pollMs: number; install: boolean; sharedIp?: string; tag: string },
): Promise<FlowResult> {
  const ip = opts.sharedIp ?? ipFor(scenario, i);
  const headers = { "content-type": "application/json", "x-forwarded-for": ip };
  const stages: Record<string, number> = {};
  const t0 = performance.now();
  const email = `keeper-${opts.tag}-${i}@walletchi.test`;
  const fail = (kind: string): FlowResult => ({
    i,
    ok: false,
    errorKind: kind,
    serial: null,
    tokenId: null,
    stages,
    totalMs: performance.now() - t0,
    readyAt: null,
  });

  // 1. checkout
  let t = performance.now();
  const co = await fetchRetry(`${b.base}/api/runner/checkout`, {
    method: "POST",
    headers,
    body: JSON.stringify({
      email,
      fingerprint: `fp-${opts.tag}-${i}`,
      elapsedMs: 4000,
      botSignals: { webdriver: false },
      pow: { nonce: chal.nonce, counter: chal.counter, sig: chal.sig, exp: chal.exp, bits: chal.bits },
    }),
  });
  stages.checkout = performance.now() - t;
  const coBody = (await res2json(co)) as { serial?: string; mintSession?: string; code?: string; error?: string };
  if (co.status !== 200 || !coBody.serial) {
    return fail(`checkout:${co.status}:${coBody.code ?? (coBody.error ?? "").slice(0, 40)}`);
  }
  const serial = coBody.serial;

  // 2. poll until ready
  t = performance.now();
  let status = "";
  let publicFailure: string | undefined;
  let tokenId: string | null = null;
  let readyAt: number | null = null;
  const pollStart = Date.now();
  let lastAlive = pollStart; // last poll where the server reported the mint alive (a queue position)
  let queuePeak = 0;
  for (;;) {
    await sleep(opts.pollMs);
    const r = await fetchRetry(`${b.base}/api/runner/checkout/${serial}`, { headers: { "x-forwarded-for": ip } });
    if (r.status === 429) {
      stages.pollRateLimited = (stages.pollRateLimited ?? 0) + 1;
      if (Date.now() - lastAlive > OPTS.pollTimeoutMs) return fail("poll:timeout-after-429s");
      continue;
    }
    const body = (await res2json(r)) as { status?: string; tokenId?: string; failureReason?: string; queue?: { position: number } };
    status = body.status ?? "";
    if (status === "ready") {
      tokenId = body.tokenId ?? null;
      readyAt = Date.now();
      break;
    }
    if (status === "failed") {
      publicFailure = body.failureReason;
      break;
    }
    if (body.queue) {
      lastAlive = Date.now();
      queuePeak = Math.max(queuePeak, body.queue.position);
    }
    if (Date.now() - lastAlive > OPTS.pollTimeoutMs) return fail("poll:timeout");
    if (Date.now() - pollStart > OPTS.pollAbsoluteCapMs) return fail("poll:absolute-cap");
  }
  stages.queuePosition = queuePeak;
  stages.timeToReady = performance.now() - t;
  if (status !== "ready") {
    // Classify from the row we own (the public view deliberately hides the raw reason).
    const row = await b.store.getRunner(serial);
    const raw = row?.failureReason ?? publicFailure ?? "unknown";
    const kind = /queue full/i.test(raw)
      ? "mint_failed:relayer_queue_full"
      : /MINT_BUSY/i.test(raw)
        ? "mint_failed:mint_budget_exhausted"
        : `mint_failed:${raw.slice(0, 50)}`;
    return { ...fail(kind), serial };
  }

  // 3. pass-link (Apple capability URL + Google save URL)
  t = performance.now();
  const pl = await fetchRetry(`${b.base}/api/runner/pass-link`, {
    method: "POST",
    headers,
    body: JSON.stringify({ id: serial, mintSession: coBody.mintSession }),
  });
  stages.passLink = performance.now() - t;
  const plBody = (await res2json(pl)) as { applePassUrl?: string; googleSaveUrl?: string };
  if (pl.status !== 200 || !plBody.applePassUrl) return { ...fail(`pass-link:${pl.status}`), serial, tokenId };

  // 4. the .pkpass download (the Apple "Add to Wallet" tap)
  t = performance.now();
  const passPath = new URL(plBody.applePassUrl).pathname;
  const pk = await fetchRetry(`${b.base}${passPath}`, { headers: { "x-forwarded-for": ip } });
  const pkBytes = Buffer.from(await pk.arrayBuffer());
  stages.pkpass = performance.now() - t;
  if (pk.status !== 200 || pkBytes.length < 1000) return { ...fail(`pkpass:${pk.status}`), serial, tokenId };

  // 5. Apple Wallet device registration (the device calls this right after the add)
  t = performance.now();
  const row = await b.store.getRunner(serial);
  const reg = await fetchRetry(
    `${b.base}/runner-apple/v1/devices/device-${opts.tag}-${i}/registrations/${config.PASS_TYPE_ID}/${serial}`,
    {
      method: "POST",
      headers: { ...headers, authorization: `ApplePass ${row?.authToken ?? ""}` },
      body: JSON.stringify({ pushToken: `apns-token-${opts.tag}-${i}` }),
    },
  );
  stages.register = performance.now() - t;
  if (reg.status !== 201 && reg.status !== 200) return { ...fail(`register:${reg.status}`), serial, tokenId };

  // 6. one-tap care install (mint-time arming's server half), when the scenario turns it on
  if (opts.install && tokenId) {
    t = performance.now();
    const key = generatePrivateKey();
    const inst = await fetchRetry(`${b.base}/api/pet/${tokenId}/care-session`, {
      method: "POST",
      headers,
      body: JSON.stringify({
        walletAddress: b.relayer.address,
        sessionKey: key,
        publicKey: privateKeyToAccount(key).address,
        context: "0x00aabbcc",
        expiresAtSec: nowSec() + 3600,
      }),
    });
    stages.install = performance.now() - t;
    if (inst.status !== 200) return { ...fail(`install:${inst.status}`), serial, tokenId };
  }

  return { i, ok: true, errorKind: null, serial, tokenId, stages, totalMs: performance.now() - t0, readyAt };
}

async function res2json(r: Response): Promise<unknown> {
  try {
    return await r.json();
  } catch {
    return {};
  }
}

// ===========================================================================
// One care tap (a keeper tapping FEED on the pass), mixed scenario
// ===========================================================================

interface CareResult {
  ok: boolean;
  status: number;
  kind: string;
  ms: number;
}

async function careTap(b: Booted, runner: Runner, action: string, ip: string): Promise<CareResult> {
  const sig = signTag(runner.authToken, actionPayload(runner.serial, action));
  const t = performance.now();
  const r = await fetchRetry(`${b.base}/api/runner/${runner.serial}/care/${action}?s=${sig}&src=apple`, {
    method: "POST",
    headers: { "x-forwarded-for": ip },
    redirect: "manual",
  });
  const html = await r.text();
  const ms = performance.now() - t;
  const ok = r.status === 200 && /Yum!|Refreshing!|Wheee!|New toy!|Off exploring!|Your egg hatched/.test(html);
  const kind = ok
    ? "landed"
    : r.status === 200
      ? /Already taken care of/.test(html) ? "deduped" : /in flight|Still on its way/.test(html) ? "waiting" : "200-other"
      : `${r.status}`;
  return { ok, status: r.status, kind, ms };
}

// ===========================================================================
// Instrumentation around a scenario
// ===========================================================================

interface Probe {
  stop: () => {
    loopP50: number;
    loopP99: number;
    loopMax: number;
    heapStart: number;
    heapPeak: number;
    heapEnd: number;
    queuePeak: number;
    unminedPeak: number;
    cpuMs: number;
    wallMs: number;
  };
}

function startProbe(relayer: InstanceType<typeof Relayer>): Probe {
  const h = monitorEventLoopDelay({ resolution: 10 });
  h.enable();
  const heapStart = process.memoryUsage().heapUsed;
  let heapPeak = heapStart;
  let queuePeak = 0;
  let unminedPeak = 0;
  const cpu0 = process.cpuUsage();
  const wall0 = performance.now();
  const timer = setInterval(() => {
    heapPeak = Math.max(heapPeak, process.memoryUsage().heapUsed);
    queuePeak = Math.max(queuePeak, relayer.pending);
    unminedPeak = Math.max(unminedPeak, relayer.unminedWrites);
  }, 25);
  timer.unref();
  return {
    stop: () => {
      clearInterval(timer);
      h.disable();
      const cpu = process.cpuUsage(cpu0);
      const out = {
        loopP50: h.percentile(50) / 1e6,
        loopP99: h.percentile(99) / 1e6,
        loopMax: h.max / 1e6,
        heapStart,
        heapPeak: Math.max(heapPeak, process.memoryUsage().heapUsed),
        heapEnd: process.memoryUsage().heapUsed,
        queuePeak,
        unminedPeak,
        cpuMs: (cpu.user + cpu.system) / 1000,
        wallMs: performance.now() - wall0,
      };
      h.reset();
      return out;
    },
  };
}

// ===========================================================================
// Invariants a burst could break
// ===========================================================================

async function invariants(b: Booted, results: FlowResult[], label: string): Promise<string[]> {
  const problems: string[] = [];
  const ready = results.filter((r) => r.ok);
  const serials = new Set(ready.map((r) => r.serial));
  if (serials.size !== ready.length) problems.push(`duplicate serials: ${ready.length - serials.size}`);
  const tokens = new Set(ready.map((r) => r.tokenId));
  if (tokens.size !== ready.length) problems.push(`duplicate tokenIds: ${ready.length - tokens.size}`);
  const rows = await b.store.allMintedRunners();
  const tokenRows = new Map<string, number>();
  for (const r of rows) tokenRows.set(r.tokenId!, (tokenRows.get(r.tokenId!) ?? 0) + 1);
  const dupRows = [...tokenRows.values()].filter((n) => n > 1).length;
  if (dupRows) problems.push(`store holds ${dupRows} tokenIds on more than one row`);
  // The chain issued exactly as many pets as the store says are ready (no orphan mint, no phantom).
  const issued = (await b.mock.seasonGate()).minted;
  const readyRows = rows.filter((r) => r.status === "ready").length;
  if (issued !== readyRows) problems.push(`chain issued ${issued} pets but ${readyRows} rows are ready`);
  // One pet per inbox: every ready row's email is reserved; every failed row's email is released.
  const { emailHash, normalizeEmail } = await import("../src/runner/sybil.js");
  for (const r of results) {
    if (!r.serial) continue;
    const row = await b.store.getRunner(r.serial);
    if (!row) continue;
    const reserved = await b.store.emailAlreadyMinted(emailHash(normalizeEmail(row.email)));
    if (row.status === "ready" && !reserved) problems.push(`ready pet ${row.serial.slice(0, 8)} has no email reservation`);
    if (row.status === "failed" && reserved) problems.push(`failed mint ${row.serial.slice(0, 8)} still holds its email (keeper locked out)`);
  }
  // No row left at "minting" once every flow settled.
  const stuck = rows.filter((r) => r.status === "minting").length +
    (await b.store.stuckMintingRunners(new Date(Date.now() + 1))).length;
  if (stuck) problems.push(`${stuck} rows still at status minting`);
  // One registration per device (the register route upserts on device+pass+serial).
  let regs = 0;
  for (const r of ready) regs += (await b.store.listRunnerPushTokensForSerial(r.serial!)).length;
  if (regs !== ready.length) problems.push(`expected ${ready.length} device registrations, found ${regs}`);
  return problems.map((p) => `[${label}] ${p}`);
}

// ===========================================================================
// Scenarios
// ===========================================================================

interface ScenarioReport {
  name: string;
  n: number;
  ready: number;
  errors: Map<string, number>;
  checkout: ReturnType<typeof summarize>;
  timeToReady: ReturnType<typeof summarize>;
  passLink: ReturnType<typeof summarize>;
  pkpass: ReturnType<typeof summarize>;
  register: ReturnType<typeof summarize>;
  install: ReturnType<typeof summarize> | null;
  flow: ReturnType<typeof summarize>;
  mintsPerMin: number;
  burstWallMs: number;
  probe: ReturnType<Probe["stop"]>;
  connectRetries: number;
  chainCalls: Map<string, number>;
  googleCalls: Map<string, number>;
  care: { n: number; landed: number; kinds: Map<string, number>; lat: ReturnType<typeof summarize> } | null;
  problems: string[];
}

let scenarioSeq = 0;

async function runMintBurst(
  name: string,
  n: number,
  opts: { budget: number; install?: boolean; sharedIp?: string; extraCare?: number },
): Promise<ScenarioReport> {
  const scenario = ++scenarioSeq;
  const b = await boot({ chainMs: OPTS.chainMs, googleMs: OPTS.googleMs, budget: opts.budget });
  const tag = `s${scenario}`;
  console.log(`\n== ${name}: ${n} concurrent mint flows` + (opts.extraCare ? ` + ${opts.extraCare} care taps` : "") + ` (chain ${OPTS.chainMs}ms, google ${OPTS.googleMs}ms, poll ${OPTS.pollMs}ms, budget ${opts.budget || "off"}/h)`);

  // Mixed scenario setup: a colony of armed pets minted BEFORE the timed window, in batches that the
  // queue can hold (MAX_PENDING = 100), with the care session installed straight into the store.
  const colony: Runner[] = [];
  let sealMs = 0;
  if (opts.extraCare) {
    config.PETVAULT_ADDRESS = "0x90349bF1461F0BADCE9b9d3486cc3Dd991E816e6";
    config.modes.silentCareLive = true;
    const batch = 50;
    for (let start = 0; start < opts.extraCare; start += batch) {
      const size = Math.min(batch, opts.extraCare - start);
      const chals = await Promise.all(Array.from({ length: size }, (_, k) => fetchAndSolveChallenge(b.base, ipFor(scenario + 100, start + k))));
      await sleep(config.MINT_MIN_ELAPSED_MS + 100);
      const rs = await Promise.all(chals.map((c, k) => mintFlow(b, scenario + 100, start + k, c, { pollMs: 200, install: false, tag: `${tag}-colony` })));
      for (const r of rs) if (r.ok) colony.push((await b.store.getRunner(r.serial!))!);
    }
    const t = performance.now();
    for (const pet of colony) {
      const key = generatePrivateKey();
      await b.store.putCareSession({
        serial: pet.serial,
        tokenId: pet.tokenId!,
        ownerAddress: pet.ownerAddress,
        vaultAddress: config.PETVAULT_ADDRESS!,
        publicKey: privateKeyToAccount(key).address.toLowerCase(),
        secretEnc: sealSessionKey(key),
        context: "0x00aabbcc",
        expiresAt: new Date(Date.now() + 3600_000),
      });
    }
    sealMs = (performance.now() - t) / Math.max(1, colony.length);
    // Every colony pet has been fed once already (hatched), like a real mid-season keeper.
    const careCounts = new Map<string, number>();
    for (const pet of colony) {
      b.mock.mockSetPetCare(pet.tokenId!, nowSec() - 3600, 1);
      careCounts.set(pet.tokenId!, 1);
    }
    _setSessionCareSubmitterForTests(async (session) => {
      await sleep(OPTS.bundlerMs);
      const next = (careCounts.get(session.tokenId) ?? 0) + 1;
      careCounts.set(session.tokenId, next);
      b.mock.mockSetPetCare(session.tokenId, nowSec(), next);
      return { ok: true, txHash: `0x${"ab".repeat(32)}` };
    });
    console.log(`   colony ready: ${colony.length} armed pets (scrypt seal ${sealMs.toFixed(1)}ms each, synchronous)`);
  }

  // Pre-phase (outside the timed window): each keeper fetches + solves its challenge, then the
  // submit-timing floor elapses. The solve is the keeper's CPU, not the server's.
  const chals = await Promise.all(Array.from({ length: n }, (_, i) => fetchAndSolveChallenge(b.base, opts.sharedIp ?? ipFor(scenario, i))));
  await sleep(config.MINT_MIN_ELAPSED_MS + 100);

  const retries0 = connectRetries;
  const probe = startProbe(b.relayer);
  const burstStart = Date.now();
  const careIps = colony.map((_, k) => ipFor(scenario + 200, k));
  const [results, careResults] = await Promise.all([
    Promise.all(chals.map((c, i) => mintFlow(b, scenario, i, c, { pollMs: OPTS.pollMs, install: Boolean(opts.install), sharedIp: opts.sharedIp, tag }))),
    opts.extraCare ? Promise.all(colony.map((pet, k) => careTap(b, pet, "feed", careIps[k]!))) : Promise.resolve([] as CareResult[]),
  ]);
  // Let fire-and-forget tails (post-response pushes, reconciles) drain before measuring the heap.
  await sleep(Math.max(OPTS.googleMs, OPTS.chainMs) * 4 + 200);
  const p = probe.stop();

  const ready = results.filter((r) => r.ok);
  const errors = new Map<string, number>();
  for (const r of results) if (!r.ok) errors.set(r.errorKind!, (errors.get(r.errorKind!) ?? 0) + 1);
  const readyTimes = results.map((r) => r.readyAt).filter((x): x is number => x !== null);
  const lastReady = readyTimes.length ? Math.max(...readyTimes) : burstStart;
  const burstWallMs = Math.max(1, lastReady - burstStart);
  const stage = (k: string) => summarize(results.map((r) => r.stages[k]).filter((v): v is number => v !== undefined));

  const problems = await invariants(b, results, name);
  if (opts.extraCare) {
    _setSessionCareSubmitterForTests(null);
    config.modes.silentCareLive = false;
    config.PETVAULT_ADDRESS = undefined as unknown as string;
  }
  let care: ScenarioReport["care"] = null;
  if (opts.extraCare) {
    const kinds = new Map<string, number>();
    for (const c of careResults) kinds.set(c.kind, (kinds.get(c.kind) ?? 0) + 1);
    care = { n: careResults.length, landed: careResults.filter((c) => c.ok).length, kinds, lat: summarize(careResults.map((c) => c.ms)) };
    // Every tap that landed must have moved the chain AND the row exactly once.
    let folded = 0;
    for (const pet of colony) {
      const row = await b.store.getRunner(pet.serial);
      if (row && row.careCount === 2) folded += 1;
    }
    if (folded !== care.landed) problems.push(`[${name}] ${care.landed} taps landed but ${folded} rows show careCount 2`);
  }
  await b.close();

  const report: ScenarioReport = {
    name,
    n,
    ready: ready.length,
    errors,
    checkout: stage("checkout"),
    timeToReady: stage("timeToReady"),
    passLink: stage("passLink"),
    pkpass: stage("pkpass"),
    register: stage("register"),
    install: opts.install ? stage("install") : null,
    flow: summarize(ready.map((r) => r.totalMs)),
    mintsPerMin: (ready.length / burstWallMs) * 60_000,
    burstWallMs,
    probe: p,
    connectRetries: connectRetries - retries0,
    chainCalls: b.chainCalls,
    googleCalls: b.googleCalls,
    care,
    problems,
  };
  printScenario(report);
  return report;
}

function printScenario(r: ScenarioReport): void {
  const errs = [...r.errors.entries()].map(([k, v]) => `${k} x${v}`).join(", ") || "none";
  console.log(`   ready ${r.ready}/${r.n} in ${fmt(r.burstWallMs)} = ${r.mintsPerMin.toFixed(1)} mints/min | errors: ${errs}`);
  console.log(`   checkout p50/p95/max ${fmtSum(r.checkout)} | time-to-ready ${fmtSum(r.timeToReady)} | flow ${fmtSum(r.flow)}`);
  console.log(`   pass-link ${fmtSum(r.passLink)} | pkpass ${fmtSum(r.pkpass)} | register ${fmtSum(r.register)}` + (r.install ? ` | install ${fmtSum(r.install)}` : ""));
  console.log(`   loop lag p50/p99/max ${r.probe.loopP50.toFixed(1)}/${r.probe.loopP99.toFixed(1)}/${r.probe.loopMax.toFixed(1)}ms | heap ${mb(r.probe.heapStart)} -> peak ${mb(r.probe.heapPeak)} -> ${mb(r.probe.heapEnd)} | queue peak ${r.probe.queuePeak} | unmined peak ${r.probe.unminedPeak} | cpu ${r.probe.cpuMs.toFixed(0)}ms over ${fmt(r.probe.wallMs)} (${((r.probe.cpuMs / r.probe.wallMs) * 100).toFixed(0)}% of one core)`);
  const chain = [...r.chainCalls.entries()].sort((a, b) => b[1] - a[1]).map(([k, v]) => `${k}:${v}`).join(" ");
  const google = [...r.googleCalls.entries()].map(([k, v]) => `${k}:${v}`).join(" ");
  console.log(`   chain calls ${chain || "none"} | google calls ${google || "none"} | client connect retries ${r.connectRetries}`);
  if (r.care) {
    const kinds = [...r.care.kinds.entries()].map(([k, v]) => `${k} x${v}`).join(", ");
    console.log(`   care taps: ${r.care.landed}/${r.care.n} landed (${kinds}) | tap latency p50/p95/max ${fmtSum(r.care.lat)}`);
  }
  for (const p of r.problems) console.log(`   INVARIANT BROKEN ${p}`);
  if (!r.problems.length) console.log(`   invariants ok (unique serials, unique tokenIds, one pet per inbox, chain count == ready rows, no stuck rows, one registration per device)`);
}

// ===========================================================================
// Budget waves: how the PetIssuer hourly budget REFUSES when it binds. Three sequential waves of 90
// keepers (each small enough for the queue) against a 200/h budget: the third wave crosses it. Before
// launch fix 2 the checkout pre-check read only the chain's `used`, which moves when a mint mines, so a
// burst that crossed the line was ACCEPTED at checkout and failed later, after polling; since then the
// pre-check reserves against used + in-flight and the crossing keepers are refused at checkout.
// ===========================================================================

async function runBudgetWaves(name: string, waveSize: number, waves: number, budget: number): Promise<ScenarioReport> {
  const scenario = ++scenarioSeq;
  const b = await boot({ chainMs: OPTS.chainMs, googleMs: OPTS.googleMs, budget });
  console.log(`
== ${name}: ${waves} sequential waves of ${waveSize} keepers against a ${budget}/h budget`);
  const all: FlowResult[] = [];
  const retries0 = connectRetries;
  // Every wave's challenges are fetched and solved BEFORE the probe starts, like runMintBurst's
  // pre-phase: the solve is the keeper's CPU, not the server's. They used to be solved between waves
  // inside the probe window, and a CPU profile showed that the 0.8 to 2.9 s event-loop "stalls" this
  // scenario reported were those 90 synchronous solves in this process, not the server. (Pausing the
  // monitor instead does not work: a re-enabled monitorEventLoopDelay records the paused gap as one
  // delay, and Node cannot merge two of its histograms.) The last wave's challenges are well inside
  // POW_TTL_SECONDS when used.
  const chalsByWave: Challenge[][] = [];
  for (let w = 0; w < waves; w++) {
    chalsByWave.push(await Promise.all(Array.from({ length: waveSize }, (_, i) => fetchAndSolveChallenge(b.base, ipFor(scenario, w * waveSize + i)))));
  }
  await sleep(config.MINT_MIN_ELAPSED_MS + 100);
  const probe = startProbe(b.relayer);
  const burstStart = Date.now();
  for (let w = 0; w < waves; w++) {
    const tag = `s${scenario}w${w}`;
    const chals = chalsByWave[w]!;
    const budgetBefore = await b.mock.mintBudgetState();
    const rs = await Promise.all(chals.map((c, i) => mintFlow(b, scenario, w * waveSize + i, c, { pollMs: OPTS.pollMs, install: false, tag })));
    const ok = rs.filter((r) => r.ok).length;
    const kinds = new Map<string, number>();
    for (const r of rs) if (!r.ok) kinds.set(r.errorKind!, (kinds.get(r.errorKind!) ?? 0) + 1);
    const at429 = rs.filter((r) => r.errorKind?.startsWith("checkout:429")).length;
    console.log(`   wave ${w + 1}: budget used ${budgetBefore.used}/${budgetBefore.max} at arrival -> ${ok}/${waveSize} ready, refused at checkout (429 mint_busy): ${at429}, failed after polling: ${[...kinds.entries()].filter(([k]) => !k.startsWith("checkout:")).map(([k, v]) => `${k} x${v}`).join(", ") || "none"}`);
    all.push(...rs);
  }
  await sleep(Math.max(OPTS.googleMs, OPTS.chainMs) * 4 + 200);
  const p = probe.stop();
  const ready = all.filter((r) => r.ok);
  const errors = new Map<string, number>();
  for (const r of all) if (!r.ok) errors.set(r.errorKind!, (errors.get(r.errorKind!) ?? 0) + 1);
  const readyTimes = all.map((r) => r.readyAt).filter((x): x is number => x !== null);
  const burstWallMs = Math.max(1, (readyTimes.length ? Math.max(...readyTimes) : burstStart) - burstStart);
  const stage = (k: string) => summarize(all.map((r) => r.stages[k]).filter((v): v is number => v !== undefined));
  const problems = await invariants(b, all, name);
  await b.close();
  const report: ScenarioReport = {
    name, n: all.length, ready: ready.length, errors,
    checkout: stage("checkout"), timeToReady: stage("timeToReady"), passLink: stage("passLink"),
    pkpass: stage("pkpass"), register: stage("register"), install: null,
    flow: summarize(ready.map((r) => r.totalMs)), mintsPerMin: (ready.length / burstWallMs) * 60_000, burstWallMs,
    probe: p, connectRetries: connectRetries - retries0, chainCalls: b.chainCalls, googleCalls: b.googleCalls, care: null, problems,
  };
  printScenario(report);
  return report;
}

// ===========================================================================
// Main
// ===========================================================================

const reports: ScenarioReport[] = [];
const want = (name: string) => !OPTS.only || OPTS.only === name;

console.log(`WALLETCHI load rehearsal (in-memory store + MockChain, node ${process.version})`);
console.log(`knobs: chain ${OPTS.chainMs}ms, block ${OPTS.blockMs}ms, google ${OPTS.googleMs}ms, bundler ${OPTS.bundlerMs}ms, poll ${OPTS.pollMs}ms, budget ${OPTS.budget}/h, pow ${config.POW_DIFFICULTY_BITS} bits, min-elapsed ${config.MINT_MIN_ELAPSED_MS}ms, supply cap ${config.RUNNER_SUPPLY_CAP}`);

for (const n of OPTS.sizes) {
  if (want(`mint-${n}`)) reports.push(await runMintBurst(`mint-${n}`, n, { budget: OPTS.budget }));
}
// The budget binds: 250 keepers arrive inside one hour against a 200/h budget.
if (want("mint-250-budget")) reports.push(await runMintBurst("mint-250-budget", 250, { budget: OPTS.budget }));
// Same burst with the budget lifted to 1,000/h: whatever still refuses is not the budget.
if (want("budget-1000")) reports.push(await runMintBurst("budget-1000", 250, { budget: 1000 }));
// Mixed: 50 keepers mint (and arm one-tap care) while 200 existing keepers each tap FEED once.
if (want("mixed")) reports.push(await runMintBurst("mixed", 50, { budget: 1000, install: true, extraCare: 200 }));
// One NAT: 50 keepers on a campus / carrier network share one public IP against the 120/min limiter.
if (want("nat")) reports.push(await runMintBurst("nat", 50, { budget: 1000, sharedIp: "11.250.0.1" }));
// The budget binding on its own: waves the queue can hold, crossing the hourly line on the third.
if (want("budget-waves")) reports.push(await runBudgetWaves("budget-waves", 90, 3, OPTS.budget));

console.log("\n== SUMMARY");
console.log("| scenario | n | ready | errors | checkout p50/p95/max | time-to-ready p50/p95/max | flow p50/p95/max | mints/min | loop lag p99/max | heap peak | queue peak | unmined peak | cpu of one core |");
console.log("|---|---|---|---|---|---|---|---|---|---|---|---|---|");
for (const r of reports) {
  const errs = [...r.errors.entries()].map(([k, v]) => `${k} x${v}`).join("; ") || "none";
  console.log(`| ${r.name} | ${r.n} | ${r.ready} | ${errs} | ${fmtSum(r.checkout)} | ${fmtSum(r.timeToReady)} | ${fmtSum(r.flow)} | ${r.mintsPerMin.toFixed(1)} | ${r.probe.loopP99.toFixed(0)}/${r.probe.loopMax.toFixed(0)}ms | ${mb(r.probe.heapPeak)} | ${r.probe.queuePeak} | ${r.probe.unminedPeak} | ${((r.probe.cpuMs / r.probe.wallMs) * 100).toFixed(0)}% |`);
}
const broken = reports.flatMap((r) => r.problems);
if (broken.length) {
  console.log(`\n${broken.length} invariant(s) broken:`);
  for (const p of broken) console.log(`  ${p}`);
}
process.exit(broken.length ? 1 : 0);
