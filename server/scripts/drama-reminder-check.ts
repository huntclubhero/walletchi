/**
 * A SHOWING REMINDER OWNS THE CARD, AND ONE SENDER PER PET (2026-10-19).
 *
 * Morning of 2026-10-19: the colony death line ("A pet just went dark. 40 still breathing.")
 * replaced the check-in or last chance on four cards; the warning text vanished, and the next
 * idle tick saw no reminder showing and sent it again (pet 115 got its last chance twice in one
 * second: the 45-minute cycle walking a stale roster snapshot and a lazy /api/runner read both
 * sent). Two fixes, checked here against the real code and the mock chain:
 *   A. broadcastDrama skips cards whose line is a reminder (lastEvent and lastWanderPingAt untouched).
 *   B. reflectSurvival re-reads the line from the store before sending and holds a per-serial
 *      latch, so a stale snapshot or a concurrent caller never produces a second send.
 *
 * Run from server/: npx tsx scripts/drama-reminder-check.ts
 */
process.env.DATABASE_URL ??= "postgres://x:y@localhost:5432/z";
const { config } = await import("../src/config.js");
const { InMemoryStore } = await import("../src/store/memory.js");
const { Relayer } = await import("../src/chain/relayer.js");
const { MockChain } = await import("../src/chain/mock.js");
const { reconcilePet, _resetReminderRearm } = await import("../src/runner/idle.js");
const { broadcastDrama } = await import("../src/runner/deathwatch.js");
const { isAlertLine, CHECKIN_PREFIX, LAST_CHANCE_PREFIX, checkInLine, lastChanceLine } = await import("../src/runner/reminders.js");
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
config.DRAMA_MAX_PUSHES_PER_CYCLE = 200;
config.DEATHFEED_MIN_HOURS = 8;

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
let nextId = 700;
const nowSec = () => Math.floor(Date.now() / 1000);

async function pet(leftSec: number, lastEvent = "Your pet is napping."): Promise<{ runner: Runner; tokenId: string }> {
  const tokenId = String(nextId++);
  const stamp = nowSec() - (lifeTtl - leftSec);
  mock.mockSetPetCare(tokenId, stamp, 1);
  const now = new Date();
  const runner = await store.createRunner({
    serial: `dr-${tokenId}`, tokenId, tbaAddress: `0x${tokenId.padStart(40, "b")}`, ownerAddress: "0xcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcd",
    email: `dr-${tokenId}@walletchi.test`, bestScore: 0, salmon: 0, runs: 0, authToken: `dr-auth-${tokenId}-0123456789abcdef`,
    status: "ready", issueTxHash: null, issueNonce: null, failureReason: null, idleSalmon: 0, lastTickAt: now,
    lastEvent, lastPushAt: null, lastIdleCatchAt: null, pendingDigest: 0, lastHoneyAt: null,
    lastFishAt: null, lastExploreAt: null, pendingSalmon: 0, activeFork: null, forkExpiresAt: null, hunger: 50, thirst: 50,
    joy: 50, lastNeedsAt: now, lastCareAt: new Date(stamp * 1000), lastWaterAt: null, lastWanderPingAt: null, lastPlayAt: null,
    lastToyAt: null, hatched: true, toys: 0, critical: false, gone: false, won: false, wonPrize: "0", lastStage: 1, bornAt: now,
    diedAt: null, careCount: 1, deathRank: 0, privyUserHash: null, googleObjectId: null,
  });
  return { runner, tokenId };
}
async function run(r: Runner, at = new Date()): Promise<{ after: Runner; pushes: number }> {
  _resetClaimState();
  const p0 = pushes;
  const after = await reconcilePet(ctx, r, { now: at });
  return { after, pushes: pushes - p0 };
}

