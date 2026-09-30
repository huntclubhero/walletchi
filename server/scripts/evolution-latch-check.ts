/**
 * EVOLUTION LATCH CHECK
 *
 * The bug this guards: maybeEvolve persisted `lastStage` whether or not the
 * celebration push actually went out. Because the re-entry guard is
 * `newStage <= runner.lastStage`, an evolution that landed inside quiet hours
 * latched the stage, dropped the push, and never fired again. A pet that grew up
 * overnight never told anyone.
 *
 * The rule now: quiet hours DEFER the celebration, they do not consume it.
 * (Contrast the fade warning, which ignores quiet hours entirely: a survival
 * warning is worth a keeper's sleep, a growth spurt is not.)
 *
 * Drives the REAL exported maybeEvolve against an in-memory store so the latch
 * behaviour is observed, not re-derived.
 */
import { config } from "../src/config.js";
import { isQuietHour } from "../src/runner/quiet.js";
import { maybeEvolve } from "../src/runner/idle.js";
import type { AppContext } from "../src/context.js";
import type { Runner } from "../src/store/types.js";

let failures = 0;
function check(name: string, cond: boolean, detail = ""): void {
  if (cond) console.log(`  ok   ${name}${detail ? `  (${detail})` : ""}`);
  else {
    failures += 1;
    console.log(`  FAIL ${name}${detail ? `  (${detail})` : ""}`);
  }
}

// Minimal in-memory store: only what maybeEvolve + pushRunnerPass touch.
// pushRunnerPass swallows its own errors, and zero push tokens makes the APNs
// call a no-op, so no network is involved.
function makeCtx(runner: Runner): { ctx: AppContext; pushes: number; get: () => Runner } {
  let current = runner;
  let pushes = 0;
  const store = {
    async updateRunner(_serial: string, patch: Partial<Runner>): Promise<Runner> {
      current = { ...current, ...patch } as Runner;
      return current;
    },
    async getRunner(): Promise<Runner> {
      return current;
    },
    async listRunnerPushTokensForSerial(): Promise<string[]> {
      pushes += 1; // the push path was entered
      return [];
    },
  };
  return {
    ctx: { store, relayer: {} } as unknown as AppContext,
    get pushes() {
      return pushes;
    },
    get: () => current,
  } as never;
}

function fixture(): Runner {
  // careCount at the stage-2 threshold: stageFor returns >= 2, so an evolution
  // is genuinely pending rather than simulated.
  return {
    serial: "evo-test",
    tokenId: "1",
    status: "ready",
    hatched: true,
    gone: false,
    won: false,
    lastStage: 1,
    careCount: config.STAGE2_CARES,
    createdAt: new Date("2026-08-20T00:00:00Z"),
    lastEvent: "Your pet napped in a sunbeam",
    lastPushAt: null,
    hunger: 100,
    thirst: 100,
    joy: 100,
    critical: false,
  } as unknown as Runner;
}

console.log("=== evolution latch: quiet hours must DEFER, not consume ===");
console.log(`TRAITS_V2_ENABLED=${config.TRAITS_V2_ENABLED}  STAGE2_CARES=${config.STAGE2_CARES}  quiet=${config.IDLE_QUIET_START_HOUR}:00-${config.IDLE_QUIET_END_HOUR}:00 ${config.QUIET_TZ}`);

// Pick real instants: one inside quiet hours, one outside.
let quietAt: Date | null = null;
let wakingAt: Date | null = null;
for (let h = 0; h < 24; h++) {
  const d = new Date(Date.parse("2026-08-24T00:00:00Z") + h * 3_600_000);
  if (isQuietHour(d) && !quietAt) quietAt = d;
  if (!isQuietHour(d) && !wakingAt) wakingAt = d;
}
console.log(`quiet instant ${quietAt!.toISOString()}   waking instant ${wakingAt!.toISOString()}\n`);

// 1. During quiet hours: no push, and CRUCIALLY the latch must not advance.
{
  const h = makeCtx(fixture());
  const after = await maybeEvolve(h.ctx, fixture(), quietAt!);
  check("quiet-hours evolution does not push", h.pushes === 0, `${h.pushes} push attempts`);
  check(
    "quiet-hours evolution does NOT consume the latch",
    after.lastStage === 1,
    `lastStage=${after.lastStage} (must stay 1 so it can re-fire)`,
  );
}

// 2. The same pet on the next waking tick: the celebration must still be there.
{
  const h = makeCtx(fixture());
  const quiet = await maybeEvolve(h.ctx, fixture(), quietAt!);
  // Feed the (unchanged) runner forward into a waking tick, exactly as the idle
  // engine would on its next cycle.
  const woke = await maybeEvolve(h.ctx, quiet, wakingAt!);
  check("the deferred evolution fires on the next waking tick", h.pushes === 1, `${h.pushes} push attempts`);
  check("the latch advances once the push actually went out", woke.lastStage >= 2, `lastStage=${woke.lastStage}`);
  check(
    "the celebration line lands on the card",
    typeof woke.lastEvent === "string" && woke.lastEvent !== "Your pet napped in a sunbeam",
    JSON.stringify(woke.lastEvent),
  );
}

// 3. It must still fire exactly ONCE: a second waking tick is a no-op.
{
  const h = makeCtx(fixture());
  const first = await maybeEvolve(h.ctx, fixture(), wakingAt!);
  const second = await maybeEvolve(h.ctx, first, wakingAt!);
  check("a celebrated evolution does not repeat", h.pushes === 1, `${h.pushes} push attempts`);
  check("latch holds after celebrating", second.lastStage === first.lastStage, `${first.lastStage} -> ${second.lastStage}`);
}

console.log(`\n${failures === 0 ? "ALL CHECKS PASSED" : `${failures} CHECK(S) FAILED`}`);
process.exit(failures === 0 ? 0 : 1);
