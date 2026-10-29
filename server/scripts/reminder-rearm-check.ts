/**
 * REMINDER RE-ARM HOLD (2026-10-19). Every tap of the five-tap ritual folds a care into the
 * runner, which clears the reminder line, and the reminder step used to re-arm the check-in at
 * once: one keeper got five reminder pushes in 50 seconds (serial f830a9da, 01:14Z). Now no NEW
 * reminder goes out within REMINDER_REARM_MINUTES of a landed care; the first tick after the gap
 * sends one, naming whatever is still due. Drives the real reconcilePet against the mock chain.
 *
 * Run from server/: npx tsx scripts/reminder-rearm-check.ts
 */
process.env.DATABASE_URL ??= "postgres://x:y@localhost:5432/z";
const { config } = await import("../src/config.js");
const { InMemoryStore } = await import("../src/store/memory.js");
const { Relayer } = await import("../src/chain/relayer.js");
const { MockChain } = await import("../src/chain/mock.js");
const { reconcilePet, reconcileOnChainCare, _resetReminderRearm } = await import("../src/runner/idle.js");
const { isAlertLine, CHECKIN_PREFIX, LAST_CHANCE_PREFIX } = await import("../src/runner/reminders.js");
const { _resetPetNeedsCache } = await import("../src/runner/season.js");
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
config.IDLE_QUIET_START_HOUR = 0;
config.IDLE_QUIET_END_HOUR = 0;
config.REMINDER_REARM_MINUTES = 30;
config.LAST_CHANCE_REARM_MINUTES = 5;

const mock = new (MockChain as any)();
const store = new (InMemoryStore as any)();
const ctx: AppContext = { store, relayer: new (Relayer as any)(mock) };
let pushes = 0;
const listTokens = store.listRunnerPushTokensForSerial.bind(store);
store.listRunnerPushTokensForSerial = async (serial: string) => {
  pushes++;
  return listTokens(serial);
};
const H = 3600;
const lifeTtl = (await mock.petVaultConfig()).lifeTtlSeconds as number;
let nextId = 900;
const nowSec = () => Math.floor(Date.now() / 1000);

async function pet(leftSec: number): Promise<{ runner: Runner; tokenId: string }> {
  const tokenId = String(nextId++);
  const stamp = nowSec() - (lifeTtl - leftSec);
  mock.mockSetPetCare(tokenId, stamp, 1);
  const now = new Date();
  const runner = await store.createRunner({
    serial: `rr-${tokenId}`, tokenId, tbaAddress: `0x${tokenId.padStart(40, "b")}`, ownerAddress: "0xcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcd",
    email: `rr-${tokenId}@walletchi.test`, bestScore: 0, salmon: 0, runs: 0, authToken: `rr-auth-${tokenId}-0123456789abcdef`,
    status: "ready", issueTxHash: null, issueNonce: null, failureReason: null, idleSalmon: 0, lastTickAt: now,
    lastEvent: "Your pet is napping.", lastPushAt: null, lastIdleCatchAt: null, pendingDigest: 0, lastHoneyAt: null,
    lastFishAt: null, lastExploreAt: null, pendingSalmon: 0, activeFork: null, forkExpiresAt: null, hunger: 50, thirst: 50,
    joy: 50, lastNeedsAt: now, lastCareAt: new Date(stamp * 1000), lastWaterAt: null, lastWanderPingAt: null, lastPlayAt: null,
    lastToyAt: null, hatched: true, toys: 0, critical: false, gone: false, won: false, wonPrize: "0", lastStage: 1, bornAt: now,
    diedAt: null, careCount: 1, deathRank: 0, privyUserHash: null, googleObjectId: null,
  });
  return { runner, tokenId };
}
/** A care lands on-chain for ONE need (water), careCount advances, like a pass tap. */
function careLands(tokenId: string, careCount: number): void {
  mock.mockSetPetNeed(tokenId, 1, nowSec());
  (mock as any).petCareCounts.set(tokenId, careCount);
  _resetPetNeedsCache();
}
async function run(r: Runner, at = new Date()): Promise<{ after: Runner; pushes: number }> {
  _resetClaimState();
  const p0 = pushes;
  const after = await reconcilePet(ctx, r, { now: at });
  return { after, pushes: pushes - p0 };
}

