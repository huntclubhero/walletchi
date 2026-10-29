/**
 * SMART CARE CHECK (runner/care-budget.ts): a pass tap must never burn the pet's daily care limit
 * on a need that adds no life, and the limit must never run out while a need is lapsing.
 * Pure decision checks, including a replay of pet No. 0038's death and a simulated week of the
 * five-tap ritual four times a day.
 *
 * Run: npx tsx scripts/care-budget-check.ts
 */
import { careBudgetVerdict, caresLeft, stalestNeed, FRESH_SECONDS, type SpendState } from "../src/runner/care-budget.js";

let failures = 0;
let passes = 0;
function check(name: string, cond: boolean, detail = ""): void {
  if (cond) {
    passes += 1;
    console.log(`  ok   ${name}${detail ? `  (${detail})` : ""}`);
  } else {
    failures += 1;
    console.log(`  FAIL ${name}${detail ? `  (${detail})` : ""}`);
  }
}

const H = 3600;
const DAY = 86_400;
const COST = 10n ** 18n;
const CAP = 20n * COST;
const T0 = 1_800_000_000;

console.log("\nbasic rules");
{
  const needAt = [T0 - 2 * H, T0 - 20 * H, T0 - 5 * H, T0 - 6 * H, T0 - 7 * H];
  check("the stalest need is found", stalestNeed(needAt) === 1);
  const base = { needAt, lifeTtl: DAY, now: T0, careCost: COST, spend: null };
  check("tapping the stalest need spends", careBudgetVerdict({ ...base, actionType: 1 }).kind === "ok");
  const v = careBudgetVerdict({ ...base, actionType: 0 });
  check("tapping a need fed 2h ago (not fresh) with an unreadable limit spends", v.kind === "ok");
  check("an unreadable limit never holds a tap, even a just-served need", careBudgetVerdict({ ...base, needAt: [T0 - 10 * 60, ...needAt.slice(1)], actionType: 0 }).kind === "ok");
  const halfUsed: SpendState = { dailyCap: CAP, windowStart: T0 - 5 * H, spentInWindow: 10n * COST };
  const fullLimit: SpendState = { dailyCap: CAP, windowStart: T0 - 5 * H, spentInWindow: 1n * COST };
  check("a brand-new pet's taps right after mint always care", careBudgetVerdict({ ...base, spend: fullLimit, needAt: [T0 - 60, T0 - 60, T0 - 60, T0 - 60, T0 - 60], actionType: 2 }).kind === "ok");
  const fresh = careBudgetVerdict({ ...base, spend: halfUsed, needAt: [T0 - 10 * 60, ...needAt.slice(1)], actionType: 0 });
  check("with half the limit used, tapping a need fed 10 minutes ago does NOT spend", fresh.kind === "fresh");
  check("and points at the stalest need with its time left", fresh.kind === "fresh" && fresh.stalest === 1 && fresh.secondsLeft === 4 * H);
  check("a never-served pet (all zeros) always spends", careBudgetVerdict({ ...base, needAt: [0, 0, 0, 0, 0], actionType: 3 }).kind === "ok");
  check("an old need spends even when others are fresh", careBudgetVerdict({ ...base, needAt: [T0 - 20 * H, T0 - 20 * H, T0, T0, T0], actionType: 0 }).kind === "ok");
  check("with half the limit used, a need served 10 minutes ago never spends, even as the stalest", careBudgetVerdict({ ...base, spend: halfUsed, needAt: [T0 - 600, T0 - 500, T0 - 400, T0 - 300, T0 - 200], actionType: 0 }).kind === "fresh");
}

console.log("\nthe limit is reserved for the needs that keep the pet alive");
{
  // 3 cares left, window reopens in 10h; three other needs lapse before then
  const spend: SpendState = { dailyCap: CAP, windowStart: T0 - 14 * H, spentInWindow: 17n * COST };
  check("cares left reads 3", caresLeft(spend, COST, T0) === 3);
  const needAt = [T0 - 3 * H, T0 - 20 * H, T0 - 19 * H, T0 - 18 * H, T0 - 2 * H];
  const v = careBudgetVerdict({ actionType: 0, needAt, lifeTtl: DAY, now: T0, careCost: COST, spend });
  check("a tap on a need that can wait is redirected when the rest would run short", v.kind === "reserve", v.kind);
  const v2 = careBudgetVerdict({ actionType: 2, needAt, lifeTtl: DAY, now: T0, careCost: COST, spend });
  check("a tap on a need that must be served before reopening spends", v2.kind === "ok", v2.kind);
  const plenty: SpendState = { ...spend, spentInWindow: 5n * COST };
  check("with plenty left, a non-fresh tap spends", careBudgetVerdict({ actionType: 0, needAt, lifeTtl: DAY, now: T0, careCost: COST, spend: plenty }).kind === "ok");
  const rolled: SpendState = { ...spend, windowStart: T0 - 25 * H };
  check("a window past 24h counts as full again", caresLeft(rolled, COST, T0) === 20);
}

