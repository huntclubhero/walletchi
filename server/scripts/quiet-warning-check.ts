/**
 * FADE-WARNING REACHABILITY CHECK
 *
 * The bug this guards: quiet hours (9h) were longer than the fade window (6h),
 * so a pet whose deadline landed in the small hours spent its ENTIRE save window
 * against a muted push channel and died without ever warning its keeper.
 *
 * This drives the REAL exported gate (criticalPushGapMs + isQuietHour), not a
 * re-derivation of it, over every deadline hour of the day, simulating the idle
 * engine's actual 45-minute tick. It asserts two things that must both hold:
 *   1. REACHABILITY: no deadline hour produces zero warnings.
 *   2. RESTRAINT: no overnight fade turns into a push storm.
 */
import { config } from "../src/config.js";
import { isQuietHour, quietZoneResolves } from "../src/runner/quiet.js";
import { criticalPushGapMs } from "../src/runner/idle.js";

let failures = 0;
function check(name: string, cond: boolean, detail = ""): void {
  if (cond) {
    console.log(`  ok   ${name}${detail ? `  (${detail})` : ""}`);
  } else {
    failures += 1;
    console.log(`  FAIL ${name}${detail ? `  (${detail})` : ""}`);
  }
}

const HOUR = 3_600_000;
const lifeTtlSec = 86_400; // the live season's lifeTtl
const fadeSec = Math.min(config.CRITICAL_WINDOW_HOURS * 3600, Math.max(60, Math.floor(lifeTtlSec / 4)));
const tickMs = config.IDLE_TICK_MINUTES * 60_000;

console.log("=== fade-warning reachability ===");
console.log(
  `lifeTtl=${lifeTtlSec / 3600}h  fade=${fadeSec / 3600}h  quiet=${config.IDLE_QUIET_START_HOUR}:00-${config.IDLE_QUIET_END_HOUR}:00 ${config.QUIET_TZ}  tick=${config.IDLE_TICK_MINUTES}m  quietGap=${config.CRITICAL_QUIET_MIN_GAP_HOURS}h`,
);
console.log(`QUIET_TZ resolves on this runtime: ${quietZoneResolves(config.QUIET_TZ)}`);

// Replay the idle engine across a pet's fade window ending at `deadline`.
// Returns the pushes a keeper would actually receive.
function simulateFade(deadline: Date): { pushes: Date[] } {
  const pushes: Date[] = [];
  let lastPushAt: Date | null = null;
  const start = deadline.getTime() - fadeSec * 1000;
  for (let t = start; t < deadline.getTime(); t += tickMs) {
    const now = new Date(t);
    const gap = criticalPushGapMs(now);
    const canPush = !lastPushAt || now.getTime() - lastPushAt.getTime() >= gap;
    if (canPush) {
      pushes.push(now);
      lastPushAt = now;
    }
  }
  return { pushes };
}

// Anchor on a real date so DST is exercised rather than assumed away.
const base = new Date("2026-08-24T00:00:00Z");
const rows: string[] = [];
let unwarned = 0;
let maxPushes = 0;

for (let h = 0; h < 24; h++) {
  const deadline = new Date(base.getTime() + h * HOUR);
  const { pushes } = simulateFade(deadline);
  if (pushes.length === 0) unwarned += 1;
  maxPushes = Math.max(maxPushes, pushes.length);
  const first = pushes[0];
  const leadH = first ? ((deadline.getTime() - first.getTime()) / HOUR).toFixed(1) : "-";
  const quietAtDeadline = isQuietHour(deadline) ? "quiet" : "awake";
  rows.push(
    `  deadline ${String(h).padStart(2, "0")}:00Z (${quietAtDeadline})  pushes=${String(pushes.length).padStart(2)}  first warning ${leadH}h ahead`,
  );
}
rows.forEach((r) => console.log(r));