console.log("reminder re-arm hold");
_resetReminderRearm();
// A. Check-in sent, then the ritual: each tap folds a care; no second reminder until the gap passes.
{
  const { runner, tokenId } = await pet(6 * H);
  let r = await run(runner);
  check("6h left: the check-in goes out once", r.pushes === 1 && (r.after.lastEvent ?? "").startsWith(CHECKIN_PREFIX), String(r.after.lastEvent));
  careLands(tokenId, 2);
  r = await run(r.after);
  check("tap 1 lands: the care narration replaces the line, one push, no reminder", r.pushes === 1 && !isAlertLine(r.after.lastEvent), `pushes=${r.pushes} line=${r.after.lastEvent}`);
  r = await run(r.after);
  check("read right after: no reminder re-armed (held)", r.pushes === 0 && !isAlertLine(r.after.lastEvent), `pushes=${r.pushes} line=${r.after.lastEvent}`);
  careLands(tokenId, 3);
  r = await run(r.after);
  check("tap 2 lands: still no reminder", r.pushes === 1 && !isAlertLine(r.after.lastEvent), `pushes=${r.pushes}`);
  r = await run(r.after, new Date(Date.now() + 29 * 60_000));
  check("29 min later: still held", r.pushes === 0, `pushes=${r.pushes}`);
  r = await run(r.after, new Date(Date.now() + 31 * 60_000));
  check("31 min later: ONE check-in, naming what is still due (not Water)", r.pushes === 1 && (r.after.lastEvent ?? "").startsWith(CHECKIN_PREFIX) && !/Water/.test(r.after.lastEvent ?? ""), String(r.after.lastEvent));
  const again = await run(r.after, new Date(Date.now() + 32 * 60_000));
  check("not sent twice", again.pushes === 0);
}
// B. Last chance is held the same way, then still goes out.
{
  _resetReminderRearm();
  const { runner, tokenId } = await pet(110 * 60);
  let r = await run(runner);
  check("1h50m left: last chance goes out", r.pushes === 1 && (r.after.lastEvent ?? "").startsWith(LAST_CHANCE_PREFIX), String(r.after.lastEvent));
  careLands(tokenId, 2);
  r = await run(r.after);
  r = await run(r.after);
  check("a tap after the last chance: no second last chance right away", r.pushes === 0 && !isAlertLine(r.after.lastEvent), `pushes=${r.pushes} line=${r.after.lastEvent}`);
  r = await run(r.after, new Date(Date.now() + 4 * 60_000));
  check("4 min later: still held (the ritual taps)", r.pushes === 0, `pushes=${r.pushes}`);
  r = await run(r.after, new Date(Date.now() + 6 * 60_000));
  check("6 min later with needs still due: the corrected last chance goes out (short hold, never past death)", r.pushes === 1 && (r.after.lastEvent ?? "").startsWith(LAST_CHANCE_PREFIX), String(r.after.lastEvent));
}
// C. No care ever landed: the hold never applies.
{
  _resetReminderRearm();
  const { runner } = await pet(6 * H);
  const r = await run(runner);
  check("no care in memory: reminder unaffected", r.pushes === 1 && isAlertLine(r.after.lastEvent));
}
// D. All five tapped: nothing due, no reminder after the gap.
{
  _resetReminderRearm();
  const { runner, tokenId } = await pet(6 * H);
  let r = await run(runner);
  mock.mockSetPetCare(tokenId, nowSec(), 6);
  _resetPetNeedsCache();
  r = await run(r.after);
  r = await run(r.after, new Date(Date.now() + 31 * 60_000));
  check("all five served: no reminder after the gap", r.pushes === 0 && !isAlertLine(r.after.lastEvent), `pushes=${r.pushes} line=${r.after.lastEvent}`);
}
// E. The PASS-TAP path: routes.ts folds the care itself via reconcileOnChainCare, then the next
// public read runs reconcilePet. The hold must see that fold too (bug hunt 2026-10-19).
{
  _resetReminderRearm();
  const { runner, tokenId } = await pet(7 * H);
  let r = await run(runner);
  check("7h left: check-in sent", r.pushes === 1 && (r.after.lastEvent ?? "").startsWith(CHECKIN_PREFIX));
  careLands(tokenId, 2);
  const state = await ctx.relayer.petState(tokenId);
  const folded = await reconcileOnChainCare(ctx, r.after, tokenId, state, new Date());
  check("tap path: the narration names the need still due with its clock, never happy and full", /Your Chi was cared for, but it still needs \w+: \d+h( \d+m)? left\./.test(folded.lastEvent ?? ""), String(folded.lastEvent));
  r = await run(folded, new Date(Date.now() + 5_000));
  check("read 5 s after a tap-path fold: no reminder re-armed", r.pushes === 0 && !isAlertLine(r.after.lastEvent), `pushes=${r.pushes} line=${r.after.lastEvent}`);
  r = await run(r.after, new Date(Date.now() + 31 * 60_000));
  check("31 min later: one check-in", r.pushes === 1 && (r.after.lastEvent ?? "").startsWith(CHECKIN_PREFIX), String(r.after.lastEvent));
}
// F. Narration when every need is comfortably far: happy and full is right.
{
  _resetReminderRearm();
  const { runner, tokenId } = await pet(20 * H);
  mock.mockSetPetCare(tokenId, nowSec(), 2);
  _resetPetNeedsCache();
  const state = await ctx.relayer.petState(tokenId);
  const folded = await reconcileOnChainCare(ctx, runner, tokenId, state, new Date());
  check("all needs far out: happy and full", /happy and full/.test(folded.lastEvent ?? ""), String(folded.lastEvent));
}
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