console.log("A. the colony death line never covers a reminder");
{
  const checkin = await pet(20 * H, checkInLine(6 * H, ["Water"]));
  const last = await pet(20 * H, lastChanceLine(1.5 * H, []));
  const flavor = await pet(20 * H, "Your pet sniffed a wildflower");
  const legacy = await pet(20 * H, "You missed something: your Chi dies in 5h. Tap Toy on the back of this card to keep it alive.");
  const p0 = pushes;
  const line = "A pet just went dark. 40 still breathing.";
  await broadcastDrama(ctx, line, new Date());
  const c = await store.getRunner(checkin.runner.serial);
  const l = await store.getRunner(last.runner.serial);
  const f = await store.getRunner(flavor.runner.serial);
  const g = await store.getRunner(legacy.runner.serial);
  check("check-in line untouched", c.lastEvent === checkin.runner.lastEvent && c.lastWanderPingAt === null, String(c.lastEvent));
  check("last chance line untouched", l.lastEvent === last.runner.lastEvent && l.lastWanderPingAt === null, String(l.lastEvent));
  check("legacy check-in line untouched", g.lastEvent === legacy.runner.lastEvent, String(g.lastEvent));
  check("flavor card gets the drama line and the ping stamp", f.lastEvent === line && f.lastWanderPingAt !== null, String(f.lastEvent));
  check("exactly one push (the flavor card)", pushes - p0 === 1, `pushes=${pushes - p0}`);
  // The skipped cards are still first in line once a care clears the reminder.
  await store.updateRunner(checkin.runner.serial, { lastEvent: "Your Chi was cared for." });
  const p1 = pushes;
  await broadcastDrama(ctx, "Another line.", new Date(Date.now() + 1000));
  const c2 = await store.getRunner(checkin.runner.serial);
  check("after a care clears the line, the next drama line lands", c2.lastEvent === "Another line." && pushes - p1 === 1, String(c2.lastEvent));
}

console.log("B. one sender per pet");
_resetReminderRearm();
// B1. Stale snapshot: the cycle holds a copy taken before a lazy read already sent.
{
  const { runner } = await pet(6 * H);
  const stale = { ...runner };
  const first = await run(runner);
  check("first caller sends the check-in", first.pushes === 1 && (first.after.lastEvent ?? "").startsWith(CHECKIN_PREFIX), String(first.after.lastEvent));
  const second = await run(stale);
  check("second caller with a stale line sends nothing", second.pushes === 0, `pushes=${second.pushes}`);
  check("the card still shows the one check-in", isAlertLine((await store.getRunner(runner.serial)).lastEvent));
}
// B2. Truly concurrent callers (tick and read in the same instant): one send.
{
  const { runner } = await pet(100 * 60);
  const p0 = pushes;
  const [a, b] = await Promise.all([reconcilePet(ctx, runner, { now: new Date() }), reconcilePet(ctx, { ...runner }, { now: new Date() })]);
  const sent = pushes - p0;
  check("concurrent tick + read: exactly one last chance", sent === 1, `pushes=${sent}`);
  check("the card shows the last chance", (await store.getRunner(runner.serial)).lastEvent?.startsWith(LAST_CHANCE_PREFIX) === true, String(a.lastEvent ?? b.lastEvent));
}
// B3. The drama line itself: with the guard in place the line stays, so no re-send on the next tick.
{
  const { runner } = await pet(6 * H);
  const first = await run(runner);
  check("check-in sent", first.pushes === 1);
  await broadcastDrama(ctx, "A pet just went dark. 39 still breathing.", new Date());
  const next = await run(await store.getRunner(runner.serial), new Date(Date.now() + 45 * 60_000));
  check("next tick after a drama broadcast: nothing re-sent", next.pushes === 0 && (next.after.lastEvent ?? "").startsWith(CHECKIN_PREFIX), `pushes=${next.pushes} line=${next.after.lastEvent}`);
}
// B4. A real reminder still goes out when nothing is showing (the latch is not a mute).
{
  const { runner } = await pet(6 * H);
  const r = await run(runner);
  check("fresh pet at 6h: the check-in still goes out", r.pushes === 1 && isAlertLine(r.after.lastEvent));
  const dying = await pet(1 * H);
  const later = await run(dying.runner);
  check("fresh pet at 1h left: the last chance still goes out", later.pushes === 1 && (later.after.lastEvent ?? "").startsWith(LAST_CHANCE_PREFIX), String(later.after.lastEvent));
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
