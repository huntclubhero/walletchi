/**
 * LIMIT-AWARE REMINDER CHECK (runner/reminders.ts + idle.ts reflectSurvival).
 *
 * A pet's account allows a fixed number of cares per rolling 24 h. A reminder sent while that
 * window has no cares left would send the keeper to a refused tap, so the line keeps its prefix
 * (isAlertLine, and with it the banner rule) and gains "Care opens again in Xh Ym.". When the
 * window reopens only after the pet's deadline, the server logs CARE LIMIT DEATH RISK and sends
 * nothing extra. An unreadable or slow spend read leaves the reminder byte-identical to before.
 * Real reconcilePet, in-memory store + MockChain.
 *
 * Run: npx tsx scripts/reminder-limit-check.ts
 */
process.env.NODE_ENV ??= "test";
process.env.LOG_LEVEL ??= "silent";
process.env.DATABASE_URL ??= "postgres://rl:rl@localhost:5432/rl";
process.env.PASS_STUB_MODE = "true";
process.env.EMAIL_STUB = "true";
process.env.GOOGLE_WALLET_STUB = "true";
process.env.PRIVY_APP_ID = "";
process.env.PRIVY_APP_SECRET = "";

const { config } = await import("../src/config.js");
const { logger } = await import("../src/logger.js");
const { InMemoryStore } = await import("../src/store/memory.js");
const { Relayer } = await import("../src/chain/relayer.js");
const { MockChain } = await import("../src/chain/mock.js");
const { reconcilePet } = await import("../src/runner/idle.js");
const { checkInLine, lastChanceLine, isAlertLine, withCareReopen, LAST_CHANCE_PREFIX } = await import("../src/runner/reminders.js");
const { NEED_LABELS } = await import("../src/runner/season.js");
const { _resetClaimState } = await import("../src/runner/claim.js");
import type { AppContext } from "../src/context.js";
import type { Runner } from "../src/store/types.js";

let pass = 0;
let fail = 0;
function check(name: string, ok: boolean, detail = ""): void {
  if (ok) pass++;
  else fail++;
  console.log(`  ${ok ? "ok  " : "FAIL"} ${name}${detail ? `  (${detail})` : ""}`);
}

config.IDLE_ENABLED = true;
config.modes.survivalLive = true;
// No quiet hours in this check (start == end): the check-in case must not depend on the clock.
config.IDLE_QUIET_START_HOUR = 0;
config.IDLE_QUIET_END_HOUR = 0;

const mock = new (MockChain as any)();
const store = new (InMemoryStore as any)();
const ctx: AppContext = { store, relayer: new (Relayer as any)(mock) };

// Count Apple pushes (pushRunnerPass reads the registrations once per push) and error logs.
let pushes = 0;
const listTokens = store.listRunnerPushTokensForSerial.bind(store);
store.listRunnerPushTokensForSerial = async (serial: string) => {
  pushes++;
  return listTokens(serial);
};
const errors: Array<{ obj: Record<string, unknown>; msg: string }> = [];
const realError = logger.error.bind(logger);
(logger as any).error = (obj: unknown, msg?: string) => {
  if (typeof obj === "object" && obj && typeof msg === "string") errors.push({ obj: obj as Record<string, unknown>, msg });
  return realError(obj as any, msg as any);
};

const H = 3600;
const CAP = 20n * 10n ** 18n; // 20 cares at the mock careCost (1e18)
const lifeTtl = (await mock.petVaultConfig()).lifeTtlSeconds as number;
const ALL_FIVE = [...NEED_LABELS];
let nextId = 700;