console.log("");
check("every deadline hour produces at least one warning", unwarned === 0, `${unwarned}/24 unwarned`);
check("no fade window becomes a push storm", maxPushes <= 12, `max ${maxPushes} pushes over ${fadeSec / 3600}h`);

// The specific hours that were dead before the fix (05:00-08:00 server local).
console.log("\n=== the previously-silent band ===");
for (const h of [5, 6, 7, 8]) {
  const deadline = new Date(base.getTime() + h * HOUR);
  const { pushes } = simulateFade(deadline);
  check(`deadline ${String(h).padStart(2, "0")}:00Z warns the keeper`, pushes.length > 0, `${pushes.length} pushes`);
}

// Overnight restraint: a fade window sitting entirely inside the quiet band must
// still warn, but must not ping on the normal 30-minute budget.
console.log("\n=== overnight restraint ===");
// A deadline whose ENTIRE fade window sits inside quiet hours. Checking only the
// deadline (or deadline minus a couple of hours) is not enough: at a 9h quiet
// window and a 6h fade, most "quiet" deadlines still fade through the evening,
// and the awake half legitimately pushes on the fast budget. Require every tick
// in the window to be quiet, otherwise the restraint assertion is meaningless.
function fadeWindowFullyQuiet(deadline: Date): boolean {
  const start = deadline.getTime() - fadeSec * 1000;
  for (let t = start; t < deadline.getTime(); t += tickMs) {
    if (!isQuietHour(new Date(t))) return false;
  }
  return true;
}
let probe: Date | null = null;
for (let h = 0; h < 24; h++) {
  const cand = new Date(base.getTime() + h * HOUR);
  if (fadeWindowFullyQuiet(cand)) {
    probe = cand;
    break;
  }
}
if (probe) {
  console.log(`  probe deadline ${probe.toISOString()} (fade window entirely inside quiet hours)`);
  const { pushes } = simulateFade(probe);
  const spacings = pushes.slice(1).map((p, i) => (p.getTime() - pushes[i]!.getTime()) / HOUR);
  const minSpacing = spacings.length ? Math.min(...spacings) : Infinity;
  check("a fully-overnight fade still warns", pushes.length > 0, `${pushes.length} pushes`);
  check(
    "overnight warnings are spaced, not spammed",
    pushes.length <= 4,
    `${pushes.length} pushes, min spacing ${minSpacing === Infinity ? "n/a" : minSpacing.toFixed(2) + "h"}`,
  );
} else {
  console.log("  (no fully-quiet probe hour found; skipped)");
}

// The timezone itself: the configured window must land where it reads.
console.log("\n=== quiet window lands in QUIET_TZ, not UTC ===");
check("QUIET_TZ resolves (no silent UTC fallback)", quietZoneResolves(config.QUIET_TZ), config.QUIET_TZ);
// 23:00 UTC is 19:00 in Toronto: quiet in the OLD UTC-based logic, awake now.
const eveningUtc = new Date("2026-08-24T23:30:00Z");
check(
  "23:30Z (19:30 Toronto) is NOT quiet: the evening is no longer muted",
  !isQuietHour(eveningUtc),
  `hour reads as ${new Intl.DateTimeFormat("en-US", { timeZone: config.QUIET_TZ, hour: "numeric", hourCycle: "h23" }).format(eveningUtc)}`,
);
// 04:00 UTC is 00:00 in Toronto: awake in the OLD logic, correctly quiet now.
const midnightLocal = new Date("2026-08-25T04:30:00Z");
check(
  "04:30Z (00:30 Toronto) IS quiet: the small hours are actually quiet",
  isQuietHour(midnightLocal),
  `hour reads as ${new Intl.DateTimeFormat("en-US", { timeZone: config.QUIET_TZ, hour: "numeric", hourCycle: "h23" }).format(midnightLocal)}`,
);

console.log(`\n${failures === 0 ? "ALL CHECKS PASSED" : `${failures} CHECK(S) FAILED`}`);
process.exit(failures === 0 ? 0 : 1);