// Simulate a keeper who runs the full five-tap ritual `ritualsPerDay` times a day for a week.
// Each tap either spends (moves that need's stamp to now, spends one care, rolls the window like the
// account) or is redirected (counted, no spend). The pet must never die and never be refused by the
// limit with a lapsing need.
function simulate(ritualsPerDay: number, smart: boolean): { died: boolean; capped: number; spent: number; redirected: number } {
  let now = T0;
  const needAt = [now, now, now, now, now];
  let windowStart = now;
  let spent = 0n;
  let capped = 0;
  let spentCares = 0;
  let redirected = 0;
  let died = false;
  const gap = Math.floor(DAY / ritualsPerDay) - 10 * 60; // a keeper on a schedule, a little early
  for (let r = 0; r < 7 * ritualsPerDay; r++) {
    now += gap;
    if (Math.min(...needAt) + DAY <= now) {
      died = true;
      break;
    }
    for (let a = 0; a < 5; a++) {
      const spend: SpendState = { dailyCap: CAP, windowStart, spentInWindow: spent };
      if (smart) {
        const v = careBudgetVerdict({ actionType: a, needAt, lifeTtl: DAY, now, careCost: COST, spend });
        if (v.kind !== "ok") {
          redirected++;
          continue;
        }
      }
      if (now >= windowStart + DAY) {
        windowStart = now;
        spent = 0n;
      }
      if (spent + COST > CAP) {
        capped++;
        continue;
      }
      spent += COST;
      spentCares++;
      needAt[a] = now;
    }
  }
  return { died, capped, spent: spentCares, redirected };
}

console.log("\na week of the five-tap ritual");
for (const n of [1, 2, 3, 4, 5, 6, 8, 12, 24]) {
  const dumb = simulate(n, false);
  const smart = simulate(n, true);
  check(`${n}x a day with smart care: alive and never hits the limit`, !smart.died && smart.capped === 0, `spent ${smart.spent}, redirected ${smart.redirected}; without smart care: refused ${dumb.capped}x`);
}

console.log("\nrandom keepers (bursts, single needs, long gaps), 1000 keepers x 30 days, with and without smart care");
{
  // Each keeper's behavior (visit times, tap choices) comes from its own seed, replayed identically
  // with and without smart care. Smart care must never lose more pets, and must never hit the limit.
  const run = (k: number, smart: boolean) => {
    let seed = 1000 + k * 7919;
    const rnd = () => (seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff;
    let now = T0;
    const needAt = [now, now, now, now, now];
    let windowStart = now;
    let spent = 0n;
    let capped = 0;
    while (now < T0 + 30 * DAY) {
      const wander = Math.floor(rnd() < 0.15 ? 12 * H + rnd() * 8 * H : rnd() * 5 * H) + 60;
      // the reminder engine pings a keeper when a need is nearly out: they come back within the hour
      const reminded = Math.min(...needAt) + DAY - 2 * H + Math.floor(rnd() * H);
      now = Math.max(now + 60, Math.min(now + wander, reminded));
      if (Math.min(...needAt) + DAY <= now) return { died: true, capped };
      const style = rnd();
      const burst = Array.from({ length: 1 + Math.floor(rnd() * 12) }, () => Math.floor(rnd() * 5));
      const urgent = [0, 1, 2, 3, 4].filter((i) => needAt[i]! + DAY - now < 4 * H); // the "next needs" list on every page
      const taps = [...urgent, ...(style < 0.4 ? [0, 1, 2, 3, 4] : style < 0.7 ? burst : [needAt.indexOf(Math.min(...needAt))])];
      for (const a of taps) {
        if (smart && careBudgetVerdict({ actionType: a, needAt, lifeTtl: DAY, now, careCost: COST, spend: { dailyCap: CAP, windowStart, spentInWindow: spent } }).kind !== "ok") continue;
        if (now >= windowStart + DAY) {
          windowStart = now;
          spent = 0n;
        }
        if (spent + COST > CAP) {
          capped++;
          continue;
        }
        spent += COST;
        needAt[a] = now;
      }
    }
    return { died: false, capped };
  };
  let smartDeaths = 0;
  let plainDeaths = 0;
  let smartCapped = 0;
  let plainCapped = 0;
  for (let k = 0; k < 1000; k++) {
    const s1 = run(k, true);
    const s0 = run(k, false);
    if (s1.died) smartDeaths++;
    if (s0.died) plainDeaths++;
    if (s1.capped) smartCapped++;
    if (s0.capped) plainCapped++;
  }
  check("smart care never loses more pets than no smart care", smartDeaths <= plainDeaths, `deaths: smart ${smartDeaths}, without ${plainDeaths}`);
  check("with smart care no keeper ever hits the on-chain limit", smartCapped === 0, `keepers refused by the limit: smart ${smartCapped}, without ${plainCapped}`);
}

console.log("\npet No. 0038 replay (2026-10-16 10:05 UTC)");
{
  // At 10:05 the window (opened 10-15 12:22) had 0 cares left; reopen 12:22; died 23:25.
  const now = Date.UTC(2026, 9, 16, 10, 5) / 1000;
  const spend: SpendState = { dailyCap: CAP, windowStart: Date.UTC(2026, 9, 15, 12, 22) / 1000, spentInWindow: CAP };
  check("the limit was fully spent (0 left)", caresLeft(spend, COST, now) === 0);
  check("the window reopened 2h17m later, before the pet's deadline", spend.windowStart + DAY - now === 2 * H + 17 * 60);
}

console.log(`\nRESULT: ${passes} passed, ${failures} failed`);
process.exit(failures === 0 ? 0 : 1);