// A hatched pet whose five needs all lapse `leftSec` from now, DB in step with the chain (no
// on-chain-care narration), card showing an idle line.
async function pet(leftSec: number): Promise<{ runner: Runner; tokenId: string; tba: string }> {
  const tokenId = String(nextId++);
  const tba = `0x${tokenId.padStart(40, "a")}`;
  const stamp = Math.floor(Date.now() / 1000) - (lifeTtl - leftSec);
  mock.mockSetPetCare(tokenId, stamp, 1);
  const now = new Date();
  const runner = await store.createRunner({
    serial: `rl-${tokenId}`, tokenId, tbaAddress: tba, ownerAddress: "0xcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcd",
    email: `rl-${tokenId}@walletchi.test`, bestScore: 0, salmon: 0, runs: 0, authToken: `rl-auth-${tokenId}-0123456789abcdef`,
    status: "ready", issueTxHash: null, issueNonce: null, failureReason: null, idleSalmon: 0, lastTickAt: now,
    lastEvent: "Your pet is napping.", lastPushAt: null, lastIdleCatchAt: null, pendingDigest: 0, lastHoneyAt: null,
    lastFishAt: null, lastExploreAt: null, pendingSalmon: 0, activeFork: null, forkExpiresAt: null, hunger: 50, thirst: 50,
    joy: 50, lastNeedsAt: now, lastCareAt: new Date(stamp * 1000), lastWaterAt: null, lastWanderPingAt: null, lastPlayAt: null,
    lastToyAt: null, hatched: true, toys: 0, critical: false, gone: false, won: false, wonPrize: "0", lastStage: 1, bornAt: now,
    diedAt: null, careCount: 1, deathRank: 0, privyUserHash: null, googleObjectId: null,
  });
  return { runner, tokenId, tba };
}
// The account's window: all cares spent, reopening `reopenSec` from now.
function spendAll(tba: string, reopenSec: number): void {
  mock.spendStates.set(tba.toLowerCase(), {
    dailyCap: CAP,
    windowStart: Math.floor(Date.now() / 1000) - (86_400 - reopenSec),
    spentInWindow: CAP,
  });
}
async function run(r: Runner): Promise<{ after: Runner; pushes: number; errors: typeof errors }> {
  _resetClaimState();
  const p0 = pushes;
  const e0 = errors.length;
  const after = await reconcilePet(ctx, r, { now: new Date() });
  return { after, pushes: pushes - p0, errors: errors.slice(e0) };
}
const CLAUSE = /^(.*) Care opens again in (\d+h \d+m|\d+m)\.$/;
// The time left is read at tick time, so a second boundary can move it by a minute: compare with the
// clock normalised, and check the clock itself separately.
const TIME = /dies in (\d+h \d+m|\d+h|\d+m)\./;
const same = (a: string | null | undefined, b: string) => !!a && a.replace(TIME, "dies in T.") === b.replace(TIME, "dies in T.");

console.log("limit-aware reminders");

// (c) Unreadable spend state (no window for this account): byte-identical to today's line.
{
  const { runner, tokenId } = await pet(2 * H - 60);
  const r = await run(runner);
  const today = lastChanceLine(2 * H - 60, ALL_FIVE);
  check("unreadable limit: last chance is byte-identical to today's", same(r.after.lastEvent, today), String(r.after.lastEvent));
  check("last chance carries the time left (about 1h 59m)", /dies in 1h 5[89]m\./.test(r.after.lastEvent ?? ""), String(r.after.lastEvent));
  check("unreadable limit: exactly one push, no error", r.pushes === 1 && r.errors.length === 0, `pushes=${r.pushes} errors=${r.errors.length}`);
}
{
  const { runner, tokenId } = await pet(6 * H);
  const r = await run(runner);
  check("unreadable limit: check-in is byte-identical to today's", same(r.after.lastEvent, checkInLine(6 * H, ALL_FIVE)), String(r.after.lastEvent));
  check("check-in carries the time left (about 6h)", /dies in (6h|5h 59m)\./.test(r.after.lastEvent ?? ""), String(r.after.lastEvent));
}
// A spend read that never answers: the reminder still goes out, unchanged, after the short timeout.
{
  const { runner, tokenId } = await pet(2 * H - 60);
  const realSpend = mock.petSpendState.bind(mock);
  mock.petSpendState = () => new Promise(() => {});
  // The read timeout is unref'd (it must not hold a server open); a live server keeps the loop
  // alive, so this script does too while the hung read is pending.
  const keepAlive = setInterval(() => {}, 100);
  const t0 = Date.now();
  const r = await run(runner);
  const ms = Date.now() - t0;
  clearInterval(keepAlive);
  mock.petSpendState = realSpend;
  check("hung limit read: reminder unchanged and sent", same(r.after.lastEvent, lastChanceLine(2 * H - 60, ALL_FIVE)) && r.pushes === 1, String(r.after.lastEvent));
  check("hung limit read: gives up within 2.5 s", ms < 2_500, `${ms} ms`);
}
// Cares still left: unchanged.
{
  const { runner, tokenId, tba } = await pet(2 * H - 60);
  mock.spendStates.set(tba.toLowerCase(), { dailyCap: CAP, windowStart: Math.floor(Date.now() / 1000) - 3600, spentInWindow: CAP - 10n ** 18n });
  const r = await run(runner);
  check("one care left: reminder unchanged", same(r.after.lastEvent, lastChanceLine(2 * H - 60, ALL_FIVE)), String(r.after.lastEvent));
}
// A spent window that already rolled over (24 h passed): the next care opens a fresh one, unchanged.
{
  const { runner, tokenId, tba } = await pet(2 * H - 60);
  mock.spendStates.set(tba.toLowerCase(), { dailyCap: CAP, windowStart: Math.floor(Date.now() / 1000) - 90_000, spentInWindow: CAP });
  const r = await run(runner);
  check("spent window already reopened: reminder unchanged", same(r.after.lastEvent, lastChanceLine(2 * H - 60, ALL_FIVE)), String(r.after.lastEvent));
}

// (b) 0 cares left, window reopens BEFORE the deadline: the clause, prefix first, banner rule intact.
{
  const { runner, tokenId, tba } = await pet(2 * H - 60);
  spendAll(tba, 70 * 60);
  const r = await run(runner);
  const m = CLAUSE.exec(r.after.lastEvent ?? "");
  check("0 cares left: last chance gains the reopen clause", !!m && same(m[1], lastChanceLine(2 * H - 60, ALL_FIVE)), String(r.after.lastEvent));
  check("0 cares left: reopen time is relative and right (about 1h 10m)", !!m && /^1h (9|10)m$/.test(m[2]!), m?.[2] ?? "");
  check("0 cares left: line still starts with the prefix and is an alert line", (r.after.lastEvent ?? "").startsWith(LAST_CHANCE_PREFIX) && isAlertLine(r.after.lastEvent), String(r.after.lastEvent));
  check("0 cares left, reopens before the deadline: one push, no death-risk error", r.pushes === 1 && !r.errors.some((e) => e.msg === "CARE LIMIT DEATH RISK"), `pushes=${r.pushes}`);
  const again = await run(r.after);
  check("0 cares left: the last chance is not sent twice", again.pushes === 0 && again.after.lastEvent === r.after.lastEvent, `pushes=${again.pushes}`);
}
{
  const { runner, tokenId, tba } = await pet(6 * H);
  spendAll(tba, 2 * H + 10 * 60);
  const r = await run(runner);
  const m = CLAUSE.exec(r.after.lastEvent ?? "");
  check("0 cares left: check-in gains the reopen clause", !!m && same(m[1], checkInLine(6 * H, ALL_FIVE)), String(r.after.lastEvent));
  check("0 cares left: check-in is still an alert line", isAlertLine(r.after.lastEvent), String(r.after.lastEvent));
  check("0 cares left: check-in sends one push", r.pushes === 1, `pushes=${r.pushes}`);
}

// (d) 0 cares left and the window reopens AFTER the deadline: error log, nothing extra sent.
{
  const { runner, tokenId, tba } = await pet(2 * H - 60);
  spendAll(tba, 5 * H);
  const r = await run(runner);
  const risk = r.errors.filter((e) => e.msg === "CARE LIMIT DEATH RISK");
  check("death risk: logs CARE LIMIT DEATH RISK once at error level", risk.length === 1, JSON.stringify(risk.map((e) => e.obj)));
  const o = risk[0]?.obj ?? {};
  check(
    "death risk: the log carries serial, tokenId and the times",
    o.serial === `rl-${tokenId}` && o.tokenId === tokenId && typeof o.careReopensAt === "string" && typeof o.deadline === "string" && Date.parse(o.careReopensAt as string) > Date.parse(o.deadline as string),
    JSON.stringify(o),
  );
  check("death risk: the one reminder push only, nothing extra", r.pushes === 1, `pushes=${r.pushes}`);
  check("death risk: the reminder still names when care opens", CLAUSE.test(r.after.lastEvent ?? "") && isAlertLine(r.after.lastEvent), String(r.after.lastEvent));
}

// Length and copy: all five needs, the longest clock and the longest clause stay within 160 characters (about four lock-screen lines; the wording that names the time left
// and the fix outgrew the 140 announcement cap on 2026-10-18), no dash tells.
{
  const worst = [withCareReopen(checkInLine(23 * H + 59 * 60, ALL_FIVE), 86_399), withCareReopen(lastChanceLine(10 * H, ALL_FIVE), 86_399)];
  const max = Math.max(...worst.map((l) => l.length));
  check("worst-case reminder with the clause stays within 160 characters", max <= 160, `${max} chars: ${worst.sort((a, b) => b.length - a.length)[0]}`);
  check("reopen clause has no em dash or double hyphen", !worst.some((l) => /—|--/.test(l)));
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
